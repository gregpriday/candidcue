//! Settings and diagnostics commands (spec §46.8).

use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use tauri::State;

use crate::database::Database;
use crate::errors::AppError;
use crate::scripts::DataPaths;
use crate::settings::{self, RevisionedSettings};

#[tauri::command]
pub async fn get_settings(db: State<'_, Database>) -> Result<RevisionedSettings, AppError> {
    settings::get_settings(db.pool()).await
}

#[tauri::command]
pub async fn update_settings(
    db: State<'_, Database>,
    expected_revision: i64,
    patch: serde_json::Value,
) -> Result<RevisionedSettings, AppError> {
    settings::update_settings(db.pool(), expected_revision, patch).await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataExportResult {
    pub path: String,
    pub scripts_copied: u32,
    pub warnings: Vec<String>,
}

/// Export all data (spec §47.7): scripts tree copy + consistent SQLite
/// snapshot via `VACUUM INTO`.
#[tauri::command]
pub async fn export_all_data(
    db: State<'_, Database>,
    paths: State<'_, DataPaths>,
    destination: String,
) -> Result<DataExportResult, AppError> {
    let dest_root = PathBuf::from(&destination);
    if !dest_root.is_absolute() || !dest_root.exists() || !dest_root.is_dir() {
        return Err(AppError::unsafe_path(
            "Choose an existing folder for the export.",
        ));
    }
    let export_dir = dest_root.join(format!(
        "CandidCue-export-{}",
        chrono::Utc::now().format("%Y%m%d-%H%M%S")
    ));
    fs::create_dir_all(&export_dir)?;

    let mut warnings = Vec::new();

    // Consistent database snapshot.
    let db_copy = export_dir.join("candidcue.sqlite3");
    if let Err(err) = sqlx::query(&format!(
        "VACUUM INTO '{}'",
        db_copy.display().to_string().replace('\'', "''")
    ))
    .execute(db.pool())
    .await
    {
        warnings.push(format!("Database snapshot failed: {err}"));
    }

    // Scripts tree (canonical Markdown, revisions, assets).
    let mut scripts_copied = 0u32;
    let scripts_dir = paths.scripts_dir();
    if scripts_dir.exists() {
        let target = export_dir.join("scripts");
        copy_tree(&scripts_dir, &target)?;
        scripts_copied = fs::read_dir(&target)?.count() as u32;
    }

    Ok(DataExportResult {
        path: export_dir.to_string_lossy().to_string(),
        scripts_copied,
        warnings,
    })
}

fn copy_tree(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let target = to.join(entry.file_name());
        if file_type.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), &target)?;
        }
        // Symlinks are intentionally skipped.
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearResult {
    pub kind: String,
    pub removed_files: u32,
}

#[tauri::command]
pub async fn clear_cache(
    paths: State<'_, DataPaths>,
    kind: String,
) -> Result<ClearResult, AppError> {
    let cache_root = paths.cache_dir();
    let sub_dirs: Vec<&str> = match kind.as_str() {
        "compiled" => vec!["compiled"],
        "vocabulary" => vec!["vocabulary"],
        "thumbnails" => vec!["thumbnails"],
        "downloads" => vec!["downloads"],
        "all" => vec!["compiled", "vocabulary", "thumbnails", "downloads"],
        other => {
            return Err(AppError::invalid_input(format!(
                "Unknown cache kind: {other}."
            )));
        }
    };
    let mut removed = 0u32;
    for sub in sub_dirs {
        let dir = cache_root.join(sub);
        if dir.exists() {
            for entry in fs::read_dir(&dir)?.filter_map(|e| e.ok()) {
                let path = entry.path();
                let ok = if path.is_dir() {
                    fs::remove_dir_all(&path).is_ok()
                } else {
                    fs::remove_file(&path).is_ok()
                };
                if ok {
                    removed += 1;
                }
            }
        }
    }
    Ok(ClearResult {
        kind,
        removed_files: removed,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemDiagnostics {
    pub app_version: String,
    pub os: String,
    pub arch: String,
    pub database_integrity_ok: bool,
    pub script_count: i64,
    pub session_count: i64,
    pub data_dir: String,
}

#[tauri::command]
pub async fn get_system_diagnostics(
    app: tauri::AppHandle,
    db: State<'_, Database>,
    paths: State<'_, DataPaths>,
) -> Result<SystemDiagnostics, AppError> {
    let integrity: String = sqlx::query_scalar("PRAGMA quick_check")
        .fetch_one(db.pool())
        .await
        .unwrap_or_else(|_| "failed".into());
    let script_count: i64 = sqlx::query_scalar("SELECT count(*) FROM scripts")
        .fetch_one(db.pool())
        .await?;
    let session_count: i64 = sqlx::query_scalar("SELECT count(*) FROM sessions")
        .fetch_one(db.pool())
        .await?;
    Ok(SystemDiagnostics {
        app_version: app.package_info().version.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        database_integrity_ok: integrity == "ok",
        script_count,
        session_count,
        data_dir: paths.root().to_string_lossy().to_string(),
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportBundleResult {
    pub path: String,
}

/// Support bundle (spec §44.11): system facts + recovery reports. No API
/// key, audio, script, or transcript content.
#[tauri::command]
pub async fn export_support_bundle(
    app: tauri::AppHandle,
    db: State<'_, Database>,
    paths: State<'_, DataPaths>,
    destination: String,
) -> Result<SupportBundleResult, AppError> {
    let dest_root = PathBuf::from(&destination);
    if !dest_root.is_absolute() || !dest_root.exists() || !dest_root.is_dir() {
        return Err(AppError::unsafe_path(
            "Choose an existing folder for the support bundle.",
        ));
    }
    let bundle_dir = dest_root.join(format!(
        "CandidCue-support-{}",
        chrono::Utc::now().format("%Y%m%d-%H%M%S")
    ));
    fs::create_dir_all(&bundle_dir)?;

    let diagnostics = get_system_diagnostics(app, db, paths.clone()).await?;
    let json = serde_json::to_vec_pretty(&diagnostics)
        .map_err(|e| AppError::Internal(format!("diagnostics serialize: {e}")))?;
    crate::util::atomic_write(&bundle_dir.join("diagnostics.json"), &json)?;

    // Include recovery reports (they contain ids and counts, not content).
    let reports_dir = paths.diagnostics_dir();
    if reports_dir.exists() {
        for entry in fs::read_dir(&reports_dir)?.filter_map(|e| e.ok()) {
            if entry.path().extension().map(|e| e == "json").unwrap_or(false) {
                let _ = fs::copy(entry.path(), bundle_dir.join(entry.file_name()));
            }
        }
    }

    Ok(SupportBundleResult {
        path: bundle_dir.to_string_lossy().to_string(),
    })
}

/// Updater is not wired in v1 (spec §44.10 planned; plugin absent).
#[tauri::command]
pub async fn check_for_update() -> Result<serde_json::Value, AppError> {
    Err(AppError::not_implemented("Update checks"))
}

#[tauri::command]
pub async fn install_update() -> Result<(), AppError> {
    Err(AppError::not_implemented("Update installation"))
}
