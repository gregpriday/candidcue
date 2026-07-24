//! Integration tests for the Rust core: scripts repository lifecycle,
//! settings roundtrip, listener manifest verification, and import/export.

use std::fs;

use candidcue_lib::listeners::{self, ListenerLibrary};
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
            query: None,
            status: Some(ScriptStatus::Trash),
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

use candidcue_lib::listeners::PackSource;

/// Minimal bytes that a container sniffer accepts. Real magic, no payload —
/// enough to prove the checks look at the file rather than the manifest.
fn fake_mp4(tag: u8) -> Vec<u8> {
    let mut out = vec![0x00, 0x00, 0x00, 0x18];
    out.extend_from_slice(b"ftypmp42");
    out.extend_from_slice(&[tag; 20]);
    out
}

fn fake_webp() -> Vec<u8> {
    let mut out = b"RIFF".to_vec();
    out.extend_from_slice(&[0x10, 0, 0, 0]);
    out.extend_from_slice(b"WEBPVP8 ");
    out
}

fn sha_of(bytes: &[u8]) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(bytes))
}

struct PackSpec<'a> {
    id: &'a str,
    version: &'a str,
    clip: Vec<u8>,
    clip_mime: &'a str,
    sha: Option<String>,
    poster: Vec<u8>,
}

impl Default for PackSpec<'_> {
    fn default() -> Self {
        Self {
            id: "testpack",
            version: "1.0.0",
            clip: fake_mp4(0xAA),
            clip_mime: "video/mp4",
            sha: None,
            poster: fake_webp(),
        }
    }
}

fn write_pack_spec(dir: &std::path::Path, spec: &PackSpec<'_>) {
    fs::create_dir_all(dir.join("listening")).unwrap();
    fs::write(dir.join("listening/loop.mp4"), &spec.clip).unwrap();
    fs::write(dir.join("poster.webp"), &spec.poster).unwrap();
    let mut clip = serde_json::json!({
        "id": "loop",
        "role": "neutral",
        "path": "listening/loop.mp4",
        "mime": spec.clip_mime,
        "durationMs": 7000,
        "sizeBytes": spec.clip.len(),
    });
    if let Some(sha) = &spec.sha {
        clip["sha256"] = serde_json::Value::String(sha.clone());
    }
    let manifest = serde_json::json!({
        "schemaVersion": 1,
        "id": spec.id,
        "version": spec.version,
        "displayName": "Test pack",
        "description": "test",
        "poster": "poster.webp",
        "defaultZoom": 1.0,
        "fit": "cover",
        "clips": [clip],
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
    let clip = fake_mp4(0xAA);
    let sha = sha_of(&clip);

    // Valid bundled pack with a checksum.
    write_pack_spec(
        &pack,
        &PackSpec {
            clip: clip.clone(),
            sha: Some(sha.clone()),
            ..Default::default()
        },
    );
    let manifest = listeners::load_verified_manifest(&pack, PackSource::Bundled)
        .expect("valid pack verifies");
    assert_eq!(manifest.id, "testpack");
    assert_eq!(manifest.clips.len(), 1);

    // Tampered media with a different length → size mismatch.
    fs::write(pack.join("listening/loop.mp4"), b"tampered").unwrap();
    let err = listeners::load_verified_manifest(&pack, PackSource::Bundled)
        .expect_err("tampered pack rejected");
    assert_eq!(err.code(), "LISTENER_MANIFEST_INVALID"); // size mismatch first

    // Size right, content wrong → checksum error. NOT "signature": there is no
    // signature scheme, and the code used to claim otherwise (M3).
    fs::write(pack.join("listening/loop.mp4"), fake_mp4(0xBB)).unwrap();
    let err = listeners::load_verified_manifest(&pack, PackSource::Bundled)
        .expect_err("checksum mismatch rejected");
    assert_eq!(err.code(), "LISTENER_CHECKSUM_INVALID");

    // Declared file missing → invalid.
    fs::remove_file(pack.join("listening/loop.mp4")).unwrap();
    let err = listeners::load_verified_manifest(&pack, PackSource::Bundled)
        .expect_err("missing file rejected");
    assert_eq!(err.code(), "LISTENER_MANIFEST_INVALID");
}

/// M3. The headline dishonesty: a pack that did not ship with the application
/// was verified with the same optional-checksum path as a bundled one, and the
/// comments called that "signature verification". Nothing signs a pack, so a
/// non-bundled pack now fails closed — after every integrity check that CAN be
/// made has been made.
#[test]
fn a_non_bundled_pack_is_refused_because_nothing_can_vouch_for_it() {
    let dir = tempfile::tempdir().unwrap();
    let pack = dir.path().join("installed").join("testpack").join("1.0.0");
    let clip = fake_mp4(0xAA);

    // No checksums at all: refused for that reason first, because integrity is
    // the part that CAN be checked.
    write_pack_spec(
        &pack,
        &PackSpec {
            clip: clip.clone(),
            sha: None,
            ..Default::default()
        },
    );
    let err = listeners::load_verified_manifest(&pack, PackSource::Installed)
        .expect_err("a non-bundled pack must declare checksums");
    assert_eq!(err.code(), "LISTENER_CHECKSUM_INVALID");

    // Fully checksummed and internally consistent — and still refused, because
    // a hash the pack wrote about itself proves nothing about who wrote it.
    write_pack_spec(
        &pack,
        &PackSpec {
            clip: clip.clone(),
            sha: Some(sha_of(&clip)),
            ..Default::default()
        },
    );
    let err = listeners::load_verified_manifest(&pack, PackSource::Installed)
        .expect_err("integrity is not authenticity");
    assert_eq!(err.code(), "LISTENER_UNVERIFIED");
    assert!(!err.recoverable(), "there is no user action that fixes this");

    // The very same directory verifies as bundled: the difference is the trust
    // anchor, not the contents.
    let bundled = dir.path().join("bundled").join("testpack");
    write_pack_spec(
        &bundled,
        &PackSpec {
            clip: clip.clone(),
            sha: Some(sha_of(&clip)),
            ..Default::default()
        },
    );
    assert!(listeners::load_verified_manifest(&bundled, PackSource::Bundled).is_ok());
}

/// M3. The declared mime was accepted on the strength of `starts_with("video/")`
/// and the poster was only checked for existence, so a pack could hand the
/// stage's media element and image tag whatever bytes it liked.
#[test]
fn declared_media_types_must_match_the_bytes_on_disk() {
    let dir = tempfile::tempdir().unwrap();

    let wrong_container = dir.path().join("testpack");
    write_pack_spec(
        &wrong_container,
        &PackSpec {
            clip: b"this is not a video at all, not even close".to_vec(),
            ..Default::default()
        },
    );
    let err = listeners::load_verified_manifest(&wrong_container, PackSource::Bundled)
        .expect_err("a clip that is not a video container must be refused");
    assert_eq!(err.code(), "LISTENER_MANIFEST_INVALID");

    let unknown_mime = dir.path().join("unknownmime");
    write_pack_spec(
        &unknown_mime,
        &PackSpec {
            id: "unknownmime",
            clip_mime: "video/x-anything",
            ..Default::default()
        },
    );
    let err = listeners::load_verified_manifest(&unknown_mime, PackSource::Bundled)
        .expect_err("an unrecognised video mime must be refused");
    assert_eq!(err.code(), "LISTENER_MANIFEST_INVALID");

    let bad_poster = dir.path().join("badposter");
    write_pack_spec(
        &bad_poster,
        &PackSpec {
            id: "badposter",
            poster: b"not an image, just some text bytes".to_vec(),
            ..Default::default()
        },
    );
    let err = listeners::load_verified_manifest(&bad_poster, PackSource::Bundled)
        .expect_err("a poster that is not an image must be refused");
    assert_eq!(err.code(), "LISTENER_MANIFEST_INVALID");
}

/// M3. The manifest's id and version are now bound to the directory the pack
/// was loaded from, and undeclared files are refused: a pack directory is
/// exposed to the asset protocol, so anything in it that nothing has inspected
/// is a file the stage can fetch.
#[test]
fn a_pack_is_bound_to_its_directory_and_declares_everything_it_contains() {
    let dir = tempfile::tempdir().unwrap();

    // Directory says `impostor`, manifest claims to be `mira`.
    let impostor = dir.path().join("impostor");
    write_pack_spec(&impostor, &PackSpec { id: "mira", ..Default::default() });
    let err = listeners::load_verified_manifest(&impostor, PackSource::Bundled)
        .expect_err("a pack may not claim another pack's identity");
    assert_eq!(err.code(), "LISTENER_MANIFEST_INVALID");

    // An extra file nobody declared.
    let smuggler = dir.path().join("smuggler");
    write_pack_spec(&smuggler, &PackSpec { id: "smuggler", ..Default::default() });
    assert!(listeners::load_verified_manifest(&smuggler, PackSource::Bundled).is_ok());
    fs::write(smuggler.join("listening/notes.html"), b"<script>x</script>").unwrap();
    let err = listeners::load_verified_manifest(&smuggler, PackSource::Bundled)
        .expect_err("an undeclared file must be refused");
    assert_eq!(err.code(), "LISTENER_MANIFEST_INVALID");
}

#[test]
fn manifest_verification_rejects_unsafe_paths() {
    let dir = tempfile::tempdir().unwrap();
    let pack = dir.path().join("evil");
    fs::create_dir_all(&pack).unwrap();
    fs::write(pack.join("poster.webp"), fake_webp()).unwrap();
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
    let err = listeners::load_verified_manifest(&pack, PackSource::Bundled)
        .expect_err("traversal rejected");
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
    let manifest = listeners::load_verified_manifest(&mira, PackSource::Bundled)
        .expect("mira verifies");
    assert_eq!(manifest.id, "mira");
    assert_eq!(manifest.clips.len(), 2);
}

#[test]
fn checksum_helper_detects_corruption() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("a.mp4"), b"content-a").unwrap();
    let sha = sha_of(b"content-a");
    listeners::verify_pack_checksums(dir.path(), &[("a.mp4".into(), sha.clone())])
        .expect("matching checksum passes");
    let err = listeners::verify_pack_checksums(
        dir.path(),
        &[("a.mp4".into(), "deadbeef".repeat(8))],
    )
    .expect_err("mismatch fails");
    assert_eq!(err.code(), "LISTENER_CHECKSUM_INVALID");
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
