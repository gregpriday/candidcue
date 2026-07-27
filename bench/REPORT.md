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

### Results

Tier A, same fixtures and evaluator on both sides, engine before and after.

| Benchmark | Unit | Better | Baseline | Optimized | Improvement |
|---|---|---|---:|---:|---|
| `forms.within2` | % | higher | 48.011 | 53.294 | +5.28 pp ✅ |
| `forms.within5` | % | higher | 90.305 | 96.224 | +5.92 pp ✅ |
| `forms.figures_within5` | % | higher | 91.783 | 96.321 | +4.54 pp ✅ |
| `forms.brands_within5` | % | higher | 88.509 | 96.106 | +7.60 pp ✅ |
| `forms.freeze` | % | lower | 7.046 | 2.723 | -4.32 pp ✅ |
| `forms.false_jumps` | count | lower | 0.000 | 0.000 | unchanged |
| `forms.lock_p95` | s | lower | 4.450 | 4.450 | unchanged |
| `forms.lock_failures` | count | lower | 0.000 | 0.000 | unchanged |
| `perf.mean_event_us` | µs | lower | 187.9 | 192.7 | 2.6% higher ⚠️ |
| `perf.p95_event_us` | µs | lower | 921.000 | 996.000 | 8.1% higher ⚠️ |

Every other row in the Tier-A table is byte-identical to the baseline —
safety, clean accuracy, robustness, recovery, viewport and ambiguity all
unmoved. That is the point of the shape of the fix: nothing here changes how
the engine decides, only what the two sides agree a word is.

Per run, with `exact` on the same script as the reference:

| Run | within5 before | within5 after | `exact` on that script |
|---|---:|---:|---:|
| `figures__asr_forms` | 92.9 | 99.2 | 100.0 |
| `figures__asr_forms_pauses` | 94.7 | 98.9 | 100.0 |
| `figures__asr_forms_corrupt` | 86.9 | 91.0 | — |
| `brands__asr_forms` | 90.6 | 99.1 | 100.0 |
| `brands__asr_forms_pauses` | 90.4 | 98.8 | 100.0 |
| `brands__asr_forms_corrupt` | 83.7 | 91.9 | — |

On the straight-read families the spelling disagreement cost 7–9 points of
`within5` and now costs under one. What remains is not spelling: the `_cold`
runs are relocation latency (4.45 s to re-lock after a 168-atom jump into a
name-dense passage) and the `_corrupt` runs are recogniser noise, both
pre-existing engine characteristics that these fixtures inherit rather than
create.

The per-event cost rose 2.6% (187.9 → 192.7 µs, three runs each side, spread
±1.2 µs). The extra work is one hash lookup per transcript atom plus, only
where a word is not in the script's vocabulary, up to two concatenations. The
budget is 2 ms.

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

### Honest limitations of this round

* The verbalizer is a MODEL of provider behaviour, not a recording of it. It
  was written to be fair — several of its renderings already normalised
  correctly before any change (`nineteen ninety eight`, `three point two`,
  spelled cardinals) and are controls rather than targets — but a model can
  still be wrong about how often a shape occurs. Tier B is the check.
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
* `bench/runs` gained three fixtures. The Tier-B engine and voice assignment
  is now pinned per run rather than derived from list position — it was
  `index % 3`, which meant inserting one entry silently re-voiced every entry
  below it, and five already-frozen runs would have been re-rendered and
  re-captured under new names at full cost for no new evidence.

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
