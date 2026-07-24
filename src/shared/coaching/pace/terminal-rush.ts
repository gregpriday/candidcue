/**
 * Terminal-rush detection (spec §14.9).
 *
 * "For a sufficiently long sentence, compare delivery rate over the final
 * 25–35% against the earlier portion." The interesting engineering is not the
 * ratio — it is deciding when the ratio is *measurable at all*. A three-word
 * sentence, a provisional transcript tail, or a sentence straddling a dropout
 * all produce a number, and all of those numbers are noise. Everything that
 * fails a gate here returns `measurable: false` with a reason rather than a
 * ratio, so nothing downstream can accidentally consume a fabricated value.
 */
import type { CoachCandidate } from '../../contracts/coaching';
import { createEvidenceStamp, type CoachClockContext } from './speech-clock';
import type { TimedToken } from './token-timing';

export interface TerminalRushOptions {
  /** §14.9: "sentence contains at least eight spoken words". */
  minimumSentenceWords: number;
  /** §14.9: the final 25–35% of the sentence. */
  finalFraction: number;
  /** Each of the two groups must contain at least this many words. */
  minimumGroupWords: number;
  /** §14.9: "ratio exceeds approximately 1.25". */
  ratioThreshold: number;
  /** §14.9: "in at least two of the last three eligible sentences". */
  patternWindowSentences: number;
  patternRequiredSentences: number;
  /** §14.9: "transcript/alignment confidence is high". */
  minimumSegmentConfidence: number;
}

export const DEFAULT_TERMINAL_RUSH_OPTIONS: TerminalRushOptions = {
  minimumSentenceWords: 8,
  finalFraction: 0.3,
  minimumGroupWords: 2,
  ratioThreshold: 1.25,
  patternWindowSentences: 3,
  patternRequiredSentences: 2,
  minimumSegmentConfidence: 0.7,
};

export type TerminalRushUnmeasurableReason =
  | 'too_few_words'
  | 'group_too_small'
  | 'zero_duration'
  | 'provisional_evidence'
  | 'low_confidence';

export type TerminalRushMeasurement =
  | {
      measurable: false;
      reason: TerminalRushUnmeasurableReason;
      ratio: null;
      startMs: number;
      endMs: number;
      wordCount: number;
    }
  | {
      measurable: true;
      reason: 'ok';
      /** `finalSegmentWpm / earlierSegmentWpm` (§14.9). */
      ratio: number;
      earlierWpm: number;
      finalWpm: number;
      splitMs: number;
      startMs: number;
      endMs: number;
      wordCount: number;
    };

/** A completed sentence handed to the analyzer. */
export interface SentenceTiming {
  tokens: TimedToken[];
  /** 0–1 transcript/alignment confidence for the sentence. */
  confidence: number;
  /** False when any part of the sentence rests on a provisional transcript tail. */
  final: boolean;
  scriptSpanId: string | null;
}

/**
 * §14.9. Measure one sentence.
 *
 * `deliveryMsIn` — when supplied — removes unmeasured audio (dropout, command,
 * manual pause) from each group's denominator. Without it a 2-second dropout
 * inside the earlier portion reads as slow earlier delivery and manufactures a
 * terminal rush that never happened.
 */
export function measureTerminalRush(
  sentence: SentenceTiming,
  options: Partial<TerminalRushOptions> = {},
  deliveryMsIn?: (startMs: number, endMs: number) => number,
): TerminalRushMeasurement {
  const config = { ...DEFAULT_TERMINAL_RUSH_OPTIONS, ...options };
  const tokens = sentence.tokens;
  const count = tokens.length;
  const startMs = tokens[0]?.startMs ?? 0;
  const endMs = tokens[count - 1]?.endMs ?? startMs;
  const base = { ratio: null, startMs, endMs, wordCount: count } as const;

  if (count < config.minimumSentenceWords) {
    return { measurable: false, reason: 'too_few_words', ...base };
  }
  if (!sentence.final) {
    return { measurable: false, reason: 'provisional_evidence', ...base };
  }
  if (sentence.confidence < config.minimumSegmentConfidence) {
    return { measurable: false, reason: 'low_confidence', ...base };
  }

  const finalCount = Math.max(
    config.minimumGroupWords,
    Math.round(config.finalFraction * count),
  );
  const earlierCount = count - finalCount;
  if (earlierCount < config.minimumGroupWords || finalCount < config.minimumGroupWords) {
    return { measurable: false, reason: 'group_too_small', ...base };
  }

  const lastEarlier = tokens[earlierCount - 1];
  const firstFinal = tokens[earlierCount];
  if (lastEarlier === undefined || firstFinal === undefined) {
    return { measurable: false, reason: 'group_too_small', ...base };
  }
  const splitMs = (lastEarlier.endMs + firstFinal.startMs) / 2;

  const measure = deliveryMsIn ?? ((a: number, b: number) => b - a);
  const earlierMs = measure(startMs, splitMs);
  const finalMs = measure(splitMs, endMs);
  if (earlierMs <= 0 || finalMs <= 0) {
    return { measurable: false, reason: 'zero_duration', ...base };
  }

  const earlierWpm = (earlierCount / earlierMs) * 60_000;
  const finalWpm = (finalCount / finalMs) * 60_000;
  return {
    measurable: true,
    reason: 'ok',
    ratio: finalWpm / earlierWpm,
    earlierWpm,
    finalWpm,
    splitMs,
    startMs,
    endMs,
    wordCount: count,
  };
}

/**
 * Tracks the §14.9 "two of the last three eligible sentences" pattern and
 * emits `terminal_rush` candidates.
 */
export class TerminalRushAnalyzer {
  private readonly options: TerminalRushOptions;
  private readonly recent: TerminalRushMeasurement[] = [];
  private latestRatio: number | null = null;
  private candidateSequence = 0;
  private lastCandidateEndMs: number | null = null;

  constructor(options: Partial<TerminalRushOptions> = {}) {
    this.options = { ...DEFAULT_TERMINAL_RUSH_OPTIONS, ...options };
  }

  /** §22 metrics: ratio of the most recent *eligible* sentence, or `null`. */
  terminalRushRatio(): number | null {
    return this.latestRatio;
  }

  reset(): void {
    this.recent.length = 0;
    this.latestRatio = null;
    this.lastCandidateEndMs = null;
  }

  /**
   * Fold a completed sentence in. Returns a candidate when the pattern gate
   * fires, otherwise `null` — which is the normal answer (§2.6).
   */
  noteSentence(
    sentence: SentenceTiming,
    context: CoachClockContext,
    deliveryMsIn?: (startMs: number, endMs: number) => number,
  ): CoachCandidate | null {
    const measurement = measureTerminalRush(sentence, this.options, deliveryMsIn);
    if (!measurement.measurable) {
      return null;
    }

    this.latestRatio = measurement.ratio;
    this.recent.push(measurement);
    while (this.recent.length > this.options.patternWindowSentences) {
      this.recent.shift();
    }

    const rushed = this.recent.filter(
      (entry) => entry.measurable && entry.ratio > this.options.ratioThreshold,
    );
    if (rushed.length < this.options.patternRequiredSentences) {
      return null;
    }
    if (this.lastCandidateEndMs !== null && measurement.endMs <= this.lastCandidateEndMs) {
      return null;
    }
    this.lastCandidateEndMs = measurement.endMs;

    const first = rushed[0];
    const startMs = first?.startMs ?? measurement.startMs;
    this.candidateSequence += 1;
    // Confidence rises with how far past 1.25 the ratio sits and with how much
    // of the window rushed; it is capped below 1 because a local acoustic
    // measurement is never certain about intent.
    const excess = Math.min(1, (measurement.ratio - this.options.ratioThreshold) / 0.5);
    const coverage = rushed.length / this.options.patternWindowSentences;
    return {
      evidenceId: `terminal_rush:${context.takePassId}:${this.candidateSequence}`,
      type: 'terminal_rush',
      localConfidence: clamp01(0.5 + 0.3 * excess + 0.2 * coverage) * sentence.confidence,
      stamp: createEvidenceStamp(startMs, measurement.endMs, context),
      scriptSpanId: sentence.scriptSpanId,
      scriptAnchorTokenId: null,
      contributingEventIds: [],
      detailCode: `ratio_${measurement.ratio.toFixed(2)}`,
      spokenFragment: '',
      authoredFragment: '',
      finalEvidence: sentence.final,
    };
  }
}

/**
 * Group timed tokens into sentences on {@link TimedToken.word.endsSentence}.
 * Any trailing tokens without a terminator are returned as `pending`, because
 * a sentence that has not ended cannot have a "final 30%".
 */
export function groupIntoSentences(tokens: readonly TimedToken[]): {
  sentences: TimedToken[][];
  pending: TimedToken[];
} {
  const sentences: TimedToken[][] = [];
  let current: TimedToken[] = [];
  for (const token of tokens) {
    current.push(token);
    if (token.word.endsSentence === true) {
      sentences.push(current);
      current = [];
    }
  }
  return { sentences, pending: current };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
