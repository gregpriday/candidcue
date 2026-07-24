/**
 * Candidate-bounded request construction (companion §37, §41, §42.3, §57.2).
 *
 * Rules enforced here:
 *
 * * never send the whole script — only the candidate/landmark windows the
 *   local engine already produced;
 * * cap candidate count (§37.1: normally 3–6) and every text field;
 * * send finalized transcript, plus a clearly marked provisional tail only
 *   when it is useful;
 * * keep the stable prefix (instruction, schema, section context) identical
 *   across requests so prompt caching can hit, and put every dynamic field
 *   after it (§41).
 */
import { candidateSetHash } from './hash';
import type { LandmarkSpan, PreparedLandmark } from './landmark-index';
import type {
  AssistSchedulingContext,
  ClassificationPayload,
  LocalCandidate,
  PreparationPayload,
  RetrievalPayload,
  SemanticClassificationRequest,
  SemanticPreparationRequest,
  SemanticRetrievalRequest,
} from './types';

/** Bounds. Starting values per §37.1/§42.3, tunable without schema changes. */
export const CONTEXT_LIMITS = {
  minCandidates: 2,
  maxCandidates: 6,
  maxCandidateChars: 320,
  maxFinalTranscriptChars: 480,
  maxProvisionalChars: 120,
  maxCriticalChecks: 4,
  maxCriticalFragmentChars: 80,
  maxLandmarkPropositionChars: 240,
  maxPreparationSpans: 128,
  maxPreparationSpanChars: 600,
} as const;

/** Keep the last `max` characters, snapped to a word boundary where possible. */
export function tailText(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(trimmed.length - max);
  const space = cut.indexOf(' ');
  return space > 0 && space < 40 ? cut.slice(space + 1) : cut;
}

function headText(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/**
 * Select the candidates worth sending. Ineligible section transitions are
 * removed *before* the request so Luna is never even offered a prohibited
 * location (§51 step 6, §3.6).
 */
export function selectCandidates(
  candidates: readonly LocalCandidate[],
  max = CONTEXT_LIMITS.maxCandidates,
): LocalCandidate[] {
  return [...candidates]
    .filter((c) => c.sectionTransitionAllowed && c.supportKinds.length > 0)
    .sort((a, b) => b.localLogScore - a.localLogScore)
    .slice(0, max);
}

/**
 * Stable per-section context (§41 step 4). Identical for every request inside
 * a section, so it extends the cacheable prefix.
 */
export function stableSectionContext(sectionId: string, sectionTitle: string): string {
  return `Current section: ${headText(sectionTitle, 120)} (id=${sectionId})`;
}

/** Operation-scoped cache key (§41). Distinct per script and operation. */
export function promptCacheKeyFor(
  scriptCompileHash: string,
  operation: 'classify' | 'retrieve' | 'prepare',
): string {
  return `candidcue:${scriptCompileHash}:${operation}`;
}

export interface ClassificationRequestBuild {
  request: SemanticClassificationRequest;
  candidates: LocalCandidate[];
}

/** Build a bounded candidate-classification request (companion C.2). */
export function buildClassificationRequest(
  context: AssistSchedulingContext,
  requestId: string,
  options: { includeProvisional?: boolean; timeoutMs?: number } = {},
): ClassificationRequestBuild | null {
  const candidates = selectCandidates(context.candidates);
  if (candidates.length < CONTEXT_LIMITS.minCandidates) return null;

  const hash = candidateSetHash(candidates);
  const payload: ClassificationPayload = {
    request_id: requestId,
    semantic_epoch: context.semanticEpoch,
    transcript_revision: context.transcriptRevision,
    candidate_set_hash: hash,
    tracking_state: context.trackingState,
    recent_behavior: context.behavior,
    current_section: { id: context.currentSectionId, title: headText(context.currentSectionTitle, 120) },
    recent_final_transcript: tailText(
      context.recentFinalTranscript,
      CONTEXT_LIMITS.maxFinalTranscriptChars,
    ),
    provisional_tail:
      options.includeProvisional === true
        ? tailText(context.provisionalTail, CONTEXT_LIMITS.maxProvisionalChars)
        : '',
    candidates: candidates.map((c) => ({
      id: c.id,
      relation_hint: c.relationHint,
      distance: c.distance,
      score_band: c.localScoreBand,
      text: headText(c.text, CONTEXT_LIMITS.maxCandidateChars),
    })),
    critical_checks: context.criticalChecks
      .slice(0, CONTEXT_LIMITS.maxCriticalChecks)
      .map((check) => ({
        kind: check.kind,
        script_fragment:
          check.scriptFragment === null
            ? null
            : headText(check.scriptFragment, CONTEXT_LIMITS.maxCriticalFragmentChars),
        transcript_fragment:
          check.transcriptFragment === null
            ? null
            : headText(check.transcriptFragment, CONTEXT_LIMITS.maxCriticalFragmentChars),
      })),
  };

  return {
    candidates,
    request: {
      requestId,
      semanticEpoch: context.semanticEpoch,
      transcriptRevision: context.transcriptRevision,
      candidateSetHash: hash,
      payload,
      stableContext: stableSectionContext(context.currentSectionId, context.currentSectionTitle),
      promptCacheKey: promptCacheKeyFor(context.scriptCompileHash, 'classify'),
      reasoningEffort: 'low',
      maxOutputTokens: 320,
      timeoutMs: options.timeoutMs,
    },
  };
}

export interface RetrievalRequestBuild {
  request: SemanticRetrievalRequest;
  landmarks: PreparedLandmark[];
}

/** Build a bounded landmark-retrieval request (companion §37.2). */
export function buildRetrievalRequest(
  context: AssistSchedulingContext,
  requestId: string,
  landmarks: readonly PreparedLandmark[],
  landmarkSetHashValue: string,
  progress: { direction: 'forward' | 'backward' | 'unknown'; fraction: number },
  options: { timeoutMs?: number } = {},
): RetrievalRequestBuild | null {
  if (landmarks.length === 0) return null;
  const payload: RetrievalPayload = {
    request_id: requestId,
    semantic_epoch: context.semanticEpoch,
    transcript_revision: context.transcriptRevision,
    landmark_set_hash: landmarkSetHashValue,
    current_section: { id: context.currentSectionId, title: headText(context.currentSectionTitle, 120) },
    recent_behavior: context.behavior,
    recent_final_transcript: tailText(
      context.recentFinalTranscript,
      CONTEXT_LIMITS.maxFinalTranscriptChars,
    ),
    progress_corridor: progress,
    landmarks: landmarks.map((l) => ({
      id: l.spanId,
      proposition: headText(l.annotation.proposition, CONTEXT_LIMITS.maxLandmarkPropositionChars),
      topics: l.annotation.topicLabels.slice(0, 6),
    })),
    critical_evidence: context.criticalChecks
      .filter((c) => c.kind !== 'none' && c.transcriptFragment !== null)
      .slice(0, CONTEXT_LIMITS.maxCriticalChecks)
      .map((c) => ({
        kind: c.kind,
        fragment: headText(c.transcriptFragment ?? '', CONTEXT_LIMITS.maxCriticalFragmentChars),
      })),
  };

  return {
    landmarks: [...landmarks],
    request: {
      requestId,
      semanticEpoch: context.semanticEpoch,
      transcriptRevision: context.transcriptRevision,
      landmarkSetHash: landmarkSetHashValue,
      payload,
      stableContext: stableSectionContext(context.currentSectionId, context.currentSectionTitle),
      promptCacheKey: promptCacheKeyFor(context.scriptCompileHash, 'retrieve'),
      reasoningEffort: 'low',
      maxOutputTokens: 256,
      timeoutMs: options.timeoutMs,
    },
  };
}

/**
 * Build a landmark-preparation request. This is the one operation allowed to
 * send whole section text, and it runs offline — never during Live (§57.2).
 */
export function buildPreparationRequest(
  requestId: string,
  scriptCompileHash: string,
  sectionId: string,
  sectionTitle: string,
  spans: readonly LandmarkSpan[],
): SemanticPreparationRequest | null {
  const bounded = spans.slice(0, CONTEXT_LIMITS.maxPreparationSpans);
  if (bounded.length === 0) return null;
  const payload: PreparationPayload = {
    request_id: requestId,
    script_compile_hash: scriptCompileHash,
    section_id: sectionId,
    section_title: headText(sectionTitle, 120),
    spans: bounded.map((s) => ({
      span_id: s.spanId,
      text: headText(s.text, CONTEXT_LIMITS.maxPreparationSpanChars),
    })),
  };
  return {
    requestId,
    scriptCompileHash,
    sectionId,
    payload,
    promptCacheKey: promptCacheKeyFor(scriptCompileHash, 'prepare'),
    reasoningEffort: 'low',
    maxOutputTokens: 4096,
    timeoutMs: 60_000,
  };
}

export type { LandmarkSpan };
