/**
 * The sidebar as a desktop source list (desktop refinement §7).
 *
 * The two properties worth pinning are both invisible to a pointer user:
 *
 *   - ONE tab stop. Five separate ones would mean four presses of Tab to get
 *     past a navigation rail on the way to the content, every time.
 *   - arrows and first-letter navigation inside it, which is what makes the
 *     single tab stop workable rather than merely tidy.
 *
 * The visual half — no raised pill, no hover elevation — is asserted in
 * `tests/unit/control/design-system-tokens.test.ts`, which reads the stylesheet
 * directly and does not need a DOM.
 */
import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setInvokeForTesting, type InvokeFn } from '../../src/control/services/ipc';
import { setLibraryView } from '../../src/control/stores/library';
import Sidebar from '../../src/control/components/Sidebar.svelte';

vi.mock('../../src/control/stores/toasts', () => ({
  showToast: vi.fn(),
  dismissToast: vi.fn(),
  dismissToastByKey: vi.fn(),
  clearConditionToasts: vi.fn(),
  toasts: { subscribe: () => () => {} },
}));

const serving: InvokeFn = async <T,>(): Promise<T> => ({ items: [], total: 0 }) as T;

function rows(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('.nav-item')];
}

beforeEach(() => {
  setInvokeForTesting(serving);
  setLibraryView('all');
});

afterEach(() => {
  setInvokeForTesting(null);
  vi.clearAllMocks();
});

async function mount(): Promise<HTMLElement> {
  const { container } = render(Sidebar, { props: { onnew: vi.fn(), onsettings: vi.fn() } });
  await tick();
  return container;
}

describe('the sidebar source list', () => {
  it('offers New Script, the three views, and Settings', async () => {
    const container = await mount();
    expect(rows(container).map((row) => row.textContent?.trim())).toEqual([
      'New script',
      'All scripts',
      'Recent',
      'Trash',
      'Settings',
    ]);
  });

  it('no longer carries a Keyboard shortcuts row or a version line', async () => {
    /*
     * Both moved out (§7.1, §31.4): Shortcuts is Help › Keyboard Shortcuts and
     * ⌘/, and the version belongs in About. The rail is for places you go, and
     * permanent chrome for two things the native menu publishes is exactly what
     * §31.4 says not to keep here.
     */
    const container = await mount();
    const text = container.textContent ?? '';
    expect(text).not.toContain('Keyboard shortcuts');
    expect(text).not.toMatch(/Speaking Glass \d/);
  });

  it('is a single tab stop, anchored on the current route', async () => {
    const container = await mount();
    const tabbable = rows(container).filter((row) => row.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    // …and it is the row for the view that is current, not the first row.
    expect(tabbable[0]?.textContent?.trim()).toBe('All scripts');
  });

  it('moves focus with the arrows and wraps', async () => {
    const container = await mount();
    const list = rows(container);
    list[1]?.focus();

    list[1]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(list[2]);

    list[2]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement).toBe(list[1]);

    // Wrapping: up from the first row reaches the last.
    list[0]?.focus();
    list[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement).toBe(list[list.length - 1]);
  });

  it('goes to the ends with Home and End', async () => {
    const container = await mount();
    const list = rows(container);
    list[2]?.focus();
    list[2]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement).toBe(list[list.length - 1]);

    list[list.length - 1]?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
    );
    expect(document.activeElement).toBe(list[0]);
  });

  it('jumps by first letter', async () => {
    const container = await mount();
    const list = rows(container);
    list[0]?.focus();
    list[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true }));
    expect(document.activeElement?.textContent?.trim()).toBe('Trash');
  });

  it('ignores a modified letter, which is a command rather than a jump', async () => {
    const container = await mount();
    const list = rows(container);
    list[0]?.focus();
    list[0]?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 't', metaKey: true, bubbles: true }),
    );
    expect(document.activeElement).toBe(list[0]);
  });

  it('marks the current route with aria-current, distinct from focus', async () => {
    // §7.4: focus and the active route must be tellable apart. `aria-current`
    // says where you ARE; focus says where the next Enter would take you.
    const container = await mount();
    const current = container.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent?.trim()).toBe('All scripts');

    const list = rows(container);
    list[3]?.focus();
    expect(document.activeElement).toBe(list[3]);
    // Focusing Trash did not make it current — nothing navigated.
    expect(container.querySelectorAll('[aria-current="page"]')[0]?.textContent?.trim()).toBe(
      'All scripts',
    );
  });

  it('carries a divider between the collection views and Settings', async () => {
    const container = await mount();
    expect(container.querySelector('.rule')).not.toBeNull();
  });
});
