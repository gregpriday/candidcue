/**
 * §31.2 summary cards as a view model.
 *
 * The route renders these strings and formats nothing itself. That is not a
 * style preference: §31.5 requires every figure the presenter reads to come
 * from validated local data, and the cheapest way to guarantee it is to leave
 * the component with no arithmetic to do. A card either has a formatted value
 * or an explicit reason it has none.
 *
 * Tone is used sparingly and never as a verdict on delivery. §2.5 is explicit
 * that more variety is not better and §2.1 that coaching is advisory, so only
 * two things are allowed to look like a problem: a sustained microphone fault,
 * and a critical script discrepancy. Pace, variety and filler cards stay
 * neutral — they report, they do not grade.
 */
import type { AbsenceReason, Measurement, SessionSummary } from './session-summary';
import type { MicrophoneStatus } from './types';

/** §12.7 status copy. Authored, never derived from a model. */
const MIC_STATUS_COPY: Record<MicrophoneStatus, string> = {
  ok: 'Healthy',
  learning: 'Still calibrating',
  low_level: 'Low input level',
  clipping: 'Clipping',
  noisy: 'Noisy',
  no_signal: 'No signal',
  disconnected: 'Disconnected',
};

export type ReviewCardId =
  | 'audible_wpm'
  | 'articulation_wpm'
  | 'time_in_target_pace'
  | 'projected_vs_actual'
  | 'fillers'
  | 'most_frequent_filler'
  | 'longest_filler_free'
  | 'variety'
  | 'terminal_rush'
  | 'cadence_events'
  | 'retakes'
  | 'critical_discrepancies'
  | 'microphone';

export type ReviewCardTone = 'neutral' | 'attention';

export interface ReviewCard {
  id: ReviewCardId;
  label: string;
  /** Formatted primary value, or `null` when it could not be measured. */
  value: string | null;
  /** Secondary line: the denominator, the band, the context. */
  detail: string | null;
  /** Authored explanation of why `value` is `null`. `null` when it is not. */
  absentLabel: string | null;
  tone: ReviewCardTone;
}

/* ---------------------------------------------------------------------------
 * Formatting
 * ------------------------------------------------------------------------- */

/** Whole words per minute. A fractional WPM implies precision we do not have. */
export function formatWpm(wpm: number): string {
  return `${Math.round(wpm)} WPM`;
}

/** Percent, rounded to whole points. */
export function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/** Up to two decimals, with trailing zeros trimmed: 1.333… → `1.33`, 2 → `2`. */
export function formatRate(rate: number): string {
  const fixed = rate.toFixed(2);
  return fixed.replace(/\.?0+$/, '');
}

/** `m:ss`, or `h:mm:ss` past an hour. Always a duration, never a clock time. */
export function formatDurationMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  return hours > 0
    ? `${hours}:${mm}:${String(seconds).padStart(2, '0')}`
    : `${mm}:${String(seconds).padStart(2, '0')}`;
}

/** A signed duration difference: `+0:12`, `−0:12`, `0:00`. */
export function formatSignedDurationMs(ms: number): string {
  const rounded = Math.round(ms / 1000) * 1000;
  if (rounded === 0) return formatDurationMs(0);
  const sign = rounded > 0 ? '+' : '−';
  return `${sign}${formatDurationMs(Math.abs(rounded))}`;
}

const ABSENCE_COPY: Record<AbsenceReason, string> = {
  no_measured_time: 'No measured delivery time in this take.',
  no_voiced_time: 'No voiced audio was measured.',
  no_words: 'No words were transcribed.',
  no_target_duration: 'This script has no target duration.',
  no_projection: 'The take never had enough evidence to project a finish.',
  no_pace_samples: 'Pace was never measured during this take.',
  no_variety_samples: 'Variety was never sampled during this take.',
  pitch_unusable: 'Not enough usable pitch to score variety.',
  no_energy_data: 'No energy measurements were recorded.',
  no_eligible_sentences: 'No sentence was long enough to measure.',
  no_eligible_boundaries: 'No eligible sentence boundary was reached.',
  no_fillers: 'No fillers were confirmed.',
  no_microphone_data: 'No microphone measurements were recorded.',
  no_prior_sessions: 'No earlier sessions to compare with.',
  metric_not_comparable: 'Not comparable with this take.',
};

export function absenceCopy(reason: AbsenceReason): string {
  return ABSENCE_COPY[reason];
}

function card(
  id: ReviewCardId,
  label: string,
  measurement: Measurement<string>,
  detail: string | null,
  tone: ReviewCardTone = 'neutral',
): ReviewCard {
  return {
    id,
    label,
    value: measurement.value,
    detail: measurement.value === null ? null : detail,
    absentLabel: measurement.absent === null ? null : absenceCopy(measurement.absent),
    tone,
  };
}

/** Map a numeric measurement through a formatter, preserving the absence. */
function formatMeasurement<T>(
  measurement: Measurement<T>,
  format: (value: T) => string,
): Measurement<string> {
  return measurement.value === null
    ? { value: null, absent: measurement.absent }
    : { value: format(measurement.value), absent: null };
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/* ---------------------------------------------------------------------------
 * §31.2
 * ------------------------------------------------------------------------- */

/** Build the thirteen §31.2 cards, in the order the specification lists them. */
export function buildSummaryCards(summary: SessionSummary): ReviewCard[] {
  const { metrics, microphone, profile } = summary;
  const { pace, duration, fillers, variety, cadence, fidelity } = metrics;

  const cards: ReviewCard[] = [];

  cards.push(
    card(
      'audible_wpm',
      'Average pace',
      formatMeasurement(pace.audibleWpm, formatWpm),
      `${plural(metrics.words.audibleWords, 'audible word')} over ${formatDurationMs(metrics.time.deliveryMs)} of delivery`,
    ),
  );

  cards.push(
    card(
      'articulation_wpm',
      'Articulation pace',
      formatMeasurement(pace.articulationWpm, formatWpm),
      `Speaking time only — ${formatDurationMs(metrics.time.voicedMs)} voiced`,
    ),
  );

  cards.push(
    card(
      'time_in_target_pace',
      'Time inside target pace',
      formatMeasurement(pace.insideTargetRatio, formatPercent),
      `Target ${profile.targetWpmLow}–${profile.targetWpmHigh} WPM, measured for ${formatDurationMs(pace.measuredMs)}`,
    ),
  );

  const projectedCard: Measurement<string> =
    duration.projectedTotalMs.value === null
      ? { value: null, absent: duration.projectedTotalMs.absent }
      : {
          value: `${formatDurationMs(duration.projectedTotalMs.value)} projected · ${formatDurationMs(duration.actualDurationMs)} actual`,
          absent: null,
        };
  cards.push(
    card(
      'projected_vs_actual',
      'Projected vs actual',
      projectedCard,
      duration.projectedMinusActualMs.value === null
        ? null
        : `Projection ran ${formatSignedDurationMs(duration.projectedMinusActualMs.value)} against the take`,
    ),
  );

  cards.push(
    card(
      'fillers',
      'Confirmed fillers',
      { value: String(fillers.confirmedCount), absent: null },
      fillers.perHundredWords.value === null
        ? absenceCopy(fillers.perHundredWords.absent ?? 'no_words')
        : `${formatRate(fillers.perHundredWords.value)} per 100 words`,
    ),
  );

  const topForm = fillers.mostFrequent.value;
  cards.push(
    card(
      'most_frequent_filler',
      'Most frequent filler',
      topForm === null
        ? { value: null, absent: fillers.mostFrequent.absent }
        : {
            // §25.3: only a fixed-lexicon `displayForm` may be quoted back.
            // A contextual form is counted and never repeated to the presenter.
            value: topForm.displayForm === null ? plural(topForm.count, 'use') : `“${topForm.displayForm}”`,
            absent: null,
          },
      topForm === null
        ? null
        : topForm.displayForm === null
          ? 'One repeated word, not quoted back'
          : plural(topForm.count, 'use'),
    ),
  );

  cards.push(
    card(
      'longest_filler_free',
      'Longest filler-free stretch',
      formatMeasurement(fillers.longestFillerFreeMs, formatDurationMs),
      fillers.confirmedCount === 0 ? 'The whole take' : 'Within a single take pass',
    ),
  );

  const varietyRange = variety.range.value;
  cards.push(
    card(
      'variety',
      'Vocal variety',
      formatMeasurement(variety.averageLevel, (level) => String(Math.round(level))),
      varietyRange === null
        ? null
        : `Range ${Math.round(varietyRange.low)}–${Math.round(varietyRange.high)}, target ${profile.targetVarietyLow}–${profile.targetVarietyHigh}`,
    ),
  );

  cards.push(
    card(
      'terminal_rush',
      'Rushed sentence endings',
      { value: String(cadence.terminalRushCount), absent: null },
      cadence.terminalRushEligibleSentences === 0
        ? absenceCopy('no_eligible_sentences')
        : `Of ${plural(cadence.terminalRushEligibleSentences, 'measurable sentence')}`,
    ),
  );

  cards.push(
    card(
      'cadence_events',
      'Cadence events',
      {
        value: `${plural(cadence.runOnCount, 'run-on')} · ${plural(cadence.choppyPauseCount, 'choppy pause')}`,
        absent: null,
      },
      cadence.shapedBoundaryRatio.value === null
        ? null
        : `${formatPercent(cadence.shapedBoundaryRatio.value)} of ${plural(cadence.eligibleBoundaries, 'boundary', 'boundaries')} were shaped`,
    ),
  );

  cards.push(
    card(
      'retakes',
      'Retakes',
      { value: String(summary.retakeCount), absent: null },
      `${plural(summary.takePassCount, 'take pass', 'take passes')} recorded`,
    ),
  );

  cards.push(
    card(
      'critical_discrepancies',
      'Critical script discrepancies',
      { value: String(fidelity.criticalDiscrepancyCount), absent: null },
      fidelity.selfCorrectedCount > 0
        ? `${plural(fidelity.selfCorrectedCount, 'more')} self-corrected during the take`
        : null,
      fidelity.criticalDiscrepancyCount > 0 ? 'attention' : 'neutral',
    ),
  );

  const micStatus = microphone.dominantStatus.value;
  const worstIssue = microphone.sustainedIssues[0];
  cards.push(
    card(
      'microphone',
      'Microphone',
      micStatus === null
        ? { value: null, absent: microphone.dominantStatus.absent }
        : { value: MIC_STATUS_COPY[micStatus], absent: null },
      microphone.medianLevelDbfs.value === null
        ? null
        : `Median level ${microphone.medianLevelDbfs.value.toFixed(1)} dBFS${
            microphone.medianSnrDb.value === null
              ? ''
              : `, SNR ${microphone.medianSnrDb.value.toFixed(1)} dB`
          }${worstIssue === undefined ? '' : ` · ${MIC_STATUS_COPY[worstIssue.status]} for ${formatDurationMs(worstIssue.totalMs)}`}`,
      worstIssue === undefined ? 'neutral' : 'attention',
    ),
  );

  return cards;
}

