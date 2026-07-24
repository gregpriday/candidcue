/**
 * Alignment engine v2 — multi-hypothesis beam (companion §10–§16, App. B.1).
 *
 * The v1 aligner (sequence.ts + candidates.ts + prior.ts + confidence.ts) is
 * retained wholesale and used as the *emission model* here: it still answers
 * "how well does this transcript tail explain this script window?". What v2
 * adds around it is the latent-state machinery §10 asks for:
 *
 *   hypotheses     — a bounded beam of plausible trajectories (§11);
 *   transitions    — explicit priors + predict-forward between updates (§16);
 *   evidence       — several transcript tails, not one fixed length (§15.2);
 *   eligibility    — the hard section gate, applied as zero probability (§13);
 *   normalization  — softmax weights over the surviving beam (§16 step 7);
 *   pruning        — merge near-identical, drop below the weight floor;
 *   margin         — a measurement *distribution*, not one token index (§16.6).
 *
 * Cost control (§63): the full rolling tail is scored against every candidate
 * window exactly once — the same single pass v1 performed — and the shorter
 * tails re-score only the windows that already lead. Total work stays
 * proportional to the candidate cap plus the beam width, never to script
 * length, and the committing decision layer reuses this pass rather than
 * running its own.
 *
 * Pure and deterministic — no clock reads, no network, no DOM.
 */
import type { SmoothFollowProfile } from '../contracts/smooth-follow';
import type { TrackingState } from '../contracts/tracking';
import { confidenceModel } from './confidence';
import type { DocumentIndex } from './document-index';
import type { AlignableTail } from './ledger';
import type { TrackingProfile } from './profile';
import { continuityPrior } from './prior';
import type {
  SectionEligibility,
  SectionGraph,
  SectionTransitionContext,
  TransitionAuthority,
} from './section-graph';
import {
  isSemanticEvidenceCurrent,
  semanticAdjustment,
  type SemanticAssistEvidence,
  type SemanticAssistRelation,
} from './semantic-assist';
import { alignSequences } from './sequence';
import type { SpeechUnitScale } from './speech-units';
import type {
  CandidateScope,
  CandidateWindow,
  LedgerToken,
  ScoredCandidate,
  SequenceAlignment,
} from './types';

/* ---------------------------------------------------------------------------
 * Types (companion §11, §16.6)
 * ------------------------------------------------------------------------- */

export type HypothesisMode = 'following' | 'holding' | 'adlib' | 'skip' | 'retake' | 'boundary';

/** Companion §11. */
export interface AlignmentHypothesis {
  id: string;
  lineageId: string;
  sectionId: string;
  candidateId: string;
  scope: CandidateScope;
  tokenPosition: number;
  spokenUnitPosition: number;
  velocityUnitsPerSecond: number;
  mode: HypothesisMode;
  logScore: number;
  /** Normalized posterior weight over the surviving beam (§16 step 7). */
  weight: number;
  lexicalScore: number;
  phoneticScore: number;
  sequenceScore: number;
  semanticScore: number;
  continuityPrior: number;
  authority: TransitionAuthority;
  evidenceItemIds: string[];
  matchedTokenIndexes: number[];
  contentMatches: number;
  rareAnchorMatches: number;
  longestOrderedRun: number;
  finalEvidence: boolean;
  semanticRelation?: SemanticAssistRelation;
  lastStrongAnchorAtMs: number;
  createdAtMs: number;
  updatedAtMs: number;
}

/** Compact projection carried on measurements and diagnostics. */
export interface AlignmentHypothesisSummary {
  id: string;
  lineageId: string;
  sectionId: string;
  scope: CandidateScope;
  mode: HypothesisMode;
  tokenPosition: number;
  spokenUnitPosition: number;
  weight: number;
  logScore: number;
  continuityPrior: number;
  semanticScore: number;
  contentMatches: number;
  rareAnchorMatches: number;
}

/** Companion §25.1 correction classes, by rendered distance (A.3). */
export type CorrectionClass =
  | 'none'
  | 'micro'
  | 'local'
  | 'catch_up'
  | 'reanchor'
  | 'backward_near'
  | 'backward_distant'
  | 'prohibited';

export interface TransitionProposal {
  kind: CorrectionClass;
  fromUnit: number;
  toUnit: number;
  destinationTokenIndex: number;
  /** Approximate rendered-line distance used for the classification (A.3). */
  renderedLines: number;
}

/** Companion §16.6. */
export interface AlignmentMeasurement {
  revision: number;
  sessionTimeMs: number;
  /** Best hypothesis position in *tokens*. */
  bestTokenPosition: number;
  /** Best hypothesis position in *spoken units* (§6). */
  bestPositionUnits: number;
  committedCandidatePosition: number | null;
  positionVariance: number;
  confidence: number;
  secondBestMargin: number;
  sectionId: string;
  finalEvidence: boolean;
  sourceItemIds: string[];
  hypotheses: AlignmentHypothesisSummary[];
  /**
   * Section-eligible candidates in v1 `ScoredCandidate` shape, ordered exactly
   * as the v1 engine ordered them. The committing decision layer (engine.ts)
   * consumes this instead of re-running the dynamic programming, so there is
   * one scoring pass per update, not two (§63).
   */
  candidates: ScoredCandidate[];
  best?: AlignmentHypothesis;
  /** Highest-scoring candidate the section gate rejected, for diagnostics. */
  blocked?: { tokenPosition: number; sectionId: string; reason: SectionEligibility };
  blockedCount: number;
  semanticAssistId?: string;
  transitionProposal: TransitionProposal;
  /**
   * §16.5 hysteresis. How long the *leading* lineage has led, in meaningful
   * final transcript tokens and in milliseconds. It becomes a challenger — the
   * thing the gate is about — when `activeLineageId` names a different lineage,
   * which the consumer can see because both are on this measurement.
   *
   * `finalTokens` used to re-add the whole 30-token rolling tail on every final
   * event, so it over-counted by 5–10× and would have made any threshold built
   * on it fire almost immediately. Each transcript item is now counted once.
   */
  challengerPersistence: { finalTokens: number; ms: number };
  activeLineageId: string | null;
}

export interface BeamAdvanceInput {
  tail: AlignableTail;
  windows: readonly CandidateWindow[];
  committedTokenIndex: number;
  cursorTokenIndex: number;
  eligibility: SectionTransitionContext;
  finalEvidence: boolean;
  sessionTimeMs: number;
  /** Latest short-term pace, used to predict hypotheses forward (§16 step 1). */
  paceUnitsPerSecond: number;
  /**
   * The semantic filter's predicted position in units. Companion §25.1 defines
   * innovation as `z - x` against the *prediction*, not against the committed
   * cursor — measuring from the cursor would classify ordinary reading lag as
   * a forward skip on every single update.
   */
  predictedUnit: number;
  epoch: number;
  state: TrackingState;
  msSinceConfident: number;
  /**
   * `profile.largeForwardDistance` already clamped to the enclosing section
   * (see `scales.ts`). The absolute constant is two thirds of a short section,
   * which would make "large forward skip" indistinguishable from reading.
   */
  largeForwardDistance: number;
  /** v1 heuristic: does the tail repeat an already-read opening? (§31.6). */
  repeatedOpening: (tokenPosition: number) => boolean;
}

/* ---------------------------------------------------------------------------
 * Beam
 * ------------------------------------------------------------------------- */

interface ScoredWindow {
  window: CandidateWindow;
  sequence: SequenceAlignment;
  tokenPosition: number;
  startTokenPosition: number;
  /**
   * Confidence from the *primary* (full) transcript tail. This is exactly the
   * value the v1 decision layer used before v2 existed, and the v1 thresholds
   * are calibrated against it, so the shorter tails must never perturb it.
   */
  confidence: number;
  /**
   * Additional, bounded beam-only evidence from the shorter tails (§15.2).
   * Applied to hypothesis `logScore`, never to `confidence`.
   */
  beamBonus: number;
  prior: number;
  tailsAgreeing: number;
  itemIds: string[];
}

export class HypothesisBeam {
  private readonly index: DocumentIndex;
  private readonly graph: SectionGraph;
  private readonly units: SpeechUnitScale;
  private readonly profile: TrackingProfile;
  private readonly smooth: SmoothFollowProfile;

  private beam: AlignmentHypothesis[] = [];
  private revision = 0;
  private nextId = 0;
  private activeLineageId: string | null = null;
  private challengerLineageId: string | null = null;
  private challengerSinceMs = 0;
  private challengerFinalTokens = 0;
  /** Transcript items already folded into `challengerFinalTokens` (§16.5). */
  private challengerCountedItemIds: ReadonlySet<string> = new Set();
  /** Lineage the §16.2 hold branch is currently carrying, if any. */
  private holdLineageId: string | null = null;
  private lastUpdateAtMs = 0;
  private assist: SemanticAssistEvidence | undefined;

  constructor(
    index: DocumentIndex,
    graph: SectionGraph,
    units: SpeechUnitScale,
    profile: TrackingProfile,
    smooth: SmoothFollowProfile,
  ) {
    this.index = index;
    this.graph = graph;
    this.units = units;
    this.profile = profile;
    this.smooth = smooth;
  }

  current(): readonly AlignmentHypothesis[] {
    return this.beam;
  }

  /**
   * Inject bounded sidecar evidence (companion §40). This is the *only*
   * injection point; the beam validates epoch, expiry, source items, and
   * candidate membership before any of it becomes score.
   */
  setSemanticAssist(evidence: SemanticAssistEvidence | undefined): void {
    this.assist = evidence;
  }

  /** Drop every hypothesis — command/manual authority, reset, or new epoch. */
  clear(): void {
    this.beam = [];
    this.activeLineageId = null;
    this.challengerLineageId = null;
    this.challengerSinceMs = 0;
    this.challengerFinalTokens = 0;
    this.challengerCountedItemIds = new Set();
    this.holdLineageId = null;
    this.assist = undefined;
  }

  /**
   * Seed the beam with an authoritative destination (§12.6): a command or
   * manual move creates one hypothesis and resets ordinary eligibility.
   */
  seedAuthoritative(tokenIndex: number, authority: TransitionAuthority, atMs: number): void {
    this.clear();
    const position = this.index.clampTokenIndex(tokenIndex);
    const lineageId = `lin-${this.nextId++}`;
    this.beam = [
      {
        id: `hyp-${this.nextId++}`,
        lineageId,
        sectionId: this.graph.sectionIdAt(position),
        candidateId: candidateIdFor('navigation', position),
        scope: 'navigation',
        tokenPosition: position,
        spokenUnitPosition: this.units.unitAt(position),
        velocityUnitsPerSecond: 0,
        mode: 'following',
        logScore: 0,
        weight: 1,
        lexicalScore: 0,
        phoneticScore: 0,
        sequenceScore: 0,
        semanticScore: 0,
        continuityPrior: 1,
        authority,
        evidenceItemIds: [],
        matchedTokenIndexes: [],
        contentMatches: 0,
        rareAnchorMatches: 0,
        longestOrderedRun: 0,
        finalEvidence: true,
        lastStrongAnchorAtMs: atMs,
        createdAtMs: atMs,
        updatedAtMs: atMs,
      },
    ];
    this.activeLineageId = lineageId;
    this.lastUpdateAtMs = atMs;
  }

  /** Companion §16 / Appendix B.1 `hypothesisBeam.advance`. */
  advance(input: BeamAdvanceInput): AlignmentMeasurement {
    this.revision++;
    const profile = this.profile;
    const tails = buildTails(input.tail.tokens, profile);

    // 1. Predict every surviving hypothesis forward (§16 step 1) and decay it
    //    so an unsupported branch fades instead of vanishing (§23.3).
    const dtSeconds = Math.max(0, (input.sessionTimeMs - this.lastUpdateAtMs) / 1000);
    this.lastUpdateAtMs = input.sessionTimeMs;
    const predicted = new Map<string, AlignmentHypothesis>();
    for (const hypothesis of this.beam) {
      const advancedUnits =
        hypothesis.spokenUnitPosition +
        Math.max(0, input.paceUnitsPerSecond) * dtSeconds * (hypothesis.mode === 'adlib' ? 0 : 1);
      const next: AlignmentHypothesis = {
        ...hypothesis,
        spokenUnitPosition: advancedUnits,
        tokenPosition: this.units.tokenAt(advancedUnits),
        logScore: hypothesis.logScore * profile.hypothesisDecay,
        velocityUnitsPerSecond: input.paceUnitsPerSecond,
      };
      predicted.set(hypothesis.lineageId, next);
    }

    // 2–3. Score candidate windows against the transcript tails.
    const scored = this.scoreWindows(tails, input);

    // 6. Hard eligibility gate — zero probability, applied before anything
    //    semantic can see the candidate (§13, §51 step 6, D.4 step 5).
    const eligible: ScoredWindow[] = [];
    let blocked: AlignmentMeasurement['blocked'];
    let blockedCount = 0;
    for (const candidate of scored) {
      // `startTokenPosition` is where the matched alignment *began*. Without
      // it the gate can only see where the span stopped, and one fluent
      // sentence straddling a section boundary looks identical to a jump into
      // the middle of the next section — which zeroed the candidate and, since
      // every later utterance lands deeper still, wedged the engine for good.
      //
      // It is offered only for a *dense* alignment. The gate reads the span
      // start as a claim that the presenter read continuously from there, and
      // that claim is only worth anything if the alignment actually matched
      // the script it spans. A sparse match on two distant phrases spans just
      // as many tokens and means nothing, so it is handed no span start and
      // faces the strict corridor test on its endpoint alone.
      const verdict = this.graph.evaluate(
        input.committedTokenIndex,
        candidate.tokenPosition,
        input.eligibility,
        isDenseAlignment(candidate) ? candidate.startTokenPosition : undefined,
      );
      if (verdict.eligible) {
        eligible.push(candidate);
        continue;
      }
      blockedCount++;
      if (blocked === undefined || candidate.confidence > 0) {
        blocked = {
          tokenPosition: candidate.tokenPosition,
          sectionId: verdict.toSectionId,
          reason: verdict.reason,
        };
      }
    }

    // 4–5. Create/update branches, folding in bounded semantic evidence.
    const activeItemIds = new Set(input.tail.itemIds);
    const assist = isSemanticEvidenceCurrent(
      this.assist,
      input.epoch,
      input.sessionTimeMs,
      profile.semanticAssistTtlMs,
      activeItemIds,
    )
      ? this.assist
      : undefined;

    const produced: AlignmentHypothesis[] = [];
    let semanticAssistId: string | undefined;
    for (const candidate of eligible) {
      const distanceTokens = candidate.tokenPosition - input.committedTokenIndex;
      const localScore = Math.min(1, candidate.confidence + candidate.beamBonus);
      const adjustment = semanticAdjustment(
        assist,
        {
          candidateId: candidateIdFor(candidate.window.scope, candidate.tokenPosition),
          distanceTokens,
          largeForward: distanceTokens > input.largeForwardDistance,
          localScore,
          finalEvidence: input.finalEvidence,
          epoch: input.epoch,
          nowMs: input.sessionTimeMs,
          activeItemIds,
        },
        this.smooth,
      );
      if (adjustment.assistId !== undefined) semanticAssistId = adjustment.assistId;

      const unitPosition = this.units.unitAt(candidate.tokenPosition);
      const inherited = this.nearestPredicted(predicted, candidate.tokenPosition);
      const mode = classifyMode(distanceTokens, input.largeForwardDistance);
      const hypothesis: AlignmentHypothesis = {
        id: `hyp-${this.nextId++}`,
        lineageId: inherited?.lineageId ?? `lin-${this.nextId++}`,
        sectionId: this.graph.sectionIdAt(candidate.tokenPosition),
        candidateId: candidateIdFor(candidate.window.scope, candidate.tokenPosition),
        scope: candidate.window.scope,
        tokenPosition: candidate.tokenPosition,
        spokenUnitPosition: unitPosition,
        velocityUnitsPerSecond: input.paceUnitsPerSecond,
        mode,
        // Continuity bonus for a branch that survived from the previous
        // update — the transition model, not a fresh guess (§16.1).
        logScore:
          localScore +
          adjustment.delta +
          (inherited ? inherited.logScore * profile.hypothesisInheritanceFactor : 0),
        weight: 0,
        lexicalScore: candidate.sequence.normalizedScore,
        phoneticScore: phoneticShare(candidate.sequence),
        sequenceScore: candidate.sequence.score,
        semanticScore: adjustment.delta,
        continuityPrior: candidate.prior,
        authority: input.eligibility.authority,
        evidenceItemIds: candidate.itemIds,
        matchedTokenIndexes: candidate.sequence.matchedPairs.map(
          (pair) => candidate.window.startTokenIndex + pair.scriptTokenIndex,
        ),
        contentMatches: candidate.sequence.contentMatches,
        rareAnchorMatches: candidate.sequence.rareAnchorMatches,
        longestOrderedRun: candidate.sequence.longestOrderedRun,
        finalEvidence: input.finalEvidence,
        ...(adjustment.relation !== undefined ? { semanticRelation: adjustment.relation } : {}),
        lastStrongAnchorAtMs:
          candidate.sequence.rareAnchorMatches > 0
            ? input.sessionTimeMs
            : (inherited?.lastStrongAnchorAtMs ?? 0),
        createdAtMs: inherited?.createdAtMs ?? input.sessionTimeMs,
        updatedAtMs: input.sessionTimeMs,
      };
      produced.push(hypothesis);
      if (inherited) predicted.delete(inherited.lineageId);
    }

    // §16.2: the hold / ad-lib branch. Staying put while speech contains
    // insertions is always plausible — this is what stops continuous speech
    // from automatically consuming script.
    //
    // Claiming the inherited lineage means *taking* it, exactly as the
    // candidate loop above does. Without the delete, a surviving active
    // lineage that no candidate adopted was pushed twice: once as the hold
    // branch sitting at the committed cursor, and again by the leftover loop
    // at its predicted-forward position. Two hypotheses with one lineage id,
    // far enough apart that `mergeHypotheses` keeps both — so the beam
    // double-counted the same trajectory in its softmax and in its variance,
    // and `markCommitted` could no longer name one branch.
    const heldLineage =
      predicted.get(this.activeLineageId ?? '') ?? predicted.get(this.holdLineageId ?? '');
    if (heldLineage !== undefined) predicted.delete(heldLineage.lineageId);
    const hold = this.holdBranch(input, heldLineage, input.sessionTimeMs);
    this.holdLineageId = hold.lineageId;
    produced.push(hold);

    // Surviving-but-unsupported branches keep their decayed score (§23.3).
    for (const leftover of predicted.values()) {
      if (leftover.logScore >= profile.minHypothesisWeight) produced.push(leftover);
    }

    // 8–9. Merge near-identical hypotheses, then prune to the beam width.
    const merged = mergeHypotheses(produced, profile.beamMergeTokens);
    merged.sort((a, b) => b.logScore - a.logScore || a.tokenPosition - b.tokenPosition);
    const beam = merged.slice(0, Math.max(1, this.smooth.alignment.beamWidth));

    // 7. Normalize (softmax over log scores).
    normalizeWeights(beam, profile.hypothesisSoftmaxTemperature);
    this.beam = beam.filter((h) => h.weight >= profile.minHypothesisWeight);
    if (this.beam.length === 0 && beam.length > 0) this.beam = beam.slice(0, 1);

    return this.buildMeasurement(input, eligible, blocked, blockedCount, semanticAssistId);
  }

  /* ----------------------------------------------------------------------- */

  /**
   * Companion §15.2 "use multiple transcript tails rather than one fixed
   * length … combine results without triple-counting the same evidence".
   *
   * Pass 1 scores the full rolling tail against every candidate window; that
   * is the primary measurement and the value the committing decision layer
   * consumes. Pass 2 re-scores only the leading windows against the shorter,
   * faster-responding tails (§63 cost control) and converts *agreement*
   * between independent tails into a small bounded beam bonus. Agreement, not
   * the sum of the scores, is what avoids counting the same tokens three
   * times: a longer tail contains the shorter one.
   */
  private scoreWindows(tails: LedgerToken[][], input: BeamAdvanceInput): ScoredWindow[] {
    const profile = this.profile;
    const primaryTail = input.tail.tokens;
    if (primaryTail.length === 0) return [];

    // §63: one DP per (window, tail length). The cache matters because the
    // leading windows are re-scored against several shorter tails and the
    // shorter tails frequently coincide in length after the meaningful-token
    // walk in `buildTails`.
    const cache = new Map<string, ScoredWindow | undefined>();
    const score = (window: CandidateWindow, tail: readonly LedgerToken[]): ScoredWindow | undefined => {
      const key = `${window.scope}:${window.startTokenIndex}:${window.endTokenIndex}:${tail.length}`;
      const hit = cache.get(key);
      if (hit !== undefined || cache.has(key)) return hit;
      const value = this.scoreOne(window, tail, input);
      cache.set(key, value);
      return value;
    };

    const scored: ScoredWindow[] = [];
    for (const window of input.windows) {
      const entry = score(window, primaryTail);
      if (entry !== undefined) scored.push({ ...entry });
    }
    scored.sort((a, b) => b.confidence - a.confidence);

    // §63: when the primary tail is already decisive there is nothing a short
    // tail can add — it can only agree — so skip the extra DP passes entirely.
    const leader = scored[0];
    const runnerUp = scored[1];
    const decisive =
      leader !== undefined &&
      leader.confidence >= profile.lockedThreshold &&
      (runnerUp === undefined ||
        leader.confidence - runnerUp.confidence >= profile.ambiguityMargin);
    if (decisive) return scored;

    const deepLimit = Math.max(1, this.smooth.alignment.beamWidth);
    for (let i = 0; i < scored.length && i < deepLimit; i++) {
      const entry = scored[i];
      if (entry === undefined) continue;
      for (const tail of tails) {
        if (tail.length === 0 || tail.length >= primaryTail.length) continue;
        const shorter = score(entry.window, tail);
        if (shorter === undefined) continue;
        if (Math.abs(shorter.tokenPosition - entry.tokenPosition) <= profile.beamMergeTokens) {
          entry.tailsAgreeing++;
        }
      }
      entry.beamBonus = profile.tailAgreementBonus * (entry.tailsAgreeing - 1);
    }
    return scored;
  }

  private scoreOne(
    window: CandidateWindow,
    tail: readonly LedgerToken[],
    input: BeamAdvanceInput,
  ): ScoredWindow | undefined {
    const profile = this.profile;
    const slice = this.index.document.spokenTokens.slice(
      window.startTokenIndex,
      window.endTokenIndex + 1,
    );
    const sequence = alignSequences(tail, slice, profile);
    if (sequence.matchedPairs.length === 0) return undefined;

    // Rarity is a document property (§14.4 rare-token index), not only the
    // compiler-assigned weight — mirrors the v1 engine.
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

    const tokenPosition = this.index.clampTokenIndex(
      window.startTokenIndex + sequence.scriptEndOffset,
    );
    const startTokenPosition = this.index.clampTokenIndex(
      window.startTokenIndex + sequence.scriptStartOffset,
    );
    const prior = continuityPrior(
      this.index,
      {
        from: input.committedTokenIndex,
        to: tokenPosition,
        scope: window.scope,
        state: input.state,
        final: input.finalEvidence,
        msSinceConfident: input.msSinceConfident,
        repeatedOpening: input.repeatedOpening(tokenPosition),
        rareAnchorMatches: sequence.rareAnchorMatches,
      },
      profile,
    );
    const confidence = confidenceModel(
      { sequence, prior, transcriptConfidence: input.tail.confidence, final: input.finalEvidence },
      profile,
    );
    return {
      window,
      sequence,
      tokenPosition,
      startTokenPosition,
      confidence,
      beamBonus: 0,
      prior,
      tailsAgreeing: 1,
      itemIds: [...input.tail.itemIds],
    };
  }

  private holdBranch(
    input: BeamAdvanceInput,
    inherited: AlignmentHypothesis | undefined,
    atMs: number,
  ): AlignmentHypothesis {
    const position = this.index.clampTokenIndex(input.committedTokenIndex);
    // A minted id, not the constant `'lin-hold'` this used to be. A constant
    // meant every hold branch the beam ever produced shared one lineage, so
    // two of them could coexist (one held, one predicted forward from an
    // earlier update) and `markCommitted` could not name either.
    const lineageId = inherited?.lineageId ?? `lin-${this.nextId++}`;
    return {
      id: `hyp-${this.nextId++}`,
      lineageId,
      sectionId: this.graph.sectionIdAt(position),
      candidateId: candidateIdFor('continuity', position),
      scope: 'continuity',
      tokenPosition: position,
      spokenUnitPosition: this.units.unitAt(position),
      velocityUnitsPerSecond: 0,
      mode: 'holding',
      // §16.2: a fixed, modest prior — plausible but easily beaten by real
      // ordered lexical support, and never able to move the cursor itself.
      logScore: this.profile.softThreshold * this.profile.holdBranchScoreFactor,
      weight: 0,
      lexicalScore: 0,
      phoneticScore: 0,
      sequenceScore: 0,
      semanticScore: 0,
      continuityPrior: 1,
      authority: input.eligibility.authority,
      evidenceItemIds: [],
      matchedTokenIndexes: [],
      contentMatches: 0,
      rareAnchorMatches: 0,
      longestOrderedRun: 0,
      finalEvidence: input.finalEvidence,
      lastStrongAnchorAtMs: inherited?.lastStrongAnchorAtMs ?? 0,
      createdAtMs: inherited?.createdAtMs ?? atMs,
      updatedAtMs: atMs,
    };
  }

  private nearestPredicted(
    predicted: Map<string, AlignmentHypothesis>,
    tokenPosition: number,
  ): AlignmentHypothesis | undefined {
    let best: AlignmentHypothesis | undefined;
    let bestDistance = Infinity;
    for (const hypothesis of predicted.values()) {
      const distance = Math.abs(hypothesis.tokenPosition - tokenPosition);
      if (distance <= this.profile.continuityForwardTokens && distance < bestDistance) {
        best = hypothesis;
        bestDistance = distance;
      }
    }
    return best;
  }

  private buildMeasurement(
    input: BeamAdvanceInput,
    eligible: readonly ScoredWindow[],
    blocked: AlignmentMeasurement['blocked'],
    blockedCount: number,
    semanticAssistId: string | undefined,
  ): AlignmentMeasurement {
    const profile = this.profile;
    const best = this.beam[0];
    const committedUnit = this.units.unitAt(input.committedTokenIndex);

    // §16.6: two close hypotheses should worry us less than two equally likely
    // candidates several paragraphs apart, so variance is measured in units
    // around the weighted mean of the whole beam.
    let mean = 0;
    let totalWeight = 0;
    for (const hypothesis of this.beam) {
      mean += hypothesis.spokenUnitPosition * hypothesis.weight;
      totalWeight += hypothesis.weight;
    }
    mean = totalWeight > 0 ? mean / totalWeight : committedUnit;
    let variance = 0;
    for (const hypothesis of this.beam) {
      const delta = hypothesis.spokenUnitPosition - mean;
      variance += hypothesis.weight * delta * delta;
    }
    variance = totalWeight > 0 ? variance / totalWeight : profile.filterInitialVariance;

    // Margin against the best *materially different* position (§31.13/§23.2).
    let margin = 1;
    if (best !== undefined) {
      for (let i = 1; i < this.beam.length; i++) {
        const other = this.beam[i];
        if (other === undefined) continue;
        if (Math.abs(other.tokenPosition - best.tokenPosition) > profile.beamMergeTokens * 2) {
          margin = Math.max(0, best.logScore - other.logScore);
          break;
        }
      }
    }

    // §16.5 hysteresis bookkeeping: how long has the leader held its lead?
    const leaderLineage = best?.lineageId ?? null;
    if (leaderLineage !== this.challengerLineageId) {
      this.challengerLineageId = leaderLineage;
      this.challengerSinceMs = input.sessionTimeMs;
      this.challengerFinalTokens = 0;
      this.challengerCountedItemIds = new Set();
    }
    if (input.finalEvidence) {
      // Per *item*, once. The tail is a 30-token rolling window, so adding all
      // of it on every final event counted the same speech five to ten times
      // over — and this is the counter a persistence threshold reads, so an
      // over-count is a threshold that fires on the first utterance.
      for (const itemId of input.tail.itemIds) {
        if (this.challengerCountedItemIds.has(itemId)) continue;
        this.challengerFinalTokens += countMeaningfulFrom(input.tail.tokens, itemId);
      }
      // Only items still in the tail can be offered again, so the memo never
      // needs to outlive it.
      this.challengerCountedItemIds = new Set(input.tail.itemIds);
    }

    const bestTokenPosition = best?.tokenPosition ?? input.committedTokenIndex;
    const bestUnit = best?.spokenUnitPosition ?? committedUnit;
    const proposal = this.classifyCorrection(
      Number.isFinite(input.predictedUnit) ? input.predictedUnit : committedUnit,
      bestUnit,
      bestTokenPosition,
    );

    return {
      revision: this.revision,
      sessionTimeMs: input.sessionTimeMs,
      bestTokenPosition,
      bestPositionUnits: bestUnit,
      committedCandidatePosition:
        input.finalEvidence && best !== undefined && best.mode !== 'holding'
          ? bestTokenPosition
          : null,
      positionVariance: Number.isFinite(variance) ? variance : profile.filterInitialVariance,
      confidence: best?.logScore ?? 0,
      secondBestMargin: margin,
      sectionId: best?.sectionId ?? this.graph.sectionIdAt(input.committedTokenIndex),
      finalEvidence: input.finalEvidence,
      sourceItemIds: [...input.tail.itemIds],
      hypotheses: this.beam.map(summarize),
      candidates: toScoredCandidates(eligible, input.committedTokenIndex),
      ...(best !== undefined ? { best } : {}),
      ...(blocked !== undefined ? { blocked } : {}),
      blockedCount,
      ...(semanticAssistId !== undefined ? { semanticAssistId } : {}),
      transitionProposal: proposal,
      challengerPersistence: {
        finalTokens: this.challengerFinalTokens,
        ms: input.sessionTimeMs - this.challengerSinceMs,
      },
      activeLineageId: this.activeLineageId,
    };
  }

  /** Companion §25.1 + A.3: classify the innovation by rendered distance. */
  classifyCorrection(fromUnit: number, toUnit: number, destinationTokenIndex: number) {
    const profile = this.profile;
    const deltaUnits = toUnit - fromUnit;
    const lines = Math.abs(deltaUnits) / Math.max(0.001, profile.unitsPerRenderedLine);
    let kind: CorrectionClass;
    if (Math.abs(deltaUnits) < profile.frameUnitEpsilon) kind = 'none';
    else if (deltaUnits < 0) {
      kind =
        lines <= profile.catchUpRenderedLines
          ? ('backward_near' as const)
          : ('backward_distant' as const);
    } else if (lines <= profile.absorbRenderedLines * 0.5) kind = 'micro';
    else if (lines <= profile.absorbRenderedLines) kind = 'local';
    else if (lines <= profile.catchUpRenderedLines) kind = 'catch_up';
    else kind = 'reanchor';
    return { kind, fromUnit, toUnit, destinationTokenIndex, renderedLines: lines };
  }

  /** Record which lineage the engine actually committed to (§16.5). */
  markCommitted(lineageId: string | null): void {
    this.activeLineageId = lineageId;
  }
}

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

/**
 * Companion §15.2 / A.2: short (6–12), medium (12–24) and long finalized
 * (24–50) meaningful-token tails. Tails are suffixes of the same rolling
 * ledger tail, so a longer tail always contains the shorter one.
 */
export function buildTails(
  tokens: readonly LedgerToken[],
  profile: TrackingProfile,
): LedgerToken[][] {
  const lengths = [profile.tailShortTokens, profile.tailMediumTokens, profile.tailLongTokens];
  const tails: LedgerToken[][] = [];
  let previousLength = -1;
  for (const meaningfulTarget of lengths) {
    // Walk back from the end until `meaningfulTarget` meaningful tokens are
    // covered; fillers and stopwords ride along but do not count (§30.6).
    let meaningful = 0;
    let start = tokens.length;
    while (start > 0 && meaningful < meaningfulTarget) {
      start--;
      const token = tokens[start];
      if (token !== undefined && token.content) meaningful++;
    }
    const tail = tokens.slice(start);
    if (tail.length === previousLength) continue;
    previousLength = tail.length;
    tails.push(tail);
  }
  return tails;
}

/**
 * Minimum share of a matched span's script tokens that must actually be
 * matched for the span to count as a continuous read. Half, because the
 * transcript legitimately drops stopwords, contractions and filler, so a
 * faithful verbatim read rarely pairs every script token — while a spurious
 * long span (two distant phrases that happen to appear in one tail) matches
 * far less than half of what it covers.
 */
const MIN_SPAN_COVERAGE = 0.5;

/**
 * Did this alignment match most of the script it spans?
 *
 * Exported because it is a *safety* predicate, not an implementation detail:
 * it is the only thing standing between "the span start proves a continuous
 * read" and "two distant phrases in one transcript tail buy a section
 * crossing". Nothing else in the suite can observe it — a sparse span that
 * happens to reach the right places is hard to provoke through a real engine —
 * so it is pinned directly.
 */
export function isDenseAlignment(candidate: {
  tokenPosition: number;
  startTokenPosition: number;
  sequence: Pick<SequenceAlignment, 'matchedPairs'>;
}): boolean {
  const spanTokens = candidate.tokenPosition - candidate.startTokenPosition + 1;
  if (spanTokens <= 1) return true;
  return candidate.sequence.matchedPairs.length >= spanTokens * MIN_SPAN_COVERAGE;
}

function classifyMode(distanceTokens: number, largeForwardDistance: number): HypothesisMode {
  if (distanceTokens < 0) return 'retake';
  if (distanceTokens > largeForwardDistance) return 'skip';
  return 'following';
}

function phoneticShare(sequence: SequenceAlignment): number {
  if (sequence.matchedPairs.length === 0) return 0;
  let phonetic = 0;
  for (const pair of sequence.matchedPairs) {
    if (pair.kind === 'phonetic' || pair.kind === 'fuzzy') phonetic++;
  }
  return phonetic / sequence.matchedPairs.length;
}

/** Meaningful tokens contributed to the tail by one transcript item (§30.6). */
function countMeaningfulFrom(tokens: readonly LedgerToken[], itemId: string): number {
  let count = 0;
  for (const token of tokens) if (token.content && token.itemId === itemId) count++;
  return count;
}

/** §16 step 8: collapse hypotheses that describe the same position. */
export function mergeHypotheses(
  hypotheses: readonly AlignmentHypothesis[],
  mergeTokens: number,
): AlignmentHypothesis[] {
  const sorted = [...hypotheses].sort(
    (a, b) => a.tokenPosition - b.tokenPosition || b.logScore - a.logScore,
  );
  const merged: AlignmentHypothesis[] = [];
  for (const hypothesis of sorted) {
    const previous = merged[merged.length - 1];
    if (
      previous !== undefined &&
      previous.sectionId === hypothesis.sectionId &&
      Math.abs(previous.tokenPosition - hypothesis.tokenPosition) <= mergeTokens
    ) {
      if (hypothesis.logScore > previous.logScore) {
        merged[merged.length - 1] = {
          ...hypothesis,
          createdAtMs: Math.min(previous.createdAtMs, hypothesis.createdAtMs),
        };
      }
      continue;
    }
    merged.push(hypothesis);
  }
  return merged;
}

/** §16 step 7: normalize the beam into posterior weights. */
export function normalizeWeights(beam: AlignmentHypothesis[], temperature: number): void {
  if (beam.length === 0) return;
  const t = Math.max(1e-3, temperature);
  let max = -Infinity;
  for (const hypothesis of beam) max = Math.max(max, hypothesis.logScore);
  let total = 0;
  const exponentials: number[] = [];
  for (const hypothesis of beam) {
    const value = Math.exp((hypothesis.logScore - max) / t);
    exponentials.push(value);
    total += value;
  }
  beam.forEach((hypothesis, i) => {
    hypothesis.weight = total > 0 ? (exponentials[i] ?? 0) / total : 1 / beam.length;
  });
}

export function candidateIdFor(scope: CandidateScope, tokenPosition: number): string {
  return `${scope}:${tokenPosition}`;
}

/**
 * Project eligible scored windows into the v1 `ScoredCandidate` shape, using
 * the v1 ordering (confidence desc, then nearest to the cursor, then earliest)
 * so the committing decision layer behaves identically to before v2.
 */
function toScoredCandidates(
  eligible: readonly ScoredWindow[],
  committedTokenIndex: number,
): ScoredCandidate[] {
  const candidates = eligible.map((entry) => ({
    window: entry.window,
    sequence: entry.sequence,
    absolutePosition: entry.tokenPosition,
    prior: entry.prior,
    confidence: entry.confidence,
  }));
  candidates.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      Math.abs(a.absolutePosition - committedTokenIndex) -
        Math.abs(b.absolutePosition - committedTokenIndex) ||
      a.absolutePosition - b.absolutePosition,
  );
  return candidates;
}

function summarize(hypothesis: AlignmentHypothesis): AlignmentHypothesisSummary {
  return {
    id: hypothesis.id,
    lineageId: hypothesis.lineageId,
    sectionId: hypothesis.sectionId,
    scope: hypothesis.scope,
    mode: hypothesis.mode,
    tokenPosition: hypothesis.tokenPosition,
    spokenUnitPosition: hypothesis.spokenUnitPosition,
    weight: hypothesis.weight,
    logScore: hypothesis.logScore,
    continuityPrior: hypothesis.continuityPrior,
    semanticScore: hypothesis.semanticScore,
    contentMatches: hypothesis.contentMatches,
    rareAnchorMatches: hypothesis.rareAnchorMatches,
  };
}
