/**
 * Movement classification for the degraded, snapshot-driven motion path.
 *
 * The v1 scroll spring that used to live here is gone: companion §32.1–32.5
 * replaces primary §32, and all stage motion now runs through the single
 * persistent `JerkLimitedScrollController` (src/stage/motion). What survives is
 * the classification of an explicit `TrackingSnapshot` movement into how the
 * correction should be *spent* — follow it, catch up, or re-anchor — which the
 * renderer hands to that controller as a disposition.
 *
 * Pure logic.
 */

export const PROVISIONAL_MAX_CORRECTION_PX = 180;
/** Explicit jumps within ~2 viewport heights catch up instead of re-anchoring. */
export const SMOOTH_JUMP_VIEWPORT_FACTOR = 2;

export type TransitionClass = 'spring' | 'smooth_jump' | 'fade_jump' | 'instant';

export type TrackingMovement = 'hold' | 'advance' | 'skip' | 'retake' | 'command' | 'manual';

/**
 * Visual disposition of a snapshot-driven correction (spec §32.3, companion
 * A.3): alignment-driven motion is simply followed; an explicit jump catches up
 * when it is close and re-anchors when it is far. Reduced motion repositions
 * without an easing spectacle (§32.4).
 */
export function classifyTransition(opts: {
  movement: TrackingMovement;
  distancePx: number;
  viewportHeightPx: number;
  reducedMotion: boolean;
}): TransitionClass {
  if (opts.reducedMotion) return 'instant';
  const explicitJump =
    opts.movement === 'skip' ||
    opts.movement === 'retake' ||
    opts.movement === 'command' ||
    opts.movement === 'manual';
  if (explicitJump) {
    const limit = SMOOTH_JUMP_VIEWPORT_FACTOR * opts.viewportHeightPx;
    return opts.distancePx <= limit ? 'smooth_jump' : 'fade_jump';
  }
  return 'spring';
}
