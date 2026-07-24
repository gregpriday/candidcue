//! M4 regression: the Rust command argument types must accept exactly the
//! payloads the TypeScript wrappers send. Both sides read the same fixture —
//! `tests/fixtures/ipc/script-command-payloads.json` — so a change to either
//! DTO that is not mirrored fails here or in
//! `tests/unit/control/scripts-ipc-contract.test.ts`.

use candidcue_lib::scripts::import_export::{ExportOptions, ImportOptions};
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
fn import_options_accept_the_frontend_payload() {
    let f = fixture();
    let options: ImportOptions =
        serde_json::from_value(f["import_script"]["options"].clone()).expect(
            "the frontend's import payload must deserialize; it used to send `sourcePath` \
             while Rust required `path`, so every import failed before it ran",
        );
    assert_eq!(options.path, "/Users/example/Documents/keynote.md");
    assert_eq!(options.title.as_deref(), Some("Keynote"));

    // The old payload must NOT silently work — that would hide the drift.
    assert!(
        serde_json::from_value::<ImportOptions>(serde_json::json!({ "sourcePath": "/x.md" }))
            .is_err()
    );
}

#[test]
fn export_options_accept_every_frontend_format() {
    let f = fixture();
    for (key, expected_format) in [
        ("export_script_markdown", "markdown"),
        ("export_script_bundle", "bundle"),
        ("export_script_text", "text"),
    ] {
        let options: ExportOptions = serde_json::from_value(f[key]["options"].clone())
            .unwrap_or_else(|e| panic!("{key} must deserialize: {e}"));
        assert_eq!(options.format, expected_format);
        assert!(!options.destination.is_empty());
    }

    // `candidcue` is the file extension, never a format name.
    let bogus: ExportOptions = serde_json::from_value(serde_json::json!({
        "destination": "/tmp/x.candidcue",
        "format": "candidcue",
    }))
    .expect("parses as a string");
    assert!(
        !matches!(bogus.format.as_str(), "markdown" | "text" | "bundle"),
        "the export matcher would reject this at runtime, which is why the \
         frontend must send `bundle`"
    );

    // Options are not optional: Rust needs a destination.
    assert!(serde_json::from_value::<ExportOptions>(serde_json::json!({})).is_err());
    assert!(
        serde_json::from_value::<ExportOptions>(serde_json::json!({ "format": "markdown" }))
            .is_err()
    );
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
