//! M4 regression: the Rust command argument types must accept exactly the
//! payloads the TypeScript wrappers send. Both sides read the same fixture —
//! `tests/fixtures/ipc/script-command-payloads.json` — so a change to either
//! DTO that is not mirrored fails here or in
//! `tests/unit/control/scripts-ipc-contract.test.ts`.

use candidcue_lib::scripts::import_export::{ExportRequest, ImportRequest};
use candidcue_lib::scripts::{CreateScriptInput, ScriptId, ScriptMetadataPatch};

fn fixture() -> serde_json::Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tests")
        .join("fixtures")
        .join("ipc")
        .join("script-command-payloads.json");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{} must exist: {e}", path.display()));
    serde_json::from_str(&raw).expect("fixture parses")
}

#[test]
fn import_request_accepts_the_frontend_payload() {
    let f = fixture();
    let request: ImportRequest = serde_json::from_value(f["import_script"]["request"].clone())
        .expect("the frontend's import payload must deserialize");
    assert_eq!(request.title.as_deref(), Some("Keynote"));

    // And it works with no fields at all: a bare import is legitimate.
    assert!(serde_json::from_value::<ImportRequest>(serde_json::json!({})).is_ok());
}

/// H5. Neither IPC type carries a filesystem path.
///
/// `ImportOptions`/`ExportOptions` still exist as the already-authorized
/// internal shapes, but they no longer implement `Deserialize` — so no webview
/// payload can become one, and the path can only come from the Rust-side
/// dialog (spec §50.7). Re-deriving `Deserialize` on either would let a command
/// take a path argument again, and the `use` list at the top of this file would
/// be the only thing standing in the way.
///
/// What this test can check at runtime is that (a) the shared fixture — the
/// thing both sides agree the frontend sends — contains no path, and (b) a
/// path-bearing payload is silently ignored rather than honoured.
#[test]
fn no_script_command_payload_carries_a_filesystem_path() {
    let f = fixture();
    for key in [
        "import_script",
        "export_script_markdown",
        "export_script_bundle",
        "export_script_text",
    ] {
        let payload = f[key]["request"].clone();
        let object = payload.as_object().expect("request is an object");
        for field in ["path", "destination", "sourcePath", "sourceFile", "file"] {
            assert!(
                !object.contains_key(field),
                "{key} sends `{field}`; the webview must not name a filesystem \
                 path (H5, spec §50.7)"
            );
        }
        for value in object.values() {
            if let Some(text) = value.as_str() {
                assert!(
                    !text.starts_with('/') && !text.contains(":\\"),
                    "{key} sends what looks like an absolute path: {text:?}"
                );
            }
        }
    }

    // A payload shaped like the OLD one deserializes, but the path is dropped
    // on the floor: there is no field to receive it.
    let sneaky: ImportRequest =
        serde_json::from_value(serde_json::json!({ "path": "/etc/passwd", "title": "x" }))
            .expect("unknown fields are ignored");
    assert_eq!(sneaky.title.as_deref(), Some("x"));

    let sneaky: ExportRequest = serde_json::from_value(serde_json::json!({
        "destination": "/Users/example/.ssh/config",
        "format": "markdown",
    }))
    .expect("unknown fields are ignored");
    assert_eq!(sneaky.format, "markdown");
    assert!(sneaky.suggested_name.is_none());
}

#[test]
fn export_request_accepts_every_frontend_format() {
    let f = fixture();
    for (key, expected_format) in [
        ("export_script_markdown", "markdown"),
        ("export_script_bundle", "bundle"),
        ("export_script_text", "text"),
    ] {
        let request: ExportRequest = serde_json::from_value(f[key]["request"].clone())
            .unwrap_or_else(|e| panic!("{key} must deserialize: {e}"));
        assert_eq!(request.format, expected_format);
        assert!(
            candidcue_lib::scripts::import_export::export_format_extension(&request.format).is_ok(),
            "{key} sends a format the exporter rejects"
        );
    }

    // `candidcue` is the file extension, never a format name.
    let bogus: ExportRequest =
        serde_json::from_value(serde_json::json!({ "format": "candidcue" }))
            .expect("parses as a string");
    assert!(
        candidcue_lib::scripts::import_export::export_format_extension(&bogus.format).is_err(),
        "the exporter must reject `candidcue`, which is why the frontend sends `bundle`"
    );

    // The format is not optional.
    assert!(serde_json::from_value::<ExportRequest>(serde_json::json!({})).is_err());
}

#[test]
fn save_and_create_payloads_deserialize() {
    let f = fixture();
    let patch: ScriptMetadataPatch =
        serde_json::from_value(f["save_script"]["metadataPatch"].clone()).expect("patch");
    assert_eq!(patch.title.as_deref(), Some("Keynote"));

    let input: CreateScriptInput =
        serde_json::from_value(f["create_script"]["input"].clone()).expect("create input");
    assert_eq!(input.title, "Keynote");
}

#[test]
fn transition_payloads_all_carry_an_expected_revision() {
    let f = fixture();
    for command in ["rename_script", "trash_script", "restore_script", "save_script"] {
        assert!(
            f[command]["expectedRevision"].is_i64(),
            "{command} must send expectedRevision; without it the command \
             cannot perform a compare-and-swap (H1)"
        );
        let raw = f[command]["scriptId"].as_str().expect("scriptId");
        assert!(
            ScriptId::parse(raw).is_ok(),
            "{command} sends a script id that the boundary would reject"
        );
    }
}

/// The error codes this pass introduced must exist on the TypeScript side, and
/// the one it retired must be gone.
///
/// M3 in particular: `LISTENER_SIGNATURE_INVALID` named a check that was never
/// implemented — a SHA-256 comparison against a hash the pack wrote about
/// itself. Leaving the name in the contract would keep the claim alive.
#[test]
fn the_typescript_error_contract_matches_the_rust_codes() {
    let ts = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("src")
            .join("shared")
            .join("contracts")
            .join("errors.ts"),
    )
    .expect("errors.ts");

    for code in [
        // H4 — remote image fetch
        "ASSET_URL_INSECURE",
        "ASSET_URL_BLOCKED",
        "ASSET_DOWNLOAD_FAILED",
        // M1 — stale stage protection
        "STAGE_SESSION_MISMATCH",
        // M3 — honest listener verification
        "LISTENER_CHECKSUM_INVALID",
        "LISTENER_UNVERIFIED",
    ] {
        assert!(
            ts.contains(&format!("'{code}'")),
            "{code} is raised by Rust but missing from src/shared/contracts/errors.ts"
        );
    }

    assert!(
        !ts.contains("'LISTENER_SIGNATURE_INVALID'"),
        "LISTENER_SIGNATURE_INVALID names a signature check that does not \
         exist; it was renamed to LISTENER_CHECKSUM_INVALID (M3)"
    );

    let rust = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("listeners")
            .join("mod.rs"),
    )
    .expect("listeners/mod.rs");
    // The module docs still MENTION the old name (in backticks) to explain what
    // was wrong with it; what must not come back is the string literal, which
    // is the only form that becomes an error code.
    assert!(
        !rust.contains("\"LISTENER_SIGNATURE_INVALID\""),
        "the listener module must not raise a code that claims a signature check"
    );
}
