/**
 * Robust summary statistics shared by the prosody aggregators.
 *
 * §17.2 asks for `P90 - P10` spans and interquartile ranges rather than means
 * and standard deviations, because one octave-error frame or one door slam
 * moves a mean and does not move a percentile. Everything here is therefore
 * order-statistic based.
 *
 * Not one of §28's suggested files: `pitch-aggregator` and `energy-aggregator`
 * both need these, and a copy in each is how two percentile functions end up
 * disagreeing about interpolation.
 */

/**
 * Linear-interpolated percentile, `fraction` in 0–1. Returns `null` for an
 * empty sample rather than 0, which would be a claim about silence.
 */
export function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = values.slice().sort((a, b) => a - b);
  if (sorted.length === 1) {
    return sorted[0] ?? null;
  }
  const position = Math.min(1, Math.max(0, fraction)) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower];
  const high = sorted[upper];
  if (low === undefined || high === undefined) {
    return null;
  }
  return low + (high - low) * (position - lower);
}

export function median(values: readonly number[]): number | null {
  return percentile(values, 0.5);
}

/** `P90 - P10`, the robust span of §17.2. `null` for an empty sample. */
export function robustSpan(values: readonly number[]): number | null {
  const low = percentile(values, 0.1);
  const high = percentile(values, 0.9);
  return low === null || high === null ? null : high - low;
}

/** `P75 - P25`. */
export function interquartileRange(values: readonly number[]): number | null {
  const low = percentile(values, 0.25);
  const high = percentile(values, 0.75);
  return low === null || high === null ? null : high - low;
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Map a raw feature onto 0–1 against a documented `[lo, hi]` prior (§17.4).
 * Values at or below `lo` normalize to 0, at or above `hi` to 1.
 */
export function linearNorm(value: number, lo: number, hi: number): number {
  if (hi <= lo) {
    return 0;
  }
  return clamp01((value - lo) / (hi - lo));
}

/** Running median filter of odd width, used to tame isolated pitch errors (§13.2). */
export function medianFilter(values: readonly number[], width: number): number[] {
  if (width <= 1 || values.length === 0) {
    return values.slice();
  }
  const half = Math.floor(width / 2);
  const out: number[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const window: number[] = [];
    for (let offset = -half; offset <= half; offset += 1) {
      const value = values[index + offset];
      if (value !== undefined) {
        window.push(value);
      }
    }
    out.push(median(window) ?? values[index] ?? 0);
  }
  return out;
}

/**
 * Coefficient of variation (standard deviation over mean) of a sample. Used
 * for §17.2's phrase-to-phrase WPM variation, where the scale-free form is
 * what makes 130 ± 20 WPM comparable to 190 ± 20 WPM.
 */
export function coefficientOfVariation(values: readonly number[]): number | null {
  if (values.length < 2) {
    return null;
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean <= 0) {
    return null;
  }
  const variance =
    values.reduce((sum, value) => sum + (value - mean) * (value - mean), 0) / values.length;
  return Math.sqrt(variance) / mean;
}
