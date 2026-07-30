/**
 * Monotone cubic Hermite interpolation (companion §8.2) — the production
 * line-handoff path.
 *
 * The path must pass exactly through every line-start knot `(U_i, Y_i)` so that
 * reaching the start of a line places that line at the reading position with no
 * step, and it must share one slope at each knot so the target velocity does not
 * jump when the active line changes. Fritsch–Carlson slope limiting keeps the
 * cubic monotone (never reversing, never overshooting) between knots, which is
 * what makes "ordinary following never moves backward" a property of the
 * geometry rather than of a runtime guard.
 *
 * Pure math, no DOM, no clocks.
 */

export interface MonotoneSample {
  y: number;
  /** dY/dX at the sample point — the feed-forward derivative (§28.2). */
  dy: number;
  /** Index of the interval start knot. */
  index: number;
  /** Normalized progress inside the interval, 0..1. */
  t: number;
}

export interface MonotoneSpline {
  readonly xs: readonly number[];
  readonly ys: readonly number[];
  readonly slopes: readonly number[];
  sample(x: number): MonotoneSample;
}

export interface MonotoneSlopeOptions {
  /** Absolute clamp for every knot slope, in Y units per X unit. */
  maxSlope?: number;
  /**
   * Preferred slope at selected knots, applied before the monotonicity limiter.
   *
   * A target is a request, not an exemption: the limiter and the explicit
   * clamps below may reduce it whenever the adjacent secants cannot carry it
   * without overshoot. This is used at the start of a short closing line so
   * its required pace can be established on the preceding line instead of
   * arriving as a late acceleration at the end of the script.
   */
  knotSlopeTarget?: readonly (number | undefined)[];
  /**
   * Per-knot slope clamp (index aligned). Used to keep paragraph, media, and
   * section gaps from producing an unbounded spline slope (§8.5, §8.6).
   */
  knotSlopeClamp?: readonly (number | undefined)[];
}

/**
 * Fritsch–Carlson / PCHIP knot slopes over a non-decreasing `ys`.
 *
 * Interior knots use the weighted harmonic mean of the adjacent secants, which
 * is zero whenever a secant is zero — the "genuine hold boundary" case of §8.2
 * step 3. Endpoints use a clamped one-sided tangent (§8.7).
 */
export function computeMonotoneSlopes(
  xs: readonly number[],
  ys: readonly number[],
  options: MonotoneSlopeOptions = {},
): number[] {
  const n = xs.length;
  if (n === 0) return [];
  if (n === 1) return [0];

  const h: number[] = new Array(n - 1);
  const d: number[] = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const dx = (xs[i + 1] ?? 0) - (xs[i] ?? 0);
    h[i] = dx;
    d[i] = dx > 0 ? ((ys[i + 1] ?? 0) - (ys[i] ?? 0)) / dx : 0;
  }

  const m: number[] = new Array(n);
  m[0] = d[0] ?? 0;
  m[n - 1] = d[n - 2] ?? 0;
  for (let i = 1; i < n - 1; i++) {
    const dPrev = d[i - 1] ?? 0;
    const dNext = d[i] ?? 0;
    if (dPrev * dNext <= 0) {
      // Sign change or a flat side: a genuine hold/discontinuity boundary.
      m[i] = 0;
      continue;
    }
    const hPrev = h[i - 1] ?? 0;
    const hNext = h[i] ?? 0;
    const w1 = 2 * hNext + hPrev;
    const w2 = hNext + 2 * hPrev;
    m[i] = (w1 + w2) / (w1 / dPrev + w2 / dNext);
  }

  /*
   * Apply authored targets BEFORE the monotonicity pass. A target that is too
   * large for either adjacent interval is therefore reduced together with its
   * neighbour, preserving the same no-overshoot proof as an inferred slope.
   */
  const { knotSlopeTarget } = options;
  for (let i = 0; i < n; i++) {
    const target = knotSlopeTarget?.[i];
    if (target !== undefined && Number.isFinite(target)) {
      m[i] = Math.max(0, target);
    }
  }

  // Monotonicity limiter: keep every slope inside 3× the adjacent secants so
  // the cubic cannot overshoot or reverse inside an interval.
  for (let i = 0; i < n - 1; i++) {
    const secant = d[i] ?? 0;
    if (secant === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const alpha = (m[i] ?? 0) / secant;
    const beta = (m[i + 1] ?? 0) / secant;
    const magnitude = alpha * alpha + beta * beta;
    if (magnitude > 9) {
      const tau = 3 / Math.sqrt(magnitude);
      m[i] = tau * alpha * secant;
      m[i + 1] = tau * beta * secant;
    }
  }

  // Explicit clamps. Reducing a non-negative slope toward zero can never break
  // monotonicity, so these are always safe to apply after the limiter.
  const { maxSlope, knotSlopeClamp } = options;
  for (let i = 0; i < n; i++) {
    let slope = m[i] ?? 0;
    if (slope < 0) slope = 0;
    const perKnot = knotSlopeClamp?.[i];
    if (perKnot !== undefined && Number.isFinite(perKnot)) {
      slope = Math.min(slope, Math.max(0, perKnot));
    }
    if (maxSlope !== undefined && Number.isFinite(maxSlope)) {
      slope = Math.min(slope, Math.max(0, maxSlope));
    }
    m[i] = slope;
  }

  return m;
}

/**
 * Build a spline through strictly increasing `xs` and non-decreasing `ys`.
 * Returns null when fewer than two usable knots exist.
 */
export function createMonotoneSpline(
  xs: readonly number[],
  ys: readonly number[],
  options: MonotoneSlopeOptions = {},
): MonotoneSpline | null {
  if (xs.length < 2 || xs.length !== ys.length) return null;
  const slopes = computeMonotoneSlopes(xs, ys, options);
  const last = xs.length - 1;

  function findInterval(x: number): number {
    let lo = 0;
    let hi = last - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((xs[mid] ?? 0) <= x) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }

  return {
    xs,
    ys,
    slopes,
    sample(x: number): MonotoneSample {
      const first = xs[0] ?? 0;
      const end = xs[last] ?? 0;
      // Outside the knot range the path holds: no extrapolated drift, which
      // keeps stale or wild predictions from scrolling past the document.
      if (x <= first) return { y: ys[0] ?? 0, dy: 0, index: 0, t: 0 };
      if (x >= end) return { y: ys[last] ?? 0, dy: 0, index: Math.max(0, last - 1), t: 1 };

      const i = findInterval(x);
      const x0 = xs[i] ?? 0;
      const x1 = xs[i + 1] ?? 0;
      const h = x1 - x0;
      if (h <= 0) return { y: ys[i] ?? 0, dy: 0, index: i, t: 0 };
      const t = (x - x0) / h;
      const t2 = t * t;
      const t3 = t2 * t;

      const y0 = ys[i] ?? 0;
      const y1 = ys[i + 1] ?? 0;
      const m0 = slopes[i] ?? 0;
      const m1 = slopes[i + 1] ?? 0;

      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;
      const y = h00 * y0 + h10 * h * m0 + h01 * y1 + h11 * h * m1;

      const dh00 = (6 * t2 - 6 * t) / h;
      const dh10 = 3 * t2 - 4 * t + 1;
      const dh01 = (-6 * t2 + 6 * t) / h;
      const dh11 = 3 * t2 - 2 * t;
      const dy = dh00 * y0 + dh10 * m0 + dh01 * y1 + dh11 * m1;

      return { y, dy: dy < 0 ? 0 : dy, index: i, t };
    },
  };
}
