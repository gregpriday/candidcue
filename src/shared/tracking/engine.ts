/**
 * Deterministic script alignment engine (spec §31, Appendix G.1–G.5) plus the
 * companion specification's alignment v2 layer (§10–§26, §50–§56).
 *
 * Owns the transcript ledger projection, candidate scoring, the alignment
 * state machine, retake/skip logic, manual correction, and snapshot
 * emission. Pure and deterministic: all time comes from event timestamps or
 * explicit `nowMs` arguments — never from wall-clock reads.
 *
 * ## How v1 and v2 relate
 *
 * v1's committing decision layer (`decideTransition`, the retake heuristic,
 * the provisional policy, the thresholds in `TrackingProfile`) is *retained*:
 * it still decides what `committedTokenIndex` becomes, and it still emits the
 * `TrackingSnapshot` the control Live screen renders. v2 wraps it:
 *
 *   - `HypothesisBeam` performs the one scoring pass and hands back both the
 *     v1-shaped candidate list and a multi-hypothesis measurement (§10–§16);
 *   - `SectionGraph` removes ineligible candidates *before* the decision layer
 *     sees them, so the prohibited-jump invariant holds for the real cursor
 *     and not merely for a parallel estimate (§13, §69.7);
 *   - `SemanticFilter` + `PaceEstimatorV2` turn the discrete decision into the
 *     continuous spoken-unit trajectory the stage follows (§24–§25);
 *   - `SemanticFrameEmitter` + `TransitionDirectiveManager` publish that
 *     trajectory as `SemanticMotionFrame`s and bounded discontinuities (§26.1,
 *     §53);
 *   - `MovementDecisionLog` records why each movement happened (§65).
 */
import type {
  SemanticMotionFrame,
  SmoothFollowProfile,
  StageTransitionDirective,
  TrackingBehavior,
  TrackingStateV2,
} from '../contracts/smooth-follow';
import type { TrackingSnapshot, TrackingState } from '../contracts/tracking';
import {
  HypothesisBeam,
  type AlignmentMeasurement,
  type CorrectionClass,
} from './alignment-v2';
import { isReturnToScript, projectBehavior } from './behavior';
import { generateCandidates } from './candidates';
import { MovementDecisionLog, type MovementDecisionRecord } from './decision-log';
import { DocumentIndex } from './document-index';
import { TranscriptLedger, type AlignableTail } from './ledger';
import {
  directiveTypeFor,
  SemanticFrameEmitter,
  TransitionDirectiveManager,
} from './motion-frame';
import { PaceEstimatorV2, type PaceSampleRejection } from './pace-estimator';
import {
  resolveSmoothFollowProfile,
  resolveTrackingProfile,
  type PartialSmoothFollowProfile,
  type TrackingProfile,
} from './profile';
import { scaleToSection } from './scales';
import { SectionGraph, type SectionTransitionContext, type TransitionAuthority } from './section-graph';
import type { SemanticAssistEvidence } from './semantic-assist';
import { buildSchedulingContext } from './semantic-context';
import type { AssistSchedulingContext } from '../semantic/types';
import { SemanticFilter } from './semantic-filter';
import { SpeechUnitScale } from './speech-units';
import { VisitedSpanRing } from './visited';
import type {
  AlignmentCheckpoint,
  AlignmentDecision,
  AlignmentDiagnostic,
  MovementKind,
  ScoredCandidate,
  TrackingDocument,
  TranscriptEvent,
} from './types';

export interface EngineSession {
  sessionId: string;
  sessionGeneration: number;
  stageGeneration: number;
  /** Layout generation the stage last reported (companion §7.2). */
  layoutGeneration?: number;
}

export interface EngineOutput {
  snapshot?: TrackingSnapshot;
  diagnostic?: AlignmentDiagnostic;
  stateChanged?: TrackingState;
  /** Companion §26.1 — emitted alongside every snapshot and on `tick`. */
  frame?: SemanticMotionFrame;
  /** Companion §65 — present only for nontrivial movement transitions. */
  decision?: MovementDecisionRecord;
  /**
   * Companion §37.1 — the post-section-gate candidate set plus the state the
   * Luna sidecar schedules against. Rate-limited by
   * `profile.semanticContextIntervalMs`; absent on most events by design.
   */
  semanticContext?: AssistSchedulingContext;
}

/** Explicit retake lead-in phrases (G.5 `transcriptContainsRetakeLeadIn`). */
const RETAKE_LEAD_INS = [
  'try that again',
  'take that again',
  'start that over',
  'start over',
  'one more time',
  'from the top',
  'let me redo',
];

const MAX_CHECKPOINTS = 12;
/**
 * How far apart two candidates must be to count as *different readings* rather
 * than two descriptions of the same one (§31.13, §23.2). Anything closer is the
 * same place seen through two windows, and the margin between them says nothing.
 */
const MATERIALLY_SEPARATE_TOKENS = 10;
const RETAKE_SUPPORT_REQUIRED = 2;
const RETAKE_POSITION_TOLERANCE = 6;
/** Prune `maskedItemIds` against the ledger once it grows past this (§30.3). */
const MASK_PRUNE_THRESHOLD = 32;

export class AlignmentEngine {
  readonly profile: TrackingProfile;
  readonly smoothProfile: SmoothFollowProfile;
  readonly ledger: TranscriptLedger;
  readonly index: DocumentIndex;
  /* --- alignment v2 collaborators (companion §50.1) ------------------- */
  readonly units: SpeechUnitScale;
  readonly sectionGraph: SectionGraph;
  readonly beam: HypothesisBeam;
  readonly filter: SemanticFilter;
  readonly paceEstimator: PaceEstimatorV2;
  readonly decisions: MovementDecisionLog;
  private readonly frames: SemanticFrameEmitter;
  private readonly directives: TransitionDirectiveManager;
  private readonly session: EngineSession;
  private readonly scriptId: string;
  private readonly scriptCompileHash: string;

  private state: TrackingState = 'following';
  private stateBeforePause: TrackingState = 'following';
  private committedTokenIndex = 0;
  private provisionalTokenIndex = 0;
  private lastConfidence = 0;
  private lastMovement: MovementKind = 'hold';
  private provisional = false;
  private revision = 0;
  private lastSourceItemIds: string[] = [];

  private lastConfidentAtMs = 0;
  private contentTokensSinceConfident = 0;
  private lastCountedFinalItem = '';
  private manualGraceUntilMs = 0;

  private checkpoints: AlignmentCheckpoint[] = [];
  /** Block-start indexes whose openings the cursor has passed (for G.5). */
  private passedBlockStarts = new Set<number>();
  private pendingRetake: { position: number; supports: number } | undefined;
  private maskedItemIds = new Set<string>();
  private commandPending = false;
  /** Session time the current COMMAND_PENDING freeze began (§33.4.4). */
  private commandPendingSinceMs = 0;

  /* --- v2 state ------------------------------------------------------- */
  /** False until the first committed lock — acquisition is not a jump (§17.1). */
  private acquired = false;
  /** True for the single decision that performed the first lock (§17.1). */
  private justAcquired = false;
  /** Semantic epoch; incremented by command/manual navigation and retakes. */
  private epoch = 0;
  private layoutGeneration: number;
  private stateV2: TrackingStateV2 = 'acquiring';
  private behavior: TrackingBehavior = 'acquire';
  private lastMeasurement: AlignmentMeasurement | undefined;
  private lastCorrection: CorrectionClass = 'none';
  /** Session time of the most recent section-boundary crossing (§13). */
  private boundaryCrossedAtMs = -Infinity;
  /** Items whose delayed completions must not undo a retake (§21.4). */
  private staleAfterRetake = new Set<string>();
  private preRetakeHighWaterMark = 0;
  /**
   * Spans the committed cursor has actually travelled through, newest last
   * (§14.4). Feeds §21.1's "the destination was visited recently", which the
   * engine previously had no way to express — `previouslyPassed` is true of
   * every token behind the cursor regardless of when, or whether, it was read.
   */
  private readonly visited: VisitedSpanRing;
  private lastEventAtMs = 0;
  /** Audio span of the last final item, for pace samples (§24.3). */
  private lastPaceSpan: { tokenIndex: number; atMs: number } | undefined;
  /** The next pace span begins immediately after command speech (§24.4). */
  private paceSpanAfterCommand = false;
  /** Why the last pace span was discarded, for diagnostics (§64). */
  private lastPaceRejection: PaceSampleRejection | undefined;
  private offScript = false;
  private lastFrameTransitionId: string | undefined;
  /* --- semantic sidecar feed (companion §37.1) -------------------------- */
  /** Session time the last scheduling context was emitted (0 = never). */
  private lastSemanticContextAtMs = -Infinity;
  /** Meaningful FINAL tokens observed since that emission (§36.2). */
  private finalTokensSinceContext = 0;
  /** Dedupe guard so a repeated completion cannot inflate the count. */
  private lastContextCountedItem = '';
  /** Session time local confidence last sat at or above `lockedThreshold`. */
  private confidentSinceMs = 0;
  /** Authority of the emission in flight; only `moveTo` raises this (§56.1). */
  private emitAuthority: TransitionAuthority = 'ordinary';
  /** Committed position before the decision currently being emitted (§65). */
  private movedFromTokenIndex = 0;

  constructor(
    document: TrackingDocument,
    session: EngineSession,
    profile?: Partial<TrackingProfile>,
    smoothProfile?: PartialSmoothFollowProfile,
  ) {
    this.profile = resolveTrackingProfile(profile);
    this.smoothProfile = resolveSmoothFollowProfile(smoothProfile);
    this.index = new DocumentIndex(document, { rareWeight: this.profile.rareWeight });
    this.ledger = new TranscriptLedger();
    this.ledger.setSessionGeneration(session.sessionGeneration);
    this.session = session;
    this.scriptId = document.scriptId;
    this.scriptCompileHash = document.scriptCompileHash ?? document.scriptId;
    this.layoutGeneration = session.layoutGeneration ?? 0;

    this.units = new SpeechUnitScale(document, this.profile);
    this.sectionGraph = new SectionGraph(this.index, this.profile);
    this.beam = new HypothesisBeam(
      this.index,
      this.sectionGraph,
      this.units,
      this.profile,
      this.smoothProfile,
    );
    this.filter = new SemanticFilter(this.profile, this.smoothProfile);
    this.paceEstimator = new PaceEstimatorV2(this.profile);
    this.decisions = new MovementDecisionLog(this.profile.decisionLogCapacity);
    this.frames = new SemanticFrameEmitter(this.profile, this.smoothProfile);
    this.directives = new TransitionDirectiveManager(this.profile);
    this.visited = new VisitedSpanRing(this.profile.visitedSpanCapacity);
    this.applySectionBounds();
  }

  get trackingState(): TrackingState {
    return this.state;
  }

  get cursor(): { tokenIndex: number; committedTokenIndex: number } {
    return {
      tokenIndex: this.provisionalTokenIndex,
      committedTokenIndex: this.committedTokenIndex,
    };
  }

  /* -------------------------------------------------------------------------
   * External control (G.1 surroundings, §31.15, §45.4 messages).
   * ----------------------------------------------------------------------- */

  /** Mask command items out of alignment (spec §33.4 step 5). */
  maskItems(itemIds: readonly string[]): void {
    for (const id of itemIds) this.maskedItemIds.add(id);
    this.ledger.setCommandDisposition(itemIds, 'command');
    // The set is consulted on every alignment pass and was otherwise monotonic
    // for the life of the session, long after the ledger's 180 s horizon had
    // dropped the items themselves.
    if (this.maskedItemIds.size > MASK_PRUNE_THRESHOLD) this.pruneMaskedItems();
    // §24.4: the masked audio is command speech, not reading. The span that
    // straddles it must not become a pace sample — it would measure "script
    // units covered" against a duration that includes the command utterance
    // and halve the estimated pace, which then drives `observeVelocity` and
    // the beam's predict-forward.
    this.invalidatePaceSpan();
  }

  /** Release items whose command detection failed (spec §33.4 tail). */
  releaseItems(itemIds: readonly string[]): void {
    for (const id of itemIds) this.maskedItemIds.delete(id);
    this.ledger.setCommandDisposition(itemIds, 'script');
    this.pruneMaskedItems();
  }

  /**
   * Drop masked ids the ledger has already aged out past its rolling horizon
   * (§30.3). The set is consulted on every alignment pass and is otherwise
   * monotonic for the life of the session.
   */
  private pruneMaskedItems(): void {
    if (this.maskedItemIds.size === 0) return;
    for (const id of [...this.maskedItemIds]) {
      if (this.ledger.getItem(id) === undefined) this.maskedItemIds.delete(id);
    }
  }

  /**
   * §24.4: flag the span currently open as command-contaminated. The anchor is
   * deliberately *not* cleared — `observeCommittedPosition` advances it even
   * for a rejected sample, so the next clean span is still measured from the
   * right place, which is the policy the estimator documents.
   */
  private invalidatePaceSpan(): void {
    this.paceSpanAfterCommand = true;
  }

  setCommandPending(pending: boolean, nowMs: number): EngineOutput {
    const wasPending = this.commandPending;
    this.commandPending = pending;
    if (pending) {
      if (!wasPending) this.commandPendingSinceMs = nowMs;
      if (this.state !== 'command_pending') {
        this.stateBeforePause = this.state;
        this.state = 'command_pending';
        return this.emit('command', nowMs, 'command_pending');
      }
    } else {
      // §24.4: whatever was spoken during the freeze was command speech, so
      // the span crossing it is not a reading-rate sample.
      if (wasPending) this.invalidatePaceSpan();
      if (this.state === 'command_pending') {
        this.state =
          this.stateBeforePause === 'command_pending' ? 'following' : this.stateBeforePause;
        return this.emit('hold', nowMs, 'command_resolved');
      }
    }
    return {};
  }

  /**
   * §33.4.4 / §33.11: COMMAND_PENDING is a *freeze*. `handleTranscriptEvent`
   * returns nothing while it is set and `command_pending` is an identity state
   * for the filter, so nothing integrates and the teleprompter simply stops.
   * Whoever set it is supposed to clear it — but a Luna handoff that never
   * returns, or an IPC call with no timeout, means nobody ever does, and the
   * take is over.
   *
   * The freeze is therefore bounded here, by construction, rather than trusted
   * to the caller: past `commandPendingTimeoutMs` the engine releases itself.
   * A late `setCommandPending(false)` is then a harmless no-op.
   */
  private expireCommandPending(nowMs: number): EngineOutput | undefined {
    if (!this.commandPending) return undefined;
    if (nowMs - this.commandPendingSinceMs <= this.profile.commandPendingTimeoutMs) {
      return undefined;
    }
    return this.setCommandPending(false, nowMs);
  }

  pause(nowMs: number): EngineOutput {
    if (this.state === 'paused') return {};
    this.stateBeforePause = this.state;
    this.state = 'paused';
    return this.emit('hold', nowMs, 'paused');
  }

  resume(nowMs: number): EngineOutput {
    if (this.state !== 'paused' && this.state !== 'reconnecting') return {};
    this.state = 'following';
    this.lastConfidentAtMs = nowMs;
    this.contentTokensSinceConfident = 0;
    return this.emit('hold', nowMs, 'resumed');
  }

  setReconnecting(nowMs: number): EngineOutput {
    this.state = 'reconnecting';
    return this.emit('hold', nowMs, 'reconnecting');
  }

  /**
   * Manual or command-driven correction (spec §31.15): immediate authority,
   * new checkpoint, cleared uncertain evidence, backward-correction grace.
   */
  moveTo(tokenIndex: number, movement: 'manual' | 'command', nowMs: number): EngineOutput {
    const target = this.index.clampTokenIndex(tokenIndex);
    const previousCommitted = this.committedTokenIndex;
    this.committedTokenIndex = target;
    this.provisionalTokenIndex = target;
    this.provisional = false;
    this.lastConfidence = 1;
    this.pendingRetake = undefined;
    this.contentTokensSinceConfident = 0;
    this.lastConfidentAtMs = nowMs;
    this.manualGraceUntilMs = nowMs + this.profile.manualCorrectionGraceMs;
    this.state = this.state === 'paused' ? 'paused' : 'following';
    this.pushCheckpoint(target, nowMs, movement === 'manual' ? 'manual' : 'command');
    this.emitAuthority = movement === 'manual' ? 'manual' : 'command';
    this.movedFromTokenIndex = previousCommitted;
    this.visited.record(target, target, nowMs);

    // Companion §56.1: authority increments the semantic epoch, clears the
    // ordinary hypotheses, resets section eligibility to the target, resets
    // the filter around it, and masks the command speech from pace.
    this.epoch++;
    this.acquired = true;
    this.justAcquired = false;
    this.offScript = false;
    this.staleAfterRetake.clear();
    this.beam.seedAuthoritative(target, movement === 'command' ? 'command' : 'manual', nowMs);
    this.applySectionBounds();
    this.paceEstimator.reset();
    this.lastPaceSpan = { tokenIndex: target, atMs: nowMs };
    this.lastCorrection = 'none';
    this.filter.resetTo(this.units.unitAt(target), nowMs, this.epoch, 'following');
    this.boundaryCrossedAtMs = -Infinity;
    return this.emit(movement, nowMs, `${movement}_move`);
  }

  /** Reset to the top of the script (session restart). */
  reset(nowMs: number): EngineOutput {
    this.committedTokenIndex = 0;
    this.provisionalTokenIndex = 0;
    this.provisional = false;
    this.lastConfidence = 0;
    this.state = 'following';
    this.pendingRetake = undefined;
    this.checkpoints = [];
    this.passedBlockStarts.clear();
    this.maskedItemIds.clear();
    this.contentTokensSinceConfident = 0;
    this.lastConfidentAtMs = nowMs;

    // v2: a session reset is an authorized discontinuity of its own (§53).
    this.epoch++;
    this.acquired = false;
    this.justAcquired = false;
    this.offScript = false;
    this.staleAfterRetake.clear();
    this.preRetakeHighWaterMark = 0;
    this.visited.clear();
    this.boundaryCrossedAtMs = -Infinity;
    this.lastMeasurement = undefined;
    this.lastCorrection = 'none';
    this.lastPaceSpan = undefined;
    // A reset invalidates the sidecar's whole view; nothing carries over.
    this.lastSemanticContextAtMs = -Infinity;
    this.finalTokensSinceContext = 0;
    this.lastContextCountedItem = '';
    this.confidentSinceMs = nowMs;
    this.beam.clear();
    this.paceEstimator.reset();
    this.decisions.clear();
    this.directives.clear();
    this.frames.reset();
    this.filter.resetTo(0, nowMs, this.epoch, 'acquiring');
    this.applySectionBounds();
    this.emitAuthority = 'manual';
    this.movedFromTokenIndex = 0;
    this.directives.issue({
      type: 'reset',
      authority: 'manual',
      reason: 'session_reset',
      fromUnit: 0,
      toUnit: 0,
      destinationTokenIndex: 0,
      issuedAtMs: nowMs,
      semanticEpoch: this.epoch,
    });
    return this.emit('manual', nowMs, 'reset');
  }

  /* -------------------------------------------------------------------------
   * Transcript processing (G.1).
   * ----------------------------------------------------------------------- */

  handleTranscriptEvent(event: TranscriptEvent): EngineOutput {
    const update = this.ledger.apply(event);
    if (this.state === 'paused' || this.state === 'reconnecting') return {};
    if (update === undefined) return {};
    if (update.sessionGeneration !== this.session.sessionGeneration) return {};
    // §26.1: `sessionTimeMs` must never go backwards. `tick` guards against
    // earlier ticks, but transcript events also advance session time, so
    // without this a tick timestamped before the last transcript event emits a
    // frame whose clock has run backwards.
    this.lastEventAtMs = Math.max(this.lastEventAtMs, update.receivedAtMs);
    if (this.commandPending) {
      const released = this.expireCommandPending(update.receivedAtMs);
      if (released === undefined) return {};
      return released;
    }

    const nowMs = update.receivedAtMs;
    const tail = this.ledger.getAlignableTail({
      maxTokens: this.profile.recentTranscriptMaxTokens,
      excludeItemIds: this.maskedItemIds,
    });

    const contentCount = tail.tokens.reduce((sum, t) => sum + (t.content ? 1 : 0), 0);
    if (contentCount === 0) {
      // Pure filler/hesitation: never evidence for or against (spec §30.6).
      return {};
    }

    // §30.7 out-of-order arrival. Finality has to be true of *both* the event
    // that woke the pass and the evidence the pass will actually align:
    //
    //   `update.final` alone — the old behaviour — let a late completion for
    //   an *older* item mark the whole pass final while the tail's newest
    //   tokens were still provisional. Everything gated on finality (retake
    //   commits, large-skip commits, `filterMeasurementNoiseFinal`, and above
    //   all `authorizedDiscontinuity`, which now re-anchors the filter
    //   outright) then fired on majority-provisional evidence.
    //
    //   `tail.final` alone is not enough either: an event that carries no
    //   tokens at all (`item_started`, a transport frame) leaves the tail
    //   entirely final, so the pass would re-commit already-consumed evidence
    //   and log a zero-distance pace span across the silence before it.
    const final = update.final && tail.final;
    this.countFinalTokens(update.itemId, update.final);
    const decision = this.align(tail, final, nowMs);
    const output = this.applyDecision(decision, tail, final, nowMs);
    const context = this.maybeBuildSemanticContext(tail, update.final, nowMs);
    if (context !== undefined) output.semanticContext = context;
    return output;
  }

  /* -------------------------------------------------------------------------
   * Semantic sidecar feed (companion §37.1, §40.2, §51 step 6).
   * ----------------------------------------------------------------------- */

  /** Meaningful FINAL tokens seen since the last emitted context (§36.2). */
  private countFinalTokens(itemId: string, final: boolean): void {
    if (!final || itemId === this.lastContextCountedItem) return;
    this.lastContextCountedItem = itemId;
    const item = this.ledger.getItem(itemId);
    if (item === undefined) return;
    for (const token of item.normalizedTokens) {
      if (token.content) this.finalTokensSinceContext++;
    }
  }

  /**
   * Build the sidecar's scheduling context — the candidate set plus everything
   * `SemanticAssistScheduler` decides against.
   *
   * Cadence (companion §36.3, §63): explicitly throttled to
   * `profile.semanticContextIntervalMs` (2 Hz by default) AND restricted to
   * finalized evidence. Provisional deltas carry no new final tokens, so the
   * scheduler's own `hasMinimumUsefulInput` gate would reject them anyway —
   * building a candidate list for them would be pure per-event cost on a budget
   * (~19 ms/event) that has no headroom. What remains on the hot path is one
   * subtraction and one comparison.
   *
   * The candidates come from `lastMeasurement`, which the beam fills from its
   * post-eligibility-gate list, so a prohibited candidate is never offered.
   */
  private maybeBuildSemanticContext(
    tail: AlignableTail,
    final: boolean,
    nowMs: number,
  ): AssistSchedulingContext | undefined {
    const interval = this.profile.semanticContextIntervalMs;
    if (interval <= 0 || !final) return undefined;
    if (nowMs - this.lastSemanticContextAtMs < interval) return undefined;
    const measurement = this.lastMeasurement;
    if (measurement === undefined) return undefined;

    const newFinalTokenCount = this.finalTokensSinceContext;
    this.finalTokensSinceContext = 0;
    this.lastSemanticContextAtMs = nowMs;

    if (this.lastConfidence >= this.profile.lockedThreshold) this.confidentSinceMs = nowMs;
    const directive = this.directives.active(nowMs);

    return buildSchedulingContext({
      index: this.index,
      measurement,
      // The tail exactly as the beam aligned it: `MatchedPair.transcriptIndex`
      // indexes this array, so it is passed whole and unfiltered.
      transcriptTail: tail.tokens,
      itemTiming: (itemId) => {
        const item = this.ledger.getItem(itemId);
        if (item === undefined) return undefined;
        return {
          audioStartMs: item.audioStartMs,
          audioEndMs: item.audioEndMs,
          commitSequence: item.commitSequence,
          tokenCount: item.normalizedTokens.length,
        };
      },
      committedTokenIndex: this.committedTokenIndex,
      largeForwardDistance: this.largeForwardDistance(),
      softThreshold: this.profile.softThreshold,
      lockedThreshold: this.profile.lockedThreshold,
      sessionId: this.session.sessionId,
      sessionGeneration: this.session.sessionGeneration,
      scriptCompileHash: this.scriptCompileHash,
      semanticEpoch: this.epoch,
      transcriptRevision: this.revision,
      sessionTimeMs: nowMs,
      trackingState: this.stateV2,
      behavior: this.behavior,
      recentFinalTranscript: joinSurfaces(tail, true),
      provisionalTail: joinSurfaces(tail, false),
      newFinalTokenCount,
      atPhraseBoundary: final,
      commandPending: this.commandPending,
      sessionPaused: this.state === 'paused',
      reanchorActive: directive?.type === 'reanchor',
      localConfidence: measurement.confidence,
      sustainedAmbiguityMs: Math.max(0, nowMs - this.confidentSinceMs),
      lexicalFailureMs: Math.max(0, nowMs - this.lastConfidentAtMs),
    });
  }

  /* -------------------------------------------------------------------------
   * Core alignment (G.3/G.4).
   * ----------------------------------------------------------------------- */

  private align(tail: AlignableTail, final: boolean, nowMs: number): AlignmentDecision {
    const profile = this.profile;
    const windows = generateCandidates(
      this.index,
      {
        committedTokenIndex: this.committedTokenIndex,
        transcriptTail: tail.tokens,
        checkpoints: this.checkpoints,
        globalSearch: this.state === 'searching',
      },
      profile,
    );

    // One scoring pass for both layers. The beam scores every window, applies
    // the hard section gate (§13 — ineligible candidates receive *zero*
    // probability and never reach the decision layer), folds in bounded
    // semantic evidence, and returns the v1-shaped candidate list plus the
    // multi-hypothesis measurement.
    const measurement = this.beam.advance({
      tail,
      windows,
      committedTokenIndex: this.committedTokenIndex,
      cursorTokenIndex: this.provisionalTokenIndex,
      eligibility: this.eligibilityContext(nowMs),
      finalEvidence: final,
      sessionTimeMs: nowMs,
      paceUnitsPerSecond: this.paceEstimator.estimate(nowMs).blendedUnitsPerSecond,
      predictedUnit: this.filter.predict(nowMs).positionUnits,
      epoch: this.epoch,
      state: this.state,
      msSinceConfident: nowMs - this.lastConfidentAtMs,
      largeForwardDistance: this.largeForwardDistance(),
      repeatedOpening: (position) => this.matchesPreviouslyReadOpening(position, tail),
    });
    this.lastMeasurement = measurement;
    this.lastCorrection = measurement.transitionProposal.kind;

    const scored = measurement.candidates;
    const best = scored[0];
    if (best === undefined) return this.holdDecision('no_candidate', scored, 0);

    // Margin against the best candidate at a materially different position
    // (§31.13 — repeated passages must freeze, not guess).
    let margin = 1;
    for (let k = 1; k < scored.length; k++) {
      const other = scored[k];
      if (other === undefined) continue;
      if (
        Math.abs(other.absolutePosition - best.absolutePosition) > MATERIALLY_SEPARATE_TOKENS
      ) {
        margin = best.confidence - other.confidence;
        break;
      }
    }

    return this.decideTransition(best, margin, scored, tail, final, nowMs);
  }

  /* -------------------------------------------------------------------------
   * Section eligibility (companion §13, B.2) — the hard invariant.
   * ----------------------------------------------------------------------- */

  /**
   * The context the section graph gates every candidate with. Ordinary
   * authority is the default; command/manual authority is applied by
   * `moveTo`, which re-seeds the beam and resets eligibility around the
   * destination (§12.6, §56.1) rather than leaving a standing exemption.
   */
  private eligibilityContext(nowMs: number): SectionTransitionContext {
    return {
      authority: 'ordinary',
      acquired: this.acquired,
      recentlyCrossedBoundary: nowMs - this.boundaryCrossedAtMs <= this.profile.recentBoundaryCrossingMs,
      // §21.2: a backward boundary edge needs retake-grade evidence, which the
      // engine only has once a retake candidate has begun accumulating.
      retakeEvidenceStrong:
        this.state === 'retake_candidate' || (this.pendingRetake?.supports ?? 0) > 0,
    };
  }

  /**
   * `largeForwardDistance`, clamped to a fraction of the enclosing section
   * (`scales.ts`). The absolute 40 is two thirds of a 62-token chapter, which
   * makes `updateOffScript`'s `nearCursor` test true for essentially the whole
   * section — so `offScript`, and with it `adlib_hold` vs `lost_local` and
   * pace-contamination flagging, ends up decided by confidence alone.
   */
  private largeForwardDistance(tokenIndex = this.committedTokenIndex): number {
    return scaleToSection(
      this.index,
      tokenIndex,
      this.profile.largeForwardDistance,
      this.profile.largeForwardMaxFraction,
    );
  }

  /**
   * §31.8 bounded provisional advance, clamped to a fraction of the enclosing
   * section. The absolute 18 exceeds the whole 14-token boundary corridor, so
   * provisional evidence could advance further than the corridor it is
   * forbidden to cross.
   *
   * Scaling this to the *sentence* was tried and reverted: sentences here run
   * ~10 tokens, so any useful fraction collapses the provisional advance to
   * 2–3 tokens, the cursor stops leading the reader between completions, and
   * D.1's "the estimate never moves backward" invariant breaks as the display
   * lead repeatedly builds and decays. Section-relative is the right structure
   * for this one.
   */
  private maxProvisionalAdvance(): number {
    return scaleToSection(
      this.index,
      this.committedTokenIndex,
      this.profile.maxProvisionalAdvanceTokens,
      this.profile.provisionalAdvanceMaxFraction,
    );
  }

  /** Keep the filter's prediction inside the current section (§24.2.1). */
  private applySectionBounds(): void {
    const section = this.sectionGraph.sectionAt(this.committedTokenIndex);
    if (section === undefined) {
      this.filter.setSectionBounds(Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY);
      return;
    }
    this.filter.setSectionBounds(
      this.units.unitAt(section.startTokenIndex),
      this.units.unitAt(Math.min(section.endTokenIndex + 1, this.index.tokenCount)),
    );
  }

  /**
   * §21.4 / §25.7: a delayed completion belonging entirely to the utterance
   * that preceded a committed retake must not pull the cursor back forward
   * past the pre-retake high-water mark.
   */
  private isStalePostRetakeEvidence(target: number, tail: AlignableTail): boolean {
    if (this.staleAfterRetake.size === 0) return false;
    if (target <= this.preRetakeHighWaterMark) return false;
    if (tail.itemIds.length === 0) return false;
    return tail.itemIds.every((id) => this.staleAfterRetake.has(id));
  }

  /** G.4 transition decision. */
  private decideTransition(
    best: ScoredCandidate,
    margin: number,
    all: ScoredCandidate[],
    tail: AlignableTail,
    final: boolean,
    nowMs: number,
  ): AlignmentDecision {
    const profile = this.profile;
    const distance = best.absolutePosition - this.committedTokenIndex;
    const isBackward = distance < 0;
    const isLargeForward = distance > this.largeForwardDistance();

    // §21.4 retake lock: reject stale evidence from the superseded take.
    if (distance > 0 && this.isStalePostRetakeEvidence(best.absolutePosition, tail)) {
      return this.holdDecision('stale_pre_retake_evidence', all, margin);
    }

    if (!final) {
      if (best.confidence < profile.softThreshold) {
        return this.holdDecision('weak_partial', all, margin);
      }
      if (isBackward) return this.holdDecision('partial_backward_forbidden', all, margin);
      if (isLargeForward) return this.holdDecision('partial_large_jump_forbidden', all, margin);
      return this.provisionalAdvance(best, margin);
    }

    if (isBackward) {
      if (nowMs < this.manualGraceUntilMs) {
        // §31.15: suppress automatic backward correction during grace.
        return this.holdDecision('manual_grace_backward_suppressed', all, margin);
      }
      // §31.14: during global search a strongly anchored backward candidate
      // may win without the retake heuristic (the user jumped back).
      if (
        this.state === 'searching' &&
        best.confidence >= profile.globalThreshold &&
        best.sequence.rareAnchorMatches >= profile.minimumGlobalAnchorCount &&
        best.sequence.contentMatches >= profile.minimumBackwardContentMatches &&
        margin >= profile.minimumBackwardMargin
      ) {
        return this.commitDecision(best, 'retake', margin);
      }
      if (!this.looksLikeRetake(best, tail, nowMs)) {
        return this.holdDecision('backward_not_retake', all, margin);
      }
      const threshold = this.backwardThreshold(-distance);
      if (
        best.confidence < threshold ||
        !this.challengerHasPersisted() ||
        best.sequence.contentMatches < profile.minimumBackwardContentMatches ||
        margin < profile.minimumBackwardMargin
      ) {
        return this.retakeCandidateDecision(best, margin);
      }
      return this.commitDecision(best, 'retake', margin);
    }

    // §31.13/§23.2: two well-separated candidates nearly tied. The policy is a
    // *preference order*, not a stop — see `resolveAmbiguity`.
    if (margin < profile.ambiguityMargin && best.confidence >= profile.softThreshold) {
      const resolved = this.resolveAmbiguity(best, all, tail);
      if (resolved === undefined) {
        // §23.2 "reduce motion and hold if ambiguity is material": nothing in
        // the tied set continues the reading, so every reading of this evidence
        // is a jump, and a repeated phrase may never trigger one.
        return this.holdDecision('ambiguous_candidates', all, margin);
      }
      return this.decideForward(resolved.candidate, resolved.margin, all);
    }

    return this.decideForward(best, margin, all);
  }

  /**
   * The §23.2 ambiguity policy: *what to do* when two eligible candidates are
   * too close to separate on text alone.
   *
   * The engine used to hold here unconditionally, which is only half of §23.2 —
   * the half that says "reduce motion and hold if ambiguity is material". An
   * exact duplicate phrase is never separable on text, by construction, so that
   * hold never ends: the presenter reads a refrain, the near copy and the copy
   * two hundred tokens back score identically, and the engine sits at the
   * ambiguity margin until it degrades to `searching` — which per Appendix E
   * does not widen across sections, so the only way out was manual navigation,
   * live. §23.2 states the missing half first: **prefer continuity**.
   *
   * The order implemented here is §23.2's own, read as a filter followed by
   * tie-breaks:
   *
   *   1. *Prefer continuity* — as a hard filter, not a nudge. Only a candidate
   *      whose matched span **begins within ordinary reading reach of where the
   *      cursor already is**, and which does not move backward, may win an
   *      ambiguity. That is also the last clause of §23.2 enforced positively:
   *      a tie can never authorize a large jump, because nothing far enough
   *      away to *be* a jump is eligible to win one.
   *   2. *Prefer the current retake epoch* — evidence belonging to a superseded
   *      take loses to evidence that does not (§21.4).
   *   3. *Prefer candidates supported by surrounding content* — more matched
   *      content, then the longer ordered run: the reading the rest of the tail
   *      agrees with.
   *   4. Minimal motion, then confidence, as final tie-breaks — of two readings
   *      that continue the script equally well, the nearer one moves the stage
   *      least.
   *
   * Returns `undefined` when no tied candidate passes the continuity filter,
   * which is the genuinely material ambiguity §23.2 asks the engine to hold on.
   *
   * The reach is `largeForwardDistance()` — already section-relative through
   * `scales.ts`, so "ordinary reading reach" means the same thing on a 40-word
   * clip as on a 4,000-word keynote.
   */
  private resolveAmbiguity(
    best: ScoredCandidate,
    all: readonly ScoredCandidate[],
    tail: AlignableTail,
  ): { candidate: ScoredCandidate; margin: number } | undefined {
    const profile = this.profile;
    const cursor = this.committedTokenIndex;
    const reach = this.largeForwardDistance();

    // `all` is sorted by confidence descending, so everything indistinguishable
    // from the leader is a prefix of it.
    let tiedCount = 0;
    while (tiedCount < all.length) {
      const candidate = all[tiedCount];
      if (candidate === undefined) break;
      if (best.confidence - candidate.confidence >= profile.ambiguityMargin) break;
      tiedCount++;
    }

    const spanStart = (candidate: ScoredCandidate): number =>
      this.index.clampTokenIndex(
        candidate.window.startTokenIndex + candidate.sequence.scriptStartOffset,
      );

    // 1. Continuity, as a filter.
    const continuous: ScoredCandidate[] = [];
    for (let i = 0; i < tiedCount; i++) {
      const candidate = all[i];
      if (candidate === undefined) continue;
      if (candidate.absolutePosition < cursor) continue; // never backward
      if (spanStart(candidate) - cursor > reach) continue; // began too far ahead
      continuous.push(candidate);
    }
    let winner = continuous[0];
    if (winner === undefined) return undefined;

    for (const candidate of continuous.slice(1)) {
      // 2. Current retake epoch.
      const staleWinner = this.isStalePostRetakeEvidence(winner.absolutePosition, tail);
      const staleCandidate = this.isStalePostRetakeEvidence(candidate.absolutePosition, tail);
      if (staleWinner !== staleCandidate) {
        if (staleWinner) winner = candidate;
        continue;
      }
      // 3. Support from surrounding content.
      const support = candidate.sequence.contentMatches - winner.sequence.contentMatches;
      if (support !== 0) {
        if (support > 0) winner = candidate;
        continue;
      }
      const run = candidate.sequence.longestOrderedRun - winner.sequence.longestOrderedRun;
      if (run !== 0) {
        if (run > 0) winner = candidate;
        continue;
      }
      // 4. Least motion, then confidence. Both are at or ahead of the cursor,
      // so the nearer position is the smaller move.
      const motion = candidate.absolutePosition - winner.absolutePosition;
      if (motion !== 0) {
        if (motion < 0) winner = candidate;
        continue;
      }
      if (candidate.confidence > winner.confidence) winner = candidate;
    }

    // The tied set is settled by the policy, so its members are no longer
    // evidence of doubt. What still is: any *untied* candidate at a materially
    // different position, which is exactly the §31.13 measurement, retaken
    // against the winner.
    let margin = 1;
    for (let k = tiedCount; k < all.length; k++) {
      const other = all[k];
      if (other === undefined) continue;
      if (
        Math.abs(other.absolutePosition - winner.absolutePosition) > MATERIALLY_SEPARATE_TOKENS
      ) {
        margin = winner.confidence - other.confidence;
        break;
      }
    }

    return { candidate: winner, margin };
  }

  /**
   * The forward half of G.4, applied to whichever candidate the decision layer
   * settled on. Split out of `decideTransition` so that a candidate re-selected
   * by the §23.2 ambiguity policy goes through *exactly* the same thresholds,
   * content requirements and anchor requirements as the leader would have —
   * resolving an ambiguity chooses between candidates, it never admits one.
   */
  private decideForward(
    best: ScoredCandidate,
    margin: number,
    all: ScoredCandidate[],
  ): AlignmentDecision {
    const profile = this.profile;
    const distance = best.absolutePosition - this.committedTokenIndex;
    const isLargeForward = distance > this.largeForwardDistance();

    const threshold = this.localThreshold(distance, best);
    const neededMargin = isLargeForward ? profile.minimumBackwardMargin : profile.minimumForwardMargin;
    const contentOk =
      best.sequence.contentMatches >=
      (isLargeForward || this.state === 'searching'
        ? profile.minimumLockContentMatches
        : Math.min(profile.minimumLockContentMatches, 2));

    if (best.confidence >= threshold && margin >= neededMargin && contentOk) {
      if (this.state === 'searching' || isLargeForward) {
        // §31.7/§31.14: global/large moves need distinctive anchors or a
        // longer ordered run.
        const anchorsOk =
          best.sequence.rareAnchorMatches >= profile.minimumGlobalAnchorCount ||
          best.sequence.longestOrderedRun >= profile.minimumLockContentMatches + 2;
        const isGlobalMove =
          this.state === 'searching' || distance > profile.continuityForwardTokens;
        if (isGlobalMove && !anchorsOk) {
          return this.holdDecision('global_needs_anchors', all, margin);
        }
      }
      return this.commitDecision(best, isLargeForward ? 'skip' : 'advance', margin);
    }

    if (best.confidence >= profile.softThreshold) {
      return this.holdDecision('soft_evidence', all, margin);
    }
    return this.holdDecision('insufficient_confidence', all, margin);
  }

  private localThreshold(distance: number, best: ScoredCandidate): number {
    const profile = this.profile;
    if (this.state === 'searching') return profile.globalThreshold;
    if (distance > profile.continuityForwardTokens) return profile.globalThreshold;
    if (
      best.window.scope === 'rare_anchor' ||
      best.window.scope === 'alias_anchor' ||
      best.window.scope === 'ngram'
    ) {
      return Math.max(profile.lockedThreshold, profile.globalThreshold - 0.02);
    }
    return profile.lockedThreshold;
  }

  private backwardThreshold(backDistance: number): number {
    const profile = this.profile;
    return backDistance <= profile.backwardDistanceStrictAfter
      ? profile.shortRetakeThreshold
      : profile.backwardThreshold;
  }

  /** G.5 retake heuristic. */
  private looksLikeRetake(best: ScoredCandidate, tail: AlignableTail, nowMs: number): boolean {
    const profile = this.profile;
    const startPosition = this.index.clampTokenIndex(
      best.window.startTokenIndex + best.sequence.scriptStartOffset,
    );
    const startsNearBoundary = this.index.isSentenceOrParagraphStart(
      startPosition,
      profile.retakeBoundaryToleranceTokens,
    );
    const repeatedOpening = this.matchesPreviouslyReadOpening(startPosition, tail);
    const withinRecentSection = this.index.sameSection(
      best.absolutePosition,
      this.committedTokenIndex,
    );
    const explicit = this.transcriptContainsRetakeLeadIn(tail);
    const previouslyPassed = startPosition <= this.committedTokenIndex;
    // §21.1 "the destination was visited recently" — an evidence feature the
    // engine could not compute before the visited ring existed. It stands
    // alongside `repeatedOpening` rather than replacing it: the two fail in
    // different ways. A repeated opening survives a long silence but not a
    // transcriber that mangles the destination's first content word; a recent
    // visit survives the mangling but expires. Requiring both would mean a
    // restart is only detectable when nothing at all went wrong, which is not
    // the situation retake detection exists for.
    const visitedRecently = this.visited.visitedRecently(
      startPosition,
      nowMs,
      profile.retakeVisitedWithinMs,
    );

    return (
      (startsNearBoundary &&
        withinRecentSection &&
        previouslyPassed &&
        (repeatedOpening || visitedRecently)) ||
      (explicit && best.confidence >= profile.softThreshold)
    );
  }

  private transcriptContainsRetakeLeadIn(tail: AlignableTail): boolean {
    const text = tail.tokens.map((t) => t.normalized).join(' ');
    return RETAKE_LEAD_INS.some((phrase) => text.includes(phrase));
  }

  /**
   * Does the transcript tail repeat the opening of a sentence/paragraph the
   * cursor has already passed (§31.6, G.5)?
   */
  private matchesPreviouslyReadOpening(position: number, tail: AlignableTail): boolean {
    const blockStart = this.index.blockStartFor(position);
    const sentence = this.index.sentenceAt(position);
    const candidates: number[] = [blockStart];
    if (sentence) candidates.push(sentence.startTokenIndex);
    for (const start of candidates) {
      if (start > this.committedTokenIndex) continue; // not passed yet
      const opening: string[] = [];
      for (let i = start; i < start + 8 && opening.length < 3; i++) {
        const token = this.index.tokenAt(i);
        if (token === undefined) break;
        if (token.weight > this.profile.stopwordWeight) opening.push(token.normalized);
      }
      if (opening.length < 2) continue;
      const tailWords = tail.tokens.filter((t) => t.content).map((t) => t.normalized);
      let cursor = 0;
      for (const word of tailWords) {
        if (word === opening[cursor]) {
          cursor++;
          if (cursor >= opening.length) return true;
        }
      }
    }
    return false;
  }

  /* -------------------------------------------------------------------------
   * Decision application, state timers, snapshots.
   * ----------------------------------------------------------------------- */

  private applyDecision(
    decision: AlignmentDecision,
    tail: AlignableTail,
    final: boolean,
    nowMs: number,
  ): EngineOutput {
    const profile = this.profile;
    const previousState = this.state;
    this.movedFromTokenIndex = this.committedTokenIndex;

    // Track content volume since the last confident lock (only count each
    // final item once so repeats don't inflate the counter).
    if (final) {
      const lastItem = tail.itemIds[tail.itemIds.length - 1] ?? '';
      if (lastItem !== this.lastCountedFinalItem) {
        this.lastCountedFinalItem = lastItem;
        if (decision.movement === 'hold') {
          const item = this.ledger.getItem(lastItem);
          const content = item?.normalizedTokens.reduce((s, t) => s + (t.content ? 1 : 0), 0) ?? 0;
          this.contentTokensSinceConfident += content;
        }
      }
    }

    if (decision.provisional) {
      // §31.8: provisional movement reduces perceived lag but commits nothing.
      this.provisionalTokenIndex = decision.tokenIndex;
      this.provisional = true;
      if (decision.confidence >= profile.lockedThreshold) {
        this.lastConfidentAtMs = nowMs;
        this.contentTokensSinceConfident = 0;
        if (this.state === 'holding') this.state = 'following';
      }
      this.lastConfidence = decision.confidence;
      this.lastMovement = 'advance';
      this.lastSourceItemIds = tail.itemIds;
      // §4.9/§15.3: provisional text is a *noisy measurement* for the filter,
      // never a commitment; the high provisional R keeps the trajectory from
      // visibly oscillating when the completion corrects it.
      this.updateOffScript(decision, nowMs);
      this.observeCommittedPosition(decision, decision.tokenIndex, nowMs);
      const provisionalOutput = this.emit('advance', nowMs, decision.reason, decision);
      if (this.state !== previousState) provisionalOutput.stateChanged = this.state;
      return provisionalOutput;
    }

    switch (decision.movement) {
      case 'advance':
      case 'skip':
      case 'retake': {
        const previousCommitted = this.committedTokenIndex;
        this.committedTokenIndex = decision.committedTokenIndex;
        this.provisionalTokenIndex = decision.tokenIndex;
        this.provisional = false;
        this.state = 'following';
        this.lastConfidentAtMs = nowMs;
        this.contentTokensSinceConfident = 0;
        this.pendingRetake = undefined;
        if (decision.movement === 'retake') {
          // Retain a take-history marker for diagnostics (§31.12).
          this.pushCheckpoint(decision.tokenIndex, nowMs, 'take');
          // §21.4 retake lock: a new epoch, a high-water mark the old take
          // may not drag us back over, and the item ids whose late
          // completions must now be ignored.
          this.epoch++;
          this.preRetakeHighWaterMark = previousCommitted;
          this.staleAfterRetake = new Set(tail.itemIds);
          this.beam.clear();
        } else {
          this.recordPassedBlocks(previousCommitted, this.committedTokenIndex, nowMs);
          // New speech supersedes the retake lock (§21.4 "unless new speech
          // strongly supports it").
          if (this.staleAfterRetake.size > 0) {
            const fresh = tail.itemIds.some((id) => !this.staleAfterRetake.has(id));
            if (fresh) this.staleAfterRetake.clear();
          }
        }
        this.visited.record(previousCommitted, this.committedTokenIndex, nowMs);
        this.justAcquired = !this.acquired;
        this.acquired = true;
        if (!this.index.sameSection(previousCommitted, this.committedTokenIndex)) {
          this.boundaryCrossedAtMs = nowMs;
        }
        this.applySectionBounds();
        this.updateOffScript(decision, nowMs);
        this.observeCommittedPosition(decision, decision.committedTokenIndex, nowMs);
        this.beam.markCommitted(this.lastMeasurement?.best?.lineageId ?? null);
        break;
      }
      case 'command':
      case 'manual':
        // Handled by moveTo(); not produced by align().
        break;
      case 'hold': {
        if (decision.state === 'retake_candidate') {
          this.state = 'retake_candidate';
        } else if (
          this.state === 'following' &&
          nowMs - this.lastConfidentAtMs > profile.adLibGraceMs
        ) {
          this.state = 'holding'; // §31.10 UNCERTAIN after grace
        } else if (this.state === 'retake_candidate') {
          // Backward evidence faded without confirmation (§31.2).
          this.state = 'holding';
        }
        if (
          nowMs - this.lastConfidentAtMs > profile.lostAfterMs &&
          this.contentTokensSinceConfident >= profile.lostAfterContentTokens
        ) {
          this.state = 'searching'; // §31.14 enter global search
        }
        break;
      }
    }

    this.lastConfidence = decision.confidence;
    this.lastMovement = decision.movement;
    this.lastSourceItemIds = tail.itemIds;
    this.updateOffScript(decision, nowMs);
    if (decision.movement === 'hold') {
      // §19.2/§25.6: a hold contributes no position measurement. The filter
      // keeps predicting under the ad-lib schedule, which is what produces
      // bounded drift followed by a settle instead of v1's abrupt freeze.
      this.filter.setState(this.projectStateV2(decision, nowMs));
      this.filter.predict(nowMs);
    }

    const output = this.emit(decision.movement, nowMs, decision.reason, decision);
    if (this.state !== previousState) output.stateChanged = this.state;
    return output;
  }

  /** Record paragraph-start checkpoints the cursor passed (§31.3.4, G.5). */
  private recordPassedBlocks(from: number, to: number, nowMs: number): void {
    for (let i = from; i <= to; i++) {
      const token = this.index.tokenAt(i);
      if (token === undefined) continue;
      const blockStart = this.index.blockStartFor(i);
      if (blockStart <= i && !this.passedBlockStarts.has(blockStart)) {
        this.passedBlockStarts.add(blockStart);
        this.pushCheckpoint(blockStart, nowMs, 'paragraph_start');
      }
    }
  }

  private pushCheckpoint(tokenIndex: number, atMs: number, kind: AlignmentCheckpoint['kind']): void {
    const token = this.index.tokenAt(this.index.clampTokenIndex(tokenIndex));
    this.checkpoints.push({
      tokenIndex: this.index.clampTokenIndex(tokenIndex),
      blockId: token?.blockId ?? '',
      sentenceId: token?.sentenceId ?? '',
      atMs,
      kind,
    });
    if (this.checkpoints.length > MAX_CHECKPOINTS) {
      this.checkpoints.splice(0, this.checkpoints.length - MAX_CHECKPOINTS);
    }
  }

  private provisionalAdvance(best: ScoredCandidate, margin: number): AlignmentDecision {
    const profile = this.profile;
    // §31.8: bounded advance beyond the last final cursor; at most one block
    // boundary without exceptional confidence.
    let target = Math.min(
      best.absolutePosition,
      this.committedTokenIndex + this.maxProvisionalAdvance(),
    );
    // §13 vs §31.8: provisional evidence may never leave the current section.
    // `TrackingSnapshot.tokenIndex` is read straight off `provisionalTokenIndex`
    // by the control Live screen while `SemanticMotionFrame.sectionId` is
    // derived from `committedTokenIndex` — without this clamp the two
    // consumers report positions in different chapters at the same instant.
    const currentSection = this.index.sectionAt(this.committedTokenIndex);
    if (currentSection !== undefined) {
      target = Math.min(target, currentSection.endTokenIndex);
    }
    const exceptional = best.confidence >= profile.lockedThreshold + 0.1;
    if (!exceptional) {
      const currentBlock = this.index.tokenAt(this.committedTokenIndex)?.blockId;
      let boundaries = 0;
      let last = currentBlock;
      for (let i = this.committedTokenIndex + 1; i <= target; i++) {
        const block = this.index.tokenAt(i)?.blockId;
        if (block !== undefined && block !== last) {
          boundaries++;
          last = block;
          if (boundaries > 1) {
            target = i - 1;
            break;
          }
        }
      }
    }
    target = Math.max(target, this.committedTokenIndex);
    return {
      movement: 'advance',
      state: this.state,
      tokenIndex: target,
      committedTokenIndex: this.committedTokenIndex,
      confidence: best.confidence,
      provisional: true,
      reason: 'provisional_advance',
      best,
      margin,
    };
  }

  private commitDecision(
    best: ScoredCandidate,
    movement: 'advance' | 'skip' | 'retake',
    margin: number,
  ): AlignmentDecision {
    return {
      movement,
      state: 'following',
      tokenIndex: best.absolutePosition,
      committedTokenIndex: best.absolutePosition,
      confidence: best.confidence,
      provisional: false,
      reason: `commit_${movement}`,
      best,
      margin,
    };
  }

  private retakeCandidateDecision(best: ScoredCandidate, margin: number): AlignmentDecision {
    // §31.2 RETAKE_CANDIDATE: require persistent evidence before moving back.
    const near =
      this.pendingRetake !== undefined &&
      Math.abs(this.pendingRetake.position - best.absolutePosition) <= RETAKE_POSITION_TOLERANCE;
    const supports = near && this.pendingRetake ? this.pendingRetake.supports + 1 : 1;
    this.pendingRetake = { position: best.absolutePosition, supports };

    if (
      supports >= RETAKE_SUPPORT_REQUIRED &&
      this.challengerHasPersisted() &&
      best.confidence >= this.profile.shortRetakeThreshold &&
      best.sequence.contentMatches >= Math.min(this.profile.minimumBackwardContentMatches, 4)
    ) {
      return this.commitDecision(best, 'retake', margin);
    }
    return {
      movement: 'hold',
      state: 'retake_candidate',
      tokenIndex: this.provisionalTokenIndex,
      committedTokenIndex: this.committedTokenIndex,
      confidence: best.confidence,
      provisional: false,
      reason: 'retake_candidate',
      best,
      margin,
    };
  }

  /**
   * §16.5 challenger hysteresis, the real thing.
   *
   * The beam has always computed `challengerPersistence`, and nothing in the
   * codebase read it; `smoothProfile.alignment.retakePersistenceTokens` and
   * `retakePersistenceMs` were likewise read by nothing. Commit-flap
   * protection rested entirely on thresholds, softmax, and the local
   * `RETAKE_SUPPORT_REQUIRED` count of consecutive supporting events — which
   * measures how often the same *position* recurred, not whether the beam's
   * leading *lineage* actually held its lead. Those are different questions,
   * and §16.5 asks the second one.
   *
   * Applied to both backward-commit paths, so the weaker one cannot be more
   * permissive than the stronger. Either measure suffices — a presenter who
   * restarts and keeps talking clears the token bar quickly, one who restarts
   * and pauses clears the time bar — because requiring both would make a quiet
   * retake wait for speech that is not coming.
   */
  private challengerHasPersisted(): boolean {
    const persistence = this.lastMeasurement?.challengerPersistence;
    if (persistence === undefined) return true; // no beam evidence to weigh
    const { retakePersistenceTokens, retakePersistenceMs } = this.smoothProfile.alignment;
    return (
      persistence.finalTokens >= retakePersistenceTokens ||
      persistence.ms >= retakePersistenceMs
    );
  }

  private holdDecision(
    reason: string,
    _scored: ScoredCandidate[],
    margin: number,
  ): AlignmentDecision {
    return {
      movement: 'hold',
      state: this.state,
      tokenIndex: this.provisionalTokenIndex,
      committedTokenIndex: this.committedTokenIndex,
      confidence: this.lastConfidence,
      provisional: false,
      reason,
      margin,
    };
  }

  /* -------------------------------------------------------------------------
   * Snapshots and diagnostics (§31.16, §31.17).
   * ----------------------------------------------------------------------- */

  toSnapshot(nowMs: number): TrackingSnapshot {
    const token = this.index.tokenAt(this.index.clampTokenIndex(this.provisionalTokenIndex));
    return {
      schemaVersion: 1,
      revision: this.revision,
      sessionId: this.session.sessionId,
      sessionGeneration: this.session.sessionGeneration,
      stageGeneration: this.session.stageGeneration,
      scriptId: this.scriptId,
      tokenIndex: this.provisionalTokenIndex,
      committedTokenIndex: this.committedTokenIndex,
      blockId: token?.blockId ?? '',
      sentenceId: token?.sentenceId ?? '',
      confidence: this.lastConfidence,
      state: this.state,
      provisional: this.provisional,
      movement: this.lastMovement,
      sourceItemIds: this.lastSourceItemIds,
      generatedAtMs: nowMs,
    };
  }

  private emit(
    movement: MovementKind,
    nowMs: number,
    reason: string,
    decision?: AlignmentDecision,
  ): EngineOutput {
    this.revision++;
    this.lastMovement = movement;
    const snapshot = this.toSnapshot(nowMs);
    const diagnostic: AlignmentDiagnostic = {
      revision: this.revision,
      reason,
      state: this.state,
      movement,
      cursorTokenIndex: this.provisionalTokenIndex,
      committedTokenIndex: this.committedTokenIndex,
      confidence: snapshot.confidence,
      margin: decision?.margin ?? 0,
      candidates: decision?.best
        ? [
            {
              scope: decision.best.window.scope,
              startTokenIndex: decision.best.window.startTokenIndex,
              endTokenIndex: decision.best.window.endTokenIndex,
              absolutePosition: decision.best.absolutePosition,
              normalizedScore: decision.best.sequence.normalizedScore,
              prior: decision.best.prior,
              confidence: decision.best.confidence,
              contentMatches: decision.best.sequence.contentMatches,
              rareAnchorMatches: decision.best.sequence.rareAnchorMatches,
            },
          ]
        : [],
      generatedAtMs: nowMs,
    };

    const output: EngineOutput = { snapshot, diagnostic };
    const stateBefore = this.stateV2;
    const projection = this.projectV2(movement, nowMs, decision);
    this.stateV2 = projection.state;
    this.behavior = projection.behavior;
    this.filter.setState(this.stateV2);

    const directive = this.maybeIssueDirective(movement, nowMs, decision);
    const frame = this.buildFrame(nowMs, true, directive);
    if (frame !== undefined) output.frame = frame;

    const record = this.recordDecision(
      movement,
      reason,
      nowMs,
      stateBefore,
      decision,
      directive,
    );
    if (record !== undefined) output.decision = record;
    this.justAcquired = false;
    this.emitAuthority = 'ordinary';
    this.movedFromTokenIndex = this.committedTokenIndex;
    return output;
  }

  /* -------------------------------------------------------------------------
   * Alignment v2 surface (companion §24–§26, §53, §65).
   * ----------------------------------------------------------------------- */

  get semanticEpoch(): number {
    return this.epoch;
  }

  get stateV2Current(): TrackingStateV2 {
    return this.stateV2;
  }

  get behaviorCurrent(): TrackingBehavior {
    return this.behavior;
  }

  /** The most recent beam measurement (companion §16.6), for diagnostics. */
  get measurement(): AlignmentMeasurement | undefined {
    return this.lastMeasurement;
  }

  /** Companion §7.2: a new layout generation invalidates stage geometry. */
  setLayoutGeneration(generation: number, nowMs: number): EngineOutput {
    // A non-finite generation would defeat the `===` latch below forever (NaN
    // never equals itself) and, once stamped on frames, would silently disable
    // the stage's stale-frame discard.
    if (!Number.isFinite(generation)) return {};
    const next = Math.floor(generation);
    if (next === this.layoutGeneration) return {};
    this.layoutGeneration = next;
    const directive = this.directives.issue({
      type: 'settle',
      authority: 'ordinary',
      reason: 'layout_recovery',
      fromUnit: this.filter.estimate().positionUnits,
      toUnit: this.units.unitAt(this.committedTokenIndex),
      destinationTokenIndex: this.committedTokenIndex,
      issuedAtMs: nowMs,
      semanticEpoch: this.epoch,
    });
    const frame = this.buildFrame(nowMs, true, directive);
    return frame !== undefined ? { frame } : {};
  }

  /**
   * Companion §40: accept one bounded sidecar classification. The beam
   * validates epoch, expiry, source items, and candidate membership; nothing
   * here can move the cursor on its own.
   */
  applySemanticAssist(evidence: SemanticAssistEvidence): void {
    if (evidence.epoch !== this.epoch) return; // §25.7 stale epoch
    this.beam.setSemanticAssist(evidence);
  }

  /**
   * Advance the continuous estimate to `nowMs` without new transcript
   * evidence and emit a frame if one is due (companion §26.1). This is what
   * keeps motion alive *between* transcript events — the whole point of §3.1
   * — and what runs the ad-lib coast→decelerate→hold schedule to its settle.
   */
  tick(nowMs: number): EngineOutput {
    if (nowMs < this.lastEventAtMs) return {};
    this.lastEventAtMs = nowMs;
    const released = this.expireCommandPending(nowMs);
    if (released !== undefined) return released;
    const previousState = this.stateV2;
    this.filter.setState(this.stateV2);
    this.filter.predict(nowMs);
    // Coasting decays into uncertainty/ad-lib hold as the horizon lapses.
    this.stateV2 = this.projectStateV2(undefined, nowMs);
    if (this.stateV2 !== previousState) this.filter.setState(this.stateV2);
    if (isReturnToScript(previousState, this.stateV2)) this.behavior = 'return';
    const frame = this.buildFrame(nowMs, false, this.directives.active(nowMs));
    return frame !== undefined ? { frame } : {};
  }

  /** Items currently withheld from alignment (§33.4 step 5). */
  get maskedItemCount(): number {
    return this.maskedItemIds.size;
  }

  /** Companion §64 — why the most recent pace span was discarded, if it was. */
  get paceRejection(): PaceSampleRejection | undefined {
    return this.lastPaceRejection;
  }

  /** Companion §65 — bounded "why did it move?" ring buffer. */
  decisionRecords(): readonly MovementDecisionRecord[] {
    return this.decisions.all();
  }

  /* ----------------------------------------------------------------------- */

  /** Feed the semantic filter and the pace estimator (companion §24.3–§24.4). */
  private observeCommittedPosition(
    decision: AlignmentDecision,
    targetTokenIndex: number,
    nowMs: number,
  ): void {
    const profile = this.profile;
    const unit = this.units.unitAt(targetTokenIndex);

    const previous = this.lastPaceSpan;
    if (previous !== undefined && !decision.provisional) {
      // §24.4: exclude contaminated spans rather than letting them distort
      // the rate. A rejected sample still advances the span anchor so the
      // *next* clean span is measured from the right place.
      const contamination: PaceSampleRejection[] = [];
      // §24.4 lists command speech among the contaminating spans. Nothing in
      // src/ ever emitted it: the first span after a command was measured
      // across the command utterance itself, which is script units covered
      // divided by a duration that includes speech that covered none of them.
      // The resulting rate clears the 0.4 floor, so it was accepted, and it
      // halves blended pace — which then drives `filter.observeVelocity` and
      // the beam's predict-forward.
      if (this.paceSpanAfterCommand) contamination.push('command_speech');
      if (decision.movement === 'skip') contamination.push('skip');
      if (decision.movement === 'retake') contamination.push('retake');
      if (this.offScript) contamination.push('adlib');
      this.lastPaceRejection = this.paceEstimator.observe(
        {
          units: unit - this.units.unitAt(previous.tokenIndex),
          durationMs: nowMs - previous.atMs,
          atMs: nowMs,
          quality: Math.max(profile.paceMinQuality, decision.confidence),
        },
        contamination,
      );
    }
    if (!decision.provisional) {
      this.lastPaceSpan = { tokenIndex: targetTokenIndex, atMs: nowMs };
      this.paceSpanAfterCommand = false;
    }

    this.filter.setState(this.projectStateV2(decision, nowMs));
    this.filter.observe({
      positionUnits: unit,
      confidence: decision.confidence,
      margin: decision.margin,
      beamVariance: this.lastMeasurement?.positionVariance ?? 0,
      finalEvidence: !decision.provisional,
      // §25.1: only the committed retake/skip *is* the authorized
      // discontinuity. Everything else that happens to arrive while a
      // directive is still live is an ordinary measurement and stays clamped.
      authorizedDiscontinuity:
        !decision.provisional &&
        (decision.movement === 'retake' || decision.movement === 'skip'),
      atMs: nowMs,
    });

    const pace = this.paceEstimator.estimate(nowMs);
    if (pace.blendedUnitsPerSecond > 0 && !decision.provisional) {
      this.filter.observeVelocity({
        unitsPerSecond: pace.blendedUnitsPerSecond,
        weight: profile.paceVelocityBlendWeight,
        atMs: nowMs,
      });
    }
  }

  /**
   * Companion §19.1 ad-lib entry conditions: speech is present, local
   * alignment stays weak past the grace period, and the best position remains
   * *near the previous cursor* rather than forming a credible skip.
   *
   * The weakness test reads the beam measurement rather than the decision,
   * because a hold decision reports the last confident value by design — that
   * is what the snapshot shows the operator — so it would never look weak.
   */
  private updateOffScript(decision: AlignmentDecision, nowMs: number): void {
    if (decision.movement !== 'hold') {
      this.offScript = false;
      return;
    }
    const measurement = this.lastMeasurement;
    const weak = (measurement?.confidence ?? 0) < this.profile.softThreshold;
    const nearCursor =
      measurement === undefined ||
      Math.abs(measurement.bestTokenPosition - this.committedTokenIndex) <=
        this.largeForwardDistance();
    const pastGrace = nowMs - this.lastConfidentAtMs > this.profile.adLibGraceMs;
    this.offScript = weak && nearCursor && pastGrace;
  }

  private behaviorContext(movement: MovementKind, nowMs: number, decision?: AlignmentDecision) {
    const confident = this.lastConfidence >= this.profile.lockedThreshold;
    return {
      state: this.state,
      movement,
      // The decision that performs the first lock *is* the acquisition, so it
      // reports ACQUIRING/acquire rather than looking like a jump (§17.1).
      acquired: this.acquired && !this.justAcquired,
      provisional: this.provisional,
      correction: this.lastCorrection,
      activeTransition: this.directives.activeType(nowMs),
      authority: this.emitAuthority,
      msSinceConfident: nowMs - this.lastConfidentAtMs,
      horizonMs: confident
        ? this.smoothProfile.prediction.normalHorizonMs
        : this.smoothProfile.prediction.uncertainHorizonMs,
      offScript: this.offScript,
      retakeCommitted: movement === 'retake',
      confidence: decision?.confidence ?? this.lastConfidence,
      lockedThreshold: this.profile.lockedThreshold,
      softThreshold: this.profile.softThreshold,
    };
  }

  private projectV2(movement: MovementKind, nowMs: number, decision?: AlignmentDecision) {
    return projectBehavior(this.behaviorContext(movement, nowMs, decision));
  }

  private projectStateV2(decision: AlignmentDecision | undefined, nowMs: number): TrackingStateV2 {
    return projectBehavior(this.behaviorContext(decision?.movement ?? this.lastMovement, nowMs, decision))
      .state;
  }

  /**
   * Companion §53. Directives are minted only for the four situations the
   * spec authorizes a visual discontinuity: a large forward skip, a retake
   * the stage cannot comfortably reverse through, command/manual navigation,
   * and a session reset. Everything else is ordinary trajectory following.
   */
  private maybeIssueDirective(
    movement: MovementKind,
    nowMs: number,
    decision?: AlignmentDecision,
  ): StageTransitionDirective | undefined {
    // A session reset is the strongest discontinuity there is; nothing may
    // supersede it inside its own epoch (§53).
    const live = this.directives.active(nowMs);
    if (live?.type === 'reset' && live.semanticEpoch === this.epoch) return live;

    const fromUnit = this.filter.estimate().positionUnits;
    const destination = this.index.clampTokenIndex(
      decision?.committedTokenIndex ?? this.committedTokenIndex,
    );
    const toUnit = this.units.unitAt(destination);
    const base = {
      fromUnit,
      toUnit,
      destinationTokenIndex: destination,
      issuedAtMs: nowMs,
      semanticEpoch: this.epoch,
    };

    if (this.emitAuthority !== 'ordinary') {
      return this.directives.issue({
        ...base,
        type: 'reanchor',
        authority: this.emitAuthority,
        reason:
          this.emitAuthority === 'command' ? 'command_navigation' : 'manual_navigation',
      });
    }
    if (movement === 'skip') {
      const type = directiveTypeFor(this.lastCorrection);
      if (type === 'none') return this.directives.active(nowMs);
      return this.directives.issue({
        ...base,
        type,
        authority: 'ordinary',
        reason: 'large_forward_skip',
      });
    }
    if (movement === 'retake') {
      // §22.1 nearby retakes rewind under the reverse cap; §22.2 distant ones
      // re-anchor. Both are retake-class transitions, hence the shared reason.
      const type = this.lastCorrection === 'backward_distant' ? 'reanchor' : 'rewind';
      return this.directives.issue({
        ...base,
        type,
        authority: 'ordinary',
        reason: 'distant_retake',
      });
    }
    return this.directives.active(nowMs);
  }

  /** Companion §26.1 — build and rate-limit a semantic motion frame. */
  private buildFrame(
    nowMs: number,
    force: boolean,
    directive: StageTransitionDirective | undefined,
  ): SemanticMotionFrame | undefined {
    const estimate = this.filter.predict(nowMs);
    const displayUnit = estimate.positionUnits + this.filter.leadUnits(this.lastConfidence);
    const tokenIndex = this.index.clampTokenIndex(this.units.tokenIndexAt(displayUnit));
    const token = this.index.tokenAt(tokenIndex);
    // A directive rides every frame until it expires; the stage keys on `id`
    // and must not re-run the motion for a repeat (§53 idempotency).
    const active = directive ?? this.directives.active(nowMs);
    const input = {
      sessionId: this.session.sessionId,
      sessionGeneration: this.session.sessionGeneration,
      scriptCompileHash: this.scriptCompileHash,
      layoutGeneration: this.layoutGeneration,
      epoch: this.epoch,
      sessionTimeMs: nowMs,
      estimatedUnit: displayUnit,
      committedUnit: this.units.unitAt(this.committedTokenIndex),
      velocityUnitsPerSecond: estimate.velocityUnitsPerSecond,
      accelerationUnitsPerSecond2: estimate.accelerationUnitsPerSecond2,
      positionVariance: Math.max(estimate.positionVariance, this.lastMeasurement?.positionVariance ?? 0),
      confidence: this.lastConfidence,
      sectionId: this.sectionGraph.sectionIdAt(this.committedTokenIndex),
      tokenIndex,
      sentenceId: token?.sentenceId ?? '',
      blockId: token?.blockId ?? '',
      state: this.stateV2,
      behavior: this.behavior,
      finalEvidence: !this.provisional,
      ...(active !== undefined ? { transition: active } : {}),
      motionProfileId: this.smoothProfile.id,
    };
    const newDirective = active !== undefined && active.id !== this.lastFrameTransitionId;
    if (!this.frames.shouldEmit(input, force || newDirective)) return undefined;
    this.lastFrameTransitionId = active?.id;
    return this.frames.emit(input);
  }

  /** Companion §65 — record why a nontrivial movement happened. */
  private recordDecision(
    movement: MovementKind,
    reason: string,
    nowMs: number,
    stateBefore: TrackingStateV2,
    decision: AlignmentDecision | undefined,
    directive: StageTransitionDirective | undefined,
  ): MovementDecisionRecord | undefined {
    const measurement = this.lastMeasurement;
    // A plain hold that changed nothing is not a movement transition.
    if (movement === 'hold' && stateBefore === this.stateV2 && measurement?.blockedCount === 0) {
      return undefined;
    }
    const fromToken = this.movedFromTokenIndex;
    const authority: TransitionAuthority = this.emitAuthority;
    const best = measurement?.best;
    return this.decisions.push({
      revision: this.revision,
      sessionTimeMs: nowMs,
      fromUnit: this.units.unitAt(fromToken),
      toUnit: this.units.unitAt(this.committedTokenIndex),
      behavior: this.behavior,
      stateBefore,
      stateAfter: this.stateV2,
      localConfidence: decision?.confidence ?? this.lastConfidence,
      secondBestMargin: decision?.margin ?? measurement?.secondBestMargin ?? 0,
      sectionGate: (measurement?.blockedCount ?? 0) > 0 ? 'blocked' : 'allowed',
      ...(best?.semanticRelation !== undefined
        ? { semanticAssistRelation: best.semanticRelation }
        : {}),
      ...(best !== undefined ? { semanticAssistInfluence: best.semanticScore } : {}),
      authority,
      visualDisposition: visualDispositionFor(movement, this.lastCorrection, authority),
      reason,
      fromTokenIndex: fromToken,
      toTokenIndex: this.committedTokenIndex,
      fromSectionId: this.sectionGraph.sectionIdAt(fromToken),
      toSectionId: this.sectionGraph.sectionIdAt(this.committedTokenIndex),
      ...(best !== undefined ? { hypothesisId: best.id, lineageId: best.lineageId } : {}),
      continuityPrior: decision?.best?.prior ?? best?.continuityPrior ?? 1,
      blockedCandidateCount: measurement?.blockedCount ?? 0,
      ...(measurement?.blocked !== undefined ? { blockedReason: measurement.blocked.reason } : {}),
      beamSize: measurement?.hypotheses.length ?? 0,
      positionVariance: measurement?.positionVariance ?? 0,
      finalEvidence: !this.provisional,
      ...(directive !== undefined ? { transitionId: directive.id } : {}),
    });
  }
}

/** §37.1/§57.2: finalized tail and provisional tail are sent separately. */
function joinSurfaces(tail: AlignableTail, final: boolean): string {
  const parts: string[] = [];
  for (const token of tail.tokens) {
    if (token.final === final) parts.push(token.surface);
  }
  return parts.join(' ');
}

/** Companion §65 `visualDisposition`. */
function visualDispositionFor(
  movement: MovementKind,
  correction: CorrectionClass,
  authority: TransitionAuthority,
): MovementDecisionRecord['visualDisposition'] {
  if (authority !== 'ordinary') return 'reanchor';
  if (movement === 'hold') return 'hold';
  if (movement === 'retake') return correction === 'backward_distant' ? 'reanchor' : 'rewind';
  if (correction === 'reanchor') return 'reanchor';
  if (correction === 'catch_up') return 'catch_up';
  return 'absorbed';
}
