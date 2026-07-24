/**
 * The coaching speech clock (spec §5.4, §12.5, §14.1, §14.5).
 *
 * Rule 3 of `shared/contracts/coaching.ts` — *the audio clock is the only
 * clock* — is implemented here. Every other analyzer in `coaching/pace` and
 * `coaching/prosody` takes its notion of "now" from this module, and this
 * module never reads `Date.now()`. Time only advances because a frame, a
 * speech interval, or an explicit `advanceTo` said so.
 *
 * The clock distinguishes three kinds of audio time, which the rest of the
 * subsystem must not conflate:
 *
 * - **voiced** — milliseconds the VAD classified as speech. Denominator of
 *   articulation rate (§14.1).
 * - **internal pause** — silence the VAD kept *inside* a speech run (§12.5:
 *   "label pauses rather than deleting them from the clock"). Part of delivery.
 * - **unmeasured** — audio we cannot make any claim about: a worklet dropout
 *   (§12.4 `processorDropout`), a manual or system pause, a command, a retake.
 *   Removed from delivery time entirely, because counting a dropout as
 *   silence reads as a deliberate pause and corrupts both pace and cadence.
 *
 * Delivery time — the denominator of Audible and Content WPM (§14.1) — is
 * wall-of-audio elapsed minus unmeasured. Deliberate pauses stay in it; that
 * is the point of §14.5.
 */
import type { AudioFrameFeatures, CoachEvidenceStamp, SpeechInterval } from '../../contracts/coaching';

/** §12.4. One analysis frame is 20 ms. */
export const COACH_FRAME_DURATION_MS = 20;

/**
 * Identity every analyzer needs in order to stamp evidence (§5.4). Passed in
 * rather than read from a singleton so that a test can drive an epoch change
 * or take-pass change deterministically.
 */
export interface CoachClockContext {
  /** Current monotonic audio-clock time, ms. */
  audioTimeMs: number;
  trackingEpoch: number;
  takePassId: string;
  /** Realtime commit ordinal, or `null` for evidence derived purely from audio. */
  commitSequence: number | null;
}

/**
 * §5.4. Build an evidence stamp for the interval `[audioStartMs, audioEndMs]`.
 * The interval is the one the evidence *describes*, never the moment it was
 * computed; a delayed result is mapped back onto its interval by passing the
 * original bounds here.
 */
export function createEvidenceStamp(
  audioStartMs: number,
  audioEndMs: number,
  context: CoachClockContext,
): CoachEvidenceStamp {
  return {
    audioStartMs,
    audioEndMs: Math.max(audioStartMs, audioEndMs),
    commitSequence: context.commitSequence,
    trackingEpoch: context.trackingEpoch,
    takePassId: context.takePassId,
  };
}

/** Why a span of audio time carries no delivery claim. */
export type UnmeasuredReason =
  | 'processor_dropout'
  | 'manual_pause'
  | 'system_pause'
  | 'command'
  | 'retake';

export interface UnmeasuredSpan {
  startMs: number;
  endMs: number;
  reason: UnmeasuredReason;
}

export interface SpeechClockOptions {
  frameDurationMs: number;
  /**
   * `speechProbability` at or above which a frame counts as *live* voice
   * activity. This drives the pause display only (§14.5); all accounting is
   * done from closed {@link SpeechInterval}s, which arrive one VAD hangover
   * late and would otherwise make an actively speaking presenter read as
   * paused.
   */
  liveSpeechProbability: number;
  /** How much history of speech intervals to retain, ms. */
  intervalRetentionMs: number;
}

export const DEFAULT_SPEECH_CLOCK_OPTIONS: SpeechClockOptions = {
  frameDurationMs: COACH_FRAME_DURATION_MS,
  liveSpeechProbability: 0.5,
  intervalRetentionMs: 120_000,
};

export interface SpeechClockSnapshot {
  audioTimeMs: number;
  /** Elapsed audio since take start minus unmeasured spans, ms (§14.1). */
  deliveryMs: number;
  /** Voiced milliseconds accumulated from closed speech intervals. */
  voicedMs: number;
  /** Silence the VAD preserved inside speech runs, ms (§12.5). */
  internalPauseMs: number;
  /** Audio removed from delivery time because no claim can be made about it. */
  unmeasuredMs: number;
  /**
   * Silence since the last evidence of voice, ms, or `null` before any speech
   * has been observed this take pass.
   */
  silenceSinceSpeechMs: number | null;
  /**
   * True when the clock has not advanced past the last evidence of voice —
   * i.e. speech is happening right now. Derived rather than latched, so that
   * advancing the clock without new frames correctly stops reporting speech.
   */
  speaking: boolean;
}

/**
 * Accumulates the audio-clock facts every pace and cadence calculation rests
 * on. One instance per take pass; `reset` starts a new pass.
 */
export class SpeechClock {
  private readonly options: SpeechClockOptions;

  private takeStartMs = 0;
  private nowMs = 0;
  private started = false;

  private voicedMsTotal = 0;
  private internalPauseMsTotal = 0;

  /** Merged, non-overlapping, ascending by `startMs`. */
  private readonly unmeasured: UnmeasuredSpan[] = [];
  private readonly intervals: SpeechInterval[] = [];
  /** `voicedPrefix[i]` is cumulative voiced ms before `intervals[i]` began. */
  private readonly voicedPrefix: number[] = [];

  private lastVoiceActivityMs: number | null = null;

  constructor(options: Partial<SpeechClockOptions> = {}) {
    this.options = { ...DEFAULT_SPEECH_CLOCK_OPTIONS, ...options };
  }

  /** Begin a take pass at `audioTimeMs`. Clears all accumulated evidence. */
  start(audioTimeMs: number): void {
    this.takeStartMs = audioTimeMs;
    this.nowMs = audioTimeMs;
    this.started = true;
    this.voicedMsTotal = 0;
    this.internalPauseMsTotal = 0;
    this.unmeasured.length = 0;
    this.intervals.length = 0;
    this.voicedPrefix.length = 0;
    this.lastVoiceActivityMs = null;
  }

  /** Advance the clock without new evidence (a silent frame gap, a tick). */
  advanceTo(audioTimeMs: number): void {
    if (!this.started) {
      this.start(audioTimeMs);
      return;
    }
    if (audioTimeMs > this.nowMs) {
      this.nowMs = audioTimeMs;
    }
  }

  /**
   * Fold one 20 ms analysis frame in. Dropout frames become unmeasured audio;
   * frames above the live-speech probability refresh the "is speaking now"
   * signal used by the §14.5 pause ladder.
   */
  noteFrame(frame: AudioFrameFeatures): void {
    const frameEndMs = frame.audioTimeMs + this.options.frameDurationMs;
    this.advanceTo(frameEndMs);

    if (frame.processorDropout) {
      this.noteUnmeasured(frame.audioTimeMs, frameEndMs, 'processor_dropout');
      return;
    }

    if (frame.speechProbability >= this.options.liveSpeechProbability) {
      this.lastVoiceActivityMs = frameEndMs;
    }
  }

  /**
   * Fold a closed VAD run in. This is the *accounting* path: voiced and
   * internal-pause totals only ever move here, so replaying frames cannot
   * double count.
   */
  noteSpeechInterval(interval: SpeechInterval): void {
    this.advanceTo(interval.endMs);
    this.voicedPrefix.push(this.voicedMsTotal);
    this.voicedMsTotal += interval.voicedMs;
    this.internalPauseMsTotal += interval.silenceMs;
    if (this.lastVoiceActivityMs === null || interval.endMs > this.lastVoiceActivityMs) {
      this.lastVoiceActivityMs = interval.endMs;
    }
    this.intervals.push(interval);
    this.trimIntervals();
  }

  /** Remove `[startMs, endMs)` from delivery time (§14.5, §18.2). */
  noteUnmeasured(startMs: number, endMs: number, reason: UnmeasuredReason): void {
    if (endMs <= startMs) {
      return;
    }
    this.advanceTo(endMs);
    const span: UnmeasuredSpan = { startMs, endMs, reason };
    const last = this.unmeasured[this.unmeasured.length - 1];
    if (last !== undefined && last.reason === reason && startMs <= last.endMs) {
      // Contiguous or overlapping continuation of the same condition.
      last.endMs = Math.max(last.endMs, endMs);
      return;
    }
    if (last === undefined || startMs >= last.endMs) {
      this.unmeasured.push(span);
      return;
    }
    this.unmeasured.push(span);
    this.unmeasured.sort((a, b) => a.startMs - b.startMs);
  }

  /** Speech intervals overlapping `[startMs, endMs]`, clipped to it. */
  voicedSubIntervalsIn(startMs: number, endMs: number): Array<{ startMs: number; endMs: number }> {
    const out: Array<{ startMs: number; endMs: number }> = [];
    for (const interval of this.intervals) {
      const lo = Math.max(startMs, interval.startMs);
      const hi = Math.min(endMs, interval.endMs);
      if (hi > lo) {
        out.push({ startMs: lo, endMs: hi });
      }
    }
    return out;
  }

  /**
   * Voiced milliseconds inside `[startMs, endMs]`. Each interval's voiced
   * fraction is applied to the overlapping portion, because the VAD reports a
   * run's voiced total rather than its positions.
   */
  voicedMsIn(startMs: number, endMs: number): number {
    let total = 0;
    for (const interval of this.intervals) {
      const lo = Math.max(startMs, interval.startMs);
      const hi = Math.min(endMs, interval.endMs);
      if (hi <= lo) {
        continue;
      }
      const span = interval.endMs - interval.startMs;
      if (span <= 0) {
        continue;
      }
      total += interval.voicedMs * ((hi - lo) / span);
    }
    return total;
  }

  /** Unmeasured milliseconds inside `[startMs, endMs]`. */
  unmeasuredMsIn(startMs: number, endMs: number): number {
    let total = 0;
    for (const span of this.unmeasured) {
      const lo = Math.max(startMs, span.startMs);
      const hi = Math.min(endMs, span.endMs);
      if (hi > lo) {
        total += hi - lo;
      }
    }
    return total;
  }

  /** Delivery milliseconds inside `[startMs, endMs]` — elapsed minus unmeasured. */
  deliveryMsIn(startMs: number, endMs: number): number {
    if (endMs <= startMs) {
      return 0;
    }
    return endMs - startMs - this.unmeasuredMsIn(startMs, endMs);
  }

  /**
   * §14.1 articulation clock. Cumulative voiced milliseconds elapsed at
   * `audioTimeMs`, interpolated linearly inside the interval that contains it.
   *
   * This is the x-axis articulation rate must be measured against. Measuring
   * it as `audibleWpm × delivery/voiced` looks equivalent and is not: when a
   * pause sits at the edge of the window with no tokens spanning it, the
   * audible regression never saw the pause, and scaling it up double-counts
   * silence that was already absent.
   */
  voicedTimeAt(audioTimeMs: number): number {
    if (this.intervals.length === 0) {
      return this.voicedMsTotal;
    }
    const first = this.intervals[0];
    if (first !== undefined && audioTimeMs <= first.startMs) {
      return this.voicedPrefix[0] ?? 0;
    }
    for (let index = this.intervals.length - 1; index >= 0; index -= 1) {
      const interval = this.intervals[index];
      const prefix = this.voicedPrefix[index];
      if (interval === undefined || prefix === undefined || audioTimeMs < interval.startMs) {
        continue;
      }
      if (audioTimeMs >= interval.endMs) {
        return prefix + interval.voicedMs;
      }
      const span = interval.endMs - interval.startMs;
      if (span <= 0) {
        return prefix + interval.voicedMs;
      }
      return prefix + interval.voicedMs * ((audioTimeMs - interval.startMs) / span);
    }
    return this.voicedPrefix[0] ?? 0;
  }

  /** Total voiced milliseconds accumulated this take pass. */
  totalVoicedMs(): number {
    return this.voicedMsTotal;
  }

  /** Closed speech intervals retained, oldest first. */
  recentIntervals(): readonly SpeechInterval[] {
    return this.intervals;
  }

  snapshot(): SpeechClockSnapshot {
    const silenceSinceSpeechMs =
      this.lastVoiceActivityMs === null ? null : Math.max(0, this.nowMs - this.lastVoiceActivityMs);
    return {
      audioTimeMs: this.nowMs,
      deliveryMs: this.deliveryMsIn(this.takeStartMs, this.nowMs),
      voicedMs: this.voicedMsTotal,
      internalPauseMs: this.internalPauseMsTotal,
      unmeasuredMs: this.unmeasuredMsIn(this.takeStartMs, this.nowMs),
      silenceSinceSpeechMs,
      speaking: this.lastVoiceActivityMs !== null && this.nowMs <= this.lastVoiceActivityMs,
    };
  }

  private trimIntervals(): void {
    const cutoff = this.nowMs - this.options.intervalRetentionMs;
    let drop = 0;
    while (drop < this.intervals.length) {
      const interval = this.intervals[drop];
      if (interval === undefined || interval.endMs >= cutoff) {
        break;
      }
      drop += 1;
    }
    if (drop > 0) {
      this.intervals.splice(0, drop);
      this.voicedPrefix.splice(0, drop);
    }
  }
}
