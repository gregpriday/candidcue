import { DatabaseSync } from 'node:sqlite';

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
  InterviewBrief,
  InterviewSession,
  SessionAggregate,
  SessionCoverageItem,
  SessionSettingsSnapshot,
  CreateSessionInput,
  AppendTurnInput,
  InterviewTurn,
  QuestionRecord,
  AnswerRecord,
  CoverageDelta,
  EndpointReason,
  PlanStatus,
} from '@shared/domain';
import { newId, deriveProjectPlanState } from '@shared/domain';
import { hashProjectPreparationFromDocuments } from '@shared/utils';
import { materializeSavedDocuments, normalizeLoadedDocuments } from './project-document-diff';

import type { CandidCueRepository } from '@shared/contracts/repository';
import { MIGRATIONS } from './migrations/index';

/**
 * The narrow slice of `node:sqlite`'s `DatabaseSync` that this repository
 * relies on. Declaring it explicitly keeps the dependency obvious and lets a
 * caller inject a compatible handle (e.g. an already-open shared connection)
 * without dragging in the full native type surface.
 */
export interface SqliteHandle {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface SqliteStatement {
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
}

type SqlValue = string | number | bigint | null | Uint8Array;

/** Row shapes as returned by SQLite (column names match the schema). */
interface ProjectRow {
  id: string;
  title: string;
  status: string;
  audience: string | null;
  intended_outcome: string | null;
  target_mode: string;
  target_value: number;
  interviewer_character_id: string;
  notes_to_interviewer: string | null;
  source_hash: string;
  active_plan_version_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ProjectDocumentRow {
  id: string;
  project_id: string;
  kind: string;
  title: string;
  original_filename: string | null;
  mime_type: string;
  content: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface PlanRow {
  id: string;
  project_id: string;
  version: number;
  source_hash: string;
  status: string;
  brief_json: string;
  prompt_version: string;
  created_at: string;
}

interface SessionRow {
  id: string;
  project_id: string;
  plan_version_id: string;
  character_id: string;
  status: string;
  endpoint_mode: string;
  selected_input_device_id: string | null;
  selected_output_device_id: string | null;
  selected_display_id: string | null;
  rolling_summary: string;
  current_turn_ordinal: number;
  settings_snapshot_json: string;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

interface CoverageRow {
  session_id: string;
  coverage_item_id: string;
  label: string;
  objective: string;
  priority: string;
  status: string;
  evidence_turn_ids_json: string;
  follow_up_count: number;
  source_refs_json: string;
  max_follow_ups: number;
}

interface TurnRow {
  id: string;
  session_id: string;
  ordinal: number;
  state: string;
  question_json: string;
  answer_json: string | null;
  coverage_delta_json: string;
  created_at: string;
  completed_at: string | null;
}

interface SettingRow {
  value_json: string;
}

/** Status values that count as "resumable" for crash recovery (spec §10.6). */
const RESUMABLE_STATUSES: readonly InterviewSession['status'][] = [
  'active',
  'paused',
  'recovering',
];

/**
 * SQLite-backed implementation of {@link CandidCueRepository}. All multi-row
 * writes that must be consistent (project + documents, turn + coverage +
 * session counters) run inside explicit transactions so a crash never leaves
 * half-written interview state.
 */
export class SqliteRepository implements CandidCueRepository {
  private readonly db: SqliteHandle;

  /**
   * @param dbPathOrHandle A filesystem path (or `:memory:`) to open a fresh
   *   `DatabaseSync`, or an already-open handle to reuse. Foreign keys are
   *   enabled immediately so cascades and FK constraints are active.
   */
  constructor(dbPathOrHandle: string | SqliteHandle) {
    this.db =
      typeof dbPathOrHandle === 'string'
        ? (new DatabaseSync(dbPathOrHandle) as unknown as SqliteHandle)
        : dbPathOrHandle;
    this.db.exec('PRAGMA foreign_keys=ON;');
  }

  // --- lifecycle -----------------------------------------------------------

  async migrate(): Promise<void> {
    // Ensure the ledger exists before we read it; the v1 migration also creates
    // it but we need it queryable up front to compute the pending set.
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);`,
    );

    const appliedRows = this.db
      .prepare('SELECT version FROM schema_migrations')
      .all() as { version: number }[];
    const applied = new Set(appliedRows.map((r) => r.version));

    const pending = MIGRATIONS.filter((m) => !applied.has(m.version)).sort(
      (a, b) => a.version - b.version,
    );
    if (pending.length === 0) return;

    this.transaction(() => {
      const insert = this.db.prepare(
        'INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)',
      );
      const now = new Date().toISOString();
      for (const migration of pending) {
        migration.up(this.db);
        insert.run(migration.version, now);
      }
    });
  }

  async close(): Promise<void> {
    this.db.close();
  }

  // --- projects ------------------------------------------------------------

  async listProjects(): Promise<ProjectSummary[]> {
    // One aggregate query joins session counts/last-session timestamp so the
    // list view never N+1s. LEFT JOIN keeps projects with zero sessions.
    const rows = this.db
      .prepare(
        `SELECT p.id, p.title, p.status, p.interviewer_character_id, p.updated_at,
                p.source_hash, p.active_plan_version_id,
                pl.status AS plan_status, pl.source_hash AS plan_source_hash,
                COUNT(s.id) AS session_count,
                MAX(s.created_at) AS last_session_at
           FROM projects p
           LEFT JOIN sessions s ON s.project_id = p.id
           LEFT JOIN interview_plans pl ON pl.id = p.active_plan_version_id
          GROUP BY p.id
          ORDER BY p.updated_at DESC`,
      )
      .all() as {
      id: string;
      title: string;
      status: string;
      interviewer_character_id: string;
      updated_at: string;
      source_hash: string;
      active_plan_version_id: string | null;
      plan_status: string | null;
      plan_source_hash: string | null;
      session_count: number;
      last_session_at: string | null;
    }[];

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status as ProjectSummary['status'],
      planState: deriveProjectPlanState(
        { sourceHash: r.source_hash, activePlanVersionId: r.active_plan_version_id },
        r.plan_status != null && r.plan_source_hash != null
          ? { status: r.plan_status as PlanStatus, sourceHash: r.plan_source_hash }
          : null,
      ),
      interviewerCharacterId: r.interviewer_character_id,
      sessionCount: Number(r.session_count),
      lastSessionAt: r.last_session_at,
      updatedAt: r.updated_at,
    }));
  }

  async getProject(id: ProjectId): Promise<ProjectAggregate | null> {
    const row = this.db
      .prepare('SELECT * FROM projects WHERE id = ?')
      .get(id) as ProjectRow | undefined;
    if (!row) return null;

    const project = mapProjectRow(row);
    const documents = normalizeLoadedDocuments(this.loadDocuments(id));
    const activePlan = row.active_plan_version_id
      ? await this.getPlan(row.active_plan_version_id)
      : null;

    return { project, documents, activePlan, planState: deriveProjectPlanState(project, activePlan) };
  }

  async saveProject(input: SaveProjectInput): Promise<ProjectAggregate> {
    const now = new Date().toISOString();
    const isUpdate = Boolean(input.id);
    const projectId = input.id ?? newId();

    // Diff against the existing documents so we can compute the source hash and
    // persist alongside the project: existing docs keep their id + createdAt and
    // only bump updatedAt on real changes, new docs get fresh ids (minted before
    // hashing), and a foreign document id is rejected.
    const existingDocs = isUpdate ? this.loadDocuments(projectId) : [];
    const existingById = new Map(existingDocs.map((doc) => [doc.id, doc] as const));
    const documents = materializeSavedDocuments(input, projectId, now, existingById, newId);

    const sourceHash = hashProjectPreparationFromDocuments(
      {
        audience: input.audience ?? null,
        intendedOutcome: input.intendedOutcome ?? null,
        targetMode: input.targetMode,
        targetValue: input.targetValue,
        interviewerCharacterId: input.interviewerCharacterId,
        notesToInterviewer: input.notesToInterviewer ?? null,
      },
      documents,
    );

    this.transaction(() => {
      const existing = isUpdate
        ? (this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as
            | ProjectRow
            | undefined)
        : undefined;
      const createdAt = existing?.created_at ?? now;
      // Preserve a project's status/active plan across edits; a fresh project
      // starts as a draft with no active plan.
      const status = existing?.status ?? 'draft';
      const activePlanVersionId = existing?.active_plan_version_id ?? null;

      this.db
        .prepare(
          `INSERT INTO projects
             (id, title, status, audience, intended_outcome, target_mode, target_value,
              interviewer_character_id, notes_to_interviewer, source_hash,
              active_plan_version_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             audience = excluded.audience,
             intended_outcome = excluded.intended_outcome,
             target_mode = excluded.target_mode,
             target_value = excluded.target_value,
             interviewer_character_id = excluded.interviewer_character_id,
             notes_to_interviewer = excluded.notes_to_interviewer,
             source_hash = excluded.source_hash,
             updated_at = excluded.updated_at`,
        )
        .run(
          projectId,
          input.title,
          status,
          input.audience ?? null,
          input.intendedOutcome ?? null,
          input.targetMode,
          input.targetValue,
          input.interviewerCharacterId,
          input.notesToInterviewer ?? null,
          sourceHash,
          activePlanVersionId,
          createdAt,
          now,
        );

      // Diff the document set: delete only the documents that are gone, then
      // upsert the rest. Existing rows keep their created_at (the conflict path
      // never touches it); only materialized changes advance updated_at.
      const incomingIds = new Set(documents.map((doc) => doc.id));
      const deleteDoc = this.db.prepare('DELETE FROM project_documents WHERE id = ?');
      for (const existing of existingDocs) {
        if (!incomingIds.has(existing.id)) deleteDoc.run(existing.id);
      }
      const upsertDoc = this.db.prepare(
        `INSERT INTO project_documents
           (id, project_id, kind, title, original_filename, mime_type, content,
            sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           title = excluded.title,
           original_filename = excluded.original_filename,
           mime_type = excluded.mime_type,
           content = excluded.content,
           sort_order = excluded.sort_order,
           updated_at = excluded.updated_at`,
      );
      for (const doc of documents) {
        upsertDoc.run(
          doc.id,
          projectId,
          doc.kind,
          doc.title,
          doc.originalFilename,
          doc.mimeType,
          doc.content,
          doc.sortOrder,
          doc.createdAt,
          doc.updatedAt,
        );
      }
    });

    const aggregate = await this.getProject(projectId);
    // getProject can only return null if the row vanished mid-transaction,
    // which cannot happen here — assert for the type checker.
    if (!aggregate) throw new Error(`saveProject: project ${projectId} missing after write`);
    return aggregate;
  }

  async deleteProject(id: ProjectId): Promise<void> {
    // ON DELETE CASCADE handles documents, plans, sessions, coverage and turns.
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  // --- plans ---------------------------------------------------------------

  async savePlan(plan: InterviewPlan): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO interview_plans
           (id, project_id, version, source_hash, status, brief_json, prompt_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           source_hash = excluded.source_hash,
           status = excluded.status,
           brief_json = excluded.brief_json,
           prompt_version = excluded.prompt_version`,
      )
      .run(
        plan.id,
        plan.projectId,
        plan.version,
        plan.sourceHash,
        plan.status,
        JSON.stringify(plan.brief),
        plan.promptVersion,
        plan.createdAt,
      );
  }

  async getPlan(planId: PlanId): Promise<InterviewPlan | null> {
    const row = this.db
      .prepare('SELECT * FROM interview_plans WHERE id = ?')
      .get(planId) as PlanRow | undefined;
    return row ? mapPlanRow(row) : null;
  }

  async getLatestPlan(projectId: ProjectId): Promise<InterviewPlan | null> {
    const row = this.db
      .prepare(
        'SELECT * FROM interview_plans WHERE project_id = ? ORDER BY version DESC LIMIT 1',
      )
      .get(projectId) as PlanRow | undefined;
    return row ? mapPlanRow(row) : null;
  }

  async setActivePlan(projectId: ProjectId, planId: PlanId): Promise<void> {
    this.db
      .prepare('UPDATE projects SET active_plan_version_id = ?, updated_at = ? WHERE id = ?')
      .run(planId, new Date().toISOString(), projectId);
  }

  async updateProjectSourceHash(projectId: ProjectId, sourceHash: string): Promise<void> {
    this.db.prepare('UPDATE projects SET source_hash = ? WHERE id = ?').run(sourceHash, projectId);
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

    this.transaction(() => {
      this.insertSessionRow(session);
      const insertCov = this.db.prepare(coverageInsertSql());
      for (const item of input.coverage) {
        runCoverageInsert(insertCov, session.id, item);
      }
    });

    return session;
  }

  async updateSession(session: InterviewSession): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE sessions SET
           status = ?, endpoint_mode = ?, character_id = ?,
           selected_input_device_id = ?, selected_output_device_id = ?, selected_display_id = ?,
           rolling_summary = ?, current_turn_ordinal = ?, settings_snapshot_json = ?,
           started_at = ?, ended_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        session.status,
        session.endpointMode,
        session.characterId,
        session.selectedInputDeviceId,
        session.selectedOutputDeviceId,
        session.selectedDisplayId,
        session.rollingSummary,
        session.currentTurnOrdinal,
        JSON.stringify(session.settingsSnapshot),
        session.startedAt,
        session.endedAt,
        now,
        session.id,
      );
  }

  async getSession(id: SessionId): Promise<SessionAggregate | null> {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(id) as SessionRow | undefined;
    if (!row) return null;

    const session = mapSessionRow(row);
    const coverage = (
      this.db.prepare('SELECT * FROM session_coverage WHERE session_id = ?').all(id) as CoverageRow[]
    ).map(mapCoverageRow);
    const turns = (
      this.db
        .prepare('SELECT * FROM turns WHERE session_id = ? ORDER BY ordinal ASC')
        .all(id) as TurnRow[]
    ).map(mapTurnRow);

    return { session, coverage, turns };
  }

  async listSessions(projectId: ProjectId): Promise<InterviewSession[]> {
    const rows = this.db
      .prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY created_at DESC')
      .all(projectId) as SessionRow[];
    return rows.map(mapSessionRow);
  }

  async findResumableSessions(): Promise<InterviewSession[]> {
    const placeholders = RESUMABLE_STATUSES.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions WHERE status IN (${placeholders}) ORDER BY updated_at DESC`,
      )
      .all(...RESUMABLE_STATUSES) as SessionRow[];
    return rows.map(mapSessionRow);
  }

  // --- turns ---------------------------------------------------------------

  async appendTurnAtomic(input: AppendTurnInput): Promise<void> {
    const now = new Date().toISOString();
    this.transaction(() => {
      this.upsertTurnRow(input.turn);

      // Replace the session's live coverage with the post-turn snapshot.
      this.db.prepare('DELETE FROM session_coverage WHERE session_id = ?').run(input.sessionId);
      const insertCov = this.db.prepare(coverageInsertSql());
      for (const item of input.coverage) {
        runCoverageInsert(insertCov, input.sessionId, item);
      }

      this.db
        .prepare(
          'UPDATE sessions SET rolling_summary = ?, current_turn_ordinal = ?, updated_at = ? WHERE id = ?',
        )
        .run(input.rollingSummary, input.currentTurnOrdinal, now, input.sessionId);
    });
  }

  async recordRawAnswer(
    _sessionId: SessionId,
    turnId: TurnId,
    rawTranscript: string,
    endpointReason: EndpointReason,
  ): Promise<void> {
    // Durability checkpoint: write a minimal answer only if a fuller one has not
    // already landed, so a later cleaned/edited answer is never clobbered by a
    // late-arriving raw checkpoint (spec §10.6 / §14).
    const row = this.db
      .prepare('SELECT answer_json FROM turns WHERE id = ?')
      .get(turnId) as { answer_json: string | null } | undefined;
    if (!row) return;
    if (row.answer_json) {
      const existing = JSON.parse(row.answer_json) as AnswerRecord;
      // A non-empty cleaned transcript means a fuller answer already exists.
      if (existing.cleanedTranscript && existing.cleanedTranscript.length > 0) return;
    }

    const minimal = minimalAnswer(rawTranscript, endpointReason);
    this.db.prepare('UPDATE turns SET answer_json = ? WHERE id = ?').run(
      JSON.stringify(minimal),
      turnId,
    );
  }

  async getRecentTurns(sessionId: SessionId, limit: number): Promise<InterviewTurn[]> {
    // Pull the newest `limit` turns descending then reverse to chronological so
    // callers receive oldest-first context for the model window.
    const rows = this.db
      .prepare('SELECT * FROM turns WHERE session_id = ? ORDER BY ordinal DESC LIMIT ?')
      .all(sessionId, limit) as TurnRow[];
    return rows.map(mapTurnRow).reverse();
  }

  async updateUserEditedTranscript(
    turnId: TurnId,
    userEditedTranscript: string,
  ): Promise<void> {
    const row = this.db
      .prepare('SELECT answer_json FROM turns WHERE id = ?')
      .get(turnId) as { answer_json: string | null } | undefined;
    if (!row?.answer_json) return;
    const answer = JSON.parse(row.answer_json) as AnswerRecord;
    answer.userEditedTranscript = userEditedTranscript;
    this.db.prepare('UPDATE turns SET answer_json = ? WHERE id = ?').run(
      JSON.stringify(answer),
      turnId,
    );
  }

  async getTurn(turnId: TurnId): Promise<InterviewTurn | null> {
    const row = this.db
      .prepare('SELECT * FROM turns WHERE id = ?')
      .get(turnId) as TurnRow | undefined;
    return row ? mapTurnRow(row) : null;
  }

  async saveCoverage(sessionId: SessionId, coverage: SessionCoverageItem[]): Promise<void> {
    this.transaction(() => {
      this.db.prepare('DELETE FROM session_coverage WHERE session_id = ?').run(sessionId);
      const insertCov = this.db.prepare(coverageInsertSql());
      for (const item of coverage) {
        runCoverageInsert(insertCov, sessionId, item);
      }
    });
  }

  async saveTurnAnswer(turnId: TurnId, answer: AnswerRecord): Promise<void> {
    this.db
      .prepare('UPDATE turns SET answer_json = ?, completed_at = ? WHERE id = ?')
      .run(JSON.stringify(answer), new Date().toISOString(), turnId);
  }

  // --- settings ------------------------------------------------------------

  async getSetting<T>(key: string): Promise<T | null> {
    const row = this.db
      .prepare('SELECT value_json FROM settings WHERE key = ?')
      .get(key) as SettingRow | undefined;
    return row ? (JSON.parse(row.value_json) as T) : null;
  }

  async setSetting<T>(key: string, value: T): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO settings(key, value_json, updated_at) VALUES(?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), new Date().toISOString());
  }

  // --- internals -----------------------------------------------------------

  /** Run `fn` inside a SQLite transaction, rolling back on any thrown error. */
  private transaction(fn: () => void): void {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private loadDocuments(projectId: ProjectId): ProjectDocument[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM project_documents WHERE project_id = ? ORDER BY sort_order ASC, id ASC',
      )
      .all(projectId) as ProjectDocumentRow[];
    return rows.map(mapDocumentRow);
  }

  private insertSessionRow(session: InterviewSession): void {
    this.db
      .prepare(
        `INSERT INTO sessions
           (id, project_id, plan_version_id, character_id, status, endpoint_mode,
            selected_input_device_id, selected_output_device_id, selected_display_id,
            rolling_summary, current_turn_ordinal, settings_snapshot_json,
            started_at, ended_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.projectId,
        session.planVersionId,
        session.characterId,
        session.status,
        session.endpointMode,
        session.selectedInputDeviceId,
        session.selectedOutputDeviceId,
        session.selectedDisplayId,
        session.rollingSummary,
        session.currentTurnOrdinal,
        JSON.stringify(session.settingsSnapshot),
        session.startedAt,
        session.endedAt,
        session.createdAt,
        session.updatedAt,
      );
  }

  private upsertTurnRow(turn: InterviewTurn): void {
    this.db
      .prepare(
        `INSERT INTO turns
           (id, session_id, ordinal, state, question_json, answer_json,
            coverage_delta_json, created_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           ordinal = excluded.ordinal,
           state = excluded.state,
           question_json = excluded.question_json,
           answer_json = excluded.answer_json,
           coverage_delta_json = excluded.coverage_delta_json,
           completed_at = excluded.completed_at`,
      )
      .run(
        turn.id,
        turn.sessionId,
        turn.ordinal,
        turn.state,
        JSON.stringify(turn.question),
        turn.answer ? JSON.stringify(turn.answer) : null,
        JSON.stringify(turn.coverageDelta),
        turn.createdAt,
        turn.completedAt,
      );
  }
}

// --- row <-> domain mappers (module-private, pure) -------------------------

function mapProjectRow(row: ProjectRow): Project {
  return {
    id: row.id,
    title: row.title,
    status: row.status as Project['status'],
    audience: row.audience,
    intendedOutcome: row.intended_outcome,
    targetMode: row.target_mode as Project['targetMode'],
    targetValue: Number(row.target_value),
    interviewerCharacterId: row.interviewer_character_id,
    notesToInterviewer: row.notes_to_interviewer,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sourceHash: row.source_hash,
    activePlanVersionId: row.active_plan_version_id,
  };
}

function mapDocumentRow(row: ProjectDocumentRow): ProjectDocument {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind as ProjectDocument['kind'],
    title: row.title,
    originalFilename: row.original_filename,
    mimeType: row.mime_type as ProjectDocument['mimeType'],
    content: row.content,
    sortOrder: Number(row.sort_order),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPlanRow(row: PlanRow): InterviewPlan {
  return {
    id: row.id,
    projectId: row.project_id,
    version: Number(row.version),
    sourceHash: row.source_hash,
    status: row.status as InterviewPlan['status'],
    brief: JSON.parse(row.brief_json) as InterviewBrief,
    promptVersion: row.prompt_version,
    createdAt: row.created_at,
  };
}

function mapSessionRow(row: SessionRow): InterviewSession {
  return {
    id: row.id,
    projectId: row.project_id,
    planVersionId: row.plan_version_id,
    characterId: row.character_id,
    status: row.status as InterviewSession['status'],
    endpointMode: row.endpoint_mode as InterviewSession['endpointMode'],
    selectedInputDeviceId: row.selected_input_device_id,
    selectedOutputDeviceId: row.selected_output_device_id,
    selectedDisplayId: row.selected_display_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    rollingSummary: row.rolling_summary,
    currentTurnOrdinal: Number(row.current_turn_ordinal),
    settingsSnapshot: JSON.parse(row.settings_snapshot_json) as SessionSettingsSnapshot,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCoverageRow(row: CoverageRow): SessionCoverageItem {
  return {
    id: row.coverage_item_id,
    label: row.label,
    objective: row.objective,
    priority: row.priority as SessionCoverageItem['priority'],
    status: row.status as SessionCoverageItem['status'],
    evidenceTurnIds: JSON.parse(row.evidence_turn_ids_json) as string[],
    maxFollowUps: Number(row.max_follow_ups),
    sourceRefs: JSON.parse(row.source_refs_json) as SessionCoverageItem['sourceRefs'],
    followUpCount: Number(row.follow_up_count),
  };
}

function mapTurnRow(row: TurnRow): InterviewTurn {
  return {
    id: row.id,
    sessionId: row.session_id,
    ordinal: Number(row.ordinal),
    question: JSON.parse(row.question_json) as QuestionRecord,
    answer: row.answer_json ? (JSON.parse(row.answer_json) as AnswerRecord) : null,
    coverageDelta: JSON.parse(row.coverage_delta_json) as CoverageDelta[],
    state: row.state as InterviewTurn['state'],
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

/** Shared coverage-row INSERT used by create/append/save coverage paths. */
function coverageInsertSql(): string {
  return `INSERT INTO session_coverage
            (session_id, coverage_item_id, label, objective, priority, status,
             evidence_turn_ids_json, follow_up_count, source_refs_json, max_follow_ups)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
}

function runCoverageInsert(
  stmt: SqliteStatement,
  sessionId: string,
  item: SessionCoverageItem,
): void {
  stmt.run(
    sessionId,
    item.id,
    item.label,
    item.objective,
    item.priority,
    item.status,
    JSON.stringify(item.evidenceTurnIds),
    item.followUpCount,
    JSON.stringify(item.sourceRefs),
    item.maxFollowUps,
  );
}

/**
 * Build the minimal {@link AnswerRecord} written by `recordRawAnswer`. Only the
 * raw transcript and endpoint reason are known at the durability checkpoint;
 * everything else is left empty/null until the cleanup stage fills it in.
 */
export function minimalAnswer(
  rawTranscript: string,
  endpointReason: EndpointReason,
): AnswerRecord {
  return {
    rawTranscript,
    cleanedTranscript: '',
    userEditedTranscript: null,
    transcriptParagraphs: [],
    uncertainTerms: [],
    endpointReason,
    speechStartedAt: null,
    speechEndedAt: null,
    durationMs: null,
    sttProvider: 'inworld',
    sttModelId: '',
    cleanupModelId: null,
    moderation: null,
    sttLatencyMs: null,
    cleanupLatencyMs: null,
    recoveredFromBufferedAudio: false,
  };
}
