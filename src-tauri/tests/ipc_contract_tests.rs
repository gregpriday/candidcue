//! M4 regression: the Rust command argument types must accept exactly the
//! payloads the TypeScript wrappers send. Both sides read the same fixture —
//! `tests/fixtures/ipc/script-command-payloads.json` — so a change to either
//! DTO that is not mirrored fails here or in
//! `tests/unit/control/scripts-ipc-contract.test.ts`.

use candidcue_lib::scripts::import_export::{ExportRequest, ImportRequest};
use candidcue_lib::scripts::{
    CreateScriptInput, PageRequest, RevisionDocument, RevisionSummary, SaveResult, ScriptFilter,
    ScriptId, ScriptMetadataPatch, ScriptStatus,
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

// ---------------------------------------------------------------------------
// §21.4 revision browser: the three commands that had no TypeScript caller
// ---------------------------------------------------------------------------

fn scripts_cmds_source() -> String {
    std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("commands")
            .join("scripts_cmds.rs"),
    )
    .expect("scripts_cmds.rs")
}

/// The revision commands take bare parameters rather than a DTO, so the thing
/// that can drift is the PARAMETER NAME: Tauri matches the camelCase form of
/// each Rust parameter, and a mismatch is a deserialization failure at call
/// time, not a compile error. The fixture is the frontend's payload; every key
/// in it must correspond to a declared parameter, and every declared parameter
/// must appear in the fixture.
#[test]
fn revision_command_arguments_match_the_frontend_payload_keys() {
    let f = fixture();
    let source = scripts_cmds_source();

    fn camel(snake: &str) -> String {
        let mut out = String::new();
        let mut upper = false;
        for ch in snake.chars() {
            if ch == '_' {
                upper = true;
            } else if upper {
                out.extend(ch.to_uppercase());
                upper = false;
            } else {
                out.push(ch);
            }
        }
        out
    }

    for (command, params) in [
        ("list_revisions", vec!["script_id"]),
        ("get_revision", vec!["script_id", "revision_id"]),
        (
            "restore_revision",
            vec!["script_id", "revision_id", "expected_revision"],
        ),
    ] {
        let body = source
            .split(&format!("pub async fn {command}("))
            .nth(1)
            .unwrap_or_else(|| panic!("{command} must exist in scripts_cmds.rs"))
            .split(')')
            .next()
            .expect("parameter list");

        let payload = f[command]
            .as_object()
            .unwrap_or_else(|| panic!("fixture must carry a {command} payload"));

        for param in &params {
            assert!(
                body.contains(&format!("{param}:")),
                "{command} no longer declares `{param}`; the frontend still sends \
                 `{}`",
                camel(param)
            );
            assert!(
                payload.contains_key(&camel(param)),
                "{command} declares `{param}` but the frontend payload has no \
                 `{}` key — Tauri would pass a missing argument",
                camel(param)
            );
        }
        assert_eq!(
            payload.len(),
            params.len(),
            "{command}'s payload has keys Rust does not declare: {:?}",
            payload.keys().collect::<Vec<_>>()
        );
    }

    // The compare-and-swap argument must be a number, and the script id must
    // survive the boundary parser.
    assert!(f["restore_revision"]["expectedRevision"].is_i64());
    assert!(ScriptId::parse(f["restore_revision"]["scriptId"].as_str().unwrap()).is_ok());
}

/// The response shapes the revision panel reads. `RevisionDocument` flattens
/// its summary, so the payload is a summary WITH a `source` — a TypeScript
/// twin shaped `{ summary, source }` would read `undefined` everywhere.
#[test]
fn revision_payloads_serialize_to_the_frontend_shape() {
    let f = fixture();
    let summary = RevisionSummary {
        id: f["expectedRevisionSummary"]["id"].as_str().unwrap().into(),
        revision_number: 3,
        source_hash: "9f2c1b0ae4d5".into(),
        reason: "autosave_interval".into(),
        word_count: Some(412),
        created_at: "2026-07-24T09:15:00Z".into(),
    };
    let encoded = serde_json::to_value(&summary).expect("serializes");
    assert_eq!(encoded, f["expectedRevisionSummary"]);

    let document = RevisionDocument {
        summary,
        source: "# Keynote\n".into(),
    };
    let encoded = serde_json::to_value(&document).expect("serializes");
    assert_eq!(
        encoded["revisionNumber"], 3,
        "RevisionDocument must FLATTEN its summary; a nested `summary` object \
         would leave every field of the frontend twin undefined"
    );
    assert!(encoded.get("summary").is_none());
    assert_eq!(encoded["source"], "# Keynote\n");
}

/// `restore_revision` returns `SaveResult`, which has no `status` field: a
/// stale revision or an external change is an `Err`, not a value. The older
/// `SaveResult` twin in scripts-types.ts declares
/// `status: 'saved' | 'conflict'`, so anything branching on it is dead code —
/// this pins the real shape so the new twin in services/revisions.ts cannot
/// drift back.
#[test]
fn restore_result_has_no_status_field() {
    let f = fixture();
    let result = SaveResult {
        script_revision: 8,
        source_hash: "9f2c1b0ae4d5".into(),
        saved_at: "2026-07-24T09:20:00Z".into(),
        revision_created: true,
        revision_id: Some(f["revisionId"].as_str().unwrap().into()),
    };
    let encoded = serde_json::to_value(&result).expect("serializes");
    assert_eq!(encoded, f["expectedRestoreResult"]);
    assert!(
        encoded.get("status").is_none(),
        "Rust has never sent a `status`; a conflict is an Err"
    );
}

/// Restoring must itself be undoable. The mechanism is a single line in
/// `repo::restore_revision` — it routes through `save_script` with
/// `revision_reason: "before_restore"`, so the text the restore destroys is
/// snapshotted under the same per-script lock that writes the replacement.
/// Deleting that reason would silently turn restore into a destructive
/// operation with no visible symptom, so it is asserted here.
#[test]
fn restore_snapshots_the_current_text_before_overwriting_it() {
    let repo = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("scripts")
            .join("repo.rs"),
    )
    .expect("repo.rs");
    let body = repo
        .split("pub async fn restore_revision(")
        .nth(1)
        .expect("restore_revision exists")
        .split("\npub ")
        .next()
        .expect("function body");
    assert!(
        body.contains("save_script("),
        "restore_revision must go through save_script, which snapshots the \
         preimage under the per-script lock"
    );
    assert!(
        body.contains("\"before_restore\""),
        "restore_revision must force a revision of the current text before \
         replacing it, otherwise a restore is unrecoverable"
    );
}

/// Every reason string Rust can write must be one the UI knows how to name.
/// A new reason that only the panel's fallback handles would surface as raw
/// snake_case; a reason the panel lists but Rust never writes is a decoy.
#[test]
fn revision_reasons_are_exactly_the_ones_the_ui_labels() {
    let f = fixture();
    let listed: Vec<String> = f["revisionReasons"]
        .as_array()
        .expect("fixture reason list")
        .iter()
        .map(|v| v.as_str().expect("reason string").to_string())
        .collect();

    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let sources: String = [
        root.join("src").join("scripts").join("repo.rs"),
        root.join("src").join("scripts").join("import_export.rs"),
        root.join("src").join("commands").join("sessions_cmds.rs"),
    ]
    .iter()
    .map(|p| std::fs::read_to_string(p).expect("source file"))
    .collect::<Vec<_>>()
    .join("\n");

    // Direction 1 — nothing the UI lists may be a decoy.
    for reason in &listed {
        assert!(
            sources.contains(&format!("\"{reason}\"")),
            "the UI labels `{reason}`, but no Rust source writes that snapshot \
             reason; a label for a reason that cannot occur is a decoy"
        );
    }

    // Direction 2 — nothing Rust writes may be missing from the UI's list.
    // Every literal reason reaches the column through one of these two call
    // shapes, and both put the string on the same line as the marker.
    for line in sources.lines() {
        let marker = if line.contains("create_revision_snapshot(") {
            "create_revision_snapshot("
        } else if line.contains("revision_reason: Some(") {
            "revision_reason: Some("
        } else {
            continue;
        };
        let tail = line.split(marker).nth(1).unwrap_or_default();
        let Some(literal) = tail.split('"').nth(1) else {
            continue; // the reason is a variable on this call (e.g. `&reason`)
        };
        if literal.is_empty() || !literal.chars().all(|c| c.is_ascii_lowercase() || c == '_') {
            continue;
        }
        assert!(
            listed.iter().any(|l| l == literal),
            "Rust writes the snapshot reason `{literal}` but the revision panel \
             has no label for it; it would surface as raw snake_case"
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
// §44.11 / §47.10 diagnostics and support bundle
// ---------------------------------------------------------------------------

use candidcue_lib::commands::settings_cmds::{SupportBundleResult, SystemDiagnostics};

fn settings_fixture() -> serde_json::Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tests")
        .join("fixtures")
        .join("ipc")
        .join("settings-command-payloads.json");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{} must exist: {e}", path.display()));
    serde_json::from_str(&raw).expect("fixture parses")
}

/// The diagnostics payload the Settings panel reads, field for field. A rename
/// on either side turns a number into `undefined`, which a panel that exists to
/// be believed must not do quietly.
#[test]
fn system_diagnostics_serializes_to_the_frontend_shape() {
    let f = settings_fixture();
    let diagnostics = SystemDiagnostics {
        app_version: "0.1.0".into(),
        os: "macos".into(),
        arch: "aarch64".into(),
        database_integrity_ok: true,
        script_count: 12,
        session_count: 0,
        data_dir: "/Users/example/Library/Application Support/com.candidcue.app".into(),
    };
    let encoded = serde_json::to_value(&diagnostics).expect("serializes");
    assert_eq!(encoded, f["expectedSystemDiagnostics"]);

    let bundle = SupportBundleResult {
        path: "/Users/example/Desktop/CandidCue-support-20260724-091500".into(),
    };
    assert_eq!(
        serde_json::to_value(&bundle).expect("serializes"),
        f["expectedSupportBundleResult"]
    );
}

/// C5, the second instance. `export_support_bundle` had the identical
/// unusable-destination shape `export_all_data` was fixed for: a
/// `destination: String` parameter the control webview could never fill,
/// because the dialog plugin is not granted to JavaScript. Any caller would
/// have sent `{ destination: undefined }`, JSON would have dropped the key,
/// and the command would have failed to deserialize before running a line.
///
/// Both commands must now take the folder from a Rust-side picker and return
/// `Option<…>`, where `None` is a cancelled dialog rather than a failure.
#[test]
fn destination_taking_export_commands_run_their_own_picker() {
    let f = settings_fixture();
    let source = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("commands")
            .join("settings_cmds.rs"),
    )
    .expect("settings_cmds.rs");

    for (command, result_type) in [
        ("export_support_bundle", "Option<SupportBundleResult>"),
        ("export_all_data", "Option<DataExportResult>"),
    ] {
        // No `(` in the needle: these commands are now generic over the Tauri
        // runtime (`pub async fn export_all_data<R: Runtime>(…)`) so that they
        // can be bound on the MockRuntime at all.
        let signature = source
            .split(&format!("pub async fn {command}"))
            .nth(1)
            .unwrap_or_else(|| panic!("{command} must exist"))
            .split('{')
            .next()
            .expect("signature");
        assert!(
            !signature.contains("destination:"),
            "{command} takes a `destination` argument again; the webview cannot \
             supply one (C5) — run the picker in Rust instead"
        );
        assert!(
            signature.contains(result_type),
            "{command} must return {result_type} so a cancelled picker is None, \
             not an error"
        );
        let body = source
            .split(&format!("pub async fn {command}"))
            .nth(1)
            .expect("body")
            .split("\n#[tauri::command]")
            .next()
            .expect("body");
        assert!(
            body.contains("pick_destination_folder"),
            "{command} must obtain its folder from the Rust-side picker"
        );
    }

    // And the payload both sides agree on is empty: there is no argument a
    // caller could smuggle a path into.
    for command in ["get_system_diagnostics", "export_support_bundle"] {
        assert!(
            f[command]
                .as_object()
                .unwrap_or_else(|| panic!("fixture carries a {command} payload"))
                .is_empty(),
            "{command} must take no arguments from the webview"
        );
    }
}

// ---------------------------------------------------------------------------
// §52 / §46.6 display profiles
// ---------------------------------------------------------------------------

use candidcue_lib::windows::DisplayProfile;

fn stage_fixture() -> serde_json::Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tests")
        .join("fixtures")
        .join("ipc")
        .join("stage-command-payloads.json");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{} must exist: {e}", path.display()));
    serde_json::from_str(&raw).expect("fixture parses")
}

/// The profile payload the (still to be built) Preflight UI sends. `id` is
/// absent on create and `updatedAt` is Rust's to assign, so both must be
/// optional on the way in — a required `id` would make every first save fail.
#[test]
fn display_profile_accepts_the_frontend_payload() {
    let f = stage_fixture();
    let profile: DisplayProfile =
        serde_json::from_value(f["save_display_profile"]["profile"].clone())
            .expect("the frontend's profile payload must deserialize");
    assert!(profile.id.is_none(), "a create carries no id");
    assert_eq!(profile.name, "Teleprompter Display");
    assert_eq!(profile.display_fingerprint.as_deref(), Some("dsp-mock-prompter"));
    assert_eq!(profile.stage["schemaVersion"], 1);
    assert_eq!(profile.stage["fontSizePx"], 72);
    assert!(profile.updated_at.is_none());

    // And the row that comes back out matches the TypeScript record twin.
    let saved: DisplayProfile = serde_json::from_value(f["expectedSavedProfile"].clone())
        .expect("a saved profile round-trips");
    assert_eq!(
        serde_json::to_value(&saved).expect("serializes"),
        f["expectedSavedProfile"]
    );
}

/// The three rejections the service mirrors client-side. If Rust ever relaxes
/// one, the duplicated check in services/display-profiles.ts becomes a UI-only
/// restriction — which is why the rules are asserted here rather than only
/// there.
#[test]
fn display_profile_validation_rules_are_the_ones_the_service_mirrors() {
    let f = stage_fixture();
    let source = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("windows")
            .join("mod.rs"),
    )
    .expect("windows/mod.rs");
    let body = source
        .split("pub async fn save_display_profile(")
        .nth(1)
        .expect("save_display_profile exists")
        .split("\npub ")
        .next()
        .expect("body");

    assert!(body.contains("A display profile needs a name."));
    assert!(body.contains("Stage settings must be an object."));
    assert!(body.contains("Stage settings have an unsupported schema version."));
    assert!(
        body.contains("schemaVersion"),
        "the schema gate must read the camelCase key the frontend sends"
    );

    // The fixture's rejected shapes still parse as DisplayProfile — they are
    // refused by the validation above, not by serde. That distinction matters:
    // a serde failure would surface as an opaque deserialization error.
    for key in ["emptyName", "wrongSchemaVersion", "stageNotAnObject"] {
        assert!(
            serde_json::from_value::<DisplayProfile>(f["rejectedProfiles"][key].clone()).is_ok(),
            "{key} must reach the validation, not fail to deserialize"
        );
    }
}

// ---------------------------------------------------------------------------
// §14.2 F / §46.7 listener catalogue
// ---------------------------------------------------------------------------

use candidcue_lib::listeners::{ListenerCatalogue, ListenerCatalogueEntry};

fn listener_fixture() -> serde_json::Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tests")
        .join("fixtures")
        .join("ipc")
        .join("listener-command-payloads.json");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{} must exist: {e}", path.display()));
    serde_json::from_str(&raw).expect("fixture parses")
}

#[test]
fn listener_catalogue_serializes_to_the_frontend_shape() {
    let f = listener_fixture();
    let entry = ListenerCatalogueEntry {
        pack_id: "mira".into(),
        latest_version: "1.0.0".into(),
        display_name: "Mira".into(),
        description: "A calm listener who holds eye contact.".into(),
        thumbnail_url: "asset://localhost/listeners/mira/poster.webp".into(),
        approximate_bytes: 18_874_368,
        variants: vec!["720p".into()],
        minimum_app_version: "0.1.0".into(),
        installed_version: Some("1.0.0".into()),
    };
    assert_eq!(
        serde_json::to_value(&entry).expect("serializes"),
        f["expectedCatalogueEntry"]
    );

    let catalogue = ListenerCatalogue {
        entries: Vec::new(),
        fetched_at: "2026-07-24T09:15:00Z".into(),
        source: "bundled_only".into(),
    };
    assert_eq!(
        serde_json::to_value(&catalogue).expect("serializes"),
        f["expectedCatalogue"]
    );

    // `installedVersion` is skipped when absent, so the TypeScript twin
    // declares it optional. A pack that is merely listed must not read as
    // installed.
    let uninstalled = ListenerCatalogueEntry {
        installed_version: None,
        ..entry
    };
    let encoded = serde_json::to_value(&uninstalled).expect("serializes");
    assert!(encoded.get("installedVersion").is_none());
}

/// The listener UI shows NO download affordance, and this is the assertion
/// that keeps that honest in both directions.
///
/// `download_listener` and `cancel_listener_download` are deliberate
/// NOT_IMPLEMENTED stubs — there is no CandidCue-controlled pack host — so a
/// download button could only ever throw. If someone implements the pipeline,
/// this test fails, which is the prompt to flip `DOWNLOADS_SUPPORTED` in
/// src/control/services/listeners-catalogue.ts and build the affordance.
///
/// The reverse mistake is also covered: `remove_listener` is REAL, so it must
/// not be allowed to decay into a stub while the UI offers a Remove button.
#[test]
fn listener_download_commands_are_still_honest_stubs() {
    let f = listener_fixture();
    let source = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("commands")
            .join("listeners_cmds.rs"),
    )
    .expect("listeners_cmds.rs");

    for command in f["notImplementedCommands"]
        .as_array()
        .expect("fixture command list")
    {
        let name = command.as_str().expect("command name");
        let body = source
            .split(&format!("pub async fn {name}("))
            .nth(1)
            .unwrap_or_else(|| panic!("{name} must exist in listeners_cmds.rs"))
            .split("\n#[tauri::command]")
            .next()
            .expect("body");
        assert!(
            body.contains("not_implemented"),
            "{name} is implemented now; the control UI hides every download \
             affordance on the assumption that it is not (DOWNLOADS_SUPPORTED \
             in services/listeners-catalogue.ts)"
        );
    }

    let remove_body = source
        .split("pub async fn remove_listener(")
        .nth(1)
        .expect("remove_listener exists")
        .split("\n#[tauri::command]")
        .next()
        .expect("body");
    assert!(
        !remove_body.contains("not_implemented"),
        "remove_listener must stay implemented; Settings offers a Remove \
         button for downloaded packs"
    );
    assert!(
        remove_body.contains("remove_pack"),
        "remove_listener must delegate to listeners::remove_pack, which is \
         what refuses bundled packs"
    );
}

// ---------------------------------------------------------------------------
// §37 Listener settings — one structure, not two
// ---------------------------------------------------------------------------

use candidcue_lib::settings::{
    validate as validate_settings, AppSettings as RustAppSettings,
    ListenerSettings as RustListenerSettings,
};

fn listener_settings_fixture() -> serde_json::Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tests")
        .join("fixtures")
        .join("ipc")
        .join("listener-settings-payload.json");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{} must exist: {e}", path.display()));
    serde_json::from_str(&raw).expect("fixture parses")
}

/// The round trip, closed on the Rust side: the patch the TypeScript adapter
/// emits deserializes into the struct, and the struct serializes back to the
/// identical document the adapter reads.
///
/// This is the assertion the previous arrangement could not have passed at all.
/// `listener` was `Record<string, unknown>` on the TypeScript side and was never
/// mapped in either direction, so the fields Rust declared here and the fields
/// the UI wrote were two disjoint sets that never met.
#[test]
fn listener_settings_survive_the_round_trip_unchanged() {
    let f = listener_settings_fixture();
    let sent = f["settings"].clone();

    let listener: RustListenerSettings = serde_json::from_value(sent.clone())
        .expect("the frontend's listener patch must deserialize");
    let stored = serde_json::to_value(&listener).expect("serializes");

    assert_eq!(
        stored, sent,
        "a listener setting changed shape between the UI and the stored document"
    );

    // The values are the ones that were sent, not defaults that happen to
    // serialize to the same JSON.
    assert_eq!(listener.default_pack_id.as_deref(), Some("mira"));
    assert!(!listener.autoplay);
    assert_eq!(listener.dim_percent, 62.0);
    assert_eq!(listener.blur_px, 6.5);
    assert_eq!(listener.saturation, 0.3);
    assert!(listener.keep_when_blanked);

    // And the whole document validates, so the round trip is not passing values
    // the backend would reject on the next write.
    let settings = RustAppSettings {
        listener,
        ..RustAppSettings::default()
    };
    validate_settings(&settings).expect("the fixture must be a legal document");
}

/// The five deleted fields stay deleted. Each declared a decision another
/// mechanism already owns (`scale` → the display profile's ListenerGeometry;
/// `softPause`/`hardPause` → the stage `freeze` directive; `hideOnBlank` → the
/// `keepListener` flag on the stage `blank` directive; `crossfadeMs` → a stage
/// constant that reduced-motion and §61 degradation both vary).
///
/// `keepWhenBlanked` is NOT `hideOnBlank` under a new name, and the difference
/// is the one that mattered about the old field rather than its spelling: this
/// one has a reader. `toggleBlankStage` in src/control/stores/session.ts reads
/// it every time the stage is blanked and puts it on the directive, which is
/// still the single carrier of the decision. It is also stated in the direction
/// the directive states it, so nothing has to invert a persisted boolean —
/// inverting a persisted value is the one bug this feature has shipped.
#[test]
fn the_unreachable_listener_fields_are_gone_not_renamed() {
    let json = serde_json::to_value(RustListenerSettings::default()).expect("serializes");
    let object = json.as_object().expect("an object");
    for dead in [
        "opacityAfterDim",
        "scale",
        "crossfadeMs",
        "softPause",
        "hardPause",
        "hideOnBlank",
    ] {
        assert!(
            !object.contains_key(dead),
            "{dead} was declared and unreachable; it must not come back"
        );
    }
    let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "autoplay",
            "blurPx",
            "defaultPackId",
            "dimPercent",
            "keepWhenBlanked",
            "saturation"
        ]
    );
}

/// The ranges Rust enforces are the ranges the Preflight sliders offer. They
/// used to disagree in BOTH directions — `opacityAfterDim <= 0.75` rejected a
/// dim of 0, and `blurPx <= 12` rejected the top half of a slider that goes to
/// 24 — so a value the UI could produce was a value Rust would refuse to store.
#[test]
fn listener_ranges_accept_everything_the_sliders_offer_and_nothing_beyond() {
    for (dim, blur, saturation, legal) in [
        (0.0, 0.0, 0.0, true),
        (80.0, 24.0, 1.0, true),
        (40.0, 12.0, 0.85, true),
        (80.1, 0.0, 0.5, false),
        (-1.0, 0.0, 0.5, false),
        (40.0, 24.1, 0.5, false),
        (40.0, 0.0, 1.1, false),
    ] {
        let settings = RustAppSettings {
            listener: RustListenerSettings {
                dim_percent: dim,
                blur_px: blur,
                saturation,
                ..RustListenerSettings::default()
            },
            ..RustAppSettings::default()
        };
        assert_eq!(
            validate_settings(&settings).is_ok(),
            legal,
            "dim={dim} blur={blur} saturation={saturation}"
        );
    }
}

/// A document written before this section had these fields still loads: every
/// missing key falls to its default rather than failing the whole read.
#[test]
fn a_listener_section_from_an_older_document_still_loads() {
    let listener: RustListenerSettings =
        serde_json::from_value(serde_json::json!({})).expect("an empty section must load");
    assert_eq!(listener, RustListenerSettings::default());

    // Including one carrying only the fields that were deleted.
    let legacy: RustListenerSettings = serde_json::from_value(serde_json::json!({
        "opacityAfterDim": 0.22,
        "scale": 1.0,
        "crossfadeMs": 160,
        "softPause": "continue",
        "hardPause": "freeze",
        "hideOnBlank": true,
    }))
    .expect("a pre-reconciliation section must load");
    assert_eq!(legacy, RustListenerSettings::default());
}

// ---------------------------------------------------------------------------
// §28.4 Local voice-detection sensitivity — the round trip, not one half of it
// ---------------------------------------------------------------------------

use candidcue_lib::settings::AudioSettings as RustAudioSettings;

fn audio_settings_fixture() -> serde_json::Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tests")
        .join("fixtures")
        .join("ipc")
        .join("audio-settings-payload.json");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{} must exist: {e}", path.display()));
    serde_json::from_str(&raw).expect("fixture parses")
}

/// The round trip, closed on the Rust side: the patch the TypeScript adapter
/// emits deserializes into the struct, and the struct serializes back to the
/// identical document the adapter reads.
///
/// `vadSensitivity` is the field this test exists for. The slider was wired to
/// the VAD and to the Preflight meter and persisted in the frontend's
/// localStorage overlay ONLY — Rust declared no such field, so a mapping in one
/// direction was not even possible. The whole audio section is round-tripped
/// rather than the one key, so a patch that quietly dropped `language` or the
/// disconnect timeout fails here too.
#[test]
fn audio_settings_survive_the_round_trip_unchanged() {
    let f = audio_settings_fixture();
    let sent = f["settings"].clone();

    let audio: RustAudioSettings =
        serde_json::from_value(sent.clone()).expect("the frontend's audio patch must deserialize");
    let stored = serde_json::to_value(&audio).expect("serializes");

    assert_eq!(
        stored, sent,
        "an audio setting changed shape between the UI and the stored document"
    );

    // The value is the one that was sent, not a default that happens to
    // serialize to the same JSON — 0.5 is the A.6 neutral, so the fixture is
    // deliberately not 0.5.
    assert_eq!(audio.vad_sensitivity, 0.72);
    assert_ne!(audio.vad_sensitivity, RustAudioSettings::default().vad_sensitivity);
    assert_eq!(audio.soft_pause_auto_disconnect_minutes, 15);

    // And the whole document validates, so the round trip is not passing a
    // value the backend would reject on the next write.
    let settings = RustAppSettings {
        audio,
        ..RustAppSettings::default()
    };
    validate_settings(&settings).expect("the fixture must be a legal document");
}

/// The range Rust enforces is the range both sliders offer. The §37 Listener
/// ranges got this wrong in both directions once — a value the UI could produce
/// was a value Rust would refuse to store — so it is asserted at the ends.
#[test]
fn vad_sensitivity_range_accepts_the_whole_slider_and_nothing_beyond() {
    for (sensitivity, legal) in [
        (0.0, true),
        (0.5, true),
        (1.0, true),
        (1.0001, false),
        (-0.0001, false),
        (2.0, false),
    ] {
        let settings = RustAppSettings {
            audio: RustAudioSettings {
                vad_sensitivity: sensitivity,
                ..RustAudioSettings::default()
            },
            ..RustAppSettings::default()
        };
        assert_eq!(
            validate_settings(&settings).is_ok(),
            legal,
            "vadSensitivity={sensitivity}"
        );
    }
}

/// A document written before the field existed still loads, and lands on the
/// A.6 neutral rather than on an extreme — the same rule the frontend adapter
/// follows, because a missing setting must not become the most aggressive VAD
/// on offer.
#[test]
fn an_audio_section_without_a_sensitivity_loads_at_the_neutral_midpoint() {
    let audio: RustAudioSettings = serde_json::from_value(serde_json::json!({
        "transcriptionModel": "inworld/inworld-stt-1",
        "language": "en-US",
        "softPauseAutoDisconnectMinutes": 10,
    }))
    .expect("a pre-§28.4 section must load");
    assert_eq!(audio.vad_sensitivity, 0.5);
    assert_eq!(audio, RustAudioSettings::default());
}

// ---------------------------------------------------------------------------
// §46.4 — which key is in play, and the release build's inability to be told
// ---------------------------------------------------------------------------

use candidcue_lib::commands::inworld_cmds::InworldKeyStatus;
use candidcue_lib::secrets::{dev_env_key_active, KeySource, RedactedSecretMetadata,
    DEV_KEY_ENV_VAR};

fn key_status_fixture() -> serde_json::Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tests")
        .join("fixtures")
        .join("ipc")
        .join("inworld-key-status.json");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{} must exist: {e}", path.display()));
    serde_json::from_str(&raw).expect("fixture parses")
}

/// Two stores can hold a key in a development build and only one of them wins,
/// so the status has to name the winner. A payload that says `present: true`
/// and nothing else describes both worlds equally well and distinguishes
/// neither.
#[test]
fn key_status_serializes_the_source_to_the_frontend_shape() {
    let f = key_status_fixture();

    let keychain = InworldKeyStatus {
        present: true,
        hint: Some("sk-…7f2a".into()),
        source: KeySource::Keychain,
    };
    assert_eq!(
        serde_json::to_value(&keychain).expect("serializes"),
        f["expectedKeychainStatus"]
    );

    let environment = InworldKeyStatus {
        present: true,
        hint: Some("sk-…9c41".into()),
        source: KeySource::Environment,
    };
    assert_eq!(
        serde_json::to_value(&environment).expect("serializes"),
        f["expectedEnvironmentStatus"]
    );

    let absent = InworldKeyStatus {
        present: false,
        hint: None,
        source: KeySource::Absent,
    };
    let encoded = serde_json::to_value(&absent).expect("serializes");
    assert_eq!(encoded, f["expectedAbsentStatus"]);
    assert!(
        encoded.get("hint").is_none(),
        "an absent key must not carry an empty hint field"
    );
}

/// `save_openai_key` returns the same metadata `describe_openai_key` produces,
/// and the frontend feeds it straight into the status it displays — so it has
/// to carry the source too, or a save would blank out what a status read had
/// just established.
#[test]
fn saved_key_metadata_carries_the_source_as_well_as_the_hint() {
    let f = key_status_fixture();
    let metadata = RedactedSecretMetadata {
        hint: "sk-…7f2a".into(),
        source: KeySource::Keychain,
    };
    assert_eq!(
        serde_json::to_value(&metadata).expect("serializes"),
        f["expectedSavedMetadata"]
    );
}

/// Nothing that crosses this boundary may carry the key. The fixture is the
/// document both sides read, so it is the thing to police: every string in it
/// is either a four-character tail behind an ellipsis or a source name.
#[test]
fn no_key_status_payload_carries_anything_that_could_be_a_key() {
    let f = key_status_fixture();
    fn walk(value: &serde_json::Value) {
        match value {
            serde_json::Value::String(s) => assert!(
                !s.starts_with("sk-") || s.starts_with("sk-…"),
                "a status payload string looks like a real key: {s}"
            ),
            serde_json::Value::Array(items) => items.iter().for_each(walk),
            serde_json::Value::Object(map) => map.values().for_each(walk),
            _ => {}
        }
    }
    for name in [
        "expectedKeychainStatus",
        "expectedEnvironmentStatus",
        "expectedAbsentStatus",
        "expectedSavedMetadata",
    ] {
        walk(&f[name]);
    }
}

/// The gating itself, asserted against the source, because it is the whole
/// safety property: a release build must contain no environment read at all.
///
/// A future tidy-up that replaces the `cfg`-split pair with a runtime
/// `if cfg!(debug_assertions)` would leave every assertion elsewhere in this
/// file passing while compiling `env::var("OPENAI_API_KEY")` into the shipped
/// binary — this is the test that notices.
#[test]
fn the_environment_override_is_compiled_out_of_release_builds() {
    let source = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("secrets")
            .join("mod.rs"),
    )
    .expect("secrets/mod.rs");

    let (before, after) = source
        .split_once("#[cfg(debug_assertions)]")
        .expect("the override must be behind a cfg(debug_assertions) gate");
    assert!(
        !before.contains("env::var"),
        "the environment read must sit behind the debug gate, not above it"
    );
    assert!(
        after.contains("#[cfg(not(debug_assertions))]"),
        "the debug gate must have a release twin, or release builds would not \
         compile at all"
    );
    let release_twin = after
        .split_once("#[cfg(not(debug_assertions))]")
        .expect("release twin")
        .1;
    assert!(
        !release_twin.contains("env::var"),
        "the release twin must not read the environment"
    );
    assert!(
        !source.contains("if cfg!(debug_assertions)"),
        "a runtime cfg! branch compiles the environment read into the release \
         binary; the override must be a compile-time split"
    );
}

/// The debug half actually works, and an exported-but-empty variable does not
/// shadow the credential store with nothing. Both directions are asserted in one
/// test because they share process-wide state.
///
/// The Keychain is never touched here — `dev_env_key_active` only inspects the
/// environment and the checkout's `.env`, which is the point: settling the
/// question costs no ACL prompt.
///
/// Deliberately NOT asserted: that removing the variable makes the override
/// inactive. There is a second debug-only source — `.env` in the checkout, so a
/// developer who puts their key where every other tool in this stack looks for
/// it gets an app that can see it — and whether that file exists is a property
/// of the machine running the suite, not of the code. What IS the code's
/// business is that a *variable holding whitespace* never counts as a key, and
/// that a real one always does; both hold whichever way `.env` falls.
#[test]
fn the_debug_override_is_active_only_while_the_variable_holds_a_value() {
    let restore = std::env::var(DEV_KEY_ENV_VAR).ok();
    // The `.env` source, if this checkout has one, is the floor for every
    // assertion below: it is already active before the variable is touched.
    std::env::remove_var(DEV_KEY_ENV_VAR);
    let dotenv_supplies_a_key = dev_env_key_active();

    std::env::set_var(DEV_KEY_ENV_VAR, "   ");
    assert_eq!(
        dev_env_key_active(),
        dotenv_supplies_a_key,
        "a whitespace-only value is a shell accident, not a key, so it must \
         neither create an override nor cancel one"
    );

    std::env::set_var(DEV_KEY_ENV_VAR, "test-override");
    assert!(
        dev_env_key_active(),
        "cargo test builds with debug_assertions on, so the override must be live"
    );

    match restore {
        Some(value) => std::env::set_var(DEV_KEY_ENV_VAR, value),
        None => std::env::remove_var(DEV_KEY_ENV_VAR),
    }
}

/// A save performed while the override is set would be written and then
/// shadowed on every read — the status would show the tail of the key just
/// typed while a different key billed the account. The command refuses instead,
/// and it refuses BEFORE spending a network round trip on validation.
#[test]
fn save_refuses_under_the_override_before_it_validates_anything() {
    let source = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("commands")
            .join("inworld_cmds.rs"),
    )
    .expect("inworld_cmds.rs");
    let body = source
        .split_once("pub async fn save_inworld_key(")
        .expect("save_inworld_key")
        .1;
    let guard = body.find("dev_env_key_active()").expect(
        "save_inworld_key must refuse while the debug environment override is set, \
         or the save silently vanishes behind it",
    );
    let validate = body.find("validate_key").expect("save_openai_key validates");
    assert!(
        guard < validate,
        "the refusal must come before the network validation, not after it"
    );

    // Delete is deliberately NOT guarded: it clears the one store this app
    // owns, which is a real and complete effect, and the environment key that
    // survives is reported honestly as `source: \"environment\"`.
    let delete = source
        .split_once("pub async fn delete_inworld_key(")
        .expect("delete_inworld_key")
        .1;
    let delete_body = delete.split_once("\n}").expect("delete body").0;
    assert!(
        !delete_body.contains("dev_env_key_active"),
        "delete_inworld_key must still remove the stored key; refusing it would \
         leave the operator no way to clear the credential store at all"
    );
}
