import type {
  ProjectId,
  PlanId,
  SessionId,
  TurnId,
  ProjectAggregate,
  ProjectSummary,
  SaveProjectInput,
  Project,
  ProjectDocument,
  InterviewPlan,
  InterviewSession,
  SessionAggregate,
  SessionCoverageItem,
  CreateSessionInput,
  AppendTurnInput,
  InterviewTurn,
  AnswerRecord,
  EndpointReason,
} from '@shared/domain';
import { newId } from '@shared/domain';
import { hashFromProjectDocuments } from '@shared/utils';

import type { CandidCueRepository } from '@shared/contracts/repository';
import { minimalAnswer } from './sqlite-repository';

/** Internal record bundling a stored project with its documents. */
interface StoredProject {
  project: Project;
  documents: ProjectDocument[];
}

/** Internal record bundling a stored session with its live coverage. */
interface StoredSession {
  session: InterviewSession;
  coverage: SessionCoverageItem[];
}

/** Statuses considered resumable — kept identical to the SQLite implementation. */
const RESUMABLE_STATUSES: ReadonlySet<InterviewSession['status']> = new Set([
  'active',
  'paused',
  'recovering',
]);

/**
 * Pure in-memory implementation of {@link CandidCueRepository}. It mirrors the
 * exact observable behaviour of {@link SqliteRepository} (id generation,
 * timestamps, source hashing, atomic replace semantics, raw-answer protection)
 * using `Map`s so orchestrator/unit tests can run without the native sqlite
 * module. Deep clones on read/write keep callers from mutating stored state.
 */
export class MemoryRepository implements CandidCueRepository {
  private readonly projects = new Map<ProjectId, StoredProject>();
  private readonly plans = new Map<PlanId, InterviewPlan>();
  private readonly sessions = new Map<SessionId, StoredSession>();
  /** Turns keyed by session id, kept sorted by ordinal ascending. */
  private readonly turnsBySession = new Map<SessionId, InterviewTurn[]>();
  /** Reverse lookup from turn id -> owning session id. */
  private readonly turnSession = new Map<TurnId, SessionId>();
  private readonly settings = new Map<string, unknown>();

  // --- lifecycle -----------------------------------------------------------

  async migrate(): Promise<void> {
    // No-op: an in-memory store has no schema to build. Idempotent by nature.
  }

  async close(): Promise<void> {
    this.projects.clear();
    this.plans.clear();
    this.sessions.clear();
    this.turnsBySession.clear();
    this.turnSession.clear();
    this.settings.clear();
  }

  // --- projects ------------------------------------------------------------

  async listProjects(): Promise<ProjectSummary[]> {
    const summaries: ProjectSummary[] = [];
    for (const { project } of this.projects.values()) {
      const sessions = [...this.sessions.values()].filter(
        (s) => s.session.projectId === project.id,
      );
      const lastSessionAt = sessions.reduce<string | null>((latest, s) => {
        const created = s.session.createdAt;
        return latest === null || created > latest ? created : latest;
      }, null);
      summaries.push({
        id: project.id,
        title: project.title,
        status: project.status,
        interviewerCharacterId: project.interviewerCharacterId,
        sessionCount: sessions.length,
        lastSessionAt,
        updatedAt: project.updatedAt,
      });
    }
    // Newest-updated first, matching the SQLite ORDER BY updated_at DESC.
    summaries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return summaries;
  }

  async getProject(id: ProjectId): Promise<ProjectAggregate | null> {
    const stored = this.projects.get(id);
    if (!stored) return null;
    const activePlanId = stored.project.activePlanVersionId;
    const activePlan = activePlanId ? (this.plans.get(activePlanId) ?? null) : null;
    return {
      project: clone(stored.project),
      documents: clone(this.sortedDocuments(stored.documents)),
      activePlan: activePlan ? clone(activePlan) : null,
    };
  }

  async saveProject(input: SaveProjectInput): Promise<ProjectAggregate> {
    const now = new Date().toISOString();
    const projectId = input.id ?? newId();
    const existing = this.projects.get(projectId);

    const documents: ProjectDocument[] = input.documents.map((doc) => ({
      id: doc.id ?? newId(),
      projectId,
      kind: doc.kind,
      title: doc.title,
      originalFilename: doc.originalFilename ?? null,
      mimeType: doc.mimeType,
      content: doc.content,
      sortOrder: doc.sortOrder,
      createdAt: now,
      updatedAt: now,
    }));

    const sourceHash = hashFromProjectDocuments(documents);

    const project: Project = {
      id: projectId,
      title: input.title,
      status: existing?.project.status ?? 'draft',
      audience: input.audience ?? null,
      intendedOutcome: input.intendedOutcome ?? null,
      targetMode: input.targetMode,
      targetValue: input.targetValue,
      interviewerCharacterId: input.interviewerCharacterId,
      notesToInterviewer: input.notesToInterviewer ?? null,
      createdAt: existing?.project.createdAt ?? now,
      updatedAt: now,
      sourceHash,
      activePlanVersionId: existing?.project.activePlanVersionId ?? null,
    };

    this.projects.set(projectId, { project: clone(project), documents: clone(documents) });

    const aggregate = await this.getProject(projectId);
    if (!aggregate) throw new Error(`saveProject: project ${projectId} missing after write`);
    return aggregate;
  }

  async deleteProject(id: ProjectId): Promise<void> {
    this.projects.delete(id);
    // Cascade: drop dependent plans, sessions and turns to mirror FK semantics.
    for (const [planId, plan] of [...this.plans]) {
      if (plan.projectId === id) this.plans.delete(planId);
    }
    for (const [sessionId, stored] of [...this.sessions]) {
      if (stored.session.projectId === id) this.removeSession(sessionId);
    }
  }

  // --- plans ---------------------------------------------------------------

  async savePlan(plan: InterviewPlan): Promise<void> {
    this.plans.set(plan.id, clone(plan));
  }

  async getPlan(planId: PlanId): Promise<InterviewPlan | null> {
    const plan = this.plans.get(planId);
    return plan ? clone(plan) : null;
  }

  async getLatestPlan(projectId: ProjectId): Promise<InterviewPlan | null> {
    let latest: InterviewPlan | null = null;
    for (const plan of this.plans.values()) {
      if (plan.projectId !== projectId) continue;
      if (latest === null || plan.version > latest.version) latest = plan;
    }
    return latest ? clone(latest) : null;
  }

  async setActivePlan(projectId: ProjectId, planId: PlanId): Promise<void> {
    const stored = this.projects.get(projectId);
    if (!stored) return;
    stored.project.activePlanVersionId = planId;
    stored.project.updatedAt = new Date().toISOString();
  }

  // --- sessions ------------------------------------------------------------

  async createSession(input: CreateSessionInput): Promise<InterviewSession> {
    const now = new Date().toISOString();
    const session: InterviewSession = {
      id: newId(),
      projectId: input.projectId,
      planVersionId: input.planVersionId,
      characterId: input.characterId,
      status: 'preflight',
      endpointMode: input.endpointMode,
      selectedInputDeviceId: input.selectedInputDeviceId,
      selectedOutputDeviceId: input.selectedOutputDeviceId,
      selectedDisplayId: input.selectedDisplayId,
      startedAt: null,
      endedAt: null,
      rollingSummary: '',
      currentTurnOrdinal: 0,
      settingsSnapshot: input.settingsSnapshot,
      createdAt: now,
      updatedAt: now,
    };

    this.sessions.set(session.id, {
      session: clone(session),
      coverage: clone(input.coverage),
    });
    this.turnsBySession.set(session.id, []);
    return clone(session);
  }

  async updateSession(session: InterviewSession): Promise<void> {
    const stored = this.sessions.get(session.id);
    if (!stored) return;
    stored.session = { ...clone(session), updatedAt: new Date().toISOString() };
  }

  async getSession(id: SessionId): Promise<SessionAggregate | null> {
    const stored = this.sessions.get(id);
    if (!stored) return null;
    return {
      session: clone(stored.session),
      coverage: clone(stored.coverage),
      turns: clone(this.turnsBySession.get(id) ?? []),
    };
  }

  async listSessions(projectId: ProjectId): Promise<InterviewSession[]> {
    return [...this.sessions.values()]
      .map((s) => s.session)
      .filter((s) => s.projectId === projectId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .map(clone);
  }

  async findResumableSessions(): Promise<InterviewSession[]> {
    return [...this.sessions.values()]
      .map((s) => s.session)
      .filter((s) => RESUMABLE_STATUSES.has(s.status))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
      .map(clone);
  }

  // --- turns ---------------------------------------------------------------

  async appendTurnAtomic(input: AppendTurnInput): Promise<void> {
    const stored = this.sessions.get(input.sessionId);
    if (!stored) throw new Error(`appendTurnAtomic: session ${input.sessionId} not found`);

    this.upsertTurn(input.sessionId, clone(input.turn));
    stored.coverage = clone(input.coverage);
    stored.session.rollingSummary = input.rollingSummary;
    stored.session.currentTurnOrdinal = input.currentTurnOrdinal;
    stored.session.updatedAt = new Date().toISOString();
  }

  async recordRawAnswer(
    _sessionId: SessionId,
    turnId: TurnId,
    rawTranscript: string,
    endpointReason: EndpointReason,
  ): Promise<void> {
    const turn = this.findTurn(turnId);
    if (!turn) return;
    // Never clobber a fuller answer (one with a non-empty cleaned transcript).
    if (turn.answer && turn.answer.cleanedTranscript && turn.answer.cleanedTranscript.length > 0) {
      return;
    }
    turn.answer = minimalAnswer(rawTranscript, endpointReason);
  }

  async getRecentTurns(sessionId: SessionId, limit: number): Promise<InterviewTurn[]> {
    const turns = this.turnsBySession.get(sessionId) ?? [];
    // Take the newest `limit` (turns are stored ascending) and return ascending.
    const start = Math.max(0, turns.length - limit);
    return clone(turns.slice(start));
  }

  async updateUserEditedTranscript(
    turnId: TurnId,
    userEditedTranscript: string,
  ): Promise<void> {
    const turn = this.findTurn(turnId);
    if (!turn?.answer) return;
    turn.answer.userEditedTranscript = userEditedTranscript;
  }

  async getTurn(turnId: TurnId): Promise<InterviewTurn | null> {
    const turn = this.findTurn(turnId);
    return turn ? clone(turn) : null;
  }

  async saveCoverage(sessionId: SessionId, coverage: SessionCoverageItem[]): Promise<void> {
    const stored = this.sessions.get(sessionId);
    if (!stored) return;
    stored.coverage = clone(coverage);
  }

  async saveTurnAnswer(turnId: TurnId, answer: AnswerRecord): Promise<void> {
    const turn = this.findTurn(turnId);
    if (!turn) return;
    turn.answer = clone(answer);
    turn.completedAt = new Date().toISOString();
  }

  // --- settings ------------------------------------------------------------

  async getSetting<T>(key: string): Promise<T | null> {
    if (!this.settings.has(key)) return null;
    // Round-trip through JSON to mirror the SQLite serialize/deserialize path.
    return JSON.parse(JSON.stringify(this.settings.get(key))) as T;
  }

  async setSetting<T>(key: string, value: T): Promise<void> {
    this.settings.set(key, JSON.parse(JSON.stringify(value)));
  }

  // --- internals -----------------------------------------------------------

  private sortedDocuments(documents: ProjectDocument[]): ProjectDocument[] {
    return [...documents].sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  private upsertTurn(sessionId: SessionId, turn: InterviewTurn): void {
    const list = this.turnsBySession.get(sessionId) ?? [];
    const idx = list.findIndex((t) => t.id === turn.id);
    if (idx >= 0) {
      list[idx] = turn;
    } else {
      list.push(turn);
      this.turnSession.set(turn.id, sessionId);
    }
    list.sort((a, b) => a.ordinal - b.ordinal);
    this.turnsBySession.set(sessionId, list);
  }

  private findTurn(turnId: TurnId): InterviewTurn | undefined {
    const sessionId = this.turnSession.get(turnId);
    if (!sessionId) return undefined;
    return this.turnsBySession.get(sessionId)?.find((t) => t.id === turnId);
  }

  private removeSession(sessionId: SessionId): void {
    this.sessions.delete(sessionId);
    const turns = this.turnsBySession.get(sessionId) ?? [];
    for (const turn of turns) this.turnSession.delete(turn.id);
    this.turnsBySession.delete(sessionId);
  }
}

/** Structured deep clone so stored state and caller state never alias. */
function clone<T>(value: T): T {
  return structuredClone(value);
}
