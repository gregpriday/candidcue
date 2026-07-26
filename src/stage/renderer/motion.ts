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
import { ALIGNMENT_RELOCATIONS, type AlignmentDecision } from '../../shared/contracts';

export const PROVISIONAL_MAX_CORRECTION_PX = 180;
/** Explicit jumps within ~2 viewport heights catch up instead of re-anchoring. */
export const SMOOTH_JUMP_VIEWPORT_FACTOR = 2;

export type TransitionClass = 'spring' | 'smooth_jump' | 'fade_jump' | 'instant';

/**
 * Visual disposition of a snapshot-driven correction (spec §32.3, companion
 * A.3): ordinary following is simply followed; an accepted discontinuity
 * catches up when it is close and re-anchors when it is far. Reduced motion
 * repositions without an easing spectacle (§32.4).
 */
export function classifyTransition(opts: {
  decision: AlignmentDecision;
  distancePx: number;
  viewportHeightPx: number;
  reducedMotion: boolean;
}): TransitionClass {
  if (opts.reducedMotion) return 'instant';
  if (ALIGNMENT_RELOCATIONS.has(opts.decision)) {
    const limit = SMOOTH_JUMP_VIEWPORT_FACTOR * opts.viewportHeightPx;
    return opts.distancePx <= limit ? 'smooth_jump' : 'fade_jump';
  }
  return 'spring';
}
