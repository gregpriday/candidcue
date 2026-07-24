/**
 * OverflowMenu.svelte — the WAI-ARIA menu-button pattern, end to end.
 *
 * `tests/unit/control/overflow-menu.test.ts` already covers `menu-nav.ts`, the
 * pure index arithmetic. What it cannot cover is the half that broke: the
 * component declared `role="menu"`/`role="menuitem"` and implemented none of
 * the behaviour those roles promise. Correct arithmetic that nothing calls
 * looks identical in a node-environment test.
 *
 * So everything below is about the wiring: does the trigger announce a popup,
 * does opening actually move `document.activeElement` onto an item, is the
 * roving tabindex reflected in the DOM, does Escape return focus to the
 * trigger, does an outside pointerdown dismiss.
 */
import { render } from '@testing-library/svelte';
import { flushSync, tick } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import OverflowMenu from '../../src/control/components/OverflowMenu.svelte';

interface Item {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onselect: () => void;
}

function items(...specs: Array<Partial<Item> & { label: string }>): Item[] {
  return specs.map((s) => ({ onselect: vi.fn(), ...s })) as Item[];
}

function renderMenu(list: Item[]) {
  const result = render(OverflowMenu, { props: { items: list } });
  flushSync();
  return result;
}

function trigger(): HTMLElement {
  const found = document.querySelector<HTMLElement>('button[aria-haspopup="menu"]');
  if (!found) throw new Error('no menu trigger rendered');
  return found;
}

function menuItems(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}

/** Open by keyboard and let the component's `tick()`-deferred focus land. */
async function pressOn(node: Element, key: string, init: KeyboardEventInit = {}) {
  node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  flushSync();
  await tick();
  await tick();
}

async function openByClick() {
  trigger().click();
  flushSync();
  await tick();
  await tick();
}

describe('OverflowMenu — trigger', () => {
  it('announces that it opens a menu, and tracks open state', async () => {
    renderMenu(items({ label: 'Rename' }, { label: 'Delete', danger: true }));
    expect(trigger().getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    // A menu button is not a toggle button.
    expect(trigger().getAttribute('aria-pressed')).toBeNull();

    await openByClick();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
  });

  it('renders no menu until it is opened', () => {
    renderMenu(items({ label: 'Rename' }));
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});

describe('OverflowMenu — opening moves focus', () => {
  it('a click lands focus on the first enabled item', async () => {
    renderMenu(items({ label: 'Rename' }, { label: 'Delete' }));
    await openByClick();
    expect(menuItems()).toHaveLength(2);
    expect(document.activeElement?.textContent?.trim()).toBe('Rename');
  });

  it('ArrowDown on the trigger opens onto the first item', async () => {
    renderMenu(items({ label: 'Rename' }, { label: 'Delete' }));
    await pressOn(trigger(), 'ArrowDown');
    expect(document.activeElement?.textContent?.trim()).toBe('Rename');
  });

  it('ArrowUp on the trigger opens onto the last item', async () => {
    renderMenu(items({ label: 'Rename' }, { label: 'Duplicate' }, { label: 'Delete' }));
    await pressOn(trigger(), 'ArrowUp');
    expect(document.activeElement?.textContent?.trim()).toBe('Delete');
  });

  it('skips a leading disabled item instead of focusing nothing', async () => {
    renderMenu(items({ label: 'Restore', disabled: true }, { label: 'Delete' }));
    await openByClick();
    expect(document.activeElement?.textContent?.trim()).toBe('Delete');
  });
});

describe('OverflowMenu — the menu is one tab stop', () => {
  it('exactly one item carries tabindex 0, and it is the focused one', async () => {
    renderMenu(items({ label: 'Rename' }, { label: 'Duplicate' }, { label: 'Delete' }));
    await openByClick();

    const tabbable = () => menuItems().filter((el) => el.getAttribute('tabindex') === '0');
    expect(tabbable()).toHaveLength(1);
    expect(tabbable()[0]).toBe(document.activeElement);

    await pressOn(document.activeElement as Element, 'ArrowDown');
    expect(tabbable()).toHaveLength(1);
    expect(tabbable()[0]?.textContent?.trim()).toBe('Duplicate');
    expect(document.activeElement?.textContent?.trim()).toBe('Duplicate');
  });
});

describe('OverflowMenu — arrow navigation', () => {
  it('wraps past the end and before the start', async () => {
    renderMenu(items({ label: 'A' }, { label: 'B' }));
    await openByClick();
    await pressOn(document.activeElement as Element, 'ArrowDown');
    expect(document.activeElement?.textContent?.trim()).toBe('B');
    await pressOn(document.activeElement as Element, 'ArrowDown');
    expect(document.activeElement?.textContent?.trim()).toBe('A');
    await pressOn(document.activeElement as Element, 'ArrowUp');
    expect(document.activeElement?.textContent?.trim()).toBe('B');
  });

  it('hops over a disabled item in the middle', async () => {
    renderMenu(items({ label: 'A' }, { label: 'B', disabled: true }, { label: 'C' }));
    await openByClick();
    await pressOn(document.activeElement as Element, 'ArrowDown');
    expect(document.activeElement?.textContent?.trim()).toBe('C');
  });

  it('Home and End jump to the ends', async () => {
    renderMenu(items({ label: 'A' }, { label: 'B' }, { label: 'C' }));
    await openByClick();
    await pressOn(document.activeElement as Element, 'End');
    expect(document.activeElement?.textContent?.trim()).toBe('C');
    await pressOn(document.activeElement as Element, 'Home');
    expect(document.activeElement?.textContent?.trim()).toBe('A');
  });

  it('swallows the arrow key so the page behind does not scroll', async () => {
    renderMenu(items({ label: 'A' }, { label: 'B' }));
    await openByClick();
    const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    (document.activeElement as Element).dispatchEvent(event);
    flushSync();
    expect(event.defaultPrevented).toBe(true);
  });
});

describe('OverflowMenu — closing', () => {
  it('Escape closes and gives focus back to the trigger', async () => {
    renderMenu(items({ label: 'A' }, { label: 'B' }));
    await openByClick();
    await pressOn(document.activeElement as Element, 'Escape');

    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('Escape does not escape the menu — an outer handler must not also fire', async () => {
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    try {
      renderMenu(items({ label: 'A' }));
      await openByClick();
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      (document.activeElement as Element).dispatchEvent(event);
      flushSync();
      expect(outer, 'a bubbling Escape would also close the dialog the menu sits in').not
        .toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', outer);
    }
  });

  it('Tab dismisses the menu without yanking focus back', async () => {
    renderMenu(items({ label: 'A' }, { label: 'B' }));
    await openByClick();
    const focused = document.activeElement;
    await pressOn(focused as Element, 'Tab');
    expect(document.querySelector('[role="menu"]')).toBeNull();
    // Focus is left where it was so the browser's own Tab moves on from there.
    expect(document.activeElement).not.toBe(trigger());
  });

  it('a pointerdown outside closes it', async () => {
    renderMenu(items({ label: 'A' }));
    await openByClick();
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    flushSync();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('a pointerdown on the menu itself does NOT close it', async () => {
    renderMenu(items({ label: 'A' }));
    await openByClick();
    menuItems()[0]?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    flushSync();
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
  });

  it('stops listening for outside clicks once closed', async () => {
    const list = items({ label: 'A' });
    const { unmount } = renderMenu(list);
    await openByClick();
    await pressOn(document.activeElement as Element, 'Escape');
    unmount();
    flushSync();
    // No listener may survive teardown; this would throw if the handler ran
    // against a torn-down component.
    expect(() =>
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })),
    ).not.toThrow();
  });
});

describe('OverflowMenu — selection', () => {
  it('choosing an item closes the menu, restores focus, then runs the action', async () => {
    const order: string[] = [];
    const list: Item[] = [
      { label: 'Rename', onselect: () => order.push('rename') },
      { label: 'Delete', onselect: () => order.push('delete') },
    ];
    renderMenu(list);
    await openByClick();

    menuItems()[1]?.click();
    flushSync();
    await tick();

    expect(order).toEqual(['delete']);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('a disabled item is disabled in the DOM and cannot be chosen', async () => {
    const onselect = vi.fn();
    renderMenu(items({ label: 'A' }, { label: 'Restore', disabled: true, onselect }));
    await openByClick();

    const restore = menuItems()[1] as HTMLButtonElement;
    expect(restore.disabled).toBe(true);
    restore.click();
    flushSync();
    expect(onselect).not.toHaveBeenCalled();
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
  });
});
