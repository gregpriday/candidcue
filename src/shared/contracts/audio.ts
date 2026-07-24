/**
 * Audio and transport contracts (spec Appendix C.3) — control-window WebRTC /
 * Realtime transcription state machine and device metadata.
 */

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
  expiresAt: number;
  sessionType: 'transcription';
  credentialGeneration: number;
}
