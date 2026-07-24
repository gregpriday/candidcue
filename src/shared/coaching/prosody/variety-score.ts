/**
 * Vocal variety (spec §2.5, §13.4, §13.5, §17, §27.2).
 *
 * ---------------------------------------------------------------------------
 * §2.5 — MORE VARIETY IS NOT BETTER. THIS IS A PRODUCT DECISION, NOT A KNOB.
 * ---------------------------------------------------------------------------
 * `varietyLevel` measures the *amount* of movement relative to the speaker's
 * own usable range, and the state machine then asks whether that amount falls
 * inside the selected band. `very_steady` and `highly_animated` are treated
 * symmetrically: same hysteresis, same persistence, same distance from target.
 * Nothing in this file rewards a larger number, and 100 is not a better score
 * than 68.
 *
 * ---------------------------------------------------------------------------
 * §13.4 — WHEN PITCH IS UNUSABLE THERE IS NO SCORE.
 * ---------------------------------------------------------------------------
 * §17.5: "If pitch reliability is insufficient, do not fabricate a score from
 * the remaining features." `level` is `null` and the state is `learning` or
 * `low_confidence`. Energy range is still reported — it is measured and true —
 * but it never becomes a variety number on its own.
 *
 * §13.5: no gendered or absolute pitch target exists anywhere here. Every
 * pitch quantity is semitones around the speaker's own rolling reference.
 */
import type {
  CoachCandidate,
  DeliveryStyle,
  PitchReliability,
  VarietyDisplayState,
  VarietyState,
} from '../../contracts/coaching';
import { createEvidenceStamp, type CoachClockContext } from '../pace/speech-clock';
import type { EnergyAggregate } from './energy-aggregator';
import type { PitchAggregate } from './pitch-aggregator';
import { clamp01, linearNorm } from './stats';

/** §17.6 provisional target bands. Internal CandidCue scales, pending testing. */
export const VARIETY_TARGET_BANDS: Record<DeliveryStyle, { low: number; high: number }> = {
  calm: { low: 35, high: 60 },
  natural: { low: 45, high: 75 },
  conversational: { low: 45, high: 75 },
  expressive: { low: 55, high: 85 },
  broadcast: { low: 40, high: 65 },
  custom: { low: 45, high: 75 },
};

/**
 * §17.4 normalization priors. Each is a broad human-speech ramp, not a
 * population percentile: `lo` is where a feature stops reading as "flat" and
 * `hi` is where more of it stops being informative.
 */
export const VARIETY_NORM_PRIORS = {
  pitchSpanSemitones: { lo: 2, hi: 14 },
  pitchMotionSemitonesPerSecond: { lo: 0.5, hi: 6 },
  energyRangeDb: { lo: 4, hi: 20 },
  tempoVariationCv: { lo: 0.03, hi: 0.35 },
} as const;

/** §17.5 weights. */
export const VARIETY_WEIGHTS = {
  pitchSpan: 0.35,
  pitchMotion: 0.2,
  energyRange: 0.2,
  tempoVariation: 0.15,
  emphasisContrast: 0.1,
} as const;

export interface VarietyFeatureNorms {
  pitchSpanNorm: number;
  pitchMotionNorm: number;
  /** `null` when no usable speech level has been measured. */
  energyRangeNorm: number | null;
  /** `null` before two phrases have completed (§17.2). */
  tempoVariationNorm: number | null;
  /** `null` when emphasis contrast is unavailable (§17.5, §17.11). */
  emphasisContrastNorm: number | null;
}

/**
 * §17.5. `V = 100 × clamp(Σ wᵢ xᵢ, 0, 1)`, with the weight of any unavailable
 * term redistributed proportionally across the terms that remain.
 *
 * §17.5 says this explicitly for emphasis contrast; the same rule is applied to
 * energy and tempo because substituting a zero for "not measured yet" would
 * report a still-calibrating speaker as steadier than they are — the same
 * class of lie as rendering `0` for an unknown WPM.
 *
 * Pitch span and pitch motion are *not* optional. A score without them would be
 * exactly the fabrication §17.5 forbids, so the caller must gate on §13.4
 * before asking for a level at all.
 */
export function varietyLevel(norms: VarietyFeatureNorms): number {
  const terms: Array<{ weight: number; value: number }> = [
    { weight: VARIETY_WEIGHTS.pitchSpan, value: clamp01(norms.pitchSpanNorm) },
    { weight: VARIETY_WEIGHTS.pitchMotion, value: clamp01(norms.pitchMotionNorm) },
  ];
  if (norms.energyRangeNorm !== null) {
    terms.push({ weight: VARIETY_WEIGHTS.energyRange, value: clamp01(norms.energyRangeNorm) });
  }
  if (norms.tempoVariationNorm !== null) {
    terms.push({ weight: VARIETY_WEIGHTS.tempoVariation, value: clamp01(norms.tempoVariationNorm) });
  }
  if (norms.emphasisContrastNorm !== null) {
    terms.push({
      weight: VARIETY_WEIGHTS.emphasisContrast,
      value: clamp01(norms.emphasisContrastNorm),
    });
  }
  const totalWeight = terms.reduce((sum, term) => sum + term.weight, 0);
  if (totalWeight <= 0) {
    return 0;
  }
  const weighted = terms.reduce((sum, term) => sum + term.weight * term.value, 0);
  return 100 * clamp01(weighted / totalWeight);
}

/** Map raw aggregates onto the §17.4 normalized features. */
export function normalizeVarietyFeatures(
  pitch: PitchAggregate,
  energy: EnergyAggregate,
  tempoVariationCv: number | null,
  emphasisContrastNorm: number | null,
): VarietyFeatureNorms | null {
  if (pitch.spanSemitones === null || pitch.motionSemitonesPerSecond === null) {
    return null;
  }
  return {
    pitchSpanNorm: linearNorm(
      pitch.spanSemitones,
      VARIETY_NORM_PRIORS.pitchSpanSemitones.lo,
      VARIETY_NORM_PRIORS.pitchSpanSemitones.hi,
    ),
    pitchMotionNorm: linearNorm(
      pitch.motionSemitonesPerSecond,
      VARIETY_NORM_PRIORS.pitchMotionSemitonesPerSecond.lo,
      VARIETY_NORM_PRIORS.pitchMotionSemitonesPerSecond.hi,
    ),
    energyRangeNorm:
      energy.rangeDb === null
        ? null
        : linearNorm(
            energy.rangeDb,
            VARIETY_NORM_PRIORS.energyRangeDb.lo,
            VARIETY_NORM_PRIORS.energyRangeDb.hi,
          ),
    tempoVariationNorm:
      tempoVariationCv === null
        ? null
        : linearNorm(
            tempoVariationCv,
            VARIETY_NORM_PRIORS.tempoVariationCv.lo,
            VARIETY_NORM_PRIORS.tempoVariationCv.hi,
          ),
    emphasisContrastNorm,
  };
}

export interface VarietyProfile {
  targetLow: number;
  targetHigh: number;
  /** §17.8 width of the `steady` / `expressive` shoulders, points. */
  shoulderPoints: number;
  /** §17.8 hysteresis, points. */
  hysteresisPoints: number;
  /** §17.8 minimum persistence before a new state is published, ms. */
  minPersistenceMs: number;
  /** §17.3 EWMA half-life for the live score, ms. */
  smoothingHalfLifeMs: number;
  /** §17.3 the score updates visually no faster than twice per second. */
  minPublishIntervalMs: number;
  /** §17.7 no numeric score during the first N ms of reliable voiced speech. */
  calibrationVoicedMs: number;
  /** Confidence below which the tile shows `low_confidence` instead of a number. */
  displayConfidenceThreshold: number;
  /** §17.9 minimum reliable medium-horizon evidence before a low tip, ms. */
  lowTipEvidenceMs: number;
  /** §17.9 the score must sit this far below target. */
  lowTipMarginPoints: number;
  /** §17.9 completed sentences required. */
  lowTipMinimumSentences: number;
  /** §17.9 / §17.10 same-category cooldown, ms. */
  tipCooldownMs: number;
  /** §17.10 how long the level must stay well above target, ms. */
  highTipSustainMs: number;
  /** §17.10 both pitch and energy must be this extreme, 0–1. */
  highTipExtremeNorm: number;
  /** §17.10 the high-variety tip is disabled by default. */
  highTipEnabled: boolean;
  /** §17.10 the tip is only allowed for a restrained style. */
  restrainedStyle: boolean;
  /**
   * §25.6 `POSITIVE_VARIETY`. Off by default, like every positive tip.
   *
   * §25.6 authors the copy ("Nice vocal balance") and the catalog prices it at
   * a 60 s cooldown and a 20 s persistence requirement — but §24 defined no
   * candidate type, so nothing could ever produce it. The type exists now, and
   * this is its producer.
   */
  positiveTipEnabled: boolean;
  /** §25.6 how long the level must sit inside the band first, ms. */
  positiveTipSustainMs: number;
}

export const DEFAULT_VARIETY_PROFILE: VarietyProfile = {
  targetLow: VARIETY_TARGET_BANDS.natural.low,
  targetHigh: VARIETY_TARGET_BANDS.natural.high,
  shoulderPoints: 15,
  hysteresisPoints: 5,
  minPersistenceMs: 2_000,
  smoothingHalfLifeMs: 8_000,
  minPublishIntervalMs: 500,
  calibrationVoicedMs: 15_000,
  displayConfidenceThreshold: 0.5,
  lowTipEvidenceMs: 18_000,
  lowTipMarginPoints: 8,
  lowTipMinimumSentences: 2,
  tipCooldownMs: 45_000,
  highTipSustainMs: 20_000,
  highTipExtremeNorm: 0.8,
  highTipEnabled: false,
  restrainedStyle: false,
  positiveTipEnabled: false,
  // Matches `POSITIVE_VARIETY.requiredPersistenceMs` in the catalog: a tip
  // scored on persistence it does not actually have would always score 0.
  positiveTipSustainMs: 20_000,
};

const RESTRAINED_STYLES: ReadonlySet<DeliveryStyle> = new Set<DeliveryStyle>(['calm', 'broadcast']);

export function varietyProfileFor(
  style: DeliveryStyle,
  overrides: Partial<VarietyProfile> = {},
): VarietyProfile {
  const band = VARIETY_TARGET_BANDS[style];
  return {
    ...DEFAULT_VARIETY_PROFILE,
    targetLow: band.low,
    targetHigh: band.high,
    restrainedStyle: RESTRAINED_STYLES.has(style),
    ...overrides,
  };
}

export interface VarietyUpdateInput {
  context: CoachClockContext;
  /** §13.4. The gate that decides whether a number may exist at all. */
  reliability: PitchReliability;
  pitch: PitchAggregate;
  energy: EnergyAggregate;
  /** §17.2 phrase-to-phrase WPM variation as a coefficient of variation. */
  tempoVariationCv: number | null;
  /** §17.5 / §17.11. `null` redistributes the emphasis weight. */
  emphasisContrastNorm?: number | null;
  /** §17.9 completed sentences this take. */
  completedSentences?: number;
  /** §17.9: no tip while the microphone itself is the problem. */
  microphoneProblem?: boolean;
  /** §17.9: list, disclaimer, quotation, or an authored directive suppressing variety. */
  suppressVarietyCoaching?: boolean;
  scriptSpanId?: string | null;
  /**
   * False when the tempo term rests on a provisional transcript tail. Pitch and
   * energy come from local audio and are always final; tempo does not.
   */
  finalEvidence?: boolean;
}

export interface VarietyAnalyzerResult {
  display: VarietyDisplayState;
  candidates: CoachCandidate[];
  /** How long the published state has held, ms (§22 metrics). */
  varietyPersistenceMs: number;
  /** Normalized features, or `null` when pitch was unusable. */
  norms: VarietyFeatureNorms | null;
  /** Unsmoothed level for this update, or `null`. Diagnostics and tests. */
  rawLevel: number | null;
}

/** §17.8 state ranks. Negative is steadier, positive more animated. */
type VarietyRank = -2 | -1 | 0 | 1 | 2;

const RANK_TO_STATE: Record<VarietyRank, VarietyState> = {
  [-2]: 'very_steady',
  [-1]: 'steady',
  [0]: 'balanced',
  [1]: 'expressive',
  [2]: 'highly_animated',
};

export class VarietyAnalyzer {
  readonly profile: VarietyProfile;

  private smoothedLevel: number | null = null;
  private lastSmoothMs: number | null = null;
  private publishedLevel: number | null = null;
  private lastPublishMs: number | null = null;

  private rank: VarietyRank = 0;
  private state: VarietyState = 'learning';
  private stateEnteredMs: number | null = null;
  private pendingRank: VarietyRank | null = null;
  private pendingSinceMs: number | null = null;

  private aboveHighSinceMs: number | null = null;
  private inBandSinceMs: number | null = null;
  private leftBandThisTake = false;
  private lastLowTipMs: number | null = null;
  private lastHighTipMs: number | null = null;
  private lastPositiveTipMs: number | null = null;
  private candidateSequence = 0;

  constructor(options: { style?: DeliveryStyle; profile?: Partial<VarietyProfile> } = {}) {
    const base =
      options.style === undefined ? DEFAULT_VARIETY_PROFILE : varietyProfileFor(options.style);
    this.profile = { ...base, ...options.profile };
  }

  reset(): void {
    this.smoothedLevel = null;
    this.lastSmoothMs = null;
    this.publishedLevel = null;
    this.lastPublishMs = null;
    this.rank = 0;
    this.state = 'learning';
    this.stateEnteredMs = null;
    this.pendingRank = null;
    this.pendingSinceMs = null;
    this.aboveHighSinceMs = null;
    this.inBandSinceMs = null;
    this.leftBandThisTake = false;
    this.lastPositiveTipMs = null;
  }

  update(input: VarietyUpdateInput): VarietyAnalyzerResult {
    const nowMs = input.context.audioTimeMs;
    const { reliability, pitch, energy } = input;
    const energyRangeDb = energy.rangeDb;

    // §13.4 / §17.7. Anything that fails here yields no number at all.
    const unusable = this.unusableState(reliability);
    if (unusable !== null) {
      this.setState(unusable, nowMs);
      this.aboveHighSinceMs = null;
      return {
        display: {
          level: null,
          confidence: 0,
          state: unusable,
          targetLow: this.profile.targetLow,
          targetHigh: this.profile.targetHigh,
          pitchSpanSemitones: null,
          energyRangeDb,
        },
        candidates: [],
        varietyPersistenceMs: nowMs - (this.stateEnteredMs ?? nowMs),
        norms: null,
        rawLevel: null,
      };
    }

    const norms = normalizeVarietyFeatures(
      pitch,
      energy,
      input.tempoVariationCv,
      input.emphasisContrastNorm ?? null,
    );
    if (norms === null) {
      this.setState('low_confidence', nowMs);
      return {
        display: {
          level: null,
          confidence: 0,
          state: 'low_confidence',
          targetLow: this.profile.targetLow,
          targetHigh: this.profile.targetHigh,
          pitchSpanSemitones: pitch.spanSemitones,
          energyRangeDb,
        },
        candidates: [],
        varietyPersistenceMs: nowMs - (this.stateEnteredMs ?? nowMs),
        norms: null,
        rawLevel: null,
      };
    }

    const rawLevel = varietyLevel(norms);
    const smoothed = this.smooth(rawLevel, nowMs);
    const level = this.publish(smoothed, nowMs);
    const confidence = this.confidenceOf(reliability);

    if (confidence < this.profile.displayConfidenceThreshold) {
      this.setState('low_confidence', nowMs);
      return {
        display: {
          level: null,
          confidence,
          state: 'low_confidence',
          targetLow: this.profile.targetLow,
          targetHigh: this.profile.targetHigh,
          pitchSpanSemitones: pitch.spanSemitones,
          energyRangeDb,
        },
        candidates: [],
        varietyPersistenceMs: nowMs - (this.stateEnteredMs ?? nowMs),
        norms,
        rawLevel,
      };
    }

    const nextRank = this.classify(level);
    this.applyRank(nextRank, nowMs);
    const varietyPersistenceMs = nowMs - (this.stateEnteredMs ?? nowMs);

    const candidates = this.buildCandidates({
      nowMs,
      level,
      norms,
      confidence,
      input,
    });

    return {
      display: {
        level,
        confidence,
        state: this.state,
        targetLow: this.profile.targetLow,
        targetHigh: this.profile.targetHigh,
        pitchSpanSemitones: pitch.spanSemitones,
        energyRangeDb,
      },
      candidates,
      varietyPersistenceMs,
      norms,
      rawLevel,
    };
  }

  /** §13.4 and §17.7 gates. Returns the state to publish, or `null` to proceed. */
  private unusableState(reliability: PitchReliability): VarietyState | null {
    if (!reliability.usable) {
      return reliability.reason === 'insufficient_voiced_audio' ? 'learning' : 'low_confidence';
    }
    if (reliability.usableVoicedMs < this.profile.calibrationVoicedMs) {
      return 'learning';
    }
    return null;
  }

  private confidenceOf(reliability: PitchReliability): number {
    // Ramps from the §13.4 gate of 0.45 up to 0.85, times how much of the
    // medium horizon has actually been observed.
    const frameFactor = clamp01((reliability.reliableFrameFraction - 0.45) / (0.85 - 0.45));
    const evidenceFactor = clamp01(reliability.usableVoicedMs / 30_000);
    return clamp01(frameFactor * evidenceFactor);
  }

  private smooth(rawLevel: number, nowMs: number): number {
    const previous = this.smoothedLevel;
    const previousMs = this.lastSmoothMs;
    if (previous === null || previousMs === null || nowMs <= previousMs) {
      this.smoothedLevel = rawLevel;
      this.lastSmoothMs = nowMs;
      return rawLevel;
    }
    const alpha = 1 - Math.pow(0.5, (nowMs - previousMs) / this.profile.smoothingHalfLifeMs);
    const next = previous + alpha * (rawLevel - previous);
    this.smoothedLevel = next;
    this.lastSmoothMs = nowMs;
    return next;
  }

  /** §17.3: the score updates visually no faster than twice per second. */
  private publish(smoothed: number, nowMs: number): number {
    if (
      this.publishedLevel === null ||
      this.lastPublishMs === null ||
      nowMs - this.lastPublishMs >= this.profile.minPublishIntervalMs
    ) {
      this.publishedLevel = smoothed;
      this.lastPublishMs = nowMs;
    }
    return this.publishedLevel;
  }

  /**
   * §17.8 with symmetric hysteresis. The two extremes use identical logic —
   * mirrored thresholds, same shoulder width, same hysteresis — which is what
   * §2.5's "treated symmetrically" means in code.
   */
  private classify(level: number): VarietyRank {
    const { targetLow: low, targetHigh: high, shoulderPoints, hysteresisPoints } = this.profile;
    const upperShoulder = this.rank >= 1 ? high - hysteresisPoints : high;
    const upperExtreme =
      this.rank >= 2 ? high + shoulderPoints - hysteresisPoints : high + shoulderPoints;
    const lowerShoulder = this.rank <= -1 ? low + hysteresisPoints : low;
    const lowerExtreme =
      this.rank <= -2 ? low - shoulderPoints + hysteresisPoints : low - shoulderPoints;

    if (level > upperExtreme) {
      return 2;
    }
    if (level > upperShoulder) {
      return 1;
    }
    if (level < lowerExtreme) {
      return -2;
    }
    if (level < lowerShoulder) {
      return -1;
    }
    return 0;
  }

  /**
   * §17.8 minimum persistence: a new rank must hold before it is published.
   *
   * The very first classification — and any return from `learning` or
   * `low_confidence` — is adopted at once, because those two states mean "no
   * number", and holding them while a number is already on the tile would be
   * the tile contradicting itself.
   */
  private applyRank(nextRank: VarietyRank, nowMs: number): void {
    if (this.state === 'learning' || this.state === 'low_confidence') {
      this.rank = nextRank;
      this.pendingRank = null;
      this.pendingSinceMs = null;
      this.setState(RANK_TO_STATE[nextRank], nowMs);
      return;
    }
    if (nextRank === this.rank) {
      this.pendingRank = null;
      this.pendingSinceMs = null;
      if (this.stateEnteredMs === null) {
        this.setState(RANK_TO_STATE[this.rank], nowMs);
      } else if (this.state !== RANK_TO_STATE[this.rank]) {
        this.setState(RANK_TO_STATE[this.rank], nowMs);
      }
      return;
    }
    if (this.pendingRank !== nextRank) {
      this.pendingRank = nextRank;
      this.pendingSinceMs = nowMs;
      return;
    }
    if (
      this.pendingSinceMs !== null &&
      nowMs - this.pendingSinceMs >= this.profile.minPersistenceMs
    ) {
      this.rank = nextRank;
      this.pendingRank = null;
      this.pendingSinceMs = null;
      this.setState(RANK_TO_STATE[nextRank], nowMs);
    }
  }

  private setState(state: VarietyState, nowMs: number): void {
    if (this.state !== state || this.stateEnteredMs === null) {
      this.state = state;
      this.stateEnteredMs = nowMs;
    }
  }

  private buildCandidates(args: {
    nowMs: number;
    level: number;
    norms: VarietyFeatureNorms;
    confidence: number;
    input: VarietyUpdateInput;
  }): CoachCandidate[] {
    const { nowMs, level, norms, confidence, input } = args;
    const out: CoachCandidate[] = [];
    const finalEvidence = input.finalEvidence ?? true;
    const stateStartMs = this.stateEnteredMs ?? nowMs;

    // §17.10 sustain tracking: measured against the raw band, not the state,
    // so hysteresis cannot shorten the 20 s requirement.
    if (level > this.profile.targetHigh + this.profile.shoulderPoints) {
      this.aboveHighSinceMs = this.aboveHighSinceMs ?? nowMs;
    } else {
      this.aboveHighSinceMs = null;
    }

    const blocked =
      input.microphoneProblem === true || input.suppressVarietyCoaching === true;

    // §17.9 low variety.
    if (
      !blocked &&
      (this.state === 'very_steady' || this.state === 'steady') &&
      level <= this.profile.targetLow - this.profile.lowTipMarginPoints &&
      input.reliability.usableVoicedMs >= this.profile.lowTipEvidenceMs &&
      (input.completedSentences ?? 0) >= this.profile.lowTipMinimumSentences &&
      this.cooledDown(this.lastLowTipMs, nowMs)
    ) {
      this.lastLowTipMs = nowMs;
      out.push(
        this.candidate('low_variety', stateStartMs, nowMs, input, confidence, finalEvidence),
      );
    }

    // §17.10 high variety — restrained style only, both dimensions extreme,
    // and disabled by default.
    if (
      !blocked &&
      this.profile.highTipEnabled &&
      this.profile.restrainedStyle &&
      this.aboveHighSinceMs !== null &&
      nowMs - this.aboveHighSinceMs >= this.profile.highTipSustainMs &&
      norms.pitchSpanNorm >= this.profile.highTipExtremeNorm &&
      (norms.energyRangeNorm ?? 0) >= this.profile.highTipExtremeNorm &&
      this.cooledDown(this.lastHighTipMs, nowMs)
    ) {
      this.lastHighTipMs = nowMs;
      out.push(
        this.candidate(
          'high_variety',
          this.aboveHighSinceMs,
          nowMs,
          input,
          confidence,
          finalEvidence,
        ),
      );
    }

    // §25.6 positive reinforcement. Tracked unconditionally so that enabling
    // the tip mid-take does not have to wait for the window to restart.
    const inBand = level >= this.profile.targetLow && level <= this.profile.targetHigh;
    if (inBand) {
      this.inBandSinceMs = this.inBandSinceMs ?? nowMs;
    } else {
      this.inBandSinceMs = null;
      // §2.5 / §25.6: "more variety is not better", and neither is telling
      // someone they are doing well before they have done anything. A positive
      // tip only means something once the take has been outside the band.
      if (this.state !== 'learning' && this.state !== 'low_confidence') {
        this.leftBandThisTake = true;
      }
    }

    if (
      !blocked &&
      this.profile.positiveTipEnabled &&
      this.leftBandThisTake &&
      this.state === 'balanced' &&
      this.inBandSinceMs !== null &&
      nowMs - this.inBandSinceMs >= this.profile.positiveTipSustainMs &&
      input.reliability.usable &&
      this.cooledDown(this.lastPositiveTipMs, nowMs)
    ) {
      this.lastPositiveTipMs = nowMs;
      out.push(
        this.candidate(
          'positive_variety',
          this.inBandSinceMs,
          nowMs,
          input,
          confidence,
          finalEvidence,
        ),
      );
    }

    return out;
  }

  private candidate(
    type: 'low_variety' | 'high_variety' | 'positive_variety',
    startMs: number,
    endMs: number,
    input: VarietyUpdateInput,
    confidence: number,
    finalEvidence: boolean,
  ): CoachCandidate {
    this.candidateSequence += 1;
    return {
      evidenceId: `${type}:${input.context.takePassId}:${this.candidateSequence}`,
      type,
      localConfidence: clamp01(confidence),
      stamp: createEvidenceStamp(startMs, endMs, input.context),
      scriptSpanId: input.scriptSpanId ?? null,
      scriptAnchorTokenId: null,
      contributingEventIds: [],
      detailCode: this.state,
      spokenFragment: '',
      authoredFragment: '',
      finalEvidence,
    };
  }

  private cooledDown(lastMs: number | null, nowMs: number): boolean {
    return lastMs === null || nowMs - lastMs >= this.profile.tipCooldownMs;
  }
}
