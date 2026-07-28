/**
 * Modal focus-trap arithmetic (spec §20), kept out of the component so it is
 * directly testable. The component owns the DOM; this owns the decision.
 */

/**
 * Everything inside a dialog that Tab can actually land on. Disabled controls
 * are excluded: they cannot be focused, so including them made the trap compute
 * a "first"/"last" that Tab could never reach.
 *
 * `[tabindex="-1"]` is excluded for the same reason, and it is not hypothetical:
 * a roving-tabindex group (SegmentedControl, and the ARIA radiogroup pattern
 * generally) parks -1 on every unselected option, so the trap's "first" element
 * was an unselected radio the browser skips. Shift+Tab from the real first stop
 * then walked out of the modal, because the element the trap was holding the
 * line at was one Tab never visits.
 */
export const FOCUSABLE_SELECTOR = [
  'button:not(:disabled):not([tabindex="-1"])',
  'input:not(:disabled):not([tabindex="-1"])',
  'select:not(:disabled):not([tabindex="-1"])',
  'textarea:not(:disabled):not([tabindex="-1"])',
  'a[href]:not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * Where Tab should send focus, or `null` to let the browser handle it.
 *
 * `inside` is false when focus escaped the dialog — typically after a click on
 * non-focusable content dropped it on `<body>`. From there the browser would
 * walk the page BEHIND the scrim, so the trap pulls focus back to its own edge
 * rather than doing nothing.
 */
export function nextTrapFocus(
  focusables: readonly HTMLElement[],
  active: HTMLElement | null,
  shiftKey: boolean,
  inside: boolean,
): HTMLElement | null {
  if (focusables.length === 0) return null;
  const first = focusables[0] ?? null;
  const last = focusables[focusables.length - 1] ?? null;
  if (!inside || active === null) return shiftKey ? last : first;
  if (shiftKey && active === first) return last;
  if (!shiftKey && active === last) return first;
  return null;
}
