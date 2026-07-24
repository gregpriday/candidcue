/**
 * Listener contracts (spec Appendix C.6) plus the local pack manifest shape
 * (spec §39.1, simplified for bundled listening-only packs).
 */

export interface ListenerCatalogueEntry {
  packId: string;
  latestVersion: string;
  displayName: string;
  description: string;
  thumbnailUrl: string;
  approximateBytes: number;
  variants: string[];
  minimumAppVersion: string;
  installedVersion?: string;
}

export interface ListenerSelection {
  packId: string;
  version: string;
  variant: string;
}

export interface ListenerGeometry {
  anchorX: number;
  anchorY: number;
  scale: number;
  cropX: number;
  cropY: number;
  cropZoom: number;
  opacity: number;
  blurPx: number;
  saturation: number;
  mirrorVideo: boolean;
}

/** Placement modes for the Listener layer on the stage (spec §37.4). */
export type ListenerPlacementMode =
  | 'background'
  | 'lens_left'
  | 'lens_right'
  | 'top_strip'
  | 'pip'
  | 'off';

export interface ListenerStageSelection extends ListenerSelection {
  geometry: ListenerGeometry;
  clipUrls: Array<{
    id: string;
    url: string;
    mime: string;
    durationMs: number;
    posterUrl: string;
  }>;
  /** Stage placement mode; defaults to 'background' when omitted (§37.4). */
  placement?: ListenerPlacementMode;
}

/* ---------------------------------------------------------------------------
 * Pack manifest (assets/listeners/<id>/manifest.json).
 * The new product has no speaking character: every clip is a neutral
 * listening loop. Downloadable packs additionally carry per-file checksums
 * and a signature (spec §39.1); bundled packs keep the simplified shape.
 * ------------------------------------------------------------------------- */

export type ListenerClipRole = 'neutral';

export interface ListenerManifestClip {
  id: string;
  role: ListenerClipRole;
  /** Path relative to the pack directory. */
  path: string;
  mime: string;
  durationMs: number;
  sizeBytes: number;
}

export interface ListenerPackManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  displayName: string;
  description: string;
  /** Poster image shown before video is ready, relative to the pack dir. */
  poster: string;
  /** Small avatar used in pickers, relative to the pack dir. */
  profileImage?: string;
  /** Default crop zoom so the user can reposition the listener. */
  defaultZoom: number;
  fit: 'cover' | 'contain';
  clips: ListenerManifestClip[];
}
