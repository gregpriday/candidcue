-- CandidCue 1.0 baseline schema.
--
-- This is a SQUASH. It replaces the original `0001_initial.sql` (which was
-- written against the full spec, including features that were later removed)
-- and `0002_session_takes.sql`. CandidCue has never been publicly released, so
-- before the first stable version is the cheapest — and last — moment to decide
-- which tables are real product contracts. After 1.0 ships, every one of them
-- needs a compatibility migration forever.
--
-- What was dropped, and why:
--
--   app_meta            no reader and no writer. A key/value side table with
--                       no keys.
--   tracking_profiles   named tracking presets. The product settled on one
--                       following configuration in Settings; nothing ever
--                       wrote a row.
--   dictionary_entries  the pronunciation dictionary of the OpenAI-era
--                       pipeline. Speech-to-script matching is now the
--                       deterministic engine in crates/cc-align, which
--                       normalises rather than looking terms up.
--   script_analyses     cached results from the semantic sidecar. There is no
--                       sidecar and no second model.
--   listener_packs      the Listener (§106), removed.
--   scripts.selected_listener_pack_id, scripts.listener_overrides_json
--                       ditto.
--   scripts.selected_tracking_profile_id
--                       the foreign key into tracking_profiles.
--   display_profiles.listener_geometry_json
--                       ditto.
--   sessions.estimated_cost_usd
--                       per-take API spend. Transcription runs on this
--                       machine; a take costs nothing, and a column that can
--                       only ever hold 0 invites a UI to display it.
--
-- Timestamps are UTC RFC 3339 strings; convert to local time only in the UI.
-- JSON columns are validated in Rust before insert/update.

-- Per-display stage configuration. Kept and load-bearing: this is where
-- optical calibration lives durably, rather than in WebView localStorage.
CREATE TABLE display_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    display_fingerprint TEXT,
    display_descriptor_json TEXT,
    stage_settings_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- The database INDEXES scripts; the canonical Markdown file on disk is the
-- authority for their content (§48.1). Startup reconciliation repairs this
-- table from those files, which is what makes it rebuildable.
CREATE TABLE scripts (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    canonical_rel_path TEXT NOT NULL UNIQUE,
    source_hash TEXT NOT NULL,
    file_fingerprint TEXT,
    revision INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'ready', 'archived', 'trash')),
    language TEXT NOT NULL DEFAULT 'en',
    spoken_word_count INTEGER NOT NULL DEFAULT 0,
    estimated_duration_seconds INTEGER NOT NULL DEFAULT 0,
    last_compile_hash TEXT,
    last_compile_version TEXT,
    selected_display_profile_id TEXT,
    script_settings_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_opened_at TEXT,
    trashed_at TEXT,
    FOREIGN KEY (selected_display_profile_id) REFERENCES display_profiles(id)
        ON DELETE SET NULL
);

CREATE INDEX idx_scripts_status_updated
    ON scripts(status, updated_at DESC);
CREATE INDEX idx_scripts_last_opened
    ON scripts(last_opened_at DESC);
CREATE INDEX idx_scripts_title_nocase
    ON scripts(title COLLATE NOCASE);

CREATE VIRTUAL TABLE script_search USING fts5(
    script_id UNINDEXED,
    title,
    plain_text,
    tokenize = 'unicode61'
);

CREATE TABLE script_revisions (
    id TEXT PRIMARY KEY,
    script_id TEXT NOT NULL,
    revision_number INTEGER NOT NULL,
    source_hash TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    reason TEXT NOT NULL,
    word_count INTEGER,
    created_at TEXT NOT NULL,
    UNIQUE(script_id, revision_number),
    FOREIGN KEY (script_id) REFERENCES scripts(id) ON DELETE CASCADE
);

CREATE INDEX idx_revisions_script_created
    ON script_revisions(script_id, created_at DESC);

CREATE TABLE assets (
    id TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    extension TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    rel_path TEXT NOT NULL,
    original_name TEXT,
    original_url TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(sha256, rel_path)
);

CREATE TABLE script_asset_references (
    script_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    source_start INTEGER,
    source_end INTEGER,
    role TEXT NOT NULL DEFAULT 'image',
    block_id TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (script_id, asset_id, source_start),
    FOREIGN KEY (script_id) REFERENCES scripts(id) ON DELETE CASCADE,
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE RESTRICT
);

-- One revisioned row keyed 'app' holding the whole settings document (§48.2).
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    script_id TEXT NOT NULL,
    script_source_hash TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    mode TEXT NOT NULL
        CHECK (mode IN ('voice', 'manual', 'fixed')),
    start_token_index INTEGER NOT NULL DEFAULT 0,
    end_token_index INTEGER,
    duration_ms INTEGER,
    soft_pause_ms INTEGER NOT NULL DEFAULT 0,
    command_count INTEGER NOT NULL DEFAULT 0,
    retake_count INTEGER NOT NULL DEFAULT 0,
    reconnect_count INTEGER NOT NULL DEFAULT 0,
    manual_correction_count INTEGER NOT NULL DEFAULT 0,
    metrics_json TEXT,
    transcript_retained INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (script_id) REFERENCES scripts(id) ON DELETE RESTRICT
);

CREATE INDEX idx_sessions_script_started
    ON sessions(script_id, started_at DESC);

-- Created from the start (spec B.4) but written only when retention is on.
CREATE TABLE session_transcript_items (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    commit_sequence INTEGER NOT NULL,
    provider_item_id TEXT,
    audio_start_ms INTEGER,
    audio_end_ms INTEGER,
    transcript TEXT NOT NULL,
    disposition TEXT NOT NULL
        CHECK (disposition IN ('script', 'command', 'discarded')),
    confidence_json TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(session_id, commit_sequence),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- §36.3 take history: the per-take detail that sits on top of the §36.1
-- session record.
--
-- `sessions` is one row per SESSION with scalar counters, and `retake_count`
-- plus a `sectionsReached` number inside `metrics_json` were the whole of what
-- survived a take. That is enough to say "you did four takes" and nothing else:
-- not when each one ran, not where it started or stopped, not which sections it
-- covered, and not where the presenter marked a checkpoint.
--
-- Checkpoints and sections are JSON columns rather than child tables on
-- purpose. They are written once, whole, at the end of a take and read back
-- whole by the review screen; nothing queries inside them, and two more tables
-- with two more foreign keys would buy a join nobody needs.
CREATE TABLE session_takes (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    -- `${sessionId}:${passOrdinal}` — the take-pass identity.
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
