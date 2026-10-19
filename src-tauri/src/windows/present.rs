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
//! THE MONITOR IS THE PINNED ONE, OR FAILING THAT THE ONE THE WINDOW IS ON
//! ---------------------------------------------------------------------------
//! A prompter fills the panel pinned in Settings › Prompter
//! (`settings.stage.displayFingerprint`), which the caller passes in. This used
//! to be deliberately NOT that: the argument was that moving the window to
//! another display was taking it out from under the person driving it, and the
//! gesture was "drag the window to the glass, then press Present". On the rig
//! this app is for that gesture is the whole cost of a take — the control
//! window lives on the desk monitor, the Elgato is a 1024×600 panel behind a
//! lens, and dragging a document window onto it to present and back off it to
//! edit is exactly the chore "Show test on this display" already spares the
//! operator in Settings. Present now does what that button does.
//!
//! The pin is a preference, not a precondition: no pin, or a pinned panel that
//! is no longer connected, falls back to the monitor the window is on, with a
//! log line rather than a refusal — the operator pressed Present and a take
//! on the wrong panel beats no take. `StageDisplayMissing`'s copy ("choose
//! another display") belongs to the separate stage window, whose selection is
//! the only thing it can open on.
//!
//! The other half of that bargain is that this module has to SAY which monitor
//! it chose. Every arm reports the panel it is landing on, from the geometry it
//! is about to apply rather than from a read taken afterwards, and `startTake`
//! composes the take's optics from that answer — so the fallback case is laid
//! out in the millimetres-per-pixel of the panel it actually fills, not the
//! one it was asked for.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow};

use crate::errors::AppError;

use super::{sleep, sleep::SleepHolder, CONTROL_LABEL};

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
/// column, and `MAX_COLUMN_FRACTION` (0.82) turns that into ~549 px. 580 leaves
/// a little over.
///
/// The fraction was 0.92 when this was first derived, which put the floor at
/// ~489 px and this constant at 520. Widening the designed margin moved the
/// floor with it: at 520 a reading window would have sat UNDER its own
/// 30-character minimum with nothing saying so, because the measure warning is
/// resolved from the rig rather than from the window's width.
///
/// Height: `TARGET_VISIBLE_LINES` (5) at a 30 px x 1.38 = 41.4 px pitch is 207
/// px, and the rest is the fades and the band's own padding.
///
/// Applied on the way into `Reader` and taken away again on the way out, so the
/// editor never inherits it.
const READER_MIN_WIDTH_PX: f64 = 580.0;
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
///
/// `scale` is the scale factor of the monitor the physical values were taken
/// against, and it is what makes the frame replayable from ANOTHER monitor —
/// see [`set_logical_position`] for why the window's own scale is the wrong
/// divisor at replay time.
#[derive(Debug, Clone, Copy, PartialEq)]
struct ControlFrame {
    position: PhysicalPosition<i32>,
    inner_size: PhysicalSize<u32>,
    scale: f64,
    decorations: bool,
    maximized: bool,
}

/// A reading window's bounds in LOGICAL (CSS) pixels.
///
/// ---------------------------------------------------------------------------
/// THE ONE FRAME IN THIS MODULE THAT OUTLIVES THE PROCESS
/// ---------------------------------------------------------------------------
/// `resting` and `reader` in [`PresentState`] are physical and stay that way:
/// they never leave this process, and converting them would round a rectangle
/// twice on every present/restore cycle to no purpose.
///
/// This one is different. It crosses the IPC boundary and is persisted in the
/// settings document, so a reader gets their window back on the NEXT LAUNCH —
/// and physical pixels mean nothing across that gap. A frame captured on a 2x
/// panel and replayed against a 1x one comes back at half the size it was left
/// at, which is precisely the "remembers, but wrongly" behaviour that is worse
/// than not remembering. So the conversion happens here, once, at the boundary.
///
/// Nothing validates these numbers on the way back in beyond the off-screen
/// clamp every restore already gets ([`restore_position`]): a frame is a hint
/// about where a window was, and the OS is the authority on where one may go.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderFrame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl ReaderFrame {
    /// The window's current bounds, converted for storage.
    fn measure<R: Runtime>(window: &WebviewWindow<R>) -> Result<Self, AppError> {
        let scale = scale_factor(window);
        let position = window.outer_position().map_err(presentation_failed)?;
        let size = window.inner_size().map_err(presentation_failed)?;
        Ok(Self {
            x: position.x as f64 / scale,
            y: position.y as f64 / scale,
            width: size.width as f64 / scale,
            height: size.height as f64 / scale,
        })
    }

}

/// Turn a remembered reading window back into a physical rectangle, against the
/// monitor it will actually land on.
///
/// ---------------------------------------------------------------------------
/// WHY THE MONITOR HAS TO BE RESOLVED FIRST
/// ---------------------------------------------------------------------------
/// The obvious implementation multiplies the stored logical frame by
/// `window.scale_factor()` — the scale of wherever the EDITOR happens to be
/// sitting — and it is wrong on any mixed-DPI rig. A reading window left at 800
/// logical px on a 1x panel, restored while the editor is on a 2x panel,
/// becomes 1600 physical px; land that on the 1x panel and it is 1600 LOGICAL
/// px, twice the size it was left at. Measuring it on the way out then stores
/// 1600, and the next cycle asks for 3200. The window grows every take, and the
/// inverse arrangement shrinks it every take.
///
/// (Handing Tauri a `Logical` position and size does not help: tao converts it
/// with the window's current scale factor, which is the same wrong number.)
///
/// So the monitor is resolved from the frame's own logical origin, and every
/// conversion below uses THAT monitor's scale. The size is also clamped to the
/// monitor, which bounds the runaway above even if the arithmetic is ever wrong
/// again: a remembered window can never come back bigger than the screen it is
/// coming back to.
///
/// `maximized` is deliberately false — a remembered reading window is a
/// rectangle somebody chose, and replaying it as maximized would discard the
/// choice while claiming to honour it.
fn reader_placement<R: Runtime>(
    app: &AppHandle<R>,
    frame: ReaderFrame,
    decorations: bool,
) -> ControlFrame {
    let rects = monitor_rects(app);
    let (position, inner_size) = fit_reader_frame(frame, &rects);
    // The same monitor `fit_reader_frame` fitted to, so the scale describes the
    // physical values beside it.
    let scale = fit_reader_monitor_index(frame, &rects)
        .and_then(|index| rects.get(index))
        .map_or(1.0, |monitor| monitor.scale);
    ControlFrame {
        position,
        inner_size,
        scale,
        decorations,
        maximized: false,
    }
}

/// The panel a windowed frame is about to land on, named the way
/// `list_displays` names it.
///
/// A reading window is the one presentation that can cross monitors — a frame
/// saved on the external panel last night is replayed onto it this morning — so
/// unlike the prompter, "whichever monitor the window is on right now" is not
/// the answer here.
///
/// ---------------------------------------------------------------------------
/// ASKED OF `restore_position`, NOT OF THE STORED RECTANGLE
/// ---------------------------------------------------------------------------
/// The stored origin is not where the window goes. [`apply_windowed`] passes
/// every frame through [`restore_position`] first, which rescues a rectangle no
/// live display covers — a take saved on a panel since unplugged — onto the
/// PRIMARY monitor, not onto the first one. Naming the panel from the raw frame
/// instead would report the display it was rescued FROM, which is unplugged, so
/// the take would be measured against a panel nobody is looking at.
///
/// Asking the same function the placement asks is what keeps the two in step.
/// It is not a proof: `apply_windowed` calls `restore_position` again, and the
/// monitors can in principle be re-enumerated between the two. What it does buy
/// is that the two now implement ONE fallback policy instead of two different
/// ones — which is the way they actually disagreed, rather than a topology that
/// changed inside a single synchronous command.
fn control_frame_display<R: Runtime>(app: &AppHandle<R>, frame: &ControlFrame) -> Option<String> {
    let (placed, _) = restore_position(app, frame);
    let monitors = app.available_monitors().ok()?;
    let rects: Vec<MonitorRect> = monitors.iter().map(MonitorRect::of).collect();
    let index = monitor_index_at(placed, &rects)?;
    super::monitor_fingerprints(&monitors).get(index).cloned()
}

/// Which monitor a physical point falls on, by the same
/// first-monitor-if-nothing-contains-it rule [`fit_reader_monitor_index`] uses.
fn monitor_index_at(point: PhysicalPosition<i32>, monitors: &[MonitorRect]) -> Option<usize> {
    monitors
        .iter()
        .position(|monitor| {
            let (_, _, logical_width, logical_height) = monitor.logical;
            let width = (logical_width * monitor.scale).round() as i32;
            let height = (logical_height * monitor.scale).round() as i32;
            point.x >= monitor.origin.x
                && point.y >= monitor.origin.y
                && point.x < monitor.origin.x + width
                && point.y < monitor.origin.y + height
        })
        .or_else(|| (!monitors.is_empty()).then_some(0))
}

/// Every connected monitor in `available_monitors()` order, which is the order
/// `monitor_fingerprints` names them in — so an index here is an index there.
fn monitor_rects<R: Runtime>(app: &AppHandle<R>) -> Vec<MonitorRect> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(MonitorRect::of)
        .collect()
}

/// One monitor, in both of the spaces this calculation needs it in.
///
/// A window's position is SET in physical pixels, and a stored frame is
/// EXPRESSED in logical ones, so a placement that touches only one of the two
/// is the bug described above wearing different clothes.
#[derive(Debug, Clone, Copy, PartialEq)]
struct MonitorRect {
    /// Physical origin — the space `set_position` works in.
    origin: PhysicalPosition<i32>,
    /// The same rectangle in this monitor's own logical pixels.
    logical: (f64, f64, f64, f64),
    scale: f64,
}

impl MonitorRect {
    fn of(monitor: &tauri::Monitor) -> Self {
        let scale = if monitor.scale_factor() > 0.0 {
            monitor.scale_factor()
        } else {
            1.0
        };
        let origin = *monitor.position();
        let size = monitor.size();
        Self {
            origin,
            logical: (
                origin.x as f64 / scale,
                origin.y as f64 / scale,
                size.width as f64 / scale,
                size.height as f64 / scale,
            ),
            scale,
        }
    }
}

/// Which monitor a remembered reading window comes back to.
///
/// Split out of [`fit_reader_frame`] and USED by it, rather than copied beside
/// it, so the choice of panel and the arithmetic done against that panel cannot
/// come from two different rules.
///
/// Placement only. The panel a take is CALIBRATED against is named by
/// [`control_frame_display`], which asks [`restore_position`] instead — the
/// rectangle this produces has still to go through that, and it is the last
/// word on where the window lands.
fn fit_reader_monitor_index(frame: ReaderFrame, monitors: &[MonitorRect]) -> Option<usize> {
    monitors
        .iter()
        .position(|monitor| {
            let (mx, my, mw, mh) = monitor.logical;
            frame.x >= mx && frame.y >= my && frame.x < mx + mw && frame.y < my + mh
        })
        /* The panel it was saved on is gone. The first monitor is visible by
           definition, which is the only property that has to hold. Not the same
           fallback `restore_position` makes — that one prefers the PRIMARY —
           and it does not need to be: whatever this fits the frame onto,
           `restore_position` sees a rectangle already on a live display and
           passes it straight through. */
        .or_else(|| (!monitors.is_empty()).then_some(0))
}

/// The placement policy, with no window and no app handle in sight.
///
/// Split out from [`reader_placement`] so it can be tested on a machine with no
/// display server, which is every machine that runs this suite. The interesting
/// behaviour is entirely arithmetic — which monitor, whose scale, and what the
/// clamps do — and none of it needs a real window to exercise.
fn fit_reader_frame(
    frame: ReaderFrame,
    monitors: &[MonitorRect],
) -> (PhysicalPosition<i32>, PhysicalSize<u32>) {
    let target = fit_reader_monitor_index(frame, monitors).and_then(|index| monitors.get(index));

    let Some(monitor) = target else {
        /* No monitors at all. Nothing sensible to compute against, so the frame
           is passed through unscaled rather than sent to an invented
           coordinate — the caller's `restore_position` still gets a look. */
        return (
            PhysicalPosition {
                x: frame.x as i32,
                y: frame.y as i32,
            },
            PhysicalSize {
                width: frame.width.max(1.0) as u32,
                height: frame.height.max(1.0) as u32,
            },
        );
    };

    let (mx, my, mw, mh) = monitor.logical;
    let scale = monitor.scale;
    /* Never bigger than the screen it is coming back to. This is what bounds
       the runaway the doc comment describes: even if a stored frame is absurd —
       a corrupt document, or an arrangement that no longer exists — the window
       that comes back still fits on a display. */
    let width = frame.width.clamp(1.0, mw);
    let height = frame.height.clamp(1.0, mh);
    /* Offset within the monitor, kept inside it so the titlebar is always
       reachable even if the frame was saved against a larger arrangement. */
    let offset_x = (frame.x - mx).clamp(0.0, (mw - width).max(0.0));
    let offset_y = (frame.y - my).clamp(0.0, (mh - height).max(0.0));

    (
        PhysicalPosition {
            x: monitor.origin.x + (offset_x * scale).round() as i32,
            y: monitor.origin.y + (offset_y * scale).round() as i32,
        },
        PhysicalSize {
            // A zero-sized window is unrecoverable without the mouse, and a
            // stored frame is the one input here the app did not measure itself
            // this run.
            width: (width * scale).round().max(1.0) as u32,
            height: (height * scale).round().max(1.0) as u32,
        },
    )
}

/// Never zero, and never negative: every use of this divides by it.
fn scale_factor<R: Runtime>(window: &WebviewWindow<R>) -> f64 {
    let scale = window.scale_factor().unwrap_or(1.0);
    if scale > 0.0 {
        scale
    } else {
        1.0
    }
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
#[derive(Debug, Clone, Copy, PartialEq)]
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

/// Is the control window presenting right now?
///
/// Exposed for the resting-frame recorder in `app.rs`, which must not store the
/// monitor-filling borderless geometry a take applies — reopening the
/// application at teleprompter size, with the window it saved being the one the
/// user never chose, is the failure this guard exists to prevent.
///
/// Reads the same latch `plan` does, so there is one answer to "is a take on the
/// glass" rather than two that can disagree.
///
/// ---------------------------------------------------------------------------
/// IT NEVER WAITS FOR THE LATCH, AND ON WINDOWS THAT IS NOT AN OPTIMISATION
/// ---------------------------------------------------------------------------
/// [`set_control_presenting`] holds the latch for the whole of a change, and
/// on Windows the change's own geometry calls deliver `WM_MOVE` and `WM_SIZE`
/// SYNCHRONOUSLY — inside `SetWindowPos`, on the same thread — so the window
/// event handlers that ask this question run while the latch is held, by the
/// thread holding it. A plain `lock()` there waited on itself: the first
/// Present on Windows froze the whole application with the window half
/// reshaped (menu bar gone, title bar still up). macOS delivers those events
/// later, which is how it went unseen.
///
/// A latch that is busy means a change is in flight, and every caller wants to
/// stand down during one — the resting-frame recorder must not store a
/// mid-transition rectangle, and a drop must not land on a window that is
/// becoming the prompter — so busy answers "presenting".
pub fn is_presenting() -> bool {
    match saved_frame().try_lock() {
        Ok(guard) => guard.is_some(),
        Err(std::sync::TryLockError::WouldBlock) => true,
        Err(std::sync::TryLockError::Poisoned(poisoned)) => poisoned.into_inner().is_some(),
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
        // Plain getters describe the monitor the window is on NOW, which is
        // the monitor these physical values are in the units of.
        scale: scale_factor(window),
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
/// Not `Copy`, unlike every other geometry type in this file: the fingerprint
/// below is an owned `String`. Nothing copied this — it is built once at the
/// bottom of `set_control_presenting` and handed straight to serde.
#[derive(Debug, Clone, Serialize)]
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
    /// The reading window's bounds, whenever this call knew them.
    ///
    /// Present while a take is in reader mode, and — the case that matters —
    /// on the way OUT of it: a `Restore` from reader mode, and the reader half
    /// of a `Switch`, both measure the window before they move it. That is the
    /// only moment those bounds still exist, so it is the only moment the
    /// frontend can be handed them to persist.
    ///
    /// Absent for a prompter, which has no bounds of its own to remember: it
    /// fills whichever monitor it was already on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reader_frame: Option<ReaderFrame>,
    /// The panel this presentation is on, named the way `list_displays` names
    /// it — which is what makes it a key the optical profiles can be looked up
    /// under.
    ///
    /// -----------------------------------------------------------------------
    /// THE TAKE IS CALIBRATED AGAINST THE PANEL IT IS ACTUALLY ON
    /// -----------------------------------------------------------------------
    /// This module fills whichever monitor the window was already on, and
    /// deliberately not `settings.stage.displayFingerprint` (see the note at
    /// the top of the file). Until this field existed, the renderer had no way
    /// to find out which one that was, so it sized the type from the PINNED
    /// panel instead — and an operator with an external prompter pinned who
    /// pressed Present at their laptop got a take measured in the external
    /// panel's millimetres-per-pixel. `mmPerCssPx` is the whole basis of the
    /// angular model, so that is not a near miss: the text comes out
    /// confidently the wrong physical size.
    ///
    /// Every arm names it from the geometry it is ABOUT to apply, never by
    /// asking the window afterwards — the setters are asynchronous, and
    /// [`logical_size`] exists because of exactly that.
    ///
    /// `None` when the window is not presenting (there is no take to
    /// calibrate), and when the monitor simply cannot be identified — a caller
    /// that gets nothing here falls back to its own guess rather than to a
    /// panel this one invented.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_fingerprint: Option<String>,
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
    let scale = scale_factor(window);
    (size.width as f64 / scale, size.height as f64 / scale)
}

/// A latched physical frame in the units [`ReaderFrame`] is stored in.
///
/// For the one case that cannot measure the live window: a take that visited
/// reader mode, switched away, and is now being restored from the prompter. The
/// reading window no longer exists to be read, so the latch's copy is converted
/// instead.
fn logical_frame(frame: &ControlFrame) -> ReaderFrame {
    // The frame's OWN scale, not the window's: by the time a latched reader
    // frame is converted on the way out of a prompter, the window is on the
    // prompter's panel, whose scale says nothing about the reader's rectangle.
    let scale = frame.scale;
    ReaderFrame {
        x: frame.position.x as f64 / scale,
        y: frame.position.y as f64 / scale,
        width: frame.inner_size.width as f64 / scale,
        height: frame.inner_size.height as f64 / scale,
    }
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
///
/// Answers with the scale factor the position is in the units of: the frame's
/// own when the saved origin stands, the rescuing monitor's when it does not.
fn restore_position<R: Runtime>(
    app: &AppHandle<R>,
    frame: &ControlFrame,
) -> (PhysicalPosition<i32>, f64) {
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
        return (frame.position, frame.scale);
    }
    app.primary_monitor()
        .ok()
        .flatten()
        .or_else(|| monitors.into_iter().next())
        .map(|monitor| (*monitor.position(), MonitorRect::of(&monitor).scale))
        .unwrap_or((frame.position, frame.scale))
}

/*
 * ---------------------------------------------------------------------------
 * EVERY MOVE IN THIS MODULE IS APPLIED IN LOGICAL UNITS
 * ---------------------------------------------------------------------------
 * `set_position(Physical(..))` and `set_size(Physical(..))` look like the
 * exact thing to hand a monitor's own physical bounds to, and on a window that
 * never leaves its monitor they are. They are not once a window CROSSES
 * monitors of different scale, which a prompter now does: tao converts a
 * physical value to points with the window's scale factor AT THE TIME THE
 * MESSAGE IS HANDLED (`platform_impl/macos/window.rs::set_inner_size`,
 * `set_outer_position`), and the window is still on the monitor it is leaving.
 * A 2x laptop handing its window the Elgato's 1024x600 physical bounds got a
 * 512x300-point window on a 1x panel — the take in the top-right quarter of
 * the glass — and the way back handed the 1x panel a frame measured in 2x
 * pixels, so the editor came home at twice its size.
 *
 * Points are global on macOS, so a value converted with the scale of the
 * monitor it BELONGS to is right wherever the window happens to be when the
 * message lands. That is what the separate stage window has always done
 * (`open_stage` builds with `position / scale`), and it is what every setter
 * here does now: the caller says which monitor's scale its numbers are in.
 *
 * Linux takes the same path, for the same reason: tao's GTK setters convert
 * with the window's current scale too. Windows is the exception — see
 * [`place`], where every move in this module is made.
 */

/// The logical point a physical position is at, on a monitor of this scale.
fn to_logical_position(position: PhysicalPosition<i32>, scale: f64) -> tauri::LogicalPosition<f64> {
    tauri::LogicalPosition {
        x: position.x as f64 / scale,
        y: position.y as f64 / scale,
    }
}

/// The logical size a physical size measures, on a monitor of this scale.
fn to_logical_size(size: PhysicalSize<u32>, scale: f64) -> tauri::LogicalSize<f64> {
    tauri::LogicalSize {
        width: size.width as f64 / scale,
        height: size.height as f64 / scale,
    }
}

/// Move and size the window: `position` and `size` are physical pixels, each
/// in the scale of the monitor it was measured on.
///
/// macOS (and Linux) take them as points converted with those scales (the
/// module note above). Windows is the mirror image. There PHYSICAL pixels are
/// the global space — `Monitor::position` and the virtual desktop agree on
/// them — and it is a LOGICAL value tao converts with the window's current
/// scale: a laptop at 125% handing its window the 100% prompter's origin at
/// x = 1920 as 1920 points landed it at x = 2400, most of the take off the
/// panel's right edge. So there the position goes in as it is, and the size
/// keeps the logical size it was measured at, in the scale of the monitor the
/// position lands on — the same pixels when the two scales agree, which is
/// every presentation; a frame rescued onto a monitor of another DPI keeps the
/// rectangle somebody chose rather than its pixel count. A move that crosses
/// into a monitor of another DPI also has Windows resize the window itself
/// (`WM_DPICHANGED`) once the position lands, so position and size are applied
/// twice — the order the launch restore uses for the same reason
/// (`shell_cmds::placements`).
fn place<R: Runtime>(
    window: &WebviewWindow<R>,
    position: PhysicalPosition<i32>,
    position_scale: f64,
    size: PhysicalSize<u32>,
    size_scale: f64,
) -> Result<(), AppError> {
    #[cfg(not(windows))]
    {
        set_logical_position(window, position, position_scale)?;
        set_logical_size(window, size, size_scale)
    }
    #[cfg(windows)]
    {
        let size = rescaled(size, size_scale, position_scale);
        for _ in 0..2 {
            window
                .set_position(tauri::Position::Physical(position))
                .map_err(presentation_failed)?;
            window
                .set_size(tauri::Size::Physical(size))
                .map_err(presentation_failed)?;
        }
        Ok(())
    }
}

/// A physical size measured at `from`, as the same logical size at `to`.
#[cfg_attr(not(windows), allow(dead_code))]
fn rescaled(size: PhysicalSize<u32>, from: f64, to: f64) -> PhysicalSize<u32> {
    let logical = to_logical_size(size, from);
    PhysicalSize::new(
        (logical.width * to).round() as u32,
        (logical.height * to).round() as u32,
    )
}

#[cfg_attr(windows, allow(dead_code))]
fn set_logical_position<R: Runtime>(
    window: &WebviewWindow<R>,
    position: PhysicalPosition<i32>,
    scale: f64,
) -> Result<(), AppError> {
    window
        .set_position(tauri::Position::Logical(to_logical_position(position, scale)))
        .map_err(presentation_failed)
}

#[cfg_attr(windows, allow(dead_code))]
fn set_logical_size<R: Runtime>(
    window: &WebviewWindow<R>,
    size: PhysicalSize<u32>,
    scale: f64,
) -> Result<(), AppError> {
    window
        .set_size(tauri::Size::Logical(to_logical_size(size, scale)))
        .map_err(presentation_failed)
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

/// Present in place: this window, where it is, at the size it is — unless the
/// caller hands back a rectangle this reader chose on a previous launch.
///
/// ---------------------------------------------------------------------------
/// WHY THIS NORMALLY MOVES NO GEOMETRY AT ALL
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
/// AND THE ONE CASE THAT DOES MOVE IT
/// ---------------------------------------------------------------------------
/// `place_at` is a rectangle the SAME gesture produced, just in an earlier run
/// of the app — the reader dragged their window somewhere, ended the take, and
/// quit. Honouring it is not overriding the operator's placement, it is the only
/// way to give it back: the in-process latch dies with the process, so without
/// this the third launch in a row opens at whatever size the editor happened to
/// be, and the reader re-drags their window every single day.
///
/// It is only ever passed on `Enter`, and only when the frame came from storage.
/// A `Reassert` or a `Switch` has a live window to read from and must not move
/// it — see [`set_control_presenting`].
fn apply_reader<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
    decorations: bool,
    place_at: Option<ReaderFrame>,
) -> Result<(PhysicalSize<u32>, f64), AppError> {
    if let Some(frame) = place_at {
        /*
         * The stored frame goes through `apply_windowed` rather than through a
         * pair of setters here, so it inherits the two things that path already
         * gets right: the off-screen clamp (`restore_position` — a reader who
         * saved their window on a panel they have since unplugged must not get
         * an invisible one back) and the floor-before-size ordering, which is
         * what stops the OS clamping a deliberately narrow reading window
         * straight back up to the editor's minimum.
         */
        let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 255)));
        return apply_windowed(
            app,
            window,
            &reader_placement(app, frame, decorations),
            Some(tauri::LogicalSize {
                width: READER_MIN_WIDTH_PX,
                height: READER_MIN_HEIGHT_PX,
            }),
        );
    }
    apply_reader_in_place(app, window, decorations)
}

/// The in-place half, unchanged: everything about a reading window except where
/// it is.
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
fn apply_reader_in_place<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
    decorations: bool,
) -> Result<(PhysicalSize<u32>, f64), AppError> {
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
    let size = window.inner_size().map_err(presentation_failed)?;
    Ok((size, scale_factor(window)))
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
) -> Result<(PhysicalSize<u32>, f64), AppError> {
    window.set_always_on_top(false).map_err(presentation_failed)?;
    chrome::restore(app, window, frame.decorations)?;
    set_min_size(window, min_size);
    if !frame.maximized {
        /*
         * A maximized window ignores `set_position`/`set_size` on Windows and
         * fights them on macOS — the same reason `apply_presentation` drops the
         * state before it moves anything.
         *
         * It was not needed while this function only ran on the way OUT of a
         * presentation, because entering had already unmaximized the window.
         * `Enter(Reader)` with a remembered frame broke that assumption: the
         * editor may well be maximized when Present is pressed, and the stored
         * rectangle would then be quietly ignored — a reading window that
         * remembers, except when it does not, which is the flakiest thing this
         * feature could be. A no-op on every path that used to reach here.
         */
        let _ = window.unmaximize();
    }
    // The position in the scale of the monitor it lands on; the size in the
    // scale it was measured in — a rescued frame keeps the rectangle somebody
    // chose even when its origin has to move.
    let (position, position_scale) = restore_position(app, frame);
    place(window, position, position_scale, frame.inner_size, frame.scale)?;
    if frame.maximized {
        let _ = window.maximize();
    }
    Ok((frame.inner_size, frame.scale))
}

/// Move the window onto the whole of the monitor it is currently on, without
/// decorations and above the menu bar. Answers with the size it is heading for,
/// and with the name of the panel it is heading onto.
///
/// The fingerprint comes from the very `Monitor` this function fills, taken
/// while it still has it. That is the only honest moment: the setters below are
/// delivered asynchronously (see [`logical_size`]), so a caller that asked the
/// window afterwards could be told about the monitor it has not left yet.
/// How long to wait for AppKit to finish leaving native fullscreen.
///
/// The exit is an animation across Spaces and takes roughly three quarters of
/// a second; this is generous enough to cover a loaded machine and short
/// enough that a presenter pressing Present does not think the app has hung.
#[cfg(target_os = "macos")]
const FULLSCREEN_EXIT_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(1_500);

/// Leave native fullscreen, and WAIT until the window agrees that it has.
///
/// ---------------------------------------------------------------------------
/// WHY THE WAIT IS THE WHOLE POINT
/// ---------------------------------------------------------------------------
/// This used to be `set_fullscreen(false)` and straight on to the geometry.
/// Every setter here is delivered asynchronously, so AppKit could finish its
/// exit animation AFTER the position and size below had been queued — and
/// restore the pre-fullscreen frame over the top of them. What the presenter
/// gets is a window somewhere this function did not put it, with the titlebar
/// AppKit restored, on the glass, mid-take. It was documented as a known edge
/// and left, which is fine right up until the first person upgrades from a
/// build that used native fullscreen and presses Present with the control
/// window still in it.
///
/// Polling rather than a `windowDidExitFullScreen` delegate: the delegate is
/// the tidier mechanism and it means owning one on a window tao already has a
/// delegate for, which is a bigger change than this edge is worth. What
/// matters is that the wait is BOUNDED and confirmed by reading the state
/// back, so it cannot spin forever on a window that never leaves.
///
/// Blocking is safe here. `set_control_presenting` is a synchronous Tauri
/// command, so this runs on the blocking pool rather than on an async runtime
/// worker — the same reason the recogniser owns its own thread.
///
/// A timeout does NOT refuse the presentation. Presenting with the documented
/// race is worse than presenting cleanly and better than a Present button that
/// does nothing; the caller gets a warning in the log and the geometry is
/// applied anyway.
#[cfg(target_os = "macos")]
fn leave_native_fullscreen<R: Runtime>(window: &WebviewWindow<R>) {
    if !window.is_fullscreen().unwrap_or(false) {
        return;
    }
    let _ = window.set_fullscreen(false);

    let deadline = std::time::Instant::now() + FULLSCREEN_EXIT_TIMEOUT;
    while std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(25));
        /*
         * An error reading the state ends the wait rather than continuing it.
         * `is_fullscreen` failing means the window is going away, and spinning
         * for another second and a half on a window that cannot answer would
         * turn a lost window into a hung Present.
         */
        match window.is_fullscreen() {
            Ok(false) => return,
            Ok(true) => continue,
            Err(_) => return,
        }
    }
    tracing::warn!(
        "the window did not leave native fullscreen within {}ms; presenting anyway, and the \
         frame AppKit restores may land over the presentation geometry",
        FULLSCREEN_EXIT_TIMEOUT.as_millis()
    );
}

/// Nothing to leave. No other platform has AppKit's cross-Space exit animation,
/// and `set_fullscreen(false)` where it applies is not raced by one.
#[cfg(not(target_os = "macos"))]
fn leave_native_fullscreen<R: Runtime>(window: &WebviewWindow<R>) {
    if window.is_fullscreen().unwrap_or(false) {
        let _ = window.set_fullscreen(false);
    }
}

/// Fill a monitor with the control window, borderless and pinned above the
/// menu bar — the pinned panel when `wanted` names one that is connected,
/// otherwise the monitor the window is on (see the module doc).
///
/// Returns the bounds applied, the scale factor of the monitor they belong to,
/// and that monitor's fingerprint. The scale travels with the bounds because a
/// prompter can now CROSS monitors: `logical_size` divides by the scale of the
/// monitor the window is on, and after an asynchronous move that is still the
/// old one — a 2x laptop to the 1x Elgato would report 512x300 for a 1024x600
/// viewport, and `awaitViewportSettled` would sit out its whole ceiling waiting
/// for a size that never comes.
fn apply_presentation<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
    wanted: Option<&str>,
) -> Result<(PhysicalSize<u32>, f64, Option<String>), AppError> {
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
    leave_native_fullscreen(window);

    let pinned = wanted.and_then(|fingerprint| {
        match super::resolve_monitor(app, Some(fingerprint)) {
            Ok(monitor) => Some(monitor),
            Err(_) => {
                tracing::warn!(
                    "the pinned prompter display {fingerprint:?} is not connected; presenting on \
                     the monitor the window is on"
                );
                None
            }
        }
    });
    let monitor = match pinned {
        Some(monitor) => monitor,
        None => window
            .current_monitor()
            .ok()
            .flatten()
            // Not `StageDisplayMissing`: its copy tells the operator the display
            // they SELECTED is gone and to choose another, and by this point the
            // selection has already been given up on — this is the fallback to
            // whichever monitor the window is on. A machine that reports no
            // monitors at all is the same "could not reshape this window"
            // failure as the rest of them.
            .ok_or_else(|| presentation_failed("no monitor to present on"))?,
    };

    let bounds = *monitor.size();
    let scale = if monitor.scale_factor() > 0.0 {
        monitor.scale_factor()
    } else {
        1.0
    };
    /*
     * Named before the setters run, for the reason in the doc comment above —
     * and named from the SAME `monitor` whose bounds are applied below, so the
     * panel reported and the rectangle applied can only ever describe the same
     * display.
     *
     * That is the guarantee worth having, because it is the one that survives
     * the case above it. A window left in NATIVE fullscreen has been asked to
     * leave it AND waited for — `leave_native_fullscreen` blocks until the
     * window reads back as not fullscreen — so the exit animation can no longer
     * finish after the geometry below is queued and restore the pre-fullscreen
     * frame over the top of it.
     *
     * The wait is bounded, so the race is closed rather than eliminated: a
     * window that has not left within the timeout is presented anyway, with a
     * warning. In that residual case the size reported here is still derived
     * from the SAME monitor whose bounds are applied below, so the report and
     * the geometry are wrong together rather than separately, and the renderer
     * is never calibrated for one panel while laid out for another. Untestable
     * here — Apple ships no WebDriver for WKWebView — and reachable only by a
     * window the PREVIOUS implementation left in fullscreen.
     */
    let display = super::monitor_fingerprint(app, &monitor);
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
    // In the TARGET monitor's scale, never the window's — see `place`. Inner
    // size, and on a window with no decorations inner IS outer — which is what
    // makes filling the monitor's bounds exact rather than approximately right
    // by a titlebar.
    place(window, *monitor.position(), scale, bounds, scale)?;
    Ok((bounds, scale, display))
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

/// Everywhere else the chrome is the decorations flag, which tao's own
/// bookkeeping owns, and the MENU BAR, which macOS keeps at the top of the
/// screen and Windows and Linux keep inside the window's frame (`menu.rs`
/// puts it on the control window there).
///
/// Left up, the bar sits across the top of the prompter — on mirrored glass,
/// backwards — and it is hidden BEFORE the window is sized to the monitor,
/// because a visible bar is part of the frame: the client area would come out
/// a menu-height short of the panel. Hiding detaches the bar and nothing
/// else; its accelerators stay registered, so the take's own keys (End Take,
/// the zoom chords) keep working with nothing drawn.
///
/// And the SHADOW. On Windows an undecorated window that keeps its shadow
/// keeps an invisible resize frame to cast it from — and, on Windows 11,
/// rounded corners and a one-pixel border. The prompter measured 1938 x 1090
/// on a 1920 x 1080 panel with its content starting at (9, 1): shifted right,
/// nine pixels of the take off the panel's edge (onto the neighbouring display
/// on a two-monitor rig) and a strip of desktop showing down the left of the
/// glass. Without the shadow the client area is the whole window.
#[cfg(not(target_os = "macos"))]
mod chrome {
    use tauri::{AppHandle, Runtime, WebviewWindow};

    use crate::errors::AppError;

    use super::presentation_failed;

    pub fn strip<R: Runtime>(
        _app: &AppHandle<R>,
        window: &WebviewWindow<R>,
    ) -> Result<(), AppError> {
        window.hide_menu().map_err(presentation_failed)?;
        window.set_decorations(false).map_err(presentation_failed)?;
        window.set_shadow(false).map_err(presentation_failed)
    }

    pub fn restore<R: Runtime>(
        _app: &AppHandle<R>,
        window: &WebviewWindow<R>,
        decorations: bool,
    ) -> Result<(), AppError> {
        window
            .set_decorations(decorations)
            .map_err(presentation_failed)?;
        window.set_shadow(true).map_err(presentation_failed)?;
        window.show_menu().map_err(presentation_failed)
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
///
/// `display` is the pinned prompter panel, honoured by every arm that fills a
/// monitor — the opening, a reassert, and the mid-take switch out of reader
/// mode — and ignored by the ones that do not.
pub fn set_control_presenting<R: Runtime>(
    app: &AppHandle<R>,
    mode: Option<PresentMode>,
    reader_frame: Option<ReaderFrame>,
    display: Option<&str>,
) -> Result<ControlPresentationState, AppError> {
    let window = control_window(app)?;
    let mut saved = lock();
    let target;
    /*
     * What to REPORT, which is not the same question as what to apply.
     *
     * Set by the arms that pass through a moment where a reading window's
     * bounds are both real and about to stop being real — the switch away from
     * reader mode, and the restore out of it. Everywhere else it is filled in
     * from the live window at the bottom of this function.
     */
    let mut departing_reader: Option<ReaderFrame> = None;
    /*
     * The panel this presentation is landing on, for the renderer to calibrate
     * against. See [`ControlPresentationState::display_fingerprint`].
     *
     * Filled in per arm, from the geometry that arm is about to APPLY, and
     * never by asking the window at the bottom of this function. That last part
     * is the whole discipline: `logical_size` and the `departing_reader` note
     * below both exist because a getter read after one of these setters
     * describes the window they have not moved yet, and a stale monitor here
     * would be a take measured against the panel it just left.
     */
    let mut landed_display: Option<String> = None;
    /*
     * The scale the reported size is divided by, when the arm knows better than
     * the window. A prompter arm names the monitor it fills, and that monitor's
     * scale is the right divisor even while the window is still on its way there.
     */
    let mut target_scale: Option<f64> = None;

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
            /*
             * The operator deliberately stops touching the keyboard for the
             * length of a take, which is exactly when the OS blanks the display
             * (§52.7).
             *
             * Claimed alongside the latch rather than after the apply, for the
             * same reason the frame is: a failed apply leaves the latch set, a
             * retry then plans `Reassert` or `Switch`, and neither claims
             * anything — a take that presented on the second try would have
             * let the display sleep. The un-present that clears the latch is
             * what withdraws it.
             *
             * Held in READER mode too, and deliberately. The argument in
             * `sleep.rs` is about somebody who stops touching the keyboard for
             * twenty minutes, and that is MORE true of reading than of
             * presenting, not less — a reader's hands are nowhere near the
             * trackpad while the script follows their voice.
             */
            sleep::acquire(app, SleepHolder::Take);
            let decorations = saved.as_ref().expect("just written").resting.decorations;
            target = match entering {
                /*
                 * A remembered frame is honoured only here, on `Enter`. The
                 * prompter arm ignores it entirely — it has a monitor to fill,
                 * and a stored rectangle would be describing the wrong thing.
                 */
                PresentMode::Prompter => {
                    let (bounds, scale, landed) = apply_presentation(app, &window, display)?;
                    landed_display = landed;
                    target_scale = Some(scale);
                    bounds
                }
                PresentMode::Reader => {
                    /*
                     * Named before the apply, because a restored frame is the
                     * one case in this file where presenting MOVES the window
                     * across monitors — a reading window saved on the external
                     * panel is replayed onto it. Without a frame nothing moves,
                     * so the monitor it is on is the monitor it stays on.
                     */
                    landed_display = match reader_frame {
                        // Through the same `reader_placement` the apply below
                        // runs, so the panel reported is the panel fitted to.
                        Some(frame) => {
                            control_frame_display(app, &reader_placement(app, frame, decorations))
                        }
                        None => super::window_monitor_fingerprint(app, &window),
                    };
                    let (bounds, scale) = apply_reader(app, &window, decorations, reader_frame)?;
                    target_scale = Some(scale);
                    bounds
                }
            };
        }
        PresentAction::Reassert(current) => {
            let decorations = saved.as_ref().expect("Reassert is only planned while presenting").resting.decorations;
            target = match current {
                PresentMode::Prompter => {
                    let (bounds, scale, landed) = apply_presentation(app, &window, display)?;
                    landed_display = landed;
                    target_scale = Some(scale);
                    bounds
                }
                // Never `reader_frame`: a reassert re-applies the mode the
                // window is ALREADY in, so the live window is the authority on
                // its own bounds and a stored rectangle would yank a reader's
                // window back to where it sat this morning.
                PresentMode::Reader => {
                    // In place, so the current monitor is also the landing one.
                    landed_display = super::window_monitor_fingerprint(app, &window);
                    let (bounds, scale) = apply_reader_in_place(app, &window, decorations)?;
                    target_scale = Some(scale);
                    bounds
                }
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
                    let departing = measure_frame(&window)?;
                    if let Some(state) = saved.as_mut() {
                        state.reader = Some(departing);
                    }
                    /*
                     * The same rectangle, in the units that survive a quit.
                     *
                     * The latch above gets the reader back within THIS take; this
                     * gets them back on the next launch. Converted from the frame
                     * just measured rather than measured a second time — one
                     * reading of the window, so the two copies cannot disagree,
                     * and no second chance to fail.
                     */
                    departing_reader = Some(logical_frame(&departing));
                    let (bounds, scale, landed) = apply_presentation(app, &window, display)?;
                    landed_display = landed;
                    target_scale = Some(scale);
                    target = bounds;
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
                    // The frame being restored, not the monitor being left:
                    // popping back to a reading window that lives on another
                    // panel changes which panel the take is measured against.
                    landed_display = control_frame_display(app, &frame);
                    let (bounds, scale) = apply_windowed(app, &window, &frame, Some(reader_min))?;
                    target = bounds;
                    target_scale = Some(scale);
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
            let state = *saved.as_ref().expect("Restore is only planned while presenting");
            let frame = state.resting;
            /*
             * Ending a take IN reader mode is the ordinary way a reading window
             * is last seen, so it is the measurement that matters most — and it
             * has to happen here, before `apply_windowed` replays the resting
             * frame over the top of it.
             *
             * A take that ended in prompter mode falls back to whatever the
             * latch recorded on its way out of reader mode earlier in the same
             * take, so popping out to the full display for one paragraph and
             * then pressing Escape still remembers the reading window rather
             * than forgetting it for having been left second.
             */
            /*
             * Best-effort, and the `?` this used to carry was a real hazard.
             *
             * Remembering where a reading window sat is ancillary; putting the
             * operator's window back is not. A failing getter would have
             * aborted the whole restore — leaving a borderless, monitor-sized,
             * always-on-top window — in service of a rectangle nobody would
             * have missed. So a measurement that cannot be taken is simply not
             * reported.
             */
            departing_reader = match state.mode {
                PresentMode::Reader => ReaderFrame::measure(&window).ok(),
                PresentMode::Prompter => state
                    .reader
                    .map(|reader| logical_frame(&reader)),
            };
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
            let (bounds, scale) = apply_windowed(app, &window, &frame, declared_min_size(app))?;
            target = bounds;
            target_scale = Some(scale);
            *saved = None;
            sleep::release(app, SleepHolder::Take);
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
            // Idempotent, but the take's claim is still withdrawn: a leaked one
            // keeps the display awake for the rest of the run. Only the take's,
            // though — a preview or display test on the stage window holds its
            // own, and this is not its to drop.
            sleep::release(app, SleepHolder::Take);
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
    let (width, height) = match target_scale {
        Some(scale) => (target.width as f64 / scale, target.height as f64 / scale),
        None => logical_size(&window, target),
    };
    /*
     * ONLY the departure measurement, never a live read of the window here.
     *
     * This used to fall back to measuring the window whenever the applied mode
     * was `Reader`, which looks like a helpful generalisation and is a way to
     * report the wrong rectangle. A `Switch` INTO reader mode has just called
     * `set_position`/`set_size`, and every geometry setter in this file is
     * delivered asynchronously — `logical_size` exists precisely because a
     * getter read straight afterwards describes the window the setter has not
     * moved yet. So the fallback measured the outgoing PROMPTER: a
     * monitor-sized rectangle, reported under the name `readerFrame`, which the
     * frontend then persisted as where the reading window lives.
     *
     * The consumer only ever needs the departure cases, which are the arms that
     * set `departing_reader` — and each of those measures BEFORE it moves
     * anything. There is nothing for a general case to add.
     */
    Ok(ControlPresentationState {
        presenting: applied.is_some(),
        mode: applied,
        width,
        height,
        reader_frame: departing_reader,
        /*
         * Cleared when the window is not presenting, rather than reporting the
         * panel it happens to be sitting on.
         *
         * `Restore` and `Nothing` never set it, so this only re-states what the
         * arms already do — but it states it where the invariant is read from,
         * because the field means "the panel this TAKE is calibrated against"
         * and there is no take. A future arm that filled it in on the way out
         * would otherwise hand the renderer a display to measure nothing
         * against.
         */
        display_fingerprint: reported_display(applied, landed_display),
    })
}

/// The panel to report, given what was applied and what was named.
///
/// A one-line rule with a real invariant in it, so it is named and tested
/// rather than inlined: a window that is not presenting has no take to
/// calibrate, and must report no panel however confidently an arm named one.
fn reported_display(applied: Option<PresentMode>, landed: Option<String>) -> Option<String> {
    applied.and(landed)
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

    /* ------------------------------------------- placing a remembered window */

    /// A monitor at a physical origin, given in logical size and a scale.
    fn monitor(x: i32, y: i32, logical_w: f64, logical_h: f64, scale: f64) -> MonitorRect {
        MonitorRect {
            origin: PhysicalPosition { x, y },
            logical: (x as f64 / scale, y as f64 / scale, logical_w, logical_h),
            scale,
        }
    }

    fn frame(x: f64, y: f64, width: f64, height: f64) -> ReaderFrame {
        ReaderFrame { x, y, width, height }
    }

    /* ------------------------------------- naming the panel a take lands on */

    /// A remembered reading window goes back to the panel it was saved on.
    ///
    /// The placement half of the defect in reader clothing: `Enter(Reader)`
    /// with a stored frame reports through `control_frame_display` on the
    /// rectangle this produces, so a frame fitted to the wrong panel would be
    /// MEASURED against the wrong panel too, however right the reporting is.
    #[test]
    fn a_remembered_reader_is_measured_against_the_panel_it_returns_to() {
        let screens = [
            monitor(0, 0, 1512.0, 982.0, 2.0),     // the editor's retina panel
            monitor(3024, 0, 1920.0, 1080.0, 1.0), // where the reader lives
        ];
        let saved = frame(3100.0, 120.0, 800.0, 600.0);

        assert_eq!(fit_reader_monitor_index(saved, &screens), Some(1));
        // And it agrees with where the geometry actually goes: the 1x panel.
        let (position, _) = fit_reader_frame(saved, &screens);
        assert!(position.x >= 3024, "placed on the panel it was named for");
    }

    /// A frame whose panel is gone is still fitted onto a live one, never left
    /// unplaced — and because `fit_reader_frame` CLAMPS it into that monitor,
    /// the rectangle handed on is already on a live display, so
    /// `restore_position` passes it through and the reported panel agrees.
    #[test]
    fn a_reader_whose_panel_is_gone_is_measured_against_where_it_actually_lands() {
        let screens = [monitor(0, 0, 1440.0, 900.0, 2.0)];
        assert_eq!(
            fit_reader_monitor_index(frame(4000.0, 300.0, 700.0, 500.0), &screens),
            Some(0),
        );
    }

    #[test]
    fn no_monitors_means_no_panel_to_name() {
        assert_eq!(fit_reader_monitor_index(frame(0.0, 0.0, 800.0, 600.0), &[]), None);
        assert_eq!(monitor_index_at(PhysicalPosition { x: 0, y: 0 }, &[]), None);
    }

    /// `Switch(→Reader)` restores a PHYSICAL frame, so the panel is found from
    /// physical coordinates.
    ///
    /// Converting that frame to logical first — through `logical_frame`, which
    /// divides by the scale of the monitor the window is on NOW — is the wrong
    /// divisor whenever the switch crosses panels on a mixed-DPI rig, and it
    /// names the wrong monitor. These origins are chosen so a 2x mistake would
    /// land on the other screen.
    #[test]
    fn a_physical_frame_finds_its_panel_without_a_scale_conversion() {
        let screens = [
            monitor(0, 0, 1512.0, 982.0, 2.0),     // 3024 physical wide
            monitor(3024, 0, 1920.0, 1080.0, 1.0), // 1920 physical wide
        ];
        assert_eq!(monitor_index_at(PhysicalPosition { x: 3100, y: 120 }, &screens), Some(1));
        assert_eq!(monitor_index_at(PhysicalPosition { x: 100, y: 120 }, &screens), Some(0));
        // Off every panel: the first one, which is visible by definition.
        assert_eq!(monitor_index_at(PhysicalPosition { x: 9000, y: 0 }, &screens), Some(0));
    }

    /* ------------------------------------------------ crossing monitors */

    /// The bug that put the take in the top-right quarter of the glass.
    ///
    /// The Elgato's 1024x600 physical bounds, handed to `set_size(Physical)`
    /// while the window was still on a 2x laptop, were converted with the
    /// laptop's scale into a 512x300-point window. Converted with the scale of
    /// the monitor the bounds BELONG to, they are 1024x600 points wherever the
    /// window is when the message lands — and a 2x frame going home is 1440x900
    /// points, not 2880x1800.
    #[test]
    fn geometry_is_converted_with_the_scale_of_the_monitor_it_belongs_to() {
        let elgato = to_logical_size(PhysicalSize { width: 1024, height: 600 }, 1.0);
        assert_eq!((elgato.width, elgato.height), (1024.0, 600.0));
        let laptop = to_logical_size(PhysicalSize { width: 2880, height: 1800 }, 2.0);
        assert_eq!((laptop.width, laptop.height), (1440.0, 900.0));
        // A 1x panel sitting to the right of a 2x laptop: its physical origin
        // is in its OWN scale, so dividing by 2 would put it inside the laptop.
        let origin = to_logical_position(PhysicalPosition { x: 2880, y: 0 }, 1.0);
        assert_eq!((origin.x, origin.y), (2880.0, 0.0));
    }

    /// Windows takes sizes in physical pixels, so a frame rescued onto a
    /// monitor of another DPI is resized to keep its logical size — 1500x1000
    /// at 125% is 1200x800 at 100%, the rectangle the editor had — and a
    /// presentation, measured on the monitor it fills, keeps its pixels.
    #[test]
    fn a_rescued_frame_keeps_its_logical_size_on_a_monitor_of_another_scale() {
        let rescued = rescaled(PhysicalSize { width: 1500, height: 1000 }, 1.25, 1.0);
        assert_eq!((rescued.width, rescued.height), (1200, 800));
        let presented = rescaled(PhysicalSize { width: 1024, height: 600 }, 1.0, 1.0);
        assert_eq!((presented.width, presented.height), (1024, 600));
        let odd = rescaled(PhysicalSize { width: 1567, height: 1019 }, 1.25, 1.25);
        assert_eq!((odd.width, odd.height), (1567, 1019));
    }

    /// A frame remembers the scale it was measured in, so the un-present after
    /// a cross-monitor take restores the rectangle the editor actually had.
    #[test]
    fn a_frame_converts_with_its_own_scale_not_the_windows() {
        let frame = ControlFrame {
            position: PhysicalPosition { x: 200, y: 100 },
            inner_size: PhysicalSize { width: 2400, height: 1500 },
            scale: 2.0,
            decorations: true,
            maximized: false,
        };
        let logical = logical_frame(&frame);
        assert_eq!((logical.x, logical.y), (100.0, 50.0));
        assert_eq!((logical.width, logical.height), (1200.0, 750.0));
    }

    /* ------------------------------------------ what the renderer is handed */

    /// Built the way `set_control_presenting` builds it — through
    /// [`reported_display`] rather than around it, so a test cannot assert a
    /// combination production forbids.
    fn presentation_state(
        applied: Option<PresentMode>,
        landed: Option<&str>,
    ) -> ControlPresentationState {
        ControlPresentationState {
            presenting: applied.is_some(),
            mode: applied,
            width: 1728.0,
            height: 1117.0,
            reader_frame: None,
            display_fingerprint: reported_display(applied, landed.map(str::to_owned)),
        }
    }

    /// The renderer looks the optical profile up under this key, so the wire
    /// name has to be the camelCase one `control-window.ts` declares.
    #[test]
    fn the_panel_reaches_the_renderer_under_the_name_it_reads() {
        let json =
            serde_json::to_value(presentation_state(PROMPTER, Some("panel-2"))).unwrap();
        assert_eq!(json["displayFingerprint"], "panel-2");
    }

    /// Omitted rather than null, so the renderer's "fall back to your own
    /// guess" branch is reached by an ABSENT key.
    ///
    /// The third case is the invariant worth having: an un-present that somehow
    /// named a panel still reports none, because there is no take to calibrate
    /// against it. That combination is unreachable through the arms today, and
    /// asserting it here is what keeps it unreachable.
    #[test]
    fn a_panel_that_cannot_be_named_is_left_out_entirely() {
        for state in [
            presentation_state(None, None),
            presentation_state(PROMPTER, None),
            presentation_state(None, Some("panel-2")),
        ] {
            let json = serde_json::to_value(state).unwrap();
            assert!(
                json.get("displayFingerprint").is_none(),
                "an unnamed panel must be absent, not null",
            );
        }
    }

    #[test]
    fn a_remembered_window_comes_back_the_size_it_was_left() {
        let screens = [monitor(0, 0, 1440.0, 900.0, 2.0)];
        let (position, size) = fit_reader_frame(frame(100.0, 80.0, 800.0, 600.0), &screens);
        // Logical in, physical out, at this monitor's scale.
        assert_eq!(size, PhysicalSize { width: 1600, height: 1200 });
        assert_eq!(position, PhysicalPosition { x: 200, y: 160 });
    }

    /// The defect this function was extracted to make testable.
    ///
    /// Converting with the scale of whatever monitor the EDITOR happens to be on
    /// meant an 800-logical-px reader saved on a 1x panel came back as 1600
    /// logical px on that panel — and measuring it on the way out then stored
    /// 1600, so the next take asked for 3200. The window grew every session.
    #[test]
    fn a_frame_saved_on_another_panel_does_not_grow_each_cycle() {
        let screens = [
            monitor(0, 0, 1512.0, 982.0, 2.0),  // the editor's retina panel
            monitor(3024, 0, 1920.0, 1080.0, 1.0), // where the reader lives
        ];
        let saved = frame(3100.0, 120.0, 800.0, 600.0);

        let (_, first) = fit_reader_frame(saved, &screens);
        // Placed on the 1x panel, so 800 logical is 800 physical — NOT 1600.
        assert_eq!(first, PhysicalSize { width: 800, height: 600 });

        // What the next exit would measure there, fed back in: unchanged.
        let measured_again = frame(3100.0, 120.0, first.width as f64, first.height as f64);
        let (_, second) = fit_reader_frame(measured_again, &screens);
        assert_eq!(second, first, "a save/restore cycle must be a fixed point");
    }

    #[test]
    fn a_window_saved_on_a_panel_that_is_gone_comes_back_somewhere_visible() {
        let screens = [monitor(0, 0, 1440.0, 900.0, 2.0)];
        // Coordinates on a second display that is no longer attached.
        let (position, size) = fit_reader_frame(frame(4000.0, 300.0, 700.0, 500.0), &screens);
        assert_eq!(position, PhysicalPosition { x: 1480, y: 600 });
        assert_eq!(size, PhysicalSize { width: 1400, height: 1000 });
    }

    #[test]
    fn a_frame_larger_than_the_screen_is_cut_down_to_it() {
        // A corrupt document, or an arrangement that no longer exists. The
        // window that comes back still has to fit on a display.
        let screens = [monitor(0, 0, 1440.0, 900.0, 1.0)];
        let (position, size) = fit_reader_frame(frame(0.0, 0.0, 9000.0, 9000.0), &screens);
        assert_eq!(size, PhysicalSize { width: 1440, height: 900 });
        assert_eq!(position, PhysicalPosition { x: 0, y: 0 });
    }

    #[test]
    fn a_window_hanging_off_the_edge_is_pulled_back_on() {
        // One pixel of origin on screen used to count as "fine", which leaves no
        // titlebar to grab.
        let screens = [monitor(0, 0, 1440.0, 900.0, 1.0)];
        let (position, _) = fit_reader_frame(frame(1439.0, 899.0, 800.0, 600.0), &screens);
        assert_eq!(position, PhysicalPosition { x: 640, y: 300 });
    }

    #[test]
    fn a_monitor_left_of_the_primary_keeps_its_negative_coordinates() {
        // Displays arranged to the left or above have negative origins, and a
        // frame there is perfectly valid.
        let screens = [
            monitor(0, 0, 1440.0, 900.0, 1.0),
            monitor(-1920, 0, 1920.0, 1080.0, 1.0),
        ];
        let (position, size) = fit_reader_frame(frame(-1800.0, 100.0, 800.0, 600.0), &screens);
        assert_eq!(position, PhysicalPosition { x: -1800, y: 100 });
        assert_eq!(size, PhysicalSize { width: 800, height: 600 });
    }

    #[test]
    fn no_monitors_at_all_is_survivable() {
        // Nothing to compute against; the caller's own clamp still gets a look.
        let (_, size) = fit_reader_frame(frame(10.0, 10.0, 800.0, 600.0), &[]);
        assert_eq!(size, PhysicalSize { width: 800, height: 600 });
    }

    #[test]
    fn a_fractional_scale_still_lands_inside_the_monitor() {
        let screens = [monitor(0, 0, 1536.0, 864.0, 1.25)];
        let (position, size) = fit_reader_frame(frame(100.0, 50.0, 800.0, 600.0), &screens);
        assert_eq!(size, PhysicalSize { width: 1000, height: 750 });
        assert_eq!(position, PhysicalPosition { x: 125, y: 63 });
    }

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
    /// The Windows freeze, in miniature: a window event handler asking while the
    /// SAME thread holds the latch mid-change. A blocking read never returned.
    #[test]
    fn asking_mid_change_answers_presenting_instead_of_waiting_on_itself() {
        let held = lock();
        assert!(is_presenting(), "a change in flight is a presentation in flight");
        drop(held);
    }

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
