/**
 * Confidence model (spec §31.7, §30.5) — combines normalized alignment
 * score, matched-evidence volume, continuity prior, transcript confidence,
 * and final-vs-provisional status into a calibrated-ish [0, 1] value.
 * The margin over the second candidate is applied by the decision layer.
 */
import type { TrackingProfile } from './profile';
import type { SequenceAlignment } from './types';

export interface ConfidenceInput {
  sequence: SequenceAlignment;
  prior: number;
  /** Mean transcript/model confidence over the tail (1 when unavailable). */
  transcriptConfidence: number;
  final: boolean;
}

export function confidenceModel(input: ConfidenceInput, profile: TrackingProfile): number {
  const { sequence } = input;
  if (sequence.contentMatches === 0) return 0;

  // Evidence-volume factor: saturates around the profile's lock requirement
  // so one or two lucky words cannot reach the locked threshold (§30.5.6).
  const volume = Math.min(1, sequence.contentMatches / profile.minimumLockContentMatches);

  // Continuity of the matched run (§31.7 "length and continuity").
  const runFactor = Math.min(1, 0.55 + 0.15 * sequence.longestOrderedRun);

  // Rare anchors add trust (§31.7 "weighted anchor total").
  const anchorBoost = Math.min(0.08, 0.03 * sequence.rareAnchorMatches);

  // Transcript/model confidence contributes but cannot rescue weak lexical
  // evidence (§30.5 layering).
  const transcriptFactor = 0.85 + 0.15 * Math.max(0, Math.min(1, input.transcriptConfidence));

  // Provisional text is inherently less trustworthy (§31.7, §31.8).
  const finalFactor = input.final ? 1 : 0.92;

  const confidence =
    sequence.normalizedScore * volume * runFactor * transcriptFactor * finalFactor * input.prior +
    anchorBoost;

  return Math.max(0, Math.min(1, confidence));
}
