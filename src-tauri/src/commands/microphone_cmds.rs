//! The operating system's side of microphone access (#303).
//!
//! macOS asks once per application. After a refusal `getUserMedia` fails at
//! once with `NotAllowedError` and no prompt, and the only remedy is the
//! Microphone list in System Settings › Privacy & Security — which nothing in
//! the app could reach, so a refused permission was a dead end. These two
//! commands are the way back:
//!
//!   - `get_microphone_permission` answers "has this application been allowed
//!     the microphone?" WITHOUT asking. WKWebView does not implement
//!     `navigator.permissions.query({ name: 'microphone' })`, so the webview
//!     cannot tell a first launch from a refusal from a grant, and the take
//!     only found out after Present had already turned the window into the
//!     prompter.
//!   - `open_microphone_settings` opens that privacy pane.
//!
//! Neither takes an argument. The pane is a compile-time constant per platform,
//! for the reason `web.rs` gives for its own table: a webview that can name what
//! gets launched has been handed an opener, and this is not one.

use serde::Serialize;

use crate::errors::AppError;

/// Whether this application may use the microphone, as the OS records it.
///
/// `Prompt` is "never asked", which is the only state in which the OS will show
/// its prompt. `Unsupported` is "this platform cannot say", and callers must
/// treat it as unknown rather than as either answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MicrophonePermission {
    Granted,
    Denied,
    /// Managed by policy — Screen Time, a device profile — rather than by the
    /// user's own choice, so the toggle in Settings may not be theirs to flip.
    Restricted,
    Prompt,
    Unsupported,
}

impl MicrophonePermission {
    /// `AVAuthorizationStatus`, which is an `NSInteger` enum.
    ///
    /// Anything outside the four documented values is reported as unknown
    /// rather than guessed at: calling an unrecognised status "denied" would
    /// accuse the user of a refusal they never made.
    pub fn from_av_authorization_status(status: isize) -> Self {
        match status {
            0 => Self::Prompt,
            1 => Self::Restricted,
            2 => Self::Denied,
            3 => Self::Granted,
            _ => Self::Unsupported,
        }
    }
}

/// The microphone privacy pane for this platform, or `None` where there is no
/// single pane to open.
///
/// macOS 13 renamed System Preferences to System Settings, and this legacy
/// `com.apple.preference.security` anchor still lands on Privacy & Security ›
/// Microphone there and on every release since.
pub const fn microphone_settings_url() -> Option<&'static str> {
    if cfg!(target_os = "macos") {
        Some("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
    } else if cfg!(target_os = "windows") {
        Some("ms-settings:privacy-microphone")
    } else {
        None
    }
}

/// Read the microphone authorisation. Never prompts.
///
/// `+[AVCaptureDevice authorizationStatusForMediaType:]` only reports; asking
/// is a different selector (`requestAccessForMediaType:completionHandler:`),
/// which this file deliberately never sends. The prompt stays where §28.1 puts
/// it: behind an explicit user action, through `getUserMedia`.
///
/// Under `tauri dev` the answer is the TERMINAL's, because macOS attributes the
/// microphone to the responsible process. So is `getUserMedia`'s, so the two
/// still agree; only a packaged build reports CandidCue's own entry.
#[tauri::command]
pub async fn get_microphone_permission() -> Result<MicrophonePermission, AppError> {
    #[cfg(target_os = "macos")]
    {
        Ok(macos_av_authorization::audio_status()
            .map(MicrophonePermission::from_av_authorization_status)
            .unwrap_or(MicrophonePermission::Unsupported))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(MicrophonePermission::Unsupported)
    }
}

/// Open the OS microphone privacy pane.
///
/// Through Rust's opener rather than the webview's: capabilities gate only the
/// JavaScript→plugin path, and the control window is deliberately not granted
/// `opener:default` (see `capabilities/control.json`).
#[tauri::command]
pub async fn open_microphone_settings() -> Result<(), AppError> {
    let Some(url) = microphone_settings_url() else {
        return Err(AppError::not_implemented("Opening the microphone privacy settings"));
    };
    tauri_plugin_opener::open_url(url, None::<&str>)
        .map_err(|e| AppError::Internal(format!("could not open the microphone settings: {e}")))
}

/// `+[AVCaptureDevice authorizationStatusForMediaType:]`, through raw
/// `objc_msgSend`.
///
/// Raw FFI rather than an `objc2` dependency, matching `shell_cmds.rs` and
/// `windows/present.rs`: this is one class method taking one object and
/// returning one integer.
#[cfg(target_os = "macos")]
mod macos_av_authorization {
    use std::ffi::{c_char, c_void};

    #[link(name = "objc", kind = "dylib")]
    extern "C-unwind" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *const c_void;
        fn objc_msgSend();
    }

    // Linked, not merely looked up: `objc_getClass` only finds a class whose
    // framework is loaded, and nothing else in the process is guaranteed to
    // have loaded AVFoundation.
    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {
        /// `AVMediaType const AVMediaTypeAudio` — an `NSString *`.
        static AVMediaTypeAudio: *mut c_void;
    }

    /// `NSInteger` is `isize`, and the argument is an `id`.
    unsafe fn msg_with_id_returning_int(
        receiver: *mut c_void,
        selector: *const c_void,
        argument: *mut c_void,
    ) -> isize {
        let send: extern "C-unwind" fn(*mut c_void, *const c_void, *mut c_void) -> isize =
            std::mem::transmute(objc_msgSend as *const ());
        send(receiver, selector, argument)
    }

    /// The raw status, or `None` if AVFoundation could not be reached.
    pub fn audio_status() -> Option<isize> {
        // SAFETY: `objc_getClass` and `sel_registerName` take NUL-terminated
        // literals and return null rather than failing. The class method is
        // documented as thread-safe, reads TCC state without prompting, and
        // takes an `AVMediaType`, which `AVMediaTypeAudio` is.
        unsafe {
            let class = objc_getClass(c"AVCaptureDevice".as_ptr());
            if class.is_null() || AVMediaTypeAudio.is_null() {
                return None;
            }
            Some(msg_with_id_returning_int(
                class,
                sel_registerName(c"authorizationStatusForMediaType:".as_ptr()),
                AVMediaTypeAudio,
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_every_documented_av_status() {
        assert_eq!(
            MicrophonePermission::from_av_authorization_status(0),
            MicrophonePermission::Prompt
        );
        assert_eq!(
            MicrophonePermission::from_av_authorization_status(1),
            MicrophonePermission::Restricted
        );
        assert_eq!(
            MicrophonePermission::from_av_authorization_status(2),
            MicrophonePermission::Denied
        );
        assert_eq!(
            MicrophonePermission::from_av_authorization_status(3),
            MicrophonePermission::Granted
        );
    }

    #[test]
    fn an_unknown_av_status_is_not_called_a_refusal() {
        for status in [-1, 4, 99] {
            assert_eq!(
                MicrophonePermission::from_av_authorization_status(status),
                MicrophonePermission::Unsupported
            );
        }
    }

    #[test]
    fn serialises_as_the_frontend_union() {
        // src/shared/contracts/audio.ts `MicrophonePermission`.
        let names: Vec<String> = [
            MicrophonePermission::Granted,
            MicrophonePermission::Denied,
            MicrophonePermission::Restricted,
            MicrophonePermission::Prompt,
            MicrophonePermission::Unsupported,
        ]
        .iter()
        .map(|p| serde_json::to_string(p).unwrap())
        .collect();
        assert_eq!(
            names,
            [
                "\"granted\"",
                "\"denied\"",
                "\"restricted\"",
                "\"prompt\"",
                "\"unsupported\""
            ]
        );
    }

    #[test]
    fn the_settings_pane_is_a_fixed_os_url() {
        let url = microphone_settings_url();
        if cfg!(target_os = "macos") {
            assert_eq!(
                url,
                Some("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
            );
        } else if cfg!(target_os = "windows") {
            assert_eq!(url, Some("ms-settings:privacy-microphone"));
        } else {
            assert_eq!(url, None);
        }
    }

    /// Reads, never asks. Run by hand on a Mac to see what TCC reports for the
    /// process running the test (usually the terminal):
    /// `cargo test --lib microphone_cmds -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn prints_this_process_microphone_permission() {
        let status = tauri::async_runtime::block_on(get_microphone_permission());
        println!("microphone permission: {status:?}");
    }
}
