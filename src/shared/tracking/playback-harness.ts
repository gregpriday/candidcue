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
 * The prohibited-section-jump metric is measured from *outside* the engine, and
 * outside every collaborator the engine uses to make the decision. It is
 * derived from:
 *
 *   - the raw `scenario.document.outline`, flattened here into a plain
 *     `tokenIndex → sectionIndex` array — not `DocumentIndex`, not
 *     `SectionGraph`;
 *   - the observed committed-cursor trace, sampled after every action — not the
 *     engine's own `fromTokenIndex`/`toTokenIndex` record fields;
 *   - `authority` and `acquire` recomputed from the *action stream* (which
 *     `move`/`reset` actions the scenario actually performed, and which action
 *     produced the first commit) — not the engine's `record.authority` /
 *     `record.behavior` labels;
 *   - a boundary corridor expressed as a literal fraction of the section's own
 *     length, with no reference to `TrackingProfile`.
 *
 * An earlier version of this file re-derived the number with a second
 * `SectionGraph` built from the same profile and calling the same three
 * helpers the gate itself calls. That is not independence: any defect in
 * corridor sizing, section ordering, or token→section ownership was reproduced
 * identically on both sides and cancelled exactly. §69.7 makes this number a
 * release blocker, so it may not share a single line of code with the gate.
 */
import type { SemanticMotionFrame, TrackingBehavior, TrackingStateV2 } from '../contracts/smooth-follow';
import type { TrackingSnapshot } from '../contracts/tracking';
import { AlignmentEngine, type EngineSession } from './engine';
import type { MovementDecisionRecord } from './decision-log';
import {
  resolveTrackingProfile,
  type PartialSmoothFollowProfile,
  type TrackingProfile,
} from './profile';
import type { SemanticAssistEvidence } from './semantic-assist';
import type { OutlineNode } from '../contracts/compiler';
import type { TrackingDocument, TranscriptEvent } from './types';

/**
 * Boundary corridor used by the *metric*, as a fraction of the enclosing
 * section's own length. Deliberately a literal: reading it from
 * `TrackingProfile` would let a profile change move the goalposts the metric
 * is supposed to hold still. It is set looser than any sane engine corridor so
 * a legal boundary crossing never trips it, while a corridor that has grown to
 * "most of the section" — the exact defect class §13 warns about — does.
 */
const METRIC_CORRIDOR_FRACTION = 0.35;

/**
 * Slack on the sentence floors below. The committed cursor lands on the last
 * token the *aligner matched*, and a sequence alignment is entitled to drop
 * trailing stopwords, so a commit that finished a sentence routinely parks a
 * token or two short of that sentence's last token. Small, literal, and about
 * tokenization rather than about §13.
 */
const METRIC_SENTENCE_SLACK_TOKENS = 3;

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
   *
   * NOTE: `SemanticFilter.applyConstraints` hard-clamps the position to exactly
   * this budget, so asserting this number against the budget compares the clamp
   * with the constants that define it — it cannot fail. `maxHoldDriftFromCommit`
   * is the assertable quantity.
   */
  maxHoldDriftUnits: number;
  /**
   * §69.8, measured independently of the filter's own clamp: how far the
   * displayed estimate ran past the last *committed* position while off script.
   * Nothing clamps the estimate to `committedUnit`, so this can fail.
   */
  maxHoldDriftFromCommit: number;
  /* Frame-contract checks (companion §26.1). */
  frameCount: number;
  framesMonotone: boolean;
  /** §26.1 — session time may never run backwards between frames. */
  framesTimeMonotone: boolean;
  framesFinite: boolean;
  maxFrameIntervalMs: number;
  /* Coverage. */
  behaviorsSeen: TrackingBehavior[];
  statesSeen: TrackingStateV2[];
  sectionsVisited: string[];
}

/**
 * One §69.7 violation, described entirely in terms the metric derived for
 * itself. `record` is attached purely so a failure is readable; nothing in the
 * detection consulted it.
 */
export interface ProhibitedJump {
  actionIndex: number;
  fromTokenIndex: number;
  toTokenIndex: number;
  fromSectionIndex: number;
  toSectionIndex: number;
  fromSectionId: string;
  toSectionId: string;
  reason: 'non_contiguous' | 'left_section_body' | 'entered_section_body';
  /** The engine's own explanation for the same action, when it emitted one. */
  record?: MovementDecisionRecord;
}

export interface PlaybackResult {
  scenarioId: string;
  metrics: PlaybackMetrics;
  /** Per-action trace, indexed by action position — the labels key off this. */
  cursorAfterAction: number[];
  /** Committed (non-provisional) cursor after each action. */
  committedAfterAction: number[];
  stateAfterAction: TrackingStateV2[];
  sectionAfterAction: string[];
  frames: SemanticMotionFrame[];
  snapshots: TrackingSnapshot[];
  records: MovementDecisionRecord[];
  /** Detail for any prohibited jump, so a failure is actionable. */
  prohibitedJumps: ProhibitedJump[];
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
  let maxHoldDriftFromCommit = 0;

  const cursorAfterAction: number[] = [];
  const committedAfterAction: number[] = [];
  const stateAfterAction: TrackingStateV2[] = [];
  const sectionAfterAction: string[] = [];
  /** Action index that produced each record, for the §69.7 correlation. */
  const recordActionIndex: number[] = [];
  let currentActionIndex = 0;

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
      recordActionIndex.push(currentActionIndex);
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
      // Against the committed position, which nothing clamps the estimate to.
      maxHoldDriftFromCommit = Math.max(
        maxHoldDriftFromCommit,
        Math.abs(unit - engine.units.unitAt(engine.cursor.committedTokenIndex)),
      );
    } else if (state === 'following' || state === 'catching_up') {
      if (offScriptSinceMs !== null && timeToReturnMs === null) {
        timeToReturnMs = atMs - offScriptSinceMs;
      }
      offScriptSinceMs = null;
    }
    // §69.4 retake latency: "first backward candidate to the committed
    // retake". Keying this off the RETAKE_PENDING *state* measured nothing —
    // the engine commits ordinary retakes straight out of UNCERTAIN, so the
    // state is often never entered and the metric stayed null however long the
    // retake took. The backward candidate is the observable §69.4 names.
    const backwardCandidate =
      engine.cursor.committedTokenIndex > 0 &&
      (engine.measurement?.bestTokenPosition ?? Infinity) < engine.cursor.committedTokenIndex;
    if ((state === 'retake_pending' || backwardCandidate) && retakePendingSinceMs === null) {
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
    currentActionIndex = actionIndex;
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
    committedAfterAction[actionIndex] = engine.cursor.committedTokenIndex;
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
    recordActionIndex,
    cursorAfterAction,
    committedAfterAction,
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
    maxHoldDriftFromCommit,
  });

  return {
    scenarioId: scenario.id,
    metrics: metrics.metrics,
    cursorAfterAction,
    committedAfterAction,
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
  recordActionIndex: number[];
  cursorAfterAction: number[];
  committedAfterAction: number[];
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
  maxHoldDriftFromCommit: number;
}

/* ---------------------------------------------------------------------------
 * §69.7 — the release blocker, derived from the document and the action stream
 * ------------------------------------------------------------------------- */

interface MetricSection {
  id: string;
  startTokenIndex: number;
  endTokenIndex: number;
  /**
   * Last token this section owns once deeper subsections have taken theirs.
   * `endTokenIndex` is widened over the whole subtree by the compiler, so for
   * a parent it names a token its child owns. Reading order is the sequence of
   * *owned* spans, and every boundary question here is about those.
   */
  ownEndTokenIndex: number;
  /**
   * The owned span is nothing but the heading line. Presenters do not read
   * headings aloud, so the cursor can never land in such a section, and §13.2
   * says an unspoken heading between two sections does not have to be spoken —
   * a `# Part Two` sitting between `## Scene B` and `## Scene C` is stepped
   * over, not jumped past.
   */
  headingOnly: boolean;
  /**
   * Last token of the section's first non-heading sentence. A commit lands
   * where an *utterance* ended, and the smallest utterance a presenter can
   * make is one sentence — so reading a short section's opening sentence
   * lands past any percentage-of-length corridor while having skipped
   * precisely nothing. Entering a section by reading its opening sentence is
   * what §13 means by entering at the start; entering three paragraphs deep
   * is not, and that still fails.
   */
  firstSentenceEndTokenIndex: number;
  /** First token of the section's last non-heading sentence — see `corridorOf`. */
  lastSentenceStartTokenIndex: number;
}

/**
 * Flatten `document.outline` into linear reading order and build a plain
 * `tokenIndex → sectionIndex` array. Written out here on purpose: it must not
 * share an implementation with `DocumentIndex`, because "which section owns
 * this token" is one of the things the metric is supposed to check the engine
 * on rather than agree with it about. The heading-only test likewise reads
 * `spokenTokens[i].blockId` directly rather than asking `DocumentIndex` which
 * block a token belongs to.
 */
function buildSectionOwnership(document: TrackingDocument): {
  sections: MetricSection[];
  ownerOf: (tokenIndex: number) => number;
} {
  const drafts: Omit<
    MetricSection,
    | 'ownEndTokenIndex'
    | 'headingOnly'
    | 'firstSentenceEndTokenIndex'
    | 'lastSentenceStartTokenIndex'
  >[] = [];
  const walk = (nodes: readonly OutlineNode[]): void => {
    for (const node of nodes) {
      drafts.push({
        id: node.id,
        startTokenIndex: node.startTokenIndex,
        endTokenIndex: node.endTokenIndex,
      });
      walk(node.children);
    }
  };
  walk(document.outline);
  drafts.sort((a, b) => a.startTokenIndex - b.startTokenIndex);

  const tokenCount = document.spokenTokens.length;
  const blockAt = (tokenIndex: number): string | undefined =>
    document.spokenTokens[Math.max(0, Math.min(tokenCount - 1, tokenIndex))]?.blockId;

  const sentencesByStart = [...document.sentences].sort(
    (a, b) => a.startTokenIndex - b.startTokenIndex,
  );

  const flat: MetricSection[] = drafts.map((draft, i) => {
    const next = drafts[i + 1];
    const ownEndTokenIndex =
      next !== undefined
        ? Math.min(draft.endTokenIndex, next.startTokenIndex - 1)
        : draft.endTokenIndex;
    const headingBlock = blockAt(draft.startTokenIndex);
    const bodySentences = sentencesByStart.filter(
      (sentence) =>
        sentence.startTokenIndex >= draft.startTokenIndex &&
        sentence.startTokenIndex <= ownEndTokenIndex &&
        blockAt(sentence.startTokenIndex) !== headingBlock,
    );
    const firstBodySentence = bodySentences[0];
    const lastBodySentence = bodySentences[bodySentences.length - 1];
    return {
      ...draft,
      ownEndTokenIndex,
      headingOnly:
        ownEndTokenIndex < draft.startTokenIndex || blockAt(ownEndTokenIndex) === headingBlock,
      firstSentenceEndTokenIndex: firstBodySentence?.endTokenIndex ?? draft.startTokenIndex,
      lastSentenceStartTokenIndex: lastBodySentence?.startTokenIndex ?? ownEndTokenIndex,
    };
  });

  const owner = new Int32Array(Math.max(0, tokenCount)).fill(-1);
  flat.forEach((section, sectionIndex) => {
    const from = Math.max(0, section.startTokenIndex);
    const to = Math.min(tokenCount - 1, section.endTokenIndex);
    for (let i = from; i <= to; i++) owner[i] = sectionIndex;
  });

  return {
    sections: flat,
    ownerOf: (tokenIndex: number): number => {
      if (tokenCount === 0) return -1;
      const clamped = Math.max(0, Math.min(tokenCount - 1, Math.floor(tokenIndex)));
      return owner[clamped] ?? -1;
    },
  };
}

/**
 * §69.7. Walks the observed committed-cursor trace and flags every movement
 * that changed section without an authority in the action stream and without
 * passing corridor-to-corridor through the shared boundary.
 */
function findProhibitedJumps(input: ReduceInput): ProhibitedJump[] {
  const { scenario } = input;
  const { sections, ownerOf } = buildSectionOwnership(scenario.document);
  if (sections.length === 0) return [];

  const recordsByAction = new Map<number, MovementDecisionRecord>();
  input.records.forEach((record, i) => {
    const actionIndex = input.recordActionIndex[i];
    if (actionIndex !== undefined && !recordsByAction.has(actionIndex)) {
      recordsByAction.set(actionIndex, record);
    }
  });

  /**
   * Corridor length for a section, as a fraction of its *owned* length, with a
   * floor of one sentence.
   *
   * The floor is a statement about this metric's resolution, not a relaxation
   * of §13. The committed cursor moves in *utterance*-sized steps, and the
   * smallest utterance a presenter can make is one sentence — so a commit that
   * skipped nothing at all still shows up here as a jump of up to a sentence
   * on each side of the boundary. An endpoint-only observer cannot distinguish
   * that from a real jump of the same size, and a pure percentage would flag
   * every correct crossing of a short section while flagging nothing extra on
   * a long one. Everything beyond a sentence is still script the presenter
   * demonstrably did not say, and still fails.
   */
  const corridorOf = (sectionIndex: number): number => {
    const section = sections[sectionIndex];
    if (section === undefined) return 0;
    const length = Math.max(1, section.ownEndTokenIndex - section.startTokenIndex + 1);
    return Math.max(
      1,
      length * METRIC_CORRIDOR_FRACTION,
      // Leaving through the boundary: the cursor may sit a whole sentence
      // short of the section end when the utterance that crosses it begins —
      // it is parked on the last token of the previous sentence, one before
      // the closing sentence starts, hence the inclusive count.
      section.ownEndTokenIndex -
        section.lastSentenceStartTokenIndex +
        1 +
        METRIC_SENTENCE_SLACK_TOKENS,
    );
  };

  /**
   * How far into a section it may be *entered*: as above, but floored by the
   * section's *opening* sentence, since reading that sentence from its first
   * word lands the cursor at its last one.
   */
  const entryCorridorOf = (sectionIndex: number): number => {
    const section = sections[sectionIndex];
    if (section === undefined) return 0;
    return Math.max(
      corridorOf(sectionIndex),
      section.firstSentenceEndTokenIndex - section.startTokenIndex + METRIC_SENTENCE_SLACK_TOKENS,
    );
  };

  /**
   * Adjacency in *reading* terms: neighbouring sections, or sections separated
   * only by heading-only ones (§13.2). Anything with a body between them is a
   * non-contiguous jump and stays a release blocker.
   */
  const readingAdjacent = (fromIndex: number, toIndex: number): boolean => {
    const low = Math.min(fromIndex, toIndex);
    const high = Math.max(fromIndex, toIndex);
    for (let i = low + 1; i < high; i++) {
      if (sections[i]?.headingOnly !== true) return false;
    }
    return true;
  };

  const jumps: ProhibitedJump[] = [];
  let previous = 0;
  // Recomputed from the action stream, never read off a record (§17.1).
  let acquired = false;

  scenario.actions.forEach((action, actionIndex) => {
    const current = input.committedAfterAction[actionIndex];
    if (current === undefined) return;
    const authoritative = action.kind === 'move' || action.kind === 'reset';
    if (authoritative) {
      acquired = action.kind !== 'reset';
      previous = current;
      return;
    }
    if (current === previous) return;

    // The first commit *is* the acquisition — there is no origin to jump from.
    if (!acquired) {
      acquired = true;
      previous = current;
      return;
    }

    const fromToken = previous;
    const fromSectionIndex = ownerOf(fromToken);
    const toSectionIndex = ownerOf(current);
    previous = current;
    if (fromSectionIndex === toSectionIndex) return;
    if (fromSectionIndex < 0 || toSectionIndex < 0) return;

    const from = sections[fromSectionIndex];
    const to = sections[toSectionIndex];
    if (from === undefined || to === undefined) return;

    const flag = (reason: ProhibitedJump['reason']): void => {
      const record = recordsByAction.get(actionIndex);
      jumps.push({
        actionIndex,
        fromTokenIndex: fromToken,
        toTokenIndex: current,
        fromSectionIndex,
        toSectionIndex,
        fromSectionId: from.id,
        toSectionId: to.id,
        reason,
        ...(record !== undefined ? { record } : {}),
      });
    };

    // (1) Adjacency: only the neighbouring section is reachable, treating a
    //     heading-only section between the two as the heading it is (§13.2).
    if (!readingAdjacent(fromSectionIndex, toSectionIndex)) {
      flag('non_contiguous');
      return;
    }
    // (2) Corridor: the move must both leave the origin near the shared
    //     boundary and enter the destination near the same shared boundary.
    const forward = toSectionIndex > fromSectionIndex;
    const leftNearBoundary = forward
      ? from.ownEndTokenIndex - fromToken <= corridorOf(fromSectionIndex)
      : fromToken - from.startTokenIndex <= corridorOf(fromSectionIndex);
    if (!leftNearBoundary) {
      flag('left_section_body');
      return;
    }
    const enteredNearBoundary = forward
      ? current - to.startTokenIndex <= entryCorridorOf(toSectionIndex)
      : to.ownEndTokenIndex - current <= entryCorridorOf(toSectionIndex);
    if (!enteredNearBoundary) flag('entered_section_body');
  });

  return jumps;
}

function reduceMetrics(input: ReduceInput): {
  metrics: PlaybackMetrics;
  prohibitedJumps: ProhibitedJump[];
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

  // §69.7 prohibited section jumps, derived from the document outline and the
  // action stream — see the module header for why nothing here may touch
  // `SectionGraph`, `DocumentIndex`, or `TrackingProfile`.
  const prohibitedJumps = findProhibitedJumps(input);

  // §69.5 / §69.6 false transitions.
  const retakes = input.records.filter((r) => r.behavior === 'retake').length;
  const skips = input.records.filter(
    (r) => r.behavior === 'large_skip' || r.behavior === 'small_skip',
  ).length;

  // Frame contract (§26.1): strictly increasing revision, all-finite numbers.
  let framesMonotone = true;
  let framesTimeMonotone = true;
  let framesFinite = true;
  let maxFrameIntervalMs = 0;
  let previous: SemanticMotionFrame | undefined;
  for (const frame of input.frames) {
    if (previous !== undefined) {
      if (frame.revision <= previous.revision) framesMonotone = false;
      if (frame.sessionTimeMs < previous.sessionTimeMs) framesTimeMonotone = false;
      maxFrameIntervalMs = Math.max(
        maxFrameIntervalMs,
        frame.sessionTimeMs - previous.sessionTimeMs,
      );
    }
    // Every numeric field, not a hand-picked six. The omitted ones were the
    // dangerous ones: a NaN `layoutGeneration` disables the stage's
    // stale-frame discard, and `sessionTimeMs`/`revision`/`epoch` drive
    // ordering.
    if (
      !Number.isFinite(frame.estimatedUnit) ||
      !Number.isFinite(frame.committedUnit) ||
      !Number.isFinite(frame.velocityUnitsPerSecond) ||
      !Number.isFinite(frame.accelerationUnitsPerSecond2) ||
      !Number.isFinite(frame.positionVariance) ||
      !Number.isFinite(frame.confidence) ||
      !Number.isFinite(frame.sessionTimeMs) ||
      !Number.isFinite(frame.revision) ||
      !Number.isFinite(frame.epoch) ||
      !Number.isFinite(frame.sessionGeneration) ||
      !Number.isFinite(frame.layoutGeneration) ||
      !Number.isFinite(frame.tokenIndex) ||
      (frame.transition !== undefined &&
        (!Number.isFinite(frame.transition.fromUnit) ||
          !Number.isFinite(frame.transition.toUnit) ||
          !Number.isFinite(frame.transition.destinationTokenIndex) ||
          !Number.isFinite(frame.transition.issuedAtMs) ||
          !Number.isFinite(frame.transition.expiresAtMs) ||
          !Number.isFinite(frame.transition.semanticEpoch)))
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
      maxHoldDriftFromCommit: input.maxHoldDriftFromCommit,
      frameCount: input.frames.length,
      framesMonotone,
      framesTimeMonotone,
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
          .map(
            (jump) =>
              `action ${jump.actionIndex}: ${jump.fromSectionId}@${jump.fromTokenIndex}` +
              `→${jump.toSectionId}@${jump.toTokenIndex} (${jump.reason}` +
              `${jump.record !== undefined ? `, engine called it ${jump.record.behavior}/${jump.record.authority}` : ''})`,
          )
          .join(', '),
    );
  }
  if (!metrics.framesMonotone) failures.push('frame revisions are not strictly increasing');
  if (!metrics.framesTimeMonotone) failures.push('frame session time ran backwards');
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
