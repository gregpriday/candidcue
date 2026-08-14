//! Settings and diagnostics commands (spec §46.8).

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{Emitter, State};

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
pub async fn update_settings<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    boot: State<'_, crate::database::BootStatus>,
    db: State<'_, Database>,
    expected_revision: i64,
    patch: serde_json::Value,
) -> Result<RevisionedSettings, AppError> {
    // Recovery mode owns no writable database (database::BootStatus).
    boot.require_ready()?;
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
    let updated = settings::update_settings(db.pool(), expected_revision, patch).await?;

    /*
     * TELL EVERY WINDOW, because there is now more than one that cares.
     *
     * Settings moved into its own Preferences window (§14.1), and each webview
     * has its own copy of the settings store — they are separate JavaScript
     * contexts, so a write in one is invisible to the other. Without this the
     * two would silently diverge: change the stage font in Preferences and the
     * control window would go on composing takes from the value it read at
     * launch, until something else happened to reload it.
     *
     * A BROADCAST rather than a targeted emit, and it carries the whole
     * revisioned document rather than a "something changed" nudge. Carrying the
     * document means a listener adopts the new state without a second round
     * trip — and, more importantly, without a window between the two in which it
     * would answer questions from a copy it already knows is stale.
     *
     * The window that made the change receives it too and adopts an identical
     * value, which is a no-op rather than a loop: `revision` only moves when a
     * write actually lands.
     */
    broadcast_settings(&app, &updated);
    Ok(updated)
}

/// Tell every window that the settings document moved.
///
/// Extracted so it is reachable from the OTHER command that writes settings.
/// `select_speech_language` patches the document directly — it has validation
/// to do that `update_settings` cannot — and without this it committed a new
/// revision that no window heard about, leaving both of them holding a stale
/// `expected_revision` and turning the next ordinary save into a concurrency
/// conflict the user did nothing to cause.
///
/// Never fatal: the write has already committed by the time this runs, and a
/// window that missed the broadcast re-reads on its next natural load.
pub(crate) fn broadcast_settings<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    updated: &crate::settings::RevisionedSettings,
) {
    if let Err(err) = app.emit(crate::windows::events::SETTINGS_CHANGED, updated) {
        tracing::warn!(error = %err, "the settings change could not be broadcast");
    }
}

/// Export everything the user made (spec §47.7).
///
/// The work is in `crate::backup`, which writes to a staging directory,
/// checksums every file, and only then gives the export a name that says
/// whether it is whole. This command is the trust boundary: it runs the folder
/// picker in Rust, because the dialog plugin is deliberately not granted to
/// JavaScript (§50.7), and validates the destination before handing it on.
///
/// C5: this used to take `destination: String` from the webview. Nothing could
/// supply it, so `exportAllData()` invoked with `{ destination: undefined }`,
/// the key was dropped from the JSON, deserialization failed, and the
/// un-`catch`ed promise meant the operator saw no export, no toast and no
/// error. `Ok(None)` means the operator cancelled.
#[tauri::command]
pub async fn export_all_data<R: tauri::Runtime>(
    boot: State<'_, crate::database::BootStatus>,
    app: tauri::AppHandle<R>,
    db: State<'_, Database>,
    paths: State<'_, DataPaths>,
) -> Result<Option<crate::backup::DataExportResult>, AppError> {
    // Recovery mode owns no writable database (database::BootStatus).
    boot.require_ready()?;
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
    crate::backup::export_all_data(db.pool(), &paths, &dest_root)
        .await
        .map(Some)
}

/// Restore from an export written by [`export_all_data`].
///
/// Refuses before it changes anything: unknown export format, missing
/// manifest, an export marked incomplete, a checksum mismatch, a path pointing
/// outside the export, or a symlink. Only then does it move the current state
/// into quarantine — where it stays, whatever happens next — and commit.
///
/// The restored database is NOT adopted by the running process. The pool is
/// open on the file that was just replaced underneath it, and reconnecting a
/// live application to a different database mid-session is a far larger change
/// than this needs to be. The result says to restart, and the frontend says so.
#[tauri::command]
pub async fn restore_all_data<R: tauri::Runtime>(
    boot: State<'_, crate::database::BootStatus>,
    app: tauri::AppHandle<R>,
    paths: State<'_, DataPaths>,
) -> Result<Option<crate::backup::RestoreResult>, AppError> {
    // Recovery mode owns no writable database (database::BootStatus).
    boot.require_ready()?;
    let Some(export_root) = crate::dialogs::pick_destination_folder(
        &app,
        "Choose the CandidCue export folder to restore from",
    )
    .await?
    else {
        return Ok(None);
    };
    if !export_root.is_absolute() || !export_root.is_dir() {
        return Err(AppError::unsafe_path("Choose an existing export folder."));
    }
    crate::backup::restore_all_data(&paths, &export_root)
        .await
        .map(Some)
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
    boot: State<'_, crate::database::BootStatus>,
    paths: State<'_, DataPaths>,
    kind: String,
) -> Result<ClearResult, AppError> {
    // Recovery mode owns no writable database (database::BootStatus).
    boot.require_ready()?;
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

/// Where the last support bundle was written, for `reveal_support_bundle`.
///
/// The bundle is the one thing in this app a user is asked to inspect before
/// handing it to a stranger, and "reveal it" is how a Mac user inspects a
/// folder. The obvious implementation — pass the path back to the webview and
/// let it ask Rust to reveal that path — is the one thing this codebase does
/// not do (C5, spec §50.7): a reveal command taking a path from JavaScript is
/// an arbitrary-directory reveal, and the webview would only be handing back a
/// string Rust gave it a moment ago anyway.
///
/// So Rust keeps it. The webview asks to reveal "the bundle", not a path, and
/// the answer is a directory this process created inside a folder the operator
/// picked in a native dialog.
///
/// A `std::sync::Mutex` and not an async one: it is held for a pointer swap.
#[derive(Debug, Default)]
pub struct LastSupportBundle(std::sync::Mutex<Option<PathBuf>>);

impl LastSupportBundle {
    fn remember(&self, path: PathBuf) {
        *self.0.lock().expect("last support bundle poisoned") = Some(path);
    }

    /// The remembered directory, if it is still there.
    ///
    /// Checked rather than trusted: a user can move or delete the folder
    /// between exporting and pressing Reveal, and `reveal_item_in_dir` on a
    /// path that no longer exists opens the wrong thing or nothing at all.
    fn current(&self) -> Option<PathBuf> {
        let guard = self.0.lock().expect("last support bundle poisoned");
        guard.as_ref().filter(|path| path.is_dir()).cloned()
    }
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
    last_bundle: State<'_, LastSupportBundle>,
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
    last_bundle.remember(bundle_dir.clone());

    Ok(Some(SupportBundleResult {
        path: bundle_dir.to_string_lossy().to_string(),
    }))
}

/// Show the last support bundle in Finder, so it can be read before it is sent.
///
/// The user-facing copy (`SUPPORT_BUNDLE_EXCLUSIONS` in
/// `src/control/lib/diagnostics-format.ts`) says a bundle is *designed* to leave
/// scripts, transcripts and audio out, and that the redactor cannot recognise
/// prose — so the honest end of that sentence is "read it before you send it".
/// This is the action that makes reading it one click rather than a hunt
/// through a folder the operator picked several minutes ago.
///
/// It takes no argument. See [`LastSupportBundle`] for why that matters.
#[tauri::command]
pub async fn reveal_support_bundle(
    last_bundle: State<'_, LastSupportBundle>,
) -> Result<(), AppError> {
    let Some(path) = last_bundle.current() else {
        return Err(AppError::not_found(
            "There is no support bundle to show. Export one first.",
        ));
    };
    tauri_plugin_opener::reveal_item_in_dir(path)
        .map_err(|e| AppError::Internal(format!("reveal failed: {e}")))
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

/*
 * `check_for_update` and `install_update` used to sit here, both returning
 * NOT_IMPLEMENTED forever.
 *
 * CandidCue 1.0 updates manually (docs/updates.md). Two always-failing commands
 * on a registered ACL, beside an `update_check: "daily"` default that nothing
 * ever scheduled, described a product that checks for updates — and the gap
 * between that description and the code was one plugin registration wide. The
 * commands, the cadence field, the `UpdateCheckCadence` enum and the frontend
 * "Check for updates" button all went together, so there is now one story:
 * Settings shows the running version and says how to get a newer one.
 */

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
