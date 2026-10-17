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
    // The pinned prompter display (#272), which used to live only in the
    // WebView's localStorage and so was never in an export at all.
    let current = candidcue_lib::settings::get_settings(&h.pool).await.expect("settings");
    candidcue_lib::settings::update_settings(
        &h.pool,
        current.revision,
        serde_json::json!({
            "stageBehavior": { "displayFingerprint": "dsp-glass", "displayPinMigrated": true }
        }),
    )
    .await
    .expect("pin the prompter display");

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
    let settings: serde_json::Value =
        serde_json::from_slice(&fs::read(export.join("settings.json")).expect("settings.json"))
            .expect("settings.json parses");
    assert!(settings["settings"].is_object(), "the settings document is the section");
    assert_eq!(
        settings["settings"]["value"]["stageBehavior"]["displayFingerprint"],
        serde_json::json!("dsp-glass"),
        "the export carries which panel prompter takes open on"
    );
    assert!(
        settings.get("displayProfiles").is_none(),
        "display profiles were dropped (#232); an export no longer writes them"
    );

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
    // The pinned prompter display (#272): restoring onto a reinstalled Mac with
    // the same prompter must bring back which panel takes open on.
    let current = candidcue_lib::settings::get_settings(&h.pool).await.expect("settings");
    candidcue_lib::settings::update_settings(
        &h.pool,
        current.revision,
        serde_json::json!({
            "stageBehavior": { "displayFingerprint": "dsp-glass", "displayPinMigrated": true }
        }),
    )
    .await
    .expect("pin the prompter display");

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
    // Read before the pool closes: the pin is in the restored database, not in
    // anything the WebView kept.
    let restored = candidcue_lib::settings::get_settings(&pool).await.expect("settings");
    pool.close().await;
    assert_eq!(
        restored.value.stage_behavior.display_fingerprint.as_deref(),
        Some("dsp-glass"),
        "a restore brings back which panel prompter takes open on"
    );
    assert!(restored.value.stage_behavior.display_pin_migrated);

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

    let quarantine = backup::rebuild_database_index(&h.paths).await.expect("rebuild");

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
            .await
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

/// A real 1×1 PNG: assets are decoded before they are trusted, so a fixture
/// has to be an actual image.
fn tiny_png() -> Vec<u8> {
    vec![
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90,
        0x77, 0x53, 0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, 0x78, 0xDA, 0x63, 0xF8,
        0xCF, 0xC0, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00, 0xF7, 0x03, 0x41, 0x43, 0x00, 0x00, 0x00,
        0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ]
}

fn script_id(raw: &str) -> candidcue_lib::scripts::ScriptId {
    candidcue_lib::scripts::ScriptId::parse(raw).expect("summary ids are canonical UUIDs")
}

async fn trashed_at(pool: &sqlx::SqlitePool, id: &str) -> Option<String> {
    sqlx::query_scalar("SELECT trashed_at FROM scripts WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .expect("script row")
}

#[tokio::test]
async fn a_rebuild_keeps_names_trash_revisions_and_images() {
    /*
     * The evidence in #252, against the real functions: a script with an
     * imported image and a revision, and a second script in the Trash. After a
     * rebuild and a relaunch the first came back as "Recovered script
     * 8a0ece26" with no history and an image that no longer resolved, and the
     * second came back as a live draft — every file still on disk.
     */
    use candidcue_lib::assets::{self, AssetRequest};
    use candidcue_lib::scripts::{reconcile, ScriptLocks, ScriptMetadataPatch, ScriptStatus};

    let h = harness().await;
    let locks = ScriptLocks::default();

    let launch = repo::create_script(&h.pool, &h.paths, create_input("Launch video", "Draft."))
        .await
        .expect("create");
    let launch_id = script_id(&launch.id);
    let picked = tempfile::tempdir().expect("picker dir");
    let png = picked.path().join("diagram.png");
    fs::write(&png, tiny_png()).expect("png");
    let image = assets::import_image(&h.pool, &h.paths, &launch_id, png.to_str().expect("utf-8"))
        .await
        .expect("import");
    repo::save_script(
        &h.pool,
        &h.paths,
        &locks,
        &launch_id,
        launch.script_revision,
        format!("# Launch video\n\nHello.\n\n![Diagram]({})\n", image.markdown_path),
        ScriptMetadataPatch::default(),
    )
    .await
    .expect("save");
    // More than one, so the order they come back in means something.
    for take in ["Take two.", "Take three."] {
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        repo::create_revision_snapshot(&h.pool, &h.paths, &launch_id, take, "pre_session", 2)
            .await
            .expect("snapshot");
    }
    let revisions_before = repo::list_revisions(&h.pool, &launch_id).await.expect("revisions");
    assert_eq!(revisions_before.len(), 3);

    let old = repo::create_script(&h.pool, &h.paths, create_input("Old draft", "Gone soon."))
        .await
        .expect("create");
    repo::trash_script(&h.pool, &locks, &script_id(&old.id), old.script_revision)
        .await
        .expect("trash");
    // Trashed long enough ago that an ordinary launch purges it, which is
    // what makes the recovery launch's deferral observable.
    let forty_days_ago = (chrono::Utc::now() - chrono::Duration::days(40))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    sqlx::query("UPDATE scripts SET trashed_at = ? WHERE id = ?")
        .bind(&forty_days_ago)
        .bind(&old.id)
        .execute(&h.pool)
        .await
        .expect("age the trash");
    h.pool.close().await;

    backup::rebuild_database_index(&h.paths).await.expect("rebuild");
    assert!(
        h.dir.path().join("rebuild-script-index.json").exists(),
        "what the old database knew must survive to the relaunch"
    );

    let pool = candidcue_lib::database::init(h.dir.path()).await.expect("relaunch");
    let report = reconcile::run_startup_reconciliation(&pool, &h.paths, &locks)
        .await
        .expect("reconciliation");

    assert_eq!(report.orphan_files_recovered.len(), 2);
    assert_eq!(report.titles_restored, 2);
    assert_eq!(report.trash_purged, 0);

    let launch_after = repo::get_summary(&pool, &launch_id).await.expect("launch");
    assert_eq!(launch_after.title, "Launch video", "the name it had, not an invented one");
    assert_eq!(launch_after.status, ScriptStatus::Draft);

    let old_after = repo::get_summary(&pool, &script_id(&old.id)).await.expect("old");
    assert_eq!(old_after.title, "Old draft");
    assert_eq!(old_after.status, ScriptStatus::Trash, "Trash stays Trash");
    assert_eq!(
        trashed_at(&pool, &old.id).await.as_deref(),
        Some(forty_days_ago.as_str()),
        "and its 30 days run from when it was trashed, not from the rebuild"
    );

    let revisions_after = repo::list_revisions(&pool, &launch_id).await.expect("revisions");
    assert_eq!(revisions_after.len(), revisions_before.len());
    assert_eq!(report.revisions_recovered as usize, revisions_before.len());
    for (before, after) in revisions_before.iter().rev().zip(revisions_after.iter().rev()) {
        assert_eq!(after.source_hash, before.source_hash, "same snapshots, same order");
        assert_eq!(after.reason, "recovered", "why it was taken is not claimed");
        let gap = chrono::DateTime::parse_from_rfc3339(&after.created_at).expect("timestamp")
            - chrono::DateTime::parse_from_rfc3339(&before.created_at).expect("timestamp");
        assert!(gap.num_seconds().abs() < 5, "taken when its file says it was");
    }
    let restored = repo::get_revision(&pool, &h.paths, &launch_id, &revisions_after[0].id)
        .await
        .expect("a recovered revision opens");
    assert!(!restored.source.is_empty());

    let request = [AssetRequest {
        id: "img-diagram".into(),
        href: image.markdown_path.clone(),
    }];
    let resolved = assets::resolve_asset_urls(&pool, &h.paths, &launch_id, &request)
        .await
        .expect("resolve");
    assert!(resolved.contains_key("img-diagram"), "the image renders again");
    assert_eq!(report.assets_recovered, 1);

    // Indexed with a reference, so garbage collection does not take it for
    // an orphan and delete the file it just found.
    assets::collect_garbage(&pool, &h.paths).await.expect("gc");
    assert!(h.paths.assets_dir(&launch_id).join(format!("{}.png", image.sha256)).exists());
    let resolved = assets::resolve_asset_urls(&pool, &h.paths, &launch_id, &request)
        .await
        .expect("resolve");
    assert!(resolved.contains_key("img-diagram"));

    assert!(
        !h.dir.path().join("rebuild-script-index.json").exists(),
        "applied once and gone, so a later rename is never overruled by it"
    );

    // The next launch adopts nothing again, and only now purges the script
    // whose 30 days ran out — the recovery launch left it to be seen first.
    let again = reconcile::run_startup_reconciliation(&pool, &h.paths, &locks)
        .await
        .expect("reconciliation");
    assert!(again.orphan_files_recovered.is_empty());
    assert_eq!(again.trash_purged, 1);
    assert_eq!(
        repo::list_revisions(&pool, &launch_id).await.expect("revisions").len(),
        revisions_before.len()
    );
}

#[tokio::test]
async fn a_rebuild_interrupted_before_reading_names_reads_them_on_the_next_launch() {
    /*
     * The window between moving the database aside and reading its names:
     * a crash there used to leave the names unread in quarantine and every
     * script named after its first line. The record written before the move
     * points the next launch at them. Simulated by doing the rebuild's own
     * steps and stopping before the read.
     */
    use candidcue_lib::scripts::{reconcile, ScriptLocks};

    let h = harness().await;
    let created = repo::create_script(&h.pool, &h.paths, create_input("Interrupted", "Body."))
        .await
        .expect("create");
    h.pool.close().await;

    let quarantine = h.paths.quarantine_dir().join("pre-rebuild-interrupted");
    let database = quarantine.join("candidcue.sqlite3");
    backup::salvage::record_pending_salvage(h.dir.path(), &database).expect("record");
    backup::quarantine_database_files(h.dir.path(), &quarantine, &database).expect("move");

    let pool = candidcue_lib::database::init(h.dir.path()).await.expect("relaunch");
    let report = reconcile::run_startup_reconciliation(&pool, &h.paths, &ScriptLocks::default())
        .await
        .expect("reconciliation");
    assert_eq!(report.titles_restored, 1);
    let after = repo::get_summary(&pool, &script_id(&created.id)).await.expect("summary");
    assert_eq!(after.title, "Interrupted");
    assert!(!h.dir.path().join("rebuild-script-index.json").exists());
}

#[tokio::test]
async fn a_folder_that_cannot_be_adopted_yet_keeps_its_name_for_the_retry() {
    /*
     * A script whose text cannot be read this launch is not adopted. Its name
     * must survive to the launch that can read it, rather than being dropped
     * with the rest of the index once the other folders are adopted.
     */
    use candidcue_lib::scripts::{reconcile, ScriptLocks};

    let h = harness().await;
    let readable = repo::create_script(&h.pool, &h.paths, create_input("Readable", "Fine."))
        .await
        .expect("create");
    let stuck = repo::create_script(&h.pool, &h.paths, create_input("Stuck for now", "Later."))
        .await
        .expect("create");
    h.pool.close().await;
    backup::rebuild_database_index(&h.paths).await.expect("rebuild");

    let canonical = h.paths.canonical_file(&script_id(&stuck.id));
    let text = fs::read(&canonical).expect("text");
    fs::write(&canonical, [0xFF, 0xFE, 0xFD]).expect("not UTF-8");

    let pool = candidcue_lib::database::init(h.dir.path()).await.expect("relaunch");
    let locks = ScriptLocks::default();
    let report = reconcile::run_startup_reconciliation(&pool, &h.paths, &locks)
        .await
        .expect("reconciliation");
    assert_eq!(report.orphan_files_recovered, vec![readable.id.clone()]);
    assert_eq!(
        report.orphan_files_waiting,
        vec![stuck.id.clone()],
        "a script missing from the Library is reported, not just noted"
    );
    assert!(report.has_findings());
    assert!(
        h.dir.path().join("rebuild-script-index.json").exists(),
        "the stuck folder's name is still waiting"
    );

    fs::write(&canonical, text).expect("readable again");
    let report = reconcile::run_startup_reconciliation(&pool, &h.paths, &locks)
        .await
        .expect("reconciliation");
    assert_eq!(report.orphan_files_recovered, vec![stuck.id.clone()]);
    assert_eq!(report.titles_restored, 1);
    let after = repo::get_summary(&pool, &script_id(&stuck.id)).await.expect("summary");
    assert_eq!(after.title, "Stuck for now");
    assert!(!h.dir.path().join("rebuild-script-index.json").exists());
}

#[tokio::test]
async fn a_rebuild_over_an_unreadable_database_names_scripts_from_their_own_text() {
    use candidcue_lib::scripts::{reconcile, ScriptLocks, ScriptStatus};

    let h = harness().await;
    let created = repo::create_script(
        &h.pool,
        &h.paths,
        create_input("Quarterly", "# Quarterly **numbers**\n\nRevenue is up."),
    )
    .await
    .expect("create");
    h.pool.close().await;
    for suffix in ["-wal", "-shm"] {
        let _ = fs::remove_file(h.dir.path().join(format!("candidcue.sqlite3{suffix}")));
    }
    fs::write(h.dir.path().join("candidcue.sqlite3"), b"not really a database").expect("db");

    backup::rebuild_database_index(&h.paths)
        .await
        .expect("a database with nothing to salvage is still rebuilt");
    assert!(!h.dir.path().join("rebuild-script-index.json").exists());

    let pool = candidcue_lib::database::init(h.dir.path()).await.expect("relaunch");
    let locks = ScriptLocks::default();
    let report = reconcile::run_startup_reconciliation(&pool, &h.paths, &locks)
        .await
        .expect("reconciliation");
    assert_eq!(report.titles_restored, 0);

    let after = repo::get_summary(&pool, &script_id(&created.id)).await.expect("summary");
    assert_eq!(after.title, "Quarterly numbers", "named after its first line, not its UUID");
    assert_eq!(after.status, ScriptStatus::Draft);
}

#[tokio::test]
async fn a_rebuild_reads_names_committed_only_to_the_write_ahead_log() {
    /*
     * The database runs in WAL mode, and a commit that has not been
     * checkpointed lives only in `-wal`. A salvage that opened the quarantined
     * file `immutable`, or without its log beside it, would not see it.
     *
     * The state is captured by copying the files while the pool is still open,
     * which is what a crashed process leaves behind.
     */
    use candidcue_lib::scripts::{reconcile, ScriptLocks};

    let h = harness().await;
    let created = repo::create_script(&h.pool, &h.paths, create_input("Only in the log", "Body."))
        .await
        .expect("create");

    let crashed = tempfile::tempdir().expect("tempdir");
    let wal = h.dir.path().join("candidcue.sqlite3-wal");
    assert!(
        fs::metadata(&wal).map(|m| m.len() > 0).unwrap_or(false),
        "the fixture needs an uncheckpointed WAL to mean anything"
    );
    for suffix in ["", "-wal", "-shm"] {
        let from = h.dir.path().join(format!("candidcue.sqlite3{suffix}"));
        if from.exists() {
            fs::copy(&from, crashed.path().join(format!("candidcue.sqlite3{suffix}"))).expect("copy");
        }
    }
    backup::copy_tree(&h.paths.scripts_dir(), &crashed.path().join("scripts")).expect("scripts");
    let main = fs::read(crashed.path().join("candidcue.sqlite3")).expect("main file");
    assert!(
        !main.windows(15).any(|w| w == b"Only in the log"),
        "the title must not have been checkpointed into the main file yet"
    );
    let paths = DataPaths::new(crashed.path().to_path_buf());

    backup::rebuild_database_index(&paths).await.expect("rebuild");
    let pool = candidcue_lib::database::init(crashed.path()).await.expect("relaunch");
    let report = reconcile::run_startup_reconciliation(&pool, &paths, &ScriptLocks::default())
        .await
        .expect("reconciliation");

    assert_eq!(report.titles_restored, 1);
    let after = repo::get_summary(&pool, &script_id(&created.id)).await.expect("summary");
    assert_eq!(after.title, "Only in the log");
}

#[tokio::test]
async fn a_rescued_copy_says_which_folder_is_which_script() {
    /*
     * "Save my scripts somewhere else" copied a folder of UUID-named folders
     * and nothing else, so telling them apart meant opening every one (#252).
     */
    use candidcue_lib::scripts::ScriptLocks;

    let h = harness().await;
    let launch = repo::create_script(
        &h.pool,
        &h.paths,
        create_input("Launch video", "# Opening line\n\nHello."),
    )
    .await
    .expect("create");
    let old = repo::create_script(&h.pool, &h.paths, create_input("Old draft", "Gone soon."))
        .await
        .expect("create");
    repo::trash_script(&h.pool, &ScriptLocks::default(), &script_id(&old.id), old.script_revision)
        .await
        .expect("trash");
    h.pool.close().await;

    let dest = tempfile::tempdir().expect("dest");
    let rescue = |name: &str| dest.path().join(name);
    let readme_of = |target: &Path, file: &Option<String>| {
        fs::read_to_string(target.join(file.as_deref().expect("a list of names was written")))
            .expect("names file")
    };

    // From the database, when it can be read.
    let rescued = backup::rescue_scripts_to(&h.paths, &rescue("one")).await.expect("rescue");
    assert_eq!(rescued.scripts_copied, 2, "scripts, not every entry in the folder");
    assert_eq!(rescued.names_file.as_deref(), Some("README.txt"));
    assert!(rescue("one").join(&launch.id).join("script.md").exists());
    let readme = readme_of(&rescue("one"), &rescued.names_file);
    assert!(readme.contains(&format!("Launch video\n    {}/script.md", launch.id)), "{readme}");
    assert!(readme.contains(&format!("Old draft  (in the Trash)\n    {}/script.md", old.id)), "{readme}");

    // After a rebuild and before the relaunch there is no live database, but
    // the names the rebuild read are still waiting to be applied.
    backup::rebuild_database_index(&h.paths).await.expect("rebuild");
    let rescued = backup::rescue_scripts_to(&h.paths, &rescue("two")).await.expect("rescue");
    let readme = readme_of(&rescue("two"), &rescued.names_file);
    assert!(readme.contains(&format!("Launch video\n    {}/script.md", launch.id)), "{readme}");
    assert!(readme.contains(&format!("Old draft  (in the Trash)\n    {}/script.md", old.id)), "{readme}");

    // With nothing to read the names from, each script's own first line.
    backup::salvage::clear_pending_index(h.dir.path());
    fs::write(h.dir.path().join("candidcue.sqlite3"), b"not really a database").expect("db");
    let rescued = backup::rescue_scripts_to(&h.paths, &rescue("three")).await.expect("rescue");
    assert_eq!(rescued.scripts_copied, 2);
    let readme = readme_of(&rescue("three"), &rescued.names_file);
    assert!(readme.contains(&format!("Opening line\n    {}/script.md", launch.id)), "{readme}");
    assert!(readme.contains(&format!("Gone soon.\n    {}/script.md", old.id)), "{readme}");
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
     * The first legitimate post-1.0 migration is numbered 2
     * (`0002_search_full_source`, #254). Under the old heuristic every healthy
     * database in the world would then have looked pre-baseline and been
     * quarantined on upgrade — a data-loss bug shipped as a safety feature.
     * Recognition has to be of the one file that existed, and of nothing else.
     * `a_baseline_database_upgrades_to_full_source_search` is the real version
     * 2 going through; this is one from a build newer than this one.
     */
    let dir = tempfile::tempdir().expect("tempdir");
    let pool = candidcue_lib::database::init(dir.path()).await.expect("init");

    // A future migration that is NOT the legacy one.
    sqlx::query(
        "INSERT INTO _sqlx_migrations
            (version, description, installed_on, success, checksum, execution_time)
         VALUES (999, 'some future migration', datetime('now'), 1, X'0123456789ABCDEF', 0)",
    )
    .execute(&pool)
    .await
    .expect("insert a future migration row");
    pool.close().await;

    // Reopening will fail for an unrelated reason — sqlx does not know a
    // migration 999 — and that is fine. What must NOT have happened is a
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

#[tokio::test]
async fn a_baseline_database_upgrades_to_full_source_search() {
    /*
     * #254 replaced the search index, and FTS5 cannot add a column, so 0002
     * swaps the table. What a user upgrading has is a database the 1.0 baseline
     * built — so that is what this starts from: the real `0001` applied by
     * sqlx, with its own checksum and bookkeeping, then the production `init`.
     *
     * Across the upgrade nothing is lost (the spoken entry still searches and
     * still previews), and the first startup reconciliation rebuilds the entry
     * from the canonical file so the rest of the page searches too.
     */
    use candidcue_lib::scripts::{reconcile, ScriptFilter, ScriptId, ScriptLocks};

    let dir = tempfile::tempdir().expect("tempdir");
    let baseline = dir.path().join("baseline-migrations");
    fs::create_dir_all(&baseline).expect("baseline dir");
    fs::write(
        baseline.join("0001_initial.sql"),
        include_str!("../migrations/0001_initial.sql"),
    )
    .expect("baseline migration");

    let id = "0f6c6a52-7a51-4f43-9b4a-2b8cbb4b2c1e";
    let source = "# Quarterly results\n\n:::stage\nPoint at the revenue chart.\n:::\n\n\
                  Hello everyone, thanks for coming.\n";
    let rel_path = format!("scripts/{id}/script.md");
    fs::create_dir_all(dir.path().join(format!("scripts/{id}"))).expect("script dir");
    fs::write(dir.path().join(&rel_path), source).expect("canonical file");
    {
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(dir.path().join("candidcue.sqlite3"))
            .create_if_missing(true);
        let pool = sqlx::SqlitePool::connect_with(options).await.expect("open");
        sqlx::migrate::Migrator::new(baseline.as_path())
            .await
            .expect("baseline migrator")
            .run(&pool)
            .await
            .expect("apply the 1.0 baseline");
        // What a 1.0 build stored for this script: spoken text only.
        sqlx::query(
            "INSERT INTO scripts
                (id, title, canonical_rel_path, source_hash, spoken_word_count,
                 estimated_duration_seconds, last_compile_version, created_at, updated_at)
             VALUES (?, 'Draft 3', ?, ?, 5, 2, 'spoken-stats-3', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
        )
        .bind(id)
        .bind(&rel_path)
        .bind(candidcue_lib::util::sha256_hex(source.as_bytes()))
        .execute(&pool)
        .await
        .expect("seed script");
        sqlx::query("INSERT INTO script_search (script_id, title, plain_text) VALUES (?, 'Draft 3', ?)")
            .bind(id)
            .bind("Hello everyone, thanks for coming.")
            .execute(&pool)
            .await
            .expect("seed index");
        pool.close().await;
    }

    let pool = candidcue_lib::database::init(dir.path()).await.expect("upgrade");
    let paths = DataPaths::new(dir.path().to_path_buf());
    let script_id = ScriptId::parse(id).expect("id");
    let search = |query: &'static str| {
        let pool = pool.clone();
        async move {
            repo::list_scripts(
                &pool,
                ScriptFilter {
                    query: Some(query.into()),
                    ..Default::default()
                },
                None,
                Default::default(),
            )
            .await
            .expect("search")
            .total
        }
    };

    let applied: Vec<i64> = sqlx::query_scalar("SELECT version FROM _sqlx_migrations ORDER BY version")
        .fetch_all(&pool)
        .await
        .expect("migrations");
    assert_eq!(applied, vec![1, 2, 3, 4]);
    // The snapshot taken first is of the database as the baseline left it.
    let snapshot = fs::read_dir(dir.path().join("backups"))
        .expect("a pending migration takes a backup first")
        .flatten()
        .map(|entry| entry.path())
        .find(|path| {
            let name = path.file_name().unwrap().to_string_lossy();
            name.starts_with("pre-migration-") && name.ends_with(".sqlite3")
        })
        .expect("a pre-migration snapshot");
    let snapshot_pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&snapshot)
            .read_only(true),
    )
    .await
    .expect("open snapshot");
    let snapshot_applied: Vec<i64> =
        sqlx::query_scalar("SELECT version FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&snapshot_pool)
            .await
            .expect("snapshot migrations");
    snapshot_pool.close().await;
    assert_eq!(snapshot_applied, vec![1], "the snapshot predates the upgrade");
    let leftovers: i64 =
        sqlx::query_scalar("SELECT count(*) FROM sqlite_master WHERE name LIKE 'script_search_v1%'")
            .fetch_one(&pool)
            .await
            .expect("schema");
    assert_eq!(leftovers, 0, "the replaced index and its shadow tables are gone");

    // Carried across: the old entry still searches and previews.
    assert_eq!(search("hello").await, 1);
    assert_eq!(search("quarterly").await, 0, "not rebuilt yet");
    let before = repo::get_summary(&pool, &script_id).await.expect("summary");
    assert_eq!(before.preview_text, "Hello everyone, thanks for coming.");
    let stamp: Option<String> =
        sqlx::query_scalar("SELECT last_compile_version FROM scripts WHERE id = ?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .expect("stamp");
    assert_eq!(stamp, None, "every row is handed to reconciliation");

    reconcile::run_startup_reconciliation(&pool, &paths, &ScriptLocks::default())
        .await
        .expect("reconciliation");

    assert_eq!(search("quarterly").await, 1);
    assert_eq!(search("revenue").await, 1);
    assert_eq!(search("hello").await, 1);
    let after = repo::get_summary(&pool, &script_id).await.expect("summary");
    assert_eq!(after.spoken_word_count, 5);
    assert_eq!(after.preview_text, "Hello everyone, thanks for coming.");
    assert_eq!(after.script_revision, before.script_revision, "a rebuild is not an edit");
    assert_eq!(after.updated_at, before.updated_at);
    assert_eq!(fs::read_to_string(dir.path().join(&rel_path)).expect("read"), source);
}

/* ------------------------------------ retired take and transcript storage */

/// Words a presenter allowed a pre-#217 build to keep. Distinctive enough that
/// finding them in the raw bytes of a file cannot be a coincidence.
const RETAINED_WORDS: &str = "retained-words-7f3a91c2 thank you all for coming";
/// Words the old retention sweep had already DELETED before the upgrade —
/// gone from every query, still sitting in a free page.
const SWEPT_WORDS: &str = "swept-words-4be06d18 we will take questions at the end";
const OLD_SESSION: &str = "5d2c1a40-8b6e-4f1d-9a37-c0ffee000217";
const OLD_SCRIPT: &str = "0f6c6a52-7a51-4f43-9b4a-2b8cbb4b2c1e";

/// A database exactly as a build before #217 left it: the real `0001` and
/// `0002` applied by sqlx with their own checksums, a presented script, a
/// session that kept its transcript, a take, and a settings document that
/// still carries `saveTranscript`.
async fn a_version_two_database_with_retained_transcripts(root: &Path) {
    let migrations = root.join("v2-migrations");
    fs::create_dir_all(&migrations).expect("migrations dir");
    fs::write(
        migrations.join("0001_initial.sql"),
        include_str!("../migrations/0001_initial.sql"),
    )
    .expect("migration 1");
    fs::write(
        migrations.join("0002_search_full_source.sql"),
        include_str!("../migrations/0002_search_full_source.sql"),
    )
    .expect("migration 2");

    let source = "# Keynote\n\nThank you all for coming.\n";
    let rel_path = format!("scripts/{OLD_SCRIPT}/script.md");
    fs::create_dir_all(root.join(format!("scripts/{OLD_SCRIPT}"))).expect("script dir");
    fs::write(root.join(&rel_path), source).expect("canonical file");

    // One connection, so the pragma below governs every write that follows.
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(root.join("candidcue.sqlite3"))
                .create_if_missing(true),
        )
        .await
        .expect("open");
    sqlx::migrate::Migrator::new(migrations.as_path())
        .await
        .expect("v2 migrator")
        .run(&pool)
        .await
        .expect("apply 0001 + 0002");
    // What every pre-#217 build ran with, stated rather than assumed: a delete
    // that leaves its bytes behind.
    sqlx::query("PRAGMA secure_delete = OFF").execute(&pool).await.expect("secure_delete");

    let statements = [
        format!(
            "INSERT INTO scripts
                (id, title, canonical_rel_path, source_hash, created_at, updated_at)
             VALUES ('{OLD_SCRIPT}', 'Keynote', '{rel_path}', '{}',
                     '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            candidcue_lib::util::sha256_hex(source.as_bytes())
        ),
        "INSERT INTO settings (key, value_json, revision, updated_at)
         VALUES ('app', '{\"schemaVersion\":1,\"general\":{\"openTo\":\"last_script\",\"wordsPerMinuteEstimate\":155,\"saveTranscript\":\"forever\"}}',
                 7, '2026-01-01T00:00:00Z')"
            .to_string(),
        "INSERT INTO display_profiles (id, name, stage_settings_json, created_at, updated_at)
         VALUES ('profile-1', 'Elgato', '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')"
            .to_string(),
        format!(
            "INSERT INTO sessions
                (id, script_id, script_source_hash, started_at, ended_at, mode,
                 end_token_index, command_count, metrics_json, transcript_retained, created_at)
             VALUES ('{OLD_SESSION}', '{OLD_SCRIPT}', 'abc', '2026-01-01T09:00:00Z',
                     '2026-01-01T09:04:00Z', 'voice', 412, 3, '{{\"sectionsReached\":4}}', 1,
                     '2026-01-01T09:00:00Z')"
        ),
        format!(
            "INSERT INTO session_takes (id, session_id, take_pass_id, pass_ordinal, started_at, created_at)
             VALUES ('take-1', '{OLD_SESSION}', '{OLD_SESSION}:1', 1, '2026-01-01T09:00:00Z',
                     '2026-01-01T09:00:00Z')"
        ),
    ];
    for statement in &statements {
        sqlx::query(statement).execute(&pool).await.expect("seed");
    }
    // Enough rows that each marker fills pages of its own.
    for (sequence, words) in (1..=40).map(|n| (n, RETAINED_WORDS)).chain((41..=80).map(|n| (n, SWEPT_WORDS))) {
        sqlx::query(
            "INSERT INTO session_transcript_items
                (id, session_id, commit_sequence, transcript, disposition, created_at)
             VALUES (?, ?, ?, ?, 'script', '2026-01-01T09:00:00Z')",
        )
        .bind(format!("item-{sequence}"))
        .bind(OLD_SESSION)
        .bind(sequence)
        .bind(words.repeat(8))
        .execute(&pool)
        .await
        .expect("seed transcript");
    }
    sqlx::query("DELETE FROM session_transcript_items WHERE commit_sequence > 40")
        .execute(&pool)
        .await
        .expect("the old retention sweep");
    pool.close().await;

    let applied = applied_migrations_at(&root.join("candidcue.sqlite3")).await;
    assert_eq!(applied, vec![1, 2], "the seed is a version-2 database");
    let on_disk = fs::read(root.join("candidcue.sqlite3")).expect("seeded file");
    assert!(contains(&on_disk, RETAINED_WORDS), "the seed must hold the retained words");
    assert!(
        contains(&on_disk, SWEPT_WORDS),
        "and the swept words, in a free page — or the scrub below proves nothing"
    );
}

async fn applied_migrations_at(path: &Path) -> Vec<i64> {
    let pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(path).read_only(true),
    )
    .await
    .expect("open read-only");
    let applied = sqlx::query_scalar("SELECT version FROM _sqlx_migrations ORDER BY version")
        .fetch_all(&pool)
        .await
        .expect("migrations");
    pool.close().await;
    applied
}

fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack.windows(needle.len()).any(|window| window == needle.as_bytes())
}

/// The live files, read while the pool is still open — after a close, SQLite's
/// own last-connection checkpoint would hide a scrub that never truncated the
/// log.
fn live_bytes(root: &Path) -> Vec<u8> {
    let mut bytes = fs::read(root.join("candidcue.sqlite3")).expect("live database");
    bytes.extend(wal_bytes(root));
    bytes
}

/// The write-ahead log, where an absent log reads as empty — and any OTHER
/// failure to read it fails the test rather than passing as "nothing found".
fn wal_bytes(root: &Path) -> Vec<u8> {
    match fs::read(root.join("candidcue.sqlite3-wal")) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(err) => panic!("could not read the write-ahead log: {err}"),
    }
}

fn pre_migration_snapshots(root: &Path) -> Vec<std::path::PathBuf> {
    match fs::read_dir(root.join("backups")) {
        Ok(entries) => entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                let name = path.file_name().unwrap().to_string_lossy();
                name.starts_with("pre-migration-") && name.ends_with(".sqlite3")
            })
            .collect(),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(err) => panic!("could not list backups: {err}"),
    }
}

/// What #217 promises about a database that went through migration 3: the
/// storage is gone from the schema AND from the file, and nothing else is.
async fn assert_retired_storage_removed(root: &Path, pool: &sqlx::SqlitePool) {
    let live = live_bytes(root);
    assert!(!contains(&live, RETAINED_WORDS), "retained words must leave the live files");
    assert!(!contains(&live, SWEPT_WORDS), "and so must words swept before the upgrade");
    assert!(
        wal_bytes(root).is_empty(),
        "the write-ahead log must be emptied, not merely ignored"
    );
    assert!(
        !root.join("retired-storage-scrub.pending").exists(),
        "a finished scrub retires its marker"
    );

    let applied: Vec<i64> = sqlx::query_scalar("SELECT version FROM _sqlx_migrations ORDER BY version")
        .fetch_all(pool)
        .await
        .expect("migrations");
    assert_eq!(applied, vec![1, 2, 3, 4]);
    let leftovers: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master
         WHERE name IN ('session_takes', 'session_transcript_items', 'idx_session_takes_session')",
    )
    .fetch_all(pool)
    .await
    .expect("schema");
    assert!(leftovers.is_empty(), "retired storage still in the schema: {leftovers:?}");
    let columns: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('sessions')")
        .fetch_all(pool)
        .await
        .expect("sessions columns");
    assert!(!columns.iter().any(|c| c == "transcript_retained"), "got {columns:?}");

    // Everything else survives.
    let sessions = candidcue_lib::sessions::list_sessions(pool, Some(OLD_SCRIPT.into()), 10)
        .await
        .expect("sessions");
    assert_eq!(sessions.len(), 1, "every session row survives");
    assert_eq!(sessions[0].id, OLD_SESSION);
    assert_eq!(sessions[0].end_token_index, Some(412));
    assert_eq!(sessions[0].command_count, 3);
    let script = repo::get_summary(
        pool,
        &candidcue_lib::scripts::ScriptId::parse(OLD_SCRIPT).expect("id"),
    )
    .await
    .expect("the script survives");
    assert_eq!(script.title, "Keynote");
    let settings = candidcue_lib::settings::get_settings(pool).await.expect("settings");
    assert_eq!(settings.revision, 7);
    assert_eq!(settings.value.general.open_to, "last_script");
}

/// The one copy that is meant to keep them: the verified pre-migration backup
/// is the rollback for this upgrade, so it is taken whole and left whole.
async fn assert_rollback_copy_kept(root: &Path) {
    let snapshots = pre_migration_snapshots(root);
    assert_eq!(snapshots.len(), 1, "a pending migration takes exactly one backup first");
    let snapshot = &snapshots[0];
    assert_eq!(applied_migrations_at(snapshot).await, vec![1, 2]);
    // Whole, not merely present: every retained row, the take and the latch.
    let pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(snapshot).read_only(true),
    )
    .await
    .expect("open the snapshot");
    let count = |sql: &'static str| {
        let pool = pool.clone();
        async move { sqlx::query_scalar::<_, i64>(sql).fetch_one(&pool).await.expect(sql) }
    };
    assert_eq!(count("SELECT count(*) FROM session_transcript_items").await, 40);
    assert_eq!(count("SELECT count(*) FROM session_takes").await, 1);
    assert_eq!(count("SELECT count(*) FROM sessions WHERE transcript_retained = 1").await, 1);
    pool.close().await;
    assert!(
        contains(&fs::read(snapshot).expect("snapshot"), RETAINED_WORDS),
        "the rollback copy must still hold what the upgrade removed"
    );
}

#[tokio::test]
async fn upgrading_removes_take_history_and_transcripts_from_the_live_files() {
    /*
     * #217. With the retention sweep gone, rows left in place would have kept a
     * "1 day" transcript forever, where nobody could see or delete it. Dropping
     * the tables is not enough on its own: SQLite frees a dropped table's pages
     * without overwriting them, and so did every delete the old sweep made.
     */
    let dir = tempfile::tempdir().expect("tempdir");
    a_version_two_database_with_retained_transcripts(dir.path()).await;

    let pool = candidcue_lib::database::init(dir.path()).await.expect("upgrade");

    assert_retired_storage_removed(dir.path(), &pool).await;
    assert_rollback_copy_kept(dir.path()).await;
    pool.close().await;
}

#[tokio::test]
async fn an_old_export_restores_and_is_scrubbed_on_the_next_launch() {
    /*
     * An export is a database snapshot validated only by its export format, so
     * one made before #217 restores — and must not bring the transcripts back
     * to stay. The restored file is applied before anything opens it, then goes
     * through the same backup, migration and scrub as a live database.
     */
    let old = tempfile::tempdir().expect("old install");
    a_version_two_database_with_retained_transcripts(old.path()).await;
    let old_pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(old.path().join("candidcue.sqlite3")),
    )
    .await
    .expect("open the old install");
    let dest = tempfile::tempdir().expect("dest");
    let export = backup::export_all_data(&old_pool, &DataPaths::new(old.path().to_path_buf()), dest.path())
        .await
        .expect("export from the old install");
    old_pool.close().await;
    assert!(export.complete);
    let exported_database = Path::new(&export.path).join("candidcue.sqlite3");
    assert_eq!(applied_migrations_at(&exported_database).await, vec![1, 2]);
    let exported_bytes = fs::read(&exported_database).expect("export");
    assert!(contains(&exported_bytes, RETAINED_WORDS));

    let h = harness().await;
    backup::restore_all_data(&h.paths, Path::new(&export.path))
        .await
        .expect("an old export still restores");
    h.pool.close().await;

    let pool = candidcue_lib::database::init(h.dir.path())
        .await
        .expect("the next launch applies the restore and upgrades it");

    assert_retired_storage_removed(h.dir.path(), &pool).await;
    assert_rollback_copy_kept(h.dir.path()).await;
    pool.close().await;
    assert!(
        fs::read(&exported_database).expect("export") == exported_bytes,
        "the export itself is the user's file, and is left exactly as it was"
    );
}

#[tokio::test]
async fn an_interrupted_scrub_is_finished_on_the_next_launch() {
    /*
     * Migration 3 commits on its own and the scrub runs after it, so a crash or
     * a failed VACUUM in between leaves a database with nothing pending. The
     * marker written before the migration is what remembers the scrub; the next
     * launch must finish it, and must not take another backup to do so.
     */
    let h = harness().await;
    assert!(
        !h.dir.path().join("retired-storage-scrub.pending").exists(),
        "a fresh database has nothing to scrub"
    );
    for statement in [
        "CREATE TABLE leftover (words TEXT)".to_string(),
        format!("INSERT INTO leftover VALUES ('{}')", RETAINED_WORDS.repeat(64)),
        "DROP TABLE leftover".to_string(),
    ] {
        sqlx::query(&statement).execute(&h.pool).await.expect("leave freed words behind");
    }
    // Into the main file now, rather than whenever the pool's closing
    // connection gets round to it: sqlx closes on a worker thread, and the read
    // below must not race it.
    let (busy, _, _): (i64, i64, i64) = sqlx::query_as("PRAGMA wal_checkpoint(TRUNCATE)")
        .fetch_one(&h.pool)
        .await
        .expect("checkpoint");
    assert_eq!(busy, 0);
    h.pool.close().await;
    assert!(
        contains(&fs::read(h.dir.path().join("candidcue.sqlite3")).expect("db"), RETAINED_WORDS),
        "the freed words must be on disk before the retry, or it proves nothing"
    );
    // As the interrupted launch left it: migration 3 applied, marker still there.
    fs::write(h.dir.path().join("retired-storage-scrub.pending"), "3\n").expect("marker");

    let pool = candidcue_lib::database::init(h.dir.path()).await.expect("relaunch");

    assert!(!contains(&live_bytes(h.dir.path()), RETAINED_WORDS));
    assert!(!h.dir.path().join("retired-storage-scrub.pending").exists());
    assert!(
        pre_migration_snapshots(h.dir.path()).is_empty(),
        "nothing was pending, so finishing the scrub takes no backup"
    );
    pool.close().await;
}

#[tokio::test]
async fn a_scrub_that_cannot_finish_is_retried_rather_than_forgotten() {
    /*
     * The marker's whole job, exercised for real: a scrub that fails AFTER
     * migration 3 has committed. A reader holding an old snapshot open is
     * enough — the TRUNCATE checkpoint cannot complete under it, and SQLite
     * says so in a result column rather than an error. Startup must go on (the
     * rows are already gone), keep the marker, and the next launch must finish
     * without taking a second backup.
     */
    let dir = tempfile::tempdir().expect("tempdir");
    a_version_two_database_with_retained_transcripts(dir.path()).await;

    let reader_options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(dir.path().join("candidcue.sqlite3"))
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);
    let mut reader = sqlx::ConnectOptions::connect(&reader_options)
        .await
        .expect("a second reader");
    sqlx::query("BEGIN").execute(&mut reader).await.expect("begin");
    let _: i64 = sqlx::query_scalar("SELECT count(*) FROM session_transcript_items")
        .fetch_one(&mut reader)
        .await
        .expect("hold a snapshot from before the upgrade");

    let pool = candidcue_lib::database::init(dir.path())
        .await
        .expect("a scrub that cannot finish must not stop the app opening");
    assert_eq!(
        applied_migrations_at(&dir.path().join("candidcue.sqlite3")).await,
        vec![1, 2, 3, 4],
        "the storage itself is gone either way"
    );
    assert!(
        dir.path().join("retired-storage-scrub.pending").exists(),
        "an unfinished scrub must leave its marker for the next launch"
    );
    assert_eq!(pre_migration_snapshots(dir.path()).len(), 1);

    sqlx::query("ROLLBACK").execute(&mut reader).await.expect("release the snapshot");
    sqlx::Connection::close(reader).await.expect("close the reader");
    pool.close().await;

    let pool = candidcue_lib::database::init(dir.path()).await.expect("next launch");
    assert_retired_storage_removed(dir.path(), &pool).await;
    assert_rollback_copy_kept(dir.path()).await;
    pool.close().await;
}

#[tokio::test]
async fn a_stale_marker_over_a_fresh_database_is_simply_retired() {
    /*
     * A rebuild or a wiped data folder can leave a marker with no database
     * beside it. That is not an upgrade: startup must succeed, take no backup,
     * and not leave the marker to run again forever.
     */
    let dir = tempfile::tempdir().expect("tempdir");
    fs::write(dir.path().join("retired-storage-scrub.pending"), "3\n").expect("marker");

    let pool = candidcue_lib::database::init(dir.path()).await.expect("fresh database");

    assert!(!dir.path().join("retired-storage-scrub.pending").exists());
    assert!(pre_migration_snapshots(dir.path()).is_empty());
    pool.close().await;
}

/* ------------------------------------------------ retired display profiles */

const PROFILED_SCRIPT: &str = "3a9e2f10-6c4d-4b8e-a1f2-232d15c0ffee";
const PROFILE_ID: &str = "8b1c4e2a-0d3f-4a6b-9c5e-7f2a1b3c4d5e";
const PROFILED_SESSION: &str = "c4f0e1d2-9a8b-4c7d-8e6f-5a4b3c2d1e0f";
const PROFILED_ASSET: &str = "e7d6c5b4-a3f2-4e1d-b0c9-8f7e6d5c4b3a";

/// A database exactly as a build before #232 left it: the real `0001`–`0003`
/// applied by sqlx with their own checksums, a display profile, a script that
/// points at it, and one of every row that hangs off a script — which are what
/// a careless rebuild of `scripts` would cascade away or be refused over.
async fn a_version_three_database_with_a_display_profile(root: &Path) {
    let migrations = root.join("v3-migrations");
    fs::create_dir_all(&migrations).expect("migrations dir");
    for (name, sql) in [
        ("0001_initial.sql", include_str!("../migrations/0001_initial.sql")),
        ("0002_search_full_source.sql", include_str!("../migrations/0002_search_full_source.sql")),
        (
            "0003_remove_take_and_transcript_storage.sql",
            include_str!("../migrations/0003_remove_take_and_transcript_storage.sql"),
        ),
    ] {
        fs::write(migrations.join(name), sql).expect("migration");
    }

    let source = "# Launch\n\nToday we are shipping.\n";
    let rel_path = format!("scripts/{PROFILED_SCRIPT}/script.md");
    fs::create_dir_all(root.join(format!("scripts/{PROFILED_SCRIPT}"))).expect("script dir");
    fs::write(root.join(&rel_path), source).expect("canonical file");

    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(root.join("candidcue.sqlite3"))
                .create_if_missing(true)
                .foreign_keys(true),
        )
        .await
        .expect("open");
    sqlx::migrate::Migrator::new(migrations.as_path())
        .await
        .expect("v3 migrator")
        .run(&pool)
        .await
        .expect("apply 0001 + 0002 + 0003");

    let statements = [
        format!(
            "INSERT INTO display_profiles
                (id, name, display_fingerprint, stage_settings_json, created_at, updated_at)
             VALUES ('{PROFILE_ID}', 'Elgato', 'dsp-elgato', '{{\"schemaVersion\":1}}',
                     '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')"
        ),
        // `status` sits before the retired column and `last_opened_at` after
        // it, so a mangled row layout cannot pass for a clean one.
        format!(
            "INSERT INTO scripts
                (id, title, canonical_rel_path, source_hash, status,
                 selected_display_profile_id, created_at, updated_at, last_opened_at)
             VALUES ('{PROFILED_SCRIPT}', 'Launch', '{rel_path}', '{}', 'ready',
                     '{PROFILE_ID}', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z',
                     '2026-01-03T00:00:00Z')",
            candidcue_lib::util::sha256_hex(source.as_bytes())
        ),
        format!(
            "INSERT INTO script_revisions
                (id, script_id, revision_number, source_hash, rel_path, reason, created_at)
             VALUES ('revision-1', '{PROFILED_SCRIPT}', 1, 'abc',
                     'scripts/{PROFILED_SCRIPT}/revisions/1.md', 'manual', '2026-01-01T00:00:00Z')"
        ),
        format!(
            "INSERT INTO assets
                (id, sha256, mime_type, extension, size_bytes, rel_path, created_at)
             VALUES ('{PROFILED_ASSET}', 'def', 'image/png', 'png', 67,
                     'scripts/{PROFILED_SCRIPT}/assets/diagram.png', '2026-01-01T00:00:00Z')"
        ),
        format!(
            "INSERT INTO script_asset_references (script_id, asset_id, source_start, created_at)
             VALUES ('{PROFILED_SCRIPT}', '{PROFILED_ASSET}', 12, '2026-01-01T00:00:00Z')"
        ),
        format!(
            "INSERT INTO sessions
                (id, script_id, script_source_hash, started_at, mode, command_count, created_at)
             VALUES ('{PROFILED_SESSION}', '{PROFILED_SCRIPT}', 'abc', '2026-01-01T09:00:00Z',
                     'voice', 2, '2026-01-01T09:00:00Z')"
        ),
    ];
    for statement in &statements {
        sqlx::query(statement).execute(&pool).await.expect("seed");
    }
    pool.close().await;

    assert_eq!(
        applied_migrations_at(&root.join("candidcue.sqlite3")).await,
        vec![1, 2, 3],
        "the seed is a version-3 database"
    );
}

/// What #232 promises about a database that went through migration 4: the
/// table, the column and the foreign key are gone, the file is sound, and
/// nothing that hung off the script went with them.
async fn assert_display_profiles_removed(root: &Path, pool: &sqlx::SqlitePool) {
    let applied: Vec<i64> = sqlx::query_scalar("SELECT version FROM _sqlx_migrations ORDER BY version")
        .fetch_all(pool)
        .await
        .expect("migrations");
    assert_eq!(applied, vec![1, 2, 3, 4]);

    let tables: Vec<String> =
        sqlx::query_scalar("SELECT name FROM sqlite_schema WHERE name = 'display_profiles'")
            .fetch_all(pool)
            .await
            .expect("schema");
    assert!(tables.is_empty(), "display_profiles is still in the schema");
    let columns: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('scripts')")
        .fetch_all(pool)
        .await
        .expect("scripts columns");
    assert!(
        !columns.iter().any(|c| c == "selected_display_profile_id"),
        "got {columns:?}"
    );
    let foreign_keys: i64 = sqlx::query_scalar("SELECT count(*) FROM pragma_foreign_key_list('scripts')")
        .fetch_one(pool)
        .await
        .expect("scripts foreign keys");
    assert_eq!(foreign_keys, 0, "scripts references nothing now");

    let integrity: Vec<String> = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_all(pool)
        .await
        .expect("integrity_check");
    assert_eq!(integrity, vec!["ok".to_string()]);
    let violations = sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(pool)
        .await
        .expect("foreign_key_check");
    assert!(violations.is_empty(), "{} foreign key violations", violations.len());

    // Everything that hung off the script survives, still attached to it.
    let count = |sql: String| {
        let pool = pool.clone();
        async move { sqlx::query_scalar::<_, i64>(&sql).fetch_one(&pool).await.expect("count") }
    };
    for table in ["script_revisions", "script_asset_references", "sessions"] {
        assert_eq!(
            count(format!("SELECT count(*) FROM {table} WHERE script_id = '{PROFILED_SCRIPT}'")).await,
            1,
            "{table} lost its row"
        );
    }
    assert_eq!(count(format!("SELECT count(*) FROM assets WHERE id = '{PROFILED_ASSET}'")).await, 1);
    let last_opened: Option<String> =
        sqlx::query_scalar("SELECT last_opened_at FROM scripts WHERE id = ?")
            .bind(PROFILED_SCRIPT)
            .fetch_one(pool)
            .await
            .expect("the script row survives");
    assert_eq!(last_opened.as_deref(), Some("2026-01-03T00:00:00Z"));

    // And the repository reads and copies it through the narrower row.
    use candidcue_lib::scripts::{ScriptId, ScriptLocks, ScriptStatus};
    let paths = DataPaths::new(root.to_path_buf());
    let locks = ScriptLocks::default();
    let id = ScriptId::parse(PROFILED_SCRIPT).expect("id");
    let document = repo::get_script(pool, &paths, &locks, &id).await.expect("get_script");
    assert_eq!(document.summary.title, "Launch");
    assert_eq!(document.summary.status, ScriptStatus::Ready);
    let copy = repo::duplicate_script(pool, &paths, &locks, &id).await.expect("duplicate_script");
    assert_eq!(copy.title, "Launch copy");

    // The failure a dangling foreign key causes: inserts into and deletes
    // from `scripts` itself.
    // A delete still cascades to the children that reference it.
    sqlx::query(
        "INSERT INTO scripts (id, title, canonical_rel_path, source_hash, created_at, updated_at)
         VALUES ('scratch', 'Scratch', 'scripts/scratch/script.md', 'abc',
                 '2026-01-04T00:00:00Z', '2026-01-04T00:00:00Z')",
    )
    .execute(pool)
    .await
    .expect("a script can still be inserted");
    sqlx::query(
        "INSERT INTO script_revisions
            (id, script_id, revision_number, source_hash, rel_path, reason, created_at)
         VALUES ('scratch-revision', 'scratch', 1, 'abc', 'r.md', 'manual', '2026-01-04T00:00:00Z')",
    )
    .execute(pool)
    .await
    .expect("revision");
    sqlx::query("DELETE FROM scripts WHERE id = 'scratch'")
        .execute(pool)
        .await
        .expect("a script can still be deleted");
    assert_eq!(
        count("SELECT count(*) FROM script_revisions WHERE script_id = 'scratch'".into()).await,
        0,
        "the delete still cascades"
    );
    // And foreign keys are still enforced on the connection the app uses.
    let orphan = sqlx::query(
        "INSERT INTO sessions (id, script_id, script_source_hash, started_at, mode, created_at)
         VALUES ('orphan', 'no-such-script', 'abc', '2026-01-04T00:00:00Z', 'voice',
                 '2026-01-04T00:00:00Z')",
    )
    .execute(pool)
    .await;
    assert!(orphan.is_err(), "a session for a missing script must still be refused");
}

/// The rollback copy is the database as it was: profile, column and all.
async fn assert_profile_rollback_copy_kept(root: &Path) {
    let snapshots = pre_migration_snapshots(root);
    assert_eq!(snapshots.len(), 1, "a pending migration takes exactly one backup first");
    assert_eq!(applied_migrations_at(&snapshots[0]).await, vec![1, 2, 3]);
    let pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(&snapshots[0]).read_only(true),
    )
    .await
    .expect("open the snapshot");
    let selected: Option<String> =
        sqlx::query_scalar("SELECT selected_display_profile_id FROM scripts WHERE id = ?")
            .bind(PROFILED_SCRIPT)
            .fetch_one(&pool)
            .await
            .expect("the snapshot keeps the column");
    assert_eq!(selected.as_deref(), Some(PROFILE_ID));
    let (name, stage): (String, String) =
        sqlx::query_as("SELECT name, stage_settings_json FROM display_profiles WHERE id = ?")
            .bind(PROFILE_ID)
            .fetch_one(&pool)
            .await
            .expect("the snapshot keeps the profile row");
    assert_eq!((name.as_str(), stage.as_str()), ("Elgato", "{\"schemaVersion\":1}"));
    pool.close().await;
}

#[tokio::test]
async fn upgrading_removes_display_profiles_and_keeps_what_hangs_off_a_script() {
    /*
     * #232. SQLite refuses to drop a column a foreign key names, dropping only
     * the table leaves every INSERT into or DELETE from `scripts` failing, and
     * rebuilding `scripts` inside sqlx's transaction would cascade away its
     * revisions and image references. So migration 4 edits the stored schema
     * instead — and this runs it through the bundled SQLite the app ships, not
     * the CLI.
     */
    let dir = tempfile::tempdir().expect("tempdir");
    a_version_three_database_with_a_display_profile(dir.path()).await;

    let pool = candidcue_lib::database::init(dir.path()).await.expect("upgrade");
    assert_display_profiles_removed(dir.path(), &pool).await;
    pool.close().await;

    // A file whose schema text was edited must open again like any other, and
    // with nothing pending it takes no second backup.
    let pool = candidcue_lib::database::init(dir.path()).await.expect("next launch");
    let integrity: Vec<String> = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_all(&pool)
        .await
        .expect("integrity_check");
    assert_eq!(integrity, vec!["ok".to_string()]);
    pool.close().await;
    assert_profile_rollback_copy_kept(dir.path()).await;
}

#[tokio::test]
async fn an_export_made_before_display_profiles_went_still_restores() {
    /*
     * A pre-#232 export carries the table in its database snapshot and the
     * rows again as `displayProfiles` in `settings.json`. Nothing reads that
     * file back, so the key is inert — but the export is checksummed, so this
     * forges the exact old shape (with a matching manifest) rather than
     * assuming it.
     */
    let old = tempfile::tempdir().expect("old install");
    a_version_three_database_with_a_display_profile(old.path()).await;
    let old_pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(old.path().join("candidcue.sqlite3")),
    )
    .await
    .expect("open the old install");
    let dest = tempfile::tempdir().expect("dest");
    let export = backup::export_all_data(&old_pool, &DataPaths::new(old.path().to_path_buf()), dest.path())
        .await
        .expect("export from the old install");
    old_pool.close().await;
    assert!(export.complete);
    let export_root = Path::new(&export.path);
    assert_eq!(
        applied_migrations_at(&export_root.join("candidcue.sqlite3")).await,
        vec![1, 2, 3]
    );

    let mut settings: serde_json::Value =
        serde_json::from_slice(&fs::read(export_root.join("settings.json")).expect("settings.json"))
            .expect("settings.json parses");
    settings["displayProfiles"] = serde_json::json!([{
        "id": PROFILE_ID,
        "name": "Elgato",
        "displayFingerprint": "dsp-elgato",
        "stage": { "schemaVersion": 1 },
        "updatedAt": "2026-01-01T00:00:00Z",
    }]);
    forge_settings_json(export_root, &settings);

    let h = harness().await;
    backup::restore_all_data(&h.paths, export_root)
        .await
        .expect("a pre-#232 export still restores");
    h.pool.close().await;

    let pool = candidcue_lib::database::init(h.dir.path())
        .await
        .expect("the next launch applies the restore and upgrades it");
    assert_display_profiles_removed(h.dir.path(), &pool).await;
    pool.close().await;
    assert_profile_rollback_copy_kept(h.dir.path()).await;
}

/// Write an older build's `settings.json` into an export, with the manifest
/// that build would have written for it. The export is checksummed, so an old
/// shape has to be forged whole rather than assumed.
fn forge_settings_json(export_root: &Path, settings: &serde_json::Value) {
    let bytes = serde_json::to_vec_pretty(settings).expect("serialize");
    fs::write(export_root.join("settings.json"), &bytes).expect("write the old shape");
    let mut manifest = manifest_of(export_root);
    for file in manifest["files"].as_array_mut().expect("files") {
        if file["path"] == "settings.json" {
            file["bytes"] = serde_json::json!(bytes.len());
            file["sha256"] = serde_json::json!(candidcue_lib::util::sha256_hex(&bytes));
        }
    }
    for section in manifest["sections"].as_array_mut().expect("sections") {
        if section["name"] == "settings" {
            section["bytes"] = serde_json::json!(bytes.len());
        }
    }
    fs::write(
        export_root.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).expect("manifest"),
    )
    .expect("write the manifest");
}

#[tokio::test]
async fn an_export_made_before_the_dead_settings_went_still_restores() {
    /*
     * #219. An export taken before the twenty fields nothing read were removed
     * carries them twice: in the database snapshot's settings row, and in
     * `settings.json`. Restoring one must bring back every setting that
     * survived — a document that failed to parse would come back as the
     * defaults, calibrated rigs included, and nothing would say so — and the
     * first write after it must shed the retired keys.
     *
     * The row is seeded raw, so the snapshot carries it exactly; this build's
     * exporter writes `settings.json` from the typed struct, which drops the
     * keys, so that file is forged back to the old shape.
     */
    let fixture: serde_json::Value = serde_json::from_slice(
        &fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../tests/fixtures/ipc/settings-retired-document.json"),
        )
        .expect("fixture"),
    )
    .expect("fixture parses");
    let document = fixture["document"].clone();
    let carries = |stored: &serde_json::Value, path: &str| match path.split_once('.') {
        Some((section, field)) => stored[section].get(field).is_some(),
        None => stored.get(path).is_some(),
    };
    let retired: Vec<String> = fixture["retired"]
        .as_array()
        .expect("retired")
        .iter()
        .map(|p| p.as_str().expect("a path").to_string())
        .collect();

    let old = harness().await;
    candidcue_lib::settings::get_settings(&old.pool).await.expect("settings row");
    sqlx::query("UPDATE settings SET value_json = ?, revision = 9 WHERE key = 'app'")
        .bind(document.to_string())
        .execute(&old.pool)
        .await
        .expect("store what a pre-#219 build wrote");
    let dest = tempfile::tempdir().expect("dest");
    let export = backup::export_all_data(&old.pool, &old.paths, dest.path())
        .await
        .expect("export");
    old.pool.close().await;
    assert!(export.complete);
    let export_root = Path::new(&export.path);

    let snapshot = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new()
            .filename(export_root.join("candidcue.sqlite3"))
            .read_only(true),
    )
    .await
    .expect("open the snapshot");
    let snapshot_row: String = sqlx::query_scalar("SELECT value_json FROM settings WHERE key = 'app'")
        .fetch_one(&snapshot)
        .await
        .expect("the snapshot's settings row");
    snapshot.close().await;
    let snapshot_row: serde_json::Value = serde_json::from_str(&snapshot_row).expect("json");
    for path in &retired {
        assert!(carries(&snapshot_row, path), "the snapshot must carry {path} as the old build did");
    }

    let mut settings: serde_json::Value =
        serde_json::from_slice(&fs::read(export_root.join("settings.json")).expect("settings.json"))
            .expect("settings.json parses");
    settings["settings"]["value"] = document.clone();
    forge_settings_json(export_root, &settings);

    // Into an install whose own settings differ, so a restore that kept them
    // could not pass for one that brought the export's back.
    let h = harness().await;
    let current = candidcue_lib::settings::get_settings(&h.pool).await.expect("settings");
    candidcue_lib::settings::update_settings(
        &h.pool,
        current.revision,
        serde_json::json!({ "stageBehavior": { "fixedSpeedWpm": 99 } }),
    )
    .await
    .expect("this install's own settings");
    backup::restore_all_data(&h.paths, export_root)
        .await
        .expect("a pre-#219 export still restores");
    h.pool.close().await;

    let pool = candidcue_lib::database::init(h.dir.path())
        .await
        .expect("the next launch applies the restore");
    let restored = candidcue_lib::settings::get_settings(&pool).await.expect("settings");
    assert_eq!(restored.revision, 9);
    assert_eq!(
        restored.value,
        serde_json::from_value::<candidcue_lib::settings::AppSettings>(document).expect("loads"),
        "every surviving setting comes back, not the defaults"
    );
    assert_eq!(restored.value.stage_behavior.fixed_speed_wpm, 172);
    assert_eq!(restored.value.optical.profiles.len(), 1, "the calibrated rig comes back");

    candidcue_lib::settings::update_settings(
        &pool,
        restored.revision,
        serde_json::json!({ "stageBehavior": { "fixedSpeedWpm": 150 } }),
    )
    .await
    .expect("the first write after a restore succeeds");
    let stored: String = sqlx::query_scalar("SELECT value_json FROM settings WHERE key = 'app'")
        .fetch_one(&pool)
        .await
        .expect("stored settings");
    pool.close().await;
    let stored: serde_json::Value = serde_json::from_str(&stored).expect("json");
    for path in &retired {
        assert!(!carries(&stored, path), "the write must take {path} off disk");
    }
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
            "reveal_support_bundle",
            "shows a folder this process already wrote; touches no database and takes no path",
        ),
        (
            "open_web_destination",
            "hands a compile-time url to the browser; a boot failure is exactly when \
             somebody needs Help › Report a Problem",
        ),
        (
            "open_third_party_notices",
            "opens a file from this build's own resources; reads nothing of the user's",
        ),
        (
            "get_microphone_permission",
            "a passive OS read that never prompts; touches no app data",
        ),
        (
            "open_microphone_settings",
            "opens a fixed OS privacy pane; takes no argument and touches no app data",
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
        ("list_displays", "read-only"),
        ("current_window_display", "read-only; asks the window manager, not the database"),
        ("identify_displays", "shows overlays; no persistence"),
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
        /*
         * It requests the same native close the red button does. The recovery
         * screen is still the control window, and closing it is still how the
         * app quits.
         */
        ("close_control_window", "window management; reads no database"),
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
        include_str!("../src/commands/microphone_cmds.rs"),
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
     * from it. For settings and session history there is no such copy:
     * "saved" has to mean saved.
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
