//! Application error model (spec §44.12, Appendix C.7, Appendix E.7).
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
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

    #[error("network error: {0}")]
    Network(#[from] reqwest::Error),

    #[error("window error: {0}")]
    Window(#[from] tauri::Error),

    #[error("stage display missing")]
    StageDisplayMissing,

    #[error("internal error: {0}")]
    Internal(String),

    /// Fully structured error: stable code + category + user copy chosen at
    /// the construction site. Preferred for all new code paths.
    #[error("{code}: {log_message}")]
    Structured {
        code: &'static str,
        category: ErrorCategory,
        user_message: String,
        recoverable: bool,
        action: Option<RecoveryAction>,
        details: Option<serde_json::Map<String, serde_json::Value>>,
        /// Internal log copy; never crosses IPC.
        log_message: String,
    },
}

impl AppError {
    pub fn structured(
        code: &'static str,
        category: ErrorCategory,
        user_message: impl Into<String>,
        recoverable: bool,
    ) -> Self {
        let user_message = user_message.into();
        AppError::Structured {
            code,
            category,
            log_message: user_message.clone(),
            user_message,
            recoverable,
            action: None,
            details: None,
        }
    }

    pub fn with_action(mut self, new_action: RecoveryAction) -> Self {
        if let AppError::Structured { ref mut action, .. } = self {
            *action = Some(new_action);
        }
        self
    }

    pub fn with_detail(mut self, key: &str, value: impl Into<serde_json::Value>) -> Self {
        if let AppError::Structured { ref mut details, .. } = self {
            details
                .get_or_insert_with(serde_json::Map::new)
                .insert(key.to_string(), value.into());
        }
        self
    }

    pub fn with_log(mut self, message: impl Into<String>) -> Self {
        if let AppError::Structured {
            ref mut log_message, ..
        } = self
        {
            *log_message = message.into();
        }
        self
    }

    // ---- Common constructors -------------------------------------------

    pub fn validation(message: impl Into<String>) -> Self {
        Self::structured("IMPORT_INVALID_FORMAT", ErrorCategory::Validation, message, true)
    }

    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::structured("VALIDATION_FAILED", ErrorCategory::Validation, message, true)
    }

    pub fn not_found(what: &str) -> Self {
        Self::structured(
            "NOT_FOUND",
            ErrorCategory::Validation,
            format!("The requested {what} could not be found."),
            true,
        )
    }

    pub fn stale_revision(expected: i64, actual: i64) -> Self {
        Self::structured(
            "SCRIPT_CONFLICT",
            ErrorCategory::Validation,
            "This document changed elsewhere. Reload before saving.",
            true,
        )
        .with_detail("expectedRevision", expected)
        .with_detail("actualRevision", actual)
    }

    pub fn unsafe_path(message: impl Into<String>) -> Self {
        Self::structured("IMPORT_UNSAFE_PATH", ErrorCategory::Validation, message, true)
    }

    pub fn not_implemented(what: &str) -> Self {
        Self::structured(
            "NOT_IMPLEMENTED",
            ErrorCategory::Internal,
            format!("{what} is not available in this version of CandidCue."),
            false,
        )
        .with_detail("feature", what)
    }

    pub fn save_failed(message: impl Into<String>) -> Self {
        Self::structured("SCRIPT_SAVE_FAILED", ErrorCategory::Storage, message, true)
            .with_action(RecoveryAction::Retry)
    }

    // ---- Accessors -------------------------------------------------------

    pub fn code(&self) -> &'static str {
        match self {
            AppError::Validation(_) => "IMPORT_INVALID_FORMAT",
            AppError::Storage(_) => "SCRIPT_SAVE_FAILED",
            AppError::Database(_) => "DATABASE_INTEGRITY_FAILED",
            AppError::Migration(_) => "DATABASE_MIGRATION_FAILED",
            AppError::Network(err) => {
                if err.is_connect() {
                    "NETWORK_OFFLINE"
                } else {
                    "NETWORK_TIMEOUT"
                }
            }
            AppError::Window(_) => "STAGE_OPEN_FAILED",
            AppError::StageDisplayMissing => "STAGE_DISPLAY_MISSING",
            AppError::Internal(_) => "INTERNAL_UNEXPECTED",
            AppError::Structured { code, .. } => code,
        }
    }

    pub fn category(&self) -> ErrorCategory {
        match self {
            AppError::Validation(_) => ErrorCategory::Validation,
            AppError::Storage(_) => ErrorCategory::Storage,
            AppError::Database(_) | AppError::Migration(_) => ErrorCategory::Database,
            AppError::Network(_) => ErrorCategory::Network,
            AppError::Window(_) | AppError::StageDisplayMissing => ErrorCategory::Window,
            AppError::Internal(_) => ErrorCategory::Internal,
            AppError::Structured { category, .. } => *category,
        }
    }

    pub fn recoverable(&self) -> bool {
        match self {
            AppError::Migration(_) | AppError::Internal(_) => false,
            AppError::Structured { recoverable, .. } => *recoverable,
            _ => true,
        }
    }

    /// Stable, redacted user-facing copy. The UI maps `code` to localized
    /// strings; this is only the fallback.
    fn user_message(&self) -> String {
        if let AppError::Structured { user_message, .. } = self {
            return user_message.clone();
        }
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
        let (action, details) = match self {
            AppError::Structured { action, details, .. } => (*action, details.clone()),
            _ => (None, None),
        };
        AppErrorPayload {
            code: self.code().to_string(),
            category: self.category(),
            user_message: self.user_message(),
            recoverable: self.recoverable(),
            action,
            correlation_id: uuid::Uuid::new_v4().to_string(),
            details,
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
