//! OpenAI REST client (spec §44.7, §27.6–27.8, Appendix E.1/E.7).
//!
//! Rust owns the only authenticated client. The permanent key never crosses
//! IPC; the webview receives only short-lived Realtime client secrets and
//! bounded operation results. No request bodies or authorization headers are
//! ever logged.

use serde::{Deserialize, Serialize};

use crate::errors::{AppError, ErrorCategory, RecoveryAction};
use crate::secrets::SecretString;

pub mod luna_ops;
pub mod responses;
pub mod semantic;

pub use responses::{LunaUsage, PromptCacheMetadata};

/// Default live transcription model (non-negotiable decision 5).
pub const DEFAULT_TRANSCRIPTION_MODEL: &str = "gpt-realtime-whisper";
/// Command interpretation model for ambiguous natural-language commands.
pub const DEFAULT_COMMAND_MODEL: &str = "gpt-5.6-luna";
/// Semantic sidecar model (companion §38). Same family as the command model
/// but registered separately so either can move independently.
pub const DEFAULT_SEMANTIC_MODEL: &str = "gpt-5.6-luna";

pub const API_BASE_URL: &str = "https://api.openai.com/v1";

const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
/// Response size cap (spec §27.6 response-size limits).
const MAX_RESPONSE_BYTES: u64 = 2 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Model capability registry (spec §27.8)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCapabilities {
    pub realtime_model: String,
    pub command_model: String,
    /// Whether `realtime_model` accepts a vocabulary `prompt` on the
    /// transcription session (spec §26.1). This is the one assumption §26.1
    /// requires to be isolated behind capability metadata, and the control
    /// window's `supportsVocabularyPrompt` is the only gate on sending one.
    pub realtime_prompt_steering: bool,
    pub realtime_logprobs: bool,
    pub supported_delay_levels: Vec<String>,
    pub supports_client_secret_for_transcription: bool,
    pub command_structured_outputs: bool,
    // ---- Luna semantic sidecar (companion §38, §41, §42.2) ----
    pub semantic_model: String,
    pub semantic_structured_outputs: bool,
    /// Reasoning efforts permitted for continuous classification (§38.1).
    pub semantic_reasoning_efforts: Vec<String>,
    pub semantic_default_reasoning_effort: String,
    pub semantic_supports_prompt_cache_key: bool,
    /// Automatic prompt caching threshold in tokens; prefixes shorter than
    /// this are never cache-eligible, so do not pad to reach it (§41).
    pub prompt_cache_min_tokens: u32,
    pub semantic_default_max_output_tokens: u32,
    pub semantic_default_timeout_ms: u64,
    /// USD per million tokens. `None` until a verified price is configured —
    /// §42.2 forbids hard-coding a permanent currency estimate.
    ///
    /// Configured through the environment (see
    /// [`ModelCapabilities::from_environment`]), never defaulted: this is a
    /// bring-your-own-key product, so an invented rate is an invented bill.
    /// While these stay `None` the control window reports Luna spend as
    /// "no rate configured" rather than as `$0.00`.
    pub semantic_input_price_per_mtok: Option<f64>,
    pub semantic_cached_input_price_per_mtok: Option<f64>,
    pub semantic_output_price_per_mtok: Option<f64>,
    pub registry_version: u32,
}

/// Environment variables carrying verified per-million-token prices (§42.2).
pub const SEMANTIC_INPUT_PRICE_ENV: &str = "CANDIDCUE_SEMANTIC_INPUT_PRICE_PER_MTOK";
pub const SEMANTIC_CACHED_INPUT_PRICE_ENV: &str =
    "CANDIDCUE_SEMANTIC_CACHED_INPUT_PRICE_PER_MTOK";
pub const SEMANTIC_OUTPUT_PRICE_ENV: &str = "CANDIDCUE_SEMANTIC_OUTPUT_PRICE_PER_MTOK";

/// Parse a configured price.
///
/// Anything that is not a finite, non-negative number is rejected rather than
/// coerced: a typo that silently becomes `0` would make the cost readout claim
/// the sidecar is free, which is the exact failure §42.2 exists to prevent.
/// A rejected value leaves the price `None`, and the UI then says the rate is
/// unknown.
pub fn parse_price_per_mtok(raw: &str) -> Option<f64> {
    let value: f64 = raw.trim().parse().ok()?;
    if value.is_finite() && value >= 0.0 {
        Some(value)
    } else {
        None
    }
}

fn price_from_env(key: &str) -> Option<f64> {
    parse_price_per_mtok(&std::env::var(key).ok()?)
}

impl ModelCapabilities {
    /// The registry with any operator-configured semantic prices applied.
    ///
    /// The prices are the one part of the registry that cannot be shipped as a
    /// constant — they change on the provider's schedule, not ours — so they
    /// are read from the environment at client construction. Unset or invalid
    /// leaves them `None`, which is a reportable state, not a zero.
    pub fn from_environment() -> Self {
        Self {
            semantic_input_price_per_mtok: price_from_env(SEMANTIC_INPUT_PRICE_ENV),
            semantic_cached_input_price_per_mtok: price_from_env(SEMANTIC_CACHED_INPUT_PRICE_ENV),
            semantic_output_price_per_mtok: price_from_env(SEMANTIC_OUTPUT_PRICE_ENV),
            ..Self::default()
        }
    }
}

impl Default for ModelCapabilities {
    fn default() -> Self {
        Self {
            realtime_model: DEFAULT_TRANSCRIPTION_MODEL.into(),
            command_model: DEFAULT_COMMAND_MODEL.into(),
            // §26.1, verbatim: "CandidCue must not assume that the primary
            // `gpt-realtime-whisper` session can accept a custom prompt or
            // dictionary. In the current Realtime transcription interface,
            // this model does not provide prompt steering." The registry
            // claimed the opposite while nothing read it, so the claim was
            // free; now that the control window gates on it, `true` here would
            // put an unsupported field in every `session.update` — a change to
            // the live transcription path that no evidence supports. Flip it
            // only alongside a verified model that accepts one.
            realtime_prompt_steering: false,
            realtime_logprobs: true,
            supported_delay_levels: vec![
                "minimal".into(),
                "low".into(),
                "medium".into(),
                "high".into(),
            ],
            supports_client_secret_for_transcription: true,
            command_structured_outputs: true,
            semantic_model: DEFAULT_SEMANTIC_MODEL.into(),
            semantic_structured_outputs: true,
            semantic_reasoning_efforts: vec!["none".into(), "minimal".into(), "low".into()],
            semantic_default_reasoning_effort: "low".into(),
            semantic_supports_prompt_cache_key: true,
            prompt_cache_min_tokens: 1024,
            semantic_default_max_output_tokens: 320,
            semantic_default_timeout_ms: responses::DEFAULT_SEMANTIC_TIMEOUT_MS,
            semantic_input_price_per_mtok: None,
            semantic_cached_input_price_per_mtok: None,
            semantic_output_price_per_mtok: None,
            registry_version: 2,
        }
    }
}

// ---------------------------------------------------------------------------
// Contract twins
// ---------------------------------------------------------------------------

/// Result of key validation (spec §27.7). Status strings are stable:
/// `valid_ready`, `valid_realtime_unavailable`, `valid_model_unavailable`,
/// `quota_exhausted`, `invalid`, `network_error`, `provider_error`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyValidationResult {
    pub status: String,
    pub realtime_model_available: bool,
    pub command_model_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Twin of `EphemeralCredential` (src/shared/contracts/audio.ts).
///
/// C1: the expiry crosses the IPC boundary as epoch **milliseconds** and the
/// unit is in the field name. The provider reports epoch seconds; the webview
/// compares against `Date.now()`, which is milliseconds. Forwarding the raw
/// provider value made every real credential compare as already-expired, so
/// the app rejected its own freshly minted secret and never transcribed.
/// Normalization happens here, at the trust boundary, exactly once.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EphemeralCredential {
    pub value: String,
    /// Unix epoch **milliseconds** (normalized from the provider's seconds).
    pub expires_at_epoch_ms: i64,
    pub session_type: String,
    pub credential_generation: u64,
}

/// Smallest plausible epoch-millisecond value (2001-09-09). Any provider
/// timestamp below this is a seconds-shaped value that must be scaled up.
const MIN_PLAUSIBLE_EPOCH_MS: i64 = 1_000_000_000_000;

/// Normalize a provider expiry timestamp to epoch milliseconds.
///
/// OpenAI documents `expires_at` as Unix epoch **seconds**, so the common path
/// is a plain `* 1000`. The magnitude check is a deliberate belt-and-braces: if
/// the provider ever starts emitting milliseconds, we must not multiply again
/// and hand the webview a credential that never appears to expire.
pub fn normalize_expiry_to_epoch_ms(provider_expires_at: i64) -> i64 {
    if provider_expires_at >= MIN_PLAUSIBLE_EPOCH_MS {
        provider_expires_at
    } else {
        provider_expires_at.saturating_mul(1000)
    }
}

/// Request config for minting a transcription credential (spec E.1).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionCredentialConfig {
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    /// 'minimal' | 'low' | 'medium' | 'high'.
    #[serde(default)]
    pub delay: Option<String>,
    #[serde(default)]
    pub expires_seconds: Option<u32>,
    #[serde(default)]
    pub request_logprobs: Option<bool>,
}

// ---------------------------------------------------------------------------
// Typed request bodies (Appendix E.1)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct ClientSecretRequest {
    expires_after: ExpiresAfter,
    session: SessionSpec,
}

#[derive(Serialize)]
struct ExpiresAfter {
    anchor: &'static str,
    seconds: u32,
}

#[derive(Serialize)]
struct SessionSpec {
    #[serde(rename = "type")]
    session_type: &'static str,
    audio: AudioSpec,
    #[serde(skip_serializing_if = "Option::is_none")]
    include: Option<Vec<&'static str>>,
}

#[derive(Serialize)]
struct AudioSpec {
    input: AudioInputSpec,
}

#[derive(Serialize)]
struct AudioInputSpec {
    transcription: TranscriptionSpec,
    turn_detection: Option<serde_json::Value>,
}

#[derive(Serialize)]
struct TranscriptionSpec {
    model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    delay: Option<String>,
}

#[derive(Deserialize)]
struct ClientSecretResponse {
    value: String,
    expires_at: i64,
}

#[derive(Deserialize)]
struct ModelsResponse {
    #[serde(default)]
    data: Vec<ModelEntry>,
}

#[derive(Deserialize)]
struct ModelEntry {
    id: String,
}

#[derive(Deserialize)]
struct ProviderErrorEnvelope {
    #[serde(default)]
    error: Option<ProviderErrorBody>,
}

#[derive(Deserialize, Default)]
struct ProviderErrorBody {
    #[serde(default)]
    code: Option<String>,
    #[serde(default, rename = "type")]
    error_type: Option<String>,
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

pub struct OpenAiClient {
    http: reqwest::Client,
    base_url: String,
    capabilities: ModelCapabilities,
    credential_generation: std::sync::atomic::AtomicU64,
    /// In-flight semantic request registry, keyed by caller request id
    /// (companion §36.5). Cancellation is best-effort; stale checks in the
    /// scheduler remain mandatory.
    inflight: std::sync::Mutex<
        std::collections::HashMap<String, tokio::sync::oneshot::Sender<()>>,
    >,
}

impl OpenAiClient {
    pub fn new() -> Self {
        Self::with_base_url(API_BASE_URL.to_string())
    }

    /// Injectable base URL for the test mock server adapter (spec §27.6).
    pub fn with_base_url(base_url: String) -> Self {
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .connect_timeout(std::time::Duration::from_secs(10))
            .build()
            .expect("reqwest client construction cannot fail with static config");
        Self {
            http,
            base_url,
            capabilities: ModelCapabilities::from_environment(),
            credential_generation: std::sync::atomic::AtomicU64::new(0),
            inflight: std::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }

    /// Model capability gate for the semantic sidecar (companion §50.2).
    /// Returns an error the caller can degrade on rather than panicking.
    pub fn require_semantic_model(&self) -> Result<&str, AppError> {
        if !self.capabilities.semantic_structured_outputs {
            return Err(AppError::structured(
                "AUTH_MODEL_UNAVAILABLE",
                ErrorCategory::Auth,
                "Semantic assist is unavailable for the configured model.",
                true,
            )
            .with_action(RecoveryAction::UseManualMode)
            .with_detail("semanticFailure", "model_unavailable"));
        }
        Ok(self.capabilities.semantic_model.as_str())
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }

    pub fn capabilities(&self) -> &ModelCapabilities {
        &self.capabilities
    }

    /// Least expensive practical authenticated request confirming access
    /// (spec §27.7): list models, then check required model availability.
    pub async fn validate_key(&self, key: &SecretString) -> KeyValidationResult {
        let url = format!("{}/models", self.base_url);
        let response = self
            .http
            .get(&url)
            .bearer_auth(key.expose())
            .send()
            .await;

        let response = match response {
            Ok(r) => r,
            Err(err) => {
                return KeyValidationResult {
                    status: "network_error".into(),
                    realtime_model_available: false,
                    command_model_available: false,
                    message: Some(if err.is_timeout() {
                        "The request to OpenAI timed out.".into()
                    } else {
                        "CandidCue could not reach OpenAI.".into()
                    }),
                };
            }
        };

        let status = response.status();
        if status.is_success() {
            let body = read_capped(response).await;
            let models: ModelsResponse = body
                .as_deref()
                .and_then(|b| serde_json::from_slice(b).ok())
                .unwrap_or(ModelsResponse { data: Vec::new() });
            let ids: std::collections::HashSet<&str> =
                models.data.iter().map(|m| m.id.as_str()).collect();
            let realtime = ids.contains(self.capabilities.realtime_model.as_str());
            let command = ids.contains(self.capabilities.command_model.as_str());
            let validation_status = if realtime && command {
                "valid_ready"
            } else if !realtime {
                "valid_realtime_unavailable"
            } else {
                "valid_model_unavailable"
            };
            return KeyValidationResult {
                status: validation_status.into(),
                realtime_model_available: realtime,
                command_model_available: command,
                message: None,
            };
        }

        let code = provider_error_code(read_capped(response).await.as_deref());
        let validation_status = match status.as_u16() {
            401 => "invalid",
            403 => "valid_model_unavailable",
            429 if code.as_deref() == Some("insufficient_quota") => "quota_exhausted",
            429 => "provider_error",
            500..=599 => "provider_error",
            _ => "provider_error",
        };
        KeyValidationResult {
            status: validation_status.into(),
            realtime_model_available: false,
            command_model_available: false,
            message: None,
        }
    }

    /// Mint a short-lived Realtime transcription client secret (Appendix
    /// E.1). Returns only `value`, `expires_at_epoch_ms`, and a local
    /// generation.
    pub async fn create_transcription_credential(
        &self,
        key: &SecretString,
        config: TranscriptionCredentialConfig,
    ) -> Result<EphemeralCredential, AppError> {
        let expires = config.expires_seconds.unwrap_or(600).clamp(60, 3600);
        let request_logprobs = config.request_logprobs.unwrap_or(true);
        let body = ClientSecretRequest {
            expires_after: ExpiresAfter {
                anchor: "created_at",
                seconds: expires,
            },
            session: SessionSpec {
                session_type: "transcription",
                audio: AudioSpec {
                    input: AudioInputSpec {
                        transcription: TranscriptionSpec {
                            model: config
                                .model
                                .unwrap_or_else(|| self.capabilities.realtime_model.clone()),
                            language: config.language.or_else(|| Some("en".into())),
                            delay: config.delay,
                        },
                        turn_detection: None,
                    },
                },
                include: request_logprobs
                    .then(|| vec!["item.input_audio_transcription.logprobs"]),
            },
        };

        let url = format!("{}/realtime/client_secrets", self.base_url);
        let response = self
            .http
            .post(&url)
            .bearer_auth(key.expose())
            .json(&body)
            .send()
            .await
            .map_err(map_transport_error)?;

        let status = response.status();
        if !status.is_success() {
            let error_body = read_capped(response).await;
            return Err(map_provider_status(status.as_u16(), error_body.as_deref()));
        }

        let bytes = read_capped(response)
            .await
            .ok_or_else(provider_malformed)?;
        let parsed: ClientSecretResponse =
            serde_json::from_slice(&bytes).map_err(|_| provider_malformed())?;
        let generation = self
            .credential_generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1;
        Ok(EphemeralCredential {
            value: parsed.value,
            // C1: provider seconds → epoch milliseconds at the boundary.
            expires_at_epoch_ms: normalize_expiry_to_epoch_ms(parsed.expires_at),
            session_type: "transcription".into(),
            credential_generation: generation,
        })
    }
}

impl Default for OpenAiClient {
    fn default() -> Self {
        Self::new()
    }
}

async fn read_capped(response: reqwest::Response) -> Option<Vec<u8>> {
    if let Some(len) = response.content_length() {
        if len > MAX_RESPONSE_BYTES {
            return None;
        }
    }
    match response.bytes().await {
        Ok(bytes) if bytes.len() as u64 <= MAX_RESPONSE_BYTES => Some(bytes.to_vec()),
        _ => None,
    }
}

fn provider_error_code(body: Option<&[u8]>) -> Option<String> {
    let envelope: ProviderErrorEnvelope = serde_json::from_slice(body?).ok()?;
    let error = envelope.error?;
    error.code.or(error.error_type)
}

fn provider_malformed() -> AppError {
    AppError::structured(
        "PROVIDER_UNAVAILABLE",
        ErrorCategory::Provider,
        "OpenAI returned an unexpected response.",
        true,
    )
    .with_action(RecoveryAction::Retry)
}

fn map_transport_error(err: reqwest::Error) -> AppError {
    if err.is_timeout() {
        AppError::structured(
            "NETWORK_TIMEOUT",
            ErrorCategory::Network,
            "The request to OpenAI timed out.",
            true,
        )
        .with_action(RecoveryAction::Retry)
    } else if err.is_connect() {
        AppError::structured(
            "NETWORK_OFFLINE",
            ErrorCategory::Network,
            "CandidCue could not reach OpenAI. Check your internet connection.",
            true,
        )
        .with_action(RecoveryAction::Reconnect)
    } else {
        AppError::structured(
            "PROVIDER_UNAVAILABLE",
            ErrorCategory::Provider,
            "The OpenAI request failed.",
            true,
        )
        .with_action(RecoveryAction::Retry)
        .with_log(format!("transport: {err}"))
    }
}

/// API failure mapping (Appendix E.7).
pub fn map_provider_status(status: u16, body: Option<&[u8]>) -> AppError {
    let code = provider_error_code(body);
    match status {
        401 => AppError::structured(
            "AUTH_KEY_INVALID",
            ErrorCategory::Auth,
            "Your OpenAI API key was rejected. Update it in Settings.",
            true,
        )
        .with_action(RecoveryAction::OpenSettings),
        403 => AppError::structured(
            "AUTH_MODEL_UNAVAILABLE",
            ErrorCategory::Auth,
            "Your OpenAI account does not have access to a required model.",
            true,
        )
        .with_action(RecoveryAction::UseManualMode),
        429 if code.as_deref() == Some("insufficient_quota") => AppError::structured(
            "QUOTA_EXHAUSTED",
            ErrorCategory::Quota,
            "Your OpenAI account is out of quota or has a billing issue.",
            true,
        )
        .with_action(RecoveryAction::OpenSettings),
        429 => AppError::structured(
            "RATE_LIMITED",
            ErrorCategory::Quota,
            "OpenAI is rate limiting requests. Try again shortly.",
            true,
        )
        .with_action(RecoveryAction::Retry),
        500..=599 => AppError::structured(
            "PROVIDER_UNAVAILABLE",
            ErrorCategory::Provider,
            "OpenAI is having trouble right now. Try again shortly.",
            true,
        )
        .with_action(RecoveryAction::Retry),
        other => AppError::structured(
            "PROVIDER_UNAVAILABLE",
            ErrorCategory::Provider,
            "The OpenAI request failed.",
            true,
        )
        .with_action(RecoveryAction::Retry)
        .with_detail("httpStatus", other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// §42.2: the registry must never invent a currency rate, and a bad one
    /// must not degrade into a confident zero.
    #[test]
    fn semantic_prices_are_absent_unless_validly_configured() {
        assert_eq!(ModelCapabilities::default().semantic_input_price_per_mtok, None);
        assert_eq!(parse_price_per_mtok("2.50"), Some(2.5));
        assert_eq!(parse_price_per_mtok("  0.30  "), Some(0.3));
        // Zero is a legitimate configured rate (a free tier); it is only a lie
        // when it is the *default*, which the assertion above pins.
        assert_eq!(parse_price_per_mtok("0"), Some(0.0));
        assert_eq!(parse_price_per_mtok("-1"), None);
        assert_eq!(parse_price_per_mtok("free"), None);
        assert_eq!(parse_price_per_mtok(""), None);
        assert_eq!(parse_price_per_mtok("NaN"), None);
        assert_eq!(parse_price_per_mtok("inf"), None);
    }

    #[test]
    fn maps_provider_failures_per_e7() {
        assert_eq!(map_provider_status(401, None).code(), "AUTH_KEY_INVALID");
        assert_eq!(map_provider_status(403, None).code(), "AUTH_MODEL_UNAVAILABLE");
        let quota_body = br#"{"error":{"code":"insufficient_quota"}}"#;
        assert_eq!(
            map_provider_status(429, Some(quota_body)).code(),
            "QUOTA_EXHAUSTED"
        );
        assert_eq!(map_provider_status(429, None).code(), "RATE_LIMITED");
        assert_eq!(map_provider_status(503, None).code(), "PROVIDER_UNAVAILABLE");
    }
}
