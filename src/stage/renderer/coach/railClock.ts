/**
 * The rail's reading of the audio clock (§5.4, §10.2).
 *
 * ---------------------------------------------------------------------------
 * What this is, and what it is not
 * ---------------------------------------------------------------------------
 * `CoachRailState.audioTimeMs` is the producer's own monotonic audio clock at
 * the moment the snapshot was built. It is the authority, and this class does
 * not second-guess it: the anchor is that field, not a guess assembled from the
 * newest timestamp lying around in the payload.
 *
 * What is still needed is *interpolation between snapshots*. Snapshots arrive at
 * a handful of hertz (§12.2 publishes every 200 ms), while the ribbon's right
 * edge is "now" and its leftward motion must be continuous and frame-rate
 * independent (§10.2), and a tip must expire on its own audio-time schedule even
 * if control stalls (§9.3). So between snapshots the clock free-runs at wall
 * rate from the last thing the producer told us, and every arriving snapshot
 * pulls it back onto the producer's number.
 *
 * The correction is deliberately asymmetric:
 *
 *  - **forward is a snap.** The producer is ahead of our interpolation, so our
 *    interpolation was simply short. Adopting it immediately is what makes this
 *    track the payload rather than crawl toward it.
 *  - **backward is bounded and slow.** Our interpolation can only ever be ahead
 *    by roughly the publish interval plus transport latency, so a lead inside
 *    {@link RAIL_CLOCK_MAX_LEAD_MS} is left alone — correcting it would jitter
 *    the ribbon back and forth every 200 ms for no visible gain. A larger lead
 *    means the audio clock genuinely fell behind the wall clock (dropped frames,
 *    a stalled analyzer), and the clock is walked back at no more than
 *    {@link RAIL_CLOCK_MAX_CORRECTION_MS} per snapshot — which, against a wall
 *    clock advancing at the same rate, *holds the ribbon still* until it
 *    converges instead of dragging marks rightward in one jump (§10.4).
 *
 * This is a reading of an authority, not an authority. It is used only to
 * position marks and to expire a tip. Nothing here can move the script (Rule 1).
 */
import type { CoachRailState } from '../../../shared/contracts/coaching';

/**
 * How far the between-snapshot interpolation may run ahead of the newest
 * payload clock before it is pulled back. Two §12.2 publish intervals: enough
 * that an ordinary gap between snapshots is never "corrected", small enough that
 * the ribbon's now-edge cannot drift visibly from the take.
 */
export const RAIL_CLOCK_MAX_LEAD_MS = 400;

/**
 * The most the clock may be walked *back* in one sync. Smaller than the publish
 * interval, so a backward correction holds the ribbon still rather than moving
 * it: §10.4 forbids a mark travelling rightward, and this is what keeps a
 * correction from becoming one.
 */
export const RAIL_CLOCK_MAX_CORRECTION_MS = 200;

/**
 * The snapshot's audio-clock time.
 *
 * Normally this is just `state.audioTimeMs` — the whole point of the field is
 * that the stage does not have to derive it. The fallback below exists only for
 * a payload that crossed the window boundary without it (an older producer, a
 * hand-built object in a test): the type is a claim, not a fact, and a rail
 * pinned at time zero would draw an empty ribbon and never expire a tip. It is a
 * last resort, not a second opinion — when `audioTimeMs` is present it wins,
 * even if the payload also carries a newer stamp somewhere.
 */
export function railClockAnchorMs(state: CoachRailState): number | null {
  if (typeof state.audioTimeMs === 'number' && Number.isFinite(state.audioTimeMs)) {
    return state.audioTimeMs;
  }
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
 * The payload's audio clock, interpolated between snapshots by a monotonic wall
 * clock (`performance.now()` in the stage, an explicit number in tests).
 */
export class RailClock {
  private audioAtBaseMs = 0;
  private baseMonotonicMs = 0;
  private started = false;
  private takePassId: string | null = null;
  /**
   * The newest payload clock folded in. A repeated snapshot is not a new
   * reading, and an *older* one is not a correction: out-of-order delivery is
   * normal (§27) and the producer's own clock never rewinds, so a lower value
   * can only be a snapshot from before the one we already applied.
   */
  private appliedAnchorMs = Number.NEGATIVE_INFINITY;

  /** Audio time now, in ms. */
  read(monotonicMs: number): number {
    if (!this.started) return this.audioAtBaseMs;
    return this.audioAtBaseMs + Math.max(0, monotonicMs - this.baseMonotonicMs);
  }

  /**
   * Fold a snapshot in. Idempotent for a fixed `monotonicMs`: calling it twice
   * with the same arguments produces the same reading, which is what lets the
   * component evaluate it inside a `$derived` without the reading moving every
   * time Svelte re-runs the expression.
   */
  sync(state: CoachRailState, monotonicMs: number): number {
    const anchor = railClockAnchorMs(state);
    if (!this.started || state.takePassId !== this.takePassId) {
      // A new take pass is a new performance; nothing carries over (§5.4).
      this.started = true;
      this.takePassId = state.takePassId;
      this.appliedAnchorMs = anchor ?? Number.NEGATIVE_INFINITY;
      this.audioAtBaseMs = anchor ?? 0;
      this.baseMonotonicMs = monotonicMs;
      return this.audioAtBaseMs;
    }

    const estimate = this.read(monotonicMs);
    // No clock news: the same snapshot re-rendered, control gone quiet, or a
    // snapshot from before the one already applied. Either way the ribbon keeps
    // moving — a stalled publisher must not stall the take on the glass
    // (§10.2, §9.3).
    if (anchor === null || anchor <= this.appliedAnchorMs) return estimate;
    this.appliedAnchorMs = anchor;

    if (anchor >= estimate) return this.rebase(anchor, monotonicMs);
    const lead = estimate - anchor;
    if (lead <= RAIL_CLOCK_MAX_LEAD_MS) return estimate;
    return this.rebase(
      Math.max(anchor + RAIL_CLOCK_MAX_LEAD_MS, estimate - RAIL_CLOCK_MAX_CORRECTION_MS),
      monotonicMs,
    );
  }

  private rebase(audioMs: number, monotonicMs: number): number {
    this.audioAtBaseMs = audioMs;
    this.baseMonotonicMs = monotonicMs;
    return audioMs;
  }
}
