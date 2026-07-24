/**
 * Modal focus trap (spec §20).
 *
 * The trap used to be bound to the panel element, so clicking non-focusable
 * dialog content (the F.17 summary `<dl>`, the shortcuts `<table>`, a confirm
 * paragraph) dropped focus on `<body>` and the dialog stopped responding:
 * Escape no longer closed it, and Tab walked the page behind an
 * `aria-modal="true"` scrim. The recovery case — "focus is no longer inside" —
 * is the whole point of `nextTrapFocus`.
 */
import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import Dialog from '../../../src/control/components/Dialog.svelte';
import { FOCUSABLE_SELECTOR, nextTrapFocus } from '../../../src/control/components/dialog-focus';

/** Stand-ins for focusable elements; only identity matters here. */
const A = { id: 'a' } as unknown as HTMLElement;
const B = { id: 'b' } as unknown as HTMLElement;
const C = { id: 'c' } as unknown as HTMLElement;
const TRAP = [A, B, C];

describe('nextTrapFocus', () => {
  it('pulls focus back into the dialog when it has escaped to the body', () => {
    // `active: null` is exactly the post-click-on-plain-content state.
    expect(nextTrapFocus(TRAP, null, false, false)).toBe(A);
    expect(nextTrapFocus(TRAP, null, true, false)).toBe(C);
    // Focus sitting on some element outside the panel is the same problem.
    expect(nextTrapFocus(TRAP, {} as HTMLElement, false, false)).toBe(A);
  });

  it('wraps at the ends and otherwise leaves Tab to the browser', () => {
    expect(nextTrapFocus(TRAP, C, false, true)).toBe(A);
    expect(nextTrapFocus(TRAP, A, true, true)).toBe(C);
    expect(nextTrapFocus(TRAP, B, false, true)).toBeNull();
    expect(nextTrapFocus(TRAP, B, true, true)).toBeNull();
  });

  it('does nothing when the dialog has no focusable content', () => {
    expect(nextTrapFocus([], null, false, false)).toBeNull();
  });

  it('handles a single focusable control', () => {
    expect(nextTrapFocus([A], A, false, true)).toBe(A);
    expect(nextTrapFocus([A], A, true, true)).toBe(A);
  });

  it('excludes disabled controls, matching the initial-focus query', () => {
    // The initial-focus selector and the trap selector are now the same
    // string; they used to disagree, so the dialog could open with focus on a
    // disabled button (i.e. on the body).
    expect(FOCUSABLE_SELECTOR).toContain('button:not(:disabled)');
    expect(FOCUSABLE_SELECTOR).toContain('input:not(:disabled)');
  });
});

describe('Dialog markup', () => {
  it('renders a focusable modal panel', () => {
    const { body } = render(Dialog, { props: { open: true, title: 'Session complete' } });
    expect(body).toContain('role="dialog"');
    expect(body).toContain('aria-modal="true"');
    // The fallback focus target when the dialog holds nothing focusable.
    expect(body).toContain('tabindex="-1"');
  });

  it('renders nothing when closed', () => {
    const { body } = render(Dialog, { props: { open: false, title: 'Session complete' } });
    expect(body).not.toContain('role="dialog"');
  });
});
