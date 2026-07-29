//! Turning the control window into the teleprompter, and back (spec §52.7).
//!
//! ---------------------------------------------------------------------------
//! WHY THIS IS NOT `set_fullscreen(true)`
//! ---------------------------------------------------------------------------
//! It used to be. `startTake` called `getCurrentWindow().setFullscreen(true)`
//! from the renderer, and on macOS that is not a resize — it allocates a new
//! Space and ANIMATES the window into it over about half a second. For the
//! length of that animation the webview's rendered surface is still the old,
//! smaller one: AppKit stretches the window around it and paints the exposed
//! strip with the window's background. The presenter saw the script land at the
//! bottom of the glass with a white bar above it, every time they pressed
//! Present.
//!
//! No element inside the page can cover that strip, because the page has not
//! been laid out into it yet. The plate in `StageApp` — which exists for a
//! different fault, the script painting at scroll zero before its line map
//! lands — was never going to reach it.
//!
//! [`set_stage_fullscreen`](super::set_stage_fullscreen) already knew this. The
//! separate stage window has presented BORDERLESS since it was written, for
//! exactly these reasons, and its doc comment says so. Single-window
//! presentation simply never inherited the lesson. So this is that same
//! approach applied to the control window: no Space, no animation, no titlebar,
//! nothing left over to paint.
//!
//! ---------------------------------------------------------------------------
//! THE MONITOR IS THE ONE THE WINDOW IS ALREADY ON
//! ---------------------------------------------------------------------------
//! Deliberately not `settings.stage.displayFingerprint`. In single-window
//! presentation the operator moves this window to the panel they want to
//! present on and then presses Present — that is the whole gesture, and it is
//! what `start-take.ts` documents at its display-enumeration step. A present
//! that teleported the window to whichever display a pinned fingerprint named
//! would be moving the window out from under the person driving it.

use serde::Serialize;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow};

use crate::errors::AppError;

use super::{sleep, CONTROL_LABEL};

/// Everything un-presenting has to put back.
///
/// Captured before the first mutation, so a restore replays measured values
/// rather than guessing at what the window "probably" looked like. There is no
/// `is_always_on_top` in the Tauri window API, which is why that one is not
/// here: the control window is never pinned except by this module, so the
/// correct restore is unconditionally `false`.
///
/// `size` is the INNER size, and the pairing matters more than it looks.
/// Tauri's `set_size` is delivered as `WindowMessage::SetSize`, which the wry
/// runtime implements as `set_inner_size` — so a frame that snapshotted
/// `outer_size()` would be restored as if the titlebar were content, and the
/// window would grow by the height of its own chrome on EVERY present/restore
/// cycle. Position is the opposite pairing and is already consistent:
/// `outer_position()` in, `SetPosition` → `set_outer_position` out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ControlFrame {
    position: PhysicalPosition<i32>,
    inner_size: PhysicalSize<u32>,
    decorations: bool,
    maximized: bool,
}

/// What a present/un-present request should actually do.
///
/// Pure and separated for the same reason [`sleep::plan`] is: the interesting
/// part is the pairing, and the pairing is what leaks or double-applies when it
/// is wrong — but it cannot be exercised at all through the real API without a
/// display server. Both idempotent cases are named rather than folded into the
/// others, because they do genuinely different things.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PresentAction {
    /// Not presenting, asked to present: save the frame, then apply.
    Enter,
    /// Already presenting, asked again: re-apply the bounds (the display may
    /// have been rearranged mid-take) WITHOUT overwriting the saved frame.
    Reassert,
    /// Presenting, asked to stop: restore the saved frame and drop it.
    Restore,
    /// Not presenting, asked to stop. `startTake`'s failure paths un-present
    /// unconditionally without knowing how far the open got, so this is the
    /// ordinary case rather than a defect.
    Nothing,
}

pub fn plan(currently_presenting: bool, want_presenting: bool) -> PresentAction {
    match (currently_presenting, want_presenting) {
        (false, true) => PresentAction::Enter,
        (true, true) => PresentAction::Reassert,
        (true, false) => PresentAction::Restore,
        (false, false) => PresentAction::Nothing,
    }
}

/// The pre-presentation frame, or `None` when the window is not presenting.
///
/// A module-level static rather than coordinator state, for the same reason
/// [`sleep`] uses one: it is a property of the OS window, it has to survive
/// every path that can end a take (including a renderer that reloads
/// mid-session), and nothing else in the app has any business reading it.
fn saved_frame() -> &'static std::sync::Mutex<Option<ControlFrame>> {
    static STATE: std::sync::OnceLock<std::sync::Mutex<Option<ControlFrame>>> =
        std::sync::OnceLock::new();
    STATE.get_or_init(|| std::sync::Mutex::new(None))
}

fn lock() -> std::sync::MutexGuard<'static, Option<ControlFrame>> {
    match saved_frame().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// What the control window is doing now, and the size the renderer should
/// expect to settle at.
///
/// The bounds are LOGICAL (CSS) pixels, because the only consumer is the
/// renderer's "has the viewport finished changing yet?" wait, and that compares
/// against `window.innerWidth`/`innerHeight`. Handing back physical pixels
/// would make every caller repeat the scale-factor division, and one of them
/// would eventually get it wrong on a mixed-DPI rig.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlPresentationState {
    pub presenting: bool,
    pub width: f64,
    pub height: f64,
}

fn control_window<R: Runtime>(app: &AppHandle<R>) -> Result<WebviewWindow<R>, AppError> {
    app.get_webview_window(CONTROL_LABEL)
        .ok_or_else(|| presentation_failed("the control window is not open"))
}

/// A window operation on THIS window failed.
///
/// Not the `#[from] tauri::Error` conversion, which every `?` in this file
/// would otherwise reach for. That produces `AppError::Window`, whose code is
/// `STAGE_OPEN_FAILED`, whose copy is "CandidCue could not open the stage
/// window on that display. Choose another display, then try again." Single-
/// window presentation opens no stage window and consults no display picker, so
/// that message sends the operator to a setting that cannot help them for a
/// failure it does not describe.
///
/// Recoverable, and truthfully so: entering leaves the saved frame latched so
/// the un-present that follows puts back whatever landed, and leaving keeps the
/// frame so it can simply be tried again.
fn presentation_failed(detail: impl std::fmt::Display) -> AppError {
    AppError::structured(
        "PRESENTATION_FAILED",
        crate::errors::ErrorCategory::Window,
        "CandidCue could not turn this window into the teleprompter. The window \
         has been left as it was — try Present again.",
        true,
    )
    .with_log(detail.to_string())
}

/// The logical (CSS) size a physical size will present as, for the settle wait.
///
/// Deliberately takes the size as an argument rather than measuring the window.
/// Every geometry setter above is delivered asynchronously — on macOS tao posts
/// them to the GCD main queue — so a `window.inner_size()` read taken straight
/// after `set_size` returns the size the window has NOT changed from yet. The
/// renderer would then be handed its own current viewport as the thing to wait
/// for, `awaitViewportSettled` would match on the first frame, and the whole
/// "resize before the stage mounts" guarantee would quietly evaporate.
///
/// So this reports the INTENDED geometry. It is the number the window is on its
/// way to, which is exactly what a wait wants.
fn logical_size<R: Runtime>(window: &WebviewWindow<R>, size: PhysicalSize<u32>) -> (f64, f64) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let scale = if scale > 0.0 { scale } else { 1.0 };
    (size.width as f64 / scale, size.height as f64 / scale)
}

/// Where the window should actually go back to.
///
/// Normally the saved position verbatim. The exception is the rig this exists
/// for: a take presented on a panel that has since been unplugged. The saved
/// coordinates are then somewhere no display covers any more, and putting a
/// window there — even a decorated one — hands the operator an app they cannot
/// see or click. So a position that no current monitor contains is replaced by
/// the top-left of the primary, which is visible by definition.
///
/// Containment is checked against the monitor's own rect rather than a margin:
/// a window whose ORIGIN is on a live display can always be dragged, which is
/// the only property that has to hold.
fn restore_position<R: Runtime>(
    app: &AppHandle<R>,
    frame: &ControlFrame,
) -> PhysicalPosition<i32> {
    let monitors = app.available_monitors().unwrap_or_default();
    let on_a_live_display = monitors.iter().any(|monitor| {
        let origin = monitor.position();
        let size = monitor.size();
        frame.position.x >= origin.x
            && frame.position.y >= origin.y
            && frame.position.x < origin.x.saturating_add(size.width as i32)
            && frame.position.y < origin.y.saturating_add(size.height as i32)
    });
    if on_a_live_display {
        return frame.position;
    }
    app.primary_monitor()
        .ok()
        .flatten()
        .or_else(|| monitors.into_iter().next())
        .map(|monitor| *monitor.position())
        .unwrap_or(frame.position)
}

/// Move the window onto the whole of the monitor it is currently on, without
/// decorations and above the menu bar. Answers with the size it is heading for.
fn apply_presentation<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
) -> Result<PhysicalSize<u32>, AppError> {
    /*
     * Black BEFORE the geometry moves, not after.
     *
     * This is the belt to borderless's braces. Borderless has no animation to
     * expose anything, but a resize is still a resize: the webview repaints
     * asynchronously, and whatever the compositor shows in the meantime is this
     * colour. Left at the OS default it is white — which is the exact artifact
     * this whole module exists to remove, arriving from the one direction the
     * geometry change does not cover.
     */
    let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 255)));

    /*
     * A maximized window ignores set_position/set_size on Windows and fights
     * them on macOS. Drop the state first so the bounds below are the ones that
     * actually land.
     *
     * Known and accepted: the frame was captured while still maximized, so what
     * it holds is the MAXIMIZED rect rather than the window's underlying restore
     * rectangle, and the geometry calls below overwrite the OS's own copy of the
     * latter. Un-presenting therefore gives back a maximized window — which is
     * what the operator had, and what they see — but a later unmaximize may land
     * somewhere other than where it would have. Reading the true restore rect
     * would mean unmaximizing first and waiting for it, and every geometry
     * setter here is delivered asynchronously, so "waiting for it" is a
     * main-thread round trip on the critical path of pressing Present. Not worth
     * it for a rectangle the operator sees only if they later restore down.
     */
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
    }
    /*
     * Defensive, and load-bearing for anyone upgrading across this change: a
     * window left in NATIVE fullscreen by the previous implementation cannot be
     * repositioned at all, so `set_position` below would be swallowed and the
     * take would open in a Space with a titlebar.
     */
    if window.is_fullscreen().unwrap_or(false) {
        let _ = window.set_fullscreen(false);
    }

    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        // Not `StageDisplayMissing`: its copy tells the operator the display
        // they SELECTED is gone and to choose another, and this path never
        // consults a selection — it uses whichever monitor the window is on. A
        // machine that reports no monitors at all is the same "could not
        // reshape this window" failure as the rest of them.
        .ok_or_else(|| presentation_failed("no monitor to present on"))?;

    let bounds = *monitor.size();
    window.set_decorations(false).map_err(presentation_failed)?;
    pin::above_everything(app, window)?;
    window
        .set_position(tauri::Position::Physical(*monitor.position()))
        .map_err(presentation_failed)?;
    // Inner size, and on a window with no decorations inner IS outer — which is
    // what makes filling the monitor's bounds exact rather than approximately
    // right by a titlebar.
    window
        .set_size(tauri::Size::Physical(bounds))
        .map_err(presentation_failed)?;
    Ok(bounds)
}

/// Putting the prompter above everything, and taking it back down.
///
/// ---------------------------------------------------------------------------
/// WHY macOS DOES NOT JUST CALL `set_always_on_top`
/// ---------------------------------------------------------------------------
/// Clearing the menu bar is the one thing OS fullscreen genuinely did better,
/// and dropping it without replacing it would have traded a white bar at the
/// top of the glass for a menu bar at the top of the glass.
///
/// tao implements `set_always_on_top(true)` as `NSFloatingWindowLevel`, which
/// is level 3. The menu bar draws at `NSMainMenuWindowLevel` (24) and the Dock
/// at `NSStatusWindowLevel` (25), so a "floating" window is comfortably
/// underneath both of them. The separate stage window has always had the same
/// gap and never showed it, because it opens on a SECONDARY display where
/// there is no menu bar to lose to — but single-window presentation runs on
/// whichever panel the operator dragged this window to, and that is very often
/// the primary one.
///
/// ---------------------------------------------------------------------------
/// AND WHY IT DOES NOT CALL IT *AS WELL*
/// ---------------------------------------------------------------------------
/// The obvious shape — `set_always_on_top(true)` for tao's bookkeeping, then
/// raise the level past it — is a race, and on the likely path a deterministic
/// loss. The two writes travel by DIFFERENT mechanisms: tao's
/// `set_level_async` posts a block to the GCD main queue, while Tauri's
/// `run_on_main_thread` sends a winit user message — and `send_user_message`
/// runs the closure INLINE when it is already on the main thread. So the
/// raise-to-26 can land first and tao's queued drop-to-3 then overwrites it,
/// putting the menu bar back over the prompter with nothing in the logs.
///
/// One writer, therefore. macOS sets the level itself and never calls
/// `set_always_on_top(true)`; nothing reads tao's flag (there is no
/// `is_always_on_top`), so there is no bookkeeping to keep in sync. The way
/// down is `set_always_on_top(false)` on every platform, which tao implements
/// as an unconditional `NSNormalWindowLevel` — level 0 — and that undoes a 26
/// exactly as well as it undoes a 3.
#[cfg(target_os = "macos")]
mod pin {
    use std::ffi::c_void;
    use std::os::raw::c_char;

    use tauri::{AppHandle, Runtime, WebviewWindow};

    use crate::errors::AppError;

    /// One above `NSStatusWindowLevel` (25), the higher of the menu bar's and
    /// the Dock's. Deliberately not something enormous: the point is to clear
    /// the system furniture, not to outrank screen savers and alert panels.
    const PROMPTER_WINDOW_LEVEL: isize = 26;

    #[link(name = "objc", kind = "dylib")]
    extern "C" {
        fn sel_registerName(name: *const c_char) -> *const c_void;
        fn objc_msgSend();
    }

    /// Raw FFI rather than an `objc2` dependency, matching `sleep.rs` — this is
    /// two selectors, and the crates that wrap them are in the tree only as
    /// tao's private business.
    pub fn above_everything<R: Runtime>(
        app: &AppHandle<R>,
        window: &WebviewWindow<R>,
    ) -> Result<(), AppError> {
        // AppKit window state must be mutated on the main thread; every tao
        // setter around this one is dispatched there for the same reason.
        //
        // The dispatch failure propagates; what happens INSIDE the closure
        // cannot, because it may run after this function has returned. So a
        // window that somehow has no `ns_window` logs rather than reports, and
        // the honest reading of a success here is "the raise was scheduled",
        // not "the prompter is above the menu bar".
        let window = window.clone();
        app.run_on_main_thread(move || {
            let ns_window = match window.ns_window() {
                Ok(ptr) => ptr,
                Err(error) => {
                    tracing::warn!(%error, "no NSWindow to raise above the menu bar");
                    return;
                }
            };
            if ns_window.is_null() {
                tracing::warn!("NSWindow handle was null; the menu bar may cover the prompter");
                return;
            }
            unsafe {
                let set_level: extern "C" fn(*mut c_void, *const c_void, isize) =
                    std::mem::transmute(objc_msgSend as *const ());
                set_level(
                    ns_window,
                    sel_registerName(c"setLevel:".as_ptr()),
                    PROMPTER_WINDOW_LEVEL,
                );
            }
        })?;
        Ok(())
    }
}

/// Everywhere else, always-on-top is the whole answer: Windows' `HWND_TOPMOST`
/// already sits above the taskbar, and X11/Wayland have no equivalent of the
/// macOS layering problem above.
#[cfg(not(target_os = "macos"))]
mod pin {
    use tauri::{AppHandle, Runtime, WebviewWindow};

    use crate::errors::AppError;

    pub fn above_everything<R: Runtime>(
        _app: &AppHandle<R>,
        window: &WebviewWindow<R>,
    ) -> Result<(), AppError> {
        window.set_always_on_top(true).map_err(presentation_failed)?;
        Ok(())
    }
}

/// Present (or un-present) the control window as the teleprompter.
///
/// Idempotent in both directions — see [`PresentAction`] for what each of the
/// four combinations means.
pub fn set_control_presenting<R: Runtime>(
    app: &AppHandle<R>,
    enabled: bool,
) -> Result<ControlPresentationState, AppError> {
    let window = control_window(app)?;
    let mut saved = lock();
    let target;

    match plan(saved.is_some(), enabled) {
        PresentAction::Enter => {
            *saved = Some(ControlFrame {
                position: window.outer_position().map_err(presentation_failed)?,
                inner_size: window.inner_size().map_err(presentation_failed)?,
                decorations: window.is_decorated().unwrap_or(true),
                maximized: window.is_maximized().unwrap_or(false),
            });
            /*
             * The frame is saved BEFORE this can fail, on purpose. A partial
             * apply — decorations gone, bounds not yet moved — is a window with
             * no titlebar, and the only thing that can give it back is the
             * frame. Losing it here to "not presenting" would be unrecoverable
             * without quitting, so the failure exits with the latch set and the
             * un-present that follows undoes whatever landed.
             */
            target = apply_presentation(app, &window)?;
            // The operator deliberately stops touching the keyboard for the
            // length of a take, which is exactly when the OS blanks the display
            // (§52.7).
            sleep::acquire(app);
        }
        PresentAction::Reassert => {
            target = apply_presentation(app, &window)?;
        }
        PresentAction::Restore => {
            let frame = *saved.as_ref().expect("Restore is only planned with a frame saved");
            /*
             * RESTORE, THEN FORGET — never the other way round.
             *
             * `saved.take()` first reads as tidier and is the one ordering that
             * cannot be recovered from. Every one of the calls below can fail,
             * and every frontend caller suppresses the error (they have to: the
             * un-present runs on teardown paths that must not themselves
             * throw). So a `take()` up front means one failed restore leaves an
             * undecorated, monitor-sized, always-on-top window AND throws away
             * the only description of what it used to be — the next un-present
             * plans `Nothing` and there is no way back but quitting.
             *
             * Holding the frame until every call has succeeded makes the
             * restore retryable instead: a failure leaves the latch set, so
             * pressing Escape again, ending the next take, or navigating away
             * all try it again with the same numbers.
             */
            window.set_always_on_top(false).map_err(presentation_failed)?;
            window
                .set_decorations(frame.decorations)
                .map_err(presentation_failed)?;
            window
                .set_position(tauri::Position::Physical(restore_position(app, &frame)))
                .map_err(presentation_failed)?;
            window
                .set_size(tauri::Size::Physical(frame.inner_size))
                .map_err(presentation_failed)?;
            *saved = None;
            sleep::release(app);
            if frame.maximized {
                let _ = window.maximize();
            }
            // Back to the OS default, so a resize of the EDITOR shows the
            // workspace theme's own light canvas rather than a black frame
            // around a light app.
            let _ = window.set_background_color(None);
            target = frame.inner_size;
        }
        PresentAction::Nothing => {
            // Idempotent, but the assertion is still released: it is shared with
            // the separate-stage path, and a leaked one keeps the display awake
            // for the rest of the run.
            sleep::release(app);
            target = window.inner_size().unwrap_or(PhysicalSize { width: 0, height: 0 });
        }
    }

    let (width, height) = logical_size(&window, target);
    Ok(ControlPresentationState { presenting: enabled, width, height })
}

/*
 * There is deliberately no `forget_control_presentation` here for the quit
 * path. The saved frame lives in this process and dies with it, and the only
 * thing that genuinely outlives the app is the display-sleep assertion — which
 * `app.rs` already releases on `ExitRequested`/`Exit`, for both this and the
 * separate-stage path. A second teardown hook would be a second thing to keep
 * in sync with no second thing to undo.
 */

#[cfg(test)]
mod tests {
    use super::*;

    /// The saved frame is a LATCH, not a stack.
    ///
    /// If a second present overwrote it, the frame saved would be the
    /// presenting one — monitor-sized and undecorated — and un-presenting would
    /// "restore" the window to full-screen-sized with no titlebar to grab. The
    /// operator's only way back would be to quit the app.
    #[test]
    fn presenting_twice_does_not_resave_the_frame() {
        assert_eq!(plan(false, true), PresentAction::Enter);
        assert_eq!(plan(true, true), PresentAction::Reassert);
    }

    /// Un-presenting a window that never presented is the ordinary shape of
    /// `startTake`'s failure paths, which call it without knowing how far the
    /// open got. It must not be an error and must not restore a frame that was
    /// never captured.
    #[test]
    fn un_presenting_twice_is_a_no_op_the_second_time() {
        assert_eq!(plan(true, false), PresentAction::Restore);
        assert_eq!(plan(false, false), PresentAction::Nothing);
    }
}
