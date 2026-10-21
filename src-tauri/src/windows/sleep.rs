//! Display-sleep assertion for a live take (spec §52.7).
//!
//! A teleprompter is the one app where the operator deliberately stops touching
//! the keyboard and mouse for twenty-plus minutes — which is exactly when macOS
//! (default 10–20 min) and Windows blank the display. The stage going dark
//! mid-take ruins the take.
//!
//! Two things present, and they share the one assertion: the single-window take
//! and the separate stage window (preview, display test, calibration). Each
//! records its own claim as a [`SleepHolder`] when it presents and withdraws it
//! on un-present, close or window destruction; quit drops them all. The
//! assertion is created with the first claim and released with the last, and
//! the two are strictly paired through [`plan`] so it cannot leak or be
//! double-released; the OS also drops it automatically if the process dies.
//!
//! With one bare slot instead of claims, closing a display test from Settings
//! mid-take released the take's assertion, and the prompter slept on the
//! operator's idle timer partway through the read.
//!
//! Implemented with direct platform FFI rather than a dependency: macOS
//! `IOPMAssertionCreateWithName`, Windows `SetThreadExecutionState`. Linux asks
//! the session bus (`org.freedesktop.ScreenSaver.Inhibit`, then the desktop
//! portal), through the zbus the single-instance plugin already links.
//! Everything else is a no-op.

use std::collections::BTreeSet;
use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Runtime};

/// What the platform layer should do, given the current state and the wish.
/// Pure, so the create/release pairing is testable without a display server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SleepAction {
    Create,
    Release,
    None,
}

/// Idempotent transition: creating while held or releasing while free is a
/// no-op, which is what keeps the assertion from leaking across the
/// present → close → reopen cycle.
pub fn plan(currently_held: bool, want_held: bool) -> SleepAction {
    match (currently_held, want_held) {
        (false, true) => SleepAction::Create,
        (true, false) => SleepAction::Release,
        _ => SleepAction::None,
    }
}

/// Who wants the display awake.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum SleepHolder {
    /// The control window presenting a take (`present.rs`).
    Take,
    /// One stage window, by generation. Not a single "the stage" claim:
    /// `open_stage` replaces the window, and the old one's `Destroyed` runs on
    /// another thread, so it can land after its replacement has presented —
    /// the same overlap `AppCoordinator::stage_closed` guards against.
    Stage(u64),
}

/// The claims outstanding, and the one OS assertion they share. A set, not a
/// count: the stage path withdraws the same claim up to three times for one
/// window (un-present, `close_stage`, `Destroyed`), and a count would go
/// negative and strand somebody else's.
#[derive(Default)]
struct State {
    holders: BTreeSet<SleepHolder>,
    assertion: Option<PlatformAssertion>,
}

fn state() -> &'static Mutex<State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(State::default()))
}

fn lock() -> std::sync::MutexGuard<'static, State> {
    match state().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// Bring the OS assertion in line with the claims. A claim stands even when
/// the platform refuses the assertion, so the next acquire tries again and the
/// last release still pairs.
fn settle(state: &mut State) {
    match plan(state.assertion.is_some(), !state.holders.is_empty()) {
        SleepAction::Create => match PlatformAssertion::create() {
            Some(assertion) => {
                tracing::debug!("display sleep assertion acquired");
                state.assertion = Some(assertion);
            }
            None => tracing::warn!("could not block display sleep for this take"),
        },
        SleepAction::Release => {
            if let Some(assertion) = state.assertion.take() {
                assertion.release();
                tracing::debug!("display sleep assertion released");
            }
        }
        SleepAction::None => {}
    }
}

/// Hold the display awake on `holder`'s behalf. Safe to call repeatedly.
pub fn acquire<R: Runtime>(_app: &AppHandle<R>, holder: SleepHolder) {
    let mut guard = lock();
    guard.holders.insert(holder);
    settle(&mut guard);
}

/// Withdraw `holder`'s claim; the display may sleep once nobody else holds
/// it. Safe to call repeatedly, and safe to call when no claim was ever made.
///
/// Only the last withdrawal touches the platform. One that leaves somebody
/// else's claim standing is not the moment to retry an assertion the platform
/// already refused — on a platform with none to give, that is a warning per
/// close.
pub fn release<R: Runtime>(_app: &AppHandle<R>, holder: SleepHolder) {
    let mut guard = lock();
    guard.holders.remove(&holder);
    if guard.holders.is_empty() {
        settle(&mut guard);
    }
}

/// Drop every claim at once. Quit only: nothing that outlives the app may keep
/// the display awake.
pub fn release_all<R: Runtime>(_app: &AppHandle<R>) {
    let mut guard = lock();
    guard.holders.clear();
    settle(&mut guard);
}

/// True while the display is being held awake (diagnostics/tests).
pub fn is_held() -> bool {
    lock().assertion.is_some()
}

// ---------------------------------------------------------------------------
// macOS — IOPMAssertionCreateWithName / IOPMAssertionRelease
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::CString;
    use std::os::raw::{c_char, c_void};

    type CFStringRef = *const c_void;
    type IOReturn = i32;
    type IOPMAssertionID = u32;

    const K_IO_RETURN_SUCCESS: IOReturn = 0;
    const K_IOPM_ASSERTION_LEVEL_ON: u32 = 255;
    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(
            alloc: *const c_void,
            c_str: *const c_char,
            encoding: u32,
        ) -> CFStringRef;
        fn CFRelease(cf: *const c_void);
    }

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMAssertionCreateWithName(
            assertion_type: CFStringRef,
            assertion_level: u32,
            assertion_name: CFStringRef,
            assertion_id: *mut IOPMAssertionID,
        ) -> IOReturn;
        fn IOPMAssertionRelease(assertion_id: IOPMAssertionID) -> IOReturn;
    }

    struct CfString(CFStringRef);

    impl CfString {
        fn new(value: &str) -> Option<Self> {
            let c_string = CString::new(value).ok()?;
            // SAFETY: `c_string` outlives the call; CoreFoundation copies the
            // bytes into the new CFString.
            let handle = unsafe {
                CFStringCreateWithCString(
                    std::ptr::null(),
                    c_string.as_ptr(),
                    K_CF_STRING_ENCODING_UTF8,
                )
            };
            if handle.is_null() {
                None
            } else {
                Some(Self(handle))
            }
        }
    }

    impl Drop for CfString {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: created by CFStringCreateWithCString, released once.
                unsafe { CFRelease(self.0) };
            }
        }
    }

    pub struct Assertion(IOPMAssertionID);

    impl Assertion {
        pub fn create() -> Option<Self> {
            let kind = CfString::new("NoDisplaySleepAssertion")?;
            let name = CfString::new("Speaking Glass teleprompter take")?;
            let mut id: IOPMAssertionID = 0;
            // SAFETY: both CFStrings are live for the duration of the call and
            // `id` is a valid out-pointer.
            let result = unsafe {
                IOPMAssertionCreateWithName(
                    kind.0,
                    K_IOPM_ASSERTION_LEVEL_ON,
                    name.0,
                    &mut id as *mut IOPMAssertionID,
                )
            };
            if result == K_IO_RETURN_SUCCESS {
                Some(Self(id))
            } else {
                None
            }
        }

        pub fn release(self) {
            // SAFETY: `self.0` came from a successful create and is released
            // exactly once — `release` consumes the value.
            unsafe { IOPMAssertionRelease(self.0) };
        }
    }
}

// ---------------------------------------------------------------------------
// Windows — SetThreadExecutionState
// ---------------------------------------------------------------------------
//
// The execution state is per-THREAD and persists only while that thread lives,
// so the assertion owns a dedicated thread that sets the flags and then parks
// until it is told to stand down. Setting the flags on a Tauri command thread
// would be silently undone the moment that pooled thread was recycled.

#[cfg(target_os = "windows")]
mod platform {
    use std::sync::mpsc::{sync_channel, SyncSender};

    const ES_CONTINUOUS: u32 = 0x8000_0000;
    const ES_DISPLAY_REQUIRED: u32 = 0x0000_0002;
    const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;

    #[link(name = "kernel32")]
    extern "system" {
        fn SetThreadExecutionState(es_flags: u32) -> u32;
    }

    pub struct Assertion(SyncSender<()>);

    impl Assertion {
        pub fn create() -> Option<Self> {
            let (tx, rx) = sync_channel::<()>(1);
            std::thread::Builder::new()
                .name("speaking-glass-keep-awake".into())
                .spawn(move || {
                    // SAFETY: plain Win32 call with no pointer arguments.
                    let previous = unsafe {
                        SetThreadExecutionState(
                            ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED,
                        )
                    };
                    if previous == 0 {
                        return;
                    }
                    // Park until released; the flags live as long as we do.
                    let _ = rx.recv();
                    // SAFETY: same, clearing our request.
                    unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
                })
                .ok()?;
            Some(Self(tx))
        }

        pub fn release(self) {
            let _ = self.0.send(());
        }
    }
}

// ---------------------------------------------------------------------------
// Linux — org.freedesktop.ScreenSaver.Inhibit over the session bus
// ---------------------------------------------------------------------------
//
// The freedesktop idle-inhibit interface, which GNOME (through its
// screensaver proxy), KDE Plasma, Xfce, Cinnamon and MATE all answer, with the
// XDG desktop portal's `Inhibit` as the fallback for a session that only has a
// portal. Both inhibitions belong to the D-Bus CONNECTION that asked: the
// session drops them when it closes, so a crashed app cannot leave the display
// held. That is also why the connection lives exactly as long as the claim —
// on a thread of its own, like the Windows arm, so a slow or missing bus never
// stalls Present: `create` answers at once and the thread does the talking.
//
// A session with neither service (a bare window manager, a container) gets a
// warning in the log and the system's own idle policy, which is what every
// Linux build had before this.

#[cfg(target_os = "linux")]
mod platform {
    use std::sync::mpsc::{sync_channel, SyncSender};

    use zbus::blocking::Connection;
    use zbus::zvariant::{OwnedObjectPath, Value};

    const APP: &str = "Speaking Glass";
    const REASON: &str = "A teleprompter take is on screen";

    /// What has to be undone when the claim is withdrawn.
    enum Held {
        ScreenSaver(u32),
        Portal(OwnedObjectPath),
    }

    fn inhibit(connection: &Connection) -> zbus::Result<Held> {
        let screensaver = connection.call_method(
            Some("org.freedesktop.ScreenSaver"),
            "/org/freedesktop/ScreenSaver",
            Some("org.freedesktop.ScreenSaver"),
            "Inhibit",
            &(APP, REASON),
        );
        match screensaver {
            Ok(reply) => Ok(Held::ScreenSaver(reply.body().deserialize::<u32>()?)),
            Err(screensaver_error) => {
                // Flag 8 is "idle": the session may not blank or lock.
                let mut options = std::collections::HashMap::new();
                options.insert("reason", Value::from(REASON));
                let portal = connection.call_method(
                    Some("org.freedesktop.portal.Desktop"),
                    "/org/freedesktop/portal/desktop",
                    Some("org.freedesktop.portal.Inhibit"),
                    "Inhibit",
                    &("", 8u32, options),
                );
                match portal {
                    Ok(reply) => Ok(Held::Portal(reply.body().deserialize::<OwnedObjectPath>()?)),
                    Err(portal_error) => {
                        tracing::warn!(
                            screensaver = %screensaver_error,
                            portal = %portal_error,
                            "neither the ScreenSaver service nor the desktop portal will hold the display awake"
                        );
                        Err(portal_error)
                    }
                }
            }
        }
    }

    fn uninhibit(connection: &Connection, held: Held) {
        let result = match &held {
            Held::ScreenSaver(cookie) => connection
                .call_method(
                    Some("org.freedesktop.ScreenSaver"),
                    "/org/freedesktop/ScreenSaver",
                    Some("org.freedesktop.ScreenSaver"),
                    "UnInhibit",
                    &(*cookie,),
                )
                .map(drop),
            Held::Portal(request) => connection
                .call_method(
                    Some("org.freedesktop.portal.Desktop"),
                    request.as_str(),
                    Some("org.freedesktop.portal.Request"),
                    "Close",
                    &(),
                )
                .map(drop),
        };
        // Closing the connection drops the inhibition anyway; this only makes
        // it prompt.
        if let Err(err) = result {
            tracing::debug!(error = %err, "the display-sleep inhibition was not withdrawn explicitly");
        }
    }

    pub struct Assertion(SyncSender<()>);

    impl Assertion {
        pub fn create() -> Option<Self> {
            let (tx, rx) = sync_channel::<()>(1);
            std::thread::Builder::new()
                .name("speaking-glass-keep-awake".into())
                .spawn(move || {
                    let connection = match Connection::session() {
                        Ok(connection) => connection,
                        Err(err) => {
                            tracing::warn!(error = %err, "no session bus; the display may sleep during this take");
                            return;
                        }
                    };
                    let Ok(held) = inhibit(&connection) else { return };
                    // Park until released; the inhibition lives as long as
                    // the connection does.
                    let _ = rx.recv();
                    uninhibit(&connection, held);
                })
                .ok()?;
            Some(Self(tx))
        }

        pub fn release(self) {
            let _ = self.0.send(());
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod platform {
    pub struct Assertion;

    impl Assertion {
        pub fn create() -> Option<Self> {
            None
        }
        pub fn release(self) {}
    }
}

use platform::Assertion as PlatformAssertion;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_and_release_are_strictly_paired() {
        // Nothing held yet: a request creates.
        assert_eq!(plan(false, true), SleepAction::Create);
        // Already held: presenting again must not create a second assertion,
        // which is how an assertion leaks past the take that owns it.
        assert_eq!(plan(true, true), SleepAction::None);
        // Held and no longer wanted: release exactly once.
        assert_eq!(plan(true, false), SleepAction::Release);
        // Not held: pause/stop/close/quit all call release, and only the first
        // may actually do anything.
        assert_eq!(plan(false, false), SleepAction::None);
    }

    #[test]
    fn a_full_take_cycle_leaves_nothing_held() {
        let mut held = false;
        // present → pause → present → close
        for want in [true, false, true, false] {
            match plan(held, want) {
                SleepAction::Create => held = true,
                SleepAction::Release => held = false,
                SleepAction::None => {}
            }
        }
        assert!(!held, "the assertion must not survive the take");
    }

    /// The claims are one process-wide slot, and these tests drive it for
    /// real; one at a time, each starting from nothing.
    fn serial() -> std::sync::MutexGuard<'static, ()> {
        static SERIAL: Mutex<()> = Mutex::new(());
        let guard = SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        release_all(mock_app().handle());
        guard
    }

    fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
        tauri::test::mock_app()
    }

    fn holders() -> Vec<SleepHolder> {
        lock().holders.iter().copied().collect()
    }

    #[test]
    fn closing_a_display_test_mid_take_keeps_the_display_awake() {
        let _serial = serial();
        let app = mock_app();
        let app = app.handle();
        acquire(app, SleepHolder::Take);
        let take_held = is_held();
        // Settings' display test presents and is closed four seconds later.
        // Its claim can be withdrawn three times over — un-present,
        // `close_stage`, `Destroyed` — and it is presented twice here, which a
        // set must still let one withdrawal undo.
        acquire(app, SleepHolder::Stage(4));
        acquire(app, SleepHolder::Stage(4));
        release(app, SleepHolder::Stage(4));
        assert_eq!(holders(), [SleepHolder::Take]);
        release(app, SleepHolder::Stage(4));
        release(app, SleepHolder::Stage(4));
        release(app, SleepHolder::Stage(4));
        assert_eq!(holders(), [SleepHolder::Take], "the take still owns the display");
        assert_eq!(is_held(), take_held, "and the assertion it took is still there");
        // The take ending is what finally lets it sleep.
        release(app, SleepHolder::Take);
        assert!(holders().is_empty());
        assert!(!is_held(), "the assertion must not survive the take");
    }

    #[test]
    fn ending_the_take_under_an_open_preview_keeps_the_display_awake() {
        let _serial = serial();
        let app = mock_app();
        let app = app.handle();
        // A preview left open while Present is pressed, and the take ends
        // first: the preview is still on the glass. `PresentAction::Nothing`
        // withdraws the take's claim a second time on the way out.
        acquire(app, SleepHolder::Stage(2));
        let stage_held = is_held();
        acquire(app, SleepHolder::Take);
        release(app, SleepHolder::Take);
        release(app, SleepHolder::Take);
        assert_eq!(holders(), [SleepHolder::Stage(2)]);
        assert_eq!(is_held(), stage_held);
        release(app, SleepHolder::Stage(2));
        assert!(!is_held(), "nothing may outlive both");
    }

    #[test]
    fn a_replaced_stage_window_cannot_release_its_replacement() {
        let _serial = serial();
        let app = mock_app();
        let app = app.handle();
        // `open_stage` destroys generation 6 and builds 7; 6's `Destroyed`
        // lands after 7 has presented.
        acquire(app, SleepHolder::Stage(6));
        let held = is_held();
        acquire(app, SleepHolder::Stage(7));
        release(app, SleepHolder::Stage(6));
        assert_eq!(holders(), [SleepHolder::Stage(7)]);
        assert_eq!(is_held(), held);
        release(app, SleepHolder::Stage(7));
        assert!(!is_held());
    }

    #[test]
    fn quitting_drops_every_claim() {
        let _serial = serial();
        let app = mock_app();
        let app = app.handle();
        acquire(app, SleepHolder::Take);
        acquire(app, SleepHolder::Stage(1));
        release_all(app);
        assert!(holders().is_empty());
        assert!(!is_held());
        // `ExitRequested` and then `Exit` both arrive.
        release_all(app);
        assert!(!is_held());
    }

    #[test]
    fn releasing_a_claim_nobody_made_changes_nothing() {
        let _serial = serial();
        let app = mock_app();
        let app = app.handle();
        release(app, SleepHolder::Stage(3));
        release(app, SleepHolder::Take);
        assert!(holders().is_empty());
        assert!(!is_held());
    }

    /// The command the issue was about, not just the bookkeeping under it:
    /// `close_stage` must withdraw the stage's claim and leave the take's.
    #[test]
    fn close_stage_leaves_a_running_take_holding_the_display() {
        use tauri::Manager as _;

        let _serial = serial();
        let app = mock_app();
        app.manage(crate::coordinator::AppCoordinator::default());
        let _stage = tauri::WebviewWindowBuilder::new(
            &app,
            super::super::STAGE_LABEL,
            tauri::WebviewUrl::App("stage.html".into()),
        )
        .build()
        .expect("mock stage webview");
        let session_id = "display-test-session";
        let coordinator = app.state::<crate::coordinator::AppCoordinator>();
        let generation = coordinator.next_stage_generation();
        coordinator.register_stage(generation, Some(session_id.to_string()), None);

        let handle = app.handle();
        acquire(handle, SleepHolder::Take);
        let take_held = is_held();
        acquire(handle, SleepHolder::Stage(generation));
        super::super::close_stage(handle, session_id).expect("the test's own stage closes");
        assert_eq!(holders(), [SleepHolder::Take]);
        assert_eq!(is_held(), take_held, "the take's assertion survives the close");

        // A late second close from the same caller is a cleanup, not a release
        // of anything the take holds.
        super::super::close_stage(handle, session_id).expect("closing again is a cleanup");
        assert_eq!(holders(), [SleepHolder::Take]);
        assert_eq!(is_held(), take_held);

        release(handle, SleepHolder::Take);
        assert!(!is_held());
    }
}
