import type {
  CandidCueRepository,
  InterviewModelAdapter,
  ModerationAdapter,
  SpeechToTextAdapter,
  TextToSpeechAdapter,
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
import { withDeadlineFallback, nowMs as defaultNow, splitParagraphs, wordCount } from '@shared/utils';

import {
  nextState,
  canTransition,
  availableCommands,
  isCommandLegal,
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
import { NOOP_LOGGER, type Logger, type StagePort, type SnapshotSink, type Clock } from './ports';

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
  private recentClipIds: string[] = [];
  private usedFallbackTexts: string[] = [];
  private recentQuestionTexts: string[] = [];
  private pausedFromState: SessionRuntimeState | null = null;
  // The working state to return to once a reconnect succeeds (RECOVERING →
  // PAUSED → resume). Captured when entering RECOVERING and folded back into
  // pausedFromState on `recovered` so resume() picks the right destination (#14).
  private recoveredFromState: SessionRuntimeState | null = null;
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
    if (this.state !== 'IDLE' && this.state !== 'PREPARING') {
      this.transition('prepareSession');
    }
    this.state = 'PREPARING';
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
    await this.runExclusive(() => this.commitPipeline(reason));
  }

  pause(): void {
    // `transition` records pausedFromState from the pre-transition state.
    if (!this.transition('pause')) return;
    this.generationId++; // invalidate any in-flight provider work
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
      // mic, then clear the recoverable warning on this success path.
      this.transition('resumeUserTurn');
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
      await this.playCurrentTurn('repeat');
    });
  }

  async skipQuestion(): Promise<void> {
    // Only valid from USER_ARMED before any speech exists for the current turn.
    this.assertCommandLegal('SKIP_QUESTION');
    this.generationId++;
    this.deps.stage.closeMicGate();
    // USER_ARMED → INTERVIEWER_THINKING so realizeNextQuestion's playback
    // transitions are legal (review P0-08: Skip previously fired an illegal
    // `stageReady` from USER_ARMED).
    this.transition('skipToNextQuestion', 'skip');
    await this.runExclusive(async () => {
      const action = await this.generateNextActionOrFallback(this.lastAnswerText());
      await this.realizeNextQuestion(action, 'model');
    });
  }

  endAfterTurn(): void {
    this.assertCommandLegal('END_AFTER_TURN');
    this.endAfterTurnRequested = true;
    this.publishSnapshot();
  }

  async endNow(): Promise<void> {
    this.assertCommandLegal('END_NOW');
    this.generationId++;
    this.clearEndpointTimer();
    this.deps.stage.closeMicGate();
    // Never mark the session completed in persistence unless the state machine
    // actually finished (review P0-08: endNow previously persisted 'completed'
    // even when the transitions were illegal, diverging DB from the live UI).
    if (!this.transition('completionSelected', 'ended now')) {
      throw stateConflict(`cannot end now from ${this.state}`);
    }
    this.transition('finalAnswerStored', 'ended now');
    await this.persistSessionStatus('completed');
  }

  /** Operator retry from the terminal ERROR state (ERROR → RECOVERING). */
  retryRecovery(): void {
    this.assertCommandLegal('RETRY_RECOVERY');
    if (!this.transition('operatorRetry', 'operator retry')) return;
    this.generationId++; // a fresh reconnect generation; invalidate any stale one
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
        this.generationId++;
        this.clearEndpointTimer();
        this.deps.stage.closeMicGate();
      }
      this.publishSnapshot();
      return;
    }
    this.markProvider('inworldStt', 'degraded');
    this.recoverableWarning = 'Reconnecting to the speech service…';
    this.transition('deviceOrProviderNeedsRecovery', reason);
    this.generationId++; // invalidate any in-flight provider work
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
    try {
      await withRetry(() => this.deps.stt.reconnect(), { shouldAbort: superseded });
    } catch (err) {
      if (superseded()) return;
      this.log.error('stt.reconnect_failed', { error: String(err) });
      this.markProvider('inworldStt', 'down');
      this.recoverableWarning = 'Could not reconnect to the speech service. Tap Retry to try again.';
      this.transition('recoveryFailed', 'reconnect exhausted');
      return;
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
    this.interimTranscript = text;
    this.publishSnapshot();
  }

  /** A finalized STT segment: append to the turn's accumulated transcript (MIC-04). */
  onSttFinalSegment(text: string): void {
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

  /** Release timers when the session ends (called from teardown). */
  dispose(): void {
    this.clearEndpointTimer();
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

    // Persist the turn as "asked" before playback so a crash after the answer
    // but before the next question can resume cleanly (spec §10.6).
    await this.persistAskedTurn(turn);

    const plan = await this.buildPlaybackPlan(turn);

    // Playback is only "confirmed" when the stage reports ready then ended. A
    // stage error or a deadline timeout returns false: Mira never actually
    // spoke, so we must NOT advance to audioEnded / open the mic / arm the turn.
    const preloaded = await this.deps.stage.preloadSpeechPlan(plan);
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
    }
  }

  // -- core: the commit pipeline (spec §12.2) ------------------------------
  private async commitPipeline(reason: 'manual' | 'automatic'): Promise<void> {
    const turn = this.currentTurn;
    if (!turn) return;
    this.commitInFlight = true;
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

      // 4. Apply coverage + summary, persist the answered turn atomically.
      const { coverage, deltas } = this.applyAction(action, turn.id);
      this.coverage = coverage;
      this.rollingSummary = action.updatedSessionSummary || this.rollingSummary;

      const answeredTurn = this.composeTurn(turn, answer, 'answered', deltas);
      await this.deps.repository.appendTurnAtomic({
        sessionId: this.ctx.session.id,
        turn: answeredTurn,
        coverage: this.coverage,
        rollingSummary: this.rollingSummary,
        currentTurnOrdinal: turn.ordinal,
      });
      // The answer is durably committed. If realizing the next question now
      // fails, resume() advances instead of replaying this answered turn (#9).
      this.currentTurnAnswered = true;
      this.recentQuestionTexts.push(turn.question.text);
      // Remember the committed answer so a subsequent skip feeds the model real
      // prior context instead of an empty string (CORR-08).
      this.lastCommittedAnswer = cleanedText;

      // 5. Decide: close, or build + play the next question.
      const shouldClose = action.action === 'complete' || action.shouldCloseAfterAnswer || this.endAfterTurnRequested;
      if (shouldClose) {
        this.commitInFlight = false;
        this.transition('completionSelected', 'coverage complete');
        this.transition('finalAnswerStored');
        await this.persistSessionStatus('completed');
        return;
      }

      await this.realizeNextQuestion(action, 'model');
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

  private async generateNextActionOrFallback(
    currentAnswer: string,
    moderation?: ModerationRecord,
  ): Promise<NextInterviewerAction> {
    const recentTurns = await this.deps.repository.getRecentTurns(this.ctx.session.id, RUNTIME_DEFAULTS.maxQuestionWords > 0 ? 6 : 6);
    const gen = await withDeadlineFallback(
      this.deps.model.generateNextAction({
        characterSystemPrompt: this.ctx.composedSystemPrompt,
        brief: this.ctx.brief,
        coverage: buildCoverageContext(this.coverage),
        rollingSummary: this.rollingSummary,
        recentTurns: buildRecentTurns(recentTurns, 6),
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

  /** Synthesize TTS, plan media, and set the current turn. */
  private async buildAndCacheTurn(record: QuestionRecord, _source: QuestionRecord['source']): Promise<void> {
    const tts = await withDeadlineFallback(
      this.deps.tts.synthesize({
        text: record.text,
        voiceId: this.ctx.voiceId,
        style: 'neutral',
        speakingRate: 1.0,
        outputFormat: 'wav',
        sampleRate: this.ctx.ttsSampleRate,
      }),
      this.r.ttsDeadlineMs,
      () => {
        throw new AppError('TTS_FAILED', { recoverable: true, retryAction: 'retry-tts' });
      },
    );
    const ttsResult = tts.value;
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

  private _lastTts: Awaited<ReturnType<TextToSpeechAdapter['synthesize']>> | null = null;

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
    this.transition('pause', 'pipeline failure');
    this.publishSnapshot();
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
        deviceLabel: null,
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
