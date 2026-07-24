/**
 * Layer C — the precision-transcription queue (§16.3, §29).
 *
 * ## The drop policy, stated once
 *
 * The queue is **bounded by audio duration, not by item count**, because what
 * costs money and memory is seconds of PCM, not array entries. Defaults from
 * §29.1: 45 s of pending audio, 1 concurrent request, 12 s maximum chunk.
 *
 * On admission, while `pendingAudioMs + incoming > maxPendingAudioMs`:
 *
 * 1. Find the **lowest-priority, oldest** queued chunk (`ordinary` <
 *    `candidate` < `take_tail`).
 * 2. If that chunk's priority is **at or below** the incoming chunk's, evict it
 *    (`evicted_lower_value`) and re-test. An ordinary chunk can therefore push
 *    out an older ordinary chunk, but never a candidate-triggered one.
 * 3. Otherwise reject the incoming chunk (`queue_full`).
 *
 * `take_tail` is never evicted while review is enabled (§29.1 "always process
 * final take tail").
 *
 * **Why evict the oldest rather than reject the newest?** Because a precision
 * result that has been queued longer than the whole bound has already missed
 * its live window — §16.3.5 forbids reprimanding a filler several seconds
 * after the speaker moved on — so its only remaining value is backfill, which
 * is the cheapest thing to lose. Under sustained latency the queue therefore
 * degrades to a sliding window over the most recent 45 s of speech, which is
 * exactly the audio that can still produce a useful tip when the API recovers.
 *
 * **In-flight requests count toward the bound and have their own deadline.**
 * Without `maxInFlightMs` a single hung request would pin the bound forever
 * and the queue would stop accepting anything: bounded, but dead. An expired
 * request is abandoned (`in_flight_timeout`), its audio released, and a late
 * answer for it is ignored rather than double-counted.
 *
 * Failures (§29.4): one retry for a transient error, then abandon. Never an
 * unbounded retry loop, and never anything that could stall the teleprompter —
 * this module holds no lock and awaits nothing on the render path.
 */
import type {
  PrecisionChunkPriority,
  PrecisionChunkRequest,
  PrecisionCostMode,
  PrecisionDropReason,
  PrecisionDropRecord,
  PrecisionTranscriptionClient,
  PrecisionTranscriptResult,
} from './types';
import { PRECISION_PRIORITY_RANK } from './types';

export interface PrecisionQueueOptions {
  client: PrecisionTranscriptionClient;
  mode?: PrecisionCostMode;
  /** §29.1 default 45 000 ms of pending audio. */
  maxPendingAudioMs?: number;
  /** §29.1: 1 or 2 depending on platform and account tier. */
  maxConcurrent?: number;
  /** §29.1 maximum chunk: 12 000 ms. */
  maxChunkMs?: number;
  /** Abandon a request still in flight after this much audio time, ms. */
  maxInFlightMs?: number;
  /** §29.4: retry once after a transient error. */
  retryTransientOnce?: boolean;
  /** §29.1: never drop the final take tail while review is enabled. */
  alwaysProcessTakeTail?: boolean;
  onResult?: (result: PrecisionTranscriptResult) => void;
  onDrop?: (record: PrecisionDropRecord) => void;
}

export interface EnqueueOutcome {
  accepted: boolean;
  /** Drops caused by this admission, including the incoming chunk if rejected. */
  dropped: PrecisionDropRecord[];
}

export interface PrecisionQueueDiagnostics {
  queued: number;
  completed: number;
  dropped: number;
  failed: number;
  inFlight: number;
  pendingCount: number;
  pendingAudioMs: number;
  peakPendingAudioMs: number;
}

interface QueueEntry {
  request: PrecisionChunkRequest;
  durationMs: number;
  attempts: number;
  /** Audio time the request was dispatched, or `null` while queued. */
  dispatchedAtAudioMs: number | null;
}

const DEFAULTS = {
  mode: 'on_candidates' as PrecisionCostMode,
  maxPendingAudioMs: 45_000,
  maxConcurrent: 1,
  maxChunkMs: 12_000,
  maxInFlightMs: 20_000,
  retryTransientOnce: true,
  alwaysProcessTakeTail: true,
};

/** An error the caller marks non-retryable (auth, quota, malformed request). */
export interface PermanentTranscriptionError extends Error {
  permanent?: boolean;
}

export class PrecisionTranscriptionQueue {
  private readonly client: PrecisionTranscriptionClient;
  private readonly options: typeof DEFAULTS;
  private readonly onResult: ((result: PrecisionTranscriptResult) => void) | undefined;
  private readonly onDrop: ((record: PrecisionDropRecord) => void) | undefined;

  private queue: QueueEntry[] = [];
  private inFlight = new Map<string, QueueEntry>();
  private abandoned = new Set<string>();
  private lastAudioMs = 0;
  private currentTakePassId: string | null = null;

  private counters = { queued: 0, completed: 0, dropped: 0, failed: 0, peakPendingAudioMs: 0 };

  constructor(options: PrecisionQueueOptions) {
    this.client = options.client;
    this.onResult = options.onResult;
    this.onDrop = options.onDrop;
    this.options = {
      mode: options.mode ?? DEFAULTS.mode,
      maxPendingAudioMs: options.maxPendingAudioMs ?? DEFAULTS.maxPendingAudioMs,
      maxConcurrent: options.maxConcurrent ?? DEFAULTS.maxConcurrent,
      maxChunkMs: options.maxChunkMs ?? DEFAULTS.maxChunkMs,
      maxInFlightMs: options.maxInFlightMs ?? DEFAULTS.maxInFlightMs,
      retryTransientOnce: options.retryTransientOnce ?? DEFAULTS.retryTransientOnce,
      alwaysProcessTakeTail: options.alwaysProcessTakeTail ?? DEFAULTS.alwaysProcessTakeTail,
    };
  }

  get mode(): PrecisionCostMode {
    return this.options.mode;
  }

  setMode(mode: PrecisionCostMode): void {
    this.options.mode = mode;
  }

  /** Audio still owed a result: queued plus in flight. */
  pendingAudioMs(): number {
    let total = 0;
    for (const entry of this.queue) total += entry.durationMs;
    for (const entry of this.inFlight.values()) total += entry.durationMs;
    return total;
  }

  pendingChunkIds(): string[] {
    return this.queue.map((entry) => entry.request.chunkId);
  }

  inFlightChunkIds(): string[] {
    return [...this.inFlight.keys()];
  }

  diagnostics(): PrecisionQueueDiagnostics {
    return {
      queued: this.counters.queued,
      completed: this.counters.completed,
      dropped: this.counters.dropped,
      failed: this.counters.failed,
      inFlight: this.inFlight.size,
      pendingCount: this.queue.length,
      pendingAudioMs: this.pendingAudioMs(),
      peakPendingAudioMs: this.counters.peakPendingAudioMs,
    };
  }

  /**
   * A take pass change invalidates everything queued for the old pass —
   * evidence from a previous performance can never be current (§23.1).
   */
  setTakePass(takePassId: string, nowAudioMs: number): void {
    this.currentTakePassId = takePassId;
    this.lastAudioMs = nowAudioMs;
    const stale = this.queue.filter((entry) => entry.request.takePassId !== takePassId);
    this.queue = this.queue.filter((entry) => entry.request.takePassId === takePassId);
    for (const entry of stale) this.recordDrop(entry, 'stale_take_pass', nowAudioMs);
  }

  enqueue(request: PrecisionChunkRequest, nowAudioMs: number): EnqueueOutcome {
    this.lastAudioMs = Math.max(this.lastAudioMs, nowAudioMs);
    const dropped: PrecisionDropRecord[] = [];
    const durationMs = Math.max(0, request.audioEndMs - request.audioStartMs);
    const entry: QueueEntry = { request, durationMs, attempts: 0, dispatchedAtAudioMs: null };

    if (this.currentTakePassId !== null && request.takePassId !== this.currentTakePassId) {
      dropped.push(this.recordDrop(entry, 'stale_take_pass', nowAudioMs));
      return { accepted: false, dropped };
    }
    if (!this.modeAccepts(request.priority)) {
      dropped.push(this.recordDrop(entry, 'mode_off', nowAudioMs));
      return { accepted: false, dropped };
    }
    if (durationMs > this.options.maxChunkMs) {
      // §29.1 caps the chunk; splitting is the caller's job, because only the
      // caller knows where the safe boundaries are (§16.3.1).
      dropped.push(this.recordDrop(entry, 'oversized_chunk', nowAudioMs));
      return { accepted: false, dropped };
    }

    this.expireInFlight(nowAudioMs);

    while (this.pendingAudioMs() + durationMs > this.options.maxPendingAudioMs) {
      const victim = this.selectEvictionVictim(request.priority);
      if (!victim) {
        dropped.push(this.recordDrop(entry, 'queue_full', nowAudioMs));
        return { accepted: false, dropped };
      }
      this.queue = this.queue.filter((candidate) => candidate !== victim);
      dropped.push(this.recordDrop(victim, 'evicted_lower_value', nowAudioMs));
    }

    this.queue.push(entry);
    this.counters.queued += 1;
    this.counters.peakPendingAudioMs = Math.max(this.counters.peakPendingAudioMs, this.pendingAudioMs());
    this.dispatch(nowAudioMs);
    return { accepted: true, dropped };
  }

  /**
   * Advance the queue's view of the audio clock: expires hung requests and
   * dispatches whatever the concurrency budget allows.
   */
  tick(nowAudioMs: number): void {
    this.lastAudioMs = Math.max(this.lastAudioMs, nowAudioMs);
    this.expireInFlight(nowAudioMs);
    this.dispatch(nowAudioMs);
  }

  /* ----------------------------------------------------------------------- */

  private modeAccepts(priority: PrecisionChunkPriority): boolean {
    switch (this.options.mode) {
      case 'off':
        return false;
      case 'full_precision':
        return true;
      case 'on_candidates':
        return priority !== 'ordinary';
      case 'review_only':
        return priority === 'take_tail';
      default:
        return false;
    }
  }

  /**
   * The oldest chunk of the lowest priority tier present, provided that tier
   * does not outrank the incoming chunk. Returns `null` when nothing may be
   * evicted, which is the signal to reject the incoming chunk instead.
   */
  private selectEvictionVictim(incoming: PrecisionChunkPriority): QueueEntry | null {
    const incomingRank = PRECISION_PRIORITY_RANK[incoming];
    let best: QueueEntry | null = null;
    for (const entry of this.queue) {
      const priority = entry.request.priority;
      if (priority === 'take_tail' && this.options.alwaysProcessTakeTail) continue;
      const rank = PRECISION_PRIORITY_RANK[priority];
      if (rank > incomingRank) continue;
      if (!best) {
        best = entry;
        continue;
      }
      const bestRank = PRECISION_PRIORITY_RANK[best.request.priority];
      if (rank < bestRank) best = entry;
      else if (rank === bestRank && entry.request.audioStartMs < best.request.audioStartMs) best = entry;
    }
    return best;
  }

  private dispatch(nowAudioMs: number): void {
    while (this.inFlight.size < this.options.maxConcurrent && this.queue.length > 0) {
      // §29.1 oldest-first, applied *within* a priority tier: the very next
      // bullet of §29.1 ranks candidate chunks above ordinary ones for
      // dropping, and the same value judgement governs ordering.
      let bestIndex = 0;
      for (let i = 1; i < this.queue.length; i++) {
        const current = this.queue[i] as QueueEntry;
        const best = this.queue[bestIndex] as QueueEntry;
        const currentRank = PRECISION_PRIORITY_RANK[current.request.priority];
        const bestRank = PRECISION_PRIORITY_RANK[best.request.priority];
        if (currentRank > bestRank) bestIndex = i;
        else if (
          currentRank === bestRank &&
          current.request.audioStartMs < best.request.audioStartMs
        ) {
          bestIndex = i;
        }
      }
      const entry = this.queue.splice(bestIndex, 1)[0] as QueueEntry;
      entry.dispatchedAtAudioMs = nowAudioMs;
      entry.attempts += 1;
      this.inFlight.set(entry.request.chunkId, entry);
      void this.send(entry);
    }
  }

  private async send(entry: QueueEntry): Promise<void> {
    const chunkId = entry.request.chunkId;
    try {
      const result = await this.client.transcribe(entry.request);
      if (!this.inFlight.has(chunkId) || this.abandoned.has(chunkId)) return;
      this.inFlight.delete(chunkId);
      this.counters.completed += 1;
      // §5.4: the result describes the *request's* interval. Anything the
      // transport says about timing is corrected back onto it here, before a
      // single consumer sees it.
      this.onResult?.({
        ...result,
        chunkId,
        audioStartMs: entry.request.audioStartMs,
        audioEndMs: entry.request.audioEndMs,
        takePassId: entry.request.takePassId,
        trackingEpoch: entry.request.trackingEpoch,
        commitSequence: entry.request.commitSequence,
      });
    } catch (error) {
      if (!this.inFlight.has(chunkId) || this.abandoned.has(chunkId)) return;
      this.inFlight.delete(chunkId);
      const permanent = (error as PermanentTranscriptionError | null)?.permanent === true;
      if (!permanent && this.options.retryTransientOnce && entry.attempts < 2) {
        entry.dispatchedAtAudioMs = null;
        this.queue.push(entry);
      } else {
        this.counters.failed += 1;
        this.recordDrop(entry, 'transport_failed', this.lastAudioMs);
      }
    }
    this.dispatch(this.lastAudioMs);
  }

  private expireInFlight(nowAudioMs: number): void {
    for (const [chunkId, entry] of [...this.inFlight]) {
      if (entry.dispatchedAtAudioMs === null) continue;
      if (nowAudioMs - entry.dispatchedAtAudioMs < this.options.maxInFlightMs) continue;
      this.inFlight.delete(chunkId);
      this.abandoned.add(chunkId);
      if (this.abandoned.size > 256) {
        // Bounded: the set only exists to ignore very late answers.
        this.abandoned.delete(this.abandoned.values().next().value as string);
      }
      this.recordDrop(entry, 'in_flight_timeout', nowAudioMs);
    }
  }

  private recordDrop(
    entry: QueueEntry,
    reason: PrecisionDropReason,
    nowAudioMs: number,
  ): PrecisionDropRecord {
    this.counters.dropped += 1;
    const record: PrecisionDropRecord = {
      chunkId: entry.request.chunkId,
      reason,
      priority: entry.request.priority,
      audioStartMs: entry.request.audioStartMs,
      audioEndMs: entry.request.audioEndMs,
      decidedAtAudioMs: nowAudioMs,
    };
    this.onDrop?.(record);
    return record;
  }
}

/**
 * §16.3.1. Chunk boundaries: a finalized commit of 3–12 s, a sentence boundary
 * with ≥ 2 s of speech, a candidate cluster, a long pause, or take end.
 * Exported as data so the caller and the tests agree on one set of numbers.
 */
export const PRECISION_CHUNK_BOUNDS = {
  minCommitMs: 3_000,
  maxCommitMs: 12_000,
  minSentenceSpeechMs: 2_000,
  /** §16.3.1 overlap between adjacent chunks, de-duplicated by audio time. */
  overlapMs: 450,
} as const;
