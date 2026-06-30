import type { SpeechPlaybackPlan } from '@shared/contracts';

/**
 * Web Audio engine that owns the interviewer's spoken audio for a turn.
 *
 * Lifecycle per plan:
 *  1. `load(plan)`  decode the WAV bytes, then `reportReady`.
 *  2. `start()`     called when the visual state becomes 'speaking'; plays the
 *                   decoded buffer and `reportStarted`.
 *  3. on `ended`    `reportEnded` — audio end is authoritative for the turn.
 *
 * Output routing: we attempt `setSinkId` on a hidden <audio> element when an
 * explicit output device was chosen and the platform supports it; otherwise we
 * fall back to the default destination. Nothing about routing is surfaced on
 * stage.
 */

type ReportReady = (input: { turnId: string }) => void;
type ReportStarted = (input: { turnId: string; atMs: number }) => void;
type ReportEnded = (input: { turnId: string; atMs: number }) => void;
type ReportError = (input: { turnId: string; reason: string }) => void;

export interface SpeechPlayerCallbacks {
  reportReady: ReportReady;
  reportStarted: ReportStarted;
  reportEnded: ReportEnded;
  reportError: ReportError;
  /** Fired locally so the deck can return to listening when speech finishes. */
  onEnded: (turnId: string) => void;
}

interface LoadedTurn {
  turnId: string;
  buffer: AudioBuffer;
  outputDeviceId: string | null;
}

export class SpeechPlayer {
  private readonly callbacks: SpeechPlayerCallbacks;
  private readonly context: AudioContext;
  /** Hidden element used purely to pin Web Audio output to a chosen device. */
  private readonly sinkElement: HTMLAudioElement;
  private sinkNode: MediaStreamAudioDestinationNode | null = null;

  private loaded: LoadedTurn | null = null;
  private source: AudioBufferSourceNode | null = null;
  private startedTurnId: string | null = null;
  /** Monotonic load token so a stale decode can't clobber a newer plan. */
  private loadGen = 0;
  /** Set when start() was requested before the buffer finished decoding. */
  private startRequested = false;

  /**
   * Streaming-playback state (C4), null on the buffered path. Chunks are decoded
   * in arrival order and scheduled back-to-back on a single time cursor so the
   * independently-WAV-wrapped chunks play gaplessly. Readiness fires on the first
   * decoded chunk; end fires when the final chunk has been scheduled AND every
   * scheduled source has finished.
   */
  private stream: {
    turnId: string;
    outputDeviceId: string | null;
    raw: { bytes: ArrayBuffer; isFinal: boolean }[];
    decoded: { buffer: AudioBuffer; isFinal: boolean }[];
    decoding: boolean;
    started: boolean;
    nextStartTime: number;
    reportedReady: boolean;
    liveSources: number;
    finalScheduled: boolean;
    ended: boolean;
    sources: AudioBufferSourceNode[];
  } | null = null;

  /**
   * Chunks that arrived before their streaming plan (the plan and chunks ride
   * different IPC channels, so a chunk can race ahead). Held briefly and drained
   * when the matching plan's load() sets up the stream, so the start is not
   * clipped. Capped so a stray turn id cannot grow it without bound.
   */
  private earlyChunks: { turnId: string; bytes: ArrayBuffer; isFinal: boolean }[] = [];

  constructor(callbacks: SpeechPlayerCallbacks) {
    this.callbacks = callbacks;
    this.context = new AudioContext();

    const el = document.createElement('audio');
    el.autoplay = true;
    // Keep it out of the layout/AT tree; it is an audio sink only.
    el.setAttribute('aria-hidden', 'true');
    el.style.display = 'none';
    document.body.appendChild(el);
    this.sinkElement = el;
  }

  /**
   * Decode a plan's audio and signal readiness. Safe to call repeatedly; the
   * most recently loaded turn wins.
   */
  async load(plan: SpeechPlaybackPlan): Promise<void> {
    const { turnId } = plan;
    const gen = ++this.loadGen;
    // A new plan supersedes any start that was requested for the previous turn.
    this.startRequested = false;
    // Streaming plan: no bytes up front — set up to receive chunks. Readiness is
    // reported from the first decoded chunk (see pushChunk), not here.
    if (plan.streaming === true) {
      const s = {
        turnId,
        outputDeviceId: plan.audio.outputDeviceId,
        raw: [] as { bytes: ArrayBuffer; isFinal: boolean }[],
        decoded: [] as { buffer: AudioBuffer; isFinal: boolean }[],
        decoding: false,
        started: false,
        nextStartTime: 0,
        reportedReady: false,
        liveSources: 0,
        finalScheduled: false,
        ended: false,
        sources: [] as AudioBufferSourceNode[],
      };
      this.stream = s;
      this.loaded = null;
      // Drain any chunks that raced ahead of this plan.
      const early = this.earlyChunks.filter((c) => c.turnId === turnId);
      this.earlyChunks = [];
      for (const c of early) {
        s.raw.push({ bytes: c.bytes, isFinal: c.isFinal });
      }
      if (early.length > 0) {
        void this.decodeStream();
      }
      return;
    }
    this.stream = null;
    this.earlyChunks = [];
    try {
      // decodeAudioData detaches the buffer, so decode a copy and keep the
      // original plan bytes intact for any later use.
      const copy = plan.audio.bytes.slice(0);
      const buffer = await this.context.decodeAudioData(copy);
      if (gen !== this.loadGen) {
        return; // superseded by a newer load while decoding
      }
      this.loaded = {
        turnId,
        buffer,
        outputDeviceId: plan.audio.outputDeviceId,
      };
      this.callbacks.reportReady({ turnId });
      // If the stage already reached 'speaking' before decode finished, start now.
      this.tryStart();
    } catch (error) {
      if (gen !== this.loadGen) {
        return;
      }
      this.callbacks.reportError({
        turnId,
        reason: error instanceof Error ? error.message : 'decode_failed',
      });
    }
  }

  /**
   * Begin playing the loaded turn. No-op unless the loaded turn matches and is
   * not already playing.
   */
  start(): void {
    if (this.stream !== null) {
      this.startStream();
      return;
    }
    // Remember the request; tryStart runs it now or as soon as decode completes.
    this.startRequested = true;
    this.tryStart();
  }

  /**
   * Accept one streamed audio chunk (a complete WAV) for the streaming turn.
   * Decoded in arrival order; the first decoded chunk reports readiness.
   */
  pushChunk(turnId: string, bytes: ArrayBuffer, isFinal: boolean): void {
    const s = this.stream;
    if (s === null || s.turnId !== turnId) {
      // The plan for this turn has not arrived yet (or has been superseded). Hold
      // the chunk briefly so a chunk that raced ahead of its plan isn't lost.
      if (this.earlyChunks.length < 256) {
        this.earlyChunks.push({ turnId, bytes, isFinal });
      }
      return;
    }
    if (s.ended) {
      return;
    }
    s.raw.push({ bytes, isFinal });
    void this.decodeStream();
  }

  /** Begin streaming playback (called when the visual state reaches 'speaking'). */
  private startStream(): void {
    const s = this.stream;
    if (s === null || s.started) {
      return;
    }
    s.started = true;
    void (async () => {
      await this.routeOutput(s.outputDeviceId);
      if (this.stream !== s) {
        return; // superseded while routing
      }
      try {
        await this.context.resume();
      } catch {
        return;
      }
      if (this.stream !== s) {
        return;
      }
      // Lead the cursor slightly so the first source never starts in the past.
      s.nextStartTime = this.context.currentTime + 0.05;
      this.callbacks.reportStarted({ turnId: s.turnId, atMs: Date.now() });
      this.pumpStream();
    })();
  }

  /** Sequentially decode queued chunk WAVs, preserving order. */
  private async decodeStream(): Promise<void> {
    const s = this.stream;
    if (s === null || s.decoding) {
      return;
    }
    s.decoding = true;
    try {
      while (s.raw.length > 0) {
        const item = s.raw.shift();
        if (item === undefined) break;
        let buffer: AudioBuffer;
        try {
          buffer = await this.context.decodeAudioData(item.bytes.slice(0));
        } catch {
          if (this.stream === s) {
            this.callbacks.reportError({ turnId: s.turnId, reason: 'chunk_decode_failed' });
          }
          return;
        }
        if (this.stream !== s) {
          return; // superseded mid-decode
        }
        s.decoded.push({ buffer, isFinal: item.isFinal });
        // The first decoded chunk satisfies the readiness gate for this turn.
        if (!s.reportedReady) {
          s.reportedReady = true;
          this.callbacks.reportReady({ turnId: s.turnId });
        }
        if (s.started) {
          this.pumpStream();
        }
      }
    } finally {
      if (this.stream === s) {
        s.decoding = false;
      }
    }
  }

  /** Schedule any decoded-but-unscheduled buffers back-to-back (gapless). */
  private pumpStream(): void {
    const s = this.stream;
    if (s === null || !s.started) {
      return;
    }
    for (;;) {
      const next = s.decoded.shift();
      if (next === undefined) break;
      const source = this.context.createBufferSource();
      source.buffer = next.buffer;
      source.connect(this.sinkNode ?? this.context.destination);
      const startAt = Math.max(this.context.currentTime, s.nextStartTime);
      s.nextStartTime = startAt + next.buffer.duration;
      s.liveSources += 1;
      s.sources.push(source);
      if (next.isFinal) {
        s.finalScheduled = true;
      }
      source.onended = (): void => {
        if (this.stream !== s) return;
        s.liveSources -= 1;
        this.maybeEndStream();
      };
      try {
        source.start(startAt);
      } catch {
        // Context closed/disposed mid-schedule: this source will never fire
        // 'ended', so release its hold on the end gate here.
        s.liveSources -= 1;
      }
    }
    this.maybeEndStream();
  }

  /** Report end once the final chunk is scheduled and all sources have finished. */
  private maybeEndStream(): void {
    const s = this.stream;
    if (s === null || s.ended) {
      return;
    }
    if (s.finalScheduled && s.liveSources === 0 && s.decoded.length === 0 && s.raw.length === 0) {
      s.ended = true;
      const { turnId } = s;
      this.callbacks.reportEnded({ turnId, atMs: Date.now() });
      this.callbacks.onEnded(turnId);
    }
  }

  private tryStart(): void {
    const loaded = this.loaded;
    if (loaded === null || !this.startRequested) {
      return;
    }
    if (this.startedTurnId === loaded.turnId) {
      return;
    }
    const turnId = loaded.turnId;
    // Snapshot the load token so an older routing/resume continuation can't start
    // a stale buffer after a newer plan has loaded.
    const gen = this.loadGen;
    // Claim the turn immediately so a re-entrant start() for the same turn is a
    // no-op while we await output routing.
    this.startRequested = false;
    this.startedTurnId = turnId;

    void (async () => {
      // Resolve output routing first so the buffer source connects to the chosen
      // sink node rather than always playing on the default device (MEDIA-03).
      await this.routeOutput(loaded.outputDeviceId);
      if (this.startedTurnId !== turnId || this.loadGen !== gen) {
        return; // superseded by a newer turn/plan while routing
      }

      const source = this.context.createBufferSource();
      source.buffer = loaded.buffer;
      source.connect(this.sinkNode ?? this.context.destination);

      source.onended = (): void => {
        // Ignore ended events from a source we have already superseded/stopped.
        if (this.source !== source) {
          return;
        }
        this.source = null;
        // Allow the same turn to be replayed (Repeat) after it has finished.
        this.startedTurnId = null;
        this.callbacks.reportEnded({ turnId, atMs: Date.now() });
        this.callbacks.onEnded(turnId);
      };
      this.source = source;

      try {
        await this.context.resume();
      } catch {
        return; // context closed/disposed mid-start
      }
      // Guard against a newer turn/plan having started while resuming.
      if (this.source !== source || this.loadGen !== gen) {
        return;
      }
      source.start();
      this.callbacks.reportStarted({ turnId, atMs: Date.now() });
    })();
  }

  /** Stop any in-flight playback without reporting an end for the turn. */
  stop(): void {
    this.startRequested = false;
    if (this.stream !== null) {
      const s = this.stream;
      this.stream = null;
      for (const src of s.sources) {
        try {
          src.onended = null;
          src.stop();
        } catch {
          // Already stopped / never started.
        }
      }
    }
    if (this.source !== null) {
      const source = this.source;
      this.source = null;
      try {
        source.onended = null;
        source.stop();
      } catch {
        // Already stopped / never started — nothing to do.
      }
    }
    this.startedTurnId = null;
  }

  async dispose(): Promise<void> {
    this.stop();
    this.sinkElement.remove();
    if (this.sinkNode !== null) {
      this.sinkNode.disconnect();
      this.sinkNode = null;
    }
    try {
      await this.context.close();
    } catch {
      // Context may already be closed.
    }
  }

  /**
   * Best-effort pinning of the Web Audio graph to a specific output device.
   * When unsupported (no `setSinkId`) we simply stay on the default output.
   */
  private async routeOutput(outputDeviceId: string | null): Promise<void> {
    if (outputDeviceId === null || outputDeviceId === '') {
      // Default device: drop any prior sink so playback returns to the default
      // destination instead of staying pinned to a previously-selected device.
      this.clearSink();
      return;
    }
    // `setSinkId` is gated behind platform support; treat its absence as default.
    const el = this.sinkElement as HTMLAudioElement & {
      setSinkId?(deviceId: string): Promise<void>;
    };
    if (typeof el.setSinkId !== 'function') {
      this.clearSink();
      return;
    }
    try {
      if (this.sinkNode === null) {
        // The buffer source connects to this node; its stream is played by the
        // hidden <audio> element, which owns the device selection via setSinkId.
        this.sinkNode = this.context.createMediaStreamDestination();
        this.sinkElement.srcObject = this.sinkNode.stream;
      }
      await el.setSinkId(outputDeviceId);
    } catch {
      // Could not pin the device; fall back to the default destination.
      this.clearSink();
    }
  }

  /** Disconnect/forget the selected-output sink so playback uses the default. */
  private clearSink(): void {
    if (this.sinkNode !== null) {
      this.sinkNode.disconnect();
      this.sinkNode = null;
    }
    this.sinkElement.srcObject = null;
  }
}
