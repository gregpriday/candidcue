/**
 * Audio contracts — device metadata, level snapshots, and the state of the
 * transcription session the control window shows.
 *
 * There is no transport type here, on purpose. The recogniser runs on-device,
 * endpoints itself and is held in Rust; audio reaches it over IPC. A client-side
 * transport abstraction would have no implementation, and one with no
 * implementation is exactly the kind of thing that gets reimplemented against
 * by mistake.
 *
 * `RealtimeState` still names `minting_credential` and `negotiating`, states of
 * a hosted connection the app no longer makes. Nothing mints a credential: the
 * live path reports `minting_credential` as its "starting" state while it opens
 * the microphone and the recogniser.
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
  /**
   * The webview withheld this input's id or name, and `label` is a placeholder.
   * It does so until the page has opened a microphone itself — see
   * `inputsWithheld`.
   */
  withheld?: boolean;
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

