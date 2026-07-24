/**
 * The local critical-term comparator (§19, §25.5).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PRODUCES AND WHY IT IS SO CAUTIOUS
 * ---------------------------------------------------------------------------
 * `CoachCandidate`s of type `critical_number_mismatch`, `critical_unit_mismatch`,
 * `critical_name_mismatch` and `critical_negation_mismatch` — the
 * `fidelity_critical` band, priority 90, second only to hardware failure. A
 * false positive here interrupts a presenter mid-take to tell them they misread
 * a number they read correctly, and the fastest way to make a coaching rail
 * worthless is to be confidently wrong at the loudest volume available.
 *
 * Every decision path is therefore biased toward silence:
 *
 * - a value is a mismatch only after **three** independent match attempts have
 *   failed (literal variant containment, parsed-value equality, digit
 *   concatenation) — see `numbers.ts`;
 * - a unit is a mismatch only when a *different unit of the same dimension* was
 *   actually spoken, never merely because the authored one is missing;
 * - a name is a mismatch only when nothing in the window sounds remotely like
 *   it, with an explicit no-man's-land between "matches" and "clearly differs"
 *   in which nothing is reported;
 * - a negation is a mismatch only when the anchors either side are tight enough
 *   that we know where the word should have been;
 * - **omission is never reported for numbers, units or names.** A missing
 *   number is indistinguishable from an alignment slip, and guessing between
 *   them at priority 90 is not a trade worth making.
 *
 * `material_meaning_change` is **not** produced here, deliberately. Deciding
 * that a paraphrase changed the meaning is a semantic judgement; §25.5 reserves
 * materiality classification for Luna and forbids it from inventing the
 * correction. A local heuristic pretending to do it would be fabrication.
 *
 * ---------------------------------------------------------------------------
 * THE CLOCK AND THE EVIDENCE (contract RULE 3, §5.4)
 * ---------------------------------------------------------------------------
 * Stamps come from the audio times carried on the spoken tokens covering the
 * compared window — never from arrival time. `finalEvidence` is `true` on every
 * emitted candidate because a candidate that could still be revised is dropped
 * rather than downgraded: §25.5 requires "final/highly stable evidence", and a
 * critical alert built on a provisional tail that is then rewritten is the worst
 * outcome available to this module.
 */
import type { CoachCandidate, CoachCandidateType, CoachEvidenceStamp } from '../../contracts/coaching';
import { safeFragment, toWordStream, type NormalWord } from './normalize';
import {
  concatenatedDigitStrings,
  extendsNumberRun,
  findNumberRuns,
  numberVariants,
  type NumberRun,
} from './numbers';
import { findUnits, unitVariants } from './units';
import { countNegations, hasPrefixNegatedForm, positiveStemOfContraction } from './negation';
import {
  NAME_MISMATCH_THRESHOLD,
  findNameRendering,
  nameIsLongEnoughToJudge,
  nameIsPresent,
} from './names';
import { extractCriticalTerms, type AuthoredToken, type CriticalTerm } from './terms';

/* ---------------------------------------------------------------------------
 * Input
 * ------------------------------------------------------------------------- */

/** One transcript token as the comparator sees it. */
export interface SpokenTokenObservation {
  /**
   * Index of this token in the transcript sequence — the **same index space**
   * the aligner's `MatchedPair.transcriptIndex` uses. If these two disagree,
   * every window in this module is silently wrong, so callers must pass the
   * aligner's own indexes rather than re-deriving them.
   */
  transcriptIndex: number;
  /** Transcribed surface. */
  surface: string;
  /** False for provisional text. Provisional evidence never yields a candidate. */
  final: boolean;
  /** Monotonic audio-clock start of the token, ms. */
  audioStartMs: number;
  /** Monotonic audio-clock end of the token, ms. `>= audioStartMs`. */
  audioEndMs: number;
  /** Realtime commit ordinal this token came from, or `null`. */
  commitSequence: number | null;
}

/**
 * One transcript↔script pairing produced by the alignment engine.
 *
 * Structurally satisfied by `tracking/types.ts` `MatchedPair`, so callers pass
 * the aligner's output straight through. **The comparator never re-solves
 * alignment**; it only reads where the aligner already put the presenter.
 */
export interface AlignmentLink {
  transcriptIndex: number;
  scriptTokenIndex: number;
}

/** Everything needed to compare one authored span against what was said. */
export interface FidelitySpanObservation {
  /** Script span id carried onto candidates for dedupe (§46). */
  spanId: string | null;
  /** Authored tokens of the span, in script order. */
  authored: readonly AuthoredToken[];
  /** Transcript tokens covering the span, in transcript order. */
  spoken: readonly SpokenTokenObservation[];
  /** Aligner pairings between the two. */
  alignment: readonly AlignmentLink[];
  trackingEpoch: number;
  takePassId: string;
  /** `<!-- cc:coach off -->` for this span (§19.4). Suppresses everything. */
  coachingDisabled?: boolean;
}

/* ---------------------------------------------------------------------------
 * Tunables — every one of them exists to make the comparator quieter
 * ------------------------------------------------------------------------- */

/**
 * How far, in authored words, an anchor may sit from the term and still tell us
 * where to look. Beyond this the aligner has not localised the presenter
 * precisely enough for a priority-90 claim.
 */
const MAX_ANCHOR_GAP_WORDS = 4;

/**
 * Widest spoken gap between the two anchors that still counts as "we know what
 * was said here". A larger gap means the presenter said far more than the
 * script did, which is ad-lib territory, not a misread term.
 */
const MAX_WINDOW_WORDS = 8;

/** Slack either side of the anchored gap when looking for a correct reading. */
const MATCH_SLACK_WORDS = 2;

/** How far past the term a self-correction is still credited (§25.5). */
const SELF_CORRECTION_LOOKAHEAD_WORDS = 12;

/**
 * Final spoken tokens that must exist beyond the term before it is judged.
 * Without this the comparator would fire the instant a term was transcribed,
 * before the presenter had the chance to correct themselves.
 */
const MIN_FINAL_TOKENS_AFTER = 2;

/** Bound on candidates emitted per span, so one bad span cannot flood policy. */
const MAX_CANDIDATES_PER_SPAN = 4;

/** Length cap on quoted fragments (§25.5 "length-limited"). */
const MAX_FRAGMENT_CHARS = 64;

/** Words that mark an explicit self-correction (§15 `self_correction`). */
const CORRECTION_CUES: ReadonlySet<string> = new Set([
  'sorry', 'apologies', 'oops', 'rather', 'actually', 'correction', 'scratch',
]);
/**
 * Vocalized fillers, which occupy a spoken gap without saying anything. A
 * negation replaced by "uh" was still dropped.
 */
const FILLER_WORDS: ReadonlySet<string> = new Set([
  'uh', 'um', 'erm', 'uhm', 'hmm', 'mm', 'ah', 'er',
]);

const CORRECTION_CUE_PHRASES: ReadonlyArray<readonly string[]> = [
  ['i', 'mean'],
  ['excuse', 'me'],
  ['let', 'me'],
  ['start', 'again'],
  ['take', 'that', 'back'],
];

/* ---------------------------------------------------------------------------
 * Internals
 * ------------------------------------------------------------------------- */

interface Anchor {
  authoredFirstWord: number;
  authoredLastWord: number;
  spokenFirstWord: number;
  spokenLastWord: number;
}

interface WordSpanIndex {
  firstWord: Map<number, number>;
  lastWord: Map<number, number>;
}

function indexWordsBySource(words: readonly NormalWord[]): WordSpanIndex {
  const firstWord = new Map<number, number>();
  const lastWord = new Map<number, number>();
  for (let index = 0; index < words.length; index++) {
    const entry = words[index];
    if (entry === undefined) continue;
    if (!firstWord.has(entry.sourceIndex)) firstWord.set(entry.sourceIndex, index);
    lastWord.set(entry.sourceIndex, index);
  }
  return { firstWord, lastWord };
}

/**
 * Build the monotone anchor chain.
 *
 * Non-monotone pairings are dropped rather than repaired: they mean the aligner
 * matched the tail out of order, and using them would produce a window that
 * spans text the presenter never read in that order.
 */
function buildAnchors(
  links: readonly AlignmentLink[],
  authoredPosByToken: ReadonlyMap<number, number>,
  spokenPosByTranscript: ReadonlyMap<number, number>,
  authoredIndex: WordSpanIndex,
  spokenIndex: WordSpanIndex,
): Anchor[] {
  const raw: Anchor[] = [];
  for (const link of links) {
    const authoredPos = authoredPosByToken.get(link.scriptTokenIndex);
    const spokenPos = spokenPosByTranscript.get(link.transcriptIndex);
    if (authoredPos === undefined || spokenPos === undefined) continue;
    const authoredFirstWord = authoredIndex.firstWord.get(authoredPos);
    const authoredLastWord = authoredIndex.lastWord.get(authoredPos);
    const spokenFirstWord = spokenIndex.firstWord.get(spokenPos);
    const spokenLastWord = spokenIndex.lastWord.get(spokenPos);
    if (
      authoredFirstWord === undefined ||
      authoredLastWord === undefined ||
      spokenFirstWord === undefined ||
      spokenLastWord === undefined
    ) {
      continue;
    }
    raw.push({ authoredFirstWord, authoredLastWord, spokenFirstWord, spokenLastWord });
  }
  raw.sort((a, b) => a.authoredFirstWord - b.authoredFirstWord || a.spokenFirstWord - b.spokenFirstWord);

  const chain: Anchor[] = [];
  for (const anchor of raw) {
    const previous = chain[chain.length - 1];
    if (previous !== undefined) {
      if (anchor.authoredFirstWord <= previous.authoredLastWord) continue;
      if (anchor.spokenFirstWord <= previous.spokenLastWord) continue;
    }
    chain.push(anchor);
  }
  return chain;
}

interface Window {
  /** Anchored gap, in spoken word indexes. `[start, end)`. */
  start: number;
  end: number;
  left: Anchor | undefined;
  right: Anchor;
}

/** Resolve the spoken window for a term, or `undefined` when it is not safe. */
function windowFor(term: CriticalTerm, anchors: readonly Anchor[]): Window | undefined {
  let left: Anchor | undefined;
  let right: Anchor | undefined;
  for (const anchor of anchors) {
    if (anchor.authoredLastWord < term.wordStart) left = anchor;
    if (right === undefined && anchor.authoredFirstWord >= term.wordEnd) right = anchor;
  }
  // A right anchor is mandatory. Without it the presenter has not yet been
  // localised past the term, and "everything after here" is not a window.
  if (right === undefined) return undefined;
  if (right.authoredFirstWord - term.wordEnd > MAX_ANCHOR_GAP_WORDS) return undefined;
  if (left !== undefined && term.wordStart - left.authoredLastWord - 1 > MAX_ANCHOR_GAP_WORDS) {
    return undefined;
  }
  const start = left === undefined ? 0 : left.spokenLastWord + 1;
  const end = right.spokenFirstWord;
  if (end < start) return undefined;
  if (end - start > MAX_WINDOW_WORDS) return undefined;
  return { start, end, left, right };
}

function slice(words: readonly NormalWord[], start: number, end: number): string[] {
  const out: string[] = [];
  for (let index = Math.max(0, start); index < Math.min(words.length, end); index++) {
    const entry = words[index];
    if (entry !== undefined) out.push(entry.word);
  }
  return out;
}

/**
 * Does `words` contain `phrase` as consecutive words?
 *
 * `maximal` rejects a match that is merely the head of a longer number run, so
 * an authored `20` is not satisfied by a spoken "twenty two". Without it the
 * comparator would silently pass real misreadings.
 */
function containsPhrase(words: readonly string[], phrase: string, maximal: boolean): boolean {
  const parts = phrase.split(' ').filter((part) => part.length > 0);
  if (parts.length === 0) return false;
  for (let start = 0; start + parts.length <= words.length; start++) {
    let hit = true;
    for (let offset = 0; offset < parts.length; offset++) {
      if (words[start + offset] !== parts[offset]) {
        hit = false;
        break;
      }
    }
    if (!hit) continue;
    if (maximal) {
      const before = words[start - 1];
      const after = words[start + parts.length];
      if (before !== undefined && extendsNumberRun(before)) continue;
      if (after !== undefined && extendsNumberRun(after)) continue;
    }
    return true;
  }
  return false;
}

function containsCorrectionCue(words: readonly string[]): boolean {
  for (const word of words) {
    if (word !== undefined && CORRECTION_CUES.has(word)) return true;
  }
  for (const phrase of CORRECTION_CUE_PHRASES) {
    if (containsPhrase(words, phrase.join(' '), false)) return true;
  }
  return false;
}

/**
 * A bare "one" on the spoken side is an article or a pronoun far more often
 * than a quantity, and letting it count as a competing number turns ordinary
 * paraphrase into a fabricated mismatch.
 */
function isReportableRun(words: readonly string[], run: NumberRun): boolean {
  if (run.length > 1) return true;
  if (words[run.start] !== 'one') return true;
  const before = words[run.start - 1];
  const after = words[run.start + 1];
  return (
    (before !== undefined && extendsNumberRun(before)) ||
    (after !== undefined && extendsNumberRun(after))
  );
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
}

/* ---------------------------------------------------------------------------
 * Comparison
 * ------------------------------------------------------------------------- */

interface Finding {
  type: CoachCandidateType;
  detailCode: string;
  localConfidence: number;
  spokenFragment: string;
}

/** Result of one term's evaluation, for tests and diagnostics. */
export type TermVerdict = 'matched' | 'mismatched' | 'unknown' | 'suppressed_provisional' | 'suppressed_self_correction';

export interface FidelityComparison {
  candidates: CoachCandidate[];
  /** Per-term verdicts in term order. Diagnostic only; never rendered. */
  verdicts: Array<{ term: CriticalTerm; verdict: TermVerdict }>;
}

/**
 * Compare one authored span against the aligned transcript for the same span.
 *
 * Returns candidates *and* per-term verdicts. The verdicts exist so that tests
 * can prove a "no candidate" result came from a **match** rather than from the
 * comparator failing to find the term at all — the difference between a
 * comparator that is correct and one that merely never speaks.
 */
export function compareSpanFidelity(observation: FidelitySpanObservation): FidelityComparison {
  const empty: FidelityComparison = { candidates: [], verdicts: [] };
  if (observation.coachingDisabled === true) return empty;
  if (observation.authored.length === 0 || observation.spoken.length === 0) return empty;

  const { words: authoredWords, terms } = extractCriticalTerms(observation.authored);
  if (terms.length === 0) return empty;

  const spokenWords = toWordStream(observation.spoken.map((token) => token.surface));
  if (spokenWords.length === 0) return empty;

  const authoredPosByToken = new Map<number, number>();
  observation.authored.forEach((token, position) => {
    authoredPosByToken.set(token.tokenIndex, position);
  });
  const spokenPosByTranscript = new Map<number, number>();
  observation.spoken.forEach((token, position) => {
    spokenPosByTranscript.set(token.transcriptIndex, position);
  });

  const anchors = buildAnchors(
    observation.alignment,
    authoredPosByToken,
    spokenPosByTranscript,
    indexWordsBySource(authoredWords),
    indexWordsBySource(spokenWords),
  );
  if (anchors.length === 0) return empty;

  const candidates: CoachCandidate[] = [];
  const verdicts: FidelityComparison['verdicts'] = [];

  for (const term of terms) {
    const window = windowFor(term, anchors);
    if (window === undefined) {
      verdicts.push({ term, verdict: 'unknown' });
      continue;
    }

    const tight = slice(spokenWords, window.start, window.end);
    const matchWords = slice(
      spokenWords,
      window.start - MATCH_SLACK_WORDS,
      window.end + MATCH_SLACK_WORDS,
    );
    const correctionWords = slice(
      spokenWords,
      window.end + MATCH_SLACK_WORDS,
      window.end + MATCH_SLACK_WORDS + SELF_CORRECTION_LOOKAHEAD_WORDS,
    );

    if (matches(term, matchWords)) {
      verdicts.push({ term, verdict: 'matched' });
      continue;
    }

    const finding = evaluate(term, tight, window);
    if (finding === undefined) {
      verdicts.push({ term, verdict: 'unknown' });
      continue;
    }

    if (selfCorrected(term, correctionWords, [...tight, ...correctionWords])) {
      verdicts.push({ term, verdict: 'suppressed_self_correction' });
      continue;
    }

    const evidence = evidenceFor(observation, spokenWords, window);
    if (evidence === undefined) {
      verdicts.push({ term, verdict: 'suppressed_provisional' });
      continue;
    }

    verdicts.push({ term, verdict: 'mismatched' });
    if (candidates.length >= MAX_CANDIDATES_PER_SPAN) continue;
    candidates.push({
      evidenceId: `fidelity:${finding.type}:${observation.spanId ?? 'span'}:${term.tokenStart}:${evidence.stamp.audioStartMs}`,
      type: finding.type,
      localConfidence: clampConfidence(finding.localConfidence),
      stamp: evidence.stamp,
      scriptSpanId: observation.spanId,
      // The comparator locates the term by word offset inside the span, not by
      // authored token id; §11 gutter marks for fidelity come from review.
      scriptAnchorTokenId: null,
      contributingEventIds: [],
      detailCode: finding.detailCode,
      spokenFragment: safeFragment(finding.spokenFragment, MAX_FRAGMENT_CHARS),
      authoredFragment: safeFragment(term.authoredText, MAX_FRAGMENT_CHARS),
      // Enforced by `evidenceFor`: a candidate that could still be revised is
      // dropped above rather than emitted with `false`.
      finalEvidence: true,
    });
  }

  return { candidates, verdicts };
}

/** Did the presenter render this term correctly, however they worded it? */
function matches(term: CriticalTerm, words: readonly string[]): boolean {
  switch (term.kind) {
    case 'number': {
      const value = term.value;
      if (value === undefined) return true;
      const variants = numberVariants(value, {
        ordinal: term.ordinal === true,
        literalWords: term.words,
      });
      for (const variant of variants) {
        if (containsPhrase(words, variant, true)) return true;
      }
      for (const run of findNumberRuns(words)) {
        if (run.value === value) return true;
      }
      return concatenatedDigitStrings(words).has(String(value));
    }
    case 'unit': {
      const id = term.unitId;
      if (id === undefined) return true;
      for (const variant of unitVariants(id)) {
        if (containsPhrase(words, variant, false)) return true;
      }
      return false;
    }
    case 'name':
      return nameIsPresent(term.words, words);
    case 'negation': {
      if (countNegations(words) > 0) return true;
      for (const stem of term.negatedStems ?? []) {
        if (hasPrefixNegatedForm(words, stem)) return true;
      }
      return false;
    }
    default:
      return true;
  }
}

/**
 * Was the term corrected shortly after being misread?
 *
 * For numbers, units and names a correct rendering appearing downstream is
 * itself the evidence — "fifteen… fifty percent" needs no apology to be a
 * self-correction. A negation is different: `not` recurring eight words later
 * is ordinary English, so an explicit correction cue is required before it
 * counts.
 */
function selfCorrected(
  term: CriticalTerm,
  correctionWords: readonly string[],
  cueSearchWords: readonly string[],
): boolean {
  if (correctionWords.length === 0) return false;
  if (!matches(term, correctionWords)) return false;
  if (term.kind !== 'negation') return true;
  return containsCorrectionCue(cueSearchWords);
}

/** Decide whether the tight window carries a reportable mismatch. */
function evaluate(
  term: CriticalTerm,
  tight: readonly string[],
  window: Window,
): Finding | undefined {
  switch (term.kind) {
    case 'number': {
      const value = term.value;
      if (value === undefined) return undefined;
      const runs = findNumberRuns(tight).filter((run) => isReportableRun(tight, run));
      const spoken = runs[0];
      // Omission is not reported: an absent number is indistinguishable from
      // an alignment slip, and only a *substitution* is safe to claim.
      if (spoken === undefined) return undefined;
      if (spoken.value === value) return undefined;
      // Quote the whole adjacent run chain, not just the first run: a spoken
      // "twenty twenty seven" parses as 20 then 27, and showing the presenter
      // "twenty" as what they said would be actively misleading.
      let quoteEnd = spoken.start + spoken.length;
      for (const run of runs) {
        if (run.start === quoteEnd) quoteEnd = run.start + run.length;
      }
      return {
        type: 'critical_number_mismatch',
        detailCode: 'number_substituted',
        localConfidence: tight.length <= 4 ? 0.85 : 0.7,
        spokenFragment: tight.slice(spoken.start, quoteEnd).join(' '),
      };
    }
    case 'unit': {
      const id = term.unitId;
      const dimension = term.unitDimension;
      if (id === undefined || dimension === undefined) return undefined;
      const rival = findUnits(tight).find(
        (occurrence) =>
          occurrence.definition.dimension === dimension && occurrence.definition.id !== id,
      );
      if (rival === undefined) return undefined;
      return {
        type: 'critical_unit_mismatch',
        detailCode: `unit_substituted:${rival.definition.id}`,
        localConfidence: tight.length <= 4 ? 0.75 : 0.6,
        spokenFragment: tight.slice(rival.start, rival.start + rival.length).join(' '),
      };
    }
    case 'name': {
      if (tight.length === 0) return undefined;
      if (!nameIsLongEnoughToJudge(term.words)) return undefined;
      const rendering = findNameRendering(term.words, tight);
      // The band between the mismatch and match thresholds is an explicit
      // "we do not know" — reporting inside it would be a guess at priority 90.
      if (rendering.similarity > NAME_MISMATCH_THRESHOLD) return undefined;
      const start = rendering.start >= 0 ? rendering.start : 0;
      const length = rendering.length > 0 ? rendering.length : tight.length;
      return {
        type: 'critical_name_mismatch',
        detailCode: 'name_substituted',
        // Names are the least reliable class here; the ceiling reflects that
        // and leaves the materiality call to Luna.
        localConfidence: 0.45 + 0.15 * (1 - rendering.similarity / NAME_MISMATCH_THRESHOLD),
        spokenFragment: tight.slice(start, start + length).join(' '),
      };
    }
    case 'negation': {
      // A dropped negation is the one class where *omission* is the signal, so
      // it demands the tightest anchoring: we must be able to see that the
      // presenter went straight from the word before to the word after.
      if (window.left === undefined) return undefined;
      const residue = tight.filter((word) => !FILLER_WORDS.has(word));
      if (residue.length === 0) {
        return {
          type: 'critical_negation_mismatch',
          detailCode: 'negation_dropped',
          localConfidence: tight.length === 0 ? 0.8 : 0.75,
          spokenFragment: tight.join(' '),
        };
      }
      // The presenter said *something* where the negation was. Whether it
      // still carries the negation is a semantic question ("not final" read as
      // "still preliminary" preserves the meaning exactly), and §25.5 gives
      // that judgement to Luna. The single exception is the contraction whose
      // positive half was read on its own — "we don't ship" as "we do ship" —
      // which is lexical, not semantic, and therefore safe to claim.
      const stem = positiveStemOfContraction(term.words[0] ?? '');
      if (stem === undefined || residue.length !== 1 || residue[0] !== stem) return undefined;
      return {
        type: 'critical_negation_mismatch',
        detailCode: 'negation_stem_read_positive',
        localConfidence: 0.75,
        spokenFragment: tight.join(' '),
      };
    }
    default:
      return undefined;
  }
}

/**
 * Build the evidence stamp, or `undefined` when the evidence is not final and
 * stable enough to act on (§25.5).
 *
 * Two conditions, both necessary:
 * - every spoken token covering the compared window is final;
 * - at least {@link MIN_FINAL_TOKENS_AFTER} final tokens exist past the window,
 *   so the presenter has demonstrably moved on and a correction would already
 *   have been transcribed.
 */
function evidenceFor(
  observation: FidelitySpanObservation,
  spokenWords: readonly NormalWord[],
  window: Window,
): { stamp: CoachEvidenceStamp } | undefined {
  const covered = new Set<number>();
  for (let index = window.start; index < window.end; index++) {
    const entry = spokenWords[index];
    if (entry !== undefined) covered.add(entry.sourceIndex);
  }
  // The anchors bracketing the window are part of the claim: if either is
  // provisional the window's boundaries can still move.
  const rightEntry = spokenWords[window.right.spokenFirstWord];
  if (rightEntry !== undefined) covered.add(rightEntry.sourceIndex);
  if (window.left !== undefined) {
    const leftEntry = spokenWords[window.left.spokenLastWord];
    if (leftEntry !== undefined) covered.add(leftEntry.sourceIndex);
  }
  if (covered.size === 0) return undefined;

  let audioStartMs = Number.POSITIVE_INFINITY;
  let audioEndMs = Number.NEGATIVE_INFINITY;
  let commitSequence: number | null = null;
  let lastPosition = -1;
  for (const position of covered) {
    const token = observation.spoken[position];
    if (token === undefined) return undefined;
    if (!token.final) return undefined;
    audioStartMs = Math.min(audioStartMs, token.audioStartMs);
    audioEndMs = Math.max(audioEndMs, token.audioEndMs);
    if (position > lastPosition) {
      lastPosition = position;
      commitSequence = token.commitSequence;
    }
  }
  if (!Number.isFinite(audioStartMs) || !Number.isFinite(audioEndMs)) return undefined;

  let finalAfter = 0;
  for (let position = lastPosition + 1; position < observation.spoken.length; position++) {
    const token = observation.spoken[position];
    if (token?.final === true) finalAfter += 1;
  }
  if (finalAfter < MIN_FINAL_TOKENS_AFTER) return undefined;

  return {
    stamp: {
      audioStartMs,
      audioEndMs: Math.max(audioStartMs, audioEndMs),
      commitSequence,
      trackingEpoch: observation.trackingEpoch,
      takePassId: observation.takePassId,
    },
  };
}
