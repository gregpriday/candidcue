/**
 * Continuity prior (spec §31.6) — position probability is not uniform.
 * Returns a multiplicative factor in (0, 1] applied to sequence evidence.
 */
import type { DocumentIndex } from './document-index';
import type { TrackingProfile } from './profile';
import type { CandidateScope } from './types';
import type { TrackingState } from '../contracts/tracking';

export interface PriorInput {
  from: number;
  to: number;
  scope: CandidateScope;
  state: TrackingState;
  final: boolean;
  /** Milliseconds since the last confident (locked) match. */
  msSinceConfident: number;
  /** The transcript repeats a previously read paragraph opening (§31.6). */
  repeatedOpening: boolean;
  /** Distinctive rare anchors matched by this candidate. */
  rareAnchorMatches: number;
}

const SCOPE_FACTOR: Record<CandidateScope, number> = {
  navigation: 1.0, // explicit command target (§31.3.6)
  continuity: 1.0,
  retake: 0.97,
  section: 0.94,
  checkpoint: 0.92,
  rare_anchor: 0.86,
  ngram: 0.86,
  global: 0.8,
};

export function continuityPrior(
  index: DocumentIndex,
  input: PriorInput,
  profile: TrackingProfile,
): number {
  const distance = input.to - input.from;
  let factor = SCOPE_FACTOR[input.scope] ?? 0.8;

  if (distance >= 0) {
    if (distance <= 8) {
      // Small forward progress is expected (§31.6).
      factor *= 1.0;
    } else if (distance <= profile.largeForwardDistance) {
      // Moderate forward skips are plausible.
      factor *= 1 - 0.15 * (distance / profile.continuityForwardTokens);
    } else if (distance <= profile.continuityForwardTokens) {
      // §31.11: distance prior is acceptable *or* rare anchors are strong.
      factor *= input.rareAnchorMatches >= profile.minimumGlobalAnchorCount ? 0.95 : 0.82;
    } else {
      // Global forward jump: plausible only with multiple distinctive anchors.
      factor *= input.rareAnchorMatches >= profile.minimumGlobalAnchorCount ? 0.78 : 0.55;
    }
  } else {
    const back = -distance;
    if (back <= profile.backwardDistanceStrictAfter) {
      // Short backward restart after repetition is plausible (§31.6).
      factor *= input.repeatedOpening ? 0.95 : 0.85;
    } else if (index.sameSection(input.from, input.to)) {
      factor *= input.repeatedOpening ? 0.85 : 0.7;
    } else {
      // Distant backward jump is rare without an explicit command.
      factor *= input.rareAnchorMatches >= profile.minimumGlobalAnchorCount ? 0.6 : 0.45;
    }
  }

  // Crossing a section boundary is less likely than staying inside (§31.6).
  if (!index.sameSection(input.from, input.to) && Math.abs(distance) <= profile.continuityForwardTokens) {
    factor *= 0.92;
  }

  // The longer we have been without a confident match, the flatter the
  // prior becomes; §31.14 explicitly allows strong anchors to overcome
  // section/distance priors so global reacquisition stays reachable above
  // the global threshold.
  if (input.state === 'searching' || input.msSinceConfident > profile.lostAfterMs) {
    factor = Math.max(
      factor,
      input.rareAnchorMatches >= profile.minimumGlobalAnchorCount ? 0.97 : 0.8,
    );
  }

  // Provisional (non-final) evidence flattens nothing — it simply cannot
  // commit large movement (§31.8); keep the prior slightly stricter.
  if (!input.final) factor *= 0.97;

  return Math.max(0.05, Math.min(1, factor));
}
