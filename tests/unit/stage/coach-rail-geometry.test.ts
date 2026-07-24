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
  railPermissionsFromModules,
  railTier,
  resolveRailLayout,
  type RailLayout,
} from '../../../src/stage/renderer/coach/railGeometry';
import { CoachRailPresenter } from '../../../src/stage/renderer/coach/presenter';
import { resolveRailModules } from '../../../src/shared/coaching/coach/coach-state';
import { railState } from './coach-rail-fixture';
import type { CoachRailMode, CoachRailModules } from '../../../src/shared/contracts/coaching';

const VIEWPORTS = [0, 320, 600, 650, 720, 800, 1080, 1440, 2160];

/** One width per §7.3 tier, widest first. */
const TIER_WIDTHS = [1280, 820, 700, 560, 420, 320];

/** The layout as a stable, readable string: the enabled flags, in order. */
function enabled(layout: RailLayout): string {
  const on = (Object.keys(layout) as Array<keyof RailLayout>)
    .filter((key) => key !== 'tier' && layout[key] === true)
    .map(String);
  return on.length === 0 ? '(nothing)' : on.join(' ');
}

function layoutTable(mode: CoachRailMode, modules?: CoachRailModules): string[] {
  return TIER_WIDTHS.map((width) => enabled(resolveRailLayout(mode, width, modules)));
}

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

describe('§6.6 the rail renders the modules it was sent', () => {
  const NAMED: readonly CoachRailMode[] = ['off', 'minimal', 'coach', 'studio', 'review_only'];

  /**
   * The guard that matters. Routing the layout through `state.modules` is only
   * safe if the producer's reading of a *named* mode is the same reading the
   * stage's own fallback makes — otherwise picking Coach in Settings would
   * quietly start showing something else.
   */
  it('reads a named mode identically through its flags and through its own fallback', () => {
    for (const mode of NAMED) {
      const fromFlags = railPermissionsFromModules(resolveRailModules(mode));
      expect(`${mode}: ${JSON.stringify(fromFlags)}`).toBe(
        `${mode}: ${JSON.stringify(modePermissions(mode))}`,
      );
      // And therefore at every width, which is what actually reaches the glass.
      expect(layoutTable(mode, resolveRailModules(mode))).toEqual(layoutTable(mode));
    }
  });

  /**
   * The same fact pinned to literal values rather than to the other
   * implementation, so a change that moved *both* readings together still
   * fails. Each row is one §7.3 tier, widest first.
   */
  it('renders each named mode exactly as specified, at every tier', () => {
    const full = 'showScore showPace showPaceNumber showPaceStatus';
    expect(layoutTable('studio')).toEqual([
      `${full} showSparkline showVariety showVarietyNumber showVarietyLabel showFillerCount showRibbon`,
      `${full} showVariety showVarietyNumber showVarietyLabel showFillerCount showRibbon`,
      `${full} showVariety showVarietyLabel showFillerCount showRibbon`,
      `${full} showVariety showVarietyLabel showRibbon`,
      `${full} showVariety showVarietyLabel showRibbon compactTelemetry`,
      'compactTelemetry',
    ]);
    // §6.3: Coach has no sparkline and no numeric variety — the word only.
    expect(layoutTable('coach')).toEqual([
      `${full} showVariety showVarietyLabel showFillerCount showRibbon`,
      `${full} showVariety showVarietyLabel showFillerCount showRibbon`,
      `${full} showVariety showVarietyLabel showFillerCount showRibbon`,
      `${full} showVariety showVarietyLabel showRibbon`,
      `${full} showVariety showVarietyLabel showRibbon compactTelemetry`,
      'compactTelemetry',
    ]);
    // §6.2: pace and critical alerts only.
    expect(layoutTable('minimal')).toEqual([
      'showPace showPaceNumber showPaceStatus',
      'showPace showPaceNumber showPaceStatus',
      'showPace showPaceNumber showPaceStatus',
      'showPace showPaceNumber showPaceStatus',
      'showPace showPaceNumber showPaceStatus compactTelemetry',
      'compactTelemetry',
    ]);
    // §6.5 / §6.1: nothing but the critical-alert slot, which is not a module.
    for (const mode of ['review_only', 'off'] as const) {
      expect(layoutTable(mode)).toEqual([
        '(nothing)',
        '(nothing)',
        '(nothing)',
        '(nothing)',
        'compactTelemetry',
        'compactTelemetry',
      ]);
    }
  });

  /**
   * Every module the user can turn off in Settings, turned off one at a time.
   * The failure this replaces is a module that was routed through the *mode*
   * instead of the flags: `custom` then rendered as Coach and the toggle did
   * nothing.
   */
  it('keeps a module the user turned off hidden at every width', () => {
    const CASES: ReadonlyArray<[keyof CoachRailModules, keyof RailLayout]> = [
      ['deliveryScore', 'showScore'],
      ['paceNumber', 'showPaceNumber'],
      ['paceStatus', 'showPaceStatus'],
      ['paceSparkline', 'showSparkline'],
      ['varietyScore', 'showVarietyNumber'],
      ['varietyLabel', 'showVarietyLabel'],
      ['fillerCount', 'showFillerCount'],
      ['fillerRibbon', 'showRibbon'],
    ];
    // Everything on, so each case turns off exactly one thing.
    const all = resolveRailModules('studio');
    for (const [module, flag] of CASES) {
      const off = resolveRailModules('custom', { ...all, [module]: false });
      for (const width of TIER_WIDTHS) {
        expect(`${module}@${width}: ${resolveRailLayout('custom', width, off)[flag]}`).toBe(
          `${module}@${width}: false`,
        );
      }
      // …and it is genuinely this module doing the hiding: with it on, the
      // widest layout shows it.
      expect(`${module}: ${resolveRailLayout('custom', 1280, resolveRailModules('custom', all))[flag]}`)
        .toBe(`${module}: true`);
    }
  });

  it('drops a zone only when both of its halves are off', () => {
    const all = resolveRailModules('studio');
    const noVarietyNumber = resolveRailModules('custom', { ...all, varietyScore: false });
    const noVarietyAtAll = resolveRailModules('custom', {
      ...all,
      varietyScore: false,
      varietyLabel: false,
    });
    expect(resolveRailLayout('custom', 1280, noVarietyNumber).showVariety).toBe(true);
    expect(resolveRailLayout('custom', 1280, noVarietyAtAll).showVariety).toBe(false);

    const noPaceNumber = resolveRailModules('custom', { ...all, paceNumber: false });
    const noPaceAtAll = resolveRailModules('custom', {
      ...all,
      paceNumber: false,
      paceStatus: false,
    });
    expect(resolveRailLayout('custom', 1280, noPaceNumber).showPace).toBe(true);
    expect(resolveRailLayout('custom', 1280, noPaceAtAll).showPace).toBe(false);
    // The sparkline lives inside the pace tile; without the tile it has no home.
    expect(resolveRailLayout('custom', 1280, noPaceAtAll).showSparkline).toBe(false);
  });

  /**
   * §6.6 and §7.3 are separate axes and they compose in one direction only:
   * width may drop what the user enabled, and nothing may restore what the user
   * disabled.
   */
  it('lets width drop an enabled module but never restores a disabled one', () => {
    const all = resolveRailModules('studio');
    const enabledEverywhere = resolveRailLayout('custom', 1280, resolveRailModules('custom', all));
    expect(enabledEverywhere.showSparkline).toBe(true);
    // Enabled, then dropped for width.
    expect(resolveRailLayout('custom', 820, resolveRailModules('custom', all)).showSparkline).toBe(
      false,
    );
    // Disabled: no width brings it back, including the "not measured yet" width
    // that resolves to the full layout.
    const off = resolveRailModules('custom', { ...all, paceSparkline: false });
    for (const width of [...TIER_WIDTHS, 0, Number.NaN, 4000]) {
      expect(resolveRailLayout('custom', width, off).showSparkline).toBe(false);
    }
  });

  it('falls back to the mode only when the snapshot carries no flags', () => {
    // A caller with a mode and nothing else still gets a sensible rail…
    expect(resolveRailLayout('custom', 1280).showPace).toBe(true);
    // …but flags always win, including an all-off set, which is exactly what a
    // user who turned everything off asked for.
    const nothing = resolveRailModules('custom');
    expect(enabled(resolveRailLayout('custom', 1280, nothing))).toBe('(nothing)');
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
