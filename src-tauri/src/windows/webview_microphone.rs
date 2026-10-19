//! The microphone, as WebView2 would otherwise ask about it (Windows).
//!
//! ---------------------------------------------------------------------------
//! WHY THE APP ANSWERS FOR ITS OWN PAGES
//! ---------------------------------------------------------------------------
//! WebView2 treats every page as a website. The first `getUserMedia` put up a
//! browser bubble — "http://tauri.localhost wants to use your microphones,
//! Block / Allow" — and remembered the answer in WebView2's own profile. Two
//! things are wrong with that in a desktop application:
//!
//!   - It is not how Windows asks. A desktop application is not asked one by
//!     one: the gate is Settings › Privacy & security › Microphone, "Let
//!     desktop apps access your microphone", which is what
//!     `get_microphone_permission` reports and what the app's recovery opens.
//!     The bubble was a second gate, in a browser's words, naming a host the
//!     user has never heard of.
//!   - Block was a trapdoor. WebView2 has no site-settings page and the app
//!     shows none, so one misclick refused the microphone for good, and the
//!     recovery the app offers — open the OS privacy pane — pointed at a
//!     setting that was not the one refusing.
//!
//! So the app grants its OWN pages the microphone, and nothing else: only the
//! microphone permission, and only for the app's origin (plus the dev server
//! in a debug build). The OS setting stays the one real gate — a refusal there
//! still fails `getUserMedia`, and the app still says where to fix it.
//!
//! Two layers, because one is not enough. A decision WebView2 has already
//! saved in its profile answers later requests itself, without raising
//! `PermissionRequested` — so a Block clicked in an earlier build would have
//! outlived the handler. On every launch the app's origin is therefore set to
//! Allow in the profile (`ICoreWebView2Profile4::SetPermissionState`, which
//! replaces whatever was saved), and the request handler covers what that
//! cannot reach: a runtime too old for the profile API, and the dev server.
//!
//! macOS needs none of this: WKWebView defers to the system's own per-app
//! prompt, which is the macOS convention.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("webview-microphone")
        .on_webview_ready(|webview| {
            #[cfg(windows)]
            grant::install(&webview);
            #[cfg(not(windows))]
            let _ = webview;
        })
        .build()
}

/// Whether a permission request comes from one of the app's own pages: the
/// packaged origin, `http://tauri.localhost`, or — in a debug build only — the
/// Vite dev server `tauri dev` loads instead.
pub fn is_own_origin(uri: &str) -> bool {
    let Some(rest) = uri.strip_prefix("http://") else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    // A port is digits after the last colon; anything else (or user info,
    // which has no business here) leaves the authority unmatched.
    let host = match authority.rsplit_once(':') {
        Some((host, port)) if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => host,
        _ => authority,
    };
    host == "tauri.localhost" || (cfg!(debug_assertions) && matches!(host, "localhost" | "127.0.0.1"))
}

#[cfg(windows)]
mod grant {
    use tauri::{Runtime, Webview};
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2Profile4, ICoreWebView2_13, COREWEBVIEW2_PERMISSION_KIND,
        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };
    use webview2_com::{
        take_pwstr, PermissionRequestedEventHandler, SetPermissionStateCompletedHandler,
    };
    use windows_core::{Interface, PCWSTR, PWSTR};

    /// The packaged origin, as the profile API names an origin.
    const APP_ORIGIN: &str = "http://tauri.localhost";

    /// Replace any microphone decision the profile holds for the app's origin
    /// with Allow. Best-effort: an older runtime without the profile API keeps
    /// only the request handler, which is what every launch had before.
    ///
    /// SAFETY (caller): `core` is this webview's live `ICoreWebView2`, used on
    /// the thread `with_webview` runs its closure on.
    unsafe fn allow_in_profile(core: &ICoreWebView2) -> windows_core::Result<()> {
        let profile = core.cast::<ICoreWebView2_13>()?.Profile()?.cast::<ICoreWebView2Profile4>()?;
        let origin: Vec<u16> = APP_ORIGIN.encode_utf16().chain(Some(0)).collect();
        // SAFETY: `origin` is NUL-terminated and outlives the call, which
        // copies it; the completion handler owns nothing borrowed.
        unsafe {
            profile.SetPermissionState(
                COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
                PCWSTR(origin.as_ptr()),
                COREWEBVIEW2_PERMISSION_STATE_ALLOW,
                &SetPermissionStateCompletedHandler::create(Box::new(|_| Ok(()))),
            )
        }
    }

    pub fn install<R: Runtime>(webview: &Webview<R>) {
        let label = webview.label().to_string();
        let dispatched = webview.with_webview(move |platform| {
            // SAFETY: COM calls on this webview's own controller, made on the
            // thread `with_webview` runs the closure on. The handler outlives
            // the call because WebView2 holds a reference to it.
            let installed = unsafe {
                platform.controller().CoreWebView2().and_then(|core| {
                    if let Err(err) = allow_in_profile(&core) {
                        tracing::debug!(error = %err, "the profile microphone grant is unavailable");
                    }
                    let mut token = 0i64;
                    core.add_PermissionRequested(
                        &PermissionRequestedEventHandler::create(Box::new(|_, args| {
                            let Some(args) = args else { return Ok(()) };
                            let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                            args.PermissionKind(&mut kind)?;
                            if kind != COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
                                return Ok(());
                            }
                            let mut uri = PWSTR::null();
                            args.Uri(&mut uri)?;
                            if super::is_own_origin(&take_pwstr(uri)) {
                                args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                            }
                            Ok(())
                        })),
                        &mut token,
                    )
                })
            };
            if let Err(err) = installed {
                tracing::warn!(webview = %label, error = %err, "the microphone grant could not be installed");
            }
        });
        if let Err(err) = dispatched {
            tracing::warn!(error = %err, "the microphone grant could not be dispatched");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::is_own_origin;

    #[test]
    fn grants_the_app_origin_and_nothing_that_merely_looks_like_it() {
        assert!(is_own_origin("http://tauri.localhost/control.html"));
        assert!(is_own_origin("http://tauri.localhost"));
        assert!(is_own_origin("http://tauri.localhost/preferences.html?x=1#y"));
        for foreign in [
            "https://tauri.localhost/control.html",
            "http://tauri.localhost.example.com/",
            "http://example.com/?http://tauri.localhost",
            "http://evil@tauri.localhost/",
            "http://tauri.localhost:evil/",
            "file:///C:/tauri.localhost/x.html",
            "",
        ] {
            assert!(!is_own_origin(foreign), "{foreign}");
        }
    }

    #[test]
    fn grants_the_dev_server_only_in_a_debug_build() {
        assert_eq!(is_own_origin("http://localhost:1420/control.html"), cfg!(debug_assertions));
        assert_eq!(is_own_origin("http://127.0.0.1:1421/"), cfg!(debug_assertions));
        assert!(!is_own_origin("http://localhost.example.com:1420/"));
    }
}
