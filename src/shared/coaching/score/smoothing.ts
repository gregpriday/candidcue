/**
 * Speaking Score report §9.6 steps 1–3 and §11.3 — why the number is
 * deliberately sluggish.
 *
 * §11.3: no animation of every sub-point change, a cap on visible movement "so
 * it cannot behave like a slot machine", holding through ordinary pauses. A
 * number that twitches invites the presenter to watch it instead of the script,
 * and a teleprompter that steals the reader's eyes has failed at its only job.
 *
 * Both stages here are driven by the **audio clock** and by an explicit elapsed
 * time. Nothing reads a wall clock and nothing assumes a fixed tick rate, so a
 * replayed session produces the same numbers as the live one (§12.7).
 */
import { clampScore } from './band';

/**
 * §9.6 step 1. Exponential smoothing with a half-life, applied to the raw
 * overall score.
 *
 * A half-life rather than a per-tick alpha because the engine's cadence is not
 * guaranteed: an aggregation pass that arrives late must not smooth *less* than
 * one that arrives on time.
 */
export function smoothTowards(
  previous: number | null,
  target: number,
  elapsedMs: number,
  halfLifeMs: number,
): number {
  if (previous === null) return target;
  if (!(elapsedMs > 0) || !(halfLifeMs > 0)) return previous;
  const alpha = 1 - Math.pow(0.5, elapsedMs / halfLifeMs);
  return previous + (target - previous) * alpha;
}

/**
 * §9.6 step 2 / §11.3. Cap the *visible* movement per second.
 *
 * The first value is adopted whole: a rail that opened at zero and crawled to
 * the speaker's real score at 2.5 points per second would spend half a minute
 * telling them they are terrible. The cap governs movement, and there is no
 * movement before there is a previous value.
 */
export function applyScoreRateCap(
  previous: number | null,
  target: number,
  elapsedMs: number,
  maxPerSecond: number,
): number {
  if (previous === null) return target;
  if (!(elapsedMs > 0) || !(maxPerSecond > 0)) return previous;
  const maxDelta = maxPerSecond * (elapsedMs / 1000);
  const delta = target - previous;
  if (Math.abs(delta) <= maxDelta) return target;
  return previous + Math.sign(delta) * maxDelta;
}

/**
 * The two stages together, clamped to 0–100 (§9.6 step 3).
 *
 * Order matters: smoothing first so the cap is applied to a value that is
 * already settling, then the cap so a step change in the underlying metrics can
 * never appear as a jump on the glass however sharp the smoothing is
 * configured.
 */
export interface SmoothedScore {
  /** What the rail should display. */
  readonly display: number;
  /** The EWMA state, carried forward. Not clamped by the rate cap. */
  readonly smoothed: number;
}

export function advanceDisplayScore(
  state: { smoothed: number | null; display: number | null },
  raw: number,
  elapsedMs: number,
  halfLifeMs: number,
  maxPerSecond: number,
): SmoothedScore {
  const smoothed = smoothTowards(state.smoothed, raw, elapsedMs, halfLifeMs);
  const display = clampScore(
    applyScoreRateCap(state.display, clampScore(smoothed), elapsedMs, maxPerSecond),
  );
  return { display, smoothed };
}
