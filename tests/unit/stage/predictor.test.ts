/**
 * Stage-side semantic prediction (companion §27).
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SMOOTH_FOLLOW_PROFILE,
  type SemanticMotionFrame,
  type TrackingStateV2,
} from '../../../src/shared/contracts';
import { predictSemanticPosition, predictionPolicy } from '../../../src/stage/motion';

const profile = DEFAULT_SMOOTH_FOLLOW_PROFILE;

function frame(overrides: Partial<SemanticMotionFrame> = {}): SemanticMotionFrame {
  return {
    sessionId: 's',
    sessionGeneration: 1,
    scriptCompileHash: 'h',
    layoutGeneration: 1,
    revision: 1,
    epoch: 1,
    sessionTimeMs: 1000,
    estimatedUnit: 100,
    committedUnit: 96,
    velocityUnitsPerSecond: 4,
    accelerationUnitsPerSecond2: 0,
    positionVariance: 0.2,
    confidence: 0.9,
    sectionId: 'section:0',
    tokenIndex: 100,
    sentenceId: 's1',
    blockId: 'b1',
    state: 'following',
    behavior: 'normal',
    finalEvidence: true,
    motionProfileId: 'default-v1',
    ...overrides,
  };
}

describe('prediction between transcript events (§3.1, §27)', () => {
  it('keeps moving between frames rather than waiting', () => {
    const at0 = predictSemanticPosition(frame(), 1000, profile);
    const at200 = predictSemanticPosition(frame(), 1200, profile);
    expect(at0.unit).toBe(100);
    expect(at200.unit).toBeGreaterThan(at0.unit);
    expect(at200.unit).toBeCloseTo(100 + 4 * 0.2, 6);
  });

  it('includes acceleration inside the horizon', () => {
    const p = predictSemanticPosition(
      frame({ accelerationUnitsPerSecond2: 2 }),
      1500,
      profile,
    );
    expect(p.unit).toBeCloseTo(100 + 4 * 0.5 + 0.5 * 2 * 0.25, 6);
  });

  it('decays velocity smoothly past the horizon rather than cutting off (§27.2)', () => {
    const horizon = profile.prediction.normalHorizonMs;
    const atHorizon = predictSemanticPosition(frame(), 1000 + horizon, profile);
    const justAfter = predictSemanticPosition(frame(), 1000 + horizon + 1, profile);
    expect(justAfter.decaying).toBe(true);
    // Continuity at the horizon: no jump in either position or velocity.
    expect(Math.abs(justAfter.unit - atHorizon.unit)).toBeLessThan(0.01);
    expect(Math.abs(justAfter.velocityUnitsPerSecond - atHorizon.velocityUnitsPerSecond))
      .toBeLessThan(0.02);
  });

  it('never scrolls indefinitely on a stale frame (§3.5)', () => {
    const veryLate = predictSemanticPosition(frame(), 1000 + 600_000, profile);
    // Total drift is bounded by the horizon's travel plus the coast budget,
    // and does not grow with age however long the frame has been stale.
    const bound =
      4 * (profile.prediction.normalHorizonMs / 1000) + profile.prediction.maxCoastUnits;
    expect(veryLate.unit - 100).toBeLessThanOrEqual(bound + 1e-9);
    const evenLater = predictSemanticPosition(frame(), 1000 + 6_000_000, profile);
    expect(evenLater.unit).toBe(veryLate.unit);
    expect(veryLate.velocityUnitsPerSecond).toBe(0);
    expect(veryLate.driftClamped).toBe(true);
  });
});

describe('state-specific prediction (§27.1)', () => {
  it('holds at the committed unit while ad-libbing — speech alone consumes no script', () => {
    const p = predictSemanticPosition(frame({ state: 'adlib_hold' }), 5000, profile);
    expect(p.unit).toBe(96);
    expect(p.velocityUnitsPerSecond).toBe(0);
  });

  it.each(['paused', 'reconnecting', 'lost_local'] as TrackingStateV2[])(
    'targets zero velocity while %s',
    (state) => {
      const p = predictSemanticPosition(frame({ state }), 3000, profile);
      expect(p.velocityUnitsPerSecond).toBe(0);
      expect(p.unit).toBe(100);
    },
  );

  it('shortens the horizon and slows down when uncertain', () => {
    const following = predictSemanticPosition(frame(), 1400, profile);
    const uncertain = predictSemanticPosition(frame({ state: 'uncertain' }), 1400, profile);
    expect(uncertain.unit).toBeLessThan(following.unit);
    expect(uncertain.unit).toBeGreaterThan(100);
    expect(predictionPolicy('uncertain', profile).horizonMs).toBe(
      profile.prediction.uncertainHorizonMs,
    );
  });

  it('refuses to predict backward before a retake commits (§30.4)', () => {
    const p = predictSemanticPosition(
      frame({ state: 'retake_pending', velocityUnitsPerSecond: -6 }),
      1300,
      profile,
    );
    expect(p.unit).toBeGreaterThanOrEqual(100);
    expect(p.velocityUnitsPerSecond).toBeGreaterThanOrEqual(0);
  });

  it('permits a committed backward trajectory while rewinding', () => {
    const p = predictSemanticPosition(
      frame({ state: 'rewinding', velocityUnitsPerSecond: -6 }),
      1200,
      profile,
    );
    expect(p.unit).toBeLessThan(100);
    expect(predictionPolicy('rewinding', profile).allowBackward).toBe(true);
  });

  it('gives catch-up a larger drift budget than ordinary following', () => {
    expect(predictionPolicy('catching_up', profile).maxDriftUnits).toBeGreaterThan(
      predictionPolicy('following', profile).maxDriftUnits,
    );
  });
});
