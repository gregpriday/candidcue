//! §153: the user picks a language, and the model follows from that choice.
//!
//! Three things are worth pinning here, and they are the three that would fail
//! silently:
//!
//!   1. **Only followable languages are offered.** The catalogue lists one
//!      bilingual model and this build can follow one language. Chinese has
//!      no alignment profile; French, German and Spanish have neither a
//!      profile nor a recogniser. A picker that offered any of them would be
//!      promising something no benchmark has measured (§156), and the
//!      failure would not show up until somebody spoke French at it.
//!   2. **The language and the recogniser move together.** They are one choice
//!      stored in two fields, and a write that sets one without the other is
//!      how the settings screen ends up disagreeing with the live session.
//!   3. **A take blocks the change.** The recogniser loads once and stays
//!      resident, so a change accepted mid-take would either be ignored or
//!      swap the model out from under a session.
//!
//! Driven through the real IPC path rather than by calling the functions
//! directly, because the serialized SHAPE is half the contract — the frontend
//! reads `downloadBytes`, not `download_bytes`, and a rename that compiles
//! would break the picker with nothing failing here.

use candidcue_lib::align::{AlignToken, AlignmentState};
use candidcue_lib::coordinator::AppCoordinator;
use candidcue_lib::database::{self, Database};
use candidcue_lib::settings;
use candidcue_lib::speech::language_options;
use candidcue_lib::speech::model_manager::SpeechModelManager;
use candidcue_lib::speech::SpeechEngine;
use candidcue_lib::{commands, scripts::DataPaths};
use serde_json::{json, Value};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{Manager as _, WebviewWindow, WebviewWindowBuilder};

struct Harness {
    _dir: tempfile::TempDir,
    app: tauri::App<MockRuntime>,
    webview: WebviewWindow<MockRuntime>,
    /// Settings' window. Commands that care who is asking (#264) are invoked
    /// from here to stand for the Settings screen.
    preferences: WebviewWindow<MockRuntime>,
}

fn harness() -> Harness {
    let dir = tempfile::tempdir().expect("tempdir");
    let pool = tauri::async_runtime::block_on(database::init(dir.path()))
        .expect("database init + migrations");
    let paths = DataPaths::new(dir.path().to_path_buf());

    let app = mock_builder()
        .invoke_handler(tauri::generate_handler![
            commands::get_speech_language_options,
            commands::select_speech_language,
            commands::get_settings,
            commands::update_settings,
            commands::preload_speech_engine,
            commands::start_transcription,
            commands::stop_transcription,
        ])
        .build(mock_context(noop_assets()))
        .expect("mock app builds");

    // `select_speech_language` and `start_speech_model_download` refuse to run
    // in recovery mode, so the harness has to declare which mode it exercises.
    app.manage(candidcue_lib::database::BootStatus::Ready);
    app.manage(Database::new(pool));
    app.manage(paths);
    app.manage(AppCoordinator::default());
    app.manage(SpeechModelManager::new());
    app.manage(SpeechEngine::new());
    app.manage(AlignmentState::new());

    let webview =
        WebviewWindowBuilder::new(&app, "control", tauri::WebviewUrl::App("control.html".into()))
            .build()
            .expect("mock control webview");
    let preferences = WebviewWindowBuilder::new(
        &app,
        candidcue_lib::windows::preferences::PREFERENCES_LABEL,
        tauri::WebviewUrl::App("preferences.html".into()),
    )
    .build()
    .expect("mock preferences webview");

    Harness {
        _dir: dir,
        app,
        webview,
        preferences,
    }
}

impl Harness {
    fn invoke(&self, command: &str, args: Value) -> Result<Value, Value> {
        invoke_from(&self.webview, command, args)
    }

    fn expect_ok(&self, command: &str, args: Value) -> Value {
        self.invoke(command, args)
            .unwrap_or_else(|e| panic!("`{command}` must succeed, got: {e}"))
    }

    fn expect_err(&self, command: &str, args: Value) -> Value {
        self.invoke(command, args)
            .expect_err(&format!("`{command}` must fail"))
    }

    /// The same call, made by Settings rather than by control.
    fn invoke_from_settings(&self, command: &str, args: Value) -> Result<Value, Value> {
        invoke_from(&self.preferences, command, args)
    }

    fn options(&self) -> Value {
        self.expect_ok("get_speech_language_options", json!({}))
    }

    fn begin_take(&self) {
        self.app.state::<AppCoordinator>().begin_session(
            "session-under-test".to_string(),
            "script-under-test".to_string(),
            Some("compile-hash".to_string()),
        );
    }
}

/// A model-backed test that fails part-way must not leave a decoder running
/// for the rest of the binary: stop whatever stream is still live.
impl Drop for Harness {
    fn drop(&mut self) {
        let speech = self.app.state::<SpeechEngine>();
        if let Some(generation) = speech.active_generation() {
            speech.stop_stream(generation);
        }
    }
}

fn invoke_from(
    from: &WebviewWindow<MockRuntime>,
    command: &str,
    args: Value,
) -> Result<Value, Value> {
    tauri::test::get_ipc_response(
        from,
        InvokeRequest {
            cmd: command.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "tauri://localhost".parse().expect("url"),
            body: InvokeBody::Json(args),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(|b| b.deserialize::<Value>().expect("response is json"))
}

fn code_of(err: &Value) -> &str {
    err.get("code").and_then(Value::as_str).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// What is offered
// ---------------------------------------------------------------------------

/// The list is what this build can FOLLOW, not what it can download.
///
/// §153: "A language we cannot follow well should not be in the list at all."
/// Not disabled, not annotated — absent.
#[test]
fn only_followable_languages_are_offered() {
    let h = harness();
    let options = h.options();
    let languages = options["languages"].as_array().expect("languages array");

    assert_eq!(
        languages.len(),
        1,
        "expected one offerable language, got {languages:?}"
    );
    assert_eq!(languages[0]["primarySubtag"], "en");
    assert_eq!(languages[0]["languageTag"], "en-US");
    assert_eq!(languages[0]["modelId"], "x-asr-480ms");

    for unfollowable in ["fr", "de", "es", "zh"] {
        assert!(
            !languages
                .iter()
                .any(|row| row["primarySubtag"] == unfollowable),
            "{unfollowable} must not be offered"
        );
    }
}

/// Everything the user is told BEFORE pressing Download.
///
/// §153 names three facts — transfer size, size on disk, and where it comes
/// from — plus the attribution the app carries. Each is asserted by name
/// because the picker reads them by name.
#[test]
fn a_language_states_its_cost_and_origin_before_anything_downloads() {
    let h = harness();
    let options = h.options();
    let english = &options["languages"][0];

    let download = english["status"]["downloadBytes"].as_u64().expect("downloadBytes");
    let installed = english["status"]["installedBytes"].as_u64().expect("installedBytes");
    assert!(download > 0, "the transfer size must be stated");
    assert!(
        installed > download,
        "the on-disk size is the larger number and both are shown: {installed} vs {download}"
    );

    let origins = english["origins"].as_array().expect("origins array");
    assert!(!origins.is_empty(), "the user is told where the bytes come from");
    let upstream = origins.last().expect("an upstream origin");
    assert_eq!(upstream["kind"], "upstream");
    assert_eq!(upstream["host"], "github.com");

    // Attribution travels with the model (§157) and is shown, never gated on.
    let attribution = &english["attribution"];
    assert!(attribution["title"].as_str().is_some_and(|s| !s.is_empty()));
    assert!(attribution["author"].as_str().is_some_and(|s| !s.is_empty()));
    assert_eq!(attribution["license"]["id"], "Apache-2.0");
    assert!(attribution["license"]["url"]
        .as_str()
        .is_some_and(|url| url.starts_with("https://")));
}

/// The two identifiers are different strings for different jobs.
///
/// `modelId` is the short catalogue id every install command takes;
/// `recognizerId` is the long `BundledModel::id` that settings persists.
/// Swapping them compiles and produces a picker that can never match its own
/// active row.
#[test]
fn the_catalogue_id_and_the_recogniser_id_are_reported_separately() {
    let h = harness();
    let options = h.options();
    let english = &options["languages"][0];

    let model_id = english["modelId"].as_str().expect("modelId");
    let recognizer_id = english["recognizerId"].as_str().expect("recognizerId");
    assert_ne!(model_id, recognizer_id);
    assert_eq!(model_id, "x-asr-480ms");
    assert_eq!(recognizer_id, candidcue_lib::speech::default_model().id);

    // The status carries the SHORT id, because that is what the install
    // commands are addressed with.
    assert_eq!(english["status"]["modelId"], model_id);

    // …and what settings persists is the LONG one.
    assert_eq!(options["active"]["recognizerId"], recognizer_id);
}

/// A fresh install already has a coherent choice, and the picker says so.
#[test]
fn the_default_install_reports_english_as_active() {
    let h = harness();
    let options = h.options();
    assert_eq!(options["active"]["languageTag"], "en-US");
    assert_eq!(options["active"]["primarySubtag"], "en");
    assert_eq!(options["active"]["modelId"], "x-asr-480ms");
    assert_eq!(options["languages"][0]["active"], true);
    assert_eq!(options["changeBlocked"], false);
}

/// The model is not installed in a temp app data dir, and that state has to be
/// visible HERE rather than at the top of a take (§153).
#[test]
fn a_missing_model_is_visible_on_the_picker() {
    let h = harness();
    let options = h.options();
    let english = &options["languages"][0];

    assert_eq!(english["status"]["installed"], false);
    assert_eq!(english["status"]["phase"], "notInstalled");
    // Supported but absent: the build CAN load it, the machine does not have
    // it. Those are different problems with different remedies, and the picker
    // needs to tell them apart.
    assert_eq!(english["status"]["supported"], true);
    assert!(
        !options["removable"]
            .as_array()
            .expect("removable array")
            .iter()
            .any(|status| status["modelId"] == "x-asr-480ms"),
        "a model that is not installed has no disk to reclaim"
    );
}

// ---------------------------------------------------------------------------
// Choosing one
// ---------------------------------------------------------------------------

/// A language nothing offers cannot be talked into the settings document.
#[test]
fn an_unoffered_language_is_refused() {
    let h = harness();
    for tag in ["fr-FR", "de-DE", "es-ES", "zh-CN", "english", "", "  "] {
        let err = h.expect_err(
            "select_speech_language",
            json!({ "input": { "expectedRevision": 1, "languageTag": tag } }),
        );
        assert_eq!(
            code_of(&err),
            "STT_LANGUAGE_UNAVAILABLE",
            "{tag} must be refused as unavailable"
        );
    }
    // Nothing was written.
    let settings = h.expect_ok("get_settings", json!({}));
    assert_eq!(settings["value"]["audio"]["language"], "en-US");
}

/// An offerable language whose weights are absent is refused too — with a
/// DIFFERENT code, because the remedy is a download rather than a wait for
/// §157.
#[test]
fn an_offered_but_uninstalled_language_is_refused_with_a_download_remedy() {
    let h = harness();
    let err = h.expect_err(
        "select_speech_language",
        json!({ "input": { "expectedRevision": 1, "languageTag": "en-US" } }),
    );
    assert_eq!(code_of(&err), "STT_MODEL_NOT_INSTALLED");
    assert_eq!(
        err.get("recoverable").and_then(Value::as_bool),
        Some(true),
        "downloading it is a remedy the user can take"
    );
}

/// The take is the thing that blocks a change, and Rust is the authority.
///
/// Checked before anything else so the refusal is about the take rather than
/// about whichever other reason the request would also have failed for.
#[test]
fn a_language_change_is_blocked_while_a_take_is_open() {
    let h = harness();
    h.begin_take();

    assert_eq!(
        h.options()["changeBlocked"],
        true,
        "the picker is told the change is blocked before the user tries"
    );

    let err = h.expect_err(
        "select_speech_language",
        json!({ "input": { "expectedRevision": 1, "languageTag": "en-US" } }),
    );
    assert_eq!(code_of(&err), "STT_LANGUAGE_CHANGE_BLOCKED");
    assert_eq!(
        err.get("recoverable").and_then(Value::as_bool),
        Some(true),
        "ending the take is a remedy the user can take"
    );
}

/// Ending the take lifts the block — the change applies to the NEXT take,
/// which is what §153 asks for.
#[test]
fn ending_the_take_unblocks_the_change() {
    let h = harness();
    h.begin_take();
    assert_eq!(h.options()["changeBlocked"], true);

    h.app.state::<AppCoordinator>().end_session("session-under-test");
    assert_eq!(h.options()["changeBlocked"], false);

    // Still refused, but now for the honest reason: the weights are not here.
    let err = h.expect_err(
        "select_speech_language",
        json!({ "input": { "expectedRevision": 1, "languageTag": "en-US" } }),
    );
    assert_eq!(code_of(&err), "STT_MODEL_NOT_INSTALLED");
}

// ---------------------------------------------------------------------------
// Loading, off the async runtime (#256)
// ---------------------------------------------------------------------------

/// Preload and the start of a take load the model on a blocking thread rather
/// than on the async worker the command arrived on. What that move can break
/// is the plumbing around it: the engine is looked up again on the far side,
/// and the load's own error has to come back as itself rather than as "the
/// task failed". A machine with no model installed is the one load outcome a
/// test can reach without ~161 MB of weights.
///
/// Says nothing about a SUCCESSFUL load, which needs the real model. The
/// locking that makes overlapping loads safe is `speech::resident`'s to test.
#[test]
fn preload_reports_a_missing_model_as_itself() {
    let h = harness();
    let err = h.expect_err("preload_speech_engine", json!({}));
    assert_eq!(code_of(&err), "STT_MODEL_NOT_INSTALLED");
    assert_eq!(
        err.get("recoverable").and_then(Value::as_bool),
        Some(true),
        "downloading the model is a remedy the user can take"
    );
}

#[test]
fn starting_a_take_reports_a_missing_model_as_itself() {
    let h = harness();
    let err = h.expect_err("start_transcription", json!({}));
    assert_eq!(code_of(&err), "STT_MODEL_NOT_INSTALLED");
    assert_eq!(
        h.app.state::<SpeechEngine>().active_generation(),
        None,
        "no session is armed on a model that is not there"
    );
}

// ---------------------------------------------------------------------------
// Who may start a stream during a take (#264)
// ---------------------------------------------------------------------------

/// Settings' "Test transcription" makes the same call a take does, and there
/// is one stream at a time: accepted mid-take, it took the take's recogniser
/// and its alignment binding, and following never came back. Refused instead,
/// and before anything else, so the refusal is about the take rather than
/// about the model this machine also lacks.
#[test]
fn settings_cannot_test_transcription_while_a_take_is_open() {
    let h = harness();
    h.begin_take();

    let err = h
        .invoke_from_settings("start_transcription", json!({ "options": {} }))
        .expect_err("a test started mid-take must be refused");
    assert_eq!(code_of(&err), "STT_TEST_BLOCKED_BY_TAKE");
    assert_eq!(
        err.get("recoverable").and_then(Value::as_bool),
        Some(true),
        "ending the take is a remedy the user can take"
    );
    assert_eq!(h.app.state::<SpeechEngine>().active_generation(), None);
}

/// The take's own call arrives with its session already open — `startTake`
/// awaits `start_session` before the voice pipeline starts — so the guard
/// must not catch it. It gets as far as the model, which is all a test
/// without ~161 MB of weights can show.
#[test]
fn the_take_is_not_refused_by_its_own_session() {
    let h = harness();
    h.begin_take();

    assert_admitted(&h, h.invoke("start_transcription", json!({ "options": {} })));
}

/// With no take open, Settings' test is an ordinary start — and ending a take
/// lifts the refusal.
#[test]
fn settings_can_test_transcription_when_no_take_is_open() {
    let h = harness();
    assert_admitted(&h, h.invoke_from_settings("start_transcription", json!({ "options": {} })));

    h.begin_take();
    h.app.state::<AppCoordinator>().end_session("session-under-test");
    assert_admitted(&h, h.invoke_from_settings("start_transcription", json!({ "options": {} })));
}

/// A start the guard let through: it reached the model. Without one that is
/// exactly `STT_MODEL_NOT_INSTALLED`; with `CANDIDCUE_MODELS_DIR` exported it
/// is a stream, stopped again here. Anything else — an argument that failed to
/// bind, say — is not admission, which "not the refusal code" would miss.
fn assert_admitted(h: &Harness, result: Result<Value, Value>) {
    match result {
        Ok(generation) => {
            let generation = generation_of(generation);
            h.app.state::<SpeechEngine>().stop_stream(generation);
        }
        Err(err) => assert_eq!(code_of(&err), "STT_MODEL_NOT_INSTALLED", "{err}"),
    }
}

/// The two halves only a real recogniser can show: the take's stream and its
/// alignment binding survive a refused test, and a take still replaces a
/// running test. Ignored because they need the model:
///
/// ```text
/// CANDIDCUE_MODELS_DIR=/path/to/src-tauri/models \
///   cargo test --test speech_language_tests transcription_ -- --ignored
/// ```
fn require_model() {
    assert!(
        std::env::var_os("CANDIDCUE_MODELS_DIR").is_some(),
        "set CANDIDCUE_MODELS_DIR to a directory `pnpm models:fetch` filled"
    );
}

fn arm_alignment(h: &Harness) {
    let tokens: Vec<AlignToken> = serde_json::from_value(json!([
        { "surface": "candidcue" },
        { "surface": "is" },
        { "surface": "following" },
    ]))
    .expect("tokens");
    h.app.state::<AlignmentState>().start(1, &tokens);
}

fn generation_of(value: Value) -> u64 {
    value.as_u64().expect("start_transcription returns its generation")
}

#[test]
#[ignore = "needs the recogniser: set CANDIDCUE_MODELS_DIR"]
fn transcription_a_settings_test_cannot_take_the_recogniser_from_a_take() {
    require_model();
    let h = harness();
    h.begin_take();
    arm_alignment(&h);
    let take = generation_of(h.expect_ok("start_transcription", json!({ "options": {} })));
    let speech = h.app.state::<SpeechEngine>();
    let alignment = h.app.state::<AlignmentState>();
    assert_eq!(speech.active_generation(), Some(take));
    assert_eq!(alignment.bound_stream(), Some(take));

    let err = h
        .invoke_from_settings("start_transcription", json!({ "options": {} }))
        .expect_err("a test started mid-take must be refused");
    assert_eq!(code_of(&err), "STT_TEST_BLOCKED_BY_TAKE");
    assert_eq!(speech.active_generation(), Some(take), "the take keeps its stream");
    assert_eq!(alignment.bound_stream(), Some(take), "and its alignment binding");
}

/// The race the up-front check alone left open: Settings asks before the take
/// opens, so it is admitted, then waits out a cold load during which the take
/// does open. Asked again after the load, it yields.
///
/// Timing-dependent in one direction only: the take must open inside the
/// load, which takes over a second. A load faster than the pause below fails
/// loudly at `expect_err` rather than passing by accident.
#[test]
#[ignore = "needs the recogniser: set CANDIDCUE_MODELS_DIR"]
fn transcription_a_settings_test_queued_behind_a_load_yields_to_the_take() {
    require_model();
    let h = harness();
    let preferences = h.preferences.clone();
    let pending = std::thread::spawn(move || {
        invoke_from(&preferences, "start_transcription", json!({ "options": {} }))
    });

    std::thread::sleep(std::time::Duration::from_millis(250));
    h.begin_take();

    let err = pending
        .join()
        .expect("the Settings request completes")
        .expect_err("a test whose load outlasted the take's opening must be refused");
    assert_eq!(code_of(&err), "STT_TEST_BLOCKED_BY_TAKE");
    let speech = h.app.state::<SpeechEngine>();
    assert!(
        speech.is_loaded(),
        "refused AFTER the load — the up-front check alone would not have loaded it"
    );
    assert_eq!(speech.active_generation(), None, "and nothing was bound or replaced");
}

#[test]
#[ignore = "needs the recogniser: set CANDIDCUE_MODELS_DIR"]
fn transcription_a_take_still_replaces_a_running_settings_test() {
    require_model();
    let h = harness();
    let test = generation_of(
        h.invoke_from_settings("start_transcription", json!({ "options": {} }))
            .expect("with no take open, Settings may test"),
    );

    h.begin_take();
    arm_alignment(&h);
    let take = generation_of(h.expect_ok("start_transcription", json!({ "options": {} })));
    let speech = h.app.state::<SpeechEngine>();
    assert_ne!(take, test);
    assert_eq!(speech.active_generation(), Some(take));
    assert_eq!(h.app.state::<AlignmentState>().bound_stream(), Some(take));

    // The test's own Stop, landing late, names its own generation and cannot
    // end the take that replaced it.
    h.invoke_from_settings("stop_transcription", json!({ "generation": test }))
        .expect("a stale stop is accepted and ignored");
    assert_eq!(speech.active_generation(), Some(take));
}

// ---------------------------------------------------------------------------
// The pair
// ---------------------------------------------------------------------------

/// The language and the recogniser are one choice. A patch that sets a
/// language this recogniser cannot serve must FAIL rather than be accepted and
/// silently repaired on the next read — that repair is what let the settings
/// screen and the live session describe different languages.
#[tokio::test]
async fn a_write_cannot_split_the_language_from_its_recogniser() {
    let dir = tempfile::tempdir().expect("tempdir");
    let pool = database::init(dir.path()).await.expect("database init");

    let unfollowable = settings::update_settings(
        &pool,
        1,
        json!({ "audio": { "language": "fr-FR" } }),
    )
    .await
    .expect_err("a language this recogniser cannot serve must be refused");
    assert_eq!(unfollowable.code(), "VALIDATION_FAILED");

    let unloadable = settings::update_settings(
        &pool,
        1,
        json!({ "audio": { "transcriptionModel": "inworld/inworld-stt-1" } }),
    )
    .await
    .expect_err("a recogniser this build cannot load must be refused");
    assert_eq!(unloadable.code(), "VALIDATION_FAILED");

    // Chinese is the interesting one: the recogniser DOES transcribe it and the
    // alignment engine has no profile for it, so it fails on the second half of
    // the conjunction rather than the first.
    let untrackable = settings::update_settings(&pool, 1, json!({ "audio": { "language": "zh-CN" } }))
        .await
        .expect_err("a language the engine cannot align must be refused");
    assert_eq!(untrackable.code(), "VALIDATION_FAILED");

    // Nothing stuck.
    let stored = settings::get_settings(&pool).await.expect("settings");
    assert_eq!(stored.revision, 1);
    assert_eq!(stored.value.audio.language, "en-US");
    assert_eq!(
        stored.value.audio.transcription_model,
        candidcue_lib::speech::default_model().id
    );
}

/// A coherent pair still goes through, and a spelling of the same language is
/// accepted — `en-GB` is English, and refusing it would be inventing a
/// distinction the recogniser does not make.
#[tokio::test]
async fn a_coherent_language_write_is_accepted() {
    let dir = tempfile::tempdir().expect("tempdir");
    let pool = database::init(dir.path()).await.expect("database init");

    let updated = settings::update_settings(&pool, 1, json!({ "audio": { "language": "en-GB" } }))
        .await
        .expect("en-GB is English");
    assert_eq!(updated.value.audio.language, "en-GB");
    assert_eq!(
        updated.value.audio.transcription_model,
        candidcue_lib::speech::default_model().id
    );
}

/// Unrelated settings edits must not disturb the pair.
#[tokio::test]
async fn an_unrelated_patch_leaves_the_language_alone() {
    let dir = tempfile::tempdir().expect("tempdir");
    let pool = database::init(dir.path()).await.expect("database init");

    let updated = settings::update_settings(
        &pool,
        1,
        json!({ "general": { "wordsPerMinuteEstimate": 150 } }),
    )
    .await
    .expect("unrelated patch");
    assert_eq!(updated.value.audio.language, "en-US");
    assert_eq!(
        updated.value.audio.transcription_model,
        candidcue_lib::speech::default_model().id
    );
}

/// The upgrade path, which is the whole reason refusing a write is safe.
///
/// Previous builds offered French, so a user upgrading into this one has
/// `fr-FR` sitting in the settings row — a pair this build's `validate` would
/// reject outright. Every patch is merged onto the CURRENT document, so if the
/// merge base were the stored value, that user could no longer change their
/// font size, their mic sensitivity or anything else: settings would be frozen
/// by a language they are not touching, and frozen for exactly the people the
/// read-time repair exists to protect.
///
/// It is not, because `get_settings` migrates before `update_settings` merges,
/// so the base is already coherent and the unrelated write goes through. It
/// also COMMITS that repair, which is the second half of the bargain: the stale
/// tag is gone from disk afterwards rather than being re-corrected on every
/// load forever.
///
/// Seeded straight into the row, because `update_settings` is now precisely the
/// thing that could not have written it.
#[tokio::test]
async fn an_obsolete_language_does_not_make_settings_unwritable() {
    let dir = tempfile::tempdir().expect("tempdir");
    let pool = database::init(dir.path()).await.expect("database init");

    // A document an older build could plausibly have left behind: French,
    // paired with the recogniser this build does ship.
    let mut obsolete = settings::AppSettings::default();
    obsolete.audio.language = "fr-FR".to_string();
    obsolete.audio.vad_sensitivity = 0.5;
    sqlx::query("INSERT INTO settings (key, value_json, revision, updated_at) VALUES (?, ?, ?, ?)")
        .bind(settings::SETTINGS_KEY)
        .bind(serde_json::to_string(&obsolete).expect("serialize"))
        .bind(4_i64)
        .bind("2026-01-01T00:00:00.000Z")
        .execute(&pool)
        .await
        .expect("seed a settings document an older build wrote");

    // The read repairs it, and reports the revision the patch has to name.
    let current = settings::get_settings(&pool).await.expect("settings");
    assert_eq!(current.revision, 4);
    assert_eq!(
        current.value.audio.language, "en-US",
        "the read-time repair is what makes the write below possible"
    );

    let updated = settings::update_settings(
        &pool,
        current.revision,
        json!({ "audio": { "vadSensitivity": 0.8 } }),
    )
    .await
    .expect("an unrelated patch must not be refused over a language nobody touched");

    assert_eq!(updated.revision, 5, "the write really happened");
    assert_eq!(updated.value.audio.vad_sensitivity, 0.8);
    assert_eq!(updated.value.audio.language, "en-US");
    assert_eq!(
        updated.value.audio.transcription_model,
        candidcue_lib::speech::default_model().id
    );

    // …and the repair is now on disk. A stale tag that survived every write
    // would be re-corrected on every load and never actually leave.
    let stored: String = sqlx::query_scalar("SELECT value_json FROM settings WHERE key = ?")
        .bind(settings::SETTINGS_KEY)
        .fetch_one(&pool)
        .await
        .expect("read the stored document back");
    assert!(
        !stored.contains("fr-FR"),
        "the unrelated write persisted the read-time repair, got: {stored}"
    );
}

/// The offer list and what a selection would persist have to agree, or the
/// picker offers a value the settings document then rejects.
#[test]
fn every_offer_would_pass_settings_validation() {
    for offer in language_options::offerable_languages() {
        let mut candidate = settings::AppSettings::default();
        candidate.audio.language = offer.language_tag.clone();
        candidate.audio.transcription_model = offer.model.id.to_string();
        settings::validate(&candidate).unwrap_or_else(|e| {
            panic!(
                "offer {}/{} would be rejected by validate: {e}",
                offer.primary_subtag, offer.model.id
            )
        });
    }
}
