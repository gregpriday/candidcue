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
  fingerprint: string;
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

/** Twin of Rust `OpenStageRequest`. */
export interface StageOpenRequest {
  displayFingerprint?: string | null;
  sessionId?: string | null;
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
  fullscreen: boolean;
  stageGeneration: number;
}

/** Twin of Rust `StageAck` (publish_stage_document result). */
export interface StageAck {
  accepted: boolean;
  stageGeneration: number;
  sessionId?: string;
}
