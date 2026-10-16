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

use std::collections::HashMap;
use std::path::{Path, PathBuf};

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

/// One `scripts` row, as much of it as could be read.
///
/// Everything but the id and title is optional: a value that is missing or
/// unreadable falls back to the default the adopting side would have used
/// anyway, and must not cost the script the title that WAS readable.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SalvagedScript {
    pub id: String,
    pub title: String,
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
    /// The quarantined database this was read from, for whoever finds it.
    source: String,
    salvaged_at: String,
    scripts: Vec<SalvagedScript>,
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
    let scratch = scratch_parent.join(format!("salvage-{}", crate::util::new_uuid()));
    let salvaged = match copy_database_set(database, &scratch) {
        Ok(copy) => read_scripts(&copy).await,
        Err(err) => {
            tracing::warn!(error = %err, "could not copy the old database to read its script names");
            Vec::new()
        }
    };
    let _ = std::fs::remove_dir_all(&scratch);
    salvaged
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
        // script its readable title.
        let text = |column: &str| {
            row.try_get::<Option<String>, _>(column)
                .ok()
                .flatten()
                .filter(|value| !value.trim().is_empty())
        };
        let (Some(id), Some(title)) = (text("id"), text("title")) else {
            continue;
        };
        salvaged.push(SalvagedScript {
            id,
            title,
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

/// Leave what a rebuild salvaged for the next launch to apply.
///
/// Durably, like the rebuild's own marker: the launch that reads it is the one
/// that adopts every script folder, and an index that did not survive the
/// restart in between is forty scripts named after their UUIDs.
pub fn write_pending_index(
    root: &Path,
    source: &Path,
    scripts: Vec<SalvagedScript>,
) -> Result<(), AppError> {
    super::write_json_durably(
        &root.join(PENDING_SCRIPT_INDEX),
        &PendingScriptIndex {
            source: source.to_string_lossy().to_string(),
            salvaged_at: crate::util::now_iso(),
            scripts,
        },
    )
}

/// The salvaged metadata a rebuild left behind, by script id. `None` when no
/// rebuild is waiting to be applied.
///
/// An index that cannot be parsed is reported as present and empty, so the
/// caller still clears it rather than tripping over it on every launch.
pub fn read_pending_index(root: &Path) -> Option<HashMap<String, SalvagedScript>> {
    let raw = std::fs::read(root.join(PENDING_SCRIPT_INDEX)).ok()?;
    match serde_json::from_slice::<PendingScriptIndex>(&raw) {
        Ok(index) => Some(
            index
                .scripts
                .into_iter()
                .map(|script| (script.id.clone(), script))
                .collect(),
        ),
        Err(err) => {
            tracing::warn!(error = %err, "the script names a rebuild saved could not be read");
            Some(HashMap::new())
        }
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
