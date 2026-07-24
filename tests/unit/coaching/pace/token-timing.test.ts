/**
 * Token counting and timing (spec §14.1, §14.2, §14.3).
 *
 * The fixtures below use `speechWeight: 1` so that every expected timestamp is
 * arithmetic the reader can do in their head, independent of the syllable
 * heuristic. The syllable heuristic gets its own tests.
 */
import { describe, expect, it } from 'vitest';
import {
  countTokens,
  distributeTokenTimes,
  estimateSyllables,
  speechWeightOf,
  voicedOffsetToAudioTime,
  type SpokenSegment,
  type SpokenWord,
} from '../../../../src/shared/coaching/pace/token-timing';

function word(text: string, overrides: Partial<SpokenWord> = {}): SpokenWord {
  return {
    text,
    excluded: false,
    confirmedFiller: false,
    repetition: false,
    speechWeight: 1,
    ...overrides,
  };
}

function segment(words: SpokenWord[], overrides: Partial<SpokenSegment> = {}): SpokenSegment {
  return {
    segmentId: 'seg-1',
    words,
    audioStartMs: 0,
    audioEndMs: 4_000,
    final: true,
    commitSequence: 1,
    takePassId: 'pass-1',
    confidence: 0.95,
    ...overrides,
  };
}

describe('countTokens keeps the three rates of §14.1 distinct', () => {
  it('counts confirmed fillers and repetitions as audible but not as content', () => {
    const counts = countTokens([
      word('we'),
      word('um', { confirmedFiller: true }),
      word('ship'),
      word('ship', { repetition: true }),
      word('today'),
      word('cue', { excluded: true }),
    ]);
    // 5 spoken words reach the listener; only 3 of them carry the message;
    // the wake word reaches neither.
    expect(counts).toEqual({ audible: 5, content: 3, excluded: 1 });
  });

  it('does not collapse audible into content when a take is filler-free', () => {
    const counts = countTokens([word('a'), word('b'), word('c')]);
    expect(counts.audible).toBe(3);
    expect(counts.content).toBe(3);
  });
});

describe('distributeTokenTimes places tokens on voiced audio only (§14.3)', () => {
  it('never places a token inside a silence break', () => {
    // 4 equally weighted words, 2 000 ms of voiced audio split either side of a
    // 2 000 ms silence. Each word occupies 500 ms of *voiced* time:
    //   w0 → [   0,  500]  centre  250
    //   w1 → [ 500, 1000]  centre  750
    //   w2 → [3000, 3500]  centre 3250
    //   w3 → [3500, 4000]  centre 3750
    const tokens = distributeTokenTimes(segment([word('a'), word('b'), word('c'), word('d')]), [
      { startMs: 0, endMs: 1_000 },
      { startMs: 3_000, endMs: 4_000 },
    ]);

    expect(tokens.map((token) => token.centerMs)).toEqual([250, 750, 3_250, 3_750]);
    for (const token of tokens) {
      const insideGap = token.centerMs > 1_000 && token.centerMs < 3_000;
      expect(insideGap).toBe(false);
    }
  });

  it('lets excluded words consume time without being counted', () => {
    // The wake word was physically spoken, so dropping its time would shift
    // every following token 1 000 ms earlier. It must consume its slot and
    // then disappear.
    const tokens = distributeTokenTimes(
      segment([word('cue', { excluded: true }), word('let'), word('us')], {
        audioEndMs: 3_000,
      }),
      [{ startMs: 0, endMs: 3_000 }],
    );

    expect(tokens).toHaveLength(2);
    expect(tokens.map((token) => token.centerMs)).toEqual([1_500, 2_500]);
  });

  it('weights token spans by speech weight rather than spacing them evenly', () => {
    // Weights 1 and 3 over 4 000 ms of voiced audio: the first word owns
    // [0, 1000], the second [1000, 4000].
    const tokens = distributeTokenTimes(
      segment([word('go', { speechWeight: 1 }), word('everywhere', { speechWeight: 3 })]),
      [{ startMs: 0, endMs: 4_000 }],
    );
    expect(tokens[0]?.startMs).toBe(0);
    expect(tokens[0]?.endMs).toBe(1_000);
    expect(tokens[1]?.startMs).toBe(1_000);
    expect(tokens[1]?.endMs).toBe(4_000);
  });

  it('falls back to the segment interval with reduced timing confidence when the VAD has no span', () => {
    const withSpans = distributeTokenTimes(segment([word('a'), word('b')]), [
      { startMs: 0, endMs: 4_000 },
    ]);
    const withoutSpans = distributeTokenTimes(segment([word('a'), word('b')]), []);

    expect(withoutSpans.map((t) => t.centerMs)).toEqual(withSpans.map((t) => t.centerMs));
    expect(withoutSpans[0]?.timingConfidence).toBeLessThan(withSpans[0]?.timingConfidence ?? 0);
  });

  it('marks tokens from a provisional segment as non-final', () => {
    const tokens = distributeTokenTimes(segment([word('a')], { final: false }), [
      { startMs: 0, endMs: 1_000 },
    ]);
    expect(tokens[0]?.final).toBe(false);
  });

  it('returns nothing when the segment has no words or no time', () => {
    expect(distributeTokenTimes(segment([]), [{ startMs: 0, endMs: 1_000 }])).toEqual([]);
    expect(distributeTokenTimes(segment([word('a')], { audioStartMs: 5, audioEndMs: 5 }), [])).toEqual(
      [],
    );
  });
});

describe('voicedOffsetToAudioTime', () => {
  it('skips the silence between spans', () => {
    const spans = [
      { startMs: 0, endMs: 1_000 },
      { startMs: 5_000, endMs: 6_000 },
    ];
    expect(voicedOffsetToAudioTime(spans, 0)).toBe(0);
    expect(voicedOffsetToAudioTime(spans, 999)).toBe(999);
    // 1 001 ms of voiced time is 1 ms into the second span, not 1 001 ms of
    // wall time.
    expect(voicedOffsetToAudioTime(spans, 1_001)).toBe(5_001);
    // Past the end clamps to the end rather than running off into silence.
    expect(voicedOffsetToAudioTime(spans, 99_999)).toBe(6_000);
  });
});

describe('estimateSyllables', () => {
  it('counts vowel groups and drops a silent final e', () => {
    expect(estimateSyllables('the')).toBe(1);
    expect(estimateSyllables('shape')).toBe(1);
    expect(estimateSyllables('little')).toBe(2);
    expect(estimateSyllables('delivery')).toBe(4);
    expect(estimateSyllables('presentation')).toBe(4);
  });

  it('never returns zero, so a word can never take zero time', () => {
    expect(estimateSyllables('')).toBe(1);
    expect(estimateSyllables('psst')).toBe(1);
    expect(estimateSyllables('123')).toBe(1);
  });

  it('prefers an explicit speech weight over the heuristic', () => {
    expect(speechWeightOf({ ...word('delivery'), speechWeight: 9 })).toBe(9);
    expect(speechWeightOf({ ...word('delivery'), speechWeight: undefined })).toBe(4);
  });
});
