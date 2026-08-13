//! Script asset management (spec §44.5, §47.8): validated image import,
//! MIME sniffing by magic bytes, hash/deduplication into per-script asset
//! directories, scoped asset-protocol URLs, and basic garbage collection.

use std::fs;
use std::path::{Path, PathBuf};

use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::Serialize;
use sqlx::{Row, SqlitePool};

use crate::errors::{AppError, ErrorCategory};
use crate::scripts::{DataPaths, ScriptId};
use crate::util::{new_uuid, now_iso, sha256_hex};

pub mod remote;

pub use remote::{fetch_remote_image, FetchPolicy};

/// Hard limit for an imported image (spec Appendix A.10).
pub const MAX_IMPORTED_IMAGE_BYTES: u64 = 25 * 1024 * 1024;

/// Decompression-bomb guards (spec §50.7). A 30000×30000 PNG is ~100 bytes on
/// the wire and 3.6 GB decoded, so the header dimensions are checked BEFORE any
/// decoder is allowed to allocate.
pub const MAX_IMAGE_DIMENSION: u32 = 16_384;
pub const MAX_IMAGE_PIXELS: u64 = 64_000_000;
/// Ceiling on what a decoder may allocate while proving the payload decodes.
pub const MAX_IMAGE_DECODE_ALLOC_BYTES: u64 = 384 * 1024 * 1024;

/// Twin of the `ImportedAsset` shape used by the editor.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedAsset {
    pub asset_id: String,
    pub sha256: String,
    pub mime: String,
    pub extension: String,
    pub size_bytes: u64,
    /// Markdown-relative path (`assets/<sha256>.<ext>`) for source insertion.
    pub markdown_path: String,
    /// Scoped asset-protocol URL for immediate preview.
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetUrlEntry {
    pub url: String,
    pub mime: String,
}

/// Magic-byte MIME sniffing for the supported image formats. Never trusts
/// the file extension alone.
///
/// SVG is deliberately NOT sniffable. It used to be recognised here and stored
/// verbatim, which meant `<svg><script>…</script></svg>` could be written into a
/// script's asset directory and then rendered by the stage webview — an active
/// content format inside the one window that is supposed to have no script
/// surface of its own (spec §50.10). The bundle importer already refused it;
/// now every import path does.
pub fn sniff_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() < 12 {
        return None;
    }
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

pub fn extension_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "bin",
    }
}

/// The `image` format that corresponds to a sniffed MIME type.
fn decoder_format_for_mime(mime: &str) -> Option<image::ImageFormat> {
    match mime {
        "image/png" => Some(image::ImageFormat::Png),
        "image/jpeg" => Some(image::ImageFormat::Jpeg),
        "image/gif" => Some(image::ImageFormat::Gif),
        "image/webp" => Some(image::ImageFormat::WebP),
        _ => None,
    }
}

/// Prove a payload really is the image its magic bytes claim: the header must
/// parse, its dimensions must be sane, and a real decode must succeed under
/// explicit width/height/allocation limits.
///
/// Magic-byte sniffing alone is a four-byte prefix check — it says nothing
/// about what a decoder will do with the remaining 25 MB. The dimension check
/// runs first and reads only the header, so a decompression bomb is refused
/// without ever allocating its pixel buffer.
pub fn validate_image_payload(bytes: &[u8], sniffed_mime: &str) -> Result<(u32, u32), AppError> {
    let expected = decoder_format_for_mime(sniffed_mime).ok_or_else(unsupported_asset)?;

    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
    limits.max_alloc = Some(MAX_IMAGE_DECODE_ALLOC_BYTES);

    let make_reader = || {
        let mut reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), expected);
        reader.limits(limits.clone());
        reader
    };

    // Header only: cheap, and the sole check that runs before any allocation.
    let (width, height) = make_reader()
        .into_dimensions()
        .map_err(|e| unsupported_asset().with_log(format!("image header unreadable: {e}")))?;
    if width == 0 || height == 0 {
        return Err(unsupported_asset().with_log("image reports a zero dimension"));
    }
    if width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION {
        return Err(image_too_large().with_log(format!("{width}x{height} exceeds the edge limit")));
    }
    if u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS {
        return Err(image_too_large().with_log(format!("{width}x{height} exceeds the pixel limit")));
    }

    // And it must actually decode: a valid header in front of garbage is not an
    // image, it is a file that happens to start with the right four bytes.
    make_reader()
        .decode()
        .map_err(|e| unsupported_asset().with_log(format!("image failed to decode: {e}")))?;
    Ok((width, height))
}

fn unsupported_asset() -> AppError {
    AppError::structured(
        "ASSET_UNSUPPORTED",
        ErrorCategory::Media,
        "Only PNG, JPEG, GIF, and WebP images can be imported.",
        true,
    )
}

fn image_too_large() -> AppError {
    AppError::structured(
        "ASSET_UNSUPPORTED",
        ErrorCategory::Media,
        "That image is too large to import.",
        true,
    )
}

fn asset_too_large() -> AppError {
    AppError::structured(
        "ASSET_TOO_LARGE",
        ErrorCategory::Media,
        "Images larger than 25 MB cannot be imported.",
        true,
    )
}

/// Platform-appropriate Tauri asset protocol URL for an absolute path.
/// Frontends must use these instead of converting arbitrary paths.
pub fn asset_url(path: &Path) -> String {
    let encoded = utf8_percent_encode(&path.to_string_lossy(), NON_ALPHANUMERIC).to_string();
    if cfg!(windows) {
        format!("http://asset.localhost/{encoded}")
    } else {
        format!("asset://localhost/{encoded}")
    }
}

/*
 * Nine arguments because the row has nine columns. Grouping them into a struct
 * would move the same fields one indirection away from the `INSERT` that has
 * to list them in order, which is where a mismatch would actually be caught.
 */
#[allow(clippy::too_many_arguments)]
async fn register_asset(
    pool: &SqlitePool,
    script_id: &ScriptId,
    sha: &str,
    mime: &str,
    extension: &str,
    size: u64,
    rel_path: &str,
    original_name: Option<&str>,
    original_url: Option<&str>,
) -> Result<String, AppError> {
    let now = now_iso();
    sqlx::query(
        "INSERT INTO assets (id, sha256, mime_type, extension, size_bytes, rel_path, original_name, original_url, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(sha256, rel_path) DO NOTHING",
    )
    .bind(new_uuid())
    .bind(sha)
    .bind(mime)
    .bind(extension)
    .bind(size as i64)
    .bind(rel_path)
    .bind(original_name)
    .bind(original_url)
    .bind(&now)
    .execute(pool)
    .await?;
    let asset_id: String = sqlx::query_scalar("SELECT id FROM assets WHERE rel_path = ? LIMIT 1")
        .bind(rel_path)
        .fetch_one(pool)
        .await?;
    sqlx::query(
        "INSERT OR IGNORE INTO script_asset_references (script_id, asset_id, role, created_at)
         VALUES (?, ?, 'image', ?)",
    )
    .bind(script_id.as_str())
    .bind(&asset_id)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(asset_id)
}

fn store_bytes(
    paths: &DataPaths,
    script_id: &ScriptId,
    bytes: &[u8],
) -> Result<(String, String, String, PathBuf), AppError> {
    let mime = sniff_mime(bytes).ok_or_else(unsupported_asset)?;
    // Nothing reaches a managed asset directory without decoding first.
    validate_image_payload(bytes, mime)?;
    let sha = sha256_hex(bytes);
    let extension = extension_for_mime(mime);
    let file_name = format!("{sha}.{extension}");
    let dest = paths.assets_dir(script_id).join(&file_name);
    if !dest.exists() {
        crate::util::atomic_write(&dest, bytes)?;
    }
    Ok((mime.to_string(), sha, file_name, dest))
}

/// Import a local image file (path from the native open dialog) into the
/// per-script asset directory, deduplicated by content hash.
pub async fn import_image(
    pool: &SqlitePool,
    paths: &DataPaths,
    script_id: &ScriptId,
    source_file: &str,
) -> Result<ImportedAsset, AppError> {
    if !crate::scripts::repo::script_exists(pool, script_id).await? {
        return Err(AppError::not_found("script"));
    }
    let source_path = PathBuf::from(source_file);
    if !source_path.is_absolute() {
        return Err(AppError::unsafe_path("Image paths must come from the file picker."));
    }
    let meta = fs::symlink_metadata(&source_path)?;
    if meta.file_type().is_symlink() {
        return Err(AppError::unsafe_path("Symbolic links cannot be imported."));
    }
    if meta.len() > MAX_IMPORTED_IMAGE_BYTES {
        return Err(asset_too_large());
    }
    let bytes = fs::read(&source_path)?;
    let (mime, sha, file_name, dest) = store_bytes(paths, script_id, &bytes)?;
    let rel_path = format!("scripts/{}/assets/{file_name}", script_id.as_str());
    let original_name = source_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string());
    let asset_id = register_asset(
        pool,
        script_id,
        &sha,
        &mime,
        extension_for_mime(&mime),
        bytes.len() as u64,
        &rel_path,
        original_name.as_deref(),
        None,
    )
    .await?;
    Ok(ImportedAsset {
        asset_id,
        sha256: sha,
        mime: mime.clone(),
        extension: extension_for_mime(&mime).to_string(),
        size_bytes: bytes.len() as u64,
        markdown_path: format!("assets/{file_name}"),
        url: asset_url(&dest),
        original_name,
    })
}

/// Download a remote image and store it like a local import
/// (spec §24.2, §46.3 `import_remote_image`).
///
/// All of the transport hardening lives in [`remote::fetch_remote_image`]:
/// https on every hop, publicly-routable resolved addresses, pinned DNS,
/// manual redirect revalidation, a streamed body with a hard cap, an allowed
/// `Content-Type` that must agree with the magic bytes, and a real decode under
/// dimension limits. This function only persists what came back.
pub async fn import_remote_image(
    pool: &SqlitePool,
    paths: &DataPaths,
    script_id: &ScriptId,
    url: &str,
) -> Result<ImportedAsset, AppError> {
    if !crate::scripts::repo::script_exists(pool, script_id).await? {
        return Err(AppError::not_found("script"));
    }
    let fetched = remote::fetch_remote_image(url, &remote::FetchPolicy::strict()).await?;
    let bytes = fetched.bytes;

    let (mime, sha, file_name, dest) = store_bytes(paths, script_id, &bytes)?;
    let rel_path = format!("scripts/{}/assets/{file_name}", script_id.as_str());
    let asset_id = register_asset(
        pool,
        script_id,
        &sha,
        &mime,
        extension_for_mime(&mime),
        bytes.len() as u64,
        &rel_path,
        None,
        // The url that was actually fetched, after redirects — recording the
        // requested one would misattribute where the bytes came from.
        Some(fetched.final_url.as_str()),
    )
    .await?;
    Ok(ImportedAsset {
        asset_id,
        sha256: sha,
        mime: mime.clone(),
        extension: extension_for_mime(&mime).to_string(),
        size_bytes: bytes.len() as u64,
        markdown_path: format!("assets/{file_name}"),
        url: asset_url(&dest),
        original_name: None,
    })
}

/// One asset the compiler wants resolved. `id` is the compiler's synthetic
/// node key (`img-<hash>`), which is NOT a database id; `href` is the path the
/// Markdown actually authored (`assets/<file>`). Resolution keys off the path
/// and answers under the caller's `id`.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetRequest {
    pub id: String,
    #[serde(default)]
    pub href: String,
}

/// Resolve scoped asset URLs for a script (spec §46.3). Paths are validated
/// to stay inside the script's asset directory.
///
/// Assets are looked up by *canonical path*, not by id. The Markdown compiler
/// mints `img-<hash-of-url>` node keys while imported assets carry database
/// UUIDs, so an id-keyed lookup can never match and every imported image
/// silently vanished from the stage. The authored href (`assets/<file>`) is
/// the only durable link between the two, and `assets.rel_path` already
/// encodes the owning script, so matching on it stays script-scoped.
pub async fn resolve_asset_urls(
    pool: &SqlitePool,
    paths: &DataPaths,
    script_id: &ScriptId,
    requests: &[AssetRequest],
) -> Result<std::collections::HashMap<String, AssetUrlEntry>, AppError> {
    let mut map = std::collections::HashMap::new();
    let assets_root = paths.assets_dir(script_id);
    let rel_prefix = format!("scripts/{}/assets/", script_id.as_str());
    for request in requests {
        // An id-keyed hit still wins when the caller genuinely has a DB id.
        let mut row = sqlx::query(
            "SELECT a.rel_path, a.mime_type FROM assets a
             JOIN script_asset_references r ON r.asset_id = a.id
             WHERE a.id = ? AND r.script_id = ?",
        )
        .bind(&request.id)
        .bind(script_id.as_str())
        .fetch_optional(pool)
        .await?;

        if row.is_none() {
            if let Some(file_name) = asset_file_name(&request.href) {
                row = sqlx::query(
                    "SELECT a.rel_path, a.mime_type FROM assets a
                     WHERE a.rel_path = ?",
                )
                .bind(format!("{rel_prefix}{file_name}"))
                .fetch_optional(pool)
                .await?;
            }
        }

        let Some(row) = row else { continue };
        let rel_path: String = row.try_get("rel_path")?;
        let mime: String = row.try_get("mime_type")?;
        let absolute = paths.root().join(&rel_path);
        if !absolute.exists() || !crate::util::is_within_root(&absolute, &assets_root) {
            continue;
        }
        map.insert(
            request.id.clone(),
            AssetUrlEntry {
                url: asset_url(&absolute),
                mime,
            },
        );
    }
    Ok(map)
}

/// Final path segment of an authored asset reference, rejecting anything that
/// tries to escape the script's asset directory or name a remote resource.
fn asset_file_name(href: &str) -> Option<&str> {
    let href = href.trim();
    if href.is_empty() || href.contains("..") || href.contains(':') || href.starts_with('/') {
        return None;
    }
    let name = href.rsplit('/').next()?;
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

/// Drop a script→asset reference; the file itself is collected by GC once
/// nothing references it.
pub async fn remove_asset_reference(
    pool: &SqlitePool,
    script_id: &ScriptId,
    asset_id: &str,
) -> Result<(), AppError> {
    sqlx::query("DELETE FROM script_asset_references WHERE script_id = ? AND asset_id = ?")
        .bind(script_id.as_str())
        .bind(asset_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Garbage collection basics (spec §24.8): remove asset rows/files that no
/// script references any more. Returns the number of files removed.
pub async fn collect_garbage(pool: &SqlitePool, paths: &DataPaths) -> Result<u32, AppError> {
    let rows = sqlx::query(
        "SELECT a.id, a.rel_path FROM assets a
         LEFT JOIN script_asset_references r ON r.asset_id = a.id
         WHERE r.asset_id IS NULL",
    )
    .fetch_all(pool)
    .await?;
    let mut removed = 0u32;
    for row in &rows {
        let id: String = row.try_get("id")?;
        let rel_path: String = row.try_get("rel_path")?;
        sqlx::query("DELETE FROM assets WHERE id = ?")
            .bind(&id)
            .execute(pool)
            .await?;
        let absolute = paths.root().join(&rel_path);
        if absolute.exists() && crate::util::is_within_root(&absolute, &paths.scripts_dir()) {
            let _ = fs::remove_file(&absolute);
            removed += 1;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffs_common_formats() {
        assert_eq!(
            sniff_mime(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]),
            Some("image/png")
        );
        let mut jpeg = vec![0xFF, 0xD8, 0xFF, 0xE0];
        jpeg.extend_from_slice(&[0; 12]);
        assert_eq!(sniff_mime(&jpeg), Some("image/jpeg"));
        assert_eq!(sniff_mime(b"GIF89a-not-really" as &[u8]), Some("image/gif"));
        let mut webp = b"RIFF".to_vec();
        webp.extend_from_slice(&[0, 0, 0, 0]);
        webp.extend_from_slice(b"WEBPVP8 ");
        assert_eq!(sniff_mime(&webp), Some("image/webp"));
        assert_eq!(sniff_mime(&[0u8; 32]), None);
    }

    /// SVG is an active-content format. It used to sniff as `image/svg+xml`
    /// and be stored verbatim in a script's asset directory, where the stage
    /// webview would render it (spec §50.10).
    #[test]
    fn svg_is_not_a_recognised_image() {
        assert_eq!(sniff_mime(b"<svg xmlns='x'></svg>" as &[u8]), None);
        assert_eq!(
            sniff_mime(b"<?xml version='1.0'?><svg><script>x</script></svg>" as &[u8]),
            None
        );
        assert_eq!(extension_for_mime("image/svg+xml"), "bin");
    }

    /// A valid four-byte prefix in front of garbage is not an image, and a
    /// header that declares 900 megapixels must never reach a decoder.
    #[test]
    fn payload_validation_needs_a_real_decodable_image() {
        assert!(validate_image_payload(remote::tests_support::TINY_PNG, "image/png").is_ok());

        let mut fake = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        fake.extend_from_slice(&[0u8; 64]);
        assert_eq!(sniff_mime(&fake), Some("image/png"));
        assert!(
            validate_image_payload(&fake, "image/png").is_err(),
            "magic bytes alone must not be enough to enter an asset directory"
        );

        let bomb = remote::tests_support::huge_png_header();
        assert_eq!(sniff_mime(&bomb), Some("image/png"));
        let err = validate_image_payload(&bomb, "image/png")
            .expect_err("a 30000x30000 header must be refused");
        assert_eq!(err.code(), "ASSET_UNSUPPORTED");
    }

    #[test]
    fn resolves_authored_asset_paths_to_a_file_name() {
        // The compiler's `img-<hash>` id can never match a database UUID, so
        // resolution keys off the authored href instead.
        assert_eq!(asset_file_name("assets/pipeline.png"), Some("pipeline.png"));
        assert_eq!(asset_file_name("pipeline.png"), Some("pipeline.png"));
        assert_eq!(
            asset_file_name("  assets/nested/deep.webp  "),
            Some("deep.webp")
        );
    }

    #[test]
    fn rejects_hrefs_that_escape_the_script_asset_directory() {
        assert_eq!(asset_file_name("../../../etc/passwd"), None);
        assert_eq!(asset_file_name("assets/../../secret.png"), None);
        assert_eq!(asset_file_name("/etc/passwd"), None);
        assert_eq!(asset_file_name("https://example.com/x.png"), None);
        assert_eq!(asset_file_name("file:///etc/passwd"), None);
        assert_eq!(asset_file_name(""), None);
        assert_eq!(asset_file_name("   "), None);
        assert_eq!(asset_file_name("assets/"), None);
    }
}
