/**
 * Text-motion primitives (spec §16.3, §32.3, A.5): a near-critically damped
 * spring for normal following, movement classification for skips/retakes,
 * and the timed-glide easing used for explicit jumps. Pure logic.
 */

export interface SpringConfig {
  stiffness: number;
  damping: number;
  /** Cap for normal (non-jump) motion, logical px/s. */
  maxVelocityPxPerS: number;
}

/** Initial constants from spec §16.3 / A.5, subject to tuning. */
export const DEFAULT_SPRING_CONFIG: SpringConfig = {
  stiffness: 150,
  damping: 28,
  maxVelocityPxPerS: 1200,
};

export const PROVISIONAL_MAX_CORRECTION_PX = 180;
export const LARGE_JUMP_FADE_OUT_MS = 90;
export const LARGE_JUMP_FADE_IN_MS = 120;
/** Explicit jumps within ~2 viewport heights glide instead of fading. */
export const SMOOTH_JUMP_VIEWPORT_FACTOR = 2;
export const SMOOTH_JUMP_DURATION_MS = 220;

export type TransitionClass = 'spring' | 'smooth_jump' | 'fade_jump' | 'instant';

export type TrackingMovement = 'hold' | 'advance' | 'skip' | 'retake' | 'command' | 'manual';

/**
 * Visual side of the movement classes (spec §32.3): alignment-driven motion
 * uses the spring; explicit jumps use a glide or, beyond ~2 viewport heights,
 * the fade-down / reposition / fade-up sequence (§16.3). Reduced motion means
 * near-instant repositioning with no easing spectacle (§32.4).
 */
export function classifyTransition(opts: {
  movement: TrackingMovement;
  distancePx: number;
  viewportHeightPx: number;
  reducedMotion: boolean;
}): TransitionClass {
  if (opts.reducedMotion) return 'instant';
  const explicitJump =
    opts.movement === 'skip' || opts.movement === 'retake' ||
    opts.movement === 'command' || opts.movement === 'manual';
  if (explicitJump) {
    const limit = SMOOTH_JUMP_VIEWPORT_FACTOR * opts.viewportHeightPx;
    return opts.distancePx <= limit ? 'smooth_jump' : 'fade_jump';
  }
  return 'spring';
}

export interface SpringStepResult {
  position: number;
  settled: boolean;
}

export interface ScrollSpring {
  readonly position: number;
  readonly target: number;
  /** Hard reset (no motion). */
  reset(position: number): void;
  setTarget(target: number): void;
  /** Instant reposition, killing velocity. */
  jumpTo(position: number): void;
  /** Advance by dtMs; returns new position and whether motion has settled. */
  step(dtMs: number): SpringStepResult;
}

const SETTLE_DISTANCE_PX = 0.5;
const SETTLE_VELOCITY_PX_PER_S = 8;
const MAX_STEP_MS = 64;
const SUBSTEP_MS = 8;

export function createScrollSpring(config: SpringConfig = DEFAULT_SPRING_CONFIG): ScrollSpring {
  let position = 0;
  let velocity = 0;
  let target = 0;

  return {
    get position() {
      return position;
    },
    get target() {
      return target;
    },
    reset(p: number) {
      position = p;
      velocity = 0;
      target = p;
    },
    setTarget(t: number) {
      target = t;
    },
    jumpTo(p: number) {
      position = p;
      velocity = 0;
      target = p;
    },
    step(dtMs: number): SpringStepResult {
      let remaining = Math.min(Math.max(dtMs, 0), MAX_STEP_MS);
      while (remaining > 0) {
        const dt = Math.min(remaining, SUBSTEP_MS) / 1000;
        remaining -= SUBSTEP_MS;
        // Semi-implicit Euler keeps the spring stable at frame-rate steps.
        const accel = config.stiffness * (target - position) - config.damping * velocity;
        velocity += accel * dt;
        const cap = config.maxVelocityPxPerS;
        if (velocity > cap) velocity = cap;
        if (velocity < -cap) velocity = -cap;
        position += velocity * dt;
      }
      const settled =
        Math.abs(target - position) < SETTLE_DISTANCE_PX &&
        Math.abs(velocity) < SETTLE_VELOCITY_PX_PER_S;
      if (settled) {
        position = target;
        velocity = 0;
      }
      return { position, settled };
    },
  };
}

/** Ease for smooth jumps (accelerated glide, §16.3). */
export function easeInOutCubic(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/** Position along a timed glide at elapsed/duration. */
export function glidePosition(from: number, to: number, elapsedMs: number, durationMs: number): number {
  if (durationMs <= 0) return to;
  return from + (to - from) * easeInOutCubic(elapsedMs / durationMs);
}
