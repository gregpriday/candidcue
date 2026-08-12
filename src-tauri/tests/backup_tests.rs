//! Export, restore, rebuild, and the pre-migration backup policy.
//!
//! These are the "can I get my work back?" paths, and every one of them was a
//! finding in the 1.0 readiness review:
//!
//!  - an export could report success after its database snapshot failed;
//!  - there was no restore at all, so "Export all data" produced a folder
//!    nobody could put back;
//!  - a pre-migration backup was written on EVERY launch, so five ordinary
//!    starts after an upgrade rotated away the only snapshot worth having;
//!  - and when that backup failed, the migration ran anyway — which inverts
//!    the one property a pre-migration backup exists to provide.
//!
//! Each test below breaks the specific thing and asserts the code notices.
//! Tests that only exercised the happy path would have passed against every
//! one of the defects above.

use std::fs;
use std::path::Path;

use candidcue_lib::backup;
use candidcue_lib::scripts::{repo, CreateScriptInput, DataPaths};

struct Harness {
    dir: tempfile::TempDir,
    pool: sqlx::SqlitePool,
    paths: DataPaths,
}

async fn harness() -> Harness {
    let dir = tempfile::tempdir().expect("tempdir");
    let pool = candidcue_lib::database::init(dir.path())
        .await
        .expect("database init + migrations");
    let paths = DataPaths::new(dir.path().to_path_buf());
    Harness { paths, pool, dir }
}

fn create_input(title: &str, source: &str) -> CreateScriptInput {
    serde_json::from_value(serde_json::json!({ "title": title, "source": source }))
        .expect("create input")
}

/// Hex → bytes, for forging a `_sqlx_migrations` checksum.
fn hex_bytes(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("hex"))
        .collect()
}

fn manifest_of(export: &Path) -> serde_json::Value {
    serde_json::from_slice(&fs::read(export.join("manifest.json")).expect("manifest exists"))
        .expect("manifest parses")
}

/* -------------------------------------------------------------- export */

#[tokio::test]
async fn a_complete_export_is_named_complete_and_carries_every_section() {
    let h = harness().await;
    repo::create_script(&h.pool, &h.paths, create_input("Opening", "# Opening\n\nHello."))
        .await
        .expect("create");

    let dest = tempfile::tempdir().expect("dest");
    let result = backup::export_all_data(&h.pool, &h.paths, dest.path())
        .await
        .expect("export");

    assert!(result.complete, "a healthy export must report complete");
    assert!(
        !result.path.contains("INCOMPLETE"),
        "a complete export must not be named INCOMPLETE: {}",
        result.path
    );
    assert_eq!(result.scripts_copied, 1);

    let export = Path::new(&result.path);
    let manifest = manifest_of(export);

    // The three sections. `settings` is the one that used not to exist at all,
    // which is how calibrations were absent from "all data".
    let names: Vec<String> = manifest["sections"]
        .as_array()
        .expect("sections")
        .iter()
        .map(|s| s["name"].as_str().unwrap_or_default().to_string())
        .collect();
    assert!(names.contains(&"database".to_string()));
    assert!(names.contains(&"scripts".to_string()));
    assert!(names.contains(&"settings".to_string()));

    assert!(export.join("candidcue.sqlite3").exists());
    assert!(export.join("settings.json").exists());
    assert!(export.join("scripts").exists());

    // Every file is checksummed, and the manifest excludes itself.
    let files = manifest["files"].as_array().expect("files");
    assert!(files.len() >= 3, "expected at least db, settings and a script");
    for file in files {
        let path = file["path"].as_str().expect("path");
        assert_ne!(path, "manifest.json", "the manifest cannot checksum itself");
        assert_eq!(
            file["sha256"].as_str().unwrap_or_default().len(),
            64,
            "{path} has no sha256"
        );
    }

    // The exclusion is stated, not discovered during a restore.
    let excluded = manifest["excluded"].as_array().expect("excluded");
    assert!(
        excluded
            .iter()
            .any(|e| e.as_str().unwrap_or_default().to_lowercase().contains("speech model")),
        "the manifest must say the speech model is deliberately not included"
    );
}

#[tokio::test]
async fn a_failed_database_snapshot_produces_an_incomplete_export() {
    /*
     * THE defect. `export_all_data` turned a `VACUUM INTO` failure into a
     * warning and carried on; the frontend adapter then discarded the warnings
     * and Settings displayed "Export ready" over a folder with no database in
     * it.
     *
     * The failure is induced by closing the pool, which is the closest thing
     * to "the snapshot cannot be taken" available without a filesystem trick,
     * and it exercises exactly the branch that used to be swallowed.
     */
    let h = harness().await;
    repo::create_script(&h.pool, &h.paths, create_input("Opening", "# Opening"))
        .await
        .expect("create");
    h.pool.close().await;

    let dest = tempfile::tempdir().expect("dest");
    let result = backup::export_all_data(&h.pool, &h.paths, dest.path())
        .await
        .expect("an export with a failed section still returns; it does not throw");

    assert!(!result.complete, "a missing database means the export is not complete");
    assert!(
        result.path.ends_with("-INCOMPLETE"),
        "the folder name itself must carry the warning, so it survives being \
         looked at in Finder a month later: {}",
        result.path
    );
    assert!(
        !result.warnings.is_empty(),
        "the reason must reach the caller, not only the log"
    );

    let manifest = manifest_of(Path::new(&result.path));
    assert_eq!(manifest["complete"], serde_json::json!(false));
    let database = manifest["sections"]
        .as_array()
        .expect("sections")
        .iter()
        .find(|s| s["name"] == "database")
        .expect("a database section, even when it failed");
    assert_eq!(database["complete"], serde_json::json!(false));
    assert!(database["problem"].is_string(), "the section must say why");
}

#[tokio::test]
async fn an_export_is_never_visible_under_its_final_name_until_it_is_finished() {
    /*
     * The old export created its destination directory as its first action, so
     * a folder named `CandidCue-export-…` existed — and could be copied to a
     * drive, or backed up by something else — before it had any content.
     * Staging is dot-prefixed and renamed last.
     */
    let h = harness().await;
    let dest = tempfile::tempdir().expect("dest");
    let result = backup::export_all_data(&h.pool, &h.paths, dest.path())
        .await
        .expect("export");

    let leftovers: Vec<String> = fs::read_dir(dest.path())
        .expect("dest")
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|name| name.starts_with('.'))
        .collect();
    assert!(
        leftovers.is_empty(),
        "the staging directory must be renamed, not left behind: {leftovers:?}"
    );
    assert!(Path::new(&result.path).join("manifest.json").exists());
}

/* ------------------------------------------------------------- restore */

#[tokio::test]
async fn a_restore_is_scheduled_and_applied_at_the_next_launch() {
    /*
     * Restoring is a TWO-PHASE operation, and that is the fix for the worst
     * defect in the first version of this module.
     *
     * `restore_all_data` used to do the swap immediately, while the
     * application was running and its pool was open on the file being
     * replaced. On Unix a rename does not invalidate an open descriptor, so
     * existing connections keep writing to the quarantined inode and SQLite
     * recreates `-wal`/`-shm` beside the file that replaced it — a database
     * whose journal belongs to a different database. On Windows the rename
     * fails, and it fails after the scripts tree has already moved.
     *
     * So the command validates and writes a marker; `database::init` applies
     * it at the next launch, before any pool exists. This test drives both
     * halves in that order.
     */
    let h = harness().await;
    repo::create_script(
        &h.pool,
        &h.paths,
        create_input("Keynote", "# Keynote\n\nThe part that must survive."),
    )
    .await
    .expect("create");

    let dest = tempfile::tempdir().expect("dest");
    let export = backup::export_all_data(&h.pool, &h.paths, dest.path())
        .await
        .expect("export");
    assert!(export.complete);

    // Phase 1: schedule. Nothing may move yet — the pool is still open.
    let scheduled = backup::restore_all_data(&h.paths, Path::new(&export.path))
        .await
        .expect("schedule");
    assert!(scheduled.restart_required);
    assert_eq!(scheduled.scripts_in_export, 1);
    assert!(
        h.dir.path().join("restore-pending.json").exists(),
        "scheduling must leave a marker for the next launch"
    );

    // Destroy the live state as thoroughly as a user could, between launches.
    h.pool.close().await;
    fs::remove_dir_all(h.paths.scripts_dir()).expect("wipe scripts");
    fs::remove_file(h.dir.path().join("candidcue.sqlite3")).ok();

    // Phase 2: the next launch. `database::init` applies the marker before it
    // opens anything.
    let pool = candidcue_lib::database::init(h.dir.path())
        .await
        .expect("startup applies the pending restore");
    pool.close().await;

    assert!(
        !h.dir.path().join("restore-pending.json").exists(),
        "the marker must be consumed, not retried every launch"
    );
    assert!(h.paths.scripts_dir().exists());
    assert!(h.dir.path().join("candidcue.sqlite3").exists());

    // The content, not just the file count.
    let found = fs::read_dir(h.paths.scripts_dir())
        .expect("scripts")
        .filter_map(|e| e.ok())
        .map(|e| e.path().join("script.md"))
        .find(|p| p.exists())
        .expect("a canonical file");
    assert!(fs::read_to_string(found)
        .expect("read")
        .contains("The part that must survive."));
}

#[tokio::test]
async fn scheduling_a_restore_does_not_touch_live_data() {
    /*
     * The property that makes the two-phase design worth having. A user who
     * schedules a restore and then decides not to restart must find everything
     * exactly as it was.
     */
    let h = harness().await;
    repo::create_script(&h.pool, &h.paths, create_input("Live", "# Live\n\nUntouched."))
        .await
        .expect("create");

    let dest = tempfile::tempdir().expect("dest");
    let export = backup::export_all_data(&h.pool, &h.paths, dest.path())
        .await
        .expect("export");

    // A second script exists only in the live state.
    repo::create_script(&h.pool, &h.paths, create_input("Newer", "# Newer"))
        .await
        .expect("create");
    let before = fs::read_dir(h.paths.scripts_dir()).expect("scripts").count();

    backup::restore_all_data(&h.paths, Path::new(&export.path))
        .await
        .expect("schedule");

    assert_eq!(
        fs::read_dir(h.paths.scripts_dir()).expect("scripts").count(),
        before,
        "scheduling must move nothing"
    );
    assert!(
        !h.dir.path().join("quarantine").exists(),
        "and quarantine nothing"
    );
}

#[tokio::test]
async fn a_restore_refuses_an_incomplete_export_before_touching_anything() {
    let h = harness().await;
    repo::create_script(&h.pool, &h.paths, create_input("Live", "# Live\n\nStill here."))
        .await
        .expect("create");
    h.pool.close().await;

    // Produce a genuinely incomplete export (closed pool ⇒ no database).
    let dest = tempfile::tempdir().expect("dest");
    let broken = backup::export_all_data(&h.pool, &h.paths, dest.path())
        .await
        .expect("export");
    assert!(!broken.complete);

    let before = fs::read_dir(h.paths.scripts_dir()).expect("scripts").count();
    let outcome = backup::restore_all_data(&h.paths, Path::new(&broken.path)).await;

    assert!(
        outcome.is_err(),
        "restoring from an incomplete export would replace what the user has \
         with less than they have"
    );
    assert_eq!(
        fs::read_dir(h.paths.scripts_dir()).expect("scripts").count(),
        before,
        "a refused restore must not have moved anything"
    );
}

#[tokio::test]
async fn a_restore_refuses_a_damaged_export() {
    let h = harness().await;
    repo::create_script(&h.pool, &h.paths, create_input("Live", "# Live\n\nStill here."))
        .await
        .expect("create");

    let dest = tempfile::tempdir().expect("dest");
    let export = backup::export_all_data(&h.pool, &h.paths, dest.path())
        .await
        .expect("export");

    // Corrupt one byte of the database snapshot, leaving its size intact so
    // only the checksum can catch it.
    let db = Path::new(&export.path).join("candidcue.sqlite3");
    let mut bytes = fs::read(&db).expect("read snapshot");
    let last = bytes.len() - 1;
    bytes[last] ^= 0xff;
    fs::write(&db, &bytes).expect("corrupt");

    let scripts_before = fs::read_dir(h.paths.scripts_dir()).expect("scripts").count();
    let outcome = backup::restore_all_data(&h.paths, Path::new(&export.path)).await;

    assert!(outcome.is_err(), "a checksum mismatch must stop the restore");
    assert_eq!(
        fs::read_dir(h.paths.scripts_dir()).expect("scripts").count(),
        scripts_before,
        "validation happens before anything moves"
    );
}

#[tokio::test]
async fn a_restore_refuses_a_folder_that_is_not_an_export() {
    let h = harness().await;
    let not_an_export = tempfile::tempdir().expect("dir");
    fs::write(not_an_export.path().join("notes.txt"), "hello").expect("write");

    let outcome = backup::restore_all_data(&h.paths, not_an_export.path()).await;
    assert!(outcome.is_err(), "no manifest means it is not an export");
}

#[tokio::test]
async fn a_restore_refuses_an_export_written_by_a_newer_build() {
    let h = harness().await;
    let dest = tempfile::tempdir().expect("dest");
    let export = backup::export_all_data(&h.pool, &h.paths, dest.path())
        .await
        .expect("export");

    let manifest_path = Path::new(&export.path).join("manifest.json");
    let mut manifest = manifest_of(Path::new(&export.path));
    manifest["exportSchemaVersion"] = serde_json::json!(backup::EXPORT_SCHEMA_VERSION + 1);
    fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest).unwrap()).expect("write");

    let outcome = backup::restore_all_data(&h.paths, Path::new(&export.path)).await;
    assert!(
        outcome.is_err(),
        "an unknown export format must be refused, not guessed at"
    );
}

#[tokio::test]
async fn a_restore_refuses_a_manifest_pointing_outside_the_export() {
    /*
     * Path traversal, from a folder the user was handed by someone else. The
     * restore writes files; a manifest entry of `../../../etc/thing` must not
     * be followed, and neither must a symlink that resolves outside.
     */
    let h = harness().await;
    let dest = tempfile::tempdir().expect("dest");
    let export = backup::export_all_data(&h.pool, &h.paths, dest.path())
        .await
        .expect("export");

    let manifest_path = Path::new(&export.path).join("manifest.json");
    let mut manifest = manifest_of(Path::new(&export.path));
    manifest["files"].as_array_mut().expect("files").push(serde_json::json!({
        "path": "../../escaped.txt",
        "bytes": 1,
        "sha256": "0".repeat(64),
    }));
    fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest).unwrap()).expect("write");

    let outcome = backup::restore_all_data(&h.paths, Path::new(&export.path)).await;
    assert!(outcome.is_err(), "a path escaping the export must be refused");
}

#[tokio::test]
async fn applying_a_restore_keeps_the_state_it_replaced() {
    let h = harness().await;
    repo::create_script(&h.pool, &h.paths, create_input("First", "# First"))
        .await
        .expect("create");

    let dest = tempfile::tempdir().expect("dest");
    let export = backup::export_all_data(&h.pool, &h.paths, dest.path())
        .await
        .expect("export");

    // A second script exists only in the live state, not in the export.
    repo::create_script(&h.pool, &h.paths, create_input("Second", "# Second"))
        .await
        .expect("create");

    backup::restore_all_data(&h.paths, Path::new(&export.path))
        .await
        .expect("schedule");
    h.pool.close().await;

    let previous = backup::apply_pending_restore(&h.paths)
        .await
        .expect("apply")
        .expect("a restore ran");

    /*
     * A restore is destructive by definition — it is meant to replace what is
     * there. What it must never do is destroy it: the replaced state is moved
     * to quarantine, and nothing deletes that automatically.
     */
    assert!(previous.exists(), "the replaced state must still be on disk");
    assert!(
        previous.join("scripts").exists(),
        "including the scripts that were not in the export"
    );
}

#[tokio::test]
async fn an_export_whose_manifest_omits_a_file_is_refused() {
    /*
     * The restore copies a fixed database path and the whole scripts tree, but
     * the check used to iterate only `manifest.files`. So a `complete: true`
     * manifest listing nothing but `settings.json` would let an unchecksummed
     * database and any number of extra script files through — which is what a
     * damaged or hostile export looks like.
     */
    let h = harness().await;
    repo::create_script(&h.pool, &h.paths, create_input("Live", "# Live"))
        .await
        .expect("create");

    let dest = tempfile::tempdir().expect("dest");
    let export = backup::export_all_data(&h.pool, &h.paths, dest.path())
        .await
        .expect("export");

    // Add a file the manifest never vouched for.
    fs::write(
        Path::new(&export.path).join("scripts").join("smuggled.md"),
        "# not in the manifest",
    )
    .expect("write");

    let outcome = backup::restore_all_data(&h.paths, Path::new(&export.path)).await;
    assert!(outcome.is_err(), "an unlisted file must stop the restore");
}

#[tokio::test]
async fn an_export_destination_inside_the_scripts_tree_is_refused() {
    /*
     * `copy_tree` walks the source with `read_dir`, so a destination under
     * `scripts/` means it finds its own newly created target and descends into
     * it — recursing until the path length, the stack or the disk gives out.
     * Choosing the scripts folder in a file picker is not an exotic input.
     */
    let h = harness().await;
    let inside = h.paths.scripts_dir().join("export-here");
    fs::create_dir_all(&inside).expect("mkdir");

    let outcome = backup::export_all_data(&h.pool, &h.paths, &inside).await;
    assert!(
        outcome.is_err(),
        "an export destination inside the source tree must be refused"
    );
}

/* ------------------------------------------------------------- rebuild */

#[tokio::test]
async fn a_rebuild_moves_the_database_aside_and_never_deletes_it() {
    let h = harness().await;
    repo::create_script(&h.pool, &h.paths, create_input("Kept", "# Kept\n\nBody."))
        .await
        .expect("create");
    h.pool.close().await;

    let quarantine = backup::rebuild_database_index(&h.paths).expect("rebuild");

    assert!(
        !h.dir.path().join("candidcue.sqlite3").exists(),
        "the live database is gone so the baseline can be applied fresh"
    );
    assert!(
        quarantine.join("candidcue.sqlite3").exists(),
        "and it is in quarantine, because it may be the only copy of the \
         session history a rebuild cannot reconstruct"
    );
    assert!(
        quarantine.join("README.txt").exists(),
        "someone finding this folder later must be told what it is"
    );
    assert!(
        h.paths.scripts_dir().exists(),
        "a rebuild must not touch the canonical files it rebuilds FROM"
    );
}

/* -------------------------------------------- pre-migration backup policy */

#[tokio::test]
async fn an_ordinary_launch_with_nothing_pending_writes_no_backup() {
    /*
     * A snapshot used to be taken on every launch of an existing database.
     * Besides the cost, the rotation keeps only the five newest — so five
     * ordinary starts after an upgrade discarded the one snapshot anybody
     * would ever want.
     */
    let dir = tempfile::tempdir().expect("tempdir");

    let pool = candidcue_lib::database::init(dir.path()).await.expect("first init");
    pool.close().await;

    let backups = dir.path().join("backups");
    let after_first = if backups.exists() {
        fs::read_dir(&backups).expect("backups").count()
    } else {
        0
    };

    // Second launch: same build, same schema, nothing pending.
    let pool = candidcue_lib::database::init(dir.path()).await.expect("second init");
    pool.close().await;

    let after_second = if backups.exists() {
        fs::read_dir(&backups).expect("backups").count()
    } else {
        0
    };

    assert_eq!(
        after_first, after_second,
        "a launch with no pending migration must not write a backup"
    );
}

#[tokio::test]
async fn a_database_from_before_the_1_0_baseline_is_quarantined_rather_than_refused() {
    /*
     * The 1.0 schema is a squash, so sqlx's checksum for migration 1 no longer
     * matches what a pre-baseline build recorded. Left alone that is a hard
     * refusal to start, reported as a checksum mismatch — an error a user can
     * do nothing with.
     *
     * The old database is set aside instead, and startup reconciliation
     * rebuilds the index from the canonical Markdown files, which are the
     * authority for script content anyway.
     */
    let dir = tempfile::tempdir().expect("tempdir");
    let pool = candidcue_lib::database::init(dir.path()).await.expect("init");

    /*
     * Forge the real tell: migration 1 carrying the checksum the PRE-BASELINE
     * `0001_initial.sql` actually had.
     *
     * An earlier version of this test inserted a version-2 row with a dummy
     * checksum, because an earlier version of the code used "an applied
     * version 2" as the tell. Both were wrong. The heuristic missed a database
     * that only ever applied the old migration 1 — which then reached sqlx as
     * a bare checksum mismatch, the exact unactionable error this exists to
     * prevent — and, worse, the first legitimate post-1.0 migration numbered 2
     * would have made every healthy database look pre-baseline.
     *
     * SHA-384 of the pre-1.0 `0001_initial.sql`. If the recognition is ever
     * broadened to "any mismatch", this test still passes and the one below
     * it — a healthy database with an unrelated future migration — starts
     * failing, which is the pair that matters.
     */
    const LEGACY_MIGRATION_1: &str = "8faf4be144c99a72b6460a0188e1986c465e58291724b36d2f0a75cdfc47ffb9cbbab0801cef31a025c6d627fd28795c";
    sqlx::query("UPDATE _sqlx_migrations SET checksum = ? WHERE version = 1")
        .bind(hex_bytes(LEGACY_MIGRATION_1))
        .execute(&pool)
        .await
        .expect("forge the pre-baseline checksum");
    pool.close().await;

    let pool = candidcue_lib::database::init(dir.path())
        .await
        .expect("a pre-baseline database must not stop the app from starting");
    pool.close().await;

    let quarantine = dir.path().join("quarantine");
    assert!(quarantine.exists(), "the old database must be kept");
    let kept: Vec<String> = fs::read_dir(&quarantine)
        .expect("quarantine")
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    assert!(
        kept.iter().any(|name| name.starts_with("pre-1.0-baseline-")
            && name.ends_with(".sqlite3")),
        "expected a quarantined pre-baseline database, found {kept:?}"
    );
    assert!(
        kept.iter().any(|name| name.ends_with(".json")),
        "and a note saying what was and was not carried over, found {kept:?}"
    );
}

#[tokio::test]
async fn a_healthy_database_with_a_future_migration_is_left_alone() {
    /*
     * The anti-vacuity partner to the test above, and the reason the tell is an
     * EXACT checksum rather than "an applied version 2".
     *
     * The first legitimate post-1.0 migration will be numbered 2. Under the old
     * heuristic every healthy database in the world would then have looked
     * pre-baseline and been quarantined on upgrade — a data-loss bug shipped as
     * a safety feature. Recognition has to be of the one file that existed, and
     * of nothing else.
     */
    let dir = tempfile::tempdir().expect("tempdir");
    let pool = candidcue_lib::database::init(dir.path()).await.expect("init");

    // A future migration 2 that is NOT the legacy one.
    sqlx::query(
        "INSERT INTO _sqlx_migrations
            (version, description, installed_on, success, checksum, execution_time)
         VALUES (2, 'some future migration', datetime('now'), 1, X'0123456789ABCDEF', 0)",
    )
    .execute(&pool)
    .await
    .expect("insert a future migration row");
    pool.close().await;

    // Reopening will fail for an unrelated reason — sqlx does not know a
    // migration 2 — and that is fine. What must NOT have happened is a
    // quarantine.
    let _ = candidcue_lib::database::init(dir.path()).await;

    assert!(
        !dir.path().join("quarantine").exists(),
        "a database with an unrecognised migration must not be quarantined"
    );
    assert!(
        dir.path().join("candidcue.sqlite3").exists(),
        "and it must still be where it was"
    );
}

/* ------------------------------------------------- the recovery-mode guard */

#[tokio::test]
async fn recovery_mode_refuses_commands_that_would_write() {
    /*
     * The frontend gates on `get_boot_status` before it routes anywhere, and a
     * gate in one process's UI is a policy, not a boundary.
     *
     * The specific hazard is that several commands touch the FILESYSTEM before
     * they touch the database — `create_script` writes the canonical Markdown
     * and then inserts the row — so a stray call in recovery mode would leave
     * a real file on disk indexed only in the scratch in-memory database that
     * vanishes with the process. The user would have a script they could not
     * find, and CandidCue would have "recovered" nothing.
     */
    use candidcue_lib::database::BootStatus;

    let failed = BootStatus::Failed(candidcue_lib::AppError::invalid_input("corrupt"));
    let ready = BootStatus::Ready;

    assert!(
        failed.require_ready().is_err(),
        "a write must be refused while the database is unavailable"
    );
    assert!(ready.require_ready().is_ok());

    /*
     * And the mirror image. `rebuild_database_index` moves the live database
     * into quarantine — the right answer to one that will not open, and the
     * wrong answer to one that is open and being written to.
     */
    assert!(
        ready.require_recovery().is_err(),
        "a destructive recovery action must be refused while the database works"
    );
    assert!(failed.require_recovery().is_ok());
}

#[tokio::test]
async fn the_mutating_commands_actually_carry_the_guard() {
    /*
     * Structural, and deliberately so: the test above proves the guard
     * FUNCTION works, which is worth nothing if it is not called. A command
     * added later without it is the whole failure mode, and nothing else in
     * the suite would notice.
     */
    let sources = [
        include_str!("../src/commands/scripts_cmds.rs"),
        include_str!("../src/commands/assets_cmds.rs"),
        include_str!("../src/commands/sessions_cmds.rs"),
        include_str!("../src/commands/settings_cmds.rs"),
        include_str!("../src/commands/stage_cmds.rs"),
    ]
    .concat();

    for command in [
        "create_script",
        "save_script",
        "rename_script",
        "duplicate_script",
        "trash_script",
        "restore_script",
        "permanently_delete_script",
        "restore_revision",
        "import_script",
        "import_image",
        "import_remote_image",
        "remove_asset_reference",
        "start_session",
        "end_session",
        "append_session_transcript",
        "record_session_take",
        "update_settings",
        "export_all_data",
        "restore_all_data",
        "save_display_profile",
    ] {
        let body = sources
            .split(&format!("pub async fn {command}"))
            .nth(1)
            .unwrap_or_else(|| panic!("{command} must exist"));
        // Only the first ~2 KB: the guard is the first statement of the body,
        // and scanning the whole rest of the file would match the next
        // command's guard instead.
        let head = &body[..body.len().min(2048)];
        assert!(
            head.contains("boot.require_ready()?"),
            "{command} writes, so it must refuse to run in recovery mode"
        );
    }

    let recovery = include_str!("../src/commands/recovery_cmds.rs");
    for command in ["rebuild_database_index", "restore_database_backup"] {
        let body = recovery
            .split(&format!("pub async fn {command}"))
            .nth(1)
            .unwrap_or_else(|| panic!("{command} must exist"));
        let head = &body[..body.len().min(2048)];
        assert!(
            head.contains("boot.require_recovery()?"),
            "{command} is destructive and must refuse to run against a healthy database"
        );
    }
}
