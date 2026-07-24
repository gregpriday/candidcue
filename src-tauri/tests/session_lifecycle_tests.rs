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
use candidcue_lib::sessions::{self, EndSessionSummary, StartSessionInput, TranscriptItemInput};
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
    let mut record = sessions::start_session(&h.pool, &input, false)
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
    let second = sessions::start_session(&h.pool, &input, false)
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

/// Register a webview labelled `stage` and a receiver for the tracking-snapshot
/// event. `app.emit_to(STAGE_LABEL, ..)` targets `AnyLabel { "stage" }`, which
/// matches a `WebviewWindow { "stage" }` listener — the same routing the real
/// stage window relies on.
fn stage_listener(
    app: &tauri::App<tauri::test::MockRuntime>,
) -> mpsc::Receiver<serde_json::Value> {
    let stage = tauri::WebviewWindowBuilder::new(
        app,
        STAGE_LABEL,
        tauri::WebviewUrl::App("stage.html".into()),
    )
    .build()
    .expect("mock stage webview");
    let (tx, rx) = mpsc::channel();
    stage.listen(
        candidcue_lib::windows::events::STAGE_TRACKING_SNAPSHOT,
        move |event| {
            let payload: serde_json::Value =
                serde_json::from_str(event.payload()).expect("snapshot payload is json");
            let _ = tx.send(payload);
        },
    );
    rx
}

fn snapshot_envelope(f: &serde_json::Value, session_id: &str, generation: u64) -> serde_json::Value {
    let mut snapshot = f["publish_stage_snapshot"]["snapshot"].clone();
    snapshot["sessionId"] = serde_json::Value::String(session_id.to_string());
    snapshot["sessionGeneration"] = serde_json::Value::from(generation);
    snapshot
}

/// INVARIANT 2 — the one nothing asserted. Given live coordinator state
/// established by `begin_session`, a snapshot carrying that generation must
/// reach the stage.
///
/// Revert check: change the `sessionGeneration` below to the hard-coded `1`
/// that `Preflight.svelte` used to send while `begin_session` is never called
/// (i.e. drop the `begin_session` line and keep generation 1) and this test
/// fails on `recv_timeout` — which is exactly the shipped bug, reproduced.
#[test]
fn a_snapshot_published_under_the_live_generation_actually_reaches_the_stage() {
    let f = fixture();
    let app = mock_app();
    app.manage(AppCoordinator::default());
    let rx = stage_listener(&app);

    let coordinator = app.state::<AppCoordinator>();
    let session_id = "1f0e5a8e-6c2b-4a3d-9f11-0a1b2c3d4e5f";
    let stage_generation = coordinator.next_stage_generation();
    coordinator.register_stage(stage_generation, Some(session_id.to_string()), None);
    let session_generation =
        coordinator.begin_session(session_id.to_string(), "script".into(), None);

    let mut snapshot = snapshot_envelope(&f, session_id, session_generation);
    snapshot["stageGeneration"] = serde_json::Value::from(stage_generation);

    windows::publish_stage_snapshot(app.handle(), session_id, snapshot.clone())
        .expect("publishing a current snapshot must succeed");

    let received = rx
        .recv_timeout(std::time::Duration::from_secs(2))
        .expect("the stage must actually receive the snapshot");
    assert_eq!(received["sessionId"], serde_json::json!(session_id));
    assert_eq!(
        received["sessionGeneration"],
        serde_json::json!(session_generation)
    );
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

/// INVARIANT 3 — C1 must not be "fixed" by deleting the guard. A snapshot from
/// a session generation that is no longer current is still dropped, silently
/// (`Ok(())`, per §43.5), and must NOT reach the stage.
#[test]
fn a_snapshot_from_a_stale_session_generation_is_still_dropped() {
    let f = fixture();
    let app = mock_app();
    app.manage(AppCoordinator::default());
    let rx = stage_listener(&app);

    let coordinator = app.state::<AppCoordinator>();
    let session_id = "1f0e5a8e-6c2b-4a3d-9f11-0a1b2c3d4e5f";
    let stage_generation = coordinator.next_stage_generation();
    coordinator.register_stage(stage_generation, Some(session_id.to_string()), None);
    let first = coordinator.begin_session(session_id.to_string(), "script".into(), None);
    // A restart: same session id on the stage, new generation.
    let second = coordinator.begin_session(session_id.to_string(), "script".into(), None);
    assert!(second > first);

    let mut stale = snapshot_envelope(&f, session_id, first);
    stale["stageGeneration"] = serde_json::Value::from(stage_generation);
    windows::publish_stage_snapshot(app.handle(), session_id, stale)
        .expect("a stale snapshot is dropped, not an error (§43.5)");

    assert!(
        rx.recv_timeout(std::time::Duration::from_millis(400)).is_err(),
        "a stale-generation snapshot must never reach the stage"
    );

    // …and the current one still gets through, so the guard is a filter rather
    // than a wall.
    let mut current = snapshot_envelope(&f, session_id, second);
    current["stageGeneration"] = serde_json::Value::from(stage_generation);
    windows::publish_stage_snapshot(app.handle(), session_id, current).expect("current publishes");
    assert!(rx.recv_timeout(std::time::Duration::from_secs(2)).is_ok());
}

// ---------------------------------------------------------------------------
// Invariant 5 — transcript retention follows the setting, both ways.
// ---------------------------------------------------------------------------

/// §36.2: retention is decided ONCE, at session start, from
/// `general.saveTranscript`, and stamped on the row. A session started with it
/// off must refuse transcript text afterwards — the guarantee is not "the
/// frontend will not ask", it is "asking does not work".
#[tokio::test]
async fn transcripts_are_persisted_only_when_retention_was_enabled_at_start() {
    let h = harness().await;
    let script_id = a_script(&h).await;
    let f = fixture();
    let input = start_input(&f, &script_id);
    let items: Vec<TranscriptItemInput> =
        serde_json::from_value(f["append_session_transcript"]["items"].clone())
            .expect("transcript items deserialize");

    // Retention ON.
    let kept = sessions::start_session(&h.pool, &input, true)
        .await
        .expect("session with retention");
    assert!(kept.transcript_retained);
    let written = sessions::append_transcript_items(&h.pool, &kept.id, items.clone())
        .await
        .expect("items accepted");
    assert_eq!(written as usize, items.len());
    let stored: i64 =
        sqlx::query_scalar("SELECT count(*) FROM session_transcript_items WHERE session_id = ?")
            .bind(&kept.id)
            .fetch_one(&h.pool)
            .await
            .unwrap();
    assert_eq!(stored, items.len() as i64);

    // Retention OFF.
    let quiet = sessions::start_session(&h.pool, &input, false)
        .await
        .expect("session without retention");
    assert!(!quiet.transcript_retained);
    let refused = sessions::append_transcript_items(&h.pool, &quiet.id, items.clone()).await;
    assert!(
        refused.is_err(),
        "a session started with retention off must refuse transcript text"
    );
    let stored_off: i64 =
        sqlx::query_scalar("SELECT count(*) FROM session_transcript_items WHERE session_id = ?")
            .bind(&quiet.id)
            .fetch_one(&h.pool)
            .await
            .unwrap();
    assert_eq!(stored_off, 0, "not one word may reach disk");
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
    let record = sessions::start_session(&h.pool, &input, false)
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
    let crashed = sessions::start_session(&h.pool, &input, false)
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

// ---------------------------------------------------------------------------
// §36.3 take history
//
// `sessions` is one row per SESSION with scalar counters. `retake_count` could
// say four takes happened and nothing about any of them — not when they ran,
// not where they started or stopped, not which sections they covered, not where
// the presenter marked a checkpoint. `session_takes` is that detail, and the
// thing worth pinning is that it is a HISTORY: a second take must never
// overwrite the first.
// ---------------------------------------------------------------------------

fn take_input(ordinal: i64, take_pass_id: &str) -> sessions::SessionTakeInput {
    serde_json::from_value(serde_json::json!({
        "takePassId": take_pass_id,
        "passOrdinal": ordinal,
        "startedAt": "2026-07-25T09:00:00.000Z",
        "endedAt": "2026-07-25T09:04:00.000Z",
        "durationMs": 240_000,
        "startTokenIndex": 0,
        "endTokenIndex": 412,
        "sections": ["block-1", "block-2"],
        "checkpoints": [
            { "atMs": 12_000, "tokenIndex": 40, "blockId": "block-1", "sentenceId": "s-3", "kind": "take" },
            { "atMs": 96_000, "tokenIndex": 300, "blockId": "block-2", "sentenceId": "s-19", "kind": "manual" }
        ]
    }))
    .expect("take input deserializes")
}

#[tokio::test]
async fn a_take_round_trips_with_its_times_sections_and_checkpoints() {
    let h = harness().await;
    let script_id = a_script(&h).await;
    let f = fixture();
    let session = sessions::start_session(&h.pool, &start_input(&f, &script_id), false)
        .await
        .expect("session started");

    let written = sessions::record_take(&h.pool, &session.id, take_input(1, "pass-1"))
        .await
        .expect("take recorded");
    assert_eq!(written.pass_ordinal, 1);
    assert_eq!(written.take_pass_id, "pass-1");

    let takes = sessions::list_takes(&h.pool, &session.id)
        .await
        .expect("takes listed");
    assert_eq!(takes.len(), 1);
    let take = &takes[0];
    assert_eq!(take.duration_ms, Some(240_000));
    assert_eq!(take.start_token_index, 0);
    assert_eq!(take.end_token_index, Some(412));
    assert_eq!(take.sections, vec!["block-1".to_string(), "block-2".to_string()]);
    assert_eq!(take.checkpoints.len(), 2);
    assert_eq!(take.checkpoints[0].kind, "take");
    assert_eq!(take.checkpoints[0].at_ms, 12_000);
    assert_eq!(take.checkpoints[0].token_index, 40);
    assert_eq!(take.checkpoints[1].kind, "manual");
    assert_eq!(take.checkpoints[1].sentence_id.as_deref(), Some("s-19"));
}

/// The assertion the whole table exists for.
#[tokio::test]
async fn a_second_take_does_not_overwrite_the_first() {
    let h = harness().await;
    let script_id = a_script(&h).await;
    let f = fixture();
    let session = sessions::start_session(&h.pool, &start_input(&f, &script_id), false)
        .await
        .expect("session started");

    sessions::record_take(&h.pool, &session.id, take_input(1, "pass-1"))
        .await
        .expect("first take");

    let mut second = take_input(2, "pass-2");
    second.duration_ms = Some(61_000);
    second.end_token_index = Some(90);
    second.sections = vec!["block-1".into()];
    second.checkpoints.clear();
    sessions::record_take(&h.pool, &session.id, second)
        .await
        .expect("second take");

    let takes = sessions::list_takes(&h.pool, &session.id)
        .await
        .expect("takes listed");
    assert_eq!(takes.len(), 2, "both passes survive");
    // Ascending by ordinal, and the first take is untouched.
    assert_eq!(takes[0].pass_ordinal, 1);
    assert_eq!(takes[0].take_pass_id, "pass-1");
    assert_eq!(takes[0].duration_ms, Some(240_000));
    assert_eq!(takes[0].checkpoints.len(), 2);
    assert_eq!(takes[1].pass_ordinal, 2);
    assert_eq!(takes[1].duration_ms, Some(61_000));
    assert!(takes[1].checkpoints.is_empty());
}

/// A take may be written while it is still open and completed later, so a crash
/// mid-session costs the tail of the current take rather than the whole history.
#[tokio::test]
async fn re_recording_the_same_ordinal_completes_it_rather_than_duplicating() {
    let h = harness().await;
    let script_id = a_script(&h).await;
    let f = fixture();
    let session = sessions::start_session(&h.pool, &start_input(&f, &script_id), false)
        .await
        .expect("session started");

    let mut open = take_input(1, "pass-1");
    open.ended_at = None;
    open.duration_ms = None;
    open.end_token_index = None;
    sessions::record_take(&h.pool, &session.id, open)
        .await
        .expect("open take");

    sessions::record_take(&h.pool, &session.id, take_input(1, "pass-1"))
        .await
        .expect("completed take");

    let takes = sessions::list_takes(&h.pool, &session.id)
        .await
        .expect("takes listed");
    assert_eq!(takes.len(), 1, "one row, not two");
    assert_eq!(takes[0].ended_at.as_deref(), Some("2026-07-25T09:04:00.000Z"));
    assert_eq!(takes[0].end_token_index, Some(412));
}

#[tokio::test]
async fn take_history_is_refused_for_a_session_that_does_not_exist() {
    let h = harness().await;
    let err = sessions::record_take(&h.pool, "11111111-1111-4111-8111-111111111111", take_input(1, "p"))
        .await
        .expect_err("no such session");
    assert!(format!("{err:?}").to_lowercase().contains("session"));
}

#[tokio::test]
async fn take_history_rejects_a_checkpoint_kind_it_does_not_know() {
    let h = harness().await;
    let script_id = a_script(&h).await;
    let f = fixture();
    let session = sessions::start_session(&h.pool, &start_input(&f, &script_id), false)
        .await
        .expect("session started");
    let mut bad = take_input(1, "pass-1");
    bad.checkpoints[0].kind = "whatever".into();
    assert!(sessions::record_take(&h.pool, &session.id, bad).await.is_err());
}

/// Deleting a session takes its takes with it — the history must not outlive
/// the thing it is a history of.
#[tokio::test]
async fn takes_are_removed_with_their_session() {
    let h = harness().await;
    let script_id = a_script(&h).await;
    let f = fixture();
    let session = sessions::start_session(&h.pool, &start_input(&f, &script_id), false)
        .await
        .expect("session started");
    sessions::record_take(&h.pool, &session.id, take_input(1, "pass-1"))
        .await
        .expect("take recorded");

    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&h.pool)
        .await
        .expect("fk on");
    sqlx::query("DELETE FROM sessions WHERE id = ?")
        .bind(&session.id)
        .execute(&h.pool)
        .await
        .expect("session deleted");

    let takes = sessions::list_takes(&h.pool, &session.id)
        .await
        .expect("takes listed");
    assert!(takes.is_empty());
}
