# CandidCue alignment benchmarks

End-to-end testing of the speech-to-script alignment system **outside the
application**: real Markdown scripts → controlled performances → (synthetic
events | real TTS audio streamed through a real recogniser) → the Rust
alignment engine → render-time metrics against a gold timeline.

The engine under test is `crates/cc-align` — a pure, deterministic core (no
I/O, no clocks, no randomness) that the app can adopt directly. The recogniser
under test is `crates/cc-stt`, which is also the one the app ships.

## Two recognisers, one ruler

The app's speech-to-text was replaced: a hosted Inworld websocket became an
on-device sherpa-onnx streaming Zipformer (EN 20M, INT8). Both speak the same
`SttFrame` protocol, which is what makes the swap a measurement rather than a
leap of faith — a captured log from either replays through the same engine and
is scored by the same evaluator against the same gold timeline.

```
bench/runs/         frozen Inworld captures — the BASELINE
bench/runs-local/   the same audio, heard by the bundled model
```

```bash
# The baseline, replayed (no network, no key):
cargo run --release -p cc-bench -- tier-b --label inworld --out ../bench/results/baseline-tier-b.json

# The bundled model, on the same fixtures:
cargo run --release -p cc-bench -- tier-b --runs ../bench/runs-local \
    --label local --out ../bench/results/local-tier-b.json

cargo run --release -p cc-bench -- compare ../bench/results/baseline-tier-b.json \
    ../bench/results/local-tier-b.json
```

Rebuilding `runs-local` from scratch needs the fixture audio (FAL_KEY) and then
a real-time pass through the recogniser:

```bash
cargo run --release -p cc-bench -- synth-audio --workdir /tmp/bench-work --runs ../bench/runs-local
cargo run --release -p cc-bench -- capture-local --workdir /tmp/bench-work \
    --runs ../bench/runs-local --model ../src-tauri/models/x-asr-480ms
```

`--runs` on `synth-audio` names the corpus the audio is destined for; synthesis
skips a run that corpus already holds, so pointing it at a fresh corpus is what
makes the audio render again for a different recogniser instead of being
skipped as "already captured".

Capture runs at real-time pace by default. Scoring does not depend on it — every
Tier-B metric is a function of the audio clock and the text, and `wall_ms` is
recorded but never read — but the fixtures are more honest at 1.0x, and the
model is ~16x faster than real time, so a faster pass would bake in latencies
no presenter will ever see.

The hosted client still exists, behind `cc-stt`'s non-default `inworld` feature
which only `cc-bench` enables. It is kept for exactly one reason: a baseline you
can no longer re-measure is a number you have to take on faith.

## Layout

```
bench/scripts/    Markdown fixture scripts (9, from 250 to 5,000 words)
bench/runs/       Captured Inworld event logs — immutable replay fixtures
                  (events.jsonl + gold.json + manifest.json + performance.txt)
bench/runs-local/ The same, heard by the bundled on-device recogniser
bench/results/    Generated benchmark tables (local/gitignored JSON)
crates/cc-align/  The alignment engine
crates/cc-stt/    STT protocol + the on-device recogniser the app ships
                  (+ the hosted client, behind the `inworld` feature)
crates/cc-bench/  Harness: plans, gold, synthetic events, TTS, capture,
                  replay, metrics, suites, reports
```

The files under `bench/runs*` are intentionally tracked replay fixtures, not
generated reports or audio. They contain only compact transcript events, gold
timing, a manifest, and the spoken text. Keeping them makes a benchmark result
reproducible without a TTS key, microphone, model download, or a fresh
non-deterministic recognition pass. WAV files remain in the temporary synthesis
work directory, and result JSON belongs under ignored `bench/results/`.

**The two bulk files per run are in Git LFS** (`.gitattributes`): `events.jsonl`
and `gold.json`, 115 files and ~4 MB. `manifest.json` and `performance.txt` stay
plain text on purpose — a few hundred bytes each, and the files a human actually
reads in a diff when a fixture changes. Tier-C frame traces are gitignored
instead: derived output, tens of MB per take, regenerable from the fixtures.

So a clone needs `git lfs` and a fetch before Tier B or Tier C will run. Without
it the fixtures are ~130-byte pointer files, and the failure is not obvious from
the error — a pointer parsed as JSONL is simply a fixture that yields no events.
If a Tier-B run reports no samples on a corpus that has them, check
`git lfs ls-files` and `wc -c` on one `events.jsonl` before looking anywhere else.

## Custom vocabulary (`transcribeConfig.prompts`)

`inworld/inworld-stt-1` accepts a soft vocabulary bias, and
`crates/cc-align/src/vocab.rs` builds one from a script: compound brands,
initialisms, non-ASCII names, capitalised runs away from a sentence start, and
figures in the notation the script wrote them in. Two commands drive it.

```bash
# What would this script send? No network, no cost.
cc-bench vocab names brands figures

# The same audio, streamed twice, differing in one field.
cc-bench prompt-ab --workdir /tmp/ab --scripts names,brands,figures
```

`prompt-ab` synthesises each script once (the clip cache makes the second
stream free), streams it with an empty vocabulary and again with the extracted
one, and prints three numbers per run because the two wins do not share a
measurement:

| column  | computed on | answers |
|---|---|---|
| `wer`   | canonical atoms | were the right WORDS heard |
| `raw`   | bare lowercased surfaces | were they SPELLED the script's way |
| `hits`  | verbatim term search | did the terms sent actually come back |

`wer` folds `27` and `twenty-seven` onto one atom by design, so it cannot see a
re-spelling; `raw` does nothing else. A bias the service ignores shows up as a
flat `hits` column.

`crates/cc-bench/tests/prompt_config.rs` is the cheap guard beside it: one
second of silence against the live endpoint carrying a term per permitted
character class, plus a deliberately invalid term as the control. It exists
because the config frame LEADS the socket — a term the gateway dislikes does
not degrade a take, it prevents one.

## Spelling, not mishearing

Most families ask what happens when the reader departs from the script. The
`asr_forms` family asks something else: what happens when they don't, and the
recogniser writes down what they said in a different notation than the script
used. "Twenty-seven" comes back as `27`. "Three thirty" comes back as `3:30`.
"RustLight" comes back as `Rust Light`. Nothing was misheard and the reader did
nothing wrong, but if normalisation does not fold both spellings onto the same
atom, the display stops on a word they have already passed.

`bench/scripts/figures.md` and `bench/scripts/brands.md` exist for this — a page
of numbers, dates, money and units, and a page of compound brand names, places
and acronyms. `crates/cc-bench/src/verbalize.rs` is the deterministic model of
what a recogniser writes back; `figures` and `brands` are also in the Tier-B
selection so the real provider gets the deciding vote.

Each of those scripts runs `exact` as well, with the same words in the script's
own spelling. The gap between `exact` and `asr_forms` on one script is the cost
of the spelling disagreement with everything else held constant.

## The reversible dim frontier (`fuzzy.*`)

Close-but-wrong spellings are the one case where the display can lead safely.
The engine keeps a **provisional** frontier fed only by fuzzy and phonetic
evidence: it shades words and reaches nothing else — not `observed`, not
`confirmed`, not acquisition or discontinuity authority — so it cannot move the
sheet. Scroll is irreversible and dimming is not, which is the whole argument for
letting one of them speculate and not the other. When contradicted, the engine
emits `provisional_retracted` once and the words brighten again.

The `fuzzy.*` rows come from `crates/cc-bench/src/dimming.rs`, which drives the
engine directly rather than replaying a fixture, **and that distinction is the
point of this section.** It builds the precondition the mechanism needs — a
confident manual lock, then one recogniser item containing a single misspelled
word — because no replay fixture produces it. Read the 100% recall rows as "the
mechanism is correct under that precondition", not as "this fires on takes".

Measured on this corpus (2026-07-30), it does not fire on takes at all:
`provisional_advances` is **0** on all 87 Tier A scenarios and all 21 Tier B
fixtures, including the three `fuzzy-follow__fuzzy_voice__*` ones added to
exercise it. Real streaming partials are the reason. Against
`Presenter teleprompter harbour narration` the recogniser returns
`Present a teleprompter, harbor narration`: `harbour`→`harbor` is exactly the
near-miss the bridge is for, but it arrives in an item that also carries exact
content matches and an insertion from the word split, and
`is_coherent_approx_chain` requires `content_matches == 0` and `insertions == 0`.
Those three fixtures also hold the corpus's worst dim latency (`dim_p50`
1.75–2.45 s against ~750 ms elsewhere), so the problem they were cut to
demonstrate is still open.

That inertness is why the merge is safe — the 87 Tier A scenarios are
bit-identical with the feature present, and the 18 original Tier B fixtures keep
`ahead_worst` 6.700, `ahead_events` 11 and `dim_never` 1 exactly. It is also why
the `fuzzy.*` rows should not be read as a win yet. `bench/configs/fuzzy-disabled.json`
(`local_approx_max_consecutive: 0`) shuts the gate for an A/B.

`fuzzy.near_word_false_bridge` sits at 100% by construction and is instrumented
rather than fixed: `desert`/`dessert` and `affect`/`effect` are one edit apart,
and no single-word matcher can separate a real near word from a mistranscription.
The cost is one reversibly-dimmed word that never moves the document.

## Two evidence tiers

**Tier A — deterministic synthetic.** Performance plans (read / pause / skip /
retake / ad-lib / substitute / viewport ops) are expanded against the compiled
script into a gold timeline; a simulator produces Inworld-cadence transcript
events (full-restatement partials ~0.9 s, finals ~1.2 s after silence,
seeded ASR-style corruption). Runs in seconds, byte-for-byte reproducible;
this is what CI regression numbers come from.

**Tier B — live end-to-end.** The same performances are rendered by three
independent fal.ai TTS engines (`gemini-3.1-flash-tts`, `qwen-3-tts` 1.7 B,
`xai/tts/v1`), stitched at 24 kHz mono PCM16 with real silence for pauses,
streamed at real-time pace in 100 ms frames to the live Inworld endpoint,
and the resulting event logs are captured as replay fixtures. Gold word
timing comes from per-segment clip boundaries (segments ≤ 12 words, so
linear interpolation stays within ±1 word).

**Tier C — the rendered stage.** Tier A and Tier B both stop at the engine's
estimated position, which is one scalar the presenter never sees. Tier C drives
the same replayed snapshots through a Rust port of the shipping stage — the line
map, the jerk-limited follower with its S-curve stopping guard, the per-state
motion limits, and the four-step per-word dim ramp with its 240 ms tween — and
scores **what would have been on the glass**: which words were bright, where the
reading line sat, how the document moved, whether the next line was legible.

It runs over a layout sweep, not a reference rig: 30 / 60 / 90 / 120 Hz, three
line pitches, and a panel that drops every eighth frame (4K@30 over HDMI, which
is a cheap teleprompter monitor rather than a corner case). The headline table is
the 60 Hz rig; every other layout is reported beside it, because the whole claim
of the jerk-limited controller is that it behaves the same at every refresh rate
and one averaged number cannot check a claim about seven rigs.

Tier C is a **model of the stage, not the stage.** WKWebView has no WebDriver, so
nothing automated on this machine can drive the packaged app — that gap is real
and unchanged. Real text measurement, compositor timing and WebKit's own opacity
interpolation are not modelled. Tier C proves the controller and the opacity ramp
behave; it says nothing about layout on a real panel.

All three tiers replay through the same engine. Tiers A and B share the position
evaluator; Tier C has its own, in `crates/cc-bench/src/perceptual.rs`.

## Three gold timelines, not one

`crates/cc-bench/src/passgold.rs`. CandidCue has at least three separate notions
of "where the reader is", and they diverge in normal use:

| reference | what it licenses |
|---|---|
| **spoken frontier** `g_s(t)` | which words may be dark. A word not yet said may not be faded, full stop. |
| **reading focus** `g_f(t)` | where the line should sit. The eyes lead the mouth; scoring placement against the mouth builds in an eye-voice lead of error and calls it correct. |
| **pass position** `g_p(t)` | what must be legible NOW. A retake makes gold non-monotonic: a word said two minutes ago still has to be bright if the presenter is re-reading it. |

The high-water mark the Tier-A/B overshoot metrics use is still exactly right for
safety — it refuses to let the display fade text nobody has ever said — and it is
structurally blind to a retake left illegible, because on that reference the text
IS spoken and leaving it dark is free. Both references are needed and they catch
different failures.

`passgold` also builds τ_p(z), the inverse reading map: the acoustic time at
which the reader passed script position z during pass p. That is what makes delay
measurable in milliseconds instead of atoms, and it matters because a two-word lag
at 80 wpm and a two-word lag at 220 wpm are not the same experience — every
atom-denominated row in the old table calls them identical.

## Difficulty, so a good score cannot come from an easy corpus

```bash
cargo run --release -p cc-bench -- difficulty
```

Uniqueness radius (the shortest phrase that identifies one place in the script),
anchor density and its worst-window floor, and stopword load. It already says
something useful: `huge` is 27.8% ambiguous with zero anchor-grade atoms and
`refrain` is 7.9%, against 0.0% for every prose script — so a lock-time average
over the corpus is mostly a statement about the easy scripts.

## Robustness: invariants and an adversarial radius

```bash
cargo run --release -p cc-bench -- metamorphic
cargo run --release -p cc-bench -- robustness --budget 2000
```

**Metamorphic** tests change something that must not change behaviour — case,
sentence punctuation, non-spoken Markdown, delayed evidence, a uniformly scaled
clock, a distant duplicate passage — and assert that it did not. The
transformation is the oracle, so they need no gold timeline and run over the whole
corpus in seconds.

**Adversarial** search looks for the cheapest recogniser corruption (substitutions
drawn from the script's own vocabulary, deletions, insertions, timing shifts, up
to three operators) that produces a false jump, a false-confidence episode, or
unread ink. It reports a *radius*, not a pass/fail: the objective is to push the
cost of unsafe behaviour past anything a real recogniser produces. A scenario
whose unperturbed baseline already misbehaves is reported as such and given no
radius — a radius measured from a failing baseline is noise with a decimal point
on it.

## Commands

```bash
cd crates

# Tier A suite (deterministic, ~10 s)
cargo run --release -p cc-bench -- tier-a --label mine --out ../bench/results/mine.json

# Per-event decision trace of one scenario
cargo run --release -p cc-bench -- inspect starter skip_forward
CC_ALIGN_DEBUG=1 cargo run --release -p cc-bench -- inspect starter retake

# Regenerate Tier B fixture audio (needs FAL_KEY; cached by content hash)
cargo run --release -p cc-bench -- synth-audio --workdir /tmp/bench-work

# Stream fixtures through live Inworld STT (needs INWORLD_API_KEY; ~real time)
cargo run --release -p cc-bench -- capture --workdir /tmp/bench-work

# Replay captured runs (offline, no network)
cargo run --release -p cc-bench -- tier-b --label mine --out ../bench/results/mine-live.json

# Tier C: the rendered stage, across the layout sweep
cargo run --release -p cc-bench -- tier-c --label mine --out ../bench/results/mine-c.json
cargo run --release -p cc-bench -- tier-c --label mine --layouts 60hz --verbose

# Tier C over captured real recogniser output — the closest thing to a real take
# anything automated here can reach
cargo run --release -p cc-bench -- tier-c --runs ../bench/runs-local --layouts 60hz --label mine

# Corpus difficulty, metamorphic invariants, adversarial robustness radius
cargo run --release -p cc-bench -- difficulty
cargo run --release -p cc-bench -- metamorphic
cargo run --release -p cc-bench -- robustness --budget 2000

# Compare two saved results / build the report table
cargo run --release -p cc-bench -- compare ../bench/results/a.json ../bench/results/b.json
cargo run --release -p cc-bench -- compare-c ../bench/results/a-c.json ../bench/results/b-c.json
cargo run --release -p cc-bench -- report A-base.json A-opt.json B-base.json B-opt.json
```

## What the benchmarks mean

Safety is lexicographically first: a config that improves accuracy but adds a
false jump is a regression.

| Benchmark | Meaning |
|---|---|
| `safety.false_jumps` | Display jumps >10 atoms that do NOT correspond to a real reader jump and do NOT land at the reader's true position. The worst product failure. |
| `safety.catastrophic` | Periods >2 s where the display is >20 atoms wrong **while the engine claims to be following** (honest holds don't count — they show up in recovery instead). |
| `accuracy.clean_within2 / within5` | % of render-time samples (20 Hz) within ±2/±5 spoken atoms of the reader's true position, on clean reads, measured from first lock. |
| `accuracy.clean_p95_abs` | 95th-percentile absolute token error on clean reads. |
| `accuracy.mean_signed_abs` | |mean signed error| — lead/lag balance of the display (0 = centred on the reader). |
| `responsiveness.prefinal_move` | % of ≥8-content-word utterances where the display moved before the provider FINAL (guards the "lurch every 5–7 s" failure). |
| `responsiveness.freeze` | % of on-script speaking time where gold advanced ≥1.5 atoms over 700 ms but the display moved <0.1. |
| `responsiveness.first_lock_p50` | Median time from first on-script word to a sustained ±3-atom lock. |
| `robust.corrupt15_within5` | Accuracy under ~15% seeded ASR corruption (sub/del/ins). |
| `robust.substitutions_within2` | Accuracy when the reader paraphrases individual words. |
| `recovery.skip_p95 / retake_p95` | P95 time to re-lock after jumping forward / re-saying earlier text. |
| `recovery.adlib_p95` | P95 time to re-lock after going off script and returning. |
| `recovery.failures` | Recovery events that never re-locked. |
| `recovery.adlib_drift_p95` | How far the display wandered from the hold anchor during off-script speech. |
| `viewport.start_lock_p50` | Lock time when the presenter scrolled somewhere, the app reported the visible range, and reading started there. |
| `names.cold_jump_lock_p95` | Lock time jumping cold into a section identified only by unusually-spelled proper nouns, with ASR-style mangling. |
### Tier C — the perceptual rows

Safety is still lexicographically first, and Tier C's gates are the ones stated
in perceptual units rather than in atoms.

**`band.occupancy` scores a stage the app does not currently ship.** Tier C's
`Layout::focus_lead_atoms` aims the corridor at the reading FOCUS, three atoms
ahead of the tracked position; the shipping renderer puts the tracked position —
the mouth — on the reading line, and there is no `focus_lead_atoms` anywhere
outside `cc-bench`. That single field is what takes occupancy from ~45% to ~82%,
and it carries most of `outcome.readable_availability`,
`outcome.disruptions_per_10min`, `outcome.longest_clean_s` and
`recover.readable_p50` with it. Those rows are a measurement of what aiming the
corridor ahead WOULD buy, not of what a take feels like today.

Three of the four changes measured alongside it did ship: the floored dim
frontier and the time-debounced retreat (`InlineNodes.svelte`) and the
`lead_margin_atoms` / `max_lead_atoms` trade (`cc-align/src/config.rs`). Those
are what `live.dim_p50_ms` 700 → 500 and `live.within2` 59.3 → 74.0 come from,
and those are Tier B rows on captured audio. Keep the distinction when quoting
numbers: the corridor is a proposal with evidence behind it, and moving the
motion path is the one change nothing on this machine can verify.

`--focus-lead 0` scores the stage as it actually ships, which is how to price the
proposal. On `runs-local` at the `60hz` layout:

| | as shipped | + 3-atom corridor |
|---|---|---|
| `band.occupancy` | 52.1% | **74.3%** |
| `band.out_episodes` | 121 | **54** |
| `outcome.readable_availability` | 71.2% | 75.8% |
| `outcome.disruptions_per_10min` | 77.1 | 69.5 |
| `outcome.longest_clean_s` | 29.6 | 37.8 |
| `gate.unread_never_spoken` (safety) | 2.903 | **2.483** |
| `time.lag_p50` | 697 ms | 697 ms |
| `recover.readable_p50` | 2738 ms | 2738 ms |

The two rows that do not move are the point: aiming the corridor ahead changes
where the same text is drawn and nothing about when a word goes dim. And the
safety gate gets BETTER rather than worse — the same words are dimmed, but they
sit nearer the reading line, so the gaze weighting counts less of the darkness
against text nobody has read. That is the opposite of the usual trade and is the
strongest argument for shipping it.

| Benchmark | Meaning |
|---|---|
| `gate.unread_never_spoken` | **The safety gate.** Gaze-weighted word-seconds of darkness applied to text that has never been spoken in ANY pass. Weighted by a Gaussian on the distance from the reading line, because a word erased under the presenter's eye and the same thing at the bottom of the glass are not one event. |
| `gate.fce_10_pct` | % of following time the engine was >10 atoms wrong **while claiming to follow**. Fills the space under the 20-atom catastrophic threshold: admitting uncertainty and holding is a recovery problem, claiming to follow while wrong is a lie. |
| `gate.visible_relocation` | Lines of document travel weighted by how visible the document was while travelling. A correct hidden re-anchor scores ~0; this catches half-transparent ghost travel. |
| `outcome.readable_availability` | % of clean on-script time the stage was *simultaneously* well placed, moving readably, with enough future text and with the next eight words bright. The single row closest to "did this work". Thresholds are CANDIDATES pending Tier D. |
| `outcome.disruptions_per_10min` | Sustained (≥200 ms) perceptual incidents: unread ink, band loss, unnecessary hold, blur travel, future starvation, false confidence. |
| `outcome.longest_clean_s` | The longest stretch with nothing conspicuous happening — the number a presenter would recognise as "it just worked for a while". |
| `ink.first_response / half_dim / committed_dim` | Time from a word's ACOUSTIC END to it reaching 25% / 50% / 85% of the way to the far past, on rendered opacity. Three questions, not one: the product does not switch a word off, it walks it down a four-step ramp with a 240 ms tween. |
| `ink.dim_mad`, `ink.dim_spread_p95_p50` | Consistency. A steady 250 ms reads better than an average of 250 that alternates 50 and 700, and percentiles cannot say so. |
| `ink.unread_exposure` | The same integral as the gate, but against the CURRENT PASS frontier — includes text unread again because of a retake. |
| `ink.spoken_retention` | The mirror: words already passed and still unnecessarily bright. The integral form of "words take too long to go dim". |
| `ink.retake_legibility_loss` | Word-seconds of text the presenter must re-read, left dim. Pass-aware; the global high-water metric cannot see it. |
| `ink.corrections_per_1k` | Words that got darker and then came back. The target is not zero — a small smooth correction beats universally late darkening — so depth and duration are reported beside it. |
| `time.lag_p50 / lag_p95 / lead_p05` | Temporal frontier error: `t − τ_p(rendered dim frontier)`. Positive = the display is showing a position the presenter passed that long ago. Speaking-rate invariant by construction. Scored only while a word is in the mouth: τ answers "when did they pass this", and during a silence the answer lies on the far side of the pause. |
| `time.lag_p50_after_pause / steady / opening` | The same lag by context. A single global p50 can hide a 900 ms delay on every resume, which is exactly when a presenter looks at the prompter and loses faith in it. |
| `band.occupancy` | % of on-script time the reading FOCUS was inside the corridor. Measured against the focus, not the mouth. |
| `band.future_reserve_p05` | Unread rendered lines below the focus. Whether the presenter feels they are being given something to read into. |
| `band.handoff_p95` | Where the next line sits, relative to the reading position, at each line end. A stage can be well placed on average and produce a bad eye-return at every wrap. |
| `motion.plant_err_p95` | Rendered scroll vs commanded target, in lines. Isolates the controller from the tracker. |
| `motion.pulse_p50 / p95` | Integrated \|jerk\| in the 400 ms after each accepted snapshot: does the stage visibly kick on every recogniser update? |
| `motion.eta_v_0_250ms` | Event-triggered average velocity change after a snapshot. One number for the same question. |
| `motion.cadence_ripple` | Fraction of velocity-spectrum power in the 0.7–3 Hz recogniser-update band. Catches periodic modulation from partial cadence even when mean speed and position error look fine. |
| `motion.silent_burden_*` | Lines travelled while the presenter was silent, by pause class. A breath and a six-second dramatic hold are different obligations. |
| `motion.rest_travel` | Travel while gold and target are both stationary. The target should be motionless, not merely under some large threshold. |
| `honest.hold_precision / hold_recall` | Correct hold time over all hold time, and over all gold should-hold time. A system that never makes a false jump because it holds constantly is not good; one that never holds is not safe. |
| `honest.brier` | Calibration of the reported confidence against "was it actually within 3 atoms". A DIAGNOSTIC: `confidence` is documented as a heuristic, not a probability, so a poor score is a fact about the field rather than a bug. |
| `recover.readable_p50 / p95` | Readable recovery time: state following, temporally in window, focus line in the corridor, next words bright, and HELD for 1.5 s. Strictly stronger than "position recovered". |
| `recover.within_5_words` | % of recoveries complete before the presenter said five more words. Often more meaningful than elapsed seconds. |
| `recover.snapbacks` | Recoveries followed by a second relocation inside 5 s. Landing fast and then snapping back is not a successful recovery. |
| `health.follow_availability` | % of frames with a complete valid follow path. The most dangerous reliability failure is not a crash; it is an apparently healthy take that has quietly stopped following. |

| `forms.span_within2 / span_within5` | The headline. Accuracy measured ONLY inside a re-spelled run and the 1.5 s after it. A whole-run number on a page of figures is nine parts undisputed prose, so this is the one that can actually move when spelling handling changes. |
| `forms.span_p95_abs` | 95th-percentile error in those same windows. Compare against `accuracy.clean_p95_abs` — equal means the disagreement costs nothing. |
| `forms.span_samples` | Not a quality number: the count the span rows are computed over. If it differs between two results, the two runs did not have the same benchmark input and every delta beside it is directional only. |
| `forms.within2 / within5` | Whole-run accuracy on the spelling-only families. Compare against `accuracy.clean_*`. |
| `forms.corrupt_within5` | The same reading with recogniser noise on top. Kept out of the headline: it moves when recognition changes, which is a different question. |
| `forms.figures_within5` | The same, numbers only: years, money, decimals, times, ordinals, units. Moves when normalisation changes. |
| `forms.brands_within5` | The same, names only: compound brands the recogniser splits in two, acronyms, places. Moves when word-boundary handling changes. |
| `forms.false_jumps` | False jumps caused by a spelling disagreement — a number that matched the wrong copy of itself elsewhere in the script. |
| `forms.freeze` | Freeze time on those scripts: the display waiting for a word it will never match. |
| `forms.relocate_p95 / lock_failures` | Relocation into a passage whose only landmarks are figures or names the recogniser respelled. |
| `ambiguity.refrain_false_jumps` | False jumps on a script whose refrain appears verbatim three times. |
| `smoothness.*` | See below — these score the *derivative* of the display path, not its position. |
| `perf.mean_event_us / p95_event_us` | Engine time per transcript revision. |
| `perf.scale_ratio_5k` | Per-event cost ratio, 5,000-word vs 300-word script (script-length independence). |
| `live.*` | The same ideas measured end-to-end on captured live STT runs, plus `live.wer` (diagnostic recogniser quality). |

## Smoothness: how it moves, not where it is

Every row above scores the display's **position** at each 50 ms sample. None of
them can see the path it took to get there. A display that crawls at a third of
the reader's pace and then steps forward once a second scores *identically* to
one that glides — same samples, same errors — and only one of them is watchable.
Every knob in the engine was tuned against position alone, which is why the
system is safe and jerky rather than safe and calm.

These rows score the derivative, on the clean families only, gated on the reader
actually speaking (a stopped display during a silence is correct, and pooling
those samples in would swamp the signal with legitimate rest). Intervals
spanning a display jump are excluded: a relocation is a deliberate
discontinuity that `safety.false_jumps` and the recovery rows already own.

| Benchmark | Meaning |
|---|---|
| `smoothness.vel_mean` | Mean display speed (atoms/s). Over a run this **must** equal the reader's true pace — otherwise the display would fall arbitrarily behind — so this row is the reader, not a quality number. |
| `smoothness.vel_p50` | *Typical* display speed. The gap between this and `vel_mean` is the whole defect: time spent moving slower than the reader, repaid later in steps. |
| `smoothness.vel_p10 / vel_p90` | The crawl and the surge. A system moving *with* the reader has these close to `vel_p50`. |
| `smoothness.vel_cov` | σ/μ of display speed. Scale-free, so it compares across readers and scripts. 0 is a perfect glide. The headline smoothness number. |
| `smoothness.stationary` | % of speaking time the display was not moving at all — the stop half of stop-start. |
| `smoothness.stalls_per_min` | Distinct hesitations: speed under 20% of **the reader's** pace (`vel_mean`), held ≥150 ms. "The number of times it paused on me." Per minute of scored speech, so adding scenarios is not a regression. Referenced to the reader and not to the display's own median, or a config that crawls the whole time would score zero stalls. |
| `smoothness.surge_p95` | P95 |change in speed| between adjacent samples — the size of the step the plant has to absorb. This is the row that moves when the display stops being fed a once-a-second correction. |

There is deliberately **no aggregate smoothness score, and none of these may be
read alone**. A display that runs ahead of the reader at a constant speed scores
perfectly on every row here. Only the safety and overshoot rows can say whether
a smoothness win was paid for honestly, and they remain lexicographically first.

## Reproducibility

Tier A is a pure function of (scripts, plans, seeds, config) — two runs are
identical. Tier B audio and provider events are frozen once captured;
`bench/runs/` is the immutable replay corpus and every result JSON embeds the
full `AlignmentConfig` it ran with. Audio itself is regenerable from the
committed scripts + plans via `synth-audio` (TTS clips are content-hash
cached) but is not required for replays.
