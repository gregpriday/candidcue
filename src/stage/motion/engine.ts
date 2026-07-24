/**
 * Stage motion engine — the continuously running control system that owns
 * frame-by-frame motion for the life of a stage session (companion §26.2).
 *
 * The pipeline, once per display frame:
 *
 *   accepted SemanticMotionFrame
 *     → §27 prediction (state horizon, evidence-age decay, drift budget)
 *     → §8 line-handoff path sample  → target scroll + dScroll/dUnit
 *     → §28 feed-forward velocity    = dScroll/dUnit × semantic velocity
 *     → §30 motion limits for the state / active transition
 *     → §29 jerk-limited controller, §32 frame-time compensation
 *     → pixels
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
  DEFAULT_SMOOTH_FOLLOW_PROFILE,
  type SemanticMotionFrame,
  type SmoothFollowProfile,
  type StageMotionAck,
  type TrackingStateV2,
} from '../../shared/contracts';
import {
  createFrameIntervalEstimator,
  createJerkLimitedScrollController,
  type JerkLimitedScrollController,
} from './controller';
import {
  createStageMotionDiagnostics,
  type StageMotionDiagnostics,
} from './diagnostics';
import {
  createSemanticFrameReceiver,
  type SemanticFrameGate,
  type SemanticFrameReceiver,
} from './frameReceiver';
import type { StageRenderedLineMap, VisualBlockSpan } from './lineMap';
import { createLineHandoffPlanner, type LineHandoffPlanner, type LineTarget } from './planner';
import { predictSemanticPosition, type SemanticPrediction } from './predictor';
import { limitsForState, type MotionLimits } from './profiles';
import {
  createStageTransitionController,
  type StageTransitionController,
} from './transitions';
import { createCalibratingUnitAxis, type UnitAxisAdapter } from './unitAxis';

/**
 * Degraded input from the v1 `TrackingSnapshot` path: a plain pixel target the
 * renderer computed from block geometry. It drives the same controller, so
 * motion stays continuous and jerk-limited even without semantic frames.
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
}

export type MotionSource = 'semantic' | 'fallback' | 'hold';

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
  state: TrackingStateV2 | null;
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
  /** Semantic frames older than this fall back to snapshot-driven motion. */
  frameStaleMs?: number;
  /** Capped rate for active/passed styling updates (§26.2 step 7). */
  styleIntervalMs?: number;
  /** Ack cadence (§54). */
  ackIntervalMs?: number;
  /** Manual-interaction grace before automatic correction resumes (§30.6). */
  manualGraceMs?: number;
  /**
   * Bridge between the worker's weighted spoken-unit axis and the axis the line
   * map was built on. Defaults to the runtime calibrator; pass
   * `identityUnitAxis()` once the map is built from real speech weights.
   */
  unitAxis?: UnitAxisAdapter;
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
  readonly receiver: SemanticFrameReceiver;
  readonly controller: JerkLimitedScrollController;
  readonly transitions: StageTransitionController;
  readonly diagnostics: StageMotionDiagnostics;
  readonly map: StageRenderedLineMap | null;
  readonly profile: SmoothFollowProfile;
  readonly lastPrediction: SemanticPrediction | null;
  readonly unitAxis: UnitAxisAdapter;
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

  configureSession(gate: SemanticFrameGate, nowMs: number): void;
  /**
   * §47.1/§55. Adopt a resolved motion profile — the user's Follow feel, as
   * control resolved it, arriving in the stage envelope.
   *
   * It is a setter rather than a constructor argument alone because the stage
   * window outlives a session: a second take on the same window republishes an
   * envelope into the SAME engine, and a profile that could only be read at
   * construction would leave the new session running the previous one's feel.
   *
   * Nothing about plant state changes. The profile reshapes limits, the
   * prediction horizon and the speech envelope; position, velocity and
   * acceleration carry straight through, and the jerk limiter absorbs the new
   * bounds over the following frames rather than stepping to them.
   */
  setProfile(next: SmoothFollowProfile): void;
  setLineMap(map: StageRenderedLineMap | null): void;
  setBounds(minPx: number, maxPx: number): void;
  setReducedMotion(reduced: boolean): void;
  setPaused(paused: boolean): void;

  receiveFrame(frame: SemanticMotionFrame, nowMs: number): boolean;
  setFallbackTarget(target: FallbackTarget | null): void;

  frame(nowMs: number): StageMotionFrameResult;

  /** Authorized plant writes. */
  manualOverride(positionPx: number, nowMs: number): void;
  layoutRecovery(request: LayoutRecoveryRequest): void;
  visibilityRestored(positionPx: number, nowMs: number): void;
  reset(positionPx: number): void;
}

/**
 * States whose `(estimatedUnit, tokenIndex)` pair is a real observation of the
 * worker's cumulative weight function rather than a guess the tracker is
 * carrying while it works something out.
 */
const CALIBRATION_STATES: ReadonlySet<TrackingStateV2> = new Set<TrackingStateV2>([
  'following',
  'catching_up',
]);

/** Minimum confidence a frame needs before it may move the unit axis. */
const CALIBRATION_MIN_CONFIDENCE = 0.6;

export function isCalibrationEvidence(frame: SemanticMotionFrame): boolean {
  return (
    CALIBRATION_STATES.has(frame.state) &&
    frame.confidence >= CALIBRATION_MIN_CONFIDENCE &&
    frame.behavior !== 'retake' &&
    frame.behavior !== 'retake_candidate'
  );
}

/**
 * The worker emits slowly while the position is held, so a quiet feed is normal
 * and not a reason to change motion source. The predictor's own drift budget
 * already bounds motion on stale evidence; this threshold only decides when the
 * snapshot fallback takes over entirely.
 */
const DEFAULT_FRAME_STALE_MS = 3000;
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
 * the document is already at the top. One rendered line is the natural unit:
 * a correction the presenter could not distinguish from ordinary following.
 */
function fadeWorthwhile(distancePx: number, linePitchPx: number): boolean {
  return distancePx > Math.max(1, linePitchPx);
}

type ReanchorFadePhase = 'idle' | 'down' | 'up';

/**
 * Session clock (§9.1). Frames carry session-relative timestamps; the stage
 * only has `performance.now()`. The bridge between the two domains is one
 * number — the offset — and the estimator is the MINIMUM observed sample: the
 * arrival that spent the least time crossing the window boundary.
 *
 * A minimum is the right estimator because of a property the worker guarantees
 * rather than by luck. `SemanticMotionFrame.sessionTimeMs` is an affine
 * re-basing of the producer's clock (`SessionClock`, §9.1): it starts at 0 and
 * is monotone, and when the producer's clock contradicts itself the map is
 * RE-BASED rather than clamped. Every sample is therefore
 * `trueOffset + transportDelay` with `transportDelay >= 0` — the samples have a
 * hard floor, and the minimum converges onto it and stays there.
 *
 * The re-basing map is not a no-op, and its two discontinuities both point in
 * directions a minimum handles:
 *
 *   - The producer's clock steps FORWARD — an NTP correction, or a laptop
 *     waking with wall time advanced while the stage's monotonic clock slept.
 *     Session time steps forward with it, so every sample steps DOWN by the
 *     same amount and the minimum adopts the new floor on the first frame after
 *     the step, with nothing left to unwind. This is the scenario the
 *     compensation exists for.
 *
 *   - The producer's clock steps BACKWARD. The worker re-bases, so session time
 *     stays monotone and loses only the interval since its previous stamp — one
 *     worker tick. The offset would have to RISE by that much and a minimum
 *     will not rise, so the residual is a few ms of overstated evidence age
 *     against a 750 ms horizon and a 3 s staleness gate.
 *
 * This used to carry a `0.005` relaxation term letting the offset drift back up
 * toward the samples. It was earned when the worker stamped frames with
 * `Date.now()` and the offset genuinely wandered in both directions. Against a
 * monotone domain it has nothing to relax and it is not free: relaxing toward
 * the samples pulls the offset ABOVE the transport floor, which understates
 * evidence age and eventually makes an ordinary arrival look like it came from
 * the future.
 */
function createSessionClock() {
  let offset: number | null = null;
  return {
    observe(nowMs: number, sessionTimeMs: number) {
      const sample = nowMs - sessionTimeMs;
      if (offset === null || sample < offset) offset = sample;
    },
    sessionTime(nowMs: number): number | null {
      return offset === null ? null : nowMs - offset;
    },
    reset() {
      offset = null;
    },
  };
}

export function createStageMotionEngine(
  options: StageMotionEngineOptions = {},
): StageMotionEngine {
  // §47.1: mutable, because a stage window outlives a session and the next
  // session's envelope may carry a different feel. Read on every frame — never
  // captured — so a swap takes effect on the next one.
  let profile = options.profile ?? DEFAULT_SMOOTH_FOLLOW_PROFILE;
  const frameStaleMs = options.frameStaleMs ?? DEFAULT_FRAME_STALE_MS;
  const styleIntervalMs = options.styleIntervalMs ?? DEFAULT_STYLE_INTERVAL_MS;
  const manualGraceMs = options.manualGraceMs ?? DEFAULT_MANUAL_GRACE_MS;

  const receiver = createSemanticFrameReceiver({
    gate: {
      sessionId: '',
      sessionGeneration: 0,
      scriptCompileHash: '',
      layoutGeneration: 0,
    },
    profile,
  });
  const controller = createJerkLimitedScrollController();
  const transitions = createStageTransitionController();
  const diagnostics = createStageMotionDiagnostics({ ackIntervalMs: options.ackIntervalMs });
  const clock = createSessionClock();
  /**
   * §70.8. A hitch is a MISSED REFRESH, so the threshold has to come from the
   * refresh the display actually has — a fixed one is a 60 Hz assumption, and
   * on a 30 Hz panel it made every healthy frame a dropped frame.
   */
  const frameInterval = createFrameIntervalEstimator();
  const unitAxis = options.unitAxis ?? createCalibratingUnitAxis();

  let map: StageRenderedLineMap | null = null;
  let planner: LineHandoffPlanner | null = null;
  let fallback: FallbackTarget | null = null;
  let reducedMotion = false;
  let paused = false;
  let manualUntilMs = Number.NEGATIVE_INFINITY;
  let lastFrameAtMs: number | null = null;
  let lastStyleAtMs = Number.NEGATIVE_INFINITY;
  let lastPrediction: SemanticPrediction | null = null;
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
      map?.linePitchPx ?? 0,
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

  function rebuildPlanner() {
    planner =
      map && map.valid
        ? createLineHandoffPlanner(map, {
            maxFeedForwardPxS: profile.motion.maxForwardVelocityPxS,
            // A media or paragraph gap must never hand the controller an
            // unbounded derivative (§8.6).
            maxDerivativePxPerUnit: Math.max(1, map.linePitchPx) * 12,
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

  function semanticTarget(nowMs: number): {
    target: LineTarget;
    prediction: SemanticPrediction;
    mapUnit: number;
    frame: SemanticMotionFrame;
  } | null {
    const frame = receiver.current;
    if (!frame || !planner) return null;
    const sessionNow = clock.sessionTime(nowMs);
    if (sessionNow === null) return null;
    const ageMs = sessionNow - frame.sessionTimeMs;
    if (ageMs > frameStaleMs) return null;

    const prediction = predictSemanticPosition(frame, sessionNow, profile);
    const mapUnit = unitAxis.toMapUnit(prediction.unit);
    // The path derivative is per *map* unit, so the semantic velocity has to
    // cross the same axis change before it becomes feed-forward pixels.
    const mapVelocity =
      prediction.velocityUnitsPerSecond * unitAxis.slopeAt(prediction.unit);
    // §C1: the unit axis and the prediction are arithmetic over values the
    // stage did not produce. A non-finite result here must never reach the
    // planner, let alone the plant.
    if (!Number.isFinite(mapUnit) || !Number.isFinite(mapVelocity)) return null;
    const target = planner.target(mapUnit, mapVelocity);
    if (target.source === 'none') return null;
    if (
      !Number.isFinite(target.scrollPx) ||
      !Number.isFinite(target.feedForwardVelocityPxS)
    ) {
      return null;
    }
    return { target, prediction, mapUnit, frame };
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
    const mapUnit = line ? line.spokenUnitStart : unitAxis.toMapUnit(destinationUnit);
    const destination = planner.target(mapUnit, 0);
    return destination.source === 'none' ? null : destination.scrollPx;
  }

  return {
    receiver,
    controller,
    transitions,
    diagnostics,
    unitAxis,
    // A getter, not a captured value: `setProfile` must be observable through
    // the same property everything else reads.
    get profile() {
      return profile;
    },
    get map() {
      return map;
    },
    get lastPrediction() {
      return lastPrediction;
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

    configureSession(gate, nowMs) {
      receiver.setGate(gate, nowMs);
      receiver.reset();
      transitions.reset();
      clock.reset();
      unitAxis.reset();
      fallback = null;
      lastPrediction = null;
      forwardTargetLatchPx = null;
      latchExcessSinceMs = null;
      heldVisualSpan = null;
      targetRegressions = 0;
      latchReanchors = 0;
      deferredPlantOverwrites = 0;
      catchUpSinceMs = null;
      catchUpCapCounted = false;
      catchUpCapExpiries = 0;
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
      // Both of these were built FROM the profile: the receiver's plausible
      // speech envelope (§55 `prediction.maxUnitsPerSecond`) and the planner's
      // feed-forward ceiling. Everything else reads `profile` per frame.
      receiver.setProfile(next);
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

    setPaused(next) {
      paused = next;
    },

    receiveFrame(frame, nowMs) {
      const outcome = receiver.accept(frame, nowMs);
      if (!outcome.accepted) return false;
      clock.observe(nowMs, frame.sessionTimeMs);
      // One sampled point of the worker's cumulative speech-weight function —
      // but only from evidence worth calibrating on. A frame emitted while the
      // tracker is uncertain, coasting on stale evidence, or mid-retake carries
      // a `(unit, tokenIndex)` pair the tracker itself does not stand behind,
      // and a bad sample distorts the axis for every later frame.
      if (isCalibrationEvidence(frame)) {
        unitAxis.observe(frame.estimatedUnit, frame.tokenIndex);
      }
      if (frame.transition) {
        const sessionNow = clock.sessionTime(nowMs) ?? frame.sessionTimeMs;
        transitions.submit(frame.transition, sessionNow);
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

      const sessionNow = clock.sessionTime(nowMs);
      if (sessionNow !== null) transitions.update(sessionNow);

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
      if (overwrite) {
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

      const semantic = semanticTarget(nowMs);
      const manualGrace = nowMs < manualUntilMs;
      // §62: an invalid map means the stage does not know where anything is.
      // The semantic planner is already disabled — the *guessed* fallback has
      // to go with it, because its off-window branch estimates positions from
      // block offsets and estimated heights, which is exactly the "moving on
      // guessed geometry" the hold exists to prevent.
      const mapUnresolved = map === null || !map.valid;
      const fallbackUsable = fallback !== null && !mapUnresolved;

      let source: MotionSource = 'hold';
      let targetPx = lastTarget;
      let feedForward = 0;
      let state: TrackingStateV2 | null = null;
      let lineId: string | null = lastLineId;
      let lineProgress = 0;
      let activeTokenIndex: number | null = null;
      let visualSpanHold = false;

      if (semantic) {
        source = 'semantic';
        targetPx = semantic.target.scrollPx;
        feedForward = semantic.target.feedForwardVelocityPxS;
        state = semantic.frame.state;
        lineId = semantic.target.lineId;
        lineProgress = semantic.target.lineProgress;
        lastPrediction = semantic.prediction;
        activeTokenIndex = activeTokenFor(semantic.mapUnit, lineId);

        // §8.6: an interval whose SECANT exceeds the visual-block limit cannot
        // be followed — the path would race the whole image height inside one
        // spoken token. Hold at the entry while the presenter is inside it, and
        // cross it as one authorized re-anchor on the way out.
        const span = map?.visualBlockSpanAt(semantic.mapUnit) ?? null;
        if (span) {
          targetPx = span.scrollStartPx;
          feedForward = 0;
          visualSpanHold = true;
          heldVisualSpan = span;
        } else if (heldVisualSpan !== null) {
          const exitedForward = semantic.mapUnit >= heldVisualSpan.unitEnd;
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
        feedForward = 0;
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
      const catchUpLicensed =
        !frozen &&
        !manualGrace &&
        (state === 'catching_up' || activeTransition?.directive.type === 'catch_up');
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
      };
      /**
       * The state/transition shape of the limits, with no §30.3 bounds applied.
       * The latch below needs `allowBackward` and `reanchorThresholdPx` to
       * decide the target, and the §30.3 bounds are measured against that
       * decided target — so the bounded limits cannot be built until it exists.
       * Neither field is touched by the bounds, so this is the same answer.
       */
      const structuralLimits: MotionLimits = limitsForState(
        state ?? 'uncertain',
        profile,
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
          // §30.3, §8.8/§16.3: the line may not be carried above the corridor's
          // UPPER edge. Scrolling forward by one pixel past the target lifts
          // the line one pixel above `R`, so the corridor half-height is
          // precisely how far past the target the plant may be carried.
          catchUpCeilingPx = targetPx + corridorHalfPx;
        }
        catchUpBoost = Math.min(timeFactor, corridorFactor);
        if (catchUpCapped && !catchUpCapCounted) {
          catchUpCapCounted = true;
          catchUpCapExpiries++;
        }
      }

      const limits: MotionLimits = catchUpLicensed
        ? limitsForState(state ?? 'uncertain', profile, {
            ...limitOptions,
            catchUpBoost,
            forwardPositionCeilingPx: catchUpCeilingPx,
          })
        : structuralLimits;

      const step = controller.step({
        dtMs,
        targetPx: frozen ? controller.state.q : targetPx,
        feedForwardVelocityPxS: frozen ? 0 : feedForward,
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
      const frameForAck = receiver.current;
      const ackSessionId = frameForAck ? frameForAck.sessionId : receiver.gate.sessionId;
      const ack =
        ackSessionId.length > 0 && diagnostics.shouldEmitAck(nowMs)
          ? diagnostics.buildAck({
              sessionId: ackSessionId,
              revision: frameForAck ? frameForAck.revision : -1,
              epoch: frameForAck ? frameForAck.epoch : -1,
              layoutGeneration: receiver.gate.layoutGeneration,
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
        state,
        controllerState,
        styleTick,
        ack,
        degraded: diagnostics.degraded,
        hitch,
        documentOpacity,
      };
    },

    manualOverride(positionPx, nowMs) {
      // §30.6: manual interaction has immediate authority; reacquire without
      // snapping once the grace interval expires.
      reanchorTo(positionPx);
      manualUntilMs = nowMs + manualGraceMs;
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
      const unit = request.anchorUnit ?? lastPrediction?.unit ?? null;
      if (unit !== null && planner) {
        const destination = planner.target(unitAxis.toMapUnit(unit), 0);
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
      receiver.setGate({ layoutGeneration: request.map.generation }, request.nowMs);
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
      clock.reset();
      fallback = null;
      lastPrediction = null;
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
      resetFade();
      reanchorFades = 0;
    },
  };
}
