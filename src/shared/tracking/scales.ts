/**
 * Structure-relative distances (companion §13, §31.6, §31.8, §31.11).
 *
 * Almost every distance in `TrackingProfile` started life as an absolute token
 * count taken from a spec appendix written against a script with long
 * chapters. Applied to a real script that is a stack of thirty-token beats,
 * those constants stop meaning what they say:
 *
 *   - `largeForwardDistance: 40` is two thirds of a sixty-token section, so
 *     "a large forward skip" and "ordinary reading" become the same thing, and
 *     `updateOffScript`'s `nearCursor` test is true for essentially the whole
 *     section — which leaves `offScript` (hence `adlib_hold` vs `lost_local`,
 *     hence pace-contamination flagging) decided by confidence alone;
 *   - `continuityForwardTokens: 260` spans four chapters, so the "continuity"
 *     window is not a continuity window;
 *   - `maxProvisionalAdvanceTokens: 18` exceeds the entire 14-token boundary
 *     corridor, so provisional evidence can advance further than the corridor
 *     that is supposed to bound where a section may legally be left.
 *
 * `SectionGraph.corridor` already solved this for one parameter by clamping it
 * to a fraction of the enclosing section. This module generalizes that shape so
 * the rest of the engine can be scaled the same way:
 *
 *     value = min(absoluteCap, max(1, floor(enclosingLength × fraction)))
 *
 * The absolute value stays the ceiling — it is still the right answer on a long
 * section — and the fraction takes over exactly when the structure is smaller
 * than the constant assumed.
 */
import type { DocumentIndex } from './document-index';

/** Clamp `absoluteCap` to `fraction` of a span of `length` tokens. */
export function scaleToLength(absoluteCap: number, length: number, fraction: number): number {
  const span = Math.max(1, Math.floor(length));
  const scaled = Math.max(1, Math.floor(span * fraction));
  return Math.max(1, Math.min(Math.floor(absoluteCap), scaled));
}

/** `absoluteCap`, clamped to a fraction of the section owning `tokenIndex`. */
export function scaleToSection(
  index: DocumentIndex,
  tokenIndex: number,
  absoluteCap: number,
  fraction: number,
): number {
  const section = index.sectionAt(tokenIndex);
  if (section === undefined) return Math.max(1, Math.floor(absoluteCap));
  return scaleToLength(
    absoluteCap,
    section.endTokenIndex - section.startTokenIndex + 1,
    fraction,
  );
}

/**
 * `absoluteCap`, clamped to a fraction of the sentence owning `tokenIndex`.
 *
 * Currently unused by the engine and kept deliberately. Sentence-relative
 * scaling was tried for `maxProvisionalAdvanceTokens` and reverted: sentences
 * in real scripts run ~10 tokens, so any useful fraction collapses the bound
 * to 2–3 tokens and the provisional cursor stops leading the reader between
 * completions at all. The helper stays because sentence-relative *is* the
 * right structure for anything scoped to a clause (e.g. `maxLeadTokens`,
 * `retakeBoundaryToleranceTokens`) — but nothing has been converted without a
 * scenario proving it.
 */
export function scaleToSentence(
  index: DocumentIndex,
  tokenIndex: number,
  absoluteCap: number,
  fraction: number,
): number {
  const sentence = index.sentenceAt(tokenIndex);
  if (sentence === undefined) return Math.max(1, Math.floor(absoluteCap));
  return scaleToLength(
    absoluteCap,
    sentence.endTokenIndex - sentence.startTokenIndex + 1,
    fraction,
  );
}
