/**
 * JerkLimitedScrollController (companion §29, §30, §32) and the §70 motion
 * metrics it has to satisfy: no velocity discontinuity, no backward motion
 * during ordinary following, bounded overshoot, no one-frame teleport.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_SMOOTH_FOLLOW_PROFILE } from '../../../src/shared/contracts';
import {
  approach,
  createJerkLimitedScrollController,
  limitsForState,
  MAX_FRAME_DT_MS,
  type MotionLimits,
} from '../../../src/stage/motion';
import { seededRandom } from '../../fixtures/layout';

const profile = DEFAULT_SMOOTH_FOLLOW_PROFILE;
const following = limitsForState('following', profile);

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
