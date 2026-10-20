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
  separated?: boolean;
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

/**
 * Open the way a MOUSE does.
 *
 * `HTMLElement.click()` dispatches a click with `detail: 0`, which is what the
 * browser produces for Enter/Space on a button — not for a pointer. The component
 * reads exactly that field to decide whether to show the highlight, so a test
 * using the bare `.click()` would be asserting the keyboard path while claiming to
 * test the mouse. A click count of one is what a real press carries — and the
 * whole sequence is sent, because the menu opens on the mousedown and has to
 * survive the click that follows it.
 */
async function openByClick() {
  await press();
  release();
  await tick();
}

/** The button going down, and nothing after it. */
async function press(init: MouseEventInit = {}): Promise<MouseEvent> {
  const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, detail: 1, ...init });
  trigger().dispatchEvent(event);
  flushSync();
  await tick();
  await tick();
  return event;
}

/** The button coming back up over the trigger: a mouseup, then the click it completes. */
function release() {
  trigger().dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, detail: 1 }));
  trigger().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  flushSync();
}

/** Open the way Enter or Space does — the browser synthesises a detail-0 click. */
async function openByActivationKey() {
  trigger().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
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

/**
 * The press opens it, as a Mac menu does — not the release.
 */
describe('OverflowMenu — opens on the press', () => {
  const isOpen = () => document.querySelector('[role="menu"]') !== null;

  it('is open while the button is still down', async () => {
    renderMenu(items({ label: 'Rename' }, { label: 'Delete' }));
    await press();
    expect(isOpen()).toBe(true);
    expect(document.activeElement?.textContent?.trim()).toBe('Rename');
  });

  it('stays open when the button comes back up', async () => {
    // The release still sends a click; answering it too would close the menu
    // the press had just opened.
    renderMenu(items({ label: 'Rename' }));
    await press();
    release();
    await tick();
    expect(isOpen()).toBe(true);
  });

  it('cancels the press, whose default would take focus back off the item', async () => {
    renderMenu(items({ label: 'Rename' }));
    const event = await press();
    expect(event.defaultPrevented).toBe(true);
  });

  it('a second press on the trigger closes it', async () => {
    renderMenu(items({ label: 'Rename' }));
    await openByClick();
    await press();
    expect(isOpen()).toBe(false);
    release();
    expect(isOpen(), 'the release must not reopen it').toBe(false);
  });

  it('leaves a secondary press alone, Control-click included', async () => {
    renderMenu(items({ label: 'Rename' }));
    expect((await press({ button: 2 })).defaultPrevented).toBe(false);
    expect(isOpen()).toBe(false);
    expect((await press({ ctrlKey: true })).defaultPrevented).toBe(false);
    expect(isOpen()).toBe(false);
  });

  it('a Control-click opens on its click, without a highlight, even after an abandoned press', async () => {
    // Control-click on Windows: the press is left alone, so the click is what
    // opens the menu, and it is still a pointer that did. A press that slid off
    // first left its flag set; the ignored press must clear it, or this click
    // would be taken for that press's release and swallowed.
    renderMenu(items({ label: 'Rename' }));
    await press();
    await pressOn(document.activeElement as Element, 'Escape');
    expect(isOpen()).toBe(false);

    await press({ ctrlKey: true });
    expect(isOpen()).toBe(false);
    release();
    await tick();
    await tick();
    expect(isOpen()).toBe(true);
    expect(menuItems().filter((el) => el.classList.contains('active'))).toHaveLength(0);
  });

  it('reports each open and close once, whichever device opened it', async () => {
    const onopenchange = vi.fn();
    render(OverflowMenu, { props: { items: items({ label: 'Rename' }), onopenchange } });
    flushSync();

    await openByClick();
    await press();
    release();
    expect(onopenchange.mock.calls.map(([open]) => open)).toEqual([true, false]);

    // Opened by Enter, closed by a press: the release must not open it again.
    onopenchange.mockClear();
    await openByActivationKey();
    await press();
    release();
    await tick();
    expect(isOpen()).toBe(false);
    expect(onopenchange.mock.calls.map(([open]) => open)).toEqual([true, false]);
  });

  it('a press that slid off before release does not swallow the next Enter', async () => {
    renderMenu(items({ label: 'Rename' }));
    await press();
    // Released elsewhere, so no click reached the trigger; dismiss and come back
    // by keyboard.
    await pressOn(document.activeElement as Element, 'Escape');
    expect(isOpen()).toBe(false);
    await openByActivationKey();
    expect(isOpen()).toBe(true);
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
    await openByActivationKey();

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
    await openByActivationKey();
    await pressOn(document.activeElement as Element, 'ArrowDown');
    expect(document.activeElement?.textContent?.trim()).toBe('B');
    await pressOn(document.activeElement as Element, 'ArrowDown');
    expect(document.activeElement?.textContent?.trim()).toBe('A');
    await pressOn(document.activeElement as Element, 'ArrowUp');
    expect(document.activeElement?.textContent?.trim()).toBe('B');
  });

  it('hops over a disabled item in the middle', async () => {
    renderMenu(items({ label: 'A' }, { label: 'B', disabled: true }, { label: 'C' }));
    await openByActivationKey();
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

/**
 * The highlight is a separate claim from focus.
 *
 * `tokens.css` rings every focusable control, and this menu moves focus onto an
 * item as soon as it opens — so a mouse-opened menu arrived with its first action
 * wearing a heavy accent box that consumed the popover's padding and overhung its
 * neighbour. Hovering the next item then lit a second highlight under the first
 * one's ring, and the menu read as broken.
 *
 * Focus still has to move (the menu-button pattern requires it, and those tests
 * are above). What must NOT happen is the menu asserting a choice nobody made.
 */
describe('OverflowMenu — the highlight follows the operator, not the focus', () => {
  const active = () => menuItems().filter((el) => el.classList.contains('active'));

  it('a mouse-opened menu highlights nothing, even though focus has moved', async () => {
    renderMenu(items({ label: 'Open' }, { label: 'Duplicate' }));
    await openByClick();
    // Focus is on the first item — that part of the pattern is intact.
    expect(document.activeElement?.textContent?.trim()).toBe('Open');
    // But nothing is painted as chosen.
    expect(active()).toHaveLength(0);
  });

  it('an arrow-opened menu DOES highlight, because a key chose it', async () => {
    renderMenu(items({ label: 'Open' }, { label: 'Duplicate' }));
    await pressOn(trigger(), 'ArrowDown');
    expect(active().map((el) => el.textContent?.trim())).toEqual(['Open']);
  });

  it('arrowing after a mouse open starts painting the highlight', async () => {
    renderMenu(items({ label: 'Open' }, { label: 'Duplicate' }));
    await openByClick();
    expect(active()).toHaveLength(0);
    await pressOn(document.activeElement as Element, 'ArrowDown');
    // The first item: nothing was drawn as chosen, so the first Down chooses
    // the top of the list rather than the row after an invisible focus.
    expect(active().map((el) => el.textContent?.trim())).toEqual(['Open']);
  });

  it('hover moves the one highlight rather than adding a second', async () => {
    renderMenu(items({ label: 'Open' }, { label: 'Duplicate' }, { label: 'Delete' }));
    await pressOn(trigger(), 'ArrowDown');
    expect(active().map((el) => el.textContent?.trim())).toEqual(['Open']);

    menuItems()[2]?.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false }));
    flushSync();
    // Exactly one — the bug was two lit rows at once.
    expect(active().map((el) => el.textContent?.trim())).toEqual(['Delete']);
  });

  it('hovering a disabled item highlights nothing', async () => {
    renderMenu(items({ label: 'Open' }, { label: 'Restore', disabled: true }));
    await pressOn(trigger(), 'ArrowDown');
    menuItems()[1]?.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false }));
    flushSync();
    expect(active().map((el) => el.textContent?.trim())).toEqual(['Open']);
  });

  it('Enter or Space on the trigger highlights, because focus has nothing else to show it', async () => {
    // Both keys reach a button as a click, so the component cannot tell them
    // apart from a press by name — only by click count. Getting this wrong left a
    // keyboard user with focus inside the menu and nothing drawn to say where,
    // since the outline that used to do that job is suppressed. On the Live
    // transport this menu is the only route to "Hard pause — mic off".
    renderMenu(items({ label: 'Open' }, { label: 'Duplicate' }));
    await openByActivationKey();
    expect(document.activeElement?.textContent?.trim()).toBe('Open');
    expect(active().map((el) => el.textContent?.trim())).toEqual(['Open']);
  });

  it('a click carrying a real click count still highlights nothing', async () => {
    // The other side of the same discriminator — this is the pointer path.
    renderMenu(items({ label: 'Open' }, { label: 'Duplicate' }));
    await openByClick();
    expect(document.activeElement?.textContent?.trim()).toBe('Open');
    expect(active()).toHaveLength(0);
  });

  it('reopening after a keyboard open does not remember the highlight', async () => {
    renderMenu(items({ label: 'Open' }, { label: 'Duplicate' }));
    await pressOn(trigger(), 'ArrowDown');
    expect(active()).toHaveLength(1);
    await pressOn(document.activeElement as Element, 'Escape');
    await openByClick();
    expect(active()).toHaveLength(0);
  });
});

/**
 * Which way the popover opens.
 *
 * The menu is absolutely positioned, so it is clipped by the nearest scrolling
 * ancestor — in the library that is `.page`, which scrolls — and the menu on the
 * last visible card was cut off rather than merely running past the window.
 *
 * jsdom reports every rect as zero, so the trigger's is stubbed. That is the
 * whole input to the decision, which is what makes this testable at all: the
 * height is COMPUTED from the item count rather than measured, precisely so the
 * menu does not have to render downwards first and correct itself on the next
 * frame.
 */
describe('OverflowMenu — opening direction', () => {
  /** jsdom's viewport is 768 tall; place the trigger within it. */
  function stubTriggerRect(top: number, bottom: number): void {
    const wrap = document.querySelector('.wrap');
    if (!(wrap instanceof HTMLElement)) throw new Error('no menu wrapper rendered');
    wrap.getBoundingClientRect = () =>
      ({ top, bottom, left: 0, right: 32, width: 32, height: bottom - top, x: 0, y: top }) as DOMRect;
  }

  function menuEl(): HTMLElement {
    const found = document.querySelector<HTMLElement>('[role="menu"]');
    if (!found) throw new Error('menu is not open');
    return found;
  }

  it('opens downward when there is room', async () => {
    renderMenu(items({ label: 'Open' }, { label: 'Duplicate' }));
    stubTriggerRect(60, 92);
    await openByClick();
    expect(menuEl().classList.contains('up')).toBe(false);
  });

  it('opens upward when the space below cannot hold it', async () => {
    renderMenu(items({ label: 'Open' }, { label: 'Duplicate' }));
    // 8px of padding either side plus two 32px items is 80; four pixels of room
    // below is not enough, and there are 720 above.
    stubTriggerRect(728, 760);
    await openByClick();
    expect(menuEl().classList.contains('up')).toBe(true);
  });

  it('stays downward when up is no better', async () => {
    // Taller than the window either way: flipping would swap one clipped edge
    // for another, so the menu keeps the direction that matches the trigger.
    const many = items(...Array.from({ length: 24 }, (_, i) => ({ label: `Item ${i}` })));
    renderMenu(many);
    stubTriggerRect(20, 52);
    await openByClick();
    expect(menuEl().classList.contains('up')).toBe(false);
  });

  it('re-decides on every open rather than remembering', async () => {
    // The row can be scrolled somewhere else entirely between two openings.
    renderMenu(items({ label: 'Open' }, { label: 'Duplicate' }));
    stubTriggerRect(728, 760);
    await openByClick();
    expect(menuEl().classList.contains('up')).toBe(true);

    await pressOn(document.activeElement as Element, 'Escape');
    stubTriggerRect(60, 92);
    await openByClick();
    expect(menuEl().classList.contains('up')).toBe(false);
  });

  it('counts separators in the height it needs', async () => {
    // Four items (128) plus padding (12, the 6px float inset each side) is 140,
    // which fits in the 148 below this trigger. The ruled-off item adds 9 more
    // and it no longer does — so a menu that ignored separators would open
    // downward here and be clipped.
    const list = items(
      { label: 'Open' },
      { label: 'Present' },
      { label: 'Duplicate' },
      { label: 'Move to Trash', danger: true, separated: true },
    );
    renderMenu(list);
    stubTriggerRect(582, 612);
    await openByClick();
    expect(menuEl().classList.contains('up')).toBe(true);
  });
});

describe('OverflowMenu — separators', () => {
  it('rules off a flagged item without joining the focusable set', async () => {
    renderMenu(
      items({ label: 'Open' }, { label: 'Move to Trash', danger: true, separated: true }),
    );
    // From the keyboard, so Open is the drawn starting point and one Down has
    // to cross the separator to reach the next stop.
    await openByActivationKey();

    expect(document.querySelectorAll('[role="separator"]')).toHaveLength(1);
    // The arrows must still see exactly two stops: `menu-nav` indexes `items`,
    // so a separator that counted as an entry would desynchronise all of it.
    expect(menuItems()).toHaveLength(2);
    await pressOn(document.activeElement as Element, 'ArrowDown');
    expect(document.activeElement?.textContent?.trim()).toBe('Move to Trash');
  });

  it('draws no separator when nothing asks for one', async () => {
    renderMenu(items({ label: 'Open' }, { label: 'Duplicate' }));
    await openByClick();
    expect(document.querySelectorAll('[role="separator"]')).toHaveLength(0);
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
