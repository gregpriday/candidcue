/**
 * Strict-schema and domain validation for every Luna result
 * (companion §39, Appendix C.3, Appendix C.4).
 *
 * Rust already rejects out-of-schema JSON and identity mismatches. This module
 * repeats the structural checks — a validator that trusts an upstream parse is
 * not a validator — and adds the domain checks only the frontend can make:
 * candidate existence, relation/direction compatibility, section-graph
 * eligibility, and tip-code compatibility.
 *
 * Invalid combinations are DISCARDED. Nothing here ever repairs a result or
 * issues a second model call (C.4).
 */
import type {
  AssistRelation,
  CoachTipCode,
  CriticalMismatch,
  LandmarkExactness,
  LocalCandidate,
  RetrievalRelation,
  SemanticAssistResult,
  SemanticLandmarkPreparationResult,
  SemanticLandmarkRetrievalResult,
} from './types';

export type Validation<T> = { ok: true; result: T } | { ok: false; reason: string };

const ASSIST_RELATIONS: readonly AssistRelation[] = [
  'near_exact',
  'paraphrase',
  'adlib',
  'return_to_script',
  'restart',
  'self_correction',
  'forward_skip',
  'unresolved',
];

const CRITICAL_MISMATCHES: readonly CriticalMismatch[] = [
  'none',
  'negation',
  'number',
  'name',
  'unit',
  'meaning_change',
  'omitted_clause',
  'uncertain',
];

const TIP_CODES: readonly CoachTipCode[] = [
  'none',
  'critical_word_changed',
  'number_changed',
  'name_changed',
  'meaningful_omission',
  'restart_detected',
];

const RETRIEVAL_RELATIONS: readonly RetrievalRelation[] = [
  'likely_current_passage',
  'likely_forward_within_section',
  'likely_retake',
  'adlib',
  'unresolved',
];

const EXACTNESS: readonly LandmarkExactness[] = ['flexible', 'balanced', 'exact'];

const CRITICAL_TERM_KINDS = ['name', 'number', 'negation', 'date', 'currency', 'meaning'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnit(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= max;
}

function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Fields the identity checks in §36.4 / C.4 compare against. */
export interface ClassificationExpectation {
  requestId: string;
  semanticEpoch: number;
  transcriptRevision: number;
  candidateSetHash: string;
  candidates: readonly LocalCandidate[];
}

/**
 * Relation ⇄ candidate-direction compatibility (C.4). A retake candidate may
 * only be chosen for restart/self-correction speech; a forward candidate only
 * for a paraphrase or within-section skip (C.1).
 */
const RELATION_ALLOWED_HINTS: Record<AssistRelation, readonly string[]> = {
  near_exact: ['continuity', 'forward', 'boundary'],
  paraphrase: ['continuity', 'forward', 'boundary'],
  return_to_script: ['continuity', 'forward', 'boundary', 'retake'],
  forward_skip: ['forward', 'boundary'],
  restart: ['retake'],
  self_correction: ['retake'],
  adlib: [],
  unresolved: [],
};

/** Tip code ⇄ criticalMismatch compatibility (C.4). */
const TIP_REQUIRES_MISMATCH: Record<Exclude<CoachTipCode, 'none'>, readonly CriticalMismatch[]> = {
  // A unit swap is reported through the number tip until the rail's own
  // CRITICAL_UNIT copy is wired; the mismatch kind stays honest either way.
  number_changed: ['number', 'unit'],
  name_changed: ['name'],
  critical_word_changed: ['negation', 'meaning_change'],
  meaningful_omission: ['omitted_clause'],
  restart_detected: ['none', 'uncertain', 'meaning_change'],
};

/** Structural pass: everything the strict JSON schema promised (C.3.1). */
export function parseAssistShape(raw: unknown): Validation<SemanticAssistResult> {
  if (!isRecord(raw)) return { ok: false, reason: 'not_an_object' };

  const allowed = new Set([
    'schemaVersion',
    'requestId',
    'semanticEpoch',
    'transcriptRevision',
    'candidateSetHash',
    'relation',
    'selectedCandidateId',
    'selectedCandidateConfidence',
    'transcriptCoverage',
    'candidateCoverage',
    'shouldInfluenceTracking',
    'criticalMismatch',
    'coachTipCode',
    'confidence',
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) return { ok: false, reason: `additional_property:${key}` };
  }
  if (raw.schemaVersion !== 1) return { ok: false, reason: 'schema_version' };
  if (!isBoundedString(raw.requestId, 128)) return { ok: false, reason: 'request_id_out_of_schema' };
  if (!isIndex(raw.semanticEpoch)) return { ok: false, reason: 'semantic_epoch_out_of_schema' };
  if (!isIndex(raw.transcriptRevision)) {
    return { ok: false, reason: 'transcript_revision_out_of_schema' };
  }
  if (!isBoundedString(raw.candidateSetHash, 256)) {
    return { ok: false, reason: 'candidate_set_hash_out_of_schema' };
  }
  if (!ASSIST_RELATIONS.includes(raw.relation as AssistRelation)) {
    return { ok: false, reason: 'relation_out_of_schema' };
  }
  if (raw.selectedCandidateId !== null && !isBoundedString(raw.selectedCandidateId, 128)) {
    return { ok: false, reason: 'selected_candidate_id_out_of_schema' };
  }
  for (const field of [
    'selectedCandidateConfidence',
    'transcriptCoverage',
    'candidateCoverage',
    'confidence',
  ] as const) {
    if (!isUnit(raw[field])) return { ok: false, reason: `${field}_out_of_range` };
  }
  if (typeof raw.shouldInfluenceTracking !== 'boolean') {
    return { ok: false, reason: 'should_influence_tracking_out_of_schema' };
  }
  if (!CRITICAL_MISMATCHES.includes(raw.criticalMismatch as CriticalMismatch)) {
    return { ok: false, reason: 'critical_mismatch_out_of_schema' };
  }
  if (!TIP_CODES.includes(raw.coachTipCode as CoachTipCode)) {
    return { ok: false, reason: 'coach_tip_code_out_of_schema' };
  }
  return { ok: true, result: raw as unknown as SemanticAssistResult };
}

/**
 * Full validation of a classification result (C.4). Returns the result only
 * when it is structurally valid, current, and domain-consistent.
 */
export function validateSemanticAssist(
  raw: unknown,
  expectation: ClassificationExpectation,
): Validation<SemanticAssistResult> {
  const shape = parseAssistShape(raw);
  if (!shape.ok) return shape;
  const result = shape.result;

  if (result.requestId !== expectation.requestId) {
    return { ok: false, reason: 'request_id_mismatch' };
  }
  if (result.semanticEpoch !== expectation.semanticEpoch) {
    return { ok: false, reason: 'semantic_epoch_mismatch' };
  }
  if (result.transcriptRevision !== expectation.transcriptRevision) {
    return { ok: false, reason: 'transcript_revision_mismatch' };
  }
  if (result.candidateSetHash !== expectation.candidateSetHash) {
    return { ok: false, reason: 'candidate_set_hash_mismatch' };
  }

  const candidate =
    result.selectedCandidateId === null
      ? undefined
      : expectation.candidates.find((c) => c.id === result.selectedCandidateId);

  if (result.selectedCandidateId !== null && candidate === undefined) {
    return { ok: false, reason: 'nonexistent_candidate' };
  }
  if (result.shouldInfluenceTracking && candidate === undefined) {
    return { ok: false, reason: 'influence_without_candidate' };
  }
  if (
    result.shouldInfluenceTracking &&
    (result.relation === 'adlib' || result.relation === 'unresolved')
  ) {
    return { ok: false, reason: 'influence_from_non_advancing_relation' };
  }
  if (candidate !== undefined) {
    // §51 step 6 / §3.6: Luna can never authorize a prohibited transition.
    if (!candidate.sectionTransitionAllowed) {
      return { ok: false, reason: 'prohibited_section_transition' };
    }
    const allowed = RELATION_ALLOWED_HINTS[result.relation];
    if (result.shouldInfluenceTracking && !allowed.includes(candidate.relationHint)) {
      return { ok: false, reason: 'relation_direction_incompatible' };
    }
  }

  if (result.coachTipCode !== 'none') {
    const required = TIP_REQUIRES_MISMATCH[result.coachTipCode];
    if (result.coachTipCode === 'restart_detected') {
      if (result.relation !== 'restart' && result.relation !== 'self_correction') {
        return { ok: false, reason: 'tip_code_incompatible_with_relation' };
      }
    } else if (!required.includes(result.criticalMismatch)) {
      return { ok: false, reason: 'tip_code_incompatible_with_mismatch' };
    }
  }

  return { ok: true, result };
}

export interface RetrievalExpectation {
  requestId: string;
  semanticEpoch: number;
  transcriptRevision: number;
  landmarkSetHash: string;
  /** Landmark IDs that appeared in the request (§39.2). */
  offeredLandmarkIds: readonly string[];
}

export function validateLandmarkRetrieval(
  raw: unknown,
  expectation: RetrievalExpectation,
): Validation<SemanticLandmarkRetrievalResult> {
  if (!isRecord(raw)) return { ok: false, reason: 'not_an_object' };
  const allowed = new Set([
    'schemaVersion',
    'requestId',
    'semanticEpoch',
    'transcriptRevision',
    'landmarkSetHash',
    'relation',
    'candidateLandmarkIds',
    'confidence',
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) return { ok: false, reason: `additional_property:${key}` };
  }
  if (raw.schemaVersion !== 1) return { ok: false, reason: 'schema_version' };
  if (!isBoundedString(raw.requestId, 128)) return { ok: false, reason: 'request_id_out_of_schema' };
  if (!isIndex(raw.semanticEpoch) || !isIndex(raw.transcriptRevision)) {
    return { ok: false, reason: 'identity_out_of_schema' };
  }
  if (!isBoundedString(raw.landmarkSetHash, 256)) {
    return { ok: false, reason: 'landmark_set_hash_out_of_schema' };
  }
  if (!RETRIEVAL_RELATIONS.includes(raw.relation as RetrievalRelation)) {
    return { ok: false, reason: 'relation_out_of_schema' };
  }
  if (!isUnit(raw.confidence)) return { ok: false, reason: 'confidence_out_of_range' };
  if (!Array.isArray(raw.candidateLandmarkIds)) {
    return { ok: false, reason: 'candidate_landmark_ids_out_of_schema' };
  }
  if (raw.candidateLandmarkIds.length > 3) return { ok: false, reason: 'too_many_landmarks' };

  const seen = new Set<string>();
  const offered = new Set(expectation.offeredLandmarkIds);
  for (const id of raw.candidateLandmarkIds) {
    if (!isBoundedString(id, 128)) return { ok: false, reason: 'landmark_id_out_of_schema' };
    if (seen.has(id)) return { ok: false, reason: 'duplicate_landmark_id' };
    seen.add(id);
    // §39.2: every returned ID must have appeared in the request.
    if (!offered.has(id)) return { ok: false, reason: 'nonexistent_landmark' };
  }

  if (raw.requestId !== expectation.requestId) return { ok: false, reason: 'request_id_mismatch' };
  if (raw.semanticEpoch !== expectation.semanticEpoch) {
    return { ok: false, reason: 'semantic_epoch_mismatch' };
  }
  if (raw.transcriptRevision !== expectation.transcriptRevision) {
    return { ok: false, reason: 'transcript_revision_mismatch' };
  }
  if (raw.landmarkSetHash !== expectation.landmarkSetHash) {
    return { ok: false, reason: 'landmark_set_hash_mismatch' };
  }
  // §39.2: ad-lib and unresolved normally return an empty array.
  if (
    (raw.relation === 'adlib' || raw.relation === 'unresolved') &&
    raw.candidateLandmarkIds.length > 0
  ) {
    return { ok: false, reason: 'landmarks_from_non_advancing_relation' };
  }
  return { ok: true, result: raw as unknown as SemanticLandmarkRetrievalResult };
}

export interface PreparationExpectation {
  requestId: string;
  scriptCompileHash: string;
  sectionId: string;
  /** Span IDs supplied in the request (§39.3: invented IDs are discarded). */
  offeredSpanIds: readonly string[];
}

/**
 * Validate a preparation result. Unlike the live paths this one *filters*:
 * §39.3 allows missing annotations, so unknown or duplicated IDs are dropped
 * while the rest of the batch is kept.
 */
export function validateLandmarkPreparation(
  raw: unknown,
  expectation: PreparationExpectation,
): Validation<SemanticLandmarkPreparationResult> {
  if (!isRecord(raw)) return { ok: false, reason: 'not_an_object' };
  if (raw.schemaVersion !== 1) return { ok: false, reason: 'schema_version' };
  if (raw.requestId !== expectation.requestId) return { ok: false, reason: 'request_id_mismatch' };
  if (raw.scriptCompileHash !== expectation.scriptCompileHash) {
    return { ok: false, reason: 'script_compile_hash_mismatch' };
  }
  if (raw.sectionId !== expectation.sectionId) return { ok: false, reason: 'section_id_mismatch' };
  if (!Array.isArray(raw.annotations)) return { ok: false, reason: 'annotations_out_of_schema' };
  if (raw.annotations.length > 128) return { ok: false, reason: 'too_many_annotations' };

  const offered = new Set(expectation.offeredSpanIds);
  const seen = new Set<string>();
  const annotations: SemanticLandmarkPreparationResult['annotations'] = [];

  for (const entry of raw.annotations) {
    if (!isRecord(entry)) return { ok: false, reason: 'annotation_out_of_schema' };
    if (!isBoundedString(entry.spanId, 128)) continue;
    if (!offered.has(entry.spanId) || seen.has(entry.spanId)) continue; // invented/dup: drop
    if (!isBoundedString(entry.proposition, 240)) continue;
    if (!EXACTNESS.includes(entry.exactness as LandmarkExactness)) continue;
    if (!Array.isArray(entry.topicLabels) || entry.topicLabels.length > 6) continue;
    if (!Array.isArray(entry.conversationalAliases) || entry.conversationalAliases.length > 12) {
      continue;
    }
    if (!Array.isArray(entry.criticalTerms) || entry.criticalTerms.length > 16) continue;
    const terms = entry.criticalTerms.filter(
      (t): t is { kind: string; canonical: string } =>
        isRecord(t) &&
        typeof t.kind === 'string' &&
        CRITICAL_TERM_KINDS.includes(t.kind) &&
        isBoundedString(t.canonical, 160),
    );
    if (terms.length !== entry.criticalTerms.length) continue;

    seen.add(entry.spanId);
    annotations.push({
      spanId: entry.spanId,
      proposition: entry.proposition,
      topicLabels: entry.topicLabels.filter((l): l is string => isBoundedString(l, 64)),
      criticalTerms: terms as SemanticLandmarkPreparationResult['annotations'][number]['criticalTerms'],
      conversationalAliases: entry.conversationalAliases.filter((a): a is string =>
        isBoundedString(a, 160),
      ),
      exactness: entry.exactness as LandmarkExactness,
    });
  }

  return {
    ok: true,
    result: {
      schemaVersion: 1,
      requestId: expectation.requestId,
      scriptCompileHash: expectation.scriptCompileHash,
      sectionId: expectation.sectionId,
      annotations,
    },
  };
}
