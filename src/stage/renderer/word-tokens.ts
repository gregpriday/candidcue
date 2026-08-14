/**
 * One rule for "which spoken token is this word?", shared by the two places
 * that ask.
 *
 * `segmentText` asks it to draw the word spans the tracker positions and the
 * dimming grades; `flattenWords` asks it to decide where a line may legally
 * break, because a break is keyed by token index and drawn by looking that
 * index up on a span. The two answers have to be the same answer — a planner
 * that thinks a word carries a token the renderer cannot find plans a break
 * that is never drawn — so the rule lives here rather than being written out
 * twice and kept in step by comment.
 *
 * No imports on purpose: both callers reach it, and neither pays for the
 * other's dependencies.
 */

/**
 * The token each word anchors, or null where it anchors none.
 *
 * Three sources, in descending order of how much they know:
 *
 *  1. `wordTokens` — the compiler's own word-by-word mapping. It is the only
 *     one that can be right about a word that is written but not spoken (an em
 *     dash) or a word said as several tokens (`API` said "a p i"), and it is
 *     built where those facts are still known.
 *  2. `tokenIndexes` zipped against the words, when there are exactly as many
 *     of them as there are words. That is the pre-existing rule, kept for
 *     documents compiled before `wordTokens` existed and for the hand-built
 *     nodes throughout the test suites, where every word is a token and the two
 *     agree by construction.
 *  3. The run's first index on the run's first word, and nothing else. The
 *     mapping cannot be trusted positionally, so the most that can honestly be
 *     claimed is where the run starts.
 */
export function resolveWordTokens(
  wordCount: number,
  tokenIndexes?: readonly number[],
  wordTokens?: readonly (number | null)[],
): (number | null)[] {
  const out: (number | null)[] = new Array(wordCount).fill(null);
  if (wordCount === 0) return out;
  if (wordTokens && wordTokens.length === wordCount) {
    for (let i = 0; i < wordCount; i++) out[i] = wordTokens[i] ?? null;
    return out;
  }
  if (!tokenIndexes || tokenIndexes.length === 0) return out;
  if (tokenIndexes.length === wordCount) {
    for (let i = 0; i < wordCount; i++) out[i] = tokenIndexes[i] ?? null;
    return out;
  }
  out[0] = tokenIndexes[0] ?? null;
  return out;
}
