/**
 * Semantic assist seam (companion §3.6, §40, A.2).
 *
 * The Luna sidecar is an *advisory* input. It never picks a position: the
 * local aligner mints candidate ids, hands the sidecar only those ids, and
 * accepts back nothing but a relation plus a confidence per supplied id. This
 * file defines that inbound shape and the single bounded fusion function the
 * beam scorer calls. Scheduling, request construction, and network calls are
 * NOT here — they belong to the sidecar agent's scheduler module and to Rust.
 *
 * Hard bounds enforced here (§3.6, §40.1):
 *   - a relation may only touch a candidate the local engine already supplied
 *     (`candidateId` must exist in the current candidate set — §40.2);
 *   - the adjustment is clamped to ±`alignment.semanticInfluenceMax` of the
 *     local decision margin, so it can never overcome an eligibility failure,
 *     an authority boundary, or a very poor local candidate;
 *   - evidence expires (§40.4) and is rejected outright when its epoch or its
 *     source items are stale (§25.7).
 */
import type { SmoothFollowProfile } from '../contracts/smooth-follow';

/** Companion §40.3. The only vocabulary the sidecar may return. */
export type SemanticAssistRelation =
  | 'near_exact'
  | 'paraphrase'
  | 'adlib'
  | 'return_to_script'
  | 'restart'
  | 'self_correction'
  | 'forward_skip'
  | 'unresolved';

/** One graded opinion about one locally supplied candidate. */
export interface SemanticAssistOpinion {
  /** Must equal a `candidateId` the local engine supplied (§40.2). */
  candidateId: string;
  relation: SemanticAssistRelation;
  /** Sidecar confidence in [0, 1]; non-finite values are treated as 0. */
  confidence: number;
}

/**
 * A complete sidecar response. This is also the payload of the worker's
 * `semantic_assist` inbound message.
 */
export interface SemanticAssistEvidence {
  assistId: string;
  /** Semantic epoch the request was issued under (§25.7 stale rejection). */
  epoch: number;
  /** Frame/decision revision the request was issued from. */
  requestRevision: number;
  /** Transcript items the classification was computed over (§25.7). */
  sourceItemIds: string[];
  /** Session-relative time the response became usable. */
  receivedAtMs: number;
  opinions: SemanticAssistOpinion[];
}

/**
 * How each relation biases a candidate, as a fraction of the maximum
 * influence (companion §40.3). Positive values strengthen the candidate;
 * `adlib`/`unresolved` supply no positive movement evidence at all.
 */
const RELATION_DIRECTION: Record<SemanticAssistRelation, number> = {
  near_exact: 1.0,
  paraphrase: 0.85,
  return_to_script: 0.9,
  restart: 0.7, // strengthens an eligible retake branch only
  self_correction: 0.7,
  forward_skip: 0.6, // still subject to final evidence + distance gates
  adlib: -1.0, // pushes toward the hold/ad-lib branch
  unresolved: 0,
};

/** Relations that may only ever support a *backward* (retake) branch. */
const BACKWARD_ONLY: ReadonlySet<SemanticAssistRelation> = new Set([
  'restart',
  'self_correction',
]);

/** Relations that may only ever support a *forward skip* branch. */
const FORWARD_SKIP_ONLY: ReadonlySet<SemanticAssistRelation> = new Set(['forward_skip']);

export interface SemanticAdjustmentInput {
  /** The locally minted id of the candidate being scored. */
  candidateId: string;
  /** Signed token distance from the committed cursor to this candidate. */
  distanceTokens: number;
  /** True when this candidate exceeds the ordinary forward-skip distance. */
  largeForward: boolean;
  /** Local score before any semantic contribution (used only for bounding). */
  localScore: number;
  /** Whether the driving transcript evidence is finalized (§15.3). */
  finalEvidence: boolean;
  /** Current semantic epoch. */
  epoch: number;
  /** Session-relative now. */
  nowMs: number;
  /** Item ids currently contributing to alignment. */
  activeItemIds: ReadonlySet<string>;
}

export interface SemanticAdjustment {
  /** Additive, already-clamped score contribution. */
  delta: number;
  relation?: SemanticAssistRelation;
  assistId?: string;
}

const NO_ADJUSTMENT: SemanticAdjustment = { delta: 0 };

/**
 * Is this evidence still usable? (§25.7, §40.4.)
 * Rejected when the epoch moved on, when it has expired, or when none of its
 * source items still contribute to the alignable tail.
 */
export function isSemanticEvidenceCurrent(
  evidence: SemanticAssistEvidence | undefined,
  epoch: number,
  nowMs: number,
  ttlMs: number,
  activeItemIds: ReadonlySet<string>,
): evidence is SemanticAssistEvidence {
  if (evidence === undefined) return false;
  if (evidence.epoch !== epoch) return false;
  if (nowMs - evidence.receivedAtMs > ttlMs) return false;
  if (evidence.sourceItemIds.length === 0) return true;
  return evidence.sourceItemIds.some((id) => activeItemIds.has(id));
}

/**
 * The one place a semantic opinion turns into score. Returns a delta bounded
 * by `profile.alignment.semanticInfluenceMax` scaled by the local score, so
 * the contribution is "a modest fraction of total decision margin" (A.2) and
 * can never rescue a candidate the local engine scored near zero (§40.1).
 */
export function semanticAdjustment(
  evidence: SemanticAssistEvidence | undefined,
  input: SemanticAdjustmentInput,
  profile: SmoothFollowProfile,
): SemanticAdjustment {
  if (evidence === undefined) return NO_ADJUSTMENT;
  const opinion = evidence.opinions.find((o) => o.candidateId === input.candidateId);
  if (opinion === undefined) return NO_ADJUSTMENT; // §40.2 not locally supplied

  const direction = RELATION_DIRECTION[opinion.relation] ?? 0;
  if (direction === 0) return NO_ADJUSTMENT;

  // §15.3 / §31.8 (tightened): provisional-only context may never carry a
  // retake or a large skip, so semantics may not push one either.
  if (!input.finalEvidence && (BACKWARD_ONLY.has(opinion.relation) || input.largeForward)) {
    return NO_ADJUSTMENT;
  }
  // Relation/direction agreement: a restart opinion cannot boost a forward
  // candidate, and a forward-skip opinion cannot boost a backward one.
  if (BACKWARD_ONLY.has(opinion.relation) && input.distanceTokens >= 0) return NO_ADJUSTMENT;
  if (FORWARD_SKIP_ONLY.has(opinion.relation) && input.distanceTokens <= 0) return NO_ADJUSTMENT;

  const confidence = Number.isFinite(opinion.confidence)
    ? Math.max(0, Math.min(1, opinion.confidence))
    : 0;
  if (confidence === 0) return NO_ADJUSTMENT;

  // Bound: a modest fraction of the candidate's own local score. A candidate
  // with no local support gets no semantic lift at all (§40.1, §18.4).
  const bound = profile.alignment.semanticInfluenceMax * Math.max(0, input.localScore);
  const delta = clamp(direction * confidence * bound, -bound, bound);
  if (!Number.isFinite(delta) || delta === 0) return NO_ADJUSTMENT;
  return { delta, relation: opinion.relation, assistId: evidence.assistId };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
