/**
 * Audio and transport contracts (spec Appendix C.3) — control-window WebRTC /
 * Realtime transcription state machine and device metadata.
 *
 * Additive extensions beyond the original C.3 snippet (documented per the
 * additive-edit policy for this file):
 * - `CommitReason`, `DisconnectReason`, `TransportState`, `Unsubscribe`,
 *   `TransportDiagnostics`, `TranscriptionEvent` — referenced by the
 *   `RealtimeTranscriptionTransport` interface in spec §27.4 but not spelled
 *   out in Appendix C.3.
 * - `TranscriptEvent` — the internal provider-neutral transcript event type
 *   from spec §30.1 (produced by the transport's event adapter, consumed by
 *   the transcript reconciler).
 * - `RealtimeTranscriptionTransport` — the transport abstraction itself
 *   (spec §27.4).
 * - `CommitMeta` — per-commit bookkeeping recorded by the manual commit
 *   driver (spec §29.3, Appendix E.3).
 */
import type { TokenLogprob } from './tracking';

/** Why a manual `input_audio_buffer.commit` was issued (spec §28.4/§29.3). */
export type CommitReason =
  | 'vad_silence'
  | 'max_utterance'
  | 'soft_pause'
  | 'hard_pause'
  | 'stop'
  | 'command_finalization'
  | 'mic_switch'
  | 'mic_disconnect';

/** Why the transport is being torn down (spec §29.6–§29.8). */
export type DisconnectReason =
  | 'stop'
  | 'hard_pause'
  | 'mic_switch'
  | 'credential_expired'
  | 'reconnect'
  | 'sleep'
  | 'idle_timeout'
  | 'error';

/** Coarse connection state of the underlying transport (spec §30.1). */
export type TransportState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'closing'
  | 'failed';

export type Unsubscribe = () => void;

/** Non-sensitive transport health snapshot (spec §27.4/§29.6). */
export interface TransportDiagnostics {
  transportState: TransportState;
  peerConnectionState?: string;
  iceConnectionState?: string;
  dataChannelState?: string;
  lastServerEventAtMs?: number;
  lastCompletedItemAtMs?: number;
  lastCommitAtMs?: number;
  /** Unix epoch **milliseconds** (C1: unit is in the name). */
  credentialExpiresAtEpochMs?: number;
  credentialGeneration?: number;
  sessionGeneration: number;
  reconnectAttempts: number;
  /**
   * Why the last connection ended unexpectedly — "data channel closed", "peer
   * connection failed", and so on.
   *
   * The transport knew this and threw it away: `handleUnexpectedClose` took a
   * `_detail` argument and discarded it, so every distinct way a live take can
   * die arrived at the user as the single sentence "the realtime connection to
   * OpenAI dropped", with nothing behind it. A data channel the service closed
   * and an ICE path that failed are different problems with different fixes,
   * and neither was distinguishable from the other in a bug report.
   */
  lastCloseReason?: string;
}

/**
 * Internal provider-neutral transcript event stream (spec §30.1). Provider
 * events are converted immediately at the transport boundary; nothing above
 * the transport may depend on transport-specific OpenAI event objects.
 */
export type TranscriptEvent =
  | { type: 'item_started'; itemId: string; commitSequence: number }
  | { type: 'delta'; itemId: string; text: string; receivedAtMs: number }
  | { type: 'completed'; itemId: string; text: string; logprobs?: TokenLogprob[] }
  /**
   * `detail` is a short, text-free reason for triage — "data channel closed",
   * "peer connection failed". One code covers several unrelated situations
   * (a channel the service closed, an ICE path that failed, an input with no
   * sender), and without this they are indistinguishable in a bug report:
   * every one of them arrives as the same sentence about the connection
   * dropping. Never provider prose, so it can never quote speech.
   */
  | { type: 'failed'; itemId?: string; code: string; recoverable: boolean; detail?: string }
  | { type: 'transport_state'; state: TransportState }
  /**
   * H5: the local audio input recovered (track unmuted / device restored).
   * Paired with a session-level `failed` carrying MIC_DEVICE_LOST or
   * MIC_NO_SIGNAL, this lets the controller release a following hold without
   * a full reconnect when the input simply came back.
   */
  | { type: 'input_restored' };

/** Alias used by the §27.4 transport interface signature. */
export type TranscriptionEvent = TranscriptEvent;

/** Frontend-facing transport abstraction (spec §27.4). */
export interface RealtimeTranscriptionTransport {
  connect(config: TranscriptionConfig): Promise<void>;
  setMicrophone(deviceId: string): Promise<void>;
  /**
   * M1: returns whether the commit was actually enqueued on the data channel.
   * A silent no-op on a closing channel left a phantom entry in the commit
   * FIFO, permanently mis-associating later provider items with the wrong
   * commit metadata.
   */
  commit(reason: CommitReason): boolean;
  clearBufferedAudio(): boolean;
  disconnect(reason: DisconnectReason): Promise<void>;
  onEvent(handler: (event: TranscriptionEvent) => void): Unsubscribe;
  getDiagnostics(): TransportDiagnostics;
}

/**
 * Local bookkeeping recorded when a manual commit is sent (spec §29.3).
 * Completion events can arrive out of order; chronological application must
 * use `commitSequence`, never arrival order.
 */
export interface CommitMeta {
  commitSequence: number;
  sessionGeneration: number;
  reason: CommitReason;
  speechStartMs: number;
  speechEndMs: number;
  alignmentAnchor?: number;
  likelyCommand?: boolean;
  itemId?: string;
}

export type RealtimeState =
  | 'idle'
  | 'requesting_permission'
  | 'opening_microphone'
  | 'minting_credential'
  | 'negotiating'
  | 'ready'
  | 'listening'
  | 'soft_paused'
  | 'reconnecting'
  | 'stopping'
  | 'recoverable_error'
  | 'fatal_error';

export interface AudioDeviceInfo {
  deviceId: string;
  groupId?: string;
  label: string;
  isDefault: boolean;
  available: boolean;
}

export interface AudioLevelSnapshot {
  rms: number;
  peak: number;
  noiseFloor: number;
  speaking: boolean;
  clipped: boolean;
  signalPresent: boolean;
  generatedAtMs: number;
}

export interface TranscriptionConfig {
  model: string;
  language?: string;
  delay: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  requestLogprobs: boolean;
}

/**
 * Short-lived OpenAI client secret minted in Rust for the webview's WebRTC
 * connection. The stored permanent key never crosses back into JavaScript.
 */
export interface EphemeralCredential {
  value: string;
  /**
   * Unix epoch **milliseconds**, directly comparable with `Date.now()`.
   *
   * C1: the provider reports epoch seconds. Rust normalizes at the IPC
   * boundary (`openai::normalize_expiry_to_epoch_ms`) and the unit lives in
   * the field name, because the seconds/milliseconds mix-up silently rejected
   * every freshly minted credential and killed transcription entirely.
   */
  expiresAtEpochMs: number;
  sessionType: 'transcription';
  credentialGeneration: number;
}
