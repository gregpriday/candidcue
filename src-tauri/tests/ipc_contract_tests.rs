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

/// The error codes Rust raises must exist on the TypeScript side.
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
    ] {
        assert!(
            ts.contains(&format!("'{code}'")),
            "{code} is raised by Rust but missing from src/shared/contracts/errors.ts"
        );
    }
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
// §28.4 Local voice-detection sensitivity — the round trip, not one half of it
// ---------------------------------------------------------------------------

use candidcue_lib::settings::{
    validate as validate_settings, AppSettings as RustAppSettings,
    AudioSettings as RustAudioSettings,
};

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

/// The range Rust enforces is the range the slider offers. A retired settings
/// group got this wrong in both directions once — a value the UI could produce
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
        "transcriptionModel": "streaming-zipformer-en-20M-int8",
        "language": "en-US",
        "softPauseAutoDisconnectMinutes": 10,
    }))
    .expect("a pre-§28.4 section must load");
    assert_eq!(audio.vad_sensitivity, 0.5);
    assert_eq!(audio, RustAudioSettings::default());
}

