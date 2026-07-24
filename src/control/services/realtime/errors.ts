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
  /** Provider-requested delay before the next attempt, when supplied. */
  retryAfterMs?: number;
}

/**
 * Structured provider signals that accompany an HTTP status.
 *
 * M4: status alone is not enough. OpenAI returns 429 for BOTH temporary rate
 * limiting (retry) and hard quota exhaustion (never retry — retrying is
 * useless and, worse, keeps a dead session looking alive while it burns the
 * reconnect budget). Only `code`/`type` are consulted; English message prose
 * is never parsed (spec Appendix C.7).
 */
export interface ProviderFailureContext {
  /** Structured provider error code, e.g. `insufficient_quota`. */
  code?: string | null;
  /** Structured provider error type, e.g. `rate_limit_error`. */
  type?: string | null;
  /** Parsed `Retry-After` header, in seconds. */
  retryAfterSeconds?: number | null;
}

function isQuotaCode(code: string, type: string): boolean {
  return (
    code.includes('insufficient_quota') ||
    code.includes('quota_exceeded') ||
    code.includes('billing') ||
    type.includes('insufficient_quota')
  );
}

function isModelAccessCode(code: string, type: string): boolean {
  return (
    code.includes('model_not_found') ||
    code.includes('model_unavailable') ||
    code.includes('unsupported_model') ||
    code.includes('unsupported_country') ||
    type.includes('model')
  );
}

function isInvalidKeyCode(code: string, type: string): boolean {
  return (
    code.includes('invalid_api_key') ||
    code.includes('invalid_authentication') ||
    code.includes('account_deactivated') ||
    type.includes('authentication')
  );
}

/**
 * Map an HTTP status (plus any structured provider code) from the credential
 * mint or SDP handshake to a stable app error code per the E.7 table.
 *
 * Never retry billing errors — E.7 lists "quota/billing" and "429 temporary"
 * as SEPARATE rows precisely because they need opposite behaviour.
 */
export function mapRealtimeHttpStatus(
  status: number,
  context: ProviderFailureContext = {},
): MappedFailure {
  const code = (context.code ?? '').toLowerCase();
  const type = (context.type ?? '').toLowerCase();
  const retryAfterMs =
    typeof context.retryAfterSeconds === 'number' && Number.isFinite(context.retryAfterSeconds)
      ? Math.max(0, Math.round(context.retryAfterSeconds * 1000))
      : undefined;

  if (status === 401) return { code: 'AUTH_KEY_INVALID', recoverable: false };

  if (status === 403) {
    // E.7 keeps "401/invalid auth" and "model permission/access" as distinct
    // rows with distinct remedies. Mapping every 403 to AUTH_KEY_INVALID told
    // users to re-enter a key that was never the problem — the real cause is
    // usually a project without access to the realtime model.
    if (isInvalidKeyCode(code, type)) return { code: 'AUTH_KEY_INVALID', recoverable: false };
    if (isQuotaCode(code, type)) return { code: 'QUOTA_EXHAUSTED', recoverable: false };
    return { code: 'AUTH_MODEL_UNAVAILABLE', recoverable: false };
  }

  if (status === 402) return { code: 'QUOTA_EXHAUSTED', recoverable: false };
  if (status === 404) return { code: 'AUTH_MODEL_UNAVAILABLE', recoverable: false };

  if (status === 429) {
    // Quota exhaustion also arrives as 429. Retrying it cannot succeed.
    if (isQuotaCode(code, type)) return { code: 'QUOTA_EXHAUSTED', recoverable: false };
    return retryAfterMs === undefined
      ? { code: 'RATE_LIMITED', recoverable: true }
      : { code: 'RATE_LIMITED', recoverable: true, retryAfterMs };
  }

  if (status === 408) return { code: 'NETWORK_TIMEOUT', recoverable: true };
  if (status >= 500) return { code: 'PROVIDER_UNAVAILABLE', recoverable: true };
  if (isModelAccessCode(code, type)) return { code: 'AUTH_MODEL_UNAVAILABLE', recoverable: false };
  return { code: 'REALTIME_NEGOTIATION_FAILED', recoverable: true };
}

/**
 * Extract the structured provider signals from an error response.
 *
 * Only well-known JSON fields and the `Retry-After` header are read; the body
 * is never pattern-matched as prose.
 */
export function readProviderFailureContext(
  body: string | null | undefined,
  headers?: { get(name: string): string | null } | null,
): ProviderFailureContext {
  const context: ProviderFailureContext = {};
  const retryAfter = headers?.get('Retry-After') ?? headers?.get('retry-after') ?? null;
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) context.retryAfterSeconds = seconds;
  }
  if (typeof body === 'string' && body.length > 0) {
    try {
      const parsed = JSON.parse(body) as { error?: { code?: unknown; type?: unknown } };
      const error = parsed?.error;
      if (error && typeof error === 'object') {
        if (typeof error.code === 'string') context.code = error.code;
        if (typeof error.type === 'string') context.type = error.type;
      }
    } catch {
      // Not JSON, or truncated: fall back to status-only classification
      // rather than guessing from prose.
    }
  }
  return context;
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
