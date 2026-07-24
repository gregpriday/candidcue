-- §36.3 take history: the per-take detail that sits on top of the §36.1
-- session record.
--
-- `sessions` is one row per SESSION with scalar counters, and `retake_count`
-- plus a `sectionsReached` number inside `metrics_json` were the whole of what
-- survived a take. That is enough to say "you did four takes" and nothing else:
-- not when each one ran, not where it started or stopped, not which sections it
-- covered, and not where the presenter marked a checkpoint.
--
-- Deliberately ONE table, not a second history. `take_pass_id` is the same
-- identifier the post-take review lane already keys `TakePassRecord` by
-- (`src/shared/coaching/review/types.ts`), so when that lane's persistence
-- lands it attaches to these rows rather than opening a parallel store — the
-- inert `REPORT_SQL_SCHEMA` in `report-store.ts` is exactly the fork this
-- avoids.
--
-- Checkpoints and sections are JSON columns rather than child tables on
-- purpose. They are written once, whole, at the end of a take and read back
-- whole by the review screen; nothing queries inside them, and two more tables
-- with two more foreign keys would buy a join nobody needs.
CREATE TABLE session_takes (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    -- `${sessionId}:${passOrdinal}` — the review lane's take-pass identity.
    take_pass_id TEXT NOT NULL,
    -- 1-based, ascending. A retake opens the next ordinal; it never rewrites
    -- the previous one, which is what UNIQUE below enforces at the storage
    -- layer rather than trusting the caller.
    pass_ordinal INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    duration_ms INTEGER,
    start_token_index INTEGER NOT NULL DEFAULT 0,
    end_token_index INTEGER,
    -- JSON array of authored block ids, in the order they were first reached.
    -- The session store has always accumulated these and thrown away everything
    -- but the count.
    sections_json TEXT NOT NULL DEFAULT '[]',
    -- JSON array of { atMs, tokenIndex, blockId, sentenceId, kind }.
    checkpoints_json TEXT NOT NULL DEFAULT '[]',
    -- §36.3 distinguishes AUTOMATIC retake transitions (the aligner decided the
    -- presenter went back and re-read) from MANUAL ones (the operator pressed
    -- restart, which is what opens the next ordinal). Only the automatic ones
    -- need counting here; every manual retake is a row of its own.
    automatic_retakes INTEGER NOT NULL DEFAULT 0,
    -- §36.3 confidence summary: the mean alignment confidence across the pass.
    -- NULL when the take produced no snapshots at all, never a confident 0.
    confidence_mean REAL,
    created_at TEXT NOT NULL,
    UNIQUE(session_id, pass_ordinal),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX idx_session_takes_session ON session_takes(session_id, pass_ordinal);
