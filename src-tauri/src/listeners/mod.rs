//! Listener packs (spec §44.8): catalogue retrieval, signature verification,
//! safe download, checksums, install/rollback, scoped asset URLs. Stub —
//! only the bundled-pack manifest shape exists so far.

#![allow(dead_code)]

use serde::{Deserialize, Serialize};

/// Rust twin of `ListenerPackManifest`
/// (`src/shared/contracts/listener.ts`) for bundled packs such as
/// `assets/listeners/mira/manifest.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenerPackManifest {
    pub schema_version: u32,
    pub id: String,
    pub version: String,
    pub display_name: String,
    pub description: String,
    pub poster: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_image: Option<String>,
    pub default_zoom: f64,
    pub fit: ListenerFit,
    pub clips: Vec<ListenerManifestClip>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ListenerFit {
    Cover,
    Contain,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenerManifestClip {
    pub id: String,
    pub role: String,
    pub path: String,
    pub mime: String,
    pub duration_ms: u64,
    pub size_bytes: u64,
}
