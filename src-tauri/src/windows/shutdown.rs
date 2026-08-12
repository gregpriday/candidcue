//! Coordinated close and quit.
//!
//! ## What used to happen
//!
//! Nothing. Closing the control window or pressing ⌘Q went straight to process
//! exit, and the application's run-loop handler released the sleep assertion
//! and closed identification overlays — the two things that would otherwise
//! outlive the process. Everything the FRONTEND owns was simply abandoned:
//!
//!  - a debounced editor save still inside its window;
//!  - an in-flight save;
//!  - an unresolved external-change conflict;
//!  - the current take, leaving its session row open until the next launch
//!    swept it as "abandoned";
//!  - the reader-window frame, so the next take opened somewhere else;
//!  - audio capture, alignment, and any preview stage window.
//!
//! Some of that is repaired on the next launch. "Repair later" is not the same
//! as a clean shutdown, and the highest-value item on the list — the newest
//! edits to a script — is not repairable at all.
//!
//! ## The handshake
//!
//! Rust intercepts the close, emits [`events::SHUTDOWN_REQUESTED`] to control,
//! and waits for [`events::SHUTDOWN_COMPLETE`] up to [`SHUTDOWN_DEADLINE`].
//! Then it proceeds — whether or not the answer came.
//!
//! The deadline is not a formality. A WebView that has crashed, hung on a
//! breakpoint, or is mid-paint cannot answer, and a user who has pressed ⌘Q
//! must be able to quit. So the fail-safe is the design, not the exception:
//! the frontend gets one bounded chance, and Rust's own cleanup runs either
//! way.
//!
//! ## What Rust does regardless
//!
//! Releases the display-sleep assertion, closes identification overlays, and
//! stops the recogniser. The first two would otherwise outlive the process
//! (they are OS-level); the third holds an ONNX session on a dedicated thread
//! and a microphone the OS shows as in use.
//!
//! Session rows are deliberately NOT closed here. `close_orphaned_sessions`
//! runs at startup and is the one path that covers every abnormal exit —
//! including the ones no handler sees, like a kill or a power loss. Adding a
//! second closer here would mean two code paths deciding what an abandoned
//! session looks like.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::{Emitter, Listener, Manager};

use super::{events, CONTROL_LABEL};

/// How long the frontend gets to flush before Rust stops waiting.
///
/// Long enough for a debounced save (600 ms by default) plus a real write and
/// a session finalisation; short enough that a broken WebView does not read as
/// an application that will not quit. Quitting is a thing users do when
/// something is already wrong.
pub const SHUTDOWN_DEADLINE: Duration = Duration::from_millis(4_000);

/// Set once the handshake has run, so it cannot run twice.
///
/// Both paths lead here — the window's close button and the application's
/// Quit — and on macOS ⌘Q produces both. Without this, quitting would ask the
/// frontend to flush, then ask again while it was flushing.
#[derive(Default)]
pub struct ShutdownState {
    running: AtomicBool,
    finished: AtomicBool,
}

impl ShutdownState {
    /// True if this call is the one that owns the handshake.
    fn claim(&self) -> bool {
        !self.running.swap(true, Ordering::SeqCst)
    }

    pub fn is_finished(&self) -> bool {
        self.finished.load(Ordering::SeqCst)
    }

    fn mark_finished(&self) {
        self.finished.store(true, Ordering::SeqCst);
    }
}

/// Ask the frontend to shut down cleanly, and wait — briefly — for it.
///
/// Blocking is correct here: the caller is a close/exit handler that has
/// already prevented the default, and the whole point is that the process does
/// not go away until the flush has had its chance.
///
/// **Returns `true` only for the caller that owns the handshake.** That is the
/// contract callers must respect, and getting it wrong is a real bug: both the
/// window-close path and the quit path spawn a thread, and the first version
/// had each of them call `exit(0)` unconditionally afterwards. A non-owner
/// returned instantly — the claim was already taken — and exited the process
/// while the owner was still waiting for the editor to flush. Only the owner
/// may exit.
#[must_use]
pub fn run_shutdown_handshake<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    let state = app.state::<ShutdownState>();
    if !state.claim() {
        // Someone else owns it. Do nothing at all — in particular, do not
        // exit: the owner is still flushing.
        return false;
    }

    let acknowledged = Arc::new(AtomicBool::new(false));

    let listener_flag = acknowledged.clone();
    let listener = app.listen_any(events::SHUTDOWN_COMPLETE, move |_event| {
        listener_flag.store(true, Ordering::SeqCst);
    });

    let emitted = app
        .emit_to(CONTROL_LABEL, events::SHUTDOWN_REQUESTED, ())
        .is_ok();

    if emitted {
        let deadline = std::time::Instant::now() + SHUTDOWN_DEADLINE;
        while std::time::Instant::now() < deadline {
            if acknowledged.load(Ordering::SeqCst) {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        if acknowledged.load(Ordering::SeqCst) {
            tracing::info!("frontend acknowledged shutdown");
        } else {
            tracing::warn!(
                deadline_ms = SHUTDOWN_DEADLINE.as_millis(),
                "frontend did not acknowledge shutdown in time; continuing"
            );
        }
    } else {
        // No control window to ask. Nothing to flush, and nothing to wait for.
        tracing::info!("no control window at shutdown; skipping the frontend handshake");
    }

    app.unlisten(listener);

    // Rust's own cleanup, which runs whatever the frontend did.
    stop_native_resources(app);
    app.state::<ShutdownState>().mark_finished();
    true
}

/// The things that would outlive the process, or the microphone light.
fn stop_native_resources<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(engine) = app.try_state::<crate::speech::SpeechEngine>() {
        // Stops the decoder thread and releases the microphone. Without this,
        // a quit during a take can leave the OS showing the mic in use until
        // the process is reaped.
        engine.shutdown();
    }
}
