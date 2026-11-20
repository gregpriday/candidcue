/**
 * Restore from export (#488): the wrappers against the fixture
 * `src-tauri/tests/ipc_contract_tests.rs` checks the Rust DTOs against.
 *
 * Choosing schedules nothing, and the confirmed choice goes back as an id —
 * never a path the webview could have made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '../../fixtures/ipc/restore-command-payloads.json';
import {
  formatExportTime,
  pendingRestoreLines,
  restoreConfirmation,
} from '../../../src/control/lib/restore-copy';
import type { PendingRestore, RestorePreview } from '../../../src/control/services/settings-types';

const calls: { command: string; payload: unknown }[] = [];
let nextResult: unknown = null;

vi.mock('../../../src/control/services/ipc', () => ({
  isTauriRuntime: () => true,
  ipcInvoke: async (command: string, payload: unknown) => {
    calls.push({ command, payload });
    return nextResult;
  },
  BackendUnavailableError: class extends Error {},
}));

const settings = await import('../../../src/control/services/settings');

describe('restore IPC payloads match the Rust signatures', () => {
  beforeEach(() => {
    calls.length = 0;
    nextResult = null;
  });

  it('choose_restore_export sends nothing and reads a cancelled picker as null', async () => {
    expect(await settings.chooseRestoreExport()).toBeNull();
    expect(calls[0]!.command).toBe('choose_restore_export');
    expect(calls[0]!.payload ?? {}).toEqual(fixture.choose_restore_export);

    nextResult = fixture.expectedRestorePreview;
    const preview = await settings.chooseRestoreExport();
    expect(preview).toEqual(fixture.expectedRestorePreview);
  });

  it('schedule_restore sends the choice id and nothing else', async () => {
    nextResult = fixture.expectedPendingRestore;
    const pending = await settings.scheduleRestore(fixture.expectedRestorePreview.selectionId);
    expect(calls[0]).toEqual({ command: 'schedule_restore', payload: fixture.schedule_restore });
    expect(pending).toEqual(fixture.expectedPendingRestore);
  });

  it('get_pending_restore and cancel_pending_restore take no arguments', async () => {
    nextResult = fixture.expectedLegacyPendingRestore;
    expect(await settings.getPendingRestore()).toEqual(fixture.expectedLegacyPendingRestore);
    nextResult = true;
    expect(await settings.cancelPendingRestore()).toBe(true);
    expect(calls.map((c) => c.command)).toEqual(['get_pending_restore', 'cancel_pending_restore']);
    for (const call of calls) expect(call.payload ?? {}).toEqual({});
  });
});

describe('what Settings says about a restore', () => {
  const preview: RestorePreview = fixture.expectedRestorePreview;

  it('asks before scheduling, and says what is replaced, when, and where the old data goes', () => {
    const request = restoreConfirmation(preview);
    expect(request.danger).toBe(true);
    expect(request.confirmLabel).toBe('Schedule restore');
    const body = request.body;
    expect(body).toContain(preview.path);
    expect(body).toContain(formatExportTime(preview.createdAt));
    expect(body).toContain('7 scripts');
    expect(body).toMatch(/next time Speaking Glass opens/);
    expect(body).toMatch(/scripts, settings \(calibrated rigs included\) and take history/);
    expect(body).toMatch(/quarantine folder/);
    expect(body, 'changes made before quitting go too').toMatch(/anything you change before you quit/);
    expect(restoreConfirmation({ ...preview, scriptsInExport: 1 }).body).toContain('holds 1 script.');
  });

  it('names the export and when it was taken while a restore waits', () => {
    const pending: PendingRestore = fixture.expectedPendingRestore;
    const lines = pendingRestoreLines(pending);
    expect(lines.body).toContain(pending.exportPath);
    expect(lines.body).toContain(`taken on ${formatExportTime(pending.exportCreatedAt!)}`);
    expect(lines.note).toBeNull();
  });

  it('never dates a legacy marker by when it was scheduled, and says why it cannot be cancelled', () => {
    const pending: PendingRestore = fixture.expectedLegacyPendingRestore;
    const lines = pendingRestoreLines(pending);
    expect(lines.body).not.toContain('taken on');
    expect(lines.body).not.toContain(formatExportTime(pending.requestedAt));
    expect(lines.note).toMatch(/can no longer be cancelled/);
  });

  it('shows an unparseable stamp as itself, not as "Invalid Date"', () => {
    expect(formatExportTime('not-a-date')).toBe('not-a-date');
  });
});
