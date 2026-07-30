import { describe, it, expect } from 'vitest';
import {
  bandCorrection,
  clampProvisionalTarget,
  columnLeftPx,
  computeReadingBand,
  computeSafeRect,
  fadeDepthPx,
  imageMaxHeightVh,
  lineBudget,
  stagePaddingPx,
  usableLines,
  type SafeRect,
  type StagePaddingPx,
} from './geometry';

const DEFAULT_BAND = { centerPercent: 38, halfHeightPercent: 4 };

/** The 9-inch Prompter and an ordinary monitor, the two panels this runs on. */
const PROMPTER = { widthPx: 1024, heightPx: 600 };
const MONITOR = { widthPx: 1920, heightPx: 1080 };

/** A 64px body at 1.28 line height — the uncalibrated default. */
const PITCH = 82;

/**
 * Where the plane has to be scrolled for one line's centre to sit on the band,
 * and how far it is allowed to go.
 *
 * This is the arithmetic the padding exists to make work, written out
 * independently — and it is written against the DOM the stage actually
 * renders, which is what it got wrong before.
 *
 * `.script-layer` is `inset: 0`: the plane fills the VIEWPORT, the transform is
 * in viewport pixels, and `ScriptLayer` bounds it at `totalHeight - vh`. This
 * helper used to model a plane inset to the safe rectangle — `bandCenterPx -
 * safeRect.y`, and a ceiling of `total - safeRect.height` — so it agreed with a
 * padding solver that made the same mistake, and the pair of them passed
 * together while a hooded rig came out `vh - safeRect.height` short. Two wrongs
 * that only cancel when the safe area is zero, which is every default profile
 * and no real hood.
 */
function scrollToPutLineOnBand(input: {
  lineIndex: number;
  lineCount: number;
  linePitchPx: number;
  padding: StagePaddingPx;
  safeRect: SafeRect;
  bandCenterPx: number;
  /** The plane is `inset: 0`, so this is what it is bounded against. */
  viewportHeightPx: number;
}): { scrollPx: number; maxScrollPx: number } {
  const { lineIndex, lineCount, linePitchPx, padding, bandCenterPx, viewportHeightPx } = input;
  const total = padding.topPx + lineCount * linePitchPx + padding.bottomPx;
  const centerDocPx = padding.topPx + lineIndex * linePitchPx + linePitchPx / 2;
  return {
    scrollPx: centerDocPx - bandCenterPx,
    maxScrollPx: Math.max(0, total - viewportHeightPx),
  };
}

describe('the reading corridor', () => {
  it('keeps the uncalibrated percentage path for a rig with no measured pitch', () => {
    const band = computeReadingBand(1000, DEFAULT_BAND);
    expect(band.centerPx).toBe(380);
    expect(band.topPx).toBe(340);
    expect(band.bottomPx).toBe(420);
  });

  it('clamps the uncalibrated band center to the supported 20–70% range', () => {
    expect(computeReadingBand(1000, { centerPercent: 5, halfHeightPercent: 4 }).centerPx).toBe(200);
    expect(computeReadingBand(1000, { centerPercent: 95, halfHeightPercent: 4 }).centerPx).toBe(700);
  });

  /* The whole point of the change. */
  it('gives the same corridor height on a 600px and a 1080px panel for one pitch', () => {
    const short = computeReadingBand(PROMPTER.heightPx, { ...DEFAULT_BAND, linePitchPx: PITCH });
    const tall = computeReadingBand(MONITOR.heightPx, { ...DEFAULT_BAND, linePitchPx: PITCH });

    const shortHeight = short.bottomPx - short.topPx;
    const tallHeight = tall.bottomPx - tall.topPx;
    expect(shortHeight).toBeCloseTo(tallHeight, 9);
    // 0.84 line pitches, total.
    expect(shortHeight).toBeCloseTo(PITCH * 0.84, 9);
  });

  it('is exactly what the percentage path could not do', () => {
    const short = computeReadingBand(PROMPTER.heightPx, DEFAULT_BAND);
    const tall = computeReadingBand(MONITOR.heightPx, DEFAULT_BAND);
    // 48px against an ~82px line, versus 86.4px against the same line.
    expect(short.bottomPx - short.topPx).toBeCloseTo(48, 9);
    expect(tall.bottomPx - tall.topPx).toBeCloseTo(86.4, 9);
  });

  it('honours an explicit dead-zone in line pitches', () => {
    const band = computeReadingBand(1000, { ...DEFAULT_BAND, linePitchPx: 100, deadZoneLines: 2 });
    expect(band.bottomPx - band.topPx).toBeCloseTo(200, 9);
  });

  it('measures the band center against the safe rectangle when one is given', () => {
    const safeRect: SafeRect = { x: 0, y: 100, width: 1024, height: 400 };
    const band = computeReadingBand(600, {
      centerPercent: 50,
      halfHeightPercent: 4,
      linePitchPx: 80,
      safeRect,
    });
    // Half way down the VISIBLE rectangle, not half way down the panel.
    expect(band.centerPx).toBeCloseTo(300, 9);
    expect(band.topPx).toBeCloseTo(300 - 80 * 0.42, 9);
    expect(band.bottomPx).toBeCloseTo(300 + 80 * 0.42, 9);
  });

  it('lets a calibrated rig place the band where the lens actually is', () => {
    const safeRect: SafeRect = { x: 0, y: 0, width: 1024, height: 1000 };
    // A camera high in the hood: 12% would be clamped to 20% on the viewport
    // path, which would move the text off the lens.
    const calibrated = computeReadingBand(1000, {
      centerPercent: 12,
      halfHeightPercent: 4,
      linePitchPx: PITCH,
      safeRect,
    });
    expect(calibrated.centerPx).toBeCloseTo(120, 9);
    expect(computeReadingBand(1000, { centerPercent: 12, halfHeightPercent: 4 }).centerPx).toBe(200);
  });

  it('clamps the calibrated band center to the 10–90% the resolver allows', () => {
    const safeRect: SafeRect = { x: 0, y: 0, width: 1024, height: 1000 };
    const settings = { halfHeightPercent: 4, linePitchPx: PITCH, safeRect };
    expect(computeReadingBand(1000, { ...settings, centerPercent: 2 }).centerPx).toBeCloseTo(100, 9);
    expect(computeReadingBand(1000, { ...settings, centerPercent: 98 }).centerPx).toBeCloseTo(
      900,
      9,
    );
  });

  it('honours a pin near the edge for an off-panel lens instead of re-clamping to 10–90%', () => {
    const safeRect: SafeRect = { x: 0, y: 0, width: 1024, height: 1000 };
    const settings = { halfHeightPercent: 4, linePitchPx: PITCH, safeRect };
    expect(
      computeReadingBand(1000, { ...settings, centerPercent: 5, lensPlacement: 'above' }).centerPx,
    ).toBeCloseTo(50, 9);
    expect(
      computeReadingBand(1000, { ...settings, centerPercent: 95, lensPlacement: 'below' }).centerPx,
    ).toBeCloseTo(950, 9);
    // The in-panel clamp still applies when placement is absent or 'in-panel'.
    expect(computeReadingBand(1000, { ...settings, centerPercent: 5 }).centerPx).toBeCloseTo(100, 9);
    expect(
      computeReadingBand(1000, { ...settings, centerPercent: 5, lensPlacement: 'in-panel' })
        .centerPx,
    ).toBeCloseTo(100, 9);
  });

  it('clamps an out-of-range off-panel centerPercent to the same 5–95% the resolver pins to', () => {
    // The off-panel range shares its bound with the resolver's own pin rather
    // than opening to a raw 0–100%: a centre allowed to land exactly on the
    // edge would give the corridor a zero margin on that side.
    const safeRect: SafeRect = { x: 0, y: 0, width: 1024, height: 1000 };
    const settings = { halfHeightPercent: 4, linePitchPx: PITCH, safeRect };
    const above = computeReadingBand(1000, {
      ...settings,
      centerPercent: 0,
      lensPlacement: 'above',
    });
    expect(above.centerPx).toBeCloseTo(50, 9);
    expect(above.bottomPx).toBeGreaterThan(above.topPx);
    expect(above.topPx).toBeGreaterThan(safeRect.y);

    const below = computeReadingBand(1000, {
      ...settings,
      centerPercent: 100,
      lensPlacement: 'below',
    });
    expect(below.centerPx).toBeCloseTo(950, 9);
    expect(below.bottomPx).toBeGreaterThan(below.topPx);
    expect(below.bottomPx).toBeLessThan(safeRect.y + safeRect.height);
  });

  it('ignores lensPlacement on the uncalibrated viewport path, which has no safe rect', () => {
    // Only a resolved, calibrated rig ever carries `lensPlacement`, and it
    // always arrives with a safe rect alongside it — but the function itself
    // should not honour an off-panel placement it has no rectangle to widen.
    expect(
      computeReadingBand(1000, { centerPercent: 5, halfHeightPercent: 4, lensPlacement: 'above' })
        .centerPx,
    ).toBe(200);
    expect(
      computeReadingBand(1000, {
        centerPercent: 95,
        halfHeightPercent: 4,
        lensPlacement: 'below',
      }).centerPx,
    ).toBe(700);
  });

  /*
   * A band centre nobody supplied has to land where the app says it lands. The
   * settings document is stored opaquely and validated only for its schema
   * version, so a missing or corrupted number reaches this function intact.
   */
  it('falls back to the documented 38% when the band center is unusable', () => {
    expect(computeReadingBand(1000, { centerPercent: Number.NaN, halfHeightPercent: 4 }).centerPx)
      .toBeCloseTo(380, 9);
    const safeRect: SafeRect = { x: 0, y: 0, width: 1024, height: 1000 };
    expect(
      computeReadingBand(1000, {
        centerPercent: Number.NaN,
        halfHeightPercent: 4,
        linePitchPx: PITCH,
        safeRect,
      }).centerPx,
    ).toBeCloseTo(380, 9);
  });

  /* The corridor may not vouch for pixels the hood is covering. */
  it('keeps the corridor inside the rectangle the presenter can see', () => {
    const safeRect = computeSafeRect(1024, 600, {
      top: 0.25,
      bottom: 0.45,
      left: 0,
      right: 0,
    });
    const safeBottom = safeRect.y + safeRect.height;

    const low = computeReadingBand(600, {
      centerPercent: 88,
      halfHeightPercent: 4,
      linePitchPx: PITCH,
      safeRect,
    });
    expect(low.bottomPx).toBeLessThanOrEqual(safeBottom);
    expect(low.bottomPx).toBeGreaterThan(low.centerPx);

    const high = computeReadingBand(600, {
      centerPercent: 12,
      halfHeightPercent: 4,
      linePitchPx: PITCH,
      safeRect,
    });
    expect(high.topPx).toBeGreaterThanOrEqual(safeRect.y);
    expect(high.topPx).toBeLessThan(high.centerPx);
  });

  it('does not narrow the corridor when nothing is hidden', () => {
    const whole = computeSafeRect(MONITOR.widthPx, MONITOR.heightPx, null);
    const withRect = computeReadingBand(MONITOR.heightPx, {
      ...DEFAULT_BAND,
      linePitchPx: PITCH,
      safeRect: whole,
    });
    expect(withRect.bottomPx - withRect.topPx).toBeCloseTo(PITCH * 0.84, 9);
    expect(withRect.centerPx).toBeCloseTo(MONITOR.heightPx * 0.38, 9);
  });

  it('never returns a degenerate band, whatever the motion path hands it', () => {
    const cases = [
      computeReadingBand(1000, { ...DEFAULT_BAND, linePitchPx: 0 }),
      computeReadingBand(1000, { ...DEFAULT_BAND, linePitchPx: -50 }),
      computeReadingBand(1000, { ...DEFAULT_BAND, linePitchPx: Number.NaN }),
      computeReadingBand(1000, { centerPercent: Number.NaN, halfHeightPercent: Number.NaN }),
      // A safe rectangle with one edge nobody managed to measure.
      computeReadingBand(600, {
        ...DEFAULT_BAND,
        linePitchPx: PITCH,
        safeRect: { x: 0, y: Number.NaN, width: 1024, height: 600 },
      }),
      // The window has not painted yet: the stage completes its handshake hidden.
      computeReadingBand(0, DEFAULT_BAND),
    ];
    for (const band of cases) {
      expect(Number.isFinite(band.centerPx)).toBe(true);
      expect(Number.isFinite(band.topPx)).toBe(true);
      expect(Number.isFinite(band.bottomPx)).toBe(true);
      expect(band.bottomPx).toBeGreaterThan(band.topPx);
    }
  });
});

describe('dead-zone correction (spec §16.3, §16.4)', () => {
  it('does not scroll while the token center stays inside the dead zone', () => {
    const band = computeReadingBand(1000, DEFAULT_BAND);
    // Token center at doc y = 900 with scrollY 520 → viewport y = 380 (center).
    expect(bandCorrection(880, 40, 520, band)).toBeNull();
    // Near the bottom edge of the band, still inside.
    expect(bandCorrection(880, 40, 482, band)).toBeNull();
  });

  it('returns the scroll target that re-centers a token below the band', () => {
    const band = computeReadingBand(1000, DEFAULT_BAND);
    // Token center doc y = 1500, scrollY 1000 → viewport y = 500 > 420.
    expect(bandCorrection(1480, 40, 1000, band)).toBe(1500 - 380);
  });

  it('returns the scroll target that re-centers a token above the band', () => {
    const band = computeReadingBand(1000, DEFAULT_BAND);
    // Token center doc y = 1300, scrollY 1000 → viewport y = 300 < 340.
    expect(bandCorrection(1280, 40, 1000, band)).toBe(1300 - 380);
  });

  it('clamps provisional corrections to the maximum (spec §16.4)', () => {
    expect(clampProvisionalTarget(1000, 1100, 180)).toBe(1100);
    expect(clampProvisionalTarget(1000, 1400, 180)).toBe(1180);
    expect(clampProvisionalTarget(1000, 400, 180)).toBe(820);
  });
});

describe('the safe rectangle', () => {
  it('is the whole display until somebody says otherwise', () => {
    expect(computeSafeRect(MONITOR.widthPx, MONITOR.heightPx, null)).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    });
  });

  it('insets each edge by its own fraction', () => {
    const rect = computeSafeRect(1000, 800, { top: 0.1, right: 0.05, bottom: 0.1, left: 0.05 });
    expect(rect.x).toBeCloseTo(50, 9);
    expect(rect.y).toBeCloseTo(80, 9);
    expect(rect.width).toBeCloseTo(900, 9);
    expect(rect.height).toBeCloseTo(640, 9);
  });

  it('still leaves a usable rectangle when the insets are dragged past each other', () => {
    const rect = computeSafeRect(1000, 800, { top: 0.9, right: 0.9, bottom: 0.9, left: 0.9 });
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(0);
    // Each edge clamped to 0.45, so a tenth of the panel survives.
    expect(rect.width).toBeCloseTo(100, 6);
    expect(rect.height).toBeCloseTo(80, 6);
  });

  it('ignores insets that are not usable numbers', () => {
    const rect = computeSafeRect(1000, 800, {
      top: Number.NaN,
      right: -0.2,
      bottom: Number.POSITIVE_INFINITY,
      left: 0,
    });
    expect(rect).toEqual({ x: 0, y: 0, width: 1000, height: 800 });
  });

  it('does not invent a rectangle for an unpainted window', () => {
    expect(computeSafeRect(0, 0, null)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe('column padding', () => {
  it('lets the first line reach the band with no scroll at all', () => {
    const safeRect = computeSafeRect(PROMPTER.widthPx, PROMPTER.heightPx, null);
    const band = computeReadingBand(PROMPTER.heightPx, {
      ...DEFAULT_BAND,
      linePitchPx: PITCH,
      safeRect,
    });
    const padding = stagePaddingPx({
      safeRect,
      viewportHeightPx: PROMPTER.heightPx,
      bandCenterPx: band.centerPx,
      linePitchPx: PITCH,
    });

    const { scrollPx } = scrollToPutLineOnBand({
      viewportHeightPx: PROMPTER.heightPx,
      lineIndex: 0,
      lineCount: 40,
      linePitchPx: PITCH,
      padding,
      safeRect,
      bandCenterPx: band.centerPx,
    });
    expect(scrollPx).toBeCloseTo(0, 9);
  });

  it('lets the last line reach the band, with the future reserve left over', () => {
    const safeRect = computeSafeRect(PROMPTER.widthPx, PROMPTER.heightPx, null);
    const band = computeReadingBand(PROMPTER.heightPx, {
      ...DEFAULT_BAND,
      linePitchPx: PITCH,
      safeRect,
    });
    const padding = stagePaddingPx({
      safeRect,
      viewportHeightPx: PROMPTER.heightPx,
      bandCenterPx: band.centerPx,
      linePitchPx: PITCH,
    });

    const { scrollPx, maxScrollPx } = scrollToPutLineOnBand({
      viewportHeightPx: PROMPTER.heightPx,
      lineIndex: 39,
      lineCount: 40,
      linePitchPx: PITCH,
      padding,
      safeRect,
      bandCenterPx: band.centerPx,
    });
    expect(scrollPx).toBeGreaterThan(0);
    expect(scrollPx).toBeLessThanOrEqual(maxScrollPx);
    // The run-out: three line pitches of travel past the final line.
    expect(maxScrollPx - scrollPx).toBeCloseTo(3 * PITCH, 9);
  });

  it('solves both edges against a hood that hides part of the panel', () => {
    const safeRect = computeSafeRect(PROMPTER.widthPx, PROMPTER.heightPx, {
      top: 0.1,
      bottom: 0.1,
      left: 0.05,
      right: 0.05,
    });
    const band = computeReadingBand(PROMPTER.heightPx, {
      ...DEFAULT_BAND,
      linePitchPx: PITCH,
      safeRect,
    });
    const padding = stagePaddingPx({
      safeRect,
      viewportHeightPx: PROMPTER.heightPx,
      bandCenterPx: band.centerPx,
      linePitchPx: PITCH,
    });

    const first = scrollToPutLineOnBand({
      viewportHeightPx: PROMPTER.heightPx,
      lineIndex: 0,
      lineCount: 20,
      linePitchPx: PITCH,
      padding,
      safeRect,
      bandCenterPx: band.centerPx,
    });
    const last = scrollToPutLineOnBand({
      viewportHeightPx: PROMPTER.heightPx,
      lineIndex: 19,
      lineCount: 20,
      linePitchPx: PITCH,
      padding,
      safeRect,
      bandCenterPx: band.centerPx,
    });
    expect(first.scrollPx).toBeCloseTo(0, 9);
    expect(last.scrollPx).toBeLessThanOrEqual(last.maxScrollPx);
    expect(last.maxScrollPx - last.scrollPx).toBeCloseTo(3 * PITCH, 9);
  });

  it('honours a caller that asks for no run-out', () => {
    const safeRect = computeSafeRect(PROMPTER.widthPx, PROMPTER.heightPx, null);
    const band = computeReadingBand(PROMPTER.heightPx, {
      ...DEFAULT_BAND,
      linePitchPx: PITCH,
      safeRect,
    });
    const padding = stagePaddingPx({
      safeRect,
      viewportHeightPx: PROMPTER.heightPx,
      bandCenterPx: band.centerPx,
      linePitchPx: PITCH,
      futureReserveLines: 0,
    });
    const { scrollPx, maxScrollPx } = scrollToPutLineOnBand({
      viewportHeightPx: PROMPTER.heightPx,
      lineIndex: 39,
      lineCount: 40,
      linePitchPx: PITCH,
      padding,
      safeRect,
      bandCenterPx: band.centerPx,
    });
    // Still reaches the band, exactly, with nothing to spare.
    expect(scrollPx).toBeCloseTo(maxScrollPx, 9);
  });

  it('scales with the pitch rather than with the panel', () => {
    const shortRect = computeSafeRect(PROMPTER.widthPx, PROMPTER.heightPx, null);
    const tallRect = computeSafeRect(MONITOR.widthPx, MONITOR.heightPx, null);
    const shortBand = computeReadingBand(PROMPTER.heightPx, {
      ...DEFAULT_BAND,
      linePitchPx: PITCH,
      safeRect: shortRect,
    });
    const tallBand = computeReadingBand(MONITOR.heightPx, {
      ...DEFAULT_BAND,
      linePitchPx: PITCH,
      safeRect: tallRect,
    });

    const short = stagePaddingPx({
      safeRect: shortRect,
      viewportHeightPx: PROMPTER.heightPx,
      bandCenterPx: shortBand.centerPx,
      linePitchPx: PITCH,
    });
    const tall = stagePaddingPx({
      safeRect: tallRect,
      viewportHeightPx: MONITOR.heightPx,
      bandCenterPx: tallBand.centerPx,
      linePitchPx: PITCH,
    });
    // The band sits at the same fraction of both panels, so the padding differs
    // by exactly the panel's extra height — no breakpoint, no second table.
    expect(tall.topPx - short.topPx).toBeCloseTo((1080 - 600) * 0.38, 9);
    expect(tall.bottomPx - short.bottomPx).toBeCloseTo((1080 - 600) * 0.62, 9);
  });

  it('gives an unmeasured pitch a padding it can still lay out with', () => {
    const safeRect = computeSafeRect(PROMPTER.widthPx, PROMPTER.heightPx, null);
    const padding = stagePaddingPx({
      safeRect,
      viewportHeightPx: PROMPTER.heightPx,
      bandCenterPx: 228,
      linePitchPx: 0,
    });
    expect(padding.topPx).toBeCloseTo(228, 9);
    expect(padding.bottomPx).toBeCloseTo(372, 9);
  });
});

describe('focus fades', () => {
  it('is deeper above the band than below it', () => {
    const fade = fadeDepthPx(80);
    expect(fade.topPx).toBeCloseTo(100, 9);
    expect(fade.bottomPx).toBeCloseTo(60, 9);
    expect(fade.topPx).toBeGreaterThan(fade.bottomPx);
  });

  it('takes explicit line counts, including zero', () => {
    expect(fadeDepthPx(80, { topLines: 2, bottomLines: 0 })).toEqual({ topPx: 160, bottomPx: 0 });
  });

  it('falls back to the defaults for a nonsense request', () => {
    expect(fadeDepthPx(80, { topLines: -1, bottomLines: Number.NaN })).toEqual({
      topPx: 100,
      bottomPx: 60,
    });
  });

  it('is zero until a pitch has been measured', () => {
    expect(fadeDepthPx(0)).toEqual({ topPx: 0, bottomPx: 0 });
  });
});

describe('column placement on the lens', () => {
  const rect: SafeRect = { x: 0, y: 0, width: 1000, height: 600 };

  it('centers on the display when the lens is centered', () => {
    expect(columnLeftPx({ safeRect: rect, columnWidthPx: 400, opticalCenterX: 0.5 })).toBeCloseTo(
      300,
      9,
    );
  });

  it('follows an off-center lens', () => {
    expect(columnLeftPx({ safeRect: rect, columnWidthPx: 400, opticalCenterX: 0.25 })).toBeCloseTo(
      50,
      9,
    );
    expect(columnLeftPx({ safeRect: rect, columnWidthPx: 400, opticalCenterX: 0.7 })).toBeCloseTo(
      500,
      9,
    );
  });

  it('never pushes the column out of the safe rectangle', () => {
    expect(columnLeftPx({ safeRect: rect, columnWidthPx: 400, opticalCenterX: 0.05 })).toBe(0);
    expect(columnLeftPx({ safeRect: rect, columnWidthPx: 400, opticalCenterX: 0.95 })).toBe(600);
  });

  it('clamps against the safe rectangle rather than the window', () => {
    const inset: SafeRect = { x: 100, y: 0, width: 800, height: 600 };
    expect(columnLeftPx({ safeRect: inset, columnWidthPx: 400, opticalCenterX: 0.02 })).toBe(100);
    expect(columnLeftPx({ safeRect: inset, columnWidthPx: 400, opticalCenterX: 0.98 })).toBe(500);
  });

  it('spills a too-wide column evenly rather than behind one bezel', () => {
    const inset: SafeRect = { x: 100, y: 0, width: 800, height: 600 };
    expect(columnLeftPx({ safeRect: inset, columnWidthPx: 900, opticalCenterX: 0.9 })).toBeCloseTo(
      50,
      9,
    );
  });

  it('treats an unusable lens position as centered', () => {
    expect(
      columnLeftPx({ safeRect: rect, columnWidthPx: 400, opticalCenterX: Number.NaN }),
    ).toBeCloseTo(300, 9);
  });
});

describe('how much script fits', () => {
  it('counts whole line pitches in the visible rectangle', () => {
    expect(usableLines(600, PITCH)).toBe(7);
    expect(usableLines(1080, PITCH)).toBe(13);
  });

  it('counts nothing it cannot measure', () => {
    expect(usableLines(600, 0)).toBe(0);
    expect(usableLines(0, PITCH)).toBe(0);
  });

  it('reports a comfortable read on a 1024×600 Prompter at the default size', () => {
    const safeRect = computeSafeRect(PROMPTER.widthPx, PROMPTER.heightPx, null);
    const band = computeReadingBand(PROMPTER.heightPx, {
      ...DEFAULT_BAND,
      linePitchPx: PITCH,
      safeRect,
    });
    const budget = lineBudget({ safeRect, viewportHeightPx: PROMPTER.heightPx, bandCenterPx: band.centerPx, linePitchPx: PITCH });
    expect(budget.above).toBe(2);
    expect(budget.below).toBe(4);
    expect(budget.total).toBe(7);
    expect(budget.sufficient).toBe(true);
    expect(budget.advice).toBe('');
  });

  it('says so when type this large leaves no future below the band', () => {
    const safeRect = computeSafeRect(PROMPTER.widthPx, PROMPTER.heightPx, null);
    const budget = lineBudget({ safeRect, viewportHeightPx: PROMPTER.heightPx, bandCenterPx: 228, linePitchPx: 150 });
    expect(budget.below).toBe(1);
    expect(budget.sufficient).toBe(false);
    expect(budget.advice).toContain('upcoming script');
  });

  it('says so when the band is too high for any context above it', () => {
    const safeRect = computeSafeRect(PROMPTER.widthPx, PROMPTER.heightPx, null);
    const budget = lineBudget({ safeRect, viewportHeightPx: PROMPTER.heightPx, bandCenterPx: 60, linePitchPx: PITCH });
    expect(budget.above).toBe(0);
    expect(budget.below).toBeGreaterThanOrEqual(3);
    expect(budget.sufficient).toBe(false);
    expect(budget.advice).toContain('above the reading band');
  });

  it('still complains about the total when the reserve itself is relaxed', () => {
    const safeRect = computeSafeRect(PROMPTER.widthPx, PROMPTER.heightPx, null);
    const budget = lineBudget({
      safeRect,
      viewportHeightPx: PROMPTER.heightPx,
      bandCenterPx: 228,
      linePitchPx: 150,
      futureReserveLines: 1,
    });
    expect(budget.total).toBe(3);
    expect(budget.sufficient).toBe(false);
    expect(budget.advice).toContain('fewer than');
  });

  it('refuses to claim a budget before the pitch is measured', () => {
    const safeRect = computeSafeRect(PROMPTER.widthPx, PROMPTER.heightPx, null);
    const budget = lineBudget({ safeRect, viewportHeightPx: PROMPTER.heightPx, bandCenterPx: 228, linePitchPx: 0 });
    expect(budget.total).toBe(0);
    expect(budget.sufficient).toBe(false);
    expect(budget.advice).toContain('line pitch');
  });
});

describe('inline media', () => {
  it('keeps the historical 78% when the whole panel is visible', () => {
    const safeRect = computeSafeRect(MONITOR.widthPx, MONITOR.heightPx, null);
    expect(imageMaxHeightVh(safeRect, MONITOR.heightPx)).toBeCloseTo(78, 9);
  });

  it('gives back what a hood already took', () => {
    const safeRect = computeSafeRect(1000, 1000, { top: 0.15, bottom: 0.15, left: 0, right: 0 });
    // 78% of the 70% that is actually visible.
    expect(imageMaxHeightVh(safeRect, 1000)).toBeCloseTo(54.6, 6);
  });

  it('falls back to the full fraction for an unpainted window', () => {
    expect(imageMaxHeightVh({ x: 0, y: 0, width: 0, height: 0 }, 0)).toBeCloseTo(78, 9);
  });
});
