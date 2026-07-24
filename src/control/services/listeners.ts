/**
 * Listener library service (spec §46.7): installed pack listing and media
 * resolution into the ListenerStageSelection the stage consumes. URLs are
 * asset-protocol URLs minted by Rust (§47.8).
 */
import type { ListenerGeometry, ListenerStageSelection } from '../../shared/contracts';
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
  /** -50..50 percent offsets mapped to cropX/cropY (-0.5..0.5). */
  offsetXPercent?: number;
  offsetYPercent?: number;
  /** 0..80 dim percent → opacity. */
  dimPercent?: number;
  blurPx?: number;
}

export function buildListenerGeometry(
  defaultZoom: number,
  overrides: ListenerGeometryOverrides = {},
): ListenerGeometry {
  const zoomFactor = (overrides.zoomPercent ?? 100) / 100;
  return {
    anchorX: 0.5,
    anchorY: 0.45,
    scale: 1,
    cropX: (overrides.offsetXPercent ?? 0) / 100,
    cropY: (overrides.offsetYPercent ?? 0) / 100,
    cropZoom: defaultZoom * zoomFactor,
    opacity: Math.max(0.05, 1 - (overrides.dimPercent ?? 40) / 100),
    blurPx: overrides.blurPx ?? 0,
    saturation: 0.85,
    mirrorVideo: false,
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
