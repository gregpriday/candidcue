//! The commands the recovery screen is allowed to use.
//!
//! Every one of these works on FILES. None of them opens the damaged database
//! for writing, and none of them needs the application to have started
//! successfully — which is the point, because the failures they exist for are
//! precisely the ones that stop it starting.
//!
//! The recovery screen is reachable now because `database::init` failing no
//! longer aborts Tauri's setup hook. See `database::BootStatus`.

use serde::Serialize;
use tauri::State;

use crate::backup;
use crate::database::BootStatus;
use crate::errors::AppError;
use crate::scripts::DataPaths;

/// What the frontend asks BEFORE it routes anywhere.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootStatusReport {
    /// `false` means the application must not open; only recovery may.
    pub database_ready: bool,
    /// The stable code, for the recovery copy to branch on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// What to tell the user. Already redacted for display by `AppError`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Where their data is, so the screen can offer to reveal it.
    pub data_directory: String,
}

/// Did Speaking Glass actually start?
///
/// Deliberately infallible and dependency-free: this is the one question that
/// must be answerable when everything else has failed.
#[tauri::command]
pub async fn get_boot_status(
    boot: State<'_, BootStatus>,
    paths: State<'_, DataPaths>,
) -> Result<BootStatusReport, AppError> {
    let (code, message) = match &*boot {
        BootStatus::Ready => (None, None),
        BootStatus::Failed(err) => (Some(err.code().to_string()), Some(err.user_message())),
    };
    Ok(BootStatusReport {
        database_ready: boot.is_ready(),
        code,
        message,
        data_directory: paths.root().to_string_lossy().to_string(),
    })
}

/// A pre-migration snapshot, with enough context to choose between several.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseBackup {
    /// File name only. The recovery screen never sees or sends a full path.
    pub name: String,
    pub bytes: u64,
    /// From the sidecar manifest written beside the snapshot; absent for
    /// backups taken before manifests existed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub taken_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema_version_before: Option<i64>,
    /// Whether the file passes `PRAGMA quick_check` right now. A backup is
    /// offered whatever the answer, but never silently.
    pub verified: bool,
}

/// Every pre-migration snapshot on disk, newest first, each one integrity
/// checked at the moment it is listed.
///
/// Checked at list time rather than at restore time on purpose: the user is
/// about to choose, and "this one is damaged" is information they need before
/// they pick, not after.
#[tauri::command]
pub async fn list_database_backups(
    paths: State<'_, DataPaths>,
) -> Result<Vec<DatabaseBackup>, AppError> {
    let dir = paths.root().join("backups");
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut found = Vec::new();
    for entry in std::fs::read_dir(&dir)?.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.extension().map(|e| e != "sqlite3").unwrap_or(true) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);

        let manifest: Option<serde_json::Value> = std::fs::read(path.with_extension("json"))
            .ok()
            .and_then(|raw| serde_json::from_slice(&raw).ok());

        found.push(DatabaseBackup {
            verified: backup::verify_database_file(&path).await.is_ok(),
            taken_at: manifest
                .as_ref()
                .and_then(|m| m["takenAt"].as_str().map(str::to_string)),
            app_version: manifest
                .as_ref()
                .and_then(|m| m["appVersion"].as_str().map(str::to_string)),
            schema_version_before: manifest
                .as_ref()
                .and_then(|m| m["schemaVersionBefore"].as_i64()),
            name,
            bytes,
        });
    }

    // Newest first. The names are timestamped, so a reverse lexical sort is a
    // reverse chronological one.
    found.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(found)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryOutcome {
    /// Where the state that was replaced now lives. Never deleted.
    pub previous_state_at: String,
    /// Recovery never reconnects the running process to a new database.
    pub restart_required: bool,
}

/// Put a verified pre-migration snapshot back as the live database.
///
/// `name` is a file name from [`list_database_backups`], never a path: the
/// recovery screen cannot name a file outside the backups directory, and this
/// asserts that rather than trusting it.
#[tauri::command]
pub async fn restore_database_backup(
    boot: State<'_, crate::database::BootStatus>,
    paths: State<'_, DataPaths>,
    name: String,
) -> Result<RecoveryOutcome, AppError> {
    // Destructive, and only correct when the database did NOT open.
    boot.require_recovery()?;
    // No separators, no traversal, no absolute paths. Checked on the raw
    // string, before it is joined to anything.
    if name.contains('/') || name.contains('\\') || name.contains("..") || name.is_empty() {
        return Err(AppError::unsafe_path("That is not a backup file name."));
    }

    let source = paths.root().join("backups").join(&name);
    if !source.is_file() {
        return Err(AppError::not_found("that backup"));
    }

    // Verify BEFORE the live database is moved. Restoring a corrupt snapshot
    // over a corrupt database leaves the user with two corrupt databases and
    // one fewer option.
    backup::verify_database_file(&source).await.map_err(|err| {
        AppError::invalid_input(format!(
            "That backup did not pass its integrity check, so it was not restored: {err}"
        ))
    })?;

    let quarantine = backup::rebuild_database_index(&paths).await?;

    /*
     * Staged, flushed, checked, then renamed into place.
     *
     * A direct `fs::copy` onto the live path is a partial database the moment
     * it is interrupted, and the previous one has already been moved aside — so
     * the next launch opens whatever landed. Copying to a sibling first means
     * the live name only ever refers to a file that is complete: the copy is
     * fsynced, verified with the same integrity check the backup itself had to
     * pass, and only then does the rename publish it.
     */
    let live = paths.root().join("speaking-glass.sqlite3");
    let staging = paths.root().join("speaking-glass.sqlite3.restoring");
    let _ = std::fs::remove_file(&staging);
    std::fs::copy(&source, &staging)?;
    crate::util::sync_file(&staging)?;
    if let Err(err) = backup::verify_database_file(&staging).await {
        let _ = std::fs::remove_file(&staging);
        return Err(AppError::invalid_input(format!(
            "The backup did not survive being copied into place, so nothing was published.              Your previous database is at {}: {err}",
            quarantine.display()
        )));
    }
    crate::util::rename(&staging, &live)?;
    crate::util::sync_dir(paths.root())?;

    Ok(RecoveryOutcome {
        previous_state_at: quarantine.to_string_lossy().to_string(),
        restart_required: true,
    })
}

/// Discard the index and rebuild it from the canonical Markdown files.
///
/// The recovery that is always available: the Markdown file is the authority
/// for a script's content (§48.1), and its saved versions and images are files
/// beside it. Names, Trash and per-script settings are read back out of the
/// old database where it can still be read, and the next launch applies them
/// (#252). Session and take history are not reconstructible this way, which is
/// why the old database is quarantined rather than deleted — and why the
/// result says where it went.
#[tauri::command]
pub async fn rebuild_database_index(
    boot: State<'_, crate::database::BootStatus>,
    paths: State<'_, DataPaths>,
) -> Result<RecoveryOutcome, AppError> {
    // Destructive, and only correct when the database did NOT open.
    boot.require_recovery()?;
    let quarantine = backup::rebuild_database_index(&paths).await?;
    Ok(RecoveryOutcome {
        previous_state_at: quarantine.to_string_lossy().to_string(),
        restart_required: true,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptRescueResult {
    pub path: String,
    pub scripts_copied: u32,
    /// The file in the copy that lists each folder's script by name, when it
    /// could be written.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub names_file: Option<String>,
}

/// Copy the canonical script files somewhere safe, WITHOUT the database.
///
/// The action a user actually wants first when the app will not start: get the
/// writing out. It reads the `scripts/` tree directly, so it works when the
/// database is unopenable — which the ordinary export does not, because that
/// begins with a `VACUUM INTO`.
#[tauri::command]
pub async fn rescue_scripts<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    paths: State<'_, DataPaths>,
) -> Result<Option<ScriptRescueResult>, AppError> {
    let Some(dest_root) =
        crate::dialogs::pick_destination_folder(&app, "Choose where to save your scripts").await?
    else {
        return Ok(None);
    };
    if !dest_root.is_absolute() || !dest_root.is_dir() {
        return Err(AppError::unsafe_path("Choose an existing folder."));
    }

    let target = dest_root.join(format!(
        "SpeakingGlass-scripts-{}",
        chrono::Utc::now().format("%Y%m%d-%H%M%S")
    ));
    let rescued = backup::rescue_scripts_to(&paths, &target).await?;

    Ok(Some(ScriptRescueResult {
        scripts_copied: rescued.scripts_copied,
        names_file: rescued.names_file,
        path: target.to_string_lossy().to_string(),
    }))
}

/// Write editor text that could not be saved somewhere it will survive.
///
/// The last line of defence in the shutdown sequence, and the one the whole
/// close/quit coordination exists for: **no successful close may lose edits the
/// editor acknowledged.**
///
/// `saveNow()` resolves normally when a save FAILS — a conflict, a read-only
/// file, a full disk — because the editor reports those through store state and
/// its own sheets. That is right while the app is open and wrong at the moment
/// it closes, because there is no longer a screen to report to. So the shutdown
/// step checks for unsaved work after the flush, and calls this when it finds
/// any.
///
/// Writes to `quarantine/`, never to the canonical file. The canonical file is
/// exactly what could not be written — in a conflict it holds someone else's
/// newer text — and overwriting it here would resolve a conflict by destroying
/// one side of it, silently, during a quit.
///
/// Nothing reads these back automatically. That is deliberate: an automatic
/// restore would have to choose between this text and the disk's, which is the
/// choice the conflict sheet exists to give the user.
#[tauri::command]
pub async fn write_unsaved_recovery(
    paths: State<'_, DataPaths>,
    script_id: String,
    source: String,
) -> Result<String, AppError> {
    // The id only ever names the file; parsing it means a malformed one cannot
    // reach the path at all.
    let script_id = crate::scripts::ScriptId::parse(&script_id)?;

    let dir = paths.quarantine_dir().join("unsaved");
    // Durably, ancestors included: `quarantine/` and `quarantine/unsaved` can
    // both be new here, and the file about to be written into them is the only
    // copy of text the user has been told was parked.
    crate::util::create_dir_all_durable(&dir)?;
    let target = dir.join(format!(
        "{}-{}.md",
        script_id.as_str(),
        chrono::Utc::now().format("%Y%m%dT%H%M%SZ")
    ));
    /*
     * `atomic_write`, not `fs::write`: this is the ONLY copy.
     *
     * The text is here because saving it failed, the window is closing, and the
     * user has been told it was parked. `fs::write` returns as soon as the
     * bytes reach the page cache, and the process is about to exit — so a power
     * loss, or a machine that goes down during the shutdown this runs in, left
     * an acknowledged rescue file empty or absent.
     */
    crate::util::atomic_write(&target, source.as_bytes())?;

    std::fs::write(
        dir.join("README.txt"),
        "Text Speaking Glass could not save before it closed.\n\
         \n\
         Each file here is the editor's copy of a script at the moment the app\n\
         was closed, written because saving it had failed — usually because the\n\
         file had also changed outside Speaking Glass, or the disk was full or\n\
         read-only.\n\
         \n\
         Speaking Glass does not read these back automatically: doing so would mean\n\
         choosing between this text and what is on disk, and that choice is\n\
         yours. Compare them and copy across whatever you want to keep.\n\
         \n\
         Nothing deletes this folder automatically.\n",
    )
    .ok();

    tracing::warn!(path = %target.display(), "wrote unsaved editor text to quarantine");
    Ok(target.to_string_lossy().to_string())
}

/// What startup reconciliation found, if anything, on THIS launch.
///
/// Read once and cleared. Reconciliation finishes inside Tauri's `setup` hook,
/// which is before the control webview has run any JavaScript, so the
/// `diagnostic://warning` it used to emit landed on a page with no listeners —
/// the code's own comment called the emit "best effort" and pointed at a
/// diagnostics file as the fallback, which is a file nobody opens. That emit is
/// gone; this is the delivery.
///
/// A repair that rewrote somebody's script index is worth telling them about,
/// so the findings wait here to be collected rather than being shouted into an
/// empty room.
#[tauri::command]
pub async fn get_startup_findings<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Option<serde_json::Value>, AppError> {
    use tauri::Manager;
    // Managed only when there WERE findings, so its absence is the ordinary
    // answer and not an error.
    let Some(findings) = app.try_state::<crate::scripts::reconcile::StartupFindings>() else {
        return Ok(None);
    };
    Ok(findings
        .take()
        .and_then(|report| serde_json::to_value(report).ok()))
}

/// Show the data folder in the file manager.
///
/// The last resort that always works, and the one a support conversation ends
/// up asking for.
#[tauri::command]
pub async fn reveal_data_folder<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    paths: State<'_, DataPaths>,
) -> Result<(), AppError> {
    let _ = app;
    tauri_plugin_opener::reveal_item_in_dir(paths.root())
        .map_err(|e| AppError::Internal(format!("reveal failed: {e}")))
}
