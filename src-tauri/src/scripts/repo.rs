//! Script repository operations (spec §21, §44.4, §47.5, §48.4).

use std::fs;

use sqlx::sqlite::SqliteRow;
use sqlx::{Row, SqlitePool};

use crate::errors::{AppError, ErrorCategory, RecoveryAction};
use crate::util::{atomic_write, file_fingerprint, now_iso, new_uuid, sha256_hex};

use super::words::{
    estimated_duration_seconds, preview_text, spoken_plain_text, word_count, SpokenTextOptions,
};
use super::{
    CreateScriptInput, DataPaths, ListenerSelection, PageRequest, RevisionDocument,
    RevisionSummary, SaveResult, ScriptDocument, ScriptFilter, ScriptId, ScriptLocks,
    ScriptMetadataPatch, ScriptPage, ScriptSettings, ScriptStatus, ScriptSummary,
};

/// Spec §21.4: revision cadence during active editing.
const REVISION_INTERVAL_SECONDS: i64 = 5 * 60;
/// Spec §21.4: hard cap per script.
const MAX_REVISIONS_PER_SCRIPT: i64 = 100;
/// Spec Appendix A.10: Markdown source hard limit.
pub const MAX_SOURCE_BYTES: usize = 10 * 1024 * 1024;

pub fn file_missing_error(script_id: &ScriptId) -> AppError {
    AppError::structured(
        "SCRIPT_FILE_MISSING",
        ErrorCategory::Storage,
        "The script file is missing from CandidCue's data folder.",
        true,
    )
    .with_action(RecoveryAction::RevealFolder)
    .with_detail("scriptId", script_id.as_str())
}

/// Every authored-state transition writes exactly one row. Anything else is a
/// lost compare-and-swap and must never be reported as success (spec §48.4).
fn expect_single_row(rows_affected: u64, expected_revision: i64) -> Result<(), AppError> {
    match rows_affected {
        1 => Ok(()),
        0 => Err(AppError::stale_revision(expected_revision, -1)),
        n => Err(AppError::Internal(format!(
            "script update affected {n} rows; expected exactly 1"
        ))),
    }
}

struct ScriptRow {
    id: String,
    title: String,
    source_hash: String,
    revision: i64,
    status: ScriptStatus,
    language: String,
    spoken_word_count: i64,
    estimated_duration_seconds: i64,
    selected_display_profile_id: Option<String>,
    selected_tracking_profile_id: Option<String>,
    listener_overrides_json: Option<String>,
    script_settings_json: String,
    updated_at: String,
    last_opened_at: Option<String>,
}

fn read_row(row: &SqliteRow) -> Result<ScriptRow, sqlx::Error> {
    Ok(ScriptRow {
        id: row.try_get("id")?,
        title: row.try_get("title")?,
        source_hash: row.try_get("source_hash")?,
        revision: row.try_get("revision")?,
        status: ScriptStatus::parse(&row.try_get::<String, _>("status")?),
        language: row.try_get("language")?,
        spoken_word_count: row.try_get("spoken_word_count")?,
        estimated_duration_seconds: row.try_get("estimated_duration_seconds")?,
        selected_display_profile_id: row.try_get("selected_display_profile_id")?,
        selected_tracking_profile_id: row.try_get("selected_tracking_profile_id")?,
        listener_overrides_json: row.try_get("listener_overrides_json")?,
        script_settings_json: row.try_get("script_settings_json")?,
        updated_at: row.try_get("updated_at")?,
        last_opened_at: row.try_get("last_opened_at")?,
    })
}

fn parse_settings(json: &str) -> ScriptSettings {
    serde_json::from_str(json).unwrap_or_default()
}

fn parse_listener(json: Option<&str>) -> Option<ListenerSelection> {
    json.and_then(|j| serde_json::from_str(j).ok())
}

fn summary_from_row(row: &ScriptRow, preview: String) -> ScriptSummary {
    ScriptSummary {
        id: row.id.clone(),
        title: row.title.clone(),
        script_revision: row.revision,
        status: row.status,
        language: row.language.clone(),
        spoken_word_count: row.spoken_word_count.max(0) as u32,
        estimated_duration_seconds: row.estimated_duration_seconds.max(0) as u32,
        updated_at: row.updated_at.clone(),
        last_opened_at: row.last_opened_at.clone(),
        preview_text: preview,
        has_warnings: false,
    }
}

async fn fetch_row(pool: &SqlitePool, script_id: &ScriptId) -> Result<ScriptRow, AppError> {
    let row = sqlx::query("SELECT * FROM scripts WHERE id = ?")
        .bind(script_id.as_str())
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::not_found("script"))?;
    Ok(read_row(&row)?)
}

async fn fetch_preview(pool: &SqlitePool, script_id: &ScriptId) -> Result<String, AppError> {
    let preview: Option<String> =
        sqlx::query_scalar("SELECT substr(plain_text, 1, 220) FROM script_search WHERE script_id = ?")
            .bind(script_id.as_str())
            .fetch_optional(pool)
            .await?;
    Ok(preview.unwrap_or_default())
}

fn stats_for(source: &str, settings: &ScriptSettings) -> (String, u32, u32) {
    let plain = spoken_plain_text(
        source,
        SpokenTextOptions {
            read_headings: settings.read_headings,
            read_image_alt_text: settings.read_image_alt_text,
        },
    );
    let words = word_count(&plain);
    let duration = estimated_duration_seconds(words, settings.words_per_minute_estimate.max(1));
    (plain, words, duration)
}

/// Search-index maintenance. Takes a connection rather than the pool so it
/// can run INSIDE the same transaction as the row update (spec §47.5: the
/// search index must never describe a different revision than the row).
async fn update_fts(
    conn: &mut sqlx::SqliteConnection,
    script_id: &ScriptId,
    title: &str,
    plain: &str,
) -> Result<(), AppError> {
    sqlx::query("DELETE FROM script_search WHERE script_id = ?")
        .bind(script_id.as_str())
        .execute(&mut *conn)
        .await?;
    sqlx::query("INSERT INTO script_search (script_id, title, plain_text) VALUES (?, ?, ?)")
        .bind(script_id.as_str())
        .bind(title)
        .bind(plain)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

pub async fn create_script(
    pool: &SqlitePool,
    paths: &DataPaths,
    input: CreateScriptInput,
) -> Result<ScriptSummary, AppError> {
    let title = input.title.trim();
    if title.is_empty() {
        return Err(AppError::invalid_input("A script needs a title."));
    }
    let source = input.source.unwrap_or_default();
    if source.len() > MAX_SOURCE_BYTES {
        return Err(AppError::validation("The script is larger than the 10 MB limit."));
    }

    let id = ScriptId::parse(&new_uuid())?;
    let now = now_iso();
    let canonical = paths.canonical_file(&id);
    atomic_write(&canonical, source.as_bytes())?;
    fs::create_dir_all(paths.assets_dir(&id))?;
    fs::create_dir_all(paths.revisions_dir(&id))?;

    let settings = ScriptSettings::default();
    let (plain, words, duration) = stats_for(&source, &settings);
    let source_hash = sha256_hex(source.as_bytes());
    let fingerprint = file_fingerprint(&canonical)?;
    let rel_path = paths
        .relative(&canonical)
        .ok_or_else(|| AppError::Internal("canonical path outside data root".into()))?;

    let mut tx = pool.begin().await?;
    sqlx::query(
        "INSERT INTO scripts
            (id, title, canonical_rel_path, source_hash, file_fingerprint, revision,
             status, language, spoken_word_count, estimated_duration_seconds,
             script_settings_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, 'draft', ?, ?, ?, ?, ?, ?)",
    )
    .bind(id.as_str())
    .bind(title)
    .bind(&rel_path)
    .bind(&source_hash)
    .bind(&fingerprint)
    .bind(input.language.as_deref().unwrap_or("en"))
    .bind(words as i64)
    .bind(duration as i64)
    .bind(serde_json::to_string(&settings).unwrap_or_else(|_| "{}".into()))
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await?;
    update_fts(&mut tx, &id, title, &plain).await?;
    tx.commit().await?;

    let row = fetch_row(pool, &id).await?;
    Ok(summary_from_row(&row, preview_text(&plain)))
}

fn sanitize_fts_query(query: &str) -> Option<String> {
    let terms: Vec<String> = query
        .split_whitespace()
        .map(|t| t.replace('"', ""))
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{t}\"*"))
        .collect();
    if terms.is_empty() {
        None
    } else {
        Some(terms.join(" "))
    }
}

pub async fn list_scripts(
    pool: &SqlitePool,
    filter: ScriptFilter,
    sort: Option<String>,
    page: PageRequest,
) -> Result<ScriptPage, AppError> {
    let page_size = page.page_size.clamp(1, 500);
    let offset = (page.page as i64) * (page_size as i64);

    let order = match sort.as_deref() {
        Some("title_asc") => "s.title COLLATE NOCASE ASC",
        Some("opened_desc") => "s.last_opened_at DESC NULLS LAST",
        _ => "s.updated_at DESC",
    };

    let status_clause = match filter.status {
        Some(status) => format!("s.status = '{}'", status.as_str()),
        None => "s.status != 'trash'".to_string(),
    };

    let fts = filter.query.as_deref().and_then(sanitize_fts_query);
    let (join, match_clause) = if fts.is_some() {
        (
            "JOIN script_search ss ON ss.script_id = s.id",
            "AND script_search MATCH ?",
        )
    } else {
        ("LEFT JOIN script_search ss ON ss.script_id = s.id", "")
    };

    let sql = format!(
        "SELECT s.*, substr(ss.plain_text, 1, 220) AS preview
         FROM scripts s {join}
         WHERE {status_clause} {match_clause}
         ORDER BY {order}
         LIMIT ? OFFSET ?"
    );
    let count_sql = format!(
        "SELECT count(*) FROM scripts s {join} WHERE {status_clause} {match_clause}"
    );

    let mut query = sqlx::query(&sql);
    let mut count_query = sqlx::query_scalar::<_, i64>(&count_sql);
    if let Some(ref fts_query) = fts {
        query = query.bind(fts_query.clone());
        count_query = count_query.bind(fts_query.clone());
    }
    query = query.bind(page_size as i64).bind(offset);

    let rows = query.fetch_all(pool).await?;
    let total = count_query.fetch_one(pool).await?;

    let mut items = Vec::with_capacity(rows.len());
    for row in &rows {
        let script_row = read_row(row)?;
        let preview: Option<String> = row.try_get("preview").ok();
        items.push(summary_from_row(
            &script_row,
            preview_text(&preview.unwrap_or_default()),
        ));
    }

    Ok(ScriptPage {
        items,
        total: total.max(0) as u32,
        page: page.page,
        page_size,
    })
}

/// Read the canonical file. The file is the authority for source content
/// (spec §48.1); on an external change the file content is adopted, a
/// revision snapshot of the adopted content is created, and
/// `externally_changed` is set so control can inform the user (§21.7).
pub async fn get_script(
    pool: &SqlitePool,
    paths: &DataPaths,
    locks: &ScriptLocks,
    script_id: &ScriptId,
) -> Result<ScriptDocument, AppError> {
    let lock = locks.lock_for(script_id);
    let _guard = lock.lock().await;

    let row = fetch_row(pool, script_id).await?;
    let canonical = paths.canonical_file(script_id);
    if !canonical.exists() {
        return Err(file_missing_error(script_id));
    }
    let source = fs::read_to_string(&canonical)?;
    let disk_hash = sha256_hex(source.as_bytes());
    let settings = parse_settings(&row.script_settings_json);

    let mut externally_changed = false;
    let mut revision = row.revision;
    let mut source_hash = row.source_hash.clone();

    if disk_hash != row.source_hash {
        externally_changed = true;
        let (plain, words, duration) = stats_for(&source, &settings);
        let snapshot =
            create_revision_snapshot(pool, paths, script_id, &source, "external_change", words)
                .await?;
        revision += 1;
        source_hash = disk_hash.clone();
        let fingerprint = file_fingerprint(&canonical)?;
        let mut tx = pool.begin().await?;
        let updated = sqlx::query(
            "UPDATE scripts SET source_hash = ?, file_fingerprint = ?, revision = ?,
             spoken_word_count = ?, estimated_duration_seconds = ?, updated_at = ?
             WHERE id = ? AND revision = ?",
        )
        .bind(&disk_hash)
        .bind(&fingerprint)
        .bind(revision)
        .bind(words as i64)
        .bind(duration as i64)
        .bind(now_iso())
        .bind(script_id.as_str())
        .bind(row.revision)
        .execute(&mut *tx)
        .await?;
        expect_single_row(updated.rows_affected(), row.revision)?;
        update_fts(&mut tx, script_id, &row.title, &plain).await?;
        tx.commit().await?;
        tracing::warn!(script_id = script_id.as_str(), revision_id = %snapshot, "adopted external change to canonical file");
    }

    // Track recency for the library.
    let now = now_iso();
    sqlx::query("UPDATE scripts SET last_opened_at = ? WHERE id = ?")
        .bind(&now)
        .bind(script_id.as_str())
        .execute(pool)
        .await?;

    let preview = fetch_preview(pool, script_id).await?;
    let mut summary = summary_from_row(&row, preview_text(&preview));
    summary.last_opened_at = Some(now);
    // `row` was read before the external-change adoption above, so the summary
    // must carry the revision the caller is expected to save against.
    summary.script_revision = revision;

    Ok(ScriptDocument {
        summary,
        source,
        source_hash,
        settings,
        selected_display_profile_id: row.selected_display_profile_id.clone(),
        selected_tracking_profile_id: row.selected_tracking_profile_id.clone(),
        selected_listener: parse_listener(row.listener_overrides_json.as_deref()),
        externally_changed,
    })
}

/// Save transaction protocol (spec §47.5) with optimistic concurrency
/// (`expected_revision`) and external-change refusal (§21.3).
pub async fn save_script(
    pool: &SqlitePool,
    paths: &DataPaths,
    locks: &ScriptLocks,
    script_id: &ScriptId,
    expected_revision: i64,
    source: String,
    patch: ScriptMetadataPatch,
) -> Result<SaveResult, AppError> {
    if source.len() > MAX_SOURCE_BYTES {
        return Err(AppError::validation("The script is larger than the 10 MB limit."));
    }
    let lock = locks.lock_for(script_id);
    let _guard = lock.lock().await;

    let row = fetch_row(pool, script_id).await?;
    if row.revision != expected_revision {
        return Err(AppError::stale_revision(expected_revision, row.revision));
    }

    // External-change detection (spec §21.3). The preimage is read once, here,
    // immediately before the replacement, and is the value both the conflict
    // check and the revision snapshot use — so the content that is about to be
    // destroyed is the content that gets preserved (H2), and the check cannot
    // be separated from the write by a wider TOCTOU window (H1).
    let canonical = paths.canonical_file(script_id);
    let preimage: Option<String> = if canonical.exists() {
        Some(fs::read_to_string(&canonical)?)
    } else {
        None
    };
    if let Some(ref current) = preimage {
        let disk_hash = sha256_hex(current.as_bytes());
        if disk_hash != row.source_hash {
            // Preserve the external version in recovery storage BEFORE
            // refusing, so an editor's write can never be lost even if a
            // later save races past this check.
            let (_, external_words, _) =
                stats_for(current, &parse_settings(&row.script_settings_json));
            match create_revision_snapshot(
                pool,
                paths,
                script_id,
                current,
                "external_change_preserved",
                external_words,
            )
            .await
            {
                Ok(id) => tracing::warn!(
                    script_id = script_id.as_str(),
                    revision_id = %id,
                    "preserved externally edited canonical file before refusing the save"
                ),
                Err(err) => tracing::error!(
                    script_id = script_id.as_str(),
                    error = %err,
                    "could not preserve externally edited canonical file"
                ),
            }
            return Err(AppError::structured(
                "SCRIPT_CONFLICT",
                ErrorCategory::Validation,
                "This script's file changed outside CandidCue. Resolve the conflict before saving.",
                true,
            )
            .with_detail("scriptId", script_id.as_str())
            .with_detail("externalChange", true));
        }
    }

    let settings = patch.settings.clone().unwrap_or_else(|| parse_settings(&row.script_settings_json));
    let (plain, words, duration) = stats_for(&source, &settings);
    let source_hash = sha256_hex(source.as_bytes());
    let now = now_iso();
    let next_revision = row.revision + 1;
    let title = patch.title.clone().unwrap_or_else(|| row.title.clone());

    // Revision snapshot policy (spec §21.4): explicit reason, first-ever
    // revision, or the 5-minute cadence. The snapshot captures the PREIMAGE —
    // the text this save destroys — not the replacement, and it is made
    // durable before the canonical file is touched.
    let mut revision_created = false;
    let mut revision_id = None;
    let should_snapshot = if let Some(ref reason) = patch.revision_reason {
        Some(reason.clone())
    } else {
        let last_created: Option<String> = sqlx::query_scalar(
            "SELECT created_at FROM script_revisions WHERE script_id = ? ORDER BY revision_number DESC LIMIT 1",
        )
        .bind(script_id.as_str())
        .fetch_optional(pool)
        .await?;
        match last_created {
            None => Some("initial".to_string()),
            Some(created_at) => {
                let stale = chrono::DateTime::parse_from_rfc3339(&created_at)
                    .map(|t| {
                        chrono::Utc::now().signed_duration_since(t.with_timezone(&chrono::Utc))
                            > chrono::Duration::seconds(REVISION_INTERVAL_SECONDS)
                    })
                    .unwrap_or(true);
                stale.then(|| "autosave_interval".to_string())
            }
        }
    };
    if let (Some(reason), Some(current)) = (should_snapshot, preimage.as_ref()) {
        let (_, preimage_words, _) = stats_for(current, &settings);
        let id =
            create_revision_snapshot(pool, paths, script_id, current, &reason, preimage_words)
                .await?;
        revision_created = true;
        revision_id = Some(id);
    }

    // 3–4: temp write + atomic rename.
    atomic_write(&canonical, source.as_bytes())
        .map_err(|e| AppError::save_failed("CandidCue could not write the script file.")
            .with_log(format!("canonical write failed: {e}")))?;
    let fingerprint = file_fingerprint(&canonical)?;

    // 5–8: database transaction. If it fails the canonical file is rolled
    // back to the preimage, so a failed save never leaves new bytes on disk
    // that the database does not know about (which would surface as a
    // spurious external-change conflict on the user's next attempt).
    let db_result = commit_save(
        pool,
        script_id,
        &CommitSave {
            title: &title,
            source_hash: &source_hash,
            fingerprint: &fingerprint,
            next_revision,
            expected_revision,
            status: patch.status.unwrap_or(row.status),
            words,
            duration,
            settings: &settings,
            now: &now,
            plain: &plain,
            patch: &patch,
        },
    )
    .await;
    if let Err(err) = db_result {
        if let Some(current) = preimage.as_ref() {
            if let Err(rollback_err) = atomic_write(&canonical, current.as_bytes()) {
                tracing::error!(
                    script_id = script_id.as_str(),
                    error = %rollback_err,
                    "could not roll the canonical file back after a failed save commit"
                );
            }
        }
        return Err(err);
    }

    // The save is durable from here on. Retention thinning is maintenance:
    // its failure must never be reported as a failed save (H2).
    if let Err(err) = prune_revisions(pool, paths, script_id).await {
        tracing::warn!(
            script_id = script_id.as_str(),
            error = %err,
            "revision pruning failed after a successful save; will retry next save"
        );
    }

    Ok(SaveResult {
        script_revision: next_revision,
        source_hash,
        saved_at: now,
        revision_created,
        revision_id,
    })
}

struct CommitSave<'a> {
    title: &'a str,
    source_hash: &'a str,
    fingerprint: &'a str,
    next_revision: i64,
    expected_revision: i64,
    status: ScriptStatus,
    words: u32,
    duration: u32,
    settings: &'a ScriptSettings,
    now: &'a str,
    plain: &'a str,
    patch: &'a ScriptMetadataPatch,
}

/// The row update, the compare-and-swap assertion, and the search index all
/// inside one transaction (spec §47.5).
async fn commit_save(
    pool: &SqlitePool,
    script_id: &ScriptId,
    c: &CommitSave<'_>,
) -> Result<(), AppError> {
    let patch = c.patch;
    let mut tx = pool.begin().await?;
    let updated = sqlx::query(
        "UPDATE scripts SET
            title = ?, source_hash = ?, file_fingerprint = ?, revision = ?,
            status = ?, spoken_word_count = ?, estimated_duration_seconds = ?,
            script_settings_json = ?, updated_at = ?,
            selected_display_profile_id = CASE WHEN ? THEN ? ELSE selected_display_profile_id END,
            selected_tracking_profile_id = CASE WHEN ? THEN ? ELSE selected_tracking_profile_id END,
            listener_overrides_json = CASE WHEN ? THEN ? ELSE listener_overrides_json END,
            last_opened_at = CASE WHEN ? THEN ? ELSE last_opened_at END
         WHERE id = ? AND revision = ?",
    )
    .bind(c.title)
    .bind(c.source_hash)
    .bind(c.fingerprint)
    .bind(c.next_revision)
    .bind(c.status.as_str())
    .bind(c.words as i64)
    .bind(c.duration as i64)
    .bind(serde_json::to_string(c.settings).unwrap_or_else(|_| "{}".into()))
    .bind(c.now)
    .bind(patch.selected_display_profile_id.is_some())
    .bind(patch.selected_display_profile_id.clone().flatten())
    .bind(patch.selected_tracking_profile_id.is_some())
    .bind(patch.selected_tracking_profile_id.clone().flatten())
    .bind(patch.selected_listener.is_some())
    .bind(
        patch
            .selected_listener
            .as_ref()
            .and_then(|l| l.as_ref())
            .and_then(|l| serde_json::to_string(l).ok()),
    )
    .bind(patch.last_opened.unwrap_or(false))
    .bind(c.now)
    .bind(script_id.as_str())
    .bind(c.expected_revision)
    .execute(&mut *tx)
    .await?;
    // A lost compare-and-swap used to commit anyway and report the new
    // revision while the row still described the old content (H1).
    expect_single_row(updated.rows_affected(), c.expected_revision)?;
    update_fts(&mut tx, script_id, c.title, c.plain).await?;
    tx.commit().await?;
    Ok(())
}

/// Rename is an authored-state transition: it takes the same per-script lock,
/// the same optimistic revision, and bumps the revision it returns, so a
/// concurrent save can never be silently invalidated (spec §48.4).
pub async fn rename_script(
    pool: &SqlitePool,
    locks: &ScriptLocks,
    script_id: &ScriptId,
    title: &str,
    expected_revision: i64,
) -> Result<ScriptSummary, AppError> {
    let title = title.trim();
    if title.is_empty() {
        return Err(AppError::invalid_input("A script needs a title."));
    }
    let lock = locks.lock_for(script_id);
    let _guard = lock.lock().await;

    let row = fetch_row(pool, script_id).await?;
    if row.revision != expected_revision {
        return Err(AppError::stale_revision(expected_revision, row.revision));
    }
    let now = now_iso();
    let mut tx = pool.begin().await?;
    let updated = sqlx::query(
        "UPDATE scripts SET title = ?, revision = ?, updated_at = ?
         WHERE id = ? AND revision = ?",
    )
    .bind(title)
    .bind(row.revision + 1)
    .bind(&now)
    .bind(script_id.as_str())
    .bind(expected_revision)
    .execute(&mut *tx)
    .await?;
    expect_single_row(updated.rows_affected(), expected_revision)?;
    sqlx::query("UPDATE script_search SET title = ? WHERE script_id = ?")
        .bind(title)
        .bind(script_id.as_str())
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    let row = fetch_row(pool, script_id).await?;
    let preview = fetch_preview(pool, script_id).await?;
    Ok(summary_from_row(&row, preview_text(&preview)))
}

/// Duplicate source, assets, and applicable script-level settings under a
/// new UUID (spec §21.2 item 5).
pub async fn duplicate_script(
    pool: &SqlitePool,
    paths: &DataPaths,
    locks: &ScriptLocks,
    script_id: &ScriptId,
) -> Result<ScriptSummary, AppError> {
    let lock = locks.lock_for(script_id);
    let _guard = lock.lock().await;

    let row = fetch_row(pool, script_id).await?;
    let canonical = paths.canonical_file(script_id);
    if !canonical.exists() {
        return Err(file_missing_error(script_id));
    }
    let source = fs::read_to_string(&canonical)?;

    let new_id = ScriptId::parse(&new_uuid())?;
    let now = now_iso();
    let new_canonical = paths.canonical_file(&new_id);
    atomic_write(&new_canonical, source.as_bytes())?;
    fs::create_dir_all(paths.revisions_dir(&new_id))?;

    // Copy assets directory.
    let src_assets = paths.assets_dir(script_id);
    let dst_assets = paths.assets_dir(&new_id);
    fs::create_dir_all(&dst_assets)?;
    if src_assets.exists() {
        for entry in fs::read_dir(&src_assets)? {
            let entry = entry?;
            if entry.file_type()?.is_file() {
                fs::copy(entry.path(), dst_assets.join(entry.file_name()))?;
            }
        }
    }

    let settings = parse_settings(&row.script_settings_json);
    let (plain, words, duration) = stats_for(&source, &settings);
    let title = format!("{} copy", row.title);
    let rel_path = paths
        .relative(&new_canonical)
        .ok_or_else(|| AppError::Internal("canonical path outside data root".into()))?;
    let fingerprint = file_fingerprint(&new_canonical)?;

    let mut tx = pool.begin().await?;
    sqlx::query(
        "INSERT INTO scripts
            (id, title, canonical_rel_path, source_hash, file_fingerprint, revision,
             status, language, spoken_word_count, estimated_duration_seconds,
             selected_display_profile_id, selected_tracking_profile_id,
             listener_overrides_json, script_settings_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(new_id.as_str())
    .bind(&title)
    .bind(&rel_path)
    .bind(sha256_hex(source.as_bytes()))
    .bind(&fingerprint)
    .bind(&row.language)
    .bind(words as i64)
    .bind(duration as i64)
    .bind(&row.selected_display_profile_id)
    .bind(&row.selected_tracking_profile_id)
    .bind(&row.listener_overrides_json)
    .bind(&row.script_settings_json)
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    // Duplicate asset rows + references pointing at the copied files.
    let asset_rows = sqlx::query(
        "SELECT a.id, a.sha256, a.mime_type, a.extension, a.size_bytes, a.width, a.height,
                a.rel_path, a.original_name, a.original_url,
                r.source_start, r.source_end, r.role, r.block_id
         FROM script_asset_references r JOIN assets a ON a.id = r.asset_id
         WHERE r.script_id = ?",
    )
    .bind(script_id.as_str())
    .fetch_all(&mut *tx)
    .await?;
    for asset in &asset_rows {
        let old_rel: String = asset.try_get("rel_path")?;
        let file_name = old_rel.rsplit('/').next().unwrap_or_default().to_string();
        let new_rel = format!("scripts/{new_id}/assets/{file_name}");
        let new_asset_id = new_uuid();
        sqlx::query(
            "INSERT INTO assets (id, sha256, mime_type, extension, size_bytes, width, height,
                                 rel_path, original_name, original_url, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(sha256, rel_path) DO NOTHING",
        )
        .bind(&new_asset_id)
        .bind(asset.try_get::<String, _>("sha256")?)
        .bind(asset.try_get::<String, _>("mime_type")?)
        .bind(asset.try_get::<String, _>("extension")?)
        .bind(asset.try_get::<i64, _>("size_bytes")?)
        .bind(asset.try_get::<Option<i64>, _>("width")?)
        .bind(asset.try_get::<Option<i64>, _>("height")?)
        .bind(&new_rel)
        .bind(asset.try_get::<Option<String>, _>("original_name")?)
        .bind(asset.try_get::<Option<String>, _>("original_url")?)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        let effective_asset_id: String =
            sqlx::query_scalar("SELECT id FROM assets WHERE rel_path = ? LIMIT 1")
                .bind(&new_rel)
                .fetch_one(&mut *tx)
                .await?;
        sqlx::query(
            "INSERT OR IGNORE INTO script_asset_references
                (script_id, asset_id, source_start, source_end, role, block_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(new_id.as_str())
        .bind(&effective_asset_id)
        .bind(asset.try_get::<Option<i64>, _>("source_start")?)
        .bind(asset.try_get::<Option<i64>, _>("source_end")?)
        .bind(asset.try_get::<String, _>("role")?)
        .bind(asset.try_get::<Option<String>, _>("block_id")?)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    }
    update_fts(&mut tx, &new_id, &title, &plain).await?;
    tx.commit().await?;

    let row = fetch_row(pool, &new_id).await?;
    Ok(summary_from_row(&row, preview_text(&plain)))
}

/// Trash is an authored-state transition: same per-script lock, same
/// optimistic revision, exactly one row (spec §48.4).
pub async fn trash_script(
    pool: &SqlitePool,
    locks: &ScriptLocks,
    script_id: &ScriptId,
    expected_revision: i64,
) -> Result<ScriptSummary, AppError> {
    let lock = locks.lock_for(script_id);
    let _guard = lock.lock().await;

    let row = fetch_row(pool, script_id).await?;
    if row.revision != expected_revision {
        return Err(AppError::stale_revision(expected_revision, row.revision));
    }
    let now = now_iso();
    let result = sqlx::query(
        "UPDATE scripts SET status = 'trash', trashed_at = ?, updated_at = ?, revision = ?
         WHERE id = ? AND revision = ?",
    )
    .bind(&now)
    .bind(&now)
    .bind(row.revision + 1)
    .bind(script_id.as_str())
    .bind(expected_revision)
    .execute(pool)
    .await?;
    expect_single_row(result.rows_affected(), expected_revision)?;

    let row = fetch_row(pool, script_id).await?;
    let preview = fetch_preview(pool, script_id).await?;
    Ok(summary_from_row(&row, preview_text(&preview)))
}

pub async fn restore_script(
    pool: &SqlitePool,
    locks: &ScriptLocks,
    script_id: &ScriptId,
    expected_revision: i64,
) -> Result<ScriptSummary, AppError> {
    let lock = locks.lock_for(script_id);
    let _guard = lock.lock().await;

    let row = fetch_row(pool, script_id).await?;
    if row.status != ScriptStatus::Trash {
        return Err(AppError::not_found("trashed script"));
    }
    if row.revision != expected_revision {
        return Err(AppError::stale_revision(expected_revision, row.revision));
    }
    let now = now_iso();
    let result = sqlx::query(
        "UPDATE scripts SET status = 'draft', trashed_at = NULL, updated_at = ?, revision = ?
         WHERE id = ? AND status = 'trash' AND revision = ?",
    )
    .bind(&now)
    .bind(row.revision + 1)
    .bind(script_id.as_str())
    .bind(expected_revision)
    .execute(pool)
    .await?;
    expect_single_row(result.rows_affected(), expected_revision)?;

    let row = fetch_row(pool, script_id).await?;
    let preview = fetch_preview(pool, script_id).await?;
    Ok(summary_from_row(&row, preview_text(&preview)))
}

/// Permanent deletion (spec §21.5): canonical source, revisions, copied
/// assets, caches, analyses, database rows. Never touches Listener packs,
/// dictionary entries, or display profiles beyond the script's own rows.
pub async fn permanently_delete_script(
    pool: &SqlitePool,
    paths: &DataPaths,
    locks: &ScriptLocks,
    script_id: &ScriptId,
) -> Result<(), AppError> {
    let lock = locks.lock_for(script_id);
    let _guard = lock.lock().await;

    // The row must exist and must already be in the trash. Permanent deletion
    // is only ever reachable from the trash flow (spec §21.5), so a delete
    // aimed at a live — or non-existent — script is a bug or an attack, and
    // must not touch the filesystem at all.
    let row = fetch_row(pool, script_id).await?;
    if row.status != ScriptStatus::Trash {
        return Err(AppError::validation(
            "Only scripts in the trash can be deleted permanently.",
        ));
    }

    // Move the directory into quarantine BEFORE committing the database
    // deletion, so an interrupted delete leaves recoverable bytes rather than
    // a row that points at nothing (spec §47.6).
    let dir = paths.script_dir(script_id);
    let quarantined = if dir.exists() {
        let quarantine = paths.quarantine_dir();
        fs::create_dir_all(&quarantine)?;
        let target = quarantine.join(format!(
            "{}-{}",
            chrono::Utc::now().format("%Y%m%dT%H%M%S%3fZ"),
            script_id.as_str()
        ));
        fs::rename(&dir, &target).map_err(|e| {
            AppError::save_failed("CandidCue could not remove the script's folder.")
                .with_log(format!("quarantine rename failed: {e}"))
        })?;
        Some(target)
    } else {
        None
    };

    // References cascade with the script row; delete asset rows housed in
    // this script's directory first (they are per-script copies). The prefix
    // is compared with `substr` rather than `LIKE` so that `%` and `_` can
    // never behave as wildcards, independently of id validation (C1).
    let prefix = format!("scripts/{}/", script_id.as_str());
    let commit = async {
        let mut tx = pool.begin().await?;
        sqlx::query("DELETE FROM script_asset_references WHERE script_id = ?")
            .bind(script_id.as_str())
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM assets WHERE substr(rel_path, 1, ?) = ?")
            .bind(prefix.len() as i64)
            .bind(&prefix)
            .execute(&mut *tx)
            .await?;
        let deleted = sqlx::query("DELETE FROM scripts WHERE id = ?")
            .bind(script_id.as_str())
            .execute(&mut *tx)
            .await?;
        if deleted.rows_affected() != 1 {
            return Err(AppError::Internal(format!(
                "permanent delete removed {} script rows; expected exactly 1",
                deleted.rows_affected()
            )));
        }
        sqlx::query("DELETE FROM script_search WHERE script_id = ?")
            .bind(script_id.as_str())
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok::<(), AppError>(())
    }
    .await;

    match commit {
        Ok(()) => {
            if let Some(target) = quarantined {
                if let Err(err) = fs::remove_dir_all(&target) {
                    tracing::warn!(
                        script_id = script_id.as_str(),
                        error = %err,
                        "quarantined script folder could not be removed; it will be cleaned up on the next reconciliation"
                    );
                }
            }
            Ok(())
        }
        Err(err) => {
            // Put the folder back so the row and its files stay consistent.
            if let Some(target) = quarantined {
                if let Err(restore_err) = fs::rename(&target, &dir) {
                    tracing::error!(
                        script_id = script_id.as_str(),
                        error = %restore_err,
                        quarantine = %target.display(),
                        "could not restore quarantined script folder after a failed permanent delete"
                    );
                }
            }
            Err(err)
        }
    }
}

/// Roll back a script that was created moments ago and then failed to finish
/// importing. Unlike `permanently_delete_script` this does NOT require the
/// trash status — the script never became visible to the user — but it is
/// still confined to a validated id and never removes more than one row.
pub async fn force_delete_partial_import(
    pool: &SqlitePool,
    paths: &DataPaths,
    locks: &ScriptLocks,
    script_id: &ScriptId,
) -> Result<(), AppError> {
    let lock = locks.lock_for(script_id);
    let _guard = lock.lock().await;

    let prefix = format!("scripts/{}/", script_id.as_str());
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM script_asset_references WHERE script_id = ?")
        .bind(script_id.as_str())
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM assets WHERE substr(rel_path, 1, ?) = ?")
        .bind(prefix.len() as i64)
        .bind(&prefix)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM script_revisions WHERE script_id = ?")
        .bind(script_id.as_str())
        .execute(&mut *tx)
        .await?;
    let deleted = sqlx::query("DELETE FROM scripts WHERE id = ?")
        .bind(script_id.as_str())
        .execute(&mut *tx)
        .await?;
    if deleted.rows_affected() > 1 {
        return Err(AppError::Internal(
            "partial-import rollback matched more than one script".into(),
        ));
    }
    sqlx::query("DELETE FROM script_search WHERE script_id = ?")
        .bind(script_id.as_str())
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    let dir = paths.script_dir(script_id);
    if dir.exists() {
        fs::remove_dir_all(&dir)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Revisions (spec §21.4, §48.2)
// ---------------------------------------------------------------------------

pub async fn create_revision_snapshot(
    pool: &SqlitePool,
    paths: &DataPaths,
    script_id: &ScriptId,
    source: &str,
    reason: &str,
    word_count: u32,
) -> Result<String, AppError> {
    let hash = sha256_hex(source.as_bytes());
    let timestamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%3fZ");
    let file_name = format!("{}-{}.md", timestamp, &hash[..12.min(hash.len())]);
    let file_path = paths.revisions_dir(script_id).join(&file_name);
    atomic_write(&file_path, source.as_bytes())?;

    let rel_path = paths
        .relative(&file_path)
        .ok_or_else(|| AppError::Internal("revision path outside data root".into()))?;
    let next_number: i64 = sqlx::query_scalar::<_, Option<i64>>(
        "SELECT MAX(revision_number) FROM script_revisions WHERE script_id = ?",
    )
    .bind(script_id.as_str())
    .fetch_one(pool)
    .await?
    .unwrap_or(0)
        + 1;

    let id = new_uuid();
    sqlx::query(
        "INSERT INTO script_revisions
            (id, script_id, revision_number, source_hash, rel_path, reason, word_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(script_id.as_str())
    .bind(next_number)
    .bind(&hash)
    .bind(&rel_path)
    .bind(reason)
    .bind(word_count as i64)
    .bind(now_iso())
    .execute(pool)
    .await?;

    Ok(id)
}

/// Spec §21.4: a session start captures a revision of the script as it is
/// about to be performed, so the text that was on stage stays recoverable
/// even if the script is edited afterwards. This is a Rust-owned step of
/// session start — it was previously specified but never implemented, so no
/// `pre_session` revision has ever existed (H2).
///
/// Returns the revision id, or `None` when the script has no canonical file.
pub async fn snapshot_pre_session(
    pool: &SqlitePool,
    paths: &DataPaths,
    locks: &ScriptLocks,
    script_id: &ScriptId,
) -> Result<Option<String>, AppError> {
    let lock = locks.lock_for(script_id);
    let _guard = lock.lock().await;

    let canonical = paths.canonical_file(script_id);
    if !canonical.exists() {
        return Ok(None);
    }
    let source = fs::read_to_string(&canonical)?;
    let row = fetch_row(pool, script_id).await?;
    let settings = parse_settings(&row.script_settings_json);
    let (_, words, _) = stats_for(&source, &settings);
    let id =
        create_revision_snapshot(pool, paths, script_id, &source, "pre_session", words).await?;
    Ok(Some(id))
}

pub async fn list_revisions(
    pool: &SqlitePool,
    script_id: &ScriptId,
) -> Result<Vec<RevisionSummary>, AppError> {
    let rows = sqlx::query(
        "SELECT id, revision_number, source_hash, reason, word_count, created_at
         FROM script_revisions WHERE script_id = ? ORDER BY revision_number DESC",
    )
    .bind(script_id.as_str())
    .fetch_all(pool)
    .await?;
    rows.iter()
        .map(|row| {
            Ok(RevisionSummary {
                id: row.try_get("id")?,
                revision_number: row.try_get("revision_number")?,
                source_hash: row.try_get("source_hash")?,
                reason: row.try_get("reason")?,
                word_count: row.try_get("word_count")?,
                created_at: row.try_get("created_at")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(Into::into)
}

async fn fetch_revision(
    pool: &SqlitePool,
    script_id: &ScriptId,
    revision_id: &str,
) -> Result<(RevisionSummary, String), AppError> {
    let row = sqlx::query(
        "SELECT id, revision_number, source_hash, rel_path, reason, word_count, created_at
         FROM script_revisions WHERE script_id = ? AND id = ?",
    )
    .bind(script_id.as_str())
    .bind(revision_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::not_found("revision"))?;
    let summary = RevisionSummary {
        id: row.try_get("id")?,
        revision_number: row.try_get("revision_number")?,
        source_hash: row.try_get("source_hash")?,
        reason: row.try_get("reason")?,
        word_count: row.try_get("word_count")?,
        created_at: row.try_get("created_at")?,
    };
    let rel_path: String = row.try_get("rel_path")?;
    Ok((summary, rel_path))
}

pub async fn get_revision(
    pool: &SqlitePool,
    paths: &DataPaths,
    script_id: &ScriptId,
    revision_id: &str,
) -> Result<RevisionDocument, AppError> {
    let (summary, rel_path) = fetch_revision(pool, script_id, revision_id).await?;
    let source = fs::read_to_string(paths.root().join(&rel_path))?;
    Ok(RevisionDocument { summary, source })
}

/// Restore as current: first saves the current version as a revision
/// (spec §21.4 revision browser requirements).
pub async fn restore_revision(
    pool: &SqlitePool,
    paths: &DataPaths,
    locks: &ScriptLocks,
    script_id: &ScriptId,
    revision_id: &str,
    expected_revision: i64,
) -> Result<SaveResult, AppError> {
    let (_, rel_path) = fetch_revision(pool, script_id, revision_id).await?;
    let restored_source = fs::read_to_string(paths.root().join(&rel_path))?;

    // `save_script` snapshots the preimage — the content this restore
    // destroys — under the per-script lock. Doing it here as well would both
    // duplicate the snapshot and reintroduce a window between the snapshot
    // and the replacement (H2).
    save_script(
        pool,
        paths,
        locks,
        script_id,
        expected_revision,
        restored_source,
        ScriptMetadataPatch {
            revision_reason: Some("before_restore".into()),
            ..Default::default()
        },
    )
    .await
}

/// Retention thinning (spec §21.4): keep everything from the last 24 hours,
/// one per day for 30 days, one per week thereafter, max 100.
pub async fn prune_revisions(
    pool: &SqlitePool,
    paths: &DataPaths,
    script_id: &ScriptId,
) -> Result<u32, AppError> {
    let rows = sqlx::query(
        "SELECT id, rel_path, created_at FROM script_revisions
         WHERE script_id = ? ORDER BY created_at DESC",
    )
    .bind(script_id.as_str())
    .fetch_all(pool)
    .await?;

    let now = chrono::Utc::now();
    let mut keep: Vec<bool> = Vec::with_capacity(rows.len());
    let mut kept_days = std::collections::HashSet::new();
    let mut kept_weeks = std::collections::HashSet::new();
    let mut kept_count = 0usize;

    for row in &rows {
        let created_at: String = row.try_get("created_at")?;
        let age = chrono::DateTime::parse_from_rfc3339(&created_at)
            .map(|t| now.signed_duration_since(t.with_timezone(&chrono::Utc)))
            .unwrap_or_else(|_| chrono::Duration::days(365 * 10));
        let day_key = created_at.get(..10).unwrap_or("").to_string();
        let week_key = chrono::DateTime::parse_from_rfc3339(&created_at)
            .map(|t| t.format("%G-W%V").to_string())
            .unwrap_or_default();

        let retain = if kept_count >= MAX_REVISIONS_PER_SCRIPT as usize {
            false
        } else if age <= chrono::Duration::hours(24) {
            true
        } else if age <= chrono::Duration::days(30) {
            kept_days.insert(day_key)
        } else {
            kept_weeks.insert(week_key)
        };
        if retain {
            kept_count += 1;
        }
        keep.push(retain);
    }

    let mut removed = 0u32;
    for (row, retain) in rows.iter().zip(keep) {
        if retain {
            continue;
        }
        let id: String = row.try_get("id")?;
        let rel_path: String = row.try_get("rel_path")?;
        sqlx::query("DELETE FROM script_revisions WHERE id = ?")
            .bind(&id)
            .execute(pool)
            .await?;
        let file = paths.root().join(&rel_path);
        if file.exists() {
            let _ = fs::remove_file(&file);
        }
        removed += 1;
    }
    Ok(removed)
}

/// Reveal helper: absolute directory containing the canonical file.
pub fn script_folder(paths: &DataPaths, script_id: &ScriptId) -> Result<std::path::PathBuf, AppError> {
    let dir = paths.script_dir(script_id);
    if !dir.exists() {
        return Err(file_missing_error(script_id));
    }
    Ok(dir)
}

/// Purge scripts trashed more than 30 days ago (spec §21.5). Returns the
/// number of scripts removed.
pub async fn purge_expired_trash(
    pool: &SqlitePool,
    paths: &DataPaths,
    locks: &ScriptLocks,
) -> Result<u32, AppError> {
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(30))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM scripts WHERE status = 'trash' AND trashed_at IS NOT NULL AND trashed_at < ?",
    )
    .bind(&cutoff)
    .fetch_all(pool)
    .await?;
    let mut purged = 0u32;
    for id in ids {
        // Ids come from our own table, but a row whose id is not a canonical
        // UUID (hand-edited database, restored backup) must never be turned
        // into a filesystem path (C1).
        let Ok(script_id) = ScriptId::parse(&id) else {
            tracing::error!(script_id = %id, "refusing to purge a script whose id is not a UUID");
            continue;
        };
        permanently_delete_script(pool, paths, locks, &script_id).await?;
        purged += 1;
    }
    Ok(purged)
}

/// Look up a canonical path safely for reveal/export flows.
pub async fn canonical_path_checked(
    pool: &SqlitePool,
    paths: &DataPaths,
    script_id: &ScriptId,
) -> Result<std::path::PathBuf, AppError> {
    fetch_row(pool, script_id).await?;
    let canonical = paths.canonical_file(script_id);
    if !canonical.exists() {
        return Err(file_missing_error(script_id));
    }
    Ok(canonical)
}

/// Internal: expose row fetch for sibling modules.
pub(crate) async fn script_exists(pool: &SqlitePool, script_id: &ScriptId) -> Result<bool, AppError> {
    let found: Option<i64> = sqlx::query_scalar("SELECT 1 FROM scripts WHERE id = ?")
        .bind(script_id.as_str())
        .fetch_optional(pool)
        .await?;
    Ok(found.is_some())
}

/// Internal helper used by import/reconciliation to register an existing
/// on-disk canonical file in the database.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn insert_script_row(
    pool: &SqlitePool,
    paths: &DataPaths,
    id: &ScriptId,
    title: &str,
    source: &str,
    language: &str,
) -> Result<(), AppError> {
    let canonical = paths.canonical_file(id);
    let settings = ScriptSettings::default();
    let (plain, words, duration) = stats_for(source, &settings);
    let now = now_iso();
    let rel_path = paths
        .relative(&canonical)
        .ok_or_else(|| AppError::Internal("canonical path outside data root".into()))?;
    let mut tx = pool.begin().await?;
    sqlx::query(
        "INSERT INTO scripts
            (id, title, canonical_rel_path, source_hash, file_fingerprint, revision,
             status, language, spoken_word_count, estimated_duration_seconds,
             script_settings_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, 'draft', ?, ?, ?, ?, ?, ?)",
    )
    .bind(id.as_str())
    .bind(title)
    .bind(&rel_path)
    .bind(sha256_hex(source.as_bytes()))
    .bind(file_fingerprint(&canonical)?)
    .bind(language)
    .bind(words as i64)
    .bind(duration as i64)
    .bind(serde_json::to_string(&settings).unwrap_or_else(|_| "{}".into()))
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await?;
    update_fts(&mut tx, id, title, &plain).await?;
    tx.commit().await?;
    Ok(())
}

/// Fetch a script summary by id (used by import/export commands).
pub async fn get_summary(pool: &SqlitePool, script_id: &ScriptId) -> Result<ScriptSummary, AppError> {
    let row = fetch_row(pool, script_id).await?;
    let preview = fetch_preview(pool, script_id).await?;
    Ok(summary_from_row(&row, preview_text(&preview)))
}

/// Restore a canonical file from the newest revision snapshot when the file
/// vanished (spec §47.6). Returns true when restored.
pub async fn restore_canonical_from_latest_revision(
    pool: &SqlitePool,
    paths: &DataPaths,
    script_id: &ScriptId,
) -> Result<bool, AppError> {
    let latest: Option<String> = sqlx::query_scalar(
        "SELECT rel_path FROM script_revisions WHERE script_id = ? ORDER BY revision_number DESC LIMIT 1",
    )
    .bind(script_id.as_str())
    .fetch_optional(pool)
    .await?;
    let Some(rel_path) = latest else {
        return Ok(false);
    };
    let revision_file = paths.root().join(&rel_path);
    if !revision_file.exists() {
        return Ok(false);
    }
    let source = fs::read_to_string(&revision_file)?;
    let canonical = paths.canonical_file(script_id);
    atomic_write(&canonical, source.as_bytes())?;
    sqlx::query(
        "UPDATE scripts SET source_hash = ?, file_fingerprint = ?, updated_at = ?, revision = revision + 1 WHERE id = ?",
    )
    .bind(sha256_hex(source.as_bytes()))
    .bind(file_fingerprint(&canonical)?)
    .bind(now_iso())
    .bind(script_id.as_str())
    .execute(pool)
    .await?;
    Ok(true)
}

/// Reconciliation repair (spec §47.6, §48.1): if the canonical file's content
/// disagrees with the hash recorded on the row, the row (and the search index)
/// are brought up to the file. The file is the authority for source content,
/// so nothing on disk is replaced. Returns true when a repair was made.
///
/// This is the "atomic rename landed, database commit did not" crash state.
/// It is invisible to an existence check, which is why it used to survive
/// every startup untouched (H3).
pub async fn repair_row_from_canonical_file(
    pool: &SqlitePool,
    paths: &DataPaths,
    script_id: &ScriptId,
    locks: &ScriptLocks,
) -> Result<bool, AppError> {
    let lock = locks.lock_for(script_id);
    let _guard = lock.lock().await;

    let row = fetch_row(pool, script_id).await?;
    let canonical = paths.canonical_file(script_id);
    if !canonical.exists() {
        return Ok(false);
    }
    let source = fs::read_to_string(&canonical)?;
    let disk_hash = sha256_hex(source.as_bytes());
    if disk_hash == row.source_hash {
        return Ok(false);
    }

    let settings = parse_settings(&row.script_settings_json);
    let (plain, words, duration) = stats_for(&source, &settings);
    let fingerprint = file_fingerprint(&canonical)?;
    let mut tx = pool.begin().await?;
    let updated = sqlx::query(
        "UPDATE scripts SET source_hash = ?, file_fingerprint = ?, revision = ?,
             spoken_word_count = ?, estimated_duration_seconds = ?, updated_at = ?
         WHERE id = ? AND revision = ?",
    )
    .bind(&disk_hash)
    .bind(&fingerprint)
    .bind(row.revision + 1)
    .bind(words as i64)
    .bind(duration as i64)
    .bind(now_iso())
    .bind(script_id.as_str())
    .bind(row.revision)
    .execute(&mut *tx)
    .await?;
    expect_single_row(updated.rows_affected(), row.revision)?;
    update_fts(&mut tx, script_id, &row.title, &plain).await?;
    tx.commit().await?;

    tracing::warn!(
        script_id = script_id.as_str(),
        "repaired script row whose recorded hash disagreed with the canonical file"
    );
    Ok(true)
}

/// Used by reconciliation: canonical rel paths registered in the database.
pub(crate) async fn all_script_ids_and_paths(
    pool: &SqlitePool,
) -> Result<Vec<(String, String)>, AppError> {
    let rows = sqlx::query("SELECT id, canonical_rel_path FROM scripts")
        .fetch_all(pool)
        .await?;
    rows.iter()
        .map(|row| Ok((row.try_get("id")?, row.try_get("canonical_rel_path")?)))
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(Into::into)
}

#[allow(dead_code)]
pub(crate) fn stats_for_settings(source: &str, settings: &ScriptSettings) -> (String, u32, u32) {
    stats_for(source, settings)
}
