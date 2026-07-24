/**
 * Spoken-unit coordinate (companion §6).
 *
 * The tracking worker reports semantic position in *weighted spoken units*, not
 * token indexes: "a" and "internationalization" are both one token but do not
 * take the same time to deliver. The stage owns the units → pixels mapping, so
 * it needs the same cumulative axis the worker used.
 *
 * The axis is injected rather than derived here on purpose. Until the compiler
 * publishes per-token speech weights in the stage envelope, the stage uses the
 * identity scale (one unit per token), which is exactly the axis a worker with
 * uniform weights produces. `weightedUnitScale` is ready for the moment weights
 * arrive; nothing else in the stage motion stack changes.
 */

export interface SpokenUnitScale {
  /** Cumulative spoken unit at the *start* of `tokenIndex`. */
  unitForToken(tokenIndex: number): number;
  /** Speech weight of `tokenIndex` (always > 0 so intervals never collapse). */
  unitSpanForToken(tokenIndex: number): number;
  /** Inverse mapping, clamped to the covered range. */
  tokenForUnit(unit: number): number;
  readonly firstTokenIndex: number;
  readonly lastTokenIndex: number;
  readonly totalUnits: number;
}

const MIN_WEIGHT = 1e-3;

/** One unit per token — the default until §6 speech weights reach the stage. */
export function identityUnitScale(
  firstTokenIndex = 0,
  lastTokenIndex = Number.MAX_SAFE_INTEGER,
): SpokenUnitScale {
  return {
    unitForToken: (tokenIndex) => tokenIndex,
    unitSpanForToken: () => 1,
    tokenForUnit: (unit) => Math.max(firstTokenIndex, Math.min(lastTokenIndex, Math.floor(unit))),
    firstTokenIndex,
    lastTokenIndex,
    totalUnits:
      lastTokenIndex === Number.MAX_SAFE_INTEGER
        ? Number.POSITIVE_INFINITY
        : lastTokenIndex - firstTokenIndex + 1,
  };
}

/**
 * Cumulative scale over per-token speech weights (companion §6):
 * `speechUnit[i + 1] = speechUnit[i] + speechWeight[i]`.
 */
export function weightedUnitScale(
  weights: readonly number[],
  firstTokenIndex = 0,
): SpokenUnitScale {
  const spans = weights.map((w) => (Number.isFinite(w) && w > MIN_WEIGHT ? w : MIN_WEIGHT));
  const cumulative = new Array<number>(spans.length + 1);
  cumulative[0] = 0;
  for (let i = 0; i < spans.length; i++) {
    cumulative[i + 1] = (cumulative[i] ?? 0) + (spans[i] ?? MIN_WEIGHT);
  }
  const lastTokenIndex = firstTokenIndex + spans.length - 1;
  const total = cumulative[spans.length] ?? 0;

  return {
    unitForToken(tokenIndex) {
      const i = tokenIndex - firstTokenIndex;
      if (i <= 0) return 0;
      if (i >= spans.length) return total;
      return cumulative[i] ?? 0;
    },
    unitSpanForToken(tokenIndex) {
      const i = tokenIndex - firstTokenIndex;
      return spans[i] ?? MIN_WEIGHT;
    },
    tokenForUnit(unit) {
      if (unit <= 0) return firstTokenIndex;
      if (unit >= total) return lastTokenIndex;
      // Binary search the cumulative array for the containing interval.
      let lo = 0;
      let hi = spans.length - 1;
      let best = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if ((cumulative[mid] ?? 0) <= unit) {
          best = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return firstTokenIndex + best;
    },
    firstTokenIndex,
    lastTokenIndex,
    totalUnits: total,
  };
}
