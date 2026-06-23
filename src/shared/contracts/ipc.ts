import type {
  SessionRuntimeState,
  SessionCommand,
  PreflightConfig,
  SpeakingMediaPlan,
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
  projectsExport: 'projects:export',
  projectsImportDocument: 'projects:import-document',
  projectsImportMarkdownDocuments: 'projects:import-markdown-documents',
  // control: settings
  settingsGetPublic: 'settings:get-public',
  settingsSaveProviders: 'settings:save-providers',
  settingsTestProvider: 'settings:test-provider',
  settingsClearProvider: 'settings:clear-provider',
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
  sessionsExport: 'sessions:export',
  sessionsResumable: 'sessions:resumable',
  sessionsReview: 'sessions:review',
  sessionsEditTranscript: 'sessions:edit-transcript',
  // events (main → control)
  evtSessionSnapshot: 'evt:session-snapshot',
  evtPreflight: 'evt:preflight',
  evtError: 'evt:error',
  // stage
  stageBootstrap: 'stage:bootstrap',
  stageOpenAudioPort: 'stage:open-audio-port',
  stageReportDevices: 'stage:report-devices',
  stageReportMeter: 'stage:report-meter',
  stagePlaybackReady: 'stage:playback-ready',
  stagePlaybackStarted: 'stage:playback-started',
  stagePlaybackEnded: 'stage:playback-ended',
  stagePlaybackError: 'stage:playback-error',
  stageCommand: 'stage:command',
  // events (main → stage)
  evtStageState: 'evt:stage-state',
  evtPlaybackPlan: 'evt:playback-plan',
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

export interface PublicMediaDevice {
  deviceId: string;
  label: string;
  kind: 'audioinput' | 'audiooutput';
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------
export type PreflightCheckId =
  | 'openai'
  | 'inworld'
  | 'voice'
  | 'manifest'
  | 'microphone'
  | 'output'
  | 'display'
  | 'network'
  | 'opening'
  | 'endpoint';

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
  deviceLabel: string | null;
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
    canEnd: boolean;
  };
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
  mirror: boolean;
  zoom: number;
  verticalOffsetPercent: number;
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
  posterUrl: string;
  listeningClips: ListeningClipRef[];
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
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'REPEAT' }
  | { type: 'SKIP' }
  | { type: 'EXIT_STAGE' };

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

// ---------------------------------------------------------------------------
// Preload API surfaces (spec §20.6)
// ---------------------------------------------------------------------------
export interface CandidCueControlApi {
  projects: {
    list(): Promise<ProjectSummary[]>;
    get(projectId: string): Promise<ProjectAggregate | null>;
    save(input: SaveProjectInput): Promise<ProjectAggregate>;
    remove(projectId: string): Promise<void>;
    prepare(projectId: string): Promise<PreparationJobResult>;
    export(projectId: string): Promise<ExportResult>;
    importDocument(): Promise<{ title: string; content: string; filename: string; mimeType: string } | null>;
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
    review(sessionId: string): Promise<SessionReview | null>;
    editTranscript(turnId: string, text: string): Promise<void>;
    export(sessionId: string, format: 'markdown' | 'json'): Promise<ExportResult>;
    resumable(): Promise<Array<{ sessionId: string; projectTitle: string; startedAt: string | null }>>;
  };
  events: {
    onSessionSnapshot(listener: (snapshot: OperatorSessionSnapshot) => void): Unsubscribe;
    onPreflight(listener: (state: PreflightState) => void): Unsubscribe;
    onError(listener: (error: PublicAppError) => void): Unsubscribe;
  };
}

export interface CandidCueStageApi {
  bootstrap(): Promise<StageBootstrap>;
  audio: {
    openCapturePort(input: { sessionId: string }): Promise<MessagePort>;
    reportDeviceList(devices: PublicMediaDevice[]): Promise<void>;
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
    onCaptureConfig(listener: (config: CaptureConfig) => void): Unsubscribe;
  };
}
