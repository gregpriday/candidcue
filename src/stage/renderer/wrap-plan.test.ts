/**
 * The bridge between the compiler's blocks and the solver's plan.
 *
 * The properties worth pinning here are not "does it break well" — the solver's
 * own suite covers that — but "does it break where the renderer can actually
 * put a break", and "does it get out of the way when it cannot answer".
 */
import { describe, expect, it } from 'vitest';
import type { CompiledBlock, SafeRenderNode } from '../../shared/contracts';
import { flattenWords, type AdvanceMeasurer, type AdvanceStyle } from './advance';
import { planBlockBreaks, planScriptBreaks } from './wrap-plan';

const BASE: AdvanceStyle = {
  fontStack: 'Test',
  fontSizePx: 40,
  fontWeight: 400,
  italic: false,
  mono: false,
  letterSpacingPx: 0,
};

/** A monospace-ish fake: every glyph 10px, a space 5px, bold a shade wider. */
const fake: AdvanceMeasurer = (text, style) => {
  const per = style.fontWeight >= 700 ? 11 : 10;
  return text === ' ' ? 5 : text.length * per;
};

/** A platform with no text metrics at all. */
const refuses: AdvanceMeasurer = () => null;

function text(t: string, tokenStart = 0): SafeRenderNode {
  const words = t.split(/\s+/).filter(Boolean);
  return {
    type: 'text',
    text: t,
    tokenIndexes: words.map((_, i) => tokenStart + i),
  };
}

function paragraph(nodes: SafeRenderNode[], id = 'b1'): CompiledBlock {
  return {
    id,
    kind: 'paragraph',
    renderNodes: nodes,
    source: { utf16Start: 0, utf16End: 0 },
    spoken: true,
  };
}

const SENTENCE = 'We shipped the new version on Monday and it saved our team time';

describe('flattening a block into words', () => {
  it('marks the space between words and not the end of the run', () => {
    const words = flattenWords([text('one two three')], BASE);
    expect(words.map((w) => w.text)).toEqual(['one', 'two', 'three']);
    expect(words.map((w) => w.spaceAfter)).toEqual([true, true, false]);
  });

  it('carries the compiler token index onto each word', () => {
    const words = flattenWords([text('one two three', 5)], BASE);
    expect(words.map((w) => w.tokenIndex)).toEqual([5, 6, 7]);
  });

  it('reads a run with no space after it as one unbreakable word', () => {
    // "**Candid**Cue": two runs, no whitespace, one word on the glass.
    const words = flattenWords(
      [
        { type: 'text', text: 'Candid', marks: ['strong'], tokenIndexes: [0] },
        { type: 'text', text: 'Cue', tokenIndexes: [1] },
      ],
      BASE,
    );
    expect(words[0]?.spaceAfter).toBe(false);
  });

  it('measures a bold run in the weight it is drawn in', () => {
    const words = flattenWords(
      [{ type: 'text', text: 'bold', marks: ['strong'], tokenIndexes: [0] }],
      BASE,
    );
    expect(words[0]?.style.fontWeight).toBe(700);
  });

  it('walks into a link label, which is ordinary inline text', () => {
    const words = flattenWords(
      [{ type: 'link', external: false, label: [text('the docs')] }],
      BASE,
    );
    expect(words.map((w) => w.text)).toEqual(['the', 'docs']);
  });

  it('turns an authored line break into a forced break on the word before it', () => {
    const words = flattenWords([text('one two'), { type: 'line_break' }, text('three', 2)], BASE);
    expect(words[1]?.breakAfter).toBe(true);
  });

  /*
   * The plan is keyed on token index and the renderer draws the break by
   * looking that index up, so the two must resolve token identity identically.
   * `segmentText` anchors a MISALIGNED run's first word to the first index and
   * gives up on the rest; this must do the same, or the planner is reasoning
   * about a different set of names than the renderer is drawing.
   */
  it('resolves a misaligned token mapping the way the renderer does', () => {
    const words = flattenWords(
      // Four words, three indexes: the compiler's mapping does not line up.
      [{ type: 'text', text: 'one two three four', tokenIndexes: [7, 8, 9] }],
      BASE,
    );
    expect(words.map((w) => w.tokenIndex)).toEqual([7, null, null, null]);
  });

  it('does not treat an image or a cue as a word', () => {
    const words = flattenWords(
      [text('one'), { type: 'image', assetId: 'a', alt: 'x' }, { type: 'cue', cueType: 'beat', label: 'PAUSE' }],
      BASE,
    );
    expect(words.map((w) => w.text)).toEqual(['one']);
  });
});

describe('planning a block', () => {
  it('chooses breaks a narrow column needs', () => {
    const plan = planBlockBreaks([text(SENTENCE)], {
      columnWidthPx: 300,
      baseStyle: BASE,
      measure: fake,
    });
    expect(plan).not.toBeNull();
    expect(plan?.breakAfterTokens.size).toBeGreaterThan(0);
    expect(plan?.lineCount).toBeGreaterThan(1);
  });

  it('never ends a line on a word with no space after it', () => {
    const nodes: SafeRenderNode[] = [
      { type: 'text', text: 'Candid', marks: ['strong'], tokenIndexes: [0] },
      { type: 'text', text: 'Cue is a prompter that follows your voice closely', tokenIndexes: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
    ];
    const plan = planBlockBreaks(nodes, {
      columnWidthPx: 240,
      baseStyle: BASE,
      measure: fake,
    });
    // Token 0 is "Candid", welded to "Cue" — a break there would split one word.
    expect(plan?.breakAfterTokens.has(0)).toBe(false);
  });

  it('does not draw a second break where the renderer already draws one', () => {
    const plan = planBlockBreaks(
      [text('one two three'), { type: 'line_break' }, text('four five six', 3)],
      { columnWidthPx: 400, baseStyle: BASE, measure: fake },
    );
    // Token 2 ends a line, but it ends it because of the <br> the renderer
    // already emits. Marking it as well would put a blank line on the glass.
    expect(plan?.breakAfterTokens.has(2)).toBe(false);
  });

  /*
   * The compiler maps a MERGED token onto every render node it spans — there is
   * a test asserting exactly that for "**Candid**Cue" — so one token index can
   * name two rendered spans. The renderer draws a break after every span
   * carrying a planned index, so planning a break on a duplicated index would
   * draw TWO breaks and split a word that has no space in it at all.
   */
  it.each([120, 160, 200, 260, 340])(
    'refuses a break on a token index that names more than one rendered span (column %i)',
    (columnWidthPx) => {
      const nodes: SafeRenderNode[] = [
        // Exactly what `compile('**Candid**Cue ships…')` produces: one token, two nodes.
        { type: 'text', text: 'Candid', marks: ['strong'], tokenIndexes: [0] },
        {
          type: 'text',
          text: 'Cue ships every single week without fail',
          tokenIndexes: [0, 1, 2, 3, 4, 5, 6],
        },
      ];
      const plan = planBlockBreaks(nodes, { columnWidthPx, baseStyle: BASE, measure: fake });
      expect(plan).not.toBeNull();
      expect(plan?.breakAfterTokens.size).toBeGreaterThan(0);

      /*
       * Stated as the invariant rather than as "not token 0", so it cannot pass
       * merely because the solver happened to break somewhere else at this
       * particular width: EVERY planned index must name exactly one span.
       */
      const occurrences = new Map<number, number>();
      for (const word of flattenWords(nodes, BASE)) {
        if (word.tokenIndex === null) continue;
        occurrences.set(word.tokenIndex, (occurrences.get(word.tokenIndex) ?? 0) + 1);
      }
      for (const token of plan?.breakAfterTokens ?? []) {
        expect(occurrences.get(token), `token ${token} names two spans`).toBe(1);
      }
    },
  );

  /*
   * `\s` in JavaScript includes U+00A0. CSS does not break at one, and does not
   * collapse it either — so a planned break there defies the author AND leaves
   * a visible indent at the start of the next line.
   */
  it.each([110, 150, 190, 240])('refuses a break at a non-breaking space (column %i)', (columnWidthPx) => {
    const nodes: SafeRenderNode[] = [
      {
        type: 'text',
        text: 'We spoke in South Africa about the whole difficult business',
        tokenIndexes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      },
    ];
    const plan = planBlockBreaks(nodes, { columnWidthPx, baseStyle: BASE, measure: fake });
    expect(plan).not.toBeNull();
    // Non-vacuity: the column is narrow enough that SOMETHING had to break.
    expect(plan?.breakAfterTokens.size).toBeGreaterThan(0);
    // Token 3 is "South", welded to "Africa" by the author's own character.
    expect(plan?.breakAfterTokens.has(3)).toBe(false);
  });

  /*
   * A calibrated rig draws a microgap after every sentence-final token, as
   * `margin-inline-end`, AFTER this plan is made. It is around 17px at ordinary
   * stage sizes against a 2px safety margin, so a planner blind to it plans a
   * line that does not fit, the browser wraps it, and the planned break then
   * strands the word it moved.
   */
  it('leaves room for the sentence microgap the stage will draw', () => {
    /*
     * Short sentences, so the gaps land in the MIDDLE of a line rather than at
     * its end — a gap after a line's last token costs that line nothing, which
     * is correct and also unobservable.
     */
    const nodes = [text('One. Two. Three. Four five six seven')];
    const options = { columnWidthPx: 200, baseStyle: BASE, measure: fake };
    const withoutGap = planBlockBreaks(nodes, options);
    const withGap = planBlockBreaks(nodes, {
      ...options,
      microgapPx: 40,
      microgapTokens: new Set([0, 1, 2]),
    });
    expect(withoutGap).not.toBeNull();
    expect(withGap?.signature).not.toBe(withoutGap?.signature);
  });

  /*
   * An inline cue chip or image occupies width this pass does not measure. A
   * plan made as though it were not there is a plan for a narrower line than
   * the one that gets drawn.
   */
  it('declines a block carrying inline content it cannot measure', () => {
    const nodes: SafeRenderNode[] = [
      text('Some words before the chip and some after it as well'),
      { type: 'cue', cueType: 'beat', label: 'PAUSE' },
    ];
    expect(
      planBlockBreaks(nodes, { columnWidthPx: 200, baseStyle: BASE, measure: fake }),
    ).toBeNull();
  });

  it('gets out of the way when the platform will not measure text', () => {
    const plan = planBlockBreaks([text(SENTENCE)], {
      columnWidthPx: 300,
      baseStyle: BASE,
      measure: refuses,
    });
    expect(plan).toBeNull();
  });

  it('gets out of the way when the column is not a usable width', () => {
    for (const columnWidthPx of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        planBlockBreaks([text(SENTENCE)], { columnWidthPx, baseStyle: BASE, measure: fake }),
      ).toBeNull();
    }
  });

  it('plans no breaks for a block too short to have a second line', () => {
    const plan = planBlockBreaks([text('Hello there')], {
      columnWidthPx: 800,
      baseStyle: BASE,
      measure: fake,
    });
    expect(plan?.breakAfterTokens.size).toBe(0);
  });

  /*
   * The safety property the whole design rests on: a planned line is never
   * wider than the column, so the browser is never asked to re-wrap one.
   */
  it('plans no line wider than the column it was given', () => {
    const words = flattenWords([text(SENTENCE)], BASE);
    const column = 300;
    const plan = planBlockBreaks([text(SENTENCE)], {
      columnWidthPx: column,
      baseStyle: BASE,
      measure: fake,
    });
    let width = 0;
    for (const [i, word] of words.entries()) {
      width += fake(word.text, word.style) ?? 0;
      if (plan?.breakAfterTokens.has(i)) {
        expect(width).toBeLessThanOrEqual(column);
        width = 0;
      } else if (word.spaceAfter) {
        width += fake(' ', word.style) ?? 0;
      }
    }
    expect(width).toBeLessThanOrEqual(column);
  });

  /*
   * Scale invariance is what says the normalisation is right.
   *
   * Two of the solver's constants are costs per unit of width, calibrated in
   * character cells. If the plan were solved in raw pixels they would be
   * multiplied by the width of a character, and a big face and a small one
   * would not merely differ in where the lines fit — they would DISAGREE about
   * whether a short line is worth a clean seam. Same text, same column in
   * characters, same breaks.
   */
  it('plans the same lines at any font size', () => {
    const plans = [4, 10, 37].map((perGlyph) => {
      const measure: AdvanceMeasurer = (t) => (t === ' ' ? perGlyph / 2 : t.length * perGlyph);
      return planBlockBreaks([text(SENTENCE)], {
        // A column of 30 characters, whatever a character costs here.
        columnWidthPx: 30 * perGlyph,
        baseStyle: BASE,
        measure,
      });
    });
    const first = [...(plans[0]?.breakAfterTokens ?? [])];
    expect(first.length).toBeGreaterThan(0);
    for (const plan of plans.slice(1)) {
      expect([...(plan?.breakAfterTokens ?? [])]).toEqual(first);
    }
  });

  it('is deterministic', () => {
    const options = { columnWidthPx: 300, baseStyle: BASE, measure: fake };
    const a = planBlockBreaks([text(SENTENCE)], options);
    const b = planBlockBreaks([text(SENTENCE)], options);
    expect([...(a?.breakAfterTokens ?? [])]).toEqual([...(b?.breakAfterTokens ?? [])]);
    expect(a?.signature).toBe(b?.signature);
  });
});

describe('what it costs to plan', () => {
  /*
   * The plan is recomputed whenever the column, the face or the document
   * changes — which includes every step of a window resize. It is not on the
   * frame path, but it is on a path a presenter can drag, so a whole long
   * script has to plan in well under the time a resize gives it.
   *
   * Measured against the INJECTED measurer, which deliberately bypasses the
   * advance cache: this is the uncached worst case, and the real stage does far
   * less work because ordinary English repeats its words.
   *
   * The budget is loose on purpose. A tight one measures how loaded the machine
   * is when the suites run in parallel, not how fast this is.
   */
  it('plans a five-thousand-word script well inside a resize step', () => {
    const words = 'the quick brown fox jumps over a lazy dog while we ship the new release on Monday'.split(' ');
    const blocks: CompiledBlock[] = [];
    let token = 0;
    for (let b = 0; b < 100; b++) {
      const paragraph: string[] = [];
      for (let i = 0; i < 50; i++) paragraph.push(words[i % words.length] ?? 'word');
      const start = token;
      token += paragraph.length;
      blocks.push(
        paragraph_(paragraph.join(' '), start, `b${b}`),
      );
    }

    const started = performance.now();
    const plan = planScriptBreaks(blocks, {
      columnWidthPx: 620,
      baseStyle: BASE,
      measure: fake,
    });
    const elapsed = performance.now() - started;

    // Every paragraph reaches several lines, so the plan is substantial rather
    // than a few blocks that happened to fit.
    expect(plan.breakAfterTokens.size).toBeGreaterThan(200);
    expect(plan.unplannedBlocks).toBe(0);
    expect(elapsed).toBeLessThan(400);
  });
});

function paragraph_(t: string, tokenStart: number, id: string): CompiledBlock {
  return paragraph([text(t, tokenStart)], id);
}

describe('planning a script', () => {
  it('plans prose and leaves everything else to the browser', () => {
    const blocks: CompiledBlock[] = [
      paragraph([text(SENTENCE)], 'p1'),
      { ...paragraph([text(SENTENCE)], 'code1'), kind: 'code' },
      { ...paragraph([text(SENTENCE)], 'table1'), kind: 'table' },
    ];
    const plan = planScriptBreaks(blocks, {
      columnWidthPx: 300,
      baseStyle: BASE,
      measure: fake,
    });
    expect(plan.breakAfterTokens.size).toBeGreaterThan(0);
    expect(plan.unplannedBlocks).toBe(0);
  });

  /*
   * A block whose rendered geometry this pass cannot reproduce EXACTLY must be
   * left alone. Being wrong here is not the usual benign miss: the planner's
   * break lands, the browser wraps the over-packed line anyway, and the
   * presenter gets a stray short line neither approach would have produced.
   */
  it('does not plan a heading, whose rendered size it cannot know', () => {
    const heading: CompiledBlock = { ...paragraph([text(SENTENCE)], 'h1'), kind: 'heading' };
    const plan = planScriptBreaks([heading], {
      columnWidthPx: 300,
      baseStyle: BASE,
      measure: fake,
    });
    expect(plan.breakAfterTokens.size).toBe(0);
  });

  it('gives a list item a narrower column, because the bullet takes some', () => {
    const asParagraph = planScriptBreaks([paragraph([text(SENTENCE)], 'p')], {
      columnWidthPx: 300,
      baseStyle: BASE,
      measure: fake,
    });
    const asListItem = planScriptBreaks(
      [{ ...paragraph([text(SENTENCE)], 'p'), kind: 'list_item' }],
      { columnWidthPx: 300, baseStyle: BASE, measure: fake },
    );
    // Same words, same column, less room: the plan cannot be the same one.
    expect(asListItem.signature).not.toBe(asParagraph.signature);
    expect(asListItem.breakAfterTokens.size).toBeGreaterThanOrEqual(
      asParagraph.breakAfterTokens.size,
    );
  });

  it('measures a blockquote in the italic it is drawn in', () => {
    const seen: boolean[] = [];
    const watching: AdvanceMeasurer = (t, style) => {
      seen.push(style.italic);
      return fake(t, style);
    };
    planScriptBreaks([{ ...paragraph([text(SENTENCE)], 'q'), kind: 'blockquote' }], {
      columnWidthPx: 300,
      baseStyle: BASE,
      measure: watching,
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
  });

  it('changes its signature when the column changes', () => {
    const blocks = [paragraph([text(SENTENCE)])];
    const wide = planScriptBreaks(blocks, {
      columnWidthPx: 600,
      baseStyle: BASE,
      measure: fake,
    });
    const narrow = planScriptBreaks(blocks, {
      columnWidthPx: 300,
      baseStyle: BASE,
      measure: fake,
    });
    expect(wide.signature).not.toBe(narrow.signature);
  });

  it('counts the blocks it could not plan rather than pretending it planned them', () => {
    const plan = planScriptBreaks([paragraph([text(SENTENCE)])], {
      columnWidthPx: 300,
      baseStyle: BASE,
      measure: refuses,
    });
    expect(plan.unplannedBlocks).toBe(1);
    expect(plan.breakAfterTokens.size).toBe(0);
  });
});
