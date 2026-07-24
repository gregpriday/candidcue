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

// A token starts with a letter/digit/$/# and continues through characters
// that can appear inside words: letters, digits, dots (acronyms, decimals),
// commas (thousands), apostrophes, hyphens, %, &. Standalone '&' is a token.
const TOKEN_PATTERN =
  /[\p{L}\p{N}$#][\p{L}\p{N}.,''’\-%&]*[\p{L}\p{N}%]|[\p{L}\p{N}]|&/gu;

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
