//! Script commands (spec §46.2). Invoke argument names are the camelCase
//! forms of the Rust parameters (Tauri convention), e.g. `expectedRevision`.

use tauri::{AppHandle, Runtime, State};

use crate::database::Database;
use crate::errors::AppError;
use crate::scripts::import_export::{
    export_format_extension, ExportOptions, ExportRequest, ExportResult, ImportOptions,
    ImportRequest, ImportResult,
};
use crate::scripts::{
    repo, CreateScriptInput, DataPaths, PageRequest, RevisionDocument, RevisionSummary,
    SaveResult, ScriptDocument, ScriptFilter, ScriptId, ScriptLocks, ScriptMetadataPatch,
    ScriptPage, ScriptSummary,
};

#[tauri::command]
pub async fn list_scripts(
    db: State<'_, Database>,
    filter: Option<ScriptFilter>,
    sort: Option<String>,
    page: Option<PageRequest>,
) -> Result<ScriptPage, AppError> {
    repo::list_scripts(
        db.pool(),
        filter.unwrap_or_default(),
        sort,
        page.unwrap_or_default(),
    )
    .await
}

#[tauri::command]
pub async fn create_script(
    boot: State<'_, crate::database::BootStatus>,
    db: State<'_, Database>,
    paths: State<'_, DataPaths>,
    input: CreateScriptInput,
) -> Result<ScriptSummary, AppError> {
    // Recovery mode owns no writable database (database::BootStatus).
    boot.require_ready()?;
    repo::create_script(db.pool(), &paths, input).await
}

#[tauri::command]
pub async fn get_script(
    boot: State<'_, crate::database::BootStatus>,
    db: State<'_, Database>,
    paths: State<'_, DataPaths>,
    locks: State<'_, ScriptLocks>,
    script_id: String,
) -> Result<ScriptDocument, AppError> {
    // Recovery mode owns no writable database (database::BootStatus).
    boot.require_ready()?;
    let script_id = ScriptId::parse(&script_id)?;
    let document = repo::get_script(db.pool(), &paths, &locks, &script_id).await?;
    /*
     * No `script://external-change` event.
     *
     * It was emitted here and NOTHING listened for it — the fact it carried is
     * already on the value this command returns, as `externally_changed`, and
     * the editor reads it from there. A second delivery channel for a fact the
     * response already holds is a race waiting to matter: the event can arrive
     * before the caller has processed the reply it belongs to.
     *
     * The 1.0 readiness review asked for exactly this: "remove redundant event
     * surfaces when the command response already carries the complete fact".
     */
    Ok(document)
}

#[tauri::command]
pub async fn save_script(
    boot: State<'_, crate::database::BootStatus>,
    db: State<'_, Database>,
    paths: State<'_, DataPaths>,
    locks: State<'_, ScriptLocks>,
    script_id: String,
    expected_revision: i64,
    source: String,
    metadata_patch: Option<ScriptMetadataPatch>,
) -> Result<SaveResult, AppError> {
    // Recovery mode owns no writable database (database::BootStatus).
    boot.require_ready()?;
    let script_id = ScriptId::parse(&script_id)?;
    repo::save_script(
        db.pool(),
        &paths,
        &locks,
        &script_id,
        expected_revision,
        source,
        metadata_patch.unwrap_or_default(),
    )
    .await
}

#[tauri::command]
pub async fn rename_script(
    boot: State<'_, crate::database::BootStatus>,
    db: State<'_, Database>,
    locks: State<'_, ScriptLocks>,
    script_id: String,
    title: String,
    expected_revision: i64,
) -> Result<ScriptSummary, AppError> {
    // Recovery mode owns no writable database (database::BootStatus).
    boot.require_ready()?;
    let script_id = ScriptId::parse(&script_id)?;
    repo::rename_script(db.pool(), &locks, &script_id, &title, expected_revision).await
}

#[tauri::command]
pub async fn duplicate_script(
    boot: State<'_, crate::database::BootStatus>,
    db: State<'_, Database>,
    paths: State<'_, DataPaths>,
    locks: State<'_, ScriptLocks>,
    script_id: String,
) -> Result<ScriptSummary, AppError> {
    // Recovery mode owns no writable database (database::BootStatus).
    boot.require_ready()?;
    let script_id = ScriptId::parse(&script_id)?;
    repo::duplicate_script(db.pool(), &paths, &locks, &script_id).await
}

#[tauri::command]
pub async fn trash_script(
    boot: State<'_, crate::database::BootStatus>,
    db: State<'_, Database>,
    locks: State<'_, ScriptLocks>,
    script_id: String,
    expected_revision: i64,
) -> Result<ScriptSummary, AppError> {
    // Recovery mode owns no writable database (database::BootStatus).
    boot.require_ready()?;
    let script_id = ScriptId::parse(&script_id)?;
    repo::trash_script(db.pool(), &locks, &script_id, expected_revision).await
}

#[tauri::command]
pub async fn restore_script(
    boot: State<'_, crate::database::BootStatus>,
    db: State<'_, Database>,
    locks: State<'_, ScriptLocks>,
    script_id: String,
    expected_revision: i64,
) -> Result<ScriptSummary, AppError> {
    // Recovery mode owns no writable database (database::BootStatus).
    boot.require_ready()?;
    let script_id = ScriptId::parse(&script_id)?;
    repo::restore_script(db.pool(), &locks, &script_id, expected_revision).await
}

#[tauri::command]
pub async fn permanently_delete_script(
    boot: State<'_, crate::database::BootStatus>,
    db: State<'_, Database>,
    paths: State<'_, DataPaths>,
    locks: State<'_, ScriptLocks>,
    script_id: String,
) -> Result<(), AppError> {
    // Recovery mode owns no writable database (database::BootStatus).
    boot.require_ready()?;
    let script_id = ScriptId::parse(&script_id)?;
    repo::permanently_delete_script(db.pool(), &paths, &locks, &script_id).await
}

#[tauri::command]
pub async fn list_revisions(
    db: State<'_, Database>,
    script_id: String,
) -> Result<Vec<RevisionSummary>, AppError> {
    let script_id = ScriptId::parse(&script_id)?;
    repo::list_revisions(db.pool(), &script_id).await
}

#[tauri::command]
pub async fn get_revision(
    db: State<'_, Database>,
    paths: State<'_, DataPaths>,
    script_id: String,
    revision_id: String,
) -> Result<RevisionDocument, AppError> {
    let script_id = ScriptId::parse(&script_id)?;
    repo::get_revision(db.pool(), &paths, &script_id, &revision_id).await
}

#[tauri::command]
pub async fn restore_revision(
    boot: State<'_, crate::database::BootStatus>,
    db: State<'_, Database>,
    paths: State<'_, DataPaths>,
    locks: State<'_, ScriptLocks>,
    script_id: String,
    revision_id: String,
    expected_revision: i64,
) -> Result<SaveResult, AppError> {
    // Recovery mode owns no writable database (database::BootStatus).
    boot.require_ready()?;
    let script_id = ScriptId::parse(&script_id)?;
    repo::restore_revision(
        db.pool(),
        &paths,
        &locks,
        &script_id,
        &revision_id,
        expected_revision,
    )
    .await
}

/// Import a script (spec §21.6, §50.7).
///
/// The picker runs HERE, in Rust, and its result goes straight into the
/// importer. There is deliberately no path argument: this command used to take
/// an absolute path from JavaScript with a comment asserting it came from the
/// dialog, which meant anything running in the control webview could read any
/// Markdown or text file on the machine and get it back out through
/// `get_script`. `Ok(None)` means the operator cancelled.
#[tauri::command]
pub async fn import_script<R: Runtime>(
    boot: State<'_, crate::database::BootStatus>,
    app: AppHandle<R>,
    db: State<'_, Database>,
    paths: State<'_, DataPaths>,
    locks: State<'_, ScriptLocks>,
    request: Option<ImportRequest>,
) -> Result<Option<ImportResult>, AppError> {
    // Recovery mode owns no writable database (database::BootStatus).
    boot.require_ready()?;
    let Some(path) = crate::dialogs::pick_script_to_import(&app).await? else {
        return Ok(None);
    };
    let options = ImportOptions {
        path: path.to_string_lossy().to_string(),
        title: request.and_then(|r| r.title),
    };
    crate::scripts::import_export::import_script(db.pool(), &paths, &locks, options)
        .await
        .map(Some)
}

/// Export a script (spec §21.6, §50.7).
///
/// Same shape as `import_script`: the save dialog runs in Rust and the chosen
/// destination never round-trips through JavaScript. The previous command took
/// an arbitrary absolute destination and `File::create`d it, truncating
/// whatever was there — naming `~/.ssh/config` destroyed that file.
/// `Ok(None)` means the operator cancelled.
#[tauri::command]
pub async fn export_script<R: Runtime>(
    boot: State<'_, crate::database::BootStatus>,
    app: AppHandle<R>,
    db: State<'_, Database>,
    paths: State<'_, DataPaths>,
    locks: State<'_, ScriptLocks>,
    script_id: String,
    request: ExportRequest,
) -> Result<Option<ExportResult>, AppError> {
    // Recovery mode owns no writable database (database::BootStatus).
    boot.require_ready()?;
    let script_id = ScriptId::parse(&script_id)?;
    // Validate the format before showing a dialog the operator cannot satisfy.
    let (extension, label) = export_format_extension(&request.format)?;
    let summary = repo::get_summary(db.pool(), &script_id).await?;
    let suggested = sanitize_file_stem(
        request
            .suggested_name
            .as_deref()
            .unwrap_or(summary.title.as_str()),
    );

    let Some(destination) = crate::dialogs::pick_export_destination(
        &app,
        &format!("{suggested}.{extension}"),
        label,
        extension,
    )
    .await?
    else {
        return Ok(None);
    };

    let options = ExportOptions {
        destination: destination.to_string_lossy().to_string(),
        format: request.format,
        include_assets: request.include_assets,
    };
    crate::scripts::import_export::export_script(db.pool(), &paths, &locks, &script_id, options)
        .await
        .map(Some)
}

/// A file-name stem that cannot introduce a path component. Only ever seeds the
/// save dialog's default name — the operator can change it, and the resulting
/// path is validated again by the exporter.
fn sanitize_file_stem(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '-'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        "script".to_string()
    } else {
        trimmed.chars().take(120).collect()
    }
}

#[tauri::command]
pub async fn reveal_script_folder(
    db: State<'_, Database>,
    paths: State<'_, DataPaths>,
    script_id: String,
) -> Result<(), AppError> {
    let script_id = ScriptId::parse(&script_id)?;
    let canonical = repo::canonical_path_checked(db.pool(), &paths, &script_id).await?;
    tauri_plugin_opener::reveal_item_in_dir(&canonical)
        .map_err(|e| AppError::Internal(format!("reveal failed: {e}")))
}
