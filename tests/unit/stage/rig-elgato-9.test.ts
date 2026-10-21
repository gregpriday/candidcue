/**
 * The 9-inch Elgato Prompter, end to end.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS RIG GETS ITS OWN SUITE
 * ---------------------------------------------------------------------------
 * 1024 x 600 is the tightest hardware Speaking Glass supports and it is the panel
 * the product is actually used on. Every generic guarantee in the optical layer
 * — five to seven visible lines, a usable reading measure, a comfortable
 * angular size — is easy to satisfy on a 1080p panel and genuinely hard here.
 * A regression that only shows up at 600 px of height would not be caught by
 * any other test in the suite, and would be discovered on a rig, mid-take.
 *
 * This file therefore asserts the SPECIFIC numbers this panel produces rather
 * than general properties. If a default moves, these break, and that is the
 * point: a default change that quietly costs the 9-inch panel a line of
 * upcoming script is exactly the thing that should require a human to look at
 * it.
 *
 * It also documents the honest limits. The 9-inch panel cannot do everything —
 * at 1.5 m it runs short of upcoming context, and no amount of layout cleverness
 * changes that. What the code owes the operator there is a straight answer, and
 * the last group of tests is about that answer being straight.
 */
import { describe, expect, it } from 'vitest';
import {
  computeReadingBand,
  computeSafeRect,
  lineBudget,
  stagePaddingPx,
  TARGET_LINES_BELOW_BAND,
} from '../../../src/stage/renderer/geometry';
import { resolveStageGeometry } from '../../../src/shared/optical-resolve';
import {
  OPTICAL_HARDWARE,
  defaultOpticalProfile,
  type OpticalProfile,
} from '../../../src/shared/contracts/optical';
import {
  ANGULAR_PRESET_ARCMIN,
  ANGULAR_SOFT_FLOOR_ARCMIN,
  READING_MEASURE,
  fallbackFontMetrics,
  inchesToMm,
  mmPerCssPixel,
} from '../../../src/shared/optics';

/** The panel: 9-inch diagonal, 1024 x 600, driven 1:1. */
const VIEWPORT = { widthPx: 1024, heightPx: 600 };
const MM_PER_PX = mmPerCssPixel({
  diagonalMm: inchesToMm(9),
  widthPx: VIEWPORT.widthPx,
  heightPx: VIEWPORT.heightPx,
}) as number;

/** Default line height for the resolved stage. */
const LINE_HEIGHT = 1.38;

function rig(distanceMm: number, overrides: Partial<OpticalProfile> = {}): OpticalProfile {
  return {
    ...defaultOpticalProfile(),
    rigName: 'Desk hood',
    hardwareKind: 'elgato-prompter',
    scale: { mmPerCssPx: MM_PER_PX, source: 'model', diagonalMm: inchesToMm(9) },
    viewingDistanceMm: distanceMm,
    ...overrides,
  };
}

/** Resolve the rig, then answer the vertical questions the presenter feels. */
function budgetFor(distanceMm: number, overrides: Partial<OpticalProfile> = {}) {
  const profile = rig(distanceMm, overrides);
  const { optics } = resolveStageGeometry({ profile, viewport: VIEWPORT });
  const safeRect = computeSafeRect(VIEWPORT.widthPx, VIEWPORT.heightPx, optics.safeArea);
  const linePitchPx = optics.bodyFontSizePx * LINE_HEIGHT;
  const band = computeReadingBand(VIEWPORT.heightPx, {
    centerPercent: optics.readingBandY * 100,
    halfHeightPercent: 4,
    linePitchPx,
    deadZoneLines: optics.deadZoneLines,
  });
  const input = {
    safeRect,
    // The scroll plane is `inset: 0`, so the padding is solved against the
    // whole panel even when a hood hides part of it.
    viewportHeightPx: VIEWPORT.heightPx,
    bandCenterPx: band.centerPx,
    linePitchPx,
    futureReserveLines: optics.futureReserveLines,
  };
  return { optics, band, linePitchPx, budget: lineBudget(input), padding: stagePaddingPx(input) };
}

describe('the panel itself', () => {
  it('is a low-density display, which is why fractional transforms matter here', () => {
    // 0.193 mm per pixel, driven 1:1. There is no Retina subpixel budget to
    // hide a half-pixel scroll offset in, so text at rest must land on the grid.
    expect(MM_PER_PX).toBeCloseTo(0.1926, 4);
  });
});

describe('desk distance — the way this rig is actually used', () => {
  it('shows six or seven lines at 1.0-1.2 m', () => {
    /*
     * The headline guarantee. Five useful lines is the floor for a comfortable
     * read and this panel clears it at desk distance with room to spare — which
     * is not obvious at 600px and is the whole reason the vh constants had to
     * go. The old compact breakpoint hard-coded 34/60 vh for this panel; the
     * derived geometry beats it without a special case.
     */
    for (const distance of [1000, 1200]) {
      const { budget } = budgetFor(distance);
      // Bounded on BOTH sides: "six or seven" is the claim, and an unbounded
      // lower assertion would pass just as happily at twenty lines, which would
      // mean the type had silently collapsed.
      expect(budget.total).toBeGreaterThanOrEqual(6);
      expect(budget.total).toBeLessThanOrEqual(7);
      expect(budget.below).toBeGreaterThanOrEqual(TARGET_LINES_BELOW_BAND);
      expect(budget.above).toBeGreaterThanOrEqual(1);
      expect(budget.sufficient).toBe(true);
      expect(budget.advice).toBe('');
    }
  });

  it('keeps text above the fluent-reading floor at desk distance', () => {
    const { optics } = budgetFor(1200);
    expect(optics.bodyArcminutes as number).toBeGreaterThanOrEqual(ANGULAR_SOFT_FLOOR_ARCMIN);
  });

  it('does not nag about line width at the distance this rig is used from', () => {
    /*
     * `width_limited` is the NORMAL verdict on a 9-inch panel — it is what the
     * physics gives — so it must not come with a complaint attached at ordinary
     * working distance. Advice fires only once the measure drops under the
     * acceptable band, which at 1.0-1.2 m it does not.
     *
     * A warning that appears on every single take is not a warning, it is
     * furniture, and the operator stops reading it before the one time it
     * matters.
     */
    for (const distance of [1000, 1200]) {
      const { optics } = budgetFor(distance);
      expect(optics.fitAdvice).toBe('');
      expect(optics.charactersPerLine as number).toBeGreaterThanOrEqual(24);
    }
  });

  it('still fits five lines at the most generous text size', () => {
    // Comfort sizing costs context; it must not cost so much that the reader
    // runs out of upcoming script.
    const { budget, optics } = budgetFor(1200, { bias: 1 });
    expect(optics.bodyArcminutes as number).toBeCloseTo(ANGULAR_PRESET_ARCMIN.comfort, 0);
    expect(budget.total).toBeGreaterThanOrEqual(5);
  });
});

describe('padding actually lets the first and last words reach the band', () => {
  it('puts the opening line at the reading band with no negative scroll', () => {
    const { padding, band, linePitchPx } = budgetFor(1200);
    const safeTop = 0;
    const firstLineCentreAtRest = safeTop + padding.topPx + linePitchPx / 2;
    expect(firstLineCentreAtRest).toBeCloseTo(band.centerPx, 6);
  });

  it('leaves run-out below the closing line rather than stopping at a wall', () => {
    const { padding, linePitchPx, optics } = budgetFor(1200);
    // The reserve is additive run-out: nothing targets it, it only widens the
    // clamp so the script eases to a halt instead of hitting the end mid-word.
    expect(padding.bottomPx).toBeGreaterThan(optics.futureReserveLines * linePitchPx);
  });
});

describe('the honest limits of a 9-inch panel', () => {
  it('still just holds the reserve at 1.5 m', () => {
    // Marginal, and worth pinning as marginal: it meets the three-line reserve
    // exactly, so any future increase in default type size costs it.
    const { budget } = budgetFor(1500);
    expect(budget.below).toBe(TARGET_LINES_BELOW_BAND);
    expect(budget.sufficient).toBe(true);
  });

  it('runs short of upcoming context at its rated maximum, and says so plainly', () => {
    /*
     * Elgato rates this panel to 1.8 m, and it is legible there — but legible
     * and comfortable are different claims. At that distance the type needed for
     * a decent angular size costs enough vertical room that the three-line
     * reserve no longer fits, and the reader starts arriving at the bottom of
     * what they can see.
     *
     * The correct behaviour is to report it, not to silently shrink the text to
     * manufacture the missing line. That trade — legibility for fullness — is
     * the operator's to make, and they can only make it if they are told.
     */
    const { budget } = budgetFor(1800);
    expect(budget.below).toBeLessThan(TARGET_LINES_BELOW_BAND);
    expect(budget.sufficient).toBe(false);
    expect(budget.advice).toContain('upcoming script');
  });

  it('names a remedy the operator can actually act on', () => {
    const { budget } = budgetFor(1800);
    // Smaller text, a taller safe area, or a higher band — all three are things
    // somebody standing at the rig can change.
    expect(budget.advice.toLowerCase()).toMatch(/smaller text|safe area|reading band/);
  });

  it('recovers the reserve through the remedy the advice names first', () => {
    /*
     * The advice has to be true, and it is worth checking WHICH of its three
     * remedies actually works here. Smaller text does, immediately.
     *
     * Moving the band up is listed second and is much weaker at this distance:
     * a 124px line pitch against 600px of panel means the band has to travel a
     * long way before the floor division yields another whole line, so a
     * reasonable adjustment buys nothing. That is a real limitation of the
     * remedy rather than of the advice, but it is the reason the order matters.
     */
    const shrunk = budgetFor(1800, { overrides: { arcminutes: ANGULAR_SOFT_FLOOR_ARCMIN } });
    expect(shrunk.budget.below).toBeGreaterThanOrEqual(TARGET_LINES_BELOW_BAND);
    expect(shrunk.budget.sufficient).toBe(true);
  });

  it('runs out of both at 2.5 m, and gives type up only after the line', () => {
    /*
     * At 2.5 m this panel is well outside Elgato's 1.8 m rating, and the
     * resolution order shows its teeth. The line narrows first, all the way to
     * the 13-character floor; only then does type start to give way, and only
     * as far as the soft angular floor.
     *
     * This rig used to stop at the first of those (`width_limited`, ~13.4
     * characters at the full 23.2'). It reaches the second now because the
     * designed column margin widened (`MAX_COLUMN_FRACTION`, 0.82 -> 0.76):
     * with ~62px less to lay a line in, 2.5 m can no longer hold thirteen
     * characters at the requested size, so the model trades about an
     * arcminute to keep them. That is the documented order working rather
     * than a regression — type gives way LAST, and stops well above the 18'
     * floor — but it is a rung this panel now reaches at a distance it did
     * not before, which is worth having written down.
     */
    const { optics } = budgetFor(2500);
    expect(optics.fitVerdict).toBe('angle_limited');
    expect(optics.charactersPerLine as number).toBeLessThan(18);
    // The line was held at its floor rather than allowed to collapse further.
    expect(optics.charactersPerLine as number).toBeGreaterThanOrEqual(READING_MEASURE.hardFloor);
    // And the type it gave up stops above the floor the evidence puts it at.
    expect(optics.bodyArcminutes as number).toBeGreaterThanOrEqual(ANGULAR_SOFT_FLOOR_ARCMIN);
    expect(optics.bodyArcminutes as number).toBeLessThan(ANGULAR_PRESET_ARCMIN.standard);
    expect(optics.fitAdvice).not.toBe('');
  });

  it('keeps the manufacturer rating available so the wizard can warn earlier', () => {
    /*
     * The optical maths will happily resolve a 2.5 m profile on this panel. The
     * reason not to is a manufacturer claim, not a geometric one, so it lives
     * on the hardware table rather than in the solver — and the calibration
     * wizard is where it belongs, at the moment the distance is typed, rather
     * than as a verdict after the fact.
     */
    expect(OPTICAL_HARDWARE['elgato-prompter'].maxComfortableDistanceMm).toBe(1800);
    expect(OPTICAL_HARDWARE['elgato-prompter'].diagonalInches).toBe(9);
  });
});

describe('the safe area, which a hood makes real', () => {
  it('costs lines when the hood crops the panel, and reports it', () => {
    const full = budgetFor(1200);
    // Vertical crop only, and a STRICT loss: mixing in a horizontal inset let
    // the assertion pass while the vertical crop was being ignored entirely.
    const cropped = budgetFor(1200, {
      safeArea: { top: 0.12, right: 0, bottom: 0.12, left: 0 },
    });
    expect(cropped.budget.total).toBeLessThan(full.budget.total);
  });

  it('costs characters when the hood crops the sides', () => {
    const full = budgetFor(1200);
    const narrowed = budgetFor(1200, {
      safeArea: { top: 0, right: 0.12, bottom: 0, left: 0.12 },
    });
    expect(narrowed.optics.charactersPerLine as number).toBeLessThan(
      full.optics.charactersPerLine as number,
    );
  });
});

describe('font metrics change the answer, so they must reach the resolver', () => {
  it('a wider face costs characters per line at the same angular size', () => {
    const profile = rig(1200);
    const narrow = resolveStageGeometry({ profile, viewport: VIEWPORT }).optics;
    const wide = resolveStageGeometry({
      profile,
      viewport: VIEWPORT,
      metrics: { ...fallbackFontMetrics(), avgCharWidthRatio: 0.58, measured: true },
    }).optics;
    expect(wide.charactersPerLine as number).toBeLessThan(narrow.charactersPerLine as number);
  });
});
