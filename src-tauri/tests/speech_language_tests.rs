//! §153: the user picks a language, and the model follows from that choice.
//!
//! Three things are worth pinning here, and they are the three that would fail
//! silently:
//!
//!   1. **Only followable languages are offered.** The catalogue lists four
//!      models and this build can follow one language. A picker that offered
//!      the other three would be promising something no benchmark has measured
//!      (§156), and the failure would not show up until somebody spoke French
//!      at it.
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
        ])
        .build(mock_context(noop_assets()))
        .expect("mock app builds");

    app.manage(Database::new(pool));
    app.manage(paths);
    app.manage(AppCoordinator::default());
    app.manage(SpeechModelManager::new());
    app.manage(SpeechEngine::new());

    let webview =
        WebviewWindowBuilder::new(&app, "control", tauri::WebviewUrl::App("control.html".into()))
            .build()
            .expect("mock control webview");

    Harness {
        _dir: dir,
        app,
        webview,
    }
}

impl Harness {
    fn invoke(&self, command: &str, args: Value) -> Result<Value, Value> {
        tauri::test::get_ipc_response(
            &self.webview,
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

    fn expect_ok(&self, command: &str, args: Value) -> Value {
        self.invoke(command, args)
            .unwrap_or_else(|e| panic!("`{command}` must succeed, got: {e}"))
    }

    fn expect_err(&self, command: &str, args: Value) -> Value {
        self.invoke(command, args)
            .expect_err(&format!("`{command}` must fail"))
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

    // The Kroko models are catalogued and fetchable; they are not followable,
    // so no row may mention them.
    for unfollowable in ["kroko-fr", "kroko-de", "kroko-es"] {
        assert!(
            !languages
                .iter()
                .any(|row| row["modelId"] == unfollowable),
            "{unfollowable} must not appear as a language choice"
        );
    }
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
