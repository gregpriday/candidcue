/**
 * Dialog.svelte — the modal focus contract.
 *
 * Every assertion here is about something that only exists once the component
 * is mounted in a document: where `document.activeElement` ends up, whether a
 * key event dispatched at the window reaches the handler, and whether a second
 * dialog stacked on the first steals the Escape.
 *
 * The two fixes this covers were previously verified only through
 * `dialog-focus.ts` (the pure `nextTrapFocus` arithmetic). That helper can be
 * perfectly correct while the component never calls it — which is exactly the
 * shape of the original bug: the keydown listener was bound to the panel, so
 * after a click on non-focusable content put focus on `<body>` the handler
 * never fired and neither Escape nor the trap did anything.
 */
import { render } from '@testing-library/svelte';
import { createRawSnippet, flushSync, type ComponentProps } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import Dialog from '../../src/control/components/Dialog.svelte';

/** A snippet of literal markup, the Svelte 5 way to pass children from a test. */
function markup(html: string) {
  return createRawSnippet(() => ({ render: () => `<div>${html}</div>` }));
}

interface DialogOpts {
  body?: string;
  footer?: string;
  onclose?: () => void;
  open?: boolean;
  title?: string;
}

type DialogProps = ComponentProps<typeof Dialog>;

function renderDialog(opts: DialogOpts = {}) {
  const props: DialogProps = {
    open: opts.open ?? true,
    title: opts.title ?? 'Delete script',
  };
  if (opts.onclose) props.onclose = opts.onclose;
  if (opts.body !== undefined) props.children = markup(opts.body);
  if (opts.footer !== undefined) props.footer = markup(opts.footer);
  const result = render(Dialog, { props });
  flushSync();
  return result;
}

/** Dispatch a key the way a browser does: at the deepest focused node. */
function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  (document.activeElement ?? document.body).dispatchEvent(event);
  flushSync();
  return event;
}

function panel(): HTMLElement {
  const found = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!found) throw new Error('no dialog panel is mounted');
  return found;
}

describe('Dialog — ARIA wiring', () => {
  it('is a labelled modal dialog', () => {
    renderDialog({ title: 'Delete script' });
    const p = panel();
    expect(p.getAttribute('aria-modal')).toBe('true');
    const labelledBy = p.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    // The id must actually resolve — a dangling aria-labelledby leaves the
    // dialog nameless and is invisible in every visual check.
    const label = document.getElementById(labelledBy as string);
    expect(label?.textContent).toBe('Delete script');
  });

  it('renders nothing at all when closed', () => {
    renderDialog({ open: false });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe('Dialog — focus entry', () => {
  it('moves focus into the panel on open', () => {
    renderDialog({ footer: '<button id="ok">OK</button>' });
    expect(document.activeElement?.id).toBe('ok');
  });

  it('prefers [data-autofocus] over document order', () => {
    renderDialog({
      body: '<button id="first">First</button><button id="wanted" data-autofocus>Wanted</button>',
    });
    expect(document.activeElement?.id).toBe('wanted');
  });

  it('skips a disabled control rather than dropping focus on the body', () => {
    // The regression: `querySelector('button')` matched the disabled Confirm,
    // `focus()` on it is a no-op, focus stayed on <body>, and a panel-scoped
    // Escape handler then never fired.
    renderDialog({
      body: '<button id="cannot" disabled>Confirm</button><button id="can">Cancel</button>',
    });
    expect(document.activeElement?.id).toBe('can');
  });

  it('falls back to the panel itself when it contains nothing focusable', () => {
    renderDialog({ body: '<p>Nothing here can take focus.</p>' });
    expect(document.activeElement).toBe(panel());
    expect(panel().getAttribute('tabindex')).toBe('-1');
  });
});

describe('Dialog — Escape', () => {
  it('closes when focus is inside the panel', () => {
    const onclose = vi.fn();
    renderDialog({ body: '<button id="x">X</button>', onclose });
    press('Escape');
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it('closes when focus is on <body>, which is the case the fix was for', () => {
    const onclose = vi.fn();
    renderDialog({ body: '<p>Summary text with nothing focusable in it.</p>', onclose });
    // Simulate a click on the non-focusable summary: focus lands on body.
    (document.activeElement as HTMLElement | null)?.blur();
    document.body.focus();
    expect(panel().contains(document.activeElement)).toBe(false);

    press('Escape');
    expect(
      onclose,
      'Escape must be handled at the window; a panel-scoped listener never sees this event',
    ).toHaveBeenCalledTimes(1);
  });

  it('consumes the key so a global Escape shortcut behind it does not also fire', () => {
    const globalEscape = vi.fn();
    window.addEventListener('keydown', globalEscape);
    try {
      renderDialog({ body: '<button id="x">X</button>', onclose: () => {} });
      const event = press('Escape');
      expect(event.defaultPrevented).toBe(true);
      // The dialog listens in the CAPTURE phase and calls stopPropagation(),
      // so a bubble-phase app shortcut never runs.
      expect(globalEscape).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', globalEscape);
    }
  });

  it('only the topmost stacked dialog closes', () => {
    const outer = vi.fn();
    const inner = vi.fn();
    renderDialog({ title: 'Outer', body: '<button id="o">O</button>', onclose: outer });
    renderDialog({ title: 'Inner', body: '<button id="i">I</button>', onclose: inner });
    expect(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).toHaveLength(2);

    press('Escape');
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });
});

describe('Dialog — Tab trap', () => {
  it('wraps forward from the last focusable back to the first', () => {
    renderDialog({
      body: '<button id="a">A</button><button id="b">B</button>',
      footer: '<button id="c">C</button>',
    });
    document.getElementById('c')?.focus();
    expect(document.activeElement?.id).toBe('c');

    const event = press('Tab');
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe('a');
  });

  it('wraps backward from the first to the last', () => {
    renderDialog({
      body: '<button id="a">A</button><button id="b">B</button>',
      footer: '<button id="c">C</button>',
    });
    document.getElementById('a')?.focus();
    press('Tab', { shiftKey: true });
    expect(document.activeElement?.id).toBe('c');
  });

  it('leaves the interior hops to the browser', () => {
    renderDialog({ body: '<button id="a">A</button><button id="b">B</button>' });
    document.getElementById('a')?.focus();
    const event = press('Tab');
    // a → b is a normal tab stop; preventing it would break the sequence.
    expect(event.defaultPrevented).toBe(false);
  });

  it('pulls focus back in when it has escaped to the page behind the scrim', () => {
    // A button OUTSIDE the dialog, standing in for the page under the scrim.
    const outside = document.createElement('button');
    outside.id = 'outside';
    document.body.appendChild(outside);

    renderDialog({ body: '<button id="a">A</button><button id="b">B</button>' });
    outside.focus();
    expect(panel().contains(document.activeElement)).toBe(false);

    press('Tab');
    expect(document.activeElement?.id).toBe('a');
  });

  it('does not trap Tab when the panel holds nothing focusable', () => {
    renderDialog({ body: '<p>Read-only.</p>' });
    const event = press('Tab');
    expect(event.defaultPrevented).toBe(false);
  });

  it('never routes Tab to a disabled control', () => {
    renderDialog({
      body: '<button id="a">A</button><button id="dead" disabled>Dead</button>',
      footer: '<button id="c">C</button>',
    });
    document.getElementById('c')?.focus();
    press('Tab');
    expect(document.activeElement?.id).toBe('a');

    document.getElementById('a')?.focus();
    press('Tab', { shiftKey: true });
    expect(document.activeElement?.id).toBe('c');
  });
});

describe('Dialog — scrim', () => {
  it('a click on the scrim closes, a click on the panel does not', () => {
    const onclose = vi.fn();
    renderDialog({ body: '<button id="a">A</button>', onclose });
    const scrim = document.querySelector<HTMLElement>('.scrim');
    expect(scrim).not.toBeNull();

    panel().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSync();
    expect(onclose, 'a click inside the panel must not dismiss it').not.toHaveBeenCalled();

    scrim?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSync();
    expect(onclose).toHaveBeenCalledTimes(1);
  });
});

describe('Dialog — teardown', () => {
  it('removes its window listener when it unmounts', () => {
    const onclose = vi.fn();
    const { unmount } = renderDialog({ body: '<button id="a">A</button>', onclose });
    press('Escape');
    expect(onclose).toHaveBeenCalledTimes(1);

    unmount();
    flushSync();
    press('Escape');
    expect(
      onclose,
      'a leaked window keydown listener would keep answering Escape after unmount',
    ).toHaveBeenCalledTimes(1);
  });

  it('returns focus to whatever had it before the dialog opened', () => {
    const opener = document.createElement('button');
    opener.id = 'opener';
    document.body.appendChild(opener);
    opener.focus();

    const { unmount } = renderDialog({ body: '<button id="a">A</button>' });
    expect(document.activeElement?.id).toBe('a');

    unmount();
    flushSync();
    expect(document.activeElement?.id).toBe('opener');
  });
});
