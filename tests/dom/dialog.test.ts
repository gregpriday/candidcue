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
  const scrim = (): HTMLElement => {
    const el = document.querySelector<HTMLElement>('.scrim');
    expect(el, 'the scrim must be rendered').not.toBeNull();
    return el!;
  };

  /** Nearest common ancestor — where a browser targets a click that moved. */
  function commonAncestor(a: HTMLElement, b: HTMLElement): HTMLElement {
    let node: HTMLElement | null = a;
    while (node && !node.contains(b)) node = node.parentElement;
    return node ?? document.body;
  }

  /**
   * jsdom has no `PointerEvent`, so pointer fields ride on a `MouseEvent`.
   * `pointerId` and `isPrimary` are read by the handler, so they have to be
   * present or the multi-pointer and touch paths are not really under test.
   */
  function pointer(
    type: string,
    init: { button?: number; pointerId?: number; isPrimary?: boolean } = {},
  ): MouseEvent {
    const event = new MouseEvent(type, { bubbles: true, button: init.button ?? 0 });
    Object.defineProperty(event, 'pointerId', { value: init.pointerId ?? 1 });
    Object.defineProperty(event, 'isPrimary', { value: init.isPrimary ?? true });
    return event;
  }

  /**
   * A pointer gesture, in the three parts a browser actually reports.
   *
   * The click target is the subtle bit, and getting it wrong is what let the
   * original bug through this suite: a browser does NOT target `click` at the
   * element the pointer came up over. When press and release land on different
   * elements it targets their nearest common ancestor — which, for anything
   * inside this dialog, is the scrim itself. An earlier version of this helper
   * dispatched the click at the release element, so a scrim-to-panel drag
   * looked harmless here while the real handler dismissed the dialog.
   *
   * jsdom has no `PointerEvent` constructor; a `MouseEvent` of the right type
   * reaches the same listener, and `button: 0` matches the primary-press check.
   */
  function gesture(down: HTMLElement, up: HTMLElement): void {
    down.dispatchEvent(pointer('pointerdown'));
    up.dispatchEvent(pointer('pointerup'));
    commonAncestor(down, up).dispatchEvent(pointer('click'));
    flushSync();
  }

  it('a click that starts and ends on the scrim closes it', () => {
    const onclose = vi.fn();
    renderDialog({ body: '<button id="a">A</button>', onclose });

    gesture(scrim(), scrim());
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it('a click inside the panel does not dismiss it', () => {
    const onclose = vi.fn();
    renderDialog({ body: '<button id="a">A</button>', onclose });

    gesture(panel(), panel());
    expect(onclose).not.toHaveBeenCalled();
  });

  /*
   * The bug in #126: selecting text in the take summary and overshooting the
   * panel threw the dialog away, because the mouseup landed on the scrim and
   * `click` reports where the pointer went up.
   */
  it('a selection drag that starts in the panel and ends on the scrim stays open', () => {
    const onclose = vi.fn();
    renderDialog({ body: '<p id="summary">Take summary</p>', onclose });

    gesture(document.getElementById('summary')!, scrim());
    expect(onclose, 'releasing a panel drag over the scrim must not dismiss').not.toHaveBeenCalled();
  });

  it('a drag that starts on the scrim and ends in the panel stays open', () => {
    const onclose = vi.fn();
    renderDialog({ body: '<p id="summary">Take summary</p>', onclose });

    gesture(scrim(), panel());
    expect(onclose).not.toHaveBeenCalled();
  });

  it('an abandoned gesture does not authorise the next click', () => {
    const onclose = vi.fn();
    renderDialog({ body: '<button id="a">A</button>', onclose });

    // Pointer goes down on the scrim, then the gesture is cancelled (a system
    // gesture takes over, the pointer leaves the window). A later stray click
    // must not cash in the recorded origin.
    scrim().dispatchEvent(pointer('pointerdown'));
    scrim().dispatchEvent(pointer('pointercancel'));
    scrim().dispatchEvent(pointer('click'));
    flushSync();
    expect(onclose).not.toHaveBeenCalled();
  });

  it('a press released outside the window does not authorise a later click', () => {
    const onclose = vi.fn();
    renderDialog({ body: '<button id="a">A</button>', onclose });

    // No pointerup and no pointercancel — the release happened off-document.
    scrim().dispatchEvent(pointer('pointerdown'));
    // A keyboard-synthesised click later has no press of its own to lean on.
    scrim().dispatchEvent(pointer('click'));
    flushSync();
    expect(onclose, 'a press with no release must not arm a dismissal').not.toHaveBeenCalled();
  });

  it('a right-click on the scrim does not dismiss', () => {
    const onclose = vi.fn();
    renderDialog({ body: '<button id="a">A</button>', onclose });

    scrim().dispatchEvent(pointer('pointerdown', { button: 2 }));
    scrim().dispatchEvent(pointer('pointerup', { button: 2 }));
    scrim().dispatchEvent(pointer('click'));
    flushSync();
    expect(onclose).not.toHaveBeenCalled();
  });

  /*
   * Touch and pen implicitly capture the pointer on press, which retargets
   * every later pointer event at the pressed element. Left alone that makes a
   * scrim-to-panel drag report a release on the scrim — the exact reverse
   * gesture the handler is supposed to refuse — so the handler releases the
   * capture and this is what says it still does.
   */
  it('a touch drag from the scrim into the panel stays open', () => {
    const onclose = vi.fn();
    renderDialog({ body: '<p id="summary">Take summary</p>', onclose });

    const captured: number[] = [];
    scrim().hasPointerCapture = (id: number) => !captured.includes(id);
    scrim().releasePointerCapture = (id: number) => captured.push(id);

    scrim().dispatchEvent(pointer('pointerdown', { pointerId: 7 }));
    expect(captured, 'the implicit capture must be released').toContain(7);

    // With the capture released the release reports the panel, as it should.
    document.getElementById('summary')!.dispatchEvent(pointer('pointerup', { pointerId: 7 }));
    scrim().dispatchEvent(pointer('click', { pointerId: 7 }));
    flushSync();
    expect(onclose).not.toHaveBeenCalled();
  });

  it('a second finger cannot complete the first one’s gesture', () => {
    const onclose = vi.fn();
    renderDialog({ body: '<p id="summary">Take summary</p>', onclose });

    // Finger 1 presses the panel — not a dismissal.
    document.getElementById('summary')!.dispatchEvent(pointer('pointerdown', { pointerId: 1 }));
    // Finger 2 presses and releases the scrim. It must not borrow finger 1's
    // gesture, nor overwrite it into one that dismisses.
    scrim().dispatchEvent(pointer('pointerdown', { pointerId: 2, isPrimary: false }));
    scrim().dispatchEvent(pointer('pointerup', { pointerId: 2, isPrimary: false }));
    scrim().dispatchEvent(pointer('click', { pointerId: 2 }));
    flushSync();
    expect(onclose).not.toHaveBeenCalled();
  });

  it('one press authorises exactly one dismissal', () => {
    const onclose = vi.fn();
    renderDialog({ body: '<button id="a">A</button>', onclose });

    scrim().dispatchEvent(pointer('pointerdown'));
    scrim().dispatchEvent(pointer('pointerup'));
    scrim().dispatchEvent(pointer('click'));
    scrim().dispatchEvent(pointer('click'));
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
