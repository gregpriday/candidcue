/**
 * Sentence segmentation (spec §25.5) with exceptions for abbreviations,
 * decimals, initials, URLs, and honorifics. Used for manual navigation and
 * retake heuristics; covered by golden tests.
 */

export interface SentenceRange {
  /** Inclusive UTF-16 start offset within the input text. */
  start: number;
  /** Exclusive UTF-16 end offset within the input text. */
  end: number;
  text: string;
}

/** Words after which a period does not end a sentence. */
const NON_TERMINAL_ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'jr', 'sr', 'vs', 'etc', 'e.g', 'eg',
  'i.e', 'ie', 'no', 'dept', 'approx', 'fig', 'al', 'inc', 'ltd', 'co', 'corp',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sept', 'sep', 'oct', 'nov',
  'dec', 'mon', 'tue', 'tues', 'wed', 'thu', 'thurs', 'fri', 'sat', 'sun',
  'a.m', 'p.m', 'am', 'pm', 'u.s', 'u.k', 'ph.d', 'min', 'max', 'sec', 'ft',
]);

function isUrlContext(text: string, dotIndex: number): boolean {
  // Walk back to the nearest whitespace; if that run contains "://" or
  // "www." or the dot is directly followed by a letter (example.com), the
  // dot is part of a URL/domain, not a sentence terminator.
  let start = dotIndex;
  while (start > 0 && !/\s/.test(text.charAt(start - 1))) start--;
  const run = text.slice(start, dotIndex + 1);
  return run.includes('://') || /(^|\.)www\./i.test(run) || run.includes('@');
}

function wordBefore(text: string, index: number): string {
  let end = index;
  let start = end;
  while (start > 0 && /[\p{L}\p{N}.'']/u.test(text.charAt(start - 1))) start--;
  return text.slice(start, end);
}

/**
 * Split `text` into sentence ranges. Never merges across newlines that the
 * caller marked as structural; the caller passes one block's spoken text.
 */
export function segmentSentences(text: string): SentenceRange[] {
  const ranges: SentenceRange[] = [];
  const len = text.length;
  let sentenceStart = 0;

  const push = (start: number, end: number) => {
    // Trim whitespace from both ends but keep offsets accurate.
    let s = start;
    let e = end;
    while (s < e && /\s/.test(text.charAt(s))) s++;
    while (e > s && /\s/.test(text.charAt(e - 1))) e--;
    if (e > s) ranges.push({ start: s, end: e, text: text.slice(s, e) });
  };

  for (let i = 0; i < len; i++) {
    const ch = text.charAt(i);
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;

    if (ch === '.') {
      const prev = text.charAt(i - 1);
      const next = text.charAt(i + 1);
      // Decimal number: 3.14 — not a boundary.
      if (/\d/.test(prev) && /\d/.test(next)) continue;
      // Ellipsis or run of dots: advance to the last dot and treat as one.
      if (next === '.') continue;
      // URL/domain/email context.
      if (isUrlContext(text, i)) continue;

      const word = wordBefore(text, i).toLowerCase().replace(/\.$/, '');
      // Abbreviations and honorifics: "Mr. Smith" is one fragment.
      if (NON_TERMINAL_ABBREVIATIONS.has(word)) continue;
      // Single-letter initials: "J. K. Rowling".
      if (/^\p{Lu}$/u.test(wordBefore(text, i))) continue;
      // Dotted acronym: "U.S.A." — the final dot ends the sentence only
      // when what follows looks like a new sentence (uppercase start).
      if (/^\p{L}(\.\p{L})+$/u.test(wordBefore(text, i))) {
        const after = text.slice(i + 1);
        if (/^\p{L}\./u.test(after)) continue; // acronym continues
        const nextWord = /^[\s"'")\]]*(.)/u.exec(after);
        if (nextWord && nextWord[1] && !/[\p{Lu}]/u.test(nextWord[1])) continue;
      }
    }

    // Consume trailing terminators and closing quotes/brackets.
    let end = i + 1;
    while (end < len && /[.!?]/.test(text.charAt(end))) end++;
    while (end < len && /["')\]”’]/.test(text.charAt(end))) end++;

    // Boundary requires end-of-text or following whitespace.
    if (end < len && !/\s/.test(text.charAt(end))) {
      i = end - 1;
      continue;
    }

    push(sentenceStart, end);
    sentenceStart = end;
    i = end - 1;
  }

  if (sentenceStart < len) push(sentenceStart, len);
  return ranges;
}
