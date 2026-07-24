/**
 * Utterance tokenization for disfluency analysis (§16.1 steps 1–2).
 *
 * The tracking pipeline's `normalizeText` throws punctuation away, which is
 * exactly right for alignment and exactly wrong here: whether "like" is set
 * off by commas, whether "and" opens a sentence, and whether a phrase was cut
 * off by a dash are the features §16.4 and §15.3/§15.4 classify on. So this
 * module keeps the punctuation *around* each token while reusing
 * `normalizeText` for the token's own spelling, so a form matched here is the
 * same string the ledger would produce.
 *
 * §16.1 step 2 — "preserve repeated tokens" — is honoured by never collapsing
 * or de-duplicating: `I, I think` yields two `i` tokens.
 */
import { normalizeText } from '../../tracking/normalize';
import type { WordTiming } from './types';

/** Sentence terminators. */
const TERMINATORS = new Set(['.', '!', '?']);
/** Clause-level breaks: the punctuation that signals a spoken pause. */
const CLAUSE_BREAKS = new Set([',', ';', ':']);
/** Interruption markers: a cut-off word (§15.4 "The next— the next thing"). */
const INTERRUPTIONS = ['—', '–', '--', '…', '...'];

export interface UtteranceToken {
  /** Position in the utterance, 0-based. */
  index: number;
  /** The raw whitespace-delimited chunk this token came from. */
  raw: string;
  /** Lowercased, punctuation-stripped, apostrophes preserved. */
  normalized: string;
  sentenceIndex: number;
  /** True at text start and after any terminator. */
  isSentenceStart: boolean;
  /** True when a comma/semicolon/colon/dash/terminator precedes this token. */
  precededByBreak: boolean;
  /** True when a comma/semicolon/colon/dash/terminator follows this token. */
  followedByBreak: boolean;
  followedByTerminator: boolean;
  /** True when the raw chunk ends in a dash or ellipsis (cut off mid-word). */
  followedByInterruption: boolean;
  /** Estimated audio-clock interval for this token. */
  startMs: number;
  endMs: number;
  /** 0–1 confidence in the interval above, not in the word (§16.3.4). */
  timingConfidence: number;
}

/** Timing confidence when the provider gave us per-word intervals. */
const PROVIDED_TIMING_CONFIDENCE = 0.9;
/** Timing confidence for proportional placement inside a commit interval. */
const PROPORTIONAL_TIMING_CONFIDENCE = 0.5;

function stripEdgePunctuation(chunk: string): {
  core: string;
  leading: string;
  trailing: string;
} {
  let start = 0;
  let end = chunk.length;
  const isWordChar = (c: string): boolean => /[\p{L}\p{N}']/u.test(c);
  while (start < end && !isWordChar(chunk[start] as string)) start++;
  while (end > start && !isWordChar(chunk[end - 1] as string)) end--;
  return {
    core: chunk.slice(start, end),
    leading: chunk.slice(0, start),
    trailing: chunk.slice(end),
  };
}

function hasInterruption(punctuation: string): boolean {
  return INTERRUPTIONS.some((marker) => punctuation.includes(marker));
}

function hasBreak(punctuation: string): boolean {
  if (hasInterruption(punctuation)) return true;
  for (const char of punctuation) {
    if (CLAUSE_BREAKS.has(char) || TERMINATORS.has(char)) return true;
  }
  return false;
}

function hasTerminator(punctuation: string): boolean {
  for (const char of punctuation) {
    if (TERMINATORS.has(char)) return true;
  }
  return false;
}

/**
 * Tokenize an utterance, preserving repeats and punctuation context.
 *
 * Timings are proportional across `[audioStartMs, audioEndMs]` weighted by
 * token length, unless `wordTimings` are supplied positionally. Proportional
 * placement is honest about itself: it stamps
 * {@link PROPORTIONAL_TIMING_CONFIDENCE}, which is below the "safe to place a
 * gutter dot" bar in some configurations and is the input to §16.3.4's
 * unlocalized rule.
 */
export function tokenizeUtterance(
  text: string,
  options: {
    audioStartMs: number;
    audioEndMs: number;
    wordTimings?: readonly WordTiming[];
    /** True when the utterance begins a speaking turn (§15.3). */
    turnStart?: boolean;
  },
): UtteranceToken[] {
  const chunks = text.split(/\s+/).filter((chunk) => chunk.length > 0);
  const tokens: UtteranceToken[] = [];

  let sentenceIndex = 0;
  let pendingSentenceStart = options.turnStart !== false;
  let pendingBreak = false;

  for (const chunk of chunks) {
    const { core, leading, trailing } = stripEdgePunctuation(chunk);
    const normalizedChunk = normalizeText(core);
    const words = normalizedChunk.length === 0 ? [] : normalizedChunk.split(' ');

    if (words.length === 0) {
      // A standalone punctuation chunk ("—", "..."). It carries no lexical
      // content but it does mark a break for the tokens on either side.
      if (hasBreak(chunk)) pendingBreak = true;
      if (hasTerminator(chunk)) {
        sentenceIndex++;
        pendingSentenceStart = true;
      }
      const previous = tokens[tokens.length - 1];
      if (previous) {
        previous.followedByBreak = previous.followedByBreak || hasBreak(chunk);
        previous.followedByTerminator = previous.followedByTerminator || hasTerminator(chunk);
        previous.followedByInterruption =
          previous.followedByInterruption || hasInterruption(chunk);
      }
      continue;
    }

    for (let w = 0; w < words.length; w++) {
      const isFirst = w === 0;
      const isLast = w === words.length - 1;
      const leadPunct = isFirst ? leading : '';
      const trailPunct = isLast ? trailing : '';

      const token: UtteranceToken = {
        index: tokens.length,
        raw: chunk,
        normalized: words[w] as string,
        sentenceIndex,
        isSentenceStart: pendingSentenceStart && isFirst,
        precededByBreak: pendingBreak || hasBreak(leadPunct),
        followedByBreak: hasBreak(trailPunct),
        followedByTerminator: hasTerminator(trailPunct),
        followedByInterruption: hasInterruption(trailPunct),
        startMs: options.audioStartMs,
        endMs: options.audioEndMs,
        timingConfidence: PROPORTIONAL_TIMING_CONFIDENCE,
      };
      tokens.push(token);
      pendingSentenceStart = false;
      pendingBreak = false;

      if (isLast && hasTerminator(trailPunct)) {
        sentenceIndex++;
        pendingSentenceStart = true;
      }
      if (isLast && hasBreak(trailPunct) && !hasTerminator(trailPunct)) {
        pendingBreak = true;
      }
    }
  }

  assignTokenTimings(tokens, options);
  return tokens;
}

function assignTokenTimings(
  tokens: UtteranceToken[],
  options: { audioStartMs: number; audioEndMs: number; wordTimings?: readonly WordTiming[] },
): void {
  if (tokens.length === 0) return;

  const timings = options.wordTimings;
  if (timings && timings.length === tokens.length) {
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i] as UtteranceToken;
      const timing = timings[i] as WordTiming;
      token.startMs = timing.startMs;
      token.endMs = timing.endMs;
      token.timingConfidence = PROVIDED_TIMING_CONFIDENCE;
    }
    return;
  }

  const spanMs = Math.max(0, options.audioEndMs - options.audioStartMs);
  // Weight by characters + 1 so a one-letter token still occupies time.
  const weights = tokens.map((token) => token.normalized.length + 1);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let cursor = options.audioStartMs;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as UtteranceToken;
    const share = total === 0 ? 0 : (spanMs * (weights[i] as number)) / total;
    token.startMs = cursor;
    token.endMs = cursor + share;
    token.timingConfidence = PROPORTIONAL_TIMING_CONFIDENCE;
    cursor += share;
  }
  // Absorb float drift into the last token so the span is exactly covered.
  const last = tokens[tokens.length - 1] as UtteranceToken;
  last.endMs = options.audioEndMs;
}

/**
 * §16.4 / §15.3. Realtime transcripts frequently arrive with little or no
 * punctuation, which would make every sentence-opener test silently vacuous.
 * Speech-interval gaps are the acoustic equivalent of a full stop, so a token
 * whose estimated start follows a silence of at least `gapMs` is promoted to a
 * sentence start and marked as preceded by a break.
 *
 * `boundaryStartsMs` are the *start* times of speech runs; a token beginning
 * within tolerance of one is a token that began after a pause.
 */
export function applyPauseBoundaries(
  tokens: UtteranceToken[],
  boundaryStartsMs: readonly number[],
  toleranceMs = 150,
): void {
  if (boundaryStartsMs.length === 0) return;
  for (const token of tokens) {
    for (const boundaryMs of boundaryStartsMs) {
      if (Math.abs(token.startMs - boundaryMs) <= toleranceMs) {
        token.isSentenceStart = true;
        token.precededByBreak = true;
        break;
      }
    }
  }
  // Re-number sentences so opener statistics see the acoustic segmentation.
  let sentenceIndex = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as UtteranceToken;
    if (i > 0 && token.isSentenceStart) sentenceIndex++;
    token.sentenceIndex = sentenceIndex;
  }
}

/** Bounded excerpt around a token, for `CoachCandidate.spokenFragment`. */
export function excerptAround(
  tokens: readonly UtteranceToken[],
  index: number,
  radius = 6,
  maxChars = 120,
): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(tokens.length, index + radius + 1);
  const text = tokens
    .slice(start, end)
    .map((token) => token.normalized)
    .join(' ');
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}
