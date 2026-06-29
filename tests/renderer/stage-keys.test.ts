import { describe, expect, it } from 'vitest';
import type { StageCommand, StageStateProjection } from '@shared/contracts';
import { commandForKey, isCommandUsefulInState } from '../../src/renderer/stage/stage-commands';

type VisualState = StageStateProjection['visualState'];
type MicState = StageStateProjection['micState'];

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

  it('maps KeyT to RETAKE', () => {
    expect(commandForKey(key('KeyT'), 'listening')).toEqual({ type: 'RETAKE' });
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

describe('isCommandUsefulInState', () => {
  const COMMIT: StageCommand = { type: 'COMMIT', reason: 'manual' };
  const PAUSE: StageCommand = { type: 'PAUSE' };
  const RESUME: StageCommand = { type: 'RESUME' };
  const REPEAT: StageCommand = { type: 'REPEAT' };
  const SKIP: StageCommand = { type: 'SKIP' };
  const EXIT: StageCommand = { type: 'EXIT_STAGE' };

  describe('COMMIT — only while the mic gate is open', () => {
    it('is useful when the mic is armed or active', () => {
      expect(isCommandUsefulInState(COMMIT, 'listening', 'armed')).toBe(true);
      expect(isCommandUsefulInState(COMMIT, 'listening', 'active')).toBe(true);
    });

    it('is not useful when the mic is closed', () => {
      for (const vs of ALL_VISUAL_STATES) {
        expect(isCommandUsefulInState(COMMIT, vs, 'closed')).toBe(false);
      }
    });
  });

  describe('PAUSE — only during a live exchange', () => {
    it('is useful while listening, thinking, or speaking', () => {
      expect(isCommandUsefulInState(PAUSE, 'listening', 'active')).toBe(true);
      expect(isCommandUsefulInState(PAUSE, 'thinking', 'closed')).toBe(true);
      expect(isCommandUsefulInState(PAUSE, 'speaking', 'closed')).toBe(true);
    });

    it('is not useful once paused, recovering, on standby, complete, or errored', () => {
      for (const vs of ['standby', 'paused', 'recovering', 'complete', 'error'] as VisualState[]) {
        expect(isCommandUsefulInState(PAUSE, vs, 'closed')).toBe(false);
      }
    });
  });

  describe('RESUME — only from paused', () => {
    it('is useful only while paused', () => {
      for (const vs of ALL_VISUAL_STATES) {
        expect(isCommandUsefulInState(RESUME, vs, 'closed')).toBe(vs === 'paused');
      }
    });
  });

  describe('REPEAT — before answering, or from a pause', () => {
    it('is useful while paused and while armed but not yet speaking', () => {
      expect(isCommandUsefulInState(REPEAT, 'paused', 'closed')).toBe(true);
      expect(isCommandUsefulInState(REPEAT, 'listening', 'armed')).toBe(true);
    });

    it('is not useful once the founder is speaking, nor while the interviewer speaks', () => {
      expect(isCommandUsefulInState(REPEAT, 'listening', 'active')).toBe(false);
      expect(isCommandUsefulInState(REPEAT, 'speaking', 'closed')).toBe(false);
      expect(isCommandUsefulInState(REPEAT, 'thinking', 'closed')).toBe(false);
    });
  });

  describe('SKIP — only before any answer speech', () => {
    it('is useful only while armed and not yet speaking', () => {
      expect(isCommandUsefulInState(SKIP, 'listening', 'armed')).toBe(true);
      expect(isCommandUsefulInState(SKIP, 'listening', 'active')).toBe(false);
      expect(isCommandUsefulInState(SKIP, 'paused', 'closed')).toBe(false);
    });
  });

  describe('EXIT_STAGE — mirrors PAUSE (it maps to PAUSE_SESSION)', () => {
    it('is useful during a live exchange', () => {
      expect(isCommandUsefulInState(EXIT, 'listening', 'active')).toBe(true);
      expect(isCommandUsefulInState(EXIT, 'thinking', 'closed')).toBe(true);
      expect(isCommandUsefulInState(EXIT, 'speaking', 'closed')).toBe(true);
    });

    it('is not useful once paused, recovering, on standby, complete, or errored', () => {
      for (const vs of ['standby', 'paused', 'recovering', 'complete', 'error'] as VisualState[]) {
        expect(isCommandUsefulInState(EXIT, vs, 'closed')).toBe(false);
      }
    });

    it('tracks the PAUSE verdict exactly in every state', () => {
      const mics: MicState[] = ['closed', 'armed', 'active'];
      for (const vs of ALL_VISUAL_STATES) {
        for (const mic of mics) {
          expect(isCommandUsefulInState(EXIT, vs, mic)).toBe(
            isCommandUsefulInState(PAUSE, vs, mic),
          );
        }
      }
    });
  });
});
