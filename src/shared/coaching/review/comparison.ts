/**
 * §31.6 comparison over time.
 *
 * ---------------------------------------------------------------------------
 * ONLY THE USER'S OWN PRIOR SESSIONS. NO POPULATION CLAIMS.
 * ---------------------------------------------------------------------------
 * §31.6 permits comparison against the presenter's own history and forbids
 * percentile claims without a representative dataset — which CandidCue does
 * not have. There is therefore no percentile, rank, cohort or "average user"
 * field anywhere in this module's output, and a test asserts that recursively
 * over the returned object rather than trusting the type.
 *
 * ---------------------------------------------------------------------------
 * NO PRIOR DATA MEANS NO BASELINE, NOT A DEFAULT ONE.
 * ---------------------------------------------------------------------------
 * With no comparable history every trend reports `baseline: null` and a reason.
 * A first session compared against an invented "typical" number would be the
 * exact failure §31.6 is written to prevent.
 *
 * ---------------------------------------------------------------------------
 * §36.3: A METRIC IS NOT COMPARED ACROSS A CHANGE IN HOW IT WAS COMPUTED.
 * ---------------------------------------------------------------------------
 * "Historical reports must not be silently reinterpreted using new scoring
 * formulas." A variety level from a different algorithm version, or a
 * time-in-target from a different WPM band, is a different measurement wearing
 * the same name. Those trends are blocked with a reason instead of being
 * silently averaged together.
 */
import type { SessionSummary } from './session-summary';

export type TrendMetricId =
  | 'filler_rate_per_100_words'
  | 'time_in_pace_target'
  | 'terminal_rush_frequency'
  | 'average_variety'
  | 'microphone_consistency'
  | 'retake_count';

export type TrendBlockReason =
  | 'no_prior_sessions'
  | 'no_comparable_prior_sessions'
  | 'metric_not_measured_now'
  | 'algorithm_version_changed'
  | 'target_profile_changed';

/**
 * Which direction of change the user is likely to want, where there is an
 * honest answer. `none` is not a hedge: §2.5 says more vocal variety is not
 * automatically better, and how many retakes a presenter takes is a working
 * style, not a score.
 */
export type DesirableDirection = 'lower' | 'higher' | 'none';

export interface PersonalTrend {
  metricId: TrendMetricId;
  label: string;
  desirableDirection: DesirableDirection;
  /** This session's value, or `null` when this take could not measure it. */
  current: number | null;
  /** Mean over the comparable prior sessions that measured it, or `null`. */
  baseline: number | null;
  /** `current - baseline`, or `null`. */
  delta: number | null;
  /** Prior sessions that contributed to `baseline`. */
  baselineSessionCount: number;
  /** Why there is no comparison, or `null` when there is one. */
  notComparable: TrendBlockReason | null;
}

export interface PersonalComparison {
  /** Prior sessions supplied, before any filtering. */
  priorSessionCount: number;
  /** Prior sessions used for at least one trend. */
  comparableSessionCount: number;
  /** False when nothing could be compared. Say so; do not invent a baseline. */
  hasBaseline: boolean;
  trends: readonly PersonalTrend[];
}

export interface ComparisonOptions {
  /** Most recent prior sessions to consider. §31.6 gives no number; 10 is ours. */
  maxPriorSessions?: number;
}

export const DEFAULT_MAX_PRIOR_SESSIONS = 10;

interface TrendDefinition {
  metricId: TrendMetricId;
  label: string;
  desirableDirection: DesirableDirection;
  /** §36.3: the metric changes meaning when the algorithm version changes. */
  requiresSameAlgorithmVersion: boolean;
  /** The metric is relative to the user's target band or thresholds. */
  requiresSameTargetProfile: boolean;
  read: (summary: SessionSummary) => number | null;
}

const TREND_DEFINITIONS: readonly TrendDefinition[] = [
  {
    metricId: 'filler_rate_per_100_words',
    label: 'Fillers per 100 words',
    desirableDirection: 'lower',
    // The detector's thresholds move with the algorithm version, so two
    // versions' counts are not the same measurement.
    requiresSameAlgorithmVersion: true,
    requiresSameTargetProfile: false,
    read: (summary) => summary.metrics.fillers.perHundredWords.value,
  },
  {
    metricId: 'time_in_pace_target',
    label: 'Time inside target pace',
    desirableDirection: 'higher',
    requiresSameAlgorithmVersion: false,
    // Measured against the band; a different band is a different question.
    requiresSameTargetProfile: true,
    read: (summary) => summary.metrics.pace.insideTargetRatio.value,
  },
  {
    metricId: 'terminal_rush_frequency',
    label: 'Rushed sentence endings',
    desirableDirection: 'lower',
    requiresSameAlgorithmVersion: true,
    requiresSameTargetProfile: true,
    read: (summary) => summary.metrics.cadence.terminalRushRatio.value,
  },
  {
    metricId: 'average_variety',
    label: 'Average vocal variety',
    // §2.5: neither direction is an improvement in itself.
    desirableDirection: 'none',
    requiresSameAlgorithmVersion: true,
    requiresSameTargetProfile: false,
    read: (summary) => summary.metrics.variety.averageLevel.value,
  },
  {
    metricId: 'microphone_consistency',
    label: 'Microphone consistency',
    desirableDirection: 'higher',
    requiresSameAlgorithmVersion: false,
    requiresSameTargetProfile: false,
    read: (summary) =>
      summary.microphone.consistent.value === null
        ? null
        : summary.microphone.consistent.value
          ? 1
          : 0,
  },
  {
    metricId: 'retake_count',
    label: 'Retakes',
    desirableDirection: 'none',
    requiresSameAlgorithmVersion: false,
    requiresSameTargetProfile: false,
    read: (summary) => summary.retakeCount,
  },
];

function sameTargetProfile(a: SessionSummary, b: SessionSummary): boolean {
  return (
    a.profile.targetWpmLow === b.profile.targetWpmLow &&
    a.profile.targetWpmHigh === b.profile.targetWpmHigh &&
    a.profile.targetVarietyLow === b.profile.targetVarietyLow &&
    a.profile.targetVarietyHigh === b.profile.targetVarietyHigh &&
    a.profile.terminalRushRatioThreshold === b.profile.terminalRushRatioThreshold
  );
}

/**
 * §31.6. Compare this session with the presenter's own prior sessions.
 *
 * `priors` may be in any order; the most recent by `startedAtIso` are used.
 * That field is wall clock and is used for *ordering only* — no measurement in
 * this module reads it (contract Rule 3).
 */
export function compareWithHistory(
  current: SessionSummary,
  priors: readonly SessionSummary[],
  options: ComparisonOptions = {},
): PersonalComparison {
  const limit = options.maxPriorSessions ?? DEFAULT_MAX_PRIOR_SESSIONS;
  const ordered = [...priors]
    .filter((prior) => prior.sessionId !== current.sessionId)
    .sort((a, b) => b.startedAtIso.localeCompare(a.startedAtIso))
    .slice(0, limit);

  const usedSessions = new Set<string>();
  const trends: PersonalTrend[] = TREND_DEFINITIONS.map((definition) => {
    const base = {
      metricId: definition.metricId,
      label: definition.label,
      desirableDirection: definition.desirableDirection,
    };
    const currentValue = definition.read(current);

    if (ordered.length === 0) {
      return {
        ...base,
        current: currentValue,
        baseline: null,
        delta: null,
        baselineSessionCount: 0,
        notComparable: 'no_prior_sessions' as const,
      };
    }

    const algorithmMatched = ordered.filter(
      (prior) =>
        !definition.requiresSameAlgorithmVersion ||
        prior.versions.algorithmVersion === current.versions.algorithmVersion,
    );
    if (algorithmMatched.length === 0) {
      return {
        ...base,
        current: currentValue,
        baseline: null,
        delta: null,
        baselineSessionCount: 0,
        notComparable: 'algorithm_version_changed' as const,
      };
    }

    const profileMatched = algorithmMatched.filter(
      (prior) => !definition.requiresSameTargetProfile || sameTargetProfile(current, prior),
    );
    if (profileMatched.length === 0) {
      return {
        ...base,
        current: currentValue,
        baseline: null,
        delta: null,
        baselineSessionCount: 0,
        notComparable: 'target_profile_changed' as const,
      };
    }

    const values: number[] = [];
    for (const prior of profileMatched) {
      const value = definition.read(prior);
      if (value === null) continue;
      values.push(value);
      usedSessions.add(prior.sessionId);
    }
    if (values.length === 0) {
      return {
        ...base,
        current: currentValue,
        baseline: null,
        delta: null,
        baselineSessionCount: 0,
        notComparable: 'no_comparable_prior_sessions' as const,
      };
    }

    const baseline = values.reduce((total, value) => total + value, 0) / values.length;
    if (currentValue === null) {
      return {
        ...base,
        current: null,
        baseline,
        delta: null,
        baselineSessionCount: values.length,
        notComparable: 'metric_not_measured_now' as const,
      };
    }
    return {
      ...base,
      current: currentValue,
      baseline,
      delta: currentValue - baseline,
      baselineSessionCount: values.length,
      notComparable: null,
    };
  });

  return {
    priorSessionCount: priors.length,
    comparableSessionCount: usedSessions.size,
    hasBaseline: trends.some((trend) => trend.baseline !== null),
    trends,
  };
}
