/**
 * Unit-axis adapter (companion §6 seam): the stage learns the worker's
 * weighted-unit → token mapping from the frames themselves.
 */
import { describe, it, expect } from 'vitest';
import { createCalibratingUnitAxis, identityUnitAxis } from '../../../src/stage/motion';

describe('calibrating unit axis', () => {
  it('is the identity before any observation', () => {
    const axis = createCalibratingUnitAxis();
    expect(axis.calibrated).toBe(false);
    expect(axis.toMapUnit(42)).toBe(42);
    expect(axis.slopeAt(42)).toBe(1);
  });

  it('learns a uniform weight scale and maps units back to tokens', () => {
    const axis = createCalibratingUnitAxis();
    // The worker uses ~1.25 units per token.
    for (let token = 0; token <= 100; token += 10) {
      axis.observe(token * 1.25, token);
    }
    expect(axis.calibrated).toBe(true);
    expect(axis.toMapUnit(62.5)).toBeCloseTo(50, 6);
    expect(axis.slopeAt(62.5)).toBeCloseTo(0.8, 6);
    // Extrapolation past the observed span uses the learned slope.
    expect(axis.toMapUnit(250)).toBeCloseTo(200, 6);
  });

  it('interpolates a non-uniform mapping monotonically', () => {
    const axis = createCalibratingUnitAxis();
    const samples: Array<[number, number]> = [
      [0, 0],
      [5, 2],
      [30, 20],
      [33, 25],
      [90, 60],
    ];
    for (const [unit, token] of samples) axis.observe(unit, token);
    let previous = -Infinity;
    for (let u = -10; u <= 120; u += 0.5) {
      const mapped = axis.toMapUnit(u);
      expect(mapped).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = mapped;
    }
    for (const [unit, token] of samples) {
      expect(axis.toMapUnit(unit)).toBeCloseTo(token, 6);
    }
  });

  it('never lets a later unit map to an earlier token, even out of order', () => {
    const axis = createCalibratingUnitAxis();
    axis.observe(100, 80);
    axis.observe(50, 90); // impossible pair (out-of-order/garbled frame)
    expect(axis.toMapUnit(120)).toBeGreaterThanOrEqual(axis.toMapUnit(60));
  });

  it('keeps the sample table bounded', () => {
    const axis = createCalibratingUnitAxis({ maxSamples: 16, mergeToleranceUnits: 0 });
    for (let i = 0; i < 500; i++) axis.observe(i * 1.1, i);
    // Still monotone and still roughly correct after decimation.
    expect(axis.toMapUnit(110)).toBeGreaterThan(90);
    expect(axis.toMapUnit(110)).toBeLessThan(110);
  });

  it('identityUnitAxis is a no-op bridge for a real speech-unit map', () => {
    const axis = identityUnitAxis();
    axis.observe(10, 3);
    expect(axis.toMapUnit(10)).toBe(10);
    expect(axis.slopeAt(10)).toBe(1);
    expect(axis.calibrated).toBe(true);
  });
});
