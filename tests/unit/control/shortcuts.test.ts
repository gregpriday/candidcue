/**
 * Keyboard shortcuts (spec §19).
 *
 * Two halves: the pure `resolveShortcut` table, and the installed window
 * listener — the half that actually decides whether a key reaches the control
 * under the cursor. The listener used to call `preventDefault()` for every
 * resolved action, so the plain-Space → play/pause mapping swallowed the
 * keydown on any focused `<button>`; the browser then never synthesised the
 * click on keyup and NO button in the control window could be activated with
 * the space bar (`role="switch"`, where ARIA requires Space, included).
 *
 * There is no jsdom in this repo, so the DOM surface `shortcuts.ts` touches
 * (window listener registration, `HTMLElement`, `closest`, `document`) is
 * stubbed here. Everything inside the module — `emit`, `installShortcuts`,
 * `isSelfActivatingTarget`, `isModalOpen`, `resolveShortcut` — is the real
 * implementation.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/* --- minimal DOM stubs ------------------------------------------------- */

interface FakeAttrs {
  role?: string;
  href?: string;
  contentEditable?: boolean;
}

class FakeHTMLElement {
  tagName: string;
  isContentEditable: boolean;
  role: string | undefined;
  href: string | undefined;
  parentElement: FakeHTMLElement | null = null;

  constructor(tagName: string, attrs: FakeAttrs = {}) {
    this.tagName = tagName.toUpperCase();
    this.isContentEditable = attrs.contentEditable ?? false;
    this.role = attrs.role;
    this.href = attrs.href;
  }

  /** Enough of `Element.closest` for the selector list the module uses. */
  closest(selector: string): FakeHTMLElement | null {
    const tokens = selector.split(',').map((t) => t.trim());
    let node: FakeHTMLElement | null = this;
    while (node) {
      for (const token of tokens) {
        if (token === node.tagName.toLowerCase()) return node;
        if (token === 'a[href]' && node.tagName === 'A' && node.href) return node;
        if (node.role && token === `[role="${node.role}"]`) return node;
      }
      node = node.parentElement;
    }
    return null;
  }
}

const listeners = new Set<(e: unknown) => void>();
/** What `document.querySelector('[role="dialog"][aria-modal="true"]')` finds. */
let modalElement: unknown = null;

beforeAll(() => {
  (globalThis as Record<string, unknown>)['HTMLElement'] = FakeHTMLElement;
  Object.defineProperty(globalThis, 'navigator', {
    value: { platform: 'MacIntel', userAgent: 'mac' },
    configurable: true,
  });
  (globalThis as Record<string, unknown>)['window'] = {
    addEventListener: (_type: string, fn: (e: unknown) => void) => listeners.add(fn),
    removeEventListener: (_type: string, fn: (e: unknown) => void) => listeners.delete(fn),
  };
  (globalThis as Record<string, unknown>)['document'] = {
    querySelector: (selector: string) =>
      selector === '[role="dialog"][aria-modal="true"]' ? modalElement : null,
  };
});

const { installShortcuts, isModalOpen, isSelfActivatingTarget, onShortcut, resolveShortcut } =
  await import('../../../src/control/lib/shortcuts');

interface Fired {
  action: string | null;
  defaultPrevented: boolean;
}

let lastAction: string | null = null;
let teardown: (() => void) | null = null;
let unsubscribe: (() => void) | null = null;

function press(
  key: string,
  options: {
    target?: FakeHTMLElement;
    metaKey?: boolean;
    ctrlKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
  } = {},
): Fired {
  const event = {
    key,
    metaKey: options.metaKey ?? false,
    ctrlKey: options.ctrlKey ?? false,
    shiftKey: options.shiftKey ?? false,
    altKey: options.altKey ?? false,
    target: options.target ?? new FakeHTMLElement('div'),
    defaultPrevented: false,
    preventDefault(this: { defaultPrevented: boolean }) {
      this.defaultPrevented = true;
    },
  };
  for (const fn of [...listeners]) fn(event);
  return { action: lastAction, defaultPrevented: event.defaultPrevented };
}

/** Install the real listener with one real subscriber, as the app does. */
function installWithSubscriber(): void {
  unsubscribe = onShortcut((action) => {
    lastAction = action;
  });
  teardown = installShortcuts();
}

beforeEach(() => {
  lastAction = null;
  modalElement = null;
});

afterEach(() => {
  teardown?.();
  unsubscribe?.();
  teardown = null;
  unsubscribe = null;
  listeners.clear();
});

describe('installShortcuts — what actually reaches the focused control', () => {
  it('leaves Space alone on a focused <button> so the click still fires', () => {
    installWithSubscriber();
    const fired = press(' ', { target: new FakeHTMLElement('button') });
    expect(fired.defaultPrevented).toBe(false);
    expect(fired.action).toBeNull();
  });

  it('leaves Space alone on a role="switch" (Toggle) and role="menuitem" (OverflowMenu)', () => {
    installWithSubscriber();
    const toggle = press(' ', { target: new FakeHTMLElement('button', { role: 'switch' }) });
    expect(toggle.defaultPrevented).toBe(false);
    expect(toggle.action).toBeNull();

    const menuItem = press(' ', { target: new FakeHTMLElement('button', { role: 'menuitem' }) });
    expect(menuItem.defaultPrevented).toBe(false);
    expect(menuItem.action).toBeNull();
  });

  it('leaves Space alone for an icon nested inside a button', () => {
    const button = new FakeHTMLElement('button');
    const icon = new FakeHTMLElement('span');
    icon.parentElement = button;
    installWithSubscriber();
    expect(press(' ', { target: icon }).defaultPrevented).toBe(false);
  });

  it('still claims Space for play/pause when nothing else owns the key', () => {
    installWithSubscriber();
    const fired = press(' ', { target: new FakeHTMLElement('div') });
    // Prevented so the window does not scroll; the action reaches the screen.
    expect(fired.defaultPrevented).toBe(true);
    expect(fired.action).toBe('play-pause');
  });

  it('does not swallow keys when no screen is subscribed', () => {
    teardown = installShortcuts(); // no onShortcut subscriber
    const fired = press(' ', { target: new FakeHTMLElement('div') });
    expect(fired.defaultPrevented).toBe(false);
  });

  it('exempts text fields and contenteditable', () => {
    installWithSubscriber();
    expect(press(' ', { target: new FakeHTMLElement('input') }).defaultPrevented).toBe(false);
    expect(press(' ', { target: new FakeHTMLElement('textarea') }).defaultPrevented).toBe(false);
    expect(
      press(' ', { target: new FakeHTMLElement('div', { contentEditable: true }) })
        .defaultPrevented,
    ).toBe(false);
  });

  it('fires nothing behind an open modal dialog', () => {
    installWithSubscriber();
    modalElement = new FakeHTMLElement('div', { role: 'dialog' });
    const space = press(' ', { target: new FakeHTMLElement('div') });
    expect(space.defaultPrevented).toBe(false);
    expect(space.action).toBeNull();
    // Cmd+. must not stop a session from behind a confirm sheet either.
    const stop = press('.', { metaKey: true, target: new FakeHTMLElement('div') });
    expect(stop.action).toBeNull();
  });

  /*
   * §16.9. Escape reached the take only while the STAGE had keyboard focus —
   * and the operator is at this window, which is where they pressed Present.
   * Pressing Escape at the machine you are sitting at, with a full-screen
   * always-on-top stage in front of you, did nothing at all.
   */
  it('delivers Escape even when a button has focus', () => {
    installWithSubscriber();
    // The plain-key rule stands down for a self-activating control. Escape must
    // not: someone reaching for it has no interest in which button has focus.
    const onButton = press('Escape', { target: new FakeHTMLElement('button') });
    expect(onButton.action).toBe('escape');
    const onSwitch = press('Escape', {
      target: new FakeHTMLElement('button', { role: 'switch' }),
    });
    expect(onSwitch.action).toBe('escape');
  });

  it('leaves Escape to the field being typed in, and to an open dialog', () => {
    installWithSubscriber();
    // In a text field Escape means "leave this field", not "end the take".
    expect(press('Escape', { target: new FakeHTMLElement('input') }).action).toBeNull();
    // And a modal owns the keyboard: the F.17 summary and the stop-confirm both
    // close on Escape, which must not also stop something behind them.
    modalElement = new FakeHTMLElement('div', { role: 'dialog' });
    expect(press('Escape', { target: new FakeHTMLElement('div') }).action).toBeNull();
  });

  it('does not confuse Escape with a modified Escape', () => {
    installWithSubscriber();
    const target = new FakeHTMLElement('div');
    expect(press('Escape', { target, metaKey: true }).action).toBeNull();
    expect(press('Escape', { target, altKey: true }).action).toBeNull();
    expect(press('Escape', { target, shiftKey: true }).action).toBeNull();
  });

  it('still delivers modifier shortcuts while a button has focus', () => {
    installWithSubscriber();
    const fired = press('s', { metaKey: true, target: new FakeHTMLElement('button') });
    expect(fired.action).toBe('save');
    expect(fired.defaultPrevented).toBe(true);
  });

  it('delivers the other plain keys from a non-interactive target', () => {
    installWithSubscriber();
    expect(press('b', { target: new FakeHTMLElement('div') }).action).toBe('blank-stage');
    expect(press('t', { target: new FakeHTMLElement('div') }).action).toBe('take-marker');
  });

  it('stops listening after teardown', () => {
    installWithSubscriber();
    teardown?.();
    teardown = null;
    expect(press(' ', { target: new FakeHTMLElement('div') }).action).toBeNull();
  });
});

describe('target classification', () => {
  const target = (tag: string, attrs?: FakeAttrs): EventTarget =>
    new FakeHTMLElement(tag, attrs) as unknown as EventTarget;

  it('recognises self-activating controls and ignores plain content', () => {
    expect(isSelfActivatingTarget(target('button'))).toBe(true);
    expect(isSelfActivatingTarget(target('summary'))).toBe(true);
    expect(isSelfActivatingTarget(target('a', { href: '#x' }))).toBe(true);
    expect(isSelfActivatingTarget(target('div', { role: 'switch' }))).toBe(true);
    expect(isSelfActivatingTarget(target('div'))).toBe(false);
    expect(isSelfActivatingTarget(target('input'))).toBe(false);
    expect(isSelfActivatingTarget(null)).toBe(false);
  });

  it('detects an open modal dialog', () => {
    expect(isModalOpen()).toBe(false);
    modalElement = new FakeHTMLElement('div', { role: 'dialog' });
    expect(isModalOpen()).toBe(true);
  });
});

function event(partial: Partial<Parameters<typeof resolveShortcut>[0]> & { key: string }) {
  return {
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    typing: false,
    isMac: true,
    ...partial,
  };
}

describe('resolveShortcut (spec §19)', () => {
  it('maps primary-modifier shortcuts on macOS (Cmd)', () => {
    expect(resolveShortcut(event({ key: 'n', metaKey: true }))).toBe('new-script');
    expect(resolveShortcut(event({ key: 'k', metaKey: true }))).toBe('quick-search');
    expect(resolveShortcut(event({ key: 's', metaKey: true }))).toBe('save');
    expect(resolveShortcut(event({ key: 'Enter', metaKey: true }))).toBe('present');
    expect(resolveShortcut(event({ key: '.', metaKey: true }))).toBe('stop-session');
    expect(resolveShortcut(event({ key: '=', metaKey: true }))).toBe('stage-text-up');
    expect(resolveShortcut(event({ key: '-', metaKey: true }))).toBe('stage-text-down');
    expect(resolveShortcut(event({ key: '/', metaKey: true }))).toBe('command-help');
  });

  it('uses Ctrl on non-mac platforms', () => {
    expect(resolveShortcut(event({ key: 'n', ctrlKey: true, isMac: false }))).toBe('new-script');
    // Cmd (meta) alone does nothing on Windows.
    expect(resolveShortcut(event({ key: 'n', metaKey: true, isMac: false }))).toBeNull();
  });

  it('maps shifted combos', () => {
    expect(resolveShortcut(event({ key: ' ', metaKey: true, shiftKey: true }))).toBe('hard-pause');
    expect(resolveShortcut(event({ key: 'm', metaKey: true, shiftKey: true }))).toBe('toggle-mirror');
  });

  it('maps Alt+arrow navigation', () => {
    expect(resolveShortcut(event({ key: 'ArrowLeft', altKey: true }))).toBe('back-sentence');
    expect(resolveShortcut(event({ key: 'ArrowRight', altKey: true }))).toBe('forward-sentence');
    expect(resolveShortcut(event({ key: 'ArrowUp', altKey: true }))).toBe('prev-chapter');
    expect(resolveShortcut(event({ key: 'ArrowDown', altKey: true }))).toBe('next-chapter');
  });

  it('plain keys work only when not typing', () => {
    expect(resolveShortcut(event({ key: ' ' }))).toBe('play-pause');
    expect(resolveShortcut(event({ key: 'b' }))).toBe('blank-stage');
    expect(resolveShortcut(event({ key: 't' }))).toBe('take-marker');

    expect(resolveShortcut(event({ key: ' ', typing: true }))).toBeNull();
    expect(resolveShortcut(event({ key: 'b', typing: true }))).toBeNull();
  });

  /*
   * The recogniser-failure copy in `services/errors.ts` tells a presenter whose
   * speech model just died to press A. That copy is only true while this
   * mapping holds, and it had no test — so the promise and the key are asserted
   * together here (`error-copy-user-facing.test.ts` asserts the copy end).
   */
  it('maps the auto-scroll transport keys the error copy promises', () => {
    expect(resolveShortcut(event({ key: 'a' }))).toBe('toggle-auto-scroll');
    expect(resolveShortcut(event({ key: ']' }))).toBe('auto-scroll-faster');
    expect(resolveShortcut(event({ key: '[' }))).toBe('auto-scroll-slower');
    // Held, A would flip the transport at the key-repeat rate.
    expect(resolveShortcut(event({ key: 'a', repeat: true }))).toBeNull();
    expect(resolveShortcut(event({ key: 'a', typing: true }))).toBeNull();
  });

  it('plain keys stand down for a self-activating control', () => {
    expect(resolveShortcut(event({ key: ' ', selfActivating: true }))).toBeNull();
    expect(resolveShortcut(event({ key: 'b', selfActivating: true }))).toBeNull();
    // Modifier combos are unaffected — they are not what the control consumes.
    expect(resolveShortcut(event({ key: 's', metaKey: true, selfActivating: true }))).toBe('save');
  });

  it('suppresses everything while a modal dialog is open', () => {
    expect(resolveShortcut(event({ key: ' ', modal: true }))).toBeNull();
    expect(resolveShortcut(event({ key: 's', metaKey: true, modal: true }))).toBeNull();
    expect(resolveShortcut(event({ key: 'ArrowLeft', altKey: true, modal: true }))).toBeNull();
  });

  it('handles Caps Lock (uppercase key, no Shift) but not Shift+letter', () => {
    expect(resolveShortcut(event({ key: 'B' }))).toBe('blank-stage');
    expect(resolveShortcut(event({ key: 'T' }))).toBe('take-marker');
    expect(resolveShortcut(event({ key: 'B', shiftKey: true }))).toBeNull();
  });

  it('modifier shortcuts still fire while typing', () => {
    expect(resolveShortcut(event({ key: 's', metaKey: true, typing: true }))).toBe('save');
  });

  it('ignores unmapped keys', () => {
    expect(resolveShortcut(event({ key: 'q' }))).toBeNull();
    expect(resolveShortcut(event({ key: 'z', metaKey: true }))).toBeNull();
  });
});
