/**
 * What the take summary offers next, as rows (CCUX-006, CCUX-008, §parts).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT MARKUP
 * ---------------------------------------------------------------------------
 * `present-menu.ts` already makes this argument for the launch menu and it
 * holds harder here: the footer of this dialog is a MATRIX, not a list. Whether
 * a row appears depends on three independent facts — was the take bounded to a
 * part, did the presenter reach the end of it, and is there another part after
 * it — and one property has to hold across all eight combinations: exactly one
 * row is the primary action.
 *
 * Written as `{#if}` blocks that was not checkable and duly broke. The last
 * part of a script, read to the end, promoted no next part (there is none) and
 * suppressed "Present again" (the take was bounded), so a presenter finishing a
 * script was handed a dialog with nothing highlighted at all. Nothing in a
 * green suite of 2,800 tests could see it, because it was a shape made of four
 * conditionals in a snippet.
 *
 * So the decision is here and the component renders what it is given.
 */
import type { SessionSummary, TakePart } from '../stores/session';

export interface SummaryActionsInput {
  /**
   * The start of the section the take ended in (CCUX-008), or null when it
   * ended above the first heading.
   */
  retrySectionTokenIndex: number | null;
  /** The part this take was recording, or null for an unbounded take. */
  part: TakePart | null;
  /**
   * The take reached the end of that part — read there, or carried there by
   * the auto-scroll transport. Either way it is not a part somebody abandoned,
   * and the next one is what to offer.
   */
  partComplete: boolean;
  /** The part after it, or null when it was the last one. */
  nextPart: TakePart | null;
}

export interface SummaryAction {
  /** Stable identity, for tests and for keying the rendered list. */
  id: 'retry-section' | 'record-part-again' | 'record-next-part' | 'present-again';
  label: string;
  /** Exactly one row carries `primary`. */
  primary: boolean;
  /**
   * Where the take it starts begins. `partId` is identity only — `startTake`
   * re-resolves the span against the compile the new take runs on — and a row
   * that carries one records the WHOLE part (`SessionSummary` says `whole`), so
   * it opens at the part's re-measured start. Its token is then only where to
   * open if the part can no longer be found.
   */
  startTokenIndex?: number;
  partId?: string;
}

export function summaryActions(input: SummaryActionsInput): SummaryAction[] {
  const { part, partComplete, nextPart } = input;
  const actions: SummaryAction[] = [];

  /*
   * "Retry last section" is hidden for a part-bounded take. The part IS the
   * section somebody would be retrying, and the row below already offers it by
   * name — two buttons that start almost the same take is the failure this
   * dialog's own copy keeps warning about.
   */
  if (input.retrySectionTokenIndex !== null && part === null) {
    actions.push({
      id: 'retry-section',
      label: 'Retry last section',
      primary: false,
      startTokenIndex: input.retrySectionTokenIndex,
    });
  }

  /*
   * Retrying THIS part is the primary action for a bounded take that stopped
   * short of the end, which is very nearly the definition of the case: somebody
   * who launched part three and did not finish it fumbled a line. Leaving the
   * whole script highlighted instead offered a forty-minute read as the default
   * response to a botched sentence.
   */
  const retryIsPrimary = part !== null && !partComplete;
  if (part !== null) {
    actions.push({
      id: 'record-part-again',
      label: `Record part ${part.ordinal} again`,
      primary: retryIsPrimary,
      startTokenIndex: part.startTokenIndex,
      partId: part.id,
    });
  }

  /*
   * The next part is promoted to primary only once this one is actually
   * covered. A take stopped halfway through part three is far more likely to be
   * a fumbled line than a finished segment, and highlighting "record part four"
   * there would put the choice that leaves a gap under the presenter's thumb by
   * default.
   */
  const nextIsPrimary = nextPart !== null && partComplete;

  if (nextPart !== null) {
    actions.push({
      id: 'record-next-part',
      label: `Record “${nextPart.label}” next`,
      primary: nextIsPrimary,
      startTokenIndex: nextPart.startTokenIndex,
      partId: nextPart.id,
    });
  }

  /*
   * The whole script from the top, and the fallback primary.
   *
   * It stands down entirely once a part has claimed the highlight — the next
   * one for a finished take, this one for an unfinished take. Somebody who has
   * just recorded part two of seven is not about to read all seven, and this
   * dialog's footer is narrow enough that a fifth button would wrap; the way
   * back to the whole script is "Back to the script", which is right there.
   *
   * The condition is written as "has anything else claimed primary" rather than
   * as "was this take bounded", and the difference is the bug this module was
   * extracted to make visible: the last part of a script, read to the end, has
   * no next part to promote, so a rule phrased the other way left a finished
   * run looking at a dialog with nothing highlighted at all.
   */
  const claimed = nextIsPrimary || retryIsPrimary;
  if (!claimed) {
    actions.push({ id: 'present-again', label: 'Present again', primary: true });
  }

  return actions;
}

/**
 * What the summary's Part row says about how far the take got (§parts, #276).
 *
 * Null means say nothing, and that is the answer for a manual or fixed-speed
 * take that the transport did not carry to the end: `partComplete` is raised
 * by alignment snapshots and by the transport running off the end, and a take
 * with neither has produced no evidence either way — "stopped part way" would
 * not be a cautious answer there but a wrong one.
 *
 * The transport comes first, and in any mode. It is the one case the take can
 * be described in without guessing, because the glass itself went to the end;
 * and it is kept apart from "read to the end" because the transport moving the
 * script past the reading band says nothing about anybody speaking it. A voice
 * take that fell back to auto-scroll is still a `voice` take, which is exactly
 * why this cannot be decided from the mode alone.
 */
export function partOutcomeLabel(
  summary: Pick<SessionSummary, 'mode' | 'partComplete' | 'partRolledToEnd'>,
): string | null {
  if (summary.partRolledToEnd) return '— carried to the end by auto-scroll';
  if (summary.mode !== 'voice') return null;
  return summary.partComplete ? '— read to the end' : '— stopped part way';
}
