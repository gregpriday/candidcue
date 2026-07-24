/**
 * §12.4 / §18.2. Turning VAD interval gaps into pauses — and refusing to turn
 * dropouts into them.
 *
 * ---------------------------------------------------------------------------
 * A DROPOUT IS NOT A PAUSE
 * ---------------------------------------------------------------------------
 * The gap between two closed speech runs is the only place a pause can be
 * derived from local audio, and it is also exactly where a buffer underrun,
 * a device change or a starved audio thread shows up. They are
 * indistinguishable from the interval list alone, which is why
 * `AudioFrameFeatures.processorDropout` exists and why `PauseEvent.unmeasured`
 * exists: whoever derives pauses from gaps must carry the distinction across.
 *
 * This module is that "whoever". It watches the frame stream for dropouts,
 * keeps the spans they cover, and marks any derived pause overlapping one as
 * unmeasured. The cadence lane then excludes it from the choppy pattern, and
 * the ribbon never draws a pause tick for a buffer underrun.
 *
 * Two kinds of hole are recorded, because the worklet can lose audio in two
 * ways:
 *
 * - an explicit `processorDropout` frame, and
 * - a *stamp gap*: consecutive frames whose times are further apart than a
 *   frame, i.e. the producer skipped frames without flagging them. `SpeechClock`
 *   already treats this as unmeasured internally; recording it here keeps the
 *   derived pause honest for the same reason.
 *
 * Clock: audio time only. Nothing here reads a wall clock.
 */
import type { AudioFrameFeatures, SpeechInterval } from '../../contracts/coaching';

export interface DerivedPause {
  startMs: number;
  endMs: number;
  /**
   * §12.4. True when part of this silence was never measured. The cadence lane
   * excludes it, and the ribbon must not draw it.
   */
  unmeasured: boolean;
  takePassId: string;
}

export interface PauseDeriverOptions {
  /** Nominal analysis frame, ms. Default 20. */
  frameMs?: number;
  /** How much dropout history to retain, ms. Default 120 000. */
  retentionMs?: number;
  /**
   * Silence shorter than this is not offered as a pause at all, ms. Default 80
   * — §18.2's micro-pause floor, below which the cadence lane classifies it as
   * `sub_threshold` anyway and the ribbon tick would be sub-pixel.
   */
  minimumPauseMs?: number;
}

interface Span {
  startMs: number;
  endMs: number;
}

const DEFAULT_RETENTION_MS = 120_000;

export class PauseDeriver {
  private readonly frameMs: number;
  private readonly retentionMs: number;
  private readonly minimumPauseMs: number;

  /** Merged, ascending, non-overlapping. */
  private unmeasured: Span[] = [];
  private lastFrameEndMs: number | null = null;
  private lastIntervalEndMs: number | null = null;

  constructor(options: PauseDeriverOptions = {}) {
    this.frameMs = options.frameMs ?? 20;
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.minimumPauseMs = options.minimumPauseMs ?? 80;
  }

  /** A new take pass: silence from a previous performance is not a pause. */
  reset(): void {
    this.unmeasured = [];
    this.lastFrameEndMs = null;
    this.lastIntervalEndMs = null;
  }

  /** Spans of audio that carry no measurement, oldest first. Diagnostics. */
  unmeasuredSpans(): readonly Span[] {
    return this.unmeasured;
  }

  /** Fold one analysis frame in. Records dropouts and producer stamp gaps. */
  noteFrame(frame: AudioFrameFeatures): void {
    const startMs = frame.audioTimeMs;
    const endMs = startMs + this.frameMs;
    const previousEnd = this.lastFrameEndMs;
    if (previousEnd !== null && startMs - previousEnd > this.frameMs * 0.5) {
      // Frames the producer never sent. `SpeechClock` calls this unmeasured
      // too; a derived pause must agree with it.
      this.addUnmeasured(previousEnd, startMs);
    }
    this.lastFrameEndMs = endMs;
    if (frame.processorDropout) this.addUnmeasured(startMs, endMs);
    this.prune(endMs);
  }

  /**
   * Fold a closed speech run in, returning the pause that ended at its start.
   *
   * `null` when this is the first run of the take pass — there is no silence
   * *between* runs before there are two of them, and calling the lead-in a
   * pause would put a tick on the ribbon for the moment before the presenter
   * started.
   */
  noteInterval(interval: SpeechInterval): DerivedPause | null {
    const previousEnd = this.lastIntervalEndMs;
    this.lastIntervalEndMs = Math.max(this.lastIntervalEndMs ?? -Infinity, interval.endMs);
    if (previousEnd === null) return null;
    const startMs = previousEnd;
    const endMs = interval.startMs;
    if (endMs - startMs < this.minimumPauseMs) return null;
    return {
      startMs,
      endMs,
      unmeasured: this.overlapsUnmeasured(startMs, endMs),
      takePassId: interval.takePassId,
    };
  }

  /**
   * §14.5 / §18.2. A span removed from delivery by something other than the
   * audio path — a manual pause, a command, a retake. Recorded so a silence
   * that spans it is reported as unmeasured rather than as phrasing.
   */
  noteUnmeasuredSpan(startMs: number, endMs: number): void {
    this.addUnmeasured(startMs, endMs);
  }

  private overlapsUnmeasured(startMs: number, endMs: number): boolean {
    for (const span of this.unmeasured) {
      if (span.startMs < endMs && span.endMs > startMs) return true;
    }
    return false;
  }

  private addUnmeasured(startMs: number, endMs: number): void {
    if (!(endMs > startMs)) return;
    const last = this.unmeasured[this.unmeasured.length - 1];
    if (last !== undefined && startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, endMs);
      return;
    }
    this.unmeasured.push({ startMs, endMs });
  }

  /** §33 bounded memory. */
  private prune(nowMs: number): void {
    const cutoff = nowMs - this.retentionMs;
    let drop = 0;
    while (drop < this.unmeasured.length) {
      const span = this.unmeasured[drop];
      if (span === undefined || span.endMs >= cutoff) break;
      drop += 1;
    }
    if (drop > 0) this.unmeasured.splice(0, drop);
  }
}
