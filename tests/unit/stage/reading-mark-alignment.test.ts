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
 *
 * The correction is half a cap height — the amount that puts the middle of a
 * capital on the mark at the instant a line is entered. It briefly also carried a
 * quarter of a pitch, chosen to raise the mark's residency on the line being
 * read; that term is gone because it cancelled the cap correction and pointed the
 * apex at the top of the letters instead of at them. The residency table it was
 * chosen from is recorded inline below, so the trade stays visible.
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
  /** How far through the line the mark first reaches the NEXT one — the handover. */
  let firstNextAt: number | null = null;
  for (let i = 0; i < steps; i++) {
    const p = i / steps;
    const unit = line.spokenUnitStart + p * (line.spokenUnitEnd - line.spokenUnitStart);
    const scrollPx = map.sampleMotionPath(unit)?.scrollPx ?? 0;
    if (MARK_PX >= line.topY - scrollPx && MARK_PX <= line.bottomY - scrollPx) onCurrent++;
    if (MARK_PX >= next.topY - scrollPx && MARK_PX <= next.bottomY - scrollPx) {
      onNext++;
      if (firstNextAt === null) firstNextAt = p;
    }
  }
  return { onCurrent: onCurrent / steps, onNext: onNext / steps, firstNextAt };
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
  /*
   * THE PROPERTY THIS FILE IS ACTUALLY FOR.
   *
   * The offset is `cap / 2` and nothing else, so at the instant a line begins
   * its baseline sits exactly half a cap height below the mark — which is to say
   * the middle of a capital is ON the mark. The tick is drawn one cap high with
   * its apex at its own centre, so at line entry the triangle spans precisely
   * the capital: same centre, same extent.
   *
   * This is the assertion a presenter would recognise. It replaced an average
   * over the whole line (see below), which was satisfied by a phase that put the
   * apex on the CAP LINE at line entry — pointing at the top of the letters
   * rather than at them — and that is what a presenter actually noticed.
   */
  it('shares a centre with the capital at the instant a line begins', () => {
    const { map } = alignedMap();
    const line = map.lines[8];
    expect(line).toBeDefined();
    if (!line) return;
    const scrollPx = map.sampleMotionPath(line.spokenUnitStart)?.scrollPx;
    expect(scrollPx).toBeDefined();
    if (scrollPx === undefined) return;
    // Where the foot of the letters lands on the glass as the line is entered.
    const baselineOnGlass = line.baselineY - scrollPx;
    expect(baselineOnGlass).toBeCloseTo(MARK_PX + CAP_PX / 2, 6);
  });

  /*
   * Residency — the mark's phase across a whole line — measured on this fixture
   * for every candidate offset, so the trade is recorded rather than argued:
   *
   *   offset            onCurrent  onNext  leaves at  on next from
   *   R == mark (0)        0.179    0.508     17.5%        40%
   *   cap/2  (shipped)     0.388    0.313     40%          65%
   *   cap/2 + pitch/8      0.492    0.213     52.5%        77.5%
   *   cap/2 + pitch/4      0.596    0.113     65%          90%
   *
   * The quarter pitch shipped for a while on the strength of `onCurrent`. Two
   * things in this table argue against it. It costs the centring asserted above,
   * because `pitch / 4` and `cap / 2` are within 6% of each other at the default
   * line height and cancel. And the sentence it was justified by — "the pointer
   * should be on the next line already by the time they get to the end of a
   * line" — is something it makes WORSE: at a quarter pitch handover happens at
   * 90% of the line, barely before it ends, where the shipped offset hands over
   * at 65% and genuinely leads the eye into the next line.
   *
   * `cap/2 + pitch/8` is the fallback if the script ever feels one line behind
   * again, but reach for the mark's SHAPE first — see `lineEntryOffsetPx`.
   */
  it('is on the line being read more than it is on the next one', () => {
    const { onCurrent, onNext } = residencyOverScript(alignedMap().map);
    expect(onCurrent).toBeGreaterThan(0.35);
    expect(onNext).toBeLessThan(0.35);
    // The margin is narrower than it was at a quarter pitch, deliberately. What
    // must never come back is the INVERSION below.
    expect(onNext).toBeLessThan(onCurrent);
  });

  it('hands the eye to the next line before the reader arrives there', () => {
    const { map } = alignedMap();
    const { firstNextAt } = markResidency(map, 8);
    // Somewhere in the back half, and not at the very last step: the eye should
    // be invited to the next line, not shown it as it gets there.
    expect(firstNextAt).not.toBeNull();
    if (firstNextAt === null) return;
    expect(firstNextAt).toBeGreaterThan(0.5);
    expect(firstNextAt).toBeLessThan(0.8);
  });

  it('is a large improvement on treating `R` and the mark as one number', () => {
    const before = residencyOverScript(unalignedMap().map);
    const after = residencyOverScript(alignedMap().map);
    /*
     * The measurement that motivated the offset existing at all: with `R` and
     * the mark as one number the mark spent most of every line on the NEXT line
     * — an inversion, not a margin, and a presenter reads it as the script
     * sitting permanently one line behind them.
     */
    expect(before.onNext).toBeGreaterThan(0.5);
    expect(before.onCurrent).toBeLessThan(0.2);
    expect(before.onNext).toBeGreaterThan(before.onCurrent * 2);
    // Corrected: the right line now wins, where it used to lose badly.
    expect(after.onCurrent).toBeGreaterThan(after.onNext);
    expect(after.onCurrent).toBeGreaterThan(before.onCurrent * 2);
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
  /*
   * Half a cap height, and no pitch term. Pinned as an equality rather than a
   * bound because the centring assertion above depends on this being EXACTLY
   * `cap / 2`: any pitch term at all moves the apex off the middle of the
   * capital, and at the default 1.32 line height a quarter of a pitch moves it
   * a whole half-cap — onto the cap line.
   */
  it('is half a cap height, with no pitch term', () => {
    expect(lineEntryOffsetPx(80, 40)).toBeCloseTo(20, 9);
    // Independent of the pitch, which is the whole point.
    expect(lineEntryOffsetPx(200, 40)).toBeCloseTo(20, 9);
  });

  it('answers zero rather than NaN for geometry that has not resolved', () => {
    expect(lineEntryOffsetPx(0, 0)).toBe(0);
    expect(lineEntryOffsetPx(Number.NaN, 40)).toBe(20);
    // No cap height means no correction to make — not a pitch-derived guess.
    expect(lineEntryOffsetPx(80, Number.NaN)).toBe(0);
  });
});
