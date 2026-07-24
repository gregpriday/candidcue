//! Secret and OpenAI commands (spec §46.4, §27).
//!
//! The candidate key enters Rust exactly once through `save_openai_key` /
//! `validate_openai_key` and is never echoed back, logged, or stored outside
//! the OS credential store.

use serde::Serialize;
use tauri::State;

use crate::errors::{AppError, ErrorCategory, RecoveryAction};
use crate::openai::luna_ops::{
    self, LunaCommandRequest, LunaRawResult, VocabularyAnalysis, VocabularyRequest,
};
use crate::openai::responses::{build_structured_body, build_tool_body};
use crate::openai::semantic::{
    self, SemanticAssistResult, SemanticClassificationRequest, SemanticLandmarkPreparationResult,
    SemanticLandmarkRetrievalResult, SemanticOperationResponse, SemanticPreparationRequest,
    SemanticRetrievalRequest,
};
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

// ---------------------------------------------------------------------------
// Luna semantic sidecar (companion §50.2)
// ---------------------------------------------------------------------------
//
// Every operation below:
//   * sends `store: false` and never logs the request body (§57);
//   * is bounded by an explicit timeout and cancellable by `requestId` (§36.5);
//   * validates the response against the strict schema and the request
//     identity before returning (Appendix C.4);
//   * returns usage + prompt-cache metadata for local cost accounting (§42).
//
// Invoke argument names are camelCase: `{ request: … }` / `{ requestId: … }`.

/// Annotate a prepared section's spans for later semantic landmark retrieval
/// (companion §39.3). Offline/preparation operation — not on the live path.
#[tauri::command]
pub async fn prepare_semantic_landmarks(
    openai: State<'_, OpenAiClient>,
    secrets: State<'_, Secrets>,
    request: SemanticPreparationRequest,
) -> Result<SemanticOperationResponse<SemanticLandmarkPreparationResult>, AppError> {
    let key = secrets.0.get_openai_key().await?.ok_or_else(key_missing)?;
    let model = openai.require_semantic_model()?.to_string();
    let spec = semantic::structured_spec(
        &model,
        semantic::PREPARE_INSTRUCTION,
        "semantic_landmark_preparation_result",
        semantic::preparation_schema(),
        request.payload.clone(),
        &request.options,
        4_096,
    );
    let (envelope, latency_ms) = openai
        .execute_responses(
            &key,
            "prepare_semantic_landmarks",
            &request.request_id,
            build_structured_body(&spec),
            semantic::timeout_for(&request.options),
        )
        .await?;
    let result: SemanticLandmarkPreparationResult = semantic::parse_structured(&envelope)?;
    semantic::validate_preparation(&result, &request)?;
    Ok(semantic::operation_response(
        result,
        &envelope,
        latency_ms,
        &model,
        spec.prompt_cache_key.clone(),
    ))
}

/// Landmark-assisted current-section recovery (companion §37.2). The result
/// only opens exact candidate windows — it never moves the cursor (§37.3).
#[tauri::command]
pub async fn retrieve_semantic_landmarks(
    openai: State<'_, OpenAiClient>,
    secrets: State<'_, Secrets>,
    request: SemanticRetrievalRequest,
) -> Result<SemanticOperationResponse<SemanticLandmarkRetrievalResult>, AppError> {
    let key = secrets.0.get_openai_key().await?.ok_or_else(key_missing)?;
    let model = openai.require_semantic_model()?.to_string();
    let spec = semantic::structured_spec(
        &model,
        semantic::RETRIEVE_INSTRUCTION,
        "semantic_landmark_retrieval_result",
        semantic::retrieval_schema(),
        request.payload.clone(),
        &request.options,
        256,
    );
    let (envelope, latency_ms) = openai
        .execute_responses(
            &key,
            "retrieve_semantic_landmarks",
            &request.request_id,
            build_structured_body(&spec),
            semantic::timeout_for(&request.options),
        )
        .await?;
    let result: SemanticLandmarkRetrievalResult = semantic::parse_structured(&envelope)?;
    semantic::validate_retrieval(&result, &request)?;
    Ok(semantic::operation_response(
        result,
        &envelope,
        latency_ms,
        &model,
        spec.prompt_cache_key.clone(),
    ))
}

/// Ordinary candidate classification (companion §37.1, §39). Ranks only the
/// candidate spans the local aligner supplied.
#[tauri::command]
pub async fn classify_semantic_tracking_window(
    openai: State<'_, OpenAiClient>,
    secrets: State<'_, Secrets>,
    request: SemanticClassificationRequest,
) -> Result<SemanticOperationResponse<SemanticAssistResult>, AppError> {
    let key = secrets.0.get_openai_key().await?.ok_or_else(key_missing)?;
    let model = openai.require_semantic_model()?.to_string();
    let spec = semantic::structured_spec(
        &model,
        semantic::CLASSIFY_INSTRUCTION,
        "semantic_assist_result",
        semantic::classification_schema(),
        request.payload.clone(),
        &request.options,
        320,
    );
    let (envelope, latency_ms) = openai
        .execute_responses(
            &key,
            "classify_semantic_tracking_window",
            &request.request_id,
            build_structured_body(&spec),
            semantic::timeout_for(&request.options),
        )
        .await?;
    let result: SemanticAssistResult = semantic::parse_structured(&envelope)?;
    semantic::validate_classification(&result, &request)?;
    Ok(semantic::operation_response(
        result,
        &envelope,
        latency_ms,
        &model,
        spec.prompt_cache_key.clone(),
    ))
}

/// Best-effort cancellation of an in-flight semantic request (companion
/// §36.5). Returns whether a matching request was registered. Pass no id to
/// cancel every in-flight request (session end / script change).
#[tauri::command]
pub fn cancel_semantic_request(
    openai: State<'_, OpenAiClient>,
    request_id: Option<String>,
) -> bool {
    match request_id {
        Some(id) => openai.cancel_semantic_request(&id),
        None => openai.cancel_all_semantic_requests() > 0,
    }
}

/// Luna command interpretation (primary Appendix E.5). A single forced,
/// strict `control_candidcue` tool call over a bounded target list. The
/// frontend re-validates the result against the live document (§33.8).
#[tauri::command]
pub async fn interpret_command(
    openai: State<'_, OpenAiClient>,
    secrets: State<'_, Secrets>,
    request: LunaCommandRequest,
) -> Result<LunaRawResult, AppError> {
    let key = secrets.0.get_openai_key().await?.ok_or_else(key_missing)?;
    if !openai.capabilities().command_structured_outputs {
        return Err(AppError::structured(
            "AUTH_MODEL_UNAVAILABLE",
            ErrorCategory::Auth,
            "Voice command interpretation is unavailable for the configured model.",
            true,
        )
        .with_action(RecoveryAction::UseManualMode));
    }
    let model = openai.capabilities().command_model.clone();
    let spec = luna_ops::build_command_spec(&model, &request);
    let function_name = spec.function_name.clone();
    let timeout = semantic::timeout_for(&request.options);
    let (envelope, _latency_ms) = openai
        .execute_responses(
            &key,
            "interpret_command",
            &request.candidate_id,
            build_tool_body(&spec),
            timeout,
        )
        .await?;
    luna_ops::parse_command_result(&envelope, &function_name)
}

/// Luna vocabulary analysis (primary Appendix E.6, §26.5). Candidate terms
/// plus brief context only — never the whole script.
#[tauri::command]
pub async fn analyze_vocabulary(
    openai: State<'_, OpenAiClient>,
    secrets: State<'_, Secrets>,
    request: VocabularyRequest,
) -> Result<VocabularyAnalysis, AppError> {
    if request.candidates.is_empty() {
        return Ok(VocabularyAnalysis { terms: Vec::new() });
    }
    let key = secrets.0.get_openai_key().await?.ok_or_else(key_missing)?;
    let model = openai.require_semantic_model()?.to_string();
    let payload = luna_ops::build_vocabulary_payload(&request);
    let spec = semantic::structured_spec(
        &model,
        luna_ops::VOCABULARY_INSTRUCTION,
        "vocabulary_analysis",
        luna_ops::vocabulary_schema(),
        payload,
        &request.options,
        4_096,
    );
    let request_id = format!("vocab_{}", uuid::Uuid::new_v4());
    let (envelope, _latency_ms) = openai
        .execute_responses(
            &key,
            "analyze_vocabulary",
            &request_id,
            build_structured_body(&spec),
            std::time::Duration::from_millis(
                request.options.timeout_ms.unwrap_or(60_000).clamp(1_000, 120_000),
            ),
        )
        .await?;
    let analysis: VocabularyAnalysis = semantic::parse_structured(&envelope)?;
    luna_ops::validate_vocabulary(analysis, &request)
}
