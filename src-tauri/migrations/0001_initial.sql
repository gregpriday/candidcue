-- CandidCue initial schema (spec Appendix B).
-- Timestamps are UTC RFC 3339 strings; convert to local time only in UI.
-- JSON columns are validated in Rust before insert/update.

CREATE TABLE app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE display_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    display_fingerprint TEXT,
    display_descriptor_json TEXT,
    stage_settings_json TEXT NOT NULL,
    listener_geometry_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE tracking_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    profile_version INTEGER NOT NULL,
    built_in INTEGER NOT NULL DEFAULT 0,
    settings_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

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
    selected_tracking_profile_id TEXT,
    selected_listener_pack_id TEXT,
    listener_overrides_json TEXT,
    script_settings_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_opened_at TEXT,
    trashed_at TEXT,
    FOREIGN KEY (selected_display_profile_id) REFERENCES display_profiles(id)
        ON DELETE SET NULL,
    FOREIGN KEY (selected_tracking_profile_id) REFERENCES tracking_profiles(id)
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

CREATE TABLE dictionary_entries (
    id TEXT PRIMARY KEY,
    script_id TEXT,
    written_term TEXT NOT NULL,
    canonical_spoken TEXT NOT NULL,
    aliases_json TEXT NOT NULL DEFAULT '[]',
    category TEXT,
    source TEXT NOT NULL DEFAULT 'user'
        CHECK (source IN ('user', 'directive', 'generated')),
    approved INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(script_id, written_term COLLATE NOCASE),
    FOREIGN KEY (script_id) REFERENCES scripts(id) ON DELETE CASCADE
);

CREATE INDEX idx_dictionary_global
    ON dictionary_entries(script_id, written_term COLLATE NOCASE);

CREATE TABLE script_analyses (
    id TEXT PRIMARY KEY,
    script_id TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    analyzer_version TEXT NOT NULL,
    model TEXT,
    prompt_schema_version TEXT,
    dictionary_version TEXT,
    language TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(script_id, source_hash, analyzer_version,
           model, prompt_schema_version, dictionary_version, language),
    FOREIGN KEY (script_id) REFERENCES scripts(id) ON DELETE CASCADE
);

CREATE TABLE listener_packs (
    pack_id TEXT NOT NULL,
    version TEXT NOT NULL,
    display_name TEXT NOT NULL,
    manifest_rel_path TEXT NOT NULL,
    selected_variant TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    state TEXT NOT NULL
        CHECK (state IN ('installing', 'installed', 'failed', 'rollback')),
    last_verified_at TEXT,
    installed_at TEXT NOT NULL,
    last_used_at TEXT,
    PRIMARY KEY (pack_id, version)
);

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
    estimated_cost_usd REAL,
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
