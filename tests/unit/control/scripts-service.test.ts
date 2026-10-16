import { afterEach, describe, expect, it, vi } from 'vitest';
import { setInvokeForTesting } from '../../../src/control/services/ipc';
import * as scripts from '../../../src/control/services/scripts';
import { DEFAULT_WORDS_PER_MINUTE } from '../../../src/shared/speaking-rate';

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

    await scripts.listScripts({ view: 'all' }, 'name', { page: 1, pageSize: 50 });
    await scripts.getScript('id-1');
    await scripts.saveScript('id-1', 3, '# Hello', { title: 'Hello' });
    await scripts.renameScript('id-1', 'New name', 3);
    await scripts.duplicateScript('id-1');
    await scripts.trashScript('id-1', 3);
    await scripts.restoreScript('id-1', 4);
    await scripts.permanentlyDeleteScript('id-1');
    await scripts.exportScript('id-1', { format: 'markdown', suggestedName: 'out' });
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
    // S2: `page` is Rust's `PageRequest` struct, not a bare number.
    expect(calls[0]?.args).toEqual({
      filter: {},
      sort: 'name',
      page: { page: 1, pageSize: 50 },
    });
  });

  it('propagates real backend errors instead of masking them', async () => {
    setInvokeForTesting(async () => {
      throw new Error('SCRIPT_SAVE_FAILED: disk full');
    });
    await expect(scripts.saveScript('id-1', 1, 'x')).rejects.toThrow('SCRIPT_SAVE_FAILED');
  });
});

/**
 * READ THIS BEFORE ADDING A TEST HERE.
 *
 * Everything below runs against `mock-backend.ts`, not Rust. The mock is a
 * *stronger* implementation than production in places, so an assertion that
 * passes here proves only that the mock behaves — it can and did conceal a
 * real defect: `listScripts({ view: 'trash' })` returned the trashed script
 * from the mock while the Rust query was returning the LIVE scripts, because
 * serde discarded the `view` field entirely (C3).
 *
 * These are browser-dev-parity tests and are labelled as such. Anything that
 * asserts what Rust receives belongs in `scripts-ipc-contract.test.ts`, which
 * drives the same wrappers against the shared fixture that
 * `src-tauri/tests/ipc_contract_tests.rs` deserializes.
 */
describe('scripts service — mock fallback (browser dev parity only, proves nothing about Rust)', () => {
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
    // MOCK ONLY. The mock honours `view` directly; Rust never sees it. That
    // the Trash view lists trashed scripts *in production* is proven by
    // `trash_and_recent_views_select_the_right_scripts` (core_tests.rs) and by
    // the payload assertions in scripts-ipc-contract.test.ts.
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

  it('refuses a trash or restore sent against a stale revision, as Rust does', async () => {
    // MOCK ONLY. The mock answered any revision at all, which is why the
    // browser build never showed #255; that Rust refuses one is proven by the
    // compare-and-swap in `repo.rs` and its own tests.
    const created = await scripts.createScript({ title: 'Stale', source: '# One\n\nHello.\n' });
    try {
      const loaded = await scripts.getScript(created.id);
      await scripts.saveScript(created.id, loaded.scriptRevision, '# One\n\nEdited.\n');

      await expect(scripts.trashScript(created.id, loaded.scriptRevision)).rejects.toMatchObject({
        code: 'SCRIPT_CONFLICT',
      });
      // Refused before anything moved: still live, still at the saved revision.
      const live = await scripts.listScripts({ view: 'all' });
      const row = live.items.find((s) => s.id === created.id);
      expect(row?.status).not.toBe('trash');
      expect(row?.scriptRevision).toBe(loaded.scriptRevision + 1);

      const trashed = await scripts.trashScript(created.id, loaded.scriptRevision + 1);
      await expect(scripts.restoreScript(created.id, loaded.scriptRevision + 1)).rejects.toMatchObject({
        code: 'SCRIPT_CONFLICT',
      });
      // Refused before anything moved, again: still in Trash, at the same revision.
      const trash = await scripts.listScripts({ view: 'trash' });
      expect(trash.items.find((s) => s.id === created.id)?.scriptRevision).toBe(trashed.scriptRevision);

      await expect(scripts.restoreScript(created.id, trashed.scriptRevision)).resolves.toMatchObject({
        status: 'draft',
        scriptRevision: trashed.scriptRevision + 1,
      });
    } finally {
      await scripts.permanentlyDeleteScript(created.id);
    }
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

  it('estimates a new script at the rate Rust gives one (#246)', async () => {
    // MOCK ONLY. The mock gave new scripts 150 wpm, so in `pnpm dev:vite` the
    // Library agreed with the editor's old 150 and hid that a real install
    // disagreed. Rust's default is pinned by `shared/speaking-rate.test.ts`.
    const created = await scripts.createScript({
      title: 'Pace',
      source: `${Array.from({ length: 130 }, () => 'word').join(' ')}\n`,
    });
    try {
      expect(created.spokenWordCount).toBe(130);
      expect(created.estimatedDurationSeconds).toBe(60);
      const loaded = await scripts.getScript(created.id);
      expect(loaded.settings.wordsPerMinuteEstimate).toBe(DEFAULT_WORDS_PER_MINUTE);
    } finally {
      await scripts.permanentlyDeleteScript(created.id);
    }
  });
});
