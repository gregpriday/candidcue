/**
 * Emphasis-aware analysis (spec §17.11).
 *
 * §17.11 is explicit that live "give that phrase more emphasis" coaching is
 * Phase 2, "because inaccurate word-level acoustic alignment would be
 * distracting". That is honoured structurally: {@link EmphasisAnalyzer} never
 * produces a {@link CoachCandidate}. It produces measurements — for the
 * post-take report, and for the small `emphasisContrastNorm` term of the
 * §17.5 variety formula — and refuses to produce even those when word-to-audio
 * localization confidence is not high.
 *
 * Both contrasts are speaker-relative differences: semitones against the
 * speaker's own reference (§13.3) and dB against their own neighbouring
 * speech (§12.7.4). Neither is an absolute measurement of anything.
 */
import { clamp01, linearNorm, median } from './stats';
import type { EnergyAggregator } from './energy-aggregator';
import type { PitchAggregator } from './pitch-aggregator';

export interface EmphasisAnalyzerOptions {
  /**
   * §17.11: word-to-audio localization confidence required before a marked
   * phrase may be compared against its neighbours.
   */
  minLocalizationConfidence: number;
  /** Neighbourhood window either side of the marked phrase, ms. */
  neighbourhoodMs: number;
  /**
   * Guard between the phrase and its neighbourhood, ms. Windows are inclusive
   * at both ends, so without a guard the frame sitting exactly on the phrase
   * edge would be counted as both phrase and neighbourhood and quietly shrink
   * every contrast.
   */
  neighbourhoodGuardMs: number;
  /** Accepted pitch frames required inside the phrase before pitch is compared. */
  minPitchFrames: number;
  /** Normalization ramp for the combined contrast (§17.4). */
  contrastNormLowSemitones: number;
  contrastNormHighSemitones: number;
  contrastNormLowDb: number;
  contrastNormHighDb: number;
}

export const DEFAULT_EMPHASIS_ANALYZER_OPTIONS: EmphasisAnalyzerOptions = {
  minLocalizationConfidence: 0.75,
  neighbourhoodMs: 1_500,
  neighbourhoodGuardMs: 1,
  minPitchFrames: 8,
  contrastNormLowSemitones: 0.5,
  contrastNormHighSemitones: 4,
  contrastNormLowDb: 0.5,
  contrastNormHighDb: 6,
};

/** A phrase the compiler marked as an emphasis opportunity (§17.11, §19.2). */
export interface EmphasisSpan {
  spanId: string;
  /** Audio interval the marked phrase was delivered over, from alignment. */
  startMs: number;
  endMs: number;
  /** 0–1 confidence that the phrase really occupies that interval. */
  localizationConfidence: number;
}

export type EmphasisUnmeasurableReason =
  | 'low_localization_confidence'
  | 'insufficient_pitch'
  | 'insufficient_energy'
  | 'no_neighbourhood';

export interface EmphasisMeasurement {
  spanId: string;
  measurable: boolean;
  reason: 'ok' | EmphasisUnmeasurableReason;
  /** Marked phrase median pitch minus neighbourhood median, semitones. */
  pitchContrastSemitones: number | null;
  /** Marked phrase mean level minus neighbourhood mean, dB. */
  energyContrastDb: number | null;
}

export class EmphasisAnalyzer {
  private readonly options: EmphasisAnalyzerOptions;
  private readonly measurements: EmphasisMeasurement[] = [];

  constructor(options: Partial<EmphasisAnalyzerOptions> = {}) {
    this.options = { ...DEFAULT_EMPHASIS_ANALYZER_OPTIONS, ...options };
  }

  reset(): void {
    this.measurements.length = 0;
  }

  /**
   * Compare one marked phrase against the speech immediately around it. The
   * neighbourhood deliberately excludes the phrase itself, so a phrase that is
   * loud only because the whole passage is loud scores no contrast.
   */
  measure(
    span: EmphasisSpan,
    pitch: PitchAggregator,
    energy: EnergyAggregator,
    referenceF0Hz: number | null,
  ): EmphasisMeasurement {
    const record = (measurement: EmphasisMeasurement): EmphasisMeasurement => {
      this.measurements.push(measurement);
      while (this.measurements.length > 64) {
        this.measurements.shift();
      }
      return measurement;
    };
    const fail = (reason: EmphasisUnmeasurableReason): EmphasisMeasurement =>
      record({
        spanId: span.spanId,
        measurable: false,
        reason,
        pitchContrastSemitones: null,
        energyContrastDb: null,
      });

    if (span.localizationConfidence < this.options.minLocalizationConfidence) {
      return fail('low_localization_confidence');
    }

    const guard = this.options.neighbourhoodGuardMs;
    const before: [number, number] = [
      span.startMs - this.options.neighbourhoodMs,
      span.startMs - guard,
    ];
    const after: [number, number] = [
      span.endMs + guard,
      span.endMs + this.options.neighbourhoodMs,
    ];

    const phraseLevel = energy.meanLevelDbfsIn(span.startMs, span.endMs);
    const neighbourLevels = [
      energy.meanLevelDbfsIn(before[0], before[1]),
      energy.meanLevelDbfsIn(after[0], after[1]),
    ].filter((value): value is number => value !== null);
    if (neighbourLevels.length === 0) {
      return fail('no_neighbourhood');
    }
    if (phraseLevel === null) {
      return fail('insufficient_energy');
    }
    const neighbourLevel =
      neighbourLevels.reduce((sum, value) => sum + value, 0) / neighbourLevels.length;
    const energyContrastDb = phraseLevel - neighbourLevel;

    let pitchContrastSemitones: number | null = null;
    if (
      referenceF0Hz !== null &&
      pitch.frameCountIn(span.startMs, span.endMs) >= this.options.minPitchFrames
    ) {
      const phrasePitch = pitch.medianSemitonesIn(span.startMs, span.endMs, referenceF0Hz);
      const neighbourPitches = [
        pitch.medianSemitonesIn(before[0], before[1], referenceF0Hz),
        pitch.medianSemitonesIn(after[0], after[1], referenceF0Hz),
      ].filter((value): value is number => value !== null);
      if (phrasePitch !== null && neighbourPitches.length > 0) {
        const neighbourPitch =
          neighbourPitches.reduce((sum, value) => sum + value, 0) / neighbourPitches.length;
        pitchContrastSemitones = phrasePitch - neighbourPitch;
      }
    }

    return record({
      spanId: span.spanId,
      measurable: true,
      reason: 'ok',
      pitchContrastSemitones,
      energyContrastDb,
    });
  }

  /** Measurements recorded this take, oldest first. Post-take report input. */
  recorded(): readonly EmphasisMeasurement[] {
    return this.measurements;
  }

  /**
   * §17.5 `emphasisContrastNorm`, 0–1, or `null` when nothing measurable has
   * been seen — in which case §17.5 says to redistribute its weight rather
   * than substitute a zero, and {@link import('./variety-score').varietyLevel}
   * does exactly that.
   */
  contrastNorm(): number | null {
    const usable = this.measurements.filter((entry) => entry.measurable);
    if (usable.length === 0) {
      return null;
    }
    const pitchNorm = median(
      usable
        .map((entry) => entry.pitchContrastSemitones)
        .filter((value): value is number => value !== null)
        .map((value) =>
          linearNorm(
            Math.abs(value),
            this.options.contrastNormLowSemitones,
            this.options.contrastNormHighSemitones,
          ),
        ),
    );
    const energyNorm = median(
      usable
        .map((entry) => entry.energyContrastDb)
        .filter((value): value is number => value !== null)
        .map((value) =>
          linearNorm(
            Math.abs(value),
            this.options.contrastNormLowDb,
            this.options.contrastNormHighDb,
          ),
        ),
    );
    if (pitchNorm === null && energyNorm === null) {
      return null;
    }
    if (pitchNorm === null) {
      return clamp01(energyNorm ?? 0);
    }
    if (energyNorm === null) {
      return clamp01(pitchNorm);
    }
    return clamp01((pitchNorm + energyNorm) / 2);
  }
}
