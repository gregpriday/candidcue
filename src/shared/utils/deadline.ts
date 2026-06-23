export class DeadlineError extends Error {
  constructor(ms: number) {
    super(`Operation exceeded deadline of ${ms}ms`);
    this.name = 'DeadlineError';
  }
}

/** Reject with DeadlineError if `promise` does not settle within `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineError(ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Resolve to `fallback` (lazy) if `promise` rejects or exceeds `ms`. */
export async function withDeadlineFallback<T>(
  promise: Promise<T>,
  ms: number,
  fallback: () => T | Promise<T>,
): Promise<{ value: T; timedOut: boolean; latencyMs: number }> {
  const start = nowMs();
  try {
    const value = await withTimeout(promise, ms);
    return { value, timedOut: false, latencyMs: nowMs() - start };
  } catch {
    return { value: await fallback(), timedOut: true, latencyMs: nowMs() - start };
  }
}

/** Monotonic-ish millisecond clock that works in main and renderer. */
export function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
