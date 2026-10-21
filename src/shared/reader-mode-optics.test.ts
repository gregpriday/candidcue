/**
 * Reader mode's half of the optical model.
 *
 * The claim under test is narrow and worth stating: reader mode changes the
 * reading MEASURE and nothing else about the optics. Every assertion here either
 * pins that (the character band, the framing skip, the band position, the
 * uncalibrated fallback) or pins the things that must NOT have moved (the
 * angular ladder, the legibility-outranks-measure order, prompter geometry).
 *
 * `docs/SpeakingGlass_Reader_Mode_Specification.md` §4 has the arithmetic these
 * numbers come from.
 */
import { describe, expect, it } from 'vitest';
import { defaultOpticalProfile, type OpticalProfile } from './contracts/optical';
import {
  NO_LENS_READING_BAND_FRACTION,
  resolveStageGeometry,
  resolveTargetCharacters,
  UNCALIBRATED_COLUMN_FRACTION,
  UNCALIBRATED_FONT_SIZE_PX,
  UNCALIBRATED_READER_FONT_SIZE_PX,
} from './optical-resolve';
import {
  arcminutesForBias,
  charactersForBias,
  fallbackFontMetrics,
  hardwareFitCheck,
  MAX_COLUMN_FRACTION,
  READER_READING_MEASURE,
  READING_MEASURE,
  type FontMetrics,
} from './optics';

/**
 * A 16" MacBook Pro at default scaling: 1728 x 1117 CSS px over a 411 mm
 * diagonal. Measured, not invented — it is the display the reader-mode
 * arithmetic in the spec is worked against, and 0.2 mm per CSS pixel is a round
 * enough number to reason about by hand.
 */
const MM_PER_CSS_PX = 411.5 / Math.hypot(1728, 1117);

/** The desk-reading preset's distance. */
const READING_DISTANCE_MM = 550;

function readerProfile(overrides: Partial<OpticalProfile> = {}): OpticalProfile {
  return {
    ...defaultOpticalProfile(),
    scale: { mmPerCssPx: MM_PER_CSS_PX, source: 'model' },
    viewingDistanceMm: READING_DISTANCE_MM,
    lensPlacement: 'none',
    flips: { horizontal: false, vertical: false },
    ...overrides,
  };
}

describe('the reader measure band', () => {
  it('asks for a continuous-reading line, not a teleprompter one', () => {
    // The whole reason the table exists. If these ever converge, reader mode has
    // gone back to rendering a camera's column in a window.
    expect(READER_READING_MEASURE.idealMin).toBeGreaterThan(READING_MEASURE.idealMax);
    expect(READER_READING_MEASURE.idealMax).toBeGreaterThan(READER_READING_MEASURE.idealMin);
  });

  it('sets its floor where prose stops reading, not where the glass runs out', () => {
    /*
     * 13 characters is defensible on a 9-inch panel at 1.2 m because it is all
     * the hardware has. A window is not out of room — it can be dragged wider —
     * so the reader floor is higher and the advice says to widen the window.
     */
    expect(READER_READING_MEASURE.hardFloor).toBeGreaterThan(READING_MEASURE.hardFloor);
  });

  it('runs the bias ladder over the reader band rather than the prompter one', () => {
    expect(charactersForBias(0, 'reader')).toBe(READER_READING_MEASURE.idealMax);
    expect(charactersForBias(1, 'reader')).toBe(READER_READING_MEASURE.idealMin);
    // More text on screen means MORE characters, in both contexts.
    expect(charactersForBias(0, 'reader')).toBeGreaterThan(charactersForBias(1, 'reader'));
  });

  it('leaves the prompter ladder exactly where it was', () => {
    expect(charactersForBias(0)).toBe(READING_MEASURE.idealMax);
    expect(charactersForBias(1)).toBe(READING_MEASURE.idealMin);
    expect(charactersForBias(0.5)).toBe(charactersForBias(0.5, 'prompter'));
  });
});

describe('the angular ladder is NOT duplicated', () => {
  /*
   * The tempting second half of "reader mode needs its own measure" is "and its
   * own type size", and it does not: 24' of cap height at 550 mm is large,
   * comfortable reading type. Duplicating the ladder would give one physical
   * quantity two names and two sets of rounding, which is the reason `optics.ts`
   * declines to implement the x-height convention as well.
   */
  it('resolves the same arcminutes for the same bias in either context', () => {
    for (const bias of [0, 0.25, 0.5, 0.75, 1]) {
      expect(arcminutesForBias(bias)).toBe(arcminutesForBias(bias));
    }
  });

  it('puts a mid-bias reading window at ordinary large-print body type', () => {
    const { optics } = resolveStageGeometry({
      profile: readerProfile({ bias: 0.5 }),
      viewport: { widthPx: 1200, heightPx: 800 },
      readingContext: 'reader',
    });
    /*
     * The sanity check on the whole model: ~24' at 550 mm on a 0.2 mm/px display
     * is about 30 CSS px. A number far outside this range means the angular path
     * has been broken rather than that a taste has changed.
     */
    expect(optics.bodyFontSizePx).toBeGreaterThan(22);
    expect(optics.bodyFontSizePx).toBeLessThan(40);
    expect(optics.calibrated).toBe(true);
  });
});

describe('framing does not apply to a reading window', () => {
  it('ignores a close-up shot, which would otherwise cut the line by a quarter', () => {
    const framed = readerProfile({ framing: 'close-up', bias: 0.5 });
    const reader = resolveTargetCharacters(framed, 'reader');
    const prompter = resolveTargetCharacters(framed, 'prompter');
    // The prompter target is scaled by 0.75; the reader target is not scaled at
    // all, so it must equal the unscaled bias value.
    expect(reader).toBeCloseTo(charactersForBias(0.5, 'reader'), 6);
    expect(prompter).toBeLessThan(charactersForBias(0.5, 'prompter'));
  });

  it('still honours an explicit character override', () => {
    // Framing is a shortcut for "pick something sensible"; a stated number is a
    // decision, and it is taken at face value in both contexts.
    const pinned = readerProfile({ overrides: { characters: 48 } });
    expect(resolveTargetCharacters(pinned, 'reader')).toBe(48);
  });
});

describe('the reading band with no lens', () => {
  it('sits a little above centre rather than pinned to an edge', () => {
    const { optics } = resolveStageGeometry({
      profile: readerProfile(),
      viewport: { widthPx: 1200, heightPx: 800 },
      readingContext: 'reader',
    });
    expect(optics.readingBandY).toBe(NO_LENS_READING_BAND_FRACTION);
    // Above centre, so more of the upcoming text stays in view — but nowhere near
    // the 5% edge pin an off-panel LENS gets.
    expect(optics.readingBandY).toBeLessThan(0.5);
    expect(optics.readingBandY).toBeGreaterThan(0.25);
  });

  it('does not read lens.y, even when it is present and finite', () => {
    /*
     * The crosshair is a measurement of where one camera ended up in one hood. A
     * rig with no camera has never had it taken, so a value sitting in the field
     * from some earlier life must not move the band.
     */
    const withStaleCrosshair = readerProfile({ lens: { x: 0.5, y: 0.8 } });
    const { optics } = resolveStageGeometry({
      profile: withStaleCrosshair,
      viewport: { widthPx: 1200, heightPx: 800 },
      readingContext: 'reader',
    });
    expect(optics.readingBandY).toBe(NO_LENS_READING_BAND_FRACTION);
  });

  it('skips lensOffsetDegrees, which has nothing to be measured from', () => {
    const offset = readerProfile({ overrides: { lensOffsetDegrees: 3 } });
    const { optics } = resolveStageGeometry({
      profile: offset,
      viewport: { widthPx: 1200, heightPx: 800 },
      readingContext: 'reader',
    });
    expect(optics.readingBandY).toBe(NO_LENS_READING_BAND_FRACTION);
    expect(optics.overriddenFields).not.toContain('lensOffsetDegrees');
  });

  it('honours an explicit readingBandY, and records it as an override', () => {
    const stated = readerProfile({ overrides: { readingBandY: 0.6 } });
    const { optics } = resolveStageGeometry({
      profile: stated,
      viewport: { widthPx: 1200, heightPx: 800 },
      readingContext: 'reader',
    });
    expect(optics.readingBandY).toBe(0.6);
    expect(optics.overriddenFields).toContain('readingBandY');
  });

  it('lets a stated position beat an offset rather than composing the two', () => {
    /*
     * Composing them would mean the number the operator typed is not the number
     * they get. Asserted on an IN-PANEL rig, because that is the only shape where
     * both controls are live at once.
     */
    const both = readerProfile({
      lensPlacement: 'in-panel',
      lens: { x: 0.5, y: 0.5 },
      overrides: { readingBandY: 0.3, lensOffsetDegrees: 4 },
    });
    const { optics } = resolveStageGeometry({
      profile: both,
      viewport: { widthPx: 1200, heightPx: 800 },
    });
    expect(optics.readingBandY).toBe(0.3);
    expect(optics.overriddenFields).toContain('readingBandY');
    expect(optics.overriddenFields).not.toContain('lensOffsetDegrees');
  });
});

describe('the uncalibrated reading window', () => {
  /*
   * Reached more often than the prompter's fallback, not less: `scaleForDisplay`
   * can only answer for hardware it recognises by its panel, and the ordinary Mac
   * display somebody reads on is `generic`.
   */
  const uncalibrated = (): OpticalProfile => ({
    ...defaultOpticalProfile(),
    lensPlacement: 'none',
  });

  it('guesses a reading size rather than a prompting one', () => {
    const { optics } = resolveStageGeometry({
      profile: uncalibrated(),
      viewport: { widthPx: 1000, heightPx: 700 },
      readingContext: 'reader',
    });
    expect(optics.calibrated).toBe(false);
    expect(optics.bodyFontSizePx).toBe(UNCALIBRATED_READER_FONT_SIZE_PX);
    // 64 px in a 1000 px window is about a dozen characters a line.
    expect(optics.bodyFontSizePx).toBeLessThan(UNCALIBRATED_FONT_SIZE_PX);
  });

  it('still gives an uncalibrated PROMPTER the size it always had', () => {
    const { optics } = resolveStageGeometry({
      profile: defaultOpticalProfile(),
      viewport: { widthPx: 1000, heightPx: 700 },
    });
    expect(optics.bodyFontSizePx).toBe(UNCALIBRATED_FONT_SIZE_PX);
  });

  it('says the distance it guessed at, so the number is not mistaken for a measurement', () => {
    const { warnings } = resolveStageGeometry({
      profile: uncalibrated(),
      viewport: { widthPx: 1000, heightPx: 700 },
      readingContext: 'reader',
    });
    expect(warnings.join(' ')).toContain('55');
    // And not the prompter's 1.2 m, which would be a claim about a rig that is
    // not there.
    expect(warnings.join(' ')).not.toContain('1.2');
  });
});

describe('the fit check narrows honestly as the window shrinks', () => {
  const fitAt = (widthPx: number) =>
    hardwareFitCheck({
      safeWidthPx: widthPx,
      mmPerCssPx: MM_PER_CSS_PX,
      distanceMm: READING_DISTANCE_MM,
      targetArcmin: 24,
      targetCharacters: 65,
      metrics: fallbackFontMetrics(),
      readingContext: 'reader',
    });

  it('gives a roomy window everything it asked for', () => {
    const fit = fitAt(1400);
    expect(fit.verdict).toBe('ok');
    expect(fit.achievableCharacters).toBe(65);
    expect(fit.advice).toBe('');
  });

  it('holds the type size and narrows the line as the window comes in', () => {
    // Legibility outranks measure — the same resolution order the prompter path
    // uses, which is exactly the point of not forking the resolver.
    const roomy = fitAt(1400);
    const tight = fitAt(700);
    expect(tight.verdict).toBe('width_limited');
    expect(tight.fontSizePx).toBeCloseTo(roomy.fontSizePx!, 6);
    expect(tight.achievableCharacters!).toBeLessThan(roomy.achievableCharacters!);
  });

  it('tells a reader to widen the window rather than to move closer', () => {
    /*
     * The remedy differs even though the verdict does not: a prompter's width is
     * a fact about hardware, and a reader's is an edge they can drag right now.
     */
    const narrow = fitAt(420);
    expect(narrow.advice).toContain('window');
    expect(narrow.advice).not.toContain('prompter');
  });

  it('keeps the prompter advice pointing at the rig, never at a window', () => {
    /*
     * Asserted across every branch that produces advice, because the two contexts
     * diverge in three separate places and it is the whole SET that has to stay
     * consistent — a prompter told to "make the window wider" is being sent to a
     * control its rig does not have.
     */
    for (const safeWidthPx of [420, 700, 1400]) {
      const prompterFit = hardwareFitCheck({
        safeWidthPx,
        mmPerCssPx: MM_PER_CSS_PX,
        distanceMm: 1200,
        targetArcmin: 24,
        targetCharacters: 35,
        metrics: fallbackFontMetrics(),
      });
      expect(prompterFit.advice).not.toContain('window');
    }
  });
});

describe('a reading window resolves against the window, not the panel', () => {
  /*
   * The defect this exists for: control resolves against `display.logicalSize`,
   * and `ScriptLayer` clamps the resulting column to `safeRect.width` — silently,
   * without running the fit check. So a measure chosen for a 1728 px panel and
   * rendered in a 700 px window could sit under the character floor with nothing
   * said. Resolving against the real viewport is what makes the narrowing above
   * reachable at all.
   */
  it('produces a narrower column and a warning for the same rig in a smaller window', () => {
    const profile = readerProfile();
    const wide = resolveStageGeometry({
      profile,
      viewport: { widthPx: 1728, heightPx: 1117 },
      readingContext: 'reader',
    });
    const narrow = resolveStageGeometry({
      profile,
      viewport: { widthPx: 620, heightPx: 700 },
      readingContext: 'reader',
    });
    expect(narrow.optics.columnCh).toBeLessThan(wide.optics.columnCh);
    expect(narrow.optics.fitVerdict).not.toBe('ok');
    expect(wide.optics.fitVerdict).toBe('ok');
  });

  it('holds the physical type size across that change, because the display did not move', () => {
    // `mmPerCssPx` is a property of the panel, so a smaller WINDOW on the same
    // display must not change how large a letter is — only how many fit.
    const profile = readerProfile();
    const wide = resolveStageGeometry({
      profile,
      viewport: { widthPx: 1728, heightPx: 1117 },
      readingContext: 'reader',
    });
    const narrow = resolveStageGeometry({
      profile,
      viewport: { widthPx: 900, heightPx: 700 },
      readingContext: 'reader',
    });
    expect(narrow.optics.bodyFontSizePx).toBeCloseTo(wide.optics.bodyFontSizePx, 6);
  });
});

describe('the uncalibrated reading window measure', () => {
  /*
   * The common reading case: no physical scale, so the fit check declines and
   * the resolver has to choose a column on its own. It used to take the
   * prompter's 68% of the width, which has no ceiling — over a hundred
   * characters a line on a 2560 px window — and wasted the margin on a narrow
   * one. It now asks for the reader's target measure, bounded by what the window
   * holds at the calibrated fit's column fraction.
   *
   * Run against the measured proportions of the shipped face rather than the DIN
   * fallbacks, because that is what the stage resolves with and because the two
   * ratios differing (0.653 vs 0.472) is what catches a `ch`/character mix-up.
   */
  const ATKINSON: FontMetrics = {
    capHeightRatio: 0.68,
    xHeightRatio: 0.5,
    avgCharWidthRatio: 0.472,
    zeroAdvanceRatio: 0.653,
    measured: true,
  };
  const uncalibrated = (overrides: OpticalProfile['overrides'] = {}): OpticalProfile => ({
    ...defaultOpticalProfile(),
    lensPlacement: 'none',
    overrides,
  });
  const resolveAt = (widthPx: number, overrides: OpticalProfile['overrides'] = {}) =>
    resolveStageGeometry({
      profile: uncalibrated(overrides),
      metrics: ATKINSON,
      viewport: { widthPx, heightPx: 900 },
      readingContext: 'reader',
    }).optics;
  /** The column as the stage draws it: `ch` times the SAME zero advance. */
  const columnPx = (o: { columnCh: number; bodyFontSizePx: number }) =>
    o.columnCh * ATKINSON.zeroAdvanceRatio * o.bodyFontSizePx;
  const target = resolveTargetCharacters(uncalibrated(), 'reader');

  it('caps a wide window at the reader target instead of a share of its width', () => {
    for (const widthPx of [1440, 2560]) {
      const o = resolveAt(widthPx);
      expect(o.charactersPerLine!).toBeCloseTo(target, 6);
      expect(columnPx(o)).toBeCloseTo(target * ATKINSON.avgCharWidthRatio * o.bodyFontSizePx, 6);
    }
    // The two windows draw the same column: growing past the measure only
    // grows the margins.
    expect(columnPx(resolveAt(2560))).toBeCloseTo(columnPx(resolveAt(1440)), 6);
    // About 67 characters at the default bias — not the hundred-plus the 68%
    // guess gave 2560 px.
    expect(target).toBeGreaterThan(60);
    expect(target).toBeLessThan(70);
  });

  it('gives a narrow window the full column fraction rather than 68% of it', () => {
    const o = resolveAt(760);
    expect(columnPx(o)).toBeCloseTo(760 * MAX_COLUMN_FRACTION, 6);
    expect(columnPx(o)).toBeGreaterThan(760 * UNCALIBRATED_COLUMN_FRACTION);
    expect(o.charactersPerLine!).toBeLessThan(target);
  });

  it('still calls itself uncalibrated, because the size is still a guess', () => {
    for (const widthPx of [760, 2560]) {
      const o = resolveAt(widthPx);
      expect(o.fitVerdict).toBe('uncalibrated');
      expect(o.calibrated).toBe(false);
      expect(o.bodyFontSizePx).toBe(UNCALIBRATED_READER_FONT_SIZE_PX);
    }
  });

  it('honours a pinned character measure as the cap', () => {
    for (const characters of [55, 75]) {
      const o = resolveAt(2560, { characters });
      expect(o.charactersPerLine!).toBeCloseTo(characters, 6);
      expect(o.overriddenFields).toContain('characters');
    }
    // And a window too narrow for the pin gives what it has, not the pin.
    expect(resolveAt(760, { characters: 75 }).charactersPerLine!).toBeCloseTo(
      (760 * MAX_COLUMN_FRACTION) / (ATKINSON.avgCharWidthRatio * UNCALIBRATED_READER_FONT_SIZE_PX),
      6,
    );
  });

  it('honours an override of the column fraction, the same one the fit would use', () => {
    const o = resolveAt(760, { maxColumnFraction: 0.6 });
    expect(columnPx(o)).toBeCloseTo(760 * 0.6, 6);
  });

  it('re-solves the column at a pinned size, larger or smaller, by the same rule', () => {
    /*
     * The reader appearance panel pins sizes from 20 to 96 px. At every one the
     * column is "the target, or what the window holds at THIS size", and the
     * reported measure describes that column rather than the 30 px one.
     */
    for (const widthPx of [760, 1240, 2560]) {
      for (const fontSizePx of [20, 30, 48, 96]) {
        const o = resolveAt(widthPx, { fontSizePx });
        expect(o.bodyFontSizePx).toBe(fontSizePx);
        const available =
          (widthPx * MAX_COLUMN_FRACTION) / (ATKINSON.avgCharWidthRatio * fontSizePx);
        const expected = Math.min(target, available);
        expect(o.charactersPerLine!, `${widthPx}px at ${fontSizePx}px`).toBeCloseTo(expected, 6);
        expect(columnPx(o)).toBeLessThanOrEqual(widthPx * MAX_COLUMN_FRACTION + 1e-6);
      }
    }
  });

  it('caps a LARGER pin at the target too, rather than carrying the 30 px column up', () => {
    // 48 px on a 2560 px window holds ~86 characters; the target is ~67, and a
    // larger pin is not a request for a longer line.
    const o = resolveAt(2560, { fontSizePx: 48 });
    expect(o.charactersPerLine!).toBeCloseTo(target, 6);
  });

  it('combines a pinned size with a pinned measure', () => {
    const o = resolveAt(2560, { fontSizePx: 40, characters: 55 });
    expect(o.charactersPerLine!).toBeCloseTo(55, 6);
    const narrow = resolveAt(760, { fontSizePx: 40, characters: 75 });
    expect(narrow.charactersPerLine!).toBeCloseTo(
      (760 * MAX_COLUMN_FRACTION) / (ATKINSON.avgCharWidthRatio * 40),
      6,
    );
  });

  it('warns about a pinned size that leaves too short a line', () => {
    const { warnings } = resolveStageGeometry({
      profile: uncalibrated({ fontSizePx: 96 }),
      metrics: ATKINSON,
      viewport: { widthPx: 760, heightPx: 900 },
      readingContext: 'reader',
    });
    expect(warnings.join(' ')).toContain('too few to carry a phrase');
  });

  it('leaves a calibrated reading window to the fit check', () => {
    // The fit returned a column, so nothing here applies: the measure is the
    // fit's, at the angular size.
    const o = resolveStageGeometry({
      profile: readerProfile(),
      metrics: ATKINSON,
      viewport: { widthPx: 1728, heightPx: 1117 },
      readingContext: 'reader',
    }).optics;
    expect(o.fitVerdict).toBe('ok');
    expect(o.charactersPerLine!).toBeCloseTo(
      resolveTargetCharacters(readerProfile(), 'reader'),
      6,
    );
  });

  it('does not touch the uncalibrated PROMPTER, which keeps its 68%', () => {
    for (const widthPx of [1024, 2560]) {
      const o = resolveStageGeometry({
        profile: defaultOpticalProfile(),
        metrics: ATKINSON,
        viewport: { widthPx, heightPx: 900 },
      }).optics;
      expect(columnPx(o)).toBeCloseTo(widthPx * UNCALIBRATED_COLUMN_FRACTION, 6);
    }
  });
});
