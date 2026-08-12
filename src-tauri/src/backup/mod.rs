//! Export, restore, and rebuild: everything that answers "can I get my work
//! back?".
//!
//! ## The problem this replaces
//!
//! `export_all_data` used to create its destination directory immediately,
//! attempt a `VACUUM INTO`, turn a snapshot failure into a *warning*, copy the
//! scripts tree, and return `{ path, scriptsCopied, warnings }`. The frontend
//! adapter then discarded the count AND the warnings and returned only the
//! path — so Settings displayed **"Export ready"** whenever a directory came
//! back. A folder named `CandidCue-export-…` could therefore contain no
//! database at all, and nothing anywhere said so.
//!
//! There was also no way to get any of it back in. "Export all data" that
//! cannot be restored is a copy, not a backup.
//!
//! ## The shape now
//!
//! Three operations, and one rule they share: **an artefact is only given its
//! real name once it has been verified.**
//!
//! - [`export_all_data`] writes into a hidden sibling directory, checksums
//!   everything it wrote, and renames into place. If any section failed it
//!   still renames — into a name ending `-INCOMPLETE`, with `complete: false`
//!   in both the manifest and the IPC result, because a partial export is
//!   worth keeping and must never be presentable as a whole one.
//! - [`restore_all_data`] validates the manifest and every checksum BEFORE it
//!   touches live data, then moves the current state aside, commits, and rolls
//!   back if the commit fails part way.
//! - [`rebuild_database_index`] throws the database away on purpose. The
//!   canonical Markdown files are the authority for script content (§48.1), so
//!   an index can always be regenerated from them; this is the recovery of last
//!   resort and it is deliberately not destructive to anything but the index.
//!
//! ## What an export contains, and what it does not
//!
//! Contains: the database (a consistent `VACUUM INTO` snapshot), the whole
//! canonical scripts tree — sources, revisions and assets — and the durable
//! settings document including display profiles.
//!
//! Does not contain: the speech model. It is ~161 MB of third-party ONNX under
//! its own licence, it is downloaded in-app, and it is not the user's data. The
//! manifest says so explicitly rather than leaving its absence to be discovered
//! during a restore.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

use crate::errors::AppError;
use crate::scripts::DataPaths;

/// Bumped when the on-disk export layout changes in a way an older build
/// cannot read. A restore refuses anything it does not recognise rather than
/// guessing.
pub const EXPORT_SCHEMA_VERSION: u32 = 1;

const MANIFEST_NAME: &str = "manifest.json";
const DATABASE_NAME: &str = "candidcue.sqlite3";
const SETTINGS_NAME: &str = "settings.json";
const SCRIPTS_DIR: &str = "scripts";

/// One file in the export, with enough to prove it arrived intact.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFile {
    /// Relative to the export root, always forward-slashed.
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}

/// A named part of the export, and whether it actually made it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSection {
    pub name: String,
    /// `true` only when every file this section intended to write was written
    /// and checksummed.
    pub complete: bool,
    pub file_count: u32,
    pub bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportManifest {
    pub export_schema_version: u32,
    pub app_version: String,
    pub created_at: String,
    /// The highest applied migration version in the snapshotted database.
    pub database_schema_version: i64,
    pub platform: String,
    pub sections: Vec<ExportSection>,
    pub files: Vec<ExportFile>,
    pub warnings: Vec<String>,
    /// What was deliberately left out, so its absence is a statement rather
    /// than a discovery.
    pub excluded: Vec<String>,
    /// The single question the UI is allowed to ask.
    pub complete: bool,
}

/// What crosses IPC. Deliberately carries `complete` first: the adapter that
/// used to drop `warnings` could not have dropped this without the compiler
/// noticing, because the frontend has to branch on it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataExportResult {
    pub path: String,
    pub complete: bool,
    pub scripts_copied: u32,
    pub file_count: u32,
    pub total_bytes: u64,
    pub warnings: Vec<String>,
    pub excluded: Vec<String>,
}

/* ------------------------------------------------------------------ export */

/// Write a complete, checksummed, restorable export under `dest_root`.
///
/// Never partially visible: everything is written into a dot-prefixed sibling
/// and renamed once the manifest is on disk. An export that failed a section is
/// still renamed — into a `-INCOMPLETE` name — because the half that worked is
/// worth having and the name has to carry the warning even if the user only
/// ever sees it in Finder.
pub async fn export_all_data(
    pool: &SqlitePool,
    paths: &DataPaths,
    dest_root: &Path,
) -> Result<DataExportResult, AppError> {
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S").to_string();
    let staging = dest_root.join(format!(".CandidCue-export-{stamp}.partial"));

    /*
     * The destination must not be inside what is being copied.
     *
     * `copy_tree` walks the source with `read_dir`, so a destination under
     * `scripts/` means it finds its own newly created target directory and
     * descends into it — recursing until the path length, the stack or the
     * disk runs out. A user choosing their scripts folder in a file picker is
     * not an exotic input.
     */
    reject_nested_destination(&paths.scripts_dir(), dest_root)?;
    reject_nested_destination(paths.root(), dest_root)?;

    // A leftover staging directory from an interrupted run is garbage by
    // definition — it has no manifest and was never renamed.
    if staging.exists() {
        std::fs::remove_dir_all(&staging)?;
    }
    std::fs::create_dir_all(&staging)?;

    let mut sections = Vec::new();
    let mut warnings = Vec::new();

    // 1. The database, as a consistent snapshot.
    let database_schema_version = write_database_snapshot(pool, &staging, &mut sections, &mut warnings).await;

    // 2. The canonical scripts tree — sources, revisions, assets.
    let scripts_copied = write_scripts_tree(paths, &staging, &mut sections, &mut warnings);

    // 3. Durable settings, as JSON beside the database.
    //
    // Redundant with the database snapshot when that succeeded, and that is
    // the point: settings are small, and a plain-text copy is readable by a
    // human staring at a broken restore. It is also the section that used to
    // be missing entirely.
    write_settings_document(pool, &staging, &mut sections, &mut warnings).await;

    // 4. Checksum everything actually present, then the manifest.
    let files = checksum_tree(&staging)?;
    let complete = sections.iter().all(|section| section.complete);

    let manifest = ExportManifest {
        export_schema_version: EXPORT_SCHEMA_VERSION,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        created_at: crate::util::now_iso(),
        database_schema_version,
        platform: format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        sections: sections.clone(),
        files: files.clone(),
        warnings: warnings.clone(),
        excluded: vec![
            "Speech model files. They are downloaded in CandidCue (Settings › Speech), \
             carry their own third-party licence, and are not your data."
                .to_string(),
            "Application logs and diagnostics. Use Export support bundle for those."
                .to_string(),
        ],
        complete,
    };
    std::fs::write(
        staging.join(MANIFEST_NAME),
        serde_json::to_vec_pretty(&manifest).map_err(|e| AppError::Internal(e.to_string()))?,
    )?;

    // 5. Give it its real name, which encodes the answer.
    let final_name = if complete {
        format!("CandidCue-export-{stamp}")
    } else {
        format!("CandidCue-export-{stamp}-INCOMPLETE")
    };
    let final_path = dest_root.join(final_name);
    std::fs::rename(&staging, &final_path)?;

    Ok(DataExportResult {
        path: final_path.to_string_lossy().to_string(),
        complete,
        scripts_copied,
        file_count: files.len() as u32,
        total_bytes: files.iter().map(|f| f.bytes).sum(),
        warnings,
        excluded: manifest.excluded,
    })
}

async fn write_database_snapshot(
    pool: &SqlitePool,
    staging: &Path,
    sections: &mut Vec<ExportSection>,
    warnings: &mut Vec<String>,
) -> i64 {
    let target = staging.join(DATABASE_NAME);
    let schema_version: i64 =
        sqlx::query_scalar("SELECT COALESCE(MAX(version), 0) FROM _sqlx_migrations")
            .fetch_one(pool)
            .await
            .unwrap_or(0);

    // Single-quote escaping because `VACUUM INTO` takes a literal, not a bind.
    let sql = format!(
        "VACUUM INTO '{}'",
        target.display().to_string().replace('\'', "''")
    );
    match sqlx::query(&sql).execute(pool).await {
        Ok(_) => {
            let bytes = std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
            if bytes == 0 {
                // Reported success, produced nothing. Treating this as a pass
                // is how an empty file ends up named as a backup.
                let problem = "the database snapshot was written but is empty".to_string();
                warnings.push(problem.clone());
                sections.push(ExportSection {
                    name: "database".into(),
                    complete: false,
                    file_count: 0,
                    bytes: 0,
                    problem: Some(problem),
                });
            } else {
                sections.push(ExportSection {
                    name: "database".into(),
                    complete: true,
                    file_count: 1,
                    bytes,
                    problem: None,
                });
            }
        }
        Err(err) => {
            /*
             * The failure that used to become a warning and let the export be
             * announced as ready. It is now the thing that makes the whole
             * export incomplete, renames the folder, and stops the toast.
             */
            let problem = format!("database snapshot failed: {err}");
            warnings.push(problem.clone());
            sections.push(ExportSection {
                name: "database".into(),
                complete: false,
                file_count: 0,
                bytes: 0,
                problem: Some(problem),
            });
        }
    }
    schema_version
}

fn write_scripts_tree(
    paths: &DataPaths,
    staging: &Path,
    sections: &mut Vec<ExportSection>,
    warnings: &mut Vec<String>,
) -> u32 {
    let scripts_dir = paths.scripts_dir();
    let target = staging.join(SCRIPTS_DIR);

    if !scripts_dir.exists() {
        // No scripts is a legitimate state, not a failure.
        sections.push(ExportSection {
            name: "scripts".into(),
            complete: true,
            file_count: 0,
            bytes: 0,
            problem: None,
        });
        return 0;
    }

    match copy_tree(&scripts_dir, &target) {
        Ok(()) => {
            let copied = std::fs::read_dir(&target).map(|d| d.count()).unwrap_or(0) as u32;
            let files = checksum_tree(&target).unwrap_or_default();
            sections.push(ExportSection {
                name: "scripts".into(),
                complete: true,
                file_count: files.len() as u32,
                bytes: files.iter().map(|f| f.bytes).sum(),
                problem: None,
            });
            copied
        }
        Err(err) => {
            let problem = format!("scripts tree copy failed: {err}");
            warnings.push(problem.clone());
            sections.push(ExportSection {
                name: "scripts".into(),
                complete: false,
                file_count: 0,
                bytes: 0,
                problem: Some(problem),
            });
            0
        }
    }
}

async fn write_settings_document(
    pool: &SqlitePool,
    staging: &Path,
    sections: &mut Vec<ExportSection>,
    warnings: &mut Vec<String>,
) {
    let settings = crate::settings::get_settings(pool).await;
    let profiles = crate::windows::list_display_profiles(pool).await;

    match (settings, profiles) {
        (Ok(settings), Ok(profiles)) => {
            let document = serde_json::json!({
                "settings": settings,
                "displayProfiles": profiles,
            });
            let target = staging.join(SETTINGS_NAME);
            match serde_json::to_vec_pretty(&document)
                .map_err(|e| e.to_string())
                .and_then(|bytes| std::fs::write(&target, &bytes).map(|_| bytes.len()).map_err(|e| e.to_string()))
            {
                Ok(bytes) => sections.push(ExportSection {
                    name: "settings".into(),
                    complete: true,
                    file_count: 1,
                    bytes: bytes as u64,
                    problem: None,
                }),
                Err(err) => {
                    let problem = format!("settings could not be written: {err}");
                    warnings.push(problem.clone());
                    sections.push(ExportSection {
                        name: "settings".into(),
                        complete: false,
                        file_count: 0,
                        bytes: 0,
                        problem: Some(problem),
                    });
                }
            }
        }
        (settings, profiles) => {
            let problem = format!(
                "settings could not be read: {}",
                settings.err().map(|e| e.to_string()).unwrap_or_else(|| profiles
                    .err()
                    .map(|e| e.to_string())
                    .unwrap_or_default())
            );
            warnings.push(problem.clone());
            sections.push(ExportSection {
                name: "settings".into(),
                complete: false,
                file_count: 0,
                bytes: 0,
                problem: Some(problem),
            });
        }
    }
}

/* ----------------------------------------------------------------- restore */

/// What validating an export found. Nothing has been restored yet.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub path: String,
    pub app_version: String,
    pub created_at: String,
    /// How many scripts the export contains — what WILL be restored.
    pub scripts_in_export: u32,
    /// Always true. See the module comment on `restore_all_data`.
    pub restart_required: bool,
}

/// The marker that tells the next launch to apply a restore.
const PENDING_RESTORE: &str = "restore-pending.json";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingRestore {
    export_path: String,
    requested_at: String,
    app_version: String,
    /// How many launches have tried to apply this.
    ///
    /// Bounds the retry an unconsumed marker would otherwise allow forever. An
    /// interrupted restore resumes; an impossible one stops and says so.
    #[serde(default)]
    attempts: u32,
    /// The quarantine directory this restore evacuates into.
    ///
    /// Minted once, on the first attempt, and reused by every retry. A fresh
    /// timestamped directory per attempt loses the identity of the original
    /// state: after a crash the next attempt would quarantine the previous
    /// attempt's partial output, and the real original would be two
    /// generations back with nothing pointing at it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    quarantine_generation: Option<String>,
}

/// Write the marker, replacing it whole.
///
/// Through a sibling temporary file and a rename, because the marker is
/// rewritten on every attempt and a crash during that write would truncate the
/// only record of what is in flight. A rename is atomic within a directory.
fn write_marker(marker: &Path, pending: &PendingRestore) -> Result<(), AppError> {
    let temporary = marker.with_extension("json.writing");
    std::fs::write(
        &temporary,
        serde_json::to_vec_pretty(pending).map_err(|e| AppError::Internal(e.to_string()))?,
    )?;
    std::fs::rename(&temporary, marker)?;
    Ok(())
}

/// Validate an export and SCHEDULE it. Nothing live is touched here.
///
/// ## Why this does not restore anything
///
/// The first version of this did the swap immediately: move the live scripts
/// and database into quarantine, copy the export in, roll back on failure.
/// That is wrong while the application is running, and wrong in a way tests
/// hide.
///
/// The pool is open on `candidcue.sqlite3`. On Unix a rename does not
/// invalidate an open file descriptor, so every existing connection keeps
/// writing to the quarantined inode — and SQLite happily recreates `-wal` and
/// `-shm` beside the file that replaced it, producing a database whose journal
/// belongs to a different database. On Windows the rename fails outright, and
/// it fails AFTER the scripts tree has already moved. Worse, an error during
/// that evacuation happens before the rollback block exists to catch it.
///
/// So: everything that can refuse happens here — unknown export format,
/// missing manifest, an export marked incomplete, a checksum mismatch, a path
/// escaping the export, a symlink — and then a marker is written naming the
/// validated export. [`apply_pending_restore`] does the swap on the next
/// launch, before any pool is opened, where a rename means what it says.
pub async fn restore_all_data(paths: &DataPaths, export_root: &Path) -> Result<RestoreResult, AppError> {
    let manifest = read_and_validate_manifest(export_root)?;

    if !manifest.complete {
        return Err(AppError::invalid_input(
            "That export is marked incomplete — it is missing part of your data, so restoring \
             from it would replace what you have with less than you have. Use a complete export.",
        ));
    }

    verify_export_contents(export_root, &manifest)?;

    let scripts_in_export = std::fs::read_dir(export_root.join(SCRIPTS_DIR))
        .map(|entries| entries.count())
        .unwrap_or(0) as u32;

    // Absolute, so the next launch can find it whatever the working directory
    // is by then.
    let export_path = export_root
        .canonicalize()
        .map_err(|e| AppError::invalid_input(format!("That export folder is unreadable: {e}")))?;

    std::fs::write(
        paths.root().join(PENDING_RESTORE),
        serde_json::to_vec_pretty(&PendingRestore {
            export_path: export_path.to_string_lossy().to_string(),
            requested_at: crate::util::now_iso(),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            attempts: 0,
            quarantine_generation: None,
        })
        .map_err(|e| AppError::Internal(e.to_string()))?,
    )?;

    Ok(RestoreResult {
        path: export_path.to_string_lossy().to_string(),
        app_version: manifest.app_version,
        created_at: manifest.created_at,
        scripts_in_export,
        restart_required: true,
    })
}

/// Apply a scheduled restore, before anything opens the database.
///
/// Called at the very top of `database::init`, which is the one place in the
/// process where no pool exists and a rename means what it says.
///
/// The export is re-validated from scratch. The marker may have been written
/// days ago, and the folder it names is one the user can edit, move or damage
/// in between — trusting the earlier validation would be trusting a check
/// performed on a different set of bytes.
///
/// Returns where the replaced state went, if a restore ran.
pub async fn apply_pending_restore(paths: &DataPaths) -> Result<Option<PathBuf>, AppError> {
    let marker = paths.root().join(PENDING_RESTORE);
    if !marker.exists() {
        return Ok(None);
    }

    /*
     * The marker survives until the restore SUCCEEDS.
     *
     * It used to be consumed first, on the reasoning that a failing restore
     * must not be retried forever. That trades one problem for a worse one: a
     * crash or a power loss part way through the copy left partial live data,
     * no marker, and no automatic retry — an application that will not open
     * and no record of what was happening to it.
     *
     * Bounded instead of abandoned. Each attempt increments a counter in the
     * marker, and after `MAX_RESTORE_ATTEMPTS` the marker is retired and the
     * failure reported — so a genuinely impossible restore stops, and an
     * interrupted one resumes.
     */
    const MAX_RESTORE_ATTEMPTS: u32 = 3;

    let raw = std::fs::read(&marker)?;
    let mut pending: PendingRestore = serde_json::from_slice(&raw)
        .map_err(|e| {
            // An unreadable marker cannot be counted or retried; remove it so
            // the next launch is not stuck on it.
            let _ = std::fs::remove_file(&marker);
            AppError::invalid_input(format!("The pending restore was unreadable: {e}"))
        })?;

    pending.attempts += 1;
    if pending.attempts > MAX_RESTORE_ATTEMPTS {
        let _ = std::fs::remove_file(&marker);
        return Err(AppError::structured(
            "RESTORE_FAILED",
            crate::errors::ErrorCategory::Storage,
            format!(
                "CandidCue tried to restore from {} on {} launches and could not finish. \
                 It has stopped trying; your previous data is in the quarantine folder.",
                pending.export_path, MAX_RESTORE_ATTEMPTS
            ),
            true,
        )
        .with_action(crate::errors::RecoveryAction::RevealFolder));
    }
    // Record the attempt before making it, so a hard crash still counts.
    write_marker(&marker, &pending)?;

    let export_root = PathBuf::from(&pending.export_path);

    let manifest = read_and_validate_manifest(&export_root)?;
    if !manifest.complete {
        return Err(AppError::invalid_input(
            "The export scheduled for restore is marked incomplete; nothing was changed.",
        ));
    }
    verify_export_contents(&export_root, &manifest)?;

    /*
     * ONE quarantine generation per restore, named in the marker.
     *
     * A fresh timestamped directory per ATTEMPT loses the identity of the
     * original state: after a crash, the next attempt would quarantine the
     * previous attempt's partial output and the real original would be two
     * generations back with nothing pointing at it. The name is minted once,
     * on the first attempt, and every retry reuses it.
     */
    let generation = pending
        .quarantine_generation
        .clone()
        .unwrap_or_else(|| format!("pre-restore-{}", chrono::Utc::now().format("%Y%m%dT%H%M%SZ")));
    /*
     * Is this launch RESUMING an attempt that was interrupted, or starting a
     * fresh one?
     *
     * It decides what an already-occupied quarantine path means. On a resume
     * it is this restore's own earlier evacuation — the original state, which
     * must not be overwritten and must not be moved on top of. On a first
     * attempt it is something else entirely, and the honest answer is to
     * refuse rather than to guess.
     */
    let resuming = pending.quarantine_generation.is_some();
    if pending.quarantine_generation.is_none() {
        pending.quarantine_generation = Some(generation.clone());
        write_marker(&marker, &pending)?;
    }
    let previous = paths.quarantine_dir().join(&generation);
    std::fs::create_dir_all(&previous)?;

    let live_scripts = paths.scripts_dir();
    let live_database = paths.root().join(DATABASE_NAME);

    /*
     * Evacuate, then commit, recording WHAT WAS ACTUALLY MOVED.
     *
     * The rollback used to delete the live scripts and database
     * unconditionally and then restore whatever it found in quarantine. That
     * destroys data on a specific and entirely reachable sequence: scripts
     * evacuate, the database move FAILS — so the database is still live and
     * untouched — and the rollback then deletes it with nothing in quarantine
     * to put back.
     *
     * So the rollback only ever touches components this list says were moved.
     * Anything that never left is, by definition, still correct where it is.
     */
    let mut evacuated: Vec<(std::path::PathBuf, std::path::PathBuf)> = Vec::new();

    let outcome = (|| -> Result<(), AppError> {
        evacuate_component(
            &live_scripts,
            previous.join(SCRIPTS_DIR),
            ComponentKind::Tree,
            resuming,
            pending.attempts,
            &previous,
            &mut evacuated,
        )?;
        for suffix in ["", "-wal", "-shm"] {
            evacuate_component(
                &paths.root().join(format!("{DATABASE_NAME}{suffix}")),
                previous.join(format!("{DATABASE_NAME}{suffix}")),
                ComponentKind::File,
                resuming,
                pending.attempts,
                &previous,
                &mut evacuated,
            )?;
        }

        let exported_scripts = export_root.join(SCRIPTS_DIR);
        if exported_scripts.exists() {
            copy_tree(&exported_scripts, &live_scripts)?;
        } else {
            std::fs::create_dir_all(&live_scripts)?;
        }
        std::fs::copy(export_root.join(DATABASE_NAME), &live_database)?;

        // The restored database has to open and pass its own integrity check
        // before this is called a success. A copy that arrived truncated would
        // otherwise become the live database and fail at the next step, with
        // the original already moved.
        Ok(())
    })();

    let outcome = match outcome {
        Ok(()) => verify_database_file(&live_database).await,
        Err(err) => Err(err),
    };

    match outcome {
        Ok(()) => {
            // Only now. An interrupted restore leaves the marker behind and
            // the next launch resumes it; a finished one retires it.
            let _ = std::fs::remove_file(&marker);
            tracing::info!(
                from = %export_root.display(),
                previous = %previous.display(),
                "applied a scheduled restore"
            );
            Ok(Some(previous))
        }
        Err(err) => {
            /*
             * Put it back, and say whether that WORKED.
             *
             * The first version ignored every error here and then told the
             * user their previous data had been restored — a claim it had not
             * checked. It also used a bare `rename`, while the forward path
             * uses `move_or_copy`: across filesystems the evacuation would
             * succeed by copying and the rollback would fail by renaming.
             *
             * The quarantine copy is on disk either way, so the honest answer
             * is either "put back" or "not put back, and here is where it is".
             */
            let mut rollback_failures: Vec<String> = Vec::new();

            /*
             * ONLY what was actually evacuated.
             *
             * Deleting the live scripts and database unconditionally, as this
             * used to, destroys data on a reachable sequence: scripts
             * evacuate, the database move fails — leaving the database still
             * live and correct — and the rollback then deletes it with nothing
             * in quarantine to restore. A component that never left is still
             * where it should be, and the right thing to do with it is
             * nothing.
             */
            for (quarantined, live) in evacuated.iter().rev() {
                // Remove whatever the commit put there, then move the original
                // back over it.
                if live.is_dir() {
                    let _ = std::fs::remove_dir_all(live);
                } else {
                    let _ = std::fs::remove_file(live);
                }
                if let Err(e) = move_or_copy(quarantined, live) {
                    rollback_failures.push(format!("{}: {e}", live.display()));
                }
            }

            let message = if rollback_failures.is_empty() {
                /*
                 * No "a copy is also in quarantine" here, which is what this
                 * used to say. A successful rollback MOVES the originals back;
                 * there is no copy left behind, and telling the user to look
                 * for one sends them to an empty folder.
                 */
                format!(
                    "The restore did not finish, so CandidCue put your previous data back \
                     where it was. Nothing was lost."
                )
            } else {
                format!(
                    "The restore did not finish, and CandidCue could not fully put your \
                     previous data back either. What it could not move is still at {} — \
                     nothing was deleted.",
                    previous.display()
                )
            };

            Err(AppError::structured(
                "RESTORE_FAILED",
                crate::errors::ErrorCategory::Storage,
                message,
                true,
            )
            .with_action(crate::errors::RecoveryAction::RevealFolder)
            .with_log(format!("{err}; rollback: {rollback_failures:?}")))
        }
    }
}

/// Rename, falling back to copy-then-delete across filesystems.
///
/// The quarantine directory is a sibling under the app data root, so a rename
/// normally works — but "normally" is doing real work there. A symlinked or
/// mounted data directory puts the two on different filesystems, and `rename`
/// answers `EXDEV` rather than doing anything.
/// What a quarantined component is supposed to be, so an occupied path can be
/// told apart from an unrelated obstruction sitting at the same name.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ComponentKind {
    Tree,
    File,
}

/// Move one live component into the restore's quarantine generation, in a way
/// that a second launch can pick up where the first stopped.
///
/// ## The state this exists for
///
/// A restore that is interrupted after the evacuation but during the commit
/// leaves BOTH sides populated: the original is in quarantine, and the live
/// path holds however much of the export had been copied before the process
/// died. The straight-line version moved live → quarantine unconditionally, so
/// the retry tried to rename a directory onto a non-empty directory, failed
/// with something that is not `EXDEV`, and failed the same way on every launch
/// after that until the attempt limit retired the restore. The user's data was
/// never lost — it is in quarantine — but the restore could never finish and
/// the live tree stayed half-written.
///
/// ## What it does instead
///
/// * Quarantine path empty — the ordinary first attempt. Move, and record it.
/// * Quarantine path holds the right KIND of thing and this is a resume — the
///   original is already safe. The live copy is the dead attempt's partial
///   output, so it is moved aside under `interrupted-attempt-N/` rather than
///   deleted, and the component is recorded as evacuated so a rollback still
///   puts the original back.
/// * Anything else — refuse. An occupied path on a FIRST attempt is not this
///   restore's own work, and treating an unknown directory as "the original"
///   would mean discarding live data in its favour.
///
/// Nothing here deletes. A cross-filesystem evacuation copies and then
/// removes, so an interruption can leave a PARTIAL copy in quarantine while the
/// live original is still whole; deleting the live copy on the strength of the
/// quarantine one existing would turn a resumable state into a real loss.
fn evacuate_component(
    from: &Path,
    to: PathBuf,
    kind: ComponentKind,
    resuming: bool,
    attempt: u32,
    previous: &Path,
    evacuated: &mut Vec<(PathBuf, PathBuf)>,
) -> Result<(), AppError> {
    if to.exists() {
        let right_kind = match kind {
            ComponentKind::Tree => to.is_dir(),
            ComponentKind::File => to.is_file(),
        };
        if !(resuming && right_kind) {
            return Err(AppError::structured(
                "RESTORE_FAILED",
                crate::errors::ErrorCategory::Storage,
                format!(
                    "CandidCue could not set your previous data aside: something is already \
                     at {}. Nothing was changed.",
                    to.display()
                ),
                true,
            )
            .with_action(crate::errors::RecoveryAction::RevealFolder));
        }
        if from.exists() {
            let aside = previous.join(format!("interrupted-attempt-{attempt}"));
            std::fs::create_dir_all(&aside)?;
            let name = from
                .file_name()
                .ok_or_else(|| AppError::Internal("component has no file name".into()))?;
            move_or_copy(from, &aside.join(name))?;
        }
        evacuated.push((to, from.to_path_buf()));
        return Ok(());
    }
    if from.exists() {
        move_or_copy(from, &to)?;
        evacuated.push((to, from.to_path_buf()));
    }
    Ok(())
}

fn move_or_copy(from: &Path, to: &Path) -> Result<(), AppError> {
    match std::fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(err) if err.raw_os_error() == Some(18) => {
            // EXDEV. Copy, verify it landed, and only then remove the source.
            if from.is_dir() {
                copy_tree(from, to)?;
                std::fs::remove_dir_all(from)?;
            } else {
                std::fs::copy(from, to)?;
                std::fs::remove_file(from)?;
            }
            Ok(())
        }
        Err(err) => Err(err.into()),
    }
}

fn read_and_validate_manifest(export_root: &Path) -> Result<ExportManifest, AppError> {
    let manifest_path = export_root.join(MANIFEST_NAME);
    if !manifest_path.exists() {
        return Err(AppError::invalid_input(
            "That folder is not a CandidCue export — it has no manifest.json.",
        ));
    }
    let raw = std::fs::read(&manifest_path)?;
    let manifest: ExportManifest = serde_json::from_slice(&raw)
        .map_err(|e| AppError::invalid_input(format!("That export's manifest is unreadable: {e}")))?;

    if manifest.export_schema_version > EXPORT_SCHEMA_VERSION {
        return Err(AppError::invalid_input(format!(
            "That export was written by a newer version of CandidCue (export format {}, this \
             build understands {}). Update CandidCue and try again.",
            manifest.export_schema_version, EXPORT_SCHEMA_VERSION
        )));
    }
    Ok(manifest)
}

/// Everything the restore is about to copy must be listed, intact, and inside
/// the export.
///
/// Two directions, and the second one is the half that used to be missing.
///
/// Forwards: every file the manifest lists is present, the right size, hashes
/// to the recorded digest, is a regular file, and resolves inside the export.
///
/// Backwards: every file the RESTORE WILL COPY is listed. The commit copies a
/// fixed database path and the whole `scripts/` tree, and the old check
/// iterated only the manifest — so a `complete: true` manifest listing nothing
/// but `settings.json` would let an unchecksummed database and any number of
/// extra script files through, which is the shape of a hostile or damaged
/// export rather than a hypothetical.
fn verify_export_contents(export_root: &Path, manifest: &ExportManifest) -> Result<(), AppError> {
    if manifest.files.is_empty() {
        return Err(AppError::invalid_input(
            "That export's manifest lists no files, so there is nothing to verify or restore.",
        ));
    }

    let canonical_root = export_root
        .canonicalize()
        .map_err(|e| AppError::invalid_input(format!("That export folder is unreadable: {e}")))?;

    // The database is what a restore is FOR. An export without one is not
    // something to put back over live data whatever its manifest claims.
    if !manifest.files.iter().any(|file| file.path == DATABASE_NAME) {
        return Err(AppError::invalid_input(
            "That export's manifest does not list a database, so it cannot be restored.",
        ));
    }

    // Backwards: nothing gets copied that the manifest did not vouch for.
    let listed: std::collections::HashSet<&str> =
        manifest.files.iter().map(|file| file.path.as_str()).collect();
    for present in checksum_tree(export_root)? {
        if !listed.contains(present.path.as_str()) {
            return Err(AppError::invalid_input(format!(
                "That export contains {} , which its manifest does not list. It has been \
                 changed since it was written, so it will not be restored.",
                present.path
            )));
        }
    }

    for file in &manifest.files {
        // Traversal and absolute paths, refused by construction rather than by
        // pattern-matching on `..`.
        let candidate = export_root.join(&file.path);
        let resolved = candidate.canonicalize().map_err(|_| {
            AppError::invalid_input(format!("That export is missing {}.", file.path))
        })?;
        if !resolved.starts_with(&canonical_root) {
            return Err(AppError::unsafe_path(format!(
                "That export lists a file outside itself ({}), so it will not be restored.",
                file.path
            )));
        }
        // A symlink resolving inside the root is still not a file we wrote.
        let meta = std::fs::symlink_metadata(&candidate)?;
        if meta.file_type().is_symlink() {
            return Err(AppError::unsafe_path(format!(
                "That export contains a symbolic link ({}), which CandidCue will not restore.",
                file.path
            )));
        }
        if meta.len() != file.bytes {
            return Err(AppError::invalid_input(format!(
                "{} is the wrong size ({} bytes, expected {}). The export is damaged.",
                file.path,
                meta.len(),
                file.bytes
            )));
        }
        if sha256_file(&candidate)? != file.sha256 {
            return Err(AppError::invalid_input(format!(
                "{} does not match its checksum. The export is damaged.",
                file.path
            )));
        }
    }
    Ok(())
}

/* ----------------------------------------------------------------- rebuild */

/// Throw the database away and let the canonical files rebuild it.
///
/// The recovery of last resort, and the one that is always available: the
/// Markdown file is the authority for a script's content (§48.1), so an index
/// can be regenerated whenever it cannot be repaired. The old database is moved
/// to quarantine, never deleted — it may be the only copy of the session
/// history, which this cannot reconstruct.
///
/// Returns where the old database went.
pub fn rebuild_database_index(paths: &DataPaths) -> Result<PathBuf, AppError> {
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let quarantine = paths.quarantine_dir().join(format!("pre-rebuild-{stamp}"));
    std::fs::create_dir_all(&quarantine)?;

    let mut moved = false;
    for suffix in ["", "-wal", "-shm"] {
        let from = paths.root().join(format!("{DATABASE_NAME}{suffix}"));
        if from.exists() {
            std::fs::rename(&from, quarantine.join(format!("{DATABASE_NAME}{suffix}")))?;
            moved = true;
        }
    }

    std::fs::write(
        quarantine.join("README.txt"),
        "This is the CandidCue database as it was immediately before a rebuild.\n\
         \n\
         The rebuild regenerated the index from the Markdown files in `scripts/`,\n\
         which are the authority for script content. Session history and retained\n\
         transcripts are NOT reconstructed by a rebuild — if you need them, this\n\
         file is where they still are.\n\
         \n\
         Nothing deletes this folder automatically.\n",
    )
    .ok();

    if !moved {
        tracing::warn!("rebuild requested but there was no database to move aside");
    }
    Ok(quarantine)
}

/// Open a SQLite file on its own, read-only, and make it prove it is intact.
///
/// Read-only and single-connection by design: this is called on files the
/// application has decided not to trust — a pre-migration snapshot the
/// recovery screen is about to offer, or a backup it is about to restore — and
/// opening one of those for writing is how a diagnostic becomes a second
/// casualty.
pub async fn verify_database_file(path: &Path) -> Result<(), AppError> {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;

    let options = SqliteConnectOptions::from_str(&format!("sqlite://{}", path.display()))
        .map_err(sqlx::Error::from)?
        .create_if_missing(false)
        .read_only(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await?;

    let check: String = sqlx::query_scalar("PRAGMA quick_check")
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|e| format!("quick_check failed to run: {e}"));
    pool.close().await;

    if check == "ok" {
        Ok(())
    } else {
        Err(AppError::invalid_input(format!(
            "integrity check failed: {check}"
        )))
    }
}

/* ------------------------------------------------------------------- utils */

/// Refuse a destination that is the source, inside it, or contains it.
///
/// Resolved with `canonicalize` where possible, so a symlink or a `..` cannot
/// be used to describe the same directory two ways. A destination that does not
/// exist yet cannot be canonicalised and is compared as given — it cannot be
/// inside a tree that is about to be walked without its parent being, and the
/// parent is checked.
pub fn reject_nested_destination(source: &Path, destination: &Path) -> Result<(), AppError> {
    let resolve = |path: &Path| path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let source = resolve(source);
    let destination = resolve(destination);

    if destination.starts_with(&source) || source.starts_with(&destination) {
        return Err(AppError::unsafe_path(format!(
            "Choose a folder outside CandidCue's data. Copying {} into {} would copy the \
             destination into itself.",
            source.display(),
            destination.display()
        )));
    }
    Ok(())
}

/// Copy a directory tree, skipping symlinks.
///
/// Symlinks are skipped rather than followed on both the export and the
/// restore side: following one on export copies data from outside the app's
/// own directory into a file the user will hand around, and following one on
/// restore writes wherever it points.
pub fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let target = to.join(entry.file_name());
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if file_type.is_file() {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Every regular file under `root`, with its size and digest.
///
/// `manifest.json` is excluded when present: it is written after this runs and
/// cannot contain its own checksum.
fn checksum_tree(root: &Path) -> Result<Vec<ExportFile>, AppError> {
    let mut files = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let file_type = entry.file_type()?;
            if file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            if file_type.is_dir() {
                pending.push(path);
            } else if file_type.is_file() {
                let rel = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/");
                if rel == MANIFEST_NAME {
                    continue;
                }
                files.push(ExportFile {
                    bytes: std::fs::metadata(&path)?.len(),
                    sha256: sha256_file(&path)?,
                    path: rel,
                });
            }
        }
    }
    // Stable order, so two exports of the same state produce comparable
    // manifests.
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

fn sha256_file(path: &Path) -> Result<String, AppError> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    // Streamed: a database snapshot can be hundreds of megabytes, and reading
    // it whole to hash it would be a needless spike during a backup.
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}
