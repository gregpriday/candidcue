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
 *   control → stage (direct emitTo): heartbeat (§43.5, ~1s cadence),
 *                                    semantic-frame (companion §26.1, 15–30 Hz)
 *   stage → Rust bridge             : hydrated, layout-ready, heartbeat-ack,
 *                                    media-error, escape-pressed,
 *                                    motion-report, layout-error
 *   stage → control (direct)        : intent
 *   Rust → control                  : ready, closed, error (CONTROL_EVENT),
 *                                    escape-requested, motion-ack,
 *                                    layout-failed
 */
import type { Uuid } from './core';
import type { StageSessionEnvelope, StageSettings } from './display';
import type { AlignmentSnapshot, AlignmentViewportHint } from './alignment';
import type { StageMotionAck } from './smooth-follow';
import type { ListenerStageSelection } from './listener';

/* ---------------------------------------------------------------------------
 * Event names
 * ------------------------------------------------------------------------- */

export const STAGE_EVENT = {
  /** Rust → stage: full hydration snapshot (StageSessionEnvelope). */
  loadSession: 'stage://load-session',
  /** Rust → stage: state directives (freeze/blank/ack/settings/…). */
  applyCommand: 'stage://apply-command',
  /** Rust → stage: Listener selection/geometry directive. */
  listenerState: 'stage://listener-state',
  /** Rust → stage: the session is over; the window is about to close. */
  closeSession: 'stage://close-session',
  /** control → stage: liveness heartbeat (spec §43.5, ~1 s cadence). */
  heartbeat: 'stage://heartbeat',
  /**
   * Rust → stage: one `AlignmentSnapshot` per transcript event (~1/s).
   *
   * From Rust, not from control: the alignment engine runs beside the Inworld
   * socket because that is where the audio clock its predictions are timed
   * against already is. Control is not in this path — it receives the same
   * snapshot separately on `CONTROL_EVENT.alignmentSnapshot`.
   */
  alignmentSnapshot: 'stage://alignment-snapshot',
  /**
   * stage → Rust: the debounced visible token range.
   *
   * This direction is forced: the stage capability grants event emission and
   * no invoke permission at all, so a hint cannot be a command. It is a prior
   * on candidate ranking rather than an instruction, which makes an event the
   * honest shape for it anyway.
   */
  viewportHint: 'stage://viewport-hint',

  /**
   * control → stage: raw recogniser text for the stage's transcript bar.
   * Same direct `emitTo` path as the heartbeat — it is a diagnostic readout,
   * not a validated document, and a dropped one costs nothing.
   */
  transcriptTap: 'stage://transcript-tap',

  /**
   * stage → Rust: the stage's subscriptions are registered (handshake step 0).
   *
   * A Tauri event is delivered by evaluating JS in the target webview and is
   * never queued, so an envelope published between `open_stage` returning and
   * the stage bundle executing lands on a page with no listeners and is lost
   * outright — the stage then never hydrates and the start sequence times out
   * with nothing to show for it. This is the stage saying it is reachable;
   * Rust answers by replaying the envelope it holds for this generation, if
   * any. Emitted again after a reload, which is how the stage recovers under
   * `tauri dev`.
   */
  listening: 'stage://listening',
  /** stage → Rust: envelope received and applied (handshake step 1). */
  hydrated: 'stage://hydrated',
  /** stage → Rust: fonts + first stable layout done (handshake step 2). */
  layoutReady: 'stage://layout-ready',
  /** stage → Rust: heartbeat acknowledgement. */
  heartbeatAck: 'stage://heartbeat-ack',
  /** stage → Rust: nonfatal media/Listener failure (§40.5 containment). */
  mediaError: 'stage://media-error',

  /*
   * S1 — why these come in pairs.
   *
   * A webview `emit()` is a BROADCAST: Tauri's manager fans it out to every
   * webview's JS listeners AND to the Rust `listen_any` handlers, and a JS
   * listener registered with the default target `Any` matches unconditionally
   * (`match_any_or_filter` in tauri/src/event/listener.rs), so no `emitTo`
   * target can exclude it. When the stage emitted `stage://escape-requested`
   * and Rust re-emitted the SAME name to control, control's handler ran twice —
   * once ungated, straight from the stage, and once after the generation check
   * in app.rs. A double Escape stopped the session twice; motion acks were
   * ingested twice into the §61 degradation logic.
   *
   * So the stage's own emission and Rust's relay have different names, which is
   * already the pattern for `layout-ready` → `stage://ready` and `media-error`
   * → `stage://error`. Control listens only for the relayed name, and the only
   * path to it runs through the coordinator's generation check.
   */

  /** stage → Rust: Escape pressed on the stage (§16.9). Relayed as below. */
  escapePressed: 'stage://escape-pressed',
  /** Rust → control: a generation-checked Escape from the live stage (§16.9). */
  escapeRequested: 'stage://escape-requested',
  /** stage → Rust: periodic `StageMotionAck` (companion §54). Relayed as below. */
  motionReport: 'stage://motion-report',
  /**
   * stage → Rust: a §62 stage-layout failure (line measurement unusable after
   * the bounded rebuild), or its recovery. Relayed as below.
   */
  layoutError: 'stage://layout-error',
  /**
   * Rust → control: a generation-checked §62 stage-layout failure/recovery.
   *
   * This has its own event rather than riding `stage://error`, which carries
   * Listener media faults and window-layer errors: those are two unrelated
   * failures with different recovery, and control was left sniffing payload
   * substrings to tell them apart. A layout failure means motion is HELD — the
   * operator has to see it and can act on it (§62 "expose a recoverable
   * stage-layout error in control").
   */
  layoutFailed: 'stage://layout-failed',
  /**
   * Rust → control: a generation-checked periodic `StageMotionAck`
   * (companion §54). Diagnostics and recovery only — deliberately NOT a
   * high-frequency feedback loop into the semantic aligner.
   */
  motionAck: 'stage://motion-ack',
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
  /**
   * Rust → control: the same `AlignmentSnapshot` the stage receives, for
   * progress, recovery affordances and the take summary. A separate name from
   * the stage's copy because they are different contracts to different
   * windows — the stage follows it, control reports on it.
   */
  alignmentSnapshot: 'align://snapshot',
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

/**
 * `stage://tracking-snapshot` — revisioned snapshots. Since the v2 motion
 * controller (companion §32.1–32.5, which replaces primary §32) these drive the
 * *degraded* motion path only: they are what the stage follows when no semantic
 * frame is current.
 */
export type StageAlignmentPayload = AlignmentSnapshot;

/** `stage://semantic-frame` — the v2 motion signal (companion §26.1). */
export type StageViewportHintPayload = AlignmentViewportHint;

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
 * `stage://transcript-tap` — the words the recogniser is returning, shown raw
 * along the bottom of the stage.
 *
 * This is a diagnostic the presenter can read at a glance, and it exists
 * because its absence cost days. "It followed for a bit then stopped" and "the
 * microphone was never captured" and "the transcript is fine but the aligner
 * is not" are three completely different faults that look identical from the
 * stage — a script that has stopped moving. One of them was another
 * application holding the microphone, which CandidCue cannot prevent and had
 * no way to report.
 *
 * Deliberately the RAW provider text rather than anything the aligner has
 * decided: this is the reading upstream of every judgement the app makes, so
 * it stays truthful when the judgements are wrong.
 */
export interface StageTranscriptTapPayload {
  stageGeneration: number;
  /** The most recent words heard, oldest first, already trimmed for display. */
  text: string;
  /** True when the provider has finalised the utterance this text came from. */
  final: boolean;
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

/**
 * `stage://listening` — the stage's subscriptions are registered.
 *
 * Deliberately carries no `stageGeneration`: the stage learns its generation
 * from the envelope, and this is emitted before any envelope has arrived. The
 * replay it triggers is generation-checked in the coordinator instead, against
 * the stage window Rust currently has open.
 */
export interface StageListeningPayload {
  atMs: number;
}

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

/**
 * `stage://motion-report` (stage → Rust), relayed to control as
 * `stage://motion-ack` — periodic motion report (companion §54). Carries the
 * stage's current layout generation, which is how control learns that the stage
 * rebuilt its line map and that older frames are being rejected (§33).
 */
export type StageMotionAckPayload = StageMotionAck & { stageGeneration: number };

/**
 * `stage://escape-pressed` (stage → Rust), relayed to control as
 * `stage://escape-requested` — Escape pressed once or twice within 1.5 s.
 */
export interface StageEscapePayload {
  stageGeneration: number;
  presses: 1 | 2;
  atMs: number;
}

/**
 * `stage://intent` — the stage never acts on privileged decisions itself; it
 * reports what the user did and control decides (spec §16.9). Escape travels
 * separately as `stage://escape-pressed` so Rust can relay it.
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

/**
 * `stage://layout-error` (stage → Rust), relayed to control as
 * `stage://layout-failed` — §62.
 *
 * The stage measures its rendered layout into a line map, validates monotonic
 * token/baseline ordering, and rebuilds once if that fails. If the rebuild is
 * unusable too, motion is HELD (the stage will not move on guessed line
 * positions) and this is the only way the operator finds out.
 *
 * `issues` is the list of fatal line-map issue codes. An EMPTY list is the
 * recovery signal: a later rebuild succeeded and the held state is over.
 */
export interface StageLayoutErrorPayload {
  stageGeneration: number;
  /** Fatal `RenderedLineMap` issue codes; empty means "recovered". */
  issues: string[];
  /** Layout generation the stage was measuring at when it gave up. */
  layoutGeneration: number;
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
