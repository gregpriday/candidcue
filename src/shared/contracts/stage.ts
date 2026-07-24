/**
 * Stage event protocol — the complete surface between control/Rust and the
 * minimally privileged stage window (spec §16, §43.5, §45.6).
 *
 * The stage window only holds `core:event:allow-listen`/`allow-unlisten`.
 * Everything it knows arrives as one of the inbound events below; everything
 * it wants to say goes out as one of the outbound events (which additionally
 * requires `core:event:allow-emit` in the stage capability — see integration
 * notes). The stage never invokes commands.
 */
import type { Uuid } from './core';
import type { StageSessionEnvelope, StageSettings } from './display';
import type { TrackingSnapshot } from './tracking';
import type { ListenerStageSelection } from './listener';

/* ---------------------------------------------------------------------------
 * Event names
 * ------------------------------------------------------------------------- */

export const STAGE_EVENT = {
  /** control/Rust → stage: full hydration snapshot (StageSessionEnvelope). */
  snapshot: 'stage:snapshot',
  /** control/Rust → stage: tracking motion updates (TrackingSnapshot). */
  tracking: 'stage:tracking',
  /** control/Rust → stage: state directives (freeze/blank/ack/settings/…). */
  state: 'stage:state',
  /** control/Rust → stage: liveness heartbeat (spec §43.5). */
  heartbeat: 'stage:heartbeat',
  /** stage → control: hydration/layout readiness acknowledgement. */
  ready: 'stage:ready',
  /** stage → control: heartbeat acknowledgement. */
  heartbeatAck: 'stage:heartbeat-ack',
  /** stage → control: keyboard/pointer intents — control decides (§16.9). */
  intent: 'stage:intent',
  /** stage → control: Listener playback health (§40.5 failure containment). */
  listenerHealth: 'stage:listener-health',
} as const;

export type StageEventName = (typeof STAGE_EVENT)[keyof typeof STAGE_EVENT];

/* ---------------------------------------------------------------------------
 * Inbound payloads (control/Rust → stage)
 * ------------------------------------------------------------------------- */

/** `stage:snapshot` — the whole render model in one validated envelope. */
export type StageSnapshotPayload = StageSessionEnvelope;

/** `stage:tracking` — revisioned tracking snapshots drive all text motion. */
export type StageTrackingPayload = TrackingSnapshot;

/**
 * `stage:state` — small imperative directives. Each carries the stage
 * generation so directives from a previous stage lifetime are ignored.
 */
export type StageDirective =
  | { kind: 'blank'; blanked: boolean; keepListener?: boolean }
  | { kind: 'freeze'; frozen: boolean }
  | { kind: 'ack'; label: string; durationMs?: number }
  | { kind: 'settings'; settings: StageSettings }
  | { kind: 'listener'; listener: ListenerStageSelection | null }
  | { kind: 'calibration'; active: boolean; crosshairX?: number; crosshairY?: number }
  | { kind: 'diagnostics'; visible: boolean };

export interface StageStatePayload {
  stageGeneration: number;
  directive: StageDirective;
}

/** `stage:heartbeat` — periodic liveness signal from control (spec §43.5). */
export interface StageHeartbeatPayload {
  stageGeneration: number;
  revision: number;
  sentAtMs: number;
}

/**
 * If no heartbeat/snapshot/tracking arrives for this long while live, the
 * stage freezes locally (control is presumed gone; it owns recovery).
 */
export const STAGE_HEARTBEAT_GRACE_MS = 5000;

/* ---------------------------------------------------------------------------
 * Outbound payloads (stage → control; requires emit permission)
 * ------------------------------------------------------------------------- */

/** `stage:ready` — emitted after hydration + fonts + first stable layout. */
export interface StageReadyPayload {
  stageGeneration: number;
  sessionId?: Uuid;
  hydrated: boolean;
  layoutReady: boolean;
  fontsReady: boolean;
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
}

/** `stage:heartbeat-ack` — response to `stage:heartbeat`. */
export interface StageHeartbeatAckPayload {
  stageGeneration: number;
  revision: number;
  lastTrackingRevision: number | null;
  mediaHealthy: boolean;
  respondedAtMs: number;
}

/**
 * `stage:intent` — the stage never acts on privileged decisions itself; it
 * reports what the user did and control/Rust decides (spec §16.9).
 */
export type StageIntent =
  /** Escape pressed once (control shows confirm toast) or twice within 1.5s. */
  | { kind: 'escape'; presses: 1 | 2 }
  /** Mouse-wheel manual scroll, in logical stage pixels (already applied locally). */
  | { kind: 'manual_scroll'; deltaPx: number }
  /** Arrow/page keys: semantic step requests. */
  | { kind: 'manual_step'; direction: 'forward' | 'back'; unit: 'line' | 'paragraph' }
  /** Space bar. */
  | { kind: 'toggle_pause' }
  /** Single click focused the stage; no script movement occurred. */
  | { kind: 'stage_focused' };

export interface StageIntentPayload {
  stageGeneration: number;
  intent: StageIntent;
  atMs: number;
}

/** `stage:listener-health` — nonfatal Listener engine status (§40.5). */
export type StageListenerHealthStatus = 'ok' | 'poster_fallback' | 'failed' | 'disabled';

export interface StageListenerHealthPayload {
  stageGeneration: number;
  status: StageListenerHealthStatus;
  code?: 'decode_failure' | 'unsupported_codec' | 'source_unavailable';
  clipId?: string;
}
