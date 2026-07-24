//! Display-sleep assertion for a live take (spec §52.7).
//!
//! A teleprompter is the one app where the operator deliberately stops touching
//! the keyboard and mouse for twenty-plus minutes — which is exactly when macOS
//! (default 10–20 min) and Windows blank the display. The stage going dark
//! mid-take ruins the take.
//!
//! The assertion is created when the stage starts presenting and released on
//! un-present, close, stage-window destruction, and quit. Create and release
//! are strictly paired through [`plan`] so the assertion cannot leak or be
//! double-released; the OS also drops it automatically if the process dies.
//!
//! Implemented with direct platform FFI rather than a dependency: macOS
//! `IOPMAssertionCreateWithName`, Windows `SetThreadExecutionState`. Everything
//! else is a no-op.

use std::sync::{Mutex, OnceLock};

use tauri::AppHandle;

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

fn state() -> &'static Mutex<Option<PlatformAssertion>> {
    static STATE: OnceLock<Mutex<Option<PlatformAssertion>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(None))
}

/// Hold the display awake. Safe to call repeatedly.
pub fn acquire(_app: &AppHandle) {
    let mut guard = match state().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    if plan(guard.is_some(), true) != SleepAction::Create {
        return;
    }
    match PlatformAssertion::create() {
        Some(assertion) => {
            tracing::debug!("display sleep assertion acquired");
            *guard = Some(assertion);
        }
        None => tracing::warn!("could not block display sleep for this take"),
    }
}

/// Let the display sleep again. Safe to call repeatedly, and safe to call when
/// no assertion was ever taken.
pub fn release(_app: &AppHandle) {
    let mut guard = match state().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    if plan(guard.is_some(), false) != SleepAction::Release {
        return;
    }
    if let Some(assertion) = guard.take() {
        assertion.release();
        tracing::debug!("display sleep assertion released");
    }
}

/// True while the display is being held awake (diagnostics/tests).
pub fn is_held() -> bool {
    match state().lock() {
        Ok(guard) => guard.is_some(),
        Err(poisoned) => poisoned.into_inner().is_some(),
    }
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
            let name = CfString::new("CandidCue teleprompter take")?;
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
                .name("candidcue-keep-awake".into())
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

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
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
}
