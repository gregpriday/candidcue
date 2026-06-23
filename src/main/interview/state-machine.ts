import type { RuntimeContext, SessionRuntimeState } from '@shared/domain';

/**
 * Session runtime state machine (spec §11.2 / §11.3).
 *
 * The orchestrator drives a single `SessionRuntimeState` through the lifecycle
 * of an interview. Every transition is expressed as a `(state, trigger)` pair so
 * the table is the single source of truth: guards elsewhere only decide whether
 * to *fire* a trigger, never which state results.
 */

/** Named triggers that drive transitions between runtime states. */
export type TransitionTrigger =
  // Preflight / preparation
  | 'prepareSession'
  | 'preflightPassed'
  | 'unrecoverablePreflightFailure'
  | 'begin'
  // Interviewer turn
  | 'stageReady'
  | 'questionAndTtsReady'
  | 'audioEnded'
  // User turn
  | 'speechStarted'
  | 'manualCommit'
  | 'speechStopped'
  | 'speechResumed'
  | 'classifierCommit'
  | 'classifierWait'
  // Finalization
  | 'transcriptStored'
  | 'completionSelected'
  | 'finalAnswerStored'
  // Pause / resume
  | 'pause'
  | 'resumeBeforeStart'
  | 'resumeUserTurn'
  | 'resumePreparedQuestion'
  // Recovery
  | 'deviceOrProviderNeedsRecovery'
  | 'recovered'
  | 'recoveryFailed'
  | 'operatorRetry';

/** Partial map of triggers → next state for a single source state. */
type TriggerMap = Partial<Record<TransitionTrigger, SessionRuntimeState>>;

/**
 * Transition table keyed by current state then trigger name. A missing entry
 * means the trigger is illegal in that state and is ignored by the orchestrator.
 */
export const TRANSITIONS: Record<SessionRuntimeState, TriggerMap> = {
  IDLE: {
    prepareSession: 'PREPARING',
  },

  PREPARING: {
    preflightPassed: 'READY',
    unrecoverablePreflightFailure: 'ERROR',
    deviceOrProviderNeedsRecovery: 'RECOVERING',
  },

  READY: {
    begin: 'INTERVIEWER_THINKING',
    pause: 'PAUSED',
    deviceOrProviderNeedsRecovery: 'RECOVERING',
  },

  INTERVIEWER_THINKING: {
    questionAndTtsReady: 'INTERVIEWER_BUFFERING',
    completionSelected: 'FINISHING',
    pause: 'PAUSED',
    deviceOrProviderNeedsRecovery: 'RECOVERING',
  },

  INTERVIEWER_BUFFERING: {
    stageReady: 'INTERVIEWER_SPEAKING',
    pause: 'PAUSED',
    deviceOrProviderNeedsRecovery: 'RECOVERING',
  },

  INTERVIEWER_SPEAKING: {
    audioEnded: 'USER_ARMED',
    pause: 'PAUSED',
    deviceOrProviderNeedsRecovery: 'RECOVERING',
  },

  USER_ARMED: {
    speechStarted: 'USER_SPEAKING',
    manualCommit: 'TURN_FINALIZING',
    pause: 'PAUSED',
    deviceOrProviderNeedsRecovery: 'RECOVERING',
  },

  USER_SPEAKING: {
    speechStopped: 'ENDPOINT_CANDIDATE',
    manualCommit: 'TURN_FINALIZING',
    pause: 'PAUSED',
    deviceOrProviderNeedsRecovery: 'RECOVERING',
  },

  ENDPOINT_CANDIDATE: {
    speechResumed: 'USER_SPEAKING',
    classifierWait: 'ENDPOINT_CANDIDATE',
    classifierCommit: 'TURN_FINALIZING',
    manualCommit: 'TURN_FINALIZING',
    pause: 'PAUSED',
    deviceOrProviderNeedsRecovery: 'RECOVERING',
  },

  TURN_FINALIZING: {
    transcriptStored: 'INTERVIEWER_THINKING',
    completionSelected: 'FINISHING',
    pause: 'PAUSED',
    deviceOrProviderNeedsRecovery: 'RECOVERING',
  },

  FINISHING: {
    finalAnswerStored: 'COMPLETED',
    deviceOrProviderNeedsRecovery: 'RECOVERING',
  },

  PAUSED: {
    resumeBeforeStart: 'READY',
    resumeUserTurn: 'USER_ARMED',
    resumePreparedQuestion: 'INTERVIEWER_BUFFERING',
    deviceOrProviderNeedsRecovery: 'RECOVERING',
  },

  RECOVERING: {
    recovered: 'PAUSED',
    recoveryFailed: 'ERROR',
  },

  COMPLETED: {},

  ERROR: {
    operatorRetry: 'RECOVERING',
  },
};

/** Resolve the next state for `(state, trigger)`, or `null` if not permitted. */
export function nextState(
  state: SessionRuntimeState,
  trigger: TransitionTrigger,
): SessionRuntimeState | null {
  return TRANSITIONS[state][trigger] ?? null;
}

/** True if `trigger` is a legal transition out of `state`. */
export function canTransition(state: SessionRuntimeState, trigger: TransitionTrigger): boolean {
  return nextState(state, trigger) !== null;
}

/** States in which the live capture path is active and the mic may be open. */
const MIC_OPEN_STATES: ReadonlySet<SessionRuntimeState> = new Set<SessionRuntimeState>([
  'USER_ARMED',
  'USER_SPEAKING',
  'ENDPOINT_CANDIDATE',
]);

/**
 * The mic gate is open only while the user holds the floor. In every other state
 * (interviewer speaking, finalizing, paused, recovering, ...) it must be closed.
 */
export function isMicGateOpen(state: SessionRuntimeState): boolean {
  return MIC_OPEN_STATES.has(state);
}

/**
 * A user turn may be committed only while the user holds the floor, no commit is
 * already running, and there is a turn to attach the transcript to.
 */
export function canCommitUserTurn(ctx: RuntimeContext): boolean {
  if (ctx.commitInFlight) return false;
  if (ctx.currentTurn === null) return false;
  return MIC_OPEN_STATES.has(ctx.state);
}

/**
 * A buffered question may begin playback only when it is still the active turn
 * for the current generation and the stage media is preloaded. The generation
 * check rejects stale TTS produced for a turn that has since been superseded.
 */
export function canPlayQuestion(ctx: RuntimeContext, turnId: string): boolean {
  if (ctx.state !== 'INTERVIEWER_BUFFERING') return false;
  if (!ctx.stageReady) return false;
  const turn = ctx.currentTurn;
  if (turn === null) return false;
  if (turn.id !== turnId) return false;
  return turn.generationId === ctx.currentGenerationId;
}

/** Observable invariants each state must hold (spec §11.3). */
export interface StateInvariant {
  micGate: 'closed' | 'open';
  stt: string;
  miraAudio: string;
  stageVisual: string;
}

/**
 * The §11.3 invariant table: for every runtime state, the required posture of the
 * mic gate, speech-to-text stream, interviewer ("Mira") audio, and the stage
 * visual. These are asserted continuously by the orchestrator.
 */
export const STATE_INVARIANTS: Record<SessionRuntimeState, StateInvariant> = {
  IDLE: {
    micGate: 'closed',
    stt: 'closed',
    miraAudio: 'silent',
    stageVisual: 'idle',
  },
  PREPARING: {
    micGate: 'closed',
    stt: 'warming',
    miraAudio: 'silent',
    stageVisual: 'idle',
  },
  READY: {
    micGate: 'closed',
    stt: 'idle',
    miraAudio: 'silent',
    stageVisual: 'idle',
  },
  INTERVIEWER_THINKING: {
    micGate: 'closed',
    stt: 'idle',
    miraAudio: 'silent',
    stageVisual: 'listening',
  },
  INTERVIEWER_BUFFERING: {
    micGate: 'closed',
    stt: 'idle',
    miraAudio: 'buffering',
    stageVisual: 'preloading',
  },
  INTERVIEWER_SPEAKING: {
    micGate: 'closed',
    stt: 'idle',
    miraAudio: 'playing',
    stageVisual: 'speaking',
  },
  USER_ARMED: {
    micGate: 'open',
    stt: 'streaming',
    miraAudio: 'silent',
    stageVisual: 'listening',
  },
  USER_SPEAKING: {
    micGate: 'open',
    stt: 'streaming',
    miraAudio: 'silent',
    stageVisual: 'listening',
  },
  ENDPOINT_CANDIDATE: {
    micGate: 'open',
    stt: 'streaming',
    miraAudio: 'silent',
    stageVisual: 'listening',
  },
  TURN_FINALIZING: {
    micGate: 'closed',
    stt: 'finalizing',
    miraAudio: 'silent',
    stageVisual: 'thinking',
  },
  PAUSED: {
    micGate: 'closed',
    stt: 'paused',
    miraAudio: 'silent',
    stageVisual: 'paused',
  },
  RECOVERING: {
    micGate: 'closed',
    stt: 'reconnecting',
    miraAudio: 'silent',
    stageVisual: 'recovering',
  },
  FINISHING: {
    micGate: 'closed',
    stt: 'closing',
    miraAudio: 'silent',
    stageVisual: 'thinking',
  },
  COMPLETED: {
    micGate: 'closed',
    stt: 'closed',
    miraAudio: 'silent',
    stageVisual: 'complete',
  },
  ERROR: {
    micGate: 'closed',
    stt: 'closed',
    miraAudio: 'silent',
    stageVisual: 'error',
  },
};
