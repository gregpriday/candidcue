/**
 * Negation detection (§25.5 `CRITICAL_NEGATION`).
 *
 * Negation is the one fidelity class where a single dropped word reverses the
 * meaning of the sentence outright — "the data is not available" read as "the
 * data is available" is a different claim, not a paraphrase — which is why it
 * earns the `fidelity_critical` band.
 *
 * The detection is deliberately *syntactic*. Words like `lack`, `fail`, or
 * `absent` negate semantically, but deciding whether a presenter preserved
 * that meaning is a judgement call, and a local comparator making judgement
 * calls at priority 90 is exactly the failure mode this module is written to
 * avoid. Semantic negation is left to Luna's materiality classification.
 */

/** Standalone negation markers. */
const NEGATION_WORDS: ReadonlySet<string> = new Set([
  'not',
  'no',
  'never',
  'none',
  'nothing',
  'nobody',
  'noone',
  'nowhere',
  'neither',
  'nor',
  'cannot',
  'without',
]);

/**
 * Contractions carrying a negation. The apostrophe-less forms are listed too
 * because transcripts produce both.
 */
const NEGATED_CONTRACTIONS: ReadonlySet<string> = new Set([
  "don't", 'dont', "doesn't", 'doesnt', "didn't", 'didnt',
  "can't", 'cant', "won't", 'wont', "shan't", 'shant',
  "isn't", 'isnt', "aren't", 'arent', "wasn't", 'wasnt', "weren't", 'werent',
  "haven't", 'havent', "hasn't", 'hasnt', "hadn't", 'hadnt',
  "shouldn't", 'shouldnt', "wouldn't", 'wouldnt', "couldn't", 'couldnt',
  "mustn't", 'mustnt', "needn't", 'neednt', "ain't", 'aint',
]);

/**
 * Prefixes that can carry a negation into a single word, so that "not
 * available" spoken as "unavailable" is recognised as *preserving* the
 * negation rather than dropping it. Used only to suppress candidates, never to
 * raise one.
 */
const NEGATING_PREFIXES: readonly string[] = ['un', 'in', 'im', 'il', 'ir', 'non', 'dis', 'a'];

/**
 * True when the normalized word is a syntactic negation marker.
 *
 * There is deliberately no `…nt` suffix heuristic. It would sweep in `front`,
 * `percent`, `important`, `government` and dozens more, and each of those
 * false friends is a *silently suppressed real negation error* on the spoken
 * side, not merely noise. The apostrophe-less contraction forms transcripts
 * actually produce are enumerated above instead.
 */
export function negates(word: string): boolean {
  if (NEGATION_WORDS.has(word)) return true;
  if (NEGATED_CONTRACTIONS.has(word)) return true;
  return word.endsWith("n't");
}

/** Count of negation markers in a word array. */
export function countNegations(words: readonly string[]): number {
  let count = 0;
  for (const word of words) {
    if (word !== undefined && negates(word)) count += 1;
  }
  return count;
}

/** Indexes of every negation marker in a word array. */
export function findNegations(words: readonly string[]): number[] {
  const out: number[] = [];
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (word !== undefined && negates(word)) out.push(index);
  }
  return out;
}

/**
 * The positive stem of a negated contraction — `don't` → `do`, `cannot` → `can`.
 *
 * This exists for one narrow, unambiguous case: the presenter read the
 * contraction's positive half and dropped the negation ("we don't ship" → "we
 * do ship"). Because the stem is a *lexical* property of the authored word, no
 * semantic judgement is involved, which is what makes it safe to report while
 * a general "they said something else here" is not.
 */
const CONTRACTION_STEMS: Readonly<Record<string, string>> = {
  "don't": 'do', dont: 'do',
  "doesn't": 'does', doesnt: 'does',
  "didn't": 'did', didnt: 'did',
  "can't": 'can', cant: 'can', cannot: 'can',
  "won't": 'will', wont: 'will',
  "shan't": 'shall', shant: 'shall',
  "isn't": 'is', isnt: 'is',
  "aren't": 'are', arent: 'are',
  "wasn't": 'was', wasnt: 'was',
  "weren't": 'were', werent: 'were',
  "haven't": 'have', havent: 'have',
  "hasn't": 'has', hasnt: 'has',
  "hadn't": 'had', hadnt: 'had',
  "shouldn't": 'should', shouldnt: 'should',
  "wouldn't": 'would', wouldnt: 'would',
  "couldn't": 'could', couldnt: 'could',
  "mustn't": 'must', mustnt: 'must',
  "needn't": 'need', neednt: 'need',
};

export function positiveStemOfContraction(word: string): string | undefined {
  return CONTRACTION_STEMS[word];
}

/**
 * True when `spokenWords` contains a prefix-negated form of `stem`, e.g.
 * `unavailable` for `available`.
 *
 * Only used to *suppress* a dropped-negation candidate: a presenter who says
 * "unavailable" where the script said "not available" preserved the meaning
 * exactly, and interrupting them for it would be the comparator's worst kind
 * of error.
 */
export function hasPrefixNegatedForm(spokenWords: readonly string[], stem: string): boolean {
  if (stem.length < 4) return false;
  for (const word of spokenWords) {
    if (word === undefined || word.length <= stem.length) continue;
    for (const prefix of NEGATING_PREFIXES) {
      if (word === `${prefix}${stem}`) return true;
      // "impossible" for "possible" doubles the consonant in some words.
      if (word === `${prefix}${stem.slice(1)}` && stem.length > 5) return true;
    }
  }
  return false;
}
