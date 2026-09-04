/**
 * The resolver, checked on the two things it must never get wrong:
 *
 *  1. an UNCALIBRATED rig still prompts, with the historical geometry, and says
 *     out loud that it is guessing;
 *  2. a CALIBRATED rig produces geometry that is identical in line-units across
 *     panels of different pixel heights, which is the entire reason the module
 *     exists.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DEAD_ZONE_LINES,
  DEFAULT_LINE_HEIGHT,
  DEFAULT_PAST_OPACITY,
  DEFAULT_TOP_FADE_LINES,
  UNCALIBRATED_FONT_SIZE_PX,
  resolveStageGeometry,
  resolveTargetArcminutes,
  resolveTargetCharacters,
} from './optical-resolve';
import { defaultOpticalProfile, type OpticalProfile } from './contracts/optical';
import {
  ANGULAR_PRESET_ARCMIN,
  READING_MEASURE,
  fallbackFontMetrics,
  inchesToMm,
  mmPerCssPixel,
} from './optics';

const PROMPTER_9 = { widthPx: 1024, heightPx: 600 };
const PROMPTER_XL = { widthPx: 1920, heightPx: 1080 };

function calibrated(overrides: Partial<OpticalProfile> = {}): OpticalProfile {
  const scale = mmPerCssPixel({
    diagonalMm: inchesToMm(9),
    widthPx: PROMPTER_9.widthPx,
    heightPx: PROMPTER_9.heightPx,
  });
  return {
    ...defaultOpticalProfile(),
    hardwareKind: 'elgato-prompter',
    scale: { mmPerCssPx: scale as number, source: 'model', diagonalMm: inchesToMm(9) },
    viewingDistanceMm: 1200,
    ...overrides,
  };
}

describe('a pinned size does not shrink the column', () => {
  /*
   * The rig this came from: a 9-inch Elgato Prompter, calibrated at 1.5 m, with
   * the body size pinned to 48px because the model's own 70px was larger than
   * the presenter wanted. The column is solved in `ch`, and a `ch` is a
   * fraction of the em — so the column solved for 70px and rendered at 48px
   * came out at 647px of a 1024px panel, with a third of the glass empty and
   * the script in a ribbon down the middle.
   */
  const rig = (overrides: Record<string, number>) => ({
    ...defaultOpticalProfile(),
    rigName: 'Prompter',
    hardwareKind: 'elgato-prompter' as const,
    bias: 0.2,
    viewingDistanceMm: 1500,
    scale: { mmPerCssPx: 0.19261321656946984, source: 'model' as const, diagonalMm: 228.6 },
    overrides,
  });
  const resolve = (overrides: Record<string, number>) =>
    resolveStageGeometry({ profile: rig(overrides), viewport: { widthPx: 1024, heightPx: 600 } })
      .optics;
  const columnPx = (o: { columnCh: number; bodyFontSizePx: number }) =>
    o.columnCh * fallbackFontMetrics().zeroAdvanceRatio * o.bodyFontSizePx;

  it('spends the width a smaller pinned size frees, rather than leaving it black', () => {
    const pinned = resolve({ fontSizePx: 48 });
    expect(pinned.bodyFontSizePx).toBe(48);
    /*
     * The rendered column on the rig this came from: ~840px of 1024 rather than
     * the ~647px it used to be. Bounded as a range because the exact number
     * moves with the DIN fallback metrics, and the point is the size of the
     * change, not a digit.
     */
    expect(columnPx(pinned) / 1024).toBeGreaterThan(0.72);
    // And the extra width shows up as what it is for: more of the sentence.
    expect(pinned.charactersPerLine!).toBeGreaterThan(31);
  });

  it('leaves a margin that reads as deliberate, not a clearance', () => {
    /*
     * The rule, and it is a design decision rather than a fit: the column is
     * inset by about 12% of the glass on each side, which is what it takes to
     * sit the reading mark in the middle of that margin with equal air on both
     * sides of it. Reserving only what the ticks need takes the text to the
     * bezel and reads as overflow; the old 18% wasted a third of a small panel.
     *
     * Checked at a pinned and an unpinned size, because they resolve through
     * different branches, and against the tick's own footprint so the margin
     * cannot quietly fall below the thing it exists to hold.
     */
    const m = fallbackFontMetrics();
    for (const overrides of [{ fontSizePx: 48 }, {}] as Record<string, number>[]) {
      const o = resolve(overrides);
      const sideMarginPx = (1024 - columnPx(o)) / 2;
      expect(sideMarginPx / 1024).toBeGreaterThan(0.1);
      expect(sideMarginPx / 1024).toBeLessThan(0.14);
      /*
       * And the margin is big enough to CENTRE the mark in, not merely to fit
       * it: the tick is drawn in a box 16/18 as wide as it is tall, and
       * `ReadingCue` centres it, so equal air either side needs the margin to
       * clear the tick by at least a gap on both sides.
       */
      const capPx = o.bodyFontSizePx * m.capHeightRatio;
      const tickPx = capPx * (16 / 18);
      expect((sideMarginPx - tickPx) / 2).toBeGreaterThan(capPx * 0.5);
    }
  });

  it('still fills far more of the panel than a proportionally shrunken column', () => {
    const free = resolve({});
    expect(free.bodyFontSizePx).toBeGreaterThan(60);
    expect(columnPx(free) / 1024).toBeGreaterThan(0.75);
  });

  it('never runs the line past the measure band, however small the pinned size', () => {
    /*
     * The counterpart of the fit check's own rule. Spending freed width is
     * right up to the point a line stops being readable prose; past that the
     * band's ceiling holds, or a presenter who pinned 12px would get a single
     * line of 90 characters across the glass.
     */
    const tiny = resolve({ fontSizePx: 14 });
    expect(tiny.charactersPerLine!).toBeLessThanOrEqual(READING_MEASURE.bandMax + 1);
  });

  it('leaves an explicitly pinned column alone', () => {
    // A presenter naming a number is not this code's to reinterpret.
    const pinned = resolve({ fontSizePx: 48, columnCh: 20 });
    expect(pinned.columnCh).toBe(20);
  });
});

describe('an uncalibrated rig', () => {
  it('still prompts, using the historical desk-distance defaults', () => {
    const { optics } = resolveStageGeometry({
      profile: defaultOpticalProfile(),
      viewport: PROMPTER_9,
    });
    expect(optics.calibrated).toBe(false);
    expect(optics.bodyFontSizePx).toBe(UNCALIBRATED_FONT_SIZE_PX);
    expect(optics.bodyArcminutes).toBeNull();
    expect(optics.columnCh).toBeGreaterThan(0);
  });

  it('says it is guessing rather than presenting the guess as a measurement', () => {
    const { warnings } = resolveStageGeometry({
      profile: defaultOpticalProfile(),
      viewport: PROMPTER_9,
    });
    expect(warnings.join(' ')).toContain('has not been calibrated');
  });

  it('resolves the legacy 68% column into the same ch mechanism the rest uses', () => {
    // One column mechanism, not a calibrated path and a legacy path that can
    // drift apart. 68% of 1024px at 64px body is ~19.9ch.
    const { optics } = resolveStageGeometry({
      profile: defaultOpticalProfile(),
      viewport: PROMPTER_9,
    });
    expect(optics.columnCh).toBeCloseTo((1024 * 0.68) / (0.55 * 64), 4);
  });
});

describe('a calibrated rig', () => {
  it('sizes body text from the angle, not from a pixel default', () => {
    const { optics } = resolveStageGeometry({ profile: calibrated(), viewport: PROMPTER_9 });
    expect(optics.calibrated).toBe(true);
    expect(optics.bodyFontSizePx).toBeGreaterThan(50);
    expect(optics.bodyArcminutes).not.toBeNull();
  });

  it('reports the 9-inch panel as width-limited instead of quietly shrinking type', () => {
    /*
     * The finding the width system is built on: at a comfortable angular size a
     * 9-inch Prompter cannot reach the mid-30s character measure, so it must
     * hold the type size and say the line is narrow.
     */
    const { optics } = resolveStageGeometry({ profile: calibrated(), viewport: PROMPTER_9 });
    expect(optics.fitVerdict).toBe('width_limited');
    expect(optics.charactersPerLine as number).toBeLessThan(READING_MEASURE.idealMin);
    expect(optics.charactersPerLine as number).toBeGreaterThan(READING_MEASURE.hardFloor);
  });

  it('finds the same profile comfortable on a larger panel', () => {
    const xlScale = mmPerCssPixel({
      diagonalMm: inchesToMm(15.6),
      widthPx: PROMPTER_XL.widthPx,
      heightPx: PROMPTER_XL.heightPx,
    });
    const profile = calibrated({
      hardwareKind: 'elgato-prompter-xl',
      scale: { mmPerCssPx: xlScale as number, source: 'model', diagonalMm: inchesToMm(15.6) },
    });
    const { optics } = resolveStageGeometry({ profile, viewport: PROMPTER_XL });
    expect(optics.fitVerdict).toBe('ok');
    expect(optics.charactersPerLine as number).toBeGreaterThan(READING_MEASURE.idealMin - 1);
  });

  it('gives both panels the SAME line-unit geometry', () => {
    // The whole point. Fades, dead zone and reserve are multiples of the
    // measured line pitch, so they cannot mean one thing on a 600px panel and
    // another on a 1080px one the way the old vh constants did.
    const nine = resolveStageGeometry({ profile: calibrated(), viewport: PROMPTER_9 }).optics;
    const xl = resolveStageGeometry({ profile: calibrated(), viewport: PROMPTER_XL }).optics;
    expect(nine.deadZoneLines).toBe(xl.deadZoneLines);
    expect(nine.topFadeLines).toBe(xl.topFadeLines);
    expect(nine.bottomFadeLines).toBe(xl.bottomFadeLines);
    expect(nine.futureReserveLines).toBe(xl.futureReserveLines);
    expect(nine.deadZoneLines).toBe(DEFAULT_DEAD_ZONE_LINES);
    expect(nine.topFadeLines).toBe(DEFAULT_TOP_FADE_LINES);
  });

  it('fades the top more deeply than the bottom', () => {
    // Material above the band has been spoken and is receding; material below
    // it is about to be needed and must stay readable as long as possible.
    const { optics } = resolveStageGeometry({ profile: calibrated(), viewport: PROMPTER_9 });
    expect(optics.topFadeLines).toBeGreaterThan(optics.bottomFadeLines);
  });

  it('warns when the resolved size lands under the fluent-reading floor', () => {
    const { warnings } = resolveStageGeometry({
      profile: calibrated({ viewingDistanceMm: 3000 }),
      viewport: PROMPTER_9,
    });
    expect(warnings.join(' ').toLowerCase()).toMatch(/too small|smaller than|comfortable/);
  });
});

describe('the safe rectangle', () => {
  it('computes the column inside the visible area, not the whole panel', () => {
    const full = resolveStageGeometry({ profile: calibrated(), viewport: PROMPTER_9 }).optics;
    const cropped = resolveStageGeometry({
      profile: calibrated({ safeArea: { top: 0.05, right: 0.15, bottom: 0.05, left: 0.15 } }),
      viewport: PROMPTER_9,
    }).optics;
    expect(cropped.charactersPerLine as number).toBeLessThan(full.charactersPerLine as number);
  });

  it('clamps insets that would leave no usable rectangle', () => {
    // Dragged by hand against a reflection: opposite edges summing past 1 must
    // not produce a negative width and take the layout with it.
    const { optics } = resolveStageGeometry({
      profile: calibrated({ safeArea: { top: 0.9, right: 0.9, bottom: 0.9, left: 0.9 } }),
      viewport: PROMPTER_9,
    });
    expect(optics.safeArea.left + optics.safeArea.right).toBeLessThan(1);
    expect(optics.safeArea.top + optics.safeArea.bottom).toBeLessThan(1);
    expect(Number.isFinite(optics.columnCh)).toBe(true);
    expect(optics.columnCh).toBeGreaterThan(0);
  });
});

describe('lens position', () => {
  it('carries the lens through as the optical centre', () => {
    const { optics } = resolveStageGeometry({
      profile: calibrated({ lens: { x: 0.36, y: 0.42 } }),
      viewport: PROMPTER_9,
    });
    expect(optics.opticalCenterX).toBeCloseTo(0.36, 6);
    expect(optics.readingBandY).toBeCloseTo(0.42, 6);
  });

  it('keeps the reading band away from the very edges of the glass', () => {
    const { optics } = resolveStageGeometry({
      profile: calibrated({ lens: { x: 2, y: -1 } }),
      viewport: PROMPTER_9,
    });
    expect(optics.opticalCenterX).toBe(1);
    expect(optics.readingBandY).toBeGreaterThanOrEqual(0.1);
    expect(optics.readingBandY).toBeLessThanOrEqual(0.9);
  });

  it('carries the default in-panel placement through to resolved optics', () => {
    const { optics } = resolveStageGeometry({ profile: calibrated(), viewport: PROMPTER_9 });
    expect(optics.lensPlacement).toBe('in-panel');
  });

  describe('an off-panel lens', () => {
    it('pins the band near the top for a lens above the display, ignoring lens.y', () => {
      const { optics } = resolveStageGeometry({
        profile: calibrated({ lensPlacement: 'above', lens: { x: 0.5, y: 0.7 } }),
        viewport: PROMPTER_9,
      });
      expect(optics.readingBandY).toBeCloseTo(0.05, 6);
      expect(optics.lensPlacement).toBe('above');
    });

    it('pins the band near the bottom for a lens below the display, ignoring lens.y', () => {
      const { optics } = resolveStageGeometry({
        profile: calibrated({ lensPlacement: 'below', lens: { x: 0.5, y: 0.1 } }),
        viewport: PROMPTER_9,
      });
      expect(optics.readingBandY).toBeCloseTo(0.95, 6);
      expect(optics.lensPlacement).toBe('below');
    });

    it('still carries the x-axis lens position through as the optical centre', () => {
      const { optics } = resolveStageGeometry({
        profile: calibrated({ lensPlacement: 'above', lens: { x: 0.3, y: 0.5 } }),
        viewport: PROMPTER_9,
      });
      expect(optics.opticalCenterX).toBeCloseTo(0.3, 6);
    });

    it('does not honour lensOffsetDegrees, and does not record it as overridden', () => {
      const { optics } = resolveStageGeometry({
        profile: calibrated({
          lensPlacement: 'above',
          overrides: { lensOffsetDegrees: 3 },
        }),
        viewport: PROMPTER_9,
      });
      expect(optics.readingBandY).toBeCloseTo(0.05, 6);
      expect(optics.overriddenFields).not.toContain('lensOffsetDegrees');
    });

    it('works without physical calibration', () => {
      const { optics } = resolveStageGeometry({
        profile: { ...defaultOpticalProfile(), lensPlacement: 'above' },
        viewport: PROMPTER_9,
      });
      expect(optics.calibrated).toBe(false);
      expect(optics.readingBandY).toBeCloseTo(0.05, 6);
    });

    it('is unaffected by OpticalFlips', () => {
      const mirrored = resolveStageGeometry({
        profile: calibrated({ lensPlacement: 'above', flips: { horizontal: true, vertical: true } }),
        viewport: PROMPTER_9,
      }).optics;
      const plain = resolveStageGeometry({
        profile: calibrated({ lensPlacement: 'above' }),
        viewport: PROMPTER_9,
      }).optics;
      expect(mirrored.readingBandY).toBe(plain.readingBandY);
      expect(mirrored.opticalCenterX).toBe(plain.opticalCenterX);
    });
  });
});

describe('targets', () => {
  it('derives both from one bias by default', () => {
    const profile = calibrated({ bias: 1 });
    expect(resolveTargetArcminutes(profile)).toBe(ANGULAR_PRESET_ARCMIN.comfort);
    expect(resolveTargetCharacters(profile)).toBeCloseTo(READING_MEASURE.idealMin, 6);
  });

  it('lets an explicit override win over the bias', () => {
    const profile = calibrated({ bias: 0, overrides: { arcminutes: 26, characters: 28 } });
    expect(resolveTargetArcminutes(profile)).toBe(26);
    expect(resolveTargetCharacters(profile)).toBeCloseTo(28, 6);
  });

  it('does not silently rescale an explicit character count by the framing', () => {
    // Framing is a shortcut for "pick something sensible". Once a number has
    // been named, multiplying it by 0.75 behind the user's back would make the
    // control lie about its own value.
    const profile = calibrated({ framing: 'close-up', overrides: { characters: 30 } });
    expect(resolveTargetCharacters(profile)).toBeCloseTo(30, 6);
  });

  it('narrows the measure for tighter framing', () => {
    // Lateral eye movement that is invisible waist-up is obvious in a headshot.
    const close = resolveTargetCharacters(calibrated({ framing: 'close-up' }));
    const wide = resolveTargetCharacters(calibrated({ framing: 'full-body' }));
    expect(close).toBeLessThan(wide);
  });

  it('never asks for fewer characters than a line can carry context in', () => {
    const profile = calibrated({ framing: 'close-up', overrides: { characters: 2 } });
    expect(resolveTargetCharacters(profile)).toBeGreaterThanOrEqual(READING_MEASURE.hardFloor);
  });

  it('ignores a non-finite override rather than propagating it', () => {
    const profile = calibrated({ overrides: { arcminutes: Number.NaN, characters: Infinity } });
    expect(Number.isFinite(resolveTargetArcminutes(profile))).toBe(true);
    expect(Number.isFinite(resolveTargetCharacters(profile))).toBe(true);
  });
});

describe('overrides — discover everything, decide nothing irreversibly', () => {
  it('lets a pinned font size win over the whole angular model', () => {
    const { optics } = resolveStageGeometry({
      profile: calibrated({ overrides: { fontSizePx: 84 } }),
      viewport: PROMPTER_9,
    });
    expect(optics.bodyFontSizePx).toBe(84);
    expect(optics.overriddenFields).toContain('fontSizePx');
  });

  it('recomputes the reported measure from what will actually be rendered', () => {
    /*
     * The readout has to describe the pinned geometry, not the geometry the
     * model wanted. It is the number the operator uses to judge whether their
     * override was a good idea, so a stale one is worse than none.
     */
    const derived = resolveStageGeometry({ profile: calibrated(), viewport: PROMPTER_9 }).optics;
    const pinned = resolveStageGeometry({
      profile: calibrated({ overrides: { fontSizePx: 120 } }),
      viewport: PROMPTER_9,
    }).optics;
    expect(pinned.charactersPerLine as number).toBeLessThan(derived.charactersPerLine as number);
    expect(pinned.bodyArcminutes as number).toBeGreaterThan(derived.bodyArcminutes as number);
  });

  it('still tells the operator what their own choice cost them', () => {
    // Overrides are applied AFTER the fit check precisely so this stays true:
    // the presenter is not prevented from choosing, only informed.
    const { warnings } = resolveStageGeometry({
      profile: calibrated({ overrides: { fontSizePx: 200 } }),
      viewport: PROMPTER_9,
    });
    expect(warnings.join(' ')).toMatch(/characters/);
  });

  it('records every applied override so the UI can offer a reset', () => {
    const { optics } = resolveStageGeometry({
      profile: calibrated({
        overrides: { lineHeight: 1.5, pastOpacity: 0.6, futureReserveLines: 5 },
      }),
      viewport: PROMPTER_9,
    });
    expect(optics.overriddenFields).toEqual(['futureReserveLines', 'lineHeight', 'pastOpacity']);
    expect(optics.lineHeight).toBe(1.5);
    expect(optics.pastOpacity).toBe(0.6);
    expect(optics.futureReserveLines).toBe(5);
  });

  it('reports nothing as overridden when a value equals what was derived', () => {
    // Setting a control to the number it already had is not an override, and
    // marking it "set by you" would be a lie the user cannot clear.
    const { optics } = resolveStageGeometry({
      profile: calibrated({ overrides: { lineHeight: DEFAULT_LINE_HEIGHT } }),
      viewport: PROMPTER_9,
    });
    expect(optics.overriddenFields).toEqual([]);
  });

  it('clamps an absurd override instead of rendering it', () => {
    const { optics } = resolveStageGeometry({
      profile: calibrated({
        overrides: { lineHeight: 99, pastOpacity: 5, deadZoneLines: -3, fontWeight: 2000 },
      }),
      viewport: PROMPTER_9,
    });
    expect(optics.lineHeight).toBeLessThanOrEqual(2);
    expect(optics.pastOpacity).toBeLessThanOrEqual(1);
    expect(optics.deadZoneLines).toBeGreaterThan(0);
    expect(optics.fontWeight).toBeLessThanOrEqual(800);
  });

  it('ships the reconciled typography defaults when nothing is overridden', () => {
    const { optics } = resolveStageGeometry({ profile: calibrated(), viewport: PROMPTER_9 });
    expect(optics.lineHeight).toBe(DEFAULT_LINE_HEIGHT);
    expect(optics.pastOpacity).toBe(DEFAULT_PAST_OPACITY);
    expect(optics.fontWeight).toBe(500);
    expect(optics.letterSpacingEm).toBe(0);
    expect(optics.paragraphSpacingEm).toBe(0.7);
    expect(optics.overriddenFields).toEqual([]);
  });

  it('shifts the reading band below the lens by a chosen angle', () => {
    /*
     * In degrees, not pixels: the same pixel offset is a different amount of
     * apparent gaze deviation at 1 m and at 2 m, and what matters is how the
     * camera perceives it.
     */
    const onLens = resolveStageGeometry({ profile: calibrated(), viewport: PROMPTER_9 }).optics;
    const below = resolveStageGeometry({
      profile: calibrated({ overrides: { lensOffsetDegrees: 1 } }),
      viewport: PROMPTER_9,
    }).optics;
    expect(below.readingBandY).toBeGreaterThan(onLens.readingBandY);
    expect(below.overriddenFields).toContain('lensOffsetDegrees');
  });

  it('refuses to honour an angular offset it cannot convert', () => {
    // No physical scale means no way to turn degrees into pixels. Saying
    // nothing beats applying a number that is definitely wrong.
    const { optics } = resolveStageGeometry({
      profile: { ...defaultOpticalProfile(), overrides: { lensOffsetDegrees: 1 } },
      viewport: PROMPTER_9,
    });
    expect(optics.overriddenFields).not.toContain('lensOffsetDegrees');
  });
});

describe('honesty fields', () => {
  it('records that the font was assumed rather than measured', () => {
    const { optics } = resolveStageGeometry({ profile: calibrated(), viewport: PROMPTER_9 });
    expect(optics.metricsMeasured).toBe(false);
  });

  it('records a real measurement when one is supplied', () => {
    const { optics } = resolveStageGeometry({
      profile: calibrated(),
      viewport: PROMPTER_9,
      metrics: {
        capHeightRatio: 0.72,
        xHeightRatio: 0.52,
        avgCharWidthRatio: 0.49,
        zeroAdvanceRatio: 0.56,
        measured: true,
      },
    });
    expect(optics.metricsMeasured).toBe(true);
  });

  it('degrades an implausible measurement instead of trusting it', () => {
    const { optics, warnings } = resolveStageGeometry({
      profile: calibrated(),
      viewport: PROMPTER_9,
      metrics: { capHeightRatio: 0, xHeightRatio: 0, avgCharWidthRatio: 0, zeroAdvanceRatio: 0 },
    });
    expect(optics.metricsMeasured).toBe(false);
    expect(Number.isFinite(optics.bodyFontSizePx)).toBe(true);
    expect(warnings.join(' ')).toContain('could not be measured');
  });

  it('always produces a usable secondary-text floor', () => {
    for (const viewport of [PROMPTER_9, PROMPTER_XL, { widthPx: 1, heightPx: 1 }]) {
      const { optics } = resolveStageGeometry({ profile: calibrated(), viewport });
      expect(Number.isFinite(optics.secondaryMinPx)).toBe(true);
      expect(optics.secondaryMinPx).toBeGreaterThan(0);
    }
  });
});

describe('review regressions', () => {
  it('treats an implausible viewing distance as no calibration at all', () => {
    /*
     * A typed 1mm is positive and finite and resolves to about 0.05px of body
     * type, which rounds to zero and leaves the presenter looking at a blank
     * rig — with nothing NaN anywhere to notice. Falling back to the
     * uncalibrated stage is the only outcome that still prompts.
     */
    const { optics } = resolveStageGeometry({
      profile: calibrated({ viewingDistanceMm: 1 }),
      viewport: PROMPTER_9,
    });
    expect(optics.calibrated).toBe(false);
    expect(optics.bodyFontSizePx).toBe(UNCALIBRATED_FONT_SIZE_PX);
  });

  it('refuses an absurd physical diagonal rather than scaling everything by it', () => {
    const { optics } = resolveStageGeometry({
      profile: calibrated({ scale: { mmPerCssPx: 0, source: 'model', diagonalMm: 1e9 } }),
      viewport: PROMPTER_9,
    });
    expect(optics.calibrated).toBe(false);
    expect(optics.bodyFontSizePx).toBeGreaterThanOrEqual(8);
  });

  it('never resolves a body size too small to render', () => {
    for (const distanceMm of [200, 400, 900, 1800, 4000]) {
      const { optics } = resolveStageGeometry({
        profile: calibrated({ viewingDistanceMm: distanceMm }),
        viewport: PROMPTER_9,
      });
      expect(optics.bodyFontSizePx).toBeGreaterThanOrEqual(8);
      expect(Number.isFinite(optics.bodyFontSizePx)).toBe(true);
    }
  });

  it('records the overrides that act before the fit check', () => {
    // These change what the model is ASKED for rather than shadowing what it
    // produced, so they never reach the take() helper and went unrecorded —
    // leaving a control the user could set but not see or reset.
    const { optics } = resolveStageGeometry({
      profile: calibrated({
        overrides: { arcminutes: 26, characters: 28, maxColumnFraction: 0.6 },
      }),
      viewport: PROMPTER_9,
    });
    expect(optics.overriddenFields).toEqual(
      expect.arrayContaining(['arcminutes', 'characters', 'maxColumnFraction']),
    );
  });

  it('converts a lens offset against the SAFE height, not the viewport', () => {
    /*
     * `readingBandY` is a fraction of the safe rectangle, so dividing a pixel
     * offset by the full viewport height under-shifts the band by exactly the
     * fraction the hood crops — and the error grows with the crop.
     */
    const insets = { top: 0.2, right: 0, bottom: 0.2, left: 0 };
    const cropped = resolveStageGeometry({
      profile: calibrated({ safeArea: insets, overrides: { lensOffsetDegrees: 1 } }),
      viewport: PROMPTER_9,
    }).optics;
    const uncropped = resolveStageGeometry({
      profile: calibrated({ overrides: { lensOffsetDegrees: 1 } }),
      viewport: PROMPTER_9,
    }).optics;
    const base = resolveStageGeometry({ profile: calibrated(), viewport: PROMPTER_9 }).optics;

    // A crop shrinks the safe height, so the SAME angle is a LARGER fraction of
    // it. Dividing by the viewport would have made the two identical.
    expect(cropped.readingBandY - base.readingBandY).toBeGreaterThan(
      uncropped.readingBandY - base.readingBandY,
    );
  });
});
