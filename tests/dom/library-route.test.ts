/**
 * What the library screen shows when the read behind it failed.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS FILE EXISTS FOR
 * ---------------------------------------------------------------------------
 * `loadLibrary` caught its failures into `state.error`, and the template never
 * mentioned that field. So a boot-time database read error left `scripts` at
 * `[]` and fell through to the branch below it — the first-run creation state:
 *
 *     "Write the words. CandidCue keeps your place."
 *     [ Create a script ]  [ Import Markdown ]  [ Try a sample script ]
 *
 * A failure to read presented as every script you had being gone, followed by
 * an invitation to start over. That is not a wording problem; it is the wrong
 * screen, and only a mounted route can prove which screen is up.
 *
 * The store is a module singleton, so each test drives the real route through
 * the real store against a fake IPC layer, exactly as the app does.
 *
 * No jest-dom here (see `vitest.dom.config.ts`) — assertions are plain DOM
 * reads.
 */
import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setInvokeForTesting, type InvokeFn } from '../../src/control/services/ipc';
import { get } from 'svelte/store';
import {
  library,
  loadLibrary,
  setLibraryQuery,
  setLibraryView,
} from '../../src/control/stores/library';
import { showToast } from '../../src/control/stores/toasts';
import Library from '../../src/control/routes/Library.svelte';
import type { ScriptSummary } from '../../src/shared/contracts';

vi.mock('../../src/control/stores/toasts', () => ({
  showToast: vi.fn(),
  dismissToast: vi.fn(),
  dismissToastByKey: vi.fn(),
  clearConditionToasts: vi.fn(),
  toasts: { subscribe: () => () => {} },
}));

const confirm = vi.hoisted(() => ({
  // Typed with its argument so the assertions below can read the request back.
  requestConfirm: vi.fn(async (_request: { title: string; body: string }) => false),
}));

/**
 * The shortcut handler the route registers, captured so a test can fire an
 * action directly instead of synthesising the keystroke that produces it.
 */
const shortcuts = vi.hoisted(() => {
  const handlers = new Set<(action: string) => void>();
  return {
    handlers,
    onShortcut: (handler: (action: string) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    fire: (action: string) => {
      for (const handler of handlers) handler(action);
    },
  };
});
vi.mock('../../src/control/lib/shortcuts', () => ({ onShortcut: shortcuts.onShortcut }));

const take = vi.hoisted(() => ({ startTake: vi.fn(async () => {}) }));
vi.mock('../../src/control/lib/start-take', () => ({ startTake: take.startTake }));
vi.mock('../../src/control/stores/confirm', () => ({
  requestConfirm: confirm.requestConfirm,
  pendingConfirm: { subscribe: () => () => {} },
  settleConfirm: vi.fn(),
}));

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
    scriptRevision: 1,
  };
}

const unreadable = { code: 'SCRIPT_FILE_MISSING', userMessage: 'the row could not be read' };

function serving(items: ScriptSummary[], total = items.length): InvokeFn {
  return async <T,>(): Promise<T> => ({ items, total }) as T;
}

function failing(): InvokeFn {
  return async <T,>(): Promise<T> => {
    throw unreadable;
  };
}

/** Mount the route and let the `$effect`'s load settle. */
async function mount(): Promise<HTMLElement> {
  const { container } = render(Library);
  await settle();
  return container;
}

/**
 * Let the route's `$effect` fire, its `loadLibrary` resolve, and Svelte flush.
 *
 * Three rounds because the chain is three hops deep: effect → IPC promise →
 * store update → render. One `tick()` covers the last hop only.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tick();
  }
}

function text(container: HTMLElement): string {
  return container.textContent ?? '';
}

function buttonNamed(container: HTMLElement, name: string): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll('button')).find(
      (button) => (button.textContent ?? '').trim() === name,
    ) ?? null
  );
}

beforeEach(async () => {
  confirm.requestConfirm.mockReset();
  confirm.requestConfirm.mockResolvedValue(false);
  shortcuts.handlers.clear();
  take.startTake.mockClear();
  setInvokeForTesting(serving([summary('a', 'Alpha'), summary('b', 'Bravo')]));
  setLibraryQuery('');
  setLibraryView('all');
  await loadLibrary();
});

afterEach(async () => {
  setLibraryQuery('');
  setLibraryView('all');
  await loadLibrary();
  setInvokeForTesting(null);
  vi.clearAllMocks();
});

/** A cold start that fails: no rows have ever arrived. */
async function bootWithoutRows(): Promise<void> {
  setInvokeForTesting(failing());
  // A view change drops the rows, which is the state a real boot begins in.
  setLibraryView('all');
  await loadLibrary();
}

describe('a read that failed is not an empty library', () => {
  it('says the scripts could not be loaded, and never offers to start over', async () => {
    await bootWithoutRows();
    const container = await mount();

    expect(text(container)).toContain('Scripts could not be loaded');
    // The exact copy of the state this used to fall through to.
    expect(text(container)).not.toContain('Write the words');
    expect(buttonNamed(container, 'Create a script')).toBeNull();
    expect(buttonNamed(container, 'Try again')).not.toBeNull();
  });

  it('shows the authored reason rather than the object it rejected with', async () => {
    await bootWithoutRows();
    const container = await mount();

    // `String(err)` on an AppError payload rendered exactly this.
    expect(text(container)).toContain('The file behind this script is missing');
    expect(text(container)).not.toContain('[object Object]');
    expect(text(container)).not.toMatch(/\b[A-Z][A-Z0-9]*(_[A-Z0-9]+)+\b/);
  });

  it('retries the read from the button', async () => {
    await bootWithoutRows();
    const container = await mount();

    setInvokeForTesting(serving([summary('a', 'Alpha')]));
    buttonNamed(container, 'Try again')?.click();
    await settle();

    expect(text(container)).not.toContain('Scripts could not be loaded');
    expect(text(container)).toContain('Alpha');
  });

  it('keeps the stale rows under a notice when a refresh fails', async () => {
    const container = await mount();
    expect(text(container)).toContain('Alpha');

    setInvokeForTesting(failing());
    await loadLibrary();
    await settle();

    // The list is stale, not wrong — it stays, and says why.
    expect(text(container)).toContain('Alpha');
    expect(text(container)).toContain('Scripts could not be refreshed');
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
});

describe('what an empty result is allowed to claim', () => {
  it('says no match, not that the Trash is empty, when a search misses in Trash', async () => {
    setInvokeForTesting(serving([]));
    setLibraryView('trash');
    setLibraryQuery('nothing like this');
    await loadLibrary();
    const container = await mount();

    expect(text(container)).toContain('No matching scripts');
    // A far larger claim about the one place a deleted script is recoverable.
    expect(text(container)).not.toContain('Trash is empty');
  });

  it('still says the Trash is empty when it actually is', async () => {
    setInvokeForTesting(serving([]));
    setLibraryView('trash');
    await loadLibrary();
    const container = await mount();

    expect(text(container)).toContain('Trash is empty');
  });
});

describe('the size of the list is stated rather than hidden', () => {
  it('names how many there are when only a page of them is shown', async () => {
    setInvokeForTesting(serving([summary('a', 'Alpha')], 617));
    await loadLibrary();
    const container = await mount();

    expect(text(container)).toContain('Showing 1 of 617 scripts.');
  });

  it('says nothing when the whole list is on screen', async () => {
    const container = await mount();
    expect(text(container)).not.toContain('Showing');
  });
});

describe('the destructive confirmations name what they are about to remove', () => {
  it('names the script in a permanent delete', async () => {
    setInvokeForTesting(serving([summary('a', 'Launch keynote')]));
    setLibraryView('trash');
    await loadLibrary();
    const container = await mount();

    const menu = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
    menu?.click();
    await settle();
    buttonNamed(container, 'Delete permanently')?.click();
    await settle();

    expect(confirm.requestConfirm).toHaveBeenCalledTimes(1);
    expect(confirm.requestConfirm.mock.calls[0]?.[0].body).toContain('Launch keynote');
  });

  it('counts the whole Trash, not the rows a search has left on screen', async () => {
    // Emptying the Trash while a search narrows it used to be confirmed against
    // the filtered list — an undercount in front of an action with no undo.
    const fake: InvokeFn = async <T,>(
      _command: string,
      args?: Record<string, unknown>,
    ): Promise<T> => {
      const filter = args?.filter as { query?: string } | undefined;
      if (filter?.query !== undefined) return { items: [summary('a')], total: 1 } as T;
      return { items: Array.from({ length: 40 }, (_, i) => summary(`t${i}`)), total: 40 } as T;
    };
    setInvokeForTesting(fake);
    setLibraryView('trash');
    setLibraryQuery('alpha');
    await loadLibrary();
    const container = await mount();

    buttonNamed(container, 'Empty Trash')?.click();
    await settle();

    expect(confirm.requestConfirm).toHaveBeenCalledTimes(1);
    expect(confirm.requestConfirm.mock.calls[0]?.[0].body).toContain('40 scripts');
  });
});

describe('a Trash row does not pretend its body is a button', () => {
  it('withholds the interactive treatment the card gives a clickable row', async () => {
    setInvokeForTesting(serving([summary('a', 'Alpha')]));
    setLibraryView('trash');
    await loadLibrary();
    const container = await mount();

    const card = container.querySelector('.card');
    expect(card).not.toBeNull();
    // `ScriptCard` reads `Boolean(onopen ?? onselect)`, so a no-op function
    // still bought the row a hover lift and a focus edge over a dead target.
    expect(card?.classList.contains('interactive')).toBe(false);
  });

  it('keeps the treatment on a live row', async () => {
    const container = await mount();
    expect(container.querySelector('.card')?.classList.contains('interactive')).toBe(true);
  });
});

describe('the Present shortcut says what it did', () => {
  it('refuses a trashed script and explains, rather than staging it', async () => {
    setInvokeForTesting(serving([summary('a', 'Alpha')]));
    setLibraryView('trash');
    await loadLibrary();
    await mount();

    shortcuts.fire('present');
    await settle();

    expect(take.startTake).not.toHaveBeenCalled();
    expect(vi.mocked(showToast)).toHaveBeenCalledWith(
      'Scripts in Trash cannot be presented. Restore one first.',
      'info',
    );
  });

  it('says so when there is no target at all', async () => {
    setInvokeForTesting(serving([]));
    setLibraryView('all');
    await loadLibrary();
    await mount();

    shortcuts.fire('present');
    await settle();

    expect(take.startTake).not.toHaveBeenCalled();
    expect(vi.mocked(showToast)).toHaveBeenCalledWith(
      'There is no script to present yet.',
      'info',
    );
  });

  it('still stages the target it does have', async () => {
    await mount();
    shortcuts.fire('present');
    await settle();
    expect(take.startTake).toHaveBeenCalledWith('a');
  });
});

describe('exporting reports itself once, from the helper that knows', () => {
  it('never adds a second, unconditional success notice', async () => {
    // `exportScriptToFile` returns quietly on a cancelled dialog and reports
    // warnings, success and failure itself. The route toasted "Export ready" on
    // top of that, unconditionally — so a cancelled dialog and a failed write
    // both ended in a success notice.
    setInvokeForTesting(async <T,>(command: string): Promise<T> => {
      // A real export result, so the helper takes its own success path and the
      // assertion below is about a duplicate notice rather than a failure.
      if (command === 'export_script') {
        return { path: '/tmp/alpha.md', format: 'markdown', warnings: [] } as T;
      }
      return { items: [summary('a', 'Alpha')], total: 1 } as T;
    });
    await loadLibrary();
    const container = await mount();
    const menu = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
    menu?.click();
    await settle();
    buttonNamed(container, 'Export Markdown')?.click();
    await settle();

    const said = vi.mocked(showToast).mock.calls.map((call) => String(call[0]));
    expect(said).not.toContain('Export ready');
    // The helper's own notice is the one that should be there, exactly once.
    expect(said.filter((message) => message === 'Script exported')).toHaveLength(1);
  });
});

describe('Recent is not a first run', () => {
  it('says nothing has been opened rather than nothing has been written', async () => {
    // A library can hold fifty scripts and have opened none of them.
    setInvokeForTesting(serving([]));
    setLibraryView('recent');
    await loadLibrary();
    const container = await mount();

    expect(text(container)).toContain('No recent scripts');
    expect(text(container)).not.toContain('Write the words');
    expect(buttonNamed(container, 'Create a script')).toBeNull();
  });
});

describe('Empty Trash stays reachable when the count is unknown', () => {
  it('offers the action, then names the set it actually read', async () => {
    // 40 scripts in Trash, a search matching none of them, and the cheap
    // unfiltered count probe rejecting. The action used to vanish over a full
    // Trash. It is now offered, and the confirmation counts what it enumerates
    // rather than the probe that failed.
    const trashed = Array.from({ length: 40 }, (_, i) => summary(`t${i}`));
    const fake: InvokeFn = async <T,>(
      _command: string,
      args?: Record<string, unknown>,
    ): Promise<T> => {
      const filter = args?.filter as { query?: string } | undefined;
      const page = args?.page as { pageSize: number } | undefined;
      if (filter?.query !== undefined) return { items: [], total: 0 } as T;
      // The count probe asks for one row; that is the read failing here.
      if (page?.pageSize === 1) throw unreadable;
      return { items: trashed, total: trashed.length } as T;
    };
    setInvokeForTesting(fake);
    setLibraryView('trash');
    setLibraryQuery('matches nothing');
    await loadLibrary();
    const container = await mount();

    const button = buttonNamed(container, 'Empty Trash');
    expect(button).not.toBeNull();

    button?.click();
    await settle();
    expect(confirm.requestConfirm.mock.calls[0]?.[0].body).toContain('40 scripts');
  });

  it('says the Trash is already empty rather than confirming a deletion of nothing', async () => {
    // The count probe fails, so the button is offered on the generous "we do
    // not know it is empty" predicate — and the Trash then turns out to be
    // empty after all. The destructive sheet must not appear over nothing.
    const fake: InvokeFn = async <T,>(
      _command: string,
      args?: Record<string, unknown>,
    ): Promise<T> => {
      const page = args?.page as { pageSize: number } | undefined;
      if (page?.pageSize === 1) throw unreadable;
      return { items: [], total: 0 } as T;
    };
    setInvokeForTesting(fake);
    setLibraryView('trash');
    setLibraryQuery('matches nothing');
    await loadLibrary();
    const container = await mount();

    buttonNamed(container, 'Empty Trash')?.click();
    await settle();

    expect(confirm.requestConfirm).not.toHaveBeenCalled();
    expect(vi.mocked(showToast)).toHaveBeenCalledWith('Trash is already empty.', 'info');
  });
});

describe('the search field and the results it filtered agree', () => {
  it('comes back carrying the query the store is still filtering by', async () => {
    // The store outlives the route. Opening a script from a set of results and
    // returning used to restore the filtered list under an empty search box,
    // ⌘K hint and all, as though nothing had been typed.
    setInvokeForTesting(serving([summary('a', 'Alpha')]));
    setLibraryQuery('keynote');
    await loadLibrary();
    const container = await mount();

    const input = container.querySelector<HTMLInputElement>('input.search-input');
    expect(input?.value).toBe('keynote');
  });

  it('drops a pending search when the route goes away', async () => {
    vi.useFakeTimers();
    try {
      const { container, unmount } = render(Library);
      const input = container.querySelector<HTMLInputElement>('input.search-input');
      if (input) input.value = 'half typed';
      input?.dispatchEvent(new Event('input', { bubbles: true }));

      unmount();
      // The debounce would otherwise land 180ms from here, set the singleton's
      // query and start a load for a screen nobody is looking at.
      vi.advanceTimersByTime(1000);
      expect(get(library).query).not.toBe('half typed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets go of the shortcut handler on the way out', async () => {
    const { unmount } = render(Library);
    await settle();
    expect(shortcuts.handlers.size).toBe(1);
    unmount();
    expect(shortcuts.handlers.size).toBe(0);
  });
});

describe('the search field leads somewhere', () => {
  it('moves focus into the results on ArrowDown', async () => {
    const container = await mount();
    const input = container.querySelector<HTMLInputElement>('input.search-input');
    expect(input).not.toBeNull();
    input?.focus();

    input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await settle();

    const first = container.querySelector<HTMLButtonElement>('button.main');
    expect(document.activeElement).toBe(first);
  });

  it('lands on Restore in Trash, where the card body does nothing', async () => {
    setInvokeForTesting(serving([summary('a', 'Alpha')]));
    setLibraryView('trash');
    await loadLibrary();
    const container = await mount();

    const input = container.querySelector<HTMLInputElement>('input.search-input');
    input?.focus();
    input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await settle();

    expect((document.activeElement as HTMLElement | null)?.textContent?.trim()).toBe('Restore');
  });

  it('leaves focus alone when there is nothing to move to', async () => {
    setInvokeForTesting(serving([]));
    await loadLibrary();
    const container = await mount();

    const input = container.querySelector<HTMLInputElement>('input.search-input');
    input?.focus();
    input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await settle();

    expect(document.activeElement).toBe(input);
  });
});
