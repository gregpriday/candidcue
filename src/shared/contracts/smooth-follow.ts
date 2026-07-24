/**
 * Smooth-following and intelligent-alignment contracts (companion specification:
 * `docs/CandidCue_Smooth_Following_and_Intelligent_Alignment_Specification.md`).
 *
 * This module owns the *seam* types shared across the v2 following system:
 *
 *   tracking worker ──SemanticMotionFrame──▶ stage frame loop
 *   stage frame loop ──StageMotionAck──▶ control diagnostics
 *   stage layout ──RenderedLineMap──▶ stage line-handoff planner
 *
 * Per companion §0.1 these types extend — and in places replace — the primary
 * specification's tracking/motion contracts. The primary `TrackingSnapshot`
 * (contracts/tracking.ts) remains the control-side view model; `SemanticMotionFrame`
 * is the higher-rate, motion-oriented projection the stage consumes.
 *
 * Numeric defaults live in `DEFAULT_SMOOTH_FOLLOW_PROFILE` (companion Appendix A).
 * They are versioned starting points for evaluation, never scattered constants.
 */

/** Companion §52. Why the tracker believes the presenter moved. */
export type TrackingBehavior =
  | 'acquire'
  | 'normal'
  | 'minor_variation'
  | 'paraphrase'
  | 'adlib'
  | 'return'
  | 'small_skip'
  | 'large_skip'
  | 'retake_candidate'
  | 'retake'
  | 'manual_navigation'
  | 'command_navigation'
  | 'lost';

/** Companion §52/§17. The tracker's operating state. */
export type TrackingStateV2 =
  | 'acquiring'
  | 'following'
  | 'coasting'
  | 'uncertain'
  | 'adlib_hold'
  | 'catching_up'
  | 'retake_pending'
  | 'rewinding'
  | 'reanchoring'
  | 'command_pending'
  | 'paused'
  | 'reconnecting'
  | 'lost_local';

/**
 * Companion §53. An authorized, bounded discontinuity in the visual trajectory.
 * Only one directive may be active at a time; directives are idempotent by `id`,
 * so a re-sent directive must never re-run the motion.
 */
export interface StageTransitionDirective {
  id: string;
  type: 'none' | 'settle' | 'catch_up' | 'rewind' | 'reanchor' | 'reset';
  authority: 'ordinary' | 'command' | 'manual';
  fromUnit: number;
  toUnit: number;
  destinationTokenIndex: number;
  destinationLineHint?: string;
  issuedAtMs: number;
  expiresAtMs: number;
  semanticEpoch: number;
  reason:
    | 'large_forward_skip'
    | 'distant_retake'
    | 'command_navigation'
    | 'manual_navigation'
    | 'layout_recovery'
    | 'session_reset';
}

/**
 * Companion §26.1. Emitted by the tracking worker at 15–30 Hz while values change,
 * and less frequently while held. The stage discards frames with a stale revision,
 * a mismatched epoch, a different script compile hash, or an old layout generation.
 *
 * Position is expressed in *spoken units* (companion §6) — a weighted, continuous
 * coordinate — not in pixels. The stage owns the units→pixels mapping.
 */
export interface SemanticMotionFrame {
  sessionId: string;
  sessionGeneration: number;
  scriptCompileHash: string;
  layoutGeneration: number;
  revision: number;
  epoch: number;
  sessionTimeMs: number;

  estimatedUnit: number;
  committedUnit: number;
  velocityUnitsPerSecond: number;
  accelerationUnitsPerSecond2: number;
  positionVariance: number;
  confidence: number;

  sectionId: string;
  tokenIndex: number;
  sentenceId: string;
  blockId: string;
  state: TrackingStateV2;
  behavior: TrackingBehavior;
  finalEvidence: boolean;

  transition?: StageTransitionDirective;
  motionProfileId: string;
}

/**
 * Companion §54. Periodic stage report used for diagnostics and recovery.
 * This is deliberately NOT a high-frequency feedback loop into the aligner.
 */
export interface StageMotionAck {
  sessionId: string;
  revision: number;
  epoch: number;
  layoutGeneration: number;
  actualScrollPx: number;
  actualVelocityPxPerSecond: number;
  targetScrollPx: number;
  activeLineId: string | null;
  controllerState: string;
  droppedFrameCountWindow: number;
  renderedAtMs: number;
}

/** Companion §7. One measured line box in the current layout generation. */
export interface RenderedLine {
  lineId: string;
  blockId: string;
  sectionId: string;
  firstTokenIndex: number;
  lastTokenIndex: number;
  spokenUnitStart: number;
  spokenUnitEnd: number;
  topY: number;
  baselineY: number;
  bottomY: number;
  nextBaselineY: number | null;
  visibleTextWidthPx: number;
  tokenStops: RenderedTokenStop[];
  startsParagraph: boolean;
  endsParagraph: boolean;
  startsSection: boolean;
  endsSection: boolean;
}

/** Companion §7. A measured token rect within a rendered line. */
export interface RenderedTokenStop {
  tokenIndex: number;
  spokenUnit: number;
  xStart: number;
  xEnd: number;
  visualFractionStart: number;
  visualFractionEnd: number;
}

/** Companion §7/§8. A control point on the monotone unit→scroll motion path. */
export interface LineMotionKnot {
  lineId: string;
  spokenUnit: number;
  scrollPx: number;
  slopePxPerUnit: number;
  boundaryKind: 'ordinary' | 'paragraph' | 'visual_block' | 'section';
}

/** Companion §7. The motion path sampled at one spoken unit. */
export interface LineMotionSample {
  scrollPx: number;
  derivativePxPerUnit: number;
  lineId: string | null;
  lineProgress: number;
}

/**
 * Companion §7. Immutable per layout generation, built only after fonts, images,
 * and stage scaling are final. `sampleMotionPath` must be monotone non-decreasing
 * in `spokenUnit` so ordinary following can never produce backward motion.
 */
export interface RenderedLineMap {
  generation: number;
  lines: RenderedLine[];
  motionKnots: LineMotionKnot[];
  sampleMotionPath(spokenUnit: number): LineMotionSample | null;
}

/**
 * Companion §7.2. The layout inputs a line map is valid for. Any change here
 * invalidates the map and requires a rebuild plus a `layout_recovery` transition.
 *
 * EVERY input that can move a rendered glyph belongs here. A field that changes
 * geometry but is missing from the fingerprint produces the worst failure mode
 * available: the map is silently rebuilt from new measurements under the OLD
 * generation, so control still believes the geometry it is addressing, and the
 * §33 semantic re-anchor that should have preserved the reading position never
 * runs. `sameLayout()` in `stage/motion/measure.ts` compares this type through
 * an exhaustive `Record<keyof LayoutFingerprint, …>` table so a field added here
 * fails compilation until it is classified there.
 */
export interface LayoutFingerprint {
  scriptCompileHash: string;
  stageGeneration: number;
  layoutGeneration: number;
  displayScaleFactor: number;
  viewportWidthPx: number;
  viewportHeightPx: number;
  fontFamily: string;
  fontHash?: string;
  fontSizePx: number;
  lineHeight: number;
  /** Tracking, em. Changes line wrapping without changing anything else. */
  letterSpacingEm: number;
  /** Vertical rhythm between blocks, em — changes every block's offset. */
  paragraphSpacingEm: number;
  marginTopPx: number;
  marginBottomPx: number;
  marginHorizontalPx: number;
  /**
   * Kept for the published §7.2 shape. The individual axes below are what the
   * measurement pass actually depends on: a vertical mirror inverts measured
   * viewport-space tops, a horizontal one does not.
   */
  mirrored: boolean;
  mirrorX: boolean;
  mirrorY: boolean;
  /** Reading-band centre, percent of the viewport — this is `R` in §8. */
  readingBandCenterPercent: number;
  /** Reading-band half height, percent of the viewport. */
  readingBandHalfHeightPercent: number;
  cueLayout: string;
  listenerGeometryHash: string;
}

/** Companion §55. Versioned, evaluable configuration for the whole following system. */
export interface SmoothFollowProfile {
  version: number;
  id: string;

  prediction: {
    normalHorizonMs: number;
    uncertainHorizonMs: number;
    maxCoastUnits: number;
    leadSecondsMin: number;
    leadSecondsMax: number;
    /**
     * Fastest spoken-unit rate the stage will believe, units/s.
     *
     * A frame's `velocityUnitsPerSecond` is a claim about how fast a human is
     * SPEAKING, and speech has a ceiling. Producers derive it by finite
     * difference, so a position correction — a skipped paragraph, a retake, a
     * command jump — divides a large unit delta by a small time delta and
     * reports a pace no mouth can produce. That number is then extrapolated
     * over the prediction horizon and becomes pixels.
     */
    maxUnitsPerSecond: number;
    /** Fastest believable CHANGE of speaking rate, units/s². */
    maxAccelerationUnitsPerSecond2: number;
  };

  alignment: {
    beamWidth: number;
    continuityBackTokens: number;
    continuityForwardTokens: number;
    sectionSearchLimit: number;
    retakePersistenceTokens: number;
    retakePersistenceMs: number;
    semanticInfluenceMax: number;
  };

  motion: {
    dampingRatio: number;
    naturalFrequency: number;
    maxForwardVelocityPxS: number;
    maxBackwardVelocityPxS: number;
    maxAccelerationPxS2: number;
    maxJerkPxS3: number;
    catchUpMultiplier: number;
    reverseTravelMaxPx: number;
    reanchorThresholdPx: number;
    restDeadbandPx: number;
  };

  coaching: {
    stageCooldownMs: number;
    controlCooldownMs: number;
    minimumConfidence: number;
  };
}

/**
 * Companion Appendix A. Midpoints of the published starting ranges; every value is
 * a calibration hypothesis to be tuned against the speech and motion corpus, not
 * product truth. Bump `version` whenever a field's meaning changes.
 */
export const DEFAULT_SMOOTH_FOLLOW_PROFILE: SmoothFollowProfile = {
  version: 1,
  id: 'default-v1',

  prediction: {
    // A.1: 600–900 ms normal, 150–400 ms uncertain, coast under one rendered line.
    normalHorizonMs: 750,
    uncertainHorizonMs: 275,
    maxCoastUnits: 0.9,
    leadSecondsMin: 0.15,
    leadSecondsMax: 0.6,
    // Conversational delivery runs 130–160 wpm and a fast read tops out near
    // 250 wpm; the fastest competitive speech ever recorded is about 640 wpm.
    // A spoken unit is a weighted token, so 8 units/s ≈ 480 wpm — far above
    // anything a presenter will ever do, and two orders of magnitude below the
    // rates a finite-difference producer emits across a position correction.
    maxUnitsPerSecond: 8,
    // Reaching that ceiling from a standstill inside a third of a second is
    // already faster than speech can change; anything above this is a
    // measurement artefact, not a pace.
    maxAccelerationUnitsPerSecond2: 24,
  },

  alignment: {
    // A.2: beam 8–16; retake persistence 3–6 meaningful final tokens.
    beamWidth: 12,
    continuityBackTokens: 80,
    continuityForwardTokens: 260,
    sectionSearchLimit: 4,
    retakePersistenceTokens: 4,
    retakePersistenceMs: 2500,
    // Luna is bounded to a modest fraction of the decision margin (§40, A.2).
    semanticInfluenceMax: 0.25,
  },

  motion: {
    dampingRatio: 1.0,
    naturalFrequency: 6.5,
    maxForwardVelocityPxS: 900,
    maxBackwardVelocityPxS: 600,
    maxAccelerationPxS2: 2600,
    maxJerkPxS3: 12000,
    catchUpMultiplier: 1.6,
    reverseTravelMaxPx: 420,
    reanchorThresholdPx: 360,
    restDeadbandPx: 1.5,
  },

  coaching: {
    // A.5: 6–10 s stage cooldown, one visible tip, never from provisional evidence.
    stageCooldownMs: 8000,
    controlCooldownMs: 15000,
    minimumConfidence: 0.8,
  },
};

/** Companion §35. How much semantic (Luna) assistance the session may use. */
export type IntelligenceMode = 'local_only' | 'balanced' | 'enhanced';
