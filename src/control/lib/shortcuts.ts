/**
 * Keyboard shortcuts (spec §19). One window-level listener translates key
 * events into named actions; screens subscribe with `onShortcut`. Cmd on
 * macOS, Ctrl elsewhere. Plain-key shortcuts (Space, B, L, T) are suppressed
 * while the user is typing.
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
  | 'command-help';

type Handler = (action: ShortcutAction) => void;
const handlers = new Set<Handler>();

/** Subscribe to shortcut actions; returns an unsubscribe function. */
export function onShortcut(handler: Handler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

function emit(action: ShortcutAction, event: KeyboardEvent): void {
  event.preventDefault();
  for (const handler of handlers) handler(action);
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return true;
  return /Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent);
}

/** Resolve a KeyboardEvent to a shortcut action, or null. Pure — testable. */
export function resolveShortcut(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  typing: boolean;
  isMac: boolean;
}): ShortcutAction | null {
  const primary = event.isMac ? event.metaKey : event.ctrlKey;
  const key = event.key;

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

  // Plain keys — only when not typing (spec §19 "Space when not typing").
  if (!primary && !event.altKey && !event.shiftKey && !event.typing) {
    switch (key) {
      case ' ':
        return 'play-pause';
      case 'b':
      case 'B':
        return 'blank-stage';
      case 'l':
      case 'L':
        return 'toggle-listener';
      case 't':
      case 'T':
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
    });
    if (action) emit(action, event);
  };
  window.addEventListener('keydown', listener);
  return () => window.removeEventListener('keydown', listener);
}
