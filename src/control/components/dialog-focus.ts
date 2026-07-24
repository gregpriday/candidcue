/**
 * Modal focus-trap arithmetic (spec §20), kept out of the component so it is
 * directly testable. The component owns the DOM; this owns the decision.
 */

/**
 * Everything inside a dialog that can hold focus. Disabled controls are
 * excluded: they cannot be focused, so including them made the trap compute a
 * "first"/"last" that Tab could never actually land on.
 */
export const FOCUSABLE_SELECTOR =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

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
