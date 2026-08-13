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

    /*
     * And the export's data actually became live — the half the first version
     * of this test did not check. Asserting only that a quarantine directory
     * and a scripts directory EXIST would pass over a restore that moved
     * everything aside and copied nothing back.
     */
    let live: Vec<String> = fs::read_dir(h.paths.scripts_dir())
        .expect("scripts")
        .filter_map(|e| e.ok())
        .filter_map(|e| fs::read_to_string(e.path().join("script.md")).ok())
        .collect();
    assert_eq!(live.len(), 1, "the export held exactly one script");
    assert!(
        live[0].contains("First"),
        "the restored content must be the EXPORT's, not the live state's: {live:?}"
    );
    assert!(
        !live.iter().any(|body| body.contains("Second")),
        "the script that existed only in the live state must be gone from live"
    );
}

#[tokio::test]
async fn an_interrupted_restore_is_resumed_rather_than_forgotten() {
    /*
     * The marker used to be consumed BEFORE any mutation, on the reasoning
     * that a failing restore must not retry forever. That trades one problem
     * for a worse one: a crash part way through the copy left partial live
     * data, no marker, and no automatic retry — an application that will not
     * open and no record of what was happening to it.
     *
     * It now survives until the restore succeeds. This drives the resume by
     * scheduling, applying once (which consumes it), and asserting the marker
     * lifecycle at each step.
     */
    let h = harness().await;
    repo::create_script(&h.pool, &h.paths, create_input("Kept", "# Kept"))
        .await
        .expect("create");

    let dest = tempfile::tempdir().expect("dest");
    let export = backup::export_all_data(&h.pool, &h.paths, dest.path())
        .await
        .expect("export");
    backup::restore_all_data(&h.paths, Path::new(&export.path))
        .await
        .expect("schedule");
    h.pool.close().await;

    let marker = h.dir.path().join("restore-pending.json");
    assert!(marker.exists(), "scheduling leaves a marker");

    backup::apply_pending_restore(&h.paths)
        .await
        .expect("apply")
        .expect("a restore ran");

    assert!(
        !marker.exists(),
        "a SUCCESSFUL restore retires the marker; only a failed one leaves it to resume"
    );

    // And a second launch has nothing to do.
    assert!(
        backup::apply_pending_restore(&h.paths)
            .await
            .expect("second launch")
            .is_none(),
        "a completed restore must not run again"
    );
}

#[tokio::test]
async fn a_restore_that_cannot_succeed_gives_up_rather_than_looping() {
    /*
     * The other side of keeping the marker: a restore that can never work must
     * not make the app unopenable forever. Each launch counts an attempt, and
     * after three the marker is retired with an error naming where the data is.
     */
    let h = harness().await;
    h.pool.close().await;

    let marker = h.dir.path().join("restore-pending.json");
    fs::write(
        &marker,
        serde_json::to_vec_pretty(&serde_json::json!({
            "exportPath": "/nonexistent/CandidCue-export-does-not-exist",
            "requestedAt": "2026-08-12T00:00:00Z",
            "appVersion": "1.0.0-rc.1",
            "attempts": 3,
        }))
        .expect("marker"),
    )
    .expect("write marker");

    let outcome = backup::apply_pending_restore(&h.paths).await;
    assert!(outcome.is_err(), "an exhausted restore reports failure");
    assert!(
        !marker.exists(),
        "and retires the marker, so the next launch is not stuck on it"
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

#[tokio::test]
async fn a_rebuild_does_not_fail_over_a_sidecar_that_is_not_there() {
    /*
     * The race this covers, which failed a release gate once and then would not
     * reproduce: `rebuild_database_index` used to test `exists()` and then
     * rename. SQLite removes `-wal` and `-shm` when the last connection closes,
     * and that can land AFTER `close()` has returned — so the check saw a
     * sidecar, the rename did not find it, and the rebuild failed with "No such
     * file or directory" having ALREADY moved the main database. The user was
     * left with no live database and an operation that reported failure.
     *
     * HONEST LIMIT: this test does NOT fail against the pre-check version. The
     * window cannot be opened deterministically without an injection point in
     * the product, so what is pinned here is the surrounding property — every
     * combination of present and absent sidecars produces the same outcome —
     * and the guarantee against the race itself rests on the shape of the code
     * (rename, then tolerate a source that is no longer there), not on this.
     */
    for sidecars in [vec![], vec!["-wal"], vec!["-wal", "-shm"]] {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = DataPaths::new(dir.path().to_path_buf());
        fs::write(dir.path().join("candidcue.sqlite3"), b"not really a database").expect("db");
        for suffix in &sidecars {
            fs::write(dir.path().join(format!("candidcue.sqlite3{suffix}")), b"x").expect("sidecar");
        }

        let quarantine = backup::rebuild_database_index(&paths)
            .unwrap_or_else(|e| panic!("rebuild with sidecars {sidecars:?} failed: {e:?}"));

        assert!(!dir.path().join("candidcue.sqlite3").exists());
        assert!(quarantine.join("candidcue.sqlite3").exists());
        for suffix in &sidecars {
            assert!(
                quarantine.join(format!("candidcue.sqlite3{suffix}")).exists(),
                "a sidecar that WAS there must still be moved"
            );
        }
    }
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

#[test]
fn every_registered_command_is_classified_for_recovery_mode() {
    /*
     * ENUMERATED, not listed.
     *
     * The first version of this test checked a hand-maintained list of twenty
     * command names — which is worth almost nothing: a command added later
     * without a guard is invisible to it, and that is precisely the failure
     * mode. A verification pass found eight real mutators it had missed,
     * including the speech-model download and delete, which write to the app
     * data directory, and `clear_cache`, which deletes logs.
     *
     * So this reads the ACTUAL command registry from `app.rs` and requires
     * every command to be one of three things:
     *
     *   1. guarded with `require_ready()`  — refuses to run in recovery mode;
     *   2. guarded with `require_recovery()` — destructive, and only correct
     *      when the database did NOT open;
     *   3. named in `RECOVERY_SAFE` below, with a reason.
     *
     * A new command is therefore an explicit decision. Adding one without
     * touching this file fails.
     */
    const RECOVERY_SAFE: &[(&str, &str)] = &[
        ("app_version", "reads package info; the recovery screen shows it"),
        ("get_boot_status", "the question recovery mode exists to answer"),
        (
            "get_startup_findings",
            "reads managed state and clears it; a repair report is worth showing whatever mode the app is in",
        ),
        ("list_database_backups", "read-only, and recovery needs it"),
        ("rescue_scripts", "copies canonical files OUT; the first thing a user wants"),
        ("reveal_data_folder", "opens Finder; the last resort that always works"),
        (
            "write_unsaved_recovery",
            "parks text a failed save would otherwise lose; must work when nothing else does",
        ),
        (
            "export_support_bundle",
            "the boot-failure screen offers it, so it must work when the database did not open",
        ),
        (
            "log_client_diagnostic",
            "the recovery screen's own failures have to be recordable",
        ),
        (
            "get_settings",
            "read-only against whichever pool is managed; the recovery screen reads the theme",
        ),
        ("get_speech_engine_status", "reads engine state; no app-data write"),
        ("get_speech_model_status", "reads the model store; no write"),
        ("get_speech_language_options", "reads the catalogue; no write"),
        ("preload_speech_engine", "loads a model into memory; touches no app data"),
        ("cancel_speech_model_download", "stops a write rather than making one"),
        ("push_transcription_audio", "in-memory; the session it feeds is already guarded"),
        ("stop_transcription", "ends a session; stopping is always allowed"),
        ("stop_alignment", "ditto"),
        ("set_alignment_position", "in-memory engine state"),
        ("reacquire_alignment", "in-memory engine state"),
        ("list_scripts", "read-only"),
        ("list_revisions", "read-only"),
        ("get_revision", "read-only"),
        ("reveal_script_folder", "opens Finder"),
        ("resolve_asset_urls", "read-only"),
        ("list_sessions", "read-only"),
        ("list_session_takes", "read-only"),
        ("list_displays", "read-only"),
        ("identify_displays", "shows overlays; no persistence"),
        ("list_display_profiles", "read-only"),
        ("get_system_diagnostics", "read-only; a support request needs it"),
        ("open_model_licence", "opens a validated url"),
        ("open_stage", "window management"),
        ("close_stage", "window management"),
        ("set_stage_fullscreen", "window management"),
        ("set_control_presenting", "window management"),
        ("publish_stage_document", "in-memory + an event"),
        ("publish_stage_command", "in-memory + an event"),
        ("get_stage_status", "read-only"),
        /*
         * Desktop shell (refinement §5, §6). All three are recovery-safe, and
         * two of them are recovery-USEFUL.
         *
         * `set_menu_state` and `set_window_title` touch no database at all —
         * they push state the frontend already holds onto the native menu and
         * the window's titlebar. The recovery screen is still an application
         * window and still wants a menu bar that greys out what it cannot do.
         *
         * `reveal_logs` opens one named directory. A boot that failed is
         * exactly when somebody needs the log, and it reads nothing from the
         * database to find it.
         */
        ("set_menu_state", "in-memory; native menu only"),
        ("set_window_title", "window management"),
        ("set_drop_target_script", "in-memory; a script id, no I/O"),
        ("open_preferences", "window management"),
        ("close_preferences", "window management"),
        ("focus_app_window", "window management; reads no database"),
        ("reveal_logs", "opens one named directory"),
    ];

    let app_rs = include_str!("../src/app.rs");
    let handler = app_rs
        .split("invoke_handler")
        .nth(1)
        .expect("app.rs must register commands")
        .split("])")
        .next()
        .expect("the handler list must be delimited");

    let registered: Vec<String> = handler
        .lines()
        .filter_map(|line| line.trim().strip_prefix("commands::"))
        .filter_map(|rest| rest.split(',').next())
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .collect();

    // Anti-vacuity: a parser that stopped matching would classify nothing and
    // pass, which is the shape of the defect this test replaces.
    assert!(
        registered.len() > 40,
        "only found {} registered commands; the parser is broken",
        registered.len()
    );

    let sources = [
        include_str!("../src/commands/mod.rs"),
        include_str!("../src/commands/scripts_cmds.rs"),
        include_str!("../src/commands/assets_cmds.rs"),
        include_str!("../src/commands/sessions_cmds.rs"),
        include_str!("../src/commands/settings_cmds.rs"),
        include_str!("../src/commands/stage_cmds.rs"),
        include_str!("../src/commands/speech_cmds.rs"),
        include_str!("../src/commands/align_cmds.rs"),
        include_str!("../src/commands/recovery_cmds.rs"),
        include_str!("../src/commands/shell_cmds.rs"),
    ]
    .concat();

    let safe: std::collections::HashMap<&str, &str> = RECOVERY_SAFE.iter().copied().collect();
    let mut unclassified = Vec::new();

    for command in &registered {
        let Some(body) = sources.split(&format!("pub async fn {command}")).nth(1) else {
            // Not async — `app_version` is a plain fn. Still has to be classified.
            if sources.contains(&format!("pub fn {command}")) {
                if !safe.contains_key(command.as_str()) {
                    unclassified.push(command.clone());
                }
                continue;
            }
            panic!("{command} is registered but has no definition");
        };
        /*
         * Bounded to THIS function's body.
         *
         * A fixed 2 KB window was the first attempt and it was vacuous: the
         * command bodies here are short, so the window ran past the end of one
         * function into the next command's guard and every command looked
         * guarded. Removing a real guard did not fail the test — which is the
         * precise failure this whole test exists to catch, reproduced inside
         * the test itself. Cut at the next command instead.
         */
        let head = body
            .split("#[tauri::command]")
            .next()
            .unwrap_or(body);
        let guarded =
            head.contains("boot.require_ready()?") || head.contains("boot.require_recovery()?");
        if !guarded && !safe.contains_key(command.as_str()) {
            unclassified.push(command.clone());
        }
    }

    assert!(
        unclassified.is_empty(),
        "these commands are neither guarded nor declared recovery-safe:\n  {}\n\n\
         Add `boot.require_ready()?` if the command writes anything, or add it to \
         RECOVERY_SAFE with the reason it is safe to run while the database is unavailable.",
        unclassified.join("\n  ")
    );

    // And the other direction: a stale RECOVERY_SAFE entry naming a command
    // that no longer exists is a claim nobody is checking.
    let stale: Vec<&str> = RECOVERY_SAFE
        .iter()
        .map(|(name, _)| *name)
        .filter(|name| !registered.iter().any(|r| r == name))
        .collect();
    assert!(stale.is_empty(), "RECOVERY_SAFE names unregistered commands: {stale:?}");
}

/* ------------------------------------------- support-bundle privacy canaries */

/// A support bundle must not carry the user's name or a URL's query string.
///
/// The 1.0 readiness review's point was precise: the diagnostics module's
/// comments say callers pass step names, states and timings rather than user
/// content, and *that is a convention, not an enforceable type boundary*.
///
/// A convention cannot be tested. Two things can:
///
///  1. that the shapes which DO leak reliably are redacted on the way into the
///     bundle — an absolute path under a home directory carries the person's
///     real name, and a URL carries its query string;
///  2. that the diagnostic call sites do not interpolate script or transcript
///     text, which no pattern can recognise and which therefore has to be
///     checked structurally. That is the test below this one.
#[tokio::test]
async fn a_support_bundle_redacts_paths_and_urls() {
    use candidcue_lib::scripts::DataPaths;

    let dir = tempfile::tempdir().expect("tempdir");
    let paths = DataPaths::new(dir.path().to_path_buf());
    std::fs::create_dir_all(paths.logs_dir()).expect("logs dir");

    std::fs::write(
        paths.logs_dir().join("candidcue-rust.2026-08-12.log"),
        "2026-08-12T10:00:00Z INFO opened /Users/aurelia-fitzwilliam/Documents/keynote/script.md\n\
         2026-08-12T10:00:01Z INFO fetched https://models.example.com/x-asr.tar.bz2?token=SECRETVALUE\n\
         2026-08-12T10:00:02Z INFO mirror https://first.example/a?leak=EARLIERSECRET then http://second.example/b\n\
         2026-08-12T10:00:03Z INFO alignment settled in 12ms\n",
    )
    .expect("write log");

    let bundle = tempfile::tempdir().expect("bundle");
    candidcue_lib::diagnostics::logging::copy_support_logs(&paths.logs_dir(), bundle.path())
        .expect("copy logs");

    let copied = std::fs::read_to_string(bundle.path().join("logs/candidcue-rust.2026-08-12.log"))
        .expect("the bundle must contain the log");

    // Anti-vacuity: an empty or missing copy would satisfy every ban below.
    assert!(
        copied.contains("alignment settled in 12ms"),
        "the bundle must still carry the diagnostics it exists for: {copied}"
    );

    assert!(
        !copied.contains("aurelia-fitzwilliam"),
        "a home-directory path carries the user's real name:\n{copied}"
    );
    assert!(
        !copied.contains("SECRETVALUE"),
        "a URL query string carries whatever was in it:\n{copied}"
    );
    assert!(
        copied.contains("models.example.com"),
        "the host is the diagnostic value and must survive:\n{copied}"
    );

    /*
     * Two urls on one line, https first.
     *
     * The first version of the redactor did `find("http://").or_else(||
     * find("https://"))`, which starts at whichever `http://` appears —
     * possibly the LATER one — and copies everything before it through as
     * ordinary prefix text. The earlier https url, query string and all,
     * survived untouched.
     */
    assert!(
        !copied.contains("EARLIERSECRET"),
        "an https url earlier in the line than an http one must still be redacted:\n{copied}"
    );
    assert!(
        copied.contains("first.example") && copied.contains("second.example"),
        "both hosts are diagnostic and must survive:\n{copied}"
    );
}

/// No diagnostic call interpolates script or transcript text.
///
/// The half no pattern can catch, checked structurally instead. `trace(...)`
/// and `log_client_diagnostic` both take a composed `String`, so the boundary
/// is the CALL SITE — and a call site is something a test can read.
#[test]
fn diagnostic_calls_do_not_interpolate_user_content() {
    let mut offenders = Vec::new();
    let mut inspected = 0usize;

    for rel in glob_sources() {
        let source = std::fs::read_to_string(&rel).unwrap_or_default();
        for (index, line) in source.lines().enumerate() {
            if !line.contains("trace(") && !line.contains("logClientDiagnostic(") {
                continue;
            }
            inspected += 1;
            /*
             * The variables that hold user content. A diagnostic line
             * interpolating any of them is putting the user's writing, or
             * what they said out loud, into a file they may email to support.
             */
            for banned in [
                "${source}",
                "${text}",
                "${transcript}",
                "${s.source}",
                "${script.source}",
                "${title}",
            ] {
                if line.contains(banned) {
                    offenders.push(format!("{}:{}: {}", rel.display(), index + 1, line.trim()));
                }
            }
        }
    }

    assert!(
        inspected > 0,
        "found no diagnostic call sites at all, so this test proved nothing"
    );
    assert!(
        offenders.is_empty(),
        "these diagnostic calls interpolate user content:\n  {}",
        offenders.join("\n  ")
    );
}

fn glob_sources() -> Vec<std::path::PathBuf> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("repo root")
        .join("src");
    let mut found = Vec::new();
    let mut pending = vec![root];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
            } else if path
                .extension()
                .map(|e| e == "ts" || e == "svelte")
                .unwrap_or(false)
            {
                found.push(path);
            }
        }
    }
    found
}

/// Pin the quarantine generation in the marker so a test can pre-place an
/// obstruction inside it. The generation is normally minted at runtime.
fn pin_generation(dir: &Path, generation: &str) -> std::path::PathBuf {
    let marker = dir.join("restore-pending.json");
    let mut pending: serde_json::Value =
        serde_json::from_slice(&fs::read(&marker).expect("marker")).expect("parses");
    pending["quarantineGeneration"] = serde_json::json!(generation);
    fs::write(&marker, serde_json::to_vec_pretty(&pending).expect("json")).expect("write");
    dir.join("quarantine").join(generation)
}

/// Record components as evacuated in the marker, the way a real attempt does
/// after each successful move.
///
/// A test that simulates an interrupted attempt has to write this too: the
/// journal — not the existence of the quarantine directory — is what tells a
/// resume that the copy in there is the complete original.
fn journal_absent(dir: &Path, names: &[&str]) {
    let marker = dir.join("restore-pending.json");
    let mut pending: serde_json::Value =
        serde_json::from_slice(&fs::read(&marker).expect("marker")).expect("parses");
    pending["absent"] = serde_json::json!(names);
    fs::write(&marker, serde_json::to_vec_pretty(&pending).expect("json")).expect("write");
}

fn journal_evacuated(dir: &Path, names: &[&str]) {
    let marker = dir.join("restore-pending.json");
    let mut pending: serde_json::Value =
        serde_json::from_slice(&fs::read(&marker).expect("marker")).expect("parses");
    pending["evacuated"] = serde_json::json!(names);
    fs::write(&marker, serde_json::to_vec_pretty(&pending).expect("json")).expect("write");
}

#[tokio::test]
async fn a_rollback_never_deletes_something_it_did_not_move() {
    /*
     * The blocker a verification pass found in the first version of this
     * rollback, and it destroyed data on a reachable sequence:
     *
     *   1. the scripts tree evacuates into quarantine;
     *   2. the database move FAILS — so the database is still live, untouched
     *      and correct;
     *   3. the rollback deleted the live scripts AND the live database
     *      unconditionally, then restored whatever it found in quarantine;
     *   4. there was no quarantined database, so it was simply gone.
     *
     * The failure is injected by pre-placing a non-empty DIRECTORY at the
     * quarantine path the database would move to: a rename onto that fails,
     * and it is not `EXDEV`, so `move_or_copy` propagates rather than copying.
     * The scripts move fine, so the evacuation is genuinely half-done — the
     * exact state that used to be unrecoverable.
     */
    let h = harness().await;
    repo::create_script(&h.pool, &h.paths, create_input("Precious", "# Precious\n\nKeep me."))
        .await
        .expect("create");

    let dest = tempfile::tempdir().expect("dest");
    let export = backup::export_all_data(&h.pool, &h.paths, dest.path())
        .await
        .expect("export");
    backup::restore_all_data(&h.paths, Path::new(&export.path))
        .await
        .expect("schedule");
    h.pool.close().await;

    let quarantine = pin_generation(h.dir.path(), "test-generation");
    fs::create_dir_all(quarantine.join("candidcue.sqlite3").join("blocker"))
        .expect("obstruct the database's quarantine path");

    let live_db = h.dir.path().join("candidcue.sqlite3");
    /*
     * IDENTITY, not bytes.
     *
     * The first version compared the file's contents before and after, and
     * failed intermittently: closing the pool can leave SQLite checkpointing,
     * so the live database's bytes are allowed to settle after the read
     * without anything being wrong. What must not change is that this is the
     * same file — a delete-and-copy takes a new inode, which is precisely what
     * the old rollback did to a database it had never evacuated.
     */
    #[cfg(unix)]
    let before = {
        use std::os::unix::fs::MetadataExt;
        fs::metadata(&live_db).expect("the live database exists before the attempt").ino()
    };

    let outcome = backup::apply_pending_restore(&h.paths).await;
    assert!(outcome.is_err(), "a half-done evacuation must fail the restore");

    /*
     * The component that was never moved must still be there. This is the
     * whole assertion: the old rollback deleted it.
     */
    assert!(live_db.is_file(), "the rollback deleted a database it never evacuated");
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        assert_eq!(
            fs::metadata(&live_db).expect("read").ino(),
            before,
            "and it must be the SAME file, not a copy written over it"
        );
    }

    // And the scripts, which WERE evacuated, must have been put back.
    let restored: Vec<String> = fs::read_dir(h.paths.scripts_dir())
        .expect("scripts must exist again")
        .filter_map(|e| e.ok())
        .filter_map(|e| fs::read_to_string(e.path().join("script.md")).ok())
        .collect();
    assert!(
        restored.iter().any(|body| body.contains("Keep me.")),
        "the evacuated scripts must be rolled back, found {restored:?}"
    );
}

#[tokio::test]
async fn a_retry_reuses_the_first_attempt_s_quarantine_generation() {
    /*
     * A fresh timestamped quarantine directory per ATTEMPT loses the identity
     * of the original state: after a crash the next attempt would quarantine
     * the previous attempt's partial output, and the real original would be
     * two generations back with nothing naming it. The generation is minted
     * once and recorded in the marker.
     */
    let h = harness().await;
    let dest = tempfile::tempdir().expect("dest");
    let export = backup::export_all_data(&h.pool, &h.paths, dest.path())
        .await
        .expect("export");
    backup::restore_all_data(&h.paths, Path::new(&export.path))
        .await
        .expect("schedule");
    h.pool.close().await;

    // Fail the same way, twice.
    let quarantine = pin_generation(h.dir.path(), "test-generation");
    fs::create_dir_all(quarantine.join("candidcue.sqlite3").join("blocker")).expect("obstruct");

    let _ = backup::apply_pending_restore(&h.paths).await;
    let after_first: serde_json::Value = serde_json::from_slice(
        &fs::read(h.dir.path().join("restore-pending.json"))
            .expect("the marker survives a failure"),
    )
    .expect("parses");
    assert_eq!(after_first["attempts"], serde_json::json!(1));
    assert_eq!(after_first["quarantineGeneration"], serde_json::json!("test-generation"));

    let _ = backup::apply_pending_restore(&h.paths).await;
    let after_second: serde_json::Value = serde_json::from_slice(
        &fs::read(h.dir.path().join("restore-pending.json")).expect("still there"),
    )
    .expect("parses");
    assert_eq!(
        after_second["quarantineGeneration"],
        serde_json::json!("test-generation"),
        "a retry must evacuate into the SAME generation as the first attempt"
    );
    assert_eq!(after_second["attempts"], serde_json::json!(2));
}

#[tokio::test]
async fn a_restore_interrupted_mid_copy_finishes_on_the_next_launch() {
    /*
     * The state a crash actually leaves, and the one the straight-line
     * evacuation could not survive: the original is ALREADY in quarantine and
     * the live paths hold however much of the export had been copied before
     * the process died.
     *
     * The retry then tried to move the live scripts onto the quarantined
     * original — a rename onto a non-empty directory, which is not `EXDEV`, so
     * `move_or_copy` propagated it — and failed identically on every launch
     * until the attempt limit retired the restore. The data was never lost (it
     * is in quarantine), but the restore could never finish and the live tree
     * stayed half-written.
     *
     * The interruption is simulated rather than caused: the test does by hand
     * exactly what a first attempt does before dying, which is the only way to
     * reach the state without killing a process mid-syscall.
     */
    let h = harness().await;
    repo::create_script(&h.pool, &h.paths, create_input("Original", "# Original\n\nKeep me."))
        .await
        .expect("create");

    let dest = tempfile::tempdir().expect("dest");
    let export = backup::export_all_data(&h.pool, &h.paths, dest.path())
        .await
        .expect("export");
    backup::restore_all_data(&h.paths, Path::new(&export.path))
        .await
        .expect("schedule");
    h.pool.close().await;

    // --- what the interrupted first attempt had already done -----------------
    let quarantine = pin_generation(h.dir.path(), "test-generation");
    fs::create_dir_all(&quarantine).expect("quarantine");
    // 1. the originals, evacuated — and JOURNALLED, which is what makes them
    //    recognisable as originals rather than as a half-finished copy;
    let mut journalled = vec!["scripts".to_string()];
    fs::rename(h.paths.scripts_dir(), quarantine.join("scripts")).expect("evacuate scripts");
    for suffix in ["", "-wal", "-shm"] {
        let name = format!("candidcue.sqlite3{suffix}");
        let from = h.dir.path().join(&name);
        if from.exists() {
            fs::rename(&from, quarantine.join(&name)).expect("evacuate database");
            journalled.push(name);
        }
    }
    journal_evacuated(
        h.dir.path(),
        &journalled.iter().map(String::as_str).collect::<Vec<_>>(),
    );
    // 2. a PARTIAL copy of the export, left live by the crash.
    let partial = h.paths.scripts_dir().join("half-written");
    fs::create_dir_all(&partial).expect("partial");
    fs::write(partial.join("script.md"), "# Truncated").expect("partial body");

    // --- the next launch -----------------------------------------------------
    let previous = backup::apply_pending_restore(&h.paths)
        .await
        .expect("a resumed restore must finish")
        .expect("a restore ran");

    assert!(
        !h.dir.path().join("restore-pending.json").exists(),
        "finishing must retire the marker"
    );
    assert!(
        h.dir.path().join("candidcue.sqlite3").is_file(),
        "the restored database must be live"
    );

    let live: Vec<String> = fs::read_dir(h.paths.scripts_dir())
        .expect("scripts")
        .filter_map(|e| e.ok())
        .filter_map(|e| fs::read_to_string(e.path().join("script.md")).ok())
        .collect();
    assert!(
        live.iter().any(|body| body.contains("Keep me.")),
        "the exported script must be live after the resume, found {live:?}"
    );
    assert!(
        !live.iter().any(|body| body.contains("Truncated")),
        "and the dead attempt's partial output must not be mixed in with it"
    );

    // The partial output is set aside, not deleted: nothing in a restore
    // destroys bytes it did not write.
    let aside = previous.join("interrupted-attempt-1").join("scripts");
    assert!(
        aside.join("half-written").join("script.md").is_file(),
        "the interrupted attempt's output must be kept at {}",
        aside.display()
    );
    // And the original is still where the first attempt put it.
    assert!(
        previous.join("scripts").is_dir(),
        "the quarantined original must not have been moved or overwritten"
    );
}

#[tokio::test]
async fn an_unjournalled_obstruction_is_refused_on_every_attempt() {
    /*
     * "This restore has a quarantine generation" is not proof that this
     * restore put anything in it.
     *
     * The generation is minted and recorded BEFORE the first move, so a first
     * attempt that refuses an obstruction still leaves the name in the marker
     * — and a rule that trusted an occupied path "because we are resuming"
     * would accept that same obstruction on the very next launch, then set the
     * live original aside in its favour. The journal is written after a move
     * succeeds, so it says what is actually in there.
     */
    let h = harness().await;
    repo::create_script(&h.pool, &h.paths, create_input("Precious", "# Precious\n\nKeep me."))
        .await
        .expect("create");

    let dest = tempfile::tempdir().expect("dest");
    let export = backup::export_all_data(&h.pool, &h.paths, dest.path())
        .await
        .expect("export");
    backup::restore_all_data(&h.paths, Path::new(&export.path))
        .await
        .expect("schedule");
    h.pool.close().await;

    // An obstruction of the RIGHT KIND — a file where the database's original
    // would go — so nothing but the journal can tell it apart from one.
    let quarantine = pin_generation(h.dir.path(), "test-generation");
    fs::create_dir_all(&quarantine).expect("quarantine");
    fs::write(quarantine.join("candidcue.sqlite3"), b"not a database").expect("obstruct");

    let live_db = h.dir.path().join("candidcue.sqlite3");
    #[cfg(unix)]
    let before = {
        use std::os::unix::fs::MetadataExt;
        fs::metadata(&live_db).expect("live database").ino()
    };

    for attempt in 1..=2 {
        assert!(
            backup::apply_pending_restore(&h.paths).await.is_err(),
            "attempt {attempt} must refuse an obstruction it cannot account for"
        );
        assert!(live_db.is_file(), "attempt {attempt} removed the live database");
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            assert_eq!(
                fs::metadata(&live_db).expect("live database").ino(),
                before,
                "attempt {attempt} replaced the live database"
            );
        }
        // And the obstruction is still exactly what it was — not adopted, not
        // overwritten, not moved aside.
        assert_eq!(
            fs::read(quarantine.join("candidcue.sqlite3")).expect("obstruction"),
            b"not a database",
        );
    }
}

#[tokio::test]
async fn a_rollback_puts_back_an_absence_as_well_as_a_file() {
    /*
     * A rollback has to restore what was NOT there.
     *
     * The commit creates the scripts directory and the database whether or not
     * they existed before, so a journal of moves alone left anything newly
     * created sitting live after a failed restore — with the message saying
     * the previous data had been put back. Here the scripts directory is
     * missing before the restore (a user who lost it, which is a reason to
     * restore in the first place), and the database verification fails after
     * the commit has recreated it.
     */
    let h = harness().await;
    repo::create_script(&h.pool, &h.paths, create_input("Precious", "# Precious\n\nKeep me."))
        .await
        .expect("create");

    let dest = tempfile::tempdir().expect("dest");
    let export = backup::export_all_data(&h.pool, &h.paths, dest.path())
        .await
        .expect("export");
    let export_root = std::path::PathBuf::from(&export.path);

    /*
     * Damage the export's DATABASE in a way its manifest still vouches for, so
     * the failure lands where nothing else can reach: after the evacuation and
     * after the copy, in `verify_database_file`. Every earlier gate checks the
     * manifest, so the manifest has to agree with the damage.
     */
    let garbage = vec![0u8; 4096];
    fs::write(export_root.join("candidcue.sqlite3"), &garbage).expect("damage the database");
    let digest = {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(&garbage);
        hex::encode(hasher.finalize())
    };
    let manifest_path = export_root.join("manifest.json");
    let mut manifest = manifest_of(&export_root);
    for file in manifest["files"].as_array_mut().expect("files") {
        if file["path"] == serde_json::json!("candidcue.sqlite3") {
            file["sha256"] = serde_json::json!(digest);
            file["bytes"] = serde_json::json!(garbage.len());
        }
    }
    fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest).expect("json"))
        .expect("rewrite manifest");

    backup::restore_all_data(&h.paths, &export_root)
        .await
        .expect("schedule");
    h.pool.close().await;

    // The state the restore is FOR: the scripts tree is gone.
    fs::remove_dir_all(h.paths.scripts_dir()).expect("lose the scripts");

    assert!(
        backup::apply_pending_restore(&h.paths).await.is_err(),
        "a database that fails its integrity check must fail the restore"
    );

    assert!(
        !h.paths.scripts_dir().exists(),
        "the rollback left behind a scripts directory the commit created; \
         'put your previous data back' has to include putting back the absence"
    );
    // And the component that WAS there is back.
    assert!(
        h.dir.path().join("candidcue.sqlite3").is_file(),
        "the evacuated database must have been rolled back"
    );
}

#[tokio::test]
async fn a_rolled_back_component_stops_being_trusted_in_quarantine() {
    /*
     * The journal has to describe what is IN quarantine right now, not what
     * once went there.
     *
     * A rollback moves the originals back, emptying those quarantine paths. If
     * the journal still named them, the next attempt would treat ANYTHING it
     * found at one of those paths as its own evacuated original — and set the
     * live copy aside in its favour. That is the hole the journal exists to
     * close, reopened by a stale entry.
     */
    let h = harness().await;
    repo::create_script(&h.pool, &h.paths, create_input("Precious", "# Precious\n\nKeep me."))
        .await
        .expect("create");

    let dest = tempfile::tempdir().expect("dest");
    let export = backup::export_all_data(&h.pool, &h.paths, dest.path())
        .await
        .expect("export");
    backup::restore_all_data(&h.paths, Path::new(&export.path))
        .await
        .expect("schedule");
    h.pool.close().await;

    // Attempt 1 fails during the DATABASE evacuation, so the scripts tree is
    // evacuated, journalled, and then rolled back.
    let quarantine = pin_generation(h.dir.path(), "test-generation");
    fs::create_dir_all(quarantine.join("candidcue.sqlite3").join("blocker")).expect("obstruct");
    assert!(backup::apply_pending_restore(&h.paths).await.is_err());

    let marker: serde_json::Value =
        serde_json::from_slice(&fs::read(h.dir.path().join("restore-pending.json")).expect("marker"))
            .expect("parses");
    let journal = marker["evacuated"].as_array().cloned().unwrap_or_default();
    assert!(
        !journal.iter().any(|n| n == "scripts"),
        "a component that was rolled back must not still be listed as quarantined, got {journal:?}"
    );

    /*
     * And the consequence, which is the reason the journal is checked at all:
     * something else at that path is refused rather than adopted. If `scripts`
     * were still journalled, the live tree would be set aside in favour of this
     * directory.
     */
    fs::create_dir_all(quarantine.join("scripts").join("not-ours")).expect("second obstruction");
    assert!(backup::apply_pending_restore(&h.paths).await.is_err());
    let live: Vec<String> = fs::read_dir(h.paths.scripts_dir())
        .expect("the live scripts must still be there")
        .filter_map(|e| e.ok())
        .filter_map(|e| fs::read_to_string(e.path().join("script.md")).ok())
        .collect();
    assert!(
        live.iter().any(|body| body.contains("Keep me.")),
        "the live scripts were set aside for a directory the restore never wrote, found {live:?}"
    );
}

#[tokio::test]
async fn a_resume_does_not_mistake_its_own_output_for_the_users_data() {
    /*
     * The cross-launch half of "a rollback must put back an absence".
     *
     * The commit creates the scripts directory and the database whether or not
     * they were there. So if a restore starts with no scripts tree, gets as far
     * as copying the export in, and the process dies — the next launch finds a
     * populated scripts directory that IS THIS RESTORE'S OWN OUTPUT.
     *
     * With absence recorded only in memory, that launch evacuated the output
     * into quarantine and journalled it as the original. A later rollback would
     * then restore a half-copied export as if it were the user's data, and the
     * message would say the previous data had been put back.
     *
     * The marker now carries `absent`, so a resume knows better.
     */
    let h = harness().await;
    repo::create_script(&h.pool, &h.paths, create_input("Original", "# Original\n\nKeep me."))
        .await
        .expect("create");

    let dest = tempfile::tempdir().expect("dest");
    let export = backup::export_all_data(&h.pool, &h.paths, dest.path())
        .await
        .expect("export");
    backup::restore_all_data(&h.paths, Path::new(&export.path))
        .await
        .expect("schedule");
    h.pool.close().await;

    // --- the interrupted first attempt ---------------------------------------
    let quarantine = pin_generation(h.dir.path(), "test-generation");
    fs::create_dir_all(&quarantine).expect("quarantine");
    // It found no scripts tree at all, and recorded that.
    fs::remove_dir_all(h.paths.scripts_dir()).expect("lose the scripts");
    journal_absent(h.dir.path(), &["scripts"]);
    // It evacuated the database, and recorded that.
    let mut journalled: Vec<String> = Vec::new();
    for suffix in ["", "-wal", "-shm"] {
        let name = format!("candidcue.sqlite3{suffix}");
        let from = h.dir.path().join(&name);
        if from.exists() {
            fs::rename(&from, quarantine.join(&name)).expect("evacuate");
            journalled.push(name);
        }
    }
    journal_evacuated(
        h.dir.path(),
        &journalled.iter().map(String::as_str).collect::<Vec<_>>(),
    );
    // ...and then it died half way through copying the export's scripts in.
    let partial = h.paths.scripts_dir().join("half-written");
    fs::create_dir_all(&partial).expect("partial");
    fs::write(partial.join("script.md"), "# Truncated").expect("partial body");

    // --- the next launch ------------------------------------------------------
    let previous = backup::apply_pending_restore(&h.paths)
        .await
        .expect("the resume must finish")
        .expect("a restore ran");

    // The restore's own half-written output must NOT be sitting in quarantine
    // under the name of the user's original scripts tree.
    let quarantined_scripts = previous.join("scripts");
    if quarantined_scripts.exists() {
        let bodies: Vec<String> = fs::read_dir(&quarantined_scripts)
            .expect("read")
            .filter_map(|e| e.ok())
            .filter_map(|e| fs::read_to_string(e.path().join("script.md")).ok())
            .collect();
        assert!(
            !bodies.iter().any(|b| b.contains("Truncated")),
            "the dead attempt's output was quarantined as if it were the original: {bodies:?}"
        );
    }

    // And the live tree is the export, not a mixture.
    let live: Vec<String> = fs::read_dir(h.paths.scripts_dir())
        .expect("scripts")
        .filter_map(|e| e.ok())
        .filter_map(|e| fs::read_to_string(e.path().join("script.md")).ok())
        .collect();
    assert!(live.iter().any(|b| b.contains("Keep me.")));
    assert!(!live.iter().any(|b| b.contains("Truncated")));
}

#[tokio::test]
async fn a_marker_flagged_completed_is_retired_rather_than_replayed() {
    /*
     * `remove_file` on the marker was a `let _ =`. If it fails, the next launch
     * replays a restore over data that has already been restored: it sets the
     * result aside and copies the export in again — and if the export has since
     * been deleted, it fails and keeps failing. The success path now records
     * `completed` durably BEFORE removing the marker, so both the failed
     * removal and a crash in that window land on the same recorded state.
     *
     * SCOPE, precisely — the name says what it proves. This covers the READ
     * side: a marker carrying `completed` is retired without a replay, even
     * when the export it names has since vanished (so a replay could not pass
     * this by accident). It does NOT prove the write side, because making
     * `remove_file` fail while leaving the same directory writable enough for
     * `write_marker` to succeed cannot be arranged: both act on one directory.
     * The ordering that makes the write side work is asserted by reading it,
     * and the residual is documented at the call site.
     */
    let h = harness().await;
    let dest = tempfile::tempdir().expect("dest");
    let export = backup::export_all_data(&h.pool, &h.paths, dest.path())
        .await
        .expect("export");
    backup::restore_all_data(&h.paths, Path::new(&export.path))
        .await
        .expect("schedule");
    h.pool.close().await;

    let marker = h.dir.path().join("restore-pending.json");
    let mut pending: serde_json::Value =
        serde_json::from_slice(&fs::read(&marker).expect("marker")).expect("parses");
    pending["completed"] = serde_json::json!(true);
    // Point it at an export that is no longer there, so a replay could not
    // quietly succeed and pass this test by accident.
    pending["exportPath"] = serde_json::json!("/nonexistent/export");
    fs::write(&marker, serde_json::to_vec_pretty(&pending).expect("json")).expect("write");

    let outcome = backup::apply_pending_restore(&h.paths)
        .await
        .expect("a finished restore must not fail the launch");
    assert!(outcome.is_none(), "it must not run a second time");
    assert!(!marker.exists(), "and the marker is retired");
}

#[tokio::test]
async fn a_rebuild_interrupted_between_its_renames_is_finished_before_sqlite_opens() {
    /*
     * Three renames are not one operation.
     *
     * A rebuild moves `candidcue.sqlite3`, then `-wal`, then `-shm`. A crash
     * between the first and the second leaves a WAL live beside no database —
     * and the next launch creates a fresh database at that path, whereupon
     * SQLite finds a WAL whose header belongs to a file that no longer exists
     * and discards it. Every page committed to that WAL and not yet
     * checkpointed goes with it, so the copy the rebuild promised to keep is
     * missing exactly the most recent work.
     *
     * The rebuild now writes its intent down first, and `database::init`
     * finishes the move before opening anything.
     */
    let dir = tempfile::tempdir().expect("tempdir");
    fs::create_dir_all(dir.path().join("quarantine")).expect("quarantine");

    // The state the crash leaves: the database already moved, its WAL not.
    let quarantine = dir.path().join("quarantine").join("pre-rebuild-interrupted");
    fs::create_dir_all(&quarantine).expect("generation");
    fs::write(quarantine.join("candidcue.sqlite3"), b"the moved database").expect("moved");
    fs::write(dir.path().join("candidcue.sqlite3-wal"), b"orphaned wal").expect("orphan wal");
    fs::write(dir.path().join("candidcue.sqlite3-shm"), b"orphaned shm").expect("orphan shm");
    fs::write(
        dir.path().join("rebuild-pending.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "quarantine": quarantine.to_string_lossy(),
        }))
        .expect("json"),
    )
    .expect("marker");

    // A launch. `init` finishes the rebuild before it opens anything.
    let pool = candidcue_lib::database::init(dir.path()).await.expect("init");
    pool.close().await;

    assert!(
        quarantine.join("candidcue.sqlite3-wal").is_file(),
        "the orphaned WAL must be kept beside the database it belongs to"
    );
    assert!(quarantine.join("candidcue.sqlite3-shm").is_file());
    assert_eq!(
        fs::read(quarantine.join("candidcue.sqlite3-wal")).expect("read"),
        b"orphaned wal",
        "and it must be the same bytes, not a WAL SQLite made for the new database"
    );
    assert!(
        !dir.path().join("rebuild-pending.json").exists(),
        "a finished rebuild retires its marker"
    );
    // The database that was quarantined is untouched by any of this.
    assert_eq!(
        fs::read(quarantine.join("candidcue.sqlite3")).expect("read"),
        b"the moved database"
    );
}

#[tokio::test]
async fn a_pre_baseline_quarantine_interrupted_between_its_renames_is_finished_too() {
    /*
     * The same three-rename defect existed twice, independently: once in the
     * rebuild and once in the pre-1.0-baseline quarantine. Both go through the
     * journalled mover now, and the finisher honours the destination the marker
     * records — the pre-1.0 path names the file after the baseline it predates
     * rather than using the plain database name, so a finisher that assumed the
     * rebuild's layout would strand the WAL under a name nothing reads.
     */
    let dir = tempfile::tempdir().expect("tempdir");
    let quarantine = dir.path().join("quarantine");
    fs::create_dir_all(&quarantine).expect("quarantine");

    let stem = quarantine.join("pre-1.0-baseline-20260812T000000Z.sqlite3");
    fs::write(&stem, b"the moved legacy database").expect("moved");
    fs::write(dir.path().join("candidcue.sqlite3-wal"), b"orphaned wal").expect("orphan wal");
    fs::write(
        dir.path().join("rebuild-pending.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "quarantine": quarantine.to_string_lossy(),
            "stem": stem.to_string_lossy(),
        }))
        .expect("json"),
    )
    .expect("marker");

    let pool = candidcue_lib::database::init(dir.path()).await.expect("init");
    pool.close().await;

    let wal = quarantine.join("pre-1.0-baseline-20260812T000000Z.sqlite3-wal");
    assert!(
        wal.is_file(),
        "the orphaned WAL must join the database it belongs to, at {}",
        wal.display()
    );
    assert_eq!(fs::read(&wal).expect("read"), b"orphaned wal");
    assert!(!dir.path().join("rebuild-pending.json").exists());
}

#[test]
fn the_database_commits_durably_because_some_of_it_exists_nowhere_else() {
    /*
     * WAL + `synchronous = NORMAL` does not fsync on commit: a transaction that
     * returned success can be lost to a power cut. For a script that is
     * survivable — the Markdown file is the authority and the row is rebuilt
     * from it. For settings, session and take history, and a retained
     * transcript there is no such copy: "saved" has to mean saved.
     *
     * A source assertion, because the alternative is cutting power to a
     * machine. It is worth having anyway: this is one word in one builder, and
     * changing it back would be silent everywhere else.
     */
    let source = fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/database/mod.rs"),
    )
    .expect("database/mod.rs");
    let code: String = source
        .lines()
        .filter(|line| {
            let t = line.trim_start();
            !(t.starts_with("//") || t.starts_with('*') || t.starts_with("/*"))
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        code.contains("SqliteSynchronous::Full"),
        "the live pool must commit durably"
    );
    assert!(
        !code.contains("SqliteSynchronous::Normal"),
        "and must not go back to a mode that acknowledges a write it has not flushed"
    );
}

#[tokio::test]
async fn creating_a_script_commits_every_directory_it_makes() {
    /*
     * The chain a new script needs: `scripts/` holds `<id>/`, which holds the
     * canonical file plus `assets/` and `revisions/`. `atomic_write` flushes the
     * file and its immediate directory; every entry ABOVE that was left in the
     * page cache, while the database row naming the script was durable — so a
     * power loss could leave the library showing a script whose file is nowhere,
     * or a first revision written into a directory that no longer exists.
     *
     * Behavioural half: the directories really are created. Source half: they
     * are created through the durable helper, which is the part a test cannot
     * observe without cutting power.
     */
    let h = harness().await;
    let created = repo::create_script(&h.pool, &h.paths, create_input("Chain", "# Chain"))
        .await
        .expect("create");
    let id = candidcue_lib::scripts::ScriptId::parse(&created.id).expect("id");
    assert!(h.paths.canonical_file(&id).is_file());
    assert!(h.paths.assets_dir(&id).is_dir());
    assert!(h.paths.revisions_dir(&id).is_dir());
    h.pool.close().await;

    let repo_source = fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/scripts/repo.rs"),
    )
    .expect("repo.rs");
    let create = &repo_source[repo_source
        .find("pub async fn create_script")
        .expect("create_script exists")..];
    let create = &create[..create.find("\npub ").unwrap_or(create.len())];
    for expected in [
        "create_dir_all_durable(&paths.assets_dir(&id))",
        "create_dir_all_durable(&paths.revisions_dir(&id))",
        "sync_dir(&paths.scripts_dir())",
    ] {
        assert!(
            create.contains(expected),
            "creating a script must go through `{expected}`"
        );
    }
}
