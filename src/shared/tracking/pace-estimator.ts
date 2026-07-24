/**
 * Robust pace estimation (companion §24.4–§24.5, A.1).
 *
 * Two windows, not one: a short window (3–8 s) so the stage follows deliberate
 * slowing, and a baseline window (15–45 s) so one rushed phrase cannot swing
 * velocity. Both are medians of trimmed samples rather than means, because the
 * contaminating samples the spec lists (§24.4) are exactly the kind that blow
 * up an average: ad-libs, command speech, reconnect gaps, committed skips,
 * retakes, and silence counted as speech.
 *
 * Samples are expressed in *spoken units per second* (§6), never words per
 * minute. Pure and deterministic.
 */
import type { TrackingProfile } from './profile';

/** Why a span must not contribute to pace (companion §24.4). */
export type PaceSampleRejection =
  | 'adlib'
  | 'command_speech'
  | 'reconnect_gap'
  | 'skip'
  | 'retake'
  | 'silence'
  | 'implausible_rate'
  | 'degraded_audio';

export interface PaceSample {
  /** Spoken units covered by the matched span. */
  units: number;
  /** Speech duration the span covers, in milliseconds. */
  durationMs: number;
  atMs: number;
  /** Weight in [0, 1] — final distinctive spans weigh more (§24.3). */
  quality: number;
}

export interface PaceEstimate {
  shortTermUnitsPerSecond: number;
  baselineUnitsPerSecond: number;
  /** Quality-weighted blend the filter and the beam actually consume. */
  blendedUnitsPerSecond: number;
  shortSampleCount: number;
  baselineSampleCount: number;
}

export class PaceEstimatorV2 {
  private readonly profile: TrackingProfile;
  private samples: PaceSample[] = [];
  private lastEstimate: PaceEstimate;

  constructor(profile: TrackingProfile) {
    this.profile = profile;
    this.lastEstimate = emptyEstimate();
  }

  /**
   * Offer one span. Returns the rejection reason when the sample is dropped
   * so diagnostics can show *why* pace stopped updating (§64).
   */
  observe(
    sample: PaceSample,
    contamination?: readonly PaceSampleRejection[],
  ): PaceSampleRejection | undefined {
    if (contamination !== undefined && contamination.length > 0) return contamination[0];
    if (!Number.isFinite(sample.units) || !Number.isFinite(sample.durationMs)) {
      return 'implausible_rate';
    }
    if (sample.durationMs <= 0 || sample.units <= 0) return 'silence';
    const rate = (sample.units / sample.durationMs) * 1000;
    if (rate < this.profile.paceMinUnitsPerSecond || rate > this.profile.paceMaxUnitsPerSecond) {
      return 'implausible_rate';
    }
    this.samples.push(sample);
    this.prune(sample.atMs);
    return undefined;
  }

  /** Drop everything (session reset, epoch change, reconnect). */
  reset(): void {
    this.samples = [];
    this.lastEstimate = emptyEstimate();
  }

  estimate(nowMs: number): PaceEstimate {
    this.prune(nowMs);
    const profile = this.profile;
    const short = this.window(nowMs, profile.paceShortWindowMs);
    const baseline = this.window(nowMs, profile.paceBaselineWindowMs);

    const shortRate = robustRate(short, profile);
    const baselineRate = robustRate(baseline, profile);

    // Not enough evidence yet: hold the previous estimate rather than
    // reporting a confident zero (§24.5).
    if (baseline.length < profile.paceMinSamples) {
      return this.lastEstimate;
    }

    const shortQuality = totalQuality(short);
    const baselineQuality = totalQuality(baseline);
    const totalWeight = shortQuality + baselineQuality;
    const blended =
      totalWeight > 0
        ? (shortRate * shortQuality + baselineRate * baselineQuality) / totalWeight
        : baselineRate;

    this.lastEstimate = {
      shortTermUnitsPerSecond: shortRate,
      baselineUnitsPerSecond: baselineRate,
      blendedUnitsPerSecond: clampRate(blended, profile),
      shortSampleCount: short.length,
      baselineSampleCount: baseline.length,
    };
    return this.lastEstimate;
  }

  private window(nowMs: number, windowMs: number): PaceSample[] {
    const cutoff = nowMs - windowMs;
    return this.samples.filter((sample) => sample.atMs >= cutoff);
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - this.profile.paceBaselineWindowMs;
    if (this.samples.length === 0) return;
    const first = this.samples[0];
    if (first !== undefined && first.atMs >= cutoff) return;
    this.samples = this.samples.filter((sample) => sample.atMs >= cutoff);
  }
}

/** §24.4: trim the extremes, then take the quality-weighted median. */
function robustRate(samples: readonly PaceSample[], profile: TrackingProfile): number {
  if (samples.length === 0) return 0;
  const rates = samples
    .map((sample) => ({
      rate: (sample.units / Math.max(1, sample.durationMs)) * 1000,
      quality: Math.max(0, Math.min(1, sample.quality)),
    }))
    .sort((a, b) => a.rate - b.rate);

  const trim = Math.floor(rates.length * profile.paceTrimFraction);
  const kept = rates.length > 2 * trim + 1 ? rates.slice(trim, rates.length - trim) : rates;
  const middle = kept[Math.floor(kept.length / 2)];
  const median = middle?.rate ?? 0;
  return clampRate(median, profile);
}

function totalQuality(samples: readonly PaceSample[]): number {
  let total = 0;
  for (const sample of samples) total += Math.max(0, Math.min(1, sample.quality));
  return total;
}

function clampRate(rate: number, profile: TrackingProfile): number {
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  return Math.max(
    profile.paceMinUnitsPerSecond,
    Math.min(profile.paceMaxUnitsPerSecond, rate),
  );
}

function emptyEstimate(): PaceEstimate {
  return {
    shortTermUnitsPerSecond: 0,
    baselineUnitsPerSecond: 0,
    blendedUnitsPerSecond: 0,
    shortSampleCount: 0,
    baselineSampleCount: 0,
  };
}
