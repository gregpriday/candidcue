/**
 * Luna semantic sidecar types (companion spec Part VII/VIII).
 *
 * This module owns the seam between the semantic sidecar and everything else:
 *
 *   aligner candidates ──▶ scheduler ──invoke──▶ Rust ──▶ validator ──▶ fusion
 *   fusion ──SemanticAssistMessage──▶ tracking worker (bounded advisory only)
 *   coach engine ──CoachTip──▶ control tip list / stage coach strip
 *
 * Nothing here performs I/O. The scheduler receives an injected `invoke` and
 * clock so the whole sidecar is unit-testable in node (companion §50.4:
 * network calls live only in Rust).
 */
import type { IntelligenceMode } from '../contracts/smooth-follow';

export type { IntelligenceMode };

/* ---------------------------------------------------------------------------
 * Result types — companion §39, Appendix C.3
 * ------------------------------------------------------------------------- */

export type AssistRelation =
  | 'near_exact'
  | 'paraphrase'
  | 'adlib'
  | 'return_to_script'
  | 'restart'
  | 'self_correction'
  | 'forward_skip'
  | 'unresolved';

export type CriticalMismatch =
  | 'none'
  | 'negation'
  | 'number'
  | 'name'
  /**
   * A different unit of the *same dimension* was spoken — milliseconds read as
   * seconds, kilometres as miles. Distinct from `number` because the digits are
   * usually correct and only the unit changed, and because the coaching rail
   * has its own `CRITICAL_UNIT` copy for it. Folding it into `number` would
   * label a real milliseconds-for-seconds error as a number error, which is a
   * small lie that survives into the presenter's tip.
   *
   * Note this enum spans both directions of the Luna exchange: it types the
   * locally-computed `CriticalCheck.kind` we send *and* the `criticalMismatch`
   * the model returns, so a value added here must also be added to
   * `CRITICAL_MISMATCHES` in `validate.ts` and to the strict response schema in
   * `src-tauri/src/openai/semantic.rs`, or the two ends disagree.
   */
  | 'unit'
  | 'meaning_change'
  | 'omitted_clause'
  | 'uncertain';

export type CoachTipCode =
  | 'none'
  | 'critical_word_changed'
  | 'number_changed'
  | 'name_changed'
  | 'meaningful_omission'
  | 'restart_detected';

/** Companion §39. Every property is required under the strict schema. */
export interface SemanticAssistResult {
  schemaVersion: 1;
  requestId: string;
  semanticEpoch: number;
  transcriptRevision: number;
  candidateSetHash: string;
  relation: AssistRelation;
  selectedCandidateId: string | null;
  selectedCandidateConfidence: number;
  transcriptCoverage: number;
  candidateCoverage: number;
  shouldInfluenceTracking: boolean;
  criticalMismatch: CriticalMismatch;
  coachTipCode: CoachTipCode;
  confidence: number;
}

export type RetrievalRelation =
  | 'likely_current_passage'
  | 'likely_forward_within_section'
  | 'likely_retake'
  | 'adlib'
  | 'unresolved';

/** Companion §39.2. Opens candidate windows only — never a position. */
export interface SemanticLandmarkRetrievalResult {
  schemaVersion: 1;
  requestId: string;
  semanticEpoch: number;
  transcriptRevision: number;
  landmarkSetHash: string;
  relation: RetrievalRelation;
  candidateLandmarkIds: string[];
  confidence: number;
}

export type CriticalTermKind = 'name' | 'number' | 'negation' | 'date' | 'currency' | 'meaning';
export type LandmarkExactness = 'flexible' | 'balanced' | 'exact';

export interface LandmarkAnnotation {
  spanId: string;
  proposition: string;
  topicLabels: string[];
  criticalTerms: Array<{ kind: CriticalTermKind; canonical: string }>;
  conversationalAliases: string[];
  exactness: LandmarkExactness;
}

/** Companion §39.3. Token/unit ranges are joined locally, never accepted. */
export interface SemanticLandmarkPreparationResult {
  schemaVersion: 1;
  requestId: string;
  scriptCompileHash: string;
  sectionId: string;
  annotations: LandmarkAnnotation[];
}

/** Usage + prompt-cache metadata surfaced by Rust (companion §41, §71). */
export interface LunaUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface PromptCacheMetadata {
  cachedInputTokens: number;
  cacheHit: boolean;
  cacheHitRatio: number;
  promptCacheKey: string | null;
}

export interface SemanticOperationResponse<T> {
  result: T;
  usage: LunaUsage;
  cache: PromptCacheMetadata;
  latencyMs: number;
  model: string;
}

/* ---------------------------------------------------------------------------
 * Local aligner inputs — companion §37.1
 * ------------------------------------------------------------------------- */

/** Companion §40.2. Why the local engine nominated a candidate at all. */
export type LocalSupportKind =
  | 'lexical_anchor'
  | 'phonetic_anchor'
  | 'ordered_context'
  | 'checkpoint'
  | 'retake_opening'
  | 'sequential_boundary';

export type CandidateRelationHint = 'continuity' | 'forward' | 'hold' | 'boundary' | 'retake';

export type CandidateDistance =
  | 'current'
  | 'near_forward'
  | 'far_forward'
  | 'previous_sentence'
  | 'previous_paragraph'
  | 'next_section';

/**
 * One eligible candidate span supplied by the local aligner. `text` is exact
 * script text; Luna may only rank these, never invent a location (§34).
 */
export interface LocalCandidate {
  id: string;
  relationHint: CandidateRelationHint;
  distance: CandidateDistance;
  /** Bounded exact script text (§37.1). */
  text: string;
  sectionId: string;
  startTokenIndex: number;
  endTokenIndex: number;
  /** Local log score; used only for the fusion margin, never sent verbatim. */
  localLogScore: number;
  localScoreBand: 'weak' | 'moderate' | 'strong';
  /** §40.2: at least one local support kind is mandatory for influence. */
  supportKinds: LocalSupportKind[];
  /**
   * Section-graph verdict computed locally *before* Luna sees the candidate
   * (§51 step 6). A candidate with `false` can never gain influence.
   */
  sectionTransitionAllowed: boolean;
}

/** Companion §37.1 "critical-token mismatch candidates". */
export interface CriticalCheck {
  kind: CriticalMismatch;
  scriptFragment: string | null;
  transcriptFragment: string | null;
  /** Local span the check refers to; used for tip dedupe (§46). */
  spanId: string | null;
}

/** Everything the scheduler needs to decide and to build a bounded payload. */
export interface AssistSchedulingContext {
  sessionId: string;
  sessionGeneration: number;
  scriptCompileHash: string;
  semanticEpoch: number;
  transcriptRevision: number;
  sessionTimeMs: number;

  trackingState: string;
  behavior: string;

  currentSectionId: string;
  currentSectionTitle: string;

  /** Finalized transcript tail only (§37.1, §57.2). */
  recentFinalTranscript: string;
  /** Optional provisional tail, clearly marked and never tip-eligible. */
  provisionalTail: string;
  hasNewFinalMeaningfulSpeech: boolean;
  /** Meaningful finalized tokens since the last request (§36.2). */
  newFinalTokenCount: number;
  atPhraseBoundary: boolean;

  commandPending: boolean;
  sessionPaused: boolean;
  reanchorActive: boolean;

  /** Local confidence in [0,1]; the middle band is the ambiguity trigger. */
  localConfidence: number;
  /** ms the engine has spent in the ambiguity band (§35.2). */
  sustainedAmbiguityMs: number;
  /** Margin between the best and second-best local candidates (log units). */
  localTopMarginLogScore: number;
  /** ms since local lexical matching last succeeded (§37.2 recovery gate). */
  lexicalFailureMs: number;

  candidates: LocalCandidate[];
  criticalChecks: CriticalCheck[];
  /**
   * Transcript item IDs the classification is computed over. Forwarded to the
   * tracking worker so it can reject evidence whose source items were
   * superseded or masked as command speech (companion §25.7).
   */
  sourceItemIds?: string[];
}

/* ---------------------------------------------------------------------------
 * Requests sent to Rust (camelCase; `{ request: … }` invoke argument)
 * ------------------------------------------------------------------------- */

export interface SemanticRequestOptions {
  timeoutMs?: number;
  reasoningEffort?: 'none' | 'minimal' | 'low';
  maxOutputTokens?: number;
  promptCacheKey?: string;
  stableContext?: string;
}

export interface SemanticClassificationRequest extends SemanticRequestOptions {
  requestId: string;
  semanticEpoch: number;
  transcriptRevision: number;
  candidateSetHash: string;
  payload: ClassificationPayload;
}

export interface SemanticRetrievalRequest extends SemanticRequestOptions {
  requestId: string;
  semanticEpoch: number;
  transcriptRevision: number;
  landmarkSetHash: string;
  payload: RetrievalPayload;
}

export interface SemanticPreparationRequest extends SemanticRequestOptions {
  requestId: string;
  scriptCompileHash: string;
  sectionId: string;
  payload: PreparationPayload;
}

/** Companion C.2 dynamic payload. Candidate-bounded — never the full script. */
export interface ClassificationPayload {
  request_id: string;
  semantic_epoch: number;
  transcript_revision: number;
  candidate_set_hash: string;
  tracking_state: string;
  recent_behavior: string;
  current_section: { id: string; title: string };
  recent_final_transcript: string;
  provisional_tail: string;
  candidates: Array<{
    id: string;
    relation_hint: CandidateRelationHint;
    distance: CandidateDistance;
    score_band: 'weak' | 'moderate' | 'strong';
    text: string;
  }>;
  critical_checks: Array<{
    kind: CriticalMismatch;
    script_fragment: string | null;
    transcript_fragment: string | null;
  }>;
}

/** Companion §37.2 retrieval payload. Current-section landmarks only. */
export interface RetrievalPayload {
  request_id: string;
  semantic_epoch: number;
  transcript_revision: number;
  landmark_set_hash: string;
  current_section: { id: string; title: string };
  recent_behavior: string;
  recent_final_transcript: string;
  progress_corridor: { direction: 'forward' | 'backward' | 'unknown'; fraction: number };
  landmarks: Array<{ id: string; proposition: string; topics: string[] }>;
  critical_evidence: Array<{ kind: CriticalMismatch; fragment: string }>;
}

export interface PreparationPayload {
  request_id: string;
  script_compile_hash: string;
  section_id: string;
  section_title: string;
  spans: Array<{ span_id: string; text: string }>;
}

/* ---------------------------------------------------------------------------
 * Outputs
 * ------------------------------------------------------------------------- */

/** Bounded advisory contribution for one candidate (companion §40). */
export interface SemanticAssistEvidence {
  candidateId: string;
  /**
   * Additive adjustment to the candidate's local log score, already clamped
   * to ±`influenceMax`. The consumer must clamp again — this value is
   * advisory and may never be the sole authority for a jump (§40.1, §3.6).
   */
  adjustment: number;
  relation: AssistRelation;
  confidence: number;
  /** The cap this adjustment was produced under (profile.alignment). */
  influenceMax: number;
}

/**
 * Inbound tracking-worker message carrying bounded semantic evidence.
 *
 * INTEGRATION (one line): the tracking worker adds
 *   `| { type: 'semantic_assist'; assist: SemanticAssistMessage }`
 * to `TrackingWorkerInbound` (src/shared/tracking/worker-protocol.ts) and, in
 * the beam scorer, adds `evidence.adjustment` — re-clamped to
 * ±`profile.alignment.semanticInfluenceMax` — to the matching hypothesis's log
 * score, only for hypotheses the local engine already produced.
 */
export interface SemanticAssistMessage {
  sessionId: string;
  sessionGeneration: number;
  scriptCompileHash: string;
  semanticEpoch: number;
  transcriptRevision: number;
  candidateSetHash: string;
  evidence: SemanticAssistEvidence[];
  /** Advisory branch hint; never a navigation instruction (§40.3). */
  behaviorHint: 'none' | 'hold' | 'advance' | 'retake' | 'forward_skip';
  issuedAtMs: number;
  /** Companion §40.4: evidence must not outlive the analyzed span. */
  expiresAtMs: number;
}

/** Landmark windows opened by a validated retrieval result (§37.3 step 3). */
export interface SemanticCandidateWindow {
  landmarkId: string;
  sectionId: string;
  startTokenIndex: number;
  endTokenIndex: number;
}

export type CoachTipCategory = 'delivery' | 'fidelity' | 'status';

/** Local, non-model tip codes (companion §43.1). */
export type DeliveryTipCode =
  | 'microphone_clipping'
  | 'microphone_no_signal'
  | 'pace_too_fast'
  | 'pace_too_slow';

export type StatusTipCode = 'slowing_to_keep_place' | 'finding_your_place' | 'moved_back';

export type AnyTipCode = Exclude<CoachTipCode, 'none'> | DeliveryTipCode | StatusTipCode;

/**
 * A published coach tip.
 *
 * INTEGRATION (one line): the stage renders `tip.text` in its bottom coach
 * strip for `tip.displayMs`, accepting only tips whose `disposition` is
 * `'stage_eligible'`; the control window renders every published tip.
 */
export interface CoachTip {
  id: string;
  code: AnyTipCode;
  category: CoachTipCategory;
  /** 1 (most urgent) … 6 (least), companion §46. */
  priority: number;
  /** Fixed authored copy — never model-generated (§39.1, §89). */
  text: string;
  confidence: number;
  semanticEpoch: number;
  transcriptRevision: number;
  spanId: string | null;
  publishedAtMs: number;
  expiresAtMs: number;
  displayMs: number;
  disposition: 'stage_eligible' | 'control_only';
}

/** Companion §46: what the arbitrator receives before gating. */
export interface CoachTipCandidate {
  code: AnyTipCode;
  category: CoachTipCategory;
  confidence: number;
  semanticEpoch: number;
  transcriptRevision: number;
  spanId: string | null;
  /** §46/A.5: provisional-only evidence can never produce a tip. */
  finalEvidence: boolean;
  /** Safely escaped script token supplied by the local engine (§39.1). */
  token?: string;
  createdAtMs: number;
}

/* ---------------------------------------------------------------------------
 * Availability / diagnostics — companion §58, §71
 * ------------------------------------------------------------------------- */

export type SemanticAvailability =
  | 'disabled'
  | 'ready'
  | 'degraded_timeout'
  | 'degraded_rate_limited'
  | 'degraded_quota'
  | 'degraded_unavailable'
  | 'budget_exhausted';

export interface SemanticDiagnostics {
  mode: IntelligenceMode;
  availability: SemanticAvailability;
  requestsByLane: Record<AssistLane, number>;
  acceptedResults: number;
  staleDiscarded: number;
  rejectedInvalid: number;
  failures: number;
  usage: LunaUsage;
  cacheHits: number;
  latencySamplesMs: number[];
  /** Present only when the capability registry carries verified prices. */
  estimatedCostUsd: number | null;
  backoffUntilMs: number | null;
}

export type AssistLane = 'candidate_classification' | 'landmark_recovery' | 'coaching_validation';
