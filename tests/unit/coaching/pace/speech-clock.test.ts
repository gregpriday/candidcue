/**
 * Speech clock (spec §5.4, §12.5, §14.1).
 *
 * Every number asserted here is computed by hand from the fixture, not read
 * back from the implementation. The fixtures are built so that the *wrong*
 * accounting — counting a dropout as silence, deleting internal pauses from
 * the clock, double-counting frames against intervals — produces a visibly
 * different number, not a slightly different one.
 */
import { describe, expect, it } from 'vitest';
import type { AudioFrameFeatures, SpeechInterval } from '../../../../src/shared/contracts/coaching';
import {
  COACH_FRAME_DURATION_MS,
  createEvidenceStamp,
  SpeechClock,
} from '../../../../src/shared/coaching/pace/speech-clock';

function frame(audioTimeMs: number, overrides: Partial<AudioFrameFeatures> = {}): AudioFrameFeatures {
  return {
    audioTimeMs,
    rmsDbfs: -22,
    peakDbfs: -6,
    clippingRatio: 0,
    noiseFloorDbfs: -60,
    estimatedSnrDb: 38,
    speechProbability: 0.9,
    voicedProbability: 0.9,
    f0Hz: 120,
    f0Confidence: 0.9,
    spectralFlux: 0.2,
    zeroCrossingRate: 0.1,
    processorDropout: false,
    ...overrides,
  };
}

function interval(overrides: Partial<SpeechInterval> = {}): SpeechInterval {
  return {
    startMs: 0,
    endMs: 1_000,
    voicedMs: 1_000,
    silenceMs: 0,
    meanSnrDb: 35,
    takePassId: 'pass-1',
    ...overrides,
  };
}

describe('SpeechClock delivery accounting', () => {
  it('removes worklet dropouts from delivery time instead of counting them as silence', () => {
    // 10 000 ms of frames, of which [5 000, 6 000) is a reported dropout.
    // Delivery time must be 9 000 ms: a dropout is unmeasured audio, not a pause.
    const clock = new SpeechClock();
    clock.start(0);
    for (let t = 0; t < 10_000; t += COACH_FRAME_DURATION_MS) {
      clock.noteFrame(frame(t, { processorDropout: t >= 5_000 && t < 6_000 }));
    }

    const snapshot = clock.snapshot();
    expect(snapshot.audioTimeMs).toBe(10_000);
    expect(snapshot.unmeasuredMs).toBe(1_000);
    expect(snapshot.deliveryMs).toBe(9_000);
  });

  it('keeps internal pauses inside delivery time but out of voiced time', () => {
    // §12.5 "label pauses rather than deleting them from the clock": a 10 s run
    // with 2 s of preserved internal silence is 10 s of delivery, 8 s voiced.
    const clock = new SpeechClock();
    clock.start(0);
    clock.noteSpeechInterval(interval({ startMs: 0, endMs: 10_000, voicedMs: 8_000, silenceMs: 2_000 }));

    const snapshot = clock.snapshot();
    expect(snapshot.deliveryMs).toBe(10_000);
    expect(snapshot.voicedMs).toBe(8_000);
    expect(snapshot.internalPauseMs).toBe(2_000);
  });

  it('does not double count frames against closed intervals', () => {
    // Frames drive the live-speech signal only; voiced accounting comes from
    // intervals. Replaying the same second as 50 frames *and* one interval must
    // still report 1 000 ms of voiced audio, not 2 000.
    const clock = new SpeechClock();
    clock.start(0);
    for (let t = 0; t < 1_000; t += COACH_FRAME_DURATION_MS) {
      clock.noteFrame(frame(t));
    }
    clock.noteSpeechInterval(interval({ startMs: 0, endMs: 1_000, voicedMs: 1_000 }));
    expect(clock.snapshot().voicedMs).toBe(1_000);
  });

  it('excludes manual pauses from delivery time', () => {
    const clock = new SpeechClock();
    clock.start(1_000);
    clock.advanceTo(5_000);
    clock.noteUnmeasured(2_000, 4_500, 'manual_pause');
    clock.advanceTo(6_000);
    // 1 000 → 6 000 is 5 000 ms elapsed; 2 500 ms of it was a manual pause.
    expect(clock.snapshot().deliveryMs).toBe(2_500);
  });

  it('merges overlapping unmeasured spans of the same reason instead of summing them', () => {
    const clock = new SpeechClock();
    clock.start(0);
    clock.noteUnmeasured(1_000, 3_000, 'processor_dropout');
    clock.noteUnmeasured(2_000, 4_000, 'processor_dropout');
    clock.advanceTo(10_000);
    // Union is [1 000, 4 000) = 3 000 ms, not 2 000 + 2 000.
    expect(clock.snapshot().unmeasuredMs).toBe(3_000);
    expect(clock.snapshot().deliveryMs).toBe(7_000);
  });
});

describe('SpeechClock windows', () => {
  it('apportions an interval voiced total across a partial window', () => {
    // 4 000 ms run containing 2 000 ms voiced; a window covering its second
    // half must see half the voiced total.
    const clock = new SpeechClock();
    clock.start(0);
    clock.noteSpeechInterval(interval({ startMs: 0, endMs: 4_000, voicedMs: 2_000, silenceMs: 2_000 }));
    expect(clock.voicedMsIn(2_000, 4_000)).toBe(1_000);
    expect(clock.voicedMsIn(0, 4_000)).toBe(2_000);
    expect(clock.voicedMsIn(4_000, 8_000)).toBe(0);
  });

  it('clips voiced sub-intervals to the requested window', () => {
    const clock = new SpeechClock();
    clock.start(0);
    clock.noteSpeechInterval(interval({ startMs: 0, endMs: 1_000 }));
    clock.noteSpeechInterval(interval({ startMs: 3_000, endMs: 5_000, voicedMs: 2_000 }));
    expect(clock.voicedSubIntervalsIn(500, 4_000)).toEqual([
      { startMs: 500, endMs: 1_000 },
      { startMs: 3_000, endMs: 4_000 },
    ]);
  });
});

describe('SpeechClock silence ladder input', () => {
  it('measures silence from the last evidence of voice, and reports null before any speech', () => {
    const clock = new SpeechClock();
    clock.start(0);
    expect(clock.snapshot().silenceSinceSpeechMs).toBeNull();

    clock.noteFrame(frame(0));
    clock.advanceTo(2_500);
    // Voice activity ended at the frame end, 20 ms.
    expect(clock.snapshot().silenceSinceSpeechMs).toBe(2_480);
    expect(clock.snapshot().speaking).toBe(false);
  });

  it('treats a closed interval end as voice activity even when no frame followed', () => {
    const clock = new SpeechClock();
    clock.start(0);
    clock.noteSpeechInterval(interval({ startMs: 0, endMs: 4_000, voicedMs: 4_000 }));
    clock.advanceTo(4_600);
    expect(clock.snapshot().silenceSinceSpeechMs).toBe(600);
  });

  it('does not let a dropout frame masquerade as speech', () => {
    const clock = new SpeechClock();
    clock.start(0);
    clock.noteFrame(frame(0, { processorDropout: true, speechProbability: 0.99 }));
    expect(clock.snapshot().silenceSinceSpeechMs).toBeNull();
    expect(clock.snapshot().speaking).toBe(false);
  });
});

describe('createEvidenceStamp', () => {
  it('stamps the interval the evidence describes, not the moment it was computed', () => {
    // §5.4: a delayed result is mapped back onto its own interval. The stamp
    // must carry the passed bounds, never `context.audioTimeMs`.
    const stamp = createEvidenceStamp(1_000, 2_000, {
      audioTimeMs: 9_500,
      trackingEpoch: 7,
      takePassId: 'pass-3',
      commitSequence: 42,
    });
    expect(stamp).toEqual({
      audioStartMs: 1_000,
      audioEndMs: 2_000,
      commitSequence: 42,
      trackingEpoch: 7,
      takePassId: 'pass-3',
    });
  });

  it('never produces an end before its start', () => {
    const stamp = createEvidenceStamp(5_000, 4_000, {
      audioTimeMs: 5_000,
      trackingEpoch: 1,
      takePassId: 'pass-1',
      commitSequence: null,
    });
    expect(stamp.audioEndMs).toBe(5_000);
  });
});
