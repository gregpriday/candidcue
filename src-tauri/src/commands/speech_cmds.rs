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

use serde::Serialize;
use tauri::State;

use crate::errors::AppError;
use crate::speech::{decode_base64, default_model, SpeechEngine, SAMPLE_RATE_HZ};

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
    speech: State<'_, SpeechEngine>,
) -> Result<SpeechEngineStatus, AppError> {
    let model = default_model();
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
    speech: State<'_, SpeechEngine>,
) -> Result<(), AppError> {
    speech.ensure_loaded(&app, default_model()).map(|_| ())
}

/// What the renderer may choose about a session.
///
/// Empty, and kept as a struct rather than deleted so the IPC shape has
/// somewhere to grow. The provider-era options are all gone: `modelId` and
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
    app: tauri::AppHandle<R>,
    speech: State<'_, SpeechEngine>,
    _options: Option<TranscriptionOptions>,
) -> Result<u64, AppError> {
    speech.start_stream(app, default_model())
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
