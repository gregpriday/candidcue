/**
 * Deterministic playback harness (companion §66, §69).
 *
 * "Build this before tuning production thresholds." The harness replays a
 * recorded action stream — transcript deltas and completions in commit order,
 * command masks, manual/command navigation, layout generations, semantic
 * sidecar responses with controlled delay, and animation ticks — through a
 * real `AlignmentEngine`, then reduces the result to the §69 metric set.
 *
 * It runs synchronously and far faster than real time, so the whole corpus can
 * live in CI, and it is completely clock-free: every timestamp comes from the
 * scenario, so a run is bit-for-bit reproducible.
 *
 * The prohibited-section-jump metric is deliberately re-derived here from the
 * decision log using an independently constructed `SectionGraph`, rather than
 * trusting the engine's own gate. A test that asks the gate whether the gate
 * worked proves nothing; §69.7 makes this number a release blocker, so it is
 * measured from the outside.
 */
import type { SemanticMotionFrame, TrackingBehavior, TrackingStateV2 } from '../contracts/smooth-follow';
import type { TrackingSnapshot } from '../contracts/tracking';
import { AlignmentEngine, type EngineSession } from './engine';
import { DocumentIndex } from './document-index';
import type { MovementDecisionRecord } from './decision-log';
import {
  resolveTrackingProfile,
  type PartialSmoothFollowProfile,
  type TrackingProfile,
} from './profile';
import { SectionGraph } from './section-graph';
import type { SemanticAssistEvidence } from './semantic-assist';
import type { TrackingDocument, TranscriptEvent } from './types';

/* ---------------------------------------------------------------------------
 * Scenario model
 * ------------------------------------------------------------------------- */

export type PlaybackAction =
  | { kind: 'transcript'; event: TranscriptEvent }
  | { kind: 'tick'; nowMs: number }
  | { kind: 'move'; tokenIndex: number; movement: 'manual' | 'command'; nowMs: number }
  | { kind: 'mask'; itemIds: string[] }
  | { kind: 'release'; itemIds: string[] }
  | { kind: 'command_pending'; pending: boolean; nowMs: number }
  | { kind: 'pause'; nowMs: number }
  | { kind: 'resume'; nowMs: number }
  | { kind: 'reset'; nowMs: number }
  | { kind: 'semantic_assist'; evidence: SemanticAssistEvidence }
  | { kind: 'layout'; generation: number; nowMs: number };

/**
 * One hand label (companion §66.1: "record expected ranges rather than brittle
 * exact floats"). `afterAction` is an index into the action list.
 */
export interface PlaybackLabel {
  afterAction: number;
  /** Intended script position, hand-labeled (§69.1). */
  intendedTokenIndex: number;
  /** Tokens of tolerance treated as "correct position". */
  toleranceTokens?: number;
  /** Section the cursor must legally be in at this point (§66.1). */
  sectionId?: string;
  /** States the tracker is permitted to be in here (§66.1). */
  allowedStates?: TrackingStateV2[];
}

export interface PlaybackScenario {
  id: string;
  description: string;
  document: TrackingDocument;
  actions: PlaybackAction[];
  labels?: PlaybackLabel[];
  session?: Partial<EngineSession>;
  profile?: Partial<TrackingProfile>;
  smoothProfile?: PartialSmoothFollowProfile;
  /** Behaviors this scenario is supposed to exhibit at least once. */
  expectBehaviors?: TrackingBehavior[];
  /** Behaviors that would indicate a defect in this scenario. */
  forbidBehaviors?: TrackingBehavior[];
  /** A retake here is intentional; otherwise every retake is counted false. */
  retakeIsExpected?: boolean;
  /** A forward skip here is intentional. */
  skipIsExpected?: boolean;
}

/* ---------------------------------------------------------------------------
 * Metrics (companion §69)
 * ------------------------------------------------------------------------- */

export interface PlaybackMetrics {
  /** §69.1 — position error against hand labels, in tokens. */
  labelCount: number;
  correctPositionRate: number;
  medianPositionErrorTokens: number;
  p90PositionErrorTokens: number;
  p95PositionErrorTokens: number;
  worstPositionErrorTokens: number;
  /** §69.2 — first useful speech to first committed lock. */
  timeToAcquireMs: number | null;
  /** §69.3 — off-script hold to the next stable lock. */
  timeToReturnMs: number | null;
  /** §69.4 — first backward candidate to the committed retake. */
  retakeLatencyMs: number | null;
  /** §69.5 / §69.6 — unintended backward and forward transitions. */
  falseRetakeCount: number;
  falseSkipCount: number;
  /** §69.7 — RELEASE BLOCKER. Must be exactly zero. */
  prohibitedSectionJumpCount: number;
  /**
   * §69.8 — hold quality. The distance the *prediction* ran past the last
   * accepted measurement while off-script, in spoken units. Measured against
   * the filter's measurement anchor rather than against wherever the hold
   * happened to begin, because that is the quantity §19.2 step 4 bounds: how
   * far the engine coasts on a stale estimate, not how far real evidence
   * legitimately moved it just before the hold started.
   */
  maxHoldDriftUnits: number;
  /* Frame-contract checks (companion §26.1). */
  frameCount: number;
  framesMonotone: boolean;
  framesFinite: boolean;
  maxFrameIntervalMs: number;
  /* Coverage. */
  behaviorsSeen: TrackingBehavior[];
  statesSeen: TrackingStateV2[];
  sectionsVisited: string[];
}

export interface PlaybackResult {
  scenarioId: string;
  metrics: PlaybackMetrics;
  /** Per-action trace, indexed by action position — the labels key off this. */
  cursorAfterAction: number[];
  stateAfterAction: TrackingStateV2[];
  sectionAfterAction: string[];
  frames: SemanticMotionFrame[];
  snapshots: TrackingSnapshot[];
  records: MovementDecisionRecord[];
  /** Detail for any prohibited jump, so a failure is actionable. */
  prohibitedJumps: MovementDecisionRecord[];
  engine: AlignmentEngine;
}

/* ---------------------------------------------------------------------------
 * Runner
 * ------------------------------------------------------------------------- */

export function runPlayback(scenario: PlaybackScenario): PlaybackResult {
  const session: EngineSession = {
    sessionId: scenario.session?.sessionId ?? `playback-${scenario.id}`,
    sessionGeneration: scenario.session?.sessionGeneration ?? 1,
    stageGeneration: scenario.session?.stageGeneration ?? 1,
    layoutGeneration: scenario.session?.layoutGeneration ?? 1,
  };
  const engine = new AlignmentEngine(
    scenario.document,
    session,
    scenario.profile,
    scenario.smoothProfile,
  );
  const profile = resolveTrackingProfile(scenario.profile);

  const frames: SemanticMotionFrame[] = [];
  const snapshots: TrackingSnapshot[] = [];
  const records: MovementDecisionRecord[] = [];
  const behaviors = new Set<TrackingBehavior>();
  const states = new Set<TrackingStateV2>();
  const sections = new Set<string>();

  let firstSpeechAtMs: number | null = null;
  let acquiredAtMs: number | null = null;
  let offScriptSinceMs: number | null = null;
  let timeToReturnMs: number | null = null;
  let retakePendingSinceMs: number | null = null;
  let retakeLatencyMs: number | null = null;
  let maxHoldDriftUnits = 0;

  const cursorAfterAction: number[] = [];
  const stateAfterAction: TrackingStateV2[] = [];
  const sectionAfterAction: string[] = [];

  const consume = (output: ReturnType<AlignmentEngine['tick']>, atMs: number): void => {
    if (output.snapshot) snapshots.push(output.snapshot);
    if (output.frame) {
      frames.push(output.frame);
      behaviors.add(output.frame.behavior);
      states.add(output.frame.state);
      sections.add(output.frame.sectionId);
    }
    if (output.decision) {
      records.push(output.decision);
      behaviors.add(output.decision.behavior);
      states.add(output.decision.stateAfter);
    }

    const state = engine.stateV2Current;
    // §69.3 time-to-return and §69.8 hold drift.
    if (state === 'adlib_hold' || state === 'lost_local' || state === 'uncertain') {
      if (offScriptSinceMs === null) offScriptSinceMs = atMs;
      const unit = engine.filter.estimate().positionUnits;
      maxHoldDriftUnits = Math.max(
        maxHoldDriftUnits,
        Math.abs(unit - engine.filter.committedAnchorUnits),
      );
    } else if (state === 'following' || state === 'catching_up') {
      if (offScriptSinceMs !== null && timeToReturnMs === null) {
        timeToReturnMs = atMs - offScriptSinceMs;
      }
      offScriptSinceMs = null;
    }
    // §69.4 retake latency.
    if (state === 'retake_pending' && retakePendingSinceMs === null) {
      retakePendingSinceMs = atMs;
    }
    if (
      output.decision?.behavior === 'retake' &&
      retakePendingSinceMs !== null &&
      retakeLatencyMs === null
    ) {
      retakeLatencyMs = atMs - retakePendingSinceMs;
      retakePendingSinceMs = null;
    }
    if (acquiredAtMs === null && engine.cursor.committedTokenIndex > 0) {
      acquiredAtMs = atMs;
    }
  };

  scenario.actions.forEach((action, actionIndex) => {
    let atMs = 0;
    switch (action.kind) {
      case 'transcript': {
        atMs = action.event.receivedAtMs;
        if (firstSpeechAtMs === null && action.event.type !== 'transport_state') {
          firstSpeechAtMs = atMs;
        }
        consume(engine.handleTranscriptEvent(action.event), atMs);
        break;
      }
      case 'tick':
        atMs = action.nowMs;
        consume(engine.tick(action.nowMs), atMs);
        break;
      case 'move':
        atMs = action.nowMs;
        consume(engine.moveTo(action.tokenIndex, action.movement, action.nowMs), atMs);
        break;
      case 'mask':
        engine.maskItems(action.itemIds);
        break;
      case 'release':
        engine.releaseItems(action.itemIds);
        break;
      case 'command_pending':
        atMs = action.nowMs;
        consume(engine.setCommandPending(action.pending, action.nowMs), atMs);
        break;
      case 'pause':
        atMs = action.nowMs;
        consume(engine.pause(action.nowMs), atMs);
        break;
      case 'resume':
        atMs = action.nowMs;
        consume(engine.resume(action.nowMs), atMs);
        break;
      case 'reset':
        atMs = action.nowMs;
        consume(engine.reset(action.nowMs), atMs);
        break;
      case 'semantic_assist':
        engine.applySemanticAssist(action.evidence);
        break;
      case 'layout':
        atMs = action.nowMs;
        consume(engine.setLayoutGeneration(action.generation, action.nowMs), atMs);
        break;
    }
    cursorAfterAction[actionIndex] = engine.cursor.tokenIndex;
    stateAfterAction[actionIndex] = engine.stateV2Current;
    sectionAfterAction[actionIndex] = engine.sectionGraph.sectionIdAt(
      engine.cursor.committedTokenIndex,
    );
  });

  const metrics = reduceMetrics({
    scenario,
    profile,
    frames,
    records,
    cursorAfterAction,
    stateAfterAction,
    sectionAfterAction,
    behaviors,
    states,
    sections,
    firstSpeechAtMs,
    acquiredAtMs,
    timeToReturnMs,
    retakeLatencyMs,
    maxHoldDriftUnits,
  });

  return {
    scenarioId: scenario.id,
    metrics: metrics.metrics,
    cursorAfterAction,
    stateAfterAction,
    sectionAfterAction,
    frames,
    snapshots,
    records,
    prohibitedJumps: metrics.prohibitedJumps,
    engine,
  };
}

/* ---------------------------------------------------------------------------
 * Metric reduction
 * ------------------------------------------------------------------------- */

interface ReduceInput {
  scenario: PlaybackScenario;
  profile: TrackingProfile;
  frames: SemanticMotionFrame[];
  records: MovementDecisionRecord[];
  cursorAfterAction: number[];
  stateAfterAction: TrackingStateV2[];
  sectionAfterAction: string[];
  behaviors: Set<TrackingBehavior>;
  states: Set<TrackingStateV2>;
  sections: Set<string>;
  firstSpeechAtMs: number | null;
  acquiredAtMs: number | null;
  timeToReturnMs: number | null;
  retakeLatencyMs: number | null;
  maxHoldDriftUnits: number;
}

function reduceMetrics(input: ReduceInput): {
  metrics: PlaybackMetrics;
  prohibitedJumps: MovementDecisionRecord[];
} {
  const { scenario } = input;

  // §69.1 position error.
  const errors: number[] = [];
  let correct = 0;
  for (const label of scenario.labels ?? []) {
    const cursor = input.cursorAfterAction[label.afterAction];
    if (cursor === undefined) continue;
    const error = Math.abs(cursor - label.intendedTokenIndex);
    errors.push(error);
    if (error <= (label.toleranceTokens ?? 3)) correct++;
  }
  errors.sort((a, b) => a - b);

  // §69.7 prohibited section jumps, re-derived independently of the engine.
  const index = new DocumentIndex(scenario.document, { rareWeight: input.profile.rareWeight });
  const graph = new SectionGraph(index, input.profile);
  const prohibitedJumps: MovementDecisionRecord[] = [];
  for (const record of input.records) {
    if (record.authority !== 'ordinary') continue; // command/manual may go anywhere
    if (record.behavior === 'acquire') continue; // §17.1 acquisition is not a jump
    if (record.fromSectionId === record.toSectionId) continue;
    const forwardOk =
      record.toSectionId === graph.nextSectionId(record.fromSectionId) &&
      graph.isNearSectionEnd(record.fromTokenIndex) &&
      graph.isNearSectionStart(record.toTokenIndex);
    const backwardOk =
      record.toSectionId === graph.previousSectionId(record.fromSectionId) &&
      graph.isNearSectionStart(record.fromTokenIndex, input.profile.sectionBoundaryBackwardTokens) &&
      graph.isNearSectionEnd(record.toTokenIndex, input.profile.sectionBoundaryBackwardTokens);
    if (!forwardOk && !backwardOk) prohibitedJumps.push(record);
  }

  // §69.5 / §69.6 false transitions.
  const retakes = input.records.filter((r) => r.behavior === 'retake').length;
  const skips = input.records.filter(
    (r) => r.behavior === 'large_skip' || r.behavior === 'small_skip',
  ).length;

  // Frame contract (§26.1): strictly increasing revision, all-finite numbers.
  let framesMonotone = true;
  let framesFinite = true;
  let maxFrameIntervalMs = 0;
  let previous: SemanticMotionFrame | undefined;
  for (const frame of input.frames) {
    if (previous !== undefined) {
      if (frame.revision <= previous.revision) framesMonotone = false;
      maxFrameIntervalMs = Math.max(
        maxFrameIntervalMs,
        frame.sessionTimeMs - previous.sessionTimeMs,
      );
    }
    if (
      !Number.isFinite(frame.estimatedUnit) ||
      !Number.isFinite(frame.committedUnit) ||
      !Number.isFinite(frame.velocityUnitsPerSecond) ||
      !Number.isFinite(frame.accelerationUnitsPerSecond2) ||
      !Number.isFinite(frame.positionVariance) ||
      !Number.isFinite(frame.confidence)
    ) {
      framesFinite = false;
    }
    previous = frame;
  }

  return {
    prohibitedJumps,
    metrics: {
      labelCount: errors.length,
      correctPositionRate: errors.length === 0 ? 1 : correct / errors.length,
      medianPositionErrorTokens: percentile(errors, 0.5),
      p90PositionErrorTokens: percentile(errors, 0.9),
      p95PositionErrorTokens: percentile(errors, 0.95),
      worstPositionErrorTokens: errors.length === 0 ? 0 : (errors[errors.length - 1] ?? 0),
      timeToAcquireMs:
        input.firstSpeechAtMs !== null && input.acquiredAtMs !== null
          ? input.acquiredAtMs - input.firstSpeechAtMs
          : null,
      timeToReturnMs: input.timeToReturnMs,
      retakeLatencyMs: input.retakeLatencyMs,
      falseRetakeCount: scenario.retakeIsExpected === true ? Math.max(0, retakes - 1) : retakes,
      falseSkipCount: scenario.skipIsExpected === true ? Math.max(0, skips - 1) : skips,
      prohibitedSectionJumpCount: prohibitedJumps.length,
      maxHoldDriftUnits: input.maxHoldDriftUnits,
      frameCount: input.frames.length,
      framesMonotone,
      framesFinite,
      maxFrameIntervalMs,
      behaviorsSeen: [...input.behaviors].sort(),
      statesSeen: [...input.states].sort(),
      sectionsVisited: [...input.sections].sort(),
    },
  };
}

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const position = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)));
  return sorted[position] ?? 0;
}

/**
 * Assert the §66.1 golden expectations for one result. Returns human-readable
 * failures rather than throwing, so a suite can report every violation.
 */
export function checkGoldenExpectations(
  scenario: PlaybackScenario,
  result: PlaybackResult,
): string[] {
  const failures: string[] = [];
  const { metrics } = result;

  if (metrics.prohibitedSectionJumpCount !== 0) {
    failures.push(
      `prohibited section jump (${metrics.prohibitedSectionJumpCount}): ` +
        result.prohibitedJumps
          .map((r) => `${r.fromSectionId}→${r.toSectionId} via ${r.behavior}`)
          .join(', '),
    );
  }
  if (!metrics.framesMonotone) failures.push('frame revisions are not strictly increasing');
  if (!metrics.framesFinite) failures.push('a frame carried a non-finite value');

  for (const behavior of scenario.expectBehaviors ?? []) {
    if (!metrics.behaviorsSeen.includes(behavior)) {
      failures.push(`expected behavior '${behavior}' never occurred`);
    }
  }
  for (const behavior of scenario.forbidBehaviors ?? []) {
    if (metrics.behaviorsSeen.includes(behavior)) {
      failures.push(`forbidden behavior '${behavior}' occurred`);
    }
  }
  for (const label of scenario.labels ?? []) {
    const cursor = result.cursorAfterAction[label.afterAction];
    const tolerance = label.toleranceTokens ?? 3;
    if (cursor === undefined) {
      failures.push(`label at action ${label.afterAction} has no recorded cursor`);
      continue;
    }
    if (Math.abs(cursor - label.intendedTokenIndex) > tolerance) {
      failures.push(
        `action ${label.afterAction}: cursor ${cursor}, expected ` +
          `${label.intendedTokenIndex} ±${tolerance}`,
      );
    }
    if (label.sectionId !== undefined) {
      const section = result.sectionAfterAction[label.afterAction];
      if (section !== label.sectionId) {
        failures.push(
          `action ${label.afterAction}: section '${section}', expected '${label.sectionId}'`,
        );
      }
    }
    if (label.allowedStates !== undefined) {
      const state = result.stateAfterAction[label.afterAction];
      if (state === undefined || !label.allowedStates.includes(state)) {
        failures.push(
          `action ${label.afterAction}: state '${state}' not in ` +
            `[${label.allowedStates.join(', ')}]`,
        );
      }
    }
  }
  return failures;
}
