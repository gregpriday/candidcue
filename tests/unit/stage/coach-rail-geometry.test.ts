/**
 * §7.1 reserved geometry and §7.3 degradation.
 *
 * The first block is the one that matters: the rail's height must not depend on
 * whether it is being shown. A hidden rail that gave its band back would move
 * the reading line under the presenter mid-take, and the failure mode is silent
 * — the script simply sits a little higher than it did a second ago.
 */
import { describe, expect, it } from 'vitest';
import {
  RAIL_MIN_HEIGHT_PX,
  RAIL_PREFERRED_HEIGHT_PX,
  RAIL_SCRIPT_GAP_PX,
  clampRailTextScale,
  coachRailReservedHeightPx,
  coachRailScriptInsetPx,
  modePermissions,
  railTier,
  resolveRailLayout,
} from '../../../src/stage/renderer/coach/railGeometry';
import { CoachRailPresenter } from '../../../src/stage/renderer/coach/presenter';
import { railState } from './coach-rail-fixture';

const VIEWPORTS = [0, 320, 600, 650, 720, 800, 1080, 1440, 2160];

describe('§7.1 reserved band', () => {
  it('reserves the same height whether the rail is visible or hidden', () => {
    for (const viewportHeightPx of VIEWPORTS) {
      const shown = new CoachRailPresenter().update({
        state: railState({ visible: true }),
        monotonicMs: 0,
        widthPx: 1280,
        viewportHeightPx,
        textScale: 1,
      });
      const hidden = new CoachRailPresenter().update({
        state: railState({ visible: false }),
        monotonicMs: 0,
        widthPx: 1280,
        viewportHeightPx,
        textScale: 1,
      });
      expect(hidden.reservedHeightPx).toBe(shown.reservedHeightPx);
      expect(hidden.reservedHeightPx).toBeGreaterThanOrEqual(RAIL_MIN_HEIGHT_PX);
      // Only the contents change.
      expect(shown.visible).toBe(true);
      expect(hidden.visible).toBe(false);
    }
  });

  it('reserves the same height regardless of what the rail has to say', () => {
    const empty = coachRailReservedHeightPx(1080);
    const busy = coachRailReservedHeightPx(1080);
    expect(busy).toBe(empty);
    // The function takes exactly one argument; there is no content or
    // visibility input it could grow with.
    expect(coachRailReservedHeightPx.length).toBe(1);
  });

  it('honours the 52/64/8% bounds', () => {
    expect(coachRailReservedHeightPx(1080)).toBe(RAIL_PREFERRED_HEIGHT_PX);
    // 8% of 700 is 56: under the preferred height, over the minimum.
    expect(coachRailReservedHeightPx(700)).toBe(56);
    // 8% of 500 is 40: the minimum wins.
    expect(coachRailReservedHeightPx(500)).toBe(RAIL_MIN_HEIGHT_PX);
    for (const viewportHeightPx of VIEWPORTS) {
      const height = coachRailReservedHeightPx(viewportHeightPx);
      expect(height).toBeGreaterThanOrEqual(RAIL_MIN_HEIGHT_PX);
      expect(height).toBeLessThanOrEqual(RAIL_PREFERRED_HEIGHT_PX);
    }
  });

  it('reserves the preferred height before the viewport has been measured', () => {
    // Reserving zero and then growing would shift the script on first paint.
    expect(coachRailReservedHeightPx(0)).toBe(RAIL_PREFERRED_HEIGHT_PX);
    expect(coachRailReservedHeightPx(Number.NaN)).toBe(RAIL_PREFERRED_HEIGHT_PX);
  });

  it('gives the script inset the band plus the §7.1 separation', () => {
    expect(coachRailScriptInsetPx(1080)).toBe(coachRailReservedHeightPx(1080) + RAIL_SCRIPT_GAP_PX);
    expect(RAIL_SCRIPT_GAP_PX).toBeGreaterThanOrEqual(10);
    expect(RAIL_SCRIPT_GAP_PX).toBeLessThanOrEqual(18);
  });
});

describe('§7.3 degradation order', () => {
  it('drops features in the order the spec prescribes and keeps the tip longest', () => {
    const widths = [1280, 820, 700, 560, 420, 320];
    const layouts = widths.map((width) => resolveRailLayout('studio', width));
    expect(layouts.map((l) => l.tier)).toEqual([
      'full',
      'no_sparkline',
      'variety_label',
      'no_filler_count',
      'compact',
      'tip_only',
    ]);
    // Step 1: the sparkline goes first, and nothing else goes with it.
    expect(layouts[0]!.showSparkline).toBe(true);
    expect(layouts[1]!.showSparkline).toBe(false);
    expect(layouts[1]!.showVarietyNumber).toBe(true);
    // Step 2: numeric variety becomes a label.
    expect(layouts[2]!.showVarietyNumber).toBe(false);
    expect(layouts[2]!.showVariety).toBe(true);
    expect(layouts[2]!.showFillerCount).toBe(true);
    // Step 3: the filler count goes, the ribbon ticks stay.
    expect(layouts[3]!.showFillerCount).toBe(false);
    expect(layouts[3]!.showRibbon).toBe(true);
    // Step 4: left and right telemetry collapse into one row.
    expect(layouts[4]!.compactTelemetry).toBe(true);
    expect(layouts[4]!.showPace).toBe(true);
    expect(layouts[4]!.showVariety).toBe(true);
    // Step 6: only the tip survives.
    expect(layouts[5]!.showPace).toBe(false);
    expect(layouts[5]!.showVariety).toBe(false);
    expect(layouts[5]!.showRibbon).toBe(false);
  });

  it('treats an unmeasured width as the full layout, not the smallest', () => {
    expect(railTier(0)).toBe('full');
    expect(railTier(Number.NaN)).toBe('full');
  });
});

describe('§6 mode permissions', () => {
  it('gives Minimal a pace tile and nothing else', () => {
    const minimal = modePermissions('minimal');
    expect(minimal.paceTile).toBe(true);
    expect(minimal.varietyTile).toBe(false);
    expect(minimal.fillerCount).toBe(false);
    expect(minimal.ribbon).toBe(false);
    expect(minimal.criticalTipsOnly).toBe(true);
  });

  it('gives Coach everything but the sparkline, and Studio the sparkline too', () => {
    expect(modePermissions('coach').sparkline).toBe(false);
    expect(modePermissions('coach').ribbon).toBe(true);
    expect(modePermissions('studio').sparkline).toBe(true);
  });

  it('leaves Review-only with critical alerts alone', () => {
    const review = modePermissions('review_only');
    expect(review.paceTile).toBe(false);
    expect(review.varietyTile).toBe(false);
    expect(review.ribbon).toBe(false);
    expect(review.criticalTipsOnly).toBe(true);
  });
});

describe('§7.6 text scale', () => {
  it('clamps to 80%–150% and survives nonsense', () => {
    expect(clampRailTextScale(0.5)).toBe(0.8);
    expect(clampRailTextScale(3)).toBe(1.5);
    expect(clampRailTextScale(1.2)).toBe(1.2);
    expect(clampRailTextScale(Number.NaN)).toBe(1);
  });
});
