/**
 * Does the reading mark point at the line the presenter is reading?
 * (companion §8, §8.8, §16.3)
 *
 * The mark is fixed on the glass and the document moves under it, so this is a
 * property of the PHASE between the two: over the traversal of one line, how
 * much of the time does the mark fall on that line rather than on its
 * neighbour?
 *
 * With `R` set to the mark — the line-entry position and the mark treated as one
 * number — the answer was 15% on the line being read and 60% on the FOLLOWING
 * line, because §8's path puts a line at `R` when it STARTS and lets it rise a
 * full pitch while it is read. A presenter reads that as the script sitting
 * permanently one line behind them.
 *
 * `lineEntryOffsetPx` is the correction, and this file is the guard on it.
 */
import { describe, it, expect } from 'vitest';
import { buildRenderedLineMap, type StageRenderedLineMap } from '../../../src/stage/motion';
import { lineEntryOffsetPx } from '../../../src/stage/renderer/geometry';
import { fixtureFingerprint, syntheticLayout } from '../../fixtures/layout';

/** Where the ticks are drawn, CSS px from the top of the glass. */
const MARK_PX = 400;
const PITCH_PX = 64;
/**
 * One cap height on this fixture's type. The synthetic layout models an ink box
 * (0.75 x pitch) rather than a font, so this stands in for what
 * `fontMetrics.capHeightRatio` measures on a real face.
 */
const CAP_PX = 30;
const OFFSET_PX = lineEntryOffsetPx(PITCH_PX, CAP_PX);

/**
 * The document as the stage lays it out: `R` below the mark by the line-entry
 * offset, and the top padding carrying the same offset so the knots — and
 * therefore the motion — are unchanged by it.
 */
const VIEWPORT_PX = 1080;
/**
 * Deliberately mean, so the closing lines are MAX-SCROLL CLAMPED.
 *
 * That is the one place the offset does not simply cancel: the raw knot
 * `baselineY - R` is unchanged, but the ceiling it is clamped against is
 * `totalHeight - viewportHeight`, and the top padding grew. A test that hands
 * the builder a generous `maxScrollPx` never reaches the clamp and would call
 * the tail unchanged without having looked at it.
 */
const PAD_BOTTOM_PX = 0;

function stageMap(readingLineStartY: number, padTopPx: number) {
  const layout = syntheticLayout({
    blocks: [
      { kind: 'heading', tokens: 4 },
      { kind: 'paragraph', tokens: 80 },
      { kind: 'paragraph', tokens: 80 },
    ],
    columnWidthPx: 800,
    lineHeightPx: PITCH_PX,
    startY: padTopPx,
  });
  // Production's bound, not the content height: the plane is `inset: 0` and
  // scrolls to `totalHeight - vh`, and `totalHeight` is padding-inclusive.
  const maxScrollPx = layout.contentHeightPx + PAD_BOTTOM_PX - VIEWPORT_PX;
  const map = buildRenderedLineMap({
    fingerprint: fixtureFingerprint({ layoutGeneration: 1 }),
    tokens: layout.tokens,
    blocks: layout.blocks,
    readingLineStartY,
    lineHeightPx: layout.lineHeightPx,
    viewportHeightPx: VIEWPORT_PX,
    maxScrollPx,
  });
  // The bound travels with the map: it is not on the built object, and every
  // tail assertion here is about the relationship between the two.
  return { map, maxScrollPx };
}

/** The stage as it ships: mark at `MARK_PX`, entry one offset below it. */
function alignedMap() {
  return stageMap(MARK_PX + OFFSET_PX, MARK_PX - PITCH_PX / 2 + OFFSET_PX);
}

/** The stage before the offset existed: `R` and the mark the same number. */
function unalignedMap() {
  return stageMap(MARK_PX, MARK_PX - PITCH_PX / 2);
}

/**
 * Walk one line at a steady reading pace and ask, at each step, which line the
 * mark is sitting on.
 */
function markResidency(map: StageRenderedLineMap, lineIndex: number, steps = 40) {
  const line = map.lines[lineIndex];
  const next = map.lines[lineIndex + 1];
  if (!line || !next) throw new Error('fixture needs two more lines');
  let onCurrent = 0;
  let onNext = 0;
  for (let i = 0; i < steps; i++) {
    const p = i / steps;
    const unit = line.spokenUnitStart + p * (line.spokenUnitEnd - line.spokenUnitStart);
    const scrollPx = map.sampleMotionPath(unit)?.scrollPx ?? 0;
    if (MARK_PX >= line.topY - scrollPx && MARK_PX <= line.bottomY - scrollPx) onCurrent++;
    if (MARK_PX >= next.topY - scrollPx && MARK_PX <= next.bottomY - scrollPx) onNext++;
  }
  return { onCurrent: onCurrent / steps, onNext: onNext / steps };
}

/** Averaged over lines, so one lucky line break cannot carry the result. */
function residencyOverScript(map: StageRenderedLineMap) {
  const indices = [4, 6, 8, 10, 12, 14];
  const samples = indices.map((i) => markResidency(map, i));
  return {
    onCurrent: samples.reduce((sum, s) => sum + s.onCurrent, 0) / samples.length,
    onNext: samples.reduce((sum, s) => sum + s.onNext, 0) / samples.length,
  };
}

describe('the reading mark and the line being read (§8.8)', () => {
  it('sits on the line being read for most of that line', () => {
    const { onCurrent, onNext } = residencyOverScript(alignedMap().map);
    /*
     * The ceiling for this fixture is 0.75: its ink box is three quarters of a
     * pitch, so a mark centred on the traversal is outside the letters for the
     * quarter-pitch at each end however well it is phased. Real type measures
     * closer to 0.88 of a pitch through `Range.getClientRects`, so the stage
     * does better than the fixture can.
     */
    expect(onCurrent).toBeGreaterThan(0.65);
    // And essentially never on the line below, which is the specific complaint:
    // a mark one line ahead reads as a script that is one line behind.
    expect(onNext).toBeLessThan(0.05);
  });

  it('is a large improvement on treating `R` and the mark as one number', () => {
    const before = residencyOverScript(unalignedMap().map);
    const after = residencyOverScript(alignedMap().map);
    // The measurement that motivated the offset: the mark spent most of every
    // line on the NEXT line.
    expect(before.onNext).toBeGreaterThan(0.5);
    expect(before.onCurrent).toBeLessThan(0.2);
    expect(after.onCurrent).toBeGreaterThan(before.onCurrent * 3);
  });

  it('leaves the motion path itself untouched — it is a phase shift, not a retune', () => {
    const { map: before, maxScrollPx: beforeMaxPx } = unalignedMap();
    const { map: after } = alignedMap();
    expect(after.lines.length).toBe(before.lines.length);
    /*
     * Every knot is `baselineY - R` and BOTH terms grew by the offset, so the
     * path comes out identical: same spline, same derivatives, same velocities,
     * and every §29/§30 bound the stage was tuned against still describes this
     * document. The mark moved relative to the text; nothing moved relative to
     * the clock.
     *
     * True of every knot the scroll range can hold. The tail is the exception
     * and gets its own test below.
     */
    let compared = 0;
    for (let i = 0; i < before.lines.length; i++) {
      const line = before.lines[i];
      const beforePx = line ? before.sampleMotionPath(line.spokenUnitStart)?.scrollPx : undefined;
      const afterPx = line ? after.sampleMotionPath(line.spokenUnitStart)?.scrollPx : undefined;
      if (line === undefined || beforePx === undefined || afterPx === undefined) continue;
      // Clamped knots are the tail's business, not this assertion's.
      if (beforePx >= beforeMaxPx - 1e-6) continue;
      expect(afterPx).toBeCloseTo(beforePx, 6);
      compared++;
    }
    expect(compared).toBeGreaterThan(10);
  });

  it('rests the closing line in the same place, though its knot IS clamped', () => {
    /*
     * The one number the offset does not cancel out of.
     *
     * A knot is clamped to `maxScrollPx`, and the top padding is part of the
     * document height that bound is computed from — so the ceiling rises by the
     * offset along with everything else. The knot VALUE therefore changes at the
     * tail where the old one was clamped. What does not change is the only thing
     * a presenter can see: where the closing line comes to rest on the glass,
     * because the document moved down by exactly what the ceiling moved up by.
     */
    const { map: before, maxScrollPx: beforeMaxPx } = unalignedMap();
    const { map: after, maxScrollPx: afterMaxPx } = alignedMap();
    const lastBefore = before.lines[before.lines.length - 1];
    const lastAfter = after.lines[after.lines.length - 1];
    expect(lastBefore).toBeDefined();
    expect(lastAfter).toBeDefined();
    if (!lastBefore || !lastAfter) return;

    const endBefore = before.sampleMotionPath(lastBefore.spokenUnitEnd)?.scrollPx;
    const endAfter = after.sampleMotionPath(lastAfter.spokenUnitEnd)?.scrollPx;
    expect(endBefore).toBeDefined();
    expect(endAfter).toBeDefined();
    if (endBefore === undefined || endAfter === undefined) return;

    // The clamp really is in play — otherwise this test proves nothing.
    expect(endBefore).toBeCloseTo(beforeMaxPx, 6);
    expect(afterMaxPx - beforeMaxPx).toBeCloseTo(OFFSET_PX, 6);

    // Same place on the glass, to the pixel.
    expect(lastAfter.baselineY - endAfter).toBeCloseTo(lastBefore.baselineY - endBefore, 6);
  });
});

describe('lineEntryOffsetPx', () => {
  it('is half a pitch plus half a cap height', () => {
    expect(lineEntryOffsetPx(80, 40)).toBeCloseTo(60, 9);
  });

  it('answers zero rather than NaN for geometry that has not resolved', () => {
    expect(lineEntryOffsetPx(0, 0)).toBe(0);
    expect(lineEntryOffsetPx(Number.NaN, 40)).toBe(20);
    expect(lineEntryOffsetPx(80, Number.NaN)).toBe(40);
  });
});
