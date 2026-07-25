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
  StageLayoutErrorPayload,
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
import { CoachingSessionController } from '../services/coaching-session';
import {
  FIRST_TAKE_PASS_ORDINAL,
  takePassIdFor,
} from '../../shared/coaching/take-pass';
import { createCoachingObserverTransport } from '../services/coaching-luna';
import type { MediaStreamLike } from '../services/audio';
import type { CoachRailState } from '../../shared/contracts';
import {
  appendSessionTranscript,
  endSessionRecord,
  recordSessionTake,
  type TakeCheckpointInput,
} from '../services/session-records';
import type { AssistSchedulingContext, SemanticAvailability } from '../../shared/semantic';
import { DEFAULT_SEMANTIC_BUDGET } from '../../shared/semantic';
import { getModelCapabilities } from '../services/capabilities';
import { resolveSmoothFollowProfile } from '../../shared/tracking/profile';
import { defaultFollowingSettings } from '../lib/follow-profiles';
import {
  TranscriptConfidenceWatch,
  type TranscriptConfidenceInput,
} from '../lib/transcript-confidence-watch';
import { configureFollowActions, smoothFollow } from './smooth-follow';
import { getSettingsSnapshot, patchSettings } from './settings';
import { showToast } from './toasts';
import { compiled as compiledStore } from './compiled';
import { saveNow } from './editor';

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
 * A window-layer failure reported on `stage://error` (§52.7).
 *
 * The one that actually happens is `STAGE_DISPLAY_MISMATCH`: the stage was
 * asked for a monitor and opened on a different one. Nothing is broken — the
 * script is prompting perfectly — it is just prompting at the wrong wall, which
 * is the single most expensive thing to discover after the take has started.
 *
 * `code` is kept as an open string on purpose. This channel has now silently
 * dropped two different classes of payload; the store must be able to surface a
 * code it has never heard of rather than discard it, so an unrecognised code
 * still becomes a notice with whatever message the window layer sent.
 */
export interface StageWindowFault {
  code: string;
  message: string;
  /** The display the operator picked, when the payload names one. */
  requestedFingerprint: string | null;
  /** The display the stage actually landed on, when the payload names one. */
  actualFingerprint: string | null;
  atMs: number;
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
  /** Words the recogniser returned this take. Zero means nothing was heard. */
  wordsHeard: number;
  /** How far the cursor actually got, in script words. */
  wordsFollowed: number;
  /** Script length, so `wordsFollowed` has something to be a fraction of. */
  scriptWords: number;
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
  /**
   * §27. Whether the Coaching Rail's contents are shown. Toggled by the control
   * UI or the "show me my stats" voice command. Hiding never reflows the script
   * (§7.1): the band stays reserved, only the contents fade. `false` when
   * coaching mode is `off`, because there is no rail to show.
   */
  coachRailVisible: boolean;
  /** §6. Whether coaching is running at all this take (mode !== 'off'). */
  coachingActive: boolean;
  voiceFollow: boolean;
  connection: 'connected' | 'reconnecting' | 'offline';
  micState: 'live' | 'muted' | 'disconnected';
  /**
   * §28.2/§28.6: the INPUT is the thing that failed — unplugged, silent, or
   * refused — as opposed to the realtime transport dying, which also leaves
   * `micState` at 'disconnected'. Only this one is fixable by choosing another
   * device, so it is what gates the Live screen's input picker. Offering a
   * microphone switch as the cure for a rejected API key would be the same
   * unfollowable-instruction defect in a new place.
   */
  inputDeviceLost: boolean;
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
  /**
   * §52.7 window-layer failure — the stage on the wrong display, or any other
   * code the window layer reports. Null until something goes wrong, and
   * dismissable: unlike the Listener fault there is no in-session repair, only
   * "now you know, and here is how to see which panel is which".
   */
  stageWindowFault: StageWindowFault | null;
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
  coachRailVisible: false,
  coachingActive: false,
  voiceFollow: true,
  connection: 'connected',
  micState: 'live',
  inputDeviceLost: false,
  stageAlive: true,
  estimatedCostUsd: 0,
  semanticSpend: { ...NO_SEMANTIC_SPEND },
  listenerFault: null,
  stageWindowFault: null,
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

/**
 * §60 low transcript confidence.
 *
 * The realtime session is billed for `requestLogprobs: true` and the per-token
 * confidences derived from them already widen the semantic filter's measurement
 * variance — so following really does get vaguer while the recogniser struggles.
 * Until now nothing told the presenter why: `TranscriptFeedStatus` has always
 * had a `'low_confidence'` member and `deriveNotices` has always rendered it,
 * and nothing ever produced it.
 *
 * Take-scoped, like every other per-session detector here. The thresholds and
 * the hysteresis live in the watcher; see that module for why they are what they
 * are.
 */
let transcriptConfidence = new TranscriptConfidenceWatch();

/**
 * The take's coaching subsystem (companion Part II). Session-owned and disposed
 * with the take, exactly like the semantic sidecar. Null in manual/fixed modes,
 * outside Tauri, when there is no compiled script, and when coaching mode is
 * `off` — in every one of those cases there is nothing to drive.
 *
 * It is fed the same `MediaStreamTrack` the voice pipeline already captured
 * (§5.3), transcript from the same finalized items, and tracking facts from the
 * same snapshots. Its only output is a `CoachRailState` relayed to the stage,
 * and nothing it does can reach motion (§2.1/§5.2).
 */
let coaching: CoachingSessionController | null = null;

/* ---------------------------------------------------------------------------
 * §36.3 take history
 *
 * The §36.1 session record has always been able to say "four takes happened"
 * and nothing about any of them: `retake_count` is a scalar, `sectionsReached`
 * was a single number folded into `metrics_json` at the end, and
 * `addTakeMarker` — the handler for the "mark this" voice command — incremented
 * a counter and stored no marker at all.
 *
 * This is the per-take detail on top: when each pass ran, where it started and
 * stopped, which sections it traversed, and where the presenter marked a
 * checkpoint. It reuses the sections the store was ALREADY accumulating
 * (`blocksSeen`) and is keyed by the review lane's own `takePassId`, so the two
 * are one history rather than two.
 * ------------------------------------------------------------------------- */

/** The take currently being performed. Null outside a session. */
interface ActiveTake {
  /** 1-based; a retake opens the next one and never rewrites this one. */
  passOrdinal: number;
  /** `${sessionId}:${passOrdinal}` — the review lane's take-pass identity. */
  takePassId: string;
  startedAtIso: string;
  /** Monotonic, so a clock step cannot invent or erase a take's duration. */
  startedAtMs: number;
  startTokenIndex: number;
  /** Authored block ids in the order this pass first reached them. */
  sections: string[];
  checkpoints: TakeCheckpointInput[];
  /**
   * §36.3 automatic retake transitions — the aligner deciding the presenter went
   * back and re-read. Distinct from a MANUAL retake, which opens a new pass and
   * so is a row of its own rather than a counter.
   */
  automaticRetakes: number;
  /** §36.3 confidence summary, accumulated rather than sampled. */
  confidenceSum: number;
  confidenceSamples: number;
}

let activeTake: ActiveTake | null = null;

/**
 * §36.3's own words: "within the current live session, keep an IN-MEMORY take
 * history ... this powers 'restart this take' and can be discarded at Stop".
 *
 * So the list is held here for the session's own use, and each pass is ALSO
 * written through to `session_takes` as it closes. The persistence is the part
 * the spec does not require and the review screen does: a take history that only
 * exists until Stop cannot answer "how did the third take go" ten minutes later,
 * which is the one moment anybody wants to know.
 */
let sessionTakes: ActiveTake[] = [];

/**
 * Checkpoints per take. These are deliberate operator actions — a spoken "mark
 * this", a paragraph restart, an outline jump — so two hundred inside a single
 * pass is already far past anything real. The cap keeps the row bounded; the
 * EARLIEST are kept because this is a history, and a history that loses its
 * beginning is not one.
 */
const MAX_TAKE_CHECKPOINTS = 200;

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
/**
 * Words the recogniser returned this take (§36 summary).
 *
 * The end-of-take summary reported duration, sections, retakes and cost —
 * every one of which reads the same whether the microphone was working or the
 * take was nine seconds of silence. There was nothing in it that answered "did
 * it hear me", which is the first thing anyone wants to know and the only one
 * that distinguishes a working session from a broken one.
 */
let wordsHeard = 0;
/** Script length in spoken words, so progress has a denominator. */
let scriptWordCount = 0;

/** Whitespace-separated words, which is what "words" means to a presenter. */
function countSpokenWords(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}
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
  /**
   * §22. The stored revision the compiled document was produced from.
   *
   * A `CompiledScript` carries `scriptId` and `sourceHash` but no revision
   * number, and the outbound `LunaCoachRequest` has a `scriptRevision` field
   * that the review lane compares against the script's own to decide whether an
   * annotation still points at the text it was written about
   * (`shared/coaching/review/script-annotations.ts`). It has to be handed down.
   */
  scriptRevision?: number;
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
  /**
   * §28.4 local voice-detection sensitivity (0–1, 0.5 = A.6 defaults). Omitted
   * means "read the saved setting", which is what production does — the value
   * is only ever passed explicitly by a preview or a test.
   */
  vadSensitivity?: number;
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
  wordsHeard = 0;
  scriptWordCount = input.totalTokens;
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
  // §60: evidence never crosses a take boundary. A fresh watcher is cheaper and
  // more obviously correct than resetting one, and it is the same lifetime as
  // every other take-scoped detector in this store.
  transcriptConfidence = new TranscriptConfidenceWatch();
  // §36.3: the session's first take opens with it, on a fresh history.
  sessionTakes = [];
  beginTake(sessionId, 1, 0);

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
    // §47.1: the worker must resolve the *same* follow profile the stage
    // envelope did. It falls back to the settings snapshot when this is
    // omitted, which matches production — but a session started with a
    // `following` that differs from saved settings (a calibration preview)
    // would otherwise resolve the stage from the passed value and the aligner
    // from the stored one, which is the split-brain this field exists to close.
    following,
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
      // §28.4: the slider had no reader at all. The saved value is the default
      // so every caller of `startLiveSession` gets it, not only Preflight.
      vadSensitivity: input.vadSensitivity ?? currentVadSensitivity(),
      // §29.2 steps 1–3, enforced by the controller that specifies them rather
      // than by whichever screen happened to run first.
      startSequence: buildStartSequenceGate(input),
      // §29.2 step 9, the half that lives above the pipeline.
      onResetTranscriptState: () => {
        state.update((s) => ({ ...s, transcriptTail: [] }));
        transcriptConfidence.reset();
      },
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
      onTrackingEvent: (event) => {
        // §60: the same `completed` event that feeds the aligner carries the
        // provider's log probabilities, so the confidence evidence is read here
        // one step before the worker sees it — no new worker protocol needed.
        if (event.type === 'completed') {
          // §36 "did it hear me". Counted here rather than from the retained
          // transcript, because retention is a SETTING and the question this
          // answers — was anything transcribed at all — has to be answerable
          // with retention off, which is the default.
          wordsHeard += countSpokenWords(event.text);
          noteTranscriptConfidence({
            itemId: event.itemId,
            text: event.text,
            ...(event.logprobs ? { logprobs: event.logprobs } : {}),
            receivedAtMs: event.receivedAtMs,
          });
        }
        driver?.feedTranscript(event);
      },
      onMaskItems: (itemIds) => {
        // §36.2: an item the command channel consumed is a command phrase, not
        // performed script, and the retained transcript must say so.
        labelTranscriptItems(itemIds, 'command');
        // §60: nor is a wake phrase evidence about how well the recogniser is
        // hearing the script — retract it from the confidence window.
        transcriptConfidence.forget(itemIds);
        driver?.maskItems(itemIds);
      },
      // §33.4 tail: the router decided the phrase was authored script after
      // all, so alignment gets those items back.
      onReleaseItems: (itemIds) => {
        labelTranscriptItems(itemIds, 'script');
        driver?.releaseItems(itemIds);
      },
      // §5.3: the single-capture fan-out. The pipeline is the one caller of
      // getUserMedia; the coaching analyzer is a third consumer of the very
      // same stream, never a second capture.
      onCaptureStream: (stream) => startCoaching(input, stream),
      // §36.2: finalized text only, never audio. Buffered here and written
      // through `append_session_transcript`, which Rust refuses outright when
      // the session was opened with retention off.
      // The same finalized item also feeds coaching (fillers + pace); coaching
      // reads text only and never audio, exactly like retention.
      onTranscriptItem: (item) => {
        bufferTranscriptItem(item);
        coaching?.noteFinalTranscript({
          itemId: item.itemId,
          commitSequence: item.commitSequence,
          transcript: item.transcript,
        });
      },
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
      /*
       * §28.4. Tell the presenter the room has been measured.
       *
       * Calibration averages the first two seconds of audio into the noise
       * floor, and the speech gate is a multiple of that floor — so a take
       * that begins with someone already reading measures their voice and
       * sets the threshold above it. Nothing on the stage said when the window
       * had closed, so "wait, then speak" was advice nobody could follow.
       *
       * On the acknowledgement channel because it already exists, is already
       * validated by Rust, and is already the transient-notice surface. It
       * inherits that channel's setting, which is the one wart: an operator
       * who has turned stage acknowledgements off does not get this either.
       */
      onVadCalibrating: () => {
        // Slightly longer than the 2 s window, so it is still on screen when
        // "Ready" replaces it rather than leaving a gap of nothing.
        sendDirective({ kind: 'ack', label: 'Listening to the room…', durationMs: 2400 });
      },
      onVadCalibrated: () => {
        sendDirective({ kind: 'ack', label: 'Ready — start speaking', durationMs: 1600 });
      },
      // H5: a dead input is not a provider problem; the user must act.
      onInputDeviceLost: (code) => {
        // §12.7: device loss outranks every acoustic reading on the mic tile.
        coaching?.setMicrophoneDisconnected(true);
        state.update((s) => ({ ...s, micState: 'disconnected', inputDeviceLost: true }));
        // §28.2/§28.6: the remedy named here is one the Live screen can
        // actually perform — `switchMicrophone` below drives the transport's
        // track replacement, and the status bar grows an input picker while
        // `micState` is 'disconnected'.
        showToast(
          code === 'MIC_NO_SIGNAL'
            ? 'No sound is reaching the microphone. Following is on hold until audio comes back.'
            : 'The microphone disconnected. Reconnect it or pick another input in the status bar, and following resumes.',
          'danger',
        );
      },
      /*
       * §28.6: the input came back on its own — the mic was replugged, or the
       * track unmuted. "Reconnect it and we resume" is a promise the product
       * has to keep without being asked twice, so the pills clear themselves.
       */
      onInputRestored: () => {
        const before = get(state);
        if (!before.inputDeviceLost) return;
        coaching?.setMicrophoneDisconnected(false);
        state.update((s) => ({
          ...s,
          inputDeviceLost: false,
          // Only undo the loss this flag recorded; a transport that is also
          // down keeps its own honest 'disconnected'.
          micState: s.micState === 'disconnected' ? 'live' : s.micState,
        }));
        showToast('The microphone is back. Voice following has resumed.', 'success');
      },
      // H1: a session-level provider failure must never leave a green UI.
      onSessionFailure: (code, fatal) => {
        state.update((s) => ({
          ...s,
          connection: fatal ? 'offline' : 'reconnecting',
          micState: fatal ? 'disconnected' : s.micState,
        }));
        // §44.12 / E.7: the code is an internal contract. `describeError`
        // turns it into authored copy that says what happened and what to do;
        // the raw code goes to Settings → Diagnostics, not to the toast.
        showToast(
          `${fatal ? 'Voice following stopped.' : 'Voice following interrupted.'} ${describeError(code)}`,
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
      showToast(`Voice tracking is unavailable. ${describeError(err)}`, 'danger');
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
 * §29.2 start sequence, steps 1–3
 * ------------------------------------------------------------------------- */

/**
 * A precondition of the start sequence was not met. Thrown out of the gate,
 * caught by `RealtimeSessionController.start`, which tears the attempt down and
 * rethrows — so the transport is never subscribed and nothing billable begins.
 */
export class StartSequenceError extends Error {
  constructor(
    readonly step: 'script_save' | 'compile' | 'stage_ack',
    message: string,
  ) {
    super(message);
    this.name = 'StartSequenceError';
  }
}

/**
 * Build the §29.2 steps 1–3 gate for this take.
 *
 * These steps were being performed in `Preflight.svelte` before
 * `startLiveSession` was ever called, which made the ordering true by accident.
 * The accident is the defect: the controller re-runs its whole start sequence on
 * every resume-after-sleep and every recovery from a hard pause, long after
 * Preflight is gone, and any future caller — a retake, a restored session, a
 * second entry point — inherits nothing.
 *
 * So each step is expressed as the CHECK it really is. Step 1 flushes, which is
 * a no-op when there is nothing pending. Steps 2 and 3 ask whether the compile
 * is current and the stage has acked, and refuse the start when they are not.
 * Running them a second time therefore costs nothing on the happy path and is
 * the only thing standing between a future caller and a take that starts against
 * a stale script or a stage that never hydrated.
 */
function buildStartSequenceGate(input: StartSessionInput): {
  flushScriptSave(): Promise<void>;
  ensureCompiled(): Promise<void>;
  awaitStageAck(): Promise<void>;
} {
  const expectedStageGeneration = input.stageGeneration ?? 0;
  return {
    async flushScriptSave(): Promise<void> {
      // Idempotent: `saveNow` returns immediately when nothing is dirty, and it
      // flushes any debounced compile on the way through.
      await saveNow();
    },

    async ensureCompiled(): Promise<void> {
      const compiledScript = input.compiled ?? null;
      if (compiledScript === null) {
        throw new StartSequenceError(
          'compile',
          'The script has not finished compiling, so the session cannot start.',
        );
      }
      const store = get(compiledStore);
      // An idle store means nobody has compiled through it this run — a test,
      // or a caller with its own compiler. The supplied script is then the only
      // authority and it has already been checked.
      if (store.status === 'idle') return;
      if (store.status === 'error') {
        throw new StartSequenceError('compile', store.error ?? 'The script failed to compile.');
      }
      const blocking = (store.result?.diagnostics ?? []).filter(
        (diagnostic) => diagnostic.blocking || diagnostic.severity === 'error',
      );
      if (blocking.length > 0) {
        throw new StartSequenceError(
          'compile',
          `The script has ${blocking.length === 1 ? 'a problem' : `${blocking.length} problems`} that must be fixed first: ${blocking[0]?.message ?? ''}`,
        );
      }
      // §45.3: a compile that has moved on since this session was assembled
      // means the stage is prompting text the aligner was not built from.
      if (
        store.status === 'ready' &&
        store.result !== null &&
        store.result.sourceHash !== compiledScript.sourceHash
      ) {
        throw new StartSequenceError(
          'compile',
          'The script changed after the session was prepared. Start again from Preflight.',
        );
      }
    },

    async awaitStageAck(): Promise<void> {
      // No stage window for this session (browser dev, headless tests): there is
      // no handshake to insist on, and inventing one would make the store
      // untestable without a Tauri runtime.
      if (expectedStageGeneration === 0 || !isTauriRuntime()) return;
      const status = await stageService.getStageStatus();
      if (
        status.stageGeneration !== expectedStageGeneration ||
        !status.hydrated ||
        !status.layoutReady
      ) {
        throw new StartSequenceError(
          'stage_ack',
          'The stage has not finished preparing, so the session cannot start.',
        );
      }
    },
  };
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
 * The `SmoothFollowProfile` here is the resolved default while the worker now
 * receives the user's resolved profile, and the seam still holds — but for a
 * narrower reason than it used to. §47.1 keeps `alignment` untouched across
 * every follow feel, so `semanticInfluenceMax` is the same number on both
 * sides regardless of which feel is selected, and the fused adjustment is
 * clamped to the identical bound the beam re-clamps it to. If a future profile
 * ever varies an `alignment` field, this must take the same resolved profile
 * the driver does rather than the default.
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
 * Coaching subsystem (companion Part II)
 * ------------------------------------------------------------------------- */

/**
 * Stand up the take's coaching subsystem on the SAME capture the pipeline just
 * opened (§5.3). Constructed once per capture; a device change re-invokes this,
 * and the guard keeps a single controller for the take.
 *
 * `off` and `review_only` do nothing live (§6.1/§6.5), but the subsystem is
 * still constructed for `review_only` because it keeps analysing while
 * publishing nothing. `off` is the one mode that is not constructed at all —
 * there is genuinely nothing to drive.
 */
function startCoaching(input: StartSessionInput, stream: MediaStreamLike): void {
  if (coaching !== null) return;
  const coachingSettings = getSettingsSnapshot().coaching;
  if (coachingSettings.mode === 'off') return;
  const sessionId = get(state).sessionId;
  if (!sessionId) return;

  const wantsLuna =
    semanticSidecar !== null && coachingSettings.modules.liveTips && coachingSettings.mode !== 'review_only';

  const controller = new CoachingSessionController({
    sessionId,
    settings: coachingSettings,
    compiled: input.compiled ?? null,
    // B3: the coach request identifies the SCRIPT, not the session. Both of
    // these used to be absent, so every outbound request named the session id
    // as its script and claimed revision 0.
    scriptId: input.scriptId,
    scriptRevision: input.scriptRevision ?? 0,
    stream,
    // §36.3: the ordinal, not an id. The controller mints through
    // `takePassIdFor`, so this lane cannot name a pass differently from the
    // take row. Capture can open *after* a retake — a mid-take device switch
    // re-acquires the stream — so the open take's ordinal is the right one and
    // a hard-coded 1 would silently fold a later pass into the first.
    initialPassOrdinal: activeTake?.passOrdinal ?? FIRST_TAKE_PASS_ORDINAL,
    publish: (snapshot) => publishCoachRail(snapshot),
    ...(wantsLuna
      ? {
          lunaTransport: createCoachingObserverTransport(),
          lunaMode: coachingSettings.mode === 'studio' ? 'enhanced' : 'standard',
          // §20.3: the coach observer shares the session's semantic budget
          // rather than opening a second, unmetered path to the API.
          isBudgetExhausted: () => isSemanticBudgetExhausted(),
        }
      : {}),
    onLaneFailure: () => {
      // §5.2: a lane failure is contained inside the subsystem. It is not a
      // session failure and must never reach the scroll; recording it for
      // diagnostics is enough.
    },
  });

  coaching = controller;
  // §7.1/§27. Push the initial display state so the first published snapshot
  // carries the right visibility and mirror, and the rail reserves its band
  // pre-take. `visible` follows the stage settings' reduced-motion and the
  // control's own toggle, which starts shown whenever coaching is active.
  controller.setDisplayState({
    visible: true,
    mirrored: stageSettings?.mirrorX === true || stageSettings?.mirrorY === true,
    reducedMotion: stageSettings?.reducedMotion === true,
  });
  state.update((s) => ({ ...s, coachingActive: true, coachRailVisible: true }));

  void controller.start().catch(() => {
    // Attaching the analyzer failed; transcript-driven filler and pace coaching
    // still run. Never a session failure (§5.2).
  });
}

/** §20.3. Whether the session's shared semantic budget is spent. */
function isSemanticBudgetExhausted(): boolean {
  const sidecar = semanticSidecar;
  if (sidecar === null) return false;
  const diagnostics = sidecar.scheduler.getDiagnostics();
  const used = Object.values(diagnostics.requestsByLane).reduce((sum, n) => sum + n, 0);
  return used >= sidecar.scheduler.getBudget().maxRequestsPerSession;
}

/** §5.4. Push the live tracking facts the orchestrator cannot compute. */
function feedCoachingTracking(snapshot: TrackingSnapshot): void {
  coaching?.setTrackingState({
    tokenIndex: snapshot.tokenIndex,
    alignmentConfidence: snapshot.confidence,
    reacquiring: snapshot.state === 'searching' || snapshot.state === 'reconnecting',
    commandActive: snapshot.state === 'command_pending',
    // §26.5: the authored SPAN the presenter is on, never a token id. The
    // aligner reports the sentence; that is the coarsest honest span we have.
    activeScriptSpanId: snapshot.sentenceId || null,
    // §5.4: the engine's semantic epoch, which only reaches the control layer
    // on the v2 motion frame. It bumps on a command jump, a retake and a
    // re-anchor, and it is what lets the coaching subsystem disown evidence
    // taken against a position the engine has since abandoned.
    trackingEpoch: lastMotionFrame?.epoch ?? 0,
  });
}

/* ---------------------------------------------------------------------------
 * Stage bridge: snapshot relay, heartbeat (§43.5), stage-originated events.
 * ------------------------------------------------------------------------- */

function handleSnapshot(snapshot: TrackingSnapshot): void {
  // §36.3: sections traversed, per take. `blocksSeen` below is the same fact
  // for the whole session and has only ever been read as a count; this is the
  // per-pass list, which is what makes "take 2 never reached the close" sayable.
  if (activeTake !== null) {
    if (snapshot.blockId && !activeTake.sections.includes(snapshot.blockId)) {
      activeTake.sections.push(snapshot.blockId);
    }
    // §36.3 confidence summary, accumulated over every snapshot the pass saw.
    if (Number.isFinite(snapshot.confidence)) {
      activeTake.confidenceSum += snapshot.confidence;
      activeTake.confidenceSamples += 1;
    }
    // §36.3 automatic retake transitions: the ALIGNER concluded the presenter
    // went back and re-read. A manual retake opens a new pass instead, so the
    // two are never conflated into one number.
    if (snapshot.movement === 'retake') activeTake.automaticRetakes += 1;
  }
  state.update((s) => ({
    ...s,
    snapshot,
    blocksSeen: s.blocksSeen.includes(snapshot.blockId)
      ? s.blocksSeen
      : [...s.blocksSeen, snapshot.blockId],
  }));
  // Feed the smooth-following store. The worker's own SemanticMotionFrames
  // take precedence; this bridge only covers drivers that emit none.
  if (usingWorkerFrames) {
    // §5.4/§14.10: the coaching subsystem reads the alignment cursor and the
    // active span from the same snapshot. It is advisory — nothing it does here
    // reaches back into motion (§2.1).
    feedCoachingTracking(snapshot);
    return relaySnapshot(snapshot);
  }
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
  // Fed *after* the bridged frame so the coaching lane reads this snapshot's
  // epoch rather than the previous one.
  feedCoachingTracking(snapshot);
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

/**
 * §27. Relay one Coaching Rail snapshot straight to the stage, the same direct
 * `emitTo` path the heartbeat and semantic frame use. Coaching is advisory and
 * failure-isolated (§5.2), so it never travels the validated Rust document
 * channel that can move the script. The snapshot carries its own `sessionId`
 * and monotonic `stageRevision`, which the stage validates on arrival.
 */
function publishCoachRail(snapshot: CoachRailState): void {
  if (stageGeneration === 0) return;
  if (!cachedEmitTo && !isTauriRuntime()) return;
  const s = get(state);
  if (!s.sessionId || !s.stageAlive) return;
  if (cachedEmitTo) {
    void cachedEmitTo('stage', STAGE_EVENT.coachRail, snapshot).catch(() => {});
    return;
  }
  void resolveEmitTo()
    .then((emitTo) => emitTo('stage', STAGE_EVENT.coachRail, snapshot))
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

/**
 * §60. Feed one finalized item to the confidence watcher and, when its verdict
 * changes, say so.
 *
 * The status field is shared with §59, so the two must not fight over it. An
 * `interrupted` feed outranks a weak one — there is no transcript at all to be
 * unconfident about — so the notice is only raised from `live`, and only ever
 * cleared back to `live` from `low_confidence`. Whichever of the two conditions
 * ends last therefore leaves the field describing reality rather than describing
 * whichever producer spoke most recently.
 */
function noteTranscriptConfidence(item: TranscriptConfidenceInput): void {
  const verdict = transcriptConfidence.observe(item);
  if (verdict === null) return;
  const status = smoothFollow.snapshot().transcript.status;
  if (verdict.status === 'low_confidence') {
    if (status !== 'live') return;
    smoothFollow.reportTranscriptStatus('low_confidence', verdict.detail);
    return;
  }
  if (status === 'low_confidence') smoothFollow.reportTranscriptStatus('live');
}

/* ---------------------------------------------------------------------------
 * §36.3 take history — lifecycle
 * ------------------------------------------------------------------------- */

/** Open a take pass. `startLiveSession` opens the first; a retake opens the next. */
function beginTake(sessionId: string, passOrdinal: number, startTokenIndex: number): void {
  activeTake = {
    passOrdinal,
    // The same scheme the coaching subsystem stamps on its own take passes, so
    // a review report and a take row for the same pass carry one identifier.
    takePassId: takePassIdFor(sessionId, passOrdinal),
    startedAtIso: new Date().toISOString(),
    startedAtMs: monotonicNowMs(),
    startTokenIndex,
    sections: [],
    checkpoints: [],
    automaticRetakes: 0,
    confidenceSum: 0,
    confidenceSamples: 0,
  };
  sessionTakes.push(activeTake);
}

/**
 * §36.3 in-memory take history for this session, oldest pass first. The open
 * take is the last entry. Empty outside a session — it is discarded at Stop, as
 * the spec says, while the persisted rows outlive it.
 */
export function takeHistory(): ReadonlyArray<{
  passOrdinal: number;
  takePassId: string;
  startedAtIso: string;
  startTokenIndex: number;
  sections: readonly string[];
  checkpoints: readonly TakeCheckpointInput[];
  automaticRetakes: number;
  /** Mean alignment confidence over the pass; null when it saw no snapshots. */
  confidenceMean: number | null;
  /** True for the pass currently being performed. */
  open: boolean;
}> {
  return sessionTakes.map((take) => ({
    passOrdinal: take.passOrdinal,
    takePassId: take.takePassId,
    startedAtIso: take.startedAtIso,
    startTokenIndex: take.startTokenIndex,
    sections: take.sections,
    checkpoints: take.checkpoints,
    automaticRetakes: take.automaticRetakes,
    confidenceMean: takeConfidenceMean(take),
    open: take === activeTake,
  }));
}

/** §36.3 confidence summary. Null, never 0, when the pass saw no snapshots. */
function takeConfidenceMean(take: ActiveTake): number | null {
  if (take.confidenceSamples === 0) return null;
  return take.confidenceSum / take.confidenceSamples;
}

/**
 * Note a position worth returning to. Times are measured from the START OF THE
 * TAKE on the monotonic clock: a checkpoint at "02:14 into take 3" survives an
 * NTP step, and a wall-clock timestamp would not.
 */
function noteCheckpoint(kind: TakeCheckpointInput['kind']): void {
  const take = activeTake;
  if (take === null) return;
  if (take.checkpoints.length >= MAX_TAKE_CHECKPOINTS) return;
  const snapshot = get(state).snapshot;
  take.checkpoints.push({
    atMs: Math.max(0, Math.round(monotonicNowMs() - take.startedAtMs)),
    tokenIndex: snapshot?.tokenIndex ?? take.startTokenIndex,
    ...(snapshot?.blockId ? { blockId: snapshot.blockId } : {}),
    ...(snapshot?.sentenceId ? { sentenceId: snapshot.sentenceId } : {}),
    kind,
  });
}

/**
 * Close the open take and persist it. Best-effort by construction: a take
 * history that cannot be written must never interrupt a take or block a stop.
 */
function finishTake(sessionId: string | null, endTokenIndex: number | undefined): void {
  const take = activeTake;
  activeTake = null;
  if (take === null || sessionId === null) return;
  const durationMs = Math.max(0, Math.round(monotonicNowMs() - take.startedAtMs));
  const confidenceMean = takeConfidenceMean(take);
  void recordSessionTake(sessionId, {
    takePassId: take.takePassId,
    passOrdinal: take.passOrdinal,
    startedAt: take.startedAtIso,
    endedAt: new Date().toISOString(),
    durationMs,
    startTokenIndex: take.startTokenIndex,
    ...(endTokenIndex === undefined ? {} : { endTokenIndex }),
    sections: [...take.sections],
    checkpoints: [...take.checkpoints],
    automaticRetakes: take.automaticRetakes,
    ...(confidenceMean === null ? {} : { confidenceMean }),
  }).catch(() => {
    // §36.3 is history, not state. Losing a row costs a line in the review
    // screen; failing the stop path would cost the take.
  });
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

/**
 * §28.4. The saved local voice-detection sensitivity, or the neutral midpoint
 * when settings are unavailable (browser dev, tests). Never an extreme: an
 * unreadable setting must not silently become the most aggressive VAD on offer.
 */
function currentVadSensitivity(): number {
  try {
    const value = getSettingsSnapshot().audio?.vadSensitivity;
    return typeof value === 'number' && Number.isFinite(value) ? value : 0.5;
  } catch {
    return 0.5;
  }
}

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
       * §62. A stage-layout failure has its own event, so this is the whole
       * handler: the stage held its motion, and the operator — who is at this
       * window, not at the stage — has to see it and be offered the rebuild.
       *
       * An EMPTY `issues` list is the recovery: a later rebuild succeeded. It
       * matters that this exists. The notice it clears is the most serious one
       * the Live screen can show (motion is held), so a stage that recovered
       * silently would leave the operator staring at a red banner for a
       * problem that is over, and eventually ignoring the banner.
       */
      listen<StageLayoutErrorPayload>(STAGE_EVENT.layoutFailed, (event) => {
        if (event.payload.stageGeneration !== generation) return;
        const issues = event.payload.issues ?? [];
        if (issues.length === 0) smoothFollow.reportLineMapRebuilt(event.payload.layoutGeneration);
        else smoothFollow.reportLineMapInvalid(issues.join(', '));
      }),
      /*
       * `stage://error` carries Listener media faults (Rust relays the stage's
       * `media-error` onto it verbatim) and the window layer's own errors.
       *
       * B2: this handler used to test every payload against
       * /layout|line[-_ ]?map/ and RETURN on anything that did not match — so
       * a Listener that failed to decode was reported by the stage, relayed by
       * Rust, and thrown away on arrival. The operator's only signal was a
       * frozen human face on camera behind their script.
       *
       * That substring sniff is gone rather than merely demoted: layout
       * failures now arrive above, typed, generation-checked, and with a
       * recovery signal, so nothing on this channel is a §62 report any more.
       *
       * S7: "not this handler's business" is how the channel came to be wrong
       * twice. A Listener health payload is identified by its `status` and
       * handled; EVERYTHING ELSE on this channel is a window-layer error and is
       * now surfaced, whatever its code. There is no `return` that discards a
       * payload, because both defects here were a `return` that discarded one.
       */
      listen<StageErrorPayload>(CONTROL_EVENT.stageError, (event) => {
        if (event.payload.stageGeneration !== generation) return;
        const health = asListenerHealth(event.payload);
        if (health !== null) handleListenerHealth(health);
        else handleStageWindowError(event.payload);
      }),
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
 * Window-layer failures on `stage://error` (§52.7)
 * ------------------------------------------------------------------------- */

/**
 * Everything that arrives on `stage://error`, both producers together.
 *
 * The Listener half (`status`, `clipId`) is Rust relaying the stage's
 * `stage://media-error` verbatim; the window half (`code`, `message`, the two
 * fingerprints) is `windows/mod.rs` reporting on the stage window itself. They
 * are told apart by `status`, never by `code` — see `asListenerHealth`.
 */
interface StageErrorPayload {
  stageGeneration: number;
  code?: string;
  message?: string;
  status?: string;
  requestedFingerprint?: string;
  actualFingerprint?: string;
}

const STAGE_DISPLAY_MISMATCH = 'STAGE_DISPLAY_MISMATCH';

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Surface a window-layer failure rather than dropping it.
 *
 * The failure this exists for is the stage opening on the wrong physical
 * display. Rust verifies the monitor after the window is shown (§52.7) and says
 * so; until now control received that and threw it away, so the operator's only
 * signal that their script was prompting at the wrong wall was looking at the
 * wrong wall.
 *
 * A code with no local knowledge still becomes a notice — a channel that
 * discards what it does not recognise is how this handler was wrong twice.
 */
function handleStageWindowError(payload: StageErrorPayload): void {
  const code = optionalString(payload.code) ?? 'STAGE_WINDOW_ERROR';
  const message =
    optionalString(payload.message) ??
    (code === STAGE_DISPLAY_MISMATCH
      ? 'The stage opened on a different display than the one selected.'
      : 'The stage window reported a problem.');
  reportStageWindowFault({
    code,
    message,
    requestedFingerprint: optionalString(payload.requestedFingerprint),
    actualFingerprint: optionalString(payload.actualFingerprint),
  });
}

/**
 * Raise the §52.7 notice.
 *
 * Exported because the mismatch is also detectable from the value
 * `set_stage_fullscreen` RETURNS, and that path matters more than the event
 * does: `windows::set_stage_fullscreen` emits during Preflight's start
 * sequence, one step before `startLiveSession` installs the stage bridge, so
 * control is not listening yet and the event is lost. The handler above keeps
 * the channel honest for every later re-assert; Preflight uses this directly.
 */
export function reportStageWindowFault(fault: {
  code: string;
  message: string;
  requestedFingerprint?: string | null;
  actualFingerprint?: string | null;
}): void {
  state.update((s) => ({
    ...s,
    stageWindowFault: {
      code: fault.code,
      message: fault.message,
      requestedFingerprint: fault.requestedFingerprint ?? null,
      actualFingerprint: fault.actualFingerprint ?? null,
      atMs: Date.now(),
    },
  }));
  showToast(fault.message, 'danger');
}

/** The operator has seen it; the notice is not a modal and does not nag. */
export function dismissStageWindowFault(): void {
  state.update((s) => (s.stageWindowFault === null ? s : { ...s, stageWindowFault: null }));
}

/**
 * "Which panel is display 2?" — answered on the panels themselves.
 *
 * This is the affordance the notice needs: a numbered, always-on-top,
 * click-through card on every connected display (`identify.html`, spec §52.4).
 * The picker in Preflight labels its tiles with the same numbers, so the
 * operator can go back and choose the right one for the next take.
 */
export async function identifyStageDisplays(): Promise<void> {
  try {
    await stageService.identifyDisplays();
  } catch (err) {
    showToast(`Could not number the displays. ${describeError(err)}`, 'danger');
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
    showToast(`Could not pause cleanly. ${describeError(err)}`, 'danger');
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
      showToast(`Could not resume voice following. ${describeError(err)}`, 'danger');
    });
}

/**
 * §28.2 — is a mid-session input change possible right now?
 *
 * False in manual/fixed takes and in browser dev, where there is no transport
 * to replace a track on. The Live screen uses this to decide whether to offer
 * the picker at all: an affordance that cannot work is worse than none.
 */
export function canSwitchMicrophone(): boolean {
  return pipeline !== null;
}

/**
 * §28.2 mid-session microphone switch — the recovery for `MIC_DEVICE_LOST`.
 *
 * The transport has always been able to replace its sender track without a
 * renegotiation; nothing in production ever called it, so the device-lost
 * toast pointed at a control that did not exist. This is that call site.
 *
 * Resolves `true` when the take is following the new input again. On failure
 * the session is left exactly as it was — still held, still saying so — and
 * the reason is shown, because a switch that silently does nothing is the
 * worst possible answer to "my microphone died".
 */
export async function switchMicrophone(deviceId: string): Promise<boolean> {
  if (!pipeline || deviceId === '') return false;
  try {
    await pipeline.switchMicrophone(deviceId);
  } catch (err) {
    showToast(`Could not switch to that microphone. ${describeError(err)}`, 'danger');
    return false;
  }
  coaching?.setMicrophoneDisconnected(false);
  state.update((s) => ({ ...s, micState: 'live', inputDeviceLost: false }));
  // §28.1: remember the choice, so the next take opens the input that worked
  // rather than the one that just vanished.
  void patchSettings('audio', { preferredDeviceId: deviceId }).catch(() => {
    /* a remembered preference is a convenience, never a gate */
  });
  showToast('Microphone switched. Voice following has resumed.', 'success');
  return true;
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
  // §36.3: an outline jump is a position the operator deliberately went to, and
  // "where did I skip to" is half of what a take history is for.
  noteCheckpoint('manual');
  state.update((s) => ({ ...s, counts: { ...s.counts, jumps: s.counts.jumps + 1 } }));
}

/**
 * §15.2 retake. This is also the §36.3 take boundary: the pass that was being
 * performed is over, and the next one starts here. Closing it first means the
 * completed take is written with its own times, sections and checkpoints rather
 * than being merged into whatever follows.
 */
export function restartParagraph(): void {
  invalidateSemantics();
  driver?.restartParagraph();
  const before = get(state);
  noteCheckpoint('paragraph_start');
  finishTake(before.sessionId, before.snapshot?.tokenIndex);
  if (before.sessionId !== null) {
    const passOrdinal = before.counts.retakes + 2;
    beginTake(before.sessionId, passOrdinal, before.snapshot?.tokenIndex ?? 0);
    // §11.3. The coaching lane's pass advances with the take history's, from
    // the one ordinal — otherwise the rail keeps counting the take the
    // presenter just discarded, and the filler tile shows a number belonging
    // to two takes at once.
    coaching?.beginTakePass(passOrdinal);
  }
  state.update((s) => ({ ...s, counts: { ...s.counts, retakes: s.counts.retakes + 1 } }));
}

/**
 * The "mark this" voice command (§36.3). It used to increment the command
 * counter and store no marker whatsoever, which made it the one voice command
 * whose entire effect was invisible.
 */
export function addTakeMarker(): void {
  noteCheckpoint('take');
  state.update((s) => ({ ...s, counts: { ...s.counts, commands: s.counts.commands + 1 } }));
}

/**
 * "Blank the screen" (§16.6) — from the Live transport or the voice command.
 *
 * WHAT THE USER DECIDES, AND WHAT THEY DO NOT.
 *
 * Blanking always hides the SCRIPT; that is what the word means and it is not
 * configurable. Whether it also hides the Listener is `keepListener` on the
 * directive, and it was hard-coded `false` here, which made one of the two
 * ordinary reasons to blank work and the other not: clearing a script off a
 * screen someone else can see wants the face gone with it, while blanking
 * between takes on a rig where the Listener is what the presenter looks at
 * wants the face to stay. So it is read from the §37 Listener defaults. The
 * directive is still the only carrier of the decision — the setting is where
 * its default comes from, not a second mechanism.
 *
 * The Listener is NOT frozen on a pause, and there is no setting for that. A
 * pause is a sip of water, and a listening loop that keeps breathing through
 * one is the whole point of the feature; a face that stops dead mid-blink is
 * uncanny in a way an idle loop never is, and the presenter is the only person
 * who would see it. The stage still freezes the loop where freezing is the
 * honest report — a `freeze` directive and the §43.5 control-loss watchdog —
 * and neither of those is a preference. This is why `softPause` / `hardPause`
 * were deleted from `settings::ListenerSettings` rather than wired up.
 */
export function toggleBlankStage(): void {
  const s = get(state);
  // Nothing to blank once the stage window is gone (§62).
  if (!s.stageAlive) return;
  const blanked = !s.stageBlanked;
  sendDirective({ kind: 'blank', blanked, keepListener: currentKeepListenerWhenBlanked() });
  state.update((prev) => ({ ...prev, stageBlanked: blanked }));
}

/**
 * §37.4. The saved "keep the Listener when the stage is blanked" default, or
 * `false` when settings are unavailable (browser dev, tests) — the behaviour
 * that shipped, and the safer of the two: an unreadable setting must not leave
 * a face on a screen the operator believes they just cleared.
 */
function currentKeepListenerWhenBlanked(): boolean {
  try {
    return getSettingsSnapshot().listeners?.keepWhenBlanked === true;
  } catch {
    return false;
  }
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
  // §7.5: the rail inherits the same mirror boundary as the script, so it must
  // learn the new mirror state too — it flips through its own snapshot, not the
  // stage transform, because it is inside the mirror plane but the boundary is
  // decided on the control side.
  coaching?.setDisplayState({
    mirrored: stageSettings.mirrorX === true || stageSettings.mirrorY === true,
  });
}

/**
 * §27. Show or hide the Coaching Rail's contents. Toggled by the Live-screen
 * button and by the "show me my stats" voice command (`set_coaching_rail`).
 *
 * Hiding NEVER reflows the script: the reserved band stays and only the
 * contents fade (§7.1). When coaching is `off` there is no rail to toggle, so
 * this is a no-op. Pass a boolean to force a state, or omit to flip.
 */
export function setCoachingRailVisible(visible?: boolean): boolean {
  const s = get(state);
  if (!s.coachingActive || coaching === null) return false;
  const next = visible ?? !s.coachRailVisible;
  coaching.setDisplayState({ visible: next });
  state.update((prev) => ({ ...prev, coachRailVisible: next }));
  return next;
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
    case 'set_coaching_rail': {
      // §27: "show me my stats". Toggle when the command omits an explicit
      // target, otherwise honour it. A no-op when coaching is off; report that
      // as not-executed so the caller does not acknowledge a phantom action.
      if (!s.coachingActive) return false;
      setCoachingRailVisible(action.visible);
      return true;
    }
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
    wordsHeard,
    wordsFollowed: s.snapshot?.committedTokenIndex ?? s.snapshot?.tokenIndex ?? 0,
    scriptWords: scriptWordCount,
  };
  // §36.2 + §36.1: write the retained tail and close the record BEFORE the
  // teardown resets `transcriptRetained`. `stopInternals` is what runs on every
  // abnormal path too, so the ordering here is the only thing that guarantees
  // the last few seconds of a take are not silently dropped.
  if (s.sessionId) {
    flushTranscript(s.sessionId, true);
    // §36.3: close the take that was running. Before the session row is closed,
    // so a listener reading the history the moment the session ends sees the
    // last take rather than a session with one pass missing.
    finishTake(s.sessionId, s.snapshot?.tokenIndex);
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
    wordsHeard: 0,
    wordsFollowed: 0,
    scriptWords: scriptWordCount,
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
  // The coaching subsystem is take-scoped like the sidecar: end the take so the
  // last seconds are measured and the glass is cleared, then dispose the graph
  // (which drops the retained PCM with the capture, §12.6). Fire-and-forget —
  // teardown must not block the session stop.
  if (coaching) {
    const c = coaching;
    coaching = null;
    try {
      c.endTake('take_end');
    } catch {
      /* §5.2 */
    }
    void c.dispose().catch(() => {});
  }
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
  // §36.3: `stopSession` closes the open take first, so anything still here got
  // past the normal stop path and belongs to a session that is already gone.
  activeTake = null;
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

const PAUSED_LISTENING_LABEL = 'Paused — still listening for “CandidCue, resume”';
/** No microphone in this take, so nothing is listening for a wake word. */
const PAUSED_MANUAL_LABEL = 'Paused — the script stays where it is';

/**
 * F.11 status line for the top bar and tracking visualization.
 *
 * Every connection/microphone clause here is gated on the take actually HAVING
 * a realtime transport. Only a voice take constructs the pipeline, so in a
 * manual or fixed-speed take `connection` and `micState` never move off their
 * optimistic `initial` values — and this line was reporting a microphone that
 * was never opened and a wake word that nothing is listening for.
 */
export const liveStatusLabel = derived(state, (s): string => {
  if (!s.active) return s.summary ? 'Session complete' : 'Ready to start';
  const voice = s.mode === 'voice';
  if (voice) {
    if (s.connection === 'offline') return 'Disconnected — voice following has stopped';
    if (s.connection === 'reconnecting') return 'Reconnecting — position held';
    if (s.micState === 'disconnected') return 'Microphone disconnected — position held';
  }
  if (s.paused === 'hard') return voice ? 'Hard paused — microphone off' : 'Paused';
  if (s.paused === 'listening') return voice ? PAUSED_LISTENING_LABEL : PAUSED_MANUAL_LABEL;
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
      return voice ? PAUSED_LISTENING_LABEL : PAUSED_MANUAL_LABEL;
    case 'reconnecting':
      return 'Reconnecting — position held';
    default:
      return voice ? 'Listening' : 'Prompting';
  }
});
