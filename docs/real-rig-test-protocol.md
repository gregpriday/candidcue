# Real-rig test protocol

**Status: this is the gate that no suite in this repository can stand in for.**

macOS ships WKWebView, for which Apple provides no WebDriver, and no suite in
this repository drives the packaged app — Playwright runs against the Vite dev
server with an injected Tauri shim. Every layer that does run
here — node vitest, jsdom vitest, Playwright against the dev server, cargo tests,
cc-bench — is listed in `CLAUDE.md` along with what it proves, and a large green
suite has repeatedly coexisted with a broken product.

This document exists because "verified by real use" was true and was not a
record. A release that changes speech following, presentation windows, optics,
stage layout or live controls must produce a filled-in copy of the relevant
section below, naming the hardware and the result — including the parts that
were not tested.

This sheet covers one rig taking one build through a take. The rest of getting
a release out — the clean-clone drill, signing, interrogating the artifact,
installing on a machine that has never seen it, the coverage matrix these
sheets add up to, and withdrawing a build that turns out to be
bad — is `docs/release-runbook.md`.

## How to use it

1. Copy this file to `docs/rig-runs/<version>-<date>.md`.
2. Fill in **Rig** and delete the hardware rows you do not have.
3. Run the sections the change touches. Do not run all of them for a copy fix.
4. Record the result of every case you ran, and **list what you skipped**. A
   sheet with no skips on a one-Mac, one-monitor setup is not a pass, it is an
   unfilled form.
5. Attach it to the release.

A case has three outcomes: **pass**, **fail** (file an issue, link it), and
**not tested** (say why). There is no "probably fine".

---

## Rig

| | |
|---|---|
| Speaking Glass version | |
| macOS version | |
| Mac | |
| Microphone | |
| Display(s) | |
| Glass / beamsplitter | |
| Viewing distance | |
| Tested by / date | |

---

## A. Opening a take

Run for any change to `start-take.ts`, `windows/present.rs`, `StageApp`, or the
opening placement in `ScriptLayer`.

| # | Case | Pass criteria | Result |
|---|---|---|---|
| A1 | Present from the editor | No editor flash, no white bar, no unstyled frame at any point | |
| A2 | First readable frame | Text is at final size and position when first seen — it does not settle visibly | |
| A3 | Destination readout | The panel named under Present is the panel it opened on | |
| A4 | Present with the window on a second display | Opens on that display, not the calibrated one | |
| A5 | Present from the caret (`From here`) | Opens at the sentence the caret is in — does not open at the top and travel | |
| A6 | Present from a take marker | Opens at the marker | |
| A7 | Continue from last ending | Opens at the start of the sentence the previous take stopped inside — it snaps backwards on purpose | |
| A8 | Present from a point far down a script of **more than 300 blocks** | Same as A5. **This is the case windowed rendering is most likely to break**, and the trigger is block count, not word count — a 2,000-word script in twenty paragraphs does not exercise it. Count paragraphs, headings, list items and cues | |
| A9 | Present with no model installed | Readiness sheet appears, says voice following is unavailable, offers Start anyway. (It does not name the model — the sheet carries booleans, not a model id) | |
| A10 | Present a script with no spoken words | Blocked, with a reason. No stage opens | |
| A11 | Reader mode | Window returns to its remembered frame | |
| A12 | Launch failure (unplug the display mid-launch) | Returns to a usable editor; no half-presented window | |

## B. Following, with a real voice

Run for any change to `cc-align`, `align/mod.rs`, `speech/`, `smooth-follow.ts`,
or `src/stage/motion/`.

| # | Case | Pass criteria | Result |
|---|---|---|---|
| B1 | Read normally at ~140 wpm | Follows; the reading line stays in the band | |
| B2 | Read slowly (~80 wpm) | Does not run ahead | |
| B3 | Read fast (200+ wpm) | Keeps up, does not lag by more than a line | |
| B4 | Pause 5 seconds mid-sentence | Text holds. **Does not overshoot** | |
| B5 | Pause 15 seconds | Holds; recovers when reading resumes | |
| B6 | 15-second ad-lib off script | Holds; status says it can hear you but the words are not in the script | |
| B7 | Restart a sentence | Recovers without jumping elsewhere | |
| B8 | Skip a paragraph deliberately | Catches up within a sentence or two | |
| B9 | Re-read a paragraph (backward retake) | Follows backwards; does not fight it | |
| B10 | Read a passage that appears twice | Holds rather than guessing; offers candidates | |
| B11 | Fillers ("um", "you know") | No effect on position | |
| B12 | Numbers, currencies, dates | Followed; note any that consistently fail | |
| B13 | Brand names / camel-case | Note every term that fails; these are vocabulary candidates | |
| B14 | Room with a fan or air conditioning | Still follows | |
| B15 | Speak far from the microphone | Degrades honestly — says it cannot hear rather than guessing | |

## C. The glass

**No stage-appearance change may be accepted because it looked better in a
browser window.** `StageDock.svelte` says in its own comments that its layout
review was reasoned rather than measured on a panel; this section is how that
stops being true.

| # | Case | Pass criteria | Result |
|---|---|---|---|
| C1 | Apparent type size at your real distance | Readable without leaning in | |
| C2 | Line width at that distance | Eye travel does not break the read | |
| C3 | Mirrored text | Correct way round through the glass | |
| C4 | Reading band vs the lens | The line being read sits at the lens, not above or below it | |
| C5 | Hold state | Visible from presenting position, and reads as calm | |
| C6 | Fault state (unplug the mic mid-take) | Visible and legible from presenting position | |
| C7 | Dock at rest | Does not distract; does not obscure text | |
| C8 | Dock controls | Legible and **unmirrored** | |
| C9 | Audio indicator | Decide: useful, or visual noise? Record the judgement | |
| C10 | Pointer reveal and fade | Reveals when wanted, fades without being asked | |
| C11 | Past-text dimming | Helps rather than distracts | |
| C12 | Reduced-motion setting on | No motion outside script travel | |
| C13 | Safe area | Nothing important inside the bezel's cut | |

## D. Recovery, under pressure

| # | Case | Pass criteria | Result |
|---|---|---|---|
| D1 | Unplug the microphone mid-take | Text holds; the fault is named; an input picker is offered | |
| D2 | Choose another input mid-take | Following resumes | |
| D3 | Hold text and resume | Both work from the dock without ending the take | |
| D4 | Previous / next sentence | Moves exactly one sentence | |
| D5 | Set my place | Anchors where asked | |
| D6 | Disconnect the display mid-take | Take survives or fails safely; says which | |
| D7 | Drag a reader window to another display mid-take | Notice appears saying sizing matches the opening display | |
| D8 | End take | Returns to the editor with the summary over it | |
| D9 | Recover in two interactions or fewer | For D1–D5, count the interactions and record them | |

## E. After the take

| # | Case | Pass criteria | Result |
|---|---|---|---|
| E1 | Healthy take | Summary says it stayed with you; names the ending section | |
| E2 | Take with the microphone muted throughout | Says nothing was transcribed; suggests the microphone | |
| E3 | Take with long ad-libs | Says following needed help; does not blame the presenter | |
| E4 | Retry last section | Starts the next take at that section | |
| E5 | Present again | Starts immediately, with no stale state from the last take | |
| E6 | Take details disclosure | All the original measurements are still there | |

## F. What was not tested

List every section and case skipped, and why. **This section is not optional**
— it is the part that makes the sheet honest, and a release note that says
"tested on real glass" without it is claiming more than was done.

| Area | Why not tested |
|---|---|
| | |

---

## Known gaps this protocol cannot close

- **Windows and Linux**: there is no build. Not applicable rather than untested.
- **Intel Macs**: the release ships a universal binary; if no Intel Mac was
  used, say so here rather than implying coverage.
- **Delivery analysis of any kind**: there is none to test. Live coaching and
  the second model were removed, and no cadence or variety scoring runs in this
  tree. Older specs and README passages still describe them; `CLAUDE.md` is
  explicit that the code is the authority. Do not write a case for a lane that
  does not exist.
- **The reversible dim frontier**: `bench/README.md` records that the gate has
  never opened on the recorded corpus. If you see a provisional dim on a real
  take, that is a new observation and worth recording.
