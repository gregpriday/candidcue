/**
 * Stage/display command payloads (spec §46.6) not yet mirrored in the shared
 * contracts. Promote additively when the Rust window commands land.
 */

export interface DisplayDescriptor {
  id: string;
  label: string;
  widthPx: number;
  heightPx: number;
  scaleFactor: number;
  isPrimary: boolean;
  /** Remembered display profile name, if any (spec §14.2 A). */
  profileName?: string;
}

export interface StageOpenRequest {
  displayId: string;
  fullscreen: boolean;
  alwaysOnTop: boolean;
  windowedPreview: boolean;
}

export interface StageOpenResult {
  opened: boolean;
  displayId: string;
  stageGeneration: number;
}

export interface StageWindowState {
  fullscreen: boolean;
  visible: boolean;
}
