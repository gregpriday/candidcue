/**
 * Tracking profile (spec Appendix A.7) — every scoring weight, threshold, and
 * window size used by the alignment engine lives here so the evaluation
 * package can tune release defaults without touching engine code.
 *
 * The `v2` block carries the numeric parameters introduced by the companion
 * specification (`CandidCue_Smooth_Following_and_Intelligent_Alignment_
 * Specification.md`) that are *not* part of the shared seam contract's
 * `SmoothFollowProfile`. Seam-owned values (beam width, prediction horizons,
 * retake persistence, semantic influence bound, motion limits) always come
 * from `SmoothFollowProfile`; everything else lives here. Nothing numeric may
 * be inlined in engine code.
 */
import {
  DEFAULT_SMOOTH_FOLLOW_PROFILE,
  isInterpretableSmoothFollowProfile,
  type SmoothFollowProfile,
} from '../contracts/smooth-follow';

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
  /**
   * Structure-relative clamps for the distances above (see `scales.ts`). Each
   * absolute count is the ceiling; on a section (or sentence) shorter than the
   * constant assumed, the fraction takes over. Without these, a script made of
   * short beats has a `largeForwardDistance` covering most of a section and a
   * provisional advance longer than the boundary corridor.
   */
  largeForwardMaxFraction: number;
  provisionalAdvanceMaxFraction: number;
  /** Continuity/section candidate windows, as a fraction of the section. */
  continuityWindowMaxFraction: number;
  /** Hard ceiling on any single candidate window, in tokens (§63). */
  maxCandidateWindowTokens: number;
  /** Anchor positions considered per transcript word, nearest first (§63). */
  maxAnchorPositionsPerWord: number;
  /**
   * Repetition allowance for a *global* anchor (§23.1, §23.2), expressed as
   * script tokens per permitted repeat.
   *
   * §23.2: "never use one common repeated phrase as a large-jump trigger." The
   * question that rule leaves open is what counts as *common*, and a bare
   * occurrence count cannot answer it: a phrase said twice in a ninety-token
   * social clip is that clip's refrain, while a phrase said twice in a
   * six-thousand-token keynote is nearly unique. So the allowance grows with
   * the script instead of being fixed — one permitted repeat per this many
   * spoken tokens, floor one. This is the `scales.ts` discipline applied to a
   * *count* rather than a distance: the structure-relative term takes over
   * exactly where the constant would have stopped meaning what it says.
   */
  globalAnchorTokensPerRepeat: number;

  /* Retake behavior (spec §31.12). */
  retakeBoundaryToleranceTokens: number;
  /**
   * Spans held by the recently-visited ring buffer (§14.4). A fixed capacity,
   * so both memory and the §21.1 lookup stay flat in script length (§63);
   * consecutive commits coalesce, so one span is a whole paragraph read
   * straight through rather than one token.
   */
  visitedSpanCapacity: number;
  /**
   * How long a visited span stays "recent" for §21.1 retake evidence.
   *
   * Milliseconds rather than tokens on purpose. Token distances in this
   * profile all needed `scales.ts` clamping because forty tokens is a clause
   * in a keynote and most of a social clip; a recency bound is a property of
   * the presenter's working memory, not of the script, and means the same
   * thing at both scales.
   */
  retakeVisitedWithinMs: number;
  shortRetakeMaxDistance: number;
  shortRetakeThreshold: number;

  /* Manual correction (spec §31.15). */
  manualCorrectionGraceMs: number;
  /**
   * Hard ceiling on a COMMAND_PENDING freeze (spec §33.4.4, §33.11). The
   * aligner integrates nothing while pending, so an unresolved command — a
   * handoff that never returns, an IPC call without a timeout — otherwise
   * stops the teleprompter for the rest of the take with no recovery path.
   */
  commandPendingTimeoutMs: number;

  /**
   * Minimum interval between emitted semantic scheduling contexts (companion
   * §36.3, §63).
   *
   * The candidate list is the sidecar's only input, and building it costs real
   * work (script text per candidate). Emitting it on every transcript event
   * would add that work to the ~19 ms per-event alignment budget, which has no
   * headroom. The sidecar's own fastest cadence is a 1.5 s burst interval, so
   * sampling the candidate set at 2 Hz is already three times more often than
   * anything downstream can act on. Set to 0 to disable emission entirely.
   */
  semanticContextIntervalMs: number;

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

  /* ---------------------------------------------------------------------
   * Alignment v2 (companion specification). See DEFAULT_TRACKING_PROFILE
   * for the citation of every starting value.
   * ------------------------------------------------------------------- */

  /* Weighted speech units (companion §6.1). */
  unitStopwordWeight: number;
  unitNormalWeight: number;
  unitLongWeight: number;
  unitLongTokenChars: number;
  unitShortTokenChars: number;
  unitSentenceEndPause: number;
  unitBlockEndPause: number;
  /**
   * §6.1 "comma or light clause boundary: virtual pause weight". Smaller than
   * a sentence end because a clause break is a breath, not a full stop.
   */
  unitClausePause: number;
  /**
   * §6.1 "explicit pause directive: authored duration or weight". The syntax
   * (`[Beat]`, `[Pause]`, `[Breathe]`) carries no duration, so the *only*
   * thing an implementation can honour is the relative length the three words
   * already mean in stage direction.
   */
  unitBeatPause: number;
  unitAuthoredPause: number;
  unitBreathePause: number;
  /** Spoken units in one rendered line — the stage refines this (A.3). */
  unitsPerRenderedLine: number;

  /* Multiple transcript tails (companion §15.2, A.2). */
  tailShortTokens: number;
  tailMediumTokens: number;
  tailLongTokens: number;

  /* Beam maintenance (companion §16). */
  beamMergeTokens: number;
  hypothesisDecay: number;
  minHypothesisWeight: number;
  hypothesisSoftmaxTemperature: number;
  hypothesisInheritanceFactor: number;
  tailAgreementBonus: number;
  holdBranchScoreFactor: number;

  /* Section eligibility graph (companion §13, B.2). */
  sectionBoundaryForwardTokens: number;
  sectionBoundaryBackwardTokens: number;
  /** Boundary corridors may never exceed this fraction of a section (§13). */
  sectionBoundaryMaxFraction: number;
  recentBoundaryCrossingMs: number;

  /* Semantic filter (companion §24.2.1). */
  filterProcessNoiseFollowing: number;
  filterProcessNoiseUncertain: number;
  filterProcessNoiseAcquiring: number;
  filterMeasurementNoiseFinal: number;
  filterMeasurementNoiseProvisional: number;
  filterInnovationClampUnits: number;
  filterMaxVelocityUnitsPerSecond: number;
  filterMaxAccelerationUnitsPerSecond2: number;
  filterInitialVariance: number;
  filterSemanticOnlyVarianceFactor: number;
  filterBeamVarianceFactor: number;
  filterUncertainInnovationFactor: number;
  filterVelocityScheduleGain: number;

  /* Pace estimator (companion §24.4–§24.5, A.1). */
  paceShortWindowMs: number;
  paceBaselineWindowMs: number;
  paceMinSamples: number;
  paceTrimFraction: number;
  paceMinUnitsPerSecond: number;
  paceMaxUnitsPerSecond: number;
  paceVelocityBlendWeight: number;
  paceProvisionalQuality: number;
  paceMinQuality: number;

  /* Ad-lib coast → decelerate → hold schedule (companion §19.2). */
  adlibCoastMs: number;
  adlibDecayMs: number;
  adlibSettleMs: number;
  adlibResidualVelocityFraction: number;

  /* Semantic motion frames (companion §26.1). */
  maxFramesPerSecond: number;
  heldFrameIntervalMs: number;
  frameUnitEpsilon: number;
  frameVelocityEpsilon: number;

  /* Transition directives (companion §53, A.3). */
  transitionTtlMs: number;
  absorbRenderedLines: number;
  catchUpRenderedLines: number;

  /* Semantic assist (companion §40). */

  /* Diagnostics ring buffer (companion §65). */
  decisionLogCapacity: number;
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
  // A "large" forward move must stay large *relative to the section*: a third
  // of a chapter, never two thirds of a short one.
  largeForwardMaxFraction: 0.34,
  // Provisional evidence may never advance further than the boundary corridor
  // it is not allowed to cross (§13 vs §31.8).
  provisionalAdvanceMaxFraction: 0.2,
  continuityWindowMaxFraction: 1.0, // windows may span their own section
  maxCandidateWindowTokens: 600, // §63 per-event cost must not track script length
  maxAnchorPositionsPerWord: 6, // §63 nearest anchors only
  globalAnchorTokensPerRepeat: 2000, // §23.2 distinctiveness allowance

  retakeBoundaryToleranceTokens: 3, // G.5 isSentenceOrParagraphStart(pos, 3)
  visitedSpanCapacity: 32, // §14.4 recently visited span ring buffer
  retakeVisitedWithinMs: 30_000, // §21.1 "the destination was visited recently"
  shortRetakeMaxDistance: 25, // §31.12 restart inside the current paragraph
  shortRetakeThreshold: 0.8, // §31.12 lower threshold for short restarts

  manualCorrectionGraceMs: 2500, // §31.15 suppression grace period
  commandPendingTimeoutMs: 4_000, // §33.11 — a bounded stall, never an open one
  semanticContextIntervalMs: 500, // companion §36.3 — 2 Hz, see the field docs

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

  /* --- companion specification (alignment v2) ------------------------- */

  unitStopwordWeight: 0.75, // companion §6.1 short function word 0.65–0.85
  unitNormalWeight: 1.0, // companion §6.1 ordinary word
  unitLongWeight: 1.45, // companion §6.1 long word 1.1–1.8
  unitLongTokenChars: 9, // "long or multi-syllable" heuristic
  unitShortTokenChars: 4, // below this a content word is not "long"
  unitSentenceEndPause: 1.6, // companion §6.1 sentence-ending virtual pause
  unitBlockEndPause: 2.4, // companion §6.1 paragraph pause
  unitClausePause: 0.6, // companion §6.1 comma/light clause boundary
  unitBeatPause: 1.6, // [Beat] — about one sentence end
  unitAuthoredPause: 2.4, // [Pause] — about one paragraph break
  unitBreathePause: 3.2, // [Breathe] — the longest of the three
  unitsPerRenderedLine: 9, // companion §7/A.3 pre-layout estimate

  tailShortTokens: 9, // A.2 short tail 6–12 meaningful tokens
  tailMediumTokens: 18, // A.2 medium tail 12–24
  tailLongTokens: 36, // A.2 long finalized tail 24–50

  beamMergeTokens: 4, // §16 step 8 "merge near-identical hypotheses"
  hypothesisDecay: 0.55, // §16 unsupported branches fade rather than vanish
  minHypothesisWeight: 0.01, // §16 step 9 pruning floor
  hypothesisSoftmaxTemperature: 0.18, // §16 step 7 score normalization
  hypothesisInheritanceFactor: 0.15, // §16.1 continuity bonus for a surviving branch
  tailAgreementBonus: 0.03, // §15.2 bounded bonus for independent tail agreement
  holdBranchScoreFactor: 0.72, // §16.2 hold/ad-lib branch prior, relative to soft evidence

  // §13/B.2 boundary corridors. These must stay tight: "reading has reached
  // the boundary" means roughly the last sentence, not the last third of a
  // chapter. SectionGraph additionally clamps them to a fraction of the
  // section's own length so a short section can never be mostly "corridor".
  sectionBoundaryForwardTokens: 14,
  sectionBoundaryBackwardTokens: 10,
  sectionBoundaryMaxFraction: 0.34, // §13 corridor ≪ section
  recentBoundaryCrossingMs: 12_000, // §13 "recent-boundary window"

  filterProcessNoiseFollowing: 0.05, // §24.2.1 low Q while stable
  filterProcessNoiseUncertain: 0.012, // §24.2.1 tightly constrained while uncertain
  filterProcessNoiseAcquiring: 0.6, // §24.2.1 higher while acquiring/returning
  filterMeasurementNoiseFinal: 0.35, // §24.2.1 low R for final distinctive matches
  filterMeasurementNoiseProvisional: 2.5, // §24.2.1 high R for provisional
  filterInnovationClampUnits: 14, // §24.2 bounded innovation
  filterMaxVelocityUnitsPerSecond: 8, // §24.2.1 plausible speech profile bound
  filterMaxAccelerationUnitsPerSecond2: 6, // §24.2.1
  filterInitialVariance: 25, // §24.2.1 diffuse prior before acquisition
  filterSemanticOnlyVarianceFactor: 2.5, // §24.2.1 semantically inferred match ⇒ high R
  filterBeamVarianceFactor: 0.25, // §24.2.1 R also reflects beam position variance
  filterUncertainInnovationFactor: 0.35, // B.3 tighter clamp while uncertain
  filterVelocityScheduleGain: 6, // §19.2 dt-normalized approach rate to the schedule

  paceShortWindowMs: 5_500, // A.1 short-term pace window 3–8 s
  paceBaselineWindowMs: 30_000, // A.1 baseline pace window 15–45 s
  paceMinSamples: 2, // §24.4 need more than one span to trust a rate
  paceTrimFraction: 0.2, // §24.4 robust trimming before the baseline update
  paceMinUnitsPerSecond: 0.4, // §24.4 implausible-rate rejection floor
  paceMaxUnitsPerSecond: 8, // §24.4 implausible-rate rejection ceiling
  paceVelocityBlendWeight: 0.35, // §24.2.1 weight of the optional H_v update
  paceProvisionalQuality: 0.3, // §24.3 provisional spans are noisy observations
  paceMinQuality: 0.2, // §24.3 floor so a weak final span still counts a little

  adlibCoastMs: 200, // §19.2 step 1: 150–250 ms
  adlibDecayMs: 350, // §19.2 step 2: 250–450 ms
  adlibSettleMs: 900, // §19.2 step 3: 700–1100 ms
  adlibResidualVelocityFraction: 0.375, // §19.2 step 2: 30–45 %

  maxFramesPerSecond: 30, // §26.1 "15–30 Hz when values change"
  heldFrameIntervalMs: 250, // §26.1 "less frequently while held"
  frameUnitEpsilon: 0.01, // §26.1 change detection
  frameVelocityEpsilon: 0.02,

  transitionTtlMs: 1_500, // §53 directives expire rather than linger
  absorbRenderedLines: 1, // A.3 "< 0.5–1 line" → absorb
  catchUpRenderedLines: 3, // A.3 "~1–3 lines" → catch up, beyond → re-anchor


  decisionLogCapacity: 64, // §65 bounded "why did it move?" ring buffer
};

export function resolveTrackingProfile(partial?: Partial<TrackingProfile>): TrackingProfile {
  return { ...DEFAULT_TRACKING_PROFILE, ...(partial ?? {}) };
}

/** A section-wise partial of the seam-owned `SmoothFollowProfile`. */
export type PartialSmoothFollowProfile = {
  [K in keyof SmoothFollowProfile]?: SmoothFollowProfile[K] extends object
    ? Partial<SmoothFollowProfile[K]>
    : SmoothFollowProfile[K];
};

/**
 * Merge a partial smooth-follow profile over the seam defaults (companion
 * §55). Sections merge independently so a caller can override only, say,
 * `alignment.beamWidth` without restating the rest.
 *
 * Interpretability is checked on the MERGED result, exactly as the stage checks
 * the profile it is handed (`stageFollowProfile` →
 * `isInterpretableSmoothFollowProfile`). The aligner is the other half of
 * following, so it has to answer "can I run this?" the same way the stage does
 * or the two halves diverge silently:
 *
 *   - a partial that names no `version` inherits the base version and merges
 *     normally — that is the ordinary override case and is unaffected;
 *   - a profile that declares a version this build does not interpret, or that
 *     carries a non-finite number, falls back WHOLE to the default rather than
 *     being partially applied. A version bump means a field's meaning changed,
 *     so half-applying it produces motion that is neither the sender's profile
 *     nor the one this build was tuned against.
 */
export function resolveSmoothFollowProfile(
  partial?: PartialSmoothFollowProfile,
): SmoothFollowProfile {
  const base = DEFAULT_SMOOTH_FOLLOW_PROFILE;
  if (partial === undefined) return base;
  const merged: SmoothFollowProfile = {
    version: partial.version ?? base.version,
    id: partial.id ?? base.id,
    prediction: { ...base.prediction, ...(partial.prediction ?? {}) },
    alignment: { ...base.alignment, ...(partial.alignment ?? {}) },
    motion: { ...base.motion, ...(partial.motion ?? {}) },
    coaching: { ...base.coaching, ...(partial.coaching ?? {}) },
  };
  return isInterpretableSmoothFollowProfile(merged) ? merged : base;
}
