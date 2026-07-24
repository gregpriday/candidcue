import { describe, expect, it } from 'vitest';
import {
  concatenatedDigitStrings,
  findNumberRuns,
  integerToWords,
  numberVariants,
  parseNumberAt,
} from '../../../../src/shared/coaching/fidelity/numbers';
import { normalizeWords } from '../../../../src/shared/coaching/fidelity/normalize';

/**
 * These tests pin the two directions the comparator depends on. They are
 * deliberately value-asserting: a parser that returned `undefined` for
 * everything, or a variant generator that returned `[]`, fails every case
 * below.
 */
describe('normalizeSurface / normalizeWords', () => {
  it('preserves thousands separators and decimals', () => {
    expect(normalizeWords('1,500')).toEqual(['1500']);
    expect(normalizeWords('3.14')).toEqual(['3.14']);
    expect(normalizeWords('1,234,567')).toEqual(['1234567']);
  });

  it('expands percent and currency into ordered words', () => {
    expect(normalizeWords('50%')).toEqual(['50', 'percent']);
    expect(normalizeWords('$1,500')).toEqual(['dollars', '1500']);
    // The currency word must not land between a number and its scale word.
    expect(normalizeWords('$50 million')).toEqual(['dollars', '50', 'million']);
  });

  it('keeps contraction apostrophes but drops sentence punctuation', () => {
    expect(normalizeWords("don't, really.")).toEqual(["don't", 'really']);
  });
});

describe('parseNumberAt', () => {
  const cases: Array<[string, number, number]> = [
    ['fifty', 50, 1],
    ['fifty percent', 50, 1],
    ['fifteen hundred', 1500, 2],
    ['one thousand five hundred', 1500, 4],
    ['two thousand and twenty six', 2026, 5],
    ['one hundred fifty', 150, 3],
    ['three point one four', 3.14, 4],
    ['1500', 1500, 1],
    ['1,500', 1500, 1],
    ['3.14', 3.14, 1],
    ['50%', 50, 1],
  ];
  for (const [text, value, length] of cases) {
    it(`parses "${text}"`, () => {
      const words = normalizeWords(text);
      const run = parseNumberAt(words, 0);
      expect(run?.value).toBe(value);
      expect(run?.length).toBe(length);
    });
  }

  it('refuses to merge two tens words ("twenty twenty six" is not 46)', () => {
    const runs = findNumberRuns(normalizeWords('twenty twenty six'));
    expect(runs.map((run) => run.value)).toEqual([20, 26]);
  });

  it('does not read "second" as the ordinal 2', () => {
    // "twenty second" must stay 20, otherwise a mangled "twenty seconds"
    // fabricates a mismatch against an authored 20.
    const runs = findNumberRuns(normalizeWords('twenty second'));
    expect(runs.map((run) => run.value)).toEqual([20]);
  });

  it('keeps a leading zero from absorbing its neighbour', () => {
    const runs = findNumberRuns(normalizeWords('two zero two six'));
    expect(runs.map((run) => run.value)).toEqual([2, 0, 2, 6]);
  });
});

describe('concatenatedDigitStrings', () => {
  it('recovers year readings the accumulator refuses to merge', () => {
    expect(concatenatedDigitStrings(normalizeWords('twenty twenty six')).has('2026')).toBe(true);
    expect(concatenatedDigitStrings(normalizeWords('nineteen eighty four')).has('1984')).toBe(true);
    expect(concatenatedDigitStrings(normalizeWords('two zero two six')).has('2026')).toBe(true);
  });

  it('does not concatenate across a non-numeric word', () => {
    expect(concatenatedDigitStrings(normalizeWords('twenty of twenty six')).has('2026')).toBe(false);
  });
});

describe('integerToWords', () => {
  it('spells values the comparator relies on', () => {
    expect(integerToWords(50)).toBe('fifty');
    expect(integerToWords(1500)).toBe('one thousand five hundred');
    expect(integerToWords(2026)).toBe('two thousand twenty six');
  });
});

describe('numberVariants', () => {
  const expectVariants = (value: number, wanted: string[]): void => {
    const variants = new Set(numberVariants(value));
    const missing = wanted.filter((want) => !variants.has(want));
    expect(missing).toEqual([]);
  };

  it('covers the spoken forms of 1500', () => {
    expectVariants(1500, [
      '1500',
      'one thousand five hundred',
      'one thousand and five hundred',
      'fifteen hundred',
    ]);
  });

  it('covers the spoken forms of 2026', () => {
    expectVariants(2026, [
      '2026',
      'two thousand twenty six',
      'two thousand and twenty six',
      'twenty twenty six',
      'two zero two six',
    ]);
  });

  it('covers percentages and plain values', () => {
    expectVariants(50, ['50', 'fifty']);
    expectVariants(100, ['100', 'one hundred', 'a hundred']);
    expectVariants(150, ['150', 'one hundred fifty', 'one hundred and fifty']);
  });

  it('covers scaled values', () => {
    expectVariants(1_500_000, [
      '1500000',
      'one point five million',
      '1.5 million',
      'one and a half million',
    ]);
    expectVariants(50_000_000, ['fifty million', '50 million']);
  });

  it('covers ordinals only when asked', () => {
    expect(numberVariants(3, { ordinal: true })).toContain('third');
    expect(numberVariants(3, { ordinal: true })).toContain('3rd');
    expect(numberVariants(3)).not.toContain('third');
  });

  it('always accepts the authored wording verbatim', () => {
    expect(numberVariants(1500, { literalWords: ['1500'] })).toContain('1500');
    expect(numberVariants(2, { literalWords: ['a', 'couple'] })).toContain('a couple');
  });
});
