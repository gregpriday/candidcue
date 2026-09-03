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
import {
  EMPTY_WRAP_PLAN,
  MIN_PLANNED_COLUMN_CHARS,
  planBlockBreaks,
  planScriptBreaks,
} from './wrap-plan';
import { compile } from '../../shared/markdown/compile';
import { FONT_METRICS_PROSE_SAMPLE } from './fontMetrics';
import { bestOf, budgetMessage } from '../../shared/perf-budget';

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

  /*
   * The failure this replaced, and the reason `wordTokens` exists.
   *
   * An em dash between spaces is a WORD on the glass and no token in the
   * stream, so `tokenIndexes` is one short of the words and the misaligned rule
   * above then gave up on the whole paragraph: one anchor on its first word and
   * nothing after it. Every later word became unbreakable — a break is keyed by
   * token index — so the solver's only legal break in a four-line paragraph was
   * after its FIRST word, which is exactly what reached the glass.
   */
  it('keeps every spoken word anchored around a word that is written, not spoken', () => {
    const words = flattenWords(
      [
        {
          type: 'text',
          text: 'pause in the middle of this one — like that',
          tokenIndexes: [40, 41, 42, 43, 44, 45, 46, 47, 48],
          wordTokens: [40, 41, 42, 43, 44, 45, 46, null, 47, 48],
        },
      ],
      BASE,
    );
    expect(words.map((w) => w.tokenIndex)).toEqual([40, 41, 42, 43, 44, 45, 46, null, 47, 48]);
    // The unspoken word is the only one a line may not end on: there is no
    // index to key its break to.
    expect(words.filter((w) => w.spaceAfter && !w.breakableAfter)).toHaveLength(0);
  });

  it('breaks a paragraph at its phrase seams even when it contains an em dash', () => {
    const node: SafeRenderNode = {
      type: 'text',
      text: 'Now try slowing right down for a sentence or two, and put a real pause in the middle of this one — like that.',
      // 24 words on the glass, 23 of them spoken: the em dash is written only.
      tokenIndexes: Array.from({ length: 23 }, (_, i) => i),
      wordTokens: [...Array.from({ length: 21 }, (_, i) => i), null, 21, 22],
    };
    const plan = planBlockBreaks([node], { columnWidthPx: 520, baseStyle: BASE, measure: fake });
    expect(plan).not.toBeNull();
    // Not one stranded break after the first word.
    expect([...plan!.breakAfterTokens]).not.toEqual([0]);
    expect(plan!.lineCount).toBeGreaterThan(2);
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

  /*
   * Inline code renders at `max(var(--stage-secondary-min), 0.92em)` and only
   * the 0.92em arm is mirrored in `advance.ts`, so on a rig sitting on the
   * optical resolver's angular floor the run is wider than it measures.
   */
  it('declines a block carrying an inline code run', () => {
    const nodes: SafeRenderNode[] = [
      text('Run the command '),
      { type: 'text', text: 'pnpm tauri dev', marks: ['code'], tokenIndexes: [3, 4, 5] },
      text(' before anything else at all', 6),
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

    /*
     * Fastest of several runs — see `bestOf`. Note this now times a WARMED
     * call where it used to time the first one, so it is a budget on the solve
     * rather than on first-plan latency; the old form measured whichever the
     * machine felt like giving it.
     */
    const run = bestOf(() =>
      planScriptBreaks(blocks, {
        columnWidthPx: 620,
        baseStyle: BASE,
        measure: fake,
      }),
    );
    const plan = run.value;

    // Every paragraph reaches several lines, so the plan is substantial rather
    // than a few blocks that happened to fit.
    expect(plan.breakAfterTokens.size).toBeGreaterThan(200);
    expect(plan.unplannedBlocks).toBe(0);
    expect(run.elapsedMs, budgetMessage('whole-script wrap plan', run, 400)).toBeLessThan(400);
  });
});

function paragraph_(t: string, tokenStart: number, id: string): CompiledBlock {
  return paragraph([text(t, tokenStart)], id);
}

describe('planning a script', () => {
  /*
   * Against the real compiler rather than a hand-built node, because the bug
   * this pins lived in the disagreement between the two: every fixture in this
   * file gives one token to one word, which is the one case where the mapping
   * cannot be wrong. Real prose has an em dash in it.
   */
  it('plans a compiled paragraph containing a written-but-unspoken word', () => {
    const script = compile(
      'Now try slowing right down for a sentence or two, and put a real pause in the middle of this one — like that. The text should ease off and wait for you.',
      { scriptId: 'wrap-plan-test' },
    );
    const plan = planScriptBreaks(script.blocks, {
      columnWidthPx: 490,
      baseStyle: BASE,
      measure: fake,
    });
    const breaks = [...plan.breakAfterTokens].sort((a, b) => a - b);
    expect(plan.unplannedBlocks).toBe(0);
    // The stranded-first-word plan: one break, on the block's opening token.
    expect(breaks).not.toEqual([script.blocks[0]!.startTokenIndex]);
    expect(breaks.length).toBeGreaterThan(2);
  });

  it('plans prose and leaves everything else to the browser', () => {
    const blocks: CompiledBlock[] = [
      paragraph([text(SENTENCE)], 'p1'),
      { ...paragraph([text(SENTENCE)], 'code1'), kind: 'code' },
      { ...paragraph([text(SENTENCE)], 'table1'), kind: 'table' },
    ];
    const plan = planScriptBreaks(blocks, {
      columnWidthPx: 500,
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
      columnWidthPx: 500,
      baseStyle: BASE,
      measure: fake,
    });
    expect(plan.breakAfterTokens.size).toBe(0);
  });

  it('gives a list item a narrower column, because the bullet takes some', () => {
    const asParagraph = planScriptBreaks([paragraph([text(SENTENCE)], 'p')], {
      columnWidthPx: 500,
      baseStyle: BASE,
      measure: fake,
    });
    const asListItem = planScriptBreaks(
      [{ ...paragraph([text(SENTENCE)], 'p'), kind: 'list_item' }],
      { columnWidthPx: 500, baseStyle: BASE, measure: fake },
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
      // The column gate measures the prose sample in the base face first;
      // it is the block's own words that have to be italic.
      if (t !== FONT_METRICS_PROSE_SAMPLE) seen.push(style.italic);
      return fake(t, style);
    };
    planScriptBreaks([{ ...paragraph([text(SENTENCE)], 'q'), kind: 'blockquote' }], {
      columnWidthPx: 500,
      baseStyle: BASE,
      measure: watching,
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
  });

  it('changes its signature when the column changes', () => {
    const blocks = [paragraph([text(SENTENCE)])];
    const wide = planScriptBreaks(blocks, {
      columnWidthPx: 900,
      baseStyle: BASE,
      measure: fake,
    });
    const narrow = planScriptBreaks(blocks, {
      columnWidthPx: 500,
      baseStyle: BASE,
      measure: fake,
    });
    expect(wide.signature).not.toBe(narrow.signature);
  });

  /*
   * The 9-inch Prompter resolves to 25-30 characters, and on that column the
   * planned wrap read as three-word lines and a sweep every breath. Below the
   * measure the model was tuned at, the whole script is the browser's.
   */
  describe('a column too narrow to plan', () => {
    // The fake measures every glyph at 10px, so the gate in pixels is the
    // character gate times ten, plus the planner's 2px safety margin.
    const atGate = MIN_PLANNED_COLUMN_CHARS * 10 + 2;

    it('is left to the browser whole', () => {
      const plan = planScriptBreaks([paragraph([text(SENTENCE)])], {
        columnWidthPx: 300,
        baseStyle: BASE,
        measure: fake,
      });
      expect(plan.breakAfterTokens.size).toBe(0);
      // Not a failure to plan: nothing was attempted.
      expect(plan.unplannedBlocks).toBe(0);
      expect(plan.signature).toBe('narrow');
    });

    it('is planned from exactly the column the model was tuned at', () => {
      const blocks = [paragraph([text(SENTENCE)])];
      const at = planScriptBreaks(blocks, { columnWidthPx: atGate, baseStyle: BASE, measure: fake });
      const under = planScriptBreaks(blocks, {
        columnWidthPx: atGate - 1,
        baseStyle: BASE,
        measure: fake,
      });
      expect(at.breakAfterTokens.size).toBeGreaterThan(0);
      expect(under.signature).toBe('narrow');
    });

    it('is not the same layout as the feature being off', () => {
      // Both draw no breaks; the fingerprint still has to tell them apart, or
      // toggling the setting on a narrow column would not be a layout change.
      const plan = planScriptBreaks([paragraph([text(SENTENCE)])], {
        columnWidthPx: 300,
        baseStyle: BASE,
        measure: fake,
      });
      expect(plan.signature).not.toBe(EMPTY_WRAP_PLAN.signature);
    });

    it('still reports an unmeasurable platform as unplanned, not as narrow', () => {
      const plan = planScriptBreaks([paragraph([text(SENTENCE)])], {
        columnWidthPx: 300,
        baseStyle: BASE,
        measure: refuses,
      });
      expect(plan.signature).not.toBe('narrow');
      expect(plan.unplannedBlocks).toBe(1);
    });
  });

  it('counts the blocks it could not plan rather than pretending it planned them', () => {
    const plan = planScriptBreaks([paragraph([text(SENTENCE)])], {
      columnWidthPx: 500,
      baseStyle: BASE,
      measure: refuses,
    });
    expect(plan.unplannedBlocks).toBe(1);
    expect(plan.breakAfterTokens.size).toBe(0);
  });
});
