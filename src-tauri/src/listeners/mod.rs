//! Listener packs (spec §39, §44.8): bundled-pack resolution, manifest
//! verification, installed-pack catalogue, scoped media URLs, and the
//! download trait with checksum verification. Remote catalogue/download is
//! declared but returns NOT_IMPLEMENTED until a CandidCue-controlled host
//! exists (v1 ships with the bundled pack only).

use std::fs;
use std::path::{Path, PathBuf};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

use crate::assets::asset_url;
use crate::errors::{AppError, ErrorCategory};
use crate::util::{is_safe_relative_path, now_iso, sha256_file};

/// Spec Appendix A.10: Listener manifest limit.
pub const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;

// ---------------------------------------------------------------------------
// Bundled pack manifest (src/shared/contracts/listener.ts, camelCase)
// ---------------------------------------------------------------------------

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
    /// Optional per-file checksum; required for downloaded packs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

// ---------------------------------------------------------------------------
// IPC result shapes
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledListener {
    pub pack_id: String,
    pub version: String,
    pub display_name: String,
    pub description: String,
    pub source: String, // 'bundled' | 'downloaded'
    pub size_bytes: u64,
    pub clip_count: u32,
    pub state: String, // 'installed' | 'installing' | 'failed' | 'rollback'
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_at: Option<String>,
}

/// Twin of `ListenerCatalogueEntry` (listener.ts).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenerCatalogueEntry {
    pub pack_id: String,
    pub latest_version: String,
    pub display_name: String,
    pub description: String,
    pub thumbnail_url: String,
    pub approximate_bytes: u64,
    pub variants: Vec<String>,
    pub minimum_app_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenerCatalogue {
    pub entries: Vec<ListenerCatalogueEntry>,
    pub fetched_at: String,
    /// 'bundled_only' until a remote catalogue host exists.
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenerClipUrl {
    pub id: String,
    pub url: String,
    pub mime: String,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenerMediaUrls {
    pub pack_id: String,
    pub version: String,
    pub poster_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_url: Option<String>,
    pub default_zoom: f64,
    pub fit: ListenerFit,
    pub clips: Vec<ListenerClipUrl>,
}

// ---------------------------------------------------------------------------
// Library state
// ---------------------------------------------------------------------------

/// Managed state: where bundled and downloaded packs live.
#[derive(Debug, Clone)]
pub struct ListenerLibrary {
    /// Bundled packs (repo `assets/listeners` in dev, Tauri resources in prod).
    pub bundled_dir: PathBuf,
    /// Downloaded packs: `<app data>/listeners/<pack-id>/<version>/`.
    pub installed_dir: PathBuf,
}

impl ListenerLibrary {
    pub fn pack_dir(&self, pack_id: &str, version: &str, bundled: bool) -> PathBuf {
        if bundled {
            self.bundled_dir.join(pack_id)
        } else {
            self.installed_dir.join(pack_id).join(version)
        }
    }
}

fn manifest_invalid(reason: impl Into<String>) -> AppError {
    AppError::structured(
        "LISTENER_MANIFEST_INVALID",
        ErrorCategory::Media,
        "This Listener pack is damaged and cannot be used.",
        true,
    )
    .with_log(reason.into())
}

/// Load and verify a pack manifest from a directory (spec §39.1): schema
/// version, safe relative paths, files present, declared sizes matched, and
/// checksums verified when declared.
pub fn load_verified_manifest(pack_dir: &Path) -> Result<ListenerPackManifest, AppError> {
    let manifest_path = pack_dir.join("manifest.json");
    let meta = fs::metadata(&manifest_path)
        .map_err(|_| manifest_invalid(format!("manifest missing at {manifest_path:?}")))?;
    if meta.len() > MAX_MANIFEST_BYTES {
        return Err(manifest_invalid("manifest exceeds 1 MB limit"));
    }
    let raw = fs::read(&manifest_path)?;
    let manifest: ListenerPackManifest = serde_json::from_slice(&raw)
        .map_err(|e| manifest_invalid(format!("manifest parse: {e}")))?;

    if manifest.schema_version != 1 {
        return Err(manifest_invalid(format!(
            "unsupported schema_version {}",
            manifest.schema_version
        )));
    }
    if manifest.id.is_empty()
        || !manifest
            .id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(manifest_invalid("pack id must be alphanumeric/dash"));
    }
    if manifest.clips.is_empty() {
        return Err(manifest_invalid("pack declares no clips"));
    }

    let mut media_paths: Vec<&str> = manifest.clips.iter().map(|c| c.path.as_str()).collect();
    media_paths.push(manifest.poster.as_str());
    if let Some(profile) = &manifest.profile_image {
        media_paths.push(profile.as_str());
    }
    for rel in media_paths {
        if !is_safe_relative_path(rel) {
            return Err(manifest_invalid(format!("unsafe media path {rel:?}")));
        }
        let absolute = pack_dir.join(rel);
        let meta = fs::symlink_metadata(&absolute)
            .map_err(|_| manifest_invalid(format!("declared file missing: {rel}")))?;
        if meta.file_type().is_symlink() {
            return Err(manifest_invalid(format!("symlink not allowed: {rel}")));
        }
        if !crate::util::is_within_root(&absolute, pack_dir) {
            return Err(manifest_invalid(format!("path escapes pack dir: {rel}")));
        }
    }

    for clip in &manifest.clips {
        let absolute = pack_dir.join(&clip.path);
        let actual_size = fs::metadata(&absolute)?.len();
        if actual_size != clip.size_bytes {
            return Err(manifest_invalid(format!(
                "size mismatch for {}: declared {}, actual {}",
                clip.path, clip.size_bytes, actual_size
            )));
        }
        if !clip.mime.starts_with("video/") {
            return Err(manifest_invalid(format!(
                "clip {} has non-video mime {}",
                clip.id, clip.mime
            )));
        }
        if let Some(expected) = &clip.sha256 {
            let actual = sha256_file(&absolute)?;
            if !actual.eq_ignore_ascii_case(expected) {
                return Err(AppError::structured(
                    "LISTENER_SIGNATURE_INVALID",
                    ErrorCategory::Media,
                    "This Listener pack failed integrity verification.",
                    true,
                )
                .with_log(format!("sha256 mismatch for {}", clip.path)));
            }
        }
    }

    Ok(manifest)
}

fn pack_total_bytes(manifest: &ListenerPackManifest) -> u64 {
    manifest.clips.iter().map(|c| c.size_bytes).sum()
}

/// Enumerate bundled packs (always installed, spec deliverable): every
/// subdirectory of the bundled dir with a verifiable manifest.
pub fn bundled_packs(library: &ListenerLibrary) -> Vec<(ListenerPackManifest, PathBuf)> {
    let mut packs = Vec::new();
    let Ok(entries) = fs::read_dir(&library.bundled_dir) else {
        return packs;
    };
    for entry in entries.filter_map(|e| e.ok()) {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        match load_verified_manifest(&entry.path()) {
            Ok(manifest) => packs.push((manifest, entry.path())),
            Err(err) => {
                tracing::warn!(dir = ?entry.path(), error = %err, "skipping invalid bundled listener pack");
            }
        }
    }
    packs
}

/// Installed packs: bundled (always) + verified downloaded rows.
pub async fn list_installed(
    pool: &SqlitePool,
    library: &ListenerLibrary,
) -> Result<Vec<InstalledListener>, AppError> {
    let mut result = Vec::new();
    for (manifest, _dir) in bundled_packs(library) {
        result.push(InstalledListener {
            pack_id: manifest.id.clone(),
            version: manifest.version.clone(),
            display_name: manifest.display_name.clone(),
            description: manifest.description.clone(),
            source: "bundled".into(),
            size_bytes: pack_total_bytes(&manifest),
            clip_count: manifest.clips.len() as u32,
            state: "installed".into(),
            installed_at: None,
        });
    }

    let rows = sqlx::query(
        "SELECT pack_id, version, display_name, size_bytes, state, installed_at FROM listener_packs",
    )
    .fetch_all(pool)
    .await?;
    for row in &rows {
        result.push(InstalledListener {
            pack_id: row.try_get("pack_id")?,
            version: row.try_get("version")?,
            display_name: row.try_get("display_name")?,
            description: String::new(),
            source: "downloaded".into(),
            size_bytes: row.try_get::<i64, _>("size_bytes")?.max(0) as u64,
            clip_count: 0,
            state: row.try_get("state")?,
            installed_at: row.try_get("installed_at")?,
        });
    }
    Ok(result)
}

/// Catalogue (spec §46.7): bundled entries always; remote entries once a
/// CandidCue-controlled catalogue host exists.
pub async fn catalogue(
    pool: &SqlitePool,
    library: &ListenerLibrary,
    _force_refresh: bool,
) -> Result<ListenerCatalogue, AppError> {
    let mut entries = Vec::new();
    for (manifest, dir) in bundled_packs(library) {
        entries.push(ListenerCatalogueEntry {
            pack_id: manifest.id.clone(),
            latest_version: manifest.version.clone(),
            display_name: manifest.display_name.clone(),
            description: manifest.description.clone(),
            thumbnail_url: asset_url(&dir.join(&manifest.poster)),
            approximate_bytes: pack_total_bytes(&manifest),
            variants: vec!["720p".into()],
            minimum_app_version: "0.1.0".into(),
            installed_version: Some(manifest.version.clone()),
        });
    }
    let _ = pool; // remote catalogue merge will consult installed rows
    Ok(ListenerCatalogue {
        entries,
        fetched_at: now_iso(),
        source: "bundled_only".into(),
    })
}

/// Resolve scoped media URLs for a pack (spec §46.7). The caller must add
/// the pack directory to the asset protocol scope before handing URLs to a
/// webview.
pub fn resolve_media(
    library: &ListenerLibrary,
    pack_id: &str,
    version: &str,
) -> Result<(ListenerMediaUrls, PathBuf), AppError> {
    // Prefer bundled; fall back to installed directory.
    let bundled_dir = library.pack_dir(pack_id, version, true);
    let installed_dir = library.pack_dir(pack_id, version, false);
    let pack_dir = if bundled_dir.join("manifest.json").exists() {
        bundled_dir
    } else if installed_dir.join("manifest.json").exists() {
        installed_dir
    } else {
        return Err(AppError::structured(
            "LISTENER_NOT_INSTALLED",
            ErrorCategory::Media,
            "This Listener pack is not installed.",
            true,
        )
        .with_detail("packId", pack_id));
    };

    let manifest = load_verified_manifest(&pack_dir)?;
    if manifest.id != pack_id {
        return Err(manifest_invalid("manifest id does not match requested pack"));
    }

    let clips = manifest
        .clips
        .iter()
        .map(|clip| ListenerClipUrl {
            id: clip.id.clone(),
            url: asset_url(&pack_dir.join(&clip.path)),
            mime: clip.mime.clone(),
            duration_ms: clip.duration_ms,
        })
        .collect();

    Ok((
        ListenerMediaUrls {
            pack_id: manifest.id.clone(),
            version: manifest.version.clone(),
            poster_url: asset_url(&pack_dir.join(&manifest.poster)),
            profile_url: manifest
                .profile_image
                .as_ref()
                .map(|p| asset_url(&pack_dir.join(p))),
            default_zoom: manifest.default_zoom,
            fit: manifest.fit,
            clips,
        },
        pack_dir,
    ))
}

/// Remove a downloaded pack (spec §39.5). Bundled packs cannot be removed.
pub async fn remove_pack(
    pool: &SqlitePool,
    library: &ListenerLibrary,
    pack_id: &str,
    version: &str,
) -> Result<(), AppError> {
    if library
        .pack_dir(pack_id, version, true)
        .join("manifest.json")
        .exists()
    {
        return Err(AppError::invalid_input(
            "Bundled Listener packs cannot be removed.",
        ));
    }
    sqlx::query("DELETE FROM listener_packs WHERE pack_id = ? AND version = ?")
        .bind(pack_id)
        .bind(version)
        .execute(pool)
        .await?;
    let dir = library.pack_dir(pack_id, version, false);
    if dir.exists() && crate::util::is_within_root(&dir, &library.installed_dir) {
        fs::remove_dir_all(&dir)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Download flow (spec §39.4): trait + checksum verification. The network
// fetch itself is NOT_IMPLEMENTED for v1 (no CandidCue-controlled host).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadJob {
    pub job_id: String,
    pub pack_id: String,
    pub variant: String,
    pub phase: String,
}

#[async_trait]
pub trait ListenerDownloader: Send + Sync {
    /// Fetch and validate catalogue + manifest, download to a temporary
    /// version directory, verify (size, MIME, SHA-256, signature), then
    /// atomically rename into the installed-pack directory.
    async fn download_pack(
        &self,
        pack_id: &str,
        variant: &str,
        destination: &Path,
    ) -> Result<DownloadJob, AppError>;

    async fn cancel(&self, job_id: &str) -> Result<(), AppError>;
}

/// v1 downloader: no remote host exists yet.
pub struct RemoteListenerDownloader;

#[async_trait]
impl ListenerDownloader for RemoteListenerDownloader {
    async fn download_pack(
        &self,
        _pack_id: &str,
        _variant: &str,
        _destination: &Path,
    ) -> Result<DownloadJob, AppError> {
        Err(AppError::not_implemented("Listener pack downloads"))
    }

    async fn cancel(&self, _job_id: &str) -> Result<(), AppError> {
        Err(AppError::not_implemented("Listener pack downloads"))
    }
}

/// Verify every downloaded file against its declared SHA-256 before an
/// install is finalized (spec §39.4 step 6).
pub fn verify_pack_checksums(
    pack_dir: &Path,
    expected: &[(String, String)], // (relative path, sha256)
) -> Result<(), AppError> {
    for (rel, sha) in expected {
        if !is_safe_relative_path(rel) {
            return Err(AppError::unsafe_path("Pack file path is unsafe."));
        }
        let absolute = pack_dir.join(rel);
        let actual = sha256_file(&absolute)?;
        if !actual.eq_ignore_ascii_case(sha) {
            return Err(AppError::structured(
                "LISTENER_SIGNATURE_INVALID",
                ErrorCategory::Media,
                "A Listener pack file failed integrity verification.",
                true,
            )
            .with_log(format!("checksum mismatch: {rel}")));
        }
    }
    Ok(())
}
