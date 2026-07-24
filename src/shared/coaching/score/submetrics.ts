/**
 * Speaking Score report §9.5 — the seven dimensions and their submetric
 * weights — mapped onto the measurements this tree actually produces.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS MISSING AND WHY IT IS MISSING RATHER THAN MADE UP
 * ---------------------------------------------------------------------------
 * §9.5 lists 24 submetrics. Twelve of them have a producer in this tree. The
 * other twelve are declared here anyway, with `score: null`, `confidence: 0`
 * and `sourceable: false`, because a missing submetric that is *visible* is a
 * piece of work someone can pick up, while a missing submetric replaced by a
 * neutral 100 is a number moving on the presenter's rail for a reason that does
 * not exist. {@link UNSOURCED_SUBMETRICS} names each one and the producer it
 * would need.
 *
 * Three whole dimensions — emphasis, clarity and consistency — have no
 * sourceable submetric at all and are therefore always `null`. That is not a
 * placeholder or a bug: emphasis needs a script salience map plus word-level
 * alignment (the `EmphasisAnalyzer` exists but nothing feeds it spans),
 * clarity's only near-ready input is ASR confidence which §16.3 forbids using
 * without a personal baseline, and consistency needs phrase-final energy and
 * terminal-contour analysis that no aggregator computes.
 *
 * ---------------------------------------------------------------------------
 * FAIRNESS (§1.3, §16.1)
 * ---------------------------------------------------------------------------
 * Nothing in this file reads an absolute pitch in hertz. `PitchAggregate`
 * reports semitones relative to the speaker's own rolling median and that is
 * the only pitch quantity used, so two speakers with the same relative contour
 * an octave apart score identically. Nothing reads absolute loudness either —
 * `EnergyAggregate.rangeDb` is a range, not a level (§12.7.4).
 *
 * Nothing reads recording quality. `MicrophoneCoachState` is not an argument to
 * any function here; it reaches the model only through `confidence.ts` (§15).
 */
import type { DeliveryDimension, FillerEvent, FillerKind } from '../../contracts/coaching';
import { DEFAULT_CADENCE_PROFILE } from '../prosody/cadence-analyzer';
import { percentile } from '../prosody/stats';
import { bandScore, type TargetBand } from './band';
import { ramp } from './confidence';
import type { DeliveryEvidence, ScoredPause } from './evidence';
import type { DeliveryScoreOptions, DeliveryTargetProfile } from './profile';
import type { SubmetricSample } from './dimension';

/**
 * The §9.5 submetrics with no producer in this build, and what each would need.
 *
 * Exported so a test can assert the list has not silently grown, and so the
 * gap is documented in code rather than in a commit message.
 */
export const UNSOURCED_SUBMETRICS: Readonly<
  Record<string, { readonly points: number; readonly needs: string }>
> = {
  'pace.articulation_rate': {
    points: 4,
    needs:
      'A syllable-nucleus detector (§7.5). The pace lane produces an articulation rate in words ' +
      'over voiced time, but §8 states the target in syllables per second and converting between ' +
      'them needs a syllables-per-word model that varies with vocabulary and language — which ' +
      'would penalise a speaker for using long words.',
  },
  'variety.contour_diversity': {
    points: 4,
    needs:
      'Per-phrase contour classification (rise / fall / arch / level, §6.3). The pitch aggregator ' +
      'counts contour *turns* but does not classify shapes, and §8 publishes no band for turn rate.',
  },
  'variety.phrase_pitch_resets': {
    points: 2,
    needs:
      'Phrase-initial pitch relative to the previous phrase endpoint (§6.3). The pitch aggregator ' +
      'tracks phrase-*final* movement only.',
  },
  'emphasis.keyword_alignment': {
    points: 6,
    needs:
      'A script salience map plus word-level alignment, feeding EmphasisSpans to the existing ' +
      'EmphasisAnalyzer. The analyzer is built and tested; nothing constructs its input.',
  },
  'emphasis.selectivity': {
    points: 3,
    needs: 'Prominence marking over content words (§6.6), which depends on the same salience map.',
  },
  'emphasis.key_line_landing': {
    points: 3,
    needs: 'Author-marked key lines plus post-line pause and terminal-contour measurement (§6.6).',
  },
  'emphasis.rhetorical_shaping': {
    points: 2,
    needs: 'Paragraph, list and rule-of-three structure from the script compiler (§6.6).',
  },
  'fluency.script_repairs': {
    points: 3,
    needs:
      'A final-take mode flag plus a script deviation *rate*. The fidelity lane reports critical ' +
      'meaning mismatches, which is a different and much rarer event than a repair.',
  },
  'clarity.asr_stability': {
    points: 4,
    needs:
      'A personal ASR baseline (Appendix A `require_personal_baseline: true`) and the §16.3 ' +
      'exclusions for names and domain terms. Scoring raw recogniser confidence without them ' +
      'penalises accent and dialect, which §1.3 forbids outright — so this is deliberately ' +
      'withheld rather than merely unbuilt.',
  },
  'clarity.articulation_problems': {
    points: 2,
    needs: 'A spectro-temporal articulation proxy (§6.7), personalized per speaker.',
  },
  'clarity.breath_control': {
    points: 3,
    needs:
      'Phrase-final energy drop (§6.4 "final 0.5–0.9 s relative to phrase median"). The energy ' +
      'aggregator computes between-phrase contrast, which is a different statistic.',
  },
  'consistency.sentence_final_control': {
    points: 3,
    needs:
      'Phrase-final energy drop plus terminal-contour *repetition*. Scoring the available ' +
      'phrase-final pitch movement on its own would penalise dialectal high-rising terminals, ' +
      'which §1.3 and §8.2 both refuse (§8.2 makes coaching it a user setting).',
  },
  'consistency.sustained_stability': {
    points: 2,
    needs:
      'Minutes-scale rate, energy and variety drift plus a recovery detector (§6.8). The 30 s ' +
      'drift window used by pace is a different measurement at a different horizon.',
  },
};

function unsourced(id: string): SubmetricSample {
  const entry = UNSOURCED_SUBMETRICS[id];
  return {
    id,
    weight: entry?.points ?? 0,
    score: null,
    confidence: 0,
    sourceable: false,
  };
}

/** A sourceable submetric that has no measurement *this pass*. */
function unmeasured(id: string, weight: number): SubmetricSample {
  return { id, weight, score: null, confidence: 0 };
}

function measured(
  id: string,
  weight: number,
  value: number | null,
  band: TargetBand,
  confidence: number,
): SubmetricSample {
  if (value === null || confidence <= 0) return unmeasured(id, weight);
  const score = bandScore(value, band);
  if (score === null) return unmeasured(id, weight);
  return { id, weight, score, confidence: Math.min(1, Math.max(0, confidence)) };
}

/** Engine-held state the pure submetric builders need. */
export interface DeliveryScoreMemory {
  /** Words inside the analysis window, from the transcript ledger. */
  readonly wordsInWindow: number;
  /** §9.7 transcript stability, 0–1. */
  readonly transcriptStability: number;
  /** §8 pace drift as a fraction of the window median, or `null`. */
  readonly paceDrift: number | null;
  /** Audio-time span the drift samples cover, ms. */
  readonly driftSpanMs: number;
  /** How long the terminal-rush ratio has stood unchanged, ms, or `null`. */
  readonly terminalRushAgeMs: number | null;
}

/* -------------------------------------------------------------------------- */
/* Window helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The longest uninterrupted speech run inside the window, ms.
 *
 * Derived from the pause list rather than from `CadenceMetrics`: that lane's
 * `longestBreathGroupMs` is a take-level maximum that never decreases, so one
 * breathless sentence in the first minute would hold the live score down for
 * the rest of the take — a permanent dent for a fault the speaker has since
 * fixed, which is the opposite of what a live instrument is for.
 *
 * The run touching either edge of the window is truncated by it, so this can
 * under-report and never over-report. That is the safe direction for a
 * lower-is-better metric.
 */
export function longestRunMsInWindow(
  pauses: readonly ScoredPause[],
  windowStartMs: number,
  nowMs: number,
): number {
  const sorted = pauses
    .filter((pause) => pause.endMs > windowStartMs && pause.startMs < nowMs)
    .slice()
    .sort((a, b) => a.startMs - b.startMs);
  let longest = 0;
  let cursor = windowStartMs;
  for (const pause of sorted) {
    const start = Math.max(pause.startMs, windowStartMs);
    if (start > cursor) longest = Math.max(longest, start - cursor);
    cursor = Math.max(cursor, Math.min(pause.endMs, nowMs));
  }
  if (nowMs > cursor) longest = Math.max(longest, nowMs - cursor);
  return longest;
}

/** P90 of the pause durations inside the window, ms, or `null`. */
export function pauseDurationP90(
  pauses: readonly ScoredPause[],
  windowStartMs: number,
  nowMs: number,
  minimumSamples: number,
): number | null {
  const durations = pauses
    .filter((pause) => pause.endMs > windowStartMs && pause.startMs < nowMs)
    .map((pause) => pause.endMs - pause.startMs)
    .filter((duration) => duration > 0);
  if (durations.length < minimumSamples) return null;
  return percentile(durations, 0.9);
}

const FILLED_PAUSE_KINDS: ReadonlySet<FillerKind> = new Set<FillerKind>(['strict_vocalized']);
const REPETITION_KINDS: ReadonlySet<FillerKind> = new Set<FillerKind>([
  'repeated_word',
  'false_start',
  'self_correction',
]);
const DISCOURSE_TIC_KINDS: ReadonlySet<FillerKind> = new Set<FillerKind>([
  'contextual',
  'repetitive_opener',
]);

/**
 * Count confirmed events of the given kinds inside the window.
 *
 * `confirmed` only — §16.5's ladder puts a provisional-tail hit at `probable`
 * and no higher, so §9.8's "provisional transcript evidence receives a low
 * confidence" is already enforced upstream and re-counting probables here would
 * undo it. `authoredIntentional` events are excluded because the script asked
 * for them (§15).
 *
 * Recomputed from the live event list on every pass rather than accumulated.
 * That is what makes a retraction free: an event demoted to `rejected` simply
 * stops being counted, and the dent it made heals. An internal counter would
 * have to be un-incremented, which is where the §9.8 "permanent dent" bug
 * lives.
 */
export function countConfirmed(
  events: readonly FillerEvent[],
  kinds: ReadonlySet<FillerKind>,
  takePassId: string,
  windowStartMs: number,
  nowMs: number,
): number {
  let count = 0;
  for (const event of events) {
    if (event.takePassId !== takePassId) continue;
    if (event.confidence !== 'confirmed') continue;
    if (event.authoredIntentional) continue;
    if (!kinds.has(event.kind)) continue;
    if (event.audioEndMs < windowStartMs || event.audioStartMs > nowMs) continue;
    count += 1;
  }
  return count;
}

/* -------------------------------------------------------------------------- */
/* The seven dimensions (§9.5)                                                */
/* -------------------------------------------------------------------------- */

/** Pace and tempo control — 18 points. */
function paceSubmetrics(
  evidence: DeliveryEvidence,
  memory: DeliveryScoreMemory,
  options: DeliveryScoreOptions,
  profile: DeliveryTargetProfile,
): SubmetricSample[] {
  const windowStartMs = evidence.audioTimeMs - options.windowMs;
  const windowFill = ramp(evidence.deliveryMsInWindow, options.minimumWindowDeliveryMs, options.windowMs);

  // §8.2 / §14.6: the user's own band wins over the preset. It arrives on the
  // pace tile already resolved, so scoring against anything else here would
  // silently ignore a setting the presenter changed on purpose.
  const wpmBand: TargetBand = {
    low: evidence.pace.targetLowWpm,
    high: evidence.pace.targetHighWpm,
    sigmaLow: profile.wpm.sigmaLow,
    sigmaHigh: profile.wpm.sigmaHigh,
  };
  const rateUsable = !evidence.suppressed && evidence.pace.state !== 'paused';
  const wpm = measured(
    'pace.wpm',
    6,
    rateUsable ? evidence.rates.audibleWpm : null,
    wpmBand,
    evidence.pace.confidence,
  );

  const drift = measured(
    'pace.drift',
    4,
    evidence.suppressed ? null : memory.paceDrift,
    profile.paceDrift,
    ramp(memory.driftSpanMs, options.windowMs / 2, options.windowMs),
  );

  const runLength = measured(
    'pace.run_length',
    2,
    evidence.suppressed ? null : longestRunMsInWindow(evidence.pauses, windowStartMs, evidence.audioTimeMs),
    profile.runLengthMs,
    windowFill,
  );

  // §14.9's ratio is `final / earlier`, so the acceleration is `ratio - 1`.
  // A single sentence is thin evidence and it goes stale: the confidence decays
  // to nothing once no eligible sentence has been measured for a minute, rather
  // than a ratio from five minutes ago quietly holding the dimension down.
  const rushAge = memory.terminalRushAgeMs;
  const rushConfidence =
    evidence.terminalRushRatio === null || rushAge === null
      ? 0
      : options.terminalRushConfidence * (1 - ramp(rushAge, 0, options.terminalRushStalenessMs));
  const ending = measured(
    'pace.ending_acceleration',
    2,
    evidence.terminalRushRatio === null ? null : evidence.terminalRushRatio - 1,
    profile.endingAcceleration,
    rushConfidence,
  );

  return [wpm, unsourced('pace.articulation_rate'), drift, runLength, ending];
}

/** Pausing and phrasing — 18 points. */
function pausingSubmetrics(
  evidence: DeliveryEvidence,
  _memory: DeliveryScoreMemory,
  options: DeliveryScoreOptions,
  profile: DeliveryTargetProfile,
): SubmetricSample[] {
  const windowStartMs = evidence.audioTimeMs - options.windowMs;
  const windowFill = ramp(evidence.deliveryMsInWindow, options.minimumWindowDeliveryMs, options.windowMs);

  const deliveryMs = evidence.deliveryMsInWindow;
  const ratio =
    evidence.suppressed || deliveryMs <= 0
      ? null
      : Math.min(1, Math.max(0, 1 - evidence.voicedMsInWindow / deliveryMs));
  const amount = measured('pausing.amount', 4, ratio, profile.pauseRatio, windowFill);

  const distribution = measured(
    'pausing.distribution',
    4,
    pauseDurationP90(evidence.pauses, windowStartMs, evidence.audioTimeMs, options.minimumPauseSamples),
    profile.longPauseMs,
    windowFill,
  );

  // §18.5 / Appendix A `minimum_alignment_confidence`. Both of the remaining
  // submetrics are script-relative, and both are *silently perfect* when the
  // alignment is not trustworthy: with no located boundaries the shaped ratio
  // is undefined and the mid-clause interruption count is structurally zero,
  // which would read as flawless phrasing. Gating on alignment confidence is
  // what stops "we cannot see it" from scoring 100.
  const alignmentTrusted = evidence.alignmentConfidence >= options.minimumAlignmentConfidence;
  const eligible = evidence.cadence.eligibleBoundaries;
  const placementConfidence =
    alignmentTrusted && eligible >= options.minimumEligibleBoundaries
      ? Math.min(1, eligible / (options.minimumEligibleBoundaries * 2)) * evidence.alignmentConfidence
      : 0;
  const placement = measured(
    'pausing.boundary_placement',
    6,
    eligible > 0 ? evidence.cadence.shapedBoundaries / eligible : null,
    profile.boundaryShaping,
    placementConfidence,
  );

  const choppyPerMinute =
    (evidence.cadence.choppyPauseCount * 60_000) / DEFAULT_CADENCE_PROFILE.choppyWindowMs;
  const choppy = measured(
    'pausing.choppy_balance',
    4,
    alignmentTrusted ? choppyPerMinute : null,
    profile.choppyPerMinute,
    alignmentTrusted ? windowFill * evidence.alignmentConfidence : 0,
  );

  return [amount, distribution, placement, choppy];
}

/** Vocal variety — 18 points. */
function varietySubmetrics(
  evidence: DeliveryEvidence,
  _memory: DeliveryScoreMemory,
  options: DeliveryScoreOptions,
  profile: DeliveryTargetProfile,
): SubmetricSample[] {
  // §13.4 is the gate on whether a pitch number may exist at all.
  const pitchConfidence = evidence.pitchReliability.usable
    ? ramp(evidence.pitch.coveredMs, 0, options.minimumPitchVoicedMs)
    : 0;

  const pitchRange = measured(
    'variety.pitch_range',
    5,
    evidence.pitch.spanSemitones,
    profile.pitchSpanSemitones,
    pitchConfidence,
  );

  // §6.3 "Pitch dispersion — detects flatness". A genuinely different statistic
  // from the P90–P10 span above: the span catches occasional excursions, the
  // IQR catches whether the *bulk* of the delivery moved. Scored as a floor
  // only, so a wide range is not penalised twice.
  const monotony = measured(
    'variety.sustained_monotony',
    3,
    evidence.pitch.iqrSemitones,
    profile.pitchDispersionSemitones,
    pitchConfidence,
  );

  // §8: "Trust only with stable gain"; §6.9: clipping suppresses loudness
  // scoring. A compressed or clipped signal cannot tell a flat speaker from a
  // flattened recording, so the submetric goes unavailable — it is never
  // scored low. This is the §15 rule at its sharpest: the microphone can
  // remove evidence and can never remove points.
  const gainStable =
    !evidence.energy.degraded &&
    evidence.microphone.status !== 'clipping' &&
    evidence.microphone.status !== 'low_level';
  const loudness = measured(
    'variety.loudness_range',
    4,
    gainStable ? evidence.energy.rangeDb : null,
    profile.loudnessRangeDb,
    gainStable ? ramp(evidence.energy.frameCount, 0, options.minimumEnergyFrames) : 0,
  );

  return [
    pitchRange,
    unsourced('variety.contour_diversity'),
    loudness,
    unsourced('variety.phrase_pitch_resets'),
    monotony,
  ];
}

/** Emphasis and message landing — 14 points, none of them sourceable yet. */
function emphasisSubmetrics(): SubmetricSample[] {
  return [
    unsourced('emphasis.keyword_alignment'),
    unsourced('emphasis.selectivity'),
    unsourced('emphasis.key_line_landing'),
    unsourced('emphasis.rhetorical_shaping'),
  ];
}

/** Fluency and cleanliness — 18 points. */
function fluencySubmetrics(
  evidence: DeliveryEvidence,
  memory: DeliveryScoreMemory,
  options: DeliveryScoreOptions,
  profile: DeliveryTargetProfile,
): SubmetricSample[] {
  const windowStartMs = evidence.audioTimeMs - options.windowMs;
  const words = memory.wordsInWindow;
  const per100 = (count: number): number | null =>
    words <= 0 ? null : (count * 100) / words;

  // A rate per 100 words is meaningless over a handful of words: one "um" in
  // eight words is 12.5 per 100 and would slam the dimension for a single
  // hesitation. Confidence ramps with the word count and carries the §9.8
  // transcript maturity, so a rate computed from text that may still be revised
  // moves the score gently.
  const rateConfidence =
    memory.transcriptStability *
    ramp(words, options.minimumRateWords, options.fullConfidenceRateWords);

  const count = (kinds: ReadonlySet<FillerKind>): number =>
    countConfirmed(evidence.fillerEvents, kinds, evidence.takePassId, windowStartMs, evidence.audioTimeMs);

  const filled = measured(
    'fluency.filled_pauses',
    7,
    per100(count(FILLED_PAUSE_KINDS)),
    profile.filledPausesPer100Words,
    rateConfidence,
  );
  const repetitions = measured(
    'fluency.repetitions',
    5,
    per100(count(REPETITION_KINDS)),
    profile.repetitionsPer100Words,
    rateConfidence,
  );
  const tics = measured(
    'fluency.discourse_tics',
    3,
    per100(count(DISCOURSE_TIC_KINDS)),
    profile.discourseTicsPer100Words,
    rateConfidence,
  );

  return [filled, repetitions, tics, unsourced('fluency.script_repairs')];
}

/** Clarity and vocal control — 9 points, none of them sourceable yet. */
function claritySubmetrics(): SubmetricSample[] {
  return [
    unsourced('clarity.asr_stability'),
    unsourced('clarity.articulation_problems'),
    unsourced('clarity.breath_control'),
  ];
}

/** Consistency and sentence endings — 5 points, none of them sourceable yet. */
function consistencySubmetrics(): SubmetricSample[] {
  return [
    unsourced('consistency.sentence_final_control'),
    unsourced('consistency.sustained_stability'),
  ];
}

/**
 * Build every dimension's submetric samples for one pass.
 *
 * Deterministic and allocation-light: no wall clock, no randomness, and every
 * window is read from the caller's already-pruned arrays rather than rescanned
 * from take start.
 */
export function buildSubmetrics(
  evidence: DeliveryEvidence,
  memory: DeliveryScoreMemory,
  options: DeliveryScoreOptions,
  profile: DeliveryTargetProfile,
): Record<DeliveryDimension, SubmetricSample[]> {
  return {
    pace: paceSubmetrics(evidence, memory, options, profile),
    pausing: pausingSubmetrics(evidence, memory, options, profile),
    variety: varietySubmetrics(evidence, memory, options, profile),
    emphasis: emphasisSubmetrics(),
    fluency: fluencySubmetrics(evidence, memory, options, profile),
    clarity: claritySubmetrics(),
    consistency: consistencySubmetrics(),
  };
}

/**
 * The §9.5 points each dimension can currently be built from.
 *
 * Declared rather than derived so it reads as a statement of coverage, and
 * cross-checked against the live catalogue by the unit tests. Three zeros are
 * the honest headline of this build: emphasis, clarity and consistency —
 * 28 of the contract's 100 points — cannot be measured yet, so they are always
 * unavailable and are always excluded from the mean.
 */
export const SOURCEABLE_WEIGHT: Readonly<Record<DeliveryDimension, number>> = {
  /** wpm 6 + drift 4 + run length 2 + ending acceleration 2, of 18. */
  pace: 14,
  /** amount 4 + distribution 4 + boundary placement 6 + choppy balance 4, of 18. */
  pausing: 18,
  /** pitch range 5 + loudness range 4 + sustained monotony 3, of 18. */
  variety: 12,
  emphasis: 0,
  /** filled pauses 7 + repetitions 5 + discourse tics 3, of 18. */
  fluency: 15,
  clarity: 0,
  consistency: 0,
};
