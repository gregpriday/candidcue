/**
 * Motion profiles by state (companion §30).
 *
 * "Use profile multipliers rather than unrelated controller implementations" —
 * every state runs the same jerk-limited follower with different limits, so
 * there is exactly one place where motion can be produced and one set of
 * invariants to test.
 *
 * Every number traces back to `SmoothFollowProfile.motion`; nothing here is a
 * free-floating constant.
 */
import type {
  SmoothFollowProfile,
  StageTransitionDirective,
  TrackingStateV2,
} from '../../shared/contracts';

export interface MotionLimits {
  /** Controller natural frequency (rad/s). */
  omega: number;
  /** Damping ratio; near 1.0 is critically damped. */
  zeta: number;
  vForwardMax: number;
  vBackwardMax: number;
  aMax: number;
  jerkMax: number;
  /** Multiplier on the feed-forward target velocity. */
  feedForwardScale: number;
  restDeadbandPx: number;
  reverseTravelMaxPx: number;
  reanchorThresholdPx: number;
  /** False forbids any backward motion (ordinary following, retake pending). */
  allowBackward: boolean;
  /** Reduced motion: follow the target exactly, with no easing dynamics. */
  snap: boolean;
}

interface StateMultipliers {
  omega?: number;
  zeta?: number;
  vForward?: number;
  vBackward?: number;
  accel?: number;
  jerk?: number;
  feedForward?: number;
  deadband?: number;
  allowBackward?: boolean;
}

/** Companion §30.1–30.5, plus the states that simply hold. */
function stateMultipliers(
  state: TrackingStateV2,
  profile: SmoothFollowProfile,
): StateMultipliers {
  const catchUp = Math.max(1, profile.motion.catchUpMultiplier);
  switch (state) {
    case 'following':
      return {};
    case 'acquiring':
      return { vForward: 0.6, accel: 0.7, feedForward: 0.8, zeta: 1.05 };
    case 'coasting':
      // §30.2: reduce speed, increase damping, keep enough motion to avoid a
      // freeze; no new large visual lead.
      return { vForward: 0.55, accel: 0.8, zeta: 1.15, feedForward: 0.8, omega: 0.9 };
    case 'uncertain':
      return { vForward: 0.35, accel: 0.6, zeta: 1.3, feedForward: 0.5, omega: 0.8 };
    case 'adlib_hold':
      return { vForward: 0.15, accel: 0.5, zeta: 1.4, feedForward: 0, omega: 0.7 };
    case 'catching_up':
      // §30.3: more velocity and acceleration, jerk limit preserved.
      return { vForward: catchUp, accel: catchUp, feedForward: 1, omega: 1.15 };
    case 'retake_pending':
      // §30.4: decelerate toward zero, do not reverse until commit.
      return { vForward: 0.3, accel: 0.6, zeta: 1.3, feedForward: 0.3, allowBackward: false };
    case 'rewinding':
      // §30.5: lower absolute speed than forward catch-up, damped to avoid
      // overshoot.
      return { vForward: 0.5, vBackward: 0.8, zeta: 1.25, feedForward: 0.6, allowBackward: true };
    case 'reanchoring':
      return {
        vForward: catchUp * 1.2,
        vBackward: catchUp,
        accel: 1.4,
        zeta: 1.1,
        feedForward: 0.8,
        allowBackward: true,
      };
    case 'command_pending':
      return { vForward: 0.8, feedForward: 0.6, zeta: 1.1 };
    case 'paused':
    case 'reconnecting':
      // Target zero velocity (§27.1) — the controller still settles smoothly.
      return { vForward: 0.25, accel: 0.5, zeta: 1.4, feedForward: 0, omega: 0.8 };
    case 'lost_local':
      return { vForward: 0.2, accel: 0.5, zeta: 1.4, feedForward: 0, omega: 0.75 };
    default:
      return {};
  }
}

/** Transition directives temporarily reshape the same limits (§53, §30). */
function transitionMultipliers(
  type: StageTransitionDirective['type'] | undefined,
  profile: SmoothFollowProfile,
): StateMultipliers {
  const catchUp = Math.max(1, profile.motion.catchUpMultiplier);
  switch (type) {
    case 'settle':
      return { vForward: 0.7, accel: 0.8, zeta: 1.25, feedForward: 0.9, omega: 0.95 };
    case 'catch_up':
      return { vForward: catchUp, accel: catchUp, feedForward: 1, omega: 1.15 };
    case 'rewind':
      return { vBackward: 0.9, zeta: 1.25, feedForward: 0.6, allowBackward: true };
    case 'reanchor':
    case 'reset':
      return { vForward: catchUp * 1.2, accel: 1.4, zeta: 1.15, allowBackward: true };
    default:
      return {};
  }
}

export interface MotionLimitOptions {
  reducedMotion?: boolean;
  /** §61: the frame budget is being missed; simplify rather than jump. */
  degraded?: boolean;
  transition?: StageTransitionDirective['type'];
  /** Manual authority suppresses automatic correction for a grace interval. */
  manualGrace?: boolean;
}

export function limitsForState(
  state: TrackingStateV2,
  profile: SmoothFollowProfile,
  options: MotionLimitOptions = {},
): MotionLimits {
  const m = profile.motion;
  const s = stateMultipliers(state, profile);
  const t = transitionMultipliers(options.transition, profile);
  /**
   * Combine a state multiplier with a transition multiplier — WITHOUT letting
   * them compound past either one on its own.
   *
   * This was a plain product, and the product is where the profile table stops
   * describing motion anyone chose. `reanchoring` × `catch_up` and
   * `catching_up` × `reanchor`/`reset` reached vMax 2765 and aMax 5824 — three
   * and 2.2 times the base — against a `jerkMax` that is deliberately never
   * relaxed (§30.3). A jerk-limited actuator needs `2·aMax/jerkMax` to swing
   * acceleration from one rail to the other, which at aMax 5824 is 0.97 s; run
   * that much actuator lag inside a loop whose stacked ω is 7.5 rad/s and the
   * phase margin is gone. The result was not overshoot but a sustained LIMIT
   * CYCLE: 106–162 px of tail oscillation with 63–78 reversals over 32 s
   * against a *static* target, the guard saturated on ~99% of sub-steps, and
   * the text visibly rocking about two and a half lines. `reanchoring` with a
   * `catch_up` transition is an ordinary combination that can hold for the
   * whole 4 s directive TTL.
   *
   * So the product is capped to the more extreme of its two factors: a
   * transition may take the limits as far as it would on its own, and a state
   * may too, but the two together may not go further than the bolder of them.
   * This is strictly narrowing — every combination comes out no more extreme
   * than it is today, and combinations that never stacked are untouched (one
   * factor is 1, and `clamp(x·1, min(x,1), max(x,1))` is exactly `x`).
   *
   * The alternative — letting a transition REPLACE the state's multiplier — is
   * also clean across the whole space, but it is not narrowing: it would let a
   * `catch_up` directive run at full catch-up speed while the tracker is
   * `uncertain`, which today's product deliberately damps to 0.56.
   */
  const mul = (a?: number, b?: number) => {
    const x = a ?? 1;
    const y = b ?? 1;
    return Math.min(Math.max(x, y, 1), Math.max(Math.min(x, y, 1), x * y));
  };

  // §61 degradation: a calmer, cheaper profile — never event-driven jumps.
  const degradeOmega = options.degraded ? 0.85 : 1;
  const degradeDeadband = options.degraded ? 2 : 1;

  const limits: MotionLimits = {
    omega: m.naturalFrequency * mul(s.omega, t.omega) * degradeOmega,
    zeta: m.dampingRatio * mul(s.zeta, t.zeta),
    vForwardMax: m.maxForwardVelocityPxS * mul(s.vForward, t.vForward),
    vBackwardMax: m.maxBackwardVelocityPxS * mul(s.vBackward, t.vBackward),
    aMax: m.maxAccelerationPxS2 * mul(s.accel, t.accel),
    // The jerk limit is never relaxed by a state: it is what keeps corrections
    // from reading as visual kicks (§29.2, §30.3).
    jerkMax: m.maxJerkPxS3 * mul(s.jerk, t.jerk),
    feedForwardScale: mul(s.feedForward, t.feedForward),
    restDeadbandPx: m.restDeadbandPx * (s.deadband ?? 1) * degradeDeadband,
    reverseTravelMaxPx: m.reverseTravelMaxPx,
    reanchorThresholdPx: m.reanchorThresholdPx,
    allowBackward: t.allowBackward ?? s.allowBackward ?? false,
    snap: options.reducedMotion === true,
  };

  if (options.manualGrace) {
    // Manual interaction has immediate authority; automatic correction back to
    // the old target is suppressed, not fought (§30.6).
    limits.vForwardMax = 0;
    limits.vBackwardMax = 0;
    limits.feedForwardScale = 0;
    limits.snap = false;
  }

  return limits;
}
