//! CandidCue Rust core (spec §44).
//!
//! Module layout mirrors the trust boundaries: filesystem, database, downloads
//! and cross-window authority all live here; the webviews only ever see typed
//! IPC results.
//!
//! `updater` finds, verifies and installs a newer build from the project's
//! update server, and is the only module that talks to it. It holds the rules
//! the webviews cannot be trusted to keep — the endpoint, the channel, and no
//! install during a take — rather than leaving them to the UI. See
//! `docs/updates.md`.

pub mod align;
pub mod app;
pub mod assets;
pub mod backup;
pub mod commands;
pub mod coordinator;
pub mod database;
pub mod dialogs;
pub mod diagnostics;
pub mod errors;
pub mod menu;
pub mod net;
pub mod scripts;
pub mod sessions;
pub mod speech;
pub mod settings;
pub mod updater;
pub mod util;
pub mod web;
pub mod windows;

pub use errors::AppError;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    app::run()
}
