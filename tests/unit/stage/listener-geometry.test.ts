/**
 * Regression tests for the listener framing contract (spec §37, §40).
 *
 * The bug these pin down: the producer emitted cropX as a FRACTION
 * (offsetXPercent / 100) while the consumer rendered `translate(cropX%)`, so a
 * -50..50 slider produced translate(-0.5%) — roughly ten pixels on a 1080p
 * stage. Mira did not move.
 */
import { describe, it, expect } from 'vitest';
import {
  clampOffsetPercent,
  listenerCropTransform,
  listenerFocusPoint,
  maxSafeOffsetPercent,
  offsetSliderBound,
} from '../../../src/shared/listener/geometry';
import { buildListenerGeometry } from '../../../src/control/services/listeners';

describe('maxSafeOffsetPercent', () => {
  it('derives the overhang the zoom buys, in percent of the frame', () => {
    // (1.15 - 1) / 2 = 0.075 of the frame on each side.
    expect(maxSafeOffsetPercent(1.15)).toBeCloseTo(7.5, 6);
    expect(maxSafeOffsetPercent(1.5)).toBeCloseTo(25, 6);
    expect(maxSafeOffsetPercent(2)).toBeCloseTo(50, 6);
  });

  it('allows no offset at all when there is no overhang to spend', () => {
    expect(maxSafeOffsetPercent(1)).toBe(0);
    expect(maxSafeOffsetPercent(0.8)).toBe(0);
    expect(maxSafeOffsetPercent(Number.NaN)).toBe(0);
  });

  it('rounds the slider bound down so a pinned slider stays inside the window', () => {
    // 1.153 -> 7.65% exact; the slider must not offer more than 7.6%.
    expect(offsetSliderBound(1.153)).toBe(7.6);
    expect(offsetSliderBound(1.153)).toBeLessThanOrEqual(maxSafeOffsetPercent(1.153));
  });
});

describe('clampOffsetPercent', () => {
  it('clamps to the zoom-derived safe window rather than exposing black bars', () => {
    expect(clampOffsetPercent(50, 1.15)).toBeCloseTo(7.5, 6);
    expect(clampOffsetPercent(-50, 1.15)).toBeCloseTo(-7.5, 6);
    expect(clampOffsetPercent(3, 1.15)).toBeCloseTo(3, 6);
  });

  it('recomputes the window when zoom changes', () => {
    // Same requested offset, two zooms: legal at 1.5, clamped at 1.15.
    expect(clampOffsetPercent(20, 1.5)).toBeCloseTo(20, 6);
    expect(clampOffsetPercent(20, 1.15)).toBeCloseTo(7.5, 6);
  });

  it('pins everything to centre when the clip is not zoomed in', () => {
    expect(clampOffsetPercent(12, 1)).toBe(0);
  });
});

describe('listenerCropTransform', () => {
  it('emits percent units, not fractions (the A4 regression)', () => {
    const transform = listenerCropTransform({ cropX: 6, cropY: -4, cropZoom: 1.15 });
    expect(transform).toContain('translate(6%, -4%)');
    // The pre-fix bug rendered the fraction form.
    expect(transform).not.toContain('translate(0.06%');
  });

  it('applies translate OUTSIDE scale so the offset is zoom-independent', () => {
    const transform = listenerCropTransform({ cropX: 5, cropY: 0, cropZoom: 1.4 });
    // translate must precede scale in the list: CSS composes right-to-left, so
    // a leading translate is applied last, in unscaled frame coordinates.
    expect(transform.indexOf('translate(')).toBeLessThan(transform.indexOf('scale(1.4)'));
    expect(transform).toBe('translate(5%, 0%) scale(1.4) scaleX(1)');
  });

  it('applies the mirror INSIDE the translate so mirroring never flips the offset', () => {
    const plain = listenerCropTransform({ cropX: 5, cropY: 0, cropZoom: 1.4 });
    const mirrored = listenerCropTransform({
      cropX: 5,
      cropY: 0,
      cropZoom: 1.4,
      mirrorVideo: true,
    });
    // Same leading translate in both: "move right" moves right either way.
    expect(mirrored.startsWith('translate(5%, 0%)')).toBe(true);
    expect(plain.startsWith('translate(5%, 0%)')).toBe(true);
    expect(mirrored.endsWith('scaleX(-1)')).toBe(true);
    // The mirror is the last (innermost) operation, after the zoom.
    expect(mirrored.indexOf('scale(1.4)')).toBeLessThan(mirrored.indexOf('scaleX(-1)'));
  });

  it('clamps out-of-range offsets at render time too', () => {
    expect(listenerCropTransform({ cropX: 50, cropY: 50, cropZoom: 1.15 })).toBe(
      'translate(7.5%, 7.5%) scale(1.15) scaleX(1)',
    );
  });

  it('survives a malformed geometry without emitting NaN into CSS', () => {
    const transform = listenerCropTransform({
      cropX: Number.NaN,
      cropY: Number.NaN,
      cropZoom: Number.NaN,
    });
    expect(transform).not.toContain('NaN');
    expect(transform).toBe('translate(0%, 0%) scale(1) scaleX(1)');
  });
});

describe('listenerFocusPoint', () => {
  it('states the framing in frame coordinates, independent of transform order', () => {
    expect(listenerFocusPoint({ cropX: 0, cropY: 0, cropZoom: 1.15 })).toEqual({ x: 0.5, y: 0.5 });
    expect(listenerFocusPoint({ cropX: 5, cropY: -5, cropZoom: 1.5 })).toEqual({
      x: 0.55,
      y: 0.45,
    });
    // Mirroring must not move the focus point.
    expect(listenerFocusPoint({ cropX: 5, cropY: 0, cropZoom: 1.5, mirrorVideo: true })).toEqual(
      listenerFocusPoint({ cropX: 5, cropY: 0, cropZoom: 1.5 }),
    );
  });
});

describe('buildListenerGeometry', () => {
  it('passes slider percents straight through as percents (no /100)', () => {
    const geometry = buildListenerGeometry(1.5, { offsetXPercent: 12, offsetYPercent: -8 });
    expect(geometry.cropX).toBeCloseTo(12, 6);
    expect(geometry.cropY).toBeCloseTo(-8, 6);
  });

  it('clamps against the EFFECTIVE zoom, including the zoom slider', () => {
    // defaultZoom 1.15 with the zoom slider at 160% -> cropZoom 1.84,
    // which buys ±42% of travel.
    const zoomedIn = buildListenerGeometry(1.15, { zoomPercent: 160, offsetXPercent: 40 });
    expect(zoomedIn.cropZoom).toBeCloseTo(1.84, 6);
    expect(zoomedIn.cropX).toBeCloseTo(40, 6);

    // Same request at the default zoom is clamped to the safe window.
    const defaultZoom = buildListenerGeometry(1.15, { offsetXPercent: 40 });
    expect(defaultZoom.cropX).toBeCloseTo(7.5, 6);
  });

  it('zeroes the offset when the zoom slider removes all the overhang', () => {
    // 1.15 * 0.6 = 0.69 -> zoomed OUT, no overhang, no legal offset.
    const geometry = buildListenerGeometry(1.15, { zoomPercent: 60, offsetXPercent: 20 });
    expect(geometry.cropX).toBe(0);
    expect(geometry.cropY).toBe(0);
  });

  it('defaults to a centred, unmirrored frame', () => {
    const geometry = buildListenerGeometry(1.15);
    expect(geometry.cropX).toBe(0);
    expect(geometry.cropY).toBe(0);
    expect(geometry.mirrorVideo).toBe(false);
  });
});
