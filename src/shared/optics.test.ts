/**
 * The optical model, checked against physical arithmetic rather than against
 * itself.
 *
 * Most of these assertions are deliberately expressed as "what should a 9-inch
 * Elgato Prompter at 1.2 m actually do", because the whole point of the module
 * is that it answers questions about real hardware. A test that only checks
 * round-tripping would pass just as happily with the constants wrong.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_COLUMN_FRACTION,
  ANGULAR_HARD_FLOOR_ARCMIN,
  ANGULAR_PRESET_ARCMIN,
  ANGULAR_SOFT_FLOOR_ARCMIN,
  READING_MEASURE,
  arcminutesForBias,
  arcminutesForFontSizePx,
  arcminutesForHeightMm,
  charactersForBias,
  charactersForCh,
  charactersForWidthPx,
  charactersPerCh,
  chForCharacters,
  columnWidthPxForCh,
  fallbackFontMetrics,
  featureHeightMm,
  fontSizePxForArcminutes,
  hardwareFitCheck,
  horizontalAngleDegrees,
  inchesToMm,
  mmPerCssPixel,
  mmPerCssPixelFromRuler,
  normalizeFontMetrics,
  secondaryTextFloorPx,
  xHeightDegreesForCapArcminutes,
  type FontMetrics,
} from './optics';

/** The two panels CandidCue is actually built around. */
const PROMPTER_9 = { diagonalMm: inchesToMm(9), widthPx: 1024, heightPx: 600 };
const PROMPTER_XL = { diagonalMm: inchesToMm(15.6), widthPx: 1920, heightPx: 1080 };

const metrics = fallbackFontMetrics();

function contextFor(panel: typeof PROMPTER_9, distanceMm: number) {
  const mmPerCssPx = mmPerCssPixel(panel);
  if (mmPerCssPx === null) throw new Error('panel must resolve a scale');
  return { distanceMm, mmPerCssPx, metrics };
}

describe('physical scale', () => {
  it('derives millimetres per pixel from a diagonal and a resolution', () => {
    // 9" over hypot(1024,600)=1186.8px -> 228.6mm / 1186.8 = 0.1926 mm/px.
    expect(mmPerCssPixel(PROMPTER_9)).toBeCloseTo(0.1926, 4);
    expect(mmPerCssPixel(PROMPTER_XL)).toBeCloseTo(0.1799, 4);
  });

  it('refuses to invent a scale from nonsense', () => {
    expect(mmPerCssPixel({ diagonalMm: 0, widthPx: 1024, heightPx: 600 })).toBeNull();
    expect(mmPerCssPixel({ diagonalMm: 228, widthPx: 0, heightPx: 600 })).toBeNull();
    expect(mmPerCssPixel({ diagonalMm: Number.NaN, widthPx: 1024, heightPx: 600 })).toBeNull();
  });

  it('takes a ruler measurement over a model lookup when one is offered', () => {
    // The user drew a 400px bar and measured 77mm against the glass.
    expect(mmPerCssPixelFromRuler({ barLengthPx: 400, measuredMm: 77 })).toBeCloseTo(0.1925, 4);
    expect(mmPerCssPixelFromRuler({ barLengthPx: 400, measuredMm: 0 })).toBeNull();
    expect(mmPerCssPixelFromRuler({ barLengthPx: -1, measuredMm: 77 })).toBeNull();
  });
});

describe('angular size', () => {
  it('converts an angle to a physical height and back', () => {
    const h = featureHeightMm(1200, 24);
    expect(h).toBeCloseTo(8.378, 2);
    expect(arcminutesForHeightMm(h, 1200)).toBeCloseTo(24, 6);
  });

  it('sizes body text for the 9-inch Prompter the way the hardware tables do', () => {
    const context = contextFor(PROMPTER_9, 1200);
    const px = fontSizePxForArcminutes(ANGULAR_PRESET_ARCMIN.standard, context);
    // 8.378mm of cap / 0.1926 mm/px = 43.5px of cap; /0.70 = ~62px of body.
    expect(px).toBeCloseTo(62.1, 0);
  });

  it('round-trips a size back to the angle it subtends', () => {
    const context = contextFor(PROMPTER_9, 1500);
    const px = fontSizePxForArcminutes(28, context);
    expect(px).not.toBeNull();
    expect(arcminutesForFontSizePx(px as number, context)).toBeCloseTo(28, 6);
  });

  it('reports the legacy 64px default as a desk-distance size, not a universal one', () => {
    // The claim the uncalibrated fallback is labelled with: ~1.2m is fine, and
    // the same size at 1.8m is close to the floor.
    expect(arcminutesForFontSizePx(64, contextFor(PROMPTER_9, 1200))).toBeCloseTo(24.7, 0);
    const atDistance = arcminutesForFontSizePx(64, contextFor(PROMPTER_9, 1800));
    expect(atDistance).not.toBeNull();
    expect(atDistance as number).toBeLessThan(ANGULAR_SOFT_FLOOR_ARCMIN);
  });

  it('returns null rather than Infinity when the inputs are unusable', () => {
    expect(fontSizePxForArcminutes(24, { distanceMm: 0, mmPerCssPx: 0.19, metrics })).toBeNull();
    expect(fontSizePxForArcminutes(24, { distanceMm: 1200, mmPerCssPx: 0, metrics })).toBeNull();
    expect(
      fontSizePxForArcminutes(24, {
        distanceMm: 1200,
        mmPerCssPx: 0.19,
        metrics: { ...metrics, capHeightRatio: 0 },
      }),
    ).toBeNull();
  });

  it('places the soft floor at the fluent-reading limit the literature reports', () => {
    // 0.2 degrees of x-height is the consensus critical print size; the soft
    // floor exists to sit exactly there rather than under it.
    const degrees = xHeightDegreesForCapArcminutes(ANGULAR_SOFT_FLOOR_ARCMIN, metrics);
    expect(degrees).toBeCloseTo(0.2, 2);
    // And the hard floor is knowingly below it — a refusal point, not a target.
    const hard = xHeightDegreesForCapArcminutes(ANGULAR_HARD_FLOOR_ARCMIN, metrics);
    expect(hard as number).toBeLessThan(0.2);
  });

  it('measures horizontal angle across the glass', () => {
    const angle = horizontalAngleDegrees({ widthPx: 800, mmPerCssPx: 0.1926, distanceMm: 1200 });
    expect(angle).toBeCloseTo(7.35, 1);
  });
});

describe('reading measure', () => {
  it('knows one ch is wider than one character of prose', () => {
    // '0' is wider than mean lowercase, so a 34ch column holds MORE than 34
    // characters. Getting this backwards would silently narrow every column.
    expect(charactersPerCh(metrics)).toBeCloseTo(1.1, 5);
    expect(charactersForCh(34, metrics)).toBeGreaterThan(34);
    expect(chForCharacters(34, metrics)).toBeLessThan(34);
  });

  it('round-trips characters through ch', () => {
    expect(charactersForCh(chForCharacters(34, metrics), metrics)).toBeCloseTo(34, 6);
  });

  it('agrees between the ch path and the pixel path', () => {
    const widthPx = columnWidthPxForCh(34, 62, metrics);
    expect(charactersForWidthPx(widthPx, 62, metrics)).toBeCloseTo(
      charactersForCh(34, metrics),
      6,
    );
  });
});

describe('the bias control', () => {
  it('trades text size against how much text is on screen', () => {
    // 0 = more text on screen: smaller type, longer lines.
    expect(arcminutesForBias(0)).toBe(ANGULAR_PRESET_ARCMIN.compact);
    expect(charactersForBias(0)).toBe(READING_MEASURE.idealMax);
    // 1 = larger, easier text: bigger type, shorter lines.
    expect(arcminutesForBias(1)).toBe(ANGULAR_PRESET_ARCMIN.comfort);
    expect(charactersForBias(1)).toBe(READING_MEASURE.idealMin);
    // The two must move in OPPOSITE directions or the control is meaningless.
    expect(arcminutesForBias(0.75)).toBeGreaterThan(arcminutesForBias(0.25));
    expect(charactersForBias(0.75)).toBeLessThan(charactersForBias(0.25));
  });

  it('clamps a bias outside 0..1 rather than extrapolating off the ladder', () => {
    expect(arcminutesForBias(-5)).toBe(ANGULAR_PRESET_ARCMIN.compact);
    expect(arcminutesForBias(5)).toBe(ANGULAR_PRESET_ARCMIN.comfort);
    expect(arcminutesForBias(Number.NaN)).toBe(ANGULAR_PRESET_ARCMIN.compact);
  });
});

describe('hardware fit', () => {
  const base = {
    targetArcmin: ANGULAR_PRESET_ARCMIN.standard,
    targetCharacters: 34,
    metrics,
  };

  it('is the mechanism that explains the 9-inch panel, not a rare warning', () => {
    /*
     * This is the finding the whole width system rests on. At a comfortable
     * angular size, a 9-inch Prompter simply cannot show the mid-30s character
     * measure that wider research recommends. The right behaviour is to hold
     * the type size and report the narrower line honestly.
     */
    const fit = hardwareFitCheck({
      ...base,
      safeWidthPx: 1024,
      mmPerCssPx: mmPerCssPixel(PROMPTER_9),
      distanceMm: 1200,
    });
    expect(fit.verdict).toBe('width_limited');
    expect(fit.arcminutes).toBe(ANGULAR_PRESET_ARCMIN.standard);
    expect(fit.achievableCharacters as number).toBeGreaterThan(READING_MEASURE.hardFloor);
    expect(fit.achievableCharacters as number).toBeLessThan(34);
    expect(fit.fontSizePx as number).toBeCloseTo(62.1, 0);
  });

  it('finds the same request comfortable on the XL', () => {
    const fit = hardwareFitCheck({
      ...base,
      safeWidthPx: 1920,
      mmPerCssPx: mmPerCssPixel(PROMPTER_XL),
      distanceMm: 1200,
    });
    expect(fit.verdict).toBe('ok');
    expect(fit.achievableCharacters).toBe(34);
    expect(fit.advice).toBe('');
  });

  it('holds legibility and sacrifices measure, never the other way round', () => {
    // Far away on a small panel: type stays at the requested angle for as long
    // as the line can still carry context.
    const fit = hardwareFitCheck({
      ...base,
      safeWidthPx: 1024,
      mmPerCssPx: mmPerCssPixel(PROMPTER_9),
      distanceMm: 1600,
    });
    expect(fit.verdict).toBe('width_limited');
    expect(fit.arcminutes).toBe(ANGULAR_PRESET_ARCMIN.standard);
    expect(fit.advice).not.toBe('');
  });

  it('gives type up only once the line cannot reach the character floor', () => {
    /*
     * Expressed as the USABLE width, which is what the rung actually turns on,
     * rather than as a panel width that happens to produce it. The margin has
     * moved twice (0.92 -> 0.82 -> 0.76) and each time a literal panel width
     * here silently walked this scenario into the next rung along, testing
     * something other than the boundary it is named for.
     *
     * ~396px of usable width: narrow enough that the character floor cannot be
     * reached at the requested angle, wide enough that dropping to the soft
     * angular floor rescues it.
     */
    const fit = hardwareFitCheck({
      ...base,
      safeWidthPx: 396 / MAX_COLUMN_FRACTION,
      mmPerCssPx: mmPerCssPixel(PROMPTER_9),
      distanceMm: 1400,
    });
    expect(fit.verdict).toBe('angle_limited');
    expect(fit.achievableCharacters).toBe(READING_MEASURE.hardFloor);
    expect(fit.arcminutes as number).toBeLessThan(ANGULAR_PRESET_ARCMIN.standard);
    expect(fit.arcminutes as number).toBeGreaterThanOrEqual(ANGULAR_SOFT_FLOOR_ARCMIN);
  });

  it('says the rig is impossible rather than quietly producing unreadable text', () => {
    const fit = hardwareFitCheck({
      ...base,
      safeWidthPx: 300,
      mmPerCssPx: mmPerCssPixel(PROMPTER_9),
      distanceMm: 2500,
    });
    expect(fit.verdict).toBe('impossible');
    expect(fit.advice).toContain('too small');
  });

  it('declines to make an angular claim with no physical scale', () => {
    const fit = hardwareFitCheck({
      ...base,
      safeWidthPx: 1024,
      mmPerCssPx: null,
      distanceMm: 1200,
    });
    expect(fit.verdict).toBe('uncalibrated');
    expect(fit.fontSizePx).toBeNull();
    expect(fit.arcminutes).toBeNull();
  });
});

describe('secondary text floor', () => {
  it('is two thirds of body when there is nothing else to go on', () => {
    expect(secondaryTextFloorPx({ bodyFontSizePx: 60, context: null })).toBeCloseTo(40.2, 5);
  });

  it('does not let small body text drag its own labels under the angular floor', () => {
    // A deliberately tiny body size: the proportional rule alone would put
    // secondary text at 16px, which nobody can read from 1.5m.
    const context = contextFor(PROMPTER_9, 1500);
    const floor = secondaryTextFloorPx({ bodyFontSizePx: 24, context });
    expect(floor).toBeGreaterThan(24 * 0.67);
    expect(arcminutesForFontSizePx(floor, context)).toBeCloseTo(ANGULAR_HARD_FLOOR_ARCMIN, 4);
  });
});

describe('font metrics normalisation', () => {
  it('accepts a plausible measurement', () => {
    const measured: FontMetrics = {
      capHeightRatio: 0.72,
      xHeightRatio: 0.52,
      avgCharWidthRatio: 0.49,
      zeroAdvanceRatio: 0.56,
      measured: true,
    };
    expect(normalizeFontMetrics(measured)).toEqual(measured);
  });

  it('rejects a whole measurement rather than patching part of it', () => {
    /*
     * All-or-nothing on purpose, for the same reason the motion profile falls
     * back wholesale on a version mismatch: a half-applied measurement is a
     * third set of proportions that nobody tuned or tested against.
     */
    const partlyBad = {
      capHeightRatio: 0.72,
      xHeightRatio: 0.52,
      avgCharWidthRatio: 0,
      zeroAdvanceRatio: 0.56,
      measured: true,
    };
    expect(normalizeFontMetrics(partlyBad)).toEqual(fallbackFontMetrics());
  });

  it('rejects an x-height taller than the cap height', () => {
    expect(
      normalizeFontMetrics({
        capHeightRatio: 0.5,
        xHeightRatio: 0.6,
        avgCharWidthRatio: 0.5,
        zeroAdvanceRatio: 0.55,
        measured: true,
      }),
    ).toEqual(fallbackFontMetrics());
  });

  it('falls back for a missing or empty measurement', () => {
    expect(normalizeFontMetrics(null)).toEqual(fallbackFontMetrics());
    expect(normalizeFontMetrics(undefined)).toEqual(fallbackFontMetrics());
    expect(normalizeFontMetrics({})).toEqual(fallbackFontMetrics());
  });

  it('marks the fallback as unmeasured so the UI can say so', () => {
    expect(fallbackFontMetrics().measured).toBe(false);
  });
});
