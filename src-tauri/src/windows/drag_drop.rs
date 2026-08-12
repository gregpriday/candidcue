//! Dropping Markdown onto the window (desktop refinement §10.5, §20.2).
//!
//! ---------------------------------------------------------------------------
//! WHY THIS IS IN RUST, WHEN THE OBVIOUS IMPLEMENTATION IS FOUR LINES OF JS
//! ---------------------------------------------------------------------------
//! Tauri delivers dropped files to the webview as absolute paths. The tempting
//! implementation is a JavaScript listener that reads them and calls an import
//! command with the path.
//!
//! That would reopen, exactly, the hole this codebase already closed. §50.7 and
//! the note on `import_script` say it plainly: the file picker runs in RUST, and
//! no path is ever chosen by — or passed through — JavaScript, because a command
//! that reads an arbitrary absolute path supplied by the renderer is a command
//! that reads `~/.ssh/config` the day something can inject into the renderer.
//! `export_script` was changed for precisely this reason after the old version
//! truncated whatever file it was handed.
//!
//! A drag-and-drop path is no different in kind from a picked one. The only
//! reason it feels safer is that a human dragged it — which is exactly what is
//! true of the picker too, and was not enough there.
//!
//! So the drop is handled where the paths already are. Tauri raises
//! `WindowEvent::DragDrop` in Rust; this module filters, imports, and tells the
//! frontend what happened. The renderer learns that scripts appeared. It never
//! learns where they came from *from this module*, and it cannot ask for one.
//!
//! ---------------------------------------------------------------------------
//! WHAT THIS MODULE CANNOT FIX, AND WHICH IS NOT NEW
//! ---------------------------------------------------------------------------
//! Tauri itself hands the renderer the dropped paths, before any of this runs,
//! and widens the asset scope to them. In tauri 2.11.5, `Manager::attach_window`
//! installs an unconditional window-event handler (`manager/window.rs`,
//! `on_window_event`) which on `DragDropEvent::Drop`:
//!
//!   * calls `Scopes::allow_file(path)` / `allow_directory(path, true)`, and
//!   * emits `tauri://drag-drop` carrying the absolute `paths` to the webview.
//!
//! `DragDropEvent::Enter` emits the paths too. Neither is gated on the app
//! having registered a handler, and neither checks whether anything is
//! listening (unlike `CloseRequested`, which does check).
//!
//! THIS IS TRUE WITH OR WITHOUT THIS MODULE. `dragDropEnabled` defaults to true
//! and `tauri.conf.json` does not set it, so a build with no drop handling at
//! all — every build of this app so far — already emits those paths the moment
//! anybody drags a file over the window. Adding a Rust-side consumer does not
//! widen the surface; it only means something useful now happens as well.
//!
//! What limits the damage today is the `deny` floor in `tauri.conf.json`, which
//! beats a runtime `allow_file`, so script bodies, revisions, the database and
//! the logs stay unreachable however many files get dropped. What is genuinely
//! exposed is the dropped file itself, and the absolute path of it — which
//! names the user's home directory.
//!
//! Turning `dragDropEnabled` off is NOT the fix: it disables the
//! `WindowEvent::DragDrop` this module needs *and* hands drops back to the
//! webview's own default, which on WKWebView means navigating to the file URL —
//! the exact behaviour §20.2 asks to prevent. Closing this properly needs an
//! upstream option to suppress the renderer emission, and is worth raising
//! there rather than worked around here.
//!
//! ---------------------------------------------------------------------------
//! WHAT IS ACCEPTED, AND WHAT HAPPENS TO THE REST
//! ---------------------------------------------------------------------------
//! Markdown and plain text, by extension. §10.5: reject unsupported files with a
//! concise notice rather than silently ignoring them — a drop that does nothing
//! and says nothing is indistinguishable from a drop the app failed to notice.
//! Directories are skipped without comment, because dragging a folder onto a
//! document app is an ordinary mistake and not worth a scolding.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{DragDropEvent, Emitter, Manager, WindowEvent};

use crate::database::Database;
use crate::scripts::{DataPaths, ScriptLocks};
use crate::windows::CONTROL_LABEL;

/// Rust → control: files are hovering over the window, or have stopped.
///
/// The frontend uses this and nothing else to draw its drop target. Deriving the
/// hover state from HTML5 `dragover` in the webview instead would work, but it
/// would be a SECOND source of truth for a state Rust already owns — and the two
/// disagree in the case that matters, a drag that leaves the window without a
/// drop, where the DOM's `dragleave` is famously unreliable.
pub const DRAG_HOVER: &str = "app://drag-hover";

/// Rust → control: a drop finished. The frontend reloads the library and reports.
pub const DRAG_IMPORTED: &str = "app://drag-imported";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HoverPayload {
    /// True while a drag with at least one importable file is over the window.
    active: bool,
    /// How many of the hovering files this app would accept. Zero means the
    /// frontend should say "not this kind of file" rather than invite a drop.
    accepted: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedPayload {
    /// The id of the last script imported, so the frontend can open it.
    ///
    /// Only ONE, and deliberately: dropping six files should not open six
    /// editors. The last one wins because that is the one whose name is under
    /// the cursor at the end of the gesture on every platform.
    script_id: Option<String>,
    imported: usize,
    /// Files that were the right kind but could not be read or parsed.
    failed: Vec<String>,
    /// Files this app does not import at all.
    rejected: Vec<String>,
    /// Warnings the importer raised (unsupported syntax, dropped images).
    warnings: Vec<String>,
}

/// Extensions the importer will accept.
///
/// Deliberately short. `.md` and `.markdown` are the format; `.txt` is accepted
/// because a plain-text script imports cleanly as Markdown with no headings, and
/// refusing it would mean telling somebody to rename a file to satisfy a rule
/// with no consequence behind it.
const IMPORTABLE: [&str; 3] = ["md", "markdown", "txt"];

fn is_importable(path: &Path) -> bool {
    // `is_file` as well as the extension: a directory called `notes.md` exists
    // and would otherwise be handed to the importer as a file.
    if !path.is_file() {
        return false;
    }
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| IMPORTABLE.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// A file's name, for a message. Never its path.
///
/// The frontend is told what could not be imported so it can say so, and a bare
/// file name is enough for that. Sending the full path would put an absolute
/// filesystem path — including the user's home directory — into the renderer,
/// which is the thing this whole module exists to avoid.
fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "that file".to_string())
}

/// Install the drop handler on the control window.
pub fn install(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window(CONTROL_LABEL) else {
        tracing::warn!("no control window to install the drop handler on");
        return;
    };
    let handle = app.clone();
    window.on_window_event(move |event| {
        let WindowEvent::DragDrop(drag) = event else {
            return;
        };
        match drag {
            /*
             * `Enter` only, never `Over`.
             *
             * `Over` fires per pointer frame and carries no paths, so answering
             * it would mean either re-emitting the same hover state a hundred
             * times a second or stat-ing every dropped file on each frame. The
             * set of files cannot change between Enter and Drop, so one look at
             * Enter is all the information there is.
             */
            /*
             * NOTHING DURING A TAKE.
             *
             * `lib/commands.ts` greys File › Import out while presenting, and a
             * drop has to obey the same rule or it is a second, unguarded way to
             * do the thing the menu says cannot be done. The consequences are
             * concrete: importing reloads the Library and then asks the shell to
             * navigate, which raises the "End the session?" confirmation over
             * the glass a presenter is reading from.
             *
             * Checked at the top so the hover overlay is not offered either —
             * inviting a drop that will be refused is worse than not inviting
             * one.
             */
            _ if crate::windows::present::is_presenting() => {}
            DragDropEvent::Enter { paths, .. } => {
                let accepted = paths.iter().filter(|path| is_importable(path)).count();
                let _ = handle.emit_to(
                    CONTROL_LABEL,
                    DRAG_HOVER,
                    HoverPayload { active: true, accepted },
                );
            }
            DragDropEvent::Leave => {
                let _ = handle.emit_to(
                    CONTROL_LABEL,
                    DRAG_HOVER,
                    HoverPayload { active: false, accepted: 0 },
                );
            }
            DragDropEvent::Drop { paths, .. } => {
                let _ = handle.emit_to(
                    CONTROL_LABEL,
                    DRAG_HOVER,
                    HoverPayload { active: false, accepted: 0 },
                );
                let handle = handle.clone();
                let paths = paths.clone();
                /*
                 * Off the event loop. Importing reads and parses files and
                 * writes to SQLite; doing that inside a window-event callback
                 * blocks the loop that paints the window, so a folder of thirty
                 * scripts would freeze the app for the length of the import.
                 */
                tauri::async_runtime::spawn(async move {
                    import_dropped(handle, paths).await;
                });
            }
            _ => {}
        }
    });
}

async fn import_dropped(app: tauri::AppHandle, paths: Vec<PathBuf>) {
    /*
     * Recovery mode imports nothing.
     *
     * The database is not writable, and the frontend is showing the recovery
     * screen rather than a library — so an import would fail in a place with
     * nothing to report it. Every other write command guards the same way
     * through `BootStatus::require_ready`.
     */
    let ready = app
        .try_state::<crate::database::BootStatus>()
        .map(|status| status.is_ready())
        .unwrap_or(false);
    if !ready {
        return;
    }

    let (Some(db), Some(data_paths), Some(locks)) = (
        app.try_state::<Database>(),
        app.try_state::<DataPaths>(),
        app.try_state::<ScriptLocks>(),
    ) else {
        return;
    };

    let mut payload = ImportedPayload {
        script_id: None,
        imported: 0,
        failed: Vec::new(),
        rejected: Vec::new(),
        warnings: Vec::new(),
    };

    for path in &paths {
        // Directories are skipped in silence — dragging a folder onto a document
        // app is an ordinary mistake, not something to be told off for.
        if path.is_dir() {
            continue;
        }
        if !is_importable(path) {
            payload.rejected.push(display_name(path));
            continue;
        }
        let options = crate::scripts::import_export::ImportOptions {
            path: path.to_string_lossy().to_string(),
            title: None,
        };
        match crate::scripts::import_export::import_script(
            db.pool(),
            &data_paths,
            &locks,
            options,
        )
        .await
        {
            Ok(result) => {
                payload.imported += 1;
                payload.script_id = Some(result.script.id.clone());
                payload.warnings.extend(result.warnings);
            }
            Err(err) => {
                tracing::warn!(error = %err, "a dropped file could not be imported");
                payload.failed.push(display_name(path));
            }
        }
    }

    // Nothing at all happened — every path was a directory. Saying so would be
    // noise about a gesture the user has probably already forgotten.
    if payload.imported == 0 && payload.failed.is_empty() && payload.rejected.is_empty() {
        return;
    }

    let _ = app.emit_to(CONTROL_LABEL, DRAG_IMPORTED, payload);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn accepts_markdown_and_text_by_extension() {
        let dir = tempfile::tempdir().expect("temp dir");
        for name in ["a.md", "b.MARKDOWN", "c.txt"] {
            let path = dir.path().join(name);
            fs::write(&path, "# hi").expect("write");
            assert!(is_importable(&path), "{name} should be importable");
        }
    }

    #[test]
    fn rejects_other_extensions() {
        let dir = tempfile::tempdir().expect("temp dir");
        for name in ["a.pdf", "b.docx", "c", "d.md.zip"] {
            let path = dir.path().join(name);
            fs::write(&path, "x").expect("write");
            assert!(!is_importable(&path), "{name} should be rejected");
        }
    }

    #[test]
    fn rejects_a_directory_that_looks_like_markdown() {
        // `notes.md/` is a legal directory name and the extension check alone
        // would hand it to the importer as a file.
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("notes.md");
        fs::create_dir(&path).expect("mkdir");
        assert!(!is_importable(&path));
    }

    #[test]
    fn reports_names_and_never_paths() {
        // The renderer must not learn an absolute path — including the home
        // directory it necessarily contains.
        let path = PathBuf::from("/Users/someone/Documents/secret-project/script.md");
        assert_eq!(display_name(&path), "script.md");
    }
}
