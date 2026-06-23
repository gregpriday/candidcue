import type {
  ProjectId,
  PlanId,
  SessionId,
  TurnId,
  ProjectAggregate,
  ProjectSummary,
  SaveProjectInput,
  InterviewPlan,
  InterviewSession,
  SessionAggregate,
  SessionCoverageItem,
  CreateSessionInput,
  AppendTurnInput,
  InterviewTurn,
  AnswerRecord,
  EndpointReason,
} from '../domain';

/**
 * Persistence boundary (spec §10.4). The concrete SQLite implementation is
 * hidden behind this interface so domain code never runs SQL and the storage
 * engine can change without touching the session domain.
 */
export interface CandidCueRepository {
  migrate(): Promise<void>;
  close(): Promise<void>;

  // Projects ----------------------------------------------------------------
  listProjects(): Promise<ProjectSummary[]>;
  getProject(id: ProjectId): Promise<ProjectAggregate | null>;
  saveProject(input: SaveProjectInput): Promise<ProjectAggregate>;
  deleteProject(id: ProjectId): Promise<void>;

  // Plans -------------------------------------------------------------------
  savePlan(plan: InterviewPlan): Promise<void>;
  getPlan(planId: PlanId): Promise<InterviewPlan | null>;
  getLatestPlan(projectId: ProjectId): Promise<InterviewPlan | null>;
  setActivePlan(projectId: ProjectId, planId: PlanId): Promise<void>;

  // Sessions ----------------------------------------------------------------
  createSession(input: CreateSessionInput): Promise<InterviewSession>;
  updateSession(session: InterviewSession): Promise<void>;
  getSession(id: SessionId): Promise<SessionAggregate | null>;
  listSessions(projectId: ProjectId): Promise<InterviewSession[]>;
  findResumableSessions(): Promise<InterviewSession[]>;

  // Turns -------------------------------------------------------------------
  /** Atomically write a full turn plus coverage/summary/ordinal (spec §10.6). */
  appendTurnAtomic(input: AppendTurnInput): Promise<void>;
  /** Durably record the raw transcript before interviewer thinking begins. */
  recordRawAnswer(
    sessionId: SessionId,
    turnId: TurnId,
    rawTranscript: string,
    endpointReason: EndpointReason,
  ): Promise<void>;
  getRecentTurns(sessionId: SessionId, limit: number): Promise<InterviewTurn[]>;
  /** Apply a post-session user edit to the cleaned/edited transcript only. */
  updateUserEditedTranscript(turnId: TurnId, userEditedTranscript: string): Promise<void>;
  getTurn(turnId: TurnId): Promise<InterviewTurn | null>;
  saveCoverage(sessionId: SessionId, coverage: SessionCoverageItem[]): Promise<void>;
  saveTurnAnswer(turnId: TurnId, answer: AnswerRecord): Promise<void>;

  // Settings ----------------------------------------------------------------
  getSetting<T>(key: string): Promise<T | null>;
  setSetting<T>(key: string, value: T): Promise<void>;
}
