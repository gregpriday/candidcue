//! Settings and diagnostics commands (spec §46.8).

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::database::Database;
use crate::errors::AppError;
use crate::scripts::DataPaths;
use crate::settings::{self, RevisionedSettings};

#[tauri::command]
pub async fn get_settings(db: State<'_, Database>) -> Result<RevisionedSettings, AppError> {
    settings::get_settings(db.pool()).await
}

/// The language and the recogniser are not patchable through here (§153).
///
/// Both are half of ONE choice, and this command cannot enforce what that
/// choice requires: it has no take guard, so it would accept a language change
/// mid-session, and it does not check that the model is actually on the
/// machine, so it would happily persist a language the next take cannot load.
/// `select_speech_language` does both and writes the pair atomically.
///
/// Refused rather than quietly ignored. A patch that silently dropped these
/// keys would leave a caller believing it had changed the language, which is
/// the same class of lie — a screen disagreeing with the session — that the
/// dedicated command exists to prevent.
const SPEECH_SELECTION_KEYS: [&str; 2] = ["language", "transcriptionModel"];

#[tauri::command]
pub async fn update_settings(
    db: State<'_, Database>,
    expected_revision: i64,
    patch: serde_json::Value,
) -> Result<RevisionedSettings, AppError> {
    if let Some(audio) = patch.get("audio").and_then(serde_json::Value::as_object) {
        if let Some(key) = SPEECH_SELECTION_KEYS
            .iter()
            .find(|key| audio.contains_key(**key))
        {
            return Err(AppError::invalid_input(
                "The speech language is changed through its own screen, not a settings patch.",
            )
            .with_detail("field", format!("audio.{key}")));
        }
    }
    settings::update_settings(db.pool(), expected_revision, patch).await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataExportResult {
    pub path: String,
    pub scripts_copied: u32,
    pub warnings: Vec<String>,
}

/// Export all data (spec §47.7): scripts tree copy + consistent SQLite
/// snapshot via `VACUUM INTO`.
///
/// C5: this used to take `destination: String` from the webview. Nothing could
/// supply it — the dialog plugin is not granted to JavaScript — so
/// `exportAllData()` invoked with `{ destination: undefined }`, the key was
/// dropped from the JSON, deserialization failed, and the un-`catch`ed promise
/// meant the operator saw no export, no toast and no error. The picker now
/// runs here, in the same trusted operation as the copy (spec §50.7).
/// `Ok(None)` means the operator cancelled.
#[tauri::command]
pub async fn export_all_data<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    db: State<'_, Database>,
    paths: State<'_, DataPaths>,
) -> Result<Option<DataExportResult>, AppError> {
    let Some(dest_root) =
        crate::dialogs::pick_destination_folder(&app, "Choose a folder for the export").await?
    else {
        return Ok(None);
    };
    if !dest_root.is_absolute() || !dest_root.exists() || !dest_root.is_dir() {
        return Err(AppError::unsafe_path(
            "Choose an existing folder for the export.",
        ));
    }
    let export_dir = dest_root.join(format!(
        "CandidCue-export-{}",
        chrono::Utc::now().format("%Y%m%d-%H%M%S")
    ));
    fs::create_dir_all(&export_dir)?;

    let mut warnings = Vec::new();

    // Consistent database snapshot.
    let db_copy = export_dir.join("candidcue.sqlite3");
    if let Err(err) = sqlx::query(&format!(
        "VACUUM INTO '{}'",
        db_copy.display().to_string().replace('\'', "''")
    ))
    .execute(db.pool())
    .await
    {
        warnings.push(format!("Database snapshot failed: {err}"));
    }

    // Scripts tree (canonical Markdown, revisions, assets).
    let mut scripts_copied = 0u32;
    let scripts_dir = paths.scripts_dir();
    if scripts_dir.exists() {
        let target = export_dir.join("scripts");
        copy_tree(&scripts_dir, &target)?;
        scripts_copied = fs::read_dir(&target)?.count() as u32;
    }

    Ok(Some(DataExportResult {
        path: export_dir.to_string_lossy().to_string(),
        scripts_copied,
        warnings,
    }))
}

fn copy_tree(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let target = to.join(entry.file_name());
        if file_type.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), &target)?;
        }
        // Symlinks are intentionally skipped.
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearResult {
    pub kind: String,
    pub removed_files: u32,
    /// Bytes actually reclaimed. The UI reports a size; it used to report
    /// `removedFiles` under the name `clearedBytes` (C6).
    pub removed_bytes: u64,
}

/// Total size of a file, or of everything under a directory. Best-effort:
/// anything unreadable simply counts as zero.
fn size_of(path: &std::path::Path) -> u64 {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return 0;
    };
    if meta.file_type().is_symlink() {
        return 0; // never follow, never count the target
    }
    if meta.is_file() {
        return meta.len();
    }
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    entries
        .filter_map(|e| e.ok())
        .map(|e| size_of(&e.path()))
        .sum()
}

/// The directories a `clear_cache` kind empties.
///
/// C6: the control window's "Clear logs" mapped onto `all`, which deletes the
/// compiled-script, vocabulary, thumbnail and download caches and leaves every
/// log file in place — then reported "Logs cleared." No arm touched
/// `paths.logs_dir()` at all. `logs` is its own kind now, and it is
/// deliberately NOT part of `all`: logs are not a cache.
pub fn clear_cache_targets(paths: &DataPaths, kind: &str) -> Result<Vec<PathBuf>, AppError> {
    let cache_root = paths.cache_dir();
    let cache = |sub: &str| cache_root.join(sub);
    Ok(match kind {
        "compiled" => vec![cache("compiled")],
        "vocabulary" => vec![cache("vocabulary")],
        "thumbnails" => vec![cache("thumbnails")],
        "all" => vec![
            cache("compiled"),
            cache("vocabulary"),
            cache("thumbnails"),
        ],
        "logs" => vec![paths.logs_dir()],
        other => {
            return Err(AppError::invalid_input(format!(
                "Unknown cache kind: {other}."
            )));
        }
    })
}

/// Empty a cache directory — or, for `logs`, the log directory, which is not a
/// cache and does not live under `cache/`.
#[tauri::command]
pub async fn clear_cache(
    paths: State<'_, DataPaths>,
    kind: String,
) -> Result<ClearResult, AppError> {
    let dirs = clear_cache_targets(&paths, &kind)?;

    /*
     * Logs cannot go through the generic loop below.
     *
     * That loop unlinks every entry it finds, and one of the entries is the
     * daily file the tracing appender is holding open. Unlinking it does not
     * close the descriptor — the appender goes on writing into an inode with
     * no name, and every line after the clear is invisible until the next
     * rotation quietly opens a new file. `clear_logs` truncates that file in
     * place instead, so logging survives its own log being cleared.
     *
     * Driven off `dirs` rather than off `paths.logs_dir()` so that
     * `clear_cache_targets` stays the single answer to "what does this kind
     * empty" — re-deriving the path here would let the two disagree silently.
     */
    if kind == "logs" {
        let mut stats = crate::diagnostics::logging::LogClearStats::default();
        for dir in &dirs {
            let cleared = crate::diagnostics::logging::clear_logs(dir)?;
            stats.removed_files += cleared.removed_files;
            stats.removed_bytes += cleared.removed_bytes;
        }
        return Ok(ClearResult {
            kind,
            removed_files: stats.removed_files,
            removed_bytes: stats.removed_bytes,
        });
    }

    let mut removed = 0u32;
    let mut removed_bytes = 0u64;
    for dir in dirs {
        if dir.exists() {
            for entry in fs::read_dir(&dir)?.filter_map(|e| e.ok()) {
                let path = entry.path();
                let bytes = size_of(&path);
                let ok = if path.is_dir() {
                    fs::remove_dir_all(&path).is_ok()
                } else {
                    fs::remove_file(&path).is_ok()
                };
                if ok {
                    removed += 1;
                    removed_bytes += bytes;
                }
            }
        }
    }
    Ok(ClearResult {
        kind,
        removed_files: removed,
        removed_bytes,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemDiagnostics {
    pub app_version: String,
    pub os: String,
    pub arch: String,
    pub database_integrity_ok: bool,
    pub script_count: i64,
    pub session_count: i64,
    pub data_dir: String,
}

#[tauri::command]
pub async fn get_system_diagnostics<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    db: State<'_, Database>,
    paths: State<'_, DataPaths>,
) -> Result<SystemDiagnostics, AppError> {
    let integrity: String = sqlx::query_scalar("PRAGMA quick_check")
        .fetch_one(db.pool())
        .await
        .unwrap_or_else(|_| "failed".into());
    let script_count: i64 = sqlx::query_scalar("SELECT count(*) FROM scripts")
        .fetch_one(db.pool())
        .await?;
    let session_count: i64 = sqlx::query_scalar("SELECT count(*) FROM sessions")
        .fetch_one(db.pool())
        .await?;
    Ok(SystemDiagnostics {
        app_version: app.package_info().version.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        database_integrity_ok: integrity == "ok",
        script_count,
        session_count,
        data_dir: paths.root().to_string_lossy().to_string(),
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportBundleResult {
    pub path: String,
}

/// Support bundle (spec §44.11): system facts, recovery reports, and the logs
/// (§179). No audio, script, or transcript content — the logs carry step names,
/// states and timings, which is a property of what the call sites write rather
/// than something enforced here.
///
/// `SUPPORT_BUNDLE_CONTENTS` in `src/control/lib/diagnostics-format.ts` states
/// this list to the operator before they send it to anyone. Anything added to
/// the bundle has to be added there too.
///
/// Same C5 shape as `export_all_data`: this used to take `destination: String`
/// from the webview, which had no way to obtain one — the dialog plugin is
/// deliberately not granted to JavaScript — so any caller would have sent
/// `undefined`, the key would have been dropped from the JSON, and the command
/// would have failed to deserialize before running a line. The picker runs
/// here, in the same trusted operation as the write (spec §50.7).
/// `Ok(None)` means the operator cancelled.
#[tauri::command]
pub async fn export_support_bundle<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    db: State<'_, Database>,
    paths: State<'_, DataPaths>,
) -> Result<Option<SupportBundleResult>, AppError> {
    let Some(dest_root) =
        crate::dialogs::pick_destination_folder(&app, "Choose a folder for the support bundle")
            .await?
    else {
        return Ok(None);
    };
    if !dest_root.is_absolute() || !dest_root.exists() || !dest_root.is_dir() {
        return Err(AppError::unsafe_path(
            "Choose an existing folder for the support bundle.",
        ));
    }
    let bundle_dir = dest_root.join(format!(
        "CandidCue-support-{}",
        chrono::Utc::now().format("%Y%m%d-%H%M%S")
    ));
    fs::create_dir_all(&bundle_dir)?;

    let diagnostics = get_system_diagnostics(app, db, paths.clone()).await?;
    write_support_bundle(&paths, &bundle_dir, &diagnostics)?;

    Ok(Some(SupportBundleResult {
        path: bundle_dir.to_string_lossy().to_string(),
    }))
}

/// Everything a support bundle contains, given a destination.
///
/// Split from the command so it can be tested. The command itself cannot be:
/// it opens a NATIVE FOLDER PICKER, so there is no deterministic way to drive
/// it from a test, and that is exactly why the logs could be dropped from the
/// bundle without a single test noticing.
pub fn write_support_bundle(
    paths: &DataPaths,
    bundle_dir: &Path,
    diagnostics: &SystemDiagnostics,
) -> Result<(), AppError> {
    let json = serde_json::to_vec_pretty(diagnostics)
        .map_err(|e| AppError::Internal(format!("diagnostics serialize: {e}")))?;
    crate::util::atomic_write(&bundle_dir.join("diagnostics.json"), &json)?;

    // Include recovery reports (they contain ids and counts, not content).
    let reports_dir = paths.diagnostics_dir();
    if reports_dir.exists() {
        for entry in fs::read_dir(&reports_dir)?.filter_map(|e| e.ok()) {
            if entry.path().extension().map(|e| e == "json").unwrap_or(false) {
                let _ = fs::copy(entry.path(), bundle_dir.join(entry.file_name()));
            }
        }
    }

    // And the logs — which is the whole reason anyone exports one of these
    // (§179). The bundle used to ship system facts and recovery reports while
    // leaving out the only files that record what the app was actually doing
    // when it went wrong.
    crate::diagnostics::logging::copy_support_logs(&paths.logs_dir(), bundle_dir)?;
    Ok(())
}

/// Updater is not wired in v1 (spec §44.10 planned; plugin absent).
#[tauri::command]
pub async fn check_for_update() -> Result<serde_json::Value, AppError> {
    Err(AppError::not_implemented("Update checks"))
}

#[tauri::command]
pub async fn install_update() -> Result<(), AppError> {
    Err(AppError::not_implemented("Update installation"))
}

/// Frontend diagnostic line → the process log AND a file (spec §30.1 triage).
///
/// The realtime transport lives in the control WEBVIEW, and a `console.log`
/// there does not reach the terminal running `tauri dev` — so the one failure
/// that has resisted every other kind of investigation, a realtime connection
/// that will not open, has been invisible from the outside.
///
/// It writes to a FILE as well as to `tracing`, and that mattered more than it
/// should have: `tracing` used to reach stdout only, so a trace survived only if
/// whoever ran the app happened to pipe it somewhere — and the first attempt to
/// collect one was lost exactly that way. `tracing` now reaches a file too
/// (§179), but this one stays: it is per-launch and per-step, which is what
/// makes it readable as a sequence.
///
/// Deliberately blunt: it takes a string the frontend has already composed and
/// writes it. It is not a general logging API, and it carries no user content
/// by construction (callers pass step names, states and timings).
///
/// The line and the client-trace file are both bounded. The `tracing::warn!`
/// below is NOT — it lands in the daily Rust log, which caps file count rather
/// than bytes — so the bound on disk usage here is the caller: the audio trace
/// is off by default in a packaged build and emits a few dozen lines per take.
#[tauri::command]
pub async fn log_client_diagnostic(
    paths: State<'_, DataPaths>,
    scope: String,
    line: String,
) -> Result<(), AppError> {
    const MAX_LINE: usize = 2000;

    let scope: String = scope
        .chars()
        .filter(|c| c.is_ascii_graphic())
        .take(32)
        .collect();
    let line: String = line.chars().take(MAX_LINE).collect();
    tracing::warn!(target: "candidcue::client", scope = %scope, "{line}");

    // This command owns sanitising and formatting; the file — its size cap,
    // its serialising lock, and the startup rotation that has to interleave
    // safely with it — belongs to `diagnostics::logging`.
    let entry = format!("{} [{scope}] {line}\n", crate::util::now_iso());
    // Failing to write a diagnostic must never fail the caller: the whole
    // point is to observe a broken path, not to add a way to break it.
    let _ = crate::diagnostics::logging::append_client_trace(&paths.logs_dir(), &entry);
    Ok(())
}
