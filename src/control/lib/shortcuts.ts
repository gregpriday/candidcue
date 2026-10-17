/**
 * Keyboard shortcuts (spec §19). One window-level listener translates key
 * events into named actions; screens subscribe with `onShortcut`. Cmd on
 * macOS, Ctrl elsewhere. Plain-key shortcuts (Space, B, A, [, ]) are
 * suppressed while the user is typing and while the focused control activates
 * itself on the same key; nothing fires behind a modal dialog.
 */
import { currentRoute, type Route } from '../stores/router';
import { detectPlatform } from './platform';

export type ShortcutAction =
  | 'new-script'
  | 'find-in-list'
  | 'save'
  | 'present'
  | 'play-pause'
  | 'hard-pause'
  | 'stop-session'
  | 'back-sentence'
  | 'forward-sentence'
  | 'prev-chapter'
  | 'next-chapter'
  | 'stage-text-up'
  | 'stage-text-down'
  | 'toggle-mirror'
  | 'blank-stage'
  | 'command-help'
  /**
   * Pop the take out to the whole display, or back into a window (§ reader mode).
   *
   * The platform's own full-screen chord, deliberately: somebody reading in a
   * window who wants the whole screen reaches for the key their OS taught them,
   * and a teleprompter is not the place to teach a new one. It is a MODIFIED key
   * rather than a plain one because it fires mid-take, where every unmodified key
   * already belongs to the transport.
   */
  | 'toggle-presentation-mode'
  /**
   * The fixed-pace transport: start/stop, and the pace itself.
   *
   * Keys rather than a control, because during a take there is no control
   * window to put a control in — the stage is full screen and the operator is
   * standing at a camera. These are the whole of the in-take interface for it.
   */
  | 'toggle-auto-scroll'
  | 'auto-scroll-faster'
  | 'auto-scroll-slower'
  /** §16.9. Escape — twice ends the take; the screen owns the two-press rule. */
  | 'escape';

/** The screens a command can belong to, plus the one scope that is every screen. */
export type ShortcutScope = 'global' | Route['name'];

/** Where a command works: every screen, or a non-empty list of the ones that answer it. */
export type ShortcutOwnership = 'global' | readonly [Route['name'], ...Route['name'][]];

/**
 * Which screen answers each command.
 *
 * This is not a description of the screen handlers written down a second time.
 * It is the policy the window listener consults BEFORE it claims a key, and the
 * shortcuts dialog groups its rows by the very same entries — so a command
 * cannot become live on one screen while the help still promises it on another.
 * It is the `presentationModeShortcutLabel` doctrine applied to the other
 * eighteen rows: derived in one place, so a label can never describe a key
 * `resolveShortcut` does not answer to.
 *
 * The listener used to claim every chord on every screen. `emit` stood down
 * only when NOTHING at all was subscribed, and App's help subscriber is mounted
 * for the life of the window — so `handlers.size` was never zero, and pressing
 * Cmd+N during a take resolved `new-script`, reached four handlers that all
 * ignored it, and was swallowed anyway. The key did nothing AND stopped doing
 * whatever it would otherwise have done.
 *
 * Route is the right question to ask because route IS the mount condition:
 * `App.svelte` renders exactly one screen per `$route.name`, so a command whose
 * owning screen is not the current route has no subscriber that will act on it.
 * Asking the handlers instead — "did anyone consume this?" — reads plausible
 * and is wrong: Live deliberately returns without acting on the keys the
 * embedded stage answers, and those still need the keypress taken.
 *
 * `'global'` is spelled out rather than represented by a missing entry, and the
 * record is exhaustive over `ShortcutAction`. A command added without an owner
 * is then a type error rather than a silently app-wide key — which is the
 * defect this table exists to prevent, and it would be a poor joke to leave the
 * door open for the next one.
 */
export const SHORTCUT_OWNERSHIP = {
  /* The one genuinely app-wide command: App owns it, mounted window-lifetime. */
  'command-help': 'global',

  'new-script': ['library'],
  /*
   * ⌘F in the LIBRARY, and only there.
   *
   * The command registry owns this chord as `edit.find`, and in the packaged
   * app the native menu takes the key before any webview sees it — so this
   * branch never fires there. It exists for the two places that have no menu
   * bar: `pnpm dev` in a browser, and the Playwright suite, which is the only
   * automated thing that can drive this app at all.
   *
   * Scoped to the library rather than global because the EDITOR's ⌘F is
   * CodeMirror's own search keymap, bound inside the editing surface. A window
   * listener claiming the chord there would take it before CodeMirror could.
   */
  'find-in-list': ['library'],
  /* Both screens that can hold a script to present: the one listing them and
     the one editing one. */
  present: ['library', 'editor'],
  save: ['editor'],

  'play-pause': ['live'],
  'hard-pause': ['live'],
  'stop-session': ['live'],
  'back-sentence': ['live'],
  'forward-sentence': ['live'],
  'prev-chapter': ['live'],
  'next-chapter': ['live'],
  'stage-text-up': ['live'],
  'stage-text-down': ['live'],
  'toggle-mirror': ['live'],
  'blank-stage': ['live'],
  'toggle-presentation-mode': ['live'],
  'toggle-auto-scroll': ['live'],
  'auto-scroll-faster': ['live'],
  'auto-scroll-slower': ['live'],
  /*
   * Escape is Live-only IN THIS WINDOW, which is not the same as saying the key
   * is idle elsewhere: a modal owns it (Dialog's own capture-phase handler, and
   * `isModalOpen` below), and off a take it goes back to meaning whatever the
   * focused control means by it. What it must not do is end a take that is not
   * running.
   */
  escape: ['live'],
} as const satisfies Readonly<Record<ShortcutAction, ShortcutOwnership>>;

/**
 * Does the screen currently on the glass answer this command?
 *
 * Deliberately NOT folded into `resolveShortcut` as another `ShortcutQuery`
 * field. That function answers one question — "which command is this chord?" —
 * and callers that only want the chord (the presentation-mode tests, anything
 * describing a key rather than dispatching one) should not have to invent a
 * route to ask it. Ownership is a property of the window's current state rather
 * than of the keystroke, so it is the installed listener's question, asked
 * where `preventDefault` is decided.
 */
export function shortcutAppliesToRoute(action: ShortcutAction, routeName: Route['name']): boolean {
  const ownership: ShortcutOwnership = SHORTCUT_OWNERSHIP[action];
  return ownership === 'global' || ownership.includes(routeName);
}

/**
 * How an action arrived: a keystroke this window heard, or a menu command.
 *
 * Live needs to know (#284). During a take the embedded stage listens on this
 * same window and answers some keys itself, so Live stands down for those —
 * but only a KEYSTROKE reaches the stage. A menu command reaches nothing but
 * this bus, and a handler that stood down for it left Session › Pause doing
 * nothing at all. A native accelerator is a menu command too: the menu takes
 * the key before any webview sees it.
 */
export type ShortcutSource = 'key' | 'menu';

type Handler = (action: ShortcutAction, source: ShortcutSource) => void;
const handlers = new Set<Handler>();

/** Subscribe to shortcut actions; returns an unsubscribe function. */
export function onShortcut(handler: Handler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

function emit(action: ShortcutAction, event: KeyboardEvent): void {
  // Nothing is listening: swallowing the key would only break the browser's
  // own handling of it for no gain.
  if (handlers.size === 0) return;
  event.preventDefault();
  for (const handler of handlers) handler(action, 'key');
}

/**
 * Fire a shortcut action without a keypress.
 *
 * The native Session menu's entries are the same actions as the transport keys,
 * and the screens that own those actions — Live, above all — already subscribe
 * here with every guard they need (the section bounds, the rig-resolved type
 * ceiling). Routing menu commands through this bus rather than reaching into
 * those screens means the menu and the key are the SAME code path, so they
 * cannot come to mean different things. The one guard a menu command must NOT
 * meet is the delegate-to-the-embedded-stage list, which is why it arrives as
 * `'menu'` — see `ShortcutSource`.
 *
 * Ownership is checked exactly as `installShortcuts` checks it. A menu item for
 * a command the current screen does not own is already greyed out — but the menu
 * state is a snapshot pushed some milliseconds ago, and the route can change
 * under it.
 */
export function emitShortcut(action: ShortcutAction): boolean {
  if (!shortcutAppliesToRoute(action, currentRoute().name)) return false;
  if (handlers.size === 0) return false;
  for (const handler of handlers) handler(action, 'menu');
  return true;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Controls that activate themselves on a plain key press. Space belongs to the
 * focused control — a `<button>` (and everything ARIA models on one) is only
 * clicked on keyup if the keydown was NOT prevented, and `role="switch"`
 * *requires* Space. Claiming Space globally silently broke every button in the
 * window, which is why this gate exists.
 */
const SELF_ACTIVATING_SELECTOR = [
  'button',
  'summary',
  'a[href]',
  '[role="button"]',
  '[role="switch"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="tab"]',
  '[role="option"]',
  '[role="link"]',
].join(', ');

/** True when the event landed on (or inside) a control that owns plain keys. */
export function isSelfActivatingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.closest(SELF_ACTIVATING_SELECTOR) !== null;
}

/**
 * True while a modal dialog is up. A modal owns the keyboard: an app shortcut
 * firing behind an `aria-modal="true"` scrim acts on a screen the user cannot
 * see or reach.
 */
export function isModalOpen(doc?: { querySelector(sel: string): unknown } | null): boolean {
  const target = doc ?? (typeof document === 'undefined' ? null : document);
  return Boolean(target?.querySelector('[role="dialog"][aria-modal="true"]'));
}

/**
 * Is this a Mac? Delegated to `lib/platform.ts`, which is the ONE check.
 *
 * This used to run its own regular expression over `navigator.platform`, and by
 * the time the desktop pass added a second one for the root platform attribute
 * there were two user-agent tests in the tree that could disagree. §22.3 asks
 * for exactly one, at the application root; this stays as a name because it
 * reads better at the call sites that are about a KEY rather than about a
 * platform, but it no longer knows anything.
 */
export function isMacPlatform(): boolean {
  return detectPlatform() === 'macos';
}

/**
 * How to write the presentation-mode chord for the platform it will be pressed
 * on.
 *
 * Derived here rather than spelled out at the two places that show it (Settings
 * and the shortcuts dialog), so a label can never describe a key
 * `resolveShortcut` does not answer to.
 */
export function presentationModeShortcutLabel(isMac = isMacPlatform()): string {
  /*
   * F11 off macOS, not Ctrl+Alt+F.
   *
   * Two reasons, and the second is the one that forced it. F11 is what Windows
   * and every Linux desktop mean by "make this window the whole screen", so it
   * is the key somebody reaches for without being told. And Ctrl+Alt+F was
   * already taken: `edit.replace` binds Mod+Alt+F, which IS Ctrl+Alt+F off
   * macOS — a native menu accelerator, so it would have won and this chord
   * would simply never have fired on the platform it was written for.
   *
   * ⌃⌘F stays on macOS because that is the system's own full-screen chord and
   * nothing in the menu claims it.
   */
  return isMac ? '⌃⌘F' : 'F11';
}

export interface ShortcutQuery {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** The target is a text field or contenteditable (spec §19). */
  typing: boolean;
  isMac: boolean;
  /**
   * The target activates itself on a plain key (button, switch, menu item,
   * disclosure summary, link). Plain-key shortcuts stand down for it.
   */
  selfActivating?: boolean;
  /** A modal dialog owns the keyboard; no app shortcut fires behind it. */
  modal?: boolean;
  /**
   * The key is auto-repeating because it is being held down.
   *
   * Only the actions for which repetition is meaningless stand down for it. A
   * held pace key SHOULD keep changing the pace — that is how somebody dials a
   * speed in while watching the glass — but a held toggle flips the transport on
   * and off many times a second, which is not something anybody can have meant.
   */
  repeat?: boolean;
}

/** Resolve a KeyboardEvent to a shortcut action, or null. Pure — testable. */
export function resolveShortcut(event: ShortcutQuery): ShortcutAction | null {
  if (event.modal) return null;
  const primary = event.isMac ? event.metaKey : event.ctrlKey;
  const key = event.key;

  /*
   * Escape (§16.9), and deliberately NOT in the plain-key block at the bottom.
   *
   * That block stands down for a control that activates itself on the key —
   * a button, a switch, a menu item. Escape must not: someone reaching for it
   * has a full-screen, always-on-top stage in front of them and no interest in
   * which button happens to have focus. It does stand down while typing, where
   * Escape means "leave this field", and behind a modal, which owns the
   * keyboard (handled above).
   *
   * The stage has always answered Escape. The control window did not, so the
   * key worked only while the stage held focus — and the operator is at the
   * control window, which is where they pressed Present. Pressing Escape at
   * the machine you are sitting at did nothing at all.
   */
  if (key === 'Escape' && !primary && !event.altKey && !event.shiftKey && !event.typing) {
    return 'escape';
  }

  /*
   * The presentation-mode toggle, before the `primary && !altKey` block.
   *
   * On macOS the platform chord is Control+Command+F, so BOTH `ctrlKey` and
   * `metaKey` are down — and `primary` is `metaKey` there, which means the block
   * below would happily read it as a plain Cmd+F and fall through to `null`.
   * Elsewhere it is a bare F11, which no block after this one looks at. Neither
   * shape fits them, which is why this is tested on its own rather than folded
   * in.
   */
  if ((key.toLowerCase() === 'f' || key === 'F11') && !event.shiftKey) {
    const macChord = event.isMac && event.ctrlKey && event.metaKey && !event.altKey;
    /* Bare F11 off macOS — see `presentationModeShortcutLabel` for why it is not
       Ctrl+Alt+F any more. No modifier, because F11 is not one of the keys a
       modifier is needed to tell apart from typing. */
    const otherChord =
      !event.isMac &&
      key === 'F11' &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey;
    /*
     * Held, this would flip the window between shapes at the key-repeat rate —
     * the same objection the `a` transport toggle makes about itself further
     * down, and worse here, because each flip is an OS window operation and a
     * full document relayout rather than a flag.
     *
     * Deliberately NOT gated on `typing`, unlike the plain-key block at the
     * bottom. ⌃⌘F is a modified chord, and a modifier already says "this is an
     * app command, not text" — Cmd+S saves from inside the editor. Bare F11 is
     * not modified, but it is a function key: it types nothing, so a text field
     * has no claim on it either.
     */
    if (macChord || otherChord) {
      return event.repeat === true ? null : 'toggle-presentation-mode';
    }
  }

  if (primary && !event.altKey) {
    if (event.shiftKey) {
      if (key === ' ') return 'hard-pause';
      if (key.toLowerCase() === 'm') return 'toggle-mirror';
      return null;
    }
    switch (key.toLowerCase()) {
      case 'n':
        return 'new-script';
      case 'f':
        /* Library only — see `find-in-list` in the ownership table. In the
           packaged app the menu has already taken this key. */
        return 'find-in-list';
      /*
       * ⌘K is NOT here. It belongs to Insert › Link now, and the Library's
       * search field is reached with ⌘F through `edit.find` in the command
       * registry — one chord per meaning rather than one per screen. Adding a
       * case back here would give the packaged app two owners for the chord,
       * and the menu wins.
       */
      case 's':
        return 'save';
      case 'enter':
        return 'present';
      case '.':
        return 'stop-session';
      case '=':
      case '+':
        return 'stage-text-up';
      case '-':
        return 'stage-text-down';
      case '/':
        return 'command-help';
      default:
        return null;
    }
  }

  if (event.altKey && !primary) {
    switch (key) {
      case 'ArrowLeft':
        return 'back-sentence';
      case 'ArrowRight':
        return 'forward-sentence';
      case 'ArrowUp':
        return 'prev-chapter';
      case 'ArrowDown':
        return 'next-chapter';
      default:
        return null;
    }
  }

  // Plain keys — only when not typing (spec §19 "Space when not typing") and
  // never when the focused control activates itself on the same key.
  if (!primary && !event.altKey && !event.shiftKey && !event.typing && !event.selfActivating) {
    // `key` is normalised because Caps Lock reports 'B' with shiftKey false —
    // Shift+B is still excluded by the guard above.
    switch (key.toLowerCase()) {
      case ' ':
        return 'play-pause';
      case 'b':
        return 'blank-stage';
      /*
       * The transport, on unmodified keys, beside Space and B.
       *
       * `a` for the transport itself and the bracket keys for its pace: they sit
       * together under one hand, they are not something a presenter reaches for
       * by accident mid-sentence, and — the reason they are not the arrow keys —
       * the arrows already step the script by a line, which is the thing an
       * operator does INSTEAD of changing the speed.
       */
      case 'a':
        // Held, this would flip the transport on and off at the key-repeat
        // rate. The pace keys below deliberately do not stand down.
        return event.repeat === true ? null : 'toggle-auto-scroll';
      case ']':
        return 'auto-scroll-faster';
      case '[':
        return 'auto-scroll-slower';
      default:
        return null;
    }
  }

  return null;
}

/** Install the window listener; returns a teardown function. */
export function installShortcuts(): () => void {
  const listener = (event: KeyboardEvent) => {
    const action = resolveShortcut({
      key: event.key,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      typing: isTypingTarget(event.target),
      isMac: isMacPlatform(),
      selfActivating: isSelfActivatingTarget(event.target),
      modal: isModalOpen(),
      repeat: event.repeat,
    });
    /*
     * The chord resolved — but only the screen that owns the command may have
     * the key. `currentRoute()` is read here, per event, rather than captured
     * when the listener is installed: this listener outlives every screen, and
     * a route read once at startup would pin the whole window to the Library.
     */
    if (action && shortcutAppliesToRoute(action, currentRoute().name)) emit(action, event);
  };
  window.addEventListener('keydown', listener);
  return () => window.removeEventListener('keydown', listener);
}
