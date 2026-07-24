/**
 * Semantic assist scheduler (companion §35, §36, §42, §58, Appendix B.6).
 *
 * Pure scheduling, validation, and fusion. Every network call goes through the
 * injected {@link SemanticInvoker}, which wraps the Rust commands (§50.4), and
 * every time source is injected, so the whole scheduler is unit-testable in
 * node.
 *
 * Nothing in this module is awaited by the stage frame loop (§26.1). A late,
 * superseded, or failed response is discarded and local tracking continues.
 */
import type { SmoothFollowProfile } from '../contracts/smooth-follow';
import type { SemanticAssistEvidence as TrackingAssistEvidence } from '../tracking/semantic-assist';
import { buildClassificationRequest, buildRetrievalRequest } from './context';
import { fuseSemanticAssist, toTrackingAssistEvidence } from './fusion';
import { candidateSetHash } from './hash';
import type { SemanticLandmarkIndex } from './landmark-index';
import type {
  AssistLane,
  AssistSchedulingContext,
  CoachTipCandidate,
  IntelligenceMode,
  LocalCandidate,
  LunaUsage,
  SemanticAssistMessage,
  SemanticAssistResult,
  SemanticAvailability,
  SemanticCandidateWindow,
  SemanticClassificationRequest,
  SemanticDiagnostics,
  SemanticLandmarkRetrievalResult,
  SemanticOperationResponse,
  SemanticRetrievalRequest,
} from './types';
import { validateLandmarkRetrieval, validateSemanticAssist } from './validate';

/* ---------------------------------------------------------------------------
 * Injected transport
 * ------------------------------------------------------------------------- */

export interface SemanticInvoker {
  classify(request: SemanticClassificationRequest): Promise<SemanticOperationResponse<unknown>>;
  retrieve(request: SemanticRetrievalRequest): Promise<SemanticOperationResponse<unknown>>;
  /** Best-effort cancellation (§36.5). Failures are ignored. */
  cancel(requestId: string): void;
}

/* ---------------------------------------------------------------------------
 * Cadence — companion §36.3 and Appendix A.4
 * ------------------------------------------------------------------------- */

export interface CadenceConfig {
  /** Ordinary minimum interval between classification requests. */
  minIntervalMs: number;
  /** Shorter interval permitted for a burst on material ambiguity. */
  burstIntervalMs: number;
  /** Bursts allowed before a full `minIntervalMs` must elapse. */
  burstAllowance: number;
  /** The rarer landmark-recovery lane (§37.4 cadence budget). */
  recoveryMinIntervalMs: number;
  /** Global concurrent in-flight cap across all lanes (§36.1). */
  maxInFlight: number;
}

export const CADENCE_BY_MODE: Record<IntelligenceMode, CadenceConfig> = {
  // No live semantic requests at all (§35.1).
  local_only: {
    minIntervalMs: Number.POSITIVE_INFINITY,
    burstIntervalMs: Number.POSITIVE_INFINITY,
    burstAllowance: 0,
    recoveryMinIntervalMs: Number.POSITIVE_INFINITY,
    maxInFlight: 0,
  },
  // A.4: ambiguity-triggered, usually 2.5–5 s minimum interval.
  balanced: {
    minIntervalMs: 5_000,
    burstIntervalMs: 2_500,
    burstAllowance: 2,
    recoveryMinIntervalMs: 10_000,
    maxInFlight: 2,
  },
  // A.4: periodic stable-window analysis, usually 1.5–3 s minimum interval.
  enhanced: {
    minIntervalMs: 3_000,
    burstIntervalMs: 1_500,
    burstAllowance: 3,
    recoveryMinIntervalMs: 8_000,
    maxInFlight: 2,
  },
};

/* ---------------------------------------------------------------------------
 * Triggers — companion §35.2, §36.2
 * ------------------------------------------------------------------------- */

export interface AssistTrigger {
  material: boolean;
  /** Permits the shorter burst interval. */
  burst: boolean;
  reason:
    | 'none'
    | 'sustained_ambiguity'
    | 'close_candidates'
    | 'retake_lead_in'
    | 'return_after_adlib'
    | 'critical_token'
    | 'stable_window';
  /** A newer trigger of strictly higher urgency may supersede an active one. */
  urgency: number;
}

export interface TriggerThresholds {
  ambiguityLow: number;
  ambiguityHigh: number;
  sustainedAmbiguityMs: number;
  closeCandidateMargin: number;
  minFinalTokens: number;
  stableWindowTokens: number;
  lexicalFailureMs: number;
}

export const DEFAULT_TRIGGER_THRESHOLDS: TriggerThresholds = {
  ambiguityLow: 0.35,
  ambiguityHigh: 0.75,
  sustainedAmbiguityMs: 600,
  closeCandidateMargin: 0.35,
  minFinalTokens: 4,
  stableWindowTokens: 8,
  lexicalFailureMs: 2_500,
};

const NO_TRIGGER: AssistTrigger = { material: false, burst: false, reason: 'none', urgency: 0 };

/** §36.2: do not call for one or two ordinary words. */
export function hasMinimumUsefulInput(
  context: AssistSchedulingContext,
  thresholds: TriggerThresholds,
): boolean {
  if (!context.hasNewFinalMeaningfulSpeech) return false;
  if (context.atPhraseBoundary) return true;
  if (context.newFinalTokenCount >= thresholds.minFinalTokens) return true;
  if (context.sustainedAmbiguityMs >= thresholds.sustainedAmbiguityMs * 2) return true;
  return context.criticalChecks.some((c) => c.kind !== 'none' && c.kind !== 'uncertain');
}

export function classifyAssistTrigger(
  context: AssistSchedulingContext,
  mode: IntelligenceMode,
  thresholds: TriggerThresholds = DEFAULT_TRIGGER_THRESHOLDS,
): AssistTrigger {
  if (mode === 'local_only') return NO_TRIGGER;
  if (!hasMinimumUsefulInput(context, thresholds)) return NO_TRIGGER;

  const eligible = context.candidates.filter((c) => c.sectionTransitionAllowed);
  if (eligible.length === 0) return NO_TRIGGER;

  if (context.criticalChecks.some((c) => c.kind !== 'none' && c.kind !== 'uncertain')) {
    return { material: true, burst: true, reason: 'critical_token', urgency: 5 };
  }
  if (context.trackingState === 'retake_pending' || context.behavior === 'retake_candidate') {
    return { material: true, burst: true, reason: 'retake_lead_in', urgency: 4 };
  }
  if (context.trackingState === 'adlib_hold') {
    return { material: true, burst: true, reason: 'return_after_adlib', urgency: 3 };
  }
  if (eligible.length >= 2 && context.localTopMarginLogScore <= thresholds.closeCandidateMargin) {
    return { material: true, burst: true, reason: 'close_candidates', urgency: 3 };
  }
  if (
    context.localConfidence >= thresholds.ambiguityLow &&
    context.localConfidence <= thresholds.ambiguityHigh &&
    context.sustainedAmbiguityMs >= thresholds.sustainedAmbiguityMs
  ) {
    return { material: true, burst: false, reason: 'sustained_ambiguity', urgency: 2 };
  }
  // §35.3: Enhanced additionally analyzes stable finalized windows.
  if (
    mode === 'enhanced' &&
    context.atPhraseBoundary &&
    context.newFinalTokenCount >= thresholds.stableWindowTokens
  ) {
    return { material: true, burst: false, reason: 'stable_window', urgency: 1 };
  }
  return NO_TRIGGER;
}

/**
 * §37.4. Landmark recovery is a rare last resort with hard prohibitions.
 */
export function landmarkRecoveryAllowed(
  context: AssistSchedulingContext,
  index: SemanticLandmarkIndex | undefined,
  thresholds: TriggerThresholds = DEFAULT_TRIGGER_THRESHOLDS,
): boolean {
  if (index === undefined) return false;
  if (!index.hasSection(context.currentSectionId)) return false;
  if (context.commandPending || context.sessionPaused) return false;
  if (!context.hasNewFinalMeaningfulSpeech) return false;
  if (context.newFinalTokenCount < thresholds.minFinalTokens) return false;
  if (context.lexicalFailureMs < thresholds.lexicalFailureMs) return false;
  // An already-strong ordinary candidate means recovery adds nothing.
  const strong = context.candidates.some(
    (c) => c.sectionTransitionAllowed && c.localScoreBand === 'strong',
  );
  return !strong;
}

/* ---------------------------------------------------------------------------
 * Budget — companion §42
 * ------------------------------------------------------------------------- */

export interface SemanticBudget {
  maxRequestsPerSession: number;
  maxRequestsPerHour: number;
  maxTotalTokens: number;
}

export const DEFAULT_SEMANTIC_BUDGET: SemanticBudget = {
  maxRequestsPerSession: 400,
  maxRequestsPerHour: 600,
  maxTotalTokens: 1_500_000,
};

/* ---------------------------------------------------------------------------
 * Degraded operation — companion §58
 * ------------------------------------------------------------------------- */

const BACKOFF_STEPS_MS = [2_000, 8_000, 30_000, 120_000];

function availabilityForError(error: unknown): SemanticAvailability {
  const code = readErrorCode(error);
  switch (code) {
    case 'NETWORK_TIMEOUT':
      return 'degraded_timeout';
    case 'RATE_LIMITED':
      return 'degraded_rate_limited';
    case 'QUOTA_EXHAUSTED':
      return 'degraded_quota';
    default:
      return 'degraded_unavailable';
  }
}

function readErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return '';
}

/** A locally cancelled request is not a failure and must not trigger backoff. */
function isLocalCancellation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const details = (error as { details?: Record<string, unknown> }).details;
  return details?.semanticFailure === 'cancelled';
}

/* ---------------------------------------------------------------------------
 * Scheduler
 * ------------------------------------------------------------------------- */

export interface SchedulerDeps {
  invoker: SemanticInvoker;
  now: () => number;
  profile: SmoothFollowProfile;
  sessionId: string;
  sessionGeneration: number;
  mode?: IntelligenceMode;
  cadence?: Partial<CadenceConfig>;
  thresholds?: Partial<TriggerThresholds>;
  budget?: Partial<SemanticBudget>;
  landmarkIndex?: SemanticLandmarkIndex;
  /** Monotonic request-id factory; defaults to an internal counter. */
  nextRequestId?: (lane: AssistLane) => string;

  onAssist?: (message: SemanticAssistMessage) => void;
  /**
   * Bounded evidence in the tracking worker's inbound shape. Post it as
   * `{ type: 'semantic_assist', evidence }` — that single line is the whole
   * integration on the alignment side.
   */
  onTrackingAssist?: (evidence: TrackingAssistEvidence) => void;
  onCandidateWindows?: (
    windows: SemanticCandidateWindow[],
    result: SemanticLandmarkRetrievalResult,
  ) => void;
  onTipCandidate?: (candidate: CoachTipCandidate) => void;
  onAvailabilityChange?: (availability: SemanticAvailability) => void;
}

interface ActiveRequest {
  lane: AssistLane;
  requestId: string;
  semanticEpoch: number;
  transcriptRevision: number;
  scriptCompileHash: string;
  candidates: LocalCandidate[];
  landmarkIds: string[];
  urgency: number;
  startedAtMs: number;
  /**
   * H7: cancellation generation this request was issued under. `cancelAll`
   * (mode switch, epoch change, retake, session end) bumps it, so a response
   * that arrives after cancellation can be recognised even when the transport
   * ignored `invoker.cancel` — which the interface documents as best-effort.
   */
  cancelGeneration: number;
  /**
   * H7: the EXACT candidate-set hash the request was computed over. The old
   * staleness check took this as a parameter and used it only as a boolean
   * flag, so a candidate whose span, section or text moved under a stable id
   * passed as "still fresh" and its stale classification was applied.
   */
  candidateSetHash: string | null;
  /** H7: section the request was built for. */
  sectionId: string | null;
  /** H7: whether the request was computed over FINAL speech only. */
  finalEvidence: boolean;
  /** H7: transcript items the request's evidence actually covers. */
  sourceItemIds: string[];
  /** H7: set when this record is superseded within its lane. */
  cancelled: boolean;
}

export class SemanticAssistScheduler {
  private mode: IntelligenceMode;
  private cadence: CadenceConfig;
  private readonly thresholds: TriggerThresholds;
  private readonly budget: SemanticBudget;

  private readonly active = new Map<AssistLane, ActiveRequest>();
  private lastRequestAtMs: number | null = null;
  private lastRecoveryAtMs: number | null = null;
  private burstsUsed = 0;
  private requestCounter = 0;
  private latestContext: AssistSchedulingContext | null = null;
  private backoffUntilMs: number | null = null;
  private backoffStep = 0;
  private availability: SemanticAvailability;
  private readonly requestTimestampsMs: number[] = [];
  private settling: Array<Promise<void>> = [];
  /** H7: bumped by `cancelAll`; see `ActiveRequest.cancelGeneration`. */
  private cancelGeneration = 0;


  private readonly diagnostics: SemanticDiagnostics;

  constructor(private readonly deps: SchedulerDeps) {
    this.mode = deps.mode ?? 'balanced';
    this.cadence = { ...CADENCE_BY_MODE[this.mode], ...deps.cadence };
    this.thresholds = { ...DEFAULT_TRIGGER_THRESHOLDS, ...deps.thresholds };
    this.budget = { ...DEFAULT_SEMANTIC_BUDGET, ...deps.budget };
    this.availability = this.mode === 'local_only' ? 'disabled' : 'ready';
    this.diagnostics = {
      mode: this.mode,
      availability: this.availability,
      requestsByLane: {
        candidate_classification: 0,
        landmark_recovery: 0,
        coaching_validation: 0,
      },
      acceptedResults: 0,
      staleDiscarded: 0,
      rejectedInvalid: 0,
      failures: 0,
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
      },
      cacheHits: 0,
      latencySamplesMs: [],
      estimatedCostUsd: null,
      backoffUntilMs: null,
    };
  }

  getDiagnostics(): SemanticDiagnostics {
    return {
      ...this.diagnostics,
      mode: this.mode,
      availability: this.availability,
      backoffUntilMs: this.backoffUntilMs,
      usage: { ...this.diagnostics.usage },
      requestsByLane: { ...this.diagnostics.requestsByLane },
      latencySamplesMs: [...this.diagnostics.latencySamplesMs],
    };
  }

  getAvailability(): SemanticAvailability {
    return this.availability;
  }

  getMode(): IntelligenceMode {
    return this.mode;
  }

  /** §35: switching to local-only cancels everything in flight immediately. */
  setMode(mode: IntelligenceMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.cadence = { ...CADENCE_BY_MODE[mode], ...this.deps.cadence };
    this.diagnostics.mode = mode;
    if (mode === 'local_only') {
      this.cancelAll();
      this.setAvailability('disabled');
    } else if (this.availability === 'disabled') {
      this.setAvailability('ready');
    }
  }

  /** §36.5: epoch change, retake commit, or session end invalidates everything. */
  cancelAll(): void {
    // H7: `invoker.cancel` is documented as best-effort and its failures are
    // ignored, so cancellation cannot rely on the transport actually aborting.
    // Bumping the generation makes it enforceable at APPLY time: a response
    // that still arrives is recognised as belonging to a cancelled request and
    // is discarded rather than emitted into a mode/epoch it does not belong to.
    this.cancelGeneration += 1;
    for (const request of this.active.values()) {
      this.deps.invoker.cancel(request.requestId);
    }
    this.active.clear();
  }

  /** Await every in-flight response. Test helper; never used on the live path. */
  async settle(): Promise<void> {
    while (this.settling.length > 0) {
      const pending = this.settling;
      this.settling = [];
      await Promise.all(pending);
    }
  }

  /**
   * Appendix B.6 `considerSemanticAssist`. Call on every alignable transcript
   * update; it decides whether a request is worth making.
   */
  observe(context: AssistSchedulingContext): void {
    this.latestContext = context;
    if (this.mode === 'local_only') return;
    if (context.commandPending || context.sessionPaused) return;
    if (this.isBudgetExhausted()) {
      this.setAvailability('budget_exhausted');
      return;
    }
    const now = this.deps.now();
    if (this.backoffUntilMs !== null && now < this.backoffUntilMs) return;
    if (this.backoffUntilMs !== null && now >= this.backoffUntilMs) {
      this.backoffUntilMs = null;
      this.setAvailability('ready');
    }
    if (this.active.size >= this.cadence.maxInFlight) return;

    const trigger = classifyAssistTrigger(context, this.mode, this.thresholds);
    if (trigger.material) {
      this.maybeStartClassification(context, trigger, now);
      return;
    }
    // §36.1: recovery is the rarer lane and never delays classification.
    if (
      !this.active.has('candidate_classification') &&
      landmarkRecoveryAllowed(context, this.deps.landmarkIndex, this.thresholds)
    ) {
      this.maybeStartRecovery(context, now);
    }
  }

  // -------------------------------------------------------------------------
  // Lanes
  // -------------------------------------------------------------------------

  private maybeStartClassification(
    context: AssistSchedulingContext,
    trigger: AssistTrigger,
    now: number,
  ): void {
    const existing = this.active.get('candidate_classification');
    if (existing !== undefined) {
      // §36.1: coalesce. A strictly more urgent trigger supersedes.
      if (trigger.urgency <= existing.urgency) return;
      this.deps.invoker.cancel(existing.requestId);
      // H7: mark the superseded record itself as dead. Supersession is
      // triggered by urgency alone and needs no revision bump, so without this
      // a late response from `existing` looked perfectly fresh and was applied
      // on top of its own replacement. The flag lives on the record so there
      // is no bookkeeping to clean up and no read-after-delete ordering trap.
      existing.cancelled = true;
      this.active.delete('candidate_classification');
    }
    if (!this.cadenceAllows(trigger, now)) return;

    const requestId = this.mintRequestId('candidate_classification');
    const build = buildClassificationRequest(context, requestId, {
      includeProvisional: context.provisionalTail.length > 0 && trigger.reason !== 'critical_token',
    });
    if (build === null) return;

    this.noteRequestStart('candidate_classification', now, trigger.burst);
    const record: ActiveRequest = {
      lane: 'candidate_classification',
      requestId,
      semanticEpoch: context.semanticEpoch,
      transcriptRevision: context.transcriptRevision,
      scriptCompileHash: context.scriptCompileHash,
      candidates: build.candidates,
      landmarkIds: [],
      urgency: trigger.urgency,
      startedAtMs: now,
      cancelGeneration: this.cancelGeneration,
      // H7: snapshot the exact authority this request was computed over.
      candidateSetHash: build.request.candidateSetHash,
      sectionId: context.currentSectionId,
      finalEvidence: context.provisionalTail.length === 0,
      sourceItemIds: [...(context.sourceItemIds ?? [])],
      cancelled: false,
    };
    this.active.set('candidate_classification', record);

    this.track(
      this.deps.invoker
        .classify(build.request)
        .then((response) => this.acceptClassification(record, build.request, response))
        .catch((error: unknown) => this.handleFailure(record, error)),
    );
  }

  private maybeStartRecovery(context: AssistSchedulingContext, now: number): void {
    if (this.active.has('landmark_recovery')) return;
    if (
      this.lastRecoveryAtMs !== null &&
      now - this.lastRecoveryAtMs < this.cadence.recoveryMinIntervalMs
    ) {
      return;
    }
    const index = this.deps.landmarkIndex;
    if (index === undefined) return;

    // §37.2: paragraph landmarks first, sentence landmarks second.
    const cursor = context.candidates[0]?.startTokenIndex ?? 0;
    const set =
      index.retrievalSet({
        currentSectionId: context.currentSectionId,
        cursorTokenIndex: cursor,
        level: 'paragraph',
      }) ??
      index.retrievalSet({
        currentSectionId: context.currentSectionId,
        cursorTokenIndex: cursor,
        level: 'sentence',
      });
    if (set === null) return;

    const requestId = this.mintRequestId('landmark_recovery');
    const build = buildRetrievalRequest(context, requestId, set.landmarks, set.landmarkSetHash, {
      direction: 'forward',
      fraction: 0,
    });
    if (build === null) return;

    this.lastRecoveryAtMs = now;
    this.noteRequestStart('landmark_recovery', now, false);
    const record: ActiveRequest = {
      lane: 'landmark_recovery',
      requestId,
      semanticEpoch: context.semanticEpoch,
      transcriptRevision: context.transcriptRevision,
      scriptCompileHash: context.scriptCompileHash,
      candidates: [],
      landmarkIds: set.landmarks.map((l) => l.spanId),
      urgency: 1,
      startedAtMs: now,
      cancelGeneration: this.cancelGeneration,
      candidateSetHash: null, // recovery is not candidate-scoped
      sectionId: context.currentSectionId,
      finalEvidence: context.provisionalTail.length === 0,
      sourceItemIds: [...(context.sourceItemIds ?? [])],
      cancelled: false,
    };
    this.active.set('landmark_recovery', record);

    this.track(
      this.deps.invoker
        .retrieve(build.request)
        .then((response) => this.acceptRetrieval(record, build.request, response))
        .catch((error: unknown) => this.handleFailure(record, error)),
    );
  }

  // -------------------------------------------------------------------------
  // Responses
  // -------------------------------------------------------------------------

  private acceptClassification(
    record: ActiveRequest,
    request: SemanticClassificationRequest,
    response: SemanticOperationResponse<unknown>,
  ): void {
    this.settleLane(record);
    this.noteUsage(response);
    if (this.isStale(record)) {
      this.diagnostics.staleDiscarded += 1;
      return;
    }
    const validation = validateSemanticAssist(response.result, {
      requestId: request.requestId,
      semanticEpoch: request.semanticEpoch,
      transcriptRevision: request.transcriptRevision,
      candidateSetHash: request.candidateSetHash,
      candidates: record.candidates,
    });
    if (!validation.ok) {
      this.diagnostics.rejectedInvalid += 1;
      return;
    }
    this.diagnostics.acceptedResults += 1;
    this.clearBackoff();

    const result = validation.result;
    const context = this.latestContext;
    const finalEvidence = context !== null && context.provisionalTail.length === 0;

    const message = fuseSemanticAssist({
      result,
      candidates: record.candidates,
      influenceMax: this.deps.profile.alignment.semanticInfluenceMax,
      finalEvidence,
      sessionId: this.deps.sessionId,
      sessionGeneration: this.deps.sessionGeneration,
      scriptCompileHash: record.scriptCompileHash,
      nowMs: this.deps.now(),
    });
    if (message !== null) {
      this.deps.onAssist?.(message);
      this.deps.onTrackingAssist?.(
        toTrackingAssistEvidence({
          result,
          message,
          candidates: record.candidates,
          assistId: record.requestId,
          requestRevision: record.transcriptRevision,
          sourceItemIds: context?.sourceItemIds ?? [],
          receivedAtMs: this.deps.now(),
        }),
      );
    }

    this.emitTipCandidate(result, record, finalEvidence);
  }

  private acceptRetrieval(
    record: ActiveRequest,
    request: SemanticRetrievalRequest,
    response: SemanticOperationResponse<unknown>,
  ): void {
    this.settleLane(record);
    this.noteUsage(response);
    if (this.isStale(record)) {
      this.diagnostics.staleDiscarded += 1;
      return;
    }
    const validation = validateLandmarkRetrieval(response.result, {
      requestId: request.requestId,
      semanticEpoch: request.semanticEpoch,
      transcriptRevision: request.transcriptRevision,
      landmarkSetHash: request.landmarkSetHash,
      offeredLandmarkIds: record.landmarkIds,
    });
    if (!validation.ok) {
      this.diagnostics.rejectedInvalid += 1;
      return;
    }
    this.diagnostics.acceptedResults += 1;
    this.clearBackoff();

    const index = this.deps.landmarkIndex;
    const context = this.latestContext;
    if (index === undefined || context === null) return;
    // §37.3: a landmark result only opens exact candidate windows.
    const windows = index.resolveWindows(validation.result.candidateLandmarkIds, [
      context.currentSectionId,
    ]);
    if (windows.length > 0) this.deps.onCandidateWindows?.(windows, validation.result);
  }

  private emitTipCandidate(
    result: SemanticAssistResult,
    record: ActiveRequest,
    finalEvidence: boolean,
  ): void {
    if (result.coachTipCode === 'none') return;
    const candidate = record.candidates.find((c) => c.id === result.selectedCandidateId);
    this.deps.onTipCandidate?.({
      code: result.coachTipCode,
      category: 'fidelity',
      confidence: result.confidence,
      semanticEpoch: result.semanticEpoch,
      transcriptRevision: result.transcriptRevision,
      spanId: candidate?.id ?? null,
      finalEvidence,
      createdAtMs: this.deps.now(),
    });
  }

  // -------------------------------------------------------------------------
  // Staleness, cadence, budget, failure
  // -------------------------------------------------------------------------

  /**
   * H7: settle a lane only when the record that finished is STILL the record
   * the lane holds.
   *
   * `active` is keyed by lane and the key is reused across supersession, so an
   * unconditional `active.delete(lane)` from a late request A wiped the
   * bookkeeping of its own replacement B. That silently slackened the
   * in-flight gate (a third request could start while B was live) and made
   * `cancelAll` unable to cancel B at all, because B was no longer in the map.
   */
  private settleLane(record: ActiveRequest): void {
    if (this.active.get(record.lane) === record) this.active.delete(record.lane);
  }

  /**
   * §36.4: discard unless EVERY authority the request was computed over still
   * holds.
   *
   * H7 hardened this substantially. It previously compared only epoch, compile
   * hash and revision, plus an id-SUBSET test on candidates — and it took the
   * candidate-set hash as a parameter that it used purely as a boolean flag,
   * never comparing the value. So a candidate whose span, section or text had
   * moved under a stable id passed as fresh, added candidates were invisible,
   * cancellation was not consulted at all, and finality/source items were read
   * off the CURRENT context rather than the request's own.
   */
  private isStale(record: ActiveRequest): boolean {
    // Cancelled or superseded: never apply, regardless of how fresh it looks.
    if (record.cancelGeneration !== this.cancelGeneration) return true;
    if (record.cancelled) return true;
    // §35: local-only makes zero live use of the model. A response still in
    // flight when the user switched must not emit evidence.
    if (this.mode === 'local_only') return true;

    const context = this.latestContext;
    if (context === null) return true;
    if (context.semanticEpoch !== record.semanticEpoch) return true;
    if (context.scriptCompileHash !== record.scriptCompileHash) return true;
    if (context.transcriptRevision !== record.transcriptRevision) return true;
    if (record.sectionId !== null && context.currentSectionId !== record.sectionId) return true;

    // Finality must match: evidence computed over a provisional tail cannot be
    // presented as final, and vice versa.
    if (record.finalEvidence !== (context.provisionalTail.length === 0)) return true;

    // The tracking worker rejects assist evidence by source item set, so the
    // items the request actually covered must still be the ones in play.
    const currentItems = context.sourceItemIds ?? [];
    if (!sameStringSet(record.sourceItemIds, currentItems)) return true;

    if (record.candidateSetHash !== null) {
      // Re-derive the hash from the CURRENT state of exactly the candidates
      // this request was built over. An id-subset test (the old check) passes
      // whenever the ids survive, even if the span, section or text behind
      // them moved — which is precisely when applying the old classification
      // sends the follower somewhere wrong.
      const current: LocalCandidate[] = [];
      for (const candidate of record.candidates) {
        const live = context.candidates.find((c) => c.id === candidate.id);
        if (live === undefined) return true; // candidate no longer eligible
        current.push(live);
      }
      if (candidateSetHash(current) !== record.candidateSetHash) return true;
    }
    return false;
  }

  private cadenceAllows(trigger: AssistTrigger, now: number): boolean {
    if (this.lastRequestAtMs === null) return true;
    const elapsed = now - this.lastRequestAtMs;
    if (elapsed >= this.cadence.minIntervalMs) return true;
    if (!trigger.burst) return false;
    if (this.burstsUsed >= this.cadence.burstAllowance) return false;
    return elapsed >= this.cadence.burstIntervalMs;
  }

  private noteRequestStart(lane: AssistLane, now: number, burst: boolean): void {
    if (lane === 'candidate_classification') {
      if (this.lastRequestAtMs !== null && now - this.lastRequestAtMs >= this.cadence.minIntervalMs) {
        this.burstsUsed = 0;
      }
      if (burst) this.burstsUsed += 1;
      this.lastRequestAtMs = now;
    }
    this.diagnostics.requestsByLane[lane] += 1;
    this.requestTimestampsMs.push(now);
  }

  private isBudgetExhausted(): boolean {
    const total =
      this.diagnostics.requestsByLane.candidate_classification +
      this.diagnostics.requestsByLane.landmark_recovery +
      this.diagnostics.requestsByLane.coaching_validation;
    if (total >= this.budget.maxRequestsPerSession) return true;
    if (this.diagnostics.usage.totalTokens >= this.budget.maxTotalTokens) return true;
    const hourAgo = this.deps.now() - 3_600_000;
    const inHour = this.requestTimestampsMs.filter((t) => t >= hourAgo).length;
    return inHour >= this.budget.maxRequestsPerHour;
  }

  private noteUsage(response: SemanticOperationResponse<unknown>): void {
    const usage: LunaUsage | undefined = response.usage;
    if (usage !== undefined) {
      this.diagnostics.usage.inputTokens += usage.inputTokens ?? 0;
      this.diagnostics.usage.cachedInputTokens += usage.cachedInputTokens ?? 0;
      this.diagnostics.usage.outputTokens += usage.outputTokens ?? 0;
      this.diagnostics.usage.reasoningTokens += usage.reasoningTokens ?? 0;
      this.diagnostics.usage.totalTokens += usage.totalTokens ?? 0;
    }
    if (response.cache?.cacheHit === true) this.diagnostics.cacheHits += 1;
    if (typeof response.latencyMs === 'number') {
      this.diagnostics.latencySamplesMs.push(response.latencyMs);
      if (this.diagnostics.latencySamplesMs.length > 200) {
        this.diagnostics.latencySamplesMs.shift();
      }
    }
  }

  /** §58: silent, graceful degradation. Local tracking is never blocked. */
  private handleFailure(record: ActiveRequest, error: unknown): void {
    this.settleLane(record);
    if (isLocalCancellation(error)) return;
    this.diagnostics.failures += 1;
    const availability = availabilityForError(error);
    this.setAvailability(availability);
    const step = Math.min(this.backoffStep, BACKOFF_STEPS_MS.length - 1);
    const base = BACKOFF_STEPS_MS[step] ?? 2_000;
    // Quota failures back off hard for the rest of the cooldown (§42.4).
    const multiplier = availability === 'degraded_quota' ? 4 : 1;
    this.backoffUntilMs = this.deps.now() + base * multiplier;
    this.backoffStep = Math.min(this.backoffStep + 1, BACKOFF_STEPS_MS.length - 1);
  }

  private clearBackoff(): void {
    this.backoffStep = 0;
    this.backoffUntilMs = null;
    if (this.availability !== 'ready' && this.mode !== 'local_only') this.setAvailability('ready');
  }

  private setAvailability(availability: SemanticAvailability): void {
    if (this.availability === availability) return;
    this.availability = availability;
    this.diagnostics.availability = availability;
    this.deps.onAvailabilityChange?.(availability);
  }

  private mintRequestId(lane: AssistLane): string {
    if (this.deps.nextRequestId !== undefined) return this.deps.nextRequestId(lane);
    this.requestCounter += 1;
    const prefix = lane === 'landmark_recovery' ? 'recover' : 'assist';
    return `${prefix}_${this.requestCounter}`;
  }

  private track(promise: Promise<void>): void {
    this.settling.push(promise);
  }
}

/** H7: order-insensitive set equality for source item ids. */
function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  for (const value of b) {
    if (!set.has(value)) return false;
  }
  return true;
}
