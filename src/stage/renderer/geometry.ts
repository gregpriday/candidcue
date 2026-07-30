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
import type { LensPlacement, SafeAreaInsets } from '../../shared/contracts/optical';
import {
  DEFAULT_BOTTOM_FADE_LINES,
  DEFAULT_DEAD_ZONE_LINES,
  DEFAULT_FUTURE_RESERVE_LINES,
  DEFAULT_TOP_FADE_LINES,
  OFF_PANEL_READING_BAND_EDGE_FRACTION,
} from '../../shared/optical-resolve';

/* ---------------------------------------------------------------------------
 * The safe rectangle
 * ------------------------------------------------------------------------- */

/** The visible rectangle, in viewport CSS pixels. */
/**
 * How long the viewport has to hold still before the document re-wraps.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS LIVES HERE AND NOT IN `ScriptLayer`, WHICH IS ITS ONLY CONSUMER
 * ---------------------------------------------------------------------------
 * It has a second reader, and the second reader is why the number matters.
 *
 * `ScriptLayer` trails its `vw`/`vh` by this interval so that dragging a reading
 * window's edge coalesces into one relayout instead of sixty. But the mid-take
 * mode switch (`Live.svelte::togglePresentationMode`) also changes the viewport,
 * and it recomposes the document geometry as soon as `awaitViewportSettled`
 * reports the RAW viewport has stopped moving — which at 60 Hz is about 33 ms.
 * Reader geometry is resolved from the trailed value, so recomposing then
 * measures the whole document at the OLD size and has it invalidated ~90 ms
 * later: exactly the two-measurement waste `startTake`'s opening sequence is
 * ordered to avoid, in the middle of a live take and with no cover over it.
 *
 * So the switch waits this out too, and the two have to agree. Duplicating the
 * literal in `Live.svelte` is the version of that which silently stops agreeing.
 *
 * 120 ms is short enough that letting go of an edge and seeing the text re-wrap
 * reads as immediate, and long enough that no frame of a drag gets its own
 * rebuild.
 */
export const VIEWPORT_REFLOW_SETTLE_MS = 120;

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
  /**
   * Where the lens sits relative to the glass. `'above'`/`'below'` widen the
   * safe-rectangle clamp so a band `resolveStageGeometry` pinned near the true
   * edge is not narrowed back to the in-panel 10–90% range. Absent or
   * `'in-panel'` keeps today's behaviour.
   */
  lensPlacement?: LensPlacement;
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
 *
 * An off-panel lens (`lensPlacement` `'above'`/`'below'`) is where the same
 * argument reaches its edge: `resolveStageGeometry` pins the band at
 * `OFF_PANEL_READING_BAND_EDGE_FRACTION`/its complement precisely because
 * there IS no lens inside the rectangle to centre on, and re-narrowing that
 * pin to 10–90% here would undo the one thing the pin was for.
 * `OFF_PANEL_CENTER_RANGE` shares that exact bound rather than opening to the
 * full 0–1 — a centre allowed to land exactly on 0 or 1 would give the
 * corridor a top or bottom margin of zero, and this way it can't.
 */
const VIEWPORT_CENTER_RANGE = { min: 0.2, max: 0.7 } as const;
const SAFE_RECT_CENTER_RANGE = { min: 0.1, max: 0.9 } as const;
const OFF_PANEL_CENTER_RANGE = {
  min: OFF_PANEL_READING_BAND_EDGE_FRACTION,
  max: 1 - OFF_PANEL_READING_BAND_EDGE_FRACTION,
} as const;

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

  const isOffPanel = settings.lensPlacement === 'above' || settings.lensPlacement === 'below';
  const range = usingSafeRect
    ? isOffPanel
      ? OFF_PANEL_CENTER_RANGE
      : SAFE_RECT_CENTER_RANGE
    : VIEWPORT_CENTER_RANGE;
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
  // force — or, for an off-panel lens, pinned near the edge but never exactly
  // on it — so the clamp can never close the corridor to nothing: `halfPx` is
  // floored above, and the rect it is measured against is finite, so the
  // narrowed edge stays strictly inside the opposite one. The one case with no
  // bound at all is a window that has not painted yet (the stage completes its
  // whole handshake hidden); clamping to a zero height there would collapse the
  // corridor and snap on every frame.
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
 * Where a line ENTERS, relative to where the mark is
 * ------------------------------------------------------------------------- */

/**
 * How far BELOW the reading mark a line sits when the presenter starts it
 * (companion §8, §8.8).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT ZERO
 * ---------------------------------------------------------------------------
 * §8's path puts every line-start knot at `R`, and the line then RISES a full
 * pitch while it is being read: at the start of line N its baseline is at `R`,
 * and by the last word of line N the document has advanced one pitch, so `R`
 * now falls on line N+1. That is the line-handoff contract working exactly as
 * specified — the next line is already in position when speech reaches it — and
 * it is correct as MOTION.
 *
 * The defect was treating `R` and the reading mark as the same number. The mark
 * is fixed on the glass and says "you are here"; a line is only AT `R` for the
 * instant it begins. Measured on the rendered map, with `R` set to the mark, the
 * mark sat on the line being read for 15% of that line and on the FOLLOWING line
 * for 60% of it. So the mark systematically pointed one line ahead of the
 * reader, which reads exactly as the script running behind them.
 *
 * The mark cannot move — it is the lens, calibrated to where the presenter's eye
 * rests — so `R` does.
 *
 * What it moves by is one correction, not two. Knots are placed by BASELINE,
 * which is the foot of the letters, so a mark level with the baseline points at
 * the gap under the text rather than at the text. Half a cap height above the
 * baseline is the middle of a capital — and the mark is drawn one cap high with
 * its apex at its own centre, so this is the statement that the mark and the
 * letters share a centre, and share their extent: at line entry the triangle
 * spans exactly the capital.
 *
 * A second term used to sit beside it — a quarter of a pitch, phasing line entry
 * lower so the mark stayed on the line being read for more of that line's
 * traversal. It is gone, and `LINE_ENTRY_PITCH_FRACTION` below records why at
 * length: it cancelled this correction almost exactly, and the average it
 * optimised is not the thing the presenter looks at.
 *
 * The whole document shifts down by this, padding included, so the path itself
 * is untouched: every knot is `baselineY - R` and both terms grow together, so
 * the same spline comes out with the same derivatives and the same velocities.
 * Only the phase between the text and the mark changes, which is the only thing
 * that was wrong.
 *
 * One number does move, and it moves to keep that promise rather than to break
 * it: `maxScrollPx` is `totalHeight - viewportHeight`, and the top padding is
 * part of `totalHeight`, so the ceiling a tail knot is clamped against rises by
 * the offset too. The closing line therefore comes to rest at exactly the
 * viewport position it always did — the document moved down by what the ceiling
 * moved up by. Take the offset out of the padding and leave it in `R` and that
 * cancellation is what you lose.
 */
/**
 * How far below the mark a line ENTERS, as a fraction of the pitch.
 *
 * ZERO, and that is a reversal — it was a quarter. The history is worth keeping
 * because the quarter was not arbitrary, it was measured, and it was still
 * wrong.
 *
 * The measurements it was chosen on, on the rendered map with a realistic ink
 * box, as residency (on the line being read / on the next line) averaged over
 * the traversal of a line:
 *
 *   half a pitch  — the mark leaves the line at 83% of it and NEVER reaches the
 *                   next one before the line ends. Residency 0.79 / 0.00.
 *   a quarter     — it leaves at 61% and is on the next line from 79%.
 *                   Residency 0.61 / 0.21.
 *   none (cap/2)  — it leaves at 41% and is on the next from 59%.
 *                   Residency 0.41 / 0.41.
 *
 * Read as an average over the line, a quarter is plainly the best of the three.
 * Two things are wrong with reading it that way.
 *
 * THE AVERAGE WEIGHTS THE LINE UNIFORMLY AND THE EYE DOES NOT. The ticks sit
 * just outside the column, at the far left and far right. The presenter's eye is
 * next to the left tick at exactly two moments: when they start a line, and when
 * they sweep back to find the next one. In between they are reading words
 * rightward and the mark is peripheral — which is to say the residency average
 * spends most of its weight on the part of the line where nobody is looking at
 * the thing being measured.
 *
 * AND IT UNDID THE CORRECTION ABOVE. `cap / 2` exists to make the mark and the
 * letters share a centre: the tick is drawn one cap high with its apex at its
 * own centre, so at a zero pitch fraction the triangle spans PRECISELY the
 * capital — same centre, same extent. At the shipped 1.32 line height and a 0.7
 * cap ratio, `pitch / 4` is 0.33em and `cap / 2` is 0.35em. The quarter pitch
 * therefore cancelled the cap correction almost exactly and landed the apex on
 * the CAP LINE, pointing at the top of the letters rather than at them. Two
 * corrections, each individually reasoned, silently annihilating each other.
 *
 * At zero the two agree again, and so does one more thing: the opening position
 * (`placeOpeningPosition`) puts the first row's MEASURED ink centre on the mark
 * with no offset at all, so any non-zero fraction here meant the text dropped by
 * that much the moment the aligner took over from the opening. That
 * discontinuity is gone rather than hidden.
 *
 * WHAT THIS GIVES UP, AND WHAT PAYS FOR IT. The quarter pitch was bought with a
 * real complaint — the script feeling permanently one line behind the reader. At
 * zero the mark leaves the line being read at ~41% and is on the line below from
 * ~59%, and that duly came back as "from the start it points below the line".
 *
 * It is not answered by moving this constant, and cannot be: a point has to
 * sweep. The document must advance exactly one pitch per line and the mark is
 * fixed, so the mark's position relative to the line being read travels one full
 * pitch every line and only the PHASE of that travel is available. Every phase
 * buys the middle of a line by selling both of its ends.
 *
 * What answers it is the mark's SHAPE, and `ReadingCue` now carries it: the
 * reading position does not go BELOW the mark — it starts there and rises — so
 * the cue marks the pitch of glass above itself, as a hairline under `ticks` and
 * as the plateau under `wash`. Exact on an ordinary line at every phase of it,
 * where a phase offset is a compromise at all of them; `ReadingCue`'s header
 * enumerates the lines it is short on (paragraph-final, before a visual block,
 * and anything whose knot clamped). So this constant stays at zero and line entry
 * stays exact; if the perception returns, the band is the thing to make louder.
 */
const LINE_ENTRY_PITCH_FRACTION = 0;

export function lineEntryOffsetPx(linePitchPx: number, capHeightPx: number): number {
  const pitch = isPositive(linePitchPx) ? linePitchPx : 0;
  const cap = isPositive(capHeightPx) ? capHeightPx : 0;
  return pitch * LINE_ENTRY_PITCH_FRACTION + cap / 2;
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
  /**
   * The full viewport height, CSS px.
   *
   * Required because the padding lands in a plane that is `inset: 0` and is
   * bounded by `totalHeight - vh`. `safeRect` cannot stand in for it — the
   * bottom inset is not recoverable from a rect — and using the safe rectangle
   * here is exactly the coordinate confusion this field exists to end.
   */
  viewportHeightPx: number;
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
  const safeHeight = isPositive(safeRect.height) ? safeRect.height : 0;
  /*
   * VIEWPORT coordinates, because that is the box these numbers land in.
   *
   * ------------------------------------------------------------------------
   * THE DEFECT THIS REPLACES
   * ------------------------------------------------------------------------
   * This used to read `center - safeTop` and `safeBottom - center`, which is
   * the arithmetic for a scroll plane INSET TO THE SAFE RECTANGLE. Nothing
   * insets it: `.script-layer` is `inset: 0`, the transform is written in
   * viewport pixels, and the scroll bound is `totalHeight - vh` against the
   * full viewport height. So the padding was solved in one coordinate system
   * and consumed in another, and the two only agreed when the safe area was
   * zero on both edges — which is every default profile, every synthetic
   * fixture, and no hooded rig.
   *
   * What a hooded rig got instead: the document short by `vh - safeRect.height`
   * overall, its first line resting `safeRect.y` too high, and — on a script
   * whose height lands near the viewport — a `maxScroll` of zero. That last one
   * is silent all the way down. `buildRenderedLineMap` clamps every knot into
   * `0..maxScroll` and only rejects knots that DECREASE, so an all-zero map is
   * still `valid`; the planner builds; snapshots are accepted and counted; and
   * the controller clamps every target it is handed to the one position it is
   * allowed to occupy. A stage that reports perfect health and cannot move.
   *
   * The safe rectangle still decides where the BAND goes — that is upstream, in
   * `computeReadingBand`, and it is the right place for it. It does not decide
   * how much paper sits above and below the text.
   */
  // Never smaller than the safe rectangle it contains, so a caller that passes
  // a stale or zero height degrades to the old safe-local answer rather than a
  // negative one.
  const viewportHeight = Math.max(safeTop + safeHeight, input.viewportHeightPx);

  return {
    topPx: Math.max(0, center - halfLine),
    bottomPx: Math.max(0, viewportHeight - center - halfLine) + reserveLines * pitch,
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
