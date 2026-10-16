//! Integration tests for the Rust core: scripts repository lifecycle,
//! settings roundtrip, and import/export.

use std::fs;

use candidcue_lib::scripts::{
    import_export::{self, ExportOptions, ImportOptions},
    repo, CreateScriptInput, DataPaths, PageRequest, ScriptFilter, ScriptId, ScriptLocks,
    ScriptMetadataPatch, ScriptStatus,
};
use candidcue_lib::settings;

struct Harness {
    _dir: tempfile::TempDir,
    pool: sqlx::SqlitePool,
    paths: DataPaths,
    locks: ScriptLocks,
}

async fn harness() -> Harness {
    let dir = tempfile::tempdir().expect("tempdir");
    let pool = candidcue_lib::database::init(dir.path())
        .await
        .expect("database init + migrations");
    let paths = DataPaths::new(dir.path().to_path_buf());
    Harness {
        paths,
        pool,
        locks: ScriptLocks::default(),
        _dir: dir,
    }
}

fn sid(raw: &str) -> ScriptId {
    ScriptId::parse(raw).expect("summary ids are always canonical UUIDs")
}

fn create_input(title: &str, source: &str) -> CreateScriptInput {
    serde_json::from_value(serde_json::json!({ "title": title, "source": source }))
        .expect("create input")
}

// ---------------------------------------------------------------------------
// Scripts repository
// ---------------------------------------------------------------------------

#[tokio::test]
async fn create_save_revision_trash_lifecycle() {
    let h = harness().await;

    // Create writes the canonical file and DB row.
    let summary = repo::create_script(
        &h.pool,
        &h.paths,
        create_input("Launch video", "Hello world from CandidCue today."),
    )
    .await
    .expect("create");
    assert_eq!(summary.title, "Launch video");
    assert_eq!(summary.spoken_word_count, 5);
    let script_id = sid(&summary.id);
    let canonical = h.paths.canonical_file(&script_id);
    assert!(canonical.exists());

    // First save at revision 1 → revision 2, snapshot created (first ever).
    let save = repo::save_script(
        &h.pool,
        &h.paths,
        &h.locks,
        &script_id,
        1,
        "Hello world from CandidCue today. Now longer.".into(),
        ScriptMetadataPatch::default(),
    )
    .await
    .expect("save");
    assert_eq!(save.script_revision, 2);
    assert!(save.revision_created);
    assert!(save.revision_id.is_some());
    assert_eq!(
        fs::read_to_string(&canonical).unwrap(),
        "Hello world from CandidCue today. Now longer."
    );

    // Stale expected revision → SCRIPT_CONFLICT.
    let stale = repo::save_script(
        &h.pool,
        &h.paths,
        &h.locks,
        &script_id,
        1,
        "conflicting".into(),
        ScriptMetadataPatch::default(),
    )
    .await
    .expect_err("stale save must fail");
    assert_eq!(stale.code(), "SCRIPT_CONFLICT");

    // A quick second save within the 5-minute window: no new snapshot.
    let save2 = repo::save_script(
        &h.pool,
        &h.paths,
        &h.locks,
        &script_id,
        2,
        "Hello world, third body.".into(),
        ScriptMetadataPatch::default(),
    )
    .await
    .expect("save 2");
    assert_eq!(save2.script_revision, 3);
    assert!(!save2.revision_created);

    // Forced revision reason bypasses the cadence.
    let save3 = repo::save_script(
        &h.pool,
        &h.paths,
        &h.locks,
        &script_id,
        3,
        "Hello world, fourth body.".into(),
        serde_json::from_value::<ScriptMetadataPatch>(
            serde_json::json!({ "revisionReason": "pre_session" }),
        )
        .unwrap(),
    )
    .await
    .expect("save 3");
    assert!(save3.revision_created);

    let revisions = repo::list_revisions(&h.pool, &script_id).await.expect("list revisions");
    assert_eq!(revisions.len(), 2);

    // Revision content roundtrip + restore-as-current. A revision holds the
    // text the save DESTROYED (its preimage), never the replacement (H2), so
    // the first revision is the body the script was created with.
    let first_revision = revisions.last().unwrap();
    let doc = repo::get_revision(&h.pool, &h.paths, &script_id, &first_revision.id)
        .await
        .expect("get revision");
    assert_eq!(doc.source, "Hello world from CandidCue today.");

    let restored = repo::restore_revision(
        &h.pool,
        &h.paths,
        &h.locks,
        &script_id,
        &first_revision.id,
        save3.script_revision,
    )
    .await
    .expect("restore revision");
    assert_eq!(
        fs::read_to_string(&canonical).unwrap(),
        "Hello world from CandidCue today."
    );
    assert!(restored.script_revision > save3.script_revision);
    // The restore itself is a destructive edit, so the body it replaced is
    // now recoverable too.
    let after_restore = repo::list_revisions(&h.pool, &script_id).await.unwrap();
    let newest = after_restore.first().unwrap();
    assert_eq!(newest.reason, "before_restore");
    let preserved = repo::get_revision(&h.pool, &h.paths, &script_id, &newest.id)
        .await
        .unwrap();
    assert_eq!(preserved.source, "Hello world, fourth body.");

    // Trash → hidden from default listing; restore → back.
    let trashed_state = repo::trash_script(&h.pool, &h.locks, &script_id, restored.script_revision)
        .await
        .expect("trash");
    let listed = repo::list_scripts(&h.pool, ScriptFilter::default(), None, PageRequest::default())
        .await
        .expect("list");
    assert_eq!(listed.total, 0);
    let trashed = repo::list_scripts(
        &h.pool,
        ScriptFilter {
            status: Some(ScriptStatus::Trash),
            ..Default::default()
        },
        None,
        PageRequest::default(),
    )
    .await
    .expect("list trash");
    assert_eq!(trashed.total, 1);
    let restored_state = repo::restore_script(
        &h.pool,
        &h.locks,
        &script_id,
        trashed_state.script_revision,
    )
    .await
    .expect("restore");

    // Duplicate copies source under a new id.
    let copy = repo::duplicate_script(&h.pool, &h.paths, &h.locks, &script_id)
        .await
        .expect("duplicate");
    assert_ne!(copy.id, summary.id);
    assert!(copy.title.ends_with("copy"));
    assert!(h.paths.canonical_file(&sid(&copy.id)).exists());

    // Permanent deletion is only reachable from the trash (spec §21.5).
    let live = repo::permanently_delete_script(&h.pool, &h.paths, &h.locks, &script_id).await;
    assert!(live.is_err(), "a live script must never be deleted permanently");
    assert!(h.paths.script_dir(&script_id).exists());

    let trashed_again =
        repo::trash_script(&h.pool, &h.locks, &script_id, restored_state.script_revision)
            .await
            .expect("trash again");
    assert_eq!(trashed_again.status, ScriptStatus::Trash);
    repo::permanently_delete_script(&h.pool, &h.paths, &h.locks, &script_id)
        .await
        .expect("purge");
    assert!(!h.paths.script_dir(&script_id).exists());
    assert!(repo::get_summary(&h.pool, &script_id).await.is_err());
}

#[tokio::test]
async fn external_change_is_adopted_on_read_and_blocks_blind_save() {
    let h = harness().await;
    let summary = repo::create_script(&h.pool, &h.paths, create_input("Ext", "Original body text."))
        .await
        .expect("create");
    let script_id = sid(&summary.id);
    let canonical = h.paths.canonical_file(&script_id);

    // Simulate an external editor.
    fs::write(&canonical, "Edited outside CandidCue.").unwrap();

    // Saving over it with a stale in-memory copy is refused (spec §21.3).
    let err = repo::save_script(
        &h.pool,
        &h.paths,
        &h.locks,
        &script_id,
        1,
        "In-app buffer".into(),
        ScriptMetadataPatch::default(),
    )
    .await
    .expect_err("external change must block save");
    assert_eq!(err.code(), "SCRIPT_CONFLICT");

    // Reading adopts the file (authority) and flags the change.
    let doc = repo::get_script(&h.pool, &h.paths, &h.locks, &script_id)
        .await
        .expect("get");
    assert!(doc.externally_changed);
    assert_eq!(doc.source, "Edited outside CandidCue.");
    assert!(doc.summary.script_revision > 1);

    // After adoption, saving with the new revision works again.
    let save = repo::save_script(
        &h.pool,
        &h.paths,
        &h.locks,
        &script_id,
        doc.summary.script_revision,
        "Post-adoption save.".into(),
        ScriptMetadataPatch::default(),
    )
    .await
    .expect("save after adoption");
    assert_eq!(save.script_revision, doc.summary.script_revision + 1);
}

#[tokio::test]
async fn search_and_pagination() {
    let h = harness().await;
    for index in 0..5 {
        repo::create_script(
            &h.pool,
            &h.paths,
            create_input(
                &format!("Video {index}"),
                &format!("Body number {index} about zebras."),
            ),
        )
        .await
        .expect("create");
    }
    repo::create_script(&h.pool, &h.paths, create_input("Recipe", "Cooking with quinoa."))
        .await
        .expect("create recipe");

    let all = repo::list_scripts(&h.pool, ScriptFilter::default(), None, PageRequest::default())
        .await
        .unwrap();
    assert_eq!(all.total, 6);

    let page = repo::list_scripts(
        &h.pool,
        ScriptFilter::default(),
        None,
        serde_json::from_value(serde_json::json!({ "page": 1, "pageSize": 4 })).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(page.items.len(), 2);

    let zebra = repo::list_scripts(
        &h.pool,
        ScriptFilter {
            query: Some("zebras".into()),
            ..Default::default()
        },
        None,
        PageRequest::default(),
    )
    .await
    .unwrap();
    assert_eq!(zebra.total, 5);
}

/// C7: every sort key the library offers must reorder the result. All four of
/// them used to fall through to `updated_at DESC`, because the only arms Rust
/// implemented — `title_asc` and `opened_desc` — are names no caller sends.
///
/// This test fails if the arms are reverted: `name` would return creation
/// order rather than alphabetical order.
#[tokio::test]
async fn every_library_sort_key_actually_orders_the_result() {
    let h = harness().await;
    // Created in an order that is neither alphabetical nor length-ordered.
    for (title, body) in [
        ("Middle", "one two three four five six"),
        ("Alpha", "one two"),
        ("Zulu", "one two three four five six seven eight nine ten eleven"),
    ] {
        repo::create_script(&h.pool, &h.paths, create_input(title, body))
            .await
            .expect("create");
    }

    let titles = |page: &candidcue_lib::scripts::ScriptPage| -> Vec<String> {
        page.items.iter().map(|s| s.title.clone()).collect()
    };

    let by_name = repo::list_scripts(
        &h.pool,
        ScriptFilter::default(),
        Some("name".into()),
        PageRequest::default(),
    )
    .await
    .expect("sort by name");
    assert_eq!(titles(&by_name), vec!["Alpha", "Middle", "Zulu"]);

    let by_length = repo::list_scripts(
        &h.pool,
        ScriptFilter::default(),
        Some("estimated_length".into()),
        PageRequest::default(),
    )
    .await
    .expect("sort by estimated length");
    assert_eq!(titles(&by_length).first().map(String::as_str), Some("Zulu"));
    assert_eq!(titles(&by_length).last().map(String::as_str), Some("Alpha"));

    for key in ["recently_edited", "created", "last_opened"] {
        repo::list_scripts(
            &h.pool,
            ScriptFilter::default(),
            Some(key.into()),
            PageRequest::default(),
        )
        .await
        .unwrap_or_else(|e| panic!("{key} must be a sort Rust understands: {e}"));
    }

    // The fallback is LOUD. A key nobody implements is an error, not a silent
    // `updated_at DESC` that makes the sort control look broken.
    let unknown = repo::list_scripts(
        &h.pool,
        ScriptFilter::default(),
        Some("title_asc".into()),
        PageRequest::default(),
    )
    .await;
    assert!(
        unknown.is_err(),
        "an unrecognised sort key must fail, not silently default"
    );
}

/// C3: the Trash view and the Recent view must actually select what they name.
#[tokio::test]
async fn trash_and_recent_views_select_the_right_scripts() {
    let h = harness().await;
    let live = repo::create_script(&h.pool, &h.paths, create_input("Live", "Still here."))
        .await
        .expect("create live");
    let doomed = repo::create_script(&h.pool, &h.paths, create_input("Doomed", "On its way out."))
        .await
        .expect("create doomed");
    let doomed_id = sid(&doomed.id);
    repo::trash_script(&h.pool, &h.locks, &doomed_id, doomed.script_revision)
        .await
        .expect("trash");

    let trash = repo::list_scripts(
        &h.pool,
        ScriptFilter {
            status: Some(ScriptStatus::Trash),
            ..Default::default()
        },
        None,
        PageRequest::default(),
    )
    .await
    .expect("list trash");
    assert_eq!(trash.total, 1);
    assert_eq!(trash.items[0].id, doomed.id);

    // Recent: nothing has been opened yet, so the view is empty even though
    // one live script exists.
    let recent_before = repo::list_scripts(
        &h.pool,
        ScriptFilter {
            opened_only: true,
            ..Default::default()
        },
        Some("last_opened".into()),
        PageRequest::default(),
    )
    .await
    .expect("list recent");
    assert_eq!(recent_before.total, 0);

    repo::get_script(&h.pool, &h.paths, &h.locks, &sid(&live.id))
        .await
        .expect("open");
    let recent_after = repo::list_scripts(
        &h.pool,
        ScriptFilter {
            opened_only: true,
            ..Default::default()
        },
        Some("last_opened".into()),
        PageRequest::default(),
    )
    .await
    .expect("list recent");
    assert_eq!(recent_after.total, 1);
    assert_eq!(recent_after.items[0].id, live.id);
}

/// C6: "Clear logs" must clear the LOGS. It mapped onto the `all` cache kind,
/// which empties four caches and touches nothing in `logs/`, while the toast
/// said "Logs cleared."
///
/// Reverting the `logs` arm makes the first assertion fail outright (unknown
/// kind); reverting it to an alias for `all` makes the second fail.
#[tokio::test]
async fn clearing_logs_targets_the_log_directory_and_no_cache() {
    let h = harness().await;
    let logs = candidcue_lib::commands::settings_cmds::clear_cache_targets(&h.paths, "logs")
        .expect("`logs` must be a kind clear_cache understands");
    assert_eq!(logs, vec![h.paths.logs_dir()]);

    let all = candidcue_lib::commands::settings_cmds::clear_cache_targets(&h.paths, "all")
        .expect("`all` targets");
    assert!(
        !all.contains(&h.paths.logs_dir()),
        "logs are not a cache and must not be swept up by `all`"
    );
    assert!(all.iter().all(|d| d.starts_with(h.paths.cache_dir())));

    assert!(
        candidcue_lib::commands::settings_cmds::clear_cache_targets(&h.paths, "everything")
            .is_err(),
        "an unknown kind must be rejected, not silently mapped onto something"
    );
}

/// §179: the support bundle has to actually carry the logs.
///
/// This asserts the JOIN, not the copier. `diagnostics::logging` has its own
/// tests proving it copies the right files given a directory — but every one of
/// them passed while `export_support_bundle` did not call it at all, which is
/// the state this issue was filed about. Deleting the `copy_support_logs` call
/// from `write_support_bundle` fails here and nowhere else.
///
/// It goes through `write_support_bundle` rather than the command because the
/// command opens a native folder picker: there is no deterministic way to drive
/// it, which is precisely how the omission survived.
#[tokio::test]
async fn a_support_bundle_carries_the_logs_and_not_just_the_facts() {
    let h = harness().await;
    let bundle = tempfile::tempdir().expect("bundle dir");

    fs::create_dir_all(h.paths.logs_dir()).expect("logs dir");
    fs::create_dir_all(h.paths.diagnostics_dir()).expect("diagnostics dir");
    fs::write(
        h.paths.logs_dir().join("client-trace.log"),
        "the run in front of you\n",
    )
    .expect("live trace");
    fs::write(
        h.paths.logs_dir().join("client-trace.prev.log"),
        "the run that crashed\n",
    )
    .expect("previous trace");
    fs::write(
        h.paths.logs_dir().join("candidcue-rust.2026-08-03.log"),
        "a warning nobody could read before\n",
    )
    .expect("rust log");
    fs::write(
        h.paths.diagnostics_dir().join("recovery.json"),
        "{\"kind\":\"startup_reconciliation\"}",
    )
    .expect("report");

    let diagnostics = candidcue_lib::commands::settings_cmds::SystemDiagnostics {
        app_version: "0.1.0".into(),
        os: "macos".into(),
        arch: "aarch64".into(),
        database_integrity_ok: true,
        script_count: 0,
        session_count: 0,
        data_dir: h.paths.root().to_string_lossy().to_string(),
    };
    candidcue_lib::commands::settings_cmds::write_support_bundle(
        &h.paths,
        bundle.path(),
        &diagnostics,
    )
    .expect("bundle written");

    // What the bundle always had.
    assert!(bundle.path().join("diagnostics.json").is_file());
    assert!(bundle.path().join("recovery.json").is_file());

    // What it was missing, which is the only reason anyone exports one.
    let logs = bundle.path().join("logs");
    assert_eq!(
        fs::read_to_string(logs.join("client-trace.log")).expect("live trace in bundle"),
        "the run in front of you\n"
    );
    assert_eq!(
        fs::read_to_string(logs.join("client-trace.prev.log")).expect("previous trace in bundle"),
        "the run that crashed\n",
        "a crash plus a relaunch must still reach whoever is debugging it"
    );
    assert_eq!(
        fs::read_to_string(logs.join("candidcue-rust.2026-08-03.log")).expect("rust log in bundle"),
        "a warning nobody could read before\n"
    );
}

// The "Clear logs" behaviour that goes with the above lives in
// `ipc_roundtrip_tests::clearing_logs_through_the_command_keeps_the_open_log_writable`,
// which drives the actual command. A version of it here called `clear_logs`
// directly and claimed to guard the routing in `clear_cache` — it did not, and
// a test whose docstring overstates what it covers is worse than no test.

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[tokio::test]
async fn settings_defaults_patch_and_conflict() {
    let h = harness().await;

    let initial = settings::get_settings(&h.pool).await.expect("defaults");
    assert_eq!(initial.revision, 1);
    assert_eq!(initial.value.general.words_per_minute_estimate, 130);
    assert_eq!(initial.value.general.save_transcript, "off");
    assert_eq!(
        initial.value.audio.transcription_model,
        candidcue_lib::speech::default_model().id
    );

    // Patch a nested field; others survive.
    let updated = settings::update_settings(
        &h.pool,
        1,
        serde_json::json!({ "general": { "wordsPerMinuteEstimate": 150 } }),
    )
    .await
    .expect("update");
    assert_eq!(updated.revision, 2);
    assert_eq!(updated.value.general.words_per_minute_estimate, 150);
    assert_eq!(updated.value.editor.font_size_px, 15);

    // Persistence roundtrip.
    let reloaded = settings::get_settings(&h.pool).await.unwrap();
    assert_eq!(reloaded.revision, 2);
    assert_eq!(reloaded.value.general.words_per_minute_estimate, 150);

    // Stale revision → conflict.
    let stale = settings::update_settings(&h.pool, 1, serde_json::json!({}))
        .await
        .expect_err("stale settings update");
    assert_eq!(stale.code(), "SCRIPT_CONFLICT");

    // Out-of-range value → validation error, nothing stored.
    let invalid = settings::update_settings(
        &h.pool,
        2,
        serde_json::json!({ "general": { "wordsPerMinuteEstimate": 1000 } }),
    )
    .await
    .expect_err("range validation");
    assert_eq!(invalid.code(), "VALIDATION_FAILED");
    assert_eq!(
        settings::get_settings(&h.pool).await.unwrap().value.general.words_per_minute_estimate,
        150
    );
}

// ---------------------------------------------------------------------------
// Import / export
// ---------------------------------------------------------------------------

#[tokio::test]
async fn import_markdown_and_bundle_roundtrip() {
    let h = harness().await;
    let external = tempfile::tempdir().unwrap();

    // Markdown import copies into managed storage and snapshots a revision.
    let md_path = external.path().join("My Talk.md");
    fs::write(&md_path, "# Talk\n\nSpoken body here.\n").unwrap();
    let imported = import_export::import_script(
        &h.pool,
        &h.paths,
        &h.locks,
        ImportOptions {
            path: md_path.to_string_lossy().to_string(),
            title: None,
        },
    )
    .await
    .expect("md import");
    assert_eq!(imported.script.title, "My Talk");
    let revisions = repo::list_revisions(&h.pool, &sid(&imported.script.id)).await.unwrap();
    assert_eq!(revisions.len(), 1);
    assert_eq!(revisions[0].reason, "import");

    // Bundle export → re-import roundtrip.
    let bundle_path = external.path().join("talk.candidcue");
    let exported = import_export::export_script(
        &h.pool,
        &h.paths,
        &h.locks,
        &sid(&imported.script.id),
        ExportOptions {
            destination: bundle_path.to_string_lossy().to_string(),
            format: "bundle".into(),
            include_assets: true,
        },
    )
    .await
    .expect("bundle export");
    assert!(std::path::Path::new(&exported.path).exists());

    let reimported = import_export::import_script(
        &h.pool,
        &h.paths,
        &h.locks,
        ImportOptions {
            path: exported.path.clone(),
            title: None,
        },
    )
    .await
    .expect("bundle import");
    assert_eq!(reimported.script.title, "My Talk");
    let source = fs::read_to_string(h.paths.canonical_file(&sid(&reimported.script.id))).unwrap();
    assert_eq!(source, "# Talk\n\nSpoken body here.\n");

    // Unknown extension refused.
    let bad = external.path().join("script.exe");
    fs::write(&bad, "nope").unwrap();
    let err = import_export::import_script(
        &h.pool,
        &h.paths,
        &h.locks,
        ImportOptions {
            path: bad.to_string_lossy().to_string(),
            title: None,
        },
    )
    .await
    .expect_err("exe refused");
    assert_eq!(err.code(), "IMPORT_INVALID_FORMAT");

    // Markdown export.
    let md_out = external.path().join("out.md");
    import_export::export_script(
        &h.pool,
        &h.paths,
        &h.locks,
        &sid(&imported.script.id),
        ExportOptions {
            destination: md_out.to_string_lossy().to_string(),
            format: "markdown".into(),
            include_assets: false,
        },
    )
    .await
    .expect("markdown export");
    assert_eq!(
        fs::read_to_string(&md_out).unwrap(),
        "# Talk\n\nSpoken body here.\n"
    );
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

#[tokio::test]
async fn session_records_and_transcript_gating() {
    use candidcue_lib::sessions;

    let h = harness().await;
    let script = repo::create_script(&h.pool, &h.paths, create_input("S", "Body words here."))
        .await
        .unwrap();

    let input: sessions::StartSessionInput = serde_json::from_value(serde_json::json!({
        "scriptId": script.id,
        "scriptSourceHash": "abc",
        "mode": "voice",
        "startTokenIndex": 0,
    }))
    .unwrap();

    // Retention off → transcript writes refused.
    let record = sessions::start_session(&h.pool, &input, false).await.unwrap();
    assert!(!record.transcript_retained);
    let items: Vec<sessions::TranscriptItemInput> = serde_json::from_value(serde_json::json!([
        { "commitSequence": 1, "transcript": "hello", "disposition": "script" }
    ]))
    .unwrap();
    let err = sessions::append_transcript_items(&h.pool, &record.id, items.clone())
        .await
        .expect_err("gated");
    assert_eq!(err.code(), "VALIDATION_FAILED");

    // Retention on → items stored; end_session fills aggregates.
    let record2 = sessions::start_session(&h.pool, &input, true).await.unwrap();
    let stored = sessions::append_transcript_items(&h.pool, &record2.id, items)
        .await
        .unwrap();
    assert_eq!(stored, 1);
    let ended = sessions::end_session(
        &h.pool,
        &record2.id,
        serde_json::from_value(serde_json::json!({ "commandCount": 3, "endTokenIndex": 42 }))
            .unwrap(),
    )
    .await
    .unwrap();
    assert!(ended.ended_at.is_some());
    assert_eq!(ended.command_count, 3);
    assert_eq!(ended.end_token_index, Some(42));

    let listed = sessions::list_sessions(&h.pool, Some(script.id.clone()), 10)
        .await
        .unwrap();
    assert_eq!(listed.len(), 2);
}

// ---------------------------------------------------------------------------
// Permanently deleting a script that has been presented (#216)
// ---------------------------------------------------------------------------

/// The history one presented take leaves: a session with retained
/// transcripts, one take and one transcript item. Returns the session id.
async fn present_once(h: &Harness, script_id: &str) -> String {
    use candidcue_lib::sessions;

    let input: sessions::StartSessionInput = serde_json::from_value(serde_json::json!({
        "scriptId": script_id,
        "scriptSourceHash": "abc",
        "mode": "voice",
        "startTokenIndex": 0,
    }))
    .unwrap();
    let session = sessions::start_session(&h.pool, &input, true).await.unwrap();
    let take: sessions::SessionTakeInput = serde_json::from_value(serde_json::json!({
        "takePassId": "pass-1",
        "passOrdinal": 1,
        "startedAt": "2026-07-25T09:00:00.000Z",
    }))
    .unwrap();
    sessions::record_take(&h.pool, &session.id, take).await.unwrap();
    let items: Vec<sessions::TranscriptItemInput> = serde_json::from_value(serde_json::json!([
        { "commitSequence": 1, "transcript": "hello", "disposition": "script" }
    ]))
    .unwrap();
    sessions::append_transcript_items(&h.pool, &session.id, items)
        .await
        .unwrap();
    sessions::end_session(
        &h.pool,
        &session.id,
        serde_json::from_value(serde_json::json!({ "endTokenIndex": 3 })).unwrap(),
    )
    .await
    .unwrap();
    session.id
}

/// (session rows, takes, transcript items) for one session id. Counted by
/// session id rather than through `sessions`, so an orphaned take could not
/// hide behind its deleted parent.
async fn session_history(pool: &sqlx::SqlitePool, session_id: &str) -> (i64, i64, i64) {
    let count = |sql: &'static str| async move {
        sqlx::query_scalar::<_, i64>(sql)
            .bind(session_id)
            .fetch_one(pool)
            .await
            .unwrap()
    };
    (
        count("SELECT count(*) FROM sessions WHERE id = ?").await,
        count("SELECT count(*) FROM session_takes WHERE session_id = ?").await,
        count("SELECT count(*) FROM session_transcript_items WHERE session_id = ?").await,
    )
}

/// Make deleting one script's row fail inside the permanent-delete
/// transaction — after its sessions have already been deleted — so the
/// rollback is what the test sees.
async fn block_row_delete(pool: &sqlx::SqlitePool, script_id: &ScriptId) {
    sqlx::query(&format!(
        "CREATE TRIGGER block_script_delete BEFORE DELETE ON scripts
         WHEN OLD.id = '{}'
         BEGIN SELECT RAISE(ABORT, 'blocked by test'); END",
        script_id.as_str()
    ))
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn a_presented_script_deletes_permanently_with_its_history_and_nothing_else() {
    let h = harness().await;
    let doomed = repo::create_script(&h.pool, &h.paths, create_input("Presented", "Said aloud."))
        .await
        .unwrap();
    let survivor = repo::create_script(&h.pool, &h.paths, create_input("Kept", "Said again."))
        .await
        .unwrap();
    let doomed_session = present_once(&h, &doomed.id).await;
    let survivor_session = present_once(&h, &survivor.id).await;

    let doomed_id = sid(&doomed.id);
    repo::trash_script(&h.pool, &h.locks, &doomed_id, doomed.script_revision)
        .await
        .expect("trash");
    // Trash on its own keeps the history: Restore must bring the takes back.
    assert_eq!(session_history(&h.pool, &doomed_session).await, (1, 1, 1));

    repo::permanently_delete_script(&h.pool, &h.paths, &h.locks, &doomed_id)
        .await
        .expect("a presented script must delete permanently");
    assert!(repo::get_summary(&h.pool, &doomed_id).await.is_err());
    assert!(!h.paths.script_dir(&doomed_id).exists());
    assert_eq!(session_history(&h.pool, &doomed_session).await, (0, 0, 0));

    // "Start where the last take ended" reads the other script's sessions.
    assert_eq!(session_history(&h.pool, &survivor_session).await, (1, 1, 1));
    assert_eq!(
        fs::read_to_string(h.paths.canonical_file(&sid(&survivor.id))).unwrap(),
        "Said again."
    );
    let listed = candidcue_lib::sessions::list_sessions(&h.pool, Some(survivor.id.clone()), 10)
        .await
        .unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].end_token_index, Some(3));
}

#[tokio::test]
async fn a_failed_permanent_delete_keeps_the_history_and_the_folder() {
    let h = harness().await;
    let doomed = repo::create_script(&h.pool, &h.paths, create_input("Stuck", "Cannot go."))
        .await
        .unwrap();
    let session = present_once(&h, &doomed.id).await;
    let doomed_id = sid(&doomed.id);
    repo::trash_script(&h.pool, &h.locks, &doomed_id, doomed.script_revision)
        .await
        .expect("trash");
    block_row_delete(&h.pool, &doomed_id).await;

    let err = repo::permanently_delete_script(&h.pool, &h.paths, &h.locks, &doomed_id)
        .await
        .expect_err("the blocked delete fails");
    // Failing anywhere earlier (the quarantine rename, say) would leave the
    // history alone without the rollback ever being exercised.
    assert!(
        format!("{err:?}").contains("blocked by test"),
        "the delete must fail at the injected trigger, got: {err:?}"
    );
    assert_eq!(
        repo::get_summary(&h.pool, &doomed_id).await.unwrap().status,
        ScriptStatus::Trash
    );
    // The session delete ran in the same transaction, so it rolled back too.
    assert_eq!(session_history(&h.pool, &session).await, (1, 1, 1));
    assert_eq!(
        fs::read_to_string(h.paths.canonical_file(&doomed_id)).unwrap(),
        "Cannot go."
    );
}

#[tokio::test]
async fn expired_trash_purge_deletes_presented_scripts_and_skips_one_that_fails() {
    let h = harness().await;
    let mut ids = Vec::new();
    for title in ["Presented", "Never presented", "Blocked", "Trashed today"] {
        let summary = repo::create_script(&h.pool, &h.paths, create_input(title, "Some words."))
            .await
            .unwrap();
        let id = sid(&summary.id);
        if title != "Never presented" {
            present_once(&h, &summary.id).await;
        }
        repo::trash_script(&h.pool, &h.locks, &id, summary.script_revision)
            .await
            .expect("trash");
        ids.push(id);
    }
    let [presented, never_presented, blocked, recent] = <[ScriptId; 4]>::try_from(ids).unwrap();
    // The blocked script expired first, so the purge — oldest first — reaches
    // it before the two behind it.
    for (id, trashed_at) in [
        (&blocked, "2019-01-01T00:00:00.000Z"),
        (&presented, "2020-01-01T00:00:00.000Z"),
        (&never_presented, "2020-01-01T00:00:00.000Z"),
    ] {
        sqlx::query("UPDATE scripts SET trashed_at = ? WHERE id = ?")
            .bind(trashed_at)
            .bind(id.as_str())
            .execute(&h.pool)
            .await
            .unwrap();
    }
    block_row_delete(&h.pool, &blocked).await;

    let purged = repo::purge_expired_trash(&h.pool, &h.paths, &h.locks)
        .await
        .expect("purge");
    assert_eq!(purged, 2);
    assert!(repo::get_summary(&h.pool, &presented).await.is_err());
    assert!(repo::get_summary(&h.pool, &never_presented).await.is_err());
    for kept in [&blocked, &recent] {
        assert_eq!(
            repo::get_summary(&h.pool, kept).await.unwrap().status,
            ScriptStatus::Trash
        );
    }
}

// ---------------------------------------------------------------------------
// Startup reconciliation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn reconciliation_recovers_orphans_and_missing_files() {
    use candidcue_lib::scripts::reconcile;

    let h = harness().await;

    // Orphan: canonical file on disk with no DB row.
    let orphan_id = "0a651b8e-3a54-4a7e-bb6d-000000000001";
    let orphan = sid(orphan_id);
    fs::create_dir_all(h.paths.script_dir(&orphan)).unwrap();
    fs::write(h.paths.canonical_file(&orphan), "Orphan body.").unwrap();

    // Missing file: DB row whose canonical file vanished, with a revision.
    let victim = repo::create_script(&h.pool, &h.paths, create_input("Victim", "Original."))
        .await
        .unwrap();
    repo::save_script(
        &h.pool,
        &h.paths,
        &h.locks,
        &sid(&victim.id),
        1,
        "Recoverable content.".into(),
        ScriptMetadataPatch::default(),
    )
    .await
    .unwrap();
    fs::remove_file(h.paths.canonical_file(&sid(&victim.id))).unwrap();

    let report = reconcile::run_startup_reconciliation(&h.pool, &h.paths, &h.locks)
        .await
        .expect("reconciliation");
    assert!(report.integrity_ok);
    assert!(report.orphan_files_recovered.contains(&orphan_id.to_string()));
    assert!(report.missing_files_restored.contains(&victim.id));
    // Revisions hold preimages (H2), so the newest recoverable text after the
    // canonical file is destroyed is the body the last save replaced.
    assert_eq!(
        fs::read_to_string(h.paths.canonical_file(&sid(&victim.id))).unwrap(),
        "Original."
    );
    // ...and the Library describes the restored text, not the lost one: the
    // row still counted "Recoverable content." until the restore cleared its
    // stats stamp and the refresh re-derived it.
    let listed = repo::list_scripts(&h.pool, ScriptFilter::default(), None, PageRequest::default())
        .await
        .unwrap();
    let restored = listed.items.iter().find(|s| s.id == victim.id).expect("victim listed");
    assert_eq!(restored.spoken_word_count, 1);
    assert_eq!(restored.preview_text, "Original.");
}

/// #249: a library indexed by an older spoken-word extraction is re-derived at
/// startup — count, duration, preview and search text — and the refresh is not
/// mistaken for an edit: revision and timestamps stay put, so neither the
/// library's order nor a pending compare-and-swap save notices it happened.
#[tokio::test]
async fn reconciliation_rederives_stale_library_stats_without_editing_the_script() {
    use candidcue_lib::scripts::{reconcile, words::SPOKEN_STATS_VERSION};

    let h = harness().await;
    let source = "<!-- TODO: cut this line before Friday -->\n\nWelcome back. [Cue: smile at camera] Let's go.\n";
    let created = repo::create_script(&h.pool, &h.paths, create_input("Stale", source))
        .await
        .unwrap();
    assert_eq!(created.spoken_word_count, 4);
    assert_eq!(created.preview_text, "Welcome back. Let's go.");
    let version = |pool: sqlx::SqlitePool, id: String| async move {
        sqlx::query_scalar::<_, Option<String>>("SELECT last_compile_version FROM scripts WHERE id = ?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap()
    };
    assert_eq!(
        version(h.pool.clone(), created.id.clone()).await.as_deref(),
        Some(SPOKEN_STATS_VERSION),
        "a freshly derived row is stamped, or every startup would re-derive it"
    );

    // What the old line scanner stored for this script, with no stamp.
    sqlx::query(
        "UPDATE scripts SET spoken_word_count = 17, estimated_duration_seconds = 8,
             last_compile_version = NULL
         WHERE id = ?",
    )
    .bind(&created.id)
    .execute(&h.pool)
    .await
    .unwrap();
    sqlx::query("UPDATE script_search SET plain_text = ? WHERE script_id = ?")
        .bind("<!-- TODO: cut this line before Friday --> Welcome back. Cue: smile at camera Let's go.")
        .bind(&created.id)
        .execute(&h.pool)
        .await
        .unwrap();
    let (revision, updated_at): (i64, String) =
        sqlx::query_as("SELECT revision, updated_at FROM scripts WHERE id = ?")
            .bind(&created.id)
            .fetch_one(&h.pool)
            .await
            .unwrap();

    let report = reconcile::run_startup_reconciliation(&h.pool, &h.paths, &h.locks)
        .await
        .expect("reconciliation");
    assert!(report.hash_mismatches_repaired.is_empty(), "a stats refresh is not a repair");

    let search = |query: &'static str| {
        let pool = h.pool.clone();
        async move {
            repo::list_scripts(
                &pool,
                ScriptFilter {
                    query: Some(query.into()),
                    ..Default::default()
                },
                None,
                PageRequest::default(),
            )
            .await
            .unwrap()
            .total
        }
    };
    let listed = repo::list_scripts(&h.pool, ScriptFilter::default(), None, PageRequest::default())
        .await
        .unwrap();
    let row = listed.items.iter().find(|s| s.id == created.id).expect("listed");
    assert_eq!(row.spoken_word_count, 4);
    assert_eq!(row.estimated_duration_seconds, 2);
    assert_eq!(row.preview_text, "Welcome back. Let's go.");
    assert_eq!(row.script_revision, revision);
    assert_eq!(row.updated_at, updated_at);
    assert_eq!(search("Friday").await, 0, "an author's note is not searchable script text");
    assert_eq!(search("Welcome").await, 1);
    assert_eq!(
        version(h.pool.clone(), created.id.clone()).await.as_deref(),
        Some(SPOKEN_STATS_VERSION)
    );

    // Idempotent: nothing is stale the second time round.
    assert!(!repo::refresh_stale_spoken_stats(&h.pool, &h.paths, &sid(&created.id), &h.locks)
        .await
        .unwrap());
}

