/**
 * Audio contracts (spec Appendix C.3) — device metadata, level snapshots, and
 * the state the Preflight/Live screens show for the transcription connection.
 *
 * The WebRTC transport types that used to live here are gone with the provider
 * that needed them: `CommitReason`, `DisconnectReason`, `TransportDiagnostics`,
 * `CommitMeta`, `EphemeralCredential` and `RealtimeTranscriptionTransport` all
 * described a client that decided its own turn boundaries and minted its own
 * short-lived credentials. The recogniser endpoints itself and is held
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

/**
 * Whether the OS allows this application the microphone (#303), as
 * `get_microphone_permission` reports it — read, never asked.
 *
 * `prompt` means never asked, which is the only state in which the OS will
 * show its prompt. `restricted` is managed by policy rather than chosen by the
 * user. `unsupported` is "this platform cannot say" and is neither answer.
 */
export type MicrophonePermission = 'granted' | 'denied' | 'restricted' | 'prompt' | 'unsupported';

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
/**
 * The recogniser this build ships.
 *
 * Mirrors `crate::speech::MODEL_NAME`, which is itself asserted equal to
 * `src-tauri/models/catalogue.json`. Rust re-derives the real value on every
 * settings read, so a stale copy here is corrected before a take — but this is
 * also what the browser mock and the offline fallback show, and nothing
 * corrects those. A Rust test `include_str!`s this file to keep the two
 * honest, so keep the literal grep-able.
 */
export const BUNDLED_MODEL_NAME = 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05';

export interface TranscriptionConfig {
  /** The bundled recogniser's name — see {@link BUNDLED_MODEL_NAME}. */
  model: string;
  /** BCP-47 tag, e.g. `en-US`. */
  language?: string;
}

