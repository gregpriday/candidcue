/**
 * Speaking Score report §9.4 and §9.6 — the two places the model can most
 * easily start lying.
 *
 * ---------------------------------------------------------------------------
 * THE UNAVAILABLE DIMENSION
 * ---------------------------------------------------------------------------
 * §9.4: "If the denominator is too small, the dimension is unavailable rather
 * than assumed to be 100." The contract restates the mirror image of that on
 * `DimensionScore.score`: it is not assumed to be 0 either. A speaker who has
 * not produced enough voiced audio to judge their emphasis has not thereby
 * failed at emphasis, and a speaker whose microphone is clipping has not
 * thereby lost their vocal dynamics.
 *
 * So an unavailable dimension is `null`, and — this is the part a `null` alone
 * does not buy you — it is *excluded from the weighted mean* rather than folded
 * in at some default. {@link combineDimensions} renormalizes across whatever is
 * actually available, so four available dimensions scoring 100 produce an
 * overall of 100, not 4/7 of it.
 *
 * ---------------------------------------------------------------------------
 * THE WEAK-DIMENSION TERM
 * ---------------------------------------------------------------------------
 * §9.6: "A simple weighted mean can hide one bad dimension. A speaker with
 * excellent variety but unintelligibly fast pace should not receive a very high
 * overall score." The 25th percentile is what makes the flaw visible; the 0.75
 * mean weighting is what stops one noisy metric from dominating.
 */
import { DELIVERY_SCORE_WEIGHTS, type DeliveryDimension } from '../../contracts/coaching';
import type { DimensionScore } from '../../contracts/coaching';
import { clampScore } from './band';

/**
 * One submetric's contribution to a dimension (§9.1, §9.5).
 *
 * `score` is `null` when the submetric could not be measured *or* has no
 * producer in this build at all. §9.1: "A metric without enough evidence should
 * have low confidence rather than a fabricated neutral score." A null with
 * confidence 0 costs the speaker nothing; a fabricated 100 would quietly prop
 * the dimension up and a fabricated 0 would quietly sink it.
 */
export interface SubmetricSample {
  /** Stable id, `<dimension>.<submetric>`. Diagnostics and tests only. */
  readonly id: string;
  /** The §9.5 point weight. Preserved even when the submetric is unavailable. */
  readonly weight: number;
  readonly score: number | null;
  /** 0–1 evidence confidence, `c_i` in §9.4. */
  readonly confidence: number;
  /**
   * False when this build has **no producer at all** for the submetric, as
   * opposed to a producer that has not gathered enough evidence yet. Defaults
   * to true.
   *
   * The distinction is not cosmetic. An unsourceable submetric is excluded from
   * the denominator {@link DimensionScore.confidence} is measured against, so
   * listing the §9.5 submetrics we cannot yet build — which is the honest thing
   * to do, and keeps the gap visible — does not depress the reported confidence
   * of the submetrics we can.
   */
  readonly sourceable?: boolean;
}

export interface DimensionResult extends DimensionScore {
  /** The samples the score was built from, for diagnostics and post-take review. */
  readonly submetrics: readonly SubmetricSample[];
}

/**
 * §9.4. `D_k = Σ(w·c·s) / Σ(w·c)`.
 *
 * `sourceableWeight` is the total weight of the submetrics this build can
 * *ever* produce, which is not the same as the dimension's configured weight:
 * emphasis is 14 points of contract weight and 0 points of sourceable weight,
 * because nothing in the tree produces keyword-emphasis alignment. Measuring
 * confidence against the configured weight would report a fully-evidenced
 * variety dimension as two-thirds confident forever; measuring it against the
 * sourceable weight reports "of what I can see, how much do I have", which is
 * the question `DimensionScore.confidence` is asked.
 */
export function scoreDimension(
  dimension: DeliveryDimension,
  samples: readonly SubmetricSample[],
  minimumEvidence: number,
): DimensionResult {
  let numerator = 0;
  let denominator = 0;
  let sourceableWeight = 0;

  for (const sample of samples) {
    if (sample.weight <= 0) continue;
    // A submetric with no producer is not sourceable and must not enlarge the
    // denominator confidence is measured against — otherwise adding a
    // permanently-null submetric would *lower* a dimension's reported
    // confidence without changing any measurement.
    if (sample.sourceable !== false) sourceableWeight += sample.weight;
    if (sample.score === null) continue;
    const confidence = Math.min(1, Math.max(0, sample.confidence));
    if (confidence <= 0) continue;
    const weight = sample.weight * confidence;
    numerator += weight * clampScore(sample.score);
    denominator += weight;
  }

  const weight = DELIVERY_SCORE_WEIGHTS[dimension];
  const confidence = sourceableWeight <= 0 ? 0 : Math.min(1, denominator / sourceableWeight);
  const available = sourceableWeight > 0 && confidence >= minimumEvidence && denominator > 0;

  return {
    dimension,
    score: available ? clampScore(numerator / denominator) : null,
    confidence,
    weight,
    submetrics: samples,
  };
}

/**
 * A weighted quantile over dimension scores — the §9.6 `weak_score`.
 *
 * ---------------------------------------------------------------------------
 * WHICH PERCENTILE CONVENTION, AND WHY IT MATTERS HERE
 * ---------------------------------------------------------------------------
 * "Weighted 25th percentile" has several defensible definitions and they do not
 * agree on the case this term exists for. Under the symmetric
 * midpoint-of-weight convention, a speaker who is excellent in six dimensions
 * and bad in one lands *above* their own mean, because a single 18-point
 * dimension holds less than a quarter of the mass and the quantile therefore
 * sits inside the good cluster. That inverts §9.6: the weak term would raise
 * the score of a speaker with a persistent flaw.
 *
 * This uses the empirical-CDF convention instead — `p_i = Σ_{j≤i} w_j / W`,
 * with linear interpolation between consecutive points. Q(p) is then "the score
 * at which a fraction p of the dimension weight has been accounted for", read
 * from the bottom. The lowest dimension owns the interval up to its own
 * cumulative weight, so a heavy weak dimension pulls the quantile down onto
 * itself and a light one only partly does.
 *
 * It does not take the raw minimum, which is the other half of §9.6's
 * requirement — "without allowing a single noisy metric to dominate". A
 * dimension holding less than 25% of the available weight moves `weak_score`
 * proportionally, not completely, and the 0.75/0.25 blend bounds its reach at
 * the total besides.
 */
export function weightedQuantile(
  entries: ReadonlyArray<{ value: number; weight: number }>,
  fraction: number,
): number | null {
  const usable = entries.filter((entry) => entry.weight > 0);
  if (usable.length === 0) return null;
  const sorted = usable.slice().sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, entry) => sum + entry.weight, 0);
  if (total <= 0) return null;
  const firstValue = sorted[0]?.value;
  const lastValue = sorted[sorted.length - 1]?.value;
  if (firstValue === undefined || lastValue === undefined) return null;
  if (sorted.length === 1) return firstValue;

  const positions: number[] = [];
  let cumulative = 0;
  for (const entry of sorted) {
    cumulative += entry.weight;
    positions.push(cumulative / total);
  }

  const target = Math.min(1, Math.max(0, fraction));
  if (target <= (positions[0] ?? 1)) return firstValue;

  for (let index = 1; index < sorted.length; index += 1) {
    const upper = positions[index];
    const lower = positions[index - 1];
    const upperValue = sorted[index]?.value;
    const lowerValue = sorted[index - 1]?.value;
    if (upper === undefined || lower === undefined) continue;
    if (upperValue === undefined || lowerValue === undefined) continue;
    if (target > upper) continue;
    const span = upper - lower;
    if (span <= 0) return upperValue;
    return lowerValue + ((target - lower) / span) * (upperValue - lowerValue);
  }
  return lastValue;
}

export interface OverallScore {
  /** `0.75 × mean + 0.25 × weak`, or `null` when no dimension is available. */
  readonly raw: number | null;
  /** The weighted mean of available dimensions, for diagnostics. */
  readonly mean: number | null;
  /** The weighted 25th percentile of available dimensions, for diagnostics. */
  readonly weak: number | null;
  /** The available dimension dragging hardest, or `null`. */
  readonly weakest: DeliveryDimension | null;
  readonly availableCount: number;
}

/**
 * §9.6. `raw_overall = 0.75 × mean_score + 0.25 × weak_score`.
 *
 * Note what is *not* here: no separate event penalties. §9.6 step 4 is
 * explicit — "do not add separate penalties for events already represented in
 * dimensions" — so a filled pause costs the speaker points once, inside
 * fluency, and never again at the total.
 */
export function combineDimensions(
  dimensions: readonly DimensionScore[],
  weakBlend: number,
): OverallScore {
  const available = dimensions.filter(
    (dimension): dimension is DimensionScore & { score: number } =>
      dimension.score !== null && dimension.weight > 0,
  );
  if (available.length === 0) {
    return { raw: null, mean: null, weak: null, weakest: null, availableCount: 0 };
  }

  let numerator = 0;
  let denominator = 0;
  for (const dimension of available) {
    numerator += dimension.weight * dimension.score;
    denominator += dimension.weight;
  }
  const mean = numerator / denominator;
  const weak =
    weightedQuantile(
      available.map((dimension) => ({ value: dimension.score, weight: dimension.weight })),
      0.25,
    ) ?? mean;

  const blend = Math.min(1, Math.max(0, weakBlend));
  const raw = clampScore((1 - blend) * mean + blend * weak);

  // The weakest dimension is the lowest available score; ties break toward the
  // heavier dimension and then by the contract's declaration order, so the
  // answer is deterministic rather than dependent on array order.
  let weakest = available[0] ?? null;
  for (const dimension of available) {
    if (weakest === null) {
      weakest = dimension;
      continue;
    }
    if (dimension.score < weakest.score) weakest = dimension;
    else if (dimension.score === weakest.score && dimension.weight > weakest.weight) {
      weakest = dimension;
    }
  }

  return {
    raw,
    mean,
    weak,
    weakest: weakest === null ? null : weakest.dimension,
    availableCount: available.length,
  };
}
