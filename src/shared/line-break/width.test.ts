/**
 * The measured-width seam.
 *
 * Character cells are a fair estimate of a COLUMN and a poor estimate of any
 * individual line. These pin the behaviour that lets the stage hand the solver
 * what it actually measured instead.
 */
import { describe, expect, it } from 'vitest';
import { breakLines, verifyLineBreakPlan, visualWidth } from './index';
import { tokenSeparator, tokenWidth } from './width';
import type { LineBreakToken } from './types';

describe('a supplied width', () => {
  it('is used instead of the character count', () => {
    expect(tokenWidth({ text: 'iiii', width: 40 })).toBe(40);
  });

  it('falls back to cells when it is missing', () => {
    expect(tokenWidth({ text: 'iiii' })).toBe(visualWidth('iiii'));
  });

  /*
   * Per FIELD, not per token: a caller that measures most of a block and misses
   * one span gets a plan wrong about one word, not a plan that silently reverts
   * the whole block to cells while the measure stays in pixels.
   */
  it('falls back per field when only one of the two is given', () => {
    expect(tokenWidth({ text: 'abc', separatorWidth: 9 })).toBe(3);
    expect(tokenSeparator({ text: 'abc', width: 30 })).toBe(1);
  });

  it.each([
    ['negative', -5],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
  ])('refuses a %s width rather than planning with it', (_label, value) => {
    expect(tokenWidth({ text: 'abc', width: value })).toBe(3);
  });

  it('honours a zero separator, which is not the same as a missing one', () => {
    expect(tokenSeparator({ text: 'abc', separatorWidth: 0 })).toBe(0);
    expect(tokenSeparator({ text: 'abc' })).toBe(1);
  });

  it('still reports no separator when the caller said there is no space', () => {
    expect(tokenSeparator({ text: 'abc', spaceAfter: false })).toBe(0);
  });
});

/*
 * Reported from a real stage: the breaker was shortening lines further than
 * anything on the glass justified. The clearest instance was a line holding the
 * single word "readable," in a 36-character column — the seam was excellent, so
 * the hole penalty (scaled by how weak the seam is) charged almost nothing for
 * the other twenty-seven characters being empty.
 */
describe('lines the presenter reads as too short', () => {
  const words = (text: string): LineBreakToken[] =>
    text.split(' ').map((word) => ({ text: word }));

  const SENTENCE =
    'The text should remain centred, readable, and predictable until the last word appears on screen.';

  it('does not strand one short word on a line just because the seam is good', () => {
    const tokens = words(SENTENCE);
    const plan = breakLines(tokens, { targetChars: 36, maxChars: 36, minChars: 18 });
    for (const line of plan.lines.slice(0, -1)) {
      const wordCount = line.endIndex - line.startIndex + 1;
      expect(
        wordCount,
        `line ${line.startIndex}..${line.endIndex} holds one word at width ${line.widthChars}`,
      ).toBeGreaterThan(1);
    }
  });

  /*
   * The general form of the same complaint. A comma or a full stop buys a short
   * line — that is the entire point of the module — but it must not buy an
   * arbitrarily short one, so the discount has a floor under it.
   */
  it.each([28, 32, 36, 42, 48, 54])(
    'keeps interior lines above a third of the column (column %i)',
    (column) => {
      const plan = breakLines(words(SENTENCE), {
        targetChars: column,
        maxChars: column,
        minChars: Math.round(column * 0.5),
      });
      for (const line of plan.lines.slice(0, -1)) {
        expect(line.widthChars).toBeGreaterThan(column / 3);
      }
    },
  );
});

/**
 * The glue guarantees, under the measure the STAGE actually solves with.
 *
 * The suite in `line-break.test.ts` sweeps `targetChars` alone, which hands the
 * solver the default 12% of slack above its aim. `wrap-plan.ts` does not: the
 * column is a hard ceiling, so it passes `targetChars === maxChars`, and the
 * cost model behaves differently there — every line is under-filled by
 * definition, so the raggedness term is always pushing outward.
 *
 * That difference is not academic. It hid a real regression: a raggedness
 * weight that kept every guarantee in the swept configuration split a pronoun
 * from its verb at an 18-character column, and a number from its unit at 19,
 * in the configuration that ships. Any retune has to be measured HERE.
 */
describe('glue, in the configuration the stage solves with', () => {
  const GLUE_CASES: Array<[string, string]> = [
    ['a pronoun from its verb', 'gorbin plandu they vandice vurmek tregom plandu'],
    ['a number from its unit', 'gorbin plandu forty percent vurmek tregom plandu'],
    ['an article from its noun', 'gorbin plandu the version vurmek tregom plandu'],
    ['the parts of a name', 'gorbin plandu Sarah Vandice vurmek tregom plandu'],
    ['a preposition from its object', 'gorbin plandu on Monday vurmek tregom plandu'],
    ['an auxiliary from its verb', 'gorbin plandu will vandice vurmek tregom plandu'],
  ];

  it.each(GLUE_CASES)('never splits %s at any column the stage can resolve', (_label, text) => {
    const tokens: LineBreakToken[] = text.split(' ').map((word) => ({ text: word }));
    const offenders: number[] = [];
    for (let column = 16; column <= 40; column++) {
      const plan = breakLines(tokens, {
        targetChars: column,
        maxChars: column,
        minChars: Math.round(column / 2),
      });
      // The glued pair is tokens 2 and 3, so a line ending at 2 splits it.
      if (plan.lines.slice(0, -1).some((line) => line.endIndex === 2)) offenders.push(column);
    }
    expect(offenders, `split at columns ${offenders.join(',')}`).toEqual([]);
  });
});

describe('planning in pixels', () => {
  /**
   * A proportional face where 'i' is narrow and 'W' is wide. Character cells
   * cannot see the difference; the stage can.
   */
  const advance = (text: string): number => {
    let px = 0;
    for (const ch of text) px += ch === 'i' ? 4 : ch === 'W' ? 24 : 10;
    return px;
  };
  const px = (text: string): LineBreakToken[] =>
    text.split(' ').map((word) => ({ text: word, width: advance(word), separatorWidth: 5 }));

  it('fits more narrow words than wide ones in the same column', () => {
    const narrow = breakLines(px('iiii iiii iiii iiii iiii iiii'), {
      targetChars: 120,
      maxChars: 130,
    });
    const wide = breakLines(px('WWWW WWWW WWWW WWWW WWWW WWWW'), {
      targetChars: 120,
      maxChars: 130,
    });
    // Same word count, same cell count, very different columns.
    expect(narrow.lines.length).toBeLessThan(wide.lines.length);
  });

  it('never plans a line past a measure expressed in the same unit', () => {
    const tokens = px('WWW iii WWWW ii WWWWW iiii WWW iiiii WW iii');
    const plan = breakLines(tokens, { targetChars: 100, maxChars: 110 });
    for (const line of plan.lines) {
      if (line.widthChars <= 110) continue;
      /*
       * The one permitted overflow: a single run wider than the whole column.
       * "WWWWW" is 120px against a 110px measure, and no plan can make that
       * fit — it is a fact about the text, not a choice the solver made.
       */
      expect(line.startIndex).toBe(line.endIndex);
      expect(line.overflow).toBe(true);
    }
  });

  it('reports widths the verifier agrees with, fractional pixels included', () => {
    const tokens: LineBreakToken[] = 'one two three four five six seven eight'
      .split(' ')
      .map((word) => ({
        text: word,
        width: word.length * 9.37,
        separatorWidth: 4.21,
      }));
    const plan = breakLines(tokens, { targetChars: 90, maxChars: 100 });
    // The solver subtracts prefix sums, the verifier adds; IEEE 754 does not
    // promise those agree in the last bits, and a checker that fired on that
    // would be useless.
    expect(verifyLineBreakPlan(tokens, plan)).toEqual([]);
    expect(plan.lines.length).toBeGreaterThan(1);
  });

  /*
   * The scan bound has to come from the width of the atoms, not from the count
   * of them.
   *
   * `maxChars + 2` assumed every atom occupies at least one unit, which holds
   * for character cells and fails for advances normalised against an AVERAGE
   * character: "i" and a space are each a fraction of one. A window sized in
   * atoms would stop short of a line that genuinely fits and force a break the
   * geometry never asked for.
   */
  it('fills a line with atoms narrower than one unit of the measure', () => {
    // Forty atoms of 0.3 + 0.2 separator = exactly 20 units, the whole measure.
    const tokens: LineBreakToken[] = Array.from({ length: 40 }, () => ({
      text: 'i',
      width: 0.3,
      separatorWidth: 0.2,
    }));
    const plan = breakLines(tokens, { targetChars: 20, maxChars: 20 });
    expect(plan.lines).toHaveLength(1);
    expect(verifyLineBreakPlan(tokens, plan)).toEqual([]);
  });

  it('keeps the seam rules working when the widths are pixels', () => {
    const text = 'We shipped the new version on Monday and it saved our team time';
    const tokens: LineBreakToken[] = text.split(' ').map((word) => ({
      text: word,
      width: advance(word),
      separatorWidth: 5,
    }));
    const plan = breakLines(tokens, { targetChars: 180, maxChars: 200 });
    // Whatever the unit, a line may not end on a determiner.
    for (const line of plan.lines.slice(0, -1)) {
      expect(tokens[line.endIndex]?.text).not.toBe('the');
    }
  });
});
