/**
 * An iPad over Sidecar: what it is, and everything it will not tell us.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A CHECKLIST AND NOT A CHECK
 * ---------------------------------------------------------------------------
 * An iPad on the far side of Sidecar is a genuinely good prompter — bright,
 * high-contrast, already on the desk — and a genuinely awkward one. Apple's
 * Sidecar can EXTEND the desktop or MIRROR it, and only extend gives the stage
 * a screen of its own. The sidebar and the Touch Bar are painted over the edges
 * of the same panel the script is on. Opening any app on the iPad suspends the
 * session. A wireless link costs latency and battery that a cable does not.
 *
 * Every one of those ruins a take, and almost none of them is detectable from
 * inside the app: macOS hands us a display descriptor — a name, a pixel size, a
 * scale factor — and nothing about how it got there. So this module does not
 * pretend to check anything. It states, in the presenter's terms, what goes
 * wrong and leaves the confirming to the person who can actually see the rig.
 *
 * The one thing worth being firm about is the honesty flag. A checklist item
 * that says "CandidCue has verified this" when it has verified nothing is worse
 * than no checklist at all: it converts a reminder into a false assurance, and
 * the presenter stops looking at the thing that is about to break.
 *
 * Pure logic, and structural rather than typed against the control layer's
 * `DisplayDescriptor`, for the same reason `optical-discovery.ts` is:
 * `shared/` must not depend on `control/`.
 */
import type { SafeAreaInsets } from './contracts/optical';
import type { DisplayShape } from './optical-discovery';

/* ---------------------------------------------------------------------------
 * Recognising the panel
 * ------------------------------------------------------------------------- */

/**
 * Aspect band, long edge over short, that an iPad occupies and a laptop panel
 * does not.
 *
 * The 4:3 iPads land at 1.333, the 11-inch Pro at 1.432 and the Air at 1.439.
 * The upper bound stops just above them ON PURPOSE: an iPad mini is 1.523 and a
 * 13-inch MacBook Air's built-in panel is 1.538, which are too close together to
 * separate from geometry alone. Claiming a mini and being handed a MacBook would
 * put a Sidecar checklist in front of somebody calibrating their own laptop
 * screen, so the mini is simply not claimed — it still matches by name, which is
 * how Sidecar displays usually arrive anyway.
 */
const SIDECAR_MIN_ASPECT = 1.3;
/*
 * 1.46, not 1.45.
 *
 * The 11-inch iPad Pro is 2420x1668 at 2x, an aspect of 1.45084 — over a 1.45
 * bound by eight ten-thousandths. A display that misses this test by that
 * margin loses every Sidecar warning it should have shown, and only when the
 * name is missing or renamed, which is exactly when the geometry test is the
 * one thing left. Bounds set against real hardware want a little air.
 */
const SIDECAR_MAX_ASPECT = 1.46;

/**
 * Logical long edge, in CSS pixels, that Sidecar's modes fall inside.
 *
 * 1080 for a 10.2-inch, 1180 for an Air, 1194 for an 11-inch Pro, 1366 for a
 * 12.9-inch. The ceiling also does useful work on its own: every MacBook panel
 * above the aspect band is wider than 1440 logical pixels.
 */
const SIDECAR_MIN_LONG_EDGE_PX = 960;
const SIDECAR_MAX_LONG_EDGE_PX = 1440;

/**
 * Does this display look like an iPad on the other end of Sidecar?
 *
 * The name is the strong signal — macOS passes the iPad's own name through, so
 * a display called "Greg's iPad Pro" is not a coincidence. Geometry is the
 * fallback for the paths that report no name, and it is deliberately narrow:
 * a Retina panel in portrait or landscape 4:3-ish proportions at tablet size is
 * not something else pretending, whereas a wider band would start catching
 * laptops.
 *
 * "Likely" is the whole contract. Nothing downstream may treat a true here as
 * proof of anything — it decides whether to OFFER a checklist, never whether to
 * assert a fact about the rig.
 */
export function isLikelySidecarDisplay(display: DisplayShape | null | undefined): boolean {
  if (!display) return false;

  const name = (display.name ?? '').toLowerCase();
  if (name.includes('ipad') || name.includes('sidecar')) return true;

  const scaleFactor = display.scaleFactor > 0 ? display.scaleFactor : 1;
  // Sidecar is always a Retina link. A 1x display of any shape is something else.
  if (scaleFactor < 2) return false;

  const width = display.physicalSize.width / scaleFactor;
  const height = display.physicalSize.height / scaleFactor;
  if (!(width > 0) || !(height > 0)) return false;

  // Normalised so a portrait-mounted iPad — a perfectly reasonable way to hang
  // one in a hood — is the same panel as a landscape one.
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  const aspect = long / short;

  return (
    aspect >= SIDECAR_MIN_ASPECT &&
    aspect <= SIDECAR_MAX_ASPECT &&
    long >= SIDECAR_MIN_LONG_EDGE_PX &&
    long <= SIDECAR_MAX_LONG_EDGE_PX
  );
}

/* ---------------------------------------------------------------------------
 * The checklist
 * ------------------------------------------------------------------------- */

export type SidecarCheckId =
  | 'extend-not-mirror'
  | 'wired-link'
  | 'hide-strips'
  | 'stay-on-screen'
  | 'keep-awake'
  | 'silence-notifications'
  | 'steady-brightness';

export interface SidecarCheck {
  id: SidecarCheckId;
  /** What to do, in the imperative. */
  label: string;
  /**
   * What goes wrong if they do not.
   *
   * Written as a consequence rather than a rule. "Enable a Focus" is an
   * instruction nobody weighs; "a banner covers the line you are about to read,
   * and on glass it bounces into the lens" is a thing a presenter can decide
   * about.
   */
  why: string;
  /**
   * Whether CandidCue can confirm this itself. Almost nothing here is.
   *
   * An item with `false` must be rendered as a reminder the presenter ticks,
   * never as a claim about state the app cannot see.
   */
  verifiable: boolean;
  /**
   * What CandidCue would see, and when — null when it would see nothing at all.
   *
   * For the verifiable item this is the evidence. For the rest it is the honest
   * bad news: the one symptom the app can actually report arrives AFTER the take
   * it ruined, which is exactly why the list is worth reading beforehand.
   */
  symptom: string | null;
}

/**
 * Ordered by what makes prompting impossible, then by what interrupts a take,
 * then by what merely degrades one.
 *
 * The first three also want settling BEFORE the rest of calibration runs: the
 * strips move the safe area and the brightness controls move the panel the
 * brightness step is judged on, so measuring first and fixing after means
 * measuring twice.
 */
const SIDECAR_CHECKS: readonly SidecarCheck[] = frozen([
  {
    id: 'extend-not-mirror',
    label: 'Set the iPad to extend the desktop, not mirror it',
    why: 'Mirroring gives the iPad a copy of the Mac’s own screen, so the prompter shows your desktop, your windows and the control window looking back at you — and there is no second screen for the stage to open on. Extending gives it a display of its own.',
    // The one item with real evidence behind it: a mirrored iPad does not
    // arrive as a display in its own right, so a panel that is in the list and
    // can be opened on is already extending.
    verifiable: true,
    symptom:
      'This panel arrived as a display of its own. Mirroring collapses the iPad into the screen it is copying, so a mirror set is one display where extending is two.',
  },
  {
    id: 'wired-link',
    label: 'Run the iPad on a cable if you can',
    why: 'Wireless Sidecar is a radio link: the stage arrives a beat later than it does over a cable, and how much later moves around as the room does. It also drains the iPad for the length of the take, and a prompter that dims itself to save power halfway through a read has turned off as far as you are concerned.',
    verifiable: false,
    symptom: null,
  },
  {
    id: 'hide-strips',
    label: 'Turn off the Sidecar sidebar and the Touch Bar, or calibrate around them',
    why: 'Both strips are drawn over the edges of the same panel the script is on, so the text nearest an edge sits under a row of buttons you are not looking at and cannot read. Turning them off hands the whole panel back; keeping them means the safe area has to exclude them.',
    verifiable: false,
    symptom:
      'The display reports a size, not a shape, so whatever CandidCue is told about this panel includes any strip you can see on it.',
  },
  {
    id: 'stay-on-screen',
    label: 'Leave the iPad on the Sidecar screen for the whole take',
    why: 'Opening an app on the iPad, or swiping home, suspends the Sidecar session. The prompter goes dark mid-sentence and the stage lands back on the Mac, where you are not looking.',
    verifiable: false,
    symptom:
      'CandidCue finds out when the display disappears from under the stage — by which point the take has already been interrupted.',
  },
  {
    id: 'keep-awake',
    label: 'Stop the Mac from sleeping its displays',
    why: 'Reading from a prompter is the one activity that produces no keystrokes and no pointer movement for minutes at a time, so a Mac on its normal settings can decide nobody is there and dim the screen you are reading from. CandidCue does not hold the Mac awake for you.',
    verifiable: false,
    symptom: null,
  },
  {
    id: 'silence-notifications',
    label: 'Put the Mac in a Focus that silences notifications',
    why: 'A banner lands on top of whatever is on the screen it chooses, and on a prompter that means somebody’s message covering the next line at the moment you need it. On glass it is worse than a distraction: the banner is bright, so it also bounces into the lens.',
    verifiable: false,
    symptom: null,
  },
  {
    id: 'steady-brightness',
    label: 'Fix the iPad’s brightness — no auto-brightness, no True Tone, no Night Shift',
    why: 'You are about to set how hot the type burns by looking at the glass. Each of those features moves the panel afterwards — auto-brightness follows the room, True Tone and Night Shift shift its colour as the day goes on — so the level you settled on is not the level you get.',
    verifiable: false,
    symptom: null,
  },
]);

/**
 * Frozen, rather than only typed `readonly`.
 *
 * `readonly` is a promise the compiler keeps and the runtime does not, and every
 * caller shares this one array: a single `.sort()` from a JavaScript caller would
 * reorder the checklist for the whole process, and the item it would push off the
 * top is the only one on the list with anything behind it.
 */
function frozen(checks: SidecarCheck[]): readonly SidecarCheck[] {
  for (const check of checks) Object.freeze(check);
  return Object.freeze(checks);
}

/**
 * The checklist, in order.
 *
 * A function rather than an exported array so the set can later depend on the
 * rig — a cabled iPad has no business being told about battery drain. What it
 * hands back is frozen; a function returning a shared mutable array would
 * protect nothing.
 */
export function sidecarChecklist(): readonly SidecarCheck[] {
  return SIDECAR_CHECKS;
}

/* ---------------------------------------------------------------------------
 * The safe-area starting point
 * ------------------------------------------------------------------------- */

/**
 * Roughly what the two strips cost, in CSS pixels.
 *
 * macOS points and CSS pixels are the same unit here — the stage lays out in
 * CSS pixels and a 2x Sidecar display reports its scale factor honestly — so
 * these can be turned into fractions of a logical viewport directly.
 *
 * Both numbers are approximate and are meant to be. Sidecar's strips are drawn
 * by the iPad, they are not reported to applications, and their size shifts with
 * the iPad's own display scaling. This is where the safe-area step starts, not
 * where it ends.
 */
export const SIDECAR_SIDEBAR_PX = 64;
export const SIDECAR_TOUCH_BAR_PX = 48;

/** Which edges the strips are on, or off entirely. */
export interface SidecarStrips {
  sidebar: 'left' | 'right' | 'off';
  touchBar: 'top' | 'bottom' | 'off';
}

/** Sidecar's own defaults: sidebar on the left, Touch Bar along the bottom. */
export const DEFAULT_SIDECAR_STRIPS: SidecarStrips = { sidebar: 'left', touchBar: 'bottom' };

/**
 * Ceiling on any single inset.
 *
 * Matches the calibration sliders' range. An inset the wizard cannot represent
 * would be shown as 45% and stored as something else, which is the one failure
 * mode a starting point must not have.
 */
const MAX_HINT_FRACTION = 0.45;

export interface SidecarSafeAreaHint {
  /** Fractions of the raw viewport, shaped to seed `OpticalProfile.safeArea`. */
  insets: SafeAreaInsets;
  /** The pixel figures behind the fractions, so the UI can show its working. */
  sidebarPx: number;
  touchBarPx: number;
  /** False when there is nothing to suggest: no viewport, or both strips off. */
  applies: boolean;
}

/**
 * Where to START the safe-area step on a Sidecar panel.
 *
 * Not an assertion. macOS does not tell an application whether the sidebar is
 * showing, nor whether the desktop area it reports already excludes it, so a
 * computed inset here is a first position for the frame the presenter is about
 * to drag on the glass — and if the strips turn out to be excluded already they
 * drag it back to zero and nothing has been lost. What it buys is the two
 * minutes of confusion where the frame starts at the panel edge, the text runs
 * under a row of buttons, and nothing on screen explains why.
 *
 * Fractions are rounded to whole percent because the wizard's sliders are whole
 * percent: a seeded 0.0469 would be DISPLAYED as 5% while a neighbouring slider
 * wrote a true 5%, and the number on screen would stop matching the number in
 * the profile.
 */
export function sidecarSafeAreaHint(
  viewport?: { widthPx: number; heightPx: number } | null,
  strips: Partial<SidecarStrips> = {},
): SidecarSafeAreaHint {
  const sidebar = strips.sidebar ?? DEFAULT_SIDECAR_STRIPS.sidebar;
  const touchBar = strips.touchBar ?? DEFAULT_SIDECAR_STRIPS.touchBar;

  const empty: SidecarSafeAreaHint = {
    insets: { top: 0, right: 0, bottom: 0, left: 0 },
    sidebarPx: SIDECAR_SIDEBAR_PX,
    touchBarPx: SIDECAR_TOUCH_BAR_PX,
    applies: false,
  };

  const width = viewport?.widthPx ?? 0;
  const height = viewport?.heightPx ?? 0;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return empty;
  if (sidebar === 'off' && touchBar === 'off') return empty;

  const across = wholePercent(SIDECAR_SIDEBAR_PX / width);
  const down = wholePercent(SIDECAR_TOUCH_BAR_PX / height);

  return {
    insets: {
      top: touchBar === 'top' ? down : 0,
      right: sidebar === 'right' ? across : 0,
      bottom: touchBar === 'bottom' ? down : 0,
      left: sidebar === 'left' ? across : 0,
    },
    sidebarPx: SIDECAR_SIDEBAR_PX,
    touchBarPx: SIDECAR_TOUCH_BAR_PX,
    applies: true,
  };
}

/** A fraction the wizard's whole-percent sliders can hold exactly. */
function wholePercent(fraction: number): number {
  const clamped = Math.min(MAX_HINT_FRACTION, Math.max(0, fraction));
  return Math.round(clamped * 100) / 100;
}
