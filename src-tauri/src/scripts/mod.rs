//! Script repository (spec §44.4): CRUD, atomic canonical file writes,
//! revisions, import/export, trash. Stub — only the summary type used by
//! `list_scripts` exists so far.

use serde::{Deserialize, Serialize};

/// Rust twin of the `ScriptSummary` contract
/// (`src/shared/contracts/core.ts`). Keep field names in sync.
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScriptStatus {
    Draft,
    Ready,
    Archived,
    Trash,
}
