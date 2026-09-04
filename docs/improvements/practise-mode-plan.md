# Practise mode

Status: **built.** Written against the code as of 2026-09-04 on
`feat/practise-mode`, branched from `develop` at `cbdc8e6`. Where it disagrees
with the older specs in `docs/`, the code was consulted and the code wins.

---

## 1. The use case

Before a script goes to the glass it gets read through, several times, at a
desk. What somebody is practising is the delivery: saying the words out loud
and finding out whether the script keeps up with them. That is the app's whole
trick, and until now the only way to reach it was to open a take — which fills
the display, and ends by opening a report on a performance nobody gave.

A practice is that same reading, framed as a rehearsal.

## 2. The one decision: a practice is a take that has been told it is a rehearsal

Voice following stays on. This is the decision the rest of the design hangs
off, and the tempting alternative — a mic-less mode driven by the fixed-pace
transport — rehearses nothing. Reading aloud and being followed IS the skill;
a script rolling at 130 words a minute while you read along is a different
exercise, and one the app already offers inside any take with the space bar.

So a practice reuses the reader-mode machinery whole. Reader mode is built to
phase 4 of `CandidCue_Reader_Mode_Specification.md`: the window keeps its
chrome, latches a resting frame, lowers its minimum size, resolves optics for a
desk, hardens resize, and pops out to the prompter on ⌃⌘F. Every one of those
is what a rehearsal wants, and every one was hard to get right.

Three things follow from the flag, and they are the whole feature:

| | Reader take | Practice |
|---|---|---|
| Window | whatever Settings says, and an explicit choice sticks | always a window, and the default is never written |
| Document | performance projection: a table becomes REFER TO TABLE | the whole thing, tables and all |
| Ending | the end-of-take report | nothing; the editor comes back |

Everything else — the microphone, the recogniser, the aligner, the motion path,
the optics, the dock, the appearance sheet, the transport, ⌃⌘F — is the take's,
untouched, because it is doing the same job.

Two pieces of vocabulary were already waiting for this:

- `src/shared/performance-view.ts` has had `PerformanceMode = 'take' |
  'rehearsal'` since it was written, and says in its own comment that "nobody
  rehearsing wants their reference table replaced by the words REFER TO TABLE".
  Until now the only way to select it was the diagnostic stage mode.
- `src/control/lib/present-menu.ts` says the three questions at launch are where
  to start, how to display, "and whether this is a take or a rehearsal" — and
  that the third was not covered. It is now.

## 3. What was built

**The flag.** `StartTakeOptions.practice` in `src/control/lib/start-take.ts`.
It forces `presentationMode: 'reader'` *past* `resolveLaunchSettings`, so the
window is a window without the saved default being rewritten — otherwise
somebody who rehearses before every take would find their real takes had
quietly stopped filling the display. It reaches `startLiveSession` as
`practice: true` and lives in the control-side session store and nowhere else.

**The session row is deliberately ordinary.** A practice writes a `'voice'`
session in the ordinary place, because a rehearsal is a real reading and its
ending is a real place in the script — "From last ending" on the Present menu
should pick a practice up exactly as it picks a take up. That is also why the
feature needs no schema change and no migration.

**Entry.** `file.practise`, label "Practise", accelerator ⌘⇧↩ next to Present's
⌘↩: the same gesture with the same precondition and a different consequence.
Availability is `file.present`'s verbatim. It is declared in
`src/shared/contracts/commands.ts`, defined in `src/control/lib/commands.ts`,
run from `src/control/App.svelte`, and mirrored in `src-tauri/src/menu.rs`
under File. It also appears as a row in the Editor's Present split menu, below
the two shapes, which is where the launch questions are answered.

**Readiness is not skipped.** A practice goes through the Editor's readiness
sheet exactly as a take does. It needs the model and the microphone for the
same reason a take does, and waving a rehearsal past the check would put
somebody in front of a script that never moves.

**The document.** `ScriptLayer` gained a `rehearsal` prop feeding
`performanceMode`. Safe to flip per take because the projection only touches
blocks carrying no spoken token, so the aligner sees the same indices either
way.

**The ending.** `stopSession` withholds the summary from the store when the
session is a practice. Live opens the F.17 card on `!active && summary !==
null`, so that is the whole of "no report". The summary is still built and
still returned: everything above that line closes the session row, flushes the
transcript tail and reports the ending location to Rust.

**The words.** There are three ways out of a running session and all three ask
before they take it. `StageDock` takes a `practice` prop and changes only the
exit control and its confirmation — "Finish Practice", "Finish practising?",
"Nothing is reported. Your place in the script is kept." Live's own dialog (the
drawer button, ⌘.) and App's navigation guard ask the same question from
elsewhere and follow it, off one shared body in `app-lifecycle.ts`; leaving
either of them offering to "end this take" would have put the operator in front
of an offer to end something they do not believe they started. Nothing else on
the dock moves, because nothing else is doing a different job.

**The forced window had to reach the optics too, and at first it did not.**
`stageSettingsFromSettings` branches on `stage.presentationMode` to choose the
optical profile: a reader synthesises its own desk rig, a prompter resolves the
calibrated or automatic one for the glass and carries the mirroring with it. An
explicit "Present in a window" is safe because `resolveLaunchSettings` bakes the
choice into the settings it returns — but a practice goes past that resolver on
purpose, which is exactly how it avoids writing the default, so the settings it
composed from still said `prompter`. The operator this feature was written for —
somebody who presents to glass every day and rehearses at a desk — would have
opened a reading window sized for a teleprompter and, with mirroring on, read a
backwards script. It repaired itself the moment anybody touched an appearance
slider, because `recomposeStageSettings` in the session store already applies the
take's own mode over the saved one. `startTake` now composes the same way, and
`tests/unit/control/start-take.test.ts` pins it beside the identical regression
already recorded for the explicit-choice path.

**The layout fingerprint had to be told.** `ScriptLayer`'s `layoutInputs()`
already read `performanceMode`, so a practice schedules a map rebuild — but
`buildLayoutFingerprint` re-derived the same field from `stageMode`, which a
practice never touches. `sameLayout()` would therefore have called a rendered
table and the words REFER TO TABLE the same layout, replaced the map under the
OLD generation and skipped the §33 semantic re-anchor: the precise omission the
exhaustive `IDENTIFIES_LAYOUT` table exists to prevent. The renderer now states
the projection it drew and the settings derivation only stands in when nobody
does.

**The ending reaches the database before the editor reads it.** `stopSession`
fire-and-forgets the session row's ending index, and the Editor's history effect
is built around that: it depends on `$session.summary` so the report's arrival is
a second, later trigger after a mount that may have read the row too early. A
practice publishes no summary and therefore has no second trigger — so it awaits
`awaitPendingPersistence()` inside the cover before navigating, the same
primitive the quit handshake awaits and for the same reason. Without it "From
last ending" could offer an older ending, or none, which would have hollowed out
the reason a practice writes an ordinary session row at all.

**A practice clears its own session.** `leavePresentation` deliberately does not
clear, because the store's `summary` is what the report opens on and clearing
under the cover was the bug that meant nobody had ever seen one; `SessionSummary`
clears when it is dismissed. A practice opens no card, so that dismissal never
comes — without this the store would hold a finished rehearsal until the next
take replaced it. It is safe here for exactly the reason it was unsafe there:
there is no report to destroy.

## 4. Light or dark: dark, and here is why

Greg left this open. It is dark.

The stage has no theme today in either direction. `StageSettings` carries
`themeId`, `background` and `foreground` on the wire and the envelope fills
them, but nothing reads them: `src/styles/stage.css` hard-codes `--stage-bg`,
which is why the old two-option "Stage background" menu rendered identically on
both options and was replaced by `textIntensity` — a text luminance over an
unchanging black.

So a light theme is not a colour swap. It is: the stylesheet taking its ground
from the envelope, `textIntensity` deciding what it means on paper, the dim
ramp re-checked because opacity fades towards the background, and a paper
variant of the dock, the appearance sheet and their menus.

That work is worth doing on its own merits, and it is not worth doing to ship a
rehearsal. The argument for dark is also the better one: what you rehearse
should look like what you will read. Light stays available as a later feature,
and it belongs to the stage rather than to practising.

## 5. What is not done

- **No light theme.** §4.
- **A practice always opens at the beginning.** The Present split menu's start
  rows ("From here", "From last ending") each launch a take as soon as they are
  chosen, and `SplitButton` closes on select — so there is no gesture that picks
  a start row and the Practise row together, and rehearsing one section is not
  reachable. The fix is a design decision — a start row per shape, or a practice
  that opens at the caret — not a wiring one, so it is recorded rather than
  guessed at.
- **A legacy `defaultSessionMode` still governs a practice.** `startTake` passes
  `s.general.defaultSessionMode` into both the session row and the live session,
  and `fromRustDocument` still accepts a persisted `manual` or `fixed`. On such a
  document a practice opens without the voice pipeline and rehearses nothing —
  but so does a take, readiness skips the microphone check for both, and Settings
  already names the state and offers one click back to voice. Forcing voice for a
  practice alone would make Practise work where Present does not on the same
  document, which is a product decision rather than a defect fix.
- **`stopSession` returns a zero summary on a SECOND stop of a practice.** The
  first stop stores `null`, so the `!active` guard's `s.summary ?? emptySummary(s)`
  has nothing to hand back. No production caller reads the return and the
  teardown guards prevent a double stop; retaining the measured summary purely to
  make an unread return value idempotent would be state added for nobody.
- **The Library has no Practise row.** ⌘⇧↩ works there — the command resolves
  the Library's selected script — but there is no visible affordance. The
  Editor's split menu is the discoverable one.
- **Rehearsals are in the session history.** By design (§3), but it means a
  script practised ten times has ten session rows. If that becomes noise, the
  fix is a `practice` column on the row and a filter, not a change here.
- **⌘⇧↩ from the menu skips the readiness sheet**, exactly as ⌘↩ does today.
  Pre-existing, and shared with Present rather than introduced here.

## 6. Tests

- `tests/unit/control/start-take.test.ts` — a practice opens in a window
  whatever Settings says, never writes that window back, still carries the
  microphone and the transcription config, flags the session, and writes an
  ordinary session row.
- `tests/unit/control/session-store.test.ts` — a practice is a voice take with
  the flag set; it opens no report; `stopSession` still measures and returns
  one; an ordinary take still reports.
- `src/control/lib/commands.test.ts` — Practise is offered exactly where
  Present is, across six contexts, and runs the practice action rather than a
  present with a mode.
- `tests/dom/stage-dock.test.ts` — the exit control and confirmation say the
  right thing in both directions, and a practice still ends through the same
  confirmed path.
- `tests/unit/control/start-take.test.ts` also pins the optics: a practice out
  of a saved mirrored prompter default composes reader optics with no mirror, in
  both the settings and the envelope the renderer actually receives.
- `tests/unit/stage/measure.test.ts` — the fingerprint takes the rendered
  projection from the caller, two projections are not the same layout, and the
  settings derivation still stands in when nobody says.
- `tests/unit/control/app-lifecycle.test.ts` — the shared take body still
  refuses to promise a place, and the practice body reports nothing and calls
  the rehearsal nothing.
- `src-tauri/src/menu.rs` — the existing accelerator mirror covers ⌘⇧↩ in both
  directions and passes.

**Unproven by any of the above**, and worth saying plainly: nobody has yet
practised a real script into a real microphone with this build. macOS ships
WKWebView, which has no WebDriver, so nothing automated here can drive the
packaged app. The suite proves the plumbing. Whether a rehearsal *feels* right
is a morning's use.
