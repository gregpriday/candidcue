import { describe, it, expect } from 'vitest';
import { classifyTransition } from './motion';
import { segmentText } from './text';

describe('transition classification (spec §32.3, §16.3)', () => {
  it('follows alignment-driven advances and holds', () => {
    expect(
      classifyTransition({
        decision: 'localConfirmed',
        distancePx: 300,
        viewportHeightPx: 1000,
        reducedMotion: false,
      }),
    ).toBe('spring');
    expect(
      classifyTransition({
        decision: 'holdLowEvidence',
        distancePx: 10,
        viewportHeightPx: 1000,
        reducedMotion: false,
      }),
    ).toBe('spring');
  });

  it('catches up on explicit jumps within two viewport heights', () => {
    for (const decision of [
      'jumpForwardAccepted',
      'retakeAccepted',
      'relocationAccepted',
      'manualAnchor',
    ] as const) {
      expect(
        classifyTransition({
          decision,
          distancePx: 1900,
          viewportHeightPx: 1000,
          reducedMotion: false,
        }),
      ).toBe('smooth_jump');
    }
  });

  it('re-anchors larger jumps', () => {
    expect(
      classifyTransition({
        decision: 'jumpForwardAccepted',
        distancePx: 2100,
        viewportHeightPx: 1000,
        reducedMotion: false,
      }),
    ).toBe('fade_jump');
  });

  it('respects reduced motion with near-instant repositioning', () => {
    expect(
      classifyTransition({
        decision: 'jumpForwardAccepted',
        distancePx: 5000,
        viewportHeightPx: 1000,
        reducedMotion: true,
      }),
    ).toBe('instant');
  });
});

describe('token segmentation', () => {
  it('assigns token indexes to words when the mapping aligns', () => {
    const segs = segmentText('hello brave world', [4, 5, 6]);
    const words = segs.filter((s) => !s.space);
    expect(words.map((w) => w.tokenIndex)).toEqual([4, 5, 6]);
    expect(segs.map((s) => s.text).join('')).toBe('hello brave world');
  });

  it('preserves whitespace segments verbatim', () => {
    const segs = segmentText('a  b\nc', [1, 2, 3]);
    expect(segs.map((s) => s.text).join('')).toBe('a  b\nc');
  });

  it('anchors only the run start when the mapping is misaligned', () => {
    const segs = segmentText('one two three', [9]);
    const words = segs.filter((s) => !s.space);
    expect(words[0]?.tokenIndex).toBe(9);
    expect(words[1]?.tokenIndex).toBeNull();
  });

  it('handles empty and whitespace-only runs', () => {
    expect(segmentText('', [])).toEqual([]);
    const segs = segmentText('   ');
    expect(segs).toHaveLength(1);
    expect(segs[0]?.space).toBe(true);
  });
});
