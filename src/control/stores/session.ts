/**
 * Live session store (spec §15, §45.2 RealtimeStore/TrackingStore facade for
 * the Live screen). Owns session identity, the tracking worker feed, the
 * realtime voice pipeline, §15.3 pause semantics, the elapsed clock, the
 * transcript tail, stage heartbeats (§43.5), and the F.17 summary.
 */
import { derived, get, writable } from 'svelte/store';
import type {
  CommandAction,
  CompiledScript,
  ListenerStageSelection,
  OutlineNode,
  SentenceUnit,
  StageDirective,
  StageEscapePayload,
  StageIntentPayload,
  StageListenerHealthPayload,
  StageSettings,
  TrackingSnapshot,
  TranscriptionConfig,
  ValidatedCommand,
} from '../../shared/contracts';
import { STAGE_EVENT, CONTROL_EVENT } from '../../shared/contracts';
import type { SemanticMotionFrame } from '../../shared/contracts';
import type { CommandSettings } from '../../shared/commands';
import type { FollowingSettings, SessionMode } from '../services/settings-types';
import { createTrackingDriver, newSessionId, type TrackingDriver } from '../services/session';
import { VoiceSessionPipeline } from '../services/voice-session';
import { estimateTranscriptionCostUsd } from '../services/realtime/costEstimator';
import { isTauriRuntime } from '../services/ipc';
import { describeError } from '../services/errors';
import * as stageService from '../services/stage';
import {
  isNontrivialMovement,
  monotonicNowMs,
  motionFrameFromSnapshot,
  movementRecordFromDiagnostic,
  setActiveSemanticSidecar,
  subscribeFollowSidecar,
  subscribeStageMotionAcks,
} from '../services/smooth-follow-adapter';
import { SemanticSidecar } from '../services/semantic-sidecar';
import { appendSessionTranscript, endSessionRecord } from '../services/session-records';
import type { AssistSchedulingContext, SemanticAvailability } from '../../shared/semantic';
import { DEFAULT_SEMANTIC_BUDGET } from '../../shared/semantic';
import { getModelCapabilities } from '../services/capabilities';
import { resolveSmoothFollowProfile } from '../../shared/tracking/profile';
import { defaultFollowingSettings } from '../lib/follow-profiles';
import { configureFollowActions, smoothFollow } from './smooth-follow';
import { getSettingsSnapshot, patchSettings } from './settings';
import { showToast } from './toasts';

export type PauseKind = 'none' | 'listening' | 'hard';

/**
 * A Listener media failure reported by the stage (§40.5), and what the
 * operator has done about it.
 *
 * This is deliberately NOT the same state as a layout/line-map failure. Both
 * arrive on `stage://error`, but a broken line map is a tracking emergency and
 * a Listener that stopped decoding is a cosmetic one: the script is fine, the
 * position is fine, and the only thing wrong is that a video of a person is
 * frozen on camera behind the text. They need different words and completely
 * different actions, and the handler used to throw the media half away.
 */
export interface ListenerFault {
  status: 'poster_fallback' | 'failed';
  /** Absent when the stage could not attribute a cause (autoplay refusals). */
  code: 'decode_failure' | 'unsupported_codec' | 'source_unavailable' | null;
  clipId: string | null;
  atMs: number;
  /**
   * `unresolved` while the four §40.5 choices are still open; `retrying` after
   * Retry / Choose another until the stage either goes quiet or reports again;
   * `poster` and `off` are the operator's settled choices.
   */
  resolution: 'unresolved' | 'retrying' | 'poster' | 'off';
  /** Clips in the pack that have not failed yet — gates "Choose another". */
  alternativeClips: number;
}

/**
 * Luna sidecar spend for this take (§42.1).
 *
 * Separate from `SessionState.estimatedCostUsd` on purpose. That number is
 * realtime *transcription*, billed per connected audio minute by a different
 * subsystem; this one is semantic-assist tokens billed per million. Adding them
 * together would produce a figure that is neither, and hiding either one leaves
 * a bring-your-own-key user unable to see what their session actually costs.
 */
export interface SemanticSpend {
  /** Requests actually issued, across every lane. */
  requests: number;
  /** The cap in force this session — the user's, or the §42 default. */
  requestLimit: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** `null` = no verified rate configured. NOT zero. See §42.2. */
  estimatedCostUsd: number | null;
  availability: SemanticAvailability;
}

const NO_SEMANTIC_SPEND: SemanticSpend = {
  requests: 0,
  requestLimit: DEFAULT_SEMANTIC_BUDGET.maxRequestsPerSession,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  estimatedCostUsd: null,
  availability: 'disabled',
};

export interface SessionCounts {
  jumps: number;
  retakes: number;
  commands: number;
  reconnects: number;
}

export interface SessionSummary {
  durationSeconds: number;
  mode: SessionMode;
  sectionsReached: number;
  retakes: number;
  commands: number;
  reconnects: number;
  /** Estimated realtime TRANSCRIPTION cost — clearly an estimate (F.17). */
  estimatedCostUsd: number;
  /**
   * Estimated Luna sidecar cost (§42.1), reported on its own line. `null`
   * means no verified rate is configured — it does not mean "free".
   */
  semanticCostUsd: number | null;
  /** Luna requests issued this take, which is meaningful even without a rate. */
  semanticRequests: number;
  endingLocation: string;
  /**
   * §36.2. Was hard-coded `false` because nothing ever opened a session record,
   * so no transcript could be saved under any setting. It now reports what Rust
   * decided at session start.
   */
  transcriptSaved: boolean;
}

export interface SessionState {
  active: boolean;
  sessionId: string | null;
  scriptId: string | null;
  scriptTitle: string;
  mode: SessionMode;
  displayLabel: string;
  startedAtMs: number;
  elapsedSeconds: number;
  /** False until the user (or a voice command) starts prompting (§9.1). */
  prompting: boolean;
  paused: PauseKind;
  stageBlanked: boolean;
  voiceFollow: boolean;
  connection: 'connected' | 'reconnecting' | 'offline';
  micState: 'live' | 'muted' | 'disconnected';
  /**
   * False once the stage window is gone (§62). Everything that publishes to the
   * stage stands down; the UI must say so rather than keep offering controls
   * that write into the void.
   */
  stageAlive: boolean;
  /**
   * Running realtime TRANSCRIPTION cost estimate — the same number the F.17
   * summary uses. Luna sidecar spend is `semanticSpend`, never folded in here.
   */
  estimatedCostUsd: number;
  /** §42.1 Luna spend, shown next to (never added to) `estimatedCostUsd`. */
  semanticSpend: SemanticSpend;
  /** §40.5 Listener media failure awaiting (or after) a recovery choice. */
  listenerFault: ListenerFault | null;
  snapshot: TrackingSnapshot | null;
  transcriptTail: string[];
  outline: OutlineNode[];
  sentences: SentenceUnit[];
  counts: SessionCounts;
  summary: SessionSummary | null;
  blocksSeen: string[];
  stageFontSizePx: number;
}

const initial: SessionState = {
  active: false,
  sessionId: null,
  scriptId: null,
  scriptTitle: '',
  mode: 'voice',
  displayLabel: '',
  startedAtMs: 0,
  elapsedSeconds: 0,
  prompting: false,
  paused: 'none',
  stageBlanked: false,
  voiceFollow: true,
  connection: 'connected',
  micState: 'live',
  stageAlive: true,
  estimatedCostUsd: 0,
  semanticSpend: { ...NO_SEMANTIC_SPEND },
  listenerFault: null,
  snapshot: null,
  transcriptTail: [],
  outline: [],
  sentences: [],
  counts: { jumps: 0, retakes: 0, commands: 0, reconnects: 0 },
  summary: null,
  blocksSeen: [],
  stageFontSizePx: 64,
};

const state = writable<SessionState>({ ...initial });
export const session = { subscribe: state.subscribe };

let driver: TrackingDriver | null = null;
let clock: ReturnType<typeof setInterval> | null = null;
let pipeline: VoiceSessionPipeline | null = null;
let compiledScript: CompiledScript | null = null;
let stageGeneration = 0;
/**
 * The Rust coordinator's session generation for this take.
 *
 * C1: this used to default to a hard-coded 1 while nothing ever invoked
 * `start_session`, so the coordinator stayed at its `Default` of 0 and
 * `validate_stage_payload_header` dropped every snapshot control published.
 * Rust assigns it now (`AppCoordinator::begin_session`) and control adopts
 * whatever it is handed — 0 means "no session record", which is only ever true
 * in browser dev.
 */
let sessionGeneration = 0;
let stageSettings: StageSettings | null = null;
let listenerSelection: ListenerStageSelection | null = null;
let listenerVisible = false;
/**
 * §40.5 "Turn off": once the operator retires the Listener for this take,
 * nothing may bring it back — not the quick control, not a voice command, not
 * a later recovery. It is re-armed only by the next session.
 */
let listenerRetiredForSession = false;
/** Clips the stage has already failed on, so "Choose another" can skip them. */
let failedClipIds: string[] = [];
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatRevision = 0;
let stageEventUnlisteners: Array<() => void> = [];
/**
 * The stage's CURRENT layout generation, learned from its motion acks (§7.2,
 * §54).
 *
 * C1: this is not `stageGeneration`. `stageGeneration` counts stage *windows*;
 * the layout generation counts *line-map rebuilds* inside one window, and the
 * stage's frame receiver gates on the latter. Both semantic-frame producers —
 * the tracking worker and the v1 snapshot bridge — used a value that was never
 * the stage's, so every frame was stamped with a generation the stage had never
 * published: the worker's frozen 0 was permanently stale (rejected for the
 * 900 ms grace after every rebuild, then merely *tolerated* forever), and the
 * bridge's `stageGeneration` went permanently NEWER than the gate as soon as
 * the stage window was reopened mid-session, which the receiver rejects with no
 * grace and no tolerance at all. Acks are the one channel that carries the
 * stage's own number, so this is where the loop closes.
 */
let stageLayoutGeneration = 0;
/**
 * Monotonic token for the stage bridge. `listen()` resolves asynchronously, so
 * a stop/restart that happens before it settles must be able to prove that the
 * arriving unlisteners belong to a dead session — otherwise they are installed
 * with no disposer and keep firing into the NEXT session.
 */
let stageBridgeToken = 0;
let lastRelayAtMs = 0;
/** The realtime model whose published rate the cost estimate uses. */
const DEFAULT_COST_MODEL = 'gpt-realtime-whisper';
let costModel = DEFAULT_COST_MODEL;

/* Smooth-following bridge state (companion §50.1). The v2 producers are
 * landing in parallel; until then the control UI is fed by bridging today's
 * v1 snapshots/diagnostics — see services/smooth-follow-adapter.ts. */
/**
 * Session-clock origin for the §26.1 bridge, on the MONOTONIC clock.
 *
 * This is not `startedAtMs` in the store (which is wall time, for display). A
 * frame's `sessionTimeMs` is what the stage measures evidence age against, and
 * `Date.now()` moves: an NTP step backward mid-take inflates every subsequent
 * age and pushes the predictor past its horizon into decay for no reason.
 */
let sessionStartedAtMs = 0;
let lastMotionFrame: SemanticMotionFrame | null = null;
let followProfileId = defaultFollowingSettings().motionProfileId;
let scriptCompileHash = '';
let stopMotionAcks: (() => void) | null = null;
let stopSidecarFeed: (() => void) | null = null;
/**
 * The take's semantic sidecar (companion §36, H6). One per take, disposed with
 * it. Null in manual/fixed modes, outside Tauri, and whenever the worker-backed
 * driver is not in use — there is no candidate feed in those cases, so a
 * scheduler would have nothing to schedule.
 */
let semanticSidecar: SemanticSidecar | null = null;
/** The sidecar's attached candidate sink, or null while nothing is attached. */
let pushSemanticContext: ((context: AssistSchedulingContext) => void) | null = null;
/** True once the worker has sent a real v2 frame — the bridge then stands down. */
let usingWorkerFrames = false;

/* Session record (§36.1) + transcript retention (§36.2). */
interface PendingTranscriptItem {
  /** The realtime item id, so the command channel can re-label it. */
  itemId: string;
  receivedAtMs: number;
  commitSequence: number;
  providerItemId?: string;
  audioStartMs?: number;
  audioEndMs?: number;
  transcript: string;
  disposition: 'script' | 'command' | 'discarded';
}
/** Fixed at session start by Rust; false means "never persist a word". */
let transcriptRetained = false;
let transcriptBuffer: PendingTranscriptItem[] = [];
let transcriptFlushTimer: ReturnType<typeof setInterval> | null = null;
/**
 * How long an item waits before it is flushed. The command router decides
 * whether a finalized item was script or a command phrase a beat after the item
 * arrives, and `INSERT OR IGNORE` on `UNIQUE(session_id, commit_sequence)`
 * means the first write of a commit is the one that sticks — so writing before
 * the disposition settles would permanently mislabel command phrases as script.
 */
const TRANSCRIPT_SETTLE_MS = 4000;
const TRANSCRIPT_FLUSH_INTERVAL_MS = 15000;

/** Stage relay throttle (§46.6): the worker caps at 30/s; the stage gets ~15/s. */
const STAGE_RELAY_MIN_INTERVAL_MS = 66;

export interface StartSessionInput {
  scriptId: string;
  scriptTitle: string;
  mode: SessionMode;
  displayLabel: string;
  outline: OutlineNode[];
  sentences: SentenceUnit[];
  totalTokens: number;
  /** Integration inputs — optional so the store degrades in browser dev. */
  sessionId?: string;
  compiled?: CompiledScript | null;
  /** From `start_session` — the Rust coordinator assigns it, control adopts. */
  sessionGeneration?: number;
  stageGeneration?: number;
  /**
   * §36.2: whether the session row was opened with transcript retention on.
   * Fixed at session start in Rust and never re-derived here — a session
   * started with retention off must not start keeping text mid-take because
   * the user flipped a setting.
   */
  transcriptRetained?: boolean;
  stageSettings?: StageSettings | null;
  listener?: ListenerStageSelection | null;
  transcription?: TranscriptionConfig;
  commandSettings?: Partial<CommandSettings>;
  commandsEnabled?: boolean;
  micDeviceId?: string;
  /** §28.3 capture processing (Settings → Audio / Preflight → Advanced). */
  audioProcessing?: {
    echoCancellation?: boolean;
    noiseSuppression?: boolean;
    autoGainControl?: boolean;
  };
  /** §47 follow settings for this session; defaults to the saved settings. */
  following?: FollowingSettings;
}

export function startLiveSession(input: StartSessionInput): string {
  stopInternals();
  const sessionId = input.sessionId ?? newSessionId();
  compiledScript = input.compiled ?? null;
  stageGeneration = input.stageGeneration ?? 0;
  sessionGeneration = input.sessionGeneration ?? 0;
  // Nothing is known about the new stage window's layout until it acks.
  stageLayoutGeneration = 0;
  transcriptRetained = input.transcriptRetained === true;
  transcriptBuffer = [];
  stageSettings = input.stageSettings ?? null;
  listenerSelection = input.listener ?? null;
  listenerVisible = listenerSelection !== null;
  listenerRetiredForSession = false;
  failedClipIds = [];
  heartbeatRevision = 0;
  lastRelayAtMs = 0;
  costModel = input.transcription?.model ?? DEFAULT_COST_MODEL;
  sessionStartedAtMs = monotonicNowMs();
  lastMotionFrame = null;
  usingWorkerFrames = false;
  scriptCompileHash = input.compiled?.sourceHash ?? '';

  // Smooth-following store (§50.1): user-visible following state + §48 actions.
  const following = input.following ?? currentFollowingSettings();
  followProfileId = following.motionProfileId;
  smoothFollow.beginSession(sessionId, following);
  configureFollowActions(followActions);
  smoothFollow.reportTranscriptStatus(input.mode === 'voice' ? 'live' : 'idle');
  stopSidecarFeed = subscribeFollowSidecar({
    onAssistStatus: (patch) => smoothFollow.ingestAssistStatus(patch),
    onCoachTip: (tip) => smoothFollow.ingestCoachTip(tip),
    onBudgetBreach: (breach) => smoothFollow.reportBudgetBreach(breach),
  });

  state.set({
    ...initial,
    active: true,
    sessionId,
    scriptId: input.scriptId,
    scriptTitle: input.scriptTitle,
    mode: input.mode,
    displayLabel: input.displayLabel,
    startedAtMs: Date.now(),
    voiceFollow: input.mode === 'voice',
    outline: input.outline,
    sentences: input.sentences,
    stageFontSizePx: stageSettings?.fontSizePx ?? 64,
  });

  // Voice mode without a Tauri runtime has no realtime feed — keep the
  // animated mock driver so browser dev stays demonstrable.
  const useRealDriver = Boolean(input.compiled) && (isTauriRuntime() || input.mode !== 'voice');
  driver = createTrackingDriver({
    sessionId,
    scriptId: input.scriptId,
    sentences: input.compiled?.sentences ?? input.sentences,
    totalTokens: input.totalTokens,
    compiled: useRealDriver ? (input.compiled ?? null) : null,
    sessionGeneration,
    stageGeneration: stageGeneration || 1,
    onSnapshot: handleSnapshot,
    onTranscript(line) {
      pushTranscriptLine(line);
    },
    // Real v2 output from the tracking worker (companion §26.1, §65).
    onMotionFrame(frame) {
      usingWorkerFrames = true;
      lastMotionFrame = frame;
      smoothFollow.ingestMotionFrame(frame);
      // C2: the stage's v2 motion input. Real worker frames and the bridged
      // ones both go out on the same event, so the stage never sees a gap.
      publishSemanticFrame(frame);
    },
    onMovementRecord(record) {
      usingWorkerFrames = true;
      smoothFollow.ingestMovementRecord(record);
    },
    // Companion §37.1: the aligner's post-section-gate candidate set. This is
    // the sidecar's ONLY input — without it the scheduler is inert and no
    // semantic assist can ever occur.
    onSemanticContext(context) {
      pushSemanticContext?.(context);
    },
    // Fallback for drivers without a v2 output (the mock driver used in
    // browser dev, manual/fixed modes, and node tests).
    onDiagnostic(diagnostic) {
      if (usingWorkerFrames || !isNontrivialMovement(diagnostic)) return;
      smoothFollow.ingestMovementRecord(
        movementRecordFromDiagnostic(diagnostic, {
          sessionStartedAtMs,
          previousState: smoothFollow.snapshot().state,
        }),
      );
    },
  });

  // Semantic sidecar (companion §36, H6): session-owned, take-scoped, and fed
  // by the worker's candidate emissions. `local_only` is handled inside the
  // scheduler (it simply never issues a request), so the wiring is unconditional
  // once a real worker-backed driver exists.
  if (useRealDriver) {
    startSemanticSidecar(sessionId, following);
  }

  // Voice pipeline: realtime transcription + command routing (§29, §33).
  if (input.mode === 'voice' && input.compiled && isTauriRuntime()) {
    pipeline = new VoiceSessionPipeline({
      sessionId,
      sessionGeneration,
      compiled: input.compiled,
      config: input.transcription ?? {
        model: 'gpt-realtime-whisper',
        language: 'en',
        delay: 'low',
        requestLogprobs: true,
      },
      commandSettings: input.commandSettings,
      commandsEnabled: input.commandsEnabled,
      deviceId: input.micDeviceId,
      audioProcessing: input.audioProcessing,
      getCursorTokenIndex: () => get(state).snapshot?.tokenIndex ?? 0,
      getPosition: () => {
        const snap = get(state).snapshot;
        return {
          blockId: snap?.blockId ?? '',
          sentenceId: snap?.sentenceId ?? '',
          tokenIndex: snap?.tokenIndex ?? 0,
        };
      },
      getScrollMode: () => (get(state).voiceFollow ? 'voice' : 'manual'),
      onTrackingEvent: (event) => driver?.feedTranscript(event),
      onMaskItems: (itemIds) => {
        // §36.2: an item the command channel consumed is a command phrase, not
        // performed script, and the retained transcript must say so.
        labelTranscriptItems(itemIds, 'command');
        driver?.maskItems(itemIds);
      },
      // §33.4 tail: the router decided the phrase was authored script after
      // all, so alignment gets those items back.
      onReleaseItems: (itemIds) => {
        labelTranscriptItems(itemIds, 'script');
        driver?.releaseItems(itemIds);
      },
      // §36.2: finalized text only, never audio. Buffered here and written
      // through `append_session_transcript`, which Rust refuses outright when
      // the session was opened with retention off.
      onTranscriptItem: (item) => bufferTranscriptItem(item),
      onCommandPending: (pending) => driver?.setCommandPending(pending),
      executeCommand: (command) => executeValidatedCommand(command),
      // H8: real execution context for the §33.9 confirmation policy.
      getExecutionState: () => {
        const s = get(state);
        return {
          hardPaused: s.paused === 'hard',
          takeInProgress: s.active && s.prompting,
          // §33.9 default. There is no user setting for this yet; confirming
          // is the safe side — an unconfirmed voice "stop" mid-take destroys
          // the one thing the presenter cannot redo cheaply.
          confirmStopDuringTake: true,
        };
      },
      onCommandRejected: (command, reason) => {
        showToast(
          reason === 'stop_during_take'
            ? `Say it again to confirm: ${command.humanLabel}`
            : `Not sure what you meant by "${command.humanLabel}" — say it again.`,
          'info',
        );
      },
      onUnknownCommand: (message) => showToast(message, 'info'),
      onTranscriptLine: (line) => pushTranscriptLine(line),
      onConnectionState: (connection) => {
        state.update((s) => {
          const reconnects =
            connection === 'reconnecting' && s.connection !== 'reconnecting'
              ? s.counts.reconnects + 1
              : s.counts.reconnects;
          return { ...s, connection, counts: { ...s.counts, reconnects } };
        });
        // §59: an interrupted transcript is a first-class degraded state.
        smoothFollow.reportTranscriptStatus(
          connection === 'connected' ? 'live' : 'interrupted',
          connection === 'offline' ? 'The realtime connection is offline.' : null,
        );
      },
      onRealtimeState: (realtimeState) => {
        state.update((s) => ({
          ...s,
          micState:
            realtimeState === 'listening' || realtimeState === 'ready'
              ? 'live'
              : realtimeState === 'fatal_error' || realtimeState === 'recoverable_error'
                ? 'disconnected'
                : s.micState,
        }));
      },
      // H5: transcription is untrustworthy — stop following visibly rather
      // than letting the stage drift on stale or absent speech.
      onFollowingHold: (held, reason) => {
        smoothFollow.setFollowingPaused(held);
        if (held) {
          showToast(describeHold(reason), 'danger');
        }
      },
      // H5: a dead input is not a provider problem; the user must act.
      onInputDeviceLost: (code) => {
        state.update((s) => ({ ...s, micState: 'disconnected' }));
        showToast(
          code === 'MIC_NO_SIGNAL'
            ? 'No sound is reaching the microphone. Following is on hold.'
            : 'The microphone disconnected. Choose an input to continue following.',
          'danger',
        );
      },
      // H1: a session-level provider failure must never leave a green UI.
      onSessionFailure: (code, fatal) => {
        state.update((s) => ({
          ...s,
          connection: fatal ? 'offline' : 'reconnecting',
          micState: fatal ? 'disconnected' : s.micState,
        }));
        showToast(
          fatal
            ? `Voice following stopped: ${describeError(code)}`
            : `Voice following interrupted: ${describeError(code)}`,
          'danger',
        );
      },
      // M3: a soft pause keeps the mic and the billing meter live.
      onPauseWarning: (msRemaining) => {
        showToast(
          `Still paused — voice will disconnect in ${Math.round(msRemaining / 60_000)} min.`,
          'info',
        );
      },
    });
    void pipeline.start().catch((err) => {
      state.update((s) => ({ ...s, connection: 'offline' }));
      showToast(`Voice tracking is unavailable: ${describeError(err)}`, 'danger');
    });
  }

  clock = setInterval(() => {
    state.update((s) => {
      if (!s.active) return s;
      const elapsedSeconds = Math.floor((Date.now() - s.startedAtMs) / 1000);
      return { ...s, elapsedSeconds, estimatedCostUsd: currentCostUsd(s.mode, elapsedSeconds) };
    });
    // §42.1: the sidecar's counters are pulled on the same beat as the
    // transcription clock, and land in their own field — the two costs are
    // never summed and never displayed as one number.
    publishSemanticSpend();
  }, 1000);

  // §36.2: incremental retention, so a crash mid-take costs at most one
  // interval rather than the whole transcript.
  if (transcriptRetained) {
    transcriptFlushTimer = setInterval(() => {
      flushTranscript(sessionId, false);
    }, TRANSCRIPT_FLUSH_INTERVAL_MS);
  }

  startStageBridge(sessionId);
  return sessionId;
}

/* ---------------------------------------------------------------------------
 * Semantic sidecar (companion §36–§40)
 * ------------------------------------------------------------------------- */

/**
 * Stand up the take's sidecar and connect both halves of the loop:
 *
 *   worker `semantic_context` → sidecar scheduler → Rust → validate → fuse
 *                             → worker `semantic_assist` (bounded, re-clamped)
 *
 * The `SmoothFollowProfile` is the resolved default, which is exactly what the
 * tracking worker's engine resolves for itself (the driver sends no
 * `smoothProfile`), so `semanticInfluenceMax` is the same number on both sides
 * of the seam — the fused adjustment is clamped to the identical bound that the
 * beam re-clamps it to.
 */
function startSemanticSidecar(sessionId: string, following: FollowingSettings): void {
  const sidecar = new SemanticSidecar({
    sessionId,
    sessionGeneration,
    profile: resolveSmoothFollowProfile(),
    mode: following.intelligenceMode,
    // §42.1: the request cap is the user's setting, not a module constant.
    // `null` means "no cap of my own", which leaves the §42 default in force
    // rather than removing the bound entirely.
    ...(following.semanticRequestLimit !== null
      ? { budget: { maxRequestsPerSession: following.semanticRequestLimit } }
      : {}),
    // Only fused + validated evidence gets here; the scheduler owns that work
    // and the beam re-checks epoch, TTL, source items and candidate membership.
    postAssistEvidence: (evidence) => driver?.applySemanticAssist(evidence),
    // §47.4: publish real scheduler availability as it changes.
    onAvailabilityChange: () => setActiveSemanticSidecar(semanticSidecar),
  });
  sidecar.attachContextSource((emit) => {
    pushSemanticContext = emit;
    return () => {
      if (pushSemanticContext === emit) pushSemanticContext = null;
    };
  });
  semanticSidecar = sidecar;
  setActiveSemanticSidecar(sidecar);
  publishSemanticSpend();

  /*
   * §42.2 prices. Rust is the only holder of the verified rates (they are
   * configured, never shipped as constants), so they are fetched once and
   * handed to the scheduler. Until they arrive — and forever, if none is
   * configured — the cost reads as unknown rather than as zero. A failed fetch
   * must never interrupt a take, so it simply leaves the rate unknown.
   */
  void getModelCapabilities()
    .then((capabilities) => {
      if (semanticSidecar !== sidecar) return;
      sidecar.setPrices({
        inputPerMTokUsd: capabilities.semanticInputPricePerMtok ?? null,
        cachedInputPerMTokUsd: capabilities.semanticCachedInputPricePerMtok ?? null,
        outputPerMTokUsd: capabilities.semanticOutputPricePerMtok ?? null,
      });
      publishSemanticSpend();
    })
    .catch(() => {});
}

/**
 * §42.1: change the per-session Luna request cap while the take is running.
 *
 * The operator watching the request count climb is the person who wants to cap
 * it, and the only alternative — stop the take, open Settings — costs more
 * than the requests do. The new value is persisted as the default for the next
 * session too.
 */
export function setSemanticRequestLimit(limit: number | null): void {
  const normalized =
    limit === null || !Number.isFinite(limit) || limit < 1 ? null : Math.floor(limit);
  semanticSidecar?.setRequestLimit(
    normalized ?? DEFAULT_SEMANTIC_BUDGET.maxRequestsPerSession,
  );
  // Patch first: the settings store applies it optimistically and
  // `publishSemanticSpend` reads it back for the no-sidecar case.
  void patchSettings('following', { semanticRequestLimit: normalized }).catch(() => {});
  publishSemanticSpend();
}

/** Copy the scheduler's own counters into the store (§42.1 visibility). */
function publishSemanticSpend(): void {
  const sidecar = semanticSidecar;
  if (sidecar === null) {
    // No sidecar (manual/fixed mode, browser dev): no requests and no tokens,
    // but still report the cap the user has chosen — "0 of 400" when they set
    // 50 would misdescribe their own setting.
    const configured = currentFollowingSettings().semanticRequestLimit;
    state.update((s) => ({
      ...s,
      semanticSpend: {
        ...NO_SEMANTIC_SPEND,
        requestLimit: configured ?? DEFAULT_SEMANTIC_BUDGET.maxRequestsPerSession,
      },
    }));
    return;
  }
  const diagnostics = sidecar.scheduler.getDiagnostics();
  const requests = Object.values(diagnostics.requestsByLane).reduce((sum, n) => sum + n, 0);
  const spend: SemanticSpend = {
    requests,
    requestLimit: sidecar.scheduler.getBudget().maxRequestsPerSession,
    inputTokens: diagnostics.usage.inputTokens,
    cachedInputTokens: diagnostics.usage.cachedInputTokens,
    outputTokens: diagnostics.usage.outputTokens,
    totalTokens: diagnostics.usage.totalTokens,
    estimatedCostUsd: diagnostics.estimatedCostUsd,
    availability: diagnostics.availability,
  };
  state.update((s) => ({ ...s, semanticSpend: spend }));
}

/**
 * §36.5: any authorized discontinuity invalidates everything in flight. The
 * engine also bumps its semantic epoch on `moveTo`, so a late response would be
 * rejected anyway — cancelling is the cheaper half of the same guarantee.
 */
function invalidateSemantics(): void {
  semanticSidecar?.cancelInFlight();
}

/* ---------------------------------------------------------------------------
 * Stage bridge: snapshot relay, heartbeat (§43.5), stage-originated events.
 * ------------------------------------------------------------------------- */

function handleSnapshot(snapshot: TrackingSnapshot): void {
  state.update((s) => ({
    ...s,
    snapshot,
    blocksSeen: s.blocksSeen.includes(snapshot.blockId)
      ? s.blocksSeen
      : [...s.blocksSeen, snapshot.blockId],
  }));
  // Feed the smooth-following store. The worker's own SemanticMotionFrames
  // take precedence; this bridge only covers drivers that emit none.
  if (usingWorkerFrames) return relaySnapshot(snapshot);
  const frame = motionFrameFromSnapshot(snapshot, {
    sessionId: snapshot.sessionId,
    sessionGeneration,
    scriptCompileHash,
    layoutGeneration: stageLayoutGeneration,
    motionProfileId: followProfileId,
    sessionStartedAtMs,
    previous: lastMotionFrame,
  });
  lastMotionFrame = frame;
  smoothFollow.ingestMotionFrame(frame);
  publishSemanticFrame(frame);
  relaySnapshot(snapshot);
}

/* ---------------------------------------------------------------------------
 * `stage://semantic-frame` producer (companion §26.1)
 * ------------------------------------------------------------------------- */

/**
 * C2: this event had no producer outside `src/stage/preview.ts`, the in-browser
 * preview driver — so in a packaged build the stage's whole v2 motion engine
 * received nothing and the stage fell back to the degraded tracking-snapshot
 * path for the entire session.
 *
 * Like the heartbeat, this is a direct control → stage `emitTo`, not a Rust
 * command: it is a high-rate motion signal, not a validated document, and the
 * stage's frame receiver is the gate that rejects stale or foreign frames
 * (`StageApp.svelte` feeds it straight to `scriptLayer.pushSemanticFrame`).
 *
 * The `emitTo` binding is resolved once and cached — at 15–30 Hz an `import()`
 * per frame is pure overhead.
 */
type EmitToFn = (target: string, event: string, payload?: unknown) => Promise<void>;
let cachedEmitTo: EmitToFn | null = null;
let emitToPending: Promise<EmitToFn> | null = null;

async function resolveEmitTo(): Promise<EmitToFn> {
  if (cachedEmitTo) return cachedEmitTo;
  emitToPending ??= import('@tauri-apps/api/event').then((mod) => {
    cachedEmitTo = mod.emitTo as unknown as EmitToFn;
    return cachedEmitTo;
  });
  return emitToPending;
}

/** Testing seam: inject the emitter so the producer is observable in node. */
export function setStageEmitterForTesting(fn: EmitToFn | null): void {
  cachedEmitTo = fn;
  emitToPending = fn ? Promise.resolve(fn) : null;
}

function publishSemanticFrame(frame: SemanticMotionFrame): void {
  if (stageGeneration === 0) return;
  if (!cachedEmitTo && !isTauriRuntime()) return;
  const s = get(state);
  if (!s.sessionId || !s.stageAlive) return;
  if (cachedEmitTo) {
    void cachedEmitTo('stage', STAGE_EVENT.semanticFrame, frame).catch(() => {});
    return;
  }
  void resolveEmitTo()
    .then((emitTo) => emitTo('stage', STAGE_EVENT.semanticFrame, frame))
    .catch(() => {});
}

/** Throttled control → stage snapshot relay (§46.6). */
function relaySnapshot(snapshot: TrackingSnapshot): void {
  const current = get(state);
  if (!current.sessionId || stageGeneration === 0) return;
  const important =
    !snapshot.provisional || snapshot.movement !== 'advance' || snapshot.state !== 'following';
  const now = Date.now();
  if (!important && now - lastRelayAtMs < STAGE_RELAY_MIN_INTERVAL_MS) return;
  lastRelayAtMs = now;
  void stageService.publishStageSnapshot(current.sessionId, snapshot).catch(() => {});
}

function pushTranscriptLine(line: string): void {
  state.update((s) => ({
    ...s,
    transcriptTail: [...s.transcriptTail, line].slice(-4),
  }));
}

/* ---------------------------------------------------------------------------
 * Transcript retention (§36.2)
 *
 * Off by default and decided ONCE, in Rust, at session start: `start_session`
 * reads `general.saveTranscript` and stamps `transcript_retained` on the row,
 * and `append_session_transcript` refuses items for a row that says false. This
 * side must therefore never buffer text it was not told to keep — the point is
 * that a user who turned retention off has no transcript in memory either.
 * ------------------------------------------------------------------------- */

function bufferTranscriptItem(item: {
  itemId: string;
  commitSequence: number;
  audioStartMs?: number;
  audioEndMs?: number;
  transcript: string;
}): void {
  if (!transcriptRetained) return;
  const text = item.transcript.trim();
  if (text.length === 0) return;
  transcriptBuffer.push({
    itemId: item.itemId,
    receivedAtMs: Date.now(),
    commitSequence: item.commitSequence,
    providerItemId: item.itemId,
    audioStartMs: item.audioStartMs,
    audioEndMs: item.audioEndMs,
    transcript: text,
    disposition: 'script',
  });
}

function labelTranscriptItems(
  itemIds: readonly string[],
  disposition: 'script' | 'command' | 'discarded',
): void {
  if (!transcriptRetained || itemIds.length === 0) return;
  const wanted = new Set(itemIds);
  for (const item of transcriptBuffer) {
    if (wanted.has(item.itemId)) item.disposition = disposition;
  }
}

/**
 * Write out every item whose disposition has settled. `force` (session end)
 * writes the tail too — there is no later chance to relabel it.
 */
function flushTranscript(sessionId: string, force: boolean): void {
  if (!transcriptRetained || transcriptBuffer.length === 0) return;
  const cutoff = Date.now() - TRANSCRIPT_SETTLE_MS;
  const ready = force
    ? transcriptBuffer
    : transcriptBuffer.filter((item) => item.receivedAtMs <= cutoff);
  if (ready.length === 0) return;
  transcriptBuffer = force ? [] : transcriptBuffer.filter((item) => item.receivedAtMs > cutoff);
  void appendSessionTranscript(
    sessionId,
    ready.map((item) => ({
      commitSequence: item.commitSequence,
      providerItemId: item.providerItemId,
      audioStartMs: item.audioStartMs,
      audioEndMs: item.audioEndMs,
      transcript: item.transcript,
      disposition: item.disposition,
    })),
  ).catch(() => {
    // Retention is best-effort: a failed write must never interrupt a take.
  });
}

/* ---------------------------------------------------------------------------
 * Smooth-following actions (companion §48) — the store owns the state, this
 * store owns the effects.
 * ------------------------------------------------------------------------- */

function currentFollowingSettings(): FollowingSettings {
  try {
    return getSettingsSnapshot().following ?? defaultFollowingSettings();
  } catch {
    return defaultFollowingSettings();
  }
}

const followActions = {
  nudge(deltaSentences: number): void {
    moveSentences(deltaSentences);
  },
  /**
   * "Re-find me here" (§48): re-acquire around the position now on screen.
   * TODO(integration, Agent A): use a dedicated `reacquire` worker message so
   * the aligner reopens candidate windows instead of being re-seeded with its
   * own cursor.
   */
  reAnchor(): void {
    const token = get(state).snapshot?.tokenIndex;
    if (token === undefined) return;
    invalidateSemantics();
    driver?.moveToToken(token, 'manual');
    showToast('Re-finding your place', 'info', { durationMs: 1600 });
  },
  acceptCandidate(candidate: { tokenIndex: number }): void {
    invalidateSemantics();
    driver?.moveToToken(candidate.tokenIndex, 'manual');
  },
  /**
   * Pausing following is not pausing the session (§15.3, §48): transcription
   * stays connected and voice commands keep working — only automatic movement
   * stops.
   */
  setFollowingPaused(paused: boolean): void {
    if (paused) driver?.pause();
    else driver?.resume();
    state.update((s) => ({ ...s, voiceFollow: !paused }));
  },
  setIntelligenceMode(mode: FollowingSettings['intelligenceMode']): void {
    // §35: the live scheduler must follow the switch immediately — flipping to
    // local_only cancels everything in flight rather than waiting for a restart.
    semanticSidecar?.setMode(mode);
    setActiveSemanticSidecar(semanticSidecar);
    void patchSettings('following', { intelligenceMode: mode }).catch(() => {});
  },
  setCoachingDisplay(display: FollowingSettings['coachingDisplay']): void {
    void patchSettings('following', { coachingDisplay: display }).catch(() => {});
  },
  /**
   * §62 recovery. Re-publishing the current stage settings forces the stage to
   * re-run layout and rebuild its line map.
   * TODO(integration, Agent B): replace with an explicit rebuild directive once
   * the stage exposes one.
   */
  rebuildStageLayout(): void {
    pushSettings();
    showToast('Asked the stage to rebuild its layout', 'info');
  },
};

/**
 * Adopt the stage's layout generation and forward it to the worker (§7.2).
 *
 * Exported for the layout-generation contract test: the ack subscription is set
 * up behind a Tauri-only dynamic import, and the loop this closes is worth
 * asserting without one.
 */
export function adoptStageLayoutGeneration(generation: number): void {
  if (!Number.isInteger(generation) || generation < 0) return;
  if (generation === stageLayoutGeneration) return;
  stageLayoutGeneration = generation;
  // The worker stamps its own frames; the v1 bridge reads the module value
  // directly in `handleSnapshot`. Both producers now carry the stage's number.
  driver?.setLayoutGeneration(generation);
}

/** The stage layout generation control currently believes in (§7.2). */
export function currentStageLayoutGeneration(): number {
  return stageLayoutGeneration;
}

function startStageBridge(sessionId: string): void {
  if (!isTauriRuntime() || stageGeneration === 0) return;

  /*
   * Both of these are captured, never read from module scope inside the
   * handlers. A handler that outlived its session used to re-read the CURRENT
   * generation, pass its own `payload.stageGeneration !== stageGeneration`
   * guard for a different session, and (for `escapeRequested`) stop it.
   */
  const generation = stageGeneration;
  const token = (stageBridgeToken += 1);

  // Stage motion acks (§54) feed motion health, §61 degradation, and — C1 —
  // the layout-generation loop both frame producers depend on.
  stopMotionAcks = subscribeStageMotionAcks((ack) => {
    adoptStageLayoutGeneration(ack.layoutGeneration);
    smoothFollow.ingestStageAck(ack);
  });

  // Heartbeat: control → stage at ~1 s cadence; the stage acks to Rust.
  heartbeatTimer = setInterval(() => {
    heartbeatRevision += 1;
    void (async () => {
      const { emitTo } = await import('@tauri-apps/api/event');
      await emitTo('stage', STAGE_EVENT.heartbeat, {
        stageGeneration: generation,
        revision: heartbeatRevision,
        sentAtMs: Date.now(),
      });
    })().catch(() => {});
  }, 1000);

  void (async () => {
    const { listen } = await import('@tauri-apps/api/event');
    const unlisteners = await Promise.all([
      listen<StageEscapePayload>(STAGE_EVENT.escapeRequested, (event) => {
        if (event.payload.stageGeneration !== generation) return;
        if (event.payload.presses >= 2) {
          stopSession();
          showToast('Session stopped from the stage', 'info');
        } else {
          showToast('Press Escape again on the stage to end the session', 'info');
        }
      }),
      listen<StageIntentPayload>(STAGE_EVENT.intent, (event) => {
        if (event.payload.stageGeneration !== generation) return;
        const intent = event.payload.intent;
        if (intent.kind === 'toggle_pause') togglePlayPause();
        else if (intent.kind === 'manual_step') {
          moveSentences(intent.direction === 'forward' ? 1 : -1);
        }
        // manual_scroll is already applied locally on the stage; the tracker
        // re-acquires around it (§16.9).
      }),
      /*
       * `stage://error` carries two unrelated kinds of failure, because Rust
       * relays the stage's `media-error` onto the same channel the window
       * layer uses for its own errors (app.rs → `emit_to(CONTROL, STAGE_ERROR,
       * value)`, verbatim payload).
       *
       * B2: this handler used to test every payload against
       * /layout|line[-_ ]?map/ and RETURN on anything that did not match — so
       * a Listener that failed to decode was reported by the stage, relayed by
       * Rust, and thrown away on arrival. The operator's only signal was a
       * frozen human face on camera behind their script.
       *
       * The two kinds are now split at the door: a Listener health payload
       * (identified by its `status`, which the layout errors do not carry) is
       * a §40.5 media fault with its own recovery choices, and everything else
       * keeps the §62 line-map path exactly as it was.
       */
      listen<{ stageGeneration: number; code?: string; message?: string; status?: string }>(
        CONTROL_EVENT.stageError,
        (event) => {
          if (event.payload.stageGeneration !== generation) return;
          const health = asListenerHealth(event.payload);
          if (health !== null) {
            handleListenerHealth(health);
            return;
          }
          const code = event.payload.code ?? '';
          if (!/layout|line[-_ ]?map/i.test(`${code} ${event.payload.message ?? ''}`)) return;
          smoothFollow.reportLineMapInvalid(event.payload.message ?? code);
        },
      ),
      listen<{ stageGeneration: number }>(CONTROL_EVENT.stageClosed, (event) => {
        if (event.payload.stageGeneration !== generation) return;
        handleStageClosed();
      }),
    ]);
    // The session this bridge belongs to may already be gone.
    if (token !== stageBridgeToken) {
      for (const unlisten of unlisteners) unlisten();
      return;
    }
    stageEventUnlisteners = unlisteners;
  })().catch(() => {});
}

/**
 * §62: the stage window is gone and this session cannot reopen it. Stop
 * pretending otherwise — the heartbeat stops, directives stop being published,
 * and the UI is told so it can stand its stage controls down.
 */
function handleStageClosed(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  stageGeneration = 0;
  const s = get(state);
  if (!s.stageAlive) return;
  state.update((prev) => ({ ...prev, stageAlive: false }));
  if (s.active) {
    showToast('The stage window closed. Stop and restart the session to reopen it.', 'danger');
  }
}

/* ---------------------------------------------------------------------------
 * Listener media failures and recovery (§40.5)
 *
 * Everything in this section is deliberately inert with respect to reading
 * position. A Listener is a video of a person behind the words; when it breaks,
 * the take is still perfectly good, and the recovery must not touch the
 * tracking cursor, the scroll, the semantic epoch, or the driver at all. That
 * is why nothing here calls `driver`, `invalidateSemantics`, `moveSentences`,
 * or `relaySnapshot` — a cosmetic failure may not cost the presenter their
 * place.
 * ------------------------------------------------------------------------- */

const LISTENER_HEALTH_STATUSES = new Set(['ok', 'poster_fallback', 'failed', 'disabled']);

/**
 * Is this `stage://error` payload the stage's Listener health report?
 *
 * Discriminated on `status`, which only `StageListenerHealthPayload` carries —
 * the window layer's errors have `code`/`message` and no status. Matching on
 * the code would be fragile: the stage sends `code` only when it can attribute
 * a cause, and sends none at all when the autoplay policy simply keeps
 * refusing, which is a real failure the operator still has to see.
 */
function asListenerHealth(payload: {
  stageGeneration: number;
  status?: string;
}): StageListenerHealthPayload | null {
  if (typeof payload.status !== 'string') return null;
  if (!LISTENER_HEALTH_STATUSES.has(payload.status)) return null;
  return payload as StageListenerHealthPayload;
}

/** Clips in the current selection the stage has not already failed on. */
function remainingListenerClips(): number {
  if (listenerSelection === null) return 0;
  return listenerSelection.clipUrls.filter((clip) => !failedClipIds.includes(clip.id)).length;
}

function handleListenerHealth(health: StageListenerHealthPayload): void {
  // 'ok' means the stage is playing again; 'disabled' means it has nothing to
  // play by arrangement. Neither is something to offer a recovery for.
  if (health.status === 'ok' || health.status === 'disabled') {
    state.update((s) =>
      s.listenerFault === null || s.listenerFault.resolution === 'off'
        ? s
        : { ...s, listenerFault: null },
    );
    return;
  }
  // Already retired for this take: re-alerting about a Listener the operator
  // has switched off would be noise about a decision they already made.
  if (listenerRetiredForSession) return;

  const clipId = typeof health.clipId === 'string' ? health.clipId : null;
  if (clipId !== null && !failedClipIds.includes(clipId)) failedClipIds.push(clipId);

  state.update((s) => ({
    ...s,
    listenerFault: {
      status: health.status === 'failed' ? 'failed' : 'poster_fallback',
      code: health.code ?? null,
      clipId,
      atMs: Date.now(),
      resolution: 'unresolved',
      alternativeClips: remainingListenerClips(),
    },
  }));
  // Informational, not alarming: nothing about the take is at risk, and a
  // danger toast mid-performance would cost more attention than the fault does.
  showToast('The Listener video stopped. Your script and position are unaffected.', 'info');
}

/**
 * Re-arm the stage's Listener layer.
 *
 * Null first, then the selection. The stage keeps its poster-fallback state
 * for as long as the layer is mounted, so re-publishing the same selection
 * only updates a prop and changes nothing; unmounting and remounting is what
 * actually restarts playback.
 */
async function remountListener(selection: ListenerStageSelection | null): Promise<void> {
  const s = get(state);
  if (!s.sessionId || !s.stageAlive || stageGeneration === 0) return;
  const sessionId = s.sessionId;
  const generation = stageGeneration;
  await stageService.publishListenerState(sessionId, generation, {
    kind: 'listener',
    listener: null,
  });
  if (selection === null || listenerRetiredForSession) return;
  // The take may have ended (or the stage been replaced) while the first
  // publish was in flight; re-mounting into that would be publishing at a
  // stage this session no longer owns.
  if (get(state).sessionId !== sessionId || stageGeneration !== generation) return;
  await stageService.publishListenerState(sessionId, generation, {
    kind: 'listener',
    listener: selection,
  });
  listenerVisible = true;
}

function markListenerRetrying(): void {
  state.update((s) => ({
    ...s,
    listenerFault:
      s.listenerFault === null ? null : { ...s.listenerFault, resolution: 'retrying' },
  }));
}

/** §40.5 "Retry": reload the same Listener and let it try again. */
export function retryListenerMedia(): void {
  if (listenerRetiredForSession || listenerSelection === null) return;
  markListenerRetrying();
  void remountListener(listenerSelection).catch(() => {});
}

/**
 * §40.5 "Use poster": settle for the still image the pack ships.
 *
 * The stage has already fallen back to it — `poster_fallback` IS that state —
 * so this sends nothing and simply stops asking the operator to decide. It is
 * the cheapest possible recovery, which is the point: no stage churn, no
 * re-decode, nothing that could stutter the text.
 *
 * (A `failed` report would mean the layer is not in poster mode at all;
 * forcing it there needs a stage-side directive that does not exist yet, and
 * belongs to the stage lane. Today the stage only ever reports the fallback.)
 */
export function useListenerPoster(): void {
  state.update((s) =>
    s.listenerFault === null ? s : { ...s, listenerFault: { ...s.listenerFault, resolution: 'poster' } },
  );
}

/**
 * §40.5 "Choose another": drop the clip that failed and play the rest of the
 * pack. The failure is per-clip — an unsupported codec or a truncated file is
 * one file's problem — so the smallest honest change is to stop offering that
 * file, not to abandon the Listener.
 */
export function chooseAnotherListenerClip(): boolean {
  if (listenerRetiredForSession || listenerSelection === null) return false;
  const remaining = listenerSelection.clipUrls.filter((clip) => !failedClipIds.includes(clip.id));
  if (remaining.length === 0) return false;
  listenerSelection = { ...listenerSelection, clipUrls: remaining };
  markListenerRetrying();
  void remountListener(listenerSelection).catch(() => {});
  return true;
}

/**
 * §40.5 "Turn off": retire the Listener for the rest of the take.
 *
 * Nothing may bring it back — not the Stage quick control, not the
 * `set_listener` voice command, not a later remount — because the operator
 * turned it off mid-performance and a Listener reappearing on camera by itself
 * is worse than the failure was. The stage falls back to the text-only theme,
 * which is exactly what §40.5 asks for, and the script never moves.
 */
export function turnOffListenerForSession(): void {
  listenerRetiredForSession = true;
  listenerVisible = false;
  sendDirective({ kind: 'listener', listener: null });
  state.update((s) => ({
    ...s,
    listenerFault:
      s.listenerFault === null ? null : { ...s.listenerFault, resolution: 'off' },
  }));
}

function sendDirective(directive: StageDirective): void {
  const s = get(state);
  if (!s.sessionId || !s.stageAlive || stageGeneration === 0) return;
  if (directive.kind === 'listener') {
    void stageService
      .publishListenerState(s.sessionId, stageGeneration, directive)
      .catch(() => {});
    return;
  }
  void stageService.publishStageDirective(s.sessionId, stageGeneration, directive).catch(() => {});
}

/* ---------------------------------------------------------------------------
 * Transport actions (§15.3)
 * ------------------------------------------------------------------------- */

/** Start (or restart) prompting — the stage begins following. */
export function startPrompting(): void {
  const s = get(state);
  if (!s.active || s.prompting) return;
  state.update((prev) => ({ ...prev, prompting: true, paused: 'none' }));
  driver?.start();
  pipeline?.startListening();
}

/** Listening pause — transcription stays connected (§15.3). */
export function pauseListening(): void {
  state.update((s) => ({ ...s, paused: 'listening' }));
  driver?.pause();
  pipeline?.softPause();
}

/** Hard pause — the realtime connection closes; voice cannot resume (§15.3). */
export function hardPause(): void {
  // 'muted' is the deliberate-pause label; 'disconnected' means something
  // broke. A hard pause is a choice, so it must not read as a failure.
  state.update((s) => ({ ...s, paused: 'hard', micState: 'muted' }));
  driver?.pause();
  void pipeline?.hardPause().catch((err) => {
    showToast(`Could not pause cleanly: ${describeError(err)}`, 'danger');
  });
}

/**
 * H3: resume must NOT optimistically claim the microphone is live.
 *
 * The old version flipped `micState` to 'live' and cleared the pause before
 * awaiting anything, then swallowed the rejection — so a resume that failed
 * (and after a hard pause it always did, on an invalid `idle -> resume`
 * transition) left the UI showing a live microphone over a dead session, which
 * is the single worst outcome this product has. The UI now follows the
 * session, never leads it.
 */
export function resumeSession(): void {
  const s0 = get(state);
  if (!s0.active) return;
  state.update((s) => ({ ...s, connection: 'reconnecting' }));
  driver?.resume();
  if (!pipeline) {
    // Manual/mock mode: there is no session to negotiate.
    state.update((s) => ({ ...s, paused: 'none', micState: 'live', connection: 'connected' }));
    return;
  }
  void pipeline
    .resume()
    .then(() => {
      state.update((s) => ({ ...s, paused: 'none', micState: 'live', connection: 'connected' }));
    })
    .catch((err) => {
      // Stay paused and say so. Silence here is what made the failure invisible.
      state.update((s) => ({
        ...s,
        paused: s.paused === 'none' ? 'listening' : s.paused,
        micState: 'disconnected',
        connection: 'offline',
      }));
      showToast(`Could not resume voice following: ${describeError(err)}`, 'danger');
    });
}

function describeHold(reason: string | null): string {
  switch (reason) {
    case 'input_lost':
      return 'Microphone input stopped. Following is on hold.';
    case 'input_silent':
      return 'No sound is reaching the microphone. Following is on hold.';
    case 'no_transcripts':
      return 'No transcription is coming back. Following is on hold while we reconnect.';
    default:
      return 'Reconnecting — your position is held.';
  }
}

export function togglePlayPause(): void {
  const s = get(state);
  if (!s.active) return;
  if (!s.prompting) startPrompting();
  else if (s.paused === 'none') pauseListening();
  else resumeSession();
}

export function moveSentences(delta: number): void {
  invalidateSemantics();
  driver?.moveSentences(delta);
  state.update((s) => ({ ...s, counts: { ...s.counts, jumps: s.counts.jumps + 1 } }));
}

/**
 * Absolute move to a token (§15.1 outline navigation). `moveSentences` is a
 * RELATIVE move and needs a cursor, so it cannot express "put me here" before
 * the first snapshot exists — which is every moment before Start.
 */
export function goToToken(tokenIndex: number): void {
  if (!get(state).active) return;
  invalidateSemantics();
  driver?.moveToToken(Math.max(0, tokenIndex), 'manual');
  state.update((s) => ({ ...s, counts: { ...s.counts, jumps: s.counts.jumps + 1 } }));
}

export function restartParagraph(): void {
  invalidateSemantics();
  driver?.restartParagraph();
  state.update((s) => ({ ...s, counts: { ...s.counts, retakes: s.counts.retakes + 1 } }));
}

export function addTakeMarker(): void {
  state.update((s) => ({ ...s, counts: { ...s.counts, commands: s.counts.commands + 1 } }));
}

export function toggleBlankStage(): void {
  const s = get(state);
  // Nothing to blank once the stage window is gone (§62).
  if (!s.stageAlive) return;
  const blanked = !s.stageBlanked;
  sendDirective({ kind: 'blank', blanked, keepListener: false });
  state.update((prev) => ({ ...prev, stageBlanked: blanked }));
}

/**
 * The transport's "Voice follow" switch and the Live "Pause following" button
 * are the same decision (§48), so both route through the follow store and stay
 * in sync.
 */
export function toggleVoiceFollow(): void {
  smoothFollow.setFollowingPaused(get(state).voiceFollow);
}

/* ---------------------------------------------------------------------------
 * Stage appearance quick-controls (Live screen + voice commands)
 * ------------------------------------------------------------------------- */

function pushSettings(): void {
  if (stageSettings) sendDirective({ kind: 'settings', settings: { ...stageSettings } });
}

export function adjustStageFontSize(deltaPx: number): number {
  const next = Math.min(160, Math.max(24, (stageSettings?.fontSizePx ?? get(state).stageFontSizePx) + deltaPx));
  if (stageSettings) {
    stageSettings = { ...stageSettings, fontSizePx: next };
    pushSettings();
  }
  state.update((s) => ({ ...s, stageFontSizePx: next }));
  return next;
}

export function toggleStageMirror(axis: 'x' | 'y' = 'x'): void {
  if (!stageSettings) return;
  stageSettings =
    axis === 'x'
      ? { ...stageSettings, mirrorX: !stageSettings.mirrorX }
      : { ...stageSettings, mirrorY: !stageSettings.mirrorY };
  pushSettings();
}

export function toggleListenerVisible(): boolean {
  // §40.5: a Listener the operator turned off after a failure stays off for
  // the take, whichever control asks.
  if (listenerRetiredForSession) return false;
  listenerVisible = !listenerVisible && listenerSelection !== null;
  sendDirective({ kind: 'listener', listener: listenerVisible ? listenerSelection : null });
  return listenerVisible;
}

/* ---------------------------------------------------------------------------
 * Validated voice-command execution (§33.9, §34)
 * ------------------------------------------------------------------------- */

function executeValidatedCommand(command: ValidatedCommand): void {
  const executed = applyCommandAction(command.action);
  if (!executed) {
    showToast('That command is not available during prompting.', 'info');
    return;
  }
  state.update((s) => ({ ...s, counts: { ...s.counts, commands: s.counts.commands + 1 } }));
  sendDirective({ kind: 'ack', label: command.humanLabel, durationMs: 900 });
  showToast(command.humanLabel, 'info', { durationMs: 1600 });
}

function applyCommandAction(action: CommandAction): boolean {
  const s = get(state);
  switch (action.action) {
    case 'start':
      startPrompting();
      return true;
    case 'pause':
      pauseListening();
      return true;
    case 'resume':
      resumeSession();
      return true;
    case 'hard_pause':
      hardPause();
      return true;
    case 'stop':
      stopSession();
      return true;
    case 'blank_stage':
      if (!s.stageBlanked) toggleBlankStage();
      return true;
    case 'unblank_stage':
      if (s.stageBlanked) toggleBlankStage();
      return true;
    case 'toggle_mirror':
      toggleStageMirror(action.axis);
      return true;
    case 'set_font_size':
      adjustStageFontSize(action.valuePx - (stageSettings?.fontSizePx ?? s.stageFontSizePx));
      return true;
    case 'adjust_font_size':
      adjustStageFontSize(action.deltaSteps * 4);
      return true;
    case 'set_margins':
      if (stageSettings) {
        stageSettings = {
          ...stageSettings,
          columnWidthPercent: Math.min(100, Math.max(40, 100 - 2 * action.valuePercent)),
        };
        pushSettings();
      }
      return true;
    case 'adjust_margins':
      if (stageSettings) {
        stageSettings = {
          ...stageSettings,
          columnWidthPercent: Math.min(
            100,
            Math.max(40, stageSettings.columnWidthPercent - 2 * action.deltaPercent),
          ),
        };
        pushSettings();
      }
      return true;
    case 'adjust_reading_band':
      if (stageSettings) {
        stageSettings = {
          ...stageSettings,
          readingBandCenterPercent: Math.min(
            70,
            Math.max(20, stageSettings.readingBandCenterPercent + action.deltaPercent),
          ),
        };
        pushSettings();
      }
      return true;
    case 'set_cue_visibility':
      if (stageSettings) {
        stageSettings = { ...stageSettings, showCues: action.visible };
        pushSettings();
      }
      return true;
    case 'set_listener':
      if (action.enabled !== listenerVisible) toggleListenerVisible();
      return true;
    case 'adjust_listener_opacity':
      if (listenerSelection) {
        listenerSelection = {
          ...listenerSelection,
          geometry: {
            ...listenerSelection.geometry,
            opacity: Math.min(
              1,
              Math.max(0.05, listenerSelection.geometry.opacity + action.deltaPercent / 100),
            ),
          },
        };
        if (listenerVisible) sendDirective({ kind: 'listener', listener: listenerSelection });
      }
      return true;
    case 'next_section':
      return jumpSection(1);
    case 'previous_section':
      return jumpSection(-1);
    case 'go_to_target': {
      const target = compiledScript?.navigationTargets.find((t) => t.id === action.targetId);
      if (!target) return false;
      invalidateSemantics();
      driver?.moveToToken(target.tokenIndex, 'command');
      state.update((prev) => ({ ...prev, counts: { ...prev.counts, jumps: prev.counts.jumps + 1 } }));
      return true;
    }
    case 'move_relative': {
      const sign = action.direction === 'forward' ? 1 : -1;
      if (action.unit === 'sentence') {
        driver?.moveSentences(sign * action.amount);
        return true;
      }
      if (action.unit === 'section') return jumpSection(sign * action.amount);
      // paragraph: approximate as three sentences per paragraph move.
      driver?.moveSentences(sign * action.amount * 3);
      return true;
    }
    case 'restart_unit':
      if (action.unit === 'sentence') {
        driver?.moveSentences(0);
        return true;
      }
      restartParagraph();
      return true;
    case 'retake':
      restartParagraph();
      return true;
    case 'mark_checkpoint':
      addTakeMarker();
      return true;
    case 'set_scroll_mode':
      state.update((prev) => ({ ...prev, voiceFollow: action.mode === 'voice' }));
      return true;
    default:
      return false;
  }
}

function jumpSection(delta: number): boolean {
  const s = get(state);
  const flat: OutlineNode[] = [];
  const walk = (nodes: OutlineNode[]) => {
    for (const n of nodes) {
      flat.push(n);
      walk(n.children);
    }
  };
  walk(s.outline);
  if (flat.length === 0) return false;
  const token = s.snapshot?.tokenIndex ?? 0;
  let currentIndex = -1;
  flat.forEach((n, i) => {
    if (n.startTokenIndex <= token) currentIndex = i;
  });
  const target = flat[Math.max(0, Math.min(flat.length - 1, currentIndex + delta))];
  if (!target) return false;
  invalidateSemantics();
  driver?.moveToToken(target.startTokenIndex, 'command');
  state.update((prev) => ({ ...prev, counts: { ...prev.counts, jumps: prev.counts.jumps + 1 } }));
  return true;
}

/* ---------------------------------------------------------------------------
 * Stop / teardown
 * ------------------------------------------------------------------------- */

/**
 * Running realtime cost estimate (§35). ONE source for the Live status-bar
 * popover and the F.17 summary: they used to compute it differently and
 * disagreed by an order of magnitude for the same take.
 *
 * The live pipeline meters real connected time, which is the correct number
 * whenever there is one. Without a pipeline there is no billable stream at all
 * in manual and fixed modes; voice mode without a pipeline (browser dev, no
 * compiled script) falls back to elapsed minutes at the published rate so the
 * figure is still of the right order.
 */
function currentCostUsd(mode: SessionMode, elapsedSeconds: number): number {
  if (pipeline) return pipeline.estimatedCostUsd();
  if (mode !== 'voice') return 0;
  return estimateTranscriptionCostUsd(elapsedSeconds, costModel).usd;
}

/** Stop the session and produce the F.17 summary. */
export function stopSession(): SessionSummary {
  const s = get(state);
  // A stop with nothing running must not manufacture an end-of-session
  // summary — Live opens the F.17 dialog on `!active && summary !== null`.
  if (!s.active) {
    stopInternals();
    return s.summary ?? emptySummary(s);
  }
  const estimatedCostUsd = Math.round(currentCostUsd(s.mode, s.elapsedSeconds) * 100) / 100;
  // §42.1: read the sidecar's final counters BEFORE `stopInternals` disposes
  // it — this is the last moment the take's Luna spend can be observed at all.
  const semanticDiagnostics = semanticSidecar?.scheduler.getDiagnostics() ?? null;
  const summary: SessionSummary = {
    durationSeconds: s.elapsedSeconds,
    mode: s.mode,
    sectionsReached: s.blocksSeen.length,
    retakes: s.counts.retakes,
    commands: s.counts.commands,
    reconnects: s.counts.reconnects,
    estimatedCostUsd,
    // Reported to full precision: Luna spend is routinely sub-cent, and
    // rounding it to two places here is how a real cost becomes "$0.00".
    semanticCostUsd: semanticDiagnostics?.estimatedCostUsd ?? null,
    semanticRequests: semanticDiagnostics
      ? Object.values(semanticDiagnostics.requestsByLane).reduce((sum, n) => sum + n, 0)
      : 0,
    endingLocation: locateEnding(s),
    transcriptSaved: transcriptRetained,
  };
  // §36.2 + §36.1: write the retained tail and close the record BEFORE the
  // teardown resets `transcriptRetained`. `stopInternals` is what runs on every
  // abnormal path too, so the ordering here is the only thing that guarantees
  // the last few seconds of a take are not silently dropped.
  if (s.sessionId) {
    flushTranscript(s.sessionId, true);
    void endSessionRecord(s.sessionId, {
      endTokenIndex: s.snapshot?.tokenIndex,
      commandCount: s.counts.commands,
      retakeCount: s.counts.retakes,
      reconnectCount: s.counts.reconnects,
      manualCorrectionCount: s.counts.jumps,
      estimatedCostUsd,
      metrics: {
        sectionsReached: s.blocksSeen.length,
        durationSeconds: s.elapsedSeconds,
        endingLocation: summary.endingLocation,
      },
    }).catch(() => {
      // A session that cannot be closed is closed at next launch instead
      // (`sessions::close_orphaned_sessions`); never block the stop path.
    });
  }
  stopInternals();
  smoothFollow.endSession();
  if (s.sessionId) void stageService.closeStage(s.sessionId).catch(() => {});
  state.update((prev) => ({ ...prev, active: false, prompting: false, summary }));
  return summary;
}

export function clearSession(): void {
  // §36.1: clearing a session that is still running would drop its record on
  // the floor — the row would stay open until the next launch closed it as if
  // the app had crashed. Every caller today stops first; this makes that
  // ordering a property of the store rather than a convention.
  if (get(state).active) stopSession();
  stopInternals();
  smoothFollow.reset();
  state.set({ ...initial });
}

/** Shape-complete zero summary for a stop that had no session to stop. */
function emptySummary(s: SessionState): SessionSummary {
  return {
    durationSeconds: 0,
    mode: s.mode,
    sectionsReached: 0,
    retakes: 0,
    commands: 0,
    reconnects: 0,
    estimatedCostUsd: 0,
    semanticCostUsd: null,
    semanticRequests: 0,
    endingLocation: 'Beginning',
    transcriptSaved: false,
  };
}

function locateEnding(s: SessionState): string {
  const snapshot = s.snapshot;
  if (!snapshot) return 'Beginning';
  const flat: OutlineNode[] = [];
  const walk = (nodes: OutlineNode[]) => {
    for (const n of nodes) {
      flat.push(n);
      walk(n.children);
    }
  };
  walk(s.outline);
  const section = [...flat]
    .reverse()
    .find((n) => n.startTokenIndex <= snapshot.tokenIndex);
  return section ? section.title : `Token ${snapshot.tokenIndex}`;
}

function stopInternals(): void {
  // H6: the scheduler is created and cancelled with the take. Dispose it before
  // the driver so nothing in flight can post evidence at a dead worker.
  semanticSidecar?.dispose();
  semanticSidecar = null;
  pushSemanticContext = null;
  setActiveSemanticSidecar(null);
  driver?.dispose();
  driver = null;
  if (pipeline) {
    const p = pipeline;
    pipeline = null;
    void p.stop().catch(() => {});
  }
  if (clock) clearInterval(clock);
  clock = null;
  if (transcriptFlushTimer) clearInterval(transcriptFlushTimer);
  transcriptFlushTimer = null;
  transcriptRetained = false;
  transcriptBuffer = [];
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  stopMotionAcks?.();
  stopMotionAcks = null;
  stopSidecarFeed?.();
  stopSidecarFeed = null;
  lastMotionFrame = null;
  // Invalidate any bridge whose `listen()` calls have not settled yet, then
  // dispose the ones that have.
  stageBridgeToken += 1;
  for (const unlisten of stageEventUnlisteners) unlisten();
  stageEventUnlisteners = [];
  compiledScript = null;
  stageGeneration = 0;
  stageLayoutGeneration = 0;
  stageSettings = null;
  listenerSelection = null;
  listenerVisible = false;
  listenerRetiredForSession = false;
  failedClipIds = [];
}

/**
 * The realtime connection pill (§15.1). Three states, not two: `offline` is a
 * non-recoverable failure and nothing is retrying, so labelling it
 * "Reconnecting" in a warning tone tells the operator to wait for a recovery
 * that is never coming.
 */
export function connectionPill(connection: SessionState['connection']): {
  tone: 'success' | 'warning' | 'danger';
  label: string;
} {
  switch (connection) {
    case 'connected':
      return { tone: 'success', label: 'Connected' };
    case 'reconnecting':
      return { tone: 'warning', label: 'Reconnecting' };
    default:
      return { tone: 'danger', label: 'Disconnected' };
  }
}

/** F.11 status line for the top bar and tracking visualization. */
export const liveStatusLabel = derived(state, (s): string => {
  if (!s.active) return s.summary ? 'Session complete' : 'Ready to start';
  if (s.connection === 'offline') return 'Disconnected — voice following has stopped';
  if (s.connection === 'reconnecting') return 'Reconnecting — position held';
  if (s.micState === 'disconnected') return 'Microphone disconnected — position held';
  if (s.paused === 'hard') return 'Hard paused — microphone off';
  if (s.paused === 'listening') return 'Paused — still listening for “CandidCue, resume”';
  if (!s.prompting) return 'Ready to start';
  switch (s.snapshot?.state) {
    case 'following':
      return 'Following';
    case 'holding':
      return 'Holding your place';
    case 'searching':
      return 'Looking for your place';
    case 'retake_candidate':
      return 'Retake detected';
    case 'command_pending':
      return 'Command heard';
    case 'paused':
      return 'Paused — still listening for “CandidCue, resume”';
    case 'reconnecting':
      return 'Reconnecting — position held';
    default:
      return 'Listening';
  }
});
