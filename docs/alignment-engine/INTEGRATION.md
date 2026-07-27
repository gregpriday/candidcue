# Integrating the Rust alignment engine (`cc-align`)

**Audience:** the frontend/stage agent wiring the new speech-to-script
alignment engine into the app.
**Engine location:** `crates/cc-align` (pure Rust, no Tauri/network/clock
dependencies — it slots into the existing Rust backend next to the Inworld
socket).
**Benchmarked behaviour:** `bench/REPORT.md` — zero false jumps across the
suite, 99.99% within ±5 words on clean reads, and the display ahead of the
reader 3.8% of the time on live captures (down from 22.2%). Read it to know
what the engine promises. Note the deliberate asymmetry before tuning
anything on top of it: **the display is built to trail the reader, never to
lead**, so the symmetric ±2-word figure is intentionally not the objective.

---

## 1. The mental model

The engine consumes the transcript frames the Rust Inworld session already
produces and emits one `Snapshot` per transcript event (~1/second). A
snapshot is not a scroll command — it is the engine's best statement of
*where the reader is*, plus how confident it is and what mode it's in. The
stage owns all animation.

```
src-tauri inworld socket ──SttFrame──► Engine::handle(SessionEvent) ──► Snapshot
     (already exists)                        (new, Rust side)              │
                                                                           ▼
                                            stage WebView: 60 Hz motion from
                                            snapshot.display_at(now) + smoothing
```

Three positions, one per concern:

| Field | Meaning | Use it for |
|---|---|---|
| `confirmed` | Conservative anchor; monotonic except accepted retakes / manual moves | progress %, "words covered", recovery UI |
| `observed` | Best evidence-supported position right now (may retract a little on partial revisions) | debugging, coverage |
| `display_at(t)` | Where the display should place the reader at audio-clock time `t` — observed + rate·horizon, lag-compensated and capped | **the scroll target** |

Positions are fractional boundaries in **spoken-atom space** (see §4 for
mapping atoms → DOM).

## 2. Session wiring (Rust side)

```rust
use cc_align::{compile, CompileOptions, AlignmentConfig, Engine, SessionEvent};

// At take start:
let script = compile(&markdown_source, CompileOptions { read_headings: false });
let mut engine = Engine::new(script, AlignmentConfig::default());

// For every SttFrame the inworld session emits (same wire data it already
// sends to the renderer):
let snapshot = match frame {
    SttFrame::ItemStarted { item_id, audio_start_ms, .. } =>
        engine.handle(SessionEvent::ItemStarted { item_id, audio_start_ms }),
    SttFrame::Partial { item_id, text, .. } =>
        engine.handle(SessionEvent::Partial { item_id, text, audio_ms }),
    SttFrame::Final { item_id, text, audio_end_ms, .. } =>
        engine.handle(SessionEvent::Final { item_id, text, audio_end_ms }),
    _ => /* transport frames don't feed the engine */ return,
};
// Ship `snapshot` to the stage over an ordered channel (Tauri Channel, not
// global events). ~1 message/second — no throttling needed.
```

**The audio clock.** `audio_ms` is the session's bytes-sent clock the Inworld
module already maintains (`SessionHandle::audio_ms()`), captured when the
frame arrives. Do not substitute wall-clock time — the engine's lag model is
calibrated against the audio clock (`AlignmentConfig::partial_lag_ms` /
`endpoint_lag_ms`, measured on live captures).

**Config.** `AlignmentConfig::default()` is the benchmarked configuration.
Don't hand-tune fields in the app; change defaults in `cc-align` and re-run
`cc-bench tier-a` + `tier-b` so the numbers move with the change.

## 3. Stage behaviour per state

`snapshot.state` tells the stage what kind of moment this is. The research
brief (docs/improvements) is explicit: calm, no drama, no red.

| `state` | What's happening | Stage behaviour |
|---|---|---|
| `Following` | Healthy local tracking | Animate toward `display_at(now)` each frame; normal smoothing |
| `Holding` | Off-script speech / weak evidence | Stop advancing; hold position; optional quiet "holding" affordance |
| `Ambiguous` | Two distant places both fit (duplicate passage) | Hold; do NOT pick a side visually |
| `Searching` | No lock yet (session start, manual reset) | Hold at current scroll; subtle "listening…" is fine |

Frame loop (60 Hz, stage-side):

```ts
const target = snapshotDisplayAt(lastSnapshot, audioClockNowMs());
// velocity/acceleration-limited approach to `target`; the engine already
// bounds prediction, so no extra dead-reckoning on the stage side.
```

`display_at` reference implementation (mirror of `Snapshot::display_at`):

```ts
function snapshotDisplayAt(s: Snapshot, tMs: number): number {
  const ceiling = Math.min(s.displayLimitToken, s.scriptLen);
  if (s.rate <= 0) return Math.min(s.observed, ceiling);
  const age = Math.max(0, tMs - s.evidenceAudioMs);
  const onset = Math.min(s.pauseOnsetMs, s.maxPredictionMs);
  // Fresh evidence: the lead grows 1:1. That is pipeline-lag compensation,
  // not a guess about the future — the words are already said, the recogniser
  // has simply not finished saying so. Stale evidence: the reader has
  // probably stopped, and the lead decays to rest on the last word heard.
  const leadMs =
    age <= onset ? age : Math.max(onset - (age - onset), Math.min(s.leadFloorMs, onset));
  const lead = Math.min((s.rate * leadMs) / 1000, s.maxLeadTokens);
  return Math.min(s.observed + lead, ceiling);
}
```

The canonical TS mirror lives in `src/shared/contracts/alignment.ts`
(`alignmentDisplayAt`) — never fork it.

**The contract this function exists to keep: the returned position must never
get ahead of what the reader has actually said.** Four separate mechanisms
enforce it, and none of them is something the stage should re-derive, relax,
or compensate for:

* `rate` is already scaled *below* the reader's estimated pace
  (`prediction_gain`, currently 0.35), so the steady state trails them. It is
  not a measured reading speed and must not be "corrected" back up.
* `rate` is already zero whenever extrapolation would be a guess
  (holding / ambiguous / searching), and the moment the provider endpoints an
  utterance — its VAD heard silence, so the display parks exactly where the
  reader stopped. `speechStarted` re-bases the clock so gliding resumes the
  instant they speak again.
* `maxLeadTokens` caps the lead in *words*, not milliseconds, because a
  reader who slows down invalidates the rate estimate without invalidating
  the clock.
* `displayLimitToken` is a hard ceiling at the end of the paragraph the
  reader was last heard in. The engine will not predict across a paragraph
  break on any amount of confidence: a break is where readers stop, so it is
  simultaneously the likeliest place for a forward guess to be wrong and the
  most visible place to be wrong in. Expect the display to sit still at a
  paragraph end until the next paragraph is genuinely heard — that pause is
  the feature.

Benchmarked as `ahead_*` in `bench/REPORT.md`: live time-spent-ahead-of-the-
reader is 3.8%, down from 22.2%, against a measurement floor of ~0.5%.

> **`profile.prediction.leadSeconds` now works against all of this.** The
> stage adds its own comfort lead by asking `alignmentDisplayAt` for a moment
> in the future (`engine.ts`, `voiceLeadMs()`), default 0.38 s. That was the
> right call for an underline — you want to read *into* placed text. For a
> fade it is the opposite: it spends the safety margin on erasing words
> earlier. Replaying the live captures with the lead applied measures the
> cost directly — 3.8% → **6.5%** time-ahead at the 0.38 s default, and
> **9.6%** at the 0.6 s maximum, roughly doubling and tripling the defect.
> It cannot run away (it inherits `maxLeadTokens` and the paragraph ceiling),
> but for the fade display it should be 0 by default. If a comfort lead is
> still wanted for scrolling, apply it to the SCROLL anchor — how high on
> screen the line sits — and not to the token position that drives the fade.

### The word underline / highlight

**The stage does not mark a current word, by decision — don't add one back.**

Underlining `floor(display_at(now))` was tried and removed: a mark on one
token asserts a precision the engine does not have, and its ordinary
sub-word wobble reads as twitching under the reader's eye. The stage instead
dims everything *before* the position — a boundary, not a word, so a
one-token error shades an extra word slightly grey rather than pointing
confidently at the wrong one. Liveness comes from the scroll.

What this asks of the engine is unchanged and if anything stricter: the
position driving that boundary must never run ahead of what was actually
heard. Any future word-level cue would have to carry `confidence` in its
treatment rather than assert a single token.

### Jumps and suggestions

* Accepted skips/retakes arrive as an ordinary snapshot whose position moved
  far (`decision` = `JumpForwardAccepted` / `RetakeAccepted` /
  `RelocationAccepted`). Animate these as a **deliberate relocation** (fast
  scripted scroll), not an instant teleport and not the normal smoothing.
* `snapshot.suggestion: Option<f64>` is a distant candidate that is
  accumulating evidence but has NOT been accepted ("possible match below").
  The UI may surface it as an unobtrusive affordance ("resume here?"). Never
  auto-scroll to a suggestion.
* A small backward `observed` correction after a partial retraction is
  normal; the motion layer should absorb ≤2-atom corrections gently.

## 4. Mapping atoms ↔ screen

The engine positions are indices into `CompiledScript::atoms`. Each
`ScriptAtom` carries `line` (0-based source line in the Markdown) and `para`
(0-based spoken-paragraph ordinal). To map a fractional position to the DOM:

1. When compiling, export `(atom index → line, para)` to the stage (a flat
   array; ~1–5k entries).
2. The stage keeps its existing element-per-line/word rendering; the scroll
   target for position `p` is the element containing atom `floor(p)`,
   interpolated toward the next atom by `frac(p)`.
3. Non-spoken blocks (headings, cues, images, code) occupy screen space but
   no atom space — that's why mapping goes through the compiled atoms, not
   through word counts in the raw Markdown.

Note the compiler's spoken-content rules match the app's contract: code
fences, `:::` containers, tables, dividers, whole-line `[Cue: …]`/`[Beat]`
directives and HTML comments are not spoken; headings only if
`read_headings`.

## 5. Inputs the frontend must provide

### Viewport hints (the "this is what I can see" prior)

Whenever the visible range changes (user scroll, resize, font change):

```rust
engine.set_viewport_hint(first_visible_atom, last_visible_atom);
```

This is a *prior*, not a command — it biases candidate ranking, speeds up
starting-in-the-middle locks (3.6 s in the benchmarks), and makes far jumps
to off-screen targets require an extra round of evidence. Debounce to ~4/s;
call `clear_viewport_hint()` if the concept doesn't apply (e.g. full-script
minimap view).

### Manual navigation

When the user explicitly says "I'm here" (tap a paragraph, jump-to-section):

```rust
let snapshot = engine.set_manual_position(atom, audio_ms_now);
```

This resets evidence continuity — speech from before the manual move can
never drag the cursor back.

## 6. Reading `decision` (diagnostics, not UI copy)

`DecisionCode` explains each snapshot: `LocalObserved`, `LocalConfirmed`,
`HoldOffScript`, `HoldAmbiguous`, `JumpPending`, `RetakeAccepted`, … Use it
for logging/diagnostics panels; don't map codes directly to user-facing
text (the state table in §3 is the user-facing contract).

`confidence` (0..1) is a documented heuristic, not a calibrated
probability. It's fine for a debug meter; don't gate product behaviour on
exact thresholds.

## 7. Take summary

At take end, derive the honest summary from snapshots you've already
received (spec §14.7): unique coverage from `confirmed` progression,
recovery events from `decision` codes, availability from time spent in
`Following`. Do not report "followed N of M words" from a single final
position.

## 8. Testing your integration

* `crates/cc-bench` replays captured live sessions offline:
  `cargo run --release -p cc-bench -- tier-b --label check` must stay green
  after any engine-adjacent change.
* `cc-bench inspect <script> <scenario>` prints the per-event decision trace
  when a take "felt wrong" — reproduce with a captured log before touching
  engine code.
* The fixtures in `bench/runs/` are frozen; add new captures rather than
  regenerating.

## 9. What NOT to do

* Don't feed the engine wall-clock times, provider `Transport` frames, or
  renderer-side VAD guesses.
* Don't scroll to `observed` directly — that reintroduces the
  freeze-then-lurch the display model exists to fix.
* Don't auto-accept `suggestion`.
* Don't create a second stopword list, tokenizer, or "is this word close
  enough" check anywhere in the frontend. All lexical judgement lives in
  the engine — that split is what the historical `0 of 26` failure taught.
