import type { StageCommand, StageStateProjection } from '@shared/contracts';

/** The subset of a keydown event we read — keeps the function trivially
 *  unit-testable with a plain object and free of DOM dependencies. */
type KeyInput = Pick<KeyboardEvent, 'code' | 'key' | 'shiftKey'>;

/**
 * Map a held key to a stage command. Returns null for keys we don't handle so
 * the caller can leave the event untouched.
 *
 * `KeyP` is a pause/resume toggle: it resumes when the stage is paused and
 * pauses otherwise. The orchestrator silently drops a command that is illegal
 * for the current session state, so sending RESUME when not paused (or PAUSE
 * when already paused) is harmless if the projection briefly lags a keypress.
 */
export function commandForKey(
  event: KeyInput,
  visualState: StageStateProjection['visualState'],
): StageCommand | null {
  if (event.shiftKey && event.key === 'Escape') {
    return { type: 'EXIT_STAGE' };
  }
  switch (event.code) {
    case 'Space':
      return { type: 'COMMIT', reason: 'manual' };
    case 'KeyP':
      return visualState === 'paused' ? { type: 'RESUME' } : { type: 'PAUSE' };
    case 'KeyR':
      return { type: 'REPEAT' };
    case 'KeyS':
      return { type: 'SKIP' };
    default:
      return null;
  }
}
