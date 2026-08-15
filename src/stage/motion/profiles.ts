/**
 * Motion profiles by state (companion §30).
 *
 * "Use profile multipliers rather than unrelated controller implementations" —
 * every state runs the same jerk-limited follower with different limits, so
 * there is exactly one place where motion can be produced and one set of
 * invariants to test.
 *
 * Every number traces back to `SmoothFollowProfile.motion`; nothing here is a
 * free-floating constant.
 */
import {
  DEFAULT_SMOOTH_FOLLOW_PROFILE,
  isInterpretableSmoothFollowProfile,
  resolveLineLimitPx,
  type SmoothFollowProfile,
  type StageTransitionDirective,
  type StageMotionState,
} from '../../shared/contracts';

/**
 * The profile the stage will actually run this session on (§47.1, §55).
 *
 * Control resolves the user's Follow feel into a versioned profile and sends it
 * in the stage envelope. The stage decides whether it can be applied:
 *
 *   - a profile of the version this build interprets, whose numbers are all
 *     present and finite, is used exactly as sent;
 *   - anything else — a version from a newer or older build, a truncated
 *     payload, nothing at all — falls back to `DEFAULT_SMOOTH_FOLLOW_PROFILE`.
 *
 * Falling back rather than merging is the whole point. A version bump means a
 * field's MEANING changed, so a partial application would produce motion that
 * is neither the profile control sent nor the one this stage was tuned and
 * evaluated against — an unreproducible third thing, on the presenter's glass,
 * with no way for either side to know. The default is always followable.
 */
export function stageFollowProfile(
  candidate: SmoothFollowProfile | null | undefined,
): SmoothFollowProfile {
  return isInterpretableSmoothFollowProfile(candidate)
    ? candidate
    : DEFAULT_SMOOTH_FOLLOW_PROFILE;
}

/**
 * How much slower ordinary following's error correction is than every other
 * state's — see the note in `limitsForState`. 6.5 rad/s → 2.0.
 */
const FOLLOWING_OMEGA_SCALE = 2.0 / 6.5;
/**
 * And overdamped with it: an error is closed by easing onto the target, never
 * by overshooting and coming back. The display must not oscillate around the
 * reader at any cost.
 */
const FOLLOWING_ZETA_SCALE = 1.15;

export interface MotionLimits {
  /** Controller natural frequency (rad/s). */
  omega: number;
  /** Damping ratio; near 1.0 is critically damped. */
  zeta: number;
  vForwardMax: number;
  vBackwardMax: number;
  aMax: number;
  jerkMax: number;
  /** Multiplier on the feed-forward target velocity. */
  feedForwardScale: number;
  restDeadbandPx: number;
  reverseTravelMaxPx: number;
  reanchorThresholdPx: number;
  /**
   * §30.3 upper safety boundary — a POSITION the plant may not be carried past,
   * in the same scroll-pixel space as `targetPx`.
   *
   * `Number.POSITIVE_INFINITY` means "no ceiling", which is the value for every
   * state except catch-up. It is deliberately NOT one of the fields the §C1
   * finite fuse checks: infinity is the legitimate resting value here, and every
   * use site tests `Number.isFinite` before doing arithmetic with it.
   */
  forwardPositionCeilingPx: number;
  /** False forbids any backward motion (ordinary following, retake pending). */
  allowBackward: boolean;
  /** Reduced motion: follow the target exactly, with no easing dynamics. */
  snap: boolean;
}

interface StateMultipliers {
  omega?: number;
  zeta?: number;
  vForward?: number;
  vBackward?: number;
  accel?: number;
  jerk?: number;
  feedForward?: number;
  deadband?: number;
  allowBackward?: boolean;
}

/**
 * The catch-up boost actually in force this frame (§30.3).
 *
 * `boost` is the fraction of the profile's boost the frame loop has licensed —
 * 1 while the spoken line is still well outside the reading corridor and the
 * duration cap has time left, falling to 0 as either bound closes. The
 * multiplier lands on 1 (ordinary following limits), never below: a bound that
 * is spent is a return to ordinary motion, not a brake.
 */
export function catchUpMultiplierFor(profile: SmoothFollowProfile, boost: number): number {
  const full = Math.max(1, profile.motion.catchUpMultiplier);
  const fraction = Number.isFinite(boost) ? Math.min(1, Math.max(0, boost)) : 1;
  return 1 + (full - 1) * fraction;
}

/**
 * Companion §30.1–30.5, over the alignment engine's four states plus `paused`.
 *
 * The state vocabulary is deliberately small. It used to carry thirteen
 * entries, most of which were the old TypeScript tracker's internal bookkeeping
 * leaking into motion — `coasting`, `retake_pending`, `reanchoring` and friends
 * described what the *tracker* was doing, not what the presenter needed to see.
 * The engine now reports the only four distinctions that change how the
 * document should move, and everything that used to be a state is either a
 * transition directive (a bounded discontinuity, handled below) or nothing at
 * all.
 *
 * Note what is NOT here: no multiplier tries to stop the document during a
 * hold. It stops because the engine zeroes `rateTokensPerSecond` in exactly
 * those states, so the target itself stops advancing. These numbers only shape
 * how the plant settles onto a target that has already stopped moving —
 * belt-and-braces damping, not the mechanism.
 */
function stateMultipliers(
  state: StageMotionState,
  _profile: SmoothFollowProfile,
  /** §30.3 catch-up multiplier after the boost bounds; see `limitsForState`. */
  _boostedCatchUp: number,
): StateMultipliers {
  switch (state) {
    case 'following':
      return {};
    case 'searching':
      // No lock yet. Move gently and damp hard: everything the stage does here
      // is on weak evidence, and an eager approach to a position that is about
      // to be revised reads as the document hunting.
      return { vForward: 0.6, accel: 0.7, feedForward: 0.8, zeta: 1.05 };
    case 'holding':
      // Off-script speech or weak evidence. The target is already frozen, so
      // this only governs how the plant comes to rest on it.
      return { vForward: 0.35, accel: 0.6, zeta: 1.3, feedForward: 0.5, omega: 0.8 };
    case 'ambiguous':
      // Two distant places both fit. The display must not drift toward either
      // one, so no feed-forward at all — a lead here would be the stage
      // visually picking a side the engine explicitly refused to pick.
      return { vForward: 0.15, accel: 0.5, zeta: 1.4, feedForward: 0, omega: 0.7 };
    case 'paused':
      // Target zero velocity (§27.1) — the controller still settles smoothly.
      return { vForward: 0.25, accel: 0.5, zeta: 1.4, feedForward: 0, omega: 0.8 };
    default:
      return {};
  }
}

/** Transition directives temporarily reshape the same limits (§53, §30). */
function transitionMultipliers(
  type: StageTransitionDirective['type'] | undefined,
  profile: SmoothFollowProfile,
  boostedCatchUp: number,
): StateMultipliers {
  const catchUp = Math.max(1, profile.motion.catchUpMultiplier);
  switch (type) {
    case 'settle':
      return { vForward: 0.7, accel: 0.8, zeta: 1.25, feedForward: 0.9, omega: 0.95 };
    case 'catch_up':
      return { vForward: boostedCatchUp, accel: boostedCatchUp, feedForward: 1, omega: 1.15 };
    case 'rewind':
      return { vBackward: 0.9, zeta: 1.25, feedForward: 0.6, allowBackward: true };
    case 'reanchor':
    case 'reset':
      return { vForward: catchUp * 1.2, accel: 1.4, zeta: 1.15, allowBackward: true };
    default:
      return {};
  }
}

/**
 * How fast the document may travel while it re-grabs the presenter's place
 * after they moved it by hand, in rendered lines per second.
 *
 * LINES, because what makes a correction followable is whether the reader's eye
 * can stay on the text while it moves, and that is a claim about reading. Four
 * lines a second is comfortably faster than anybody reads — a half-screen gap
 * closes in about two seconds — and slow enough that the words stay words
 * rather than becoming a blur with a destination.
 *
 * The number this replaces was not a number at all: ordinary following simply
 * ran at `maxForwardVelocityPxS`, which is 900 px/s, about ten lines a second,
 * most of a screen every second. That ceiling is right for the case it was
 * tuned for — the tracker legitimately reporting that the presenter has moved
 * on — and completely wrong for the case where the DOCUMENT was moved and the
 * tracker never knew, because then the "correction" is a full-speed flight back
 * to a place the presenter has deliberately left.
 */
export const REACQUIRE_LINES_PER_SECOND = 4;

/**
 * The same ceiling for a stage that has not measured a pitch, px/s.
 *
 * 340 px/s is four lines at the ~85 px reference pitch, and it is the number
 * `resolveLineLimitPx` clamps the line-relative answer around — so an
 * implausible pitch (a font that never loaded) can move this by at most half or
 * three times, never by the factor a raw multiplication would allow.
 */
export const REACQUIRE_FALLBACK_VELOCITY_PX_S = 340;

/**
 * Slack added to the backward licence a re-acquisition is granted.
 *
 * The licence is sized to the gap being closed, because §30.5's standing 420 px
 * reverse budget is a bound on how far ordinary tracker jitter may reverse the
 * document, and this is not that: the presenter asked to be somewhere else and
 * the document is walking back to meet them. A licence cut exactly to the gap
 * strands the last few pixels — the plant brakes into the wall while still
 * short — so it carries one ordinary line of slack.
 */
export const REACQUIRE_REVERSE_SLACK_PX = 96;

/* ------------------------------------------------------------------ §30.5 --
 * The guided rewind ceiling.
 *
 * A `rewind` is what an accepted retake looks like on the glass: the presenter
 * has restarted an earlier phrase and the script walks back to meet them. It is
 * the one correction they are watching WORD BY WORD — they are already reading
 * the destination out loud — so the only question that matters is whether an
 * eye can stay on the text while it moves.
 *
 * That is a claim about reading, so the unit is rendered LINES, exactly as it
 * is for manual re-acquisition. What this replaces was a claim about nothing at
 * all: the profile's `maxBackwardVelocityPxS` (600) times the rewind
 * multiplier (0.9) is 540 px/s, which is 6.4 lines a second at the ~85 px
 * reference pitch and over ten a second on a 50 px one. The identical setting
 * therefore meant "a readable walk" on one rig and "the document leaving" on
 * another, and on both it was faster than anybody reads.
 */

/**
 * Three lines a second, deliberately BELOW the four that manual re-acquisition
 * gets (`REACQUIRE_LINES_PER_SECOND`).
 *
 * A re-acquisition happens when the presenter has stopped reading and moved the
 * script; a retake happens when they are mid-sentence and recovering their
 * place. The second is the worse moment of the two to make somebody chase text,
 * so it is the slower of the two ceilings, not the faster.
 */
export const GUIDED_REWIND_LINES_PER_SECOND = 3;

/**
 * And the viewport ceiling those three lines are met by (§30).
 *
 * A line-relative speed becomes a screen-relative sweep once a line is a large
 * part of the glass: at a calibrated 300 px pitch three lines a second is
 * 900 px/s, most of a 1080 px stage every second. Roughly a third of the glass
 * per second is the point past which "the script walking back" stops being
 * something anybody reads, however few lines it happens to be.
 */
export const GUIDED_REWIND_VIEWPORTS_PER_SECOND = 0.35;

/**
 * The same ceiling for a stage that has measured no pitch, px/s.
 *
 * 255 px/s is three lines at the ~85 px reference pitch, and it is the figure
 * `resolveLineLimitPx` clamps the line-relative answer around — so a pitch that
 * is not a size anybody chose (a font that never loaded) can move this by at
 * most half or three times, never by the factor a raw multiplication would.
 */
export const GUIDED_REWIND_FALLBACK_VELOCITY_PX_S = 255;

/** The reference pitch the two pixel fallbacks above are three and one line of. */
export const GUIDED_REWIND_REFERENCE_PITCH_PX = 85;

/**
 * Slack on the backward licence a guided rewind is granted, in lines.
 *
 * Sized to the destination for the same reason `REACQUIRE_REVERSE_SLACK_PX` is:
 * §30.5's standing reverse budget bounds how far ordinary tracker jitter may
 * reverse the document, and a retake is not jitter — the engine has made an
 * expensive semantic decision that the presenter is reading an earlier line. A
 * licence cut exactly to the gap strands the last few pixels, because the plant
 * brakes into the wall while still short of the target, so it carries one
 * ordinary line of slack.
 */
export const GUIDED_REWIND_SLACK_LINES = 1;

/**
 * How fast a guided rewind may travel on THIS rig, px/s.
 *
 * The smaller of the line-relative and viewport-relative bounds — never the
 * product, never a band around either. Both are absolute safety limits rather
 * than preferences, so the stricter one is always the answer.
 */
export function guidedRewindVelocityLimitPx(
  linePitchPx?: number | null,
  viewportHeightPx?: number | null,
): number {
  const lineRelative = resolveLineLimitPx(
    GUIDED_REWIND_LINES_PER_SECOND,
    GUIDED_REWIND_FALLBACK_VELOCITY_PX_S,
    linePitchPx,
  );
  const viewportRelative =
    typeof viewportHeightPx === 'number' &&
    Number.isFinite(viewportHeightPx) &&
    viewportHeightPx > 0
      ? viewportHeightPx * GUIDED_REWIND_VIEWPORTS_PER_SECOND
      : Number.POSITIVE_INFINITY;
  return Math.min(lineRelative, viewportRelative);
}

/** One rendered line of slack on the reverse licence, px. */
export function guidedRewindSlackPx(linePitchPx?: number | null): number {
  return resolveLineLimitPx(
    GUIDED_REWIND_SLACK_LINES,
    GUIDED_REWIND_REFERENCE_PITCH_PX,
    linePitchPx,
  );
}

export interface MotionLimitOptions {
  reducedMotion?: boolean;
  /** §61: the frame budget is being missed; simplify rather than jump. */
  degraded?: boolean;
  transition?: StageTransitionDirective['type'];
  /** Manual authority suppresses automatic correction for a grace interval. */
  manualGrace?: boolean;
  /**
   * §30.6. The presenter moved the script by hand and has now started speaking
   * again: this is the correction that re-grabs their place.
   *
   * A distinct shape from every transition in the table above, because it is a
   * distinct situation. A `catch_up` is the presenter having moved ahead in the
   * SCRIPT and the document following them; a re-acquisition is the document
   * having been moved and the reader standing still. Nothing about it is urgent
   * — the presenter is already reading the words they want — so it is the one
   * correction that is allowed to take its time.
   */
  reacquire?: boolean;
  /**
   * Total backward travel this re-acquisition is authorized to spend, px —
   * already inclusive of whatever the plant has spent, because that is what the
   * controller's cumulative `reverseTravelPx` is compared against.
   *
   * An ABSOLUTE licence, latched by the caller when the episode begins, not a
   * remaining distance. Deriving it from the shrinking gap each frame lowered
   * the ceiling as fast as the counter rose and dead-stopped long re-grabs
   * short of their destination; see `reacquireBudgetPx` in the engine.
   *
   * Omitted or non-finite leaves the profile's standing §30.5 budget alone.
   */
  reacquireReverseBudgetPx?: number;
  /**
   * Total backward travel the guided rewind episode in force is authorized to
   * spend, px — the same ABSOLUTE, already-inclusive-of-what-is-spent licence
   * `reacquireReverseBudgetPx` is, for the same reason.
   *
   * Read only while `transition` is `rewind`. Omitted or non-finite leaves the
   * profile's standing §30.5 budget alone, which is what every caller that does
   * not run episodes gets.
   */
  rewindReverseBudgetPx?: number;
  /**
   * The glass, CSS px — the stage's own measurement, never a setting.
   *
   * Supplied alongside `linePitchPx` so that a line-relative SPEED bound can be
   * met by the viewport ceiling it needs at large type (see
   * `guidedRewindVelocityLimitPx`). Its absence simply drops the viewport half
   * of that pair rather than guessing at a height.
   */
  viewportHeightPx?: number;
  /**
   * §30.3. Fraction of the profile's catch-up boost the frame loop licenses
   * this frame — the smaller of the corridor-relative decay and the duration
   * cap's release ramp. Defaults to 1 (undecayed), so a caller that does not
   * track catch-up episodes gets exactly today's behaviour.
   */
  catchUpBoost?: number;
  /**
   * §30.3 upper safety boundary, in scroll pixels. Omitted (or non-finite)
   * means no ceiling; the frame loop supplies one only while a catch-up licence
   * is in force, because that is the only motion the spec bounds this way.
   */
  forwardPositionCeilingPx?: number;
  /**
   * The measured line pitch, CSS px — the stage's own measurement, never a
   * setting. Supplying it switches the three POSITION bounds (`restDeadbandPx`,
   * `reverseTravelMaxPx`, `reanchorThresholdPx`) from the profile's pixel
   * numbers to its `lineUnits`, clamped into a band around those same pixel
   * numbers (`resolveLineLimitPx`).
   *
   * Optional, and its absence is the pre-optical behaviour exactly: a caller
   * that has not measured a pitch — the first frames of a session, a map that
   * failed to build, every existing call site — gets the pixel bounds it always
   * got. A pitch is only ever an improvement on a guess, never a prerequisite
   * for motion.
   *
   * The VELOCITY, acceleration and jerk limits are deliberately not in this
   * scheme. They are the plant's own dynamics, tuned together against a jerk
   * ceiling that no state relaxes (see the limit-cycle note in `limitsForState`),
   * and rescaling them per-panel would move three coupled numbers to chase one
   * measurement. What the pitch changes is how far a correction may TRAVEL,
   * which is what the presenter reads in lines.
   */
  linePitchPx?: number;
}

export function limitsForState(
  state: StageMotionState,
  profile: SmoothFollowProfile,
  options: MotionLimitOptions = {},
): MotionLimits {
  const m = profile.motion;
  /*
   * The three position bounds, resolved before any multiplier touches them.
   *
   * Resolving the BASE and then multiplying — rather than multiplying and then
   * resolving — keeps `degradeDeadband` and the state's `deadband` factor
   * meaning what they meant: "twice whatever the resting bound is", not "twice
   * a number that has since been clamped". It also makes the no-pitch case
   * arithmetically identical to the old code rather than merely close, because
   * `resolveLineLimitPx` returns the pixel value unchanged and the expressions
   * below are the ones that were already here.
   */
  const lines = profile.lineUnits;
  const pitchPx = options.linePitchPx;
  const restDeadbandBasePx = resolveLineLimitPx(
    lines?.restDeadbandLines,
    m.restDeadbandPx,
    pitchPx,
  );
  const reverseTravelMaxPx = resolveLineLimitPx(
    lines?.reverseTravelMaxLines,
    m.reverseTravelMaxPx,
    pitchPx,
  );
  const reanchorThresholdPx = resolveLineLimitPx(
    lines?.reanchorThresholdLines,
    m.reanchorThresholdPx,
    pitchPx,
  );
  const boostedCatchUp = catchUpMultiplierFor(profile, options.catchUpBoost ?? 1);
  const s = stateMultipliers(state, profile, boostedCatchUp);
  const t = transitionMultipliers(options.transition, profile, boostedCatchUp);
  /**
   * Combine a state multiplier with a transition multiplier — WITHOUT letting
   * them compound past either one on its own.
   *
   * This was a plain product, and the product is where the profile table stops
   * describing motion anyone chose. `reanchoring` × `catch_up` and
   * `catching_up` × `reanchor`/`reset` reached vMax 2765 and aMax 5824 — three
   * and 2.2 times the base — against a `jerkMax` that is deliberately never
   * relaxed (§30.3). A jerk-limited actuator needs `2·aMax/jerkMax` to swing
   * acceleration from one rail to the other, which at aMax 5824 is 0.97 s; run
   * that much actuator lag inside a loop whose stacked ω is 7.5 rad/s and the
   * phase margin is gone. The result was not overshoot but a sustained LIMIT
   * CYCLE: 106–162 px of tail oscillation with 63–78 reversals over 32 s
   * against a *static* target, the guard saturated on ~99% of sub-steps, and
   * the text visibly rocking about two and a half lines. `reanchoring` with a
   * `catch_up` transition is an ordinary combination that can hold for the
   * whole 4 s directive TTL.
   *
   * So the product is capped to the more extreme of its two factors: a
   * transition may take the limits as far as it would on its own, and a state
   * may too, but the two together may not go further than the bolder of them.
   * This is strictly narrowing — every combination comes out no more extreme
   * than it is today, and combinations that never stacked are untouched (one
   * factor is 1, and `clamp(x·1, min(x,1), max(x,1))` is exactly `x`).
   *
   * The alternative — letting a transition REPLACE the state's multiplier — is
   * also clean across the whole space, but it is not narrowing: it would let a
   * `catch_up` directive run at full catch-up speed while the tracker is
   * `uncertain`, which today's product deliberately damps to 0.56.
   */
  const mul = (a?: number, b?: number) => {
    const x = a ?? 1;
    const y = b ?? 1;
    return Math.min(Math.max(x, y, 1), Math.max(Math.min(x, y, 1), x * y));
  };

  // §61 degradation: a calmer, cheaper profile — never event-driven jumps.
  const degradeOmega = options.degraded ? 0.85 : 1;
  const degradeDeadband = options.degraded ? 2 : 1;

  /*
   * ORDINARY FOLLOWING IS THE ONE THING THAT GOT GENTLER (§29.1).
   *
   * The presenter's complaint was that the document moved "in a jerk and then a
   * jerk". At ω = 6.5 the controller has a ~150 ms time constant, so it answers
   * every step in the reference at full authority — and the reference steps
   * once per transcript event, about once a second. Measured on the rendered
   * trace, that was |accel| P95 319 px/s² and jerk P95 6 623 px/s³: the plant
   * doing violent work to track a signal that arrives in jumps.
   *
   * A slow controller is affordable only because the feed-forward now carries
   * the display path's own speed, so ω governs how fast a residual ERROR is
   * closed and nothing else. Without that, dropping ω would just mean lagging
   * further and further behind.
   *
   * Applied HERE, as one factor on one state, rather than by lowering
   * `naturalFrequency`. Lowering the base and compensating every other state
   * and transition back up is what it looked like it should be, and it is
   * wrong: `mul` returns the LARGER factor once both exceed 1, so pairs that
   * used to combine a sub-unity state with a transition stopped combining at
   * all. `holding` × `catch_up` was 0.8 × 1.15 → 5.98 rad/s and became 7.48;
   * `ambiguous` × `rewind` went 4.55 → 6.50. Every cautious state silently
   * became stiffer in exactly the situations it exists to be careful in.
   *
   * A single factor on `following` cannot do that: `mul(x, 1)` is `x`, and the
   * combinations below are untouched because `following` carries no other
   * multiplier. Every non-following state, and every transition — including a
   * catch-up or a re-anchor that happens WHILE following — keeps the exact
   * stiffness it was tuned with, which is right: each of those is a deliberate,
   * bounded, visible move, and none of them should become sluggish because
   * ordinary reading became calm.
   */
  const ordinaryFollowing =
    state === 'following' &&
    (options.transition === undefined || options.transition === 'none') &&
    options.reacquire !== true &&
    options.manualGrace !== true;
  const followOmega = ordinaryFollowing ? FOLLOWING_OMEGA_SCALE : 1;
  const followZeta = ordinaryFollowing ? FOLLOWING_ZETA_SCALE : 1;

  const limits: MotionLimits = {
    omega: m.naturalFrequency * mul(s.omega, t.omega) * degradeOmega * followOmega,
    zeta: m.dampingRatio * mul(s.zeta, t.zeta) * followZeta,
    vForwardMax: m.maxForwardVelocityPxS * mul(s.vForward, t.vForward),
    vBackwardMax: m.maxBackwardVelocityPxS * mul(s.vBackward, t.vBackward),
    aMax: m.maxAccelerationPxS2 * mul(s.accel, t.accel),
    // The jerk limit is never relaxed by a state: it is what keeps corrections
    // from reading as visual kicks (§29.2, §30.3).
    jerkMax: m.maxJerkPxS3 * mul(s.jerk, t.jerk),
    feedForwardScale: mul(s.feedForward, t.feedForward),
    restDeadbandPx: restDeadbandBasePx * (s.deadband ?? 1) * degradeDeadband,
    reverseTravelMaxPx,
    reanchorThresholdPx,
    // §30.3. A safety boundary, so it is a position and not a speed: the boost
    // decay above only shapes how fast the gap closes, and a plant that is
    // already level with a target moving at the same speed closes nothing at
    // all. Non-finite in every state but catch-up.
    forwardPositionCeilingPx: Number.isFinite(options.forwardPositionCeilingPx)
      ? (options.forwardPositionCeilingPx as number)
      : Number.POSITIVE_INFINITY,
    allowBackward: t.allowBackward ?? s.allowBackward ?? false,
    snap: options.reducedMotion === true,
  };

  if (options.manualGrace) {
    // Manual interaction has immediate authority; automatic correction back to
    // the old target is suppressed, not fought (§30.6).
    limits.vForwardMax = 0;
    limits.vBackwardMax = 0;
    limits.feedForwardScale = 0;
    limits.snap = false;
    // Nothing automatic may move, so there is nothing for a safety ceiling to
    // bound — and the presenter's own position may legitimately be past it.
    limits.forwardPositionCeilingPx = Number.POSITIVE_INFINITY;
  } else if (options.reacquire && options.reducedMotion !== true) {
    /*
     * §30.6, the other end of the same interval: the grace is over and the
     * document has to come back to the reader.
     *
     * Applied AFTER the state and transition shaping and as a `min`, never as a
     * multiplier, for the reason the §32.3 fade threshold is combined the same
     * way: this is a bound on a correction the presenter did not ask for, so a
     * state that happens to be feeling energetic may not raise it. Large type
     * can make the re-grab faster in pixels — that is what keeps it four LINES
     * a second on every rig — and nothing can make it faster in lines.
     *
     * Reduced motion is exempt and goes back to `snap`: somebody who has asked
     * their system not to animate is not asking for a gentler animation (§32.4).
     */
    const ceilingPxS = resolveLineLimitPx(
      REACQUIRE_LINES_PER_SECOND,
      REACQUIRE_FALLBACK_VELOCITY_PX_S,
      options.linePitchPx,
    );
    limits.vForwardMax = Math.min(limits.vForwardMax, ceilingPxS);
    limits.vBackwardMax = Math.min(limits.vBackwardMax, ceilingPxS);
    /*
     * Backward is the direction this exists for.
     *
     * Ordinary following forbids reverse, and rightly — but the commonest
     * manual gesture on a prompter is scrolling BACK to re-read a line, which
     * leaves the plant behind the tracker's target and closes the gap forward.
     * The mirror case, scrolling ahead to look and then carrying on from where
     * you were, leaves the plant AHEAD, and with reverse forbidden the document
     * simply froze until the reader's own progress caught up with it — the
     * script sitting still while somebody reads is the failure this whole
     * surface is built to avoid.
     */
    limits.allowBackward = true;
    const budgetPx = options.reacquireReverseBudgetPx;
    if (typeof budgetPx === 'number' && Number.isFinite(budgetPx) && budgetPx > 0) {
      limits.reverseTravelMaxPx = Math.max(limits.reverseTravelMaxPx, budgetPx);
    }
    // No leading while re-grabbing. Feed-forward is a bet on where the reader
    // will be next, and the one thing this frame knows for certain is that the
    // display and the tracker disagree about where they are NOW.
    limits.feedForwardScale = 0;
    // Damp harder and soften the approach: an overshoot at the end of a
    // correction the presenter did not ask for reads as the document hunting.
    limits.zeta = limits.zeta * 1.2;
    limits.omega = limits.omega * 0.9;
  }

  if (options.transition === 'rewind' && options.reducedMotion !== true) {
    /*
     * §30.5, the guided rewind. See `GUIDED_REWIND_LINES_PER_SECOND`.
     *
     * Applied LAST and as a `min`, never as a multiplier, for the same reason
     * the re-acquisition ceiling above is: this bounds a correction the
     * presenter is reading through, so a state that happens to be feeling
     * energetic may not raise it, and a profile that is already gentler than
     * three lines a second keeps its own number. Large type can make the walk
     * faster in PIXELS — that is what keeps it three LINES a second on every
     * rig — and nothing can make it faster in lines.
     *
     * After the `manualGrace` branch on purpose: that branch zeroes both
     * velocity budgets because nothing automatic may move while the presenter's
     * hand is on the script, and `Math.min` with zero is zero. A rewind that
     * arrives mid-drag still cannot move until the grace runs out.
     *
     * Reduced motion is exempt and keeps `snap` (§32.4): somebody who has asked
     * their system not to animate is not asking for a gentler animation. That
     * exception is confined to this branch — ordinary motion mode never inherits
     * it — and is the ONE case where a retake repositions without travelling.
     */
    const ceilingPxS = guidedRewindVelocityLimitPx(
      options.linePitchPx,
      options.viewportHeightPx,
    );
    /*
     * Forward as well as backward, and the asymmetry it removes is the point.
     * The target stays live while the presenter reads on through the sentence
     * they restarted, so it can cross the plant mid-episode; without a forward
     * bound the document would answer that by rebounding at the profile's full
     * 900 px/s, which is the same eye-losing flight the backward cap exists to
     * prevent, pointing the other way. Completion (see the engine's guided
     * rewind episode) hands ordinary forward speed straight back the moment the
     * backward correction is genuinely over.
     */
    limits.vBackwardMax = Math.min(limits.vBackwardMax, ceilingPxS);
    limits.vForwardMax = Math.min(limits.vForwardMax, ceilingPxS);
    // Backward is the direction this exists for; the multiplier table already
    // says so, and restating it here keeps the branch honest on its own.
    limits.allowBackward = true;
    /*
     * No leading while recovering. Feed-forward is a bet on where the reader
     * will be next, and a rewind is the stage closing a disagreement about
     * where they are NOW. It is also what turns a live target revision into a
     * rebound: the term survives the target crossing the plant and pushes on
     * in the direction the episode has just finished with.
     */
    limits.feedForwardScale = 0;
    // Overshoot at the end of a correction the presenter is reading through
    // reads as the document hunting for its place. Raise the damping, never
    // lower it — a profile that is already more overdamped keeps its own.
    limits.zeta = Math.max(limits.zeta, 1.25);
    const budgetPx = options.rewindReverseBudgetPx;
    if (typeof budgetPx === 'number' && Number.isFinite(budgetPx) && budgetPx > 0) {
      limits.reverseTravelMaxPx = Math.max(limits.reverseTravelMaxPx, budgetPx);
    }
  }

  return limits;
}
