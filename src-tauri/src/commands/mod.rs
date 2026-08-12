//! Typed IPC commands exposed to the control window (spec §46).
//!
//! Every command returns `Result<T, AppError>` so failures always cross the
//! boundary as the stable error payload (spec §44.12). Invoke argument names
//! are the camelCase forms of the Rust parameter names.

pub mod align_cmds;
pub mod assets_cmds;
pub mod speech_cmds;
pub mod scripts_cmds;
pub mod sessions_cmds;
pub mod settings_cmds;
pub mod stage_cmds;

pub use align_cmds::*;
pub use assets_cmds::*;
pub use speech_cmds::*;
pub use scripts_cmds::*;
pub use sessions_cmds::*;
pub mod recovery_cmds;
pub use recovery_cmds::*;
pub use settings_cmds::*;
pub use stage_cmds::*;

/// Application version string, e.g. "0.1.0".
#[tauri::command]
pub fn app_version<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> String {
    app.package_info().version.to_string()
}
