/**
 * Reading geometry: the corridor, the safe rectangle, and everything the stage
 * pads, fades and centres against.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NO LONGER IN PERCENTAGES
 * ---------------------------------------------------------------------------
 * Every number in here used to be a fraction of the viewport: a band 4% of the
 * height on each side, 38/55 `vh` of column padding, a 16 `vh` fade, and a
 * `<= 700px` breakpoint that switched all of them to a second set. On the two
 * panels CandidCue actually runs on that produced two different instruments. A
 * 4% half-band is 24px against an ~85px line on a 1024x600 Prompter — barely a
 * quarter of a line, so the display corrects constantly — and 43px against the
 * same line on a 1920x1080 panel, so it corrects half as often. Same setting,
 * different behaviour, and no way for the presenter to know which one they had.
 *
 * The unit that means the same thing on both is the LINE PITCH, which the stage
 * measures from its own rendered layout. A corridor of 0.84 line pitches is
 * "hold still while the reader is on this line" on every panel there is, and a
 * fade of 1.25 line pitches always covers the same amount of receding script.
 * `resolveStageGeometry` decides those multiples once, in line units; this
 * module multiplies them by the measured pitch and does the arithmetic.
 *
 * The second half of the change is the SAFE RECTANGLE. A hood or an iPad
 * housing reveals less than the whole panel, so a band placed against the
 * window can land behind the bezel. Everything here is measured against the
 * visible rectangle instead, and the column is centred on the LENS inside it
 * rather than on the display — a camera mounted off-centre otherwise pulls the
 * presenter's gaze sideways by exactly the offset nobody compensated for.
 *
 * Coordinate model, unchanged: "document space" has y = 0 at the top of the
 * scroll plane content (including its top padding). The plane is translated by
 * -scrollY, so a document y appears on screen at `y - scrollY`. Viewport-space
 * inputs here (`bandCenterPx`, the safe rectangle) are in the window's own
 * coordinates, so a plane inset to the safe rectangle sits at `safeRect.y`.
 *
 * Pure logic — all units are logical (CSS) pixels unless noted.
 */
import type { SafeAreaInsets } from '../../shared/contracts/optical';
import {
  DEFAULT_BOTTOM_FADE_LINES,
  DEFAULT_DEAD_ZONE_LINES,
  DEFAULT_FUTURE_RESERVE_LINES,
  DEFAULT_TOP_FADE_LINES,
} from '../../shared/optical-resolve';

/* ---------------------------------------------------------------------------
 * The safe rectangle
 * ------------------------------------------------------------------------- */

/** The visible rectangle, in viewport CSS pixels. */
export interface SafeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The largest inset a single edge may claim.
 *
 * Deliberately the same 0.45 `resolveStageGeometry`'s `normalizeSafeArea` uses,
 * and for the same reason: the insets are dragged by hand against a reflection,
 * and a slip that makes opposite edges sum past 1 would give a negative width
 * and take the whole layout with it. Clamped rather than rejected — the
 * presenter is mid-calibration, and a stage that goes blank while they drag is
 * not debuggable. Resolved optics arrive already normalized; this repeats the
 * clamp because the raw profile also reaches the stage during calibration.
 */
const MAX_SAFE_AREA_INSET = 0.45;

/**
 * The rectangle the presenter can actually see, from fractional edge insets.
 *
 * Absent or unusable insets mean "the whole display is visible", which is the
 * correct assumption for a bare monitor and the default until somebody has
 * dragged a safe area against their own glass.
 */
export function computeSafeRect(
  viewportWidthPx: number,
  viewportHeightPx: number,
  insets?: Partial<SafeAreaInsets> | null,
): SafeRect {
  const width = isPositive(viewportWidthPx) ? viewportWidthPx : 0;
  const height = isPositive(viewportHeightPx) ? viewportHeightPx : 0;
  const top = insetFraction(insets?.top);
  const right = insetFraction(insets?.right);
  const bottom = insetFraction(insets?.bottom);
  const left = insetFraction(insets?.left);
  return {
    x: width * left,
    y: height * top,
    width: Math.max(0, width * (1 - left - right)),
    height: Math.max(0, height * (1 - top - bottom)),
  };
}

function insetFraction(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return clamp(value, 0, MAX_SAFE_AREA_INSET);
}

/* ---------------------------------------------------------------------------
 * The reading corridor
 * ------------------------------------------------------------------------- */

export interface ReadingBandSettings {
  /**
   * Band centre as a percent of the height it is measured against — the safe
   * rectangle when one is supplied, the raw viewport otherwise (default 38).
   */
  centerPercent: number;
  /**
   * Band half-height as a percent of viewport height (default 4). Used only on
   * the uncalibrated path, where no line pitch has been measured yet.
   */
  halfHeightPercent: number;
  /**
   * The measured line pitch, CSS px. Its presence is what switches the corridor
   * from a viewport fraction to line units; `halfHeightPercent` is then ignored.
   */
  linePitchPx?: number;
  /** Total corridor height in line pitches (default {@link DEFAULT_DEAD_ZONE_LINES}). */
  deadZoneLines?: number;
  /** The visible rectangle the centre fraction is measured against. */
  safeRect?: SafeRect;
}

export interface ReadingBand {
  centerPx: number;
  topPx: number;
  bottomPx: number;
}

/**
 * The centre fractions each path will accept.
 *
 * The viewport path keeps the historical 20–70%, which is what an uncalibrated
 * rig has always had. The safe-rectangle path honours the wider 10–90% that
 * `resolveStageGeometry` already clamps `readingBandY` to, because on a
 * calibrated rig that number is not a taste setting — it is where the camera
 * physically is. Narrowing it back to 20% would move the text off the lens,
 * which is the exact fault the optical model exists to remove.
 */
const VIEWPORT_CENTER_RANGE = { min: 0.2, max: 0.7 } as const;
const SAFE_RECT_CENTER_RANGE = { min: 0.1, max: 0.9 } as const;

/**
 * Where the band sits when the caller has not said usefully.
 *
 * Falling back to the low end of whichever clamp is in force would park the
 * reading line at the very top of the glass — the most hostile answer available,
 * reached by exactly the inputs least likely to have been checked (a settings
 * document Rust stores opaquely and validates only for `schemaVersion`). 38% is
 * the position the rest of the app documents as the default, so an unusable
 * number lands where a missing one always has.
 */
const DEFAULT_CENTER_FRACTION = 0.38;

/**
 * The corridor the reading position may drift within before the stage corrects.
 *
 * Two paths, and the percentage one is not legacy debt: it is what a rig with no
 * measured line pitch gets, and the motion path calls this function on every
 * fallback frame. It must therefore be total — a degenerate band (top === bottom,
 * or a NaN edge) would make `bandCorrection`'s dead-zone test false on every
 * frame and turn the smooth follow into a per-frame snap.
 */
export function computeReadingBand(
  viewportHeightPx: number,
  settings: ReadingBandSettings,
): ReadingBand {
  const height = isPositive(viewportHeightPx) ? viewportHeightPx : 0;
  const safeRect = settings.safeRect;
  const usingSafeRect = safeRect != null && isPositive(safeRect.height);
  // Guarded the same way the padding and column solvers guard it. A single
  // non-finite edge would otherwise reach `centerPx` and hand the motion path a
  // NaN band, which is the one thing this function promises not to produce.
  const safeTop = usingSafeRect && isPositive(safeRect.y) ? safeRect.y : 0;

  const range = usingSafeRect ? SAFE_RECT_CENTER_RANGE : VIEWPORT_CENTER_RANGE;
  const centerFraction = clamp(
    Number.isFinite(settings.centerPercent)
      ? settings.centerPercent / 100
      : DEFAULT_CENTER_FRACTION,
    range.min,
    range.max,
  );
  const centerPx = usingSafeRect
    ? safeTop + safeRect.height * centerFraction
    : height * centerFraction;

  const pitch = settings.linePitchPx;
  let halfPx: number;
  if (isPositive(pitch)) {
    // Zero takes the default here, unlike the fades below where zero means "off".
    // A corridor of no height is not a request anybody can mean — it asks the
    // stage to correct on every frame — so it is read as an unset value instead.
    const lines = isPositive(settings.deadZoneLines)
      ? settings.deadZoneLines
      : DEFAULT_DEAD_ZONE_LINES;
    halfPx = (pitch * lines) / 2;
  } else {
    const percent = Number.isFinite(settings.halfHeightPercent) ? settings.halfHeightPercent : 4;
    halfPx = height * (clamp(percent, 2, 12) / 100);
  }
  // A corridor thinner than a pixel is a corridor the reading position cannot
  // sit inside, so the dead zone would never hold and every frame would correct.
  halfPx = Math.max(1, halfPx);

  // The corridor is bounded by what the presenter can SEE, not by the window.
  // A band low in a hooded safe area otherwise runs its bottom edge behind the
  // bezel, and the dead zone then holds the display still while the line being
  // read is hidden — the corridor would be vouching for pixels nobody has. The
  // clamp only ever narrows, and `bandCorrection` re-centres on `centerPx`
  // either way, so a narrowed edge cannot make the follow oscillate.
  //
  // The centre is at least a tenth of the way inside whichever bound is in
  // force, so the clamp can never close the corridor to nothing. The one case
  // with no bound at all is a window that has not painted yet (the stage
  // completes its whole handshake hidden); clamping to a zero height there would
  // collapse the corridor and snap on every frame.
  const limitTop = usingSafeRect ? safeTop : 0;
  const limitBottom = usingSafeRect ? safeTop + safeRect.height : height;
  const bounded = limitBottom > limitTop;
  return {
    centerPx,
    topPx: Math.max(limitTop, centerPx - halfPx),
    bottomPx: bounded ? Math.min(limitBottom, centerPx + halfPx) : centerPx + halfPx,
  };
}

/**
 * Dead-zone check + correction (spec §16.3): while the target token's center
 * remains inside the band, do not scroll (returns null). Once it leaves,
 * return the scrollY that puts the token center back at the band center.
 */
export function bandCorrection(
  tokenTopDocPx: number,
  tokenHeightPx: number,
  scrollY: number,
  band: ReadingBand,
): number | null {
  const centerDoc = tokenTopDocPx + tokenHeightPx / 2;
  const viewportY = centerDoc - scrollY;
  if (viewportY >= band.topPx && viewportY <= band.bottomPx) {
    return null;
  }
  return centerDoc - band.centerPx;
}

/** ScrollY that centers a document-space y on the band center. */
export function scrollTargetFor(centerDocPx: number, band: ReadingBand): number {
  return centerDocPx - band.centerPx;
}

/**
 * Provisional matches may not trigger large movement (spec §16.4): clamp the
 * correction distance to maxCorrectionPx around the current position.
 */
export function clampProvisionalTarget(
  currentScrollY: number,
  targetScrollY: number,
  maxCorrectionPx: number,
): number {
  const delta = targetScrollY - currentScrollY;
  if (Math.abs(delta) <= maxCorrectionPx) return targetScrollY;
  return currentScrollY + Math.sign(delta) * maxCorrectionPx;
}

/* ---------------------------------------------------------------------------
 * Column padding
 * ------------------------------------------------------------------------- */

export interface StagePaddingPx {
  topPx: number;
  bottomPx: number;
}

/**
 * The three resolved facts every vertical question is answered from: what the
 * presenter can see, where the corridor sits inside it, and how tall a line is.
 * Shared by the padding solver and the line budget so the two can never be
 * solved against different geometry.
 */
export interface BandGeometryInput {
  /** The visible rectangle the scroll plane is laid out inside. */
  safeRect: SafeRect;
  /** Band centre in viewport space, from {@link computeReadingBand}. */
  bandCenterPx: number;
  /** The measured line pitch, CSS px. */
  linePitchPx: number;
  /** Upcoming script kept below the band (default {@link DEFAULT_FUTURE_RESERVE_LINES}). */
  futureReserveLines?: number;
}

/**
 * Blank space above the first line and below the last, derived rather than set.
 *
 * These were 38 and 55 `vh`, hand-tuned per breakpoint, and the pair did not
 * agree with each other. With the band at 38% the last line needs 62% below it
 * to travel up to the corridor; 38 + 55 leaves the plane 7 `vh` short, so at
 * maximum scroll the closing line stops `0.07 x vh - pitch/2` below the band
 * centre — about 35px on a 1080 panel at an 82px line. That fell inside the old
 * ±4 `vh` dead zone, which is why it shipped, but only just, and the margin
 * shrinks with every increase in type size. The compact table (34 and 60) landed
 * 5px on the other side of the same line: two tables, one question, opposite
 * answers, and no way to tell which one you had.
 *
 * So both edges are solved instead of chosen:
 *
 *   top    — at scrollY 0 the first line's centre sits at `safeRect.y + top +
 *            pitch/2`. Setting that equal to the band centre is the whole
 *            derivation, and it makes the opening word reachable without the
 *            plane ever needing a negative scroll offset.
 *   bottom — at max scroll the last line's centre sits at `safeRect.bottom -
 *            bottom - pitch/2`. The same equation, from the other end.
 *
 * The future reserve is added on top of the bottom solution, not folded into it.
 * It is run-out: the reader who ad-libs past the final full stop, or an aligner
 * that overshoots the last token, still has somewhere to go, so the script eases
 * to a halt instead of hitting a wall mid-sentence. Nothing targets that extra
 * travel — it only widens the clamp — so the cost of carrying it is nil.
 */
export function stagePaddingPx(input: BandGeometryInput): StagePaddingPx {
  const { safeRect, bandCenterPx } = input;
  const pitch = isPositive(input.linePitchPx) ? input.linePitchPx : 0;
  const halfLine = pitch / 2;
  const reserveLines =
    typeof input.futureReserveLines === 'number' && Number.isFinite(input.futureReserveLines)
      ? Math.max(0, input.futureReserveLines)
      : DEFAULT_FUTURE_RESERVE_LINES;
  const center = Number.isFinite(bandCenterPx) ? bandCenterPx : 0;
  const safeTop = Number.isFinite(safeRect.y) ? safeRect.y : 0;
  const safeBottom = safeTop + (isPositive(safeRect.height) ? safeRect.height : 0);

  return {
    topPx: Math.max(0, center - safeTop - halfLine),
    bottomPx: Math.max(0, safeBottom - center - halfLine) + reserveLines * pitch,
  };
}

/* ---------------------------------------------------------------------------
 * Focus fades
 * ------------------------------------------------------------------------- */

export interface FadeDepthPx {
  topPx: number;
  bottomPx: number;
}

/**
 * Depth of the top and bottom focus fades.
 *
 * Asymmetric on purpose (see `DEFAULT_TOP_FADE_LINES`): material above the band
 * has been spoken and is receding, while material below it is about to be needed
 * and must stay readable for as long as possible. There was no asymmetry before
 * — one `vh` depth drove both edges, so the upcoming script was buried exactly
 * as deep as the script already delivered. And because it was a `vh`, the same
 * setting bought different things: 16 `vh` against an 82px line is 2.1 lines of
 * fade on a 1080 panel and the compact branch's 10 `vh` is 0.7 of one on a 600px
 * Prompter, so the rig with the most script to spare hid the most of it.
 */
export function fadeDepthPx(
  linePitchPx: number,
  options?: { topLines?: number; bottomLines?: number },
): FadeDepthPx {
  const pitch = isPositive(linePitchPx) ? linePitchPx : 0;
  return {
    topPx: pitch * fadeLines(options?.topLines, DEFAULT_TOP_FADE_LINES),
    bottomPx: pitch * fadeLines(options?.bottomLines, DEFAULT_BOTTOM_FADE_LINES),
  };
}

/** Zero is a legitimate request (fades off); anything unusable takes the default. */
function fadeLines(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  return value;
}

/* ---------------------------------------------------------------------------
 * Column placement
 * ------------------------------------------------------------------------- */

export interface ColumnPlacementInput {
  safeRect: SafeRect;
  columnWidthPx: number;
  /** Lens position as a fraction of the safe rectangle's width. */
  opticalCenterX: number;
}

/**
 * Left edge of the text column, centred on the LENS rather than on the display.
 *
 * `margin: 0 auto` centres on the panel, which is only correct when the camera
 * happens to sit in the middle of the hood. When it does not, the presenter
 * reads with their eyes parked a fixed distance to one side of the lens for the
 * whole take — a squint that is invisible on the prompter and obvious in the
 * footage. The offset is known (it is measured during calibration), so it is
 * simply applied.
 *
 * Clamped into the safe rectangle regardless: a lens near an edge would
 * otherwise push half the column behind the bezel, and text nobody can see is a
 * worse failure than a column a few degrees off the lens.
 */
export function columnLeftPx(input: ColumnPlacementInput): number {
  const { safeRect } = input;
  const safeX = Number.isFinite(safeRect.x) ? safeRect.x : 0;
  const safeWidth = isPositive(safeRect.width) ? safeRect.width : 0;
  const columnWidth = isPositive(input.columnWidthPx) ? input.columnWidthPx : 0;
  const fraction = Number.isFinite(input.opticalCenterX) ? clamp(input.opticalCenterX, 0, 1) : 0.5;

  const maxLeft = safeX + safeWidth - columnWidth;
  // A column wider than the rectangle cannot be clamped inside it. Spilling
  // evenly keeps the reading measure centred on the safe area rather than
  // hiding one whole margin behind the near bezel.
  if (maxLeft <= safeX) return safeX + (safeWidth - columnWidth) / 2;

  return clamp(safeX + safeWidth * fraction - columnWidth / 2, safeX, maxLeft);
}

/* ---------------------------------------------------------------------------
 * How much script actually fits
 * ------------------------------------------------------------------------- */

/**
 * The real question the `<= 700px` breakpoint was standing in for.
 *
 * A viewport being short does not make it a compact display — a short viewport
 * with small type shows more lines than a tall one with large type, and after
 * calibration the type size is decided by viewing distance rather than by the
 * panel. So nothing branches on the panel any more; what the stage needs to know
 * is how many line pitches fit in the rectangle the presenter can see.
 *
 * Whole lines only. Half a line at the bottom edge of the glass is not a line
 * the reader can use, and counting it would let a rig report a budget it cannot
 * deliver.
 */
export function usableLines(safeRectHeightPx: number, linePitchPx: number): number {
  if (!isPositive(safeRectHeightPx) || !isPositive(linePitchPx)) return 0;
  return Math.floor(safeRectHeightPx / linePitchPx);
}

/**
 * Lines above the band the reader needs for context — the sentence just spoken.
 * One is the floor; two is comfortable.
 */
export const TARGET_LINES_ABOVE_BAND = 1;

/**
 * Lines below the band, i.e. the future reserve: roughly 2.5–3.5 seconds of
 * speech, which is how far ahead a reader's eye actually runs.
 */
export const TARGET_LINES_BELOW_BAND = DEFAULT_FUTURE_RESERVE_LINES;

/** Context, the line being spoken, and the reserve: five useful lines, six is better. */
export const TARGET_VISIBLE_LINES = TARGET_LINES_ABOVE_BAND + 1 + TARGET_LINES_BELOW_BAND;

export interface LineBudget {
  /** Whole lines that fit between the top of the safe rectangle and the band. */
  above: number;
  /** Whole lines that fit between the band and the bottom of the safe rectangle. */
  below: number;
  /** `above` + the line being read + `below`. */
  total: number;
  /** Every target met: context above, the reserve below, and the total. */
  sufficient: boolean;
  /** One sentence naming what is short, addressed to the operator. */
  advice: string;
}

/**
 * Does this resolved geometry actually show the reader enough script?
 *
 * Reported rather than enforced. Nothing here changes what is drawn — the type
 * size comes from the viewing distance and the band from the lens, and silently
 * overriding either to hit a line count would trade a legible display for a
 * fuller one. What the operator gets is the honest number, in the diagnostics,
 * while there is still time to move the camera or step closer.
 */
export function lineBudget(input: BandGeometryInput): LineBudget {
  const { safeRect, bandCenterPx } = input;
  const pitch = input.linePitchPx;
  if (!isPositive(pitch) || !isPositive(safeRect.height)) {
    return {
      above: 0,
      below: 0,
      total: 0,
      sufficient: false,
      advice: 'The stage has not measured a line pitch yet, so it cannot say how much script fits.',
    };
  }

  const reserve =
    typeof input.futureReserveLines === 'number' && Number.isFinite(input.futureReserveLines)
      ? Math.max(0, input.futureReserveLines)
      : TARGET_LINES_BELOW_BAND;
  const halfLine = pitch / 2;
  const safeTop = Number.isFinite(safeRect.y) ? safeRect.y : 0;
  const center = Number.isFinite(bandCenterPx) ? bandCenterPx : safeTop;
  const above = Math.max(0, Math.floor((center - safeTop - halfLine) / pitch));
  const below = Math.max(0, Math.floor((safeTop + safeRect.height - center - halfLine) / pitch));
  const total = above + 1 + below;

  // Ordered by what actually breaks a read. Running out of script below the band
  // is the failure the presenter feels — they reach the bottom of what they can
  // see and stop — so it is reported first even when the top is also short.
  let advice = '';
  if (below < reserve) {
    advice = `This rig shows about ${below} line${below === 1 ? '' : 's'} of upcoming script below the reading band, and a reader needs ${reserve}. Smaller text, a taller safe area, or a reading band placed higher would buy it back.`;
  } else if (above < TARGET_LINES_ABOVE_BAND) {
    advice =
      'There is no room above the reading band for the line just spoken, so the script will appear to start at the top of the glass. Moving the reading band down would give it context.';
  } else if (total < TARGET_VISIBLE_LINES) {
    advice = `This rig shows about ${total} lines at once, fewer than the ${TARGET_VISIBLE_LINES} a comfortable read wants. Smaller text or a larger prompter would show more.`;
  }

  return {
    above,
    below,
    total,
    sufficient: advice === '',
    advice,
  };
}

/* ---------------------------------------------------------------------------
 * Media
 * ------------------------------------------------------------------------- */

/** Fraction of the VISIBLE height an inline image may claim (spec §16.8). */
export const IMAGE_MAX_SAFE_FRACTION = 0.78;

/**
 * Max image height, still as a `vh` number because that is what the CSS custom
 * property takes — but derived from the safe rectangle rather than from a
 * breakpoint.
 *
 * The old compact branch dropped 78 to 70 on a short panel, which was a proxy
 * for "leave room for a line of script". Measuring the visible rectangle says
 * the same thing directly and also covers the case the breakpoint could not see:
 * a full-height 1080p panel behind a hood that reveals two thirds of it.
 */
export function imageMaxHeightVh(safeRect: SafeRect, viewportHeightPx: number): number {
  if (!isPositive(viewportHeightPx) || !isPositive(safeRect.height)) {
    return IMAGE_MAX_SAFE_FRACTION * 100;
  }
  const visibleFraction = Math.min(1, safeRect.height / viewportHeightPx);
  return IMAGE_MAX_SAFE_FRACTION * visibleFraction * 100;
}

/* ---------------------------------------------------------------------------
 * Small helpers
 * ------------------------------------------------------------------------- */

function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Deliberately NOT the finite-guarding `clamp` from `optics.ts`. This one is on
 * the motion path — it bounds every scroll target the fallback produces — and
 * changing what it does with a NaN would change motion behaviour in a module
 * whose job today is layout.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
