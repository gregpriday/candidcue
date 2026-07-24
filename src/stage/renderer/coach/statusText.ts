/**
 * §8.3 variety tile, §8.4 filler summary, and the §12.7 microphone status line.
 *
 * All three are pure formatting: the rail states what the payload says and
 * invents nothing. In particular §8.3 shows `VARIETY —` + `LEARNING` before
 * calibration rather than a score the analyzer has not earned yet, and §8.4's
 * `degraded` flag deliberately produces no stage output at all — the spec is
 * explicit that incomplete filler recall is disclosed in settings and must not
 * become a permanent warning on the presenter's glass.
 */
import type {
  FillerDisplayState,
  MicrophoneCoachState,
  VarietyDisplayState,
  VarietyState,
} from '../../../shared/contracts/coaching';
import { UNKNOWN_VALUE } from './paceTile';

export const VARIETY_STATE_LABEL: Record<VarietyState, string> = {
  learning: 'LEARNING',
  very_steady: 'VERY STEADY',
  steady: 'STEADY',
  balanced: 'BALANCED',
  expressive: 'EXPRESSIVE',
  highly_animated: 'HIGHLY ANIMATED',
  low_confidence: 'LOW CONFIDENCE',
};

export interface VarietyTileView {
  /** A whole 0–100 score, or `—`. */
  number: string;
  label: string;
}

export function varietyTileView(variety: VarietyDisplayState): VarietyTileView {
  const unknown =
    variety.level === null ||
    !Number.isFinite(variety.level) ||
    variety.state === 'learning' ||
    // A score we do not trust is not a score. §8.3 gives `LOW CONFIDENCE` its
    // own label precisely so the number does not have to carry the doubt.
    variety.state === 'low_confidence';
  return {
    number: unknown ? UNKNOWN_VALUE : String(Math.round(variety.level as number)),
    label: VARIETY_STATE_LABEL[variety.state],
  };
}

/** §8.4: a take-local count of confirmed events only. */
export function fillerSummaryText(fillers: FillerDisplayState): string {
  return `FILLERS ${Math.max(0, Math.round(fillers.confirmedCount))}`;
}

/**
 * §12.7 / §25.1. A sustained microphone fault the presenter can act on, in
 * authored words — never a raw status token, never a number.
 *
 * This is the rail's own floor, not a duplicate of the mic tips: if the coach
 * policy is stalled or suppressed, the presenter still learns that the take is
 * being recorded badly. It is shown in the same single centre slot as the tip,
 * so there is never a second message surface (§9.1).
 */
export function microphoneAlertText(microphone: MicrophoneCoachState): string | null {
  if (microphone.sustained) {
    switch (microphone.status) {
      case 'clipping':
        return 'MIC IS CLIPPING';
      case 'low_level':
        return 'MIC LEVEL IS LOW';
      case 'noisy':
        return 'BACKGROUND NOISE IS HIGH';
      case 'no_signal':
        return 'NO MIC SIGNAL';
      case 'disconnected':
        return 'MIC DISCONNECTED';
      default:
        break;
    }
  }
  // A disconnected microphone is critical whether or not anything had time to
  // "sustain": there is nothing left to sustain.
  if (microphone.status === 'disconnected') return 'MIC DISCONNECTED';
  if (microphone.transcriptionDegraded) return 'TRANSCRIPTION DEGRADED';
  return null;
}
