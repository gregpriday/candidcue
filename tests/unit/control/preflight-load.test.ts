/**
 * Preflight's async plumbing (spec §14) — see src/control/routes/preflight-load.ts.
 *
 * The initial load was a bare `void (async () => {…})()` with no rejection
 * handling. Because every row is set to `checking` before its work starts, a
 * throw from `getScript`, `listDisplays` or `getOpenAiKeyStatus` skipped the
 * rest of the body and left that row reading "Opening…" / "Connecting…"
 * forever — `computeReadiness` then reported "Checks are still running" with no
 * error text and no retry. Separately, `startTranscriptionTest` only returns
 * its disposer once the microphone is already open, so leaving the screen
 * mid-acquisition leaked the capture.
 */
import { describe, expect, it, vi } from 'vitest';
import { acquireCancellable, runCheck } from '../../../src/control/routes/preflight-load';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('runCheck', () => {
  it('always leaves a started check in a settled state on rejection', async () => {
    const onStart = vi.fn();
    const onSuccess = vi.fn();
    const onFailure = vi.fn();

    await runCheck({
      isStale: () => false,
      onStart,
      run: () => Promise.reject(new Error('no displays service')),
      onSuccess,
      onFailure,
    });

    expect(onStart).toHaveBeenCalledOnce();
    expect(onSuccess).not.toHaveBeenCalled();
    // The row is told to stop saying "checking" — this is the whole fix.
    expect(onFailure).toHaveBeenCalledOnce();
    expect(String(onFailure.mock.calls[0]?.[0])).toContain('no displays service');
  });

  it('does not reject, so one failed check cannot abort the rest of the load', async () => {
    await expect(
      runCheck({
        isStale: () => false,
        onStart: () => {},
        run: () => Promise.reject(new Error('boom')),
        onSuccess: () => {},
        onFailure: () => {},
      }),
    ).resolves.toBeUndefined();
  });

  it('applies the result on success', async () => {
    const onSuccess = vi.fn();
    const onFailure = vi.fn();
    await runCheck({
      isStale: () => false,
      onStart: () => {},
      run: () => Promise.resolve(['display-1']),
      onSuccess,
      onFailure,
    });
    expect(onSuccess).toHaveBeenCalledWith(['display-1']);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('awaits an async onSuccess and reports its failure too', async () => {
    const order: string[] = [];
    const onFailure = vi.fn();
    await runCheck({
      isStale: () => false,
      onStart: () => order.push('start'),
      run: async () => 'fp-1',
      onSuccess: async () => {
        order.push('probe');
        throw new Error('stage would not open');
      },
      onFailure: (err) => {
        order.push('failed');
        onFailure(err);
      },
    });
    expect(order).toEqual(['start', 'probe', 'failed']);
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it('writes nothing once the run is superseded', async () => {
    // The user moved to a different script while the load was in flight.
    let stale = false;
    const onSuccess = vi.fn();
    const onFailure = vi.fn();
    const gate = deferred<string[]>();

    const running = runCheck({
      isStale: () => stale,
      onStart: () => {},
      run: () => gate.promise,
      onSuccess,
      onFailure,
    });
    stale = true;
    gate.resolve(['display-1']);
    await running;

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('stays silent when a superseded run rejects', async () => {
    let stale = false;
    const onFailure = vi.fn();
    const gate = deferred<string[]>();
    const running = runCheck({
      isStale: () => stale,
      onStart: () => {},
      run: () => gate.promise,
      onSuccess: () => {},
      onFailure,
    });
    stale = true;
    gate.reject(new Error('too late'));
    await running;
    expect(onFailure).not.toHaveBeenCalled();
  });
});

describe('acquireCancellable', () => {
  it('disposes a resource whose disposer arrives after cancellation', async () => {
    let stale = false;
    const stop = vi.fn();
    const gate = deferred<() => void>();

    const running = acquireCancellable(() => gate.promise, () => stale);
    stale = true; // the screen unmounted while the microphone was opening
    gate.resolve(stop);
    const result = await running;

    expect(stop).toHaveBeenCalledOnce(); // the capture is released, not leaked
    expect(result.stop).toBeNull();
    expect(result.cancelled).toBe(true);
  });

  it('hands back the disposer when nothing was cancelled', async () => {
    const stop = vi.fn();
    const result = await acquireCancellable(async () => stop, () => false);
    expect(result.stop).toBe(stop);
    expect(result.cancelled).toBe(false);
    expect(result.error).toBeNull();
    expect(stop).not.toHaveBeenCalled();
  });

  it('reports a failed acquisition instead of throwing', async () => {
    // A throwing `startTranscriptionTest` used to strand micTest at
    // 'listening', which permanently disables the "Test transcription" button.
    const result = await acquireCancellable(
      () => Promise.reject(new Error('mic busy')),
      () => false,
    );
    expect(result.stop).toBeNull();
    expect(result.cancelled).toBe(false);
    expect(String(result.error)).toContain('mic busy');
  });
});
