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
/**
 * Hitch threshold used until the real refresh interval is known (§70.8).
 *
 * This was a FIXED 28 ms, which is a 60 Hz assumption wearing a constant's
 * clothing. A 30 Hz display has a 33.3 ms frame period, so on one of those
 * every single healthy frame counted as a dropped frame: the ratio pinned at
 * 1.0, §61 degradation tripped after 4 s and could never clear (the 0.05
 * recovery ratio is unreachable when the numerator is every frame), ω was cut
 * 15%, the deadband doubled, styling dropped to 250 ms, and control was told
 * the stage was dropping frames for the whole session. 4K@30 over HDMI is a
 * real and cheap teleprompter monitor, not a corner case.
 *
 * A hitch is a MISSED REFRESH, which is only definable against the refresh the
 * display actually has — so the live threshold comes from
 * `createFrameIntervalEstimator` and this value is just the seed before enough
 * frames have been seen to measure one.
 */
export const HITCH_THRESHOLD_MS = 28;

/**
 * A frame is a hitch when it took this many nominal periods or more. Halfway
 * between "on time" (1 period) and "one refresh missed" (2 periods), so vsync
 * jitter does not read as a drop and a genuinely missed refresh always does.
 */
export const HITCH_INTERVAL_RATIO = 1.5;

/** Frames of history the nominal-period estimate is taken over. */
const FRAME_INTERVAL_WINDOW = 60;
/** How often the median is recomputed — every frame would be pure overhead. */
const FRAME_INTERVAL_RECOMPUTE_EVERY = 15;
/** Samples needed before the measured period is trusted over the seed. */
const FRAME_INTERVAL_MIN_SAMPLES = 20;

export interface FrameIntervalEstimator {
  /** Feed one measured inter-frame delta. Returns the current hitch threshold. */
  observe(dtMs: number): number;
  /** Best estimate of the display's frame period, or null while unknown. */
  readonly nominalMs: number | null;
  readonly thresholdMs: number;
  reset(): void;
}

/**
 * Estimate the display's frame period from what the loop actually sees.
 *
 * The MEDIAN, not the mean: dropped frames, GC pauses, and hidden-window
 * catch-ups are exactly the samples this must not be moved by, and they are
 * always long. A median over a one-second window is unaffected by anything
 * short of the majority of frames being late — at which point the stage is
 * genuinely degraded and should say so.
 */
export function createFrameIntervalEstimator(
  options: { windowSize?: number; ratio?: number; seedThresholdMs?: number } = {},
): FrameIntervalEstimator {
  const windowSize = options.windowSize ?? FRAME_INTERVAL_WINDOW;
  const ratio = options.ratio ?? HITCH_INTERVAL_RATIO;
  const seed = options.seedThresholdMs ?? HITCH_THRESHOLD_MS;
  const samples: number[] = [];
  let sinceRecompute = 0;
  let nominal: number | null = null;
  let threshold = seed;

  function recompute() {
    if (samples.length < FRAME_INTERVAL_MIN_SAMPLES) return;
    const sorted = [...samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? seed;
    nominal = median;
    // Never tighter than the seed: a 120 Hz display would otherwise call an
    // ordinary 60 Hz-equivalent frame a hitch, and the point of the metric is
    // missed refreshes, not refresh rate.
    threshold = Math.min(MAX_FRAME_DT_MS, Math.max(seed, median * ratio));
  }

  return {
    get nominalMs() {
      return nominal;
    },
    get thresholdMs() {
      return threshold;
    },
    observe(dtMs) {
      // A non-positive delta is the first frame or a repeated timestamp, and a
      // multi-second one is a resumed window — neither describes the refresh.
      if (dtMs > 0 && dtMs <= 1000) {
        samples.push(dtMs);
        if (samples.length > windowSize) samples.shift();
        sinceRecompute++;
        if (sinceRecompute >= FRAME_INTERVAL_RECOMPUTE_EVERY || nominal === null) {
          sinceRecompute = 0;
          recompute();
        }
      }
      return threshold;
    },
    reset() {
      samples.length = 0;
      sinceRecompute = 0;
      nominal = null;
      threshold = seed;
    },
  };
}

const VELOCITY_EPSILON_PX_S = 4;
/**
 * Fraction of `aMax` spent on braking. The remaining authority is headroom for
 * the feed-forward term and for frame-time discretization; the stopping
 * distance itself is computed exactly for this authority (see
 * `brakingSpeedFor`), so this is margin, not a correction factor.
 */
const BRAKE_AUTHORITY = 0.6;
/**
 * Braking authority assumed when deciding whether to start defending the §30.5
 * reverse-travel budget. Lower than `BRAKE_AUTHORITY` on purpose: the budget is
 * a wall rather than a moving target, so committing early is free, and running
 * out of it means a dead stop from full rewind speed.
 */
const REVERSE_BRAKE_AUTHORITY = 0.35;
/** Reserve between the reverse-travel guard and the hard clamp, in deadbands. */
const REVERSE_RESERVE_DEADBANDS = 4;

/**
 * Distance the plant still travels if it starts braking NOW, from speed `v`
 * while currently accelerating at `a`, under a jerk limit.
 *
 * This is the guard the overshoot protection is built on, and the reason it has
 * to take `a` as an argument: a jerk-limited plant cannot reverse its
 * acceleration instantly, so a controller that is still accelerating hard has
 * already committed to a large amount of forward travel. The familiar
 * `v²/(2·a)` answer assumes braking begins immediately and understates the real
 * distance by a factor of two or more at full acceleration — which is exactly
 * how a "guard" can be present and still let the document sail past its target.
 *
 * Three phases of the standard S-curve stop:
 *
 *   A  ramp acceleration from `a` down to `−aBrake` at `jerkMax`
 *   B  hold `−aBrake` until only the final ramp's worth of speed is left
 *   C  ramp acceleration from `−aBrake` back to 0, arriving at v = 0
 *
 * Cheap enough to evaluate every sub-step (§63: the whole motion pass stays
 * well under 1 ms/frame).
 */
export function stoppingDistancePx(
  v: number,
  a: number,
  aBrake: number,
  jerkMax: number,
): number {
  if (!(v > 0)) return 0;
  if (!(aBrake > 0)) return Number.POSITIVE_INFINITY;
  if (!(jerkMax > 0)) return (v * v) / (2 * aBrake);

  // Braking harder than `aBrake` already? Treat it as `−aBrake`: the estimate
  // stays conservative, which is the safe direction for a guard.
  const a0 = Math.max(-aBrake, a);
  const tA = (a0 + aBrake) / jerkMax;
  const dA = v * tA + 0.5 * a0 * tA * tA - (jerkMax * tA * tA * tA) / 6;
  const vA = v + a0 * tA - 0.5 * jerkMax * tA * tA;
  if (vA <= 0) return Math.max(0, dA);

  // Speed consumed by phase C, and the distance it covers.
  const vC = (aBrake * aBrake) / (2 * jerkMax);
  if (vA <= vC) {
    // Too slow for a full brake ramp: a symmetric jerk-only stop, which takes
    // 2·√(vA/jerkMax) and covers vA·√(vA/jerkMax).
    return dA + vA * Math.sqrt(vA / jerkMax);
  }
  const dB = (vA * vA - vC * vC) / (2 * aBrake);
  const dC = (aBrake * aBrake * aBrake) / (6 * jerkMax * jerkMax);
  return dA + dB + dC;
}

/**
 * Largest |acceleration| that can still be ramped back to zero inside
 * `velocityHeadroom` at `jerkMax` — the same idea one derivative up. Keeping
 * `|a|` under this bound means the plant approaches a velocity limit
 * asymptotically instead of hitting it and being clipped, and a clip is exactly
 * the unbounded-jerk event we are trying to remove.
 *
 * Continuously the answer is `√(2·jerkMax·h)`; the ramp consumes `a²/(2·jerkMax)`
 * of headroom. Integrating in sub-steps costs extra travel at the current
 * acceleration, and the ramp itself can only shed `jerkMax·dt` per sub-step, so
 * the discrete condition is `h ≥ a²/(2·j) + a·dt`. Inverting that quadratic
 * gives the bound below. The `dt` term is not cosmetic: without it the envelope
 * tightens faster than the jerk ramp can follow, `a` stays permanently a few
 * per cent above the bound, and the last sub-steps before a velocity limit take
 * jerk steps well past `jerkMax`. With it the excess strictly decays.
 */
function jerkLimitedAccel(velocityHeadroom: number, jerkMax: number, dt: number): number {
  if (!(velocityHeadroom > 0)) return 0;
  if (!(jerkMax > 0)) return Number.POSITIVE_INFINITY;
  const margin = jerkMax * Math.max(0, dt);
  return Math.sqrt(margin * margin + 2 * jerkMax * velocityHeadroom) - margin;
}

/**
 * Which `MotionLimits` fields must be finite before the plant may be
 * integrated. Typed `Record<keyof MotionLimits, …>` so a new limit fails
 * compilation until it is classified (§C1: the stage does not trust control).
 */
const LIMIT_IS_NUMERIC: Record<keyof MotionLimits, boolean> = {
  omega: true,
  zeta: true,
  vForwardMax: true,
  vBackwardMax: true,
  aMax: true,
  jerkMax: true,
  feedForwardScale: true,
  restDeadbandPx: true,
  reverseTravelMaxPx: true,
  reanchorThresholdPx: true,
  allowBackward: false,
  snap: false,
};

const NUMERIC_LIMIT_KEYS = (
  Object.keys(LIMIT_IS_NUMERIC) as Array<keyof MotionLimits>
).filter((key) => LIMIT_IS_NUMERIC[key]);

/** True when every value the integrator will touch is a finite number. */
export function motionInputsAreFinite(input: ControllerStepInput): boolean {
  if (!Number.isFinite(input.targetPx)) return false;
  if (!Number.isFinite(input.feedForwardVelocityPxS)) return false;
  const limits = input.limits as unknown as Record<string, unknown>;
  if (!limits) return false;
  for (const key of NUMERIC_LIMIT_KEYS) {
    if (!Number.isFinite(limits[key] as number)) return false;
  }
  return true;
}

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
  /**
   * The finite-value fuse rejected this step's inputs: the plant was NOT
   * integrated and NOT mutated, and the previous position is being held (§C1).
   */
  fused: boolean;
  /**
   * The step ended against a WALL — the document edge or the §30.5
   * reverse-travel budget — rather than against a limit. A wall is a genuine
   * discontinuity: velocity goes to zero in one sub-step, so this is the only
   * place the realized jerk is not bounded by `jerkMax`. The guards above brake
   * into both walls, so when this does fire the remaining speed is small; the
   * flag exists so diagnostics and tests can say so rather than assume it.
   */
  hardStop: boolean;
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
      // Even the one authorized plant write refuses a non-finite position: a
      // poisoned re-anchor would wedge the display exactly like a poisoned
      // frame, and the previous position is always a safe thing to keep.
      if (!Number.isFinite(positionPx)) return;
      plant.q = clamp(positionPx, minPx, maxPx);
      const velocity = opts?.velocityPxS ?? 0;
      plant.v = Number.isFinite(velocity) ? velocity : 0;
      if (!opts?.keepAcceleration) plant.a = 0;
      reverseTravelPx = 0;
    },

    step(input): ControllerStepResult {
      const { limits } = input;
      const rawDt = Number.isFinite(input.dtMs) ? Math.max(0, input.dtMs) : 0;
      const hitch = rawDt > maxFrameDtMs;

      // §C1 fuse. A non-finite target, feed-forward, or limit would propagate
      // into `q`, `v`, and `a` — and because the plant is persistent, every
      // later frame would stay poisoned. Hold the current position instead, and
      // do not touch plant state at all so the next sound frame resumes from a
      // real position with real momentum.
      if (!motionInputsAreFinite(input)) {
        return {
          ...plant,
          errorPx: 0,
          atRest: Math.abs(plant.v) < VELOCITY_EPSILON_PX_S,
          hitch,
          integratedMs: 0,
          saturated: true,
          jerkPxS3: 0,
          fused: true,
          hardStop: false,
        };
      }

      const target = clamp(input.targetPx, minPx, maxPx);
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
          fused: false,
          hardStop: false,
        };
      }

      const aBrake = Math.max(0, limits.aMax) * BRAKE_AUTHORITY;
      const envelopeDt = substepMs / 1000;
      let wallHit = false;
      let remaining = integratedMs;
      while (remaining > 0) {
        const stepMs = Math.min(remaining, substepMs);
        remaining -= stepMs;
        const dt = stepMs / 1000;
        if (dt <= 0) break;

        const error = target - plant.q;
        const vTarget = input.feedForwardVelocityPxS * limits.feedForwardScale;

        /* ---- 1. velocity envelope for the PROFILE limits ----
         * `vForwardMax` / `vBackwardMax` are constants for the frame, so the
         * jerk-aware bound below lets the plant decelerate *into* them instead
         * of being clipped by them — a clip is exactly the unbounded-jerk event
         * the previous velocity rewrite produced.
         *
         * The envelope is always evaluated for a FULL sub-step, never for the
         * short remainder one: a bound derived from a 0.5 ms remainder is looser
         * than the next 8 ms sub-step can honour, and the acceleration it
         * permits then leaks across the frame boundary.
         */
        const vHi = Math.max(0, limits.vForwardMax);
        const vLo = limits.allowBackward ? -Math.max(0, limits.vBackwardMax) : 0;
        const aUpper = Math.min(
          limits.aMax,
          jerkLimitedAccel(vHi - plant.v, limits.jerkMax, envelopeDt),
        );
        const aLower = Math.max(
          -limits.aMax,
          -jerkLimitedAccel(plant.v - vLo, limits.jerkMax, envelopeDt),
        );

        /* ---- 2. desired acceleration (§29.1) ----
         * Damped second-order controller with feed-forward; without the
         * feed-forward term the controller always lags a steadily moving target.
         */
        let aDesired =
          limits.omega * limits.omega * error -
          2 * limits.zeta * limits.omega * (plant.v - vTarget);

        /* ---- 3. overshoot guard (§70.5) ----
         * Ordinary following may not move backward, so an overshoot would be
         * permanent. The guard asks the only question that matters — "if I
         * commit to braking now, do I still stop inside the remaining error?" —
         * and answers it from the plant's CURRENT acceleration, because a
         * jerk-limited plant that is still accelerating has already committed to
         * travel that `v²/2a` does not see.
         *
         * Crucially the guard acts by demanding braking *acceleration*. It never
         * rewrites `v`, so its braking is jerk-limited like everything else and
         * the position trace has no step in it. Speed is measured relative to
         * the target's own feed-forward velocity: matching a moving target's
         * speed is not overshoot.
         */
        // Travel the rest deadband would absorb anyway is not overshoot; without
        // this tolerance the guard fires on the sub-pixel lead a healthy
        // feed-forward carries and brakes at full authority once per frame.
        const slackPx = Math.max(0, limits.restDeadbandPx);
        const vRelForward = plant.v - Math.max(0, vTarget);
        const vRelBackward = Math.min(0, vTarget) - plant.v;
        // Each branch only applies while the plant is genuinely OUTRUNNING the
        // target in that direction. A plant that is not moving forward cannot
        // overshoot forward, and reading a zero stopping distance as "greater
        // than a negative error" would otherwise brake a rewind to a stop.
        if (
          vRelForward > 0 &&
          stoppingDistancePx(vRelForward, plant.a, aBrake, limits.jerkMax) > error + slackPx
        ) {
          aDesired = -limits.aMax;
          saturated = true;
        } else if (
          limits.allowBackward &&
          vRelBackward > 0 &&
          stoppingDistancePx(vRelBackward, -plant.a, aBrake, limits.jerkMax) > -error + slackPx
        ) {
          aDesired = limits.aMax;
          saturated = true;
        }

        /* ---- 4. §30.5 reverse-travel budget ----
         * A hard travel limit, so unlike the overshoot guard it is measured
         * against the ground, not against the target's feed-forward velocity —
         * matching a backward-moving target is still travel. Braking into it
         * (rather than slamming `v` to zero when it ran out) removes a
         * 60 000 px/s³ kick at the bottom of every rewind; the clamp below is
         * now only a net. The reserve is one sub-step of travel, which is what
         * the discrete integration can overshoot by.
         */
        // Reserve kept between where the guard starts defending the budget and
        // where the hard clamp sits, so the jerk-limited brake always finishes
        // first and the clamp stays a net. A few pixels of a 420 px budget.
        const reverseReserve = Math.max(
          REVERSE_RESERVE_DEADBANDS * Math.max(0, limits.restDeadbandPx),
          -Math.min(0, plant.v) * envelopeDt,
        );
        if (limits.allowBackward && plant.v < 0) {
          const budget =
            Math.max(0, limits.reverseTravelMaxPx - reverseTravelPx) - reverseReserve;
          // Deliberately pessimistic authority: unlike the target, the travel
          // budget is not going to move out of the way, and the real brake uses
          // the full `aMax`, so an early commit costs nothing.
          const reverseBrake = Math.max(0, limits.aMax) * REVERSE_BRAKE_AUTHORITY;
          if (stoppingDistancePx(-plant.v, -plant.a, reverseBrake, limits.jerkMax) > budget) {
            aDesired = limits.aMax;
            saturated = true;
          }
        }

        // Did the plant BEGIN this sub-step outside the profile's own velocity
        // limits? Only a profile that changed between frames can do that, and it
        // decides whether the residual net below may act at all.
        const startedAboveCeiling = plant.v > vHi;
        const startedBelowFloor = plant.v < vLo;
        if (startedAboveCeiling) {
          // Outside the profile's own velocity limit (a profile change between
          // frames). Brake as hard as the *other* edge still permits.
          aDesired = aLower;
          saturated = true;
        } else if (startedBelowFloor) {
          aDesired = aUpper;
          saturated = true;
        } else {
          if (aDesired > aUpper || aDesired < aLower) saturated = true;
          aDesired = clamp(aDesired, aLower, aUpper);
        }
        aDesired = clamp(aDesired, -limits.aMax, limits.aMax);

        /* ---- 3. jerk-limited integration ----
         * The jerk limit is ABSOLUTE: nothing above may move `a` further than
         * `jerkMax·dt` in one sub-step. The envelope is a bound on what may be
         * *asked for*, never a licence to rewrite the state afterwards — that
         * rewrite is precisely what let the previous overshoot guard put a
         * ±aMax step into the position trace while `plant.a` stayed positive.
         */
        const vPrev = plant.v;
        plant.a = approach(plant.a, aDesired, limits.jerkMax * dt);
        let v = plant.v + plant.a * dt;

        /* Residual net for the profile's hard velocity limits.
         *
         * This is a net for DISCRETIZATION SLOP — the fraction of a px/s the
         * jerk-aware envelope above can leave on the table — and nothing else.
         * It used to be applied unconditionally, which quietly made it the
         * mechanism for something entirely different: a profile that shrinks
         * between frames leaves the plant *starting* the sub-step outside its
         * own new limits, and clamping straight to the new ceiling is a
         * one-sub-step velocity STEP. Measured on a stacked catch-up
         * (2304 px/s) expiring into `following`: Δv −1404 px/s in 8 ms, a
         * realized −175,500 px/s² against an aMax of 2600 and a jerk two orders
         * of magnitude past `jerkMax` — and not flagged as a wall, so nothing in
         * the suite could see it. The trigger is mundane (a `catch_up`
         * transition hitting its 4 s timer), and the presenter sees a snag.
         *
         * A jerk-limited plant cannot honour a limit that moved underneath it in
         * zero time, and pretending otherwise is the whole defect. The
         * `startedAboveCeiling` / `startedBelowFloor` branches above already
         * demand maximum braking toward the new limit; the net's job is to stay
         * out of their way until they have brought the plant back inside, which
         * they do smoothly in a few hundred ms.
         */
        const vCeiling = startedAboveCeiling ? Math.max(vHi, v) : vHi;
        const vFloor = startedBelowFloor ? Math.min(vLo, v) : vLo;
        const vNet = clamp(v, vFloor, vCeiling);
        if (vNet !== v) {
          v = vNet;
          saturated = true;
        }

        /* ---- 4. hard stops ----
         * The document edges and the §30.5 reverse-travel clamp are walls, not
         * limits: the plant stops dead. `a` is zeroed rather than left holding
         * a demand that would immediately push back off the wall.
         */
        let hardStop = false;
        if (v < 0) {
          // The budget's own reserve is the allowed overrun: the guard above is
          // what actually stops the rewind, and letting it finish inside the
          // reserve is worth far more than shaving the last fraction of a pixel
          // off the excursion with a dead stop the presenter can see.
          if (reverseTravelPx >= limits.reverseTravelMaxPx + reverseReserve) {
            v = 0;
            hardStop = true;
            saturated = true;
          } else {
            reverseTravelPx += -v * dt;
          }
        } else if (v > 0) {
          // Net excursion, not "reset on any forward motion". Braking smoothly
          // into the budget (rather than slamming `v` to zero) leaves a small
          // forward blip at the bottom of the rewind; a reset-on-any-forward
          // rule would hand the budget straight back and let the plant creep
          // backward indefinitely, one blip at a time.
          reverseTravelPx = Math.max(0, reverseTravelPx - v * dt);
        }

        plant.v = v;
        plant.q += plant.v * dt;

        if (plant.q <= minPx) {
          plant.q = minPx;
          if (plant.v < 0) {
            plant.v = 0;
            hardStop = true;
          }
        } else if (plant.q >= maxPx) {
          plant.q = maxPx;
          if (plant.v > 0) {
            plant.v = 0;
            hardStop = true;
          }
        }
        // `a` describes the acceleration the position trace actually
        // experienced. A wall zeroes it; a residual net adopts the realized
        // value so the next sub-step's jerk limit is applied to the truth.
        if (hardStop) {
          plant.a = 0;
          wallHit = true;
        }
        else if (plant.v !== vPrev + plant.a * dt) plant.a = (plant.v - vPrev) / dt;
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
        // Settling may close a sub-deadband gap, but it may not contradict the
        // profile: under a forward-only profile the deadband never snaps `q`
        // backward, because "ordinary following never moves backward" has to
        // hold at every scale, including 1.5 px.
        if (limits.allowBackward || target >= plant.q) plant.q = target;
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
        fused: false,
        hardStop: wallHit,
      };
    },
  };
}
