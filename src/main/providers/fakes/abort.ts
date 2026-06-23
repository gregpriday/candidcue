// Shared abort helpers for the deterministic provider fakes. The real adapters
// honour an AbortSignal on every async call, so the fakes reproduce the same
// rejection semantics (a DOMException-shaped error whose `.name` is 'AbortError')
// to keep orchestrator/integration tests faithful.

/** An Error whose `.name` is 'AbortError', matching the retry layer's checks. */
export class AbortError extends Error {
  constructor(message = 'The operation was aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

/** Throw an AbortError immediately if the supplied signal is already aborted. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AbortError();
}

/**
 * Resolve after `ms` milliseconds, rejecting early with an AbortError if the
 * (optional) signal fires first. Used so fakes can simulate real network
 * latency while still respecting cancellation.
 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * A promise that never resolves on its own, used to simulate a provider hang /
 * timeout. It only settles by rejecting with an AbortError when the signal
 * fires, so callers relying on a deadline/AbortController behave realistically.
 */
export function neverResolve(signal?: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortError());
      return;
    }
    signal?.addEventListener('abort', () => reject(new AbortError()), { once: true });
  });
}
