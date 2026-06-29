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
  /** Founder-supplied interview title, used as authoritative framing. */
  title: string | null;
  /** Founder-supplied intended audience, used as authoritative framing. */
  audience: string | null;
  /** Founder-supplied desired outcome, used as authoritative framing. */
  intendedOutcome: string | null;
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
    maxFollowUps: number;
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
  /**
   * Build the interview plan from the compiled project source. Unlike the other
   * methods this one streams: `onProgress`, when supplied, is invoked as output
   * generates with the running count of characters produced so far (issue #47),
   * letting the caller surface live progress while the long call runs.
   */
  prepareProject(
    input: PrepareProjectInput,
    signal?: AbortSignal,
    onProgress?: (charsGenerated: number) => void,
  ): Promise<PreparedInterviewOutput>;
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
  /**
   * True when {@link SpeechToTextAdapter.endTurn} resolved by hitting its own
   * finalize deadline (the provider went quiet) rather than observing a genuine
   * FINAL segment. A mid-answer stream drop surfaces here — endTurn does NOT
   * reject, it resolves with whatever partial accumulated — so the orchestrator
   * uses this (not just a thrown/timed-out endTurn) to decide whether to batch
   * re-transcribe the buffered audio (#69). Undefined/false means a clean final.
   */
  hitDeadline?: boolean;
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
  /**
   * Re-establish the streaming transport after it dropped mid-session, reusing
   * the config supplied at {@link connect}. Unlike {@link close} + {@link connect}
   * this preserves the registered event listeners (and the orchestrator bridge
   * wired through {@link on}) so a reconnect is transparent to subscribers — only
   * the dead transport is torn down and rebuilt. Throws if no session was ever
   * established (reconnect before a successful connect).
   */
  reconnect(signal?: AbortSignal): Promise<void>;
  beginTurn(turnId: string): Promise<void>;
  /**
   * Re-activate the in-flight turn after a mid-answer pause so partial/final
   * events fold again, WITHOUT resetting the accumulator or discarding any
   * transcript captured before the pause. Unlike {@link beginTurn} (which starts
   * a fresh turn from empty), this preserves the pre-pause words so resuming a
   * live answer never drops what the user already said.
   */
  resumeTurn(turnId: string): Promise<void>;
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
