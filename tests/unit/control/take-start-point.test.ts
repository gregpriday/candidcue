/**
 * Starting somewhere other than the top (CCUX-014/015/016, CCUX-008).
 *
 * `startTake` wrote `startTokenIndex: 0` on every session while the session
 * record had carried the field since it was written. A creator who fumbled a
 * line six minutes in could read the first six minutes again or navigate after
 * the stage was already live and the camera already rolling.
 *
 * The number is the easy part. What is tested here is the snapping, because an
 * arbitrary token is a bad place to begin: mid-sentence leaves the presenter
 * guessing where to start reading, and it hands the aligner half a clause of
 * context to anchor on.
 */
import { describe, expect, it } from 'vitest';
import {
  beginning,
  continueFrom,
  describeStartPoint,
  flattenOutline,
  lastEndingFor,
  newestEnding,
  snapToStart,
  startPointAtCaret,
  type SnapInput,
} from '../../../src/control/lib/take-start-point';
import type { OutlineNode, SentenceUnit } from '../../../src/shared/contracts';
import { compile } from '../../../src/shared/markdown/compile';

function sentence(id: string, start: number, end: number, text: string): SentenceUnit {
  return {
    id,
    blockId: `b-${id}`,
    startTokenIndex: start,
    endTokenIndex: end,
    normalizedText: text,
    source: { utf16Start: 0, utf16End: 0 },
  };
}

function heading(id: string, title: string, start: number, end: number, children: OutlineNode[] = []): OutlineNode {
  return {
    id,
    level: children.length > 0 ? 1 : 2,
    title,
    normalizedTitle: title.toLowerCase(),
    blockId: `h-${id}`,
    startTokenIndex: start,
    endTokenIndex: end,
    children,
  };
}

/*
 * A small script, with an outline shaped the way the COMPILER shapes one.
 *
 * This matters more than it looks. `compile.ts` gives every outline node the
 * whole section beneath it — `endTokenIndex` runs to the token before the next
 * heading, not to the end of the heading's own words — and widens a parent
 * across its children. An earlier version of this fixture invented narrow
 * heading spans (20–21, 50–51), which is not a shape the compiler can produce,
 * and it hid a resolver bug that collapsed every start point in the product to
 * the top of its section.
 *
 * So: "Opening" spans 0–19, "Pricing" spans 20–49, "Demo" spans 50–60.
 */
const INPUT: SnapInput = {
  sentences: [
    sentence('s1', 0, 9, 'welcome to the product update'),
    sentence('s2', 10, 19, 'today we are covering three things'),
    /*
     * The heading's OWN sentence, at the heading's own start.
     *
     * With `readHeadings` on, a heading is a `singleSentence` block and emits a
     * SentenceUnit beginning at the same token as its outline node. With it off
     * — the default — the heading emits no tokens at all and the next sentence
     * simply starts there. Either way a heading start and a sentence start
     * COINCIDE; the compiler cannot produce a heading whose tokens no sentence
     * covers, which an earlier version of this fixture invented.
     */
    sentence('s3', 20, 21, 'pricing'),
    sentence('s4', 22, 34, 'our pricing changed at the start of the quarter'),
    sentence('s5', 35, 49, 'the standard plan is now thirty dollars a month'),
    sentence('s6', 50, 51, 'demo'),
    sentence('s7', 52, 60, 'let me show you the new dashboard'),
  ],
  outline: [
    heading('h0', 'Opening', 0, 19),
    heading('h1', 'Pricing', 20, 49),
    heading('h2', 'Demo', 50, 60),
  ],
  totalTokens: 61,
};

/**
 * The other shape the compiler really produces: a script with NO headings gets
 * one synthetic node spanning the entire document.
 *
 * Under the old rule this made every request collapse to token 0 — the feature
 * silently did nothing at all for anybody who wrote without headings.
 */
const NO_HEADINGS: SnapInput = {
  sentences: INPUT.sentences,
  outline: [heading('synthetic', '', 0, 60)],
  totalTokens: 61,
};

describe('snapToStart', () => {
  it('treats the top of the document as the beginning', () => {
    expect(snapToStart(0, INPUT)).toEqual(beginning());
    // Negative and non-finite requests are launch-blocking if they propagate.
    expect(snapToStart(-5, INPUT).tokenIndex).toBe(0);
    expect(snapToStart(Number.NaN, INPUT).tokenIndex).toBe(0);
  });

  it('snaps backwards to the start of the sentence you are inside', () => {
    /*
     * BACKWARDS, never forwards. Somebody who put the caret in a line asked to
     * start at that line; snapping forward would silently skip the one line
     * they were most likely trying to include.
     */
    const point = snapToStart(40, INPUT);
    expect(point.tokenIndex).toBe(35);
    expect(point.kind).toBe('sentence');
  });

  it('never lands mid-sentence, wherever in it you point', () => {
    for (let token = 35; token <= 49; token += 1) {
      expect(snapToStart(token, INPUT).tokenIndex, `token ${token}`).toBe(35);
    }
  });

  it('opens at the top of the section when you point at its heading', () => {
    /*
     * The heading start and its sentence start COINCIDE, so which of the two
     * the resolver reports is a labelling question — the token is the same
     * either way, and the token is what the take actually uses. What must hold
     * is that pointing at a heading opens the section rather than dropping into
     * its body.
     */
    const point = snapToStart(20, INPUT);
    expect(point.tokenIndex).toBe(20);
  });

  it('labels a sentence by the section that contains it', () => {
    const point = snapToStart(36, INPUT);
    expect(point.label).toContain('Pricing');
    // A quoted phrase the presenter can recognise, not a token index.
    expect(point.label).toMatch(/standard plan/);
  });

  it('calls the document’s first sentence the beginning', () => {
    // Quoting the opening words back at somebody who did not ask for a section
    // is more confusing than saying "the beginning".
    expect(snapToStart(3, INPUT).kind).toBe('beginning');
  });

  it('snaps to a sentence on a script with no headings at all', () => {
    /*
     * The compiler gives such a script ONE synthetic node spanning everything,
     * so any rule that asks "is the target inside this heading" answers yes
     * everywhere and sends every start point back to token 0.
     */
    const point = snapToStart(40, NO_HEADINGS);
    expect(point.tokenIndex).toBe(35);
    expect(point.kind).toBe('sentence');
  });

  it('is not fooled by a section span that covers the whole section', () => {
    // Token 40 is inside "Pricing" (20–49) and inside sentence s4 (35–49). The
    // sentence is the unit the presenter pointed at.
    const point = snapToStart(40, INPUT);
    expect(point.tokenIndex).toBe(35);
    expect(point.kind).toBe('sentence');
  });

  it('does not fall into the body when pointed inside a heading', () => {
    expect(snapToStart(21, INPUT).tokenIndex).toBe(20);
  });

  it('reports a section when a heading has tokens no sentence covers', () => {
    /*
     * The current compiler always emits a sentence at a heading's start, so
     * this shape does not arise today. It is asserted anyway because the
     * `section` branch exists for it, and a resolver whose only untested branch
     * is the one that handles a future compiler change is a resolver nobody can
     * safely change the compiler around.
     */
    const gapped: SnapInput = {
      sentences: [sentence('a', 0, 9, 'intro line'), sentence('b', 22, 30, 'body line')],
      outline: [heading('h', 'Pricing', 20, 30)],
      totalTokens: 31,
    };
    const point = snapToStart(21, gapped);
    expect(point.kind).toBe('section');
    expect(point.tokenIndex).toBe(20);
    expect(point.label).toBe('Pricing');
  });

  it('clamps a request past the end instead of launching into nothing', () => {
    const point = snapToStart(9999, INPUT);
    expect(point.tokenIndex).toBeLessThan(INPUT.totalTokens);
    expect(point.tokenIndex).toBe(52);
  });

  it('falls back to the beginning for a script with no sentences', () => {
    // An empty or all-cue script must still be launchable. Refusing would leave
    // the caller with nothing to present.
    const empty: SnapInput = { sentences: [], outline: [], totalTokens: 0 };
    expect(snapToStart(12, empty)).toEqual(beginning());
  });
});

describe('flattenOutline', () => {
  it('returns nested headings in document order', () => {
    const nested = [
      heading('a', 'One', 0, 1, [heading('a1', 'One point one', 5, 6)]),
      heading('b', 'Two', 20, 21),
    ];
    expect(flattenOutline(nested).map((n) => n.title)).toEqual(['One', 'One point one', 'Two']);
  });
});

describe('continueFrom', () => {
  it('resumes at the unit containing where the last take stopped', () => {
    const point = continueFrom(40, INPUT);
    expect(point).not.toBeNull();
    expect(point!.tokenIndex).toBe(35);
    // The KIND is what the UI explains, and it is not "a sentence" — it is
    // "where you stopped".
    expect(point!.kind).toBe('last_ending');
  });

  it('offers nothing when there is nothing to continue from', () => {
    // Null rather than the beginning, so the UI hides the action instead of
    // offering one that silently does what Present already does.
    expect(continueFrom(undefined, INPUT)).toBeNull();
    expect(continueFrom(0, INPUT)).toBeNull();
    // A take that ended inside the first sentence has not got anywhere either.
    expect(continueFrom(3, INPUT)).toBeNull();
  });
});

/**
 * #448: a take's ending is a token offset into the source it was performed
 * from. Against any other source the same number names whatever sentence now
 * happens to sit there, so the row is offered only while the source is the one
 * the take was recorded against.
 */
describe('lastEndingFor', () => {
  const ORIGINAL = 'Opening words go here. Repeat this tricky passage. Closing words go here.\n';

  function compiled(source: string) {
    const script = compile(source, { scriptId: 'script-448' });
    return {
      sourceHash: script.sourceHash,
      input: {
        sentences: script.sentences,
        outline: script.outline,
        totalTokens: script.statistics.spokenWordCount,
        blocks: script.blocks,
      } satisfies SnapInput,
    };
  }

  const recorded = compiled(ORIGINAL);
  // Three words into "Repeat this tricky passage." — a take ended mid-sentence.
  const record = { scriptSourceHash: recorded.sourceHash, endTokenIndex: 6 };

  it('offers the recorded passage while the script is unchanged', () => {
    const point = lastEndingFor(record, recorded.sourceHash, recorded.input);
    expect(point).not.toBeNull();
    expect(point!.tokenIndex).toBe(4);
    expect(point!.kind).toBe('last_ending');
    expect(point!.excerpt).toMatch(/^“Repeat this tricky passage/);
    // The launch re-checks this against the compile the stage is built from.
    expect(point!.sourceHash).toBe(recorded.sourceHash);
  });

  it('withholds it after text is inserted before the ending', () => {
    const edited = compiled(`A new introduction first. ${ORIGINAL}`);
    // The bug: the same number now snaps to an unrelated sentence.
    expect(continueFrom(record.endTokenIndex, edited.input)?.excerpt).toMatch(/^“Opening words/);
    expect(lastEndingFor(record, edited.sourceHash, edited.input)).toBeNull();
  });

  it('withholds it when the sentence the take ended in is deleted', () => {
    const edited = compiled('Opening words go here. Closing words go here.\n');
    expect(continueFrom(record.endTokenIndex, edited.input)).not.toBeNull();
    expect(lastEndingFor(record, edited.sourceHash, edited.input)).toBeNull();
  });

  it('offers it again once the edit is undone', () => {
    const edited = compiled(`A new introduction first. ${ORIGINAL}`);
    expect(lastEndingFor(record, edited.sourceHash, edited.input)).toBeNull();
    const undone = compiled(ORIGINAL);
    expect(lastEndingFor(record, undone.sourceHash, undone.input)?.tokenIndex).toBe(4);
  });

  it('resumes from the newest take with an ending, not the newest one that still matches', () => {
    const edited = compiled(`A new introduction first. ${ORIGINAL}`);
    // Newest first, as Rust lists them: an abandoned take with no ending, the
    // last real ending (recorded against the edited text, then edited again —
    // here, against the ORIGINAL), and an older ending against the edited text.
    const records = [
      { scriptSourceHash: edited.sourceHash },
      { scriptSourceHash: edited.sourceHash, endTokenIndex: 0 },
      { scriptSourceHash: recorded.sourceHash, endTokenIndex: 6 },
      { scriptSourceHash: edited.sourceHash, endTokenIndex: 10 },
    ];
    expect(newestEnding(records)).toEqual({ scriptSourceHash: recorded.sourceHash, endTokenIndex: 6 });
    // Against the edited text the last ending is unknown, so nothing is offered —
    // not the older take's ending dressed up as the last one.
    expect(lastEndingFor(newestEnding(records), edited.sourceHash, edited.input)).toBeNull();
    expect(lastEndingFor(newestEnding(records), recorded.sourceHash, recorded.input)?.tokenIndex).toBe(4);
    expect(newestEnding([])).toBeNull();
    expect(newestEnding([{ scriptSourceHash: recorded.sourceHash }])).toBeNull();
  });

  it('offers nothing without a record, an ending, or a compile', () => {
    expect(lastEndingFor(null, recorded.sourceHash, recorded.input)).toBeNull();
    expect(lastEndingFor({ scriptSourceHash: recorded.sourceHash }, recorded.sourceHash, recorded.input)).toBeNull();
    expect(lastEndingFor(record, null, recorded.input)).toBeNull();
    // An empty hash on either side establishes nothing.
    expect(lastEndingFor({ ...record, scriptSourceHash: '' }, '', recorded.input)).toBeNull();
  });
});

describe('describeStartPoint', () => {
  it('always says something, including for the ordinary case', () => {
    // A readout that appeared only when the start was unusual would make the
    // usual case look like a missing readout.
    expect(describeStartPoint(beginning())).toBe('From beginning');
    // A heading start coincides with its own sentence in real compiler output,
    // so this reads as "From here" — the same token, described as the caret
    // position it is. The section wording is exercised on the gapped shape.
    expect(describeStartPoint(snapToStart(20, INPUT))).toBe('From here');
    expect(describeStartPoint(continueFrom(40, INPUT)!)).toBe('From last ending');
    expect(describeStartPoint(snapToStart(40, INPUT))).toBe('From here');
  });
});

describe('startPointAtCaret (#241)', () => {
  const source = [
    '# Opening',
    '',
    'Hello there everyone. Welcome back to the show.',
    '',
    '# Pricing',
    '',
    'Raise prices now. Then raise them again.',
    '',
  ].join('\n');
  const script = compile(source, { scriptId: 'script-241' });
  const input: SnapInput = {
    sentences: script.sentences,
    outline: script.outline,
    totalTokens: script.statistics.spokenWordCount,
    blocks: script.blocks,
  };
  const pricingFirst = script.sentences.find((s) =>
    s.normalizedText.startsWith('raise prices'),
  )!;

  it('starts the section when the caret is on its heading, as an outline click leaves it', () => {
    // Before #241 this resolved to the last sentence ABOVE the heading —
    // "Welcome back…", in the previous section.
    for (const offset of [source.indexOf('# Pricing'), source.indexOf('Pricing') + 3]) {
      const point = startPointAtCaret(offset, input)!;
      expect(point.tokenIndex).toBe(pricingFirst.startTokenIndex);
      // Quoted as the section's first sentence, which is what the menu shows.
      expect(point.excerpt).toMatch(/^“Raise prices now/);
    }
  });

  it('still uses the sentence at or before the caret in body text', () => {
    const point = startPointAtCaret(source.indexOf('Then raise'), input)!;
    expect(point.tokenIndex).toBe(
      script.sentences.find((s) => s.normalizedText.startsWith('then raise'))!.startTokenIndex,
    );
    expect(point.kind).toBe('sentence');
  });

  it('treats the first heading as the beginning', () => {
    expect(startPointAtCaret(0, input)).toEqual(beginning());
  });

  it('treats a caret above the first sentence as the beginning, as the Opening row leaves it', () => {
    const opening = '\nIntro words come first. Then more.\n\n# Pricing\n\nRaise prices now.\n';
    const compiled = compile(opening, { scriptId: 'script-241c' });
    expect(
      startPointAtCaret(0, {
        sentences: compiled.sentences,
        outline: compiled.outline,
        totalTokens: compiled.statistics.spokenWordCount,
        blocks: compiled.blocks,
      }),
    ).toEqual(beginning());
  });

  it('offers nothing without a compile', () => {
    expect(startPointAtCaret(5, { sentences: [], outline: [], totalTokens: 0 })).toBeNull();
  });

  it('falls back to the body rule for a trailing heading with nothing spoken after it', () => {
    const trailing = `${source}\n# Afterword\n`;
    const compiled = compile(trailing, { scriptId: 'script-241b' });
    const point = startPointAtCaret(trailing.indexOf('# Afterword'), {
      sentences: compiled.sentences,
      outline: compiled.outline,
      totalTokens: compiled.statistics.spokenWordCount,
      blocks: compiled.blocks,
    })!;
    expect(point.tokenIndex).toBe(
      compiled.sentences.find((s) => s.normalizedText.startsWith('then raise'))!.startTokenIndex,
    );
  });
});
