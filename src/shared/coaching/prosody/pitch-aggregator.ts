/**
 * Pitch aggregation (spec §13.2–§13.5, §17.2).
 *
 * Two product decisions from the specification are structural here, not
 * optional:
 *
 * - **Speaker-relative units only (§13.3, §13.5).** Everything is reported in
 *   semitones around the speaker's own slowly learned reference. There is no
 *   absolute Hz target and no gendered norm anywhere in this file, and there
 *   must never be one.
 * - **The reliability gate belongs upstream (§13.4).** This aggregator
 *   summarizes whatever pitch frames it was given; it does not decide whether
 *   pitch coaching is permitted. That decision arrives as a
 *   {@link PitchReliability} produced by `coaching/audio`, and
 *   `variety-score.ts` is what refuses to publish a number when it says no.
 */
import type { AudioFrameFeatures, PitchReliability } from '../../contracts/coaching';
import {
  interquartileRange,
  median,
  medianFilter,
  robustSpan,
} from './stats';

export interface PitchAggregatorOptions {
  /** §17.3 short horizon, ms. */
  shortHorizonMs: number;
  /** §17.3 medium horizon, ms — the one the live score uses. */
  mediumHorizonMs: number;
  /** §17.3 session baseline horizon, ms. */
  sessionHorizonMs: number;
  minVoicedProbability: number;
  minF0Confidence: number;
  /** Frames further apart than this are not treated as consecutive for movement. */
  maxFrameGapMs: number;
  /** §13.2 short median filter width, frames (odd). */
  medianFilterFrames: number;
  /** Excursion a direction change must exceed to count as a contour turn, semitones. */
  turnMinimumSemitones: number;
  /** A frame this far above the clipping ratio is dropped: clipping wrecks F0. */
  maxClippingRatio: number;
  /** Window either side of a phrase end used for phrase-final movement, ms. */
  phraseFinalWindowMs: number;
}

export const DEFAULT_PITCH_AGGREGATOR_OPTIONS: PitchAggregatorOptions = {
  shortHorizonMs: 10_000,
  mediumHorizonMs: 30_000,
  sessionHorizonMs: 60_000,
  minVoicedProbability: 0.5,
  minF0Confidence: 0.5,
  maxFrameGapMs: 60,
  medianFilterFrames: 5,
  turnMinimumSemitones: 1,
  maxClippingRatio: 0.01,
  phraseFinalWindowMs: 300,
};

/** One accepted pitch observation, kept in Hz until a reference is chosen. */
interface PitchSample {
  audioTimeMs: number;
  f0Hz: number;
}

export interface PitchAggregate {
  /** Accepted frames inside the requested horizon. */
  frameCount: number;
  /** Audio-time span the accepted frames cover, ms. */
  coveredMs: number;
  /** The reference the semitone values are relative to, Hz. */
  referenceF0Hz: number | null;
  /** §17.2 robust pitch span, `P90 - P10`, semitones. */
  spanSemitones: number | null;
  /** §17.2 pitch interquartile range, semitones. */
  iqrSemitones: number | null;
  /** §17.2 median absolute pitch movement, semitones per second. */
  motionSemitonesPerSecond: number | null;
  /** §17.2 meaningful contour turns, per minute. */
  contourTurnsPerMinute: number | null;
  /** §17.2 mean phrase-final pitch movement, signed semitones. */
  phraseFinalMovementSemitones: number | null;
}

const EMPTY_AGGREGATE: PitchAggregate = {
  frameCount: 0,
  coveredMs: 0,
  referenceF0Hz: null,
  spanSemitones: null,
  iqrSemitones: null,
  motionSemitonesPerSecond: null,
  contourTurnsPerMinute: null,
  phraseFinalMovementSemitones: null,
};

/** §13.3. `pitch_st(t) = 12 × log2(f0(t) / f0_reference)`. */
export function toSemitones(f0Hz: number, referenceF0Hz: number): number {
  if (f0Hz <= 0 || referenceF0Hz <= 0) {
    return 0;
  }
  return 12 * Math.log2(f0Hz / referenceF0Hz);
}

export class PitchAggregator {
  private readonly options: PitchAggregatorOptions;
  private samples: PitchSample[] = [];
  private phraseFinalMovements: Array<{ audioTimeMs: number; semitones: number }> = [];

  constructor(options: Partial<PitchAggregatorOptions> = {}) {
    this.options = { ...DEFAULT_PITCH_AGGREGATOR_OPTIONS, ...options };
  }

  reset(): void {
    this.samples = [];
    this.phraseFinalMovements = [];
  }

  /**
   * Accept a frame if it carries usable pitch. Rejection here is about the
   * *frame*; §13.4's take-level gate is a separate decision made upstream.
   */
  noteFrame(frame: AudioFrameFeatures): boolean {
    if (
      frame.processorDropout ||
      frame.f0Hz === null ||
      frame.f0Hz <= 0 ||
      frame.f0Confidence < this.options.minF0Confidence ||
      frame.voicedProbability < this.options.minVoicedProbability ||
      frame.clippingRatio > this.options.maxClippingRatio
    ) {
      return false;
    }
    this.samples.push({ audioTimeMs: frame.audioTimeMs, f0Hz: frame.f0Hz });
    this.trim(frame.audioTimeMs);
    return true;
  }

  /**
   * §17.2 phrase-final pitch movement. Records the signed semitone difference
   * between the last `phraseFinalWindowMs` of the phrase and the window before
   * it — a falling terminal is negative, a rising one positive.
   */
  notePhraseEnd(endMs: number, referenceF0Hz: number | null): void {
    const window = this.options.phraseFinalWindowMs;
    const reference = referenceF0Hz ?? this.rollingReferenceF0Hz();
    if (reference === null) {
      return;
    }
    const tail = this.between(endMs - window, endMs).map((sample) =>
      toSemitones(sample.f0Hz, reference),
    );
    const before = this.between(endMs - 2 * window, endMs - window).map((sample) =>
      toSemitones(sample.f0Hz, reference),
    );
    const tailMedian = median(tail);
    const beforeMedian = median(before);
    if (tailMedian === null || beforeMedian === null) {
      return;
    }
    this.phraseFinalMovements.push({ audioTimeMs: endMs, semitones: tailMedian - beforeMedian });
    while (this.phraseFinalMovements.length > 32) {
      this.phraseFinalMovements.shift();
    }
  }

  /** §13.3 rolling median reference, Hz, or `null` before enough evidence. */
  rollingReferenceF0Hz(): number | null {
    return median(this.samples.map((sample) => sample.f0Hz));
  }

  /**
   * Median pitch over `[startMs, endMs]` in semitones relative to `reference`,
   * or `null` when the window holds no accepted frames. Used by the emphasis
   * analyzer to compare a marked phrase against its neighbourhood (§17.11).
   */
  medianSemitonesIn(startMs: number, endMs: number, referenceF0Hz: number): number | null {
    return median(
      this.between(startMs, endMs).map((sample) => toSemitones(sample.f0Hz, referenceF0Hz)),
    );
  }

  /** Accepted frames inside `[startMs, endMs]`. */
  frameCountIn(startMs: number, endMs: number): number {
    return this.between(startMs, endMs).length;
  }

  /**
   * Summarize the horizon ending at `nowMs`. `reliability.referenceF0Hz` wins
   * when present, because the audio layer owns calibration (§13.3); the local
   * rolling median is only a fallback so this module is testable alone.
   */
  aggregate(
    nowMs: number,
    reliability: Pick<PitchReliability, 'referenceF0Hz'> | null = null,
    horizonMs: number = this.options.mediumHorizonMs,
  ): PitchAggregate {
    const window = this.between(nowMs - horizonMs, nowMs);
    if (window.length === 0) {
      return EMPTY_AGGREGATE;
    }
    const reference = reliability?.referenceF0Hz ?? median(window.map((s) => s.f0Hz));
    if (reference === null || reference <= 0) {
      return { ...EMPTY_AGGREGATE, frameCount: window.length };
    }

    const raw = window.map((sample) => toSemitones(sample.f0Hz, reference));
    // §13.2: a short median filter, which is also what suppresses the isolated
    // octave jumps that would otherwise dominate a P90 - P10 span.
    const smoothed = medianFilter(raw, this.options.medianFilterFrames);

    const first = window[0];
    const last = window[window.length - 1];
    const coveredMs = first === undefined || last === undefined ? 0 : last.audioTimeMs - first.audioTimeMs;

    return {
      frameCount: window.length,
      coveredMs,
      referenceF0Hz: reference,
      spanSemitones: robustSpan(smoothed),
      iqrSemitones: interquartileRange(smoothed),
      motionSemitonesPerSecond: this.motion(window, smoothed),
      contourTurnsPerMinute: this.turns(smoothed, coveredMs),
      phraseFinalMovementSemitones: median(
        this.phraseFinalMovements
          .filter((entry) => entry.audioTimeMs >= nowMs - horizonMs)
          .map((entry) => entry.semitones),
      ),
    };
  }

  private motion(window: readonly PitchSample[], smoothed: readonly number[]): number | null {
    const deltas: number[] = [];
    const gaps: number[] = [];
    for (let index = 1; index < window.length; index += 1) {
      const previous = window[index - 1];
      const current = window[index];
      const previousSemitones = smoothed[index - 1];
      const currentSemitones = smoothed[index];
      if (
        previous === undefined ||
        current === undefined ||
        previousSemitones === undefined ||
        currentSemitones === undefined
      ) {
        continue;
      }
      const gapMs = current.audioTimeMs - previous.audioTimeMs;
      if (gapMs <= 0 || gapMs > this.options.maxFrameGapMs) {
        continue;
      }
      deltas.push(Math.abs(currentSemitones - previousSemitones));
      gaps.push(gapMs);
    }
    const medianDelta = median(deltas);
    const medianGapMs = median(gaps);
    if (medianDelta === null || medianGapMs === null || medianGapMs <= 0) {
      return null;
    }
    return medianDelta / (medianGapMs / 1000);
  }

  /**
   * Count direction changes whose excursion since the previous turn exceeds
   * `turnMinimumSemitones`, then express them per minute. The excursion gate is
   * what stops micro-jitter reading as an animated contour.
   */
  private turns(smoothed: readonly number[], coveredMs: number): number | null {
    if (smoothed.length < 3 || coveredMs <= 0) {
      return null;
    }
    let turns = 0;
    let direction: 1 | -1 | 0 = 0;
    let extreme = smoothed[0] ?? 0;
    for (const value of smoothed) {
      if (direction === 0) {
        if (Math.abs(value - extreme) >= this.options.turnMinimumSemitones) {
          direction = value > extreme ? 1 : -1;
          extreme = value;
        }
        continue;
      }
      if ((direction === 1 && value > extreme) || (direction === -1 && value < extreme)) {
        extreme = value;
        continue;
      }
      if (Math.abs(value - extreme) >= this.options.turnMinimumSemitones) {
        turns += 1;
        direction = direction === 1 ? -1 : 1;
        extreme = value;
      }
    }
    return turns / (coveredMs / 60_000);
  }

  private between(startMs: number, endMs: number): PitchSample[] {
    return this.samples.filter(
      (sample) => sample.audioTimeMs >= startMs && sample.audioTimeMs <= endMs,
    );
  }

  private trim(nowMs: number): void {
    const cutoff = nowMs - this.options.sessionHorizonMs;
    let drop = 0;
    while (drop < this.samples.length) {
      const sample = this.samples[drop];
      if (sample === undefined || sample.audioTimeMs >= cutoff) {
        break;
      }
      drop += 1;
    }
    if (drop > 0) {
      this.samples.splice(0, drop);
    }
  }
}
