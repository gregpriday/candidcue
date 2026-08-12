/**
 * The control side of the close/quit handshake.
 *
 * Rust intercepts the window close and the application quit, emits
 * `app://shutdown-requested`, and waits up to ~4s for
 * `app://shutdown-complete`. This installs the listener, runs the sequence in
 * `lib/shutdown.ts`, and answers.
 *
 * The answer is sent in a `finally`. A shutdown that throws somewhere
 * unexpected must still tell Rust to stop waiting — otherwise a user who
 * pressed ⌘Q watches the window sit there for the full deadline for no reason.
 */
import { CONTROL_EVENT, SHUTDOWN_COMPLETE_EVENT } from '../../shared/contracts/stage';
import { runShutdownSequence, type ShutdownReport, type ShutdownStep } from '../lib/shutdown';
import { isTauriRuntime } from './ipc';

/*
 * There is ONE deadline, and Rust owns it.
 *
 * This file used to impose a 3s budget of its own so that its report would
 * arrive before Rust's 4s deadline. That is backwards: it means the frontend
 * gives up on a save that Rust was still willing to wait a further second for,
 * to deliver a nicer log line. The report is diagnostic; the save is the point.
 *
 * So the sequence runs to completion and Rust's deadline is the only thing
 * that can cut it short — which it does by proceeding without us, which is
 * exactly the fail-safe it exists to be.
 */

/**
 * Listen for the shutdown request and answer it.
 *
 * Returns a teardown function. The steps are supplied by the caller (the shell
 * owns the stores); this file owns the protocol.
 */
export function installShutdownHandshake(steps: () => readonly ShutdownStep[]): () => void {
  if (!isTauriRuntime()) return () => {};

  let unlisten: (() => void) | null = null;
  let cancelled = false;
  let running = false;

  void (async () => {
    const { emit, listen } = await import('@tauri-apps/api/event');
    const stop = await listen(CONTROL_EVENT.shutdownRequested, () => {
      // Rust makes its side idempotent too, but a second request arriving
      // mid-flush must not start a second flush — two concurrent editor saves
      // is exactly the race a coordinated shutdown exists to avoid.
      if (running) return;
      running = true;

      void (async () => {
        let report: ShutdownReport = { completed: [], failed: [] };
        try {
          report = await runShutdownSequence(steps());
        } finally {
          // Always. See the module comment.
          await emit(SHUTDOWN_COMPLETE_EVENT, report).catch(() => {});
        }
      })();
    });
    if (cancelled) stop();
    else unlisten = stop;
  })().catch(() => {
    /*
     * Failing to install the listener is not worth escalating to the user: it
     * means shutdown falls back to Rust's timeout, which is the behaviour the
     * app had before this existed. Rust logs the missing acknowledgement.
     */
  });

  return () => {
    cancelled = true;
    unlisten?.();
    unlisten = null;
  };
}
