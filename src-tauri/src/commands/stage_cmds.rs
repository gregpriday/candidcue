//! Stage/window commands (spec §46.6).

use tauri::{AppHandle, Runtime};

use crate::errors::AppError;
use crate::windows::{
    self, ControlPresentationState, DisplayDescriptor, IdentificationSession,
    OpenStageRequest, StageAck, StageDocumentEnvelope, StageOpenResult, StageStatus,
    StageWindowState,
};

#[tauri::command]
pub fn list_displays<R: Runtime>(app: AppHandle<R>) -> Result<Vec<DisplayDescriptor>, AppError> {
    windows::list_displays(&app)
}

#[tauri::command]
pub fn identify_displays<R: Runtime>(app: AppHandle<R>) -> Result<IdentificationSession, AppError> {
    windows::identify_displays(&app)
}

/// The panel the CONTROL window is on right now — the destination a take will
/// actually open on (CCUX-004).
///
/// Read-only and cheap enough to call whenever the editor wants to re-state
/// where Present is going. `None` means the panel could not be determined, and
/// the caller must say so rather than substituting the calibrated display: the
/// whole point of the readout is that those two are not the same thing.
#[tauri::command]
pub fn current_window_display<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Option<DisplayDescriptor>, AppError> {
    windows::window_display(&app, windows::CONTROL_LABEL)
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
/// Turn the control window into the teleprompter, and back (§52.7).
///
/// This is single-window presentation's counterpart to `set_stage_fullscreen`,
/// and `prompter` mode presents the same way for the same reasons: borderless at
/// the monitor's exact bounds, always-on-top, no OS fullscreen. The renderer
/// used to call `core:window:set_fullscreen` directly, which on macOS animates
/// into a new Space and shows a white bar over the half-painted webview for the
/// length of the animation — see `windows::present` for the full account.
///
/// `mode` chooses the shape and is optional for the same reason `native` is on
/// the command above: an `{ enabled: true }` payload from before reader mode
/// existed must keep doing exactly what it did, which is present as a prompter.
/// `enabled: false` ignores it — there is one way to stop.
///
/// `reader_frame` is where a reading window was left on a PREVIOUS run, read
/// out of the settings document by the caller. Optional in the same way and for
/// the same reason: absent means "present in place", which is what reader mode
/// did before the frame was persisted at all. It is ignored for `prompter`,
/// which fills a monitor rather than occupying a rectangle, and on the way out.
///
/// The frame arrives as an argument rather than being read from settings here
/// on purpose. This module owns windows, not preferences, and the round trip is
/// already asymmetric — Rust is the only thing that can MEASURE the frame, the
/// settings document is the only thing that can KEEP it — so the frontend owns
/// the storage half at both ends and Rust stays a pure window operation.
///
/// `display_fingerprint` is the panel a PROMPTER should fill — the one pinned
/// in Settings › Prompter, as `list_displays` fingerprints it. Optional for the
/// same compatibility reason as the others: absent, the prompter fills the
/// monitor the window is already on, which is all it ever did before. Ignored
/// by reader mode, which presents in place, and on the way out.
pub fn set_control_presenting<R: Runtime>(
    app: AppHandle<R>,
    enabled: bool,
    mode: Option<windows::PresentMode>,
    reader_frame: Option<windows::ReaderFrame>,
    display_fingerprint: Option<String>,
) -> Result<ControlPresentationState, AppError> {
    let requested = if enabled {
        Some(mode.unwrap_or(windows::PresentMode::Prompter))
    } else {
        None
    };
    windows::set_control_presenting(&app, requested, reader_frame, display_fingerprint.as_deref())
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
pub fn get_stage_status<R: Runtime>(app: AppHandle<R>, _session_id: Option<String>) -> StageStatus {
    windows::stage_status(&app)
}
