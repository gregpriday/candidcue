/**
 * Primary Realtime transport: browser WebRTC in the control window
 * (spec §27.3, Appendix E.2).
 *
 * All platform surfaces (peer connection, fetch, Tauri invoke, microphone
 * acquisition, timers) are injected so the transport is unit-testable with
 * fakes. Raw OpenAI events never leave this module — the adapter converts
 * them to `TranscriptEvent`s at the boundary (spec §27.4/§30.1).
 */
import type {
  CommitReason,
  DisconnectReason,
  EphemeralCredential,
  RealtimeTranscriptionTransport,
  TranscriptEvent,
  TranscriptionConfig,
  TransportDiagnostics,
  TransportState,
  Unsubscribe,
} from '../../../shared/contracts';
import type { Clock, MediaStreamLike, MediaStreamTrackLike } from '../audio/types';
import { releaseStream } from '../audio/permissions';
import { CommitLedger } from './commitLedger';
import { mintTranscriptionCredential, type TauriInvoke } from './credentials';
import { TranscriptEventAdapter } from './eventAdapter';
import { mapRealtimeHttpStatus, RealtimeTransportError } from './errors';
import { buildSessionUpdateEvent, type TranscriptionSessionOptions } from './sessionConfig';

export const OPENAI_REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
export const DEFAULT_DATA_CHANNEL_OPEN_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Thin structural WebRTC interfaces (injected; matched by the real DOM types)
// ---------------------------------------------------------------------------

export interface RtcDataChannelLike {
  readonly readyState: 'connecting' | 'open' | 'closing' | 'closed';
  send(data: string): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface RtcSenderLike {
  track: { stop(): void } | null;
  replaceTrack(track: unknown): Promise<void>;
}

export interface RtcPeerConnectionLike {
  readonly connectionState?: string;
  readonly iceConnectionState?: string;
  createDataChannel(label: string): RtcDataChannelLike;
  addTrack(track: unknown, stream: unknown): unknown;
  getSenders(): RtcSenderLike[];
  createOffer(): Promise<{ type: string; sdp?: string }>;
  setLocalDescription(description: unknown): Promise<void>;
  setRemoteDescription(description: { type: string; sdp: string }): Promise<void>;
  close(): void;
  onconnectionstatechange: (() => void) | null;
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<FetchResponseLike>;

export interface TransportTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface WebRtcTransportDeps {
  /** Tauri invoke used to mint the short-lived client secret (§46.4). */
  invoke: TauriInvoke;
  /** Open the selected microphone (audio package provides this). */
  acquireMicrophone: (deviceId?: string) => Promise<MediaStreamLike>;
  fetchFn?: FetchLike;
  createPeerConnection?: () => RtcPeerConnectionLike;
  ledger?: CommitLedger;
  now?: Clock;
  callsUrl?: string;
  /** Vocabulary prompt injection point (spec §27.5). Read at connect time. */
  getVocabularyPrompt?: () => string | undefined;
  sessionOptions?: Omit<TranscriptionSessionOptions, 'vocabularyPrompt'>;
  dataChannelOpenTimeoutMs?: number;
  timers?: TransportTimers;
  /**
   * Optional connect-progress callback so the session controller can mirror
   * the §29.1 sub-states (opening_microphone → minting_credential →
   * negotiating) without depending on transport internals.
   */
  onConnectProgress?: (phase: ConnectPhase) => void;
}

export type ConnectPhase = 'opening_microphone' | 'minting_credential' | 'negotiating';

interface ActiveConnection {
  pc: RtcPeerConnectionLike;
  dc: RtcDataChannelLike;
  stream: MediaStreamLike;
  credentialExpiresAt: number;
  credentialGeneration: number;
}

export class WebRtcTranscriptionTransport implements RealtimeTranscriptionTransport {
  readonly ledger: CommitLedger;

  private readonly adapter: TranscriptEventAdapter;
  private readonly now: Clock;
  private readonly fetchFn: FetchLike;
  private readonly createPc: () => RtcPeerConnectionLike;
  private readonly timers: TransportTimers;
  private readonly callsUrl: string;
  private readonly openTimeoutMs: number;

  private readonly handlers = new Set<(event: TranscriptEvent) => void>();
  private state: TransportState = 'disconnected';
  private connection: ActiveConnection | null = null;
  private preferredDeviceId: string | undefined;
  private lastServerEventAtMs: number | undefined;
  private lastCompletedItemAtMs: number | undefined;
  private lastCommitAtMs: number | undefined;
  private reconnectAttempts = 0;
  private closingIntentionally = false;

  constructor(private readonly deps: WebRtcTransportDeps) {
    this.ledger = deps.ledger ?? new CommitLedger();
    this.now = deps.now ?? (() => Date.now());
    this.adapter = new TranscriptEventAdapter({ ledger: this.ledger, now: this.now });
    this.fetchFn =
      deps.fetchFn ?? ((url, init) => fetch(url, init) as unknown as Promise<FetchResponseLike>);
    this.createPc =
      deps.createPeerConnection ??
      (() => new RTCPeerConnection() as unknown as RtcPeerConnectionLike);
    this.timers = deps.timers ?? {
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (h) => clearTimeout(h as Parameters<typeof clearTimeout>[0]),
    };
    this.callsUrl = deps.callsUrl ?? OPENAI_REALTIME_CALLS_URL;
    this.openTimeoutMs = deps.dataChannelOpenTimeoutMs ?? DEFAULT_DATA_CHANNEL_OPEN_TIMEOUT_MS;
  }

  // -- RealtimeTranscriptionTransport -------------------------------------

  async connect(config: TranscriptionConfig): Promise<void> {
    if (this.connection) {
      throw new RealtimeTransportError(
        'REALTIME_NEGOTIATION_FAILED',
        'Transport is already connected',
        true,
      );
    }
    this.setState('connecting');

    let credential: EphemeralCredential | null = null;
    let stream: MediaStreamLike | null = null;
    let pc: RtcPeerConnectionLike | null = null;
    try {
      // 1. Open the microphone and verify an active track (§29.2 step 4).
      this.deps.onConnectProgress?.('opening_microphone');
      stream = await this.deps.acquireMicrophone(this.preferredDeviceId);
      const track = stream.getAudioTracks()[0];
      if (!track || track.readyState !== 'live') {
        throw new RealtimeTransportError('MIC_DEVICE_MISSING', 'No live audio track', true);
      }

      // 2. Mint a fresh short-lived client secret in Rust (§29.2 step 5).
      this.deps.onConnectProgress?.('minting_credential');
      credential = await mintTranscriptionCredential(this.deps.invoke, config, this.now);

      // 3. Peer connection + data channel (Appendix E.2).
      this.deps.onConnectProgress?.('negotiating');
      pc = this.createPc();
      const dc = pc.createDataChannel('oai-events');
      pc.addTrack(track, stream);
      dc.onmessage = (event) => this.handleServerMessage(event.data);

      // 4. SDP offer/answer via the calls endpoint, ephemeral bearer only.
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const response = await this.fetchFn(this.callsUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential.value}`,
          'Content-Type': 'application/sdp',
        },
        body: offer.sdp ?? '',
      });
      if (!response.ok) {
        const mapped = mapRealtimeHttpStatus(response.status);
        throw new RealtimeTransportError(
          mapped.code,
          `Realtime SDP handshake failed (${response.status})`,
          mapped.recoverable,
          response.status,
        );
      }
      await pc.setRemoteDescription({ type: 'answer', sdp: await response.text() });

      // 5. Wait for the events channel, then send/verify session config.
      await this.waitForDataChannelOpen(dc);
      this.ledger.beginSessionGeneration();
      const sessionUpdate = buildSessionUpdateEvent(config, {
        ...this.deps.sessionOptions,
        vocabularyPrompt: this.deps.getVocabularyPrompt?.(),
      });
      dc.send(JSON.stringify(sessionUpdate));

      this.connection = {
        pc,
        dc,
        stream,
        credentialExpiresAt: credential.expiresAt,
        credentialGeneration: credential.credentialGeneration,
      };
      // Ephemeral secret is single-use for the handshake; drop the reference.
      credential = null;
      this.closingIntentionally = false;
      pc.onconnectionstatechange = () => this.handleConnectionStateChange();
      dc.onclose = () => this.handleUnexpectedClose('data channel closed');
      this.setState('connected');
    } catch (error) {
      credential = null;
      if (pc) safeClose(pc);
      releaseStream(stream);
      this.connection = null;
      this.setState('failed');
      throw error instanceof RealtimeTransportError
        ? error
        : new RealtimeTransportError(
            'REALTIME_NEGOTIATION_FAILED',
            error instanceof Error ? error.message : 'Realtime negotiation failed',
            true,
          );
    }
  }

  /**
   * Switch microphone. Mid-session this replaces the sender track without a
   * renegotiation; the caller is responsible for committing buffered speech
   * first (spec §28.2/§29.3 — commit before switch).
   */
  async setMicrophone(deviceId: string): Promise<void> {
    this.preferredDeviceId = deviceId || undefined;
    if (!this.connection) return; // applies on next connect

    const newStream = await this.deps.acquireMicrophone(this.preferredDeviceId);
    const newTrack = newStream.getAudioTracks()[0];
    if (!newTrack || newTrack.readyState !== 'live') {
      releaseStream(newStream);
      throw new RealtimeTransportError('MIC_DEVICE_MISSING', 'No live audio track', true);
    }
    const sender = this.connection.pc.getSenders().find((s) => s.track !== null);
    if (!sender) {
      releaseStream(newStream);
      throw new RealtimeTransportError('REALTIME_CONNECTION_LOST', 'No audio sender', true);
    }
    await sender.replaceTrack(newTrack as unknown as MediaStreamTrackLike);
    releaseStream(this.connection.stream);
    this.connection.stream = newStream;
  }

  /** Manual commit (Appendix E.3). Never sent before the channel is open. */
  commit(_reason: CommitReason): void {
    const dc = this.connection?.dc;
    if (!dc || dc.readyState !== 'open') return;
    dc.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    this.lastCommitAtMs = this.now();
  }

  clearBufferedAudio(): void {
    const dc = this.connection?.dc;
    if (!dc || dc.readyState !== 'open') return;
    dc.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
  }

  async disconnect(_reason: DisconnectReason): Promise<void> {
    const connection = this.connection;
    if (!connection) {
      this.setState('disconnected');
      return;
    }
    this.closingIntentionally = true;
    this.setState('closing');
    this.connection = null;
    connection.pc.onconnectionstatechange = null;
    connection.dc.onclose = null;
    connection.dc.onmessage = null;
    try {
      connection.dc.close();
    } catch {
      // already closed
    }
    safeClose(connection.pc);
    // Stop tracks and clear references (spec §28.7 / §29.7).
    releaseStream(connection.stream);
    this.setState('disconnected');
  }

  onEvent(handler: (event: TranscriptEvent) => void): Unsubscribe {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  getDiagnostics(): TransportDiagnostics {
    return {
      transportState: this.state,
      peerConnectionState: this.connection?.pc.connectionState,
      iceConnectionState: this.connection?.pc.iceConnectionState,
      dataChannelState: this.connection?.dc.readyState,
      lastServerEventAtMs: this.lastServerEventAtMs,
      lastCompletedItemAtMs: this.lastCompletedItemAtMs,
      lastCommitAtMs: this.lastCommitAtMs,
      credentialExpiresAt: this.connection?.credentialExpiresAt,
      credentialGeneration: this.connection?.credentialGeneration,
      sessionGeneration: this.ledger.getSessionGeneration(),
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  // -- helpers -------------------------------------------------------------

  /** Redacted developer diagnostics from the adapter (spec §30.1). */
  getAdapterDiagnostics(): ReadonlyArray<Record<string, unknown>> {
    return this.adapter.getDiagnosticEvents();
  }

  noteReconnectAttempt(): void {
    this.reconnectAttempts += 1;
  }

  resetReconnectAttempts(): void {
    this.reconnectAttempts = 0;
  }

  private handleServerMessage(data: unknown): void {
    this.lastServerEventAtMs = this.now();
    const event = this.adapter.adapt(data);
    if (!event) return;
    if (event.type === 'completed') this.lastCompletedItemAtMs = this.now();
    this.emit(event);
  }

  private handleConnectionStateChange(): void {
    const state = this.connection?.pc.connectionState;
    if (!state || this.closingIntentionally) return;
    if (state === 'failed' || state === 'disconnected' || state === 'closed') {
      this.handleUnexpectedClose(`peer connection ${state}`);
    }
  }

  private handleUnexpectedClose(_detail: string): void {
    if (this.closingIntentionally || !this.connection) return;
    this.setState('failed');
    this.emit({ type: 'failed', code: 'REALTIME_CONNECTION_LOST', recoverable: true });
  }

  private waitForDataChannelOpen(dc: RtcDataChannelLike): Promise<void> {
    if (dc.readyState === 'open') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = this.timers.setTimeout(() => {
        dc.onopen = null;
        dc.onerror = null;
        reject(
          new RealtimeTransportError(
            'REALTIME_NEGOTIATION_FAILED',
            'Data channel did not open in time',
            true,
          ),
        );
      }, this.openTimeoutMs);
      dc.onopen = () => {
        this.timers.clearTimeout(timeout);
        dc.onopen = null;
        dc.onerror = null;
        resolve();
      };
      dc.onerror = () => {
        this.timers.clearTimeout(timeout);
        dc.onopen = null;
        dc.onerror = null;
        reject(
          new RealtimeTransportError(
            'REALTIME_NEGOTIATION_FAILED',
            'Data channel error before open',
            true,
          ),
        );
      };
    });
  }

  private setState(state: TransportState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit({ type: 'transport_state', state });
  }

  private emit(event: TranscriptEvent): void {
    for (const handler of this.handlers) handler(event);
  }
}

function safeClose(pc: RtcPeerConnectionLike): void {
  try {
    pc.close();
  } catch {
    // already closed
  }
}
