/**
 * Stage/display command payloads (spec §46.6) — exact twins of the Rust
 * shapes in src-tauri/src/windows/mod.rs.
 */

export interface PhysicalPoint {
  x: number;
  y: number;
}

export interface PhysicalDimensions {
  width: number;
  height: number;
}

export interface LogicalDimensions {
  width: number;
  height: number;
}

/** Twin of Rust `DisplayDescriptor` (spec §52.3). */
export interface DisplayDescriptor {
  id: string;
  name?: string;
  physicalPosition: PhysicalPoint;
  physicalSize: PhysicalDimensions;
  scaleFactor: number;
  logicalSize: LogicalDimensions;
  primary: boolean;
  /**
   * Stable panel identity (name + physical size, plus an ordinal only when two
   * connected panels are genuinely identical). Deliberately NOT affected by
   * where the display sits or how it is scaled, so rearranging displays does
   * not invalidate saved profiles.
   */
  fingerprint: string;
  /**
   * Soft arrangement hash — changes when displays are moved or rescaled. Only
   * ever a "your arrangement changed" hint; never used to resolve a profile.
   */
  topologyHash: string;
}

/** Twin of Rust `IdentificationSession` (spec §52.4). */
export interface IdentificationSession {
  sessionId: string;
  durationMs: number;
  displays: Array<{
    number: number;
    fingerprint: string;
    name?: string;
    logicalSize: LogicalDimensions;
    primary: boolean;
  }>;
}

/**
 * Twin of Rust `OpenStageRequest`.
 *
 * `sessionId` is mandatory (M1). It used to be optional, so the stage could be
 * registered with no owning session — and then `close_stage` accepted any id,
 * and every downstream generation check had nothing to compare against.
 */
export interface StageOpenRequest {
  displayFingerprint?: string | null;
  sessionId: string;
}

/** Twin of Rust `StageOpenResult`. */
export interface StageOpenResult {
  stageGeneration: number;
  displayFingerprint: string;
}

/** Twin of Rust `StageWindowState`. */
export interface StageWindowState {
  exists: boolean;
  visible: boolean;
  /** Presenting full-screen on its display — true for borderless too. */
  fullscreen: boolean;
  /** The OS native-fullscreen flag specifically (macOS Space / Win exclusive). */
  nativeFullscreen: boolean;
  /** The display the stage ACTUALLY landed on, verified after show. */
  displayFingerprint?: string;
  stageGeneration: number;
}

/** Twin of Rust `StageAck` (publish_stage_document result). */
export interface StageAck {
  accepted: boolean;
  stageGeneration: number;
  sessionId?: string;
}
