/**
 * Word normalization for the critical-term comparator (§19.2, §25.5).
 *
 * This deliberately does **not** reuse `tracking/normalize.ts`. That pipeline
 * strips `,` and `.` as sentence punctuation, which turns `1,500` into the two
 * words `1 500` and `3.14` into `3 14`. For alignment that is harmless; for a
 * comparator whose entire job is to decide whether a *number* was read
 * correctly it is fatal — the authored value would be destroyed before it was
 * ever compared, and the comparator would either miss real errors or invent
 * fake ones.
 *
 * The rules here are therefore numeric-preserving:
 * - thousands separators inside digit runs are removed (`1,500` → `1500`);
 * - a decimal point between digits survives (`3.14` stays one word);
 * - `%` becomes the word `percent`, on both sides, so `50%` and
 *   `fifty percent` reach the comparator in the same shape;
 * - a currency sign becomes a currency *word*, so `$1,500` and
 *   `one thousand five hundred dollars` reach the comparator with the same
 *   words in them;
 * - contractions keep their apostrophe, because `don't` carries a negation and
 *   must stay recognisable as such.
 *
 * Everything else that cannot change lexical identity is discarded.
 */

const SMART_SINGLE = /[‘’‚‛′ʼ]/g;
const SMART_DOUBLE = /[“”„‟″]/g;
const DASHES = /[‐‑‒–—―−]/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** Sentinel standing in for a protected decimal point during punctuation strip. */
const DECIMAL_SENTINEL = '\u0001';

/** Currency symbols expanded to a trailing unit word. */
const CURRENCY_PATTERN = /([$£€¥])\s*(?=\d)/g;
const CURRENCY_WORDS: Readonly<Record<string, string>> = {
  $: 'dollars',
  '£': 'pounds',
  '€': 'euros',
  '¥': 'yen',
};

/**
 * One normalized word plus a back-reference to the token it came from.
 *
 * The back-reference is what lets the comparator quote **exact authored
 * surface text** (§25.5) after matching on normalized forms: a single authored
 * token such as `50%` expands to two normalized words, and without the link we
 * could only quote the normalized form back at the presenter.
 */
export interface NormalWord {
  /** Normalized, lowercased word. Never empty. */
  word: string;
  /** Index into the caller's token array this word was derived from. */
  sourceIndex: number;
}

/**
 * Normalize a single token surface into zero or more comparison words.
 *
 * Zero words is a legitimate result (pure punctuation), and callers must cope
 * with it rather than assuming a 1:1 token↔word mapping.
 */
export function normalizeSurface(surface: string): string[] {
  let text = surface
    .normalize('NFKC')
    .replace(CONTROL, ' ')
    .replace(SMART_SINGLE, "'")
    .replace(SMART_DOUBLE, '"')
    .replace(DASHES, '-')
    .toLowerCase();

  // The currency sign becomes a word emitted *before* the number rather than
  // after it. Emitting it after would sit between the number and a following
  // scale word — `$50 million` would normalize to `50 dollars million` and the
  // parser would read the value as 50, not 50 000 000, turning a correct
  // reading into a fabricated mismatch. Position does not otherwise matter:
  // every check in this subsystem is containment-based, not positional.
  const leadingUnits: string[] = [];
  text = text.replace(CURRENCY_PATTERN, (_match, symbol: string) => {
    const word = CURRENCY_WORDS[symbol];
    if (word !== undefined) leadingUnits.push(word);
    return '';
  });

  text = text.replace(/%/g, ' percent ');
  text = text.replace(/&/g, ' and ');

  // Thousands separators inside a digit run disappear; a decimal point between
  // digits is parked on a sentinel so the punctuation strip cannot eat it.
  text = text.replace(/(\d),(?=\d{3}(?!\d))/g, '$1');
  text = text.replace(/(\d)\.(?=\d)/g, `$1${DECIMAL_SENTINEL}`);

  // Everything that cannot change lexical identity becomes a separator.
  text = text.replace(/[^\p{L}\p{N}' -]+/gu, ' ');
  text = text.replace(/-/g, ' ');
  // Apostrophes only survive inside a word (contractions).
  text = text.replace(/(^|\s)'+/g, '$1').replace(/'+(?=\s|$)/g, '');
  text = text.split(DECIMAL_SENTINEL).join('.');

  const words = text.split(/\s+/).filter((word) => word.length > 0);
  return leadingUnits.length === 0 ? words : [...leadingUnits, ...words];
}

/** Normalize a token array into a flat word stream with back-references. */
export function toWordStream(surfaces: readonly string[]): NormalWord[] {
  const out: NormalWord[] = [];
  for (let index = 0; index < surfaces.length; index++) {
    const surface = surfaces[index];
    if (surface === undefined) continue;
    for (const word of normalizeSurface(surface)) {
      out.push({ word, sourceIndex: index });
    }
  }
  return out;
}

/** Normalize a free-text string into comparison words. */
export function normalizeWords(text: string): string[] {
  const out: string[] = [];
  for (const chunk of text.split(/\s+/)) {
    if (chunk.length === 0) continue;
    out.push(...normalizeSurface(chunk));
  }
  return out;
}

/**
 * §25.5 "use exact authored text, escaped and length-limited".
 *
 * This is the sanitizing half: control characters removed, whitespace
 * collapsed, and a hard character cap. It is applied to every fragment the
 * comparator puts on a candidate, so a downstream tip layer cannot accidentally
 * interpolate a multi-line or unbounded excerpt into the rail. HTML escaping is
 * deliberately *not* done here — the rail renders text nodes, and
 * double-escaping would show `&amp;` to the presenter.
 */
export function safeFragment(text: string, maxChars = 64): string {
  const cleaned = text.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
