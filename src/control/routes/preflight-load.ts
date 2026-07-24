/**
 * Preflight's async plumbing (spec §14).
 *
 * Two guarantees live here, both of which the screen got wrong:
 *
 *  1. A check that starts must finish. Every row is set to `checking` before
 *     its work begins, so a rejection that skips the assignment leaves the row
 *     reading "Opening…" / "Connecting…" forever, with no error text, no retry
 *     and a Start button that only says "Checks are still running".
 *  2. A resource acquired asynchronously must be disposed even if the caller
 *     went away while it was being acquired. `startTranscriptionTest` hands
 *     back its disposer only once the microphone is already open, so a
 *     navigation mid-acquisition used to leak the capture for the lifetime of
 *     the app.
 *
 * Both are kept out of the component so they can be tested without a DOM.
 */

export interface CheckSteps<T> {
  /** True when this run has been superseded (new script) or unmounted. */
  isStale(): boolean;
  /** Put the row into its `checking` state. */
  onStart(): void;
  /** The work itself. May reject. */
  run(): Promise<T>;
  /** Apply the result. May itself be async (e.g. a follow-up probe). */
  onSuccess(value: T): void | Promise<void>;
  /** Put the row into a blocked state WITH a reason the operator can act on. */
  onFailure(error: unknown): void;
}

/**
 * Run one preflight check. Never rejects: a failing step becomes `onFailure`,
 * a superseded one becomes nothing at all.
 */
export async function runCheck<T>(steps: CheckSteps<T>): Promise<void> {
  steps.onStart();
  let value: T;
  try {
    value = await steps.run();
  } catch (error) {
    if (steps.isStale()) return;
    steps.onFailure(error);
    return;
  }
  if (steps.isStale()) return;
  try {
    await steps.onSuccess(value);
  } catch (error) {
    if (steps.isStale()) return;
    steps.onFailure(error);
  }
}

export interface Acquisition {
  /** The disposer, or null when the acquisition failed or was cancelled. */
  stop: (() => void) | null;
  /** True when the caller moved on before the resource became available. */
  cancelled: boolean;
  /** The rejection, if any. Never thrown — the caller decides what to show. */
  error: unknown;
}

/**
 * Acquire a disposable resource that may be cancelled while in flight. A
 * disposer that arrives too late to be stored is used immediately rather than
 * dropped.
 */
export async function acquireCancellable(
  acquire: () => Promise<() => void>,
  isStale: () => boolean,
): Promise<Acquisition> {
  let stop: () => void;
  try {
    stop = await acquire();
  } catch (error) {
    return { stop: null, cancelled: isStale(), error };
  }
  if (isStale()) {
    stop();
    return { stop: null, cancelled: true, error: null };
  }
  return { stop, cancelled: false, error: null };
}
