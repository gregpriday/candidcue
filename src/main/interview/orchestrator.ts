import type {
  CandidCueRepository,
  InterviewModelAdapter,
  ModerationAdapter,
  SpeechToTextAdapter,
  TextToSpeechAdapter,
  TtsResult,
  SpeechPlaybackPlan,
  StageStateProjection,
  OperatorSessionSnapshot,
  PublicCoverageItem,
  PublicProviderStatus,
  AudioMeterReading,
} from '@shared/contracts';
import type {
  InterviewSession,
  InterviewBrief,
  InterviewerCharacter,
  MediaClip,
  SessionCoverageItem,
  SessionRuntimeState,
  QuestionRecord,
  AnswerRecord,
  InterviewTurn,
  NextInterviewerAction,
  ModerationRecord,
  TranscriptCleanupResult,
  EndpointReason,
  CoverageDelta,
} from '@shared/domain';
import { newId } from '@shared/domain';
import { RUNTIME_DEFAULTS } from '@shared/constants/runtime-defaults';
import { AppError } from '@shared/errors/app-error';
import { withDeadlineFallback, withTimeout, nowMs as defaultNow, splitParagraphs, wordCount } from '@shared/utils';

import {
  nextState,
  canTransition,
  availableCommands,
  isCommandLegal,
  isMicGateOpen,
  type CommandContext,
  type TransitionTrigger,
} from './state-machine';
import { withRetry } from '../providers/retry';
import { planSpeaking } from '../media/media-planner';
import { validateQuestion, deterministicRepair } from './question-validator';
import { applyCoverageUpdates, incrementFollowUp } from './coverage-controller';
import { pickFallback } from './fallback-planner';
import { DurationCalibrator } from './duration-calibrator';
import { buildCoverageContext, buildRecentTurns, buildModerationGuidance } from './context-builder';
import { decideEndpoint, shouldRunClassifier, autoCommitAllowed } from './endpoint-controller';
import { NOOP_LOGGER, type Logger, type StagePort, type SnapshotSink, type ErrorSink, type Clock } from './ports';

export interface OrchestratorModels {
  interviewer: string;
  cleanup: string;
  endpoint: string;
  repair: string;
  stt: string;
}

export interface SessionContext {
  session: InterviewSession;
  brief: InterviewBrief;
  character: InterviewerCharacter;
  composedSystemPrompt: string;
  coverage: SessionCoverageItem[];
  clips: MediaClip[];
  models: OrchestratorModels;
  voiceId: string;
  ttsSampleRate: number;
  captionsEnabled: boolean;
  selectedOutputDeviceId: string | null;
  targetQuestionCount: number;
}

export interface OrchestratorDeps {
  repository: CandidCueRepository;
  model: InterviewModelAdapter;
  moderation: ModerationAdapter;
  stt: SpeechToTextAdapter;
  tts: TextToSpeechAdapter;
  stage: StagePort;
  snapshotSink: SnapshotSink;
  errorSink: ErrorSink;
  logger?: Logger;
  clock?: Clock;
}

interface CurrentTurn {
  id: string;
  ordinal: number;
  question: QuestionRecord;
  generationId: number;
  speechStartedAt: number | null;
  speechEndedAt: number | null;
  rawTranscript: string;
}

const STAGE_VISUAL: Record<SessionRuntimeState, StageStateProjection['visualState']> = {
  IDLE: 'standby',
  PREPARING: 'standby',
  READY: 'standby',
  INTERVIEWER_THINKING: 'thinking',
  INTERVIEWER_BUFFERING: 'thinking',
  INTERVIEWER_SPEAKING: 'speaking',
  USER_ARMED: 'listening',
  USER_SPEAKING: 'listening',
  ENDPOINT_CANDIDATE: 'listening',
  TURN_FINALIZING: 'thinking',
  PAUSED: 'paused',
  RECOVERING: 'recovering',
  FINISHING: 'complete',
  COMPLETED: 'complete',
  ERROR: 'error',
};

const MIC_STATE: Record<SessionRuntimeState, 'closed' | 'armed' | 'active'> = {
  IDLE: 'closed', PREPARING: 'closed', READY: 'closed', INTERVIEWER_THINKING: 'closed',
  INTERVIEWER_BUFFERING: 'closed', INTERVIEWER_SPEAKING: 'closed', USER_ARMED: 'armed',
  USER_SPEAKING: 'active', ENDPOINT_CANDIDATE: 'active', TURN_FINALIZING: 'closed',
  PAUSED: 'closed', RECOVERING: 'closed', FINISHING: 'closed', COMPLETED: 'closed', ERROR: 'closed',
};

/** How often the auto-endpoint loop re-evaluates while the user is silent. */
const ENDPOINT_TICK_MS = 250;

const STATUS_TEXT: Partial<Record<SessionRuntimeState, string>> = {
  INTERVIEWER_THINKING: 'Thinking',
  INTERVIEWER_BUFFERING: 'Thinking',
  USER_ARMED: 'Listening',
  USER_SPEAKING: 'Listening',
  ENDPOINT_CANDIDATE: 'Listening',
  TURN_FINALIZING: 'Thinking',
  PAUSED: 'Paused',
  RECOVERING: 'Reconnecting',
  COMPLETED: 'Interview complete',
  FINISHING: 'Interview complete',
};

/**
 * The single source of truth for a live interview session (spec §11, §12).
 * Every state change goes through here; renderers only request commands.
 */
export class SessionOrchestrator {
  private state: SessionRuntimeState = 'IDLE';
  private generationId = 0;
  private commitInFlight = false;
  private endAfterTurnRequested = false;
  private snapshotVersion = 0;
  private rollingSummary: string;
  private coverage: SessionCoverageItem[];
  private currentTurn: CurrentTurn | null = null;
  // True once the current turn's answer is committed but before the next turn is
  // built. If realizing the next question fails here, resume() must advance to
  // the next question rather than replaying (and wiping) the answered turn (#9).
  private currentTurnAnswered = false;
  private nextOrdinal: number;
  // Memoized hard ceiling on answered questions (issue #17):
  // ceil(targetQuestionCount * RUNTIME_DEFAULTS.questionCountHardCapFactor).
  // Lazily computed; the target is immutable for the session.
  private questionCountHardCap: number | null = null;
  private recentClipIds: string[] = [];
  private usedFallbackTexts: string[] = [];
  private recentQuestionTexts: string[] = [];
  private pausedFromState: SessionRuntimeState | null = null;
  // The working state to return to once a reconnect succeeds (RECOVERING →
  // PAUSED → resume). Captured when entering RECOVERING and folded back into
  // pausedFromState on `recovered` so resume() picks the right destination (#14).
  private recoveredFromState: SessionRuntimeState | null = null;
  // Aborts an in-flight reconnect (the connectFactory await inside stt.reconnect)
  // when the session is ended/disposed mid-RECOVERING, so a late-resolving
  // connect can't leave a freshly-opened transport dangling after teardown (#14).
  private reconnectAbort: AbortController | null = null;
  // Aborts the speculative next-question TTS synthesis the commit pipeline runs
  // in parallel with the answered-turn DB write (Overlap A, #52). Bumped in
  // lockstep with generationId via bumpGeneration() so any pause/skip/endNow/
  // recovery that invalidates the commit also cancels its in-flight TTS request
  // instead of leaving a multi-second synthesis running for a discarded turn.
  // Null whenever no commit fan-out is in flight.
  private _commitAbort: AbortController | null = null;
  private lastCommittedAnswer = '';
  private interimTranscript = '';
  private micLevel = 0;
  private micClipping = false;
  private endpointTimer: ReturnType<typeof setInterval> | null = null;
  private endpointEvalInFlight = false;
  private providerHealth: PublicProviderStatus = {
    openai: 'ok',
    inworldStt: 'ok',
    inworldTts: 'ok',
    lastQuestionLatencyMs: null,
  };
  private recoverableWarning: string | null = null;
  private readonly startedAtMs: number;
  private readonly calibrator = new DurationCalibrator();
  private opChain: Promise<unknown> = Promise.resolve();

  private readonly r = RUNTIME_DEFAULTS;
  private readonly log: Logger;
  private readonly now: Clock;

  constructor(
    private readonly deps: OrchestratorDeps,
    private readonly ctx: SessionContext,
  ) {
    this.log = deps.logger ?? NOOP_LOGGER;
    this.now = deps.clock ?? defaultNow;
    this.coverage = ctx.coverage.map((c) => ({ ...c }));
    this.rollingSummary = ctx.session.rollingSummary ?? '';
    this.nextOrdinal = ctx.session.currentTurnOrdinal + 1;
    this.startedAtMs = this.now();
  }

  getState(): SessionRuntimeState {
    return this.state;
  }

  // -- exclusive operation queue (spec §12.3) ------------------------------
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.opChain.then(fn, fn);
    this.opChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // -- transitions ---------------------------------------------------------
  private transition(trigger: TransitionTrigger, reason = ''): boolean {
    const target = nextState(this.state, trigger);
    if (target == null) {
      this.log.warn('session.invalid_transition', { from: this.state, trigger });
      return false;
    }
    const from = this.state;
    this.state = target;
    // Capture the pre-pause state at the moment we enter PAUSED, from EVERY
    // pause entry point (manual pause, empty-answer, pipeline failure), so
    // resume() can tell whether the user's mic was open (spec §5.5). When PAUSED
    // is re-entered from RECOVERING via `recovered`, restore the true
    // pre-recovery state captured in recoveredFromState rather than RECOVERING
    // itself — otherwise a resume after a reconnect would lose the mic-open
    // context and replay the question instead of re-arming the turn (#14).
    if (target === 'PAUSED') {
      this.pausedFromState = from === 'RECOVERING' ? this.recoveredFromState : from;
    }
    // Entering RECOVERING: remember where to resume to once reconnect succeeds.
    // From PAUSED the true pre-pause state lives in pausedFromState (a failed
    // resume re-entered recovery); from a live state it is `from`. An operator
    // retry (ERROR → RECOVERING) keeps the value captured when recovery began.
    if (target === 'RECOVERING' && from !== 'ERROR') {
      this.recoveredFromState = from === 'PAUSED' ? this.pausedFromState : from;
    }
    this.log.info('session.state_changed', { from, to: target, trigger, reason });
    this.publishStage();
    this.publishSnapshot();
    return true;
  }

  // -- public command surface ---------------------------------------------
  async prepareOpening(): Promise<void> {
    // A duplicate prepare once the opening is already built is a no-op.
    if (this.state === 'READY') return;
    if (this.state !== 'IDLE' && this.state !== 'PREPARING') {
      throw stateConflict('prepareOpening requires IDLE or PREPARING');
    }
    // Route IDLE→PREPARING through transition() so stage + snapshot publish (the
    // spec §11.3 invariant PREPARING.stt='warming' must be visible to the UI the
    // moment preparation begins); a direct `this.state = 'PREPARING'` previously
    // left the UI blind to PREPARING until preflight landed on READY. We do NOT
    // short-circuit on PREPARING itself: reaching PREPARING and then failing
    // buildAndCacheTurn (TTS) would strand the session mid-prepare, so a retry
    // must be able to rebuild the opening. (Production reconstructs a fresh
    // orchestrator per prepare IPC; this same-instance retry is defensive.)
    if (this.state === 'IDLE') this.transition('prepareSession');
    await this.buildAndCacheTurn(this.openingQuestionRecord(), 'opening_cache');
    this.transition('preflightPassed', 'opening cached');
  }

  async begin(): Promise<void> {
    if (this.state !== 'READY') throw stateConflict('begin requires READY');
    await this.markSessionStarted();
    await this.playCurrentTurn('begin');
  }

  /**
   * Persist the session as active and stamp `startedAt` once, when the
   * interview actually begins. Without this the session row stays in the
   * `preflight` state with a null start time, breaking resume detection and
   * review/export timestamps (CORR-07).
   */
  private async markSessionStarted(): Promise<void> {
    if (this.ctx.session.status === 'active' && this.ctx.session.startedAt != null) return;
    const nowIso = new Date(this.now()).toISOString();
    this.ctx.session = {
      ...this.ctx.session,
      status: 'active',
      startedAt: this.ctx.session.startedAt ?? nowIso,
      updatedAt: nowIso,
    };
    await this.deps.repository.updateSession(this.ctx.session);
  }

  async commitUserTurn(reason: 'manual' | 'automatic'): Promise<void> {
    if (!['USER_ARMED', 'USER_SPEAKING', 'ENDPOINT_CANDIDATE'].includes(this.state)) {
      throw stateConflict(`commit not allowed in ${this.state}`);
    }
    if (this.commitInFlight) return; // idempotent (spec directive 10)
    // Claim the flag synchronously, before runExclusive enqueues onto opChain.
    // runExclusive only schedules the pipeline (it never runs it in this tick),
    // so if we waited for commitPipeline to set the flag, two same-tick callers
    // (double-click / duplicate IPC) would both pass the guard above and both
    // enqueue — the second committing the now-empty armed next turn (#16).
    this.commitInFlight = true;
    await this.runExclusive(() => this.commitPipeline(reason));
  }

  pause(): void {
    // `transition` records pausedFromState from the pre-transition state.
    if (!this.transition('pause')) return;
    this.bumpGeneration(); // invalidate any in-flight provider work
    this.clearEndpointTimer();
    this.deps.stage.closeMicGate();
  }

  async resume(): Promise<void> {
    if (this.state !== 'PAUSED') return;
    // Resume to the safest prior state (spec §5.5).
    if (this.currentTurn && this.micWasOpenBeforePause()) {
      // Re-activate STT FIRST, and only arm the mic if it succeeds. pause stopped
      // the client's turn, so without resumeTurn its turnActive stays false and
      // every partial/final is dropped. If we armed the mic before confirming STT
      // is live and resumeTurn threw (STT_DISCONNECTED — transport dropped), the
      // session would sit in USER_ARMED with the mic projection 'armed' but STT
      // inactive — an "armed but deaf" state where the user speaks into the void.
      // resumeTurn (unlike beginTurn / armUserTurn) re-arms WITHOUT resetting the
      // accumulator or the turn's speech timestamps, so the user's pre-pause words
      // and userHasSpoken are preserved (spec §5.5).
      try {
        await this.deps.stt.resumeTurn(this.currentTurn.id);
      } catch (err) {
        // STT could not be re-activated (the transport dropped). Route into
        // RECOVERING so the orchestrator auto-reconnects and self-heals, rather
        // than stranding the operator in PAUSED with a manual retry prompt (#14).
        // The mic stays closed; resume() never rejects unhandled.
        this.log.warn('stt.resume_failed', { error: String(err) });
        this.enterRecovery('stt resume failed');
        return;
      }
      // STT is live again: now it is safe to transition to USER_ARMED and open the
      // mic, then clear the recoverable warning on this success path. Guard the
      // transition: a Retake (or Repeat) dispatched while we awaited resumeTurn is
      // still legal from PAUSED and may have already driven us into
      // INTERVIEWER_BUFFERING. If so, resumeUserTurn is illegal (returns false) and
      // we must NOT openMicGate over the in-progress re-delivery (#62).
      if (!this.transition('resumeUserTurn')) return;
      this.deps.stage.openMicGate();
    } else if (this.currentTurn && !this.currentTurnAnswered) {
      this.transition('resumePreparedQuestion');
      await this.playCurrentTurn('resume');
    } else if (this.currentTurn && this.currentTurnAnswered) {
      // The current turn's answer was committed, but realizing the next question
      // failed (e.g. TTS) and paused us with currentTurn still on the answered
      // turn. Replaying it would re-persist the turn as "asked" with a null
      // answer — wiping the committed answer — and force the user to re-answer.
      // Instead advance: generate and play the next question from the committed
      // answer, exactly as skipQuestion does (issue #9).
      this.transition('resumeNextQuestion');
      try {
        const action = await this.generateNextActionOrFallback(this.lastAnswerText());
        await this.realizeNextQuestion(action, 'model');
      } catch (err) {
        // Stay PAUSED with the recoverable warning intact. The early return
        // skips the warning-clearing tail below, mirroring the STT-failure
        // branch above so the operator still sees a retry prompt.
        await this.handlePipelineFailure(err);
        return;
      }
    } else {
      this.transition('resumeBeforeStart');
    }
    // If playback failed during resume, failStagePlayback() put us back in PAUSED
    // with a fresh recoverable warning (it pauses without throwing, so the catch
    // blocks above don't see it). Leave that warning intact instead of clearing
    // it on the success tail, or the operator is stranded in PAUSED with no retry
    // prompt. The throwing failure paths above already returned early.
    if (this.state === 'PAUSED') return;
    // Success path: clear any recoverable warning (e.g. a prior failed-resume
    // prompt) and republish so the UI drops it.
    this.recoverableWarning = null;
    this.publishSnapshot();
  }

  /** The context the command-legality projection inspects (review P0-08). */
  getCommandContext(): CommandContext {
    return {
      state: this.state,
      commitInFlight: this.commitInFlight,
      hasCurrentTurn: this.currentTurn != null,
      userHasSpoken: this.currentTurn?.speechStartedAt != null,
      currentTurnAnswered: this.currentTurnAnswered,
    };
  }

  async repeatQuestion(): Promise<void> {
    this.assertCommandLegal('REPEAT_QUESTION');
    // Re-asking the current turn makes it an unanswered prepared question again,
    // so a later resume must replay it — not advance past it (#9). Clear the
    // answered flag in case we are repeating from a post-commit recoverable pause.
    this.currentTurnAnswered = false;
    // Reuse the cached question + audio; choose a different clip when possible.
    await this.runExclusive(async () => {
      // Drive back into the buffering state so playback transitions are legal
      // from USER_ARMED / PAUSED (review P0-08: Repeat from a non-buffering
      // state previously fired an illegal `stageReady`).
      if (this.state === 'USER_ARMED' || this.state === 'PAUSED') {
        this.transition('replayQuestion', 'repeat');
      }
      // Re-plan the speaking media so a repeat picks a different clip when one is
      // available (item #26), reusing the cached TTS audio (no re-synthesis).
      const turn = this.currentTurn;
      if (turn) this.replanForRepeat(turn);
      await this.playCurrentTurn('repeat');
    });
  }

  async skipQuestion(): Promise<void> {
    // Only valid from USER_ARMED before any speech exists for the current turn.
    this.assertCommandLegal('SKIP_QUESTION');
    this.bumpGeneration();
    this.deps.stage.closeMicGate();
    // USER_ARMED → INTERVIEWER_THINKING so realizeNextQuestion's playback
    // transitions are legal (review P0-08: Skip previously fired an illegal
    // `stageReady` from USER_ARMED).
    this.transition('skipToNextQuestion', 'skip');
    await this.runExclusive(async () => {
      const action = await this.generateNextActionOrFallback(this.lastAnswerText());
      // A skip can land on a completion just like an answered turn: the model may
      // return `complete`, request close after the turn, or End After Turn may be
      // armed. Honour that here instead of realizing an empty question (#13) — the
      // same close decision commitPipeline makes after a committed answer.
      const shouldClose =
        action.action === 'complete' || action.shouldCloseAfterAnswer || this.endAfterTurnRequested;
      if (shouldClose) {
        await this.completeSession(action, 'skip complete');
        return;
      }
      await this.realizeNextQuestion(action, 'model');
    });
  }

  /**
   * Discard the in-progress answer and re-deliver the SAME question (Retake, the
   * complement of Repeat). Legal once the creator has begun answering — from any
   * mic-open state or a pause taken mid-answer (#62). The turn object and its
   * cached TTS are reused (same turnId, no re-synthesis); only the answer fields
   * are cleared. Modeled on {@link skipQuestion}: a synchronous prefix that
   * cancels in-flight work and resets state before any await, then the buffered
   * re-play inside runExclusive.
   */
  async retakeTurn(): Promise<void> {
    this.assertCommandLegal('RETAKE_TURN');
    // bumpGeneration() cancels endpoint evaluation in flight and aborts any
    // speculative next-question TTS; clearEndpointTimer() stops the silence loop.
    this.bumpGeneration();
    this.clearEndpointTimer();
    this.deps.stage.closeMicGate();
    // Reset the discarded answer SYNCHRONOUSLY — before the transition and any
    // await — so userHasSpoken flips false at once and the mic-gate guard in
    // onSttFinalSegment drops any late final from the abandoned take. armUserTurn
    // (inside playCurrentTurn) clears these again and beginTurn() resets the STT
    // accumulator, so the next take starts clean. We deliberately do NOT call
    // stt.endTurn(): there is no transcript to finalize and it would add a
    // network round-trip for words we are throwing away (cf. skipQuestion).
    if (this.currentTurn) {
      this.currentTurn.rawTranscript = '';
      this.currentTurn.speechStartedAt = null;
      this.currentTurn.speechEndedAt = null;
    }
    this.interimTranscript = '';
    // The turn is an unanswered prepared question again (it never committed, but
    // keep this explicit and symmetric with repeatQuestion's reset).
    this.currentTurnAnswered = false;
    // Drive back into INTERVIEWER_BUFFERING so playCurrentTurn's playback
    // transitions are legal from USER_SPEAKING / ENDPOINT_CANDIDATE / USER_ARMED
    // / PAUSED (the retakeTurn trigger targets INTERVIEWER_BUFFERING).
    this.transition('retakeTurn', 'retake');
    await this.runExclusive(async () => {
      // Re-plan the speaking media so the retake picks a different clip when one
      // is available (same as Repeat, item #26), reusing the cached TTS audio.
      const turn = this.currentTurn;
      if (turn) this.replanForRepeat(turn);
      await this.playCurrentTurn('retake');
    });
  }

  endAfterTurn(): void {
    this.assertCommandLegal('END_AFTER_TURN');
    this.endAfterTurnRequested = true;
    this.publishSnapshot();
  }

  async endNow(): Promise<void> {
    this.assertCommandLegal('END_NOW');
    this.bumpGeneration();
    // Cancel any in-flight reconnect (END_NOW is legal from RECOVERING) so its
    // connectFactory does not open a transport into a session we are ending.
    this.reconnectAbort?.abort();
    this.clearEndpointTimer();
    this.deps.stage.closeMicGate();
    // Never mark the session completed in persistence unless the state machine
    // actually finished (review P0-08: endNow previously persisted 'completed'
    // even when the transitions were illegal, diverging DB from the live UI).
    // assertCommandLegal('END_NOW') above already guarantees `completionSelected`
    // is legal (END_NOW_STATES ⊆ states where it is legal), so the shared
    // completion path drives it. endNow has no model action → no closing line is
    // spoken (it is an abort, not a sign-off).
    await this.completeSession(undefined, 'ended now');
  }

  /** Operator retry from the terminal ERROR state (ERROR → RECOVERING). */
  retryRecovery(): void {
    this.assertCommandLegal('RETRY_RECOVERY');
    if (!this.transition('operatorRetry', 'operator retry')) return;
    this.bumpGeneration(); // a fresh reconnect generation; invalidate any stale one
    this.recoverableWarning = 'Reconnecting to the speech service…';
    this.publishSnapshot();
    void this.launchReconnect();
  }

  /**
   * Route a recoverable device/provider fault into RECOVERING and kick off an
   * async reconnect (#14). Wired call sites (a dropped STT transport seen on
   * resume, or an STT_DISCONNECTED pipeline failure) always have a recovery edge;
   * if some future caller does not, degrade to a plain recoverable pause so the
   * session is never stranded mid-flight.
   */
  private enterRecovery(reason: string): void {
    if (!canTransition(this.state, 'deviceOrProviderNeedsRecovery')) {
      this.recoverableWarning = 'Speech service disconnected. Resume to try again.';
      if (this.transition('pause', reason)) {
        this.bumpGeneration();
        this.clearEndpointTimer();
        this.deps.stage.closeMicGate();
      }
      this.publishSnapshot();
      return;
    }
    this.markProvider('inworldStt', 'degraded');
    this.recoverableWarning = 'Reconnecting to the speech service…';
    this.transition('deviceOrProviderNeedsRecovery', reason);
    this.bumpGeneration(); // invalidate any in-flight provider work
    this.clearEndpointTimer();
    this.deps.stage.closeMicGate();
    void this.launchReconnect();
  }

  /**
   * Drive the async reconnect that gives RECOVERING a real exit (#14). Re-opens
   * the STT transport with bounded backoff; on success fires `recovered`
   * (→ PAUSED), on exhaustion fires `recoveryFailed` (→ ERROR, where the operator
   * can RETRY_RECOVERY). The generation guard discards a stale resolution if the
   * session has since been ended, paused, or re-entered recovery — a late
   * reconnect must never transition a state the operator already escaped.
   */
  private async launchReconnect(): Promise<void> {
    const myGen = this.generationId;
    const superseded = (): boolean => this.state !== 'RECOVERING' || myGen !== this.generationId;
    // Abort the in-flight connect if the session is ended/disposed mid-reconnect,
    // so a late connectFactory resolution can't leave an orphaned open transport.
    const ac = new AbortController();
    this.reconnectAbort = ac;
    try {
      await withRetry(() => this.deps.stt.reconnect(ac.signal), { shouldAbort: superseded });
    } catch (err) {
      if (superseded()) return;
      this.log.error('stt.reconnect_failed', { error: String(err) });
      this.markProvider('inworldStt', 'down');
      this.recoverableWarning = 'Could not reconnect to the speech service. Tap Retry to try again.';
      this.transition('recoveryFailed', 'reconnect exhausted');
      return;
    } finally {
      if (this.reconnectAbort === ac) this.reconnectAbort = null;
    }
    if (superseded()) return;
    this.markProvider('inworldStt', 'ok');
    this.recoverableWarning = null;
    this.transition('recovered', 'reconnected');
  }

  /** Reject a command that is illegal in the current state without side effects. */
  private assertCommandLegal(command: Parameters<typeof isCommandLegal>[0]): void {
    if (!isCommandLegal(command, this.getCommandContext())) {
      throw stateConflict(`${command} is not available in ${this.state}`);
    }
  }

  // -- STT-driven events (auto endpoint) -----------------------------------
  onSpeechStarted(at: number): void {
    // A speechStarted arriving while we are already evaluating an endpoint
    // candidate means the user resumed talking after a pause. The STT provider
    // emits no distinct "resume" event — resume is always a second bare
    // speechStarted after a prior speechStopped — so our own state is the only
    // reliable resume signal. Route it to the already-legal speechResumed
    // trigger instead of firing an illegal speechStarted from ENDPOINT_CANDIDATE
    // (which would log session.invalid_transition and leave the state stuck) (#15).
    if (this.state === 'ENDPOINT_CANDIDATE') {
      this.onSpeechResumed();
      return;
    }
    this.clearEndpointTimer();
    if (this.currentTurn && this.currentTurn.speechStartedAt == null) {
      this.currentTurn.speechStartedAt = at;
    }
    this.transition('speechStarted');
  }

  onSpeechStopped(at: number): void {
    if (this.currentTurn) this.currentTurn.speechEndedAt = at;
    this.transition('speechStopped');
    // Begin auto-endpoint evaluation as silence grows (MIC-05). No-op in manual mode.
    this.startEndpointEvaluation();
  }

  onSpeechResumed(): void {
    this.clearEndpointTimer();
    this.transition('speechResumed');
  }

  /** A live interim (non-final) STT transcript for the current turn (MIC-04). */
  onSttPartial(text: string): void {
    // Same mic-gate gate as onSttFinalSegment: a stale interim from an abandoned
    // take (e.g. arriving during the INTERVIEWER_BUFFERING window of a Retake)
    // must not flash old text into the operator's live caption (#62).
    if (!isMicGateOpen(this.state)) return;
    this.interimTranscript = text;
    this.publishSnapshot();
  }

  /** A finalized STT segment: append to the turn's accumulated transcript (MIC-04). */
  onSttFinalSegment(text: string): void {
    // The streaming transcript shadows the floor only while the mic gate is open
    // (spec §11.3: stt='streaming' solely in the mic-open states). Once the floor
    // is released — commit (TURN_FINALIZING reads endTurn's result, not this
    // shadow), pause, skip, or retake — drop late segments so a final arriving in
    // the millisecond window after Retake closes the gate cannot contaminate the
    // freshly-cleared rawTranscript of the next take (#62).
    if (!isMicGateOpen(this.state)) return;
    const segment = text.trim();
    if (segment.length > 0 && this.currentTurn) {
      this.currentTurn.rawTranscript = this.currentTurn.rawTranscript
        ? `${this.currentTurn.rawTranscript} ${segment}`.trim()
        : segment;
    }
    this.interimTranscript = '';
    this.markProvider('inworldStt', 'ok');
    this.publishSnapshot();
  }

  /** A streaming STT error: degrade provider health and surface it to the operator. */
  onSttError(message: string): void {
    this.log.warn('stt.stream_error', { message });
    this.markProvider('inworldStt', 'degraded');
    this.publishSnapshot();
  }

  /** Set the live STT connection health (called once after the connect attempt). */
  setSttConnected(connected: boolean): void {
    this.markProvider('inworldStt', connected ? 'ok' : 'down');
    this.publishSnapshot();
  }

  /** Live microphone meter reading from the stage capture graph (MIC-06/07). */
  reportMeter(reading: AudioMeterReading): void {
    this.micLevel = reading.average;
    this.micClipping = reading.clipping;
    // The stage emits ~10 readings/sec; publish each so the operator meter is live.
    this.publishSnapshot();
  }

  /** Release timers (and any in-flight reconnect) when the session ends. */
  dispose(): void {
    this.clearEndpointTimer();
    this.reconnectAbort?.abort();
    // Bump the generation so an in-flight commit fan-out (Overlap A) trips its
    // stale guard and silently bails — never running mountPreparedTurn or
    // handlePipelineFailure (transition/publishSnapshot) against a torn-down
    // orchestrator. bumpGeneration() also aborts the speculative TTS.
    this.bumpGeneration();
  }

  /**
   * Advance the generation counter and cancel any in-flight commit-pipeline TTS.
   * Every generationId bump invalidates a running commit (its stale-gen guard
   * discards the result), so the speculative TTS synthesis the commit fan-out
   * started (Overlap A, #52) must be aborted in lockstep — otherwise a pause/
   * skip/endNow/recovery would leave a multi-second synthesis running for a turn
   * the operator already abandoned. Coupling the two here means no bump site can
   * forget the abort. A no-op when no commit fan-out is in flight.
   */
  private bumpGeneration(): void {
    this.generationId++;
    this._commitAbort?.abort();
    this._commitAbort = null;
  }

  /** Evaluate whether the conservative/balanced classifier should auto-commit. */
  async evaluateEndpoint(input: { transcript: string; silenceMs: number; speechMs: number }): Promise<void> {
    const mode = this.ctx.session.endpointMode;
    if (this.commitInFlight || this.state !== 'ENDPOINT_CANDIDATE') return;
    // Identify the turn we're judging so a slow classifier can't commit a later one.
    const evalTurnId = this.currentTurn?.id ?? null;
    let classifier = null;
    if (
      shouldRunClassifier({
        mode,
        silenceMs: input.silenceMs,
        speechMs: input.speechMs,
        transcript: input.transcript,
        commitInFlight: this.commitInFlight,
      })
    ) {
      try {
        classifier = await this.deps.model.classifyEndpoint({
          question: this.currentTurn?.question.text ?? '',
          transcript: input.transcript,
          speechDurationMs: input.speechMs,
          silenceDurationMs: input.silenceMs,
          mode,
          modelId: this.ctx.models.endpoint,
        });
      } catch {
        classifier = null;
      }
    }
    const decision = decideEndpoint({
      mode,
      silenceMs: input.silenceMs,
      speechMs: input.speechMs,
      transcript: input.transcript,
      classifier,
    });
    if (decision.commit) {
      // Re-check after the (possibly slow) classifier await: a concurrent tick or
      // a manual commit may already have moved us on, or armed a different turn.
      // Never commit a stale or different turn.
      if (
        this.commitInFlight ||
        this.state !== 'ENDPOINT_CANDIDATE' ||
        this.currentTurn?.id !== evalTurnId
      ) {
        return;
      }
      await this.commitUserTurn('automatic');
    } else {
      // Symmetric staleness check: a classifier that resolves after we have left
      // ENDPOINT_CANDIDATE (e.g. the user resumed speech, moving us back to
      // USER_SPEAKING) is stale — its classifierWait transition would be illegal
      // from the new state and only log an invalid_transition (#15).
      if (this.state !== 'ENDPOINT_CANDIDATE' || this.currentTurn?.id !== evalTurnId) {
        return;
      }
      this.transition('classifierWait');
    }
  }

  // -- core: play the current prepared turn --------------------------------
  private async playCurrentTurn(reason: string): Promise<void> {
    const turn = this.currentTurn;
    if (!turn) throw stateConflict('no prepared turn to play');
    // The mic gate must be closed while Mira speaks (spec §13.3). Idempotent.
    this.deps.stage.closeMicGate();
    // Drive to INTERVIEWER_BUFFERING from whatever pre-play state we are in.
    // begin: READY → THINKING → BUFFERING. next question: THINKING → BUFFERING.
    if (this.state === 'READY') this.transition('begin', reason);
    if (this.state === 'INTERVIEWER_THINKING') this.transition('questionAndTtsReady', reason);
    // else: already buffering (repeat/resume).

    // Snapshot the generation BEFORE the FIRST cancelable await. We are now in
    // INTERVIEWER_BUFFERING, where pause/endNow/skip are legal and each bumps
    // generationId to cancel this turn. If we sampled myGen only after the
    // persist/buildPlan/preload awaits, a bump landing during one of those awaits
    // would be folded into the new generation and the guard would wrongly pass,
    // arming a turn the operator already cancelled. Sampling here means any such
    // bump makes myGen !== this.generationId at every later check. Mirrors
    // commitPipeline's stale-generation guard (a silent bail; no
    // failStagePlayback, no recoverable warning).
    const myGen = this.generationId;

    // Build the playback plan up front: buildPlaybackPlan only reads the cached
    // TTS buffer (set in mountPreparedTurn) and copies it for IPC — no I/O — so
    // it can feed the preload immediately.
    const plan = await this.buildPlaybackPlan(turn);

    // Overlap B (#52): persist the turn as "asked" (crash-recovery, spec §10.6)
    // IN PARALLEL with shipping the plan to the renderer for decode. These were
    // serial; the persist's DB write and the renderer's decodeAudioData are
    // independent waits. Sending the plan early is safe — the renderer only PLAYS
    // on playSpeechPlan, never on preload. Playback is only "confirmed" when the
    // stage reports ready: a stage error or deadline timeout returns false, so
    // Mira never actually spoke and we must NOT advance / open the mic / arm.
    const [, preloaded] = await Promise.all([
      this.persistAskedTurn(turn),
      this.deps.stage.preloadSpeechPlan(plan),
    ]);
    if (myGen !== this.generationId) {
      this.log.info('session.stale_playback_discarded', { turnId: turn.id, phase: 'preload' });
      return;
    }
    if (!preloaded) {
      this.failStagePlayback(reason);
      return;
    }
    this.transition('stageReady', reason);
    const played = await this.deps.stage.playSpeechPlan(plan); // resolves when audio ends
    // A late ready/ended for a cancelled/superseded turn must be ignored: the
    // pause/endNow/skip that bumped the generation already owns the stage state.
    if (myGen !== this.generationId) {
      this.log.info('session.stale_playback_discarded', { turnId: turn.id, phase: 'play' });
      return;
    }
    if (!played) {
      this.failStagePlayback(reason);
      return;
    }
    // Audio end is authoritative end of Mira's speaking turn (spec §18.7).
    this.transition('audioEnded', reason);
    this.deps.stage.openMicGate();
    await this.armUserTurn(turn);
  }

  /**
   * Stage playback was not confirmed (error report or deadline timeout). Hold in
   * the recoverable-pause state — same mechanism as a pipeline failure — so the
   * mic is never armed and the operator can retry or skip. The question is
   * already persisted as "asked", so a resume replays the prepared turn.
   */
  private failStagePlayback(reason: string): void {
    this.log.warn('stage.playback_not_confirmed', { state: this.state, reason });
    this.recoverableWarning = 'Stage playback failed. Resume to retry.';
    this.transition('pause', 'stage playback failed');
    this.publishSnapshot();
  }

  private async persistAskedTurn(turn: CurrentTurn): Promise<void> {
    const asked = this.composeTurn(turn, null, 'asked');
    await this.deps.repository.appendTurnAtomic({
      sessionId: this.ctx.session.id,
      turn: asked,
      coverage: this.coverage,
      rollingSummary: this.rollingSummary,
      currentTurnOrdinal: turn.ordinal,
    });
  }

  private async armUserTurn(turn: CurrentTurn): Promise<void> {
    turn.speechStartedAt = null;
    turn.speechEndedAt = null;
    this.interimTranscript = '';
    try {
      await this.deps.stt.beginTurn(turn.id);
    } catch (err) {
      this.log.warn('stt.begin_failed', { error: String(err) });
      // We have just opened the mic gate (audioEnded → USER_ARMED). If STT could
      // not arm because the transport dropped, staying USER_ARMED would be the
      // "armed but deaf" antipattern resume() deliberately avoids: mic open, STT
      // silent. Route the dropped transport into RECOVERING so it auto-reconnects
      // and the mic is closed (enterRecovery closes the gate) until it does (#14).
      if (err instanceof AppError && err.code === 'STT_DISCONNECTED') {
        this.enterRecovery('beginTurn failed');
      }
    }
  }

  // -- core: the commit pipeline (spec §12.2) ------------------------------
  private async commitPipeline(reason: 'manual' | 'automatic'): Promise<void> {
    const turn = this.currentTurn;
    if (!turn) {
      // commitInFlight was claimed in commitUserTurn; release it on this early
      // exit or all future commits would silently no-op (permanent lock).
      this.commitInFlight = false;
      return;
    }
    // commitInFlight is already true (claimed in commitUserTurn before enqueue).
    this.clearEndpointTimer();
    const myGen = this.generationId;
    const endpointReason: EndpointReason = reason;

    this.transition('manualCommit', reason);
    this.deps.stage.closeMicGate();

    try {
      // 1. Finalize STT (buffered fallback handled by the adapter).
      const finalize = await withDeadlineFallback(
        this.deps.stt.endTurn({ deadlineMs: this.r.sttFinalizeDeadlineMs }),
        this.r.sttFinalizeDeadlineMs + 100,
        () => ({ text: turn.rawTranscript, finalSegments: [], confidence: null }),
      );
      const rawTranscript = (finalize.value.text || turn.rawTranscript || '').trim();

      // Empty answer: do not invent content (spec §14.6, §22.3).
      if (rawTranscript.length === 0) {
        this.commitInFlight = false;
        // The user may have triggered speechStarted before the silence (so
        // userHasSpoken is true), which re-legalizes neither Skip nor Repeat from
        // this PAUSED state. Resume is the only action that is always legal here,
        // so advertise it alone (no "skip"/"repeat" the operator can't take).
        this.recoverableWarning = 'No speech was captured. Resume to try again.';
        this.transition('pause', 'empty answer');
        this.publishSnapshot();
        return;
      }

      await this.deps.repository.recordRawAnswer(this.ctx.session.id, turn.id, rawTranscript, endpointReason);
      this.transition('transcriptStored', reason);

      // 2. Cleanup + moderation in parallel, each with a deadline fallback.
      const [cleanup, moderation] = await Promise.all([
        withDeadlineFallback(
          this.deps.model.cleanTranscript({
            rawTranscript,
            glossary: this.ctx.brief.terminology,
            modelId: this.ctx.models.cleanup,
          }),
          this.r.transcriptCleanupDeadlineMs,
          () => fallbackCleanup(rawTranscript),
        ),
        withDeadlineFallback(
          this.deps.moderation.moderate(rawTranscript),
          this.r.moderationDeadlineMs,
          () => moderationUnavailable(),
        ),
      ]);

      const cleanupResult = cleanup.value;
      const moderationResult = moderation.value;
      const cleanedText = cleanupResult.cleanedText || rawTranscript;

      const answer = this.buildAnswerRecord({
        turn,
        rawTranscript,
        cleanup: cleanupResult,
        moderation: moderationResult,
        endpointReason,
        sttLatencyMs: finalize.latencyMs,
        cleanupLatencyMs: cleanup.timedOut ? null : cleanup.latencyMs,
        // recoveredFromBufferedAudio must only be true when stt.recoverFromAudio
        // actually produced the transcript. The finalize deadline fallback just
        // reuses the already-streamed turn.rawTranscript — no batch audio
        // recovery occurs — so this is false. Wiring buffered-audio recovery
        // into the live flow is deferred.
        recovered: false,
      });

      // 3. Next action (GPT-5.5) with fallback to the ranked bank (spec §22.2).
      const action = await this.generateNextActionOrFallback(cleanedText, moderationResult);

      // Stale check — a pause/skip during generation invalidates this turn.
      if (myGen !== this.generationId) {
        this.log.info('session.stale_result_discarded', { turnId: turn.id });
        this.commitInFlight = false;
        return;
      }

      // 4. Apply coverage + summary, compose the answered turn for persistence.
      const { coverage, deltas } = this.applyAction(action, turn.id);
      this.coverage = coverage;
      this.rollingSummary = action.updatedSessionSummary || this.rollingSummary;

      const answeredTurn = this.composeTurn(turn, answer, 'answered', deltas);
      const persistAnswered = {
        sessionId: this.ctx.session.id,
        turn: answeredTurn,
        coverage: this.coverage,
        rollingSummary: this.rollingSummary,
        currentTurnOrdinal: turn.ordinal,
      };

      // 5. Decide: close, or build + play the next question.
      // Hard safety cap (issue #17): if enough questions have been posed, force
      // completion regardless of the model's decision — a model that keeps
      // returning `ask` must not run forever. Evaluated against turn.ordinal, the
      // count of questions posed so far (the current turn's ordinal; skipped turns
      // count too, bounding total interview length). nextOrdinal has not advanced
      // yet here, so using it would close one turn early.
      const hardCapReached = this.hardQuestionCapReached(turn.ordinal);
      // Surface the cap only when it is the DECISIVE close reason; if the model
      // also asked to close this turn, attribute the close to the model (the OR
      // still guarantees the cap closes regardless, and collapses idempotently).
      const closedByHardCap =
        hardCapReached &&
        action.action !== 'complete' &&
        !action.shouldCloseAfterAnswer &&
        !this.endAfterTurnRequested;
      const shouldClose =
        action.action === 'complete' ||
        action.shouldCloseAfterAnswer ||
        this.endAfterTurnRequested ||
        hardCapReached;
      if (shouldClose) {
        // No next question to synthesize — persist the answer serially, then end.
        await this.deps.repository.appendTurnAtomic(persistAnswered);
        this.markAnswerCommitted(turn, cleanedText);
        if (closedByHardCap) {
          // Set before the transitions: completeSession()'s transition()
          // publishes a snapshot that reads recoverableWarning, so the COMPLETED
          // snapshot must carry it (issue #73 hard-cap attribution).
          this.recoverableWarning =
            'Reached the safety question limit. The interview ended automatically.';
          this.log.info('session.hard_question_cap_reached', {
            sessionId: this.ctx.session.id,
            questionCount: turn.ordinal,
            targetQuestionCount: this.ctx.targetQuestionCount,
            hardQuestionCap: this.hardQuestionCap(),
          });
        }
        // commitInFlight is released first (preserves the release-before-complete
        // ordering), then the shared completion path speaks the model's closing
        // line (when the action is an explicit `complete`) and closes STT. A
        // hard-cap close authors no sign-off — closedByHardCap implies
        // action.action !== 'complete', so completeSession plays no closing line —
        // and the reason carries the cap attribution into the transition log.
        this.commitInFlight = false;
        await this.completeSession(
          action,
          closedByHardCap ? 'hard question cap reached' : 'coverage complete',
        );
        return;
      }

      // 6. Overlap A (#52): synthesize the next question's audio IN PARALLEL with
      // the answered-turn persist. They are independent — the persist writes the
      // turn we just finished; the synthesis produces the turn we play next — and
      // were previously serial, so fanning them out trims the persist time off
      // the gap. The synthesis is speculative: a pause/skip/recovery aborts it
      // via _commitAbort (set below, bumped by bumpGeneration), and the
      // stale-generation guard discards its result before it is ever mounted.
      const nextRecord = this.questionRecordFrom(this.validateAndRepair(action), action, 'model');
      const ac = new AbortController();
      this._commitAbort = ac;
      const [appendOutcome, ttsOutcome] = await Promise.allSettled([
        // If the answered persist hard-fails, the next turn is moot — abort its
        // speculative TTS so the fan-out fails fast instead of waiting out the
        // full ttsDeadlineMs (and burning a synthesis call) for a turn we will
        // never mount.
        this.deps.repository.appendTurnAtomic(persistAnswered).catch((err) => {
          ac.abort();
          throw err;
        }),
        this.synthesizeSpeech(nextRecord, ac.signal),
      ]);
      if (this._commitAbort === ac) this._commitAbort = null;

      // The answer is durable the moment its persist resolves. Record the resume
      // sentinels (#9, CORR-08) immediately — independent of what happened to the
      // speculative TTS — so any pause/skip/failure from here advances rather
      // than replays the already-committed answer.
      if (appendOutcome.status === 'fulfilled') {
        this.markAnswerCommitted(turn, cleanedText);
      } else {
        // The answer was NOT persisted: a hard pipeline failure. resume() replays
        // this turn (currentTurnAnswered stays false). The aborted/failed TTS is
        // irrelevant here.
        this.commitInFlight = false;
        await this.handlePipelineFailure(appendOutcome.reason);
        return;
      }

      // Stale check — a pause/skip/endNow/recovery during the fan-out bumped the
      // generation (and aborted the in-flight TTS). The answer is safely
      // persisted above; silently discard the speculative next turn before it is
      // mounted (mirrors the post-LLM guard: a silent bail, no warning).
      if (myGen !== this.generationId) {
        this.log.info('session.stale_result_discarded', { turnId: turn.id });
        this.commitInFlight = false;
        return;
      }

      // A non-abort TTS failure (deadline timeout / provider down): the answer is
      // durable but there is no audio. Route to a recoverable pause; resume
      // advances to re-realize the next question (#9).
      if (ttsOutcome.status === 'rejected') {
        this.commitInFlight = false;
        await this.handlePipelineFailure(ttsOutcome.reason);
        return;
      }

      // 7. Mount the freshly synthesized turn (all state writes, gated on the
      // stale guard above) and play it.
      this.mountPreparedTurn(nextRecord, ttsOutcome.value);
      await this.playCurrentTurn('next-question');
      this.commitInFlight = false;
    } catch (err) {
      this.commitInFlight = false;
      await this.handlePipelineFailure(err);
    }
  }

  /** Build the next question's record + audio + media and start playback. */
  private async realizeNextQuestion(action: NextInterviewerAction, source: QuestionRecord['source']): Promise<void> {
    const validatedText = this.validateAndRepair(action);
    const record = this.questionRecordFrom(validatedText, action, source);
    await this.buildAndCacheTurn(record, source);
    await this.playCurrentTurn('next-question');
  }

  /**
   * Record that the current turn's answer is durably persisted: set the
   * answered-turn resume sentinel (#9, so resume() advances instead of replaying
   * a wiped turn), remember the asked question text, and cache the cleaned answer
   * so a later skip feeds the model real prior context (CORR-08). Called only
   * once the answered-turn appendTurnAtomic has resolved.
   */
  private markAnswerCommitted(turn: CurrentTurn, cleanedText: string): void {
    this.currentTurnAnswered = true;
    this.recentQuestionTexts.push(turn.question.text);
    this.lastCommittedAnswer = cleanedText;
  }

  private async generateNextActionOrFallback(
    currentAnswer: string,
    moderation?: ModerationRecord,
  ): Promise<NextInterviewerAction> {
    // How many prior turns feed the model is a per-session setting, not a
    // hardcoded constant. (The old `maxQuestionWords > 0 ? 6 : 6` ternary always
    // evaluated to 6 and gated on an unrelated word-count limit.)
    const recentTurnCount = this.ctx.session.settingsSnapshot.recentTurnCount;
    const recentTurns = await this.deps.repository.getRecentTurns(this.ctx.session.id, recentTurnCount);
    const gen = await withDeadlineFallback(
      this.deps.model.generateNextAction({
        characterSystemPrompt: this.ctx.composedSystemPrompt,
        brief: this.ctx.brief,
        coverage: buildCoverageContext(this.coverage),
        rollingSummary: this.rollingSummary,
        recentTurns: buildRecentTurns(recentTurns, recentTurnCount),
        currentAnswer,
        rawAnswerFallback: currentAnswer,
        moderationGuidance: buildModerationGuidance(moderation ?? null),
        nextOrdinal: this.nextOrdinal,
        targetQuestionCount: this.ctx.targetQuestionCount,
        endAfterTurn: this.endAfterTurnRequested,
        currentSectionId: null,
        modelId: this.ctx.models.interviewer,
      }),
      this.r.nextQuestionDeadlineMs,
      () => this.fallbackAction(),
    );
    // A timed-out next-question call means we fell back to the bank → degraded.
    this.providerHealth = {
      ...this.providerHealth,
      openai: gen.timedOut ? 'degraded' : 'ok',
      lastQuestionLatencyMs: gen.timedOut
        ? this.providerHealth.lastQuestionLatencyMs
        : Math.round(gen.latencyMs),
    };
    return gen.value;
  }

  private fallbackAction(): NextInterviewerAction {
    const picked = pickFallback(this.ctx.brief.fallbackQuestions, {
      coverage: this.coverage,
      currentSectionId: null,
      recentQuestions: this.recentQuestionTexts.slice(-5),
      usedFallbackTexts: this.usedFallbackTexts,
    });
    if (picked) {
      this.usedFallbackTexts.push(picked.text);
      return askAction(picked.text, picked.type, picked.targetCoverageItemIds);
    }
    // Nothing left to ask → close gracefully.
    return {
      action: 'complete',
      spokenText: '',
      questionType: 'closing',
      targetCoverageItemIds: [],
      coverageUpdates: [],
      followUpCounts: [],
      updatedSessionSummary: this.rollingSummary,
      currentSectionId: null,
      shouldCloseAfterAnswer: true,
      qualityFlags: ['none'],
    };
  }

  private validateAndRepair(action: NextInterviewerAction): string {
    const validIds = this.coverage.map((c) => c.id);
    const result = validateQuestion({
      spokenText: action.spokenText,
      action: action.action,
      targetCoverageItemIds: action.targetCoverageItemIds,
      validCoverageIds: validIds,
      recentQuestions: this.recentQuestionTexts.slice(-5),
      maxWords: this.r.maxQuestionWords,
      wordsPerSecond: this.calibrator.wordsPerSecond,
    });
    if (result.valid) return action.spokenText.trim();
    // Deterministic trim repair (spec §16.15 step 3).
    return deterministicRepair(action.spokenText, this.r.maxQuestionWords);
  }

  private applyAction(
    action: NextInterviewerAction,
    turnId: string,
  ): { coverage: SessionCoverageItem[]; deltas: CoverageDelta[] } {
    const validTurnIds = [...this.coverage.flatMap((c) => c.evidenceTurnIds), turnId];
    const { coverage, deltas } = applyCoverageUpdates(
      this.coverage,
      action.coverageUpdates.map((u) => ({
        coverageItemId: u.coverageItemId,
        status: u.status,
        evidenceTurnIds: u.evidenceTurnIds,
      })),
      { validTurnIds },
    );
    let result = coverage;
    for (const fc of action.followUpCounts) {
      if (fc.count > 0) result = incrementFollowUp(result, fc.coverageItemId);
    }
    return { coverage: result, deltas };
  }

  // -- helpers: build records ----------------------------------------------
  private openingQuestionRecord(): QuestionRecord {
    const q = this.ctx.brief.openingQuestion;
    return this.questionRecordFrom(q.text, askAction(q.text, q.type, q.targetCoverageItemIds), 'opening_cache');
  }

  private questionRecordFrom(text: string, action: NextInterviewerAction, source: QuestionRecord['source']): QuestionRecord {
    return {
      text: text.trim(),
      type: action.questionType,
      targetCoverageItemIds: action.targetCoverageItemIds,
      modelId: this.ctx.models.interviewer,
      promptVersion: this.ctx.character.systemPromptVersion,
      generatedAt: new Date(this.now()).toISOString(),
      ttsProvider: 'inworld',
      ttsVoiceId: this.ctx.voiceId,
      audioDurationMs: null,
      mediaPlan: null,
      generationLatencyMs: null,
      ttsLatencyMs: null,
      source,
    };
  }

  /**
   * Synthesize the question's audio. PURE with respect to orchestrator state —
   * it touches no shared fields (`currentTurn`, `_lastTts`, `recentClipIds`,
   * calibrator, provider health), so the commit pipeline can run it concurrently
   * with the answered-turn DB write (Overlap A, #52) without a chance of
   * corrupting state for the wrong turn. All of those writes live in
   * {@link mountPreparedTurn}, applied only after the stale-generation guard
   * passes. The optional `signal` lets a pause/skip/recovery abort the in-flight
   * request (see {@link bumpGeneration}). On timeout or abort the deadline
   * fallback throws `TTS_FAILED`.
   */
  private async synthesizeSpeech(record: QuestionRecord, signal?: AbortSignal): Promise<TtsResult> {
    const tts = await withDeadlineFallback(
      this.deps.tts.synthesize(
        {
          text: record.text,
          voiceId: this.ctx.voiceId,
          style: 'neutral',
          speakingRate: 1.0,
          outputFormat: 'wav',
          sampleRate: this.ctx.ttsSampleRate,
        },
        signal,
      ),
      this.r.ttsDeadlineMs,
      () => {
        throw new AppError('TTS_FAILED', { recoverable: true, retryAction: 'retry-tts' });
      },
    );
    return tts.value;
  }

  /**
   * Commit a freshly synthesized turn into orchestrator state: plan its media,
   * build `currentTurn`, cache the TTS buffer, and advance the ordinal. Must run
   * synchronously AFTER the stale-generation guard passes — every write here is
   * the irreversible "this is now the live turn" step that the guard protects.
   */
  private mountPreparedTurn(record: QuestionRecord, ttsResult: TtsResult): void {
    this.markProvider('inworldTts', 'ok');
    this.calibrator.update(wordCount(record.text), ttsResult.durationMs);
    const media = planSpeaking(ttsResult.durationMs, this.ctx.clips, this.recentClipIds, {
      seed: record.text,
    });
    for (const seg of media.segments) {
      this.recentClipIds = [seg.clipId, ...this.recentClipIds].slice(0, 5);
    }
    const id = this.currentTurn && this.currentTurn.question === record ? this.currentTurn.id : newId();
    this.currentTurn = {
      id,
      ordinal: this.nextOrdinal,
      question: { ...record, audioDurationMs: ttsResult.durationMs, mediaPlan: media, ttsLatencyMs: ttsResult.latencyMs },
      generationId: this.generationId,
      speechStartedAt: null,
      speechEndedAt: null,
      rawTranscript: '',
    };
    // A fresh, unanswered turn is now current. Reaching this line means TTS
    // succeeded, so the answered-turn resume path (#9) no longer applies.
    this.currentTurnAnswered = false;
    this.nextOrdinal = this.currentTurn.ordinal + 1;
    this._lastTts = ttsResult;
  }

  /**
   * Synthesize TTS and mount the turn, serially. Used by every realization path
   * except the commit pipeline (opening, skip, resume-advance, repeat), which
   * have no concurrent DB write to overlap. The commit pipeline instead calls
   * {@link synthesizeSpeech} and {@link mountPreparedTurn} directly so it can fan
   * the synthesis out against the answered-turn persist (Overlap A, #52).
   */
  private async buildAndCacheTurn(record: QuestionRecord, _source: QuestionRecord['source']): Promise<void> {
    const ttsResult = await this.synthesizeSpeech(record);
    this.mountPreparedTurn(record, ttsResult);
  }

  private _lastTts: Awaited<ReturnType<TextToSpeechAdapter['synthesize']>> | null = null;

  /**
   * Re-plan the speaking media for a repeated question so the same clip does not
   * replay verbatim (item #26). Reuses the cached TTS buffer (no re-synthesis) —
   * only the clip selection is redone, now penalized by the recency list updated
   * since the turn was first built, and seeded per-repeat so a second repeat
   * differs again. When only one clip is eligible, planSpeaking returns the same
   * clip — the intended "when possible" escape hatch.
   */
  private replanForRepeat(turn: CurrentTurn): void {
    const durationMs = this._lastTts?.durationMs ?? turn.question.audioDurationMs ?? 0;
    const media = planSpeaking(durationMs, this.ctx.clips, this.recentClipIds, {
      seed: `${turn.id}:repeat`,
    });
    turn.question = { ...turn.question, mediaPlan: media };
    // Mirror buildAndCacheTurn's recency tracking so the just-replayed clip is
    // deprioritized on a subsequent repeat too.
    for (const seg of media.segments) {
      this.recentClipIds = [seg.clipId, ...this.recentClipIds].slice(0, 5);
    }
  }

  private async buildPlaybackPlan(turn: CurrentTurn): Promise<SpeechPlaybackPlan> {
    // Re-synthesize is avoided: reuse the cached TTS buffer from buildAndCacheTurn.
    const tts = this._lastTts;
    if (!tts) throw new AppError('TTS_FAILED', { publicMessage: 'Speech audio was not prepared.' });
    // Copy into a fresh ArrayBuffer (not SharedArrayBuffer) for structured-clone IPC.
    const bytes = new ArrayBuffer(tts.bytes.byteLength);
    new Uint8Array(bytes).set(tts.bytes);
    return {
      sessionId: this.ctx.session.id,
      turnId: turn.id,
      text: turn.question.text,
      audio: {
        mimeType: tts.mimeType,
        bytes,
        durationMs: tts.durationMs,
        outputDeviceId: this.ctx.selectedOutputDeviceId,
      },
      media: turn.question.mediaPlan ?? planSpeaking(tts.durationMs, this.ctx.clips, this.recentClipIds, { seed: turn.id }),
      captionsEnabled: this.ctx.captionsEnabled,
    };
  }

  private buildAnswerRecord(args: {
    turn: CurrentTurn;
    rawTranscript: string;
    cleanup: TranscriptCleanupResult;
    moderation: ModerationRecord;
    endpointReason: EndpointReason;
    sttLatencyMs: number;
    cleanupLatencyMs: number | null;
    recovered: boolean;
  }): AnswerRecord {
    const { turn, rawTranscript, cleanup } = args;
    const durationMs =
      turn.speechStartedAt != null && turn.speechEndedAt != null
        ? Math.max(0, turn.speechEndedAt - turn.speechStartedAt)
        : null;
    return {
      rawTranscript,
      cleanedTranscript: cleanup.cleanedText || rawTranscript,
      userEditedTranscript: null,
      transcriptParagraphs: cleanup.paragraphs.length ? cleanup.paragraphs : splitParagraphs(rawTranscript),
      uncertainTerms: cleanup.uncertainTerms,
      endpointReason: args.endpointReason,
      speechStartedAt: turn.speechStartedAt != null ? new Date(turn.speechStartedAt).toISOString() : null,
      speechEndedAt: turn.speechEndedAt != null ? new Date(turn.speechEndedAt).toISOString() : null,
      durationMs,
      sttProvider: 'inworld',
      sttModelId: this.ctx.models.stt,
      cleanupModelId: args.cleanupLatencyMs == null ? null : this.ctx.models.cleanup,
      moderation: args.moderation,
      sttLatencyMs: Math.round(args.sttLatencyMs),
      cleanupLatencyMs: args.cleanupLatencyMs == null ? null : Math.round(args.cleanupLatencyMs),
      recoveredFromBufferedAudio: args.recovered,
    };
  }

  private composeTurn(
    turn: CurrentTurn,
    answer: AnswerRecord | null,
    state: InterviewTurn['state'],
    coverageDelta: CoverageDelta[] = [],
  ): InterviewTurn {
    return {
      id: turn.id,
      sessionId: this.ctx.session.id,
      ordinal: turn.ordinal,
      question: turn.question,
      answer,
      coverageDelta,
      state,
      createdAt: new Date(this.now()).toISOString(),
      completedAt: answer ? new Date(this.now()).toISOString() : null,
    };
  }

  private async handlePipelineFailure(err: unknown): Promise<void> {
    const appErr = err instanceof AppError ? err : new AppError('UNKNOWN', { cause: err });
    if (appErr.code === 'TTS_FAILED') this.markProvider('inworldTts', 'down');
    this.log.error('session.pipeline_failure', { code: appErr.code, message: appErr.message });
    // A dropped speech transport routes through RECOVERING (auto-reconnect)
    // rather than a plain pause, so the session self-heals instead of stranding
    // the operator with a manual retry prompt (#14). Every other failure keeps
    // the existing recoverable-pause behaviour.
    if (appErr.code === 'STT_DISCONNECTED') {
      this.enterRecovery('stt disconnected');
      return;
    }
    this.recoverableWarning = appErr.publicMessage;
    // Unrecoverable failures (auth, db, mic permission, export, …) have no
    // per-screen handler, so surface them on the global error banner. Recoverable
    // faults (rate limits, transient TTS) keep their snapshot warning only — they
    // self-heal and must not light up the banner.
    const publicError = appErr.toPublic();
    if (!publicError.recoverable) {
      this.deps.errorSink.publish(publicError);
    }
    this.transition('pause', 'pipeline failure');
    this.publishSnapshot();
  }

  /**
   * Speak a model-authored closing line as one final interviewer utterance,
   * *before* the session transitions to COMPLETED (item #26). Narrow and
   * self-contained: it reuses the same generation-guarded preload→play shape as
   * {@link playCurrentTurn} but deliberately does NOT transition to
   * stageReady/audioEnded, open the mic gate, or arm a user turn — a closing
   * sign-off must never hand the floor back to the creator. Best-effort: a
   * synthesis/stage failure or deadline logs via the caller and is swallowed so
   * completion still proceeds (the final answer is already committed).
   */
  private async playClosingLine(text: string): Promise<void> {
    // Sample the generation BEFORE the first cancelable await, mirroring
    // playCurrentTurn: a pause/endNow during the closing line bumps generationId,
    // and we must not run playback side effects for a session the operator moved
    // past (though the closing path has none beyond audio, so this is hygiene).
    const myGen = this.generationId;
    let ttsResult: TtsResult;
    try {
      ttsResult = await withTimeout(
        this.deps.tts.synthesize({
          text,
          voiceId: this.ctx.voiceId,
          style: 'neutral',
          speakingRate: 1.0,
          outputFormat: 'wav',
          sampleRate: this.ctx.ttsSampleRate,
        }),
        this.r.ttsDeadlineMs,
      );
    } catch {
      // Best-effort: a synthesis failure or deadline must never block completion.
      return;
    }
    // Copy into a fresh ArrayBuffer (not SharedArrayBuffer) for structured-clone IPC.
    const bytes = new ArrayBuffer(ttsResult.bytes.byteLength);
    new Uint8Array(bytes).set(ttsResult.bytes);
    const plan: SpeechPlaybackPlan = {
      sessionId: this.ctx.session.id,
      // A distinct turnId avoids colliding with the just-answered turn's playback
      // lifecycle in the stage's pending-ended map.
      turnId: 'closing',
      text,
      audio: {
        mimeType: ttsResult.mimeType,
        bytes,
        durationMs: ttsResult.durationMs,
        outputDeviceId: this.ctx.selectedOutputDeviceId,
      },
      media: planSpeaking(ttsResult.durationMs, this.ctx.clips, this.recentClipIds, { seed: 'closing' }),
      captionsEnabled: this.ctx.captionsEnabled,
    };
    const preloaded = await this.deps.stage.preloadSpeechPlan(plan);
    if (myGen !== this.generationId) {
      this.log.info('session.stale_closing_discarded', { phase: 'preload' });
      return;
    }
    if (!preloaded) return;
    // Publish a 'speaking' projection so the stage renderer actually starts the
    // decoded audio: the renderer only calls speechPlayer.start() when the
    // published visualState is 'speaking' (preload alone just loads/decodes, and
    // playSpeechPlan merely awaits the renderer's 'ended' report — it does not
    // itself start playback). We cannot transition to INTERVIEWER_SPEAKING for
    // the closing line because that state arms the mic on audioEnded; instead we
    // publish the speaking visual directly with the mic closed, and rely on the
    // completionSelected → FINISHING transition (in completeSession) to publish a
    // non-speaking visual that stops playback once the audio ends.
    this.publishClosingStage(text);
    await this.deps.stage.playSpeechPlan(plan);
    if (myGen !== this.generationId) {
      this.log.info('session.stale_closing_discarded', { phase: 'play' });
    }
  }

  /**
   * Publish a 'speaking' stage projection for the closing line so the renderer
   * starts playback (see playClosingLine). The mic stays closed — the closing
   * sign-off never hands the floor to the creator — and captions carry the
   * closing text. statusText reads "Interview complete" because the line plays as
   * the session wraps up; the next transition's publishStage restores the normal
   * FINISHING/COMPLETED status.
   */
  private publishClosingStage(text: string): void {
    const projection: StageStateProjection = {
      version: ++this.snapshotVersion,
      visualState: 'speaking',
      micState: 'closed',
      statusText: STATUS_TEXT.COMPLETED ?? 'Interview complete',
      captions: this.ctx.captionsEnabled ? text : null,
      mirror: this.ctx.session.settingsSnapshot.mirrorStage,
      zoom: this.ctx.session.settingsSnapshot.zoom,
      verticalOffsetPercent: this.ctx.session.settingsSnapshot.verticalOffsetPercent,
    };
    this.deps.stage.setVisualState(projection);
  }

  /**
   * Best-effort close of the STT transport on completion (item #26). The spec
   * §11.3 invariant declares COMPLETED.stt='closed', but teardown
   * (app-controller) only closes STT when the operator leaves the session — so
   * an idle review could leave the transport open for minutes. Idempotent at the
   * adapter (InworldSttClient.close is null-safe on re-entry), so teardown's
   * later close is harmless.
   */
  private async closeStt(): Promise<void> {
    try {
      await this.deps.stt.close();
    } catch (err) {
      this.log.warn('stt.close_failed_on_complete', { error: String(err) });
    }
  }

  /**
   * Centralize every completion path — coverage-complete commit, skip-complete,
   * and endNow — so they share one closing-line playback + STT-close posture
   * (items #26 #4 / #5). The model's closing line is spoken only when the action
   * is an explicit `complete` with non-empty text: an `ask` that merely requests
   * close-after-answer has a next-question-shaped line that must not be voiced as
   * a sign-off, and endNow has no model action at all. Closing playback is
   * best-effort — the answer is already committed, so a failure logs and
   * completion proceeds (never strand the session in a recoverable pause).
   */
  private async completeSession(
    action: NextInterviewerAction | undefined,
    reason = 'completed',
  ): Promise<void> {
    if (action?.action === 'complete' && action.spokenText.trim().length > 0) {
      try {
        await this.playClosingLine(action.spokenText);
      } catch (err) {
        this.log.warn('session.closing_line_failed', { error: String(err) });
      }
    }
    this.transition('completionSelected', reason);
    this.transition('finalAnswerStored', reason);
    // The COMPLETED invariant (spec §11.3: COMPLETED.stt='closed') must hold the
    // moment the live state reaches COMPLETED, so close the STT transport in a
    // finally — even if the status persist throws (surfaced upstream as a pipeline
    // failure), STT is not left streaming against a COMPLETED session.
    try {
      await this.persistSessionStatus('completed');
    } finally {
      await this.closeStt();
    }
  }

  private async persistSessionStatus(status: InterviewSession['status']): Promise<void> {
    const updated: InterviewSession = {
      ...this.ctx.session,
      status,
      rollingSummary: this.rollingSummary,
      currentTurnOrdinal: this.nextOrdinal - 1,
      endedAt: status === 'completed' ? new Date(this.now()).toISOString() : this.ctx.session.endedAt,
      updatedAt: new Date(this.now()).toISOString(),
    };
    await this.deps.repository.updateSession(updated);
  }

  /**
   * Hard safety cap on the number of questions posed (issue #17). A model that
   * keeps returning `ask` is forced to close once this many questions have been
   * posed, independent of the model's own termination decision. Counting posed
   * questions (not just answered ones) bounds total interview length even when
   * turns are skipped, and it is resume-safe: the ordinal is restored from
   * ctx.session.currentTurnOrdinal on reconstruction. Derived from the (immutable)
   * soft target, floored at 1 so a degenerate target never collapses the cap to
   * zero, and memoized per session.
   */
  private hardQuestionCap(): number {
    if (this.questionCountHardCap == null) {
      const target = Math.max(1, this.ctx.targetQuestionCount);
      this.questionCountHardCap = Math.ceil(target * this.r.questionCountHardCapFactor);
    }
    return this.questionCountHardCap;
  }

  /** True once enough questions have been posed to trip the safety cap. */
  private hardQuestionCapReached(posedQuestionCount: number): boolean {
    return posedQuestionCount >= this.hardQuestionCap();
  }

  // -- snapshots -----------------------------------------------------------
  private micWasOpenBeforePause(): boolean {
    return (
      this.pausedFromState === 'USER_ARMED' ||
      this.pausedFromState === 'USER_SPEAKING' ||
      this.pausedFromState === 'ENDPOINT_CANDIDATE'
    );
  }

  private lastAnswerText(): string {
    return this.lastCommittedAnswer;
  }

  // -- automatic endpoint evaluation loop (spec §14, MIC-05) ---------------
  private startEndpointEvaluation(): void {
    if (!autoCommitAllowed(this.ctx.session.endpointMode)) return;
    this.clearEndpointTimer();
    this.endpointTimer = setInterval(() => {
      void this.tickEndpoint();
    }, ENDPOINT_TICK_MS);
  }

  private async tickEndpoint(): Promise<void> {
    // Never let a slow classifier from one tick overlap the next tick's call.
    if (this.endpointEvalInFlight) return;
    const turn = this.currentTurn;
    if (this.state !== 'ENDPOINT_CANDIDATE' || turn?.speechEndedAt == null) {
      this.clearEndpointTimer();
      return;
    }
    const now = this.now();
    const silenceMs = Math.max(0, now - turn.speechEndedAt);
    const speechMs =
      turn.speechStartedAt != null ? Math.max(0, turn.speechEndedAt - turn.speechStartedAt) : 0;
    this.endpointEvalInFlight = true;
    try {
      await this.evaluateEndpoint({ transcript: turn.rawTranscript, silenceMs, speechMs });
    } finally {
      this.endpointEvalInFlight = false;
    }
  }

  private clearEndpointTimer(): void {
    if (this.endpointTimer != null) {
      clearInterval(this.endpointTimer);
      this.endpointTimer = null;
    }
  }

  private markProvider(
    provider: 'openai' | 'inworldStt' | 'inworldTts',
    status: 'ok' | 'degraded' | 'down',
  ): void {
    this.providerHealth = { ...this.providerHealth, [provider]: status };
  }

  private publishStage(): void {
    // Captions show Mira's current spoken question while she speaks (spec §7.12,
    // CORR-10); the user's own transcript is never shown on stage by default.
    const speaking = STAGE_VISUAL[this.state] === 'speaking';
    const captions =
      this.ctx.captionsEnabled && speaking ? (this.currentTurn?.question.text ?? null) : null;
    const projection: StageStateProjection = {
      version: ++this.snapshotVersion,
      visualState: STAGE_VISUAL[this.state],
      micState: MIC_STATE[this.state],
      statusText: STATUS_TEXT[this.state] ?? null,
      captions,
      mirror: this.ctx.session.settingsSnapshot.mirrorStage,
      zoom: this.ctx.session.settingsSnapshot.zoom,
      verticalOffsetPercent: this.ctx.session.settingsSnapshot.verticalOffsetPercent,
    };
    this.deps.stage.setVisualState(projection);
  }

  private publishSnapshot(): void {
    const coverage: PublicCoverageItem[] = this.coverage.map((c) => ({
      id: c.id,
      label: c.label,
      priority: c.priority,
      status: c.status,
    }));
    const snapshot: OperatorSessionSnapshot = {
      version: ++this.snapshotVersion,
      sessionId: this.ctx.session.id,
      projectTitle: this.ctx.brief.title,
      state: this.state,
      elapsedMs: Math.max(0, this.now() - this.startedAtMs),
      questionOrdinal: this.currentTurn?.ordinal ?? this.nextOrdinal - 1,
      currentQuestion: this.currentTurn?.question.text ?? null,
      partialTranscript: this.interimTranscript,
      finalTranscriptSoFar: this.currentTurn?.rawTranscript ?? '',
      coverage,
      mic: {
        gate: MIC_STATE[this.state],
        level: this.micLevel,
        clipping: this.micClipping,
      },
      providerStatus: { ...this.providerHealth },
      endpointPending: this.state === 'ENDPOINT_CANDIDATE',
      recoverableWarning: this.recoverableWarning,
      controls: this.controlAvailability(),
    };
    this.deps.snapshotSink.publish(snapshot);
  }

  private controlAvailability(): OperatorSessionSnapshot['controls'] {
    // Derive UI control availability from the single command-legality source of
    // truth so a button can never advertise an action the orchestrator (and the
    // main-process dispatch) would reject (review P0-08).
    const cmds = availableCommands(this.getCommandContext());
    return {
      canPause: cmds.PAUSE_SESSION,
      canResume: cmds.RESUME_SESSION,
      canCommit: cmds.COMMIT_USER_TURN,
      canRepeat: cmds.REPEAT_QUESTION,
      canSkip: cmds.SKIP_QUESTION,
      canRetake: cmds.RETAKE_TURN,
      canEnd: cmds.END_AFTER_TURN,
      canEndAfterTurn: cmds.END_AFTER_TURN,
      canEndNow: cmds.END_NOW,
      canRetry: cmds.RETRY_RECOVERY,
    };
  }

  /** For tests/diagnostics: feed partial transcript into the current turn. */
  setPartialTranscript(text: string): void {
    if (this.currentTurn) this.currentTurn.rawTranscript = text;
  }
}

// -- module-local helpers ---------------------------------------------------

function stateConflict(message: string): AppError {
  return new AppError('SESSION_STATE_CONFLICT', { message, publicMessage: message });
}

function askAction(text: string, type: QuestionRecord['type'], targets: string[]): NextInterviewerAction {
  return {
    action: 'ask',
    spokenText: text,
    questionType: type,
    targetCoverageItemIds: targets,
    coverageUpdates: [],
    followUpCounts: [],
    updatedSessionSummary: '',
    currentSectionId: null,
    shouldCloseAfterAnswer: false,
    qualityFlags: ['none'],
  };
}

function fallbackCleanup(raw: string): TranscriptCleanupResult {
  return {
    cleanedText: raw,
    paragraphs: splitParagraphs(raw),
    glossaryCorrections: [],
    uncertainTerms: [],
    materialChanges: [],
  };
}

function moderationUnavailable(): ModerationRecord {
  return {
    modelId: 'unavailable',
    flagged: false,
    categories: {},
    categoryScores: {},
    decision: 'error',
  };
}
