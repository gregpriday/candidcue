/**
 * Turning this one webview into the teleprompter, and back.
 *
 * ---------------------------------------------------------------------------
 * THIS USED TO BE `getCurrentWindow().setFullscreen(true)`
 * ---------------------------------------------------------------------------
 * One line, and it was the reason every take opened with the script pushed to
 * the bottom of the glass under a white bar. On macOS OS fullscreen is not a
 * resize: it allocates a new Space and animates the window into it. Throughout
 * that animation the webview's painted surface is the old, smaller one, and
 * AppKit fills the strip it does not cover with the window background — white,
 * because nothing had ever set it otherwise.
 *
 * Nothing inside the page can cover that strip. It is not a region the document
 * has been laid out into yet, so a plate, an overlay, a black `<body>` — none
 * of them exist there. The fix has to be that the window never has an unpainted
 * strip in the first place, which means presenting BORDERLESS
 * (`windows/present.rs`, the same way the separate stage window has always
 * presented) and not moving the geometry until the page is already covered.
 *
 * What is left here is the renderer's half: the two commands, and the waits
 * that make "the cover is on screen" and "the window has finished changing
 * size" things a caller can await rather than things it hopes have happened.
 */
import { invokeOrMock } from './ipc';
import type { PresentationMode, ReaderFrame } from './settings-types';

/**
 * Where the window ended up, in the CSS pixels the renderer measures in.
 *
 * Rust divides by the scale factor before answering, so this compares directly
 * against `window.innerWidth`/`innerHeight` on any rig — including the
 * mixed-DPI ones, where doing that arithmetic in two places would eventually
 * disagree with itself.
 */
export interface ControlPresentationState {
  presenting: boolean;
  /**
   * The mode the WINDOW is in, absent when it is not presenting.
   *
   * Read back rather than assumed. The mid-take toggle means a caller's idea of
   * the mode and the window's can come apart — a switch that failed halfway
   * leaves one believing the other — and adopting this answer is what keeps the
   * dock's toggle describing the window somebody is actually looking at.
   */
  mode?: PresentationMode;
  width: number;
  height: number;
  /**
   * The reading window's bounds, whenever this call knew them.
   *
   * The case worth naming is the one on the way OUT: ending a take in reader
   * mode, and switching from reader to prompter, both report the rectangle the
   * window had a moment before it stopped having it. That is the only instant
   * those bounds exist, so it is the only chance to persist them — see
   * `rememberReaderFrame` in the session store.
   *
   * Absent for a prompter, which has no bounds of its own: it fills whichever
   * monitor it was already on.
   */
  readerFrame?: ReaderFrame;
  /**
   * The panel this presentation is on, fingerprinted the way `list_displays`
   * fingerprints it — so it is a key the optical profiles can be looked up
   * under.
   *
   * This is what a take should be calibrated against, and the reason is that
   * `mmPerCssPx` is the whole basis of the angular model. Presenting has always
   * used whichever monitor this window was already on rather than the pinned
   * one, and until Rust reported which that was, `startTake` sized its type
   * from the PIN — so an operator with an external prompter pinned who pressed
   * Present at their laptop got a take measured in the external panel's
   * millimetres, which is a confidently wrong physical size rather than a near
   * miss.
   *
   * Absent when the window is not presenting, when the monitor could not be
   * identified, and in plain-browser dev, where there are no monitors to name.
   * A caller that gets nothing falls back to its own guess, which may well name
   * a panel this answer did not — that is what a guess is, and it is the one
   * takes were composed from before this field existed.
   */
  displayFingerprint?: string;
}

/**
 * Present this window as the teleprompter, in the mode asked for.
 *
 * `prompter` fills the current monitor: borderless, above the menu bar, black
 * behind the webview. The monitor is whichever one the window is already on —
 * the operator drags it to the panel they want and presses Present, and moving
 * it somewhere else on their behalf would be taking the window away from the
 * person driving it.
 *
 * `reader` presents in place and moves no geometry at all, so the viewport is
 * already the size it is going to be and `awaitViewportSettled` matches on its
 * first check. See `windows/present.rs` for what each mode does to the window.
 *
 * `readerFrame` is the exception to "presents in place": a rectangle this reader
 * left behind on an earlier RUN of the app, which the in-process latch cannot
 * remember because it dies with the process. Passing it is what makes a reading
 * window come back where it was rather than at whatever size the editor happened
 * to be. Ignored for `prompter`, which has a monitor to fill instead.
 */
export async function enterPresentation(
  mode: PresentationMode = 'prompter',
  readerFrame?: ReaderFrame | null,
): Promise<ControlPresentationState> {
  return invokeOrMock<ControlPresentationState>(
    'set_control_presenting',
    // Omitted rather than sent as null when there is nothing to restore: the
    // command's argument is optional, and an explicit null would have to be
    // deserialized as one.
    { enabled: true, mode, ...(readerFrame ? { readerFrame } : {}) },
    () => browserViewport(true, mode),
  );
}

/**
 * Put the window back exactly as it was: position, size, titlebar, maximized
 * state, and the OS-default background.
 *
 * Safe to call when no take ever opened — `startTake`'s failure paths call it
 * without knowing how far they got, and Rust plans that case as a no-op.
 */
export async function exitPresentation(): Promise<ControlPresentationState> {
  return invokeOrMock<ControlPresentationState>('set_control_presenting', { enabled: false }, () =>
    browserViewport(false),
  );
}

/**
 * Change mode without ending the take.
 *
 * The same command, and deliberately so: Rust plans this as a `Switch`, which
 * re-applies one mode over the other WITHOUT re-saving the resting frame. A
 * caller that tried to express this as un-present-then-present would lose that
 * frame to the intermediate state and hand the operator a window it could not
 * put back. There is one owner of the latch and this is how you ask it.
 */
export async function switchPresentationMode(
  mode: PresentationMode,
): Promise<ControlPresentationState> {
  return enterPresentation(mode);
}

/**
 * Plain-browser dev has one viewport and no window management, so the honest
 * answer is "you are already the size you are going to be" — which makes the
 * settle wait below resolve on its first check instead of burning its ceiling.
 */
function browserViewport(
  presenting: boolean,
  mode?: PresentationMode,
): ControlPresentationState {
  return {
    presenting,
    ...(presenting && mode ? { mode } : {}),
    width: typeof window === 'undefined' ? 0 : window.innerWidth,
    height: typeof window === 'undefined' ? 0 : window.innerHeight,
  };
}

/**
 * How long a caller will wait for the viewport to become the size Rust says it
 * is.
 *
 * A borderless move is a single synchronous window operation, so this is
 * normally satisfied within a frame or two. The ceiling is for the rig where it
 * is not — a compositor mid-modeset, a display waking up — and it is short
 * because the cost of giving up early is one frame of slightly-wrong layout
 * behind a black cover, while the cost of waiting is the presenter watching
 * nothing happen after pressing Present.
 */
const VIEWPORT_SETTLE_CEILING_MS = 1200;

/** A CSS pixel of slack, for fractional scale factors. */
const VIEWPORT_MATCH_TOLERANCE_PX = 1;

/**
 * Resolve once the viewport actually measures what `state` promised, and has
 * stopped changing.
 *
 * Both halves are needed. Matching alone can be true for a single frame in the
 * middle of a resize sequence; quiescence alone is true BEFORE the resize has
 * started at all, which is precisely the moment a caller would mistake for
 * "done". So: the size has to match, and then a further frame has to pass
 * without it moving again.
 *
 * Resolves rather than rejects on timeout. Everything downstream of this is
 * cosmetic sequencing — the take itself is unaffected by a viewport that
 * settled 40px late — and a rejection here would abandon a session that is
 * otherwise perfectly healthy.
 */
export async function awaitViewportSettled(
  state: ControlPresentationState,
  ceilingMs = VIEWPORT_SETTLE_CEILING_MS,
): Promise<void> {
  if (typeof window === 'undefined' || typeof requestAnimationFrame !== 'function') return;
  if (state.width <= 0 || state.height <= 0) return;

  const matches = (): boolean =>
    Math.abs(window.innerWidth - state.width) <= VIEWPORT_MATCH_TOLERANCE_PX &&
    Math.abs(window.innerHeight - state.height) <= VIEWPORT_MATCH_TOLERANCE_PX;

  await new Promise<void>((resolve) => {
    const done = once(resolve);
    // The ceiling is a TIMER, not a frame count — see `deadline` for why that
    // distinction is the difference between a bounded wait and a hung Present.
    let stopped = false;
    const timer = deadline(ceilingMs, () => {
      stopped = true;
      done();
    });
    let lastW = -1;
    let lastH = -1;
    const tick = () => {
      // The timer may have won. Without this the loop keeps rescheduling itself
      // for the rest of the take — one callback every frame, forever, behind a
      // promise nobody is waiting on any more.
      if (stopped) return;
      if (matches()) {
        // A second IDENTICAL frame, not merely a second matching one: on a
        // fractional scale factor the tolerance above can stay satisfied while
        // the window is still moving through it.
        if (window.innerWidth === lastW && window.innerHeight === lastH) {
          clearTimeout(timer);
          done();
          return;
        }
        lastW = window.innerWidth;
        lastH = window.innerHeight;
      } else {
        lastW = -1;
        lastH = -1;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/**
 * Wrap a resolve so the second and later calls do nothing.
 *
 * Both waits below can be finished by either a frame or a timer, and a promise
 * that has already settled ignores the loser silently — but the frame loop also
 * has to know to stop, and reading that from one flag is clearer than from the
 * promise's own state.
 */
function once(resolve: () => void): () => void {
  let settled = false;
  return () => {
    if (settled) return;
    settled = true;
    resolve();
  };
}

/**
 * The escape hatch for both waits: a `setTimeout` that resolves them whatever
 * the frame loop is doing.
 *
 * This is load-bearing rather than belt-and-braces. `requestAnimationFrame` is
 * not guaranteed to fire at all — a window that is minimised, fully occluded by
 * another app, or on a display that has gone to sleep can stop being rendered,
 * and the callbacks simply stop. A ceiling checked INSIDE an rAF callback is no
 * ceiling at all in exactly that case: the check never runs, the promise never
 * settles, and `startTake` waits forever with `takeStarting` latched true — so
 * Present is dead until the app is restarted. Pressing Present is not a
 * guarantee the window stays visible; an operator can hit it and immediately
 * switch to another app to line something up.
 *
 * `setTimeout` is throttled in a background page but not stopped, so it still
 * arrives. Late is fine. Never is not.
 */
function deadline(ms: number, done: () => void): ReturnType<typeof setTimeout> {
  return setTimeout(done, ms);
}

/**
 * Resolve after the browser has had a chance to paint what was just rendered.
 *
 * Two frames, not one. A `requestAnimationFrame` callback runs BEFORE the paint
 * it is scheduled against, so a single frame proves only that style and layout
 * were computed — which is not the guarantee any caller here wants. The second
 * frame can only run after the first has been presented.
 *
 * This is the entire mechanism behind "do not move the window until the cover
 * is genuinely on screen", so it is worth being exact about.
 *
 * Bounded for the reason `deadline` gives: a window nobody is rendering never
 * delivers a frame, and this sits between pressing Present and anything
 * happening. If the frames do not come, there is also no paint to wait for.
 */
const PAINT_CEILING_MS = 250;

export async function painted(): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') return;
  await new Promise<void>((resolve) => {
    const done = once(resolve);
    const timer = deadline(PAINT_CEILING_MS, done);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        clearTimeout(timer);
        done();
      }),
    );
  });
}
