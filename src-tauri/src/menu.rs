//! The native application menu (desktop refinement §6).
//!
//! ---------------------------------------------------------------------------
//! WHY THIS FILE EXISTS AT ALL
//! ---------------------------------------------------------------------------
//! CandidCue shipped with no native menu. Everything it could do lived behind an
//! in-webview shortcut or a button on the screen that owned it, which means the
//! application had no PUBLISHED list of its own commands: nothing a user could
//! read to find out that Blank Stage exists, nothing that told them the key, and
//! — on macOS — a menu bar carrying only the OS-supplied defaults, which is the
//! single loudest signal that a window is a web page rather than an application.
//!
//! ---------------------------------------------------------------------------
//! WHAT THIS FILE DELIBERATELY DOES NOT DO
//! ---------------------------------------------------------------------------
//! It does not decide anything. Every item here is a name, a key, and an id;
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
}

/// Push menu state from the frontend onto the live menu.
pub fn apply_state(app: &AppHandle, states: &[MenuItemState]) {
    app.state::<MenuRegistry>().apply(states);
}

/// Accelerators, in Tauri's platform-neutral spelling.
///
/// `CmdOrCtrl` resolves to ⌘ on macOS and Ctrl elsewhere, which is the same rule
/// `resolveShortcut` applies in `control/lib/shortcuts.ts`. They are written out
/// here rather than derived from that file because they cross a language
/// boundary; `commands.ts` carries the same strings and a test compares them.
mod keys {
    pub const NEW_SCRIPT: &str = "CmdOrCtrl+N";
    pub const IMPORT: &str = "CmdOrCtrl+Shift+I";
    pub const SAVE: &str = "CmdOrCtrl+S";
    pub const DUPLICATE: &str = "CmdOrCtrl+D";
    pub const CLOSE: &str = "CmdOrCtrl+W";
    pub const PRESENT: &str = "CmdOrCtrl+Return";
    pub const FIND: &str = "CmdOrCtrl+F";
    pub const FIND_NEXT: &str = "CmdOrCtrl+G";
    pub const FIND_PREVIOUS: &str = "CmdOrCtrl+Shift+G";
    pub const REPLACE: &str = "CmdOrCtrl+Alt+F";
    pub const LIBRARY: &str = "CmdOrCtrl+Shift+L";
    pub const TOGGLE_SIDEBAR: &str = "CmdOrCtrl+Alt+S";
    pub const TOGGLE_OUTLINE: &str = "CmdOrCtrl+Alt+O";
    pub const TOGGLE_DIAGNOSTICS: &str = "CmdOrCtrl+Alt+D";
    pub const EDIT_MODE: &str = "CmdOrCtrl+1";
    pub const PREVIEW_MODE: &str = "CmdOrCtrl+2";
    pub const SPLIT_MODE: &str = "CmdOrCtrl+3";
    pub const ZOOM_IN: &str = "CmdOrCtrl+Plus";
    pub const ZOOM_OUT: &str = "CmdOrCtrl+-";
    pub const ACTUAL_SIZE: &str = "CmdOrCtrl+0";
    pub const END_TAKE: &str = "CmdOrCtrl+.";
    pub const SHORTCUTS: &str = "CmdOrCtrl+/";
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
            if let Err(err) = app.set_menu(menu) {
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
        /*
         * Emitted to CONTROL specifically, not broadcast.
         *
         * A menu command is an instruction to the application's one operable
         * window. The stage holds `core:event:allow-listen` and would receive a
         * broadcast — it has no handler for these, but "nothing listens today"
         * is exactly how an event ends up acted on twice a year from now.
         */
        if let Err(err) = handle.emit_to(CONTROL_LABEL, MENU_COMMAND_EVENT, serde_json::json!({ "id": id })) {
            tracing::warn!(error = %err, id = %id, "a menu command could not be delivered");
        }
    });
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
     * to Help and File respectively, and inventing a "CandidCue" menu there
     * would be macOS mimicry of exactly the kind §22.3 warns against.
     */
    #[cfg(target_os = "macos")]
    {
        let about = AboutMetadata {
            name: Some("CandidCue".into()),
            version: Some(env!("CARGO_PKG_VERSION").into()),
            comments: Some(
                "A voice-following teleprompter. Speech is transcribed on this machine and never leaves it."
                    .into(),
            ),
            ..Default::default()
        };
        let app_menu = Submenu::with_items(
            app,
            "CandidCue",
            true,
            &[
                &PredefinedMenuItem::about(app, Some("About CandidCue"), Some(about))?,
                &sep()?,
                // ⌘, — the platform key for preferences, and the reason a user
                // reaches for the menu bar at all before they know the app.
                &item("view.settings", "Settings…", Some("CmdOrCtrl+,"))?,
                &sep()?,
                &PredefinedMenuItem::services(app, None)?,
                &sep()?,
                &PredefinedMenuItem::hide(app, Some("Hide CandidCue"))?,
                &PredefinedMenuItem::hide_others(app, None)?,
                &PredefinedMenuItem::show_all(app, None)?,
                &sep()?,
                &PredefinedMenuItem::quit(app, Some("Quit CandidCue"))?,
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
            &sep()?,
            &item("file.close-script", "Close Script", Some(keys::CLOSE))?,
            &item("file.move-to-trash", "Move to Trash", None)?,
        ],
    )?;
    menu.append(&file)?;

    /*
     * Settings and Quit, for the platforms with no application menu.
     *
     * On macOS both live under "CandidCue" above, which is where every Mac user
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
        file.append(&PredefinedMenuItem::quit(app, Some("Exit"))?)?;
    }

    /*
     * Edit: the six predefined items first, then the app's own Find family.
     *
     * The predefined ones are the whole reason this submenu exists. Without an
     * Edit menu a macOS webview still handles ⌘C by accident of the platform's
     * key handling, but Undo does NOT reliably reach CodeMirror, and a text
     * field has no context-menu Cut/Copy/Paste at all.
     */
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &sep()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
            &sep()?,
            &item("edit.find", "Find…", Some(keys::FIND))?,
            &item("edit.find-next", "Find Next", Some(keys::FIND_NEXT))?,
            &item("edit.find-previous", "Find Previous", Some(keys::FIND_PREVIOUS))?,
            &item("edit.replace", "Find and Replace…", Some(keys::REPLACE))?,
        ],
    )?;
    menu.append(&edit)?;

    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &item("view.library", "Show Library", Some(keys::LIBRARY))?,
            &sep()?,
            &check("view.toggle-sidebar", "Show Sidebar", Some(keys::TOGGLE_SIDEBAR))?,
            &check("view.toggle-outline", "Show Outline", Some(keys::TOGGLE_OUTLINE))?,
            &check("view.toggle-diagnostics", "Show Diagnostics", Some(keys::TOGGLE_DIAGNOSTICS))?,
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
            &item("session.take-marker", "Add Take Marker", None)?,
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
    let main_window = item("window.main", "CandidCue", None)?;
    window_items.push(&minimize);
    window_items.push(&maximize);
    #[cfg(target_os = "macos")]
    let bring_all = PredefinedMenuItem::bring_all_to_front(app, None)?;
    #[cfg(target_os = "macos")]
    window_items.push(&bring_all);
    window_items.push(&separator);
    window_items.push(&main_window);
    let window = Submenu::with_items(app, "Window", true, &window_items)?;
    menu.append(&window)?;

    let help = Submenu::with_items(
        app,
        "Help",
        true,
        &[
            &item("help.keyboard-shortcuts", "Keyboard Shortcuts", Some(keys::SHORTCUTS))?,
            &item("help.setup-assistant", "Setup Assistant", None)?,
            &sep()?,
            &item("help.privacy", "Privacy and Local Processing", None)?,
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
            Some("About CandidCue"),
            Some(AboutMetadata {
                name: Some("CandidCue".into()),
                version: Some(env!("CARGO_PKG_VERSION").into()),
                comments: Some(
                    "A voice-following teleprompter. Speech is transcribed on this machine and never leaves it."
                        .into(),
                ),
                ..Default::default()
            }),
        )?)?;
    }
    menu.append(&help)?;

    Ok(menu)
}

/// Finder on macOS, File Explorer everywhere else (§25.3).
///
/// A compile-time choice rather than a runtime one: the binary only ever runs on
/// the platform it was built for, and a `cfg` cannot drift the way a
/// `navigator.platform` check scattered through components can.
const fn reveal_label() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "Reveal in Finder"
    }
    #[cfg(not(target_os = "macos"))]
    {
        "Show in File Explorer"
    }
}

#[cfg(test)]
mod tests {
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

    #[test]
    fn menu_command_event_name_matches_typescript() {
        let ts = include_str!("../../src/shared/contracts/commands.ts");
        assert!(
            ts.contains(&format!("'{}'", super::MENU_COMMAND_EVENT)),
            "MENU_COMMAND_EVENT is spelled differently in TypeScript"
        );
    }
}
