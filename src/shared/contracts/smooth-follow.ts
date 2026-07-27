/**
 * Stage motion contracts — the *geometry and plant* half of following.
 *
 *   Rust aligner ──AlignmentSnapshot──▶ stage frame loop  (contracts/alignment.ts)
 *   stage frame loop ──StageMotionAck──▶ control diagnostics
 *   stage layout ──RenderedLineMap──▶ stage line-handoff planner
 *
 * Everything about *where the presenter is* now lives in `contracts/alignment.ts`
 * and is decided by the Rust engine. What remains here is what the stage alone
 * can know: how its own text is laid out, and how fast a document may move
 * without looking like a scrollbar being dragged.
 *
 * Numeric defaults live in `DEFAULT_SMOOTH_FOLLOW_PROFILE` (companion Appendix A).
 * They are versioned starting points for evaluation, never scattered constants.
 */
import type { AlignmentState } from './alignment';

/**
 * What the motion layer is doing this frame.
 *
 * The four alignment states plus `paused`, which is the stage's own condition
 * rather than anything the engine reports: the presenter stopped the take, and
 * no amount of evidence about where they were reading changes that.
 */
export type StageMotionState = AlignmentState | 'paused';

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
 * Companion §54. Periodic stage report used for diagnostics and recovery.
 * This is deliberately NOT a high-frequency feedback loop into the aligner.
 */
export interface StageMotionAck {
  /**
   * The alignment session this report describes.
   *
   * A generation, not a session UUID: the stage receives snapshots stamped
   * with a generation and knows nothing else about session identity. It used
   * to carry a `sessionId` copied off the frames control sent it, and with
   * control out of the motion path there is no longer anything true to put
   * there — so the field says what the stage can actually stand behind.
   */
  sessionGeneration: number;
  /** Sequence number of the last accepted snapshot, or -1 before the first. */
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

  /*
   * There is no `prediction` block, and the omission is the point.
   *
   * §47.3 voice lead used to live here: the stage sampled `alignmentDisplayAt`
   * a fraction of a second in the future so the presenter read into text that
   * was already placed. Extrapolation is the alignment engine's job now, and it
   * is built to trail the reader deliberately — a stage lead stacked on top of
   * it, doubling the share of the take spent ahead of the reader. Comfort is
   * the reading band's job (`readingBandCenterPercent`), which changes where
   * the line sits rather than what the engine claims to have heard.
   */

  motion: {
    dampingRatio: number;
    naturalFrequency: number;
    maxForwardVelocityPxS: number;
    maxBackwardVelocityPxS: number;
    maxAccelerationPxS2: number;
    maxJerkPxS3: number;
    catchUpMultiplier: number;
    /**
     * §30.3 duration cap. Longest one continuous catch-up episode may hold the
     * boost, measured from the frame the catch-up licence appears.
     */
    catchUpMaxDurationMs: number;
    /**
     * Window at the end of `catchUpMaxDurationMs` over which the boost ramps
     * out. The cap is a deadline, but a deadline applied as a step is a limit
     * that moved underneath a jerk-limited plant — the exact shape that once
     * produced a −175,500 px/s² sub-step. Ramping means the limits the plant is
     * tracking never move faster than it can follow them.
     */
    catchUpReleaseMs: number;
    /**
     * §30.3 boost decay, in reading-corridor half-heights.
     *
     * The boost falls to nothing over this many corridor half-heights of gap
     * ABOVE the corridor's entry edge, so it is spent bringing the spoken line
     * back to the corridor and ordinary following covers the rest. Expressed in
     * corridors rather than pixels or milliseconds because the corridor is the
     * only scale that means the same thing on a 1080p stage and a 4K one, and
     * because a time-relative decay makes a long catch-up crawl at the end and
     * a short one snap.
     */
    catchUpDecayCorridors: number;
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
 * The one `SmoothFollowProfile.version` this build knows how to interpret.
 *
 * The version is bumped whenever a FIELD'S MEANING changes, so an older profile
 * is not a subset of a newer one — its numbers say something different. That
 * makes exact equality the only honest test: a consumer handed any other
 * version cannot interpret it, in either direction, and must fall back to its
 * own default rather than apply numbers it is guessing about (§55).
 */
export const SMOOTH_FOLLOW_PROFILE_VERSION = 3;

/**
 * Companion Appendix A. Midpoints of the published starting ranges; every value is
 * a calibration hypothesis to be tuned against the speech and motion corpus, not
 * product truth. Bump `version` whenever a field's meaning changes.
 */
export const DEFAULT_SMOOTH_FOLLOW_PROFILE: SmoothFollowProfile = {
  version: SMOOTH_FOLLOW_PROFILE_VERSION,
  id: 'default-v3',

  motion: {
    dampingRatio: 1.0,
    naturalFrequency: 6.5,
    maxForwardVelocityPxS: 900,
    maxBackwardVelocityPxS: 600,
    maxAccelerationPxS2: 2600,
    maxJerkPxS3: 12000,
    catchUpMultiplier: 1.6,
    // A.4/§30.3. Long enough to absorb a sentence-length stumble or a transcript
    // stall at 1.6× (at 900 px/s base that is ~3600 px, several screens); short
    // enough that a catch-up which is not closing stops being a spectacle before
    // the presenter has finished the next sentence.
    catchUpMaxDurationMs: 2500,
    catchUpReleaseMs: 250,
    // Sized so the decay LEADS the plant's own braking rather than being masked
    // by it. Fourteen corridor half-heights is ~605 px on a 1080p stage with the
    // default 4% band, against a 565 px full-authority stop from boosted top
    // speed (1440 px/s, aMax 4160, jerk 12000) — so the ceiling is already
    // coming down by the time the overshoot guard would otherwise slam on, and
    // the approach is shaped instead of braked. Below about 13 the guard fires
    // first and the decay is decoration.
    catchUpDecayCorridors: 14,
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

/**
 * Every numeric leaf of `reference` must exist on `candidate` as a finite
 * number. Walking the DEFAULT profile rather than a hand-written field list is
 * deliberate: a field added to `SmoothFollowProfile` is validated the moment it
 * gets a default, with no second list to forget.
 */
function everyNumberIsFinite(reference: Record<string, unknown>, candidate: unknown): boolean {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const value = candidate as Record<string, unknown>;
  for (const [key, ref] of Object.entries(reference)) {
    const got = value[key];
    if (typeof ref === 'number') {
      if (typeof got !== 'number' || !Number.isFinite(got)) return false;
    } else if (typeof ref === 'object' && ref !== null) {
      if (!everyNumberIsFinite(ref as Record<string, unknown>, got)) return false;
    }
  }
  return true;
}

/**
 * Is this profile safe to APPLY, as opposed to merely well-typed?
 *
 * A profile crosses a process boundary (control → validated stage envelope), so
 * by the time it arrives it is untrusted data, and every number in it ends up
 * multiplying pixels on the presenter's glass. Two ways it can be wrong:
 *
 *   - a version this build does not interpret (see the constant above);
 *   - a truncated or corrupted payload, where a missing field becomes
 *     `undefined` and the first arithmetic on it produces NaN limits — motion
 *     that is neither the chosen feel nor the default, and unrecoverable
 *     because NaN propagates through the whole controller.
 *
 * Both answer "no", and the caller's answer to "no" is its own default.
 */
export function isInterpretableSmoothFollowProfile(
  value: unknown,
): value is SmoothFollowProfile {
  if (typeof value !== 'object' || value === null) return false;
  const profile = value as Partial<SmoothFollowProfile>;
  if (profile.version !== SMOOTH_FOLLOW_PROFILE_VERSION) return false;
  if (typeof profile.id !== 'string' || profile.id.length === 0) return false;
  return everyNumberIsFinite(
    DEFAULT_SMOOTH_FOLLOW_PROFILE as unknown as Record<string, unknown>,
    value,
  );
}

