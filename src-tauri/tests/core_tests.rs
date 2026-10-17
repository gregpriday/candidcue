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
    fs::write(&canonical, "# Outline\n\nEdited outside CandidCue.").unwrap();

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
    assert_eq!(doc.source, "# Outline\n\nEdited outside CandidCue.");
    assert!(doc.summary.script_revision > 1);
    // The search entry is the adopted page's, heading and all (#254).
    assert_eq!(search_total(&h, "outline").await, 1);

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

/// How many scripts a Library search returns.
async fn search_total(h: &Harness, query: &str) -> u32 {
    repo::list_scripts(
        &h.pool,
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

/// #254: the Library finds a script by any word on the page, not only the
/// words it speaks. The index used to hold the spoken text alone, so the
/// heading people remember a script by found nothing — while the word count,
/// which is what spoken-only is for, must stay exactly as it was.
#[tokio::test]
async fn library_search_finds_words_that_are_on_the_page_but_not_spoken() {
    let h = harness().await;
    let draft = repo::create_script(
        &h.pool,
        &h.paths,
        create_input(
            "Draft 3",
            "# Quarterly results\n\n:::stage\nPoint at the revenue chart.\n:::\n\n\
             Hello everyone, thanks for coming.\n\n[Cue: smile at the lens]\n",
        ),
    )
    .await
    .expect("create");
    let notes = repo::create_script(
        &h.pool,
        &h.paths,
        create_input(
            "Launch notes",
            "<!-- TODO: confirm figures with finance -->\n\n\
             :::silent\nRemember the hydration break.\n:::\n\n\
             ```bash\ndeploy --canary\n```\n\n\
             Run `kubectl` before we start. ![Lighthouse at dusk](assets/light.png)\n\n\
             This is **Candid**Cue.\n",
        ),
    )
    .await
    .expect("create");

    for query in ["quarterly", "revenue", "hello", "smile", "Quarterly results", "draft"] {
        assert_eq!(search_total(&h, query).await, 1, "searching {query:?}");
    }
    for query in ["finance", "hydration", "canary", "kubectl", "lighthouse"] {
        assert_eq!(search_total(&h, query).await, 1, "searching {query:?}");
    }
    // Spoken text stays searchable in its spoken form, which is not always in
    // the source literally.
    assert_eq!(search_total(&h, "CandidCue").await, 1);
    assert_eq!(search_total(&h, "quarterly hydration").await, 0, "terms are ANDed per script");
    assert_eq!(search_total(&h, "zebra").await, 0);

    // Still spoken-only: the heading, stage block and cue are not speech.
    assert_eq!(draft.spoken_word_count, 5);
    assert_eq!(draft.estimated_duration_seconds, 2);
    assert_eq!(draft.preview_text, "Hello everyone, thanks for coming.");
    assert!(!notes.preview_text.contains("finance"), "{:?}", notes.preview_text);
}

/// A save re-indexes the whole page, so a heading edited away stops finding
/// the script and the new one starts.
#[tokio::test]
async fn library_search_follows_a_saved_heading() {
    let h = harness().await;
    let created = repo::create_script(
        &h.pool,
        &h.paths,
        create_input("Talk", "# Quarterly results\n\nHello everyone.\n"),
    )
    .await
    .expect("create");
    let id = sid(&created.id);
    assert_eq!(search_total(&h, "quarterly").await, 1);

    repo::save_script(
        &h.pool,
        &h.paths,
        &h.locks,
        &id,
        created.script_revision,
        "# Annual review\n\nHello everyone.\n".into(),
        ScriptMetadataPatch::default(),
    )
    .await
    .expect("save");
    assert_eq!(search_total(&h, "quarterly").await, 0);
    assert_eq!(search_total(&h, "annual").await, 1);

    let copy = repo::duplicate_script(&h.pool, &h.paths, &h.locks, &id)
        .await
        .expect("duplicate");
    assert_eq!(search_total(&h, "annual").await, 2, "a duplicate is indexed like its original: {copy:?}");
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
/// which emptied four caches and touched nothing in `logs/`, while the toast
/// said "Logs cleared."
///
/// `logs` is the only kind left (#219): nothing ever wrote the compiled,
/// vocabulary or thumbnail caches `all` swept, and nothing asks for them now,
/// so each of those names is refused like any other unknown kind rather than
/// quietly doing nothing.
#[tokio::test]
async fn clearing_logs_targets_the_log_directory_and_no_cache() {
    let h = harness().await;
    let logs = candidcue_lib::commands::settings_cmds::clear_cache_targets(&h.paths, "logs")
        .expect("`logs` must be a kind clear_cache understands");
    assert_eq!(logs, vec![h.paths.logs_dir()]);

    for kind in ["all", "compiled", "vocabulary", "thumbnails", "everything"] {
        assert!(
            candidcue_lib::commands::settings_cmds::clear_cache_targets(&h.paths, kind).is_err(),
            "{kind:?} must be rejected, not silently mapped onto something"
        );
    }
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
    assert_eq!(initial.value.stage_behavior.fixed_speed_wpm, 130);
    assert_eq!(
        initial.value.audio.transcription_model,
        candidcue_lib::speech::default_model().id
    );

    // Patch a nested field; others survive.
    let updated = settings::update_settings(
        &h.pool,
        1,
        serde_json::json!({ "stageBehavior": { "fixedSpeedWpm": 150 } }),
    )
    .await
    .expect("update");
    assert_eq!(updated.revision, 2);
    assert_eq!(updated.value.stage_behavior.fixed_speed_wpm, 150);
    assert_eq!(updated.value.stage_behavior.prompt_mode, "voice");

    // Persistence roundtrip.
    let reloaded = settings::get_settings(&h.pool).await.unwrap();
    assert_eq!(reloaded.revision, 2);
    assert_eq!(reloaded.value.stage_behavior.fixed_speed_wpm, 150);

    // Stale revision → conflict.
    let stale = settings::update_settings(&h.pool, 1, serde_json::json!({}))
        .await
        .expect_err("stale settings update");
    assert_eq!(stale.code(), "SCRIPT_CONFLICT");

    // Out-of-range value → validation error, nothing stored.
    let invalid = settings::update_settings(
        &h.pool,
        2,
        serde_json::json!({ "stageBehavior": { "fixedSpeedWpm": 1000 } }),
    )
    .await
    .expect_err("range validation");
    assert_eq!(invalid.code(), "VALIDATION_FAILED");
    assert_eq!(
        settings::get_settings(&h.pool).await.unwrap().value.stage_behavior.fixed_speed_wpm,
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
// Byte-order marks (#247)
// ---------------------------------------------------------------------------

/// U+FEFF, which "UTF-8 with BOM" files open with and `read_to_string` keeps.
const BOM: &str = "\u{feff}";
const QUARTERLY: &str = "# Quarterly update\n\nHello everyone, thanks for coming.\n";

async fn import_path(h: &Harness, path: &std::path::Path) -> import_export::ImportResult {
    import_export::import_script(
        &h.pool,
        &h.paths,
        &h.locks,
        ImportOptions {
            path: path.to_string_lossy().to_string(),
            title: None,
        },
    )
    .await
    .expect("import")
}

#[tokio::test]
async fn a_byte_order_mark_does_not_survive_a_file_import() {
    let h = harness().await;
    for ext in ["md", "markdown", "txt"] {
        let plain_dir = tempfile::tempdir().unwrap();
        let marked_dir = tempfile::tempdir().unwrap();
        let plain_path = plain_dir.path().join(format!("Quarterly update.{ext}"));
        let marked_path = marked_dir.path().join(format!("Quarterly update.{ext}"));
        fs::write(&plain_path, QUARTERLY).unwrap();
        fs::write(&marked_path, format!("{BOM}{QUARTERLY}")).unwrap();

        let plain = import_path(&h, &plain_path).await.script;
        let marked = import_path(&h, &marked_path).await.script;

        let stored = fs::read(h.paths.canonical_file(&sid(&marked.id))).unwrap();
        assert!(!stored.starts_with(&[0xEF, 0xBB, 0xBF]), "{ext}: the mark reached the stored script");
        assert_eq!(stored, fs::read(h.paths.canonical_file(&sid(&plain.id))).unwrap(), "{ext}");
        // The Library used to count the heading, `#` and all: 8 words, not 5.
        assert_eq!(marked.spoken_word_count, plain.spoken_word_count, "{ext}");
        assert_eq!(marked.spoken_word_count, 5, "{ext}");
        assert_eq!(marked.preview_text, plain.preview_text, "{ext}");
        assert_eq!(marked.preview_text, "Hello everyone, thanks for coming.", "{ext}");

        // The import revision holds the same bytes as a plain import's.
        let plain_revisions = repo::list_revisions(&h.pool, &sid(&plain.id)).await.unwrap();
        let marked_revisions = repo::list_revisions(&h.pool, &sid(&marked.id)).await.unwrap();
        assert_eq!(marked_revisions.len(), 1, "{ext}");
        assert_eq!(marked_revisions[0].source_hash, plain_revisions[0].source_hash, "{ext}");
        assert_eq!(marked_revisions[0].word_count, Some(5), "{ext}");

        // The user's own file is read, never rewritten.
        assert!(fs::read(&marked_path).unwrap().starts_with(&[0xEF, 0xBB, 0xBF]), "{ext}");
    }
}

#[tokio::test]
async fn a_byte_order_mark_does_not_survive_a_bundle_import() {
    use std::io::Write;

    let h = harness().await;
    let external = tempfile::tempdir().unwrap();
    let bundle = external.path().join("quarterly.candidcue");
    let mut writer = zip::ZipWriter::new(fs::File::create(&bundle).unwrap());
    let options = zip::write::SimpleFileOptions::default();
    writer.start_file("manifest.json", options).unwrap();
    writer
        .write_all(br#"{"schemaVersion":1,"title":"Quarterly update","assets":[]}"#)
        .unwrap();
    writer.start_file("script.md", options).unwrap();
    writer.write_all(format!("{BOM}{QUARTERLY}").as_bytes()).unwrap();
    writer.finish().unwrap();

    let imported = import_path(&h, &bundle).await.script;
    let script_id = sid(&imported.id);
    assert_eq!(fs::read_to_string(h.paths.canonical_file(&script_id)).unwrap(), QUARTERLY);
    assert_eq!(imported.spoken_word_count, 5);
    let revisions = repo::list_revisions(&h.pool, &script_id).await.unwrap();
    assert_eq!(revisions.len(), 1);
    assert_eq!(revisions[0].source_hash, candidcue_lib::util::sha256_hex(QUARTERLY.as_bytes()));
}

#[tokio::test]
async fn an_external_byte_order_mark_is_adopted_once_and_never_handed_on() {
    let h = harness().await;
    let summary = repo::create_script(&h.pool, &h.paths, create_input("Ext", QUARTERLY))
        .await
        .expect("create");
    let script_id = sid(&summary.id);
    let canonical = h.paths.canonical_file(&script_id);

    // An outside editor saves the same words back as "UTF-8 with BOM".
    fs::write(&canonical, format!("{BOM}{QUARTERLY}")).unwrap();

    // The bytes changed, so this is an ordinary adoption; the editor still
    // gets the text without the mark.
    let doc = repo::get_script(&h.pool, &h.paths, &h.locks, &script_id)
        .await
        .expect("get");
    assert!(doc.externally_changed);
    assert_eq!(doc.source, QUARTERLY);

    // ...once. The recorded hash describes the file as it is on disk, so a
    // second open finds nothing new (no phantom-change loop).
    let again = repo::get_script(&h.pool, &h.paths, &h.locks, &script_id)
        .await
        .expect("get again");
    assert!(!again.externally_changed);
    assert_eq!(again.summary.script_revision, doc.summary.script_revision);
    assert_eq!(again.source, QUARTERLY);

    // Export and duplicate carry the text, not the mark.
    let external = tempfile::tempdir().unwrap();
    let md_out = external.path().join("out.md");
    import_export::export_script(
        &h.pool,
        &h.paths,
        &h.locks,
        &script_id,
        ExportOptions {
            destination: md_out.to_string_lossy().to_string(),
            format: "markdown".into(),
            include_assets: false,
        },
    )
    .await
    .expect("markdown export");
    assert_eq!(fs::read_to_string(&md_out).unwrap(), QUARTERLY);
    let copy = repo::duplicate_script(&h.pool, &h.paths, &h.locks, &script_id)
        .await
        .expect("duplicate");
    assert_eq!(fs::read_to_string(h.paths.canonical_file(&sid(&copy.id))).unwrap(), QUARTERLY);
    assert_eq!(copy.spoken_word_count, 5);

    // The adoption snapshot preserved the file byte for byte; viewing it
    // shows the text, and restoring it writes the text.
    let revisions = repo::list_revisions(&h.pool, &script_id).await.unwrap();
    let adopted = revisions
        .iter()
        .find(|r| r.reason == "external_change")
        .expect("adoption snapshot");
    assert_eq!(
        adopted.source_hash,
        candidcue_lib::util::sha256_hex(format!("{BOM}{QUARTERLY}").as_bytes())
    );
    let viewed = repo::get_revision(&h.pool, &h.paths, &script_id, &adopted.id)
        .await
        .expect("view revision");
    assert_eq!(viewed.source, QUARTERLY);

    // Saving over the marked file is not refused, and writes it clean.
    let saved = repo::save_script(
        &h.pool,
        &h.paths,
        &h.locks,
        &script_id,
        again.summary.script_revision,
        format!("{QUARTERLY}More.\n"),
        ScriptMetadataPatch::default(),
    )
    .await
    .expect("save over a marked file");
    assert_eq!(fs::read_to_string(&canonical).unwrap(), format!("{QUARTERLY}More.\n"));

    let restored = repo::restore_revision(
        &h.pool,
        &h.paths,
        &h.locks,
        &script_id,
        &adopted.id,
        saved.script_revision,
    )
    .await
    .expect("restore the marked revision");
    assert_eq!(fs::read_to_string(&canonical).unwrap(), QUARTERLY);
    let after = repo::get_script(&h.pool, &h.paths, &h.locks, &script_id)
        .await
        .expect("get after restore");
    assert!(!after.externally_changed);
    assert_eq!(after.summary.script_revision, restored.script_revision);
}

#[tokio::test]
async fn a_byte_order_mark_from_the_editor_never_reaches_the_disk() {
    let h = harness().await;
    // Pasted into a new script...
    let summary = repo::create_script(
        &h.pool,
        &h.paths,
        create_input("Pasted", &format!("{BOM}{QUARTERLY}")),
    )
    .await
    .expect("create");
    let script_id = sid(&summary.id);
    let canonical = h.paths.canonical_file(&script_id);
    assert_eq!(fs::read_to_string(&canonical).unwrap(), QUARTERLY);
    assert_eq!(summary.spoken_word_count, 5);

    // ...and into an existing one. The file is written without it, and the
    // recorded hash is of what was written, so nothing reads it as changed.
    let first = repo::save_script(
        &h.pool,
        &h.paths,
        &h.locks,
        &script_id,
        1,
        format!("{BOM}Hello again.\n"),
        ScriptMetadataPatch::default(),
    )
    .await
    .expect("save");
    assert_eq!(fs::read_to_string(&canonical).unwrap(), "Hello again.\n");

    let doc = repo::get_script(&h.pool, &h.paths, &h.locks, &script_id)
        .await
        .expect("get");
    assert!(!doc.externally_changed);
    assert_eq!(doc.summary.script_revision, first.script_revision);
    repo::save_script(
        &h.pool,
        &h.paths,
        &h.locks,
        &script_id,
        doc.summary.script_revision,
        "Third time.\n".into(),
        ScriptMetadataPatch::default(),
    )
    .await
    .expect("a later save is not refused");
}

/// Put a script into the state an import left it in before #247: the given
/// file keeps its mark, the row's hash matches it, and the Library read the
/// heading as speech — 8 words, a 4-second estimate, the mark in the preview.
/// The row is stamped `spoken-stats-2`, the last extraction that read the mark
/// as text, so only the version bump can tell reconciliation it is stale.
async fn seed_legacy_bom_metadata(h: &Harness, script_id: &ScriptId, marked: &str) {
    sqlx::query(
        "UPDATE scripts SET source_hash = ?, spoken_word_count = 8, estimated_duration_seconds = 4,
             last_compile_version = 'spoken-stats-2'
         WHERE id = ?",
    )
    .bind(candidcue_lib::util::sha256_hex(marked.as_bytes()))
    .bind(script_id.as_str())
    .execute(&h.pool)
    .await
    .unwrap();
    sqlx::query("DELETE FROM script_search WHERE script_id = ?")
        .bind(script_id.as_str())
        .execute(&h.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO script_search (script_id, title, plain_text) VALUES (?, ?, ?)")
        .bind(script_id.as_str())
        .bind("Legacy")
        .bind(format!("{BOM}# Quarterly update Hello everyone, thanks for coming."))
        .execute(&h.pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn library_metadata_extracted_with_a_byte_order_mark_is_rebuilt_at_startup() {
    use candidcue_lib::scripts::reconcile;

    let h = harness().await;
    let summary = repo::create_script(&h.pool, &h.paths, create_input("Legacy", QUARTERLY))
        .await
        .expect("create");
    let clean_duration = summary.estimated_duration_seconds;
    let script_id = sid(&summary.id);
    let canonical = h.paths.canonical_file(&script_id);

    let marked = format!("{BOM}{QUARTERLY}");
    fs::write(&canonical, &marked).unwrap();
    seed_legacy_bom_metadata(&h, &script_id, &marked).await;
    let before = repo::get_summary(&h.pool, &script_id).await.unwrap();
    assert_eq!(before.spoken_word_count, 8);
    assert_ne!(before.estimated_duration_seconds, clean_duration);
    assert!(before.preview_text.starts_with(BOM));

    // The hash matches, so this is not a repair...
    let report = reconcile::run_startup_reconciliation(&h.pool, &h.paths, &h.locks)
        .await
        .expect("reconciliation");
    assert!(report.hash_mismatches_repaired.is_empty());

    // ...but the Library now reads what the editor does, and nothing else moved.
    let after = repo::get_summary(&h.pool, &script_id).await.unwrap();
    assert_eq!(after.spoken_word_count, 5);
    assert_eq!(after.estimated_duration_seconds, clean_duration);
    assert_eq!(after.preview_text, "Hello everyone, thanks for coming.");
    assert_eq!(after.script_revision, before.script_revision);
    assert_eq!(after.updated_at, before.updated_at);
    assert_eq!(fs::read_to_string(&canonical).unwrap(), marked);

    // A second startup leaves it be, and opening finds no external change.
    reconcile::run_startup_reconciliation(&h.pool, &h.paths, &h.locks)
        .await
        .expect("second reconciliation");
    let doc = repo::get_script(&h.pool, &h.paths, &h.locks, &script_id)
        .await
        .expect("get");
    assert!(!doc.externally_changed);
    assert_eq!(doc.source, QUARTERLY);
    assert_eq!(doc.summary.spoken_word_count, 5);
    assert_eq!(doc.summary.script_revision, before.script_revision);
}

#[tokio::test]
async fn a_legacy_marked_script_restored_from_its_revision_is_rebuilt_too() {
    use candidcue_lib::scripts::reconcile;

    let h = harness().await;
    let summary = repo::create_script(&h.pool, &h.paths, create_input("Legacy", QUARTERLY))
        .await
        .expect("create");
    let script_id = sid(&summary.id);
    let canonical = h.paths.canonical_file(&script_id);

    // The legacy import's own revision is the newest one, mark and all, and
    // the canonical file is gone.
    let marked = format!("{BOM}{QUARTERLY}");
    repo::create_revision_snapshot(&h.pool, &h.paths, &script_id, &marked, "import", 8)
        .await
        .expect("legacy import revision");
    seed_legacy_bom_metadata(&h, &script_id, &marked).await;
    fs::remove_file(&canonical).unwrap();

    let report = reconcile::run_startup_reconciliation(&h.pool, &h.paths, &h.locks)
        .await
        .expect("reconciliation");
    assert!(report.missing_files_restored.contains(&summary.id));

    // Restored byte for byte, with the metadata rebuilt in the same pass.
    assert_eq!(fs::read_to_string(&canonical).unwrap(), marked);
    let after = repo::get_summary(&h.pool, &script_id).await.unwrap();
    assert_eq!(after.spoken_word_count, 5);
    assert_eq!(after.preview_text, "Hello everyone, thanks for coming.");
    let doc = repo::get_script(&h.pool, &h.paths, &h.locks, &script_id)
        .await
        .expect("get");
    assert!(!doc.externally_changed);
    assert_eq!(doc.source, QUARTERLY);
}

#[tokio::test]
async fn an_import_with_two_marks_stores_one_text() {
    // Stripping must be idempotent: import strips, then `create_script`
    // strips what import hands it, and the import revision is written from
    // import's copy. A file a tool gave a second mark must not come out as
    // one text in the script and another in its first revision.
    let h = harness().await;
    let external = tempfile::tempdir().unwrap();
    let path = external.path().join("Twice.md");
    fs::write(&path, format!("{BOM}{BOM}{QUARTERLY}")).unwrap();

    let imported = import_path(&h, &path).await.script;
    let script_id = sid(&imported.id);
    assert_eq!(fs::read_to_string(h.paths.canonical_file(&script_id)).unwrap(), QUARTERLY);
    let revisions = repo::list_revisions(&h.pool, &script_id).await.unwrap();
    assert_eq!(revisions[0].source_hash, candidcue_lib::util::sha256_hex(QUARTERLY.as_bytes()));
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

#[tokio::test]
async fn session_records_start_end_and_list() {
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

    let record = sessions::start_session(&h.pool, &input).await.unwrap();
    // #217: the retention latch went with retained transcripts, so the record
    // no longer claims anything about them.
    let wire = serde_json::to_value(&record).unwrap();
    assert!(wire.get("transcriptRetained").is_none(), "got {wire}");

    // end_session fills aggregates.
    let record2 = sessions::start_session(&h.pool, &input).await.unwrap();
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
    assert!(listed.iter().any(|session| session.id == record.id));
}

// ---------------------------------------------------------------------------
// Permanently deleting a script that has been presented (#216)
// ---------------------------------------------------------------------------

/// The history one presented take leaves: an ended session. Returns its id.
async fn present_once(h: &Harness, script_id: &str) -> String {
    use candidcue_lib::sessions;

    let input: sessions::StartSessionInput = serde_json::from_value(serde_json::json!({
        "scriptId": script_id,
        "scriptSourceHash": "abc",
        "mode": "voice",
        "startTokenIndex": 0,
    }))
    .unwrap();
    let session = sessions::start_session(&h.pool, &input).await.unwrap();
    sessions::end_session(
        &h.pool,
        &session.id,
        serde_json::from_value(serde_json::json!({ "endTokenIndex": 3 })).unwrap(),
    )
    .await
    .unwrap();
    session.id
}

/// Session rows for one session id.
async fn session_history(pool: &sqlx::SqlitePool, session_id: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM sessions WHERE id = ?")
        .bind(session_id)
        .fetch_one(pool)
        .await
        .unwrap()
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
    // Trash on its own keeps the history: Restore must bring the sessions back.
    assert_eq!(session_history(&h.pool, &doomed_session).await, 1);

    repo::permanently_delete_script(&h.pool, &h.paths, &h.locks, &doomed_id)
        .await
        .expect("a presented script must delete permanently");
    assert!(repo::get_summary(&h.pool, &doomed_id).await.is_err());
    assert!(!h.paths.script_dir(&doomed_id).exists());
    assert_eq!(session_history(&h.pool, &doomed_session).await, 0);

    // "Start where the last take ended" reads the other script's sessions.
    assert_eq!(session_history(&h.pool, &survivor_session).await, 1);
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
    assert_eq!(session_history(&h.pool, &session).await, 1);
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
    // With no rebuild to say what it was called, it is named after its own
    // first line rather than its UUID (#252).
    assert_eq!(repo::get_summary(&h.pool, &orphan).await.unwrap().title, "Orphan body.");
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

/// #252: an adopted folder's revisions and images are indexed again, but only
/// the files that prove they are what their names say. Anything else is left
/// exactly where it was, unindexed, with a note.
#[tokio::test]
async fn an_adopted_folder_indexes_only_the_files_that_prove_themselves() {
    use candidcue_lib::scripts::reconcile;
    use candidcue_lib::util::sha256_hex;

    let h = harness().await;
    let orphan = sid("0a651b8e-3a54-4a7e-bb6d-000000000252");
    fs::create_dir_all(h.paths.assets_dir(&orphan)).unwrap();
    fs::create_dir_all(h.paths.revisions_dir(&orphan)).unwrap();
    fs::write(h.paths.canonical_file(&orphan), "```\nnot a title\n```\n\n## Second take\n").unwrap();

    let png: Vec<u8> = vec![
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90,
        0x77, 0x53, 0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, 0x78, 0xDA, 0x63, 0xF8,
        0xCF, 0xC0, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00, 0xF7, 0x03, 0x41, 0x43, 0x00, 0x00, 0x00,
        0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];
    let genuine = format!("{}.png", sha256_hex(&png));
    // Named for bytes it does not hold.
    let forged = format!("{}.png", sha256_hex(b"something else"));
    // A real image under a name that is not its hash.
    let renamed = "photo.png".to_string();
    for name in [&genuine, &forged, &renamed] {
        fs::write(h.paths.assets_dir(&orphan).join(name), &png).unwrap();
    }

    let older = "First take.";
    let newer = "Second take.";
    let name_for = |stamp: &str, text: &str| format!("{stamp}-{}.md", &sha256_hex(text.as_bytes())[..12]);
    fs::write(h.paths.revisions_dir(&orphan).join(name_for("20261001T090000000Z", older)), older).unwrap();
    fs::write(h.paths.revisions_dir(&orphan).join(name_for("20261002T090000000Z", newer)), newer).unwrap();
    // Contents swapped out from under its name.
    let tampered = name_for("20261003T090000000Z", "Third take.");
    fs::write(h.paths.revisions_dir(&orphan).join(&tampered), "Not the third take.").unwrap();

    let report = reconcile::run_startup_reconciliation(&h.pool, &h.paths, &h.locks)
        .await
        .expect("reconciliation");
    assert!(report.orphan_files_recovered.contains(&orphan.as_str().to_string()));
    assert_eq!(
        repo::get_summary(&h.pool, &orphan).await.unwrap().title,
        "Second take",
        "fenced code is not a title; the first spoken line is"
    );

    let revisions = repo::list_revisions(&h.pool, &orphan).await.unwrap();
    assert_eq!(revisions.len(), 2, "the tampered snapshot is not indexed as the third take");
    assert_eq!(revisions[0].revision_number, 2);
    assert_eq!(revisions[0].created_at, "2026-10-02T09:00:00.000Z");
    assert_eq!(revisions[1].created_at, "2026-10-01T09:00:00.000Z");
    assert_eq!(
        repo::get_revision(&h.pool, &h.paths, &orphan, &revisions[0].id).await.unwrap().source,
        newer
    );
    assert_eq!(report.revisions_recovered, 2);

    assert_eq!(report.assets_recovered, 1);
    let indexed: Vec<String> = sqlx::query_scalar("SELECT rel_path FROM assets")
        .fetch_all(&h.pool)
        .await
        .unwrap();
    assert_eq!(indexed, vec![format!("scripts/{}/assets/{genuine}", orphan.as_str())]);
    for name in [&forged, &renamed] {
        assert!(h.paths.assets_dir(&orphan).join(name).exists(), "{name} is left alone");
        assert!(
            report.notes.iter().any(|note| note.contains(name.as_str())),
            "and the report says why {name} was not indexed: {:?}",
            report.notes
        );
    }
    assert!(h.paths.revisions_dir(&orphan).join(&tampered).exists());
    assert!(report.notes.iter().any(|note| note.contains(&tampered)));
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

    // What an older extraction stored for this script. (Rows indexed before
    // the stamp existed carry NULL; the restore test above covers that one.)
    sqlx::query(
        "UPDATE scripts SET spoken_word_count = 17, estimated_duration_seconds = 8,
             last_compile_version = 'spoken-stats-1'
         WHERE id = ?",
    )
    .bind(&created.id)
    .execute(&h.pool)
    .await
    .unwrap();
    // ...and an index from before search covered the whole page (#254).
    sqlx::query("UPDATE script_search SET plain_text = ?, body = NULL WHERE script_id = ?")
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
    // The note is no longer in the spoken text, so only a rebuilt `body` can
    // still find it: it is on the page, and search covers the page (#254).
    assert_eq!(search("Friday").await, 1, "an author's note is found by search");
    assert_eq!(search("Welcome").await, 1);
    assert_eq!(
        version(h.pool.clone(), created.id.clone()).await.as_deref(),
        Some(SPOKEN_STATS_VERSION)
    );

    // Idempotent: nothing is stale the second time round.
    assert!(!repo::refresh_stale_spoken_stats(&h.pool, &h.paths, &sid(&created.id), &h.locks)
        .await
        .unwrap());

    // A file that disagrees with its row is a repair, not a refresh: the
    // refresh leaves the row alone rather than indexing bytes the row's hash
    // does not describe.
    fs::write(h.paths.canonical_file(&sid(&created.id)), "Somebody else's words entirely.").unwrap();
    sqlx::query("UPDATE scripts SET last_compile_version = NULL WHERE id = ?")
        .bind(&created.id)
        .execute(&h.pool)
        .await
        .unwrap();
    assert!(!repo::refresh_stale_spoken_stats(&h.pool, &h.paths, &sid(&created.id), &h.locks)
        .await
        .unwrap());
    let listed = repo::list_scripts(&h.pool, ScriptFilter::default(), None, PageRequest::default())
        .await
        .unwrap();
    let row = listed.items.iter().find(|s| s.id == created.id).expect("listed");
    assert_eq!(row.spoken_word_count, 4);
    assert_eq!(row.preview_text, "Welcome back. Let's go.");
}

