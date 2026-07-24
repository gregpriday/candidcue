/**
 * Target-duration pacing (spec §14.10).
 *
 * The sign convention is the point of the first test: positive means running
 * long. Getting that backwards would tell a presenter to speed up when they
 * are already over, and no amount of smoothing would save it.
 *
 * The second theme is the trust gate on the alignment cursor. A projection is
 * only as good as "how much script is left", so a stale, low-confidence,
 * re-acquiring or wrong-epoch cursor must produce *no* projection rather than
 * a confident wrong one.
 */
import { describe, expect, it } from 'vitest';
import {
  rejectProgress,
  TargetDurationTracker,
  type ScriptProgress,
} from '../../../../src/shared/coaching/pace/target-duration';

const FIVE_MINUTES_MS = 300_000;
const EPOCH = 3;

function progress(
  remainingSpokenWordEquivalents: number,
  overrides: Partial<ScriptProgress> = {},
): ScriptProgress {
  return {
    cursorUnitIndex: 400,
    totalUnits: 1_000,
    remainingSpokenWordEquivalents,
    confidence: 0.9,
    observedAtMs: 60_000,
    trackingEpoch: EPOCH,
    reacquiring: false,
    ...overrides,
  };
}

describe('TargetDurationTracker projection', () => {
  it('projects zero delta when the current rate lands exactly on target', () => {
    // 60 s spent, 600 words left, 150 WPM → 240 s remaining → 300 s total.
    const tracker = new TargetDurationTracker(FIVE_MINUTES_MS);
    const result = tracker.update({
      audioTimeMs: 60_000,
      elapsedDeliveryMs: 60_000,
      progress: progress(600),
      currentWpm: 150,
      trackingEpoch: EPOCH,
    });
    expect(result.rawProjectedFinishDeltaMs).toBeCloseTo(0, 6);
    expect(result.projectedTotalMs).toBeCloseTo(FIVE_MINUTES_MS, 6);
    expect(result.withinTolerance).toBe(true);
    expect(result.progressRejected).toBeNull();
  });

  it('reports a positive delta when running long', () => {
    // Same script remainder at 120 WPM → 300 s remaining → 360 s total,
    // i.e. one minute over a five-minute target.
    const tracker = new TargetDurationTracker(FIVE_MINUTES_MS);
    const result = tracker.update({
      audioTimeMs: 60_000,
      elapsedDeliveryMs: 60_000,
      progress: progress(600),
      currentWpm: 120,
      trackingEpoch: EPOCH,
    });
    expect(result.rawProjectedFinishDeltaMs).toBeCloseTo(60_000, 6);
    expect(result.projectedFinishDeltaMs).toBeCloseTo(60_000, 6);
    expect(result.withinTolerance).toBe(false);
  });

  it('reports a negative delta when running short', () => {
    // 200 WPM → 180 s remaining → 240 s total, a minute under target.
    const tracker = new TargetDurationTracker(FIVE_MINUTES_MS);
    const result = tracker.update({
      audioTimeMs: 60_000,
      elapsedDeliveryMs: 60_000,
      progress: progress(600),
      currentWpm: 200,
      trackingEpoch: EPOCH,
    });
    expect(result.rawProjectedFinishDeltaMs).toBeCloseTo(-60_000, 6);
  });

  it('computes the required rate from the remaining target window', () => {
    // 240 s left, 600 words → 150 WPM required.
    const tracker = new TargetDurationTracker(FIVE_MINUTES_MS);
    const result = tracker.update({
      audioTimeMs: 60_000,
      elapsedDeliveryMs: 60_000,
      progress: progress(600),
      currentWpm: null,
      trackingEpoch: EPOCH,
    });
    expect(result.requiredWpm).toBeCloseTo(150, 9);
    // No rate yet, so no projection may be invented.
    expect(result.projectedFinishDeltaMs).toBeNull();
  });

  it('reports nothing at all when no target duration is set', () => {
    const tracker = new TargetDurationTracker(null);
    const result = tracker.update({
      audioTimeMs: 60_000,
      elapsedDeliveryMs: 60_000,
      progress: progress(600),
      currentWpm: 150,
      trackingEpoch: EPOCH,
    });
    expect(result.requiredWpm).toBeNull();
    expect(result.projectedFinishDeltaMs).toBeNull();
    expect(result.projectedTotalMs).toBeNull();
  });

  it('refuses to project from an implausibly low rate', () => {
    const tracker = new TargetDurationTracker(FIVE_MINUTES_MS);
    const result = tracker.update({
      audioTimeMs: 60_000,
      elapsedDeliveryMs: 60_000,
      progress: progress(600),
      currentWpm: 5,
      trackingEpoch: EPOCH,
    });
    expect(result.projectedFinishDeltaMs).toBeNull();
    expect(result.requiredWpm).toBeCloseTo(150, 9);
  });

  it('stops reporting a required rate once the target window has run out', () => {
    const tracker = new TargetDurationTracker(FIVE_MINUTES_MS);
    const result = tracker.update({
      audioTimeMs: 320_000,
      elapsedDeliveryMs: 320_000,
      progress: progress(100, { observedAtMs: 320_000 }),
      currentWpm: 150,
      trackingEpoch: EPOCH,
    });
    expect(result.requiredWpm).toBeNull();
    // The projection still works: 100 words at 150 WPM is 40 s more, so the
    // take finishes 60 s over.
    expect(result.rawProjectedFinishDeltaMs).toBeCloseTo(60_000, 6);
  });
});

describe('TargetDurationTracker trusts the alignment cursor only when it should', () => {
  const base = {
    audioTimeMs: 60_000,
    elapsedDeliveryMs: 60_000,
    currentWpm: 150,
    trackingEpoch: EPOCH,
  };

  it('rejects a cursor from a previous tracking epoch', () => {
    expect(rejectProgress({ ...base, progress: progress(600, { trackingEpoch: 2 }) })).toBe(
      'stale_epoch',
    );
  });

  it('rejects a cursor while the engine is re-acquiring', () => {
    expect(rejectProgress({ ...base, progress: progress(600, { reacquiring: true }) })).toBe(
      'reacquiring',
    );
  });

  it('rejects a low-confidence cursor', () => {
    expect(rejectProgress({ ...base, progress: progress(600, { confidence: 0.2 }) })).toBe(
      'low_confidence',
    );
  });

  it('rejects a cursor that has gone stale', () => {
    expect(rejectProgress({ ...base, progress: progress(600, { observedAtMs: 50_000 }) })).toBe(
      'stale_cursor',
    );
  });

  it('rejects a negative remainder', () => {
    expect(rejectProgress({ ...base, progress: progress(-5) })).toBe('negative_remainder');
  });

  it('accepts a fresh, confident, current-epoch cursor', () => {
    expect(rejectProgress({ ...base, progress: progress(600) })).toBeNull();
  });

  it('produces no projection at all when the cursor is rejected', () => {
    const tracker = new TargetDurationTracker(FIVE_MINUTES_MS);
    const result = tracker.update({ ...base, progress: progress(600, { reacquiring: true }) });
    expect(result.progressRejected).toBe('reacquiring');
    expect(result.projectedFinishDeltaMs).toBeNull();
    expect(result.requiredWpm).toBeNull();
  });
});

describe('TargetDurationTracker smoothing (§14.10 "smooth this value and cap changes")', () => {
  it('seeds on the first sample and then caps how fast the delta may move', () => {
    const tracker = new TargetDurationTracker(FIVE_MINUTES_MS, {
      maxDeltaChangeMsPerSecond: 4_000,
    });
    const first = tracker.update({
      audioTimeMs: 60_000,
      elapsedDeliveryMs: 60_000,
      progress: progress(600),
      currentWpm: 150,
      trackingEpoch: EPOCH,
    });
    expect(first.projectedFinishDeltaMs).toBeCloseTo(0, 6);

    // One second later the raw projection jumps to +61 s. The cap allows at
    // most 4 000 ms of movement in that second.
    const second = tracker.update({
      audioTimeMs: 61_000,
      elapsedDeliveryMs: 61_000,
      progress: progress(600, { observedAtMs: 61_000 }),
      currentWpm: 120,
      trackingEpoch: EPOCH,
    });
    expect(second.rawProjectedFinishDeltaMs).toBeCloseTo(61_000, 6);
    expect(second.projectedFinishDeltaMs).toBeCloseTo(4_000, 6);
  });

  it('caps how fast the required rate may move', () => {
    const tracker = new TargetDurationTracker(FIVE_MINUTES_MS, {
      maxRequiredWpmChangePerSecond: 8,
    });
    const first = tracker.update({
      audioTimeMs: 60_000,
      elapsedDeliveryMs: 60_000,
      progress: progress(600),
      currentWpm: 150,
      trackingEpoch: EPOCH,
    });
    expect(first.requiredWpm).toBeCloseTo(150, 6);

    // A skipped section removes 500 words: the raw requirement collapses to
    // ~25 WPM. Unsmoothed the tile would jump 125 WPM in one second; the cap
    // allows 8.
    const second = tracker.update({
      audioTimeMs: 61_000,
      elapsedDeliveryMs: 61_000,
      progress: progress(100, { observedAtMs: 61_000 }),
      currentWpm: 150,
      trackingEpoch: EPOCH,
    });
    expect(second.requiredWpm).toBeCloseTo(142, 6);
  });

  it('re-seeds after a reset instead of dragging the old projection across a retake', () => {
    const tracker = new TargetDurationTracker(FIVE_MINUTES_MS);
    tracker.update({
      audioTimeMs: 60_000,
      elapsedDeliveryMs: 60_000,
      progress: progress(600),
      currentWpm: 150,
      trackingEpoch: EPOCH,
    });
    tracker.reset();
    const afterReset = tracker.update({
      audioTimeMs: 61_000,
      elapsedDeliveryMs: 61_000,
      progress: progress(600, { observedAtMs: 61_000 }),
      currentWpm: 120,
      trackingEpoch: EPOCH,
    });
    expect(afterReset.projectedFinishDeltaMs).toBeCloseTo(61_000, 6);
  });

  it('re-seeds automatically when the tracking epoch changes', () => {
    const tracker = new TargetDurationTracker(FIVE_MINUTES_MS);
    tracker.update({
      audioTimeMs: 60_000,
      elapsedDeliveryMs: 60_000,
      progress: progress(600),
      currentWpm: 150,
      trackingEpoch: EPOCH,
    });
    const afterJump = tracker.update({
      audioTimeMs: 61_000,
      elapsedDeliveryMs: 61_000,
      progress: progress(600, { observedAtMs: 61_000, trackingEpoch: EPOCH + 1 }),
      currentWpm: 120,
      trackingEpoch: EPOCH + 1,
    });
    // Seeded fresh, so the whole +61 s appears at once rather than crawling
    // there from the pre-jump projection.
    expect(afterJump.projectedFinishDeltaMs).toBeCloseTo(61_000, 6);
  });

  it('treats the tolerance as a display hint, not as a change to the number', () => {
    const tracker = new TargetDurationTracker(FIVE_MINUTES_MS, { toleranceMs: 7_500 });
    const result = tracker.update({
      audioTimeMs: 60_000,
      elapsedDeliveryMs: 60_000,
      progress: progress(600),
      currentWpm: 149,
      trackingEpoch: EPOCH,
    });
    // 600 / 149 min = 241.61 s → total 301.61 s → +1 611 ms.
    expect(result.projectedFinishDeltaMs).toBeCloseTo(1_610.738, 2);
    expect(result.withinTolerance).toBe(true);
  });
});
