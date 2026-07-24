/**
 * Loudness aggregation (spec §12.7.4, §17.2, §17.4).
 *
 * §12.7.4 is a hard constraint on this file: without a calibrated microphone
 * and a known distance, CandidCue measures **relative digital level**, not
 * sound-pressure level, and must never claim otherwise. Everything reported
 * here is therefore a *range* or a *contrast* in dB — a difference between two
 * of the speaker's own frames — and there is deliberately no "how loud are
 * they" output at all.
 *
 * Clipped frames are counted but excluded from the range. A clipped frame has
 * had its peak flattened by the converter, so including it *narrows* the
 * measured dynamic range and would report a shouting presenter as monotone.
 */
import type { AudioFrameFeatures } from '../../contracts/coaching';
import { median, robustSpan } from './stats';

export interface EnergyAggregatorOptions {
  /** Frames below this speech probability are background, not delivery. */
  minSpeechProbability: number;
  /** A frame at or above this clipping ratio is unusable for range (§12.7.1). */
  maxClippingRatio: number;
  /** Half-width of the "near the same narrow level" band, dB (§17.2). */
  narrowBandDb: number;
  /** Above this fraction of clipped frames the aggregate is declared degraded. */
  degradedClippedRatio: number;
  /** Retention horizon, ms. */
  sessionHorizonMs: number;
  /** §17.3 medium horizon, ms. */
  mediumHorizonMs: number;
}

export const DEFAULT_ENERGY_AGGREGATOR_OPTIONS: EnergyAggregatorOptions = {
  minSpeechProbability: 0.5,
  maxClippingRatio: 0.01,
  narrowBandDb: 1.5,
  degradedClippedRatio: 0.02,
  sessionHorizonMs: 60_000,
  mediumHorizonMs: 30_000,
};

interface EnergySample {
  audioTimeMs: number;
  rmsDbfs: number;
}

export interface EnergyAggregate {
  frameCount: number;
  /** §17.2 robust RMS range, `P90 - P10`, dB. Positive by construction. */
  rangeDb: number | null;
  /** §17.2 phrase-level energy contrast: `P90 - P10` of per-phrase mean level, dB. */
  phraseContrastDb: number | null;
  /** §17.2 fraction of speech frames within ±`narrowBandDb` of the median, 0–1. */
  narrowLevelRatio: number | null;
  /** Fraction of speech frames rejected for clipping, 0–1. */
  clippedFrameRatio: number;
  /** True when clipping makes the range untrustworthy (§12.7.1). */
  degraded: boolean;
}

const EMPTY_AGGREGATE: EnergyAggregate = {
  frameCount: 0,
  rangeDb: null,
  phraseContrastDb: null,
  narrowLevelRatio: null,
  clippedFrameRatio: 0,
  degraded: false,
};

export class EnergyAggregator {
  private readonly options: EnergyAggregatorOptions;
  private samples: EnergySample[] = [];
  private clipped: number[] = [];
  private phraseMeans: Array<{ audioTimeMs: number; meanDbfs: number }> = [];
  private currentPhrase: number[] = [];

  constructor(options: Partial<EnergyAggregatorOptions> = {}) {
    this.options = { ...DEFAULT_ENERGY_AGGREGATOR_OPTIONS, ...options };
  }

  reset(): void {
    this.samples = [];
    this.clipped = [];
    this.phraseMeans = [];
    this.currentPhrase = [];
  }

  /** Returns true when the frame contributed to the level distribution. */
  noteFrame(frame: AudioFrameFeatures): boolean {
    if (frame.processorDropout || frame.speechProbability < this.options.minSpeechProbability) {
      return false;
    }
    if (frame.clippingRatio > this.options.maxClippingRatio) {
      this.clipped.push(frame.audioTimeMs);
      this.trim(frame.audioTimeMs);
      return false;
    }
    this.samples.push({ audioTimeMs: frame.audioTimeMs, rmsDbfs: frame.rmsDbfs });
    this.currentPhrase.push(frame.rmsDbfs);
    this.trim(frame.audioTimeMs);
    return true;
  }

  /** Close the current phrase so its mean level joins the contrast sample. */
  notePhraseEnd(endMs: number): void {
    if (this.currentPhrase.length === 0) {
      return;
    }
    const meanDbfs =
      this.currentPhrase.reduce((sum, value) => sum + value, 0) / this.currentPhrase.length;
    this.phraseMeans.push({ audioTimeMs: endMs, meanDbfs });
    this.currentPhrase = [];
    while (this.phraseMeans.length > 64) {
      this.phraseMeans.shift();
    }
  }

  /**
   * Mean level over `[startMs, endMs]`, dBFS (negative), or `null` when the
   * window holds no usable speech frames. A *relative* comparison against
   * another window is the only legitimate use (§12.7.4).
   */
  meanLevelDbfsIn(startMs: number, endMs: number): number | null {
    const window = this.samples.filter(
      (sample) => sample.audioTimeMs >= startMs && sample.audioTimeMs <= endMs,
    );
    if (window.length === 0) {
      return null;
    }
    return window.reduce((sum, sample) => sum + sample.rmsDbfs, 0) / window.length;
  }

  aggregate(nowMs: number, horizonMs: number = this.options.mediumHorizonMs): EnergyAggregate {
    const startMs = nowMs - horizonMs;
    const window = this.samples.filter(
      (sample) => sample.audioTimeMs >= startMs && sample.audioTimeMs <= nowMs,
    );
    const clippedInWindow = this.clipped.filter((time) => time >= startMs && time <= nowMs).length;
    const considered = window.length + clippedInWindow;
    const clippedFrameRatio = considered === 0 ? 0 : clippedInWindow / considered;

    if (window.length === 0) {
      return { ...EMPTY_AGGREGATE, clippedFrameRatio, degraded: clippedInWindow > 0 };
    }

    const levels = window.map((sample) => sample.rmsDbfs);
    const centre = median(levels);
    const narrowLevelRatio =
      centre === null
        ? null
        : levels.filter((level) => Math.abs(level - centre) <= this.options.narrowBandDb).length /
          levels.length;

    const phraseLevels = this.phraseMeans
      .filter((entry) => entry.audioTimeMs >= startMs && entry.audioTimeMs <= nowMs)
      .map((entry) => entry.meanDbfs);

    return {
      frameCount: window.length,
      rangeDb: robustSpan(levels),
      phraseContrastDb: phraseLevels.length >= 2 ? robustSpan(phraseLevels) : null,
      narrowLevelRatio,
      clippedFrameRatio,
      degraded: clippedFrameRatio > this.options.degradedClippedRatio,
    };
  }

  private trim(nowMs: number): void {
    const cutoff = nowMs - this.options.sessionHorizonMs;
    this.samples = this.samples.filter((sample) => sample.audioTimeMs >= cutoff);
    this.clipped = this.clipped.filter((time) => time >= cutoff);
  }
}
