/**
 * Keyboard logic for the `role="menu"` pattern (spec §20). Pure, so the
 * WAI-ARIA menu-button contract is testable without a DOM.
 *
 * It lives in `shared/` rather than beside its first caller because it now has
 * two of them in different layers: control's `OverflowMenu`/`SplitButton`, and
 * the stage's own session menu — which is in a window that must not pull
 * control's component tree in behind it. The arithmetic has no DOM and no I/O,
 * so it is the same module in both places rather than a second copy that can
 * drift.
 *
 * Contract (WAI-ARIA menu button):
 *  - the menu opens on Enter/Space/ArrowDown (first item) and ArrowUp (last);
 *  - the menu is ONE tab stop: only the active item has tabindex 0;
 *  - Arrow keys move focus, wrapping; Home/End jump to the ends;
 *  - disabled items are skipped, never landed on;
 *  - a printable character jumps to the next item that starts with it;
 *  - Escape closes and returns focus to the trigger.
 */

export interface MenuItemLike {
  /** The disabled flag drives the arrows; the label drives first-letter jumps. */
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

/**
 * First-letter navigation (§18.3 "typeahead"): the index of the next enabled
 * item whose label starts with the typed character, or null when the key is
 * not a letter for this menu.
 *
 * Searches forward from the active item and wraps, so pressing D twice in a
 * menu holding Duplicate and Delete walks between them rather than sticking on
 * the first. Only a single printable character counts, and never Space: Space
 * is how a keyboard user activates the focused item, and treating it as a
 * letter made half the activation keys dead in the menu that first had this.
 * A modified key is a command, not a letter, so the caller passes the modifier
 * state too.
 */
export function typeaheadIndex(
  items: readonly MenuItemLike[],
  fromIndex: number,
  key: string,
  modified = false,
): number | null {
  if (modified || key.length !== 1 || key === ' ') return null;
  const lower = key.toLowerCase();
  const count = items.length;
  // With nothing active yet the search starts AT the first item, not after it.
  const start = fromIndex >= 0 ? fromIndex : count - 1;
  for (let step = 1; step <= count; step += 1) {
    const index = (start + step) % count;
    const item = items[index];
    if (item && item.disabled !== true && (item.label ?? '').toLowerCase().startsWith(lower)) {
      return index;
    }
  }
  return null;
}

/** Roving tabindex: exactly one item is reachable with Tab. */
export function menuItemTabIndex(activeIndex: number, index: number): 0 | -1 {
  return index === activeIndex ? 0 : -1;
}
