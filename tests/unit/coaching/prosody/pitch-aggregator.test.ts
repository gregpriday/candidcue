/**
 * Pitch aggregation (spec §13.2–§13.5, §17.2).
 *
 * The fixtures are analytic contours — a flat line, a linear semitone ramp, a
 * triangle — so that span, motion and turn count all have exact closed-form
 * answers. A "pitch moved a bit" assertion would pass for almost any
 * implementation; these do not.
 *
 * A reference of 100 Hz is used throughout because 12 × log2(f0/100) is then
 * simply "semitones above 100 Hz" and the fixture can be written in semitones
 * and converted, rather than the other way round.
 */
import { describe, expect, it } from 'vitest';
import type { AudioFrameFeatures } from '../../../../src/shared/contracts/coaching';
import {
  PitchAggregator,
  toSemitones,
} from '../../../../src/shared/coaching/prosody/pitch-aggregator';

const REFERENCE_HZ = 100;
const HOP_MS = 10;

function hz(semitones: number): number {
  return REFERENCE_HZ * Math.pow(2, semitones / 12);
}

function frame(
  audioTimeMs: number,
  semitones: number | null,
  overrides: Partial<AudioFrameFeatures> = {},
): AudioFrameFeatures {
  return {
    audioTimeMs,
    rmsDbfs: -24,
    peakDbfs: -8,
    clippingRatio: 0,
    noiseFloorDbfs: -60,
    estimatedSnrDb: 36,
    speechProbability: 0.9,
    voicedProbability: 0.9,
    f0Hz: semitones === null ? null : hz(semitones),
    f0Confidence: 0.9,
    spectralFlux: 0.2,
    zeroCrossingRate: 0.1,
    processorDropout: false,
    ...overrides,
  };
}

/** Feed a semitone contour sampled every 10 ms starting at t = 0. */
function feed(aggregator: PitchAggregator, contour: readonly number[]): number {
  contour.forEach((semitones, index) => {
    aggregator.noteFrame(frame(index * HOP_MS, semitones));
  });
  return (contour.length - 1) * HOP_MS;
}

/** A linear ramp from `from` to `to` in `steps` samples, inclusive. */
function ramp(from: number, to: number, steps: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < steps; i += 1) {
    out.push(from + ((to - from) * i) / (steps - 1));
  }
  return out;
}

describe('toSemitones', () => {
  it('is the §13.3 formula and nothing else', () => {
    expect(toSemitones(100, 100)).toBe(0);
    expect(toSemitones(200, 100)).toBeCloseTo(12, 9);
    expect(toSemitones(50, 100)).toBeCloseTo(-12, 9);
    expect(toSemitones(hz(7), 100)).toBeCloseTo(7, 9);
  });
});

describe('PitchAggregator span', () => {
  it('reports a zero span for a perfectly flat contour', () => {
    const aggregator = new PitchAggregator();
    const nowMs = feed(aggregator, new Array<number>(200).fill(3));
    const aggregate = aggregator.aggregate(nowMs, { referenceF0Hz: REFERENCE_HZ });

    expect(aggregate.frameCount).toBe(200);
    expect(aggregate.spanSemitones).toBeCloseTo(0, 9);
    expect(aggregate.iqrSemitones).toBeCloseTo(0, 9);
    expect(aggregate.motionSemitonesPerSecond).toBeCloseTo(0, 9);
  });

  it('reports exactly the P90-P10 width of a two-level contour', () => {
    // 60 samples at 0 st and 40 at 6 st, in alternating plateaus long enough
    // that the §13.2 median filter leaves them alone. P10 = 0, P90 = 6.
    const contour = [
      ...new Array<number>(20).fill(0),
      ...new Array<number>(20).fill(6),
      ...new Array<number>(20).fill(0),
      ...new Array<number>(20).fill(6),
      ...new Array<number>(20).fill(0),
    ];
    const aggregator = new PitchAggregator();
    const nowMs = feed(aggregator, contour);
    const aggregate = aggregator.aggregate(nowMs, { referenceF0Hz: REFERENCE_HZ });

    expect(aggregate.spanSemitones).toBeCloseTo(6, 9);
  });

  it('uses the supplied reference rather than its own rolling median', () => {
    // Every frame is an octave above the reference: the span is zero, but the
    // reference reported back is the one that was handed in.
    const aggregator = new PitchAggregator();
    const nowMs = feed(aggregator, new Array<number>(100).fill(12));
    const supplied = aggregator.aggregate(nowMs, { referenceF0Hz: REFERENCE_HZ });
    expect(supplied.referenceF0Hz).toBe(REFERENCE_HZ);

    // With no reliability supplied it falls back to its own median, which for
    // a flat contour is the contour itself — hence a semitone offset of zero.
    const fallback = aggregator.aggregate(nowMs);
    expect(fallback.referenceF0Hz).toBeCloseTo(hz(12), 6);
  });
});

describe('PitchAggregator motion', () => {
  it('reads exactly 2 semitones per second for a 2 st/s ramp', () => {
    // 0.02 semitones per 10 ms frame is 2 semitones per second by definition.
    const contour: number[] = [];
    for (let i = 0; i < 300; i += 1) {
      contour.push(i * 0.02);
    }
    const aggregator = new PitchAggregator();
    const nowMs = feed(aggregator, contour);
    const aggregate = aggregator.aggregate(nowMs, { referenceF0Hz: REFERENCE_HZ });

    expect(aggregate.motionSemitonesPerSecond).toBeCloseTo(2, 6);
  });

  it('reads half as much for a ramp half as steep', () => {
    const contour: number[] = [];
    for (let i = 0; i < 300; i += 1) {
      contour.push(i * 0.01);
    }
    const aggregator = new PitchAggregator();
    const nowMs = feed(aggregator, contour);
    expect(
      aggregator.aggregate(nowMs, { referenceF0Hz: REFERENCE_HZ }).motionSemitonesPerSecond,
    ).toBeCloseTo(1, 6);
  });

  it('does not treat a gap between phrases as a pitch jump', () => {
    // Two plateaus 5 semitones apart separated by 2 s of unvoiced audio. The
    // 60 ms consecutive-frame gate must drop that one delta; otherwise a single
    // 5-semitone step across a pause dominates the motion estimate.
    const aggregator = new PitchAggregator();
    for (let i = 0; i < 100; i += 1) {
      aggregator.noteFrame(frame(i * HOP_MS, 0));
    }
    for (let i = 0; i < 100; i += 1) {
      aggregator.noteFrame(frame(3_000 + i * HOP_MS, 5));
    }
    const aggregate = aggregator.aggregate(3_990, { referenceF0Hz: REFERENCE_HZ });
    expect(aggregate.motionSemitonesPerSecond).toBeCloseTo(0, 9);
  });
});

describe('PitchAggregator contour turns', () => {
  it('counts exactly the direction changes in an up-down-up contour', () => {
    // Three 40-sample legs: 0 → 4 → 0 → 4 semitones. Two direction changes.
    const contour = [...ramp(0, 4, 40), ...ramp(4, 0, 40), ...ramp(0, 4, 40)];
    const aggregator = new PitchAggregator();
    const nowMs = feed(aggregator, contour);
    const aggregate = aggregator.aggregate(nowMs, { referenceF0Hz: REFERENCE_HZ });

    const turns = ((aggregate.contourTurnsPerMinute ?? 0) * aggregate.coveredMs) / 60_000;
    expect(turns).toBeCloseTo(2, 6);
    expect(aggregate.coveredMs).toBe(1_190);
  });

  it('counts no turns for jitter below the excursion threshold', () => {
    // ±0.2 semitone wobble: real, and not a contour turn.
    const contour: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      contour.push(i % 2 === 0 ? 0.2 : -0.2);
    }
    const aggregator = new PitchAggregator();
    const nowMs = feed(aggregator, contour);
    expect(aggregator.aggregate(nowMs, { referenceF0Hz: REFERENCE_HZ }).contourTurnsPerMinute).toBe(
      0,
    );
  });
});

describe('PitchAggregator frame acceptance', () => {
  it('rejects frames that carry no usable pitch', () => {
    const aggregator = new PitchAggregator();
    expect(aggregator.noteFrame(frame(0, null))).toBe(false);
    expect(aggregator.noteFrame(frame(10, 2, { f0Confidence: 0.2 }))).toBe(false);
    expect(aggregator.noteFrame(frame(20, 2, { voicedProbability: 0.1 }))).toBe(false);
    expect(aggregator.noteFrame(frame(30, 2, { processorDropout: true }))).toBe(false);
    expect(aggregator.noteFrame(frame(40, 2, { clippingRatio: 0.5 }))).toBe(false);
    expect(aggregator.noteFrame(frame(50, 2))).toBe(true);
  });

  it('returns nulls, not zeros, when the horizon holds no accepted frames', () => {
    const aggregator = new PitchAggregator();
    const aggregate = aggregator.aggregate(10_000, { referenceF0Hz: REFERENCE_HZ });
    expect(aggregate.frameCount).toBe(0);
    expect(aggregate.spanSemitones).toBeNull();
    expect(aggregate.motionSemitonesPerSecond).toBeNull();
    expect(aggregate.referenceF0Hz).toBeNull();
  });

  it('only summarizes frames inside the requested horizon', () => {
    const aggregator = new PitchAggregator();
    for (let i = 0; i < 100; i += 1) {
      aggregator.noteFrame(frame(i * HOP_MS, 0));
    }
    for (let i = 0; i < 100; i += 1) {
      aggregator.noteFrame(frame(20_000 + i * HOP_MS, 8));
    }
    // A 5 s horizon at t = 20 990 sees only the second plateau.
    const recent = aggregator.aggregate(20_990, { referenceF0Hz: REFERENCE_HZ }, 5_000);
    expect(recent.frameCount).toBe(100);
    expect(recent.spanSemitones).toBeCloseTo(0, 9);

    // A 30 s horizon sees both, and the span between them.
    const wide = aggregator.aggregate(20_990, { referenceF0Hz: REFERENCE_HZ }, 30_000);
    expect(wide.frameCount).toBe(200);
    expect(wide.spanSemitones).toBeCloseTo(8, 9);
  });
});

describe('PitchAggregator phrase-final movement', () => {
  it('reports a falling terminal as a negative semitone movement', () => {
    // The 300 ms before the phrase end sits 3 semitones below the 300 ms
    // before that: a falling terminal contour.
    const aggregator = new PitchAggregator();
    for (let i = 0; i < 30; i += 1) {
      aggregator.noteFrame(frame(i * HOP_MS, 3));
    }
    for (let i = 0; i < 30; i += 1) {
      aggregator.noteFrame(frame(300 + i * HOP_MS, 0));
    }
    aggregator.notePhraseEnd(600, REFERENCE_HZ);

    const aggregate = aggregator.aggregate(600, { referenceF0Hz: REFERENCE_HZ });
    expect(aggregate.phraseFinalMovementSemitones).toBeCloseTo(-3, 6);
  });

  it('reports nothing when the phrase edge holds no usable pitch', () => {
    const aggregator = new PitchAggregator();
    aggregator.notePhraseEnd(600, REFERENCE_HZ);
    expect(
      aggregator.aggregate(600, { referenceF0Hz: REFERENCE_HZ }).phraseFinalMovementSemitones,
    ).toBeNull();
  });
});
