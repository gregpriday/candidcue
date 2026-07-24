/**
 * Transcript-side normalization (spec §25.4 baseline pipeline, applied to
 * live transcript text). Deterministic and pure — the same input always
 * produces the same tokens, and normalizing normalized output is idempotent.
 */

const SMART_QUOTES = /[‘’ʼ]/g;
const SMART_DOUBLE = /[“”]/g;
const DASHES = /[‐-―−]/g;
/** Punctuation that never changes lexical identity (spec §25.4 step 5). */
const STRIP_PUNCTUATION = /[.,!?;:()[\]{}"“”…*_`~<>|\\/]/g;

export function normalizeText(text: string): string {
  let out = text.normalize('NFKC');
  out = out.replace(SMART_QUOTES, "'").replace(SMART_DOUBLE, '"');
  out = out.toLocaleLowerCase('en-US');
  out = out.replace(DASHES, '-');
  out = out.replace(/%/g, ' percent ');
  out = out.replace(/&/g, ' and ');
  out = out.replace(STRIP_PUNCTUATION, ' ');
  // Hyphens become spaces so "forty-two" tokenizes like "forty two".
  out = out.replace(/-/g, ' ');
  // Strip apostrophes that are not intra-word (keep contractions).
  // Lookarounds keep boundaries unconsumed so the pass is idempotent.
  out = out.replace(/(?<=^|\s)'+|'+(?=\s|$)/g, '');
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}

/** Split normalized text into word tokens. */
export function tokenizeNormalized(text: string): string[] {
  const normalized = normalizeText(text);
  return normalized.length === 0 ? [] : normalized.split(' ');
}

/* ---------------------------------------------------------------------------
 * Stopwords, fillers (spec §30.6), and small equivalence dictionaries.
 * ------------------------------------------------------------------------- */

export const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'by',
  'for', 'with', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'am', 'it',
  'its', "it's", 'this', 'that', 'these', 'those', 'i', 'you', 'we', 'they',
  'he', 'she', 'my', 'your', 'our', 'their', 'me', 'us', 'him', 'her', 'do',
  'does', 'did', 'have', 'has', 'had', 'will', 'would', 'can', 'could',
  'should', 'not', 'no', 'so', 'if', 'then', 'than', 'there', 'here', 'up',
  'down', 'out', 'about', 'into', 'over', 'just', 'very',
]);

/** Single-token fillers (spec §30.6). */
const FILLER_SINGLE: ReadonlySet<string> = new Set(['uh', 'um', 'erm', 'uhm', 'hmm', 'mm', 'ah', 'er']);

/** Multi-token fillers, matched greedily over normalized tokens (spec §30.6). */
const FILLER_PHRASES: ReadonlyArray<readonly string[]> = [
  ['you', 'know'],
  ['i', 'mean'],
  ['sort', 'of'],
  ['kind', 'of'],
];

/** Words that count as fillers only at a turn/item start (spec §30.6). */
const FILLER_TURN_START: ReadonlySet<string> = new Set(['okay', 'ok', 'so', 'like', 'well']);

/**
 * Classify fillers conservatively (spec §30.6): "like"/"so" are only fillers
 * at a turn start because they may be authored script content.
 */
export function classifyFillers(tokens: readonly string[], atTurnStart: boolean): boolean[] {
  const filler = new Array<boolean>(tokens.length).fill(false);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) continue;
    if (FILLER_SINGLE.has(token)) {
      filler[i] = true;
      continue;
    }
    if (i === 0 && atTurnStart && FILLER_TURN_START.has(token)) {
      filler[i] = true;
      continue;
    }
    for (const phrase of FILLER_PHRASES) {
      if (i + phrase.length <= tokens.length) {
        let all = true;
        for (let j = 0; j < phrase.length; j++) {
          if (tokens[i + j] !== phrase[j]) {
            all = false;
            break;
          }
        }
        if (all) {
          for (let j = 0; j < phrase.length; j++) filler[i + j] = true;
        }
      }
    }
  }
  return filler;
}

/* ---------------------------------------------------------------------------
 * Number and contraction equivalence (spec §25.4 steps 6/8, §31.4).
 * ------------------------------------------------------------------------- */

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
};
const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7,
  eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13,
  fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
  eighteenth: 18, nineteenth: 19, twentieth: 20,
};

/** Parse a single normalized token as a number, or return undefined. */
export function tokenNumberValue(token: string): number | undefined {
  if (/^\d+$/.test(token)) return Number.parseInt(token, 10);
  const ordinalDigits = /^(\d+)(st|nd|rd|th)$/.exec(token);
  if (ordinalDigits?.[1] !== undefined) return Number.parseInt(ordinalDigits[1], 10);
  if (token in UNITS) return UNITS[token];
  if (token in TENS) return TENS[token];
  if (token in ORDINALS) return ORDINALS[token];
  return undefined;
}

/**
 * Parse a run of spelled-number tokens starting at `start` (e.g. "forty two",
 * "one hundred"). Returns the value and how many tokens were consumed.
 */
export function parseNumberRun(
  tokens: readonly string[],
  start: number,
): { value: number; length: number } | undefined {
  const first = tokens[start];
  if (first === undefined) return undefined;
  if (/^\d+$/.test(first)) return { value: Number.parseInt(first, 10), length: 1 };
  const firstValue = tokenNumberValue(first);
  if (firstValue === undefined) return undefined;
  let value = firstValue;
  let length = 1;
  if (first in TENS) {
    const next = tokens[start + 1];
    if (next !== undefined && (next in UNITS || next in ORDINALS)) {
      const unit = UNITS[next] ?? ORDINALS[next] ?? 0;
      if (unit > 0 && unit < 10) {
        value += unit;
        length = 2;
      }
    }
  } else if (tokens[start + 1] === 'hundred') {
    value *= 100;
    length = 2;
    const next = tokens[start + 2];
    if (next !== undefined) {
      const rest = parseNumberRun(tokens, next === 'and' ? start + 3 : start + 2);
      if (rest && rest.value < 100) {
        value += rest.value;
        length += rest.length + (next === 'and' ? 1 : 0);
      }
    }
  }
  return { value, length };
}

/** True when two normalized tokens are numerically equivalent (§31.4). */
export function numberEquivalent(a: string, b: string): boolean {
  const va = tokenNumberValue(a);
  if (va === undefined) return false;
  const vb = tokenNumberValue(b);
  return vb !== undefined && va === vb;
}

const CONTRACTIONS: Record<string, string> = {
  "don't": 'do not', "doesn't": 'does not', "didn't": 'did not',
  "can't": 'cannot', "won't": 'will not', "isn't": 'is not',
  "aren't": 'are not', "wasn't": 'was not', "weren't": 'were not',
  "it's": 'it is', "that's": 'that is', "there's": 'there is',
  "we're": 'we are', "they're": 'they are', "you're": 'you are',
  "i'm": 'i am', "i've": 'i have', "we've": 'we have', "you've": 'you have',
  "they've": 'they have', "i'll": 'i will', "we'll": 'we will',
  "you'll": 'you will', "it'll": 'it will', "let's": 'let us',
  "haven't": 'have not', "hasn't": 'has not', "hadn't": 'had not',
  "shouldn't": 'should not', "wouldn't": 'would not', "couldn't": 'could not',
  "what's": 'what is', "here's": 'here is',
};

/** Expansion of a contraction, or undefined (spec §25.4 step 6). */
export function contractionExpansion(token: string): string | undefined {
  return CONTRACTIONS[token];
}

/** True when tokens are contraction-equivalent ("don't" ↔ "dont"). */
export function contractionEquivalent(a: string, b: string): boolean {
  if (a === b) return true;
  const stripA = a.replace(/'/g, '');
  const stripB = b.replace(/'/g, '');
  if (stripA === stripB) return true;
  const expandA = contractionExpansion(a);
  const expandB = contractionExpansion(b);
  return (
    (expandA !== undefined && (expandA === b || expandA.replace(/ /g, '') === stripB)) ||
    (expandB !== undefined && (expandB === a || expandB.replace(/ /g, '') === stripA))
  );
}

/* ---------------------------------------------------------------------------
 * Lexical and phonetic similarity (spec §31.4).
 * ------------------------------------------------------------------------- */

/** Bounded Levenshtein distance; bails out early above `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev = new Array<number>(lb + 1);
  let curr = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const value = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
      curr[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[lb] ?? max + 1;
}

/**
 * Light edit similarity for sufficiently long tokens (spec §31.4): allow one
 * edit for tokens of 5–8 chars, two edits for longer tokens.
 */
export function lexicallySimilar(a: string, b: string): boolean {
  const minLen = Math.min(a.length, b.length);
  if (minLen < 5) return false;
  const allowed = minLen >= 9 ? 2 : 1;
  return editDistance(a, b, allowed) <= allowed;
}

/**
 * Compact phonetic key (metaphone-flavored, hand-rolled — no dependencies).
 * Deterministic, English-oriented, good enough for near-homophone rescue.
 */
export function phoneticKey(word: string): string {
  let w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length === 0) return '';
  // Leading silent combos.
  w = w.replace(/^(kn|gn|pn|wr|ps)/, (m) => m.charAt(1));
  w = w.replace(/^x/, 's');
  let out = '';
  for (let i = 0; i < w.length; i++) {
    const c = w.charAt(i);
    const next = w.charAt(i + 1);
    let code = '';
    switch (c) {
      case 'b': code = 'b'; break;
      case 'c':
        code = next === 'h' ? 'x' : next !== '' && 'eiy'.includes(next) ? 's' : 'k';
        if (next === 'h') i++;
        break;
      case 'd':
        if (next === 'g') { code = 'j'; i++; } else code = 't';
        break;
      case 'f': case 'v': code = 'f'; break;
      case 'g':
        if (next === 'h') { code = 'k'; i++; } else code = next !== '' && 'eiy'.includes(next) ? 'j' : 'k';
        break;
      case 'j': code = 'j'; break;
      case 'k': case 'q': code = 'k'; break;
      case 'l': code = 'l'; break;
      case 'm': case 'n': code = 'n'; break;
      case 'p':
        if (next === 'h') { code = 'f'; i++; } else code = 'p';
        break;
      case 'r': code = 'r'; break;
      case 's':
        if (next === 'h') { code = 'x'; i++; } else code = 's';
        break;
      case 't':
        if (next === 'h') { code = '0'; i++; } else code = 't';
        break;
      case 'x': code = 'ks'; break;
      case 'z': code = 's'; break;
      case 'w': case 'y':
        code = next !== '' && 'aeiou'.includes(next) ? c : '';
        break;
      default:
        // Vowels: keep only when word-initial.
        code = i === 0 ? 'a' : '';
    }
    if (code.length > 0 && !out.endsWith(code)) out += code;
  }
  return out;
}

export function phoneticallySimilar(a: string, b: string): boolean {
  if (a.length < 3 || b.length < 3) return false;
  const ka = phoneticKey(a);
  const kb = phoneticKey(b);
  if (ka.length === 0 || kb.length === 0) return false;
  if (ka === kb) return true;
  if (ka.length >= 3 && kb.length >= 3) return editDistance(ka, kb, 1) <= 1;
  return false;
}
