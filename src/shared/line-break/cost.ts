/**
 * The cost model.
 *
 * Two currencies, deliberately on one scale: how wrong the line LOOKS
 * (raggedness) and how wrong the break SOUNDS (the seam). Both are in the same
 * arbitrary units, and the ratio between them is the only interesting number in
 * this module — it is what decides whether a short line is worth a better
 * break. The values below buy about one third of a measure of shortness for one
 * good seam, which is what the reference case in the tests pins.
 *
 * Nothing here knows what unit the measure is in. `MEASURE_WEIGHT` is applied to
 * a FRACTION of the target, not to a count, so the same constants behave the
 * same whether the caller is counting character cells or pixels.
 */

import {
  ADJECTIVE_SUFFIX,
  AUXILIARIES,
  CLAUSE_OPENERS,
  COMMON_ADJECTIVES,
  CONJUNCTIONS,
  DETERMINERS,
  HONORIFICS,
  PREPOSITIONS,
  PRONOUNS,
  UNITS,
  type WordFacts,
} from './lexicon';
import type { LineBreakReason } from './types';

/**
 * Raggedness weight, applied to the SQUARED fractional deviation from target.
 *
 * Squared rather than linear so that two mildly short lines are cheaper than
 * one severe one — the same reason typesetters minimise squared badness.
 *
 * Raised from 14 after the first version reached a real stage, where the
 * breaker was shortening lines further than anything on the glass justified —
 * on a 36-character column it put the single word "readable," on a line. At 14
 * that line cost about 10 all in, against seam penalties reaching 52, so
 * reaching a comma was worth almost any amount of measure.
 *
 * The ceiling on this constant is sharp and it is NOT the taste of the result:
 * at 21 the model starts splitting a pronoun from its verb, and at 22 a number
 * from its unit, both at narrow columns — buying a full line by committing the
 * failures the module exists to prevent. 28 was measured and reverted for
 * exactly that. `width.test.ts` gates it in the configuration the stage
 * actually solves with, which is where those splits appear; the sweep in
 * `line-break.test.ts` gives the solver 12% of slack and does not see them.
 */
export const MEASURE_WEIGHT = 20;

/**
 * The least a hole can cost, however good the seam that closed it.
 *
 * The hole penalty is scaled by how WEAK the closing seam is, which is right:
 * a ten-character line ending on "…on Monday," is a deliberate beat and a
 * ten-character line ending mid-clause is damage. But the scale ran all the way
 * to zero — `closing` is 0 at a sentence end and 1.5 at a comma against a
 * `BREAK_BASE` of 10 — so the charge all but vanished exactly where the seam
 * was best.
 *
 * Stated precisely, because the honest version is smaller than it sounds: a
 * comma still paid 15% of the shortfall, so "readable," was not free, and the
 * raggedness term above was already objecting. Neither constant moves that
 * plan on its own — the floor and the weight only reach it together, and by
 * about one unit of cost. What the floor contributes is that a good seam can no
 * longer discount a hole to nearly nothing however severe it is.
 *
 * A line the AUTHOR ended is exempt entirely (see `solve.ts`): a forced break
 * scores 0 like a sentence end, and without the exemption this floor would
 * start charging people for line breaks they typed on purpose.
 */
export const SHORT_LINE_WEAKNESS_FLOOR = 0.28;

/*
 * A PER-LINE TOLL WAS TRIED HERE, AND IS NOT IN THE MODEL. WHY:
 *
 * The model's opinion about how MANY lines it uses is only indirect — each one
 * pays its closing seam, which a strong seam discounts to nearly nothing — so a
 * fixed charge per line is the obvious lever for "break less often", and every
 * line really is a return sweep, so it is not a fudge factor either. Measured
 * over the benchmark scripts it worked: at 12 it took the extra lines over the
 * browser from 14-21% down to 9-11% while slightly IMPROVING the seam count.
 *
 * It is absent because of what it cost at the narrow end. At a 16-17 character
 * column a toll of even 6 made the solver split a number from its unit, split a
 * proper noun, and strand a verb from its pronoun — it bought the line back by
 * committing the exact failures this module exists to prevent, and it did so
 * where a presenter is least able to absorb them. Three of the glue guarantees
 * fail at LINE_COST 6 and five at 20.
 *
 * The lever that turned out to be safe is the pair above: raggedness weight for
 * how much an under-filled line costs, and a floor under the hole penalty so a
 * good seam cannot excuse an arbitrarily short line. Anyone reaching for a
 * per-line toll again should re-run `tests/unit/stage/line-break-quality.test.ts`
 * AND the glue block in `src/shared/line-break.test.ts`, and should expect to
 * have to raise the glue penalties to keep them dominant.
 */

/**
 * An ordinary break: legal, unremarkable, no punctuation and no seam.
 *
 * The absolute value matters less than the DISTANCE from it down to the
 * punctuated seams below and up to the glue above — a plan with the same number
 * of lines pays this the same number of times, so it is the gap that decides
 * anything. It is set high enough that a good seam is worth roughly a third of
 * a measure of shortness, which is the trade the reference case pins.
 */
export const BREAK_BASE = 10;

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
 * scan in the solver refuses to score a multi-atom line that has passed the
 * column at all, so the only line that can overflow is a single indivisible run
 * wider than the whole measure, and such a run is alone on its line in EVERY
 * plan. The toll is therefore the same constant in every plan of one input, and
 * it cancels. What it buys is a `cost` that reports "this text does not fit"
 * loudly enough to notice next to a `cost` that is a raggedness score.
 */
export const OVERFLOW_PENALTY = 400;
export const OVERFLOW_PER_CHAR = 40;

/**
 * A mid-paragraph line under `minChars`, per unit below it — scaled by how WEAK
 * the seam that closed it is.
 *
 * This is what `minChars` is for, and the scaling is the whole idea: a ten
 * character line is a hole in the paragraph when it ends mid-clause, and it is
 * a deliberate beat when it ends on "…on Monday,". Charging both the same is
 * how a breaker ends up refusing the very short strong-seam lines that are the
 * reason to have one at all.
 */
export const SHORT_LINE_PER_CHAR = 2;

/**
 * A closing line of one or two short words.
 *
 * The most visible of all the failures this module exists to fix: the presenter
 * sweeps back to the left edge for "Australia." and the sentence has already
 * ended. Charged only when the final line is genuinely stranded — under the
 * minimum measure AND two words or fewer — so an ordinarily short closing line
 * pays nothing.
 */
export const ORPHAN_LINE_PENALTY = 26;
/** One stranded word is worse than two, and it is worse than proportionally. */
export const ORPHAN_SINGLE_WORD_MULTIPLIER = 1.6;

/**
 * How badly the pair `left` / `right` wants to stay on one line.
 *
 * The maximum of the rules that fire, not the sum — see the note on the glue
 * constants. Returns 0 when nothing objects.
 */
export function gluePenalty(left: WordFacts, right: WordFacts): number {
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
    (COMMON_ADJECTIVES.has(left.core) ||
      (left.core.length > 4 && ADJECTIVE_SUFFIX.test(left.core)))
  ) {
    claim(GLUE_ADJECTIVE);
  }
  return glue;
}

/**
 * The cost and the character of the break between `left` and `right`.
 *
 * `forced` is an authored line break, which is free and outranks everything —
 * there is no judgement to make about a break the writer already made.
 */
export function classifyBreak(
  left: WordFacts,
  right: WordFacts,
  forced: boolean,
): { penalty: number; reason: LineBreakReason } {
  if (forced) return { penalty: 0, reason: 'forced' };

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
