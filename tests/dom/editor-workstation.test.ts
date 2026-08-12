/**
 * The editor as a desktop workstation (desktop refinement §11).
 *
 * What these cover, and why each is worth a mounted test rather than a unit one:
 *
 *   - the LAYOUT persists and is driven from the workspace store, not from
 *     component-local state. That is what lets the View menu toggle it from
 *     outside the route, and what stops it being forgotten on every open.
 *   - the STATUS BAR is present with the outline closed. That is the whole point
 *     of §11.7: closing the rail is what somebody does to concentrate, and it
 *     used to take the compile state with it.
 *   - the toolbar keeps ONE row of chrome, and the formatting row appears only
 *     in the modes that have an editor to format.
 *
 * jsdom performs no layout (see `tests/dom/setup.ts`), so nothing here asserts a
 * measured size — only which elements exist and what state they carry.
 */
import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { setInvokeForTesting, type InvokeFn } from '../../src/control/services/ipc';
import {
  DEFAULT_WORKSPACE,
  updateWorkspace,
  workspace,
} from '../../src/control/stores/workspace';
import Editor from '../../src/control/routes/Editor.svelte';

vi.mock('../../src/control/stores/toasts', () => ({
  showToast: vi.fn(),
  dismissToast: vi.fn(),
  dismissToastByKey: vi.fn(),
  clearConditionToasts: vi.fn(),
  toasts: { subscribe: () => () => {} },
}));

vi.mock('../../src/control/lib/shortcuts', () => ({
  onShortcut: () => () => {},
  isMacPlatform: () => true,
}));

vi.mock('../../src/control/lib/start-take', () => ({
  startTake: vi.fn(async () => true),
  takeStarting: { subscribe: (run: (v: boolean) => void) => (run(false), () => {}) },
}));

const SCRIPT = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  title: 'Launch keynote',
  source: '# Opening\n\nWelcome everyone to the show.\n',
  scriptRevision: 3,
  updatedAt: '2026-07-30T10:00:00.000Z',
  externallyChanged: false,
};

const serving: InvokeFn = async <T,>(command: string): Promise<T> => {
  if (command === 'get_script') return SCRIPT as T;
  if (command === 'list_scripts') return { items: [], total: 0 } as T;
  return null as T;
};

/**
 * Let the route's open effect, its IPC promise, the compile settle timer and
 * Svelte's flush all land. The editor deliberately stays behind a panel until
 * its first compile settles, so a short wait shows "Opening script…" and nothing
 * this file is about.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tick();
  }
}

async function mount(): Promise<HTMLElement> {
  const { container } = render(Editor, { props: { scriptId: SCRIPT.id } });
  await settle();
  return container;
}

beforeEach(() => {
  setInvokeForTesting(serving);
  updateWorkspace({ ...DEFAULT_WORKSPACE });
});

afterEach(() => {
  setInvokeForTesting(null);
  vi.clearAllMocks();
});

describe('the editor layout lives in the workspace store', () => {
  it('starts in the persisted layout rather than always in Edit', async () => {
    updateWorkspace({ editorLayout: 'preview' });
    const container = await mount();

    const segmented = container.querySelector('[aria-label="Editor mode"]');
    expect(segmented).not.toBeNull();
    // The formatting row is for modes with an editor in them.
    expect(container.querySelector('[aria-label="Insert"]')).toBeNull();
  });

  it('offers all three arrangements, including split', async () => {
    const container = await mount();
    const labels = [...container.querySelectorAll('[aria-label="Editor mode"] button')].map(
      (button) => button.textContent?.trim(),
    );
    expect(labels).toEqual(['Edit', 'Preview', 'Both']);
  });

  it('shows the formatting row in Edit and in split, but not in Preview', async () => {
    const container = await mount();
    expect(container.querySelector('[aria-label="Insert"]')).not.toBeNull();

    updateWorkspace({ editorLayout: 'split' });
    await tick();
    expect(container.querySelector('[aria-label="Insert"]')).not.toBeNull();

    updateWorkspace({ editorLayout: 'preview' });
    await tick();
    expect(container.querySelector('[aria-label="Insert"]')).toBeNull();
  });

  it('renders a split divider only in split', async () => {
    const container = await mount();
    const splitter = () =>
      container.querySelector('[role="separator"][aria-label="Editor and preview split"]');
    expect(splitter()).toBeNull();

    updateWorkspace({ editorLayout: 'split' });
    await tick();
    expect(splitter()).not.toBeNull();
  });
});

describe('the outline is an operable pane', () => {
  it('has a resizable divider carrying the ARIA splitter contract', async () => {
    const container = await mount();
    const divider = container.querySelector('[role="separator"][aria-label="Outline width"]');
    expect(divider).not.toBeNull();
    // A window splitter must be focusable and report its range — without these
    // it is a decoration, and §23.1 requires keyboard resize.
    expect(divider?.getAttribute('tabindex')).toBe('0');
    expect(divider?.getAttribute('aria-valuenow')).toBe(String(DEFAULT_WORKSPACE.outlineWidth));
    expect(divider?.getAttribute('aria-valuemin')).not.toBeNull();
    expect(divider?.getAttribute('aria-valuemax')).not.toBeNull();
  });

  it('is hidden when the workspace says so, and the divider goes with it', async () => {
    updateWorkspace({ outlineVisible: false });
    const container = await mount();
    expect(container.querySelector('[aria-label="Outline"]')).toBeNull();
    expect(container.querySelector('[role="separator"][aria-label="Outline width"]')).toBeNull();
  });

  it('is toggled from the store, so the View menu can reach it', async () => {
    const container = await mount();
    expect(container.querySelector('[aria-label="Outline"]')).not.toBeNull();

    updateWorkspace({ outlineVisible: false });
    await tick();
    expect(container.querySelector('[aria-label="Outline"]')).toBeNull();
    expect(get(workspace).outlineVisible).toBe(false);
  });
});

describe('the status bar', () => {
  it('is present with the outline closed', async () => {
    // §11.7's whole reason: closing the rail must not silence the document's
    // state, and closing the rail is exactly what somebody does to concentrate.
    updateWorkspace({ outlineVisible: false });
    const container = await mount();

    const bar = container.querySelector('footer');
    expect(bar).not.toBeNull();
    /*
     * The compile WORKER does not run in jsdom, so the compile state here is
     * "Could not render" rather than a word count. That is the honest state for
     * this environment and it is exactly the kind this test is about: the one
     * status that stops a script rendering must still be visible with the rail
     * closed, which is the failure §11.7 names.
     */
    expect(bar?.textContent ?? '').toMatch(/word|Reading the script|Could not render/);
  });

  it('reports the editor text scale only when it is not 100%', async () => {
    const container = await mount();
    expect(container.querySelector('footer')?.textContent).not.toContain('%');

    updateWorkspace({ documentScale: 1.25 });
    await tick();
    expect(container.querySelector('footer')?.textContent).toContain('125%');
  });
});
