import type {
  PreparedInterviewOutput,
  NextInterviewerAction,
  TranscriptCleanupResult,
  EndpointDecision,
  GlossaryTerm,
  InterviewBrief,
  ModerationRecord,
  EndpointMode,
  InterviewTurn,
} from '../domain';

// ---------------------------------------------------------------------------
// Interview model adapter (OpenAI behind a domain interface)
// ---------------------------------------------------------------------------

export interface PrepareProjectInput {
  compiledSource: string;
  targetQuestionCount: number;
  tone: string | null;
  exclusions: string[];
  modelId: string;
}

export interface RecentTurnContext {
  turnId: string;
  question: string;
  answer: string;
  targetCoverageIds: string[];
}

export interface GenerateNextActionInput {
  characterSystemPrompt: string;
  brief: InterviewBrief;
  coverage: Array<{
    coverageItemId: string;
    label: string;
    objective: string;
    priority: string;
    status: string;
    followUpCount: number;
  }>;
  rollingSummary: string;
  recentTurns: RecentTurnContext[];
  currentAnswer: string;
  rawAnswerFallback: string;
  moderationGuidance: string;
  nextOrdinal: number;
  targetQuestionCount: number;
  endAfterTurn: boolean;
  currentSectionId: string | null;
  modelId: string;
}

export interface CleanTranscriptInput {
  rawTranscript: string;
  glossary: GlossaryTerm[];
  modelId: string;
}

export interface ClassifyEndpointInput {
  question: string;
  transcript: string;
  speechDurationMs: number;
  silenceDurationMs: number;
  mode: EndpointMode;
  modelId: string;
}

export interface RepairQuestionInput {
  spokenText: string;
  maxWords: number;
  reason: string;
  modelId: string;
}

export interface InterviewModelAdapter {
  prepareProject(input: PrepareProjectInput, signal?: AbortSignal): Promise<PreparedInterviewOutput>;
  generateNextAction(input: GenerateNextActionInput, signal?: AbortSignal): Promise<NextInterviewerAction>;
  cleanTranscript(input: CleanTranscriptInput, signal?: AbortSignal): Promise<TranscriptCleanupResult>;
  classifyEndpoint(input: ClassifyEndpointInput, signal?: AbortSignal): Promise<EndpointDecision>;
  repairQuestion(input: RepairQuestionInput, signal?: AbortSignal): Promise<{ spokenText: string }>;
}

export interface ModerationAdapter {
  moderate(text: string, signal?: AbortSignal): Promise<ModerationRecord>;
}

// ---------------------------------------------------------------------------
// Speech-to-text adapter (Inworld streaming STT behind a domain interface)
// ---------------------------------------------------------------------------

export interface SttSessionConfig {
  sampleRate: 16000;
  channels: 1;
  model: string;
  languageHint?: string;
  interimResults: boolean;
}

export interface AudioChunkPacket {
  sessionId: string;
  turnId: string;
  sequence: number;
  sampleRate: 16000;
  channels: 1;
  format: 'pcm_s16le';
  capturedAtMs: number;
  payload: ArrayBuffer;
}

export interface SttTurnResult {
  text: string;
  finalSegments: string[];
  confidence: number | null;
}

export interface SttRecoveryConfig {
  sampleRate: number;
  channels: number;
  model: string;
}

export type Unsubscribe = () => void;

export type SttEvent = 'partial' | 'finalSegment' | 'speechStarted' | 'speechStopped' | 'error';

export interface SpeechToTextAdapter {
  connect(config: SttSessionConfig, signal?: AbortSignal): Promise<void>;
  beginTurn(turnId: string): Promise<void>;
  writeAudio(chunk: AudioChunkPacket): void;
  endTurn(options: { signal?: AbortSignal; deadlineMs: number }): Promise<SttTurnResult>;
  recoverFromAudio(pcm: Uint8Array, config: SttRecoveryConfig, signal?: AbortSignal): Promise<SttTurnResult>;
  close(): Promise<void>;
  on(event: SttEvent, listener: (...args: any[]) => void): Unsubscribe;
}

// ---------------------------------------------------------------------------
// Text-to-speech adapter (Inworld TTS behind a domain interface)
// ---------------------------------------------------------------------------

export interface TtsInput {
  text: string;
  voiceId: string;
  style: 'neutral';
  speakingRate: number;
  outputFormat: 'pcm_s16le' | 'wav';
  sampleRate: number;
}

export type TestVoiceInput = TtsInput;

export interface TtsResult {
  bytes: Uint8Array;
  mimeType: string;
  sampleRate: number;
  channels: number;
  durationMs: number;
  providerRequestId: string | null;
  latencyMs: number;
}

export interface TextToSpeechAdapter {
  testVoice(input: TestVoiceInput, signal?: AbortSignal): Promise<TtsResult>;
  synthesize(input: TtsInput, signal?: AbortSignal): Promise<TtsResult>;
}

// ---------------------------------------------------------------------------
// Provider test results
// ---------------------------------------------------------------------------

export interface ProviderTestResult {
  provider: 'openai' | 'inworld';
  ok: boolean;
  message: string;
  latencyMs: number | null;
}

export { InterviewTurn };
