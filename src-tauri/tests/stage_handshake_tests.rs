//! The stage handshake, and the lost first envelope (spec §29.2, §43.3).
//!
//! The shipped symptom was a modal reading "Could not start the session. The
//! stage did not finish preparing in time." — on the default sample script, on
//! a clean machine, every time.
//!
//! The cause is a race that no layer of the existing pyramid could see.
//! `open_stage` returns as soon as the window is *built*; the webview's bundle
//! has not run and not one listener exists yet. Control publishes the session
//! envelope a few milliseconds later. A Tauri event is delivered by evaluating
//! JS inside the target webview and has no queue, so an event that arrives
//! before the page is listening is not buffered, not retried, and not reported
//! — it is simply gone. The stage therefore never hydrated, `waitForStageReady`
//! sat out its full 12 s, and the session could not start at all. Under
//! `tauri dev`, where the stage additionally waits on Vite to compile its
//! module graph, control wins that race essentially always.
//!
//! Why everything was green anyway:
//!
//!  - the browser E2E suite injects a `__TAURI_INTERNALS__` shim whose
//!    `get_stage_status` reports `hydrated` the moment the stage "exists", so
//!    the handshake resolves through the poll backstop and no event is ever in
//!    flight to lose;
//!  - the Rust suite asserted that a *listening* stage receives the envelope
//!    (`session_lifecycle_tests.rs`), which is the half that already worked;
//!  - nothing anywhere registered a listener LATE, which is the only ordering
//!    that fails.
//!
//! So the tests below are written around the ordering rather than the payload:
//! the stage subscribes *after* the publish, exactly as the real one does.
//!
//! The fix is a handshake step 0. The stage announces `stage://listening` once
//! its subscriptions resolve; Rust holds the last envelope per stage generation
//! and replays it on that announcement. Deliberately not the other obvious fix
//! — letting the stage *pull* the document with a command — because that would
//! mean granting the stage window `core:allow-invoke`, and its minimal
//! privilege (listen/emit and nothing else) is a spec commitment, Appendix D.3.

use speaking_glass_lib::coordinator::AppCoordinator;
use speaking_glass_lib::windows::{self, events, STAGE_LABEL};
use std::sync::mpsc;
use std::time::Duration;
use tauri::{Listener, Manager};

fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
    tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app builds")
}

const SESSION_ID: &str = "1f0e5a8e-6c2b-4a3d-9f11-0a1b2c3d4e5f";

fn envelope(session_id: &str, session_generation: u64, stage_generation: u64) -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": 1,
        "sessionId": session_id,
        "sessionGeneration": session_generation,
        "stageGeneration": stage_generation,
        "scriptId": "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        "sourceHash": "hash",
        "compileRevision": 1,
        "renderDocument": { "blocks": [] },
        "stageSettings": {},
    })
}

/// A stage webview that is NOT yet listening — the state the real one is in
/// when `open_stage` returns. `subscribe` is what its bundle finishing looks
/// like.
struct LateStage {
    window: tauri::WebviewWindow<tauri::test::MockRuntime>,
}

impl LateStage {
    fn build(app: &tauri::App<tauri::test::MockRuntime>) -> Self {
        let window = tauri::WebviewWindowBuilder::new(
            app,
            STAGE_LABEL,
            tauri::WebviewUrl::App("stage.html".into()),
        )
        .build()
        .expect("mock stage webview");
        Self { window }
    }

    fn subscribe(&self) -> mpsc::Receiver<serde_json::Value> {
        let (tx, rx) = mpsc::channel();
        self.window.listen(events::STAGE_LOAD_SESSION, move |event| {
            let payload: serde_json::Value =
                serde_json::from_str(event.payload()).expect("envelope is json");
            let _ = tx.send(payload);
        });
        rx
    }

    fn subscribe_live_sync(&self) -> mpsc::Receiver<serde_json::Value> {
        let (tx, rx) = mpsc::channel();
        self.window.listen(events::STAGE_LIVE_SYNC, move |event| {
            let payload: serde_json::Value =
                serde_json::from_str(event.payload()).expect("live checkpoint is json");
            let _ = tx.send(payload);
        });
        rx
    }
}

/// Coordinator state for a stage that has been opened for a live session.
fn open_stage_for_session(app: &tauri::App<tauri::test::MockRuntime>) -> (u64, u64) {
    let coordinator = app.state::<AppCoordinator>();
    let stage_generation = coordinator.next_stage_generation();
    coordinator.register_stage(stage_generation, Some(SESSION_ID.to_string()), None);
    let session_generation =
        coordinator.begin_session(SESSION_ID.to_string(), "script".into(), None);
    (stage_generation, session_generation)
}

// ---------------------------------------------------------------------------
// The race itself
// ---------------------------------------------------------------------------

/// The shipped bug, reproduced. Nothing here is about validation: the envelope
/// is perfectly valid, the generations all match, and `publish_stage_document`
/// returns `accepted: true`. It still never arrives, because the page was not
/// listening yet.
///
/// This is the assertion that makes the rest of the file meaningful — if Tauri
/// ever did buffer events, the replay would be unnecessary and this test would
/// fail rather than quietly passing for the wrong reason.
#[test]
fn an_envelope_published_before_the_stage_subscribes_is_lost() {
    let app = mock_app();
    app.manage(AppCoordinator::default());
    let stage = LateStage::build(&app);
    let (stage_generation, session_generation) = open_stage_for_session(&app);

    let ack = windows::publish_stage_document(
        app.handle(),
        SESSION_ID,
        envelope(SESSION_ID, session_generation, stage_generation),
    )
    .expect("publishing a current envelope must succeed");
    assert!(
        ack.accepted,
        "the publish is accepted — which is exactly why the failure was so \
         hard to see from control's side"
    );

    // The bundle finishes and the stage starts listening. Too late.
    let rx = stage.subscribe();
    assert!(
        rx.recv_timeout(Duration::from_millis(250)).is_err(),
        "a Tauri event is not queued for a webview that was not listening; if \
         this ever starts receiving, the whole replay path is dead code"
    );
}

/// And the fix: the same ordering, plus the announcement the stage makes when
/// its subscriptions resolve.
///
/// Revert check: delete the `store_stage_document` call in
/// `publish_stage_document` and this fails on `recv_timeout` — the shipped bug,
/// reproduced through the real command.
#[test]
fn the_replay_delivers_the_envelope_the_stage_was_too_late_to_hear() {
    let app = mock_app();
    app.manage(AppCoordinator::default());
    let stage = LateStage::build(&app);
    let (stage_generation, session_generation) = open_stage_for_session(&app);

    windows::publish_stage_document(
        app.handle(),
        SESSION_ID,
        envelope(SESSION_ID, session_generation, stage_generation),
    )
    .expect("publish");

    let rx = stage.subscribe();
    assert!(
        windows::replay_stage_document(app.handle()),
        "there is a held envelope for the current stage, so the replay must fire"
    );

    let received = rx
        .recv_timeout(Duration::from_secs(2))
        .expect("the stage must receive the envelope it missed");
    assert_eq!(received["sessionId"], serde_json::json!(SESSION_ID));
    assert_eq!(
        received["stageGeneration"],
        serde_json::json!(stage_generation),
        "and it must be the envelope for THIS stage window"
    );
}

#[test]
fn live_sync_recovers_a_transcript_event_the_stage_was_too_late_to_hear() {
    let app = mock_app();
    app.manage(AppCoordinator::default());
    let stage = LateStage::build(&app);
    let (stage_generation, _session_generation) = open_stage_for_session(&app);

    // Publish while the stage has no apply-command listener: the immediate
    // event is deliberately lost, exactly like the failure on the real rig.
    windows::publish_stage_command(
        app.handle(),
        SESSION_ID,
        serde_json::json!({
            "stageGeneration": stage_generation,
            "directive": {
                "kind": "transcript",
                "text": "recovered across the webview boundary",
                "final": false
            }
        }),
    )
    .expect("current transcript directive");

    let rx = stage.subscribe_live_sync();
    assert!(
        windows::replay_stage_live(app.handle(), stage_generation),
        "the stage pull must produce a Rust-owned checkpoint"
    );
    let recovered = rx
        .recv_timeout(Duration::from_secs(2))
        .expect("the real Tauri stage event hop must deliver the checkpoint");
    assert_eq!(
        recovered["transcript"]["directive"]["text"],
        "recovered across the webview boundary"
    );
    assert_eq!(recovered["stageGeneration"], stage_generation);
}

/// The other ordering, which is equally normal and must stay a no-op: the stage
/// came up first, the ordinary emit will land on a listening window, and there
/// is nothing to replay. A replay here would be a duplicate document.
#[test]
fn announcing_before_anything_is_published_replays_nothing() {
    let app = mock_app();
    app.manage(AppCoordinator::default());
    let _stage = LateStage::build(&app);
    open_stage_for_session(&app);

    assert!(
        !windows::replay_stage_document(app.handle()),
        "no envelope has been published yet, so there is nothing to re-send"
    );
}

/// A stage that reloads mid-session (routine under `tauri dev`) announces
/// itself again and must get its document back — otherwise the reload leaves a
/// blank stage for the rest of the take. The envelope is held, not consumed.
#[test]
fn a_reloading_stage_can_be_served_more_than_once() {
    let app = mock_app();
    app.manage(AppCoordinator::default());
    let stage = LateStage::build(&app);
    let (stage_generation, session_generation) = open_stage_for_session(&app);

    windows::publish_stage_document(
        app.handle(),
        SESSION_ID,
        envelope(SESSION_ID, session_generation, stage_generation),
    )
    .expect("publish");

    for reload in 1..=3 {
        let rx = stage.subscribe();
        assert!(
            windows::replay_stage_document(app.handle()),
            "reload {reload} must still be served"
        );
        assert!(
            rx.recv_timeout(Duration::from_secs(2)).is_ok(),
            "reload {reload} must receive the document"
        );
    }
}

// ---------------------------------------------------------------------------
// The generation checks — a replay must never cross a stage lifetime
// ---------------------------------------------------------------------------

/// Opening a new stage window discards the previous window's envelope. Without
/// this, a stage opened for take 2 would be handed take 1's document by the
/// very mechanism meant to rescue it.
#[test]
fn opening_a_new_stage_window_drops_the_previous_envelope() {
    let app = mock_app();
    app.manage(AppCoordinator::default());
    let _stage = LateStage::build(&app);
    let (stage_generation, session_generation) = open_stage_for_session(&app);

    windows::publish_stage_document(
        app.handle(),
        SESSION_ID,
        envelope(SESSION_ID, session_generation, stage_generation),
    )
    .expect("publish");

    // A second stage window: new generation, no document of its own yet.
    let coordinator = app.state::<AppCoordinator>();
    let next = coordinator.next_stage_generation();
    coordinator.register_stage(next, Some(SESSION_ID.to_string()), None);

    assert!(
        coordinator.stage_document_for_replay().is_none(),
        "the envelope belonged to the stage window that was just replaced"
    );
    assert!(!windows::replay_stage_document(app.handle()));
}

/// A closed stage releases the envelope. Nothing can be replayed to a window
/// that is gone, and holding it would pin a whole compiled document for the
/// life of the process.
#[test]
fn closing_the_stage_releases_the_envelope() {
    let app = mock_app();
    app.manage(AppCoordinator::default());
    let _stage = LateStage::build(&app);
    let (stage_generation, session_generation) = open_stage_for_session(&app);

    windows::publish_stage_document(
        app.handle(),
        SESSION_ID,
        envelope(SESSION_ID, session_generation, stage_generation),
    )
    .expect("publish");

    let coordinator = app.state::<AppCoordinator>();
    assert!(coordinator.stage_document_for_replay().is_some());
    coordinator.stage_closed(stage_generation);
    assert!(
        coordinator.stage_document_for_replay().is_none(),
        "the stage window is gone; there is nobody to replay to"
    );
}

/// A stale `stage_closed` (a previous window's destroy event arriving late)
/// must not release the CURRENT window's envelope — that would silently
/// disarm the recovery for the stage that actually needs it.
///
/// This is a real ordering, not a hypothetical: `open_stage` destroys the
/// previous window itself, and a window's `Destroyed` callback runs on another
/// thread, so the close for the take the presenter just abandoned is routinely
/// still in flight while the next take registers and publishes.
#[test]
fn a_stale_close_does_not_release_the_current_envelope() {
    let app = mock_app();
    app.manage(AppCoordinator::default());
    let _stage = LateStage::build(&app);
    let coordinator = app.state::<AppCoordinator>();

    // A full generation-1 → generation-2 lifecycle, so the stale close carries
    // a generation that genuinely existed rather than a synthetic zero.
    let first = coordinator.next_stage_generation();
    coordinator.register_stage(first, Some(SESSION_ID.to_string()), None);
    let (second, session_generation) = open_stage_for_session(&app);
    assert_eq!(second, first + 1, "the second window is the next generation");

    windows::publish_stage_document(
        app.handle(),
        SESSION_ID,
        envelope(SESSION_ID, session_generation, second),
    )
    .expect("publish");

    coordinator.stage_closed(first);
    assert!(
        coordinator.stage_document_for_replay().is_some(),
        "the late close belonged to the window that was replaced; clearing on \
         it would strand the CURRENT stage with nothing to replay — the exact \
         start-up timeout this mechanism exists to prevent"
    );
}

/*
 * A note on what is NOT tested here, and why.
 *
 * The dangerous interleaving is a close for generation G that DECIDES while G
 * is still current and CLEARS after G+1 has registered and published — it
 * discards the new stage's envelope and reproduces the start-up timeout
 * exactly. It was reachable when `stage_closed` decided under the state lock,
 * released it, and then took the document lock separately, and `open_stage`
 * destroys the previous window itself, so the ordering is the ordinary retake
 * path rather than a curiosity.
 *
 * There is no honest deterministic test for it. Splitting the two halves needs
 * a barrier INSIDE `stage_closed`, and a barrier around the whole call only
 * schedules orderings the single-threaded tests already cover — such a test
 * would pass against the broken code too, which is worse than no test.
 *
 * So the race is closed by construction instead, and it is the construction
 * that is asserted below: the document is stored only for the stage that is
 * currently open, and released only by a close that names the generation
 * holding it. With both ends qualified there is no interleaving left in which
 * one generation's close can touch another's document — the state that would
 * express the bug is now unreachable through the API, which is why it cannot
 * be set up in a test.
 */

/// An envelope stored for a window that has already gone is never stored at
/// all. `require_active_stage` validates against a snapshot it then releases,
/// so a close can land in the gap — and nothing would ever clear the value,
/// because the close that would have cleared it already ran.
#[test]
fn a_publish_for_a_window_that_just_closed_is_refused_rather_than_retained() {
    let app = mock_app();
    app.manage(AppCoordinator::default());
    let coordinator = app.state::<AppCoordinator>();

    let generation = coordinator.next_stage_generation();
    coordinator.register_stage(generation, Some(SESSION_ID.to_string()), None);
    coordinator.stage_closed(generation);

    assert!(
        !coordinator.store_stage_document(generation, serde_json::json!({"big": "payload"})),
        "the window is gone; storing would pin the document for the life of \
         the process with no close left to release it"
    );
    assert!(coordinator.stage_document_for_replay().is_none());
}

// ---------------------------------------------------------------------------
// The caller — this project's signature defect
// ---------------------------------------------------------------------------

/// `replay_stage_document` is only worth anything if something calls it, and
/// the one thing that does is a `listen_any` registration in the app setup
/// that no test can drive without a running Tauri app.
///
/// This is the same class of hole as `beginTakePass` (a finished mechanism with
/// no production caller, tested directly and passing), and it gets the same
/// treatment: assert on the source. Every test above would keep passing with
/// the bridge unwired, and the app would keep failing to start.
#[test]
fn the_event_bridge_actually_calls_the_replay() {
    let app_rs = include_str!("../src/app.rs");
    let code: String = app_rs
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");

    assert!(
        code.contains("listen_any(events::STAGE_LISTENING"),
        "the stage event bridge must listen for the stage's announcement"
    );
    assert!(
        code.contains("replay_stage_document"),
        "…and answer it by replaying the held envelope"
    );
    assert!(
        code.contains("stage_listening()"),
        "…and record that the stage is reachable, which is what lets control \
         stop charging boot time against the layout budget"
    );
    assert!(
        code.contains("listen_any(events::STAGE_SYNC_REQUEST")
            && code.matches("replay_stage_live").count() >= 2,
        "live recovery must answer explicit stage pulls and accepted heartbeat \
         ACKs; either route can heal a dropped webview event"
    );
    // The bridge is a function. Asserting on its BODY says nothing about
    // whether setup ever runs it — deleting the single call site would leave
    // every other assertion in this file green and the app unable to start.
    assert!(
        code.contains("register_stage_event_bridge(")
            && code.matches("register_stage_event_bridge").count() >= 2,
        "the bridge must be called from setup, not merely defined"
    );
    // Guard on the guard: if the constant is renamed, the assertions above
    // would pass vacuously against a bridge that wires nothing.
    assert_eq!(events::STAGE_LISTENING, "stage://listening");
    assert_eq!(events::STAGE_SYNC_REQUEST, "stage://sync-request");
    assert!(app_rs.len() > 1000);
}
