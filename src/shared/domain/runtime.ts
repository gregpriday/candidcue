import type { CoverageItemId } from './ids';
import type { QuestionType, CoverageStatus } from './plan';
import type { EndpointMode } from './session';
import type { SpeakingMediaPlan } from './turn';

// EndpointReason is owned by ./turn and re-exported by the domain barrel.

/** Canonical runtime states of the session orchestrator (spec §11.1). */
export type SessionRuntimeState =
  | 'IDLE'
  | 'PREPARING'
  | 'READY'
  | 'INTERVIEWER_THINKING'
  | 'INTERVIEWER_BUFFERING'
  | 'INTERVIEWER_SPEAKING'
  | 'USER_ARMED'
  | 'USER_SPEAKING'
  | 'ENDPOINT_CANDIDATE'
  | 'TURN_FINALIZING'
  | 'PAUSED'
  | 'RECOVERING'
  | 'FINISHING'
  | 'COMPLETED'
  | 'ERROR';

export interface PreflightConfig {
  endpointMode: EndpointMode;
  selectedInputDeviceId: string | null;
  selectedOutputDeviceId: string | null;
  selectedDisplayId: string | null;
  captionsEnabled: boolean;
  mirrorStage: boolean;
  zoom: number;
  verticalOffsetPercent: number;
}

export type SessionCommand =
  | { type: 'PREPARE_SESSION'; projectId: string; config: PreflightConfig }
  | { type: 'BEGIN_SESSION' }
  | { type: 'COMMIT_USER_TURN'; reason: 'manual' | 'automatic' }
  | { type: 'PAUSE_SESSION' }
  | { type: 'RESUME_SESSION' }
  | { type: 'REPEAT_QUESTION' }
  | { type: 'SKIP_QUESTION' }
  | { type: 'END_AFTER_TURN' }
  | { type: 'END_NOW' }
  | { type: 'RETRY_RECOVERY' };

export type SessionCommandType = SessionCommand['type'];

export interface SpeechPlaybackPlanLite {
  turnId: string;
  durationMs: number;
  media: SpeakingMediaPlan;
}

export type SessionEvent =
  | { type: 'STATE_CHANGED'; state: SessionRuntimeState; from: SessionRuntimeState; reason: string }
  | { type: 'SPEECH_STARTED'; at: number }
  | { type: 'SPEECH_STOPPED'; at: number }
  | { type: 'SPEECH_RESUMED'; at: number }
  | { type: 'TRANSCRIPT_PARTIAL'; text: string }
  | { type: 'TRANSCRIPT_FINAL_SEGMENT'; text: string }
  | { type: 'TURN_COMMITTED'; turnId: string; reason: string }
  | { type: 'QUESTION_READY'; turnId: string; plan: SpeechPlaybackPlanLite }
  | { type: 'PLAYBACK_STARTED'; turnId: string }
  | { type: 'PLAYBACK_ENDED'; turnId: string }
  | { type: 'DEVICE_LOST'; deviceType: 'input' | 'output' | 'display' }
  | { type: 'PROVIDER_FAILED'; provider: string; recoverable: boolean }
  | { type: 'SESSION_COMPLETED' };

export type SessionEventType = SessionEvent['type'];

/** Minimal context the state-machine guards inspect. */
export interface RuntimeContext {
  state: SessionRuntimeState;
  commitInFlight: boolean;
  stageReady: boolean;
  currentGenerationId: number;
  currentTurn: { id: string; generationId: number } | null;
}

export interface EndpointDecision {
  shouldCommit: boolean;
  completeProbability: number;
  incompleteReason:
    | 'none'
    | 'trailing_conjunction'
    | 'unfinished_list'
    | 'setup_without_conclusion'
    | 'self_correction'
    | 'too_short'
    | 'other';
}

export interface TranscriptCleanupResult {
  cleanedText: string;
  paragraphs: string[];
  glossaryCorrections: Array<{ from: string; to: string; glossaryTermId: string }>;
  uncertainTerms: Array<{ raw: string; proposed: string | null; reason: string }>;
  materialChanges: Array<{
    before: string;
    after: string;
    type: 'deduplication' | 'punctuation' | 'filler' | 'terminology' | 'other';
  }>;
}

export type InterviewerActionType = 'ask' | 'complete';

export type QualityFlag =
  | 'none'
  | 'answer_was_incomplete'
  | 'answer_contradicted_source'
  | 'answer_repeated_prior_content'
  | 'needs_specific_example'
  | 'needs_clarification';

export interface NextInterviewerAction {
  action: InterviewerActionType;
  spokenText: string;
  questionType: QuestionType;
  targetCoverageItemIds: CoverageItemId[];
  coverageUpdates: Array<{
    coverageItemId: CoverageItemId;
    status: CoverageStatus;
    evidenceTurnIds: string[];
  }>;
  followUpCounts: Array<{ coverageItemId: CoverageItemId; count: number }>;
  updatedSessionSummary: string;
  currentSectionId: string | null;
  shouldCloseAfterAnswer: boolean;
  qualityFlags: QualityFlag[];
}

export type QuestionViolation =
  | 'empty'
  | 'too_many_words'
  | 'multiple_question_marks'
  | 'no_question_when_action_ask'
  | 'markdown'
  | 'mentions_internal_system'
  | 'repeats_recent_question'
  | 'invalid_coverage_id'
  | 'contains_stage_direction';

export interface QuestionValidation {
  valid: boolean;
  wordCount: number;
  estimatedDurationMs: number;
  violations: QuestionViolation[];
}
