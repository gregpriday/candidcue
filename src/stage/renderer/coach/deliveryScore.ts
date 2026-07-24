/**
 * The delivery score as the rail draws it (Speaking Score report §11.1–§11.3).
 *
 * ---------------------------------------------------------------------------
 * The rule this module exists to enforce
 * ---------------------------------------------------------------------------
 * §11.3: a number that twitches invites the presenter to watch it instead of
 * the script, and a teleprompter that steals the reader's eyes has failed at
 * its only job. So the glyph redraws at 2–5 Hz — not once per 200 ms snapshot —
 * and nothing about it is animated: the engine already rate-caps the value at
 * 2.5 points/s, so a plain string swap is the correct and calmest rendering.
 * There is no counter roll, no easing between digits, no pulse on change.
 *
 * ---------------------------------------------------------------------------
 * What this view deliberately cannot carry
 * ---------------------------------------------------------------------------
 * {@link DeliveryScoreView} has four fields and none of them is a number the
 * caller could accidentally print:
 *
 *  - `rawScore` is diagnostics. It never reaches the glass, so the smoothing
 *    can be audited in the post-take report without the rail showing two
 *    disagreeing figures.
 *  - `confidence` is §9.7's "do not show this as another large number". It
 *    reaches the rail as `tier`, and `tier` only ever chooses a presentation.
 *  - `dimensions` is §11.2's explicit prohibition — seven dimension scores
 *    during a take is exactly the readout the spec says belongs in review.
 *  - `weakestDimension` is a hook for a future coaching prompt, not copy.
 *
 * Those omissions are the point. A test can assert that a view serialised to
 * JSON contains none of those values, which is a claim about the *type*, not
 * about one component's markup.
 */
import type { DeliveryScoreState } from '../../../shared/contracts/coaching';
import { UNKNOWN_VALUE } from './paceTile';

/**
 * §11.3: "Update numerically at about 2–5 Hz even if internal snapshots run at
 * 10 Hz." 300 ms is 3.33 Hz — mid-band, and comfortably slower than the 200 ms
 * snapshot cadence so a snapshot can never map one-to-one onto a redraw.
 */
export const SCORE_NUMBER_INTERVAL_MS = 300;

/** §11.3 warm-up copy. The number slot shows `—`; this line says why. */
export const SCORE_WARMING_LABEL = 'LISTENING…';
/** The settled caption. Same typographic voice as `PACE` / `VARIETY`. */
export const SCORE_LABEL = 'SCORE';

/**
 * §11.3 trend indicator. There is no `steady` member on purpose: a neutral
 * glyph that appears and disappears is still movement in the presenter's
 * peripheral vision, and `steady` is the overwhelmingly common case.
 *
 * The carets are vertical (`▲` / `▼`) rather than horizontal, which is also
 * what makes them safe under §7.5 — the rail flips with the script's mirror
 * transform, and a left/right arrow would then point the wrong way.
 */
export type ScoreTrendCaret = 'rising' | 'falling';

export const SCORE_CARET_GLYPH: Record<ScoreTrendCaret, string> = {
  rising: '▲',
  falling: '▼',
};

export interface DeliveryScoreView {
  /**
   * The whole-number score, or `—`. Never `0` for "unknown": zero is a
   * judgement about a performance and "we are still listening" is not one.
   */
  value: string;
  /** {@link SCORE_LABEL}, or {@link SCORE_WARMING_LABEL} during warm-up. */
  label: string;
  /**
   * §9.7 `estimated`: the same figure, quieter. The component expresses this as
   * opacity and never as font weight — a lighter weight changes glyph advance
   * and would resize the number, which §7.1 forbids.
   */
  subdued: boolean;
  /** `null` for `steady`, and for every state with no number to trend. */
  caret: ScoreTrendCaret | null;
}

/** The warm-up frame. Identical shape to a scored frame, so nothing reflows. */
function warmingUp(): DeliveryScoreView {
  return { value: UNKNOWN_VALUE, label: SCORE_WARMING_LABEL, subdued: false, caret: null };
}

/**
 * Rounds and clamps a display score to the whole number the rail prints.
 *
 * Clamped because a smoothed value may momentarily overshoot its own 0–100
 * range, and a rail that prints `101` is a rail nobody believes again.
 */
export function roundDeliveryScore(displayScore: number): number {
  return Math.min(100, Math.max(0, Math.round(displayScore)));
}

/**
 * Stateful because the 2–5 Hz cap is memory of what the presenter was last
 * shown, exactly as `PaceTilePresenter` is for §8.1.
 *
 * `update` is idempotent for a fixed `nowMs`: the component evaluates it inside
 * a `$derived`, which re-runs for reasons that have nothing to do with time
 * passing, and a rate limiter that advanced on every re-evaluation would let
 * the number through at whatever rate Svelte happened to recompute.
 */
export class DeliveryScorePresenter {
  private displayed: number | null = null;
  private lastEmitMs = Number.NEGATIVE_INFINITY;

  /**
   * @param score The snapshot's score, or `null` when the producer has not sent
   *   one yet. Note that "no score in this snapshot" is a *warm-up* state here:
   *   whether scoring runs at all is decided upstream by
   *   `CoachRailModules.deliveryScore`, and when it is off the rail does not
   *   render this zone at all. The two are never conflated.
   * @param nowMs The rail's audio-clock estimate (contract Rule 3).
   */
  update(score: DeliveryScoreState | null, nowMs: number): DeliveryScoreView {
    // §9.7 / §11.3: below the `warming_up` threshold there is no score to show,
    // whatever the engine happened to leave in `displayScore`.
    if (score === null || score.tier === 'warming_up' || score.displayScore === null) {
      // Dropping to unknown bypasses the rate limit. Holding a number the
      // producer has told us it no longer stands behind is the rail lying —
      // and §11.3 is explicit that a collapse in confidence must replace the
      // number rather than let a false low one stand.
      this.displayed = null;
      this.lastEmitMs = nowMs;
      return warmingUp();
    }

    if (!Number.isFinite(score.displayScore)) {
      this.displayed = null;
      this.lastEmitMs = nowMs;
      return warmingUp();
    }

    const rounded = roundDeliveryScore(score.displayScore);
    if (this.displayed === null || nowMs - this.lastEmitMs >= SCORE_NUMBER_INTERVAL_MS) {
      this.displayed = rounded;
      this.lastEmitMs = nowMs;
    }

    return {
      value: String(this.displayed),
      label: SCORE_LABEL,
      subdued: score.tier === 'estimated',
      caret: score.trend === 'steady' ? null : score.trend,
    };
  }
}
