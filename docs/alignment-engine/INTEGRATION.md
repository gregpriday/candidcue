# Integrating the Rust alignment engine (`cc-align`)

**Audience:** the frontend/stage agent wiring the new speech-to-script
alignment engine into the app.
**Engine location:** `crates/cc-align` (pure Rust, no Tauri/network/clock
dependencies — it slots into the existing Rust backend next to the Inworld
socket).
**Benchmarked behaviour:** `bench/REPORT.md` (99.5% within ±2 words on clean
reads, zero false jumps across the suite; read it to know what the engine
promises).

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
  if (s.rate <= 0) return s.observed;
  const horizon = clamp(tMs - s.evidenceAudioMs, 0, s.maxPredictionMs);
  return s.observed + (s.rate * horizon) / 1000;
}
```

`rate` is already zeroed by the engine whenever extrapolation would be a
guess (holding/ambiguous/searching) — don't re-derive that condition.

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
