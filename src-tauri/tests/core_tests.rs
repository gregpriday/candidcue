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
    assert_eq!(initial.value.audio.language, "en-US");

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
}

// ---------------------------------------------------------------------------
// §44.6 secrets — the development escape hatch from the Keychain ACL
// ---------------------------------------------------------------------------

use candidcue_lib::secrets::{
    dev_env_key_active, KeySource, OsSecretStore, SecretStore, DEV_KEY_ENV_VAR,
};

/// Serialises the two tests that mutate `DEV_KEY_ENV_VAR`.
///
/// The environment is process-global and cargo runs these in threads of ONE
/// process, so without this they interleave: the `.env` test removes the
/// variable, reads it, and puts the original back — and when that restore lands
/// between the override test's `set_var` and the read it does next, the store
/// answers with the machine's REAL key and the hint assertion fails on a
/// four-character tail nobody wrote.
///
/// It only ever failed on a machine that HAS a key exported, which is every
/// development machine and no CI runner — the worst possible distribution for
/// a flake, since the people who could fix it are the only ones who saw it.
static ENV_KEY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Take the lock, surviving a panic in whichever test held it last. A poisoned
/// mutex here means another test failed; it must not turn into a second,
/// unrelated failure in this one.
fn lock_env_key() -> std::sync::MutexGuard<'static, ()> {
    ENV_KEY_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The store really does prefer the environment in a debug build, and it says
/// so — `Environment`, not a `Keychain` label over a key that never came from
/// there.
///
/// This test is careful never to reach the real Keychain: the override is
/// asserted live BEFORE the store is asked anything, so a regression fails here
/// instead of popping the macOS login prompt in front of whoever ran the suite.
#[tokio::test]
async fn a_debug_build_reads_the_key_from_the_environment_and_names_that_source() {
    let _guard = lock_env_key();
    let restore = std::env::var(DEV_KEY_ENV_VAR).ok();
    std::env::set_var(DEV_KEY_ENV_VAR, "core-test-override-4d7e");
    assert!(
        dev_env_key_active(),
        "the override must be live before the store is touched, or this test \
         would fall through to the real credential store"
    );

    let described = OsSecretStore
        .describe_stt_key()
        .await
        .expect("the environment path cannot fail")
        .expect("a key is set");
    assert_eq!(described.source, KeySource::Environment);
    // The redacted tail, and nothing more: the value itself never leaves Rust.
    assert_eq!(described.hint, "…4d7e");
    assert!(!described.hint.contains("override"));

    match restore {
        Some(value) => std::env::set_var(DEV_KEY_ENV_VAR, value),
        None => std::env::remove_var(DEV_KEY_ENV_VAR),
    }
}

/// The `.env` fallback finds the key a developer actually put there.
///
/// `tauri dev` inherits the shell's environment, and a `.env` file is not part
/// of it — Vite loads one for the frontend, Rust does not. A developer who puts
/// their key where every other tool in this stack looks for it would otherwise
/// get an app that cannot see it, whose only symptom is a key field that will
/// not go away.
///
/// Skips rather than fails when this checkout has no `.env`: whether the file
/// exists is a property of the machine, not of the code.
#[test]
fn a_dotenv_key_is_found_without_an_exported_variable() {
    let dotenv = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has a parent")
        .join(".env");
    let Ok(contents) = std::fs::read_to_string(&dotenv) else {
        return; // no .env in this checkout
    };
    if !contents.contains(DEV_KEY_ENV_VAR) {
        return;
    }

    let _guard = lock_env_key();
    let restore = std::env::var(DEV_KEY_ENV_VAR).ok();
    std::env::remove_var(DEV_KEY_ENV_VAR);
    let found = dev_env_key_active();
    if let Some(value) = restore {
        std::env::set_var(DEV_KEY_ENV_VAR, value);
    }

    assert!(
        found,
        "a key in {} must be picked up with nothing exported",
        dotenv.display()
    );
}
