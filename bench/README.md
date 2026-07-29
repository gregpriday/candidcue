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
    --runs ../bench/runs-local --model ../src-tauri/models/zipformer-en-20m
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

Both tiers replay through the same engine and the same evaluator.

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

# Compare two saved results / build the report table
cargo run --release -p cc-bench -- compare ../bench/results/a.json ../bench/results/b.json
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
