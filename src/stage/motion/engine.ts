/**
 * Stage motion engine — the continuously running control system that owns
 * frame-by-frame motion for the life of a stage session (companion §26.2).
 *
 * The pipeline, once per display frame:
 *
 *   accepted AlignmentSnapshot
 *     → displayAt(audio clock now)   → token position
 *     → §8 line-handoff path sample  → target scroll + dScroll/dUnit
 *     → §28 feed-forward velocity    = dScroll/dUnit × token rate
 *     → §30 motion limits for the state / active transition
 *     → §29 jerk-limited controller, §32 frame-time compensation
 *     → pixels
 *
 * ---------------------------------------------------------------------------
 * PREDICTION IS NOT THIS MODULE'S JOB ANY MORE
 * ---------------------------------------------------------------------------
 * The alignment engine ships a lag-compensated, hard-capped extrapolation with
 * every snapshot, and `alignmentDisplayAt` is the exact mirror of it. The stage
 * used to run a second prediction model on top — its own horizon, decay curve
 * and drift budget — which meant extrapolating an extrapolation and tuning two
 * sets of constants against each other. There is now exactly one prediction in
 * the system, it lives in the engine, and it is benchmarked there.
 *
 * What the stage kept is everything prediction was never doing: turning a
 * position into pixels through measured geometry, and moving there under jerk,
 * velocity and acceleration limits that make it look like reading rather than
 * scrolling.
 *
 * A new frame updates the desired *path* only. Plant state (position, velocity,
 * acceleration) is overwritten in exactly four places, all authorized: a
 * reanchor/reset directive, layout recovery, manual navigation, and visibility
 * restoration (§26.3, §30.6, §32.4, §33).
 *
 * Everything here is pure with respect to time and the DOM: the caller supplies
 * `nowMs` and applies `scrollPx`. That keeps the whole control system testable
 * in node while the rAF loop stays in the stage window.
 */
import {
  alignmentDisplayAt,
  alignmentDisplayRateAt,
  ALIGNMENT_RELOCATIONS,
  DEFAULT_SMOOTH_FOLLOW_PROFILE,
  resolveLineLimitPx,
  type AlignmentDecision,
  type AlignmentSnapshot,
  type SmoothFollowProfile,
  type StageMotionAck,
  type StageMotionState,
  type StageTransitionDirective,
} from '../../shared/contracts';
import {
  createAlignmentReceiver,
  type AlignmentReceiver,
} from './alignmentReceiver';
import {
  createFrameIntervalEstimator,
  createJerkLimitedScrollController,
  type JerkLimitedScrollController,
} from './controller';
import {
  createStageMotionDiagnostics,
  type StageMotionDiagnostics,
} from './diagnostics';
import type { StageRenderedLineMap, VisualBlockSpan } from './lineMap';
import { createLineHandoffPlanner, type LineHandoffPlanner, type LineTarget } from './planner';
import {
  limitsForState,
  REACQUIRE_REVERSE_SLACK_PX,
  type MotionLimits,
} from './profiles';
import {
  createStageTransitionController,
  type StageTransitionController,
} from './transitions';

/**
 * A plain pixel target the renderer computed from block geometry, used when
 * there is no alignment feed at all — a manual scroll, a paused session, the
 * pre-roll before the first snapshot. It drives the same controller, so motion
 * stays continuous and jerk-limited whatever produced the target.
 */
export interface FallbackTarget {
  scrollPx: number;
  /**
   * How the correction should be spent. `reanchor` is the only value that
   * overwrites plant state, and only because an explicit command/manual
   * navigation produced it.
   */
  disposition: 'follow' | 'catch_up' | 'reanchor' | 'instant';
  atMs: number;
  /**
   * How fast this target is itself moving, px/s. Optional; 0 for a target that
   * is standing still, which is every caller that does not set it.
   *
   * ---------------------------------------------------------------------------
   * WHY A STATIONARY-LOOKING TARGET IS NOT THE SAME AS A CRAWLING ONE
   * ---------------------------------------------------------------------------
   * §29.3's rest deadband exists to stop subpixel shimmer once everything has
   * genuinely settled: inside the deadband, with no feed-forward and a slow
   * plant, it snaps `q` to the target and zeroes `v`.
   *
   * A target that creeps forward a third of a pixel per frame — which is what
   * the fixed-pace transport at a readable speed looks like — satisfies every
   * one of those conditions on every frame. The plant is then teleported to the
   * target sixty times a second with `v` reported as zero, and two things go
   * wrong at once: the limits stop being applied, because nothing is being
   * integrated; and the RENDERER, which quantises the painted offset to the
   * device pixel grid whenever velocity reads as at-rest, turns smooth
   * sub-pixel travel into a visible 1 px step twenty times a second. On the
   * 1024x600 panel this app targets there is no spare resolution to hide that
   * in.
   *
   * A caller that knows how fast its target is moving can say so, and then none
   * of that happens: the deadband correctly declines to call it rest, the plant
   * integrates under its own limits, and the reported velocity is true — which
   * is what the renderer needs to leave the fractional offset alone.
   */
  feedForwardVelocityPxS?: number;
}

export type MotionSource = 'alignment' | 'fallback' | 'hold';

export interface StageMotionFrameResult {
  /** Position to render this frame (fractional; §29.4). */
  scrollPx: number;
  velocityPxS: number;
  accelerationPxS2: number;
  targetPx: number;
  activeLineId: string | null;
  lineProgress: number;
  /** Token the presenter is estimated to be on, for active/passed styling. */
  activeTokenIndex: number | null;
  source: MotionSource;
  state: StageMotionState | null;
  /**
   * A distant candidate the engine is accumulating evidence for but has NOT
   * accepted. Surfaced so the renderer can offer "resume here?"; the motion
   * layer deliberately does nothing with it, because auto-scrolling to an
   * unaccepted suggestion is precisely what the suggestion mechanism exists to
   * avoid.
   */
  suggestionToken: number | null;
  controllerState: string;
  /** True on frames where capped-rate styling should be refreshed (§26.2/7). */
  styleTick: boolean;
  /** Non-null on the periodic ack cadence (§54). */
  ack: StageMotionAck | null;
  degraded: boolean;
  hitch: boolean;
  /**
   * §20.4. Opacity the document layer must be painted at this frame. `1` except
   * during a re-anchor transition, where it ramps down, sits at `0` for the one
   * frame that moves the transform, and ramps back up.
   *
   * This is not decoration: it is the other half of the re-anchor. The renderer
   * MUST apply it to the same element it applies `scrollPx` to, in the same
   * update, or the guarantee that the document moves while obscured is lost.
   */
  documentOpacity: number;
}

export interface StageMotionEngineOptions {
  profile?: SmoothFollowProfile;
  /**
   * How long a snapshot stays usable after it arrives.
   *
   * Snapshots come one per transcript event, so a quiet feed is normal, not a
   * fault: a presenter who stops talking produces no events and the engine has
   * nothing new to say. `displayAt` already stops advancing at
   * `maxPredictionMs`, so a merely-old snapshot holds the position by itself.
   * This threshold is about something stronger — the feed being GONE (the
   * session ended, the socket died) — after which the stage stops claiming to
   * follow anyone and hands over to the fallback target.
   */
  snapshotStaleMs?: number;
  /** Capped rate for active/passed styling updates (§26.2 step 7). */
  styleIntervalMs?: number;
  /** Ack cadence (§54). */
  ackIntervalMs?: number;
  /** Manual-interaction grace before automatic correction resumes (§30.6). */
  manualGraceMs?: number;
}

export interface LayoutRecoveryRequest {
  map: StageRenderedLineMap;
  nowMs: number;
  /**
   * Semantic unit to preserve, and the viewport height it currently occupies.
   * The new scroll offset is chosen so that unit stays where it was (§33).
   */
  anchorUnit?: number;
  anchorViewportY?: number;
}

export interface StageMotionEngine {
  readonly receiver: AlignmentReceiver;
  readonly controller: JerkLimitedScrollController;
  readonly transitions: StageTransitionController;
  readonly diagnostics: StageMotionDiagnostics;
  readonly map: StageRenderedLineMap | null;
  readonly profile: SmoothFollowProfile;
  /** Token position the last rendered frame aimed at, or null while holding. */
  readonly lastDisplayToken: number | null;
  /** Backward target revisions suppressed by the forward latch (§70.5). */
  readonly targetRegressions: number;
  /**
   * Times the latch gave way to an authorized re-anchor because the suppressed
   * regression exceeded `reanchorThresholdPx` and stayed there (§30, §53).
   */
  readonly latchReanchors: number;
  /**
   * Frames on which an authorized plant overwrite could not be resolved (no
   * line map) and was parked rather than spent (§62, §53).
   */
  readonly deferredPlantOverwrites: number;
  /**
   * Re-anchor transitions that were obscured by a §20.4 fade rather than cut
   * bare — diagnostics only.
   */
  readonly reanchorFades: number;
  /**
   * Catch-up episodes that hit the §30.3 duration cap with the gap still open
   * and were handed back to ordinary following — diagnostics only.
   */
  readonly catchUpCapExpiries: number;
  /**
   * §30.6. The presenter moved the script by hand and has not spoken since, so
   * manual authority stands until they do — the half of the hold that the grace
   * interval's clock cannot express.
   *
   * Exposed rather than folded into a single `manualHoldActive` flag because
   * this side of it has no clock in it, and the engine deliberately owns no
   * clock: every temporal decision it makes is against the `nowMs` its caller
   * hands to `frame()`, which is what lets the whole of it be tested without a
   * browser. The renderer's degraded fallback (§62) is a second writer of
   * position that does not run through the frame loop, and it already keeps a
   * grace timer of its own — this is the fact it was missing.
   */
  readonly awaitingManualEvidence: boolean;

  /**
   * Point the engine at a transcription generation. Snapshots stamped with any
   * other generation are rejected, which is what keeps the tail of a stopped
   * take out of the next one's motion.
   */
  configureSession(sessionGeneration: number, nowMs: number): void;
  /**
   * §47.1/§55. Adopt a resolved motion profile — the user's Follow feel, as
   * control resolved it, arriving in the stage envelope.
   *
   * It is a setter rather than a constructor argument alone because the stage
   * window outlives a session: a second take on the same window republishes an
   * envelope into the SAME engine, and a profile that could only be read at
   * construction would leave the new session running the previous one's feel.
   *
   * Nothing about plant state changes. The profile reshapes the motion limits;
   * position, velocity and acceleration carry straight through, and the jerk
   * limiter absorbs the new bounds over the following frames rather than
   * stepping to them.
   */
  setProfile(next: SmoothFollowProfile): void;
  setLineMap(map: StageRenderedLineMap | null): void;
  setBounds(minPx: number, maxPx: number): void;
  setReducedMotion(reduced: boolean): void;
  /**
   * §48. Stop/resume automatic motion. `nowMs` stamps the takeover so ordinary
   * directives issued before it can be recognised as superseded; omitting it
   * leaves that stamp untouched.
   */
  setPaused(paused: boolean, nowMs?: number): void;

  /**
   * Ingest one alignment snapshot. Returns whether it was accepted; a rejected
   * snapshot changes nothing at all, which is the point.
   */
  receiveSnapshot(snapshot: unknown, nowMs: number): boolean;
  /**
   * Give up the current alignment lock, because something else is driving now.
   *
   * ---------------------------------------------------------------------------
   * WHY THIS IS NOT THE SAME AS THE FEED GOING QUIET
   * ---------------------------------------------------------------------------
   * An accepted snapshot outranks any fallback target for
   * `DEFAULT_SNAPSHOT_STALE_MS` — fifteen seconds — and that generosity is
   * deliberate: silence is a normal thing for a presenter to produce, and a
   * stage that dropped its lock every time somebody paused for breath would be
   * worse than useless.
   *
   * It is exactly wrong for an EXPLICIT instruction. When the operator starts
   * the fixed-pace transport, "the last thing the recogniser said is still
   * roughly true" stops being the question: they have told the stage to roll,
   * and a stage that answered by holding for fifteen seconds and then jumping
   * the accumulated distance would be a key that appeared not to work followed
   * by a lurch.
   *
   * So this is narrow on purpose. It does not weaken the precedence rule — an
   * ordinary fallback still loses to a live alignment frame, which is the
   * protection that keeps guessed geometry off the glass. It says the lock is
   * VOID, which only something with the authority to say so may do.
   */
  releaseAlignment(): void;
  setFallbackTarget(target: FallbackTarget | null): void;

  frame(nowMs: number): StageMotionFrameResult;

  /**
   * Authorized plant writes.
   *
   * `anchorUnit` is the spoken unit the presenter's hand left on the reading
   * line. Optional because only the renderer can work it out — it owns the
   * measured line map — and load-bearing when a relayout lands during the hold
   * that follows: without it, `layoutRecovery` preserves the ALIGNER's token
   * and snaps the document back to the place they just scrolled away from.
   */
  manualOverride(positionPx: number, nowMs: number, anchorUnit?: number | null): void;
  layoutRecovery(request: LayoutRecoveryRequest): void;
  visibilityRestored(positionPx: number, nowMs: number): void;
  reset(positionPx: number): void;
}

/**
 * How far the position must move for a relocation to be worth flying rather
 * than absorbing, in tokens.
 *
 * A retake that backs up two words is a correction and the smoothing should
 * swallow it; one that backs up a paragraph is a different place in the script
 * and deserves the deliberate, obscured re-anchor. Six tokens is roughly half a
 * spoken line — comfortably above the ±2-token accuracy the engine benchmarks
 * at, so ordinary tracking jitter can never mint a directive.
 */
const RELOCATION_MIN_TOKENS = 6;

/**
 * How long a synthesized relocation directive stays live.
 *
 * Long enough for the ~220 ms re-anchor fade plus a line-map rebuild; short
 * enough that a directive whose destination never resolves dies rather than
 * waiting for a jump that has been superseded twice over.
 *
 * A `catch_up` directive is the exception and gets its TTL from the profile
 * instead — see `relocationDirectiveFor`. It is not a discontinuity waiting to
 * be spent in one step but a boosted APPROACH, and §30.3 already bounds how
 * long that may run. A TTL shorter than `catchUpMaxDurationMs` would retire
 * the licence before the cap could, which would leave the cap — and its
 * decay ramp, and every test of both — dead code that nothing could reach.
 */
const RELOCATION_TTL_MS = 1500;

/**
 * How far back a retake may be FLOWN rather than stepped, in tokens — the
 * BLIND fallback, used only when the geometry cannot answer the question
 * properly (see `RewindReach`).
 *
 * A `rewind` is ordinary motion under a backward-capable profile, and ordinary
 * backward motion is hard-capped at `reverseTravelMaxPx` (420 px by default,
 * about a third of a screen) precisely so a rewind can never run away. That cap
 * makes a rewind the wrong shape for a DISTANT retake: the plant creeps back
 * its 420 px, the directive expires, and forward-only following resumes with
 * the presenter still thousands of pixels from where they restarted — stranded,
 * with nothing left that can carry them there.
 *
 * So distance decides, and the honest unit for that distance is PIXELS, because
 * the budget it is being compared against is pixels. Twelve tokens is roughly a
 * rendered line, which is somewhere between a fifth and a half of the travel a
 * rewind may actually spend — so as the only gate it sent every retake longer
 * than about a line to the obscured step, including the very common one where
 * the presenter backs up to a phrase still on the glass and would rather watch
 * the script walk back to it than have it cut. It survives as the answer for a
 * stage that has no map yet, where a token count is the only measure there is.
 */
const REWIND_MAX_TOKENS = 12;

/**
 * What a `rewind` would cost, measured on the glass (§30.5).
 *
 * Only the stage can supply this — the alignment engine has no notion of a
 * pixel, and `relocationDirectiveFor` has no notion of a line map — so it is
 * handed in, and its absence falls back to `REWIND_MAX_TOKENS`.
 */
export interface RewindReach {
  /** Backward travel from where the display IS to the retake point, px. */
  travelPx: number;
  /**
   * How long before the licence can first be spent at all, ms.
   *
   * Manual authority (§30.6) zeroes both velocity limits, so a rewind issued
   * mid-drag cannot move until the grace runs out. The TTL has to cover that or
   * the licence dies having done nothing — and what a rewind fails to do is
   * unrecoverable, because forward-only following cannot carry the document
   * backward afterwards.
   *
   * The grace OUTSTANDING, not the profile's whole grace interval. A retake
   * arriving when nobody has touched the script gets no extension, which keeps
   * the window where the document may move backward — and the §70.5 forward
   * latch is therefore released — as short as the travel actually needs.
   */
  graceRemainingMs: number;
  /**
   * §30.5 reverse-travel budget the rewind may spend, px — what is LEFT of it,
   * not what a fresh plant would get.
   *
   * The budget is cumulative and only forward motion refunds it, so a second
   * retake before the presenter has read their way back is measured against a
   * partly spent one. Classifying it against the full budget is how a rewind
   * gets licensed for travel the controller will not grant: measured on a
   * paragraph retake followed by two lines of re-reading and a second retake,
   * the walk was licensed for 197 px with 134 px left and the plant parked
   * 69 px — over a line — above the presenter, with forward-only following
   * unable to close it. A re-anchor is the honest answer there, and it arrives.
   */
  budgetPx: number;
}

/**
 * How the stage animates each kind of accepted discontinuity.
 *
 * A `retakeAccepted` the plant can walk to is a `rewind`, because backward
 * motion over a distance the presenter can see still reads as reading — they
 * watch the script return to where they restarted, which is the whole
 * information content of the move. One beyond the reverse-travel budget becomes
 * a `reanchor` (see `RewindReach`). A forward jump has no such reading to show:
 * the text between is not being spoken, so flying through it at speed is a
 * spectacle rather than information, and `catch_up` bounds it.
 */
const RELOCATION_SHAPE: Record<
  'relocationAccepted' | 'jumpForwardAccepted' | 'retakeAccepted' | 'manualAnchor',
  { type: StageTransitionDirective['type']; reason: StageTransitionDirective['reason']; authority: StageTransitionDirective['authority'] }
> = {
  jumpForwardAccepted: {
    type: 'catch_up',
    reason: 'large_forward_skip',
    authority: 'ordinary',
  },
  retakeAccepted: { type: 'rewind', reason: 'distant_retake', authority: 'ordinary' },
  relocationAccepted: { type: 'reanchor', reason: 'large_forward_skip', authority: 'ordinary' },
  manualAnchor: { type: 'reanchor', reason: 'manual_navigation', authority: 'manual' },
};

/**
 * Can the plant WALK to this retake point, or does it have to step?
 *
 * The pixel answer whenever the stage has one: a rewind is ordinary motion, so
 * the only thing that decides whether it arrives is whether the travel fits the
 * §30.5 reverse budget it is allowed to spend. Travel that is zero or forward
 * fits trivially — a backward-capable profile never obliges the plant to move
 * backward, so a retake whose destination is already at or below the display is
 * simply followed.
 *
 * With no reach to measure against, the token proxy: about a rendered line.
 */
function rewindFits(reach: RewindReach | null, distanceTokens: number): boolean {
  if (!reach || !Number.isFinite(reach.travelPx) || !Number.isFinite(reach.budgetPx)) {
    return distanceTokens <= REWIND_MAX_TOKENS;
  }
  return reach.travelPx <= Math.max(0, reach.budgetPx);
}

/**
 * How long a `rewind`'s backward licence has to stay open.
 *
 * A rewind is not spent in one step the way a re-anchor is — it is ordinary
 * motion under a backward-capable profile — so the DIRECTIVE has to outlive the
 * travel. While the gate was a single line, any TTL longer than the fade
 * covered it. Now that the gate is the reverse-travel budget itself, a flat
 * 1.5 s expires part-way up the far end of that budget: `allowBackward` goes
 * false with the plant still parked below the retake point, and forward-only
 * following has nothing that can bring it down again.
 *
 * So the licence is the base TTL — which covers the jerk-limited reversal at
 * the start, including whatever forward velocity the plant is carrying — plus
 * the travel's own cruise time at the profile's backward ceiling, doubled for
 * the damped approach that follows it. A second-order controller spends about
 * as long easing into the last few pixels as it does crossing the rest, and it
 * spends longer the further it came, so the allowance has to scale with the
 * distance rather than sit in the constant.
 *
 * And whatever manual grace is still outstanding, for the same reason `catch_up`
 * carries it (§30.6) — see `RewindReach.graceRemainingMs`. Unlike catch-up this
 * takes the grace REMAINING rather than the profile's whole interval, because a
 * live rewind releases the §70.5 forward latch, and a licence held open for
 * seconds after the walk is done is a licence for tracker jitter to reverse the
 * document. Travel is what this bound is trying to describe; the grace only
 * covers the part of it that cannot be spent yet.
 */
const REWIND_APPROACH_SHARE = 2;

function rewindTtlMs(reach: RewindReach | null, profile: SmoothFollowProfile): number {
  const travelPx = reach && Number.isFinite(reach.travelPx) ? Math.max(0, reach.travelPx) : 0;
  const graceMs =
    reach && Number.isFinite(reach.graceRemainingMs) ? Math.max(0, reach.graceRemainingMs) : 0;
  // The ceiling the rewind will actually run under, multiplier included, read
  // from the same table the frame loop reads rather than restated here.
  const vBackwardPxS = limitsForState('following', profile, { transition: 'rewind' }).vBackwardMax;
  if (!(vBackwardPxS > 0) || !Number.isFinite(vBackwardPxS)) return RELOCATION_TTL_MS + graceMs;
  return RELOCATION_TTL_MS + graceMs + (travelPx / vBackwardPxS) * 1000 * REWIND_APPROACH_SHARE;
}

/**
 * Turn an accepted discontinuity into a §53 transition directive, or null when
 * the snapshot is ordinary following.
 *
 * The engine reports discontinuities as an ordinary snapshot whose position
 * moved a long way, plus a decision code saying so. It does not issue motion
 * directives — it has no idea what a pixel is — so the stage classifies. The
 * distance gate is applied here rather than trusting the code alone, because
 * `retakeAccepted` fires for a two-word restart just as it does for a jump back
 * to the top of the script.
 */
export function relocationDirectiveFor(
  snapshot: AlignmentSnapshot,
  previousToken: number | null,
  nowMs: number,
  profile: SmoothFollowProfile = DEFAULT_SMOOTH_FOLLOW_PROFILE,
  /**
   * How long automatic correction may be suspended before this directive can
   * be exercised at all (§30.6). Folded into the catch-up TTL below.
   */
  manualGraceMs = DEFAULT_MANUAL_GRACE_MS,
  /**
   * What a rewind would cost on this stage's geometry, when it is known.
   * Null — no map, an unresolvable destination — falls back to the token proxy.
   */
  rewindReach: RewindReach | null = null,
): StageTransitionDirective | null {
  if (!ALIGNMENT_RELOCATIONS.has(snapshot.decision)) return null;
  const shape = RELOCATION_SHAPE[snapshot.decision as keyof typeof RELOCATION_SHAPE];
  if (!shape) return null;

  const from = previousToken ?? snapshot.observedToken;
  const distance = Math.abs(snapshot.observedToken - from);
  // A manual move is authoritative regardless of distance: the presenter asked
  // to be somewhere, and honouring that only when it is far enough away would
  // make a short jump-to-section silently do nothing.
  if (shape.authority !== 'manual' && distance < RELOCATION_MIN_TOKENS) return null;

  // A retake further back than ordinary reverse motion can carry has to be a
  // step, not a walk — see `RewindReach`.
  const type: StageTransitionDirective['type'] =
    shape.type === 'rewind' && !rewindFits(rewindReach, distance) ? 'reanchor' : shape.type;

  /*
   * A catch-up runs until §30.3's duration cap retires it, and a rewind until
   * its travel is done (`rewindTtlMs`); a re-anchor is a single step that either
   * lands promptly or should be forgotten. The first two both cover the manual
   * grace, for the reason spelled out immediately below.
   *
   * The TTL starts at RECEIPT, but the cap's clock does not start until the
   * licence can actually be exercised — and manual authority suspends that for
   * a whole grace interval (§30.6). With a TTL of cap + release alone, a jump
   * that arrives while the presenter is dragging the script gets what is left
   * after the grace: 250 ms of the 2500 ms it is entitled to, so neither the
   * cap nor its release ramp is ever reached and the catch-up simply does not
   * happen. Covering the grace makes the CAP the binding constraint again,
   * which is the whole point of having one.
   */
  const ttlMs =
    type === 'catch_up'
      ? Math.max(
          RELOCATION_TTL_MS,
          manualGraceMs + profile.motion.catchUpMaxDurationMs + profile.motion.catchUpReleaseMs,
        )
      : type === 'rewind'
        ? rewindTtlMs(rewindReach, profile)
        : RELOCATION_TTL_MS;

  return {
    // Keyed on `seq`, so the idempotency check in the transition controller
    // collapses a re-delivered snapshot instead of re-running the motion.
    id: `align-${snapshot.sessionGeneration}-${snapshot.seq}`,
    type,
    authority: shape.authority,
    fromUnit: from,
    toUnit: snapshot.observedToken,
    destinationTokenIndex: Math.max(0, Math.round(snapshot.observedToken)),
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + ttlMs,
    semanticEpoch: snapshot.sessionGeneration,
    reason: shape.reason,
  };
}

/**
 * How long after the last snapshot the stage stops claiming to follow.
 *
 * Not a prediction bound — `displayAt` already stops advancing at
 * `maxPredictionMs`, so an old snapshot holds position on its own. This is the
 * threshold past which the feed is treated as GONE rather than quiet, and the
 * fallback target takes over. Generous, because silence is a normal thing for a
 * presenter to produce and a stage that dropped its lock every time somebody
 * paused for breath would be worse than useless.
 */
/**
 * Decisions that end a manual hold (§30.6).
 *
 * The hold that follows a manual scroll waits for EVIDENCE, not for a clock —
 * see `manualAwaitingEvidence` — and "evidence" has to mean the tracker
 * actually heard the presenter say something it was willing to act on. The
 * codes left out are the ones that report the opposite: `noEvidence` is
 * silence, `jumpPending` is a jump the engine has explicitly not accepted, and
 * the three `hold*` codes are the tracker declining to move on what it heard.
 *
 * Releasing on those would put the wall clock back in charge by the side door,
 * because the aligner emits them on its own cadence whether or not anybody is
 * speaking — which is exactly how the document used to start travelling while
 * the presenter was still deciding where to read from.
 */
const MANUAL_HOLD_RELEASE_DECISIONS: ReadonlySet<AlignmentDecision> = new Set<AlignmentDecision>([
  'localObserved',
  'localConfirmed',
  'relocationAccepted',
  'jumpForwardAccepted',
  'retakeAccepted',
  'manualAnchor',
]);

/**
 * How long the gentle re-acquisition may run before ordinary following takes
 * the correction back.
 *
 * A bound rather than "until it arrives", for the same reason §30.3 caps
 * catch-up: a correction that is still visibly running seconds later has
 * stopped being a re-grab and become the document travelling on its own. At
 * four lines a second this carries about ten lines, which is more than the
 * gesture that produced it can leave behind — a scroll further than half a
 * screen re-anchors the tracker instead (see `manual_scroll`), so the gap this
 * closes is bounded by construction and the cap is a backstop, not the design.
 */
const REACQUIRE_MAX_MS = 2500;

const DEFAULT_SNAPSHOT_STALE_MS = 15_000;
const DEFAULT_STYLE_INTERVAL_MS = 100;
const DEGRADED_STYLE_INTERVAL_MS = 250;
const DEFAULT_MANUAL_GRACE_MS = 2500;
/**
 * How long a beyond-threshold backward disagreement must persist before the
 * forward latch gives way to an authorized re-anchor. Long enough that a single
 * bad frame or a one-off tracker wobble never repositions the document; short
 * enough that a presenter who really is a third of a viewport behind is not
 * left reading text that is no longer on the glass.
 */
const LATCH_REANCHOR_PERSISTENCE_MS = 400;

/* ------------------------------------------------------------------- §30 --
 * Line units are half a bound. The panel sets the other half.
 *
 * `SmoothFollowLineUnits` restates the motion bounds as multiples of the
 * MEASURED pitch, because what a presenter perceives is lines rather than
 * pixels, and that is the right unit right up until a line stops being a small
 * part of the glass. Calibrate a 15.6-inch panel for arm's length and the pitch
 * passes 200 px: five lines of reverse travel is then more than a full screen,
 * and ten line pitches a second is the whole document leaving. Motion the
 * presenter reads in lines becomes motion nobody reads at all.
 *
 * So every bound the pitch can scale is met by a bound the panel sets and the
 * narrower one wins. Lines because the reader experiences lines; viewport
 * heights because a sweep across the whole glass is disruptive regardless of
 * how tall a line happens to be on this rig.
 *
 * The four numbers below are deliberately just above the tuned profile's own,
 * restated in viewport heights: 900, 600, 2600 and 12000 px on the 1080 px
 * stage they were tuned on are 0.83 viewport heights per second, 0.56 per
 * second, 2.41 per second squared and 11.1 per second cubed. Two consequences,
 * both load-bearing:
 *
 *   - on that stage NONE of them bind. The rig the profile was evaluated
 *     against moves exactly as it does today; these are a safety net for
 *     panels the tuning never saw, not a retune of the tuning.
 *   - where they do bind they scale velocity, acceleration and jerk by nearly
 *     one factor, which is what keeps the plant coupled. The limit-cycle note
 *     in `profiles.ts` is about `aMax` moving against a fixed `jerkMax`: the
 *     actuator's rail-to-rail swing time `2·aMax/jerkMax` grows, phase margin
 *     goes, and the text visibly rocks. The small spread here runs the other
 *     way — acceleration is capped a shade harder than jerk — so the swing
 *     time shortens and the margin can only improve.
 */
const MAX_FORWARD_VIEWPORTS_PER_SECOND = 1;
/**
 * Backward motion gets less. It is rarer, it always means something went wrong,
 * and a reverse sweep is read as the document leaving rather than as reading —
 * the same asymmetry the profile's own 900/600 pair already carries.
 */
const MAX_BACKWARD_VIEWPORTS_PER_SECOND = 0.7;
const MAX_ACCELERATION_VIEWPORTS_PER_SECOND2 = 2.5;
const MAX_JERK_VIEWPORTS_PER_SECOND3 = 12;

/**
 * §8.6's derivative clamp, viewport-relative. One spoken word may not move the
 * document more than a screen however tall the type is; the line-relative
 * clamp beside it (12 pitches) is 768 px at the reference pitch and 3600 px at
 * a calibrated 300 px one, where it stops bounding anything a presenter would
 * recognise as a bound.
 */
const MAX_DERIVATIVE_VIEWPORTS_PER_UNIT = 1;

/**
 * §20.4. A step across a quarter of the glass is one the presenter sees,
 * whatever the type size — so that is where "too small to be worth obscuring"
 * stops being true. Without it a 300 px pitch would quietly redefine a
 * third-of-a-screen jump as invisible.
 */
const MAX_FADE_SKIP_VIEWPORT_FRACTION = 0.25;

/**
 * What `fadeSkipLines` means for a profile that carries no `lineUnits` at all.
 *
 * That profile is legal and stays legal: §55 makes the block additive, and its
 * absence is a request for "the behaviour every build before this one had"
 * rather than a truncation. For THIS bound that behaviour was one measured
 * pitch — the engine hard-coded it — so reading the field and stopping there
 * answers "no threshold", the one-pixel floor takes over, and a quarter-line
 * re-anchor nobody could see drags a 220 ms full-field fade onto the glass with
 * it. Restating the engine's old constant as the default is what makes the
 * absent block mean what it says it means.
 *
 * It is deliberately NOT paired with a `catchUpCeilingLines` default. That
 * field's old behaviour, on a map with no corridor, was no ceiling at all, so
 * leaving it unresolved is what preserves it; defaulting there would invent a
 * bound a profile never asked for rather than restore one it used to get.
 */
const DEFAULT_FADE_SKIP_LINES = 1;

/**
 * §30.3. How far past the target the plant may be carried when no reading
 * corridor is available to say. A tenth of the glass is already generous for a
 * bound whose whole job is to catch a plant parked ahead of its target.
 */
const MAX_CATCH_UP_CEILING_VIEWPORT_FRACTION = 0.1;

/**
 * The profile as this panel may actually run it (§30).
 *
 * Applied to the profile's BASE numbers rather than to the composed limits, so
 * that a state or transition multiplier still means what the table says: a
 * catch-up is 1.6× ordinary following on every rig. Capping after the
 * multipliers would put a panel constant in front of §30.3's own three bounds
 * on the boost — the duration cap, the corridor-relative decay, and the upper
 * safety boundary — and none of them knows anything about the gap being
 * closed, while all three exist precisely to shape how it is.
 *
 * Returns the profile ITSELF when nothing binds, which is every rig at or above
 * the 1080 px the numbers were tuned on. That keeps the common case free of an
 * allocation and makes "this panel changed nothing" checkable by identity.
 */
export function viewportBoundedProfile(
  profile: SmoothFollowProfile,
  viewportHeightPx: number,
): SmoothFollowProfile {
  if (!Number.isFinite(viewportHeightPx) || viewportHeightPx <= 0) return profile;
  const m = profile.motion;
  const maxForwardVelocityPxS = Math.min(
    m.maxForwardVelocityPxS,
    viewportHeightPx * MAX_FORWARD_VIEWPORTS_PER_SECOND,
  );
  const maxBackwardVelocityPxS = Math.min(
    m.maxBackwardVelocityPxS,
    viewportHeightPx * MAX_BACKWARD_VIEWPORTS_PER_SECOND,
  );
  const maxAccelerationPxS2 = Math.min(
    m.maxAccelerationPxS2,
    viewportHeightPx * MAX_ACCELERATION_VIEWPORTS_PER_SECOND2,
  );
  let maxJerkPxS3 = Math.min(
    m.maxJerkPxS3,
    viewportHeightPx * MAX_JERK_VIEWPORTS_PER_SECOND3,
  );

  /*
   * The two caps are independent, and that is the one way this could hurt.
   *
   * A jerk-limited actuator needs `2·aMax/jerkMax` to swing acceleration from
   * one rail to the other, and profiles.ts's limit-cycle note explains what too
   * much of that lag does inside this loop: the phase margin goes and the
   * document rocks against a static target instead of settling. Capping jerk
   * harder than acceleration LENGTHENS that lag.
   *
   * For the profiles that ship it never happens — acceleration starts binding
   * at a taller panel than jerk does, so the ratio only ever shortens. But the
   * contract accepts profiles nobody here wrote, and one whose acceleration is
   * already under its cap while its jerk is not would come out worse than it
   * went in. Rather than rely on the shipped numbers staying where they are,
   * give back whatever jerk the incoming ratio was entitled to.
   */
  const incomingLagS = m.maxJerkPxS3 > 0 ? (2 * m.maxAccelerationPxS2) / m.maxJerkPxS3 : 0;
  if (incomingLagS > 0) {
    const jerkForSameLag = (2 * maxAccelerationPxS2) / incomingLagS;
    maxJerkPxS3 = Math.min(m.maxJerkPxS3, Math.max(maxJerkPxS3, jerkForSameLag));
  }
  if (
    maxForwardVelocityPxS === m.maxForwardVelocityPxS &&
    maxBackwardVelocityPxS === m.maxBackwardVelocityPxS &&
    maxAccelerationPxS2 === m.maxAccelerationPxS2 &&
    maxJerkPxS3 === m.maxJerkPxS3
  ) {
    return profile;
  }
  return {
    ...profile,
    motion: {
      ...m,
      maxForwardVelocityPxS,
      maxBackwardVelocityPxS,
      maxAccelerationPxS2,
      maxJerkPxS3,
    },
  };
}

/* ------------------------------------------------------------------ §20.4 --
 * The re-anchor transition.
 *
 * A re-anchor is an authorized DISCONTINUITY: the document is somewhere the
 * presenter is not, and the honest fix is to put it where they are in one step
 * rather than fly there. Applied bare, though, that step is a teleport — the
 * whole script snaps across the glass and the presenter loses their place
 * exactly when they are already recovering from a skip or a retake.
 *
 * §20.4's answer is to hide the step rather than soften it: fade the document
 * down, change the transform WHILE IT IS INVISIBLE, fade it back up. The
 * presenter sees the text dim and return in the right place. They never see it
 * move, because it never moves while it can be seen.
 *
 * The ordering is the whole design. A fade that merely overlaps the jump is
 * worse than no fade at all — a half-transparent document sliding across the
 * glass is a ghost, and a ghost is harder to ignore than a cut. So the plant
 * write is gated on the fade-down being COMPLETE, and the frame that performs
 * it reports `documentOpacity: 0`.
 */

/**
 * Per leg. §20.4 specifies 90–130 ms for the fade-down and the fade-up; this is
 * the midpoint, so the whole transition costs ~220 ms. Well inside the 1.5 s
 * `transitionTtlMs` a directive is issued with, so an ordinary directive never
 * expires underneath its own fade.
 */
export const REANCHOR_FADE_MS = 110;

/**
 * Reduced motion: an instant cut, no fade.
 *
 * §20.4 says "respect reduced motion with a near-instant opacity transition",
 * and this deviates from that wording deliberately. A fade of the WHOLE
 * document is a full-field luminance swing, which is the accommodation
 * photosensitive users are asking to be spared; and shrinking it to "near
 * instant" (two frames) does not obscure anything anyway — it is a flicker
 * wrapped around a jump the presenter still sees. The rest of this codebase
 * already reads reduced motion as "reposition without a spectacle" (§32.4:
 * `classifyTransition` returns `instant`, and the motion limits drop the
 * easing), so a bare cut is the consistent reading.
 *
 * The machinery is duration-driven, so restoring the literal spec behaviour is
 * this constant: set it to ~40 and reduced motion gets a two-frame fade with
 * the same move-while-obscured guarantee.
 */
const REDUCED_MOTION_FADE_MS = 0;

/**
 * Below this the re-anchor is not a teleport and there is nothing worth
 * obscuring, so fading would be a gratuitous flash — a re-affirmed directive
 * whose destination is where we already are, or a session reset issued while
 * the document is already at the top.
 *
 * The threshold is resolved by `fadeSkipThresholdPx` from the profile and the
 * measured geometry; the one-pixel floor lives here so that "no geometry yet"
 * still answers the question rather than fading a zero-length move.
 */
function fadeWorthwhile(distancePx: number, skipThresholdPx: number): boolean {
  return distancePx > Math.max(1, skipThresholdPx);
}

type ReanchorFadePhase = 'idle' | 'down' | 'up';

export function createStageMotionEngine(
  options: StageMotionEngineOptions = {},
): StageMotionEngine {
  // §47.1: mutable, because a stage window outlives a session and the next
  // session's envelope may carry a different feel. Read on every frame — never
  // captured — so a swap takes effect on the next one.
  let profile = options.profile ?? DEFAULT_SMOOTH_FOLLOW_PROFILE;
  /**
   * `profile` with its §30 viewport ceilings applied — the one every motion
   * limit is composed from.
   *
   * Recomputed in `rebuildPlanner`, which already runs on every event that can
   * move either input — `setProfile`, `setLineMap`, `layoutRecovery` — because
   * the viewport height comes off the map's own fingerprint. Deriving it per
   * frame instead would allocate sixty times a second for a value that changes
   * about twice a session, against a §63 budget of a millisecond for the whole
   * motion pass.
   */
  let boundedProfile = profile;
  const snapshotStaleMs = options.snapshotStaleMs ?? DEFAULT_SNAPSHOT_STALE_MS;
  const styleIntervalMs = options.styleIntervalMs ?? DEFAULT_STYLE_INTERVAL_MS;
  const manualGraceMs = options.manualGraceMs ?? DEFAULT_MANUAL_GRACE_MS;

  const receiver = createAlignmentReceiver();
  const controller = createJerkLimitedScrollController();
  const transitions = createStageTransitionController();
  const diagnostics = createStageMotionDiagnostics({ ackIntervalMs: options.ackIntervalMs });
  /**
   * §70.8. A hitch is a MISSED REFRESH, so the threshold has to come from the
   * refresh the display actually has — a fixed one is a 60 Hz assumption, and
   * on a 30 Hz panel it made every healthy frame a dropped frame.
   */
  const frameInterval = createFrameIntervalEstimator();

  let map: StageRenderedLineMap | null = null;
  let planner: LineHandoffPlanner | null = null;
  let fallback: FallbackTarget | null = null;
  let reducedMotion = false;
  let paused = false;
  let manualUntilMs = Number.NEGATIVE_INFINITY;
  /**
   * §30.6. The presenter moved the script by hand and has not spoken since.
   *
   * The grace interval used to be the whole of manual authority, and a wall
   * clock is the wrong instrument for it. The presenter scrolls back a
   * paragraph, reads the line to themselves, draws breath — and two and a half
   * seconds later, with the stage still silent, the grace expired and the
   * document set off for wherever the tracker's last snapshot said they were.
   * The correction they eventually saw was not a response to anything they had
   * done; it was a timer.
   *
   * So the timer became the floor and this is the real condition: hold where
   * they put it until they say something. A presenter who scrolls and never
   * speaks again is answered by a document that never moves, which is the only
   * honest thing a stage with no evidence can do.
   */
  let manualAwaitingEvidence = false;
  /**
   * The token the presenter's own hand left on the reading line, or null when
   * they have not moved the script.
   *
   * Kept because `lastDisplayToken` cannot answer for them: it follows the
   * ALIGNER, and goes on following it through a manual hold. A live relayout
   * during that hold — a font change, a resize, an optics rebuild — asks
   * `layoutRecovery` which token to preserve, and answering with the aligner's
   * snapped the document straight back to the place the presenter had just
   * scrolled away from, silently, while the hold was still in force.
   */
  let manualAnchorUnit: number | null = null;
  /**
   * When the presenter last took the script off automatic control, on the
   * stage's own clock. `Number.NEGATIVE_INFINITY` means they never have.
   *
   * Ordinary transition directives minted before this moment described a
   * document that no longer exists. See `supersededTransition`.
   */
  let manualAuthorityAtMs = Number.NEGATIVE_INFINITY;
  /**
   * A gentle re-grab is owed: the presenter moved the script, has since spoken,
   * and the correction has not been spent yet.
   *
   * A DEBT rather than a deadline, and the difference is the whole bug it fixes.
   * An absolute `reacquireUntilMs` was armed the moment evidence arrived — which
   * is routinely the same second the gesture ended, because a presenter who
   * scrolls mid-sentence never stops speaking. The clock then ran through the
   * remaining wall-clock grace, during which re-acquisition is forbidden and
   * the plant cannot move at all, and expired with the gap barely touched.
   * Ordinary following picked the rest up at 900 px/s: the original defect,
   * rebuilt out of its own fix.
   *
   * So the cap is spent in ELIGIBLE time (`reacquireElapsedMs`), and frozen,
   * held, faded, hidden and manual frames cost it nothing.
   */
  let reacquireOwed = false;
  /** Eligible milliseconds spent on the re-grab so far. See `REACQUIRE_MAX_MS`. */
  let reacquireElapsedMs = 0;
  /**
   * The backward licence this re-grab was granted, latched on its first eligible
   * frame, or null while none is in flight.
   *
   * LATCHED, because the controller's `reverseTravelPx` is cumulative and the
   * gap being closed is not. Recomputing the cap from the remaining gap each
   * frame let the ceiling fall as fast as the counter rose: a 500 px backward
   * re-grab against a 420 px standing budget started with 596 px of licence,
   * and by the time 420 px had been spent the recomputed cap was back to 420 —
   * so the plant hit the §30.5 wall and dead-stopped about 80 px short, with
   * ordinary forward-only following unable to finish the journey.
   */
  let reacquireBudgetPx: number | null = null;
  let lastFrameAtMs: number | null = null;
  let lastStyleAtMs = Number.NEGATIVE_INFINITY;
  /** Token position the last rendered frame aimed at — the layout-recovery anchor. */
  let lastDisplayToken: number | null = null;
  /**
   * Display position of the previously accepted snapshot, which is what a
   * relocation's distance is measured FROM. Deliberately not `observedToken` of
   * the previous snapshot: the presenter sees the display, and the size of the
   * jump they experience is the size of the jump from where the document is.
   */
  let previousDisplayToken: number | null = null;
  let lastTarget = 0;
  let lastLineId: string | null = null;
  /**
   * §70.5. Under a forward-only profile the desired position is latched
   * monotonically: a revised target that moves BACKWARD cannot be followed
   * (reverse is forbidden), so honouring it would only park the plant past a
   * target it can never reach and leave a permanent tracking error. A genuine
   * regression arrives as a backward-capable state or a re-anchor directive,
   * both of which clear the latch.
   */
  let forwardTargetLatchPx: number | null = null;
  /** Target regressions suppressed by the latch — diagnostics only. */
  let targetRegressions = 0;
  /**
   * When the latched target first got further than `reanchorThresholdPx` ahead
   * of where the tracker says the presenter is, or null while it has not.
   */
  let latchExcessSinceMs: number | null = null;
  /** Re-anchors the latch escape hatch performed — diagnostics only. */
  let latchReanchors = 0;
  /** Frames on which a plant-overwrite licence was parked (§62) — diagnostics. */
  let deferredPlantOverwrites = 0;
  /** Visual-block span the plant is currently held at (§8.6). */
  let heldVisualSpan: VisualBlockSpan | null = null;
  /**
   * §30.3 duration cap. When the current catch-up licence first appeared, or
   * null while none is in force. One continuous licence is one episode: losing
   * it (the tracker leaves `catching_up`, the directive expires, manual
   * authority takes over) ends the episode and re-acquiring it starts a fresh
   * one, because that is a new thing to catch up with.
   */
  let catchUpSinceMs: number | null = null;
  /** One `catchUpCapExpiries` increment per episode, not per frame. */
  let catchUpCapCounted = false;
  /** Catch-up episodes retired by the §30.3 duration cap — diagnostics only. */
  let catchUpCapExpiries = 0;

  /* ---- §20.4 re-anchor fade ---- */
  let fadePhase: ReanchorFadePhase = 'idle';
  let fadeStartedAtMs = 0;
  /** Opacity the current leg ramps FROM, so an interrupted leg never snaps. */
  let fadeFromOpacity = 1;
  /** Re-anchor transitions obscured by a fade — diagnostics only. */
  let reanchorFades = 0;

  function fadeLegMs(): number {
    return reducedMotion ? REDUCED_MOTION_FADE_MS : REANCHOR_FADE_MS;
  }

  function opacityAt(nowMs: number): number {
    if (fadePhase === 'idle') return 1;
    const leg = fadeLegMs();
    const t = leg <= 0 ? 1 : Math.min(1, Math.max(0, (nowMs - fadeStartedAtMs) / leg));
    return fadePhase === 'down'
      ? fadeFromOpacity * (1 - t)
      : fadeFromOpacity + (1 - fadeFromOpacity) * t;
  }

  function beginFade(phase: 'down' | 'up', nowMs: number) {
    fadeFromOpacity = opacityAt(nowMs);
    fadePhase = phase;
    fadeStartedAtMs = nowMs;
  }

  /**
   * May the plant be written for a re-anchor to `destinationPx` on this frame?
   *
   * True only when the document is genuinely obscured — or when obscuring it
   * was never warranted (reduced motion, or a move too small to see). This is
   * the gate that makes "the transform changes while invisible" a property of
   * the code rather than a hope about timing.
   */
  function fadeAdmitsReanchor(nowMs: number, destinationPx: number): boolean {
    if (fadeLegMs() <= 0) return true;
    // A fade already at zero is the point of the exercise: move now.
    if (fadePhase === 'down') return nowMs - fadeStartedAtMs >= fadeLegMs();
    return !fadeWorthwhile(
      Math.abs(destinationPx - controller.state.q),
      fadeSkipThresholdPx(),
    );
  }

  /**
   * §20.4 + §30. How small a re-anchor has to be before obscuring it would be a
   * gratuitous flash rather than a mercy.
   *
   * One rendered line is the natural unit — a correction the presenter cannot
   * distinguish from ordinary following — and `fadeSkipLines` is where the
   * profile says so. This used to be a hard-coded single pitch, so a profile
   * that carried the field changed nothing whatsoever; a profile that omits the
   * block falls back to that same single pitch (`DEFAULT_FADE_SKIP_LINES`), so
   * every profile that does not say otherwise gets the number it always got.
   *
   * The viewport ceiling is the other half of the bound and it earns its place
   * at large type: at a 300 px pitch one line is more than a quarter of a
   * 1080 px stage, and a step across a quarter of the glass is one the
   * presenter sees. Without it "too small to bother hiding" would come to mean
   * "a third of the screen".
   */
  function fadeSkipThresholdPx(): number {
    return lineBoundPx(
      profile.lineUnits?.fadeSkipLines ?? DEFAULT_FADE_SKIP_LINES,
      MAX_FADE_SKIP_VIEWPORT_FRACTION,
    );
  }

  /**
   * Nothing is pending behind the fade any more — the directive expired, its
   * licence was revoked, or its destination stopped resolving. Come back up.
   * Text left dim is not a degraded transition, it is a permanently unreadable
   * stage, so every exit path from `down` runs through here or through the
   * apply itself.
   */
  function abortFadeIfOrphaned(nowMs: number, pending: boolean) {
    if (fadePhase === 'down' && !pending) beginFade('up', nowMs);
    if (fadePhase === 'up' && nowMs - fadeStartedAtMs >= fadeLegMs()) {
      fadePhase = 'idle';
      fadeFromOpacity = 1;
    }
  }

  function resetFade() {
    fadePhase = 'idle';
    fadeStartedAtMs = 0;
    fadeFromOpacity = 1;
  }

  /** Every authorized plant write goes through here so the latch stays honest. */
  function reanchorTo(positionPx: number, velocityPxS?: number) {
    controller.reanchor(positionPx, velocityPxS === undefined ? undefined : { velocityPxS });
    forwardTargetLatchPx = null;
    heldVisualSpan = null;
  }

  /**
   * The measured line pitch, or 0 when nothing has been measured yet.
   *
   * Read straight off the map rather than cached beside it. The pitch and the
   * geometry it describes are one object, so there is no second copy that can
   * survive a rebuild and quietly bound the new layout with the old layout's
   * lines — which is the whole reason this is not a public setter. A stage that
   * has no map has no pitch, and `resolveLineLimitPx` answers that with the
   * profile's tuned pixel numbers, which is the pre-optical behaviour exactly.
   */
  function measuredPitchPx(): number {
    const pitch = map?.linePitchPx ?? 0;
    return Number.isFinite(pitch) && pitch > 0 ? pitch : 0;
  }

  /**
   * The glass, from the fingerprint the map was built against — so the viewport
   * a bound is measured in is always the viewport the layout was measured in.
   * Zero means unknown, and every §30 viewport ceiling is then simply not
   * applied rather than guessed at.
   */
  function viewportHeightPx(): number {
    const height = map?.fingerprint.viewportHeightPx ?? 0;
    return Number.isFinite(height) && height > 0 ? height : 0;
  }

  /**
   * A line-relative bound, met by its viewport ceiling (§30).
   *
   * Zero for "no answer" — no pitch measured, or a profile that named no
   * multiple — which every caller reads as "fall back to what you did before".
   */
  function lineBoundPx(lines: number | undefined, viewportFraction: number): number {
    const pitch = measuredPitchPx();
    if (pitch <= 0 || typeof lines !== 'number' || !Number.isFinite(lines) || lines <= 0) {
      return 0;
    }
    const linePx = lines * pitch;
    const height = viewportHeightPx();
    return height > 0 ? Math.min(linePx, height * viewportFraction) : linePx;
  }

  function rebuildPlanner() {
    const heightPx = viewportHeightPx();
    boundedProfile = viewportBoundedProfile(profile, heightPx);
    planner =
      map && map.valid
        ? createLineHandoffPlanner(map, {
            maxFeedForwardPxS: boundedProfile.motion.maxForwardVelocityPxS,
            // A media or paragraph gap must never hand the controller an
            // unbounded derivative (§8.6) — and neither must large type. Twelve
            // pitches is 768 px at the reference pitch and 3600 px at a
            // calibrated 300 px one, where the clamp has stopped bounding
            // anything a presenter would call a bound; one viewport per spoken
            // word is the half of it that survives the conversion (§30).
            maxDerivativePxPerUnit: Math.min(
              Math.max(1, map.linePitchPx) * 12,
              heightPx > 0
                ? heightPx * MAX_DERIVATIVE_VIEWPORTS_PER_UNIT
                : Number.POSITIVE_INFINITY,
            ),
          })
        : null;
  }

  /** Token under the predicted unit, for capped-rate active styling. */
  function activeTokenFor(unit: number, lineId: string | null): number | null {
    if (!map) return null;
    const line = lineId ? map.lines.find((l) => l.lineId === lineId) : map.lineForUnit(unit);
    if (!line) return null;
    let token = line.firstTokenIndex;
    for (const stop of line.tokenStops) {
      if (stop.spokenUnit <= unit) token = stop.tokenIndex;
      else break;
    }
    return token;
  }

  /**
   * The position the display should be at this frame, as pixels and a
   * feed-forward velocity.
   *
   * Returns null whenever the stage has no business moving: no snapshot, no
   * line map, a feed that has gone away, or arithmetic that came out
   * non-finite. Every one of those is a hold, never a guess.
   */
  function alignmentTarget(nowMs: number): {
    target: LineTarget;
    snapshot: AlignmentSnapshot;
    displayToken: number;
  } | null {
    const snapshot = receiver.current;
    if (!snapshot || !planner) return null;
    if (receiver.ageMs(nowMs) > snapshotStaleMs) return null;
    const audioNow = receiver.audioNowMs(nowMs);
    if (audioNow === null) return null;

    /*
     * Sampled at NOW, never at a moment in the future.
     *
     * The stage used to add a comfort lead here (§47.3 "voice lead", 0.38 s by
     * default) on the reasoning that a presenter should read into text that is
     * already placed. That was right while a current-word underline existed —
     * you want the mark under the word you are about to say. It is wrong for a
     * fade, where the same lead is spent erasing words before they have been
     * spoken, and it compounds with the engine's own extrapolation rather than
     * replacing it: replaying the live captures measured the display ahead of
     * the reader 3.8% of the time at zero lead, 6.5% at the old default and
     * 9.6% at the old maximum.
     *
     * `alignmentDisplayAt` is built to trail — four separate mechanisms in the
     * engine enforce it (see docs/alignment-engine/INTEGRATION.md §3) — and
     * asking it about the future defeats every one of them at once. Comfort is
     * the reading band's job: `readingBandCenterPercent` decides how much text
     * sits below the line, which buys the same thing without claiming the
     * reader has said words they have not.
     */
    const displayToken = alignmentDisplayAt(snapshot, audioNow);
    /*
     * The feed-forward is the DISPLAY PATH's own speed, not the engine's rate
     * estimate — see `alignmentDisplayRateAt`. Both are per token, and so is
     * the path derivative below, because the projection into token space
     * happened in Rust, so no axis conversion is needed here.
     *
     * It is zero whenever the path is not advancing — a holding state, a
     * saturated lead, a paragraph ceiling, a settle onto a pause — which is
     * what keeps the §70.5 overshoot guard meaningful: that guard measures the
     * plant's speed relative to this number, so a feed-forward the target
     * cannot justify is a guard that cannot fire.
     */
    const velocity = alignmentDisplayRateAt(snapshot, audioNow);
    // The snapshot crossed a process boundary; arithmetic over it must not be
    // allowed to reach the planner, let alone the plant.
    if (!Number.isFinite(displayToken) || !Number.isFinite(velocity)) return null;

    const target = planner.target(displayToken, velocity);
    if (target.source === 'none') return null;
    if (!Number.isFinite(target.scrollPx) || !Number.isFinite(target.feedForwardVelocityPxS)) {
      return null;
    }
    return { target, snapshot, displayToken };
  }

  /**
   * What a rewind to this snapshot's position would cost on the glass (§30.5).
   *
   * Measured from where the display IS — the same `q` the reverse-travel budget
   * is spent from — rather than from the reported token, because that is the
   * distance the plant has to walk and the distance the presenter watches.
   *
   * Null whenever the geometry cannot answer: no map, no planner, a destination
   * that does not resolve. `relocationDirectiveFor` then falls back to counting
   * tokens, which is what this stage did before it could measure anything.
   */
  function rewindReachFor(snapshot: AlignmentSnapshot, nowMs: number): RewindReach | null {
    // Only a retake can become a rewind, and the shape table is where that is
    // decided — asked here rather than restated, so the two cannot drift.
    const shape = RELOCATION_SHAPE[snapshot.decision as keyof typeof RELOCATION_SHAPE];
    if (shape?.type !== 'rewind') return null;
    if (!planner || !Number.isFinite(snapshot.observedToken)) return null;
    /*
     * The target ORDINARY FOLLOWING will aim at, not `destinationScrollPx`.
     *
     * They are different places, and the difference is the point: a re-anchor
     * lands on a line start, because a step that leaves the presenter mid-line
     * is a step to the wrong place. A rewind never uses that — it simply
     * follows the path, and the path answers for the unit itself. Classifying
     * against the line start would charge a rewind for up to a whole pitch of
     * travel it is not going to make.
     */
    const destination = planner.target(snapshot.observedToken, 0);
    if (destination.source === 'none' || !Number.isFinite(destination.scrollPx)) return null;
    return {
      travelPx: controller.state.q - destination.scrollPx,
      // Zero unless the presenter is actually holding the script right now.
      graceRemainingMs: Math.max(0, manualUntilMs - nowMs),
      // The bound exactly as the frame loop will resolve it — the profile this
      // panel may run, in lines where a pitch has been measured — LESS what the
      // plant has already spent going backward. Resolving it any other way here
      // would let a retake be classified against travel the controller is not
      // going to grant. See `RewindReach`.
      budgetPx:
        resolveLineLimitPx(
          boundedProfile.lineUnits?.reverseTravelMaxLines,
          boundedProfile.motion.reverseTravelMaxPx,
          measuredPitchPx(),
        ) - controller.reverseTravelPx,
    };
  }

  /** Scroll position that places a transition's destination at the reading line. */
  function destinationScrollPx(
    destinationTokenIndex: number,
    destinationUnit: number,
  ): number | null {
    if (!planner || !map) return null;
    const line = Number.isFinite(destinationTokenIndex)
      ? map.lineForToken(destinationTokenIndex)
      : null;
    const mapUnit = line ? line.spokenUnitStart : destinationUnit;
    const destination = planner.target(mapUnit, 0);
    return destination.source === 'none' ? null : destination.scrollPx;
  }

  return {
    receiver,
    controller,
    transitions,
    diagnostics,
    // A getter, not a captured value: `setProfile` must be observable through
    // the same property everything else reads.
    get profile() {
      return profile;
    },
    get map() {
      return map;
    },
    get lastDisplayToken() {
      return lastDisplayToken;
    },
    get targetRegressions() {
      return targetRegressions;
    },
    get latchReanchors() {
      return latchReanchors;
    },
    get deferredPlantOverwrites() {
      return deferredPlantOverwrites;
    },
    get reanchorFades() {
      return reanchorFades;
    },
    get catchUpCapExpiries() {
      return catchUpCapExpiries;
    },
    get awaitingManualEvidence() {
      return manualAwaitingEvidence;
    },

    configureSession(sessionGeneration) {
      receiver.setSession(sessionGeneration);
      receiver.reset();
      transitions.reset();
      fallback = null;
      lastDisplayToken = null;
      previousDisplayToken = null;
      forwardTargetLatchPx = null;
      latchExcessSinceMs = null;
      heldVisualSpan = null;
      targetRegressions = 0;
      latchReanchors = 0;
      deferredPlantOverwrites = 0;
      catchUpSinceMs = null;
      catchUpCapCounted = false;
      catchUpCapExpiries = 0;
      /*
       * §30.6. Manual authority does not survive a session either, and this is
       * the one place it could have.
       *
       * The stage window outlives a take — that is the whole reason this
       * function exists — so a take that ENDED with the presenter's hand on the
       * script would have carried the hold into the next one: take two would
       * open holding, and the §62 degraded fallback would be suppressed with
       * it, until somebody said something. The hold is a fact about a gesture
       * in a session that is over.
       */
      manualAwaitingEvidence = false;
      manualAnchorUnit = null;
      manualAuthorityAtMs = Number.NEGATIVE_INFINITY;
      manualUntilMs = Number.NEGATIVE_INFINITY;
      reacquireOwed = false;
      reacquireElapsedMs = 0;
      reacquireBudgetPx = null;
      // A new session cannot inherit a half-finished fade from the old one.
      resetFade();
      reanchorFades = 0;
    },

    setProfile(next) {
      // Identity check first: the mount site re-asserts the profile whenever
      // anything about the envelope changes, and rebuilding the planner on
      // every one of those would throw away the line-handoff state for nothing.
      if (next === profile) return;
      profile = next;
      // The planner's feed-forward ceiling was built FROM the profile.
      // Everything else — the motion limits — reads `profile` per frame.
      rebuildPlanner();
    },

    setLineMap(next) {
      map = next;
      rebuildPlanner();
    },

    setBounds(minPx, maxPx) {
      controller.setBounds(minPx, maxPx);
    },

    setReducedMotion(reduced) {
      reducedMotion = reduced;
    },

    /**
     * §48. Automatic movement is off — the session's pause, or the presenter
     * switching voice following off at the dock.
     *
     * Both are the same instruction to this layer ("nothing automatic moves the
     * document"), and both differ from a HOLD, which is the engine declining to
     * guess on weak evidence and will resolve itself the moment the evidence
     * improves. Reported as `paused` so the glass can say which of the two is
     * keeping the script still.
     *
     * Resuming arms the manual-evidence hold rather than releasing straight
     * into following, and that is the whole reason this is not a one-line
     * setter. The presenter has spent the paused stretch scrolling the script
     * wherever they liked, so the tracker's cursor and the document are in
     * different places by construction; releasing into ordinary following would
     * spend that difference at the profile's forward ceiling the instant the
     * switch flipped. Waiting for them to speak, and then re-grabbing at
     * reading speed, is the same treatment a wheel gesture gets — and for
     * exactly the same reason.
     *
     * WHAT "STOPS" MEANS HERE: no new automatic motion, and the motion already
     * under way is BRAKED rather than cut. Zeroing the velocity limits leaves
     * the plant to decelerate under its own jerk bound (§29.2), so switching
     * following off mid-glide costs a few pixels of run-off — more if it is
     * switched off mid-catch-up — instead of a dead stop the presenter would
     * read as the script snapping. That is the deliberate reading: this surface
     * spends a great deal of effort never moving abruptly, and the moment
     * somebody takes manual control is a poor place to make an exception.
     *
     * `nowMs` stamps the takeover for `supersededTransition`. It defaults to
     * leaving that stamp alone, so a caller with no clock to offer cannot
     * accidentally revoke directives by passing nothing.
     */
    setPaused(next, nowMs = manualAuthorityAtMs) {
      if (next === paused) return;
      paused = next;
      if (next) {
        reacquireOwed = false;
        reacquireElapsedMs = 0;
        reacquireBudgetPx = null;
        // Switching following off is the presenter taking the script, so it
        // supersedes an ordinary directive the same way a wheel gesture does.
        if (Number.isFinite(nowMs)) manualAuthorityAtMs = nowMs;
      } else {
        manualAwaitingEvidence = true;
      }
    },

    releaseAlignment() {
      receiver.reset();
      // An in-flight re-anchor or catch-up is a decision the tracker made about
      // where the presenter is. Once the operator has taken the wheel that is
      // no longer a question anybody is asking, and spending the directive
      // afterwards would move the document somewhere they did not put it.
      transitions.reset();
      lastDisplayToken = null;
      previousDisplayToken = null;
      forwardTargetLatchPx = null;
      latchExcessSinceMs = null;
      heldVisualSpan = null;
      catchUpSinceMs = null;
      catchUpCapCounted = false;
      // `fallback` is deliberately NOT cleared: the caller releasing the lock is
      // the one about to drive, and dropping its target here would cost a frame
      // of hold at exactly the moment it takes over.
    },

    receiveSnapshot(snapshot, nowMs) {
      const outcome = receiver.accept(snapshot, nowMs);
      if (!outcome.accepted) return false;
      const accepted = receiver.current;
      if (!accepted) return false;

      // The engine reports an accepted discontinuity as an ordinary snapshot
      // whose position moved a long way. It cannot issue a motion directive —
      // it has no notion of a pixel — so the classification happens here, and
      // only here, on the way in.
      /*
       * Measured from where the display actually IS, not from the previous
       * reported position.
       *
       * The presenter experiences the size of the jump on the glass, and
       * prediction has usually carried the display some way past the last
       * reported token by the time the next snapshot lands. Measuring from the
       * stale report understates a backward move and overstates a forward one —
       * a retake of ten visible words gets gated away as five, and a one-word
       * forward correction gets animated as six.
       *
       * Before the first frame there is no display position; the snapshot's own
       * position is then the only honest `from`, and a discontinuity the engine
       * accepted is still worth flying rather than dropping — so a manual move
       * (which has no distance gate) survives, and an ordinary one waits for the
       * next snapshot, by which time there is a display to measure against.
       */
      const from = lastDisplayToken ?? previousDisplayToken;
      const directive = relocationDirectiveFor(
        accepted,
        from,
        nowMs,
        boundedProfile,
        manualGraceMs,
        rewindReachFor(accepted, nowMs),
      );
      if (directive) transitions.submit(directive, nowMs);
      previousDisplayToken = accepted.observedToken;

      /*
       * §30.6. The presenter has spoken since moving the script by hand, so the
       * hold is over and the correction it was holding back is now due.
       *
       * It is spent as a re-acquisition rather than as ordinary following. The
       * gap in front of it was not made by the presenter reading — it was made
       * by the presenter's own hand — so closing it at the profile's forward
       * ceiling is a full-speed flight back to somewhere they deliberately
       * left. `REACQUIRE_LINES_PER_SECOND` is the same distance travelled at a
       * pace an eye can stay with.
       *
       * A relocation the tracker classified itself keeps its own directive: the
       * conditional in the frame loop stands down for `catch_up`, because the
       * engine saying "they have moved on in the script" outranks the stage
       * saying "somebody touched the wheel".
       */
      if (manualAwaitingEvidence && MANUAL_HOLD_RELEASE_DECISIONS.has(accepted.decision)) {
        manualAwaitingEvidence = false;
        manualAnchorUnit = null;
        reacquireOwed = true;
        reacquireElapsedMs = 0;
        reacquireBudgetPx = null;
      }
      return true;
    },

    setFallbackTarget(target) {
      fallback = target;
    },

    frame(nowMs): StageMotionFrameResult {
      const frameStartMs = nowMs;
      // §63: the motion work itself must stay comfortably under 1 ms/frame.
      const costStart = typeof performance === 'undefined' ? nowMs : performance.now();
      const dtMs = lastFrameAtMs === null ? 0 : nowMs - lastFrameAtMs;
      lastFrameAtMs = nowMs;

      // Directives are stamped on the stage's own wall clock (they are minted
      // here, in `receiveSnapshot`), so expiry is a plain comparison with no
      // clock domain to cross.
      transitions.update(nowMs);

      // §26.3: the only authorized overwrite of plant state during following.
      const overwrite = transitions.consumePlantOverwrite();
      let deferredOverwrite = false;
      /**
       * §20.4. A re-anchor is waiting behind an in-flight fade-down. The plant
       * is frozen while this is true — the document must not creep under a
       * half-transparent layer, or the transition becomes the moving ghost the
       * fade exists to prevent.
       */
      let fadeHold = false;
      /** True on the one frame that spends a re-anchor while obscured. */
      let reanchorApplied = false;
      if (overwrite && paused) {
        /*
         * §48. Following is off, and a re-anchor is automatic motion.
         *
         * This licence is the ONE authorized overwrite of plant state during
         * following (§26.3), and it is consumed at the top of the frame before
         * anything has looked at whether motion is wanted — so with following
         * switched off, an ordinary relocation still faded the glass and moved
         * the document to wherever the aligner had gone. The presenter had
         * turned that off; a teleport is not a smaller version of it.
         *
         * Parked rather than dropped, the same way §20.4 parks one behind a
         * fade: parking keeps it revocable, so it dies with its own TTL if
         * following stays off, and is there to be spent if it is still live
         * when following comes back.
         */
        transitions.deferPlantOverwrite(overwrite);
      } else if (overwrite) {
        const destination = destinationScrollPx(overwrite.destinationTokenIndex, overwrite.toUnit);
        if (destination !== null && fadeAdmitsReanchor(nowMs, destination)) {
          reanchorTo(destination);
          reanchorApplied = true;
          // A re-anchor *is* the discontinuity: once applied it is finished, so
          // its backward-capable profile cannot linger and let ordinary
          // following reverse afterwards.
          transitions.complete(overwrite.id);
          // The glass is dark and the document has moved: bring it back.
          if (fadePhase === 'down') beginFade('up', nowMs);
        } else if (destination !== null) {
          /* §20.4: the destination is known, but the document is still visible.
           *
           * Park the licence rather than spend it. Parking is the ONLY safe way
           * to wait: it keeps the directive revocable, so an expiry, a
           * supersession by a newer directive, or a session reset during the
           * ~110 ms fade takes the pending write with it instead of landing a
           * stale destination on the far side of the fade.
           */
          transitions.deferPlantOverwrite(overwrite);
          if (fadePhase !== 'down') {
            beginFade('down', nowMs);
            reanchorFades++;
          }
          fadeHold = true;
        } else {
          /* §62: there is no line map, so there is no destination — yet.
           *
           * This used to complete the directive regardless, which threw the
           * discontinuity away. Directives are idempotent by `id`, so the
           * worker's re-sent copies on every later frame are all
           * `duplicate`-ignored: nothing retries, ever. A distant BACKWARD
           * retake arriving during a rebuild window is then unrecoverable by
           * ordinary motion — the §30.5 reverse-travel budget hard-caps the
           * rewind at 420 px, so the plant parks above the retake point and
           * stays there. Forward destinations "recover" by rolling at full
           * speed for a couple of seconds, which is the exact spectacle §53
           * re-anchors exist to prevent.
           *
           * Park the licence instead. It stays valid while its directive is
           * active, so it is spent on the first frame after the map resolves,
           * and it dies with the directive's own expiry if the map never does.
           */
          transitions.deferPlantOverwrite(overwrite);
          deferredPlantOverwrites++;
          deferredOverwrite = true;
        }
      }

      const aligned = alignmentTarget(nowMs);
      /*
       * The interval, then the condition it is the floor of: manual authority
       * lasts at least `manualGraceMs` and then until the presenter says
       * something (§30.6, `manualAwaitingEvidence`).
       *
       * `paused` joins them because it is the same instruction with no end date
       * — following is off, so nothing automatic may move the document — and
       * because the multiplier table's `paused` state only shapes how the plant
       * SETTLES onto a target that is still advancing underneath it. A state
       * that damps hard is not a state that stops.
       */
      const manualGrace = nowMs < manualUntilMs || manualAwaitingEvidence || paused;
      // §62: an invalid map means the stage does not know where anything is.
      // The alignment planner is already disabled — the *guessed* fallback has
      // to go with it, because its off-window branch estimates positions from
      // block offsets and estimated heights, which is exactly the "moving on
      // guessed geometry" the hold exists to prevent.
      const mapUnresolved = map === null || !map.valid;
      const fallbackUsable = fallback !== null && !mapUnresolved;

      let source: MotionSource = 'hold';
      let targetPx = lastTarget;
      let feedForward = 0;
      let state: StageMotionState | null = null;
      let lineId: string | null = lastLineId;
      let lineProgress = 0;
      let activeTokenIndex: number | null = null;
      let visualSpanHold = false;
      let suggestionToken: number | null = null;

      if (aligned) {
        source = 'alignment';
        targetPx = aligned.target.scrollPx;
        feedForward = aligned.target.feedForwardVelocityPxS;
        state = aligned.snapshot.state;
        suggestionToken = aligned.snapshot.suggestionToken;
        lineId = aligned.target.lineId;
        lineProgress = aligned.target.lineProgress;
        lastDisplayToken = aligned.displayToken;
        activeTokenIndex = activeTokenFor(aligned.displayToken, lineId);

        // §8.6: an interval whose SECANT exceeds the visual-block limit cannot
        // be followed — the path would race the whole image height inside one
        // spoken token. Hold at the entry while the presenter is inside it, and
        // cross it as one authorized re-anchor on the way out.
        const span = map?.visualBlockSpanAt(aligned.displayToken) ?? null;
        if (span) {
          targetPx = span.scrollStartPx;
          feedForward = 0;
          visualSpanHold = true;
          heldVisualSpan = span;
        } else if (heldVisualSpan !== null) {
          const exitedForward = aligned.displayToken >= heldVisualSpan.unitEnd;
          heldVisualSpan = null;
          // Leaving forward means the presenter is past the media: the
          // re-anchor IS the discontinuity (§53), and it is bounded because the
          // destination is the far knot of a measured interval. Leaving
          // backward needs no discontinuity — the plant is already there.
          if (exitedForward) reanchorTo(targetPx);
        }
      } else if (fallbackUsable && fallback) {
        source = 'fallback';
        targetPx = fallback.scrollPx;
        // Zero unless the caller knows better — see `FallbackTarget`.
        feedForward =
          typeof fallback.feedForwardVelocityPxS === 'number' &&
          Number.isFinite(fallback.feedForwardVelocityPxS)
            ? fallback.feedForwardVelocityPxS
            : 0;
        state = 'following';
        if (fallback.disposition === 'instant') {
          // §32.4 reduced motion: reposition with no spectacle at all.
          reanchorTo(fallback.scrollPx);
          fallback = { ...fallback, disposition: 'follow' };
          reanchorApplied = true;
        } else if (fallback.disposition === 'reanchor') {
          // The degraded path's `fade_jump` (§20.4) — an explicit jump beyond
          // the comfortable traversal distance. Same rule as a directive: move
          // only once the fade-down has finished.
          if (fadeAdmitsReanchor(nowMs, fallback.scrollPx)) {
            reanchorTo(fallback.scrollPx);
            fallback = { ...fallback, disposition: 'follow' };
            reanchorApplied = true;
            if (fadePhase === 'down') beginFade('up', nowMs);
          } else {
            if (fadePhase !== 'down') {
              beginFade('down', nowMs);
              reanchorFades++;
            }
            fadeHold = true;
          }
        }
      }

      /*
       * §20.4 exit guarantee. `fadeHold` is true only while a write is actually
       * pending behind the fade; if it is not, whatever the fade was hiding is
       * gone — expired, superseded, revoked, or made unresolvable by a relayout
       * — and the fade must unwind immediately. There is no path out of `down`
       * that does not go through here or through the apply above, because a
       * fade that stalls leaves the presenter reading a dimmed script with no
       * way to recover it.
       */
      abortFadeIfOrphaned(nowMs, fadeHold);
      const documentOpacity = opacityAt(nowMs);

      if (paused) state = 'paused';

      const activeTransition = transitions.active;

      // No map, no accepted frame, no fallback: hold. Never move on guessed
      // geometry (§62).
      const holding = source === 'hold';
      /*
       * §20.3 step 4 + §20.4. Behind the fade the plant aims at where it
       * already is, so the controller decelerates to rest under its own jerk
       * limits instead of creeping toward the destination under a
       * half-transparent layer. That is both the spec's "decelerate briefly"
       * and the reason the re-anchor stays a single invisible step: nothing
       * visible moves between the fade starting and the transform changing.
       */
      const frozen = holding || fadeHold;

      /* ------------------------------------------------------------ §30.3 --
       * The catch-up licence.
       *
       * Catch-up is boosted motion, and §30.3 bounds it three ways: a duration
       * cap, a boost that decays as the gap closes, and a position the spoken
       * line may not be carried above. All three are scoped to exactly the
       * frames on which the boost is in force — the tracker's own
       * `catching_up`, or a `catch_up` directive — because that is what the
       * spec bounds and because a ceiling left standing in ordinary following
       * would fight the very corrections it is meant to protect.
       *
       * A `catch_up` DIRECTIVE already carries `expiresAtMs`, and
       * `transitions.update()` retires it: that is a real duration bound and
       * this does not duplicate it. What has no bound at all is the state — the
       * worker can report `catching_up` for as long as it likes, and the
       * profile multiplier simply stays applied. The clock below runs over the
       * licence however it arrived, so a directive is bounded by whichever of
       * its TTL and the cap comes first, and the state is bounded at all.
       */
      /*
       * A directive the presenter's own hand has overtaken.
       *
       * An ordinary directive describes where the ALIGNER thinks the document
       * should go, decided before the presenter grabbed the wheel or switched
       * following off. Afterwards it is describing a document that no longer
       * exists — and a `catch_up` is the dangerous one, because its whole
       * purpose is boosted travel: it outlives the 2.5 s grace comfortably (its
       * TTL is built to cover exactly that), and on the first frame after the
       * grace it took the correction back at `catchUpMultiplier` speed, around
       * the four-lines-a-second re-grab entirely. The presenter scrolled, spoke,
       * and watched the script fly anyway.
       *
       * Scoped to `ordinary` authority on purpose. A `command` or `manual`
       * directive IS somebody's decision — an outline jump, a re-find, a
       * retake — and those outrank a wheel gesture rather than being
       * superseded by it.
       */
      const supersededTransition =
        activeTransition !== null &&
        activeTransition.directive.authority === 'ordinary' &&
        activeTransition.directive.issuedAtMs <= manualAuthorityAtMs;

      const catchUpLicensed =
        !frozen &&
        !manualGrace &&
        !supersededTransition &&
        // The engine has no `catching_up` state to report — a forward skip
        // arrives as an accepted discontinuity, which `receiveSnapshot` turns
        // into exactly one bounded `catch_up` directive. So the directive is
        // now the whole licence, and it carries its own TTL alongside the
        // §30.3 duration cap below.
        activeTransition?.directive.type === 'catch_up';
      if (catchUpLicensed) catchUpSinceMs ??= nowMs;
      else {
        catchUpSinceMs = null;
        catchUpCapCounted = false;
      }
      const catchUpElapsedMs = catchUpSinceMs === null ? 0 : nowMs - catchUpSinceMs;

      const limitOptions = {
        reducedMotion,
        degraded: diagnostics.degraded,
        transition: activeTransition?.directive.type,
        manualGrace,
        /*
         * §30. The three POSITION bounds are resolved against the pitch this
         * layout actually measured, so what the presenter is promised — five
         * lines of reverse travel, a re-anchor threshold reachable before that
         * budget is spent — is the same promise on a 9-inch panel at 1.8 m and
         * a 15.6-inch one at arm's length.
         *
         * `limitsForState` has taken a `linePitchPx` since the line-unit block
         * shipped and no production caller ever passed one, so every rig went on
         * running the pixel numbers tuned for a 64 px body at a 1.32 line
         * height. The pitch comes from the map rather than from a setter
         * precisely so it cannot describe a geometry that has since been
         * rebuilt.
         */
        linePitchPx: measuredPitchPx(),
      };
      /**
       * The state/transition shape of the limits, with no §30.3 bounds applied.
       * The latch below needs `allowBackward` and `reanchorThresholdPx` to
       * decide the target, and the §30.3 bounds are measured against that
       * decided target — so the bounded limits cannot be built until it exists.
       * Neither field is touched by the bounds, so this is the same answer.
       */
      const structuralLimits: MotionLimits = limitsForState(
        state ?? 'holding',
        boundedProfile,
        limitOptions,
      );

      // §70.5 forward latch. Applied only to ordinary (forward-only) following;
      // a backward-capable profile is an explicit classification of the
      // regression and releases the latch.
      let regressed = false;
      let latchReanchored = false;
      // §20.4: while the fade-down runs the plant is going to be repositioned
      // anyway, so latching to a target it is about to abandon only leaves
      // stale bookkeeping for the frame after the re-anchor. `reanchorTo`
      // clears the latch on the way through.
      if (!holding && !visualSpanHold && !fadeHold) {
        if (structuralLimits.allowBackward || manualGrace) {
          // A backward-capable profile is an explicit classification of the
          // regression; manual authority suspends automatic correction outright
          // (§30.6), and re-latching to the pre-interaction target during the
          // grace would fight the presenter's own reposition afterwards.
          forwardTargetLatchPx = null;
          latchExcessSinceMs = null;
        } else if (forwardTargetLatchPx !== null && targetPx < forwardTargetLatchPx) {
          /* §30 `reanchorThresholdPx` — the latch's escape hatch.
           *
           * The latch is right about small regressions: reverse is forbidden
           * here, so following one would only park the plant past a target it
           * can never reach. It was WRONG about large ones. A latch with no
           * upper bound turns any single bad frame that raced the plant forward
           * into a permanent error — the corrective targets that follow are all
           * "backward", all suppressed, and forward-only means nothing on the
           * stage can ever bring it back. `reanchorThresholdPx` existed for
           * exactly this and was read nowhere.
           *
           * Past that distance the honest reading is not "the tracker glitched"
           * but "we are somewhere the presenter is not", and §53's answer to
           * that is an authorized, bounded discontinuity rather than a
           * permanent error or a full-speed roll. Persistence keeps a momentary
           * backward blip from teleporting anyone: the disagreement has to hold
           * for `LATCH_REANCHOR_PERSISTENCE_MS` first.
           */
          const excessPx = forwardTargetLatchPx - targetPx;
          if (excessPx > Math.max(0, structuralLimits.reanchorThresholdPx)) {
            latchExcessSinceMs ??= nowMs;
            if (nowMs - latchExcessSinceMs >= LATCH_REANCHOR_PERSISTENCE_MS) {
              reanchorTo(targetPx);
              latchExcessSinceMs = null;
              latchReanchors++;
              latchReanchored = true;
            }
          } else {
            latchExcessSinceMs = null;
          }
          if (!latchReanchored) {
            targetPx = forwardTargetLatchPx;
            regressed = true;
            targetRegressions++;
          }
        } else {
          forwardTargetLatchPx = targetPx;
          latchExcessSinceMs = null;
        }
      }

      /* ------------------------------------------------------------ §30.6 --
       * The re-grab, measured against the target the latch has finished with.
       *
       * Three ways it ends, and all three are here rather than at the point it
       * is granted, because a licence that can only be revoked by the thing
       * that issued it is a licence that outlives its reason. It ends when the
       * gap is closed (there is nothing left to re-acquire), when the plant is
       * not moving under it anyway (a hold, a fade, a visual-block freeze —
       * spending the cap while frozen would retire the licence before it could
       * be used), and at the cap.
       */
      let reacquiring = false;
      let reacquireGapPx = 0;
      if (reacquireOwed) {
        /*
         * Eligibility first, and nothing is measured or spent without it.
         *
         * A frame the re-grab cannot move on is a frame it must not be charged
         * for, and — the subtler half — a frame it must not be judged ARRIVED
         * on either. While the plant holds, `targetPx` falls back to
         * `lastTarget`, which is the last thing the feed asked for, possibly
         * under a layout that no longer exists. That stale number sitting
         * within a pixel and a half of where the document happens to be parked
         * would retire the licence for a journey nobody had taken.
         *
         * A relocation the tracker classified itself is a better description of
         * events than "somebody touched the wheel", and arrives with bounds of
         * its own (§30.3) — so it wins, unless it predates the presenter's own
         * hand, in which case it is describing a document that no longer exists.
         */
        const transitionOwnsIt = activeTransition !== null && !supersededTransition;
        const eligible =
          !frozen && !visualSpanHold && !manualGrace && !catchUpLicensed && !transitionOwnsIt;
        if (eligible) {
          reacquireGapPx = Math.abs(targetPx - controller.state.q);
          /*
           * The licence, sized once, from where the plant actually is.
           *
           * `controller.reverseTravelPx` is included because the cap it becomes
           * is compared against that same cumulative counter — a licence that
           * ignored what had already been spent would be short by exactly that
           * much. It is normally zero here (`manualOverride` re-anchors, and
           * `reanchor` zeroes the counter), and is not zero when a re-grab
           * follows following being switched back on.
           */
          reacquireBudgetPx ??=
            controller.reverseTravelPx + reacquireGapPx + REACQUIRE_REVERSE_SLACK_PX;
          reacquireElapsedMs += dtMs;
          const arrived = reacquireGapPx <= Math.max(1, structuralLimits.restDeadbandPx);
          if (arrived || reacquireElapsedMs >= REACQUIRE_MAX_MS) {
            reacquireOwed = false;
            reacquireBudgetPx = null;
          } else {
            reacquiring = true;
          }
        }
      }

      /* ------------------------------------------------------------ §30.3 --
       * The three bounds, now that the target they are measured against exists.
       *
       *   1. DURATION CAP. `catchUpMaxDurationMs` from the frame the licence
       *      appeared, ramped out over its final `catchUpReleaseMs` rather than
       *      dropped: a limit that steps underneath a jerk-limited plant is the
       *      exact shape that once put a −175,500 px/s² sub-step into the
       *      position trace when a `catch_up` directive hit its TTL.
       *
       *      The EXIT when the cap runs out with the gap still open is ordinary
       *      following, not a re-anchor. Two reasons. The gap is forward, and
       *      forward gaps still close under ordinary limits — 900 px/s is most
       *      of a screen a second, so nothing is stuck; what ends is the
       *      spectacle, which is the part §30.3 is bounding. And the stage
       *      already has exactly one path from "we are somewhere the presenter
       *      is not" to an authorized discontinuity — the §70.5 latch's
       *      `reanchorThresholdPx` escape hatch, with its own persistence
       *      window — so a timer that minted its own re-anchor would be a
       *      second mechanism for one idea, which is how two of them diverge.
       *
       *   2. CORRIDOR-RELATIVE BOOST DECAY. The gap is what closes, so the gap
       *      is what the decay is measured on: full boost while the spoken line
       *      is more than `catchUpDecayCorridors` corridor half-heights below
       *      the corridor's entry edge, falling to none by the time it reaches
       *      that edge. The boost is therefore spent bringing the line back to
       *      the corridor, and ordinary following carries it the last stretch
       *      to `R` — so a small catch-up finishes gently and a large one still
       *      moves, which a time-relative decay cannot do in both directions.
       *
       *   3. UPPER SAFETY BOUNDARY. See `catchUpCeilingPx` below. It is handed
       *      to the plant as a position, not a speed, because the failure it
       *      exists for has no speed: a plant sitting ahead of a target that is
       *      moving at the same pace has zero relative velocity, and the
       *      overshoot guard — which is deliberately measured relative to the
       *      target's feed-forward velocity — cannot see it. That is the shape
       *      that once left the document 908 px ahead permanently.
       */
      const corridorHalfPx = map?.readingBandHalfHeightPx ?? 0;
      let catchUpBoost = 1;
      let catchUpCeilingPx = Number.POSITIVE_INFINITY;
      let catchUpCapped = false;
      if (catchUpLicensed) {
        const capMs = Math.max(0, profile.motion.catchUpMaxDurationMs);
        const releaseMs = Math.min(Math.max(0, profile.motion.catchUpReleaseMs), capMs);
        const remainingMs = capMs - catchUpElapsedMs;
        catchUpCapped = remainingMs <= 0;
        const timeFactor =
          releaseMs <= 0
            ? (catchUpCapped ? 0 : 1)
            : Math.max(0, Math.min(1, remainingMs / releaseMs));

        let corridorFactor = 1;
        if (corridorHalfPx > 0) {
          /* The corridor's entry edge, in gap terms.
           *
           * The target places the spoken line's baseline at `R`, and the plant
           * is `gapPx` short of the target, so the line is sitting `gapPx`
           * BELOW `R` — it enters the corridor when `gapPx` falls to the
           * corridor half-height, and the boost is gone by then.
           */
          const gapPx = targetPx - controller.state.q;
          const decayPx = Math.max(0, profile.motion.catchUpDecayCorridors) * corridorHalfPx;
          corridorFactor =
            decayPx <= 0
              ? (gapPx > corridorHalfPx ? 1 : 0)
              : Math.max(0, Math.min(1, (gapPx - corridorHalfPx) / decayPx));
        }
        /* §30.3, §8.8/§16.3: the line may not be carried above the corridor's
         * UPPER edge. Scrolling forward by one pixel past the target lifts the
         * line one pixel above `R`, so the corridor half-height is precisely
         * how far past the target the plant may be carried — when the map knows
         * one. It is measured from this layout rather than converted through a
         * pitch, so it wins wherever it exists.
         *
         * `catchUpCeilingLines` is the same boundary in a unit that survives a
         * map built without a corridor — a degraded builder, a stage whose band
         * has not resolved yet. It was read nowhere, so the ONE bound that
         * catches a plant parked ahead of a target moving at the same speed
         * (zero relative velocity, invisible to the overshoot guard, the shape
         * that once left the document 908 px ahead permanently) simply
         * disappeared on exactly the frames it is needed most.
         */
        const ceilingMarginPx =
          corridorHalfPx > 0
            ? corridorHalfPx
            : lineBoundPx(
                profile.lineUnits?.catchUpCeilingLines,
                MAX_CATCH_UP_CEILING_VIEWPORT_FRACTION,
              );
        if (ceilingMarginPx > 0) catchUpCeilingPx = targetPx + ceilingMarginPx;
        catchUpBoost = Math.min(timeFactor, corridorFactor);
        if (catchUpCapped && !catchUpCapCounted) {
          catchUpCapCounted = true;
          catchUpCapExpiries++;
        }
      }

      const limits: MotionLimits = catchUpLicensed
        ? limitsForState(state ?? 'holding', boundedProfile, {
            ...limitOptions,
            catchUpBoost,
            forwardPositionCeilingPx: catchUpCeilingPx,
          })
        : reacquiring
          ? limitsForState(state ?? 'holding', boundedProfile, {
              ...limitOptions,
              reacquire: true,
              ...(reacquireBudgetPx === null
                ? {}
                : { reacquireReverseBudgetPx: reacquireBudgetPx }),
            })
          : structuralLimits;

      /*
       * Never feed forward faster than the target is ACTUALLY moving.
       *
       * `feedForward` is the display path's own derivative, which is right
       * about how the path would move if this snapshot were the last word. It
       * is not always right about how the target moves, because a new snapshot
       * can re-pin `observedToken` to the same place frame after frame — a
       * tracker repeating "you are here, at three tokens a second" while the
       * reader does not advance. The path says three tokens a second; the
       * target has not moved at all.
       *
       * That gap is a safety hole, not an inefficiency. The §70.5 overshoot
       * guard measures the plant's speed RELATIVE to the feed-forward — match
       * the target's speed and you are not overshooting — so a feed-forward the
       * target cannot justify disables the guard by exactly that much, and the
       * plant sails past a stationary target with nothing to arrest it.
       *
       * Taking the smaller of the two closes it: they agree while following
       * normally, and where they disagree the one that reflects what the
       * document is really doing wins. `min` rather than the realized value
       * alone because a snapshot boundary steps the target, and one frame of
       * that step is not a velocity.
       */
      const realizedTargetPxS = dtMs > 0 ? ((targetPx - lastTarget) * 1000) / dtMs : 0;
      const boundedFeedForward = Math.max(0, Math.min(feedForward, realizedTargetPxS));

      const step = controller.step({
        dtMs,
        targetPx: frozen ? controller.state.q : targetPx,
        feedForwardVelocityPxS: frozen ? 0 : boundedFeedForward,
        limits,
        allowRest: true,
      });

      if (!holding) lastTarget = targetPx;
      lastLineId = lineId;

      const controllerState = [
        source,
        state ?? 'idle',
        activeTransition ? activeTransition.directive.type : null,
        diagnostics.degraded ? 'degraded' : null,
        manualGrace ? 'manual' : null,
        reacquiring ? 'reacquire' : null,
        mapUnresolved ? 'map_unresolved' : null,
        visualSpanHold ? 'visual_block' : null,
        regressed ? 'target_regression' : null,
        latchReanchored ? 'latch_reanchor' : null,
        deferredOverwrite ? 'transition_deferred' : null,
        fadeHold ? 'reanchor_fade' : null,
        catchUpCapped ? 'catch_up_capped' : null,
        step.fused ? 'fused' : null,
      ]
        .filter(Boolean)
        .join(':');

      const hitchThresholdMs = frameInterval.observe(dtMs);
      const hitch = step.hitch || dtMs > hitchThresholdMs;
      diagnostics.sample({
        nowMs,
        dtMs,
        hitch,
        targetPx: frozen ? controller.state.q : targetPx,
        positionPx: step.q,
        velocityPxS: step.v,
        accelerationPxS2: step.a,
        jerkPxS3: step.jerkPxS3,
        lineId,
        controllerState,
        saturated: step.saturated,
        fused: step.fused,
        frameCostMs:
          typeof performance === 'undefined' ? undefined : performance.now() - costStart,
      });

      const styleInterval = diagnostics.degraded
        ? DEGRADED_STYLE_INTERVAL_MS
        : styleIntervalMs;
      /*
       * §20.4 + §22.4. The frame that re-anchors forces a styling refresh even
       * off the capped cadence. Active/passed styling is epoch state, and after
       * a re-anchor the old take's passed run is wrong by up to 100 ms of
       * cadence — which is most of the fade-up. Refreshing on the obscured
       * frame means the reading band, the past/future ramps and the current
       * phrase are already correct at the instant the text becomes visible
       * again, instead of visibly correcting themselves afterwards.
       */
      const styleTick = reanchorApplied || nowMs - lastStyleAtMs >= styleInterval;
      if (styleTick) lastStyleAtMs = nowMs;

      /*
       * C1: the ack is the ONLY channel that carries the stage's layout
       * generation back to control, and control is the only party that can
       * hand it on to the frame producers. Gating the ack on an accepted frame
       * therefore closed a loop that had to stay open to work: the gate bumps
       * to a generation control has never heard of, every frame is rejected
       * because of it, and no ack goes out to say so — the stage sits in a
       * self-sustaining blackout until the stale-layout tolerance opens at
       * 900 ms. So a frameless ack still reports identity, position, and
       * generation; `revision`/`epoch` of -1 say "no accepted frame yet"
       * rather than borrowing a stale frame's counters.
       */
      const snapshotForAck = receiver.current;
      const ack = diagnostics.shouldEmitAck(nowMs)
        ? diagnostics.buildAck({
            // The ack is a stage→control health report, and the identity that
            // makes it addressable is the alignment session. `revision`/`epoch`
            // of -1 say "no snapshot accepted yet" rather than borrowing a
            // stale one's counters.
            sessionGeneration: receiver.sessionGeneration,
            revision: snapshotForAck ? snapshotForAck.seq : -1,
            epoch: snapshotForAck ? snapshotForAck.sessionGeneration : -1,
            layoutGeneration: map?.generation ?? 0,
            targetPx: frozen ? controller.state.q : targetPx,
            positionPx: step.q,
            velocityPxS: step.v,
            activeLineId: lineId,
            controllerState,
            nowMs: frameStartMs,
          })
        : null;

      return {
        scrollPx: step.q,
        velocityPxS: step.v,
        accelerationPxS2: step.a,
        targetPx: frozen ? controller.state.q : targetPx,
        activeLineId: lineId,
        lineProgress,
        activeTokenIndex,
        source,
        suggestionToken,
        state,
        controllerState,
        styleTick,
        ack,
        degraded: diagnostics.degraded,
        hitch,
        documentOpacity,
      };
    },

    manualOverride(positionPx, nowMs, anchorUnit = null) {
      // §30.6: manual interaction has immediate authority; reacquire without
      // snapping once the presenter starts speaking again.
      reanchorTo(positionPx);
      manualUntilMs = nowMs + manualGraceMs;
      manualAwaitingEvidence = true;
      manualAnchorUnit = Number.isFinite(anchorUnit as number) ? anchorUnit : null;
      // Everything the aligner decided before this instant was decided about a
      // document the presenter has since moved. See `supersededTransition`.
      manualAuthorityAtMs = nowMs;
      // A re-acquisition already in flight is over: it was closing a gap to a
      // position the presenter has just overruled by hand.
      reacquireOwed = false;
      reacquireElapsedMs = 0;
      reacquireBudgetPx = null;
      fallback = null;
      // Direct manipulation is never obscured: the presenter is looking at the
      // text they are dragging. If a directive was mid-fade it re-fades from
      // full opacity on the next frame rather than landing behind a dim layer.
      resetFade();
    },

    layoutRecovery(request) {
      // §33: preserve the *semantic* position, never raw scrollTop.
      const previous = map;
      map = request.map;
      rebuildPlanner();
      /*
       * The presenter's own anchor outranks the aligner's while their hand is
       * on the script (§30.6).
       *
       * `lastDisplayToken` keeps tracking the feed right through a manual hold,
       * so a relayout landing inside one — a font change, a resize, an optics
       * rebuild, all of which happen mid-take — preserved the token the ALIGNER
       * was on and re-anchored the document there. The presenter scrolled to a
       * different page, said nothing, changed the type size, and the script
       * jumped back to where it had been and then froze, still holding.
       */
      const manualHeld = manualAwaitingEvidence || paused;
      const unit =
        request.anchorUnit ?? (manualHeld ? manualAnchorUnit : null) ?? lastDisplayToken;
      if (unit !== null && planner) {
        const destination = planner.target(unit, 0);
        if (destination.source !== 'none') {
          const viewportY = request.anchorViewportY;
          // Keep the semantic position at the same viewport height it occupied
          // before the rebuild, then let the settle profile absorb the rest.
          const anchored =
            viewportY === undefined
              ? destination.scrollPx
              : destination.scrollPx + (request.map.readingLineStartY - viewportY);
          reanchorTo(anchored);
        }
      } else if (previous === null) {
        reanchorTo(controller.state.q);
      }
      forwardTargetLatchPx = null;
    },

    visibilityRestored(positionPx, nowMs) {
      // §32.4: re-anchor to what is on screen; never replay missed motion.
      reanchorTo(positionPx);
      lastFrameAtMs = nowMs;
      // Nor replay a missed fade. The window may have been hidden for minutes;
      // coming back to a document stuck at 30% opacity is the worst outcome of
      // all, and no frames ran to unwind it.
      resetFade();
    },

    reset(positionPx) {
      reanchorTo(positionPx);
      transitions.reset();
      receiver.reset();
      diagnostics.reset();
      fallback = null;
      lastDisplayToken = null;
      previousDisplayToken = null;
      lastFrameAtMs = null;
      lastTarget = positionPx;
      lastLineId = null;
      targetRegressions = 0;
      latchReanchors = 0;
      latchExcessSinceMs = null;
      deferredPlantOverwrites = 0;
      catchUpSinceMs = null;
      catchUpCapCounted = false;
      catchUpCapExpiries = 0;
      manualAwaitingEvidence = false;
      manualAnchorUnit = null;
      manualAuthorityAtMs = Number.NEGATIVE_INFINITY;
      manualUntilMs = Number.NEGATIVE_INFINITY;
      reacquireOwed = false;
      reacquireElapsedMs = 0;
      reacquireBudgetPx = null;
      resetFade();
      reanchorFades = 0;
    },
  };
}
