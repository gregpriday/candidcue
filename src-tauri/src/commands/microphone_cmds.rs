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

    /// Windows' privacy settings for a DESKTOP application, which is what
    /// CandidCue is to Windows.
    ///
    /// There is no "never asked": Windows does not prompt desktop apps one by
    /// one, so the answer is always one of three. Each `Value` is the string
    /// `Allow` or `Deny`, and a missing one is the default, which allows.
    ///
    ///   - `policy_denies`: Group Policy forces "Let Windows apps access the
    ///     microphone" off (`LetAppsAccessMicrophone` = 2). Managed by an
    ///     administrator — restricted.
    ///   - `device`: Settings › Privacy & security › Microphone › "Microphone
    ///     access", which is machine-wide and needs an administrator to change
    ///     — restricted, for the same reason.
    ///   - `user`: "Let apps access your microphone", the user's master switch.
    ///   - `desktop_apps`: "Let desktop apps access your microphone", the one
    ///     that actually names CandidCue. Either of these two off is a refusal
    ///     the user made and can undo — denied.
    pub fn from_windows_consent(
        policy_denies: bool,
        device: Option<&str>,
        user: Option<&str>,
        desktop_apps: Option<&str>,
    ) -> Self {
        let denies = |value: Option<&str>| value.is_some_and(|v| v.eq_ignore_ascii_case("Deny"));
        if policy_denies || denies(device) {
            Self::Restricted
        } else if denies(user) || denies(desktop_apps) {
            Self::Denied
        } else {
            Self::Granted
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
    #[cfg(target_os = "windows")]
    {
        Ok(windows_consent::microphone())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Ok(MicrophonePermission::Unsupported)
    }
}

/// The microphone consent store, read straight from the registry — the same
/// keys Settings › Privacy & security › Microphone writes. Raw FFI, matching
/// `windows/panel_size.rs`, rather than a crate for one call.
#[cfg(target_os = "windows")]
mod windows_consent {
    use super::MicrophonePermission;
    use std::ffi::c_void;

    /// `HKEY_LOCAL_MACHINE` and `HKEY_CURRENT_USER`, sign-extended to pointer
    /// width the way `winreg.h` defines them.
    const HKEY_LOCAL_MACHINE: isize = 0x8000_0002_u32 as i32 as isize;
    const HKEY_CURRENT_USER: isize = 0x8000_0001_u32 as i32 as isize;
    const RRF_RT_REG_SZ: u32 = 0x0000_0002;
    const RRF_RT_REG_DWORD: u32 = 0x0000_0010;
    const STORE: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";

    #[link(name = "advapi32")]
    extern "system" {
        fn RegGetValueW(
            key: isize,
            subkey: *const u16,
            value: *const u16,
            flags: u32,
            kind: *mut u32,
            data: *mut c_void,
            size: *mut u32,
        ) -> i32;
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }

    fn string(root: isize, key: &str) -> Option<String> {
        let (key, value) = (wide(key), wide("Value"));
        let mut buffer = [0u16; 64];
        let mut size = std::mem::size_of_val(&buffer) as u32;
        // SAFETY: NUL-terminated names; `size` describes `buffer` in bytes.
        let status = unsafe {
            RegGetValueW(
                root,
                key.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if status != 0 {
            return None;
        }
        let len = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
        Some(String::from_utf16_lossy(&buffer[..len]))
    }

    fn policy_denies() -> bool {
        let (key, value) = (
            wide(r"SOFTWARE\Policies\Microsoft\Windows\AppPrivacy"),
            wide("LetAppsAccessMicrophone"),
        );
        let mut data = 0u32;
        let mut size = std::mem::size_of::<u32>() as u32;
        // SAFETY: as above, with a DWORD out-parameter.
        let status = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                key.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_DWORD,
                std::ptr::null_mut(),
                (&mut data as *mut u32).cast(),
                &mut size,
            )
        };
        // 2 is "Force Deny"; 0 (user in control) and 1 (Force Allow) are not refusals.
        status == 0 && data == 2
    }

    pub fn microphone() -> MicrophonePermission {
        MicrophonePermission::from_windows_consent(
            policy_denies(),
            string(HKEY_LOCAL_MACHINE, STORE).as_deref(),
            string(HKEY_CURRENT_USER, STORE).as_deref(),
            string(HKEY_CURRENT_USER, &format!(r"{STORE}\NonPackaged")).as_deref(),
        )
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
    fn windows_consent_maps_each_switch_to_who_can_change_it() {
        use MicrophonePermission as P;
        let allow = Some("Allow");
        let deny = Some("Deny");
        // Nothing written anywhere is Windows' default: desktop apps allowed.
        assert_eq!(P::from_windows_consent(false, None, None, None), P::Granted);
        assert_eq!(P::from_windows_consent(false, allow, allow, allow), P::Granted);
        // The user's own switches.
        assert_eq!(P::from_windows_consent(false, allow, deny, allow), P::Denied);
        assert_eq!(P::from_windows_consent(false, allow, allow, deny), P::Denied);
        // The machine-wide switch and policy are an administrator's.
        assert_eq!(P::from_windows_consent(false, deny, allow, allow), P::Restricted);
        assert_eq!(P::from_windows_consent(true, allow, allow, allow), P::Restricted);
        assert_eq!(P::from_windows_consent(true, None, deny, deny), P::Restricted);
        // Spelled the way Windows writes it, or not.
        assert_eq!(P::from_windows_consent(false, None, Some("deny"), None), P::Denied);
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
