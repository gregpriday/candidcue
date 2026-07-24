/**
 * Speaking Score report §9.2 / §9.3. Scoring one metric against a target band.
 *
 * ---------------------------------------------------------------------------
 * WHY A GAUSSIAN AND NOT A THRESHOLD
 * ---------------------------------------------------------------------------
 * §9.2 asks for a *flat desirable region* with a smooth fall-off either side,
 * and it asks for it specifically to avoid a discontinuity at the threshold.
 * A step function at 175 WPM means the presenter's score lurches as their rate
 * wobbles across a line they cannot perceive; the same wobble against
 * `100 × exp(-0.5 × (d/σ)²)` moves the number by less than a point. The band
 * itself is the product decision; σ is only how fast leaving it costs.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TWO SIGMAS ARE NOT THE SAME NUMBER
 * ---------------------------------------------------------------------------
 * §9.3: "Speaking too fast may be more damaging than speaking slightly below
 * target in a calm explainer preset. Use `sigma_low` and `sigma_high` rather
 * than forcing symmetry." Every band here therefore carries both, and nothing
 * in this file ever averages them.
 *
 * σ has a deliberate, checkable meaning: **a metric exactly σ outside its band
 * scores `100 × exp(-0.5)` ≈ 60.65.** Most σ values in the default profile are
 * derived by putting that point at the far edge of §8's published "soft warning
 * region", so the soft region and the ~60-point score describe the same place.
 */

/**
 * A target range with asymmetric tolerances.
 *
 * `low`/`high` may be `-Infinity`/`Infinity` for a one-sided metric — see
 * {@link atMost} and {@link atLeast}, which is how "fewer fillers is always
 * better" is expressed without a second, fictional bound.
 */
export interface TargetBand {
  low: number;
  high: number;
  /** Tolerance below `low`, in the metric's own units. Must be > 0. */
  sigmaLow: number;
  /** Tolerance above `high`, in the metric's own units. Must be > 0. */
  sigmaHigh: number;
}

/**
 * §9.2 "For a lower-is-better metric such as fillers: `d = max(0, x - U)`".
 * The low side is unbounded, so `sigmaLow` is never consulted.
 */
export function atMost(upper: number, sigmaHigh: number): TargetBand {
  return { low: Number.NEGATIVE_INFINITY, high: upper, sigmaLow: sigmaHigh, sigmaHigh };
}

/** §9.2 "For a higher-is-better metric, mirror the formula around a lower threshold." */
export function atLeast(lower: number, sigmaLow: number): TargetBand {
  return { low: lower, high: Number.POSITIVE_INFINITY, sigmaLow, sigmaHigh: sigmaLow };
}

/** Distance from the band, §9.2. Zero inside it. */
export function distanceFromBand(value: number, band: TargetBand): number {
  if (value < band.low) return band.low - value;
  if (value > band.high) return value - band.high;
  return 0;
}

/**
 * §9.2 / §9.3. `100 × exp(-0.5 × (d/σ)²)`, with the σ chosen by which side of
 * the band the value fell on.
 *
 * Returns exactly `100` inside the band — the flat region is flat, not merely
 * nearly flat — and never returns `NaN`: a non-finite value is not evidence of
 * anything and scores nothing, which the caller must represent as an
 * unavailable submetric rather than as a zero.
 */
export function bandScore(value: number, band: TargetBand): number | null {
  if (!Number.isFinite(value)) return null;
  const distance = distanceFromBand(value, band);
  if (distance === 0) return 100;
  const sigma = value < band.low ? band.sigmaLow : band.sigmaHigh;
  // A zero or negative σ is a configuration error, not a speaker's fault. It is
  // reported as unmeasurable rather than as a score of 0.
  if (!(sigma > 0) || !Number.isFinite(sigma)) return null;
  const z = distance / sigma;
  return 100 * Math.exp(-0.5 * z * z);
}

/** Clamp to the reportable 0–100 range (§9.6 step 3). */
export function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}
