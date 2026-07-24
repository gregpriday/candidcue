/**
 * One object for the whole review screen.
 *
 * `Review.svelte` takes exactly this as a single prop and does no arithmetic,
 * no formatting and no selection logic of its own. That is deliberate: §31.5
 * requires every figure shown to come from validated local data, and a
 * component that cannot compute a number cannot show a wrong one. It also
 * makes the whole screen testable in a node environment, which matters in a
 * repo with no jsdom.
 */
import { buildSummaryCards, type ReviewCard } from './cards';
import {
  compareWithHistory,
  type ComparisonOptions,
  type PersonalComparison,
} from './comparison';
import {
  buildPassageIndex,
  buildTimeline,
  selectPassageForEvent,
  type PassageIndex,
  type ReviewTimeline,
  type SelectionResult,
  type TimelineOptions,
} from './event-map';
import {
  applyLunaSelection,
  buildRecommendationCandidates,
  describeTipFollowThrough,
  selectRecommendations,
  type NarrationRejection,
  type Recommendation,
  type TipFollowThrough,
} from './recommendations';
import { retentionStatement, type RetentionStatement } from './report-store';
import {
  annotateScript,
  type AnnotatedScript,
  type AnnotationOptions,
} from './script-annotations';
import {
  summarizeSession,
  type SessionSummary,
  type SummaryOptions,
} from './session-summary';
import type { CoachingSessionRecord, ReviewScript } from './types';

export interface ReviewModelInput {
  record: CoachingSessionRecord;
  /**
   * The authored script, or `null` when it is unavailable (a deleted script, a
   * report opened from history without its source). The review degrades to
   * summary, timeline and recommendations rather than refusing to open.
   */
  script?: ReviewScript | null;
  /** §31.6. The user's own prior sessions. Empty means no baseline, not zero. */
  priorSummaries?: readonly SessionSummary[];
  /**
   * §31.5. A raw Luna review response, unvalidated. Omit it and the local
   * ordering stands. Whatever it contains, no number in it can be rendered.
   */
  lunaSelection?: unknown;
  options?: {
    summary?: SummaryOptions;
    timeline?: TimelineOptions;
    annotations?: AnnotationOptions;
    comparison?: ComparisonOptions;
  };
}

export interface ReviewModel {
  summary: SessionSummary;
  /** §31.2, in specification order, pre-formatted. */
  cards: readonly ReviewCard[];
  /** §31.3. */
  timeline: ReviewTimeline;
  /** `null` when no script was supplied. */
  annotatedScript: AnnotatedScript | null;
  /** `null` when no script was supplied; needed to resolve a clicked event. */
  passageIndex: PassageIndex | null;
  /** §31.5, at most three. */
  recommendations: readonly Recommendation[];
  /** Why any Luna selection was refused. Diagnostics; never rendered as copy. */
  narrationRejections: readonly NarrationRejection[];
  /** §31.6. */
  comparison: PersonalComparison;
  /** §32.2. Exactly what this take retained. */
  retention: RetentionStatement;
  /** §26.4, per pass. Sequence observations only, never causal. */
  followThrough: readonly TipFollowThrough[];
}

export function buildReviewModel(input: ReviewModelInput): ReviewModel {
  const { record } = input;
  const script = input.script ?? null;
  const options = input.options ?? {};

  const summary = summarizeSession(record, options.summary);
  const candidates = buildRecommendationCandidates(summary);
  const narration =
    input.lunaSelection === undefined
      ? { recommendations: selectRecommendations(candidates), rejections: [] }
      : applyLunaSelection(candidates, input.lunaSelection);

  return {
    summary,
    cards: buildSummaryCards(summary),
    timeline: buildTimeline(record, options.timeline),
    annotatedScript: script === null ? null : annotateScript(script, record, options.annotations),
    passageIndex: script === null ? null : buildPassageIndex(script),
    recommendations: narration.recommendations,
    narrationRejections: narration.rejections,
    comparison: compareWithHistory(summary, input.priorSummaries ?? [], options.comparison),
    retention: retentionStatement(record.consent, record.audio.available),
    followThrough: record.passes.flatMap((pass) =>
      describeTipFollowThrough(pass, record.profile.targetWpmLow, record.profile.targetWpmHigh),
    ),
  };
}

/**
 * §31.3 "clicking an event selects the aligned script passage".
 *
 * Returns a reason when it cannot: no script loaded, no anchor on the event, or
 * an anchor from a revision this script no longer has.
 */
export function selectPassage(model: ReviewModel, eventId: string): SelectionResult {
  if (model.passageIndex === null) return { resolved: false, reason: 'anchor_not_in_script' };
  return selectPassageForEvent(model.timeline, model.passageIndex, eventId);
}
