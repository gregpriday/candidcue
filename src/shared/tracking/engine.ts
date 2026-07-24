/**
 * Deterministic script alignment engine (spec §31, Appendix G.1–G.5).
 *
 * Owns the transcript ledger projection, candidate scoring, the alignment
 * state machine, retake/skip logic, manual correction, and snapshot
 * emission. Pure and deterministic: all time comes from event timestamps or
 * explicit `nowMs` arguments — never from wall-clock reads.
 */
import type { TrackingSnapshot, TrackingState } from '../contracts/tracking';
import { generateCandidates } from './candidates';
import { confidenceModel } from './confidence';
import { DocumentIndex } from './document-index';
import { TranscriptLedger, type AlignableTail } from './ledger';
import { resolveTrackingProfile, type TrackingProfile } from './profile';
import { continuityPrior } from './prior';
import { alignSequences } from './sequence';
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
}

export interface EngineOutput {
  snapshot?: TrackingSnapshot;
  diagnostic?: AlignmentDiagnostic;
  stateChanged?: TrackingState;
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
const RETAKE_SUPPORT_REQUIRED = 2;
const RETAKE_POSITION_TOLERANCE = 6;

export class AlignmentEngine {
  readonly profile: TrackingProfile;
  readonly ledger: TranscriptLedger;
  readonly index: DocumentIndex;
  private readonly session: EngineSession;
  private readonly scriptId: string;

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

  constructor(
    document: TrackingDocument,
    session: EngineSession,
    profile?: Partial<TrackingProfile>,
  ) {
    this.profile = resolveTrackingProfile(profile);
    this.index = new DocumentIndex(document, { rareWeight: this.profile.rareWeight });
    this.ledger = new TranscriptLedger();
    this.ledger.setSessionGeneration(session.sessionGeneration);
    this.session = session;
    this.scriptId = document.scriptId;
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
  }

  /** Release items whose command detection failed (spec §33.4 tail). */
  releaseItems(itemIds: readonly string[]): void {
    for (const id of itemIds) this.maskedItemIds.delete(id);
    this.ledger.setCommandDisposition(itemIds, 'script');
  }

  setCommandPending(pending: boolean, nowMs: number): EngineOutput {
    this.commandPending = pending;
    if (pending) {
      if (this.state !== 'command_pending') {
        this.stateBeforePause = this.state;
        this.state = 'command_pending';
        return this.emit('command', nowMs, 'command_pending');
      }
    } else if (this.state === 'command_pending') {
      this.state = this.stateBeforePause === 'command_pending' ? 'following' : this.stateBeforePause;
      return this.emit('hold', nowMs, 'command_resolved');
    }
    return {};
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
    if (this.commandPending) return {};

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

    const decision = this.align(tail, update.final, nowMs);
    return this.applyDecision(decision, tail, update.final, nowMs);
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

    const scored: ScoredCandidate[] = [];
    for (const window of windows) {
      const slice = this.index.document.spokenTokens.slice(
        window.startTokenIndex,
        window.endTokenIndex + 1,
      );
      const sequence = alignSequences(tail.tokens, slice, profile);
      if (sequence.matchedPairs.length === 0) continue;
      // Rarity is a document property (frequency index), not only the
      // compiler-assigned token weight (§31.14 rare-token indexes).
      let indexedRare = 0;
      for (const pair of sequence.matchedPairs) {
        const scriptToken = slice[pair.scriptTokenIndex];
        if (
          scriptToken !== undefined &&
          pair.kind !== 'weak' &&
          this.index.rareTokenPositions.has(scriptToken.normalized)
        ) {
          indexedRare++;
        }
      }
      sequence.rareAnchorMatches = Math.max(sequence.rareAnchorMatches, indexedRare);
      const absolutePosition = this.index.clampTokenIndex(
        window.startTokenIndex + sequence.scriptEndOffset,
      );
      const prior = continuityPrior(
        this.index,
        {
          from: this.committedTokenIndex,
          to: absolutePosition,
          scope: window.scope,
          state: this.state,
          final,
          msSinceConfident: nowMs - this.lastConfidentAtMs,
          repeatedOpening: this.matchesPreviouslyReadOpening(absolutePosition, tail),
          rareAnchorMatches: sequence.rareAnchorMatches,
        },
        profile,
      );
      const confidence = confidenceModel(
        { sequence, prior, transcriptConfidence: tail.confidence, final },
        profile,
      );
      scored.push({ window, sequence, absolutePosition, prior, confidence });
    }

    scored.sort(
      (a, b) =>
        b.confidence - a.confidence ||
        Math.abs(a.absolutePosition - this.committedTokenIndex) -
          Math.abs(b.absolutePosition - this.committedTokenIndex) ||
        a.absolutePosition - b.absolutePosition,
    );

    const best = scored[0];
    if (best === undefined) return this.holdDecision('no_candidate', scored, 0);

    // Margin against the best candidate at a materially different position
    // (§31.13 — repeated passages must freeze, not guess).
    let margin = 1;
    for (let k = 1; k < scored.length; k++) {
      const other = scored[k];
      if (other === undefined) continue;
      if (Math.abs(other.absolutePosition - best.absolutePosition) > 10) {
        margin = best.confidence - other.confidence;
        break;
      }
    }

    return this.decideTransition(best, margin, scored, tail, final, nowMs);
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
    const isLargeForward = distance > profile.largeForwardDistance;

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
      if (!this.looksLikeRetake(best, tail)) {
        return this.holdDecision('backward_not_retake', all, margin);
      }
      const threshold = this.backwardThreshold(-distance);
      if (
        best.confidence < threshold ||
        best.sequence.contentMatches < profile.minimumBackwardContentMatches ||
        margin < profile.minimumBackwardMargin
      ) {
        return this.retakeCandidateDecision(best, margin);
      }
      return this.commitDecision(best, 'retake', margin);
    }

    // §31.13: two well-separated candidates nearly tied → hold, don't guess.
    if (margin < profile.ambiguityMargin && best.confidence >= profile.softThreshold) {
      return this.holdDecision('ambiguous_candidates', all, margin);
    }

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
    if (best.window.scope === 'rare_anchor' || best.window.scope === 'ngram') {
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
  private looksLikeRetake(best: ScoredCandidate, tail: AlignableTail): boolean {
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

    return (
      (startsNearBoundary && repeatedOpening && withinRecentSection && previouslyPassed) ||
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
        } else {
          this.recordPassedBlocks(previousCommitted, this.committedTokenIndex, nowMs);
        }
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
      this.committedTokenIndex + profile.maxProvisionalAdvanceTokens,
    );
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
    return { snapshot, diagnostic };
  }
}
