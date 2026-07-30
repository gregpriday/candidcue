/**
 * SplitButton.svelte — the two halves, and the menu behaviour that only exists
 * once it is mounted.
 *
 * The keyboard ARITHMETIC is `menu-nav.ts` and is already covered as pure logic.
 * What cannot be covered there is whether this component actually calls it, and
 * the wiring it does NOT share with OverflowMenu: the primary half, the
 * pointer-versus-keyboard highlight, the outside-click close, and the effect
 * that shuts an open menu when the button goes disabled.
 *
 * That last one matters more than it looks. The button disables itself while a
 * take is opening, and a menu left painted over a control that no longer does
 * anything is an invitation to click into a take that has already started.
 *
 * No `@testing-library/jest-dom` here, deliberately — it extends chai at import
 * time and produces "Invalid Chai property" when files share a worker. Plain
 * DOM reads only.
 */
import { render } from '@testing-library/svelte';
import { flushSync, type ComponentProps } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import SplitButton from '../../src/control/components/SplitButton.svelte';

type Props = ComponentProps<typeof SplitButton>;

function renderSplit(overrides: Partial<Props> = {}) {
  const onclick = vi.fn();
  const chooseFullScreen = vi.fn();
  const chooseWindow = vi.fn();
  const props: Props = {
    label: 'Present',
    menuLabel: 'How to present',
    variant: 'primary',
    onclick,
    items: [
      { label: 'Present full screen', selected: true, onselect: chooseFullScreen },
      { label: 'Present in a window', selected: false, onselect: chooseWindow },
    ],
    ...overrides,
  };
  const result = render(SplitButton, { props });
  flushSync();
  const main = result.container.querySelector<HTMLButtonElement>('.main')!;
  const caret = result.container.querySelector<HTMLButtonElement>('.caret')!;
  const items = () => [
    ...result.container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
  ];
  const menu = () => result.container.querySelector('[role="menu"]');
  return { ...result, main, caret, items, menu, onclick, chooseFullScreen, chooseWindow };
}

/** A click the way a POINTER makes one. `detail` is the only discriminator. */
function pointerClick(el: HTMLElement): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  flushSync();
}

/** A click the way Enter or Space on a focused button makes one. */
function keyboardClick(el: HTMLElement): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
  flushSync();
}

describe('the two halves', () => {
  it('runs the primary action without opening anything', () => {
    const { main, onclick, menu } = renderSplit();
    pointerClick(main);
    expect(onclick).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
  });

  it('opens the menu without running the primary action', () => {
    const { caret, onclick, menu } = renderSplit();
    pointerClick(caret);
    expect(menu()).not.toBeNull();
    expect(onclick).not.toHaveBeenCalled();
  });

  it('says which mode a take would open in', () => {
    // A menu of modes owes an answer to "which one am I in?" — the check is the
    // only thing that distinguishes it from a menu of commands.
    const { caret, items } = renderSplit();
    pointerClick(caret);
    expect(items().map((item) => item.getAttribute('aria-checked'))).toEqual(['true', 'false']);
  });

  it('runs the chosen item and closes', () => {
    const { caret, items, chooseWindow, menu } = renderSplit();
    pointerClick(caret);
    pointerClick(items()[1]!);
    expect(chooseWindow).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
  });
});

describe('the highlight tells the truth about who is driving', () => {
  it('paints nothing as chosen when the pointer opened the menu', () => {
    /*
     * Focus still lands on the first item — the ARIA menu-button pattern
     * requires it — but painting that item as chosen is a different claim, and
     * a false one, since nobody pointed at it. It also made the top action look
     * pre-armed, one Return away from firing.
     */
    const { caret, items } = renderSplit();
    pointerClick(caret);
    expect(items().some((item) => item.classList.contains('active'))).toBe(false);
  });

  it('paints the first item when a key opened the menu', () => {
    // Enter and Space reach a button as a click, so a keyboard user would
    // otherwise be inside a menu with nothing drawn to say where they are.
    const { caret, items } = renderSplit();
    keyboardClick(caret);
    expect(items()[0]!.classList.contains('active')).toBe(true);
  });

  it('moves the highlight with the arrow keys', () => {
    // Proves the shared `menu-nav` arithmetic is actually wired up.
    const { caret, items, menu } = renderSplit();
    keyboardClick(caret);
    menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    flushSync();
    expect(items()[1]!.classList.contains('active')).toBe(true);
  });

  it('follows the pointer with exactly one highlight', () => {
    // Two would mean the arrow-focused item and the hovered item both looking
    // chosen, which is the state that made this pattern read as broken.
    const { caret, items } = renderSplit();
    keyboardClick(caret);
    items()[1]!.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
    flushSync();
    expect(items().filter((item) => item.classList.contains('active')).length).toBe(1);
  });
});

describe('the menu closes when it should', () => {
  it('closes on Escape', () => {
    const { caret, menu } = renderSplit();
    pointerClick(caret);
    menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flushSync();
    expect(menu()).toBeNull();
  });

  it('closes on a pointerdown outside it', () => {
    /*
     * Dispatched on an element rather than on `window` directly. The listener
     * is on the window in the capture phase, so it sees this either way — but a
     * real pointerdown always has an Element target, and firing one at the
     * window gives the handler a target that is not a Node at all.
     */
    const outside = document.createElement('button');
    document.body.append(outside);
    const { caret, menu } = renderSplit();
    pointerClick(caret);
    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    flushSync();
    expect(menu()).toBeNull();
    outside.remove();
  });

  it('stays open for a pointerdown inside it', () => {
    const { caret, items, menu } = renderSplit();
    pointerClick(caret);
    items()[0]!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    flushSync();
    expect(menu()).not.toBeNull();
  });

  it('closes when the button becomes disabled', async () => {
    /*
     * Present disables itself while a take opens. A menu left painted over a
     * dead control invites a click into a take that has already started.
     */
    const { caret, menu, rerender } = renderSplit();
    pointerClick(caret);
    expect(menu()).not.toBeNull();

    await rerender({ disabled: true });
    flushSync();
    expect(menu()).toBeNull();
    expect(caret.getAttribute('aria-expanded')).toBe('false');
  });
});
