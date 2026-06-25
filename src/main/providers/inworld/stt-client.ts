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
import { INWORLD_DEFAULTS } from '@shared/constants/runtime-defaults';
import { DeadlineError } from '@shared/utils/deadline';
import { TranscriptAccumulator } from '../../interview/transcript-accumulator';
import { normalizeSttEvent, type NormalizedSttEvent } from './event-normalizer';

/**
 * Injectable streaming transport. The live implementation wraps an Inworld STT
 * WebSocket, but tests supply a fake so the client logic is exercised without a
 * network. `onMessage` delivers raw provider event objects (the kind that
 * {@link normalizeSttEvent} maps).
 */
export interface SttTransport {
  /** Send a PCM s16le audio frame to the provider (the transport handles encoding). */
  send(payload: ArrayBuffer): void;
  /** Close the transport. Idempotent. */
  close(): void;
  /** Subscribe to raw inbound events. Returns an unsubscribe function. */
  onMessage(listener: (raw: unknown) => void): Unsubscribe;
}

/** Factory that opens a transport for a given session configuration. */
export type SttConnectFactory = (
  args: { apiKey: string; model: string; config: SttSessionConfig },
  signal?: AbortSignal,
) => Promise<SttTransport>;

/**
 * Optional fetch implementation used by {@link InworldSttClient.recoverFromAudio}
 * to POST a buffered turn to Inworld's batch STT endpoint when the live stream
 * dropped. Defaults to the global `fetch`.
 */
export type SttFetch = typeof fetch;

export interface InworldSttClientOptions {
  apiKey: string;
  model?: string;
  /** Injectable transport factory (live WebSocket in production, fake in tests). */
  connect: SttConnectFactory;
  /** Base URL for the batch recovery endpoint. */
  recoveryBaseUrl?: string;
  /** Injectable fetch for the recovery path. */
  fetchImpl?: SttFetch;
}

/** Shape the batch recovery endpoint is assumed to return (documented assumption). */
interface RecoveryResponseBody {
  text?: unknown;
  finalSegments?: unknown;
  confidence?: unknown;
}

/**
 * Inworld streaming STT client (spec §13.4).
 *
 * Lifecycle: {@link connect} once per session, then per answer
 * {@link beginTurn} → repeated {@link writeAudio} → {@link endTurn}. The live
 * WebSocket transport is injected via the `connect` factory, so the streaming
 * path stays testable; tests drive a fake transport that replays normalized
 * events. {@link recoverFromAudio} is the fallback batch path used when the live
 * stream is unavailable mid-turn.
 *
 * Normalized events are forwarded to {@link on} listeners and also fold into a
 * {@link TranscriptAccumulator} so {@link endTurn} can resolve with the
 * accumulated transcript.
 */
export class InworldSttClient implements SpeechToTextAdapter {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly connectFactory: SttConnectFactory;
  private readonly recoveryBaseUrl: string;
  private readonly fetchImpl: SttFetch;

  /** Open transport for the current session, or null when disconnected. */
  private transport: SttTransport | null = null;
  /** Unsubscribe handle for the transport's onMessage subscription. */
  private transportUnsub: Unsubscribe | null = null;
  /** The config supplied at connect time, retained for diagnostics. */
  private sessionConfig: SttSessionConfig | null = null;

  /** The config supplied at connect time (diagnostics). */
  getSessionConfig(): SttSessionConfig | null {
    return this.sessionConfig;
  }

  /** Accumulates partial/final transcript for the in-flight turn. */
  private readonly accumulator = new TranscriptAccumulator();
  /** Per-event listeners keyed by event name. */
  private readonly listeners = new Map<SttEvent, Set<(...args: any[]) => void>>();

  /** True between beginTurn and the next endTurn. */
  private turnActive = false;
  /** Resolved by endTurn when a FINAL segment arrives before the deadline. */
  private finalResolve: (() => void) | null = null;

  constructor(options: InworldSttClientOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? INWORLD_DEFAULTS.sttModel;
    this.connectFactory = options.connect;
    this.recoveryBaseUrl = options.recoveryBaseUrl ?? 'https://api.inworld.ai/v1/stt:recognize';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Open the streaming transport for this session. Safe to call once. */
  async connect(config: SttSessionConfig, signal?: AbortSignal): Promise<void> {
    if (this.transport !== null) return;
    this.sessionConfig = config;
    const transport = await this.connectFactory(
      { apiKey: this.apiKey, model: this.model, config },
      signal,
    );
    this.transport = transport;
    this.transportUnsub = transport.onMessage((raw) => this.handleRaw(raw));
  }

  /** Begin a new answer turn, resetting any prior accumulated transcript. */
  async beginTurn(_turnId: string): Promise<void> {
    if (this.transport === null) {
      throw new AppError('STT_DISCONNECTED', { message: 'beginTurn called before connect' });
    }
    this.accumulator.reset();
    this.turnActive = true;
  }

  /** Forward a captured PCM audio chunk to the live transport. */
  writeAudio(chunk: AudioChunkPacket): void {
    if (this.transport === null) {
      throw new AppError('STT_DISCONNECTED', { message: 'writeAudio called before connect' });
    }
    this.transport.send(chunk.payload);
  }

  /**
   * End the current turn. Resolves with the accumulated transcript once a FINAL
   * segment has been observed, or — if the provider goes quiet — when
   * `deadlineMs` elapses, in which case whatever has accumulated so far is
   * returned. Honors an optional abort signal.
   */
  async endTurn(options: { signal?: AbortSignal; deadlineMs: number }): Promise<SttTurnResult> {
    const { signal, deadlineMs } = options;
    if (signal?.aborted) {
      this.turnActive = false;
      throw new DOMException('Aborted', 'AbortError');
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.finalResolve = null;
        resolve();
      };
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.finalResolve = null;
        reject(new DOMException('Aborted', 'AbortError'));
      };
      // Resolve early if a FINAL segment arrives while we wait.
      this.finalResolve = finish;
      // Deadline: resolve with whatever accumulated so far (spec §13.4).
      const timer = setTimeout(finish, deadlineMs);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });

    this.turnActive = false;
    const text = this.accumulator.commit();
    return {
      text,
      finalSegments: [...this.accumulator.finalSegments],
      confidence: null,
    };
  }

  /**
   * Batch-recover a turn by POSTing the full buffered PCM to Inworld's
   * recognize endpoint. Used when the live stream dropped mid-turn (spec §17).
   * @throws AppError STT_FINALIZE_FAILED on a non-OK response.
   */
  async recoverFromAudio(
    pcm: Uint8Array,
    config: SttRecoveryConfig,
    signal?: AbortSignal,
  ): Promise<SttTurnResult> {
    const response = await this.fetchImpl(this.recoveryBaseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        Authorization: `Bearer ${this.apiKey}`,
        'X-Inworld-Model': config.model,
        'X-Inworld-Sample-Rate': String(config.sampleRate),
        'X-Inworld-Channels': String(config.channels),
      },
      // Copy into a standalone ArrayBuffer so we never send a shared/oversized view.
      body: pcm.slice().buffer,
      ...(signal ? { signal } : {}),
    });

    if (!response.ok) {
      throw new AppError('STT_FINALIZE_FAILED', {
        message: `Inworld batch STT failed with status ${response.status}`,
      });
    }

    const body = (await response.json()) as RecoveryResponseBody;
    const finalSegments = Array.isArray(body.finalSegments)
      ? body.finalSegments.filter((s): s is string => typeof s === 'string')
      : [];
    const text = typeof body.text === 'string' ? body.text : finalSegments.join(' ').trim();
    const confidence = typeof body.confidence === 'number' ? body.confidence : null;

    return { text, finalSegments, confidence };
  }

  /** Tear down the transport and clear all turn state. Idempotent. */
  async close(): Promise<void> {
    this.transportUnsub?.();
    this.transportUnsub = null;
    this.transport?.close();
    this.transport = null;
    this.sessionConfig = null;
    this.turnActive = false;
    this.finalResolve = null;
    this.accumulator.reset();
    this.listeners.clear();
  }

  /** Subscribe to a normalized STT event. Returns an unsubscribe function. */
  on(event: SttEvent, listener: (...args: any[]) => void): Unsubscribe {
    let set = this.listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  /** Map a raw transport event, fold it into state, and notify listeners. */
  private handleRaw(raw: unknown): void {
    const event = normalizeSttEvent(raw);
    if (event === null) return;
    this.foldEvent(event);
    this.emit(event);
  }

  /** Update the accumulator from a normalized event and trigger turn finalization. */
  private foldEvent(event: NormalizedSttEvent): void {
    switch (event.kind) {
      case 'partial':
        if (this.turnActive) this.accumulator.setInterim(event.text ?? '');
        break;
      case 'finalSegment':
        if (this.turnActive) {
          this.accumulator.addFinalSegment(event.text ?? '');
          // A FINAL segment lets an in-flight endTurn resolve before its deadline.
          this.finalResolve?.();
        }
        break;
      case 'speechStarted':
      case 'speechStopped':
      case 'error':
        // Pure signaling events: forwarded to listeners, no accumulator change.
        break;
    }
  }

  /** Dispatch a normalized event to subscribers of its kind. */
  private emit(event: NormalizedSttEvent): void {
    const set = this.listeners.get(event.kind);
    if (set === undefined) return;
    const arg = event.kind === 'error' ? (event.message ?? '') : (event.text ?? '');
    for (const listener of set) listener(arg);
  }
}

/** Re-export DeadlineError so callers can branch on STT finalize timeouts. */
export { DeadlineError };
