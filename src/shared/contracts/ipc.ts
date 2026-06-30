import type {
  SessionRuntimeState,
  SessionCommand,
  PreflightConfig,
  SpeakingMediaPlan,
  InterviewSession,
  ProjectAggregate,
  ProjectSummary,
  SaveProjectInput,
  ImportMarkdownDocumentsResult,
  PublicCharacterSummary,
  EndpointMode,
} from '../domain';
import type { ProviderTestResult, Unsubscribe } from './adapters';
import type { PublicAppError } from '../errors/app-error';

// ---------------------------------------------------------------------------
// IPC channel names — hardcoded and specific (spec §20.7)
// ---------------------------------------------------------------------------
export const CHANNELS = {
  // control: projects
  projectsList: 'projects:list',
  projectsGet: 'projects:get',
  projectsSave: 'projects:save',
  projectsRemove: 'projects:remove',
  projectsPrepare: 'projects:prepare',
  projectsPrepareCancel: 'projects:prepare-cancel',
  projectsImportMarkdownDocuments: 'projects:import-markdown-documents',
  // control: settings
  settingsGetPublic: 'settings:get-public',
  settingsSaveProviders: 'settings:save-providers',
  settingsTestProvider: 'settings:test-provider',
  settingsClearProvider: 'settings:clear-provider',
  // control: window chrome
  windowSetThemeChrome: 'window:set-theme-chrome',
  // control: characters
  charactersList: 'characters:list',
  // control: devices
  devicesListDisplays: 'devices:list-displays',
  devicesSetDisplay: 'devices:set-display',
  devicesIdentifyDisplays: 'devices:identify-displays',
  // control: sessions
  sessionsPrepare: 'sessions:prepare',
  sessionsCommand: 'sessions:command',
  sessionsSnapshot: 'sessions:get-snapshot',
  sessionsList: 'sessions:list',
  sessionsExport: 'sessions:export',
  sessionsResumable: 'sessions:resumable',
  sessionsReview: 'sessions:review',
  sessionsEditTranscript: 'sessions:edit-transcript',
  // events (main → control)
  evtSessionSnapshot: 'evt:session-snapshot',
  evtPreflight: 'evt:preflight',
  evtPrepareProgress: 'evt:prepare-progress',
  evtError: 'evt:error',
  // stage
  stageBootstrap: 'stage:bootstrap',
  stageOpenAudioPort: 'stage:open-audio-port',
  stageReportMeter: 'stage:report-meter',
  stagePlaybackReady: 'stage:playback-ready',
  stagePlaybackStarted: 'stage:playback-started',
  stagePlaybackEnded: 'stage:playback-ended',
  stagePlaybackError: 'stage:playback-error',
  stageCommand: 'stage:command',
  // events (main → stage)
  evtStageState: 'evt:stage-state',
  evtPlaybackPlan: 'evt:playback-plan',
  evtSpeechChunk: 'evt:speech-audio-chunk',
  evtPlayBackchannel: 'evt:play-backchannel',
  evtCaptureConfig: 'evt:capture-config',
} as const;


// ---------------------------------------------------------------------------
// Public (renderer-safe) settings & devices
// ---------------------------------------------------------------------------
export interface PublicSettings {
  hasOpenAiKey: boolean;
  hasInworldKey: boolean;
  endpointMode: EndpointMode;
  captionsEnabled: boolean;
  explicitAudioOutputSelection: boolean;
  diagnosticsOverlay: boolean;
  ttsVoiceId: string;
}

export interface ProviderCredentialInput {
  openaiApiKey?: string;
  inworldApiKey?: string;
}

export interface DisplayInfo {
  id: string;
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
  isPrimary: boolean;
  isInternal: boolean;
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------
// Only the checks the main-process preflight actually runs. The renderer owns
// mic permission/enumeration and audio-device selection (navigator.mediaDevices
// is unavailable in the main process), so those are not part of the shared
// readiness result; `voice` is deferred until the Inworld TTS format issue (#8)
// is resolved.
export type PreflightCheckId = 'openai' | 'inworld' | 'manifest' | 'display' | 'opening';

export interface PreflightCheck {
  id: PreflightCheckId;
  label: string;
  required: boolean;
  status: 'pending' | 'checking' | 'passed' | 'failed';
  detail: string | null;
}

export interface PreflightState {
  projectId: string;
  sessionId: string | null;
  checks: PreflightCheck[];
  canBegin: boolean;
}

export interface PrepareSessionInput {
  projectId: string;
  config: PreflightConfig;
}

// ---------------------------------------------------------------------------
// Operator + stage projections (spec §20.8)
// ---------------------------------------------------------------------------
export interface PublicCoverageItem {
  id: string;
  label: string;
  priority: 'must' | 'should' | 'optional';
  status: 'not_started' | 'partial' | 'covered' | 'skipped';
}

export interface PublicMicState {
  gate: 'closed' | 'armed' | 'active';
  level: number;
  clipping: boolean;
}

export interface PublicProviderStatus {
  openai: 'ok' | 'degraded' | 'down';
  inworldStt: 'ok' | 'degraded' | 'down';
  inworldTts: 'ok' | 'degraded' | 'down';
  lastQuestionLatencyMs: number | null;
}

export interface OperatorSessionSnapshot {
  version: number;
  sessionId: string;
  projectTitle: string;
  state: SessionRuntimeState;
  elapsedMs: number;
  questionOrdinal: number;
  currentQuestion: string | null;
  partialTranscript: string;
  finalTranscriptSoFar: string;
  coverage: PublicCoverageItem[];
  mic: PublicMicState;
  providerStatus: PublicProviderStatus;
  endpointPending: boolean;
  recoverableWarning: string | null;
  controls: {
    canPause: boolean;
    canResume: boolean;
    canCommit: boolean;
    canRepeat: boolean;
    canSkip: boolean;
    canRetake: boolean;
    canEnd: boolean;
    canEndAfterTurn: boolean;
    canEndNow: boolean;
    canRetry: boolean;
  };
}

/** The model-authored teleprompter cue the founder reads during a live turn.
 *  `headline` is the question rendered for the eye (the dominant on-screen text);
 *  `prompt` is an optional short coaching line on how to answer, or null. */
export interface StageCueProjection {
  headline: string;
  prompt: string | null;
}

export interface StageStateProjection {
  version: number;
  visualState:
    | 'standby'
    | 'listening'
    | 'thinking'
    | 'speaking'
    | 'paused'
    | 'recovering'
    | 'complete'
    | 'error';
  micState: 'closed' | 'armed' | 'active';
  statusText: string | null;
  captions: string | null;
  /** The current turn's teleprompter cue, shown across the live turn (speaking →
   *  the founder's answer). Null outside a live turn (standby / complete / error)
   *  and for the closing sign-off. Independent of the verbatim `captions` toggle:
   *  this is the core prompt the founder reads, not an accessibility caption. */
  cue: StageCueProjection | null;
  mirror: boolean;
  zoom: number;
  verticalOffsetPercent: number;
  /** True only while the session is READY — the one runtime state where the
   *  founder may begin the interview from the stage. The 'standby' visualState
   *  alone can't say this: it also covers IDLE/PREPARING, where BEGIN is illegal. */
  canBegin: boolean;
}

// ---------------------------------------------------------------------------
// Playback plan that crosses to the stage (spec §18.10)
// ---------------------------------------------------------------------------
export interface SpeechPlaybackPlan {
  sessionId: string;
  turnId: string;
  text: string;
  audio: {
    mimeType: string;
    bytes: ArrayBuffer;
    durationMs: number;
    outputDeviceId: string | null;
  };
  media: SpeakingMediaPlan;
  captionsEnabled: boolean;
  /**
   * When true, `audio.bytes` is empty and the audio arrives as a sequence of
   * {@link SpeechAudioChunk}s on `evt:speech-audio-chunk` (streamed TTS). The
   * player decodes + schedules chunks gaplessly and reports ready on the first
   * one. Absent/false = the whole clip is in `audio.bytes` (buffered path).
   */
  streaming?: boolean;
}

/** One streamed TTS audio chunk pushed to the stage (a complete WAV). */
export interface SpeechAudioChunk {
  sessionId: string;
  turnId: string;
  sequence: number;
  /** A self-contained WAV the renderer can decodeAudioData directly. */
  bytes: ArrayBuffer;
  /** True on the final chunk, so the player knows when playback can end. */
  isFinal: boolean;
}

export interface CaptureConfig {
  /** The live session the captured audio belongs to (stamped on every chunk). */
  sessionId: string;
  /** Selected microphone, or null for the system default device. */
  inputDeviceId: string | null;
  sampleRate: 16000;
  channels: 1;
  preRollMs: number;
  postSpeechMicGuardMs: number;
}

export interface ListeningClipRef {
  clipId: string;
  url: string;
  durationMs: number;
}

export interface StageBootstrap {
  characterId: string;
  /** When true, the stage shows a single still image (`posterUrl`) for the whole
   *  session and skips the avatar video deck — the video pipeline is disabled
   *  (see STATIC_STAGE_BACKGROUND). The renderer reports speaking-readiness
   *  immediately, so the turn's readiness gate falls through to the decoded
   *  audio alone. Flip the flag to re-enable the VideoDeck later. */
  staticBackground: boolean;
  posterUrl: string;
  listeningClips: ListeningClipRef[];
  /**
   * Short audio-only acknowledgments ("mm-hm", "got it") played the instant a
   * turn commits, to fill the silent gap while STT finalizes and the next
   * question synthesizes (#53). Empty when the character ships no such clips —
   * the stage simply plays nothing.
   */
  backchannelClips: ListeningClipRef[];
  video: {
    fit: 'cover' | 'contain';
    mirror: boolean;
    zoom: number;
    verticalOffsetPercent: number;
    transitionMs: number;
  };
}

export interface AudioMeterReading {
  peak: number;
  average: number;
  clipping: boolean;
}

export interface StageReadyEvent {
  turnId: string;
}
export interface PlaybackStartedEvent {
  turnId: string;
  atMs: number;
}
export interface PlaybackEndedEvent {
  turnId: string;
  atMs: number;
}
export interface PlaybackErrorEvent {
  turnId: string;
  reason: string;
}

export type StageCommand =
  | { type: 'COMMIT'; reason: 'manual' | 'automatic' }
  | { type: 'BEGIN' }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'REPEAT' }
  | { type: 'SKIP' }
  | { type: 'RETAKE' }
  | { type: 'EXIT_STAGE' }
  | { type: 'END_AFTER_TURN' };

// ---------------------------------------------------------------------------
// Job / command results
// ---------------------------------------------------------------------------
export interface CommandResult {
  ok: boolean;
  state: SessionRuntimeState | null;
  error: PublicAppError | null;
}

export interface ExportResult {
  ok: boolean;
  path: string | null;
  bytesWritten: number | null;
  error: PublicAppError | null;
}

export interface PreparationJobResult {
  ok: boolean;
  planId: string | null;
  warnings: string[];
  error: PublicAppError | null;
}

/**
 * Streaming progress for an in-flight interview preparation, pushed from the
 * main process to the renderer over `evt:prepare-progress`. The companion
 * `projects:prepare-cancel` command lets the renderer abort the job.
 */
export interface PrepareProgress {
  projectId: string;
  phase: 'reading' | 'generating' | 'validating' | 'saving' | 'done' | 'failed';
  detail?: string;
  charsGenerated?: number;
}

export interface SessionReviewTurn {
  /** The real persisted turn id — required for transcript edits to target the right row. */
  id: string;
  ordinal: number;
  question: string;
  rawTranscript: string | null;
  cleanedTranscript: string | null;
  userEditedTranscript: string | null;
  endpointReason: string | null;
  incomplete: boolean;
}

export interface SessionReview {
  sessionId: string;
  projectTitle: string;
  startedAt: string | null;
  endedAt: string | null;
  turns: SessionReviewTurn[];
  coverage: PublicCoverageItem[];
}

/**
 * Shell theme the renderer is currently showing — drives the native Windows
 * title-bar overlay palette so a dark block never sits over the light workspace.
 */
export type ChromeTheme = 'workspace' | 'studio';

// ---------------------------------------------------------------------------
// Preload API surfaces (spec §20.6)
// ---------------------------------------------------------------------------
export interface CandidCueControlApi {
  window: {
    /** Re-skin the native window-control overlay for the active shell theme
     * (no-op on macOS, where traffic lights are used). Fire-and-forget. */
    setThemeChrome(theme: ChromeTheme): void;
  };
  projects: {
    list(): Promise<ProjectSummary[]>;
    get(projectId: string): Promise<ProjectAggregate | null>;
    save(input: SaveProjectInput): Promise<ProjectAggregate>;
    remove(projectId: string): Promise<void>;
    prepare(projectId: string): Promise<PreparationJobResult>;
    cancelPrepare(projectId: string): Promise<void>;
    importMarkdownDocuments(): Promise<ImportMarkdownDocumentsResult | null>;
  };
  settings: {
    getPublic(): Promise<PublicSettings>;
    saveProviders(input: ProviderCredentialInput): Promise<{ ok: boolean }>;
    testProvider(provider: 'openai' | 'inworld'): Promise<ProviderTestResult>;
    clearProvider(provider: 'openai' | 'inworld'): Promise<{ ok: boolean }>;
  };
  characters: {
    list(): Promise<PublicCharacterSummary[]>;
  };
  devices: {
    listDisplays(): Promise<DisplayInfo[]>;
    setSelectedDisplay(displayId: string): Promise<void>;
    identifyDisplays(): Promise<void>;
  };
  sessions: {
    prepare(input: PrepareSessionInput): Promise<PreflightState>;
    command(command: SessionCommand): Promise<CommandResult>;
    getSnapshot(): Promise<OperatorSessionSnapshot | null>;
    list(projectId: string): Promise<InterviewSession[]>;
    review(sessionId: string): Promise<SessionReview | null>;
    editTranscript(turnId: string, text: string): Promise<void>;
    export(sessionId: string, format: 'markdown' | 'json'): Promise<ExportResult>;
    resumable(): Promise<
      Array<{ sessionId: string; projectId: string; projectTitle: string; startedAt: string | null }>
    >;
  };
  events: {
    onSessionSnapshot(listener: (snapshot: OperatorSessionSnapshot) => void): Unsubscribe;
    onPreflight(listener: (state: PreflightState) => void): Unsubscribe;
    onPrepareProgress(listener: (p: PrepareProgress) => void): Unsubscribe;
    onError(listener: (error: PublicAppError) => void): Unsubscribe;
  };
}

export interface CandidCueStageApi {
  bootstrap(): Promise<StageBootstrap>;
  audio: {
    openCapturePort(input: { sessionId: string }): Promise<MessagePort>;
    reportMeter(level: AudioMeterReading): void;
  };
  playback: {
    reportReady(input: StageReadyEvent): void;
    reportStarted(input: PlaybackStartedEvent): void;
    reportEnded(input: PlaybackEndedEvent): void;
    reportError(input: PlaybackErrorEvent): void;
  };
  commands: {
    send(command: StageCommand): void;
  };
  events: {
    onState(listener: (state: StageStateProjection) => void): Unsubscribe;
    onPlaybackPlan(listener: (plan: SpeechPlaybackPlan) => void): Unsubscribe;
    /** Streamed TTS audio chunks for a `streaming` playback plan (C4). */
    onSpeechChunk(listener: (chunk: SpeechAudioChunk) => void): Unsubscribe;
    /** Fire-and-forget cue to play an immediate backchannel acknowledgment (#53). */
    onPlayBackchannel(listener: () => void): Unsubscribe;
    onCaptureConfig(listener: (config: CaptureConfig) => void): Unsubscribe;
  };
}
