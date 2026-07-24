import { describe, expect, it } from 'vitest';
import { resolveShortcut } from '../../../src/control/lib/shortcuts';

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
    expect(resolveShortcut(event({ key: 'l' }))).toBe('toggle-listener');
    expect(resolveShortcut(event({ key: 't' }))).toBe('take-marker');

    expect(resolveShortcut(event({ key: ' ', typing: true }))).toBeNull();
    expect(resolveShortcut(event({ key: 'b', typing: true }))).toBeNull();
  });

  it('modifier shortcuts still fire while typing', () => {
    expect(resolveShortcut(event({ key: 's', metaKey: true, typing: true }))).toBe('save');
  });

  it('ignores unmapped keys', () => {
    expect(resolveShortcut(event({ key: 'q' }))).toBeNull();
    expect(resolveShortcut(event({ key: 'z', metaKey: true }))).toBeNull();
  });
});
