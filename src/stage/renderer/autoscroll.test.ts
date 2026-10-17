import { describe, expect, it } from 'vitest';
import type { RenderedLine } from '../../shared/contracts';
import {
  AUTO_SCROLL_DEFAULT_WPM,
  AUTO_SCROLL_MAX_FRAME_MS,
  AUTO_SCROLL_MAX_WPM,
  AUTO_SCROLL_MIN_WPM,
  advanceAutoScrollTarget,
  autoScrollAtEnd,
  autoScrollNowhereToGo,
  autoScrollPxPerSecond,
  clampAutoScrollWpm,
  measureAutoScrollScale,
} from './autoscroll';

/**
 * A rendered line carrying only what the scale measurement reads. Everything
 * else on `RenderedLine` describes geometry this module has no opinion about.
 */
function line(firstTokenIndex: number, baselineY: number): RenderedLine {
  return {
    lineId: `L${firstTokenIndex}`,
    blockId: 'b1',
    sectionId: 's1',
    firstTokenIndex,
    lastTokenIndex: firstTokenIndex + 7,
    spokenUnitStart: firstTokenIndex,
    spokenUnitEnd: firstTokenIndex + 8,
    topY: baselineY - 40,
    baselineY,
    bottomY: baselineY + 12,
    nextBaselineY: null,
    visibleTextWidthPx: 900,
    tokenStops: [],
    startsParagraph: false,
    endsParagraph: false,
    startsSection: false,
    endsSection: false,
  };
}

describe('measureAutoScrollScale', () => {
  it('measures pixels per word between the two baselines', () => {
    // Eight words per line, 64 px of pitch: 8 px of travel buys one word.
    const scale = measureAutoScrollScale([line(0, 100), line(8, 164), line(16, 228)]);
    expect(scale?.pxPerWord).toBeCloseTo(8, 6);
  });

  it('charges only for the lines the document has moved PAST', () => {
    /*
     * Baseline-to-baseline and word count have to describe the same journey.
     * Counting the last line's own words as well would report the script as
     * denser than it is, and the document would then roll too slowly for the
     * pace on the dial.
     */
    const scale = measureAutoScrollScale([line(0, 0), line(10, 50)]);
    expect(scale?.pxPerWord).toBeCloseTo(5, 6);
    expect(scale?.sampledWords).toBe(10);
  });

  it('refuses to answer from one line, or from none', () => {
    expect(measureAutoScrollScale([])).toBeNull();
    expect(measureAutoScrollScale([line(0, 100)])).toBeNull();
  });

  it('refuses a span with no height, or one that runs backwards', () => {
    // A map measured before layout settled, or one built from a stale plane.
    expect(measureAutoScrollScale([line(0, 100), line(8, 100)])).toBeNull();
    expect(measureAutoScrollScale([line(0, 200), line(8, 100)])).toBeNull();
  });

  it('refuses a span whose token indices do not advance', () => {
    expect(measureAutoScrollScale([line(8, 100), line(8, 164)])).toBeNull();
    expect(measureAutoScrollScale([line(16, 100), line(8, 164)])).toBeNull();
  });
});

/** A line in a named block — the wordless correction is all about block edges. */
function lineIn(blockId: string, firstTokenIndex: number, baselineY: number): RenderedLine {
  return { ...line(firstTokenIndex, baselineY), blockId };
}

function box(blockId: string, topY: number, bottomY: number) {
  return { blockId, topY, bottomY };
}

/**
 * The script from #278: twenty lines 60 px apart, eight words on each, and an
 * image of `imagePx` between the tenth and the eleventh. Paragraph spacing is
 * left at zero so the arithmetic is the issue's arithmetic.
 */
function scriptWithImage(imagePx: number) {
  const lines: RenderedLine[] = [];
  let y = 100;
  for (let i = 0; i < 20; i++) {
    if (i === 10) y += imagePx;
    lines.push(lineIn(i < 10 ? 'p1' : 'p2', i * 8, y));
    y += 60;
  }
  const tenth = lines[9]!;
  const eleventh = lines[10]!;
  const blocks = [
    box('p1', lines[0]!.topY, tenth.bottomY),
    box('image', tenth.bottomY + 4, tenth.bottomY + 4 + imagePx),
    box('p2', eleventh.topY, lines[19]!.bottomY),
  ];
  return { lines, blocks };
}

/**
 * What a pace on the dial actually reads at over the fixture's text, whose own
 * density is 60 px of pitch over eight words — 7.5 px a word.
 */
function paceOverText(wordsPerMinute: number, scale: ReturnType<typeof measureAutoScrollScale>) {
  return (autoScrollPxPerSecond(wordsPerMinute, scale) / 7.5) * 60;
}

describe('measureAutoScrollScale over a script with things in it that are not words', () => {
  it('rolls the text at the pace on the dial when the script has an image in it (#278)', () => {
    const { lines, blocks } = scriptWithImage(600);
    const scale = measureAutoScrollScale(lines, blocks);

    expect(scale?.pxPerWord).toBeCloseTo(7.5, 6);
    expect(scale?.sampledWords).toBe(152);
    expect(paceOverText(130, scale)).toBeCloseTo(130, 6);
  });

  it('is the bug without the block boxes, which is what makes it the fix', () => {
    // The same lines measured the old way: the image's 600 px are charged to
    // the words, and the text runs at nearly 200 wpm.
    const { lines } = scriptWithImage(600);
    expect(paceOverText(130, measureAutoScrollScale(lines))).toBeGreaterThan(198);
  });

  it('does not care how tall the image is', () => {
    for (const imagePx of [40, 300, 600, 2400]) {
      const { lines, blocks } = scriptWithImage(imagePx);
      expect(measureAutoScrollScale(lines, blocks)?.pxPerWord).toBeCloseTo(7.5, 6);
    }
  });

  it('measures a script with nothing wordless in it exactly as before', () => {
    // Two paragraphs, back to back. Every block has lines, so nothing comes
    // out, and the answer is the plain baseline ratio to the last digit.
    const lines = [lineIn('p1', 0, 100), lineIn('p1', 8, 164), lineIn('p2', 16, 260), lineIn('p2', 24, 324)];
    const blocks = [box('p1', 60, 176), box('p2', 220, 336)];
    expect(measureAutoScrollScale(lines, blocks)).toEqual(measureAutoScrollScale(lines));
  });

  it('takes out every wordless block between two lines, and the margins between them', () => {
    // A cue chip, a table and a silent block in a row. The spacing between
    // them is as wordless as they are.
    const lines = [lineIn('p1', 0, 100), lineIn('p1', 8, 160), lineIn('p2', 16, 1000), lineIn('p2', 24, 1060)];
    const blocks = [
      box('p1', 60, 172),
      box('cue', 200, 230),
      box('table', 260, 700),
      box('silent', 740, 940),
      box('p2', 960, 1072),
    ];
    // 960 px of span, 740 of it from the top of the cue to the bottom of the
    // silent block: 220 px of travel for 24 words.
    expect(measureAutoScrollScale(lines, blocks)?.pxPerWord).toBeCloseTo(220 / 24, 6);
  });

  it('takes out a wordless block too small for any gap threshold to notice', () => {
    // A one-line cue between paragraphs is a few dozen pixels — nothing a
    // geometry heuristic would flag, and still height with nothing to read.
    const lines = [lineIn('p1', 0, 100), lineIn('p2', 8, 200), lineIn('p2', 16, 260)];
    const blocks = [box('p1', 60, 112), box('cue', 120, 150), box('p2', 160, 272)];
    expect(measureAutoScrollScale(lines, blocks)?.pxPerWord).toBeCloseTo((160 - 30) / 16, 6);
  });

  it('leaves alone a block whose words are read, whatever kind of block it is', () => {
    // An image with its alt text read aloud produces a line, and a line is
    // words: nothing about it is wordless.
    const lines = [lineIn('p1', 0, 100), lineIn('image', 8, 400), lineIn('p2', 12, 700)];
    const blocks = [box('p1', 60, 112), box('image', 150, 650), box('p2', 660, 712)];
    expect(measureAutoScrollScale(lines, blocks)).toEqual(measureAutoScrollScale(lines));
  });

  it('removes nothing outside the span the lines measure', () => {
    // An image above the first line or below the last is not between any two
    // words the span counts, so it is not in the span to begin with.
    const { lines, blocks } = scriptWithImage(600);
    const framed = [box('lead', 0, 50), ...blocks, box('tail', 2000, 2600)];
    expect(measureAutoScrollScale(lines, framed)?.pxPerWord).toBeCloseTo(7.5, 6);
  });

  it('never lets a box that measured oddly eat into the lines either side of it', () => {
    // A wordless box claiming to overlap both lines. Only the space BETWEEN
    // them comes out, so the step keeps the descent of one line and the ascent
    // of the next.
    const lines = [lineIn('p1', 0, 100), lineIn('p2', 8, 800), lineIn('p2', 16, 860)];
    const blocks = [box('p1', 60, 112), box('image', 0, 2000), box('p2', 760, 872)];
    const removed = 760 - 112;
    expect(measureAutoScrollScale(lines, blocks)?.pxPerWord).toBeCloseTo((760 - removed) / 16, 6);
  });

  it('counts a step as text when it cannot measure what is in it', () => {
    const { lines } = scriptWithImage(600);
    const plain = measureAutoScrollScale(lines);
    // Lines whose blocks were never measured, and a box with no usable rect.
    expect(measureAutoScrollScale(lines, [box('elsewhere', 0, 9000)])).toEqual(plain);
    expect(
      measureAutoScrollScale(lines, [box('p1', 0, 652), box('image', Number.NaN, 1256), box('p2', 1260, 2000)]),
    ).toEqual(plain);
    expect(
      measureAutoScrollScale(lines, [box('p1', 0, 652), box('image', 1256, 656), box('p2', 1260, 2000)]),
    ).toEqual(plain);
  });

  it('still refuses what it refused before', () => {
    const blocks = [box('b1', 0, 1000)];
    expect(measureAutoScrollScale([], blocks)).toBeNull();
    expect(measureAutoScrollScale([line(0, 100)], blocks)).toBeNull();
    expect(measureAutoScrollScale([line(0, 200), line(8, 100)], blocks)).toBeNull();
    expect(measureAutoScrollScale([line(8, 100), line(8, 164)], blocks)).toBeNull();
  });
});

describe('autoScrollPxPerSecond', () => {
  it('converts a pace into a pixel rate', () => {
    // 120 wpm is two words a second; at 8 px a word that is 16 px/s.
    expect(autoScrollPxPerSecond(120, { pxPerWord: 8, sampledWords: 40 })).toBeCloseTo(16, 6);
  });

  it('is zero without a scale, which is a full stop and not an error', () => {
    expect(autoScrollPxPerSecond(120, null)).toBe(0);
  });

  it('is zero for a pace or a scale that cannot mean anything', () => {
    expect(autoScrollPxPerSecond(0, { pxPerWord: 8, sampledWords: 40 })).toBe(0);
    expect(autoScrollPxPerSecond(-120, { pxPerWord: 8, sampledWords: 40 })).toBe(0);
    expect(autoScrollPxPerSecond(Number.NaN, { pxPerWord: 8, sampledWords: 40 })).toBe(0);
    expect(autoScrollPxPerSecond(120, { pxPerWord: 0, sampledWords: 40 })).toBe(0);
    expect(autoScrollPxPerSecond(120, { pxPerWord: Number.NaN, sampledWords: 40 })).toBe(0);
  });
});

describe('clampAutoScrollWpm', () => {
  it('holds the offered range', () => {
    expect(clampAutoScrollWpm(AUTO_SCROLL_MIN_WPM - 40)).toBe(AUTO_SCROLL_MIN_WPM);
    expect(clampAutoScrollWpm(AUTO_SCROLL_MAX_WPM + 40)).toBe(AUTO_SCROLL_MAX_WPM);
    expect(clampAutoScrollWpm(150)).toBe(150);
  });

  it('answers the default for a value that is not a number at all', () => {
    // The pace crosses a window boundary as JSON; a null arrives as NaN here.
    expect(clampAutoScrollWpm(Number.NaN)).toBe(AUTO_SCROLL_DEFAULT_WPM);
    expect(clampAutoScrollWpm(Number.POSITIVE_INFINITY)).toBe(AUTO_SCROLL_DEFAULT_WPM);
  });
});

describe('advanceAutoScrollTarget', () => {
  const base = { targetPx: 100, pxPerSecond: 100, dtMs: 100, maxScrollPx: 10_000 };

  it('advances by the rate over the elapsed time', () => {
    expect(advanceAutoScrollTarget(base)).toBeCloseTo(110, 6);
    expect(advanceAutoScrollTarget({ ...base, dtMs: 50 })).toBeCloseTo(105, 6);
  });

  it('caps the frame delta so a stall cannot lurch the script', () => {
    /*
     * An occluded window, a swapped-out machine or a paused debugger returns a
     * delta in seconds. Integrating it whole would move the target a page down
     * the script in one frame — while nobody was looking at it.
     */
    const stalled = advanceAutoScrollTarget({ ...base, dtMs: 4000 });
    const capped = advanceAutoScrollTarget({ ...base, dtMs: AUTO_SCROLL_MAX_FRAME_MS });
    expect(stalled).toBe(capped);
    expect(stalled).toBeCloseTo(110, 6);
  });

  it('stops at the end of the document', () => {
    expect(advanceAutoScrollTarget({ ...base, targetPx: 9995, maxScrollPx: 10_000 })).toBe(10_000);
  });

  it('does not move on a zero or negative rate', () => {
    expect(advanceAutoScrollTarget({ ...base, pxPerSecond: 0 })).toBe(100);
    expect(advanceAutoScrollTarget({ ...base, pxPerSecond: -20 })).toBe(100);
  });

  it('does not move on a zero, negative or absent frame delta', () => {
    // The first frame after starting has no previous timestamp to subtract.
    expect(advanceAutoScrollTarget({ ...base, dtMs: 0 })).toBe(100);
    expect(advanceAutoScrollTarget({ ...base, dtMs: -16 })).toBe(100);
    expect(advanceAutoScrollTarget({ ...base, dtMs: Number.NaN })).toBe(100);
  });

  it('pulls a target that is already outside the document back inside it', () => {
    // A relayout can shrink the document under a target that was legal before.
    expect(advanceAutoScrollTarget({ ...base, targetPx: 50_000 })).toBe(10_000);
    expect(advanceAutoScrollTarget({ ...base, targetPx: -400 })).toBeCloseTo(10, 6);
  });

  it('holds at zero when there is nothing to scroll', () => {
    expect(advanceAutoScrollTarget({ ...base, maxScrollPx: 0 })).toBe(0);
  });
});

describe('autoScrollAtEnd', () => {
  it('is true within a pixel of the bottom, because the target is fractional', () => {
    expect(autoScrollAtEnd(9999.4, 10_000)).toBe(true);
    expect(autoScrollAtEnd(10_000, 10_000)).toBe(true);
    expect(autoScrollAtEnd(9800, 10_000)).toBe(false);
  });

  it('is true for a document with nowhere to go', () => {
    // A script shorter than the viewport. Reaching the end is not a fault.
    expect(autoScrollAtEnd(0, 0)).toBe(true);
  });

  it('is false rather than true when the numbers are unusable', () => {
    // Standing the transport down on a measurement that never arrived would
    // read to the operator as the feature refusing to start.
    expect(autoScrollAtEnd(Number.NaN, 10_000)).toBe(false);
    expect(autoScrollAtEnd(100, Number.NaN)).toBe(false);
  });
});

/**
 * The guard that decides whether the transport has anything to do at all.
 *
 * The case worth naming is the empty script, because the obvious test for it is
 * wrong. A blank document is not a zero scroll range: the stage's own padding is
 * a viewport plus the reserved future lines, so it is a couple of hundred pixels
 * TALLER than the glass. Everything that keyed the end of the roll on the range
 * therefore skipped it, and — with `emptyRenderedLineMap` hard-coding
 * `valid: false` — it fell to the map guard below and stayed there: the
 * transport running, `onautoscrollend` never fired, voice following paused for
 * the rest of a take that could not move a pixel. New scripts start empty, so
 * that is the FIRST thing a new script does.
 */
describe('autoScrollNowhereToGo', () => {
  it('is true for a document with words but no room to move', () => {
    expect(autoScrollNowhereToGo({ documentTokenCount: 400, maxScrollPx: 0 })).toBe(true);
    expect(autoScrollNowhereToGo({ documentTokenCount: 400, maxScrollPx: -12 })).toBe(true);
  });

  it('is true for an empty script even though its padding leaves room to move', () => {
    // The regression. ~150-200px of pure padding is the realistic range for a
    // blank document, and it is positive on every rig.
    expect(autoScrollNowhereToGo({ documentTokenCount: 0, maxScrollPx: 180 })).toBe(true);
  });

  it('is false for an ordinary script that has both words and room', () => {
    expect(autoScrollNowhereToGo({ documentTokenCount: 400, maxScrollPx: 10_000 })).toBe(false);
  });

  it('does not end the roll on a scroll range that is not a number', () => {
    // A rebuild mid-flight, not a finished script. Announcing an end here would
    // stand a running transport down over a measurement about to arrive.
    expect(autoScrollNowhereToGo({ documentTokenCount: 400, maxScrollPx: Number.NaN })).toBe(false);
  });
});
