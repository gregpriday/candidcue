/**
 * §8.1 / §8.2 pace tile, plus the §14.5 pause ladder.
 *
 * The tile is where the rail is most likely to lie to the presenter, so the
 * rules it enforces are:
 *
 *  - `wpm: null` renders `—`, never `0`. Zero is a measurement ("you have
 *    stopped"); null is an absence of one ("we do not know yet"), and printing
 *    a confident `0` for the second is how a telemetry tile loses its reader.
 *  - the number redraws at most four times a second (§8.1), so it reads as a
 *    settled figure rather than a flickering counter;
 *  - during a pause it holds the last stable number for 1.5 s, then says
 *    `PAUSED` with that number at lower contrast, then drops to `—` at 8 s
 *    (§14.5) — it never falls toward zero.
 */
import type { PaceDisplayState, PaceState } from '../../../shared/contracts/coaching';

/** §8.1: no faster than four visual updates per second. */
export const PACE_NUMBER_INTERVAL_MS = 250;
/** §8.1: below this confidence the evidence is noisy; round to the nearest 2. */
export const PACE_NOISY_CONFIDENCE = 0.6;
/** §14.5 hold, then labelled pause, then unknown. */
export const PACE_PAUSE_HOLD_MS = 1_500;
export const PACE_PAUSE_UNKNOWN_MS = 8_000;
/**
 * §14.10: never show a schedule error the user should not be chasing. Inside
 * the tolerance the tile says `ON TIME` and shows no figure at all, so there is
 * nothing to chase; outside it, the figure is the real one (§8.2's example is
 * literally `12 SEC AHEAD`) rather than a rounded approximation of it.
 */
export const SCHEDULE_TOLERANCE_MS = 10_000;

/** The em dash the whole rail uses for "not measured". */
export const UNKNOWN_VALUE = '—';

export const PACE_STATE_LABEL: Record<PaceState, string> = {
  learning: 'LEARNING',
  on_target: 'ON TARGET',
  slightly_fast: 'SLIGHTLY FAST',
  fast: 'FAST',
  slightly_slow: 'SLIGHTLY SLOW',
  slow: 'SLOW',
  paused: 'PAUSED',
  low_confidence: 'LOW CONFIDENCE',
};

/**
 * §7.4 contrast bands. `stable` telemetry sits at low contrast; `attention`
 * is a state worth reading but is still not an alert — and it is always paired
 * with the state's own words, never signalled by colour alone (§7.6).
 */
export type PaceTone = 'stable' | 'attention';

const ATTENTION_STATES: ReadonlySet<PaceState> = new Set<PaceState>(['fast', 'slow']);

export interface PaceTileView {
  /** Already formatted: a whole number, or `—`. Never `0` for "unknown". */
  number: string;
  label: string;
  /** §14.5: the held number during a pause renders at lower contrast. */
  dim: boolean;
  tone: PaceTone;
}

/** §8.1 rounding: whole WPM, or the nearest 2 when the evidence is noisy. */
export function roundWpm(wpm: number, confidence: number): number {
  const noisy = !Number.isFinite(confidence) || confidence < PACE_NOISY_CONFIDENCE;
  return noisy ? Math.round(wpm / 2) * 2 : Math.round(wpm);
}

/**
 * §8.2 / §14.10 schedule status. Positive `projectedFinishDeltaMs` means the
 * take is projected to run long, which is behind schedule.
 */
export function scheduleLabel(projectedFinishDeltaMs: number): string {
  if (Math.abs(projectedFinishDeltaMs) < SCHEDULE_TOLERANCE_MS) return 'ON TIME';
  const seconds = Math.round(Math.abs(projectedFinishDeltaMs) / 1000);
  return projectedFinishDeltaMs < 0 ? `${seconds} SEC AHEAD` : `${seconds} SEC BEHIND`;
}

/**
 * §8.1 sparkline points, normalised to 0–1 in both axes with the target band
 * always inside the range so the trace reads against it. `null` when there is
 * not enough series to draw a line.
 */
export function sparklinePoints(
  series: PaceDisplayState['recentSeries'],
  targetLowWpm: number,
  targetHighWpm: number,
): Array<{ x: number; y: number }> | null {
  if (series.length < 2) return null;
  const values = series.map((point) => point.wpm);
  const low = Math.min(targetLowWpm, ...values);
  const high = Math.max(targetHighWpm, ...values);
  const span = high - low || 1;
  const first = series[0]!.audioTimeMs;
  const last = series[series.length - 1]!.audioTimeMs;
  const duration = last - first || 1;
  return series.map((point) => ({
    x: (point.audioTimeMs - first) / duration,
    // Screen space: higher WPM draws higher, so y is inverted.
    y: 1 - (point.wpm - low) / span,
  }));
}

/**
 * Stateful because §8.1 (rate limit) and §14.5 (hold the last stable number)
 * are both memory of what the presenter was last shown.
 *
 * `update` is idempotent for a fixed `nowMs`: the component evaluates it inside
 * a `$derived`, so re-evaluating with unchanged inputs must not advance the
 * rate limiter or the pause ladder.
 */
export class PaceTilePresenter {
  private displayedWpm: number | null = null;
  private lastEmitMs = Number.NEGATIVE_INFINITY;
  private lastStableWpm: number | null = null;
  private lastStableLabel = PACE_STATE_LABEL.learning;
  private pausedSinceMs: number | null = null;

  /**
   * @param scheduleStatus §6.6 `targetDurationStatus`. False replaces the
   *   §8.2 schedule line with the ordinary pace state; the schedule is never
   *   *computed* differently, only withheld.
   */
  update(pace: PaceDisplayState, nowMs: number, scheduleStatus = true): PaceTileView {
    if (pace.state === 'paused') return this.updatePaused(pace, nowMs);
    this.pausedSinceMs = null;

    const rounded = pace.wpm === null || !Number.isFinite(pace.wpm)
      ? null
      : roundWpm(pace.wpm, pace.confidence);

    if (rounded === null) {
      // Going *unknown* bypasses the rate limit. Holding a stale number while
      // the producer has told us it no longer knows is the tile lying.
      this.displayedWpm = null;
      this.lastEmitMs = nowMs;
    } else if (this.displayedWpm === null || nowMs - this.lastEmitMs >= PACE_NUMBER_INTERVAL_MS) {
      this.displayedWpm = rounded;
      this.lastEmitMs = nowMs;
    }
    if (this.displayedWpm !== null) this.lastStableWpm = this.displayedWpm;

    const label = this.resolveLabel(pace, scheduleStatus);
    this.lastStableLabel = label;
    return {
      number: this.displayedWpm === null ? UNKNOWN_VALUE : String(this.displayedWpm),
      label,
      dim: false,
      tone: ATTENTION_STATES.has(pace.state) ? 'attention' : 'stable',
    };
  }

  /** §14.5. */
  private updatePaused(pace: PaceDisplayState, nowMs: number): PaceTileView {
    if (this.pausedSinceMs === null) this.pausedSinceMs = nowMs;
    const elapsed = Math.max(0, nowMs - this.pausedSinceMs);

    if (elapsed < PACE_PAUSE_HOLD_MS) {
      // Hold everything, including the label: the first moment of a deliberate
      // pause should not change the tile at all.
      return {
        number: this.lastStableWpm === null ? UNKNOWN_VALUE : String(this.lastStableWpm),
        label: this.lastStableLabel,
        dim: false,
        tone: 'stable',
      };
    }
    const expired = elapsed >= PACE_PAUSE_UNKNOWN_MS;
    const held = expired || this.lastStableWpm === null ? UNKNOWN_VALUE : String(this.lastStableWpm);
    return {
      number: held,
      label: PACE_STATE_LABEL.paused,
      dim: true,
      tone: 'stable',
    };
  }

  private resolveLabel(pace: PaceDisplayState, scheduleStatus: boolean): string {
    // §8.2: with a target duration the second line becomes schedule status,
    // but only once there is something to project from.
    if (
      scheduleStatus &&
      pace.targetDurationMs !== null &&
      pace.projectedFinishDeltaMs !== null &&
      pace.state !== 'learning' &&
      pace.state !== 'low_confidence'
    ) {
      return scheduleLabel(pace.projectedFinishDeltaMs);
    }
    return PACE_STATE_LABEL[pace.state];
  }
}
