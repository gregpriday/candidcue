/**
 * The tail of the recogniser's text, for the stage's transcript bar.
 *
 * ---------------------------------------------------------------------------
 * WHY THE BAR CROPS AT ALL
 * ---------------------------------------------------------------------------
 * The bar answers one question — "is Speaking Glass hearing me?" — and it answers it
 * with the words that just arrived. Everything before those is answered
 * already: a presenter reading a sentence they finished twenty seconds ago
 * learns nothing they did not learn when it appeared.
 *
 * It used to carry the whole utterance and lean on `overflow: hidden` to hide
 * the excess, which works on the glass and nowhere else. The element still
 * LAID OUT at the full width of everything said since the last finalisation —
 * on a long one that is a strip of text running the width of the panel, under a
 * script somebody is reading, with the newest words pinned to the far edge away
 * from the corner the presenter's eye already checks.
 *
 * So the crop is real rather than visual: a fixed number of words, and a
 * bounded box to put them in. The two do different jobs and both are needed —
 * ten short words are narrow and ten long ones are not, and a box with no word
 * limit fills with whatever fits rather than with what was just said.
 *
 * Pure, and separate from the component, because "which words" is a decision
 * with edges (no words at all, one enormous word, text that is nothing but
 * whitespace) and none of those are worth mounting a stage to check.
 */

import { STAGE_TRANSCRIPT_TAP_WORDS } from '../../shared/contracts';

/**
 * How many words the bar carries.
 *
 * The contract's number, not a second opinion about it: control trims its
 * rolling window to the same bound before the tap is even sent, and the two
 * cropping the same text to different lengths is how one of them quietly stops
 * mattering. See `STAGE_TRANSCRIPT_TAP_WORDS`.
 */
export const TRANSCRIPT_TAIL_WORDS = STAGE_TRANSCRIPT_TAP_WORDS;

/**
 * The last `maxWords` words of `text`, whitespace normalised.
 *
 * Normalising is part of the job rather than tidiness: recogniser text arrives
 * with the spacing of whatever produced it — leading spaces on continuation
 * partials, doubled spaces where a finalisation was stitched onto a partial,
 * and occasionally a newline. Rendered in a `nowrap` bar those become gaps that
 * read as missing words.
 *
 * WHAT THIS DOES NOT DO: segment text that is not written with spaces. Chinese
 * and Japanese recogniser output arrives as one run, counts as one "word", and
 * is passed through for the bar's `max-width` and `overflow: hidden` to clip on
 * the right — which is the same newest-first reading, arrived at by geometry
 * instead of by counting. That is a deliberate floor rather than an oversight:
 * `Intl.Segmenter` would give real words, and it would also make what the bar
 * shows depend on a locale nothing here knows. The pixel clip is honest in
 * every language.
 */
export function transcriptTail(text: string, maxWords: number = TRANSCRIPT_TAIL_WORDS): string {
  if (typeof text !== 'string') return '';
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return '';
  /*
   * A limit below one whole word means "do not crop" rather than "show
   * nothing": an empty bar is indistinguishable from a dead recogniser, which
   * is the one thing this element exists not to be.
   *
   * `< 1` rather than `<= 0`, because the floor below turns anything in (0, 1)
   * into a zero — and `slice(-0)` is `slice(0)`, which returns EVERY word. The
   * degenerate input would otherwise land on the one answer neither branch
   * intends.
   */
  if (!Number.isFinite(maxWords) || maxWords < 1) return words.join(' ');
  return words.slice(-Math.floor(maxWords)).join(' ');
}
