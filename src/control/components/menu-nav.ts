/**
 * Keyboard logic for the `role="menu"` pattern used by OverflowMenu (spec
 * §20). Pure, so the WAI-ARIA menu-button contract is testable without a DOM.
 *
 * Contract (WAI-ARIA menu button):
 *  - the menu opens on Enter/Space/ArrowDown (first item) and ArrowUp (last);
 *  - the menu is ONE tab stop: only the active item has tabindex 0;
 *  - Arrow keys move focus, wrapping; Home/End jump to the ends;
 *  - disabled items are skipped, never landed on;
 *  - Escape closes and returns focus to the trigger.
 */

export interface MenuItemLike {
  /** Only the disabled flag matters here; the label keeps call sites honest. */
  label?: string;
  disabled?: boolean;
}

const FORWARD_KEYS = new Set(['ArrowDown']);
const BACKWARD_KEYS = new Set(['ArrowUp']);

/** First / last item that can actually take focus, or -1. */
export function firstEnabledIndex(items: readonly MenuItemLike[]): number {
  return items.findIndex((item) => item.disabled !== true);
}

export function lastEnabledIndex(items: readonly MenuItemLike[]): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i]?.disabled !== true) return i;
  }
  return -1;
}

/**
 * Which item the trigger's key should open onto, or null when the key does
 * not open the menu. Space and Enter are included because the trigger is a
 * `<button>`: the browser turns them into a click, and the menu that click
 * opens must still place focus on an item.
 */
export function openIndexForTriggerKey(items: readonly MenuItemLike[], key: string): number | null {
  if (key === 'ArrowUp') return lastEnabledIndex(items);
  if (key === 'ArrowDown' || key === 'Enter' || key === ' ') return firstEnabledIndex(items);
  return null;
}

/**
 * Resolve a keydown inside the open menu to the index that should take focus,
 * or null when the key is not ours. `fromIndex` may be -1 (focus has not
 * landed on an item yet).
 */
export function nextMenuIndex(
  items: readonly MenuItemLike[],
  fromIndex: number,
  key: string,
): number | null {
  if (firstEnabledIndex(items) === -1) return null;
  if (key === 'Home') return firstEnabledIndex(items);
  if (key === 'End') return lastEnabledIndex(items);

  const forward = FORWARD_KEYS.has(key);
  const backward = BACKWARD_KEYS.has(key);
  if (!forward && !backward) return null;

  const step = forward ? 1 : -1;
  const count = items.length;
  const start = fromIndex >= 0 ? fromIndex : forward ? -1 : 0;
  for (let hop = 1; hop <= count; hop += 1) {
    const index = (((start + step * hop) % count) + count) % count;
    if (items[index]?.disabled !== true) return index;
  }
  return null;
}

/** Roving tabindex: exactly one item is reachable with Tab. */
export function menuItemTabIndex(activeIndex: number, index: number): 0 | -1 {
  return index === activeIndex ? 0 : -1;
}
