/**
 * What the store holds when a read fails, and what it asks for when it works.
 *
 * `loadLibrary` did catch — into `error: String(err)`, which on the object shape
 * a Tauri command actually rejects with is the literal string
 * `"[object Object]"`. Nothing rendered that field, so the value never came up;
 * the moment the route started rendering it, it had to be copy somebody could
 * read. That is `describeError`'s job, and this pins that it is used.
 *
 * The other half is what a failed read must NOT do: empty the list. A failed
 * re-query leaves the previous results on screen, because a database that could
 * not be read has not told you your scripts are gone — and a blank list on this
 * screen is answered by an invitation to start writing your first one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { setInvokeForTesting, type InvokeFn } from '../../../src/control/services/ipc';
import {
  library,
  loadLibrary,
  loadMoreScripts,
  setLibraryQuery,
  setLibrarySort,
  setLibraryView,
} from '../../../src/control/stores/library';
import type { ScriptSummary } from '../../../src/shared/contracts';

function summary(id: string): ScriptSummary {
  return {
    id,
    title: id,
    status: 'draft',
    language: 'en',
    spokenWordCount: 10,
    estimatedDurationSeconds: 4,
    updatedAt: '2026-07-30T10:00:00.000Z',
    previewText: 'Some narration.',
    hasWarnings: false,
    scriptRevision: 1,
  };
}

const unreadable = {
  code: 'SCRIPT_FILE_MISSING',
  userMessage: 'the row could not be read',
};

let requests: Array<{ command: string; args?: Record<string, unknown> }> = [];

function serving(items: ScriptSummary[], total = items.length): InvokeFn {
  return async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
    requests.push({ command, args });
    return { items, total } as T;
  };
}

function failing(): InvokeFn {
  return async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
    requests.push({ command, args });
    throw unreadable;
  };
}

beforeEach(async () => {
  requests = [];
  setInvokeForTesting(serving([summary('a'), summary('b')]));
  setLibraryQuery('');
  setLibrarySort('recently_edited');
  setLibraryView('all');
  await loadLibrary();
  requests = [];
});

afterEach(() => {
  setInvokeForTesting(null);
});

describe('a successful read', () => {
  it('asks for one page at the largest size Rust will serve', async () => {
    // No page was sent at all, so Rust applied `PageRequest::default()` — 100 —
    // and a library of 340 scripts silently showed 100 of them.
    await loadLibrary();
    const listed = requests.filter((request) => request.command === 'list_scripts');
    expect(listed).not.toHaveLength(0);
    expect(listed[0]?.args?.page).toEqual({ page: 0, pageSize: 500 });
  });

  it('keeps the total, which used to arrive and be dropped', async () => {
    setInvokeForTesting(serving([summary('a')], 617));
    await loadLibrary();
    expect(get(library).total).toBe(617);
    expect(get(library).scripts).toHaveLength(1);
  });
});

describe('a read that fails', () => {
  it('records copy a person can read, never the object it rejected with', async () => {
    setInvokeForTesting(failing());
    await loadLibrary();

    const error = get(library).error;
    expect(error).not.toBeNull();
    expect(error).not.toContain('[object Object]');
    expect(error).not.toMatch(/\b[A-Z][A-Z0-9]*(_[A-Z0-9]+)+\b/);
    // The authored copy for this code, which is what `describeError` returns.
    expect(error).toContain('missing');
    expect(get(library).loading).toBe(false);
  });

  it('keeps the rows already on screen when a re-query fails', async () => {
    // The list is stale, not wrong. Blanking it would put a read error behind
    // the first-run "Write the words" invitation — apparent data loss, plus an
    // offer to start over.
    expect(get(library).scripts).toHaveLength(2);

    setInvokeForTesting(failing());
    setLibraryQuery('keynote');
    await loadLibrary();

    expect(get(library).scripts).toHaveLength(2);
    expect(get(library).error).not.toBeNull();
  });

  it('keeps them across a failed sort change too', async () => {
    setInvokeForTesting(failing());
    setLibrarySort('name');
    await loadLibrary();
    expect(get(library).scripts).toHaveLength(2);
    expect(get(library).error).not.toBeNull();
  });

  it('clears the error once a read succeeds', async () => {
    setInvokeForTesting(failing());
    await loadLibrary();
    expect(get(library).error).not.toBeNull();

    setInvokeForTesting(serving([summary('a')]));
    await loadLibrary();
    expect(get(library).error).toBeNull();
  });
});

/**
 * Two reads in flight at once.
 *
 * Every setter fires its own un-awaited `loadLibrary`, so a view change during
 * a search is two requests racing. Whichever answers LAST used to win, and its
 * update kept the current `view` while replacing the rows — which is how live
 * scripts came to be rendered inside Trash, each one carrying Restore and
 * Delete permanently.
 */
describe('overlapping reads', () => {
  /** One macrotask, which is where a resolved promise chain lands. */
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it('never lets the view being left commit its rows', async () => {
    const releases: Array<() => void> = [];
    setInvokeForTesting(async <T,>(
      _command: string,
      args?: Record<string, unknown>,
    ): Promise<T> => {
      const filter = args?.filter as { status?: string } | undefined;
      const trashed = filter?.status === 'trash';
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      return { items: [summary(trashed ? 'deleted-thing' : 'live-thing')], total: 1 } as T;
    });

    const leaving = loadLibrary();
    await flush();
    setLibraryView('trash');
    await flush();
    expect(releases).toHaveLength(2);

    // Trash answers first; the abandoned read answers last and must be ignored.
    releases[1]?.();
    await flush();
    releases[0]?.();
    await leaving;
    await flush();

    expect(get(library).view).toBe('trash');
    expect(get(library).scripts.map((script) => script.id)).toEqual(['deleted-thing']);
  });

  it('does not let an older failure bury a newer success', async () => {
    const releases: Array<(fail: boolean) => void> = [];
    setInvokeForTesting(async <T,>(): Promise<T> => {
      const shouldFail = await new Promise<boolean>((resolve) => {
        releases.push(resolve);
      });
      if (shouldFail) throw unreadable;
      return { items: [summary('fresh')], total: 1 } as T;
    });

    const older = loadLibrary();
    await flush();
    const newer = loadLibrary();
    await flush();

    releases[1]?.(false);
    await newer;
    releases[0]?.(true);
    await older;
    await flush();

    expect(get(library).error).toBeNull();
    expect(get(library).loading).toBe(false);
    expect(get(library).scripts.map((script) => script.id)).toEqual(['fresh']);
  });
});

describe('changing view', () => {
  it('drops the rows belonging to the view being left', async () => {
    // Live scripts left rendering as Trash rows carry a menu whose entries
    // delete permanently — the same class of mix-up `deny_unknown_fields` was
    // added to Rust's `ScriptFilter` to stop.
    expect(get(library).scripts).toHaveLength(2);
    setLibraryView('trash');
    expect(get(library).scripts).toEqual([]);
    expect(get(library).total).toBe(0);
    expect(get(library).trashTotal).toBeNull();
  });

  it('shows the read error rather than an empty Trash when the load fails', async () => {
    setInvokeForTesting(failing());
    setLibraryView('trash');
    await loadLibrary();
    expect(get(library).scripts).toEqual([]);
    expect(get(library).error).not.toBeNull();
  });
});

/**
 * Paging past the first 500, which is where a large library actually lives.
 *
 * Two failures hid here, and both looked fine from a list of ten fixtures.
 */
describe('paging through a library bigger than one read', () => {
  /** Serve distinct rows per page, so a repeated request is visible. */
  function paged(total: number, pageSize = 500): InvokeFn {
    return async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
      requests.push({ command, args });
      const request = args?.['page'] as { page: number; pageSize: number } | undefined;
      const page = request?.page ?? 0;
      const size = request?.pageSize ?? pageSize;
      const start = page * size;
      const items: ScriptSummary[] = [];
      for (let i = start; i < Math.min(total, start + size); i += 1) items.push(summary(`s${i}`));
      return { items, total } as T;
    };
  }

  it('asks for the next page, not the same one again, when a row was deduplicated', async () => {
    /*
     * The cursor used to be `Math.floor(scripts.length / PAGE_SIZE)`. The append
     * de-duplicates by id, so ONE row repeated between two reads — an ordinary
     * consequence of a script being renamed while the list is open — left 999
     * rows instead of 1000, and the next request asked for page 1 for ever.
     */
    setInvokeForTesting(paged(3000));
    setLibraryView('trash');
    setLibraryView('all');
    await loadLibrary();

    requests = [];
    await loadMoreScripts();
    expect((requests[0]?.args?.['page'] as { page: number }).page).toBe(1);

    // Now serve a page whose first row repeats one already held, so the append
    // drops it and the row count lands one short of a whole page.
    setInvokeForTesting(async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
      requests.push({ command, args });
      const items = [summary('s0'), ...Array.from({ length: 499 }, (_, i) => summary(`x${i}`))];
      return { items, total: 3000 } as T;
    });
    await loadMoreScripts();
    expect(get(library).scripts.length).toBe(1499);

    requests = [];
    setInvokeForTesting(paged(3000));
    await loadMoreScripts();
    expect((requests[0]?.args?.['page'] as { page: number }).page).toBe(3);
  });

  it('re-reads as deep as the list was when it reloads', async () => {
    /*
     * Returning from the editor calls `loadLibrary()`. It used to read page 0
     * only, so a list scrolled to row 700 snapped back to 500 rows — taking the
     * selection with it, because a selected id no longer in the list falls back
     * to the first row. §10.2 names that journey by hand.
     */
    setInvokeForTesting(paged(1400));
    setLibraryView('trash');
    setLibraryView('all');
    await loadLibrary();
    await loadMoreScripts();
    expect(get(library).scripts).toHaveLength(1000);

    requests = [];
    await loadLibrary();
    expect(requests[0]?.args?.['page']).toEqual({ page: 0, pageSize: 1000 });
    expect(get(library).scripts).toHaveLength(1000);
  });

  it('drops back to one page when the query underneath it changes', async () => {
    setInvokeForTesting(paged(1400));
    setLibraryView('trash');
    setLibraryView('all');
    await loadLibrary();
    await loadMoreScripts();

    requests = [];
    setLibraryQuery('interview');
    await loadLibrary();
    // A search is a different list: re-reading two pages of it would be both a
    // larger read than the screen can use and a cursor into pages that the new
    // result set may not have.
    expect(requests[0]?.args?.['page']).toEqual({ page: 0, pageSize: 500 });
  });
});
