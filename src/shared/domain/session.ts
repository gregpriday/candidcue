import type { ProjectId, SessionId, PlanId, CoverageItemId } from './ids';
import type { CoverageItem } from './plan';
import type { InterviewTurn } from './turn';

export type SessionStatus =
  | 'preflight'
  | 'ready'
  | 'active'
  | 'paused'
  | 'recovering'
  | 'completed'
  | 'abandoned';

export type EndpointMode = 'manual' | 'conservative' | 'balanced';

export interface SessionSettingsSnapshot {
  endpointMode: EndpointMode;
  captionsEnabled: boolean;
  mirrorStage: boolean;
  zoom: number;
  verticalOffsetPercent: number;
  maxQuestionWords: number;
  maxQuestionAudioMs: number;
  recentTurnCount: number;
  characterId: string;
  ttsVoiceId: string;
}

export interface InterviewSession {
  id: SessionId;
  projectId: ProjectId;
  planVersionId: PlanId;
  characterId: string;
  status: SessionStatus;
  endpointMode: EndpointMode;
  selectedInputDeviceId: string | null;
  selectedOutputDeviceId: string | null;
  selectedDisplayId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  rollingSummary: string;
  currentTurnOrdinal: number;
  settingsSnapshot: SessionSettingsSnapshot;
  createdAt: string;
  updatedAt: string;
}

/** Live coverage state for a session (denormalized from the plan at start). */
export interface SessionCoverageItem extends CoverageItem {
  followUpCount: number;
}

export interface SessionAggregate {
  session: InterviewSession;
  coverage: SessionCoverageItem[];
  turns: InterviewTurn[];
}

export interface CreateSessionInput {
  projectId: ProjectId;
  planVersionId: PlanId;
  characterId: string;
  endpointMode: EndpointMode;
  selectedInputDeviceId: string | null;
  selectedOutputDeviceId: string | null;
  selectedDisplayId: string | null;
  settingsSnapshot: SessionSettingsSnapshot;
  coverage: SessionCoverageItem[];
}

export interface AppendTurnInput {
  sessionId: SessionId;
  turn: InterviewTurn;
  coverage: SessionCoverageItem[];
  rollingSummary: string;
  currentTurnOrdinal: number;
}

export interface CoverageUpdateInput {
  coverageItemId: CoverageItemId;
  status: SessionCoverageItem['status'];
  evidenceTurnIds: string[];
}
