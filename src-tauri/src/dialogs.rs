//! Native file dialogs, driven from Rust (spec §50.7).
//!
//! Why this module exists. `import_script`, `export_script` and `import_image`
//! used to take an absolute path as a command argument, with a comment
//! promising the path "came from the native open dialog". Nothing enforced
//! that: the argument is JavaScript-supplied, so any code running in the
//! control webview — injected through a script, a compromised dependency, or a
//! rendered document — could name any path it liked. Import would read any
//! readable Markdown or text file and hand it back through `get_script`; export
//! would `File::create` an arbitrary destination and TRUNCATE it, so pointing
//! it at `~/.ssh/config` destroyed that file.
//!
//! The app ACL now confines those commands to the control window, which shrinks
//! the attacker set but does not close the hole — the control window is exactly
//! where injected script would run.
//!
//! So the picker and the I/O happen together, here, in one trusted Rust
//! operation. The webview asks to import; it does not get to say from where.
//! There is no path parameter left to forge, which is a stronger property than
//! any token scheme: a token still has to be minted, stored, matched and
//! expired, and every one of those is a place to get it wrong.

use std::path::PathBuf;

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_dialog::{DialogExt, FilePath};

use crate::errors::AppError;
use crate::windows::CONTROL_LABEL;

fn builder<R: Runtime>(app: &AppHandle<R>) -> tauri_plugin_dialog::FileDialogBuilder<R> {
    let dialog = app.dialog().file();
    match app.get_webview_window(CONTROL_LABEL) {
        // Sheet the dialog to the control window: a detached picker on macOS can
        // end up behind the always-on-top stage.
        Some(window) => dialog.set_parent(&window),
        None => dialog,
    }
}

async fn resolve(
    rx: tokio::sync::oneshot::Receiver<Option<FilePath>>,
) -> Result<Option<PathBuf>, AppError> {
    let picked = rx
        .await
        .map_err(|_| AppError::Internal("the file dialog closed unexpectedly".into()))?;
    let Some(picked) = picked else {
        return Ok(None); // user cancelled
    };
    let path = picked.into_path().map_err(|e| {
        AppError::unsafe_path("That location cannot be used.").with_log(format!("file path: {e}"))
    })?;
    if !path.is_absolute() {
        return Err(AppError::unsafe_path("That location cannot be used."));
    }
    Ok(Some(path))
}

/// Ask the operator for a script file to import. `Ok(None)` means cancelled.
pub async fn pick_script_to_import<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Option<PathBuf>, AppError> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    builder(app)
        .set_title("Import a script")
        .add_filter("Scripts", &["md", "markdown", "txt", "candidcue"])
        .pick_file(move |picked| {
            let _ = tx.send(picked);
        });
    resolve(rx).await
}

/// Ask the operator for an image to import into a script.
pub async fn pick_image_to_import<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Option<PathBuf>, AppError> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    builder(app)
        .set_title("Add an image")
        .add_filter("Images", &["png", "jpg", "jpeg", "gif", "webp"])
        .pick_file(move |picked| {
            let _ = tx.send(picked);
        });
    resolve(rx).await
}

/// Ask the operator for a FOLDER to write into. `Ok(None)` means cancelled.
///
/// C5: `export_all_data` took a `destination: String` the webview was supposed
/// to supply, but the dialog plugin is deliberately not granted to JavaScript,
/// so there was no way to obtain one — the command was uninvokable and the
/// "Export all scripts" button did nothing at all. The picker belongs on this
/// side for the same reason every other one does (spec §50.7).
pub async fn pick_destination_folder<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
) -> Result<Option<PathBuf>, AppError> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    builder(app)
        .set_title(title)
        .pick_folder(move |picked| {
            let _ = tx.send(picked);
        });
    resolve(rx).await
}

/// Ask the operator where to write an export. `Ok(None)` means cancelled.
pub async fn pick_export_destination<R: Runtime>(
    app: &AppHandle<R>,
    suggested_name: &str,
    filter_label: &str,
    extension: &str,
) -> Result<Option<PathBuf>, AppError> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    builder(app)
        .set_title("Export script")
        .set_file_name(suggested_name)
        .add_filter(filter_label, &[extension])
        .save_file(move |picked| {
            let _ = tx.send(picked);
        });
    resolve(rx).await
}
