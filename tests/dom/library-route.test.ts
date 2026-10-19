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
 *     "Your words. Your pace."
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

/**
 * The router, spied.
 *
 * Opening a script is a NAVIGATION, and "did the route navigate" is the only
 * assertion that actually proves a row opened. The first version of the
 * rewritten tests checked that the mounted Library still contained a listbox
 * afterwards — which is true whether or not `navigate` was called, because these
 * tests mount the route directly rather than through the shell. That is a test
 * that cannot fail.
 */
const router = vi.hoisted(() => ({ navigate: vi.fn(async () => true) }));
vi.mock('../../src/control/stores/router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/control/stores/router')>();
  return { ...actual, navigate: router.navigate };
});
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

/**
 * The overflow trigger on a script ROW, not the toolbar's view-options menu.
 *
 * The desktop pass gave the toolbar its own `aria-haspopup="menu"` button for
 * sort and density, and it comes first in the document — so the unqualified
 * query these tests used to make now opens the wrong menu and finds none of the
 * row's actions. Matched by its accessible name, which the route builds from the
 * script's title, because that is the thing that distinguishes the two.
 */
function rowMenuTrigger(container: HTMLElement): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]')).find(
      (button) => (button.getAttribute('aria-label') ?? '').startsWith('Actions for '),
    ) ?? null
  );
}

beforeEach(async () => {
  router.navigate.mockClear();
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

/**
 * A cold start that fails: no rows have ever arrived.
 *
 * The rows are dropped by CHANGING view and coming back, not by re-selecting
 * the current one. `setLibraryView` used to clear unconditionally, so
 * `setLibraryView('all')` from 'all' happened to reset the store — and this
 * helper leaned on that. It is a no-op refresh now, deliberately: re-choosing
 * the view you are already in is what the sidebar does when you come back from
 * the editor, and clearing there discarded the selection every single time
 * (§10.2 asks for exactly the opposite).
 *
 * Going out to Trash and back is the honest way to reach "no rows have ever
 * arrived", and it exercises the clearing path this file cares about.
 */
async function bootWithoutRows(): Promise<void> {
  setInvokeForTesting(failing());
  setLibraryView('trash');
  setLibraryView('all');
  await loadLibrary();
}

describe('a read that failed is not an empty library', () => {
  it('says the scripts could not be loaded, and never offers to start over', async () => {
    await bootWithoutRows();
    const container = await mount();

    expect(text(container)).toContain('Scripts could not be loaded');
    // The exact copy of the state this used to fall through to.
    expect(text(container)).not.toContain('Your words. Your pace.');
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
  /*
   * The count moved from a line under the list to the STATUS BAR (§10.8), and
   * its wording changed with it: a status bar states what is on screen rather
   * than announcing a limit. What is being guarded is unchanged — the number
   * that matters is how many there are, not where the page ceiling stops.
   */
  it('names how many there are when only a page of them is shown', async () => {
    setInvokeForTesting(serving([summary('a', 'Alpha')], 617));
    await loadLibrary();
    const container = await mount();

    expect(text(container)).toContain('1 of 617 scripts');
  });

  it('states the plain count when the whole list is on screen', async () => {
    const container = await mount();
    expect(text(container)).not.toContain(' of ');
    expect(text(container)).toMatch(/\d+ scripts|1 script/);
  });
});

describe('the destructive confirmations name what they are about to remove', () => {
  it('names the script in a permanent delete', async () => {
    setInvokeForTesting(serving([summary('a', 'Launch keynote')]));
    setLibraryView('trash');
    await loadLibrary();
    const container = await mount();

    // The ROW's overflow, not the toolbar's. The toolbar gained a view-options
    // menu in the desktop pass, and it is the first `aria-haspopup` in the
    // document — so an unqualified query now opens the wrong menu.
    const menu = rowMenuTrigger(container);
    menu?.click();
    await settle();
    buttonNamed(container, 'Delete Permanently')?.click();
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

/*
 * The rows are `ScriptRow` now rather than `ScriptCard`, and Trash rows are
 * selectable — which is the change §10.2 asked for, so that Restore and Delete
 * Permanently have something to act on. What must NOT come back is a Trash row
 * that offers to OPEN: a trashed script has no editor to go to, and the old
 * defect was a body that invited a click and then ignored it.
 */
/*
 * The activation model, which is the whole point of a selection-led collection:
 * one click selects, two clicks (or Enter) open, and Trash never opens.
 *
 * These replace what `script-card-click.test.ts` guarded for the old card. That
 * file's guarantees were event-level — activate exactly once, never twice, never
 * from a nested control — and they matter more here, not less, because a row now
 * carries buttons AND has its own activation.
 */
describe('the row activation model', () => {
  it('selects on a single click and does not open', async () => {
    setInvokeForTesting(serving([summary('a', 'Alpha'), summary('b', 'Bravo')]));
    await loadLibrary();
    const container = await mount();

    const rows = container.querySelectorAll<HTMLElement>('[role="option"]');
    rows[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();

    expect(get(library).selectedId).toBe('b');
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('opens exactly once on a double click', async () => {
    const container = await mount();
    const row = container.querySelector<HTMLElement>('[role="option"]');
    row?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await settle();

    expect(router.navigate).toHaveBeenCalledTimes(1);
    expect(router.navigate).toHaveBeenCalledWith({ name: 'editor', scriptId: 'a' });
  });

  it('opens exactly once on Enter', async () => {
    const container = await mount();
    const row = container.querySelector<HTMLElement>('[role="option"]');
    row?.focus();
    row?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();

    expect(router.navigate).toHaveBeenCalledTimes(1);
  });

  it('never opens a Trash row', async () => {
    setInvokeForTesting(serving([summary('a', 'Alpha')]));
    setLibraryView('trash');
    await loadLibrary();
    const container = await mount();

    const row = container.querySelector<HTMLElement>('[role="option"]');
    expect(row?.getAttribute('aria-selected')).toBe('true');

    row?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    row?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();

    expect(router.navigate).not.toHaveBeenCalled();
  });

  /**
   * The regression both reviewers found: a row's Enter handler swallowed keys
   * pressed on the buttons INSIDE it.
   *
   * Enter on Present opened the script instead of presenting it; in Trash, where
   * there is no open handler, Enter on Restore did nothing at all.
   */
  it('does not open when Enter is pressed on a control inside the row', async () => {
    const container = await mount();
    const present = buttonNamed(container, 'Present');
    expect(present).not.toBeNull();

    present?.focus();
    present?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();

    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('does not move the selection when arrows are pressed inside a row menu', async () => {
    setInvokeForTesting(serving([summary('a', 'Alpha'), summary('b', 'Bravo')]));
    await loadLibrary();
    const container = await mount();
    expect(get(library).selectedId).toBe('a');

    rowMenuTrigger(container)?.click();
    await settle();

    const item = container.querySelector<HTMLElement>('[role="menuitem"]');
    item?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await settle();

    // The list's own handler must not have seen it.
    expect(get(library).selectedId).toBe('a');
  });

  it('does not trash the row when Delete is pressed inside a row menu', async () => {
    const container = await mount();
    rowMenuTrigger(container)?.click();
    await settle();

    const item = container.querySelector<HTMLElement>('[role="menuitem"]');
    item?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    await settle();

    expect(confirm.requestConfirm).not.toHaveBeenCalled();
  });
});

describe('keyboard navigation through the collection', () => {
  async function threeRows(): Promise<HTMLElement> {
    setInvokeForTesting(
      serving([summary('a', 'Alpha'), summary('b', 'Bravo'), summary('c', 'Charlie')]),
    );
    await loadLibrary();
    return mount();
  }

  it('moves the selection with the arrows and stops at the ends', async () => {
    const container = await threeRows();
    const row = () => container.querySelector<HTMLElement>('[aria-selected="true"]');

    row()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await settle();
    expect(get(library).selectedId).toBe('b');

    row()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await settle();
    expect(get(library).selectedId).toBe('a');

    // Already at the top: ArrowUp must not wrap to the bottom. A collection
    // that wraps makes Home and End meaningless.
    row()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await settle();
    expect(get(library).selectedId).toBe('a');
  });

  it('jumps to the ends with Home and End', async () => {
    const container = await threeRows();
    const row = () => container.querySelector<HTMLElement>('[aria-selected="true"]');

    row()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    await settle();
    expect(get(library).selectedId).toBe('c');

    row()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    await settle();
    expect(get(library).selectedId).toBe('a');
  });

  it('asks before trashing on Delete, naming the row', async () => {
    const container = await threeRows();
    const row = container.querySelector<HTMLElement>('[aria-selected="true"]');
    row?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    await settle();

    expect(confirm.requestConfirm).toHaveBeenCalledTimes(1);
    expect(confirm.requestConfirm.mock.calls[0]?.[0].body).toContain('Alpha');
  });

  it('asks only once when Delete is held', async () => {
    // `requestConfirm` replaces its singleton without resolving the request it
    // displaces, so a repeat would strand the first await for ever.
    const container = await threeRows();
    const row = container.querySelector<HTMLElement>('[aria-selected="true"]');
    row?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    row?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    row?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    await settle();

    expect(confirm.requestConfirm).toHaveBeenCalledTimes(1);
  });

  /**
   * The tab model, counted HONESTLY.
   *
   * The first version of this asserted "a single tab stop" and counted only
   * `role="option"` elements — so it could never have seen the row action
   * buttons, which are the whole question. What is actually true, and what
   * matters, is that the number of stops does not grow with the list: exactly
   * one row is tabbable, and the selected row's two actions are reachable
   * because they are the only ones visible.
   */
  it('keeps its tab stops constant however long the list is', async () => {
    const container = await threeRows();
    const rows = [...container.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(rows).toHaveLength(3);

    const tabbableRows = rows.filter((r) => r.getAttribute('tabindex') === '0');
    expect(tabbableRows).toHaveLength(1);
    expect(tabbableRows[0]?.getAttribute('aria-selected')).toBe('true');

    /*
     * Every row's buttons are in the DOM, but only the SELECTED row's are
     * visible — `visibility: hidden` is not focusable, so the others are not
     * tab stops. jsdom resolves no stylesheets, so the rule cannot be read here;
     * what is asserted instead is the structural fact it depends on, that the
     * actions live inside the row and are governed by its selected state.
     */
    const selectedRow = tabbableRows[0]!;
    expect(selectedRow.querySelectorAll('button').length).toBeGreaterThan(0);
    expect(selectedRow.classList.contains('selected')).toBe(true);
    const unselected = rows.find((r) => r.getAttribute('aria-selected') !== 'true')!;
    expect(unselected.classList.contains('selected')).toBe(false);
  });

  it('marks selection and focus as separate things', async () => {
    // §23.3: a list where selected-and-focused looks the same as
    // selected-but-not-focused tells a keyboard user nothing.
    const container = await threeRows();
    const row = container.querySelector<HTMLElement>('[aria-selected="true"]');
    expect(row?.classList.contains('selected')).toBe(true);
    // `list-focused` is applied only while focus is inside the list.
    expect(row?.classList.contains('list-focused')).toBe(false);
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
    // Through the readiness check (#301), which a healthy setup passes
    // straight through; its options are the Library's, which are none.
    expect(take.startTake).toHaveBeenCalledWith('a', {});
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
    const menu = rowMenuTrigger(container);
    menu?.click();
    await settle();
    buttonNamed(container, 'Export Markdown…')?.click();
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
    expect(text(container)).not.toContain('Your words. Your pace.');
    expect(buttonNamed(container, 'Create a script')).toBeNull();
  });

  it('keeps the invitation for a library that really is empty', async () => {
    // The refusals in this file are worth something only while this is the
    // copy a first run actually shows; reworded, they would pass vacuously.
    setInvokeForTesting(serving([]));
    await loadLibrary();
    const container = await mount();

    expect(text(container)).toContain('Your words. Your pace.');
    expect(text(container)).toContain('Write or import a Markdown script.');
    expect(buttonNamed(container, 'Create a script')).not.toBeNull();
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
  /*
   * ArrowDown now SELECTS the first result rather than focusing a button inside
   * it. That is the point of the collection model: the key that carries you out
   * of the search box has to leave you somewhere the next keystroke means
   * something, and in a selection-led list that is the selected row — from
   * which the arrows keep working, Enter opens, and Delete trashes.
   *
   * It works identically in Trash, which is the other half of what changed:
   * there used to be no selectable target there at all, so the key had to aim at
   * the row's Restore button instead.
   */
  it('selects the first result on ArrowDown', async () => {
    const container = await mount();
    const input = container.querySelector<HTMLInputElement>('input.search-input');
    expect(input).not.toBeNull();
    input?.focus();

    input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await settle();

    const selected = container.querySelector('[aria-selected="true"]');
    expect(selected).not.toBeNull();
  });

  it('selects the first Trash row too', async () => {
    setInvokeForTesting(serving([summary('a', 'Alpha')]));
    setLibraryView('trash');
    await loadLibrary();
    const container = await mount();

    const input = container.querySelector<HTMLInputElement>('input.search-input');
    input?.focus();
    input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await settle();

    expect(container.querySelector('[aria-selected="true"]')?.textContent).toContain('Alpha');
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
