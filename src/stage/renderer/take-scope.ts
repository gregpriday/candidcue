/**
 * What the glass says this reading IS (#241): a rehearsal, a part, or both.
 *
 * A practice and a take used to look identical while reading — the only word
 * that told them apart was the dock's exit control, which hides with the dock —
 * and the part a take was recording was readable only in a drawer closed over
 * the script. The glass is the one place the presenter is looking, so the
 * answer goes there, as one quiet line in a corner.
 *
 * Pure, so the wording is testable without a stage. Null means "say nothing":
 * an ordinary take of the whole script is the case that needs no label.
 */

/** The part a take or practice is of, as the stage needs it. */
export interface TakeScopePart {
  ordinal: number;
  totalParts: number;
  label: string;
}

export interface TakeScopeText {
  /** "Practising", "Part 2 of 5", or "Practising · Part 2 of 5". */
  lead: string;
  /** The part's own name, which may be long and is the piece that truncates. */
  name: string | null;
  /** Set once the confirmed position has reached the part's end. */
  done: string | null;
}

export function takeScopeText(
  practice: boolean,
  part: TakeScopePart | null | undefined,
  partComplete: boolean,
): TakeScopeText | null {
  if (!practice && !part) return null;
  const lead = [
    practice ? 'Practising' : null,
    part ? `Part ${part.ordinal} of ${part.totalParts}` : null,
  ]
    .filter((s): s is string => s !== null)
    .join(' · ');
  const name = part && part.label.trim() !== '' ? part.label.trim() : null;
  return { lead, name, done: part && partComplete ? 'end reached' : null };
}
