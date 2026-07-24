/**
 * A display profile stores the Listener's *resolved* geometry, so restoring the
 * sliders means inverting the forward conversion. That inversion was wrong: it
 * multiplied by 100 without dividing the pack's `defaultZoom` back out, so
 * every save/restore cycle multiplied the scale by `defaultZoom` again.
 *
 * The bug is only visible when the round-trip *compounds* — a single pass looks
 * plausible (100% → 115%), and it is the second and third passes that show the
 * Listener growing by 15% of herself every session while the offset sliders'
 * range widens underneath her. So these tests iterate rather than assert once.
 */
import { describe, expect, it } from 'vitest';
import {
  buildListenerGeometry,
  listenerScalePercentFromCropZoom,
} from '../../../src/control/services/listeners';

/** Mira's published `defaultZoom`, the only pack that ships today. */
const MIRA_DEFAULT_ZOOM = 1.15;

function saveThenRestore(scalePercent: number, defaultZoom: number): number {
  const geometry = buildListenerGeometry(defaultZoom, { zoomPercent: scalePercent });
  return listenerScalePercentFromCropZoom(geometry.cropZoom, defaultZoom);
}

describe('listener scale survives a display-profile round trip', () => {
  it('returns the same scale it was given', () => {
    for (const scale of [60, 100, 115, 130, 160]) {
      expect(saveThenRestore(scale, MIRA_DEFAULT_ZOOM)).toBe(scale);
    }
  });

  it('does not drift over repeated sessions', () => {
    // The compounding is the defect. Ten cycles of the old code took 100% to
    // roughly 405%; a correct inverse is a fixed point.
    let scale = 100;
    for (let session = 0; session < 10; session++) {
      scale = saveThenRestore(scale, MIRA_DEFAULT_ZOOM);
    }
    expect(scale).toBe(100);
  });

  it('holds for a pack whose default zoom is not Mira’s', () => {
    // Guards against a fix that merely hard-codes 1.15 somewhere.
    for (const defaultZoom of [1, 1.4, 2.5]) {
      expect(saveThenRestore(100, defaultZoom)).toBe(100);
      expect(saveThenRestore(140, defaultZoom)).toBe(140);
    }
  });

  it('falls back rather than dividing by zero when the pack zoom is unusable', () => {
    // `defaultZoom` is resolved asynchronously from the pack manifest, so a
    // restore can race it. Returning the stored zoom unscaled is wrong-but-sane;
    // NaN or Infinity would reach a slider and a CSS transform.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const restored = listenerScalePercentFromCropZoom(1.15, bad);
      expect(Number.isFinite(restored)).toBe(true);
      expect(restored).toBe(115);
    }
  });

  it('keeps the offset range stable, which is what the drift silently widened', () => {
    // The sliders' bound is derived from the zoom, so a scale that inflates
    // hands the user a range they never asked for.
    const first = buildListenerGeometry(MIRA_DEFAULT_ZOOM, {
      zoomPercent: 100,
      offsetXPercent: 4,
    });
    const restoredScale = listenerScalePercentFromCropZoom(first.cropZoom, MIRA_DEFAULT_ZOOM);
    const second = buildListenerGeometry(MIRA_DEFAULT_ZOOM, {
      zoomPercent: restoredScale,
      offsetXPercent: first.cropX,
    });
    expect(second.cropZoom).toBeCloseTo(first.cropZoom, 10);
    expect(second.cropX).toBeCloseTo(first.cropX, 10);
  });
});
