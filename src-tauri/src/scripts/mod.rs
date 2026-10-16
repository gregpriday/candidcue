//! Script repository (spec §44.4): CRUD, atomic canonical file writes,
//! revisions, import/export, trash, startup reconciliation, per-script
//! locking.

pub mod import_export;
pub mod reconcile;
pub mod repo;
pub mod words;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as AsyncMutex;

use crate::errors::AppError;

/// Script text without its leading byte-order mark.
///
/// Windows editors and some export tools save "UTF-8 with BOM", and decoding
/// UTF-8 keeps the U+FEFF. Left in, it is an invisible first character that
/// defeats every line-one check — a `:::stage` fence, a `#` heading, front
/// matter — and shifts the compiler's source positions (#247). Only a mark at
/// the very start is a BOM; a U+FEFF anywhere else is the author's text.
pub(crate) fn without_bom(source: &str) -> &str {
    source.strip_prefix('\u{feff}').unwrap_or(source)
}

/// [`without_bom`] for owned text, in place.
pub(crate) fn into_without_bom(mut source: String) -> String {
    if source.starts_with('\u{feff}') {
        source.replace_range(..'\u{feff}'.len_utf8(), "");
    }
    source
}

/// A script identifier that has been proven to be a canonical lowercase
/// hyphenated UUID (spec §47.1: script directories are named by UUID).
///
/// This type is the ONLY way to build a managed script path, so an
/// attacker-supplied string can never reach the filesystem or the SQL layer:
/// `PathBuf::join` replaces the base when its argument is absolute, and
/// `%`/`_` are LIKE wildcards. Both classes of abuse are impossible for a
/// value of this type.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(transparent)]
pub struct ScriptId(String);

impl ScriptId {
    /// Parse and validate. Only the canonical lowercase hyphenated UUID form
    /// is accepted — braced, URN, uppercase, and simple (unhyphenated) forms
    /// are rejected so the validated string is byte-for-byte the string used
    /// downstream.
    pub fn parse(raw: &str) -> Result<Self, AppError> {
        if raw.len() != 36 {
            return Err(invalid_script_id());
        }
        if !raw
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
        {
            return Err(invalid_script_id());
        }
        let parsed = uuid::Uuid::parse_str(raw).map_err(|_| invalid_script_id())?;
        if parsed.as_hyphenated().to_string() != raw {
            return Err(invalid_script_id());
        }
        Ok(Self(raw.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for ScriptId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl AsRef<str> for ScriptId {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for ScriptId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw = String::deserialize(deserializer)?;
        ScriptId::parse(&raw).map_err(|_| {
            serde::de::Error::invalid_value(
                serde::de::Unexpected::Str(&raw),
                &"a canonical lowercase hyphenated UUID",
            )
        })
    }
}

fn invalid_script_id() -> AppError {
    AppError::structured(
        "INVALID_SCRIPT_ID",
        crate::errors::ErrorCategory::Validation,
        "That script identifier is not valid.",
        false,
    )
}

/// Managed-state map of data directory locations (spec §47.1).
#[derive(Debug, Clone)]
pub struct DataPaths {
    root: PathBuf,
}

impl DataPaths {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn scripts_dir(&self) -> PathBuf {
        self.root.join("scripts")
    }

    /// `<root>/scripts/<uuid>`. Only reachable with a validated [`ScriptId`],
    /// and additionally asserted to be a direct child of the scripts root
    /// (defence in depth against a future change to [`ScriptId`]).
    pub fn script_dir(&self, script_id: &ScriptId) -> PathBuf {
        let scripts_root = self.scripts_dir();
        let dir = scripts_root.join(script_id.as_str());
        debug_assert_eq!(dir.parent(), Some(scripts_root.as_path()));
        debug_assert_eq!(
            dir.file_name().map(|n| n.to_string_lossy().to_string()),
            Some(script_id.as_str().to_string())
        );
        dir
    }

    pub fn canonical_file(&self, script_id: &ScriptId) -> PathBuf {
        self.script_dir(script_id).join("script.md")
    }

    pub fn assets_dir(&self, script_id: &ScriptId) -> PathBuf {
        self.script_dir(script_id).join("assets")
    }

    pub fn revisions_dir(&self, script_id: &ScriptId) -> PathBuf {
        self.script_dir(script_id).join("revisions")
    }

    /// Quarantine root for content that is about to be destroyed but must
    /// stay recoverable if the destroying operation is interrupted
    /// (spec §47.6: preserve evidence rather than delete uncertain data).
    pub fn quarantine_dir(&self) -> PathBuf {
        self.root.join("quarantine")
    }

    pub fn cache_dir(&self) -> PathBuf {
        self.root.join("cache")
    }

    pub fn backups_dir(&self) -> PathBuf {
        self.root.join("backups")
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.root.join("logs")
    }

    pub fn diagnostics_dir(&self) -> PathBuf {
        self.root.join("diagnostics")
    }

    /// Relative path (unix separators) from the data root, for DB storage.
    pub fn relative(&self, absolute: &Path) -> Option<String> {
        absolute
            .strip_prefix(&self.root)
            .ok()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
    }
}

/// Per-script async write locks (spec §48.4): only one canonical save
/// operation per script runs at a time.
#[derive(Default)]
pub struct ScriptLocks {
    locks: std::sync::Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
}

impl ScriptLocks {
    pub fn lock_for(&self, script_id: &ScriptId) -> Arc<AsyncMutex<()>> {
        let mut map = self.locks.lock().expect("script locks poisoned");
        map.entry(script_id.as_str().to_string())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }
}

// ---------------------------------------------------------------------------
// Contract twins (src/shared/contracts/core.ts). Field names must match.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptSummary {
    pub id: String,
    pub title: String,
    /// Optimistic-concurrency revision. Carried on every summary so the
    /// library can perform compare-and-swap transitions (rename, trash,
    /// restore) without first re-reading the document (M4, spec §48.4).
    pub script_revision: i64,
    pub status: ScriptStatus,
    pub language: String,
    pub spoken_word_count: u32,
    pub estimated_duration_seconds: u32,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_opened_at: Option<String>,
    pub preview_text: String,
    pub has_warnings: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScriptStatus {
    Draft,
    Ready,
    Archived,
    Trash,
}

impl ScriptStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            ScriptStatus::Draft => "draft",
            ScriptStatus::Ready => "ready",
            ScriptStatus::Archived => "archived",
            ScriptStatus::Trash => "trash",
        }
    }

    pub fn parse(value: &str) -> Self {
        match value {
            "ready" => ScriptStatus::Ready,
            "archived" => ScriptStatus::Archived,
            "trash" => ScriptStatus::Trash,
            _ => ScriptStatus::Draft,
        }
    }
}

/// Twin of `ScriptSettings` (core.ts).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ScriptSettings {
    pub schema_version: u32,
    pub read_headings: bool,
    pub read_image_alt_text: bool,
    pub read_inline_code: bool,
    pub cue_visibility: String,
    pub silent_block_visibility: String,
    pub words_per_minute_estimate: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage_overrides: Option<serde_json::Value>,
}

impl Default for ScriptSettings {
    fn default() -> Self {
        Self {
            schema_version: 1,
            read_headings: false,
            read_image_alt_text: false,
            read_inline_code: false,
            cue_visibility: "subtle".into(),
            silent_block_visibility: "dim".into(),
            words_per_minute_estimate: 130,
            stage_overrides: None,
        }
    }
}

/// Twin of `ScriptDocument` (core.ts): summary + source + settings.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptDocument {
    #[serde(flatten)]
    pub summary: ScriptSummary,
    pub source: String,
    pub source_hash: String,
    pub settings: ScriptSettings,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_display_profile_id: Option<String>,
    /*
     * No `selected_tracking_profile_id`. `tracking_profiles` was dropped in
     * the 1.0 schema baseline: named tracking presets never shipped, nothing
     * ever wrote a row, and the product settled on one following
     * configuration in Settings.
     */
    /// True when the canonical file changed outside CandidCue and the file
    /// content (authority, spec §48.1) was adopted during this read.
    pub externally_changed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptPage {
    pub items: Vec<ScriptSummary>,
    pub total: u32,
    pub page: u32,
    pub page_size: u32,
}

/// Twin of the wire filter built by `listScripts` in
/// src/control/services/scripts.ts.
///
/// C3: `deny_unknown_fields` is the point of this struct now. Control used to
/// send `{ view: 'trash' }`; serde silently discarded `view`, `status` stayed
/// `None`, and the Trash view listed live scripts — which the per-row
/// "Delete permanently" and "Empty Trash" controls then acted on. The library
/// view is mapped to `status`/`openedOnly` on the TypeScript side, and any
/// field this struct does not declare is now a hard deserialization error
/// rather than a silent default.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScriptFilter {
    pub query: Option<String>,
    pub status: Option<ScriptStatus>,
    /// Recent view: only scripts that have actually been opened.
    #[serde(default)]
    pub opened_only: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageRequest {
    pub page: u32,
    pub page_size: u32,
}

impl Default for PageRequest {
    fn default() -> Self {
        Self {
            page: 0,
            page_size: 100,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateScriptInput {
    pub title: String,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
}

/// Optional metadata changes carried with a save (spec §46.2
/// `metadata_patch`).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScriptMetadataPatch {
    pub title: Option<String>,
    pub status: Option<ScriptStatus>,
    pub settings: Option<ScriptSettings>,
    #[serde(default, with = "double_option")]
    pub selected_display_profile_id: Option<Option<String>>,
    /// Force a revision snapshot with this reason (e.g. `pre_session`,
    /// `before_destructive_edit`); otherwise the 5-minute policy applies.
    pub revision_reason: Option<String>,
    pub last_opened: Option<bool>,
}

/// `Option<Option<T>>` deserializer: absent = no change, null = clear.
mod double_option {
    use serde::{Deserialize, Deserializer};

    pub fn deserialize<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
    where
        T: Deserialize<'de>,
        D: Deserializer<'de>,
    {
        Deserialize::deserialize(deserializer).map(Some)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub script_revision: i64,
    pub source_hash: String,
    pub saved_at: String,
    pub revision_created: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionSummary {
    pub id: String,
    pub revision_number: i64,
    pub source_hash: String,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub word_count: Option<i64>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionDocument {
    #[serde(flatten)]
    pub summary: RevisionSummary,
    pub source: String,
}

#[cfg(test)]
mod bom_tests {
    use super::*;

    #[test]
    fn strips_one_leading_mark_only() {
        assert_eq!(without_bom("# Title"), "# Title");
        assert_eq!(without_bom("\u{feff}# Title"), "# Title");
        // A second mark, or one mid-text, is the author's character.
        assert_eq!(without_bom("\u{feff}\u{feff}x"), "\u{feff}x");
        assert_eq!(without_bom("a\u{feff}b"), "a\u{feff}b");
        assert_eq!(without_bom("\u{feff}"), "");

        assert_eq!(into_without_bom("\u{feff}# Title".into()), "# Title");
        assert_eq!(into_without_bom("a\u{feff}b".into()), "a\u{feff}b");
        assert_eq!(into_without_bom("\u{feff}\u{feff}x".into()), "\u{feff}x");
    }
}

#[cfg(test)]
mod script_id_tests {
    use super::*;

    const VALID: &str = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

    #[test]
    fn accepts_canonical_uuid_only() {
        assert_eq!(ScriptId::parse(VALID).unwrap().as_str(), VALID);
        // Uppercase, braced, URN and simple forms are all rejected so the
        // validated bytes are exactly the bytes used for paths and SQL.
        assert!(ScriptId::parse(&VALID.to_uppercase()).is_err());
        assert!(ScriptId::parse(&format!("{{{VALID}}}")).is_err());
        assert!(ScriptId::parse(&format!("urn:uuid:{VALID}")).is_err());
        assert!(ScriptId::parse(&VALID.replace('-', "")).is_err());
    }

    #[test]
    fn rejects_path_traversal_and_sql_wildcards() {
        // C1: these are the exact payloads that deleted arbitrary directories
        // and matched unrelated asset rows.
        for evil in [
            "/Users/alice/Documents",
            "/",
            "..",
            "../..",
            "../../../etc",
            "C:\\Windows",
            "%",
            "_",
            "3f2504e0-4f89-41d3-9a0c-0305e82c33%1",
            "3f2504e0-4f89-41d3-9a0c-0305e82c33_1",
            "3f2504e0-4f89-41d3-9a0c-0305e82c3301/../../..",
            "",
            "   ",
            "script.md",
        ] {
            assert!(
                ScriptId::parse(evil).is_err(),
                "must reject script id {evil:?}"
            );
        }
    }

    #[test]
    fn deserialize_rejects_invalid_ids() {
        assert!(serde_json::from_str::<ScriptId>(&format!("\"{VALID}\"")).is_ok());
        assert!(serde_json::from_str::<ScriptId>("\"/etc/passwd\"").is_err());
        assert!(serde_json::from_str::<ScriptId>("\"../../..\"").is_err());
    }

    #[test]
    fn managed_paths_stay_directly_under_the_scripts_root() {
        let paths = DataPaths::new(std::path::PathBuf::from("/data/root"));
        let id = ScriptId::parse(VALID).unwrap();
        let dir = paths.script_dir(&id);
        assert_eq!(dir, std::path::Path::new("/data/root/scripts").join(VALID));
        assert!(dir.starts_with(paths.scripts_dir()));
        assert_eq!(dir.parent(), Some(paths.scripts_dir().as_path()));
        assert!(paths.canonical_file(&id).starts_with(&dir));
        assert!(paths.assets_dir(&id).starts_with(&dir));
        assert!(paths.revisions_dir(&id).starts_with(&dir));
    }

    #[test]
    fn new_uuid_round_trips_through_validation() {
        let generated = crate::util::new_uuid();
        assert_eq!(ScriptId::parse(&generated).unwrap().as_str(), generated);
    }
}
