//! Script commands (spec §46.2). Invoke argument names are the camelCase
//! forms of the Rust parameters (Tauri convention), e.g. `expectedRevision`.

use tauri::{AppHandle, Emitter, State};

use crate::database::Database;
use crate::errors::AppError;
use crate::scripts::import_export::{ExportOptions, ExportResult, ImportOptions, ImportResult};
use crate::scripts::{
    repo, CreateScriptInput, DataPaths, PageRequest, RevisionDocument, RevisionSummary,
    SaveResult, ScriptDocument, ScriptFilter, ScriptLocks, ScriptMetadataPatch, ScriptPage,
    ScriptSummary,
};
use crate::windows::{events, CONTROL_LABEL};

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
    db: State<'_, Database>,
    paths: State<'_, DataPaths>,
    input: CreateScriptInput,
) -> Result<ScriptSummary, AppError> {
    repo::create_script(db.pool(), &paths, input).await
}

#[tauri::command]
pub async fn get_script(
    app: AppHandle,
    db: State<'_, Database>,
    paths: State<'_, DataPaths>,
    locks: State<'_, ScriptLocks>,
    script_id: String,
) -> Result<ScriptDocument, AppError> {
    let document = repo::get_script(db.pool(), &paths, &locks, &script_id).await?;
    if document.externally_changed {
        let _ = app.emit_to(
            CONTROL_LABEL,
            events::SCRIPT_EXTERNAL_CHANGE,
            serde_json::json!({
                "scriptId": script_id,
                "scriptRevision": document.script_revision,
                "sourceHash": document.source_hash,
            }),
        );
    }
    Ok(document)
}

#[tauri::command]
pub async fn save_script(
    db: State<'_, Database>,
    paths: State<'_, DataPaths>,
    locks: State<'_, ScriptLocks>,
    script_id: String,
    expected_revision: i64,
    source: String,
    metadata_patch: Option<ScriptMetadataPatch>,
) -> Result<SaveResult, AppError> {
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
    db: State<'_, Database>,
    script_id: String,
    title: String,
    expected_revision: i64,
) -> Result<ScriptSummary, AppError> {
    repo::rename_script(db.pool(), &script_id, &title, expected_revision).await
}

#[tauri::command]
pub async fn duplicate_script(
    db: State<'_, Database>,
    paths: State<'_, DataPaths>,
    locks: State<'_, ScriptLocks>,
    script_id: String,
) -> Result<ScriptSummary, AppError> {
    repo::duplicate_script(db.pool(), &paths, &locks, &script_id).await
}

#[tauri::command]
pub async fn trash_script(db: State<'_, Database>, script_id: String) -> Result<(), AppError> {
    repo::trash_script(db.pool(), &script_id).await
}

#[tauri::command]
pub async fn restore_script(
    db: State<'_, Database>,
    script_id: String,
) -> Result<ScriptSummary, AppError> {
    repo::restore_script(db.pool(), &script_id).await
}

#[tauri::command]
pub async fn permanently_delete_script(
    db: State<'_, Database>,
    paths: State<'_, DataPaths>,
    locks: State<'_, ScriptLocks>,
    script_id: String,
) -> Result<(), AppError> {
    repo::permanently_delete_script(db.pool(), &paths, &locks, &script_id).await
}

#[tauri::command]
pub async fn list_revisions(
    db: State<'_, Database>,
    script_id: String,
) -> Result<Vec<RevisionSummary>, AppError> {
    repo::list_revisions(db.pool(), &script_id).await
}

#[tauri::command]
pub async fn get_revision(
    db: State<'_, Database>,
    paths: State<'_, DataPaths>,
    script_id: String,
    revision_id: String,
) -> Result<RevisionDocument, AppError> {
    repo::get_revision(db.pool(), &paths, &script_id, &revision_id).await
}

#[tauri::command]
pub async fn restore_revision(
    db: State<'_, Database>,
    paths: State<'_, DataPaths>,
    locks: State<'_, ScriptLocks>,
    script_id: String,
    revision_id: String,
    expected_revision: i64,
) -> Result<SaveResult, AppError> {
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

#[tauri::command]
pub async fn import_script(
    db: State<'_, Database>,
    paths: State<'_, DataPaths>,
    locks: State<'_, ScriptLocks>,
    options: ImportOptions,
) -> Result<ImportResult, AppError> {
    crate::scripts::import_export::import_script(db.pool(), &paths, &locks, options).await
}

#[tauri::command]
pub async fn export_script(
    db: State<'_, Database>,
    paths: State<'_, DataPaths>,
    locks: State<'_, ScriptLocks>,
    script_id: String,
    options: ExportOptions,
) -> Result<ExportResult, AppError> {
    crate::scripts::import_export::export_script(db.pool(), &paths, &locks, &script_id, options)
        .await
}

#[tauri::command]
pub async fn reveal_script_folder(
    db: State<'_, Database>,
    paths: State<'_, DataPaths>,
    script_id: String,
) -> Result<(), AppError> {
    let canonical = repo::canonical_path_checked(db.pool(), &paths, &script_id).await?;
    tauri_plugin_opener::reveal_item_in_dir(&canonical)
        .map_err(|e| AppError::Internal(format!("reveal failed: {e}")))
}
