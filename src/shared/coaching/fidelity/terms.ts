/**
 * Critical-term extraction from authored script text (§19.2).
 *
 * §19.2 lists what the compiler derives — "numbers, dates, units, names, URLs,
 * and acronyms" — and this module turns the subset that can be *compared
 * reliably* into terms the comparator can check: numbers (including
 * spelled-out forms), units, proper nouns, and negations.
 *
 * What is deliberately not extracted:
 * - **URLs and email addresses.** A presenter almost never reads them verbatim
 *   ("slash docs slash setup" vs "docs setup"), so every check would be noise.
 * - **Acronyms.** `API` may be authored as one token and spoken as three
 *   letters, or vice versa, and the compiler's `say=` override already handles
 *   the cases where the author cared.
 * - **Month names and weekdays.** Their numeric parts are covered as numbers;
 *   the words themselves are left to Luna, because "March" vs "May" is a
 *   one-phoneme difference that transcription gets wrong on its own.
 *
 * Extraction is *ordered*: a word claimed by an earlier term is never re-used
 * by a later one, so `"not 50%"` produces one negation and one number, never
 * three overlapping checks that would each fire separately.
 */
import { TOKEN_FLAGS } from '../../contracts/compiler';
import { toWordStream, type NormalWord } from './normalize';
import { findNumberRuns, extendsNumberRun } from './numbers';
import { findUnits, type UnitDimension } from './units';
import { negates } from './negation';

export type CriticalTermKind = 'number' | 'unit' | 'name' | 'negation';

/** One authored token as the comparator needs to see it. */
export interface AuthoredToken {
  /** Absolute spoken-token index in the compiled script. */
  tokenIndex: number;
  /** Exact authored surface — the only text ever quoted back (§25.5). */
  surface: string;
  /**
   * Compiler token flags. When present they are authoritative for proper-noun
   * detection; when absent a conservative capitalization heuristic is used.
   */
  flags?: number;
  /** Sentence this token belongs to, used to find sentence-initial capitals. */
  sentenceId?: string;
}

export interface CriticalTerm {
  kind: CriticalTermKind;
  /** Inclusive/exclusive range in the authored word stream. */
  wordStart: number;
  wordEnd: number;
  /** Inclusive range of authored array positions the term covers. */
  tokenStart: number;
  tokenEnd: number;
  /** Normalized words of the term itself. */
  words: string[];
  /** Exact authored text for the tip quote, already length-limited. */
  authoredText: string;
  /** Numeric value, for `number` terms. */
  value?: number;
  /** True when the authored form was ordinal. */
  ordinal?: boolean;
  /** Canonical unit id, for `unit` terms. */
  unitId?: string;
  unitDimension?: UnitDimension;
  /**
   * For `negation` terms: the normalized content words the negation scopes
   * over, used to recognise "unavailable" as preserving "not available".
   */
  negatedStems?: string[];
}

export interface ExtractedTerms {
  /** The authored word stream the term offsets refer to. */
  words: NormalWord[];
  terms: CriticalTerm[];
}

/** Words that are capitalized constantly and are not names. */
const NOT_NAMES: ReadonlySet<string> = new Set([
  'i', 'the', 'a', 'an', 'and', 'but', 'we', 'you', 'they', 'it', 'this',
  'that', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
  'sunday', 'january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december',
]);

/** Shortest authored name considered. Below this, phonetics are meaningless. */
const MIN_NAME_LENGTH = 4;

/**
 * Extra authored tokens included in a negation's quote, so the rail can show
 * `Script says "not available"` rather than a bare `"not"` (§25.5).
 */
const NEGATION_QUOTE_TOKENS = 1;

function isProperNoun(
  token: AuthoredToken,
  sentenceInitial: boolean,
  normalized: string,
): boolean {
  if (token.flags !== undefined) {
    // The compiler already resolved sentence-initial capitals and the
    // mid-sentence capitalization evidence (§25.2); second-guessing it here
    // would produce a different answer to the rest of the pipeline.
    return (token.flags & TOKEN_FLAGS.PROPER_NOUN) !== 0;
  }
  if (sentenceInitial) return false;
  if (normalized.length < MIN_NAME_LENGTH) return false;
  if (NOT_NAMES.has(normalized)) return false;
  // "Fridays" and "Mondays" are capitalized every time and are not names.
  if (normalized.endsWith('s') && NOT_NAMES.has(normalized.slice(0, -1))) return false;
  return /^\p{Lu}/u.test(token.surface);
}

function quoteRange(tokens: readonly AuthoredToken[], start: number, end: number): string {
  const parts: string[] = [];
  for (let index = start; index <= end; index++) {
    const token = tokens[index];
    if (token !== undefined) parts.push(token.surface);
  }
  return parts.join(' ');
}

/**
 * Extract every critical term from a run of authored tokens.
 *
 * The returned word stream is the comparator's coordinate system: term offsets
 * and alignment anchors are both expressed in it, so a token that normalizes to
 * two words (`50%` → `50 percent`) cannot desynchronise them.
 */
export function extractCriticalTerms(tokens: readonly AuthoredToken[]): ExtractedTerms {
  const words = toWordStream(tokens.map((token) => token.surface));
  const forms = words.map((entry) => entry.word);
  const claimed = new Array<boolean>(words.length).fill(false);
  const terms: CriticalTerm[] = [];

  const sentenceInitial = new Set<number>();
  const seenSentences = new Set<string>();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === undefined) continue;
    const sentenceId = token.sentenceId;
    if (sentenceId === undefined) {
      if (index === 0) sentenceInitial.add(index);
      continue;
    }
    if (!seenSentences.has(sentenceId)) {
      seenSentences.add(sentenceId);
      sentenceInitial.add(index);
    }
  }

  const tokenRangeFor = (wordStart: number, wordEnd: number): [number, number] => {
    const first = words[wordStart];
    const last = words[wordEnd - 1];
    return [first?.sourceIndex ?? 0, last?.sourceIndex ?? first?.sourceIndex ?? 0];
  };

  const claim = (wordStart: number, wordEnd: number): boolean => {
    for (let index = wordStart; index < wordEnd; index++) {
      if (claimed[index] === true) return false;
    }
    for (let index = wordStart; index < wordEnd; index++) claimed[index] = true;
    return true;
  };

  // 1. Negations first: a dropped "not" is the highest-value check, and it
  //    must win the word if it somehow overlaps anything else.
  for (let index = 0; index < forms.length; index++) {
    const word = forms[index];
    if (word === undefined || !negates(word)) continue;
    if (!claim(index, index + 1)) continue;
    const [tokenStart, tokenEnd] = tokenRangeFor(index, index + 1);
    const quoteEnd = Math.min(tokens.length - 1, tokenEnd + NEGATION_QUOTE_TOKENS);
    const stems: string[] = [];
    for (let ahead = index + 1; ahead < Math.min(forms.length, index + 4); ahead++) {
      const stem = forms[ahead];
      if (stem !== undefined && stem.length >= MIN_NAME_LENGTH) stems.push(stem);
    }
    terms.push({
      kind: 'negation',
      wordStart: index,
      wordEnd: index + 1,
      tokenStart,
      tokenEnd,
      words: [word],
      authoredText: quoteRange(tokens, tokenStart, quoteEnd),
      negatedStems: stems,
    });
  }

  // 2. Numbers.
  for (const run of findNumberRuns(forms)) {
    if (!isReportableNumber(forms, run.start, run.length)) continue;
    if (!claim(run.start, run.start + run.length)) continue;
    const [tokenStart, tokenEnd] = tokenRangeFor(run.start, run.start + run.length);
    terms.push({
      kind: 'number',
      wordStart: run.start,
      wordEnd: run.start + run.length,
      tokenStart,
      tokenEnd,
      words: forms.slice(run.start, run.start + run.length),
      authoredText: quoteRange(tokens, tokenStart, tokenEnd),
      value: run.value,
      ordinal: run.ordinal,
    });
  }

  // 3. Units.
  for (const occurrence of findUnits(forms)) {
    if (!claim(occurrence.start, occurrence.start + occurrence.length)) continue;
    const [tokenStart, tokenEnd] = tokenRangeFor(
      occurrence.start,
      occurrence.start + occurrence.length,
    );
    terms.push({
      kind: 'unit',
      wordStart: occurrence.start,
      wordEnd: occurrence.start + occurrence.length,
      tokenStart,
      tokenEnd,
      words: forms.slice(occurrence.start, occurrence.start + occurrence.length),
      authoredText: quoteRange(tokens, tokenStart, tokenEnd),
      unitId: occurrence.definition.id,
      unitDimension: occurrence.definition.dimension,
    });
  }

  // 4. Proper nouns, merging consecutive ones into a single name.
  let index = 0;
  while (index < words.length) {
    const entry = words[index];
    if (entry === undefined) {
      index += 1;
      continue;
    }
    const token = tokens[entry.sourceIndex];
    if (
      token === undefined ||
      claimed[index] === true ||
      !isProperNoun(token, sentenceInitial.has(entry.sourceIndex), entry.word)
    ) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < words.length) {
      const nextEntry = words[end];
      if (nextEntry === undefined || claimed[end] === true) break;
      const nextToken = tokens[nextEntry.sourceIndex];
      if (
        nextToken === undefined ||
        !isProperNoun(nextToken, sentenceInitial.has(nextEntry.sourceIndex), nextEntry.word)
      ) {
        break;
      }
      end += 1;
    }
    if (claim(index, end)) {
      const [tokenStart, tokenEnd] = tokenRangeFor(index, end);
      terms.push({
        kind: 'name',
        wordStart: index,
        wordEnd: end,
        tokenStart,
        tokenEnd,
        words: forms.slice(index, end),
        authoredText: quoteRange(tokens, tokenStart, tokenEnd),
      });
    }
    index = end;
  }

  terms.sort((a, b) => a.wordStart - b.wordStart);
  return { words, terms };
}

/**
 * A bare "one" is far more often an article or a pronoun than a quantity, and
 * checking it produces false alarms out of ordinary paraphrase. It is only
 * treated as a number when something numeric sits next to it.
 */
function isReportableNumber(forms: readonly string[], start: number, length: number): boolean {
  if (length > 1) return true;
  const word = forms[start];
  if (word !== 'one') return true;
  const before = forms[start - 1];
  const after = forms[start + 1];
  if (before !== undefined && extendsNumberRun(before)) return true;
  if (after !== undefined && extendsNumberRun(after)) return true;
  return false;
}
