//! Live transcription commands.
//!
//! There is no key lifecycle here any more, and that absence is the point. The
//! recogniser is a bundled resource: nothing to paste, nothing to validate,
//! nothing to store, nothing to revoke, and no reason for a take to fail that
//! is not visible on the machine it runs on. The commands that used to save,
//! validate, test and delete an API key are gone along with the credential
//! store that held it — that store existed for exactly one secret.
//!
//! What remains is the audio path: arm a session, push PCM at it, stop it.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::coordinator::AppCoordinator;
use crate::database::Database;
use crate::errors::{AppError, ErrorCategory};
use crate::settings::{self, RevisionedSettings};
use crate::speech::catalogue::{self, ModelEntry};
use crate::speech::language_options::{self, SpeechLanguageOptions};
use crate::speech::model_manager::{self, SpeechModelManager, SpeechModelStatus};
use crate::speech::{decode_base64, BundledModel, SpeechEngine, SAMPLE_RATE_HZ};

/// The recogniser the user's settings select.
///
/// Read from the database on every call rather than cached, and that is the
/// point: this is the ONE place a language choice becomes a model, and a copy
/// held anywhere else is a copy that can disagree with the settings screen.
/// `selected_model` repairs anything this build cannot load, so a stale
/// document degrades to the default rather than failing a take.
async fn selected_model(db: &Database) -> Result<&'static BundledModel, AppError> {
    let settings = settings::get_settings(db.pool()).await?;
    Ok(settings::selected_model(&settings.value))
}

/// What Settings shows in place of "is the key still good?".
///
/// The honest questions about a bundled recogniser are whether its files are
/// present and whether it has been loaded, so those are the questions this
/// answers.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechEngineStatus {
    /// Always true for a healthy installation — false means the bundle is
    /// broken, which is a reinstall rather than anything the user can fix.
    pub available: bool,
    /// Whether the model is resident in memory right now.
    pub loaded: bool,
    /// The recogniser this build ships, for the Settings line and diagnostics.
    pub model: String,
    /// Set when `available` is false: what is actually wrong.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Whether this installation can transcribe, and whether it is warm.
///
/// Never fails: a broken bundle is reported as `available: false` with a
/// reason, because Settings asking "can I transcribe?" wants an answer rather
/// than an exception.
#[tauri::command]
pub async fn get_speech_engine_status<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    db: State<'_, Database>,
    speech: State<'_, SpeechEngine>,
) -> Result<SpeechEngineStatus, AppError> {
    // "Never fails" is a promise this command makes in its own doc comment, and
    // reading the selection introduced a way to break it: a database hiccup
    // would turn "can I transcribe?" into an exception on a screen that only
    // wants an answer.
    //
    // Reported as UNAVAILABLE rather than answered about the default model.
    // Substituting the default keeps the promise and tells a lie to keep it: if
    // a non-default language is selected while the default happens to be
    // resident, `loaded` would come back true and the screen would label the
    // selected language Ready on the strength of a different recogniser being
    // warm. Not knowing which model is selected is exactly the state this field
    // exists to report.
    let model = match selected_model(&db).await {
        Ok(model) => model,
        Err(err) => {
            tracing::warn!(error = %err, "speech status: could not read the selected model");
            return Ok(SpeechEngineStatus {
                available: false,
                loaded: false,
                model: String::new(),
                detail: Some(
                    "CandidCue could not read which speech language is selected.".to_string(),
                ),
            });
        }
    };
    // "Is THIS model resident", not "is anything resident". The two are the
    // same answer while one model ships and stop being the same the moment a
    // second does — at which point a status line reporting model B as loaded
    // because model A happened to be warm is exactly the kind of lie this
    // whole surface exists to avoid.
    let loaded = speech.loaded_model_id() == Some(model.id);
    // Asked of the directory directly rather than through a config: "are the
    // files there?" is a question about the bundle, and building a tuned config
    // to ask it would imply the tuning had something to do with the answer.
    let available = match SpeechEngine::model_dir(&app, model) {
        Ok(dir) => cc_stt::local::ModelFiles::detect(&dir).map(|_| ()),
        Err(err) => Err(err.to_string()),
    };
    Ok(match available {
        Ok(()) => SpeechEngineStatus {
            available: true,
            loaded,
            model: model.id.to_string(),
            detail: None,
        },
        Err(detail) => SpeechEngineStatus {
            available: false,
            loaded,
            model: model.id.to_string(),
            detail: Some(detail),
        },
    })
}

/// Load the model without starting a take.
///
/// Worth calling when the presenter opens the live view: loading costs ~200 ms
/// and belongs anywhere except the top of a take, where the presenter has
/// already started talking. Idempotent.
#[tauri::command]
pub async fn preload_speech_engine<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    db: State<'_, Database>,
    speech: State<'_, SpeechEngine>,
) -> Result<(), AppError> {
    let model = selected_model(&db).await?;
    speech.ensure_loaded(&app, model).map(|_| ())
}

/// What the renderer may choose about a session.
///
/// Still empty after §153, and now deliberately so rather than incidentally.
/// The language is a SETTING, read here from the database, and a per-take
/// override would create a second authority over which recogniser is listening
/// — which is exactly the mid-session switching §153 rules out. A renderer that
/// could name a model per take could also name a different one from the one
/// Settings is showing.
///
/// The provider-era options are all gone: `modelId` and
/// `language` described a service that no longer exists, and `vocabulary`
/// carried a soft bias the hosted recogniser accepted on its config frame.
///
/// That last one is a real capability this swap gives up. sherpa can bias
/// toward hotwords, but only under `modified_beam_search` and only with a
/// `bpe.vocab` beside the model — the 20M bundle ships neither, and greedy
/// decoding is what the benchmark numbers were taken with. Reinstating it is a
/// model-packaging decision, not a flag, so pretending the option still does
/// something would be worse than removing it. `cc_align`'s extractor stays
/// where it is; the benchmark harness still exercises it.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionOptions {}

/// Open a live transcription session and return its generation.
///
/// Every subsequent `push_transcription_audio` and every event the session
/// emits carries this generation. It is what keeps a frame captured before a
/// take ended out of the next take's audio.
#[tauri::command]
pub async fn start_transcription<R: tauri::Runtime>(
    boot: State<'_, crate::database::BootStatus>,
    app: tauri::AppHandle<R>,
    db: State<'_, Database>,
    speech: State<'_, SpeechEngine>,
    _options: Option<TranscriptionOptions>,
) -> Result<u64, AppError> {
    // Recovery mode owns no writable database (database::BootStatus).
    boot.require_ready()?;
    let model = selected_model(&db).await?;
    speech.start_stream(app, model)
}

/// Forward one frame of PCM16 audio, base64-encoded.
///
/// Base64 rather than a byte array because the IPC bridge round-trips JSON: at
/// 100 ms per frame this is ~5 KB ten times a second, which is nothing, and it
/// avoids a second encoding of the same samples.
///
/// The frames are expected at [`SAMPLE_RATE_HZ`]; the renderer's capture graph
/// resamples to it.
#[tauri::command]
pub async fn push_transcription_audio(
    speech: State<'_, SpeechEngine>,
    generation: u64,
    chunk: String,
) -> Result<(), AppError> {
    let _ = SAMPLE_RATE_HZ;
    speech.push_audio(generation, decode_base64(&chunk)?)
}

/// End the session, giving the last utterance a chance to finalize.
#[tauri::command]
pub async fn stop_transcription(
    speech: State<'_, SpeechEngine>,
    generation: u64,
) -> Result<(), AppError> {
    speech.stop_stream(generation);
    Ok(())
}

/* -------------------------------------------------------------- model install
 *
 * §152: the recogniser is no longer inside the app. These four are how a
 * machine gets one.
 *
 * The download runs in RUST rather than in the webview, and not for tidiness:
 * the control window's CSP allows `connect-src 'self' ipc: http://ipc.localhost`
 * and nothing else, so JavaScript here cannot reach a remote host at all. It
 * also should not — the hardened hop guard, the SHA-256 check and the atomic
 * install are the reasons this is safe, and none of them can live in a webview.
 *
 * All four take an OPTIONAL `modelId` and fall back to the catalogue default.
 * There is one model worth naming today, and making every call site spell it
 * out would put a string that belongs to the catalogue into the frontend.
 */

/// What Settings and Welcome show about a speech model.
#[tauri::command]
pub async fn get_speech_model_status<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    models: State<'_, SpeechModelManager>,
    model_id: Option<String>,
) -> Result<SpeechModelStatus, AppError> {
    let entry = resolve_entry(model_id.as_deref())?;
    Ok(models.status(&app, entry))
}

/// Begin downloading a model, or join the download already running.
///
/// Returns as soon as the job is registered rather than when it finishes: a
/// 128 MB transfer outlives any reasonable IPC call, so progress arrives on
/// `speech://model-progress` and this hands back the status to paint now.
#[tauri::command]
pub async fn start_speech_model_download<R: tauri::Runtime>(
    boot: State<'_, crate::database::BootStatus>,
    app: tauri::AppHandle<R>,
    models: State<'_, SpeechModelManager>,
    model_id: Option<String>,
) -> Result<SpeechModelStatus, AppError> {
    // Recovery mode owns no writable database (database::BootStatus).
    boot.require_ready()?;
    let entry = resolve_entry(model_id.as_deref())?;
    models.start(&app, entry)
}

/// Stop a running download, keeping what has been transferred so far.
#[tauri::command]
pub async fn cancel_speech_model_download<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    models: State<'_, SpeechModelManager>,
    model_id: Option<String>,
) -> Result<SpeechModelStatus, AppError> {
    let entry = resolve_entry(model_id.as_deref())?;
    Ok(models.cancel(&app, entry))
}

/// Remove a downloaded model, and any partial download of it, from app data.
///
/// Refuses while a take is running on it or an install is in flight — see
/// `SpeechModelManager::delete`.
#[tauri::command]
pub async fn delete_speech_model<R: tauri::Runtime>(
    boot: State<'_, crate::database::BootStatus>,
    app: tauri::AppHandle<R>,
    models: State<'_, SpeechModelManager>,
    model_id: Option<String>,
) -> Result<SpeechModelStatus, AppError> {
    // Recovery mode owns no writable database (database::BootStatus).
    boot.require_ready()?;
    let entry = resolve_entry(model_id.as_deref())?;
    models.delete(&app, entry)
}

/* ------------------------------------------------------------ language choice
 *
 * §153: the user picks a LANGUAGE. The model is an implementation detail of
 * that choice, which is why these two commands speak in language tags and the
 * four above speak in model ids.
 */

/// Every language this build can follow, with what fetching each one costs.
///
/// One call rather than "list languages, then ask about each model": a row
/// cannot be painted without both halves, and splitting them would give the
/// sizes and the install state separate chances to go stale.
#[tauri::command]
pub async fn get_speech_language_options<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    db: State<'_, Database>,
    models: State<'_, SpeechModelManager>,
    coordinator: State<'_, AppCoordinator>,
) -> Result<SpeechLanguageOptions, AppError> {
    let settings = settings::get_settings(db.pool()).await?;
    Ok(language_options::build(
        &app,
        &models,
        &settings.value,
        take_is_running(&coordinator),
    ))
}

/// What the picker sends when the user commits to a language.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectSpeechLanguageInput {
    /// The settings revision the screen was showing. Carried so a language
    /// change cannot silently clobber an unrelated edit made in another window.
    pub expected_revision: i64,
    /// A BCP-47 tag. Resolved by PRIMARY SUBTAG against the offer list, and the
    /// offer's own canonical tag is what gets persisted — never this string.
    pub language_tag: String,
}

/// Make a language the one CandidCue listens in.
///
/// Writes BOTH halves of the choice in ONE patch, and that is the whole reason
/// this command exists rather than the screen issuing two settings writes. The
/// language and the recogniser are a pair: persisted separately they can be
/// observed half-applied, and a session declaring one language while the
/// settings screen shows another is the failure `services/settings.ts` warns
/// about in as many words.
///
/// Refused while a take is running. The recogniser loads once and stays
/// resident, so honouring a change mid-take would either do nothing (and lie
/// about it) or swap the model out from under a live session.
#[tauri::command]
pub async fn select_speech_language<R: tauri::Runtime>(
    boot: State<'_, crate::database::BootStatus>,
    app: tauri::AppHandle<R>,
    db: State<'_, Database>,
    coordinator: State<'_, AppCoordinator>,
    input: SelectSpeechLanguageInput,
) -> Result<RevisionedSettings, AppError> {
    // Recovery mode owns no writable database (database::BootStatus).
    boot.require_ready()?;
    if take_is_running(&coordinator) {
        return Err(AppError::structured(
            "STT_LANGUAGE_CHANGE_BLOCKED",
            ErrorCategory::Validation,
            "End the current take before changing the speech language.",
            true,
        )
        .with_log("language change requested while a session was open".to_string()));
    }

    // The same offer list the picker rendered from, so a tag that was offerable
    // when the screen painted is still checked against the build's own tables
    // rather than trusted. An unoffered language is refused here and can never
    // reach the settings document.
    let Some(offer) = language_options::offer_for_tag(&input.language_tag) else {
        return Err(AppError::structured(
            "STT_LANGUAGE_UNAVAILABLE",
            ErrorCategory::Validation,
            "CandidCue cannot follow that language yet.",
            false,
        )
        .with_log(format!("no offer for language tag {:?}", input.language_tag)));
    };

    // Activating a language whose weights are not on the machine would leave
    // the app claiming to listen in a language it cannot load — the take would
    // fail at its top, which is the outcome §153 exists to move earlier.
    if model_manager::resolve_for(&app, offer.entry).is_none() {
        return Err(AppError::structured(
            "STT_MODEL_NOT_INSTALLED",
            ErrorCategory::Validation,
            "Download this language before switching to it.",
            true,
        )
        .with_log(format!("model {:?} is not installed", offer.entry.id)));
    }

    let patch = serde_json::json!({
        "audio": {
            "language": offer.language_tag,
            "transcriptionModel": offer.model.id,
        }
    });
    let updated = settings::update_settings(db.pool(), input.expected_revision, patch).await?;
    /*
     * AND TELL THE WINDOWS.
     *
     * This is the second place in the app that writes the settings document,
     * and it used to be the silent one: `update_settings` in `settings_cmds`
     * broadcasts, this did not. The consequence was not cosmetic — every window
     * kept the revision it last read, so the next ordinary save from Settings
     * failed its optimistic-concurrency check because of a language change made
     * minutes earlier.
     */
    crate::commands::settings_cmds::broadcast_settings(&app, &updated);
    Ok(updated)
}

/// Whether a take is open, as Rust sees it.
///
/// The COORDINATOR's session rather than `SpeechEngine::active_generation`,
/// because a take exists before its transcription stream does: `start_session`
/// establishes this the moment the take begins arming, and a language change
/// landing in that window would apply to a take already under way.
///
/// A check against a moving target, like the one `SpeechModelManager::delete`
/// makes for the same reason and documents in the same terms: a take can begin
/// between this returning false and the write landing. The consequence is
/// bounded and benign — `ensure_loaded` hands a running session its own `Arc`,
/// so a take already under way finishes on the recogniser it started with, and
/// the new choice applies to the next one. That is the behaviour §153 asks for
/// ("a change applies to the next take"), reached by a different route than
/// intended. Closing the window properly means latching the selection into the
/// session at `begin_session`, which is a change to the take lifecycle rather
/// than to this command.
fn take_is_running(coordinator: &AppCoordinator) -> bool {
    coordinator.snapshot().session.session_id.is_some()
}

/// A catalogue entry from an optional id, defaulting to the catalogue default.
///
/// The `'static` lifetime is load-bearing: `start` hands the entry to a task
/// that outlives this call, and the catalogue is a `LazyLock` that lives for
/// the process, so there is nothing to clone and no lifetime to launder.
fn resolve_entry(model_id: Option<&str>) -> Result<&'static ModelEntry, AppError> {
    match model_id {
        Some(id) => model_manager::entry_for(id),
        None => Ok(catalogue::default_model()),
    }
}
