/**
 * Tracking profile (spec Appendix A.7) — every scoring weight, threshold, and
 * window size used by the alignment engine lives here so the evaluation
 * package can tune release defaults without touching engine code.
 */

export interface TrackingProfile {
  profileVersion: 1;

  /* Candidate windows (spec §31.3, G.2). */
  continuityBackTokens: number;
  continuityForwardTokens: number;
  checkpointBackTokens: number;
  checkpointForwardTokens: number;
  anchorBackTokens: number;
  anchorForwardTokens: number;
  maxCandidateWindows: number;

  /* Transcript tail (spec §31.5). */
  recentTranscriptMinContentTokens: number;
  recentTranscriptMaxTokens: number;

  /* Confidence thresholds (spec §31.7, A.7). */
  lockedThreshold: number;
  softThreshold: number;
  globalThreshold: number;
  backwardThreshold: number;
  backwardDistanceStrictAfter: number;
  minimumGlobalAnchorCount: number;
  minimumBackwardContentMatches: number;
  minimumLockContentMatches: number;
  minimumBackwardMargin: number;
  minimumForwardMargin: number;
  /** Margin below which two near-tied candidates force a hold (spec §31.13). */
  ambiguityMargin: number;

  /* Lost detection (spec §31.14, A.7). */
  lostAfterMs: number;
  lostAfterContentTokens: number;
  /** Grace before weak evidence flips FOLLOWING → HOLDING (spec §31.10). */
  adLibGraceMs: number;

  /* Token weights (spec §25.2, A.7). */
  stopwordWeight: number;
  normalWeight: number;
  rareWeight: number;

  /* Match feature scores (spec §31.4, A.7). */
  exactScore: number;
  explicitAliasScore: number;
  equivalentScore: number;
  fuzzyScore: number;
  phoneticScore: number;
  weakScore: number;
  transcriptInsertionPenalty: number;
  scriptGapPenalty: number;
  fillerInsertionPenalty: number;

  /* Provisional-vs-final policy (spec §31.8). */
  maxProvisionalAdvanceTokens: number;
  largeForwardDistance: number;

  /* Retake behavior (spec §31.12). */
  retakeBoundaryToleranceTokens: number;
  shortRetakeMaxDistance: number;
  shortRetakeThreshold: number;

  /* Manual correction (spec §31.15). */
  manualCorrectionGraceMs: number;

  /* Snapshot cadence (spec §31.16). */
  maxSnapshotsPerSecond: number;

  /* Stage coupling (spec §32). */
  leadConfidence: number;
  maxLeadTokens: number;
  provisionalBackwardPx: number;
  provisionalForwardPx: number;
  readingBandPercent: number;
  readingBandMinPercent: number;
  readingBandMaxPercent: number;
  deadBandPx: number;
  microMovementPx: number;
  normalFollowMsMin: number;
  normalFollowMsMax: number;
  skipTransitionMsMin: number;
  skipTransitionMsMax: number;
  retakeTransitionMsMin: number;
  retakeTransitionMsMax: number;
  commandTransitionMs: number;
}

/**
 * Release defaults. Numeric values marked A.7 are the spec's illustrative
 * initial profile; the rest derive from §31–§32 prose (documented inline).
 */
export const DEFAULT_TRACKING_PROFILE: TrackingProfile = {
  profileVersion: 1,

  continuityBackTokens: 80, // A.7
  continuityForwardTokens: 260, // A.7
  checkpointBackTokens: 20, // G.2 windowAround(checkpoint, -20, 100)
  checkpointForwardTokens: 100,
  anchorBackTokens: 40, // G.2 windowAround(position, -40, 120)
  anchorForwardTokens: 120,
  maxCandidateWindows: 24,

  recentTranscriptMinContentTokens: 4, // A.7
  recentTranscriptMaxTokens: 30, // A.7

  lockedThreshold: 0.78, // A.7 / §31.7
  softThreshold: 0.58, // A.7 / §31.7
  globalThreshold: 0.84, // A.7 / §31.7
  backwardThreshold: 0.9, // A.7 / §31.7
  backwardDistanceStrictAfter: 12, // A.7 / §31.7
  minimumGlobalAnchorCount: 2, // A.7 / §31.7
  minimumBackwardContentMatches: 5, // A.7 / §31.7
  minimumLockContentMatches: 4, // §31.7 "at least four useful content-word matches"
  minimumBackwardMargin: 0.12, // G.4 minimumBackwardMargin
  minimumForwardMargin: 0.05,
  ambiguityMargin: 0.08, // §31.13 near-tied candidates hold

  lostAfterMs: 1600, // A.7
  lostAfterContentTokens: 10, // A.7
  adLibGraceMs: 600, // §31.10 short grace period

  stopwordWeight: 0.35, // A.7
  normalWeight: 1.0, // A.7
  rareWeight: 1.5, // A.7

  exactScore: 3.0, // A.7 / §31.4
  explicitAliasScore: 2.8, // A.7 / §31.4
  equivalentScore: 2.6, // A.7 / §31.4
  fuzzyScore: 1.7, // A.7 / §31.4
  phoneticScore: 1.4, // A.7 / §31.4
  weakScore: 0.5, // §31.4 weak/common-word match
  transcriptInsertionPenalty: -0.45, // A.7
  scriptGapPenalty: -0.8, // A.7
  fillerInsertionPenalty: -0.05, // §30.6 near-zero penalty

  maxProvisionalAdvanceTokens: 18, // §31.8 bounded provisional advance
  largeForwardDistance: 40, // §31.6/§31.11 moderate-vs-large forward boundary

  retakeBoundaryToleranceTokens: 3, // G.5 isSentenceOrParagraphStart(pos, 3)
  shortRetakeMaxDistance: 25, // §31.12 restart inside the current paragraph
  shortRetakeThreshold: 0.8, // §31.12 lower threshold for short restarts

  manualCorrectionGraceMs: 2500, // §31.15 suppression grace period

  maxSnapshotsPerSecond: 30, // §31.16

  leadConfidence: 0.78, // G.6 — lead only while confidently locked
  maxLeadTokens: 6, // §32.2 clamp lead to a fraction of a sentence
  provisionalBackwardPx: 0, // §31.8 provisional never moves backward
  provisionalForwardPx: 320,
  readingBandPercent: 38, // §32.5 default 38% from the top
  readingBandMinPercent: 20, // §32.5
  readingBandMaxPercent: 70, // §32.5
  deadBandPx: 24, // §32.5 dead band around the target
  microMovementPx: 40, // §32.3 micro movement threshold
  normalFollowMsMin: 180, // §32.3
  normalFollowMsMax: 350, // §32.3
  skipTransitionMsMin: 150, // §32.3
  skipTransitionMsMax: 250, // §32.3
  retakeTransitionMsMin: 180, // §32.3
  retakeTransitionMsMax: 300, // §32.3
  commandTransitionMs: 200, // §32.3 manual/command short transition
};

export function resolveTrackingProfile(partial?: Partial<TrackingProfile>): TrackingProfile {
  return { ...DEFAULT_TRACKING_PROFILE, ...(partial ?? {}) };
}
