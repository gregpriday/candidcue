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

  it('expands dotted honorifics through the bounded dictionary', () => {
    expect(aliasesForToken('Mr.', 'mr')).toContain('mister');
    expect(aliasesForToken('Dr.', 'dr')).toContain('doctor');
  });

  it('does not expand bare common words as abbreviations', () => {
    expect(aliasesForToken('no', 'no')).not.toContain('number');
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
