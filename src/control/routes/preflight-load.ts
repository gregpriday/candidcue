/**
 * Preflight's async check plumbing (spec §14).
 *
 * One guarantee lives here, which the screen got wrong: a check that starts
 * must finish. Every row is set to `checking` before its work begins, so a
 * rejection that skips the assignment leaves the row reading "Opening…" /
 * "Connecting…" forever, with no error text, no retry and a Start button that
 * only says "Checks are still running".
 *
 * It is kept out of the component so it can be tested without a DOM. The
 * microphone test's own lifecycle (including disposing a capture whose
 * disposer arrives after the caller went away) lives in `preflight-mic-test.ts`.
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
