import { describe, it, expect } from 'vitest';
import { classifyTransition } from './motion';
import { ALIGNMENT_RELOCATIONS } from '../../shared/contracts';
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

describe('the smooth-jump threshold may narrow with pitch, never widen', () => {
  /*
   * This is the boundary between a correction the presenter WATCHES travel and
   * one hidden behind the §20.4 fade. Getting it wrong in the permissive
   * direction is the expensive one: an unnecessary fade costs 220ms of dimmed
   * text, while a visible flight across the glass costs the reader their place
   * mid-sentence — which is the whole reason the fade exists.
   */
  const relocation = [...ALIGNMENT_RELOCATIONS][0]!;

  function classify(distancePx: number, viewportHeightPx: number, linePitchPx?: number) {
    return classifyTransition({
      decision: relocation,
      distancePx,
      viewportHeightPx,
      reducedMotion: false,
      ...(linePitchPx === undefined ? {} : { linePitchPx }),
    });
  }

  it('hides a three-screen correction even at a large pitch', () => {
    /*
     * The regression. A 0.5x-3x band around two viewport heights reaches SIX
     * screens, so a 600px stage at a 150px pitch classified a 2,000px
     * correction — three and a third screens — as something to show travelling.
     */
    expect(classify(2000, 600, 150)).toBe('fade_jump');
  });

  it('never widens the pitch-less boundary, at any pitch', () => {
    const viewportHeightPx = 600;
    const boundary = 2 * viewportHeightPx;
    for (const pitch of [20, 48, 86, 120, 150, 240, 320]) {
      // Just past the viewport-relative boundary must fade, whatever the type
      // size claims about lines.
      expect(classify(boundary + 1, viewportHeightPx, pitch)).toBe('fade_jump');
    }
  });

  it('still lets a small pitch NARROW the boundary', () => {
    // The line-relative bound is allowed to be the stricter of the two — tiny
    // type means many lines fit on a screen, and a screen-and-a-half of them is
    // a lot of reading to fly past.
    const tight = classify(700, 600, 20);
    const loose = classify(700, 600, 150);
    expect(tight).toBe('fade_jump');
    expect(loose).toBe('smooth_jump');
  });

  it('leaves a caller with no measured pitch exactly where it was', () => {
    expect(classify(1199, 600)).toBe('smooth_jump');
    expect(classify(1201, 600)).toBe('fade_jump');
  });
});
