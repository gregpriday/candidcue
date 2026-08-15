import { describe, it, expect } from 'vitest';
import { classifyTransition, manualScrollRelocated } from './motion';
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

  /* ------------------------------------------------------------------ §30.5 --
   * An accepted retake is a walk at every distance.
   *
   * The presenter has restarted an earlier phrase and is saying it out loud. The
   * script coming back to meet them IS the information; a fade and a cut hides
   * the one move they can actually follow with their eye, and the further back
   * they went the worse that trade gets. There is no length at which this
   * becomes a teleport.
   */
  describe('an accepted retake (§30.5)', () => {
    it('is a guided rewind at any distance, near or a whole document away', () => {
      for (const distancePx of [0, 40, 400, 1900, 2100, 4000, 40_000]) {
        expect(
          classifyTransition({
            decision: 'retakeAccepted',
            distancePx,
            viewportHeightPx: 1000,
            reducedMotion: false,
          }),
        ).toBe('smooth_rewind');
      }
    });

    it('is not recaptured by the fade threshold at any pitch', () => {
      // The generic branch narrows with the pitch (see below). A retake never
      // reaches it, so no type size can turn one into a cut.
      for (const linePitchPx of [20, 48, 86, 150, 320]) {
        expect(
          classifyTransition({
            decision: 'retakeAccepted',
            distancePx: 3000,
            viewportHeightPx: 600,
            reducedMotion: false,
            linePitchPx,
          }),
        ).toBe('smooth_rewind');
      }
    });

    it('still yields to reduced motion, which is the one documented exception', () => {
      // §32.4. Somebody who has asked their system not to animate is not asking
      // for a gentler animation, and this exception may not leak the other way.
      expect(
        classifyTransition({
          decision: 'retakeAccepted',
          distancePx: 3000,
          viewportHeightPx: 1000,
          reducedMotion: true,
        }),
      ).toBe('instant');
    });
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

describe('a settled wheel gesture: move or look? (§16.9)', () => {
  const VH = 1080;

  it('treats a glance as a glance', () => {
    // A third of a screen leaves the place the aligner is holding plainly in
    // view. Re-seeding its cursor would discard a lock that is still right.
    expect(manualScrollRelocated(VH * 0.3, VH)).toBe(false);
  });

  it('treats half a screen as having moved', () => {
    expect(manualScrollRelocated(VH * 0.5, VH)).toBe(true);
    expect(manualScrollRelocated(VH * 2, VH)).toBe(true);
  });

  it('reads the same in both directions', () => {
    // Scrolling back to re-read is as much a move as scrolling on.
    expect(manualScrollRelocated(-VH * 0.6, VH)).toBe(true);
    expect(manualScrollRelocated(-VH * 0.2, VH)).toBe(false);
  });

  it('says no when there is nothing to measure against', () => {
    /*
     * A null gap is not a small one: it means no frame has arrived from the
     * feed this session, so the stage does not know whether the presenter has
     * moved. Not knowing is a reason to leave the tracker alone, never a reason
     * to overwrite it.
     */
    expect(manualScrollRelocated(null, VH)).toBe(false);
    expect(manualScrollRelocated(Number.NaN, VH)).toBe(false);
  });

  it('says no before the viewport has been measured', () => {
    // Every gap is "half of nothing" against a zero-height viewport, which
    // would make the very first gesture of a take a relocation.
    expect(manualScrollRelocated(400, 0)).toBe(false);
  });

  it('scales with the glass, so the rule is the same on every panel', () => {
    // 300 px is a third of a 900 px stage and most of a 600 px one.
    expect(manualScrollRelocated(300, 900)).toBe(false);
    expect(manualScrollRelocated(300, 600)).toBe(true);
  });
});
