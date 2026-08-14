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
  snapToStart,
  type SnapInput,
} from '../../../src/control/lib/take-start-point';
import type { OutlineNode, SentenceUnit } from '../../../src/shared/contracts';

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
