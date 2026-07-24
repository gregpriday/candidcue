/**
 * Emphasis-aware analysis (spec §17.11).
 *
 * §17.11 makes live emphasis coaching a Phase 2 feature, so the strongest
 * assertion in this file is a negative one: {@link EmphasisAnalyzer} has no
 * path that produces a `CoachCandidate`. It measures, and it refuses to
 * measure when word-to-audio localization is not confident.
 *
 * The fixtures place a marked phrase 6 dB above its neighbourhood, so the
 * expected contrast is exactly 6 dB and not "some positive number".
 */
import { describe, expect, it } from 'vitest';
import type { AudioFrameFeatures } from '../../../../src/shared/contracts/coaching';
import { EnergyAggregator } from '../../../../src/shared/coaching/prosody/energy-aggregator';
import { PitchAggregator } from '../../../../src/shared/coaching/prosody/pitch-aggregator';
import {
  EmphasisAnalyzer,
  type EmphasisSpan,
} from '../../../../src/shared/coaching/prosody/emphasis-analyzer';

const REFERENCE_HZ = 100;

function frame(
  audioTimeMs: number,
  rmsDbfs: number,
  semitones: number,
): AudioFrameFeatures {
  return {
    audioTimeMs,
    rmsDbfs,
    peakDbfs: rmsDbfs + 8,
    clippingRatio: 0,
    noiseFloorDbfs: -60,
    estimatedSnrDb: 36,
    speechProbability: 0.9,
    voicedProbability: 0.9,
    f0Hz: REFERENCE_HZ * Math.pow(2, semitones / 12),
    f0Confidence: 0.9,
    spectralFlux: 0.2,
    zeroCrossingRate: 0.1,
    processorDropout: false,
  };
}

/**
 * Three seconds of speech: -30 dBFS at 0 st, then a marked phrase from 1 000
 * to 2 000 ms at -24 dBFS and +4 st, then -30 dBFS at 0 st again.
 */
function fixture(): { pitch: PitchAggregator; energy: EnergyAggregator } {
  const pitch = new PitchAggregator();
  const energy = new EnergyAggregator();
  for (let t = 0; t < 3_000; t += 20) {
    const marked = t >= 1_000 && t < 2_000;
    const f = frame(t, marked ? -24 : -30, marked ? 4 : 0);
    pitch.noteFrame(f);
    energy.noteFrame(f);
  }
  return { pitch, energy };
}

function span(overrides: Partial<EmphasisSpan> = {}): EmphasisSpan {
  return {
    spanId: 'span-1',
    startMs: 1_000,
    endMs: 1_999,
    localizationConfidence: 0.9,
    ...overrides,
  };
}

describe('EmphasisAnalyzer', () => {
  it('measures the marked phrase against its neighbourhood, in speaker-relative units', () => {
    const { pitch, energy } = fixture();
    const analyzer = new EmphasisAnalyzer();
    const measurement = analyzer.measure(span(), pitch, energy, REFERENCE_HZ);

    expect(measurement.measurable).toBe(true);
    expect(measurement.reason).toBe('ok');
    expect(measurement.energyContrastDb).toBeCloseTo(6, 9);
    expect(measurement.pitchContrastSemitones).toBeCloseTo(4, 6);
  });

  it('reports no contrast for a phrase that matches its surroundings', () => {
    const pitch = new PitchAggregator();
    const energy = new EnergyAggregator();
    for (let t = 0; t < 3_000; t += 20) {
      const f = frame(t, -30, 0);
      pitch.noteFrame(f);
      energy.noteFrame(f);
    }
    const measurement = new EmphasisAnalyzer().measure(span(), pitch, energy, REFERENCE_HZ);
    expect(measurement.energyContrastDb).toBeCloseTo(0, 9);
    expect(measurement.pitchContrastSemitones).toBeCloseTo(0, 9);
  });

  it('refuses to measure when word-to-audio localization is uncertain (§17.11)', () => {
    const { pitch, energy } = fixture();
    const measurement = new EmphasisAnalyzer().measure(
      span({ localizationConfidence: 0.4 }),
      pitch,
      energy,
      REFERENCE_HZ,
    );
    expect(measurement.measurable).toBe(false);
    expect(measurement.reason).toBe('low_localization_confidence');
    expect(measurement.energyContrastDb).toBeNull();
    expect(measurement.pitchContrastSemitones).toBeNull();
  });

  it('refuses to measure a phrase with no neighbouring speech to compare against', () => {
    const pitch = new PitchAggregator();
    const energy = new EnergyAggregator();
    for (let t = 1_000; t < 2_000; t += 20) {
      const f = frame(t, -24, 4);
      pitch.noteFrame(f);
      energy.noteFrame(f);
    }
    const measurement = new EmphasisAnalyzer().measure(span(), pitch, energy, REFERENCE_HZ);
    expect(measurement.measurable).toBe(false);
    expect(measurement.reason).toBe('no_neighbourhood');
  });

  it('reports energy contrast without pitch when pitch is unusable', () => {
    const { energy } = fixture();
    const pitch = new PitchAggregator();
    const measurement = new EmphasisAnalyzer().measure(span(), pitch, energy, null);
    expect(measurement.measurable).toBe(true);
    expect(measurement.energyContrastDb).toBeCloseTo(6, 9);
    expect(measurement.pitchContrastSemitones).toBeNull();
  });
});

describe('EmphasisAnalyzer contrastNorm', () => {
  it('reports nothing until something measurable has been seen (§17.5)', () => {
    const analyzer = new EmphasisAnalyzer();
    expect(analyzer.contrastNorm()).toBeNull();

    const { pitch, energy } = fixture();
    analyzer.measure(span({ localizationConfidence: 0.1 }), pitch, energy, REFERENCE_HZ);
    expect(analyzer.contrastNorm()).toBeNull();
  });

  it('normalizes the measured contrast onto 0–1', () => {
    const { pitch, energy } = fixture();
    const analyzer = new EmphasisAnalyzer();
    analyzer.measure(span(), pitch, energy, REFERENCE_HZ);
    // Pitch 4 st on the 0.5–4 ramp saturates at 1; energy 6 dB on the
    // 0.5–6 ramp also saturates at 1; the mean is 1.
    expect(analyzer.contrastNorm()).toBeCloseTo(1, 9);
  });

  it('is near zero for a flat delivery', () => {
    const pitch = new PitchAggregator();
    const energy = new EnergyAggregator();
    for (let t = 0; t < 3_000; t += 20) {
      const f = frame(t, -30, 0);
      pitch.noteFrame(f);
      energy.noteFrame(f);
    }
    const analyzer = new EmphasisAnalyzer();
    analyzer.measure(span(), pitch, energy, REFERENCE_HZ);
    expect(analyzer.contrastNorm()).toBeCloseTo(0, 9);
  });

  it('keeps a record of every measurement for the post-take report', () => {
    const { pitch, energy } = fixture();
    const analyzer = new EmphasisAnalyzer();
    analyzer.measure(span({ spanId: 'a' }), pitch, energy, REFERENCE_HZ);
    analyzer.measure(span({ spanId: 'b', localizationConfidence: 0.2 }), pitch, energy, REFERENCE_HZ);
    expect(analyzer.recorded().map((entry) => [entry.spanId, entry.measurable])).toEqual([
      ['a', true],
      ['b', false],
    ]);
  });
});
