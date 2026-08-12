/**
 * What the control window does when Rust says the app is closing.
 *
 * ## The gap this fills
 *
 * Closing the window or pressing ⌘Q used to go straight to process exit. The
 * frontend has route guards and explicit save/teardown paths, and none of them
 * ran: a debounced save still inside its window was lost, the take's session
 * row stayed open until the next launch swept it as abandoned, the reader
 * frame was not persisted, and audio capture stopped only because the process
 * did.
 *
 * Rust now emits `app://shutdown-requested` and waits — briefly — for
 * `app://shutdown-complete`. This is what happens in between.
 *
 * ## Ordering, and why it is this order
 *
 * Most valuable first, because the deadline is real and a slow step must not
 * be able to starve a more important one:
 *
 *  1. **Flush the editor.** The only thing here that is not recoverable on the
 *     next launch. Everything else is repaired, re-derived or simply restarted.
 *  2. **Finish the take.** Closes the session row through the same path a
 *     normal end uses, so a take that ended by quitting is not a different
 *     kind of record from one that ended by pressing End.
 *  3. **Persist the reader frame**, so the next take opens where this one was.
 *  4. **Stop audio, alignment and any stage window.** Rust stops the recogniser
 *     regardless; this is the orderly version.
 *
 * ## Every step is individually guarded
 *
 * A step that throws must not prevent the ones after it. The failure mode this
 * avoids is precise: an editor save that rejects because of an unresolved
 * external-change conflict would otherwise abandon the take as well, turning
 * one problem into two.
 */

export interface ShutdownStep {
  readonly name: string;
  readonly run: () => Promise<void> | void;
}

export interface ShutdownReport {
  /** Steps that completed, in order. */
  completed: string[];
  /** Steps that threw, with the reason. The shutdown continued past each. */
  failed: Array<{ name: string; reason: string }>;
}

/**
 * Run every step, in order, and never let one stop the next.
 *
 * Exported and pure of I/O — the steps are supplied — so the ordering and the
 * isolation are testable without a Tauri runtime, a microphone, or a database.
 */
export async function runShutdownSequence(steps: readonly ShutdownStep[]): Promise<ShutdownReport> {
  const report: ShutdownReport = { completed: [], failed: [] };
  for (const step of steps) {
    try {
      await step.run();
      report.completed.push(step.name);
    } catch (err) {
      report.failed.push({
        name: step.name,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return report;
}

/*
 * `runShutdownWithin` used to live here: a race between the sequence and a
 * frontend timeout, so that the report would arrive before Rust's deadline.
 *
 * That is backwards. It meant giving up on a save that Rust was still willing
 * to wait a further second for, in order to deliver a nicer log line. The
 * report is diagnostic; the save is the point. There is now ONE deadline and
 * Rust owns it — and the way it enforces it is to proceed without us, which is
 * exactly the fail-safe it exists to be.
 */
