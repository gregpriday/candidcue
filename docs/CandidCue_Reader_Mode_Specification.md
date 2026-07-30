# Reader mode: presenting without taking the display

Status: design. Nothing here is implemented.

This document is written against the code as of 2026-07-30, not against the
older specs in this directory. Where it disagrees with them, the code was
consulted and the code wins.

---

## 1. The use case, stated plainly

CandidCue today has exactly one presentation gesture: **become the whole
panel.** Press Present and the control window goes borderless, fills the
monitor it is on, and rises above the menu bar (`src-tauri/src/windows/present.rs`).
That is correct for the rig it was built for — a presenter standing at a camera,
reading off glass.

There is a second thing this app is quietly very good at, which nobody can
currently reach: **reading a script off a screen.** Sitting down, script in a
window, following your own voice, the read text dimming behind you and the
upcoming text sliding up to meet you. No camera, no glass, no rig. It is a
genuinely nice reading experience and the machinery for it already exists — it
is just locked inside a mode that steals your display.

So: make taking the display optional.

## 2. The one decision

**Reader mode is a presentation mode, not "full screen off".**

This is the whole design, and getting it wrong is the obvious trap. A window is
not a smaller monitor. Six things differ, and every one of them is a fact the
optical model or the window layer currently assumes:

| | Prompter (today) | Reader (new) |
|---|---|---|
| Surface | the whole monitor | a window you sized |
| Viewing distance | 0.6–3 m, from the rig | ~600 mm, desk |
| Optical path | often a beamsplitter → mirrored | direct → **never** mirrored |
| Safe area | cropped by a hood | there is no hood |
| Reading band | derived from the lens position | the reader's own preference |
| Above everything | yes, and clears the menu bar | no; it is an ordinary window |
| Chrome | stripped | kept — that is how you move it |
| Resize | happens once, at open | continuous, first-class |

Note the shape of that list: it is not "the same thing, smaller". It is a
different rig. Treating it as one is what makes the rest of this design small
rather than sprawling.

## 3. Dead code to clear first

`settings.stage.fullscreen` exists and is a lie.

It is read in exactly three places — `Settings.svelte:299`, `:480`, and its own
toggle at `:1554` — all of which drive the *stage preview* and the *display
test*. `lib/start-take.ts` never reads it. A real take calls
`enterPresentation()` → `set_control_presenting(true)` → `apply_presentation`,
unconditionally, whatever the toggle says.

So there is a "Full screen" switch in Settings that has no effect on any take
anybody has ever run. It should not be repurposed as-is; it should be replaced:

```ts
stage: {
  displayFingerprint: string | null;
  presentationMode: 'prompter' | 'reader';   // was: fullscreen: boolean
}
```

Migration: `fullscreen: true → 'prompter'`, `false → 'reader'`. That is
technically a behaviour change for anyone who had turned the toggle off, but
since it never did anything, the honest reading is that it finally does what it
said.

## 4. The optical model in a window

This is the part worth being precise about, because the answer is much better
than it first looks and a rewrite is not needed.

### 4.1 What already works

Three of the four things that matter are already viewport-independent:

- **Type size.** `fontSizePxForArcminutes` needs `mmPerCssPx` and
  `distanceMm`. `mmPerCssPx` is a property of the *display* — a CSS pixel is the
  same physical size whether the window is 400 px or 4000 px wide — so it is
  unchanged by windowing. Type in a reader window is physically correct type.
- **The dead zone.** `computeReadingBand` derives `halfPx` from
  `deadZoneLines × linePitchPx` whenever the pitch is positive
  (`geometry.ts:221`), which it is on any calibrated rig. The
  `readingBandHalfHeightPercent` twin — which *is* a percentage of viewport
  height, and would shrink with the window — is only the fallback. So the
  follower's corridor holds its absolute size in a small window. Good.
- **The column.** `ScriptLayer` renders
  `min(safeRect.width, columnCh × 0.55 × bodyFontSizePx)`
  (`ScriptLayer.svelte:790`) — an absolute pixel width, clamped to what is
  actually there.

### 4.2 What is wrong, and why

**(a) The resolver is handed the panel, not the window.**

`stageSettingsFromSettings` passes `display.logicalSize` as the viewport
(`stage-envelope.ts:310`). In prompter mode that is right, because the window
*is* the display. In reader mode it means the reading measure was chosen against
a width the reader does not have. The `min(safeRect.width, …)` clamp then
silently truncates the column, bypassing `hardwareFitCheck` entirely — so the
measure can drop under `READING_MEASURE.hardFloor` with no narrowing pass and no
warning. The fit check is described in `optics.ts` as "the primary mechanism of
the width system", and in a window it never runs.

**(b) The reading measure is a teleprompter measure.**

`READING_MEASURE.idealMin/idealMax` is 32–38 characters, and `optics.ts` is
explicit about why: on-camera delivery, where "a sideways eye movement that is
invisible in a waist-up shot is obvious in a tight headshot". `FRAMING_MEASURE_SCALE`
then multiplies it by 0.75–1.25 by shot size.

In reader mode there is no shot. Continuous reading wants the established
45–75-character measure, and applying a 32-character target to a wide reading
window produces a narrow ribbon of text down the middle of a lot of black.

Worth working the arithmetic, because it settles what does and does not need to
change. Take a 16" MacBook Pro at default scaling: 1728 × 1117 CSS px over a
411 mm diagonal → **0.200 mm per CSS pixel**. At the desk preset's 600 mm and
the standard 24′ target:

- cap height = 2 × 600 × tan(24′/2) = **4.19 mm**
- em = 4.19 / 0.7 = 5.98 mm → **≈ 30 CSS px** body size

30 px at arm's length is large, comfortable type — bigger than ordinary UI body
text, which is what you want for something you are reading aloud. **The angular
ladder needs no reader variant.** (For contrast: ordinary 18 px body text at
600 mm is about 14′ of cap height, *below* this app's 16′ hard floor. The floors
are prompter floors, and a reader who drags the bias all the way down still
lands at 20′ ≈ 25 px. Fine. Leave it.)

But at 30 px, 35 characters is a **523 px** column. In a 1400 px window that is
440 px of black on each side. At 65 characters it is 970 px — a normal window.
So the measure is the one table that needs a reader variant, and the angular
ladder is not.

**(c) The safe area is a hood crop.**

`profile.safeArea` describes glass hidden behind a bezel. Applied as a fraction
of a window, it crops a window for a hood that is not there.

**(d) Mirroring.**

`buildStageSettings` takes `mirrorX`/`mirrorY` from `settings.teleprompter`
(`stage-envelope.ts:242`), which the rig presets write from `flips`. A
beamsplitter user reading in a window would get backwards text on a bare
monitor — which the `desk-webcam` preset's own comment calls "the classic
first-run confusion".

### 4.3 The fix: reader is its own profile, resolved against the window

Two changes, and they are both small.

**A second profile per display.** Optical profiles are already keyed by display
fingerprint (`activeOpticalProfile`, `opticalRigKey`). Reader mode reads a
sibling key — `readerRigKey(fingerprint)` — seeded from a new `desk-reading`
rig preset:

```ts
{
  id: 'desk-reading',
  label: 'Reading at a desk',
  description: 'A window on your own screen, read directly. No camera and no glass.',
  patch: {
    hardwareKind: 'generic',
    viewingDistanceMm: 600,
    flips: { horizontal: false, vertical: false },
    lensPlacement: 'none',      // new variant — see below
  },
}
```

`lensPlacement` gains a `'none'` arm. There is no camera, so there is nothing
for `lens.y` to describe and nothing for `lensOffsetDegrees` to be measured
from. The resolver's `derivedBandY` switch (`optical-resolve.ts:372`) grows one
case, returning a plain reader preference — default **0.42**, a little above
centre, which is where a reader's eye rests and which leaves more upcoming text
in view than dead centre. `computeReadingBand`'s `isOffPanel` test
(`geometry.ts:202`) does *not* grow to include it: `'none'` is not an edge-pinned
band, it is a freely chosen one, so it takes `SAFE_RECT_CENTER_RANGE`.

The profile's `safeArea` is zeroes and its `flips` are false, so (c) and (d)
need no special-casing — they fall out of the profile being a different profile.
`stageSettingsFromSettings` does need one guard: in reader mode, force
`mirrorX`/`mirrorY` off rather than reading the Settings toggles, because those
toggles are the rig's.

**A reader measure table.** `optics.ts` gains a second constant table and the
functions that read it gain a context argument:

```ts
export type ReadingContext = 'prompter' | 'reader';

export const READER_READING_MEASURE = {
  idealMin: 55,
  idealMax: 75,
  bandMin: 45,
  bandMax: 90,
  hardFloor: 30,
} as const;
```

`charactersForBias`, `hardwareFitCheck` and `resolveTargetCharacters` take the
context and select the table. `resolveTargetCharacters` additionally skips
`FRAMING_MEASURE_SCALE` in reader mode — framing is a fact about a shot, and
there is no shot.

Everything else in `optics.ts` and `optical-resolve.ts` is untouched. The
angular ladder, the floors, the legibility-outranks-measure resolution order,
the override plumbing, the warnings — all of it applies unchanged.

### 4.4 Who resolves, and when

(a) above means the resolver needs the *window's* live size. Control does not
have it; the stage does, as `vw`/`vh`, already reactive through
`<svelte:window bind:innerWidth bind:innerHeight>` and already a line-map layout
input (`ScriptLayer.svelte:1381`).

So: **move the resolve into the stage.** The envelope already carries
`opticalProfile` — `stage-envelope.ts:239` says so explicitly ("`flips` rides
along inside `opticalProfile` for the calibration screen to read") — so the
input is present. `ScriptLayer` re-resolves whenever `vw`, `vh`, the profile or
the measured font metrics change, and `settings.optics` from the envelope
becomes the *initial estimate* that the stage improves on once it has painted.

This is worth doing for prompter mode too, and the code already wishes for it:

> Font metrics are deliberately not supplied. Control cannot measure a font it
> does not render; the DIN fallbacks resolve a defensible size and mark
> themselves `metricsMeasured: false`, which the stage improves on once it has
> painted its own text. — `stage-envelope.ts:274`

Today the stage *partially* improves on it — it re-derives `columnWidthPx` from
`optics.columnCh` and its own `vw` — which is two half-resolutions rather than
one. In prompter mode the stage's `vw`/`vh` **is** the panel, so a unified
resolve produces the same geometry plus real measured metrics instead of DIN
fallbacks.

Phase it anyway (§10): reader mode resolves in the stage; prompter keeps
control's resolve until the unified path is proven against the benchmark. Two
implementations of one thing is precisely the drift problem `bench/README.md`
warns about with Tier C, so this fork is a temporary one with an owner, not an
architecture.

## 5. The window layer

`present.rs` is a two-state machine over one latch. It becomes three-state.

### 5.1 `plan` grows an arm

```rust
pub enum PresentMode { Prompter, Reader }

pub enum PresentAction {
    Enter(PresentMode),   // not presenting → presenting: save the frame, apply
    Reassert(PresentMode),// same mode again: re-apply, do NOT re-save
    Switch(PresentMode),  // presenting → the other mode
    Restore,              // presenting → not: restore the frame, drop it
    Nothing,              // not presenting → not
}
```

`Switch` is the mid-take toggle, and it is the one genuinely new pairing.

### 5.2 The latch rule, refined

`present.rs` already documents the rule that matters, in a test named
`presenting_twice_does_not_resave_the_frame`:

> If a second present overwrote it, the frame saved would be the presenting one
> — monitor-sized and undecorated — and un-presenting would "restore" the window
> to full-screen-sized with no titlebar to grab.

`Switch` forces that rule to be stated more exactly, because reader mode is a
*resting* presenting state — chrome on, ordinary bounds — and its frame is a
perfectly good frame to save.

**The invariant: re-capture the frame on any transition out of a windowed
resting state; never on a transition out of a full-monitor state.**

Concretely:

- `Enter(Reader)` — save the frame. Apply: black background, sleep assertion,
  lowered minimum size. **Geometry untouched.** The window is already where the
  reader put it and the size they want; moving it would be taking the window
  away from the person driving it, which is the same argument `present.rs`
  already makes about not honouring a pinned display fingerprint.
- `Enter(Prompter)` — save the frame, then today's `apply_presentation`.
- `Switch(Reader → Prompter)` — **re-capture the frame** (the reader may have
  moved or resized it since), then `apply_presentation`.
- `Switch(Prompter → Reader)` — unpin, restore chrome from the latched
  `decorations`, restore the latched position and size. **Do not clear the
  latch.**
- `Restore` — as today, then clear.
- `Nothing` — as today, including the defensive chrome drain.

`Switch(Prompter → Reader)` and `Restore` share nearly all of their body; factor
the shared part as `apply_windowed(frame)` and let the two callers differ in the
latch clear and the background reset.

`plan` is pure and already has a test module, so every one of these pairings is
testable without a display server — which matters, because none of them can be
exercised through the real API on CI.

### 5.3 What reader mode does and does not do

| | Prompter | Reader |
|---|---|---|
| `chrome::strip` | yes | **no** — the titlebar is how you move and close it |
| `pin::above_everything` | yes (level 26, over the menu bar) | **no** |
| move / resize to monitor bounds | yes | **no** |
| `set_background_color(black)` | yes | **yes** — a resize that outruns the paint must not flash white |
| `sleep::acquire` | yes | **yes** — a reader who is reading is not typing, and macOS blanks at 10–20 min |
| `set_min_inner_size` | untouched | **lowered** (see below) |

Holding the sleep assertion in reader mode is a deliberate call. The argument in
`sleep.rs` — "the operator deliberately stops touching the keyboard and mouse
for twenty-plus minutes" — is *more* true of reading than of presenting, not
less. It is released on `Restore` and on quit through the existing paths, and
`plan` makes double-release a no-op, so nothing new can leak.

### 5.4 Minimum size

`tauri.conf.json` sets the control window's minimum to 980 × 680 — sized for the
editor, not for a reading window. A reader might reasonably want a tall narrow
window beside a video call.

The floor reader mode actually needs, at 30 px type and the 30-character reader
hard floor: 30 × 0.5 × 30 = 450 px column ÷ 0.92 → **≈ 490 px** of width; and
`TARGET_VISIBLE_LINES` (5) × a 41 px pitch, plus fades and padding → **≈ 360 px**
of height. Call it **520 × 360**.

So `Enter(Reader)` lowers the minimum and `Restore` puts it back — which means
the minimum joins `decorations` in `ControlFrame` as a thing the latch must
carry. Same reasoning as the note there about inner-vs-outer size: snapshot what
was actually set, restore what was snapshotted, never a guessed constant.

## 6. Control: choosing and switching

### 6.1 At Present

`startTake`'s opening sequence exists for two reasons stated at
`start-take.ts:251`: the white bar during the macOS fullscreen animation, and
measuring the line map twice. Reader mode changes neither conclusion, but it does
make the sequence cheaper:

```
setPresentingPhase('opening')
await painted()
const presentation = await enterPresentation(mode)
await awaitViewportSettled(presentation)
startLiveSession(...)
```

In reader mode `enterPresentation` moves no geometry, so
`awaitViewportSettled` matches on its first check — which is exactly the
`browserViewport` case that function already documents ("you are already the size
you are going to be"). The cover still goes up: the background colour change and
the chrome are still visible transitions, and a cover that is up for two frames
costs nothing.

The one thing that genuinely changes: **the line map is measured at the window's
size, and the window's size is not the panel's.** `start-take.ts`'s "measure
once, at the size it will be read at" guarantee holds, because reader mode does
not resize on the way in. It is the *later* resizes that are new (§7).

### 6.2 Mid-take toggle

This is the gesture that makes the feature real: *"I'm reading in a window —
now let me pop it out to the whole screen."* And back.

- Keyboard: `Cmd+Ctrl+F` on macOS, the platform convention, added to
  `ShortcutAction` as `'toggle-presentation-mode'`. It goes in the `primary`
  block, so it is not one of the plain keys that stand down for a focused
  control.
- The dock (`StageDock.svelte`) gains a third reveal-on-hover button beside
  Follow and Adjust. The dock is already the answer to "a full-screen window
  with no visible way out reads as a hang" (`StageApp.svelte:1239`), and "get
  me out of full screen" is the most literal possible instance of that.

A toggle mid-take runs `Switch`, which changes the viewport, which invalidates
the line map, which triggers the §33 semantic re-anchor. That path exists and is
tested. What it has never been asked to do is run *during* a take on a
presenter's command, twice a minute, which is what §7 is about.

### 6.3 Escape

Reader mode does **not** change the two-press rule, and it is worth saying why,
because the surface argument runs the other way: a reader window has a titlebar
and is not always-on-top, so the "no visible way out" problem the double press
was written for does not apply.

`StageApp.svelte:1192` already rejected exactly this reasoning once:

> Single-window presentation used to end the take on the FIRST Escape, because
> the host was right there to hear it… The result was a keyboard that meant two
> different things depending on an architectural detail nobody using it can see.

A presentation mode is *more* visible than a window topology, but it is still
the same mistake: the same key, on the same screen, ending the session in one
mode and prompting in the other. One rule. Two presses.

## 7. Resize becomes a first-class event

Everything above is design. This section is where the actual risk is, because
the whole motion path has only ever been asked to handle a viewport that changes
**once**, before the stage mounts.

Two concrete defects, both currently unreachable and both reachable the moment a
window edge can be dragged:

### 7.1 A dropped rebuild

```ts
function scheduleLineMapBuild() {
  if (lineMapPending) return;        // ← the drop
  lineMapPending = true;
  void (async () => {
    try {
      if (planeEl) await awaitLayoutStable(planeEl);
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      rebuildLineMap();
    } finally {
      lineMapPending = false;
    }
  })();
}
```
— `ScriptLayer.svelte:1399`

A request arriving while one is in flight is dropped, and nothing reschedules it.
Usually harmless, because `rebuildLineMap` reads the *current* `vw`/`vh` when it
eventually runs. But a resize landing between `rebuildLineMap()` reading the
viewport and `lineMapPending = false` leaves a map built for a size the window no
longer has, with no pending rebuild to correct it. In prompter mode the viewport
changes once and this never fires. Under a drag it fires constantly.

Fix: a `lineMapDirty` flag set on every request, cleared when a build starts, and
checked in the `finally` — a trailing-edge rebuild. Small, and testable without a
window.

### 7.2 An occluded window that never said so

`ScriptLayer` handles `visibilitychange` and calls `engine.visibilityRestored`,
which re-anchors to what is on screen and resets the fade rather than replaying
missed motion (§32.4). That is the right behaviour and it is already there.

But a reader window can stop receiving `requestAnimationFrame` callbacks without
`document.hidden` ever becoming true — fully occluded by another app's window is
the ordinary case, and it is a case an always-on-top full-screen prompter can
never be in. Then:

- frames stop; the follower stops integrating
- alignment snapshots keep arriving (they come over IPC, not off rAF)
- on resume, `visibilityRestored` is *not* called, so no re-anchor happens
- `dtMs` is capped by `maxFrameDtMs` (`controller.ts:385`), so there is no
  runaway integration step — the plant just resumes and catches up

The result is a long catch-up scroll rather than a jump, and `catchUpSinceMs`
bounds it. Not a disaster; not right either. Fix: drive the re-anchor off a
detected frame gap as well as off `visibilitychange` — if `dtMs` exceeds the
hitch threshold by a wide margin, treat it as a visibility restore. That puts one
decision in one place, which is the pattern the existing comment at
`ScriptLayer.svelte:2615` explicitly asks for ("it used to be both, which is one
decision with two owners").

### 7.3 Deliberate policy during a drag

Beyond the two defects, reader mode needs a stated policy:

- **Coalesce.** A drag produces a resize per frame. Debounce the *resolve* and
  the *line-map rebuild* on a trailing edge (~120 ms of quiet), so a drag
  produces one rebuild rather than sixty.
- **Do not fight the reader.** While a resize is in flight, hold the follower
  where it is and re-anchor once, after the rebuild. Do not let the corridor
  correct against a map that is being replaced.
- **Do not blank.** The opening plate must not come back on every resize. It is
  for "the script has not found its position yet" at open; a resize re-anchors an
  already-placed script, and flashing black on a window drag would be worse than
  a frame of slightly-wrong wrap.
- **Say when it stops fitting.** A window dragged narrow enough runs
  `hardwareFitCheck` down through `width_limited` to `impossible`. Those verdicts
  already carry operator-facing sentences; reader mode is the first context where
  they are *actionable in the moment* — "make the window wider" is a thing the
  reader can do right now. Surface `fitAdvice` in the dock, quietly, and let it
  go away when the window grows.

## 8. What does not change

Worth listing, because it is most of the system:

- **The alignment engine.** `crates/cc-align` sees atoms and milliseconds. It has
  no idea what a window is.
- **The align host.** `src-tauri/src/align/mod.rs` converts atoms to tokens.
  Unaffected.
- **The follower.** `motion/controller.ts` is pure and takes `dt` from its
  caller. Unaffected except through the line map.
- **The stage event protocol.** `src/shared/contracts/stage.ts` needs no new
  event: reader mode is a property of the *window*, and the stage learns its size
  from the DOM. (`presentationMode` does belong in the envelope, so the stage can
  choose the reader measure table — one field, mirrored in the Rust twin per the
  usual rule.)
- **Speech.** On-device, one thread, indifferent to window geometry.
- **The two-window stage path.** `open_stage` / `set_stage_fullscreen` stay as
  they are. Reader mode is a single-window concept; a "windowed stage window" on
  a second display is a different feature nobody has asked for.
- **Blank, mirror, take markers, the transport, manual scroll.** All already work
  and are all *more* useful in reader mode — trackpad scroll especially, which is
  the natural gesture for "take me back a paragraph" when you have a trackpad
  under your hand.

## 9. Honest gaps

Stated in the house style, because a green suite here has repeatedly coexisted
with a broken product:

- **Nothing automated on this machine can drive the packaged app.** macOS ships
  WKWebView and Apple provides no WebDriver. Every claim about what a real reader
  window does when dragged is unverified until somebody drags one.
- **`Switch` is a live geometry change during a running take**, and this app's
  history with live geometry changes is the entire reason `present.rs` and
  `stores/presenting.ts` exist. Expect the first implementation to have a visible
  artifact on at least one of the four transitions.
- **The reader measure numbers (55–75 characters) are a starting position, not a
  finding** — the same status `FRAMING_MEASURE_SCALE` gives its own multipliers.
  They come from typographic practice for continuous reading, not from measuring
  anybody reading a script aloud off a window.
- **Tier C ports the shipping follower into Rust** and would have to learn about
  a changing viewport to say anything about reader mode. Until it does, no
  benchmark number describes reading in a window.
- **Reader mode is the first context in which the fit check's narrowing path runs
  routinely.** It is well tested as pure logic and essentially unexercised in a
  real take.

## 10. Phasing

Each phase is independently shippable and independently useful.

**Phase 1 — the mode exists.**
`presentationMode` replaces `stage.fullscreen` (and finally means something).
`plan` grows to three states; `Enter(Reader)`/`Restore` only, no `Switch`.
Reader mode keeps chrome, does not pin, does not move the window, lowers the
minimum size, holds the sleep assertion. Present honours the setting. Optics are
untouched — so the column is prompter-narrow and the mirror may be wrong, but the
mode is reachable and the window layer is proven.

**Phase 2 — the reading experience.**
The `desk-reading` preset, `readerRigKey`, `lensPlacement: 'none'`, the reader
measure table, mirrors forced off, and the resolve moved into `ScriptLayer` for
reader mode. This is the phase that makes reader mode actually pleasant, and it
is nearly all pure-logic changes in `shared/` with unit tests.

**Phase 3 — resize hardening.**
The trailing-edge rebuild (§7.1), the frame-gap re-anchor (§7.2), the coalescing
and re-anchor policy (§7.3), and `fitAdvice` in the dock. Do this before
`Switch`, not after: `Switch` is a resize, and shipping it onto an unhardened
resize path is shipping the bug twice.

**Phase 4 — the mid-take toggle.**
`Switch` in both directions, `Cmd+Ctrl+F`, the dock button, and the frame
re-capture invariant from §5.2.

**Phase 5 — one resolver.**
Unify prompter mode onto the stage-side resolve, retire control's, and re-run
Tier A/B/C to prove the geometry did not move. Deliberately last, and
deliberately behind a benchmark: it is a cleanup, and it touches the one path
that is currently working.

---

## 11. Review corrections (2026-07-30)

Everything above was audited against the tree at `eb406b8`. Most of it held —
the optical formulas, the arithmetic, and nearly every citation. What follows is
what did not, kept here rather than edited into the body so the original
reasoning stays legible. **Read this section before implementing any of the
above.**

### Blocking: the reader preset cannot produce the reading experience §4.2 designs

§4.3's preset sets `hardwareKind: 'generic'`, and a generic panel resolves to
`diagonalInches: null` (`optical-discovery.ts:111`). With no physical scale
`mmPerCssPx` is null, `hardwareFitCheck` returns `'uncalibrated'`
(`optics.ts:535`), and the resolver falls back to `UNCALIBRATED_FONT_SIZE_PX = 64`
(`optical-resolve.ts:90`, used at `:258`) with a 68%-wide column.

So Phase 2 as written lands on 64px uncalibrated type, not the ~30px and 55–75
characters §4.2 derives. The 30px figure assumes a *measured* `mmPerCssPx`, and
nothing in this design provides one: the calibration wizard is hood-, lens- and
glass-oriented, and it now refuses to open its stage on the control panel or on
a single-display machine (`Calibrate.svelte`). The reader profile also cannot
simply borrow the prompter's scale — a ruler-calibrated scale may include
beamsplitter magnification, so it describes the finished optical path rather
than the bare panel (`contracts/optical.ts:45`).

**Reader mode needs a direct-display calibration path of its own** — panel model
or diagonal, an on-screen ruler, reading distance, band preference — and it is a
prerequisite for Phase 2, not a follow-up.

### §7.1's defect does not exist as described

`rebuildLineMap` is synchronous with no awaits (`ScriptLayer.svelte:1414`), so
nothing can interleave between its viewport read and the `finally` that clears
`lineMapPending`. The **drop** is real (`:1400`, no dirty bit) but self-correcting:
the build reads live `vw`/`vh` whenever it runs, and a resize arriving after the
synchronous rebuild finds the flag clear and schedules another.

A trailing-edge flag may still be worth having for latency, but the permanently
stale map offered as its justification is not reachable.

### §7's premise is false: live resize is already exercised

"The whole motion path has only ever been asked to handle a viewport that changes
once, before the stage mounts" is wrong. Browser journeys resize a running take
repeatedly — `single-window-presentation.spec.ts:206`, `:281`, `:317`, `:388`,
`:467`, `:500`, `:638`, and `auto-scroll.spec.ts:176`. Coverage-only rebuilds are
also already throttled at 250 ms (`ScriptLayer.svelte:914`).

The real §7 risks are the ones this section understates: mixed geometry during a
drag. Safe rect, reading band, padding, column, `maxScroll` and `engine.setBounds`
all react to `vw`/`vh` immediately while the line map still describes the old
viewport; virtualized off-window block heights stay cached across wrapping
changes; and the transport advances on an uncapped wall-clock delta. The unit that
fixes this is a **committed geometry generation** — suspend follower, transport and
viewport hints, resolve and rebuild once, then commit optics, map, bounds and band
together and run one `layoutRecovery` — not two point repairs plus a debounce.

### §5.2's one latch loses the editor frame

The stated recapture invariant makes the final restore depend on toggle history:
`Enter(Reader)` saves the editor frame `E`; the reader resizes to `R`;
`Switch(Reader → Prompter)` recaptures `R`; ending the take restores `R`. But
`Reader → Restore` without ever toggling restores `E`. Identical intent, different
geometry.

Recapturing after `Enter(Reader)` has lowered the minimum size also records the
*lowered* minimum, so one undifferentiated snapshot cannot restore the original
980×680. Use `PresentationState { mode, editorFrame, readerFrame }` and treat the
minimum as app-owned state.

Also missing from §5: maximize, minimize, OS-native fullscreen, titlebar close
(there is no control-window `CloseRequested` policy), monitor move/disconnect
(the topology watcher at `windows/mod.rs:877` has no control subscriber), and
sleep-assertion ownership — `sleep.rs` is one global latch that closing a
separate stage releases unconditionally (`windows/mod.rs:757`), which would drop
it out from under a live reader take.

### Smaller factual corrections

- **`set_min_inner_size` does not exist** anywhere in `src-tauri/`. The Tauri
  commands are `set_min_size` / `set_size_constraints`.
- **§3's history is wrong.** The *current* dead-setting conclusion is right —
  `Settings.svelte:299`, `:480`, `:1554` are the only reads and `start-take.ts`
  never reads it, all verified exactly as cited. But "it never did anything" is
  false: `start-take.ts` called `setStageFullscreen(sessionId, s.stage.fullscreen)`
  from `8177f0f` until `60c5361` removed it. The migration also needs an explicit
  overlay migration — `settings.ts`'s `mergeSection` will not drop the old field.
  And replacing `fullscreen` outright breaks the two Settings callers, which
  contradicts §8's claim that the separate-stage path is untouched.
- **§4.3 undercounts the context plumbing.** `READING_MEASURE` is read directly in
  override warnings and clamping (`optical-resolve.ts:477`, `:514`, `:517`), the
  uncalibrated fallback (`:547`), and several fit branches (`optics.ts:575`, `591`,
  `599`). Threading a context through three functions leaves reader mode on
  prompter thresholds elsewhere. Pass a measure *policy* object instead. Fit advice
  is also prompter-worded ("larger prompter", "closer to the glass") and needs
  mode-aware text.
- **`lensPlacement` is a string union, not an enum** (`contracts/optical.ts:110`),
  and adding an arm requires the normalization allowlist at
  `settings-types.ts:327`. `'none'` is numerically safe — `isOffPanel` tests only
  `above`/`below` — but semantically it overloads a field that means where a
  physical lens sits, and `derivedBandY` still derives horizontal centre from
  `profile.lens.x`. A band-anchor policy with a real reader preference field is the
  cleaner shape; §4.3 names 0.42 without adding anywhere to put it.
- **Presets do not zero `safeArea`** — they own four fields
  (`optical-rig-presets.ts:69`) and leave `safeArea` alone. The zeroes come from
  `defaultOpticalProfile`, which §4.3 must state as an invariant.
- **§8's Rust-twin claim is wrong.** Rust treats `stage_settings` as opaque
  `serde_json::Value` and unknown envelope fields survive via flattened `rest`
  (`windows/mod.rs:992`, `:998`), so `presentationMode` needs no Rust field unless
  Rust inspects it. Routing the dock toggle the existing way *would* need a new
  `StageIntent` variant.
- **Tier A/B/C cannot prove the Phase 5 geometry unchanged.** A/B stop at engine
  position; Tier C explicitly does not model real text measurement or WebKit
  layout (`bench/README.md:231`). The acceptance evidence has to be resolver
  fixtures, DOM layout tests and a packaged-app pass.
- **Line drift.** `StageApp.svelte:1239` → `:1271` and `:1192` → `:1221` (moved by
  `eb406b8`). The `dtMs` cap is `controller.ts:409`, not `:385`. The eye-movement
  rationale and `FRAMING_MEASURE_SCALE` are in `optical-resolve.ts:163`/`:170`, not
  `optics.ts`. Mirrors are read at `stage-envelope.ts:299`, not `:242`. The dock
  already has an End button, so a mode control is its fourth, not third.
  `awaitViewportSettled` needs two identical frames (`control-window.ts:139`), so
  it does not resolve on the first check.
- **§2's "0.6–3 m" is the preset range, not the model's** — `optics.ts:242` accepts
  150–15,000 mm.

### Confirmed correct, since it was checked

The arithmetic is right, including the part that looks inconsistent: characters →
px uses `FALLBACK_AVG_CHAR_WIDTH_RATIO = 0.5` while the CSS `ch` unit uses
`FALLBACK_ZERO_ADVANCE_RATIO = 0.55`, and this document uses each in its place.
Also verified: 0.200 mm/CSS px and ~30px body size for a 16" panel at 600mm and
24′; `READING_MEASURE` 32–38 with the field names §4.3 mirrors; `minWidth`
980×680; `TARGET_VISIBLE_LINES` = 5; `maxColumnFraction` 0.92; `geometry.ts:221`
and `:202`; the `presenting_twice_does_not_resave_the_frame` quote; and the
`stage-envelope.ts:274` font-metrics quote, character-for-character.
