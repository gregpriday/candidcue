/**
 * §31.2 summary cards, computed from a frozen {@link CoachingSessionRecord}.
 *
 * Everything here is arithmetic over recorded evidence. There is no model, no
 * network, no clock: given the same record this module returns the same
 * numbers forever, which is the property §36.3 depends on when it forbids
 * silently reinterpreting a historical report.
 *
 * Three rules are load-bearing and each one has a test that fails if it is
 * broken:
 *
 * 1. **Delivery time is measured, never subtracted.** `deliveryMsBetween`
 *    removes recorded unmeasured spans from an interval. Nothing computes
 *    silence as `duration - voicedMs`; the residual the VAD could not account
 *    for is reported as {@link TimeAccountingSummary.unaccountedMs}, not
 *    absorbed into pause time.
 * 2. **Absence is `null` with a reason**, never `0`. A take with no measurable
 *    variety reports `absent: 'pitch_unusable'`; it does not report 0.
 * 3. **Passes are separate performances (§11.3).** Every aggregate is computed
 *    over an explicit list of passes, and a filler-free streak can never span
 *    a retake boundary.
 */
import {
  DELIVERY_SCORE_WEIGHTS,
  type DeliveryDimension,
  type DeliveryScoreConfidenceTier,
  type FillerEvent,
} from '../../contracts/coaching';
import { isCountableDisfluency, isCountableFiller } from '../disfluency/types';
import type { UnmeasuredSpan } from '../pace/speech-clock';
import {
  classifyPause,
  DEFAULT_PAUSE_THRESHOLDS,
  type PauseClass,
  type PauseThresholds,
} from '../prosody/cadence-analyzer';
import { median } from '../prosody/stats';
import type {
  CoachingSessionRecord,
  CriticalFindingRecord,
  MicrophoneSessionRecord,
  MicrophoneStatus,
  ReviewTargetProfile,
  TakePassRecord,
  TakeTimeAccounting,
} from './types';

/* ---------------------------------------------------------------------------
 * Measurement
 * ------------------------------------------------------------------------- */

/**
 * Why a metric has no value. Every one of these is a real, distinguishable
 * situation the review states out loud rather than papering over with a zero.
 */
export type AbsenceReason =
  | 'no_measured_time'
  | 'no_voiced_time'
  | 'no_words'
  | 'no_target_duration'
  | 'no_projection'
  | 'no_pace_samples'
  | 'no_variety_samples'
  | 'pitch_unusable'
  | 'no_energy_data'
  | 'no_eligible_sentences'
  | 'no_eligible_boundaries'
  | 'no_fillers'
  | 'no_microphone_data'
  | 'no_prior_sessions'
  | 'metric_not_comparable'
  /** Delivery scoring was not running for this take at all. */
  | 'not_scored'
  /** It was running, but never gathered enough evidence to state a figure. */
  | 'score_never_left_warm_up'
  /** One dimension of the score had too little evidence to judge (§9.4). */
  | 'dimension_unavailable';

/** A value that may legitimately not exist. `value` and `absent` are exclusive. */
export interface Measurement<T> {
  value: T | null;
  absent: AbsenceReason | null;
}

export function measured<T>(value: T): Measurement<T> {
  return { value, absent: null };
}

export function unmeasured<T>(reason: AbsenceReason): Measurement<T> {
  return { value: null as T | null, absent: reason };
}

/* ---------------------------------------------------------------------------
 * Time accounting
 * ------------------------------------------------------------------------- */

/** Merge overlapping/adjacent spans so overlap is never double counted. */
function mergeSpans(spans: readonly UnmeasuredSpan[]): Array<{ startMs: number; endMs: number }> {
  const sorted = spans
    .filter((span) => span.endMs > span.startMs)
    .map((span) => ({ startMs: span.startMs, endMs: span.endMs }))
    .sort((a, b) => a.startMs - b.startMs);
  const merged: Array<{ startMs: number; endMs: number }> = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, span.endMs);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

/**
 * Milliseconds of *delivery* time inside `[startMs, endMs)` — elapsed audio
 * minus the recorded unmeasured spans that overlap it.
 *
 * Deliberate pauses stay in. A worklet dropout, a command, a manual pause and
 * a retake come out, because none of them is delivery and counting them as
 * silence turns a dead microphone into a thoughtful pause (§12.5, §14.5).
 */
export function deliveryMsBetween(
  time: TakeTimeAccounting,
  startMs: number,
  endMs: number,
): number {
  const from = Math.max(startMs, time.startMs);
  const to = Math.min(endMs, time.endMs);
  if (to <= from) return 0;
  let unmeasured = 0;
  for (const span of mergeSpans(time.unmeasuredSpans)) {
    const overlap = Math.min(span.endMs, to) - Math.max(span.startMs, from);
    if (overlap > 0) unmeasured += overlap;
  }
  return Math.max(0, to - from - unmeasured);
}

/** Total unmeasured milliseconds inside a pass. */
export function unmeasuredMsOf(time: TakeTimeAccounting): number {
  let total = 0;
  for (const span of mergeSpans(time.unmeasuredSpans)) {
    const overlap = Math.min(span.endMs, time.endMs) - Math.max(span.startMs, time.startMs);
    if (overlap > 0) total += overlap;
  }
  return total;
}

export interface TimeAccountingSummary {
  /** Wall of audio the passes occupied, ms. */
  spanMs: number;
  /** `spanMs` minus unmeasured audio — the denominator of Audible WPM (§14.1). */
  deliveryMs: number;
  /** VAD-classified voiced time, ms — the denominator of Articulation WPM. */
  voicedMs: number;
  /** Silence the VAD preserved inside speech runs, ms. Real pause time. */
  internalPauseMs: number;
  /** Audio no claim can be made about, ms. */
  unmeasuredMs: number;
  /**
   * `spanMs - voicedMs - internalPauseMs - unmeasuredMs`. Positive means audio
   * the VAD simply never classified. It is reported, not redistributed.
   */
  unaccountedMs: number;
  /**
   * True when the recorded parts sum to *more* than the span, which is a
   * producer bug. Surfaced rather than clamped away, because a silently
   * clamped total is how a broken lane keeps looking healthy.
   */
  inconsistent: boolean;
}

function summarizeTime(passes: readonly TakePassRecord[]): TimeAccountingSummary {
  let spanMs = 0;
  let deliveryMs = 0;
  let voicedMs = 0;
  let internalPauseMs = 0;
  let unmeasuredMs = 0;
  for (const pass of passes) {
    const span = Math.max(0, pass.time.endMs - pass.time.startMs);
    spanMs += span;
    deliveryMs += deliveryMsBetween(pass.time, pass.time.startMs, pass.time.endMs);
    voicedMs += pass.time.voicedMs;
    internalPauseMs += pass.time.internalPauseMs;
    unmeasuredMs += unmeasuredMsOf(pass.time);
  }
  const residual = spanMs - voicedMs - internalPauseMs - unmeasuredMs;
  return {
    spanMs,
    deliveryMs,
    voicedMs,
    internalPauseMs,
    unmeasuredMs,
    unaccountedMs: Math.max(0, residual),
    inconsistent: residual < 0,
  };
}

/* ---------------------------------------------------------------------------
 * Pace (§14, §31.2)
 * ------------------------------------------------------------------------- */

export interface PaceSummary {
  /** Audible words over delivery time (§14.1). */
  audibleWpm: Measurement<number>;
  /** Audible words over *voiced* time (§14.1). */
  articulationWpm: Measurement<number>;
  /** Content words over delivery time. */
  contentWpm: Measurement<number>;
  targetLowWpm: number;
  targetHighWpm: number;
  /** Milliseconds whose measured WPM fell inside the target band, inclusive. */
  insideTargetMs: number;
  /** Milliseconds for which a WPM was measured at all. */
  measuredMs: number;
  /** `insideTargetMs / measuredMs`, 0–1. */
  insideTargetRatio: Measurement<number>;
}

function wordsPerMinute(words: number, ms: number): number {
  return words / (ms / 60_000);
}

function summarizePace(
  passes: readonly TakePassRecord[],
  time: TimeAccountingSummary,
  profile: ReviewTargetProfile,
): PaceSummary {
  let audibleWords = 0;
  let contentWords = 0;
  for (const pass of passes) {
    audibleWords += pass.words.audibleWords;
    contentWords += pass.words.contentWords;
  }

  let insideTargetMs = 0;
  let measuredMs = 0;
  for (const pass of passes) {
    for (const sample of pass.paceSamples) {
      const durationMs = Math.max(0, sample.endMs - sample.startMs);
      if (durationMs === 0 || sample.audibleWpm === null) continue;
      measuredMs += durationMs;
      // The band, not the state machine. `on_target` carries §14.7 hysteresis,
      // which exists to stop the tile flickering — it is a display device and
      // it is not what "time inside target pace" means.
      if (
        sample.audibleWpm >= profile.targetWpmLow &&
        sample.audibleWpm <= profile.targetWpmHigh
      ) {
        insideTargetMs += durationMs;
      }
    }
  }

  return {
    audibleWpm:
      time.deliveryMs > 0 && audibleWords > 0
        ? measured(wordsPerMinute(audibleWords, time.deliveryMs))
        : unmeasured(time.deliveryMs > 0 ? 'no_words' : 'no_measured_time'),
    articulationWpm:
      time.voicedMs > 0 && audibleWords > 0
        ? measured(wordsPerMinute(audibleWords, time.voicedMs))
        : unmeasured(time.voicedMs > 0 ? 'no_words' : 'no_voiced_time'),
    contentWpm:
      time.deliveryMs > 0 && contentWords > 0
        ? measured(wordsPerMinute(contentWords, time.deliveryMs))
        : unmeasured(time.deliveryMs > 0 ? 'no_words' : 'no_measured_time'),
    targetLowWpm: profile.targetWpmLow,
    targetHighWpm: profile.targetWpmHigh,
    insideTargetMs,
    measuredMs,
    insideTargetRatio:
      measuredMs > 0 ? measured(insideTargetMs / measuredMs) : unmeasured('no_pace_samples'),
  };
}

/* ---------------------------------------------------------------------------
 * Duration (§14.10, §31.2)
 * ------------------------------------------------------------------------- */

export interface DurationSummary {
  /** Wall of audio the take actually occupied, ms. */
  actualDurationMs: number;
  targetDurationMs: number | null;
  /** Last projection the take produced, ms. */
  projectedTotalMs: Measurement<number>;
  /** `projectedTotalMs - actualDurationMs`. Positive = the projection ran long. */
  projectedMinusActualMs: Measurement<number>;
  /** `actualDurationMs - targetDurationMs`. Positive = the take ran long. */
  actualMinusTargetMs: Measurement<number>;
}

function summarizeDuration(
  passes: readonly TakePassRecord[],
  time: TimeAccountingSummary,
  profile: ReviewTargetProfile,
): DurationSummary {
  // The projection describes the take as a whole; the last pass that produced
  // one is the one that was still on screen when the take ended.
  let projected: number | null = null;
  for (const pass of passes) {
    if (pass.projectedTotalMs !== null) projected = pass.projectedTotalMs;
  }
  const actualDurationMs = time.spanMs;
  const target = profile.targetDurationMs;
  return {
    actualDurationMs,
    targetDurationMs: target,
    projectedTotalMs: projected === null ? unmeasured('no_projection') : measured(projected),
    projectedMinusActualMs:
      projected === null ? unmeasured('no_projection') : measured(projected - actualDurationMs),
    actualMinusTargetMs:
      target === null ? unmeasured('no_target_duration') : measured(actualDurationMs - target),
  };
}

/* ---------------------------------------------------------------------------
 * Fillers (§16.6, §31.2)
 * ------------------------------------------------------------------------- */

/** §16.7 cluster definition: three confirmed fillers inside this window. */
export const FILLER_CLUSTER_WINDOW_MS = 20_000;
export const FILLER_CLUSTER_MIN_EVENTS = 3;

export interface FillerFormCount {
  normalizedForm: string;
  /**
   * Quotable form, or `null` when nothing may be shown back (§25.3). Only
   * `strict_vocalized` events from the fixed lexicon ever carry one.
   */
  displayForm: string | null;
  count: number;
  firstAtMs: number;
}

export interface FillerSummary {
  /** Confirmed, countable fillers (§2.4 excludes openers by kind). */
  confirmedCount: number;
  /** Detected but never confirmed. Reported separately; never added in. */
  probableCount: number;
  /** §16.6 fillers per 100 audible words. */
  perHundredWords: Measurement<number>;
  /** §16.6 fillers per minute of delivery time. */
  perMinute: Measurement<number>;
  strictPerMinute: Measurement<number>;
  contextualPerMinute: Measurement<number>;
  /** Descending by count, then by first occurrence. */
  byForm: readonly FillerFormCount[];
  mostFrequent: Measurement<FillerFormCount>;
  /**
   * §16.6 filler-free speaking streak, in delivery ms. With zero fillers this
   * is the whole take — not `null`, because "you never used one" is a measured
   * result, not a missing one. A streak never spans a take-pass boundary.
   */
  longestFillerFreeMs: Measurement<number>;
  /** §16.7 clusters. */
  clusterCount: number;
  /** §15 disfluencies that are not fillers. Counted, never folded into the total. */
  falseStartCount: number;
  repeatedWordCount: number;
  selfCorrectionCount: number;
  repetitiveOpenerCount: number;
}

function isProbableFiller(event: FillerEvent): boolean {
  if (event.kind !== 'strict_vocalized' && event.kind !== 'contextual') return false;
  if (event.authoredIntentional) return false;
  return event.confidence === 'probable';
}

function countKind(passes: readonly TakePassRecord[], kind: FillerEvent['kind']): number {
  let total = 0;
  for (const pass of passes) {
    for (const event of pass.fillers) {
      if (event.kind === kind && isCountableDisfluency(event)) total += 1;
    }
  }
  return total;
}

/**
 * §16.7. A cluster opens at the third confirmed filler inside
 * {@link FILLER_CLUSTER_WINDOW_MS} and extends while the next filler stays
 * inside the window of the previous one, so a long run of fillers is one
 * cluster rather than a new cluster per event.
 */
export function countFillerClusters(
  events: readonly FillerEvent[],
  windowMs: number = FILLER_CLUSTER_WINDOW_MS,
  minEvents: number = FILLER_CLUSTER_MIN_EVENTS,
): number {
  const times = events.map((event) => event.audioStartMs).sort((a, b) => a - b);
  let clusters = 0;
  let index = 0;
  while (index + minEvents - 1 < times.length) {
    const first = times[index] as number;
    const third = times[index + minEvents - 1] as number;
    if (third - first > windowMs) {
      index += 1;
      continue;
    }
    clusters += 1;
    let end = index + minEvents - 1;
    while (end + 1 < times.length && (times[end + 1] as number) - (times[end] as number) <= windowMs) {
      end += 1;
    }
    index = end + 1;
  }
  return clusters;
}

/**
 * Longest run of delivery time containing no countable filler, measured inside
 * a single pass. Exported so a test can drive it directly.
 */
export function longestFillerFreeMsInPass(pass: TakePassRecord): number {
  const events = pass.fillers
    .filter(isCountableFiller)
    .slice()
    .sort((a, b) => a.audioStartMs - b.audioStartMs);
  let cursor = pass.time.startMs;
  let best = 0;
  for (const event of events) {
    best = Math.max(best, deliveryMsBetween(pass.time, cursor, event.audioStartMs));
    cursor = Math.max(cursor, event.audioEndMs);
  }
  return Math.max(best, deliveryMsBetween(pass.time, cursor, pass.time.endMs));
}

function summarizeFillers(
  passes: readonly TakePassRecord[],
  time: TimeAccountingSummary,
  words: { audibleWords: number },
): FillerSummary {
  const countable: FillerEvent[] = [];
  let probableCount = 0;
  for (const pass of passes) {
    for (const event of pass.fillers) {
      if (isCountableFiller(event)) countable.push(event);
      else if (isProbableFiller(event)) probableCount += 1;
    }
  }

  const byFormMap = new Map<string, FillerFormCount>();
  for (const event of countable) {
    const existing = byFormMap.get(event.normalizedForm);
    if (existing === undefined) {
      byFormMap.set(event.normalizedForm, {
        normalizedForm: event.normalizedForm,
        displayForm: event.displayForm,
        count: 1,
        firstAtMs: event.audioStartMs,
      });
      continue;
    }
    existing.count += 1;
    existing.firstAtMs = Math.min(existing.firstAtMs, event.audioStartMs);
    // A form is quotable if *any* of its events was quotable (§25.3).
    if (existing.displayForm === null) existing.displayForm = event.displayForm;
  }
  const byForm = [...byFormMap.values()].sort(
    (a, b) => b.count - a.count || a.firstAtMs - b.firstAtMs,
  );

  const strictCount = countable.filter((event) => event.kind === 'strict_vocalized').length;
  const contextualCount = countable.filter((event) => event.kind === 'contextual').length;
  const minutes = time.deliveryMs / 60_000;
  const perMinuteOf = (count: number): Measurement<number> =>
    time.deliveryMs > 0 ? measured(count / minutes) : unmeasured('no_measured_time');

  let longestFillerFreeMs: Measurement<number> = unmeasured('no_measured_time');
  if (passes.length > 0 && time.deliveryMs > 0) {
    let best = 0;
    for (const pass of passes) best = Math.max(best, longestFillerFreeMsInPass(pass));
    longestFillerFreeMs = measured(best);
  }

  const top = byForm[0];
  return {
    confirmedCount: countable.length,
    probableCount,
    perHundredWords:
      words.audibleWords > 0
        ? measured((countable.length / words.audibleWords) * 100)
        : unmeasured('no_words'),
    perMinute: perMinuteOf(countable.length),
    strictPerMinute: perMinuteOf(strictCount),
    contextualPerMinute: perMinuteOf(contextualCount),
    byForm,
    mostFrequent: top === undefined ? unmeasured('no_fillers') : measured(top),
    longestFillerFreeMs,
    clusterCount: countFillerClusters(countable),
    falseStartCount: countKind(passes, 'false_start'),
    repeatedWordCount: countKind(passes, 'repeated_word'),
    selfCorrectionCount: countKind(passes, 'self_correction'),
    repetitiveOpenerCount: passes.reduce(
      (total, pass) =>
        total +
        pass.fillers.filter(
          (event) =>
            event.kind === 'repetitive_opener' &&
            event.confidence === 'confirmed' &&
            !event.authoredIntentional,
        ).length,
      0,
    ),
  };
}

/* ---------------------------------------------------------------------------
 * Variety (§17, §31.2)
 * ------------------------------------------------------------------------- */

export interface VarietySummary {
  /** Duration-weighted mean 0–100 level over samples that had one. */
  averageLevel: Measurement<number>;
  /** Observed min and max level. */
  range: Measurement<{ low: number; high: number }>;
  targetLow: number;
  targetHigh: number;
  measuredMs: number;
  insideTargetMs: number;
  insideTargetRatio: Measurement<number>;
  /**
   * §17.5. When pitch was never usable the review MAY show an explicitly
   * labelled energy-only observation — and only in review. It is a dB range,
   * not a 0–100 score, precisely so it cannot be mistaken for one.
   */
  energyFallbackRangeDb: Measurement<{ meanDb: number; lowDb: number; highDb: number }>;
}

function summarizeVariety(
  passes: readonly TakePassRecord[],
  profile: ReviewTargetProfile,
): VarietySummary {
  let weighted = 0;
  let measuredMs = 0;
  let insideTargetMs = 0;
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  let sampleCount = 0;

  let energyWeighted = 0;
  let energyMs = 0;
  let energyLow = Number.POSITIVE_INFINITY;
  let energyHigh = Number.NEGATIVE_INFINITY;

  for (const pass of passes) {
    for (const sample of pass.varietySamples) {
      sampleCount += 1;
      const durationMs = Math.max(0, sample.endMs - sample.startMs);
      if (durationMs === 0) continue;
      if (sample.energyRangeDb !== null) {
        energyWeighted += sample.energyRangeDb * durationMs;
        energyMs += durationMs;
        energyLow = Math.min(energyLow, sample.energyRangeDb);
        energyHigh = Math.max(energyHigh, sample.energyRangeDb);
      }
      if (sample.level === null) continue;
      weighted += sample.level * durationMs;
      measuredMs += durationMs;
      low = Math.min(low, sample.level);
      high = Math.max(high, sample.level);
      if (sample.level >= profile.targetVarietyLow && sample.level <= profile.targetVarietyHigh) {
        insideTargetMs += durationMs;
      }
    }
  }

  const absent: AbsenceReason = sampleCount === 0 ? 'no_variety_samples' : 'pitch_unusable';
  const hasLevel = measuredMs > 0;
  return {
    averageLevel: hasLevel ? measured(weighted / measuredMs) : unmeasured(absent),
    range: hasLevel ? measured({ low, high }) : unmeasured(absent),
    targetLow: profile.targetVarietyLow,
    targetHigh: profile.targetVarietyHigh,
    measuredMs,
    insideTargetMs,
    insideTargetRatio: hasLevel ? measured(insideTargetMs / measuredMs) : unmeasured(absent),
    // Only offered when there is no real variety level to show; otherwise it
    // would read as a second, competing score.
    energyFallbackRangeDb:
      !hasLevel && energyMs > 0
        ? measured({ meanDb: energyWeighted / energyMs, lowDb: energyLow, highDb: energyHigh })
        : unmeasured(hasLevel ? 'metric_not_comparable' : 'no_energy_data'),
  };
}

/* ---------------------------------------------------------------------------
 * Cadence (§18, §31.2)
 * ------------------------------------------------------------------------- */

export type PauseClassCounts = Record<PauseClass, number>;

export interface CadenceSummary {
  runOnCount: number;
  choppyPauseCount: number;
  longestBreathGroupMs: number;
  /** §18.3 eligible boundaries are the strong and paragraph ones. */
  eligibleBoundaries: number;
  shapedBoundaries: number;
  shapedBoundaryRatio: Measurement<number>;
  /** §14.9 sentence endings whose rush ratio cleared the threshold. */
  terminalRushCount: number;
  terminalRushEligibleSentences: number;
  terminalRushRatio: Measurement<number>;
  pauseCounts: PauseClassCounts;
}

function emptyPauseCounts(): PauseClassCounts {
  return { sub_threshold: 0, micro: 0, short: 0, medium: 0, long: 0, excluded: 0 };
}

function summarizeCadence(
  passes: readonly TakePassRecord[],
  profile: ReviewTargetProfile,
  thresholds: PauseThresholds,
): CadenceSummary {
  let runOnCount = 0;
  let choppyPauseCount = 0;
  let longestBreathGroupMs = 0;
  let eligibleBoundaries = 0;
  let shapedBoundaries = 0;
  let terminalRushCount = 0;
  let terminalRushEligibleSentences = 0;
  const pauseCounts = emptyPauseCounts();

  for (const pass of passes) {
    runOnCount += pass.cadence.runOnCount;
    choppyPauseCount += pass.cadence.choppyPauseCount;
    longestBreathGroupMs = Math.max(longestBreathGroupMs, pass.cadence.longestBreathGroupMs);

    for (const boundary of pass.boundaries) {
      if (boundary.strength !== 'strong' && boundary.strength !== 'paragraph') continue;
      eligibleBoundaries += 1;
      if (boundary.shaped) shapedBoundaries += 1;
    }

    for (const sentence of pass.terminalRushSentences) {
      if (!sentence.measurable || sentence.ratio === null) continue;
      terminalRushEligibleSentences += 1;
      if (sentence.ratio >= profile.terminalRushRatioThreshold) terminalRushCount += 1;
    }

    for (const pause of pass.pauses) {
      const durationMs = Math.max(0, pause.endMs - pause.startMs);
      const cls = pause.manual === true ? 'excluded' : classifyPause(durationMs, thresholds);
      pauseCounts[cls] += 1;
    }
  }

  return {
    runOnCount,
    choppyPauseCount,
    longestBreathGroupMs,
    eligibleBoundaries,
    shapedBoundaries,
    shapedBoundaryRatio:
      eligibleBoundaries > 0
        ? measured(shapedBoundaries / eligibleBoundaries)
        : unmeasured('no_eligible_boundaries'),
    terminalRushCount,
    terminalRushEligibleSentences,
    terminalRushRatio:
      terminalRushEligibleSentences > 0
        ? measured(terminalRushCount / terminalRushEligibleSentences)
        : unmeasured('no_eligible_sentences'),
    pauseCounts,
  };
}

/* ---------------------------------------------------------------------------
 * Script fidelity (§21, §31.2)
 * ------------------------------------------------------------------------- */

export interface FidelitySummary {
  /** Discrepancies that stood. Self-corrected ones are excluded from the count. */
  criticalDiscrepancyCount: number;
  selfCorrectedCount: number;
  byKind: Record<CriticalFindingRecord['kind'], number>;
  /** Every finding, self-corrected included, in time order. */
  findings: readonly CriticalFindingRecord[];
}

function summarizeFidelity(passes: readonly TakePassRecord[]): FidelitySummary {
  const byKind: Record<CriticalFindingRecord['kind'], number> = {
    critical_number_mismatch: 0,
    critical_name_mismatch: 0,
    critical_unit_mismatch: 0,
    critical_negation_mismatch: 0,
    material_meaning_change: 0,
  };
  const findings: CriticalFindingRecord[] = [];
  let selfCorrectedCount = 0;
  for (const pass of passes) {
    for (const finding of pass.criticalFindings) {
      findings.push(finding);
      if (finding.selfCorrected) {
        selfCorrectedCount += 1;
        continue;
      }
      byKind[finding.kind] += 1;
    }
  }
  findings.sort((a, b) => a.atMs - b.atMs);
  const criticalDiscrepancyCount = findings.length - selfCorrectedCount;
  return { criticalDiscrepancyCount, selfCorrectedCount, byKind, findings };
}

/* ---------------------------------------------------------------------------
 * Microphone (§12.7, §31.2)
 * ------------------------------------------------------------------------- */

export interface MicrophoneSummary {
  dominantStatus: Measurement<MicrophoneStatus>;
  msByStatus: Partial<Record<MicrophoneStatus, number>>;
  /** Sustained problem conditions, worst first by total time. */
  sustainedIssues: ReadonlyArray<{ status: MicrophoneStatus; totalMs: number; episodes: number }>;
  /** Median rolling level, dBFS (negative). There is no SPL claim (§12.7.4). */
  medianLevelDbfs: Measurement<number>;
  medianSnrDb: Measurement<number>;
  transcriptionDegradedMs: number;
  /** True when one status held for at least 95% of the observed time. */
  consistent: Measurement<boolean>;
}

const HEALTHY_MIC_STATUSES: ReadonlySet<MicrophoneStatus> = new Set<MicrophoneStatus>([
  'ok',
  'learning',
]);

export function summarizeMicrophone(record: MicrophoneSessionRecord): MicrophoneSummary {
  const msByStatus: Partial<Record<MicrophoneStatus, number>> = {};
  const issueMs = new Map<MicrophoneStatus, { totalMs: number; episodes: number }>();
  let observedMs = 0;
  for (const span of record.spans) {
    const durationMs = Math.max(0, span.endMs - span.startMs);
    if (durationMs === 0) continue;
    observedMs += durationMs;
    msByStatus[span.status] = (msByStatus[span.status] ?? 0) + durationMs;
    if (span.sustained && !HEALTHY_MIC_STATUSES.has(span.status)) {
      const entry = issueMs.get(span.status) ?? { totalMs: 0, episodes: 0 };
      entry.totalMs += durationMs;
      entry.episodes += 1;
      issueMs.set(span.status, entry);
    }
  }

  let dominant: MicrophoneStatus | null = null;
  let dominantMs = 0;
  for (const [status, ms] of Object.entries(msByStatus) as Array<[MicrophoneStatus, number]>) {
    if (ms > dominantMs) {
      dominant = status;
      dominantMs = ms;
    }
  }

  const levels = record.levelSamples.map((sample) => sample.levelDbfs);
  const snrs = record.levelSamples
    .map((sample) => sample.snrDb)
    .filter((value): value is number => value !== null);
  const medianLevel = median(levels);
  const medianSnr = median(snrs);

  return {
    dominantStatus: dominant === null ? unmeasured('no_microphone_data') : measured(dominant),
    msByStatus,
    sustainedIssues: [...issueMs.entries()]
      .map(([status, entry]) => ({ status, ...entry }))
      .sort((a, b) => b.totalMs - a.totalMs),
    medianLevelDbfs: medianLevel === null ? unmeasured('no_microphone_data') : measured(medianLevel),
    medianSnrDb: medianSnr === null ? unmeasured('no_microphone_data') : measured(medianSnr),
    transcriptionDegradedMs: record.transcriptionDegradedMs,
    consistent:
      observedMs > 0 ? measured(dominantMs / observedMs >= 0.95) : unmeasured('no_microphone_data'),
  };
}

/* ---------------------------------------------------------------------------
 * The summary
 * ------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
 * Delivery score (Speaking Score report §9, §11.2)
 * ------------------------------------------------------------------------- */

/**
 * One dimension of the delivery score, as the review states it.
 *
 * `score` is a {@link Measurement} rather than a bare number because §9.4 is
 * explicit that a dimension with too small a confidence-weighted denominator is
 * *unavailable*, not zero — a speaker who has not yet produced enough voiced
 * audio to judge their emphasis has not thereby failed at emphasis. Rendering
 * that as `0/14` would be the review inventing a failure.
 */
export interface DeliveryDimensionSummary {
  dimension: DeliveryDimension;
  score: Measurement<number>;
  /** Points this dimension can contribute out of 100 (§9.5). */
  weight: number;
  /** 0–1 evidence confidence for this dimension. */
  confidence: number;
}

/**
 * The delivery score for a set of passes.
 *
 * §11.2 forbids this breakdown *live* and places it here instead, so this is
 * the only surface in the product that shows seven dimension scores.
 *
 * Three absences are kept apart, because collapsing them is how a review starts
 * lying: `not_scored` (the take was never scored), `score_never_left_warm_up`
 * (it was scored, and never gathered enough evidence to state a figure) and a
 * per-dimension `dimension_unavailable`. None of them is a zero.
 */
export interface DeliveryScoreSummary {
  /** The smoothed 0–100 figure the presenter was actually shown. */
  displayScore: Measurement<number>;
  /**
   * The unsmoothed figure the engine computed. Carried so §11.3's rate cap and
   * smoothing can be *audited* rather than trusted — the contract's own reason
   * for exposing it. Never shown beside `displayScore` as a competing number.
   */
  rawScore: Measurement<number>;
  /** §9.7 trust ladder, as a tier. Never rendered as a second large number. */
  tier: DeliveryScoreConfidenceTier | null;
  /** Always seven entries, in {@link DELIVERY_SCORE_WEIGHTS} order. */
  dimensions: readonly DeliveryDimensionSummary[];
  /**
   * §9.6. The dimension dragging the score down hardest. Carried for the
   * recommendation lane to reach for; it is not display copy.
   */
  weakestDimension: DeliveryDimension | null;
  /**
   * Which pass this score came from, or `null` when none was scored. An
   * aggregate over several passes reports the *latest scored pass* rather than
   * averaging two performances into a figure neither of them earned.
   */
  sourcePassOrdinal: number | null;
}

/** The seven dimensions with no evidence behind any of them. */
function unscoredDimensions(reason: AbsenceReason): DeliveryDimensionSummary[] {
  return (Object.keys(DELIVERY_SCORE_WEIGHTS) as DeliveryDimension[]).map((dimension) => ({
    dimension,
    score: unmeasured<number>(reason),
    weight: DELIVERY_SCORE_WEIGHTS[dimension],
    confidence: 0,
  }));
}

/**
 * §9, §11.2. The score for an explicit set of passes.
 *
 * Passes are separate performances (§11.3), so nothing is averaged across them.
 * The latest pass that carries a score is the one reported, and it says which
 * pass that was.
 */
export function summarizeDeliveryScore(
  passes: readonly TakePassRecord[],
): DeliveryScoreSummary {
  const scored = [...passes]
    .sort((a, b) => a.passOrdinal - b.passOrdinal)
    .filter((pass) => pass.deliveryScore !== null);
  const latest = scored[scored.length - 1];

  if (latest === undefined) {
    return {
      displayScore: unmeasured<number>('not_scored'),
      rawScore: unmeasured<number>('not_scored'),
      tier: null,
      dimensions: unscoredDimensions('not_scored'),
      weakestDimension: null,
      sourcePassOrdinal: null,
    };
  }

  const score = latest.deliveryScore!;
  const byDimension = new Map(score.dimensions.map((entry) => [entry.dimension, entry]));
  const dimensions = (Object.keys(DELIVERY_SCORE_WEIGHTS) as DeliveryDimension[]).map(
    (dimension) => {
      const entry = byDimension.get(dimension);
      return {
        dimension,
        score:
          entry === undefined || entry.score === null
            ? unmeasured<number>('dimension_unavailable')
            : measured(Math.round(entry.score)),
        // The weight is the contract's, never the producer's: a record written
        // by an older algorithm cannot restate what a dimension is worth today.
        weight: DELIVERY_SCORE_WEIGHTS[dimension],
        confidence: entry?.confidence ?? 0,
      } satisfies DeliveryDimensionSummary;
    },
  );

  return {
    displayScore:
      score.displayScore === null
        ? unmeasured<number>('score_never_left_warm_up')
        : measured(Math.round(score.displayScore)),
    rawScore:
      score.rawScore === null
        ? unmeasured<number>('score_never_left_warm_up')
        : measured(Math.round(score.rawScore)),
    tier: score.tier,
    dimensions,
    weakestDimension: score.weakestDimension,
    sourcePassOrdinal: latest.passOrdinal,
  };
}

export interface TipsShownSummary {
  total: number;
  /** Descending by count, then alphabetical, so the order is deterministic. */
  byCode: ReadonlyArray<{ code: string; count: number }>;
}

/** Everything computed over one explicit set of passes. */
export interface TakeMetrics {
  time: TimeAccountingSummary;
  words: { audibleWords: number; contentWords: number };
  pace: PaceSummary;
  duration: DurationSummary;
  fillers: FillerSummary;
  variety: VarietySummary;
  cadence: CadenceSummary;
  fidelity: FidelitySummary;
  tips: TipsShownSummary;
  /** §11.2's forbidden-live breakdown, in the one place it belongs. */
  deliveryScore: DeliveryScoreSummary;
}

export interface PassSummary {
  takePassId: string;
  passOrdinal: number;
  metrics: TakeMetrics;
}

export interface SessionSummary {
  schemaVersion: number;
  sessionId: string;
  scriptId: string;
  scriptRevision: number;
  startedAtIso: string;
  endedAtIso: string | null;
  versions: CoachingSessionRecord['versions'];
  profile: ReviewTargetProfile;
  takePassCount: number;
  /** §31.2 retake count: every pass after the first is a retake. */
  retakeCount: number;
  /** Aggregate over every pass. */
  metrics: TakeMetrics;
  /** Per pass, so §11.3 is visible rather than averaged away. */
  passes: readonly PassSummary[];
  microphone: MicrophoneSummary;
  /** True when a transcript was retained under §32.2 consent. */
  transcriptAvailable: boolean;
  audio: CoachingSessionRecord['audio'];
}

export interface SummaryOptions {
  pauseThresholds?: PauseThresholds;
}

function summarizeTips(passes: readonly TakePassRecord[]): TipsShownSummary {
  const counts = new Map<string, number>();
  let total = 0;
  for (const pass of passes) {
    for (const tip of pass.tipsShown) {
      total += 1;
      counts.set(tip.code, (counts.get(tip.code) ?? 0) + 1);
    }
  }
  return {
    total,
    byCode: [...counts.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
  };
}

/** Compute every metric over an explicit set of passes (§11.3). */
export function computeTakeMetrics(
  passes: readonly TakePassRecord[],
  profile: ReviewTargetProfile,
  options: SummaryOptions = {},
): TakeMetrics {
  const time = summarizeTime(passes);
  const words = passes.reduce(
    (total, pass) => ({
      audibleWords: total.audibleWords + pass.words.audibleWords,
      contentWords: total.contentWords + pass.words.contentWords,
    }),
    { audibleWords: 0, contentWords: 0 },
  );
  return {
    time,
    words,
    pace: summarizePace(passes, time, profile),
    duration: summarizeDuration(passes, time, profile),
    fillers: summarizeFillers(passes, time, words),
    variety: summarizeVariety(passes, profile),
    cadence: summarizeCadence(passes, profile, options.pauseThresholds ?? DEFAULT_PAUSE_THRESHOLDS),
    fidelity: summarizeFidelity(passes),
    tips: summarizeTips(passes),
    deliveryScore: summarizeDeliveryScore(passes),
  };
}

/**
 * §31.2. The whole summary for one recorded session.
 *
 * `profile` and `versions` are re-projected field by field rather than passed
 * through. The summary is what gets persisted (§36.2 `summary_json`), and
 * §32.3 forbids storing inferred labels — an allowlist here means a producer
 * that starts hanging extra properties off the profile cannot leak them into
 * storage by accident.
 */
export function summarizeSession(
  record: CoachingSessionRecord,
  options: SummaryOptions = {},
): SessionSummary {
  const passes = [...record.passes].sort((a, b) => a.passOrdinal - b.passOrdinal);
  return {
    schemaVersion: record.schemaVersion,
    sessionId: record.sessionId,
    scriptId: record.scriptId,
    scriptRevision: record.scriptRevision,
    startedAtIso: record.startedAtIso,
    endedAtIso: record.endedAtIso,
    versions: {
      coachingSchemaVersion: record.versions.coachingSchemaVersion,
      algorithmVersion: record.versions.algorithmVersion,
      tipPolicyVersion: record.versions.tipPolicyVersion,
      lunaPromptVersion: record.versions.lunaPromptVersion,
      transcriptionModels: [...record.versions.transcriptionModels],
      precisionTranscriptionActive: record.versions.precisionTranscriptionActive,
    },
    profile: {
      deliveryStyle: record.profile.deliveryStyle,
      targetWpmLow: record.profile.targetWpmLow,
      targetWpmHigh: record.profile.targetWpmHigh,
      targetVarietyLow: record.profile.targetVarietyLow,
      targetVarietyHigh: record.profile.targetVarietyHigh,
      targetDurationMs: record.profile.targetDurationMs,
      terminalRushRatioThreshold: record.profile.terminalRushRatioThreshold,
    },
    takePassCount: passes.length,
    retakeCount: Math.max(0, passes.length - 1),
    metrics: computeTakeMetrics(passes, record.profile, options),
    passes: passes.map((pass) => ({
      takePassId: pass.takePassId,
      passOrdinal: pass.passOrdinal,
      metrics: computeTakeMetrics([pass], record.profile, options),
    })),
    microphone: summarizeMicrophone(record.microphone),
    transcriptAvailable: passes.some((pass) => pass.transcript !== null),
    audio: record.audio,
  };
}
