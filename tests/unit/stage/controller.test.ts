/**
 * JerkLimitedScrollController (companion §29, §30, §32) and the §70 motion
 * metrics it has to satisfy: no velocity discontinuity, no backward motion
 * during ordinary following, bounded overshoot, no one-frame teleport.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_SMOOTH_FOLLOW_PROFILE } from '../../../src/shared/contracts';
import {
  approach,
  CONTROLLER_SUBSTEP_MS,
  createFrameIntervalEstimator,
  createJerkLimitedScrollController,
  HITCH_THRESHOLD_MS,
  limitsForState,
  MAX_FRAME_DT_MS,
  stoppingDistancePx,
  type MotionLimits,
} from '../../../src/stage/motion';
import { seededRandom } from '../../fixtures/layout';

const profile = DEFAULT_SMOOTH_FOLLOW_PROFILE;
const following = limitsForState('following', profile);

/**
 * Drive the controller one integration SUB-STEP per call, so every returned
 * sample is a real integration point and the realized acceleration and jerk can
 * be recovered by finite differences of the rendered POSITION.
 *
 * This is the whole point of the harness (H1): the old tests measured jerk from
 * the STORED `plant.a`, which the overshoot guard did not go through. It could
 * rewrite `v` by a full `aMax·dt` in one sub-step — a realized jerk over
 * 600 000 px/s³ against a 12 000 px/s³ limit — while `plant.a` stayed positive
 * and the assertion stayed green.
 *
 * `q` is the only field with that property. Deriving from the reported `v`
 * fixed one instance of the mistake and left the class of it open: `v` is
 * itself a stored field the controller writes, so any path that moves the
 * document WITHOUT going through it — the §29.3 rest snap does exactly that,
 * assigning `q = target` and `v = 0` together — is invisible to a `v`-based
 * trace in precisely the way `plant.a` was. Only `q` is what the presenter
 * sees, so `q` is what the limits are measured from. Everything below is
 * `Δq/Δt` and its differences.
 */
function substepTrace(
  limits: MotionLimits,
  frames: Array<{ targetPx: number; feedForwardVelocityPxS?: number }>,
  options: { initialPositionPx?: number; maxPx?: number; minPx?: number } = {},
) {
  const dtSec = CONTROLLER_SUBSTEP_MS / 1000;
  const controller = createJerkLimitedScrollController({
    initialPositionPx: options.initialPositionPx ?? 0,
    minPx: options.minPx ?? 0,
    maxPx: options.maxPx ?? 1e7,
    substepMs: CONTROLLER_SUBSTEP_MS,
  });
  const q: number[] = [];
  /** What the controller SAYS its velocity is — never used for the limits. */
  const reportedV: number[] = [];
  const wall: boolean[] = [];
  const rest: boolean[] = [];
  for (const f of frames) {
    const step = controller.step({
      dtMs: CONTROLLER_SUBSTEP_MS,
      targetPx: f.targetPx,
      feedForwardVelocityPxS: f.feedForwardVelocityPxS ?? 0,
      limits,
    });
    q.push(step.q);
    reportedV.push(step.v);
    wall.push(step.hardStop);
    rest.push(step.atRest);
  }
  // Realized velocity/acceleration/jerk from the RENDERED trace, not from any
  // stored state. Each difference costs one more leading sample.
  const v = q.map((value, i) => (i === 0 ? 0 : (value - (q[i - 1] ?? 0)) / dtSec));
  const a = v.map((value, i) => (i <= 1 ? 0 : (value - (v[i - 1] ?? 0)) / dtSec));
  const jerk = a.map((value, i) => (i <= 2 ? 0 : (value - (a[i - 1] ?? 0)) / dtSec));
  return { controller, q, v, reportedV, a, jerk, wall, rest, dtSec };
}

/** First sample at which every derivative above is a real measurement. */
const FIRST_DERIVED_SAMPLE = 3;

/**
 * Relative slack for a limit compared against a value recovered by THREE finite
 * differences of `q`. Dividing by `dtSec³` (5.12e-7 at an 8 ms sub-step)
 * amplifies double-precision error in a ~6000 px position by a factor of ~2e6,
 * which is a few parts in 1e10 of `jerkMax` — and nothing like the orders of
 * magnitude a real violation shows.
 */
const LIMIT_SLACK = 1 + 1e-6;

/**
 * A wall (document edge, §30.5 reverse-travel budget) is a genuine
 * discontinuity, so the sub-step it happens on and the two after it are the
 * places realized jerk is legitimately unbounded. Everything else must obey the
 * profile. `hardStop` makes that exemption explicit instead of a loosened
 * tolerance that would hide a real defect.
 */
function nearWall(wall: boolean[], i: number): boolean {
  return wall[i] === true || wall[i - 1] === true || wall[i - 2] === true;
}

/**
 * The §29.3 rest snap closes a sub-deadband gap by writing `q` directly. It is
 * a settle, not motion, and it is bounded by `restDeadbandPx` — but measured
 * from `q` it is a step, so it gets the same explicit exemption a wall does
 * rather than a loosened tolerance. (Measuring from `v` hid it entirely, which
 * is the reason this exemption has to be written down at all.)
 */
function nearRest(rest: boolean[], i: number): boolean {
  return rest[i] === true || rest[i - 1] === true || rest[i - 2] === true;
}

function run(
  limits: MotionLimits,
  frames: Array<{ dtMs: number; targetPx: number; feedForwardVelocityPxS?: number }>,
  options: { initialPositionPx?: number; maxPx?: number } = {},
) {
  const controller = createJerkLimitedScrollController({
    initialPositionPx: options.initialPositionPx ?? 0,
    maxPx: options.maxPx ?? 1e6,
  });
  const trace = [];
  for (const f of frames) {
    trace.push(
      controller.step({
        dtMs: f.dtMs,
        targetPx: f.targetPx,
        feedForwardVelocityPxS: f.feedForwardVelocityPxS ?? 0,
        limits,
      }),
    );
  }
  return { controller, trace };
}

describe('controller limits (§29.1)', () => {
  it('never exceeds velocity, acceleration, or jerk limits over random frame sequences', () => {
    const random = seededRandom(20260724);
    for (let iteration = 0; iteration < 40; iteration++) {
      const controller = createJerkLimitedScrollController({ maxPx: 1e7 });
      let previousV = 0;
      let previousA = 0;
      let target = 0;
      for (let i = 0; i < 400; i++) {
        // Adversarial input: wild target jumps, wild feed-forward, wild dt.
        if (random() < 0.15) target += (random() - 0.2) * 4000;
        const dtMs = 4 + random() * 60;
        const step = controller.step({
          dtMs,
          targetPx: Math.max(0, target),
          feedForwardVelocityPxS: (random() - 0.3) * 3000,
          limits: following,
        });
        const dtSec = Math.min(dtMs, MAX_FRAME_DT_MS) / 1000;

        expect(step.v).toBeLessThanOrEqual(following.vForwardMax + 1e-6);
        expect(step.v).toBeGreaterThanOrEqual(-1e-6); // forward-only profile
        expect(Math.abs(step.a)).toBeLessThanOrEqual(following.aMax + 1e-6);
        // Jerk: acceleration may change by at most jerkMax·dt over the frame.
        expect(Math.abs(step.a - previousA)).toBeLessThanOrEqual(
          following.jerkMax * dtSec + 1e-6,
        );
        // Velocity is continuous: bounded by aMax·dt, never a step.
        expect(Math.abs(step.v - previousV)).toBeLessThanOrEqual(
          following.aMax * dtSec + 1e-6,
        );
        expect(Number.isFinite(step.q)).toBe(true);
        previousV = step.v;
        previousA = step.a;
      }
    }
  });

  it('never moves backward while ordinary following, even if the target jumps back', () => {
    const controller = createJerkLimitedScrollController({ initialPositionPx: 5000, maxPx: 1e6 });
    let previousQ = 5000;
    for (let i = 0; i < 200; i++) {
      const step = controller.step({
        dtMs: 16.7,
        targetPx: 1000, // a large backward correction
        feedForwardVelocityPxS: -800,
        limits: following,
      });
      expect(step.q).toBeGreaterThanOrEqual(previousQ - 1e-9);
      previousQ = step.q;
    }
  });

  it('reverses only under a backward-capable profile, and never past the travel clamp', () => {
    const rewinding = limitsForState('rewinding', profile);
    const controller = createJerkLimitedScrollController({ initialPositionPx: 6000, maxPx: 1e6 });
    for (let i = 0; i < 600; i++) {
      controller.step({
        dtMs: 16.7,
        targetPx: 0,
        feedForwardVelocityPxS: -400,
        limits: rewinding,
      });
    }
    const travelled = 6000 - controller.state.q;
    expect(travelled).toBeGreaterThan(0);
    // §30.5: a rewind may not run away — the reverse-travel clamp stops it.
    expect(travelled).toBeLessThanOrEqual(profile.motion.reverseTravelMaxPx + 5);
  });

  it('converges without meaningful overshoot (§70.5)', () => {
    const { controller, trace } = run(
      following,
      Array.from({ length: 400 }, () => ({ dtMs: 16.7, targetPx: 900 })),
    );
    const overshoot = Math.max(...trace.map((t) => t.q - 900));
    expect(controller.state.q).toBeCloseTo(900, 3);
    expect(overshoot).toBeLessThan(900 * 0.03);
    // No oscillation: velocity never changes sign after settling.
    const signs = new Set(trace.slice(50).map((t) => Math.sign(t.v)).filter((s) => s !== 0));
    expect(signs.size).toBeLessThanOrEqual(1);
  });

  it('tracks a steadily moving target using feed-forward instead of chronic lag', () => {
    const controller = createJerkLimitedScrollController({ maxPx: 1e6 });
    const velocity = 220; // px/s
    let target = 0;
    let lastError = Infinity;
    for (let i = 0; i < 300; i++) {
      target += velocity * 0.0167;
      const step = controller.step({
        dtMs: 16.7,
        targetPx: target,
        feedForwardVelocityPxS: velocity,
        limits: following,
      });
      lastError = Math.abs(step.errorPx);
    }
    // Sub-frame discretization only: the fixture advances the target before the
    // step, so a fraction of one frame of travel remains.
    expect(lastError).toBeLessThan(5);
    expect(controller.state.v).toBeCloseTo(velocity, 0);
  });
});

describe('frame-time and hitch handling (§32)', () => {
  it('clamps a huge frame gap instead of integrating it', () => {
    const controller = createJerkLimitedScrollController({ maxPx: 1e6 });
    const normal = controller.step({
      dtMs: 16.7,
      targetPx: 100000,
      feedForwardVelocityPxS: 0,
      limits: following,
    });
    const hitchController = createJerkLimitedScrollController({ maxPx: 1e6 });
    const hitched = hitchController.step({
      dtMs: 5000, // tab was hidden / GC pause
      targetPx: 100000,
      feedForwardVelocityPxS: 0,
      limits: following,
    });
    expect(hitched.hitch).toBe(true);
    expect(hitched.integratedMs).toBe(MAX_FRAME_DT_MS);
    // Bounded by the velocity limit over the capped step — not a teleport.
    expect(hitched.q).toBeLessThanOrEqual(
      (following.vForwardMax * MAX_FRAME_DT_MS) / 1000 + 1e-6,
    );
    expect(hitched.q).toBeGreaterThan(normal.q);
  });

  it('produces comparable motion at 60 Hz and 120 Hz (§32.3)', () => {
    const at60 = run(
      following,
      Array.from({ length: 120 }, () => ({ dtMs: 1000 / 60, targetPx: 700 })),
    );
    const at120 = run(
      following,
      Array.from({ length: 240 }, () => ({ dtMs: 1000 / 120, targetPx: 700 })),
    );
    expect(Math.abs(at60.controller.state.q - at120.controller.state.q)).toBeLessThan(2);
  });

  it('is stable with a zero-length frame', () => {
    const { trace } = run(following, [{ dtMs: 0, targetPx: 500 }]);
    expect(trace[0]?.q).toBe(0);
    expect(Number.isFinite(trace[0]?.v ?? NaN)).toBe(true);
  });
});

describe('rest, bounds, and authority (§29.3, §26.3)', () => {
  it('snaps to rest inside the deadband and stops shimmering', () => {
    const { controller, trace } = run(
      following,
      Array.from({ length: 300 }, () => ({ dtMs: 16.7, targetPx: 250 })),
    );
    expect(trace[trace.length - 1]?.atRest).toBe(true);
    expect(controller.state.v).toBe(0);
    expect(controller.state.a).toBe(0);
    expect(controller.state.q).toBe(250);
  });

  it('clamps to the scroll bounds without accumulating velocity', () => {
    const controller = createJerkLimitedScrollController({ maxPx: 500 });
    for (let i = 0; i < 200; i++) {
      controller.step({
        dtMs: 16.7,
        targetPx: 99999,
        feedForwardVelocityPxS: 5000,
        limits: following,
      });
    }
    expect(controller.state.q).toBe(500);
    expect(controller.state.v).toBe(0);
  });

  it('only reanchor() may overwrite plant state', () => {
    const controller = createJerkLimitedScrollController({ maxPx: 1e6 });
    controller.step({
      dtMs: 16.7,
      targetPx: 4000,
      feedForwardVelocityPxS: 300,
      limits: following,
    });
    expect(controller.state.v).toBeGreaterThan(0);
    controller.reanchor(9000);
    expect(controller.state.q).toBe(9000);
    expect(controller.state.v).toBe(0);
    expect(controller.state.a).toBe(0);
  });

  it('reduced motion follows the target exactly, with no dynamics', () => {
    const snap = limitsForState('following', profile, { reducedMotion: true });
    const { controller } = run(snap, [
      { dtMs: 16.7, targetPx: 100 },
      { dtMs: 16.7, targetPx: 4000 },
    ]);
    expect(controller.state.q).toBe(4000);
    expect(controller.state.a).toBe(0);
  });
});

describe('per-state motion profiles (§30)', () => {
  it('catch-up raises velocity and acceleration but never relaxes the jerk limit', () => {
    const catching = limitsForState('catching_up', profile);
    expect(catching.vForwardMax).toBeGreaterThan(following.vForwardMax);
    expect(catching.aMax).toBeGreaterThan(following.aMax);
    expect(catching.jerkMax).toBe(following.jerkMax);
  });

  it('uncertainty slows down and damps harder rather than freezing', () => {
    const uncertain = limitsForState('uncertain', profile);
    expect(uncertain.vForwardMax).toBeGreaterThan(0);
    expect(uncertain.vForwardMax).toBeLessThan(following.vForwardMax);
    expect(uncertain.zeta).toBeGreaterThan(following.zeta);
    expect(uncertain.feedForwardScale).toBeLessThan(1);
  });

  it('retake_pending refuses to reverse before the semantic commit (§30.4)', () => {
    expect(limitsForState('retake_pending', profile).allowBackward).toBe(false);
    expect(limitsForState('rewinding', profile).allowBackward).toBe(true);
  });

  it('manual grace suspends automatic correction entirely (§30.6)', () => {
    const manual = limitsForState('following', profile, { manualGrace: true });
    const { controller } = run(manual, [
      { dtMs: 16.7, targetPx: 5000, feedForwardVelocityPxS: 900 },
    ]);
    expect(controller.state.q).toBe(0);
  });

  it('degradation simplifies the profile without switching to jumps (§61)', () => {
    const degraded = limitsForState('following', profile, { degraded: true });
    expect(degraded.omega).toBeLessThan(following.omega);
    expect(degraded.restDeadbandPx).toBeGreaterThan(following.restDeadbandPx);
    expect(degraded.snap).toBe(false);
  });
});

describe('approach()', () => {
  it('moves toward the target by at most the allowance', () => {
    expect(approach(0, 10, 3)).toBe(3);
    expect(approach(0, -10, 3)).toBe(-3);
    expect(approach(0, 2, 3)).toBe(2);
  });
});

describe('stoppingDistancePx()', () => {
  const { aMax, maxJerkPxS3: jerk } = {
    aMax: profile.motion.maxAccelerationPxS2 * 0.6,
    maxJerkPxS3: profile.motion.maxJerkPxS3,
  };

  it('is zero at rest and grows with speed', () => {
    expect(stoppingDistancePx(0, 0, aMax, jerk)).toBe(0);
    expect(stoppingDistancePx(-50, 0, aMax, jerk)).toBe(0);
    expect(stoppingDistancePx(600, 0, aMax, jerk)).toBeGreaterThan(
      stoppingDistancePx(300, 0, aMax, jerk),
    );
  });

  it('accounts for the acceleration the plant is CURRENTLY carrying', () => {
    // The whole reason the old guard did not work: `v²/2a` assumes braking can
    // begin instantly. A jerk-limited plant still accelerating at aMax has
    // already committed to a large amount of extra travel.
    const coasting = stoppingDistancePx(500, 0, aMax, jerk);
    const accelerating = stoppingDistancePx(500, profile.motion.maxAccelerationPxS2, aMax, jerk);
    expect(accelerating).toBeGreaterThan(coasting * 1.5);
  });

  it('predicts the real stopping distance to within the reserved authority', () => {
    // Sanity: brake from a standstill target and compare the prediction against
    // what the controller actually travels.
    const predicted = stoppingDistancePx(400, 0, aMax, jerk);
    const controller = createJerkLimitedScrollController({ maxPx: 1e7 });
    controller.reanchor(0, { velocityPxS: 400 });
    const start = controller.state.q;
    for (let i = 0; i < 400; i++) {
      controller.step({
        dtMs: CONTROLLER_SUBSTEP_MS,
        targetPx: 0, // "stop here" — error is always ≤ 0, so brake at once
        feedForwardVelocityPxS: 0,
        limits: following,
      });
    }
    const travelled = controller.state.q - start;
    expect(travelled).toBeGreaterThan(0);
    // Real braking uses the full aMax, so it stops sooner than the 0.6-authority
    // prediction — the guard is conservative, which is the safe direction.
    expect(travelled).toBeLessThanOrEqual(predicted + 1);
  });
});

/**
 * H1 — the motion limits measured from the RENDERED trace.
 *
 * Every assertion here derives acceleration and jerk from finite differences of
 * `q`/`v` per integration sub-step, so a guard that reaches around the
 * acceleration state to rewrite velocity is visible instead of invisible.
 */
describe('realized motion limits (§29.2, §70)', () => {
  it('keeps realized acceleration and jerk inside the limits under adversarial targets', () => {
    const random = seededRandom(70705);
    for (let iteration = 0; iteration < 12; iteration++) {
      let target = 4000;
      const frames = Array.from({ length: 1200 }, () => {
        if (random() < 0.05) target += (random() - 0.35) * 4000;
        return {
          targetPx: Math.max(0, target),
          feedForwardVelocityPxS: (random() - 0.3) * 2000,
        };
      });
      const trace = substepTrace(following, frames, { initialPositionPx: 1000 });
      // Forward-only following never reaches a wall in this corpus.
      expect(trace.wall.some(Boolean)).toBe(false);
      for (let i = FIRST_DERIVED_SAMPLE; i < trace.a.length; i++) {
        if (nearRest(trace.rest, i)) continue;
        expect(Math.abs(trace.a[i] ?? 0)).toBeLessThanOrEqual(following.aMax * LIMIT_SLACK);
        expect(Math.abs(trace.jerk[i] ?? 0)).toBeLessThanOrEqual(following.jerkMax * LIMIT_SLACK);
      }
    }
  });

  it('keeps them inside the limits for a backward-capable profile too', () => {
    // Under `rewinding` the reverse-travel clamp used to slam `v` to zero from
    // full rewind speed — a 60 000 px/s³ realized jerk that the stored-`a`
    // assertions could not see.
    const rewinding = limitsForState('rewinding', profile);
    const random = seededRandom(30503);
    let target = 6000;
    const frames = Array.from({ length: 1500 }, () => {
      if (random() < 0.05) target += (random() - 0.7) * 5000;
      return {
        targetPx: Math.max(0, target),
        feedForwardVelocityPxS: (random() - 0.6) * 1500,
      };
    });
    const trace = substepTrace(rewinding, frames, { initialPositionPx: 6000 });
    for (let i = FIRST_DERIVED_SAMPLE; i < trace.a.length; i++) {
      if (nearWall(trace.wall, i) || nearRest(trace.rest, i)) continue;
      expect(Math.abs(trace.a[i] ?? 0)).toBeLessThanOrEqual(rewinding.aMax * LIMIT_SLACK);
      expect(Math.abs(trace.jerk[i] ?? 0)).toBeLessThanOrEqual(rewinding.jerkMax * LIMIT_SLACK);
    }
    // The guard brakes INTO the travel budget, so the speed left when the wall
    // does arrive is a fraction of a rendered line per second — not the
    // full-speed dead stop the old clamp produced.
    for (let i = 1; i < trace.wall.length; i++) {
      if (!trace.wall[i]) continue;
      const step = Math.abs((trace.v[i] ?? 0) - (trace.v[i - 1] ?? 0));
      expect(step, `wall velocity step at ${i}`).toBeLessThan(60);
    }
  });

  it('brakes without a jerk step when the target regresses mid-motion (§70.5)', () => {
    // The scenario: the plant is at 1000 px moving forward, a newer ordinary
    // frame revises the target BACKWARD to 950 while still reporting positive
    // speech velocity. The old guard answered by rewriting `v` — realized
    // acceleration jumped to −aMax in one sub-step while `plant.a` stayed
    // positive.
    const frames = [
      ...Array.from({ length: 60 }, () => ({
        targetPx: 1400,
        feedForwardVelocityPxS: 300,
      })),
      ...Array.from({ length: 400 }, () => ({
        targetPx: 950,
        feedForwardVelocityPxS: 300,
      })),
    ];
    const trace = substepTrace(following, frames, { initialPositionPx: 1000 });
    for (let i = FIRST_DERIVED_SAMPLE; i < trace.a.length; i++) {
      if (nearRest(trace.rest, i)) continue;
      expect(Math.abs(trace.jerk[i] ?? 0)).toBeLessThanOrEqual(following.jerkMax * LIMIT_SLACK);
    }
    // Forward-only, so it cannot come back — but it must not sail far past
    // either. (The engine's forward latch is what stops the regression reaching
    // the controller at all in production; see engine.test.ts.)
    expect(trace.controller.state.v).toBeGreaterThanOrEqual(0);
  });

  it('stops within the remaining error instead of sailing past it', () => {
    // A large forward correction, then the target stops moving: the plant must
    // arrive without overshooting, because reverse is forbidden and any
    // overshoot is therefore permanent.
    for (const distance of [200, 900, 3000]) {
      const trace = substepTrace(
        following,
        Array.from({ length: 1500 }, () => ({ targetPx: distance })),
      );
      const overshoot = Math.max(...trace.q) - distance;
      expect(overshoot, `overshoot at ${distance}px`).toBeLessThanOrEqual(
        following.restDeadbandPx,
      );
      expect(trace.controller.state.q).toBeCloseTo(distance, 3);
    }
  });

  it('never snaps the position backward inside the rest deadband', () => {
    // §29.3's settle may close a sub-deadband gap, but "ordinary following never
    // moves backward" has to hold at 1.5 px as much as at 150 px.
    const trace = substepTrace(
      following,
      [
        ...Array.from({ length: 900 }, () => ({ targetPx: 500 })),
        // Target creeps back inside the deadband.
        ...Array.from({ length: 200 }, () => ({ targetPx: 499 })),
      ],
      { initialPositionPx: 0 },
    );
    let previous = -Infinity;
    for (const value of trace.q) {
      expect(value).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = value;
    }
  });

  it('comes to a stop in bounded time and distance when evidence stops (§27)', () => {
    // Evidence loss shows up as feed-forward going to zero with the target
    // frozen: the plant must settle, not drift.
    const spinUp = Array.from({ length: 200 }, () => ({
      targetPx: 100000,
      feedForwardVelocityPxS: 800,
    }));
    const trace = substepTrace(following, [
      ...spinUp,
      ...Array.from({ length: 600 }, (_, i) => ({
        // The last target it ever saw, held.
        targetPx: 0,
        feedForwardVelocityPxS: 0,
        _: i,
      })),
    ]);
    const stopIndex = trace.v.findIndex((value, i) => i > spinUp.length && value === 0);
    expect(stopIndex).toBeGreaterThan(spinUp.length);
    const stopTimeMs = (stopIndex - spinUp.length) * CONTROLLER_SUBSTEP_MS;
    // Bounded by the jerk ramp plus the brake, not by the size of the error.
    expect(stopTimeMs).toBeLessThan(1200);
    const stopDistance = (trace.q[stopIndex] ?? 0) - (trace.q[spinUp.length] ?? 0);
    expect(stopDistance).toBeLessThan(400);
  });

  it('crosses the catch-up safety bound without exceeding it (§30.3)', () => {
    const catching = limitsForState('catching_up', profile);
    expect(catching.jerkMax).toBe(following.jerkMax);
    const trace = substepTrace(
      catching,
      Array.from({ length: 900 }, () => ({ targetPx: 20000, feedForwardVelocityPxS: 900 })),
    );
    expect(Math.max(...trace.v)).toBeLessThanOrEqual(catching.vForwardMax + 1e-6);
    for (let i = FIRST_DERIVED_SAMPLE; i < trace.a.length; i++) {
      if (nearRest(trace.rest, i)) continue;
      expect(Math.abs(trace.a[i] ?? 0)).toBeLessThanOrEqual(catching.aMax * LIMIT_SLACK);
      expect(Math.abs(trace.jerk[i] ?? 0)).toBeLessThanOrEqual(catching.jerkMax * LIMIT_SLACK);
    }
  });

  it('reports saturation while limiting, and not while cruising', () => {
    const controller = createJerkLimitedScrollController({ maxPx: 1e7 });
    const hard = controller.step({
      dtMs: 16.7,
      targetPx: 1e6,
      feedForwardVelocityPxS: 5000,
      limits: following,
    });
    expect(hard.saturated).toBe(true);
    for (let i = 0; i < 600; i++) {
      controller.step({ dtMs: 16.7, targetPx: 400, feedForwardVelocityPxS: 0, limits: following });
    }
    const settled = controller.step({
      dtMs: 16.7,
      targetPx: 400,
      feedForwardVelocityPxS: 0,
      limits: following,
    });
    expect(settled.atRest).toBe(true);
    expect(settled.saturated).toBe(false);
  });

  it('survives varied-refresh jitter without a jerk excursion', () => {
    // 60 Hz that drops the odd frame, plus vsync jitter — the shape of a real
    // 120 Hz panel sharing a GPU with a video decode.
    const random = seededRandom(120120);
    const controller = createJerkLimitedScrollController({ maxPx: 1e7 });
    let target = 0;
    let previousV = 0;
    let previousA = 0;
    let previousDtSec = 1 / 120;
    for (let i = 0; i < 2000; i++) {
      target += 6;
      const dtMs = random() < 0.1 ? 8 + random() * 40 : 1000 / 120 + (random() - 0.5) * 2;
      const step = controller.step({
        dtMs,
        targetPx: target,
        feedForwardVelocityPxS: 360,
        limits: following,
      });
      const dtSec = Math.min(dtMs, MAX_FRAME_DT_MS) / 1000;
      const realizedA = (step.v - previousV) / dtSec;
      // Averaged over a whole frame, realized acceleration stays inside the
      // profile: a longer frame can only average, never amplify. Frame-averaged
      // jerk is compared over the span the two averages cover, because two
      // frames of very different length have their averages centred at
      // different times.
      expect(Math.abs(realizedA)).toBeLessThanOrEqual(following.aMax + 1e-6);
      expect(Math.abs(realizedA - previousA)).toBeLessThanOrEqual(
        following.jerkMax * (dtSec + previousDtSec) + 1e-6,
      );
      previousV = step.v;
      previousA = realizedA;
      previousDtSec = dtSec;
    }
  });
});

/**
 * C1 — the finite-value fuse. The plant is persistent, so a single non-finite
 * input must hold safely rather than propagate.
 */
describe('finite-value fuse (C1)', () => {
  function healthyController() {
    const controller = createJerkLimitedScrollController({ maxPx: 1e6 });
    for (let i = 0; i < 40; i++) {
      controller.step({ dtMs: 16.7, targetPx: 4000, feedForwardVelocityPxS: 300, limits: following });
    }
    return controller;
  }

  it.each([
    ['targetPx', { targetPx: Number.NaN }],
    ['targetPx infinite', { targetPx: Number.POSITIVE_INFINITY }],
    ['feedForwardVelocityPxS', { feedForwardVelocityPxS: Number.NaN }],
  ] as const)('holds without mutating plant state on a non-finite %s', (_name, patch) => {
    const controller = healthyController();
    const before = { ...controller.state };
    const step = controller.step({
      dtMs: 16.7,
      targetPx: 4000,
      feedForwardVelocityPxS: 300,
      limits: following,
      ...patch,
    });
    expect(step.fused).toBe(true);
    expect(controller.state.q).toBe(before.q);
    expect(controller.state.v).toBe(before.v);
    expect(controller.state.a).toBe(before.a);
    expect(Number.isFinite(step.q)).toBe(true);
  });

  it.each([
    'omega',
    'zeta',
    'vForwardMax',
    'vBackwardMax',
    'aMax',
    'jerkMax',
    'feedForwardScale',
    'restDeadbandPx',
    'reverseTravelMaxPx',
    'reanchorThresholdPx',
  ] as const)('holds on a non-finite %s limit', (key) => {
    const controller = healthyController();
    const before = { ...controller.state };
    const step = controller.step({
      dtMs: 16.7,
      targetPx: 4000,
      feedForwardVelocityPxS: 300,
      limits: { ...following, [key]: Number.NaN },
    });
    expect(step.fused).toBe(true);
    expect(controller.state).toEqual(before);
  });

  it('resumes normally on the very next sound frame', () => {
    const controller = healthyController();
    const before = { ...controller.state };
    controller.step({
      dtMs: 16.7,
      targetPx: Number.NaN,
      feedForwardVelocityPxS: 300,
      limits: following,
    });
    const resumed = controller.step({
      dtMs: 16.7,
      targetPx: 4000,
      feedForwardVelocityPxS: 300,
      limits: following,
    });
    expect(resumed.fused).toBe(false);
    expect(Number.isFinite(resumed.q)).toBe(true);
    // Momentum was preserved, so there is no restart kick.
    expect(resumed.q).toBeGreaterThan(before.q);
  });

  it('refuses a non-finite reanchor rather than poisoning the plant', () => {
    const controller = healthyController();
    const before = { ...controller.state };
    controller.reanchor(Number.NaN);
    expect(controller.state).toEqual(before);
    controller.reanchor(500, { velocityPxS: Number.NaN });
    expect(controller.state.q).toBe(500);
    expect(controller.state.v).toBe(0);
  });

  it('never renders a non-finite position after a poisoned frame', () => {
    const controller = createJerkLimitedScrollController({ maxPx: 1e6 });
    for (let i = 0; i < 300; i++) {
      const poisoned = i % 7 === 0;
      const step = controller.step({
        dtMs: 16.7,
        targetPx: poisoned ? Number.NaN : 3000,
        feedForwardVelocityPxS: poisoned ? Number.NaN : 250,
        limits: following,
      });
      expect(Number.isFinite(step.q)).toBe(true);
      expect(Number.isFinite(step.v)).toBe(true);
      expect(Number.isFinite(step.a)).toBe(true);
    }
    expect(controller.state.q).toBeGreaterThan(100);
  });
});

/**
 * §70.8. A hitch is a MISSED REFRESH, and "missed" is only definable against
 * the refresh the display actually has. The threshold was a fixed 28 ms, which
 * is below a 30 Hz panel's 33.3 ms period — so on one of those every healthy
 * frame was a dropped frame, degradation tripped in 4 s, and the 0.05 recovery
 * ratio could never be met because the numerator was every frame.
 */
describe('frame-interval estimator (§70.8)', () => {
  function feed(
    estimator: ReturnType<typeof createFrameIntervalEstimator>,
    intervalMs: number,
    count: number,
  ): number {
    let threshold = 0;
    for (let i = 0; i < count; i++) threshold = estimator.observe(intervalMs);
    return threshold;
  }

  it('learns 60, 30 and 120 Hz from the deltas alone', () => {
    for (const hz of [120, 60, 30]) {
      const estimator = createFrameIntervalEstimator();
      feed(estimator, 1000 / hz, 120);
      expect(estimator.nominalMs, `${hz} Hz`).toBeCloseTo(1000 / hz, 6);
    }
  });

  it('does not call a display’s own refresh interval a hitch', () => {
    for (const hz of [120, 90, 60, 30, 24]) {
      const estimator = createFrameIntervalEstimator();
      const threshold = feed(estimator, 1000 / hz, 120);
      expect(threshold, `${hz} Hz`).toBeGreaterThan(1000 / hz);
    }
  });

  it('does call a missed refresh a hitch at 60 Hz and below', () => {
    for (const hz of [60, 30, 24]) {
      const estimator = createFrameIntervalEstimator();
      const threshold = feed(estimator, 1000 / hz, 120);
      // One dropped refresh is two periods.
      expect(threshold, `${hz} Hz`).toBeLessThan(2000 / hz);
    }
  });

  it('never tightens below the seed, so 120 Hz is not held to a 12 ms budget', () => {
    // Deliberate policy, not an oversight: motion is refresh-rate independent
    // (§32.3), and a frame that lands inside a 60 Hz budget is not something a
    // presenter can see. Holding a 144 Hz panel to 8 ms would report dropped
    // frames — and trip §61 degradation — for output that looks perfect.
    const estimator = createFrameIntervalEstimator();
    const threshold = feed(estimator, 1000 / 120, 120);
    expect(threshold).toBeGreaterThanOrEqual(HITCH_THRESHOLD_MS);
    expect(estimator.nominalMs).toBeCloseTo(1000 / 120, 6);
  });

  it('uses the seed until it has enough samples to measure with', () => {
    const estimator = createFrameIntervalEstimator();
    expect(estimator.nominalMs).toBeNull();
    expect(estimator.thresholdMs).toBe(HITCH_THRESHOLD_MS);
    expect(feed(estimator, 1000 / 30, 5)).toBe(HITCH_THRESHOLD_MS);
  });

  it('is not moved by the outliers it exists to detect', () => {
    // A 60 Hz display dropping a third of its frames must still measure 60 Hz;
    // a mean would drift up until the drops stopped being visible at all.
    const estimator = createFrameIntervalEstimator();
    for (let i = 0; i < 300; i++) estimator.observe(i % 3 === 2 ? 50 : 1000 / 60);
    expect(estimator.nominalMs).toBeCloseTo(1000 / 60, 6);
    expect(estimator.thresholdMs).toBeLessThan(50);
  });

  it('ignores a resumed-window gap rather than adopting it as the period', () => {
    const estimator = createFrameIntervalEstimator();
    feed(estimator, 1000 / 60, 120);
    const before = estimator.nominalMs;
    estimator.observe(9000); // hidden window, then restored
    for (let i = 0; i < 20; i++) estimator.observe(1000 / 60);
    expect(estimator.nominalMs).toBeCloseTo(before ?? -1, 6);
  });

  it('adapts when the stage window moves to a different display', () => {
    const estimator = createFrameIntervalEstimator();
    feed(estimator, 1000 / 60, 120);
    feed(estimator, 1000 / 30, 120);
    expect(estimator.nominalMs).toBeCloseTo(1000 / 30, 6);
  });

  it('never lets the threshold exceed the integration cap', () => {
    const estimator = createFrameIntervalEstimator();
    const threshold = feed(estimator, 200, 120); // a 5 Hz slideshow
    expect(threshold).toBeLessThanOrEqual(MAX_FRAME_DT_MS);
  });

  it('resets to the seed', () => {
    const estimator = createFrameIntervalEstimator();
    feed(estimator, 1000 / 30, 120);
    estimator.reset();
    expect(estimator.nominalMs).toBeNull();
    expect(estimator.thresholdMs).toBe(HITCH_THRESHOLD_MS);
  });
});
