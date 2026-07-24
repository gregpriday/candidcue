//! Window management (spec §44.9, §43, §52): display enumeration and stable
//! fingerprints, safe stage creation/positioning, fullscreen behavior, the
//! control→stage event bridge, and display profiles.

use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use tauri::{AppHandle, Emitter, Manager, Monitor, WebviewUrl, WebviewWindowBuilder};

use crate::coordinator::AppCoordinator;
use crate::errors::{AppError, ErrorCategory};
use crate::util::{new_uuid, now_iso};

pub const STAGE_LABEL: &str = "stage";
pub const CONTROL_LABEL: &str = "control";

// Event names (spec §46.9).
pub mod events {
    // Rust → control.
    pub const SCRIPT_EXTERNAL_CHANGE: &str = "script://external-change";
    pub const STAGE_READY: &str = "stage://ready";
    pub const STAGE_CLOSED: &str = "stage://closed";
    pub const STAGE_ERROR: &str = "stage://error";
    pub const LISTENER_DOWNLOAD_PROGRESS: &str = "listener://download-progress";
    pub const LISTENER_CATALOGUE_UPDATED: &str = "listener://catalogue-updated";
    pub const UPDATE_AVAILABLE: &str = "update://available";
    pub const UPDATE_PROGRESS: &str = "update://progress";
    pub const DEVICE_OR_DISPLAY_CHANGE: &str = "app://device-or-display-change";
    pub const DIAGNOSTIC_WARNING: &str = "diagnostic://warning";
    pub const IDENTIFY_DISPLAYS: &str = "app://identify-displays";

    // Rust → stage.
    pub const STAGE_LOAD_SESSION: &str = "stage://load-session";
    pub const STAGE_TRACKING_SNAPSHOT: &str = "stage://tracking-snapshot";
    pub const STAGE_APPLY_COMMAND: &str = "stage://apply-command";
    pub const STAGE_LISTENER_STATE: &str = "stage://listener-state";
    pub const STAGE_CLOSE_SESSION: &str = "stage://close-session";

    // Stage → Rust (listened in app setup).
    pub const STAGE_HYDRATED: &str = "stage://hydrated";
    pub const STAGE_LAYOUT_READY: &str = "stage://layout-ready";
    pub const STAGE_HEARTBEAT: &str = "stage://heartbeat";
    pub const STAGE_MEDIA_ERROR: &str = "stage://media-error";
    pub const STAGE_ESCAPE_REQUESTED: &str = "stage://escape-requested";
}

// ---------------------------------------------------------------------------
// Display descriptors and fingerprints (spec §52.3–52.4)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhysicalPoint {
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhysicalDimensions {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogicalDimensions {
    pub width: f64,
    pub height: f64,
}

/// Twin of the `DisplayDescriptor` interface (spec §52.3).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayDescriptor {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub physical_position: PhysicalPoint,
    pub physical_size: PhysicalDimensions,
    pub scale_factor: f64,
    pub logical_size: LogicalDimensions,
    pub primary: bool,
    pub fingerprint: String,
}

/// Stable display fingerprint from available facts (spec §52.3): name,
/// physical/logical dimensions, scale, and relative topology. A hint, not a
/// guaranteed hardware identifier.
pub fn display_fingerprint(
    name: Option<&str>,
    physical_width: u32,
    physical_height: u32,
    scale_factor: f64,
    position_x: i32,
    position_y: i32,
) -> String {
    let material = format!(
        "{}|{}x{}|{:.3}|{},{}",
        name.unwrap_or("unknown"),
        physical_width,
        physical_height,
        scale_factor,
        position_x,
        position_y
    );
    let digest = crate::util::sha256_hex(material.as_bytes());
    format!("dsp-{}", &digest[..16])
}

fn monitor_fingerprint(monitor: &Monitor) -> String {
    let size = monitor.size();
    let position = monitor.position();
    display_fingerprint(
        monitor.name().map(|n| n.as_str()),
        size.width,
        size.height,
        monitor.scale_factor(),
        position.x,
        position.y,
    )
}

fn monitor_descriptor(monitor: &Monitor, primary: bool, index: usize) -> DisplayDescriptor {
    let size = monitor.size();
    let position = monitor.position();
    let scale = monitor.scale_factor();
    DisplayDescriptor {
        id: format!("display-{index}"),
        name: monitor.name().cloned(),
        physical_position: PhysicalPoint {
            x: position.x,
            y: position.y,
        },
        physical_size: PhysicalDimensions {
            width: size.width,
            height: size.height,
        },
        scale_factor: scale,
        logical_size: LogicalDimensions {
            width: size.width as f64 / scale,
            height: size.height as f64 / scale,
        },
        primary,
        fingerprint: monitor_fingerprint(monitor),
    }
}

pub fn list_displays(app: &AppHandle) -> Result<Vec<DisplayDescriptor>, AppError> {
    let primary_fp = app.primary_monitor()?.map(|m| monitor_fingerprint(&m));
    let monitors = app.available_monitors()?;
    Ok(monitors
        .iter()
        .enumerate()
        .map(|(index, monitor)| {
            let descriptor = monitor_descriptor(monitor, false, index);
            let is_primary = primary_fp.as_deref() == Some(descriptor.fingerprint.as_str());
            DisplayDescriptor {
                primary: is_primary,
                ..descriptor
            }
        })
        .collect())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentificationSession {
    pub session_id: String,
    pub duration_ms: u32,
    pub displays: Vec<IdentifiedDisplay>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentifiedDisplay {
    pub number: u32,
    pub fingerprint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub logical_size: LogicalDimensions,
    pub primary: bool,
}

/// Number displays for identification (spec §52.4). The numbered overlays
/// are rendered by the control UI layer from the emitted event; Rust
/// supplies stable numbering and fingerprints.
pub fn identify_displays(app: &AppHandle) -> Result<IdentificationSession, AppError> {
    let displays = list_displays(app)?;
    let session = IdentificationSession {
        session_id: new_uuid(),
        duration_ms: 6000,
        displays: displays
            .iter()
            .enumerate()
            .map(|(index, d)| IdentifiedDisplay {
                number: index as u32 + 1,
                fingerprint: d.fingerprint.clone(),
                name: d.name.clone(),
                logical_size: d.logical_size.clone(),
                primary: d.primary,
            })
            .collect(),
    };
    let _ = app.emit_to(CONTROL_LABEL, events::IDENTIFY_DISPLAYS, &session);
    Ok(session)
}

// ---------------------------------------------------------------------------
// Stage lifecycle (spec §43.3, §46.6)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenStageRequest {
    pub display_fingerprint: Option<String>,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageOpenResult {
    pub stage_generation: u64,
    pub display_fingerprint: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageWindowState {
    pub exists: bool,
    pub visible: bool,
    pub fullscreen: bool,
    pub stage_generation: u64,
}

/// Twin of `StageStatus` (src/shared/contracts/display.ts).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageStatus {
    pub exists: bool,
    pub visible: bool,
    pub fullscreen: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_fingerprint: Option<String>,
    pub stage_generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub hydrated: bool,
    pub layout_ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_tracking_revision: Option<i64>,
    pub media_healthy: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageAck {
    pub accepted: bool,
    pub stage_generation: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

/// Create (or recreate) the stage window per spec §43.3: hidden first,
/// positioned to the target display; the control window then publishes the
/// session document, waits for hydration/layout events, and finally calls
/// `set_stage_fullscreen` to show without an intermediate flash.
pub fn open_stage(app: &AppHandle, request: OpenStageRequest) -> Result<StageOpenResult, AppError> {
    let monitor = resolve_monitor(app, request.display_fingerprint.as_deref())?;
    let fingerprint = monitor_fingerprint(&monitor);
    let size = *monitor.size();
    let position = *monitor.position();

    let coordinator = app.state::<AppCoordinator>();
    let generation = coordinator.next_stage_generation();

    if let Some(existing) = app.get_webview_window(STAGE_LABEL) {
        existing.destroy()?;
    }

    let window = WebviewWindowBuilder::new(app, STAGE_LABEL, WebviewUrl::App("stage.html".into()))
        .title("CandidCue Stage")
        .decorations(false)
        .resizable(false)
        .visible(false)
        .skip_taskbar(true)
        .build()?;

    window.set_position(tauri::Position::Physical(position))?;
    window.set_size(tauri::Size::Physical(size))?;

    coordinator.register_stage(generation, request.session_id, Some(fingerprint.clone()));

    // Notify control of window destruction (crash or close) so it can offer
    // "Reopen stage" (spec §43.5).
    let app_handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let coordinator = app_handle.state::<AppCoordinator>();
            coordinator.stage_closed(generation);
            let _ = app_handle.emit_to(
                CONTROL_LABEL,
                events::STAGE_CLOSED,
                serde_json::json!({ "stageGeneration": generation }),
            );
        }
    });

    Ok(StageOpenResult {
        stage_generation: generation,
        display_fingerprint: fingerprint,
    })
}

fn resolve_monitor(app: &AppHandle, fingerprint: Option<&str>) -> Result<Monitor, AppError> {
    let monitors = app.available_monitors()?;
    if let Some(fp) = fingerprint {
        for monitor in &monitors {
            if monitor_fingerprint(monitor) == fp {
                return Ok(monitor.clone());
            }
        }
        return Err(AppError::StageDisplayMissing);
    }
    app.primary_monitor()?
        .or_else(|| monitors.into_iter().next())
        .ok_or(AppError::StageDisplayMissing)
}

fn require_active_session(app: &AppHandle, session_id: &str) -> Result<u64, AppError> {
    let coordinator = app.state::<AppCoordinator>();
    let snapshot = coordinator.snapshot();
    if !snapshot.stage.exists {
        return Err(AppError::structured(
            "STAGE_OPEN_FAILED",
            ErrorCategory::Window,
            "The stage window is not open.",
            true,
        ));
    }
    match &snapshot.stage.session_id {
        Some(active) if active == session_id => Ok(snapshot.stage.generation),
        _ => Err(AppError::invalid_input(
            "The session is no longer active on the stage.",
        )
        .with_detail("sessionId", session_id)),
    }
}

pub fn close_stage(app: &AppHandle, session_id: &str) -> Result<(), AppError> {
    let coordinator = app.state::<AppCoordinator>();
    let snapshot = coordinator.snapshot();
    // Idempotent: closing an absent stage is fine.
    if let Some(window) = app.get_webview_window(STAGE_LABEL) {
        let _ = app.emit_to(
            STAGE_LABEL,
            events::STAGE_CLOSE_SESSION,
            serde_json::json!({ "sessionId": session_id }),
        );
        window.destroy()?;
    }
    coordinator.stage_closed(snapshot.stage.generation);
    Ok(())
}

pub fn set_stage_fullscreen(
    app: &AppHandle,
    session_id: &str,
    enabled: bool,
) -> Result<StageWindowState, AppError> {
    let generation = require_active_session(app, session_id)?;
    let window = app
        .get_webview_window(STAGE_LABEL)
        .ok_or(AppError::StageDisplayMissing)?;
    if enabled {
        window.show()?;
        window.set_fullscreen(true)?;
        window.set_focus().ok();
    } else {
        window.set_fullscreen(false)?;
    }
    let visible = window.is_visible().unwrap_or(false);
    let fullscreen = window.is_fullscreen().unwrap_or(false);
    let coordinator = app.state::<AppCoordinator>();
    coordinator.set_stage_visible(visible, fullscreen);
    Ok(StageWindowState {
        exists: true,
        visible,
        fullscreen,
        stage_generation: generation,
    })
}

pub fn stage_status(app: &AppHandle) -> StageStatus {
    let coordinator = app.state::<AppCoordinator>();
    let snapshot = coordinator.snapshot();
    let window_exists = app.get_webview_window(STAGE_LABEL).is_some();
    StageStatus {
        exists: snapshot.stage.exists && window_exists,
        visible: snapshot.stage.visible,
        fullscreen: snapshot.stage.fullscreen,
        display_fingerprint: snapshot.stage.display_fingerprint.clone(),
        stage_generation: snapshot.stage.generation,
        session_id: snapshot.stage.session_id.clone(),
        hydrated: snapshot.stage.hydrated,
        layout_ready: snapshot.stage.layout_ready,
        last_tracking_revision: snapshot.stage.last_tracking_revision,
        media_healthy: snapshot.stage.media_healthy,
    }
}

// ---------------------------------------------------------------------------
// Control → stage relay (spec §46.6): validated, emitted only to the stage
// window label, never broadcast.
// ---------------------------------------------------------------------------

/// Payload cap for a stage document envelope (spec §46.10).
const MAX_STAGE_DOCUMENT_BYTES: usize = 8 * 1024 * 1024;
/// Payload cap for a tracking snapshot.
const MAX_SNAPSHOT_BYTES: usize = 32 * 1024;

pub fn publish_stage_document(
    app: &AppHandle,
    session_id: &str,
    document_envelope: serde_json::Value,
) -> Result<StageAck, AppError> {
    let generation = require_active_session(app, session_id)?;
    let serialized = serde_json::to_vec(&document_envelope)
        .map_err(|e| AppError::Internal(format!("envelope serialize: {e}")))?;
    if serialized.len() > MAX_STAGE_DOCUMENT_BYTES {
        return Err(AppError::invalid_input("The stage document is too large."));
    }
    if document_envelope.get("schemaVersion").and_then(|v| v.as_u64()) != Some(1) {
        return Err(AppError::invalid_input(
            "The stage document has an unsupported schema.",
        ));
    }
    if document_envelope.get("sessionId").and_then(|v| v.as_str()) != Some(session_id) {
        return Err(AppError::invalid_input(
            "The stage document targets another session.",
        ));
    }
    app.emit_to(STAGE_LABEL, events::STAGE_LOAD_SESSION, &document_envelope)?;
    Ok(StageAck {
        accepted: true,
        stage_generation: generation,
        session_id: Some(session_id.to_string()),
    })
}

/// Validate numeric bounds, identifiers, session generation, and payload
/// size before emitting to the stage (spec §46.6).
pub fn publish_stage_snapshot(
    app: &AppHandle,
    session_id: &str,
    snapshot: serde_json::Value,
) -> Result<(), AppError> {
    let coordinator = app.state::<AppCoordinator>();
    let state = coordinator.snapshot();
    let generation = require_active_session(app, session_id)?;

    let serialized = serde_json::to_vec(&snapshot)
        .map_err(|e| AppError::Internal(format!("snapshot serialize: {e}")))?;
    if serialized.len() > MAX_SNAPSHOT_BYTES {
        return Err(AppError::invalid_input("The tracking snapshot is too large."));
    }
    if snapshot.get("schemaVersion").and_then(|v| v.as_u64()) != Some(1) {
        return Err(AppError::invalid_input("The snapshot has an unsupported schema."));
    }
    if snapshot.get("sessionId").and_then(|v| v.as_str()) != Some(session_id) {
        return Err(AppError::invalid_input("The snapshot targets another session."));
    }
    // Stale-generation snapshots are dropped silently (spec §43.5).
    if let Some(stage_generation) = snapshot.get("stageGeneration").and_then(|v| v.as_u64()) {
        if stage_generation != generation {
            return Ok(());
        }
    }
    if let Some(session_generation) = snapshot.get("sessionGeneration").and_then(|v| v.as_u64()) {
        if session_generation != state.session.session_generation {
            return Ok(());
        }
    }
    for field in ["tokenIndex", "committedTokenIndex", "revision"] {
        match snapshot.get(field).and_then(|v| v.as_i64()) {
            Some(value) if value >= 0 => {}
            _ => {
                return Err(AppError::invalid_input(format!(
                    "Snapshot field {field} must be a non-negative integer."
                )));
            }
        }
    }
    app.emit_to(STAGE_LABEL, events::STAGE_TRACKING_SNAPSHOT, &snapshot)?;
    Ok(())
}

/// Allow-listed stage command actions (src/shared/contracts/commands.ts).
const ALLOWED_STAGE_ACTIONS: &[&str] = &[
    "start",
    "pause",
    "resume",
    "hard_pause",
    "stop",
    "go_to_target",
    "next_section",
    "previous_section",
    "move_relative",
    "restart_unit",
    "set_font_size",
    "adjust_font_size",
    "set_margins",
    "toggle_mirror",
    "blank_stage",
    "unblank_stage",
    "set_listener",
    "adjust_reading_band",
    "set_scroll_mode",
];

pub fn publish_stage_command(
    app: &AppHandle,
    session_id: &str,
    action: serde_json::Value,
) -> Result<(), AppError> {
    require_active_session(app, session_id)?;
    let action_name = action
        .get("action")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::invalid_input("A stage command needs an action."))?;
    if !ALLOWED_STAGE_ACTIONS.contains(&action_name) {
        return Err(AppError::invalid_input(format!(
            "Unknown stage command action: {action_name}"
        )));
    }
    app.emit_to(STAGE_LABEL, events::STAGE_APPLY_COMMAND, &action)?;
    Ok(())
}

pub fn publish_listener_state(
    app: &AppHandle,
    session_id: &str,
    state: serde_json::Value,
) -> Result<(), AppError> {
    require_active_session(app, session_id)?;
    app.emit_to(STAGE_LABEL, events::STAGE_LISTENER_STATE, &state)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Display profiles (spec §46.6 save_display_profile, table display_profiles)
// ---------------------------------------------------------------------------

/// Twin of `DisplayProfile` (src/shared/contracts/display.ts). The stage
/// settings and listener geometry are carried as validated JSON documents.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayProfile {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_fingerprint: Option<String>,
    pub stage: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listener: Option<serde_json::Value>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

pub async fn save_display_profile(
    pool: &SqlitePool,
    mut profile: DisplayProfile,
) -> Result<DisplayProfile, AppError> {
    if profile.name.trim().is_empty() {
        return Err(AppError::invalid_input("A display profile needs a name."));
    }
    if !profile.stage.is_object() {
        return Err(AppError::invalid_input("Stage settings must be an object."));
    }
    if profile.stage.get("schemaVersion").and_then(|v| v.as_u64()) != Some(1) {
        return Err(AppError::invalid_input(
            "Stage settings have an unsupported schema version.",
        ));
    }
    let id = profile.id.clone().unwrap_or_else(new_uuid);
    let now = now_iso();
    sqlx::query(
        "INSERT INTO display_profiles
            (id, name, display_fingerprint, stage_settings_json, listener_geometry_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            display_fingerprint = excluded.display_fingerprint,
            stage_settings_json = excluded.stage_settings_json,
            listener_geometry_json = excluded.listener_geometry_json,
            updated_at = excluded.updated_at",
    )
    .bind(&id)
    .bind(profile.name.trim())
    .bind(&profile.display_fingerprint)
    .bind(serde_json::to_string(&profile.stage).unwrap_or_else(|_| "{}".into()))
    .bind(
        profile
            .listener
            .as_ref()
            .and_then(|l| serde_json::to_string(l).ok()),
    )
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;

    profile.id = Some(id);
    profile.updated_at = Some(now);
    Ok(profile)
}

pub async fn list_display_profiles(pool: &SqlitePool) -> Result<Vec<DisplayProfile>, AppError> {
    let rows = sqlx::query(
        "SELECT id, name, display_fingerprint, stage_settings_json, listener_geometry_json, updated_at
         FROM display_profiles ORDER BY updated_at DESC",
    )
    .fetch_all(pool)
    .await?;
    rows.iter()
        .map(|row| {
            let stage_json: String = row.try_get("stage_settings_json")?;
            let listener_json: Option<String> = row.try_get("listener_geometry_json")?;
            Ok(DisplayProfile {
                id: Some(row.try_get("id")?),
                name: row.try_get("name")?,
                display_fingerprint: row.try_get("display_fingerprint")?,
                stage: serde_json::from_str(&stage_json).unwrap_or(serde_json::Value::Null),
                listener: listener_json.and_then(|j| serde_json::from_str(&j).ok()),
                updated_at: row.try_get("updated_at")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_is_stable_and_distinct() {
        let a1 = display_fingerprint(Some("DELL U2720Q"), 3840, 2160, 2.0, 0, 0);
        let a2 = display_fingerprint(Some("DELL U2720Q"), 3840, 2160, 2.0, 0, 0);
        assert_eq!(a1, a2);
        assert!(a1.starts_with("dsp-"));
        assert_eq!(a1.len(), 4 + 16);

        // Same panel at a different position → different topology → new fp.
        let moved = display_fingerprint(Some("DELL U2720Q"), 3840, 2160, 2.0, 3840, 0);
        assert_ne!(a1, moved);

        // Different scale factor → different fingerprint.
        let scaled = display_fingerprint(Some("DELL U2720Q"), 3840, 2160, 1.0, 0, 0);
        assert_ne!(a1, scaled);

        // Unnamed generic display still yields a usable fingerprint.
        let generic = display_fingerprint(None, 1024, 600, 1.0, -1024, 0);
        assert!(generic.starts_with("dsp-"));
        assert_ne!(generic, a1);
    }
}
