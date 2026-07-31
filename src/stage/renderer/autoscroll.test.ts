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
