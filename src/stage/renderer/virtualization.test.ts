import { describe, it, expect } from 'vitest';
import {
  shouldVirtualize,
  computeOffsets,
  computeWindow,
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
