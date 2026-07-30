/**
 * A library mutation that fails has to say so.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THESE EXIST FOR
 * ---------------------------------------------------------------------------
 * None of the five mutators had a `try`/`catch`, and every call site invoked
 * them as `void restoreScriptFromTrash(id)`. There is no `unhandledrejection`
 * handler in `src/`, so a backend failure reached nothing whatsoever. Worse,
 * the success toasts sat AFTER the await at the call sites, so on failure the
 * confirmation sheet closed and the screen did not change in any way. You
 * clicked Restore, and the row stayed exactly where it was.
 *
 * So these drive the real store against a failing IPC layer and assert the
 * rendered notice. Asserting that the promise rejects would pin the opposite of
 * what is wanted: a rejection is precisely what nobody was catching.
 *
 * The copy assertions are shaped as "opens with the authored sentence, carries
 * no machine token, is not `[object Object]`" rather than pinned to an exact
 * string — the second half comes from `describeError`, which owns that wording
 * (§44.12, no user ever reads a stable error code).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { setInvokeForTesting, type InvokeFn } from '../../../src/control/services/ipc';
import {
  collectTrashTargets,
  deleteScriptPermanently,
  duplicateScript,
  emptyTrash,
  library,
  loadLibrary,
  moveScriptToTrash,
  restoreScriptFromTrash,
  setLibraryQuery,
  setLibraryView,
} from '../../../src/control/stores/library';
import { showToast } from '../../../src/control/stores/toasts';
import type { ScriptSummary } from '../../../src/shared/contracts';

// `vi.spyOn` on a statically imported ESM export throws under Vitest's native
// ESM mode; the module has to be replaced before the store binds to it.
vi.mock('../../../src/control/stores/toasts', () => ({ showToast: vi.fn() }));

const toast = vi.mocked(showToast);

function summary(id: string, title = id): ScriptSummary {
  return {
    id,
    title,
    status: 'draft',
    language: 'en',
    spokenWordCount: 10,
    estimatedDurationSeconds: 4,
    updatedAt: '2026-07-30T10:00:00.000Z',
    previewText: 'Some narration.',
    hasWarnings: false,
    scriptRevision: 3,
  };
}

/** Every message shown at the given tone, in order. */
function messages(tone: 'info' | 'success' | 'danger'): string[] {
  return toast.mock.calls.filter((call) => call[1] === tone).map((call) => String(call[0]));
}

/** The wording rules every user-facing failure notice has to keep. */
function expectReadableFailure(shown: string | undefined, opening: string): void {
  expect(typeof shown).toBe('string');
  const message = shown ?? '';
  expect(message.startsWith(opening)).toBe(true);
  // `String(err)` on an AppError payload produced exactly this, for months.
  expect(message).not.toContain('[object Object]');
  // §44.12: no SCREAMING_SNAKE token reaches an operator.
  expect(message).not.toMatch(/\b[A-Z][A-Z0-9]*(_[A-Z0-9]+)+\b/);
  // A notice that is only its prefix has not said what went wrong.
  expect(message.length).toBeGreaterThan(opening.length + 1);
}

/** An AppError payload — the shape a real Tauri command rejection arrives in. */
const conflict = { code: 'SCRIPT_CONFLICT', userMessage: 'stale revision' };

/** The scripts the fake backend is holding. Mutations really change it. */
let live: ScriptSummary[] = [];

function pageOf(args: Record<string, unknown> | undefined): {
  items: ScriptSummary[];
  total: number;
} {
  const page = args?.page as { page: number; pageSize: number } | undefined;
  const size = page?.pageSize ?? 100;
  const offset = (page?.page ?? 0) * size;
  return { items: live.slice(offset, offset + size), total: live.length };
}

/** A backend where a delete really does shorten the next `list_scripts`. */
function installBackend(fail: Record<string, unknown> = {}): void {
  const fake: InvokeFn = async <T,>(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<T> => {
    if (command in fail) throw fail[command];
    if (command === 'list_scripts') return pageOf(args) as T;
    if (command === 'permanently_delete_script') {
      live = live.filter((script) => script.id !== (args?.scriptId as string));
      return undefined as T;
    }
    if (command === 'trash_script' || command === 'restore_script') {
      const id = args?.scriptId as string;
      live = live.filter((script) => script.id !== id);
      return summary(id) as T;
    }
    if (command === 'duplicate_script') return summary('copy') as T;
    throw new Error(`unexpected command ${command}`);
  };
  setInvokeForTesting(fake);
}

/**
 * The route's own sequence: read what is in the Trash, then delete exactly
 * that set. Driving both halves keeps the enumeration under test rather than
 * letting it be an implementation detail nothing exercises.
 */
async function runEmptyTrash(): Promise<boolean> {
  const targets = await collectTrashTargets();
  if (targets === null) return false;
  return emptyTrash(targets);
}

beforeEach(async () => {
  live = [summary('a'), summary('b')];
  installBackend();
  // The store is a module singleton, so each test normalises it rather than
  // inheriting whatever view and query the last one left behind.
  setLibraryQuery('');
  setLibraryView('all');
  await loadLibrary();
  toast.mockClear();
});

afterEach(() => {
  setInvokeForTesting(null);
  vi.clearAllMocks();
});

describe('a mutation that fails is reported once, and does not reject', () => {
  const cases = [
    {
      name: 'duplicate',
      command: 'duplicate_script',
      run: () => duplicateScript('a'),
      opening: 'The script could not be duplicated.',
      success: 'Script duplicated',
    },
    {
      name: 'move to Trash',
      command: 'trash_script',
      run: () => moveScriptToTrash('a'),
      opening: 'The script could not be moved to Trash.',
      success: 'Moved to Trash',
    },
    {
      name: 'restore',
      command: 'restore_script',
      run: () => restoreScriptFromTrash('a'),
      opening: 'The script could not be restored.',
      success: 'Script restored',
    },
    {
      name: 'delete permanently',
      command: 'permanently_delete_script',
      run: () => deleteScriptPermanently('a'),
      opening: 'The script could not be deleted permanently.',
      success: 'Script deleted permanently',
    },
  ];

  for (const item of cases) {
    it(`${item.name} reports the failure in words an operator can act on`, async () => {
      installBackend({ [item.command]: conflict });

      // It settles rather than rejecting. Nothing on this screen awaits it for
      // correctness, which is why it cannot be the only carrier of the outcome.
      await expect(item.run()).resolves.toBe(false);

      const shown = messages('danger');
      expect(shown).toHaveLength(1);
      expectReadableFailure(shown[0], item.opening);
    });

    it(`${item.name} does not claim success when it failed`, async () => {
      installBackend({ [item.command]: conflict });
      await item.run();
      expect([...messages('success'), ...messages('info')]).not.toContain(item.success);
    });

    it(`${item.name} reports success exactly once when it worked`, async () => {
      await expect(item.run()).resolves.toBe(true);
      const shown = [...messages('success'), ...messages('info')];
      expect(shown.filter((message) => message === item.success)).toHaveLength(1);
      expect(messages('danger')).toEqual([]);
    });
  }

  it('reports a row the library no longer holds instead of throwing past everyone', async () => {
    // `revisionOf` throws synchronously inside the mutator when the id is gone.
    // "That script is no longer in the library." was raised and never seen.
    await expect(moveScriptToTrash('vanished')).resolves.toBe(false);
    const shown = messages('danger');
    expect(shown).toHaveLength(1);
    expectReadableFailure(shown[0], 'The script could not be moved to Trash.');
    expect(shown[0]).toContain('no longer in the library');
    // The copy has to end somewhere useful, not just state the fact.
    expect(shown[0]).toContain('Refresh the list');
  });
});

describe('Empty Trash empties the Trash, not the page of it on screen', () => {
  beforeEach(async () => {
    live = Array.from({ length: 620 }, (_, index) => summary(`t${index}`));
    installBackend();
    setLibraryView('trash');
    await loadLibrary();
    toast.mockClear();
  });

  it('deletes past the one page Rust will serve', async () => {
    // 620 trashed scripts, 500 to a page. The old loop walked the loaded page
    // and stopped, leaving 120 scripts inside an emptied Trash.
    await expect(runEmptyTrash()).resolves.toBe(true);
    expect(live).toHaveLength(0);
    expect(messages('success')).toEqual(['Trash emptied']);
    expect(messages('danger')).toEqual([]);
  });

  it('is not narrowed by the search box', async () => {
    // Empty Trash means Trash. A filtered list is a view of it, not its extent —
    // here the search matches nothing at all, and everything still goes.
    live = [summary('t0'), summary('t1'), summary('t2')];
    const fake: InvokeFn = async <T,>(
      command: string,
      args?: Record<string, unknown>,
    ): Promise<T> => {
      if (command === 'list_scripts') {
        const filter = args?.filter as { query?: string } | undefined;
        if (filter?.query !== undefined) return { items: [], total: 0 } as T;
        return pageOf(args) as T;
      }
      if (command === 'permanently_delete_script') {
        live = live.filter((script) => script.id !== (args?.scriptId as string));
        return undefined as T;
      }
      throw new Error(`unexpected command ${command}`);
    };
    setInvokeForTesting(fake);

    setLibraryQuery('matches nothing');
    await loadLibrary();
    expect(get(library).scripts).toEqual([]);

    await expect(runEmptyTrash()).resolves.toBe(true);
    expect(live).toHaveLength(0);
  });

  it('still reaches the rows past the first page when the whole first page fails', async () => {
    // The shape this replaced deleted page zero and re-read page zero, so a
    // full page of undeletable rows parked itself at the top and hid the 501st
    // — which was deletable — behind it, then reported no progress and stopped.
    live = Array.from({ length: 501 }, (_, index) => summary(`t${index}`));
    const stuck = new Set(live.slice(0, 500).map((script) => script.id));
    const fake: InvokeFn = async <T,>(
      command: string,
      args?: Record<string, unknown>,
    ): Promise<T> => {
      if (command === 'list_scripts') return pageOf(args) as T;
      if (command === 'permanently_delete_script') {
        const id = args?.scriptId as string;
        if (stuck.has(id)) throw conflict;
        live = live.filter((script) => script.id !== id);
        return undefined as T;
      }
      throw new Error(`unexpected command ${command}`);
    };
    setInvokeForTesting(fake);

    await expect(runEmptyTrash()).resolves.toBe(false);

    // The one deletable row is gone, and the count says exactly that.
    expect(live.map((script) => script.id)).not.toContain('t500');
    expect(live).toHaveLength(500);
    expect(messages('danger')[0]).toContain('Deleted 1 of 501 scripts.');
  });

  it('attempts each row once rather than retrying one into a contradiction', async () => {
    // A row that fails and then succeeds on a later pass used to leave the
    // first failure latched, producing "Trash was only partly emptied. Deleted
    // 2 of 2 scripts." — a report that argues with itself.
    live = [summary('flaky'), summary('fine')];
    // Counted per id, not in total: two attempts could otherwise mean "tried
    // `flaky` twice and never touched `fine`", which is the failure being ruled
    // out here.
    const attempts: string[] = [];
    const fake: InvokeFn = async <T,>(
      command: string,
      args?: Record<string, unknown>,
    ): Promise<T> => {
      if (command === 'list_scripts') return pageOf(args) as T;
      if (command === 'permanently_delete_script') {
        const id = args?.scriptId as string;
        attempts.push(id);
        if (id === 'flaky' && attempts.filter((seen) => seen === 'flaky').length === 1) {
          throw conflict;
        }
        live = live.filter((script) => script.id !== id);
        return undefined as T;
      }
      throw new Error(`unexpected command ${command}`);
    };
    setInvokeForTesting(fake);

    await expect(runEmptyTrash()).resolves.toBe(false);
    expect([...attempts].sort()).toEqual(['fine', 'flaky']);
    const shown = messages('danger');
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain('Deleted 1 of 2 scripts.');
  });

  it('stops enumerating when a page comes back saying nothing new', async () => {
    // A backend that answers every page with the same rows while claiming a
    // larger total would spin this loop forever, in front of a permanent
    // delete. `total` is a separate COUNT(*) and is not a termination
    // condition; a page that contributes no new id is.
    live = Array.from({ length: 500 }, (_, index) => summary(`t${index}`));
    let reads = 0;
    const fake: InvokeFn = async <T,>(
      command: string,
      args?: Record<string, unknown>,
    ): Promise<T> => {
      if (command === 'list_scripts') {
        reads += 1;
        // Always a full page of the same rows, and a total one larger.
        return { items: live.slice(0, 500), total: 501 } as T;
      }
      if (command === 'permanently_delete_script') return undefined as T;
      throw new Error(`unexpected command ${command}`);
    };
    setInvokeForTesting(fake);

    const targets = await collectTrashTargets();
    expect(targets).toHaveLength(500);
    // Page zero, then one repeat that proves there is nothing further.
    expect(reads).toBe(2);
  });

  it('counts what it managed and stops rather than spinning on a row it cannot delete', async () => {
    live = [summary('keeps-failing'), summary('goes'), summary('also-goes')];
    const fake: InvokeFn = async <T,>(
      command: string,
      args?: Record<string, unknown>,
    ): Promise<T> => {
      if (command === 'list_scripts') return { items: live, total: live.length } as T;
      if (command === 'permanently_delete_script') {
        const id = args?.scriptId as string;
        if (id === 'keeps-failing') throw conflict;
        live = live.filter((script) => script.id !== id);
        return undefined as T;
      }
      throw new Error(`unexpected command ${command}`);
    };
    setInvokeForTesting(fake);

    // It terminates: the second pass deletes nothing, so the loop gives up
    // rather than reading the same undeletable row back forever.
    await expect(runEmptyTrash()).resolves.toBe(false);

    const shown = messages('danger');
    expect(shown).toHaveLength(1);
    expectReadableFailure(shown[0], 'Trash was only partly emptied.');
    expect(shown[0]).toContain('Deleted 2 of 3 scripts.');
    expect(messages('success')).toEqual([]);
  });

  it('says nothing was deleted when nothing was', async () => {
    live = [summary('only')];
    const fake: InvokeFn = async <T,>(command: string): Promise<T> => {
      if (command === 'list_scripts') return { items: live, total: live.length } as T;
      throw conflict;
    };
    setInvokeForTesting(fake);

    await expect(runEmptyTrash()).resolves.toBe(false);
    const shown = messages('danger');
    expect(shown).toHaveLength(1);
    expectReadableFailure(shown[0], 'Trash could not be emptied.');
    expect(shown[0]).toContain('Deleted 0 of 1 script.');
  });

  it('reports a failure that lands before anything could be counted', async () => {
    const fake: InvokeFn = async <T,>(): Promise<T> => {
      throw conflict;
    };
    setInvokeForTesting(fake);

    await expect(runEmptyTrash()).resolves.toBe(false);
    const shown = messages('danger');
    expect(shown).toHaveLength(1);
    expectReadableFailure(shown[0], 'Trash could not be emptied.');
    // No total was ever read, so it names no count rather than "0 of 0".
    expect(shown[0]).not.toContain('Deleted');
  });
});

describe('what the store knows about the size of the Trash', () => {
  it('counts the whole Trash even while a search narrows the list', async () => {
    // The Empty Trash confirmation is built from this number. Searching Trash
    // for two scripts and being asked to confirm "2 scripts" before forty go is
    // an undercount with no undo behind it.
    live = Array.from({ length: 40 }, (_, index) => summary(`t${index}`));
    const fake: InvokeFn = async <T,>(
      command: string,
      args?: Record<string, unknown>,
    ): Promise<T> => {
      if (command !== 'list_scripts') throw new Error(`unexpected command ${command}`);
      const filter = args?.filter as { query?: string } | undefined;
      const matched = filter?.query === undefined ? live : live.slice(0, 2);
      return { items: matched, total: matched.length } as T;
    };
    setInvokeForTesting(fake);

    setLibraryView('trash');
    await loadLibrary();
    expect(get(library).trashTotal).toBe(40);

    setLibraryQuery('keynote');
    await loadLibrary();

    expect(get(library).scripts).toHaveLength(2);
    expect(get(library).total).toBe(2);
    expect(get(library).trashTotal).toBe(40);
  });

  it('leaves the count unknown rather than wrong when it cannot be read', async () => {
    live = [summary('a'), summary('b')];
    installBackend();
    setLibraryView('trash');
    setLibraryQuery('anything');
    await loadLibrary();

    // Only the unfiltered count read fails; the list itself is fine.
    const fake: InvokeFn = async <T,>(
      command: string,
      args?: Record<string, unknown>,
    ): Promise<T> => {
      if (command !== 'list_scripts') throw new Error(`unexpected command ${command}`);
      const filter = args?.filter as { query?: string } | undefined;
      if (filter?.query === undefined) throw conflict;
      return { items: live, total: live.length } as T;
    };
    setInvokeForTesting(fake);
    await loadLibrary();

    // The rows survive. A count that could not be read is no reason to hide the
    // Trash, which is the failure mode this whole issue is about.
    expect(get(library).scripts).toHaveLength(2);
    expect(get(library).trashTotal).toBeNull();
    expect(get(library).error).toBeNull();
  });
});
