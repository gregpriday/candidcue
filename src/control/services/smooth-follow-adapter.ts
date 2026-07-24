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
import { STAGE_EVENT } from '../../shared/contracts';
import type { AlignmentDiagnostic } from '../../shared/tracking/types';
import type { MovementDecisionRecord } from '../lib/follow-language';
import type { AssistStatus, BudgetBreach, CoachTipView } from '../stores/smooth-follow';
import { isTauriRuntime } from './ipc';

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
 * TODO(integration, Agent A): delete once the worker emits real frames.
 */
export function motionFrameFromSnapshot(
  snapshot: TrackingSnapshot,
  context: MotionFrameBridgeContext,
): SemanticMotionFrame {
  const nowMs = context.nowMs ?? Date.now();
  const sessionTimeMs = Math.max(0, nowMs - context.sessionStartedAtMs);
  const previous = context.previous ?? null;
  const elapsedSeconds =
    previous && sessionTimeMs > previous.sessionTimeMs
      ? (sessionTimeMs - previous.sessionTimeMs) / 1000
      : 0;
  const velocity =
    elapsedSeconds > 0
      ? Math.max(0, (snapshot.tokenIndex - previous!.estimatedUnit) / elapsedSeconds)
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
  const nowMs = context.nowMs ?? Date.now();
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
 * Semantic-sidecar + runtime-budget feed.
 *
 * Returns an unsubscribe function and reports nothing until the producers
 * exist, so an un-instrumented build simply shows no assist activity rather
 * than inventing one.
 *
 * TODO(integration, Agent C): subscribe to the scheduler's status stream and
 * the coach engine in `src/shared/semantic/**`, and forward Rust-side usage
 * from `src-tauri/src/openai/**`.
 * TODO(integration, Agents A + B): report §63 budget overruns — worker
 * alignment-update time and stage per-frame controller time — through
 * `onBudgetBreach`.
 */
export function subscribeFollowSidecar(_handlers: FollowSidecarHandlers): () => void {
  return () => {};
}
