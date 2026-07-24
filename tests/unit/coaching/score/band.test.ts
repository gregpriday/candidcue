/**
 * §9.2 / §9.3 band scoring, checked against values computed by hand rather than
 * against the implementation.
 *
 * Every assertion here is a *number*, not an inequality: `exp(-0.5)` is
 * 0.6065306597…, so a metric exactly one σ outside its band must score
 * 60.65306597…, and an assertion of "less than 100" would pass for a function
 * that returned 99, 1, or the wrong σ entirely.
 */
import { describe, expect, it } from 'vitest';
import {
  atLeast,
  atMost,
  bandScore,
  clampScore,
  distanceFromBand,
  type TargetBand,
} from '../../../../src/shared/coaching/score/band';

/** The §8 WPM row with Appendix A's tolerances. */
const wpm: TargetBand = { low: 135, high: 175, sigmaLow: 25, sigmaHigh: 20 };

const ONE_SIGMA = 100 * Math.exp(-0.5); // 60.6530659712633…
const TWO_SIGMA = 100 * Math.exp(-2); // 13.5335283236613…
const HALF_SIGMA = 100 * Math.exp(-0.125); // 88.2496902584595…

describe('the flat in-band region (§9.2)', () => {
  it('scores exactly 100 at the band centre', () => {
    expect(bandScore(155, wpm)).toBe(100);
  });

  it('scores exactly 100 at both inclusive edges', () => {
    expect(bandScore(135, wpm)).toBe(100);
    expect(bandScore(175, wpm)).toBe(100);
  });

  it('is genuinely flat across the band, not merely near-flat', () => {
    for (let value = 135; value <= 175; value += 1) {
      expect(bandScore(value, wpm)).toBe(100);
    }
  });
});

describe('the Gaussian penalty (§9.2)', () => {
  it('scores 100 × exp(-0.5) at exactly one sigma outside the high edge', () => {
    // 175 + 20 = 195, the far edge of §8's soft warning region.
    expect(bandScore(195, wpm)).toBeCloseTo(ONE_SIGMA, 10);
    expect(bandScore(195, wpm)).toBeCloseTo(60.6530659712633, 10);
  });

  it('scores 100 × exp(-2) at two sigma out', () => {
    expect(bandScore(215, wpm)).toBeCloseTo(TWO_SIGMA, 10);
  });

  it('scores 100 × exp(-0.125) at half a sigma out', () => {
    expect(bandScore(185, wpm)).toBeCloseTo(HALF_SIGMA, 10);
  });

  it('never reaches zero, so a very bad metric is still a number', () => {
    const far = bandScore(600, wpm);
    expect(far).not.toBeNull();
    expect(far as number).toBeGreaterThan(0);
    expect(far as number).toBeLessThan(1e-30);
  });
});

describe('asymmetry (§9.3)', () => {
  it('uses sigmaLow below the band and sigmaHigh above it', () => {
    // 25 WPM below 135 is one sigmaLow; 25 WPM above 175 is 1.25 sigmaHigh.
    expect(bandScore(110, wpm)).toBeCloseTo(ONE_SIGMA, 10);
    expect(bandScore(200, wpm)).toBeCloseTo(100 * Math.exp(-0.5 * 1.25 * 1.25), 10);
  });

  it('punishes running fast harder than running equally slow', () => {
    const slow = bandScore(115, wpm) as number; // 20 below the low edge
    const fast = bandScore(195, wpm) as number; // 20 above the high edge
    expect(fast).toBeLessThan(slow);
    // And by exactly the amount the two sigmas imply, not by an arbitrary bias.
    expect(slow).toBeCloseTo(100 * Math.exp(-0.5 * (20 / 25) ** 2), 10);
    expect(fast).toBeCloseTo(100 * Math.exp(-0.5 * (20 / 20) ** 2), 10);
  });

  it('would collapse to symmetry only if both sigmas were equal', () => {
    const symmetric: TargetBand = { ...wpm, sigmaLow: 20 };
    expect(bandScore(115, symmetric)).toBeCloseTo(bandScore(195, symmetric) as number, 10);
  });
});

describe('one-sided metrics (§9.2)', () => {
  it('atMost never penalises a value below the threshold', () => {
    const fillers = atMost(1, 3);
    expect(bandScore(0, fillers)).toBe(100);
    expect(bandScore(-5, fillers)).toBe(100);
    expect(bandScore(1, fillers)).toBe(100);
    expect(bandScore(4, fillers)).toBeCloseTo(ONE_SIGMA, 10);
  });

  it('atLeast never penalises a value above the threshold', () => {
    const shaping = atLeast(0.8, 0.25);
    expect(bandScore(1, shaping)).toBe(100);
    expect(bandScore(0.8, shaping)).toBe(100);
    expect(bandScore(0.55, shaping)).toBeCloseTo(ONE_SIGMA, 10);
  });
});

describe('distance from the band', () => {
  it('is zero inside and the signed gap outside', () => {
    expect(distanceFromBand(150, wpm)).toBe(0);
    expect(distanceFromBand(130, wpm)).toBe(5);
    expect(distanceFromBand(180, wpm)).toBe(5);
  });
});

describe('refusing to invent a score', () => {
  it('returns null rather than NaN for a non-finite metric', () => {
    expect(bandScore(Number.NaN, wpm)).toBeNull();
    expect(bandScore(Number.POSITIVE_INFINITY, wpm)).toBeNull();
  });

  it('returns null rather than 0 for a misconfigured sigma', () => {
    expect(bandScore(200, { ...wpm, sigmaHigh: 0 })).toBeNull();
    expect(bandScore(200, { ...wpm, sigmaHigh: -4 })).toBeNull();
    // Still 100 inside the band: a bad sigma cannot manufacture a penalty.
    expect(bandScore(150, { ...wpm, sigmaHigh: 0 })).toBe(100);
  });
});

describe('clampScore', () => {
  it('clamps to 0–100 and maps non-finite input to 0', () => {
    expect(clampScore(101)).toBe(100);
    expect(clampScore(-1)).toBe(0);
    expect(clampScore(42.5)).toBe(42.5);
    expect(clampScore(Number.NaN)).toBe(0);
  });
});
