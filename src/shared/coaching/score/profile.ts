/**
 * Speaking Score report §8 — the "Conversational Authority" default target
 * profile — plus the §9.6/§9.7 scoring constants from Appendix A.
 *
 * ---------------------------------------------------------------------------
 * THESE NUMBERS ARE HYPOTHESES, NOT PRODUCT TRUTH
 * ---------------------------------------------------------------------------
 * §8 opens with "These values are recommended engineering starting points",
 * §8.2 requires the user's own targets to override them, and Appendix A closes
 * with "All numeric values in this appendix are versioned starting hypotheses."
 * {@link DELIVERY_PROFILE_VERSION} exists so a later calibration can be told
 * apart from this one rather than silently replacing it.
 *
 * ---------------------------------------------------------------------------
 * WHERE EACH SIGMA COMES FROM
 * ---------------------------------------------------------------------------
 * §8 publishes a target range *and* a "soft warning region" for most metrics
 * but no σ. Rather than invent tolerances, each σ here is derived by the same
 * rule and the rule is stated once: **σ is the width of the soft region on that
 * side**, so a metric at the far edge of the soft region scores
 * `100 × exp(-0.5)` ≈ 60.65. Speaking rate is the exception — Appendix A gives
 * its σ values explicitly (25 low, 20 high) and those win, because they carry
 * the §9.3 asymmetry the report argues for directly.
 *
 * A handful of bands have no §8 row at all. They are marked `internal` below,
 * they follow the same convention as `VARIETY_TARGET_BANDS` in the prosody lane
 * ("Internal CandidCue scales, pending testing"), and they are deliberately the
 * lowest-weighted submetrics in their dimension.
 */
import { atLeast, atMost, type TargetBand } from './band';

/** Bump when any constant below changes, so two profiles are distinguishable. */
export const DELIVERY_PROFILE_VERSION = 1;

export interface DeliveryTargetProfile {
  readonly profileId: string;
  readonly version: number;

  // --- §8 pace ---------------------------------------------------------
  /**
   * Speaking rate, WPM. §8: target 135–175, soft 115–195. σ from Appendix A.
   *
   * The band is a *fallback*: the effective band is the user's own
   * `targetLowWpm`/`targetHighWpm`, which reaches the engine on
   * `PaceDisplayState`. §8.2 and §14.6 both say the user's target wins.
   */
  readonly wpm: TargetBand;
  /** Pace drift as a fraction of the window median. §8: ±12%, soft 12–22%. */
  readonly paceDrift: TargetBand;
  /** Longest recent uninterrupted run, ms. §8: under 10–12 s, soft 12–16 s. */
  readonly runLengthMs: TargetBand;
  /** Sentence-final acceleration as a fraction. §8: under +18%, soft 18–30%. */
  readonly endingAcceleration: TargetBand;

  // --- §8 pausing ------------------------------------------------------
  /** Silent fraction of recent delivery time. §8: 12–28%, soft 8–35%. */
  readonly pauseRatio: TargetBand;
  /** Upper tail (P90) of recent pause durations, ms. §8: under 1.8 s, soft 1.8–3.0 s. */
  readonly longPauseMs: TargetBand;
  /** Fraction of eligible authored boundaries that were prosodically shaped. `internal`. */
  readonly boundaryShaping: TargetBand;
  /** Unexplained mid-clause interruptions per minute. `internal`, from the cadence profile. */
  readonly choppyPerMinute: TargetBand;

  // --- §8 variety ------------------------------------------------------
  /** Pitch span P90–P10, semitones **relative to the speaker's own median**. §8: 4–10, soft 2.5–13. */
  readonly pitchSpanSemitones: TargetBand;
  /** Pitch IQR, semitones, as the sustained-monotony floor. Derived; see below. */
  readonly pitchDispersionSemitones: TargetBand;
  /** Relative loudness range, dB. §8: 6–14, soft 3–18. */
  readonly loudnessRangeDb: TargetBand;

  // --- §8 fluency ------------------------------------------------------
  /** Filled pauses per 100 words. §8: 0–1, soft 2–4. */
  readonly filledPausesPer100Words: TargetBand;
  /** Restarts/repetitions per 100 words. §8: 0–1, soft 2–3. */
  readonly repetitionsPer100Words: TargetBand;
  /** Discourse tics per 100 words. `internal`. */
  readonly discourseTicsPer100Words: TargetBand;
}

/**
 * §8, "Conversational Authority".
 *
 * The pitch dispersion floor is the one derived constant worth spelling out:
 * §8 publishes a *span* (P90–P10) target of 4–10 semitones but no IQR target,
 * and the two are different statistics of the same distribution. For an
 * approximately normal sample, `IQR / (P90 − P10)` is `1.349 / 2.563 ≈ 0.527`,
 * so §8's 4-semitone span floor implies a ≈2.1-semitone IQR floor and its
 * 1.5-semitone soft margin implies ≈0.79. It is scaled arithmetic on a
 * published number, not a new claim about speech.
 */
export const CONVERSATIONAL_AUTHORITY: DeliveryTargetProfile = {
  profileId: 'conversational_authority',
  version: DELIVERY_PROFILE_VERSION,

  wpm: { low: 135, high: 175, sigmaLow: 25, sigmaHigh: 20 },
  paceDrift: atMost(0.12, 0.1),
  runLengthMs: atMost(11_000, 5_000),
  endingAcceleration: atMost(0.18, 0.12),

  pauseRatio: { low: 0.12, high: 0.28, sigmaLow: 0.04, sigmaHigh: 0.07 },
  longPauseMs: atMost(1_800, 1_200),
  boundaryShaping: atLeast(0.8, 0.25),
  choppyPerMinute: atMost(6, 4),

  pitchSpanSemitones: { low: 4, high: 10, sigmaLow: 1.5, sigmaHigh: 3 },
  pitchDispersionSemitones: atLeast(2.1, 0.79),
  loudnessRangeDb: { low: 6, high: 14, sigmaLow: 3, sigmaHigh: 4 },

  filledPausesPer100Words: atMost(1, 3),
  repetitionsPer100Words: atMost(1, 2),
  discourseTicsPer100Words: atMost(2, 3),
};

/**
 * Appendix A's `score:` block, plus the evidence horizons the engine needs.
 *
 * `visibleMaxDeltaPerSecond` is the §9.6 step-2 rate cap and §11.3's "cap on
 * visible movement so it cannot behave like a slot machine". It is enforced on
 * the *displayed* number only; `rawScore` is never rate-limited, so the
 * smoothing can be audited rather than trusted.
 */
export interface DeliveryScoreOptions {
  /** §9.6 step 1. EWMA half-life applied to the raw overall score, ms. */
  readonly smoothingHalfLifeMs: number;
  /** §9.6 step 2 / §11.3. Maximum visible movement, points per second. */
  readonly visibleMaxDeltaPerSecond: number;
  /** §9.6. Blend of the weighted 25th percentile into the overall score. */
  readonly weakDimensionBlend: number;
  /** §9.7. Below this the rail shows "Listening…" and `displayScore` is `null`. */
  readonly minimumDisplayConfidence: number;

  /** §9.4. Fraction of a dimension's sourceable weight required before it scores. */
  readonly minimumDimensionEvidence: number;

  /** Rolling analysis window for windowed metrics, ms (§5). */
  readonly windowMs: number;
  /** Appendix A `warmup_voiced_seconds`, as ms of voiced audio for full coverage. */
  readonly coverageVoicedMs: number;
  /** Appendix A `warmup_stable_words`. Words in the window for full coverage. */
  readonly coverageWords: number;
  /** Words in the window before a per-100-words rate is worth reporting. */
  readonly minimumRateWords: number;
  /** Words in the window at which a per-100-words rate reaches full confidence. */
  readonly fullConfidenceRateWords: number;

  /** §9.8. Confidence given to evidence that still rests on a provisional tail. */
  readonly provisionalEvidenceConfidence: number;
  /** §9.8 "final evidence increases confidence gradually over 0.5–1.5 seconds". */
  readonly finalEvidenceRampStartMs: number;
  readonly finalEvidenceRampEndMs: number;

  /** §8.1/§16.2. Personal-baseline audio for full calibration maturity, ms. */
  readonly calibrationVoicedMs: number;
  /**
   * Calibration maturity with no personal baseline at all.
   *
   * Not zero: the §8 profile is a legitimate prior, so an uncalibrated speaker
   * is judged with less certainty rather than with none. Not one either — §9.7
   * makes calibration a factor precisely so that `confident` is unreachable
   * until the engine has heard enough of *this* speaker.
   */
  readonly calibrationFloor: number;

  /** Voiced audio in the window before pitch-derived submetrics may score, ms. */
  readonly minimumPitchVoicedMs: number;
  /** Accepted energy frames before the loudness range may score (≈6 s at 20 ms). */
  readonly minimumEnergyFrames: number;
  /** Alignment confidence required before script-relative pausing submetrics score. */
  readonly minimumAlignmentConfidence: number;
  /** Eligible authored boundaries required before boundary shaping scores. */
  readonly minimumEligibleBoundaries: number;
  /** Measured pauses required before the pause-duration distribution scores. */
  readonly minimumPauseSamples: number;
  /** Delivery time in the window required before run length and pause ratio score. */
  readonly minimumWindowDeliveryMs: number;
  /**
   * A single-sentence terminal-rush ratio is stale after this long with no new
   * eligible sentence; its confidence decays linearly to zero across it.
   */
  readonly terminalRushStalenessMs: number;
  /** Ceiling on the confidence of a single-sentence terminal-rush measurement. */
  readonly terminalRushConfidence: number;

  /** Samples of the WPM series kept for the drift metric, at 1 Hz. */
  readonly driftSamples: number;
  /** Look-back used for the `rising`/`falling` trend, ms. */
  readonly trendWindowMs: number;
  /** Points of movement across the trend window before it stops being `steady`. */
  readonly trendThresholdPoints: number;
}

export const DEFAULT_DELIVERY_SCORE_OPTIONS: DeliveryScoreOptions = {
  smoothingHalfLifeMs: 8_000,
  visibleMaxDeltaPerSecond: 2.5,
  weakDimensionBlend: 0.25,
  minimumDisplayConfidence: 0.35,

  minimumDimensionEvidence: 0.25,

  windowMs: 30_000,
  coverageVoicedMs: 3_000,
  coverageWords: 8,
  minimumRateWords: 25,
  fullConfidenceRateWords: 100,

  provisionalEvidenceConfidence: 0.35,
  finalEvidenceRampStartMs: 500,
  finalEvidenceRampEndMs: 1_500,

  calibrationVoicedMs: 45_000,
  calibrationFloor: 0.6,

  minimumPitchVoicedMs: 6_000,
  minimumEnergyFrames: 300,
  minimumAlignmentConfidence: 0.7,
  minimumEligibleBoundaries: 3,
  minimumPauseSamples: 3,
  minimumWindowDeliveryMs: 12_000,
  terminalRushStalenessMs: 60_000,
  terminalRushConfidence: 0.6,

  driftSamples: 30,
  trendWindowMs: 10_000,
  trendThresholdPoints: 1.5,
};

/**
 * §9.7's published thresholds, kept next to the tier they produce so the two
 * cannot drift apart.
 */
export const CONFIDENCE_TIER_THRESHOLDS = {
  /** < 0.35 → `warming_up`. */
  estimated: 0.35,
  /** ≥ 0.35 → `estimated`; ≥ 0.55 → `usable`. */
  usable: 0.55,
  /** > 0.75 → `confident`. */
  confident: 0.75,
} as const;
