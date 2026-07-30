# Reader mode: presenting without taking the display

Status: **phases 1–4 built; phase 5 deliberately not.** §11 records what was
built differently from what §1–10 proposed. §12 records what a separate audit of
§1–10 against the code found that building it did not already settle.

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

## 11. As built

Phases 1–4 are implemented. Phase 5 is not, for the reason given above.

Four things came out differently from the plan, and one of them corrects it.

**The plan was wrong about the angular ladder — twice, in opposite directions.**
An earlier draft of §4.2 proposed a `READER_PRESET_ARCMIN` on the grounds that
24′ at desk distance would be too small. That was a factor-of-two arithmetic
slip: `featureHeightMm` is `2 · D · tan(θ/2)`, and running it correctly gives 24′
at the preset's 550 mm = 3.84 mm of cap height = **27.4 CSS px** on a 0.2 mm/px
display, which is large, comfortable reading type. No reader ladder was added,
and `reader-mode-optics.test.ts` pins the two contexts to the same one. The
measure finding survived the correction; the size finding did not.

(§4.2's own worked example says 600 mm and ≈30 px, because it was written against
the `desk-webcam` preset before `desk-reading` existed at 550 mm. Both figures are
right for their own distance; 550 mm / 27.4 px is the one reader mode ships.)

**`UNCALIBRATED_READER_FONT_SIZE_PX` (30) was not in the plan and is needed.**
`scaleForDisplay` can only answer for hardware it recognises by its panel, and
the ordinary Mac display somebody reads on is `generic` — so the uncalibrated
path is the *common* case for reader mode, not the edge case it is for a
prompter. 64 px in a reading window is about a dozen characters a line. 30 px is
the same arithmetic as the paragraph above, run for the uncalibrated case.

**`overrides.readingBandY` is new.** The plan said the reader's band position
was "a preference" without saying where the preference lived, and there was no
override that could hold it — `lensOffsetDegrees` is an angle measured *from a
lens*, which is exactly what a `'none'` rig does not have. The new override wins
over `lensOffsetDegrees` when both are set, rather than composing with it, so the
number somebody typed is the number they get.

**Two frames, not one.** §5.2 proposed re-capturing the resting frame on the way
out of reader mode. That is unsafe: reader mode lowers the window's minimum size,
so those bounds can be smaller than the editor's own minimum, and a `Restore`
replaying them would hand back an editor at 520×360. `PresentState` therefore
holds `resting` (written once by `Enter`, never overwritten — the original
latch-not-a-stack rule verbatim) and `reader` (the reading window's own bounds, so
a `Switch` round trip preserves them). Neither has to know about the other.

Smaller notes:

- `PresentationMode` and `ReadingContext` are separate types with the same two
  members, mapped once in `stageSettingsFromSettings`. One is a fact about the
  window; the other is an input to the optical model. The types say so.
- The reading rig is stored under a reserved rig name (`READER_RIG_NAME`) inside
  the existing `profiles` map, so it is keyed, normalized, listed and validated by
  the machinery every other rig already goes through.
- `set_control_presenting` kept its `enabled: bool` and gained an optional
  `mode`, matching how `set_stage_fullscreen` handles `native`. An
  `{ enabled: true }` payload from before reader mode still presents as a
  prompter.
- The viewport settle debounce (§7.3) is applied to `vw`/`vh` themselves rather
  than to a second "settled" pair beside them. A split viewport means the band,
  the padding and the fades track a window whose line map describes a different
  width — a document that is wrong about itself, rather than one that lags a drag
  by a tenth of a second.

### Found in review, and fixed

An adversarial pass over the built code turned up seven things. They are recorded
because most of them are the kind of defect that would only have shown up on a
real rig, and two of them were the code's own comments claiming more than the
code did.

1. **The mode was committed before the window changed.** `set_control_presenting`
   wrote `state.mode` and then ran the window mutations, every one of which
   `?`-propagates. A `Switch` that failed partway left the latch claiming the new
   mode while control still believed the old one — so the retry planned
   `Reassert`, and `apply_reader` (which moves no geometry, by design) could not
   undo the prompter's pinning or chrome. The window stayed borderless and above
   the menu bar while control composed a reading window's geometry for it. Fixed
   in two halves, because either alone leaves the other reachable: the mode is
   committed only after the apply succeeds, AND `apply_reader` now un-pins and
   restores chrome idempotently so a mis-planned `Reassert` also recovers.
   `a_failed_switch_retries_as_a_switch` pins the first half.
2. **Reader optics were measured against the wrong display.**
   `chooseStageDisplay` deliberately prefers a NON-primary panel, which is right
   for a prompter and exactly backwards for a window that never moved. A reader
   working at their laptop with a calibrated external prompter attached had their
   type sized from the external panel's `mmPerCssPx` — the entire basis of the
   angular model — so the text came out confidently the wrong physical size. It
   now takes the mode and prefers the primary display, and ignores a pinned
   prompter fingerprint (which names a panel a prompter presents on, and says
   nothing about where a reading window is). **Residual gap, filed not fixed:**
   dragging a reading window to another display mid-take keeps the first panel's
   scale. The complete answer is for `set_control_presenting` to report the
   monitor the window actually landed on — `windows::window_monitor_fingerprint`
   already computes it for the separate stage — and rebuild the envelope from it.
3. **A ruler scale is not safe to inherit.** `readerOpticalProfile` borrowed the
   panel's `scale` unconditionally, and `OpticalScale`'s own contract says a
   ruler measurement describes "the finished optical path" including "a
   magnifying beamsplitter". A rig measured at 0.25 mm/px through glass whose
   bare panel is 0.20 would render a reading window ~20% small while reporting
   itself calibrated. `inheritableReaderScale` now accepts only the
   panel-derived sources (`model`, `diagonal`); a ruler-only rig falls through to
   the uncalibrated reader default, which is a guess that says it is one.
4. **The reserved rig name could be hijacked destructively.** The comment called
   a collision "a strange thing to do and a harmless outcome". It was not
   harmless: a prompter rig a user happened to name "Reading window" was adopted
   wholesale, hood crop, mirror, 2.5 m distance and all. A stored profile is now
   adopted only when `lensPlacement === 'none'`, which is the one field only a
   reading rig has.
5. **The chord repeated.** Held, ⌃⌘F flipped the window between shapes at the
   key-repeat rate — an OS window operation and a full relayout per repeat. It
   now stands down on `event.repeat`, like the `a` transport toggle. The in-flight
   guard alone was not enough: it only suppressed repeats *during* a switch.
6. **The toggle raced the stage's own settle, and its comment denied it.**
   `awaitViewportSettled` watches the RAW viewport (~33 ms at 60 Hz), but reader
   geometry resolves from a viewport deliberately trailed by 120 ms — so
   recomposing on the raw settle produced precisely the double relayout the
   comment claimed the ordering avoided. The switch now waits both out, and
   `VIEWPORT_REFLOW_SETTLE_MS` moved to `geometry.ts` so the two cannot drift.
7. **A stale switch could mutate a later take.** The sequence spans two waits and
   `adoptPresentationMode` guards only on `active`, which a *fresh* take also
   satisfies. It now captures the session id before awaiting.

Also fixed: `declared_min_size` returned `None` unless BOTH axes were declared,
and `set_min_size(None)` clears the floor rather than leaving it — so a future
config that dropped `minHeight` would have left the editor with no width floor
either, permanently, the first time anybody used reader mode.

Three review notes were considered and not acted on. A failed `exitPresentation`
can still leak the sleep assertion and leave presentation chrome behind, because
`Live.svelte` suppresses the error and navigates anyway — pre-existing, and
untouched by this change. `adoptPresentationMode`'s no-display guard records a
mode it does not compose into the document, which is deliberate: the window has
already changed by then, so a truthful dock beats a consistent envelope, and the
case is unreachable in production for the reason its sibling guard states. And
the second review request — the optics and renderer half — timed out rather than
returning; that half was reviewed by hand instead, which is what turned up the
550/600 mm error above.

### Verified, and not

Green: `pnpm check` (0 errors), 1766 node vitest tests including 55 new ones
across `src/shared/reader-mode-optics.test.ts` and
`tests/unit/control/presentation-mode.test.ts`, the jsdom suite file-by-file
including a new `tests/dom/script-layer-viewport-settle.test.ts`, 202 `cargo
test` tests including 6 new `present::plan` pairings, and `pnpm build`.

The jsdom suite is the only place the resize path is exercised at all, and it is
worth knowing what it does and does not reach. It pins that the opening is not
delayed by the debounce, that a burst of resizes coalesces, that the document does
NOT re-wrap mid-drag, and that the sequence converges rather than rescheduling
forever. It does **not** pin the `lineMapDirty` trailing rebuild directly: that
fixes a two-frame race, and nothing in jsdom can schedule an observation into that
window reliably. The file says so at the top rather than letting its name imply
otherwise.

**Not verified, and §9 still applies in full.** Nothing here has been run in the
packaged app. In particular: no reader window has been dragged, no `Switch` has
been watched on real glass, and the resize-hardening in §7 is asserted as logic
rather than observed as behaviour. The two defects it fixes were found by reading
the code, and their absence is unproven on a real window.

## 12. Audit of §1–10 (2026-07-30)

§1–10 were audited against the tree independently of the work in §11, which had
not landed at the time. Most of the audit is now moot — building it settled the
same questions, usually better. Two findings corroborate §11 and are worth
recording as independent arrivals at the same place: the uncalibrated font size
(§11's `UNCALIBRATED_READER_FONT_SIZE_PX`) was reached from the other direction by
noticing that a `generic` panel yields `diagonalInches: null`, so `mmPerCssPx` is
null, `hardwareFitCheck` returns `'uncalibrated'` and the resolver falls through
to 64px; and the wrong-display defect (§11 review item 2) and the ruler-scale
defect (item 3) were both independently predicted from `chooseStageDisplay`'s
non-primary preference and `OpticalScale`'s own contract.

What the audit found that §11 does not cover:

**§7.1's stated race is not reachable, and §11's comment restates it.** Both the
original §7.1 and the `WHY DROPPING IT WAS SAFE AND IS NOT ANY MORE` comment now
in `ScriptLayer.svelte` describe a change landing "after `rebuildLineMap()` has
read its inputs but before the `finally` clears the flag". `rebuildLineMap` is a
synchronous function with no awaits, and the `finally` runs in the same
synchronous turn as the call — so no browser event and no Svelte effect can be
delivered into that gap. The window is zero-width, not "a couple of frames".

`lineMapDirty` is still defensible, for a different reason the comment does not
give: a request arriving during the two *awaits* (`awaitLayoutStable`, then rAF)
was previously dropped outright, and the trailing reschedule now catches it. Note
the cost, though — `lineMapDirty` is cleared inside the `try` before those awaits,
so any request landing in that window sets it, and the in-flight build already
reads current inputs when it runs. The trailing rebuild is therefore redundant
work in exactly the case it fires. Worth measuring before treating it as free.

**"The viewport changed once per take" is false, in §7 and again in §11.** §7
opens with it, §11's *Verified, and not* repeats it as "the jsdom suite is the only
place the resize path is exercised at all", and the comment quoted above states it
a third time. Playwright resizes a running take in
`single-window-presentation.spec.ts:206`, `:281`, `:317`, `:388`, `:467`, `:500`
and `:638`, and in `auto-scroll.spec.ts:176`. Coverage-only rebuilds were also
already throttled at 250 ms before this change. The resize path was *thinner* than
reader mode needs, not unexercised — which makes the browser suite the place to
add the reader cases §11 correctly says jsdom cannot reach.

**§3's history is wrong, though its conclusion is right.** "No effect on any take
anybody has ever run" is false: `start-take.ts` called
`setStageFullscreen(sessionId, s.stage.fullscreen)` from `8177f0f` until `60c5361`
removed it. The three read sites cited (`Settings.svelte:299`, `:480`, `:1554`)
and "`start-take.ts` never reads it" are exactly right for the current tree.

**Phase 5's acceptance criterion does not exist.** §10 proposes re-running Tier
A/B/C to prove a unified resolver did not move the geometry. Tier A/B stop at
engine position, and Tier C explicitly does not model real text measurement or
WebKit layout (`bench/README.md`). Geometry equivalence needs resolver fixtures,
DOM layout assertions and a packaged pass — not benchmark scores. Worth settling
before Phase 5 is picked up, since it is the stated gate.

**Smaller.** §5.4 names `set_min_inner_size`, which does not exist in Tauri; the
implementation correctly used `set_min_size` / `declared_min_size`. §2's table
gives the prompter viewing distance as 0.6–3 m, which is the preset range — the
model accepts 150–15,000 mm (`optics.ts`). §4.2's eye-movement rationale and
`FRAMING_MEASURE_SCALE` are in `optical-resolve.ts`, not `optics.ts`; mirrors are
read at `stage-envelope.ts:299`, not `:242`; and the `dtMs` cap is
`controller.ts:409`.

**Verified as correct, since it was checked.** The arithmetic holds, including the
part that reads as inconsistent: characters → px uses
`FALLBACK_AVG_CHAR_WIDTH_RATIO` (0.5) while the CSS `ch` unit uses
`FALLBACK_ZERO_ADVANCE_RATIO` (0.55), and §4 uses each in its place. Also checked
against the code: `READING_MEASURE` 32–38 with the field names §4.3 mirrors,
`minWidth` 980×680, `TARGET_VISIBLE_LINES` = 5, `maxColumnFraction` 0.92,
`geometry.ts:221` and `:202`, and both long quotations character-for-character.
