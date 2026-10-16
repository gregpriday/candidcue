/**
 * Closing the window must not lose acknowledged edits.
 *
 * The 1.0 readiness review found that native close and application quit ran no
 * frontend policy at all. A debounced editor save still inside its window was
 * simply lost; the take's session row stayed open until the next launch swept
 * it as abandoned; the reader frame was never persisted. Some of that is
 * repaired on the next launch, but "repair later" is not a clean shutdown, and
 * the item at the top of the list is not repairable at all.
 *
 * `lib/shutdown.ts` is where the ordering and the isolation live, and it is
 * pure — the steps are supplied — so the two properties that matter are
 * testable without a Tauri runtime, a microphone, or a database:
 *
 *  1. every step runs, in the order given;
 *  2. a step that throws does not stop the ones after it.
 *
 * Property 2 is the one with teeth. Without it, an editor save that rejects on
 * an unresolved external-change conflict would also abandon the take — turning
 * one problem into two, at the exact moment nobody is watching.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { runShutdownSequence, type ShutdownStep } from '../../../src/control/lib/shutdown';

function step(name: string, run: () => Promise<void> | void): ShutdownStep {
  return { name, run };
}

describe('the shutdown sequence', () => {
  it('runs every step, in the order it was given', async () => {
    const order: string[] = [];
    const report = await runShutdownSequence([
      step('flush-editor', () => void order.push('flush-editor')),
      step('end-take', () => void order.push('end-take')),
      step('reader-frame', () => void order.push('reader-frame')),
    ]);

    expect(order).toEqual(['flush-editor', 'end-take', 'reader-frame']);
    expect(report.completed).toEqual(['flush-editor', 'end-take', 'reader-frame']);
    expect(report.failed).toEqual([]);
  });

  it('keeps going after a step throws, and says which one', async () => {
    /*
     * The specific scenario: quitting with an unresolved external-change
     * conflict. `saveNow()` rejects, and the take must still be finished and
     * the reader frame still persisted.
     */
    const order: string[] = [];
    const report = await runShutdownSequence([
      step('flush-editor', () => {
        throw new Error('conflict: the file changed on disk');
      }),
      step('end-take', () => void order.push('end-take')),
      step('reader-frame', () => void order.push('reader-frame')),
    ]);

    expect(order, 'the steps after a failure must still run').toEqual([
      'end-take',
      'reader-frame',
    ]);
    expect(report.completed).toEqual(['end-take', 'reader-frame']);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]?.name).toBe('flush-editor');
    expect(report.failed[0]?.reason, 'the reason must reach the log').toContain('conflict');
  });

  it('awaits an asynchronous step before starting the next', async () => {
    /*
     * Not incidental. `saveNow()` returns a promise, and a sequence that fired
     * the steps without awaiting would let the take be cleared while the save
     * was still in flight — which is the in-flight-save case in the review's
     * close matrix.
     */
    const order: string[] = [];
    await runShutdownSequence([
      step('slow-save', async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push('slow-save');
      }),
      step('end-take', () => void order.push('end-take')),
    ]);
    expect(order).toEqual(['slow-save', 'end-take']);
  });

  it('imposes no deadline of its own — Rust owns the only one', async () => {
    /*
     * This module used to export a `runShutdownWithin` that raced the sequence
     * against a 3s frontend budget, so its report would land before Rust's 4s
     * deadline. That is backwards: it gives up on a save Rust was still
     * willing to wait a further second for, in order to deliver a nicer log
     * line. The report is diagnostic; the save is the point.
     *
     * Two deadlines for one operation is also two numbers to keep in sync, and
     * the shorter one silently wins. There is one now, in Rust, and it
     * enforces itself by proceeding without us — which is exactly the
     * fail-safe it exists to be.
     */
    const lib = await import('../../../src/control/lib/shutdown');
    expect('runShutdownWithin' in lib, 'a second deadline must not come back').toBe(false);

    const service = readFileSync(
      new URL('../../../src/control/services/shutdown.ts', import.meta.url),
      'utf8',
    );
    expect(service, 'the protocol must not set a timer either').not.toMatch(
      /setTimeout|BUDGET_MS/,
    );
  });
});

describe('the shell wires the steps that matter', () => {
  const appSource = readFileSync(
    new URL('../../../src/control/App.svelte', import.meta.url),
    'utf8',
  );

  it('installs the handshake', () => {
    expect(appSource).toMatch(/installShutdownHandshake\(/);
  });

  it('flushes the editor before it clears the take', () => {
    /*
     * Ordering is a claim about what is irreplaceable. Everything else in the
     * sequence is repaired, re-derived or restarted on the next launch; the
     * newest edits to a script are not.
     */
    const steps = appSource.slice(appSource.indexOf('installShutdownHandshake('));
    const flush = steps.indexOf("name: 'flush-editor'");
    const take = steps.indexOf("name: 'end-take'");
    const frame = steps.indexOf("name: 'reader-frame'");

    expect(flush, 'the editor flush step must exist').toBeGreaterThan(-1);
    expect(flush).toBeLessThan(take);
    expect(take).toBeLessThan(frame);
  });

  it('actually calls saveNow, not merely names a step after it', () => {
    const steps = appSource.slice(appSource.indexOf('installShutdownHandshake('));
    const flushStep = steps.slice(steps.indexOf("name: 'flush-editor'"), steps.indexOf("name: 'end-take'"));
    expect(flushStep).toMatch(/saveNow\(\)/);
  });

  it('parks the text somewhere when the save did not actually land', () => {
    /*
     * `saveNow()` RESOLVES WHEN THE SAVE FAILS — a conflict or a failed write
     * is reported through store state and the editor's own sheets. That is
     * right while the app is open and wrong at the moment it closes, because
     * there is no longer a screen to report to. Awaiting it and moving on
     * would quit with the text gone and the step recorded as completed, which
     * is the exact acceptance criterion this whole change exists for: no
     * successful close may lose edits the editor acknowledged.
     */
    const steps = appSource.slice(appSource.indexOf('installShutdownHandshake('));
    const flushStep = steps.slice(
      steps.indexOf("name: 'flush-editor'"),
      steps.indexOf("name: 'end-take'"),
    );
    expect(flushStep, 'the flush must be checked, not assumed').toMatch(/editorHasUnsavedWork\(\)/);
    expect(flushStep, 'and anything left over must be written somewhere').toMatch(
      /writeUnsavedRecovery\(/,
    );
  });

  it('waits for the session row before the take step reports done', () => {
    /*
     * `stopSession` closes the session row fire-and-forget, and that row holds
     * the ending token Editor starts the next take from. The take history and
     * the transcript appends used to share this wait; the row is what is left
     * of it, and it is the one write the next launch cannot reconstruct.
     */
    const steps = appSource.slice(appSource.indexOf('installShutdownHandshake('));
    const takeStep = steps.slice(
      steps.indexOf("name: 'end-take'"),
      steps.indexOf("name: 'reader-frame'"),
    );
    expect(takeStep).toMatch(/stopSession\(\)/);
    expect(takeStep).toMatch(/await awaitPendingPersistence\(\)/);
  });
});

describe('the shutdown protocol keeps its two event names distinct', () => {
  it('does not reuse one name for the request and the answer', async () => {
    /*
     * Tauri fans a webview emit out to every webview's listeners regardless of
     * target, so an event control EMITS must not share a name with one control
     * LISTENS for — the same reason `escapePressed`/`motionReport` exist as
     * separate names. Sharing one here would make the control window
     * acknowledge its own request the instant it arrived, and the flush would
     * be raced by the exit it was meant to delay.
     */
    const { CONTROL_EVENT, SHUTDOWN_COMPLETE_EVENT } = await import(
      '../../../src/shared/contracts/stage'
    );
    expect(CONTROL_EVENT.shutdownRequested).toBe('app://shutdown-requested');
    expect(SHUTDOWN_COMPLETE_EVENT).toBe('app://shutdown-complete');
    expect(SHUTDOWN_COMPLETE_EVENT).not.toBe(CONTROL_EVENT.shutdownRequested);
  });
});
