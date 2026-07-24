import { describe, expect, it } from 'vitest';
import {
  aliasesForToken,
  normalizePhrase,
  normalizeToken,
  numberToWords,
  standardizeText,
} from './normalize';
import { tokenizeText } from './tokenize';
import { phoneticKey } from './phonetic';

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

describe('aliasesForToken', () => {
  it('splits contractions', () => {
    const aliases = aliasesForToken("don't", "don't");
    expect(aliases).toContain('dont');
    expect(aliases).toContain('do not');
  });

  it('generates number word forms', () => {
    const aliases = aliasesForToken('42', '42');
    expect(aliases).toContain('forty two');
    expect(aliases).toContain('forty-two');
  });

  it('speaks decimals digit by digit', () => {
    expect(aliasesForToken('3.14', '3.14')).toContain('three point one four');
  });

  it('expands percent', () => {
    expect(aliasesForToken('42%', '42%')).toContain('forty two percent');
  });

  it('expands ampersand to and', () => {
    expect(aliasesForToken('&', '&')).toContain('and');
  });

  it('splits and joins hyphenated compounds', () => {
    const aliases = aliasesForToken('real-time', 'real-time');
    expect(aliases).toContain('realtime');
    expect(aliases).toContain('real time');
  });

  /**
   * The abbreviation dictionary, tested against surfaces the tokenizer can
   * actually produce.
   *
   * This block used to read `aliasesForToken('Dr.', 'dr')` and assert
   * `'doctor'`, which passed — and meant nothing. `tokenizeText` never emits a
   * surface ending in a dot, so the compiler's only call site passes `'Dr'`,
   * and the branch under test could not run in production. Every assertion
   * here now starts from real tokenizer output.
   */
  const firstSurface = (text: string): string => tokenizeText(text)[0]?.surface ?? '';

  it('expands an interior-dot abbreviation, which is what survives tokenization', () => {
    expect(firstSurface('e.g. the appendix')).toBe('e.g');
    expect(aliasesForToken('e.g', normalizeToken('e.g.'))).toContain('for example');
    expect(firstSurface('i.e. the point')).toBe('i.e');
    expect(aliasesForToken('i.e', normalizeToken('i.e.'))).toContain('that is');
  });

  it('cannot reach an honorific, because the tokenizer took its dot', () => {
    // Pinned as the documented gap it is, not as desirable behaviour: closing
    // it means widening `SpokenToken.surface` (see tokenize.ts).
    expect(firstSurface('Dr. Halvorsen arrived')).toBe('Dr');
    expect(aliasesForToken('Dr', 'dr')).toEqual([]);
    expect(firstSurface('Mr. Halvorsen arrived')).toBe('Mr');
    expect(aliasesForToken('Mr', 'mr')).toEqual([]);
  });

  it('does not expand bare common words as abbreviations', () => {
    // The dot is the entire disambiguator between "no" and "No.", and between
    // "min" and "min." — so a dotless surface must expand to nothing even
    // though the dictionary has the key.
    expect(aliasesForToken('no', 'no')).not.toContain('number');
    expect(aliasesForToken('min', 'min')).toEqual([]);
    expect(aliasesForToken('sun', 'sun')).toEqual([]);
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

describe('phoneticKey', () => {
  it('merges common confusions', () => {
    expect(phoneticKey('phone')).toBe(phoneticKey('fone'));
    expect(phoneticKey('cat')).toBe(phoneticKey('kat'));
  });

  it('returns empty for non-alphabetic tokens', () => {
    expect(phoneticKey('42')).toBe('');
  });
});
