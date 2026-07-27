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

/**
 * The motion bounds a second time, as multiples of the MEASURED line pitch.
 *
 * Every pixel bound in `motion` was tuned against one body size — 64 px at a
 * 1.32 line height, so a pitch of about 85 px — and means something different at
 * every other size. On a 9-inch panel calibrated to 24 arcminutes at 1.8 m the
 * pitch is nearer 50 px, and `reverseTravelMaxPx: 420` is eight rendered lines
 * rather than five: a correction the presenter experiences as the document
 * leaving rather than backing up. On a 15.6-inch panel read at arm's length the
 * pitch is over 200 px and the same 420 px is two lines — not far enough to
 * reach the start of the sentence somebody is re-reading.
 *
 * What a presenter perceives is LINES, so lines are the unit. The pixel fields
 * are not replaced: they stay authoritative wherever a line-relative answer
 * cannot be trusted — a stage that has not measured a pitch yet, and a pitch so
 * far from the plausible band that it is a measurement failure rather than a
 * font size (see `resolveLineLimitPx`).
 */
export interface SmoothFollowLineUnits {
  /**
   * §30 hard cap on backward travel in one correction. Five lines is about as
   * far back as a presenter who stumbles is plausibly re-reading from; past
   * that the honest reading is not "they repeated a phrase" but "we are
   * somewhere they are not", which is a re-anchor's job rather than a roll.
   */
  reverseTravelMaxLines: number;
  /**
   * §30 latch escape hatch — how far the target may disagree with a latched
   * forward position before the disagreement is treated as a relocation.
   *
   * Deliberately BELOW `reverseTravelMaxLines`, in the ordering AND very nearly
   * the ratio the pixel pair has (360 < 420): the escape hatch has to be
   * reachable before the reverse cap is spent, or a large regression exhausts
   * its travel budget against a position it was never going to reach.
   */
  reanchorThresholdLines: number;
  /**
   * The point at which further correction stops being visible, so the plant is
   * allowed to rest. Under a fiftieth of a line: 1.52 px at the default pitch,
   * and still a fiftieth of a line rather than a fixed 1.5 px once the type
   * doubles — which is the difference between resting when the correction is
   * invisible and resting when it merely happens to be small in pixels.
   */
  restDeadbandLines: number;
  /**
   * §20.4. Below this a re-anchor is not a teleport and there is nothing worth
   * obscuring, so fading it would be a gratuitous full-field flash. One
   * rendered line is a correction the presenter cannot distinguish from
   * ordinary following. Consumed by the engine's `fadeWorthwhile`.
   */
  fadeSkipLines: number;
  /**
   * §30.3 upper safety boundary during catch-up, as a distance past the target
   * the plant may be carried. The engine derives this from the reading
   * corridor's half-height when it knows one; this is the same bound in a unit
   * that survives a corridor the engine could not measure, so the boundary
   * stops disappearing entirely on the frames where it is needed most.
   */
  catchUpCeilingLines: number;
}

/**
 * How far a line-relative bound may travel from its pixel default.
 *
 * The pixel defaults are the tuned values at a 84.48 px pitch (64 px body, 1.32
 * line height), and every `lineUnits` multiple below is one of those numbers
 * divided by that pitch — so clamping the RESULT to 0.5x–3x its own pixel
 * default is the same statement as clamping the measured PITCH to 42–253 px,
 * identically for every bound. That equivalence is why the multiples have to
 * stay faithful to the pixels they came from: round one of them to a tidier
 * figure and this band quietly starts meaning a different range of pitches for
 * that bound than for the one beside it.
 *
 * 42–253 px spans the rigs CandidCue is used on, from a 9-inch panel read at
 * 1.8 m to a 15.6-inch one at arm's length. Outside it the pitch is not a size
 * anybody chose: a font that never loaded, a measurement pass that ran against
 * an empty document, a display scale read wrong. Multiplying a bad pitch by five
 * and handing the product to the plant is how a measurement fault turns into
 * motion on the presenter's glass, so the band clamps rather than trusts — the
 * same instinct as the version gate below, applied to a number instead of a
 * payload.
 */
export const LINE_LIMIT_MIN_SCALE = 0.5;
export const LINE_LIMIT_MAX_SCALE = 3;

/**
 * One line-relative bound, resolved against a measured pitch.
 *
 * Total, and biased toward the pixel value: anything unusable about either
 * input — no pitch measured yet, a profile with no `lineUnits`, a nonsense
 * multiple — answers with `fallbackPx`, which is a tuned number rather than a
 * guess. That is what makes `lineUnits` additive: omitting it is a request for
 * the pixel behaviour, not a truncation.
 */
export function resolveLineLimitPx(
  lines: number | null | undefined,
  fallbackPx: number,
  linePitchPx: number | null | undefined,
): number {
  if (typeof lines !== 'number' || !Number.isFinite(lines) || lines <= 0) return fallbackPx;
  if (typeof linePitchPx !== 'number' || !Number.isFinite(linePitchPx) || linePitchPx <= 0) {
    return fallbackPx;
  }
  // Nothing to clamp into. A non-positive or non-finite pixel default is either
  // a caller with no bound to offer — a viewport height it has not measured —
  // or a profile asking for zero travel, and both want their own number handed
  // straight back rather than a line-relative substitute for it.
  if (!Number.isFinite(fallbackPx) || fallbackPx <= 0) return fallbackPx;
  const scaled = lines * linePitchPx;
  return Math.min(
    Math.max(scaled, fallbackPx * LINE_LIMIT_MIN_SCALE),
    fallbackPx * LINE_LIMIT_MAX_SCALE,
  );
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

  /**
   * OPTIONAL, and optional is the contract rather than an oversight.
   *
   * A profile without this block asks for the pixel bounds above, applied as
   * written — which is exactly what every build before this one did, and is a
   * complete, tuned answer rather than a partial one. So its absence must never
   * fail `isInterpretableSmoothFollowProfile`; only a block that is PRESENT and
   * incomplete does, on the same all-or-nothing reasoning as the version gate.
   */
  lineUnits?: SmoothFollowLineUnits;

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
 *
 * 3 → 4 is such a change even though `lineUnits` is additive. The pixel bounds
 * did not move, but once a profile carries `lineUnits` they stop being the
 * value and become the CLAMP BAND around it — so a v3 consumer handed this
 * profile would read 420 px of reverse travel where a v4 one reads five lines,
 * and on the panels this whole change exists for those are not the same number.
 */
export const SMOOTH_FOLLOW_PROFILE_VERSION = 4;

/**
 * Companion Appendix A. Midpoints of the published starting ranges; every value is
 * a calibration hypothesis to be tuned against the speech and motion corpus, not
 * product truth. Bump `version` whenever a field's meaning changes.
 */
export const DEFAULT_SMOOTH_FOLLOW_PROFILE: SmoothFollowProfile = {
  version: SMOOTH_FOLLOW_PROFILE_VERSION,
  id: 'default-v4',

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

  /*
   * The same three bounds, plus the two the engine had as bare constants, in
   * the unit the presenter reads in.
   *
   * These are not new tuning, and the arithmetic has to keep saying so: each is
   * the pixel number above divided by the pitch it was tuned at — 64 px body at
   * a 1.32 line height, so 84.48 px. 420 is 4.97 lines, 360 is 4.26, and 1.5 is
   * 0.0178. Five, four and a quarter, and eighteen thousandths land within 1.5%
   * of the published pixel value, so a stage that measures the reference pitch
   * moves exactly as it does today, and the ordering that matters — the
   * re-anchor threshold reachable before the reverse cap is spent — is inherited
   * from the pixel pair rather than re-argued.
   *
   * Rounding harder than that is a retune wearing a conversion's clothes. Four
   * lines and three and a half read better on the page and are 19% and 18% off
   * two bounds nobody measured again, applied the instant a stage learns its own
   * pitch and to no stage before that. `LINE_LIMIT_MIN_SCALE` leans on the same
   * fidelity for its band to mean one pitch range — see the note there.
   *
   * `fadeSkipLines` and `catchUpCeilingLines` were already line- and
   * corridor-relative in the engine; they move here so there is one table of
   * motion bounds rather than a profile and a scatter of constants beside it.
   */
  lineUnits: {
    reverseTravelMaxLines: 5,
    reanchorThresholdLines: 4.25,
    restDeadbandLines: 0.018,
    fadeSkipLines: 1,
    catchUpCeilingLines: 1,
  },

  coaching: {
    // A.5: 6–10 s stage cooldown, one visible tip, never from provisional evidence.
    stageCooldownMs: 8000,
    controlCooldownMs: 15000,
    minimumConfidence: 0.8,
  },
};

/**
 * Top-level blocks of the default profile whose ABSENCE from a candidate is
 * legal — the one exception to walking the default as a required shape.
 *
 * `lineUnits` earns it because leaving it out is a request, not a truncation:
 * the pixel bounds are a complete and tuned description of the same motion, and
 * a control that never learned to send lines is asking for exactly them. There
 * is no equivalent argument for `motion` or `coaching`, where a missing block
 * means a payload lost something on the way.
 *
 * Optional applies to PRESENCE only. A block that is there is walked in full,
 * so a half-written `lineUnits` is still rejected outright — half a block is the
 * same unreproducible third thing a half-applied profile is.
 */
const OPTIONAL_PROFILE_BLOCKS: ReadonlySet<string> = new Set(['lineUnits']);

const EMPTY_BLOCK_SET: ReadonlySet<string> = new Set();

/**
 * Every numeric leaf of `reference` must exist on `candidate` as a finite
 * number. Walking the DEFAULT profile rather than a hand-written field list is
 * deliberate: a field added to `SmoothFollowProfile` is validated the moment it
 * gets a default, with no second list to forget.
 */
function everyNumberIsFinite(
  reference: Record<string, unknown>,
  candidate: unknown,
  /** Nested blocks are never optional; only the top level has exceptions. */
  optionalBlocks: ReadonlySet<string> = EMPTY_BLOCK_SET,
): boolean {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const value = candidate as Record<string, unknown>;
  for (const [key, ref] of Object.entries(reference)) {
    const got = value[key];
    if (typeof ref === 'number') {
      if (typeof got !== 'number' || !Number.isFinite(got)) return false;
    } else if (typeof ref === 'object' && ref !== null) {
      if (got === undefined && optionalBlocks.has(key)) continue;
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
  /*
   * v3 is still interpretable; anything else is not.
   *
   * The all-or-nothing rule on a version mismatch is right and stays: a bumped
   * version means a field's MEANING changed, so a partial application produces
   * motion that is neither the profile control sent nor the one this stage was
   * tuned against — an unreproducible third thing, on the presenter's glass,
   * with no way for either side to know.
   *
   * v3 to v4 is the exception, and the reason is visible in the diff: v4 only
   * ADDS an optional `lineUnits` block. Every pixel field a v3 profile carries
   * means exactly what it meant before, and the absence of the block already
   * means "use the pixel values" for a v4 profile that omits it. So a v3
   * profile is a v4 profile that omits it, and rejecting one costs a presenter
   * the calm or responsive feel they chose the moment they run a newer stage
   * against an older control — silently, because the default is followable.
   *
   * A v3 that arrives WITH a `lineUnits` block is refused: that is not a
   * version this build has ever produced, and guessing at it is the exact
   * failure the gate exists to prevent.
   */
  const version = profile.version;
  const interpretableVersion =
    version === SMOOTH_FOLLOW_PROFILE_VERSION ||
    (version === SMOOTH_FOLLOW_PROFILE_VERSION - 1 &&
      (value as Record<string, unknown>).lineUnits === undefined);
  if (!interpretableVersion) return false;
  if (typeof profile.id !== 'string' || profile.id.length === 0) return false;
  return everyNumberIsFinite(
    DEFAULT_SMOOTH_FOLLOW_PROFILE as unknown as Record<string, unknown>,
    value,
    OPTIONAL_PROFILE_BLOCKS,
  );
}

