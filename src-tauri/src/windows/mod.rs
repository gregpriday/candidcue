//! Window management (spec §44.9, §43, §52): display enumeration and stable
//! fingerprints, safe stage creation/positioning, fullscreen behavior, the
//! control→stage event bridge, and display profiles.

use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use tauri::{AppHandle, Emitter, Manager, Monitor, Runtime, WebviewUrl, WebviewWindowBuilder};

use crate::coordinator::AppCoordinator;
use crate::errors::{AppError, ErrorCategory};
use crate::util::{new_uuid, now_iso};

pub mod sleep;

pub const STAGE_LABEL: &str = "stage";
pub const CONTROL_LABEL: &str = "control";
/// Label prefix for the transient "which display is this?" overlays (§52.4).
pub const IDENTIFY_LABEL_PREFIX: &str = "identify-";

// Event names (spec §46.9). Mirrored verbatim by the TypeScript constants in
// src/shared/contracts/stage.ts (STAGE_EVENT / CONTROL_EVENT); the
// `stage_event_names_match_ts_contract` test enforces the pairing.
pub mod events {
    // Rust → control.
    pub const SCRIPT_EXTERNAL_CHANGE: &str = "script://external-change";
    pub const STAGE_READY: &str = "stage://ready";
    pub const STAGE_CLOSED: &str = "stage://closed";
    pub const STAGE_ERROR: &str = "stage://error";
    pub const UPDATE_AVAILABLE: &str = "update://available";
    pub const UPDATE_PROGRESS: &str = "update://progress";
    pub const DEVICE_OR_DISPLAY_CHANGE: &str = "app://device-or-display-change";
    pub const DIAGNOSTIC_WARNING: &str = "diagnostic://warning";
    pub const IDENTIFY_DISPLAYS: &str = "app://identify-displays";
    /// Rust → control: the same `AlignmentSnapshot` the stage receives, for
    /// progress, recovery affordances and the take summary. A separate name
    /// from the stage's copy because they are different contracts to different
    /// windows — the stage follows it, control reports on it.
    pub const ALIGN_SNAPSHOT: &str = "align://snapshot";

    // Rust → stage.
    pub const STAGE_LOAD_SESSION: &str = "stage://load-session";
    pub const STAGE_APPLY_COMMAND: &str = "stage://apply-command";
    pub const STAGE_CLOSE_SESSION: &str = "stage://close-session";

    // Control → stage (emitted directly from the control webview, §43.5).
    pub const STAGE_HEARTBEAT: &str = "stage://heartbeat";
    // Semantic motion frames, 15–30 Hz (companion §26.1). Like the heartbeat
    // these are emitted straight from the control webview: a high-rate motion
    // signal, gated by the stage's own frame receiver rather than by Rust.
    /// Raw recogniser text for the stage's transcript bar. Same direct path as
    /// the heartbeat: a diagnostic readout, and a dropped one costs nothing.
    pub const STAGE_TRANSCRIPT_TAP: &str = "stage://transcript-tap";
    /// The voice pill: the stage's corner readout of whether the app is
    /// picking up what the presenter says. Control owns the capture and sends
    /// a resolved view; the stage holds no audio state. Direct control → stage
    /// emit, same path as the transcript tap.
    pub const STAGE_VOICE_PILL: &str = "stage://voice-pill";

    /// Rust → stage: one `AlignmentSnapshot` per transcript event (~1/s).
    ///
    /// This comes from Rust rather than from control because the alignment
    /// engine lives in Rust, next to the audio clock its predictions are timed
    /// against. Control is not in the path at all — it receives the same
    /// snapshot separately on [`ALIGN_SNAPSHOT`] for progress and the take
    /// summary.
    pub const STAGE_ALIGNMENT_SNAPSHOT: &str = "stage://alignment-snapshot";
    /// Stage → Rust: the debounced visible token range (§5 of the integration
    /// note). A prior on candidate ranking, never a command.
    pub const STAGE_VIEWPORT_HINT: &str = "stage://viewport-hint";

    // Stage → Rust (listened in app setup).
    /// The stage's event subscriptions are registered and it can now receive
    /// a document (spec §43.3 step 0).
    ///
    /// A webview event is delivered by evaluating JS in the target webview and
    /// is not queued, so anything emitted to the stage before its bundle runs
    /// is lost outright. This is the stage saying it is reachable; Rust
    /// answers by replaying the envelope it is holding, if any.
    pub const STAGE_LISTENING: &str = "stage://listening";
    pub const STAGE_SYNC_REQUEST: &str = "stage://sync-request";
    pub const STAGE_LIVE_SYNC: &str = "stage://live-sync";
    pub const STAGE_HYDRATED: &str = "stage://hydrated";
    pub const STAGE_LAYOUT_READY: &str = "stage://layout-ready";
    pub const STAGE_HEARTBEAT_ACK: &str = "stage://heartbeat-ack";
    pub const STAGE_MEDIA_ERROR: &str = "stage://media-error";
    // S1: the stage emits these two under names control does NOT listen for.
    // A webview `emit` is a broadcast — Tauri delivers it to every webview's JS
    // listeners as well as to the Rust `listen_any` handlers, and a listener
    // with the default `Any` target matches whatever the emitter targeted. When
    // the stage emitted `stage://escape-requested` and the bridge below
    // re-emitted the same name to control, control ran its handler twice: once
    // ungated, once after the generation check. Same shape as `layout-ready` →
    // `stage://ready` and `media-error` → `stage://error`.
    pub const STAGE_ESCAPE_PRESSED: &str = "stage://escape-pressed";
    pub const STAGE_MOTION_REPORT: &str = "stage://motion-report";
    // §62 recoverable stage-layout failure (and its recovery). Same name
    // separation as the two above, for the same reason.
    pub const STAGE_LAYOUT_ERROR: &str = "stage://layout-error";

    // Rust → control, after the coordinator's generation check.
    pub const STAGE_ESCAPE_REQUESTED: &str = "stage://escape-requested";
    // Periodic stage motion report, relayed to control (companion §54).
    pub const STAGE_MOTION_ACK: &str = "stage://motion-ack";
    // §62 stage-layout failure, relayed to control. Deliberately NOT
    // `stage://error`: that channel already carries the window layer's own
    // errors, and a held stage is a different emergency with a different
    // recovery.
    pub const STAGE_LAYOUT_FAILED: &str = "stage://layout-failed";

    // Stage → control (listened directly by the control webview).
    pub const STAGE_INTENT: &str = "stage://intent";
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
    /// Stable identity: survives rearranging displays (see `display_identity`).
    pub fingerprint: String,
    /// Soft arrangement hash: changes when the user moves/rescales displays.
    /// Only ever used to hint "your arrangement changed" — never to resolve a
    /// saved profile.
    pub topology_hash: String,
}

/// Stable display identity (spec §52.3) from the facts that describe the
/// PANEL rather than its placement: name plus physical size.
///
/// Position and scale factor are deliberately excluded. They used to be folded
/// in, which meant dragging a monitor in System Settings ▸ Displays ▸ Arrange —
/// or docking a laptop, or changing the resolution scaling — silently
/// invalidated every saved display profile and turned a configured stage
/// display into `StageDisplayMissing`. Arrangement is not identity.
pub fn display_identity(name: Option<&str>, physical_width: u32, physical_height: u32) -> String {
    let material = format!(
        "{}|{}x{}",
        name.unwrap_or("unknown"),
        physical_width,
        physical_height
    );
    let digest = crate::util::sha256_hex(material.as_bytes());
    format!("dsp-{}", &digest[..16])
}

/// Full fingerprint: the stable identity, plus a disambiguating ordinal when
/// several connected panels are genuinely indistinguishable (two identical
/// monitors). Ordinal 0 — the overwhelmingly common case — yields the bare
/// identity, so a unique panel's fingerprint never changes at all.
pub fn display_fingerprint(
    name: Option<&str>,
    physical_width: u32,
    physical_height: u32,
    ordinal: u32,
) -> String {
    let identity = display_identity(name, physical_width, physical_height);
    if ordinal == 0 {
        identity
    } else {
        format!("{identity}-{ordinal}")
    }
}

/// The identity portion of a fingerprint — used for the softer fallback match
/// when the exact fingerprint (identity + ordinal) is no longer present.
pub fn fingerprint_identity(fingerprint: &str) -> &str {
    match fingerprint.rfind('-') {
        // Only a trailing "-<digits>" is an ordinal; "dsp-<hex>" is not.
        Some(index)
            if index > 3 && fingerprint[index + 1..].chars().all(|c| c.is_ascii_digit()) =>
        {
            &fingerprint[..index]
        }
        _ => fingerprint,
    }
}

/// Soft hash of where a display currently sits and how it is scaled. Changing
/// it means "the arrangement moved", never "this is a different display".
pub fn display_topology_hash(
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
    format!("top-{}", &digest[..16])
}

fn monitor_topology_hash(monitor: &Monitor) -> String {
    let size = monitor.size();
    let position = monitor.position();
    display_topology_hash(
        monitor.name().map(|n| n.as_str()),
        size.width,
        size.height,
        monitor.scale_factor(),
        position.x,
        position.y,
    )
}

/// Fingerprints for a whole monitor list. The ordinal can only be assigned
/// with the full list in hand, so fingerprints are always derived in a batch.
fn monitor_fingerprints(monitors: &[Monitor]) -> Vec<String> {
    let mut seen: std::collections::HashMap<(String, u32, u32), u32> =
        std::collections::HashMap::new();
    monitors
        .iter()
        .map(|monitor| {
            let size = monitor.size();
            let name = monitor.name().cloned().unwrap_or_default();
            let counter = seen.entry((name, size.width, size.height)).or_insert(0);
            let fingerprint = display_fingerprint(
                monitor.name().map(|n| n.as_str()),
                size.width,
                size.height,
                *counter,
            );
            *counter += 1;
            fingerprint
        })
        .collect()
}

/// Same physical panel? Compared by the facts tao gives us rather than by
/// fingerprint, because the fingerprint needs whole-list context for ordinals.
fn same_monitor(a: &Monitor, b: &Monitor) -> bool {
    a.name() == b.name() && a.size() == b.size() && a.position() == b.position()
}

fn monitor_descriptor(
    monitor: &Monitor,
    primary: bool,
    index: usize,
    fingerprint: String,
) -> DisplayDescriptor {
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
        fingerprint,
        topology_hash: monitor_topology_hash(monitor),
    }
}

pub fn list_displays<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<DisplayDescriptor>, AppError> {
    let primary = app.primary_monitor()?;
    let monitors = app.available_monitors()?;
    let fingerprints = monitor_fingerprints(&monitors);
    Ok(monitors
        .iter()
        .enumerate()
        .map(|(index, monitor)| {
            let is_primary = primary.as_ref().is_some_and(|p| same_monitor(p, monitor));
            monitor_descriptor(monitor, is_primary, index, fingerprints[index].clone())
        })
        .collect())
}

/// One hash covering the whole desktop arrangement. Used only to notice that
/// the topology changed so control can revalidate (spec §52.5).
pub fn topology_signature(descriptors: &[DisplayDescriptor]) -> String {
    let mut parts: Vec<String> = descriptors
        .iter()
        .map(|d| format!("{}:{}", d.fingerprint, d.topology_hash))
        .collect();
    parts.sort();
    let digest = crate::util::sha256_hex(parts.join("|").as_bytes());
    digest[..16].to_string()
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

/// How long the numbered overlays stay up.
const IDENTIFY_DURATION_MS: u32 = 2500;
/// Overlay card size in logical points.
const IDENTIFY_CARD_W: f64 = 320.0;
const IDENTIFY_CARD_H: f64 = 220.0;

/// Number displays for identification (spec §52.4).
///
/// The question this answers — "which physical panel is number 2?" — is only
/// answerable by putting a number ON each panel. A toast in the control window
/// listing display names cannot answer it, because the operator is looking at
/// the panels, not at the list. So this puts a short-lived, always-on-top,
/// click-through numbered card on every connected display, and ALSO emits the
/// session to control so the picker can label its tiles to match.
pub fn identify_displays<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<IdentificationSession, AppError> {
    let displays = list_displays(app)?;
    let session = IdentificationSession {
        session_id: new_uuid(),
        duration_ms: IDENTIFY_DURATION_MS,
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

    close_identify_overlays(app);
    for display in &session.displays {
        if let Some(descriptor) = displays.iter().find(|d| d.fingerprint == display.fingerprint) {
            // A failed overlay must not fail the whole command — the emitted
            // session is still useful.
            if let Err(error) = spawn_identify_overlay(app, display.number, descriptor) {
                tracing::warn!(%error, "could not show a display identification overlay");
            }
        }
    }
    schedule_identify_close(app, IDENTIFY_DURATION_MS);

    let _ = app.emit_to(CONTROL_LABEL, events::IDENTIFY_DISPLAYS, &session);
    Ok(session)
}

fn spawn_identify_overlay<R: Runtime>(
    app: &AppHandle<R>,
    number: u32,
    display: &DisplayDescriptor,
) -> Result<(), AppError> {
    let label = format!("{IDENTIFY_LABEL_PREFIX}{number}");
    let url = format!(
        "identify.html?n={number}&primary={}",
        u8::from(display.primary)
    );

    // Centre a small card on the panel rather than covering it: a full-display
    // overlay would need a transparent window, which on macOS means opting the
    // whole app into the private-API surface — too much for a 2.5 s hint.
    let scale = display.scale_factor.max(0.1);
    let card_w = (IDENTIFY_CARD_W * scale) as i32;
    let card_h = (IDENTIFY_CARD_H * scale) as i32;
    let x = display.physical_position.x + (display.physical_size.width as i32 - card_w) / 2;
    let y = display.physical_position.y + (display.physical_size.height as i32 - card_h) / 2;

    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title("Display")
        .decorations(false)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        // Never steal focus from the control window the operator is driving.
        .focused(false)
        .focusable(false)
        .shadow(false)
        .background_color(tauri::window::Color(13, 15, 18, 255))
        .visible(false)
        .position(x as f64 / scale, y as f64 / scale)
        .inner_size(IDENTIFY_CARD_W, IDENTIFY_CARD_H)
        .build()?;

    window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }))?;
    window.set_size(tauri::Size::Physical(tauri::PhysicalSize {
        width: card_w as u32,
        height: card_h as u32,
    }))?;
    let _ = window.set_ignore_cursor_events(true);
    window.show()?;
    Ok(())
}

/// Close every identification overlay. Idempotent and safe against windows
/// that already went away (a quit mid-identify must not fire at a destroyed
/// window — the failure the Electron build guarded with a `closed` handler).
pub fn close_identify_overlays<R: Runtime>(app: &AppHandle<R>) {
    let labels: Vec<String> = app
        .webview_windows()
        .keys()
        .filter(|label| label.starts_with(IDENTIFY_LABEL_PREFIX))
        .cloned()
        .collect();
    for label in labels {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.destroy();
        }
    }
}

fn schedule_identify_close<R: Runtime>(app: &AppHandle<R>, delay_ms: u32) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(u64::from(delay_ms)));
        let handle = app.clone();
        // Window teardown must happen on the main thread; if the dispatch
        // fails the app is already shutting down and the windows go with it.
        let _ = app.run_on_main_thread(move || close_identify_overlays(&handle));
    });
}

// ---------------------------------------------------------------------------
// Stage lifecycle (spec §43.3, §46.6)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenStageRequest {
    #[serde(default)]
    pub display_fingerprint: Option<String>,
    /// Mandatory (M1). It used to be optional, so a stage could be registered
    /// with no owning session at all — and then every downstream check that
    /// compares against the active session had nothing to compare with, and
    /// `close_stage` would happily accept any id.
    pub session_id: String,
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
    /// Presenting full-screen on its display — true for borderless too.
    pub fullscreen: bool,
    /// The OS native-fullscreen flag specifically (macOS Space / Win exclusive).
    pub native_fullscreen: bool,
    /// The display the stage ACTUALLY landed on, verified after show.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_fingerprint: Option<String>,
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
    /// The stage webview's bundle has run and its subscriptions are live
    /// (handshake step 0). Distinguishes a window that never finished loading
    /// from one that loaded and then never received its document — two
    /// unrelated failures that used to report identically.
    pub listening: bool,
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
pub fn open_stage<R: Runtime>(
    app: &AppHandle<R>,
    request: OpenStageRequest,
) -> Result<StageOpenResult, AppError> {
    let monitor = resolve_monitor(app, request.display_fingerprint.as_deref())?;
    let monitors = app.available_monitors()?;
    let fingerprints = monitor_fingerprints(&monitors);
    let fingerprint = monitors
        .iter()
        .position(|m| same_monitor(m, &monitor))
        .and_then(|index| fingerprints.get(index).cloned())
        .ok_or(AppError::StageDisplayMissing)?;
    let size = *monitor.size();
    let position = *monitor.position();
    let scale = monitor.scale_factor();

    let coordinator = app.state::<AppCoordinator>();
    let generation = coordinator.next_stage_generation();

    if let Some(existing) = app.get_webview_window(STAGE_LABEL) {
        existing.destroy()?;
    }

    // Position and size go into the BUILDER, not a post-build set_position:
    // creating a window at the origin and then moving it makes the OS assign it
    // to the wrong screen first, which on mixed-DPI setups bakes in the wrong
    // scale factor before the move (a long-standing tao rough edge). The
    // builder takes logical units, so convert through the target monitor's own
    // scale factor; the physical values are re-asserted below, where they are
    // unambiguous.
    let window = WebviewWindowBuilder::new(app, STAGE_LABEL, WebviewUrl::App("stage.html".into()))
        .title("CandidCue Stage")
        .decorations(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .visible(false)
        .skip_taskbar(true)
        // The stage must sit above every other window — including other apps'
        // full-screen windows — for the whole take (spec §52.7). This is what
        // makes the borderless presentation mode viable as the default.
        .always_on_top(true)
        // Paint the window black before the webview's first frame, so the
        // OS window-show cannot flash white on the way to a black stage.
        .background_color(tauri::window::Color(0, 0, 0, 255))
        .position(position.x as f64 / scale, position.y as f64 / scale)
        .inner_size(size.width as f64 / scale, size.height as f64 / scale)
        .build()?;

    // Re-assert in physical units: exact, and immune to the logical rounding
    // above.
    window.set_position(tauri::Position::Physical(position))?;
    window.set_size(tauri::Size::Physical(size))?;

    coordinator.register_stage(generation, Some(request.session_id), Some(fingerprint.clone()));

    // Notify control of window destruction (crash or close) so it can offer
    // "Reopen stage" (spec §43.5).
    let app_handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let coordinator = app_handle.state::<AppCoordinator>();
            coordinator.stage_closed(generation);
            // The display-sleep assertion is created when the stage presents;
            // release it here so a crash or an unexpected close can never leak
            // it (spec §52.7).
            crate::windows::sleep::release(&app_handle);
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

/// Which monitor in `fingerprints` a saved fingerprint refers to.
///
/// Exact match first; then the softer identity match, which lets a display
/// keep resolving after its twin was unplugged (ordinal shifted) — anything
/// that would otherwise be a spurious `StageDisplayMissing`. Pure so the
/// matching policy is testable without a window system.
pub fn match_display_index(fingerprints: &[String], wanted: &str) -> Option<usize> {
    if let Some(index) = fingerprints.iter().position(|f| f == wanted) {
        return Some(index);
    }
    let wanted_identity = fingerprint_identity(wanted);
    fingerprints
        .iter()
        .position(|f| fingerprint_identity(f) == wanted_identity)
}

fn resolve_monitor<R: Runtime>(
    app: &AppHandle<R>,
    fingerprint: Option<&str>,
) -> Result<Monitor, AppError> {
    let monitors = app.available_monitors()?;
    if let Some(fp) = fingerprint {
        let fingerprints = monitor_fingerprints(&monitors);
        return match_display_index(&fingerprints, fp)
            .and_then(|index| monitors.get(index).cloned())
            .ok_or(AppError::StageDisplayMissing);
    }
    app.primary_monitor()?
        .or_else(|| monitors.into_iter().next())
        .ok_or(AppError::StageDisplayMissing)
}

/// The fingerprint of the monitor a live window actually landed on, if it can
/// be determined. Used to verify the stage opened where it was asked to.
fn window_monitor_fingerprint<R: Runtime>(
    app: &AppHandle<R>,
    window: &tauri::WebviewWindow<R>,
) -> Option<String> {
    let current = window.current_monitor().ok().flatten()?;
    let monitors = app.available_monitors().ok()?;
    let fingerprints = monitor_fingerprints(&monitors);
    monitors
        .iter()
        .position(|m| same_monitor(m, &current))
        .and_then(|index| fingerprints.get(index).cloned())
}

/// Everything a stage command needs from the coordinator, read ONCE.
///
/// The previous code called `coordinator.snapshot()` twice per command — once
/// to validate the session and again to read the generation or fingerprint.
/// Between those two reads the stage can be destroyed and reopened, so a
/// command could validate against generation N and then act on N+1. One read,
/// one consistent view (M1).
#[derive(Debug, Clone)]
pub struct ActiveStage {
    pub generation: u64,
    pub session_generation: u64,
    pub display_fingerprint: Option<String>,
}

/// Generic over the runtime so `publish_stage_snapshot` can be exercised
/// against tauri's MockRuntime in `tests/session_lifecycle_tests.rs`. That test
/// is the one that asserts an emission actually HAPPENS — the suite previously
/// only ever asserted that stale payloads are dropped, which is how a stage
/// that never received a single snapshot in a packaged build stayed green.
fn require_active_stage<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
) -> Result<ActiveStage, AppError> {
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
        Some(active) if active == session_id => Ok(ActiveStage {
            generation: snapshot.stage.generation,
            session_generation: snapshot.session.session_generation,
            display_fingerprint: snapshot.stage.display_fingerprint.clone(),
        }),
        _ => Err(AppError::invalid_input(
            "The session is no longer active on the stage.",
        )
        .with_detail("sessionId", session_id)),
    }
}

/// What a `close_stage` request should do, given the coordinator's view of the
/// stage. Pure, so the policy is testable without a window system.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseDecision {
    /// The caller owns the live stage: tell it to close, then destroy it.
    Close,
    /// No session owns the stage (it crashed, or was never registered): tear
    /// down whatever window is left, but there is nothing to notify.
    Cleanup,
    /// Another session is on the stage now. Refuse.
    Refuse,
}

/// `close_stage` used to destroy the window unconditionally and then clear the
/// generation it had just read. A close that arrived late — a 4 s display-test
/// timer, a teardown from an abandoned session — therefore killed the stage
/// that a DIFFERENT session had opened in the meantime, mid-take (M1).
pub fn close_decision(stage: &crate::coordinator::StageState, session_id: &str) -> CloseDecision {
    if !stage.exists {
        return CloseDecision::Cleanup;
    }
    match stage.session_id.as_deref() {
        Some(active) if active == session_id => CloseDecision::Close,
        Some(_) => CloseDecision::Refuse,
        None => CloseDecision::Cleanup,
    }
}

pub fn close_stage<R: Runtime>(app: &AppHandle<R>, session_id: &str) -> Result<(), AppError> {
    let coordinator = app.state::<AppCoordinator>();
    let snapshot = coordinator.snapshot();
    let decision = close_decision(&snapshot.stage, session_id);

    if decision == CloseDecision::Refuse {
        return Err(AppError::structured(
            "STAGE_SESSION_MISMATCH",
            ErrorCategory::Window,
            "The stage is showing a different session.",
            true,
        )
        .with_detail("sessionId", session_id));
    }

    if let Some(window) = app.get_webview_window(STAGE_LABEL) {
        if decision == CloseDecision::Close {
            let _ = app.emit_to(
                STAGE_LABEL,
                events::STAGE_CLOSE_SESSION,
                serde_json::json!({ "sessionId": session_id }),
            );
        }
        window.destroy()?;
    }
    coordinator.stage_closed(snapshot.stage.generation);
    sleep::release(app);
    Ok(())
}

/// Present or un-present the stage (spec §43.3, §52.7).
///
/// The default presentation is BORDERLESS: the frameless window is sized to the
/// target monitor's exact bounds and pinned always-on-top. Native fullscreen is
/// an explicit opt-in (`native`), because on macOS `set_fullscreen(true)`
/// allocates a new Space, animates into it, and steals focus away from the
/// control window the operator is driving — none of which a teleprompter wants.
/// The Electron predecessor set `fullscreenable: false` and never called
/// setFullScreen once, on purpose.
pub fn set_stage_fullscreen<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
    enabled: bool,
    native: bool,
) -> Result<StageWindowState, AppError> {
    // ONE coordinator read: generation and requested display come from the
    // same consistent view, so a stage that is destroyed and reopened between
    // them cannot be validated as one generation and acted on as another (M1).
    let active = require_active_stage(app, session_id)?;
    let generation = active.generation;
    let requested_fingerprint = active.display_fingerprint.clone();
    let window = app
        .get_webview_window(STAGE_LABEL)
        .ok_or(AppError::StageDisplayMissing)?;
    let coordinator = app.state::<AppCoordinator>();

    if enabled {
        // Re-assert the monitor bounds: the display may have been rearranged
        // between open_stage and here.
        if let Some(fp) = requested_fingerprint.as_deref() {
            if let Ok(monitor) = resolve_monitor(app, Some(fp)) {
                let _ = window.set_position(tauri::Position::Physical(*monitor.position()));
                let _ = window.set_size(tauri::Size::Physical(*monitor.size()));
            }
        }
        window.set_always_on_top(true)?;
        window.show()?;
        if native {
            window.set_fullscreen(true)?;
        }
        window.set_focus().ok();
        // Block display sleep for the take: the operator deliberately stops
        // touching the keyboard for 20+ minutes, and macOS sleeps the display
        // at 10–20 (spec §52.7).
        sleep::acquire(app);
    } else {
        // Windowed stage (preview/test): still make it visible (§43.3).
        window.set_fullscreen(false)?;
        window.show()?;
        sleep::release(app);
    }

    let visible = window.is_visible().unwrap_or(false);
    let native_fullscreen = window.is_fullscreen().unwrap_or(false);
    // "fullscreen" to the rest of the app means "presenting full-screen on its
    // display", which borderless satisfies without the native flag being set.
    let fullscreen = native_fullscreen || (enabled && visible);

    // A display is not validated until the stage reports it opened on the
    // requested monitor (spec §52.7). Verify rather than assume.
    let actual_fingerprint = window_monitor_fingerprint(app, &window);
    if enabled {
        if let (Some(wanted), Some(actual)) = (&requested_fingerprint, &actual_fingerprint) {
            if wanted != actual {
                let _ = app.emit_to(
                    CONTROL_LABEL,
                    events::STAGE_ERROR,
                    serde_json::json!({
                        "stageGeneration": generation,
                        "code": "STAGE_DISPLAY_MISMATCH",
                        "message": "The stage opened on a different display than the one selected.",
                        "requestedFingerprint": wanted,
                        "actualFingerprint": actual,
                    }),
                );
            }
        }
    }

    coordinator.set_stage_visible(visible, fullscreen);
    Ok(StageWindowState {
        exists: true,
        visible,
        fullscreen,
        native_fullscreen,
        display_fingerprint: actual_fingerprint.or(requested_fingerprint),
        stage_generation: generation,
    })
}

/// Poll the monitor topology and tell control when it changes (spec §52.5).
/// Tauri 2 has no cross-platform display-topology event, so this is a cheap
/// 2 s poll executed on the main thread — enumerating monitors off the main
/// thread is not safe on macOS.
pub fn spawn_display_watcher(app: &AppHandle) {
    use std::sync::{Arc, Mutex};

    let app = app.clone();
    let last: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(2));
        let handle = app.clone();
        let last = last.clone();
        let dispatched = handle.clone().run_on_main_thread(move || {
            let Ok(displays) = list_displays(&handle) else {
                return;
            };
            let signature = topology_signature(&displays);
            let mut guard = match last.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            let changed = guard.as_deref().is_some_and(|prev| prev != signature);
            *guard = Some(signature);
            if changed {
                let _ = handle.emit_to(
                    CONTROL_LABEL,
                    events::DEVICE_OR_DISPLAY_CHANGE,
                    serde_json::json!({ "kind": "display", "displays": displays }),
                );
            }
        });
        if dispatched.is_err() {
            // The app is shutting down.
            return;
        }
    });
}

pub fn stage_status<R: Runtime>(app: &AppHandle<R>) -> StageStatus {
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
        listening: snapshot.stage.listening,
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

/* ---------------------------------------------------------------------------
 * Typed control → stage payloads (§46.6)
 *
 * These two commands used to take a bare `serde_json::Value`, which meant the
 * one path that carries the script and the reading cursor had NO argument shape
 * at all: a renamed or dropped field on the control side was invisible to
 * everything on this side, and the only guard was the four-field header check
 * below. That is exactly the surface that shipped broken.
 *
 * How the split works, and why it is not "just make every field required":
 *
 *  - The HEADER fields (`schemaVersion`, `sessionId`, `stageGeneration`,
 *    `sessionGeneration`) and the three non-negative snapshot integers stay
 *    `Option`, deserialized leniently, and are validated exactly where they
 *    always were. Their absence is load-bearing behaviour — a missing
 *    `stageGeneration` is `AppError::invalid_input("The stage payload needs a
 *    stageGeneration.")`, and a missing `schemaVersion` is "unsupported
 *    schema" — and making serde reject them would silently convert those
 *    documented errors into Tauri's generic `invalid args`, changing what
 *    control sees for the one class of failure that has already cost this
 *    project a shipped bug.
 *
 *  - The BODY fields are required and typed. Nothing validated them before, so
 *    there is no behaviour to preserve, and they are what a contract test can
 *    finally catch drifting.
 *
 *  - `rest` keeps every field neither side names (`followProfile`, anything
 *    added later) so the payload that reaches the stage is the payload
 *    control sent. A struct that dropped unknown fields here would be a much
 *    worse bug than the one being fixed.
 * ------------------------------------------------------------------------- */

/// `StageSessionEnvelope` (src/shared/contracts/display.ts) — the full
/// hydration document, as `publish_stage_document` receives it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageDocumentEnvelope {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema_version: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage_generation: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_generation: Option<u64>,
    pub script_id: String,
    pub source_hash: String,
    pub compile_revision: i64,
    /// `StageSettings`. Structure belongs to the stage; presence belongs here.
    pub stage_settings: serde_json::Value,
    /// `StageRenderDocument` — the script itself. Without it the stage has
    /// nothing to show, which is the whole point of the envelope.
    pub render_document: serde_json::Value,
    pub initial_token_index: i64,
    /// `followProfile` and anything added after this struct.
    #[serde(flatten)]
    pub rest: serde_json::Map<String, serde_json::Value>,
}


/// The header every control→stage payload MUST carry (M1).
///
/// `schemaVersion`, `sessionId` and `stageGeneration` used to be read with
/// `if let Some(...)`, so a payload that simply omitted `stageGeneration`
/// skipped the staleness check entirely — the one thing a caller trying to
/// reach a stage it no longer owns would do. A missing field is now a
/// rejection, not a pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeaderVerdict {
    Accept,
    /// Stale generation: dropped silently, per spec §43.5.
    Drop,
}

pub fn validate_stage_payload_header(
    payload: &serde_json::Value,
    session_id: &str,
    stage_generation: u64,
    session_generation: u64,
    stale_is_error: bool,
) -> Result<HeaderVerdict, AppError> {
    if payload.get("schemaVersion").and_then(|v| v.as_u64()) != Some(1) {
        return Err(AppError::invalid_input(
            "The stage payload has an unsupported schema.",
        ));
    }
    match payload.get("sessionId").and_then(|v| v.as_str()) {
        Some(id) if id == session_id => {}
        _ => {
            return Err(AppError::invalid_input(
                "The stage payload targets another session.",
            ))
        }
    }
    let payload_generation = payload
        .get("stageGeneration")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| {
            AppError::invalid_input("The stage payload needs a stageGeneration.")
        })?;
    if payload_generation != stage_generation {
        return if stale_is_error {
            Err(AppError::invalid_input(
                "The stage payload targets a stale stage generation.",
            ))
        } else {
            Ok(HeaderVerdict::Drop)
        };
    }
    // A session generation, when carried, must also be current. Unlike the
    // stage generation this one is genuinely optional in the contract.
    if let Some(payload_session_generation) =
        payload.get("sessionGeneration").and_then(|v| v.as_u64())
    {
        if payload_session_generation != session_generation {
            return Ok(HeaderVerdict::Drop);
        }
    }
    Ok(HeaderVerdict::Accept)
}

/// Whether a stage document envelope may be emitted.
///
/// C4: `publish_stage_document` used to call `validate_stage_payload_header`
/// with a bare `?` and discard the `HeaderVerdict` it returns, so a `Drop` — an
/// envelope carrying a session generation that is no longer current — was
/// emitted to the stage anyway. `publish_stage_snapshot` honours the same
/// verdict, so the two commands disagreed about what a stale generation means.
/// The decision lives here, on its own, where it can be tested without a
/// window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublishPlan {
    Emit,
    /// Stale: dropped silently, per spec §43.5.
    DropSilently,
}

pub fn plan_stage_document_publish(
    document_envelope: &serde_json::Value,
    session_id: &str,
    stage_generation: u64,
    session_generation: u64,
) -> Result<PublishPlan, AppError> {
    let serialized = serde_json::to_vec(document_envelope)
        .map_err(|e| AppError::Internal(format!("envelope serialize: {e}")))?;
    if serialized.len() > MAX_STAGE_DOCUMENT_BYTES {
        return Err(AppError::invalid_input("The stage document is too large."));
    }
    match validate_stage_payload_header(
        document_envelope,
        session_id,
        stage_generation,
        session_generation,
        true,
    )? {
        HeaderVerdict::Accept => Ok(PublishPlan::Emit),
        HeaderVerdict::Drop => Ok(PublishPlan::DropSilently),
    }
}

pub fn publish_stage_document<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
    document_envelope: serde_json::Value,
) -> Result<StageAck, AppError> {
    let active = require_active_stage(app, session_id)?;
    let plan = plan_stage_document_publish(
        &document_envelope,
        session_id,
        active.generation,
        active.session_generation,
    )?;
    // A dropped document is not an error (spec §43.5); it is an ack that says
    // `accepted: false`, so control can see its envelope did not land.
    if plan == PublishPlan::DropSilently {
        return Ok(StageAck {
            accepted: false,
            stage_generation: active.generation,
            session_id: Some(session_id.to_string()),
        });
    }
    // Remember it BEFORE emitting: the stage may not be listening yet, and
    // this is the only copy Rust will ever have. See the field comment on
    // `AppCoordinator::pending_document`.
    //
    // A refusal means the window was destroyed between `require_active_stage`
    // reading its snapshot and this line. Emitting anyway would hand the
    // document to whatever now answers to the label, so this reports the same
    // `accepted: false` a stale generation does.
    if !app
        .state::<AppCoordinator>()
        .store_stage_document(active.generation, document_envelope.clone())
    {
        return Ok(StageAck {
            accepted: false,
            stage_generation: active.generation,
            session_id: Some(session_id.to_string()),
        });
    }
    app.emit_to(STAGE_LABEL, events::STAGE_LOAD_SESSION, &document_envelope)?;
    Ok(StageAck {
        accepted: true,
        stage_generation: active.generation,
        session_id: Some(session_id.to_string()),
    })
}

/// Re-send the current stage's envelope, if one is being held.
///
/// Called when the stage announces its subscriptions are live. Both orderings
/// are normal and both are covered: the stage may come up before control
/// publishes (nothing is held, and the ordinary emit lands on a listening
/// window), or after (the emit was lost, and this is what recovers it).
pub fn replay_stage_document<R: Runtime>(app: &AppHandle<R>) -> bool {
    let Some((_generation, envelope)) = app.state::<AppCoordinator>().stage_document_for_replay()
    else {
        return false;
    };
    app.emit_to(STAGE_LABEL, events::STAGE_LOAD_SESSION, &envelope)
        .is_ok()
}

/// The bytes that reach the stage — every field, in or out of the struct.
fn to_payload_value<T: Serialize>(payload: &T, what: &str) -> Result<serde_json::Value, AppError> {
    serde_json::to_value(payload)
        .map_err(|e| AppError::Internal(format!("{what} serialize: {e}")))
}

impl StageDocumentEnvelope {
    pub fn into_value(self) -> Result<serde_json::Value, AppError> {
        to_payload_value(&self, "envelope")
    }
}

/// Allow-listed stage directive kinds (StageDirective in
/// src/shared/contracts/stage.ts). Control translates high-level command
/// actions into these small imperative directives; the stage never receives
/// raw command actions.
const ALLOWED_STAGE_DIRECTIVES: &[&str] = &[
    "blank",
    "freeze",
    "ack",
    "settings",
    "calibration",
    "diagnostics",
    // The recogniser's own words for the stage's transcript bar. It used to
    // reach the stage as a direct `emitTo` from the control webview and, on a
    // real rig, never arrived — while snapshots emitted from HERE reached the
    // same window in the same seconds. It travels the proven road now.
    "transcript",
    // Same failure class as the transcript: this status readout was produced
    // by control and disappeared on the direct webview-to-webview event road.
    "voicePill",
    // Voice following switched on or off (§48). The stage cannot infer this
    // from the snapshots stopping: an absence is indistinguishable from a
    // presenter who has gone quiet until the staleness window expires, and for
    // those seconds the script would keep drifting on prediction — which is the
    // exact thing the switch was flipped to stop.
    "follow",
    // The fixed-pace transport — the fallback for a take voice following
    // cannot carry. It travels the same proven road for the same reason, and
    // it is generation-checked on both ends because unlike the two above it
    // MOVES the document.
    "autoScroll",
];

/// Validate a `StageStatePayload` ({ stageGeneration, directive }) against
/// the live stage generation. Returns Ok(None) for silently dropped stale
/// generations (spec §43.5) and Ok(Some(payload)) when it may be emitted.
fn validate_stage_directive(
    generation: u64,
    payload: &serde_json::Value,
) -> Result<bool, AppError> {
    let directive_kind = payload
        .get("directive")
        .and_then(|d| d.get("kind"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::invalid_input("A stage directive needs a kind."))?;
    if !ALLOWED_STAGE_DIRECTIVES.contains(&directive_kind) {
        return Err(AppError::invalid_input(format!(
            "Unknown stage directive kind: {directive_kind}"
        )));
    }
    match payload.get("stageGeneration").and_then(|v| v.as_u64()) {
        Some(payload_generation) if payload_generation == generation => Ok(true),
        Some(_) => Ok(false), // stale generation: dropped silently (§43.5)
        None => Err(AppError::invalid_input(
            "A stage directive needs a stageGeneration.",
        )),
    }
}

pub fn publish_stage_command<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
    action: serde_json::Value,
) -> Result<(), AppError> {
    let active = require_active_stage(app, session_id)?;
    if !validate_stage_directive(active.generation, &action)? {
        return Ok(());
    }
    app.state::<AppCoordinator>()
        .store_stage_directive(active.generation, &action);
    app.emit_to(STAGE_LABEL, events::STAGE_APPLY_COMMAND, &action)?;
    Ok(())
}

pub fn replay_stage_live<R: Runtime>(app: &AppHandle<R>, generation: u64) -> bool {
    let Some(payload) = app
        .state::<AppCoordinator>()
        .stage_live_for_replay(generation)
    else {
        return false;
    };
    app.emit_to(STAGE_LABEL, events::STAGE_LIVE_SYNC, payload)
        .is_ok()
}

// ---------------------------------------------------------------------------
// Display profiles (spec §46.6 save_display_profile, table display_profiles)
// ---------------------------------------------------------------------------

/// Twin of `DisplayProfile` (src/shared/contracts/display.ts). The stage
/// settings are carried as a validated JSON document.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayProfile {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_fingerprint: Option<String>,
    pub stage: serde_json::Value,
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
            (id, name, display_fingerprint, stage_settings_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            display_fingerprint = excluded.display_fingerprint,
            stage_settings_json = excluded.stage_settings_json,
            updated_at = excluded.updated_at",
    )
    .bind(&id)
    .bind(profile.name.trim())
    .bind(&profile.display_fingerprint)
    .bind(serde_json::to_string(&profile.stage).unwrap_or_else(|_| "{}".into()))
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
        "SELECT id, name, display_fingerprint, stage_settings_json, updated_at
         FROM display_profiles ORDER BY updated_at DESC",
    )
    .fetch_all(pool)
    .await?;
    rows.iter()
        .map(|row| {
            let stage_json: String = row.try_get("stage_settings_json")?;
            Ok(DisplayProfile {
                id: Some(row.try_get("id")?),
                name: row.try_get("name")?,
                display_fingerprint: row.try_get("display_fingerprint")?,
                stage: serde_json::from_str(&stage_json).unwrap_or(serde_json::Value::Null),
                updated_at: row.try_get("updated_at")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The TS side of the protocol lives in src/shared/contracts/stage.ts;
    /// every event name Rust emits or listens for must appear there verbatim
    /// (and vice versa for the stage:// namespace).
    #[test]
    fn stage_event_names_match_ts_contract() {
        let ts = include_str!("../../../src/shared/contracts/stage.ts");
        let rust_names = [
            events::STAGE_READY,
            events::STAGE_CLOSED,
            events::STAGE_ERROR,
            events::IDENTIFY_DISPLAYS,
            events::SCRIPT_EXTERNAL_CHANGE,
            events::DEVICE_OR_DISPLAY_CHANGE,
            events::DIAGNOSTIC_WARNING,
            events::STAGE_LOAD_SESSION,
            events::STAGE_APPLY_COMMAND,
            events::STAGE_CLOSE_SESSION,
            events::STAGE_HEARTBEAT,
            events::STAGE_TRANSCRIPT_TAP,
            events::STAGE_VOICE_PILL,
            events::STAGE_ALIGNMENT_SNAPSHOT,
            events::STAGE_VIEWPORT_HINT,
            events::STAGE_LISTENING,
            events::STAGE_SYNC_REQUEST,
            events::STAGE_LIVE_SYNC,
            events::STAGE_HYDRATED,
            events::STAGE_LAYOUT_READY,
            events::STAGE_HEARTBEAT_ACK,
            events::STAGE_MEDIA_ERROR,
            events::STAGE_ESCAPE_PRESSED,
            events::STAGE_MOTION_REPORT,
            events::STAGE_LAYOUT_ERROR,
            events::STAGE_ESCAPE_REQUESTED,
            events::STAGE_MOTION_ACK,
            events::STAGE_LAYOUT_FAILED,
            events::STAGE_INTENT,
        ];
        for name in rust_names {
            assert!(
                ts.contains(&format!("'{name}'")),
                "event name {name} is missing from src/shared/contracts/stage.ts"
            );
        }
        // And every stage:// literal in the TS contract must be a Rust const.
        for line in ts.lines() {
            if let Some(start) = line.find("'stage://") {
                let rest = &line[start + 1..];
                if let Some(end) = rest.find('\'') {
                    let ts_name = &rest[..end];
                    assert!(
                        rust_names.contains(&ts_name),
                        "TS event name {ts_name} has no Rust constant"
                    );
                }
            }
        }
    }

    /// S1: a webview `emit` is a BROADCAST. Tauri's manager delivers it to
    /// every webview's JS listeners AND to the Rust `listen_any` handlers, and
    /// a JS listener registered with the default `Any` target matches
    /// regardless of what the emitter targeted (`match_any_or_filter` in
    /// tauri/src/event/listener.rs) — so no `emitTo` can exclude control.
    ///
    /// The only defence is name separation: what the stage emits and what the
    /// bridge relays to control must never be the same string, or control's
    /// handler runs twice, and the first run bypasses the generation check.
    #[test]
    fn no_relayed_control_event_reuses_a_name_the_stage_emits() {
        let emitted_by_stage = [
            events::STAGE_LISTENING,
            events::STAGE_SYNC_REQUEST,
            events::STAGE_HYDRATED,
            events::STAGE_LAYOUT_READY,
            events::STAGE_HEARTBEAT_ACK,
            events::STAGE_MEDIA_ERROR,
            events::STAGE_ESCAPE_PRESSED,
            events::STAGE_MOTION_REPORT,
            events::STAGE_LAYOUT_ERROR,
        ];
        let relayed_to_control = [
            events::STAGE_READY,
            events::STAGE_ERROR,
            events::STAGE_ESCAPE_REQUESTED,
            events::STAGE_MOTION_ACK,
            events::STAGE_LAYOUT_FAILED,
        ];
        for relayed in relayed_to_control {
            assert!(
                !emitted_by_stage.contains(&relayed),
                "{relayed} is both emitted by the stage and relayed to control; \
                 control would receive it twice, the first time ungated (S1)"
            );
        }

        // And the bridge must listen for the stage's names, not the relayed
        // ones — listening for a relayed name would make the relay re-trigger
        // itself.
        let app_rs = include_str!("../app.rs");
        for name in [
            "STAGE_ESCAPE_PRESSED",
            "STAGE_MOTION_REPORT",
            "STAGE_LAYOUT_ERROR",
        ] {
            assert!(
                app_rs.contains(&format!("listen_any(events::{name}")),
                "the stage event bridge must listen for events::{name}"
            );
        }
        for name in [
            "STAGE_ESCAPE_REQUESTED",
            "STAGE_MOTION_ACK",
            "STAGE_LAYOUT_FAILED",
        ] {
            assert!(
                !app_rs.contains(&format!("listen_any(events::{name}")),
                "events::{name} is a control-facing name; listening for it here \
                 would relay the stage's own broadcast a second time"
            );
        }
    }

    #[test]
    fn stage_directive_validation_accepts_live_generation_only() {
        let live = serde_json::json!({
            "stageGeneration": 4,
            "directive": { "kind": "blank", "blanked": true }
        });
        assert!(validate_stage_directive(4, &live).unwrap());

        // Stale generation: silently dropped, not an error (§43.5).
        assert!(!validate_stage_directive(5, &live).unwrap());

        let unknown = serde_json::json!({
            "stageGeneration": 4,
            "directive": { "kind": "explode" }
        });
        assert!(validate_stage_directive(4, &unknown).is_err());

        let missing_generation = serde_json::json!({
            "directive": { "kind": "freeze", "frozen": true }
        });
        assert!(validate_stage_directive(4, &missing_generation).is_err());
    }

    /// Every kind the TypeScript `StageDirective` union can produce has to be
    /// on the allow-list, or control raises an error at the moment somebody
    /// uses the feature. The follow switch is the one this caught: the whole
    /// path was built, typechecked and unit-tested, and would have failed here
    /// the first time a presenter switched following off on a real rig.
    #[test]
    fn stage_directive_allow_list_covers_the_follow_switch() {
        let follow = serde_json::json!({
            "stageGeneration": 4,
            "directive": { "kind": "follow", "paused": true }
        });
        assert!(validate_stage_directive(4, &follow).unwrap());
    }

    // -----------------------------------------------------------------
    // M2: stage privilege — CSP and asset scope
    // -----------------------------------------------------------------

    /// The stage inherited the GLOBAL csp, which used to allow the speech
    /// provider's origin for the control window. That handed the minimally
    /// privileged window — the one that renders the operator's script — a live
    /// route to a third party, contradicting §43.2/§50.10. stage.html carries
    /// its own policy; CSP composes restrictively, so the stage gets the
    /// intersection.
    ///
    /// Neither window needs an external origin now: the Inworld socket is held
    /// in Rust (it needs an `Authorization` header the browser cannot send), so
    /// the global policy dropped the provider host too. This test asserts both
    /// halves, because the interesting failure is a future change re-opening
    /// the control window's network and quietly widening the stage with it.
    #[test]
    fn stage_csp_grants_no_network() {
        let html = include_str!("../../../stage.html");
        let start = html
            .find("http-equiv=\"Content-Security-Policy\"")
            .expect("stage.html must carry its own CSP (M2)");
        let content_start = html[start..]
            .find("content=\"")
            .map(|i| start + i + "content=\"".len())
            .expect("the CSP meta tag needs a content attribute");
        let csp = &html[content_start..content_start
            + html[content_start..]
                .find('"')
                .expect("unterminated CSP content")];

        let connect = csp
            .split(';')
            .map(str::trim)
            .find(|d| d.starts_with("connect-src"))
            .expect("the stage CSP must pin connect-src explicitly");
        assert!(
            !connect.contains("api.inworld.ai"),
            "the stage must have no route to the provider: {connect}"
        );
        assert!(
            !connect.contains('*'),
            "the stage's connect-src must not contain a wildcard: {connect}"
        );
        for host in ["https:", "http://localhost", "ws:", "wss:"] {
            assert!(
                !connect.contains(host),
                "the stage's connect-src must not allow {host}: {connect}"
            );
        }
        for directive in ["object-src 'none'", "frame-src 'none'", "base-uri 'none'"] {
            assert!(csp.contains(directive), "the stage CSP must set {directive}");
        }

        // And no window reaches the provider from JavaScript at all: the
        // session is Rust's. A `connect-src` naming any remote host in the
        // global policy means somebody moved the socket back into the webview,
        // which cannot work — the key travels in a header the browser will not
        // send — and would put the key in the renderer on the way to finding
        // that out.
        let config = include_str!("../../tauri.conf.json");
        let global_csp = config
            .split("\"csp\": \"")
            .nth(1)
            .and_then(|rest| rest.split('"').next())
            .expect("the global CSP must be present");
        let global_connect = global_csp
            .split(';')
            .map(str::trim)
            .find(|d| d.starts_with("connect-src"))
            .expect("the global CSP must pin connect-src explicitly");
        for host in ["api.inworld.ai", "api.openai.com", "https:", "wss:"] {
            assert!(
                !global_connect.contains(host),
                "no window may reach {host} from JavaScript: {global_connect}"
            );
        }
    }

    /// The asset-protocol scope used to be `$APPDATA/scripts/**`, so every
    /// canonical `script.md` and every revision file was reachable over
    /// `asset://` — by the stage, among others.
    #[test]
    fn the_asset_scope_exposes_media_only() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json")).expect("config parses");
        let scope = &config["app"]["security"]["assetProtocol"]["scope"];

        let allow: Vec<&str> = scope["allow"]
            .as_array()
            .expect("the scope must use the allow/deny form")
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert!(
            !allow.iter().any(|p| p.starts_with("$APPDATA/scripts")
                && !p.contains("/assets/")),
            "a script-root pattern that is not confined to assets exposes \
             canonical Markdown and revisions: {allow:?}"
        );
        assert!(
            allow.contains(&"$APPDATA/scripts/*/assets/*"),
            "the per-script assets directory must still be reachable: {allow:?}"
        );

        let deny: Vec<&str> = scope["deny"]
            .as_array()
            .expect("the scope must declare a deny list")
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        // `deny` beats `allow` AND beats any runtime `allow_directory`, so
        // these are the floor a future widening cannot lift.
        for required in [
            "$APPDATA/scripts/*/script.md",
            "$APPDATA/scripts/*/revisions/**",
            "$APPDATA/candidcue.sqlite3*",
        ] {
            assert!(
                deny.contains(&required),
                "the asset scope must explicitly deny {required}: {deny:?}"
            );
        }
    }

    // -----------------------------------------------------------------
    // M1: stale-stage protection
    // -----------------------------------------------------------------

    /// The defect: `stageGeneration` was validated only when PRESENT
    /// (`if let Some(...)`), so a payload that simply omitted it skipped the
    /// staleness check entirely — the exact thing a caller aiming at a stage it
    /// no longer owns would send.
    #[test]
    fn a_stage_payload_without_a_generation_is_refused() {
        let no_generation = serde_json::json!({
            "schemaVersion": 1,
            "sessionId": "s-1",
        });
        let err = validate_stage_payload_header(&no_generation, "s-1", 7, 1, true)
            .expect_err("a missing stageGeneration must be an error, not a pass");
        assert_eq!(err.code(), "VALIDATION_FAILED");

        // ...and for the silent-drop caller too: a missing generation is still
        // an error there, because "drop silently" is only correct for a
        // generation that is present and stale.
        assert!(validate_stage_payload_header(&no_generation, "s-1", 7, 1, false).is_err());
    }

    #[test]
    fn a_stage_payload_header_accepts_only_the_live_generation_and_session() {
        let live = serde_json::json!({
            "schemaVersion": 1,
            "sessionId": "s-1",
            "stageGeneration": 7,
            "sessionGeneration": 3,
        });
        assert_eq!(
            validate_stage_payload_header(&live, "s-1", 7, 3, true).unwrap(),
            HeaderVerdict::Accept
        );

        // Stale stage generation: an error for documents, a silent drop for
        // high-rate snapshots (spec §43.5).
        let stale = serde_json::json!({
            "schemaVersion": 1,
            "sessionId": "s-1",
            "stageGeneration": 6,
        });
        assert!(validate_stage_payload_header(&stale, "s-1", 7, 3, true).is_err());
        assert_eq!(
            validate_stage_payload_header(&stale, "s-1", 7, 3, false).unwrap(),
            HeaderVerdict::Drop
        );

        // Stale session generation is always a silent drop.
        let old_session = serde_json::json!({
            "schemaVersion": 1,
            "sessionId": "s-1",
            "stageGeneration": 7,
            "sessionGeneration": 2,
        });
        assert_eq!(
            validate_stage_payload_header(&old_session, "s-1", 7, 3, true).unwrap(),
            HeaderVerdict::Drop
        );

        // Another session's payload, and an unsupported schema, are refused.
        assert!(validate_stage_payload_header(&live, "s-2", 7, 3, true).is_err());
        let bad_schema = serde_json::json!({
            "schemaVersion": 2,
            "sessionId": "s-1",
            "stageGeneration": 7,
        });
        assert!(validate_stage_payload_header(&bad_schema, "s-1", 7, 3, true).is_err());
    }

    /// C4: `publish_stage_document` computed the header verdict and threw it
    /// away, so a `Drop` still reached the stage — while `publish_stage_snapshot`
    /// honoured the identical verdict. The two commands must agree.
    ///
    /// This test fails if the `Drop` arm is reverted to an unconditional emit:
    /// the stale-session envelope would plan `Emit`.
    #[test]
    fn a_stale_session_document_is_not_published() {
        let live = serde_json::json!({
            "schemaVersion": 1,
            "sessionId": "s-1",
            "stageGeneration": 7,
            "sessionGeneration": 3,
        });
        assert_eq!(
            plan_stage_document_publish(&live, "s-1", 7, 3).unwrap(),
            PublishPlan::Emit
        );

        // Same envelope, a session generation that has moved on. The snapshot
        // path drops this; the document path used to publish it.
        assert_eq!(
            plan_stage_document_publish(&live, "s-1", 7, 4).unwrap(),
            PublishPlan::DropSilently
        );
        assert_eq!(
            validate_stage_payload_header(&live, "s-1", 7, 4, false).unwrap(),
            HeaderVerdict::Drop,
            "the two commands must reach the same verdict for the same envelope"
        );

        // A stale STAGE generation stays an error for documents (unchanged).
        let stale_stage = serde_json::json!({
            "schemaVersion": 1,
            "sessionId": "s-1",
            "stageGeneration": 6,
            "sessionGeneration": 3,
        });
        assert!(plan_stage_document_publish(&stale_stage, "s-1", 7, 3).is_err());

        // Oversize is still rejected before anything else is decided.
        let huge = serde_json::json!({
            "schemaVersion": 1,
            "sessionId": "s-1",
            "stageGeneration": 7,
            "blocks": "x".repeat(MAX_STAGE_DOCUMENT_BYTES + 1),
        });
        assert!(plan_stage_document_publish(&huge, "s-1", 7, 3).is_err());
    }

    /// The defect: `close_stage` destroyed the window unconditionally. A close
    /// that arrived late — an abandoned display test's 4 s timer, a teardown
    /// from a session that already ended — killed the stage that a DIFFERENT
    /// session had opened in the meantime, mid-take.
    #[test]
    fn close_only_destroys_the_stage_its_own_session_owns() {
        use crate::coordinator::StageState;

        let live_for_a = StageState {
            exists: true,
            session_id: Some("session-a".into()),
            generation: 4,
            ..Default::default()
        };
        assert_eq!(close_decision(&live_for_a, "session-a"), CloseDecision::Close);
        assert_eq!(
            close_decision(&live_for_a, "session-b"),
            CloseDecision::Refuse,
            "a close from a session that no longer owns the stage must be refused"
        );

        // Nothing registered: whatever window is left is an orphan, so tearing
        // it down is right regardless of who asks.
        let closed = StageState {
            exists: false,
            session_id: Some("session-a".into()),
            generation: 4,
            ..Default::default()
        };
        assert_eq!(close_decision(&closed, "session-b"), CloseDecision::Cleanup);

        let unowned = StageState {
            exists: true,
            session_id: None,
            generation: 4,
            ..Default::default()
        };
        assert_eq!(close_decision(&unowned, "anything"), CloseDecision::Cleanup);
    }

    /// A stage can no longer be opened with no owning session: the field is
    /// mandatory, so `close_decision` and every generation check downstream
    /// always have something to compare against.
    #[test]
    fn opening_a_stage_requires_a_session_id() {
        let complete: OpenStageRequest = serde_json::from_value(serde_json::json!({
            "displayFingerprint": "dsp-0123456789abcdef",
            "sessionId": "session-a",
        }))
        .expect("a complete request parses");
        assert_eq!(complete.session_id, "session-a");

        assert!(
            serde_json::from_value::<OpenStageRequest>(serde_json::json!({
                "displayFingerprint": "dsp-0123456789abcdef"
            }))
            .is_err(),
            "an open request with no sessionId must be refused at the boundary"
        );
        assert!(
            serde_json::from_value::<OpenStageRequest>(serde_json::json!({
                "sessionId": serde_json::Value::Null
            }))
            .is_err(),
            "a null sessionId is not a session id"
        );

        // The display is genuinely optional: no fingerprint means "primary".
        let primary: OpenStageRequest =
            serde_json::from_value(serde_json::json!({ "sessionId": "session-a" }))
                .expect("display is optional");
        assert!(primary.display_fingerprint.is_none());
    }

    #[test]
    fn fingerprint_is_stable_and_distinct() {
        let a1 = display_fingerprint(Some("DELL U2720Q"), 3840, 2160, 0);
        let a2 = display_fingerprint(Some("DELL U2720Q"), 3840, 2160, 0);
        assert_eq!(a1, a2);
        assert!(a1.starts_with("dsp-"));
        assert_eq!(a1.len(), 4 + 16);

        // A different panel is a different fingerprint.
        let other = display_fingerprint(Some("LG ULTRAFINE"), 3840, 2160, 0);
        assert_ne!(a1, other);

        // Resolution change is a genuine identity change (the media geometry
        // the stage was configured against no longer holds).
        let resized = display_fingerprint(Some("DELL U2720Q"), 2560, 1440, 0);
        assert_ne!(a1, resized);

        // Unnamed generic display still yields a usable fingerprint.
        let generic = display_fingerprint(None, 1024, 600, 0);
        assert!(generic.starts_with("dsp-"));
        assert_ne!(generic, a1);
    }

    /// The regression this pins: position and scale factor USED to be folded
    /// into the fingerprint, so dragging a monitor in System Settings ▸
    /// Displays ▸ Arrange — or docking a laptop, or changing the scaling —
    /// silently invalidated every saved display profile and turned a
    /// configured stage display into StageDisplayMissing.
    #[test]
    fn fingerprint_survives_rearranging_and_rescaling_displays() {
        let home = display_fingerprint(Some("DELL U2720Q"), 3840, 2160, 0);

        // Dragged to the right of the primary in Arrange: same panel.
        let rearranged = display_fingerprint(Some("DELL U2720Q"), 3840, 2160, 0);
        assert_eq!(home, rearranged);

        // Only the SOFT topology hash notices the move and the rescale.
        let before = display_topology_hash(Some("DELL U2720Q"), 3840, 2160, 2.0, 0, 0);
        let moved = display_topology_hash(Some("DELL U2720Q"), 3840, 2160, 2.0, 3840, 0);
        let rescaled = display_topology_hash(Some("DELL U2720Q"), 3840, 2160, 1.0, 0, 0);
        assert_ne!(before, moved);
        assert_ne!(before, rescaled);
        // ...and it is never mistaken for an identity.
        assert!(before.starts_with("top-"));
    }

    #[test]
    fn identical_twin_panels_stay_distinguishable() {
        let first = display_fingerprint(Some("DELL U2720Q"), 3840, 2160, 0);
        let second = display_fingerprint(Some("DELL U2720Q"), 3840, 2160, 1);
        assert_ne!(first, second);
        // Both still resolve back to one shared identity.
        assert_eq!(fingerprint_identity(&first), fingerprint_identity(&second));
        // The unique case carries no ordinal suffix at all.
        assert_eq!(fingerprint_identity(&first), first);
    }

    #[test]
    fn saved_profiles_resolve_through_the_soft_identity_fallback() {
        let twin_a = display_fingerprint(Some("DELL U2720Q"), 3840, 2160, 0);
        let twin_b = display_fingerprint(Some("DELL U2720Q"), 3840, 2160, 1);
        let laptop = display_fingerprint(Some("Built-in Retina Display"), 3456, 2234, 0);

        let both = vec![laptop.clone(), twin_a.clone(), twin_b.clone()];
        assert_eq!(match_display_index(&both, &twin_b), Some(2));
        assert_eq!(match_display_index(&both, &laptop), Some(0));

        // One twin unplugged: the profile saved against the SECOND one still
        // resolves to the surviving identical panel instead of blowing up
        // with StageDisplayMissing.
        let one_twin = vec![laptop.clone(), twin_a.clone()];
        assert_eq!(match_display_index(&one_twin, &twin_b), Some(1));

        // A display that is genuinely gone still reports missing.
        assert_eq!(match_display_index(&one_twin, "dsp-0123456789abcdef"), None);
    }

    #[test]
    fn topology_signature_tracks_arrangement_not_just_membership() {
        let make = |x: i32| DisplayDescriptor {
            id: "display-0".into(),
            name: Some("DELL U2720Q".into()),
            physical_position: PhysicalPoint { x, y: 0 },
            physical_size: PhysicalDimensions {
                width: 3840,
                height: 2160,
            },
            scale_factor: 2.0,
            logical_size: LogicalDimensions {
                width: 1920.0,
                height: 1080.0,
            },
            primary: true,
            fingerprint: display_fingerprint(Some("DELL U2720Q"), 3840, 2160, 0),
            topology_hash: display_topology_hash(Some("DELL U2720Q"), 3840, 2160, 2.0, x, 0),
        };
        assert_eq!(topology_signature(&[make(0)]), topology_signature(&[make(0)]));
        assert_ne!(topology_signature(&[make(0)]), topology_signature(&[make(3840)]));
    }
}
