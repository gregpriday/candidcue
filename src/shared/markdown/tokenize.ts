/**
 * Word-level tokenization of spoken text runs. Produces surface tokens with
 * UTF-16 offsets relative to the input string; the compiler rebases them to
 * absolute source offsets. Pure punctuation never becomes a token (it would
 * carry weight 0 per spec §25.7 and adds no anchor value).
 */

export interface RawToken {
  surface: string;
  /** UTF-16 offset range within the input string. */
  start: number;
  end: number;
}

// A token starts with a letter/digit/currency/# and continues through characters
// that can appear inside words: letters, digits, dots (acronyms, decimals),
// commas (thousands), apostrophes, hyphens, %, &. Standalone '&' is a token.
//
// NOTE: every alternative ends on `[\p{L}\p{N}%]`, `[\p{L}\p{N}]` or `&`, so a
// surface produced here can never end in a dot — "Dr." arrives downstream as
// "Dr", "U.S.A." as "U.S.A". `normalize.ts`'s abbreviation dictionary depends
// on the surface carrying the dot, so it only ever fires for interior-dot
// forms like "e.g."; the honorifics it was mostly written for are unreachable.
// Closing that gap means keeping the trailing dot when the dot-stripped form
// is a known abbreviation, which widens `SpokenToken.surface` and its source
// range by one character wherever tokens are rendered — deliberately not done
// here as a side effect of a comment.
//
// The currency symbols are all three, not just `$`. The alignment engine reads
// `£20` as "twenty pounds" — the way a presenter says it — but only if the
// symbol reaches it, and a leading class of `$` alone silently dropped `£` and
// `€` from the token surface. The engine then had nothing to expand, the
// presenter said "pounds", and the word had nothing to match. Keeping the
// symbol in the token also means the underline covers `£20` rather than
// leaving the symbol outside the word it belongs to.
const TOKEN_PATTERN =
  /[\p{L}\p{N}$£€#][\p{L}\p{N}.,''’\-%&]*[\p{L}\p{N}%]|[\p{L}\p{N}]|&/gu;

export function tokenizeText(text: string): RawToken[] {
  const tokens: RawToken[] = [];
  TOKEN_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_PATTERN.exec(text)) !== null) {
    let surface = match[0];
    let start = match.index;
    // Trailing sentence punctuation the pattern may have swallowed via
    // dot/comma continuation ("end." matches through the final letter only,
    // but "U.S.A." keeps its final dot out — trim defensive commas/dots that
    // are not part of a number or acronym).
    while (surface.length > 1 && /[.,]$/.test(surface)) {
      const prev = surface.charAt(surface.length - 2);
      if (/[\p{N}]/u.test(prev) || /^\p{L}(\.\p{L})+\.?$/u.test(surface)) break;
      surface = surface.slice(0, -1);
    }
    if (!surface) continue;
    tokens.push({ surface, start, end: start + surface.length });
  }
  return tokens;
}
