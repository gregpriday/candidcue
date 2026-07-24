/**
 * Cadence and pause analysis (spec §18).
 *
 * §18.1: "Cadence describes the pattern of speech, pauses, phrase lengths, and
 * changes in rate. It is not reducible to WPM." Everything here is therefore
 * about *structure* — where the silence fell relative to the script, whether a
 * boundary was allowed to land — rather than about rate, which `coaching/pace`
 * owns.
 *
 * The one idea worth stating twice is §18.3: a boundary is well shaped when
 * *any* of silence, pitch reset, energy reset, rate deceleration, or a fresh
 * contour occurs. Equating good phrasing with silence alone would coach a rigid
 * full-stop-shaped pause after every period, which is worse delivery than the
 * problem it set out to fix.
 */
import type { CoachCandidate } from '../../contracts/coaching';
import { createEvidenceStamp, type CoachClockContext } from '../pace/speech-clock';
import { clamp01 } from './stats';

/** §18.2 pause classes. `sub_threshold` is shorter than a perceptible pause. */
export type PauseClass = 'sub_threshold' | 'micro' | 'short' | 'medium' | 'long' | 'excluded';

/** §18.2 authored location a pause was mapped to. */
export type PauseLocation =
  | 'within_word'
  | 'between_words'
  | 'comma_boundary'
  | 'sentence_boundary'
  | 'paragraph_boundary'
  | 'retake_boundary'
  | 'ad_lib'
  | 'uncertain';

/** §18.1 boundary strength, from the authored punctuation class. */
export type BoundaryStrength = 'weak' | 'medium' | 'strong' | 'paragraph';

export interface PauseThresholds {
  /** §18.2: micro-pause 80–180 ms. */
  microMs: number;
  /** §18.2: short pause 180–400 ms. */
  shortMs: number;
  /** §18.2: medium pause 400–900 ms. */
  mediumMs: number;
  /** §18.2: long pause 900 ms or more. */
  longMs: number;
}

export const DEFAULT_PAUSE_THRESHOLDS: PauseThresholds = {
  microMs: 80,
  shortMs: 180,
  mediumMs: 400,
  longMs: 900,
};

/**
 * §18.2. Boundaries are inclusive at the lower edge: exactly 180 ms is a short
 * pause, exactly 400 ms is a medium one, exactly 900 ms is long. Stated here so
 * a test can assert the boundary rather than guess at it.
 */
export function classifyPause(
  durationMs: number,
  thresholds: PauseThresholds = DEFAULT_PAUSE_THRESHOLDS,
): PauseClass {
  if (durationMs < thresholds.microMs) {
    return 'sub_threshold';
  }
  if (durationMs < thresholds.shortMs) {
    return 'micro';
  }
  if (durationMs < thresholds.mediumMs) {
    return 'short';
  }
  if (durationMs < thresholds.longMs) {
    return 'medium';
  }
  return 'long';
}

export interface PauseEvent {
  startMs: number;
  endMs: number;
  location: PauseLocation;
  /**
   * §18.5: the pause is explained by a comma, a parenthetical, a difficult
   * name, a voice command, or retake behaviour, and therefore is not evidence
   * of choppy delivery.
   */
  explained?: boolean;
  /** §18.2: a manual or system pause, excluded from delivery scoring. */
  manual?: boolean;
}

export interface BoundaryEvent {
  atMs: number;
  strength: BoundaryStrength;
  /** Silence actually observed at the boundary, ms. */
  silenceMs: number;
  /** Pitch reset across the boundary, signed semitones, or `null` if unusable. */
  pitchResetSemitones: number | null;
  /** Energy reset across the boundary, signed dB, or `null` if unusable. */
  energyResetDb: number | null;
  /** `1 - postRate / preRate`; positive means the speaker decelerated. */
  rateDecelerationRatio: number | null;
  /** True when the next sentence starts on a visibly new contour. */
  newContour: boolean;
  /** 0–1 script-alignment confidence at the boundary. */
  alignmentConfidence: number;
}

export type BoundaryShapingReason =
  | 'silence'
  | 'pitch_reset'
  | 'energy_reset'
  | 'rate_deceleration'
  | 'new_contour';

export interface BoundaryAssessment {
  shaped: boolean;
  reasons: BoundaryShapingReason[];
}

export interface CadenceProfile {
  thresholds: PauseThresholds;
  /** §18.3: silence at or above this shapes a boundary, ms (a short pause). */
  boundarySilenceMs: number;
  /** §18.3 pitch reset magnitude that counts, semitones. */
  boundaryPitchResetSemitones: number;
  /** §18.3 energy reset magnitude that counts, dB. */
  boundaryEnergyResetDb: number;
  /** §18.3 deceleration that counts, as a fraction of the preceding rate. */
  boundaryDecelerationRatio: number;

  /** §18.4: sustained active speech longer than this, ms. */
  runOnMinimumRunMs: number;
  /** §18.4: unshaped strong boundaries required inside one run. */
  runOnMinimumBoundaries: number;
  /** §18.4: "pattern repeated at least twice". */
  runOnMinimumEpisodes: number;

  /** §18.5: eligible events required. */
  choppyMinimumEvents: number;
  /** §18.5: within this window, ms. */
  choppyWindowMs: number;
  /** §18.5: "alignment confidence high". */
  choppyMinimumAlignmentConfidence: number;

  /** Same-category cooldown, ms (§25.4). */
  tipCooldownMs: number;
  /** Mid-clause interruptions per minute at which the cadence sub-score hits 0. */
  midClauseSaturationPerMinute: number;
}

export const DEFAULT_CADENCE_PROFILE: CadenceProfile = {
  thresholds: DEFAULT_PAUSE_THRESHOLDS,
  boundarySilenceMs: 180,
  boundaryPitchResetSemitones: 2,
  boundaryEnergyResetDb: 3,
  boundaryDecelerationRatio: 0.15,
  runOnMinimumRunMs: 15_000,
  runOnMinimumBoundaries: 2,
  runOnMinimumEpisodes: 2,
  choppyMinimumEvents: 3,
  choppyWindowMs: 20_000,
  choppyMinimumAlignmentConfidence: 0.7,
  tipCooldownMs: 30_000,
  midClauseSaturationPerMinute: 12,
};

/**
 * §18.3. Any one of the listed cues is enough. `silenceMs` is compared against
 * a *short* pause, not a long one — a well-shaped boundary is perceptible, not
 * theatrical.
 */
export function assessBoundary(
  boundary: BoundaryEvent,
  profile: CadenceProfile = DEFAULT_CADENCE_PROFILE,
): BoundaryAssessment {
  const reasons: BoundaryShapingReason[] = [];
  if (boundary.silenceMs >= profile.boundarySilenceMs) {
    reasons.push('silence');
  }
  if (
    boundary.pitchResetSemitones !== null &&
    Math.abs(boundary.pitchResetSemitones) >= profile.boundaryPitchResetSemitones
  ) {
    reasons.push('pitch_reset');
  }
  if (
    boundary.energyResetDb !== null &&
    Math.abs(boundary.energyResetDb) >= profile.boundaryEnergyResetDb
  ) {
    reasons.push('energy_reset');
  }
  if (
    boundary.rateDecelerationRatio !== null &&
    boundary.rateDecelerationRatio >= profile.boundaryDecelerationRatio
  ) {
    reasons.push('rate_deceleration');
  }
  if (boundary.newContour) {
    reasons.push('new_contour');
  }
  return { shaped: reasons.length > 0, reasons };
}

export interface CadenceMetrics {
  /** §22 metrics: run-on episodes detected this take. */
  runOnCount: number;
  /** §22 metrics: unexplained mid-clause pauses in the choppy window. */
  choppyPauseCount: number;
  /** §18.9 internal 0–1 score, or `null` before there is anything to score. */
  cadenceBalance: number | null;
  /** §18.6 longest uninterrupted active speech run, ms. */
  longestBreathGroupMs: number;
  /** Eligible (strong or paragraph) boundaries seen. */
  eligibleBoundaries: number;
  shapedBoundaries: number;
}

export interface CadenceBalanceInputs {
  /** 0–1 fraction of eligible sentences showing terminal rush, from pace. */
  terminalRushRate?: number;
  /** 0–1 phrase-rate stability relative to style, from pace. */
  phraseRateStability?: number;
}

/**
 * §18.9 `cadenceBalance` weights. Kept public so the review screen and tests
 * agree on what the number is made of; it is a gating and review signal, never
 * a gamified live score.
 */
export const CADENCE_BALANCE_WEIGHTS = {
  boundaryShaping: 0.3,
  midClauseInterruption: 0.25,
  terminalRush: 0.15,
  runOn: 0.15,
  phraseRateStability: 0.15,
} as const;

export class CadenceAnalyzer {
  readonly profile: CadenceProfile;

  private runStartMs: number | null = null;
  private runUnshapedStrongBoundaries = 0;
  private runEpisodeCounted = false;
  private runOnEpisodes = 0;
  private longestRunMs = 0;

  private eligibleBoundaries = 0;
  private shapedBoundaries = 0;

  private midClausePauses: number[] = [];
  private lastAlignmentConfidence = 1;
  private observedMs = 0;
  private firstEventMs: number | null = null;

  private lastRunOnTipMs: number | null = null;
  private lastChoppyTipMs: number | null = null;
  private candidateSequence = 0;

  constructor(profile: Partial<CadenceProfile> = {}) {
    this.profile = { ...DEFAULT_CADENCE_PROFILE, ...profile };
  }

  reset(): void {
    this.runStartMs = null;
    this.runUnshapedStrongBoundaries = 0;
    this.runEpisodeCounted = false;
    this.runOnEpisodes = 0;
    this.longestRunMs = 0;
    this.eligibleBoundaries = 0;
    this.shapedBoundaries = 0;
    this.midClausePauses = [];
    this.observedMs = 0;
    this.firstEventMs = null;
    this.lastRunOnTipMs = null;
    this.lastChoppyTipMs = null;
  }

  /** A run of continuous active speech began (VAD onset). */
  noteSpeechOnset(atMs: number): void {
    if (this.runStartMs === null) {
      this.runStartMs = atMs;
      this.runUnshapedStrongBoundaries = 0;
      this.runEpisodeCounted = false;
    }
    this.observe(atMs);
  }

  /** The run ended (VAD offset). §18.6 breath-group length is recorded here. */
  noteSpeechEnd(atMs: number): void {
    if (this.runStartMs !== null) {
      this.longestRunMs = Math.max(this.longestRunMs, atMs - this.runStartMs);
    }
    this.runStartMs = null;
    this.runUnshapedStrongBoundaries = 0;
    this.runEpisodeCounted = false;
    this.observe(atMs);
  }

  /**
   * §18.4. Fold in an authored boundary the presenter has just passed.
   * Returns a `run_on_delivery` candidate when the pattern completes.
   */
  noteBoundary(boundary: BoundaryEvent, context: CoachClockContext): CoachCandidate | null {
    this.observe(boundary.atMs);
    this.lastAlignmentConfidence = boundary.alignmentConfidence;
    const strong = boundary.strength === 'strong' || boundary.strength === 'paragraph';
    const assessment = assessBoundary(boundary, this.profile);
    if (strong) {
      this.eligibleBoundaries += 1;
      if (assessment.shaped) {
        this.shapedBoundaries += 1;
      }
    }
    if (!strong || assessment.shaped) {
      return null;
    }

    this.runUnshapedStrongBoundaries += 1;
    const runStartMs = this.runStartMs;
    if (runStartMs === null || this.runEpisodeCounted) {
      return null;
    }
    const runMs = boundary.atMs - runStartMs;
    if (
      runMs < this.profile.runOnMinimumRunMs ||
      this.runUnshapedStrongBoundaries < this.profile.runOnMinimumBoundaries
    ) {
      return null;
    }

    this.runEpisodeCounted = true;
    this.runOnEpisodes += 1;
    if (
      this.runOnEpisodes < this.profile.runOnMinimumEpisodes ||
      !this.cooledDown(this.lastRunOnTipMs, boundary.atMs)
    ) {
      return null;
    }
    this.lastRunOnTipMs = boundary.atMs;
    this.candidateSequence += 1;
    return {
      evidenceId: `run_on_delivery:${context.takePassId}:${this.candidateSequence}`,
      type: 'run_on_delivery',
      localConfidence: clamp01(0.55 + 0.1 * this.runUnshapedStrongBoundaries) *
        boundary.alignmentConfidence,
      stamp: createEvidenceStamp(runStartMs, boundary.atMs, context),
      scriptSpanId: null,
      detailCode: `unshaped_${this.runUnshapedStrongBoundaries}`,
      spokenFragment: '',
      authoredFragment: '',
      finalEvidence: true,
    };
  }

  /**
   * §18.5. Fold in a silence the VAD found. Returns a `choppy_delivery`
   * candidate when three unexplained mid-clause interruptions land inside the
   * 20-second window.
   */
  notePause(pause: PauseEvent, context: CoachClockContext): CoachCandidate | null {
    this.observe(pause.endMs);
    const durationMs = pause.endMs - pause.startMs;
    const pauseClass = pause.manual === true ? 'excluded' : classifyPause(durationMs, this.profile.thresholds);
    if (!this.isMidClauseInterruption(pause, pauseClass)) {
      return null;
    }

    this.midClausePauses.push(pause.endMs);
    this.trimChoppyWindow(pause.endMs);

    if (
      this.midClausePauses.length < this.profile.choppyMinimumEvents ||
      this.lastAlignmentConfidence < this.profile.choppyMinimumAlignmentConfidence ||
      !this.cooledDown(this.lastChoppyTipMs, pause.endMs)
    ) {
      return null;
    }

    this.lastChoppyTipMs = pause.endMs;
    this.candidateSequence += 1;
    const startMs = this.midClausePauses[0] ?? pause.startMs;
    return {
      evidenceId: `choppy_delivery:${context.takePassId}:${this.candidateSequence}`,
      type: 'choppy_delivery',
      localConfidence: clamp01(0.5 + 0.1 * this.midClausePauses.length) * this.lastAlignmentConfidence,
      stamp: createEvidenceStamp(startMs, pause.endMs, context),
      scriptSpanId: null,
      detailCode: `mid_clause_${this.midClausePauses.length}`,
      spokenFragment: '',
      authoredFragment: '',
      finalEvidence: true,
    };
  }

  /** Set the alignment confidence used to gate the choppy pattern (§18.5). */
  setAlignmentConfidence(confidence: number): void {
    this.lastAlignmentConfidence = confidence;
  }

  metrics(nowMs: number, inputs: CadenceBalanceInputs = {}): CadenceMetrics {
    this.observe(nowMs);
    this.trimChoppyWindow(nowMs);
    const openRunMs = this.runStartMs === null ? 0 : nowMs - this.runStartMs;
    return {
      runOnCount: this.runOnEpisodes,
      choppyPauseCount: this.midClausePauses.length,
      cadenceBalance: this.cadenceBalance(inputs),
      longestBreathGroupMs: Math.max(this.longestRunMs, openRunMs),
      eligibleBoundaries: this.eligibleBoundaries,
      shapedBoundaries: this.shapedBoundaries,
    };
  }

  /**
   * §18.9. Composed of boundary shaping, mid-clause interruption rate,
   * terminal-rush rate, run-on rate, and phrase-rate stability. `null` until
   * there is at least one eligible boundary — a score with no boundaries in it
   * would just be the default values of its own inputs.
   */
  private cadenceBalance(inputs: CadenceBalanceInputs): number | null {
    if (this.eligibleBoundaries === 0) {
      return null;
    }
    const boundaryShaping = this.shapedBoundaries / this.eligibleBoundaries;
    const observedMinutes = Math.max(this.observedMs, 1) / 60_000;
    const midClausePerMinute = this.midClausePauses.length / observedMinutes;
    const midClauseScore =
      1 - clamp01(midClausePerMinute / this.profile.midClauseSaturationPerMinute);
    const terminalRushScore = 1 - clamp01(inputs.terminalRushRate ?? 0);
    const runOnScore = 1 - clamp01(this.runOnEpisodes / 3);
    const stabilityScore = clamp01(inputs.phraseRateStability ?? 1);

    return clamp01(
      CADENCE_BALANCE_WEIGHTS.boundaryShaping * boundaryShaping +
        CADENCE_BALANCE_WEIGHTS.midClauseInterruption * midClauseScore +
        CADENCE_BALANCE_WEIGHTS.terminalRush * terminalRushScore +
        CADENCE_BALANCE_WEIGHTS.runOn * runOnScore +
        CADENCE_BALANCE_WEIGHTS.phraseRateStability * stabilityScore,
    );
  }

  private isMidClauseInterruption(pause: PauseEvent, pauseClass: PauseClass): boolean {
    if (pause.manual === true || pause.explained === true) {
      return false;
    }
    if (pauseClass !== 'short' && pauseClass !== 'medium' && pauseClass !== 'long') {
      return false;
    }
    return (
      pause.location === 'within_word' ||
      pause.location === 'between_words' ||
      pause.location === 'uncertain'
    );
  }

  private trimChoppyWindow(nowMs: number): void {
    const cutoff = nowMs - this.profile.choppyWindowMs;
    this.midClausePauses = this.midClausePauses.filter((time) => time > cutoff);
  }

  private observe(atMs: number): void {
    if (this.firstEventMs === null) {
      this.firstEventMs = atMs;
    }
    this.observedMs = Math.max(this.observedMs, atMs - this.firstEventMs);
  }

  private cooledDown(lastMs: number | null, nowMs: number): boolean {
    return lastMs === null || nowMs - lastMs >= this.profile.tipCooldownMs;
  }
}
