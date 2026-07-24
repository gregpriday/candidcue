/**
 * Realtime transport failure mapping (spec Appendix E.7, §35.4).
 */
import type { AppErrorCode } from '../../../shared/contracts';

export class RealtimeTransportError extends Error {
  constructor(
    readonly code: AppErrorCode,
    message: string,
    readonly recoverable: boolean,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'RealtimeTransportError';
  }
}

export class NotImplementedError extends Error {
  constructor(feature: string) {
    super(`Not implemented: ${feature}`);
    this.name = 'NotImplementedError';
  }
}

export interface MappedFailure {
  code: AppErrorCode;
  recoverable: boolean;
}

/**
 * Map an HTTP status from the credential mint or SDP handshake to a stable
 * app error code per the E.7 table. Never retry billing errors.
 */
export function mapRealtimeHttpStatus(status: number): MappedFailure {
  if (status === 401 || status === 403) return { code: 'AUTH_KEY_INVALID', recoverable: false };
  if (status === 402) return { code: 'QUOTA_EXHAUSTED', recoverable: false };
  if (status === 404) return { code: 'AUTH_MODEL_UNAVAILABLE', recoverable: false };
  if (status === 429) return { code: 'RATE_LIMITED', recoverable: true };
  if (status === 408) return { code: 'NETWORK_TIMEOUT', recoverable: true };
  if (status >= 500) return { code: 'PROVIDER_UNAVAILABLE', recoverable: true };
  return { code: 'REALTIME_NEGOTIATION_FAILED', recoverable: true };
}

/**
 * Map an OpenAI Realtime `error` server event payload to a stable code.
 * Classification is by provider error code/type, never by English message
 * text (spec Appendix C.7 note).
 */
export function mapProviderErrorEvent(event: {
  code?: string | null;
  type?: string | null;
}): MappedFailure {
  const code = (event.code ?? '').toLowerCase();
  const type = (event.type ?? '').toLowerCase();
  if (code.includes('invalid_api_key') || code.includes('invalid_authentication') || type === 'invalid_request_error' && code.includes('auth')) {
    return { code: 'AUTH_KEY_INVALID', recoverable: false };
  }
  if (code.includes('insufficient_quota') || code.includes('billing')) {
    return { code: 'QUOTA_EXHAUSTED', recoverable: false };
  }
  if (code.includes('rate_limit') || type === 'rate_limit_error') {
    return { code: 'RATE_LIMITED', recoverable: true };
  }
  if (code.includes('model_not_found') || code.includes('model_unavailable')) {
    return { code: 'AUTH_MODEL_UNAVAILABLE', recoverable: false };
  }
  if (code.includes('session_expired') || code.includes('token_expired')) {
    // Expired client secret: mint fresh and reconnect (E.7).
    return { code: 'REALTIME_CONNECTION_LOST', recoverable: true };
  }
  if (type === 'server_error') return { code: 'PROVIDER_UNAVAILABLE', recoverable: true };
  return { code: 'PROVIDER_UNAVAILABLE', recoverable: true };
}
