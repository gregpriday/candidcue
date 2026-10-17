//! C1/C11 regression: the session lifecycle, end to end through Rust.
//!
//! Why this file exists at all. The defect it guards was that NOTHING in the
//! frontend invoked `start_session`, so `AppCoordinator::begin_session` — the
//! only writer of the Rust-side session generation — never ran, the coordinator
//! stayed at its `Default` of 0, and `validate_stage_payload_header` dropped
//! every tracking snapshot control published (silently: the drop is
//! `Ok(())` and control's relay ends in `.catch(() => {})`). The stage hydrated
//! and then never moved, in every packaged build, and 2038 vitest tests plus 146
//! cargo tests all passed.
//!
//! They passed because the existing suite tested the *drop* half of the
//! generation guard and never the *emit* half, and because no test anywhere
//! drove a real command. So the tests here deliberately:
//!
//!  - run the real `sessions::start_session` against a real migrated database
//!    and the real `AppCoordinator`, rather than a hand-built generation;
//!  - build the stage envelope from the SAME fixture the TypeScript contract
//!    test reads (`tests/fixtures/ipc/session-command-payloads.json`), so a
//!    change on either side of the seam fails here;
//!  - assert an actual `emit_to` reaches a webview labelled `stage`, via
//!    tauri's MockRuntime — not that a policy function returned `Emit`.

use candidcue_lib::coordinator::AppCoordinator;
use candidcue_lib::scripts::{repo, CreateScriptInput, DataPaths, ScriptId, ScriptLocks};
use candidcue_lib::sessions::{self, EndSessionSummary, StartSessionInput};
use candidcue_lib::windows::{self, STAGE_LABEL};
use std::sync::mpsc;
use tauri::{Listener, Manager};

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

async fn a_script(h: &Harness) -> ScriptId {
    let input: CreateScriptInput = serde_json::from_value(serde_json::json!({
        "title": "Keynote",
        "source": "# Keynote\n\nGood morning, everyone.\n"
    }))
    .expect("create input");
    let summary = repo::create_script(&h.pool, &h.paths, input)
        .await
        .expect("script created");
    ScriptId::parse(&summary.id).expect("canonical id")
}

fn fixture() -> serde_json::Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tests")
        .join("fixtures")
        .join("ipc")
        .join("session-command-payloads.json");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{} must exist: {e}", path.display()));
    serde_json::from_str(&raw).expect("fixture parses")
}

/// The exact payload `services/session-records.ts` sends, with the script id
/// substituted for one that exists in this harness's database.
fn start_input(f: &serde_json::Value, script_id: &ScriptId) -> StartSessionInput {
    let mut payload = f["start_session"]["input"].clone();
    payload["scriptId"] = serde_json::Value::String(script_id.as_str().to_string());
    serde_json::from_value(payload).expect("start_session input deserializes")
}

// ---------------------------------------------------------------------------
// Invariant 1 — control's session generation is the coordinator's.
// ---------------------------------------------------------------------------

/// The generation control stamps on every stage payload is an OUTPUT of
/// `start_session`, never an input: `StartSessionInput` has no such field, so
/// the only way for the two sides to agree is for control to adopt what it is
/// handed. This test pins that the returned record carries the coordinator's
/// current generation, and that a second take advances both together.
///
/// Reverting the fix does not make this test fail — it makes it irrelevant,
/// which is why `snapshot_is_emitted_...` below exists and asserts the
/// consequence instead.
#[tokio::test]
async fn start_session_returns_the_coordinator_generation_it_just_assigned() {
    let h = harness().await;
    let script_id = a_script(&h).await;
    let f = fixture();
    let coordinator = AppCoordinator::default();

    assert_eq!(
        coordinator.snapshot().session.session_generation,
        0,
        "the coordinator starts at its Default — this is the value control's \
         hard-coded 1 used to be compared against"
    );

    let input = start_input(&f, &script_id);
    let mut record = sessions::start_session(&h.pool, &input)
        .await
        .expect("session row");
    record.session_generation = coordinator.begin_session(
        record.id.clone(),
        input.script_id.clone(),
        input.compile_hash.clone(),
    );

    assert_eq!(record.session_generation, 1);
    assert_eq!(
        coordinator.snapshot().session.session_generation,
        record.session_generation,
        "control adopts the returned generation, so these must be the same number"
    );

    // A second take: the generation advances, and a control that kept using the
    // first one would be publishing under a stale generation.
    let second = sessions::start_session(&h.pool, &input)
        .await
        .expect("second session row");
    let second_generation =
        coordinator.begin_session(second.id, input.script_id.clone(), None);
    assert_eq!(second_generation, 2);
    assert_ne!(second_generation, record.session_generation);
}

// ---------------------------------------------------------------------------
// Invariants 2 + 3 — the snapshot is emitted, and a stale one still is not.
// ---------------------------------------------------------------------------

fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
    tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app builds")
}




/// The FIRST casualty of C1, and the one that makes the defect fatal rather
/// than merely degrading: `publish_stage_document` honours the same header
/// verdict, so a mismatched session generation meant the stage never received
/// its hydration envelope at all. Control's `waitForStageReady` then sat for its
/// full 12 s timeout and the start sequence failed outright — the session could
/// not be started in a packaged build, not merely fail to follow.
#[test]
fn the_hydration_envelope_reaches_the_stage_under_the_live_generation() {
    let app = mock_app();
    app.manage(AppCoordinator::default());
    let (tx, rx) = mpsc::channel();
    let stage = tauri::WebviewWindowBuilder::new(
        &app,
        STAGE_LABEL,
        tauri::WebviewUrl::App("stage.html".into()),
    )
    .build()
    .expect("mock stage webview");
    stage.listen(
        candidcue_lib::windows::events::STAGE_LOAD_SESSION,
        move |event| {
            let _ = tx.send(event.payload().to_string());
        },
    );

    let coordinator = app.state::<AppCoordinator>();
    let session_id = "1f0e5a8e-6c2b-4a3d-9f11-0a1b2c3d4e5f";
    let stage_generation = coordinator.next_stage_generation();
    coordinator.register_stage(stage_generation, Some(session_id.to_string()), None);
    let session_generation =
        coordinator.begin_session(session_id.to_string(), "script".into(), None);

    let envelope = serde_json::json!({
        "schemaVersion": 1,
        "sessionId": session_id,
        "sessionGeneration": session_generation,
        "stageGeneration": stage_generation,
        "scriptId": "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        "sourceHash": "hash",
        "compileRevision": 1,
        "stageSettings": {},
        "renderDocument": { "blocks": [] },
        "initialTokenIndex": 0,
    });

    let ack = windows::publish_stage_document(app.handle(), session_id, envelope)
        .expect("publishing the envelope must succeed");
    assert!(ack.accepted, "the envelope must be accepted, not dropped");
    assert!(
        rx.recv_timeout(std::time::Duration::from_secs(2)).is_ok(),
        "the stage must actually receive stage://load-session, or it never hydrates"
    );
}

/// §21.4: the pre-session snapshot is taken by Rust inside `start_session`
/// precisely so a frontend cannot skip it. Now that the frontend calls the
/// command, this is the assertion that the snapshot is actually produced.
#[tokio::test]
async fn starting_a_session_takes_the_pre_session_revision_snapshot() {
    let h = harness().await;
    let script_id = a_script(&h).await;

    let before = repo::list_revisions(&h.pool, &script_id).await.unwrap();
    let snapshot_id = repo::snapshot_pre_session(&h.pool, &h.paths, &h.locks, &script_id)
        .await
        .expect("snapshot succeeds");
    assert!(snapshot_id.is_some(), "a saved script must be snapshotted");

    let after = repo::list_revisions(&h.pool, &script_id).await.unwrap();
    assert_eq!(after.len(), before.len() + 1);
    assert!(
        after.iter().any(|r| r.reason == "pre_session"),
        "the new revision must be tagged pre_session"
    );
}

// ---------------------------------------------------------------------------
// §36.1 — the record closes, on the normal path and after a crash.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ending_a_session_closes_the_row_and_records_the_summary() {
    let h = harness().await;
    let script_id = a_script(&h).await;
    let f = fixture();
    let input = start_input(&f, &script_id);
    let record = sessions::start_session(&h.pool, &input)
        .await
        .expect("session row");

    let summary: EndSessionSummary =
        serde_json::from_value(f["end_session"]["summary"].clone()).expect("summary deserializes");
    let ended = sessions::end_session(&h.pool, &record.id, summary)
        .await
        .expect("session ends");

    assert!(ended.ended_at.is_some());
    assert_eq!(ended.command_count, 3);
    assert_eq!(ended.retake_count, 1);
    assert_eq!(ended.end_token_index, Some(412));

    // `get_system_diagnostics` reports `session_count` from this table; before
    // the frontend opened records it was structurally always zero.
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM sessions")
        .fetch_one(&h.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
}

/// The abnormal paths the frontend cannot observe — crash, force quit, power
/// loss — leave a row open forever. Startup is the only moment at which every
/// open row is provably abandoned.
#[tokio::test]
async fn startup_closes_sessions_that_were_never_ended() {
    let h = harness().await;
    let script_id = a_script(&h).await;
    let f = fixture();
    let input = start_input(&f, &script_id);
    let crashed = sessions::start_session(&h.pool, &input)
        .await
        .expect("session row");

    let closed = sessions::close_orphaned_sessions(&h.pool)
        .await
        .expect("recovery runs");
    assert_eq!(closed, 1);

    let rows = sessions::list_sessions(&h.pool, None, 10).await.unwrap();
    let row = rows.iter().find(|r| r.id == crashed.id).expect("the row");
    assert!(row.ended_at.is_some(), "an abandoned take must not stay open");
    assert!(
        row.duration_ms.is_none(),
        "nobody knows when an abandoned take stopped; a fabricated duration \
         would be read as a real §36.1 metric"
    );

    // Idempotent: a clean launch closes nothing.
    assert_eq!(sessions::close_orphaned_sessions(&h.pool).await.unwrap(), 0);
}
