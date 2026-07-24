/**
 * Exponentially weighted moving rate (spec §14.4).
 *
 * §14.4 prefers a *weighted linear regression over cumulative word count* to a
 * simple moving-window division, because transcript updates arrive irregularly
 * and a window division silently assumes they do not. The slope of cumulative
 * words against time is words per second whether observations arrive every
 * 200 ms or in one 3-second burst; a `words / windowSeconds` division is wrong
 * by however much of the window happened to be covered.
 *
 * All time here is the audio clock (Rule 3). Nothing in this file reads a wall
 * clock, and `estimate` takes `nowMs` explicitly for that reason.
 */

/** One (audio time, cumulative spoken word count) observation. */
export interface RateObservation {
  audioTimeMs: number;
  cumulativeWords: number;
}

export interface WeightedRateOptions {
  /** §14.4 observation horizon, ms. Observations older than this are dropped. */
  horizonMs: number;
  /** §14.4 half-life of the exponential weights, ms. */
  halfLifeMs: number;
  /**
   * §14.4 minimum usable *active* evidence, ms. Below this the estimator
   * returns `null` — never `0`, which would be a different and false claim.
   */
  minimumActiveEvidenceMs: number;
  /**
   * Active evidence at which confidence saturates, ms. Between the minimum and
   * this value confidence ramps linearly.
   */
  fullConfidenceEvidenceMs: number;
  /** Robust residual rejection threshold, in units of scaled MAD (§14.4). */
  outlierResidualThreshold: number;
  /** Floor on the robust residual scale, words. Stops a perfect fit rejecting noise. */
  minimumResidualScaleWords: number;
}

export const DEFAULT_WEIGHTED_RATE_OPTIONS: WeightedRateOptions = {
  horizonMs: 14_000,
  halfLifeMs: 4_000,
  minimumActiveEvidenceMs: 3_500,
  fullConfidenceEvidenceMs: 7_000,
  outlierResidualThreshold: 3,
  minimumResidualScaleWords: 0.5,
};

/** §14.4 trend half-life, for the slower series used by tip gating. */
export const TREND_HALF_LIFE_MS = 15_000;

/** §14.4 maximum displayed change, WPM per second. */
export const MAX_DISPLAY_CHANGE_WPM_PER_SECOND = 12;

export interface RateEstimate {
  /** Words per minute, or `null` when there is not enough active evidence. */
  wpm: number | null;
  /** 0–1. Combines evidence duration with goodness of fit. */
  confidence: number;
  /** Observations that survived outlier rejection. */
  sampleCount: number;
  /** Audio-time span covered by the surviving observations, ms. */
  spanMs: number;
  /** Observations rejected as outliers on this estimate. */
  rejectedCount: number;
}

/**
 * Accumulates observations and produces the §14.4 weighted-least-squares rate.
 *
 * One instance per rate (audible / content / articulation); they differ only in
 * what the caller feeds as `cumulativeWords` and as active evidence.
 */
export class WeightedRateEstimator {
  private readonly options: WeightedRateOptions;
  private readonly observations: RateObservation[] = [];
  private provisional: readonly RateObservation[] = [];
  private readonly tau: number;

  constructor(options: Partial<WeightedRateOptions> = {}) {
    this.options = { ...DEFAULT_WEIGHTED_RATE_OPTIONS, ...options };
    this.tau = this.options.halfLifeMs / Math.LN2;
  }

  /**
   * Add an observation. Observations must be non-decreasing in both time and
   * cumulative count; an out-of-order or decreasing sample is ignored, because
   * cumulative counts that go backwards mean a revision that the caller should
   * have handled by {@link reset}.
   */
  add(observation: RateObservation): void {
    const last = this.observations[this.observations.length - 1];
    if (
      last !== undefined &&
      (observation.audioTimeMs < last.audioTimeMs ||
        observation.cumulativeWords < last.cumulativeWords)
    ) {
      return;
    }
    this.observations.push(observation);
  }

  /**
   * Replace the provisional overlay — observations derived from a transcript
   * tail that has not been finalized. They are used for responsiveness, but
   * {@link usesProvisional} reports their influence so a candidate built while
   * they are in the window can honestly set `finalEvidence: false`.
   *
   * Held separately rather than pushed into `observations` because a
   * provisional tail is routinely revised away, and a cumulative series that
   * has to move *backwards* is not a series.
   */
  setProvisional(observations: readonly RateObservation[]): void {
    this.provisional = observations;
  }

  /**
   * True when a provisional observation actually contributes to the estimate
   * at `nowMs` — inside the horizon *and* beyond the newest final observation.
   */
  usesProvisional(nowMs: number): boolean {
    const cutoff = nowMs - this.options.horizonMs;
    const lastFinalMs = this.observations[this.observations.length - 1]?.audioTimeMs ?? -Infinity;
    return this.provisional.some(
      (o) => o.audioTimeMs > lastFinalMs && o.audioTimeMs >= cutoff && o.audioTimeMs <= nowMs,
    );
  }

  /** Drop all observations — a retake, section jump, or epoch change (§5.4). */
  reset(): void {
    this.observations.length = 0;
    this.provisional = [];
  }

  /** Drop observations older than the horizon relative to `nowMs`. */
  prune(nowMs: number): void {
    const cutoff = nowMs - this.options.horizonMs;
    let drop = 0;
    while (drop < this.observations.length) {
      const observation = this.observations[drop];
      if (observation === undefined || observation.audioTimeMs >= cutoff) {
        break;
      }
      drop += 1;
    }
    if (drop > 0) {
      this.observations.splice(0, drop);
    }
  }

  observationCount(): number {
    return this.observations.length;
  }

  /**
   * §14.4. `activeEvidenceMs` is voiced (or delivery) time inside the horizon
   * — *not* the horizon length. A 14-second horizon containing 1 second of
   * speech is not 14 seconds of evidence, and treating it as such is how a
   * pace tile confidently reports a number derived from one word.
   */
  estimate(nowMs: number, activeEvidenceMs: number): RateEstimate {
    this.prune(nowMs);
    const cutoff = nowMs - this.options.horizonMs;
    const lastFinalMs = this.observations[this.observations.length - 1]?.audioTimeMs ?? -Infinity;
    const points = [
      ...this.observations.filter((o) => o.audioTimeMs <= nowMs),
      ...this.provisional.filter(
        (o) => o.audioTimeMs > lastFinalMs && o.audioTimeMs >= cutoff && o.audioTimeMs <= nowMs,
      ),
    ];

    if (activeEvidenceMs < this.options.minimumActiveEvidenceMs || points.length < 2) {
      return { wpm: null, confidence: 0, sampleCount: points.length, spanMs: 0, rejectedCount: 0 };
    }

    const weights = points.map((o) => Math.exp(-(nowMs - o.audioTimeMs) / this.tau));
    const first = fit(points, weights);
    if (first === null) {
      return { wpm: null, confidence: 0, sampleCount: points.length, spanMs: 0, rejectedCount: 0 };
    }

    // Robust second pass: reject observations whose residual exceeds the
    // scaled median absolute deviation (§14.4 "robust residual threshold").
    const residuals = points.map(
      (o) => o.cumulativeWords - (first.intercept + first.slopePerSecond * seconds(o.audioTimeMs)),
    );
    const scale = Math.max(
      this.options.minimumResidualScaleWords,
      1.4826 * median(residuals.map((r) => Math.abs(r))),
    );
    const keptIndices: number[] = [];
    for (let index = 0; index < points.length; index += 1) {
      const residual = residuals[index];
      if (residual === undefined) {
        continue;
      }
      if (Math.abs(residual) <= this.options.outlierResidualThreshold * scale) {
        keptIndices.push(index);
      }
    }

    let usedPoints = points;
    let usedWeights = weights;
    let rejectedCount = 0;
    if (keptIndices.length >= 2 && keptIndices.length < points.length) {
      usedPoints = keptIndices.map((index) => points[index]).filter(isDefined);
      usedWeights = keptIndices.map((index) => weights[index]).filter(isDefined);
      rejectedCount = points.length - keptIndices.length;
    }

    const final = fit(usedPoints, usedWeights) ?? first;
    const spanMs =
      (usedPoints[usedPoints.length - 1]?.audioTimeMs ?? 0) - (usedPoints[0]?.audioTimeMs ?? 0);

    let weightSum = 0;
    let weightedSquaredResidual = 0;
    for (let index = 0; index < usedPoints.length; index += 1) {
      const point = usedPoints[index];
      const weight = usedWeights[index];
      if (point === undefined || weight === undefined) {
        continue;
      }
      const residual =
        point.cumulativeWords - (final.intercept + final.slopePerSecond * seconds(point.audioTimeMs));
      weightSum += weight;
      weightedSquaredResidual += weight * residual * residual;
    }
    const residualRmsWords = weightSum > 0 ? Math.sqrt(weightedSquaredResidual / weightSum) : 0;

    const evidenceFactor = clamp01(
      (activeEvidenceMs - this.options.minimumActiveEvidenceMs) /
        Math.max(1, this.options.fullConfidenceEvidenceMs - this.options.minimumActiveEvidenceMs),
    );
    const fitFactor = 1 / (1 + residualRmsWords);
    const confidence = clamp01(evidenceFactor * fitFactor);

    return {
      wpm: Math.max(0, 60 * final.slopePerSecond),
      confidence,
      sampleCount: usedPoints.length,
      spanMs,
      rejectedCount,
    };
  }
}

/**
 * §14.4 "maximum displayed change: 12 WPM per second unless a true
 * section/retake reset occurs". Applied to the *displayed* number only; the
 * underlying estimate is never slew-limited, so tip gating still sees the
 * truth.
 */
export function applySlewLimit(
  previousWpm: number | null,
  targetWpm: number,
  elapsedMs: number,
  maxWpmPerSecond: number = MAX_DISPLAY_CHANGE_WPM_PER_SECOND,
): number {
  if (previousWpm === null || elapsedMs <= 0) {
    return targetWpm;
  }
  const maxDelta = maxWpmPerSecond * (elapsedMs / 1000);
  const delta = targetWpm - previousWpm;
  if (Math.abs(delta) <= maxDelta) {
    return targetWpm;
  }
  return previousWpm + Math.sign(delta) * maxDelta;
}

interface Fit {
  slopePerSecond: number;
  intercept: number;
}

function fit(points: readonly RateObservation[], weights: readonly number[]): Fit | null {
  let weightSum = 0;
  let weightedTime = 0;
  let weightedCount = 0;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const weight = weights[index];
    if (point === undefined || weight === undefined) {
      continue;
    }
    weightSum += weight;
    weightedTime += weight * seconds(point.audioTimeMs);
    weightedCount += weight * point.cumulativeWords;
  }
  if (weightSum <= 0) {
    return null;
  }
  const meanTime = weightedTime / weightSum;
  const meanCount = weightedCount / weightSum;

  let covariance = 0;
  let variance = 0;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const weight = weights[index];
    if (point === undefined || weight === undefined) {
      continue;
    }
    const dt = seconds(point.audioTimeMs) - meanTime;
    covariance += weight * dt * (point.cumulativeWords - meanCount);
    variance += weight * dt * dt;
  }
  if (variance <= 0) {
    return null;
  }
  const slopePerSecond = covariance / variance;
  return { slopePerSecond, intercept: meanCount - slopePerSecond * meanTime };
}

function seconds(audioTimeMs: number): number {
  return audioTimeMs / 1000;
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0;
  }
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
