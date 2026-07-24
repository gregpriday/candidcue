/**
 * Unit-axis adapter — the seam between the worker's weighted spoken-unit axis
 * (companion §6) and the axis the rendered line map was built on (§7, §8.3).
 *
 * The tracking worker positions the presenter in *weighted* spoken units, where
 * a long word advances further than a short one. The stage can only build its
 * line map on an axis it actually knows. Until the compiled speech weights are
 * published in the stage envelope, the map is built on the token axis, and this
 * adapter learns the mapping between the two at runtime from the frames
 * themselves: every accepted frame carries both `estimatedUnit` and
 * `tokenIndex`, which is one sampled point of the worker's cumulative weight
 * function.
 *
 * The calibration is monotone, bounded in size, and starts as the identity, so
 * an uncalibrated stage behaves exactly as if the two axes agreed — which is
 * also the correct behavior for a worker with uniform weights.
 *
 * When the envelope does publish per-token weights, build the map with a real
 * `SpokenUnitScale` and use `identityUnitAxis()`; nothing else changes.
 */

export interface UnitAxisAdapter {
  /** Convert a semantic (worker) unit into the map's axis coordinate. */
  toMapUnit(semanticUnit: number): number;
  /** d(mapUnit)/d(semanticUnit) near `semanticUnit`, for feed-forward scaling. */
  slopeAt(semanticUnit: number): number;
  /** Record a (semantic unit, token index) observation from an accepted frame. */
  observe(semanticUnit: number, tokenIndex: number): void;
  readonly calibrated: boolean;
  reset(): void;
}

/** The two axes already agree (a real speech-unit scale drove the map). */
export function identityUnitAxis(): UnitAxisAdapter {
  return {
    toMapUnit: (unit) => unit,
    slopeAt: () => 1,
    observe: () => {},
    calibrated: true,
    reset: () => {},
  };
}

interface Sample {
  unit: number;
  token: number;
}

export interface CalibratingUnitAxisOptions {
  /** Maximum retained samples; the table is decimated uniformly beyond this. */
  maxSamples?: number;
  /** Observations closer than this in unit space replace their neighbour. */
  mergeToleranceUnits?: number;
}

/**
 * Learns semanticUnit → tokenIndex from observed frames and interpolates
 * monotonically between them. Outside the observed span it extrapolates with
 * the global tokens-per-unit slope, which is a far better guess than 1.0 once
 * even a handful of samples exist.
 */
export function createCalibratingUnitAxis(
  options: CalibratingUnitAxisOptions = {},
): UnitAxisAdapter {
  const maxSamples = options.maxSamples ?? 256;
  const mergeTolerance = options.mergeToleranceUnits ?? 0.5;
  const samples: Sample[] = [];

  function globalSlope(): number {
    const first = samples[0];
    const last = samples[samples.length - 1];
    if (!first || !last) return 1;
    const du = last.unit - first.unit;
    if (du <= 1e-6) return 1;
    const dt = last.token - first.token;
    return dt > 0 ? dt / du : 1;
  }

  function indexFor(unit: number): number {
    let lo = 0;
    let hi = samples.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((samples[mid]?.unit ?? 0) <= unit) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }

  return {
    get calibrated() {
      return samples.length >= 2;
    },

    observe(semanticUnit, tokenIndex) {
      if (!Number.isFinite(semanticUnit) || !Number.isFinite(tokenIndex)) return;
      const sample: Sample = { unit: semanticUnit, token: tokenIndex };
      const at = indexFor(semanticUnit);
      const neighbour = at >= 0 ? samples[at] : undefined;
      if (neighbour && Math.abs(neighbour.unit - semanticUnit) <= mergeTolerance) {
        // Same place, fresher evidence.
        neighbour.token = tokenIndex;
        return;
      }
      samples.splice(at + 1, 0, sample);
      // Keep the table monotone in token space: a later unit can never map to
      // an earlier token, even if a frame arrived out of order.
      for (let i = 1; i < samples.length; i++) {
        const prev = samples[i - 1];
        const next = samples[i];
        if (prev && next && next.token < prev.token) next.token = prev.token;
      }
      if (samples.length > maxSamples) {
        // Uniform decimation keeps coverage across the whole script.
        for (let i = samples.length - 2; i > 0; i -= 2) {
          samples.splice(i, 1);
          if (samples.length <= maxSamples / 2) break;
        }
      }
    },

    toMapUnit(semanticUnit) {
      if (samples.length === 0) return semanticUnit;
      const at = indexFor(semanticUnit);
      if (at < 0) {
        const first = samples[0];
        if (!first) return semanticUnit;
        return first.token + (semanticUnit - first.unit) * globalSlope();
      }
      const lower = samples[at];
      const upper = samples[at + 1];
      if (!lower) return semanticUnit;
      if (!upper) {
        return lower.token + (semanticUnit - lower.unit) * globalSlope();
      }
      const du = upper.unit - lower.unit;
      if (du <= 1e-6) return lower.token;
      const t = (semanticUnit - lower.unit) / du;
      return lower.token + t * (upper.token - lower.token);
    },

    slopeAt(semanticUnit) {
      if (samples.length < 2) return 1;
      const at = indexFor(semanticUnit);
      const lower = samples[Math.max(0, at)];
      const upper = samples[Math.max(0, at) + 1];
      if (!lower || !upper) return globalSlope();
      const du = upper.unit - lower.unit;
      if (du <= 1e-6) return globalSlope();
      const slope = (upper.token - lower.token) / du;
      return slope > 0 ? slope : globalSlope();
    },

    reset() {
      samples.length = 0;
    },
  };
}
