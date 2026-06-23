import type {
  SpeechToTextAdapter,
  SttSessionConfig,
  AudioChunkPacket,
  SttTurnResult,
  SttRecoveryConfig,
  SttEvent,
  Unsubscribe,
} from '@shared/contracts/adapters';

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
    this.currentTurnId = turnId;
  }

  writeAudio(chunk: AudioChunkPacket): void {
    this.writtenChunks.push(chunk);
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

  /** Build a fresh copy of the configured turn result. */
  private result(): SttTurnResult {
    return {
      text: this.transcript,
      finalSegments: [...this.finalSegments],
      confidence: this.confidence,
    };
  }
}
