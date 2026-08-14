import { describe, it, expect } from 'vitest';
import {
  shouldVirtualize,
  computeOffsets,
  computeWindow,
  seedScrollForToken,
  DEFAULT_OVERSCAN_PX,
  VIRTUALIZATION_BLOCK_THRESHOLD,
} from './virtualization';

describe('stage virtualization (spec §51.3)', () => {
  it('renders ordinary scripts fully and windows only extreme ones', () => {
    expect(shouldVirtualize(50)).toBe(false);
    expect(shouldVirtualize(VIRTUALIZATION_BLOCK_THRESHOLD)).toBe(false);
    expect(shouldVirtualize(VIRTUALIZATION_BLOCK_THRESHOLD + 1)).toBe(true);
  });

  it('computes cumulative offsets with leading padding', () => {
    const offsets = computeOffsets([100, 200, 300], 0, 500);
    expect(offsets).toEqual([500, 600, 800, 1100]);
  });

  it('applies an inter-block gap between blocks but not after the last', () => {
    const offsets = computeOffsets([100, 100], 40, 0);
    expect(offsets).toEqual([0, 140, 240]);
  });

  it('windows the visible range plus overscan', () => {
    const heights = Array.from({ length: 100 }, () => 100);
    const offsets = computeOffsets(heights, 0, 0);
    const win = computeWindow(offsets, 5000, 800, 400);
    // Range [4600, 6200] → blocks 46..61 inclusive.
    expect(win.startIndex).toBe(46);
    expect(win.endIndex).toBe(62);
    expect(win.leadingSpacePx).toBe(4600);
    expect(win.trailingSpacePx).toBe(10000 - offsets[62]!);
  });

  it('reconstructs total height exactly from spacers plus rendered blocks', () => {
    const heights = Array.from({ length: 50 }, (_, i) => 80 + (i % 7) * 12);
    const offsets = computeOffsets(heights, 0, 0);
    const total = offsets[50]!;
    const win = computeWindow(offsets, 1234, 700, 300);
    let rendered = 0;
    for (let i = win.startIndex; i < win.endIndex; i++) rendered += heights[i]!;
    expect(win.leadingSpacePx + rendered + win.trailingSpacePx).toBe(total);
  });

  it('clamps at the top of the document', () => {
    const offsets = computeOffsets([100, 100, 100], 0, 0);
    const win = computeWindow(offsets, 0, 500, 200);
    expect(win.startIndex).toBe(0);
    expect(win.leadingSpacePx).toBe(0);
    expect(win.endIndex).toBe(3);
  });

  it('clamps at the bottom of the document', () => {
    const heights = Array.from({ length: 40 }, () => 100);
    const offsets = computeOffsets(heights, 0, 0);
    const win = computeWindow(offsets, 100000, 500, 200);
    expect(win.endIndex).toBe(40);
    expect(win.startIndex).toBeLessThan(40);
    expect(win.trailingSpacePx).toBe(0);
  });

  it('handles an empty document', () => {
    const win = computeWindow(computeOffsets([], 0, 0), 0, 500, 200);
    expect(win).toEqual({ startIndex: 0, endIndex: 0, leadingSpacePx: 0, trailingSpacePx: 0 });
  });
});

/**
 * Seeding the window for a far-down opening (CCUX-014).
 *
 * The window is computed from `scrollY`, which starts at zero, and the stage
 * can only measure what it rendered. So a take asked to open part-way down a
 * long script found no measured token at its opening index, correctly refused
 * to place against a top-of-document map, and revealed at the top — the feature
 * silently failing on exactly the long scripts it exists for.
 *
 * The arithmetic lives here rather than in the component because jsdom lays
 * nothing out: a component test could prove the effect ran and nothing about
 * where it landed. What the RENDERED result looks like is case A8 of the
 * real-rig protocol, and is not claimed by this file.
 */
describe('seedScrollForToken', () => {
  /** Ten blocks, twenty tokens and 500px each. Offsets are cumulative tops. */
  const blocks = Array.from({ length: 10 }, (_, i) => ({
    startTokenIndex: i * 20,
    endTokenIndex: i * 20 + 19,
  }));
  const offsets = Array.from({ length: 11 }, (_, i) => i * 500);
  const VH = 900;
  const MAX = 5000 - VH;

  it('lands the target block inside the window', () => {
    // Token 125 is in block 6 (120–139), whose top is 3000.
    const seed = seedScrollForToken(blocks, offsets, 125, VH, MAX);
    expect(seed).not.toBeNull();
    // Above the block by a third of a viewport, so the row is inside the
    // window rather than on its very edge.
    expect(seed).toBeCloseTo(3000 - VH / 3, 5);
    // And the block really is within the rendered window from there.
    const w = computeWindow(offsets, seed!, VH, DEFAULT_OVERSCAN_PX);
    expect(w.startIndex).toBeLessThanOrEqual(6);
    expect(w.endIndex).toBeGreaterThan(6);
  });

  it('never seeds past the end of the document', () => {
    const seed = seedScrollForToken(blocks, offsets, 199, VH, MAX);
    expect(seed).toBeLessThanOrEqual(MAX);
    expect(seed).toBeGreaterThanOrEqual(0);
  });

  it('never seeds above the top', () => {
    // An early token would put the biased seed negative.
    expect(seedScrollForToken(blocks, offsets, 5, VH, MAX)).toBe(0);
  });

  it('declines rather than guessing when there is nothing to seed', () => {
    // Leaving the scroll alone is right: jumping somewhere arbitrary would be
    // worse than opening at the top, which is at least a place in the script.
    expect(seedScrollForToken(blocks, offsets, 0, VH, MAX)).toBeNull();
    expect(seedScrollForToken(blocks, offsets, -1, VH, MAX)).toBeNull();
    expect(seedScrollForToken(blocks, offsets, Number.NaN, VH, MAX)).toBeNull();
    // A token past every block — a stale index from a longer revision.
    expect(seedScrollForToken(blocks, offsets, 9999, VH, MAX)).toBeNull();
    expect(seedScrollForToken([], [], 100, VH, MAX)).toBeNull();
  });
});
