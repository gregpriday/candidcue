import type { RuntimeContext, SessionRuntimeState, SessionCommandType } from '@shared/domain';

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
  | 'classifierWait'
  // Operator: replay the current question (Repeat) or abandon it for a new
  // one (Skip), both only legal before the creator has started answering.
  | 'replayQuestion'
  | 'skipToNextQuestion'
  // Operator: discard the in-progress answer and re-deliver the SAME question
  // (Retake), the complement of Repeat — only legal AFTER the creator has begun
  // answering. Re-buffers the cached question just like replayQuestion (#62).
  | 'retakeTurn'
  // Finalization
  | 'transcriptStored'
  // An empty answer (cough/silence) committed nothing; silently re-arm the same
  // turn instead of pausing so the creator can simply keep talking (issue #61).
  | 'emptyAnswerRearm'
  | 'completionSelected'
  | 'finalAnswerStored'
  // Pause / resume
  | 'pause'
  | 'resumeBeforeStart'
  | 'resumeUserTurn'
  | 'resumePreparedQuestion'
  | 'resumeNextQuestion'
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
    completionSelected: 'FINISHING',
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
    completionSelected: 'FINISHING',
    pause: 'PAUSED',
    deviceOrProviderNeedsRecovery: 'RECOVERING',
  },

  INTERVIEWER_SPEAKING: {
    audioEnded: 'USER_ARMED',
    completionSelected: 'FINISHING',
    pause: 'PAUSED',
    deviceOrProviderNeedsRecovery: 'RECOVERING',
  },

  USER_ARMED: {
    speechStarted: 'USER_SPEAKING',
    manualCommit: 'TURN_FINALIZING',
    // Operator may replay the just-delivered question or swap it for a new one,
    // but only before any speech exists for this turn (guarded by the caller).
    replayQuestion: 'INTERVIEWER_BUFFERING',
    skipToNextQuestion: 'INTERVIEWER_THINKING',
    // Retake re-delivers the same question after a paused/resumed mic-open turn
    // where speech already exists (guarded by the caller on userHasSpoken) (#62).
    retakeTurn: 'INTERVIEWER_BUFFERING',
    completionSelected: 'FINISHING',
    pause: 'PAUSED',
    deviceOrProviderNeedsRecovery: 'RECOVERING',
  },

  USER_SPEAKING: {
    speechStopped: 'ENDPOINT_CANDIDATE',
    manualCommit: 'TURN_FINALIZING',
    // Discard this in-progress answer and re-ask the same question (#62).
    retakeTurn: 'INTERVIEWER_BUFFERING',
    completionSelected: 'FINISHING',
    pause: 'PAUSED',
    deviceOrProviderNeedsRecovery: 'RECOVERING',
  },

  ENDPOINT_CANDIDATE: {
    speechResumed: 'USER_SPEAKING',
    classifierWait: 'ENDPOINT_CANDIDATE',
    manualCommit: 'TURN_FINALIZING',
    // Discard this in-progress answer and re-ask the same question (#62).
    retakeTurn: 'INTERVIEWER_BUFFERING',
    completionSelected: 'FINISHING',
    pause: 'PAUSED',
    deviceOrProviderNeedsRecovery: 'RECOVERING',
  },

  TURN_FINALIZING: {
    transcriptStored: 'INTERVIEWER_THINKING',
    // Empty transcript (cough/silence): re-arm the same turn rather than pause.
    emptyAnswerRearm: 'USER_ARMED',
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
    // The current turn's answer is already committed but realizing the next
    // question failed; resume by generating/playing the next question rather
    // than replaying the answered turn (issue #9). Mirrors skipToNextQuestion.
    resumeNextQuestion: 'INTERVIEWER_THINKING',
    replayQuestion: 'INTERVIEWER_BUFFERING',
    // Retake from a pause taken mid-answer: re-deliver the same question rather
    // than re-arming the half-spoken turn (guarded by the caller on
    // userHasSpoken && !currentTurnAnswered) (#62).
    retakeTurn: 'INTERVIEWER_BUFFERING',
    completionSelected: 'FINISHING',
    deviceOrProviderNeedsRecovery: 'RECOVERING',
  },

  RECOVERING: {
    recovered: 'PAUSED',
    completionSelected: 'FINISHING',
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

// -- command legality -------------------------------------------------------

/**
 * The minimal context the command-legality projection inspects. It is a
 * superset of what a single transition guard needs because some commands are
 * context-sensitive (Skip/Repeat depend on whether the creator has begun
 * answering; Commit depends on an in-flight commit).
 */
export interface CommandContext {
  state: SessionRuntimeState;
  commitInFlight: boolean;
  /** Whether a turn is currently armed/in-flight. */
  hasCurrentTurn: boolean;
  /** Whether the creator has produced speech for the current turn. */
  userHasSpoken: boolean;
  /**
   * Whether the current turn's answer is already committed (but the next turn is
   * not yet built). Retake must be illegal here — re-asking an answered turn
   * would discard the committed answer (cf. the same guard in resume(), #9).
   */
  currentTurnAnswered: boolean;
}

/** Every operator/stage command, in a stable order for the projection. */
export const ALL_COMMANDS: readonly SessionCommandType[] = [
  'PREPARE_SESSION',
  'BEGIN_SESSION',
  'COMMIT_USER_TURN',
  'PAUSE_SESSION',
  'RESUME_SESSION',
  'REPEAT_QUESTION',
  'SKIP_QUESTION',
  'RETAKE_TURN',
  'END_AFTER_TURN',
  'END_NOW',
  'RETRY_RECOVERY',
];

/**
 * States from which the session is live enough that "End now" must produce a
 * coherent COMPLETED. Excludes the lifecycle ends (IDLE/PREPARING/COMPLETED/
 * ERROR) and FINISHING (already completing). `completionSelected` is a legal
 * trigger out of every state in this set.
 */
const END_NOW_STATES: ReadonlySet<SessionRuntimeState> = new Set<SessionRuntimeState>([
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
]);

/**
 * Single source of truth for whether an operator/stage command is legal right
 * now. Both the main-process command dispatch and the UI control projection
 * consume this so the buttons can never advertise an action the orchestrator
 * would reject (spec §11; review P0-08). Legality is derived from the
 * transition table wherever a command maps cleanly onto a trigger.
 */
export function isCommandLegal(command: SessionCommandType, ctx: CommandContext): boolean {
  const { state } = ctx;
  switch (command) {
    case 'PREPARE_SESSION':
      return state === 'IDLE' || state === 'PREPARING';
    case 'BEGIN_SESSION':
      return state === 'READY';
    case 'COMMIT_USER_TURN':
      return isMicGateOpen(state) && ctx.hasCurrentTurn && !ctx.commitInFlight;
    case 'PAUSE_SESSION':
      return canTransition(state, 'pause');
    case 'RESUME_SESSION':
      return state === 'PAUSED';
    case 'REPEAT_QUESTION':
      // Replay the current question only before the creator has begun, or from
      // a pause taken before they began (review: "before answering, or Paused").
      return (
        ctx.hasCurrentTurn &&
        !ctx.commitInFlight &&
        !ctx.userHasSpoken &&
        (state === 'USER_ARMED' || state === 'PAUSED')
      );
    case 'SKIP_QUESTION':
      // Swap the delivered question for a new one, only before any speech.
      return ctx.hasCurrentTurn && !ctx.userHasSpoken && state === 'USER_ARMED';
    case 'RETAKE_TURN':
      // Discard the in-progress answer and re-deliver the same question — the
      // complement of Repeat. Legal once the creator has begun answering, while
      // the mic is open, or from a pause taken mid-answer. Never once the answer
      // is committed (that would wipe it) nor while a commit is in flight.
      return (
        ctx.hasCurrentTurn &&
        !ctx.commitInFlight &&
        !ctx.currentTurnAnswered &&
        ctx.userHasSpoken &&
        (isMicGateOpen(state) || state === 'PAUSED')
      );
    case 'END_AFTER_TURN':
      // Finish after the answer the creator currently owns is committed.
      return isMicGateOpen(state) || state === 'TURN_FINALIZING';
    case 'END_NOW':
      return END_NOW_STATES.has(state);
    case 'RETRY_RECOVERY':
      return state === 'ERROR';
    default: {
      const _exhaustive: never = command;
      return _exhaustive;
    }
  }
}

/** The full legality verdict for every command in the given context. */
export function availableCommands(ctx: CommandContext): Record<SessionCommandType, boolean> {
  const out = {} as Record<SessionCommandType, boolean>;
  for (const command of ALL_COMMANDS) {
    out[command] = isCommandLegal(command, ctx);
  }
  return out;
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
