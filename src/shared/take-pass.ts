/**
 * The one place a take-pass identity is minted (§11.3, §36.3, §5.4).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * Three lanes used to mint three different strings and call all of them
 * `takePassId`:
 *
 *   - the coaching lane stamped `` `${sessionId}:1` `` once at session start
 *     and never advanced it, so every retake accumulated into pass 1;
 *   - the §36.3 take history minted `` `${sessionId}:${passOrdinal}` `` and
 *     *did* advance it, and those rows are persisted in `session_takes`;
 *   - the alignment layer minted a third, three-part string of its own.
 *
 * Take-scoped state — confirmed filler counts, ribbon events, gutter marks,
 * coaching reports, take history rows — is keyed on this value, so a retake
 * reconciled in one lane and not the others: the take history opened a new
 * pass while the coaching rail kept counting the old one.
 *
 * `${sessionId}:${passOrdinal}` is authoritative because it is the only one of
 * the three that is already **on disk**. A `session_takes` row written by an
 * earlier build carries it, review reports are correlated by it, and a scheme
 * change would silently orphan every historical row. It is also the only one
 * that carries the fact that actually distinguishes two passes — which pass
 * this is — rather than a tracking coordinate that moves *within* a pass.
 *
 * ---------------------------------------------------------------------------
 * ONE MINTING FUNCTION, NOT ONE CONVENTION
 * ---------------------------------------------------------------------------
 * The lanes agreed on the string by coincidence before, because each of them
 * open-coded the same template literal. Coincidence is what let them drift.
 * Every producer now calls {@link takePassIdFor}; a lane that wants a take
 * pass supplies the ordinal and cannot supply a string at all.
 */

/**
 * The ordinal of the first pass of a session.
 *
 * One-based, not zero-based: it is presenter-facing ("take 3"), and the
 * persisted rows already count from 1.
 */
export const FIRST_TAKE_PASS_ORDINAL = 1;

/**
 * The take-pass identity for `passOrdinal` of `sessionId`.
 *
 * The ordinal is coerced to a whole number at or above
 * {@link FIRST_TAKE_PASS_ORDINAL}: a fractional or zero ordinal is a caller
 * defect, and minting `session:0.5` would produce an id that looks valid,
 * compares unequal to everything, and silently discards a take's evidence.
 */
export function takePassIdFor(sessionId: string, passOrdinal: number): string {
  return `${sessionId}:${normalizeOrdinal(passOrdinal)}`;
}

/** The next pass after `passOrdinal`. */
export function nextTakePassOrdinal(passOrdinal: number): number {
  return normalizeOrdinal(passOrdinal) + 1;
}

/**
 * The `(sessionId, passOrdinal)` pair inside a take-pass id, or `null`.
 *
 * The session id is everything before the **last** colon, because a session id
 * is opaque to this module and a future one containing a colon must not be
 * silently truncated.
 */
export function parseTakePassId(
  takePassId: string,
): { sessionId: string; passOrdinal: number } | null {
  const at = takePassId.lastIndexOf(':');
  if (at <= 0 || at === takePassId.length - 1) return null;
  const ordinalText = takePassId.slice(at + 1);
  if (!/^[0-9]+$/u.test(ordinalText)) return null;
  const passOrdinal = Number.parseInt(ordinalText, 10);
  if (passOrdinal < FIRST_TAKE_PASS_ORDINAL) return null;
  return { sessionId: takePassId.slice(0, at), passOrdinal };
}

/**
 * The ordinal `takePassIdFor` would actually mint for `passOrdinal`.
 *
 * Exported so a caller that keeps its own copy of "which pass am I on" cannot
 * end up reporting an ordinal its own id does not contain.
 */
export function normalizeTakePassOrdinal(passOrdinal: number): number {
  return normalizeOrdinal(passOrdinal);
}

function normalizeOrdinal(passOrdinal: number): number {
  if (!Number.isFinite(passOrdinal)) return FIRST_TAKE_PASS_ORDINAL;
  return Math.max(FIRST_TAKE_PASS_ORDINAL, Math.floor(passOrdinal));
}
