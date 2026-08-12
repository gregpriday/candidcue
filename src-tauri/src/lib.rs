//! CandidCue Rust core (spec §44).
//!
//! Module layout mirrors the trust boundaries: filesystem, database, downloads
//! and cross-window authority all live here; the webviews only ever see typed
//! IPC results.
//!
//! There is no `updates` module. CandidCue 1.0 updates manually: the user
//! downloads a new build and replaces the app. An `updates` stub used to sit
//! here holding an `UpdateCheckCadence` enum that defaulted to `Daily`, beside
//! two commands that always returned `NOT_IMPLEMENTED` — a contract a future
//! change could have switched on without doing any of the signing or privacy
//! work an updater needs. See `docs/updates.md`.

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
pub mod net;
pub mod scripts;
pub mod sessions;
pub mod speech;
pub mod settings;
pub mod util;
pub mod windows;

pub use errors::AppError;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    app::run()
}
