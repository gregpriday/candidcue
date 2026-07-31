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
 *
 * Being inside the panel is not the same as being in the ring, and the second
 * is what the edge tests below need. A long dialog opens on a static
 * `tabindex="-1"` line at the top — the APG's own advice, and what keeps the
 * shortcuts reference from opening scrolled to its footer button — and that
 * element is excluded by `FOCUSABLE_SELECTOR`. It is therefore neither `first`
 * nor `last`, so both edge tests missed, `null` handed Tab back to the browser,
 * and Shift+Tab walked straight out of an `aria-modal` panel whose only real
 * stop was the button in the footer. Membership implies containment, so this
 * subsumes `inside`; the flag stays because it is the caller's own reading of
 * where focus went and costs nothing to keep honest.
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
  if (!inside || active === null || !focusables.includes(active)) return shiftKey ? last : first;
  if (shiftKey && active === first) return last;
  if (!shiftKey && active === last) return first;
  return null;
}
