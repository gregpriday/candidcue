import type {
  SpeechToTextAdapter,
  SttSessionConfig,
  AudioChunkPacket,
  SttTurnResult,
  SttRecoveryConfig,
  SttEvent,
  Unsubscribe,
} from '@shared/contracts/adapters';
import { AppError } from '@shared/errors/app-error';

import { throwIfAborted, delay } from './abort';

/** Knobs for {@link FakeStt}. */
export interface FakeSttConfig {
  /** Transcript returned by `endTurn` / `recoverFromAudio`. */
  transcript?: string;
  /** Final segments returned by `endTurn` / `recoverFromAudio`. */
  finalSegments?: string[];
  /** Confidence reported on results. Default 0.9. */
  confidence?: number | null;
  /** Artificial latency (ms) applied to async calls. Default 0. */
  delayMs?: number;
}

type Listener = (...args: any[]) => void;

/**
 * Deterministic stand-in for the Inworld streaming STT adapter. It records the
 * audio it is fed, returns a configurable transcript on `endTurn`, and exposes
 * an event emitter so tests can drive `speechStarted` / `speechStopped` /
 * `partial` / `finalSegment` / `error` events synchronously.
 */
export class FakeStt implements SpeechToTextAdapter {
  private readonly transcript: string;
  private readonly finalSegments: string[];
  private readonly confidence: number | null;
  private readonly delayMs: number;

  /** Registered listeners keyed by event name. */
  private readonly listeners = new Map<SttEvent, Set<Listener>>();

  // Observable state for test assertions.
  public connected = false;
  public closed = false;
  public currentTurnId: string | null = null;
  public readonly writtenChunks: AudioChunkPacket[] = [];
  public lastConfig: SttSessionConfig | null = null;
  /** How many times beginTurn has been called (a fresh turn each time). */
  public beginTurnCalls = 0;
  /** How many times resumeTurn has been called (re-activation, no reset). */
  public resumeTurnCalls = 0;
  /** The turnId of the most recent resumeTurn call, or null if never resumed. */
  public lastResumedTurnId: string | null = null;
  /**
   * Test hook: when true, `resumeTurn` rejects (simulating a dropped transport /
   * STT_DISCONNECTED) so tests can drive the "re-activate failed" resume path.
   */
  public failResume = false;
  /**
   * Test hook: when true, `beginTurn` rejects with STT_DISCONNECTED (the
   * transport dropped between Mira's audio ending and the turn arming) so tests
   * can drive the armed-but-deaf recovery path.
   */
  public failBeginTurn = false;
  /** How many times reconnect() has been called. */
  public reconnectCalls = 0;
  /**
   * Test hook: when true, `reconnect` rejects (the transport cannot be
   * re-established) so tests can drive the RECOVERING → ERROR path. The thrown
   * `STT_DISCONNECTED` is non-retryable, so each reconnect is a single attempt.
   */
  public failReconnect = false;
  /**
   * Test hook: when set, `reconnect` awaits this promise before resolving, so a
   * test can hold the session in RECOVERING (e.g. to drive an END_NOW mid-recover
   * and prove the stale reconnect is discarded).
   */
  public reconnectGate: Promise<void> | null = null;
  /**
   * Words captured for the in-flight turn. `beginTurn` clears it (fresh turn);
   * `resumeTurn` preserves it; `endTurn` returns it when non-empty (mirroring the
   * real accumulator) so tests can prove pre-pause transcript is not dropped.
   */
  private accumulated = '';

  constructor(config: FakeSttConfig = {}) {
    this.transcript = config.transcript ?? 'this is a fake transcript';
    this.finalSegments = config.finalSegments ?? ['this is a fake transcript'];
    this.confidence = config.confidence ?? 0.9;
    this.delayMs = config.delayMs ?? 0;
  }

  async connect(config: SttSessionConfig, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (this.delayMs > 0) await delay(this.delayMs, signal);
    throwIfAborted(signal);
    this.lastConfig = config;
    this.connected = true;
  }

  async beginTurn(turnId: string): Promise<void> {
    this.beginTurnCalls += 1;
    if (this.failBeginTurn) {
      // Simulate a transport that dropped before the turn could arm.
      throw new AppError('STT_DISCONNECTED', { message: 'fake beginTurn failed' });
    }
    this.currentTurnId = turnId;
    // A fresh turn discards any previously accumulated transcript.
    this.accumulated = '';
  }

  /**
   * Re-activate the in-flight turn after a pause WITHOUT clearing accumulated
   * state (mirrors {@link beginTurn} minus the reset). Records the call so tests
   * can assert resume happened on the original turn and that beginTurn was not
   * fired a second time.
   */
  async resumeTurn(turnId: string): Promise<void> {
    this.resumeTurnCalls += 1;
    this.lastResumedTurnId = turnId;
    if (this.failResume) {
      // Simulate a dropped transport: the in-flight turn is NOT re-activated.
      throw new Error('STT_DISCONNECTED');
    }
    this.currentTurnId = turnId;
    // Deliberately do NOT touch `accumulated` — pre-pause words are preserved.
  }

  /**
   * Re-establish the (fake) transport. A successful reconnect restores the live
   * stream, so a subsequent {@link resumeTurn} succeeds again (`failResume` is
   * cleared). When `failReconnect` is set it rejects instead, modelling a
   * transport that cannot be brought back.
   */
  async reconnect(signal?: AbortSignal): Promise<void> {
    this.reconnectCalls += 1;
    throwIfAborted(signal);
    if (this.reconnectGate) await this.reconnectGate;
    if (this.delayMs > 0) await delay(this.delayMs, signal);
    throwIfAborted(signal);
    if (this.failReconnect) {
      throw new AppError('STT_DISCONNECTED', { message: 'fake reconnect failed' });
    }
    this.connected = true;
    // The transport is live again: re-activation no longer fails.
    this.failResume = false;
  }

  writeAudio(chunk: AudioChunkPacket): void {
    this.writtenChunks.push(chunk);
  }

  /**
   * Test hook: append a finalized segment to the in-flight turn's accumulated
   * transcript, modelling words captured by the live stream. Not part of the
   * adapter contract.
   */
  pushTranscript(text: string): void {
    const segment = text.trim();
    if (segment.length === 0) return;
    this.accumulated = this.accumulated ? `${this.accumulated} ${segment}`.trim() : segment;
  }

  async endTurn(options: { signal?: AbortSignal; deadlineMs: number }): Promise<SttTurnResult> {
    throwIfAborted(options.signal);
    if (this.delayMs > 0) await delay(this.delayMs, options.signal);
    throwIfAborted(options.signal);
    this.currentTurnId = null;
    return this.result();
  }

  async recoverFromAudio(
    pcm: Uint8Array,
    _config: SttRecoveryConfig,
    signal?: AbortSignal,
  ): Promise<SttTurnResult> {
    throwIfAborted(signal);
    if (this.delayMs > 0) await delay(this.delayMs, signal);
    throwIfAborted(signal);
    // An empty buffer yields an empty result, mirroring the real adapter.
    if (pcm.length === 0) {
      return { text: '', finalSegments: [], confidence: null };
    }
    return this.result();
  }

  async close(): Promise<void> {
    this.connected = false;
    this.closed = true;
    this.listeners.clear();
  }

  on(event: SttEvent, listener: Listener): Unsubscribe {
    let set = this.listeners.get(event);
    if (set === undefined) {
      set = new Set<Listener>();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => {
      this.listeners.get(event)?.delete(listener);
    };
  }

  /**
   * Test hook: synchronously emit `event` to all registered listeners. Not part
   * of the adapter contract — exposed so tests can simulate provider callbacks.
   */
  emit(event: SttEvent, ...args: any[]): void {
    const set = this.listeners.get(event);
    if (set === undefined) return;
    // Snapshot so a listener unsubscribing mid-emit can't disturb iteration.
    for (const listener of [...set]) listener(...args);
  }

  /**
   * Build a fresh copy of the turn result. When the in-flight turn accumulated
   * transcript (via {@link pushTranscript}), that takes precedence — mirroring
   * the real adapter, where endTurn returns what the live stream captured.
   */
  private result(): SttTurnResult {
    if (this.accumulated.length > 0) {
      return {
        text: this.accumulated,
        finalSegments: [this.accumulated],
        confidence: this.confidence,
      };
    }
    return {
      text: this.transcript,
      finalSegments: [...this.finalSegments],
      confidence: this.confidence,
    };
  }
}
