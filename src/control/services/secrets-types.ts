/**
 * OpenAI key command payloads (spec §46.4). The permanent key never returns
 * to JavaScript — only redacted status metadata crosses the boundary.
 */

export interface KeyValidationResult {
  status: 'valid' | 'partial' | 'invalid' | 'quota' | 'network';
  /** When partial: which capability failed, for F.2 copy interpolation. */
  missing?: string;
  models?: { realtime: boolean; command: boolean };
}

/**
 * Which store the key in play came from. A packaged build only ever reports
 * `keychain` or `none`; `environment` means a debug build picked up
 * `OPENAI_API_KEY`, which takes precedence over anything stored.
 */
export type OpenAiKeySource = 'environment' | 'keychain' | 'none';

export interface OpenAiKeyStatus {
  present: boolean;
  lastFour?: string;
  state: 'connected' | 'invalid' | 'rate_limited' | 'network_unavailable' | 'unknown';
  source: OpenAiKeySource;
  lastValidatedAt?: string;
}
