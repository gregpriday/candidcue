import {
  APIConnectionError as SDKAPIConnectionError,
  APIConnectionTimeoutError as SDKAPIConnectionTimeoutError,
  APIUserAbortError as SDKAPIUserAbortError,
} from 'openai';

import { isTransientStatus, shouldRetry, withRetry } from '@main/providers/retry';
import { RETRY_POLICY } from '@shared/constants/runtime-defaults';

/** No-op delay so tests never actually sleep. */
const noDelay = async (): Promise<void> => {};

/** Build a plain error object carrying an HTTP-style `.status`. */
function statusError(status: number): Error & { status: number } {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

/** Build a plain error object carrying a network-style `.code`. */
function codeError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

// Minimal stand-ins for the OpenAI SDK error classes. Like the real ones, they
// leave `.name` as the inherited 'Error' and expose their identity only via the
// constructor name; `APIConnectionError` carries the Node errno on `.cause`.
class APIConnectionError extends Error {
  cause?: { code: string };
  constructor(cause?: { code: string }) {
    super('Connection error.');
    if (cause) this.cause = cause;
  }
}

class APIConnectionTimeoutError extends APIConnectionError {
  constructor() {
    super();
    this.message = 'Request timed out.';
  }
}

class APIUserAbortError extends Error {
  constructor() {
    super('Request was aborted.');
  }
}

describe('isTransientStatus', () => {
  it('returns true for every configured transient status', () => {
    for (const status of RETRY_POLICY.transientHttpStatuses) {
      expect(isTransientStatus(status)).toBe(true);
    }
  });

  it('returns false for non-transient statuses', () => {
    for (const status of [200, 201, 301, 400, 401, 403, 404, 422]) {
      expect(isTransientStatus(status)).toBe(false);
    }
  });
});

describe('shouldRetry', () => {
  it('retries transient HTTP statuses', () => {
    expect(shouldRetry(statusError(429))).toBe(true);
    expect(shouldRetry(statusError(500))).toBe(true);
    expect(shouldRetry(statusError(503))).toBe(true);
  });

  it('retries transient network codes', () => {
    expect(shouldRetry(codeError('ECONNRESET'))).toBe(true);
    expect(shouldRetry(codeError('ETIMEDOUT'))).toBe(true);
  });

  it('does not retry explicit client-side statuses', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(shouldRetry(statusError(status))).toBe(false);
    }
  });

  it('does not retry an AbortError', () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(shouldRetry(err)).toBe(false);
  });

  it('does not retry a ZodError', () => {
    const err = Object.assign(new Error('invalid'), { name: 'ZodError' });
    expect(shouldRetry(err)).toBe(false);
  });

  it('treats an AbortError with a transient code as non-retryable (name wins)', () => {
    const err = Object.assign(new Error('aborted'), {
      name: 'AbortError',
      code: 'ECONNRESET',
    });
    expect(shouldRetry(err)).toBe(false);
  });

  it('does not retry unknown errors with no status or code', () => {
    expect(shouldRetry(new Error('boom'))).toBe(false);
    expect(shouldRetry('a string')).toBe(false);
    expect(shouldRetry(null)).toBe(false);
    expect(shouldRetry(undefined)).toBe(false);
    expect(shouldRetry(codeError('ENOTFOUND'))).toBe(false);
  });

  it('retries an SDK APIConnectionError whose cause carries a transient code', () => {
    expect(shouldRetry(new APIConnectionError({ code: 'ECONNRESET' }))).toBe(true);
    expect(shouldRetry(new APIConnectionError({ code: 'ETIMEDOUT' }))).toBe(true);
  });

  it('does not retry an APIConnectionError whose cause code is non-transient', () => {
    expect(shouldRetry(new APIConnectionError({ code: 'ENOTFOUND' }))).toBe(false);
  });

  it('does not retry a bare APIConnectionError with no cause', () => {
    expect(shouldRetry(new APIConnectionError())).toBe(false);
  });

  it('retries an APIConnectionTimeoutError by constructor name', () => {
    expect(shouldRetry(new APIConnectionTimeoutError())).toBe(true);
  });

  it('does not retry an APIUserAbortError (matched by constructor name)', () => {
    expect(shouldRetry(new APIUserAbortError())).toBe(false);
  });

  it('treats an APIUserAbortError as non-retryable even with a transient cause', () => {
    const err = Object.assign(new APIUserAbortError(), { cause: { code: 'ECONNRESET' } });
    expect(shouldRetry(err)).toBe(false);
  });

  it('lets a non-retryable status win over a transient cause code', () => {
    const err = Object.assign(new Error('HTTP 401'), {
      status: 401,
      cause: { code: 'ECONNRESET' },
    });
    expect(shouldRetry(err)).toBe(false);
  });
});

// Guards the duck-typed helpers against drift in the real OpenAI SDK error
// shapes — the entire fix hinges on `.cause.code` and `constructor.name`.
describe('shouldRetry with real OpenAI SDK errors', () => {
  it('retries a real APIConnectionError carrying a transient cause', () => {
    const cause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    expect(shouldRetry(new SDKAPIConnectionError({ message: 'Connection error.', cause }))).toBe(
      true,
    );
  });

  it('retries a real APIConnectionTimeoutError', () => {
    expect(shouldRetry(new SDKAPIConnectionTimeoutError())).toBe(true);
  });

  it('does not retry a real APIUserAbortError', () => {
    expect(shouldRetry(new SDKAPIUserAbortError())).toBe(false);
  });
});

describe('withRetry', () => {
  it('returns immediately when the function succeeds first try', async () => {
    const fn = vi.fn(async () => 'ok');
    const result = await withRetry(fn, { delayFn: noDelay });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('succeeds after one transient failure', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw statusError(503);
      return 'recovered';
    });
    const result = await withRetry(fn, { maxAttempts: 3, delayFn: noDelay });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries an SDK APIConnectionError (dropped connection) then succeeds', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new APIConnectionError({ code: 'ECONNRESET' });
      return 'recovered';
    });
    const result = await withRetry(fn, { maxAttempts: 3, delayFn: noDelay });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries an APIConnectionTimeoutError then succeeds', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new APIConnectionTimeoutError();
      return 'recovered';
    });
    const result = await withRetry(fn, { maxAttempts: 3, delayFn: noDelay });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('passes the 1-based attempt number to the function', async () => {
    const attempts: number[] = [];
    let calls = 0;
    await withRetry(
      async (attempt) => {
        attempts.push(attempt);
        calls += 1;
        if (calls < 3) throw statusError(500);
        return 'done';
      },
      { maxAttempts: 3, delayFn: noDelay },
    );
    expect(attempts).toEqual([1, 2, 3]);
  });

  it('does not retry a 401 and rethrows immediately', async () => {
    const fn = vi.fn(async () => {
      throw statusError(401);
    });
    await expect(withRetry(fn, { maxAttempts: 5, delayFn: noDelay })).rejects.toMatchObject({
      status: 401,
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('stops after maxAttempts and rethrows the last error', async () => {
    const fn = vi.fn(async () => {
      throw statusError(500);
    });
    await expect(withRetry(fn, { maxAttempts: 3, delayFn: noDelay })).rejects.toMatchObject({
      status: 500,
    });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('defaults maxAttempts to RETRY_POLICY.maxAttempts', async () => {
    const fn = vi.fn(async () => {
      throw statusError(502);
    });
    await expect(withRetry(fn, { delayFn: noDelay })).rejects.toMatchObject({ status: 502 });
    expect(fn).toHaveBeenCalledTimes(RETRY_POLICY.maxAttempts);
  });

  it('aborts immediately when shouldAbort() returns true', async () => {
    const fn = vi.fn(async () => {
      throw statusError(503);
    });
    await expect(
      withRetry(fn, { maxAttempts: 5, delayFn: noDelay, shouldAbort: () => true }),
    ).rejects.toMatchObject({ status: 503 });
    // First attempt throws, shouldAbort short-circuits before a second attempt.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('continues while shouldAbort() returns false', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 2) throw statusError(503);
      return 'ok';
    });
    const result = await withRetry(fn, {
      maxAttempts: 3,
      delayFn: noDelay,
      shouldAbort: () => false,
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('computes exponential backoff without jitter', async () => {
    const delays: number[] = [];
    const delayFn = async (ms: number): Promise<void> => {
      delays.push(ms);
    };
    const fn = async (): Promise<never> => {
      throw statusError(500);
    };
    await expect(
      withRetry(fn, {
        maxAttempts: 4,
        baseDelayMs: 100,
        maxDelayMs: 10_000,
        jitter: false,
        delayFn,
      }),
    ).rejects.toBeDefined();
    // attempt 1 -> 100, attempt 2 -> 200, attempt 3 -> 400; no delay after final.
    expect(delays).toEqual([100, 200, 400]);
  });

  it('caps backoff at maxDelayMs', async () => {
    const delays: number[] = [];
    const delayFn = async (ms: number): Promise<void> => {
      delays.push(ms);
    };
    const fn = async (): Promise<never> => {
      throw statusError(500);
    };
    await expect(
      withRetry(fn, {
        maxAttempts: 5,
        baseDelayMs: 1000,
        maxDelayMs: 1500,
        jitter: false,
        delayFn,
      }),
    ).rejects.toBeDefined();
    // 1000, then 2000->capped 1500, 4000->1500, 8000->1500.
    expect(delays).toEqual([1000, 1500, 1500, 1500]);
  });

  it('applies full jitter within [0, capped] using the injected rng', async () => {
    const delays: number[] = [];
    const delayFn = async (ms: number): Promise<void> => {
      delays.push(ms);
    };
    const fn = async (): Promise<never> => {
      throw statusError(500);
    };
    await expect(
      withRetry(fn, {
        maxAttempts: 3,
        baseDelayMs: 200,
        maxDelayMs: 10_000,
        jitter: true,
        rng: () => 0.5,
        delayFn,
      }),
    ).rejects.toBeDefined();
    // rng 0.5 halves each capped value: 200*0.5=100, 400*0.5=200.
    expect(delays).toEqual([100, 200]);
  });

  it('does not delay when only a single attempt is allowed', async () => {
    const delayFn = vi.fn(async () => {});
    const fn = async (): Promise<never> => {
      throw statusError(500);
    };
    await expect(withRetry(fn, { maxAttempts: 1, delayFn })).rejects.toBeDefined();
    expect(delayFn).not.toHaveBeenCalled();
  });
});
