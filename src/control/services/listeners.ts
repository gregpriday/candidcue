/**
 * Listener library service (spec §46.7): installed pack listing and media
 * resolution into the ListenerStageSelection the stage consumes. URLs are
 * asset-protocol URLs minted by Rust (§47.8).
 */
import type {
  ListenerGeometry,
  ListenerPlacementMode,
  ListenerStageSelection,
} from '../../shared/contracts';
import { clampOffsetPercent } from '../../shared/listener/geometry';
import { defaultPlacementGeometry } from '../../shared/listener/placement';
import { invokeOrMock } from './ipc';

/** Twin of Rust `InstalledListener`. */
export interface InstalledListener {
  packId: string;
  version: string;
  displayName: string;
  description: string;
  source: 'bundled' | 'downloaded';
  sizeBytes: number;
  clipCount: number;
  state: 'installed' | 'installing' | 'failed' | 'rollback';
  installedAt?: string;
}

/** Twin of Rust `ListenerMediaUrls`. */
export interface ListenerMediaUrls {
  packId: string;
  version: string;
  posterUrl: string;
  profileUrl?: string;
  defaultZoom: number;
  fit: 'cover' | 'contain';
  clips: Array<{ id: string; url: string; mime: string; durationMs: number }>;
}

export async function listInstalledListeners(): Promise<InstalledListener[]> {
  return invokeOrMock<InstalledListener[]>('list_installed_listeners', undefined, () => []);
}

export async function resolveListenerMedia(
  packId: string,
  version: string,
): Promise<ListenerMediaUrls> {
  return invokeOrMock<ListenerMediaUrls>(
    'resolve_listener_media',
    { packId, version },
    () => {
      // Browser-dev fallback: repo-relative URLs served by Vite.
      const base = `/assets/listeners/${packId}`;
      return {
        packId,
        version,
        posterUrl: `${base}/poster.webp`,
        defaultZoom: 1.15,
        fit: 'cover',
        clips: [
          {
            id: 'listening-7s',
            url: `${base}/listening/${packId}-listening-7s.mp4`,
            mime: 'video/mp4',
            durationMs: 7042,
          },
          {
            id: 'listening-10s',
            url: `${base}/listening/${packId}-listening-10s.mp4`,
            mime: 'video/mp4',
            durationMs: 10042,
          },
        ],
      };
    },
  );
}

export interface ListenerGeometryOverrides {
  /**
   * Where the media box sits on the stage (§37.4). Decides the default anchors
   * and the box size; see src/shared/listener/placement.ts.
   */
  placement?: ListenerPlacementMode;
  /**
   * Multiplier on the placement's default box size, as a PERCENT (100 = the
   * placement's own size). Ignored by 'background', which is the whole stage.
   */
  sizePercent?: number;
  /** 100 = the pack's manifest defaultZoom; percent scale on top of it. */
  zoomPercent?: number;
  /**
   * Framing offsets in PERCENT of the visible frame — positive x = right,
   * positive y = down. These map 1:1 onto `ListenerGeometry.cropX/cropY`; see
   * the unit contract in src/shared/listener/geometry.ts. They are clamped to
   * the zoom-derived safe window, which is ±(cropZoom - 1) / 2 × 100 percent,
   * so the caller can pass any value without exposing the media edge.
   */
  offsetXPercent?: number;
  offsetYPercent?: number;
  /** 0..80 dim percent → opacity. */
  dimPercent?: number;
  blurPx?: number;
  /** 0..100 colour percent → the CSS `saturate()` factor the stage applies. */
  saturationPercent?: number;
  /**
   * Horizontal mirror of the VIDEO, which is independent of the script mirror:
   * a glass rig flips the script optically and the Listener with it, so the
   * media has to be pre-flipped to come back the right way round. Applied
   * inside the crop, so it never flips the offsets.
   */
  mirrorVideo?: boolean;
}

/**
 * The inverse of the `sizePercent` conversion, for the same reason
 * `listenerScalePercentFromCropZoom` exists: a display profile stores the
 * resolved `scale`, and restoring the slider has to undo the /100.
 *
 * Trivial today — but the last geometry field restored "by eye" compounded
 * across sessions, so both directions live here, next to each other, and are
 * covered by the same round-trip test.
 */
export function listenerSizePercentFromScale(scale: number): number {
  const value = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return Math.round(value * 100);
}

/** The inverse of the dim → opacity conversion. */
export function listenerDimPercentFromOpacity(opacity: number): number {
  const value = Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1;
  return Math.round((1 - value) * 100);
}

/** The inverse of the colour → saturation conversion. */
export function listenerSaturationPercentFromFactor(saturation: number): number {
  const value = Number.isFinite(saturation) && saturation >= 0 ? saturation : 1;
  return Math.round(value * 100);
}

/**
 * The inverse of `buildListenerGeometry`'s zoom conversion.
 *
 * A display profile stores the *resolved* geometry, so restoring the slider
 * has to undo `cropZoom = defaultZoom × scale/100`. Doing that by eye is how
 * this went wrong: multiplying by 100 without dividing the pack's default zoom
 * back out made the scale compound across sessions — a pack whose
 * `defaultZoom` is 1.15 restored as 115%, saved as 1.3225, restored as 132% —
 * so the Listener grew by 15% of herself every time the profile round-tripped,
 * and the offset sliders' range silently widened underneath her.
 *
 * Kept beside the forward conversion so the two cannot drift apart, and
 * guarded so a missing or nonsensical `defaultZoom` falls back to the stored
 * zoom rather than dividing by zero.
 */
export function listenerScalePercentFromCropZoom(cropZoom: number, defaultZoom: number): number {
  const base = Number.isFinite(defaultZoom) && defaultZoom > 0 ? defaultZoom : 1;
  return Math.round((cropZoom / base) * 100);
}

export function buildListenerGeometry(
  defaultZoom: number,
  overrides: ListenerGeometryOverrides = {},
): ListenerGeometry {
  const zoomFactor = (overrides.zoomPercent ?? 100) / 100;
  const cropZoom = defaultZoom * zoomFactor;
  const placement = overrides.placement ?? 'background';
  // Anchors come from the placement, not from a constant here: they used to be
  // a hard-coded (0.5, 0.45) that only 'background' — which ignores them — ever
  // saw, so a lens-side Listener would have been centred behind the text.
  const anchors = defaultPlacementGeometry(placement);
  return {
    placement,
    anchorX: anchors.anchorX,
    anchorY: anchors.anchorY,
    scale: (overrides.sizePercent ?? 100) / 100,
    // Percent of the frame, NOT a 0..1 fraction — the stage feeds these
    // straight into `translate(cropX%, cropY%)`.
    cropX: clampOffsetPercent(overrides.offsetXPercent ?? 0, cropZoom),
    cropY: clampOffsetPercent(overrides.offsetYPercent ?? 0, cropZoom),
    cropZoom,
    opacity: Math.max(0.05, 1 - (overrides.dimPercent ?? 40) / 100),
    blurPx: overrides.blurPx ?? 0,
    // The stage used to hard-code 0.85 here while Rust declared a `saturation`
    // setting nothing could reach. One value, one home: the setting.
    saturation: Math.max(0, (overrides.saturationPercent ?? 85) / 100),
    mirrorVideo: overrides.mirrorVideo ?? false,
  };
}

/** Resolve a full stage selection for one installed pack. */
export async function buildListenerSelection(
  packId: string,
  version: string,
  overrides: ListenerGeometryOverrides = {},
): Promise<ListenerStageSelection> {
  const media = await resolveListenerMedia(packId, version);
  const geometry = buildListenerGeometry(media.defaultZoom, overrides);
  return {
    packId: media.packId,
    version: media.version,
    variant: 'default',
    // Lifted from the geometry rather than taken from a second argument: the
    // geometry is what a display profile persists, so it is the one writer of
    // the placement and this is the one place it reaches the stage contract.
    placement: geometry.placement ?? 'background',
    geometry,
    clipUrls: media.clips.map((clip) => ({
      id: clip.id,
      url: clip.url,
      mime: clip.mime,
      durationMs: clip.durationMs,
      posterUrl: media.posterUrl,
    })),
  };
}
