//! Stage/window commands (spec §46.6).

use tauri::{AppHandle, Manager, State};

use crate::database::Database;
use crate::errors::AppError;
use crate::scripts::DataPaths;
use crate::windows::{
    self, DisplayDescriptor, DisplayProfile, IdentificationSession, OpenStageRequest, StageAck,
    StageOpenResult, StageStatus, StageWindowState,
};

#[tauri::command]
pub fn list_displays(app: AppHandle) -> Result<Vec<DisplayDescriptor>, AppError> {
    windows::list_displays(&app)
}

#[tauri::command]
pub fn identify_displays(app: AppHandle) -> Result<IdentificationSession, AppError> {
    windows::identify_displays(&app)
}

#[tauri::command]
pub fn open_stage(
    app: AppHandle,
    paths: State<'_, DataPaths>,
    request: OpenStageRequest,
) -> Result<StageOpenResult, AppError> {
    // The stage renders script assets and listener media through the asset
    // protocol; make sure the managed roots are in scope (spec §47.8).
    let _ = app
        .asset_protocol_scope()
        .allow_directory(paths.scripts_dir(), true);
    let _ = app
        .asset_protocol_scope()
        .allow_directory(paths.listeners_dir(), true);
    windows::open_stage(&app, request)
}

#[tauri::command]
pub fn close_stage(app: AppHandle, session_id: String) -> Result<(), AppError> {
    windows::close_stage(&app, &session_id)
}

#[tauri::command]
pub fn set_stage_fullscreen(
    app: AppHandle,
    session_id: String,
    enabled: bool,
) -> Result<StageWindowState, AppError> {
    windows::set_stage_fullscreen(&app, &session_id, enabled)
}

#[tauri::command]
pub fn publish_stage_document(
    app: AppHandle,
    session_id: String,
    document_envelope: serde_json::Value,
) -> Result<StageAck, AppError> {
    windows::publish_stage_document(&app, &session_id, document_envelope)
}

#[tauri::command]
pub fn publish_stage_snapshot(
    app: AppHandle,
    session_id: String,
    snapshot: serde_json::Value,
) -> Result<(), AppError> {
    windows::publish_stage_snapshot(&app, &session_id, snapshot)
}

#[tauri::command]
pub fn publish_stage_command(
    app: AppHandle,
    session_id: String,
    action: serde_json::Value,
) -> Result<(), AppError> {
    windows::publish_stage_command(&app, &session_id, action)
}

#[tauri::command]
pub fn publish_listener_state(
    app: AppHandle,
    session_id: String,
    state: serde_json::Value,
) -> Result<(), AppError> {
    windows::publish_listener_state(&app, &session_id, state)
}

#[tauri::command]
pub fn get_stage_status(app: AppHandle, _session_id: Option<String>) -> StageStatus {
    windows::stage_status(&app)
}

#[tauri::command]
pub async fn save_display_profile(
    db: State<'_, Database>,
    profile: DisplayProfile,
) -> Result<DisplayProfile, AppError> {
    windows::save_display_profile(db.pool(), profile).await
}

#[tauri::command]
pub async fn list_display_profiles(
    db: State<'_, Database>,
) -> Result<Vec<DisplayProfile>, AppError> {
    windows::list_display_profiles(db.pool()).await
}
