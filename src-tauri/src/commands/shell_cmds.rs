//! Desktop-shell commands: the native menu's state, the window's identity, and
//! where the window sits (desktop refinement §5, §6, §20.4).
//!
//! These exist because three things a desktop application is judged on cannot be
//! done from a webview at all:
//!
//!   - a menu bar that reflects what the app can do RIGHT NOW;
//!   - a window title that names the open document;
//!   - a window that reopens where it was left.
//!
//! All three are one-way pushes from the frontend, which owns the state that
//! decides them. None of them read anything back: a command here that answered
//! "what is the title" would be a second copy of a fact the frontend already
//! holds, and the two would drift.

use serde::{Deserialize, Serialize};
use tauri::{LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize};

use crate::errors::AppError;
use crate::menu::{self, MenuItemState};
use crate::scripts::DataPaths;
use crate::windows::CONTROL_LABEL;

/// Push enabled/checked/label state for native menu items.
///
/// Called on every route change, session transition and editor state change. The
/// batch is applied wholesale rather than diffed: the frontend sends the state
/// of every command it knows about, so a stale item cannot survive by simply not
/// appearing in an update.
#[tauri::command]
pub fn set_menu_state(app: tauri::AppHandle, items: Vec<MenuItemState>) -> Result<(), AppError> {
    menu::apply_state(&app, &items);
    Ok(())
}

/// Set the control window's native title.
///
/// The window's title is the app's identity in the task switcher, in Mission
/// Control, in the Windows taskbar and in the macOS Window menu. A static
/// "CandidCue" there tells a user with three things open nothing at all, which
/// is why `document-title.ts` keeps this in step with the open script.
///
/// `edited` maps to the macOS document-modified dot — the small grey dot in the
/// close button that every native document app uses to mean "there is unsaved
/// work here". It is a no-op elsewhere; Windows has no equivalent convention and
/// faking one with a title suffix would be worse than saying nothing.
#[tauri::command]
pub fn set_window_title<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    title: String,
    edited: Option<bool>,
) -> Result<(), AppError> {
    let Some(window) = app.get_webview_window(CONTROL_LABEL) else {
        // Not an error. The one caller runs on every route change, and a window
        // that has gone away is a window that is closing — reporting a failure
        // there would raise a toast on a screen that is being torn down.
        return Ok(());
    };
    window
        .set_title(&title)
        .map_err(|e| AppError::Internal(format!("the window title could not be set: {e}")))?;

    #[cfg(target_os = "macos")]
    if let Some(edited) = edited {
        macos_document_edited::set(&window, edited);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = edited;

    Ok(())
}

/// The macOS document-modified dot, through raw `objc_msgSend`.
///
/// Raw FFI rather than an `objc2` dependency, matching `windows/present.rs` and
/// `windows/sleep.rs` — this is one selector taking one `BOOL`, and adding a
/// crate to the tree for it would be out of proportion to the call.
#[cfg(target_os = "macos")]
mod macos_document_edited {
    use std::ffi::{c_char, c_void};

    #[link(name = "objc", kind = "dylib")]
    extern "C-unwind" {
        fn sel_registerName(name: *const c_char) -> *const c_void;
        fn objc_msgSend();
    }

    /// `BOOL` is passed as `i8` for the reason `present.rs` spells out: it is
    /// `signed char` on Intel and `_Bool` on arm64, and `i8` is correct on both.
    unsafe fn msg_with_bool(receiver: *mut c_void, selector: *const c_void, value: i8) {
        let send: extern "C-unwind" fn(*mut c_void, *const c_void, i8) =
            std::mem::transmute(objc_msgSend as *const ());
        send(receiver, selector, value)
    }

    /// Set (or clear) the dot in the window's close button.
    ///
    /// Hopped onto the main thread, because AppKit window mutation is
    /// main-thread-only and a Tauri command runs on the async runtime. Every
    /// failure is swallowed and logged: the title itself has already changed by
    /// the time this runs, so the worst outcome is a missing dot.
    pub fn set<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>, edited: bool) {
        /*
         * THE WINDOW IS CLONED INTO THE CLOSURE; THE POINTER IS NOT.
         *
         * The first version of this read `ns_window()` here, cast the result to
         * `usize` to get past `Send`, and dereferenced it on the main thread.
         * That is a use-after-free waiting to happen: `run_on_main_thread`
         * QUEUES the closure, so between the read and the run the window can be
         * closed and the NSWindow deallocated — and casting a pointer to an
         * integer launders away the `Send` check without making any of it safe.
         *
         * `WebviewWindow` is a refcounted handle, so cloning it into the closure
         * keeps the window alive until the closure runs and lets the pointer be
         * read on the thread that is allowed to use it. This is the pattern
         * `windows/present.rs` already uses for its style-mask work.
         */
        let window = window.clone();
        let result = window.clone().run_on_main_thread(move || {
            let Ok(ns_window) = window.ns_window() else {
                tracing::debug!("no NSWindow; skipping the document-modified dot");
                return;
            };
            if ns_window.is_null() {
                return;
            }
            // SAFETY: `ns_window()` returns this window's own NSWindow, read on
            // the main thread from a handle that is keeping the window alive for
            // the duration of this closure. `setDocumentEdited:` is a plain BOOL
            // setter declared on NSWindow.
            unsafe {
                // No cast: `ns_window()` already returns `*mut c_void`, and
                // spelling it out again is what clippy 1.97 started flagging.
                msg_with_bool(
                    ns_window,
                    sel_registerName(c"setDocumentEdited:".as_ptr()),
                    i8::from(edited),
                );
            }
        });
        if let Err(err) = result {
            tracing::debug!(error = %err, "the document-modified dot could not be set");
        }
    }
}

/// Tell Rust which script a dropped image belongs to (§11.9, §20.2).
///
/// Pushed by the editor when it opens a script and cleared when it leaves. See
/// `windows::drag_drop::DropTargetScript` for why Rust has to be told, and why
/// a script id — a UUID the repository resolves to a path itself — does not
/// reopen the "no path from JavaScript" hole this app closed.
///
/// The id is NOT validated here. It is validated at the moment it is used, by
/// `ScriptId::parse` inside the drop handler, which is the only place it can
/// matter — and validating a stale id at registration time would reject a script
/// that has since been deleted with an error nobody asked for.
#[tauri::command]
pub fn set_drop_target_script<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    script_id: Option<String>,
) -> Result<(), AppError> {
    use tauri::Manager;
    if let Some(state) = app.try_state::<crate::windows::drag_drop::DropTargetScript>() {
        state.set(script_id);
    }
    Ok(())
}

/// Open the Preferences window, or bring it forward (§14.1).
///
/// The window's lifecycle is entirely Rust's — see `windows/preferences.rs`.
/// The frontend asks; it does not get to create a second one.
#[tauri::command]
pub fn open_preferences<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), AppError> {
    crate::windows::preferences::open(&app)
}

/// Which window the Window menu is asking for.
///
/// An enum rather than a label string, so the renderer cannot name a window
/// that is not one of these. It is the same discipline as everywhere else on
/// this boundary: the webview says WHAT it wants, never which object.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FocusTarget {
    /// The document window.
    Control,
    /// The stage window — the appearance preview and the calibration wizard.
    Stage,
}

/// Bring one of the application's windows forward (the Window menu).
///
/// ---------------------------------------------------------------------------
/// WHY THIS IS A COMMAND AND NOT `getCurrentWindow().setFocus()`
/// ---------------------------------------------------------------------------
/// Because that does not work, and did not work before this: `core:window:default`
/// grants the READ half of the window plugin — sizes, positions, `is_focused` —
/// and neither `allow-set-focus` nor `allow-unminimize`. Window › CandidCue has
/// therefore been a silent no-op since it was added; the renderer's call was
/// rejected by the ACL inside a `try` that treated the rejection as "browser
/// dev".
///
/// The fix is not to widen the capability. Focusing a window is a window
/// operation, and this application deliberately keeps window operations in
/// Rust — the same argument `close_preferences` makes about closing. Widening
/// it would also hand the renderer `set_focus` on the STAGE mid-take, which is
/// the one window whose focus the presentation code owns.
///
/// Unminimise first, then focus: a minimised window accepts focus without
/// coming back on screen, which looks exactly like the menu doing nothing.
///
/// A failure to focus is REPORTED rather than swallowed. A window that is there
/// and will not come forward is a real fault, and the menu item that asked for
/// it is the only place the user could learn about it.
#[tauri::command]
pub fn focus_app_window<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    target: FocusTarget,
) -> Result<(), AppError> {
    let label = match target {
        FocusTarget::Control => crate::windows::CONTROL_LABEL,
        FocusTarget::Stage => crate::windows::STAGE_LABEL,
    };
    // A window that is not there is not an error. The Window menu greys Stage
    // when there is none, and a menu can be clicked faster than a window closes.
    if let Some(window) = app.get_webview_window(label) {
        /*
         * NO `show()`.
         *
         * The stage is deliberately built HIDDEN and shown by the presentation
         * path once it has hydrated and been laid out (`windows/mod.rs`).
         * Showing it from here would put an unpainted window on the presenter's
         * display — the white flash that borderless presentation exists to
         * avoid — and Window › Stage is enabled the moment the window is
         * created, which is exactly that interval.
         *
         * Unminimising is safe: a window that was never shown is not minimised,
         * so this is a no-op for the hidden case and the fix for the real one.
         */
        let _ = window.unminimize();
        window.set_focus().map_err(|err| {
            AppError::structured(
                "WINDOW_FOCUS_FAILED",
                crate::errors::ErrorCategory::Internal,
                "That window could not be brought forward.",
                true,
            )
            .with_log(format!("set_focus on {label}: {err}"))
        })?;
    }
    Ok(())
}

/// Close the Preferences window from inside it (its own Done control).
///
/// A command rather than `window.close()` in the renderer, for the same reason
/// the control window's ⌘W goes through the window manager: closing is a window
/// operation, and routing it through Rust keeps one implementation of what
/// closing means rather than two that can drift.
#[tauri::command]
pub fn close_preferences<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), AppError> {
    crate::windows::preferences::close(&app);
    Ok(())
}

/// Close the document window — File › Close Window, ⌘W off the editor.
///
/// A command for the reason `focus_app_window` gives: the renderer's
/// `getCurrentWindow().close()` needs `core:window:allow-close`, which the
/// control capability does not grant, and the `try` around it read the ACL's
/// refusal as "browser dev". Close Window did nothing at all. Granting the
/// permission instead would hand the renderer `close` on the stage mid-take.
///
/// `close()`, NEVER `destroy()`. `close()` raises `CloseRequested` exactly as
/// the red close button does, so `install_close_coordinator` intercepts it and
/// the shutdown handshake flushes the editor and finishes the take before the
/// app exits. `destroy()` raises nothing, and would quit with all of that
/// skipped.
///
/// The window is the CALLER, not an argument, and only control may ask.
/// Settings holds the same application-command grant (`preferences.json` says
/// why), so a command that found control by label and closed it would let the
/// Settings window quit the app — and Settings' own ⌘W closing Settings is the
/// whole of what #265 secured.
#[tauri::command]
pub fn close_control_window<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
) -> Result<(), AppError> {
    if window.label() != CONTROL_LABEL {
        return Err(AppError::structured(
            "WINDOW_CLOSE_REFUSED",
            crate::errors::ErrorCategory::Permission,
            "Only the document window can close itself this way.",
            false,
        )
        .with_log(format!("close_control_window invoked from `{}`", window.label())));
    }
    window.close().map_err(|err| {
        AppError::structured(
            "WINDOW_CLOSE_FAILED",
            crate::errors::ErrorCategory::Internal,
            "The window could not be closed.",
            true,
        )
        .with_log(format!("close on {CONTROL_LABEL}: {err}"))
    })
}

/// Open the log directory in the platform file browser (Help › Reveal Logs).
///
/// Points at the logs directory specifically rather than the data root, which
/// `reveal_data_folder` already covers. §20.3's rule is that a reveal command
/// shows exactly what its name says and never a parent that happens to contain
/// the database.
#[tauri::command]
pub async fn reveal_logs(paths: tauri::State<'_, DataPaths>) -> Result<(), AppError> {
    tauri_plugin_opener::reveal_item_in_dir(paths.logs_dir())
        .map_err(|e| AppError::Internal(format!("reveal failed: {e}")))
}

/// Open one of CandidCue's own pages in the user's browser (Help).
///
/// Named rather than addressed. The argument is a key into a compile-time table
/// in `crate::web`, never a URL — which is what lets the control window keep
/// having no `opener:default` grant. See that module for the whole argument.
///
/// An unknown name is an error rather than a silent no-op: the only ways to
/// send one are a bug in the frontend and an attempt to use this as a general
/// opener, and both are worth seeing.
#[tauri::command]
pub async fn open_web_destination(name: String) -> Result<(), AppError> {
    let Some(url) = crate::web::url_for(&name) else {
        return Err(AppError::unsafe_path(
            "CandidCue only opens its own pages, and that is not one of them.",
        )
        .with_detail("destination", name));
    };
    tauri_plugin_opener::open_url(url, None::<&str>)
        .map_err(|e| AppError::Internal(format!("could not open that page: {e}")))
}

/// Open the third-party notices that ship inside the bundle (Help › Licences).
///
/// CandidCue is MIT-licensed and links a lot of other people's work. Apache-2.0,
/// MIT, BSD and the model's own licence all require the notice to travel with
/// the binary, and `tauri.conf.json` already bundles `THIRD_PARTY_NOTICES.md`
/// as a resource — but nothing in the application pointed at it, so a user
/// could not read what they had been given. A notice nobody can find is a
/// notice that has not been delivered.
///
/// The path comes from the resource resolver, not from the webview: this takes
/// no argument, so it cannot be turned into "open any file". `open_path` rather
/// than a reveal because a text file the user is meant to READ should open, and
/// macOS has a handler for it.
#[tauri::command]
pub async fn open_third_party_notices<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<(), AppError> {
    use tauri::Manager;
    let path = app
        .path()
        .resolve("THIRD_PARTY_NOTICES.md", tauri::path::BaseDirectory::Resource)
        .map_err(|e| AppError::Internal(format!("notices path: {e}")))?;
    if !path.is_file() {
        return Err(AppError::not_found(
            "The third-party notices are missing from this build. This is a problem with the \
             release rather than with your machine.",
        ));
    }
    tauri_plugin_opener::open_path(path, None::<&str>)
        .map_err(|e| AppError::Internal(format!("could not open the notices: {e}")))
}

/// The control window's resting geometry, persisted between launches.
///
/// "Resting" is the operative word and the reason this is not merged with the
/// reader frame in settings: a take rewrites the window to fill a monitor, and
/// remembering THAT as the window's position would reopen the app the size of a
/// teleprompter panel. Only the frame the window has while the app is being
/// worked in is recorded, and `present.rs` suspends recording for the length of
/// a take.
///
/// The numbers are in the platform's desktop space, [`FrameSpace::native`] —
/// points on macOS, physical pixels elsewhere. Never raw `outer_position()`
/// numbers on macOS: [`measure_frame`] is the one way in.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct WindowFrame {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// The units a frame is measured in — the one space every display on this
/// platform shares.
///
/// The window and every monitor have to be compared in a space where the
/// monitors TILE, and which space that is depends on the platform:
///
///   - macOS: global points. tao reports a window's geometry as points times
///     the window's own scale, and each monitor's as points times THAT
///     monitor's scale, so in "physical" numbers a 2x laptop and a 1x external
///     overlap rather than sitting side by side. A physical setter is also
///     divided by the scale of whichever display the window is on when tao
///     handles it, which at launch is the primary. A frame left on a 1x
///     external came back at half its coordinates and half its size on the
///     laptop, and with the displays the other way round it came back on no
///     display at all (#270). `present.rs` met the same trap in the opposite
///     direction and moves in logical units for the same reason.
///   - Windows (per-monitor DPI v2) and X11: one contiguous virtual desktop in
///     physical pixels. Here it is the LOGICAL setter that goes wrong — tao
///     multiplies a logical value by the window's current scale, not the
///     target monitor's — so physical stays physical.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FrameSpace {
    Logical,
    Physical,
}

impl FrameSpace {
    /// This platform's space. `cfg!` rather than `#[cfg]` so both arms compile,
    /// and are tested, on every platform — CI only runs macOS.
    pub fn native() -> Self {
        if cfg!(target_os = "macos") {
            Self::Logical
        } else {
            Self::Physical
        }
    }
}

/// What `window-frame.json` holds: the frame, and the space it was taken in.
///
/// `space` is absent from every file written before #270, and what those
/// numbers mean depends on the platform — see [`interpret_stored`].
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
struct StoredFrame {
    #[serde(flatten)]
    frame: WindowFrame,
    #[serde(default)]
    space: Option<FrameSpace>,
}

/// The control window's minimum size in points. Mirrors `minWidth`/`minHeight`
/// in tauri.conf.json, so a clamp cannot produce a window the user could not
/// have made themselves.
const MIN_WIDTH_POINTS: u32 = 980;
const MIN_HEIGHT_POINTS: u32 = 680;

/// A scale tao reported, if it is one that can be divided by.
fn usable_scale(scale: f64) -> Option<f64> {
    (scale.is_finite() && scale > 0.0).then_some(scale)
}

/// Physical geometry measured at `scale`, expressed in `space`.
///
/// `scale` is the scale the numbers were MULTIPLIED by: the window's own for a
/// window, the monitor's own for a monitor. That is the whole fix — each
/// rectangle is divided by its own scale rather than by whichever display the
/// window happens to be on.
fn frame_from_physical(
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    scale: f64,
    space: FrameSpace,
) -> WindowFrame {
    let to_space = |value: f64| match space {
        FrameSpace::Logical => (value / scale).round(),
        FrameSpace::Physical => value,
    };
    WindowFrame {
        x: to_space(position.x as f64) as i32,
        y: to_space(position.y as f64) as i32,
        width: to_space(size.width as f64) as u32,
        height: to_space(size.height as f64) as u32,
    }
}

/// The control window's current frame, in [`FrameSpace::native`]. What the
/// recorder in `app.rs` stores.
///
/// Here, beside the restore, so that recording and replay cannot disagree
/// about units.
///
/// `None` when the measurement cannot be trusted: a getter failed, or the
/// window's scale changed between the reads, which means it crossed displays
/// while being measured and the numbers belong to two different scales. The
/// recorder skips that write; the move still settling produces another event.
pub fn measure_frame<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> Option<WindowFrame> {
    let scale = usable_scale(window.scale_factor().ok()?)?;
    let position = window.outer_position().ok()?;
    let size = window.inner_size().ok()?;
    if window.scale_factor().ok()? != scale {
        return None;
    }
    Some(frame_from_physical(position, size, scale, FrameSpace::native()))
}

/// What a stored frame means in `native` space, or `None` when it cannot be
/// trusted.
///
/// A file written before #270 has no `space`. Off macOS its numbers were
/// already physical desktop pixels, so they are used as they are. On macOS
/// they are physical pixels at the scale of whichever display the window was
/// left on, which the file never said. They are read at `legacy_scale`, the
/// primary display's: exact on every desk whose displays share a scale, and no
/// worse than the restore that wrote them on a mixed one. Guessing the scale
/// per frame is not better, because on a mixed desk more than one guess lands
/// on a display at its own scale. The next recorded move rewrites the file in
/// the new form.
///
/// A frame tagged with the OTHER platform's space is refused rather than
/// converted: nothing this app writes produces one.
fn interpret_stored(
    stored: StoredFrame,
    native: FrameSpace,
    legacy_scale: f64,
) -> Option<WindowFrame> {
    let frame = stored.frame;
    match stored.space {
        Some(space) if space == native => Some(frame),
        Some(_) => None,
        None => Some(frame_from_physical(
            PhysicalPosition::new(frame.x, frame.y),
            PhysicalSize::new(frame.width, frame.height),
            legacy_scale,
            native,
        )),
    }
}

/// Where the frame is kept.
///
/// A small JSON file beside the database rather than a settings row, because it
/// has to be read BEFORE the webview exists — the whole point is that the window
/// appears in the right place, and a settings read is an async database query
/// that happens after the window is already on screen.
fn frame_path(paths: &DataPaths) -> std::path::PathBuf {
    paths.root().join("window-frame.json")
}

/// Record the control window's frame.
///
/// Deliberately NOT a `#[tauri::command]`.
///
/// It was one, briefly, on the reasoning that the frontend might want to force a
/// write at a moment it knows is significant. Nothing ever called it: Rust's own
/// `Moved`/`Resized` recorder in `app.rs` already covers every way the window
/// can change shape, including the ones the frontend cannot see. A registered
/// command with no caller is a widened ACL surface for a feature that does not
/// exist — the same objection this codebase already records against the
/// `check_for_update` stub that always returned NOT_IMPLEMENTED — and
/// `ipc-command-reachability.test.ts` exists precisely to catch it.
pub fn write_frame(paths: &DataPaths, frame: WindowFrame) -> Result<(), AppError> {
    /*
     * A window with no area is not a window anybody wants back.
     *
     * Both platforms report a zero size at moments the window genuinely has one
     * — minimised on Windows, and on macOS during the borderless transition a
     * take makes. Storing that would reopen the app as an invisible window with
     * no way to grab it, which is unrecoverable without deleting this file by
     * hand. The floor is the configured minimum from tauri.conf.json.
     */
    if frame.width < 400 || frame.height < 300 {
        return Ok(());
    }
    let path = frame_path(paths);
    let stored = StoredFrame {
        frame,
        space: Some(FrameSpace::native()),
    };
    let json = serde_json::to_vec_pretty(&stored)
        .map_err(|e| AppError::Internal(format!("the window frame could not be encoded: {e}")))?;
    std::fs::write(&path, json)
        .map_err(|e| AppError::Internal(format!("the window frame could not be written: {e}")))?;
    Ok(())
}

/// Put the control window back where it was, at startup.
///
/// Called from `setup`, before the window is shown. Every failure is swallowed:
/// a window at the default position is completely fine, and an app that refuses
/// to launch because a 40-byte cache file is malformed is not.
pub fn restore_window_frame(app: &tauri::AppHandle) {
    let Some(paths) = app.try_state::<DataPaths>() else {
        return;
    };
    let Ok(bytes) = std::fs::read(frame_path(&paths)) else {
        return;
    };
    let Ok(stored) = serde_json::from_slice::<StoredFrame>(&bytes) else {
        tracing::warn!("the stored window frame could not be read; using the default");
        return;
    };
    let Some(window) = app.get_webview_window(CONTROL_LABEL) else {
        return;
    };

    /*
     * FIT THE FRAME TO A MONITOR THAT EXISTS.
     *
     * The stored frame came from a display arrangement that may be gone: a
     * laptop undocked from a second monitor reopens with the window at
     * coordinates entirely off the visible desktop, which on both platforms is
     * an application that has launched and cannot be found. The same care
     * `present.rs` already takes when it chooses a panel.
     *
     * The first version of this checked only whether the ORIGIN fell inside a
     * monitor's full bounds, and applied the stored size unchanged. Two ways
     * that was wrong:
     *
     *   - an origin at a monitor's bottom-right pixel passed the test with the
     *     entire window, titlebar included, off the screen;
     *   - a frame saved on a 5K display reopened at 3000 × 1800 on a laptop.
     *
     * `work_area` rather than `size`, so the macOS menu bar and the Windows
     * taskbar are excluded — a window restored under the taskbar is one whose
     * title bar cannot be grabbed.
     *
     * The primary goes FIRST, because the first area is where a frame whose
     * display is gone gets centred. Enumeration order is not a promise of that
     * on every platform, and this list is local, so reordering it disturbs no
     * index anything else holds.
     */
    let space = FrameSpace::native();
    let mut monitors = window.available_monitors().unwrap_or_default();
    let primary = window.primary_monitor().ok().flatten();
    if let Some(primary) = &primary {
        if let Some(index) = monitors.iter().position(|monitor| {
            monitor.position() == primary.position() && monitor.size() == primary.size()
        }) {
            let primary = monitors.remove(index);
            monitors.insert(0, primary);
        }
    }

    let legacy_scale = primary
        .as_ref()
        .and_then(|monitor| usable_scale(monitor.scale_factor()))
        .or_else(|| window.scale_factor().ok().and_then(usable_scale))
        .unwrap_or(1.0);
    let Some(frame) = interpret_stored(stored, space, legacy_scale) else {
        tracing::info!("the stored window frame is in another platform's units; using the default");
        return;
    };
    let Some(fitted) = fit_to_monitors(frame, &monitors, space) else {
        tracing::info!("no monitor can hold the stored window frame; using the default");
        return;
    };

    for placement in placements(fitted, space) {
        let _ = match placement {
            Placement::Size(size) => window.set_size(size),
            Placement::Position(position) => window.set_position(position),
        };
    }
}

/// One setter call a restore makes.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Placement {
    Size(tauri::Size),
    Position(tauri::Position),
}

/// The setter calls that put the window at `fitted`, in the units and the order
/// `space` needs.
///
/// Points (macOS): size, then position. tao sets the size through
/// `setContentSize`, which keeps the window's BOTTOM-left corner where it is,
/// so a position applied first would have its top edge moved by the resize.
///
/// Physical (Windows): position and size, twice. Windows changes a window's
/// DPI once most of it is on a display of another DPI, and tao answers
/// `WM_DPICHANGED` by rescaling the window. Which call sets that off depends on
/// how much of the launch-sized window the first move leaves behind — the move
/// itself, or the resize after it — and whichever it is, the size it rescales
/// is the one just applied. By the second pass the window is on its
/// destination at that display's DPI, and nothing rescales the numbers it sets.
fn placements(fitted: WindowFrame, space: FrameSpace) -> Vec<Placement> {
    match space {
        FrameSpace::Logical => vec![
            Placement::Size(LogicalSize::new(fitted.width as f64, fitted.height as f64).into()),
            Placement::Position(LogicalPosition::new(fitted.x as f64, fitted.y as f64).into()),
        ],
        FrameSpace::Physical => {
            let position = Placement::Position(PhysicalPosition::new(fitted.x, fitted.y).into());
            let size = Placement::Size(PhysicalSize::new(fitted.width, fitted.height).into());
            vec![position, size, position, size]
        }
    }
}

/// A monitor's usable rectangle, as plain numbers.
///
/// Extracted so `fit_to_monitors` is pure and testable: the real
/// `tauri::Monitor` cannot be constructed without a running event loop, and the
/// geometry rules here are exactly the part worth testing.
///
/// In the same space as the frame being fitted, and so is the minimum: the
/// control window's minimum is declared in points, which on a physical-space
/// desk is a different number of pixels on every display.
#[derive(Debug, Clone, Copy)]
pub struct WorkArea {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub min_width: u32,
    pub min_height: u32,
}

/// One monitor's usable rectangle as tao reports it — physical, at the
/// monitor's own `scale` — expressed in `space`.
fn work_area_from_physical(
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    scale: f64,
    space: FrameSpace,
) -> WorkArea {
    let rect = frame_from_physical(position, size, scale, space);
    let min = |points: u32| match space {
        FrameSpace::Logical => points,
        FrameSpace::Physical => (points as f64 * scale).round() as u32,
    };
    WorkArea {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        min_width: min(MIN_WIDTH_POINTS),
        min_height: min(MIN_HEIGHT_POINTS),
    }
}

fn fit_to_monitors(
    frame: WindowFrame,
    monitors: &[tauri::Monitor],
    space: FrameSpace,
) -> Option<WindowFrame> {
    let areas: Vec<WorkArea> = monitors
        .iter()
        .map(|monitor| {
            let area = monitor.work_area();
            let scale = usable_scale(monitor.scale_factor()).unwrap_or(1.0);
            work_area_from_physical(area.position, area.size, scale, space)
        })
        .collect();
    fit_frame(frame, &areas)
}

/// Choose a work area for the frame and clamp it into that area.
///
/// Returns `None` when there is nothing to fit into at all (no monitors), which
/// the caller answers by leaving the window at its configured default.
///
/// The chosen monitor is the one the frame OVERLAPS MOST, not the one its
/// origin happens to land in: a window straddling two displays belongs to the
/// one showing most of it, and a window whose origin sits one pixel inside a
/// neighbour does not belong to the neighbour.
pub fn fit_frame(frame: WindowFrame, areas: &[WorkArea]) -> Option<WindowFrame> {
    if areas.is_empty() {
        return None;
    }

    // In i64 throughout: the frame comes from a file, and a corrupt one with an
    // edge near `i32::MAX` must not overflow on the way to being refused.
    let overlap = |area: &WorkArea| -> i64 {
        let left = (frame.x as i64).max(area.x as i64);
        let top = (frame.y as i64).max(area.y as i64);
        let right = (frame.x as i64 + frame.width as i64).min(area.x as i64 + area.width as i64);
        let bottom = (frame.y as i64 + frame.height as i64).min(area.y as i64 + area.height as i64);
        (right - left).max(0) * (bottom - top).max(0)
    };

    // Most overlap wins; with none anywhere (the display is gone) the first
    // monitor is the primary and the window is centred on it below. Ties go to
    // the EARLIER area: `max_by_key` returns the last maximum, which with no
    // overlap anywhere centred the window on whichever monitor was enumerated
    // last rather than on the primary.
    let best = areas
        .iter()
        .copied()
        .reduce(|best, area| if overlap(&area) > overlap(&best) { area } else { best })
        .expect("areas is non-empty");
    let has_overlap = overlap(&best) > 0;

    // Never larger than the area it is going into, and never smaller than the
    // window's declared minimum on that display.
    let width = frame.width.min(best.width).max(best.min_width.min(best.width));
    let height = frame.height.min(best.height).max(best.min_height.min(best.height));

    if !has_overlap {
        // Centred rather than nudged: a window restored to the middle of a
        // display is obviously fine, whereas one shoved against the edge of a
        // display it was never on is a new kind of wrong.
        return Some(WindowFrame {
            x: best.x + (best.width as i32 - width as i32) / 2,
            y: best.y + (best.height as i32 - height as i32) / 2,
            width,
            height,
        });
    }

    let x = frame
        .x
        .min(best.x + best.width as i32 - width as i32)
        .max(best.x);
    let y = frame
        .y
        .min(best.y + best.height as i32 - height as i32)
        .max(best.y);
    Some(WindowFrame { x, y, width, height })
}

#[cfg(test)]
mod tests {
    use super::*;

    const LAPTOP: WorkArea = WorkArea {
        x: 0,
        y: 25,
        width: 1512,
        height: 907,
        min_width: MIN_WIDTH_POINTS,
        min_height: MIN_HEIGHT_POINTS,
    };
    const EXTERNAL: WorkArea = WorkArea {
        x: 1512,
        y: 0,
        width: 2560,
        height: 1440,
        min_width: MIN_WIDTH_POINTS,
        min_height: MIN_HEIGHT_POINTS,
    };

    fn frame(x: i32, y: i32, width: u32, height: u32) -> WindowFrame {
        WindowFrame { x, y, width, height }
    }

    /// A rectangle in points as tao reports it on macOS: multiplied by `scale`
    /// and rounded, with the same `dpi` conversion tao uses.
    fn mac_physical(points: WindowFrame, scale: f64) -> (PhysicalPosition<i32>, PhysicalSize<u32>) {
        (
            LogicalPosition::new(points.x as f64, points.y as f64).to_physical(scale),
            LogicalSize::new(points.width as f64, points.height as f64).to_physical(scale),
        )
    }

    /// What tao on macOS reports for a monitor whose usable area is this
    /// rectangle in POINTS: origin and size both multiplied by the monitor's
    /// own scale (`tauri-runtime-wry`'s `monitor/macos.rs::work_area`).
    fn mac_work_area(points: WindowFrame, scale: f64) -> WorkArea {
        let (position, size) = mac_physical(points, scale);
        work_area_from_physical(position, size, scale, FrameSpace::Logical)
    }

    /// What the recorder stores on macOS for a window at this frame in points,
    /// on a display of `scale`: tao's `outer_position`/`inner_size` multiply by
    /// the window's scale, and `measure_frame` divides it back out.
    fn mac_record(points: WindowFrame, scale: f64) -> WindowFrame {
        let (position, size) = mac_physical(points, scale);
        frame_from_physical(position, size, scale, FrameSpace::Logical)
    }

    /// Where tao on macOS puts a window given these setter calls, in points. A
    /// logical value already is points; a physical one is divided by the scale
    /// of the display the window is on when the call is handled, which at
    /// launch is the primary (`platform_impl/macos/window.rs`).
    fn mac_apply(placements: &[Placement], launch_scale: f64) -> WindowFrame {
        let mut placed = frame(0, 0, 0, 0);
        for placement in placements {
            match placement {
                Placement::Size(size) => {
                    let size = size.to_logical::<f64>(launch_scale);
                    placed.width = size.width.round() as u32;
                    placed.height = size.height.round() as u32;
                }
                Placement::Position(position) => {
                    let position = position.to_logical::<f64>(launch_scale);
                    placed.x = position.x.round() as i32;
                    placed.y = position.y.round() as i32;
                }
            }
        }
        placed
    }

    /// Record, quit, relaunch, restore — then record what the restore produced
    /// and do it again, because the recorder writes the restored frame back
    /// and a restore that drifts loses the arrangement for every later launch.
    fn assert_round_trips(
        left: WindowFrame,
        window_scale: f64,
        launch_scale: f64,
        areas: &[WorkArea],
    ) {
        let mut on_screen = left;
        for launch in 1..=3 {
            let recorded = StoredFrame {
                frame: mac_record(on_screen, window_scale),
                space: Some(FrameSpace::Logical),
            };
            let json = serde_json::to_vec(&recorded).expect("encodes");
            let stored: StoredFrame = serde_json::from_slice(&json).expect("parses");
            let frame = interpret_stored(stored, FrameSpace::Logical, launch_scale).expect("native");
            let fitted = fit_frame(frame, areas).expect("a monitor");
            on_screen = mac_apply(&placements(fitted, FrameSpace::Logical), launch_scale);
            assert_eq!(on_screen, left, "launch {launch} moved the window");
        }
    }

    /*
     * The three arrangements in #270, which reopened at half the coordinates,
     * then off every display, then correctly.
     */

    #[test]
    fn restores_onto_a_1x_external_beside_a_2x_primary() {
        let macbook = mac_work_area(frame(0, 25, 1512, 957), 2.0);
        let external = mac_work_area(frame(1512, 0, 2560, 1440), 1.0);
        assert_round_trips(frame(2000, 200, 1240, 820), 1.0, 2.0, &[macbook, external]);
    }

    #[test]
    fn restores_onto_a_2x_laptop_left_of_a_1x_primary() {
        // The laptop sits at negative x, the arrangement that used to come
        // back at (-2800, 200), on no display.
        let external = mac_work_area(frame(0, 25, 2560, 1415), 1.0);
        let macbook = mac_work_area(frame(-1512, 0, 1512, 982), 2.0);
        assert_round_trips(frame(-1400, 100, 1240, 820), 2.0, 1.0, &[external, macbook]);
    }

    #[test]
    fn restores_between_two_2x_displays() {
        let macbook = mac_work_area(frame(0, 25, 1512, 957), 2.0);
        let external = mac_work_area(frame(1512, 0, 2560, 1440), 2.0);
        assert_round_trips(frame(2000, 200, 1240, 820), 2.0, 2.0, &[macbook, external]);
    }

    #[test]
    fn the_model_reproduces_the_old_restore() {
        // The pipeline this replaced, under the same model of tao: raw
        // physical frame, raw physical work areas, physical setters. It has to
        // land where #270 says it did, or the tests above are tests of a model
        // that never had the bug.
        let raw = |points: WindowFrame, scale: f64| {
            let (position, size) = mac_physical(points, scale);
            work_area_from_physical(position, size, scale, FrameSpace::Physical)
        };
        let old = |left: WindowFrame, window_scale: f64, launch_scale: f64, areas: &[WorkArea]| {
            let (position, size) = mac_physical(left, window_scale);
            let stored = frame_from_physical(position, size, window_scale, FrameSpace::Physical);
            let fitted = fit_frame(stored, areas).expect("a monitor");
            let setters = [
                Placement::Size(PhysicalSize::new(fitted.width, fitted.height).into()),
                Placement::Position(PhysicalPosition::new(fitted.x, fitted.y).into()),
            ];
            mac_apply(&setters, launch_scale)
        };

        let macbook = raw(frame(0, 25, 1512, 957), 2.0);
        let external = raw(frame(1512, 0, 2560, 1440), 1.0);
        assert_eq!(
            old(frame(2000, 200, 1240, 820), 1.0, 2.0, &[macbook, external]),
            frame(1000, 100, 620, 410)
        );

        let external = raw(frame(0, 25, 2560, 1415), 1.0);
        let macbook = raw(frame(-1512, 0, 1512, 982), 2.0);
        assert_eq!(
            old(frame(-1400, 100, 1240, 820), 2.0, 1.0, &[external, macbook]),
            frame(-2800, 200, 2480, 1640)
        );
    }

    #[test]
    fn rounds_odd_pixels_once_and_then_holds() {
        let measured = frame_from_physical(
            PhysicalPosition::new(-2801, 401),
            PhysicalSize::new(2481, 1641),
            2.0,
            FrameSpace::Logical,
        );
        assert_eq!(measured, frame(-1401, 201, 1241, 821));
        assert_eq!(mac_record(measured, 2.0), measured);
    }

    #[test]
    fn applies_points_once_and_pixels_twice() {
        let fitted = frame(2000, 200, 1240, 820);
        assert_eq!(
            placements(fitted, FrameSpace::Logical),
            vec![
                Placement::Size(LogicalSize::new(1240.0, 820.0).into()),
                Placement::Position(LogicalPosition::new(2000.0, 200.0).into()),
            ]
        );
        let position = Placement::Position(PhysicalPosition::new(2000, 200).into());
        let size = Placement::Size(PhysicalSize::new(1240u32, 820u32).into());
        assert_eq!(
            placements(fitted, FrameSpace::Physical),
            vec![position, size, position, size]
        );
    }

    #[test]
    fn survives_absurd_coordinates() {
        let fitted = fit_frame(frame(i32::MAX, i32::MIN, u32::MAX, u32::MAX), &[LAPTOP])
            .expect("a monitor");
        assert!(fitted.x >= LAPTOP.x && fitted.y >= LAPTOP.y);
        assert!(fitted.width <= LAPTOP.width && fitted.height <= LAPTOP.height);
    }

    #[test]
    fn divides_each_monitor_by_its_own_scale() {
        let laptop = work_area_from_physical(
            PhysicalPosition::new(0, 50),
            PhysicalSize::new(3024, 1914),
            2.0,
            FrameSpace::Logical,
        );
        assert_eq!(
            (laptop.x, laptop.y, laptop.width, laptop.height),
            (0, 25, 1512, 957)
        );
        assert_eq!((laptop.min_width, laptop.min_height), (980, 680));

        let left = work_area_from_physical(
            PhysicalPosition::new(-3024, 0),
            PhysicalSize::new(3024, 1964),
            2.0,
            FrameSpace::Logical,
        );
        assert_eq!((left.x, left.width), (-1512, 1512));
    }

    #[test]
    fn leaves_a_physical_desktop_alone() {
        // Windows: one contiguous physical space, whatever each display's DPI.
        let wide = work_area_from_physical(
            PhysicalPosition::new(1920, 0),
            PhysicalSize::new(3840, 2100),
            1.5,
            FrameSpace::Physical,
        );
        assert_eq!((wide.x, wide.y, wide.width, wide.height), (1920, 0, 3840, 2100));
        // The minimum is declared in points, so it is 1.5x as many pixels here.
        assert_eq!((wide.min_width, wide.min_height), (1470, 1020));

        let measured = frame_from_physical(
            PhysicalPosition::new(2500, 300),
            PhysicalSize::new(1860, 1230),
            1.5,
            FrameSpace::Physical,
        );
        assert_eq!(measured, frame(2500, 300, 1860, 1230));
        let narrow = work_area_from_physical(
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(1920, 1040),
            1.0,
            FrameSpace::Physical,
        );
        assert_eq!(fit_frame(measured, &[narrow, wide]), Some(measured));
    }

    #[test]
    fn grows_to_the_displays_minimum_before_clamping() {
        // A frame at the 1x minimum, restored onto a 1.5x display at its right
        // edge. Windows would enlarge it to 1470 px after the clamp and push it
        // off the display; the fit has to do the enlarging itself.
        let wide = work_area_from_physical(
            PhysicalPosition::new(1920, 0),
            PhysicalSize::new(3840, 2100),
            1.5,
            FrameSpace::Physical,
        );
        let fitted = fit_frame(frame(1920 + 3840 - 980, 300, 980, 680), &[wide]).expect("a monitor");
        assert_eq!((fitted.width, fitted.height), (1470, 1020));
        assert_eq!(fitted.x + fitted.width as i32, 1920 + 3840);
    }

    #[test]
    fn centres_on_the_first_area_when_the_display_is_gone() {
        // `max_by_key` used to hand a zero-overlap tie to the LAST area.
        let frame = frame(9000, 200, 1240, 820);
        let fitted = fit_frame(frame, &[LAPTOP, EXTERNAL]).expect("a monitor");
        assert!(fitted.x >= LAPTOP.x);
        assert!(fitted.x + fitted.width as i32 <= LAPTOP.x + LAPTOP.width as i32);
        let fitted = fit_frame(frame, &[EXTERNAL, LAPTOP]).expect("a monitor");
        assert!(fitted.x >= EXTERNAL.x);
    }

    #[test]
    fn reads_a_legacy_mac_frame_at_the_primary_scale() {
        let legacy = StoredFrame { frame: frame(2000, 400, 2480, 1640), space: None };
        assert_eq!(
            interpret_stored(legacy, FrameSpace::Logical, 2.0),
            Some(frame(1000, 200, 1240, 820))
        );
        assert_eq!(
            interpret_stored(legacy, FrameSpace::Logical, 1.0),
            Some(legacy.frame)
        );
    }

    #[test]
    fn reads_a_legacy_physical_frame_unchanged() {
        let legacy = StoredFrame { frame: frame(2000, 400, 2480, 1640), space: None };
        assert_eq!(
            interpret_stored(legacy, FrameSpace::Physical, 1.5),
            Some(legacy.frame)
        );
    }

    #[test]
    fn never_converts_a_tagged_frame_twice() {
        let tagged = StoredFrame {
            frame: frame(2000, 200, 1240, 820),
            space: Some(FrameSpace::Logical),
        };
        assert_eq!(interpret_stored(tagged, FrameSpace::Logical, 2.0), Some(tagged.frame));
    }

    #[test]
    fn refuses_a_frame_tagged_with_the_other_space() {
        let tagged = StoredFrame {
            frame: frame(2000, 200, 1240, 820),
            space: Some(FrameSpace::Physical),
        };
        assert_eq!(interpret_stored(tagged, FrameSpace::Logical, 2.0), None);
    }

    #[test]
    fn parses_old_and_new_files() {
        let old: StoredFrame =
            serde_json::from_str(r#"{"x":-1,"y":2,"width":1240,"height":820}"#).expect("parses");
        assert_eq!(old, StoredFrame { frame: frame(-1, 2, 1240, 820), space: None });

        let new: StoredFrame = serde_json::from_str(
            r#"{"x":-1,"y":2,"width":1240,"height":820,"space":"logical"}"#,
        )
        .expect("parses");
        assert_eq!(new.space, Some(FrameSpace::Logical));

        assert!(serde_json::from_str::<StoredFrame>(
            r#"{"x":0,"y":0,"width":1240,"height":820,"space":"furlongs"}"#
        )
        .is_err());
    }

    #[test]
    fn writes_the_native_space() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let paths = DataPaths::new(dir.path().to_path_buf());
        write_frame(&paths, frame(10, 20, 1240, 820)).expect("written");
        let bytes = std::fs::read(frame_path(&paths)).expect("a file");
        let stored: StoredFrame = serde_json::from_slice(&bytes).expect("parses");
        assert_eq!(
            stored,
            StoredFrame { frame: frame(10, 20, 1240, 820), space: Some(FrameSpace::native()) }
        );

        // A frame under the floor leaves the previous one where it was.
        write_frame(&paths, frame(0, 0, 0, 0)).expect("declined quietly");
        let bytes = std::fs::read(frame_path(&paths)).expect("a file");
        let kept: StoredFrame = serde_json::from_slice(&bytes).expect("parses");
        assert_eq!(kept, stored);
    }

    #[test]
    fn leaves_a_frame_that_already_fits_alone() {
        let frame = WindowFrame { x: 100, y: 100, width: 1240, height: 820 };
        let fitted = fit_frame(frame, &[LAPTOP]).expect("a monitor");
        assert_eq!((fitted.x, fitted.y, fitted.width, fitted.height), (100, 100, 1240, 820));
    }

    #[test]
    fn shrinks_a_frame_saved_on_a_bigger_display() {
        // The failure this exists for: 2400 × 1400 saved on the external, then
        // reopened with only the laptop attached.
        let frame = WindowFrame { x: 1600, y: 100, width: 2400, height: 1400 };
        let fitted = fit_frame(frame, &[LAPTOP]).expect("a monitor");
        assert!(fitted.width <= LAPTOP.width, "width {} exceeds the work area", fitted.width);
        assert!(fitted.height <= LAPTOP.height, "height {} exceeds the work area", fitted.height);
    }

    #[test]
    fn centres_a_frame_whose_display_is_gone() {
        let frame = WindowFrame { x: 3000, y: 200, width: 1240, height: 820 };
        let fitted = fit_frame(frame, &[LAPTOP]).expect("a monitor");
        assert!(fitted.x >= LAPTOP.x);
        assert!(fitted.y >= LAPTOP.y);
        assert!(fitted.x + fitted.width as i32 <= LAPTOP.x + LAPTOP.width as i32);
    }

    #[test]
    fn keeps_the_whole_window_inside_the_work_area() {
        // An origin one pixel inside the bottom-right corner used to pass: the
        // old check tested the ORIGIN and nothing else, so the entire window —
        // titlebar included — could be off screen.
        let frame = WindowFrame { x: 1511, y: 931, width: 1240, height: 820 };
        let fitted = fit_frame(frame, &[LAPTOP]).expect("a monitor");
        assert!(fitted.x + fitted.width as i32 <= LAPTOP.x + LAPTOP.width as i32);
        assert!(fitted.y + fitted.height as i32 <= LAPTOP.y + LAPTOP.height as i32);
        assert!(fitted.y >= LAPTOP.y, "the frame must clear the menu bar");
    }

    #[test]
    fn respects_the_menu_bar_inset() {
        // The laptop work area starts at y=25 (the macOS menu bar). A frame
        // saved at y=0 must come down, not stay under the bar.
        let frame = WindowFrame { x: 10, y: 0, width: 800, height: 600 };
        let fitted = fit_frame(frame, &[LAPTOP]).expect("a monitor");
        assert_eq!(fitted.y, LAPTOP.y);
    }

    #[test]
    fn picks_the_monitor_the_window_mostly_occupies() {
        // Straddling both, mostly on the external: it should stay on the
        // external rather than being pulled onto the laptop it touches.
        let frame = WindowFrame { x: 1400, y: 200, width: 1240, height: 820 };
        let fitted = fit_frame(frame, &[LAPTOP, EXTERNAL]).expect("a monitor");
        assert!(
            fitted.x + (fitted.width as i32 / 2) >= EXTERNAL.x,
            "the window's centre should stay on the external display"
        );
    }

    #[test]
    fn declines_when_there_are_no_monitors() {
        let frame = WindowFrame { x: 0, y: 0, width: 1240, height: 820 };
        assert!(fit_frame(frame, &[]).is_none());
    }

    #[test]
    fn never_returns_a_frame_larger_than_its_area() {
        // Property-ish sweep over sizes that bracket the work area.
        for width in [200u32, 980, 1512, 4000] {
            for height in [200u32, 680, 907, 3000] {
                let frame = WindowFrame { x: -500, y: -500, width, height };
                let fitted = fit_frame(frame, &[LAPTOP]).expect("a monitor");
                assert!(fitted.width <= LAPTOP.width);
                assert!(fitted.height <= LAPTOP.height);
                assert!(fitted.x >= LAPTOP.x);
                assert!(fitted.y >= LAPTOP.y);
            }
        }
    }
}
