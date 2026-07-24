//! Application error model (spec §44.12, Appendix C.7).
//!
//! Every Rust error exposed through IPC serializes into the stable
//! `AppError` payload shape the frontend contracts expect
//! (`src/shared/contracts/errors.ts`). Raw Rust debug strings and provider
//! response bodies are never used as user-facing copy.

use serde::Serialize;

/// Serialized payload matching the `AppError` TypeScript contract.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppErrorPayload {
    pub code: String,
    pub category: ErrorCategory,
    pub user_message: String,
    pub recoverable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<RecoveryAction>,
    pub correlation_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCategory {
    Validation,
    Permission,
    Network,
    Auth,
    Quota,
    Storage,
    Database,
    Media,
    Window,
    Provider,
    Internal,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryAction {
    Retry,
    OpenSettings,
    ChooseDevice,
    Reconnect,
    RevealFolder,
    UseManualMode,
    ContactSupport,
}

/// Internal error enum. Variants carry sources for logging/diagnostics only;
/// the IPC boundary sees the redacted [`AppErrorPayload`].
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("validation failed: {0}")]
    Validation(String),

    #[error("storage error: {0}")]
    Storage(#[from] std::io::Error),

    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),

    #[error("database migration failed: {0}")]
    Migration(#[from] sqlx::migrate::MigrateError),

    #[error("secret store error: {0}")]
    SecretStore(#[from] keyring::Error),

    #[error("network error: {0}")]
    Network(#[from] reqwest::Error),

    #[error("window error: {0}")]
    Window(#[from] tauri::Error),

    #[error("stage display missing")]
    StageDisplayMissing,

    #[error("internal error: {0}")]
    Internal(String),
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            AppError::Validation(_) => "IMPORT_INVALID_FORMAT",
            AppError::Storage(_) => "SCRIPT_SAVE_FAILED",
            AppError::Database(_) => "DATABASE_INTEGRITY_FAILED",
            AppError::Migration(_) => "DATABASE_MIGRATION_FAILED",
            AppError::SecretStore(_) => "AUTH_KEY_INVALID",
            AppError::Network(_) => "NETWORK_TIMEOUT",
            AppError::Window(_) => "STAGE_OPEN_FAILED",
            AppError::StageDisplayMissing => "STAGE_DISPLAY_MISSING",
            AppError::Internal(_) => "INTERNAL_UNEXPECTED",
        }
    }

    pub fn category(&self) -> ErrorCategory {
        match self {
            AppError::Validation(_) => ErrorCategory::Validation,
            AppError::Storage(_) => ErrorCategory::Storage,
            AppError::Database(_) | AppError::Migration(_) => ErrorCategory::Database,
            AppError::SecretStore(_) => ErrorCategory::Auth,
            AppError::Network(_) => ErrorCategory::Network,
            AppError::Window(_) | AppError::StageDisplayMissing => ErrorCategory::Window,
            AppError::Internal(_) => ErrorCategory::Internal,
        }
    }

    pub fn recoverable(&self) -> bool {
        !matches!(self, AppError::Migration(_) | AppError::Internal(_))
    }

    /// Stable, redacted user-facing copy. The UI maps `code` to localized
    /// strings; this is only the fallback.
    fn user_message(&self) -> String {
        match self.category() {
            ErrorCategory::Network => "A network problem interrupted the operation.".into(),
            ErrorCategory::Database => "CandidCue could not access its local database.".into(),
            ErrorCategory::Window => "The stage window could not be opened or positioned.".into(),
            ErrorCategory::Auth => "There is a problem with the stored API key.".into(),
            ErrorCategory::Storage => "A file operation failed.".into(),
            ErrorCategory::Validation => "The request was not valid.".into(),
            _ => "Something unexpected went wrong.".into(),
        }
    }

    pub fn to_payload(&self) -> AppErrorPayload {
        AppErrorPayload {
            code: self.code().to_string(),
            category: self.category(),
            user_message: self.user_message(),
            recoverable: self.recoverable(),
            action: None,
            correlation_id: uuid::Uuid::new_v4().to_string(),
            details: None,
        }
    }
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let payload = self.to_payload();
        tracing::error!(code = payload.code, correlation_id = %payload.correlation_id, error = %self, "command error");
        payload.serialize(serializer)
    }
}
