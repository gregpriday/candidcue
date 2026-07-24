/**
 * §7.1 reserved geometry and §7.3 responsive degradation for the Coaching Rail.
 *
 * The single most important rule in this file: the rail's height is a function
 * of the *safe viewport* alone. It is not a function of `visible`, of the mode's
 * content, of whether a tip is showing, or of how many ribbon events arrived.
 * Hiding the rail fades its contents; it never reclaims the band, because
 * reclaiming it would move the reading line under the presenter mid-take —
 * exactly the failure §7.1 exists to prevent.
 *
 * The mount site computes the script's bottom inset with
 * {@link coachRailScriptInsetPx} and the rail computes its own height with
 * {@link coachRailReservedHeightPx}; both read the same numbers, so the band and
 * the hole left for it cannot drift apart.
 */
import type { CoachRailMode, CoachRailModules } from '../../../shared/contracts/coaching';

/** §7.1 minimum height, CSS px. */
export const RAIL_MIN_HEIGHT_PX = 52;
/** §7.1 preferred height, CSS px. */
export const RAIL_PREFERRED_HEIGHT_PX = 64;
/** §7.1 maximum height as a fraction of the safe viewport height. */
export const RAIL_MAX_VIEWPORT_FRACTION = 0.08;
/** §7.1 separation from the script, CSS px (spec allows 10–18). */
export const RAIL_SCRIPT_GAP_PX = 14;
/** §7.1 event ribbon height, CSS px (spec allows 4–8). */
export const RAIL_RIBBON_HEIGHT_PX = 6;

/** §7.6 rail text scale bounds. */
export const RAIL_TEXT_SCALE_MIN = 0.8;
export const RAIL_TEXT_SCALE_MAX = 1.5;

/**
 * §7.1. Reserved band height for a given safe viewport height.
 *
 * Preferred 64 px, capped at 8% of the viewport, floored at 52 px. Monotone in
 * `safeViewportHeightPx` and independent of every other input — see the file
 * header for why that matters.
 */
export function coachRailReservedHeightPx(safeViewportHeightPx: number): number {
  if (!Number.isFinite(safeViewportHeightPx) || safeViewportHeightPx <= 0) {
    // Pre-measurement. Reserve the preferred height rather than zero: starting
    // at zero and growing would shift the script once the first measurement
    // lands, which is the reflow this whole module exists to avoid.
    return RAIL_PREFERRED_HEIGHT_PX;
  }
  const capped = Math.min(RAIL_PREFERRED_HEIGHT_PX, safeViewportHeightPx * RAIL_MAX_VIEWPORT_FRACTION);
  return Math.round(Math.max(RAIL_MIN_HEIGHT_PX, capped));
}

/**
 * Total vertical space the script must give up: the band plus the separation
 * between the band and the script column. The mount site applies this as the
 * script layer's bottom inset.
 */
export function coachRailScriptInsetPx(safeViewportHeightPx: number): number {
  return coachRailReservedHeightPx(safeViewportHeightPx) + RAIL_SCRIPT_GAP_PX;
}

/** §7.6. */
export function clampRailTextScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(RAIL_TEXT_SCALE_MAX, Math.max(RAIL_TEXT_SCALE_MIN, scale));
}

/**
 * §7.3 degradation tiers, in the order the spec prescribes. Each tier drops
 * exactly one thing relative to the one above it, and the active tip is the
 * last thing standing.
 */
export type RailTier =
  | 'full'
  | 'no_sparkline'
  | 'variety_label'
  | 'no_filler_count'
  | 'compact'
  | 'tip_only';

const TIER_MIN_WIDTH_PX: ReadonlyArray<readonly [RailTier, number]> = [
  ['full', 900],
  ['no_sparkline', 760],
  ['variety_label', 620],
  ['no_filler_count', 500],
  ['compact', 380],
];

/**
 * §7.3. `widthPx <= 0` means "not measured yet" and resolves to `full` — a rail
 * that briefly collapsed to tip-only on first paint and then expanded would be
 * movement on the presenter's glass for no reason (§7.4).
 */
export function railTier(widthPx: number): RailTier {
  if (!Number.isFinite(widthPx) || widthPx <= 0) return 'full';
  for (const [tier, min] of TIER_MIN_WIDTH_PX) {
    if (widthPx >= min) return tier;
  }
  return 'tip_only';
}

/** What each mode is permitted to show at all (§6), before width degradation. */
export interface RailModulePermissions {
  paceTile: boolean;
  varietyTile: boolean;
  fillerCount: boolean;
  sparkline: boolean;
  ribbon: boolean;
  /** Speaking Score report §11.1. The 0–100 delivery score. */
  deliveryScore: boolean;
  /** §6.2 / §6.5: everything except critical alerts is withheld. */
  criticalTipsOnly: boolean;
}

export function modePermissions(mode: CoachRailMode): RailModulePermissions {
  switch (mode) {
    case 'off':
      return {
        paceTile: false,
        varietyTile: false,
        fillerCount: false,
        sparkline: false,
        ribbon: false,
        deliveryScore: false,
        criticalTipsOnly: true,
      };
    case 'minimal':
      return {
        paceTile: true,
        varietyTile: false,
        fillerCount: false,
        sparkline: false,
        ribbon: false,
        deliveryScore: false,
        criticalTipsOnly: true,
      };
    case 'review_only':
      return {
        paceTile: false,
        varietyTile: false,
        fillerCount: false,
        sparkline: false,
        ribbon: false,
        // §6.5: the take is still scored — the number is simply never shown
        // live. It waits in the post-take report.
        deliveryScore: false,
        criticalTipsOnly: true,
      };
    case 'studio':
      return {
        paceTile: true,
        varietyTile: true,
        fillerCount: true,
        sparkline: true,
        ribbon: true,
        deliveryScore: true,
        criticalTipsOnly: false,
      };
    // §6.6 `custom` is defined by individual module toggles, which is why
    // `CoachRailState.modules` exists: the producer resolves them and the stage
    // reads them. This branch is only the fallback for a caller that has a mode
    // and no flags — pass `modules` to {@link resolveRailLayout} and the user's
    // own set wins. Coach is the honest default for a mode with no other
    // information; it must never be the *answer* when flags were supplied.
    case 'custom':
    case 'coach':
    default:
      return {
        paceTile: true,
        varietyTile: true,
        fillerCount: true,
        sparkline: false,
        ribbon: true,
        deliveryScore: true,
        criticalTipsOnly: false,
      };
  }
}

/** The resolved layout after mode permissions and width degradation. */
export interface RailLayout {
  tier: RailTier;
  /**
   * Speaking Score report §11.1: the score sits left-most and survives the
   * whole §7.3 ladder except its last rung.
   *
   * Its place in the drop order is deliberate. The score costs two glyphs and
   * carries the rail's whole summary; the sparkline and the numeric variety
   * cost far more width for detail their own labels already imply, which is
   * exactly why §7.3 drops those two first. Dropping the score before either
   * of them would trade the cheapest information on the rail for the most
   * expensive. So it goes last, with the rest of the telemetry, one rung
   * before the tip — which §7.3 step 5 preserves above everything.
   */
  showScore: boolean;
  showPace: boolean;
  showSparkline: boolean;
  showVariety: boolean;
  /** §7.3 step 2: numeric variety becomes a bare label. */
  showVarietyNumber: boolean;
  showFillerCount: boolean;
  showRibbon: boolean;
  /** §7.3 step 4: left and right telemetry collapse into one row. */
  compactTelemetry: boolean;
}

/**
 * @param modules §6.6 resolved module flags from the snapshot. Supplying them
 *   is what lets `custom` mean what the user actually chose rather than being
 *   rendered as Coach — see the note on the `custom` branch of
 *   {@link modePermissions}. Omitted, the mode's own reading stands.
 */
export function resolveRailLayout(
  mode: CoachRailMode,
  widthPx: number,
  modules?: CoachRailModules,
): RailLayout {
  const permissions = modePermissions(mode);
  const tier = railTier(widthPx);
  const rank = (t: RailTier): number =>
    ['full', 'no_sparkline', 'variety_label', 'no_filler_count', 'compact', 'tip_only'].indexOf(t);
  const at = rank(tier);
  const telemetryVisible = at < rank('tip_only');
  return {
    tier,
    showScore: (modules?.deliveryScore ?? permissions.deliveryScore) && telemetryVisible,
    showPace: permissions.paceTile && telemetryVisible,
    showSparkline: permissions.sparkline && at < rank('no_sparkline'),
    showVariety: permissions.varietyTile && telemetryVisible,
    showVarietyNumber: permissions.varietyTile && at < rank('variety_label'),
    showFillerCount: permissions.fillerCount && at < rank('no_filler_count'),
    // The ribbon survives the compact tier: §7.3 step 3 keeps the event ticks
    // when the filler *count* goes. It goes only at the smallest layout.
    showRibbon: permissions.ribbon && telemetryVisible,
    compactTelemetry: at >= rank('compact'),
  };
}
