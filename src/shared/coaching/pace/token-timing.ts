/**
 * Token counting and token timing (spec §14.2, §14.3).
 *
 * Word timestamps are not assumed to exist. What we do have is an
 * application-owned audio interval per transcript segment and the local VAD's
 * voiced sub-intervals inside it, so token centers are distributed across the
 * *voiced* time proportionally to a speech-weight estimate, and never placed
 * inside a silence break (§14.3).
 *
 * The three rates of §14.1 are kept distinct on purpose:
 *
 * - **Audible** — every spoken lexical unit, *including* confirmed fillers and
 *   repetitions. "How fast is the listener being asked to keep up?"
 * - **Content** — meaningful delivered words only; fillers, repetitions and
 *   false starts removed. "How fast is the message actually arriving?"
 * - **Articulation** — audible words over *voiced* time, silence removed.
 *   "How fast are the words themselves being produced?"
 *
 * Collapsing them loses the question each one answers. The live rail shows
 * Audible (§14.1); the post-take report shows Audible and Articulation.
 */

/**
 * One spoken lexical unit as the coaching layer sees it. This is the analyzer
 * input shape, produced upstream from the transcript ledger plus disfluency
 * classification — deliberately *not* a rendered Markdown token (§14.2).
 */
export interface SpokenWord {
  /** Lexical form, already normalized upstream. Used only for weight estimation. */
  text: string;
  /**
   * §14.2 exclusions: wake word and voice commands, stage acknowledgements,
   * non-spoken headings and image descriptions, duplicate partial-transcript
   * revisions, and words rejected by VAD/speaker checks. Excluded words count
   * toward no rate at all.
   */
  excluded: boolean;
  /** A filler promoted to `confirmed` (§15). Counts as audible, not content. */
  confirmedFiller: boolean;
  /** A repetition or false start. Counts as audible, not content. */
  repetition: boolean;
  /**
   * Speech-weight estimate for timing distribution (§14.3). Defaults to a
   * syllable estimate when omitted.
   */
  speechWeight?: number;
  /** True when this word ends a sentence, from transcript punctuation or alignment. */
  endsSentence?: boolean;
  /** Script span this word aligned to, when known. */
  scriptSpanId?: string | null;
}

/**
 * A transcript segment with an application-owned audio interval (§5.4). One
 * Realtime commit, or one precision-transcription chunk.
 */
export interface SpokenSegment {
  segmentId: string;
  words: SpokenWord[];
  audioStartMs: number;
  audioEndMs: number;
  /**
   * False for a provisional tail. Candidates built only from provisional text
   * carry `finalEvidence: false` and may never become a visible tip.
   */
  final: boolean;
  commitSequence: number | null;
  takePassId: string;
  /** 0–1 transcript/alignment confidence for this segment. */
  confidence: number;
}

/** A word placed on the audio clock. */
export interface TimedToken {
  word: SpokenWord;
  segmentId: string;
  /** Estimated audio-clock center of the word, ms. */
  centerMs: number;
  /** Estimated start and end of the word's allotted span, ms. */
  startMs: number;
  endMs: number;
  /** 0–1 confidence in the *timing*, not in the transcription. */
  timingConfidence: number;
  final: boolean;
}

/** Counts for the three rates of §14.1. */
export interface TokenCounts {
  /** All spoken lexical units, including confirmed fillers and repetitions. */
  audible: number;
  /** Meaningful delivered words: audible minus confirmed fillers, repetitions. */
  content: number;
  /** Words dropped entirely by §14.2. */
  excluded: number;
}

export function countTokens(words: readonly SpokenWord[]): TokenCounts {
  let audible = 0;
  let content = 0;
  let excluded = 0;
  for (const word of words) {
    if (word.excluded) {
      excluded += 1;
      continue;
    }
    audible += 1;
    if (!word.confirmedFiller && !word.repetition) {
      content += 1;
    }
  }
  return { audible, content, excluded };
}

const VOWEL_GROUP = /[aeiouy]+/g;

/**
 * Syllable estimate used as the default speech weight (§14.3). A vowel-group
 * count with a silent-final-`e` correction: crude, English-centric, and good
 * enough, because §14.3 only requires timing "stable enough for rolling pace
 * and event placement", not phoneme accuracy. Callers with a better estimate
 * should set {@link SpokenWord.speechWeight} explicitly.
 */
export function estimateSyllables(text: string): number {
  const lower = text.toLowerCase().replace(/[^a-z]/g, '');
  if (lower.length === 0) {
    return 1;
  }
  const groups = lower.match(VOWEL_GROUP);
  let count = groups === null ? 0 : groups.length;
  if (count > 1 && lower.endsWith('e') && !lower.endsWith('le')) {
    count -= 1;
  }
  return Math.max(1, count);
}

export function speechWeightOf(word: SpokenWord): number {
  if (word.speechWeight !== undefined && word.speechWeight > 0) {
    return word.speechWeight;
  }
  return estimateSyllables(word.text);
}

export interface VoicedSpan {
  startMs: number;
  endMs: number;
}

/**
 * §14.3. Distribute token centers of `segment` across `voicedSpans`
 * proportionally to speech weight.
 *
 * Excluded words (§14.2) still consume weight — they were physically spoken,
 * so removing their time would shift every following token — but they are not
 * returned, because nothing downstream may count them.
 *
 * When no voiced span is known for the segment (VAD lagging, dropout) the
 * whole segment interval is used and `timingConfidence` drops, rather than
 * refusing to place tokens: pace with soft timing beats no pace at all, and
 * the confidence field is how that is declared.
 */
export function distributeTokenTimes(
  segment: SpokenSegment,
  voicedSpans: readonly VoicedSpan[],
): TimedToken[] {
  const spans = voicedSpans
    .filter((span) => span.endMs > span.startMs)
    .slice()
    .sort((a, b) => a.startMs - b.startMs);

  const usable =
    spans.length > 0
      ? spans
      : segment.audioEndMs > segment.audioStartMs
        ? [{ startMs: segment.audioStartMs, endMs: segment.audioEndMs }]
        : [];
  if (usable.length === 0 || segment.words.length === 0) {
    return [];
  }

  const timingConfidence = spans.length > 0 ? (segment.final ? 0.8 : 0.6) : 0.4;
  const totalVoicedMs = usable.reduce((sum, span) => sum + (span.endMs - span.startMs), 0);
  const weights = segment.words.map((word) => speechWeightOf(word));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= 0 || totalVoicedMs <= 0) {
    return [];
  }

  const tokens: TimedToken[] = [];
  let cumulativeWeight = 0;
  for (let index = 0; index < segment.words.length; index += 1) {
    const word = segment.words[index];
    const weight = weights[index];
    if (word === undefined || weight === undefined) {
      continue;
    }
    const startOffsetMs = (cumulativeWeight / totalWeight) * totalVoicedMs;
    cumulativeWeight += weight;
    const endOffsetMs = (cumulativeWeight / totalWeight) * totalVoicedMs;
    if (word.excluded) {
      continue;
    }
    tokens.push({
      word,
      segmentId: segment.segmentId,
      startMs: voicedOffsetToAudioTime(usable, startOffsetMs),
      endMs: voicedOffsetToAudioTime(usable, endOffsetMs),
      centerMs: voicedOffsetToAudioTime(usable, (startOffsetMs + endOffsetMs) / 2),
      timingConfidence,
      final: segment.final,
    });
  }
  return tokens;
}

/**
 * Map an offset measured in *concatenated voiced time* back onto the audio
 * clock, skipping the silence between spans. This is what keeps §14.3's "if a
 * silence break exists, do not place tokens inside it" true.
 */
export function voicedOffsetToAudioTime(
  spans: readonly VoicedSpan[],
  offsetMs: number,
): number {
  let remaining = Math.max(0, offsetMs);
  for (const span of spans) {
    const spanMs = span.endMs - span.startMs;
    if (remaining <= spanMs) {
      return span.startMs + remaining;
    }
    remaining -= spanMs;
  }
  const last = spans[spans.length - 1];
  return last === undefined ? 0 : last.endMs;
}
