import { describe, expect, it } from 'vitest';
import {
  classifyFillers,
  contractionEquivalent,
  editDistance,
  lexicallySimilar,
  normalizeText,
  numberEquivalent,
  parseNumberRun,
  phoneticallySimilar,
  tokenNumberValue,
  tokenizeNormalized,
} from '../../../src/shared/tracking/normalize';
import { mulberry32, randomNoisyText } from '../helpers/rand';

describe('normalizeText', () => {
  it('lowercases, strips punctuation, and collapses whitespace', () => {
    expect(normalizeText('Hello,   World!')).toBe('hello world');
    expect(normalizeText('“Smart” quotes—and dashes')).toBe('smart quotes and dashes');
    expect(normalizeText('50% & more')).toBe('50 percent and more');
  });

  it('keeps contractions but strips stray apostrophes', () => {
    expect(normalizeText("Don't stop")).toBe("don't stop");
    expect(normalizeText("'quoted'")).toBe('quoted');
  });

  it('is idempotent on arbitrary noisy input (§55.3 property)', () => {
    const rand = mulberry32(1234);
    for (let i = 0; i < 300; i++) {
      const input = randomNoisyText(rand, 8);
      const once = normalizeText(input);
      expect(normalizeText(once)).toBe(once);
    }
  });

  it('tokenizes deterministically', () => {
    expect(tokenizeNormalized('Forty-two things!')).toEqual(['forty', 'two', 'things']);
    expect(tokenizeNormalized('   ')).toEqual([]);
  });
});

describe('fillers (§30.6)', () => {
  it('flags single-token and phrase fillers', () => {
    const tokens = ['um', 'this', 'is', 'you', 'know', 'fine'];
    const flags = classifyFillers(tokens, false);
    expect(flags).toEqual([true, false, false, true, true, false]);
  });

  it('treats "so"/"like" as filler only at a turn start', () => {
    expect(classifyFillers(['so', 'anyway'], true)[0]).toBe(true);
    expect(classifyFillers(['i', 'like', 'dogs'], true)[1]).toBe(false);
  });
});

describe('number equivalence (§31.4)', () => {
  it('maps digits, words, and ordinals', () => {
    expect(tokenNumberValue('42')).toBe(42);
    expect(tokenNumberValue('seven')).toBe(7);
    expect(tokenNumberValue('2nd')).toBe(2);
    expect(tokenNumberValue('twelfth')).toBe(12);
    expect(numberEquivalent('two', '2')).toBe(true);
    expect(numberEquivalent('three', '4')).toBe(false);
  });

  it('parses spelled number runs', () => {
    expect(parseNumberRun(['forty', 'two'], 0)).toEqual({ value: 42, length: 2 });
    expect(parseNumberRun(['one', 'hundred', 'and', 'five'], 0)).toEqual({ value: 105, length: 4 });
    expect(parseNumberRun(['banana'], 0)).toBeUndefined();
  });
});

describe('contraction and similarity (§31.4)', () => {
  it('matches contraction equivalents', () => {
    expect(contractionEquivalent("don't", 'dont')).toBe(true);
    expect(contractionEquivalent("it's", 'it is')).toBe(true);
    expect(contractionEquivalent('cat', 'dog')).toBe(false);
  });

  it('edit distance is bounded and symmetric-ish', () => {
    expect(editDistance('kitten', 'sitting', 3)).toBe(3);
    expect(editDistance('abc', 'zzzzzzzz', 2)).toBeGreaterThan(2);
  });

  it('lexical similarity requires sufficiently long tokens', () => {
    expect(lexicallySimilar('cat', 'car')).toBe(false); // too short (§31.4)
    expect(lexicallySimilar('principle', 'principal')).toBe(true);
  });

  it('phonetic similarity rescues near-homophones', () => {
    expect(phoneticallySimilar('kaleidoscope', 'kalidoscope')).toBe(true);
    expect(phoneticallySimilar('metronome', 'metranome')).toBe(true);
    expect(phoneticallySimilar('dog', 'teleprompter')).toBe(false);
  });
});
