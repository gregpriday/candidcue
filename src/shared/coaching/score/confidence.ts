/**
 * Speaking Score report §9.7 — evidence confidence — and §15's separation of
 * delivery from recording quality.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE
 * ---------------------------------------------------------------------------
 * §15: a recording fault "affects **evidence confidence** for dependent
 * metrics… It should not mechanically subtract, for example, 15 delivery
 * points." So clipping, a fan, a quiet preamp and dropouts all arrive here and
 * nowhere else in the engine. They lower how far the number may be trusted;
 * they never lower the number. A speaker on a bad microphone is not a worse
 * speaker, and the moment the score says otherwise the presenter stops
 * believing the rail about anything.
 *
 * The consequence, which is deliberate: on a badly clipping microphone the
 * score fades out rather than falling. §11.3 asks for exactly that — "fading
 * rather than showing a false low score when confidence collapses".
 */
import type {
  DeliveryScoreConfidenceTier,
  MicrophoneCoachState,
  PitchReliability,
} from '../../contracts/coaching';
import { CONFIDENCE_TIER_THRESHOLDS, type DeliveryScoreOptions } from './profile';

export interface ConfidenceComponents {
  /** Enough recent voiced audio *and* words (§9.7). */
  readonly coverage: number;
  /** VAD/pitch/energy are trustworthy — the only place a recording fault lands. */
  readonly signalQuality: number;
  /** Final or stable text is available (§9.8). */
  readonly transcriptStability: number;
  /** Enough personal baseline data exists (§8.1, §16.2). */
  readonly calibrationMaturity: number;
  /** `C = coverage × signal_quality × transcript_stability × calibration_maturity`. */
  readonly overall: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** A linear ramp from 0 at `lo` to 1 at `hi`, flat outside. */
export function ramp(value: number, lo: number, hi: number): number {
  if (!(hi > lo)) return value >= hi ? 1 : 0;
  return clamp01((value - lo) / (hi - lo));
}

/**
 * §9.7 coverage: "enough recent voiced audio and words".
 *
 * The weakest link, not the average. Three seconds of voiced audio with no
 * transcript is not two-thirds of the evidence needed to judge fluency; it is
 * no evidence at all about fluency, and averaging would hide that.
 */
export function coverageFrom(
  voicedMsInWindow: number,
  wordsInWindow: number,
  options: DeliveryScoreOptions,
): number {
  const voiced = ramp(voicedMsInWindow, 0, options.coverageVoicedMs);
  const words = ramp(wordsInWindow, 0, options.coverageWords);
  return Math.min(voiced, words);
}

/**
 * §9.7 signal quality, and §15's list of what belongs in it.
 *
 * Every value here is a *confidence multiplier*. `no_signal` and `disconnected`
 * take it to zero, which suppresses the score entirely rather than reporting a
 * zero delivery — the distinction the contract draws between "not measured" and
 * a judgement.
 *
 * `learning` is not a fault. It is the microphone monitor still establishing a
 * noise floor, and it resolves on its own within a few seconds.
 */
export function signalQualityFrom(
  microphone: MicrophoneCoachState,
  pitch: PitchReliability,
): number {
  let quality: number;
  switch (microphone.status) {
    case 'ok':
      quality = 1;
      break;
    case 'learning':
      quality = 0.75;
      break;
    case 'low_level':
      // §15: a quiet preamp lowers confidence in loudness-range and
      // trailing-off metrics. It says nothing about the speaker.
      quality = 0.7;
      break;
    case 'noisy':
      // §15: low SNR lowers VAD, pitch and acoustic-filler confidence.
      quality = 0.6;
      break;
    case 'clipping':
      // §15: clipping lowers pitch and spectral-feature confidence.
      quality = 0.5;
      break;
    case 'no_signal':
    case 'disconnected':
      return 0;
  }
  // §13.4. Unusable pitch does not zero the score — pace, pausing and fluency
  // are all still measurable — but it does mean a fifth of the evidence the
  // model wants is missing.
  if (!pitch.usable) quality *= 0.85;
  return clamp01(quality);
}

/**
 * §8.1 / §16.2 calibration maturity.
 *
 * Floored rather than started at zero: the §8 profile is a legitimate prior, so
 * an uncalibrated speaker is judged with less certainty, not with none. Capped
 * below 1 until the engine has heard enough of *this* speaker, which is what
 * makes `confident` unreachable in the first seconds of a take — §9.7 puts
 * calibration in the product for that reason.
 */
export function calibrationMaturityFrom(
  usableVoicedMs: number,
  options: DeliveryScoreOptions,
): number {
  const floor = clamp01(options.calibrationFloor);
  const progress = ramp(usableVoicedMs, 0, options.calibrationVoicedMs);
  return clamp01(floor + (1 - floor) * progress);
}

export function combineConfidence(
  coverage: number,
  signalQuality: number,
  transcriptStability: number,
  calibrationMaturity: number,
): ConfidenceComponents {
  const parts = {
    coverage: clamp01(coverage),
    signalQuality: clamp01(signalQuality),
    transcriptStability: clamp01(transcriptStability),
    calibrationMaturity: clamp01(calibrationMaturity),
  };
  return {
    ...parts,
    overall: clamp01(
      parts.coverage * parts.signalQuality * parts.transcriptStability * parts.calibrationMaturity,
    ),
  };
}

/**
 * §9.7's published ladder. The boundaries are read exactly as the table writes
 * them: below 0.35, 0.35–0.55, 0.55–0.75, above 0.75.
 */
export function confidenceTier(confidence: number): DeliveryScoreConfidenceTier {
  if (confidence < CONFIDENCE_TIER_THRESHOLDS.estimated) return 'warming_up';
  if (confidence < CONFIDENCE_TIER_THRESHOLDS.usable) return 'estimated';
  if (confidence <= CONFIDENCE_TIER_THRESHOLDS.confident) return 'usable';
  return 'confident';
}
