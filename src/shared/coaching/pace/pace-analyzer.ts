/**
 * The pace state machine (spec §14.5–§14.10, §27.1).
 *
 * This module is the only place that decides what the pace tile says. It owns
 * the §14.7 hysteresis ladder, the §14.5 pause ladder, the §14.8 tip gates and
 * the §14.10 schedule projection, and it produces a
 * {@link PaceDisplayState} plus zero or more {@link CoachCandidate}s.
 *
 * Two rules from `shared/contracts/coaching.ts` are load-bearing here:
 *
 * - `wpm` is `null` — never `0` — while learning or paused. Zero is a real and
 *   different claim, and a tile that renders `0` when it means "unknown" has
 *   started lying to the presenter mid-take.
 * - Nothing here can move the script (Rule 1). The result carries no position,
 *   scroll, cursor, or navigation field, by construction.
 *
 * §28's suggested module list does not name a file for the state machine
 * itself; it lives here rather than being smeared across `weighted-rate.ts`
 * and `target-duration.ts`, which stay purely computational.
 */
import type {
  CoachCandidate,
  DeliveryStyle,
  PaceDisplayState,
  PaceState,
} from '../../contracts/coaching';
import { createEvidenceStamp, SpeechClock, type CoachClockContext } from './speech-clock';
import { distributeTokenTimes, type SpokenSegment, type TimedToken } from './token-timing';
import {
  TargetDurationTracker,
  type ScriptProgress,
  type TargetDurationOptions,
  type TargetDurationResult,
} from './target-duration';
import { TerminalRushAnalyzer, type TerminalRushOptions } from './terminal-rush';
import {
  applySlewLimit,
  DEFAULT_WEIGHTED_RATE_OPTIONS,
  WeightedRateEstimator,
  type RateObservation,
  type WeightedRateOptions,
} from './weighted-rate';

/**
 * §14.6 target presets. These are *starting presets, not universal truths* —
 * the spec is explicit about that, and the user's own band always wins.
 *
 * `broadcast` is an inference: §14.6's table has no broadcast row (its rows are
 * calm explainer, natural presentation, conversational camera, energetic
 * short-form, custom). 130–165 is placed here to keep the mapping total over
 * the contract's `DeliveryStyle` union, and is flagged for tuning.
 */
export const PACE_TARGET_BANDS: Record<DeliveryStyle, { lowWpm: number; highWpm: number }> = {
  calm: { lowWpm: 110, highWpm: 145 },
  natural: { lowWpm: 115, highWpm: 160 },
  conversational: { lowWpm: 130, highWpm: 170 },
  expressive: { lowWpm: 150, highWpm: 190 },
  broadcast: { lowWpm: 130, highWpm: 165 },
  custom: { lowWpm: 115, highWpm: 160 },
};

export interface PaceProfile {
  targetLowWpm: number;
  targetHighWpm: number;

  /* §14.7 classification. */
  /** Width of the `slightly_*` shoulder either side of the band, WPM. */
  slightBandWpm: number;
  /** §14.7: "4–6 WPM hysteresis when returning to a less severe state". */
  hysteresisWpm: number;
  /** §14.7: `FAST` requires the condition to hold this long. */
  fastDwellMs: number;
  /** §14.7: `SLOW` requires the condition to hold this long. */
  slowDwellMs: number;

  /* §14.5 pause ladder. */
  holdSilenceMs: number;
  idleSilenceMs: number;

  /* §27.1 display. */
  displayConfidenceThreshold: number;
  seriesSampleIntervalMs: number;
  seriesMaxSamples: number;

  /* §14.8 tip eligibility. */
  fastTipPersistenceMs: number;
  slowTipPersistenceMs: number;
  paceTipCooldownMs: number;

  /* §25.6 positive reinforcement (disabled by default downstream). */
  positivePaceSustainMs: number;
  positivePaceCooldownMs: number;
}

export const DEFAULT_PACE_PROFILE: PaceProfile = {
  targetLowWpm: PACE_TARGET_BANDS.natural.lowWpm,
  targetHighWpm: PACE_TARGET_BANDS.natural.highWpm,
  slightBandWpm: 12,
  hysteresisWpm: 5,
  fastDwellMs: 4_000,
  slowDwellMs: 5_000,
  holdSilenceMs: 1_500,
  idleSilenceMs: 8_000,
  displayConfidenceThreshold: 0.5,
  seriesSampleIntervalMs: 1_000,
  seriesMaxSamples: 60,
  fastTipPersistenceMs: 6_000,
  slowTipPersistenceMs: 6_000,
  paceTipCooldownMs: 25_000,
  positivePaceSustainMs: 45_000,
  positivePaceCooldownMs: 120_000,
};

export function paceProfileFor(
  style: DeliveryStyle,
  overrides: Partial<PaceProfile> = {},
): PaceProfile {
  const band = PACE_TARGET_BANDS[style];
  return {
    ...DEFAULT_PACE_PROFILE,
    targetLowWpm: band.lowWpm,
    targetHighWpm: band.highWpm,
    ...overrides,
  };
}

/** Where the §14.5 pause ladder currently sits. Not part of the contract type. */
export type PacePauseStage = 'speaking' | 'holding' | 'paused' | 'idle';

export interface PaceUpdateInput {
  context: CoachClockContext;
  /** True while a manual pause, system pause, or voice command is in effect (§14.5). */
  suppressed?: boolean;
  /** §14.8: line tracking is catching up after a transcript delay. */
  trackingCatchingUp?: boolean;
  /** §14.8: the presenter is deliberately reading a marked fast section. */
  authoredFastSection?: boolean;
  /**
   * §14.8: at least one sentence boundary has passed since the current pace
   * condition began. Supplied by the caller because sentence boundaries come
   * from script alignment, which this module deliberately does not read.
   */
  sentenceBoundaryPassed?: boolean;
  /**
   * §14.8: the current line is reflective, a list, a quotation, a retake, or a
   * system delay — all of which forbid the "bring the pace up" tip.
   */
  suppressSlowTip?: boolean;
  /**
   * §14.10: where the alignment cursor sits in the script, or `null` when the
   * engine has nothing trustworthy to say. See the seam note on
   * {@link ScriptProgress} — this input is not yet part of the shared contract.
   */
  scriptProgress?: ScriptProgress | null;
  scriptSpanId?: string | null;
}

/** The three rates of §14.1, kept distinct. */
export interface PaceRates {
  /** All spoken lexical units including confirmed fillers and repetitions. */
  audibleWpm: number | null;
  /** Meaningful delivered words only. */
  contentWpm: number | null;
  /** Audible words over *voiced* time, silence excluded. */
  articulationWpm: number | null;
}

export interface PaceAnalyzerResult {
  display: PaceDisplayState;
  candidates: CoachCandidate[];
  rates: PaceRates;
  pauseStage: PacePauseStage;
  /** How long the current {@link PaceState} has held, ms (§22 metrics). */
  pacePersistenceMs: number;
  terminalRushRatio: number | null;
  schedule: TargetDurationResult;
  /** True when the estimate in use rests partly on a provisional transcript tail. */
  usingProvisionalEvidence: boolean;
}

export interface PaceAnalyzerOptions {
  profile?: Partial<PaceProfile>;
  rate?: Partial<WeightedRateOptions>;
  targetDuration?: Partial<TargetDurationOptions>;
  terminalRush?: Partial<TerminalRushOptions>;
  targetDurationMs?: number | null;
  style?: DeliveryStyle;
}

export class PaceAnalyzer {
  readonly profile: PaceProfile;

  private readonly rateOptions: Partial<WeightedRateOptions>;
  private readonly audible: WeightedRateEstimator;
  private readonly content: WeightedRateEstimator;
  private readonly articulation: WeightedRateEstimator;
  private readonly terminalRush: TerminalRushAnalyzer;
  private readonly targetDuration: TargetDurationTracker;
  private readonly horizonMs: number;

  private audibleTotal = 0;
  private contentTotal = 0;
  private targetDurationMs: number | null;
  private provisionalTokens: TimedToken[] = [];

  private pendingSentence: TimedToken[] = [];
  private pendingSentenceConfidence = 1;
  private pendingSentenceSpanId: string | null = null;

  private state: PaceState = 'learning';
  private stateEnteredMs: number | null = null;
  private aboveFastSinceMs: number | null = null;
  private belowSlowSinceMs: number | null = null;
  private displayedWpm: number | null = null;
  private lastDisplayMs: number | null = null;
  private series: Array<{ audioTimeMs: number; wpm: number }> = [];
  private lastSeriesMs: number | null = null;

  private lastFastTipMs: number | null = null;
  private lastSlowTipMs: number | null = null;
  private lastPositiveTipMs: number | null = null;
  private hasBeenOffTarget = false;
  private candidateSequence = 0;

  constructor(options: PaceAnalyzerOptions = {}) {
    const base = options.style === undefined ? DEFAULT_PACE_PROFILE : paceProfileFor(options.style);
    this.profile = { ...base, ...options.profile };
    this.rateOptions = options.rate ?? {};
    this.audible = new WeightedRateEstimator(this.rateOptions);
    this.content = new WeightedRateEstimator(this.rateOptions);
    this.articulation = new WeightedRateEstimator(this.rateOptions);
    this.terminalRush = new TerminalRushAnalyzer(options.terminalRush);
    this.targetDurationMs = options.targetDurationMs ?? null;
    this.targetDuration = new TargetDurationTracker(this.targetDurationMs, options.targetDuration);
    this.horizonMs = this.rateOptions.horizonMs ?? DEFAULT_WEIGHTED_RATE_OPTIONS.horizonMs;
  }

  /**
   * §14.4 "unless a true section/retake reset occurs". Clears the rate history
   * and the slew limiter so the next number is not dragged toward a rate that
   * belonged to a different performance.
   */
  resetForDiscontinuity(): void {
    this.audible.reset();
    this.content.reset();
    this.articulation.reset();
    this.terminalRush.reset();
    this.targetDuration.reset();
    this.provisionalTokens = [];
    this.pendingSentence = [];
    this.pendingSentenceConfidence = 1;
    this.displayedWpm = null;
    this.lastDisplayMs = null;
    this.aboveFastSinceMs = null;
    this.belowSlowSinceMs = null;
    this.series = [];
    this.lastSeriesMs = null;
  }

  setTargetDurationMs(targetDurationMs: number | null): void {
    this.targetDurationMs = targetDurationMs;
    this.targetDuration.setTargetDurationMs(targetDurationMs);
  }

  /**
   * Fold one transcript segment in. Final segments advance the cumulative
   * counts; a provisional segment replaces the provisional overlay wholesale,
   * because a tail that gets revised must not leave a cumulative count that
   * has to move backwards.
   *
   * Returns any `terminal_rush` candidate produced by a sentence completing.
   */
  ingestSegment(
    segment: SpokenSegment,
    clock: SpeechClock,
    context: CoachClockContext,
  ): CoachCandidate[] {
    const spans = clock.voicedSubIntervalsIn(segment.audioStartMs, segment.audioEndMs);
    const tokens = distributeTokenTimes(segment, spans);

    if (!segment.final) {
      this.provisionalTokens = tokens;
      this.applyProvisional();
      return [];
    }

    this.provisionalTokens = [];
    this.applyProvisional();

    const candidates: CoachCandidate[] = [];
    let audible = this.audibleTotal;
    let content = this.contentTotal;
    for (const token of tokens) {
      audible += 1;
      if (!token.word.confirmedFiller && !token.word.repetition) {
        content += 1;
      }
      this.audible.add({ audioTimeMs: token.centerMs, cumulativeWords: audible });
      this.content.add({ audioTimeMs: token.centerMs, cumulativeWords: content });
      // §14.1 articulation: the same words plotted against *voiced* time, so
      // the slope is words per second of actual speaking.
      this.articulation.add({
        audioTimeMs: clock.voicedTimeAt(token.centerMs),
        cumulativeWords: audible,
      });

      this.pendingSentence.push(token);
      this.pendingSentenceConfidence = Math.min(this.pendingSentenceConfidence, segment.confidence);
      if (token.word.scriptSpanId !== undefined && token.word.scriptSpanId !== null) {
        this.pendingSentenceSpanId = token.word.scriptSpanId;
      }
      if (token.word.endsSentence === true) {
        const candidate = this.terminalRush.noteSentence(
          {
            tokens: this.pendingSentence,
            confidence: this.pendingSentenceConfidence,
            final: true,
            scriptSpanId: this.pendingSentenceSpanId,
          },
          context,
          (a, b) => clock.deliveryMsIn(a, b),
        );
        if (candidate !== null) {
          candidates.push(candidate);
        }
        this.pendingSentence = [];
        this.pendingSentenceConfidence = 1;
        this.pendingSentenceSpanId = null;
      }
    }
    this.audibleTotal = audible;
    this.contentTotal = content;
    return candidates;
  }

  /** Recompute the display and tip candidates at `input.context.audioTimeMs`. */
  update(clock: SpeechClock, input: PaceUpdateInput): PaceAnalyzerResult {
    const nowMs = input.context.audioTimeMs;
    const snapshot = clock.snapshot();
    const windowStartMs = nowMs - this.horizonMs;
    const activeEvidenceMs = clock.voicedMsIn(windowStartMs, nowMs);

    const audibleEstimate = this.audible.estimate(nowMs, activeEvidenceMs);
    const contentEstimate = this.content.estimate(nowMs, activeEvidenceMs);
    const usingProvisional = this.audible.usesProvisional(nowMs);

    // §14.1 articulation rate, measured on the voiced-time axis. A pause makes
    // audible and articulation diverge, which is the whole point of keeping
    // the two apart.
    const voicedNowMs = clock.voicedTimeAt(nowMs);
    const articulationWpm = this.articulation.estimate(
      voicedNowMs,
      Math.min(this.horizonMs, voicedNowMs),
    ).wpm;

    const pauseStage = this.pauseStage(snapshot.silenceSinceSpeechMs, input.suppressed === true);

    let nextState: PaceState;
    let displayWpm: number | null;
    if (pauseStage === 'paused' || pauseStage === 'idle') {
      nextState = 'paused';
      displayWpm = null;
      // §14.5: resume the filter from its previous state with a bounded warm
      // start — the slew limiter is what bounds it, so it is not cleared here.
      this.aboveFastSinceMs = null;
      this.belowSlowSinceMs = null;
    } else if (audibleEstimate.wpm === null) {
      nextState = 'learning';
      displayWpm = null;
    } else {
      const slewed = applySlewLimit(
        this.displayedWpm,
        audibleEstimate.wpm,
        this.lastDisplayMs === null ? 0 : nowMs - this.lastDisplayMs,
      );
      displayWpm = slewed;
      nextState =
        audibleEstimate.confidence < this.profile.displayConfidenceThreshold
          ? 'low_confidence'
          : this.classify(slewed, nowMs);
    }

    if (displayWpm !== null) {
      this.displayedWpm = displayWpm;
      this.lastDisplayMs = nowMs;
      if (
        this.lastSeriesMs === null ||
        nowMs - this.lastSeriesMs >= this.profile.seriesSampleIntervalMs
      ) {
        this.series.push({ audioTimeMs: nowMs, wpm: displayWpm });
        if (this.series.length > this.profile.seriesMaxSamples) {
          this.series.splice(0, this.series.length - this.profile.seriesMaxSamples);
        }
        this.lastSeriesMs = nowMs;
      }
    }

    if (nextState !== this.state || this.stateEnteredMs === null) {
      this.state = nextState;
      this.stateEnteredMs = nowMs;
    }
    if (nextState === 'fast' || nextState === 'slow' || nextState === 'slightly_fast' || nextState === 'slightly_slow') {
      this.hasBeenOffTarget = true;
    }
    const pacePersistenceMs = nowMs - (this.stateEnteredMs ?? nowMs);

    const schedule = this.targetDuration.update({
      audioTimeMs: nowMs,
      elapsedDeliveryMs: snapshot.deliveryMs,
      progress: input.scriptProgress ?? null,
      currentWpm: displayWpm,
      trackingEpoch: input.context.trackingEpoch,
    });

    const candidates = this.buildCandidates({
      nowMs,
      input,
      pacePersistenceMs,
      confidence: audibleEstimate.confidence,
      usingProvisional,
    });

    const display: PaceDisplayState = {
      wpm: displayWpm,
      confidence: audibleEstimate.confidence,
      state: this.state,
      targetLowWpm: this.profile.targetLowWpm,
      targetHighWpm: this.profile.targetHighWpm,
      targetDurationMs: this.targetDurationMs,
      projectedFinishDeltaMs: schedule.projectedFinishDeltaMs,
      recentSeries: this.series.slice(),
    };

    return {
      display,
      candidates,
      rates: {
        audibleWpm: audibleEstimate.wpm,
        contentWpm: contentEstimate.wpm,
        articulationWpm,
      },
      pauseStage,
      pacePersistenceMs,
      terminalRushRatio: this.terminalRush.terminalRushRatio(),
      schedule,
      usingProvisionalEvidence: usingProvisional,
    };
  }

  /** §14.5 ladder. Silence is measured from the last evidence of voice. */
  private pauseStage(silenceSinceSpeechMs: number | null, suppressed: boolean): PacePauseStage {
    if (suppressed) {
      return 'idle';
    }
    if (silenceSinceSpeechMs === null) {
      return 'speaking';
    }
    if (silenceSinceSpeechMs >= this.profile.idleSilenceMs) {
      return 'idle';
    }
    if (silenceSinceSpeechMs >= this.profile.holdSilenceMs) {
      return 'paused';
    }
    return silenceSinceSpeechMs > 0 ? 'holding' : 'speaking';
  }

  /** §14.7 band classification with hysteresis and dwell. */
  private classify(wpm: number, nowMs: number): PaceState {
    const { targetLowWpm: low, targetHighWpm: high, slightBandWpm: slight, hysteresisWpm: hyst } =
      this.profile;

    if (wpm > high + slight) {
      this.aboveFastSinceMs = this.aboveFastSinceMs ?? nowMs;
    } else {
      this.aboveFastSinceMs = null;
    }
    if (wpm < low - slight) {
      this.belowSlowSinceMs = this.belowSlowSinceMs ?? nowMs;
    } else {
      this.belowSlowSinceMs = null;
    }

    if (this.state === 'fast') {
      if (wpm > high + slight - hyst) {
        return 'fast';
      }
    } else if (
      this.aboveFastSinceMs !== null &&
      nowMs - this.aboveFastSinceMs >= this.profile.fastDwellMs
    ) {
      return 'fast';
    }

    if (this.state === 'slow') {
      if (wpm < low - slight + hyst) {
        return 'slow';
      }
    } else if (
      this.belowSlowSinceMs !== null &&
      nowMs - this.belowSlowSinceMs >= this.profile.slowDwellMs
    ) {
      return 'slow';
    }

    const upperEnter =
      this.state === 'slightly_fast' || this.state === 'fast' ? high - hyst : high;
    const lowerEnter = this.state === 'slightly_slow' || this.state === 'slow' ? low + hyst : low;

    if (wpm > upperEnter) {
      return 'slightly_fast';
    }
    if (wpm < lowerEnter) {
      return 'slightly_slow';
    }
    return 'on_target';
  }

  private buildCandidates(args: {
    nowMs: number;
    input: PaceUpdateInput;
    pacePersistenceMs: number;
    confidence: number;
    usingProvisional: boolean;
  }): CoachCandidate[] {
    const { nowMs, input, pacePersistenceMs, confidence, usingProvisional } = args;
    const out: CoachCandidate[] = [];
    if (confidence < this.profile.displayConfidenceThreshold) {
      return out;
    }
    const stateStartMs = this.stateEnteredMs ?? nowMs;
    const spanId = input.scriptSpanId ?? null;

    const gatesOk =
      input.trackingCatchingUp !== true && input.sentenceBoundaryPassed === true;

    if (
      this.state === 'fast' &&
      pacePersistenceMs >= this.profile.fastTipPersistenceMs &&
      gatesOk &&
      input.authoredFastSection !== true &&
      this.cooledDown(this.lastFastTipMs, nowMs, this.profile.paceTipCooldownMs)
    ) {
      this.lastFastTipMs = nowMs;
      out.push(
        this.candidate('pace_too_fast', stateStartMs, nowMs, input.context, confidence, spanId, {
          detailCode: 'sustained_fast',
          finalEvidence: !usingProvisional,
        }),
      );
    }

    if (
      this.state === 'slow' &&
      pacePersistenceMs >= this.profile.slowTipPersistenceMs &&
      gatesOk &&
      input.suppressSlowTip !== true &&
      this.cooledDown(this.lastSlowTipMs, nowMs, this.profile.paceTipCooldownMs)
    ) {
      this.lastSlowTipMs = nowMs;
      out.push(
        this.candidate('pace_too_slow', stateStartMs, nowMs, input.context, confidence, spanId, {
          detailCode: 'sustained_slow',
          finalEvidence: !usingProvisional,
        }),
      );
    }

    if (
      this.state === 'on_target' &&
      this.hasBeenOffTarget &&
      pacePersistenceMs >= this.profile.positivePaceSustainMs &&
      this.cooledDown(this.lastPositiveTipMs, nowMs, this.profile.positivePaceCooldownMs)
    ) {
      this.lastPositiveTipMs = nowMs;
      out.push(
        this.candidate('positive_pace', stateStartMs, nowMs, input.context, confidence, spanId, {
          detailCode: 'sustained_on_target',
          finalEvidence: !usingProvisional,
        }),
      );
    }

    return out;
  }

  private candidate(
    type: CoachCandidate['type'],
    startMs: number,
    endMs: number,
    context: CoachClockContext,
    confidence: number,
    scriptSpanId: string | null,
    extra: { detailCode: string; finalEvidence: boolean },
  ): CoachCandidate {
    this.candidateSequence += 1;
    return {
      evidenceId: `${type}:${context.takePassId}:${this.candidateSequence}`,
      type,
      localConfidence: Math.min(1, Math.max(0, confidence)),
      stamp: createEvidenceStamp(startMs, endMs, context),
      scriptSpanId,
      // Pace is a continuous measurement over a span, not a token.
      scriptAnchorTokenId: null,
      contributingEventIds: [],
      detailCode: extra.detailCode,
      spokenFragment: '',
      authoredFragment: '',
      finalEvidence: extra.finalEvidence,
    };
  }

  private cooledDown(lastMs: number | null, nowMs: number, cooldownMs: number): boolean {
    return lastMs === null || nowMs - lastMs >= cooldownMs;
  }

  private applyProvisional(): void {
    const observations: RateObservation[] = [];
    let audible = this.audibleTotal;
    for (const token of this.provisionalTokens) {
      audible += 1;
      observations.push({ audioTimeMs: token.centerMs, cumulativeWords: audible });
    }
    this.audible.setProvisional(observations);
  }
}
