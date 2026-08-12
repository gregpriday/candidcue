//! The Preferences window (desktop refinement §14.1).
//!
//! ---------------------------------------------------------------------------
//! WHY SETTINGS STOPPED BEING A PAGE
//! ---------------------------------------------------------------------------
//! Settings was a route in the control window with a "Back to Library" control
//! at the top. That has three costs, and §14.1 names all of them: changing a
//! preference means LEAVING the script you are working on; coming back is a
//! navigation rather than a dismissal; and the whole surface reads as another
//! page in a sequence, which is the single pattern this refinement exists to
//! remove.
//!
//! It is a window now: ⌘, opens it from wherever you are, closing it puts you
//! back exactly where you were because you never went anywhere, and the native
//! Window menu can list it.
//!
//! ---------------------------------------------------------------------------
//! SINGLE INSTANCE, AND THAT IS THE WHOLE OF THE LIFECYCLE
//! ---------------------------------------------------------------------------
//! §14.1: prevent multiple Settings windows, and bring the existing one to the
//! front when it is invoked again. Both are this file. A second Preferences
//! window would be two views of one document with no coordination between them,
//! which is the failure the settings broadcast in `settings_cmds.rs` exists to
//! prevent between the control window and this one — and it should not have to
//! defend against copies of the same window as well.
//!
//! ---------------------------------------------------------------------------
//! IT IS NOT CLOSED WHEN THE CONTROL WINDOW PRESENTS
//! ---------------------------------------------------------------------------
//! A take turns the control window into the stage. This window is left alone:
//! it is an ordinary window on another part of the desktop, and closing it out
//! from under somebody because a take started would be surprising. What DOES
//! change is that unsafe settings refuse to apply mid-take — that rule lives in
//! the frontend, next to the controls it governs.

use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

use crate::errors::AppError;

/// The window's label. Also the key `capabilities/preferences.json` matches on.
pub const PREFERENCES_LABEL: &str = "preferences";

/// Open the Preferences window, or bring it forward if it is already up.
///
/// Sized for a settings surface rather than for a document: wide enough for the
/// section list plus a form column at its natural width, and tall enough for the
/// longest section without scrolling on a laptop. Resizable, because the speech
/// section's model list and the following section's advanced controls are both
/// longer than the rest.
pub fn open<R: Runtime>(app: &AppHandle<R>) -> Result<(), AppError> {
    if let Some(existing) = app.get_webview_window(PREFERENCES_LABEL) {
        /*
         * Unminimise BEFORE focusing.
         *
         * A minimised window accepts focus without coming back on screen, which
         * looks exactly like the application ignoring ⌘, — the same trap the
         * single-instance handler in `app.rs` documents for the control window.
         */
        let _ = existing.unminimize();
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    let mut builder = WebviewWindowBuilder::new(
        app,
        PREFERENCES_LABEL,
        WebviewUrl::App("preferences.html".into()),
    )
    .title("CandidCue Settings")
    .inner_size(880.0, 660.0)
    .min_inner_size(720.0, 480.0)
    .resizable(true)
    .visible(true);

    /*
     * Centred on first open, and only on first open.
     *
     * Tauri remembers nothing between launches, so without this the window
     * appears at the platform's default offset — which on macOS cascades from
     * the last window opened and can land it half off the screen. It is not
     * given the control window's frame-restore treatment: a preferences window
     * is opened, used and dismissed, and remembering its position is a smaller
     * win than remembering the document window's.
     */
    builder = builder.center();

    builder
        .build()
        .map_err(|err| AppError::Internal(format!("the Settings window could not open: {err}")))?;
    Ok(())
}

/// Close it, if it is open. Used by Help › nothing today — reserved for the
/// shutdown path, which must not leave a window behind when the app exits.
pub fn close<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(PREFERENCES_LABEL) {
        let _ = window.close();
    }
}

/// Is it open? Read by the native Window menu so its entry can be enabled.
pub fn is_open<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.get_webview_window(PREFERENCES_LABEL).is_some()
}
