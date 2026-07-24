//! Secret handling (spec §44.6). The OpenAI key enters Rust once through a
//! one-shot masked field and never returns to JavaScript.

use async_trait::async_trait;

use crate::errors::AppError;

const SERVICE_NAME: &str = "com.candidcue.app";
const OPENAI_KEY_ENTRY: &str = "openai-api-key";

/// A secret that redacts `Debug`/`Display` output.
pub struct SecretString(String);

impl SecretString {
    pub fn new(value: String) -> Self {
        Self(value)
    }

    /// Deliberately explicit accessor; never log the result.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for SecretString {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SecretString(<redacted>)")
    }
}

impl std::fmt::Display for SecretString {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("<redacted>")
    }
}

/// Non-secret facts about a stored key, safe to show in settings.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactedSecretMetadata {
    /// e.g. "sk-…abcd"
    pub hint: String,
}

#[async_trait]
pub trait SecretStore: Send + Sync {
    async fn set_openai_key(&self, key: SecretString) -> Result<(), AppError>;
    async fn get_openai_key(&self) -> Result<Option<SecretString>, AppError>;
    async fn delete_openai_key(&self) -> Result<(), AppError>;
    async fn describe_openai_key(&self) -> Result<Option<RedactedSecretMetadata>, AppError>;
}

/// OS credential store implementation backed by `keyring`
/// (macOS Keychain / Windows Credential Manager).
pub struct OsSecretStore;

impl OsSecretStore {
    fn entry() -> Result<keyring::Entry, AppError> {
        Ok(keyring::Entry::new(SERVICE_NAME, OPENAI_KEY_ENTRY)?)
    }
}

#[async_trait]
impl SecretStore for OsSecretStore {
    async fn set_openai_key(&self, key: SecretString) -> Result<(), AppError> {
        Self::entry()?.set_password(key.expose())?;
        Ok(())
    }

    async fn get_openai_key(&self) -> Result<Option<SecretString>, AppError> {
        match Self::entry()?.get_password() {
            Ok(value) => Ok(Some(SecretString::new(value))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(err.into()),
        }
    }

    async fn delete_openai_key(&self) -> Result<(), AppError> {
        match Self::entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(err.into()),
        }
    }

    async fn describe_openai_key(&self) -> Result<Option<RedactedSecretMetadata>, AppError> {
        Ok(self.get_openai_key().await?.map(|key| {
            let value = key.expose();
            let tail: String = value.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
            RedactedSecretMetadata {
                hint: format!("sk-…{tail}"),
            }
        }))
    }
}
