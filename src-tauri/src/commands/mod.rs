//! Typed IPC commands exposed to the control window.
//!
//! Every command returns `Result<T, AppError>` so failures always cross the
//! boundary as the stable error payload (spec §44.12).

use tauri::State;

use crate::database::Database;
use crate::errors::AppError;
use crate::scripts::ScriptSummary;

/// Application version string, e.g. "0.1.0".
#[tauri::command]
pub fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Script library listing. Stub: returns an empty library until the scripts
/// repository lands; already touches the pool so wiring is proven.
#[tauri::command]
pub async fn list_scripts(db: State<'_, Database>) -> Result<Vec<ScriptSummary>, AppError> {
    // Cheap liveness check that the pool + migrations are actually wired.
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM scripts")
        .fetch_one(db.pool())
        .await?;
    Ok(Vec::new())
}
