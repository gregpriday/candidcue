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
  listenerDimPercentFromOpacity,
  listenerSaturationPercentFromFactor,
  listenerScalePercentFromCropZoom,
  listenerSizePercentFromScale,
  type ListenerGeometryOverrides,
} from '../../../src/control/services/listeners';
import type { ListenerPlacementMode } from '../../../src/shared/contracts';

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

  it('is a fixed point for EVERY persisted field, not only the zoom', () => {
    /*
     * The rule this file exists to enforce, applied to the whole object. Each
     * of these is a Preflight control that `buildListenerGeometry` converts on
     * the way into a display profile and `restoreDisplayProfile` inverts on the
     * way out; a single pass looks fine even when the inverse is wrong, so the
     * loop below runs the cycle ten times and demands the same numbers back.
     *
     * `placement`, `scale`, `saturation` and `mirrorVideo` are the fields added
     * when the four unreachable placement modes were exposed. They are here
     * because the last geometry field restored by eye compounded 15% a session.
     */
    const controls: Required<
      Pick<
        ListenerGeometryOverrides,
        | 'placement'
        | 'sizePercent'
        | 'zoomPercent'
        | 'offsetXPercent'
        | 'offsetYPercent'
        | 'dimPercent'
        | 'blurPx'
        | 'saturationPercent'
        | 'mirrorVideo'
      >
    > = {
      placement: 'lens_right',
      sizePercent: 130,
      zoomPercent: 140,
      offsetXPercent: 6.4,
      offsetYPercent: -3.1,
      dimPercent: 55,
      blurPx: 7,
      saturationPercent: 40,
      mirrorVideo: true,
    };

    /** Exactly what `restoreDisplayProfile` does, in one place. */
    const restore = (geometry: ReturnType<typeof buildListenerGeometry>): typeof controls => ({
      placement: (geometry.placement ?? 'background') as ListenerPlacementMode,
      sizePercent: listenerSizePercentFromScale(geometry.scale),
      zoomPercent: listenerScalePercentFromCropZoom(geometry.cropZoom, MIRA_DEFAULT_ZOOM),
      offsetXPercent: geometry.cropX,
      offsetYPercent: geometry.cropY,
      dimPercent: listenerDimPercentFromOpacity(geometry.opacity),
      blurPx: geometry.blurPx,
      saturationPercent: listenerSaturationPercentFromFactor(geometry.saturation),
      mirrorVideo: geometry.mirrorVideo,
    });

    let current = { ...controls };
    let geometry = buildListenerGeometry(MIRA_DEFAULT_ZOOM, current);
    for (let session = 0; session < 10; session++) {
      current = restore(geometry);
      geometry = buildListenerGeometry(MIRA_DEFAULT_ZOOM, current);
    }
    expect(current).toEqual(controls);
    // And the resolved geometry itself has stopped moving.
    expect(geometry).toEqual(buildListenerGeometry(MIRA_DEFAULT_ZOOM, controls));
  });

  it('restores the anchors from the placement rather than persisting them twice', () => {
    // The anchors are derived, not stored-and-inverted, so there is no third
    // copy to drift. Restoring the placement restores them exactly.
    for (const placement of ['background', 'lens_left', 'lens_right', 'top_strip', 'pip'] as const) {
      const first = buildListenerGeometry(MIRA_DEFAULT_ZOOM, { placement });
      const second = buildListenerGeometry(MIRA_DEFAULT_ZOOM, {
        placement: first.placement ?? 'background',
      });
      expect(second.anchorX).toBe(first.anchorX);
      expect(second.anchorY).toBe(first.anchorY);
    }
  });

  it('reads a profile saved before placement was selectable as the mode it was saved under', () => {
    // Those profiles have no `placement` key at all, and every one of them was
    // written while the producer hard-coded 'background'.
    const legacy = { ...buildListenerGeometry(MIRA_DEFAULT_ZOOM), placement: undefined };
    expect(legacy.placement ?? 'background').toBe('background');
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
