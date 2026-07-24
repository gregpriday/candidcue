//! Secret and OpenAI commands (spec §46.4, §27).
//!
//! The candidate key enters Rust exactly once through `save_openai_key` /
//! `validate_openai_key` and is never echoed back, logged, or stored outside
//! the OS credential store.

use serde::Serialize;
use tauri::State;

use crate::errors::{AppError, ErrorCategory, RecoveryAction};
use crate::openai::{
    EphemeralCredential, KeyValidationResult, ModelCapabilities, OpenAiClient,
    TranscriptionCredentialConfig,
};
use crate::secrets::{RedactedSecretMetadata, SecretStore, SecretString};

/// Managed state wrapper for the secret store implementation.
pub struct Secrets(pub std::sync::Arc<dyn SecretStore>);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiKeyStatus {
    pub present: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

fn key_missing() -> AppError {
    AppError::structured(
        "AUTH_KEY_INVALID",
        ErrorCategory::Auth,
        "Add your OpenAI API key in Settings first.",
        true,
    )
    .with_action(RecoveryAction::OpenSettings)
}

/// Validate a candidate key without storing it (spec §27.7). The candidate
/// exists transiently in this call only.
#[tauri::command]
pub async fn validate_openai_key(
    openai: State<'_, OpenAiClient>,
    candidate_key: String,
) -> Result<KeyValidationResult, AppError> {
    let key = SecretString::new(candidate_key.trim().to_string());
    if key.expose().is_empty() {
        return Err(AppError::invalid_input("Paste an API key first."));
    }
    Ok(openai.validate_key(&key).await)
}

/// One-shot key intake: validate then persist to the OS keychain. The key
/// never returns to JavaScript; only redacted metadata does.
#[tauri::command]
pub async fn save_openai_key(
    openai: State<'_, OpenAiClient>,
    secrets: State<'_, Secrets>,
    candidate_key: String,
) -> Result<RedactedSecretMetadata, AppError> {
    let key = SecretString::new(candidate_key.trim().to_string());
    if key.expose().is_empty() {
        return Err(AppError::invalid_input("Paste an API key first."));
    }
    let validation = openai.validate_key(&key).await;
    match validation.status.as_str() {
        "invalid" => {
            return Err(AppError::structured(
                "AUTH_KEY_INVALID",
                ErrorCategory::Auth,
                "OpenAI rejected this API key.",
                true,
            ));
        }
        "network_error" => {
            return Err(AppError::structured(
                "NETWORK_OFFLINE",
                ErrorCategory::Network,
                "CandidCue could not reach OpenAI to verify the key.",
                true,
            )
            .with_action(RecoveryAction::Retry));
        }
        // valid_* and quota/provider states still represent a real key; the
        // UI surfaces the validation result separately.
        _ => {}
    }
    secrets.0.set_openai_key(key).await?;
    secrets
        .0
        .describe_openai_key()
        .await?
        .ok_or_else(|| AppError::Internal("key vanished immediately after save".into()))
}

#[tauri::command]
pub async fn get_openai_key_status(
    secrets: State<'_, Secrets>,
) -> Result<OpenAiKeyStatus, AppError> {
    let described = secrets.0.describe_openai_key().await?;
    Ok(OpenAiKeyStatus {
        present: described.is_some(),
        hint: described.map(|d| d.hint),
    })
}

#[tauri::command]
pub async fn delete_openai_key(secrets: State<'_, Secrets>) -> Result<(), AppError> {
    secrets.0.delete_openai_key().await
}

/// Mint a short-lived Realtime transcription client secret (Appendix E.1).
#[tauri::command]
pub async fn create_realtime_transcription_credential(
    openai: State<'_, OpenAiClient>,
    secrets: State<'_, Secrets>,
    config: Option<TranscriptionCredentialConfig>,
) -> Result<EphemeralCredential, AppError> {
    let key = secrets.0.get_openai_key().await?.ok_or_else(key_missing)?;
    openai
        .create_transcription_credential(
            &key,
            config.unwrap_or(TranscriptionCredentialConfig {
                model: None,
                language: None,
                delay: None,
                expires_seconds: None,
                request_logprobs: None,
            }),
        )
        .await
}

#[tauri::command]
pub fn get_model_capabilities(openai: State<'_, OpenAiClient>) -> ModelCapabilities {
    openai.capabilities().clone()
}

/// Luna command interpretation (spec §27.1 op 2). Not wired in v1: the
/// deterministic parser handles commands; Luna fallback ships later.
#[tauri::command]
pub async fn interpret_command(
    _request: serde_json::Value,
) -> Result<serde_json::Value, AppError> {
    Err(AppError::not_implemented("Luna command interpretation"))
}

/// Luna vocabulary analysis (spec §27.1 op 3). Not wired in v1.
#[tauri::command]
pub async fn analyze_vocabulary(
    _request: serde_json::Value,
) -> Result<serde_json::Value, AppError> {
    Err(AppError::not_implemented("Vocabulary analysis"))
}
