/**
 * The line breaker, tested against what a presenter would notice.
 *
 * Two kinds of assertion here, and they are not equally negotiable. The
 * invariants — every token exactly once and in order, total on degenerate
 * input, deterministic, bounded — are the contract, and a failure in one of
 * them is a defect no tuning may explain away. The QUALITY assertions are
 * written as "this seam beats that seam", never as "the cost is 4.5", so that
 * the tuning constants can move without rewriting the suite; what they pin is
 * the model's judgement, which is the thing that is allowed to be argued with.
 *
 * Every quality assertion is a CONTROL and a TREATMENT over the same skeleton,
 * because a seam test without a control passes for the wrong reason: a break
 * lands somewhere else for a dozen reasons that have nothing to do with the
 * rule under test, and a suite that only ever looks at the treatment goes green
 * with the rule deleted. The nonsense fillers ("gorbin", "vandice") are nonsense
 * on purpose — no lexicon matches them, so the only thing that can move a break
 * is the one word the case changes.
 */
import { describe, expect, it } from 'vitest';
import { bestOf, budgetMessage } from './perf-budget';
import {
  breakLines,
  tokensForLine,
  verifyLineBreakPlan,
  visualWidth,
  type LineBreakPlan,
  type LineBreakReason,
  type LineBreakToken,
} from './line-break';

/** The stage hands over rendered words; this is that shape from a string. */
function words(text: string): LineBreakToken[] {
  return text
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word, index) => ({ text: word, tokenIndex: index }));
}

function render(tokens: readonly LineBreakToken[], plan: LineBreakPlan): string[] {
  return plan.lines.map((line) =>
    tokensForLine(tokens, line)
      .map((token) => token.text)
      .join(' '),
  );
}

/**
 * What a browser does: put the word on the line if it fits, otherwise start a
 * new one. Here to prove the difference is real rather than asserted.
 */
function greedy(tokens: readonly LineBreakToken[], maxChars: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const token of tokens) {
    const candidate = current === '' ? token.text : `${current} ${token.text}`;
    if (visualWidth(candidate) <= maxChars || current === '') current = candidate;
    else {
      lines.push(current);
      current = token.text;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}

const SWEEP_FROM = 16;
const SWEEP_TO = 40;

/**
 * The measures at which some line ends after `index`, over every ordinary
 * column width.
 *
 * A single measure proves nothing about a seam — the break may have landed
 * where it did because nothing else fitted. Sweeping the column and counting
 * how often the breaker is WILLING to stop there is the question the cost model
 * actually answers, and it is stable under retuning in a way a single plan is
 * not. The final line is excluded: it ends where the text ends, not where the
 * model chose.
 */
function breaksAfter(tokens: readonly LineBreakToken[], index: number): number[] {
  const measures: number[] = [];
  for (let target = SWEEP_FROM; target <= SWEEP_TO; target++) {
    const plan = breakLines(tokens, { targetChars: target });
    if (plan.lines.slice(0, -1).some((line) => line.endIndex === index)) measures.push(target);
  }
  return measures;
}

/** The seam kinds reported for a line ending after `index`, over the sweep. */
function reasonsAfter(tokens: readonly LineBreakToken[], index: number): LineBreakReason[] {
  const seen = new Set<LineBreakReason>();
  for (let target = SWEEP_FROM; target <= SWEEP_TO; target++) {
    const plan = breakLines(tokens, { targetChars: target });
    for (const line of plan.lines.slice(0, -1)) {
      if (line.endIndex === index) seen.add(line.reason);
    }
  }
  return [...seen];
}

const REFERENCE = 'The new version will launch on Monday, in South Africa and Australia.';
const REFERENCE_MEASURE = { targetChars: 30, maxChars: 34, minChars: 15 };

describe('the reference case', () => {
  it('breaks at the phrase boundaries a reader returns to, not at the last word that fits', () => {
    const tokens = words(REFERENCE);
    const plan = breakLines(tokens, REFERENCE_MEASURE);

    expect(render(tokens, plan)).toEqual([
      'The new version will launch',
      'on Monday,',
      'in South Africa and Australia.',
    ]);
  });

  it('is a different plan from the one the browser would have produced', () => {
    const tokens = words(REFERENCE);
    const plan = breakLines(tokens, REFERENCE_MEASURE);

    // The browser fills to the measure: "…launch on" / "Monday, in South Africa
    // and" / "Australia." — a line ending on a preposition, and a closing line
    // of one stranded word.
    expect(greedy(tokens, REFERENCE_MEASURE.maxChars)[0]).toBe(
      'The new version will launch on',
    );
    expect(render(tokens, plan)).not.toEqual(greedy(tokens, REFERENCE_MEASURE.maxChars));
  });

  it('names why each line ended where it did', () => {
    const plan = breakLines(words(REFERENCE), REFERENCE_MEASURE);
    expect(plan.lines.map((line) => line.reason)).toEqual(['phrase', 'clause', 'end']);
  });
});

describe('glue: the pairs a break may not come between', () => {
  /**
   * Same skeleton, same word lengths, one word changed from a class the model
   * knows to a nonsense word it does not. The control has to be WILLING to
   * break there or the case proves nothing about the rule.
   */
  function expectGlued(glued: string, control: string, index: number): void {
    expect(breaksAfter(words(glued), index)).toEqual([]);
    expect(breaksAfter(words(control), index).length).toBeGreaterThan(0);
  }

  it('never strands a noun from its article', () => {
    expectGlued(
      'gorbin plandu the version vurmek tregom plandu',
      'gorbin plandu vex vandice vurmek tregom plandu',
      2,
    );
  });

  it('never strands a verb from its auxiliary', () => {
    expectGlued(
      'gorbin plandu will vandice vurmek tregom plandu',
      'gorbin plandu vund vandice vurmek tregom plandu',
      2,
    );
  });

  it('never strands an object from its preposition', () => {
    expectGlued(
      'gorbin plandu with vandice vurmek tregom plandu',
      'gorbin plandu vund vandice vurmek tregom plandu',
      2,
    );
  });

  it('never ends a line on a conjunction', () => {
    // The comma in front of it is what makes this the conjunction rule and not
    // the bonus for opening a line WITH a conjunction: both strings can break
    // at the comma, so the only thing left to separate them is what happens on
    // the far side of the word.
    expectGlued(
      'gorbin plandu tregom, and vandice vurmek tregom plandu',
      'gorbin plandu tregom, vex vandice vurmek tregom plandu',
      3,
    );
  });

  it('never strands a verb from its pronoun', () => {
    expectGlued(
      'gorbin plandu they vandice vurmek tregom plandu',
      'gorbin plandu vexo vandice vurmek tregom plandu',
      2,
    );
  });

  it('never strands a noun from its adjective', () => {
    expectGlued(
      'gorbin plandu strong vandice vurmek tregom plandu',
      'gorbin plandu vundro vandice vurmek tregom plandu',
      2,
    );
  });

  it('keeps a number with its unit', () => {
    expectGlued(
      'gorbin plandu forty percent vurmek tregom plandu',
      'gorbin plandu vexto vandice vurmek tregom plandu',
      2,
    );
  });

  it('keeps a title with the name it belongs to', () => {
    // The follower is lowercase so this is the honorific rule alone and not the
    // two-capitals rule wearing its coat.
    expectGlued(
      'gorbin plandu Prof vandice vurmek tregom plandu',
      'gorbin plandu vund vandice vurmek tregom plandu',
      2,
    );
  });

  it('keeps the parts of a proper noun together', () => {
    // Only the capital of the SECOND word differs between the two.
    expectGlued(
      'gorbin plandu Sarah Vandice vurmek tregom plandu',
      'gorbin plandu Sarah vandice vurmek tregom plandu',
      2,
    );
  });

  it('does not read the capital that opens a sentence as half a name', () => {
    // "Sarah" is capitalised in both. In the first it opens the sentence, where
    // the capital means nothing, and the breaker must be free to stop after it.
    const initial = words('gorbin plandu tregom. Sarah Vandice vurmek tregom plandu');
    const mid = words('gorbin plandu tregomz Sarah Vandice vurmek tregom plandu');
    expect(breaksAfter(initial, 3).length).toBeGreaterThan(0);
    expect(breaksAfter(mid, 3)).toEqual([]);
  });

  it('keeps a currency symbol with its amount', () => {
    const build = (symbol: string): LineBreakToken[] => [
      ...words('gorbin plandu'),
      { text: symbol, spaceAfter: false },
      { text: '40,000' },
      ...words('vurmek tregom plandu'),
    ];
    expect(breaksAfter(build('$'), 2)).toEqual([]);
    expect(breaksAfter(build('~'), 2).length).toBeGreaterThan(0);
  });
});

describe('seams: the breaks the model reaches for', () => {
  it('takes a free sentence boundary over a better-measured ordinary break', () => {
    // Both land a line; the sentence one lands it seven characters short of the
    // measure and is still the cheaper plan. Same lengths in both strings, so
    // the only difference is that one of them ends a sentence.
    const sentence = words('gorbin plandu tregom. gorbin plandu tregom vurmek');
    const abbreviation = words('gorbin plandu approx. gorbin plandu tregom vurmek');
    const measure = { targetChars: 27, maxChars: 30, minChars: 5 };

    expect(breakLines(sentence, measure).lines[0]).toMatchObject({
      endIndex: 2,
      reason: 'sentence',
    });
    // "approx." ends in a dot and ends nothing, so there is no free seam to
    // take and the plan fills the measure instead.
    expect(breakLines(abbreviation, measure).lines[0]?.endIndex).not.toBe(2);
  });

  it('does not mistake an abbreviation or an acronym for the end of a sentence', () => {
    for (const text of [
      'gorbin plandu approx. vandice vurmek tregom plandu',
      'gorbin plandu U.S.A. vandice vurmek tregom plandu',
    ]) {
      const reasons = reasonsAfter(words(text), 2);
      // Non-empty first: an assertion that nothing is a sentence break is
      // satisfied for free by a token nothing ever breaks after.
      expect(reasons.length).toBeGreaterThan(0);
      expect(reasons).not.toContain('sentence');
    }
    expect(reasonsAfter(words('gorbin plandu tregom. vandice vurmek tregom plandu'), 2)).toEqual([
      'sentence',
    ]);
  });

  it('opens a line with a subordinate clause rather than breaking inside it', () => {
    const opener = words('gorbin plandu tregom because vandice vurmek tregom plandu');
    const control = words('gorbin plandu tregom vandiceo vandice vurmek tregom plandu');
    expect(reasonsAfter(opener, 2)).toEqual(['phrase']);
    expect(reasonsAfter(control, 2)).toEqual(['measure']);
  });

  it('opens a line with a prepositional phrase rather than breaking inside it', () => {
    const opener = words('gorbin plandu tregom during vandice vurmek tregom plandu');
    const control = words('gorbin plandu tregom vandiceo vandice vurmek tregom plandu');
    expect(reasonsAfter(opener, 2)).toEqual(['phrase']);
    expect(reasonsAfter(control, 2)).toEqual(['measure']);
  });
});

describe('the measure', () => {
  it('aims interior lines at the target rather than filling the column', () => {
    // Fifteen identical words: three fit the target exactly, five fill the
    // column exactly. A model with no raggedness term takes the fewest breaks
    // it can and every interior line comes out at the column edge.
    const tokens: LineBreakToken[] = Array.from({ length: 15 }, () => ({ text: 'gorbin' }));
    const plan = breakLines(tokens, { targetChars: 20, maxChars: 34, minChars: 8 });
    const interior = plan.lines.slice(0, -1).map((line) => line.widthChars);

    expect(interior.length).toBeGreaterThan(0);
    expect(Math.max(...interior)).toBeLessThan(34);
  });

  it('counts the space the caller says is there, and no other', () => {
    const joined: LineBreakToken[] = [{ text: 'abc', spaceAfter: false }, { text: 'def' }];
    const spaced: LineBreakToken[] = [{ text: 'abc' }, { text: 'def' }];
    expect(breakLines(joined, { targetChars: 40 }).lines[0]?.widthChars).toBe(6);
    expect(breakLines(spaced, { targetChars: 40 }).lines[0]?.widthChars).toBe(7);
  });

  it('refuses a mid-paragraph hole the text did not ask for', () => {
    // Nonsense words, so every seam in here is worth exactly the same and
    // minChars is the only thing that can be moving this plan. Neither closing
    // line is short enough or thin enough for the orphan rule to reach it.
    const tokens = words('plandu vundro tregom vexo vurmek vund vandice');
    const loose = breakLines(tokens, { targetChars: 22, maxChars: 25, minChars: 0 });
    const tight = breakLines(tokens, { targetChars: 22, maxChars: 25, minChars: 22 });

    expect(loose.lines[0]?.widthChars).toBeLessThan(22);
    expect(tight.lines[0]?.widthChars).toBeGreaterThanOrEqual(22);
  });

  it('forgives a line under minChars after a comma and refuses the same line without one', () => {
    // Identical words, identical measure; the only difference is one comma.
    // With it, a fifteen-character line is a beat the author asked for. Without
    // it, the same line is a hole and the plan lands two even lines instead.
    // Both closing lines carry four words, so the orphan rule is not in play
    // and the shortfall charge is the only thing that can be deciding this.
    const measure = { targetChars: 24, maxChars: 27, minChars: 17 };
    const clause = breakLines(words('plandu vandice, gorbin vurmek vundro tregom'), measure);
    const plain = breakLines(words('plandu vandice gorbin vurmek vundro tregom'), measure);

    expect(clause.lines.map((line) => `${line.widthChars} ${line.reason}`)).toEqual([
      '15 clause',
      '27 end',
    ]);
    expect(plain.lines.every((line) => line.widthChars >= measure.minChars)).toBe(true);
  });
});

describe('the closing line', () => {
  it('does not strand one short word at the end of a paragraph', () => {
    const tokens = words('The second recording session ran long and we lost the light.');
    const plan = breakLines(tokens, { targetChars: 28, maxChars: 32, minChars: 14 });
    const last = plan.lines[plan.lines.length - 1];
    expect(last).toBeDefined();
    if (!last) return;
    const wordCount = last.endIndex - last.startIndex + 1;
    expect(wordCount === 1 && last.widthChars < 14).toBe(false);
  });

  it('accepts a short closing line when it carries enough words', () => {
    const tokens = words('We will ship it on Friday and not a day sooner than that.');
    const plan = breakLines(tokens, { targetChars: 24, maxChars: 28, minChars: 12 });
    expect(verifyLineBreakPlan(tokens, plan)).toEqual([]);
    expect(plan.lines.length).toBeGreaterThan(1);
  });
});

describe('the invariant: the token sequence is never touched', () => {
  const corpus = [
    REFERENCE,
    'One.',
    'A B C D E F G H I J K L M N O P',
    'Supercalifragilisticexpialidocious antidisestablishmentarianism',
    'He said "we are done" — and then, after a pause, he left the room.',
    'Item 1. Item 2. Item 3. Item 4. Item 5. Item 6. Item 7. Item 8.',
    'It cost $40,000 and took 18 months and 3 people to finish properly.',
  ];

  it('emits every token exactly once, in order, at every measure', () => {
    for (const text of corpus) {
      const tokens = words(text);
      for (let target = 4; target <= 60; target += 3) {
        const plan = breakLines(tokens, { targetChars: target });
        expect(verifyLineBreakPlan(tokens, plan)).toEqual([]);
        const flattened = plan.lines.flatMap((line) => tokensForLine(tokens, line));
        expect(flattened).toEqual(tokens);
      }
    }
  });

  it('preserves the spoken token indexes untouched', () => {
    const tokens = words(REFERENCE);
    const plan = breakLines(tokens, REFERENCE_MEASURE);
    const indexes = plan.lines
      .flatMap((line) => tokensForLine(tokens, line))
      .map((token) => token.tokenIndex);
    expect(indexes).toEqual(tokens.map((_, index) => index));
  });

  it('reports a plan whose widths do not match the tokens it covers', () => {
    // The checker is the wiring agent's only executable statement that a plan
    // is safe to render, so it has to fail on a plan that lies. A width one
    // character out is a line box the browser wraps a second time.
    const tokens = words(REFERENCE);
    const plan = breakLines(tokens, REFERENCE_MEASURE);
    const lied = {
      ...plan,
      lines: plan.lines.map((line, i) =>
        i === 0 ? { ...line, widthChars: line.widthChars + 1 } : line,
      ),
    };
    expect(verifyLineBreakPlan(tokens, lied)).toHaveLength(1);

    // The overflow flag is what tells a caller a line will not fit whatever it
    // does; a plan that reports it wrongly is a line box sized to a lie.
    const miscalled = {
      ...plan,
      lines: plan.lines.map((line, i) => (i === 0 ? { ...line, overflow: true } : line)),
    };
    expect(verifyLineBreakPlan(tokens, miscalled)).toHaveLength(1);

    const dropped = { ...plan, lines: plan.lines.slice(0, -1) };
    expect(verifyLineBreakPlan(tokens, dropped).length).toBeGreaterThan(0);
  });
});

describe('totality', () => {
  it('plans nothing for no tokens', () => {
    const plan = breakLines([], REFERENCE_MEASURE);
    expect(plan.lines).toEqual([]);
    expect(plan.tokenCount).toBe(0);
    expect(verifyLineBreakPlan([], plan)).toEqual([]);
  });

  it('plans one line for one token', () => {
    const tokens = words('Hello');
    const plan = breakLines(tokens, REFERENCE_MEASURE);
    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0]?.overflow).toBe(false);
  });

  it('gives a token wider than the whole measure a line of its own, and says so', () => {
    const tokens = words('Say pneumonoultramicroscopicsilicovolcanoconiosis slowly now');
    const plan = breakLines(tokens, { targetChars: 12, maxChars: 14, minChars: 6 });
    expect(verifyLineBreakPlan(tokens, plan)).toEqual([]);
    const long = plan.lines.find((line) => (tokens[line.startIndex]?.text.length ?? 0) > 20);
    expect(long?.overflow).toBe(true);
    expect(long?.startIndex).toBe(long?.endIndex);
    // A solve that ran out of legal plans and fell back to one atom per line
    // renders the same thing and costs nothing. This is what tells the two
    // apart: a real solve prices the overflow it could not avoid.
    expect(Number.isFinite(plan.cost)).toBe(true);
    expect(plan.cost).toBeGreaterThan(0);
  });

  it('keeps a run that may not break on one line, however it falls', () => {
    // Three inline runs rendered with no space between them: "the", "API", "s"
    // are one word on the glass and must stay one word on every measure.
    const tokens: LineBreakToken[] = [
      ...words('We renamed every one of the'),
      { text: 'the', spaceAfter: false, noBreakAfter: true },
      { text: 'API', spaceAfter: false, noBreakAfter: true },
      { text: 's' },
      ...words('in the public interface last week.'),
    ];
    const joinedStart = 6;
    for (let target = 6; target <= 50; target += 2) {
      const plan = breakLines(tokens, { targetChars: target });
      expect(verifyLineBreakPlan(tokens, plan)).toEqual([]);
      const holder = plan.lines.find((line) => line.startIndex <= joinedStart && line.endIndex >= joinedStart);
      expect(holder?.endIndex).toBeGreaterThanOrEqual(joinedStart + 2);
    }
  });

  it('lets an authored break win over a forbidden one, rather than deadlocking', () => {
    const tokens: LineBreakToken[] = [
      { text: 'before' },
      { text: 'joined', spaceAfter: false, noBreakAfter: true, breakAfter: true },
      { text: 'after' },
    ];
    const plan = breakLines(tokens, { targetChars: 40 });
    expect(plan.lines.map((line) => line.endIndex)).toEqual([1, 2]);
    expect(verifyLineBreakPlan(tokens, plan)).toEqual([]);
  });

  it('returns one long line when nothing may break', () => {
    const tokens = words('nothing here is allowed to break at all')
      .map((token) => ({ ...token, noBreakAfter: true }));
    const plan = breakLines(tokens, { targetChars: 10, maxChars: 12, minChars: 5 });
    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0]?.overflow).toBe(true);
    expect(plan.lines[0]?.endIndex).toBe(tokens.length - 1);
  });

  it('survives nonsense options', () => {
    const tokens = words(REFERENCE);
    for (const opts of [
      { targetChars: 0 },
      { targetChars: Number.NaN, maxChars: Number.NaN, minChars: Number.NaN },
      { targetChars: -20, maxChars: -1, minChars: -5 },
      { targetChars: 40, maxChars: 5 },
      { targetChars: 20, minChars: 900 },
      { targetChars: Number.POSITIVE_INFINITY, maxChars: Number.POSITIVE_INFINITY },
      undefined,
    ]) {
      const plan = breakLines(tokens, opts);
      expect(verifyLineBreakPlan(tokens, plan)).toEqual([]);
      expect(plan.measure.targetChars).toBeGreaterThan(0);
      expect(Number.isFinite(plan.measure.maxChars)).toBe(true);
      expect(plan.measure.maxChars).toBeGreaterThanOrEqual(plan.measure.targetChars);
      expect(plan.measure.minChars).toBeLessThanOrEqual(plan.measure.targetChars);
    }
  });

  it('survives empty and whitespace-only token text', () => {
    const tokens: LineBreakToken[] = [
      { text: '' },
      { text: 'real' },
      { text: '' },
      { text: 'words' },
    ];
    const plan = breakLines(tokens, { targetChars: 8, maxChars: 10 });
    expect(verifyLineBreakPlan(tokens, plan)).toEqual([]);
  });
});

describe('forced breaks', () => {
  it('ends a line where the caller says a line ends', () => {
    const tokens = words('Two roads diverged in a yellow wood and both looked the same');
    const forcedAt = 4;
    const withBreak = tokens.map((token, index) =>
      index === forcedAt ? { ...token, breakAfter: true } : token,
    );
    const plan = breakLines(withBreak, { targetChars: 40, maxChars: 46 });
    expect(plan.lines.some((line) => line.endIndex === forcedAt)).toBe(true);
    expect(plan.lines.find((line) => line.endIndex === forcedAt)?.reason).toBe('forced');
    expect(verifyLineBreakPlan(withBreak, plan)).toEqual([]);
  });

  it('honours a forced break on the last token without emitting an empty line', () => {
    const tokens = words('One two three').map((token, index, all) =>
      index === all.length - 1 ? { ...token, breakAfter: true } : token,
    );
    const plan = breakLines(tokens, { targetChars: 40 });
    expect(plan.lines).toHaveLength(1);
    expect(verifyLineBreakPlan(tokens, plan)).toEqual([]);
  });
});

describe('determinism', () => {
  it('produces byte-identical plans for identical input', () => {
    const tokens = words(REFERENCE);
    const first = breakLines(tokens, REFERENCE_MEASURE);
    for (let i = 0; i < 25; i++) {
      expect(JSON.stringify(breakLines(tokens, REFERENCE_MEASURE))).toEqual(
        JSON.stringify(first),
      );
    }
  });

  it('resolves a tie the same way every time, and the way it says it does', () => {
    // Six identical one-character words at a measure where a two-word line and
    // a one-word line are exactly equidistant from the target, with a forced
    // break to keep the tie from being swallowed by the free last line. Both
    // plans cost the same; the documented policy is that the shorter line wins.
    const tokens: LineBreakToken[] = Array.from({ length: 6 }, (_, i) => ({
      text: 'q',
      breakAfter: i === 2,
    }));
    const plan = breakLines(tokens, { targetChars: 4, maxChars: 4, minChars: 0 });
    expect(plan.lines.map((line) => line.endIndex)).toEqual([1, 2, 4, 5]);
  });

  it('signs the break positions, so a fingerprint can carry the plan', () => {
    const tokens = words(REFERENCE);
    const a = breakLines(tokens, REFERENCE_MEASURE);
    const b = breakLines(tokens, REFERENCE_MEASURE);
    expect(a.signature).toBe(b.signature);
    expect(a.signature).toMatch(/^[0-9a-f]{16}$/);
  });

  it('changes the signature when the breaks move under one measure', () => {
    // Same measure, same token count, different break positions. Nothing but
    // the break positions can distinguish these two, so a signature that does
    // not carry them cannot tell the stage its layout moved.
    const measure = { targetChars: 20, maxChars: 22, minChars: 10 };
    const even = words('aaaa bbbb cccc dddd eeee ffff gggg hhhh');
    const uneven = words('aaaaaaaa bb cccccccc dd eeeeeeee ff gggggggg hh');
    expect(even).toHaveLength(uneven.length);

    const a = breakLines(even, measure);
    const b = breakLines(uneven, measure);
    expect(a.lines.map((line) => line.endIndex)).not.toEqual(b.lines.map((line) => line.endIndex));
    expect(a.signature).not.toBe(b.signature);
  });

  it('changes the signature when the measure moves under one set of breaks', () => {
    // Same tokens, same resulting breaks, a wider column. The lines are in the
    // same place and every one of them is a different width, so a signature
    // that only carries break positions would report no change at all.
    const tokens = words(REFERENCE);
    const narrow = breakLines(tokens, { targetChars: 30, maxChars: 34, minChars: 15 });
    const wide = breakLines(tokens, { targetChars: 30, maxChars: 36, minChars: 15 });
    expect(narrow.lines.map((line) => line.endIndex)).toEqual(
      wide.lines.map((line) => line.endIndex),
    );
    expect(narrow.signature).not.toBe(wide.signature);
  });
});

describe('text the heuristics do not understand', () => {
  it('wraps CJK by the width it actually occupies, not by character count', () => {
    // Each glyph is two cells wide, so a 20-cell measure holds ten of them.
    const glyphs = Array.from('這是一個沒有空格的句子而且它必須仍然可以換行的測試').map((glyph) => ({
      text: glyph,
      spaceAfter: false,
    }));
    const plan = breakLines(glyphs, { targetChars: 20, maxChars: 20, minChars: 10 });
    expect(verifyLineBreakPlan(glyphs, plan)).toEqual([]);
    expect(plan.lines.length).toBeGreaterThan(1);
    for (const line of plan.lines) expect(line.widthChars).toBeLessThanOrEqual(20);
  });

  it('returns a valid plan for a right-to-left script', () => {
    const tokens = words('هذا نص عربي طويل بما فيه الكفاية ليحتاج إلى أكثر من سطر واحد');
    const plan = breakLines(tokens, { targetChars: 20, maxChars: 24, minChars: 10 });
    expect(verifyLineBreakPlan(tokens, plan)).toEqual([]);
    expect(plan.lines.length).toBeGreaterThan(1);
    for (const line of plan.lines) expect(line.overflow).toBe(false);
  });

  it('degrades to measure-based wrapping when no lexical rule applies', () => {
    const tokens = words('ᚠᚢᚦ ᚨᚱᚲ ᚷᚹᚺ ᚾᛁᛃ ᛇᛈᛉ ᛊᛏᛒ ᛖᛗᛚ ᛜᛞᛟ');
    const plan = breakLines(tokens, { targetChars: 12, maxChars: 14, minChars: 6 });
    expect(verifyLineBreakPlan(tokens, plan)).toEqual([]);
    expect(plan.lines.every((line) => line.reason === 'measure' || line.reason === 'end')).toBe(
      true,
    );
  });

  it('measures astral characters once, not twice', () => {
    expect(visualWidth('🙂')).toBe(1);
    expect(visualWidth('ab')).toBe(2);
    expect(visualWidth('漢')).toBe(2);
  });
});

describe('cost', () => {
  it('plans a 5,000-word script in well under a frame', () => {
    // A deterministic pseudo-script: no randomness, so the timing is comparable
    // between runs and the plan is reproducible if this ever fails.
    const vocabulary = [
      'the', 'new', 'version', 'will', 'launch', 'on', 'Monday,', 'in', 'South',
      'Africa', 'and', 'Australia.', 'we', 'rebuilt', 'the', 'entire',
      'recording', 'pipeline', 'because', 'the', 'audio', 'path', 'was',
      'wrong.', 'it', 'cost', '40', 'percent', 'more', 'than', 'planned.',
    ];
    const tokens: LineBreakToken[] = [];
    for (let i = 0; i < 5000; i++) {
      tokens.push({ text: vocabulary[i % vocabulary.length] ?? 'word', tokenIndex: i });
    }

    /*
     * Fastest of several runs, not one measurement. `bestOf` warms up first and
     * explains why the minimum is the honest estimate: contention can only make
     * a run slower, and this budget used to fail at 36 ms on a machine running
     * the rest of the suite while passing on its own seconds later.
     */
    const run = bestOf(() => breakLines(tokens, { targetChars: 38, maxChars: 44, minChars: 19 }));

    expect(verifyLineBreakPlan(tokens, run.value)).toEqual([]);
    expect(run.elapsedMs, budgetMessage('5,000-word plan', run, 16)).toBeLessThan(16);
  });

  it('stays linear-ish: ten times the script is not a hundred times the work', () => {
    const build = (count: number): LineBreakToken[] =>
      Array.from({ length: count }, (_, i) => ({ text: `word${i % 7}`, tokenIndex: i }));
    const time = (count: number): number => {
      const tokens = build(count);
      breakLines(tokens, { targetChars: 38 });
      const startedAt = performance.now();
      breakLines(tokens, { targetChars: 38 });
      return performance.now() - startedAt;
    };
    const small = Math.max(time(2000), 0.05);
    const large = time(20000);
    expect(large / small).toBeLessThan(40);
  });

  it('stays bounded when the atoms have no width to stop the scan on', () => {
    // Empty tokens joined with no separator: nothing ever passes the column, so
    // the width test that bounds every other input bounds this one not at all.
    // Without a hard window the solve is quadratic on a document a caller can
    // produce by accident with two adjacent inline runs that render to nothing.
    const tokens: LineBreakToken[] = Array.from({ length: 20000 }, () => ({
      text: '',
      spaceAfter: false,
    }));
    breakLines(tokens.slice(0, 200), { targetChars: 38 });
    const run = bestOf(() => breakLines(tokens, { targetChars: 38 }));

    expect(verifyLineBreakPlan(tokens, run.value)).toEqual([]);
    expect(run.elapsedMs, budgetMessage('zero-width scan', run, 120)).toBeLessThan(120);
  });
});
