//! Script import and export (spec §21.6, §46.2).
//!
//! Accepted import formats: `.md`, `.markdown`, `.txt`, and the
//! ZIP-compatible `.candidcue` bundle (manifest.json + script.md + assets/).
//! The bundle importer rejects path traversal, absolute paths, symlinks,
//! undeclared/oversized files, and decompression bombs.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::errors::AppError;
use crate::util::{atomic_write, is_safe_relative_path, new_uuid, now_iso, sha256_hex};

use super::repo::{self, MAX_SOURCE_BYTES};
use super::words::{spoken_plain_text, spoken_text, SpokenTextOptions};
use super::{into_without_bom, DataPaths, ScriptId, ScriptLocks, ScriptSummary};

/// Spec Appendix A.10 limits.
const MAX_BUNDLE_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_BUNDLE_ASSET_BYTES: u64 = 25 * 1024 * 1024;
const MAX_BUNDLE_TOTAL_BYTES: u64 = 600 * 1024 * 1024;
const MAX_BUNDLE_FILE_COUNT: usize = 256;

/// Already-authorized import parameters.
///
/// `path` is NOT an IPC field any more. It is filled in by
/// `commands::scripts_cmds::import_script`, which runs the native picker in
/// Rust and passes what the operator actually chose (see `crate::dialogs`).
/// JavaScript sends `ImportRequest`, which has no path at all.
#[derive(Debug, Clone)]
pub struct ImportOptions {
    /// Absolute path the operator selected in the native open dialog.
    pub path: String,
    pub title: Option<String>,
}

/// What the control webview may ask for: a title override, nothing else.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub script: ScriptSummary,
    pub warnings: Vec<String>,
}

/// Already-authorized export parameters. Like [`ImportOptions`], `destination`
/// is supplied by the Rust-side save dialog, never by JavaScript.
#[derive(Debug, Clone)]
pub struct ExportOptions {
    /// Absolute destination the operator selected in the native save dialog.
    pub destination: String,
    /// 'markdown' | 'text' | 'bundle'.
    pub format: String,
    pub include_assets: bool,
}

/// What the control webview may ask for: which format, and whether to copy
/// images alongside a Markdown export.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    /// 'markdown' | 'text' | 'bundle'.
    pub format: String,
    #[serde(default)]
    pub include_assets: bool,
    /// Seeds the save dialog's file name only; never used as a path.
    #[serde(default)]
    pub suggested_name: Option<String>,
}

/// The three formats, their save-dialog extension, and their filter label.
pub fn export_format_extension(format: &str) -> Result<(&'static str, &'static str), AppError> {
    match format {
        "markdown" => Ok(("md", "Markdown")),
        "text" => Ok(("txt", "Plain text")),
        "bundle" => Ok(("candidcue", "CandidCue bundle")),
        other => Err(AppError::invalid_input(format!(
            "Unknown export format: {other}. Use markdown, text, or bundle."
        ))),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub format: String,
    pub warnings: Vec<String>,
}

/// Bundle manifest schema (fixed, spec §21.6).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BundleManifest {
    schema_version: u32,
    title: String,
    #[serde(default)]
    language: Option<String>,
    #[serde(default)]
    exported_at: Option<String>,
    #[serde(default)]
    assets: Vec<String>,
}

/// Asset file names a bundle may contain: `<sha256>.<ext>` for an image type
/// the app actually decodes. SVG is excluded — it is active content, and the
/// importer has no sanitiser.
const ALLOWED_BUNDLE_ASSET_EXTENSIONS: [&str; 4] = ["png", "jpg", "gif", "webp"];

/// Spec §21.6 / H6: the manifest is the authority for what a bundle contains.
fn validate_declared_assets(
    declared: &[String],
    actual: &[(String, Vec<u8>)],
) -> Result<(), AppError> {
    let mut declared_sorted: Vec<&String> = declared.iter().collect();
    declared_sorted.sort();
    let before = declared_sorted.len();
    declared_sorted.dedup();
    if declared_sorted.len() != before {
        return Err(AppError::validation(
            "The bundle manifest lists the same asset twice.",
        ));
    }

    let mut actual_names: Vec<&String> = actual.iter().map(|(name, _)| name).collect();
    actual_names.sort();
    if declared_sorted != actual_names {
        return Err(AppError::validation(
            "The bundle's files do not match its manifest.",
        ));
    }

    for (name, bytes) in actual {
        let (stem, extension) = name
            .rsplit_once('.')
            .ok_or_else(|| AppError::validation("A bundle asset has no file extension."))?;
        let extension = extension.to_ascii_lowercase();
        if !ALLOWED_BUNDLE_ASSET_EXTENSIONS.contains(&extension.as_str()) {
            return Err(AppError::validation(format!(
                "The bundle contains an unsupported asset type: {name}"
            )));
        }
        // Bind the name to the content: an entry called `<hash>.png` must
        // actually hash to `<hash>`, so a bundle cannot ship one image under
        // another's identity.
        if stem.len() != 64 || !stem.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(AppError::validation(format!(
                "Bundle assets must be named after their content hash: {name}"
            )));
        }
        if !sha256_hex(bytes).eq_ignore_ascii_case(stem) {
            return Err(AppError::validation(format!(
                "A bundle asset does not match its content hash: {name}"
            )));
        }
        // And the bytes must really be the image type the extension claims.
        let sniffed = crate::assets::sniff_mime(bytes)
            .ok_or_else(|| AppError::validation(format!("{name} is not a supported image.")))?;
        if crate::assets::extension_for_mime(sniffed) != extension {
            return Err(AppError::validation(format!(
                "{name} is not the image type its name claims."
            )));
        }
        // Magic bytes are a four-byte prefix. The payload must also survive a
        // real decode under dimension limits, so a bundle cannot drop a
        // decompression bomb — or arbitrary bytes behind a PNG header — into a
        // managed asset directory.
        crate::assets::validate_image_payload(bytes, sniffed)
            .map_err(|e| AppError::validation(format!("{name} is not a usable image.")).with_log(format!("{e}")))?;
    }
    Ok(())
}

/// Defence in depth on a path the operator picked in the native dialog.
///
/// Even a dialog result gets checked: a picker can hand back a symlink, a
/// device node, or a fifo, and reading a fifo blocks the command forever.
fn checked_import_source(path: &Path) -> Result<PathBuf, AppError> {
    if !path.is_absolute() {
        return Err(AppError::unsafe_path("The selected file could not be read."));
    }
    let meta = fs::symlink_metadata(path)
        .map_err(|_| AppError::unsafe_path("The selected file could not be read."))?;
    if meta.file_type().is_symlink() {
        return Err(AppError::unsafe_path("Symbolic links cannot be imported."));
    }
    if !meta.is_file() {
        return Err(AppError::unsafe_path("Only files can be imported."));
    }
    // Canonicalize so a symlinked PARENT directory is resolved too; the result
    // is what the rest of the importer works with.
    let resolved = path
        .canonicalize()
        .map_err(|_| AppError::unsafe_path("The selected file could not be read."))?;
    if !resolved.is_file() {
        return Err(AppError::unsafe_path("Only files can be imported."));
    }
    Ok(resolved)
}

/// Where an export may land. The parent directory is canonicalized, so a
/// symlinked folder cannot smuggle the write somewhere else, and CandidCue's
/// own managed storage is refused outright — an export is for the operator's
/// documents, and a stray write inside the library corrupts it.
fn checked_export_destination(
    paths: &DataPaths,
    destination: &Path,
) -> Result<PathBuf, AppError> {
    if !destination.is_absolute() {
        return Err(AppError::unsafe_path(
            "Export destination must be an absolute path.",
        ));
    }
    let file_name = destination
        .file_name()
        .ok_or_else(|| AppError::unsafe_path("Export destination has no file name."))?;
    let parent = destination
        .parent()
        .ok_or_else(|| AppError::unsafe_path("Export destination has no parent directory."))?
        .canonicalize()
        .map_err(|_| AppError::unsafe_path("Export destination folder does not exist."))?;
    if !parent.is_dir() {
        return Err(AppError::unsafe_path(
            "Export destination folder does not exist.",
        ));
    }
    if let Ok(root) = paths.root().canonicalize() {
        if parent.starts_with(&root) {
            return Err(AppError::unsafe_path(
                "Exports cannot be written inside CandidCue's own storage.",
            ));
        }
    }

    let resolved = parent.join(file_name);
    // An existing destination must be a plain file. Writing through a symlink
    // is how "save as notes.md" becomes "overwrite whatever notes.md points at";
    // the atomic rename below would replace the link rather than follow it, but
    // refusing outright tells the operator what happened.
    if let Ok(meta) = fs::symlink_metadata(&resolved) {
        if meta.file_type().is_symlink() {
            return Err(AppError::unsafe_path(
                "The export destination is a symbolic link.",
            ));
        }
        if !meta.is_file() {
            return Err(AppError::unsafe_path(
                "The export destination is not a file.",
            ));
        }
    }
    Ok(resolved)
}

fn title_from_path(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Imported script".into())
}

/// Conservative plain-text to Markdown conversion (spec §21.2 item 4):
/// normalize line endings and promote single line breaks to paragraphs.
fn text_to_markdown(text: &str) -> String {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    normalized
        .split('\n')
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n\n")
        .split("\n\n\n")
        .collect::<Vec<_>>()
        .join("\n\n")
}

pub async fn import_script(
    pool: &SqlitePool,
    paths: &DataPaths,
    locks: &ScriptLocks,
    options: ImportOptions,
) -> Result<ImportResult, AppError> {
    let source_path = checked_import_source(Path::new(&options.path))?;
    let meta = fs::symlink_metadata(&source_path)?;

    let extension = source_path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    match extension.as_str() {
        "md" | "markdown" | "txt" => {
            if meta.len() as usize > MAX_SOURCE_BYTES {
                return Err(AppError::validation("The file is larger than the 10 MB limit."));
            }
            let raw = fs::read_to_string(&source_path)
                .map_err(|_| AppError::validation("The file is not valid UTF-8 text."))?;
            // Before the `.txt` conversion, so the mark cannot ride into the
            // stored script, its import revision or its word count (#247).
            let raw = into_without_bom(raw);
            let source = if extension == "txt" {
                text_to_markdown(&raw)
            } else {
                raw
            };
            let title = options.title.unwrap_or_else(|| title_from_path(&source_path));
            let summary = repo::create_script(
                pool,
                paths,
                super::CreateScriptInput {
                    title,
                    source: Some(source.clone()),
                    language: None,
                },
            )
            .await?;
            // Spec §21.4: revision on first save after import.
            let new_id = ScriptId::parse(&summary.id)?;
            let words = spoken_text(&source, SpokenTextOptions::default()).word_count();
            repo::create_revision_snapshot(pool, paths, &new_id, &source, "import", words)
                .await?;
            let _ = locks; // imports of flat files need no per-script lock: the id is fresh
            Ok(ImportResult {
                script: summary,
                warnings: Vec::new(),
            })
        }
        "candidcue" => import_bundle(pool, paths, locks, &source_path, options.title).await,
        _ => Err(AppError::validation(
            "Only .md, .markdown, .txt, and .candidcue files can be imported.",
        )),
    }
}

async fn import_bundle(
    pool: &SqlitePool,
    paths: &DataPaths,
    locks: &ScriptLocks,
    bundle_path: &Path,
    title_override: Option<String>,
) -> Result<ImportResult, AppError> {
    let file = fs::File::open(bundle_path)?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| AppError::validation("The bundle could not be opened.")
            .with_log(format!("zip open: {e}")))?;

    if archive.len() > MAX_BUNDLE_FILE_COUNT {
        return Err(AppError::validation("The bundle contains too many files."));
    }

    let mut manifest: Option<BundleManifest> = None;
    let mut script_source: Option<String> = None;
    let mut assets: Vec<(String, Vec<u8>)> = Vec::new();
    let mut total_bytes: u64 = 0;
    // A bundle either matches its manifest exactly or is rejected, so the
    // importer no longer accumulates "ignored entry" warnings (H6).
    let warnings: Vec<String> = Vec::new();

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| AppError::validation("The bundle is corrupt.")
                .with_log(format!("zip entry: {e}")))?;
        let name = entry.name().to_string();
        if entry.is_dir() {
            continue;
        }
        // Symlinks and unsafe paths are rejected outright.
        if let Some(mode) = entry.unix_mode() {
            if mode & 0o170000 == 0o120000 {
                return Err(AppError::unsafe_path("The bundle contains a symbolic link."));
            }
        }
        if !is_safe_relative_path(&name) {
            return Err(AppError::unsafe_path("The bundle contains an unsafe path."));
        }

        let declared = entry.size();
        total_bytes = total_bytes.saturating_add(declared);
        if total_bytes > MAX_BUNDLE_TOTAL_BYTES {
            return Err(AppError::validation("The bundle exceeds the size limit."));
        }

        match name.as_str() {
            "manifest.json" => {
                if declared > MAX_BUNDLE_MANIFEST_BYTES {
                    return Err(AppError::validation("The bundle manifest is too large."));
                }
                let mut buf = Vec::new();
                entry
                    .by_ref()
                    .take(MAX_BUNDLE_MANIFEST_BYTES + 1)
                    .read_to_end(&mut buf)?;
                if buf.len() as u64 > MAX_BUNDLE_MANIFEST_BYTES {
                    return Err(AppError::validation("The bundle manifest is too large."));
                }
                let parsed: BundleManifest = serde_json::from_slice(&buf)
                    .map_err(|e| AppError::validation("The bundle manifest is malformed.")
                        .with_log(format!("manifest parse: {e}")))?;
                if parsed.schema_version != 1 {
                    return Err(AppError::validation(
                        "This bundle was created by a newer version of CandidCue.",
                    ));
                }
                manifest = Some(parsed);
            }
            "script.md" => {
                if declared as usize > MAX_SOURCE_BYTES {
                    return Err(AppError::validation("The script is larger than the 10 MB limit."));
                }
                let mut buf = Vec::new();
                entry
                    .by_ref()
                    .take(MAX_SOURCE_BYTES as u64 + 1)
                    .read_to_end(&mut buf)?;
                if buf.len() > MAX_SOURCE_BYTES {
                    return Err(AppError::validation("The script is larger than the 10 MB limit."));
                }
                script_source = Some(into_without_bom(
                    String::from_utf8(buf)
                        .map_err(|_| AppError::validation("script.md is not valid UTF-8."))?,
                ));
            }
            _ if name.starts_with("assets/") => {
                if declared > MAX_BUNDLE_ASSET_BYTES {
                    return Err(AppError::validation("A bundle asset exceeds the 25 MB limit."));
                }
                let file_name = name.trim_start_matches("assets/").to_string();
                if file_name.contains('/') || !is_safe_relative_path(&file_name) {
                    return Err(AppError::unsafe_path("The bundle contains an unsafe asset path."));
                }
                if assets.iter().any(|(existing, _)| existing == &file_name) {
                    return Err(AppError::validation(
                        "The bundle contains the same asset twice.",
                    ));
                }
                let mut buf = Vec::new();
                entry
                    .by_ref()
                    .take(MAX_BUNDLE_ASSET_BYTES + 1)
                    .read_to_end(&mut buf)?;
                if buf.len() as u64 > MAX_BUNDLE_ASSET_BYTES {
                    return Err(AppError::validation("A bundle asset exceeds the 25 MB limit."));
                }
                assets.push((file_name, buf));
            }
            _ => {
                // Undeclared entries used to be accepted with a warning, which
                // let a bundle smuggle HTML or executables into a managed
                // directory. A bundle has a fixed shape (spec §21.6): anything
                // else means the file is not one of ours (H6).
                return Err(AppError::validation(format!(
                    "The bundle contains an unexpected entry: {name}"
                )));
            }
        }
    }

    let manifest =
        manifest.ok_or_else(|| AppError::validation("The bundle is missing manifest.json."))?;
    let source =
        script_source.ok_or_else(|| AppError::validation("The bundle is missing script.md."))?;

    // The manifest is now enforced, not decorative: the declared asset list
    // and the actual archive entries must match exactly, and every asset must
    // be named after its own content hash so a name can never be bound to
    // content it does not describe (H6).
    validate_declared_assets(&manifest.assets, &assets)?;

    let title = title_override.unwrap_or(manifest.title);
    let summary = repo::create_script(
        pool,
        paths,
        super::CreateScriptInput {
            title,
            source: Some(source.clone()),
            language: manifest.language,
        },
    )
    .await?;

    // Write assets into the new script's asset directory and register them.
    let new_id = ScriptId::parse(&summary.id)?;
    let finish = install_bundle_assets(pool, paths, &new_id, &assets, &source).await;
    if let Err(err) = finish {
        // A partially imported script is worse than no script: roll the whole
        // import back rather than leaving a half-populated one behind (H6).
        if let Err(cleanup) =
            repo::force_delete_partial_import(pool, paths, locks, &new_id).await
        {
            tracing::error!(
                script_id = new_id.as_str(),
                error = %cleanup,
                "could not roll back a failed bundle import"
            );
        }
        return Err(err);
    }

    let script = repo::get_summary(pool, &new_id).await?;
    Ok(ImportResult { script, warnings })
}

/// Asset files, asset rows AND the script→asset references, in one
/// transaction. The references were previously never created, so imported
/// assets could not be resolved by `resolve_asset_urls` and were eligible for
/// garbage collection the moment it ran (H6).
async fn install_bundle_assets(
    pool: &SqlitePool,
    paths: &DataPaths,
    new_id: &ScriptId,
    assets: &[(String, Vec<u8>)],
    source: &str,
) -> Result<(), AppError> {
    let assets_dir = paths.assets_dir(new_id);
    // Durably: the rows registering these assets are committed below, and a
    // folder left in the page cache would leave the database naming images
    // that are nowhere.
    crate::util::create_dir_all_durable(&assets_dir)?;

    let mut tx = pool.begin().await?;
    for (file_name, bytes) in assets {
        let dest = assets_dir.join(file_name);
        atomic_write(&dest, bytes)?;
        let sha = sha256_hex(bytes);
        let extension = dest
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let mime = crate::assets::sniff_mime(bytes)
            .ok_or_else(|| AppError::validation("A bundle asset is not a supported image."))?
            .to_string();
        let rel_path = format!("scripts/{}/assets/{}", new_id.as_str(), file_name);
        let now = now_iso();
        sqlx::query(
            "INSERT INTO assets (id, sha256, mime_type, extension, size_bytes, rel_path, original_name, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(sha256, rel_path) DO NOTHING",
        )
        .bind(new_uuid())
        .bind(&sha)
        .bind(&mime)
        .bind(&extension)
        .bind(bytes.len() as i64)
        .bind(&rel_path)
        .bind(file_name)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        let asset_id: String =
            sqlx::query_scalar("SELECT id FROM assets WHERE rel_path = ? LIMIT 1")
                .bind(&rel_path)
                .fetch_one(&mut *tx)
                .await?;
        sqlx::query(
            "INSERT OR IGNORE INTO script_asset_references (script_id, asset_id, role, created_at)
             VALUES (?, ?, 'image', ?)",
        )
        .bind(new_id.as_str())
        .bind(&asset_id)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    // Spec §21.4: revision on first save after import.
    let words = spoken_text(source, SpokenTextOptions::default()).word_count();
    repo::create_revision_snapshot(pool, paths, new_id, source, "import", words).await?;
    Ok(())
}

pub async fn export_script(
    pool: &SqlitePool,
    paths: &DataPaths,
    locks: &ScriptLocks,
    script_id: &ScriptId,
    options: ExportOptions,
) -> Result<ExportResult, AppError> {
    let lock = locks.lock_for(script_id);
    let _guard = lock.lock().await;

    let canonical = repo::canonical_path_checked(pool, paths, script_id).await?;
    // A canonical file saved with a BOM outside CandidCue exports without it.
    let source = into_without_bom(fs::read_to_string(&canonical)?);
    let summary = repo::get_summary(pool, script_id).await?;

    // Reject the format BEFORE touching the filesystem: an unknown format used
    // to fall through to the match arm below, after the destination had already
    // been validated and (for bundles) created.
    export_format_extension(&options.format)?;

    let destination = checked_export_destination(paths, Path::new(&options.destination))?;
    let parent = destination
        .parent()
        .ok_or_else(|| AppError::unsafe_path("Export destination has no parent directory."))?
        .to_path_buf();

    let mut warnings = Vec::new();
    // Only the images the exported text uses (#253). The folder also holds
    // every image the script ever had: deleting an image's line leaves its
    // file behind, so revision restore and undo can still show it, and the
    // screenshot somebody removed for showing the wrong thing is exactly the
    // one that must not travel with the export.
    let assets_dir = paths.assets_dir(script_id);
    let mentions = crate::assets::AssetMentions::new(&source);
    let asset_files: Vec<PathBuf> = if assets_dir.exists() {
        fs::read_dir(&assets_dir)?
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
            .filter(|e| mentions.uses(&e.file_name().to_string_lossy()))
            .map(|e| e.path())
            .collect()
    } else {
        Vec::new()
    };

    match options.format.as_str() {
        "markdown" => {
            atomic_write(&destination, source.as_bytes())?;
            if options.include_assets && !asset_files.is_empty() {
                let export_assets = parent.join("assets");
                // Durably: `atomic_write` below flushes each image and the
                // folder it sits in, but that folder is itself new, and an
                // entry left in the page cache takes every image with it —
                // after the export has reported success.
                crate::util::create_dir_all_durable(&export_assets)?;
                for file in &asset_files {
                    if let Some(name) = file.file_name() {
                        // atomic_write, not fs::copy: the rename replaces a
                        // symlink at the destination instead of writing through
                        // it, and never leaves a half-copied image behind.
                        atomic_write(&export_assets.join(name), &fs::read(file)?)?;
                    }
                }
            } else if !asset_files.is_empty() {
                warnings.push(format!(
                    "{} local image(s) were not exported; enable includeAssets to copy them.",
                    asset_files.len()
                ));
            }
        }
        "text" => {
            let plain = spoken_plain_text(&source, SpokenTextOptions::default());
            atomic_write(&destination, plain.as_bytes())?;
            if !asset_files.is_empty() {
                warnings.push("Images are omitted from plain-text exports.".into());
            }
        }
        "bundle" => {
            let manifest = BundleManifest {
                schema_version: 1,
                title: summary.title.clone(),
                language: Some(summary.language.clone()),
                exported_at: Some(now_iso()),
                assets: asset_files
                    .iter()
                    .filter_map(|f| f.file_name().map(|n| n.to_string_lossy().to_string()))
                    .collect(),
            };
            write_bundle(&destination, &manifest, &source, &asset_files)?;
        }
        other => {
            return Err(AppError::invalid_input(format!(
                "Unknown export format: {other}. Use markdown, text, or bundle."
            )));
        }
    }

    Ok(ExportResult {
        path: destination.to_string_lossy().to_string(),
        format: options.format,
        warnings,
    })
}

/// Write the bundle as an ATOMIC REPLACE.
///
/// `fs::File::create(destination)` truncated the operator's chosen file the
/// moment the zip writer opened it, and followed a symlink while doing so. A
/// failure half-way through then left a corrupt stub where a real file used to
/// be. The zip is built in a temporary file beside the destination and renamed
/// over it, so the destination either has the old contents or the new ones.
fn write_bundle(
    destination: &Path,
    manifest: &BundleManifest,
    source: &str,
    asset_files: &[PathBuf],
) -> Result<(), AppError> {
    let map_zip = |e: zip::result::ZipError| {
        AppError::save_failed("The bundle could not be written.").with_log(format!("zip: {e}"))
    };
    let manifest_json = serde_json::to_string_pretty(manifest)
        .map_err(|e| AppError::Internal(format!("manifest serialize: {e}")))?;

    crate::util::atomic_write_with(destination, |file| {
        use std::io::Write;
        let mut writer = zip::ZipWriter::new(file);
        let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        writer.start_file("manifest.json", options).map_err(map_zip)?;
        writer.write_all(manifest_json.as_bytes())?;
        writer.start_file("script.md", options).map_err(map_zip)?;
        writer.write_all(source.as_bytes())?;
        for asset in asset_files {
            if let Some(name) = asset.file_name() {
                writer
                    .start_file(format!("assets/{}", name.to_string_lossy()), options)
                    .map_err(map_zip)?;
                writer.write_all(&fs::read(asset)?)?;
            }
        }
        writer.finish().map_err(map_zip)?;
        Ok(())
    })
}
