//! C2 regression: the stage webview must not be able to invoke ANY custom
//! application command (spec §43.2, §50.2 — the stage is the minimally
//! privileged window).
//!
//! Why this test exists. In Tauri 2.11.5 `Webview::on_message`
//! (tauri/src/webview/mod.rs) gates an invoke like this:
//!
//! ```ignore
//! if (plugin_command.is_some() || has_app_acl_manifest || !is_local)
//!     && request.cmd != FETCH_CHANNEL_DATA_COMMAND
//!     && invoke.acl.is_none()
//! { reject("Command not allowed by ACL") }
//! ```
//!
//! An application command has no `plugin:` prefix, and both windows are
//! local, so the whole gate collapses to `has_app_acl_manifest`. That flag is
//! `acl.contains_key("__app-acl__")` (tauri-utils `acl::has_app_manifest`),
//! and tauri-build only inserts that key when the app actually declares
//! permissions (tauri-build `acl.rs`: `has_app_manifest = default_permission
//! .is_some() || !permission_sets.is_empty() || !permissions.is_empty()`).
//!
//! With no `src-tauri/permissions/` directory the key was absent, the gate was
//! skipped, and EVERY command in `generate_handler!` was callable from the
//! stage — `save_openai_key`, `permanently_delete_script`, `export_all_data`,
//! the lot. `permissions/app-commands.toml` turns the gate on; these tests
//! prove it is on and that only `control` is through it.

use std::collections::BTreeMap;

use tauri::ipc::{Origin, RuntimeAuthority};
use tauri::utils::acl::capability::Capability;
use tauri::utils::acl::manifest::Manifest;
use tauri::utils::acl::resolved::Resolved;
use tauri::utils::acl::APP_ACL_KEY;
use tauri::utils::platform::Target;

const CONTROL_WINDOW: &str = "control";
const STAGE_WINDOW: &str = "stage";
const PREFERENCES_WINDOW: &str = "preferences";

fn generated(name: &str) -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("gen")
        .join("schemas")
        .join(name);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{} must exist (run a build first): {e}", path.display()))
}

fn acl_manifests() -> BTreeMap<String, Manifest> {
    serde_json::from_str(&generated("acl-manifests.json")).expect("acl manifests parse")
}

fn capabilities() -> BTreeMap<String, Capability> {
    serde_json::from_str(&generated("capabilities.json")).expect("capabilities parse")
}

fn authority() -> RuntimeAuthority {
    let manifests = acl_manifests();
    let resolved = Resolved::resolve(&manifests, capabilities(), Target::current())
        .expect("capabilities must resolve");
    assert!(
        resolved.has_app_acl,
        "the app ACL manifest is empty, so Tauri skips the ACL gate for every \
         application command on any local webview — the stage would be able to \
         invoke all of them (C2)"
    );
    RuntimeAuthority::new(manifests, resolved)
}

/// The command list is the single source of truth for what the IPC surface is.
fn registered_commands() -> Vec<String> {
    let app_rs = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("app.rs"),
    )
    .expect("app.rs");
    let start = app_rs.find("generate_handler![").expect("generate_handler");
    let end = app_rs[start..].find("])").expect("end of handler list") + start;
    app_rs[start..end]
        .lines()
        .filter_map(|line| line.trim().strip_prefix("commands::"))
        .map(|line| line.trim_end_matches(',').to_string())
        .collect()
}

fn permitted_commands() -> Vec<String> {
    let toml = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("permissions")
            .join("app-commands.toml"),
    )
    .expect("permissions/app-commands.toml");
    toml.lines()
        .map(str::trim)
        .filter(|l| l.starts_with('"'))
        .map(|l| l.trim_end_matches(',').trim_matches('"').to_string())
        .collect()
}

/// The exact runtime predicate: `Some(..)` means the invoke is allowed.
fn allowed_for(authority: &RuntimeAuthority, command: &str, window: &str) -> bool {
    authority
        .resolve_access(command, window, window, &Origin::Local)
        .is_some()
}

#[test]
fn app_acl_manifest_is_present_so_the_gate_is_active() {
    let manifests = acl_manifests();
    assert!(
        manifests.contains_key(APP_ACL_KEY),
        "gen/schemas/acl-manifests.json has no {APP_ACL_KEY} entry, so \
         RuntimeAuthority::has_app_manifest() is false and application \
         commands bypass the ACL entirely (C2)"
    );
}

#[test]
fn stage_window_cannot_invoke_any_application_command() {
    let authority = authority();
    let commands = registered_commands();
    assert!(!commands.is_empty(), "no commands parsed out of app.rs");

    for command in &commands {
        assert!(
            !allowed_for(&authority, command, STAGE_WINDOW),
            "the stage window must not be able to invoke `{command}`; the stage \
             is minimally privileged and communicates only over events \
             (spec §43.2, §50.2)"
        );
    }
}

/// The most damaging commands, called out by name so a future capability edit
/// that re-opens them fails with an obvious message.
#[test]
fn stage_window_cannot_reach_secrets_deletion_or_export() {
    let authority = authority();
    for command in [
        "save_openai_key",
        "delete_openai_key",
        "get_openai_key_status",
        "create_realtime_transcription_credential",
        "permanently_delete_script",
        "trash_script",
        "save_script",
        "get_script",
        "import_script",
        "export_script",
        "export_all_data",
        "export_support_bundle",
        "update_settings",
    ] {
        assert!(
            !allowed_for(&authority, command, STAGE_WINDOW),
            "stage must not reach `{command}`"
        );
    }
}

/// NEITHER window may drive OS full-screen from JavaScript.
///
/// Presentation is borderless and lives in Rust (`windows::present`). The
/// renderer calling `core:window:set_fullscreen` itself is the defect that
/// change exists to remove: on macOS it animates the window into a new Space,
/// and for the length of that animation the webview's painted surface is the
/// old, smaller one — so every take opened with the script at the bottom of the
/// glass under a white bar.
///
/// `capabilities/control.json` states that withholding the permission is what
/// stops that path coming back. This is that claim as a test: without it the
/// only enforcement is a runtime ACL denial on a real machine, which is the one
/// place this project cannot run anything automatically.
#[test]
fn no_window_can_drive_os_fullscreen_from_javascript() {
    let authority = authority();
    for window in [CONTROL_WINDOW, STAGE_WINDOW] {
        assert!(
            !allowed_for(&authority, "plugin:window|set_fullscreen", window),
            "`{window}` can invoke plugin:window|set_fullscreen; presentation is \
             borderless (src/windows/present.rs) and the renderer must not be \
             able to ask the OS for full-screen directly"
        );
    }
}

/// NO window may close a window from JavaScript.
///
/// File › Close Window used to call `getCurrentWindow().close()`, which this
/// ACL refuses — and a `try` read the refusal as "browser dev", so ⌘W off the
/// editor was a silent no-op (#266). The fix is the `close_control_window`
/// command, NOT a grant: `core:window:allow-close` would also let the renderer
/// close the stage in the middle of a take.
///
/// The positive half is what makes the negative half mean anything. A command
/// key spelled in a shape the authority does not recognise is denied too, so
/// without an allowed read from the same plugin this would pass vacuously.
#[test]
fn no_window_can_close_a_window_from_javascript() {
    let authority = authority();
    assert!(
        allowed_for(&authority, "plugin:window|is_focused", CONTROL_WINDOW),
        "control cannot even read is_focused, so the denial below proves nothing \
         about the key format"
    );
    for window in [CONTROL_WINDOW, PREFERENCES_WINDOW, STAGE_WINDOW] {
        assert!(
            !allowed_for(&authority, "plugin:window|close", window),
            "`{window}` can invoke plugin:window|close; closing goes through \
             Rust (close_control_window, close_preferences) so it always raises \
             CloseRequested and never reaches the stage"
        );
    }
}

#[test]
fn control_window_can_invoke_every_application_command() {
    let authority = authority();
    for command in registered_commands() {
        assert!(
            allowed_for(&authority, &command, CONTROL_WINDOW),
            "control can no longer invoke `{command}`; add it to \
             permissions/app-commands.toml"
        );
    }
}

/// Drift guard. Turning the ACL gate on makes the permission file
/// load-bearing: a command registered in `generate_handler!` but missing from
/// the permission file is denied for control at runtime, and a stale entry
/// hides that a command was removed.
#[test]
fn app_commands_permission_matches_generate_handler() {
    let mut registered = registered_commands();
    let mut permitted = permitted_commands();
    registered.sort();
    permitted.sort();

    let missing: Vec<_> = registered
        .iter()
        .filter(|c| !permitted.contains(c))
        .collect();
    let extra: Vec<_> = permitted
        .iter()
        .filter(|c| !registered.contains(c))
        .collect();

    assert!(
        missing.is_empty(),
        "these commands are registered but not permitted, so control cannot \
         call them: {missing:?}"
    );
    assert!(
        extra.is_empty(),
        "these commands are permitted but no longer registered: {extra:?}"
    );
}

/// The stage capability itself must never name an app-scope permission.
/// App permissions have no `plugin:` prefix, which is exactly what makes them
/// easy to add by accident.
#[test]
fn stage_capability_declares_no_application_permissions() {
    let capabilities = capabilities();
    let stage = capabilities
        .values()
        .find(|c| c.windows.iter().any(|w| w == STAGE_WINDOW))
        .expect("a capability for the stage window");

    for permission in &stage.permissions {
        let identifier = permission.identifier().get();
        assert!(
            identifier.contains(':'),
            "stage capability grants `{identifier}`, which has no plugin \
             prefix and is therefore an application-command permission; the \
             stage must have none (spec §50.2)"
        );
        assert!(
            identifier.starts_with("core:event:"),
            "stage capability grants `{identifier}`; the stage is limited to \
             the core event channel (spec Appendix D.3)"
        );
    }
}

/// H5. No window may invoke the dialog plugin from JavaScript.
///
/// The file pickers now run in Rust (`src/dialogs.rs`) and hand their result
/// straight to the importer/exporter, so a webview never sees — and never
/// supplies — a filesystem path. Re-granting `dialog:allow-open`/`allow-save`
/// would not by itself reopen the hole (no command accepts a path any more),
/// but it would put the picker back on the JavaScript side, which is where the
/// next path-shaped argument would come from.
#[test]
fn no_window_can_open_a_file_dialog_from_javascript() {
    for capability in capabilities().values() {
        for permission in &capability.permissions {
            let identifier = permission.identifier().get();
            assert!(
                !identifier.starts_with("dialog:"),
                "capability `{}` grants `{identifier}`; file pickers belong in \
                 Rust so no path is chosen by JavaScript (H5, spec §50.7)",
                capability.identifier
            );
        }
    }
}
