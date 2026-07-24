//! Asset commands (spec §46.3).

use std::collections::HashMap;

use tauri::{AppHandle, Manager, State};

use crate::assets::{self, AssetRequest, AssetUrlEntry, ImportedAsset};
use crate::database::Database;
use crate::errors::AppError;
use crate::openai::OpenAiClient;
use crate::scripts::{DataPaths, ScriptId};

/// Allow the script's asset directory in the asset-protocol scope so the
/// returned URLs actually resolve (spec §47.8).
fn allow_script_assets(app: &AppHandle, paths: &DataPaths, script_id: &ScriptId) {
    let dir = paths.assets_dir(script_id);
    if dir.exists() {
        let _ = app.asset_protocol_scope().allow_directory(&dir, true);
    }
}

#[tauri::command]
pub async fn import_image(
    app: AppHandle,
    db: State<'_, Database>,
    paths: State<'_, DataPaths>,
    script_id: String,
    source_file: String,
) -> Result<ImportedAsset, AppError> {
    let script_id = ScriptId::parse(&script_id)?;
    let imported = assets::import_image(db.pool(), &paths, &script_id, &source_file).await?;
    allow_script_assets(&app, &paths, &script_id);
    Ok(imported)
}

#[tauri::command]
pub async fn import_remote_image(
    app: AppHandle,
    db: State<'_, Database>,
    paths: State<'_, DataPaths>,
    openai: State<'_, OpenAiClient>,
    script_id: String,
    url: String,
) -> Result<ImportedAsset, AppError> {
    let script_id = ScriptId::parse(&script_id)?;
    // Reuses the shared reqwest client; no provider credentials attached.
    let imported =
        assets::import_remote_image(db.pool(), &paths, openai.http(), &script_id, &url).await?;
    allow_script_assets(&app, &paths, &script_id);
    Ok(imported)
}

#[tauri::command]
pub async fn resolve_asset_urls(
    app: AppHandle,
    db: State<'_, Database>,
    paths: State<'_, DataPaths>,
    script_id: String,
    assets_to_resolve: Vec<AssetRequest>,
) -> Result<HashMap<String, AssetUrlEntry>, AppError> {
    let script_id = ScriptId::parse(&script_id)?;
    allow_script_assets(&app, &paths, &script_id);
    assets::resolve_asset_urls(db.pool(), &paths, &script_id, &assets_to_resolve).await
}

#[tauri::command]
pub async fn remove_asset_reference(
    db: State<'_, Database>,
    paths: State<'_, DataPaths>,
    script_id: String,
    asset_id: String,
) -> Result<(), AppError> {
    let script_id = ScriptId::parse(&script_id)?;
    assets::remove_asset_reference(db.pool(), &script_id, &asset_id).await?;
    // Basic GC after unreferencing (spec §24.8).
    let _ = assets::collect_garbage(db.pool(), &paths).await;
    Ok(())
}
