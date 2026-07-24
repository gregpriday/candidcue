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

export interface OpenAiKeyStatus {
  present: boolean;
  lastFour?: string;
  state: 'connected' | 'invalid' | 'rate_limited' | 'network_unavailable' | 'unknown';
  lastValidatedAt?: string;
}
