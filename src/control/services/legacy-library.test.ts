/**
 * The CandidCue library notice, as the window reads it from Rust (#454).
 *
 * The parser is the trust boundary in miniature: Rust's answer is checked, not
 * dereferenced, and anything that is not a notice is no notice. The reveal
 * sends no path, because Rust owns the filesystem and already knows which
 * folder it reported.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ipc = vi.hoisted(() => ({
  tauri: true,
  calls: [] as Array<{ command: string; args?: unknown }>,
  response: undefined as unknown,
  fail: false,
}));

vi.mock('./ipc', () => ({
  isTauriRuntime: () => ipc.tauri,
  ipcInvoke: async (command: string, args?: unknown) => {
    ipc.calls.push(args === undefined ? { command } : { command, args });
    if (ipc.fail) throw new Error('no such command');
    return ipc.response;
  },
}));

import {
  getLegacyLibraryNotice,
  parseLegacyLibraryNotice,
  revealLegacyLibrary,
} from './legacy-library';

beforeEach(() => {
  ipc.tauri = true;
  ipc.calls.length = 0;
  ipc.response = undefined;
  ipc.fail = false;
});

describe('parseLegacyLibraryNotice', () => {
  it('reads a failed copy with its reason, and an abandoned one without', () => {
    expect(
      parseLegacyLibraryNotice({
        kind: 'failed',
        oldFolder: '/Users/a/Library/Application Support/com.candidcue.app',
        reason: 'CandidCue has not finished a recovery',
      }),
    ).toEqual({
      kind: 'failed',
      oldFolder: '/Users/a/Library/Application Support/com.candidcue.app',
      reason: 'CandidCue has not finished a recovery',
    });
    expect(parseLegacyLibraryNotice({ kind: 'abandoned', oldFolder: 'C:\\old' })).toEqual({
      kind: 'abandoned',
      oldFolder: 'C:\\old',
    });
  });

  it('is no notice for anything that is not one', () => {
    for (const answer of [
      null,
      undefined,
      'failed',
      {},
      { kind: 'copied', oldFolder: '/old' },
      { kind: 'failed' },
      { kind: 'failed', oldFolder: '' },
      { kind: 'failed', oldFolder: 42 },
    ]) {
      expect(parseLegacyLibraryNotice(answer), JSON.stringify(answer)).toBeNull();
    }
  });

  it('drops a reason that is not a sentence', () => {
    for (const reason of [7, '']) {
      expect(parseLegacyLibraryNotice({ kind: 'failed', oldFolder: '/old', reason })).toEqual({
        kind: 'failed',
        oldFolder: '/old',
      });
    }
  });
});

describe('getLegacyLibraryNotice', () => {
  it('asks Rust, and passes on what it said', async () => {
    ipc.response = { kind: 'abandoned', oldFolder: '/old' };
    await expect(getLegacyLibraryNotice()).resolves.toEqual({ kind: 'abandoned', oldFolder: '/old' });
    expect(ipc.calls).toEqual([{ command: 'get_legacy_library_notice' }]);
  });

  it('is null when Rust has nothing to say', async () => {
    ipc.response = null;
    await expect(getLegacyLibraryNotice()).resolves.toBeNull();
    expect(ipc.calls).toEqual([{ command: 'get_legacy_library_notice' }]);
  });

  it('is null when what Rust said cannot be read', async () => {
    ipc.response = { kind: 'failed', oldFolder: 12 };
    await expect(getLegacyLibraryNotice()).resolves.toBeNull();
  });

  it('asks nothing in a browser dev session', async () => {
    ipc.tauri = false;
    await expect(getLegacyLibraryNotice()).resolves.toBeNull();
    expect(ipc.calls).toEqual([]);
  });
});

describe('revealLegacyLibrary', () => {
  it('sends no path: Rust reveals the folder it reported', async () => {
    await revealLegacyLibrary();
    expect(ipc.calls).toEqual([{ command: 'reveal_legacy_library' }]);
  });

  it('lets a failure reach the card, which says so', async () => {
    ipc.fail = true;
    await expect(revealLegacyLibrary()).rejects.toThrow('no such command');
    expect(ipc.calls).toEqual([{ command: 'reveal_legacy_library' }]);
  });
});
