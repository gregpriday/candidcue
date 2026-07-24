//! Integration tests for the Rust core: scripts repository lifecycle,
//! settings roundtrip, listener manifest verification, and import/export.

use std::fs;

use candidcue_lib::listeners::{self, ListenerLibrary};
use candidcue_lib::scripts::{
    import_export::{self, ExportOptions, ImportOptions},
    repo, CreateScriptInput, DataPaths, PageRequest, ScriptFilter, ScriptLocks,
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
    let canonical = h.paths.canonical_file(&summary.id);
    assert!(canonical.exists());

    // First save at revision 1 → revision 2, snapshot created (first ever).
    let save = repo::save_script(
        &h.pool,
        &h.paths,
        &h.locks,
        &summary.id,
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
        &summary.id,
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
        &summary.id,
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
        &summary.id,
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

    let revisions = repo::list_revisions(&h.pool, &summary.id).await.expect("list revisions");
    assert_eq!(revisions.len(), 2);

    // Revision content roundtrip + restore-as-current.
    let first_revision = revisions.last().unwrap();
    let doc = repo::get_revision(&h.pool, &h.paths, &summary.id, &first_revision.id)
        .await
        .expect("get revision");
    assert_eq!(doc.source, "Hello world from CandidCue today. Now longer.");

    let restored = repo::restore_revision(
        &h.pool,
        &h.paths,
        &h.locks,
        &summary.id,
        &first_revision.id,
        save3.script_revision,
    )
    .await
    .expect("restore revision");
    assert_eq!(
        fs::read_to_string(&canonical).unwrap(),
        "Hello world from CandidCue today. Now longer."
    );
    assert!(restored.script_revision > save3.script_revision);

    // Trash → hidden from default listing; restore → back.
    repo::trash_script(&h.pool, &summary.id).await.expect("trash");
    let listed = repo::list_scripts(&h.pool, ScriptFilter::default(), None, PageRequest::default())
        .await
        .expect("list");
    assert_eq!(listed.total, 0);
    let trashed = repo::list_scripts(
        &h.pool,
        ScriptFilter {
            query: None,
            status: Some(ScriptStatus::Trash),
        },
        None,
        PageRequest::default(),
    )
    .await
    .expect("list trash");
    assert_eq!(trashed.total, 1);
    repo::restore_script(&h.pool, &summary.id).await.expect("restore");

    // Duplicate copies source under a new id.
    let copy = repo::duplicate_script(&h.pool, &h.paths, &h.locks, &summary.id)
        .await
        .expect("duplicate");
    assert_ne!(copy.id, summary.id);
    assert!(copy.title.ends_with("copy"));
    assert!(h.paths.canonical_file(&copy.id).exists());

    // Permanent deletion removes rows and the directory.
    repo::permanently_delete_script(&h.pool, &h.paths, &h.locks, &summary.id)
        .await
        .expect("purge");
    assert!(!h.paths.script_dir(&summary.id).exists());
    assert!(repo::get_summary(&h.pool, &summary.id).await.is_err());
}

#[tokio::test]
async fn external_change_is_adopted_on_read_and_blocks_blind_save() {
    let h = harness().await;
    let summary = repo::create_script(&h.pool, &h.paths, create_input("Ext", "Original body text."))
        .await
        .expect("create");
    let canonical = h.paths.canonical_file(&summary.id);

    // Simulate an external editor.
    fs::write(&canonical, "Edited outside CandidCue.").unwrap();

    // Saving over it with a stale in-memory copy is refused (spec §21.3).
    let err = repo::save_script(
        &h.pool,
        &h.paths,
        &h.locks,
        &summary.id,
        1,
        "In-app buffer".into(),
        ScriptMetadataPatch::default(),
    )
    .await
    .expect_err("external change must block save");
    assert_eq!(err.code(), "SCRIPT_CONFLICT");

    // Reading adopts the file (authority) and flags the change.
    let doc = repo::get_script(&h.pool, &h.paths, &h.locks, &summary.id)
        .await
        .expect("get");
    assert!(doc.externally_changed);
    assert_eq!(doc.source, "Edited outside CandidCue.");
    assert!(doc.script_revision > 1);

    // After adoption, saving with the new revision works again.
    let save = repo::save_script(
        &h.pool,
        &h.paths,
        &h.locks,
        &summary.id,
        doc.script_revision,
        "Post-adoption save.".into(),
        ScriptMetadataPatch::default(),
    )
    .await
    .expect("save after adoption");
    assert_eq!(save.script_revision, doc.script_revision + 1);
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
            status: None,
        },
        None,
        PageRequest::default(),
    )
    .await
    .unwrap();
    assert_eq!(zebra.total, 5);
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
    assert_eq!(initial.value.commands.wake_phrase, "CandidCue");

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
// Listener manifest verification
// ---------------------------------------------------------------------------

fn write_pack(dir: &std::path::Path, clip_bytes: &[u8], sha: Option<&str>) {
    fs::create_dir_all(dir.join("listening")).unwrap();
    fs::write(dir.join("listening/loop.mp4"), clip_bytes).unwrap();
    fs::write(dir.join("poster.webp"), b"poster").unwrap();
    let manifest = serde_json::json!({
        "schemaVersion": 1,
        "id": "testpack",
        "version": "1.0.0",
        "displayName": "Test pack",
        "description": "test",
        "poster": "poster.webp",
        "defaultZoom": 1.0,
        "fit": "cover",
        "clips": [{
            "id": "loop",
            "role": "neutral",
            "path": "listening/loop.mp4",
            "mime": "video/mp4",
            "durationMs": 7000,
            "sizeBytes": clip_bytes.len(),
            "sha256": sha,
        }]
    });
    fs::write(
        dir.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
}

#[test]
fn manifest_verification_accepts_valid_and_rejects_tampered() {
    let dir = tempfile::tempdir().unwrap();
    let pack = dir.path().join("testpack");
    let clip = b"fake video bytes";
    let sha = {
        use sha2::Digest;
        hex::encode(sha2::Sha256::digest(clip))
    };

    // Valid pack with checksum.
    write_pack(&pack, clip, Some(&sha));
    let manifest = listeners::load_verified_manifest(&pack).expect("valid pack verifies");
    assert_eq!(manifest.id, "testpack");
    assert_eq!(manifest.clips.len(), 1);

    // Tampered media with a different length → size mismatch.
    fs::write(pack.join("listening/loop.mp4"), b"tampered").unwrap();
    let err = listeners::load_verified_manifest(&pack).expect_err("tampered pack rejected");
    assert_eq!(err.code(), "LISTENER_MANIFEST_INVALID"); // size mismatch first

    // Size right, content wrong → signature/checksum error.
    fs::write(pack.join("listening/loop.mp4"), b"fake video byteZ").unwrap();
    let err = listeners::load_verified_manifest(&pack).expect_err("checksum mismatch rejected");
    assert_eq!(err.code(), "LISTENER_SIGNATURE_INVALID");

    // Declared file missing → invalid.
    fs::remove_file(pack.join("listening/loop.mp4")).unwrap();
    let err = listeners::load_verified_manifest(&pack).expect_err("missing file rejected");
    assert_eq!(err.code(), "LISTENER_MANIFEST_INVALID");
}

#[test]
fn manifest_verification_rejects_unsafe_paths() {
    let dir = tempfile::tempdir().unwrap();
    let pack = dir.path().join("evil");
    fs::create_dir_all(&pack).unwrap();
    fs::write(pack.join("poster.webp"), b"poster").unwrap();
    let manifest = serde_json::json!({
        "schemaVersion": 1,
        "id": "evil",
        "version": "1.0.0",
        "displayName": "Evil",
        "description": "",
        "poster": "poster.webp",
        "defaultZoom": 1.0,
        "fit": "cover",
        "clips": [{
            "id": "loop",
            "role": "neutral",
            "path": "../../outside.mp4",
            "mime": "video/mp4",
            "durationMs": 1,
            "sizeBytes": 1,
        }]
    });
    fs::write(pack.join("manifest.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
    let err = listeners::load_verified_manifest(&pack).expect_err("traversal rejected");
    assert_eq!(err.code(), "LISTENER_MANIFEST_INVALID");
}

#[test]
fn bundled_mira_pack_verifies() {
    // The real bundled pack in the repo must always pass verification.
    let mira = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("assets")
        .join("listeners")
        .join("mira");
    let manifest = listeners::load_verified_manifest(&mira).expect("mira verifies");
    assert_eq!(manifest.id, "mira");
    assert_eq!(manifest.clips.len(), 2);
}

#[test]
fn checksum_helper_detects_corruption() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("a.mp4"), b"content-a").unwrap();
    let sha = {
        use sha2::Digest;
        hex::encode(sha2::Sha256::digest(b"content-a"))
    };
    listeners::verify_pack_checksums(dir.path(), &[("a.mp4".into(), sha.clone())])
        .expect("matching checksum passes");
    let err = listeners::verify_pack_checksums(
        dir.path(),
        &[("a.mp4".into(), "deadbeef".repeat(8))],
    )
    .expect_err("mismatch fails");
    assert_eq!(err.code(), "LISTENER_SIGNATURE_INVALID");
    let err = listeners::verify_pack_checksums(dir.path(), &[("../a.mp4".into(), sha)])
        .expect_err("unsafe path fails");
    assert_eq!(err.code(), "IMPORT_UNSAFE_PATH");
}

#[tokio::test]
async fn bundled_pack_is_always_installed() {
    let h = harness().await;
    let library = ListenerLibrary {
        bundled_dir: std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("assets")
            .join("listeners"),
        installed_dir: h.paths.listeners_dir(),
    };
    let installed = listeners::list_installed(&h.pool, &library).await.unwrap();
    assert!(installed.iter().any(|p| p.pack_id == "mira" && p.source == "bundled"));

    let catalogue = listeners::catalogue(&h.pool, &library, false).await.unwrap();
    assert!(catalogue.entries.iter().any(|e| e.pack_id == "mira"));
    assert_eq!(catalogue.source, "bundled_only");

    let (media, _dir) = listeners::resolve_media(&library, "mira", "1.0.0").unwrap();
    assert_eq!(media.clips.len(), 2);
    assert!(media.clips[0].url.contains("localhost"));

    // Bundled packs cannot be removed.
    let err = listeners::remove_pack(&h.pool, &library, "mira", "1.0.0")
        .await
        .expect_err("bundled removal refused");
    assert_eq!(err.code(), "VALIDATION_FAILED");
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
    let revisions = repo::list_revisions(&h.pool, &imported.script.id).await.unwrap();
    assert_eq!(revisions.len(), 1);
    assert_eq!(revisions[0].reason, "import");

    // Bundle export → re-import roundtrip.
    let bundle_path = external.path().join("talk.candidcue");
    let exported = import_export::export_script(
        &h.pool,
        &h.paths,
        &h.locks,
        &imported.script.id,
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
    let source = fs::read_to_string(h.paths.canonical_file(&reimported.script.id)).unwrap();
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
        &imported.script.id,
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
    fs::create_dir_all(h.paths.script_dir(orphan_id)).unwrap();
    fs::write(h.paths.canonical_file(orphan_id), "Orphan body.").unwrap();

    // Missing file: DB row whose canonical file vanished, with a revision.
    let victim = repo::create_script(&h.pool, &h.paths, create_input("Victim", "Original."))
        .await
        .unwrap();
    repo::save_script(
        &h.pool,
        &h.paths,
        &h.locks,
        &victim.id,
        1,
        "Recoverable content.".into(),
        ScriptMetadataPatch::default(),
    )
    .await
    .unwrap();
    fs::remove_file(h.paths.canonical_file(&victim.id)).unwrap();

    let report = reconcile::run_startup_reconciliation(&h.pool, &h.paths, &h.locks)
        .await
        .expect("reconciliation");
    assert!(report.integrity_ok);
    assert!(report.orphan_files_recovered.contains(&orphan_id.to_string()));
    assert!(report.missing_files_restored.contains(&victim.id));
    assert_eq!(
        fs::read_to_string(h.paths.canonical_file(&victim.id)).unwrap(),
        "Recoverable content."
    );
}
