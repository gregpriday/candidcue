//! CandidCue Rust core (spec §44).
//!
//! Module layout mirrors the trust boundaries: secrets, filesystem, database,
//! downloads, updates, and cross-window authority all live here; the webviews
//! only ever see typed IPC results.

pub mod app;
pub mod assets;
pub mod commands;
pub mod coordinator;
pub mod database;
pub mod dialogs;
pub mod diagnostics;
pub mod errors;
pub mod listeners;
pub mod inworld;
pub mod scripts;
pub mod secrets;
pub mod sessions;
pub mod settings;
pub mod updates;
pub mod util;
pub mod windows;

pub use errors::AppError;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    app::run()
}
