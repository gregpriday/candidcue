/**
 * Speech-aware line breaking.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS MODULE EXISTS
 * ---------------------------------------------------------------------------
 * A browser breaks a line at the last space that fits. That is the correct
 * answer for a paragraph somebody reads silently at their own pace, and the
 * wrong one for a prompter, where the break position is a PERFORMANCE decision:
 * the eye returns to the left edge at a phrase boundary far more comfortably
 * than in the middle of a clause, and a line that ends on "the", on "will", or
 * on a first name forces a recovery the viewer can see and hear.
 *
 * So the break is chosen rather than discovered. Every legal break point is
 * scored — how far the line lands from the reading measure, and what kind of
 * seam the break sits on — and a dynamic program picks the cheapest set of
 * breaks over the whole paragraph. Choosing per line (greedy first-fit, which
 * is what the browser does) cannot trade a slightly short line now for a much
 * better seam later, and that trade is the entire point.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE IS NOT ALLOWED TO DO
 * ---------------------------------------------------------------------------
 * It decides WHERE LINES BREAK. Nothing else. It never reorders, merges,
 * splits, inserts or drops a token, because the compiler is the single source
 * of spoken tokens and the aligner's indices are the compiler's indices — a
 * breaker that changed the token sequence would move the reader's position in
 * the script, which is the one thing the display must never do.
 * `verifyLineBreakPlan` states that invariant as an executable check.
 *
 * It is also DETERMINISTIC and PURE: no DOM, no clock, no randomness, no
 * network, no model. Same tokens and same options give the same plan on every
 * machine and in every process, which is what lets the plan be a layout
 * fingerprint input rather than a source of layout churn.
 *
 * And it is TOTAL. Empty input, a single token, one token longer than the whole
 * measure, or text with no legal break anywhere all produce a valid plan. There
 * is no input for which it throws, and no input for which it loops: a run that
 * may not break is merged into one indivisible ATOM before the solve, so the
 * smallest thing the solver has to place is always placeable — on its own line,
 * overflowing, if that is what the text is — and the dynamic program always has
 * an answer to return.
 *
 * The heuristics are English-shaped and openly so. On text they do not
 * understand — CJK, Arabic, Hebrew, anything without spaces — none of the
 * lexical rules fire, every break scores the same, and the plan degrades to
 * pure measure-based wrapping. That is the correct failure: worse than a
 * language-aware breaker, identical to what the browser would have done.
 */

import { hashString } from './markdown/hash';

/* ---------------------------------------------------------------------------
 * Public shapes
 * ------------------------------------------------------------------------- */

/**
 * One visual word, as the stage will render it.
 *
 * `text` is the RENDERED surface including any punctuation attached to it
 * ("Monday,", "Australia."), because punctuation is the strongest evidence this
 * module has and stripping it upstream would throw that evidence away. It is
 * deliberately not `SpokenToken`: unspoken visual text (a cue chip's label, a
 * table cell) has to be laid out too, and carries no token index.
 */
export interface LineBreakToken {
  text: string;
  /**
   * The compiler's spoken-token index, when this word is one. Carried through
   * untouched — this module never reads it for any decision, it exists so the
   * caller can map a planned line back to the token stops it contains.
   */
  tokenIndex?: number | null;
  /**
   * Rendered with a space between this token and the next. Default true.
   *
   * Width bookkeeping only; it says nothing about whether a break is legal
   * there. Scripts that do not put spaces between words still break between
   * them, and a Latin run that genuinely may not break says so with
   * `noBreakAfter`.
   */
  spaceAfter?: boolean;
  /**
   * There is no break opportunity after this token — adjacent inline runs with
   * no space between them, or a span the caller has decided is atomic.
   */
  noBreakAfter?: boolean;
  /** An authored line break or the end of a block: a line MUST end here. */
  breakAfter?: boolean;
}

export interface LineBreakOptions {
  /** The measure the plan aims for, in characters. */
  targetChars?: number;
  /**
   * The measure the column can actually hold.
   *
   * A ceiling rather than a law: a line past it is penalised heavily enough
   * that it only happens when one indivisible run is wider than the column,
   * which is a fact about the text rather than a choice the solver made.
   */
  maxChars?: number;
  /**
   * The width below which a line reads as a hole rather than as a phrase.
   *
   * Never a hard floor — the whole point of a speech-aware breaker is that a
   * ten-character line ending on "…on Monday," is right. It is the threshold
   * for two judgements: how much a short mid-paragraph line costs GIVEN how
   * weak the seam that closed it was, and whether a closing line of one or two
   * words is stranded.
   */
  minChars?: number;
}

/**
 * What kind of seam the break that ends a line sits on.
 *
 * Diagnostic rather than load-bearing — nothing downstream branches on it — but
 * it is what makes a plan reviewable by a human and testable without asserting
 * on costs, which are tuning and will move.
 */
export type LineBreakReason =
  | 'sentence'
  | 'clause'
  | 'phrase'
  | 'measure'
  | 'glue'
  | 'forced'
  | 'end';

export interface LineBreakLine {
  /** Inclusive index range into the input tokens. */
  startIndex: number;
  endIndex: number;
  /** Rendered width in characters, separators included. */
  widthChars: number;
  /** The line is wider than `maxChars` — always because nothing else fits. */
  overflow: boolean;
  reason: LineBreakReason;
}

export interface LineBreakPlan {
  lines: LineBreakLine[];
  /** The options the plan was actually solved with, after sanitization. */
  measure: { targetChars: number; maxChars: number; minChars: number };
  /** Total dynamic-program cost. Comparable only between plans of one input. */
  cost: number;
  /**
   * A stable digest of the plan.
   *
   * This is the value the stage folds into its layout fingerprint. A plan that
   * changed and a fingerprint that did not is the exact bug class the
   * fingerprint exists to prevent — the map gets replaced under the old
   * generation and the semantic re-anchor never runs.
   */
  signature: string;
  tokenCount: number;
}

/* ---------------------------------------------------------------------------
 * Measure defaults
 *
 * A prompter column is short. These are the fallbacks for a caller that has not
 * measured anything yet; a calibrated stage passes its own resolved measure and
 * these are never used.
 * ------------------------------------------------------------------------- */

export const LINE_BREAK_DEFAULTS = {
  targetChars: 38,
  /** ~12% of slack over the target, which is roughly one long word. */
  maxOverTargetRatio: 1.12,
  /** Half the target: under it, a mid-paragraph line reads as a hole. */
  minOverTargetRatio: 0.5,
} as const;

/* ---------------------------------------------------------------------------
 * The cost model
 *
 * Two currencies, deliberately on one scale: how wrong the line LOOKS
 * (raggedness) and how wrong the break SOUNDS (the seam). Both are in the same
 * arbitrary units, and the ratio between them is the only interesting number in
 * this file — it is what decides whether a short line is worth a better break.
 * The values below buy about one third of a measure of shortness for one good
 * seam, which is what the reference case in the tests pins.
 * ------------------------------------------------------------------------- */

/**
 * Raggedness weight, applied to the SQUARED fractional deviation from target.
 *
 * Squared rather than linear so that two mildly short lines are cheaper than
 * one severe one — the same reason typesetters minimise squared badness.
 */
const MEASURE_WEIGHT = 14;

/**
 * An ordinary break: legal, unremarkable, no punctuation and no seam.
 *
 * The absolute value matters less than the DISTANCE from it down to the
 * punctuated seams below and up to the glue above — a plan with the same number
 * of lines pays this the same number of times, so it is the gap that decides
 * anything. It is set high enough that a good seam is worth roughly a third of
 * a measure of shortness, which is the trade the reference case pins.
 */
const BREAK_BASE = 10;

/** After a full stop, a question mark or an exclamation: free. */
const BREAK_SENTENCE = 0;

/** After a comma, semicolon, colon or dash — a real clause boundary. */
const BREAK_CLAUSE = 1.5;

/** Before a conjunction or a subordinator: the new line opens the clause. */
const BREAK_BEFORE_CONJUNCTION = 2.5;

/** Before a preposition: the new line opens the prepositional phrase. */
const BREAK_BEFORE_PREPOSITION = 3;

/* Glue: breaking HERE splits something the ear hears as one unit. Applied as
 * the maximum of whatever fires, never the sum — the rules below all describe
 * the same single boundary from different angles, and summing them would charge
 * three times for one syntactic fact. */

/** "$" / "£" / "€" and its amount. Splitting these is close to unreadable. */
const GLUE_CURRENCY = 70;
/** A number and its unit: "20 percent", "3 million", "45 minutes". */
const GLUE_NUMBER_UNIT = 55;
/** A number and whatever it counts, when the unit is not one we know. */
const GLUE_NUMBER = 22;
/** Parts of one proper noun: "South Africa", "Sarah Whitfield", "Dr Ncube". */
const GLUE_PROPER_NOUN = 45;
/** Article or determiner and its noun: "the version", "our launch". */
const GLUE_DETERMINER = 42;
/** Coordinator or subordinator and what follows it: break BEFORE, never after. */
const GLUE_CONJUNCTION = 38;
/** Preposition and its object: "on Monday", "in South Africa". */
const GLUE_PREPOSITION = 36;
/** Auxiliary or modal and its main verb: "will launch", "has shipped". */
const GLUE_AUXILIARY = 34;
/** Pronoun and its verb: "we ship", "it launches". */
const GLUE_PRONOUN = 28;
/** Adjective and its noun: "new version", "difficult conversation". */
const GLUE_ADJECTIVE = 24;

/**
 * Past the measure.
 *
 * This one does not steer anything, and saying so is the honest version: the
 * scan below refuses to score a multi-atom line that has passed the column at
 * all, so the only line that can overflow is a single indivisible run wider
 * than the whole measure, and such a run is alone on its line in EVERY plan.
 * The toll is therefore the same constant in every plan of one input, and it
 * cancels. What it buys is a `cost` that reports "this text does not fit"
 * loudly enough to notice next to a `cost` that is a raggedness score.
 */
const OVERFLOW_PENALTY = 400;
const OVERFLOW_PER_CHAR = 40;

/**
 * The hard ceiling on how many atoms one line may be scanned across.
 *
 * The width test in the solver is the real bound and for ordinary text it is
 * the only one needed: a candidate line that has passed the column ends the
 * scan, so the work per line is bounded by the measure. It bounds nothing when
 * an atom occupies no cells at all — a run of empty tokens (adjacent inline
 * runs that render to nothing, which a caller produces by accident rather than
 * on purpose) never passes the column, so the scan walks the whole document
 * for every line and the solve goes quadratic. A count no real line could
 * reach closes that without touching any plan the width test would have
 * allowed: 1,024 atoms is not a line at any measure a person reads from.
 */
const MAX_ATOMS_PER_LINE = 1024;

/**
 * A mid-paragraph line under `minChars`, per character below it — scaled by how
 * WEAK the seam that closed it is.
 *
 * This is what `minChars` is for, and the scaling is the whole idea: a ten
 * character line is a hole in the paragraph when it ends mid-clause, and it is
 * a deliberate beat when it ends on "…on Monday,". Charging both the same is
 * how a breaker ends up refusing the very short strong-seam lines that are the
 * reason to have one at all.
 */
const SHORT_LINE_PER_CHAR = 2;

/**
 * A closing line of one or two short words.
 *
 * The most visible of all the failures this module exists to fix: the presenter
 * sweeps back to the left edge for "Australia." and the sentence has already
 * ended. Charged only when the final line is genuinely stranded — under the
 * minimum measure AND two words or fewer — so an ordinarily short closing line
 * pays nothing.
 */
const ORPHAN_LINE_PENALTY = 26;
/** One stranded word is worse than two, and it is worse than proportionally. */
const ORPHAN_SINGLE_WORD_MULTIPLIER = 1.6;

/* ---------------------------------------------------------------------------
 * Lexicons
 *
 * Closed classes only. Every set here is a category English has a finite number
 * of members of, which is precisely why a table is the right tool and a
 * part-of-speech tagger is not: these do not need training data, they do not
 * disagree with themselves, and they cost one hash lookup.
 * ------------------------------------------------------------------------- */

const DETERMINERS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'my', 'your', 'his',
  'her', 'its', 'our', 'their', 'each', 'every', 'some', 'any', 'no', 'both',
  'either', 'neither', 'another', 'such', 'what', 'which', 'whose',
]);

const PREPOSITIONS = new Set([
  'of', 'in', 'on', 'at', 'to', 'for', 'with', 'from', 'by', 'into', 'onto',
  'upon', 'over', 'under', 'above', 'below', 'between', 'among', 'through',
  'during', 'before', 'after', 'against', 'about', 'across', 'behind',
  'beyond', 'beside', 'within', 'without', 'toward', 'towards', 'via', 'per',
  'off', 'near', 'along', 'around', 'throughout', 'despite', 'inside',
  'outside', 'until', 'unlike', 'like',
]);

const AUXILIARIES = new Set([
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'has', 'have',
  'had', 'having', 'do', 'does', 'did', 'will', 'would', 'shall', 'should',
  'can', 'could', 'may', 'might', 'must', 'ought', 'let', 'going',
]);

const PRONOUNS = new Set([
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'who', 'there', 'here',
  'someone', 'everyone', 'nobody', 'anyone', 'something', 'nothing',
  'everything', 'anything',
]);

const CONJUNCTIONS = new Set([
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
const CLAUSE_OPENERS = new Set([
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
const UNITS = new Set([
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
const NUMBER_WORDS = new Set([
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
const COMMON_ADJECTIVES = new Set([
  'new', 'old', 'good', 'bad', 'great', 'small', 'big', 'large', 'little',
  'long', 'short', 'high', 'low', 'early', 'late', 'young', 'best', 'worst',
  'better', 'worse', 'first', 'second', 'last', 'next', 'final', 'whole',
  'full', 'real', 'true', 'main', 'own', 'same', 'other', 'right', 'wrong',
  'hard', 'easy', 'free', 'open', 'close', 'clear', 'strong', 'weak', 'deep',
  'fast', 'slow', 'quiet', 'loud', 'warm', 'cold', 'entire', 'single',
]);

/** Derivational endings that mark an attributive adjective often enough. */
const ADJECTIVE_SUFFIX = /(ous|ful|ive|able|ible|al|ic|ical|ish|less|ary|ent|ant)$/;

/** Titles bind to the name that follows exactly as a first name does. */
const HONORIFICS = new Set([
  'mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'professor', 'sir', 'dame', 'lord',
  'lady', 'president', 'senator', 'judge', 'captain', 'saint', 'st',
]);

/**
 * Abbreviations that end in a dot without ending a sentence.
 *
 * Small on purpose: a false negative costs one slightly worse break, while a
 * false positive puts a line break in the middle of "Dr. Ncube".
 */
const DOTTED_ABBREVIATIONS = new Set([
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

/**
 * Whether a code point occupies two character cells.
 *
 * The measure is in characters, and a character is not a fixed width once the
 * text stops being Latin: a line of 30 Han glyphs is twice as wide as a line of
 * 30 letters, and counting them the same would hand CJK a column twice the one
 * that was calibrated. These are the East Asian Wide and Fullwidth blocks; the
 * approximation is coarse and it is still enormously better than 1.
 */
function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/**
 * Width of one token in character cells.
 *
 * Iterated by code point rather than by `length`, so an emoji or an astral
 * glyph counts once instead of twice — `String.length` counts UTF-16 units, and
 * a measure built on it silently shrinks the column for anyone whose script
 * lives outside the BMP.
 */
export function visualWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    const cp = character.codePointAt(0);
    if (cp === undefined) continue;
    width += isWideCodePoint(cp) ? 2 : 1;
  }
  return width;
}

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

/* ---------------------------------------------------------------------------
 * Break classification
 * ------------------------------------------------------------------------- */

/** Everything about one word the cost model needs, computed once. */
interface WordFacts {
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

/**
 * A run of tokens that must stay on one line, and the unit the solver places.
 *
 * Usually exactly one token. It is more only where the caller said a break is
 * impossible — inline runs written with no space between them — and collapsing
 * those before the solve is what keeps the solver total: its smallest unit is
 * always placeable, so there is no such thing as an input it cannot answer.
 */
interface Atom {
  /** Inclusive token index range. */
  startIndex: number;
  endIndex: number;
  /** Rendered width, including any separators inside the run. */
  width: number;
  /** Separator between this atom and the next. */
  separator: number;
  /** An authored line break: a line MUST end here. */
  breakAfter: boolean;
  /** Facts of the last word — the left-hand side of the break that follows. */
  tail: WordFacts;
  /** Facts of the first word — the right-hand side of the break before it. */
  head: WordFacts;
}

function describeWord(text: string, sentenceInitial: boolean): WordFacts {
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

function buildAtoms(tokens: readonly LineBreakToken[]): Atom[] {
  const atoms: Atom[] = [];
  let sentenceInitial = true;
  let open: Atom | null = null;
  for (const [index, token] of tokens.entries()) {
    const text = typeof token.text === 'string' ? token.text : '';
    const facts = describeWord(text, sentenceInitial);
    const width = visualWidth(text);
    const separator = token.spaceAfter === false ? 0 : 1;
    const forced = token.breakAfter === true;

    if (open) {
      open.endIndex = index;
      open.width += open.separator + width;
      open.separator = separator;
      open.breakAfter = forced;
      open.tail = facts;
    } else {
      open = {
        startIndex: index,
        endIndex: index,
        width,
        separator,
        breakAfter: forced,
        tail: facts,
        head: facts,
      };
      atoms.push(open);
    }
    /*
     * A forced break closes the atom whatever `noBreakAfter` says. The two are
     * a contradiction the caller can only produce by accident, and of the two
     * the authored line break is the one with an author behind it.
     */
    if (forced || token.noBreakAfter !== true) open = null;
    sentenceInitial = facts.endsSentence || forced;
  }
  return atoms;
}

/**
 * How badly the pair `left` / `right` wants to stay on one line.
 *
 * The maximum of the rules that fire, not the sum — see the note on the glue
 * constants. Returns 0 when nothing objects.
 */
function gluePenalty(left: WordFacts, right: WordFacts): number {
  let glue = 0;
  const claim = (value: number) => {
    if (value > glue) glue = value;
  };

  if (left.currencyOnly && right.numberLike) claim(GLUE_CURRENCY);
  if (left.numberLike) claim(UNITS.has(right.core) ? GLUE_NUMBER_UNIT : GLUE_NUMBER);
  if (DETERMINERS.has(left.core)) claim(GLUE_DETERMINER);
  if (CONJUNCTIONS.has(left.core)) claim(GLUE_CONJUNCTION);
  if (PREPOSITIONS.has(left.core)) claim(GLUE_PREPOSITION);
  if (AUXILIARIES.has(left.core)) claim(GLUE_AUXILIARY);
  if (PRONOUNS.has(left.core)) claim(GLUE_PRONOUN);
  if (HONORIFICS.has(left.core)) claim(GLUE_PROPER_NOUN);
  /*
   * Two capitalised words in a row are one name far more often than they are
   * two things — but only away from the start of a sentence, where the first
   * capital means nothing at all. "Yesterday Sarah left" would otherwise glue
   * an adverb to a name.
   */
  if (!left.sentenceInitial && left.capitalized && right.capitalized) {
    claim(GLUE_PROPER_NOUN);
  }
  if (
    right.lowercase &&
    (COMMON_ADJECTIVES.has(left.core) || (left.core.length > 4 && ADJECTIVE_SUFFIX.test(left.core)))
  ) {
    claim(GLUE_ADJECTIVE);
  }
  return glue;
}

/** The cost and the character of the break AFTER atom `at`. */
function classifyBreak(
  atoms: readonly Atom[],
  at: number,
): { penalty: number; reason: LineBreakReason } {
  const before = atoms[at];
  const after = atoms[at + 1];
  if (!before || !after) return { penalty: 0, reason: 'end' };
  if (before.breakAfter) return { penalty: 0, reason: 'forced' };
  const left = before.tail;
  const right = after.head;

  /*
   * Punctuation outranks the lexical rules, and it also SUPPRESSES them.
   *
   * A comma is a syntactic boundary the author wrote down; whatever the words
   * on either side of it are, they are not one constituent. Charging glue
   * across it would let "on Monday, in South Africa" refuse the break the comma
   * is literally there to offer.
   */
  if (left.endsSentence) return { penalty: BREAK_SENTENCE, reason: 'sentence' };
  if (left.endsClause) return { penalty: BREAK_CLAUSE, reason: 'clause' };

  const glue = gluePenalty(left, right);
  if (glue > 0) return { penalty: BREAK_BASE + glue, reason: 'glue' };

  if (CLAUSE_OPENERS.has(right.core)) {
    return { penalty: BREAK_BEFORE_CONJUNCTION, reason: 'phrase' };
  }
  if (PREPOSITIONS.has(right.core)) {
    return { penalty: BREAK_BEFORE_PREPOSITION, reason: 'phrase' };
  }
  return { penalty: BREAK_BASE, reason: 'measure' };
}

/* ---------------------------------------------------------------------------
 * The solver
 * ------------------------------------------------------------------------- */

function sanitizeMeasure(opts: LineBreakOptions | undefined): {
  targetChars: number;
  maxChars: number;
  minChars: number;
} {
  const raw = opts ?? {};
  const target =
    Number.isFinite(raw.targetChars) && (raw.targetChars as number) >= 1
      ? Math.round(raw.targetChars as number)
      : LINE_BREAK_DEFAULTS.targetChars;
  const maxCandidate =
    Number.isFinite(raw.maxChars) && (raw.maxChars as number) >= 1
      ? Math.round(raw.maxChars as number)
      : Math.round(target * LINE_BREAK_DEFAULTS.maxOverTargetRatio);
  // A max under the target is a caller contradiction, and the readable measure
  // is the one that has to survive it.
  const max = Math.max(target, maxCandidate);
  const minCandidate =
    Number.isFinite(raw.minChars) && (raw.minChars as number) >= 0
      ? Math.round(raw.minChars as number)
      : Math.round(target * LINE_BREAK_DEFAULTS.minOverTargetRatio);
  const min = Math.max(0, Math.min(target, minCandidate));
  return { targetChars: target, maxChars: max, minChars: min };
}

/**
 * Plan where the lines of one paragraph break.
 *
 * O(n · k) where k is the number of tokens that fit in a line — the inner scan
 * stops the moment a candidate line passes the measure, so the work per token
 * is bounded by the column and not by the length of the script.
 */
export function breakLines(
  tokens: readonly LineBreakToken[],
  opts?: LineBreakOptions,
): LineBreakPlan {
  const measure = sanitizeMeasure(opts);
  const n = tokens.length;
  if (n === 0) {
    return {
      lines: [],
      measure,
      cost: 0,
      signature: planSignature([], measure, 0),
      tokenCount: 0,
    };
  }

  const atoms = buildAtoms(tokens);
  const count = atoms.length;

  /*
   * Prefix sums, so a candidate line's width is two subtractions rather than a
   * loop. Without them the inner scan is O(k) per candidate and the whole solve
   * goes quadratic in the column width for no reason.
   */
  const cumWidth = new Float64Array(count + 1);
  const cumSeparator = new Float64Array(count + 1);
  for (let i = 0; i < count; i++) {
    cumWidth[i + 1] = (cumWidth[i] ?? 0) + (atoms[i]?.width ?? 0);
    cumSeparator[i + 1] = (cumSeparator[i] ?? 0) + (atoms[i]?.separator ?? 0);
  }
  /** Width of atoms `from`..`to` inclusive, separators between them included. */
  const widthOf = (from: number, to: number): number =>
    (cumWidth[to + 1] ?? 0) -
    (cumWidth[from] ?? 0) +
    ((cumSeparator[to] ?? 0) - (cumSeparator[from] ?? 0));

  // The seam quality of every break point, computed once — it depends on the
  // pair of words either side and not on which line they end up in.
  const breakPenalties = new Float64Array(Math.max(0, count - 1));
  const breakReasons: LineBreakReason[] = new Array(Math.max(0, count - 1));
  for (let i = 0; i < count - 1; i++) {
    const classified = classifyBreak(atoms, i);
    breakPenalties[i] = classified.penalty;
    breakReasons[i] = classified.reason;
  }

  const best = new Float64Array(count + 1).fill(Number.POSITIVE_INFINITY);
  const from = new Int32Array(count + 1).fill(-1);
  best[0] = 0;

  /* An atom that occupies at least one cell — every atom of ordinary text —
   * cannot be one of more than `maxChars + 1` on a line the width test lets
   * through, so this only ever bites on zero-width input. See the constant. */
  const scanWindow = Math.min(measure.maxChars + 2, MAX_ATOMS_PER_LINE);

  for (let end = 1; end <= count; end++) {
    const isLastLine = end === count;
    // The seam that CLOSES this line. The document's own end is free.
    const closing = isLastLine ? 0 : (breakPenalties[end - 1] ?? 0);
    for (let start = end - 1; start >= 0 && end - start <= scanWindow; start--) {
      const width = widthOf(start, end - 1);
      // Always cost the single-atom line (start === end - 1) even when it
      // overflows: an indivisible run wider than the column has to go
      // somewhere, and this is the branch that guarantees `best[end]` is always
      // finite — and therefore that the solve always has an answer.
      if (width > measure.maxChars && start < end - 1) break;

      let cost = (best[start] ?? Number.POSITIVE_INFINITY) + closing;
      if (!Number.isFinite(cost)) break;

      if (width > measure.maxChars) {
        cost += OVERFLOW_PENALTY + OVERFLOW_PER_CHAR * (width - measure.maxChars);
      } else if (isLastLine) {
        /*
         * A last line pays nothing for being short — it is SUPPOSED to be, and
         * charging it turns every closing line into a reason to ruin the ones
         * above it. What it does pay for is being stranded: one or two words
         * under the minimum measure, alone at the left edge, is the failure a
         * presenter sees.
         *
         * It pays nothing for being LONG either, which is only safe because
         * `maxChars` is the ceiling and a caller sets it near the target. Hand
         * this a max far above the target and the closing line will run all
         * the way to it for free: the measure the caller passes is the only
         * thing holding the last line in.
         */
        const wordCount = (atoms[end - 1]?.endIndex ?? 0) - (atoms[start]?.startIndex ?? 0) + 1;
        if (wordCount <= 2 && width < measure.minChars) {
          cost +=
            ORPHAN_LINE_PENALTY * (wordCount === 1 ? ORPHAN_SINGLE_WORD_MULTIPLIER : 1);
        }
      } else {
        const deviation = (width - measure.targetChars) / measure.targetChars;
        cost += MEASURE_WEIGHT * deviation * deviation;
        if (width < measure.minChars) {
          // Weighted by the seam, not by the shortfall alone — see the note on
          // the constant. `closing` is 0 at a sentence end and BREAK_BASE at an
          // ordinary break, so this is "how much of a hole is this, given how
          // little reason there was to stop here".
          const weakness = Math.min(1, closing / BREAK_BASE);
          cost += SHORT_LINE_PER_CHAR * (measure.minChars - width) * weakness;
        }
      }

      // `<` and not `<=`: `start` walks downward from the shortest candidate
      // line, so the first plan scored wins a tie and ties keep the SHORTEST
      // line. Which of the two it is matters less than that it is fixed —
      // the plan is a fingerprint input, and two equal-cost plans that
      // alternate would churn the layout for no visible reason.
      if (cost < (best[end] ?? Number.POSITIVE_INFINITY)) {
        best[end] = cost;
        from[end] = start;
      }

      // A forced break may not sit inside a line. Lines STARTING at `start` are
      // fine, so this stops after scoring it rather than before.
      if (start > 0 && atoms[start - 1]?.breakAfter) break;
    }
  }

  /* Reconstruct backwards. The ranges are contiguous by construction — each
   * line starts where the previous one ended, and atoms tile the token stream —
   * which is what makes the "every token exactly once, in order" invariant
   * structural rather than something the cost model could accidentally violate.
   * The guard is for a `from` that was never written, which cannot happen
   * (`best[end]` is always finite) and would otherwise be an infinite loop
   * rather than a bug report. */
  const lines: LineBreakLine[] = [];
  let cursor = count;
  while (cursor > 0) {
    const recorded = from[cursor];
    const start =
      recorded === undefined || recorded < 0 || recorded >= cursor ? cursor - 1 : recorded;
    const width = widthOf(start, cursor - 1);
    lines.push({
      startIndex: atoms[start]?.startIndex ?? 0,
      endIndex: atoms[cursor - 1]?.endIndex ?? n - 1,
      widthChars: width,
      overflow: width > measure.maxChars,
      reason: cursor === count ? 'end' : (breakReasons[cursor - 1] ?? 'measure'),
    });
    cursor = start;
  }
  lines.reverse();

  const cost = best[count] ?? 0;
  return {
    lines,
    measure,
    cost: Number.isFinite(cost) ? cost : 0,
    signature: planSignature(lines, measure, n),
    tokenCount: n,
  };
}

/**
 * A digest of the break positions and the measure they were solved for.
 *
 * Break positions only — not widths, not costs, not reasons. Those are derived
 * from the same decisions, and a fingerprint that moves when a tuning constant
 * moves would invalidate every cached layout on an upgrade that changed nothing
 * the presenter can see.
 */
function planSignature(
  lines: readonly LineBreakLine[],
  measure: { targetChars: number; maxChars: number; minChars: number },
  tokenCount: number,
): string {
  const breaks = lines.slice(0, -1).map((line) => line.endIndex);
  return hashString(
    `${tokenCount}|${measure.targetChars}:${measure.maxChars}:${measure.minChars}|${breaks.join(',')}`,
  );
}

/* ---------------------------------------------------------------------------
 * The invariant, as an executable check
 * ------------------------------------------------------------------------- */

/**
 * Everything wrong with a plan, as human-readable problems. Empty means valid.
 *
 * This exists because the one unacceptable failure of this module is silent:
 * a plan that drops, duplicates or reorders a token changes what the presenter
 * reads while every test about break QUALITY still passes. It is exported
 * rather than kept private so the code that wires the breaker into the stage
 * can assert it against real compiled documents, which is where the shapes this
 * module has never seen actually come from.
 *
 * It returns problems instead of throwing, because a checker that can take the
 * stage down is worse than the bug it looks for.
 */
export function verifyLineBreakPlan(
  tokens: readonly LineBreakToken[],
  plan: LineBreakPlan,
): string[] {
  const problems: string[] = [];
  if (plan.tokenCount !== tokens.length) {
    problems.push(`tokenCount ${plan.tokenCount} does not match ${tokens.length} tokens`);
  }
  if (tokens.length === 0) {
    if (plan.lines.length > 0) problems.push('empty input produced lines');
    return problems;
  }

  let expected = 0;
  for (const [i, line] of plan.lines.entries()) {
    if (line.startIndex !== expected) {
      problems.push(`line ${i} starts at ${line.startIndex}, expected ${expected}`);
    }
    if (line.endIndex < line.startIndex) {
      problems.push(`line ${i} is empty (${line.startIndex}..${line.endIndex})`);
    }
    expected = line.endIndex + 1;

    /*
     * Recomputed straight from the tokens rather than read back from the
     * solver's prefix sums, so this catches the two of them disagreeing. The
     * width is what a caller sizes a line box against; a plan whose reported
     * width is a character out wraps that box a second time inside itself,
     * which puts a line on the glass nobody planned.
     */
    let width = 0;
    for (let t = line.startIndex; t <= line.endIndex && t < tokens.length; t++) {
      const token = tokens[t];
      if (!token) continue;
      width += visualWidth(typeof token.text === 'string' ? token.text : '');
      if (t < line.endIndex && token.spaceAfter !== false) width += 1;
    }
    if (width !== line.widthChars) {
      problems.push(`line ${i} reports width ${line.widthChars}, tokens measure ${width}`);
    }
    if (line.overflow !== width > plan.measure.maxChars) {
      problems.push(`line ${i} reports overflow ${line.overflow} at width ${width}`);
    }
  }
  if (expected !== tokens.length) {
    problems.push(`plan covers ${expected} of ${tokens.length} tokens`);
  }

  for (let i = 0; i < plan.lines.length - 1; i++) {
    const line = plan.lines[i];
    if (!line || line.endIndex >= tokens.length - 1) continue;
    // Unreachable by construction — a forbidden break is inside an atom, and
    // the solver only ever breaks between them. Checked anyway, because "the
    // atoms tile the token stream" is the assumption the whole invariant rests
    // on, and an assumption nothing tests is a comment.
    if (tokens[line.endIndex]?.noBreakAfter && !tokens[line.endIndex]?.breakAfter) {
      problems.push(`line ${i} breaks after token ${line.endIndex}, which forbids a break`);
    }
  }
  for (const [i, token] of tokens.entries()) {
    if (!token.breakAfter || i === tokens.length - 1) continue;
    if (!plan.lines.some((line) => line.endIndex === i)) {
      problems.push(`forced break after token ${i} was not honoured`);
    }
  }
  return problems;
}

/**
 * The tokens of one line, in order — the mapping every caller needs and none
 * should write twice.
 */
export function tokensForLine<T>(items: readonly T[], line: LineBreakLine): T[] {
  return items.slice(line.startIndex, line.endIndex + 1);
}
