/**
 * The renderer's half of the audio queue: frames on their way to
 * `push_transcription_audio`, one call at a time and in order, with a bound.
 *
 * Rust bounds its own queue (`AUDIO_QUEUE_FRAMES` in `speech/session.rs`) and
 * reports what it drops, but it can only count frames that reach it. A push
 * that slows down or never settles holds every later frame here, on this side
 * of the IPC edge, and an unbounded chain of them was a backlog of seconds-old
 * audio replayed the moment the call came back — the cursor placed against
 * the past, and the loss reported to nobody (#288).
 *
 * The policy, which matches Rust's in effect if not in mechanism:
 *
 * - ONE CALL IN FLIGHT. Tauri dispatches invocations concurrently, and audio
 *   delivered out of order is a transcript with its syllables shuffled. A call
 *   that has not come back is never abandoned for the next frame: a JavaScript
 *   timeout cannot cancel a native invocation, so moving on would put that
 *   frame behind the ones after it.
 * - THE OLDEST GO. Past the bound, and past the wait budget, frames are dropped
 *   from the front, so what follows a stall is the present rather than a
 *   replay of it. Nothing is sent in a gap's place: the audio clock is the
 *   count of samples the recogniser received, and a frame never sent leaves it
 *   exactly as a frame Rust dropped does.
 * - NOTHING SILENTLY. Every frame lost here is counted, traced, and handed to
 *   `onDropped` — the first of a stall at once, so a call that never settles
 *   is still visible, and then at most once a second while it lasts.
 */
import { trace } from '../audio-trace';

/**
 * The most frames waiting behind the call in flight: 4 s of 100 ms frames.
 *
 * No smaller than `PRE_ROLL_MAX_FRAMES`, because the opening words held while
 * the recogniser loads are released here in one burst and a healthy start must
 * deliver all of them. Under Rust's 50 for the same reason the pre-roll is: the
 * backlog has to fit even if the worker has not taken a frame yet.
 */
export const AUDIO_SEND_QUEUE_FRAMES = 40;

/**
 * How long a frame may wait here before it is too old to be worth sending.
 *
 * The span of a full queue, so under a capture running at its cadence this and
 * the count bound agree, and this one bites only when capture stops mid-stall
 * and the frames left behind keep ageing. Deliberately not tighter: a danger
 * notice stands until dismissed, and a second's jank on the main thread is not
 * worth telling the presenter about when the audio would have arrived intact.
 */
export const AUDIO_SEND_MAX_WAIT_MS = 4_000;

/** Repeat reports during one long stall no more often than this. */
const REPORT_INTERVAL_MS = 1_000;

type LossReason = 'overflow' | 'expired' | 'rejected';

export interface AudioSendQueueOptions {
  /** One IPC push; the next frame is not sent until it settles. */
  send(chunk: string): Promise<void>;
  /** A push came back. Not proof the recogniser kept it — Rust drops its own. */
  onDelivered?(): void;
  /** Frames that will never reach the recogniser, since the last report. */
  onDropped?(frames: number): void;
  now?: () => number;
  capacity?: number;
  maxWaitMs?: number;
}

export class AudioSendQueue {
  private waiting: Array<{ chunk: string; queuedAtMs: number }> = [];
  private sending = false;
  private disposed = false;
  private readonly lost: Record<LossReason, number> = { overflow: 0, expired: 0, rejected: 0 };
  private unreported = 0;
  private lastReportAtMs = Number.NEGATIVE_INFINITY;
  private readonly now: () => number;
  private readonly capacity: number;
  private readonly maxWaitMs: number;

  constructor(private readonly options: AudioSendQueueOptions) {
    this.now = options.now ?? (() => performance.now());
    this.capacity = options.capacity ?? AUDIO_SEND_QUEUE_FRAMES;
    this.maxWaitMs = options.maxWaitMs ?? AUDIO_SEND_MAX_WAIT_MS;
  }

  /** Frames held behind the call in flight. */
  get depth(): number {
    return this.waiting.length;
  }

  /** Whether a push has been issued and has not yet settled. */
  get inFlight(): boolean {
    return this.sending;
  }

  enqueue(chunk: string): void {
    if (this.disposed) return;
    const now = this.now();
    this.waiting.push({ chunk, queuedAtMs: now });
    this.expire(now);
    if (this.waiting.length > this.capacity) {
      this.waiting.shift();
      this.lose('overflow');
    }
    this.pump();
  }

  /**
   * Send nothing more and report nothing more.
   *
   * Synchronous, and never waits on the call in flight: one that never settles
   * must not hold a microphone open behind it. The take is over, so what was
   * lost is traced rather than raised as a notice nobody is reading.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const discarded = this.waiting.length;
    this.waiting = [];
    if (this.unreported > 0 || discarded > 0) {
      trace(
        'audio-dropped',
        `${this.unreported} frames lost unreported at close, ${discarded} still waiting ` +
          `(${this.describeLosses()})`,
      );
    }
    this.unreported = 0;
  }

  private pump(): void {
    if (this.sending || this.disposed) return;
    this.expire(this.now());
    const next = this.waiting.shift();
    if (!next) return;
    this.sending = true;
    let pending: Promise<void>;
    try {
      pending = this.options.send(next.chunk);
    } catch (err) {
      pending = Promise.reject(err);
    }
    pending.then(
      () => {
        this.sending = false;
        if (this.disposed) return;
        this.options.onDelivered?.();
        // The gap, if there was one, has closed: what is left of it goes now.
        this.report(true);
        this.pump();
      },
      () => {
        this.sending = false;
        if (this.disposed) return;
        this.lose('rejected');
        this.pump();
      },
    );
  }

  /**
   * Drop, oldest first, every waiting frame past the wait budget — as one
   * loss, so a stall that ends with capture stopped reports all of it at once.
   */
  private expire(now: number): void {
    let stale = 0;
    while (stale < this.waiting.length && now - this.waiting[stale]!.queuedAtMs > this.maxWaitMs) {
      stale += 1;
    }
    if (stale === 0) return;
    this.waiting.splice(0, stale);
    this.lose('expired', stale);
  }

  private lose(reason: LossReason, frames = 1): void {
    this.lost[reason] += frames;
    this.unreported += frames;
    this.report(false);
  }

  private report(flush: boolean): void {
    if (this.unreported === 0) return;
    const now = this.now();
    if (!flush && now - this.lastReportAtMs < REPORT_INTERVAL_MS) return;
    const frames = this.unreported;
    this.unreported = 0;
    this.lastReportAtMs = now;
    trace(
      'audio-dropped',
      `${frames} frames did not reach the recogniser (${this.describeLosses()}, ` +
        `${this.waiting.length} waiting)`,
    );
    this.options.onDropped?.(frames);
  }

  private describeLosses(): string {
    const { overflow, expired, rejected } = this.lost;
    return `overflow ${overflow}, expired ${expired}, rejected ${rejected} so far`;
  }
}
