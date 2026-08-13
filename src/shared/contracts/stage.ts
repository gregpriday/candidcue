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
 *                                    apply-command (including transcript and
 *                                    voice-pill diagnostics),
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

/* ---------------------------------------------------------------------------
 * Event names
 * ------------------------------------------------------------------------- */

export const STAGE_EVENT = {
  /** Rust → stage: full hydration snapshot (StageSessionEnvelope). */
  loadSession: 'stage://load-session',
  /** Rust → stage: state directives (freeze/blank/ack/settings/…). */
  applyCommand: 'stage://apply-command',
  /** Rust → stage: the session is over; the window is about to close. */
  closeSession: 'stage://close-session',
  /** control → stage: liveness heartbeat (spec §43.5, ~1 s cadence). */
  heartbeat: 'stage://heartbeat',
  /**
   * Rust → stage: one `AlignmentSnapshot` per transcript event (~1/s).
   *
   * From Rust, not from control: the alignment engine runs beside the
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

  /** Legacy direct route; current control sends this through applyCommand. */
  transcriptTap: 'stage://transcript-tap',

  /**
   * control → stage: the voice pill — "we are picking up what you say".
   *
   * There used to be a full-screen microphone check here, standing between the
   * stage going full screen and the transport opening. It was the wrong
   * instrument: a gate that judged a microphone from two seconds of silence and
   * refused to open the take until it approved of what it heard, which meant it
   * accused a working rig of being deaf before the presenter had drawn breath.
   *
   * The take now starts immediately and this reports on it from the corner of
   * the stage instead: a live waveform while it is listening, a tick once real
   * recogniser text has come back, a cross if audio or transcription stops.
   * Evidence rather than a gate — it can be ignored, and nothing it says
   * prevents a take from running.
   *
   * Control owns the capture (one microphone, one owner — see
   * audio/ownership.ts) and sends a fully resolved view through Rust's
   * apply-command relay; the stage holds no audio state and no thresholds.
   * The legacy direct event remains subscribed for compatibility with an older
   * control window during development reloads.
   */
  voicePill: 'stage://voice-pill',

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
  /** stage → Rust: ask for the newest recoverable live checkpoint. */
  syncRequest: 'stage://sync-request',
  /** Rust → stage: newest alignment and presenter diagnostics. */
  liveSync: 'stage://live-sync',
  /** stage → Rust: envelope received and applied (handshake step 1). */
  hydrated: 'stage://hydrated',
  /** stage → Rust: fonts + first stable layout done (handshake step 2). */
  layoutReady: 'stage://layout-ready',
  /** stage → Rust: heartbeat acknowledgement. */
  heartbeatAck: 'stage://heartbeat-ack',
  /** stage → Rust: nonfatal media failure (§40.5 containment). */
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
   * the window layer's own errors: those are two unrelated failures with
   * different recovery, and control was left sniffing payload substrings to
   * tell them apart. A layout failure means motion is HELD — the
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
  /*
   * `identifyDisplays`, `scriptExternalChange` and `diagnosticWarning` used to
   * be declared here. Rust emitted all three to this window and nothing
   * listened, because the command each accompanied already returns the fact:
   * `get_script` carries `externallyChanged`, `identify_displays` returns its
   * session, and startup findings are collected by `get_startup_findings`.
   *
   * The last of those could not have worked as an event in any case: it was
   * emitted from Tauri's `setup`, before this webview had run a line of
   * JavaScript, and a Tauri event is delivered by evaluating JS in the target
   * window rather than being queued for it.
   */
  deviceOrDisplayChange: 'app://device-or-display-change',
  /**
   * Rust → control: the window is closing, or the application is quitting.
   *
   * The frontend has one bounded chance to flush a debounced save, finish the
   * take, persist the reader frame and stop audio, then answer with
   * `app://shutdown-complete`. Rust waits, and proceeds regardless once the
   * deadline passes — a WebView that cannot answer must not be able to stop a
   * user quitting.
   *
   * Before this existed, closing the window or pressing ⌘Q went straight to
   * process exit: a save still inside its debounce window was simply lost, and
   * the session row stayed open until the next launch swept it.
   */
  shutdownRequested: 'app://shutdown-requested',
} as const;

export type ControlEventName = (typeof CONTROL_EVENT)[keyof typeof CONTROL_EVENT];

/**
 * Control → Rust: the shutdown sequence has finished (or given up).
 *
 * A distinct name from `shutdownRequested`, and that is not stylistic. Tauri
 * fans a webview emit out to every webview's listeners regardless of target,
 * so an event control emits must never share a name with one control listens
 * for — the same reason `escapePressed`/`motionReport` exist as separate names.
 */
export const SHUTDOWN_COMPLETE_EVENT = 'app://shutdown-complete';

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
 * `stage://apply-command` — small imperative
 * directives. Each carries the stage generation so directives from a
 * previous stage lifetime are ignored.
 */
export type StageDirective =
  | { kind: 'blank'; blanked: boolean }
  | { kind: 'freeze'; frozen: boolean }
  | { kind: 'ack'; label: string; durationMs?: number }
  | { kind: 'settings'; settings: StageSettings }
  /**
   * The recogniser's own words, for the stage's transcript bar.
   *
   * A DIRECTIVE rather than its own event, and that is the whole point. The bar
   * used to arrive by `emitTo('stage', 'stage://transcript-tap', …)` straight
   * from the control webview, and on at least one real rig it never showed a
   * word while control counted six sent — while alignment snapshots, which come
   * from RUST, arrived and moved the document perfectly. Two roads to the same
   * window, one of them not delivering.
   *
   * This puts the words on the road that demonstrably works: control invokes
   * `publish_stage_command`, Rust validates the generation and emits to the
   * stage, and the stage handles it beside every other directive. It also gets
   * the generation check for free, which the old direct emit never had.
   */
  | { kind: 'transcript'; text: string; final: boolean }
  /**
   * The microphone/transcription status readout. It shares the transcript's
   * Rust relay because both direct control-webview events disappeared on the
   * affected real rig while Rust-originated stage traffic kept arriving.
   */
  | { kind: 'voicePill'; pill: StageVoicePillPayload }
  /**
   * Roll the script at a fixed pace, because nothing is following a voice.
   *
   * Travels the same Rust relay as the transcript and the pill, for the same
   * reason: it is a live transport command, and the one road to the stage that
   * has demonstrably kept working on every rig is the one that goes through
   * Rust with a generation check on it.
   */
  | { kind: 'autoScroll'; autoScroll: StageAutoScrollPayload }
  | ({ kind: 'calibration'; active: boolean } & StageCalibrationDirective)
  /**
   * Voice following is on or off (§48).
   *
   * The state lives in control — the same switch the transport checkbox and the
   * Live "Pause following" button already flip — and the stage has to be told
   * because the stage is where the consequence is visible. Without it the only
   * way the glass learns that following stopped is that snapshots stop
   * arriving, which it cannot distinguish from a presenter who has gone quiet
   * until the 15 s staleness window expires. A mode has to be announced, not
   * inferred from an absence.
   */
  | { kind: 'follow'; paused: boolean }
  | { kind: 'diagnostics'; visible: boolean };

/**
 * The auto-scroll transport, as the stage should run it.
 *
 * A pace and a running flag, and deliberately nothing else — no pixel rate, no
 * position, no direction. The stage is the only window that has measured how
 * much script a pixel of travel carries, so control naming a pixel rate would be
 * control guessing at the type size on the glass. It names the pace a presenter
 * would recognise; the stage converts it against what it actually rendered.
 *
 * `running` is separate from a zero pace because they are different states and
 * only one of them is reversible in the presenter's head: a paused transport
 * resumes at the speed it was set to, where a pace dialled to nothing has lost
 * the setting it was at.
 */
export interface StageAutoScrollPayload {
  running: boolean;
  wordsPerMinute: number;
}

/**
 * What the stage should draw while the operator is calibrating the rig.
 *
 * The crosshair used to be the whole of calibration, and it answered exactly one
 * question: where is the lens. The optical model needs four more answers before
 * it can size anything — how much of the panel is visible in the glass, which
 * way the glass flips the image, how many millimetres a pixel is, and whether a
 * given type size is actually comfortable from where the presenter stands.
 *
 * They are modes of one directive rather than five directives because only one
 * can be on screen at a time, and because "leave calibration" must be a single
 * unambiguous message. `mode` is optional so a directive from an older control
 * still means the crosshair, which is what it always meant.
 */
export interface StageCalibrationDirective {
  mode?: StageCalibrationMode;
  /** `crosshair`: lens position, fractions of the viewport. */
  crosshairX?: number;
  crosshairY?: number;
  /** `safe-area`: the adjustable border, fractions inset from each edge. */
  safeArea?: { top: number; right: number; bottom: number; left: number };
  /**
   * `ruler`: length of the drawn bar in CSS pixels.
   *
   * The stage draws it; the operator measures it against the glass with a
   * physical ruler and types back what they got. That round trip is the only
   * way CandidCue can learn millimetres per pixel — the window layer reports
   * `PhysicalSize` in device PIXELS, not physical units — and it is also the
   * only method that measures the finished optical path rather than the panel,
   * so it silently absorbs a beamsplitter that magnifies.
   */
  rulerLengthPx?: number;
  /** `type-sample`: the size and measure being judged. */
  sampleFontSizePx?: number;
  sampleColumnCh?: number;
  /** `type-sample`: what the size is being called, e.g. "Standard · 24'". */
  sampleLabel?: string;
}

export type StageCalibrationMode =
  | 'crosshair'
  | 'orientation'
  | 'safe-area'
  | 'ruler'
  | 'type-sample';

export interface StageStatePayload {
  stageGeneration: number;
  directive: StageDirective;
}

export interface StageLiveSyncPayload {
  stageGeneration: number;
  revision: number;
  alignment: AlignmentSnapshot | null;
  transcript: StageStatePayload | null;
  voicePill: StageStatePayload | null;
}

export interface StageSyncRequestPayload {
  stageGeneration: number;
  lastRevision: number;
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
/**
 * How many words the tap carries, and therefore how many the stage draws.
 *
 * ONE number, because there are two places that crop and they were drifting:
 * control keeps a rolling window of the last few words (so the bar reads across
 * utterance boundaries rather than blanking wherever the provider's voice
 * detector happens to end one), and the stage crops again on the way in — it
 * has to, because the single-window route hands it text through memory rather
 * than through this payload. Two constants for one policy means the wire
 * carries words nothing will ever draw, and a change to either one silently
 * does nothing.
 *
 * Ten is about a spoken phrase: enough that a presenter recognises what they
 * just said rather than reading a fragment, few enough to take in at a glance
 * from prompting distance, which is the only way this is ever read.
 */
export const STAGE_TRANSCRIPT_TAP_WORDS = 10;

export interface StageTranscriptTapPayload {
  stageGeneration: number;
  /**
   * The most recent words heard, oldest first, already trimmed for display —
   * at most {@link STAGE_TRANSCRIPT_TAP_WORDS} of them.
   */
  text: string;
  /** True when the provider has finalised the utterance this text came from. */
  final: boolean;
  sentAtMs: number;
}

/**
 * What the voice pill is currently reporting.
 *
 * `listening` — audio is arriving and nothing has come back yet. The ordinary
 *               state at the top of a take, and NOT a warning: a presenter who
 *               has not spoken yet is not a fault to be announced;
 * `confirmed` — recogniser text has JUST come back, so the whole chain (device
 *               → capture → socket → model) demonstrably works. Transient — see
 *               below;
 * `steady`    — the chain has been proven and nothing has gone wrong since;
 * `fault`     — the input died, the frames stopped, or the presenter has been
 *               speaking for several seconds with nothing coming back.
 *
 * ---------------------------------------------------------------------------
 * WHY `confirmed` AND `steady` ARE TWO STATES
 * ---------------------------------------------------------------------------
 * `confirmed` used to be terminal: the first partial that came back lit a
 * filled tick, and that tick stayed lit for the rest of the take. It was the
 * brightest mark on the glass and it was reporting an event from twenty minutes
 * ago — a permanently celebrated success sitting beside a script somebody is
 * reading.
 *
 * So the tick is now an EVENT, held for {@link STAGE_VOICE_PILL_CONFIRM_HOLD_MS}
 * and then settled into a quiet dot. It is spent on the three moments that are
 * genuinely news — the first lock of a take, and coming back from a fault — and
 * on nothing else.
 *
 * `steady` exists so that settling loses no information. The obvious version of
 * this change drops back to `listening`, which then means two incompatible
 * things at once: "nothing has ever come back" and "everything is fine". A
 * presenter glancing at the corner could not tell a working take from one that
 * has transcribed nothing since it started, which is the single question the
 * readout exists to answer. Hollow dot before the first lock, solid dot after;
 * both are still, neither is an announcement.
 */
export type StageVoicePillReading = 'listening' | 'confirmed' | 'steady' | 'fault';

/**
 * How long the tick is held before it settles into the steady dot.
 *
 * Long enough to be noticed by somebody who was not looking at the corner when
 * it happened, short enough that it is over before it becomes scenery.
 */
export const STAGE_VOICE_PILL_CONFIRM_HOLD_MS = 800;

/**
 * `stage://voice-pill` — the corner readout, as the stage should draw it.
 *
 * Deliberately a fully-resolved view rather than raw levels plus a rule: the
 * stage holds no audio state and no thresholds, so what the presenter sees
 * cannot drift from what control decided. `levels` is the only history in the
 * payload, and it is there because a waveform IS history — a single amplitude
 * would be a meter, and a meter cannot show a voice arriving.
 */
export interface StageVoicePillPayload {
  stageGeneration: number;
  reading: StageVoicePillReading;
  /** Waveform trace, oldest first, each 0–1 and already normalised. */
  levels: number[];
  /**
   * The reading in words (§20: state is never colour alone).
   *
   * Authored copy, never a code. Drawn beside the mark while something is
   * wrong, and carried as the accessible name the rest of the time.
   */
  label: string;
  /**
   * False fades the pill out. The stage keeps it MOUNTED either way, so
   * returning to true fades it back in rather than making it appear from
   * nowhere.
   *
   * It used to go false a couple of seconds after the pill confirmed, on the
   * reasoning that a proven chain has said its piece. That retired the WAVEFORM
   * along with the tick, and the waveform is not a status that resolves — it is
   * the only live evidence that audio is arriving at all, and having been heard
   * at 00:04 says nothing about 00:20. It now stays true for the whole take.
   *
   * What still sets it false is a PAUSE, where the question the pill answers
   * has no answer: a hard pause has muted the device, so a moving trace would
   * be a claim about a microphone that is deliberately switched off.
   */
  visible: boolean;
  sentAtMs: number;
}

/*
 * THERE IS NO `prominence` FIELD ANY MORE, AND THAT IS DELIBERATE.
 *
 * It carried `'expanded' | 'collapsed'`, and `collapsed` drew the mark without
 * the trace — on the reasoning that a waveform is continuous peripheral motion
 * beside the only other thing allowed to move on the glass, and that once
 * recognition has come back the pill has said everything it exists to say.
 *
 * The premise is wrong. The trace is not a status that resolves: it is the only
 * live evidence that audio is arriving, and the presenter who needs it most is
 * the one twenty minutes in wondering whether they are still being picked up.
 * The waveform stays for the whole take, so the field's only possible value was
 * a way to defeat that.
 *
 * Nothing ever set it — it shipped optional and no control path populated it —
 * so removing it changes no behaviour. If a "quieten the corner" setting is
 * ever wanted, it should arrive as its own decision with its own reasoning
 * rather than be inherited from this one.
 */

/**
 * Bars in the pill's waveform.
 *
 * On the contract rather than either side of it because both sides need the
 * same number: control fills the trace to it, and the stage pads to it from
 * the left so the waveform grows INTO the pill instead of stretching to fill
 * it. Two independent copies of that number would drift into a trace that
 * silently rescaled itself — which on the one element whose job is to report a
 * level honestly would read as the level changing when it had not.
 *
 * Twenty-four at the ~100 ms publish cadence is about 2.4 seconds of history:
 * enough to read as a voice, short enough to stay a pill.
 */
export const STAGE_VOICE_PILL_TRACE_SAMPLES = 24;

/**
 * §16.9. How long a first Escape stays "armed" for the second one.
 *
 * Shared because BOTH windows implement the protocol and they have to agree:
 * the stage answers Escape when it has focus, and control answers it when it
 * does — which is most of the time, since the operator is at the control
 * window. Two different windows counting to two on two different clocks is how
 * a presenter ends up pressing Escape four times.
 *
 * 1.5 s is long enough to be a deliberate second press and short enough that
 * an Escape now and an Escape a minute from now are never one gesture.
 */
export const ESCAPE_DOUBLE_PRESS_MS = 1500;

/**
 * If no HEARTBEAT arrives for this long while live, the stage freezes locally
 * and says so on the glass (control is presumed gone; it owns recovery).
 *
 * Heartbeats only, and generation-scoped. This used to read "heartbeat/snapshot
 * /tracking", and the stage implemented exactly that — which made the watchdog
 * unable to fire in the one situation it exists for. Alignment snapshots come
 * from RUST, with control out of the motion path by design, so they say nothing
 * whatever about whether the control window is still answering: a control window
 * that had crashed went on being counted as alive for as long as the aligner
 * kept publishing, which mid-take is indefinitely. The heartbeat is the only
 * inbound event control alone can produce, so it is the only one that can
 * answer the question. Do not widen this back.
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
  /**
   * One settled wheel gesture, in logical stage pixels (already applied
   * locally).
   *
   * `anchorToken` is the half that was missing for as long as this intent has
   * existed. The stage moved its own document and told nobody where to, so the
   * tracker's cursor stayed where it was: the presenter scrolled back a
   * paragraph to re-read a line, spoke, and the document ran forward at the
   * profile's ceiling to a place they were no longer looking at. The wheel had
   * no way to say "I am here" while the arrow keys — which travel as
   * `manual_step` and reach `set_manual_position` — always had.
   *
   * Null means the gesture was a LOOK, not a move: the presenter glanced ahead
   * and their place has not changed, so re-anchoring the tracker on it would
   * throw away a lock that is still correct. The stage decides which it was,
   * because the distinction is "has the place I was reading left the glass",
   * and only the stage knows how tall the glass is.
   */
  | {
      kind: 'manual_scroll';
      /** Where the gesture actually left the document, px — travel, not wheel deltas. */
      deltaPx: number;
      anchorToken: number | null;
      /**
       * When the gesture settled, wall clock.
       *
       * Carried on the intent itself rather than only on the event envelope,
       * because single-window presentation hands intents straight to the host
       * and never builds an envelope — and control needs this to tell a report
       * that is merely in flight from one that has been overtaken. The gesture
       * settles 200 ms after the presenter stops scrolling, and an operator who
       * restarts the paragraph inside that window would otherwise have the
       * stale report drag the freshly restarted aligner back.
       */
      atMs: number;
    }
  /** Arrow/page keys: semantic step requests. */
  | { kind: 'manual_step'; direction: 'forward' | 'back'; unit: 'line' | 'paragraph' }
  /** Space bar. */
  | { kind: 'toggle_pause' }
  /**
   * The dock's follow control (§48). Voice following is a mode the presenter
   * may switch off — to read from a script at their own pace, with the wheel
   * — and switching it off is not pausing the session: transcription stays
   * connected and only automatic movement stops.
   */
  | { kind: 'toggle_follow' }
  /** Single click focused the stage; no script movement occurred. */
  | { kind: 'stage_focused' }
  /**
   * The fixed-pace transport ran out of script.
   *
   * Reported rather than acted on, like everything else here. The stage knows
   * the document has no further to go; only control knows whether that should
   * stand the transport down, and control is where the button that says
   * "running" lives.
   */
  | { kind: 'auto_scroll_end' }
  /**
   * The presenter asked for the transport from the glass.
   *
   * These exist because the hold chip tells them to. When the input chain dies
   * the chip names the key that starts the transport, and on a rig with a
   * separate stage window that window is the one holding the keyboard — the
   * presenter is standing at it, and the control window is on a desk behind
   * them. Advice naming a key that does nothing where it is read would be worse
   * than no advice.
   *
   * Reported, not acted on: the running flag, the pace and the mutual exclusion
   * with voice following are all session state, and none of it is the stage's.
   */
  | { kind: 'auto_scroll_toggle' }
  | { kind: 'auto_scroll_pace'; direction: 'faster' | 'slower' };

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
