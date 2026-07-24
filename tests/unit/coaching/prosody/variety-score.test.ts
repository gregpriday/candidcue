/**
 * Vocal variety (spec §2.5, §13.4, §13.5, §17, §27.2).
 *
 * Two binding product decisions are tested here rather than assumed:
 *
 * - **§2.5** — more variety is not better. `very_steady` and `highly_animated`
 *   are checked with mirrored fixtures and the hysteresis on each side is
 *   asserted to be the same distance from the band.
 * - **§13.4 / §17.5** — when pitch is unusable there is no number. Several
 *   tests drive long runs of unusable audio and assert `level` stays `null`
 *   and no candidate is ever produced.
 *
 * The fixtures work backwards from a target score: with emphasis contrast
 * absent the remaining weights sum to 0.90, so setting every normalized
 * feature to `V / 100` produces exactly `V`. That inverse is checked directly
 * in the formula tests below, so the state-machine tests can rely on it.
 */
import { describe, expect, it } from 'vitest';
import type { CoachCandidate, PitchReliability } from '../../../../src/shared/contracts/coaching';
import type { CoachClockContext } from '../../../../src/shared/coaching/pace/speech-clock';
import type { EnergyAggregate } from '../../../../src/shared/coaching/prosody/energy-aggregator';
import type { PitchAggregate } from '../../../../src/shared/coaching/prosody/pitch-aggregator';
import {
  normalizeVarietyFeatures,
  VARIETY_NORM_PRIORS,
  VarietyAnalyzer,
  varietyLevel,
  type VarietyAnalyzerResult,
  type VarietyFeatureNorms,
} from '../../../../src/shared/coaching/prosody/variety-score';

function ctx(audioTimeMs: number): CoachClockContext {
  return { audioTimeMs, trackingEpoch: 2, takePassId: 'pass-9', commitSequence: null };
}

function reliability(overrides: Partial<PitchReliability> = {}): PitchReliability {
  return {
    usable: true,
    reliableFrameFraction: 0.85,
    usableVoicedMs: 30_000,
    referenceF0Hz: 120,
    reason: 'ok',
    ...overrides,
  };
}

/** Invert the §17.4 ramps: a normalized value back to a raw feature. */
function rawPitchSpan(norm: number): number {
  const { lo, hi } = VARIETY_NORM_PRIORS.pitchSpanSemitones;
  return lo + norm * (hi - lo);
}
function rawPitchMotion(norm: number): number {
  const { lo, hi } = VARIETY_NORM_PRIORS.pitchMotionSemitonesPerSecond;
  return lo + norm * (hi - lo);
}
function rawEnergyRange(norm: number): number {
  const { lo, hi } = VARIETY_NORM_PRIORS.energyRangeDb;
  return lo + norm * (hi - lo);
}
function rawTempoCv(norm: number): number {
  const { lo, hi } = VARIETY_NORM_PRIORS.tempoVariationCv;
  return lo + norm * (hi - lo);
}

function pitchAggregate(spanNorm: number, motionNorm: number): PitchAggregate {
  return {
    frameCount: 900,
    coveredMs: 30_000,
    referenceF0Hz: 120,
    spanSemitones: rawPitchSpan(spanNorm),
    iqrSemitones: rawPitchSpan(spanNorm) / 2,
    motionSemitonesPerSecond: rawPitchMotion(motionNorm),
    contourTurnsPerMinute: 20,
    phraseFinalMovementSemitones: -2,
  };
}

function energyAggregate(rangeNorm: number): EnergyAggregate {
  return {
    frameCount: 900,
    rangeDb: rawEnergyRange(rangeNorm),
    phraseContrastDb: 5,
    narrowLevelRatio: 0.3,
    clippedFrameRatio: 0,
    degraded: false,
  };
}

interface DriveOptions {
  pitchSpanNorm?: number;
  pitchMotionNorm?: number;
  energyRangeNorm?: number;
  tempoNorm?: number;
  reliability?: PitchReliability;
  completedSentences?: number;
  microphoneProblem?: boolean;
  suppressVarietyCoaching?: boolean;
}

/** One update at `atMs` with every normalized feature set to `norm`. */
function update(
  analyzer: VarietyAnalyzer,
  atMs: number,
  norm: number,
  options: DriveOptions = {},
): VarietyAnalyzerResult {
  return analyzer.update({
    context: ctx(atMs),
    reliability: options.reliability ?? reliability(),
    pitch: pitchAggregate(options.pitchSpanNorm ?? norm, options.pitchMotionNorm ?? norm),
    energy: energyAggregate(options.energyRangeNorm ?? norm),
    tempoVariationCv: rawTempoCv(options.tempoNorm ?? norm),
    emphasisContrastNorm: null,
    completedSentences: options.completedSentences ?? 4,
    microphoneProblem: options.microphoneProblem ?? false,
    suppressVarietyCoaching: options.suppressVarietyCoaching ?? false,
  });
}

/** Hold a level long enough to clear §17.8's minimum persistence. */
function settle(
  analyzer: VarietyAnalyzer,
  level: number,
  startMs: number,
  options: DriveOptions = {},
): VarietyAnalyzerResult {
  update(analyzer, startMs, level / 100, options);
  return update(analyzer, startMs + 2_500, level / 100, options);
}

/** As {@link settle}, but collecting every candidate proposed along the way. */
function settleAll(
  analyzer: VarietyAnalyzer,
  level: number,
  startMs: number,
  options: DriveOptions = {},
): { last: VarietyAnalyzerResult; candidates: CoachCandidate[] } {
  const first = update(analyzer, startMs, level / 100, options);
  const last = update(analyzer, startMs + 2_500, level / 100, options);
  return { last, candidates: [...first.candidates, ...last.candidates] };
}

/** No smoothing lag, so a test can place the level exactly where it wants it. */
const IMMEDIATE = { smoothingHalfLifeMs: 1, minPublishIntervalMs: 0 };

describe('varietyLevel (§17.5)', () => {
  const all = (value: number, emphasis: number | null = null): VarietyFeatureNorms => ({
    pitchSpanNorm: value,
    pitchMotionNorm: value,
    energyRangeNorm: value,
    tempoVariationNorm: value,
    emphasisContrastNorm: emphasis,
  });

  it('spans the full 0–100 range', () => {
    expect(varietyLevel(all(0))).toBe(0);
    expect(varietyLevel(all(1))).toBe(100);
    expect(varietyLevel(all(1, 1))).toBe(100);
  });

  it('is exactly 100 × the common normalized value when features agree', () => {
    // This is the inverse the state-machine fixtures below rely on.
    expect(varietyLevel(all(0.25))).toBeCloseTo(25, 9);
    expect(varietyLevel(all(0.95))).toBeCloseTo(95, 9);
  });

  it('redistributes the weight of an absent feature instead of scoring it zero', () => {
    // Only pitch span is present. With emphasis absent the surviving weights
    // are 0.35 + 0.20 + 0.20 + 0.15 = 0.90, so the answer is 0.35 / 0.90.
    const onlySpan: VarietyFeatureNorms = {
      pitchSpanNorm: 1,
      pitchMotionNorm: 0,
      energyRangeNorm: 0,
      tempoVariationNorm: 0,
      emphasisContrastNorm: null,
    };
    expect(varietyLevel(onlySpan)).toBeCloseTo((0.35 / 0.9) * 100, 9);

    // Scoring the missing emphasis term as zero instead would give 0.35 / 1.00,
    // i.e. a lower number for the same performance.
    expect(varietyLevel({ ...onlySpan, emphasisContrastNorm: 0 })).toBeCloseTo(35, 9);
  });

  it('redistributes an absent energy or tempo term too', () => {
    const norms: VarietyFeatureNorms = {
      pitchSpanNorm: 0.6,
      pitchMotionNorm: 0.6,
      energyRangeNorm: null,
      tempoVariationNorm: null,
      emphasisContrastNorm: null,
    };
    // Only the two pitch terms survive, and they agree, so the answer is 60.
    expect(varietyLevel(norms)).toBeCloseTo(60, 9);
  });

  it('weights pitch span most heavily, per §17.5', () => {
    const spanOnly = varietyLevel({
      pitchSpanNorm: 1,
      pitchMotionNorm: 0,
      energyRangeNorm: 0,
      tempoVariationNorm: 0,
      emphasisContrastNorm: 0,
    });
    const energyOnly = varietyLevel({
      pitchSpanNorm: 0,
      pitchMotionNorm: 0,
      energyRangeNorm: 1,
      tempoVariationNorm: 0,
      emphasisContrastNorm: 0,
    });
    expect(spanOnly).toBeCloseTo(35, 9);
    expect(energyOnly).toBeCloseTo(20, 9);
  });
});

describe('normalizeVarietyFeatures', () => {
  it('refuses to produce features without pitch (§17.5)', () => {
    const noPitch: PitchAggregate = { ...pitchAggregate(0.5, 0.5), spanSemitones: null };
    expect(normalizeVarietyFeatures(noPitch, energyAggregate(0.5), 0.2, null)).toBeNull();

    const noMotion: PitchAggregate = {
      ...pitchAggregate(0.5, 0.5),
      motionSemitonesPerSecond: null,
    };
    expect(normalizeVarietyFeatures(noMotion, energyAggregate(0.5), 0.2, null)).toBeNull();
  });

  it('passes a missing energy range or tempo through as null, not zero', () => {
    const norms = normalizeVarietyFeatures(
      pitchAggregate(0.5, 0.5),
      { ...energyAggregate(0.5), rangeDb: null },
      null,
      null,
    );
    expect(norms?.energyRangeNorm).toBeNull();
    expect(norms?.tempoVariationNorm).toBeNull();
    expect(norms?.pitchSpanNorm).toBeCloseTo(0.5, 9);
  });
});

describe('VarietyAnalyzer never invents a score (§13.4, §17.5)', () => {
  it('shows learning, not a number, while there is too little voiced audio', () => {
    const analyzer = new VarietyAnalyzer();
    const result = update(analyzer, 5_000, 0.6, {
      reliability: reliability({
        usable: false,
        usableVoicedMs: 4_000,
        reason: 'insufficient_voiced_audio',
      }),
    });
    expect(result.display.state).toBe('learning');
    expect(result.display.level).toBeNull();
    expect(result.display.pitchSpanSemitones).toBeNull();
    expect(result.candidates).toEqual([]);
  });

  it('shows low confidence, not a number, when pitch is unusable for any other reason', () => {
    for (const reason of ['low_snr', 'competing_audio', 'clipping', 'octave_instability'] as const) {
      const analyzer = new VarietyAnalyzer();
      const result = update(analyzer, 30_000, 0.6, {
        reliability: reliability({ usable: false, reason }),
      });
      expect(result.display.state).toBe('low_confidence');
      expect(result.display.level).toBeNull();
      expect(result.display.pitchSpanSemitones).toBeNull();
    }
  });

  it('still reports the energy range it did measure', () => {
    // Energy is measured and true even when pitch is not. It is reported —
    // and it never becomes a variety score on its own.
    const analyzer = new VarietyAnalyzer();
    const result = update(analyzer, 30_000, 0.5, {
      reliability: reliability({ usable: false, reason: 'low_snr' }),
    });
    expect(result.display.energyRangeDb).toBeCloseTo(rawEnergyRange(0.5), 9);
    expect(result.display.level).toBeNull();
  });

  it('stays silent for a whole take of unusable pitch', () => {
    const analyzer = new VarietyAnalyzer();
    const unusable = reliability({ usable: false, reason: 'competing_audio' });
    for (let t = 0; t <= 120_000; t += 1_000) {
      const result = update(analyzer, t, 0.9, { reliability: unusable });
      expect(result.display.level).toBeNull();
      expect(result.candidates).toEqual([]);
    }
  });

  it('withholds the number during §17.7 calibration even when pitch is usable', () => {
    const analyzer = new VarietyAnalyzer();
    const result = update(analyzer, 12_000, 0.6, {
      reliability: reliability({ usableVoicedMs: 12_000 }),
    });
    expect(result.display.state).toBe('learning');
    expect(result.display.level).toBeNull();

    const later = update(analyzer, 20_000, 0.6, {
      reliability: reliability({ usableVoicedMs: 16_000 }),
    });
    expect(later.display.level).not.toBeNull();
  });

  it('withholds the number when the reliable-frame fraction is barely over the gate', () => {
    const analyzer = new VarietyAnalyzer();
    const result = update(analyzer, 30_000, 0.6, {
      reliability: reliability({ reliableFrameFraction: 0.5 }),
    });
    // (0.50 - 0.45) / 0.40 = 0.125, below the 0.5 display threshold.
    expect(result.display.confidence).toBeCloseTo(0.125, 6);
    expect(result.display.state).toBe('low_confidence');
    expect(result.display.level).toBeNull();
  });

  it('reports low confidence rather than a score when pitch produced no aggregate', () => {
    const analyzer = new VarietyAnalyzer();
    const result = analyzer.update({
      context: ctx(30_000),
      reliability: reliability(),
      pitch: { ...pitchAggregate(0.5, 0.5), spanSemitones: null },
      energy: energyAggregate(0.5),
      tempoVariationCv: 0.2,
    });
    expect(result.display.state).toBe('low_confidence');
    expect(result.display.level).toBeNull();
  });
});

describe('VarietyAnalyzer state classification (§17.8)', () => {
  it('places a mid-band score in balanced', () => {
    const analyzer = new VarietyAnalyzer({ profile: IMMEDIATE });
    const result = settle(analyzer, 60, 0);
    expect(result.display.level).toBeCloseTo(60, 6);
    expect(result.display.state).toBe('balanced');
    expect(result.display.targetLow).toBe(45);
    expect(result.display.targetHigh).toBe(75);
  });

  it('treats the two extremes symmetrically (§2.5)', () => {
    // 25 is 20 points below the band; 95 is 20 points above it. Neither is
    // "better"; both are outside target.
    const steady = new VarietyAnalyzer({ profile: IMMEDIATE });
    const animated = new VarietyAnalyzer({ profile: IMMEDIATE });

    const steadyResult = settle(steady, 25, 0);
    const animatedResult = settle(animated, 95, 0);

    expect(steadyResult.display.state).toBe('very_steady');
    expect(animatedResult.display.state).toBe('highly_animated');
    expect(steadyResult.display.targetLow - (steadyResult.display.level ?? 0)).toBeCloseTo(
      (animatedResult.display.level ?? 0) - animatedResult.display.targetHigh,
      6,
    );
  });

  it('applies the same hysteresis width on both sides of the band', () => {
    // Leaving `very_steady` needs the score at or above 35 (= 45 - 15 + 5);
    // leaving `highly_animated` needs it at or below 85 (= 75 + 15 - 5).
    // Both are 10 points inside the shoulder.
    const steady = new VarietyAnalyzer({ profile: IMMEDIATE });
    settle(steady, 25, 0);
    expect(settle(steady, 34, 5_000).display.state).toBe('very_steady');
    expect(settle(steady, 36, 15_000).display.state).toBe('steady');

    const animated = new VarietyAnalyzer({ profile: IMMEDIATE });
    settle(animated, 95, 0);
    expect(settle(animated, 86, 5_000).display.state).toBe('highly_animated');
    expect(settle(animated, 84, 15_000).display.state).toBe('expressive');
  });

  it('requires a new state to persist before publishing it', () => {
    const analyzer = new VarietyAnalyzer({ profile: IMMEDIATE });
    settle(analyzer, 60, 0);
    // A single sample well below the band does not immediately flip the tile.
    expect(update(analyzer, 5_000, 0.2).display.state).toBe('balanced');
    expect(update(analyzer, 5_500, 0.2).display.state).toBe('balanced');
    expect(update(analyzer, 7_600, 0.2).display.state).toBe('very_steady');
  });

  it('uses the style band rather than a hard-coded one', () => {
    // 62 is expressive for a calm/authoritative target of 35–60 and balanced
    // for a natural target of 45–75. Same delivery, different production.
    const calm = new VarietyAnalyzer({ style: 'calm', profile: IMMEDIATE });
    expect(settle(calm, 62, 0).display.state).toBe('expressive');
    expect(calm.profile.targetLow).toBe(35);
    expect(calm.profile.targetHigh).toBe(60);

    const natural = new VarietyAnalyzer({ style: 'natural', profile: IMMEDIATE });
    expect(settle(natural, 62, 0).display.state).toBe('balanced');
  });
});

describe('VarietyAnalyzer smoothing (§17.3)', () => {
  it('moves toward a new level over the EWMA half-life rather than jumping', () => {
    const analyzer = new VarietyAnalyzer({ profile: { minPublishIntervalMs: 0 } });
    const first = update(analyzer, 0, 0.2);
    expect(first.display.level).toBeCloseTo(20, 6);

    // One half-life later the level should have moved halfway from 20 to 80.
    const later = update(analyzer, 8_000, 0.8);
    expect(later.rawLevel).toBeCloseTo(80, 6);
    expect(later.display.level).toBeCloseTo(50, 6);
  });

  it('does not refresh the published number faster than twice a second', () => {
    const analyzer = new VarietyAnalyzer({ profile: { smoothingHalfLifeMs: 1 } });
    expect(update(analyzer, 0, 0.2).display.level).toBeCloseTo(20, 6);
    // 100 ms later the smoother already says 80, but the tile must not.
    const held = update(analyzer, 100, 0.8);
    expect(held.rawLevel).toBeCloseTo(80, 6);
    expect(held.display.level).toBeCloseTo(20, 6);
    expect(update(analyzer, 600, 0.8).display.level).toBeCloseTo(80, 6);
  });
});

describe('VarietyAnalyzer low-variety candidate (§17.9)', () => {
  it('proposes low_variety once the score sits well below target', () => {
    const analyzer = new VarietyAnalyzer({ profile: IMMEDIATE });
    const { candidates } = settleAll(analyzer, 25, 0);
    expect(candidates.map((entry) => entry.type)).toEqual(['low_variety']);
    const candidate = candidates[0];
    expect(candidate?.stamp.trackingEpoch).toBe(2);
    expect(candidate?.stamp.takePassId).toBe('pass-9');
    expect(candidate?.finalEvidence).toBe(true);
    expect(candidate?.localConfidence).toBeGreaterThan(0.5);
  });

  it('proposes nothing for a score merely at the low edge of the band', () => {
    // §17.9 requires the score to be at least eight points below target.
    const analyzer = new VarietyAnalyzer({ profile: IMMEDIATE });
    const { last, candidates } = settleAll(analyzer, 40, 0);
    expect(last.display.state).toBe('steady');
    expect(candidates).toEqual([]);
  });

  it('respects the same-category cooldown', () => {
    const analyzer = new VarietyAnalyzer({ profile: IMMEDIATE });
    expect(settleAll(analyzer, 25, 0).candidates).toHaveLength(1);
    expect(update(analyzer, 20_000, 0.25).candidates).toEqual([]);
    expect(update(analyzer, 60_000, 0.25).candidates).toHaveLength(1);
  });

  it('stays silent while the microphone itself is the problem', () => {
    const analyzer = new VarietyAnalyzer({ profile: IMMEDIATE });
    expect(settleAll(analyzer, 25, 0, { microphoneProblem: true }).candidates).toEqual([]);
  });

  it('stays silent when the passage suppresses variety coaching', () => {
    const analyzer = new VarietyAnalyzer({ profile: IMMEDIATE });
    expect(settleAll(analyzer, 25, 0, { suppressVarietyCoaching: true }).candidates).toEqual([]);
  });

  it('stays silent before two sentences have completed', () => {
    const analyzer = new VarietyAnalyzer({ profile: IMMEDIATE });
    expect(settleAll(analyzer, 25, 0, { completedSentences: 1 }).candidates).toEqual([]);
  });

  it('stays silent without 18 s of reliable evidence', () => {
    const analyzer = new VarietyAnalyzer({ profile: IMMEDIATE });
    const thin = reliability({ usableVoicedMs: 16_000 });
    expect(settleAll(analyzer, 25, 0, { reliability: thin }).candidates).toEqual([]);
  });

  it('marks the candidate non-final when the tempo term rests on a provisional tail', () => {
    const analyzer = new VarietyAnalyzer({ profile: IMMEDIATE });
    const drive = (atMs: number): VarietyAnalyzerResult =>
      analyzer.update({
        context: ctx(atMs),
        reliability: reliability(),
        pitch: pitchAggregate(0.25, 0.25),
        energy: energyAggregate(0.25),
        tempoVariationCv: rawTempoCv(0.25),
        emphasisContrastNorm: null,
        completedSentences: 4,
        finalEvidence: false,
      });
    const result = drive(0);
    expect(result.candidates[0]?.type).toBe('low_variety');
    expect(result.candidates[0]?.finalEvidence).toBe(false);
  });
});

describe('VarietyAnalyzer high-variety candidate (§17.10)', () => {
  const HIGH: DriveOptions = { pitchSpanNorm: 0.95, energyRangeNorm: 0.95 };

  /** 25 s of sustained, extreme delivery. Returns every candidate seen. */
  function driveHigh(
    analyzer: VarietyAnalyzer,
    options: DriveOptions = HIGH,
  ): { last: VarietyAnalyzerResult; types: string[] } {
    let last = update(analyzer, 0, 0.95, options);
    const types = last.candidates.map((candidate) => candidate.type);
    for (let t = 2_500; t <= 25_000; t += 2_500) {
      last = update(analyzer, t, 0.95, options);
      types.push(...last.candidates.map((candidate) => candidate.type));
    }
    return { last, types };
  }

  it('is disabled by default even for a sustained, extreme performance', () => {
    const analyzer = new VarietyAnalyzer({ style: 'calm', profile: IMMEDIATE });
    const { last, types } = driveHigh(analyzer);
    expect(last.display.state).toBe('highly_animated');
    expect(types).toEqual([]);
  });

  it('fires once enabled for a restrained style after 20 s well above target', () => {
    const analyzer = new VarietyAnalyzer({
      style: 'calm',
      profile: { ...IMMEDIATE, highTipEnabled: true },
    });
    expect(driveHigh(analyzer).types).toEqual(['high_variety']);
  });

  it('does not fire for an unrestrained style, however animated', () => {
    const analyzer = new VarietyAnalyzer({
      style: 'expressive',
      profile: { ...IMMEDIATE, highTipEnabled: true },
    });
    expect(driveHigh(analyzer).types).toEqual([]);
  });

  it('requires both pitch and energy to be extreme, not one expressive dimension', () => {
    // §17.10: "energy and pitch changes are both extreme rather than one
    // expressive sentence." Pitch is maxed, energy is mid-range.
    const analyzer = new VarietyAnalyzer({
      style: 'calm',
      profile: { ...IMMEDIATE, highTipEnabled: true },
    });
    const { last, types } = driveHigh(analyzer, {
      pitchSpanNorm: 1,
      pitchMotionNorm: 1,
      energyRangeNorm: 0.5,
      tempoNorm: 1,
    });
    expect(last.display.state).toBe('highly_animated');
    expect(types).toEqual([]);
  });

  it('does not fire before the sustain window has elapsed', () => {
    const analyzer = new VarietyAnalyzer({
      style: 'calm',
      profile: { ...IMMEDIATE, highTipEnabled: true },
    });
    update(analyzer, 0, 0.95, HIGH);
    const early = update(analyzer, 10_000, 0.95, HIGH);
    expect(early.display.state).toBe('highly_animated');
    expect(early.candidates).toEqual([]);
  });
});
