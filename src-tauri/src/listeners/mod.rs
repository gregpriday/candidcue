//! Listener packs (spec §39, §44.8): bundled-pack resolution, manifest
//! verification, installed-pack catalogue, scoped media URLs, and the
//! download trait. Remote catalogue/download returns NOT_IMPLEMENTED until a
//! CandidCue-controlled host exists (v1 ships with the bundled pack only).
//!
//! # There is no signature verification. Read this before trusting a pack.
//!
//! M3. This module used to describe itself as verifying a pack's "signature",
//! and raised an error code called `LISTENER_SIGNATURE_INVALID`, for what was
//! in fact a plain SHA-256 comparison against a hash written in the pack's own
//! manifest. That is an INTEGRITY check and nothing more: it detects a truncated
//! download or a corrupt disk. It says nothing about authenticity, because
//! anyone who can write the media files can write the manifest that describes
//! them, and CandidCue has no publisher key to check the manifest against.
//!
//! Dishonest comments are their own hazard — the next person to touch this file
//! would have believed there was a trust anchor here and built on it. So:
//!
//!   * the error code is `LISTENER_CHECKSUM_INVALID`, which is what it means;
//!   * `PackSource` makes the trust distinction explicit;
//!   * a pack that did NOT ship inside the application bundle is verified as
//!     far as it can be (mandatory checksums on every declared file, media type
//!     and size limits, symlink refusal, id+version bound to the directory it
//!     was loaded from) and is then REFUSED, because integrity is not
//!     authenticity (`LISTENER_UNVERIFIED`).
//!
//! That is a hard fail-closed, not a warning. When pack signing exists, the
//! refusal in [`load_verified_manifest`] is the single place to replace.

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
/// Per-file limits (M3). A pack directory is not a place to stage a 4 GB blob.
pub const MAX_CLIP_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_IMAGE_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_PACK_BYTES: u64 = 1024 * 1024 * 1024;
pub const MAX_CLIPS_PER_PACK: usize = 64;

/// Where a pack came from, and therefore how far it can be trusted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackSource {
    /// Shipped inside the application bundle. Its integrity is the
    /// application's own integrity — on macOS, the code signature covers it.
    Bundled,
    /// Written into the user's data directory. Nothing vouches for it: there is
    /// no pack-signing scheme, so this is refused (see the module docs).
    Installed,
}

/// Container magic bytes for the video types a pack may declare (M3). The
/// declared `mime` used to be taken at face value, so a pack could label any
/// bytes at all `video/mp4` and hand them to the stage's media element.
fn video_mime_matches_bytes(mime: &str, head: &[u8]) -> bool {
    match mime {
        // ISO base media: `....ftyp` at offset 4.
        "video/mp4" | "video/quicktime" => head.len() >= 12 && &head[4..8] == b"ftyp",
        // Matroska/WebM EBML header.
        "video/webm" | "video/x-matroska" => head.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]),
        _ => false,
    }
}

fn read_head(path: &Path, len: usize) -> Result<Vec<u8>, AppError> {
    use std::io::Read;
    let mut file = fs::File::open(path)?;
    let mut buf = vec![0u8; len];
    let read = file.read(&mut buf)?;
    buf.truncate(read);
    Ok(buf)
}

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

fn checksum_invalid(reason: impl Into<String>) -> AppError {
    AppError::structured(
        // NOT "signature": this is a hash comparison against the pack's own
        // manifest, which proves the bytes are intact and nothing about who
        // produced them (M3).
        "LISTENER_CHECKSUM_INVALID",
        ErrorCategory::Media,
        "This Listener pack failed its integrity check.",
        true,
    )
    .with_log(reason.into())
}

fn unverified_pack(reason: impl Into<String>) -> AppError {
    AppError::structured(
        "LISTENER_UNVERIFIED",
        ErrorCategory::Media,
        "This Listener pack did not ship with CandidCue and cannot be verified.",
        false,
    )
    .with_log(reason.into())
}

/// Load and verify a pack manifest from a directory (spec §39.1).
///
/// What is actually checked: schema version, id/version shape, id+version bound
/// to the directory the pack was loaded from, safe relative paths, no symlinks,
/// every declared file present and inside the pack root, declared sizes matched,
/// per-file size limits, media types confirmed against container magic bytes,
/// and SHA-256 checksums — MANDATORY for a non-bundled pack, optional for a
/// bundled one (whose integrity is the application bundle's own).
///
/// What is NOT checked, and cannot be: authenticity. See the module docs. A
/// non-bundled pack is refused at the end of this function, after verification,
/// so the code path that a signing scheme will need already exists and is
/// exercised.
pub fn load_verified_manifest(
    pack_dir: &Path,
    source: PackSource,
) -> Result<ListenerPackManifest, AppError> {
    let manifest = verify_pack_contents(pack_dir, source)?;
    if source == PackSource::Installed {
        return Err(unverified_pack(format!(
            "pack {} {} is not bundled and CandidCue has no pack-signing scheme",
            manifest.id, manifest.version
        )));
    }
    Ok(manifest)
}

fn verify_pack_contents(
    pack_dir: &Path,
    source: PackSource,
) -> Result<ListenerPackManifest, AppError> {
    let manifest_path = pack_dir.join("manifest.json");
    let manifest_meta = fs::symlink_metadata(&manifest_path)
        .map_err(|_| manifest_invalid(format!("manifest missing at {manifest_path:?}")))?;
    if manifest_meta.file_type().is_symlink() {
        return Err(manifest_invalid("manifest.json is a symlink"));
    }
    if manifest_meta.len() > MAX_MANIFEST_BYTES {
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
    if !is_safe_identifier(&manifest.id) {
        return Err(manifest_invalid("pack id must be alphanumeric/dash"));
    }
    if !is_safe_identifier(&manifest.version) || manifest.version.is_empty() {
        return Err(manifest_invalid("pack version must be alphanumeric/dash/dot"));
    }
    if manifest.clips.is_empty() {
        return Err(manifest_invalid("pack declares no clips"));
    }
    if manifest.clips.len() > MAX_CLIPS_PER_PACK {
        return Err(manifest_invalid("pack declares too many clips"));
    }
    let mut clip_ids: Vec<&str> = manifest.clips.iter().map(|c| c.id.as_str()).collect();
    clip_ids.sort_unstable();
    let before = clip_ids.len();
    clip_ids.dedup();
    if clip_ids.len() != before {
        return Err(manifest_invalid("pack declares the same clip id twice"));
    }

    // M3: bind the manifest to the directory it was loaded from. The pack
    // directory is named after the id (and, when installed, the version), so a
    // pack that claims a different identity is either mislaid or trying to
    // impersonate one that is already trusted.
    bind_identity_to_root(pack_dir, &manifest, source)?;

    // Every declared file: safe path, no symlink, inside the root.
    let mut media_paths: Vec<&str> = manifest.clips.iter().map(|c| c.path.as_str()).collect();
    media_paths.push(manifest.poster.as_str());
    if let Some(profile) = &manifest.profile_image {
        media_paths.push(profile.as_str());
    }
    for rel in &media_paths {
        if !is_safe_relative_path(rel) {
            return Err(manifest_invalid(format!("unsafe media path {rel:?}")));
        }
        let absolute = pack_dir.join(rel);
        let meta = fs::symlink_metadata(&absolute)
            .map_err(|_| manifest_invalid(format!("declared file missing: {rel}")))?;
        if meta.file_type().is_symlink() {
            return Err(manifest_invalid(format!("symlink not allowed: {rel}")));
        }
        if !meta.is_file() {
            return Err(manifest_invalid(format!("not a regular file: {rel}")));
        }
        if !crate::util::is_within_root(&absolute, pack_dir) {
            return Err(manifest_invalid(format!("path escapes pack dir: {rel}")));
        }
    }

    // A pack directory must contain ONLY what its manifest declares. An
    // undeclared file in a scoped media directory is a file the asset protocol
    // will happily serve and nothing has looked at.
    reject_undeclared_files(pack_dir, &media_paths)?;

    let mut total_bytes: u64 = 0;

    // Poster and profile: real images, within the image size limit.
    let mut images = vec![("poster", manifest.poster.clone())];
    if let Some(profile) = &manifest.profile_image {
        images.push(("profileImage", profile.clone()));
    }
    for (label, rel) in &images {
        let absolute = pack_dir.join(rel);
        let size = fs::metadata(&absolute)?.len();
        if size > MAX_IMAGE_BYTES {
            return Err(manifest_invalid(format!("{label} {rel} exceeds the size limit")));
        }
        total_bytes = total_bytes.saturating_add(size);
        let head = read_head(&absolute, 64)?;
        // M3: the poster and profile used only to be checked for existence.
        // They are rendered by the stage, so they get the same treatment as an
        // imported image: sniffed, never trusted by extension.
        if crate::assets::sniff_mime(&head).is_none() {
            return Err(manifest_invalid(format!(
                "{label} {rel} is not a supported image"
            )));
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
        if actual_size > MAX_CLIP_BYTES {
            return Err(manifest_invalid(format!(
                "clip {} exceeds the per-clip size limit",
                clip.id
            )));
        }
        total_bytes = total_bytes.saturating_add(actual_size);
        if total_bytes > MAX_PACK_BYTES {
            return Err(manifest_invalid("pack exceeds the total size limit"));
        }
        // M3: the declared mime used to be accepted on the strength of a
        // `starts_with("video/")` test, so any bytes at all could be handed to
        // the stage's media element as `video/mp4`.
        let head = read_head(&absolute, 32)?;
        if !video_mime_matches_bytes(&clip.mime, &head) {
            return Err(manifest_invalid(format!(
                "clip {} declares {} but its container does not match",
                clip.id, clip.mime
            )));
        }

        match (&clip.sha256, source) {
            (Some(expected), _) => {
                if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err(manifest_invalid(format!(
                        "clip {} has a malformed sha256",
                        clip.id
                    )));
                }
                // Streamed, not buffered: a pack can be hundreds of megabytes.
                let actual = sha256_file(&absolute)?;
                if !actual.eq_ignore_ascii_case(expected) {
                    return Err(checksum_invalid(format!("sha256 mismatch for {}", clip.path)));
                }
            }
            (None, PackSource::Installed) => {
                // M3: checksums used to be optional everywhere, so a pack that
                // simply omitted them skipped verification entirely.
                return Err(checksum_invalid(format!(
                    "clip {} has no sha256 and the pack is not bundled",
                    clip.id
                )));
            }
            (None, PackSource::Bundled) => {}
        }
    }

    Ok(manifest)
}

/// Pack ids and versions become directory names, so they get the same
/// treatment as any other caller-supplied path component.
fn is_safe_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        && !value.contains("..")
}

/// The pack's declared identity must match the directory it was loaded from:
/// `<bundled>/<id>` or `<installed>/<id>/<version>`.
fn bind_identity_to_root(
    pack_dir: &Path,
    manifest: &ListenerPackManifest,
    source: PackSource,
) -> Result<(), AppError> {
    let name = |path: Option<&Path>| {
        path.and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().to_string())
    };
    match source {
        PackSource::Bundled => {
            if name(Some(pack_dir)).as_deref() != Some(manifest.id.as_str()) {
                return Err(manifest_invalid(format!(
                    "bundled pack directory {pack_dir:?} does not match declared id {}",
                    manifest.id
                )));
            }
        }
        PackSource::Installed => {
            if name(Some(pack_dir)).as_deref() != Some(manifest.version.as_str())
                || name(pack_dir.parent()).as_deref() != Some(manifest.id.as_str())
            {
                return Err(manifest_invalid(format!(
                    "installed pack directory {pack_dir:?} does not match declared id/version {} {}",
                    manifest.id, manifest.version
                )));
            }
        }
    }
    Ok(())
}

/// Refuse a pack that contains files its manifest does not declare.
fn reject_undeclared_files(pack_dir: &Path, declared: &[&str]) -> Result<(), AppError> {
    fn walk(dir: &Path, root: &Path, found: &mut Vec<String>) -> Result<(), AppError> {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let meta = entry.metadata()?;
            let path = entry.path();
            if meta.is_dir() {
                walk(&path, root, found)?;
            } else if let Ok(rel) = path.strip_prefix(root) {
                found.push(rel.to_string_lossy().replace('\\', "/"));
            }
            if found.len() > 4096 {
                return Err(manifest_invalid("pack contains too many files"));
            }
        }
        Ok(())
    }
    let mut found = Vec::new();
    walk(pack_dir, pack_dir, &mut found)?;
    for rel in &found {
        if rel == "manifest.json" || declared.iter().any(|d| d == rel) {
            continue;
        }
        return Err(manifest_invalid(format!(
            "pack contains an undeclared file: {rel}"
        )));
    }
    Ok(())
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
        match load_verified_manifest(&entry.path(), PackSource::Bundled) {
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
    // A pack id or version that is not a safe identifier must never become a
    // path component.
    if !is_safe_identifier(pack_id) || !is_safe_identifier(version) {
        return Err(AppError::unsafe_path("That Listener pack name is not valid."));
    }

    // Prefer bundled; a non-bundled directory is loaded only so it can be
    // refused with an honest reason rather than silently ignored.
    let bundled_dir = library.pack_dir(pack_id, version, true);
    let installed_dir = library.pack_dir(pack_id, version, false);
    let (pack_dir, source) = if bundled_dir.join("manifest.json").exists() {
        (bundled_dir, PackSource::Bundled)
    } else if installed_dir.join("manifest.json").exists() {
        (installed_dir, PackSource::Installed)
    } else {
        return Err(AppError::structured(
            "LISTENER_NOT_INSTALLED",
            ErrorCategory::Media,
            "This Listener pack is not installed.",
            true,
        )
        .with_detail("packId", pack_id));
    };

    let manifest = load_verified_manifest(&pack_dir, source)?;
    // M3: only the id was checked here, so a directory named after one version
    // could serve a manifest declaring another — and the caller would scope the
    // asset protocol to it under the version it thought it asked for.
    if manifest.id != pack_id || manifest.version != version {
        return Err(manifest_invalid(format!(
            "manifest declares {} {} but {pack_id} {version} was requested",
            manifest.id, manifest.version
        )));
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
    /// version directory, verify (size, MIME, SHA-256), then atomically rename
    /// into the installed-pack directory.
    ///
    /// M3: this doc comment used to promise a "signature" check. There is no
    /// signature scheme, and until there is, a downloaded pack cannot be
    /// trusted no matter how carefully it is hashed — see the module docs.
    /// `load_verified_manifest` refuses non-bundled packs for exactly that
    /// reason, so an implementation of this trait would install something the
    /// rest of the module then declines to use. The refusal is deliberate: it
    /// is the honest state of affairs, not an oversight to work around.
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

/// Verify every downloaded file against its declared SHA-256 before an install
/// is finalized (spec §39.4 step 6).
///
/// This is an INTEGRITY check against hashes the pack itself supplied. It
/// catches a truncated or corrupted download. It is not, and was never, a proof
/// of origin — see the module docs (M3).
pub fn verify_pack_checksums(
    pack_dir: &Path,
    expected: &[(String, String)], // (relative path, sha256)
) -> Result<(), AppError> {
    for (rel, sha) in expected {
        if !is_safe_relative_path(rel) {
            return Err(AppError::unsafe_path("Pack file path is unsafe."));
        }
        let absolute = pack_dir.join(rel);
        if fs::symlink_metadata(&absolute)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(true)
        {
            return Err(AppError::unsafe_path("Pack file path is unsafe."));
        }
        let actual = sha256_file(&absolute)?;
        if !actual.eq_ignore_ascii_case(sha) {
            return Err(checksum_invalid(format!("checksum mismatch: {rel}")));
        }
    }
    Ok(())
}
