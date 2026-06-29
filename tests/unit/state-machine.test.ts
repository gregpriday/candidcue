import type { RuntimeContext, SessionRuntimeState } from '@shared/domain';
import {
  STATE_INVARIANTS,
  TRANSITIONS,
  canCommitUserTurn,
  canPlayQuestion,
  canTransition,
  isMicGateOpen,
  nextState,
} from '@main/interview/state-machine';
import type { TransitionTrigger } from '@main/interview/state-machine';

const ALL_STATES: SessionRuntimeState[] = [
  'IDLE',
  'PREPARING',
  'READY',
  'INTERVIEWER_THINKING',
  'INTERVIEWER_BUFFERING',
  'INTERVIEWER_SPEAKING',
  'USER_ARMED',
  'USER_SPEAKING',
  'ENDPOINT_CANDIDATE',
  'TURN_FINALIZING',
  'PAUSED',
  'RECOVERING',
  'FINISHING',
  'COMPLETED',
  'ERROR',
];

const MIC_OPEN_STATES: SessionRuntimeState[] = ['USER_ARMED', 'USER_SPEAKING', 'ENDPOINT_CANDIDATE'];

const ACTIVE_STATES: SessionRuntimeState[] = [
  'READY',
  'INTERVIEWER_THINKING',
  'INTERVIEWER_BUFFERING',
  'INTERVIEWER_SPEAKING',
  'USER_ARMED',
  'USER_SPEAKING',
  'ENDPOINT_CANDIDATE',
  'TURN_FINALIZING',
];

function ctx(overrides: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    state: 'USER_ARMED',
    commitInFlight: false,
    stageReady: true,
    currentGenerationId: 1,
    currentTurn: { id: 'turn-1', generationId: 1 },
    ...overrides,
  };
}

describe('TRANSITIONS table', () => {
  it('covers every runtime state', () => {
    for (const state of ALL_STATES) {
      expect(TRANSITIONS[state]).toBeDefined();
    }
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...ALL_STATES].sort());
  });

  it('only ever maps to valid runtime states', () => {
    for (const state of ALL_STATES) {
      for (const target of Object.values(TRANSITIONS[state])) {
        expect(ALL_STATES).toContain(target);
      }
    }
  });

  it('drives the happy-path interview lifecycle', () => {
    expect(nextState('IDLE', 'prepareSession')).toBe('PREPARING');
    expect(nextState('PREPARING', 'preflightPassed')).toBe('READY');
    expect(nextState('READY', 'begin')).toBe('INTERVIEWER_THINKING');
    expect(nextState('INTERVIEWER_THINKING', 'questionAndTtsReady')).toBe('INTERVIEWER_BUFFERING');
    expect(nextState('INTERVIEWER_BUFFERING', 'stageReady')).toBe('INTERVIEWER_SPEAKING');
    expect(nextState('INTERVIEWER_SPEAKING', 'audioEnded')).toBe('USER_ARMED');
    expect(nextState('USER_ARMED', 'speechStarted')).toBe('USER_SPEAKING');
    expect(nextState('USER_SPEAKING', 'speechStopped')).toBe('ENDPOINT_CANDIDATE');
    expect(nextState('ENDPOINT_CANDIDATE', 'manualCommit')).toBe('TURN_FINALIZING');
    expect(nextState('TURN_FINALIZING', 'transcriptStored')).toBe('INTERVIEWER_THINKING');
  });

  it('routes completion to FINISHING then COMPLETED', () => {
    expect(nextState('TURN_FINALIZING', 'completionSelected')).toBe('FINISHING');
    expect(nextState('INTERVIEWER_THINKING', 'completionSelected')).toBe('FINISHING');
    expect(nextState('FINISHING', 'finalAnswerStored')).toBe('COMPLETED');
  });
});

describe('nextState / canTransition', () => {
  it('returns null for illegal triggers', () => {
    expect(nextState('IDLE', 'begin')).toBeNull();
    expect(nextState('READY', 'speechStarted')).toBeNull();
    expect(nextState('COMPLETED', 'begin')).toBeNull();
  });

  it('canTransition agrees with nextState for every (state, trigger)', () => {
    const triggers: TransitionTrigger[] = [
      'prepareSession',
      'preflightPassed',
      'unrecoverablePreflightFailure',
      'begin',
      'stageReady',
      'audioEnded',
      'speechStarted',
      'manualCommit',
      'speechStopped',
      'speechResumed',
      'classifierWait',
      'transcriptStored',
      'questionAndTtsReady',
      'completionSelected',
      'finalAnswerStored',
      'pause',
      'deviceOrProviderNeedsRecovery',
      'resumeBeforeStart',
      'resumeUserTurn',
      'resumePreparedQuestion',
      'recovered',
      'recoveryFailed',
      'operatorRetry',
    ];
    for (const state of ALL_STATES) {
      for (const trigger of triggers) {
        expect(canTransition(state, trigger)).toBe(nextState(state, trigger) !== null);
      }
    }
  });
});

describe('endpoint / user-turn transitions', () => {
  it('manualCommit from USER_SPEAKING goes to TURN_FINALIZING', () => {
    expect(nextState('USER_SPEAKING', 'manualCommit')).toBe('TURN_FINALIZING');
  });

  it('manualCommit is available from every mic-open state', () => {
    for (const state of MIC_OPEN_STATES) {
      expect(nextState(state, 'manualCommit')).toBe('TURN_FINALIZING');
    }
  });

  it('classifierWait keeps the session in ENDPOINT_CANDIDATE', () => {
    expect(nextState('ENDPOINT_CANDIDATE', 'classifierWait')).toBe('ENDPOINT_CANDIDATE');
  });

  it('speechResumed returns to USER_SPEAKING', () => {
    expect(nextState('ENDPOINT_CANDIDATE', 'speechResumed')).toBe('USER_SPEAKING');
  });
});

describe('mic gate', () => {
  it('is open only in USER_ARMED, USER_SPEAKING, ENDPOINT_CANDIDATE', () => {
    for (const state of ALL_STATES) {
      const expectedOpen = MIC_OPEN_STATES.includes(state);
      expect(isMicGateOpen(state)).toBe(expectedOpen);
    }
  });

  it('cannot open the mic during INTERVIEWER_SPEAKING', () => {
    expect(isMicGateOpen('INTERVIEWER_SPEAKING')).toBe(false);
  });

  it('cannot open the mic during INTERVIEWER_THINKING or BUFFERING', () => {
    expect(isMicGateOpen('INTERVIEWER_THINKING')).toBe(false);
    expect(isMicGateOpen('INTERVIEWER_BUFFERING')).toBe(false);
  });

  it('cannot open the mic while paused, recovering, finalizing, or finishing', () => {
    expect(isMicGateOpen('PAUSED')).toBe(false);
    expect(isMicGateOpen('RECOVERING')).toBe(false);
    expect(isMicGateOpen('TURN_FINALIZING')).toBe(false);
    expect(isMicGateOpen('FINISHING')).toBe(false);
  });
});

describe('canCommitUserTurn', () => {
  it('is true in each mic-open state with a current turn and no commit in flight', () => {
    for (const state of MIC_OPEN_STATES) {
      expect(canCommitUserTurn(ctx({ state }))).toBe(true);
    }
  });

  it('is blocked when commitInFlight is true', () => {
    expect(canCommitUserTurn(ctx({ state: 'USER_SPEAKING', commitInFlight: true }))).toBe(false);
  });

  it('is blocked when there is no current turn', () => {
    expect(canCommitUserTurn(ctx({ state: 'USER_SPEAKING', currentTurn: null }))).toBe(false);
  });

  it('is blocked outside the mic-open states', () => {
    const closedStates = ALL_STATES.filter((s) => !MIC_OPEN_STATES.includes(s));
    for (const state of closedStates) {
      expect(canCommitUserTurn(ctx({ state }))).toBe(false);
    }
  });

  it('is blocked during INTERVIEWER_SPEAKING even with a current turn', () => {
    expect(canCommitUserTurn(ctx({ state: 'INTERVIEWER_SPEAKING' }))).toBe(false);
  });
});

describe('canPlayQuestion', () => {
  const turnId = 'turn-1';

  it('is true when buffering, stage ready, matching turn and generation', () => {
    expect(canPlayQuestion(ctx({ state: 'INTERVIEWER_BUFFERING' }), turnId)).toBe(true);
  });

  it('is false when not in INTERVIEWER_BUFFERING', () => {
    expect(canPlayQuestion(ctx({ state: 'INTERVIEWER_SPEAKING' }), turnId)).toBe(false);
    expect(canPlayQuestion(ctx({ state: 'INTERVIEWER_THINKING' }), turnId)).toBe(false);
    expect(canPlayQuestion(ctx({ state: 'USER_ARMED' }), turnId)).toBe(false);
  });

  it('is false when the stage is not ready', () => {
    expect(canPlayQuestion(ctx({ state: 'INTERVIEWER_BUFFERING', stageReady: false }), turnId)).toBe(
      false,
    );
  });

  it('is false for the wrong turn id', () => {
    expect(canPlayQuestion(ctx({ state: 'INTERVIEWER_BUFFERING' }), 'turn-OTHER')).toBe(false);
  });

  it('is false when there is no current turn', () => {
    expect(canPlayQuestion(ctx({ state: 'INTERVIEWER_BUFFERING', currentTurn: null }), turnId)).toBe(
      false,
    );
  });

  it('rejects stale TTS when the generation id mismatches (turn superseded)', () => {
    const stale = ctx({
      state: 'INTERVIEWER_BUFFERING',
      currentGenerationId: 5,
      currentTurn: { id: turnId, generationId: 4 },
    });
    expect(canPlayQuestion(stale, turnId)).toBe(false);
  });

  it('accepts when generation ids align', () => {
    const fresh = ctx({
      state: 'INTERVIEWER_BUFFERING',
      currentGenerationId: 5,
      currentTurn: { id: turnId, generationId: 5 },
    });
    expect(canPlayQuestion(fresh, turnId)).toBe(true);
  });
});

describe('pause / resume', () => {
  it('pause from each active state goes to PAUSED with the mic gate closed', () => {
    for (const state of ACTIVE_STATES) {
      const paused = nextState(state, 'pause');
      expect(paused).toBe('PAUSED');
      expect(isMicGateOpen('PAUSED')).toBe(false);
    }
  });

  it('does not allow pause from terminal or transient states', () => {
    expect(nextState('IDLE', 'pause')).toBeNull();
    expect(nextState('PAUSED', 'pause')).toBeNull();
    expect(nextState('RECOVERING', 'pause')).toBeNull();
    expect(nextState('FINISHING', 'pause')).toBeNull();
    expect(nextState('COMPLETED', 'pause')).toBeNull();
    expect(nextState('ERROR', 'pause')).toBeNull();
  });

  it('supports the three resume triggers out of PAUSED', () => {
    expect(nextState('PAUSED', 'resumeBeforeStart')).toBe('READY');
    expect(nextState('PAUSED', 'resumeUserTurn')).toBe('USER_ARMED');
    expect(nextState('PAUSED', 'resumePreparedQuestion')).toBe('INTERVIEWER_BUFFERING');
  });
});

describe('recovery', () => {
  it('enters RECOVERING from active states via deviceOrProviderNeedsRecovery', () => {
    for (const state of ACTIVE_STATES) {
      expect(nextState(state, 'deviceOrProviderNeedsRecovery')).toBe('RECOVERING');
    }
  });

  it('resolves recovery to PAUSED on success and ERROR on failure', () => {
    expect(nextState('RECOVERING', 'recovered')).toBe('PAUSED');
    expect(nextState('RECOVERING', 'recoveryFailed')).toBe('ERROR');
  });

  it('allows an operator retry out of ERROR back into RECOVERING', () => {
    expect(nextState('ERROR', 'operatorRetry')).toBe('RECOVERING');
  });

  it('routes an unrecoverable preflight failure to ERROR', () => {
    expect(nextState('PREPARING', 'unrecoverablePreflightFailure')).toBe('ERROR');
  });
});

describe('terminal states', () => {
  it('COMPLETED has no outgoing transitions back to an active state', () => {
    expect(Object.keys(TRANSITIONS.COMPLETED)).toHaveLength(0);
    expect(nextState('COMPLETED', 'begin')).toBeNull();
    expect(nextState('COMPLETED', 'operatorRetry')).toBeNull();
    expect(nextState('COMPLETED', 'resumeUserTurn')).toBeNull();
    for (const state of Object.values(TRANSITIONS.COMPLETED)) {
      expect(ACTIVE_STATES).not.toContain(state);
    }
  });
});

describe('STATE_INVARIANTS', () => {
  it('defines an invariant for every runtime state', () => {
    for (const state of ALL_STATES) {
      expect(STATE_INVARIANTS[state]).toBeDefined();
    }
  });

  it('micGate agrees with isMicGateOpen for every state', () => {
    for (const state of ALL_STATES) {
      const expected = isMicGateOpen(state) ? 'open' : 'closed';
      expect(STATE_INVARIANTS[state].micGate).toBe(expected);
    }
  });

  it('keeps Mira audio silent whenever the mic gate is open', () => {
    for (const state of MIC_OPEN_STATES) {
      expect(STATE_INVARIANTS[state].miraAudio).toBe('silent');
    }
  });

  it('only the open mic-open states are marked open', () => {
    const open = ALL_STATES.filter((s) => STATE_INVARIANTS[s].micGate === 'open');
    expect(open.sort()).toEqual([...MIC_OPEN_STATES].sort());
  });
});
