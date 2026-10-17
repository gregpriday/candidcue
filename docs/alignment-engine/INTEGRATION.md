# Integrating the Rust alignment engine (`cc-align`)

**Audience:** anyone working on how the stage and control windows consume
speech-to-script alignment.
**Engine location:** `crates/cc-align` (pure Rust, no Tauri/network/clock
dependencies), hosted by `src-tauri/src/align/mod.rs`, which sits next to the
on-device speech session in `src-tauri/src/speech/`.
**Benchmarked behaviour:** `bench/REPORT.md` — zero false jumps across the
suite, 99.99% within ±5 words on clean reads, and the display ahead of the
reader 3.8% of the time on live captures (down from 22.2%). The live captures
are the frozen corpora under `bench/runs/`, recorded through the hosted
recogniser the app used before speech moved on-device. Read the report to know
what the engine promises. Note the deliberate asymmetry before tuning anything
on top of it: **the display is built to trail the reader, never to lead**, so
the symmetric ±2-word figure is intentionally not the objective.

---

## 1. The mental model

The engine consumes the transcript frames the on-device recogniser produces
and emits one snapshot per transcript event. There is no timer: snapshot
cadence is the recogniser's partial cadence. A snapshot is not a scroll
command — it is the engine's best statement of *where the reader is*, plus how
confident it is and what mode it's in. The stage owns all animation.

```
on-device recogniser (cc-stt, dedicated OS thread)
   │ transcript frames + audio clock + word times
   ▼
src-tauri/src/align/mod.rs: Engine::handle(SessionEvent) ──► project_to_tokens
   │
   ├──► stage://alignment-snapshot ──► stage: 60 Hz motion from
   │                                   alignmentDisplayAt(snapshot, now)
   └──► align://snapshot ────────────► control: progress, take summary
```

Three positions, one per concern:

| Field | Meaning | Use it for |
|---|---|---|
| `confirmedToken` | Conservative anchor; monotonic except accepted retakes / manual moves | progress %, "words covered", recovery UI |
| `observedToken` | Best evidence-supported position right now (may retract a little on partial revisions) | debugging, coverage |
| `alignmentDisplayAt(snapshot, t)` | Where the display should place the reader at audio-clock time `t` — observed plus a bounded, lag-compensated lead, less a safety margin | **the scroll target** |

Positions are fractional indices into the compiled script's `spokenTokens`.
The engine itself works in spoken atoms; the host converts once, in Rust,
before anything leaves it (see §4).

## 2. Session wiring (Rust side)

This is built. What follows describes `src-tauri/src/align/mod.rs` as it is.

**Take start.** Control calls `start_alignment` with the script's spoken tokens
(`alignTokensFor` in `src/control/services/alignment.ts`). `AlignmentState`
compiles them with `cc_align::compile_tokens_in`, which builds atoms *from the
app's own tokens* so every position can be projected back, and arms
`Engine::new(script, AlignmentConfig::default())`. The session starts unbound:
`SpeechEngine::start_stream` binds it to the recogniser stream generation it
mints, and frames from any other stream are ignored.

**Frames.** The recogniser thread in `src-tauri/src/speech/session.rs` hands
every transcript frame to `align::observe_frame` before emitting it to control
on `stt://event`. The host turns it into an engine event:

```rust
let event = match frame {
    SttFrame::ItemStarted { item_id, audio_start_ms, .. } =>
        SessionEvent::ItemStarted { item_id, audio_start_ms },
    SttFrame::Partial { item_id, text, .. } =>
        SessionEvent::Partial { item_id, text, audio_ms: audio_now_ms, word_times },
    SttFrame::Final { item_id, text, audio_end_ms, acoustic_end_ms, .. } =>
        SessionEvent::Final { item_id, text, audio_end_ms, acoustic_end_ms, word_times },
    // Transport, Failed and AudioDropped frames say nothing about where the
    // reader is.
    _ => return None,
};
let snapshot = engine.handle(event);
publish(project_to_tokens(&snapshot, &engine.script, label));
```

`word_times`, the recogniser's per-word start times, rides beside the frame
rather than inside it: the renderer's `SttFrame` is the `stt://event` contract
and has no use for them.

**Delivery.** `publish` emits the projected snapshot to two windows by name:
`stage://alignment-snapshot` to the stage for motion, and `align://snapshot` to
control for progress and the take summary. These are targeted events, not a
broadcast. Control is out of the motion path; it receives its own copy only so
its report can never disagree with what the stage showed.

**The audio clock.** Time is milliseconds of audio handed to the recogniser,
counted from samples at the pinned `SAMPLE_RATE_HZ`
(`cc_stt::LocalSession::audio_ms`, mirrored into `SessionHandle::audio_ms()`).
Each frame comes off the decoder stamped on that clock — `audio_ms` for a
partial, `audio_start_ms` / `audio_end_ms` for the others — and that stamp is
what the host passes as `audio_now_ms`. Do not substitute wall-clock time — the
engine's lag model is calibrated against the audio clock
(`AlignmentConfig::partial_lag_ms` / `endpoint_lag_ms`).

**Config.** `AlignmentConfig::default()` is the benchmarked configuration.
Don't hand-tune fields in the app; change defaults in `cc-align` and re-run
`cc-bench tier-a` + `tier-b` so the numbers move with the change.

## 3. Stage behaviour per state

`snapshot.state` tells the stage what kind of moment this is. Keep it calm: no
drama, no red.

| `state` | What's happening | Stage behaviour |
|---|---|---|
| `following` | Healthy local tracking | Animate toward `alignmentDisplayAt(snapshot, now)` each frame; normal smoothing |
| `holding` | Off-script speech / weak evidence | Stop advancing; hold position; optional quiet "holding" affordance |
| `ambiguous` | Two distant places both fit (duplicate passage) | Hold; do NOT pick a side visually |
| `searching` | No lock yet (session start, manual reset) | Hold at current scroll; subtle "listening…" is fine |

Frame loop (60 Hz, stage-side):

```ts
const target = alignmentDisplayAt(snapshot, audioNowMs);
// velocity/acceleration-limited approach to `target`; the engine already
// bounds prediction, so no extra dead-reckoning on the stage side.
```

`alignmentDisplayAt` in `src/shared/contracts/alignment.ts` is the canonical
TypeScript mirror of `Snapshot::display_at`, and a Rust test asserts the two
agree. Never fork it, and don't transcribe it into a document either: a copy
that used to live here fell behind it. In outline, while evidence is fresh the
lead grows 1:1 with evidence age (pipeline-lag compensation, not a guess about
the future: the words are already said, the recogniser has simply not finished
saying so), eases into a plateau at `pauseOnsetMs`, holds for `leadHoldMs`, and
then settles over `leadDecayMs` onto the last word heard.

**The contract this function exists to keep: the returned position must never
get ahead of what the reader has actually said.** Four separate mechanisms
enforce it, and none of them is something the stage should re-derive, relax,
or compensate for:

* `leadMarginTokens` holds the display a fixed distance behind its own
  estimate while the reader is flowing, and fades out through the same settle
  as the lead, so a display at rest rests on the last word heard. Caution is
  bought as a distance, not a speed: `rateTokensPerSecond` is not scaled down
  (`prediction_gain` is 1.0), because a reduced rate makes the display crawl
  between transcript events and then step forward at each one. Don't remove
  the margin, and don't "correct" for it.
* `rateTokensPerSecond` is zero whenever extrapolation would be a guess
  (holding / ambiguous / searching), and it decays to zero as evidence goes
  stale (`rate_hold_ms`, `rate_decay_ms`), so the display parks where the
  reader stopped. A final does not stop it by itself: it arrives
  `endpoint_lag_ms` after the last word, and stopping on arrival put a halt in
  the motion at every sentence. `ItemStarted` re-bases the evidence clock so
  gliding resumes the instant the reader speaks again.
* `maxLeadTokens` caps the lead in *words*, not milliseconds, because a
  reader who slows down invalidates the rate estimate without invalidating
  the clock.
* `displayLimitToken` is a hard ceiling at the end of the sentence the reader
  was last heard in, and never past the end of its paragraph. The engine will
  not predict across either break on any amount of confidence: a break is
  where readers stop, so it is simultaneously the likeliest place for a
  forward guess to be wrong and the most visible place to be wrong in. Expect
  the display to sit still at a full stop until the next sentence is genuinely
  heard — that pause is the feature.

Benchmarked as `ahead_*` in `bench/REPORT.md`: live time-spent-ahead-of-the-
reader is 3.8%, down from 22.2%, against a measurement floor of ~0.5%.

> **The stage adds no lead of its own — done, and removed rather than
> zeroed.** It used to ask `alignmentDisplayAt` for a moment in the future
> (`engine.ts`, `voiceLeadMs()`, default 0.38 s from `profile.prediction.
> leadSeconds`). That was the right call for an underline — you want to read
> *into* placed text — and the opposite for a fade, where it spends the safety
> margin on erasing words earlier. Replaying the live captures measured the
> cost: 3.8% → **6.5%** time-ahead at the 0.38 s default, **9.6%** at the 0.6 s
> maximum. A default of 0 would have left a user-facing "More lead" control
> whose whole function was to reintroduce the defect, so the field, the
> setting and the control are gone (`SMOOTH_FOLLOW_PROFILE_VERSION` 3).
> Comfort for scrolling belongs to the reading band —
> `readingBandCenterPercent`, how high on screen the line sits — not to the
> token position that drives the fade.

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
  far (`decision` = `jumpForwardAccepted` / `retakeAccepted` /
  `relocationAccepted` / `manualAnchor`, the set `ALIGNMENT_RELOCATIONS` in
  `src/shared/contracts/alignment.ts`). Animate these as a **deliberate
  relocation** (fast scripted scroll), not an instant teleport and not the
  normal smoothing.
* `snapshot.suggestionToken: number | null` is a distant candidate that is
  accumulating evidence but has NOT been accepted ("possible match below").
  A discontinuity the viewport leash refused (`holdOffScreen`) travels here
  too. The UI may surface it as an unobtrusive affordance ("resume here?").
  Never auto-scroll to a suggestion.
* A small backward `observedToken` correction after a partial retraction is
  normal; the motion layer should absorb a correction of a word or two gently.

## 4. Mapping atoms ↔ screen

The mapping is done, and it is done in Rust. Control compiles the Markdown
into `spokenTokens` and sends each token's authored surface, source line,
paragraph and sentence end to `start_alignment` (`alignTokensFor`). The host
builds atoms from those tokens with `compile_tokens_in`, which records where
each atom came from, and projects every snapshot back with `project_to_tokens`
before publishing it. Every position the frontend sees is a fractional index
into `spokenTokens`, and the stage resolves it against its own measured token
and line geometry.

Keep it that way: no atom arrays shipped to the stage, no atom-to-DOM mapping,
and no tokenizing or normalizing in TypeScript. The `observedAtom` /
`confirmedAtom` snapshot fields exist for diagnostics and benchmark parity
only.

Content the app's Markdown compiler (`src/shared/markdown/`) does not mark as
spoken occupies screen space but never becomes a spoken token, so it never
reaches the engine.

## 5. Inputs the frontend must provide

### Viewport hints (the "this is what I can see" prior)

Whenever the visible range changes (user scroll, resize, font change), the
stage emits `stage://viewport-hint` with `sessionGeneration`, `firstToken`,
`lastToken` and `cleared`. `app.rs` relays it to `align::apply_viewport_hint`,
which ignores a hint for a different take, converts the inclusive token range
to atoms, and calls `engine.set_viewport_hint` — or `clear_viewport_hint` when
`cleared` is set because the concept doesn't apply (e.g. full-script minimap
view).

This is a *prior*, not a command — it biases candidate ranking, speeds up
starting-in-the-middle locks (3.6 s in the benchmarks), and, with
`viewport_confines_jumps` on (the default), leashes discontinuities: a far
jump, retake or cold lock to an off-screen target is refused and reported as
`suggestionToken` instead. Debounce to ~4/s, and repeat an unchanged range
every couple of seconds — a hint that arrives before the session is installed
is dropped, and an engine with no viewport has no leash.

### Manual navigation

When the user explicitly says "I'm here" (tap a paragraph, jump-to-section),
control calls `setAlignmentPosition(token)`, which invokes
`set_alignment_position`. The host converts the token to an atom, calls
`engine.set_manual_position` at its own last audio-clock reading, and publishes
the result to both windows. The frontend never supplies a time.

This resets evidence continuity — speech from before the manual move can
never drag the cursor back.

"Re-find me here" is a different call: `reacquireAlignment()`
(`reacquire_alignment`) reopens the search over the viewport the stage last
reported, without asserting a position.

## 6. Reading `decision` (diagnostics, not UI copy)

`decision` (`DecisionCode` in Rust, camelCase on the wire) explains each
snapshot: `localObserved`, `localConfirmed`, `holdOffScript`, `holdAmbiguous`,
`holdOffScreen`, `jumpPending`, `retakeAccepted`, … (`ALIGNMENT_DECISIONS`).
Use it for logging/diagnostics panels; don't map codes directly to
user-facing text (the state table in §3 is the user-facing contract).

`confidence` (0..1) is a documented heuristic, not a calibrated
probability. It's fine for a debug meter; don't gate product behaviour on
exact thresholds.

## 7. Take summary

At take end, derive the honest summary from snapshots you've already
received: unique coverage from the high-water mark of `confirmedToken`, and
availability from time spent in `following`. Do not report "followed N of M
words" from a single final position. Control does this in
`src/control/stores/session.ts`, from its own copy of the snapshots.

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

* Don't feed the engine wall-clock times, `Transport` / `Failed` /
  `AudioDropped` frames, or renderer-side VAD guesses.
* Don't scroll to `observedToken` directly — that reintroduces the
  freeze-then-lurch the display model exists to fix.
* Don't auto-accept `suggestionToken`.
* Don't create a second stopword list, tokenizer, or "is this word close
  enough" check anywhere in the frontend. All lexical judgement lives in
  the engine — that split is what the historical `0 of 26` failure taught.
