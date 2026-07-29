/**
 * xAI key command payloads (spec §46.4). The key never returns to
 * JavaScript — only redacted status metadata crosses the boundary, and the
 * transcription socket that uses it is held entirely in Rust.
 */

export interface KeyValidationResult {
  status: 'valid' | 'invalid' | 'quota' | 'network';
  /** The provider's own explanation, when it gave one. Never contains a key. */
  message?: string;
}

/**
 * Which store the key in play came from. A packaged build only ever reports
 * `keychain` or `none`; `environment` means a debug build picked up
 * `GROK_API_KEY`, which takes precedence over anything stored.
 */
export type SttKeySource = 'environment' | 'keychain' | 'none';

export interface SttKeyStatus {
  present: boolean;
  lastFour?: string;
  state: 'connected' | 'invalid' | 'rate_limited' | 'network_unavailable' | 'unknown';
  source: SttKeySource;
  lastValidatedAt?: string;
}
