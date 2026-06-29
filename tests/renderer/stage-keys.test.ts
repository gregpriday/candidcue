import { describe, expect, it } from 'vitest';
import type { StageStateProjection } from '@shared/contracts';
import { commandForKey } from '../../src/renderer/stage/stage-commands';

type VisualState = StageStateProjection['visualState'];

const ALL_VISUAL_STATES: readonly VisualState[] = [
  'standby',
  'listening',
  'thinking',
  'speaking',
  'paused',
  'recovering',
  'complete',
  'error',
];

/** Build the minimal keydown shape `commandForKey` reads. */
function key(
  code: string,
  opts: {
    key?: string;
    shiftKey?: boolean;
    metaKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
  } = {},
): Pick<KeyboardEvent, 'code' | 'key' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey'> {
  return {
    code,
    key: opts.key ?? '',
    shiftKey: opts.shiftKey ?? false,
    metaKey: opts.metaKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
    altKey: opts.altKey ?? false,
  };
}

describe('commandForKey', () => {
  it('maps Space to a manual COMMIT', () => {
    expect(commandForKey(key('Space'), 'listening')).toEqual({
      type: 'COMMIT',
      reason: 'manual',
    });
  });

  it('maps KeyR to REPEAT and KeyS to SKIP', () => {
    expect(commandForKey(key('KeyR'), 'listening')).toEqual({ type: 'REPEAT' });
    expect(commandForKey(key('KeyS'), 'listening')).toEqual({ type: 'SKIP' });
  });

  it('maps Shift+Escape to EXIT_STAGE', () => {
    expect(commandForKey(key('Escape', { key: 'Escape', shiftKey: true }), 'speaking')).toEqual({
      type: 'EXIT_STAGE',
    });
  });

  it('ignores bare Escape (no shift)', () => {
    expect(commandForKey(key('Escape', { key: 'Escape' }), 'speaking')).toBeNull();
  });

  it('ignores unhandled keys', () => {
    expect(commandForKey(key('KeyX'), 'listening')).toBeNull();
    expect(commandForKey(key('Enter'), 'listening')).toBeNull();
  });

  it('returns null for Shift+E (the end-confirm trigger is stage-app state, not a direct command)', () => {
    expect(commandForKey(key('KeyE', { key: 'E', shiftKey: true }), 'listening')).toBeNull();
  });

  it('ignores modifier chords so OS shortcuts never toggle the session', () => {
    expect(commandForKey(key('KeyP', { metaKey: true }), 'paused')).toBeNull();
    expect(commandForKey(key('KeyP', { ctrlKey: true }), 'listening')).toBeNull();
    expect(commandForKey(key('KeyS', { altKey: true }), 'listening')).toBeNull();
    // Shift is still honoured for the exit chord.
    expect(commandForKey(key('Escape', { key: 'Escape', shiftKey: true }), 'speaking')).toEqual({
      type: 'EXIT_STAGE',
    });
  });

  describe('KeyP pause/resume toggle', () => {
    it('resumes when the stage is paused', () => {
      expect(commandForKey(key('KeyP'), 'paused')).toEqual({ type: 'RESUME' });
    });

    it('pauses in every non-paused visual state', () => {
      for (const visualState of ALL_VISUAL_STATES) {
        if (visualState === 'paused') continue;
        expect(commandForKey(key('KeyP'), visualState)).toEqual({ type: 'PAUSE' });
      }
    });
  });
});
