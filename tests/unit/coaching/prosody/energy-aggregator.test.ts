/**
 * Loudness aggregation (spec §12.7.4, §17.2).
 *
 * The fixture is a level ramp from -40 to -20 dBFS in 1 dB steps, twenty-one
 * frames long, so P10 and P90 land exactly on samples: -38 and -22, a range of
 * exactly 16 dB. Nothing here asserts an absolute loudness, because §12.7.4
 * says CandidCue cannot measure one.
 */
import { describe, expect, it } from 'vitest';
import type { AudioFrameFeatures } from '../../../../src/shared/contracts/coaching';
import { EnergyAggregator } from '../../../../src/shared/coaching/prosody/energy-aggregator';

function frame(
  audioTimeMs: number,
  rmsDbfs: number,
  overrides: Partial<AudioFrameFeatures> = {},
): AudioFrameFeatures {
  return {
    audioTimeMs,
    rmsDbfs,
    peakDbfs: rmsDbfs + 8,
    clippingRatio: 0,
    noiseFloorDbfs: -60,
    estimatedSnrDb: 34,
    speechProbability: 0.9,
    voicedProbability: 0.8,
    f0Hz: 120,
    f0Confidence: 0.9,
    spectralFlux: 0.2,
    zeroCrossingRate: 0.1,
    processorDropout: false,
    ...overrides,
  };
}

/** -40 … -20 dBFS in 1 dB steps, one frame every 20 ms. */
function rampFixture(aggregator: EnergyAggregator): number {
  for (let i = 0; i <= 20; i += 1) {
    aggregator.noteFrame(frame(i * 20, -40 + i));
  }
  return 20 * 20;
}

describe('EnergyAggregator range', () => {
  it('reports exactly the P90-P10 width in dB', () => {
    const aggregator = new EnergyAggregator();
    const nowMs = rampFixture(aggregator);
    const aggregate = aggregator.aggregate(nowMs);

    expect(aggregate.frameCount).toBe(21);
    expect(aggregate.rangeDb).toBe(16);
    expect(aggregate.degraded).toBe(false);
  });

  it('reports a zero range for a level that never moves', () => {
    const aggregator = new EnergyAggregator();
    for (let i = 0; i < 50; i += 1) {
      aggregator.noteFrame(frame(i * 20, -28));
    }
    const aggregate = aggregator.aggregate(1_000);
    expect(aggregate.rangeDb).toBe(0);
    expect(aggregate.narrowLevelRatio).toBe(1);
  });

  it('measures how much speech sits inside a narrow band around the median', () => {
    const aggregator = new EnergyAggregator();
    const nowMs = rampFixture(aggregator);
    // Median is -30; ±1.5 dB admits -31, -30 and -29 — three of twenty-one.
    expect(aggregator.aggregate(nowMs).narrowLevelRatio).toBeCloseTo(3 / 21, 9);
  });
});

describe('EnergyAggregator frame acceptance', () => {
  it('ignores frames that are not speech', () => {
    const aggregator = new EnergyAggregator();
    expect(aggregator.noteFrame(frame(0, -30, { speechProbability: 0.1 }))).toBe(false);
    expect(aggregator.noteFrame(frame(20, -30, { processorDropout: true }))).toBe(false);
    expect(aggregator.noteFrame(frame(40, -30))).toBe(true);
    expect(aggregator.aggregate(100).frameCount).toBe(1);
  });

  it('excludes clipped frames from the range and flags the aggregate degraded', () => {
    // Clipping flattens peaks, so a clipped frame *narrows* the measured range.
    // Counting it would report a shouting presenter as monotone.
    const aggregator = new EnergyAggregator();
    const nowMs = rampFixture(aggregator);
    for (let i = 0; i < 5; i += 1) {
      aggregator.noteFrame(frame(nowMs + i * 20, -3, { clippingRatio: 0.4 }));
    }
    const aggregate = aggregator.aggregate(nowMs + 100);

    expect(aggregate.rangeDb).toBe(16);
    expect(aggregate.frameCount).toBe(21);
    expect(aggregate.clippedFrameRatio).toBeCloseTo(5 / 26, 9);
    expect(aggregate.degraded).toBe(true);
  });

  it('returns nulls, not zeros, when the horizon holds no speech', () => {
    const aggregate = new EnergyAggregator().aggregate(10_000);
    expect(aggregate.rangeDb).toBeNull();
    expect(aggregate.narrowLevelRatio).toBeNull();
    expect(aggregate.phraseContrastDb).toBeNull();
  });

  it('only summarizes frames inside the requested horizon', () => {
    const aggregator = new EnergyAggregator();
    for (let i = 0; i < 20; i += 1) {
      aggregator.noteFrame(frame(i * 20, -30));
    }
    for (let i = 0; i < 20; i += 1) {
      aggregator.noteFrame(frame(20_000 + i * 20, -20));
    }
    expect(aggregator.aggregate(20_400, 5_000).rangeDb).toBe(0);
    expect(aggregator.aggregate(20_400, 30_000).rangeDb).toBe(10);
  });
});

describe('EnergyAggregator phrase contrast', () => {
  it('spreads phrase mean levels, not frame levels', () => {
    // Three phrases at -40, -30 and -20 dBFS. P90 - P10 of {-40, -30, -20}
    // is 16 dB: position 0.1 × 2 = 0.2 → -38, position 1.8 → -22.
    const aggregator = new EnergyAggregator();
    let t = 0;
    for (const level of [-40, -30, -20]) {
      for (let i = 0; i < 10; i += 1) {
        aggregator.noteFrame(frame(t, level));
        t += 20;
      }
      aggregator.notePhraseEnd(t);
    }
    expect(aggregator.aggregate(t).phraseContrastDb).toBeCloseTo(16, 9);
  });

  it('reports no contrast until two phrases have closed', () => {
    const aggregator = new EnergyAggregator();
    for (let i = 0; i < 10; i += 1) {
      aggregator.noteFrame(frame(i * 20, -30));
    }
    aggregator.notePhraseEnd(200);
    expect(aggregator.aggregate(200).phraseContrastDb).toBeNull();
  });
});

describe('EnergyAggregator windowed mean', () => {
  it('averages only the frames inside the window', () => {
    const aggregator = new EnergyAggregator();
    for (let i = 0; i < 10; i += 1) {
      aggregator.noteFrame(frame(i * 20, -30));
    }
    for (let i = 0; i < 10; i += 1) {
      aggregator.noteFrame(frame(1_000 + i * 20, -20));
    }
    expect(aggregator.meanLevelDbfsIn(0, 199)).toBeCloseTo(-30, 9);
    expect(aggregator.meanLevelDbfsIn(1_000, 1_199)).toBeCloseTo(-20, 9);
    expect(aggregator.meanLevelDbfsIn(400, 900)).toBeNull();
  });
});
