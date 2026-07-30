/**
 * Reader mode's half of the optical model.
 *
 * The claim under test is narrow and worth stating: reader mode changes the
 * reading MEASURE and nothing else about the optics. Every assertion here either
 * pins that (the character band, the framing skip, the band position, the
 * uncalibrated fallback) or pins the things that must NOT have moved (the
 * angular ladder, the legibility-outranks-measure order, prompter geometry).
 *
 * `docs/CandidCue_Reader_Mode_Specification.md` §4 has the arithmetic these
 * numbers come from.
 */
import { describe, expect, it } from 'vitest';
import { defaultOpticalProfile, type OpticalProfile } from './contracts/optical';
import {
  NO_LENS_READING_BAND_FRACTION,
  resolveStageGeometry,
  resolveTargetCharacters,
  UNCALIBRATED_FONT_SIZE_PX,
  UNCALIBRATED_READER_FONT_SIZE_PX,
} from './optical-resolve';
import {
  arcminutesForBias,
  charactersForBias,
  fallbackFontMetrics,
  hardwareFitCheck,
  READER_READING_MEASURE,
  READING_MEASURE,
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
