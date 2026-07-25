//! Secret handling (spec §44.6). The Inworld key enters Rust once through a
//! one-shot masked field and never returns to JavaScript.
//!
//! A packaged build has exactly one source for that key: the OS credential
//! store. A *debug* build has a second one — the `INWORLD_API_KEY` environment
//! variable — which exists solely to keep macOS from re-prompting for the login
//! password on every `tauri dev` rebuild; see [`dev_env_key`] for the reason and
//! for how it is kept out of release binaries. Everything else in this module is
//! written so that whichever source wins is reported truthfully upward, because
//! the one thing worse than two possible keys is not knowing which one is
//! billing the account.

use async_trait::async_trait;

use crate::errors::AppError;

const SERVICE_NAME: &str = "com.candidcue.app";
const INWORLD_KEY_ENTRY: &str = "inworld-api-key";

/// The variable a *debug* build consults ahead of the OS credential store.
/// Named for the ecosystem convention so a shell that already exports a key for
/// the Inworld SDKs needs no second variable.
pub const DEV_KEY_ENV_VAR: &str = "INWORLD_API_KEY";

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

/// Where the key CandidCue would actually use right now comes from.
///
/// Two stores can hold a key at once in a development build, and only one of
/// them wins. Reporting the winner is the difference between settings that
/// describe reality and settings that describe an intention — it is never the
/// key itself, only which drawer it came out of.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum KeySource {
    /// The debug-only `INWORLD_API_KEY` override; impossible in a release build.
    Environment,
    /// The OS credential store — the only source a packaged build has.
    Keychain,
    /// No key anywhere.
    #[serde(rename = "none")]
    Absent,
}

/// Non-secret facts about a stored key, safe to show in settings.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactedSecretMetadata {
    /// e.g. "sk-…abcd"
    pub hint: String,
    /// Which store this key came out of. Never the key.
    pub source: KeySource,
}

/// Interpret a raw override value. Whitespace-only counts as unset: an
/// exported-but-empty variable is a shell accident, not an instruction to run
/// CandidCue without a key, and treating it as a key would shadow the keychain
/// with nothing.
fn override_from_raw(raw: Option<String>) -> Option<SecretString> {
    let value = raw?.trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(SecretString::new(value))
    }
}

/// Development-only escape hatch from the macOS Keychain.
///
/// macOS binds a Keychain item's ACL to the *code signature* of the process
/// that asked for it. `tauri dev` relinks the binary on every change and signs
/// it ad-hoc, so every run presents a different identity to the Keychain, the
/// saved ACL never matches, and "Always Allow" can never stick — the login
/// password prompt comes back on each launch, several times a day. Reading the
/// key from the environment first sidesteps the ACL entirely.
///
/// The `cfg(not(debug_assertions))` twin below exists so that a release build
/// contains no environment read at all: a packaged CandidCue cannot be made to
/// pick up a key from whatever was exported into its environment, no matter how
/// it was launched. Do NOT collapse the pair into a runtime `if cfg!(…)` — that
/// compiles the environment read into the shipped binary and only hides it
/// behind a branch.
#[cfg(debug_assertions)]
fn dev_env_key() -> Option<SecretString> {
    override_from_raw(std::env::var(DEV_KEY_ENV_VAR).ok()).or_else(dev_dotenv_key)
}

/// Second debug-only source: `INWORLD_API_KEY` in the project's `.env`.
///
/// `tauri dev` inherits the shell's environment, and a `.env` file is not part
/// of it — Vite loads one for the frontend, Rust does not. So a developer who
/// puts their key where every other tool in this stack looks for it gets an app
/// that cannot see it, and the only symptom is a key field that will not go
/// away. Reading it here closes that gap without asking anyone to remember an
/// `export`.
///
/// Debug builds only, like its caller, and for the same reason: a packaged
/// CandidCue must not pick up a key from a file next to wherever it happens to
/// have been launched. The path is resolved from `CARGO_MANIFEST_DIR`, which is
/// baked in at compile time, so it names THIS checkout rather than a working
/// directory an attacker could choose.
#[cfg(debug_assertions)]
fn dev_dotenv_key() -> Option<SecretString> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .join(".env");
    let contents = std::fs::read_to_string(path).ok()?;
    for line in contents.lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        let Some((name, value)) = line.split_once('=') else {
            continue;
        };
        if name.trim() != DEV_KEY_ENV_VAR {
            continue;
        }
        let value = value.trim().trim_matches(|c| c == '"' || c == '\'');
        return override_from_raw(Some(value.to_string()));
    }
    None
}

/// Release twin of [`dev_env_key`]. See that function for why this is a
/// separate compilation, not a branch. It is handed `None` rather than simply
/// returning `None` so that the two twins differ in exactly one thing — whether
/// the environment is consulted at all — and so this one still fails to compile
/// if the override's shape ever changes underneath it.
#[cfg(not(debug_assertions))]
fn dev_env_key() -> Option<SecretString> {
    override_from_raw(None)
}

/// Whether the debug-only environment override is supplying the key right now.
/// Always `false` in a release build. Callers use this to refuse writes the
/// override would immediately shadow.
pub fn dev_env_key_active() -> bool {
    dev_env_key().is_some()
}

/// The redacted tail shown in settings. Takes the last four characters so the
/// operator can tell two of their own keys apart, and nothing more.
fn hint_for(key: &SecretString) -> String {
    let value = key.expose();
    let tail: String = value
        .chars()
        .rev()
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("…{tail}")
}

#[async_trait]
pub trait SecretStore: Send + Sync {
    async fn set_inworld_key(&self, key: SecretString) -> Result<(), AppError>;
    async fn get_inworld_key(&self) -> Result<Option<SecretString>, AppError>;
    async fn delete_inworld_key(&self) -> Result<(), AppError>;
    async fn describe_inworld_key(&self) -> Result<Option<RedactedSecretMetadata>, AppError>;
}

/// OS credential store implementation backed by `keyring`
/// (macOS Keychain / Windows Credential Manager).
pub struct OsSecretStore;

impl OsSecretStore {
    fn entry() -> Result<keyring::Entry, AppError> {
        Ok(keyring::Entry::new(SERVICE_NAME, INWORLD_KEY_ENTRY)?)
    }

    /// The credential-store read on its own, with the environment override out
    /// of the picture — the one place that actually touches the Keychain.
    fn keychain_key() -> Result<Option<SecretString>, AppError> {
        match Self::entry()?.get_password() {
            Ok(value) => Ok(Some(SecretString::new(value))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(err.into()),
        }
    }

    /// The winning key and the store it came from, in one pass, so a caller
    /// never reads the Keychain twice (each read is a potential ACL prompt).
    fn resolve(&self) -> Result<(Option<SecretString>, KeySource), AppError> {
        // Debug builds only; `dev_env_key` explains why the environment wins.
        if let Some(key) = dev_env_key() {
            return Ok((Some(key), KeySource::Environment));
        }
        Ok((Self::keychain_key()?, KeySource::Keychain))
    }
}

#[async_trait]
impl SecretStore for OsSecretStore {
    async fn set_inworld_key(&self, key: SecretString) -> Result<(), AppError> {
        Self::entry()?.set_password(key.expose())?;
        Ok(())
    }

    async fn get_inworld_key(&self) -> Result<Option<SecretString>, AppError> {
        Ok(self.resolve()?.0)
    }

    /// Deletes the credential-store entry only. The environment override is not
    /// this process's to remove, so a delete performed while it is set does
    /// exactly what it says and no more; `describe_inworld_key` then keeps
    /// reporting `Environment`, which is the honest answer rather than a
    /// pretend-empty one.
    async fn delete_inworld_key(&self) -> Result<(), AppError> {
        match Self::entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(err.into()),
        }
    }

    async fn describe_inworld_key(&self) -> Result<Option<RedactedSecretMetadata>, AppError> {
        let (key, source) = self.resolve()?;
        Ok(key.map(|key| RedactedSecretMetadata {
            hint: hint_for(&key),
            source,
        }))
    }
}
