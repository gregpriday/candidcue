//! Startup reconciliation (spec §47.6): repair drift between the managed
//! filesystem and the database after unclean exits, preserving evidence in a
//! recovery report instead of deleting uncertain data.

use std::fs;
use std::time::{Duration, SystemTime};

use serde::Serialize;
use sqlx::SqlitePool;

use crate::errors::AppError;
use crate::util::{atomic_write, now_iso};

use super::repo;
use super::{DataPaths, ScriptId};

const STALE_TEMP_AGE: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryReport {
    pub ran_at: String,
    pub integrity_ok: bool,
    pub temp_files_removed: u32,
    pub orphan_files_recovered: Vec<String>,
    pub missing_files_restored: Vec<String>,
    pub missing_files_unrecoverable: Vec<String>,
    /// Rows whose canonical file did not match the recorded hash — the
    /// "file rename succeeded, database commit did not" crash state.
    pub hash_mismatches_repaired: Vec<String>,
    pub listener_installs_rolled_back: u32,
    pub trash_purged: u32,
    pub notes: Vec<String>,
}

impl RecoveryReport {
    pub fn has_findings(&self) -> bool {
        !self.integrity_ok
            || self.temp_files_removed > 0
            || !self.orphan_files_recovered.is_empty()
            || !self.missing_files_restored.is_empty()
            || !self.missing_files_unrecoverable.is_empty()
            || !self.hash_mismatches_repaired.is_empty()
            || self.listener_installs_rolled_back > 0
    }
}

pub async fn run_startup_reconciliation(
    pool: &SqlitePool,
    paths: &DataPaths,
    locks: &super::ScriptLocks,
) -> Result<RecoveryReport, AppError> {
    let mut report = RecoveryReport {
        ran_at: now_iso(),
        integrity_ok: true,
        ..Default::default()
    };

    // 1. Quick database integrity check.
    let check: String = sqlx::query_scalar("PRAGMA quick_check")
        .fetch_one(pool)
        .await
        .unwrap_or_else(|_| "failed".into());
    report.integrity_ok = check == "ok";
    if !report.integrity_ok {
        // Fail closed (spec §47.6, §48.5): a database that failed its
        // integrity check must not be written to. Every step below mutates
        // something — deleting temp files, inserting recovered rows, purging
        // trash — so none of them may run. The evidence is preserved in the
        // report and the caller surfaces it to the user.
        report.notes.push(format!("quick_check: {check}"));
        report.notes.push(
            "database integrity check failed; reconciliation made no changes".to_string(),
        );
        tracing::error!(check = %check, "database integrity check failed; refusing to reconcile");
        let _ = write_report(paths, &report);
        return Ok(report);
    }

    // 2. Remove abandoned temporary files older than a safe threshold.
    report.temp_files_removed = remove_stale_temp_files(paths)?;

    // 3. Canonical files on disk missing from the database → recover.
    let known: std::collections::HashSet<String> = repo::all_script_ids_and_paths(pool)
        .await?
        .into_iter()
        .map(|(id, _)| id)
        .collect();
    let scripts_dir = paths.scripts_dir();
    if scripts_dir.exists() {
        for entry in fs::read_dir(&scripts_dir)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let dir_name = entry.file_name().to_string_lossy().to_string();
            if known.contains(&dir_name) {
                continue;
            }
            // A directory whose name is not a canonical UUID is not ours; it
            // must never be adopted as a script id and turned back into a
            // path (C1).
            let Ok(script_id) = ScriptId::parse(&dir_name) else {
                report
                    .notes
                    .push(format!("ignored non-UUID directory in scripts root: {dir_name}"));
                continue;
            };
            let canonical = entry.path().join("script.md");
            if !canonical.exists() {
                continue;
            }
            match fs::read_to_string(&canonical) {
                Ok(source) => {
                    let title = format!("Recovered script {}", &dir_name[..8.min(dir_name.len())]);
                    if repo::insert_script_row(pool, paths, &script_id, &title, &source, "en")
                        .await
                        .is_ok()
                    {
                        report.orphan_files_recovered.push(dir_name);
                    }
                }
                Err(err) => {
                    report
                        .notes
                        .push(format!("unreadable orphan {dir_name}: {err}"));
                }
            }
        }
    }

    // 4. Every row is checked against its canonical file: missing files are
    // restored from the latest revision, and — the case that used to be
    // silently treated as healthy — rows whose recorded hash disagrees with
    // the file on disk are repaired. That mismatch is exactly the crash state
    // where the atomic rename landed but the database commit did not, so it
    // must be detected by content, not by mere existence (H3). The file is
    // the authority for source content (spec §48.1), so the database is
    // brought up to the file; disk content is never replaced here.
    for (id, _) in repo::all_script_ids_and_paths(pool).await? {
        let Ok(script_id) = ScriptId::parse(&id) else {
            report
                .notes
                .push(format!("script row {id} has a non-UUID id; skipped"));
            continue;
        };
        let canonical = paths.canonical_file(&script_id);
        if !canonical.exists() {
            match repo::restore_canonical_from_latest_revision(pool, paths, &script_id).await {
                Ok(true) => report.missing_files_restored.push(id),
                Ok(false) => report.missing_files_unrecoverable.push(id),
                Err(err) => report.notes.push(format!("restore {id}: {err}")),
            }
            continue;
        }
        match repo::repair_row_from_canonical_file(pool, paths, &script_id, locks).await {
            Ok(true) => report.hash_mismatches_repaired.push(id),
            Ok(false) => {}
            Err(err) => report.notes.push(format!("repair {id}: {err}")),
        }
    }

    // 5. Finish or roll back Listener installs: anything still marked
    // 'installing' after a restart failed mid-flight.
    let rolled_back = sqlx::query(
        "UPDATE listener_packs SET state = 'failed' WHERE state = 'installing'",
    )
    .execute(pool)
    .await?;
    report.listener_installs_rolled_back = rolled_back.rows_affected() as u32;

    // 6. Clear expired compiled caches (best effort).
    let compiled = paths.cache_dir().join("compiled");
    if compiled.exists() {
        let _ = remove_older_than(&compiled, Duration::from_secs(30 * 24 * 3600));
    }

    // 7. Purge trash older than 30 days (spec §21.5).
    report.trash_purged = repo::purge_expired_trash(pool, paths, locks).await.unwrap_or(0);

    // Preserve evidence: write the report to the diagnostics directory.
    write_report(paths, &report)?;

    Ok(report)
}

fn write_report(paths: &DataPaths, report: &RecoveryReport) -> Result<(), AppError> {
    if !report.has_findings() {
        return Ok(());
    }
    let dir = paths.diagnostics_dir();
    fs::create_dir_all(&dir)?;
    let file = dir.join(format!(
        "recovery-{}.json",
        chrono::Utc::now().format("%Y%m%dT%H%M%S%3fZ")
    ));
    if let Ok(json) = serde_json::to_vec_pretty(report) {
        let _ = atomic_write(&file, &json);
    }
    Ok(())
}

fn remove_stale_temp_files(paths: &DataPaths) -> Result<u32, AppError> {
    let mut removed = 0u32;
    let scripts_dir = paths.scripts_dir();
    if !scripts_dir.exists() {
        return Ok(0);
    }
    let cutoff = SystemTime::now() - STALE_TEMP_AGE;
    for script_entry in fs::read_dir(&scripts_dir)? {
        let script_entry = script_entry?;
        if !script_entry.file_type()?.is_dir() {
            continue;
        }
        for entry in fs::read_dir(script_entry.path())? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name.contains(".tmp-") {
                if let Ok(meta) = entry.metadata() {
                    if meta.modified().map(|m| m < cutoff).unwrap_or(true) {
                        let _ = fs::remove_file(entry.path());
                        removed += 1;
                    }
                }
            }
        }
    }
    Ok(removed)
}

fn remove_older_than(dir: &std::path::Path, age: Duration) -> std::io::Result<()> {
    let cutoff = SystemTime::now() - age;
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            if let Ok(meta) = entry.metadata() {
                if meta.modified().map(|m| m < cutoff).unwrap_or(false) {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    }
    Ok(())
}
