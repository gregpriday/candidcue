/**
 * Adapters between the v2 following producers and the control-side
 * `SmoothFollowStore`.
 *
 * The producers are owned by other modules that are landing in parallel, so
 * every seam here is typed against the shared contract
 * (`src/shared/contracts/smooth-follow.ts`) and marked with the binding that
 * integration must make. Nothing in this file guesses at behavior: where a v2
 * producer does not exist yet, the bridge from today's v1 pipeline is explicit
 * about what it can and cannot know.
 *
 * TODO(integration) — bindings to make when the owning modules land:
 *  1. Agent A (`src/workers/**`, `src/shared/tracking/**`): emit
 *     `SemanticMotionFrame` and the §65 `MovementDecisionRecord` on the worker
 *     protocol. Then delete `motionFrameFromSnapshot` / `movementRecordFrom-
 *     Diagnostic` below and forward the real messages straight to the store.
 *  2. Agent B (`src/stage/**`): the ack event name is bound (STAGE_EVENT.
 *     motionAck) — the remaining binding is a layout/line-map error the stage
 *     raises on §62 so control can offer the rebuild action. Today the session
 *     store pattern-matches the generic stage-error event for it.
 *  3. Agent C (`src/shared/semantic/**`, `src-tauri/src/openai/**`): report
 *     scheduler state, usage, and coach tips. `subscribeAssistStatus` is the
 *     single entry point the store expects.
 */
import type {
  SemanticMotionFrame,
  StageMotionAck,
  TrackingBehavior,
  TrackingSnapshot,
  TrackingState,
  TrackingStateV2,
} from '../../shared/contracts';
import { DEFAULT_SMOOTH_FOLLOW_PROFILE, STAGE_EVENT } from '../../shared/contracts';
import type { AlignmentDiagnostic } from '../../shared/tracking/types';
import type { MovementDecisionRecord } from '../lib/follow-language';
import type { AssistStatus, BudgetBreach, CoachTipView } from '../stores/smooth-follow';
import { isTauriRuntime } from './ipc';
import type { SemanticSidecar } from './semantic-sidecar';

/** The stage's periodic motion report (companion §54), owned by contracts. */
export const STAGE_MOTION_ACK_EVENT = STAGE_EVENT.motionAck;

/* ---------------------------------------------------------------------------
 * v1 → v2 bridges (temporary)
 * ------------------------------------------------------------------------- */

/** Companion §52 state, as close as the v1 engine can honestly report. */
export function trackingStateV2FromLegacy(state: TrackingState): TrackingStateV2 {
  switch (state) {
    case 'following':
      return 'following';
    // v1 "holding" is a hold caused by weak evidence — v2 calls that uncertain.
    case 'holding':
      return 'uncertain';
    case 'searching':
      return 'acquiring';
    case 'retake_candidate':
      return 'retake_pending';
    case 'command_pending':
      return 'command_pending';
    case 'paused':
      return 'paused';
    case 'reconnecting':
      return 'reconnecting';
    default:
      return 'acquiring';
  }
}

/** Companion §52 behavior inferred from the v1 movement kind. */
export function trackingBehaviorFromMovement(
  movement: TrackingSnapshot['movement'],
  state: TrackingState,
): TrackingBehavior {
  switch (movement) {
    case 'advance':
      return 'normal';
    case 'skip':
      return 'small_skip';
    case 'retake':
      return 'retake';
    case 'command':
      return 'command_navigation';
    case 'manual':
      return 'manual_navigation';
    case 'hold':
    default:
      if (state === 'searching') return 'lost';
      if (state === 'retake_candidate') return 'retake_candidate';
      return 'normal';
  }
}

export interface MotionFrameBridgeContext {
  sessionId: string;
  sessionGeneration: number;
  scriptCompileHash: string;
  layoutGeneration: number;
  motionProfileId: string;
  sessionStartedAtMs: number;
  /** Previous bridged frame, used for a crude velocity estimate. */
  previous?: SemanticMotionFrame | null;
  nowMs?: number;
}

/**
 * Movements whose position delta is a CORRECTION rather than speech.
 *
 * A finite difference over one of these divides a jump by a frame interval and
 * calls the result a speaking rate — 30 tokens across 200 ms reads as 150
 * units/s, which the stage then extrapolates over its 750 ms horizon into a
 * hundred-plus units of scroll. The presenter's pace did not change when the
 * tracker re-located them; only the position did.
 */
const NON_SPEECH_MOVEMENTS: ReadonlySet<TrackingSnapshot['movement']> = new Set([
  'skip',
  'retake',
  'command',
  'manual',
]);

/**
 * Monotonic wall clock. `Date.now()` is subject to NTP steps and manual clock
 * changes; a backward step inflates every subsequent evidence age (and a
 * forward one hides real staleness), which is exactly the input the prediction
 * horizon is measured against.
 */
export function monotonicNowMs(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

/**
 * Bridge a v1 `TrackingSnapshot` into a `SemanticMotionFrame` so the control
 * UI is exercised today.
 *
 * Deliberate limitations, so nothing here oversells the v1 engine:
 *  - spoken units are approximated by token indices (the v1 engine has no
 *    weighted spoken-unit coordinate);
 *  - velocity is a finite difference between snapshots, not a filtered pace
 *    estimate, and acceleration is reported as zero rather than invented;
 *  - `positionVariance` is left at zero — v1 does not estimate one.
 *
 * The finite difference is bounded on both sides: it is not taken across a
 * position correction at all, and what it does produce is folded into the
 * profile's plausible-speech envelope. The stage clamps this again on receipt —
 * it does not trust control — but a producer should not be emitting a rate no
 * mouth can make in the first place.
 *
 * TODO(integration, Agent A): delete once the worker emits real frames.
 */
export function motionFrameFromSnapshot(
  snapshot: TrackingSnapshot,
  context: MotionFrameBridgeContext,
): SemanticMotionFrame {
  const nowMs = context.nowMs ?? monotonicNowMs();
  const sessionTimeMs = Math.max(0, nowMs - context.sessionStartedAtMs);
  const previous = context.previous ?? null;
  const elapsedSeconds =
    previous && sessionTimeMs > previous.sessionTimeMs
      ? (sessionTimeMs - previous.sessionTimeMs) / 1000
      : 0;
  const paceMax = DEFAULT_SMOOTH_FOLLOW_PROFILE.prediction.maxUnitsPerSecond;
  const velocity =
    elapsedSeconds > 0 && !NON_SPEECH_MOVEMENTS.has(snapshot.movement)
      ? Math.min(
          paceMax,
          Math.max(0, (snapshot.tokenIndex - previous!.estimatedUnit) / elapsedSeconds),
        )
      : 0;

  return {
    sessionId: snapshot.sessionId,
    sessionGeneration: context.sessionGeneration,
    scriptCompileHash: context.scriptCompileHash,
    layoutGeneration: context.layoutGeneration,
    revision: snapshot.revision,
    epoch: snapshot.sessionGeneration,
    sessionTimeMs,
    estimatedUnit: snapshot.tokenIndex,
    committedUnit: snapshot.committedTokenIndex,
    velocityUnitsPerSecond: velocity,
    accelerationUnitsPerSecond2: 0,
    positionVariance: 0,
    confidence: snapshot.confidence,
    sectionId: snapshot.blockId,
    tokenIndex: snapshot.tokenIndex,
    sentenceId: snapshot.sentenceId,
    blockId: snapshot.blockId,
    state: trackingStateV2FromLegacy(snapshot.state),
    behavior: trackingBehaviorFromMovement(snapshot.movement, snapshot.state),
    finalEvidence: !snapshot.provisional,
    motionProfileId: context.motionProfileId,
  };
}

const DISPOSITION_BY_MOVEMENT: Record<
  TrackingSnapshot['movement'],
  MovementDecisionRecord['visualDisposition']
> = {
  advance: 'absorbed',
  skip: 'catch_up',
  retake: 'rewind',
  command: 'reanchor',
  manual: 'reanchor',
  hold: 'hold',
};

/**
 * Bridge a v1 `AlignmentDiagnostic` into a §65 movement record.
 *
 * `sectionGate` is reported as `allowed` because the v1 engine has no section
 * graph — nothing was blocked, rather than "a gate approved it". Semantic
 * fields are omitted entirely rather than defaulted, so the UI does not claim
 * assist input that never happened.
 *
 * TODO(integration, Agent A): delete once the worker emits real records.
 */
export function movementRecordFromDiagnostic(
  diagnostic: AlignmentDiagnostic,
  context: { sessionStartedAtMs: number; previousState: TrackingStateV2; nowMs?: number },
): MovementDecisionRecord {
  const nowMs = context.nowMs ?? monotonicNowMs();
  return {
    revision: diagnostic.revision,
    sessionTimeMs: Math.max(0, nowMs - context.sessionStartedAtMs),
    fromUnit: diagnostic.committedTokenIndex,
    toUnit: diagnostic.cursorTokenIndex,
    behavior: trackingBehaviorFromMovement(diagnostic.movement, diagnostic.state),
    stateBefore: context.previousState,
    stateAfter: trackingStateV2FromLegacy(diagnostic.state),
    localConfidence: diagnostic.confidence,
    secondBestMargin: diagnostic.margin,
    sectionGate: 'allowed',
    authority:
      diagnostic.movement === 'command'
        ? 'command'
        : diagnostic.movement === 'manual'
          ? 'manual'
          : 'ordinary',
    visualDisposition: DISPOSITION_BY_MOVEMENT[diagnostic.movement] ?? 'hold',
  };
}

/**
 * Movements worth recording (§65: "every nontrivial movement transition").
 * A steady advance at high confidence is not a decision anyone needs
 * explained, and logging every one would flood the ring buffer.
 */
export function isNontrivialMovement(diagnostic: AlignmentDiagnostic): boolean {
  if (diagnostic.movement !== 'advance' && diagnostic.movement !== 'hold') return true;
  if (diagnostic.state !== 'following') return true;
  return diagnostic.confidence < 0.6;
}

/* ---------------------------------------------------------------------------
 * Event subscriptions
 * ------------------------------------------------------------------------- */

/**
 * Listen for stage motion acks (§54). Returns an unsubscribe function; a
 * no-op outside the Tauri runtime so browser dev and unit tests are unaffected.
 */
export function subscribeStageMotionAcks(
  handler: (ack: StageMotionAck) => void,
): () => void {
  if (!isTauriRuntime()) return () => {};
  let unlisten: (() => void) | null = null;
  let cancelled = false;
  void (async () => {
    const { listen } = await import('@tauri-apps/api/event');
    const stop = await listen<StageMotionAck>(STAGE_MOTION_ACK_EVENT, (event) => {
      handler(event.payload);
    });
    if (cancelled) stop();
    else unlisten = stop;
  })().catch(() => {
    // The stage has not started emitting acks yet — diagnostics simply stay
    // empty; following is unaffected.
  });
  return () => {
    cancelled = true;
    unlisten?.();
    unlisten = null;
  };
}

/** Handlers the semantic sidecar and budget reporters push into. */
export interface FollowSidecarHandlers {
  /** Scheduler state, usage counters, and §58 outage reasons. */
  onAssistStatus(patch: Partial<AssistStatus>): void;
  /** Validated coach tips (§43, §46). */
  onCoachTip(tip: CoachTipView): void;
  /** §63 runtime budgets, measured by whoever owns the budgeted work. */
  onBudgetBreach(breach: Omit<BudgetBreach, 'atMs'>): void;
}

/**
 * The live semantic sidecar for the current take, or null when none is
 * running. Set by the session store through `setActiveSemanticSidecar` so the
 * sidecar feed can report real scheduler state instead of nothing.
 */
let activeSidecar: SemanticSidecar | null = null;
const sidecarListeners = new Set<FollowSidecarHandlers>();

/**
 * Register (or clear) the session-owned sidecar. Called on take start/stop.
 *
 * H6: the scheduler is created and cancelled with the take, never module
 * state that outlives it — a scheduler surviving a take would keep emitting
 * evidence against a session generation that no longer exists.
 */
export function setActiveSemanticSidecar(sidecar: SemanticSidecar | null): void {
  activeSidecar = sidecar;
  const patch = assistStatusPatch(sidecar);
  for (const handlers of sidecarListeners) {
    handlers.onAssistStatus(patch);
  }
}

/** The sidecar owning the current take, for callers that need to drive it. */
export function getActiveSemanticSidecar(): SemanticSidecar | null {
  return activeSidecar;
}

/**
 * Semantic-sidecar + runtime-budget feed.
 *
 * Returns an unsubscribe function. Assist status now reflects the real
 * scheduler when a take is running; it reports `disabled` when no sidecar is
 * registered, rather than inventing activity.
 *
 * The candidate feed is bound: the tracking worker emits `semantic_context`
 * (companion §37.1) and the session store attaches it to the sidecar, so a
 * running take with a worker-backed driver reports genuine scheduler activity.
 *
 * TODO(integration, Agents A + B): report §63 budget overruns — worker
 * alignment-update time and stage per-frame controller time — through
 * `onBudgetBreach`.
 */
export function subscribeFollowSidecar(handlers: FollowSidecarHandlers): () => void {
  sidecarListeners.add(handlers);
  handlers.onAssistStatus(assistStatusPatch(activeSidecar));
  return () => {
    sidecarListeners.delete(handlers);
  };
}

/** Map real scheduler availability onto the §47.4 assist-status view. */
function assistStatusPatch(sidecar: SemanticSidecar | null): Partial<AssistStatus> {
  if (sidecar === null) return { state: 'off', reason: null };
  const diagnostics = sidecar.scheduler.getDiagnostics();
  switch (sidecar.scheduler.getAvailability()) {
    case 'ready':
      return { state: 'ready', reason: null, requestCount: totalRequests(diagnostics) };
    case 'disabled':
      return { state: 'off', reason: null };
    case 'budget_exhausted':
      return { state: 'limit_reached', requestCount: totalRequests(diagnostics) };
    case 'degraded_timeout':
    case 'degraded_rate_limited':
      return { state: 'backing_off', requestCount: totalRequests(diagnostics) };
    case 'degraded_quota':
    case 'degraded_unavailable':
    default:
      return { state: 'unavailable', requestCount: totalRequests(diagnostics) };
  }
}

function totalRequests(diagnostics: { requestsByLane: Record<string, number> }): number {
  return Object.values(diagnostics.requestsByLane).reduce((sum, n) => sum + n, 0);
}
