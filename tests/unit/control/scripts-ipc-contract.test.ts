/**
 * M4 regression: the TypeScript wrappers and the Rust command signatures must
 * agree. These tests drive the REAL wrappers (not a hand-written payload) and
 * compare what they emit against the shared fixture that
 * `src-tauri/tests/ipc_contract_tests.rs` deserializes into the Rust DTOs.
 *
 * Before the fix `importScript` sent `options.sourcePath` while Rust required
 * `options.path`, and `exportScript` made options optional and sent the format
 * `'candidcue'` while Rust required `destination`/`format` and accepts
 * `'bundle'` — so import and normal editor export both failed with a Serde
 * missing-field error before any work happened.
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

  it('import_script sends options.path, the field Rust requires', async () => {
    await scripts.importScript({ path: fixture.import_script.options.path, title: 'Keynote' });
    expect(payloadFor('import_script')).toEqual(fixture.import_script);
  });

  it('export_script sends destination, format and includeAssets', async () => {
    await scripts.exportScript(scriptId, {
      destination: fixture.export_script_markdown.options.destination,
      format: 'markdown',
      includeAssets: true,
    });
    expect(payloadFor('export_script')).toEqual(fixture.export_script_markdown);
  });

  it('export_script uses the Rust format name "bundle", not "candidcue"', async () => {
    await scripts.exportScript(scriptId, {
      destination: fixture.export_script_bundle.options.destination,
      format: 'bundle',
      includeAssets: true,
    });
    const payload = payloadFor('export_script') as { options: { format: string } };
    expect(payload.options.format).toBe('bundle');
    expect(payload).toEqual(fixture.export_script_bundle);
  });

  it('export_script defaults includeAssets rather than omitting it', async () => {
    await scripts.exportScript(scriptId, {
      destination: fixture.export_script_text.options.destination,
      format: 'text',
    });
    expect(payloadFor('export_script')).toEqual(fixture.export_script_text);
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
