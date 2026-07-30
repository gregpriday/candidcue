/**
 * Failure reporting for the cross-screen actions (issue #122).
 *
 * Tauri rejects `invoke()` with the serialized `AppError` object rather than an
 * `Error`, so the old `String(err)` interpolation rendered every one of these
 * failures as the literal text `[object Object]`. These tests assert the
 * authored copy reaches the toast, and assert the absence of `[object Object]`
 * directly so the exact regression cannot come back quietly.
 *
 * `services/errors` is deliberately NOT mocked: the point is that real authored
 * copy comes out the other end, which a stubbed `describeError` would hide.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppError } from '../../../src/shared/contracts/errors';

const calls = vi.hoisted(() => ({
  createScript: vi.fn(),
  importScript: vi.fn(),
  exportScript: vi.fn(),
  markWelcomed: vi.fn(),
  loadLibrary: vi.fn(),
  navigate: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock('../../../src/control/services/scripts', () => ({
  createScript: calls.createScript,
  importScript: calls.importScript,
  exportScript: calls.exportScript,
}));
vi.mock('../../../src/control/stores/app-status', () => ({ markWelcomed: calls.markWelcomed }));
vi.mock('../../../src/control/stores/library', () => ({ loadLibrary: calls.loadLibrary }));
vi.mock('../../../src/control/stores/router', () => ({ navigate: calls.navigate }));
vi.mock('../../../src/control/stores/toasts', () => ({ showToast: calls.showToast }));

const { clearErrorDiagnostics, recentErrorDiagnostics } = await import(
  '../../../src/control/services/errors'
);
const { createAndOpenScript, importMarkdown, exportScriptToFile } = await import(
  '../../../src/control/lib/app-actions'
);

/** An `AppError` exactly as it crosses IPC — a plain object, never an `Error`. */
function appError(code: string, userMessage: string): AppError {
  return {
    code,
    category: 'storage',
    userMessage,
    recoverable: true,
    correlationId: 'test-correlation-id',
  };
}

/** The single danger toast raised during a test. */
function dangerToast(): string {
  const danger = calls.showToast.mock.calls.filter(([, tone]) => tone === 'danger');
  expect(danger).toHaveLength(1);
  return danger[0][0] as string;
}

beforeEach(() => {
  for (const spy of Object.values(calls)) spy.mockReset();
  calls.loadLibrary.mockResolvedValue(undefined);
  calls.navigate.mockResolvedValue(undefined);
  clearErrorDiagnostics();
});

describe('createAndOpenScript', () => {
  it('reports a creation failure instead of rejecting out of the click handler', async () => {
    calls.createScript.mockRejectedValueOnce(
      appError('SCRIPT_SAVE_FAILED', 'Backend prose nobody authored copy against.'),
    );

    // Resolves rather than rejects: the welcome CTA fires this and forgets it,
    // so a rejection here would surface as an unhandled promise rejection.
    await expect(createAndOpenScript('new')).resolves.toBeUndefined();

    expect(dangerToast()).toBe(
      'Could not create that script. CandidCue could not save the script. Check that the disk is not full or read-only, then try again.',
    );
  });

  it('does not mark welcomed, reload the library, or navigate when creation fails', async () => {
    calls.createScript.mockRejectedValueOnce(appError('SCRIPT_SAVE_FAILED', 'unused'));

    await createAndOpenScript('sample');

    expect(calls.markWelcomed).not.toHaveBeenCalled();
    expect(calls.loadLibrary).not.toHaveBeenCalled();
    expect(calls.navigate).not.toHaveBeenCalled();
  });

  it('still opens the editor on success', async () => {
    calls.createScript.mockResolvedValueOnce({ id: 'script-1' });

    await createAndOpenScript('new');

    expect(calls.markWelcomed).toHaveBeenCalledOnce();
    expect(calls.navigate).toHaveBeenCalledWith({ name: 'editor', scriptId: 'script-1' });
    expect(calls.showToast).not.toHaveBeenCalled();
  });
});

describe('importMarkdown', () => {
  it('renders authored copy for a mapped code', async () => {
    calls.importScript.mockRejectedValueOnce(
      appError('IMPORT_INVALID_FORMAT', 'unused because the code has authored copy'),
    );

    await importMarkdown();

    expect(dangerToast()).toBe(
      'Could not import that file. That file is not in a format CandidCue can import.',
    );
  });

  it('stays silent when the operator cancels the picker', async () => {
    calls.importScript.mockResolvedValueOnce(null);

    await importMarkdown();

    expect(calls.showToast).not.toHaveBeenCalled();
    expect(calls.markWelcomed).not.toHaveBeenCalled();
    expect(calls.navigate).not.toHaveBeenCalled();
  });
});

describe('exportScriptToFile', () => {
  it('renders authored copy for a mapped code', async () => {
    calls.exportScript.mockRejectedValueOnce(appError('SCRIPT_FILE_MISSING', 'unused'));

    await exportScriptToFile('script-1', 'My script');

    expect(dangerToast()).toBe(
      'Could not export that script. The file behind this script is missing. It may have been moved or deleted outside CandidCue.',
    );
  });

  it('falls back to the backend message for a code with no authored copy', async () => {
    // Every code in the contract has authored copy today, so this branch is
    // reached by a code Rust mints before the UI has copy for it. Worth holding:
    // it is the path that decides whether an unrecognised failure reads as
    // prose or as a raw token.
    calls.exportScript.mockRejectedValueOnce(
      appError('EXPORT_WRITE_FAILED', 'The destination folder is read-only.'),
    );

    await exportScriptToFile('script-1', 'My script');

    expect(dangerToast()).toBe(
      'Could not export that script. The destination folder is read-only.',
    );
  });

  it('raises no success toast when the export fails', async () => {
    calls.exportScript.mockRejectedValueOnce(appError('SCRIPT_FILE_MISSING', 'unused'));

    await exportScriptToFile('script-1', 'My script');

    expect(calls.showToast.mock.calls.filter(([, tone]) => tone === 'success')).toHaveLength(0);
  });

  it('stays silent when the operator cancels the save dialog', async () => {
    calls.exportScript.mockResolvedValueOnce(null);

    await exportScriptToFile('script-1', 'My script');

    expect(calls.showToast).not.toHaveBeenCalled();
  });

  it('raises exactly one success toast on a clean export', async () => {
    calls.exportScript.mockResolvedValueOnce({ warnings: [] });

    await exportScriptToFile('script-1', 'My script');

    expect(calls.showToast.mock.calls).toEqual([['Script exported', 'success']]);
  });
});

describe('the [object Object] regression', () => {
  const cases: Array<[string, () => void, () => Promise<void>]> = [
    [
      'createAndOpenScript',
      () => calls.createScript.mockRejectedValueOnce(appError('SCRIPT_SAVE_FAILED', 'x')),
      () => createAndOpenScript('new'),
    ],
    [
      'importMarkdown',
      () => calls.importScript.mockRejectedValueOnce(appError('IMPORT_INVALID_FORMAT', 'x')),
      () => importMarkdown(),
    ],
    [
      'exportScriptToFile',
      () => calls.exportScript.mockRejectedValueOnce(appError('SCRIPT_FILE_MISSING', 'x')),
      () => exportScriptToFile('script-1', 'My script'),
    ],
  ];

  for (const [name, arrange, act] of cases) {
    it(`${name} never stringifies the raw AppError`, async () => {
      arrange();

      await act();

      const message = dangerToast();
      expect(message).not.toContain('[object Object]');
      // The stable code is for Diagnostics, not for the operator to read.
      expect(message).not.toMatch(/[A-Z]{2,}_[A-Z_]+/);
    });

    it(`${name} records the raw code for Diagnostics`, async () => {
      arrange();

      await act();

      const entries = recentErrorDiagnostics();
      expect(entries).toHaveLength(1);
      expect(entries[0].code).not.toBeNull();
      // The lead sentence belongs to the toast; Diagnostics records only the
      // resolved copy `describeError` returned.
      expect(dangerToast()).toContain(entries[0].shown);
    });
  }
});
