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

/// A script's text, asked which asset files it uses (#253).
///
/// The reference rows cannot answer this: they record that a script OWNS a
/// file, from the moment it was imported, and nothing removes one when the
/// image's line is deleted. So the text is asked directly, and it is asked for
/// the file's name anywhere in it rather than parsed for image syntax. That is
/// deliberately generous — an inline image, a reference definition and a
/// mention in a code block all count — because the two ways of being wrong are
/// not alike: a stray name carries one extra file along, while a missed one
/// drops an image the text shows, and at startup deletes it. Every import
/// names a file after the SHA-256 of its bytes, so a name the text did not mean
/// is not a name it will contain by accident.
///
/// A file named by its hash is also used wherever its hash appears in the text
/// as the compiler reads a URL before resolving it: character references
/// decoded, whitespace and control characters dropped (`classifyUrl` in
/// `compile.ts`), and, since a hash is hex, in either case. So
/// `assets/&#51;055….png`, `<assets/3055 ….png>` and an extension written
/// `\.png` or `&#46;png` all keep the image, and so does `<HASH>.png` for a file
/// stored as `<hash>.png`, which on a case-insensitive disk is the same file.
pub(crate) struct AssetMentions<'a> {
    source: &'a str,
    as_a_url_reads: String,
}

impl<'a> AssetMentions<'a> {
    pub(crate) fn new(source: &'a str) -> Self {
        Self {
            source,
            as_a_url_reads: as_a_url_reads(source),
        }
    }

    pub(crate) fn uses(&self, file_name: &str) -> bool {
        if file_name.is_empty() {
            return false;
        }
        if self.source.contains(file_name) {
            return true;
        }
        match file_name.split_once('.') {
            Some((stem, _)) if stem.len() == 64 && stem.bytes().all(|b| b.is_ascii_hexdigit()) => {
                self.as_a_url_reads.contains(&stem.to_ascii_lowercase())
            }
            _ => false,
        }
    }
}

/// `source` with numeric character references decoded, whitespace and
/// control characters removed, and ASCII in lower case. `&Tab;` and
/// `&NewLine;` are the named references that decode to a character this then
/// drops, so they are dropped too; no named reference spells a hex digit.
fn as_a_url_reads(source: &str) -> String {
    fn push(out: &mut String, c: char) {
        if c > '\u{20}' && c != '\u{7f}' {
            out.push(c.to_ascii_lowercase());
        }
    }
    let mut out = String::with_capacity(source.len());
    let mut rest = source;
    while let Some(at) = rest.find('&') {
        rest[..at].chars().for_each(|c| push(&mut out, c));
        let after = &rest[at + 1..];
        if let Some(named) = ["Tab;", "NewLine;"].into_iter().find(|n| after.starts_with(n)) {
            rest = &after[named.len()..];
        } else if let Some((c, len)) = after.strip_prefix('#').and_then(numeric_reference) {
            push(&mut out, c);
            rest = &after[1 + len..];
        } else {
            out.push('&');
            rest = after;
        }
    }
    rest.chars().for_each(|c| push(&mut out, c));
    out
}

/// The character a numeric reference names, given what follows its `&#`, and
/// how many bytes of that it spans — by CommonMark's rule: up to seven decimal
/// or six hex digits and a closing `;`.
fn numeric_reference(after: &str) -> Option<(char, usize)> {
    let (radix, skip) = match after.as_bytes().first()? {
        b'x' | b'X' => (16, 1),
        _ => (10, 0),
    };
    let digits = &after[skip..];
    let len = digits.bytes().take_while(|b| (*b as char).is_digit(radix)).count();
    let max = if radix == 16 { 6 } else { 7 };
    if len == 0 || len > max || !digits[len..].starts_with(';') {
        return None;
    }
    let code = u32::from_str_radix(&digits[..len], radix).ok()?;
    let c = char::from_u32(code).filter(|c| *c != '\0').unwrap_or('\u{FFFD}');
    Some((c, skip + len + 1))
}

/// Remove the images in a script's folder that nothing can show any more
/// (#253): not its text, and not any saved version of it a restore could bring
/// back. Returns how many images went.
///
/// Deleting an image's line used to leave its file there for good. It cannot
/// go when the line does, because the line can come back — an undo replays
/// text that was never in a revision, and a restore replays one that was — so
/// this runs only from startup reconciliation, before the first command is
/// dispatched, when no editor holds an undo history at all. What a revision
/// still uses stays until retention thins that revision away.
///
/// The text that can come back is more than the revisions the database lists:
/// a snapshot is written before its row, and a rebuild indexes every snapshot
/// file it finds (#252), so every file in the revisions folder counts; and
/// text that could not be saved when the app closed is parked in
/// `quarantine/unsaved/` for the user to copy back by hand, so that counts
/// too.
///
/// It removes only what it can prove unused, and only images it indexed: a
/// file without an `assets` row was never registered (or was refused by
/// recovery) and is left where it is, and an image another script references
/// is left too. If any of that text cannot be read in full, nothing is
/// removed: text that cannot be read is evidence that is missing, not evidence
/// that the image is unused.
pub(crate) async fn collect_unused_script_assets(
    pool: &SqlitePool,
    paths: &DataPaths,
    script_id: &ScriptId,
) -> Result<u32, AppError> {
    let prefix = format!("scripts/{}/assets/", script_id.as_str());
    // Compared with `substr` rather than `LIKE`, as `permanently_delete_script`
    // does, so `%` and `_` can never act as wildcards.
    let indexed: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT rel_path FROM assets WHERE substr(rel_path, 1, ?) = ?",
    )
    .bind(prefix.len() as i64)
    .bind(&prefix)
    .fetch_all(pool)
    .await?;
    if indexed.is_empty() {
        return Ok(0);
    }

    let canonical_path = paths.canonical_file(script_id);
    let canonical = read_recoverable_text(&canonical_path)?;
    let mut unused: Vec<String> = {
        let mentions = AssetMentions::new(&canonical);
        indexed
            .into_iter()
            .filter(|rel_path| !mentions.uses(rel_path.rsplit('/').next().unwrap_or_default()))
            .collect()
    };
    if unused.is_empty() {
        return Ok(0);
    }

    for path in recoverable_texts(pool, paths, script_id).await? {
        let text = read_recoverable_text(&path)?;
        let mentions = AssetMentions::new(&text);
        unused.retain(|asset| !mentions.uses(asset.rsplit('/').next().unwrap_or_default()));
        if unused.is_empty() {
            return Ok(0);
        }
    }

    // An image another script still references is not this script's to remove
    // (and its row could not be deleted under the foreign key anyway) — under
    // any spelling of its path, since on a case-insensitive disk two spellings
    // are one file.
    let mut removable = Vec::with_capacity(unused.len());
    for rel_path in unused {
        let shared: bool = sqlx::query_scalar(
            "SELECT EXISTS (
                 SELECT 1 FROM script_asset_references r JOIN assets a ON a.id = r.asset_id
                 WHERE lower(a.rel_path) = lower(?) AND r.script_id != ?
             )",
        )
        .bind(&rel_path)
        .bind(script_id.as_str())
        .fetch_one(pool)
        .await?;
        if !shared {
            removable.push(rel_path);
        }
    }
    if removable.is_empty() {
        return Ok(0);
    }

    // Only inside the script's own folder. `is_within_root` canonicalizes both
    // sides, so an `assets/` that is a link would pass a check against itself
    // while every file in it is somewhere else — another script's images, or
    // the user's. A folder that is not there holds no files to remove, and its
    // rows can still go.
    let assets_root = paths.assets_dir(script_id);
    match fs::symlink_metadata(&assets_root) {
        Ok(meta) if meta.is_dir() && crate::util::is_within_root(&assets_root, &paths.scripts_dir()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        _ => {
            return Err(AppError::Internal(
                "its assets folder is not a folder inside the library".into(),
            ))
        }
    }
    // The text was read a moment ago, and nothing in the app can write it
    // before the first command — but an outside editor can. One that saved in
    // between may have put an image back.
    if read_recoverable_text(&canonical_path)? != canonical {
        return Err(AppError::Internal("its text changed while it was being checked".into()));
    }

    // Files first, then their rows. A crash between the two leaves rows for
    // files already gone, which nothing shows and the next launch clears; the
    // other order would leave files that nothing indexes any more, which no
    // later launch would ever look at again. A file that cannot be removed
    // keeps its row, for the same reason.
    let mut forget = Vec::with_capacity(removable.len());
    let mut unlinked = Vec::with_capacity(removable.len());
    for rel_path in &removable {
        let absolute = paths.root().join(rel_path);
        match fs::symlink_metadata(&absolute) {
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => forget.push(rel_path),
            Ok(meta) if meta.is_file() && crate::util::is_within_root(&absolute, &assets_root) => {
                match fs::remove_file(&absolute) {
                    Ok(()) => unlinked.push(rel_path),
                    Err(err) => tracing::warn!(
                        script_id = script_id.as_str(),
                        error = %err,
                        "an unused image could not be removed"
                    ),
                }
            }
            _ => tracing::warn!(
                script_id = script_id.as_str(),
                rel_path = %rel_path,
                "an unused image is not a plain file in its script's folder, and was left"
            ),
        }
    }
    // The removals must outlast a power cut before the rows that describe the
    // files go; otherwise the commit survives and the unlink does not.
    let removed = unlinked.len() as u32;
    if !unlinked.is_empty() {
        crate::util::sync_dir(&assets_root)?;
        forget.extend(unlinked);
    }
    let mut tx = pool.begin().await?;
    for rel_path in forget {
        sqlx::query(
            "DELETE FROM script_asset_references
             WHERE script_id = ? AND asset_id IN (SELECT id FROM assets WHERE rel_path = ?)",
        )
        .bind(script_id.as_str())
        .bind(rel_path)
        .execute(&mut *tx)
        .await?;
        sqlx::query("DELETE FROM assets WHERE rel_path = ?")
            .bind(rel_path)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(removed)
}

/// A file of script text, whole. Bytes, decoded leniently: a name is ASCII, and
/// a snapshot that is not valid UTF-8 can still name an image. Larger than a
/// script can be is refused rather than read into memory at startup — and, as
/// text that could not be read, stops the sweep for that script.
fn read_recoverable_text(path: &Path) -> Result<String, AppError> {
    use std::io::Read;
    let limit = crate::scripts::repo::MAX_SOURCE_BYTES as u64;
    // Through `take`, not after a size check: a file can be replaced, or grow,
    // between looking at it and reading it.
    let mut bytes = Vec::new();
    fs::File::open(path)?.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(AppError::Internal(format!(
            "{} is larger than a script can be",
            path.file_name().unwrap_or_default().to_string_lossy()
        )));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Every file holding text of `script_id` that could come back: the revisions
/// the database lists, everything else in its revisions folder, and the
/// unsaved text parked for it when the app closed.
async fn recoverable_texts(
    pool: &SqlitePool,
    paths: &DataPaths,
    script_id: &ScriptId,
) -> Result<Vec<PathBuf>, AppError> {
    let mut found = std::collections::BTreeSet::new();
    let indexed: Vec<String> =
        sqlx::query_scalar("SELECT rel_path FROM script_revisions WHERE script_id = ?")
            .bind(script_id.as_str())
            .fetch_all(pool)
            .await?;
    for rel_path in indexed {
        found.insert(paths.root().join(rel_path));
    }

    let mut notes = Vec::new();
    if let Some(entries) = crate::util::read_owned_dir(&paths.revisions_dir(script_id), &mut notes)? {
        for entry in entries {
            let entry = entry?;
            if entry.file_type()?.is_file() {
                found.insert(entry.path());
            }
        }
    }
    // A revisions folder that is a link, or not a folder, was not looked in —
    // which is not the same as having nothing in it.
    if let Some(note) = notes.into_iter().next() {
        return Err(AppError::Internal(format!("revisions not read: {note}")));
    }

    let prefix = format!("{}-", script_id.as_str());
    match fs::read_dir(paths.quarantine_dir().join("unsaved")) {
        Ok(entries) => {
            for entry in entries {
                let entry = entry?;
                if entry.file_type()?.is_file()
                    && entry.file_name().to_string_lossy().starts_with(&prefix)
                {
                    found.insert(entry.path());
                }
            }
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err.into()),
    }
    Ok(found.into_iter().collect())
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

/// An image already in a script's asset folder, proved to be what its name
/// says it is.
#[derive(Debug, Clone)]
pub(crate) struct RecoveredAsset {
    sha256: String,
    mime: &'static str,
    extension: &'static str,
    size: u64,
    width: u32,
    height: u32,
    rel_path: String,
}

/// The images in a script's asset folder that can be indexed again, and a note
/// for each file that looked like one and could not be (#252).
///
/// After a rebuild the files are all still there but nothing knows about them,
/// and an image resolves only through its `assets` row — so every image in
/// every script stopped rendering. Every file is held to the standard an import
/// is: named by the SHA-256 of exactly its bytes, the extension its magic bytes
/// call for, within the size limit, and a real decode under the dimension
/// limits. What fails stays where it is, untouched and unindexed.
pub(crate) fn scan_asset_files(
    paths: &DataPaths,
    script_id: &ScriptId,
) -> Result<(Vec<RecoveredAsset>, Vec<String>), AppError> {
    let mut found = Vec::new();
    let mut skipped = Vec::new();
    let Some(entries) = crate::util::read_owned_dir(&paths.assets_dir(script_id), &mut skipped)?
    else {
        return Ok((found, skipped));
    };
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        // Finder's `.DS_Store` and an interrupted write's temporary file are
        // not images anybody placed, and not worth a note each.
        if name.starts_with('.') || name.contains(".tmp-") {
            continue;
        }
        match recover_asset_file(script_id, &entry, &name) {
            Ok(asset) => found.push(asset),
            Err(reason) => skipped.push(format!("image assets/{name} was not indexed: {reason}")),
        }
    }
    found.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok((found, skipped))
}

fn recover_asset_file(
    script_id: &ScriptId,
    entry: &fs::DirEntry,
    name: &str,
) -> Result<RecoveredAsset, &'static str> {
    // `DirEntry::file_type` does not follow links, so a symlink is refused
    // here rather than read through.
    if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
        return Err("not a regular file");
    }
    let (stem, extension) = name.rsplit_once('.').ok_or("not named by its content")?;
    if stem.len() != 64 || !stem.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err("not named by its content");
    }
    let size = entry.metadata().map_err(|_| "unreadable")?.len();
    if size > MAX_IMPORTED_IMAGE_BYTES {
        return Err("larger than an import allows");
    }
    let bytes = fs::read(entry.path()).map_err(|_| "unreadable")?;
    if sha256_hex(&bytes) != stem {
        return Err("its contents do not match its name");
    }
    let mime = sniff_mime(&bytes).ok_or("not a supported image")?;
    if extension_for_mime(mime) != extension {
        return Err("its extension does not match its contents");
    }
    let (width, height) =
        validate_image_payload(&bytes, mime).map_err(|_| "not a valid image")?;
    Ok(RecoveredAsset {
        sha256: stem.to_string(),
        mime,
        extension: extension_for_mime(mime),
        size: bytes.len() as u64,
        width,
        height,
        rel_path: format!("scripts/{}/assets/{name}", script_id.as_str()),
    })
}

/// Index recovered images for `script_id`, inside the caller's transaction.
///
/// The reference row is what keeps `collect_garbage` from deleting the file as
/// unreferenced, so it is not optional. It is inserted only when absent,
/// rather than with `INSERT OR IGNORE`: its primary key includes the nullable
/// `source_start`, and SQLite treats every NULL as distinct, so the conflict
/// clause never fires for a reference without a source range.
pub(crate) async fn register_recovered_assets(
    conn: &mut sqlx::SqliteConnection,
    script_id: &ScriptId,
    assets: &[RecoveredAsset],
) -> Result<(), AppError> {
    let now = now_iso();
    for asset in assets {
        sqlx::query(
            "INSERT INTO assets (id, sha256, mime_type, extension, size_bytes, width, height, rel_path, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(sha256, rel_path) DO NOTHING",
        )
        .bind(new_uuid())
        .bind(&asset.sha256)
        .bind(asset.mime)
        .bind(asset.extension)
        .bind(asset.size as i64)
        .bind(asset.width as i64)
        .bind(asset.height as i64)
        .bind(&asset.rel_path)
        .bind(&now)
        .execute(&mut *conn)
        .await?;
        // By hash AND path: the schema allows two rows for one path, and the
        // reference must protect the row describing these bytes.
        let asset_id: String =
            sqlx::query_scalar("SELECT id FROM assets WHERE sha256 = ? AND rel_path = ?")
                .bind(&asset.sha256)
                .bind(&asset.rel_path)
                .fetch_one(&mut *conn)
                .await?;
        sqlx::query(
            "INSERT INTO script_asset_references (script_id, asset_id, role, created_at)
             SELECT ?, ?, 'image', ?
             WHERE NOT EXISTS (
                 SELECT 1 FROM script_asset_references WHERE script_id = ? AND asset_id = ?
             )",
        )
        .bind(script_id.as_str())
        .bind(&asset_id)
        .bind(&now)
        .bind(script_id.as_str())
        .bind(&asset_id)
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
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

    /// #253: what an export carries and what startup keeps is decided by the
    /// text, generously — any mention keeps an image, however it is written.
    #[test]
    fn an_asset_is_used_wherever_the_text_names_it() {
        let hash = "305519f5".repeat(8);
        let name = format!("{hash}.png");
        let uses = |source: &str, file_name: &str| AssetMentions::new(source).uses(file_name);
        for source in [
            format!("![Kept](assets/{name})"),
            format!("![Kept][shot]\n\n[shot]: assets/{name}\n"),
            format!("<img src=\"assets/{name}\">"),
            format!("```\nassets/{name}\n```"),
            format!("![Kept]({name})"),
            // What the compiler decodes or drops before it resolves a path.
            format!("![Kept](assets/{hash}\\.png)"),
            format!("![Kept](assets/{hash}&#46;png)"),
            format!("![Kept](assets/&#51;{}.png)", &hash[1..]),
            format!("![Kept](assets/&#x33;{}.png)", &hash[1..]),
            format!("![Kept](<assets/{} {}.png>)", &hash[..8], &hash[8..]),
            format!("![Kept](assets/{}&Tab;{}.png)", &hash[..32], &hash[32..]),
            format!("![Kept](assets/{}&NewLine;{}.png)", &hash[..32], &hash[32..]),
            // On a case-insensitive disk, the same file.
            format!("![Kept](assets/{}.png)", hash.to_ascii_uppercase()),
        ] {
            assert!(uses(&source, &name), "{source}");
        }
        // An uppercase name, as a bundle may carry, written in lower case.
        assert!(uses(&format!("![](assets/{name})"), &name.to_ascii_uppercase()));

        let other = format!("{}.png", "d6593080".repeat(8));
        assert!(!uses(&format!("![Kept](assets/{name})"), &other));
        assert!(!uses("Just words.", &name));
        assert!(!uses("Just words.", ""));
        // A reference that is not one is left as written.
        assert!(!uses(&format!("assets/&#99999999;{}.png", &hash[1..]), &name));
        // A name that is not a hash is matched as written.
        assert!(uses("![](assets/photo.png)", "photo.png"));
        assert!(!uses("![](assets/photo.jpg)", "photo.png"));
    }

    #[test]
    fn numeric_references_decode_as_commonmark_reads_them() {
        assert_eq!(as_a_url_reads("A&#66;c&#x44;&#X65;"), "abcde");
        assert_eq!(as_a_url_reads("&#0; &#; &#x; &#12345678; &#1"), "\u{fffd}&#;&#x;&#12345678;&#1");
        assert_eq!(as_a_url_reads("&#38;#51; x"), "&#51;x");
        assert_eq!(as_a_url_reads("a&Tab;b&NewLine;c&tab;&amp;"), "abc&tab;&amp;");
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
