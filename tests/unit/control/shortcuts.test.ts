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

const {
  installShortcuts,
  isModalOpen,
  isSelfActivatingTarget,
  onShortcut,
  resolveShortcut,
  shortcutAppliesToRoute,
  SHORTCUT_OWNERSHIP,
} = await import('../../../src/control/lib/shortcuts');
const { setInitialRoute } = await import('../../../src/control/stores/router');

/**
 * Put the window on a screen.
 *
 * The installed listener asks the router which screen is mounted before it
 * claims a key, so these tests have to say where they are. They used to inherit
 * the router's Library default and still assert that Space reached play/pause —
 * which passed only because the listener claimed every key on every screen, the
 * defect this file now guards.
 */
function onScreen(name: 'welcome' | 'library' | 'editor' | 'live' | 'settings' | 'calibrate') {
  if (name === 'library') setInitialRoute({ name: 'library', view: 'all' });
  else if (name === 'editor') setInitialRoute({ name: 'editor', scriptId: 's1' });
  else if (name === 'live') setInitialRoute({ name: 'live', sessionId: 'x1', scriptId: 's1' });
  else if (name === 'settings') setInitialRoute({ name: 'settings', section: 'general' });
  else if (name === 'calibrate')
    setInitialRoute({ name: 'calibrate', displayFingerprint: 'd1', rigName: 'rig' });
  else setInitialRoute({ name: 'welcome' });
}

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
  /*
   * Live by default, because that is where most of the keyboard lives and where
   * the questions this half of the file asks — does Space reach the transport,
   * does a focused button keep it — are actually asked. Tests about another
   * screen's keys say so themselves.
   */
  onScreen('live');
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
    onScreen('editor'); // Cmd+S is the Editor's key.
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

  /*
   * The defect this gate exists for.
   *
   * `emit` stood down only when NOTHING was subscribed, and App's help
   * subscriber is mounted for the life of the window — so `handlers.size` was
   * never zero. Cmd+N during a take resolved `new-script`, reached every
   * handler, was ignored by all of them, and was swallowed anyway: the key did
   * nothing AND stopped doing whatever it would otherwise have done. Both
   * halves are asserted, because taking the key is the part users feel.
   */
  it('does not claim a key the mounted screen will not act on', () => {
    installWithSubscriber();
    const newScript = press('n', { metaKey: true, target: new FakeHTMLElement('div') });
    expect(newScript.action).toBeNull();
    expect(newScript.defaultPrevented).toBe(false);

    // Cmd+S belongs to the Editor, and is just as dead here.
    const save = press('s', { metaKey: true, target: new FakeHTMLElement('div') });
    expect(save.action).toBeNull();
    expect(save.defaultPrevented).toBe(false);
  });

  it('leaves the take transport alone on the screens that cannot answer it', () => {
    onScreen('library');
    installWithSubscriber();
    for (const key of [' ', 'b', 't', 'a', '[', ']', 'Escape']) {
      const fired = press(key, { target: new FakeHTMLElement('div') });
      expect(fired.action).toBeNull();
      expect(fired.defaultPrevented).toBe(false);
    }
  });

  it('answers command help on every screen, including the ones that own no keys', () => {
    installWithSubscriber();
    for (const screen of ['welcome', 'library', 'editor', 'live', 'settings', 'calibrate'] as const) {
      onScreen(screen);
      lastAction = null;
      const fired = press('/', { metaKey: true, target: new FakeHTMLElement('div') });
      expect(fired.action).toBe('command-help');
      expect(fired.defaultPrevented).toBe(true);
    }
  });

  it('delivers each screen its own keys', () => {
    installWithSubscriber();
    onScreen('library');
    expect(press('n', { metaKey: true, target: new FakeHTMLElement('div') }).action).toBe(
      'new-script',
    );
    expect(press('k', { metaKey: true, target: new FakeHTMLElement('div') }).action).toBe(
      'quick-search',
    );
    onScreen('editor');
    expect(press('s', { metaKey: true, target: new FakeHTMLElement('div') }).action).toBe('save');
    // Present is the one key two screens answer.
    expect(press('Enter', { metaKey: true, target: new FakeHTMLElement('div') }).action).toBe(
      'present',
    );
    onScreen('library');
    expect(press('Enter', { metaKey: true, target: new FakeHTMLElement('div') }).action).toBe(
      'present',
    );
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

  /*
   * `resolveShortcut` still answers "which command is this chord?" and nothing
   * else — no route reaches it. Ownership is a property of the window's current
   * state rather than of the keystroke, so it is asked separately, and callers
   * that only want to name a key (the presentation-mode tests, the shortcuts
   * dialog) do not have to invent a screen to ask.
   */
  it('names the chord regardless of which screen is mounted', () => {
    onScreen('settings');
    expect(resolveShortcut(event({ key: 'n', metaKey: true }))).toBe('new-script');
    expect(resolveShortcut(event({ key: ' ' }))).toBe('play-pause');
  });
});

describe('shortcut ownership (issue #128)', () => {
  const ALL_ROUTES = ['welcome', 'library', 'editor', 'live', 'settings', 'calibrate'] as const;

  it('gives command help to every screen and nothing else to the idle ones', () => {
    for (const routeName of ALL_ROUTES) {
      expect(shortcutAppliesToRoute('command-help', routeName)).toBe(true);
    }
    // Welcome, Settings and Calibrate subscribe to no shortcuts at all, so no
    // key but help may be taken from the browser there.
    for (const routeName of ['welcome', 'settings', 'calibrate'] as const) {
      for (const action of Object.keys(SHORTCUT_OWNERSHIP) as Array<
        keyof typeof SHORTCUT_OWNERSHIP
      >) {
        expect(shortcutAppliesToRoute(action, routeName)).toBe(action === 'command-help');
      }
    }
  });

  it('scopes each screen to the keys its handler actually answers', () => {
    expect(shortcutAppliesToRoute('new-script', 'library')).toBe(true);
    expect(shortcutAppliesToRoute('new-script', 'live')).toBe(false);
    expect(shortcutAppliesToRoute('save', 'editor')).toBe(true);
    expect(shortcutAppliesToRoute('save', 'library')).toBe(false);
    // Present is the only command with two owners.
    expect(shortcutAppliesToRoute('present', 'library')).toBe(true);
    expect(shortcutAppliesToRoute('present', 'editor')).toBe(true);
    expect(shortcutAppliesToRoute('present', 'live')).toBe(false);
  });

  /*
   * The whole transport, asserted as a set rather than a sample: these are the
   * keys the dialog groups under "During a take", and a command that quietly
   * loses its Live entry would otherwise still be advertised there.
   */
  it('keeps the take transport to the take', () => {
    const liveOnly = [
      'play-pause',
      'hard-pause',
      'stop-session',
      'back-sentence',
      'forward-sentence',
      'prev-chapter',
      'next-chapter',
      'stage-text-up',
      'stage-text-down',
      'toggle-mirror',
      'blank-stage',
      'take-marker',
      'toggle-presentation-mode',
      'toggle-auto-scroll',
      'auto-scroll-faster',
      'auto-scroll-slower',
      'escape',
    ] as const;
    for (const action of liveOnly) {
      expect(shortcutAppliesToRoute(action, 'live')).toBe(true);
      for (const routeName of ALL_ROUTES) {
        if (routeName === 'live') continue;
        expect(shortcutAppliesToRoute(action, routeName)).toBe(false);
      }
    }
  });
});
