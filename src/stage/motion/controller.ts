/**
 * JerkLimitedScrollController (companion §29, §32).
 *
 * One persistent controller owns motion for the life of the stage session
 * (§26.2). It is a near-critically damped follower with explicit acceleration
 * and jerk limits, so a revised target blends into the motion already happening
 * instead of restarting an animation. Nothing outside `reanchor()` may write
 * the plant state (§26.3).
 *
 * Frame-time handling (§32): the measured delta is clamped to a safe
 * integration range and split into fixed sub-steps, so a garbage-collection
 * hitch or a hidden-window catch-up can never teleport the document, and gains
 * behave the same at 60, 90, and 120 Hz.
 *
 * Pure: the caller supplies dt; no rAF, no DOM.
 */
import type { MotionLimits } from './profiles';

/** §32.1: never integrate more than this in one displayed frame. */
export const MAX_FRAME_DT_MS = 50;
/** Fixed integration sub-step — keeps behavior refresh-rate independent. */
export const CONTROLLER_SUBSTEP_MS = 8;
/** A frame gap beyond this is counted as a hitch/dropped frame (§70.8). */
export const HITCH_THRESHOLD_MS = 28;

const VELOCITY_EPSILON_PX_S = 4;
/**
 * Fraction of `aMax` reserved for braking. A jerk-limited controller cannot
 * reverse its acceleration instantly, so the velocity ceiling that guarantees
 * "arrive without overshooting" has to leave room for the jerk ramp.
 */
const BRAKE_AUTHORITY = 0.6;

export interface MotionPlantState {
  /** Actual scroll position in px (fractional; §29.4 — never rounded here). */
  q: number;
  /** Actual velocity, px/s. */
  v: number;
  /** Actual acceleration, px/s². */
  a: number;
}

export interface ControllerStepInput {
  dtMs: number;
  targetPx: number;
  feedForwardVelocityPxS: number;
  limits: MotionLimits;
  /** Allow the rest deadband to snap the plant to rest (§29.3). */
  allowRest?: boolean;
}

export interface ControllerStepResult extends MotionPlantState {
  /** Position error at the end of the step. */
  errorPx: number;
  atRest: boolean;
  /** The measured frame delta exceeded the integration cap. */
  hitch: boolean;
  /** Milliseconds actually integrated (≤ MAX_FRAME_DT_MS). */
  integratedMs: number;
  /** Acceleration or velocity limiting was active during the step. */
  saturated: boolean;
  /** Estimated jerk over the step, px/s³ (diagnostics only). */
  jerkPxS3: number;
}

export interface JerkLimitedScrollController {
  readonly state: Readonly<MotionPlantState>;
  /** Backward distance travelled since the last forward motion (§30.5 clamp). */
  readonly reverseTravelPx: number;
  step(input: ControllerStepInput): ControllerStepResult;
  /**
   * The ONE authorized way to overwrite plant state (§26.3): re-anchor, reset,
   * layout recovery, manual navigation, visibility restoration.
   */
  reanchor(positionPx: number, options?: { velocityPxS?: number; keepAcceleration?: boolean }): void;
  setBounds(minPx: number, maxPx: number): void;
  readonly bounds: { minPx: number; maxPx: number };
}

export interface ControllerOptions {
  initialPositionPx?: number;
  minPx?: number;
  maxPx?: number;
  maxFrameDtMs?: number;
  substepMs?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Move `current` toward `target` by at most `maxDelta`. */
export function approach(current: number, target: number, maxDelta: number): number {
  const delta = target - current;
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
}

export function createJerkLimitedScrollController(
  options: ControllerOptions = {},
): JerkLimitedScrollController {
  const maxFrameDtMs = options.maxFrameDtMs ?? MAX_FRAME_DT_MS;
  const substepMs = options.substepMs ?? CONTROLLER_SUBSTEP_MS;
  let minPx = options.minPx ?? 0;
  let maxPx = options.maxPx ?? Number.POSITIVE_INFINITY;

  const plant: MotionPlantState = {
    q: clamp(options.initialPositionPx ?? 0, minPx, maxPx),
    v: 0,
    a: 0,
  };
  let reverseTravelPx = 0;

  return {
    get state() {
      return plant;
    },
    get reverseTravelPx() {
      return reverseTravelPx;
    },
    get bounds() {
      return { minPx, maxPx };
    },

    setBounds(nextMin, nextMax) {
      minPx = nextMin;
      maxPx = Math.max(nextMin, nextMax);
      plant.q = clamp(plant.q, minPx, maxPx);
    },

    reanchor(positionPx, opts) {
      plant.q = clamp(positionPx, minPx, maxPx);
      plant.v = opts?.velocityPxS ?? 0;
      if (!opts?.keepAcceleration) plant.a = 0;
      reverseTravelPx = 0;
    },

    step(input): ControllerStepResult {
      const { limits } = input;
      const target = clamp(input.targetPx, minPx, maxPx);
      const rawDt = Number.isFinite(input.dtMs) ? Math.max(0, input.dtMs) : 0;
      const hitch = rawDt > maxFrameDtMs;
      // §32.2: cap the integration step. The target is re-evaluated next frame;
      // a large remaining error becomes catch-up, never a one-frame jump.
      const integratedMs = Math.min(rawDt, maxFrameDtMs);
      const aBefore = plant.a;
      let saturated = false;

      if (limits.snap) {
        // Reduced motion (§32.4 / A.3): follow the target exactly. The target
        // itself is continuous, so this still reads as motion, just without
        // controller dynamics.
        const dtSec = integratedMs / 1000;
        const previous = plant.q;
        plant.q = target;
        plant.v = dtSec > 0 ? (plant.q - previous) / dtSec : 0;
        plant.a = 0;
        return {
          ...plant,
          errorPx: 0,
          atRest: Math.abs(plant.v) < VELOCITY_EPSILON_PX_S,
          hitch,
          integratedMs,
          saturated: false,
          jerkPxS3: 0,
        };
      }

      let remaining = integratedMs;
      while (remaining > 0) {
        const stepMs = Math.min(remaining, substepMs);
        remaining -= stepMs;
        const dt = stepMs / 1000;
        if (dt <= 0) break;

        const error = target - plant.q;
        const vTarget = input.feedForwardVelocityPxS * limits.feedForwardScale;

        // §29.1: damped second-order controller with feed-forward. Without the
        // feed-forward term the controller always lags a steadily moving target.
        let aDesired =
          limits.omega * limits.omega * error -
          2 * limits.zeta * limits.omega * (plant.v - vTarget);
        if (aDesired > limits.aMax || aDesired < -limits.aMax) saturated = true;
        aDesired = clamp(aDesired, -limits.aMax, limits.aMax);

        plant.a = approach(plant.a, aDesired, limits.jerkMax * dt);

        let v = plant.v + plant.a * dt;
        const vMin = limits.allowBackward ? -limits.vBackwardMax : 0;
        if (v > limits.vForwardMax || v < vMin) saturated = true;
        v = clamp(v, vMin, limits.vForwardMax);

        // Overshoot guard (§70.5). Ordinary following may not move backward, so
        // an overshoot would be permanent: never carry more speed than the
        // remaining error can absorb, measured relative to the feed-forward
        // velocity the target itself is moving at.
        // The ceiling itself is approached at no more than aMax, so a target
        // that suddenly moves cannot produce a velocity step.
        const brake = 2 * limits.aMax * BRAKE_AUTHORITY;
        const maxDelta = limits.aMax * dt;
        const forwardCeiling = Math.max(0, vTarget) + Math.sqrt(brake * Math.max(0, error));
        if (v > forwardCeiling) {
          v = Math.max(forwardCeiling, plant.v - maxDelta);
          saturated = true;
        }
        if (limits.allowBackward) {
          const backwardFloor = Math.min(0, vTarget) - Math.sqrt(brake * Math.max(0, -error));
          if (v < backwardFloor) {
            v = Math.min(backwardFloor, plant.v + maxDelta);
            saturated = true;
          }
        }

        // §30.5 reverse-travel clamp: a rewind may not run away backward.
        if (v < 0) {
          if (reverseTravelPx >= limits.reverseTravelMaxPx) {
            v = 0;
            plant.a = Math.max(0, plant.a);
          } else {
            reverseTravelPx += -v * dt;
          }
        } else if (v > 0) {
          reverseTravelPx = 0;
        }

        plant.v = v;
        plant.q += plant.v * dt;

        if (plant.q <= minPx) {
          plant.q = minPx;
          if (plant.v < 0) {
            plant.v = 0;
            plant.a = Math.max(0, plant.a);
          }
        } else if (plant.q >= maxPx) {
          plant.q = maxPx;
          if (plant.v > 0) {
            plant.v = 0;
            plant.a = Math.min(0, plant.a);
          }
        }
      }

      // §29.3 rest condition — not ordinary follow behavior, only a way to stop
      // subpixel shimmer once everything has genuinely settled.
      const error = target - plant.q;
      const vTarget = input.feedForwardVelocityPxS * limits.feedForwardScale;
      const atRest =
        (input.allowRest ?? true) &&
        Math.abs(error) < limits.restDeadbandPx &&
        Math.abs(vTarget) < VELOCITY_EPSILON_PX_S &&
        Math.abs(plant.v) < VELOCITY_EPSILON_PX_S;
      if (atRest) {
        plant.q = target;
        plant.v = 0;
        plant.a = 0;
      }

      const dtSec = integratedMs / 1000;
      return {
        ...plant,
        errorPx: target - plant.q,
        atRest,
        hitch,
        integratedMs,
        saturated,
        jerkPxS3: dtSec > 0 ? (plant.a - aBefore) / dtSec : 0,
      };
    },
  };
}
