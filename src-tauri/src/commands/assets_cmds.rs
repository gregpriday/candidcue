//! Asset commands (spec §46.3).

use std::collections::HashMap;

use tauri::{AppHandle, Manager, State};

use crate::assets::{self, AssetRequest, AssetUrlEntry, ImportedAsset};
use crate::database::Database;
use crate::errors::AppError;
use crate::scripts::{DataPaths, ScriptId};

/// Make sure the script's asset FILES resolve through the asset protocol
/// (spec §47.8).
///
/// M2: this used to grant the directory RECURSIVELY. The assets directory is
/// flat, so recursion bought nothing and would have followed any subdirectory
/// that appeared in it. The static scope in tauri.conf.json already covers
/// `$APPDATA/scripts/*/assets/*`; this stays as a belt-and-braces grant for
/// paths the glob might not reach (a relocated data dir in a dev build), and it
/// can no longer reach the canonical file or the revision history because the
/// config's `deny` list takes precedence over every runtime grant.
fn allow_script_assets(app: &AppHandle, paths: &DataPaths, script_id: &ScriptId) {
    let dir = paths.assets_dir(script_id);
    if dir.exists() {
        let _ = app.asset_protocol_scope().allow_directory(&dir, false);
    }
}

/// Add a local image to a script (spec §46.3, §50.7).
///
/// The picker runs in Rust; there is no `sourceFile` argument to forge. It used
/// to accept any absolute path from the control webview, which meant any image
/// on the machine could be copied into a script and then read back through the
/// asset protocol. `Ok(None)` means the operator cancelled.
#[tauri::command]
pub async fn import_image(
    app: AppHandle,
    db: State<'_, Database>,
    paths: State<'_, DataPaths>,
    script_id: String,
) -> Result<Option<ImportedAsset>, AppError> {
    let script_id = ScriptId::parse(&script_id)?;
    let Some(source) = crate::dialogs::pick_image_to_import(&app).await? else {
        return Ok(None);
    };
    let imported =
        assets::import_image(db.pool(), &paths, &script_id, &source.to_string_lossy()).await?;
    allow_script_assets(&app, &paths, &script_id);
    Ok(Some(imported))
}

#[tauri::command]
pub async fn import_remote_image(
    app: AppHandle,
    db: State<'_, Database>,
    paths: State<'_, DataPaths>,
    script_id: String,
    url: String,
) -> Result<ImportedAsset, AppError> {
    let script_id = ScriptId::parse(&script_id)?;
    // A dedicated, credential-free, redirect-disabled client is built per
    // fetch inside `assets::remote`. The shared OpenAI client must never be
    // used here: it follows redirects and is the one client that grows
    // provider credentials.
    let imported = assets::import_remote_image(db.pool(), &paths, &script_id, &url).await?;
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
