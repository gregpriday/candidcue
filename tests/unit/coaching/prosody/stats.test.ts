/**
 * Robust statistics used by the prosody aggregators (spec §17.2).
 *
 * Every expected value here is an order statistic of a hand-written sample, so
 * a change of interpolation convention — the usual silent breakage in
 * percentile code — shows up as a failing number rather than as a slightly
 * different variety score nobody notices.
 */
import { describe, expect, it } from 'vitest';
import {
  coefficientOfVariation,
  interquartileRange,
  linearNorm,
  median,
  medianFilter,
  percentile,
  robustSpan,
} from '../../../../src/shared/coaching/prosody/stats';

/** 1 … 11. Eleven values means P10 and P90 land exactly on a sample. */
const ELEVEN = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

describe('percentile', () => {
  it('lands exactly on a sample when the position is an integer', () => {
    expect(percentile(ELEVEN, 0.1)).toBe(2);
    expect(percentile(ELEVEN, 0.5)).toBe(6);
    expect(percentile(ELEVEN, 0.9)).toBe(10);
  });

  it('interpolates linearly between samples', () => {
    // Position 0.25 × 10 = 2.5, halfway between 3 and 4.
    expect(percentile(ELEVEN, 0.25)).toBe(3.5);
    expect(percentile(ELEVEN, 0.75)).toBe(8.5);
  });

  it('does not care about input order', () => {
    expect(percentile([11, 3, 7, 1, 9], 0.5)).toBe(7);
  });

  it('returns null — not 0 — for an empty sample', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(median([])).toBeNull();
    expect(robustSpan([])).toBeNull();
    expect(interquartileRange([])).toBeNull();
  });

  it('clamps out-of-range fractions rather than reading past the array', () => {
    expect(percentile(ELEVEN, -1)).toBe(1);
    expect(percentile(ELEVEN, 2)).toBe(11);
  });
});

describe('robustSpan and interquartileRange', () => {
  it('report the P90-P10 and P75-P25 widths', () => {
    expect(robustSpan(ELEVEN)).toBe(8);
    expect(interquartileRange(ELEVEN)).toBe(5);
  });

  it('ignore a single extreme outlier, which is the point of using them', () => {
    const withOutlier = [...ELEVEN, 10_000];
    // A standard deviation would explode here; P90 - P10 barely moves.
    expect(robustSpan(withOutlier) ?? 0).toBeLessThan(12);
  });
});

describe('medianFilter', () => {
  it('removes an isolated spike without moving the surrounding plateau', () => {
    expect(medianFilter([0, 0, 10, 0, 0], 3)).toEqual([0, 0, 0, 0, 0]);
  });

  it('preserves a genuine sustained change', () => {
    // §13.2: "detect and suppress isolated octave jumps; preserve genuine
    // sustained changes."
    expect(medianFilter([0, 0, 0, 6, 6, 6], 3)).toEqual([0, 0, 0, 6, 6, 6]);
  });

  it('is the identity for width 1', () => {
    expect(medianFilter([3, 1, 4], 1)).toEqual([3, 1, 4]);
  });
});

describe('linearNorm', () => {
  it('maps the documented ramp onto 0–1 and clamps outside it', () => {
    expect(linearNorm(2, 2, 14)).toBe(0);
    expect(linearNorm(8, 2, 14)).toBe(0.5);
    expect(linearNorm(14, 2, 14)).toBe(1);
    expect(linearNorm(0, 2, 14)).toBe(0);
    expect(linearNorm(99, 2, 14)).toBe(1);
  });

  it('returns 0 for a degenerate ramp rather than dividing by zero', () => {
    expect(linearNorm(5, 3, 3)).toBe(0);
  });
});

describe('coefficientOfVariation', () => {
  it('is zero for a constant sample and scale-free otherwise', () => {
    expect(coefficientOfVariation([100, 100, 100])).toBe(0);
    // mean 100, population sd 10 → 0.1. The same spread around a mean of 200
    // is half the coefficient, which is why the scale-free form is used.
    expect(coefficientOfVariation([90, 110])).toBeCloseTo(0.1, 9);
    expect(coefficientOfVariation([190, 210])).toBeCloseTo(0.05, 9);
  });

  it('returns null when there is nothing to vary', () => {
    expect(coefficientOfVariation([150])).toBeNull();
    expect(coefficientOfVariation([])).toBeNull();
  });
});
