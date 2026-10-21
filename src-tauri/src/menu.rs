//! The native application menu (desktop refinement §6).
//!
//! ---------------------------------------------------------------------------
//! WHY THIS FILE EXISTS AT ALL
//! ---------------------------------------------------------------------------
//! Speaking Glass shipped with no native menu. Everything it could do lived behind an
//! in-webview shortcut or a button on the screen that owned it, which means the
//! application had no PUBLISHED list of its own commands: nothing a user could
//! read to find out that Blank Stage exists, nothing that told them the key, and
//! — on macOS — a menu bar carrying only the OS-supplied defaults, which is the
//! single loudest signal that a window is a web page rather than an application.
//!
//! ---------------------------------------------------------------------------
//! WHAT THIS FILE DELIBERATELY DOES NOT DO
//! ---------------------------------------------------------------------------
//! It decides only which window a command reaches, and whether the Stage item is enabled — everything else it is told. Every item here is a name, a key, and an id;
//! choosing whether the item can fire, and what it does, belongs to the frontend
//! (`src/control/lib/commands.ts`) because that is where the route, the session,
//! the editor's save state and the navigation guards already live. Rust asking
//! those questions would mean a second implementation of "is a take running",
//! and the two would disagree exactly once — in front of a presenter.
//!
//! So the flow is:
//!
//!   1. this file builds the menu and emits [`MENU_COMMAND_EVENT`] on a click;
//!   2. the frontend runs the command through the SAME guards a button uses;
//!   3. the frontend pushes enabled/checked/label state back with
//!      `set_menu_state`, and [`apply_state`] writes it onto the live handles.
//!
//! The predefined items (undo, redo, cut, copy, paste, select all, minimise,
//! zoom, fullscreen, quit, about, hide, services) are NOT routed through that
//! loop. They are dispatched by the platform to whatever native control has
//! focus, which is the only way ⌘Z can reach CodeMirror when the caret is in the
//! editor and the script-title field when it is in the title.
//!
//! `Quit` is predefined for the same reason it always was safe to be: it raises
//! `RunEvent::ExitRequested`, which `app.rs` intercepts and turns into the
//! shutdown handshake. A custom quit item would have had to re-implement that.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Deserialize;
use tauri::menu::{
    AboutMetadata, CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu,
};
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::windows::CONTROL_LABEL;

/// Rust → control: a native menu item was chosen. Mirrored verbatim in
/// `src/shared/contracts/commands.ts`; the test at the bottom of this file keeps
/// the two spellings identical.
pub const MENU_COMMAND_EVENT: &str = "menu://command";

/// File › Exit on Linux, where GTK offers no predefined Quit (see `build`).
/// Answered here rather than by a window: it is the application's exit, not a
/// command any page implements, so it is never forwarded as a menu command.
#[cfg(target_os = "linux")]
const LINUX_EXIT_ID: &str = "app.exit";

/// One menu item's state, as the frontend reports it.
///
/// `checked` and `label` are optional because most items have neither: an item
/// with no checkmark must not grow one, and an item whose label is fixed must
/// not be rewritten to `null`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuItemState {
    pub id: String,
    pub enabled: bool,
    #[serde(default)]
    pub checked: Option<bool>,
    #[serde(default)]
    pub label: Option<String>,
}

/// The live menu handles, kept so state pushes can find them by id.
///
/// Managed state rather than a static: a menu belongs to an application
/// instance, and a static would outlive one under `cargo test`.
#[derive(Default)]
pub struct MenuRegistry {
    items: Mutex<HashMap<String, MenuHandle>>,
}

enum MenuHandle {
    Item(MenuItem<Wry>),
    Check(CheckMenuItem<Wry>),
}

impl MenuRegistry {
    fn insert_item(&self, id: &str, item: MenuItem<Wry>) {
        if let Ok(mut items) = self.items.lock() {
            items.insert(id.to_string(), MenuHandle::Item(item));
        }
    }

    fn insert_check(&self, id: &str, item: CheckMenuItem<Wry>) {
        if let Ok(mut items) = self.items.lock() {
            items.insert(id.to_string(), MenuHandle::Check(item));
        }
    }

    /// Apply a batch of state updates.
    ///
    /// Unknown ids are SKIPPED rather than reported as an error. The frontend
    /// registry is the authority on what commands exist, and a build where it
    /// knows one this menu does not should degrade to "that item is missing
    /// from the menu bar", not to a failed IPC call that leaves every OTHER
    /// item in the batch stale.
    fn apply(&self, states: &[MenuItemState]) {
        let Ok(items) = self.items.lock() else { return };
        for state in states {
            let Some(handle) = items.get(&state.id) else {
                tracing::debug!(id = %state.id, "menu state for an item this build has no handle for");
                continue;
            };
            match handle {
                MenuHandle::Item(item) => {
                    let _ = item.set_enabled(state.enabled);
                    if let Some(label) = &state.label {
                        let _ = item.set_text(label);
                    }
                }
                MenuHandle::Check(item) => {
                    let _ = item.set_enabled(state.enabled);
                    if let Some(checked) = state.checked {
                        let _ = item.set_checked(checked);
                    }
                    if let Some(label) = &state.label {
                        let _ = item.set_text(label);
                    }
                }
            }
        }
    }

    /// Set one item's enabled flag, for the state RUST decides rather than the
    /// webview. See `apply_state`.
    fn set_enabled(&self, id: &str, enabled: bool) {
        let Ok(items) = self.items.lock() else { return };
        match items.get(id) {
            Some(MenuHandle::Item(item)) => {
                let _ = item.set_enabled(enabled);
            }
            Some(MenuHandle::Check(item)) => {
                let _ = item.set_enabled(enabled);
            }
            None => {}
        }
    }
}

/// Push menu state from the frontend onto the live menu.
pub fn apply_state(app: &AppHandle, states: &[MenuItemState]) {
    app.state::<MenuRegistry>().apply(states);
    /*
     * ONE ITEM RUST DECIDES, whatever the webview said.
     *
     * Window › Stage names a window, and whether that window exists is a fact
     * about this process that no renderer can answer: the `stage` webview is
     * created by the appearance preview and by the calibration wizard, both of
     * which now live in the SETTINGS window — so the control window would be
     * guessing, and the Settings window would be reporting on a window it may
     * have closed a moment ago.
     *
     * Applied after the pushed state rather than merged into it, so it wins
     * regardless of which window pushed and what that window believed.
     */
    refresh_stage_item(app);
}

/// Re-read whether the stage window exists, and grey Window › Stage to match.
///
/// Called from `apply_state` — so any menu push carries it — AND from the
/// stage window's own lifecycle in `windows/mod.rs`. Both are needed: a push is
/// driven by a renderer's command context, and neither renderer is told when
/// the stage window is created or destroyed. Without the lifecycle calls the
/// item could stay greyed while a stage was up, or offer to bring forward a
/// window that had closed, until something unrelated happened to push state.
///
/// Generic over the runtime and tolerant of a missing registry, because it is
/// called from `open_stage`, which is generic and also runs under the mock
/// runtime in tests where no menu was ever built.
pub fn refresh_stage_item<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let Some(registry) = app.try_state::<MenuRegistry>() else {
        return;
    };
    let exists = app
        .get_webview_window(crate::windows::STAGE_LABEL)
        .is_some();
    registry.set_enabled("window.stage", exists);
}

/// Accelerators, in Tauri's platform-neutral spelling.
///
/// `CmdOrCtrl` resolves to ⌘ on macOS and Ctrl elsewhere, which is the same rule
/// `resolveShortcut` applies in `control/lib/shortcuts.ts`. They are written out
/// here rather than derived from that file because they cross a language
/// boundary; `commands.ts` carries the same strings and a test compares them.
///
/// The key names are muda's, which is not the browser's vocabulary: `Enter`,
/// never `Return`, and `=` for the zoom key, never `Plus`. Tauri drops a string
/// muda cannot parse without a word and builds the item with no shortcut, so
/// a misspelling here fails nowhere but in
/// `every_menu_accelerator_parses_the_way_tauri_parses_it` (#269).
mod keys {
    pub const NEW_SCRIPT: &str = "CmdOrCtrl+N";
    pub const IMPORT: &str = "CmdOrCtrl+Shift+I";
    pub const SAVE: &str = "CmdOrCtrl+S";
    pub const DUPLICATE: &str = "CmdOrCtrl+D";
    pub const CLOSE: &str = "CmdOrCtrl+W";
    pub const PRESENT: &str = "CmdOrCtrl+Enter";
    /// Rehearse rather than take. Shift over Present, because it is the same
    /// gesture with the same precondition and a different consequence.
    pub const PRACTISE: &str = "CmdOrCtrl+Shift+Enter";
    pub const FIND: &str = "CmdOrCtrl+F";
    pub const FIND_NEXT: &str = "CmdOrCtrl+G";
    pub const FIND_PREVIOUS: &str = "CmdOrCtrl+Shift+G";
    pub const REPLACE: &str = "CmdOrCtrl+Alt+F";
    pub const LIBRARY: &str = "CmdOrCtrl+Shift+L";
    pub const TOGGLE_SIDEBAR: &str = "CmdOrCtrl+Alt+S";
    pub const TOGGLE_OUTLINE: &str = "CmdOrCtrl+Alt+O";
    pub const EDIT_MODE: &str = "CmdOrCtrl+1";
    pub const PREVIEW_MODE: &str = "CmdOrCtrl+2";
    pub const SPLIT_MODE: &str = "CmdOrCtrl+3";
    pub const ZOOM_IN: &str = "CmdOrCtrl+=";
    pub const ZOOM_OUT: &str = "CmdOrCtrl+-";
    pub const ACTUAL_SIZE: &str = "CmdOrCtrl+0";
    pub const END_TAKE: &str = "CmdOrCtrl+.";
    pub const SHORTCUTS: &str = "CmdOrCtrl+/";
    // The Insert family. Bold and Italic are the keys CodeMirror's own keymap
    // already answers (`MarkdownEditor.svelte`); naming them here is what makes
    // them discoverable rather than what makes them work.
    pub const BOLD: &str = "CmdOrCtrl+B";
    pub const ITALIC: &str = "CmdOrCtrl+I";
    pub const LINK: &str = "CmdOrCtrl+K";
}

/// Where the menu lives.
///
/// macOS: the application, which is the only place a macOS menu can live.
///
/// Windows and Linux: the CONTROL window, and only that window. A menu bar
/// there is part of a window's frame, and `AppHandle::set_menu` gives the
/// app-wide menu to every window that exists — and, through
/// `WebviewWindowBuilder`, to every window created afterwards. The stage, the
/// "which display is this?" cards and Settings each grew a full
/// File/Edit/Insert/View bar: across the top of the prompter glass, inside a
/// 2.5-second identify card, and over a preferences window that answers three
/// of its commands. Attaching to control alone leaves every later window
/// without one. The command routing below is unchanged — events from a window
/// menu arrive at the same `on_menu_event`, and the items are the same handles
/// [`apply_state`] writes to.
fn attach(app: &AppHandle, menu: Menu<Wry>) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    {
        app.set_menu(menu).map(|_| ())
    }
    #[cfg(not(target_os = "macos"))]
    {
        match app.get_webview_window(CONTROL_LABEL) {
            Some(control) => control.set_menu(menu).map(|_| ()),
            None => {
                tracing::error!("there is no control window to carry the menu");
                Ok(())
            }
        }
    }
}

/// Build and install the application menu.
///
/// Called from `setup`, after the control window exists. A failure is logged and
/// swallowed: an application with no menu bar is a worse application, but it is
/// still an application, and refusing to launch over a menu would trade a
/// cosmetic failure for a total one — the same trade `app.rs` already refuses to
/// make for the log file.
pub fn install(app: &AppHandle) {
    app.manage(MenuRegistry::default());
    match build(app) {
        Ok(menu) => {
            if let Err(err) = attach(app, menu) {
                tracing::error!(error = %err, "the application menu could not be installed");
            }
        }
        Err(err) => {
            tracing::error!(error = %err, "the application menu could not be built");
        }
    }

    let handle = app.clone();
    app.on_menu_event(move |_app, event| {
        let id = event.id().0.as_str();
        // The same request a predefined Quit makes: `ExitRequested`, which
        // `app.rs` holds open for the frontend's flush before it lets go.
        #[cfg(target_os = "linux")]
        if id == LINUX_EXIT_ID {
            handle.exit(0);
            return;
        }
        /*
         * TO THE FOCUSED WINDOW, not to control.
         *
         * ---------------------------------------------------------------------
         * WHY THIS WAS WRONG THE MOMENT PREFERENCES EXISTED
         * ---------------------------------------------------------------------
         * A macOS menu bar belongs to the APPLICATION and acts on whichever
         * window is in front. This used to emit unconditionally to `control`,
         * which was harmless while control was the only operable window and
         * became a real defect with Settings in a window of its own:
         *
         *   - ⌘W with Preferences in front closed the CONTROL window, taking
         *     the open script off the screen;
         *   - Find opened the search panel in an editor nobody was looking at;
         *   - Insert wrote Markdown into a hidden document.
         *
         * Each of those is a menu doing something to a window the user was not
         * pointed at, which is worse than a menu that does nothing.
         *
         * With the STAGE in front, only WINDOW-LEVEL commands are forwarded to
         * control; everything else is dropped.
         *
         * The stage has no command handler of its own, so something has to
         * happen. Forwarding everything was wrong for the same reason targeting
         * control unconditionally was: ⌘W over the stage would close the
         * document window, and Insert would write into an editor two windows
         * away. Dropping everything is wrong too — Window › Speaking Glass pressed
         * over the stage is exactly the gesture "get me back to the other
         * window", and it has to work from there most of all.
         *
         * So the split is by what the command ACTS ON. A window command names a
         * window and is safe from anywhere; a document, edit or session command
         * acts on whatever is in front, and there is no document in front.
         */
        let Some(target) = command_target(&handle, id) else {
            tracing::debug!(id = %id, "a menu command was pressed over a window that cannot answer it");
            return;
        };
        if let Err(err) =
            handle.emit_to(target.as_str(), MENU_COMMAND_EVENT, serde_json::json!({ "id": id }))
        {
            tracing::warn!(error = %err, id = %id, target = %target, "a menu command could not be delivered");
        }
    });
}

/// Which window a menu command should be delivered to, if any.
///
/// The focused one when it answers commands — `control` and `preferences`.
/// Over any other window (the stage, an identify overlay) only window-level
/// commands are forwarded, to control; the rest are dropped. See the note at
/// the emit site for why that split rather than all-or-nothing.
fn command_target(app: &AppHandle, id: &str) -> Option<String> {
    /*
     * A command whose answer lives in the control window goes there from
     * anywhere — Settings included — rather than to whichever window is in
     * front. Control brings itself forward to show the answer.
     */
    if is_control_routed(id) {
        return Some(CONTROL_LABEL.to_string());
    }
    let focused = app
        .webview_windows()
        .values()
        .find(|window| window.is_focused().unwrap_or(false))
        .map(|window| window.label().to_string());

    match focused.as_deref() {
        Some(CONTROL_LABEL) => Some(CONTROL_LABEL.to_string()),
        Some(label) if label == crate::windows::preferences::PREFERENCES_LABEL => {
            Some(label.to_string())
        }
        /*
         * NOTHING FOCUSED is treated exactly like the stage being focused.
         *
         * `None` is not "the application is in the background and control is
         * still in charge". It is also every window minimised, a focus change
         * in flight, and `is_focused()` having returned an error that this code
         * flattened to `false`. In every one of those there is no window the
         * user is looking at — which is the same situation the arm below is
         * about, and forwarding Save or Insert into a document nobody can see
         * is the same mistake either way.
         */
        _ => is_context_free(id).then(|| CONTROL_LABEL.to_string()),
    }
}

/// Commands that act on the APPLICATION rather than on what is in front.
///
/// Safe to answer when no window is looking at a document, which is what makes
/// them the exception above.
///
/// An explicit list, not a `window.`/`help.` prefix test. The prefix looked
/// self-maintaining and was wrong: `help.setup-assistant` NAVIGATES the control
/// window, `help.keyboard-shortcuts` opens a dialog in it, `help.privacy` opens
/// Settings, and `help.export-support-bundle` starts a file-picker flow. Those
/// act on a window as much as Save does. Only these five name a window or a
/// directory and nothing else.
///
/// A new command is therefore excluded by default, which is the safe direction:
/// it is dropped when pressed over the stage rather than delivered somewhere it
/// was not meant for.
const CONTEXT_FREE_COMMANDS: &[&str] = &[
    "window.main",
    "window.settings",
    "window.stage",
    "help.reveal-logs",
    "help.privacy",
];

fn is_context_free(id: &str) -> bool {
    CONTEXT_FREE_COMMANDS.contains(&id)
}

/// Commands the CONTROL window answers, whichever window they are chosen over.
///
/// Help › Check for Updates… is the one. Its answer — "up to date", or the
/// update notice with Install and Restart — is drawn in the document window,
/// because that is where the install flow and its never-during-a-take rule
/// live (`src/control/stores/updates.ts`). Delivered to Settings it would
/// have nowhere to go: Settings has no notice to show and no way to ask control
/// for one. Routing it here is what makes it work from Settings as well, and
/// control brings itself forward to show the answer.
///
/// Safe from anywhere for the same reason the context-free list is: it acts on
/// no document. During a take control's own registry refuses it (`available`
/// is false while presenting), so routing it here cannot put anything on the
/// glass.
const CONTROL_ROUTED_COMMANDS: &[&str] = &["help.check-for-updates"];

fn is_control_routed(id: &str) -> bool {
    CONTROL_ROUTED_COMMANDS.contains(&id)
}

fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let registry = app.state::<MenuRegistry>();

    /* One helper per item kind so the menu below reads as a list of names. */
    let item = |id: &str, label: &str, accelerator: Option<&str>| -> tauri::Result<MenuItem<Wry>> {
        // Built DISABLED. The frontend pushes real state as soon as it mounts,
        // and the window between the menu appearing and that first push is a
        // window in which the app cannot answer anything: the stores have not
        // loaded, and a command that ran there would act on an empty library.
        let built = MenuItem::with_id(app, id, label, false, accelerator)?;
        registry.insert_item(id, built.clone());
        Ok(built)
    };
    let check = |id: &str, label: &str, accelerator: Option<&str>| -> tauri::Result<CheckMenuItem<Wry>> {
        let built = CheckMenuItem::with_id(app, id, label, false, false, accelerator)?;
        registry.insert_check(id, built.clone());
        Ok(built)
    };
    let sep = || PredefinedMenuItem::separator(app);

    let menu = Menu::new(app)?;

    /*
     * The application menu, macOS only.
     *
     * On Windows and Linux there is no application menu: About and Quit belong
     * to Help and File respectively, and inventing a "Speaking Glass" menu there
     * would be macOS mimicry of exactly the kind §22.3 warns against.
     */
    #[cfg(target_os = "macos")]
    {
        let about = AboutMetadata {
            name: Some("Speaking Glass".into()),
            version: Some(env!("CARGO_PKG_VERSION").into()),
            comments: Some(
                "A voice-following teleprompter. Speech is transcribed on this machine and never leaves it."
                    .into(),
            ),
            copyright: app.config().bundle.copyright.clone(),
            license: Some(env!("CARGO_PKG_LICENSE").into()),
            ..Default::default()
        };
        let app_menu = Submenu::with_items(
            app,
            "Speaking Glass",
            true,
            &[
                &PredefinedMenuItem::about(app, Some("About Speaking Glass"), Some(about))?,
                &sep()?,
                // ⌘, — the platform key for preferences, and the reason a user
                // reaches for the menu bar at all before they know the app.
                &item("view.settings", "Settings…", Some("CmdOrCtrl+,"))?,
                &sep()?,
                &PredefinedMenuItem::services(app, None)?,
                &sep()?,
                &PredefinedMenuItem::hide(app, Some("Hide Speaking Glass"))?,
                &PredefinedMenuItem::hide_others(app, None)?,
                &PredefinedMenuItem::show_all(app, None)?,
                &sep()?,
                &PredefinedMenuItem::quit(app, Some("Quit Speaking Glass"))?,
            ],
        )?;
        menu.append(&app_menu)?;
    }

    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &item("file.new-script", "New Script", Some(keys::NEW_SCRIPT))?,
            &item("file.import-markdown", "Import Markdown…", Some(keys::IMPORT))?,
            &sep()?,
            &item("file.save", "Save", Some(keys::SAVE))?,
            &item("file.duplicate-script", "Duplicate Script", Some(keys::DUPLICATE))?,
            &item("file.rename-script", "Rename Script", None)?,
            &sep()?,
            &item("file.export-markdown", "Export Markdown…", None)?,
            &item("file.reveal-script", reveal_label(), None)?,
            &sep()?,
            &item("file.present", "Present", Some(keys::PRESENT))?,
            &Submenu::with_items(
                app,
                "Present As",
                true,
                &[
                    &item("file.present-prompter", "Prompter", None)?,
                    &item("file.present-reader", "Reader Window", None)?,
                ],
            )?,
            &item("file.practise", "Practise", Some(keys::PRACTISE))?,
            &sep()?,
            &item("file.close-script", "Close Script", Some(keys::CLOSE))?,
            // On its own below a rule, as in the window's own menus: flush under
            // Close Script, a one-row overshoot from ⌘W's item reached Trash.
            &sep()?,
            &item("file.move-to-trash", "Move to Trash", None)?,
        ],
    )?;
    menu.append(&file)?;

    /*
     * Settings and Quit, for the platforms with no application menu.
     *
     * On macOS both live under "Speaking Glass" above, which is where every Mac user
     * looks for them. Windows and Linux have no such menu — the convention there
     * is Settings at the bottom of File (or Edit) and Exit below it — so
     * building them only inside the `cfg(target_os = "macos")` block left
     * Windows advertising `Ctrl+,` in its own Shortcuts dialog with no menu item
     * behind it.
     *
     * Appended to File after the fact rather than declared inside the list
     * above, because the list is shared and only these two entries differ.
     */
    #[cfg(not(target_os = "macos"))]
    {
        file.append(&sep()?)?;
        file.append(&item("view.settings", "Settings…", Some("CmdOrCtrl+,"))?)?;
        file.append(&sep()?)?;
        #[cfg(not(target_os = "linux"))]
        file.append(&PredefinedMenuItem::quit(app, Some("Exit"))?)?;
        /*
         * GTK has no predefined Quit: muda builds nothing for one there, and
         * File ended in a rule with no Exit under it — while the recovery
         * screen's copy tells a Linux user to choose File › Exit. So Linux gets
         * a plain item that asks for the same exit a predefined Quit does
         * (`on_menu_event` below), through the flush handshake in `app.rs`.
         */
        #[cfg(target_os = "linux")]
        file.append(&MenuItem::with_id(app, LINUX_EXIT_ID, "Exit", true, None::<&str>)?)?;
    }

    /*
     * Edit: the six predefined items first, then the app's own Find family.
     *
     * The predefined ones are the whole reason this submenu exists. Without an
     * Edit menu a macOS webview still handles ⌘C by accident of the platform's
     * key handling, but Undo does NOT reliably reach CodeMirror, and a text
     * field has no context-menu Cut/Copy/Paste at all.
     */
    let edit = Submenu::new(app, "Edit", true)?;
    /*
     * GTK has no predefined Undo or Redo — muda builds nothing for either — so
     * on Linux the menu opened on a bare rule. The web view answers Ctrl+Z and
     * Ctrl+Shift+Z itself there.
     */
    if cfg!(not(target_os = "linux")) {
        edit.append_items(&[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &sep()?,
        ])?;
    }
    edit.append_items(&[
        &PredefinedMenuItem::cut(app, None)?,
        &PredefinedMenuItem::copy(app, None)?,
        &PredefinedMenuItem::paste(app, None)?,
        &PredefinedMenuItem::select_all(app, None)?,
        &sep()?,
        &item("edit.find", "Find…", Some(keys::FIND))?,
        &item("edit.find-next", "Find Next", Some(keys::FIND_NEXT))?,
        &item("edit.find-previous", "Find Previous", Some(keys::FIND_PREVIOUS))?,
        &item("edit.replace", "Find and Replace…", Some(keys::REPLACE))?,
    ])?;
    menu.append(&edit)?;

    /*
     * Insert — §11.4's "clearly discoverable Insert menu in the native menu bar".
     *
     * These are the editor's formatting-row controls, given names and keys. The
     * row is a set of glyphs and icons whose meanings have to be hovered for;
     * this is where somebody finds out that a Cue and a Part Break exist at
     * all, and it is the only surface that can say so without being on the
     * screen already.
     */
    let insert = Submenu::with_items(
        app,
        "Insert",
        true,
        &[
            &item("insert.heading", "Heading", None)?,
            &sep()?,
            &item("insert.bold", "Bold", Some(keys::BOLD))?,
            &item("insert.italic", "Italic", Some(keys::ITALIC))?,
            &item("insert.link", "Link", Some(keys::LINK))?,
            &sep()?,
            &item("insert.image", "Image…", None)?,
            &item("insert.diagram", "Diagram", None)?,
            &sep()?,
            // The teleprompter's own two. They are last and ruled off because
            // they are the ones that mean something to a TAKE rather than to a
            // document — §11.4's grouping.
            &item("insert.cue", "Cue", None)?,
            &item("insert.take-marker", "Part Break", None)?,
        ],
    )?;
    menu.append(&insert)?;

    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &item("view.library", "Show Library", Some(keys::LIBRARY))?,
            &sep()?,
            &check("view.toggle-sidebar", "Show Sidebar", Some(keys::TOGGLE_SIDEBAR))?,
            &check("view.toggle-outline", "Show Outline", Some(keys::TOGGLE_OUTLINE))?,
            &sep()?,
            &check("view.edit-mode", "Edit", Some(keys::EDIT_MODE))?,
            &check("view.preview-mode", "Preview", Some(keys::PREVIEW_MODE))?,
            &check("view.split-mode", "Edit and Preview", Some(keys::SPLIT_MODE))?,
            &sep()?,
            /*
             * Named for the document, not the window.
             *
             * "Zoom In" next to a teleprompter's stage-font control is genuinely
             * ambiguous — the one thing a prompter user means by "bigger text"
             * is the glass, and this is not that. The stage's own size lives on
             * the transport and in Stage Appearance.
             */
            &item("view.zoom-in", "Larger Editor Text", Some(keys::ZOOM_IN))?,
            &item("view.zoom-out", "Smaller Editor Text", Some(keys::ZOOM_OUT))?,
            &item("view.actual-size", "Actual Size", Some(keys::ACTUAL_SIZE))?,
            &sep()?,
            &item("view.stage-appearance", "Stage Appearance…", None)?,
            /*
             * NO "Enter Full Screen" ITEM, and its absence is deliberate.
             *
             * §6.2 lists one, and adding `PredefinedMenuItem::fullscreen` is a
             * one-line change. It is also the one menu entry in this file that
             * would actively break the product.
             *
             * On macOS that predefined item calls AppKit's `toggleFullScreen:`
             * directly. That is the native fullscreen transition this
             * application deliberately does not use: presentation is BORDERLESS
             * (`windows/present.rs`), and `core:window:allow-set-fullscreen` is
             * withheld from the control capability precisely so the renderer
             * cannot reach that path — because it is what "put a white bar over
             * the opening of every take".
             *
             * A predefined item is also outside `MenuRegistry`, so it cannot be
             * disabled during a take and does not go through `runCommand`'s
             * availability re-check. It would be an unguarded route into the
             * one window transition the presentation state machine owns.
             *
             * ⌃⌘F still works: `resolveShortcut` answers it with
             * `toggle-presentation-mode`, which moves a take between the reader
             * window and the full display through the state machine.
             */
        ],
    )?;
    menu.append(&view)?;

    /*
     * Session — the menu that says what this application is.
     *
     * File/Edit/View/Window/Help is every application. A teleprompter's actual
     * subject is the take, and putting it in the menu bar is the difference
     * between "a document app that can also present" and an instrument.
     */
    let session = Submenu::with_items(
        app,
        "Session",
        true,
        &[
            &item("session.start-take", "Start Take", None)?,
            &item("session.play-pause", "Pause", None)?,
            &sep()?,
            &item("session.previous-sentence", "Previous Sentence", Some("Alt+Left"))?,
            &item("session.next-sentence", "Next Sentence", Some("Alt+Right"))?,
            &item("session.previous-chapter", "Previous Section", Some("Alt+Up"))?,
            &item("session.next-chapter", "Next Section", Some("Alt+Down"))?,
            &sep()?,
            &item("session.blank-stage", "Blank Stage", None)?,
            &check("session.toggle-mirror", "Mirror Stage", None)?,
            &sep()?,
            &item("session.identify-displays", "Identify Displays", None)?,
            &sep()?,
            &item("session.end-take", "End Take", Some(keys::END_TAKE))?,
        ],
    )?;
    menu.append(&session)?;

    let mut window_items: Vec<&dyn tauri::menu::IsMenuItem<Wry>> = Vec::new();
    let minimize = PredefinedMenuItem::minimize(app, None)?;
    let maximize = PredefinedMenuItem::maximize(app, None)?;
    let separator = sep()?;
    let main_window = item("window.main", "Speaking Glass", None)?;
    // §20.4: the Settings window is listed, and choosing it brings the existing
    // one forward rather than making a second.
    let settings_window = item("window.settings", "Speaking Glass Settings", None)?;
    /*
     * §13.4: the Stage window is listed WHILE IT EXISTS.
     *
     * Which is not most of the time — production presentation is single-window,
     * so the control window is the prompter and there is no second window to
     * name. A real `stage` webview is still created by the appearance preview
     * and by the calibration wizard, and while one of those is up it was a
     * window of this application that the Window menu did not mention.
     *
     * Enabled from the live window list in `apply_state`, not from the state a
     * webview pushed: no renderer knows whether this window exists.
     */
    let stage_window = item("window.stage", "Stage", None)?;
    /*
     * GTK has no predefined Minimize or Maximize — muda builds nothing for
     * either — so on Linux the menu would open on a bare rule. The window
     * manager's own controls do both there.
     */
    let window_controls = cfg!(not(target_os = "linux"));
    if window_controls {
        window_items.push(&minimize);
        window_items.push(&maximize);
    }
    #[cfg(target_os = "macos")]
    let bring_all = PredefinedMenuItem::bring_all_to_front(app, None)?;
    #[cfg(target_os = "macos")]
    window_items.push(&bring_all);
    if window_controls {
        window_items.push(&separator);
    }
    window_items.push(&main_window);
    window_items.push(&settings_window);
    window_items.push(&stage_window);
    let window = Submenu::with_items(app, "Window", true, &window_items)?;
    menu.append(&window)?;

    let help = Submenu::with_items(
        app,
        "Help",
        true,
        &[
            &item("help.keyboard-shortcuts", "Keyboard Shortcuts", Some(keys::SHORTCUTS))?,
            &item("help.syntax-reference", "Script Syntax Reference", None)?,
            &item("help.setup-assistant", "Setup Assistant", None)?,
            &item("help.guide", "Project README", None)?,
            &sep()?,
            // Off the machine and onto the web. Grouped away from the local
            // actions above because leaving the app is a different kind of
            // thing to do, and a user reaching for "Reveal Logs" should not
            // land in a browser.
            &item("help.website", "Speaking Glass on GitHub", None)?,
            &item("help.release-notes", "Release Notes", None)?,
            &item("help.download", "Download Latest Version", None)?,
            &item("help.check-for-updates", "Check for Updates…", None)?,
            &item("help.report-problem", "Report a Problem", None)?,
            &sep()?,
            &item("help.privacy", "Privacy and Local Processing", None)?,
            &item("help.notices", "Third-Party Notices", None)?,
            &sep()?,
            &item("help.export-support-bundle", "Export Support Bundle…", None)?,
            &item("help.reveal-logs", "Reveal Logs", None)?,
        ],
    )?;
    // About belongs to the application menu on macOS and to Help everywhere
    // else — the same split as Settings and Quit above.
    #[cfg(not(target_os = "macos"))]
    {
        help.append(&sep()?)?;
        help.append(&PredefinedMenuItem::about(
            app,
            Some("About Speaking Glass"),
            Some(AboutMetadata {
                name: Some("Speaking Glass".into()),
                version: Some(env!("CARGO_PKG_VERSION").into()),
                comments: Some(
                    "A voice-following teleprompter. Speech is transcribed on this machine and never leaves it."
                        .into(),
                ),
                copyright: app.config().bundle.copyright.clone(),
                license: Some(env!("CARGO_PKG_LICENSE").into()),
                ..Default::default()
            }),
        )?)?;
    }
    menu.append(&help)?;

    Ok(menu)
}

/// Finder on macOS, File Explorer on Windows, and on Linux the generic name,
/// since each desktop's file manager is called something else (§25.3).
///
/// A compile-time choice rather than a runtime one: the binary only ever runs on
/// the platform it was built for, and a `cfg` cannot drift the way a
/// `navigator.platform` check scattered through components can.
const fn reveal_label() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "Reveal in Finder"
    }
    #[cfg(target_os = "linux")]
    {
        "Show in File Manager"
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        "Show in File Explorer"
    }
}

#[cfg(test)]
mod tests {
    /// Every accelerator `build` hands to Tauri, as `(command id, spelling)`.
    ///
    /// Read from this file's source, as the id tests below are, but from the
    /// production half only — the tests' own string literals are not menu items
    /// — and from anywhere on the line, so a call wrapped in `file.append(…)` is
    /// seen too. A call the scan cannot read (one split across lines, say) and a
    /// `keys::` name it cannot resolve are failures rather than skips: a binding
    /// the scan drops is one no test checks.
    fn menu_accelerators() -> Vec<(String, String)> {
        let rs = include_str!("menu.rs");
        let production = &rs[..rs.find("#[cfg(test)]").expect("menu.rs has a test module")];

        let mut found = Vec::new();
        for line in production.lines() {
            for call in ["item(", "check("] {
                let Some(at) = line.find(call) else { continue };
                // `insert_item(`, `refresh_stage_item(`: another function's name.
                if line[..at].ends_with(|c: char| c.is_alphanumeric() || c == '_') {
                    continue;
                }
                let Some(rest) = line[at + call.len()..].strip_prefix('"') else {
                    panic!("a `{call}…)` call the scan cannot read: `{}`", line.trim());
                };
                let Some(quote) = rest.find('"') else { continue };
                let id = rest[..quote].to_string();
                // `Some(keys::NAME)` or `Some("Literal")`, else `None`.
                if let Some(start) = rest.find("Some(keys::") {
                    let name = rest[start + "Some(keys::".len()..]
                        .split(')')
                        .next()
                        .unwrap_or("")
                        .trim();
                    found.push((id, key_constant(name)));
                } else if let Some(start) = rest.find("Some(\"") {
                    let value = rest[start + "Some(\"".len()..].split('"').next().unwrap_or("");
                    found.push((id, value.to_string()));
                }
                break;
            }
        }
        found
    }

    /// The value of `keys::NAME`, read from the `keys` module.
    fn key_constant(name: &str) -> String {
        let rs = include_str!("menu.rs");
        let needle = format!("pub const {name}: &str = \"");
        let at = rs
            .find(&needle)
            .unwrap_or_else(|| panic!("`keys::{name}` is not a constant the scan can read"));
        rs[at + needle.len()..].split('"').next().unwrap_or("").to_string()
    }

    /// Every accelerator this file hands to Tauri must survive Tauri's parse.
    ///
    /// Tauri builds a menu item with `accelerator.and_then(|s| s.parse().ok())`
    /// into muda's `Accelerator`, so a spelling muda does not know is an error
    /// nowhere: the item is built with no key, nothing is logged, and the menu
    /// simply shows none. Present, Practise and Larger Editor Text shipped that
    /// way — `Return` and `Plus` are not muda key names — while the Shortcuts
    /// dialog advertised all three and the registry test below passed (#269).
    /// This parses every string exactly as Tauri does, so the failure that
    /// cannot happen at runtime happens here.
    #[test]
    fn every_menu_accelerator_parses_the_way_tauri_parses_it() {
        let rs = include_str!("menu.rs");

        // Every constant in `keys`, whether or not a menu item is found using
        // it, and then every accelerator the items are actually built with.
        let mut accelerators: Vec<(String, String)> = Vec::new();
        let start = rs.find("mod keys {").expect("the `keys` module");
        let end = start + rs[start..].find("\n}").expect("the end of the `keys` module");
        for line in rs[start..end].lines() {
            let Some(rest) = line.trim_start().strip_prefix("pub const ") else {
                continue;
            };
            let name = rest.split(':').next().unwrap_or("");
            accelerators.push((format!("keys::{name}"), key_constant(name)));
        }
        let constants = accelerators.len();
        assert!(constants > 20, "found only {constants} `keys` constants; the parser is broken");
        let bound = menu_accelerators();
        assert!(
            bound.len() > 25,
            "found only {} menu accelerators; the parser is broken",
            bound.len()
        );
        accelerators.extend(bound);

        let dropped: Vec<String> = accelerators
            .iter()
            .filter_map(|(owner, spec)| {
                spec.parse::<muda::accelerator::Accelerator>()
                    .err()
                    .map(|error| format!("{owner}: `{spec}` ({error})"))
            })
            .collect();
        assert!(
            dropped.is_empty(),
            "Tauri would build these menu items with NO shortcut, and say nothing:\n  {}",
            dropped.join("\n  ")
        );
    }

    /// Every id this menu builds must exist in the TypeScript command contract.
    ///
    /// The same `include_str!` discipline the stage event names use
    /// (`windows/mod.rs`): the two sides are separate languages with no shared
    /// build step, so the only thing that can hold them together is a test that
    /// reads the other side's source. Without it, renaming a command in
    /// TypeScript leaves a menu item that emits an event nothing answers — and
    /// the symptom is a menu entry that silently does nothing, which is the
    /// hardest kind of bug to notice in a menu nobody clicks every item of.
    #[test]
    fn menu_ids_match_typescript_contract() {
        let ts = include_str!("../../src/shared/contracts/commands.ts");
        let rs = include_str!("menu.rs");

        // Ids as this file spells them: the first argument of every `item(` /
        // `check(` call. Parsed from the source rather than listed again here,
        // because a hand-maintained list is one more thing that can go stale.
        let mut ids: Vec<&str> = Vec::new();
        for line in rs.lines() {
            let trimmed = line.trim_start();
            for prefix in ["&item(\"", "&check(\"", "item(\"", "check(\""] {
                if let Some(rest) = trimmed.strip_prefix(prefix) {
                    if let Some(end) = rest.find('"') {
                        ids.push(&rest[..end]);
                    }
                    break;
                }
            }
        }
        assert!(ids.len() > 20, "the id scan found {} ids; the parser is wrong", ids.len());

        for id in ids {
            assert!(
                ts.contains(&format!("'{id}'")),
                "menu item `{id}` is not declared in src/shared/contracts/commands.ts"
            );
        }
    }

    /// …and the other direction: every declared command must reach the menu.
    ///
    /// This is the half that actually enforces the design rule. A command that
    /// exists in TypeScript but has no menu item is a command the application
    /// can perform and never tells anybody about — which is precisely the state
    /// this whole refinement was written to end. Adding a command is therefore
    /// not complete until it has a place in the menu bar.
    #[test]
    fn every_declared_command_appears_in_the_menu() {
        let ts = include_str!("../../src/shared/contracts/commands.ts");
        let rs = include_str!("menu.rs");

        // Ids as the TS contract declares them: the quoted entries inside
        // `COMMAND_IDS`, which is the block between the `= [` and the `] as
        // const`. Scoped to that block so a mention in prose is not mistaken
        // for a declaration.
        let start = ts.find("export const COMMAND_IDS = [").expect("COMMAND_IDS is declared");
        let end = ts[start..].find("] as const").expect("COMMAND_IDS is closed") + start;
        let block = &ts[start..end];

        let mut declared = Vec::new();
        for line in block.lines() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix('\'') {
                if let Some(quote) = rest.find('\'') {
                    declared.push(&rest[..quote]);
                }
            }
        }
        assert!(
            declared.len() > 20,
            "the contract scan found {} ids; the parser is wrong",
            declared.len()
        );

        for id in declared {
            assert!(
                rs.contains(&format!("(\"{id}\"")),
                "command `{id}` is declared in commands.ts but has no native menu item"
            );
        }
    }

    /// Every accelerator this menu binds must be the one TypeScript advertises.
    ///
    /// The two sides spell the same chord differently — Tauri wants
    /// `CmdOrCtrl+N`, `lib/commands.ts` wants `Mod+N` — so the check normalises
    /// both to a canonical form and compares the sets.
    ///
    /// This test was CLAIMED by a comment in `keys` before it existed, which is
    /// the failure mode worth guarding hardest against: an accelerator that the
    /// menu binds and the Shortcuts dialog does not name is a key nobody can
    /// discover, and one the dialog names and the menu does not bind is a
    /// promise the app breaks.
    #[test]
    fn menu_accelerators_match_the_typescript_registry() {
        let ts = include_str!("../../src/control/lib/commands.ts");

        /// `CmdOrCtrl+Shift+G` / `Mod+Shift+G` → `mod+shift+g`.
        ///
        /// Only the modifier is translated; the key is compared as spelled. This
        /// used to fold `Plus` into `=` and `Return` into `Enter` too, which
        /// proved that two spellings named one chord and so passed three that
        /// the menu library cannot parse (#269).
        fn canonical(spec: &str) -> String {
            let mut parts: Vec<String> = spec
                .split('+')
                .map(|part| match part.to_ascii_lowercase().as_str() {
                    "cmdorctrl" | "mod" => "mod".to_string(),
                    other => other.to_string(),
                })
                .collect();
            // The key is last; the modifiers are a SET, so their order must not
            // decide equality.
            let key = parts.pop().unwrap_or_default();
            parts.sort();
            parts.push(key);
            parts.join("+")
        }

        // Rust: every accelerator the menu items are built with.
        let rust_accelerators: Vec<(String, String)> = menu_accelerators()
            .into_iter()
            .map(|(id, spec)| (id, canonical(&spec)))
            .collect();

        /// A registry accelerator in the menu library's spelling. One key name
        /// differs, deliberately and on the TypeScript side only: `commands.ts`
        /// calls it `Return`, the word `formatAccelerator` turns into ⏎, and
        /// muda knows it only as `Enter`. Translating it here rather than in
        /// `canonical` is what keeps a Rust `Return` failing.
        fn menu_spelling(declared: &str) -> String {
            match declared.rsplit_once('+') {
                Some((modifiers, "Return")) => format!("{modifiers}+Enter"),
                _ => declared.to_string(),
            }
        }

        assert!(
            rust_accelerators.len() > 10,
            "found only {} accelerators; the parser is broken",
            rust_accelerators.len()
        );

        let mut bound: std::collections::HashSet<String> = std::collections::HashSet::new();
        for (id, accelerator) in rust_accelerators {
            // Find this command's block in the TypeScript registry and read its
            // `accelerator:` line, if it has one.
            let needle = format!("'{id}': {{");
            let Some(at) = ts.find(&needle) else {
                panic!("`{id}` has a menu accelerator but no registry entry");
            };
            let block_end = ts[at..].find("\n  },").map(|n| at + n).unwrap_or(ts.len());
            let block = &ts[at..block_end];
            let Some(line) = block.lines().find(|l| l.trim_start().starts_with("accelerator:"))
            else {
                panic!(
                    "menu item `{id}` binds `{accelerator}` but the registry declares no \
                     accelerator — the Shortcuts dialog cannot name a key the menu owns"
                );
            };
            let declared = line
                .split('\'')
                .nth(1)
                .unwrap_or_else(|| panic!("could not read the accelerator for `{id}`"));
            assert_eq!(
                canonical(&menu_spelling(declared)),
                accelerator,
                "`{id}`: the menu binds `{accelerator}` and the registry advertises \
                 `{declared}`"
            );
            bound.insert(id);
        }

        /*
         * AND THE OTHER DIRECTION.
         *
         * The loop above only proves that every chord Rust binds is the chord
         * TypeScript advertises. On its own that is half a guarantee, and the
         * missing half is the one that bites: a command given an accelerator in
         * `commands.ts` and never added to `build()` is printed in the Shortcuts
         * dialog, described in the registry, and answered by nothing — a key the
         * app promises and does not have. Nothing above could see it, because
         * there was no Rust row to start from.
         */
        let mut advertised = 0usize;
        for line in ts.lines() {
            let trimmed = line.trim_start();
            let Some(rest) = trimmed.strip_prefix("id: '") else {
                continue;
            };
            let Some(quote) = rest.find('\'') else { continue };
            let id = &rest[..quote];
            let Some(at) = ts.find(&format!("'{id}': {{")) else {
                continue;
            };
            let block_end = ts[at..].find("\n  },").map(|n| at + n).unwrap_or(ts.len());
            if !ts[at..block_end]
                .lines()
                .any(|l| l.trim_start().starts_with("accelerator:"))
            {
                continue;
            }
            advertised += 1;
            assert!(
                bound.contains(id),
                "`{id}` advertises an accelerator in `commands.ts` but no menu item binds it \
                 — the Shortcuts dialog would print a key nothing answers"
            );
        }
        // Anti-vacuity: a parser that matched nothing would satisfy the loop.
        assert!(
            advertised > 25,
            "only {advertised} registry accelerators were read; the parser is broken"
        );
    }

    /// Every id in the context-free allow-list is a real command.
    ///
    /// The list decides what survives being pressed over a window that answers
    /// nothing, so an id misspelt here fails open in the quiet direction: the
    /// command is simply dropped, and nothing says so.
    #[test]
    fn context_free_commands_are_real_commands() {
        let ts = include_str!("../../src/shared/contracts/commands.ts");
        for id in super::CONTEXT_FREE_COMMANDS {
            assert!(
                ts.contains(&format!("'{id}'")),
                "`{id}` is treated as context-free but is not a declared command"
            );
        }
        // Anti-vacuity, and a nudge to think when the list grows: these are the
        // commands that act on no document, and there are not many of them.
        assert_eq!(super::CONTEXT_FREE_COMMANDS.len(), 5);
    }

    /// Every control-routed id is a real command, and Settings lists it as one
    /// it answers — otherwise its menu push would grey the item out over the
    /// very window this routing exists to serve.
    #[test]
    fn control_routed_commands_are_real_and_enabled_over_settings() {
        let ts = include_str!("../../src/shared/contracts/commands.ts");
        let shell = include_str!("../../src/control/services/desktop-shell.ts");
        let preferences = shell
            .split("export const PREFERENCES_COMMANDS = [")
            .nth(1)
            .and_then(|rest| rest.split("] as const").next())
            .expect("PREFERENCES_COMMANDS is declared in desktop-shell.ts");
        for id in super::CONTROL_ROUTED_COMMANDS {
            assert!(
                ts.contains(&format!("'{id}'")),
                "`{id}` is routed to control but is not a declared command"
            );
            assert!(
                preferences.contains(&format!("'{id}'")),
                "`{id}` is routed to control from Settings, but Settings greys it out"
            );
            assert!(
                !super::CONTEXT_FREE_COMMANDS.contains(id),
                "`{id}` is in both lists; control routing already covers every window"
            );
        }
        assert_eq!(super::CONTROL_ROUTED_COMMANDS, &["help.check-for-updates"]);
    }

    #[test]
    fn menu_command_event_name_matches_typescript() {
        let ts = include_str!("../../src/shared/contracts/commands.ts");
        assert!(
            ts.contains(&format!("'{}'", super::MENU_COMMAND_EVENT)),
            "MENU_COMMAND_EVENT is spelled differently in TypeScript"
        );
    }
}
