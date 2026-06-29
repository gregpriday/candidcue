import type { StageCommand, StageStateProjection } from '@shared/contracts';

/** The subset of a keydown event we read — keeps the function trivially
 *  unit-testable with a plain object and free of DOM dependencies. */
type KeyInput = Pick<
  KeyboardEvent,
  'code' | 'key' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey'
>;

/**
 * Map a held key to a stage command. Returns null for keys we don't handle so
 * the caller can leave the event untouched.
 *
 * `KeyP` is a pause/resume toggle: it resumes when the stage is paused and
 * pauses otherwise. The orchestrator silently drops a command that is illegal
 * for the current session state, so sending RESUME when not paused (or PAUSE
 * when already paused) is harmless if the projection briefly lags a keypress.
 *
 * Modifier chords (Cmd/Ctrl/Alt) are ignored so OS/app shortcuts such as
 * Cmd+P never accidentally toggle the session. The only modifier we honour is
 * Shift, used for the Shift+Esc exit chord.
 */
export function commandForKey(
  event: KeyInput,
  visualState: StageStateProjection['visualState'],
): StageCommand | null {
  if (event.metaKey || event.ctrlKey || event.altKey) {
    return null;
  }
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
    case 'KeyT':
      return { type: 'RETAKE' };
    default:
      return null;
  }
}

/**
 * Whether a stage command would actually do something right now. The orchestrator
 * stays the source of truth and silently drops a command that is illegal for the
 * session state (see `isCommandLegal` in src/main/interview/state-machine.ts);
 * this mirrors that gating using only what the renderer can see — the projected
 * `visualState` and `micState` — so a solo founder gets an immediate confirm/
 * reject cue instead of silence when they press a key. It can briefly disagree
 * with the orchestrator while a projection lags a keypress, which is harmless:
 * the caller sends the command regardless and the orchestrator decides.
 *
 * The projection collapses several runtime states (orchestrator STAGE_VISUAL /
 * MIC_STATE): USER_ARMED → listening + armed; USER_SPEAKING / ENDPOINT_CANDIDATE
 * → listening + active; INTERVIEWER_SPEAKING → speaking; *_THINKING / BUFFERING /
 * TURN_FINALIZING → thinking; PAUSED → paused; RECOVERING → recovering. The mic
 * gate is open (armed or active) exactly while the user holds the floor.
 */
export function isCommandUsefulInState(
  command: StageCommand,
  visualState: StageStateProjection['visualState'],
  micState: StageStateProjection['micState'],
): boolean {
  switch (command.type) {
    case 'COMMIT':
      // A manual commit lands a turn only while the mic gate is open.
      return micState !== 'closed';
    case 'PAUSE':
      // Pausable throughout a live exchange; not once paused, recovering,
      // finished, errored, or still on standby.
      return (
        visualState === 'listening' || visualState === 'thinking' || visualState === 'speaking'
      );
    case 'RESUME':
      return visualState === 'paused';
    case 'REPEAT':
      // Replay the current question only before the founder has begun answering
      // (mic still merely armed) or from a pause taken before they began.
      return visualState === 'paused' || (visualState === 'listening' && micState === 'armed');
    case 'SKIP':
      // Swap the delivered question for a new one, only before any answer speech.
      return visualState === 'listening' && micState === 'armed';
    case 'EXIT_STAGE':
      // Leaving the stage is always available.
      return true;
    case 'END_AFTER_TURN':
      // Finish after the answer the founder currently owns; the mic-open states
      // are the renderer-visible slice of where this is legal.
      return micState !== 'closed';
    default: {
      const _exhaustive: never = command;
      return _exhaustive;
    }
  }
}
