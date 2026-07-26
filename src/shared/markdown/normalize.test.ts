import { describe, expect, it } from 'vitest';
import {
  normalizePhrase,
  normalizeToken,
  numberToWords,
  standardizeText,
} from './normalize';
import { tokenizeText } from './tokenize';

describe('standardizeText', () => {
  it('standardizes smart quotes and dashes', () => {
    expect(standardizeText('“Hello” — it’s fine')).toBe('"Hello" - it\'s fine');
  });

  it('applies NFKC', () => {
    expect(standardizeText('ﬁne')).toBe('fine');
  });
});

describe('normalizeToken', () => {
  it('lowercases and strips outer punctuation', () => {
    expect(normalizeToken('Hello,')).toBe('hello');
    expect(normalizeToken('(world)')).toBe('world');
  });

  it('keeps contractions intact', () => {
    expect(normalizeToken("Don’t")).toBe("don't");
  });

  it('keeps hyphens in compounds', () => {
    expect(normalizeToken('forty-two')).toBe('forty-two');
  });

  it('preserves decimal points but strips acronym dots', () => {
    expect(normalizeToken('3.14')).toBe('3.14');
    expect(normalizeToken('U.S.A.')).toBe('usa');
  });

  it('drops thousands separators', () => {
    expect(normalizeToken('1,250')).toBe('1250');
  });
});

describe('numberToWords', () => {
  it('handles teens, tens, hundreds, thousands', () => {
    expect(numberToWords(0)).toBe('zero');
    expect(numberToWords(17)).toBe('seventeen');
    expect(numberToWords(42)).toBe('forty two');
    expect(numberToWords(105)).toBe('one hundred five');
    expect(numberToWords(1250)).toBe('one thousand two hundred fifty');
    expect(numberToWords(2_000_000)).toBe('two million');
  });
});

describe('normalizePhrase', () => {
  it('normalizes a full phrase', () => {
    expect(normalizePhrase('  The Quick—Brown FOX! ')).toBe('the quick-brown fox');
  });
});

describe('tokenizeText', () => {
  it('extracts words with offsets', () => {
    const tokens = tokenizeText('Hello, brave new world.');
    expect(tokens.map((t) => t.surface)).toEqual(['Hello', 'brave', 'new', 'world']);
    expect(tokens[0]).toMatchObject({ start: 0, end: 5 });
    expect(tokens[3]).toMatchObject({ start: 17, end: 22 });
  });

  it('keeps numbers, contractions, and compounds whole', () => {
    const tokens = tokenizeText("It's 3.14 or 1,250 for real-time use");
    expect(tokens.map((t) => t.surface)).toEqual([
      "It's",
      '3.14',
      'or',
      '1,250',
      'for',
      'real-time',
      'use',
    ]);
  });

  it('never emits pure punctuation', () => {
    expect(tokenizeText('... --- !!!')).toEqual([]);
  });

  /**
   * The invariant `normalize.ts` relies on. Asserted here so that if the
   * pattern ever gains a dot-final alternative, the abbreviation dictionary's
   * dead entries come back to life with a test to notice.
   */
  it('never emits a surface ending in a dot', () => {
    const text = 'Dr. Mr. U.S.A. e.g. approx. 3.14 42% ends here. No. 5 or 1,250 lb.';
    const surfaces = tokenizeText(text).map((t) => t.surface);
    expect(surfaces.length).toBeGreaterThan(8);
    for (const surface of surfaces) {
      expect(surface.endsWith('.'), surface).toBe(false);
    }
  });
});

