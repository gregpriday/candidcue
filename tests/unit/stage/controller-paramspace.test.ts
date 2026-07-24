/**
 * The controller across its WHOLE parameter space (companion §29, §30, §70).
 *
 * The existing controller suite pins realized limits under one profile at a
 * time, at constant limits, on a handful of hand-written traces. Two doors were
 * left open by that shape, and both were open in production:
 *
 *  - **limits that change BETWEEN frames.** Every realized-limit trace ran at
 *    constant limits, so the residual velocity net — the one place a limit
 *    change could put a step into the position trace — was never measured
 *    across one. A stacked catch-up expiring into `following` cut velocity by
 *    1404 px/s in a single 8 ms sub-step (a realized −175,500 px/s² against an
 *    aMax of 2600) and did not raise `hardStop`, so even the wall-exemption
 *    discipline could not see it. The trigger is mundane: a `catch_up`
 *    directive reaching its 4 s TTL.
 *  - **stacked profiles.** Nothing sampled state × transition combinations, so
 *    the ones where a state multiplier and a transition multiplier compounded
 *    were never run at all. Three of them sustained a LIMIT CYCLE around a
 *    static target — 106–162 px of tail oscillation, 63–78 reversals over 32 s,
 *    the overshoot guard saturated on ~99% of sub-steps — which is the text
 *    visibly rocking about two and a half lines while nothing is happening.
 *
 * Everything below is measured from `q`, the rendered position, because that is
 * the only quantity the presenter can see and the only one no internal write
 * can bypass.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SMOOTH_FOLLOW_PROFILE as PROFILE,
  type TrackingStateV2,
} from '../../../src/shared/contracts';
import {
  CONTROLLER_SUBSTEP_MS,
  createJerkLimitedScrollController,
  limitsForState,
  type MotionLimits,
} from '../../../src/stage/motion';

const DT = CONTROLLER_SUBSTEP_MS;
const DT_S = DT / 1000;
/** Relative slack for a limit recovered by three finite differences of `q`. */
const LIMIT_SLACK = 1 + 1e-6;

const STATES: TrackingStateV2[] = [
  'acquiring',
  'following',
  'coasting',
  'uncertain',
  'adlib_hold',
  'catching_up',
  'retake_pending',
  'rewinding',
  'reanchoring',
  'command_pending',
  'paused',
  'reconnecting',
  'lost_local',
];
const TRANSITIONS = [undefined, 'settle', 'catch_up', 'rewind', 'reanchor', 'reset'] as const;

interface Trace {
  q: number[];
  v: number[];
  a: number[];
  jerk: number[];
  wall: boolean[];
  rest: boolean[];
  saturated: boolean[];
}

/** Run a sequence of sub-steps and derive every rate from `q`. */
function trace(
  frames: Array<{ targetPx: number; ff?: number; limits: MotionLimits }>,
  options: { initialPositionPx?: number } = {},
): Trace {
  const controller = createJerkLimitedScrollController({
    initialPositionPx: options.initialPositionPx ?? 0,
    minPx: 0,
    maxPx: 1e7,
    substepMs: DT,
  });
  const q: number[] = [];
  const wall: boolean[] = [];
  const rest: boolean[] = [];
  const saturated: boolean[] = [];
  for (const f of frames) {
    const step = controller.step({
      dtMs: DT,
      targetPx: f.targetPx,
      feedForwardVelocityPxS: f.ff ?? 0,
      limits: f.limits,
    });
    q.push(step.q);
    wall.push(step.hardStop);
    rest.push(step.atRest);
    saturated.push(step.saturated);
  }
  const v = q.map((value, i) => (i === 0 ? 0 : (value - (q[i - 1] ?? 0)) / DT_S));
  const a = v.map((value, i) => (i <= 1 ? 0 : (value - (v[i - 1] ?? 0)) / DT_S));
  const jerk = a.map((value, i) => (i <= 2 ? 0 : (value - (a[i - 1] ?? 0)) / DT_S));
  return { q, v, a, jerk, wall, rest, saturated };
}

/** A wall or a rest snap is a documented step; three samples of skirt each. */
function exempt(t: Trace, i: number): boolean {
  for (let k = Math.max(0, i - 2); k <= i; k++) {
    if (t.wall[k] || t.rest[k]) return true;
  }
  return false;
}

function combos(): Array<{ label: string; limits: MotionLimits }> {
  const out: Array<{ label: string; limits: MotionLimits }> = [];
  for (const state of STATES) {
    for (const transition of TRANSITIONS) {
      for (const degraded of [false, true]) {
        const limits = limitsForState(state, PROFILE, { transition, degraded });
        // Reduced motion follows the target exactly and has no dynamics.
        if (limits.snap) continue;
        out.push({
          label: `${state}/${transition ?? 'none'}${degraded ? '/degraded' : ''}`,
          limits,
        });
      }
    }
  }
  return out;
}

describe('realized limits hold for every state × transition × degraded profile', () => {
  it('honours v, a and jerk on a step, a ramp, and a regression', () => {
    const violations: string[] = [];
    for (const { label, limits } of combos()) {
      const scenarios: Record<string, Array<{ targetPx: number; ff?: number }>> = {
        step: Array.from({ length: 4000 }, () => ({ targetPx: 5000 })),
        ramp: Array.from({ length: 4000 }, (_, i) => ({
          targetPx: 1.3 * limits.vForwardMax * DT_S * i,
          ff: 1.3 * limits.vForwardMax,
        })),
        regress: [
          ...Array.from({ length: 400 }, () => ({ targetPx: 3000, ff: 400 })),
          ...Array.from({ length: 3000 }, () => ({ targetPx: 200, ff: -300 })),
        ],
      };
      for (const [name, frames] of Object.entries(scenarios)) {
        const t = trace(
          frames.map((f) => ({ ...f, limits })),
          { initialPositionPx: name === 'regress' ? 2000 : 0 },
        );
        for (let i = 3; i < t.q.length; i++) {
          if (exempt(t, i)) continue;
          const v = t.v[i] ?? 0;
          if (v > limits.vForwardMax * LIMIT_SLACK + 1e-3) {
            violations.push(`${label} ${name}@${i} v+=${v.toFixed(1)}`);
          }
          const floor = limits.allowBackward ? -limits.vBackwardMax * LIMIT_SLACK - 1e-3 : -1e-3;
          if (v < floor) violations.push(`${label} ${name}@${i} v-=${v.toFixed(1)}`);
          if (Math.abs(t.a[i] ?? 0) > limits.aMax * LIMIT_SLACK + 1e-3) {
            violations.push(`${label} ${name}@${i} a=${(t.a[i] ?? 0).toFixed(1)}`);
          }
          if (Math.abs(t.jerk[i] ?? 0) > limits.jerkMax * LIMIT_SLACK + 1e-3) {
            violations.push(`${label} ${name}@${i} jerk=${(t.jerk[i] ?? 0).toFixed(1)}`);
          }
        }
      }
    }
    expect(violations.slice(0, 20)).toEqual([]);
  });
});

describe('no profile sustains a limit cycle around a static target (§70.5)', () => {
  /**
   * The failure this closes: stacking a state multiplier onto a transition
   * multiplier reached aMax 5824 against a `jerkMax` that is deliberately never
   * relaxed. A jerk-limited actuator needs `2·aMax/jerkMax` — 0.97 s there — to
   * swing acceleration rail to rail, and running that much lag inside a loop
   * whose stacked ω is 7.5 rad/s leaves no phase margin at all. The symptom is
   * not overshoot; it is a relay oscillation that never settles.
   */
  it('settles instead of oscillating, in every combination', () => {
    const rows: string[] = [];
    for (const { label, limits } of combos()) {
      const t = trace(
        Array.from({ length: 12000 }, () => ({ targetPx: 5000, limits })),
      );
      const tail = t.q.slice(8000);
      const amplitude = Math.max(...tail) - Math.min(...tail);
      let reversals = 0;
      let lastSign = 0;
      for (let i = 1; i < tail.length; i++) {
        const sign = Math.sign((tail[i] ?? 0) - (tail[i - 1] ?? 0));
        if (sign !== 0 && lastSign !== 0 && sign !== lastSign) reversals++;
        if (sign !== 0) lastSign = sign;
      }
      // A settled plant is allowed the deadband it settles inside, and nothing
      // more. 106 px and 63 reversals is what the stacked profiles produced.
      const allowed = limits.allowBackward ? limits.restDeadbandPx + 0.5 : 1e-6;
      if (amplitude > allowed || reversals > 2) {
        rows.push(`${label}: amp=${amplitude.toFixed(1)}px reversals=${reversals}`);
      }
    }
    expect(rows).toEqual([]);
  });

  it('names the combinations that used to oscillate, so a regression is legible', () => {
    const worst: Array<{ state: TrackingStateV2; transition: 'catch_up' | 'reanchor' | 'reset' }> = [
      { state: 'reanchoring', transition: 'catch_up' },
      { state: 'catching_up', transition: 'reanchor' },
      { state: 'catching_up', transition: 'reset' },
    ];
    for (const combo of worst) {
      const limits = limitsForState(combo.state, PROFILE, { transition: combo.transition });
      expect(limits.allowBackward).toBe(true);
      const t = trace(Array.from({ length: 12000 }, () => ({ targetPx: 5000, limits })));
      const tail = t.q.slice(8000);
      expect(
        Math.max(...tail) - Math.min(...tail),
        `${combo.state}/${combo.transition} tail amplitude`,
      ).toBeLessThanOrEqual(limits.restDeadbandPx + 0.5);
      // The overshoot guard was saturated on ~99% of sub-steps; a settled plant
      // is not fighting anything.
      const saturatedTail = t.saturated.slice(8000).filter(Boolean).length;
      expect(saturatedTail / tail.length).toBeLessThan(0.05);
    }
  });
});

describe('stacked multipliers never compound past either factor (§30)', () => {
  /**
   * The rule the profile table now enforces: a transition may take the limits
   * as far as it would on its own, a state may too, but the two together may
   * not go further than the bolder of them. `following` carries no multipliers,
   * so `limitsForState('following', …, { transition })` is exactly the
   * transition acting alone — which makes the property checkable directly.
   */
  it('keeps every combined limit between the two factors acting alone', () => {
    for (const state of STATES) {
      for (const transition of TRANSITIONS) {
        if (transition === undefined) continue;
        const both = limitsForState(state, PROFILE, { transition });
        const stateOnly = limitsForState(state, PROFILE);
        const transitionOnly = limitsForState('following', PROFILE, { transition });
        const base = limitsForState('following', PROFILE);
        for (const key of ['vForwardMax', 'vBackwardMax', 'aMax', 'omega'] as const) {
          const lo = Math.min(stateOnly[key], transitionOnly[key], base[key]);
          const hi = Math.max(stateOnly[key], transitionOnly[key], base[key]);
          expect(both[key], `${state}/${transition} ${key}`).toBeGreaterThanOrEqual(lo - 1e-9);
          expect(both[key], `${state}/${transition} ${key}`).toBeLessThanOrEqual(hi + 1e-9);
        }
      }
    }
  });

  it('still lets a transition do its job from a neutral state', () => {
    // The cap must not neuter the transitions: `catch_up` from `following` has
    // to be the full catch-up profile, or the directive means nothing.
    const base = limitsForState('following', PROFILE);
    const caught = limitsForState('following', PROFILE, { transition: 'catch_up' });
    expect(caught.vForwardMax).toBeCloseTo(base.vForwardMax * PROFILE.motion.catchUpMultiplier, 9);
    expect(caught.aMax).toBeCloseTo(base.aMax * PROFILE.motion.catchUpMultiplier, 9);
    // …and a state's own profile is untouched when no transition is active.
    const catching = limitsForState('catching_up', PROFILE);
    expect(catching.vForwardMax).toBeCloseTo(base.vForwardMax * PROFILE.motion.catchUpMultiplier, 9);
  });

  it('preserves a cautious state’s damping rather than letting a directive undo it', () => {
    // The alternative fix — letting the transition REPLACE the state — would
    // run a `catch_up` at full speed while the tracker is `uncertain`. Capping
    // the product keeps the product where it is whenever it is already the
    // least extreme of the three.
    const uncertain = limitsForState('uncertain', PROFILE);
    const both = limitsForState('uncertain', PROFILE, { transition: 'catch_up' });
    expect(both.vForwardMax).toBeGreaterThan(uncertain.vForwardMax);
    expect(both.vForwardMax).toBeLessThan(limitsForState('following', PROFILE).vForwardMax);
  });
});

describe('a profile that shrinks between frames brakes, it does not snap (§29.2)', () => {
  /** Spin the plant up to full speed against a distant target under `limits`. */
  function spinUp(limits: MotionLimits, substeps = 2000) {
    return Array.from({ length: substeps }, () => ({
      targetPx: 1e6,
      ff: limits.vForwardMax,
      limits,
    }));
  }

  it.each([
    ['following', 'a catch_up directive expiring on its 4 s timer'],
    ['uncertain', 'the tracker losing confidence mid catch-up'],
    ['adlib_hold', 'the presenter going off script mid catch-up'],
  ] as const)('downgrades into %s without a velocity step (%s)', (stateName, _why) => {
    const fast = limitsForState('catching_up', PROFILE, { transition: 'catch_up' });
    const slow = limitsForState(stateName, PROFILE);
    expect(slow.vForwardMax).toBeLessThan(fast.vForwardMax);

    const t = trace([
      ...spinUp(fast),
      ...Array.from({ length: 600 }, () => ({
        targetPx: 1e6,
        ff: slow.vForwardMax,
        limits: slow,
      })),
    ]);

    // No wall was hit: this is a limit change, not a document edge, and the
    // wall exemption must not be what makes this pass.
    expect(t.wall.some(Boolean)).toBe(false);
    for (let i = 3; i < t.q.length; i++) {
      if (exempt(t, i)) continue;
      // The plant may still be ABOVE the new ceiling while it brakes — that is
      // the honest consequence of a jerk limit — but every sub-step of the
      // braking obeys the new acceleration and jerk limits.
      expect(Math.abs(t.a[i] ?? 0), `a at ${i}`).toBeLessThanOrEqual(
        Math.max(fast.aMax, slow.aMax) * LIMIT_SLACK + 1e-3,
      );
      expect(Math.abs(t.jerk[i] ?? 0), `jerk at ${i}`).toBeLessThanOrEqual(
        slow.jerkMax * LIMIT_SLACK + 1e-3,
      );
    }

    // And it does converge: the overspeed is a transient, not a new normal.
    const settled = t.v.slice(2000 + 500);
    for (const v of settled) {
      expect(v).toBeLessThanOrEqual(slow.vForwardMax * LIMIT_SLACK + 1e-3);
    }
  });

  it('measures the worst single-sub-step velocity change across the downgrade', () => {
    const fast = limitsForState('catching_up', PROFILE, { transition: 'catch_up' });
    const slow = limitsForState('following', PROFILE);
    const t = trace([
      ...spinUp(fast),
      ...Array.from({ length: 600 }, () => ({ targetPx: 1e6, ff: slow.vForwardMax, limits: slow })),
    ]);
    let worstDv = 0;
    for (let i = 1998; i < 2100; i++) {
      worstDv = Math.max(worstDv, Math.abs((t.v[i] ?? 0) - (t.v[i - 1] ?? 0)));
    }
    // Before: −1404 px/s in one 8 ms sub-step. The bound is what aMax permits.
    expect(worstDv).toBeLessThanOrEqual(Math.max(fast.aMax, slow.aMax) * DT_S * LIMIT_SLACK + 1e-3);
  });

  it('handles the backward-capable → forward-only downgrade the same way', () => {
    // The mirror image: the plant carries rewind speed into a profile that
    // forbids reverse. Slamming `v` to zero there is the same discontinuity.
    const rewinding = limitsForState('rewinding', PROFILE, { transition: 'rewind' });
    const forwardOnly = limitsForState('following', PROFILE);
    expect(rewinding.allowBackward).toBe(true);
    expect(forwardOnly.allowBackward).toBe(false);

    const t = trace(
      [
        ...Array.from({ length: 300 }, () => ({
          targetPx: 0,
          ff: -rewinding.vBackwardMax,
          limits: rewinding,
        })),
        ...Array.from({ length: 600 }, () => ({ targetPx: 1e6, ff: 200, limits: forwardOnly })),
      ],
      { initialPositionPx: 20_000 },
    );

    for (let i = 3; i < t.q.length; i++) {
      if (exempt(t, i)) continue;
      expect(Math.abs(t.jerk[i] ?? 0), `jerk at ${i}`).toBeLessThanOrEqual(
        forwardOnly.jerkMax * LIMIT_SLACK + 1e-3,
      );
    }
    // Reverse stops promptly, and stays stopped.
    for (let i = 400; i < t.v.length; i++) {
      expect(t.v[i] ?? 0).toBeGreaterThanOrEqual(-1e-6);
    }
  });
});
