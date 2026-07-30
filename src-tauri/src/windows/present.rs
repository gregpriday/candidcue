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

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow};

use crate::errors::AppError;

use super::{sleep, CONTROL_LABEL};

/// The two shapes a take can present in.
///
/// ---------------------------------------------------------------------------
/// WHY THIS IS A MODE AND NOT "FULL SCREEN, OFF"
/// ---------------------------------------------------------------------------
/// A window is not a smaller monitor. `Prompter` is the rig this module was
/// written for — borderless, monitor-sized, above the menu bar, read off glass
/// at a distance. `Reader` is somebody sitting down and reading a script off
/// their own screen: an ordinary window, at ordinary desk distance, with no
/// camera and no beamsplitter in the optical path.
///
/// Those differ in the viewing distance, in whether the picture is mirrored, in
/// whether a hood crops the glass, and in where the reading band belongs — all
/// of which the optical model reads from the rig profile rather than from here.
/// What THIS module owns is the four window facts: chrome, layering, geometry
/// and the minimum size. See `docs/CandidCue_Reader_Mode_Specification.md`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PresentMode {
    Prompter,
    Reader,
}

/// The reader window's floor, in logical pixels.
///
/// The control window's resting minimum is sized for the EDITOR (980x680 in
/// `tauri.conf.json`), and a reader may reasonably want something narrower — a
/// tall strip beside a video call.
///
/// Derived rather than picked, and worked at the SIZE READER MODE ACTUALLY USES
/// when it has no calibration, which is `UNCALIBRATED_READER_FONT_SIZE_PX` (30
/// CSS px) rather than whatever a calibrated rig resolves to. That is the
/// conservative direction: 30 px is larger than the 27.4 px a calibrated
/// 550 mm rig produces at the standard 24', so a floor that fits 30 px type also
/// fits anything a calibrated reading window will ask for.
///
/// Width: the 30-character reader floor at 30 px is 30 x 0.5 x 30 = 450 px of
/// column, and `MAX_COLUMN_FRACTION` (0.92) turns that into ~489 px. 520 leaves
/// a little over.
///
/// Height: `TARGET_VISIBLE_LINES` (5) at a 30 px x 1.38 = 41.4 px pitch is 207
/// px, and the rest is the fades and the band's own padding.
///
/// Applied on the way into `Reader` and taken away again on the way out, so the
/// editor never inherits it.
const READER_MIN_WIDTH_PX: f64 = 520.0;
const READER_MIN_HEIGHT_PX: f64 = 360.0;

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
///
/// One caveat on the paragraph above, now that [`chrome`] exists: under
/// `FullSizeContentView` the inner and outer HEIGHTS coincide, so on macOS today
/// the outer/inner mix-up it warns about would not actually show. The 32pt-per-
/// cycle growth that WAS observed came from the mask instead — snapshotting the
/// inner size under one mask and restoring it under another. The warning stands
/// as written for any window without that bit; it is simply not the whole story.
///
/// `decorations` is a bool because that is all tao's flag can say, and on macOS
/// that is not enough to describe the chrome — see [`chrome`], which snapshots
/// the real `NSWindowStyleMask` instead and leaves this field to the platforms
/// where the bool IS the whole state.
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
/// display server. Every idempotent case is named rather than folded into the
/// others, because they do genuinely different things.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PresentAction {
    /// Not presenting, asked to present: save the resting frame, then apply.
    Enter(PresentMode),
    /// Already presenting in this mode, asked again: re-apply it (the display
    /// may have been rearranged mid-take) WITHOUT touching the resting frame.
    Reassert(PresentMode),
    /// Presenting, asked for the OTHER mode. Mid-take, on the presenter's
    /// command — see [`set_control_presenting`] for what each direction moves.
    Switch(PresentMode),
    /// Presenting, asked to stop: restore the resting frame and drop it.
    Restore,
    /// Not presenting, asked to stop. `startTake`'s failure paths un-present
    /// unconditionally without knowing how far the open got, so this is the
    /// ordinary case rather than a defect.
    Nothing,
}

/// `None` means "not presenting" on both sides.
pub fn plan(current: Option<PresentMode>, want: Option<PresentMode>) -> PresentAction {
    match (current, want) {
        (None, Some(mode)) => PresentAction::Enter(mode),
        (Some(from), Some(to)) if from == to => PresentAction::Reassert(to),
        (Some(_), Some(to)) => PresentAction::Switch(to),
        (Some(_), None) => PresentAction::Restore,
        (None, None) => PresentAction::Nothing,
    }
}

/// Everything a presenting window has to remember.
///
/// ---------------------------------------------------------------------------
/// TWO FRAMES, AND WHY THEY ARE NOT ONE
/// ---------------------------------------------------------------------------
/// `resting` is the pre-take frame. It is written ONCE, by `Enter`, and no
/// later transition may overwrite it — that is the latch-not-a-stack rule this
/// module already had, and `presenting_twice_does_not_resave_the_frame` is its
/// test. A `Restore` always replays it, so un-presenting always gives back a
/// legitimate resting window.
///
/// `reader` is separate because [`PresentMode::Reader`] made the rule ambiguous
/// for the first time. Reader mode is itself a RESTING shape — chrome on,
/// ordinary bounds — so a reader who drags their window somewhere and then pops
/// out to `Prompter` and back expects to land where they left it. The naive fix
/// is to re-capture `resting` on the way out of reader mode, and it is wrong:
/// reader mode lowers the window's minimum size (see [`READER_MIN_WIDTH_PX`]),
/// so those bounds can be smaller than the editor's own minimum, and a
/// `Restore` replaying them would hand the editor a window the OS then clamps
/// — or, worse, an editor at 520x360.
///
/// So the reader's bounds get their own home, `resting` keeps its original
/// promise verbatim, and neither has to know about the other.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PresentState {
    resting: ControlFrame,
    /// Which mode is applied over `resting` right now.
    mode: PresentMode,
    /// The reader window's own bounds, once it has had any.
    reader: Option<ControlFrame>,
}

/// The presentation state, or `None` when the window is not presenting.
///
/// A module-level static rather than coordinator state, for the same reason
/// [`sleep`] uses one: it is a property of the OS window, it has to survive
/// every path that can end a take (including a renderer that reloads
/// mid-session), and nothing else in the app has any business reading it.
fn saved_frame() -> &'static std::sync::Mutex<Option<PresentState>> {
    static STATE: std::sync::OnceLock<std::sync::Mutex<Option<PresentState>>> =
        std::sync::OnceLock::new();
    STATE.get_or_init(|| std::sync::Mutex::new(None))
}

fn lock() -> std::sync::MutexGuard<'static, Option<PresentState>> {
    match saved_frame().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// The window's frame as it stands right now.
///
/// Every read here is a plain getter with no setter in front of it, so unlike
/// the intended-geometry note on [`logical_size`] these values are current
/// rather than pending.
fn measure_frame<R: Runtime>(window: &WebviewWindow<R>) -> Result<ControlFrame, AppError> {
    Ok(ControlFrame {
        position: window.outer_position().map_err(presentation_failed)?,
        inner_size: window.inner_size().map_err(presentation_failed)?,
        decorations: window.is_decorated().unwrap_or(true),
        maximized: window.is_maximized().unwrap_or(false),
    })
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
    /// The mode now applied, or `None` when the window is not presenting.
    ///
    /// Reported rather than assumed, because the mid-take toggle means the
    /// renderer's idea of the mode and the window's can come apart — a `Switch`
    /// that failed halfway leaves the window in one mode while the store still
    /// believes the other, and the store adopting the answer is what keeps the
    /// dock's toggle telling the truth.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<PresentMode>,
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

/// The minimum size the control window was DECLARED with, in logical pixels.
///
/// Read out of the app config rather than named as a constant here, because that
/// is where the window actually got it (`tauri.conf.json`) and because Tauri
/// exposes no `min_inner_size()` getter to snapshot it from — so the alternative
/// is a literal in this file that silently stops matching the day somebody
/// resizes the editor's floor. `None` when the config declares no minimum, which
/// is also the correct thing to hand `set_min_size`.
fn declared_min_size<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::LogicalSize<f64>> {
    let window = app
        .config()
        .app
        .windows
        .iter()
        .find(|candidate| candidate.label == CONTROL_LABEL)?;
    /*
     * Each axis independently, because the config can declare one without the
     * other.
     *
     * This used to require BOTH and answer `None` otherwise, which is a quiet
     * trap rather than a conservative default: `set_min_size(None)` does not mean
     * "leave the floor alone", it CLEARS it. So a future `tauri.conf.json` that
     * dropped `minHeight` — a perfectly ordinary thing to do — would have left the
     * editor with no width floor either, permanently, the first time anybody used
     * reader mode. A missing axis takes 0, which is what "no constraint on this
     * axis" actually is.
     */
    match (window.min_width, window.min_height) {
        (None, None) => None,
        (width, height) => Some(tauri::LogicalSize {
            width: width.unwrap_or(0.0),
            height: height.unwrap_or(0.0),
        }),
    }
}

fn set_min_size<R: Runtime>(window: &WebviewWindow<R>, size: Option<tauri::LogicalSize<f64>>) {
    // Never fatal. A floor that did not apply is a window that can be dragged
    // smaller than is comfortable — which is a cosmetic disappointment, not a
    // reason to refuse to present.
    let _ = window.set_min_size(size.map(tauri::Size::Logical));
}

/// Present in place: this window, where it is, at the size it is.
///
/// ---------------------------------------------------------------------------
/// WHY THIS MOVES NO GEOMETRY AT ALL
/// ---------------------------------------------------------------------------
/// The operator put this window somewhere and made it a size. That IS the
/// gesture — the same argument the module header makes about not teleporting the
/// window to a pinned display fingerprint, and it applies twice as hard here,
/// because a reader chose their window's shape on purpose and a prompter merely
/// chose its panel.
///
/// So this sets everything about a reading window EXCEPT where it is: the black
/// backing, the lowered floor, an ordinary titlebar, and not being pinned above
/// other applications (a reading window that floated over everything would be
/// unusable for the one thing people read scripts beside).
///
/// ---------------------------------------------------------------------------
/// AND WHY IT UNDOES THE PROMPTER'S CHROME AND PINNING EVERY TIME
/// ---------------------------------------------------------------------------
/// It would be enough, for `Enter(Reader)`, to do nothing about either: a window
/// that has never presented is already decorated and already unpinned.
///
/// `Reassert` is why it does them anyway. Its whole purpose is "re-apply the
/// current mode, because the world may have moved under it", and the prompter's
/// `apply_presentation` does that completely — it re-strips, re-pins and
/// re-bounds. A reader equivalent that only set a colour and a floor could not
/// recover from a `Switch` that failed halfway, and that is a reachable state:
/// every mutation below `?`-propagates, so a `Switch(→Reader)` whose
/// `set_always_on_top(false)` failed would leave a pinned, borderless window that
/// no later `Reassert` would ever un-pin.
///
/// Both calls are idempotent, which is what makes this free: `set_always_on_top`
/// is an unconditional level write, and `chrome::restore` silently does nothing
/// once the mask latch is empty.
fn apply_reader<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
    decorations: bool,
) -> Result<PhysicalSize<u32>, AppError> {
    /*
     * Black, for the same reason the prompter path sets it — and it is NOT
     * redundant here just because nothing below moves the window.
     *
     * A reader resizes by dragging an edge, which is a geometry change the
     * webview repaints asynchronously exactly like the prompter's one-off move.
     * Left at the OS default the strip the layout has not reached yet is white,
     * and it would flash on every drag rather than once per take.
     */
    let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 255)));
    window.set_always_on_top(false).map_err(presentation_failed)?;
    chrome::restore(app, window, decorations)?;
    set_min_size(
        window,
        Some(tauri::LogicalSize {
            width: READER_MIN_WIDTH_PX,
            height: READER_MIN_HEIGHT_PX,
        }),
    );
    /*
     * The CURRENT inner size, and this is the one place in this module where
     * reading it back is correct.
     *
     * `logical_size`'s note warns that a size read straight after `set_size`
     * describes the window the setter has not moved yet. Nothing above is a
     * geometry setter — `set_min_size` cannot enlarge a window that already
     * satisfies the editor's larger floor, which every window reaching here
     * does — so there is no pending change to be stale about. And this is
     * precisely the number `awaitViewportSettled` should match on its first
     * check, which is what makes entering reader mode instant.
     */
    window.inner_size().map_err(presentation_failed)
}

/// Put the window back into an ordinary decorated frame at a known rectangle.
///
/// Shared by `Restore` and by the `Prompter → Reader` half of a `Switch`, which
/// do the same four things to the window and differ only in which frame they
/// replay, which floor they leave behind, and whether the latch survives.
///
/// The floor is applied BEFORE the size, and the ordering is load-bearing: a
/// reader may have dragged their window below the editor's declared minimum (the
/// whole point of [`READER_MIN_WIDTH_PX`]), so restoring those bounds under the
/// editor's floor would have the OS clamp them straight back up.
fn apply_windowed<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
    frame: &ControlFrame,
    min_size: Option<tauri::LogicalSize<f64>>,
) -> Result<PhysicalSize<u32>, AppError> {
    window.set_always_on_top(false).map_err(presentation_failed)?;
    chrome::restore(app, window, frame.decorations)?;
    set_min_size(window, min_size);
    window
        .set_position(tauri::Position::Physical(restore_position(app, frame)))
        .map_err(presentation_failed)?;
    window
        .set_size(tauri::Size::Physical(frame.inner_size))
        .map_err(presentation_failed)?;
    if frame.maximized {
        let _ = window.maximize();
    }
    Ok(frame.inner_size)
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
    /*
     * Give the declared floor back, in case we are arriving from reader mode.
     *
     * A monitor-sized window is never near any minimum, so this changes nothing
     * about what the presenter sees. It exists so the lowered reader floor
     * cannot outlive the mode that wanted it: `Restore` from prompter would
     * otherwise leave the editor draggable down to 520x360, which is a state
     * nothing in this app is laid out for and which nothing would ever put back.
     */
    set_min_size(window, declared_min_size(app));
    chrome::strip(app, window)?;
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

    // `C-unwind` for the reason the same block in `chrome` spells out: an
    // Objective-C method can raise, and an exception crossing a boundary declared
    // non-unwinding aborts instead of unwinding.
    #[link(name = "objc", kind = "dylib")]
    extern "C-unwind" {
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
                let set_level: extern "C-unwind" fn(*mut c_void, *const c_void, isize) =
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

/// Taking the window's chrome off for a take, and putting back EXACTLY what was
/// there before.
///
/// ---------------------------------------------------------------------------
/// WHY macOS DOES NOT CALL `set_decorations`
/// ---------------------------------------------------------------------------
/// It did, and that is what left the titlebar dark for the rest of the run.
///
/// Tauri gives every macOS window built with the DEFAULT `titleBarStyle`
/// (`TitleBarStyle::Visible`) `NSWindowStyleMaskFullSizeContentView`, which it
/// sets unconditionally to work around a devtools resize artifact. That covers
/// every window this app opens, since none of them set `titleBarStyle` — but it
/// is a property of the style, not of macOS, which is why the restore below reads
/// the real mask instead of assuming this one. It is not cosmetic. With the content
/// view running the full height of the window, the webview is underneath the
/// titlebar, and macOS draws the titlebar over it — so the bar reads as the
/// app's own warm paper and the window looks like one surface. Drop that single
/// bit and the same window gets ordinary opaque system chrome instead: dark, on
/// a machine in Dark Mode, sitting above a light editor. That is the whole
/// symptom, and nothing about it is recoverable from inside the page.
///
/// tao's `set_decorations(true)` rebuilds the mask from a fixed set —
/// `Closable | Miniaturizable | Resizable | Titled` — so it cannot put back a
/// bit it does not model. Re-adding the bit afterwards does not work either, for
/// the same reason `pin` does not stack two writers: `set_decorations` applies
/// its mask through tao's `set_style_mask_ASYNC` (a block on the GCD main
/// queue), while `set_fullsize_content_view` applies its own through
/// `set_style_mask_SYNC` (inline, when it is already on the main thread). The
/// inline write lands first and the queued rebuild overwrites it, so the
/// titlebar comes back dark anyway with nothing in the logs.
///
/// One writer, therefore. This module owns the style mask outright and reads the
/// resting value off the window rather than reconstructing it, which means a
/// future `titleBarStyle` change in `tauri.conf.json` is restored correctly
/// without anybody remembering this file exists.
///
/// The cost is that tao's own `decorations` flag is never updated, so
/// `is_decorated()` keeps reporting the resting state (decorated) for the length
/// of a take. Harmless: tao reads that flag nowhere but `set_decorations`'s
/// early-out and the getter, and the only caller in this app is the frame
/// snapshot, which wants the resting value.
#[cfg(target_os = "macos")]
mod chrome {
    use std::ffi::c_void;
    use std::os::raw::c_char;

    use tauri::{AppHandle, Runtime, WebviewWindow};

    use crate::errors::AppError;

    /// The presenting mask: no titlebar, still resizable.
    ///
    /// `NSWindowStyleMaskBorderless` is zero, so this is only the resizable bit
    /// — which is what tao's own `set_decorations(false)` reduces to for a
    /// resizable window, and the control window is one.
    const BORDERLESS_RESIZABLE: usize = 1 << 3;

    /// `NSWindowStyleMaskFullScreen`, which must never be latched.
    ///
    /// `apply_presentation` asks a natively-fullscreen window to leave fullscreen
    /// just above the call into this module, and `set_fullscreen(false)` is
    /// asynchronous — AppKit animates out over about half a second. So the mask
    /// read here can still carry this bit, and writing it back on restore would
    /// hand AppKit a window claiming to be fullscreen when it is not. Setting the
    /// bit by hand is not how a window enters fullscreen and AppKit does not treat
    /// it as such.
    ///
    /// KNOWN GAP, and it is the reason this constant exists rather than a wait:
    /// tao's `set_decorations` returns early while fullscreen and re-applies from
    /// `windowDidExitFullScreen`, which is the correct shape and needs a delegate
    /// this module does not have. Presenting DURING the exit animation can
    /// therefore still lose the borderless mask to AppKit's own restoration when
    /// the transition completes, leaving a titlebar on the glass until `Reassert`
    /// or the next Present. Normalising the latch bounds the damage to that take:
    /// what gets put back afterwards is always a legitimate resting mask.
    const FULLSCREEN: usize = 1 << 14;

    /// The mask worth remembering, given the one AppKit read.
    ///
    /// Separated from [`remember`] because it is a different question — "is this
    /// value even a resting mask?" rather than "have we already got one?" — and
    /// because it is the half that is testable.
    fn resting(mask: usize) -> usize {
        mask & !FULLSCREEN
    }

    // `extern "C-unwind"`, not `extern "C"`, because an Objective-C method can
    // raise — `objc2` declares the whole message-send family this way for that
    // reason. `makeFirstResponder:` runs arbitrary responder hooks and
    // `setStyleMask:` runs AppKit's frame-view rebuild, so an exception crossing a
    // boundary declared non-unwinding is reachable rather than theoretical, and it
    // would abort instead of unwinding.
    #[link(name = "objc", kind = "dylib")]
    extern "C-unwind" {
        fn sel_registerName(name: *const c_char) -> *const c_void;
        fn objc_msgSend();
    }

    /// `objc_msgSend` as a typed call. One transmute helper per shape, so the
    /// signatures sit next to each other and can be read against the selectors.
    ///
    /// `id`-returning and `void`-returning are separate types on purpose: the
    /// return type is part of the ABI contract, and getting it from the wrong
    /// shape is exactly the class of mistake that only shows up as corruption.
    unsafe fn msg_id(receiver: *mut c_void, selector: *const c_void) -> *mut c_void {
        let send: extern "C-unwind" fn(*mut c_void, *const c_void) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        send(receiver, selector)
    }

    unsafe fn msg_void(receiver: *mut c_void, selector: *const c_void) {
        let send: extern "C-unwind" fn(*mut c_void, *const c_void) =
            std::mem::transmute(objc_msgSend as *const ());
        send(receiver, selector)
    }

    /// `NSUInteger` is `usize`, matching `pin`'s `NSInteger`/`isize` for
    /// `setLevel:`.
    unsafe fn msg_uint(receiver: *mut c_void, selector: *const c_void) -> usize {
        let send: extern "C-unwind" fn(*mut c_void, *const c_void) -> usize =
            std::mem::transmute(objc_msgSend as *const ());
        send(receiver, selector)
    }

    unsafe fn msg_with_uint(receiver: *mut c_void, selector: *const c_void, value: usize) {
        let send: extern "C-unwind" fn(*mut c_void, *const c_void, usize) =
            std::mem::transmute(objc_msgSend as *const ());
        send(receiver, selector, value)
    }

    /// Returns `i8` rather than `bool` deliberately. Objective-C `BOOL` is C
    /// `_Bool` on arm64 but `signed char` on Intel, and a `signed char` holding
    /// anything but 0 or 1 read as a Rust `bool` is undefined behaviour. `i8`
    /// compared against zero is correct on both, which matters the day this is
    /// built as a universal binary.
    unsafe fn msg_with_id_returning_bool(
        receiver: *mut c_void,
        selector: *const c_void,
        argument: *mut c_void,
    ) -> i8 {
        let send: extern "C-unwind" fn(*mut c_void, *const c_void, *mut c_void) -> i8 =
            std::mem::transmute(objc_msgSend as *const ());
        send(receiver, selector, argument)
    }

    /// The resting style mask, or `None` when the window is not presenting.
    ///
    /// Deliberately separate from the saved frame rather than a field on it. The
    /// mask has to be READ from the window, `styleMask` is main-thread-only, and
    /// `run_on_main_thread` cannot hand a value back — so the read and the write
    /// both happen inside the closure, which needs somewhere of its own to put
    /// the answer.
    fn saved_mask() -> &'static std::sync::Mutex<Option<usize>> {
        static STATE: std::sync::OnceLock<std::sync::Mutex<Option<usize>>> =
            std::sync::OnceLock::new();
        STATE.get_or_init(|| std::sync::Mutex::new(None))
    }

    fn lock() -> std::sync::MutexGuard<'static, Option<usize>> {
        match saved_mask().lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    /// What to latch when stripping the chrome.
    ///
    /// Pure and separated for the same reason [`super::plan`] is: it is the one
    /// piece of judgement in this module that can be wrong in a way no type
    /// catches, and it cannot be exercised at all through `setStyleMask:`
    /// without a window server.
    fn remember(saved: Option<usize>, resting: usize) -> Option<usize> {
        saved.or(Some(resting))
    }

    unsafe fn style_mask(ns_window: *mut c_void) -> usize {
        msg_uint(ns_window, sel_registerName(c"styleMask".as_ptr()))
    }

    /// Set the mask, and keep the keyboard.
    ///
    /// AppKit rebuilds the window's frame view whenever the mask gains or loses
    /// `Titled`, and the first responder does not survive it — tao's own helper
    /// re-points it at the content view for exactly this reason, with the comment
    /// "if we don't do this, key handling will break". It matters more here than
    /// it does there: the keyboard is how a presenter gets OUT of a take, so a
    /// dropped responder means Escape does nothing.
    ///
    /// ---------------------------------------------------------------------------
    /// WHY THE PREVIOUS RESPONDER IS RETAINED, AND WHY THERE IS A FLOOR
    /// ---------------------------------------------------------------------------
    /// Handing the keyboard back to whatever had it is better than naming a view —
    /// it preserves focus rather than resetting it — but the pointer needs care in
    /// both directions.
    ///
    /// `NSWindow.firstResponder` is declared `weak` and comes back `+0`, and the
    /// frame view AppKit is about to rebuild may be the responder's last owner. So
    /// the read is retained ACROSS `setStyleMask:`; without that,
    /// `makeFirstResponder:` can be messaging freed memory.
    ///
    /// And it can legitimately refuse: a responder that WAS part of the rebuilt
    /// frame view is no longer in the window, so it answers `NO`. `content_view`
    /// is the floor for that case — the window owns it, so it is always there to
    /// take the keyboard. It is second rather than first because it is a reset,
    /// not a restore.
    unsafe fn set_style_mask(ns_window: *mut c_void, content_view: *mut c_void, mask: usize) {
        let previous = msg_id(ns_window, sel_registerName(c"firstResponder".as_ptr()));
        if !previous.is_null() {
            msg_id(previous, sel_registerName(c"retain".as_ptr()));
        }

        msg_with_uint(
            ns_window,
            sel_registerName(c"setStyleMask:".as_ptr()),
            mask,
        );

        let make_first_responder = sel_registerName(c"makeFirstResponder:".as_ptr());
        let restored = !previous.is_null()
            && msg_with_id_returning_bool(ns_window, make_first_responder, previous) != 0;
        if !previous.is_null() {
            msg_void(previous, sel_registerName(c"release".as_ptr()));
        }

        if !restored && !content_view.is_null() {
            msg_with_id_returning_bool(ns_window, make_first_responder, content_view);
        }
    }

    /// Run `apply` against this window's `NSWindow` and content view, on the main
    /// thread.
    ///
    /// The dispatch failure propagates; what happens INSIDE the closure cannot,
    /// because it may run after this function has returned. Same honesty as
    /// `pin::above_everything`: a success here means the change was scheduled. In
    /// practice it means more than that — `set_control_presenting` is reached from
    /// the IPC handler on the main thread, where Tauri runs the closure INLINE —
    /// but the weaker claim is the one the signature can actually keep.
    ///
    /// Neither pointer escapes: both are read inside the closure and consumed
    /// inside it, so nothing raw crosses a thread and the `Send` bound applies
    /// only to whatever `apply` captures.
    fn on_ns_window<R, F>(
        app: &AppHandle<R>,
        window: &WebviewWindow<R>,
        what: &'static str,
        apply: F,
    ) -> Result<(), AppError>
    where
        R: Runtime,
        F: FnOnce(*mut c_void, *mut c_void) + Send + 'static,
    {
        let window = window.clone();
        app.run_on_main_thread(move || {
            let ns_window = match window.ns_window() {
                Ok(ptr) => ptr,
                Err(error) => {
                    tracing::warn!(%error, "no NSWindow to {what}");
                    return;
                }
            };
            if ns_window.is_null() {
                tracing::warn!("NSWindow handle was null; could not {what}");
                return;
            }
            // Only the keyboard floor, so a window that cannot report one still
            // gets its mask changed — `set_style_mask` treats null as "no floor".
            let content_view = window.ns_view().unwrap_or(std::ptr::null_mut());
            apply(ns_window, content_view);
        })
        .map_err(super::presentation_failed)
    }

    /// Borderless, remembering what to put back.
    pub fn strip<R: Runtime>(
        app: &AppHandle<R>,
        window: &WebviewWindow<R>,
    ) -> Result<(), AppError> {
        on_ns_window(
            app,
            window,
            "take the titlebar off",
            |ns_window, content_view| unsafe {
                let mut saved = lock();
                // A LATCH, not a stack, for the same reason the frame is one:
                // `Reassert` re-applies the presentation mid-take, and saving then
                // would record the BORDERLESS mask as the thing to restore — so
                // un-presenting would hand back a window with no titlebar to grab.
                *saved = remember(*saved, resting(style_mask(ns_window)));
                set_style_mask(ns_window, content_view, BORDERLESS_RESIZABLE);
            },
        )
    }

    /// The resting chrome, exactly as it was.
    ///
    /// `decorations` is the non-macOS path's business: here the saved mask
    /// already describes the titlebar, the traffic lights and the full-size
    /// content view in one value.
    pub fn restore<R: Runtime>(
        app: &AppHandle<R>,
        window: &WebviewWindow<R>,
        _decorations: bool,
    ) -> Result<(), AppError> {
        on_ns_window(
            app,
            window,
            "put the titlebar back",
            |ns_window, content_view| unsafe {
                // Nothing latched means nothing is left to put back — either no
                // strip ever happened (`startTake`'s failure paths un-present
                // without knowing how far the open got) or an earlier restore
                // already consumed it. Both are ordinary rather than a defect,
                // which is why this is silent.
                if let Some(mask) = lock().take() {
                    set_style_mask(ns_window, content_view, mask);
                }
            },
        )
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// `NSWindowStyleMaskFullSizeContentView`. Not a constant this module
        /// sets — it is named here only so the test can say what the bug was.
        const FULL_SIZE_CONTENT_VIEW: usize = 1 << 15;

        /// The four bits tao's `set_decorations(true)` rebuilds a mask from.
        const TAO_DECORATED: usize = 0b1111;

        /// The whole defect, as an assertion: bits this module does not model
        /// have to survive the round trip.
        ///
        /// `FullSizeContentView` is the one that mattered — it is what puts the
        /// webview under the titlebar and makes the bar read as the app's own
        /// paper — but the assertion is deliberately about ANY unmodelled bit,
        /// because the failure was not "we forgot bit 15", it was "we rebuilt the
        /// mask from a list". A restore that reconstructs rather than replays
        /// fails this for whatever the next such bit turns out to be.
        #[test]
        fn latching_replays_unmodelled_bits_rather_than_rebuilding_them() {
            let exotic = 1 << 20;
            let resting_mask = FULL_SIZE_CONTENT_VIEW | exotic | TAO_DECORATED;
            let latched = remember(None, resting(resting_mask)).expect("first strip latches");
            assert_eq!(latched, resting_mask);
            // What `set_decorations(true)` would have produced instead.
            assert_ne!(latched, TAO_DECORATED);
        }

        /// Presenting twice must not re-latch: the second strip reads the
        /// BORDERLESS mask off the window, and remembering that would leave
        /// un-presenting with no titlebar to hand back.
        #[test]
        fn stripping_twice_does_not_relatch_the_mask() {
            let resting_mask = FULL_SIZE_CONTENT_VIEW | TAO_DECORATED;
            let once = remember(None, resting_mask);
            assert_eq!(remember(once, BORDERLESS_RESIZABLE), Some(resting_mask));
        }

        /// A window asked to leave NATIVE fullscreen a moment ago can still read
        /// back as fullscreen, because `set_fullscreen(false)` is asynchronous.
        /// Latching that bit would mean handing it back on restore, telling AppKit
        /// the window is fullscreen when it is not.
        #[test]
        fn a_fullscreen_mask_is_never_latched_as_resting() {
            let mid_transition = FULLSCREEN | FULL_SIZE_CONTENT_VIEW | TAO_DECORATED;
            let latched = remember(None, resting(mid_transition)).expect("first strip latches");
            assert_eq!(latched & FULLSCREEN, 0);
            // Everything else about the window is still the thing to put back.
            assert_eq!(latched, FULL_SIZE_CONTENT_VIEW | TAO_DECORATED);
        }
    }
}

/// Everywhere else the decorations flag is the whole story, and tao's own
/// bookkeeping is the right owner of it.
#[cfg(not(target_os = "macos"))]
mod chrome {
    use tauri::{AppHandle, Runtime, WebviewWindow};

    use crate::errors::AppError;

    use super::presentation_failed;

    pub fn strip<R: Runtime>(
        _app: &AppHandle<R>,
        window: &WebviewWindow<R>,
    ) -> Result<(), AppError> {
        window.set_decorations(false).map_err(presentation_failed)
    }

    pub fn restore<R: Runtime>(
        _app: &AppHandle<R>,
        window: &WebviewWindow<R>,
        decorations: bool,
    ) -> Result<(), AppError> {
        window
            .set_decorations(decorations)
            .map_err(presentation_failed)
    }
}

/// Everywhere else, always-on-top is the whole answer: Windows' `HWND_TOPMOST`
/// already sits above the taskbar, and X11/Wayland have no equivalent of the
/// macOS layering problem above.
#[cfg(not(target_os = "macos"))]
mod pin {
    use tauri::{AppHandle, Runtime, WebviewWindow};

    use crate::errors::AppError;

    // A child module does not inherit the parent's names, and without this the
    // whole arm is an unresolved-name error — so no non-macOS target has ever
    // compiled this file. Fixed in passing while adding the sibling `chrome` arm,
    // which would otherwise have been written to match something broken.
    use super::presentation_failed;

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
/// `mode` is the shape to present in and `None` means "stop". Idempotent in
/// every direction — see [`PresentAction`] for what each of the five
/// combinations means, and [`PresentState`] for why there are two frames.
pub fn set_control_presenting<R: Runtime>(
    app: &AppHandle<R>,
    mode: Option<PresentMode>,
) -> Result<ControlPresentationState, AppError> {
    let window = control_window(app)?;
    let mut saved = lock();
    let target;

    match plan(saved.map(|state| state.mode), mode) {
        PresentAction::Enter(entering) => {
            *saved = Some(PresentState {
                resting: measure_frame(&window)?,
                mode: entering,
                reader: None,
            });
            /*
             * The frame is saved BEFORE this can fail, on purpose. A partial
             * apply — decorations gone, bounds not yet moved — is a window with
             * no titlebar, and the only thing that can give it back is the
             * frame. Losing it here to "not presenting" would be unrecoverable
             * without quitting, so the failure exits with the latch set and the
             * un-present that follows undoes whatever landed.
             */
            let decorations = saved.as_ref().expect("just written").resting.decorations;
            target = match entering {
                PresentMode::Prompter => apply_presentation(app, &window)?,
                PresentMode::Reader => apply_reader(app, &window, decorations)?,
            };
            /*
             * The operator deliberately stops touching the keyboard for the
             * length of a take, which is exactly when the OS blanks the display
             * (§52.7).
             *
             * Held in READER mode too, and deliberately. The argument in
             * `sleep.rs` is about somebody who stops touching the keyboard for
             * twenty minutes, and that is MORE true of reading than of
             * presenting, not less — a reader's hands are nowhere near the
             * trackpad while the script follows their voice.
             */
            sleep::acquire(app);
        }
        PresentAction::Reassert(current) => {
            let decorations = saved.as_ref().expect("Reassert is only planned while presenting").resting.decorations;
            target = match current {
                PresentMode::Prompter => apply_presentation(app, &window)?,
                PresentMode::Reader => apply_reader(app, &window, decorations)?,
            };
        }
        PresentAction::Switch(to) => {
            /*
             * ------------------------------------------------------------------
             * THE MODE IS COMMITTED ONLY ONCE THE WINDOW HAS ACTUALLY CHANGED
             * ------------------------------------------------------------------
             * Writing `state.mode` before the apply reads as harmless and is not.
             * Every mutation below `?`-propagates, so a `Switch` can fail partway
             * — and a latch that already says the new mode turns the retry into a
             * `Reassert` of a mode the window is not in.
             *
             * That is survivable for the prompter direction, because
             * `apply_presentation` re-does everything unconditionally. It was NOT
             * survivable for the reader direction until `apply_reader` learned to
             * un-pin and restore the chrome as well: the frontend still believed
             * `prompter`, so pressing the chord again asked for reader, Rust
             * planned `Reassert(Reader)`, and the window stayed borderless and
             * pinned while control composed a reading window's geometry for it.
             *
             * Both halves of that are fixed — the ordering here and the
             * idempotence there — because either alone leaves the other's failure
             * mode reachable.
             */
            let existing = *saved.as_ref().expect("Switch is only planned while presenting");
            match to {
                PresentMode::Prompter => {
                    /*
                     * Record where the reader had their window before it goes.
                     *
                     * Into `reader`, never into `resting` — see [`PresentState`].
                     * Measured before anything moves, because after
                     * `apply_presentation` the window IS the monitor and there
                     * would be nothing left to remember. Saved to the latch
                     * immediately too: losing the reader's bounds to a failed
                     * apply would strand them at the resting frame on the way
                     * back, and remembering a rectangle costs nothing if the
                     * switch then fails.
                     */
                    let reader_frame = measure_frame(&window)?;
                    if let Some(state) = saved.as_mut() {
                        state.reader = Some(reader_frame);
                    }
                    target = apply_presentation(app, &window)?;
                }
                PresentMode::Reader => {
                    /*
                     * Back to the reader's own bounds, or — the first time, when
                     * the take opened straight into prompter mode and the reader
                     * has never had a window — to the resting frame, which is the
                     * only rectangle anybody has expressed a preference about.
                     */
                    let frame = existing.reader.unwrap_or(existing.resting);
                    let reader_min = tauri::LogicalSize {
                        width: READER_MIN_WIDTH_PX,
                        height: READER_MIN_HEIGHT_PX,
                    };
                    target = apply_windowed(app, &window, &frame, Some(reader_min))?;
                    // The backing stays black across the switch (the take is
                    // still running), so there is nothing to set here that
                    // `Enter` has not already set.
                }
            }
            if let Some(state) = saved.as_mut() {
                state.mode = to;
            }
        }
        PresentAction::Restore => {
            let frame = saved.as_ref().expect("Restore is only planned while presenting").resting;
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
            target = apply_windowed(app, &window, &frame, declared_min_size(app))?;
            *saved = None;
            sleep::release(app);
            /*
             * Back to the OS default, so the take's black is not left behind the
             * editor.
             *
             * The comment here used to say this restores "the workspace theme's
             * own light canvas". It does not: `None` gives back the dynamic
             * `windowBackgroundColor`, which resolves DARK on a machine in Dark
             * Mode — measured, not assumed. It is close to invisible in practice
             * because the webview covers the whole window (full-size content
             * view), so the backing only shows in the instant a resize outruns
             * the paint. Left as the OS default rather than pinned to a
             * hard-coded paper colour, which would be wrong the moment the
             * workspace palette moves; noted here so the next person does not
             * read the old promise and trust it.
             */
            let _ = window.set_background_color(None);
        }
        PresentAction::Nothing => {
            // Idempotent, but the assertion is still released: it is shared with
            // the separate-stage path, and a leaked one keeps the display awake
            // for the rest of the run.
            sleep::release(app);
            /*
             * And the chrome is still drained, for the same "shared latch can
             * outlive the thing that set it" reason.
             *
             * `Nothing` is planned from the FRAME latch, and the two latches can
             * come apart: a restore whose closure could not reach the `NSWindow`
             * leaves the mask latched while the frame is cleared below it, and
             * every later un-present would then plan `Nothing` and never look at
             * the mask again — a window left borderless until the app quits. A
             * drain here is a no-op in the overwhelmingly common case (nothing
             * latched, which is every ordinary launch) and the only path back in
             * the case that matters.
             *
             * The lowered reader floor is drained here for exactly the same
             * reason: it is a latch this module sets and nothing else clears.
             */
            chrome::restore(app, &window, true)?;
            set_min_size(&window, declared_min_size(app));
            target = window.inner_size().unwrap_or(PhysicalSize { width: 0, height: 0 });
        }
    }

    /*
     * Answered from the LATCH, not from the request.
     *
     * They agree on every path that reaches here — a failure `?`-propagates
     * instead of returning — and reading the latch is still the right shape,
     * because it is what the renderer's comment on `ControlPresentationState.mode`
     * promises: the mode the window is in, not the mode that was asked for. A
     * future arm that declines a request, or applies a different one, would then
     * report the truth without anybody having to remember to update this.
     */
    let applied = saved.map(|state| state.mode);
    let (width, height) = logical_size(&window, target);
    Ok(ControlPresentationState {
        presenting: applied.is_some(),
        mode: applied,
        width,
        height,
    })
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

    const PROMPTER: Option<PresentMode> = Some(PresentMode::Prompter);
    const READER: Option<PresentMode> = Some(PresentMode::Reader);

    /// The saved frame is a LATCH, not a stack.
    ///
    /// If a second present overwrote it, the frame saved would be the
    /// presenting one — monitor-sized and undecorated — and un-presenting would
    /// "restore" the window to full-screen-sized with no titlebar to grab. The
    /// operator's only way back would be to quit the app.
    #[test]
    fn presenting_twice_does_not_resave_the_frame() {
        assert_eq!(plan(None, PROMPTER), PresentAction::Enter(PresentMode::Prompter));
        assert_eq!(
            plan(PROMPTER, PROMPTER),
            PresentAction::Reassert(PresentMode::Prompter)
        );
    }

    /// Un-presenting a window that never presented is the ordinary shape of
    /// `startTake`'s failure paths, which call it without knowing how far the
    /// open got. It must not be an error and must not restore a frame that was
    /// never captured.
    #[test]
    fn un_presenting_twice_is_a_no_op_the_second_time() {
        assert_eq!(plan(PROMPTER, None), PresentAction::Restore);
        assert_eq!(plan(None, None), PresentAction::Nothing);
    }

    /// Reader mode is a first-class way to present, not a way to not present.
    ///
    /// The distinction is the whole reason `plan` takes an `Option<PresentMode>`
    /// rather than the old bool: `Some(Reader)` must save a frame, acquire the
    /// sleep assertion and be `Restore`-able, all of which `None` must not do.
    #[test]
    fn entering_reader_mode_is_presenting() {
        assert_eq!(plan(None, READER), PresentAction::Enter(PresentMode::Reader));
        assert_eq!(plan(READER, None), PresentAction::Restore);
    }

    /// A repeated request in the SAME mode reasserts; a request in the other
    /// mode switches. Never the other way round — a `Switch` planned as an
    /// `Enter` would re-save the frame from a presenting window, which is the
    /// unrecoverable case `presenting_twice_does_not_resave_the_frame` names.
    #[test]
    fn the_mid_take_toggle_switches_rather_than_re_entering() {
        assert_eq!(plan(READER, PROMPTER), PresentAction::Switch(PresentMode::Prompter));
        assert_eq!(plan(PROMPTER, READER), PresentAction::Switch(PresentMode::Reader));
        assert_eq!(plan(READER, READER), PresentAction::Reassert(PresentMode::Reader));
    }

    /// A `Switch` that failed must plan another `Switch`, never a `Reassert`.
    ///
    /// This is the state-machine half of a real defect. `set_control_presenting`
    /// used to write `state.mode` BEFORE the window mutations, every one of which
    /// `?`-propagates — so a switch that failed partway left the latch claiming
    /// the new mode while the frontend still believed the old one. Pressing the
    /// chord again then asked for the new mode, `plan` answered `Reassert`, and
    /// `apply_reader` (which deliberately moves no geometry) could not undo the
    /// prompter's pinning or chrome. The window stayed borderless and above the
    /// menu bar while control composed a reading window's geometry for it.
    ///
    /// The fix has two halves and this asserts the first: the mode is committed
    /// only after the apply succeeds, so a failed switch leaves `plan` seeing the
    /// OLD mode and planning a full `Switch` on the retry. The second half —
    /// `apply_reader` being idempotently able to un-pin and restore chrome — is
    /// what makes even a mis-planned `Reassert` recover, and is asserted by
    /// reading that function rather than by this table.
    #[test]
    fn a_failed_switch_retries_as_a_switch() {
        // The latch still says Reader, because the Prompter apply never landed.
        assert_eq!(plan(READER, PROMPTER), PresentAction::Switch(PresentMode::Prompter));
        // And the other direction, which was the unrecoverable one.
        assert_eq!(plan(PROMPTER, READER), PresentAction::Switch(PresentMode::Reader));
    }

    /// Whatever a take does in the middle, it ends by restoring — once.
    ///
    /// Walked as a sequence rather than asserted pairwise, because the defect
    /// this guards against is a `Switch` that leaves the state machine believing
    /// it is not presenting: every step below would still pass on its own, and
    /// the run would end with a borderless window and a `Nothing` plan.
    #[test]
    fn a_take_that_toggles_modes_still_ends_in_exactly_one_restore() {
        let mut current = None;
        for step in [READER, PROMPTER, READER, PROMPTER] {
            let action = plan(current, step);
            assert_ne!(action, PresentAction::Nothing, "a mode request never plans Nothing");
            assert_ne!(action, PresentAction::Restore, "a mode request never plans Restore");
            current = step;
        }
        assert_eq!(plan(current, None), PresentAction::Restore);
        assert_eq!(plan(None, None), PresentAction::Nothing);
    }
}
