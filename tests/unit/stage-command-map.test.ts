import { describe, expect, it, vi } from 'vitest';

// register-stage-ipc imports `electron` (and audio-port, which also does) at
// module load. mapStageCommand is a pure mapper that touches none of it, so an
// empty stub lets the module import cleanly under the Node test runner.
vi.mock('electron', () => ({}));

import { mapStageCommand } from '../../src/main/ipc/register-stage-ipc';

describe('mapStageCommand', () => {
  it('maps END_AFTER_TURN to the END_AFTER_TURN session command', () => {
    expect(mapStageCommand({ type: 'END_AFTER_TURN' })).toEqual({ type: 'END_AFTER_TURN' });
  });

  it('maps the founder-start BEGIN to the BEGIN_SESSION session command', () => {
    expect(mapStageCommand({ type: 'BEGIN' })).toEqual({ type: 'BEGIN_SESSION' });
  });

  it('translates the existing stage commands to their session equivalents', () => {
    expect(mapStageCommand({ type: 'COMMIT', reason: 'manual' })).toEqual({
      type: 'COMMIT_USER_TURN',
      reason: 'manual',
    });
    expect(mapStageCommand({ type: 'PAUSE' })).toEqual({ type: 'PAUSE_SESSION' });
    expect(mapStageCommand({ type: 'RESUME' })).toEqual({ type: 'RESUME_SESSION' });
    expect(mapStageCommand({ type: 'REPEAT' })).toEqual({ type: 'REPEAT_QUESTION' });
    expect(mapStageCommand({ type: 'SKIP' })).toEqual({ type: 'SKIP_QUESTION' });
    expect(mapStageCommand({ type: 'RETAKE' })).toEqual({ type: 'RETAKE_TURN' });
    // EXIT_STAGE intentionally pauses rather than ending — Shift+Esc is a soft exit.
    expect(mapStageCommand({ type: 'EXIT_STAGE' })).toEqual({ type: 'PAUSE_SESSION' });
  });
});
