/**
 * Live session store (spec §15, §45.2 RealtimeStore/TrackingStore facade for
 * the Live screen). Owns session identity, the alignment feed, the realtime
 * voice pipeline, §15.3 pause semantics, the elapsed clock, the transcript
 * tail, stage heartbeats (§43.5), and the F.17 summary.
 *
 * Note what this store no longer does: it does not carry motion to the stage.
 * The alignment engine publishes snapshots to the stage directly from Rust, so
 * control is out of the motion path entirely and receives its own copy purely
 * to report on. A take summary built here can therefore never disagree with
 * what the presenter saw — both are derived from the same published snapshots.
 */
import { derived, get, writable } from 'svelte/store';
import type {
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
  TranscriptionConfig,
} from '../../shared/contracts';
import { STAGE_EVENT, CONTROL_EVENT } from '../../shared/contracts';
import type {
  AlignmentSnapshot,
  StageTranscriptTapPayload,
  StageVoicePillPayload,
} from '../../shared/contracts';
import {
  initialVoicePillState,
  reduceVoicePillLevel,
  reduceVoicePillText,
  tickVoicePill,
  voicePillView,
  type VoicePillState,
} from '../services/audio/voice-pill';
import type { FollowingSettings, SessionMode } from '../services/settings-types';
import { createTrackingDriver, newSessionId, type TrackingDriver } from '../services/session';
import { VoiceSessionPipeline } from '../services/voice-session';
import { isTauriRuntime } from '../services/ipc';
import { describeError, errorCode } from '../services/errors';
import { trace } from '../services/audio-trace';
import * as stageService from '../services/stage';
import { monotonicNowMs, subscribeStageMotionAcks } from '../services/stage-acks';
import { FIRST_TAKE_PASS_ORDINAL, takePassIdFor } from '../../shared/take-pass';
import type { MediaStreamLike } from '../services/audio';
import {
  appendSessionTranscript,
  endSessionRecord,
  recordSessionTake,
  type TakeCheckpointInput,
} from '../services/session-records';
import { defaultFollowingSettings } from '../lib/follow-profiles';
import { configureFollowActions, smoothFollow } from './smooth-follow';
import { getSettingsSnapshot, patchSettings } from './settings';
import { clearConditionToasts, showToast } from './toasts';

/**
 * Lost audio is worth interrupting for — words were said and will never be
 * followed, and unlike a hold there is no status line that can express it
 * after the fact. Keyed so a stalling connection reports once rather than
 * once per stall, and cleared with the take.
 */
const TOAST_AUDIO_DROPPED = 'audio-dropped';
/** §64: the stage is receiving snapshots and not applying them. */
const TOAST_STAGE_NOT_APPLYING = 'stage-not-applying';
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

export interface SessionCounts {
  jumps: number;
  retakes: number;
  reconnects: number;
}

export interface SessionSummary {
  durationSeconds: number;
  mode: SessionMode;
  sectionsReached: number;
  retakes: number;
  reconnects: number;
  endingLocation: string;
  /**
   * §36.2. Was hard-coded `false` because nothing ever opened a session record,
   * so no transcript could be saved under any setting. It now reports what Rust
   * decided at session start.
   */
  transcriptSaved: boolean;
  /**
   * Words the recogniser FINALISED this take. Zero means nothing was heard.
   *
   * Finals only, and the summary is taken before `endTurn` closes the last
   * utterance — so on a continuous read this undercounts, sometimes badly.
   * `wordsInFlight` carries what was still open, which is the difference
   * between "the microphone failed" and "you had not stopped talking".
   */
  wordsHeard: number;
  /** Words in the utterance still open when the take ended. */
  wordsInFlight: number;
  /** How far the cursor actually got, in script words. */
  wordsFollowed: number;
  /** Script length, so `wordsFollowed` has something to be a fraction of. */
  scriptWords: number;
  /**
   * Position updates SENT to the stage, and the number it reported applying.
   *
   * The two numbers above are both measured on the control side, and they
   * agreed perfectly through a take where the script never moved: the aligner
   * followed nine words, control counted nine words, and the glass sat still.
   * Nothing on this card could distinguish "the aligner lost you" from "the
   * aligner followed you and the stage discarded every update", which are
   * unrelated faults with one symptom.
   *
   * `stageApplied` is null when the stage never reported — a browser-dev
   * session, or one that ended before the first heartbeat ack came back — and
   * that is stated rather than shown as zero, which would read as a fault.
   */
  updatesSent: number;
  stageApplied: number | null;
  /**
   * How far the document actually travelled on the glass, in CSS pixels, and
   * how far the motion controller was aiming to travel. Null when the stage
   * never reported a frame.
   *
   * These are the only numbers in the summary measured on the STAGE. Everything
   * else is control's own bookkeeping, which is why a take could report perfect
   * health along every row and still never have moved a pixel.
   */
  documentTravelPx: number | null;
  targetTravelPx: number | null;
  /**
   * Recogniser text control was handed, and how much of it reached the stage.
   *
   * The stage's transcript bar is the instrument that answers "is it hearing
   * me", and it read "listening — no words yet" through a take that heard
   * eleven words. Four separate guards in `publishTranscriptTap` can drop the
   * text before it is emitted, all silently, and an emitted tap with empty text
   * looks identical on the glass to one that was never sent. These three
   * numbers separate all of it: seen but not emitted is control's fault and
   * `transcriptTapFault` names which guard; emitted but not shown is the
   * stage's.
   */
  transcriptTapsSeen: number;
  transcriptTapsEmitted: number;
  transcriptTapFault: string | null;
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
  /** §40.5 Listener media failure awaiting (or after) a recovery choice. */
  listenerFault: ListenerFault | null;
  /**
   * §52.7 window-layer failure — the stage on the wrong display, or any other
   * code the window layer reports. Null until something goes wrong, and
   * dismissable: unlike the Listener fault there is no in-session repair, only
   * "now you know, and here is how to see which panel is which".
   */
  stageWindowFault: StageWindowFault | null;
  snapshot: AlignmentSnapshot | null;
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
  listenerFault: null,
  stageWindowFault: null,
  snapshot: null,
  transcriptTail: [],
  outline: [],
  sentences: [],
  counts: { jumps: 0, retakes: 0, reconnects: 0 },
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
 * Not `stageGeneration`: that counts stage *windows*, while this counts
 * *line-map rebuilds* inside one window. Motion no longer travels through
 * control, so nothing here stamps it onto a payload any more — it is kept
 * because acks are the one channel carrying the stage's own number, and the
 * §62 recovery UI needs to know which geometry the stage believes it has.
 */
let stageLayoutGeneration = 0;
/**
 * Monotonic token for the stage bridge. `listen()` resolves asynchronously, so
 * a stop/restart that happens before it settles must be able to prove that the
 * arriving unlisteners belong to a dead session — otherwise they are installed
 * with no disposer and keep firing into the NEXT session.
 */
let stageBridgeToken = 0;
/** The realtime model whose published rate the cost estimate uses. */

/* Smooth-following state (companion §50.1). Fed by the alignment snapshots
 * the stage's own motion reports — see services/stage-acks.ts. */
/**
 * Session-clock origin for the §26.1 bridge, on the MONOTONIC clock.
 *
 * This is not `startedAtMs` in the store (which is wall time, for display). A
 * frame's `sessionTimeMs` is what the stage measures evidence age against, and
 * `Date.now()` moves: an NTP step backward mid-take inflates every subsequent
 * age and pushes the predictor past its horizon into decay for no reason.
 */
let sessionStartedAtMs = 0;
let followProfileId = defaultFollowingSettings().motionProfileId;
let scriptCompileHash = '';
let stopMotionAcks: (() => void) | null = null;
let stopSidecarFeed: (() => void) | null = null;

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
   * §36.3 automatic retake transitions — the engine deciding the presenter went
   * back and re-read. Distinct from a MANUAL retake, which opens a new pass and
   * so is a row of its own rather than a counter.
   */
  automaticRetakes: number;
  /**
   * Accepted relocations — a skipped section or a jump the engine caught up to.
   * Counted apart from retakes because they say opposite things about a take:
   * a retake is the presenter redoing something, a relocation is the engine
   * finding them somewhere else.
   */
  relocations: number;
  /**
   * §36.3 unique coverage: the furthest the CONFIRMED anchor ever reached.
   *
   * A high-water mark rather than the last position, which is what makes this
   * honest — jumping to the closing line does not retroactively cover the
   * middle, and going back for a retake does not un-cover what was already
   * read.
   */
  maxConfirmedToken: number;
  /** §36.3 availability: milliseconds spent in `following`. */
  followingMs: number;
  /** Wall time of the previous snapshot, for accumulating `followingMs`. */
  lastSnapshotAtMs: number | null;
  lastState: AlignmentSnapshot['state'] | null;
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
 * How often the buffered transcript is written.
 *
 * Purely batching now. There used to be a four-second settle delay as well,
 * because the command router decided a beat later whether a finalized item was
 * script or a command phrase, and `INSERT OR IGNORE` on
 * `UNIQUE(session_id, commit_sequence)` means the first write of a commit is
 * the one that sticks. With no command channel every item is script the moment
 * it arrives, so there is nothing left to wait for.
 */
const TRANSCRIPT_FLUSH_INTERVAL_MS = 15000;


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
   * number, and the persisted take row has a `scriptRevision` field
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
  // §64: both ends of the apply comparison are per-session. `seq` restarts with
  // the engine, so a count carried across takes would read as a huge backlog on
  // the first beat of the next one.
  lastSnapshotSeq = 0;
  stageAppliedRevision = null;
  scrollSeenMinPx = Number.POSITIVE_INFINITY;
  scrollSeenMaxPx = Number.NEGATIVE_INFINITY;
  targetSeenMinPx = Number.POSITIVE_INFINITY;
  targetSeenMaxPx = Number.NEGATIVE_INFINITY;
  stageApplyDivergedAtMs = null;
  stageApplyReported = false;
  scriptWordCount = input.totalTokens;
  stageSettings = input.stageSettings ?? null;
  listenerSelection = input.listener ?? null;
  listenerVisible = listenerSelection !== null;
  listenerRetiredForSession = false;
  failedClipIds = [];
  heartbeatRevision = 0;
  resetTranscriptTap();
  sessionStartedAtMs = monotonicNowMs();
  scriptCompileHash = input.compiled?.sourceHash ?? '';
  // §60: evidence never crosses a take boundary. A fresh watcher is cheaper and
  // more obviously correct than resetting one, and it is the same lifetime as
  // every other take-scoped detector in this store.
  // §36.3: the session's first take opens with it, on a fresh history.
  sessionTakes = [];
  beginTake(sessionId, 1, 0);

  // Smooth-following store (§50.1): user-visible following state + §48 actions.
  const following = input.following ?? currentFollowingSettings();
  followProfileId = following.motionProfileId;
  smoothFollow.beginSession(sessionId, following);
  configureFollowActions(followActions);
  smoothFollow.reportTranscriptStatus(input.mode === 'voice' ? 'live' : 'idle');

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
  // Voice mode without a Tauri runtime has no Rust to align in — keep the
  // animated mock driver so browser dev stays demonstrable.
  const useRealDriver = Boolean(input.compiled) && (isTauriRuntime() || input.mode !== 'voice');
  driver = createTrackingDriver({
    sessionId,
    scriptId: input.scriptId,
    sentences: input.compiled?.sentences ?? input.sentences,
    totalTokens: input.totalTokens,
    compiled: useRealDriver ? (input.compiled ?? null) : null,
    sessionGeneration,
    onSnapshot: handleSnapshot,
    onTranscript(line) {
      pushTranscriptLine(line);
    },
  });

  /*
   * Starting a take IS starting to prompt.
   *
   * The worker driver pauses the aligner the instant it is built — §9.1, "hold
   * position until the user explicitly starts prompting" — and a paused engine
   * discards every transcript event before it looks at a token. Nothing on the
   * take path ever resumed it. Only the `Start` button in the Live transport
   * bar did, and a presenter who has just pressed `Present`, watched the stage
   * open and begun speaking has no reason to believe a second, differently
   * named button stands between them and a teleprompter that follows.
   *
   * What that cost: the microphone recorded, the provider transcribed, the
   * ledger filled, "Words heard: 26" counted up — and every one of those words
   * was dropped on the floor. "0 of 26 words (0%)", four takes running, with a
   * summary card that showed the evidence and the result side by side and no
   * hint of what sat between them.
   *
   * The explicit start survives as `Pause`, which is the control a presenter
   * actually reaches for. `Present` is the start.
   */
  startPrompting();

  // Voice pipeline: realtime transcription + command routing (§29, §33).
  if (input.mode === 'voice' && input.compiled && isTauriRuntime()) {
    // Before the pipeline, so the first level frame it produces has somewhere
    // to land and the pill is on the stage while the device is being acquired.
    // The epoch is captured here and checked in every callback below: a
    // superseded pipeline is torn down asynchronously and can still deliver.
    const pillEpoch = startVoicePill();
    pipeline = new VoiceSessionPipeline({
      sessionId,
      sessionGeneration,
      compiled: input.compiled,
      ...(input.transcription?.language !== undefined
        ? { language: input.transcription.language }
        : {}),
      ...(input.transcription?.model !== undefined ? { modelId: input.transcription.model } : {}),
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
        resetTranscriptTap();
      },
      /*
       * The pill's waveform, from the ONE capture the take already owns (§5.3).
       * A second `getUserMedia` for an indicator would contend with the take's
       * own stream — see `services/audio/ownership.ts` for what that costs.
       */
      onLevel: (snapshot) => {
        if (voicePill === null || pillEpoch !== voicePillEpoch) return;
        voicePill = reduceVoicePillLevel(voicePill, snapshot, snapshot.generatedAtMs);
      },
      /*
       * The device is about to be asked for. The pill's "no audio" window runs
       * from HERE rather than from the take's first instant, because everything
       * before this line — the §29.2 gate, the permission check, the socket
       * subscription — is time in which no capture has been attempted, and a
       * cross that means "we have not asked yet" is a lie about the microphone.
       */
      onCaptureAttempt: () => {
        if (voicePill === null || pillEpoch !== voicePillEpoch) return;
        voicePill = { ...voicePill, startedAtMs: monotonicNowMs(), lastFrameAtMs: null };
      },
      onTranscriptText: (text, final) => {
        // The stage's transcript bar reads from here — straight off the wire,
        // before anything interprets it — so it stays honest when alignment is
        // wrong.
        publishTranscriptTap(text, final);
        // Words coming back is the only evidence that the whole chain works,
        // and it is what turns the pill's dot into a tick. Epoch-checked: a
        // late partial from a superseded transport must not certify this take.
        if (voicePill !== null && pillEpoch === voicePillEpoch) {
          voicePill = reduceVoicePillText(voicePill, text);
        }
        /*
         * The open utterance counts too — as an ESTIMATE, separately.
         *
         * `wordsHeard` totals finals only, and the summary is snapshotted
         * before `endTurn` gets the last one back: Rust's stop returns
         * immediately and finalises in the background for up to 2.5 s. So a
         * presenter who reads for fourteen seconds without a long enough pause
         * to close an utterance is told "Words heard: 11" for a passage the
         * recogniser heard in full, and reasonably concludes the microphone is
         * failing. The display, which follows PARTIAL evidence, moves the whole
         * time — and the two facts flatly contradict each other on one card.
         *
         * Kept as its own number rather than folded into `wordsHeard`: a
         * partial is a restatement and may be revised or withdrawn, so adding
         * it to a total of committed words would make that total wrong in the
         * other direction. This is "and this much more was in flight".
         */
        if (!final) {
          wordsInFlight = countSpokenWords(text);
        }
        if (final) {
          wordsInFlight = 0;
          // §36 "did it hear me". Counted here rather than from the retained
          // transcript, because retention is a SETTING and the question this
          // answers — was anything transcribed at all — has to be answerable
          // with retention off, which is the default.
          wordsHeard += countSpokenWords(text);
        }
      },
      /*
       * Audio that never reached the recogniser. Surfaced rather than counted
       * silently: dropped frames and a presenter who said nothing are
       * indistinguishable downstream, and "words heard: 0" with no explanation
       * is the exact failure this app has shipped twice.
       */
      onAudioDropped: (frames) => {
        showToast(
          `The connection stalled and ${frames} ${frames === 1 ? 'moment' : 'moments'} of audio ` +
            'did not reach the transcriber. Anything said in that gap will not be followed.',
          'danger',
          { key: TOAST_AUDIO_DROPPED },
        );
      },
      // §36.2: finalized text only, never audio. Buffered here and written
      // through `append_session_transcript`, which Rust refuses outright when
      // the session was opened with retention off.
      onTranscriptItem: (item) => bufferTranscriptItem(item),
      onTranscriptLine: (line) => pushTranscriptLine(line),
      onConnectionState: (connection) => {
        /*
         * A superseded pipeline may not speak for the current take.
         *
         * `stopInternals` does not await `pipeline.stop()`, and stopping is
         * what drives a pipeline to `offline` — so take A's teardown lands
         * after take B has connected and hands B a connection state belonging
         * to a session that no longer exists. On the Live screen that is a
         * status pill lying; on the stage it is a permanent "Not connected"
         * cross over a take that is working perfectly, because the pill reads
         * this same field.
         */
        if (pillEpoch !== voicePillEpoch) return;
        state.update((s) => {
          /*
           * A reconnect is a connection RE-established, not the first one.
           *
           * The store initialises `connection: 'connected'` — an optimistic
           * placeholder, since nothing has connected yet — and the pipeline
           * announces `reconnecting` on its way to opening the very first
           * socket. That transition satisfied the test below, so EVERY healthy
           * take reported exactly one reconnect, from its first second, having
           * lost nothing.
           *
           * It cost more than a wrong number. "Reconnects: 1" appeared on every
           * summary of a take that was not working and was read, repeatedly, as
           * evidence of a transport dropping mid-session — sending two people
           * hunting a fault that had never happened while the real one sat
           * elsewhere on the same card. A diagnostic that cries wolf on every
           * healthy run is worse than no diagnostic.
           *
           * So it counts only a return to `reconnecting` AFTER something has
           * actually connected. A genuine mid-take reconnect still reads 1.
           */
          const reconnects =
            connection === 'reconnecting' && s.connection === 'connected' && everConnected
              ? s.counts.reconnects + 1
              : s.counts.reconnects;
          return { ...s, connection, counts: { ...s.counts, reconnects } };
        });
        if (connection === 'connected') everConnected = true;
        // §59: an interrupted transcript is a first-class degraded state.
        smoothFollow.reportTranscriptStatus(
          connection === 'connected' ? 'live' : 'interrupted',
          connection === 'offline' ? 'The transcription connection is offline.' : null,
        );
      },
      // H5: transcription is untrustworthy — stop following visibly rather
      // than letting the stage drift on stale or absent speech.
      onFollowingHold: (held, reason) => {
        trace('hold', `${held ? 'held' : 'released'} — ${reason ?? 'none'}`);
        smoothFollow.setFollowingPaused(held);
        /*
         * No toast. A hold is a STATE, and the Live status line already reports
         * it — "Reconnecting — position held", "Microphone disconnected —
         * position held" — accurately and with no history.
         *
         * A notification was the wrong instrument twice over. During a take the
         * presenter is looking at the stage, full screen, with the control
         * window behind it: the toast is invisible exactly when it is relevant.
         * And because `danger` toasts never expire, an ordinary take — a few
         * pauses between sentences, one transport blip — delivered the whole
         * stack at once afterwards, describing a microphone no longer in use,
         * on the summary screen of a take that had scored 96%.
         *
         * The stage's transcript bar is the live instrument now; the status
         * line is the durable one. Neither accumulates.
         */
      },
      // H5: a dead input is not a provider problem; the user must act.
      onInputDeviceLost: (code) => {
        // §12.7: device loss outranks every acoustic reading on the mic tile.
        state.update((s) => ({ ...s, micState: 'disconnected', inputDeviceLost: true }));
        /*
         * The pill takes only the HARD half of this signal.
         *
         * `MIC_NO_SIGNAL` is the §28.6 detector reporting five seconds without
         * signal, which a presenter collecting their thoughts in a treated room
         * produces several times a take. The status bar can afford to call that
         * a disconnected input; a cross on the stage saying "No audio" cannot —
         * it is the microphone check's false accusation with a longer fuse.
         */
        if (code !== 'MIC_NO_SIGNAL' && pillEpoch === voicePillEpoch) {
          voicePillDeviceLost = true;
        }
        // §28.2/§28.6: the remedy named here is one the Live screen can
        // actually perform — `switchMicrophone` below drives the transport's
        // track replacement, and the status bar grows an input picker while
        // `micState` is 'disconnected'.
        /*
         * No toast: `micState: 'disconnected'` is what the status bar renders,
         * and it grows the input picker that fixes it. The toast said the same
         * thing in a form that expired never and appeared behind the stage.
         */
      },
      /*
       * §28.6: the input came back on its own — the mic was replugged, or the
       * track unmuted. "Reconnect it and we resume" is a promise the product
       * has to keep without being asked twice, so the pills clear themselves.
       */
      /*
       * §28.2: the chosen device was busy and the system default was opened
       * instead. Said out loud, once: a take running on the built-in
       * microphone when the user selected an interface is a take whose audio
       * is not what they think it is, and the status bar's input picker is
       * where they change it.
       */
      onInputFellBackToDefault: () => {
        showToast(
          'The microphone you chose was busy, so CandidCue is using the system default input. ' +
            'Pick another input in the status bar if that is wrong.',
          'info',
        );
      },
      onInputRestored: () => {
        if (pillEpoch === voicePillEpoch) voicePillDeviceLost = false;
        const before = get(state);
        if (!before.inputDeviceLost) return;
        state.update((s) => ({
          ...s,
          inputDeviceLost: false,
          // Only undo the loss this flag recorded; a transport that is also
          // down keeps its own honest 'disconnected'.
          micState: s.micState === 'disconnected' ? 'live' : s.micState,
        }));
        // Nothing to announce: the status line goes back to normal on its own,
        // and "the microphone is back" answers a warning we no longer give.
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
      /*
       * A take that has been superseded may not report on the one that
       * replaced it. Its start can still be in flight — the microphone retry
       * alone spends up to 1.75 s — and when it finally rejects, everything
       * below would be about a session that no longer exists: the current
       * take marked offline, a danger toast, and a cross on its voice pill,
       * all for a failure that happened to a take the operator already ended.
       */
      if (pillEpoch !== voicePillEpoch) {
        trace('start-superseded', 'a replaced take failed to start; not reported');
        return;
      }
      /*
       * `SESSION_STOPPED` is not a failure, it is this app tearing the take
       * down while its start was still in flight — a second `startLiveSession`,
       * a stop, a navigation guard. Reporting it as one produced the worst
       * possible message: "Voice tracking is unavailable. Something went wrong
       * and CandidCue has no specific advice for it", which is both alarming
       * and, for a session that no longer exists, addressed to nobody. The
       * trace still records it; the presenter is not told about the internals
       * of a take they already ended.
       */
      const code = errorCode(err);
      if (code === 'SESSION_STOPPED') {
        trace('start-abandoned', 'the session was stopped while voice was starting');
        return;
      }
      /*
       * A start that failed on the MICROPHONE must say so on the pill.
       *
       * Without this the take goes `connection: 'offline'` a moment later and
       * the pill reports "Not connected" — pointing at the network for a
       * failure that was the input device, which is the one thing the
       * presenter could have fixed. The no-capture window would eventually
       * reach the same conclusion, several seconds late and after they had
       * already gone looking at their wifi.
       */
      const micFailure = code !== null && code.startsWith('MIC_');
      if (micFailure) voicePillDeviceLost = true;
      /*
       * `micState` too, not just the connection.
       *
       * A start that rejected never opened a capture — whatever it failed on,
       * there is no microphone in this take. It stayed at its initial 'live'
       * and the status bar reported "Mic live" over a session with no input at
       * all, which is the same never-show-a-confident-state-you-do-not-have
       * defect the manual-mode pills were fixed for.
       *
       * `inputDeviceLost` is narrower on purpose: it is what offers the §28.2
       * mid-session input picker, and a picker is only an answer when the
       * DEVICE is what failed. Swapping microphones cannot fix a refused
       * credential, and offering it there is the same unfollowable instruction
       * as advice pointing at a control that does not exist.
       */
      state.update((s) => ({
        ...s,
        connection: 'offline',
        micState: 'disconnected',
        inputDeviceLost: micFailure || s.inputDeviceLost,
      }));
      showToast(`Voice tracking is unavailable. ${describeError(err)}`, 'danger');
    });
  }

  clock = setInterval(() => {
    state.update((s) => {
      if (!s.active) return s;
      const elapsedSeconds = Math.floor((Date.now() - s.startedAtMs) / 1000);
      return { ...s, elapsedSeconds };
    });
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
          'CandidCue has not finished reading this script, so the take cannot start.',
        );
      }
      const store = get(compiledStore);
      // An idle store means nobody has compiled through it this run — a test,
      // or a caller with its own compiler. The supplied script is then the only
      // authority and it has already been checked.
      if (store.status === 'idle') return;
      /*
       * A store holding a DIFFERENT script says nothing about this one.
       *
       * The editor populates this store and never clears it on the way out, so
       * after editing script A and presenting script B the store still held A.
       * Every check below then ran B's take against A's compile: A's stale
       * error, A's blocking diagnostics, and — always, since two scripts never
       * hash alike — A's source hash, which failed B with "the script changed
       * after the session was prepared". B had compiled cleanly and its stage
       * was already up; only voice tracking died, and the advice it gave named
       * a screen that no longer exists.
       *
       * This gate is a stale-EDITOR guard. It has standing over the script it
       * is looking at and none over any other.
       */
      if (store.scriptId !== null && store.scriptId !== compiledScript.scriptId) return;
      if (store.status === 'error') {
        throw new StartSequenceError('compile', store.error ?? 'CandidCue could not read this script.');
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
          'The script changed after this take was prepared. Stop and press Present again.',
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
 * Which authored block a token position falls in.
 *
 * Derived rather than reported: the engine states where the reader is, and
 * block identity is a property of the compiled document. Resolving it here
 * means the take history keeps answering "which sections did this pass reach"
 * without the engine having to know what a section is.
 */
function blockIdForToken(token: number): string | null {
  const compiled = compiledScript;
  if (!compiled) return null;
  const at = Math.round(token);
  let best: string | null = null;
  for (const sentence of compiled.sentences) {
    if (sentence.startTokenIndex <= at) best = sentence.blockId;
    else break;
  }
  return best;
}

/**
 * One alignment snapshot, as control sees it.
 *
 * ---------------------------------------------------------------------------
 * THE TAKE SUMMARY IS BUILT FROM PROGRESSION, NOT FROM A FINAL POSITION
 * ---------------------------------------------------------------------------
 * "Followed N of M words" read off the last snapshot is a number that flatters
 * every take: a presenter who lost the thread at word 30, jumped to the end and
 * read the closing line scores 100%. What is honest is what accumulates here —
 * how far the CONFIRMED anchor actually advanced, how much time was spent
 * genuinely following, and how many recoveries the engine had to make. Those
 * are three different facts and the summary reports them as three.
 */
function handleSnapshot(snapshot: AlignmentSnapshot): void {
  const nowMs = monotonicNowMs();
  // What control has been told, for the §64 comparison against what the stage
  // has actually applied. See `checkStageApplyingSnapshots`.
  if (snapshot.seq > lastSnapshotSeq) lastSnapshotSeq = snapshot.seq;
  const blockId = blockIdForToken(snapshot.confirmedToken);
  if (activeTake !== null) {
    // §36.3 sections traversed, per take. `blocksSeen` below is the same fact
    // for the whole session and has only ever been read as a count; this is
    // the per-pass list, which is what makes "take 2 never reached the close"
    // sayable.
    if (blockId && !activeTake.sections.includes(blockId)) {
      activeTake.sections.push(blockId);
    }
    // §36.3 unique coverage: the high-water mark of the conservative anchor.
    // `confirmed` is monotone except across an accepted retake or a manual
    // move, and taking the maximum is what makes a retake cost nothing it
    // already earned while still refusing to credit a jump to the end.
    if (snapshot.confirmedToken > activeTake.maxConfirmedToken) {
      activeTake.maxConfirmedToken = snapshot.confirmedToken;
    }
    if (Number.isFinite(snapshot.confidence)) {
      activeTake.confidenceSum += snapshot.confidence;
      activeTake.confidenceSamples += 1;
    }
    // §36.3 availability: time spent in `following`, accumulated between
    // snapshots. Measured rather than inferred from a state count, because
    // snapshots arrive on transcript events and a long confident passage
    // produces no more of them than a stuttering one.
    if (activeTake.lastSnapshotAtMs !== null && activeTake.lastState === 'following') {
      activeTake.followingMs += nowMs - activeTake.lastSnapshotAtMs;
    }
    activeTake.lastSnapshotAtMs = nowMs;
    activeTake.lastState = snapshot.state;
    // §36.3 recovery events, from the decision codes that describe one: the
    // engine concluded the presenter went back and re-read, or relocated. A
    // manual retake opens a new pass instead, so the two are never conflated.
    if (snapshot.decision === 'retakeAccepted') activeTake.automaticRetakes += 1;
    if (
      snapshot.decision === 'relocationAccepted' ||
      snapshot.decision === 'jumpForwardAccepted'
    ) {
      activeTake.relocations += 1;
    }
  }

  state.update((s) => ({
    ...s,
    snapshot,
    blocksSeen:
      blockId && !s.blocksSeen.includes(blockId) ? [...s.blocksSeen, blockId] : s.blocksSeen,
  }));
  smoothFollow.ingestSnapshot(snapshot);
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

/**
 * The last words the recogniser returned, for the stage's transcript bar.
 *
 * Held as a rolling word list rather than the provider's utterance text so the
 * bar keeps reading across utterance boundaries — the provider ends an
 * utterance wherever its voice-activity detector decides, which is nowhere in
 * particular, and a bar that blanked at each boundary would look like a fault.
 */
const TAP_WORDS = 14;
let tapCommitted: string[] = [];

/** §64 tap accounting — see `publishTranscriptTap`. */
/**
 * Has a socket ever reached `connected` this take?
 *
 * The store's initial `connection: 'connected'` is a placeholder, not a fact,
 * so "was connected, is now reconnecting" cannot be read off the state alone.
 */
let everConnected = false;
/** Words in the utterance still open when the take ended. See `wordsHeard`. */
let wordsInFlight = 0;
let transcriptTapsSeen = 0;
let transcriptTapsEmitted = 0;
const transcriptTapsDropped = {
  noStageGeneration: 0,
  noRuntime: 0,
  noSession: 0,
  emptyText: 0,
  /** The emit itself rejected — the channel, not a guard. */
  emitFailed: 0,
};

/** The first reason taps were dropped, or null when none were. */
function transcriptTapFault(): string | null {
  for (const [reason, count] of Object.entries(transcriptTapsDropped)) {
    if (count > 0) return reason;
  }
  return null;
}

function resetTranscriptTap(): void {
  tapCommitted = [];
  everConnected = false;
  wordsInFlight = 0;
  transcriptTapsSeen = 0;
  transcriptTapsEmitted = 0;
  transcriptTapsDropped.noStageGeneration = 0;
  transcriptTapsDropped.noRuntime = 0;
  transcriptTapsDropped.noSession = 0;
  transcriptTapsDropped.emitFailed = 0;
  transcriptTapsDropped.emptyText = 0;
}

/**
 * Publish the raw recogniser text. Partials replace the open utterance rather
 * than appending to it, for the same reason the ledger does: a partial is a
 * restatement, and appending would show every revision of a sentence at once.
 */
function publishTranscriptTap(text: string, final: boolean): void {
  /*
   * Every early return is COUNTED, not silent.
   *
   * The bar on the stage read "listening — no words yet" through a take that
   * heard eleven words, and there was no way to tell whether control had
   * declined to send them or the stage had failed to draw them. Four guards sit
   * above, any of which drops the text on the floor, and none of them said so.
   */
  transcriptTapsSeen += 1;
  if (stageGeneration === 0) {
    transcriptTapsDropped.noStageGeneration += 1;
    return;
  }
  if (!cachedEmitTo && !isTauriRuntime()) {
    transcriptTapsDropped.noRuntime += 1;
    return;
  }
  const s = get(state);
  /*
   * `stageAlive` is deliberately NOT consulted.
   *
   * It was, and that is the same mistake as gating the bar on `phase ===
   * 'live'`: a DIAGNOSTIC suppressed by a flag that is only ever wrong when
   * something has already gone wrong. `stageAlive` is set from a `stage://
   * closed` event and cleared by nothing until the next take, so any spurious
   * or mis-generationed close silently darkens the one readout that says
   * whether the recogniser is hearing anything — while alignment snapshots,
   * which travel Rust -> stage and never consult it, keep arriving. The
   * presenter is then looking at a stage that is visibly working and a
   * transcript bar that says "no words yet".
   *
   * Sending to a stage that has genuinely gone costs a rejected promise the
   * catch below already swallows. That is strictly cheaper than being unable
   * to see what the microphone is doing.
   */
  if (!s.sessionId) {
    transcriptTapsDropped.noSession += 1;
    return;
  }

  const words = text.trim().split(/\s+/).filter((word) => word.length > 0);
  const shown = [...tapCommitted, ...words].slice(-TAP_WORDS);
  if (final) tapCommitted = shown;

  const payload: StageTranscriptTapPayload = {
    stageGeneration,
    text: shown.join(' '),
    final,
    sentAtMs: Date.now(),
  };
  // An emitted tap whose TEXT is empty renders as "listening — no words yet",
  // which is indistinguishable on the glass from never having been sent.
  if (payload.text.length === 0) transcriptTapsDropped.emptyText += 1;
  /*
   * Through RUST, not straight at the stage window.
   *
   * This used to be `emitTo('stage', 'stage://transcript-tap', …)` from this
   * webview. On a real rig it delivered nothing — the bar read "listening — no
   * words yet" for an entire take while this function counted six taps sent —
   * and no amount of reading the two sides could explain why, when alignment
   * snapshots reached the same window in the same seconds and moved the
   * document to the pixel.
   *
   * The difference between them was the ROAD, not the payload: snapshots come
   * from Rust (`app.emit_to(STAGE_LABEL, …)`), and everything Rust emits
   * arrives. So the words go that way too, as a directive on the relay the
   * stage already trusts for freeze, blank, settings and calibration. It is
   * one IPC call a second against a channel with a proven delivery record,
   * and it picks up Rust's generation validation on the way past, which the
   * direct emit never had.
   *
   * Counted on RESOLUTION. Counting the attempt is what made "6 of 6 sent"
   * describe six calls rather than six deliveries, and turned a dead channel
   * into a perfect score.
   */
  void stageService
    .publishStageDirective(s.sessionId, stageGeneration, {
      kind: 'transcript',
      text: payload.text,
      final,
    })
    .then(() => {
      transcriptTapsEmitted += 1;
    })
    .catch(() => {
      transcriptTapsDropped.emitFailed += 1;
    });
}

/* ---------------------------------------------------------------------------
 * The voice pill (§29.2, and what replaced the microphone check)
 * ------------------------------------------------------------------------- */

/**
 * How often the stage is told what the pill thinks.
 *
 * A TIMER rather than a per-frame publish, and the reason is the whole point of
 * the pill: the failure worth catching is the one where level frames stop
 * arriving — the device pulled, the graph dead, another process holding the
 * input — and a publisher driven by frames would fall silent during exactly
 * that failure, leaving the last healthy-looking reading frozen on the stage.
 */
const VOICE_PILL_INTERVAL_MS = 100;

let voicePill: VoicePillState | null = null;
let voicePillTimer: ReturnType<typeof setInterval> | null = null;
/**
 * The DEVICE is gone — as opposed to the room being quiet.
 *
 * Kept here rather than read off `state.inputDeviceLost`, which is also raised
 * by `SilentInputDetector` after five seconds without signal. The pill must
 * never treat silence as a fault: a presenter thinking for five seconds in a
 * quiet room is the ordinary case, and answering it with a cross is the exact
 * behaviour the microphone check was deleted for.
 */
let voicePillDeviceLost = false;
/**
 * Which take the pill belongs to.
 *
 * Pipeline teardown is asynchronous — `stopInternals` does not await
 * `pipeline.stop()` — so a superseded pipeline can still deliver a level frame
 * or a late partial after the next take has started. Without this, take A's
 * microphone would animate take B's waveform, and a stale partial could put a
 * tick on a session that has transcribed nothing.
 */
let voicePillEpoch = 0;

/** Begin a take's pill. Torn down by `stopInternals` on every path out. */
function startVoicePill(): number {
  voicePillEpoch += 1;
  voicePillDeviceLost = false;
  if (stageGeneration === 0 || !isTauriRuntime()) return voicePillEpoch;
  voicePill = initialVoicePillState(monotonicNowMs());
  voicePillTimer ??= setInterval(publishVoicePill, VOICE_PILL_INTERVAL_MS);
  return voicePillEpoch;
}

function stopVoicePill(): void {
  voicePillEpoch += 1;
  if (voicePillTimer) clearInterval(voicePillTimer);
  voicePillTimer = null;
  voicePill = null;
  voicePillDeviceLost = false;
}

/**
 * Restart the evidence at a take boundary (§15.2 retake, §36.3 pass).
 *
 * Only when a pill is already running: a retake in manual mode has no capture
 * to report on, and starting one there would put a permanent "Listening" on a
 * stage that is not listening to anything.
 */
function resetVoicePill(): void {
  if (voicePill === null) return;
  voicePillDeviceLost = false;
  voicePill = initialVoicePillState(monotonicNowMs());
}

/**
 * Resolve the pill and send it.
 *
 * The conditions come from the session state rather than from a second set of
 * detectors: `inputDeviceLost` is §28.6's finding, already made by the pipeline
 * on the same level frames, and a pause is a pause. Re-deriving either here
 * would give the stage a chance to disagree with the Live screen about the same
 * microphone.
 */
function publishVoicePill(): void {
  if (voicePill === null || stageGeneration === 0) return;
  const s = get(state);
  // Not `stageAlive` — see `publishTranscriptTap`. The pill is the readout
  // that says whether the microphone is being heard, and a liveness flag that
  // is only ever wrong when something is already wrong must not be able to
  // switch it off.
  if (!s.sessionId) return;
  if (!cachedEmitTo && !isTauriRuntime()) return;

  const nowMs = monotonicNowMs();
  voicePill = tickVoicePill(
    voicePill,
    {
      deviceLost: voicePillDeviceLost,
      // 'reconnecting' is deliberately not a fault: it is usually over in a
      // second, and the Live status line already says so.
      transportOffline: s.connection === 'offline',
      suspended: s.paused !== 'none',
    },
    nowMs,
  );
  const view = voicePillView(voicePill, nowMs);
  const payload: StageVoicePillPayload = {
    stageGeneration,
    reading: view.reading,
    levels: view.levels,
    label: view.label,
    visible: view.visible,
    sentAtMs: Date.now(),
  };
  if (cachedEmitTo) {
    void cachedEmitTo('stage', STAGE_EVENT.voicePill, payload).catch(() => {});
    return;
  }
  void resolveEmitTo()
    .then((emitTo) => emitTo('stage', STAGE_EVENT.voicePill, payload))
    .catch(() => {});
}

/** Snapshot token positions are fractional; persisted indexes are not. */
function roundToken(token: number | undefined): number | undefined {
  return token === undefined || !Number.isFinite(token) ? undefined : Math.round(token);
}

/**
 * §36.3 "unique coverage", the honest form.
 *
 * The furthest the CONFIRMED anchor reached in this pass, not the position it
 * finished at. Reporting the final position would score a take that lost the
 * thread and jumped to the closing line as complete — which is precisely the
 * summary that made the old numbers untrustworthy.
 */
function takeWordsFollowed(): number {
  if (activeTake === null) return 0;
  return Math.max(0, Math.round(activeTake.maxConfirmedToken));
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
    relocations: 0,
    maxConfirmedToken: startTokenIndex,
    followingMs: 0,
    lastSnapshotAtMs: null,
    lastState: null,
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
  const tokenIndex = Math.round(snapshot?.confirmedToken ?? take.startTokenIndex);
  const blockId = blockIdForToken(tokenIndex);
  take.checkpoints.push({
    atMs: Math.max(0, Math.round(monotonicNowMs() - take.startedAtMs)),
    tokenIndex,
    kind,
    // "Where did I skip to" is half of what a take history is for, and a token
    // index alone does not answer it in a form anybody reads.
    ...(blockId ? { blockId } : {}),
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

/**
 * Write out everything buffered so far. `force` is retained on the signature
 * because the call sites read better for it, but every item is now ready the
 * moment it arrives — see {@link TRANSCRIPT_FLUSH_INTERVAL_MS}.
 */
function flushTranscript(sessionId: string, force: boolean): void {
  void force;
  if (!transcriptRetained || transcriptBuffer.length === 0) return;
  const ready = transcriptBuffer;
  transcriptBuffer = [];
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
    const token = get(state).snapshot?.confirmedToken;
    if (token === undefined) return;
    driver?.moveToToken(token);
    showToast('Re-finding your place', 'info', { durationMs: 1600 });
  },
  acceptCandidate(candidate: { tokenIndex: number }): void {
    driver?.moveToToken(candidate.tokenIndex);
  },
  /**
   * Pausing following is not pausing the session (§15.3, §48): transcription
   * stays connected and voice commands keep working — only automatic movement
   * stops.
   */
  setFollowingPaused(paused: boolean): void {
    trace('follow-pause', paused ? 'paused by the follow store' : 'resumed by the follow store');
    if (paused) driver?.pause();
    else driver?.resume();
    state.update((s) => ({ ...s, voiceFollow: !paused }));
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
 * Adopt the stage's layout generation from its acks (§7.2).
 *
 * Exported for the layout-generation contract test: the ack subscription is set
 * up behind a Tauri-only dynamic import, and the value this tracks is worth
 * asserting without one.
 */
export function adoptStageLayoutGeneration(generation: number): void {
  if (!Number.isInteger(generation) || generation < 0) return;
  if (generation === stageLayoutGeneration) return;
  stageLayoutGeneration = generation;
  // The worker stamps its own frames; the v1 bridge reads the module value
  // directly in `handleSnapshot`. Both producers now carry the stage's number.
}

/** The stage layout generation control currently believes in (§7.2). */
export function currentStageLayoutGeneration(): number {
  return stageLayoutGeneration;
}

/**
 * Whether a second person watching the control window is even plausible.
 *
 * On a single display the stage is frameless, sized to the monitor, and
 * always-on-top (§52.7) — it covers everything, and control is not merely
 * behind it but on the SAME screen the stage owns. Nobody can be looking at
 * control who is not also looking at the stage, which already carries its own
 * on-screen hint for the same information. Defaults to `true` (an operator
 * might be watching) until the real count resolves, so a race at startup errs
 * toward showing the notice rather than silently dropping it for a genuine
 * two-display setup.
 */
let controlOperatorPlausible = true;

function refreshControlOperatorPlausible(): void {
  void stageService
    .listDisplays()
    .then((displays) => {
      controlOperatorPlausible = displays.length > 1;
    })
    .catch(() => {
      // Unknown is not evidence of a solo setup; keep showing the notice.
      controlOperatorPlausible = true;
    });
}

/* ---------------------------------------------------------------------------
 * §64: is the stage APPLYING what control is sending?
 * ------------------------------------------------------------------------- */

/**
 * The newest alignment snapshot control has been handed, by `seq`.
 *
 * Rust publishes every snapshot to BOTH windows, so this and the stage's own
 * applied revision describe the same stream from its two ends. They are the
 * only two numbers that can tell "the aligner is not following" apart from "the
 * aligner is following and the glass is not moving" — and those two have
 * identical symptoms and completely unrelated causes.
 */
let lastSnapshotSeq = 0;
/**
 * The stage's applied revision, as of the last beat that could read it.
 *
 * Kept so the end-of-session summary can state it. That card is the one
 * artefact anybody actually looks at after a take that went wrong, and it
 * already shows "Words heard" beside "Script followed" — two numbers that
 * agreed completely while the glass never moved, with nothing to explain the
 * gap. This is the third number that closes it.
 */
let stageAppliedRevision: number | null = null;
/**
 * The extremes of the document's real scroll offset, and of the offset the
 * controller was aiming at, over this take. Infinities mean the stage never
 * acked — a browser-dev session, or one that ended before the first frame.
 */
let scrollSeenMinPx = Number.POSITIVE_INFINITY;
let scrollSeenMaxPx = Number.NEGATIVE_INFINITY;
let targetSeenMinPx = Number.POSITIVE_INFINITY;
let targetSeenMaxPx = Number.NEGATIVE_INFINITY;

/** Travel over the take, or null when the stage never reported a position. */
function travelPx(minPx: number, maxPx: number): number | null {
  return Number.isFinite(minPx) && Number.isFinite(maxPx) ? maxPx - minPx : null;
}
/** When the two ends first disagreed, or null while they agree. */
let stageApplyDivergedAtMs: number | null = null;
/** Said once per take. A stuck stage does not get more true by repetition. */
let stageApplyReported = false;

/**
 * How far apart the two ends may drift before it means anything.
 *
 * The stage's revision reaches control through its heartbeat ack and the Rust
 * relay, so it trails by up to a beat, and snapshots arrive about once a second.
 * Two is inside the ordinary lag; four is not.
 */
const STAGE_APPLY_LAG_TOLERANCE = 4;
/** And how long it has to stay that way. One slow beat is not a fault. */
const STAGE_APPLY_LAG_GRACE_MS = 5000;

/**
 * Compare the two ends, and say so when they part company.
 *
 * The failure this exists for looks, from the presenter's side, exactly like
 * the aligner having lost them: the script sits still while they talk. But the
 * summary afterwards says "Script followed: 9 of 131", because control received
 * every one of those snapshots and counted them. Nothing anywhere joined those
 * two facts up, so the honest diagnosis — the engine is fine, the stage is
 * discarding what it is sent — was not available from either window.
 *
 * The stage already reports its applied revision on every heartbeat ack and
 * Rust already stores it. Reading it is all that was missing.
 */
function checkStageApplyingSnapshots(expectedGeneration: number): void {
  if (stageApplyReported || lastSnapshotSeq === 0) return;
  void stageService
    .getStageStatus()
    .then((status) => {
      if (!status.exists || status.stageGeneration !== expectedGeneration) return;
      const applied = status.lastTrackingRevision ?? 0;
      stageAppliedRevision = applied;
      const behind = lastSnapshotSeq - applied;
      if (behind < STAGE_APPLY_LAG_TOLERANCE) {
        stageApplyDivergedAtMs = null;
        return;
      }
      const nowMs = monotonicNowMs();
      if (stageApplyDivergedAtMs === null) {
        stageApplyDivergedAtMs = nowMs;
        return;
      }
      if (nowMs - stageApplyDivergedAtMs < STAGE_APPLY_LAG_GRACE_MS) return;
      stageApplyReported = true;
      showToast(
        `Your voice is being followed, but the stage is not applying it — ${lastSnapshotSeq} updates sent, ${applied} applied. ` +
          'The script will not move. Press "s" on the stage for its own diagnostics, which name the reason.',
        'danger',
        { key: TOAST_STAGE_NOT_APPLYING },
      );
    })
    .catch(() => {
      // A failed status read is not evidence about the stage. The next beat
      // asks again, and a stage that has genuinely gone is the watchdog's job.
    });
}

function startStageBridge(sessionId: string): void {
  if (!isTauriRuntime() || stageGeneration === 0) return;

  refreshControlOperatorPlausible();

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
    /*
     * §64: how far the GLASS actually travelled.
     *
     * Every ack has always carried the document's real scroll offset and the
     * offset the controller was aiming at, and both were dropped on the floor
     * after feeding the follow store. That left "the script did not move" as
     * the one claim the app could neither confirm nor deny — a take could
     * report words heard, words followed and snapshots applied, all healthy,
     * and nothing anywhere knew whether a single pixel had moved.
     *
     * Two numbers, because they fail differently. `target` not advancing means
     * the stage never derived a position to travel to — a snapshot, layout or
     * line-map problem. `target` advancing while `actual` does not means the
     * motion controller is not moving the document it was told to move. Those
     * are unrelated faults and, from the presenter's chair, identical.
     */
    if (Number.isFinite(ack.actualScrollPx)) {
      scrollSeenMinPx = Math.min(scrollSeenMinPx, ack.actualScrollPx);
      scrollSeenMaxPx = Math.max(scrollSeenMaxPx, ack.actualScrollPx);
    }
    if (Number.isFinite(ack.targetScrollPx)) {
      targetSeenMinPx = Math.min(targetSeenMinPx, ack.targetScrollPx);
      targetSeenMaxPx = Math.max(targetSeenMaxPx, ack.targetScrollPx);
    }
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
    // The ack this beat provokes carries the stage's applied revision, which is
    // the other half of the comparison. Checked on the same cadence.
    checkStageApplyingSnapshots(generation);
  }, 1000);

  void (async () => {
    const { listen } = await import('@tauri-apps/api/event');
    const unlisteners = await Promise.all([
      listen<StageEscapePayload>(STAGE_EVENT.escapeRequested, (event) => {
        if (event.payload.stageGeneration !== generation) return;
        if (event.payload.presses >= 2) {
          stopSession();
          /*
           * Only when somebody else is watching this window.
           *
           * A solo presenter on one display pressed Escape twice, watched the
           * stage disappear, and was then told — on the screen that stage had
           * been covering — that the session stopped. It is an announcement of
           * their own deliberate action, arriving underneath the F.17 summary
           * that says the same thing better, on the one setup where it can only
           * be read after the fact.
           *
           * With a second display it earns its place: an operator sat at
           * control did NOT press the key, watched the stage go dark, and this
           * is the line that says why.
           */
          if (controlOperatorPlausible) showToast('Session stopped from the stage', 'info');
        } else if (controlOperatorPlausible) {
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
 * is why nothing here calls `driver`, `moveSentences`,
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
  trace('prompting', 'start');
  state.update((prev) => ({ ...prev, prompting: true, paused: 'none' }));
  driver?.start();
}

/** Listening pause — transcription stays connected (§15.3). */
export function pauseListening(): void {
  trace('pause', 'listening pause (user)');
  state.update((s) => ({ ...s, paused: 'listening' }));
  driver?.pause();
  pipeline?.softPause();
}

/** Hard pause — the realtime connection closes; voice cannot resume (§15.3). */
export function hardPause(): void {
  // 'muted' is the deliberate-pause label; 'disconnected' means something
  // broke. A hard pause is a choice, so it must not read as a failure.
  trace('pause', 'hard pause (user)');
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
export async function switchMicrophone(deviceId: string, label?: string): Promise<boolean> {
  if (!pipeline || deviceId === '') return false;
  try {
    await pipeline.switchMicrophone(deviceId);
  } catch (err) {
    showToast(`Could not switch to that microphone. ${describeError(err)}`, 'danger');
    return false;
  }
  state.update((s) => ({ ...s, micState: 'live', inputDeviceLost: false }));
  // §28.1: remember the choice, so the next take opens the input that worked
  // rather than the one that just vanished. The label goes with it — the id
  // alone does not survive a restart (see `matchRememberedMicrophone`).
  void patchSettings('audio', {
    followSystemDefault: false,
    preferredDeviceId: deviceId,
    ...(label === undefined ? {} : { preferredDeviceLabel: label }),
  }).catch(() => {
    /* a remembered preference is a convenience, never a gate */
  });
  showToast('Microphone switched. Voice following has resumed.', 'success');
  return true;
}

export function togglePlayPause(): void {
  const s = get(state);
  if (!s.active) return;
  if (!s.prompting) startPrompting();
  else if (s.paused === 'none') pauseListening();
  else resumeSession();
}

export function moveSentences(delta: number): void {
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
  driver?.moveToToken(Math.max(0, tokenIndex));
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
  driver?.restartParagraph();
  const before = get(state);
  // §36.3: a new pass proves itself again. The evidence that the last one was
  // heard says nothing about this one, and the pill coming back is how the
  // presenter knows the retake is being picked up.
  resetVoicePill();
  noteCheckpoint('paragraph_start');
  finishTake(before.sessionId, roundToken(before.snapshot?.confirmedToken));
  if (before.sessionId !== null) {
    const passOrdinal = before.counts.retakes + 2;
    beginTake(before.sessionId, passOrdinal, roundToken(before.snapshot?.confirmedToken) ?? 0);
  }
  state.update((s) => ({ ...s, counts: { ...s.counts, retakes: s.counts.retakes + 1 } }));
}

/** "Mark this" (§36.3) — drop a checkpoint at the current position. */
export function addTakeMarker(): void {
  noteCheckpoint('take');
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
}

export function toggleListenerVisible(): boolean {
  // §40.5: a Listener the operator turned off after a failure stays off for
  // the take, whichever control asks.
  if (listenerRetiredForSession) return false;
  listenerVisible = !listenerVisible && listenerSelection !== null;
  sendDirective({ kind: 'listener', listener: listenerVisible ? listenerSelection : null });
  return listenerVisible;
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
  const token = roundToken(s.snapshot?.confirmedToken) ?? 0;
  let currentIndex = -1;
  flat.forEach((n, i) => {
    if (n.startTokenIndex <= token) currentIndex = i;
  });
  const target = flat[Math.max(0, Math.min(flat.length - 1, currentIndex + delta))];
  if (!target) return false;
  driver?.moveToToken(target.startTokenIndex);
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
/** Stop the session and produce the F.17 summary. */
export function stopSession(): SessionSummary {
  const s = get(state);
  // A stop with nothing running must not manufacture an end-of-session
  // summary — Live opens the F.17 dialog on `!active && summary !== null`.
  if (!s.active) {
    stopInternals();
    return s.summary ?? emptySummary(s);
  }
  const summary: SessionSummary = {
    durationSeconds: s.elapsedSeconds,
    mode: s.mode,
    sectionsReached: s.blocksSeen.length,
    retakes: s.counts.retakes,
    reconnects: s.counts.reconnects,
    endingLocation: locateEnding(s),
    transcriptSaved: transcriptRetained,
    wordsHeard,
    wordsFollowed: takeWordsFollowed(),
    scriptWords: scriptWordCount,
    updatesSent: lastSnapshotSeq,
    stageApplied: stageAppliedRevision,
    documentTravelPx: travelPx(scrollSeenMinPx, scrollSeenMaxPx),
    targetTravelPx: travelPx(targetSeenMinPx, targetSeenMaxPx),
    wordsInFlight,
    transcriptTapsSeen,
    transcriptTapsEmitted,
    transcriptTapFault: transcriptTapFault(),
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
    /*
     * Where the session ended. The conservative anchor when there is one, and
     * the take's own high-water mark otherwise — a session that ran and ended
     * has an end position even if alignment never produced a snapshot, and
     * reporting `undefined` there would make "did it follow anything" and "was
     * there a session at all" the same answer.
     */
    const endTokenIndex = roundToken(s.snapshot?.confirmedToken) ?? takeWordsFollowed();
    finishTake(s.sessionId, endTokenIndex);
    void endSessionRecord(s.sessionId, {
      endTokenIndex,
      commandCount: 0,
      retakeCount: s.counts.retakes,
      reconnectCount: s.counts.reconnects,
      manualCorrectionCount: s.counts.jumps,
      estimatedCostUsd: 0,
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
    reconnects: 0,
    endingLocation: 'Beginning',
    transcriptSaved: false,
    wordsHeard: 0,
    wordsFollowed: 0,
    scriptWords: scriptWordCount,
    updatesSent: 0,
    stageApplied: null,
    documentTravelPx: null,
    targetTravelPx: null,
    wordsInFlight: 0,
    transcriptTapsSeen: 0,
    transcriptTapsEmitted: 0,
    transcriptTapFault: null,
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
    .find((n) => n.startTokenIndex <= snapshot.confirmedToken);
  return section ? section.title : `Token ${Math.round(snapshot.confirmedToken)}`;
}

function stopInternals(): void {
  /*
   * The take's warnings end with the take. Every one of them describes a
   * microphone or a transport that is no longer in use, and `danger` toasts do
   * not expire — so left standing they arrive all at once on the summary
   * screen, reading as a fresh pile of problems rather than an old one that
   * resolved itself.
   */
  clearConditionToasts();
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
  stopVoicePill();
  stopMotionAcks?.();
  stopMotionAcks = null;
  stopSidecarFeed?.();
  stopSidecarFeed = null;
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
    // `ambiguous` deliberately reads the same as `holding`. The distinction —
    // "two places fit" versus "nothing fits" — is real, and it belongs in the
    // detail line where it can be acted on; as a status it would only tell the
    // presenter that the app has an internal state machine.
    case 'holding':
    case 'ambiguous':
      return 'Holding your place';
    case 'searching':
      return 'Looking for your place';
    default:
      return voice ? 'Listening' : 'Prompting';
  }
});
