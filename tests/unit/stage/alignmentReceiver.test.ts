/**
 * The stage's gate on alignment snapshots, and its audio clock.
 *
 * The clock is the part worth testing hardest, because its failure mode is
 * silent: every snapshot is accepted, every field is finite, the state says
 * `following` — and the display sits a fixed distance behind the presenter for
 * the rest of the take with nothing anywhere reporting a fault.
 */
import { describe, expect, it } from 'vitest';
import { createAlignmentReceiver } from '../../../src/stage/motion/alignmentReceiver';
import { snapshot } from '../../helpers/alignment';

/**
 * A snapshot as it would arrive: produced at audio time `audioMs`, delivered
 * `delayMs` later than a zero-latency delivery would have been.
 *
 * The session's audio clock leads wall time by `OFFSET` here, which is what
 * makes the sign of the estimator observable at all.
 */
const OFFSET = -5_000;

function deliver(
  receiver: ReturnType<typeof createAlignmentReceiver>,
  seq: number,
  audioMs: number,
  delayMs: number,
): number {
  // wall time of a zero-delay delivery is `audioMs - OFFSET`.
  const nowMs = audioMs - OFFSET + delayMs;
  receiver.accept(snapshot({ seq, atAudioMs: audioMs, evidenceAudioMs: audioMs }), nowMs);
  return nowMs;
}

describe('the stage audio clock', () => {
  it('converges on the least-delayed sample, not the most-delayed one', () => {
    const receiver = createAlignmentReceiver(1);
    // A prompt delivery, then a slow one.
    deliver(receiver, 1, 1_000, 20);
    const nowMs = deliver(receiver, 2, 2_000, 400);

    /*
     * A snapshot produced at audio time A arrives at wall time
     * `(A - trueOffset) + delay`, so `atAudioMs - nowMs = trueOffset - delay`.
     * Delivery delay is never negative, which puts a CEILING on the samples:
     * the best estimate is the LARGEST one, and taking the smallest — as this
     * once did on the stated reasoning that delay pushed samples up — locks
     * onto the worst delivery of the take.
     */
    const estimate = receiver.audioNowMs(nowMs);
    expect(estimate).not.toBeNull();
    expect(nowMs + OFFSET - estimate!).toBeLessThanOrEqual(20);
  });

  /*
   * The regression. One slow delivery used to pin the clock behind for the rest
   * of the session, because a lifetime minimum only ever falls. At a typical
   * reading pace a one-second error is about three words of permanent lag.
   */
  it('recovers from a single slow delivery instead of being pinned by it', () => {
    const receiver = createAlignmentReceiver(1);
    deliver(receiver, 1, 1_000, 1_000); // one bad stall, first
    for (let i = 2; i <= 5; i++) deliver(receiver, i, i * 1_000, 15);
    const nowMs = deliver(receiver, 6, 6_000, 15);

    const estimate = receiver.audioNowMs(nowMs)!;
    const errorMs = Math.abs(nowMs + OFFSET - estimate);
    expect(errorMs, `clock is ${errorMs.toFixed(0)}ms behind after a stall`).toBeLessThan(100);
  });

  /*
   * The mirror-image failure a lifetime MAXIMUM would have.
   *
   * The offset falls legitimately when capture stalls: audio time stops while
   * wall time does not. An estimate that could only ever rise would keep
   * predicting from a moment the session never reached, for the rest of the
   * take. The window is what lets it come back down.
   *
   * It comes down with a lag of roughly one window, and that is the honest
   * bound to assert — not instant tracking. Over-estimating during a stall is
   * the harmless direction anyway: `displayAt` clamps the lead at
   * `maxPredictionMs`, so the display simply rests at the clamp, which is what
   * a paused reader should see.
   */
  it('follows the offset down when the audio clock genuinely falls behind', () => {
    const receiver = createAlignmentReceiver(1);
    const firstNow = deliver(receiver, 1, 1_000, 15);
    const beforeStall = receiver.audioNowMs(firstNow)!;

    // Capture stalls: wall time advances 2 s per snapshot, audio time 20 ms.
    let nowMs = firstNow;
    for (let i = 2; i <= 12; i++) {
      const audioMs = 1_000 + i * 20;
      nowMs = firstNow + (i - 1) * 2_000;
      receiver.accept(snapshot({ seq: i, atAudioMs: audioMs, evidenceAudioMs: audioMs }), nowMs);
    }

    const estimate = receiver.audioNowMs(nowMs)!;
    const trueAudioMs = 1_000 + 12 * 20;
    // A lifetime maximum would still be reporting the pre-stall relationship,
    // which by now is twenty seconds of audio that never happened.
    const lifetimeMax = nowMs + (beforeStall - firstNow);
    const gapItWouldHave = lifetimeMax - trueAudioMs;
    const gapItHas = estimate - trueAudioMs;
    expect(gapItHas).toBeGreaterThanOrEqual(0);
    // Most of that error is gone — the estimate tracked the stall rather than
    // being pinned by it — and what remains is the window's own lag.
    expect(gapItHas).toBeLessThan(gapItWouldHave / 2);
    expect(gapItHas).toBeLessThanOrEqual(8_000 + 100);
  });

  it('has no estimate at all before the first snapshot', () => {
    const receiver = createAlignmentReceiver(1);
    expect(receiver.audioNowMs(1_000)).toBeNull();
    expect(receiver.ageMs(1_000)).toBe(Number.POSITIVE_INFINITY);
  });

  it('drops the clock with the session, so a new take never inherits one', () => {
    const receiver = createAlignmentReceiver(1);
    deliver(receiver, 1, 30_000, 15);
    expect(receiver.audioNowMs(50_000)).not.toBeNull();

    receiver.setSession(2);
    // A new take is a new audio clock starting at zero; carrying the old offset
    // forward would place every prediction half a minute into the future.
    expect(receiver.audioNowMs(50_000)).toBeNull();
  });

  /**
   * The counters describe THIS take's feed, and the stage reads them to answer
   * "is the display not moving because nothing is arriving, or because
   * everything is being thrown away?".
   *
   * One window can serve two takes — present again, a retake — and the engine
   * that owns this receiver survives the change. Carried forward, the counts
   * stop answering that question: a take that rejected everything early keeps
   * supplying the dominant reason for a later healthy take, and, worse in the
   * other direction, one acceptance from the earlier take makes the next take's
   * entirely-rejected feed read as partly healthy.
   */
  it('starts its counters again with each take, so one take cannot explain another', () => {
    const receiver = createAlignmentReceiver(1);
    expect(receiver.accept(snapshot({ seq: 1 }), 0).accepted).toBe(true);
    receiver.accept(snapshot({ sessionGeneration: 9, seq: 2 }), 0);
    receiver.accept(snapshot({ sessionGeneration: 9, seq: 3 }), 0);
    // A structural rejection too, so every counter under test is non-zero
    // before the reset — an assertion that a field is null after clearing is
    // worth nothing if it was null to begin with.
    receiver.accept({ ...snapshot({ seq: 4 }), confidence: Number.NaN }, 0);
    expect(receiver.stats.accepted).toBe(1);
    expect(receiver.stats.rejected).toBe(3);
    expect(receiver.stats.byReason.session_generation).toBe(2);
    expect(receiver.stats.byReason.malformed).toBe(1);
    expect(receiver.stats.lastMalformedField).toBe('confidence');
    expect(receiver.stats.lastAcceptedAtMs).not.toBeNull();

    receiver.setSession(2);

    expect(receiver.stats.accepted).toBe(0);
    expect(receiver.stats.rejected).toBe(0);
    expect(receiver.stats.byReason.session_generation).toBe(0);
    expect(receiver.stats.byReason.malformed).toBe(0);
    expect(receiver.stats.lastAcceptedAtMs).toBeNull();
    expect(receiver.stats.lastMalformedField).toBeNull();

    // And the new take's own feed is counted from zero, under the new
    // generation — the old one is now the rejected case.
    expect(receiver.accept(snapshot({ sessionGeneration: 2, seq: 1 }), 0).accepted).toBe(true);
    expect(receiver.stats.accepted).toBe(1);
    expect(receiver.accept(snapshot({ sessionGeneration: 1, seq: 2 }), 0).accepted).toBe(false);
    expect(receiver.stats.byReason.session_generation).toBe(1);
  });
});

describe('the stage snapshot gate', () => {
  it('rejects a snapshot from another alignment session', () => {
    const receiver = createAlignmentReceiver(1);
    const outcome = receiver.accept(snapshot({ sessionGeneration: 9 }), 0);
    expect(outcome.accepted).toBe(false);
    expect(outcome.reason).toBe('session_generation');
  });

  it('rejects anything not strictly newer, so a replay cannot rewind the stage', () => {
    const receiver = createAlignmentReceiver(1);
    expect(receiver.accept(snapshot({ seq: 5 }), 0).accepted).toBe(true);
    expect(receiver.accept(snapshot({ seq: 5 }), 0).reason).toBe('stale');
    expect(receiver.accept(snapshot({ seq: 4 }), 0).reason).toBe('stale');
    expect(receiver.accept(snapshot({ seq: 6 }), 0).accepted).toBe(true);
  });

  it('rejects a malformed payload without storing any of it', () => {
    const receiver = createAlignmentReceiver(1);
    const outcome = receiver.accept({ ...snapshot(), observedToken: Number.NaN }, 0);
    expect(outcome.accepted).toBe(false);
    expect(outcome.reason).toBe('malformed');
    expect(outcome.field).toBe('observedToken');
    expect(receiver.current).toBeNull();
  });
});
