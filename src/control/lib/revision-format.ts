/**
 * Pure presentation helpers for the revision browser (spec §21.4).
 *
 * Kept out of the component so the labelling is unit-testable: this repo has
 * no jsdom, so anything that matters has to live in a plain module.
 *
 * The `reason` strings are written by Rust (`repo::create_revision_snapshot`
 * callers) and are the ONLY vocabulary that can appear:
 *   initial · autosave_interval · external_change ·
 *   external_change_preserved · before_restore · pre_session · import ·
 *   recovered
 * `REVISION_REASONS` is asserted against repo.rs by the Rust contract test, so
 * a new reason on the Rust side cannot quietly reach the UI as raw snake_case.
 */

export const REVISION_REASONS = [
  'initial',
  'autosave_interval',
  'external_change',
  'external_change_preserved',
  'before_restore',
  'pre_session',
  'import',
  'recovered',
] as const;

export type RevisionReason = (typeof REVISION_REASONS)[number];

const REASON_LABELS: Record<RevisionReason, string> = {
  initial: 'First version',
  autosave_interval: 'While editing',
  external_change: 'Changed outside CandidCue',
  external_change_preserved: 'Preserved outside edit',
  before_restore: 'Before a restore',
  pre_session: 'Before a session',
  import: 'Imported',
  // Indexed again from its file after a rebuild; why it was taken is gone.
  recovered: 'Recovered version',
};

/**
 * Human label for a snapshot reason. An unknown reason is humanised rather
 * than hidden — a revision the UI cannot name is still a revision the user
 * may need, and showing `some_new_reason` is more honest than showing
 * nothing or mislabelling it as an autosave.
 */
export function revisionReasonLabel(reason: string): string {
  const known = REASON_LABELS[reason as RevisionReason];
  if (known) return known;
  const words = reason.replace(/[_-]+/g, ' ').trim();
  if (words === '') return 'Saved version';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Word-count movement between a revision and the text that is open now.
 * `undefined` when the revision carries no count (older rows may not).
 * Positive = the revision has MORE words than the current text, i.e. restoring
 * it brings words back.
 */
export function revisionWordDelta(
  revisionWordCount: number | undefined,
  currentWordCount: number,
): number | undefined {
  if (revisionWordCount === undefined || !Number.isFinite(revisionWordCount)) return undefined;
  return revisionWordCount - currentWordCount;
}

/** "+128 words" / "−12 words" / "same length". */
export function formatWordDelta(delta: number | undefined): string {
  if (delta === undefined) return '';
  if (delta === 0) return 'same length';
  const magnitude = Math.abs(delta);
  const unit = magnitude === 1 ? 'word' : 'words';
  return `${delta > 0 ? '+' : '−'}${magnitude.toLocaleString()} ${unit}`;
}

/** Absolute clock/date for a revision row, e.g. "14:32" or "12 Mar, 14:32". */
export function revisionTimestamp(iso: string, nowMs: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const date = new Date(then);
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const sameDay = new Date(nowMs).toDateString() === date.toDateString();
  if (sameDay) return time;
  const day = date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return `${day}, ${time}`;
}

/**
 * Restoring is itself undoable: Rust's `restore_revision` routes through
 * `save_script` with `revision_reason: "before_restore"`, so the text being
 * replaced is snapshotted under the same per-script lock before it is
 * overwritten. This sentence is the UI's promise of that, and the Rust
 * contract test asserts the mechanism still exists.
 */
export const RESTORE_SAFETY_NOTE =
  'Your current text is saved as a revision first, so you can undo this.';
