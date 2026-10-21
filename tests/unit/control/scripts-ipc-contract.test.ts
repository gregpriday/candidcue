/**
 * M4 regression: the TypeScript wrappers and the Rust command signatures must
 * agree. These tests drive the REAL wrappers (not a hand-written payload) and
 * compare what they emit against the shared fixture that
 * `src-tauri/tests/ipc_contract_tests.rs` deserializes into the Rust DTOs.
 *
 * H5: neither payload carries a filesystem path any more. Rust runs the native
 * dialog and does the I/O in the same trusted operation, so the control webview
 * cannot name a file to read or a file to truncate (spec §50.7).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '../../fixtures/ipc/script-command-payloads.json';

const calls: { command: string; payload: unknown }[] = [];

vi.mock('../../../src/control/services/ipc', () => ({
  isTauriRuntime: () => true,
  invokeOrMock: async (command: string, payload: unknown) => {
    calls.push({ command, payload });
    return {};
  },
}));

const scripts = await import('../../../src/control/services/scripts');

const scriptId = fixture.scriptId;

function payloadFor(command: string): unknown {
  const call = calls.find((c) => c.command === command);
  expect(call, `no invoke recorded for ${command}`).toBeDefined();
  return call!.payload;
}

describe('script command IPC payloads match the Rust DTOs', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  /**
   * C3/C7/S2. These drive the REAL wrapper, so they fail the moment the
   * `view` → `status` mapping is reverted — unlike the mock-backed assertions
   * in scripts-service.test.ts, which the mock satisfied on its own.
   */
  it('the Trash view sends status, not the view name Rust discards', async () => {
    await scripts.listScripts({ view: 'trash' }, 'recently_edited', { page: 1, pageSize: 50 });
    const payload = payloadFor('list_scripts') as Record<string, unknown>;
    expect(payload).toEqual(fixture.list_scripts_trash);
    expect(Object.keys(payload.filter as object)).not.toContain('view');
  });

  it('the Recent view sends openedOnly and orders by last opened', async () => {
    await scripts.listScripts({ view: 'recent' }, 'name');
    expect(payloadFor('list_scripts')).toEqual(fixture.list_scripts_recent);
  });

  it('the All view sends neither status nor openedOnly', async () => {
    await scripts.listScripts({ view: 'all', query: 'keynote' }, 'name');
    expect(payloadFor('list_scripts')).toEqual(fixture.list_scripts_all);
  });

  it('import_script sends only a title — never a path', async () => {
    await scripts.importScript({ title: 'Keynote' });
    expect(payloadFor('import_script')).toEqual(fixture.import_script);
  });

  it('export_script sends format, includeAssets and a suggested name', async () => {
    await scripts.exportScript(scriptId, {
      format: 'markdown',
      includeAssets: true,
      suggestedName: 'Keynote',
    });
    expect(payloadFor('export_script')).toEqual(fixture.export_script_markdown);
  });

  it('export_script uses the Rust format name "bundle", not "speakingglass"', async () => {
    await scripts.exportScript(scriptId, {
      format: 'bundle',
      includeAssets: true,
      suggestedName: 'Keynote',
    });
    const payload = payloadFor('export_script') as { request: { format: string } };
    expect(payload.request.format).toBe('bundle');
    expect(payload).toEqual(fixture.export_script_bundle);
  });

  it('export_script defaults includeAssets rather than omitting it', async () => {
    await scripts.exportScript(scriptId, {
      format: 'text',
      suggestedName: 'Keynote',
    });
    expect(payloadFor('export_script')).toEqual(fixture.export_script_text);
  });

  /**
   * H5. The whole point of the new shape: there is no field a caller could put
   * a path in, so a compromised control webview cannot make Rust read or
   * truncate a file of its choosing.
   */
  it('no script command payload contains a filesystem path', async () => {
    await scripts.importScript({ title: 'Keynote' });
    await scripts.exportScript(scriptId, { format: 'markdown', suggestedName: 'Keynote' });
    for (const command of ['import_script', 'export_script']) {
      const payload = payloadFor(command) as Record<string, unknown>;
      const request = payload.request as Record<string, unknown>;
      expect(Object.keys(request)).not.toContain('path');
      expect(Object.keys(request)).not.toContain('destination');
      for (const value of Object.values(request)) {
        if (typeof value === 'string') {
          expect(value.startsWith('/')).toBe(false);
          expect(value).not.toContain(':\\');
        }
      }
    }
  });

  it('save_script sends the optimistic revision and metadata patch', async () => {
    await scripts.saveScript(scriptId, 7, '# Keynote\n\nBody.\n', { title: 'Keynote' });
    expect(payloadFor('save_script')).toEqual(fixture.save_script);
  });

  it('rename, trash and restore all carry an expected revision', async () => {
    await scripts.renameScript(scriptId, 'Keynote', 7);
    await scripts.trashScript(scriptId, 7);
    await scripts.restoreScript(scriptId, 8);
    expect(payloadFor('rename_script')).toEqual(fixture.rename_script);
    expect(payloadFor('trash_script')).toEqual(fixture.trash_script);
    expect(payloadFor('restore_script')).toEqual(fixture.restore_script);
  });
});
