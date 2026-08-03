/**
 * What the breaker knows about English.
 *
 * Closed classes only. Every set here is a category English has a finite number
 * of members of, which is precisely why a table is the right tool and a
 * part-of-speech tagger is not: these do not need training data, they do not
 * disagree with themselves, and they cost one hash lookup.
 *
 * The open classes are reached at obliquely — a suffix test for adjectives, a
 * capitalisation test for names — and both are deliberately weak evidence,
 * because the cost of a false positive here is a break the presenter can see.
 */

export const DETERMINERS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'my', 'your', 'his',
  'her', 'its', 'our', 'their', 'each', 'every', 'some', 'any', 'no', 'both',
  'either', 'neither', 'another', 'such', 'what', 'which', 'whose',
]);

export const PREPOSITIONS = new Set([
  'of', 'in', 'on', 'at', 'to', 'for', 'with', 'from', 'by', 'into', 'onto',
  'upon', 'over', 'under', 'above', 'below', 'between', 'among', 'through',
  'during', 'before', 'after', 'against', 'about', 'across', 'behind',
  'beyond', 'beside', 'within', 'without', 'toward', 'towards', 'via', 'per',
  'off', 'near', 'along', 'around', 'throughout', 'despite', 'inside',
  'outside', 'until', 'unlike', 'like',
]);

export const AUXILIARIES = new Set([
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'has', 'have',
  'had', 'having', 'do', 'does', 'did', 'will', 'would', 'shall', 'should',
  'can', 'could', 'may', 'might', 'must', 'ought', 'let', 'going',
]);

export const PRONOUNS = new Set([
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'who', 'there', 'here',
  'someone', 'everyone', 'nobody', 'anyone', 'something', 'nothing',
  'everything', 'anything',
]);

export const CONJUNCTIONS = new Set([
  'and', 'or', 'but', 'nor', 'so', 'yet', 'because', 'although', 'though',
  'while', 'whereas', 'if', 'unless', 'since', 'when', 'whenever', 'where',
  'wherever', 'than', 'as', 'whether', 'plus',
]);

/**
 * Subordinators and relatives that OPEN a clause.
 *
 * They earn a break BEFORE them for the same reason they are glued after them:
 * the eye should meet the clause whole, at the left edge.
 */
export const CLAUSE_OPENERS = new Set([
  ...CONJUNCTIONS, 'that', 'which', 'who', 'whom', 'whose', 'after', 'before',
  'until', 'once', 'however', 'therefore', 'meanwhile', 'instead',
]);

/**
 * Units and counted nouns.
 *
 * Not exhaustive and never will be — the unknown-unit case falls through to
 * `GLUE_NUMBER`, which is smaller but still keeps a number attached to the word
 * it quantifies.
 */
export const UNITS = new Set([
  'percent', 'per', 'cent', 'dollars', 'dollar', 'euros', 'euro', 'pounds',
  'pound', 'rand', 'cents', 'million', 'billion', 'trillion', 'thousand',
  'hundred', 'seconds', 'second', 'minutes', 'minute', 'hours', 'hour',
  'days', 'day', 'weeks', 'week', 'months', 'month', 'years', 'year',
  'metres', 'meters', 'metre', 'meter', 'kilometres', 'kilometers', 'miles',
  'mile', 'feet', 'foot', 'inches', 'inch', 'grams', 'gram', 'kilograms',
  'kilos', 'tons', 'tonnes', 'degrees', 'degree', 'times', 'people',
  'kg', 'km', 'cm', 'mm', 'ms', 'gb', 'mb', 'tb', 'kb', 'hz', 'khz', 'mhz',
  'ghz', 'mph', 'kph', 'am', 'pm', 'x', 'k', 'm', 'bn',
]);

/** Number words, so "five hundred" glues the same way "500" does. */
export const NUMBER_WORDS = new Set([
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve', 'twenty', 'thirty', 'forty', 'fifty',
  'sixty', 'seventy', 'eighty', 'ninety', 'hundred', 'thousand', 'million',
  'billion', 'half', 'quarter',
]);

/**
 * Adjectives common enough in scripted speech to be worth naming.
 *
 * The suffix test below catches the derived ones; this catches the short,
 * frequent, morphologically invisible ones that a suffix rule never will.
 */
export const COMMON_ADJECTIVES = new Set([
  'new', 'old', 'good', 'bad', 'great', 'small', 'big', 'large', 'little',
  'long', 'short', 'high', 'low', 'early', 'late', 'young', 'best', 'worst',
  'better', 'worse', 'first', 'second', 'last', 'next', 'final', 'whole',
  'full', 'real', 'true', 'main', 'own', 'same', 'other', 'right', 'wrong',
  'hard', 'easy', 'free', 'open', 'close', 'clear', 'strong', 'weak', 'deep',
  'fast', 'slow', 'quiet', 'loud', 'warm', 'cold', 'entire', 'single',
]);

/** Derivational endings that mark an attributive adjective often enough. */
export const ADJECTIVE_SUFFIX =
  /(ous|ful|ive|able|ible|al|ic|ical|ish|less|ary|ent|ant)$/;

/** Titles bind to the name that follows exactly as a first name does. */
export const HONORIFICS = new Set([
  'mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'professor', 'sir', 'dame', 'lord',
  'lady', 'president', 'senator', 'judge', 'captain', 'saint', 'st',
]);

/**
 * Abbreviations that end in a dot without ending a sentence.
 *
 * Small on purpose: a false negative costs one slightly worse break, while a
 * false positive puts a line break in the middle of "Dr. Ncube".
 */
export const DOTTED_ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'vs', 'etc', 'inc', 'ltd', 'co',
  'no', 'fig', 'jr', 'sr', 'approx', 'dept', 'est', 'eg', 'ie', 'cf', 'al',
]);

/* ---------------------------------------------------------------------------
 * Character-level helpers
 * ------------------------------------------------------------------------- */

const CURRENCY = /[$£€¥₹₽₩]/;
const SENTENCE_END = /[.!?…‼⁇⁈⁉。！？][)\]}"'”’»›]*$/;
const CLAUSE_END = /[,;:—–][)\]}"'”’»›]*$/u;
const ACRONYM = /^\p{Lu}(\.\p{Lu})+\.?$/u;
const LEADING_TRIM = /^[^\p{L}\p{N}]+/u;
const TRAILING_TRIM = /[^\p{L}\p{N}]+$/u;
const DIGITS = /^\d+([.,]\d+)*(st|nd|rd|th)?$/;
const UPPERCASE_START = /^\p{Lu}/u;
const LOWERCASE_START = /^\p{Ll}/u;

/** Lowercased, stripped of the punctuation hanging off either end. */
function coreWord(text: string): string {
  return text.replace(LEADING_TRIM, '').replace(TRAILING_TRIM, '').toLowerCase();
}

function endsSentence(text: string, core: string): boolean {
  if (!SENTENCE_END.test(text)) return false;
  // "U.S.A." and "Dr." end in a dot and end nothing.
  if (ACRONYM.test(text)) return false;
  if (text.endsWith('.') && DOTTED_ABBREVIATIONS.has(core)) return false;
  return true;
}

function isNumberLike(core: string, text: string): boolean {
  return DIGITS.test(core) || NUMBER_WORDS.has(core) || CURRENCY.test(text);
}

/** Everything about one word the cost model needs, computed once. */
export interface WordFacts {
  core: string;
  endsSentence: boolean;
  endsClause: boolean;
  capitalized: boolean;
  lowercase: boolean;
  numberLike: boolean;
  currencyOnly: boolean;
  /** First word of the document, or first after a sentence end / forced break. */
  sentenceInitial: boolean;
}

export function describeWord(text: string, sentenceInitial: boolean): WordFacts {
  const core = coreWord(text);
  const unprefixed = text.replace(LEADING_TRIM, '');
  return {
    core,
    endsSentence: endsSentence(text, core),
    endsClause: CLAUSE_END.test(text),
    capitalized: UPPERCASE_START.test(unprefixed),
    lowercase: LOWERCASE_START.test(unprefixed),
    numberLike: isNumberLike(core, text),
    currencyOnly: core.length === 0 && CURRENCY.test(text),
    sentenceInitial,
  };
}
