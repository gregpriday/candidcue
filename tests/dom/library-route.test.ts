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
import { loadLibrary, setLibraryQuery, setLibraryView } from '../../src/control/stores/library';
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
