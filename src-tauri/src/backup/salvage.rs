//! What only the old database knew about each script, read back out of it.
//!
//! ## Why this exists (#252)
//!
//! A script's text, its revision snapshots and its images are files, and a
//! rebuild regenerates the index from them. Its NAME is not a file. Neither is
//! whether it was in the Trash, when it went there, or its per-script
//! settings: those live in the `scripts` table and nowhere else. A rebuild
//! starts from an empty database, so every script used to come back as
//! `Recovered script 8a0ece26`, Trash came back as live drafts, and someone
//! with forty scripts had to open all forty to find out which was which.
//!
//! The database being rebuilt is usually broken in a way that stops it
//! OPENING — a failed integrity check, a migration that will not apply — not in
//! a way that makes its `scripts` table unreadable. So the rebuild reads that
//! table out of the quarantined copy, best effort, and leaves what it found at
//! the data root for the next launch's reconciliation to apply as it adopts
//! each folder. Nothing here can fail a rebuild: a database that yields
//! nothing simply leaves the scripts to be named from their own text.
//!
//! ## Journalled like the move it follows
//!
//! The index is written in two steps. Before the database is moved, the
//! rebuild records WHERE it is going and that its names have not been read
//! yet (`complete: false`); once they have, the record is rewritten complete.
//! A crash anywhere in between — during the move, or after it and before the
//! read — leaves that record behind, and the next launch reads the quarantined
//! database itself before it adopts a single folder. Without the first step,
//! the crash window between moving the database and reading it was a library
//! of scripts named after their first lines, with the names sitting unread in
//! quarantine.
//!
//! Successive recoveries before a relaunch (a rebuild, then a backup restore;
//! two restores) MERGE into the record rather than replacing it: each read
//! describes the scripts its database knew, and a script only the earlier one
//! knew still needs its name.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use sqlx::{ConnectOptions, Connection, Row};

use crate::errors::AppError;

/// Where a rebuild leaves the metadata it salvaged, for the next launch.
///
/// At the data root rather than inside the quarantine folder, so there is
/// never a question of WHICH rebuild's index applies: there is at most one,
/// written by the most recent rebuild that found anything, and reconciliation
/// removes it once it has adopted the folders it describes.
const PENDING_SCRIPT_INDEX: &str = "rebuild-script-index.json";

/// A scratch copy older than this belongs to a salvage that never cleaned up
/// after itself — a process killed part way through — not to one running now.
const ABANDONED_SCRATCH_AGE: Duration = Duration::from_secs(60 * 60);

/// One `scripts` row, as much of it as could be read.
///
/// Everything but the id is optional: a value that is missing or unreadable
/// falls back to the default the adopting side would have used anyway, and
/// must not cost the script the values that WERE readable — an unreadable
/// title still leaves it in the Trash it was in.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SalvagedScript {
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub trashed_at: Option<String>,
    #[serde(default)]
    pub script_settings_json: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingScriptIndex {
    /// The quarantined database the names are read from.
    source: String,
    salvaged_at: String,
    /// `false` between recording the rebuild's intent and finishing the read:
    /// the next launch reads `source` itself before applying anything.
    #[serde(default = "complete_by_default")]
    complete: bool,
    scripts: Vec<SalvagedScript>,
}

fn complete_by_default() -> bool {
    true
}

/// Read every `scripts` row that can still be read out of `database`.
///
/// Works on a COPY of the database and its WAL, in a scratch directory under
/// `scratch_parent`, never on the file itself. The original is evidence — it
/// may be the only copy of the session history — and opening a SQLite file is
/// not a read: it replays a WAL, creates a shared-memory file, and checkpoints
/// on close. The copy is opened read-write for exactly that reason, so that
/// replaying a WAL whose commits were never checkpointed (which a read-only
/// connection may refuse to do) is something it is allowed to do to itself.
///
/// Returns nothing rather than an error: every failure here leaves the scripts
/// to be named from their own text, which is what happened before this
/// existed.
pub async fn salvage_scripts(database: &Path, scratch_parent: &Path) -> Vec<SalvagedScript> {
    if !database.is_file() {
        return Vec::new();
    }
    remove_abandoned_scratch(scratch_parent);
    let scratch = scratch_parent.join(format!("salvage-{}", crate::util::new_uuid()));
    let salvaged = match copy_database_set(database, &scratch) {
        Ok(copy) => read_scripts(&copy).await,
        Err(err) => {
            tracing::warn!(error = %err, "could not copy the old database to read its script names");
            Vec::new()
        }
    };
    if let Err(err) = std::fs::remove_dir_all(&scratch) {
        tracing::warn!(
            error = %err,
            scratch = %scratch.display(),
            "could not remove the scratch copy of the old database"
        );
    }
    salvaged
}

/// Copies left by a salvage that was killed part way. Each is a whole
/// database, so they are not left to accumulate in the cache.
fn remove_abandoned_scratch(scratch_parent: &Path) {
    let Ok(entries) = std::fs::read_dir(scratch_parent) else {
        return;
    };
    let cutoff = SystemTime::now() - ABANDONED_SCRATCH_AGE;
    for entry in entries.flatten() {
        let abandoned = entry.file_name().to_string_lossy().starts_with("salvage-")
            && entry.file_type().map(|t| t.is_dir()).unwrap_or(false)
            && entry
                .metadata()
                .and_then(|m| m.modified())
                .map(|modified| modified < cutoff)
                .unwrap_or(false);
        if abandoned {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// The database and its WAL, copied side by side under the same name so the
/// copy finds its own log. The shared-memory file is deliberately left behind:
/// it is a cache of the WAL that SQLite rebuilds, and a stale one from a
/// process that died is the one thing here worth not trusting.
fn copy_database_set(database: &Path, scratch: &Path) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(scratch)?;
    let copy = scratch.join("candidcue.sqlite3");
    std::fs::copy(database, &copy)?;
    let mut wal = database.as_os_str().to_owned();
    wal.push("-wal");
    let wal = PathBuf::from(wal);
    if wal.is_file() {
        let mut target = copy.as_os_str().to_owned();
        target.push("-wal");
        std::fs::copy(&wal, PathBuf::from(target))?;
    }
    Ok(copy)
}

async fn read_scripts(copy: &Path) -> Vec<SalvagedScript> {
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(copy)
        .create_if_missing(false)
        // A schema read out of a damaged file is not one to run code from.
        .pragma("trusted_schema", "OFF");
    let mut conn = match options.connect().await {
        Ok(conn) => conn,
        Err(err) => {
            tracing::warn!(error = %err, "the old database would not open to give up its script names");
            return Vec::new();
        }
    };

    /*
     * One row at a time, walking the rowid.
     *
     * A corrupt page fails the query that reaches it. Read in a single query,
     * that takes every row with it, including the ones before the damage that
     * read perfectly well; read like this, everything up to the bad page is
     * kept and the walk stops there.
     */
    let mut salvaged = Vec::new();
    let mut after = i64::MIN;
    loop {
        let row = sqlx::query(
            "SELECT rowid, id, title, status, language, created_at, updated_at, trashed_at,
                    script_settings_json
             FROM scripts WHERE rowid > ? ORDER BY rowid LIMIT 1",
        )
        .bind(after)
        .fetch_optional(&mut conn)
        .await;
        let row = match row {
            Ok(Some(row)) => row,
            Ok(None) => break,
            Err(err) => {
                tracing::warn!(
                    error = %err,
                    salvaged = salvaged.len(),
                    "stopped reading script names from the old database"
                );
                break;
            }
        };
        let Ok(rowid) = row.try_get::<i64, _>("rowid") else {
            break;
        };
        after = rowid;
        // Column by column: an unreadable settings blob must not cost the
        // script its readable title, nor an unreadable title its Trash.
        let text = |column: &str| {
            row.try_get::<Option<String>, _>(column)
                .ok()
                .flatten()
                .filter(|value| !value.trim().is_empty())
        };
        let Some(id) = text("id") else {
            continue;
        };
        salvaged.push(SalvagedScript {
            id,
            title: text("title"),
            status: text("status"),
            language: text("language"),
            created_at: text("created_at"),
            updated_at: text("updated_at"),
            trashed_at: text("trashed_at"),
            script_settings_json: text("script_settings_json"),
        });
    }
    let _ = conn.close().await;
    salvaged
}

/// Record, before the database is moved, that its names are to be read from
/// `database` — so a crash before the read finishes still leaves the next
/// launch knowing where they are.
///
/// Anything an earlier, unapplied recovery left is carried forward.
pub fn record_pending_salvage(root: &Path, database: &Path) -> Result<(), AppError> {
    let carried = read_index(root).ok().flatten().map(|index| index.scripts).unwrap_or_default();
    write_index(root, database, false, carried)
}

/// Read the names out of the database a pending record points at, merge them
/// over what it already carries, and mark it complete. A record that ends up
/// naming nothing is removed. Best effort throughout.
pub async fn finish_pending_salvage(root: &Path, scratch_parent: &Path) {
    let index = match read_index(root) {
        Ok(Some(index)) if !index.complete => index,
        _ => return,
    };
    let source = PathBuf::from(&index.source);
    let salvaged = salvage_scripts(&source, scratch_parent).await;
    let read = salvaged.len();

    // Newest read wins for a script both describe.
    let fresh: HashSet<String> = salvaged.iter().map(|s| s.id.clone()).collect();
    let mut scripts: Vec<SalvagedScript> =
        index.scripts.into_iter().filter(|s| !fresh.contains(&s.id)).collect();
    scripts.extend(salvaged);

    if scripts.is_empty() {
        clear_pending_index(root);
        return;
    }
    match write_index(root, &source, true, scripts) {
        Ok(()) => tracing::info!(read, "kept the old database's script names for the rebuild"),
        Err(err) => tracing::warn!(error = %err, "could not keep the old database's script names"),
    }
}

/// The names a rebuild salvaged, by script id, for reconciliation to apply.
/// `Ok(None)` when no recovery is waiting.
///
/// Finishes an interrupted salvage first. An index that cannot be parsed is
/// reported as present and empty, so the caller retires it rather than
/// tripping over it on every launch; one that exists and cannot be READ is an
/// error, because adopting the folders without it would make the fallback
/// names permanent.
pub async fn load_pending_index(
    root: &Path,
    scratch_parent: &Path,
) -> std::io::Result<Option<HashMap<String, SalvagedScript>>> {
    finish_pending_salvage(root, scratch_parent).await;
    Ok(read_index(root)?.map(|index| {
        index
            .scripts
            .into_iter()
            .map(|script| (script.id.clone(), script))
            .collect()
    }))
}

/// Whatever a recovery has salvaged and not yet applied, read as is. For the
/// rescue copy, which only needs names and must not start a salvage of its
/// own.
pub fn pending_entries(root: &Path) -> Vec<SalvagedScript> {
    read_index(root).ok().flatten().map(|index| index.scripts).unwrap_or_default()
}

/// Keep only the entries whose scripts are still waiting to be adopted —
/// a folder whose text could not be read this launch, or whose adoption
/// failed — and remove the record once nothing is. Never applied to a script
/// that has a row, so a later rename or restore from the Trash is not
/// overruled by it.
pub fn retain_pending_index(root: &Path, waiting: &HashSet<String>) {
    let index = match read_index(root) {
        Ok(Some(index)) => index,
        Ok(None) => return,
        Err(err) => {
            tracing::warn!(error = %err, "could not re-read the rebuild's script index");
            return;
        }
    };
    let source = PathBuf::from(&index.source);
    let kept: Vec<SalvagedScript> =
        index.scripts.into_iter().filter(|s| waiting.contains(&s.id)).collect();
    if kept.is_empty() {
        clear_pending_index(root);
    } else if let Err(err) = write_index(root, &source, index.complete, kept) {
        tracing::warn!(error = %err, "could not trim the rebuild's script index");
    }
}

pub fn clear_pending_index(root: &Path) {
    match std::fs::remove_file(root.join(PENDING_SCRIPT_INDEX)) {
        Ok(()) => {
            let _ = super::sync_dir(root);
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => tracing::warn!(error = %err, "could not remove the rebuild's script index"),
    }
}

/// Durably, like the rebuild's own marker: the launch that reads it is the one
/// that adopts every script folder, and an index that did not survive the
/// restart in between is forty scripts named after their first lines.
fn write_index(
    root: &Path,
    source: &Path,
    complete: bool,
    scripts: Vec<SalvagedScript>,
) -> Result<(), AppError> {
    super::write_json_durably(
        &root.join(PENDING_SCRIPT_INDEX),
        &PendingScriptIndex {
            source: source.to_string_lossy().to_string(),
            salvaged_at: crate::util::now_iso(),
            complete,
            scripts,
        },
    )
}

fn read_index(root: &Path) -> std::io::Result<Option<PendingScriptIndex>> {
    let raw = match std::fs::read(root.join(PENDING_SCRIPT_INDEX)) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err),
    };
    match serde_json::from_slice::<PendingScriptIndex>(&raw) {
        Ok(index) => Ok(Some(index)),
        Err(err) => {
            tracing::warn!(error = %err, "the script names a rebuild saved could not be read");
            Ok(Some(PendingScriptIndex {
                source: String::new(),
                salvaged_at: String::new(),
                complete: true,
                scripts: Vec::new(),
            }))
        }
    }
}
