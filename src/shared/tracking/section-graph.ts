/**
 * Script eligibility graph (companion §13, Appendix B.2).
 *
 * This module owns CandidCue's single hardest invariant:
 *
 *   > An uncommanded non-contiguous section jump is PROHIBITED — it receives
 *   > zero probability, not merely a large penalty (§13, §3.3, §69.7).
 *
 * Appendix E replaces the primary specification's §31.6 cross-section
 * continuity *penalty* and its §31.14 unrestricted global reacquisition with
 * this gate. Everything that can move the cursor — the v1 decision path, the
 * v2 hypothesis beam and the semantic motion filter — runs
 * candidates through `isEligible` first, so there is exactly one enforcement
 * point rather than a penalty scattered across scorers.
 *
 * Allowed ordinary edges (§13):
 *   - remain inside the current section;
 *   - advance to the *immediate next* section while progressing through the
 *     current end boundary;
 *   - retake into the *immediate previous* section only within a recent
 *     boundary-crossing window;
 *   - anything a command/manual authority explicitly supplied.
 *
 * Acquisition is deliberately not a transition: before the engine has ever
 * committed a position there is no `from` section to jump *from* (§17.1), so
 * an unacquired engine may lock anywhere. Every transition after that first
 * lock is gated.
 *
 * Two properties have to hold *simultaneously*, and only one of them used to:
 *
 *   SAFETY   an uncommanded non-contiguous jump never executes;
 *   LIVENESS a presenter reading the script correctly always gets through it.
 *
 * A gate that refuses everything satisfies safety perfectly, so safety alone
 * cannot tell a correct gate from a wedged one. Two shapes wedged it:
 *
 *   1. `# Part` immediately followed by `## Scene`. Token ownership is
 *      deepest-wins, so the parent owns *only its own heading words* — a span
 *      the presenter never speaks, because nobody reads headings aloud. The
 *      parent was nevertheless the only legal successor of the previous scene,
 *      so every real commit (which lands in the first child) was
 *      `prohibited_non_contiguous`, permanently, at every part boundary.
 *      Fixed by `headingOnly` transparency: a section whose own span is
 *      nothing but its heading block is stepped *over*, which is exactly what
 *      §13.2 means by "a non-spoken heading between the two does not have to
 *      be spoken".
 *
 *   2. One fluent sentence straddling the boundary. The corridor test ran
 *      against the *end* of the matched span, so a sentence that crossed the
 *      boundary and kept going landed past the entry corridor and was zeroed —
 *      and every later utterance landed deeper still, so the wedge was
 *      monotonically unrecoverable. Fixed by testing the corridor against
 *      where the evidence *entered* the section (`evidenceStartTokenIndex`),
 *      not where it stopped: an alignment that walked contiguously through the
 *      boundary entered through the front door regardless of how far it ran.
 */
import type { DocumentIndex } from './document-index';
import type { TrackingProfile } from './profile';
import type { SectionSpan } from './types';

export type TransitionAuthority = 'ordinary' | 'command' | 'manual';

/** Why a candidate transition was allowed, or why it was rejected. */
export type SectionEligibility =
  | 'unacquired'
  | 'authorized'
  | 'same_section'
  | 'sequential_next'
  | 'boundary_retake'
  | 'prohibited_non_contiguous'
  | 'prohibited_unauthorized_target';

export interface SectionTransitionContext {
  authority: TransitionAuthority;
  /**
   * Section ids an authority explicitly opened. Consulted only when
   * `authority` is `command` or `manual` (B.2 first branch).
   */
  authorizedSectionIds?: ReadonlySet<string>;
  /** False until the engine has committed its first position (§17.1). */
  acquired: boolean;
  /** The cursor crossed a section boundary within the recent window (§13). */
  recentlyCrossedBoundary: boolean;
  /** Retake evidence is strong enough for a backward boundary edge (§21.2). */
  retakeEvidenceStrong: boolean;
}

/**
 * The first *script* token the matched evidence covers, when the caller knows
 * it. Optional so a caller that only has a destination keeps the old, stricter
 * behaviour; the beam always has it (`ScoredWindow.startTokenPosition`).
 */
export type EvidenceStartTokenIndex = number | undefined;

export interface EligibilityDecision {
  eligible: boolean;
  reason: SectionEligibility;
  fromSectionId: string;
  toSectionId: string;
}

/** Section id used when a document has no outline at all. */
export const IMPLICIT_SECTION_ID = '__document__';

export class SectionGraph {
  private readonly index: DocumentIndex;
  private readonly profile: TrackingProfile;
  private readonly order: SectionSpan[];
  private readonly positionById = new Map<string, number>();
  /**
   * Last token each section *owns* under deepest-wins coverage — i.e. the last
   * `t` for which `sectionIdAt(t)` returns this section. `SectionSpan.end` is
   * widened over the whole subtree by the compiler, so for any parent it names
   * a token its deepest child owns, not one it owns itself. Every boundary
   * test here needs the owned span: reading order is exactly
   * `order[0].own, order[1].own, …`, contiguous and disjoint.
   */
  private readonly ownEndByPosition: number[] = [];
  /**
   * A section whose own span is nothing but its heading block. Nobody reads
   * headings aloud, so the cursor can never land in one; sequential
   * progression steps over it (§13.2).
   */
  private readonly headingOnlyByPosition: boolean[] = [];

  constructor(index: DocumentIndex, profile: TrackingProfile) {
    this.index = index;
    this.profile = profile;
    // `index.sections` is already sorted by start token; deeper subsections
    // are flattened into the same linear reading order, which is exactly the
    // order sequential progression walks.
    // Copy: `index.sections` is a public mutable array on DocumentIndex, and
    // the gate's ordering is the invariant everything else is checked against.
    this.order = [...index.sections];
    this.order.forEach((section, position) => {
      if (!this.positionById.has(section.id)) this.positionById.set(section.id, position);
    });
    this.order.forEach((section, position) => {
      const next = this.order[position + 1];
      const ownEnd =
        next !== undefined
          ? Math.min(section.endTokenIndex, next.startTokenIndex - 1)
          : section.endTokenIndex;
      this.ownEndByPosition[position] = ownEnd;
      this.headingOnlyByPosition[position] =
        ownEnd < section.startTokenIndex ||
        index.blockStartFor(ownEnd) === index.blockStartFor(section.startTokenIndex);
    });
  }

  /** The hard section id owning `tokenIndex` (§14.4 "hard section ID"). */
  sectionIdAt(tokenIndex: number): string {
    return this.index.sectionAt(tokenIndex)?.id ?? IMPLICIT_SECTION_ID;
  }

  sectionAt(tokenIndex: number): SectionSpan | undefined {
    return this.index.sectionAt(tokenIndex);
  }

  nextSectionId(sectionId: string): string | undefined {
    const position = this.positionById.get(sectionId);
    if (position === undefined) return undefined;
    return this.order[position + 1]?.id;
  }

  previousSectionId(sectionId: string): string | undefined {
    const position = this.positionById.get(sectionId);
    if (position === undefined || position === 0) return undefined;
    return this.order[position - 1]?.id;
  }

  /**
   * Every section reachable from `sectionId` by ordinary forward progression:
   * the next section in reading order, plus anything further separated from it
   * only by heading-only sections. Exposed for diagnostics and tests — the
   * §13.2 relaxation should be inspectable, not implicit.
   */
  sequentialNextSectionIds(sectionId: string): string[] {
    const position = this.positionById.get(sectionId);
    if (position === undefined) return [];
    return this.forwardPositions(position).map((p) => this.order[p]?.id ?? IMPLICIT_SECTION_ID);
  }

  /** Mirror of `sequentialNextSectionIds` for the backward boundary edge. */
  boundaryRetakeSectionIds(sectionId: string): string[] {
    const position = this.positionById.get(sectionId);
    if (position === undefined) return [];
    return this.backwardPositions(position).map((p) => this.order[p]?.id ?? IMPLICIT_SECTION_ID);
  }

  /**
   * Clamp a boundary corridor so it can never span a large part of a short
   * section. Without this, a 60-token chapter with a 45-token corridor would
   * treat "anywhere past the first quarter" as "at the boundary", and the
   * sequential-progression edge would quietly become a general licence to
   * enter the next section.
   */
  private corridor(position: number, windowTokens: number): number {
    const section = this.order[position];
    if (section === undefined) return windowTokens;
    const length = Math.max(1, this.ownEnd(position) - section.startTokenIndex + 1);
    return Math.min(windowTokens, Math.max(1, Math.floor(length * this.profile.sectionBoundaryMaxFraction)));
  }

  private ownEnd(position: number): number {
    return this.ownEndByPosition[position] ?? this.order[position]?.endTokenIndex ?? 0;
  }

  private positionAt(tokenIndex: number): number {
    const section = this.index.sectionAt(tokenIndex);
    if (section === undefined) return -1;
    return this.positionById.get(section.id) ?? -1;
  }

  /** Is `tokenIndex` within `windowTokens` of its section's last owned token? */
  isNearSectionEnd(tokenIndex: number, windowTokens = this.profile.sectionBoundaryForwardTokens) {
    const position = this.positionAt(tokenIndex);
    if (position < 0) return true;
    return this.ownEnd(position) - tokenIndex <= this.corridor(position, windowTokens);
  }

  /** Is `tokenIndex` within `windowTokens` of its section's first token? */
  isNearSectionStart(tokenIndex: number, windowTokens = this.profile.sectionBoundaryForwardTokens) {
    const position = this.positionAt(tokenIndex);
    if (position < 0) return true;
    const start = this.order[position]?.startTokenIndex ?? tokenIndex;
    return tokenIndex - start <= this.corridor(position, windowTokens);
  }

  /**
   * Appendix B.2 `isEligibleTransition`, expressed over token indexes.
   * Returns the reason as well as the verdict so diagnostics can explain the
   * gate (§65 `sectionGate`) without re-deriving it.
   *
   * `evidenceStartTokenIndex` is where the matched alignment *began*. Without
   * it the corridor tests can only look at where the span stopped, which makes
   * a single fluent sentence that runs through a boundary — the most ordinary
   * thing a presenter does — indistinguishable from a jump into the middle of
   * the next section. See the module header, defect 2.
   */
  evaluate(
    fromTokenIndex: number,
    toTokenIndex: number,
    context: SectionTransitionContext,
    evidenceStartTokenIndex?: EvidenceStartTokenIndex,
  ): EligibilityDecision {
    const fromSectionId = this.sectionIdAt(fromTokenIndex);
    const toSectionId = this.sectionIdAt(toTokenIndex);
    const decide = (eligible: boolean, reason: SectionEligibility): EligibilityDecision => ({
      eligible,
      reason,
      fromSectionId,
      toSectionId,
    });

    // Authority branch (B.2 first branch, §12.6): a validated command or
    // manual action supplies its own destination and resets eligibility.
    if (context.authority === 'command' || context.authority === 'manual') {
      const authorized = context.authorizedSectionIds;
      if (authorized === undefined || authorized.has(toSectionId)) {
        return decide(true, 'authorized');
      }
      return decide(false, 'prohibited_unauthorized_target');
    }

    // §17.1: acquisition is not a transition — there is no origin section.
    if (!context.acquired) return decide(true, 'unacquired');

    if (toSectionId === fromSectionId) return decide(true, 'same_section');

    const fromPosition = this.positionAt(fromTokenIndex);
    const toPosition = this.positionAt(toTokenIndex);

    // Sequential progression through the current end boundary (§13, §13.2:
    // a non-spoken heading between the two does not have to be spoken).
    if (toPosition >= 0 && this.forwardPositions(fromPosition).includes(toPosition)) {
      const window = this.profile.sectionBoundaryForwardTokens;
      const entry = this.entryTokenIndex(toPosition, toTokenIndex, evidenceStartTokenIndex);
      const enteredAtBoundary =
        entry - (this.order[toPosition]?.startTokenIndex ?? entry) <=
        this.corridor(toPosition, window);
      if (this.leftAtBoundary(fromPosition, fromTokenIndex, evidenceStartTokenIndex, window) &&
        enteredAtBoundary
      ) {
        return decide(true, 'sequential_next');
      }
    }

    // Retake across a *just crossed* boundary (§13, §21.2 "previous section
    // near a just-crossed boundary: very high threshold").
    if (
      fromPosition >= 0 &&
      toPosition >= 0 &&
      this.backwardPositions(fromPosition).includes(toPosition) &&
      context.recentlyCrossedBoundary &&
      context.retakeEvidenceStrong &&
      this.isNearSectionStart(fromTokenIndex, this.profile.sectionBoundaryBackwardTokens) &&
      this.isNearSectionEnd(toTokenIndex, this.profile.sectionBoundaryBackwardTokens)
    ) {
      return decide(true, 'boundary_retake');
    }

    // §13.1: prohibited even if a distinctive phrase matches perfectly.
    return decide(false, 'prohibited_non_contiguous');
  }

  isEligible(
    fromTokenIndex: number,
    toTokenIndex: number,
    context: SectionTransitionContext,
    evidenceStartTokenIndex?: EvidenceStartTokenIndex,
  ): boolean {
    return this.evaluate(fromTokenIndex, toTokenIndex, context, evidenceStartTokenIndex).eligible;
  }

  /* ----------------------------------------------------------------------- */

  /**
   * Positions forward progression may enter from `position`: the next section,
   * and then — only while each one it passes is heading-only — the one after
   * that. The walk stops at the first section with a body, so it can never
   * step over script the presenter has not read.
   *
   * `position < 0` is the pre-outline preamble; it may progress into the first
   * real section, which the old flat successor lookup silently prohibited.
   */
  private forwardPositions(position: number): number[] {
    const positions: number[] = [];
    for (let j = Math.max(0, position + 1); j < this.order.length; j++) {
      positions.push(j);
      if (this.headingOnlyByPosition[j] !== true) break;
    }
    return positions;
  }

  /** Mirror of `forwardPositions` for the backward boundary-retake edge. */
  private backwardPositions(position: number): number[] {
    const positions: number[] = [];
    for (let j = position - 1; j >= 0; j--) {
      positions.push(j);
      if (this.headingOnlyByPosition[j] !== true) break;
    }
    return positions;
  }

  /**
   * Did the transition leave the origin section *through its end boundary*?
   *
   * Two ways, and the second is what §13 actually means. Either the committed
   * cursor had already reached the corridor — the careful reader who paused at
   * the last full stop — or the matched evidence itself covers the section's
   * whole remaining tail: it began no further ahead of the cursor than the
   * corridor allows, and ran on past the section's last owned token. That is
   * one fluent sentence read through the boundary, and it demonstrably skipped
   * nothing, so it is progression through the end boundary in the only sense
   * that matters.
   *
   * The gap test (`evidenceStart - fromTokenIndex <= corridor`) is what keeps
   * this from becoming a licence: a candidate whose match begins far *ahead*
   * of the cursor has skipped the script in between, and is refused however
   * neatly it crosses the boundary afterwards — which is the D.4
   * distant-phrase collision, whose match begins inside the far section.
   *
   * A match beginning *behind* the cursor is fine and common: the rolling tail
   * holds several utterances, so an alignment routinely starts a section or
   * two back. What makes such a span admissible is that it is dense — the
   * caller offers `evidenceStartTokenIndex` only for an alignment that
   * actually matched most of the script it spans (see `HypothesisBeam`), so a
   * sparse match on two distant phrases cannot buy a boundary crossing.
   */
  private leftAtBoundary(
    position: number,
    fromTokenIndex: number,
    evidenceStartTokenIndex: EvidenceStartTokenIndex,
    windowTokens: number,
  ): boolean {
    if (position < 0) return true;
    if (this.order[position] === undefined) return true;
    const ownEnd = this.ownEnd(position);
    const corridor = this.corridor(position, windowTokens);
    if (ownEnd - fromTokenIndex <= corridor) return true;
    if (evidenceStartTokenIndex === undefined) return false;
    return (
      evidenceStartTokenIndex <= ownEnd &&
      evidenceStartTokenIndex - fromTokenIndex <= corridor
    );
  }

  /**
   * Where the evidence *entered* the destination section. When the match began
   * before the section started, the alignment walked in through the front door
   * and the entry point is the section's first token — no matter how far past
   * it the same fluent sentence ran.
   */
  private entryTokenIndex(
    position: number,
    toTokenIndex: number,
    evidenceStartTokenIndex: EvidenceStartTokenIndex,
  ): number {
    const start = this.order[position]?.startTokenIndex;
    if (evidenceStartTokenIndex === undefined || start === undefined) return toTokenIndex;
    return Math.max(start, Math.min(toTokenIndex, evidenceStartTokenIndex));
  }
}
