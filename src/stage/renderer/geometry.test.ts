import { describe, it, expect } from 'vitest';
import {
  computeReadingBand,
  bandCorrection,
  clampProvisionalTarget,
  isCompactViewport,
  stagePadding,
} from './geometry';

const DEFAULT_BAND = { centerPercent: 38, halfHeightPercent: 4 };

describe('reading band geometry (spec §16.3, §32.5)', () => {
  it('places the default band at 34–42% of viewport height', () => {
    const band = computeReadingBand(1000, DEFAULT_BAND);
    expect(band.centerPx).toBe(380);
    expect(band.topPx).toBe(340);
    expect(band.bottomPx).toBe(420);
  });

  it('clamps the band center to the supported 20–70% range', () => {
    expect(computeReadingBand(1000, { centerPercent: 5, halfHeightPercent: 4 }).centerPx).toBe(200);
    expect(computeReadingBand(1000, { centerPercent: 95, halfHeightPercent: 4 }).centerPx).toBe(700);
  });

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
    const target = bandCorrection(1480, 40, 1000, band);
    expect(target).toBe(1500 - 380);
  });

  it('returns the scroll target that re-centers a token above the band', () => {
    const band = computeReadingBand(1000, DEFAULT_BAND);
    // Token center doc y = 1300, scrollY 1000 → viewport y = 300 < 340.
    const target = bandCorrection(1280, 40, 1000, band);
    expect(target).toBe(1300 - 380);
  });

  it('clamps provisional corrections to the maximum (spec §16.4)', () => {
    expect(clampProvisionalTarget(1000, 1100, 180)).toBe(1100);
    expect(clampProvisionalTarget(1000, 1400, 180)).toBe(1180);
    expect(clampProvisionalTarget(1000, 400, 180)).toBe(820);
  });
});

describe('compact-display adaptation (spec §16.8)', () => {
  it('detects an Elgato-style 1024×600 display as compact', () => {
    expect(isCompactViewport(1024, 600)).toBe(true);
  });

  it('does not treat ordinary monitors as compact', () => {
    expect(isCompactViewport(1920, 1080)).toBe(false);
    expect(isCompactViewport(2560, 1440)).toBe(false);
  });

  it('adjusts column padding for compact displays (A.3)', () => {
    expect(stagePadding(false)).toEqual({ topVh: 38, bottomVh: 55 });
    expect(stagePadding(true)).toEqual({ topVh: 34, bottomVh: 60 });
  });
});
