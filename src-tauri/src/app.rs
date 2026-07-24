//! Tauri builder, plugin registration, startup wiring (spec §44.1).

use std::sync::Arc;

use tauri::{Emitter, Listener, Manager};

use crate::commands::{self, openai_cmds::Secrets};
use crate::coordinator::AppCoordinator;
use crate::database::{self, Database};
use crate::listeners::ListenerLibrary;
use crate::openai::OpenAiClient;
use crate::scripts::{DataPaths, ScriptLocks};
use crate::secrets::OsSecretStore;
use crate::windows::{events, CONTROL_LABEL};

pub fn run() {
    diagnostics_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::app_version,
            // Scripts (spec §46.2)
            commands::list_scripts,
            commands::create_script,
            commands::get_script,
            commands::save_script,
            commands::rename_script,
            commands::duplicate_script,
            commands::trash_script,
            commands::restore_script,
            commands::permanently_delete_script,
            commands::list_revisions,
            commands::get_revision,
            commands::restore_revision,
            commands::import_script,
            commands::export_script,
            commands::reveal_script_folder,
            // Assets (spec §46.3)
            commands::import_image,
            commands::import_remote_image,
            commands::resolve_asset_urls,
            commands::remove_asset_reference,
            // Secrets / OpenAI (spec §46.4)
            commands::validate_openai_key,
            commands::save_openai_key,
            commands::get_openai_key_status,
            commands::delete_openai_key,
            commands::create_realtime_transcription_credential,
            commands::get_model_capabilities,
            commands::interpret_command,
            commands::analyze_vocabulary,
            // Luna semantic sidecar (companion §50.2)
            commands::prepare_semantic_landmarks,
            commands::retrieve_semantic_landmarks,
            commands::classify_semantic_tracking_window,
            commands::cancel_semantic_request,
            // Stage / windows (spec §46.6)
            commands::list_displays,
            commands::identify_displays,
            commands::open_stage,
            commands::close_stage,
            commands::set_stage_fullscreen,
            commands::publish_stage_document,
            commands::publish_stage_snapshot,
            commands::publish_stage_command,
            commands::publish_listener_state,
            commands::get_stage_status,
            commands::save_display_profile,
            commands::list_display_profiles,
            // Listeners (spec §46.7)
            commands::get_listener_catalogue,
            commands::list_installed_listeners,
            commands::download_listener,
            commands::cancel_listener_download,
            commands::remove_listener,
            commands::resolve_listener_media,
            // Settings / diagnostics (spec §46.8)
            commands::get_settings,
            commands::update_settings,
            commands::export_all_data,
            commands::clear_cache,
            commands::get_system_diagnostics,
            commands::export_support_bundle,
            commands::check_for_update,
            commands::install_update,
            // Sessions (spec §36)
            commands::start_session,
            commands::end_session,
            commands::append_session_transcript,
            commands::list_sessions,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // Data directory layout (spec §47.1).
            let data_dir = handle.path().app_data_dir()?;
            let paths = DataPaths::new(data_dir.clone());
            std::fs::create_dir_all(paths.scripts_dir())?;
            std::fs::create_dir_all(paths.listeners_dir())?;
            std::fs::create_dir_all(paths.cache_dir())?;
            std::fs::create_dir_all(paths.logs_dir())?;

            // Database: connect + run migrations before any command can run.
            let pool = tauri::async_runtime::block_on(database::init(&data_dir))?;
            handle.manage(Database::new(pool.clone()));
            handle.manage(paths.clone());
            handle.manage(ScriptLocks::default());

            // Cross-window authority (spec §43.4).
            handle.manage(AppCoordinator::default());

            // Secrets: OS credential store only (spec §44.6).
            handle.manage(Secrets(Arc::new(OsSecretStore)));

            // Rust-owned OpenAI client (spec §27.6).
            handle.manage(OpenAiClient::new());

            // Listener library: bundled packs from the repo assets dir in
            // dev, from Tauri resources in production builds.
            let library = ListenerLibrary {
                bundled_dir: resolve_bundled_listeners_dir(&handle),
                installed_dir: paths.listeners_dir(),
            };
            handle.manage(library.clone());

            // Asset protocol scope for the managed roots (spec §47.8).
            let _ = handle
                .asset_protocol_scope()
                .allow_directory(paths.scripts_dir(), true);
            let _ = handle
                .asset_protocol_scope()
                .allow_directory(paths.listeners_dir(), true);
            if library.bundled_dir.exists() {
                let _ = handle
                    .asset_protocol_scope()
                    .allow_directory(&library.bundled_dir, true);
            }

            register_stage_event_bridge(&handle);

            // Notice monitors being plugged, unplugged, or rearranged so
            // Preflight can revalidate its display selection (spec §52.5).
            crate::windows::spawn_display_watcher(&handle);

            // Startup reconciliation + retention enforcement (spec §47.6,
            // §36.2). This runs to completion HERE, synchronously, before
            // `setup` returns and therefore before the event loop dispatches
            // the first IPC message — reconciliation repairs and a user
            // command must never interleave (H3). It also uses the MANAGED
            // lock set: a private `ScriptLocks::default()` locks nothing that
            // a command would respect, which is exactly how a repair could
            // race a save.
            let reconciliation = {
                let locks = handle.state::<ScriptLocks>();
                tauri::async_runtime::block_on(async {
                    let report = crate::scripts::reconcile::run_startup_reconciliation(
                        &pool, &paths, &locks,
                    )
                    .await;
                    if let Ok(settings) = crate::settings::get_settings(&pool).await {
                        let _ = crate::sessions::enforce_transcript_retention(
                            &pool,
                            &settings.value.general.save_transcript,
                        )
                        .await;
                    }
                    report
                })
            };
            match reconciliation {
                Ok(report) => {
                    if report.has_findings() {
                        tracing::warn!(?report, "startup reconciliation had findings");
                        // Best effort: the control webview may not have
                        // installed its listener yet, so the recovery report is
                        // also written to the diagnostics directory.
                        let _ = handle.emit_to(
                            CONTROL_LABEL,
                            events::DIAGNOSTIC_WARNING,
                            serde_json::json!({
                                "kind": "startup_reconciliation",
                                "report": report,
                            }),
                        );
                    }
                }
                Err(err) => {
                    tracing::error!(error = %err, "startup reconciliation failed");
                }
            }

            tracing::info!("CandidCue started; database ready at {:?}", data_dir);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running CandidCue")
        .run(|handle, event| {
            // Never let the display-sleep assertion outlive the app, and take
            // any lingering identification overlay down with us (§52.4, §52.7).
            if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
                crate::windows::sleep::release(handle);
                crate::windows::close_identify_overlays(handle);
            }
        });
}

/// Bundled listener packs directory: `<repo>/assets/listeners` in dev,
/// `<resource dir>/listeners` in production (bundled via tauri.conf.json
/// `bundle.resources`).
fn resolve_bundled_listeners_dir(app: &tauri::AppHandle) -> std::path::PathBuf {
    if cfg!(debug_assertions) {
        let dev = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("assets")
            .join("listeners");
        if dev.exists() {
            return dev;
        }
    }
    app.path()
        .resource_dir()
        .map(|dir| dir.join("listeners"))
        .unwrap_or_else(|_| std::path::PathBuf::from("listeners"))
}

/// Stage → Rust event bridge (spec §43.5, §46.9): handshake progress,
/// heartbeat, media errors, and escape requests update the coordinator and
/// are relayed to control where relevant. Stale generations are ignored.
fn register_stage_event_bridge(app: &tauri::AppHandle) {
    fn generation(payload: &str) -> Option<(u64, serde_json::Value)> {
        let value: serde_json::Value = serde_json::from_str(payload).ok()?;
        let generation = value.get("stageGeneration")?.as_u64()?;
        Some((generation, value))
    }

    let handle = app.clone();
    app.listen_any(events::STAGE_HYDRATED, move |event| {
        if let Some((gen, _)) = generation(event.payload()) {
            let coordinator = handle.state::<AppCoordinator>();
            coordinator.stage_event(gen, |stage| stage.hydrated = true);
        }
    });

    // The handshake completes at layout-ready (§43.3 hydration → fonts →
    // layout); only then does control learn the stage is ready to show.
    let handle = app.clone();
    app.listen_any(events::STAGE_LAYOUT_READY, move |event| {
        if let Some((gen, value)) = generation(event.payload()) {
            let coordinator = handle.state::<AppCoordinator>();
            if coordinator.stage_event(gen, |stage| {
                stage.hydrated = true;
                stage.layout_ready = true;
            }) {
                let _ = handle.emit_to(
                    CONTROL_LABEL,
                    events::STAGE_READY,
                    serde_json::json!({
                        "stageGeneration": gen,
                        "sessionId": value.get("sessionId"),
                        "layoutReady": true,
                    }),
                );
            }
        }
    });

    let handle = app.clone();
    app.listen_any(events::STAGE_HEARTBEAT_ACK, move |event| {
        if let Some((gen, value)) = generation(event.payload()) {
            let coordinator = handle.state::<AppCoordinator>();
            let revision = value.get("trackingRevision").and_then(|v| v.as_i64());
            let media_healthy = value.get("mediaHealthy").and_then(|v| v.as_bool());
            coordinator.stage_event(gen, |stage| {
                stage.last_heartbeat_ms = Some(chrono::Utc::now().timestamp_millis());
                if revision.is_some() {
                    stage.last_tracking_revision = revision;
                }
                if let Some(healthy) = media_healthy {
                    stage.media_healthy = healthy;
                }
            });
        }
    });

    let handle = app.clone();
    app.listen_any(events::STAGE_MEDIA_ERROR, move |event| {
        if let Some((gen, value)) = generation(event.payload()) {
            let coordinator = handle.state::<AppCoordinator>();
            if coordinator.stage_event(gen, |stage| stage.media_healthy = false) {
                let _ = handle.emit_to(CONTROL_LABEL, events::STAGE_ERROR, value);
            }
        }
    });

    // Periodic stage motion report (companion §54): diagnostics and recovery
    // for control, never a feedback loop into the aligner. Relayed verbatim.
    let handle = app.clone();
    app.listen_any(events::STAGE_MOTION_ACK, move |event| {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(event.payload()) {
            let _ = handle.emit_to(CONTROL_LABEL, events::STAGE_MOTION_ACK, value);
        }
    });

    let handle = app.clone();
    app.listen_any(events::STAGE_ESCAPE_REQUESTED, move |event| {
        // Relay to control, which owns session shutdown policy.
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(event.payload()) {
            let _ = handle.emit_to(CONTROL_LABEL, events::STAGE_ESCAPE_REQUESTED, value);
        }
    });
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
