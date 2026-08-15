/**
 * Movement classification for the fallback, snapshot-driven motion path.
 *
 * All stage motion runs through the single persistent
 * `JerkLimitedScrollController` (src/stage/motion). What lives here is the
 * classification of an accepted discontinuity into how the correction should be
 * *spent* — follow it, catch up, or re-anchor — which the renderer hands to
 * that controller as a disposition.
 *
 * Both bounds below are stated twice, in lines and in viewport heights, and the
 * narrower one wins. Lines because what a presenter absorbs is READING — two
 * lines is two lines whether the pitch is 50 px or 250 px. Viewport heights
 * because a correction that sweeps the whole glass is disruptive regardless of
 * how tall a line happens to be on this rig, and at a calibrated 300 px pitch a
 * purely line-relative answer is exactly that sweep.
 *
 * Pure logic.
 */
import {
  ALIGNMENT_RELOCATIONS,
  resolveLineLimitPx,
  type AlignmentDecision,
} from '../../shared/contracts';

/**
 * How far weak evidence may move the document, when no pitch has been measured.
 *
 * Kept as the fallback rather than deleted: the fallback path runs at exactly
 * the moments the rendered line map is unresolved, which is also when there is
 * no measured pitch to reason with. Prefer `provisionalMaxCorrectionPx()`.
 */
export const PROVISIONAL_MAX_CORRECTION_PX = 180;

/**
 * The same bound in the unit the presenter reads in.
 *
 * Two rendered lines is a correction somebody can absorb without losing their
 * place — which is the whole claim being made, and it is a claim about lines.
 * 180 px was that claim at a ~85 px pitch and silently became three and a half
 * lines on a 9-inch panel and less than one on a 15.6-inch one at close range,
 * so the identical setting let weak evidence move the document a paragraph on
 * one rig and nothing at all on another.
 *
 * 180 px is 2.13 lines at that pitch, so two rounds it DOWN — which is the only
 * direction to round a cap on what weak evidence may do. The reference rig comes
 * out 11 px tighter than it is today rather than anywhere looser.
 */
export const PROVISIONAL_MAX_CORRECTION_LINES = 2;

/**
 * And the viewport ceiling those two lines are met by.
 *
 * A third of the glass is already a large move to make on evidence the engine
 * has explicitly declined to act on. At a 300 px pitch two lines is 600 px —
 * the whole of a 9-inch panel — so without this the line-relative answer would
 * license weak evidence to replace the entire visible script, which is the one
 * thing §16.4 exists to prevent.
 */
export const PROVISIONAL_MAX_CORRECTION_VIEWPORT_FRACTION = 1 / 3;

/** Explicit jumps within ~2 viewport heights catch up instead of re-anchoring. */
export const SMOOTH_JUMP_VIEWPORT_FACTOR = 2;

/**
 * The same threshold in lines, for when the pitch is known.
 *
 * Two viewport heights is about 25 rendered lines on the 1080p stage the factor
 * was chosen against, and about 14 on a 600px panel — so "how big a jump is
 * worth travelling smoothly" changed by nearly half between the two displays
 * CandidCue is actually used on, for reasons that have nothing to do with the
 * jump. What decides it is how much READING the presenter is being carried
 * across, so lines are the unit.
 *
 * 24 rather than the 25.6 that reference stage actually measures, because this
 * is the boundary BELOW which a relocation is travelled instead of faded, and a
 * jump travelled that should have been obscured is the one the presenter loses
 * their place in. The rounding goes toward the fade.
 */
export const SMOOTH_JUMP_MAX_LINES = 24;

export type TransitionClass =
  | 'spring'
  | 'smooth_rewind'
  | 'smooth_jump'
  | 'fade_jump'
  | 'instant';

/**
 * A bound stated in lines, met by the bound the panel sets (§30).
 *
 * `resolveLineLimitPx` already refuses an implausible pitch by clamping the
 * line-relative answer into a band around the pixel default, which catches a
 * font that never loaded. It cannot catch a pitch that is entirely real and
 * simply large: 300 px is a legitimate 15.6-inch-at-arm's-length calibration,
 * three lines of it is most of a 1080 px stage, and no clamp expressed against
 * the pixel default knows how tall the glass is. So the viewport says too.
 */
function lineBoundAgainstViewport(
  lines: number,
  fallbackPx: number,
  linePitchPx: number | null | undefined,
  viewportHeightPx: number | null | undefined,
  viewportFraction: number,
): number {
  const resolved = resolveLineLimitPx(lines, fallbackPx, linePitchPx);
  if (
    typeof viewportHeightPx !== 'number' ||
    !Number.isFinite(viewportHeightPx) ||
    viewportHeightPx <= 0
  ) {
    return resolved;
  }
  return Math.min(resolved, viewportHeightPx * viewportFraction);
}

/**
 * The cap on a correction made from weak evidence (§16.4), at a measured pitch.
 *
 * Falls back to `PROVISIONAL_MAX_CORRECTION_PX` for an absent or unusable pitch,
 * and a pitch far outside the plausible band only moves the answer as far as
 * `resolveLineLimitPx` allows — a font that never loaded must not be able to
 * license a screen-sized correction on evidence the engine has already refused
 * to act on.
 *
 * `viewportHeightPx` is optional and is the second half of the same sentence:
 * supply it and two lines can never also mean most of the glass. A caller that
 * omits it gets the line-or-pixel answer alone, which is what every caller got
 * before the ceiling existed.
 */
export function provisionalMaxCorrectionPx(
  linePitchPx?: number | null,
  viewportHeightPx?: number | null,
): number {
  return lineBoundAgainstViewport(
    PROVISIONAL_MAX_CORRECTION_LINES,
    PROVISIONAL_MAX_CORRECTION_PX,
    linePitchPx,
    viewportHeightPx,
    PROVISIONAL_MAX_CORRECTION_VIEWPORT_FRACTION,
  );
}

/**
 * Visual disposition of a snapshot-driven correction (spec §32.3, companion
 * A.3): ordinary following is simply followed; an accepted discontinuity
 * catches up when it is close and re-anchors when it is far. Reduced motion
 * repositions without an easing spectacle (§32.4).
 *
 * `linePitchPx` is optional because this is the path that runs when the line map
 * is not available; without it the viewport-relative threshold stands, which is
 * the behaviour every existing caller has.
 */
export function classifyTransition(opts: {
  decision: AlignmentDecision;
  distancePx: number;
  viewportHeightPx: number;
  reducedMotion: boolean;
  linePitchPx?: number | null;
}): TransitionClass {
  if (opts.reducedMotion) return 'instant';
  /*
   * §30.5. An accepted retake is a walk at every distance, and the branch below
   * never sees it.
   *
   * The threshold under this one asks "is this correction small enough to be
   * worth showing?", which is the right question for a FORWARD jump: the text
   * being flown past is not being spoken, so travelling it is a spectacle and
   * the fade is a mercy. A retake inverts every term. The presenter is reading
   * the destination out loud right now, they know what it says, and the script
   * returning to meet them is the information rather than the wrapper around
   * it — so the further back it is, the more they need to SEE it happen, and
   * the worse a cut serves them. Distance changes how long the walk takes and
   * nothing else.
   *
   * Placed before the generic branch rather than inside it so that no future
   * change to the fade threshold can quietly recapture retakes.
   */
  if (opts.decision === 'retakeAccepted') return 'smooth_rewind';
  if (ALIGNMENT_RELOCATIONS.has(opts.decision)) {
    /*
     * This threshold decides whether a correction is SHOWN travelling or hidden
     * behind the fade, so it is the one place a line-relative answer may only
     * ever narrow the viewport-relative one.
     *
     * `resolveLineLimitPx` clamps into a 0.5x-3x band around the figure it is
     * given, which is right for a limit where both directions are survivable —
     * and wrong here. Three times two viewport heights is SIX SCREENS: at a
     * 600px stage with a 150px pitch, a 2,000px correction (three and a third
     * screens) came out `smooth_jump`, and the presenter watched the whole
     * document fly across the glass. That is precisely the teleport §20.4
     * introduced the fade to hide, and the failure asymmetry is not symmetric:
     * an unnecessary fade costs 220ms of dimmed text, while a visible flight
     * across the glass costs the reader their place mid-sentence.
     *
     * So the two bounds are combined with `min`, not with a band. Large type
     * can make the stage more willing to fade; nothing can make it less.
     */
    const viewportLimitPx = SMOOTH_JUMP_VIEWPORT_FACTOR * opts.viewportHeightPx;
    const lineLimitPx = resolveLineLimitPx(
      SMOOTH_JUMP_MAX_LINES,
      viewportLimitPx,
      opts.linePitchPx,
    );
    const limit = Math.min(lineLimitPx, viewportLimitPx);
    return opts.distancePx <= limit ? 'smooth_jump' : 'fade_jump';
  }
  return 'spring';
}

/* ---------------------------------------------------------------------------
 * Was that gesture a move, or a look? (§16.9)
 * ------------------------------------------------------------------------- */

/**
 * How far from the aligner's position counts as having MOVED, in viewports.
 *
 * The question this stands in for is "can the presenter still see the place the
 * aligner thinks they are". If they can, the sensible reading of a scroll is
 * that they glanced at something — the next paragraph, a figure, the line they
 * fluffed — and their place has not changed; re-seeding the tracker's cursor
 * would throw away a lock that is still correct and make the aligner earn it
 * back on evidence alone.
 *
 * Half a viewport is where the answer becomes reliably no. The reading line
 * sits at 38% of the glass, so half a screen of movement in either direction
 * takes the old position off it or close enough to an edge to be unreadable.
 */
export const MANUAL_RELOCATION_VIEWPORT_FRACTION = 0.5;

/**
 * Whether a settled manual scroll left the presenter somewhere else.
 *
 * Measured on the GAP — where the document ended up relative to where the
 * aligner believes the presenter is — and never on the distance travelled.
 * Somebody who scrolls two screens ahead to check something and then scrolls
 * back has travelled four screens and gone nowhere, and a rule written on
 * travel would re-anchor the tracker to a place they had already left again.
 *
 * A null gap is not a small one. It means the stage has no alignment target to
 * measure against — no frame from the feed this session — and the honest answer
 * is then that it does not know whether the presenter has moved, which is a
 * reason to leave the tracker alone rather than to overwrite it.
 */
export function manualScrollRelocated(
  gapPx: number | null,
  viewportHeightPx: number,
  fraction: number = MANUAL_RELOCATION_VIEWPORT_FRACTION,
): boolean {
  if (gapPx === null || !Number.isFinite(gapPx)) return false;
  if (!Number.isFinite(viewportHeightPx) || viewportHeightPx <= 0) return false;
  return Math.abs(gapPx) >= viewportHeightPx * fraction;
}
