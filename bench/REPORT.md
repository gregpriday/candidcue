# Speech-to-script alignment: benchmark report

**Date:** 2026-07-26 · **Branch:** `inworld-only` · **Scope:** the new Rust
alignment engine (`crates/cc-align`), benchmarked end-to-end outside the app.

## What was built

A complete, deterministic speech-to-script alignment system in Rust, plus the
harness that proves it works:

```
Markdown script ──► cc-align compiler (canonical atoms, weights, anchor indexes)
live/simulated STT ──► transcript ledger (full-restatement partials, stability)
tail × candidate regions ──► weighted semi-global DP (affine gaps, integer costs)
evidence ──► two-phase tracker ──► Snapshot {confirmed, observed, display, state,
                                             confidence, suggestion}
```

* **`cc-align`** — pure engine: no I/O, no clocks, no randomness. Same crate
  runs live and in replay; two identical replays produce identical output.
* **`cc-stt`** — tauri-free Inworld streaming client speaking the exact wire
  protocol of `src-tauri/src/inworld` (Basic-auth header, `transcribeConfig`
  first, `result`-wrapped inbound, minted item ids, bytes-sent audio clock).
* **`cc-bench`** — performance plans with gold timelines, a synthetic
  Inworld-cadence simulator (Tier A), fal.ai TTS synthesis across three
  engines + live capture at real-time pace (Tier B), offline replay, a
  render-time evaluator, and this report's table generator.

### How the engine works (short version)

Every transcript revision is aligned in two phases. **Phase 1** aligns the
full evidence tail against a band around the predicted position — ordinary
reading, misspeaks, fillers, retractions and repetitions all resolve here.
Everything after the last *solid* match is the **unexplained suffix**; when it
grows, **phase 2** aligns just that suffix against globally indexed candidate
regions (rare tokens, unique n-grams, the visible viewport, an
always-available backward retake corridor, and — after repeated failure — a
windowed full-script sweep). Distant candidates pass through strict gates:
exact-content minimums, an evidence-only margin over the local explanation, a
rival-cluster ambiguity check that keeps duplicate passages honest, and
persistence across revisions (one extra round if the target isn't even
visible). The display extrapolates the observed position by the estimated
reading rate, bounded and lag-compensated per timestamp kind — partials lag
speech by ~400 ms, finals by ~1.2–1.7 s, both measured against gold word
times on live captures.

The tracker deliberately spends its safety budget the way the research says
users experience it: **wrong jumps are the catastrophic failure; a
half-second of extra hold is noise.** Ambiguity (a refrain that appears three
times) produces an honest hold, not a guess; a far match accumulates as a
`suggestion` the UI may offer instead of a teleport.

## How it was measured

Two evidence tiers, one evaluator, one config:

* **Tier A** — 67 deterministic scenario runs across 7 fixture scripts
  (starter, product update, technical/numbers, thrice-repeated refrain,
  unusual proper nouns, long-form, 5,000-word scale). Synthetic events mimic
  the measured Inworld cadence (full-restatement partials ~0.9 s, finals
  ~1.2 s after silence, seeded ASR-style corruption). Reproducible to the
  digit; runs in seconds.
* **Tier B** — the same performances rendered by three independent fal.ai
  TTS engines (gemini-3.1-flash, qwen-3-tts 1.7 B, xai), stitched at 24 kHz
  mono PCM16, streamed at 1× through the **live Inworld endpoint** via the
  production wire protocol, captured as frozen replay fixtures in
  `bench/runs/` (~22 minutes of audio, 14 runs).

The display trajectory is sampled at 20 Hz against a gold timeline built from
the performance plan (per-segment TTS clip boundaries keep gold word timing
within ±1 word). Baseline and optimized engines were measured with the **same
final metric definitions** — the baseline engine ran via a git worktree with
the current harness synced in.

Scenario families cover exactly the behaviours asked for: read something at
the beginning → stop → read the ending; skip ahead; scroll around and re-say
something said further above (with and without the viewport hint); go
off-script and return; paraphrase; 15% ASR corruption; word/phrase
repetitions; a verbatim refrain repeated three times; a cold jump into a
section identified only by mangled proper nouns; 90→220 wpm; 5,000-word
scripts.

## What the optimization phase changed

Ten committed rounds, each justified by a benchmark delta (chronological):

1. **Two-phase tracking with the unexplained suffix** — discontinuities are
   evaluated on evidence the local alignment could NOT explain, so post-jump
   fidelity is not diluted by pre-jump words (skip recovery 23.6 s → ~6 s).
2. **Global search gated on weakness** — anchors are consulted only when
   local evidence fails, making per-event cost script-length independent
   (5k/300-word cost ratio 6.1× → 1.5×).
3. **Tail horizon** — evidence spoken before an accepted discontinuity is
   dead; without this an accepted retake snapped straight back.
4. **Evidence-only margins + observed-anchored classification** — a
   4,000-atom relocation can now beat nearby junk; the stale local candidate
   can no longer masquerade as a "backward retake" of itself.
5. **Windowed desperate search** — on anchor-poor self-similar text, the
   full script is swept in windows so duplicate passages surface as rival
   clusters and the ambiguity gate can hold honestly (500-atom skip on the
   5,000-word script: never-recovers → 5.6 s, zero false jumps).
6. **Display timing model** — per-timestamp-kind lag correction in the
   ledger (partials ~400 ms, finals ~1.2–1.7 s receipt bias), prediction cap
   1.8 s (freeze 22.4% → 0.3% Tier A; live within±2 71% → 88%).
7. **Solid-match anchoring** — one stray stopword match no longer marks the
   material after it as explained.
8. **Phonetic fallback** — a Soundex-class key (first letter code-classed:
   CandidCue↔Kandik) matches recogniser-mangled rare words as weak local
   evidence with zero discontinuity authority.
9. **Retake corridor + viewport-gated jumps + suggestions** — from the UX
   research: recently-read territory is always searchable backward; far
   targets outside the viewport charge an extra persistence round; the
   pending target is exposed to the UI as a suggestion instead of a teleport.
10. **Gate tuning by sweep** — persistence 2→1 with content 3 (safety
    unchanged: the margin + rival gates carry it), weak-detection thresholds
    tightened.
11. **Pause tolerance** (field report: "it keeps rushing forward when I
    pause") — the provider's VAD endpoint parks the display exactly where
    the reader stopped, `speechStarted` resumes the glide instantly, and a
    stale-evidence lead decays to a one-word rest instead of holding the
    full horizon. New `pause_overshoot` benchmark + 1s/2s/3s pause
    scenarios; overshoot 4.5 → 1.5 atoms (Tier A) with freeze still ~0.
12. **The display trails, it never leads** (field report: "it tends to jump
    too far ahead too often") — the stage stopped underlining a current word
    and now fades words out as it hears them, which makes the two directions
    of error worth completely different amounts. Trailing leaves a word
    legible a moment longer. Leading *erases a line the reader is still
    reading*. Three changes, all of them refusals to guess: a
    `prediction_gain` of 0.35 so extrapolation aims deliberately short of the
    reader rather than at them; a paragraph ceiling so prediction stops dead
    at a break and waits to actually hear the next paragraph; and a stale
    lead that decays to zero instead of to one word. New `ahead_*` benchmark
    family. Live time-spent-ahead 22.2% → 3.8%, incidents 65 → 6.

Fixture quality fixes found by the harness along the way: gemini-3.1-flash
TTS *performs* instruction-shaped text instead of reading it (now pinned with
a verbatim wrapper); Inworld rejects trailing audio chunks under 20 ms;
Inworld force-finalizes utterances at ~30 s on continuous speech.

## Results

Same benchmark definitions, same fixtures, same evaluator on both sides.
Baseline = the first working engine (commit `a9b5a37`); Optimized = the
current engine. Tier B rows replay the identical captured live event logs
through both engines.

| Benchmark | Unit | Better | Baseline | Optimized | Improvement |
|---|---|---|---:|---:|---|
| `safety.false_jumps` | count | lower | 0.000 | 0.000 | unchanged |
| `safety.catastrophic` | count | lower | 18.000 | 0.000 | 18 → 0 ✅ |
| `safety.ahead_events` | count | lower | 5.000 | 1.000 | 5 → 1 ✅ |
| `safety.ahead_worst` | atoms | lower | 3.444 | 2.392 | 30.5% lower ✅ |
| `overshoot.ahead_time` | % | lower | 2.826 | 0.306 | -2.52 pp ✅ |
| `overshoot.ahead_p95` | atoms | lower | 0.651 | -0.519 | 179.7% lower ✅ |
| `accuracy.clean_within2` | % | higher | 91.890 | 58.103 | -33.79 pp ⚠️ |
| `accuracy.clean_within5` | % | higher | 99.985 | 99.989 | +0.00 pp ✅ |
| `accuracy.clean_p95_abs` | atoms | lower | 2.185 | 2.992 | -36.9% lower ⚠️ |
| `accuracy.mean_signed_abs` | atoms | lower | 0.927 | 1.901 | -105.2% lower ⚠️ |
| `responsiveness.prefinal_move` | % | higher | 96.694 | 96.694 | unchanged |
| `responsiveness.freeze` | % | lower | 22.246 | 0.529 | -21.72 pp ✅ |
| `responsiveness.pause_overshoot_p95` | atoms | lower | 1.625 | 0.394 | 75.8% lower ✅ |
| `responsiveness.first_lock_p50` | s | lower | 2.650 | 2.650 | unchanged |
| `robust.corrupt15_within5` | % | higher | 96.775 | 96.207 | -0.57 pp ⚠️ |
| `robust.substitutions_within2` | % | higher | 90.257 | 53.163 | -37.09 pp ⚠️ |
| `robust.word_repeats_within5` | % | higher | 100.000 | 100.000 | unchanged |
| `robust.phrase_repeats_within5` | % | higher | 100.000 | 100.000 | unchanged |
| `recovery.skip_p95` | s | lower | 23.350 | 5.350 | 77.1% lower ✅ |
| `recovery.retake_p95` | s | lower | 15.250 | 5.350 | 64.9% lower ✅ |
| `recovery.adlib_p95` | s | lower | 0.050 | 0.050 | unchanged |
| `recovery.failures` | count | lower | 1.000 | 0.000 | 1 → 0 ✅ |
| `recovery.adlib_drift_p95` | atoms | lower | 1.740 | 3.000 | -72.4% lower ⚠️ |
| `viewport.start_lock_p50` | s | lower | 3.550 | 3.550 | unchanged |
| `names.cold_jump_lock_p95` | s | lower | 7.150 | 3.550 | 50.3% lower ✅ |
| `ambiguity.refrain_false_jumps` | count | lower | 0.000 | 0.000 | unchanged |
| `perf.mean_event_us` | µs | lower | 189.695 | 188.740 | 0.5% lower ✅ |
| `perf.p95_event_us` | µs | lower | 1836.000 | 942.000 | 48.7% lower ✅ |
| `perf.scale_ratio_5k` | × | lower | 5.707 | 1.476 | 74.1% lower ✅ |
| `live.within2` | % | higher | 76.345 | 69.683 | -6.66 pp ⚠️ |
| `live.within5` | % | higher | 89.410 | 93.390 | +3.98 pp ✅ |
| `live.p95_abs` | atoms | lower | 61.907 | 6.690 | 89.2% lower ✅ |
| `live.mean_signed_abs` | atoms | lower | 19.219 | 4.967 | 74.2% lower ✅ |
| `live.false_jumps` | count | lower | 1.000 | 1.000 | unchanged |
| `live.catastrophic` | count | lower | 7.000 | 1.000 | 7 → 1 ✅ |
| `live.prefinal_move` | % | higher | 98.113 | 100.000 | +1.89 pp ✅ |
| `live.freeze` | % | lower | 37.897 | 5.899 | -32.00 pp ✅ |
| `live.pause_overshoot_p95` | atoms | lower | 1.842 | 0.726 | 60.6% lower ✅ |
| `live.ahead_events` | count | lower | 65.000 | 6.000 | 65 → 6 ✅ |
| `live.ahead_time` | % | lower | 22.173 | 3.773 | -18.40 pp ✅ |
| `live.ahead_p95` | atoms | lower | 1.902 | 0.841 | 55.8% lower ✅ |
| `live.ahead_worst` | atoms | lower | 7.300 | 6.562 | 10.1% lower ✅ |
| `live.recovery_p95` | s | lower | 23.400 | 4.850 | 79.3% lower ✅ |
| `live.recovery_failures` | count | lower | 0.000 | 0.000 | unchanged |
| `live.first_lock_p50` | s | lower | 2.600 | 2.600 | unchanged |
| `live.wer` | % | higher_is_worse_diagnostic | 6.777 | 6.777 | unchanged |

### Reading the table

* The safety rows are the lexicographic headline: the optimized engine
  produces **zero false jumps everywhere and zero catastrophic periods
  across all 67 Tier A scenarios**; on live captures one catastrophic
  period remains (the mangled-names cold jump — see limitations), down
  from seven under the same strict definition. Skips and retakes recover
  4× faster than the baseline.
* Definitions were hardened after an external review: catastrophic
  counting is NOT gated on first lock (a wrong early lock counts), grace
  windows apply only around genuine reader discontinuities, and a display
  jump is false unless it lands near the reader's actual region.
* `accuracy.*` and `live.within*` are render-time, post-first-lock,
  on-script speaking samples of the ENGINE TARGET (the stage's smoothing
  is not modelled); lock latency is its own row, and a run that never
  locks scores zero accuracy and a recovery failure.
* Tier-B gold word times come from per-segment TTS clip boundaries with
  character-weighted interpolation, not forced alignment — treat ±1–2
  atoms of Tier-B gold noise as measurement floor.
* The pause rows must be read as a pair with freeze: the baseline's low
  `pause_overshoot` came from its 650 ms prediction cap — the same cap
  that froze it 22–40% of the time. The optimized engine holds BOTH: live
  freeze 37.9 → 4.9% with pause overshoot ~2 atoms (about one word past
  where the reader stopped, by design).
* `live.wer` is diagnostic (the recogniser's quality, not ours): ~0–4% on
  clean scripts, ~14% on the proper-noun and dense-number scripts — the
  conditions the robustness rows exist for.
* **The `ahead_*` rows and the `within2` rows are the two ends of one
  decision, and they must be read together.** The display fades words out as
  it hears them, so being early and being late are not the same mistake:
  late leaves a word legible a moment longer than it needed to be, early
  deletes a line the reader is still on. `within2` is a symmetric metric and
  therefore cannot express that — it scores a word early exactly as well as a
  word late. So the engine now aims deliberately short, `within2` falls
  (live 76 → 70%, Tier A 92 → 58%), `within5` does not (89 → 93% live), and
  the time spent ahead of the reader drops from 22.2% to 3.8%. Judge the
  display on `ahead_*` plus `within5`; `within2` is retained because it is
  the historical series, not because it is the objective.
* `ahead_*` measures against the HIGH-WATER MARK of what has been spoken,
  not the reader's instantaneous position, so re-reading a sentence does not
  register as the display "running ahead" — those words were genuinely
  already said, and nothing on screen has been erased early. Against
  instantaneous gold the metric scored 105 incidents of which ~100 were
  ordinary backward re-reads, which is the measurement equivalent of a
  smoke alarm that goes off when you cook.
* The floor for `live.ahead_*` is **not zero**: with prediction disabled
  entirely (`prediction_gain = 0`, `max_lead_atoms = 0`) the live captures
  still show 0.55% ahead-time and a 6.0-atom worst case, because in those
  moments the *aligner's* observed position is ahead of Tier-B's
  interpolated gold. So of the reducible 22.2%, the display model was
  responsible for essentially all of it, and 3.8% is close to the fixtures'
  measurement floor — while zero prediction would cost 37% freeze.

## Round two: when the script and the recogniser disagree on spelling

Everything above measures what happens when the reader departs from the
script. This round measures the opposite case, which turned out to be
unmeasured entirely: the reader says exactly what is written, and the
recogniser writes it down in a different notation than the author used.

Greg found it by reading a line of figures at the prompter — "twenty-seven,
one hundred and forty-three, RustLight Games, Cape Town, Tuesday the
twenty-eighth of July". Nothing was misheard. The provider simply wrote `27`
where the script wrote the words, `$2.4 million` where the script wrote
`2.4 million dollars`, `Rust Light` where the script wrote `RustLight`. Every
one of those is a word the display then had no way to match, and the corpus
had no fixture that could produce a single one of them: seven scripts of
ordinary prose, and a Tier-A simulator that says the script's own canonical
words back to the engine, so both sides agreed on spelling by construction.

### What was added

Two fixtures — `figures.md` (a page of numbers, money, dates, times, units and
versions) and `brands.md` (compound brand names, places, acronyms and mixed
alphanumerics) — and `crates/cc-bench/src/verbalize.rs`, a deterministic model
of what a recogniser writes back. Each script runs `exact` in its own spelling
as a control and four `asr_forms` families through the verbalizer, so the gap
between the two on the same script is the cost of the spelling disagreement
with everything else held constant. Both scripts are also in the Tier-B
selection, as plain reads, so the real provider decides its own spelling rather
than being handed a guess at it.

### What the engine got wrong, and what fixed it

| Written | Heard | Before | After |
|---|---|---|---|
| `three thirty` | `3:30` | `330` — one number nobody says | `3` `30` |
| `2019` | `two thousand and nineteen` | `2000` `and` `19` | `2019` |
| `1905` | `nineteen oh five` | `19` `oh` `5` | `1905` |
| `one hundred and twenty` | `a hundred and twenty` | `a` `hundred` `and` `20` | `120` |
| `1.2 seconds` | `one point two seconds` | `one` `point` `2` | `1.2` |
| `2.4 million dollars` | `$2.4 million` | `2.4` `dollars` `million` | `2.4` `million` `dollars` |
| `24kHz` | `24 kilohertz` | `khz` vs `kilohertz` | both `kilohertz` |
| `RustLight` | `Rust Light` | no atom either half can match | rejoined to `rustlight` |

The first seven are normalisation: colons and slashes now separate words
instead of gluing them, the `and` after a scale word is understood to be
inside the number rather than between two, a lone `one` heads a decimal,
`a hundred` is `one hundred`, a currency unit follows its scale word, and a
short closed list of unit abbreviations is spoken in full — but only after a
number, so `Ms Okonkwo` stays a person.

The last is not normalisation, because no normaliser can know where the space
should not have been. `CompiledScript::query_atoms` reconciles transcript word
boundaries against the script's own vocabulary: adjacent transcript atoms are
glued back together when the concatenation is a word THIS script contains and
the pieces are not all script words in their own right. A script that says
both `light` and `house` on its own keeps them apart — two words is a reading
it already supports, and choosing between them is the aligner's job.

### Two things the harness had to fix before the numbers meant anything

A review of this round found two defects in the measurement, both of which
made the first set of numbers unusable as a paired comparison.

**The gold was wrong inside every re-spelled run.** `PlanOp::Substitute`
advanced the reference position by whole atoms with `div_ceil`, but the
evaluator assumes each spoken word crosses exactly one atom. So `143` said as
five words made the reference sweep the *same* atom from start to end five
times, running forward and snapping back four times inside one number; and
`three thirty` written as `3:30` left the first of its two atoms untraversed
entirely. `GoldTag::Script` now carries the fractional span the word actually
covers, so the reader is a fifth of the way through `143` after saying "one".
The field is optional and absent from every frozen capture, where a word
crosses one whole atom and the old behaviour was already correct.

**`asr_forms` was 10% longer than the `exact` it was compared against.**
Five words for `143` were five word-times of speech, so the scenario billed as
"the same performance, differently spelled" was a different, slower
performance with more partials and more evidence. A re-spelled run now takes
exactly the clock its atoms would have taken. `figures__exact` and
`figures__asr_forms` are now both 208 events and 3,652 samples — the same
performance, to the event.

That second fix incidentally closed a third hole. The verbalizer reads
*compiled* atoms, so a normalisation change can alter which re-spellings fire:
once `24kHz` compiled to `24 kilohertz`, the unit rule stopped matching and a
different rendering took its place, and the before/after was quietly no longer
the same experiment (228 events against 229). With the clock fixed, a
rendering's word count no longer moves the timeline, and the unit rule now
matches either spelling. `forms.span_samples` is in the table as the tell: if
it differs between two results, they did not run the same benchmark and the
deltas next to it are directional only.

### Results

Tier A, same fixtures, same evaluator, identical synthetic input on both sides
(`forms.span_samples` = 4,412 for each). Engine before and after.

| Benchmark | Unit | Better | Baseline | Optimized | Improvement |
|---|---|---|---:|---:|---|
| `forms.span_within2` | % | higher | 40.503 | 51.587 | +11.08 pp ✅ |
| `forms.span_within5` | % | higher | 89.166 | 99.343 | +10.18 pp ✅ |
| `forms.span_p95_abs` | atoms | lower | 8.500 | 3.031 | 64.3% lower ✅ |
| `forms.within2` | % | higher | 47.883 | 53.533 | +5.65 pp ✅ |
| `forms.within5` | % | higher | 92.735 | 99.215 | +6.48 pp ✅ |
| `forms.figures_within5` | % | higher | 93.854 | 99.288 | +5.43 pp ✅ |
| `forms.brands_within5` | % | higher | 91.443 | 99.130 | +7.69 pp ✅ |
| `forms.corrupt_within5` | % | higher | 85.252 | 92.479 | +7.23 pp ✅ |
| `forms.freeze` | % | lower | 5.700 | 0.957 | -4.74 pp ✅ |
| `forms.false_jumps` | count | lower | 0.000 | 0.000 | unchanged |
| `forms.relocate_p95` | s | lower | 4.450 | 4.450 | unchanged |
| `forms.lock_failures` | count | lower | 0.000 | 0.000 | unchanged |
| `forms.span_samples` | count | — | 4412 | 4412 | same input ✅ |
| `perf.mean_event_us` | µs | lower | 197.585 | 177.407 | 10.2% lower ✅ |

The `span_*` rows are the ones to read. A whole-run number on a page of
figures is nine parts undisputed prose, so a total failure on every single
number would still leave the headline in the nineties; `forms.span_within5`
scores only the samples inside a re-spelled run and the 1.5 s after it, which
is where the failure lives. **Measured there, the display went from 89.2% to
99.3% within five words, and the 95th-percentile error fell from 8.5 words to
3.0** — which is the same 3.0 the paired `exact` control scores.

Every other row in the Tier-A table is byte-identical to the baseline —
safety, clean accuracy, robustness, recovery, viewport and ambiguity all
unmoved. That is the point of the shape of the fix: nothing here changes how
the engine decides, only what the two sides agree a word is.

`forms.relocate_p95` did not move, and it is the honest remaining gap: 4.45 s
to re-lock after a 168-atom jump into a name-dense passage. That is
relocation latency, not spelling, and it is a pre-existing engine
characteristic these fixtures inherit rather than create.

The engine also got faster, which it had no right to. The word-boundary fix
costs one hash lookup per transcript atom and initially made the engine 3.6%
slower; the library round below then found 10% somewhere else, so the net is
**10.2% below baseline** while doing strictly more work.

### What the real recogniser actually did

Three new Tier-B fixtures were captured — `figures/exact` (qwen),
`figures/pauses` (gemini) and `brands/exact` (xai) — plus `starter/long_pauses`,
which had been in the live selection since it was added and never captured.
`bench/runs` now holds 18 frozen runs. Both engines replay the identical logs.

| Benchmark | Better | Baseline | Optimized |
|---|---|---:|---:|
| `live.within2` | higher | 67.368 | 67.877 |
| `live.within5` | higher | 92.825 | 93.359 |
| `live.p95_abs` | lower | 7.184 | 6.520 |
| `live.freeze` | lower | 6.193 | 5.988 |
| `live.false_jumps` | lower | 1.000 | 1.000 |
| `live.catastrophic` | lower | 1.000 | 1.000 |
| `live.wer` | diagnostic | 7.526 | 7.343 |

Per new run:

| Run | within5 before | within5 after | p95 before | p95 after | WER |
|---|---:|---:|---:|---:|---:|
| `brands__exact__xai` | 92.3 | 96.1 | 7.92 | 4.53 | 8.9 |
| `figures__pauses__gemini` | 97.8 | 97.8 | 3.94 | 3.86 | 2.4 |
| `figures__exact__qwen` | 80.3 | 79.7 | 11.43 | 11.91 | 17.7 |

The live transcripts are worth reading directly, because they correct the
model. Inworld writes `27,000` and `19,400` with grouping commas, `143`,
`1.2 seconds`, `24 kHz`, `version 3.2`, `2019`, `the 28th of July` — and
`2.4 million dollars` in spoken order, not as `$2.4 million`. So the currency
reorder is a real shape but a rarer one than the verbalizer assumes, and the
decision NOT to touch compound ordinals is vindicated: the provider writes
`28th`, which already lands on the script's `20 eighth`. It also writes times
with colons — `9:00 a.m.`, `9:50` — which is the fix that came out of the
model, confirmed by the provider.

`figures__exact__qwen` is the one run that did not improve, and the reason is
in its WER: 17.7%, against 2.4% for the same script read by gemini. That voice
reading a page of figures produced transcripts like "the infrastructure bill is
56 million dollars a year" and "3302475905" for "three thirty, 24kHz, 1905".
None of that is a spelling disagreement — the words were not heard. A ±0.6-point
move on a run that noisy is not a signal, and it is left in the corpus as the
honest lower bound: on a bad voice, a page of numbers is bounded by the
recogniser, not by the engine.

### Four libraries, tried and measured

The obvious question after hand-writing a normaliser, a phonetic key and a
word-boundary rule is whether somebody has already done it better. Four crates
were swapped in and benchmarked against the frozen corpus. Three lost, and each
lost for a reason worth keeping.

**`rphonetic` 3.0.6 (Double Metaphone) — rejected.** Zero movement on every
Tier-A accuracy row and 0.15–0.17 pp worse on every live one. The reason is
structural rather than a defect: this relation is a last resort carrying a low
weight, so its job is recall — catching "Saoirse" heard as "Sawersi" at all —
and Double Metaphone is *more precise*, correctly separating "presenter" from
"president" while losing matches the looser consonant skeleton was getting for
free. It also panics outright on any non-ASCII input, because it uppercases and
then indexes by byte, so `á` becomes a two-byte `Á` and the next slice lands
mid-character. `Joaquín`, `Siobhán`, `Ōtautahi` — the exact input class the
relation exists for — take the process down. A fold to ASCII fixes that, and the
result still lost.

**`instant-segment` 0.11.1 (Viterbi word segmentation) — rejected, and the most
informative loss.** It should have been the principled version of
`rejoin_split_words`: joins *and* splits, decided by likelihood against the
script's own unigram and bigram counts, and it reaches the case the greedy rule
refuses on principle — a compound whose halves are both script words. That is
the case a review had flagged as an accidental limitation. Measured:
`forms.brands_within5` **fell** 0.90 pp, `forms.span_within5` fell 0.66 pp, and
the engine got 31% slower. Restricting it to only the case the greedy rule
declines produced *byte-identical* numbers — proving every join it adds is one
the greedy rule deliberately refuses, and that those joins are net harmful. The
timid guard is not an oversight. It is load-bearing, and the benchmark says so.
(It also shatters any input it does not recognise into single characters, which
a script-sized vocabulary guarantees; that needs a rejection filter before it is
safe at all.)

**`text2num` 2.6.5 (inverse text normalisation) — rejected.** More complete than
the hand-written parser in places — it produces `28th` for "the twenty eighth",
which is what the live provider actually writes — but it does not join years at
all: "nineteen ninety eight" comes back as `19 98`, "twenty twenty six" as
`20 26`, "nineteen oh five" as `19 oh five`. On a script whose fixture contains
six years that is fatal, and `forms.span_within5` fell 1.71 pp. At its default
threshold it also converts a lone "one", so "one of the reasons" becomes "1 of
the reasons" — the trap the hand-written parser exists to avoid. Worth noting
what happened when it changed the atom count: Tier B refused to replay, naming
the fixture and both counts. The fingerprint added earlier in this round worked
exactly as intended.

**`num2words` 1.2.0 (verbalisation) — adopted, in the benchmark.** Not for
accuracy; for provenance. Half the model's spoken forms now come from a crate
that has never seen this engine, which is the only real answer to the objection
that the model's author then fixed the engine to pass it. It also disagrees
usefully: it says a year as "twenty nineteen" where the hand-written branch says
"two thousand and nineteen", and both are things people say, so alternating
covers two real shapes where either alone covered one. The measured improvement
is unchanged under it (+10.18 pp against +10.13 pp), which is the result that
matters — the story does not depend on who wrote the model.

**What was kept from the failures.** Plugging in an external encoder forced the
phonetic key to be *precomputed* — once per script atom at compile time and once
per transcript atom per revision, instead of re-derived inside the DP inner loop
for every (query, script) cell. That is worth **10.4%** of the engine's entire
per-event cost (199.0 → 178.3 µs, three runs each side, spread ±0.5 µs) at
byte-identical accuracy, and it survives the library being thrown away. The
experiment that failed paid for itself.

### What a review of this round caught

Six defects, five of them in the measurement, all found by review rather than
by the suite, all fixed:

* **The emptiness sentinel was unsound for Unicode.** `PhoneticKey::is_empty`
  read `primary[0] == 0`, but that slot holds the first character cast to `u8`
  when it is not a consonant, and the cast is lossy — `ἀθήνα` begins with
  U+1F00, whose low byte is exactly zero. A word that WAS encoded reported
  itself unencoded and silently lost the relation. Now an explicit `filled`
  flag, with a regression test on the reachable lowercase case.
* **The precompute was not behaviour-preserving.** It measured eligibility in
  characters where the inline version measured bytes, quietly dropping short
  international names (`josé` is four characters and five bytes). Bytes
  restored; the move is now a move.
* **The re-spelling tail excluded pauses.** `forms.span_*` scored only while a
  word was in the mouth, so the 1.5 s tail — which exists to ask whether the
  display CAUGHT UP after a figure — was skipped exactly when the reader fell
  silent. That is the failure `asr_forms_pauses` was built to catch. Fixed; it
  does not move the numbers today because the fixtures' pauses do not land
  inside a window.
* **Ordinary paraphrases counted as spelling disputes.** Every
  `PlanOp::Substitute` was marked `respelled`, so the `substitutions` family
  reported per-run re-spelling metrics for a disagreement that was never about
  spelling. Now a flag on the op; those runs report zero.
* **Four checked-in result files stopped deserialising.** The three new
  `RunMetrics` fields had no `#[serde(default)]`, and `report`/`compare` read
  saved JSON directly, so the previous round's results could no longer be
  compared against. Deriving `Default` does not make a Serde field optional.
* `forms.span_samples` was tagged lower-is-better, so the report rendered a
  shrinking sample count as an improvement. It is a diagnostic: any movement
  is bad news, and it is now tagged to say so.

### Honest limitations of this round

* The verbalizer is a MODEL of provider behaviour, not a recording of it. It
  was written to be fair — several of its renderings already normalised
  correctly before any change (`nineteen ninety eight`, `three point two`,
  spelled cardinals) and are controls rather than targets — but a model can
  still be wrong about how often a shape occurs. Tier B is the check, and half
  the number forms now come from `num2words` rather than from the same hand
  that wrote the engine fix.
* **The frequency mix is chosen, not measured.** Every eligible run is
  re-spelled, once, consistently. The live traces show the provider doing
  neither: it re-spells some and not others, and changes its mind between
  partials of the same utterance — `one hundred twenty`, then `120`, then the
  words again, inside one item. Revision churn is the largest unmodelled
  behaviour here and is probably harder than any stable rendering, because the
  ledger tracks stability by canonical id and a notation flip retracts the
  atom. Modelling it from the frozen traces is the obvious next round.
* **The shape list is the shapes someone thought of.** Missing: 24-hour and
  `3:05` times, `07/28/2026`, ranges, scores, fractions, phone and account
  numbers, leading zeros, currency codes, `2.4M`, `°C`, `km/h`, initialisms
  written with spaces, and a name the provider both splits AND respells.
  Absence from `forms.*` is absence of evidence, not evidence of absence.
* **`brands.md` cannot exercise its own headline example.** Its explanatory
  prose writes "Rust Light" and "Candid Cue" as separate words, which makes
  `rust`, `light`, `candid` and `cue` script words in their own right — and
  the rejoin refuses a join when every piece is already a script word. So
  `RustLight` and `CandidCue` are never rejoined anywhere in that fixture; the
  +7.69 pp on `forms.brands_within5` comes from `SoundCloud`, `PagerDuty`,
  `OpenTable`, `BrightHarbour` and `LumenWorks`, whose halves do not appear
  alone. That is an accidental but useful negative case — it is the timid half
  of the rule, proving itself — and it is left in deliberately.
* `figures.md` line 5 says it tests both "I write twenty-seven and it writes
  27" and the reverse. It does not: both notations compile to the same `27`
  atom before the verbalizer sees them, so the harness cannot tell the
  author's two spellings apart. Only the recogniser's side of the
  disagreement is modelled.
* Compound ordinals are untouched. The script's canonical form for
  `twenty-eighth` is the two atoms `20 eighth`, which is self-consistent and
  matches `28th`, but a provider writing the bare cardinal `28` still lands
  nowhere near it. Unifying them would change the atom count of every script
  containing an ordinal — including `technical.md`'s `95th` — and atom indexes
  are what Tier-B gold is expressed in, so the fix would invalidate captured
  fixtures. It costs about 0.8 points of `figures__asr_forms`; the trade was
  not worth it.
* The rejoin only closes spaces. A recogniser that REMOVES a space the script
  had (`Cape Town` → `CapeTown`) is the symmetric case and is not handled,
  because nothing in the corpus produces it and an untested branch in the hot
  path is worse than a missing one.
* `bench/runs` gained four fixtures. The Tier-B engine and voice assignment
  is now pinned per run rather than derived from list position — it was
  `index % 3`, which meant inserting one entry silently re-voiced every entry
  below it, and five already-frozen runs would have been re-rendered and
  re-captured under new names at full cost for no new evidence.
* Every manifest now records the atom count its gold was captured against,
  and replay refuses a run whose script no longer compiles to that many atoms.
  Without it, a normalisation change that adds or drops one atom does not fail
  — it shifts every gold position in every captured run for that script, and
  the benchmark goes on printing plausible numbers about the wrong words.
* Tier-B TTS still speaks the compiled canonical atoms, not the authored text:
  `brands`'s performance is literally `rustlight`, `saas`, `rtx 4090 s`. Some
  of the 17.7% WER on `figures__exact__qwen` is that, not the recogniser.
  Speaking the authored surface needs the compiler to carry it, which is the
  right fix and a larger one.

## Round three: telling the recogniser what the script says

Everything above treats the transcript as given and asks the engine to cope.
`inworld/inworld-stt-1` accepts `transcribeConfig.prompts` — an array of terms
biasing the recogniser — which makes a different question available: how much of
the disagreement can be prevented rather than repaired?

`crates/cc-align/src/vocab.rs` builds the term list from the script; `cc-bench
prompt-ab` streams the same cached audio twice, differing only in that field.

| run | words | terms | wer − | wer + | raw − | raw + | hits −/+ |
|---|---:|---:|---:|---:|---:|---:|---:|
| `names__exact__xai` | 337 | 22 | 12.76 | **10.98** | 15.41 | **13.60** | 1 / **7** |
| `brands__exact__xai` | 406 | 29 | 10.59 | **6.65** | 13.74 | **9.16** | 12 / **18** |
| `technical__exact__qwen` | 305 | 8 | 10.49 | **8.52** | 24.15 | **20.41** | 1 / **2** |
| `figures__pauses__gemini` | 463 | 18 | 2.81 | 3.02 | 13.77 | **12.92** | 7 / **10** |

`wer` is against canonical atoms and answers "were the right words heard".
`raw` is against the AUTHORED page with no number folding and answers "were they
spelled the way it was written". `hits` counts the sent terms that came back
verbatim.

Names and brands move a long way: **−2.1 and −2.2 points of WER**, a fifth of
the recogniser's error on the two scripts built to be hard, with six and eight
more terms landing and none lost. `Nkosinathi Dlamini`, `Tsholofelo Ramaphosa`,
`Thandiwe Mkhwanazi`, `Ximena Achterberg`, `Kwabena Asare-Boateng`,
`BrightHarbour`, `PagerDuty` and `OpenTable` all arrive correctly spelled only
when they are asked for.

Figures behave exactly as the design predicted and are worth reading carefully.
Canonical WER does not move (2.81 → 3.02, noise): the normaliser was already
folding `27` onto `twenty-seven`, so there was nothing there to win. What moves
is the spelling — `raw` falls 0.85 points and four spelled-out figures
(`twenty-seven thousand`, `nineteen thousand four hundred`, `eighteen thousand`,
`one hundred`) start coming back in the script's own notation. So the bias works
on figures; it simply buys a fold the engine was already making for free.

### What over-biasing looks like, and what it cost

The first version of the extractor sent whatever orthography flagged and the
word list did not veto. On `technical.md` that was 17 terms, including `Rust`,
`API`, `IPC`, `backend`, `microphone`, `milliseconds` and `0.29`, and the
capture is the clearest single result in this report:

| | terms | wer − | wer + |
|---|---:|---:|---:|
| first extractor | 17 | 10.49 | **15.08** |
| after the length bars | 8 | 10.49 | **8.52** |

A 4.6-point WER *regression* turned into a 2.0-point improvement by sending
fewer than half as many terms. Counting the words tells you exactly why: with
the loose list the recogniser wrote `rust`, `websocket`, `api`, `ipc` and
`authorization` TWICE each where the script said them once — around nine
insertions in 305 words. Every one of those terms is ordinary technical English
that no recogniser struggles with, so biasing them could not improve
recognition and could only inflate their prior until the model started finding
them in places nobody said them.

The rule that came out of it: a term must be genuinely hard, not merely absent
from a 2,800-word list. Plain lowercase words are never sent; an ordinarily
cased proper noun needs six letters; an initialism needs four; a lone figure
needs a real letter that is not an ordinal suffix. `Þorvaldsdóttir`, `24kHz`,
`WebSocket` and `GDPR` clear that bar. `Rust`, `API`, `95th` and `3.2` do not.

### The alignment number, and the one knob that moved it

Transcription is not the product. Both sides of every capture are kept as
replay fixtures, so the alignment suite scores them on the same ruler as
everything else in this report.

With the loose extractor, following got *worse* in the one direction this UI
cannot afford: `ahead_events` rose, a false jump appeared, and `ahead_worst`
grew a quarter of an atom, even as WER fell. Tightening the extractor removed
most of that on its own — false jumps returned to zero and `ahead_worst` came
level — because the engine stopped anchoring on rare words nobody said.

Closing the remainder took one configuration change, and finding it meant
discarding the obvious theory first. The suspicion was that the engine leans on
rare-word evidence because that evidence used to be scarce and mangled, so
`rank_w_matched_weight` — the ranking term that rewards matching heavy, rare
atoms — should be the culprit. It is not. Sweeping it across 0.15–0.35 changed
every metric by **exactly zero**, and so did `max_lead_atoms`, `jump_margin`,
`jump_persistence`, `jump_min_content`, `discontinuity_atoms` and `coast_ms`.
The drift is not in ranking and not in relocation. It is in plain extrapolation
between transcript events, which a cleaner transcript simply makes the engine
more willing to do, and the prediction gains are the only knobs that touch it.

`prediction_gain` 0.35 → **0.33**. `prediction_gain_fast` is deliberately left
alone: it exists for pipeline delay at pace, it was tuned against its own
benchmarks in the round that landed it, and four runs is not evidence enough to
overrule that.

0.31 was available and rejected. It drives `ahead_events` back down to the
no-vocabulary count of 6, and it costs 1.8–4.5 pp of `within2` across the three
corpora to do it. That is a lot of accuracy for one event in a four-run sample,
particularly when `ahead_worst` — how far the display actually got in front of
the reader — is already level. Depth is what erases a line somebody is reading.
The count is not worth that price.

**Before** is `main`: no vocabulary, `prediction_gain` 0.35. **After** is
vocabulary plus 0.33. Same four audio renderings, one variable set changed.

| metric | before | after | |
|---|---:|---:|---|
| `live.within5` | 96.311 % | **96.490 %** | +0.18 pp ✅ |
| `live.within2` | 71.471 % | **71.837 %** | +0.37 pp ✅ |
| `live.p95_abs` | 4.375 | **4.174** | −0.20 atoms ✅ |
| `live.wer` | 8.670 % | **6.883 %** | −1.79 pp ✅ |
| `live.ahead_time` | 4.605 % | **4.538 %** | −0.07 pp ✅ |
| `live.ahead_p95` | 0.951 | **0.928** | −0.02 atoms ✅ |
| `live.ahead_worst` | 3.246 | **3.229** | −0.02 atoms ✅ |
| `live.false_jumps` | 0 | 0 | — ✅ |
| `live.catastrophic` | 0 | 0 | — ✅ |
| `live.freeze` | 4.249 % | 4.249 % | — ✅ |
| `live.prefinal_move` | 100 % | 100 % | — |
| `live.first_lock_p50` | 2.300 s | 2.300 s | — |
| `live.mean_signed_abs` | 1.523 | 1.529 | +0.01 atoms ❌ |
| `live.pause_overshoot_p95` | 0.498 | 0.562 | +0.06 atoms ❌ |
| `live.ahead_events` | 6 | 7 | +1 ❌ |

Every measure of how FAR and how LONG the display gets in front of the reader
improves. The count of times it happens at all goes up by one, across sixteen
minutes of audio. That is the honest shape of this result and it is not a clean
sweep: three rows move the wrong way, two of them by hundredths of an atom.

### What the gain change costs where there is no vocabulary

`prediction_gain` is global, so the corpora captured before this feature existed
are worth checking. They trade a little accuracy for a little safety, which is
the same exchange in the other direction:

| | frozen tier-B (18 runs) | | tier A (synthetic) | |
|---|---:|---:|---:|---:|
| | 0.35 | 0.33 | 0.35 | 0.33 |
| `within5` | 95.509 % | 95.476 % | 99.991 % | 99.991 % |
| `within2` | 70.368 % | 69.490 % | 59.251 % | 57.114 % |
| `p95_abs` | 4.638 | 4.673 | 2.809 | 2.831 |
| `ahead_time` | 4.677 % | **4.509 %** | 0.252 % | **0.216 %** |
| `ahead_p95` | 0.990 | **0.945** | −0.519 | **−0.546** |
| `ahead_worst` | 7.481 | **7.454** | 2.392 | **2.313** |
| `false_jumps` | 0 | 0 | 0 | 0 |
| `catastrophic` | — | — | 0 | 0 |

`within5` is unmoved to a rounding error in both. The cost lands almost entirely
on `within2`, which this project deliberately does not judge on: a symmetric
±2-atom band scores a display running two atoms AHEAD exactly as well as one
two atoms behind, and those are not the same event on a fading prompter.

### What this round is still not

* **Four paired captures, one voice each.** Every number above is a real live
  measurement, but the corpus is `names`, `brands`, `technical` and
  `figures/pauses` — not the eighteen runs the frozen corpus carries. Baseline
  run-to-run variance was measured directly by repeating `brands` and came to
  roughly 0.5 pp of WER, which is the scale below which nothing here should be
  believed. `live.ahead_events` moves in whole counts and there are six of them;
  it is a coarse instrument at this sample size.
* **The frozen corpus is now one generation behind production.** It was captured
  without vocabulary, so it no longer describes what the app sends. It remains
  the broad regression guard and was checked as one, but the honest next step is
  a full re-capture with vocabulary on, at which point the `prediction_gain`
  choice should be re-swept against it rather than inherited.
* **`brands` is measuring itself slightly wrong.** Its prose quotes the
  spellings the recogniser gets WRONG ("it writes Rust Light"), so `Rust Light`
  and `Candid Cue` are extracted as terms and biased FOR. `Candid Cue` duly
  shows up in the gained list. The fixture's own explanatory text is working
  against the fixture, as `brands.md cannot exercise its own headline example`
  below already notes.

## Honest limitations

* `recovery.adlib_drift_p95` regressed (1.7 → 3.0 atoms): the baseline's
  frozen display couldn't drift during ad-libs because it barely moved at
  all; the optimized display predicts forward and pays ~2 words of drift
  before the hold engages. The trade was accepted deliberately — freeze fell
  from 22% to 0.5%.
* **The benchmark measures the engine's display position, not the pixels.**
  The stage adds its own comfort lead on top (`prediction.leadSeconds`,
  default 0.38 s) by sampling `display_at` in the future, which the evaluator
  does not model. Replaying the live captures with that lead applied costs
  3.8% → 6.5% time-ahead (9.6% at the 0.6 s maximum). Every `ahead_*` number
  here is therefore a floor for what the app shows until that lead is zeroed
  for the fade display.
* The paragraph ceiling is a structural rule, so it is only as good as the
  script's structure: it does nothing inside a single long paragraph, which
  is exactly where a reader who pauses mid-sentence gets the least
  protection. `prediction_gain` and `max_lead_atoms` carry that case, and
  they are blunter instruments. A sentence-level ceiling would be the
  natural next refinement.
* One live catastrophic period and a 6.6-atom `ahead_worst` remain, and
  neither is a display-model failure — both are the aligner's observed
  position drifting on the hardest fixture. See the measurement-floor note
  above.
* Tier-B accuracy on the names/technical scripts is bounded by recogniser
  WER (13–16%); the engine holds honestly rather than guessing, which caps
  `live.within2` around 87% until authored aliases / provider biasing exist.
* One live catastrophic period remains (down from five): the cold jump into
  the mangled-proper-noun section with no viewport hint — the deliberately
  hardest case in the corpus. Its trace is preserved in
  `bench/runs/names__names_cold_jump__gemini/`.
* Confidence is a documented heuristic, not yet a calibrated probability
  (spec §11 calibration is future work; the harness already logs everything
  needed to train it).

## Reproducing

```bash
cd crates
cargo run --release -p cc-bench -- tier-a --label mine          # ~15 s
cargo run --release -p cc-bench -- tier-b --label mine          # offline replay
cargo run --release -p cc-bench -- inspect starter skip_forward # decision trace
```

See `bench/README.md` for the full command set and benchmark definitions.

---

# The on-device recogniser swap (2026-07-29)

Inworld's hosted websocket was replaced by a bundled sherpa-onnx streaming
Zipformer (EN 20M, INT8, ~43 MB). This section is the evidence for that change.

## How the comparison was made

`fal.ai` TTS **does not render the same performance twice** — re-synthesising
the Tier-B plans produced audio differing from the frozen fixtures by up to
9.4 s on a 65 s run, and all 15 comparable runs differed. So scoring a new
local capture against the frozen `bench/runs/` corpus would have confounded
"different recogniser" with "different audio".

Both recognisers were therefore given the SAME freshly rendered audio:

| corpus | recogniser | audio |
|---|---|---|
| `bench/runs/` | Inworld | frozen (historical) |
| `bench/runs-inworld-new/` | Inworld | new |
| `bench/runs-local/` | on-device Zipformer | new (identical to above) |

33.1 minutes of speech, 18 runs, captured at 1.0x real time through the same
`SttFrame` protocol, replayed through the same engine and scored by the same
evaluator against each corpus's own gold timeline. **Columns 2 and 3 are the
comparison. Column 1 is continuity with the numbers already in this file.**

## Tier A is unchanged, and is not evidence here

39 of 42 Tier-A metrics are byte-identical before and after; the three that
differ are the wall-clock `perf.*` timings. That is the point: Tier A drives the
engine with SYNTHETIC events modelling the hosted provider's cadence, so it
measures the alignment engine — which this change does not touch — and says
nothing about the recogniser.

## Tier B

| metric | unit | Inworld (frozen audio) | Inworld (same audio) | local (same audio) | delta |  |
|---|---|---|---|---|---|---|
| `live.within2` | % | 69.49 | 70.61 | 77.16 | +6.55 | better |
| `live.within5` | % | 95.48 | 95.64 | 92.19 | -3.46 | worse |
| `live.p95_abs` | atoms | 4.67 | 4.59 | 7.42 | +2.83 | worse |
| `live.mean_signed_abs` | atoms | 3.67 | 3.13 | 3.09 | -0.03 | better |
| `live.false_jumps` | count | 0 | 0 | 0 | 0 | = |
| `live.catastrophic` | count | 0 | 0 | 0 | 0 | = |
| `live.prefinal_move` | % | 100.00 | 100.00 | 100.00 | 0 | = |
| `live.freeze` | % | 4.83 | 5.85 | 8.18 | +2.33 | worse |
| `live.pause_overshoot_p95` | atoms | 0.69 | 0.70 | 1.21 | +0.51 | worse |
| `live.ahead_events` | count | 14 | 19 | 37 | +18.00 | worse |
| `live.ahead_time` | % | 4.51 | 5.12 | 7.20 | +2.08 | worse |
| `live.ahead_p95` | atoms | 0.94 | 1.04 | 1.26 | +0.22 | worse |
| `live.ahead_worst` | atoms | 7.45 | 6.39 | 6.58 | +0.19 | worse |
| `live.recovery_p95` | s | 4.85 | 3.40 | 5.80 | +2.40 | worse |
| `live.recovery_failures` | count | 0 | 0 | 0 | 0 | = |
| `live.first_lock_p50` | s | 2.30 | 2.40 | 3.10 | +0.70 | worse |
| `live.wer` | % | 7.34 | 6.29 | 19.27 | +12.98 | diagnostic |


## What the recognisers actually did

| | Inworld | on-device |
|---|---|---|
| utterances | 100 | 117 |
| partials | 1,912 | 4,695 |
| partials/min | 57.8 | **142.0** |
| word error rate | 6.29% | 19.27% |
| decode cost | network round trip | RTF 0.017 (1 thread) |
| model on disk | — | 43 MB |
| cost per take | billed per minute | none |

## Reading the result

**Word error rate tripled and following barely moved.** That is the thesis of
this whole system holding up under measurement: the recogniser is a noisy
position sensor, not a transcript source, and `cc_align` resolves position
against a script it already has. Three times the lexical noise bought a 3.5
point drop in `within5`.

**Safety is intact.** `false_jumps`, `catastrophic` and `recovery_failures` are
all 0 on both sides, and `prefinal_move` is 100% on both. By the rule this
harness is built around — safety is lexicographically first — the swap does not
regress.

**The real costs are latency-shaped, not accuracy-shaped:**

* `first_lock_p50` 2.40s -> 3.10s. The model drops roughly the first five words
  of a stream (confirmed as the model, not the feeding: a whole-buffer decode
  loses them too), so the first lock waits for the second phrase.
* `recovery_p95` 3.40s -> 5.80s. Same cause after a jump — a relocation has to
  re-acquire from a transcript that starts late.
* `within5` 95.6% -> 92.2%, `p95_abs` 4.6 -> 7.4 atoms. A fatter tail: the
  middle of the distribution actually tightened (`within2` +6.6), but the bad
  moments are worse.

**`ahead_*` is mostly an artefact of a stale constant, and that is measurable.**
`partial_lag_ms` describes the RECOGNISER's pipeline delay: ~300 ms of network
and server buffering for the hosted service, ~0 for a local transducer that
publishes in the same call that consumed the samples. Left at 300 it pushes the
display forward for a delay that no longer exists:

| `partial_lag_ms` | `ahead_events` | `ahead_time` | `within5` |
|---|---|---|---|
| 300 (hosted calibration) | 37 | 7.20% | 92.19 |
| 0 (correct for on-device) | 26 | 5.22% | 92.26 |
| *Inworld, for reference* | *19* | *5.12%* | *95.64* |

Setting it to 0 recovers nearly the whole ahead-bias regression at no cost to
`within5`. It is **not** changed yet, because it is not only the app's constant:
`synthetic.rs` models the hosted cadence explicitly (`PARTIAL_LAG_MS = 400`,
`PARTIAL_EVERY_MS = 900`), so zeroing it alone drops `accuracy.clean_within2`
from 57.1% to 41.1% — scoring the engine against a cadence no recogniser now
produces. Correcting it properly means re-basing Tier A on the shipping
recogniser's cadence, which invalidates every historical Tier-A number here.
That is a deliberate decision, not a tweak.

## The lever list, in the order worth pulling

1. **`partial_lag_ms` -> 0**, with Tier A's simulator re-based to the on-device
   cadence at the same time. Quantified above.
2. **The lost opening words.** Feeding ~300 ms of silence before the first real
   audio, or priming the decoder at session start, would attack `first_lock`
   and `recovery` together — the two largest regressions.
3. **Hotword biasing**, which this swap gave up: sherpa supports it, but only
   under `modified_beam_search` with a `bpe.vocab` the 20M bundle does not
   ship. `cc_align`'s extractor is still there and still exercised by
   `prompt-ab`.
4. **A larger model.** The 20M is the smallest streaming Zipformer; the same
   integration takes a bigger one unchanged if WER turns out to matter more
   than this corpus suggests.

---

## Optimisation pass (2026-07-29, after the swap landed)

Two changes did almost all of the work, and a third fixed a benchmark that was
measuring the wrong thing.

### 1. `blank_penalty = 3.0` — the counter-intuitive one

The model's worst habit was emitting **blank** over roughly the first five words
of a stream, losing them for good. That, not the encoder's context window, is
what made the first lock slow: decoder priming with leading silence was tried
and changed nothing, because the words were being decoded and discarded rather
than never reaching the decoder.

Penalising blank makes the decoder commit to a token where it would have
skipped. Swept on the Tier-B corpus:

| blank_penalty | first_lock | recovery_p95 | within5 | p95_abs | WER |
|---|---|---|---|---|---|
| 0.0 | 3.10 s | 4.35 s | 92.26 | 7.40 | 19.3% |
| 2.0 | 2.40 s | 4.35 s | 92.55 | 7.25 | 19.4% |
| **3.0** | **2.10 s** | **3.60 s** | **92.74** | **6.99** | 20.1% |
| 5.0 | 2.10 s | 3.60 s | 91.84 | 7.92 | 24.7% |
| 6.0 | 2.10 s | 3.60 s | 90.69 | 9.03 | 31.2% |

**Word error rate gets worse while following gets better**, monotonically, up to
a clear turn at 3.0. That is the clearest statement this benchmark has produced
of what the recogniser is for: a wrong word inside a correct run costs the
tracker nothing, a missing word costs it evidence, and past 3.0 the guesses stop
being anchored to anything at all.

WER is a diagnostic here. It is not the objective, and tuning to minimise it
would have made the product worse.

### 2. Engine constants re-calibrated to the new recogniser

* `partial_lag_ms` 300 -> **0**. It corrects for the delay between audio and
  hypothesis; the hosted service had a network round trip, a local transducer
  publishes in the same call that consumed the samples.
* `max_lead_atoms` 2.5 -> **1.75**. Tightening the display's permitted lead cut
  `recovery_p95` from 5.80 s to 4.35 s on its own.

### 3. Tier A was simulating a recogniser that no longer exists

`synthetic.rs` fabricated Inworld-shaped events: partials every 900 ms lagging
400 ms. Measured on `bench/runs-local`, the on-device model emits every **300 ms**
with ~0 lag. Scoring the engine against the old simulator while the config was
calibrated for the new recogniser made `partial_lag_ms = 0` look like a
16-point regression no presenter could ever have experienced.

Re-based, Tier A measures the system that ships:

| Tier A, clean reads | Inworld-cadence sim | on-device sim |
|---|---|---|
| `clean_within2` | 57.11% | **99.88%** |
| `clean_within5` | 99.99% | **100.00%** |
| `clean_p95_abs` | 2.83 | **1.21** |
| `responsiveness.freeze` | 0.517% | **0.012%** |
| `first_lock_p50` | 1.75 s | **1.35 s** |
| `robust.substitutions_within2` | 51.07% | **99.13%** |
| `robust.corrupt15_within5` | 97.97% | **99.66%** |

**Tier-A numbers from before this re-base are not comparable with numbers from
after it.** Three times the evidence rate is most of the difference.

### Measured and rejected

* **Decoder priming** (300 ms / 1000 ms of leading silence): no effect on the
  lost opening words. The knob survives, defaulted off, with the negative
  result recorded, because it is an obvious thing to try twice.
* **`modified_beam_search`**: worse on every axis (`within5` 91.04,
  `recovery_p95` 5.95) and slower. Greedy stays.
* **`blank_penalty` above 3.0**: WER degrades faster than the extra evidence
  helps; every metric turns.
* **`endpoint_lag_ms`, `coast_ms`, `max_prediction_ms` >= 1800**: no measurable
  effect on this corpus.

### Fairness note

The Inworld baseline was swept over the same knobs and is already at its
optimum — the best alternative config moved `within5` by 0.11 and left
`first_lock` and `recovery_p95` untouched. The comparison is a tuned
on-device recogniser against a tuned hosted one, not against a handicapped one.

---

## Model swap: x-asr replaces the 20M Zipformer (2026-07-29)

The 20M model was the smallest streaming Zipformer available and it showed: it
dropped roughly the first five words of every stream, which is what made
`first_lock` and `recovery_p95` the two worst metrics of the swap.

`x-asr-480ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05`
replaces it. On the same 18-run corpus, each recogniser scored with the
`partial_lag_ms` its own cadence calls for (see below), under main's motion
model:

| metric | Inworld (hosted) | 20M Zipformer | **x-asr 480 ms** |
|---|---|---|---|
| `within5` | 94.69% | 90.11% | **94.03%** |
| `p95_abs` | 5.12 | 7.91 | **5.43** |
| `first_lock_p50` | 2.40 s | 2.40 s | **2.00 s** |
| `ahead_time` | 2.21% | 1.60% | **2.00%** |
| `freeze` | 3.68% | 5.44% | **3.33%** |
| `recovery_p95` | 3.40 s | 3.90 s | 3.80 s |
| `wer` | 6.29% | 20.05% | 10.86% |
| `false_jumps` / `catastrophic` / `recovery_failures` | 0 / 0 / 0 | 0 / 0 / 0 | **0 / 0 / 0** |

**This is parity with the hosted service.** It finds the reader faster, runs
ahead less and freezes less; it is 0.66 points behind on `within5` and 0.4 s
behind on re-lock.

The thing it fixed is visible in the captured event logs. The FIRST STREAMING
PARTIAL of `starter__exact__gemini`, whose script opens "Hi. If you're reading
this sentence off the screen right now…":

| | first partial | at |
|---|---|---|
| 20M Zipformer | `'S` | 3300 ms |
| **x-asr** | `Hi` | **1600 ms** |

The 20M model had already thrown away "Hi if you're reading thi" before it
emitted anything; x-asr has the first word of the script 1.7 s earlier. That is
`first_lock_p50` 2.40 s -> 2.00 s, in the raw data rather than in aggregate.

It also emits punctuation and true case, so the transcript is displayable for
the first time.

### Cost

* **161 MB on disk** against 43 MB. The INT8 encoder alone is 148 MB.
* **RTF 0.033** against 0.017 — still about 3% of one core.
* Load time 1.25 s against 0.2 s, which is what `preload_speech_engine` is for.

### `partial_lag_ms` is a property of the RECOGNISER

The most transferable lesson of this pass. It corrects for the delay between
audio arriving and a hypothesis covering it, so it tracks chunk size:

| recogniser | measured partial interval | correct value |
|---|---|---|
| Inworld (hosted) | 1000 ms | 300 |
| streaming-zipformer-en-20M | 300 ms | 0 |
| x-asr 480 ms (shipping) | 500 ms | 400 |

Leaving it at 0 for x-asr costs `first_lock` 3.80 s against 2.00 s and
`within5` 91.81 against 94.03. Changing the model without changing this
constant throws away most of the model.

### Models measured and rejected

* **`streaming-zipformer-en-2023-06-26`** (310 MB, 66M params). Bigger, but
  trained on LibriSpeech only — the same corpus as the 20M it would replace, so
  it buys American-English accuracy and nothing at all for the accent risk that
  is this feature's real exposure.
* **`streaming-zipformer-en-kroko-2025-08-06`** (57 MB). Attractive size, but
  documented as taking ~1.5 s before it emits its first token. `first_lock` is
  the metric this whole pass exists to protect.

### A note on reading `within2` and `p95_abs` after main's motion rework

`lead_margin_atoms: 2.2` parks the display 2.2 atoms behind the reader on
purpose. That makes `accuracy.clean_within2` structurally unreachable — it
reads 0.50% at the shipped margin and 98.63% at margin 0, with `within5`
unmoved at 99.99% either way — and inflates every `p95_abs` by roughly the
margin. x-asr's `p95_abs` of 5.43 is therefore about 3.2 atoms of real tracking
error. Neither number is a regression; both are the intended trade.
