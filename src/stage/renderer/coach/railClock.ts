/**
 * The rail's estimate of the audio clock (§5.4, §10.2).
 *
 * ---------------------------------------------------------------------------
 * Why this exists at all — read before "fixing" it by adding a field.
 * ---------------------------------------------------------------------------
 * `CoachRailState` carries no `audioTimeMs`. Every time-bearing value it does
 * carry (`ribbonEvents[].endMs`, `activeTip.createdAudioTimeMs`,
 * `pace.recentSeries[].audioTimeMs`) is an audio-clock stamp for an interval
 * that has already happened, and snapshots arrive at a handful of hertz. The
 * ribbon's right edge is "now" and its leftward motion must be continuous and
 * frame-rate independent (§10.2), and a tip must expire on its own audio-time
 * schedule even if control stalls (§9.3). Both need a *continuous* audio time
 * between snapshots, which means the stage has to run its own estimator.
 *
 * It is deliberately one-directional: the estimate free-runs at wall rate and
 * is only ever corrected *forward* toward the newest stamp we have seen. It
 * never runs backward, because a backward correction would drag ribbon events
 * rightward — the one motion §10.4 forbids — and would resurrect an expired tip.
 *
 * This is an estimator, not an authority. It is used only to position marks and
 * to expire a tip. Nothing here can move the script (Rule 1).
 */
import type { CoachRailState } from '../../../shared/contracts/coaching';

/** A gap this large means the rail joined mid-take or audio jumped; snap. */
export const RAIL_CLOCK_RESYNC_GAP_MS = 2_000;
/**
 * Otherwise catch up by at most this much per sync. At the snapshot rates the
 * producer uses this recovers a few hundred ms of error per second, which is
 * invisible in a 20 000 ms window and cannot make an event visibly jump.
 */
export const RAIL_CLOCK_MAX_CATCHUP_MS = 40;

/**
 * The newest audio-clock stamp anywhere in the snapshot, or `null` when the
 * snapshot carries no time at all (a fresh take before any evidence).
 */
export function railClockAnchorMs(state: CoachRailState): number | null {
  let anchor: number | null = null;
  const consider = (value: number | null | undefined): void => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    if (anchor === null || value > anchor) anchor = value;
  };
  for (const event of state.ribbonEvents) consider(event.endMs);
  consider(state.activeTip?.createdAudioTimeMs);
  const series = state.pace.recentSeries;
  consider(series[series.length - 1]?.audioTimeMs);
  return anchor;
}

/**
 * Monotonic audio-time estimate driven by a monotonic wall clock
 * (`performance.now()` in the stage, an explicit number in tests).
 */
export class RailClock {
  private audioAtBaseMs = 0;
  private baseMonotonicMs = 0;
  private started = false;
  private takePassId: string | null = null;

  /** Audio time now, in ms. Never decreases for a given take pass. */
  read(monotonicMs: number): number {
    if (!this.started) return this.audioAtBaseMs;
    return this.audioAtBaseMs + Math.max(0, monotonicMs - this.baseMonotonicMs);
  }

  /**
   * Fold a snapshot in. Idempotent for a fixed `monotonicMs`: calling it twice
   * with the same arguments produces the same reading, which is what lets the
   * component evaluate it inside a `$derived` without the estimate drifting
   * every time Svelte re-runs the expression.
   */
  sync(state: CoachRailState, monotonicMs: number): number {
    const anchor = railClockAnchorMs(state);
    if (!this.started || state.takePassId !== this.takePassId) {
      // A new take pass is a new performance; nothing carries over (§5.4).
      this.started = true;
      this.takePassId = state.takePassId;
      this.audioAtBaseMs = anchor ?? 0;
      this.baseMonotonicMs = monotonicMs;
      return this.audioAtBaseMs;
    }
    const estimate = this.read(monotonicMs);
    if (anchor === null || anchor <= estimate) return estimate;
    const gap = anchor - estimate;
    const applied = gap > RAIL_CLOCK_RESYNC_GAP_MS ? gap : Math.min(gap, RAIL_CLOCK_MAX_CATCHUP_MS);
    this.audioAtBaseMs = estimate + applied;
    this.baseMonotonicMs = monotonicMs;
    return this.audioAtBaseMs;
  }
}
