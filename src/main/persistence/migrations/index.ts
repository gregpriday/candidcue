/**
 * Ordered SQLite schema migrations (spec §10.4). Each migration owns one
 * monotonically increasing `version`; `up(db)` applies its DDL/DML against a
 * `DatabaseSync`-compatible handle. The repository runs all pending migrations
 * inside a single transaction and records each applied version in
 * `schema_migrations`, so the list is forward-only and idempotent.
 *
 * The handle is typed structurally (`MigrationDb`) rather than against
 * `node:sqlite` directly so the migration list stays trivially unit-testable and
 * does not force a hard dependency on the native module at import time.
 */

/** Minimal surface of `node:sqlite`'s `DatabaseSync` used by migrations. */
export interface MigrationDb {
  exec(sql: string): void;
}

export interface Migration {
  version: number;
  up(db: MigrationDb): void;
}

/**
 * v1 — the full initial schema. Tables, indexes, and the migration ledger are
 * created exactly as specified in §10.4. `IF NOT EXISTS` keeps re-running a
 * migration against a partially-built database harmless, though the
 * transactional ledger in the repository is the primary idempotency guard.
 */
const v1: Migration = {
  version: 1,
  up(db: MigrationDb): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id                        TEXT PRIMARY KEY,
        title                     TEXT NOT NULL,
        status                    TEXT NOT NULL,
        audience                  TEXT,
        intended_outcome          TEXT,
        target_mode               TEXT NOT NULL,
        target_value              INTEGER NOT NULL,
        interviewer_character_id  TEXT NOT NULL,
        notes_to_interviewer      TEXT,
        source_hash               TEXT NOT NULL DEFAULT '',
        active_plan_version_id    TEXT,
        created_at                TEXT NOT NULL,
        updated_at                TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_documents (
        id                 TEXT PRIMARY KEY,
        project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind               TEXT NOT NULL,
        title              TEXT NOT NULL,
        original_filename  TEXT,
        mime_type          TEXT NOT NULL,
        content            TEXT NOT NULL,
        sort_order         INTEGER NOT NULL,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_project_documents_project
        ON project_documents(project_id, sort_order);

      CREATE TABLE IF NOT EXISTS interview_plans (
        id              TEXT PRIMARY KEY,
        project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        version         INTEGER NOT NULL,
        source_hash     TEXT NOT NULL,
        status          TEXT NOT NULL,
        brief_json      TEXT NOT NULL,
        prompt_version  TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        UNIQUE(project_id, version)
      );

      CREATE INDEX IF NOT EXISTS idx_plans_project_version
        ON interview_plans(project_id, version DESC);

      CREATE TABLE IF NOT EXISTS sessions (
        id                          TEXT PRIMARY KEY,
        project_id                  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        plan_version_id             TEXT NOT NULL REFERENCES interview_plans(id),
        character_id                TEXT NOT NULL,
        status                      TEXT NOT NULL,
        endpoint_mode               TEXT NOT NULL,
        selected_input_device_id    TEXT,
        selected_output_device_id   TEXT,
        selected_display_id         TEXT,
        rolling_summary             TEXT NOT NULL DEFAULT '',
        current_turn_ordinal        INTEGER NOT NULL DEFAULT 0,
        settings_snapshot_json      TEXT NOT NULL,
        started_at                  TEXT,
        ended_at                    TEXT,
        created_at                  TEXT NOT NULL,
        updated_at                  TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_project_created
        ON sessions(project_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS session_coverage (
        session_id            TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        coverage_item_id      TEXT NOT NULL,
        label                 TEXT NOT NULL,
        objective             TEXT NOT NULL,
        priority              TEXT NOT NULL,
        status                TEXT NOT NULL,
        evidence_turn_ids_json TEXT NOT NULL,
        follow_up_count       INTEGER NOT NULL DEFAULT 0,
        source_refs_json      TEXT NOT NULL DEFAULT '[]',
        max_follow_ups        INTEGER NOT NULL DEFAULT 2,
        PRIMARY KEY(session_id, coverage_item_id)
      );

      CREATE TABLE IF NOT EXISTS turns (
        id                  TEXT PRIMARY KEY,
        session_id          TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        ordinal             INTEGER NOT NULL,
        state               TEXT NOT NULL,
        question_json       TEXT NOT NULL,
        answer_json         TEXT,
        coverage_delta_json TEXT NOT NULL DEFAULT '[]',
        created_at          TEXT NOT NULL,
        completed_at        TEXT,
        UNIQUE(session_id, ordinal)
      );

      CREATE INDEX IF NOT EXISTS idx_turns_session_ordinal
        ON turns(session_id, ordinal);

      CREATE TABLE IF NOT EXISTS settings (
        key        TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  },
};

/**
 * The full ordered migration list. Append new migrations with the next
 * `version`; never reorder or mutate an already-shipped migration.
 */
export const MIGRATIONS: readonly Migration[] = [v1];
