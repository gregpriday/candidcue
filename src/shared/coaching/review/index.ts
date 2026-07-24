/**
 * Post-take review (spec §31, §32, §36).
 *
 * `buildReviewModel` is the whole public entry point: give it a recorded
 * session and it returns everything `Review.svelte` renders. The individual
 * modules are exported too, because each is independently testable and the
 * report store is useful without the screen.
 */
export {
  absenceCopy,
  buildSummaryCards,
  formatDurationMs,
  formatPercent,
  formatRate,
  formatSignedDurationMs,
  formatWpm,
  type ReviewCard,
  type ReviewCardId,
  type ReviewCardTone,
} from './cards';

export {
  compareWithHistory,
  DEFAULT_MAX_PRIOR_SESSIONS,
  type ComparisonOptions,
  type DesirableDirection,
  type PersonalComparison,
  type PersonalTrend,
  type TrendBlockReason,
  type TrendMetricId,
} from './comparison';

export {
  buildPassageIndex,
  buildTimeline,
  DEFAULT_MAX_SERIES_STEPS,
  downsampleSteps,
  eventsForPass,
  eventsOnTrack,
  selectPassageForEvent,
  type PassageIndex,
  type ReviewTimeline,
  type ScriptPositionPoint,
  type ScriptSelection,
  type SelectionResult,
  type SpeechSegment,
  type TimelineEvent,
  type TimelineEventKind,
  type TimelineOptions,
  type TimelinePass,
  type TimelineStep,
  type TimelineTrackId,
} from './event-map';

export {
  applyLunaSelection,
  buildRecommendationCandidates,
  describeTipFollowThrough,
  isSafeFact,
  MAX_FACT_CHARS,
  MAX_RECOMMENDATIONS,
  renderTemplate,
  selectRecommendations,
  TIP_FOLLOW_THROUGH_TEXT,
  TIP_FOLLOW_THROUGH_WINDOW_MS,
  type NarrationOutcome,
  type NarrationRejection,
  type NarrationRejectionReason,
  type Recommendation,
  type RecommendationCandidate,
  type RecommendationPatternId,
  type RecommendationVariant,
  type TipFollowThrough,
} from './recommendations';

export {
  buildStoredReport,
  InMemoryReviewReportPersistence,
  redactedForm,
  redactTranscriptDerived,
  ReportStore,
  REPORT_SQL_SCHEMA,
  retentionStatement,
  type ReportListQuery,
  type RetentionStatement,
  type ReviewReportPersistence,
  type SaveOutcome,
  type SaveSkipReason,
  type StoredCoachingEvent,
  type StoredCoachingReport,
  type StoredReportHeader,
  type StoredTranscript,
} from './report-store';

export {
  annotateScript,
  type AnnotatedPassage,
  type AnnotatedScript,
  type AnnotationOptions,
  type ScriptAnnotation,
  type ScriptAnnotationKind,
} from './script-annotations';

export {
  computeTakeMetrics,
  countFillerClusters,
  deliveryMsBetween,
  FILLER_CLUSTER_MIN_EVENTS,
  FILLER_CLUSTER_WINDOW_MS,
  longestFillerFreeMsInPass,
  measured,
  summarizeMicrophone,
  summarizeSession,
  unmeasured,
  unmeasuredMsOf,
  type AbsenceReason,
  type CadenceSummary,
  type DurationSummary,
  type FidelitySummary,
  type FillerFormCount,
  type FillerSummary,
  type Measurement,
  type MicrophoneSummary,
  type PaceSummary,
  type PassSummary,
  type SessionSummary,
  type SummaryOptions,
  type TakeMetrics,
  type TimeAccountingSummary,
  type TipsShownSummary,
  type VarietySummary,
} from './session-summary';

export * from './types';

export { buildReviewModel, selectPassage, type ReviewModel, type ReviewModelInput } from './view-model';
