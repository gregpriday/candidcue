/**
 * Semantic score fusion (companion §40).
 *
 * Luna output becomes a BOUNDED additive adjustment on a hypothesis the local
 * engine already produced:
 *
 *     combinedLogScore = localLogScore + clamp(semanticAdjustment, -max, +max)
 *
 * where `max = profile.alignment.semanticInfluenceMax`.
 *
 * Three structural properties make Luna advisory rather than authoritative:
 *
 * 1. **Bound.** `|adjustment| ≤ influenceMax` by construction and again on
 *    application ({@link applyBoundedAdjustment} re-clamps, so a malformed or
 *    tampered evidence value cannot exceed the cap either).
 * 2. **Single beneficiary.** At most one candidate — the one Luna selected —
 *    receives an adjustment. Reordering is therefore impossible unless the
 *    local margin between the top candidate and the selected one was already
 *    ≤ `influenceMax`, i.e. the local decision was genuinely ambiguous.
 * 3. **Local-support and eligibility preconditions.** Evidence is produced
 *    only for a candidate the local aligner supplied with at least one support
 *    kind (§40.2) whose section transition the graph already permits (§51
 *    step 6). Luna can neither invent a location nor authorize a prohibited
 *    one, so it can never be the sole authority for a navigation jump.
 */
import type {
  SemanticAssistEvidence as TrackingAssistEvidence,
  SemanticAssistOpinion,
} from '../tracking/semantic-assist';
import type {
  AssistRelation,
  LocalCandidate,
  SemanticAssistEvidence,
  SemanticAssistMessage,
  SemanticAssistResult,
} from './types';

/** §40.3 relative strength per relation, as a fraction of `influenceMax`. */
const RELATION_WEIGHT: Record<AssistRelation, number> = {
  near_exact: 1.0,
  return_to_script: 0.9,
  paraphrase: 0.85,
  forward_skip: 0.6,
  restart: 0.6,
  self_correction: 0.6,
  adlib: 0,
  unresolved: 0,
};

const BEHAVIOR_HINT: Record<AssistRelation, SemanticAssistMessage['behaviorHint']> = {
  near_exact: 'advance',
  paraphrase: 'advance',
  return_to_script: 'advance',
  forward_skip: 'forward_skip',
  restart: 'retake',
  self_correction: 'retake',
  adlib: 'hold',
  unresolved: 'none',
};

/** §40.4. Semantic evidence must not outlive the span it was computed for. */
export const DEFAULT_EVIDENCE_LIFETIME_MS = 2_500;

export interface FusionInput {
  /** A result that already passed `validateSemanticAssist`. */
  result: SemanticAssistResult;
  /** Exactly the candidate set the request was built for. */
  candidates: readonly LocalCandidate[];
  /** `profile.alignment.semanticInfluenceMax`. */
  influenceMax: number;
  /**
   * Whether the analyzed transcript span is finalized. §3.6/§40.1: Luna may
   * never make an irreversible change from provisional speech alone.
   */
  finalEvidence: boolean;
  sessionId: string;
  sessionGeneration: number;
  scriptCompileHash: string;
  nowMs: number;
  evidenceLifetimeMs?: number;
}

export function clampInfluence(value: number, influenceMax: number): number {
  const max = Math.max(0, influenceMax);
  if (!Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(-max, value));
}

/**
 * Convert a validated result into a bounded assist message, or `null` when the
 * result carries no usable movement evidence.
 */
export function fuseSemanticAssist(input: FusionInput): SemanticAssistMessage | null {
  const { result, influenceMax } = input;
  const lifetime = input.evidenceLifetimeMs ?? DEFAULT_EVIDENCE_LIFETIME_MS;
  const behaviorHint = BEHAVIOR_HINT[result.relation];

  const base: Omit<SemanticAssistMessage, 'evidence' | 'behaviorHint'> = {
    sessionId: input.sessionId,
    sessionGeneration: input.sessionGeneration,
    scriptCompileHash: input.scriptCompileHash,
    semanticEpoch: result.semanticEpoch,
    transcriptRevision: result.transcriptRevision,
    candidateSetHash: result.candidateSetHash,
    issuedAtMs: input.nowMs,
    expiresAtMs: input.nowMs + lifetime,
  };

  const empty = (hint: SemanticAssistMessage['behaviorHint']): SemanticAssistMessage => ({
    ...base,
    evidence: [],
    behaviorHint: hint,
  });

  // §40.3: ad-lib raises the hold branch but contributes no positive evidence.
  if (result.relation === 'adlib') return empty('hold');
  if (result.relation === 'unresolved') return empty('none');
  if (!result.shouldInfluenceTracking) return empty(behaviorHint === 'hold' ? 'hold' : 'none');
  // §3.6: never an irreversible change from provisional-only speech.
  if (!input.finalEvidence) return empty('none');

  const candidate = input.candidates.find((c) => c.id === result.selectedCandidateId);
  if (candidate === undefined) return empty('none');
  // §40.2: minimum local support is mandatory.
  if (candidate.supportKinds.length === 0) return empty('none');
  // §3.6 / §51 step 6: the section graph decides, not Luna.
  if (!candidate.sectionTransitionAllowed) return empty('none');

  const magnitude = semanticMagnitude(result, influenceMax);
  if (magnitude <= 0) return empty(behaviorHint);

  const evidence: SemanticAssistEvidence = {
    candidateId: candidate.id,
    adjustment: clampInfluence(magnitude, influenceMax),
    relation: result.relation,
    confidence: result.confidence,
    influenceMax,
  };
  return { ...base, evidence: [evidence], behaviorHint };
}

/**
 * Magnitude before clamping. Confidence and coverage can only shrink the
 * contribution — never grow it beyond `relationWeight * influenceMax`.
 */
export function semanticMagnitude(result: SemanticAssistResult, influenceMax: number): number {
  const weight = RELATION_WEIGHT[result.relation];
  if (weight <= 0) return 0;
  const confidence = Math.min(result.confidence, result.selectedCandidateConfidence);
  // A paraphrase is capped by how much of the candidate span it covered (§40.3).
  const coverage =
    result.relation === 'paraphrase'
      ? Math.max(result.candidateCoverage, result.transcriptCoverage)
      : 1;
  return Math.max(0, influenceMax * weight * confidence * coverage);
}

/**
 * Adapt a fused result to the tracking worker's inbound `semantic_assist`
 * payload (`src/shared/tracking/semantic-assist.ts`, owned by the alignment
 * engine).
 *
 * INTEGRATION (one line): post
 * `{ type: 'semantic_assist', evidence }` to the tracking worker with the
 * value this function returns.
 *
 * The worker's `semanticAdjustment` applies its own relation direction and its
 * own `semanticInfluenceMax` bound, so the opinion carries the *raw* confidence
 * — not this module's pre-weighted magnitude — to avoid double weighting.
 */
export function toTrackingAssistEvidence(input: {
  result: SemanticAssistResult;
  message: SemanticAssistMessage;
  /** Exactly the candidate set the request was built for. */
  candidates: readonly LocalCandidate[];
  assistId: string;
  requestRevision: number;
  sourceItemIds: readonly string[];
  receivedAtMs: number;
}): TrackingAssistEvidence {
  const { result, message } = input;
  const opinions: SemanticAssistOpinion[] = [];

  if (result.relation === 'adlib') {
    // §40.3: ad-lib raises the hold branch. The worker maps `adlib` to a
    // negative direction, so every eligible candidate carries the opinion.
    for (const candidate of input.candidates) {
      opinions.push({ candidateId: candidate.id, relation: 'adlib', confidence: result.confidence });
    }
  } else {
    for (const evidence of message.evidence) {
      opinions.push({
        candidateId: evidence.candidateId,
        relation: evidence.relation,
        confidence: rawOpinionConfidence(result),
      });
    }
  }

  return {
    assistId: input.assistId,
    epoch: message.semanticEpoch,
    requestRevision: input.requestRevision,
    sourceItemIds: [...input.sourceItemIds],
    receivedAtMs: input.receivedAtMs,
    opinions,
  };
}

/** Confidence before any relation weighting; coverage still caps a paraphrase. */
function rawOpinionConfidence(result: SemanticAssistResult): number {
  const confidence = Math.min(result.confidence, result.selectedCandidateConfidence);
  const coverage =
    result.relation === 'paraphrase'
      ? Math.max(result.candidateCoverage, result.transcriptCoverage)
      : 1;
  return Math.max(0, Math.min(1, confidence * coverage));
}

export interface ScoredCandidate {
  id: string;
  localLogScore: number;
  combinedLogScore: number;
}

/**
 * Apply bounded evidence to local scores. This is the reference implementation
 * of the injection point the tracking beam scorer performs; it re-clamps every
 * adjustment so an out-of-range value in a message cannot widen the influence.
 */
export function applyBoundedAdjustment(
  candidates: ReadonlyArray<{ id: string; localLogScore: number }>,
  evidence: readonly SemanticAssistEvidence[],
  influenceMax: number,
): ScoredCandidate[] {
  const byId = new Map(evidence.map((e) => [e.candidateId, e]));
  return candidates.map((candidate) => {
    const found = byId.get(candidate.id);
    const adjustment = found === undefined ? 0 : clampInfluence(found.adjustment, influenceMax);
    return {
      id: candidate.id,
      localLogScore: candidate.localLogScore,
      combinedLogScore: candidate.localLogScore + adjustment,
    };
  });
}

/** The local winner, or `null` for an empty set. */
export function topByLocalScore(
  candidates: ReadonlyArray<{ id: string; localLogScore: number }>,
): string | null {
  let best: { id: string; localLogScore: number } | null = null;
  for (const candidate of candidates) {
    if (best === null || candidate.localLogScore > best.localLogScore) best = candidate;
  }
  return best?.id ?? null;
}

/**
 * Local margin between the best and second-best candidate. Semantic evidence
 * can only reorder the top when this margin is `≤ influenceMax`.
 */
export function localTopMargin(
  candidates: ReadonlyArray<{ id: string; localLogScore: number }>,
): number {
  if (candidates.length < 2) return Number.POSITIVE_INFINITY;
  const sorted = [...candidates].sort((a, b) => b.localLogScore - a.localLogScore);
  const [best, runnerUp] = sorted;
  if (best === undefined || runnerUp === undefined) return Number.POSITIVE_INFINITY;
  return best.localLogScore - runnerUp.localLogScore;
}
