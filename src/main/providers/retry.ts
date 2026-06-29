import { RETRY_POLICY } from '@shared/constants/runtime-defaults';
import { sleep } from '@shared/utils';

/** HTTP statuses that should never be retried regardless of transient list. */
const NON_RETRYABLE_STATUSES = new Set<number>([400, 401, 403, 404, 422]);

/**
 * Error names that signal a deliberate stop or a structural failure. Matched
 * against both `error.name` and `error.constructor.name`: the OpenAI SDK's
 * `APIUserAbortError` leaves `.name` as the inherited `'Error'`, so its identity
 * only shows up on the constructor.
 */
const NON_RETRYABLE_ERROR_NAMES = new Set<string>([
  'AbortError',
  'APIUserAbortError',
  'ZodError',
]);

/** Network-level error codes worth retrying (transient connectivity faults). */
const TRANSIENT_ERROR_CODES = new Set<string>(['ECONNRESET', 'ETIMEDOUT']);

/** True when `status` is one of the configured transient HTTP statuses (spec §19.4). */
export function isTransientStatus(status: number): boolean {
  return RETRY_POLICY.transientHttpStatuses.includes(status as never);
}

/** Read a numeric `.status` off an unknown error-like value, if present. */
function statusOf(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return undefined;
}

/** Read a string `.code` off an unknown error-like value, if present. */
function codeOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** Read a string `.name` off an unknown error-like value, if present. */
function nameOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return undefined;
}

/**
 * Read the constructor name off an unknown error-like value, if present. The
 * OpenAI SDK error classes (`APIConnectionError`, `APIConnectionTimeoutError`,
 * `APIUserAbortError`) never set `.name`, so their identity is only legible on
 * `error.constructor.name`.
 */
function constructorNameOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null) {
    const ctor = (error as { constructor?: unknown }).constructor;
    if (typeof ctor === 'function') {
      const name = (ctor as { name?: unknown }).name;
      if (typeof name === 'string') return name;
    }
  }
  return undefined;
}

/**
 * Read a string `.code` off the `.cause` of an unknown error-like value. The
 * OpenAI SDK wraps socket faults in `APIConnectionError`, whose own `.code` is
 * undefined; the Node errno (`ECONNRESET`, `ETIMEDOUT`) lands on `cause.code`.
 */
function causeCodeOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null) {
    const cause = (error as { cause?: unknown }).cause;
    if (typeof cause === 'object' && cause !== null) {
      const code = (cause as { code?: unknown }).code;
      if (typeof code === 'string') return code;
    }
  }
  return undefined;
}

/**
 * Decide whether `error` is worth retrying (spec §19.4). Only transient faults
 * retry: a transient HTTP status, a connection timeout, or a network-ish
 * connectivity code (read directly or off `error.cause` for SDK-wrapped socket
 * faults). Explicit client-side statuses, aborts, and validation errors never
 * retry.
 */
export function shouldRetry(error: unknown): boolean {
  // Deliberate stops / structural failures, by error name or constructor name.
  const name = nameOf(error);
  if (name !== undefined && NON_RETRYABLE_ERROR_NAMES.has(name)) return false;
  const ctorName = constructorNameOf(error);
  if (ctorName !== undefined && NON_RETRYABLE_ERROR_NAMES.has(ctorName)) return false;

  const status = statusOf(error);
  if (status !== undefined) {
    if (NON_RETRYABLE_STATUSES.has(status)) return false;
    return isTransientStatus(status);
  }

  // A connection timeout carries no status, code, or cause — the SDK's
  // `APIConnectionTimeoutError` is identifiable only by its constructor name.
  if (ctorName === 'APIConnectionTimeoutError') return true;

  // Direct `.code` for plain Node errors; `.cause.code` for SDK-wrapped ones.
  const code = codeOf(error) ?? causeCodeOf(error);
  if (code !== undefined && TRANSIENT_ERROR_CODES.has(code)) return true;

  return false;
}

export interface WithRetryOptions {
  /** Maximum number of attempts (inclusive). Defaults to RETRY_POLICY.maxAttempts. */
  maxAttempts?: number;
  /** Base backoff delay in ms. Defaults to RETRY_POLICY.baseDelayMs. */
  baseDelayMs?: number;
  /** Upper bound on a single backoff delay. Defaults to RETRY_POLICY.maxDelayMs. */
  maxDelayMs?: number;
  /** Apply random jitter to the backoff. Defaults to RETRY_POLICY.jitter. */
  jitter?: boolean;
  /** Random source in [0, 1) for jitter. Defaults to Math.random. */
  rng?: () => number;
  /** Sleeper used between attempts. Defaults to a real timer. Inject in tests. */
  delayFn?: (ms: number) => Promise<void>;
  /** Polled before each retry; when true, abort immediately and rethrow. */
  shouldAbort?: () => boolean;
}

/** Compute the exponential backoff for a given (1-based) attempt, capped and jittered. */
function backoffMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitter: boolean,
  rng: () => number,
): number {
  const raw = baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(raw, maxDelayMs);
  // Full jitter: pick a random delay within [0, capped] to spread retries.
  return jitter ? rng() * capped : capped;
}

/**
 * Run `fn(attempt)` with bounded exponential backoff on retryable errors
 * (spec §19.4). Rethrows immediately on a non-retryable error, after the final
 * attempt, or when `shouldAbort()` reports true.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: WithRetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? RETRY_POLICY.maxAttempts;
  const baseDelayMs = opts.baseDelayMs ?? RETRY_POLICY.baseDelayMs;
  const maxDelayMs = opts.maxDelayMs ?? RETRY_POLICY.maxDelayMs;
  const jitter = opts.jitter ?? RETRY_POLICY.jitter;
  const rng = opts.rng ?? Math.random;
  const delayFn = opts.delayFn ?? sleep;
  const shouldAbort = opts.shouldAbort;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const isLastAttempt = attempt >= maxAttempts;
      if (isLastAttempt || !shouldRetry(error) || shouldAbort?.()) {
        throw error;
      }
      await delayFn(backoffMs(attempt, baseDelayMs, maxDelayMs, jitter, rng));
    }
  }

  // Unreachable in practice: the loop either returns or throws. Rethrow defensively.
  throw lastError;
}
