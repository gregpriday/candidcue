import { describe, expect, it } from 'vitest';
import { DEFAULT_TRACKING_PROFILE } from '../../../src/shared/tracking/profile';
import { alignSequences } from '../../../src/shared/tracking/sequence';
import type { LedgerToken, SpokenToken } from '../../../src/shared/tracking/types';
import { STOPWORDS } from '../../../src/shared/tracking/normalize';
import { mulberry32, randomInt, randomWord } from '../helpers/rand';

const profile = DEFAULT_TRACKING_PROFILE;

function scriptTokens(words: readonly string[]): SpokenToken[] {
  return words.map((word, index) => ({
    index,
    blockId: 'b0',
    sentenceId: 's0',
    surface: word,
    normalized: word,
    aliases: [],
    weight: STOPWORDS.has(word) ? 0.35 : 1,
    source: { utf16Start: 0, utf16End: 0 },
    flags: STOPWORDS.has(word) ? 2 : 0,
  }));
}

function transcriptTokens(words: readonly string[]): LedgerToken[] {
  return words.map((word, index) => ({
    itemId: 'item',
    indexInItem: index,
    surface: word,
    normalized: word,
    final: true,
    filler: ['um', 'uh'].includes(word),
    content: !['um', 'uh'].includes(word) && !STOPWORDS.has(word),
  }));
}

describe('alignSequences (§31.5)', () => {
  it('finds a verbatim run with high normalized score', () => {
    const script = scriptTokens('the quick brown fox jumps over the lazy dog'.split(' '));
    const tail = transcriptTokens('quick brown fox jumps'.split(' '));
    const result = alignSequences(tail, script, profile);
    expect(result.scriptStartOffset).toBe(1);
    expect(result.scriptEndOffset).toBe(4);
    expect(result.normalizedScore).toBeGreaterThan(0.9);
    expect(result.longestOrderedRun).toBe(4);
    expect(result.contentMatches).toBe(4);
  });

  it('tolerates filler insertions cheaply (§30.6)', () => {
    const script = scriptTokens('welcome to the channel everyone'.split(' '));
    const clean = alignSequences(
      transcriptTokens('welcome to the channel'.split(' ')),
      script,
      profile,
    );
    const withFillers = alignSequences(
      transcriptTokens('welcome um to the uh channel'.split(' ')),
      script,
      profile,
    );
    expect(withFillers.normalizedScore).toBeGreaterThan(clean.normalizedScore - 0.1);
  });

  it('penalizes script gaps but still matches across an omission', () => {
    const script = scriptTokens('alpha bravo charlie delta echo foxtrot'.split(' '));
    const tail = transcriptTokens('alpha bravo echo foxtrot'.split(' '));
    const result = alignSequences(tail, script, profile);
    expect(result.scriptEndOffset).toBe(5);
    expect(result.contentMatches).toBe(4);
  });

  it('preserves order: reversed input cannot produce a full ordered run', () => {
    const script = scriptTokens('one two three four five'.split(' '));
    const result = alignSequences(
      transcriptTokens('five four three two one'.split(' ')),
      script,
      profile,
    );
    expect(result.longestOrderedRun).toBeLessThanOrEqual(1);
  });

  it('returns empty result for empty inputs', () => {
    expect(alignSequences([], scriptTokens(['a']), profile).matchedPairs).toEqual([]);
    expect(alignSequences(transcriptTokens(['a']), [], profile).matchedPairs).toEqual([]);
  });

  it('never indexes outside token arrays on fuzzed input (§55.3 property)', () => {
    const rand = mulberry32(4242);
    const vocabulary = Array.from({ length: 30 }, () => randomWord(rand, 2, 9));
    for (let trial = 0; trial < 200; trial++) {
      const scriptWords = Array.from(
        { length: randomInt(rand, 1, 60) },
        () => vocabulary[randomInt(rand, 0, vocabulary.length - 1)] ?? 'x',
      );
      const tailWords = Array.from(
        { length: randomInt(rand, 1, 30) },
        () => vocabulary[randomInt(rand, 0, vocabulary.length - 1)] ?? 'y',
      );
      const script = scriptTokens(scriptWords);
      const tail = transcriptTokens(tailWords);
      const result = alignSequences(tail, script, profile);
      expect(Number.isFinite(result.score)).toBe(true);
      expect(result.normalizedScore).toBeGreaterThanOrEqual(0);
      expect(result.normalizedScore).toBeLessThanOrEqual(1);
      expect(result.scriptStartOffset).toBeGreaterThanOrEqual(0);
      expect(result.scriptEndOffset).toBeLessThan(script.length);
      expect(result.scriptStartOffset).toBeLessThanOrEqual(result.scriptEndOffset);
      for (const pair of result.matchedPairs) {
        expect(pair.transcriptIndex).toBeGreaterThanOrEqual(0);
        expect(pair.transcriptIndex).toBeLessThan(tail.length);
        expect(pair.scriptTokenIndex).toBeGreaterThanOrEqual(0);
        expect(pair.scriptTokenIndex).toBeLessThan(script.length);
      }
    }
  });
});
