//! Listener commands (spec §46.7).

use tauri::{AppHandle, Manager, Runtime, State};

use crate::database::Database;
use crate::errors::AppError;
use crate::listeners::{
    self, DownloadJob, InstalledListener, ListenerCatalogue, ListenerLibrary, ListenerMediaUrls,
};

#[tauri::command]
pub async fn get_listener_catalogue<R: Runtime>(
    app: AppHandle<R>,
    db: State<'_, Database>,
    library: State<'_, ListenerLibrary>,
    force_refresh: Option<bool>,
) -> Result<ListenerCatalogue, AppError> {
    // Poster thumbnails resolve through the asset protocol.
    let _ = app
        .asset_protocol_scope()
        .allow_directory(&library.bundled_dir, true);
    listeners::catalogue(db.pool(), &library, force_refresh.unwrap_or(false)).await
}

#[tauri::command]
pub async fn list_installed_listeners(
    db: State<'_, Database>,
    library: State<'_, ListenerLibrary>,
) -> Result<Vec<InstalledListener>, AppError> {
    listeners::list_installed(db.pool(), &library).await
}

/// Remote downloads return NOT_IMPLEMENTED in v1: no CandidCue-controlled
/// pack host exists yet. The download/verify/install pipeline trait and
/// checksum verification are in `crate::listeners`.
#[tauri::command]
pub async fn download_listener(
    _pack_id: String,
    _variant: Option<String>,
) -> Result<DownloadJob, AppError> {
    Err(AppError::not_implemented("Listener pack downloads"))
}

#[tauri::command]
pub async fn cancel_listener_download(_job_id: String) -> Result<(), AppError> {
    Err(AppError::not_implemented("Listener pack downloads"))
}

#[tauri::command]
pub async fn remove_listener(
    db: State<'_, Database>,
    library: State<'_, ListenerLibrary>,
    pack_id: String,
    version: String,
) -> Result<(), AppError> {
    listeners::remove_pack(db.pool(), &library, &pack_id, &version).await
}

#[tauri::command]
pub fn resolve_listener_media<R: Runtime>(
    app: AppHandle<R>,
    library: State<'_, ListenerLibrary>,
    pack_id: String,
    version: String,
) -> Result<ListenerMediaUrls, AppError> {
    let (media, pack_dir) = listeners::resolve_media(&library, &pack_id, &version)?;
    // Scope the asset protocol to this installed pack (spec §47.8).
    let _ = app.asset_protocol_scope().allow_directory(&pack_dir, true);
    Ok(media)
}
