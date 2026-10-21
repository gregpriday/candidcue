//! Regression tests for the script-id, concurrency, and recovery defects.
//!
//! Every test here fails against the code as it stood before the fix; the
//! comment on each says which defect it pins down.

use std::fs;

use speaking_glass_lib::scripts::import_export::ExportOptions;
use speaking_glass_lib::scripts::{
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
    let pool = speaking_glass_lib::database::init(dir.path())
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

    let (indexed, body): (String, String) =
        sqlx::query_as("SELECT plain_text, body FROM script_search WHERE script_id = ?")
            .bind(id.as_str())
            .fetch_one(&h.pool)
            .await
            .unwrap();
    assert!(
        on_disk.starts_with(indexed.trim_end().split('.').next().unwrap_or("")),
        "the search index must describe the same revision as the row: \
         index={indexed:?} disk={on_disk:?}"
    );
    assert_eq!(body, on_disk, "and so must the page text it searches (#254)");
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
    use speaking_glass_lib::util::atomic_write;

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
        let plain: Vec<(&str, Vec<u8>, Option<u32>)> =
            entries.iter().map(|(name, data)| (*name, data.clone(), None)).collect();
        write_with_modes(&plain)
    }

    /// Entries that carry a Unix mode, the way a zip made on macOS or Linux
    /// does: a Unix host in "version made by" and the mode in the top half of
    /// the external attributes. `None` writes both as `write` always has.
    pub fn write_with_modes(entries: &[(&str, Vec<u8>, Option<u32>)]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut directory = Vec::new();
        for (name, data, mode) in entries {
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
            let made_by: u16 = if mode.is_some() { (3 << 8) | 20 } else { 20 };
            directory.extend_from_slice(&made_by.to_le_bytes()); // version made by
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
            directory.extend_from_slice(&(mode.unwrap_or(0) << 16).to_le_bytes()); // external attrs
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

/// A genuine, decodable 1×1 PNG.
///
/// This used to be a PNG signature followed by 32 zero bytes: correct magic
/// bytes in front of garbage. That was enough for the old importer, which
/// sniffed a four-byte prefix and stopped there. Bundle assets are now put
/// through a real decode under dimension limits (H4), so a fixture has to be an
/// actual image — which is the point.
fn tiny_png() -> Vec<u8> {
    vec![
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90,
        0x77, 0x53, 0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, 0x78, 0xDA, 0x63, 0xF8,
        0xCF, 0xC0, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00, 0xF7, 0x03, 0x41, 0x43, 0x00, 0x00, 0x00,
        0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ]
}

/// A PNG header claiming 30000×30000 (900 megapixels) with a trivial payload —
/// about 100 bytes on the wire, 3.6 GB decoded.
fn png_decompression_bomb() -> Vec<u8> {
    fn crc(bytes: &[u8]) -> u32 {
        let mut table = [0u32; 256];
        for (i, entry) in table.iter_mut().enumerate() {
            let mut c = i as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
            }
            *entry = c;
        }
        let mut c = 0xFFFF_FFFFu32;
        for b in bytes {
            c = table[((c ^ u32::from(*b)) & 0xFF) as usize] ^ (c >> 8);
        }
        c ^ 0xFFFF_FFFF
    }
    let mut ihdr = b"IHDR".to_vec();
    ihdr.extend_from_slice(&30_000u32.to_be_bytes());
    ihdr.extend_from_slice(&30_000u32.to_be_bytes());
    ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
    let mut out = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    out.extend_from_slice(&13u32.to_be_bytes());
    out.extend_from_slice(&ihdr);
    out.extend_from_slice(&crc(&ihdr).to_be_bytes());
    out.extend_from_slice(&[0u8; 64]);
    out
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
    speaking_glass_lib::scripts::import_export::ImportResult,
    speaking_glass_lib::errors::AppError,
>;

async fn import_bundle_bytes(h: &Harness, bytes: Vec<u8>) -> ImportOutcome {
    let dir = h.paths.root().join("incoming");
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join(format!("{}.speakingglass", uuid::Uuid::new_v4()));
    fs::write(&path, bytes).unwrap();
    speaking_glass_lib::scripts::import_export::import_script(
        &h.pool,
        &h.paths,
        &h.locks,
        // `ImportOptions` is the already-authorized internal shape: it is
        // constructed here the same way the command constructs it, from a path
        // the Rust-side dialog produced. It has no `Deserialize` impl any more,
        // which is what stops a webview payload from ever becoming one (H5).
        speaking_glass_lib::scripts::import_export::ImportOptions {
            path: path.to_string_lossy().to_string(),
            title: None,
        },
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

    speaking_glass_lib::assets::collect_garbage(&h.pool, &h.paths)
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
        let pool = speaking_glass_lib::database::init(dir.path()).await.unwrap();
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&pool)
            .await
            .ok();
        pool.close().await;
    }
    let db = dir.path().join("speaking-glass.sqlite3");
    corrupt_database_file(&db);
    let before = fs::read(&db).unwrap();

    let err = speaking_glass_lib::database::init(dir.path())
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
            pool: speaking_glass_lib::database::init(dir.path()).await.unwrap(),
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

    let db = dir.path().join("speaking-glass.sqlite3");
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

/// The other side of that gate: a HEALTHY database must pass it.
///
/// SQLite's FTS5 answers its part of `quick_check` from the search index's
/// structure as the connection running the check last read it, without asking
/// whether another connection has written since. So a pooled connection that
/// checked once, then sat idle while a script was saved through another one,
/// reported "malformed inverted index for FTS5 table main.script_search" — and
/// reconciliation, failing closed, adopted and repaired nothing that launch.
/// Which connection the pool handed the check was a matter of timing, which is
/// how `a_folder_that_cannot_be_adopted_yet_keeps_its_name_for_the_retry`
/// failed on CI runners and almost never on a Mac. The pool reconciling here
/// has one connection, so the check would land on the stale one every time.
#[tokio::test]
async fn a_search_index_written_through_another_connection_still_passes_the_check() {
    let h = harness().await;
    let one_connection = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with((*h.pool.connect_options()).clone())
        .await
        .expect("a second pool on the same database");

    let first = reconcile::run_startup_reconciliation(&one_connection, &h.paths, &h.locks)
        .await
        .expect("reconciliation");
    assert!(first.integrity_ok, "{first:?}");

    new_script(&h, "Saved elsewhere", "Through the other pool.").await;

    let second = reconcile::run_startup_reconciliation(&one_connection, &h.paths, &h.locks)
        .await
        .expect("reconciliation");
    assert!(
        second.integrity_ok,
        "a search index another connection wrote is not a corrupt one: {second:?}"
    );
    one_connection.close().await;
}

// ---------------------------------------------------------------------------
// H5: caller-supplied paths (spec §50.7)
// ---------------------------------------------------------------------------

fn export_options(destination: &std::path::Path, format: &str) -> ExportOptions {
    ExportOptions {
        destination: destination.to_string_lossy().to_string(),
        format: format.to_string(),
        include_assets: false,
    }
}

/// The defect: `write_bundle` called `fs::File::create(destination)`, which
/// truncates the target the instant it opens. Aiming an export at an existing
/// file destroyed it before a single byte of the bundle was written, and a
/// failure part-way through left a corrupt stub behind. The export is now an
/// atomic replace: the zip is built in a temporary file and renamed over the
/// destination.
#[tokio::test]
async fn a_failed_bundle_export_does_not_destroy_the_destination() {
    let h = harness().await;
    let id = new_script(&h, "Talk", "# Talk\n\nBody.\n").await;
    let external = tempfile::tempdir().unwrap();

    let precious = external.path().join("precious.speakingglass");
    fs::write(&precious, b"IRREPLACEABLE\n").unwrap();

    // A directory where the file should be makes the rename fail late, after
    // the zip has been fully written — exactly the "half-way through" case.
    let blocked = external.path().join("blocked.speakingglass");
    fs::create_dir_all(&blocked).unwrap();
    let err = speaking_glass_lib::scripts::import_export::export_script(
        &h.pool,
        &h.paths,
        &h.locks,
        &id,
        export_options(&blocked, "bundle"),
    )
    .await
    .expect_err("a directory is not a usable export destination");
    assert_eq!(err.code(), "IMPORT_UNSAFE_PATH", "{err:?}");

    // And a successful export leaves no temp files lying around next to it.
    speaking_glass_lib::scripts::import_export::export_script(
        &h.pool,
        &h.paths,
        &h.locks,
        &id,
        export_options(&precious, "bundle"),
    )
    .await
    .expect("bundle export");
    let leftovers: Vec<_> = fs::read_dir(external.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
        .collect();
    assert!(leftovers.is_empty(), "bundle export left a temp file behind");
    assert_ne!(fs::read(&precious).unwrap(), b"IRREPLACEABLE\n");
}

/// An export must never be written through a symlink: "save as notes.md" would
/// otherwise become "overwrite whatever notes.md points at".
#[cfg(unix)]
#[tokio::test]
async fn an_export_refuses_to_write_through_a_symlink() {
    let h = harness().await;
    let id = new_script(&h, "Talk", "# Talk\n\nBody.\n").await;
    let external = tempfile::tempdir().unwrap();

    let secret = external.path().join("id_rsa");
    fs::write(&secret, b"PRIVATE KEY\n").unwrap();
    let link = external.path().join("innocent.md");
    std::os::unix::fs::symlink(&secret, &link).unwrap();

    for format in ["markdown", "text", "bundle"] {
        let err = speaking_glass_lib::scripts::import_export::export_script(
            &h.pool,
            &h.paths,
            &h.locks,
            &id,
            export_options(&link, format),
        )
        .await
        .expect_err("a symlinked destination must be refused");
        assert_eq!(err.code(), "IMPORT_UNSAFE_PATH", "{format}: {err:?}");
    }
    assert_eq!(fs::read(&secret).unwrap(), b"PRIVATE KEY\n");
}

/// Speaking Glass's own managed storage is not a valid export destination: writing
/// there can overwrite a canonical script, a revision, or the database itself.
#[tokio::test]
async fn an_export_refuses_the_apps_own_storage() {
    let h = harness().await;
    let id = new_script(&h, "Talk", "# Talk\n\nBody.\n").await;

    let canonical = h.paths.canonical_file(&id);
    let err = speaking_glass_lib::scripts::import_export::export_script(
        &h.pool,
        &h.paths,
        &h.locks,
        &id,
        export_options(&canonical, "markdown"),
    )
    .await
    .expect_err("managed storage must be refused");
    assert_eq!(err.code(), "IMPORT_UNSAFE_PATH", "{err:?}");
    // The canonical file is untouched and still readable.
    assert_eq!(
        fs::read_to_string(&canonical).unwrap(),
        "# Talk\n\nBody.\n"
    );
}

/// Import must refuse anything that is not a plain file. A fifo in particular
/// would block the command forever, and a symlink is how a picker result gets
/// redirected at a file the operator never saw.
#[cfg(unix)]
#[tokio::test]
async fn an_import_refuses_symlinks_and_non_files() {
    let h = harness().await;
    let external = tempfile::tempdir().unwrap();

    let real = external.path().join("real.md");
    fs::write(&real, "# Real\n").unwrap();
    let link = external.path().join("link.md");
    std::os::unix::fs::symlink(&real, &link).unwrap();

    let err = speaking_glass_lib::scripts::import_export::import_script(
        &h.pool,
        &h.paths,
        &h.locks,
        speaking_glass_lib::scripts::import_export::ImportOptions {
            path: link.to_string_lossy().to_string(),
            title: None,
        },
    )
    .await
    .expect_err("symlinks are refused");
    assert_eq!(err.code(), "IMPORT_UNSAFE_PATH", "{err:?}");

    let dir = external.path().join("adirectory.md");
    fs::create_dir_all(&dir).unwrap();
    let err = speaking_glass_lib::scripts::import_export::import_script(
        &h.pool,
        &h.paths,
        &h.locks,
        speaking_glass_lib::scripts::import_export::ImportOptions {
            path: dir.to_string_lossy().to_string(),
            title: None,
        },
    )
    .await
    .expect_err("a directory is not importable");
    assert_eq!(err.code(), "IMPORT_UNSAFE_PATH", "{err:?}");
}

/// H4, bundle edge: the importer verified magic bytes only, so a PNG header in
/// front of nothing — or one declaring 900 megapixels — was written straight
/// into a script's asset directory and later handed to the stage webview's
/// decoder. Bundle assets now have to survive a real decode under dimension
/// limits, like every other import path.
#[tokio::test]
async fn a_bundle_asset_must_be_a_decodable_image() {
    for (label, bytes) in [
        ("a PNG header in front of garbage", {
            let mut fake = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
            fake.extend_from_slice(&[0u8; 64]);
            fake
        }),
        ("a 30000x30000 decompression bomb", png_decompression_bomb()),
    ] {
        let h = harness().await;
        let name = png_name(&bytes);
        let bundle = zip_writer::write(&[
            ("manifest.json", manifest_json(&[name.as_str()])),
            ("script.md", b"# Bundled\n\nBody.\n".to_vec()),
            (&format!("assets/{name}"), bytes.clone()),
        ]);
        let err = import_bundle_bytes(&h, bundle)
            .await
            .expect_err(label);
        assert_eq!(err.code(), "IMPORT_INVALID_FORMAT", "{label}: {err:?}");
    }
}

/// RUSTSEC-2026-0367 to -0369 were in `zip`'s own extraction
/// (`ZipArchive::extract` and friends): it kept setuid and setgid bits, wrote
/// symlinks that point outside the destination and applied permissions through
/// symlinks. zip 9 fixed them, and the importer was never exposed, because it
/// does not extract: it reads each entry into memory and writes assets itself.
/// These check that it refuses a symlink entry and that an asset lands without
/// the special or execute bits its archive entry carries.
#[tokio::test]
async fn a_bundle_symlink_entry_is_refused() {
    let h = harness().await;
    let png = tiny_png();
    let name = png_name(&png);
    let asset = format!("assets/{name}");
    let bundle = zip_writer::write_with_modes(&[
        ("manifest.json", manifest_json(&[name.as_str()]), None),
        ("script.md", b"# Bundled\n\nBody.\n".to_vec(), None),
        // A symlink entry's data is its target.
        (asset.as_str(), b"/etc/passwd".to_vec(), Some(0o120777)),
    ]);

    let err = import_bundle_bytes(&h, bundle)
        .await
        .expect_err("a symlink entry must be refused");
    assert_eq!(err.code(), "IMPORT_UNSAFE_PATH", "{err:?}");
}

/// Unix only: NTFS has no mode bits for an archive entry's to reach.
#[cfg(unix)]
#[tokio::test]
async fn a_bundle_asset_lands_without_its_archive_permission_bits() {
    use std::os::unix::fs::PermissionsExt;

    let h = harness().await;
    let png = tiny_png();
    let name = png_name(&png);
    let asset = format!("assets/{name}");
    let bundle = zip_writer::write_with_modes(&[
        ("manifest.json", manifest_json(&[name.as_str()]), None),
        ("script.md", b"# Bundled\n\nBody.\n".to_vec(), None),
        // setuid, setgid, sticky and executable, on a regular file.
        (asset.as_str(), png.clone(), Some(0o107777)),
    ]);
    // The archive really carries the bits, or the assertion below proves nothing.
    // Read the raw external attributes: since zip 9, `unix_mode()` clears the
    // setuid, setgid and sticky bits before returning them.
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(&bundle[..])).unwrap();
    assert_eq!(archive.by_name(&asset).unwrap().external_attributes() >> 16, 0o107777);
    drop(archive);

    let imported = import_bundle_bytes(&h, bundle).await.expect("import");
    let path = h.paths.assets_dir(&sid(&imported.script.id)).join(&name);
    let mode = fs::metadata(&path).unwrap().permissions().mode();
    assert_eq!(
        mode & 0o7111,
        0,
        "the archive's special or execute bits reached disk: {mode:o}"
    );
}

/// The importer judges an entry by its decoded name, and `zip` decodes these
/// ASCII names without sanitising them, so a traversal or absolute name reaches
/// `is_safe_relative_path` intact and is refused there, rather than being
/// quietly rewritten into a path inside the bundle. The message pins the check:
/// `assets/../escape.png` would otherwise also fail the later asset-name check.
#[tokio::test]
async fn a_bundle_entry_with_an_unsafe_name_is_refused() {
    let h = harness().await;
    for name in [
        "../escape.md",
        "/absolute.md",
        "assets/../escape.png",
        "assets\\..\\escape.png",
        "C:escape.md",
    ] {
        let before: i64 = sqlx::query_scalar("SELECT count(*) FROM scripts")
            .fetch_one(&h.pool)
            .await
            .unwrap();
        let bundle = zip_writer::write(&[
            ("manifest.json", manifest_json(&[])),
            ("script.md", b"# Bundled\n\nBody.\n".to_vec()),
            (name, b"payload".to_vec()),
        ]);
        let err = import_bundle_bytes(&h, bundle)
            .await
            .expect_err(name);
        assert_eq!(err.code(), "IMPORT_UNSAFE_PATH", "{name}: {err:?}");
        assert_eq!(err.user_message(), "The bundle contains an unsafe path.", "{name}");

        let after: i64 = sqlx::query_scalar("SELECT count(*) FROM scripts")
            .fetch_one(&h.pool)
            .await
            .unwrap();
        assert_eq!(before, after, "{name} left a partial script behind");
    }
}

// ---------------------------------------------------------------------------
// #253: images whose lines were deleted
// ---------------------------------------------------------------------------

/// A real PNG of one colour, so two calls with different colours are two
/// different images with two different names.
fn solid_png(rgb: [u8; 3]) -> Vec<u8> {
    let mut out = std::io::Cursor::new(Vec::new());
    image::RgbImage::from_pixel(2, 2, image::Rgb(rgb))
        .write_to(&mut out, image::ImageFormat::Png)
        .expect("encode png");
    out.into_inner()
}

fn asset_name(asset: &speaking_glass_lib::assets::ImportedAsset) -> String {
    asset.markdown_path.trim_start_matches("assets/").to_string()
}

fn file_names(dir: &std::path::Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .expect("list")
        .map(|e| e.expect("entry").file_name().to_string_lossy().to_string())
        .collect();
    names.sort();
    names
}

fn with_both(kept: &str, removed: &str) -> String {
    format!("# Shots\n\n![Kept]({kept})\n\n![Private]({removed})\n")
}

fn with_kept(kept: &str) -> String {
    format!("# Shots\n\n![Kept]({kept})\n")
}

/// The issue's scenario: two screenshots imported and shown, then the line
/// showing the second one deleted. With `snapshot`, that last save is one that
/// takes a revision, so a saved version still shows the deleted image.
async fn script_that_dropped_an_image(
    h: &Harness,
    snapshot: bool,
) -> (
    ScriptId,
    speaking_glass_lib::assets::ImportedAsset,
    speaking_glass_lib::assets::ImportedAsset,
) {
    let created = repo::create_script(&h.pool, &h.paths, create_input("Shots", "Draft."))
        .await
        .expect("create");
    let id = sid(&created.id);
    let picked = tempfile::tempdir().expect("picker dir");
    let mut imported = Vec::new();
    for (file, rgb) in [("kept.png", [10, 120, 200]), ("private-screenshot.png", [200, 30, 30])] {
        let path = picked.path().join(file);
        fs::write(&path, solid_png(rgb)).unwrap();
        imported.push(
            speaking_glass_lib::assets::import_image(&h.pool, &h.paths, &id, path.to_str().unwrap())
                .await
                .expect("import"),
        );
    }
    let removed = imported.pop().unwrap();
    let kept = imported.pop().unwrap();
    assert_ne!(kept.sha256, removed.sha256);

    let saved = repo::save_script(
        &h.pool,
        &h.paths,
        &h.locks,
        &id,
        created.script_revision,
        with_both(&kept.markdown_path, &removed.markdown_path),
        ScriptMetadataPatch::default(),
    )
    .await
    .expect("save both");
    assert!(saved.revision_created, "the first save keeps the text it replaced");
    let last = repo::save_script(
        &h.pool,
        &h.paths,
        &h.locks,
        &id,
        saved.script_revision,
        with_kept(&kept.markdown_path),
        ScriptMetadataPatch {
            revision_reason: snapshot.then(|| "manual".to_string()),
            ..Default::default()
        },
    )
    .await
    .expect("save kept");
    assert_eq!(
        last.revision_created, snapshot,
        "within the 5-minute cadence, only an explicit reason takes a revision"
    );
    (id, kept, removed)
}

async fn resolves(h: &Harness, id: &ScriptId, href: &str) -> bool {
    let request = [speaking_glass_lib::assets::AssetRequest {
        id: "img-x".into(),
        href: href.to_string(),
    }];
    speaking_glass_lib::assets::resolve_asset_urls(&h.pool, &h.paths, id, &request)
        .await
        .expect("resolve")
        .contains_key("img-x")
}

/// The next launch: a fresh pool, as a relaunched process opens one, and the
/// reconciliation it runs before anything else. Reusing one pool across
/// "launches" is not what the app does, and it is not harmless here: with
/// several connections having written the search index, `quick_check` on one
/// of them reported that index malformed while another found it fine.
async fn relaunch(h: &mut Harness) -> reconcile::RecoveryReport {
    h.pool.close().await;
    h.pool = speaking_glass_lib::database::init(h._dir.path())
        .await
        .expect("relaunch");
    reconcile::run_startup_reconciliation(&h.pool, &h.paths, &h.locks)
        .await
        .expect("reconciliation")
}

async fn indexed_assets(h: &Harness, id: &ScriptId) -> Vec<String> {
    let prefix = format!("scripts/{}/assets/", id.as_str());
    let mut rows: Vec<String> =
        sqlx::query_scalar("SELECT rel_path FROM assets WHERE substr(rel_path, 1, ?) = ?")
            .bind(prefix.len() as i64)
            .bind(&prefix)
            .fetch_all(&h.pool)
            .await
            .unwrap();
    rows.sort();
    rows.into_iter()
        .map(|rel| rel.trim_start_matches(&prefix).to_string())
        .collect()
}

/// The issue's evidence, against the real functions: an exported folder held
/// the screenshot whose line had been deleted, because export listed the asset
/// folder rather than reading the text it was exporting.
#[tokio::test]
async fn issue_253_an_export_carries_only_the_images_its_text_uses() {
    let h = harness().await;
    let (id, kept, removed) = script_that_dropped_an_image(&h, false).await;
    assert_eq!(
        file_names(&h.paths.assets_dir(&id)),
        {
            let mut both = vec![asset_name(&kept), asset_name(&removed)];
            both.sort();
            both
        },
        "the script's own folder still holds both, for undo and restore"
    );

    // Markdown, with its images.
    let out = tempfile::tempdir().unwrap();
    let md = out.path().join("talk.md");
    let result = speaking_glass_lib::scripts::import_export::export_script(
        &h.pool,
        &h.paths,
        &h.locks,
        &id,
        ExportOptions {
            include_assets: true,
            ..export_options(&md, "markdown")
        },
    )
    .await
    .expect("markdown export");
    assert_eq!(file_names(&out.path().join("assets")), vec![asset_name(&kept)]);
    assert!(result.warnings.is_empty(), "{:?}", result.warnings);

    // Without them, the warning counts the images the text uses.
    let bare = tempfile::tempdir().unwrap();
    let result = speaking_glass_lib::scripts::import_export::export_script(
        &h.pool,
        &h.paths,
        &h.locks,
        &id,
        export_options(&bare.path().join("talk.md"), "markdown"),
    )
    .await
    .expect("markdown export without assets");
    assert_eq!(
        result.warnings,
        vec!["1 local image(s) were not exported; enable includeAssets to copy them.".to_string()]
    );
    assert!(!bare.path().join("assets").exists());

    // A bundle: the manifest and the archive agree, on the kept image alone.
    let bundle = out.path().join("talk.speakingglass");
    speaking_glass_lib::scripts::import_export::export_script(
        &h.pool,
        &h.paths,
        &h.locks,
        &id,
        export_options(&bundle, "bundle"),
    )
    .await
    .expect("bundle export");
    let mut archive = zip::ZipArchive::new(fs::File::open(&bundle).unwrap()).expect("zip");
    let mut entries: Vec<String> = archive
        .file_names()
        .map(|name| name.expect("zip entry name").into_owned())
        .collect();
    entries.sort();
    assert_eq!(
        entries,
        vec![
            format!("assets/{}", asset_name(&kept)),
            "manifest.json".to_string(),
            "script.md".to_string(),
        ]
    );
    let manifest: serde_json::Value = {
        use std::io::Read;
        let mut text = String::new();
        archive
            .by_name("manifest.json")
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        serde_json::from_str(&text).unwrap()
    };
    assert_eq!(manifest["assets"], serde_json::json!([asset_name(&kept)]));

    // And it imports, with the image it shows.
    let reimported = speaking_glass_lib::scripts::import_export::import_script(
        &h.pool,
        &h.paths,
        &h.locks,
        speaking_glass_lib::scripts::import_export::ImportOptions {
            path: bundle.to_string_lossy().to_string(),
            title: None,
        },
    )
    .await
    .expect("bundle import");
    let reimported_id = sid(&reimported.script.id);
    assert_eq!(file_names(&h.paths.assets_dir(&reimported_id)), vec![asset_name(&kept)]);
    assert!(resolves(&h, &reimported_id, &kept.markdown_path).await);
}

/// Duplicate copied the whole folder too, and indexed every image in it.
#[tokio::test]
async fn issue_253_a_duplicate_copies_only_the_images_its_text_uses() {
    let h = harness().await;
    let (id, kept, removed) = script_that_dropped_an_image(&h, false).await;

    let copy = repo::duplicate_script(&h.pool, &h.paths, &h.locks, &id)
        .await
        .expect("duplicate");
    let copy_id = sid(&copy.id);
    assert_eq!(file_names(&h.paths.assets_dir(&copy_id)), vec![asset_name(&kept)]);
    assert_eq!(indexed_assets(&h, &copy_id).await, vec![asset_name(&kept)]);
    assert!(resolves(&h, &copy_id, &kept.markdown_path).await);
    assert!(!resolves(&h, &copy_id, &removed.markdown_path).await);

    let copy_references: i64 =
        sqlx::query_scalar("SELECT count(*) FROM script_asset_references WHERE script_id = ?")
            .bind(copy_id.as_str())
            .fetch_one(&h.pool)
            .await
            .unwrap();
    let original_references: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM script_asset_references r JOIN assets a ON a.id = r.asset_id
         WHERE r.script_id = ? AND a.sha256 = ?",
    )
    .bind(id.as_str())
    .bind(&kept.sha256)
    .fetch_one(&h.pool)
    .await
    .unwrap();
    assert_eq!(copy_references, original_references, "the kept image's references, and no others");

    // The original is untouched: both images, both still resolvable.
    assert!(resolves(&h, &id, &removed.markdown_path).await);
}

/// Saving never removes an image: an undo can put its line back, and the text
/// it replays was never in any revision (the 5-minute cadence took none).
#[tokio::test]
async fn issue_253_saving_without_an_image_keeps_it_for_undo() {
    let h = harness().await;
    let (id, kept, removed) = script_that_dropped_an_image(&h, false).await;
    let revisions = repo::list_revisions(&h.pool, &id).await.unwrap();
    for revision in &revisions {
        let doc = repo::get_revision(&h.pool, &h.paths, &id, &revision.id).await.unwrap();
        assert!(!doc.source.contains(&removed.sha256), "no revision shows the deleted image");
    }

    // The undo, autosaved.
    repo::save_script(
        &h.pool,
        &h.paths,
        &h.locks,
        &id,
        db_revision(&h, &id).await,
        with_both(&kept.markdown_path, &removed.markdown_path),
        ScriptMetadataPatch::default(),
    )
    .await
    .expect("save the undo");
    assert!(resolves(&h, &id, &removed.markdown_path).await, "the image is still there to show");
}

/// Startup removes an image only once nothing can bring it back: kept while a
/// revision shows it, still there after a restore, and gone once retention has
/// thinned away every version that showed it — with the live image, and every
/// file nobody indexed, untouched throughout.
#[tokio::test]
async fn issue_253_startup_collects_an_image_once_no_revision_can_bring_it_back() {
    let mut h = harness().await;
    let (id, kept, removed) = script_that_dropped_an_image(&h, true).await;
    // Hash-named, never indexed: not this sweep's to judge.
    let stray = format!("{}.png", "ab".repeat(32));
    fs::write(h.paths.assets_dir(&id).join(&stray), b"never indexed").unwrap();

    let report = relaunch(&mut h).await;
    assert!(!report.has_findings(), "{report:?}");
    assert_eq!(report.unused_assets_removed, 0, "a revision still shows it");
    assert!(h.paths.assets_dir(&id).join(asset_name(&removed)).exists());

    // Restoring that revision brings the image back with it.
    let revision = repo::list_revisions(&h.pool, &id)
        .await
        .unwrap()
        .into_iter()
        .find(|r| r.reason == "manual")
        .expect("the snapshot of both");
    repo::restore_revision(&h.pool, &h.paths, &h.locks, &id, &revision.id, db_revision(&h, &id).await)
        .await
        .expect("restore");
    assert_eq!(
        fs::read_to_string(h.paths.canonical_file(&id)).unwrap(),
        with_both(&kept.markdown_path, &removed.markdown_path)
    );
    assert!(resolves(&h, &id, &removed.markdown_path).await);

    // Deleted again, and every version that showed it gone — what retention
    // thinning does over the weeks, done here directly.
    repo::save_script(
        &h.pool,
        &h.paths,
        &h.locks,
        &id,
        db_revision(&h, &id).await,
        with_kept(&kept.markdown_path),
        ScriptMetadataPatch::default(),
    )
    .await
    .expect("save kept");
    let snapshots: Vec<String> =
        sqlx::query_scalar("SELECT rel_path FROM script_revisions WHERE script_id = ?")
            .bind(id.as_str())
            .fetch_all(&h.pool)
            .await
            .unwrap();
    for rel_path in snapshots {
        fs::remove_file(h.paths.root().join(rel_path)).unwrap();
    }
    sqlx::query("DELETE FROM script_revisions WHERE script_id = ?")
        .bind(id.as_str())
        .execute(&h.pool)
        .await
        .unwrap();

    let report = relaunch(&mut h).await;
    assert_eq!(report.unused_assets_removed, 1, "{report:?}");
    assert!(!report.has_findings(), "maintenance, not a finding: {report:?}");
    assert!(!h.paths.assets_dir(&id).join(asset_name(&removed)).exists());
    assert_eq!(indexed_assets(&h, &id).await, vec![asset_name(&kept)]);
    let dangling: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM script_asset_references r
         LEFT JOIN assets a ON a.id = r.asset_id WHERE a.id IS NULL",
    )
    .fetch_one(&h.pool)
    .await
    .unwrap();
    assert_eq!(dangling, 0);
    assert!(resolves(&h, &id, &kept.markdown_path).await);
    assert!(h.paths.assets_dir(&id).join(&stray).exists(), "an unindexed file is left alone");

    // Nothing left to do on the launch after.
    let again = relaunch(&mut h).await;
    assert_eq!(again.unused_assets_removed, 0);
}

/// Every other text that can come back keeps the image too: parked unsaved
/// text, a snapshot file without its row, and a listed revision that cannot be
/// read. A launch that repaired something removes nothing; the next one does.
#[tokio::test]
async fn issue_253_startup_keeps_an_image_any_recoverable_text_may_still_use() {
    let mut h = harness().await;
    let (id, kept, removed) = script_that_dropped_an_image(&h, false).await;
    let removed_file = h.paths.assets_dir(&id).join(asset_name(&removed));
    let both = with_both(&kept.markdown_path, &removed.markdown_path);

    // Text the app could not save when it closed, parked for the user.
    let unsaved = h.paths.quarantine_dir().join("unsaved");
    fs::create_dir_all(&unsaved).unwrap();
    let parked = unsaved.join(format!("{}-20261017T090000Z.md", id.as_str()));
    fs::write(&parked, &both).unwrap();
    let report = relaunch(&mut h).await;
    assert!(report.integrity_ok && !report.notes.iter().any(|n| n.contains("deferred")), "{report:?}");
    assert_eq!(report.unused_assets_removed, 0);
    assert!(removed_file.exists(), "parked unsaved text still shows it");
    fs::remove_file(&parked).unwrap();

    // A snapshot whose row was never written: named the way one is, so a
    // rebuild would index it.
    let unlisted = h.paths.revisions_dir(&id).join(format!(
        "20261017T090000000Z-{}.md",
        &speaking_glass_lib::util::sha256_hex(both.as_bytes())[..12]
    ));
    fs::write(&unlisted, &both).unwrap();
    let report = relaunch(&mut h).await;
    assert!(report.integrity_ok && !report.notes.iter().any(|n| n.contains("deferred")), "{report:?}");
    assert_eq!(report.unused_assets_removed, 0);
    assert!(removed_file.exists(), "an unlisted snapshot still shows it");
    fs::remove_file(&unlisted).unwrap();

    // A listed revision whose file cannot be read: no evidence, no removal.
    let lost = repo::create_revision_snapshot(&h.pool, &h.paths, &id, "Lost.", "manual", 1)
        .await
        .unwrap();
    let lost_path: String = sqlx::query_scalar("SELECT rel_path FROM script_revisions WHERE id = ?")
        .bind(&lost)
        .fetch_one(&h.pool)
        .await
        .unwrap();
    fs::remove_file(h.paths.root().join(&lost_path)).unwrap();
    let report = relaunch(&mut h).await;
    assert_eq!(report.unused_assets_removed, 0);
    assert!(removed_file.exists(), "an unreadable revision is not proof of anything");
    assert!(
        report.notes.iter().any(|note| note.contains("collect unused images")),
        "{:?}",
        report.notes
    );
    sqlx::query("DELETE FROM script_revisions WHERE id = ?")
        .bind(&lost)
        .execute(&h.pool)
        .await
        .unwrap();

    // A launch that repaired the library leaves collection to the next one.
    fs::write(
        h.paths.canonical_file(&id),
        format!("{}\nEdited outside Speaking Glass.\n", with_kept(&kept.markdown_path)),
    )
    .unwrap();
    let report = relaunch(&mut h).await;
    assert!(!report.hash_mismatches_repaired.is_empty());
    assert_eq!(report.unused_assets_removed, 0);
    assert!(removed_file.exists());

    let report = relaunch(&mut h).await;
    assert_eq!(report.unused_assets_removed, 1, "{report:?}");
    assert!(!removed_file.exists());
    assert!(resolves(&h, &id, &kept.markdown_path).await);
}

/// An image in the Trash's scripts is judged like any other — and one whose
/// script cannot be read is not judged at all.
#[tokio::test]
async fn issue_253_startup_treats_trashed_scripts_alike_and_skips_unreadable_ones() {
    let mut h = harness().await;
    let (trashed, _, trashed_removed) = script_that_dropped_an_image(&h, false).await;
    repo::trash_script(&h.pool, &h.locks, &trashed, db_revision(&h, &trashed).await)
        .await
        .expect("trash");
    let (missing, _, missing_removed) = script_that_dropped_an_image(&h, false).await;

    // With no text and no revision to restore it from, the script cannot be
    // judged. That stays true launch after launch, and must not hold every
    // other script's collection back with it.
    fs::remove_file(h.paths.canonical_file(&missing)).unwrap();
    for entry in fs::read_dir(h.paths.revisions_dir(&missing)).unwrap() {
        fs::remove_file(entry.unwrap().path()).unwrap();
    }
    sqlx::query("DELETE FROM script_revisions WHERE script_id = ?")
        .bind(missing.as_str())
        .execute(&h.pool)
        .await
        .unwrap();
    let report = relaunch(&mut h).await;
    assert_eq!(report.missing_files_unrecoverable, vec![missing.as_str().to_string()]);
    assert_eq!(report.unused_assets_removed, 1, "{report:?}");
    assert!(!h.paths.assets_dir(&trashed).join(asset_name(&trashed_removed)).exists());
    assert!(h.paths.assets_dir(&missing).join(asset_name(&missing_removed)).exists());
    assert!(
        report.notes.iter().any(|note| note.contains(missing.as_str())),
        "{:?}",
        report.notes
    );

    let again = relaunch(&mut h).await;
    assert_eq!(again.missing_files_unrecoverable, vec![missing.as_str().to_string()]);
    assert_eq!(again.unused_assets_removed, 0);
    assert!(h.paths.assets_dir(&missing).join(asset_name(&missing_removed)).exists());
}

/// An image the text never used is neither carried nor mentioned: the
/// plain-text warning and the Markdown copy both used to count the folder.
#[tokio::test]
async fn issue_253_an_export_whose_text_shows_no_image_carries_and_mentions_none() {
    let h = harness().await;
    let id = new_script(&h, "Words", "# Words\n\nNo pictures here.\n").await;
    let picked = tempfile::tempdir().unwrap();
    let path = picked.path().join("unused.png");
    fs::write(&path, solid_png([1, 2, 3])).unwrap();
    speaking_glass_lib::assets::import_image(&h.pool, &h.paths, &id, path.to_str().unwrap())
        .await
        .expect("import");

    for (format, file) in [("markdown", "words.md"), ("text", "words.txt")] {
        let out = tempfile::tempdir().unwrap();
        let result = speaking_glass_lib::scripts::import_export::export_script(
            &h.pool,
            &h.paths,
            &h.locks,
            &id,
            ExportOptions {
                include_assets: true,
                ..export_options(&out.path().join(file), format)
            },
        )
        .await
        .expect(format);
        assert!(result.warnings.is_empty(), "{format}: {:?}", result.warnings);
        assert!(!out.path().join("assets").exists(), "{format}");
    }
}

/// Where startup must remove nothing: a launch that restored any script's
/// text from a revision, an image another script references, and — through a
/// link — a folder that is not the script's own.
#[tokio::test]
async fn issue_253_startup_removes_nothing_on_doubtful_ground() {
    let mut h = harness().await;
    let (id, _, removed) = script_that_dropped_an_image(&h, false).await;
    let removed_file = h.paths.assets_dir(&id).join(asset_name(&removed));

    // Another script's file is gone and comes back from its latest revision.
    let other = new_script(&h, "Other", "Other text.").await;
    repo::save_script(
        &h.pool,
        &h.paths,
        &h.locks,
        &other,
        db_revision(&h, &other).await,
        "Other text, saved.".into(),
        ScriptMetadataPatch::default(),
    )
    .await
    .expect("save other");
    fs::remove_file(h.paths.canonical_file(&other)).unwrap();
    let report = relaunch(&mut h).await;
    assert_eq!(report.missing_files_restored, vec![other.as_str().to_string()]);
    assert_eq!(report.unused_assets_removed, 0);
    assert!(removed_file.exists(), "a launch that restored text collects nothing");

    // An image another script references.
    let asset_id: String = sqlx::query_scalar("SELECT id FROM assets WHERE rel_path = ?")
        .bind(format!("scripts/{}/assets/{}", id.as_str(), asset_name(&removed)))
        .fetch_one(&h.pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO script_asset_references (script_id, asset_id, role, created_at)
         VALUES (?, ?, 'image', '2026-10-17T09:00:00.000Z')",
    )
    .bind(other.as_str())
    .bind(&asset_id)
    .execute(&h.pool)
    .await
    .unwrap();
    let report = relaunch(&mut h).await;
    assert!(!report.notes.iter().any(|n| n.contains("deferred")), "{report:?}");
    assert_eq!(report.unused_assets_removed, 0);
    assert!(removed_file.exists(), "another script still references it");
    sqlx::query("DELETE FROM script_asset_references WHERE script_id = ?")
        .bind(other.as_str())
        .execute(&h.pool)
        .await
        .unwrap();

    #[cfg(unix)]
    {
        // A revisions folder that is a link was not looked in.
        let revisions = h.paths.revisions_dir(&id);
        let elsewhere = tempfile::tempdir().unwrap();
        let moved = elsewhere.path().join("revisions");
        fs::rename(&revisions, &moved).unwrap();
        std::os::unix::fs::symlink(&moved, &revisions).unwrap();
        let report = relaunch(&mut h).await;
        assert_eq!(report.unused_assets_removed, 0);
        assert!(removed_file.exists());
        assert!(report.notes.iter().any(|n| n.contains("revisions not read")), "{:?}", report.notes);
        fs::remove_file(&revisions).unwrap();
        fs::rename(&moved, &revisions).unwrap();

        // An assets folder that is a link: what it points at is not the
        // script's to delete from.
        let assets = h.paths.assets_dir(&id);
        let outside = tempfile::tempdir().unwrap();
        let moved = outside.path().join("assets");
        fs::rename(&assets, &moved).unwrap();
        std::os::unix::fs::symlink(&moved, &assets).unwrap();
        let report = relaunch(&mut h).await;
        assert_eq!(report.unused_assets_removed, 0);
        assert!(moved.join(asset_name(&removed)).exists(), "nothing outside the library is touched");
        assert!(
            report.notes.iter().any(|n| n.contains("not a folder inside the library")),
            "{:?}",
            report.notes
        );
        fs::remove_file(&assets).unwrap();
        fs::rename(&moved, &assets).unwrap();
    }

    // On ordinary ground, it goes.
    let report = relaunch(&mut h).await;
    assert_eq!(report.unused_assets_removed, 1, "{report:?}");
    assert!(!removed_file.exists());
}
