/**
 * §20/§22/§23. The Luna Coach Observer: request assembly, scheduling, and the
 * local validation that stands between a schema-valid answer and the glass.
 *
 * Three properties this module exists to guarantee:
 *
 * - **A late answer is discarded, not applied.** Every request carries
 *   `validUntilAudioTimeMs` (§22) and every response is checked against the
 *   audio clock at *application* time, never against its own arrival time.
 * - **A model answer can only ever select from what the local layer already
 *   found.** §23.1 is implemented as a list of individually named rejections,
 *   so a test can prove the exact rule that fired.
 * - **Failure is silent, not degraded.** §23.2: refusal, timeout, malformed
 *   result, quota error, and network failure all produce no tip; local pace,
 *   microphone, and strict-filler coaching are untouched because they never
 *   pass through here.
 *
 * There is exactly one path to the API and it is budgeted: the transport is
 * injected, requests are rate-limited per §20.3, and an external budget gate
 * (the session's existing semantic budget) can veto every call.
 */
import type {
  CoachCandidate,
  CoachCandidateType,
  CoachRailMode,
  CoachTipCode,
  DeliveryStyle,
  LunaCoachDecision,
  LunaCoachReasonCode,
  LunaCoachRequest,
  LunaCoachTipCode,
  PaceState,
  VarietyState,
} from '../../contracts/coaching';
import { isEvidenceCurrent } from '../../contracts/coaching';
import type { Uuid } from '../../contracts/core';
import type { LunaUsage, SemanticAvailability } from '../../semantic/types';
import { COACH_TIP_CATALOG, permittedCodesFor } from './tip-catalog';
import { parseCoachDecision, type SchemaRejection } from './luna-schema';
import { isSuppressedByState, type CoachLiveState } from './tip-policy';

/* ---------------------------------------------------------------------------
 * §22 request assembly
 * ------------------------------------------------------------------------- */

/** §20.4: "Never send the entire session transcript on each request." */
export const COACH_REQUEST_BOUNDS = {
  /** §20.4: 1–3 authored sentences around the active span. */
  maxAuthoredSpans: 3,
  maxAuthoredSpanChars: 400,
  maxCriticalTokens: 8,
  maxEmphasisTokens: 8,
  /** §20.4: roughly 6–15 seconds of finalized speech. */
  maxFinalTextChars: 1_200,
  maxProvisionalTailChars: 240,
  maxCandidates: 6,
  maxFragmentChars: 160,
  /** §22: how long an answer stays useful, ms. */
  defaultValidityMs: 4_000,
} as const;

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/gu;

function bound(text: string, max: number): string {
  const cleaned = text.replace(CONTROL_CHARS, ' ').replace(/\s+/gu, ' ').trim();
  return cleaned.length <= max ? cleaned : cleaned.slice(0, max);
}

export interface CoachRequestInput {
  sessionId: Uuid;
  scriptId: Uuid;
  scriptRevision: number;
  trackingEpoch: number;
  takePassId: string;
  /** Audio clock at the moment the request is built (§5.4). */
  requestAudioTimeMs: number;
  language: string;
  state: CoachLiveState;
  profile: LunaCoachRequest['profile'];
  authoredSpans: LunaCoachRequest['authoredSpans'];
  speech: LunaCoachRequest['speech'];
  metrics: LunaCoachRequest['metrics'];
  candidates: readonly CoachCandidate[];
  /** Overrides {@link COACH_REQUEST_BOUNDS.defaultValidityMs}. */
  validityMs?: number;
}

/**
 * §22. Build the bounded snapshot. Every collection and every string is
 * truncated here rather than "usually being small"; an unbounded field is a
 * cost and latency defect waiting for an unusual take.
 *
 * `validUntilAudioTimeMs` is set from the audio clock, so an answer that
 * arrives after the window it describes has passed is rejected by
 * {@link validateCoachDecision} instead of being applied late.
 */
export function buildCoachRequest(input: CoachRequestInput): LunaCoachRequest {
  const validity = input.validityMs ?? COACH_REQUEST_BOUNDS.defaultValidityMs;
  return {
    schemaVersion: '1.0',
    sessionId: input.sessionId,
    scriptId: input.scriptId,
    scriptRevision: input.scriptRevision,
    trackingEpoch: input.trackingEpoch,
    takePassId: input.takePassId,
    requestAudioTimeMs: input.requestAudioTimeMs,
    validUntilAudioTimeMs: input.requestAudioTimeMs + validity,
    language: input.language,
    state: { ...input.state },
    profile: { ...input.profile },
    authoredSpans: input.authoredSpans
      .slice(0, COACH_REQUEST_BOUNDS.maxAuthoredSpans)
      .map((span) => ({
        spanId: span.spanId,
        text: bound(span.text, COACH_REQUEST_BOUNDS.maxAuthoredSpanChars),
        criticalTokens: span.criticalTokens
          .slice(0, COACH_REQUEST_BOUNDS.maxCriticalTokens)
          .map((token) => bound(token, 64)),
        emphasisTokens: span.emphasisTokens
          .slice(0, COACH_REQUEST_BOUNDS.maxEmphasisTokens)
          .map((token) => bound(token, 64)),
        punctuationClass: span.punctuationClass,
        coachingDisabled: span.coachingDisabled,
      })),
    speech: {
      // Keep the *tail*: the most recent speech is what the decision is about.
      finalText: tailBound(input.speech.finalText, COACH_REQUEST_BOUNDS.maxFinalTextChars),
      provisionalTail: tailBound(
        input.speech.provisionalTail,
        COACH_REQUEST_BOUNDS.maxProvisionalTailChars,
      ),
      finalAudioStartMs: input.speech.finalAudioStartMs,
      finalAudioEndMs: input.speech.finalAudioEndMs,
    },
    metrics: { ...input.metrics },
    candidates: input.candidates.slice(0, COACH_REQUEST_BOUNDS.maxCandidates).map((candidate) => ({
      evidenceId: candidate.evidenceId,
      type: candidate.type,
      localConfidence: candidate.localConfidence,
      audioStartMs: candidate.stamp.audioStartMs,
      audioEndMs: candidate.stamp.audioEndMs,
      scriptSpanId: candidate.scriptSpanId,
      detailCode: bound(candidate.detailCode, 64),
      spokenFragment: bound(candidate.spokenFragment, COACH_REQUEST_BOUNDS.maxFragmentChars),
      authoredFragment: bound(candidate.authoredFragment, COACH_REQUEST_BOUNDS.maxFragmentChars),
    })),
  };
}

function tailBound(text: string, max: number): string {
  const cleaned = text.replace(CONTROL_CHARS, ' ').replace(/\s+/gu, ' ').trim();
  return cleaned.length <= max ? cleaned : cleaned.slice(cleaned.length - max);
}

/* ---------------------------------------------------------------------------
 * §20.2 when to call Luna
 * ------------------------------------------------------------------------- */

/** Candidate types that genuinely need semantic judgement (§20.2). */
const NEEDS_SEMANTIC_JUDGEMENT: ReadonlySet<CoachCandidateType> = new Set<CoachCandidateType>([
  'contextual_filler',
  'material_meaning_change',
  'critical_number_mismatch',
  'critical_name_mismatch',
  'critical_unit_mismatch',
  'critical_negation_mismatch',
  'repetitive_opener',
  'repeated_stumble',
]);

/**
 * §20.2. Never call to compute WPM or to notice that pitch moved — those are
 * local facts and paying a model to restate them is the failure mode §2.2
 * exists to prevent.
 */
export function shouldConsultLuna(candidates: readonly CoachCandidate[]): boolean {
  if (candidates.length === 0) return false;
  if (candidates.length > 1) return true; // §20.2: multiple candidates compete
  return candidates.some((candidate) => NEEDS_SEMANTIC_JUDGEMENT.has(candidate.type));
}

/* ---------------------------------------------------------------------------
 * §23.1 local validation
 * ------------------------------------------------------------------------- */

export type DecisionRejection =
  | SchemaRejection
  | 'stale_epoch'
  | 'stale_take_pass'
  | 'past_valid_until'
  | 'valid_for_expired'
  | 'decision_tip_code_disagreement'
  | 'evidence_ids_required'
  | 'unknown_evidence_id'
  | 'locally_invalidated_evidence'
  | 'stale_evidence'
  | 'code_not_permitted_by_candidates'
  | 'confidence_below_code_floor'
  | 'suppressed_by_state'
  /** §23.2. Distinct from a malformed body: the model declined, correctly. */
  | 'model_refusal';

/** The app-shaped result of a validated decision. camelCase begins here. */
export interface CoachDecisionSelection {
  code: CoachTipCode;
  confidence: number;
  evidenceIds: string[];
  scope: LunaCoachDecision['scope'];
  reasonCode: LunaCoachReasonCode;
  validForMs: number;
}

export type DecisionValidation =
  | { ok: true; selection: CoachDecisionSelection | null; decision: LunaCoachDecision }
  | { ok: false; reason: DecisionRejection };

export interface CoachDecisionExpectation {
  /** The request this answer replies to. */
  request: LunaCoachRequest;
  /** Audio clock at the moment the answer would be applied (§5.4). */
  audioTimeMs: number;
  currentTrackingEpoch: number;
  currentTakePassId: string;
  /** Current state — not the state captured in the request. */
  state: CoachLiveState;
  mode: CoachRailMode;
  deliveryStyle: DeliveryStyle;
  /** The candidates the request was built over, with their evidence stamps. */
  candidates: readonly CoachCandidate[];
  /**
   * §23.1 final bullet: events a local deterministic rule has already
   * invalidated — a filler demoted to `rejected`, a discrepancy the presenter
   * self-corrected, a detection revised away by a later transcript.
   */
  invalidatedEvidenceIds?: ReadonlySet<string>;
  minimumAlignmentConfidence?: number;
}

const DEFAULT_MIN_ALIGNMENT_CONFIDENCE = 0.4;

/**
 * §23.1. Schema-valid is not acceptable. Each rejection below corresponds to
 * one bullet of §23.1 (plus §20.5's `valid_until` rule) and is reachable by
 * varying only its own input from an otherwise-accepted response.
 *
 * A `decision: 'none'` answer validates successfully with a `null` selection:
 * §2.6 makes silence a correct outcome, not an error to be logged as one.
 */
export function validateCoachDecision(
  raw: unknown,
  expectation: CoachDecisionExpectation,
): DecisionValidation {
  const parsed = parseCoachDecision(raw);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const decision = parsed.decision;
  const request = expectation.request;

  // §20.5 / §23.1: an old epoch or take pass describes a different performance.
  if (request.trackingEpoch !== expectation.currentTrackingEpoch) {
    return { ok: false, reason: 'stale_epoch' };
  }
  if (request.takePassId !== expectation.currentTakePassId) {
    return { ok: false, reason: 'stale_take_pass' };
  }

  // §20.5: arrived after the request's own validity window.
  if (expectation.audioTimeMs > request.validUntilAudioTimeMs) {
    return { ok: false, reason: 'past_valid_until' };
  }
  // §23.1: the model's own validity claim has expired.
  if (expectation.audioTimeMs > request.requestAudioTimeMs + decision.valid_for_ms) {
    return { ok: false, reason: 'valid_for_expired' };
  }

  // §23.1: decision and tip_code must agree, in both directions.
  const saysNone = decision.decision === 'none';
  const codeIsNone = decision.tip_code === 'NONE';
  if (saysNone !== codeIsNone) {
    return { ok: false, reason: 'decision_tip_code_disagreement' };
  }
  if (saysNone) {
    // §2.6: a well-formed silence.
    return { ok: true, selection: null, decision };
  }

  if (decision.evidence_ids.length === 0) {
    return { ok: false, reason: 'evidence_ids_required' };
  }

  const byId = new Map<string, CoachCandidate>();
  for (const candidate of expectation.candidates) byId.set(candidate.evidenceId, candidate);

  for (const id of decision.evidence_ids) {
    const candidate = byId.get(id);
    // §23.1: unknown evidence id. The model may not invent an event (§20.1).
    if (candidate === undefined) return { ok: false, reason: 'unknown_evidence_id' };
    if (expectation.invalidatedEvidenceIds?.has(id) === true) {
      return { ok: false, reason: 'locally_invalidated_evidence' };
    }
    // §23.1: stale evidence — the stamp no longer describes this performance.
    if (
      !isEvidenceCurrent(
        candidate.stamp,
        expectation.currentTrackingEpoch,
        expectation.currentTakePassId,
      )
    ) {
      return { ok: false, reason: 'stale_evidence' };
    }
  }

  // §23.1: the code must be one the local candidate types admit.
  const cited = decision.evidence_ids
    .map((id) => byId.get(id))
    .filter((candidate): candidate is CoachCandidate => candidate !== undefined);
  const permitted = permittedCodesFor(cited.map((candidate) => candidate.type));
  const code = decision.tip_code as Exclude<LunaCoachTipCode, 'NONE'> as CoachTipCode;
  const definition = COACH_TIP_CATALOG[code];
  if (!permitted.has(code) || !definition.lunaSelectable) {
    return { ok: false, reason: 'code_not_permitted_by_candidates' };
  }

  // §23.1: per-code confidence floor.
  if (decision.confidence < definition.lunaConfidenceFloor) {
    return { ok: false, reason: 'confidence_below_code_floor' };
  }

  // §23.1: current state suppresses the code.
  if (
    isSuppressedByState(
      code,
      { state: expectation.state },
      expectation.minimumAlignmentConfidence ?? DEFAULT_MIN_ALIGNMENT_CONFIDENCE,
    )
  ) {
    return { ok: false, reason: 'suppressed_by_state' };
  }

  return {
    ok: true,
    // Conversion to app casing happens exactly once, here, after validation.
    // Nothing but enums and numbers crosses: there is no field on this object
    // that could carry a sentence.
    selection: {
      code,
      confidence: decision.confidence,
      evidenceIds: [...decision.evidence_ids],
      scope: decision.scope,
      reasonCode: decision.reason_code,
      validForMs: decision.valid_for_ms,
    },
    decision,
  };
}

/* ---------------------------------------------------------------------------
 * §20.3 scheduling and the single budgeted transport
 * ------------------------------------------------------------------------- */

export interface CoachObserverResponse {
  /** The raw wire object. Never trusted; always re-parsed locally. */
  result: unknown;
  /** §23.2: a model refusal produces no tip. */
  refusal?: string | null;
  usage?: LunaUsage;
  latencyMs?: number;
}

export interface CoachObserverTransport {
  classify(request: LunaCoachRequest): Promise<CoachObserverResponse>;
  /** Best-effort; correctness never depends on it (see the scheduler's H7). */
  cancel(requestId: string): void;
}

export interface CoachObserverCadence {
  /** §20.3: coalesce candidates for 600–1,200 ms. */
  coalesceMs: number;
  /** §20.3: no more than one request every three seconds. */
  minIntervalMs: number;
  /** §20.3: 12/min standard, 20/min enhanced. */
  maxRequestsPerMinute: number;
  maxInFlight: number;
  /** §20.3 enhanced: compact periodic observation, or `null` in standard. */
  periodicIntervalMs: number | null;
}

export const COACH_CADENCE_BY_MODE: Record<'standard' | 'enhanced', CoachObserverCadence> = {
  standard: {
    coalesceMs: 800,
    minIntervalMs: 3_000,
    maxRequestsPerMinute: 12,
    maxInFlight: 1,
    periodicIntervalMs: null,
  },
  enhanced: {
    coalesceMs: 600,
    minIntervalMs: 3_000,
    maxRequestsPerMinute: 20,
    maxInFlight: 1,
    periodicIntervalMs: 3_000,
  },
};

/** §37 counters, in the shape `CoachDiagnostics` expects. */
export interface CoachObserverDiagnostics {
  requests: number;
  responses: number;
  rejected: number;
  failures: number;
  refusals: number;
  latencySamplesMs: number[];
  usage: LunaUsage;
  availability: SemanticAvailability;
}

export interface CoachObserverDeps {
  transport: CoachObserverTransport;
  lunaMode?: 'standard' | 'enhanced';
  cadence?: Partial<CoachObserverCadence>;
  /**
   * The session's existing semantic budget. Returning `true` vetoes every
   * call — this is the hook that keeps the coach observer inside one budget
   * rather than opening a second, unmetered path to the API.
   */
  isBudgetExhausted?: () => boolean;
  /** Hard per-take request ceiling, independent of the shared budget. */
  maxRequestsPerTake?: number;
  onSelection?: (selection: CoachDecisionSelection, request: LunaCoachRequest) => void;
  onRejection?: (reason: DecisionRejection, request: LunaCoachRequest) => void;
}

interface PendingObservation {
  input: CoachRequestInput;
  queuedAtAudioMs: number;
}

const BACKOFF_STEPS_MS = [2_000, 8_000, 30_000, 120_000];

/**
 * §20.3. Event-triggered, coalesced, rate-limited, cancellable.
 *
 * The clock is passed in on every call rather than read: the observer runs on
 * the audio clock like everything else in the subsystem, and a test's virtual
 * clock is therefore the same mechanism, not a substitute for one.
 */
export class LunaCoachObserver {
  private readonly cadence: CoachObserverCadence;
  private pending: PendingObservation | null = null;
  private inFlight = 0;
  private lastRequestAtMs: number | null = null;
  private lastPeriodicAtMs: number | null = null;
  private readonly requestTimestampsMs: number[] = [];
  private backoffUntilMs: number | null = null;
  private backoffStep = 0;
  private generation = 0;
  private settling: Array<Promise<void>> = [];

  private readonly diagnostics: CoachObserverDiagnostics = {
    requests: 0,
    responses: 0,
    rejected: 0,
    failures: 0,
    refusals: 0,
    latencySamplesMs: [],
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    },
    availability: 'ready',
  };

  constructor(private readonly deps: CoachObserverDeps) {
    this.cadence = {
      ...COACH_CADENCE_BY_MODE[deps.lunaMode ?? 'standard'],
      ...deps.cadence,
    };
  }

  getDiagnostics(): CoachObserverDiagnostics {
    return {
      ...this.diagnostics,
      latencySamplesMs: [...this.diagnostics.latencySamplesMs],
      usage: { ...this.diagnostics.usage },
    };
  }

  /** §20.3: queue an observation. Later observations replace earlier ones. */
  observe(input: CoachRequestInput): void {
    this.pending = { input, queuedAtAudioMs: input.requestAudioTimeMs };
  }

  /**
   * §20.5 / §26.5. Epoch change, retake, command, take end: everything queued
   * is dropped and everything in flight is disowned. Bumping the generation
   * makes cancellation enforceable at *apply* time, because the transport's
   * `cancel` is best-effort and may do nothing at all.
   */
  cancelAll(): void {
    this.generation += 1;
    this.pending = null;
  }

  /**
   * Drive the observer from the audio clock. Returns `true` when a request was
   * actually issued, so a caller can assert cadence behaviour directly.
   */
  tick(nowAudioMs: number): boolean {
    if (this.backoffUntilMs !== null) {
      if (nowAudioMs < this.backoffUntilMs) return false;
      this.backoffUntilMs = null;
      this.setAvailability('ready');
    }
    const pending = this.pending;
    if (pending === null) return false;
    // §20.3: coalesce.
    if (nowAudioMs - pending.queuedAtAudioMs < this.cadence.coalesceMs) return false;
    if (this.inFlight >= this.cadence.maxInFlight) return false;
    if (
      this.lastRequestAtMs !== null &&
      nowAudioMs - this.lastRequestAtMs < this.cadence.minIntervalMs
    ) {
      return false;
    }
    const windowStart = nowAudioMs - 60_000;
    const inWindow = this.requestTimestampsMs.filter((t) => t > windowStart).length;
    if (inWindow >= this.cadence.maxRequestsPerMinute) return false;
    if (this.deps.isBudgetExhausted?.() === true) {
      this.setAvailability('budget_exhausted');
      return false;
    }
    if (
      this.deps.maxRequestsPerTake !== undefined &&
      this.diagnostics.requests >= this.deps.maxRequestsPerTake
    ) {
      this.setAvailability('budget_exhausted');
      return false;
    }

    this.pending = null;
    this.lastRequestAtMs = nowAudioMs;
    this.lastPeriodicAtMs = nowAudioMs;
    this.requestTimestampsMs.push(nowAudioMs);
    this.issue(pending.input, nowAudioMs);
    return true;
  }

  /** §20.3 enhanced mode: is a periodic observation due? */
  periodicDue(nowAudioMs: number): boolean {
    const interval = this.cadence.periodicIntervalMs;
    if (interval === null) return false;
    if (this.lastPeriodicAtMs === null) return true;
    return nowAudioMs - this.lastPeriodicAtMs >= interval;
  }

  /** Await in-flight work. Test helper; never awaited on the live path. */
  async settle(): Promise<void> {
    while (this.settling.length > 0) {
      const batch = this.settling;
      this.settling = [];
      await Promise.all(batch);
    }
  }

  /**
   * Apply a response. Exposed so a caller that owns its own transport can feed
   * results in directly; `issue` uses the same path, so there is one and only
   * one place a decision can become a selection.
   */
  applyResponse(
    response: CoachObserverResponse,
    expectation: CoachDecisionExpectation,
  ): DecisionValidation {
    this.diagnostics.responses += 1;
    this.noteUsage(response);

    // §23.2: a refusal is not an error and not a tip. Nothing else changes.
    if (typeof response.refusal === 'string' && response.refusal.length > 0) {
      this.diagnostics.refusals += 1;
      this.diagnostics.rejected += 1;
      // The refusal string itself is never read, logged to the rail, or
      // returned — only the fact that one occurred.
      this.deps.onRejection?.('model_refusal', expectation.request);
      return { ok: false, reason: 'model_refusal' };
    }

    const validation = validateCoachDecision(response.result, expectation);
    if (!validation.ok) {
      this.diagnostics.rejected += 1;
      this.deps.onRejection?.(validation.reason, expectation.request);
      return validation;
    }
    this.clearBackoff();
    if (validation.selection !== null) {
      this.deps.onSelection?.(validation.selection, expectation.request);
    }
    return validation;
  }

  private issue(input: CoachRequestInput, nowAudioMs: number): void {
    const request = buildCoachRequest(input);
    const generation = this.generation;
    this.diagnostics.requests += 1;
    this.inFlight += 1;

    const promise = this.deps.transport
      .classify(request)
      .then((response) => {
        this.inFlight -= 1;
        // Cancelled while in flight: the answer describes a performance that
        // no longer exists, so it is discarded without being validated.
        if (generation !== this.generation) return;
        this.applyResponse(response, {
          request,
          audioTimeMs: nowAudioMs,
          currentTrackingEpoch: input.trackingEpoch,
          currentTakePassId: input.takePassId,
          state: input.state,
          mode: input.profile.coachingMode,
          deliveryStyle: input.profile.deliveryStyle,
          candidates: input.candidates,
        });
      })
      .catch((error: unknown) => {
        this.inFlight -= 1;
        // §23.2: timeout, malformed result, quota error, network failure.
        this.handleFailure(error, nowAudioMs);
      });
    this.settling.push(promise);
  }

  /**
   * §23.2. No tip, a bounded backoff, and nothing else: the local pace,
   * microphone and strict-filler paths never touch this module, so "carry on
   * normally" is a structural property rather than a promise.
   */
  private handleFailure(error: unknown, nowAudioMs: number): void {
    this.diagnostics.failures += 1;
    this.setAvailability(availabilityForError(error));
    const step = Math.min(this.backoffStep, BACKOFF_STEPS_MS.length - 1);
    const base = BACKOFF_STEPS_MS[step] ?? 2_000;
    const multiplier = this.diagnostics.availability === 'degraded_quota' ? 4 : 1;
    this.backoffUntilMs = nowAudioMs + base * multiplier;
    this.backoffStep = Math.min(this.backoffStep + 1, BACKOFF_STEPS_MS.length - 1);
  }

  private clearBackoff(): void {
    this.backoffStep = 0;
    this.backoffUntilMs = null;
    this.setAvailability('ready');
  }

  private setAvailability(availability: SemanticAvailability): void {
    this.diagnostics.availability = availability;
  }

  private noteUsage(response: CoachObserverResponse): void {
    const usage = response.usage;
    if (usage !== undefined) {
      this.diagnostics.usage.inputTokens += usage.inputTokens ?? 0;
      this.diagnostics.usage.cachedInputTokens += usage.cachedInputTokens ?? 0;
      this.diagnostics.usage.outputTokens += usage.outputTokens ?? 0;
      this.diagnostics.usage.reasoningTokens += usage.reasoningTokens ?? 0;
      this.diagnostics.usage.totalTokens += usage.totalTokens ?? 0;
    }
    if (typeof response.latencyMs === 'number') {
      this.diagnostics.latencySamplesMs.push(response.latencyMs);
      if (this.diagnostics.latencySamplesMs.length > 200) {
        this.diagnostics.latencySamplesMs.shift();
      }
    }
  }
}

function availabilityForError(error: unknown): SemanticAvailability {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code: unknown }).code
      : '';
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

export type { PaceState, VarietyState };
