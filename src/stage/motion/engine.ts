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
  createJerkLimitedScrollController,
  HITCH_THRESHOLD_MS,
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

  configureSession(gate: SemanticFrameGate, nowMs: number): void;
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
 * Session clock (§9.1). Frames carry session-relative timestamps; the stage
 * only has `performance.now()`. Track the minimum observed offset — the sample
 * with the least transport delay — and let it relax slowly so clock drift does
 * not accumulate into an inflated evidence age.
 */
function createSessionClock() {
  let offset: number | null = null;
  return {
    observe(nowMs: number, sessionTimeMs: number) {
      const sample = nowMs - sessionTimeMs;
      if (offset === null || sample < offset) offset = sample;
      else offset += (sample - offset) * 0.005;
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
  const profile = options.profile ?? DEFAULT_SMOOTH_FOLLOW_PROFILE;
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
  });
  const controller = createJerkLimitedScrollController();
  const transitions = createStageTransitionController();
  const diagnostics = createStageMotionDiagnostics({ ackIntervalMs: options.ackIntervalMs });
  const clock = createSessionClock();
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
  /** Visual-block span the plant is currently held at (§8.6). */
  let heldVisualSpan: VisualBlockSpan | null = null;

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
    profile,
    unitAxis,
    get map() {
      return map;
    },
    get lastPrediction() {
      return lastPrediction;
    },
    get targetRegressions() {
      return targetRegressions;
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
      heldVisualSpan = null;
      targetRegressions = 0;
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
      if (overwrite) {
        const destination = destinationScrollPx(overwrite.destinationTokenIndex, overwrite.toUnit);
        if (destination !== null) reanchorTo(destination);
        // A re-anchor *is* the discontinuity: once applied it is finished, so
        // its backward-capable profile cannot linger and let ordinary following
        // reverse afterwards.
        transitions.complete(overwrite.id);
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
        if (fallback.disposition === 'reanchor' || fallback.disposition === 'instant') {
          // Explicit command/manual navigation: an authorized reposition.
          reanchorTo(fallback.scrollPx);
          fallback = { ...fallback, disposition: 'follow' };
        }
      }

      if (paused) state = 'paused';

      const activeTransition = transitions.active;
      const limits: MotionLimits = limitsForState(state ?? 'uncertain', profile, {
        reducedMotion,
        degraded: diagnostics.degraded,
        transition: activeTransition?.directive.type,
        manualGrace,
      });

      // No map, no accepted frame, no fallback: hold. Never move on guessed
      // geometry (§62).
      const holding = source === 'hold';

      // §70.5 forward latch. Applied only to ordinary (forward-only) following;
      // a backward-capable profile is an explicit classification of the
      // regression and releases the latch.
      let regressed = false;
      if (!holding && !visualSpanHold) {
        if (limits.allowBackward || manualGrace) {
          // A backward-capable profile is an explicit classification of the
          // regression; manual authority suspends automatic correction outright
          // (§30.6), and re-latching to the pre-interaction target during the
          // grace would fight the presenter's own reposition afterwards.
          forwardTargetLatchPx = null;
        } else if (forwardTargetLatchPx !== null && targetPx < forwardTargetLatchPx) {
          targetPx = forwardTargetLatchPx;
          regressed = true;
          targetRegressions++;
        } else {
          forwardTargetLatchPx = targetPx;
        }
      }

      const step = controller.step({
        dtMs,
        targetPx: holding ? controller.state.q : targetPx,
        feedForwardVelocityPxS: holding ? 0 : feedForward,
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
        step.fused ? 'fused' : null,
      ]
        .filter(Boolean)
        .join(':');

      const hitch = step.hitch || dtMs > HITCH_THRESHOLD_MS;
      diagnostics.sample({
        nowMs,
        dtMs,
        hitch,
        targetPx: holding ? controller.state.q : targetPx,
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
      const styleTick = nowMs - lastStyleAtMs >= styleInterval;
      if (styleTick) lastStyleAtMs = nowMs;

      const frameForAck = receiver.current;
      const ack =
        frameForAck && diagnostics.shouldEmitAck(nowMs)
          ? diagnostics.buildAck({
              sessionId: frameForAck.sessionId,
              revision: frameForAck.revision,
              epoch: frameForAck.epoch,
              layoutGeneration: receiver.gate.layoutGeneration,
              targetPx: holding ? controller.state.q : targetPx,
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
        targetPx: holding ? controller.state.q : targetPx,
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
      };
    },

    manualOverride(positionPx, nowMs) {
      // §30.6: manual interaction has immediate authority; reacquire without
      // snapping once the grace interval expires.
      reanchorTo(positionPx);
      manualUntilMs = nowMs + manualGraceMs;
      fallback = null;
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
    },
  };
}
