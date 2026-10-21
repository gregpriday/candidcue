//! Update commands (docs/updates.md). Thin on purpose: every rule about when a
//! check or an install may happen lives in `crate::updater`, which is where the
//! tests that pin those rules are.

use tauri::State;

use crate::database::{BootStatus, Database};
use crate::errors::{AppError, ErrorCategory};
use crate::updater::{self, UpdateCheckResult};

/// Ask the update server whether a newer Speaking Glass is available.
///
/// `automatic` is true for the scheduled check (shortly after launch, then every
/// few hours) and false for Help › Check for Updates…. An automatic check is
/// refused — without touching the network — when the user has turned
/// "Check for updates automatically" off, and in recovery mode, where the
/// setting cannot be read and so cannot be honoured. The refusal is enforced
/// HERE as well as in the scheduler that decides whether to ask: the setting is
/// a promise about the network, and the network is Rust's.
///
/// A manual check always runs: asking is the user's explicit consent to the one
/// request it makes.
#[tauri::command]
pub async fn check_for_update<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    boot: State<'_, BootStatus>,
    db: State<'_, Database>,
    automatic: Option<bool>,
) -> Result<UpdateCheckResult, AppError> {
    if automatic.unwrap_or(false) {
        let allowed = boot.is_ready()
            && crate::settings::get_settings(db.pool())
                .await
                .map(|settings| settings.value.general.check_for_updates)
                .unwrap_or(false);
        if !allowed {
            return Err(AppError::structured(
                "UPDATE_CHECK_DISABLED",
                ErrorCategory::Validation,
                "Automatic update checks are turned off in Settings.",
                true,
            ));
        }
    }
    updater::check(&app).await
}

/// Download, verify and install the update the last check found, then restart.
///
/// Takes no argument: what is installed is what Rust's own check found, from
/// the compiled-in endpoint, verified against the compiled-in key. Refused
/// during a take (`updater::install_refusal`). Progress arrives on
/// `update://progress`; on success the app restarts and this call's answer may
/// never be read.
#[tauri::command]
pub async fn install_update<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), AppError> {
    updater::install(&app).await
}
