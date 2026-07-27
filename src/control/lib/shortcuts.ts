/**
 * Keyboard shortcuts (spec §19). One window-level listener translates key
 * events into named actions; screens subscribe with `onShortcut`. Cmd on
 * macOS, Ctrl elsewhere. Plain-key shortcuts (Space, B, L, T) are suppressed
 * while the user is typing and while the focused control activates itself on
 * the same key; nothing fires behind a modal dialog.
 */

export type ShortcutAction =
  | 'new-script'
  | 'quick-search'
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
  | 'toggle-listener'
  | 'take-marker'
  | 'command-help'
  /** §16.9. Escape — twice ends the take; the screen owns the two-press rule. */
  | 'escape';

type Handler = (action: ShortcutAction) => void;
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
  for (const handler of handlers) handler(action);
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

export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return true;
  return /Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent);
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

  if (primary && !event.altKey) {
    if (event.shiftKey) {
      if (key === ' ') return 'hard-pause';
      if (key.toLowerCase() === 'm') return 'toggle-mirror';
      return null;
    }
    switch (key.toLowerCase()) {
      case 'n':
        return 'new-script';
      case 'k':
        return 'quick-search';
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
      case 'l':
        return 'toggle-listener';
      case 't':
        return 'take-marker';
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
    });
    if (action) emit(action, event);
  };
  window.addEventListener('keydown', listener);
  return () => window.removeEventListener('keydown', listener);
}
