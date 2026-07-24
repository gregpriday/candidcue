/**
 * Stage event protocol — the complete surface between control/Rust and the
 * minimally privileged stage window (spec §16, §43.5, §45.6, §46.9).
 *
 * Event names use the Rust `stage://` convention and are mirrored verbatim in
 * `src-tauri/src/windows/mod.rs::events` (a Rust test asserts the two sides
 * stay in sync via include_str! over this file — keep the string literals
 * grep-able).
 *
 * The stage window only holds `core:event:allow-listen`/`allow-unlisten` plus
 * `allow-emit`/`allow-emit-to` for the outbound acks below. Everything it
 * knows arrives as one of the inbound events; the stage never invokes
 * commands.
 *
 * Direction summary:
 *   control → Rust command → stage : load-session, tracking-snapshot,
 *                                    apply-command, listener-state,
 *                                    close-session
 *   control → stage (direct emitTo): heartbeat (§43.5, ~1s cadence)
 *   stage → Rust bridge (+ control) : hydrated, layout-ready, heartbeat-ack,
 *                                    media-error, escape-requested
 *   stage → control (direct)        : intent
 *   Rust → control                  : ready, closed, error (CONTROL_EVENT)
 */
import type { Uuid } from './core';
import type { StageSessionEnvelope, StageSettings } from './display';
import type { TrackingSnapshot } from './tracking';
import type { ListenerStageSelection } from './listener';

/* ---------------------------------------------------------------------------
 * Event names
 * ------------------------------------------------------------------------- */

export const STAGE_EVENT = {
  /** Rust → stage: full hydration snapshot (StageSessionEnvelope). */
  loadSession: 'stage://load-session',
  /** Rust → stage: tracking motion updates (TrackingSnapshot). */
  trackingSnapshot: 'stage://tracking-snapshot',
  /** Rust → stage: state directives (freeze/blank/ack/settings/…). */
  applyCommand: 'stage://apply-command',
  /** Rust → stage: Listener selection/geometry directive. */
  listenerState: 'stage://listener-state',
  /** Rust → stage: the session is over; the window is about to close. */
  closeSession: 'stage://close-session',
  /** control → stage: liveness heartbeat (spec §43.5, ~1 s cadence). */
  heartbeat: 'stage://heartbeat',

  /** stage → Rust: envelope received and applied (handshake step 1). */
  hydrated: 'stage://hydrated',
  /** stage → Rust: fonts + first stable layout done (handshake step 2). */
  layoutReady: 'stage://layout-ready',
  /** stage → Rust: heartbeat acknowledgement. */
  heartbeatAck: 'stage://heartbeat-ack',
  /** stage → Rust: nonfatal media/Listener failure (§40.5 containment). */
  mediaError: 'stage://media-error',
  /** stage → Rust → control: Escape pressed on the stage (§16.9). */
  escapeRequested: 'stage://escape-requested',
  /** stage → control: other keyboard/pointer intents — control decides. */
  intent: 'stage://intent',
} as const;

export type StageEventName = (typeof STAGE_EVENT)[keyof typeof STAGE_EVENT];

/** Rust → control notifications (windows/mod.rs events, spec §46.9). */
export const CONTROL_EVENT = {
  /** Stage handshake finished (hydrated + layout ready). */
  stageReady: 'stage://ready',
  /** Stage window was destroyed (crash or close). */
  stageClosed: 'stage://closed',
  /** Stage reported a media error. */
  stageError: 'stage://error',
  identifyDisplays: 'app://identify-displays',
  scriptExternalChange: 'script://external-change',
  deviceOrDisplayChange: 'app://device-or-display-change',
  diagnosticWarning: 'diagnostic://warning',
} as const;

export type ControlEventName = (typeof CONTROL_EVENT)[keyof typeof CONTROL_EVENT];

/* ---------------------------------------------------------------------------
 * Inbound payloads (control/Rust → stage)
 * ------------------------------------------------------------------------- */

/** `stage://load-session` — the whole render model in one validated envelope. */
export type StageSnapshotPayload = StageSessionEnvelope;

/** `stage://tracking-snapshot` — revisioned snapshots drive all text motion. */
export type StageTrackingPayload = TrackingSnapshot;

/**
 * `stage://apply-command` / `stage://listener-state` — small imperative
 * directives. Each carries the stage generation so directives from a
 * previous stage lifetime are ignored.
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

/** `stage://close-session` — emitted just before the window is destroyed. */
export interface StageCloseSessionPayload {
  sessionId: Uuid;
}

/** `stage://heartbeat` — periodic liveness signal from control (spec §43.5). */
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
 * Outbound payloads (stage → Rust/control; requires emit permission)
 * ------------------------------------------------------------------------- */

/** `stage://hydrated` — the envelope was received and applied. */
export interface StageHydratedPayload {
  stageGeneration: number;
  sessionId?: Uuid;
}

/** `stage://layout-ready` — hydration + fonts + first stable layout done. */
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

/** `stage://heartbeat-ack` — response to `stage://heartbeat`. */
export interface StageHeartbeatAckPayload {
  stageGeneration: number;
  revision: number;
  /** Field name mirrored by the Rust bridge (app.rs reads `trackingRevision`). */
  trackingRevision: number | null;
  mediaHealthy: boolean;
  respondedAtMs: number;
}

/** `stage://escape-requested` — Escape pressed once or twice within 1.5 s. */
export interface StageEscapePayload {
  stageGeneration: number;
  presses: 1 | 2;
  atMs: number;
}

/**
 * `stage://intent` — the stage never acts on privileged decisions itself; it
 * reports what the user did and control decides (spec §16.9). Escape travels
 * separately as `stage://escape-requested` so Rust can relay it.
 */
export type StageIntent =
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

/** `stage://media-error` — nonfatal Listener engine status (§40.5). */
export type StageListenerHealthStatus = 'ok' | 'poster_fallback' | 'failed' | 'disabled';

export interface StageListenerHealthPayload {
  stageGeneration: number;
  status: StageListenerHealthStatus;
  code?: 'decode_failure' | 'unsupported_codec' | 'source_unavailable';
  clipId?: string;
}

/* ---------------------------------------------------------------------------
 * Rust → control payloads
 * ------------------------------------------------------------------------- */

/** `stage://ready` — relayed by Rust once the stage handshake completes. */
export interface ControlStageReadyPayload {
  stageGeneration: number;
  sessionId?: Uuid;
  layoutReady: boolean;
}

/** `stage://closed` — the stage window was destroyed. */
export interface ControlStageClosedPayload {
  stageGeneration: number;
}
