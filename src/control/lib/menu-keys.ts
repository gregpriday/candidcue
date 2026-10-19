/**
 * Menu accelerators for a webview the native menu cannot hear (Windows).
 *
 * ---------------------------------------------------------------------------
 * WHY THE MENU'S OWN KEYS DO NOTHING ON WINDOWS
 * ---------------------------------------------------------------------------
 * On macOS the menu bar sees every key first: AppKit offers a key-down to the
 * main menu's key equivalents before the focused view, so ⌘S saves whether the
 * editor, a button or nothing has focus. On Windows the accelerator table is
 * consulted by the APPLICATION's message loop (`TranslateAcceleratorW`, which
 * Tauri runs for every menu) — and WebView2's input window does not live in the
 * application. It belongs to the browser process, its key messages are pumped
 * there, and the page simply receives Ctrl+S as a keydown. Every chord in the
 * menu was dead the moment a webview had focus, which in this app is always:
 * Present, End Take, Save, Close, the zoom keys, Settings.
 *
 * So on Windows the window listens for the chords itself and runs them through
 * the SAME path a menu click takes. The registry in `commands.ts` already
 * carries every accelerator `menu.rs` publishes (a Rust test holds the two sets
 * equal in both directions), which is what lets this resolve a chord without a
 * second table.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT COPIES FROM THE MENU, AND WHAT IT DOES NOT
 * ---------------------------------------------------------------------------
 * - The key goes to the menu FIRST: the listener captures on `window`, ahead of
 *   CodeMirror's keymap and the `shortcuts.ts` layer, and a chord it runs stops
 *   there. Otherwise Ctrl+B would toggle bold twice (the menu and CodeMirror)
 *   and Ctrl+S would save twice (the menu and the editor's own shortcut).
 * - A command that is not available lets the key through, as a disabled menu
 *   item does: the page and the shortcut layer still see it.
 * - It works while typing, as a menu accelerator does: Ctrl+S saves from inside
 *   the editor.
 * - It stands down behind a modal dialog, which owns the keyboard — the rule
 *   `shortcuts.ts` already keeps (spec §19). Ctrl+B with the Keyboard Shortcuts
 *   sheet up must not reach into the document behind it and pull focus there.
 * - It never touches the Edit menu's Cut, Copy, Paste, Undo, Redo and Select
 *   All. Those are the platform's predefined items, not registry commands, and
 *   the webview already answers them natively.
 * - It does not auto-repeat. Holding Ctrl+N is not a request for forty scripts,
 *   and the repeats of a chord it answers are swallowed rather than passed to
 *   the page, so the editor does not get the presses the menu declined.
 */
import type { CommandId } from '../../shared/contracts/commands';
import { COMMANDS } from './commands';
import { isModalOpen } from './shortcuts';

/** The fields of a `KeyboardEvent` a chord is made of. */
export interface ChordEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * A key in the registry's own spelling: `Return`, `Left`, `=`, `N`.
 *
 * `+` is `=`: they are one key on a US keyboard, the registry writes zoom-in
 * as `Mod+=`, and somebody zooming in reaches for "Ctrl and plus" whether or
 * not they press Shift to get it. The numeric keypad's plus reports `+` too.
 */
function normaliseKey(key: string): string {
  switch (key) {
    case 'Enter':
      return 'Return';
    case 'ArrowLeft':
      return 'Left';
    case 'ArrowRight':
      return 'Right';
    case 'ArrowUp':
      return 'Up';
    case 'ArrowDown':
      return 'Down';
    case '+':
      return '=';
    default:
      return key.length === 1 ? key.toUpperCase() : key;
  }
}

function signature(primary: boolean, alt: boolean, shift: boolean, key: string): string {
  return `${primary ? 'P' : '-'}${alt ? 'A' : '-'}${shift ? 'S' : '-'} ${key}`;
}

/** `Mod+Shift+I` → its signature. `Mod` is Ctrl off macOS, which is the only place this runs. */
function acceleratorSignature(accelerator: string): string {
  const parts = accelerator.split('+');
  const key = normaliseKey(parts[parts.length - 1] ?? '');
  const modifiers = new Set(parts.slice(0, -1));
  return signature(modifiers.has('Mod') || modifiers.has('Ctrl'), modifiers.has('Alt'), modifiers.has('Shift'), key);
}

let table: Map<string, CommandId> | null = null;

function chordTable(): Map<string, CommandId> {
  if (table === null) {
    table = new Map();
    for (const command of Object.values(COMMANDS)) {
      if (command.accelerator) table.set(acceleratorSignature(command.accelerator), command.id);
    }
  }
  return table;
}

/**
 * The command a key-down is the accelerator for, or null. Pure.
 *
 * The Windows key is never part of a menu chord — Win+anything belongs to the
 * shell — so a press with it held resolves to nothing.
 */
export function commandForChord(event: ChordEvent): CommandId | null {
  if (event.metaKey) return null;
  const key = normaliseKey(event.key);
  /*
   * Shift on a key with no case — a digit or punctuation — is how the LAYOUT
   * types that character, not a modifier anybody chose: `+` on a US keyboard,
   * `/` (Shift+7) on a German one, `.` (Shift+;) on a French one. Counted, it
   * made Ctrl+/ and Ctrl+. (End Take) unreachable on those layouts. No chord in
   * the registry pairs Shift with such a key, so it is dropped there; on a
   * letter it is kept, because Ctrl+Shift+I and Ctrl+I are different commands.
   */
  const caseless = event.key.length === 1 && event.key.toUpperCase() === event.key.toLowerCase();
  const shift = event.shiftKey && !caseless;
  return chordTable().get(signature(event.ctrlKey, event.altKey, shift, key)) ?? null;
}

/** How a window answers its menu: whether a command is live here, and running it. */
export interface MenuKeyDispatch {
  available(id: CommandId): boolean;
  run(id: CommandId): void;
}

/** Listen for menu chords on this window and run them. Returns a teardown. */
export function installMenuKeyBridge(
  dispatch: MenuKeyDispatch,
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
  modalOpen: () => boolean = () => isModalOpen(),
): () => void {
  const listener = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || modalOpen()) return;
    const id = commandForChord(event);
    if (id === null || !dispatch.available(id)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!event.repeat) dispatch.run(id);
  };
  target.addEventListener('keydown', listener as EventListener, true);
  return () => target.removeEventListener('keydown', listener as EventListener, true);
}
