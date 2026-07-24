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
use super::words::{spoken_plain_text, SpokenTextOptions};
use super::{DataPaths, ScriptLocks, ScriptSummary};

/// Spec Appendix A.10 limits.
const MAX_BUNDLE_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_BUNDLE_ASSET_BYTES: u64 = 25 * 1024 * 1024;
const MAX_BUNDLE_TOTAL_BYTES: u64 = 600 * 1024 * 1024;
const MAX_BUNDLE_FILE_COUNT: usize = 256;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOptions {
    /// Absolute path returned by the native open dialog.
    pub path: String,
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub script: ScriptSummary,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    /// Absolute destination path returned by the native save dialog.
    pub destination: String,
    /// 'markdown' | 'text' | 'bundle'.
    pub format: String,
    #[serde(default)]
    pub include_assets: bool,
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
    let source_path = PathBuf::from(&options.path);
    if !source_path.is_absolute() || !source_path.exists() {
        return Err(AppError::unsafe_path("The selected file could not be read."));
    }
    let meta = fs::symlink_metadata(&source_path)?;
    if meta.file_type().is_symlink() {
        return Err(AppError::unsafe_path("Symbolic links cannot be imported."));
    }

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
            let (plain, _, _) = (spoken_plain_text(&source, SpokenTextOptions::default()), 0, 0);
            let words = super::words::word_count(&plain);
            repo::create_revision_snapshot(pool, paths, &summary.id, &source, "import", words)
                .await?;
            let _ = locks; // imports of flat files need no per-script lock: the id is fresh
            Ok(ImportResult {
                script: summary,
                warnings: Vec::new(),
            })
        }
        "candidcue" => import_bundle(pool, paths, &source_path, options.title).await,
        _ => Err(AppError::validation(
            "Only .md, .markdown, .txt, and .candidcue files can be imported.",
        )),
    }
}

async fn import_bundle(
    pool: &SqlitePool,
    paths: &DataPaths,
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
    let mut warnings = Vec::new();

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
                script_source = Some(
                    String::from_utf8(buf)
                        .map_err(|_| AppError::validation("script.md is not valid UTF-8."))?,
                );
            }
            _ if name.starts_with("assets/") => {
                if declared > MAX_BUNDLE_ASSET_BYTES {
                    return Err(AppError::validation("A bundle asset exceeds the 25 MB limit."));
                }
                let file_name = name.trim_start_matches("assets/").to_string();
                if file_name.contains('/') || !is_safe_relative_path(&file_name) {
                    return Err(AppError::unsafe_path("The bundle contains an unsafe asset path."));
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
                warnings.push(format!("Ignored undeclared bundle entry: {name}"));
                if warnings.len() > 16 {
                    return Err(AppError::validation(
                        "The bundle contains too many undeclared files.",
                    ));
                }
            }
        }
    }

    let manifest =
        manifest.ok_or_else(|| AppError::validation("The bundle is missing manifest.json."))?;
    let source =
        script_source.ok_or_else(|| AppError::validation("The bundle is missing script.md."))?;

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
    let assets_dir = paths.assets_dir(&summary.id);
    fs::create_dir_all(&assets_dir)?;
    for (file_name, bytes) in &assets {
        let dest = assets_dir.join(file_name);
        atomic_write(&dest, bytes)?;
        let sha = sha256_hex(bytes);
        let extension = dest
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let mime = crate::assets::sniff_mime(bytes)
            .unwrap_or("application/octet-stream")
            .to_string();
        let rel_path = format!("scripts/{}/assets/{}", summary.id, file_name);
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
        .bind(now_iso())
        .execute(pool)
        .await?;
    }

    // Spec §21.4: revision on first save after import.
    let plain = spoken_plain_text(&source, SpokenTextOptions::default());
    let words = super::words::word_count(&plain);
    repo::create_revision_snapshot(pool, paths, &summary.id, &source, "import", words).await?;

    let script = repo::get_summary(pool, &summary.id).await?;
    Ok(ImportResult { script, warnings })
}

pub async fn export_script(
    pool: &SqlitePool,
    paths: &DataPaths,
    locks: &ScriptLocks,
    script_id: &str,
    options: ExportOptions,
) -> Result<ExportResult, AppError> {
    let lock = locks.lock_for(script_id);
    let _guard = lock.lock().await;

    let canonical = repo::canonical_path_checked(pool, paths, script_id).await?;
    let source = fs::read_to_string(&canonical)?;
    let summary = repo::get_summary(pool, script_id).await?;

    let destination = PathBuf::from(&options.destination);
    if !destination.is_absolute() {
        return Err(AppError::unsafe_path("Export destination must be an absolute path."));
    }
    let parent = destination
        .parent()
        .ok_or_else(|| AppError::unsafe_path("Export destination has no parent directory."))?;
    if !parent.exists() {
        return Err(AppError::unsafe_path("Export destination folder does not exist."));
    }

    let mut warnings = Vec::new();
    let assets_dir = paths.assets_dir(script_id);
    let asset_files: Vec<PathBuf> = if assets_dir.exists() {
        fs::read_dir(&assets_dir)?
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
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
                fs::create_dir_all(&export_assets)?;
                for file in &asset_files {
                    if let Some(name) = file.file_name() {
                        fs::copy(file, export_assets.join(name))?;
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

fn write_bundle(
    destination: &Path,
    manifest: &BundleManifest,
    source: &str,
    asset_files: &[PathBuf],
) -> Result<(), AppError> {
    let file = fs::File::create(destination)?;
    let mut writer = zip::ZipWriter::new(file);
    let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let map_zip = |e: zip::result::ZipError| {
        AppError::save_failed("The bundle could not be written.").with_log(format!("zip: {e}"))
    };

    use std::io::Write;
    writer.start_file("manifest.json", options).map_err(map_zip)?;
    writer.write_all(
        serde_json::to_string_pretty(manifest)
            .map_err(|e| AppError::Internal(format!("manifest serialize: {e}")))?
            .as_bytes(),
    )?;
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
}
