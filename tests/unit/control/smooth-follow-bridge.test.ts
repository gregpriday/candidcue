/**
 * The v1 → v2 snapshot bridge (companion §26.1, §50.1).
 *
 * `motionFrameFromSnapshot` is a *producer* of `SemanticMotionFrame`s, and the
 * stage extrapolates whatever velocity it is handed across a 750 ms horizon.
 * The bridge derives that velocity by finite difference, which makes two things
 * load-bearing:
 *
 *  - a position CORRECTION is not speech. A 30-token skip across a 200 ms gap
 *    is not a presenter talking at 150 units/s (≈ 9000 wpm); it is the tracker
 *    re-locating them. Dividing one by the other and calling the result a pace
 *    is how a single snapshot became a permanent forward runaway on the stage.
 *  - the session clock has to be monotonic. `sessionTimeMs` is what evidence
 *    age is measured against, and `Date.now()` steps.
 *
 * The stage clamps this again on receipt — it does not trust control — but a
 * producer should not emit an impossible pace in the first place.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SMOOTH_FOLLOW_PROFILE as PROFILE,
  type SemanticMotionFrame,
  type TrackingSnapshot,
} from '../../../src/shared/contracts';
import {
  monotonicNowMs,
  motionFrameFromSnapshot,
} from '../../../src/control/services/smooth-follow-adapter';

const PACE_MAX = PROFILE.prediction.maxUnitsPerSecond;

function snapshot(overrides: Partial<TrackingSnapshot> = {}): TrackingSnapshot {
  return {
    schemaVersion: 1,
    revision: 7,
    sessionId: 'session-a',
    sessionGeneration: 1,
    stageGeneration: 1,
    scriptId: 'script-a',
    tokenIndex: 130,
    committedTokenIndex: 128,
    blockId: 'b1',
    sentenceId: 's9',
    confidence: 0.9,
    state: 'following',
    provisional: false,
    movement: 'advance',
    sourceItemIds: [],
    generatedAtMs: 0,
    ...overrides,
  };
}

function previousFrame(overrides: Partial<SemanticMotionFrame> = {}): SemanticMotionFrame {
  return {
    sessionId: 'session-a',
    sessionGeneration: 1,
    scriptCompileHash: 'hash-a',
    layoutGeneration: 1,
    revision: 6,
    epoch: 1,
    sessionTimeMs: 10_000,
    estimatedUnit: 100,
    committedUnit: 99,
    velocityUnitsPerSecond: 3,
    accelerationUnitsPerSecond2: 0,
    positionVariance: 0,
    confidence: 0.9,
    sectionId: 'b1',
    tokenIndex: 100,
    sentenceId: 's8',
    blockId: 'b1',
    state: 'following',
    behavior: 'normal',
    finalEvidence: true,
    motionProfileId: 'default-v1',
    ...overrides,
  };
}

function bridge(
  snap: TrackingSnapshot,
  opts: { nowMs: number; previous?: SemanticMotionFrame | null },
): SemanticMotionFrame {
  return motionFrameFromSnapshot(snap, {
    sessionId: 'session-a',
    sessionGeneration: 1,
    scriptCompileHash: 'hash-a',
    layoutGeneration: 1,
    motionProfileId: 'default-v1',
    sessionStartedAtMs: 0,
    previous: opts.previous === undefined ? previousFrame() : opts.previous,
    nowMs: opts.nowMs,
  });
}

describe('velocity is a speaking rate, not a position delta', () => {
  it('reports no pace across a skip — the presenter did not speed up', () => {
    // 30 tokens in 200 ms. As a finite difference that is 150 units/s; as
    // speech it is nothing at all, because the tracker moved, not the mouth.
    const frame = bridge(snapshot({ movement: 'skip' }), { nowMs: 10_200 });
    expect(frame.velocityUnitsPerSecond).toBe(0);
    expect(frame.estimatedUnit).toBe(130);
  });

  it.each(['retake', 'command', 'manual'] as const)(
    'reports no pace across a %s reposition either',
    (movement) => {
      expect(bridge(snapshot({ movement }), { nowMs: 10_200 }).velocityUnitsPerSecond).toBe(0);
    },
  );

  it('clamps an ordinary advance that still outruns human speech', () => {
    // `advance` can cover a lot of ground when transcription arrives in a burst.
    const frame = bridge(snapshot({ movement: 'advance' }), { nowMs: 10_200 });
    expect(frame.velocityUnitsPerSecond).toBe(PACE_MAX);
  });

  it('passes an ordinary pace through untouched', () => {
    // 100 → 100.6 across 200 ms — 3 units/s, a normal delivery.
    const frame = bridge(snapshot({ tokenIndex: 100.6 as number }), {
      nowMs: 10_200,
      previous: previousFrame(),
    });
    expect(frame.velocityUnitsPerSecond).toBeCloseTo(3, 6);
  });

  it('never reports a negative pace on the forward-only v1 path', () => {
    const frame = bridge(snapshot({ tokenIndex: 40 }), { nowMs: 10_200 });
    expect(frame.velocityUnitsPerSecond).toBe(0);
  });

  it('reports no pace without a previous frame to difference against', () => {
    const frame = bridge(snapshot(), { nowMs: 10_200, previous: null });
    expect(frame.velocityUnitsPerSecond).toBe(0);
  });
});

describe('the bridged session clock is monotonic', () => {
  it('defaults to performance.now(), not the wall clock', () => {
    const before = monotonicNowMs();
    const frame = motionFrameFromSnapshot(snapshot(), {
      sessionId: 'session-a',
      sessionGeneration: 1,
      scriptCompileHash: 'hash-a',
      layoutGeneration: 1,
      motionProfileId: 'default-v1',
      sessionStartedAtMs: 0,
      previous: null,
    });
    const after = monotonicNowMs();
    // A `Date.now()` default would be ~1.7e12 here — thirteen digits clear of
    // any `performance.now()` reading in a test process.
    expect(frame.sessionTimeMs).toBeGreaterThanOrEqual(before);
    expect(frame.sessionTimeMs).toBeLessThanOrEqual(after);
    expect(frame.sessionTimeMs).toBeLessThan(1e10);
  });

  it('is a monotonic clock, so it never runs backward', () => {
    let previous = monotonicNowMs();
    for (let i = 0; i < 500; i += 1) {
      const now = monotonicNowMs();
      expect(now).toBeGreaterThanOrEqual(previous);
      previous = now;
    }
  });
});
