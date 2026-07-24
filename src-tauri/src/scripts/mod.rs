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

    pub fn script_dir(&self, script_id: &str) -> PathBuf {
        self.scripts_dir().join(script_id)
    }

    pub fn canonical_file(&self, script_id: &str) -> PathBuf {
        self.script_dir(script_id).join("script.md")
    }

    pub fn assets_dir(&self, script_id: &str) -> PathBuf {
        self.script_dir(script_id).join("assets")
    }

    pub fn revisions_dir(&self, script_id: &str) -> PathBuf {
        self.script_dir(script_id).join("revisions")
    }

    pub fn listeners_dir(&self) -> PathBuf {
        self.root.join("listeners")
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
    pub fn lock_for(&self, script_id: &str) -> Arc<AsyncMutex<()>> {
        let mut map = self.locks.lock().expect("script locks poisoned");
        map.entry(script_id.to_string())
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

/// Twin of `ListenerSelection` (listener.ts).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenerSelection {
    pub pack_id: String,
    pub version: String,
    pub variant: String,
}

/// Twin of `ScriptDocument` (core.ts): summary + source + settings.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptDocument {
    #[serde(flatten)]
    pub summary: ScriptSummary,
    pub source: String,
    pub source_hash: String,
    pub script_revision: i64,
    pub settings: ScriptSettings,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_display_profile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_tracking_profile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_listener: Option<ListenerSelection>,
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

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptFilter {
    pub query: Option<String>,
    pub status: Option<ScriptStatus>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
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
#[serde(rename_all = "camelCase")]
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
#[serde(rename_all = "camelCase")]
pub struct ScriptMetadataPatch {
    pub title: Option<String>,
    pub status: Option<ScriptStatus>,
    pub settings: Option<ScriptSettings>,
    #[serde(default, with = "double_option")]
    pub selected_display_profile_id: Option<Option<String>>,
    #[serde(default, with = "double_option")]
    pub selected_tracking_profile_id: Option<Option<String>>,
    #[serde(default, with = "double_option")]
    pub selected_listener: Option<Option<ListenerSelection>>,
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
