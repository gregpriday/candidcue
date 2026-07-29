//! xAI key lifecycle and live transcription commands (spec §46.4).
//!
//! The candidate key enters Rust exactly once through `save_stt_key` /
//! `validate_stt_key` and is never echoed back, logged, or stored outside
//! the OS credential store. It is not returned to JavaScript even to open a
//! socket: the streaming session is held here, and the renderer only pushes
//! audio at it.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::errors::{AppError, ErrorCategory, RecoveryAction};
use crate::secrets::{
    dev_env_key_active, KeySource, RedactedSecretMetadata, SecretStore, SecretString,
    DEV_KEY_ENV_VAR,
};
use crate::stt::{
    decode_base64, primary_subtag, KeyValidationResult, SttClient, SttConfig, DEFAULT_LANGUAGE,
};

/// Managed state wrapper for the secret store implementation.
pub struct Secrets(pub std::sync::Arc<dyn SecretStore>);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SttKeyStatus {
    pub present: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    /// Which store the key came out of, so Settings can say which one is in
    /// play. A release build can only ever report `keychain` or `none`.
    pub source: KeySource,
}

fn key_missing() -> AppError {
    AppError::structured(
        "AUTH_KEY_INVALID",
        ErrorCategory::Auth,
        "Add your xAI API key in Settings first.",
        true,
    )
    .with_action(RecoveryAction::OpenSettings)
}

/// Validate a candidate key without storing it (spec §27.7). The candidate
/// exists transiently in this call only.
#[tauri::command]
pub async fn validate_stt_key(
    stt: State<'_, SttClient>,
    candidate_key: String,
) -> Result<KeyValidationResult, AppError> {
    let key = SecretString::new(candidate_key.trim().to_string());
    if key.expose().is_empty() {
        return Err(AppError::invalid_input("Paste an API key first."));
    }
    Ok(stt.validate_key(&key).await)
}

/// One-shot key intake: validate then persist to the OS keychain. The key
/// never returns to JavaScript; only redacted metadata does.
#[tauri::command]
pub async fn save_stt_key(
    stt: State<'_, SttClient>,
    secrets: State<'_, Secrets>,
    candidate_key: String,
) -> Result<RedactedSecretMetadata, AppError> {
    // Refused before the key is even looked at, because in a debug build the
    // `GROK_API_KEY` override — from the environment or from the checkout's
    // `.env` — is read ahead of the credential store: a key saved now would be
    // written successfully and then shadowed on every subsequent read. Settings
    // would report "Connected" and show the tail of the key just typed while a
    // different key billed the account — a lie that survives restarts. Refusing
    // is the only outcome that cannot mislead. Release builds never reach this
    // branch; `dev_env_key_active` is compiled to `false` there.
    if dev_env_key_active() {
        return Err(AppError::invalid_input(format!(
            "{DEV_KEY_ENV_VAR} is already supplying a key to this development build, from the \
             environment or from the project's .env file, and it takes precedence over the stored \
             key — so saving one here would have no effect. Remove it from both and restart \
             CandidCue to store a key in the credential store."
        )));
    }
    let key = SecretString::new(candidate_key.trim().to_string());
    if key.expose().is_empty() {
        return Err(AppError::invalid_input("Paste an API key first."));
    }
    let validation = stt.validate_key(&key).await;
    match validation.status.as_str() {
        "invalid" => {
            return Err(AppError::structured(
                "AUTH_KEY_INVALID",
                ErrorCategory::Auth,
                // The provider's own sentence when there is one: a key that is
                // valid but belongs to an unfunded team reports "your team
                // doesn't have any credits yet", and telling somebody that is
                // the difference between a fix and a wild goose chase.
                validation
                    .message
                    .clone()
                    .unwrap_or_else(|| "xAI rejected this API key.".to_string()),
                true,
            ));
        }
        "network_error" => {
            return Err(AppError::structured(
                "NETWORK_OFFLINE",
                ErrorCategory::Network,
                "CandidCue could not reach xAI to verify the key.",
                true,
            )
            .with_action(RecoveryAction::Retry));
        }
        // `quota` and `provider_error` still represent a real key; the UI
        // surfaces the validation result separately rather than refusing a key
        // that will work again once the account does.
        _ => {}
    }
    secrets.0.set_stt_key(key).await?;
    secrets
        .0
        .describe_stt_key()
        .await?
        .ok_or_else(|| AppError::Internal("key vanished immediately after save".into()))
}

/// Redacted facts about the key currently in play, including which store it
/// came from. The value is never part of this — only its last four characters
/// and its provenance.
#[tauri::command]
pub async fn get_stt_key_status(secrets: State<'_, Secrets>) -> Result<SttKeyStatus, AppError> {
    Ok(match secrets.0.describe_stt_key().await? {
        Some(described) => SttKeyStatus {
            present: true,
            hint: Some(described.hint),
            source: described.source,
        },
        None => SttKeyStatus {
            present: false,
            hint: None,
            source: KeySource::Absent,
        },
    })
}

/// Remove the stored key. Deliberately *not* refused while the debug-only
/// environment override is set: unlike a save, a delete has a real and complete
/// effect on the only store this app owns, and the key that remains afterwards
/// is reported as `source: "environment"` rather than being passed off as
/// stored. The caller re-reads the status and tells the operator what is left.
#[tauri::command]
pub async fn delete_stt_key(secrets: State<'_, Secrets>) -> Result<(), AppError> {
    secrets.0.delete_stt_key().await
}

/// What the renderer may choose about a session.
///
/// Deliberately small: the sample rate and encoding are pinned app-wide and
/// the streaming endpoint takes no model, so the only real choices are language
/// and the script to draw a vocabulary from.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionOptions {
    pub language: Option<String>,
    /// The take's spoken tokens, in the app compiler's AUTHORED spelling.
    ///
    /// The renderer sends the script, not the vocabulary. Which words are
    /// unusual is a lexical judgement, and lexical judgement belongs to
    /// `cc_align` — the same crate that decides what an anchor is and which
    /// words are cheap to mismatch. A second opinion about rare words, living
    /// in TypeScript and drifting from the first, is precisely the failure the
    /// alignment core is organised to prevent (see `script.rs`: "there is no
    /// second stopword list anywhere downstream").
    ///
    /// It is also why this reuses `AlignToken` rather than inventing a shape:
    /// the renderer already builds exactly this list for `start_alignment`, so
    /// there is nothing new to construct and nothing new to keep in step.
    pub vocabulary: Option<Vec<crate::align::AlignToken>>,
}

/// The bias terms for a take, from the tokens the renderer sent.
///
/// Failure here is never a failure of the take. A script that yields no terms —
/// or one whose every term is unsendable — simply opens the socket the way it
/// always did, which is the same outcome as not having this feature at all.
fn vocabulary_terms(tokens: &[crate::align::AlignToken]) -> Vec<String> {
    let view: Vec<cc_align::VocabToken<'_>> = tokens
        .iter()
        .map(|token| cc_align::VocabToken {
            surface: &token.surface,
            // The app's `line` IS its sentence ordinal (see `alignment.ts`),
            // which is the field this needs: a capital only means "name" when
            // a sentence did not just start.
            sentence: token.line,
        })
        .collect();
    cc_align::extract_terms(&view, cc_align::VocabLimits::default())
}

/// Open a live transcription session and return its generation.
///
/// Every subsequent `push_transcription_audio` and every event the session
/// emits carries this generation. It is what keeps a frame captured before a
/// take ended out of the next take's audio.
#[tauri::command]
pub async fn start_transcription<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    stt: State<'_, SttClient>,
    secrets: State<'_, Secrets>,
    options: Option<TranscriptionOptions>,
) -> Result<u64, AppError> {
    let key = secrets.0.get_stt_key().await?.ok_or_else(key_missing)?;
    let options = options.unwrap_or_default();
    let config = SttConfig {
        // Narrowed, never forwarded verbatim: the stored value is BCP-47
        // because that is what the picker offers, and the service rejects the
        // regional form. An empty or unparseable value falls back rather than
        // opening a socket that will be refused.
        language: match primary_subtag(options.language.as_deref().unwrap_or_default()).as_str() {
            "" => DEFAULT_LANGUAGE.to_string(),
            narrowed => narrowed.to_string(),
        },
        keyterms: options
            .vocabulary
            .as_deref()
            .map_or_else(Vec::new, vocabulary_terms),
        ..SttConfig::default()
    };
    Ok(stt.start_stream(app, key, config))
}

/// Forward one frame of PCM16 audio, base64-encoded.
///
/// Base64 rather than a byte array because the IPC bridge round-trips JSON: at
/// 100 ms per frame this is ~6 KB ten times a second, which is nothing, and it
/// avoids a second encoding of the same samples. It is decoded here and handed
/// to the socket as raw binary — the provider takes bytes, not base64.
#[tauri::command]
pub async fn push_transcription_audio(
    stt: State<'_, SttClient>,
    generation: u64,
    chunk: String,
) -> Result<(), AppError> {
    stt.push_audio(generation, decode_base64(&chunk)?)
}

/// End the session, giving the last utterance a chance to finalize.
#[tauri::command]
pub async fn stop_transcription(
    stt: State<'_, SttClient>,
    generation: u64,
) -> Result<(), AppError> {
    stt.stop_stream(generation);
    Ok(())
}

/// Check the key that is already stored, without ever exposing it.
///
/// Settings needs a "does this still work" answer, and the stored key cannot
/// leave Rust, so the round-trip happens here. The distinction from
/// [`validate_stt_key`] matters: that one judges a candidate the user has just
/// typed, this one judges the key the app would actually present — the
/// difference between a typo and a key that was revoked last week.
#[tauri::command]
pub async fn test_stt_key(
    stt: State<'_, SttClient>,
    secrets: State<'_, Secrets>,
) -> Result<KeyValidationResult, AppError> {
    let key = secrets.0.get_stt_key().await?.ok_or_else(key_missing)?;
    Ok(stt.validate_key(&key).await)
}
