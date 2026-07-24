/**
 * Listener library service (spec §46.7): installed pack listing and media
 * resolution into the ListenerStageSelection the stage consumes. URLs are
 * asset-protocol URLs minted by Rust (§47.8).
 */
import type { ListenerGeometry, ListenerStageSelection } from '../../shared/contracts';
import { clampOffsetPercent } from '../../shared/listener/geometry';
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
  /** Horizontal mirror; applied inside the crop, so it never flips offsets. */
  mirrorVideo?: boolean;
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
  return {
    anchorX: 0.5,
    anchorY: 0.45,
    scale: 1,
    // Percent of the frame, NOT a 0..1 fraction — the stage feeds these
    // straight into `translate(cropX%, cropY%)`.
    cropX: clampOffsetPercent(overrides.offsetXPercent ?? 0, cropZoom),
    cropY: clampOffsetPercent(overrides.offsetYPercent ?? 0, cropZoom),
    cropZoom,
    opacity: Math.max(0.05, 1 - (overrides.dimPercent ?? 40) / 100),
    blurPx: overrides.blurPx ?? 0,
    saturation: 0.85,
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
  return {
    packId: media.packId,
    version: media.version,
    variant: 'default',
    placement: 'background',
    geometry: buildListenerGeometry(media.defaultZoom, overrides),
    clipUrls: media.clips.map((clip) => ({
      id: clip.id,
      url: clip.url,
      mime: clip.mime,
      durationMs: clip.durationMs,
      posterUrl: media.posterUrl,
    })),
  };
}
