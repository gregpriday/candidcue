/**
 * The desktop layout primitives (desktop refinement §21.1, §18.3, §7.4).
 *
 * These three carry behaviour that no route test would notice going wrong,
 * because each of them fails SILENTLY: a splitter that cannot be focused is
 * still a visible line, a menu whose typeahead eats Space still opens, and a
 * source list with the wrong tab stops still navigates by pointer. Every
 * failure here is one that only a keyboard user ever meets.
 *
 * jsdom performs no layout (see `tests/dom/setup.ts`), so nothing asserts a
 * measured size — only the state and the ARIA contract.
 */
import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import PaneDivider from '../../src/control/components/PaneDivider.svelte';
import ContextMenu from '../../src/control/components/ContextMenu.svelte';
import {
  closeContextMenu,
  contextMenu,
  openContextMenu,
  type ContextMenuItem,
} from '../../src/control/stores/context-menu';

/* ---------------------------------------------------------------- divider -- */

describe('PaneDivider', () => {
  function mount(overrides: Record<string, unknown> = {}) {
    const onresize = vi.fn();
    const oncommit = vi.fn();
    const { container } = render(PaneDivider, {
      props: {
        orientation: 'vertical',
        side: 'leading',
        label: 'Sidebar width',
        value: 240,
        min: 180,
        max: 360,
        defaultValue: 224,
        onresize,
        oncommit,
        ...overrides,
      },
    });
    const el = container.querySelector('[role="separator"]') as HTMLElement;
    return { el, onresize, oncommit };
  }

  it('declares the ARIA window-splitter contract', () => {
    // `role="separator"` WITH `aria-valuenow` is the focusable variant — that is
    // what makes the arrow keys an obligation rather than a nicety (§23.1).
    const { el } = mount();
    expect(el.getAttribute('aria-orientation')).toBe('vertical');
    expect(el.getAttribute('aria-label')).toBe('Sidebar width');
    expect(el.getAttribute('aria-valuenow')).toBe('240');
    expect(el.getAttribute('aria-valuemin')).toBe('180');
    expect(el.getAttribute('aria-valuemax')).toBe('360');
    expect(el.getAttribute('tabindex')).toBe('0');
  });

  it('moves on the arrows, and by more with Shift', () => {
    const { el, onresize } = mount();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(onresize).toHaveBeenLastCalledWith(256);

    el.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }),
    );
    expect(onresize).toHaveBeenLastCalledWith(304);
  });

  it('reverses the arrows for a trailing pane', () => {
    // Dragging right must GROW a left-hand pane and SHRINK a right-hand one, and
    // a keyboard user gets the same mental model as a pointer user.
    const { el, onresize } = mount({ side: 'trailing' });
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(onresize).toHaveBeenLastCalledWith(224);
  });

  it('clamps to the declared range', () => {
    const { el, onresize } = mount({ value: 356 });
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(onresize).toHaveBeenLastCalledWith(360);

    const low = mount({ value: 184 });
    low.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(low.onresize).toHaveBeenLastCalledWith(180);
  });

  it('goes to the extremes on Home and End', () => {
    const { el, onresize } = mount();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(onresize).toHaveBeenLastCalledWith(180);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(onresize).toHaveBeenLastCalledWith(360);
  });

  it('restores the default on Enter, as a double-click does', () => {
    const { el, onresize } = mount();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onresize).toHaveBeenLastCalledWith(224);
  });

  it('commits immediately on a keypress', () => {
    // A keypress is a whole gesture, not the middle of one — there is no pointer
    // release to wait for, so the persisted write happens now.
    const { el, oncommit } = mount();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(oncommit).toHaveBeenCalledWith(256);
  });

  it('ignores keys it does not own', () => {
    const { el, onresize } = mount();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    // A vertical divider does not answer the vertical arrows.
    expect(onresize).not.toHaveBeenCalled();
  });

  it('answers the vertical arrows when horizontal', () => {
    const { el, onresize } = mount({ orientation: 'horizontal' });
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(onresize).toHaveBeenLastCalledWith(256);
  });
});

/* ----------------------------------------------------------- context menu -- */

describe('ContextMenu', () => {
  let trigger: HTMLButtonElement;

  beforeEach(() => {
    trigger = document.createElement('button');
    trigger.textContent = 'row';
    document.body.appendChild(trigger);
  });

  afterEach(() => {
    closeContextMenu(false);
    trigger.remove();
  });

  function items(): ContextMenuItem[] {
    return [
      { label: 'Open', onselect: vi.fn() },
      { label: 'Duplicate', onselect: vi.fn() },
      { label: 'Delete permanently', danger: true, separated: true, onselect: vi.fn() },
    ];
  }

  async function open(list: ContextMenuItem[] = items()) {
    const { container } = render(ContextMenu);
    openContextMenu({ x: 10, y: 10, label: 'Actions', items: list, trigger });
    await tick();
    await tick();
    return container;
  }

  it('declines to open with nothing to offer', () => {
    // A zero-row popover is a one-pixel box that appears and eats the next click.
    openContextMenu({ x: 0, y: 0, label: 'Actions', items: [], trigger });
    expect(get(contextMenu)).toBeNull();
  });

  it('opens with NOTHING active, so the first arrow lands on the first item', async () => {
    // It used to seed the active index to 0, which made the first ArrowDown move
    // to the SECOND row — and painted a destructive top row as pre-armed.
    const container = await open();
    const rows = [...container.querySelectorAll('[role="menuitem"],[role="menuitemcheckbox"]')];
    expect(rows).toHaveLength(3);
    expect(rows.some((row) => row.classList.contains('active'))).toBe(false);
  });

  it('does not treat Space as typeahead', async () => {
    /*
     * Space is `' '` — one character — so an unqualified length check caught it,
     * called `preventDefault()`, and looked for an item beginning with a space.
     * Space is how a keyboard user ACTIVATES the focused row, so that silently
     * killed half the activation keys.
     */
    const container = await open();
    const menu = container.querySelector('[role="menu"]') as HTMLElement;
    const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    menu.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('jumps by first letter, skipping past the active row', async () => {
    const container = await open();
    const menu = container.querySelector('[role="menu"]') as HTMLElement;
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true }));
    await tick();
    await tick();
    const active = container.querySelector('.item.active');
    expect(active?.textContent).toContain('Duplicate');
  });

  it('closes on Escape and gives focus back to the trigger', async () => {
    const container = await open();
    const menu = container.querySelector('[role="menu"]') as HTMLElement;
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();
    expect(get(contextMenu)).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('leaves focus alone when dismissed by clicking elsewhere', async () => {
    // The user has already chosen where they want to be; yanking focus back to
    // the row they right-clicked would undo it.
    await open();
    const elsewhere = document.createElement('input');
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    closeContextMenu(false);
    await tick();
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it('runs the chosen action and closes', async () => {
    const list = items();
    const container = await open(list);
    const row = [...container.querySelectorAll('[role="menuitem"]')].find((element) =>
      element.textContent?.includes('Duplicate'),
    ) as HTMLElement;
    row.click();
    await tick();
    expect(list[1]?.onselect).toHaveBeenCalledTimes(1);
    expect(get(contextMenu)).toBeNull();
  });

  it('marks a checkable row as menuitemcheckbox', async () => {
    // §18.3: state is a checkmark in a reserved column, not a pill inside a
    // menu row — and the role has to say so or the tick is decoration.
    const container = await open([
      { label: 'Compact rows', checked: true, onselect: vi.fn() },
      { label: 'Comfortable rows', checked: false, onselect: vi.fn() },
    ]);
    const rows = [...container.querySelectorAll('[role="menuitemcheckbox"]')];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.getAttribute('aria-checked')).toBe('true');
    expect(rows[1]?.getAttribute('aria-checked')).toBe('false');
  });

  it('keeps a disabled row visible rather than hiding it', async () => {
    // §10.6: a command whose absence would be confusing stays, greyed.
    const container = await open([
      { label: 'Restore', disabled: true, onselect: vi.fn() },
      { label: 'Open', onselect: vi.fn() },
    ]);
    const disabled = container.querySelector('[role="menuitem"][disabled]');
    expect(disabled?.textContent).toContain('Restore');
  });
});
