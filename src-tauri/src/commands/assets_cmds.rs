//! Asset commands (spec §46.3).

use std::collections::HashMap;

use tauri::{AppHandle, Manager, Runtime, State};

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
fn allow_script_assets<R: Runtime>(app: &AppHandle<R>, paths: &DataPaths, script_id: &ScriptId) {
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
pub async fn import_image<R: Runtime>(
    boot: State<'_, crate::database::BootStatus>,
    app: AppHandle<R>,
    db: State<'_, Database>,
    paths: State<'_, DataPaths>,
    script_id: String,
) -> Result<Option<ImportedAsset>, AppError> {
    // Recovery mode owns no writable database (database::BootStatus).
    boot.require_ready()?;
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
pub async fn resolve_asset_urls<R: Runtime>(
    app: AppHandle<R>,
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
    boot: State<'_, crate::database::BootStatus>,
    db: State<'_, Database>,
    paths: State<'_, DataPaths>,
    script_id: String,
    asset_id: String,
) -> Result<(), AppError> {
    // Recovery mode owns no writable database (database::BootStatus).
    boot.require_ready()?;
    let script_id = ScriptId::parse(&script_id)?;
    assets::remove_asset_reference(db.pool(), &script_id, &asset_id).await?;
    // Basic GC after unreferencing (spec §24.8).
    let _ = assets::collect_garbage(db.pool(), &paths).await;
    Ok(())
}

/// Open a model's licence page in the user's browser.
///
/// ## Why this exists instead of `opener:default`
///
/// The control capability used to grant `opener:default`, which lets the
/// webview open ANY url, and the one place the app actually needs it is a
/// licence link in the speech-model picker. The 1.0 readiness review called
/// that out as authority minimisation: a capability that broad is not
/// dangerous today because the CSP blocks remote hosts and nothing else calls
/// it — it is dangerous because it is standing permission for a thing nobody
/// is watching.
///
/// So the grant is gone and this took its place. The url is checked against
/// the licence urls the **catalogue itself** declares, which is the same file
/// the downloader takes its pinned digests from. That is stricter than a host
/// allow-list and it cannot drift: adding a model with a new licence adds its
/// url here automatically, and nothing else can ever be opened.
///
/// §153 is explicit that attribution is an obligation the app carries rather
/// than a decision to put in front of the user, so this is not gated on
/// anything — it is the same link, opened safely.
#[tauri::command]
pub async fn open_model_licence(url: String) -> Result<(), AppError> {
    let permitted = crate::speech::catalogue::licence_urls();
    if !permitted.iter().any(|allowed| allowed == &url) {
        return Err(AppError::unsafe_path(
            "CandidCue only opens the licence pages the speech-model catalogue names.",
        )
        .with_detail("url", url));
    }
    tauri_plugin_opener::open_url(url, None::<&str>)
        .map_err(|e| AppError::Internal(format!("could not open the licence page: {e}")))
}
