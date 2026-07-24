//! Window management (spec §44.9): display enumeration/fingerprinting, safe
//! positioning, stage creation/destruction, fullscreen behavior.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Monitor, WebviewUrl, WebviewWindowBuilder};

use crate::coordinator::AppCoordinator;
use crate::errors::AppError;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenStageRequest {
    pub display_fingerprint: Option<String>,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageOpenResult {
    pub generation: u64,
}

/// Create (or recreate) the stage window per spec Appendix D.4 / §43.3.
///
/// The window is created hidden; callers position it, perform the stage
/// handshake, wait for fonts/media readiness, then enter fullscreen and show
/// without an intermediate flash. Handshake and readiness sequencing are not
/// implemented yet.
#[allow(dead_code)]
pub fn open_stage(app: &AppHandle, request: OpenStageRequest) -> Result<StageOpenResult, AppError> {
    let monitor = resolve_monitor(app, request.display_fingerprint.as_deref())?;
    let coordinator = app.state::<AppCoordinator>();
    let generation = coordinator.next_stage_generation();

    if let Some(existing) = app.get_webview_window("stage") {
        existing.close()?;
    }

    let window = WebviewWindowBuilder::new(app, "stage", WebviewUrl::App("stage.html".into()))
        .title("CandidCue Stage")
        .decorations(false)
        .resizable(false)
        .visible(false)
        .skip_taskbar(true)
        .build()?;

    position_to_monitor(&window, &monitor)?;
    coordinator.register_stage(generation, request.session_id);

    Ok(StageOpenResult { generation })
}

/// Resolve the target monitor from a stored display fingerprint, falling back
/// to the primary monitor. Real fingerprinting (stable across reconnects)
/// replaces the name/position heuristic below.
#[allow(dead_code)]
fn resolve_monitor(app: &AppHandle, fingerprint: Option<&str>) -> Result<Monitor, AppError> {
    let monitors = app.available_monitors()?;
    if let Some(fp) = fingerprint {
        if let Some(found) = monitors.iter().find(|m| monitor_fingerprint(m) == fp) {
            return Ok(found.clone());
        }
    }
    app.primary_monitor()?
        .or_else(|| monitors.into_iter().next())
        .ok_or(AppError::StageDisplayMissing)
}

/// Placeholder fingerprint: name + size + scale. Spec §43.8 requires a
/// profile-based match rather than blind raw coordinates.
#[allow(dead_code)]
pub fn monitor_fingerprint(monitor: &Monitor) -> String {
    format!(
        "{}|{}x{}|{}",
        monitor.name().map(|n| n.as_str()).unwrap_or("unknown"),
        monitor.size().width,
        monitor.size().height,
        monitor.scale_factor()
    )
}

#[allow(dead_code)]
fn position_to_monitor(window: &tauri::WebviewWindow, monitor: &Monitor) -> Result<(), AppError> {
    window.set_position(tauri::Position::Physical(*monitor.position()))?;
    window.set_size(tauri::Size::Physical(*monitor.size()))?;
    Ok(())
}
