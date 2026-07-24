/**
 * §9.5's submetric catalogue, the window helpers it rests on, and the §1.3
 * fairness property.
 *
 * The fairness test drives the *real* `PitchAggregator` with two synthetic
 * speakers an octave apart rather than handing the engine two pre-made
 * aggregates. Asserting on a hand-written `spanSemitones` would prove only that
 * two equal numbers are equal; driving the aggregator proves the whole path
 * from frames to score never touches an absolute hertz value.
 */
import { describe, expect, it } from 'vitest';
import type { AudioFrameFeatures, DeliveryDimension } from '../../../../src/shared/contracts/coaching';
import { DELIVERY_SCORE_WEIGHTS } from '../../../../src/shared/contracts/coaching';
import { PitchAggregator } from '../../../../src/shared/coaching/prosody/pitch-aggregator';
import { DEFAULT_DELIVERY_SCORE_OPTIONS, CONVERSATIONAL_AUTHORITY } from '../../../../src/shared/coaching/score/profile';
import {
  buildSubmetrics,
  countConfirmed,
  longestRunMsInWindow,
  pauseDurationP90,
  SOURCEABLE_WEIGHT,
  UNSOURCED_SUBMETRICS,
  type DeliveryScoreMemory,
} from '../../../../src/shared/coaching/score/submetrics';
import { scoreDimension } from '../../../../src/shared/coaching/score/dimension';
import { evidenceAt, filler } from './evidence-fixture';

const OPTIONS = DEFAULT_DELIVERY_SCORE_OPTIONS;
const PROFILE = CONVERSATIONAL_AUTHORITY;

const MEMORY: DeliveryScoreMemory = {
  wordsInWindow: 150,
  transcriptStability: 1,
  paceDrift: 0.03,
  driftSpanMs: 29_000,
  terminalRushAgeMs: 1_000,
};

const DIMENSIONS = Object.keys(DELIVERY_SCORE_WEIGHTS) as DeliveryDimension[];

describe('the catalogue matches §9.5', () => {
  it('declares every dimension at its contract weight', () => {
    const samples = buildSubmetrics(evidenceAt(60_000), MEMORY, OPTIONS, PROFILE);
    for (const dimension of DIMENSIONS) {
      const total = samples[dimension].reduce((sum, sample) => sum + sample.weight, 0);
      expect(total).toBe(DELIVERY_SCORE_WEIGHTS[dimension]);
    }
  });

  it('agrees with the declared sourceable coverage', () => {
    const samples = buildSubmetrics(evidenceAt(60_000), MEMORY, OPTIONS, PROFILE);
    for (const dimension of DIMENSIONS) {
      const sourceable = samples[dimension]
        .filter((sample) => sample.sourceable !== false)
        .reduce((sum, sample) => sum + sample.weight, 0);
      expect(sourceable).toBe(SOURCEABLE_WEIGHT[dimension]);
    }
  });

  it('accounts for every unsourced submetric with a stated producer', () => {
    const samples = buildSubmetrics(evidenceAt(60_000), MEMORY, OPTIONS, PROFILE);
    const declared = new Set(Object.keys(UNSOURCED_SUBMETRICS));
    let seen = 0;
    for (const dimension of DIMENSIONS) {
      for (const sample of samples[dimension]) {
        if (sample.sourceable !== false) continue;
        seen += 1;
        expect(declared.has(sample.id)).toBe(true);
        expect(sample.score).toBeNull();
        expect(sample.confidence).toBe(0);
        expect(UNSOURCED_SUBMETRICS[sample.id]?.points).toBe(sample.weight);
        expect((UNSOURCED_SUBMETRICS[sample.id]?.needs ?? '').length).toBeGreaterThan(20);
      }
    }
    expect(seen).toBe(declared.size);
    // 28 of the contract's 100 points are unavailable in this build.
    const missing = Object.values(UNSOURCED_SUBMETRICS).reduce(
      (sum, entry) => sum + entry.points,
      0,
    );
    expect(missing).toBe(100 - 14 - 18 - 12 - 15);
  });

  it('leaves emphasis, clarity and consistency entirely unavailable', () => {
    const samples = buildSubmetrics(evidenceAt(60_000), MEMORY, OPTIONS, PROFILE);
    for (const dimension of ['emphasis', 'clarity', 'consistency'] as const) {
      const result = scoreDimension(dimension, samples[dimension], OPTIONS.minimumDimensionEvidence);
      expect(result.score).toBeNull();
      expect(result.confidence).toBe(0);
    }
  });
});

describe('§1.3 / §16.1 fairness — pitch is judged in semitones, never hertz', () => {
  /**
   * One speaker's contour: a repeating rise and fall with a 6-semitone span.
   * Rendered twice, an octave apart, from real frames.
   */
  function aggregateFor(baseHz: number) {
    const aggregator = new PitchAggregator();
    const pattern = [0, 2, 4, 6, 8, 6, 4, 2];
    // Each step is held for 200 ms so the §13.2 median filter smooths noise
    // rather than the contour itself.
    const framesPerStep = 10;
    let index = 0;
    for (let timeMs = 0; timeMs < 20_000; timeMs += 20) {
      const semitones = pattern[Math.floor(index / framesPerStep) % pattern.length] ?? 0;
      index += 1;
      const frame: AudioFrameFeatures = {
        audioTimeMs: timeMs,
        rmsDbfs: -22,
        peakDbfs: -8,
        clippingRatio: 0,
        noiseFloorDbfs: -60,
        estimatedSnrDb: 30,
        speechProbability: 0.95,
        voicedProbability: 0.95,
        f0Hz: baseHz * Math.pow(2, semitones / 12),
        f0Confidence: 0.9,
        spectralFlux: 0.2,
        zeroCrossingRate: 0.1,
        processorDropout: false,
      };
      aggregator.noteFrame(frame);
    }
    return aggregator.aggregate(20_000, null, 30_000);
  }

  it('gives a low and a high voice the same measured span', () => {
    const low = aggregateFor(85); // a low voice
    const high = aggregateFor(170); // exactly one octave higher
    expect(low.spanSemitones).not.toBeNull();
    expect(low.spanSemitones as number).toBeGreaterThan(3);
    expect(high.spanSemitones).toBeCloseTo(low.spanSemitones as number, 9);
    expect(high.iqrSemitones).toBeCloseTo(low.iqrSemitones as number, 9);
    // The references genuinely differ — the test is not comparing two copies.
    expect(high.referenceF0Hz as number).toBeCloseTo((low.referenceF0Hz as number) * 2, 6);
  });

  it('gives them the same variety contribution', () => {
    const low = aggregateFor(85);
    const high = aggregateFor(170);
    const score = (pitch: typeof low) =>
      scoreDimension(
        'variety',
        buildSubmetrics(
          evidenceAt(20_000, {
            pitch: {
              frameCount: pitch.frameCount,
              coveredMs: pitch.coveredMs,
              referenceF0Hz: pitch.referenceF0Hz,
              spanSemitones: pitch.spanSemitones,
              iqrSemitones: pitch.iqrSemitones,
              motionSemitonesPerSecond: pitch.motionSemitonesPerSecond,
              contourTurnsPerMinute: pitch.contourTurnsPerMinute,
              phraseFinalMovementSemitones: pitch.phraseFinalMovementSemitones,
            },
            pitchReliability: { referenceF0Hz: pitch.referenceF0Hz },
          }),
          MEMORY,
          OPTIONS,
          PROFILE,
        ).variety,
        OPTIONS.minimumDimensionEvidence,
      );

    const lowScore = score(low);
    const highScore = score(high);
    expect(lowScore.score).not.toBeNull();
    expect(highScore.score).toBeCloseTo(lowScore.score as number, 9);
    expect(highScore.confidence).toBeCloseTo(lowScore.confidence, 9);
    // And both are *good* scores, not two identically terrible ones. A model
    // that scored absolute hertz would put 85 Hz and 170 Hz equally far outside
    // a 4–10 semitone band and this equality would hold for the wrong reason.
    expect(lowScore.score as number).toBeGreaterThan(80);
  });

  it('scores the pitch-range submetric itself identically and correctly', () => {
    const submetric = (baseHz: number) => {
      const pitch = aggregateFor(baseHz);
      return buildSubmetrics(
        evidenceAt(20_000, {
          pitch: {
            frameCount: pitch.frameCount,
            coveredMs: pitch.coveredMs,
            referenceF0Hz: pitch.referenceF0Hz,
            spanSemitones: pitch.spanSemitones,
            iqrSemitones: pitch.iqrSemitones,
            motionSemitonesPerSecond: pitch.motionSemitonesPerSecond,
            contourTurnsPerMinute: pitch.contourTurnsPerMinute,
            phraseFinalMovementSemitones: pitch.phraseFinalMovementSemitones,
          },
          pitchReliability: { referenceF0Hz: pitch.referenceF0Hz },
        }),
        MEMORY,
        OPTIONS,
        PROFILE,
      ).variety.find((sample) => sample.id === 'variety.pitch_range');
    };
    // A ~6-semitone contour sits inside §8's 4–10 band, whichever octave it is
    // sung in. Both must be exactly 100 — the flat region, not merely equal.
    expect(submetric(85)?.score).toBe(100);
    expect(submetric(170)?.score).toBe(100);
    expect(submetric(340)?.score).toBe(100);
  });
});

describe('§15 — the loudness submetric is suppressed rather than scored low', () => {
  it('goes unavailable when the gain is not stable', () => {
    const stable = buildSubmetrics(
      evidenceAt(60_000, { energy: { rangeDb: 2 } }),
      MEMORY,
      OPTIONS,
      PROFILE,
    ).variety.find((sample) => sample.id === 'variety.loudness_range');
    const clipped = buildSubmetrics(
      evidenceAt(60_000, {
        energy: { rangeDb: 2, degraded: true },
        microphone: { status: 'clipping' },
      }),
      MEMORY,
      OPTIONS,
      PROFILE,
    ).variety.find((sample) => sample.id === 'variety.loudness_range');

    // With a healthy microphone a 2 dB range is a real, low score.
    expect(stable?.score).not.toBeNull();
    expect(stable?.score as number).toBeLessThan(50);
    // With a clipping one it is not a score at all.
    expect(clipped?.score).toBeNull();
    expect(clipped?.confidence).toBe(0);
  });
});

describe('§18.5 — script-relative pausing submetrics are gated on alignment', () => {
  it('does not score a perfect 100 for boundaries it cannot see', () => {
    const blind = buildSubmetrics(
      evidenceAt(60_000, {
        alignmentConfidence: 0.2,
        cadence: { eligibleBoundaries: 0, shapedBoundaries: 0, choppyPauseCount: 0 },
      }),
      MEMORY,
      OPTIONS,
      PROFILE,
    ).pausing;
    const placement = blind.find((sample) => sample.id === 'pausing.boundary_placement');
    const choppy = blind.find((sample) => sample.id === 'pausing.choppy_balance');
    expect(placement?.score).toBeNull();
    expect(choppy?.score).toBeNull();
    expect(choppy?.confidence).toBe(0);
  });

  it('scores them once the alignment is trustworthy', () => {
    const sighted = buildSubmetrics(
      evidenceAt(60_000, {
        alignmentConfidence: 0.9,
        cadence: { eligibleBoundaries: 10, shapedBoundaries: 4, choppyPauseCount: 0 },
      }),
      MEMORY,
      OPTIONS,
      PROFILE,
    ).pausing;
    const placement = sighted.find((sample) => sample.id === 'pausing.boundary_placement');
    // 4 of 10 shaped is 0.4, which is 1.6 sigma below the 0.8 floor.
    expect(placement?.score).toBeCloseTo(100 * Math.exp(-0.5 * (0.4 / 0.25) ** 2), 9);
  });
});

describe('window helpers', () => {
  it('finds the longest speech run between derived pauses', () => {
    // Window 0–30 000. Pauses at 5 000–5 500 and 12 000–12 400, so the runs are
    // 5 000, 6 500 and 17 600 ms.
    const runs = longestRunMsInWindow(
      [
        { startMs: 5_000, endMs: 5_500 },
        { startMs: 12_000, endMs: 12_400 },
      ],
      0,
      30_000,
    );
    expect(runs).toBe(17_600);
  });

  it('reports the whole window when no pause was derived', () => {
    expect(longestRunMsInWindow([], 0, 30_000)).toBe(30_000);
  });

  it('truncates rather than extrapolating past the window edges', () => {
    // A pause that began before the window: only the part inside counts, and
    // the run before it is clipped to zero rather than invented.
    expect(longestRunMsInWindow([{ startMs: -2_000, endMs: 1_000 }], 0, 10_000)).toBe(9_000);
  });

  it('takes the P90 of pause durations once there are enough of them', () => {
    const pauses = [200, 400, 600, 800, 1_000, 3_000].map((duration, index) => ({
      startMs: index * 2_000,
      endMs: index * 2_000 + duration,
    }));
    // P90 of [200,400,600,800,1000,3000] with linear interpolation: position
    // 0.9 × 5 = 4.5, halfway between 1 000 and 3 000.
    expect(pauseDurationP90(pauses, 0, 30_000, 3)).toBeCloseTo(2_000, 6);
  });

  it('refuses a distribution built from too few pauses', () => {
    const pauses = [{ startMs: 0, endMs: 500 }];
    expect(pauseDurationP90(pauses, 0, 30_000, 3)).toBeNull();
  });
});

describe('counting confirmed disfluencies', () => {
  const kinds = new Set(['strict_vocalized'] as const);
  const events = [
    filler({ kind: 'strict_vocalized', audioStartMs: 1_000, audioEndMs: 1_200 }),
    filler({ kind: 'strict_vocalized', audioStartMs: 2_000, audioEndMs: 2_200, confidence: 'probable' }),
    filler({ kind: 'strict_vocalized', audioStartMs: 3_000, audioEndMs: 3_200, confidence: 'rejected' }),
    filler({ kind: 'strict_vocalized', audioStartMs: 4_000, audioEndMs: 4_200, authoredIntentional: true }),
    filler({ kind: 'strict_vocalized', audioStartMs: 5_000, audioEndMs: 5_200, takePassId: 'other' }),
    filler({ kind: 'repeated_word', audioStartMs: 6_000, audioEndMs: 6_200 }),
    filler({ kind: 'strict_vocalized', audioStartMs: 100, audioEndMs: 300 }),
  ];

  it('counts only confirmed, unauthored, in-window events of this take pass', () => {
    expect(countConfirmed(events, kinds, 'pass-1', 500, 10_000)).toBe(1);
  });

  it('separates the three fluency submetrics by kind, without overlap', () => {
    const all = [
      filler({ kind: 'strict_vocalized', audioStartMs: 1_000, audioEndMs: 1_100 }),
      filler({ kind: 'repeated_word', audioStartMs: 2_000, audioEndMs: 2_100 }),
      filler({ kind: 'false_start', audioStartMs: 3_000, audioEndMs: 3_100 }),
      filler({ kind: 'self_correction', audioStartMs: 4_000, audioEndMs: 4_100 }),
      filler({ kind: 'contextual', audioStartMs: 5_000, audioEndMs: 5_100 }),
      filler({ kind: 'repetitive_opener', audioStartMs: 6_000, audioEndMs: 6_100 }),
    ];
    expect(countConfirmed(all, new Set(['strict_vocalized'] as const), 'pass-1', 0, 10_000)).toBe(1);
    expect(
      countConfirmed(
        all,
        new Set(['repeated_word', 'false_start', 'self_correction'] as const),
        'pass-1',
        0,
        10_000,
      ),
    ).toBe(3);
    expect(
      countConfirmed(all, new Set(['contextual', 'repetitive_opener'] as const), 'pass-1', 0, 10_000),
    ).toBe(2);
  });
});

describe('§8.2 / §14.6 — the user’s own target band wins', () => {
  it('scores against the band on the pace tile, not the profile default', () => {
    // A speaker who has set a deliberately slow 90–110 band. At 100 WPM they
    // are on target, even though the §8 default would call that far too slow.
    const samples = buildSubmetrics(
      evidenceAt(60_000, {
        pace: { targetLowWpm: 90, targetHighWpm: 110, wpm: 100 },
        rates: { audibleWpm: 100 },
      }),
      MEMORY,
      OPTIONS,
      PROFILE,
    ).pace;
    expect(samples.find((sample) => sample.id === 'pace.wpm')?.score).toBe(100);

    const defaultBand = buildSubmetrics(
      evidenceAt(60_000, { rates: { audibleWpm: 100 } }),
      MEMORY,
      OPTIONS,
      PROFILE,
    ).pace;
    // Against the §8 default, 100 WPM is 35 below the 135 floor: 1.4 sigmaLow.
    expect(defaultBand.find((sample) => sample.id === 'pace.wpm')?.score).toBeCloseTo(
      100 * Math.exp(-0.5 * (35 / 25) ** 2),
      9,
    );
  });
});
