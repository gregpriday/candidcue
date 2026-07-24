/**
 * Contextual classification (§2.4, §16.4).
 *
 * This module exists to say **no**. Every word in the contextual vocabulary is
 * a legitimate English word, and the cost of a false positive here is not a
 * slightly wrong number — it is a presenter watching a red mark appear every
 * time they say "and" and switching the rail off in the first minute. The
 * asymmetry is deliberate: missing a genuine "you know" costs almost nothing,
 * flagging "I like this approach" costs the feature.
 *
 * The classifier is therefore built as a **gate**, not a score:
 *
 * 1. A per-form *lexical-use veto* — the patterns in which the word is
 *    unambiguously doing lexical work ("I like", "so much", "turn right",
 *    "you know the answer"). A veto is final; no amount of other evidence
 *    overrides it.
 * 2. A per-form *structural gate* — most forms must be set off by pauses on
 *    both sides, or be sentence-initial before a break. `It was, like, a
 *    completely different result` passes; `It was like magic` does not
 *    (§16.4's own examples).
 * 3. A per-form *repetition requirement* — words that carry real meaning
 *    (`actually`, `kind of`, `right`) are only interesting as a pattern.
 * 4. Only then is the §16.4 evidence list scored, to produce an honest
 *    confidence rather than a boolean.
 *
 * A veto suppressed by an intervening pause is not a veto: the comma in
 * `It was, like, a…` separates `was` from `like`, so `was`'s lexical claim no
 * longer covers the token. That rule is applied uniformly to both neighbours.
 */
import type { UtteranceToken } from './utterance';

export interface ContextualEvidence {
  /** Canonical form, e.g. `you know`. */
  form: string;
  /** Index of the first token of the match. */
  tokenIndex: number;
  /** Number of tokens the form spans. */
  length: number;
  /** True when the form does not appear in the aligned authored span (§16.4). */
  absentFromAuthored: boolean;
  /** True when local audio shows a hesitation overlapping this token (§16.2). */
  acousticHesitation: boolean;
  /** Prior occurrences of the same form in the recent window (§16.4). */
  priorOccurrences: number;
  /** True when the form sits inside quoted speech or a fixed phrase (§16.4). */
  inQuotation: boolean;
  /** True for user-added phrases (§15.6), which carry no built-in policy. */
  custom?: boolean;
}

export interface ContextualVerdict {
  isFiller: boolean;
  /** 0–1. Meaningful only when `isFiller` is true. */
  score: number;
  /** The veto pattern that rejected the token, or `null`. */
  veto: string | null;
  /** Human-readable evidence trail, for diagnostics and test failure messages. */
  reasons: string[];
}

interface FormPolicy {
  /**
   * The form must be set off by a break (comma / dash / terminator / acoustic
   * pause) on both sides to be considered a filler at all.
   */
  requiresBothSideBreaks: boolean;
  /** A sentence-initial occurrence followed by a break also satisfies the gate. */
  allowsSentenceInitial: boolean;
  /** Minimum prior occurrences in the window before the form is interesting. */
  requiresPriorOccurrences: number;
  /** §16.4: "deleting it leaves the sentence meaning intact". */
  deletionPreservesMeaning: boolean;
  /** Preceding tokens that prove lexical use (applied only across no break). */
  prevVeto: readonly string[];
  /** Following tokens that prove lexical use (applied only across no break). */
  nextVeto: readonly string[];
}

const DEFAULT_POLICY: FormPolicy = {
  requiresBothSideBreaks: false,
  allowsSentenceInitial: true,
  requiresPriorOccurrences: 0,
  deletionPreservesMeaning: true,
  prevVeto: [],
  nextVeto: [],
};

/**
 * Per-form policy. The veto lists are the load-bearing part of this file; each
 * entry is a construction in which the word is doing lexical work.
 */
const POLICIES: Readonly<Record<string, FormPolicy>> = {
  like: {
    requiresBothSideBreaks: true,
    allowsSentenceInitial: false,
    requiresPriorOccurrences: 0,
    deletionPreservesMeaning: true,
    // "I like", "we would like", "looks like", "just like", "something like".
    prevVeto: [
      'i', 'you', 'we', 'they', 'he', 'she', 'who', 'people', 'users', 'everyone',
      'would', 'really', 'also', 'both', 'to', 'not', "don't", "doesn't", "didn't",
      'looks', 'look', 'looked', 'looking', 'sounds', 'sound', 'sounded', 'feels',
      'feel', 'felt', 'seems', 'seem', 'seemed', 'smells', 'tastes', 'acts',
      'just', 'much', 'more', 'something', 'anything', 'nothing', 'someone',
      'exactly', 'somewhat', 'behaves', 'treat', 'treats',
    ],
    // "like to", "like this one", "like a pro" read as similes/verbs.
    nextVeto: ['to', 'that', 'this', 'these', 'those', 'them', 'it', 'him', 'her', 'us', 'me'],
  },
  so: {
    requiresBothSideBreaks: true,
    allowsSentenceInitial: false,
    requiresPriorOccurrences: 0,
    deletionPreservesMeaning: true,
    prevVeto: ['not', 'even', 'and', 'or'],
    // "so that", "so much", "so many", "so far", "so good".
    nextVeto: ['that', 'much', 'many', 'far', 'long', 'few', 'little', 'good', 'bad', 'we', 'i', 'they', 'you', 'it'],
  },
  right: {
    requiresBothSideBreaks: true,
    allowsSentenceInitial: false,
    requiresPriorOccurrences: 2,
    deletionPreservesMeaning: true,
    prevVeto: ['turn', 'turned', 'turning', 'the', 'a', 'all', 'far', 'is', 'was', 'be', "that's", "you're", "he's", "she's", "it's", 'quite', 'exactly', 'absolutely'],
    nextVeto: ['now', 'here', 'there', 'away', 'after', 'before', 'hand', 'side', 'of', 'angle', 'answer', 'thing', 'one', 'way', 'to', 'and'],
  },
  okay: {
    requiresBothSideBreaks: false,
    allowsSentenceInitial: true,
    requiresPriorOccurrences: 2,
    deletionPreservesMeaning: true,
    prevVeto: ['is', 'was', 'are', 'were', 'be', 'been', 'feeling', 'feel', 'felt', 'looks', 'looked', 'sounds', 'sounded', "it's", "that's", "i'm", 'quite', 'perfectly', 'more', 'not'],
    nextVeto: ['with', 'for', 'to', 'if', 'but'],
  },
  well: {
    requiresBothSideBreaks: false,
    allowsSentenceInitial: true,
    requiresPriorOccurrences: 2,
    deletionPreservesMeaning: true,
    // "as well", "done well", "the well", "works well", "I'm well".
    prevVeto: ['as', 'very', 'pretty', 'quite', 'really', 'doing', 'done', 'did', 'does', 'feeling', 'feel', 'works', 'worked', 'work', 'go', 'went', 'goes', 'fits', 'fit', 'the', 'a', 'is', 'was', 'are', "i'm", 'ran', 'run', 'runs', 'performed', 'performs', 'reads', 'scaled', 'scales'],
    nextVeto: ['known', 'being', 'established', 'understood', 'worth', 'over', 'under', 'below', 'above', 'into', 'documented', 'defined', 'tested', 'suited'],
  },
  basically: {
    requiresBothSideBreaks: false,
    allowsSentenceInitial: true,
    requiresPriorOccurrences: 2,
    deletionPreservesMeaning: true,
    prevVeto: [],
    nextVeto: [],
  },
  actually: {
    requiresBothSideBreaks: false,
    allowsSentenceInitial: true,
    requiresPriorOccurrences: 2,
    deletionPreservesMeaning: true,
    prevVeto: [],
    nextVeto: [],
  },
  literally: {
    requiresBothSideBreaks: false,
    allowsSentenceInitial: true,
    requiresPriorOccurrences: 2,
    deletionPreservesMeaning: true,
    prevVeto: [],
    nextVeto: [],
  },
  'you know': {
    requiresBothSideBreaks: false,
    allowsSentenceInitial: false,
    requiresPriorOccurrences: 0,
    deletionPreservesMeaning: true,
    // "do you know", "if you know", "let you know".
    prevVeto: ['do', 'did', 'does', "don't", "didn't", 'if', 'unless', 'whether', 'let', 'lets', 'make', 'makes', 'and', 'when', 'that'],
    // "you know the answer", "you know what I mean", "you know about it".
    nextVeto: ['that', 'the', 'a', 'an', 'what', 'how', 'who', 'why', 'when', 'where', 'it', 'him', 'her', 'them', 'this', 'about', 'of', 'my', 'your', 'his', 'their', 'our', 'me', 'us', 'if', 'i', 'we', 'they', 'he', 'she', 'better', 'more'],
  },
  'i mean': {
    requiresBothSideBreaks: false,
    allowsSentenceInitial: false,
    requiresPriorOccurrences: 0,
    deletionPreservesMeaning: true,
    prevVeto: ['what', 'that', 'when', 'and'],
    nextVeto: ['what', 'that', 'it', 'this', 'to', 'business', 'well', 'exactly', 'literally', 'the', 'a', 'every', 'no'],
  },
  'kind of': {
    requiresBothSideBreaks: false,
    allowsSentenceInitial: false,
    // A hedge changes meaning; only a repeated hedge is a delivery pattern.
    requiresPriorOccurrences: 2,
    deletionPreservesMeaning: false,
    // "a kind of", "some kind of", "what kind of", "this kind of".
    prevVeto: ['a', 'an', 'the', 'this', 'that', 'some', 'any', 'what', 'which', 'every', 'each', 'another', 'one', 'other', 'new', 'different', 'no'],
    nextVeto: [],
  },
  'sort of': {
    requiresBothSideBreaks: false,
    allowsSentenceInitial: false,
    requiresPriorOccurrences: 2,
    deletionPreservesMeaning: false,
    prevVeto: ['a', 'an', 'the', 'this', 'that', 'some', 'any', 'what', 'which', 'every', 'each', 'another', 'one', 'other', 'new', 'different', 'no'],
    nextVeto: [],
  },
};

function policyFor(evidence: ContextualEvidence): FormPolicy {
  if (evidence.custom === true) return DEFAULT_POLICY;
  return POLICIES[evidence.form] ?? DEFAULT_POLICY;
}

/**
 * A break before the first token of the match, from punctuation or from an
 * acoustic pause the caller already folded into `precededByBreak`.
 */
function hasLeadingBreak(tokens: readonly UtteranceToken[], index: number): boolean {
  const token = tokens[index];
  if (!token) return false;
  if (index === 0) return true;
  return token.precededByBreak || token.isSentenceStart;
}

function hasTrailingBreak(tokens: readonly UtteranceToken[], lastIndex: number): boolean {
  const token = tokens[lastIndex];
  if (!token) return false;
  if (lastIndex === tokens.length - 1) return true;
  return token.followedByBreak || token.followedByInterruption;
}

/**
 * Classify one contextual match. Pure: same inputs, same verdict, no clock.
 */
export function classifyContextual(
  tokens: readonly UtteranceToken[],
  evidence: ContextualEvidence,
): ContextualVerdict {
  const reasons: string[] = [];
  const policy = policyFor(evidence);
  const firstIndex = evidence.tokenIndex;
  const lastIndex = evidence.tokenIndex + evidence.length - 1;

  if (evidence.inQuotation) {
    return { isFiller: false, score: 0, veto: 'quotation', reasons: ['inside a quotation'] };
  }

  // §16.4: "token is absent from authored text". If it *is* authored, the
  // presenter is reading the script and there is nothing to coach (§15.5).
  if (!evidence.absentFromAuthored) {
    return { isFiller: false, score: 0, veto: 'authored', reasons: ['present in authored text'] };
  }

  const leadingBreak = hasLeadingBreak(tokens, firstIndex);
  const trailingBreak = hasTrailingBreak(tokens, lastIndex);

  // --- 1. Lexical-use veto. A break between the neighbour and the form
  // severs the construction, so the veto no longer applies.
  const previous = firstIndex > 0 ? tokens[firstIndex - 1] : undefined;
  if (previous && !leadingBreak && policy.prevVeto.includes(previous.normalized)) {
    return {
      isFiller: false,
      score: 0,
      veto: `lexical:prev=${previous.normalized}`,
      reasons: [`"${previous.normalized} ${evidence.form}" is lexical use`],
    };
  }
  const next = tokens[lastIndex + 1];
  if (next && !trailingBreak && policy.nextVeto.includes(next.normalized)) {
    return {
      isFiller: false,
      score: 0,
      veto: `lexical:next=${next.normalized}`,
      reasons: [`"${evidence.form} ${next.normalized}" is lexical use`],
    };
  }

  // --- 2. Structural gate.
  const bothSides = leadingBreak && trailingBreak;
  const sentenceInitial = (tokens[firstIndex]?.isSentenceStart ?? false) && trailingBreak;
  // Acoustic hesitation can stand in for the *second* break — realtime
  // transcripts often arrive with no commas at all — but never for both. A
  // hesitation somewhere near a fully embedded word is not evidence that the
  // word was a filler; people pause in the middle of ordinary sentences.
  const hesitationAssist = evidence.acousticHesitation && (leadingBreak || trailingBreak);
  const structurallyIsolated =
    bothSides || (policy.allowsSentenceInitial && sentenceInitial) || hesitationAssist;
  if (policy.requiresBothSideBreaks && !bothSides && !hesitationAssist) {
    return {
      isFiller: false,
      score: 0,
      veto: 'not_isolated',
      reasons: [`"${evidence.form}" is not set off by pauses`],
    };
  }
  if (!structurallyIsolated) {
    return {
      isFiller: false,
      score: 0,
      veto: 'not_isolated',
      reasons: [`"${evidence.form}" is embedded in the clause`],
    };
  }
  reasons.push(bothSides ? 'set off by pauses on both sides' : 'isolated at a boundary');

  // --- 3. Repetition requirement for forms that carry real meaning.
  if (evidence.priorOccurrences < policy.requiresPriorOccurrences) {
    return {
      isFiller: false,
      score: 0,
      veto: 'insufficient_repetition',
      reasons: [
        `"${evidence.form}" needs ${policy.requiresPriorOccurrences} prior uses, saw ${evidence.priorOccurrences}`,
      ],
    };
  }

  // --- 4. §16.4 evidence scoring, for an honest confidence.
  let points = 1; // absent from authored, already established
  reasons.push('absent from authored text');
  if (bothSides) points += 1;
  if (evidence.acousticHesitation) {
    points += 1;
    reasons.push('acoustic hesitation overlaps');
  }
  if (evidence.priorOccurrences >= 3) {
    points += 1;
    reasons.push(`repeats (${evidence.priorOccurrences} prior)`);
  }
  if (policy.deletionPreservesMeaning) {
    points += 1;
    reasons.push('deleting it preserves meaning');
  }

  const maxPoints = 5;
  return { isFiller: true, score: Math.min(1, points / maxPoints), veto: null, reasons };
}

/**
 * §16.7: "Do not quote a contextual word unless classification confidence is
 * very high." Exported so the candidate generator and the tip policy agree on
 * one number instead of two.
 */
export const CONTEXTUAL_QUOTE_CONFIDENCE = 0.8;

/** Minimum score for a contextual detection to be promotable to `confirmed`. */
export const CONTEXTUAL_CONFIRM_CONFIDENCE = 0.6;
