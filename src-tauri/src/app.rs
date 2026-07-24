//! Tauri builder, plugin registration, startup wiring (spec §44.1).

use tauri::Manager;

use crate::commands;
use crate::coordinator::AppCoordinator;
use crate::database::{self, Database};

pub fn run() {
    diagnostics_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::app_version,
            commands::list_scripts,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // Database: connect + run migrations before any command can run.
            let data_dir = handle.path().app_data_dir()?;
            let pool = tauri::async_runtime::block_on(database::init(&data_dir))?;
            handle.manage(Database::new(pool));

            // Cross-window authority (spec §43.4).
            handle.manage(AppCoordinator::default());

            tracing::info!("CandidCue started; database ready at {:?}", data_dir);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running CandidCue");
}

fn diagnostics_init() {
    // Structured logs with env-filter; redaction rules land in `diagnostics`.
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .try_init();
}
