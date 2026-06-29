import type { SessionId, TurnId, CoverageItemId } from './ids';
import type { QuestionType, CoverageStatus } from './plan';

export type QuestionSource =
  | 'opening_cache'
  | 'model'
  | 'fallback_bank'
  | 'operator';

export interface SpeakingMediaPlanSegment {
  clipId: string;
  relativePath: string;
  playbackRate: number;
  expectedPlaybackDurationMs: number;
}

export type SpeakingSelectionReason =
  | 'single_match'
  | 'pair_match'
  | 'forced_cut'
  | 'poster_fallback';

export interface SpeakingMediaPlan {
  speechDurationMs: number;
  segments: SpeakingMediaPlanSegment[];
  selectionReason: SpeakingSelectionReason;
  diagnosticScore: number;
}

export interface QuestionRecord {
  text: string;
  type: QuestionType;
  targetCoverageItemIds: CoverageItemId[];
  modelId: string;
  promptVersion: string;
  generatedAt: string;
  ttsProvider: 'inworld';
  ttsVoiceId: string;
  /**
   * Per-turn TTS speaking-rate multiplier derived from the model's delivery
   * hint (clamped to the safe subset of Inworld's range). When absent, the
   * synthesizer falls back to the character's configured `voice.speakingRate`.
   */
  ttsSpeakingRate?: number;
  audioDurationMs: number | null;
  mediaPlan: SpeakingMediaPlan | null;
  generationLatencyMs: number | null;
  ttsLatencyMs: number | null;
  source: QuestionSource;
}

export type EndpointReason = 'manual' | 'automatic' | 'timeout' | 'recovery' | 'ended-now';

export interface ModerationRecord {
  modelId: string;
  flagged: boolean;
  categories: Record<string, boolean>;
  categoryScores: Record<string, number>;
  decision: 'allow' | 'allow_sensitive' | 'redirect' | 'error';
}

export interface UncertainTerm {
  raw: string;
  proposed: string | null;
  reason: string;
}

export interface AnswerRecord {
  rawTranscript: string;
  cleanedTranscript: string;
  userEditedTranscript: string | null;
  transcriptParagraphs: string[];
  uncertainTerms: UncertainTerm[];
  endpointReason: EndpointReason;
  speechStartedAt: string | null;
  speechEndedAt: string | null;
  durationMs: number | null;
  sttProvider: 'inworld';
  sttModelId: string;
  cleanupModelId: string | null;
  moderation: ModerationRecord | null;
  sttLatencyMs: number | null;
  cleanupLatencyMs: number | null;
  recoveredFromBufferedAudio: boolean;
}

export interface CoverageDelta {
  coverageItemId: CoverageItemId;
  fromStatus: CoverageStatus;
  toStatus: CoverageStatus;
  evidenceTurnIds: TurnId[];
}

export type TurnState = 'planned' | 'asked' | 'answered' | 'failed' | 'skipped';

export interface InterviewTurn {
  id: TurnId;
  sessionId: SessionId;
  ordinal: number;
  question: QuestionRecord;
  answer: AnswerRecord | null;
  coverageDelta: CoverageDelta[];
  state: TurnState;
  createdAt: string;
  completedAt: string | null;
}
