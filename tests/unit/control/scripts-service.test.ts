import { afterEach, describe, expect, it, vi } from 'vitest';
import { setInvokeForTesting } from '../../../src/control/services/ipc';
import * as scripts from '../../../src/control/services/scripts';

afterEach(() => {
  setInvokeForTesting(null);
});

describe('scripts service — invoke wiring', () => {
  it('uses the exact spec §46.2 command names with camelCase payloads', async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = [];
    setInvokeForTesting(async <T>(command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      return {} as T;
    });

    await scripts.listScripts({ view: 'all' }, 'name', 1);
    await scripts.getScript('id-1');
    await scripts.saveScript('id-1', 3, '# Hello', { title: 'Hello' });
    await scripts.renameScript('id-1', 'New name', 3);
    await scripts.duplicateScript('id-1');
    await scripts.trashScript('id-1', 3);
    await scripts.restoreScript('id-1', 4);
    await scripts.permanentlyDeleteScript('id-1');
    await scripts.exportScript('id-1', { destination: '/tmp/out.md', format: 'markdown' });
    await scripts.revealScriptFolder('id-1');

    expect(calls.map((c) => c.command)).toEqual([
      'list_scripts',
      'get_script',
      'save_script',
      'rename_script',
      'duplicate_script',
      'trash_script',
      'restore_script',
      'permanently_delete_script',
      'export_script',
      'reveal_script_folder',
    ]);
    expect(calls[2]?.args).toEqual({
      scriptId: 'id-1',
      expectedRevision: 3,
      source: '# Hello',
      metadataPatch: { title: 'Hello' },
    });
    expect(calls[3]?.args).toEqual({ scriptId: 'id-1', title: 'New name', expectedRevision: 3 });
  });

  it('propagates real backend errors instead of masking them', async () => {
    setInvokeForTesting(async () => {
      throw new Error('SCRIPT_SAVE_FAILED: disk full');
    });
    await expect(scripts.saveScript('id-1', 1, 'x')).rejects.toThrow('SCRIPT_SAVE_FAILED');
  });
});

describe('scripts service — mock fallback (no backend)', () => {
  it('supports the full library lifecycle', async () => {
    const created = await scripts.createScript({ title: 'Lifecycle', source: '# One\n\nHello world.\n' });
    expect(created.id).toBeTruthy();
    expect(created.spokenWordCount).toBeGreaterThan(0);

    const page = await scripts.listScripts({ view: 'all' });
    expect(page.items.some((s) => s.id === created.id)).toBe(true);

    const loaded = await scripts.getScript(created.id);
    expect(loaded.source).toContain('Hello world.');

    const saved = await scripts.saveScript(created.id, loaded.scriptRevision, '# One\n\nEdited text.\n');
    expect(saved.status).toBe('saved');
    expect(saved.scriptRevision).toBe(loaded.scriptRevision + 1);

    // Stale revision → conflict, never silent overwrite.
    const conflict = await scripts.saveScript(created.id, loaded.scriptRevision, 'other');
    expect(conflict.status).toBe('conflict');

    await scripts.trashScript(created.id, loaded.scriptRevision + 1);
    const trash = await scripts.listScripts({ view: 'trash' });
    expect(trash.items.some((s) => s.id === created.id)).toBe(true);
    const all = await scripts.listScripts({ view: 'all' });
    expect(all.items.some((s) => s.id === created.id)).toBe(false);

    await scripts.restoreScript(created.id, loaded.scriptRevision + 2);
    const restored = await scripts.listScripts({ view: 'all' });
    expect(restored.items.some((s) => s.id === created.id)).toBe(true);

    await scripts.permanentlyDeleteScript(created.id);
    const finalList = await scripts.listScripts({ view: 'all' });
    expect(finalList.items.some((s) => s.id === created.id)).toBe(false);
  });

  it('search filters by title and source text', async () => {
    const created = await scripts.createScript({
      title: 'Quarterly review',
      source: '# Numbers\n\nRevenue grew by twelve percent.\n',
    });
    const byTitle = await scripts.listScripts({ view: 'all', query: 'quarterly' });
    expect(byTitle.items.some((s) => s.id === created.id)).toBe(true);
    const bySource = await scripts.listScripts({ view: 'all', query: 'twelve percent' });
    expect(bySource.items.some((s) => s.id === created.id)).toBe(true);
    const miss = await scripts.listScripts({ view: 'all', query: 'zebra unicorns' });
    expect(miss.items.some((s) => s.id === created.id)).toBe(false);
    await scripts.permanentlyDeleteScript(created.id);
  });
});
