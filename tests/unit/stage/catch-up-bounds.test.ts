/**
 * §30.3's three catch-up safety bounds — duration cap, corridor-relative boost
 * decay, and the upper safety boundary (companion §30.3, §8.8, §16.3).
 *
 * Three shapes of blind spot are documented in this subsystem and every
 * assertion below is written against them:
 *
 *  - a jerk test once derived realized acceleration from a stored field the
 *    guard never updated, so it could not fail. EVERYTHING here is derived from
 *    `Δq` — the position the presenter actually sees — and never from
 *    `step.v`, `step.a`, `result.velocityPxS`, or any other reported value;
 *  - consistency tests that pass identically if the plant is deleted. Each test
 *    below asserts a MAGNITUDE, and then re-runs the identical scenario with
 *    its own bound removed and asserts the magnitude changes. A bound that does
 *    nothing fails its own mutation clause;
 *  - a tracking-error test measured against the latched target, which cannot
 *    see a runaway where the target itself is wrong. The clamp test measures
 *    the LEAD (`q − target`) rather than the error, so a plant that parks ahead
 *    of a target moving at the same speed — zero relative velocity, invisible
 *    to the overshoot guard — is exactly what it looks at.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SMOOTH_FOLLOW_PROFILE as PROFILE,
  type AlignmentSnapshot,
  type SmoothFollowProfile,
  type StageMotionState,
} from '../../../src/shared/contracts';
import {
  buildRenderedLineMap,
  createJerkLimitedScrollController,
  createStageMotionEngine,
  limitsForState,
  type StageMotionEngine,
  type StageMotionFrameResult,
  type StageRenderedLineMap,
} from '../../../src/stage/motion';
import { fixtureFingerprint, syntheticLayout } from '../../fixtures/layout';

const R = 400;

/** A following snapshot at `unit`, with its audio stamps agreeing. */
function snapshotAt(unit: number, atMs: number): AlignmentSnapshot {
  return {
    sessionGeneration: 1,
    seq: 1,
    state: 'following',
    decision: 'localConfirmed',
    confirmedToken: Math.max(0, unit - 1),
    observedToken: unit,
    rateTokensPerSecond: 3,
    evidenceAudioMs: atMs,
    atAudioMs: atMs,
    maxPredictionMs: 900,
  pauseOnsetMs: 1800,
  leadFloorMs: 550,
    confidence: 0.92,
    suggestionToken: null,
    scriptLenTokens: 10_000,
    observedAtom: unit,
    confirmedAtom: Math.max(0, unit - 1),
  };
}

/* -------------------------------------------------------------------------
 * Harnesses
 * ---------------------------------------------------------------------- */

function longMap(options: { readingBandHalfHeightPx?: number } = {}): {
  map: StageRenderedLineMap;
  maxScrollPx: number;
} {
  const layout = syntheticLayout({
    blocks: [{ kind: 'paragraph', tokens: 1400 }],
    columnWidthPx: 800,
    startY: 800,
  });
  const map = buildRenderedLineMap({
    fingerprint: fixtureFingerprint({ layoutGeneration: 1 }),
    tokens: layout.tokens,
    blocks: layout.blocks,
    readingLineStartY: R,
    ...(options.readingBandHalfHeightPx === undefined
      ? {}
      : { readingBandHalfHeightPx: options.readingBandHalfHeightPx }),
    lineHeightPx: layout.lineHeightPx,
    viewportHeightPx: 1080,
    maxScrollPx: layout.contentHeightPx,
  });
  return { map, maxScrollPx: layout.contentHeightPx };
}

function makeEngine(map: StageRenderedLineMap, maxScrollPx: number): StageMotionEngine {
  const engine = createStageMotionEngine();
  engine.configureSession(1, 0);
  engine.setLineMap(map);
  engine.setBounds(0, maxScrollPx);
  return engine;
}

interface EngineSample {
  tMs: number;
  /** Realized velocity over this frame, derived from `Δ scrollPx` only. */
  vPxS: number;
  gapPx: number;
  scrollPx: number;
  controllerState: string;
  documentOpacity: number;
}

/**
 * Drive the engine at a fixed refresh rate in one tracking state, starting the
 * plant a long way behind the presenter, and report a trace whose rates are all
 * finite differences of the rendered position.
 */
function driveCatchUp(
  engine: StageMotionEngine,
  options: {
    durationMs: number;
    startUnit: number;
    unitsPerSecond?: number;
    state?: AlignmentSnapshot['state'];
    frameHz?: number;
  },
): EngineSample[] {
  const frameHz = options.frameHz ?? 100;
  const dt = 1000 / frameHz;
  const unitsPerSecond = options.unitsPerSecond ?? 3;
  const semanticIntervalMs = 50;
  let revision = 0;
  let nextSemanticAt = 0;
  let previous: StageMotionFrameResult | null = null;
  const out: EngineSample[] = [];

  /*
   * The catch-up licence comes from an ACCEPTED FORWARD JUMP, which is what
   * catch-up now means: the engine reports a position a long way from the last
   * one and says it accepted the discontinuity. There is no `catching_up`
   * state to assert — the old vocabulary described the tracker's bookkeeping
   * rather than anything the presenter sees.
   *
   * Priming at 0 first is what makes the jump a jump: a relocation is measured
   * from where the display already was.
   */
  engine.receiveSnapshot(
    { ...snapshotAt(0, 0), rateTokensPerSecond: unitsPerSecond },
    0,
  );
  engine.frame(0);
  engine.receiveSnapshot(
    {
      ...snapshotAt(options.startUnit, 0),
      rateTokensPerSecond: unitsPerSecond,
      decision: 'jumpForwardAccepted',
      seq: 2,
    },
    0,
  );
  revision = 2;

  for (let t = 0; t <= options.durationMs; t += dt) {
    if (t >= nextSemanticAt) {
      revision++;
      const unit = options.startUnit + (unitsPerSecond * t) / 1000;
      const frame: AlignmentSnapshot = {
        ...snapshotAt(unit, t),
        seq: revision + 2,
        rateTokensPerSecond: unitsPerSecond,
        state: options.state ?? 'following',
      };
      engine.receiveSnapshot(frame, t);
      nextSemanticAt = t + semanticIntervalMs;
    }
    const result = engine.frame(t);
    out.push({
      tMs: t,
      vPxS: previous === null ? 0 : ((result.scrollPx - previous.scrollPx) / dt) * 1000,
      gapPx: result.targetPx - result.scrollPx,
      scrollPx: result.scrollPx,
      controllerState: result.controllerState,
      documentOpacity: result.documentOpacity,
    });
    previous = result;
  }
  return out;
}

/* -------------------------------------------------------------------------
 * 1. Duration cap
 * ---------------------------------------------------------------------- */

describe('§30.3 duration cap', () => {
  /**
   * The catch-up here CANNOT close inside the cap: the plant starts ~6000 px
   * behind and the boosted ceiling is 1440 px/s, so closing takes over four
   * seconds against a 2.5 s cap. The map carries no reading corridor, so the
   * other two bounds are inert and this measures the cap alone.
   */
  function run(profile: SmoothFollowProfile) {
    const { map, maxScrollPx } = longMap();
    const engine = makeEngine(map, maxScrollPx);
    engine.setProfile(profile);
    const trace = driveCatchUp(engine, { durationMs: 6000, startUnit: 700 });
    return { engine, trace };
  }

  it('ends the boost, and what follows is ordinary following', () => {
    const { engine, trace } = run(PROFILE);
    const capMs = PROFILE.motion.catchUpMaxDurationMs;
    const settledFrom = capMs + PROFILE.motion.catchUpReleaseMs;
    const base = PROFILE.motion.maxForwardVelocityPxS;

    // It actually ran as a catch-up first: the boost was in force and visible
    // in the rendered position, not merely configured.
    const boosted = trace.filter((s) => s.tMs < capMs - PROFILE.motion.catchUpReleaseMs);
    expect(Math.max(...boosted.map((s) => s.vPxS))).toBeGreaterThan(base * 1.2);

    // It ENDED, and it ended on the cap rather than by arriving.
    expect(engine.catchUpCapExpiries).toBe(1);
    const capped = trace.filter((s) => s.controllerState.includes('catch_up_capped'));
    expect(capped.length).toBeGreaterThan(0);
    expect(capped[0]?.tMs ?? 0).toBeGreaterThanOrEqual(capMs);
    // …with the gap still wide open, which is the case the cap exists for.
    expect(capped[0]?.gapPx ?? 0).toBeGreaterThan(500);

    /* The chosen exit: ordinary following. Not a re-anchor, not a stall.
     *
     * The document keeps closing the gap at base speed under its own limits;
     * nothing teleports; the §70.5 latch's re-anchor escape hatch is not
     * involved; and there is no §20.4 fade, because no discontinuity was
     * authorized.
     */
    const after = trace.filter((s) => s.tMs > settledFrom + 100);
    expect(Math.max(...after.map((s) => s.vPxS))).toBeLessThanOrEqual(base * 1.02);
    expect(Math.min(...after.map((s) => s.vPxS))).toBeGreaterThan(base * 0.5);
    expect(engine.latchReanchors).toBe(0);
    expect(Math.min(...after.map((s) => s.documentOpacity))).toBe(1);
    // Still closing, monotonically, with no backward step anywhere.
    const last = after[after.length - 1];
    expect((last?.gapPx ?? 0) < (after[0]?.gapPx ?? 0)).toBe(true);
    for (let i = 1; i < trace.length; i++) {
      expect(trace[i]?.scrollPx ?? 0).toBeGreaterThanOrEqual((trace[i - 1]?.scrollPx ?? 0) - 1e-9);
    }
  });

  it('MUTATION: with the cap removed the boost never ends', () => {
    const { engine, trace } = run({
      ...PROFILE,
      motion: { ...PROFILE.motion, catchUpMaxDurationMs: 600000 },
    });
    const settledFrom = PROFILE.motion.catchUpMaxDurationMs + PROFILE.motion.catchUpReleaseMs;
    const base = PROFILE.motion.maxForwardVelocityPxS;
    const after = trace.filter((s) => s.tMs > settledFrom + 100 && s.gapPx > 800);
    expect(after.length).toBeGreaterThan(0);
    // The assertion the capped run passes — realized velocity back under the
    // base ceiling — is exactly what fails here.
    expect(Math.max(...after.map((s) => s.vPxS))).toBeGreaterThan(base * 1.2);
    expect(engine.catchUpCapExpiries).toBe(0);
  });
});

/* -------------------------------------------------------------------------
 * 2. Corridor-relative boost decay
 * ---------------------------------------------------------------------- */

/** The default 4% reading-band half-height on a 1080 px stage (§16.3, A.4). */
const CORRIDOR_HALF_PX = 1080 * 0.04;

/**
 * The velocity ceiling §30.3 licenses at a given gap, computed from the spec
 * text rather than from the implementation: full boost while the spoken line is
 * more than `catchUpDecayCorridors` corridor half-heights below the corridor's
 * entry edge, none by the time it reaches that edge.
 */
function licensedCeilingPxS(profile: SmoothFollowProfile, gapPx: number): number {
  const decayPx = profile.motion.catchUpDecayCorridors * CORRIDOR_HALF_PX;
  const fraction =
    decayPx <= 0
      ? gapPx > CORRIDOR_HALF_PX
        ? 1
        : 0
      : Math.max(0, Math.min(1, (gapPx - CORRIDOR_HALF_PX) / decayPx));
  return (
    profile.motion.maxForwardVelocityPxS *
    (1 + (profile.motion.catchUpMultiplier - 1) * fraction)
  );
}

/**
 * How far above the instantaneous licence the rendered motion may ride.
 *
 * Not slop. The licence FALLS as the gap closes, and a jerk-limited plant
 * cannot track a falling ceiling instantly — shedding velocity requires first
 * ramping acceleration down at `jerkMax`. Measured lag over the decay window is
 * under 3%; this is a little over double that, and the mutation clause below
 * violates it by more than four times as much.
 */
const CEILING_LAG_TOLERANCE = 1.06;

describe('§30.3 corridor-relative boost decay', () => {
  function run(profile: SmoothFollowProfile) {
    const { map, maxScrollPx } = longMap({ readingBandHalfHeightPx: CORRIDOR_HALF_PX });
    const engine = makeEngine(map, maxScrollPx);
    engine.setProfile(profile);
    return driveCatchUp(engine, { durationMs: 6000, startUnit: 300, frameHz: 200 });
  }

  /**
   * Peak realized velocity — from `Δq` alone — while the gap was near `gapPx`.
   *
   * The first 400 ms are excluded because the catch-up begins from an accepted
   * jump with the plant AT REST: until it has ramped to its licensed ceiling
   * the peak measures the acceleration limit rather than the decay under test,
   * and a decayed and undecayed run are indistinguishable there by
   * construction. 400 ms is comfortably past the ~350 ms the plant needs to
   * reach boosted top speed under `maxAccelerationPxS2`.
   */
  function peakAtGap(trace: EngineSample[], gapPx: number): number {
    const band = trace.filter((s) => s.tMs > 400 && Math.abs(s.gapPx - gapPx) <= 15);
    return band.length === 0 ? Number.NaN : Math.max(...band.map((s) => s.vPxS));
  }

  /** A gap well outside the decay window: the boost must still be whole there. */
  const GAP_OUTSIDE = 1000;
  /** Sampled from inside the decay window down to the corridor's entry edge. */
  const GAPS = [600, 500, 400, 300, 250, 200, 150, 100, 60];

  it('falls monotonically as the gap closes, at every gap fraction', () => {
    const trace = run(PROFILE);
    const peaks = GAPS.map((g) => peakAtGap(trace, g));
    for (const peak of peaks) expect(Number.isFinite(peak)).toBe(true);

    // Outside the window the boost is whole: a large catch-up still moves.
    expect(peakAtGap(trace, GAP_OUTSIDE)).toBeCloseTo(
      PROFILE.motion.maxForwardVelocityPxS * PROFILE.motion.catchUpMultiplier,
      0,
    );

    // Monotone all the way in — not merely "lower at the end".
    for (let i = 1; i < peaks.length; i++) {
      expect({ gapPx: GAPS[i], peakPxS: peaks[i] }).toMatchObject({ gapPx: GAPS[i] });
      expect(peaks[i] ?? 0).toBeLessThan(peaks[i - 1] ?? 0);
    }

    // And it falls to the RIGHT level: the licence at that gap, with the boost
    // fully spent by the time the line reaches the corridor's entry edge, so a
    // small catch-up finishes gently under ordinary following limits.
    for (let i = 0; i < GAPS.length; i++) {
      const gap = GAPS[i] ?? 0;
      expect(peaks[i] ?? 0).toBeLessThanOrEqual(
        licensedCeilingPxS(PROFILE, gap) * CEILING_LAG_TOLERANCE,
      );
    }
    expect(peakAtGap(trace, 60)).toBeLessThan(PROFILE.motion.maxForwardVelocityPxS);
  });

  it('MUTATION: with the decay removed the boost is still whole deep inside the corridor approach', () => {
    // `catchUpDecayCorridors: 0` is the bound reverted — the four multipliers on
    // their own, at full boost right up to the corridor edge.
    const trace = run({
      ...PROFILE,
      motion: { ...PROFILE.motion, catchUpDecayCorridors: 0 },
    });
    // The licensed-ceiling assertion above is what breaks, across the whole
    // upper half of the decay window.
    const breaches = [500, 400, 300].filter(
      (gap) =>
        peakAtGap(trace, gap) > licensedCeilingPxS(PROFILE, gap) * CEILING_LAG_TOLERANCE,
    );
    expect(breaches).toEqual([500, 400, 300]);
    /*
     * And it is not a rounding difference: across the decay window the document
     * is moving materially faster at the same distance from the reading line.
     *
     * Measured over the window rather than at a single gap, because a single
     * sample also catches whichever part of the plant's own acceleration ramp
     * happens to overlap it — which is a fact about the controller, not about
     * the decay this clause exists to prove does something.
     */
    const decayed = run(PROFILE);
    const gaps = [400, 300, 200];
    const mean = (t: EngineSample[]) =>
      gaps.reduce((sum, gap) => sum + peakAtGap(t, gap), 0) / gaps.length;
    expect(mean(trace)).toBeGreaterThan(mean(decayed) * 1.1);
  });
});

/* -------------------------------------------------------------------------
 * 3. Upper safety boundary
 * ---------------------------------------------------------------------- */

const SUBSTEP_MS = 8;

/**
 * A catch-up that WOULD carry the spoken line past the corridor: the plant is
 * running at boosted speed when the presenter stops, so the feed-forward that
 * justified the speed vanishes and the jerk-limited brake physically cannot
 * stop inside the remaining error.
 *
 * The overshoot guard is present and firing here — it is what brakes — and it
 * still cannot bound the result, because a jerk-limited plant that has already
 * committed to travel arrives where it arrives. `following` is forward-only, so
 * where it arrives is where it stays. `lead = q - target` is therefore what is
 * measured, never the tracking error: a runaway in which the target itself is
 * the thing being outrun is invisible to an error-based assertion.
 */
function leadTrace(options: {
  ceiling: boolean;
  targetVelocityPxS: number;
  substeps?: number;
}) {
  const substeps = options.substeps ?? 3000;
  const startPx = 4000;
  const controller = createJerkLimitedScrollController({
    initialPositionPx: startPx,
    minPx: 0,
    maxPx: 1e7,
    substepMs: SUBSTEP_MS,
  });
  // The one authorized plant write, standing in for "the boost already carried
  // the plant to speed before the presenter stopped".
  controller.reanchor(startPx, { velocityPxS: 1400 });

  const q: number[] = [];
  const lead: number[] = [];
  for (let i = 0; i < substeps; i++) {
    const targetPx = startPx + (options.targetVelocityPxS * i * SUBSTEP_MS) / 1000;
    const limits = limitsForState('following', PROFILE, {
      transition: 'catch_up',
      catchUpBoost: 1,
      ...(options.ceiling
        ? { forwardPositionCeilingPx: targetPx + CORRIDOR_HALF_PX }
        : {}),
    });
    const step = controller.step({
      dtMs: SUBSTEP_MS,
      targetPx,
      feedForwardVelocityPxS: options.targetVelocityPxS,
      limits,
    });
    q.push(step.q);
    lead.push(step.q - targetPx);
  }
  return { q, lead };
}

describe('§30.3 upper safety boundary', () => {
  it('bounds POSITION, on a stalled target, on every sub-step and at the end', () => {
    const t = leadTrace({ ceiling: true, targetVelocityPxS: 0 });
    expect(Math.max(...t.lead)).toBeLessThanOrEqual(CORRIDOR_HALF_PX + 1e-9);
    expect(t.lead[t.lead.length - 1] ?? 0).toBeLessThanOrEqual(CORRIDOR_HALF_PX + 1e-9);
    // Never enforced by moving the document backward: forward-only means
    // forward-only, including at the boundary.
    for (let i = 1; i < t.q.length; i++) {
      expect(t.q[i] ?? 0).toBeGreaterThanOrEqual((t.q[i - 1] ?? 0) - 1e-9);
    }
  });

  it('MUTATION: without the ceiling the line is carried far past it, permanently', () => {
    const t = leadTrace({ ceiling: false, targetVelocityPxS: 0 });
    expect(Math.max(...t.lead)).toBeGreaterThan(CORRIDOR_HALF_PX * 4);
    // It never comes back: `following` is forward-only, so an overshoot is a
    // permanent error — the 908 px shape.
    expect(t.lead[t.lead.length - 1] ?? 0).toBeGreaterThan(CORRIDOR_HALF_PX * 4);
  });

  it('rides the boundary at the presenter’s own pace rather than stalling on it', () => {
    // A dead stop at the boundary would strand the document while the reading
    // line moved off at speaking pace, then chase and stall again once a frame.
    const t = leadTrace({ ceiling: true, targetVelocityPxS: 240 });
    expect(Math.max(...t.lead)).toBeLessThanOrEqual(CORRIDOR_HALF_PX + 1e-9);
    const tail = t.q.slice(-400);
    const rideVelocity =
      (((tail[tail.length - 1] ?? 0) - (tail[0] ?? 0)) / (tail.length - 1) / SUBSTEP_MS) * 1000;
    expect(rideVelocity).toBeGreaterThan(200);
    // …and the mutant is carried well past the corridor before the moving
    // reading line catches back up to it.
    const bare = leadTrace({ ceiling: false, targetVelocityPxS: 240 });
    expect(Math.max(...bare.lead)).toBeGreaterThan(CORRIDOR_HALF_PX * 4);
  });
});

describe('all three bounds together', () => {
  it('a real catch-up still arrives and settles, and never stalls short', () => {
    // The bounds are safety limits, not a brake: with the corridor present and
    // the cap running, an ordinary catch-up must still close, settle, and stay
    // settled — no oscillation against the boundary, no parking short of the
    // reading line, no backward motion anywhere.
    const { map, maxScrollPx } = longMap({ readingBandHalfHeightPx: CORRIDOR_HALF_PX });
    const engine = makeEngine(map, maxScrollPx);
    const trace = driveCatchUp(engine, { durationMs: 8000, startUnit: 300 });

    const tail = trace.filter((s) => s.tMs > 6000);
    // Arrived: the reading line is where the presenter is, within the corridor.
    for (const sample of tail) {
      expect(Math.abs(sample.gapPx)).toBeLessThan(CORRIDOR_HALF_PX);
    }
    // Settled: still tracking the presenter's pace, not rocking around it.
    let reversals = 0;
    for (let i = 1; i < tail.length; i++) {
      if ((tail[i]?.vPxS ?? 0) < -1e-6) reversals++;
    }
    expect(reversals).toBe(0);
    // And the whole run is forward-only, as `following` requires.
    for (let i = 1; i < trace.length; i++) {
      expect(trace[i]?.scrollPx ?? 0).toBeGreaterThanOrEqual(
        (trace[i - 1]?.scrollPx ?? 0) - 1e-9,
      );
    }
  });
});

/* -------------------------------------------------------------------------
 * 4. The bounds do not violate the plant
 * ---------------------------------------------------------------------- */

const STATES: StageMotionState[] = [
  'searching',
  'following',
  'following',
  'holding',
  'ambiguous',
  'following',
  'holding',
  'holding',
  'following',
  'following',
  'paused',
  'holding',
  'searching',
];
const TRANSITIONS = [undefined, 'settle', 'catch_up', 'rewind', 'reanchor', 'reset'] as const;
const BOOSTS = [0, 0.25, 0.5, 1];
const DT_S = SUBSTEP_MS / 1000;
const LIMIT_SLACK = 1 + 1e-6;

describe('the §30.3 bounds honour the plant across the profile space', () => {
  it('realized v, a and jerk from Δq stay inside the limits, degraded included', () => {
    const violations: string[] = [];
    for (const state of STATES) {
      for (const transition of TRANSITIONS) {
        for (const degraded of [false, true]) {
          for (const catchUpBoost of BOOSTS) {
            const controller = createJerkLimitedScrollController({
              initialPositionPx: 0,
              minPx: 0,
              maxPx: 1e7,
              substepMs: SUBSTEP_MS,
            });
            const label = `${state}/${transition ?? 'none'}${
              degraded ? '/degraded' : ''
            }/boost${catchUpBoost}`;
            const q: number[] = [];
            const wall: boolean[] = [];
            const rest: boolean[] = [];
            // A ceiling that tracks a moving target, so the clamp is genuinely
            // exercised rather than parked at infinity.
            let limits = limitsForState(state, PROFILE, { transition, degraded });
            if (limits.snap) continue;
            for (let i = 0; i < 3000; i++) {
              const targetPx = 4000 + Math.min(2000, 300 * ((i * SUBSTEP_MS) / 1000));
              limits = limitsForState(state, PROFILE, {
                transition,
                degraded,
                catchUpBoost,
                forwardPositionCeilingPx: targetPx + 43.2,
              });
              const step = controller.step({
                dtMs: SUBSTEP_MS,
                targetPx,
                feedForwardVelocityPxS: i * SUBSTEP_MS < 6667 ? 300 : 0,
                limits,
              });
              q.push(step.q);
              wall.push(step.hardStop);
              rest.push(step.atRest);
            }
            const v = q.map((value, i) => (i === 0 ? 0 : (value - (q[i - 1] ?? 0)) / DT_S));
            const a = v.map((value, i) => (i <= 1 ? 0 : (value - (v[i - 1] ?? 0)) / DT_S));
            const jerk = a.map((value, i) => (i <= 2 ? 0 : (value - (a[i - 1] ?? 0)) / DT_S));
            for (let i = 3; i < q.length; i++) {
              // A wall or a rest snap is a documented step; three samples of
              // skirt each, exactly as the existing param-space suite allows.
              let exempt = false;
              for (let k = Math.max(0, i - 2); k <= i; k++) {
                if (wall[k] || rest[k]) exempt = true;
              }
              if (exempt) continue;
              const vi = v[i] ?? 0;
              if (vi > limits.vForwardMax * LIMIT_SLACK + 1e-3) {
                violations.push(`${label}@${i} v+=${vi.toFixed(1)}`);
              }
              const floor = limits.allowBackward ? -limits.vBackwardMax * LIMIT_SLACK - 1e-3 : -1e-3;
              if (vi < floor) violations.push(`${label}@${i} v-=${vi.toFixed(1)}`);
              if (Math.abs(a[i] ?? 0) > limits.aMax * LIMIT_SLACK + 1e-3) {
                violations.push(`${label}@${i} a=${(a[i] ?? 0).toFixed(1)}`);
              }
              if (Math.abs(jerk[i] ?? 0) > limits.jerkMax * LIMIT_SLACK + 1e-3) {
                violations.push(`${label}@${i} jerk=${(jerk[i] ?? 0).toFixed(1)}`);
              }
            }
          }
        }
      }
    }
    expect(violations.slice(0, 20)).toEqual([]);
  });

  it('reduced motion is unaffected: the target is followed exactly', () => {
    // §32.4/A.3. Snap has no dynamics to bound, and the target is inside the
    // ceiling by construction, so the accommodation is not quietly reshaped.
    const snap = limitsForState('following', PROFILE, {
      reducedMotion: true,
      catchUpBoost: 0,
      forwardPositionCeilingPx: 1200,
    });
    expect(snap.snap).toBe(true);
    const controller = createJerkLimitedScrollController({ minPx: 0, maxPx: 1e7 });
    const step = controller.step({
      dtMs: 16,
      targetPx: 1100,
      feedForwardVelocityPxS: 0,
      limits: snap,
    });
    expect(step.q).toBe(1100);
  });

  it('manual grace drops the ceiling with the rest of automatic authority', () => {
    // §30.6: nothing automatic may move, so there is nothing to bound — and the
    // presenter's own position may legitimately sit past it.
    const manual = limitsForState('following', PROFILE, {
      manualGrace: true,
      forwardPositionCeilingPx: 500,
    });
    expect(manual.forwardPositionCeilingPx).toBe(Number.POSITIVE_INFINITY);
    expect(manual.vForwardMax).toBe(0);
  });

  it('a boost of 0 is ordinary following limits, never a brake', () => {
    const none = limitsForState('following', PROFILE, {
      transition: 'catch_up',
      catchUpBoost: 0,
    });
    const full = limitsForState('following', PROFILE, {
      transition: 'catch_up',
      catchUpBoost: 1,
    });
    const ordinary = limitsForState('following', PROFILE);
    expect(none.vForwardMax).toBeCloseTo(ordinary.vForwardMax, 6);
    expect(none.aMax).toBeCloseTo(ordinary.aMax, 6);
    expect(full.vForwardMax).toBeCloseTo(
      ordinary.vForwardMax * PROFILE.motion.catchUpMultiplier,
      6,
    );
    // And the jerk limit is never relaxed by any of it (§30.3).
    expect(full.jerkMax).toBe(PROFILE.motion.maxJerkPxS3);
    expect(none.jerkMax).toBe(PROFILE.motion.maxJerkPxS3);
  });

  /*
   * There is now exactly ONE source of a catch-up licence — a `catch_up`
   * directive — so the old "state × transition may not compound" cap has
   * nothing left to guard against by construction. What still has to hold is
   * that the boost is monotone in the decay: a MORE decayed catch-up may never
   * reach further than a less decayed one.
   */
  it('the boost is monotone in the decay, so a decayed catch-up never reaches further', () => {
    let previous = 0;
    for (const boost of [...BOOSTS].sort((a, b) => a - b)) {
      const limits = limitsForState('following', PROFILE, {
        transition: 'catch_up',
        catchUpBoost: boost,
      });
      expect(limits.vForwardMax).toBeGreaterThanOrEqual(previous);
      previous = limits.vForwardMax;
      // And the jerk limit is never relaxed by any of it (§30.3).
      expect(limits.jerkMax).toBe(PROFILE.motion.maxJerkPxS3);
    }
  });
});
