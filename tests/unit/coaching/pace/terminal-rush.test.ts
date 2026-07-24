/**
 * Terminal rush (spec §14.9).
 *
 * The fixture sentence is built so the ratio is exactly 1.5: seven words over
 * 3 500 ms is exactly 120 WPM, three words over 1 000 ms is exactly 180 WPM.
 * Both halves are arithmetic done outside the implementation.
 */
import { describe, expect, it } from 'vitest';
import {
  groupIntoSentences,
  measureTerminalRush,
  TerminalRushAnalyzer,
  type SentenceTiming,
} from '../../../../src/shared/coaching/pace/terminal-rush';
import type { TimedToken } from '../../../../src/shared/coaching/pace/token-timing';
import type { CoachClockContext } from '../../../../src/shared/coaching/pace/speech-clock';

function token(startMs: number, endMs: number, endsSentence = false): TimedToken {
  return {
    word: {
      text: 'w',
      excluded: false,
      confirmedFiller: false,
      repetition: false,
      endsSentence,
    },
    segmentId: 'seg-1',
    startMs,
    endMs,
    centerMs: (startMs + endMs) / 2,
    timingConfidence: 0.9,
    final: true,
  };
}

/**
 * `earlierCount` words evenly filling [0, earlierMs] and `finalCount` words
 * evenly filling [earlierMs, earlierMs + finalMs].
 */
function sentence(
  earlierCount: number,
  earlierMs: number,
  finalCount: number,
  finalMs: number,
  overrides: Partial<SentenceTiming> = {},
): SentenceTiming {
  const tokens: TimedToken[] = [];
  const earlierStep = earlierMs / earlierCount;
  for (let i = 0; i < earlierCount; i += 1) {
    tokens.push(token(i * earlierStep, (i + 1) * earlierStep));
  }
  const finalStep = finalMs / finalCount;
  for (let i = 0; i < finalCount; i += 1) {
    tokens.push(
      token(earlierMs + i * finalStep, earlierMs + (i + 1) * finalStep, i === finalCount - 1),
    );
  }
  return { tokens, confidence: 0.95, final: true, scriptSpanId: 'span-1', ...overrides };
}

const CONTEXT: CoachClockContext = {
  audioTimeMs: 10_000,
  trackingEpoch: 3,
  takePassId: 'pass-1',
  commitSequence: 12,
};

describe('measureTerminalRush', () => {
  it('reads exactly 1.5 for 120 WPM followed by 180 WPM', () => {
    const measurement = measureTerminalRush(sentence(7, 3_500, 3, 1_000));
    expect(measurement.measurable).toBe(true);
    if (!measurement.measurable) {
      return;
    }
    expect(measurement.earlierWpm).toBeCloseTo(120, 9);
    expect(measurement.finalWpm).toBeCloseTo(180, 9);
    expect(measurement.ratio).toBeCloseTo(1.5, 9);
    expect(measurement.splitMs).toBeCloseTo(3_500, 9);
  });

  it('reads exactly 1.0 for an evenly delivered sentence', () => {
    // 10 words, 500 ms each. The 7/3 split is 3 500 ms and 1 500 ms, both
    // 120 WPM.
    const measurement = measureTerminalRush(sentence(7, 3_500, 3, 1_500));
    expect(measurement.measurable).toBe(true);
    if (!measurement.measurable) {
      return;
    }
    expect(measurement.ratio).toBeCloseTo(1, 9);
  });

  it('refuses to measure a sentence shorter than eight words', () => {
    const measurement = measureTerminalRush(sentence(5, 2_500, 2, 500));
    expect(measurement.measurable).toBe(false);
    expect(measurement.reason).toBe('too_few_words');
    expect(measurement.ratio).toBeNull();
  });

  it('refuses to measure a provisional sentence', () => {
    const measurement = measureTerminalRush(sentence(7, 3_500, 3, 1_000, { final: false }));
    expect(measurement.measurable).toBe(false);
    expect(measurement.reason).toBe('provisional_evidence');
  });

  it('refuses to measure when transcript confidence is low', () => {
    const measurement = measureTerminalRush(sentence(7, 3_500, 3, 1_000, { confidence: 0.4 }));
    expect(measurement.measurable).toBe(false);
    expect(measurement.reason).toBe('low_confidence');
  });

  it('does not manufacture a rush out of unmeasured audio in the earlier portion', () => {
    // The presenter delivered the first seven words in 2 500 ms of real audio
    // with a 1 000 ms dropout in the middle — 168 WPM, not 120. Charging that
    // dropout to the earlier portion would report ratio 1.5 and coach a rush
    // that never happened.
    const naive = measureTerminalRush(sentence(7, 3_500, 3, 1_000));
    const corrected = measureTerminalRush(sentence(7, 3_500, 3, 1_000), {}, (a, b) => {
      const dropoutLo = Math.max(a, 1_000);
      const dropoutHi = Math.min(b, 2_000);
      return b - a - Math.max(0, dropoutHi - dropoutLo);
    });

    expect(naive.measurable && naive.ratio).toBeCloseTo(1.5, 9);
    expect(corrected.measurable).toBe(true);
    if (!corrected.measurable) {
      return;
    }
    expect(corrected.earlierWpm).toBeCloseTo(168, 9);
    expect(corrected.ratio).toBeCloseTo(180 / 168, 9);
    expect(corrected.ratio).toBeLessThan(1.25);
  });
});

describe('TerminalRushAnalyzer pattern gate (§14.9)', () => {
  it('needs two rushed sentences out of the last three before proposing anything', () => {
    const analyzer = new TerminalRushAnalyzer();
    expect(analyzer.noteSentence(sentence(7, 3_500, 3, 1_000), CONTEXT)).toBeNull();

    const candidate = analyzer.noteSentence(sentence(7, 3_500, 3, 1_000), CONTEXT);
    expect(candidate).not.toBeNull();
    expect(candidate?.type).toBe('terminal_rush');
    expect(candidate?.finalEvidence).toBe(true);
    expect(candidate?.stamp.trackingEpoch).toBe(3);
    expect(candidate?.stamp.takePassId).toBe('pass-1');
    expect(candidate?.detailCode).toBe('ratio_1.50');
  });

  it('never proposes anything for evenly delivered sentences', () => {
    const analyzer = new TerminalRushAnalyzer();
    for (let i = 0; i < 5; i += 1) {
      expect(analyzer.noteSentence(sentence(7, 3_500, 3, 1_500), CONTEXT)).toBeNull();
    }
    expect(analyzer.terminalRushRatio()).toBeCloseTo(1, 9);
  });

  it('lets the pattern lapse when rushed sentences fall out of the window', () => {
    const analyzer = new TerminalRushAnalyzer();
    // One rush, then three clean sentences push it out of the 3-sentence window.
    expect(analyzer.noteSentence(sentence(7, 3_500, 3, 1_000), CONTEXT)).toBeNull();
    for (let i = 0; i < 3; i += 1) {
      expect(analyzer.noteSentence(sentence(7, 3_500, 3, 1_500), CONTEXT)).toBeNull();
    }
    // A second rush now stands alone and must not fire.
    expect(analyzer.noteSentence(sentence(7, 3_500, 3, 1_000), CONTEXT)).toBeNull();
  });

  it('does not count an unmeasurable sentence toward the pattern', () => {
    const analyzer = new TerminalRushAnalyzer();
    analyzer.noteSentence(sentence(7, 3_500, 3, 1_000), CONTEXT);
    // A provisional rush is not evidence.
    expect(
      analyzer.noteSentence(sentence(7, 3_500, 3, 1_000, { final: false }), CONTEXT),
    ).toBeNull();
    expect(analyzer.terminalRushRatio()).toBeCloseTo(1.5, 9);
  });

  it('reports no ratio at all before any measurable sentence', () => {
    const analyzer = new TerminalRushAnalyzer();
    expect(analyzer.terminalRushRatio()).toBeNull();
    analyzer.noteSentence(sentence(5, 2_500, 2, 500), CONTEXT);
    expect(analyzer.terminalRushRatio()).toBeNull();
  });
});

describe('groupIntoSentences', () => {
  it('splits on the sentence terminator and keeps an unterminated tail pending', () => {
    const tokens = [
      token(0, 100, false),
      token(100, 200, true),
      token(200, 300, false),
      token(300, 400, true),
      token(400, 500, false),
    ];
    const grouped = groupIntoSentences(tokens);
    expect(grouped.sentences.map((s) => s.length)).toEqual([2, 2]);
    expect(grouped.pending).toHaveLength(1);
  });
});
