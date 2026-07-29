# CandidCue alignment benchmarks

End-to-end testing of the speech-to-script alignment system **outside the
application**: real Markdown scripts → controlled performances → (synthetic
events | real TTS audio streamed through the real Grok STT endpoint) →
the Rust alignment engine → render-time metrics against a gold timeline.

The engine under test is `crates/cc-align` — a pure, deterministic core (no
I/O, no clocks, no randomness) that the app can adopt directly. The wire
protocol used for live capture (`crates/cc-stt`) is the exact protocol of
`src-tauri/src/stt/stream.rs`.

## Layout

```
bench/scripts/    Markdown fixture scripts (9, from 250 to 5,000 words)
bench/runs/       Captured live-STT event logs — immutable replay fixtures
                  (events.jsonl + gold.json + manifest.json + performance.txt)
                  Append-only: a scenario already holding an events.jsonl is
                  SKIPPED by both synth-audio and capture. That is what makes
                  resuming an interrupted capture safe, and it is why comparing
                  two providers needs `--runs` pointing at a second corpus
                  rather than a re-run over this one.
bench/results/    Generated benchmark tables (local/gitignored JSON)
crates/cc-align/  The alignment engine
crates/cc-stt/    Tauri-free Grok streaming client
crates/cc-bench/  Harness: plans, gold, synthetic events, TTS, capture,
                  replay, metrics, suites, reports
```

## Custom vocabulary (`keyterm`)

Grok accepts a soft vocabulary bias of up to 100 terms of 50 characters, sent
as repeated `keyterm` parameters on the URL that opens the socket, and
`crates/cc-align/src/vocab.rs` builds one from a script: compound brands,
initialisms, non-ASCII names, capitalised runs away from a sentence start, and
figures in the notation the script wrote them in. Two commands drive it.

Because the terms ride on the OPENING URL rather than on a frame, a vocabulary
the gateway dislikes does not weaken a take — it prevents one. That is what
`crates/cc-bench/tests/prompt_config.rs` guards, for a fraction of a cent.

Worth knowing before reading an A/B as a mandate to send more: on the previous
provider a 17-term vocabulary measured WORSE than none and an 8-term one
measured better. Over-biasing is the failure mode, so the useful output here is
a term COUNT, not a yes/no.

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
script into a gold timeline; a simulator produces provider-cadence transcript
events (full-restatement partials ~0.9 s, finals ~1.2 s after silence,
seeded ASR-style corruption). Runs in seconds, byte-for-byte reproducible;
this is what CI regression numbers come from.

**Tier B — live end-to-end.** The same performances are rendered by three
independent fal.ai TTS engines (`gemini-3.1-flash-tts`, `qwen-3-tts` 1.7 B,
`xai/tts/v1`), stitched at 24 kHz mono PCM16 with real silence for pauses,
streamed at real-time pace in 100 ms frames to the live Grok endpoint,
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

# Stream fixtures through live Grok STT (needs GROK_API_KEY; ~real time)
cargo run --release -p cc-bench -- capture --workdir /tmp/bench-work

# Replay captured runs (offline, no network)
cargo run --release -p cc-bench -- tier-b --label mine --out ../bench/results/mine-live.json

# Re-record the same scenarios against a DIFFERENT provider, without
# overwriting the frozen corpus. `--runs` is accepted by all three commands
# that touch a corpus and defaults to bench/runs.
cargo run --release -p cc-bench -- synth-audio --workdir /tmp/w --runs /tmp/new
cargo run --release -p cc-bench -- capture     --workdir /tmp/w --runs /tmp/new
cargo run --release -p cc-bench -- tier-b --label after --runs /tmp/new --out ../bench/results/after.json

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
| `perf.mean_event_us / p95_event_us` | Engine time per transcript revision. |
| `perf.scale_ratio_5k` | Per-event cost ratio, 5,000-word vs 300-word script (script-length independence). |
| `live.*` | The same ideas measured end-to-end on captured live STT runs, plus `live.wer` (diagnostic recogniser quality). |

## Reproducibility

Tier A is a pure function of (scripts, plans, seeds, config) — two runs are
identical. Tier B audio and provider events are frozen once captured;
`bench/runs/` is the immutable replay corpus and every result JSON embeds the
full `AlignmentConfig` it ran with. Audio itself is regenerable from the
committed scripts + plans via `synth-audio` (TTS clips are content-hash
cached) but is not required for replays.
