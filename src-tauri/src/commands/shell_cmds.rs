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
use tauri::{Manager, PhysicalPosition, PhysicalSize};

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

/// The control window's resting geometry, persisted between launches.
///
/// "Resting" is the operative word and the reason this is not merged with the
/// reader frame in settings: a take rewrites the window to fill a monitor, and
/// remembering THAT as the window's position would reopen the app the size of a
/// teleprompter panel. Only the frame the window has while the app is being
/// worked in is recorded, and `present.rs` suspends recording for the length of
/// a take.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct WindowFrame {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
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
    let json = serde_json::to_vec_pretty(&frame)
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
    let Ok(frame) = serde_json::from_slice::<WindowFrame>(&bytes) else {
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
     */
    let monitors = window.available_monitors().unwrap_or_default();
    let Some(fitted) = fit_to_monitors(frame, &monitors) else {
        tracing::info!("no monitor can hold the stored window frame; using the default");
        return;
    };

    let _ = window.set_size(PhysicalSize::new(fitted.width, fitted.height));
    let _ = window.set_position(PhysicalPosition::new(fitted.x, fitted.y));
}

/// A monitor's usable rectangle, as plain numbers.
///
/// Extracted so `fit_to_monitors` is pure and testable: the real
/// `tauri::Monitor` cannot be constructed without a running event loop, and the
/// geometry rules here are exactly the part worth testing.
#[derive(Debug, Clone, Copy)]
pub struct WorkArea {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

fn fit_to_monitors(frame: WindowFrame, monitors: &[tauri::Monitor]) -> Option<WindowFrame> {
    let areas: Vec<WorkArea> = monitors
        .iter()
        .map(|monitor| {
            let area = monitor.work_area();
            WorkArea {
                x: area.position.x,
                y: area.position.y,
                width: area.size.width,
                height: area.size.height,
            }
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

    let overlap = |area: &WorkArea| -> i64 {
        let left = frame.x.max(area.x);
        let top = frame.y.max(area.y);
        let right = (frame.x + frame.width as i32).min(area.x + area.width as i32);
        let bottom = (frame.y + frame.height as i32).min(area.y + area.height as i32);
        let w = (right - left).max(0) as i64;
        let h = (bottom - top).max(0) as i64;
        w * h
    };

    // Most overlap wins; with none anywhere (the display is gone) the first
    // monitor is the primary and the window is centred on it below.
    let best = areas
        .iter()
        .max_by_key(|area| overlap(area))
        .copied()
        .expect("areas is non-empty");
    let has_overlap = overlap(&best) > 0;

    // Never larger than the area it is going into. `MIN_*` mirrors the
    // `minWidth`/`minHeight` in tauri.conf.json so a clamp cannot produce a
    // window the user could not have made themselves.
    const MIN_W: u32 = 980;
    const MIN_H: u32 = 680;
    let width = frame.width.min(best.width).max(MIN_W.min(best.width));
    let height = frame.height.min(best.height).max(MIN_H.min(best.height));

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

    const LAPTOP: WorkArea = WorkArea { x: 0, y: 25, width: 1512, height: 907 };
    const EXTERNAL: WorkArea = WorkArea { x: 1512, y: 0, width: 2560, height: 1440 };

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
