import { describe, expect, it, vi } from 'vitest';
import type { CommandId } from '../../shared/contracts/commands';
import { COMMANDS } from './commands';
import { commandForChord, installMenuKeyBridge, type ChordEvent } from './menu-keys';

const chord = (key: string, mods: Partial<Omit<ChordEvent, 'key'>> = {}): ChordEvent => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('commandForChord', () => {
  it('resolves every accelerator the registry publishes', () => {
    // The registry's own spelling, pressed the way a Windows keyboard reports it.
    const asPressed = (accelerator: string): ChordEvent => {
      const parts = accelerator.split('+');
      const key = parts[parts.length - 1]!;
      const pressed =
        { Return: 'Enter', Left: 'ArrowLeft', Right: 'ArrowRight', Up: 'ArrowUp', Down: 'ArrowDown' }[key] ??
        (parts.includes('Shift') && key.length === 1 ? key.toUpperCase() : key.toLowerCase());
      return chord(pressed, {
        ctrlKey: parts.includes('Mod'),
        altKey: parts.includes('Alt'),
        shiftKey: parts.includes('Shift'),
      });
    };
    const withKeys = Object.values(COMMANDS).filter((command) => command.accelerator);
    expect(withKeys.length).toBeGreaterThan(20);
    for (const command of withKeys) {
      expect(commandForChord(asPressed(command.accelerator!)), command.accelerator).toBe(command.id);
    }
  });

  it('reads the chords people actually press', () => {
    expect(commandForChord(chord('s', { ctrlKey: true }))).toBe('file.save');
    // Caps Lock: an upper-case letter with no Shift is still Ctrl+S.
    expect(commandForChord(chord('S', { ctrlKey: true }))).toBe('file.save');
    expect(commandForChord(chord('Enter', { ctrlKey: true }))).toBe('file.present');
    expect(commandForChord(chord('Enter', { ctrlKey: true, shiftKey: true }))).toBe('file.practise');
    expect(commandForChord(chord('.', { ctrlKey: true }))).toBe('session.end-take');
    expect(commandForChord(chord(',', { ctrlKey: true }))).toBe('view.settings');
    expect(commandForChord(chord('I', { ctrlKey: true, shiftKey: true }))).toBe('file.import-markdown');
    expect(commandForChord(chord('i', { ctrlKey: true }))).toBe('insert.italic');
  });

  it('takes Ctrl and plus as zoom-in with or without the Shift that types it', () => {
    expect(commandForChord(chord('=', { ctrlKey: true }))).toBe('view.zoom-in');
    expect(commandForChord(chord('+', { ctrlKey: true, shiftKey: true }))).toBe('view.zoom-in');
    // The keypad's plus, no Shift.
    expect(commandForChord(chord('+', { ctrlKey: true }))).toBe('view.zoom-in');
    expect(commandForChord(chord('-', { ctrlKey: true }))).toBe('view.zoom-out');
  });

  it('ignores the Shift a layout needs to type punctuation, and keeps it on letters', () => {
    // German: `/` is Shift+7. French AZERTY: `.` is Shift+;.
    expect(commandForChord(chord('/', { ctrlKey: true, shiftKey: true }))).toBe('help.keyboard-shortcuts');
    expect(commandForChord(chord('.', { ctrlKey: true, shiftKey: true }))).toBe('session.end-take');
    expect(commandForChord(chord(',', { ctrlKey: true, shiftKey: true }))).toBe('view.settings');
    // A shifted digit typing a symbol is still not a chord the registry has.
    expect(commandForChord(chord('!', { ctrlKey: true, shiftKey: true }))).toBeNull();
    // On a letter Shift is part of the chord: Ctrl+Shift+I is not Ctrl+I.
    expect(commandForChord(chord('I', { ctrlKey: true, shiftKey: true }))).toBe('file.import-markdown');
    expect(commandForChord(chord('G', { ctrlKey: true, shiftKey: true }))).toBe('edit.find-previous');
  });

  it('leaves the platform its own keys', () => {
    // Cut, copy, paste, undo and select-all are the webview's, not the registry's.
    for (const key of ['c', 'v', 'x', 'z', 'y', 'a']) {
      expect(commandForChord(chord(key, { ctrlKey: true })), key).toBeNull();
    }
    // Win+anything belongs to the shell.
    expect(commandForChord(chord('s', { ctrlKey: true, metaKey: true }))).toBeNull();
    // Plain typing, and chords with a modifier the registry does not name.
    expect(commandForChord(chord('s'))).toBeNull();
    expect(commandForChord(chord('n', { ctrlKey: true, altKey: true }))).toBeNull();
    expect(commandForChord(chord('n', { ctrlKey: true, shiftKey: true }))).toBeNull();
  });
});

describe('installMenuKeyBridge', () => {
  type Listener = (event: KeyboardEvent) => void;

  function harness(available: (id: CommandId) => boolean, modal = false) {
    let listener: Listener | null = null;
    let capture: unknown;
    const target = {
      addEventListener: (_type: string, fn: EventListener, options?: unknown) => {
        listener = fn as Listener;
        capture = options;
      },
      removeEventListener: () => {
        listener = null;
      },
    };
    const run = vi.fn<(id: CommandId) => void>();
    const stop = installMenuKeyBridge({ available, run }, target, () => modal);
    const press = (key: string, mods: Partial<ChordEvent> & { repeat?: boolean } = {}) => {
      const event = {
        ...chord(key, mods),
        repeat: mods.repeat ?? false,
        isComposing: false,
        defaultPrevented: false,
        preventDefault: vi.fn(),
        stopImmediatePropagation: vi.fn(),
      };
      listener?.(event as unknown as KeyboardEvent);
      return event;
    };
    return { run, press, stop, capture: () => capture, attached: () => listener !== null };
  }

  it('listens in the capture phase, ahead of the editor and the shortcut layer', () => {
    expect(harness(() => true).capture()).toBe(true);
  });

  it('runs an available command and keeps the key from the page', () => {
    const h = harness(() => true);
    const event = h.press('s', { ctrlKey: true });
    expect(h.run).toHaveBeenCalledWith('file.save');
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopImmediatePropagation).toHaveBeenCalled();
  });

  it('lets an unavailable command fall through, as a disabled menu item does', () => {
    const h = harness((id) => id !== 'file.save');
    const event = h.press('s', { ctrlKey: true });
    expect(h.run).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
  });

  it('swallows the repeats of a held chord without running them again', () => {
    const h = harness(() => true);
    h.press('n', { ctrlKey: true });
    const held = h.press('n', { ctrlKey: true, repeat: true });
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(held.preventDefault).toHaveBeenCalled();
  });

  it('stands down behind a modal dialog, which owns the keyboard', () => {
    const h = harness(() => true, true);
    const event = h.press('b', { ctrlKey: true });
    expect(h.run).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
  });

  it('ignores keys that are not menu chords', () => {
    const h = harness(() => true);
    const event = h.press('c', { ctrlKey: true });
    expect(h.run).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('detaches on teardown', () => {
    const h = harness(() => true);
    h.stop();
    expect(h.attached()).toBe(false);
  });
});
