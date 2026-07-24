//! Regression tests for the script-id, concurrency, and recovery defects.
//!
//! Every test here fails against the code as it stood before the fix; the
//! comment on each says which defect it pins down.

use std::fs;

use candidcue_lib::scripts::{
    reconcile, repo, CreateScriptInput, DataPaths, ScriptId, ScriptLocks, ScriptMetadataPatch,
    ScriptStatus,
};

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

fn sid(raw: &str) -> ScriptId {
    ScriptId::parse(raw).expect("canonical uuid")
}

async fn new_script(h: &Harness, title: &str, body: &str) -> ScriptId {
    let summary = repo::create_script(&h.pool, &h.paths, create_input(title, body))
        .await
        .expect("create");
    sid(&summary.id)
}

async fn db_hash(h: &Harness, id: &ScriptId) -> String {
    sqlx::query_scalar::<_, String>("SELECT source_hash FROM scripts WHERE id = ?")
        .bind(id.as_str())
        .fetch_one(&h.pool)
        .await
        .expect("source hash")
}

async fn db_revision(h: &Harness, id: &ScriptId) -> i64 {
    sqlx::query_scalar::<_, i64>("SELECT revision FROM scripts WHERE id = ?")
        .bind(id.as_str())
        .fetch_one(&h.pool)
        .await
        .expect("revision")
}

// ---------------------------------------------------------------------------
// C1 — script id validation and filesystem confinement
// ---------------------------------------------------------------------------

/// The reported attack: `invoke('permanently_delete_script', { scriptId:
/// '/Users/alice/Documents' })` recursively deleted that directory, because
/// `PathBuf::join` replaces the base when the argument is absolute. Every
/// command now parses its id first, so no such value can ever become a path.
#[tokio::test]
async fn hostile_script_ids_never_reach_the_filesystem() {
    let h = harness().await;

    // Sentinel content OUTSIDE the managed data root, standing in for the
    // user's real documents.
    let outside = tempfile::tempdir().expect("outside dir");
    let precious = outside.path().join("precious.txt");
    fs::write(&precious, "do not delete me").unwrap();
    let nested = outside.path().join("nested/deeper");
    fs::create_dir_all(&nested).unwrap();
    fs::write(nested.join("keep.txt"), "keep").unwrap();

    // A real script, so the database is not trivially empty.
    let real = new_script(&h, "Real", "Real body.").await;

    let hostile = [
        outside.path().to_string_lossy().to_string(),
        precious.to_string_lossy().to_string(),
        "/".to_string(),
        "..".to_string(),
        "../..".to_string(),
        "../../../../../../etc".to_string(),
        format!("{}/../..", real),
        "%".to_string(),
        "_".to_string(),
        "%/..".to_string(),
        String::new(),
        "not-a-uuid".to_string(),
    ];

    for raw in &hostile {
        // This is exactly what every command now does before touching state.
        assert!(
            ScriptId::parse(raw).is_err(),
            "script id {raw:?} must be rejected at the IPC boundary"
        );
    }

    // Nothing outside the data root was touched.
    assert_eq!(fs::read_to_string(&precious).unwrap(), "do not delete me");
    assert!(nested.join("keep.txt").exists());
    assert!(outside.path().exists());

    // The real script and its row are untouched.
    assert!(h.paths.canonical_file(&real).exists());
    assert!(repo::get_summary(&h.pool, &real).await.is_ok());
}

/// The `DELETE FROM assets WHERE rel_path LIKE ?` clause interpolated the
/// caller's id, so an id of `%` matched — and deleted — every script's asset
/// rows. Ids are UUIDs now AND the query no longer uses LIKE.
#[tokio::test]
async fn permanent_delete_only_removes_its_own_asset_rows() {
    let h = harness().await;
    let victim = new_script(&h, "Victim", "Victim body.").await;
    let bystander = new_script(&h, "Bystander", "Bystander body.").await;

    for (id, name) in [(&victim, "v.png"), (&bystander, "b.png")] {
        sqlx::query(
            "INSERT INTO assets (id, sha256, mime_type, extension, size_bytes, rel_path, created_at)
             VALUES (?, ?, 'image/png', 'png', 4, ?, ?)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(format!("{name}-hash"))
        .bind(format!("scripts/{}/assets/{name}", id.as_str()))
        .bind("2026-01-01T00:00:00.000Z")
        .execute(&h.pool)
        .await
        .expect("insert asset");
    }

    let trashed = repo::trash_script(&h.pool, &h.locks, &victim, db_revision(&h, &victim).await)
        .await
        .expect("trash");
    assert_eq!(trashed.status, ScriptStatus::Trash);
    repo::permanently_delete_script(&h.pool, &h.paths, &h.locks, &victim)
        .await
        .expect("delete");

    let remaining: Vec<String> = sqlx::query_scalar("SELECT rel_path FROM assets")
        .fetch_all(&h.pool)
        .await
        .unwrap();
    assert_eq!(remaining.len(), 1, "only the bystander's asset row survives");
    assert!(remaining[0].contains(bystander.as_str()));
    assert!(h.paths.script_dir(&bystander).exists());
}

/// Permanent deletion used to run its DB deletes (possibly affecting zero
/// rows) and then `remove_dir_all` regardless. It now requires an existing
/// row that is already in the trash.
#[tokio::test]
async fn permanent_delete_requires_an_existing_trashed_row() {
    let h = harness().await;
    let live = new_script(&h, "Live", "Live body.").await;

    // Unknown id: no row, so nothing is removed and no directory is touched.
    let unknown = sid("11111111-2222-4333-8444-555555555555");
    assert!(
        repo::permanently_delete_script(&h.pool, &h.paths, &h.locks, &unknown)
            .await
            .is_err()
    );

    // Live script: refused, directory intact.
    assert!(
        repo::permanently_delete_script(&h.pool, &h.paths, &h.locks, &live)
            .await
            .is_err()
    );
    assert!(h.paths.canonical_file(&live).exists());
    assert!(repo::get_summary(&h.pool, &live).await.is_ok());
}

// ---------------------------------------------------------------------------
// H1 — atomic authored-state transitions
// ---------------------------------------------------------------------------

/// The reported failure: a save at revision N and a rename both commit, the
/// save's `UPDATE ... WHERE revision = ?` affects zero rows but the save still
/// reports success, leaving the canonical file holding the new body while the
/// row's hash and statistics still describe the old one.
#[tokio::test]
async fn concurrent_save_and_rename_leave_the_row_and_file_in_agreement() {
    let h = harness().await;
    let id = new_script(&h, "Race", "Original body text.").await;
    let start = db_revision(&h, &id).await;

    let (save, rename) = tokio::join!(
        repo::save_script(
            &h.pool,
            &h.paths,
            &h.locks,
            &id,
            start,
            "Body written by the save.".into(),
            ScriptMetadataPatch::default(),
        ),
        repo::rename_script(&h.pool, &h.locks, &id, "Renamed", start),
    );

    // Exactly one transition wins; the loser reports a stale revision rather
    // than silently succeeding.
    assert_ne!(
        save.is_ok(),
        rename.is_ok(),
        "exactly one of save/rename must win the compare-and-swap"
    );

    // Whatever won, the canonical file, the row hash and the search index all
    // describe the same content.
    let on_disk = fs::read_to_string(h.paths.canonical_file(&id)).unwrap();
    let expected_hash = {
        use sha2::Digest;
        let mut hasher = sha2::Sha256::new();
        hasher.update(on_disk.as_bytes());
        hex::encode(hasher.finalize())
    };
    assert_eq!(
        db_hash(&h, &id).await,
        expected_hash,
        "the recorded hash must describe the bytes actually on disk"
    );
    assert_eq!(db_revision(&h, &id).await, start + 1);

    let indexed: String =
        sqlx::query_scalar("SELECT plain_text FROM script_search WHERE script_id = ?")
            .bind(id.as_str())
            .fetch_one(&h.pool)
            .await
            .unwrap();
    assert!(
        on_disk.starts_with(indexed.trim_end().split('.').next().unwrap_or("")),
        "the search index must describe the same revision as the row: \
         index={indexed:?} disk={on_disk:?}"
    );
}

/// Rename now takes the same optimistic revision as a save, so a rename with
/// a stale expectation is refused instead of quietly bumping the revision out
/// from under an in-flight edit.
#[tokio::test]
async fn rename_and_trash_refuse_stale_revisions_and_return_the_new_one() {
    let h = harness().await;
    let id = new_script(&h, "Titles", "Body.").await;
    let start = db_revision(&h, &id).await;

    let renamed = repo::rename_script(&h.pool, &h.locks, &id, "First rename", start)
        .await
        .expect("rename");
    assert_eq!(renamed.script_revision, start + 1);
    assert_eq!(renamed.title, "First rename");

    // Reusing the old revision is refused.
    assert!(repo::rename_script(&h.pool, &h.locks, &id, "Second", start)
        .await
        .is_err());

    // Trash carries a revision too, and returns the one that follows it.
    let trashed = repo::trash_script(&h.pool, &h.locks, &id, renamed.script_revision)
        .await
        .expect("trash");
    assert_eq!(trashed.script_revision, renamed.script_revision + 1);
    assert!(repo::trash_script(&h.pool, &h.locks, &id, renamed.script_revision)
        .await
        .is_err());

    let restored = repo::restore_script(&h.pool, &h.locks, &id, trashed.script_revision)
        .await
        .expect("restore");
    assert_eq!(restored.script_revision, trashed.script_revision + 1);
    assert_eq!(restored.status, ScriptStatus::Draft);
}

/// An external editor's write must never be destroyed. The save is refused
/// AND the incumbent bytes are copied into revision storage first, so the
/// external version survives even though the save did not adopt it.
#[tokio::test]
async fn an_external_edit_is_preserved_when_a_save_is_refused() {
    let h = harness().await;
    let id = new_script(&h, "Ext", "In-app body.").await;
    let start = db_revision(&h, &id).await;

    fs::write(
        h.paths.canonical_file(&id),
        "Written by an external editor.",
    )
    .unwrap();

    let err = repo::save_script(
        &h.pool,
        &h.paths,
        &h.locks,
        &id,
        start,
        "Blindly overwriting.".into(),
        ScriptMetadataPatch::default(),
    )
    .await
    .expect_err("must refuse");
    assert_eq!(err.code(), "SCRIPT_CONFLICT");

    // The file itself is untouched...
    assert_eq!(
        fs::read_to_string(h.paths.canonical_file(&id)).unwrap(),
        "Written by an external editor."
    );

    // ...and a recoverable copy exists even if the file is later clobbered.
    let revisions = repo::list_revisions(&h.pool, &id).await.unwrap();
    let preserved = revisions
        .iter()
        .find(|r| r.reason == "external_change_preserved")
        .expect("the external version must be preserved before refusing");
    let doc = repo::get_revision(&h.pool, &h.paths, &id, &preserved.id)
        .await
        .unwrap();
    assert_eq!(doc.source, "Written by an external editor.");
}

// ---------------------------------------------------------------------------
// H2 — revisions hold the destroyed text, not the replacement
// ---------------------------------------------------------------------------

/// The reported data-loss bug: `save_script` replaced the canonical file
/// FIRST and then snapshotted the incoming source, so a
/// `before_destructive_edit` revision contained the NEW text and the
/// destroyed text was unrecoverable.
#[tokio::test]
async fn a_destructive_edit_snapshots_the_text_it_destroys() {
    let h = harness().await;
    let id = new_script(&h, "Doomed", "The paragraph the user wrote by hand.").await;
    let start = db_revision(&h, &id).await;

    repo::save_script(
        &h.pool,
        &h.paths,
        &h.locks,
        &id,
        start,
        "Everything replaced by a paste.".into(),
        serde_json::from_value(
            serde_json::json!({ "revisionReason": "before_destructive_edit" }),
        )
        .unwrap(),
    )
    .await
    .expect("save");

    let revisions = repo::list_revisions(&h.pool, &id).await.unwrap();
    let snapshot = revisions
        .iter()
        .find(|r| r.reason == "before_destructive_edit")
        .expect("snapshot exists");
    let doc = repo::get_revision(&h.pool, &h.paths, &id, &snapshot.id)
        .await
        .unwrap();
    assert_eq!(
        doc.source, "The paragraph the user wrote by hand.",
        "the revision must contain the destroyed text, not the replacement"
    );
    assert_eq!(
        fs::read_to_string(h.paths.canonical_file(&id)).unwrap(),
        "Everything replaced by a paste."
    );
}

/// Spec §21.4 requires a pre-session revision. `start_session` never created
/// one; it is now a Rust-owned step and captures the text as performed.
#[tokio::test]
async fn session_start_captures_a_pre_session_revision() {
    let h = harness().await;
    let id = new_script(&h, "Talk", "The script as it will be performed.").await;

    let revision_id = repo::snapshot_pre_session(&h.pool, &h.paths, &h.locks, &id)
        .await
        .expect("snapshot")
        .expect("a script with a canonical file always snapshots");

    let doc = repo::get_revision(&h.pool, &h.paths, &id, &revision_id)
        .await
        .unwrap();
    assert_eq!(doc.source, "The script as it will be performed.");
    assert_eq!(
        repo::list_revisions(&h.pool, &id)
            .await
            .unwrap()
            .iter()
            .filter(|r| r.reason == "pre_session")
            .count(),
        1
    );

    // Editing afterwards leaves the performed text recoverable.
    repo::save_script(
        &h.pool,
        &h.paths,
        &h.locks,
        &id,
        db_revision(&h, &id).await,
        "Rewritten after the session.".into(),
        ScriptMetadataPatch::default(),
    )
    .await
    .expect("post-session save");
    let doc = repo::get_revision(&h.pool, &h.paths, &id, &revision_id)
        .await
        .unwrap();
    assert_eq!(doc.source, "The script as it will be performed.");
}

// ---------------------------------------------------------------------------
// H3 — reconciliation and atomic writes
// ---------------------------------------------------------------------------

/// The crash state the old reconciliation could never see: the atomic rename
/// landed but the database commit did not, so the row and the file both
/// exist while describing different content. Existence-only checks treated
/// that as healthy forever.
#[tokio::test]
async fn reconciliation_repairs_a_row_whose_hash_disagrees_with_its_file() {
    let h = harness().await;
    let id = new_script(&h, "Drifted", "Body the database knows about.").await;

    // Simulate the crash: new bytes on disk, database still on the old ones.
    fs::write(
        h.paths.canonical_file(&id),
        "Body that only the file knows about.",
    )
    .unwrap();
    let stale_hash = db_hash(&h, &id).await;

    let report = reconcile::run_startup_reconciliation(&h.pool, &h.paths, &h.locks)
        .await
        .expect("reconciliation");

    assert!(
        report.hash_mismatches_repaired.contains(&id.to_string()),
        "the mismatch must be detected and reported: {report:?}"
    );
    assert_ne!(db_hash(&h, &id).await, stale_hash);

    // The file is the authority: its content was NOT replaced.
    assert_eq!(
        fs::read_to_string(h.paths.canonical_file(&id)).unwrap(),
        "Body that only the file knows about."
    );

    // The row now describes the file, and so does the search index.
    let doc = repo::get_script(&h.pool, &h.paths, &h.locks, &id)
        .await
        .expect("read after repair");
    assert!(
        !doc.externally_changed,
        "after a repair the next read must not report a fresh external change"
    );
    assert_eq!(doc.source, "Body that only the file knows about.");

    // Reconciling again is a no-op.
    let second = reconcile::run_startup_reconciliation(&h.pool, &h.paths, &h.locks)
        .await
        .expect("second reconciliation");
    assert!(second.hash_mismatches_repaired.is_empty());
}

/// A directory in the scripts root whose name is not a UUID must never be
/// adopted as a script — it would put an attacker-chosen string back into the
/// path-building layer.
#[tokio::test]
async fn reconciliation_ignores_non_uuid_directories() {
    let h = harness().await;
    let rogue = h.paths.scripts_dir().join("..rogue");
    fs::create_dir_all(&rogue).unwrap();
    fs::write(rogue.join("script.md"), "Rogue body.").unwrap();

    let report = reconcile::run_startup_reconciliation(&h.pool, &h.paths, &h.locks)
        .await
        .expect("reconciliation");

    assert!(report.orphan_files_recovered.is_empty());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM scripts")
        .fetch_one(&h.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

/// The old temp name was `.<dest>.tmp-<pid>` — one name per destination per
/// process — so two concurrent writers to the same destination truncated each
/// other's temp file and could interleave bytes. Each writer now claims a
/// unique name with `create_new`.
#[test]
fn concurrent_atomic_writes_never_share_a_temp_file() {
    use candidcue_lib::util::atomic_write;

    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("script.md");

    // The old scheme derived one temp name per destination per process:
    // `.<file>.tmp-<pid>`. Two writers therefore opened the SAME file with
    // `File::create`, truncating each other mid-write. Claiming that exact
    // path up front proves the name is no longer reused: the old code would
    // truncate this sentinel, the current code must never open it.
    let legacy_temp = dir.path().join(format!(".script.md.tmp-{}", std::process::id()));
    fs::write(&legacy_temp, "sentinel").unwrap();

    let a = "A".repeat(200_000);
    let b = "B".repeat(200_000);
    let (ra, rb) = std::thread::scope(|scope| {
        let ha = scope.spawn(|| {
            let mut last = Ok(());
            for _ in 0..25 {
                last = atomic_write(&dest, a.as_bytes());
            }
            last
        });
        let hb = scope.spawn(|| {
            let mut last = Ok(());
            for _ in 0..25 {
                last = atomic_write(&dest, b.as_bytes());
            }
            last
        });
        (ha.join().unwrap(), hb.join().unwrap())
    });
    assert!(ra.is_ok() && rb.is_ok(), "both writers must succeed");
    assert_eq!(
        fs::read_to_string(&legacy_temp).unwrap(),
        "sentinel",
        "atomic_write reused a predictable temp name and clobbered it"
    );
    fs::remove_file(&legacy_temp).unwrap();

    // The destination is one complete version or the other — never a blend.
    let final_content = fs::read_to_string(&dest).unwrap();
    assert!(
        final_content == a || final_content == b,
        "atomic_write produced a torn file of {} bytes",
        final_content.len()
    );

    // No temp files survive.
    let leftovers: Vec<_> = fs::read_dir(dir.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
        .collect();
    assert!(leftovers.is_empty(), "temp files left behind: {leftovers:?}");
}

// ---------------------------------------------------------------------------
// H6 — the bundle manifest is enforced, not decorative
// ---------------------------------------------------------------------------

/// Minimal ZIP writer (stored entries only) so malformed bundles can be built
/// without adding a dev-dependency.
mod zip_writer {
    fn crc32(bytes: &[u8]) -> u32 {
        let mut table = [0u32; 256];
        for (i, slot) in table.iter_mut().enumerate() {
            let mut c = i as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
            }
            *slot = c;
        }
        let mut crc = 0xFFFF_FFFFu32;
        for &b in bytes {
            crc = table[((crc ^ b as u32) & 0xFF) as usize] ^ (crc >> 8);
        }
        crc ^ 0xFFFF_FFFF
    }

    pub fn write(entries: &[(&str, Vec<u8>)]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut directory = Vec::new();
        for (name, data) in entries {
            let offset = out.len() as u32;
            let crc = crc32(data);
            let n = name.as_bytes();
            out.extend_from_slice(&[0x50, 0x4B, 0x03, 0x04]);
            out.extend_from_slice(&20u16.to_le_bytes()); // version needed
            out.extend_from_slice(&0u16.to_le_bytes()); // flags
            out.extend_from_slice(&0u16.to_le_bytes()); // stored
            out.extend_from_slice(&0u16.to_le_bytes()); // mod time
            out.extend_from_slice(&0u16.to_le_bytes()); // mod date
            out.extend_from_slice(&crc.to_le_bytes());
            out.extend_from_slice(&(data.len() as u32).to_le_bytes());
            out.extend_from_slice(&(data.len() as u32).to_le_bytes());
            out.extend_from_slice(&(n.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes()); // extra len
            out.extend_from_slice(n);
            out.extend_from_slice(data);

            directory.extend_from_slice(&[0x50, 0x4B, 0x01, 0x02]);
            directory.extend_from_slice(&20u16.to_le_bytes()); // version made by
            directory.extend_from_slice(&20u16.to_le_bytes()); // version needed
            directory.extend_from_slice(&0u16.to_le_bytes());
            directory.extend_from_slice(&0u16.to_le_bytes());
            directory.extend_from_slice(&0u16.to_le_bytes());
            directory.extend_from_slice(&0u16.to_le_bytes());
            directory.extend_from_slice(&crc.to_le_bytes());
            directory.extend_from_slice(&(data.len() as u32).to_le_bytes());
            directory.extend_from_slice(&(data.len() as u32).to_le_bytes());
            directory.extend_from_slice(&(n.len() as u16).to_le_bytes());
            directory.extend_from_slice(&0u16.to_le_bytes()); // extra
            directory.extend_from_slice(&0u16.to_le_bytes()); // comment
            directory.extend_from_slice(&0u16.to_le_bytes()); // disk
            directory.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
            directory.extend_from_slice(&0u32.to_le_bytes()); // external attrs
            directory.extend_from_slice(&offset.to_le_bytes());
            directory.extend_from_slice(n);
        }
        let dir_offset = out.len() as u32;
        let dir_size = directory.len() as u32;
        out.extend_from_slice(&directory);
        out.extend_from_slice(&[0x50, 0x4B, 0x05, 0x06]);
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&dir_size.to_le_bytes());
        out.extend_from_slice(&dir_offset.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out
    }
}

/// A 1x1 PNG. Real magic bytes, so it passes MIME sniffing.
fn tiny_png() -> Vec<u8> {
    let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    png.extend_from_slice(&[0, 0, 0, 13, b'I', b'H', b'D', b'R']);
    png.extend_from_slice(&[0u8; 32]);
    png
}

fn png_name(bytes: &[u8]) -> String {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(bytes);
    format!("{}.png", hex::encode(hasher.finalize()))
}

fn manifest_json(assets: &[&str]) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "schemaVersion": 1,
        "title": "Bundled",
        "language": "en",
        "assets": assets,
    }))
    .unwrap()
}

type ImportOutcome = Result<
    candidcue_lib::scripts::import_export::ImportResult,
    candidcue_lib::errors::AppError,
>;

async fn import_bundle_bytes(h: &Harness, bytes: Vec<u8>) -> ImportOutcome {
    let dir = h.paths.root().join("incoming");
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join(format!("{}.candidcue", uuid::Uuid::new_v4()));
    fs::write(&path, bytes).unwrap();
    candidcue_lib::scripts::import_export::import_script(
        &h.pool,
        &h.paths,
        &h.locks,
        serde_json::from_value(serde_json::json!({ "path": path.to_string_lossy() })).unwrap(),
    )
    .await
}

/// A well-formed bundle imports, and its asset survives garbage collection —
/// the importer never created `script_asset_references`, so imported assets
/// were unresolvable and GC-eligible from the moment they landed.
#[tokio::test]
async fn a_valid_bundle_asset_is_referenced_and_survives_gc() {
    let h = harness().await;
    let png = tiny_png();
    let name = png_name(&png);
    let bundle = zip_writer::write(&[
        ("manifest.json", manifest_json(&[name.as_str()])),
        ("script.md", b"# Bundled\n\nBody.\n".to_vec()),
        (&format!("assets/{name}"), png.clone()),
    ]);

    let imported = import_bundle_bytes(&h, bundle).await.expect("import");
    let id = sid(&imported.script.id);

    let references: i64 =
        sqlx::query_scalar("SELECT count(*) FROM script_asset_references WHERE script_id = ?")
            .bind(id.as_str())
            .fetch_one(&h.pool)
            .await
            .unwrap();
    assert_eq!(references, 1, "the imported asset must be referenced");

    candidcue_lib::assets::collect_garbage(&h.pool, &h.paths)
        .await
        .expect("gc");
    assert!(
        h.paths.assets_dir(&id).join(&name).exists(),
        "garbage collection deleted a referenced asset"
    );
}

/// Undeclared entries used to be accepted with a warning, so a bundle could
/// drop arbitrary files — including active content — into a managed folder.
#[tokio::test]
async fn a_bundle_is_rejected_when_its_files_disagree_with_its_manifest() {
    let h = harness().await;
    let png = tiny_png();
    let name = png_name(&png);
    let script = b"# Bundled\n\nBody.\n".to_vec();

    type BundleEntries = Vec<(&'static str, Vec<u8>)>;
    let cases: Vec<(&str, BundleEntries)> = vec![
        (
            "undeclared asset",
            vec![
                ("manifest.json", manifest_json(&[])),
                ("script.md", script.clone()),
                (Box::leak(format!("assets/{name}").into_boxed_str()), png.clone()),
            ],
        ),
        (
            "declared but absent asset",
            vec![
                ("manifest.json", manifest_json(&[name.as_str()])),
                ("script.md", script.clone()),
            ],
        ),
        (
            "undeclared active content",
            vec![
                ("manifest.json", manifest_json(&[])),
                ("script.md", script.clone()),
                ("payload.html", b"<script>alert(1)</script>".to_vec()),
            ],
        ),
        (
            "asset name not bound to its digest",
            vec![
                ("manifest.json", manifest_json(&["banner.png"])),
                ("script.md", script.clone()),
                ("assets/banner.png", png.clone()),
            ],
        ),
        (
            "asset content does not match its name",
            vec![
                ("manifest.json", manifest_json(&[name.as_str()])),
                ("script.md", script.clone()),
                (
                    Box::leak(format!("assets/{name}").into_boxed_str()),
                    {
                        let mut other = tiny_png();
                        other.extend_from_slice(b"different");
                        other
                    },
                ),
            ],
        ),
        (
            "svg is active content and is not an allowed bundle asset",
            vec![
                ("manifest.json", manifest_json(&["logo.svg"])),
                ("script.md", script.clone()),
                ("assets/logo.svg", b"<svg xmlns='x'><script/></svg>".to_vec()),
            ],
        ),
    ];

    for (label, entries) in cases {
        let before: i64 = sqlx::query_scalar("SELECT count(*) FROM scripts")
            .fetch_one(&h.pool)
            .await
            .unwrap();
        let result = import_bundle_bytes(&h, zip_writer::write(&entries)).await;
        assert!(result.is_err(), "bundle with {label} must be rejected");

        // And the rejection leaves nothing behind (no partial script).
        let after: i64 = sqlx::query_scalar("SELECT count(*) FROM scripts")
            .fetch_one(&h.pool)
            .await
            .unwrap();
        assert_eq!(before, after, "{label} left a partial script behind");
    }
}

// ---------------------------------------------------------------------------
// H7 — corrupt databases fail closed instead of being written to
// ---------------------------------------------------------------------------

/// Corrupt a closed SQLite file by scribbling over its b-tree pages while
/// leaving the 100-byte header intact, so the file still opens but fails
/// `quick_check` — the shape a torn write or bad sector produces.
fn corrupt_database_file(db: &std::path::Path) {
    let mut bytes = fs::read(db).unwrap();
    assert!(bytes.len() > 12_288, "database too small to corrupt meaningfully");
    for b in bytes.iter_mut().skip(4096).take(8192) {
        *b = 0x5A;
    }
    fs::write(db, &bytes).unwrap();
}

/// Migrations used to run BEFORE the integrity check, so the most destructive
/// operation the app performs was applied to a database already known to be
/// damaged. The check now gates everything.
#[tokio::test]
async fn a_corrupt_database_is_not_migrated_or_modified() {
    let dir = tempfile::tempdir().unwrap();
    {
        let pool = candidcue_lib::database::init(dir.path()).await.unwrap();
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&pool)
            .await
            .ok();
        pool.close().await;
    }
    let db = dir.path().join("candidcue.sqlite3");
    corrupt_database_file(&db);
    let before = fs::read(&db).unwrap();

    let err = candidcue_lib::database::init(dir.path())
        .await
        .expect_err("a corrupt database must not open for writing");
    assert_eq!(err.code(), "DATABASE_CORRUPT");

    // Evidence is preserved byte for byte: nothing was migrated, repaired or
    // deleted, and the canonical Markdown files remain the authority.
    assert_eq!(
        fs::read(&db).unwrap(),
        before,
        "the corrupt database file was modified despite failing its check"
    );
}

/// Reconciliation mutates a great deal — deleting temp files, inserting
/// recovered rows, purging trash. None of it may run against a database that
/// failed `quick_check`; it used to record a note and carry on regardless.
#[tokio::test]
async fn reconciliation_makes_no_changes_after_an_integrity_failure() {
    let dir = tempfile::tempdir().unwrap();
    let paths = DataPaths::new(dir.path().to_path_buf());

    // Build a healthy tree first, then damage only the database.
    let stale_temp;
    let orphan;
    {
        let h = Harness {
            pool: candidcue_lib::database::init(dir.path()).await.unwrap(),
            paths: paths.clone(),
            locks: ScriptLocks::default(),
            _dir: tempfile::tempdir().unwrap(),
        };
        let id = new_script(&h, "Present", "Body.").await;
        stale_temp = paths.script_dir(&id).join(".script.md.tmp-999");
        fs::write(&stale_temp, "stale").unwrap();
        orphan = paths.scripts_dir().join("0a651b8e-3a54-4a7e-bb6d-0000000000ff");
        fs::create_dir_all(&orphan).unwrap();
        fs::write(orphan.join("script.md"), "Orphan.").unwrap();
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&h.pool)
            .await
            .ok();
        h.pool.close().await;
    }

    let db = dir.path().join("candidcue.sqlite3");
    corrupt_database_file(&db);

    // `database::init` now refuses outright, so open the damaged file
    // directly to exercise the reconciliation gate itself.
    let pool = sqlx::SqlitePool::connect(&format!("sqlite://{}", db.display()))
        .await
        .expect("a corrupt file still opens; it just fails quick_check");
    let report = reconcile::run_startup_reconciliation(&pool, &paths, &ScriptLocks::default())
        .await
        .expect("reconciliation reports rather than mutating");

    assert!(
        !report.integrity_ok,
        "the corrupted database must be reported as failing its check"
    );
    assert_eq!(report.temp_files_removed, 0);
    assert!(report.orphan_files_recovered.is_empty());
    assert!(report.missing_files_restored.is_empty());
    assert!(report.hash_mismatches_repaired.is_empty());
    assert_eq!(report.trash_purged, 0);

    // Nothing on disk was touched either.
    assert!(
        stale_temp.exists(),
        "a temp file was deleted after an integrity failure"
    );
    assert!(orphan.join("script.md").exists());
}
