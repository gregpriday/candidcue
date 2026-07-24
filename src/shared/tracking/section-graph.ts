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
 * v2 hypothesis beam, the semantic filter, and any Luna-assisted score — runs
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

  constructor(index: DocumentIndex, profile: TrackingProfile) {
    this.index = index;
    this.profile = profile;
    // `index.sections` is already sorted by start token; deeper subsections
    // are flattened into the same linear reading order, which is exactly the
    // order sequential progression walks.
    this.order = index.sections;
    this.order.forEach((section, position) => {
      if (!this.positionById.has(section.id)) this.positionById.set(section.id, position);
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
   * Clamp a boundary corridor so it can never span a large part of a short
   * section. Without this, a 60-token chapter with a 45-token corridor would
   * treat "anywhere past the first quarter" as "at the boundary", and the
   * sequential-progression edge would quietly become a general licence to
   * enter the next section.
   */
  private corridor(section: SectionSpan, windowTokens: number): number {
    const length = Math.max(1, section.endTokenIndex - section.startTokenIndex + 1);
    return Math.min(windowTokens, Math.max(1, Math.floor(length * this.profile.sectionBoundaryMaxFraction)));
  }

  /** Is `tokenIndex` within `windowTokens` of its section's last token? */
  isNearSectionEnd(tokenIndex: number, windowTokens = this.profile.sectionBoundaryForwardTokens) {
    const section = this.index.sectionAt(tokenIndex);
    if (section === undefined) return true;
    return section.endTokenIndex - tokenIndex <= this.corridor(section, windowTokens);
  }

  /** Is `tokenIndex` within `windowTokens` of its section's first token? */
  isNearSectionStart(tokenIndex: number, windowTokens = this.profile.sectionBoundaryForwardTokens) {
    const section = this.index.sectionAt(tokenIndex);
    if (section === undefined) return true;
    return tokenIndex - section.startTokenIndex <= this.corridor(section, windowTokens);
  }

  /**
   * Appendix B.2 `isEligibleTransition`, expressed over token indexes.
   * Returns the reason as well as the verdict so diagnostics can explain the
   * gate (§65 `sectionGate`) without re-deriving it.
   */
  evaluate(
    fromTokenIndex: number,
    toTokenIndex: number,
    context: SectionTransitionContext,
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

    // Sequential progression through the current end boundary (§13, §13.2:
    // a non-spoken heading between the two does not have to be spoken).
    if (
      toSectionId === this.nextSectionId(fromSectionId) &&
      this.isNearSectionEnd(fromTokenIndex, this.profile.sectionBoundaryForwardTokens) &&
      this.isNearSectionStart(toTokenIndex, this.profile.sectionBoundaryForwardTokens)
    ) {
      return decide(true, 'sequential_next');
    }

    // Retake across a *just crossed* boundary (§13, §21.2 "previous section
    // near a just-crossed boundary: very high threshold").
    if (
      toSectionId === this.previousSectionId(fromSectionId) &&
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
  ): boolean {
    return this.evaluate(fromTokenIndex, toTokenIndex, context).eligible;
  }
}
