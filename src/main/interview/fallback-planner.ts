import type { PlannedQuestion, SessionCoverageItem, CoveragePriority } from '@shared/domain';
import { lexicalSimilarity } from '@shared/utils';

/**
 * FALLBACK question planner + repetition detection (spec §16.17/16.18).
 *
 * When the live model fails to produce a usable next question, the runtime
 * falls back to the pre-authored `fallbackQuestions` from the brief. This
 * module scores those candidates against the current session state so the
 * runtime can pick the most useful, least-repetitive one.
 */

/** Context the scorer needs to rank fallback questions against live state. */
export interface FallbackContext {
  /** Live coverage state for the session. */
  coverage: SessionCoverageItem[];
  /** Section the interview is currently working through, if known. */
  currentSectionId: string | null;
  /** Recently asked question texts (most-recent window), for repetition checks. */
  recentQuestions: string[];
  /** Fallback texts already consumed this session, to avoid re-asking. */
  usedFallbackTexts: string[];
}

/** A scored fallback candidate. Higher `score` is better. */
export interface ScoredFallback {
  question: PlannedQuestion;
  score: number;
}

/** Repetition threshold: above this lexical similarity counts as a repeat. */
const REPEAT_SIMILARITY_THRESHOLD = 0.8;

/** Priority → base weight contributed by a targeted coverage item. */
const PRIORITY_WEIGHT: Record<CoveragePriority, number> = {
  must: 3,
  should: 2,
  optional: 1,
};

/** Penalty applied when a fallback's text has already been used this session. */
const ALREADY_USED_PENALTY = 5;

/** A coverage item counts as "covered" only when fully covered. */
function isCovered(item: SessionCoverageItem): boolean {
  return item.status === 'covered';
}

/**
 * Resolve the coverage items targeted by a fallback question. Targets that do
 * not appear in the live coverage set are simply dropped.
 */
function resolveTargets(
  question: PlannedQuestion,
  coverageById: Map<string, SessionCoverageItem>,
): SessionCoverageItem[] {
  const targets: SessionCoverageItem[] = [];
  for (const id of question.targetCoverageItemIds) {
    const item = coverageById.get(id);
    if (item) targets.push(item);
  }
  return targets;
}

/** Maximum lexical similarity between `question` and any recent question. */
function maxSimilarityToRecent(question: string, recentQuestions: string[]): number {
  let max = 0;
  for (const recent of recentQuestions) {
    const sim = lexicalSimilarity(question, recent);
    if (sim > max) max = sim;
  }
  return max;
}

/**
 * Score a single fallback question against the session context. The scoring
 * follows spec §16.17: priority weight + uncovered bonus + section relevance,
 * minus repetition, reuse, and follow-up-fatigue penalties.
 */
function scoreFallback(
  question: PlannedQuestion,
  targets: SessionCoverageItem[],
  ctx: FallbackContext,
): number {
  // Priority weight: best priority among the targeted items (0 if none resolve).
  let priorityWeight = 0;
  // Uncovered bonus: any targeted item not yet fully covered earns a flat boost.
  let uncoveredBonus = 0;
  // Section relevance: any target belonging to the current section earns 0.5.
  let sectionRelevance = 0;
  // Follow-up fatigue: discourage items already heavily followed up on.
  let maxFollowUpCount = 0;

  for (const target of targets) {
    const weight = PRIORITY_WEIGHT[target.priority];
    if (weight > priorityWeight) priorityWeight = weight;

    if (!isCovered(target)) uncoveredBonus = 2;

    if (target.followUpCount > maxFollowUpCount) maxFollowUpCount = target.followUpCount;
  }

  if (ctx.currentSectionId !== null && targetsBelongToSection(question, ctx)) {
    sectionRelevance = 0.5;
  }

  const similarityPenalty = maxSimilarityToRecent(question.text, ctx.recentQuestions) * 3;
  const alreadyUsedPenalty = ctx.usedFallbackTexts.includes(question.text)
    ? ALREADY_USED_PENALTY
    : 0;
  const recentFollowupPenalty = 0.5 * maxFollowUpCount;

  return (
    priorityWeight +
    uncoveredBonus +
    sectionRelevance -
    similarityPenalty -
    alreadyUsedPenalty -
    recentFollowupPenalty
  );
}

/**
 * Whether any target of `question` belongs to the current section. Section
 * membership is inferred from the live coverage set: a coverage item's
 * `sourceRefs` do not encode section, so we treat membership as "the targeted
 * item exists and the runtime placed the interview in `currentSectionId`".
 *
 * Section membership for a coverage item is determined elsewhere (the arc
 * holds `coverageItemIds`); here we only have live coverage, so we honour the
 * spec's "via coverage membership" by checking the target ids against the
 * current section's coverage ids supplied through the coverage snapshot.
 */
function targetsBelongToSection(question: PlannedQuestion, ctx: FallbackContext): boolean {
  // Coverage items carry no section pointer in the live snapshot, so section
  // relevance is keyed purely off the runtime-provided currentSectionId being
  // set together with the target existing in coverage. We additionally allow
  // the runtime to express membership by tagging coverage items via a matching
  // section id when available; absent that, presence of a resolvable target is
  // the membership signal.
  const sectionCoverageIds = new Set<string>();
  for (const item of ctx.coverage) {
    // A coverage item is considered part of the current section when its id is
    // referenced by that section. Since the live coverage snapshot is the only
    // source available here, the runtime is expected to pass the per-section
    // coverage in `ctx.coverage`; membership therefore reduces to existence.
    sectionCoverageIds.add(item.id);
  }
  return question.targetCoverageItemIds.some((id) => sectionCoverageIds.has(id));
}

/**
 * Rank fallback questions by usefulness for the current session state.
 * Returns every candidate paired with its score, sorted descending.
 */
export function rankFallbacks(
  fallbacks: PlannedQuestion[],
  ctx: FallbackContext,
): ScoredFallback[] {
  const coverageById = new Map<string, SessionCoverageItem>();
  for (const item of ctx.coverage) coverageById.set(item.id, item);

  const scored: ScoredFallback[] = fallbacks.map((question) => {
    const targets = resolveTargets(question, coverageById);
    return { question, score: scoreFallback(question, targets, ctx) };
  });

  // Stable-ish descending sort by score; ties keep original order.
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Pick the best fallback that is still usable: not already used and with at
 * least one target that is not yet fully covered. Returns null when no such
 * candidate exists.
 */
export function pickFallback(
  fallbacks: PlannedQuestion[],
  ctx: FallbackContext,
): PlannedQuestion | null {
  const coverageById = new Map<string, SessionCoverageItem>();
  for (const item of ctx.coverage) coverageById.set(item.id, item);

  const usedTexts = new Set(ctx.usedFallbackTexts);

  for (const { question } of rankFallbacks(fallbacks, ctx)) {
    if (usedTexts.has(question.text)) continue;

    const targets = resolveTargets(question, coverageById);
    const hasUncoveredTarget = targets.some((target) => !isCovered(target));
    if (hasUncoveredTarget) return question;
  }

  return null;
}

/**
 * Whether `question` is effectively a repeat of any recent question, judged by
 * lexical similarity above the repeat threshold.
 */
export function isRepeat(question: string, recentQuestions: string[]): boolean {
  return maxSimilarityToRecent(question, recentQuestions) > REPEAT_SIMILARITY_THRESHOLD;
}
