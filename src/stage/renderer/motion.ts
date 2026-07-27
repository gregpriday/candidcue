/**
 * Movement classification for the fallback, snapshot-driven motion path.
 *
 * All stage motion runs through the single persistent
 * `JerkLimitedScrollController` (src/stage/motion). What lives here is the
 * classification of an accepted discontinuity into how the correction should be
 * *spent* — follow it, catch up, or re-anchor — which the renderer hands to
 * that controller as a disposition.
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

export type TransitionClass = 'spring' | 'smooth_jump' | 'fade_jump' | 'instant';

/**
 * The cap on a correction made from weak evidence (§16.4), at a measured pitch.
 *
 * Falls back to `PROVISIONAL_MAX_CORRECTION_PX` for an absent or unusable pitch,
 * and a pitch far outside the plausible band only moves the answer as far as
 * `resolveLineLimitPx` allows — a font that never loaded must not be able to
 * license a screen-sized correction on evidence the engine has already refused
 * to act on.
 */
export function provisionalMaxCorrectionPx(linePitchPx?: number | null): number {
  return resolveLineLimitPx(
    PROVISIONAL_MAX_CORRECTION_LINES,
    PROVISIONAL_MAX_CORRECTION_PX,
    linePitchPx,
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
  if (ALIGNMENT_RELOCATIONS.has(opts.decision)) {
    /*
     * The viewport-relative threshold is the fallback AND the sanity band: a
     * jump past a few screens is a teleport whatever the type size, so the
     * line-relative answer is clamped against it rather than trusted outright.
     */
    const viewportLimitPx = SMOOTH_JUMP_VIEWPORT_FACTOR * opts.viewportHeightPx;
    const limit = resolveLineLimitPx(SMOOTH_JUMP_MAX_LINES, viewportLimitPx, opts.linePitchPx);
    return opts.distancePx <= limit ? 'smooth_jump' : 'fade_jump';
  }
  return 'spring';
}
