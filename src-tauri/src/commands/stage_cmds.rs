//! Stage/window commands (spec §46.6).

use tauri::{AppHandle, Runtime, State};

use crate::database::Database;
use crate::errors::AppError;
use crate::windows::{
    self, DisplayDescriptor, DisplayProfile, IdentificationSession, OpenStageRequest, StageAck,
    StageDocumentEnvelope, StageOpenResult, StageStatus, StageWindowState,
};

#[tauri::command]
pub fn list_displays<R: Runtime>(app: AppHandle<R>) -> Result<Vec<DisplayDescriptor>, AppError> {
    windows::list_displays(&app)
}

#[tauri::command]
pub fn identify_displays<R: Runtime>(app: AppHandle<R>) -> Result<IdentificationSession, AppError> {
    windows::identify_displays(&app)
}

#[tauri::command]
pub fn open_stage<R: Runtime>(app: AppHandle<R>, request: OpenStageRequest) -> Result<StageOpenResult, AppError> {
    // M2: opening the stage used to add BOTH managed roots to the asset scope
    // recursively, every time, and nothing ever took them back out. That put
    // every script's canonical Markdown and revision history behind an
    // `asset://` url the stage could fetch — the one window that is supposed to
    // see nothing but the media for its own session (spec §50.10, §43.2).
    //
    // The scope is now static (tauri.conf.json: `$APPDATA/scripts/*/assets/*`
    // plus an explicit deny list), so there is nothing to widen here and
    // nothing to revoke.
    windows::open_stage(&app, request)
}

#[tauri::command]
pub fn close_stage<R: Runtime>(app: AppHandle<R>, session_id: String) -> Result<(), AppError> {
    windows::close_stage(&app, &session_id)
}

#[tauri::command]
/// `native` opts into OS fullscreen. It defaults to false: the stage presents
/// borderless at the monitor's exact bounds and always-on-top, which avoids
/// macOS allocating a new Space, animating into it, and pulling focus off the
/// control window mid-take (spec §52.7).
pub fn set_stage_fullscreen<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    enabled: bool,
    native: Option<bool>,
) -> Result<StageWindowState, AppError> {
    windows::set_stage_fullscreen(&app, &session_id, enabled, native.unwrap_or(false))
}

#[tauri::command]
/// §46.6. `document_envelope` is a typed `StageSessionEnvelope`, not a bare
/// `serde_json::Value`: this is the hop that hydrates the stage, and until it
/// had an argument shape a control side that renamed `renderDocument` would
/// have produced a stage that hydrated with no script and no error anywhere.
/// The header fields stay optional inside the struct so
/// `validate_stage_payload_header` keeps reporting their absence in its own
/// words — see the type's documentation.
pub fn publish_stage_document<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    document_envelope: StageDocumentEnvelope,
) -> Result<StageAck, AppError> {
    windows::publish_stage_document(&app, &session_id, document_envelope.into_value()?)
}

#[tauri::command]
pub fn publish_stage_command<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    action: serde_json::Value,
) -> Result<(), AppError> {
    windows::publish_stage_command(&app, &session_id, action)
}

#[tauri::command]
pub fn publish_listener_state<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    state: serde_json::Value,
) -> Result<(), AppError> {
    windows::publish_listener_state(&app, &session_id, state)
}

#[tauri::command]
pub fn get_stage_status<R: Runtime>(app: AppHandle<R>, _session_id: Option<String>) -> StageStatus {
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
