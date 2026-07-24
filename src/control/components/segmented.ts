/**
 * Keyboard and focus logic for the radiogroup pattern used by
 * SegmentedControl (spec §20). Kept as pure functions so the roving-tabindex
 * and arrow-key behaviour is unit-testable without a DOM.
 *
 * Contract (WAI-ARIA radiogroup):
 *  - the group is ONE tab stop: only the checked radio has tabindex 0;
 *  - Arrow keys move focus AND selection, wrapping at both ends;
 *  - Home/End jump to the first/last selectable option;
 *  - disabled options are skipped, never landed on.
 */

export interface SegmentOptionLike {
  value: string;
  disabled?: boolean;
}

const FORWARD_KEYS = new Set(['ArrowRight', 'ArrowDown']);
const BACKWARD_KEYS = new Set(['ArrowLeft', 'ArrowUp']);

/** Index of the currently selected option, or -1 when nothing matches. */
export function selectedIndex(options: readonly SegmentOptionLike[], value: string): number {
  return options.findIndex((o) => o.value === value);
}

/**
 * Roving tabindex: exactly one option is reachable with Tab. Normally that is
 * the checked one; when nothing is checked (or the checked one is disabled)
 * the first selectable option takes the tab stop so the group is never
 * unreachable by keyboard.
 */
export function segmentTabIndex(
  options: readonly SegmentOptionLike[],
  value: string,
  index: number,
): 0 | -1 {
  const selected = selectedIndex(options, value);
  const anchor =
    selected >= 0 && options[selected]?.disabled !== true
      ? selected
      : options.findIndex((o) => o.disabled !== true);
  return index === anchor ? 0 : -1;
}

/**
 * Resolve a keydown into the option index that should become focused and
 * selected, or null when the key is not ours to handle. `fromIndex` may be -1
 * (nothing selected yet), in which case forward keys start at the first
 * option and backward keys at the last.
 */
export function nextSegmentIndex(
  options: readonly SegmentOptionLike[],
  fromIndex: number,
  key: string,
): number | null {
  const selectable = options.some((o) => o.disabled !== true);
  if (!selectable) return null;

  if (key === 'Home') return options.findIndex((o) => o.disabled !== true);
  if (key === 'End') {
    for (let i = options.length - 1; i >= 0; i--) {
      if (options[i]?.disabled !== true) return i;
    }
    return null;
  }

  const forward = FORWARD_KEYS.has(key);
  const backward = BACKWARD_KEYS.has(key);
  if (!forward && !backward) return null;

  const step = forward ? 1 : -1;
  const count = options.length;
  const start = fromIndex >= 0 ? fromIndex : forward ? -1 : 0;
  for (let hop = 1; hop <= count; hop++) {
    const index = (((start + step * hop) % count) + count) % count;
    if (options[index]?.disabled !== true) return index;
  }
  return null;
}
