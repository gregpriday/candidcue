//! M4 regression: the Rust command argument types must accept exactly the
//! payloads the TypeScript wrappers send. Both sides read the same fixture —
//! `tests/fixtures/ipc/script-command-payloads.json` — so a change to either
//! DTO that is not mirrored fails here or in
//! `tests/unit/control/scripts-ipc-contract.test.ts`.

use candidcue_lib::scripts::import_export::{ExportRequest, ImportRequest};
use candidcue_lib::scripts::{
    CreateScriptInput, PageRequest, ScriptFilter, ScriptId, ScriptMetadataPatch, ScriptStatus,
};

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

/// C3/C7/S2 — `list_scripts` is the command the shared fixture did not cover,
/// and it is where the drift lived: the frontend sent `filter.view`, which this
/// struct has no field for, so serde dropped it and `status` stayed `None`.
///
/// Reverting the TypeScript mapping makes the first assertion fail (no
/// `status`); reverting `deny_unknown_fields` makes the last one fail.
#[test]
fn list_scripts_filter_accepts_the_frontend_payload_and_nothing_else() {
    let f = fixture();

    let trash: ScriptFilter = serde_json::from_value(f["list_scripts_trash"]["filter"].clone())
        .expect("the Trash view's filter must deserialize");
    assert_eq!(trash.status, Some(ScriptStatus::Trash));
    assert!(!trash.opened_only);

    let recent: ScriptFilter = serde_json::from_value(f["list_scripts_recent"]["filter"].clone())
        .expect("the Recent view's filter must deserialize");
    assert!(recent.opened_only);
    assert_eq!(recent.status, None);

    let all: ScriptFilter = serde_json::from_value(f["list_scripts_all"]["filter"].clone())
        .expect("the All view's filter must deserialize");
    assert_eq!(all.query.as_deref(), Some("keynote"));
    assert_eq!(all.status, None);
    assert!(!all.opened_only);

    // The bug shape: a `view` field is now a hard error rather than a silent
    // default that lists live scripts under the Trash heading.
    let err = serde_json::from_value::<ScriptFilter>(serde_json::json!({ "view": "trash" }))
        .expect_err("`view` is not a field of ScriptFilter and must be rejected");
    assert!(
        err.to_string().contains("view"),
        "the error must name the unknown field, got: {err}"
    );
}

/// C7 — the fixture's sort keys must be ones `repo::list_scripts` matches on.
/// The four the library emits used to match no arm at all.
#[test]
fn list_scripts_sort_keys_are_the_ones_rust_implements() {
    let f = fixture();
    let repo = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("scripts")
            .join("repo.rs"),
    )
    .expect("repo.rs");

    for key in ["list_scripts_all", "list_scripts_recent", "list_scripts_trash"] {
        let sort = f[key]["sort"].as_str().expect("fixture carries a sort");
        assert!(
            repo.contains(&format!("Some(\"{sort}\")")),
            "{key} sends sort `{sort}`, which repo::list_scripts has no arm for"
        );
    }

    // Every option the library's sort control offers must be implemented.
    for key in ["recently_edited", "name", "created", "estimated_length"] {
        assert!(
            repo.contains(&format!("Some(\"{key}\")")),
            "the library offers `{key}` but repo::list_scripts does not match it"
        );
    }
}

/// S2 — `page` is a struct. The TypeScript wrapper used to type it as a bare
/// number, which would have been an outright deserialization failure.
#[test]
fn list_scripts_page_is_a_page_request_not_a_number() {
    let f = fixture();
    let page: PageRequest = serde_json::from_value(f["list_scripts_trash"]["page"].clone())
        .expect("the paged payload must deserialize");
    assert_eq!(page.page, 1);
    assert_eq!(page.page_size, 50);

    assert!(
        serde_json::from_value::<PageRequest>(serde_json::json!(1)).is_err(),
        "a bare number is not a PageRequest; the old TS signature sent one"
    );
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

    // Both DTOs now reject fields they do not declare, so a TypeScript wrapper
    // that starts sending one fails immediately instead of having it dropped
    // (which is exactly how the library `view` filter went missing — C3).
    assert!(
        serde_json::from_value::<CreateScriptInput>(
            serde_json::json!({ "title": "Keynote", "tags": ["x"] })
        )
        .is_err(),
        "CreateScriptInput must reject unknown fields"
    );
    assert!(
        serde_json::from_value::<ScriptMetadataPatch>(
            serde_json::json!({ "title": "Keynote", "colour": "red" })
        )
        .is_err(),
        "ScriptMetadataPatch must reject unknown fields"
    );
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

// ---------------------------------------------------------------------------
// C1 regression: credential expiry unit across the IPC boundary
// ---------------------------------------------------------------------------

use candidcue_lib::openai::{normalize_expiry_to_epoch_ms, EphemeralCredential};

fn credential_fixture() -> serde_json::Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tests")
        .join("fixtures")
        .join("ipc")
        .join("realtime-credential.json");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{} must exist: {e}", path.display()));
    serde_json::from_str(&raw).expect("fixture parses")
}

/// The provider's `expires_at` is epoch SECONDS; the webview compares expiry
/// against `Date.now()`, which is epoch MILLISECONDS. Forwarding the raw value
/// made every freshly minted credential compare as already-expired, so the app
/// rejected its own secret before SDP negotiation and never transcribed —
/// while the UI still reported a healthy session.
#[test]
fn credential_expiry_is_normalized_to_epoch_millis() {
    let f = credential_fixture();
    let provider_seconds = f["providerClientSecretResponse"]["expires_at"]
        .as_i64()
        .expect("fixture provider timestamp");

    // Deliberately a realistic 10-digit provider value: a millisecond-shaped
    // fixture is exactly what hid this defect on both sides.
    assert_eq!(provider_seconds.to_string().len(), 10);

    let normalized = normalize_expiry_to_epoch_ms(provider_seconds);
    assert_eq!(
        normalized,
        f["notes"]["expectedExpiresAtEpochMs"].as_i64().unwrap()
    );
    assert_eq!(normalized, provider_seconds * 1000);
    assert_eq!(normalized.to_string().len(), 13);
}

/// Already-millisecond input must not be scaled a second time — that would
/// hand the webview a credential that never appears to expire, which is the
/// mirror-image failure (a dead session the health monitor never renews).
#[test]
fn credential_expiry_normalization_is_idempotent_for_millis() {
    let millis = 1_785_110_400_000_i64;
    assert_eq!(normalize_expiry_to_epoch_ms(millis), millis);
}

/// The serialized field name carries its unit, and matches the fixture the
/// TypeScript contract test reads.
#[test]
fn credential_serializes_to_the_frontend_shape() {
    let f = credential_fixture();
    let credential = EphemeralCredential {
        value: "ek_live_c1regression".into(),
        expires_at_epoch_ms: normalize_expiry_to_epoch_ms(
            f["providerClientSecretResponse"]["expires_at"]
                .as_i64()
                .unwrap(),
        ),
        session_type: "transcription".into(),
        credential_generation: 1,
    };
    let encoded = serde_json::to_value(&credential).expect("serializes");
    assert_eq!(encoded, f["expectedCredential"]);
    assert!(encoded.get("expiresAtEpochMs").is_some());
    assert!(
        encoded.get("expiresAt").is_none(),
        "the unitless field name is what caused C1; it must not come back"
    );
}
