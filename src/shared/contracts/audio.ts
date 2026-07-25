/**
 * Audio contracts (spec Appendix C.3) — device metadata, level snapshots, and
 * the state the Preflight/Live screens show for the transcription connection.
 *
 * The WebRTC transport types that used to live here are gone with the provider
 * that needed them: `CommitReason`, `DisconnectReason`, `TransportDiagnostics`,
 * `CommitMeta`, `EphemeralCredential` and `RealtimeTranscriptionTransport` all
 * described a client that decided its own turn boundaries and minted its own
 * short-lived credentials. Inworld endpoints server-side and its socket is held
 * in Rust, so none of that has a caller — and a transport abstraction with no
 * implementation is exactly the kind of thing that gets reimplemented against
 * by mistake.
 */
export type Unsubscribe = () => void;

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

/**
 * What a take asks the recogniser for.
 *
 * Two fields, both of which the provider actually reads. The retired shape also
 * carried `delay` and `requestLogprobs`: the first was a latency knob the
 * chosen model rejected outright, and the second bought per-token confidences
 * that only fed the semantic filter. Neither has a consumer now.
 */
export interface TranscriptionConfig {
  /** Inworld model id, e.g. `inworld/inworld-stt-1`. */
  model: string;
  /** BCP-47 tag, e.g. `en-US`. */
  language?: string;
}

