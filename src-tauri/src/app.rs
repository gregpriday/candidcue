//! Tauri builder, plugin registration, startup wiring (spec §44.1).


use tauri::{Emitter, Listener, Manager};

use crate::align::AlignmentState;
use crate::commands;
use crate::coordinator::AppCoordinator;
use crate::database::{self, Database};
use crate::speech::SpeechEngine;
use crate::scripts::{DataPaths, ScriptLocks};
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
            // On-device speech-to-text
            commands::get_speech_engine_status,
            commands::preload_speech_engine,
            commands::start_transcription,
            commands::push_transcription_audio,
            commands::stop_transcription,
            // Speech-model install (§152): the recogniser is downloaded after
            // installation rather than bundled.
            commands::get_speech_model_status,
            commands::start_speech_model_download,
            commands::cancel_speech_model_download,
            commands::delete_speech_model,
            // Speech-to-script alignment (crates/cc-align, hosted in src/align)
            commands::start_alignment,
            commands::stop_alignment,
            commands::set_alignment_position,
            // Stage / windows (spec §46.6)
            commands::list_displays,
            commands::identify_displays,
            commands::open_stage,
            commands::close_stage,
            commands::set_stage_fullscreen,
            commands::set_control_presenting,
            commands::publish_stage_document,
            commands::publish_stage_command,
            commands::get_stage_status,
            commands::save_display_profile,
            commands::list_display_profiles,
            // Settings / diagnostics (spec §46.8)
            commands::get_settings,
            commands::update_settings,
            commands::export_all_data,
            commands::clear_cache,
            commands::get_system_diagnostics,
            commands::log_client_diagnostic,
            commands::export_support_bundle,
            commands::check_for_update,
            commands::install_update,
            // Sessions (spec §36)
            commands::start_session,
            commands::end_session,
            commands::append_session_transcript,
            commands::list_sessions,
            // §36.3 take history
            commands::record_session_take,
            commands::list_session_takes,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // Data directory layout (spec §47.1).
            let data_dir = handle.path().app_data_dir()?;
            let paths = DataPaths::new(data_dir.clone());
            std::fs::create_dir_all(paths.scripts_dir())?;
            std::fs::create_dir_all(paths.cache_dir())?;
            std::fs::create_dir_all(paths.logs_dir())?;

            /*
             * Start each run with an empty client trace.
             *
             * It is a debugging artefact for the session in front of you, not
             * a history: appending across runs means whoever reads it has to
             * work out where one launch ended and the next began, and reading
             * the tail of the wrong run is how you diagnose a bug that was
             * already fixed. The Rust log keeps accumulating; this one is
             * deliberately per-launch.
             */
            let _ = std::fs::remove_file(paths.logs_dir().join("client-trace.log"));

            // Database: connect + run migrations before any command can run.
            let pool = tauri::async_runtime::block_on(database::init(&data_dir))?;
            handle.manage(Database::new(pool.clone()));
            handle.manage(paths.clone());
            handle.manage(ScriptLocks::default());

            // Cross-window authority (spec §43.4).
            handle.manage(AppCoordinator::default());

            // No credential store. The OS keychain entry existed for exactly one
            // secret — the speech provider's API key — and the recogniser is now
            // a bundled resource. The app holds no secrets at all.

            // Rust-owned recogniser: it holds the loaded model and the take's
            // streaming session. It stays in Rust because the alignment engine
            // runs beside it and the two share an audio clock.
            handle.manage(SpeechEngine::new());

            // Owns the "is a model downloading, and how far has it got" state
            // that Settings and Welcome both read (§152). Managed rather than
            // static so a download cannot outlive the app that started it.
            handle.manage(crate::speech::model_manager::SpeechModelManager::new());

            // A staging directory belongs to an install that did not finish.
            // Extraction is never resumed, so anything here is garbage that
            // would otherwise hold ~161 MB until the next successful install.
            if let Err(err) = crate::speech::model_store::clear_staging(&data_dir) {
                tracing::warn!(error = %err, "could not sweep model staging directories");
            }

            // The alignment engine runs beside the recogniser that feeds it, so a
            // transcript frame and the audio clock it is timed against never
            // have to cross a process boundary to meet.
            handle.manage(AlignmentState::new());

            // Asset protocol scope (spec §47.8, M2).
            //
            // The scripts root used to be granted RECURSIVELY here, which put
            // every script's canonical `script.md` and its whole revision
            // history in reach of the asset protocol — and therefore of the
            // stage webview, which is only supposed to be able to see media.
            // It is now described statically in tauri.conf.json
            // (`$APPDATA/scripts/*/assets/*`), with an explicit `deny` list
            // that takes precedence over any runtime widening.
            //
            // Nothing is granted at runtime any more. The one exception was the
            // bundled Listener pack directory, which in a dev build lived in the
            // repo, outside `$RESOURCE`, and so could not be expressed as a
            // static pattern. The Listener is gone (§106) and the exception with
            // it, which leaves the static config as the whole story.

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
                    // §36.1: no session can be live at startup, so any row
                    // still open belongs to a take that crashed or was force
                    // quit. Closing it here is the only path that covers the
                    // abnormal exits the frontend cannot observe.
                    match crate::sessions::close_orphaned_sessions(&pool).await {
                        Ok(0) => {}
                        Ok(n) => tracing::warn!(count = n, "closed abandoned session records"),
                        Err(err) => {
                            tracing::error!(error = %err, "closing abandoned sessions failed")
                        }
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

/// Stage → Rust event bridge (spec §43.5, §46.9): handshake progress,
/// heartbeat, media errors, and escape requests update the coordinator and
/// are relayed to control where relevant. Stale generations are ignored.
fn register_stage_event_bridge(app: &tauri::AppHandle) {
    fn generation(payload: &str) -> Option<(u64, serde_json::Value)> {
        let value: serde_json::Value = serde_json::from_str(payload).ok()?;
        let generation = value.get("stageGeneration")?.as_u64()?;
        Some((generation, value))
    }

    // Handshake step 0 (§43.3): the stage can now receive events. Anything
    // published to it before this point was evaluated against a page with no
    // listeners and is gone, so the held envelope is re-sent here. Carries no
    // generation — the stage does not know one until it has the document —
    // and the replay is generation-checked on the coordinator side instead.
    let handle = app.clone();
    app.listen_any(events::STAGE_LISTENING, move |_event| {
        handle.state::<AppCoordinator>().stage_listening();
        crate::windows::replay_stage_document(&handle);
    });

    let handle = app.clone();
    app.listen_any(events::STAGE_SYNC_REQUEST, move |event| {
        let Some((generation, _)) = generation(event.payload()) else {
            return;
        };
        crate::windows::replay_stage_live(&handle, generation);
    });

    // The stage's "this is what I can see" report (§5 of the alignment
    // integration note). It has to travel this way round because the stage
    // window holds no invoke permission at all — it can emit events and
    // nothing else — and the aligner genuinely wants the viewport, since a
    // reader who starts mid-script locks on far faster when the candidate
    // ranking knows which part of the script is on the glass.
    //
    // Scoped to the alignment session inside `apply_viewport_hint`, so a hint
    // stamped for a take that has already ended is dropped rather than applied
    // to its successor.
    let handle = app.clone();
    app.listen_any(events::STAGE_VIEWPORT_HINT, move |event| {
        let Ok(hint) = serde_json::from_str::<crate::align::ViewportHint>(event.payload()) else {
            return;
        };
        crate::align::apply_viewport_hint(&handle.state::<AlignmentState>(), &hint);
    });

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
            let accepted = coordinator.stage_event(gen, |stage| {
                stage.last_heartbeat_ms = Some(chrono::Utc::now().timestamp_millis());
                if revision.is_some() {
                    stage.last_tracking_revision = revision;
                }
                if let Some(healthy) = media_healthy {
                    stage.media_healthy = healthy;
                }
            });
            // The heartbeat was the one control↔stage route proven alive on
            // the affected rig. Make every accepted ACK carry a replay of the
            // Rust-owned checkpoint as a second, independent recovery trigger.
            if accepted {
                crate::windows::replay_stage_live(&handle, gen);
            }
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
    // for control, never a feedback loop into the aligner.
    //
    // M1: these two used to be relayed VERBATIM, with no generation check at
    // all — the only stage-originated events that were not gated. A motion
    // report or an escape press from a stage generation that is already gone
    // therefore reached control and was acted on, which for escape means
    // tearing down the take that is running now.
    //
    // S1: they also used to be relayed under the SAME name the stage emits.
    // A webview emit is a broadcast, so control's listener fired once directly
    // from the stage (bypassing the check right below) and once from this
    // relay. The stage now emits `escape-pressed`/`motion-report`; control
    // listens only for `escape-requested`/`motion-ack`, which only this code
    // path produces.
    let handle = app.clone();
    app.listen_any(events::STAGE_MOTION_REPORT, move |event| {
        if let Some((gen, value)) = generation(event.payload()) {
            let coordinator = handle.state::<AppCoordinator>();
            if coordinator.stage_event(gen, |_| {}) {
                let _ = handle.emit_to(CONTROL_LABEL, events::STAGE_MOTION_ACK, value);
            }
        }
    });

    // §62 recoverable stage-layout failure. The stage holds motion rather than
    // move on guessed line positions, so the operator has to be told — this is
    // the only path by which control learns. Relayed under its own name for the
    // S1 reason above, and generation-checked like every other stage-originated
    // event: a held layout from a stage lifetime that is already gone is not a
    // problem with the take running now.
    let handle = app.clone();
    app.listen_any(events::STAGE_LAYOUT_ERROR, move |event| {
        if let Some((gen, value)) = generation(event.payload()) {
            let coordinator = handle.state::<AppCoordinator>();
            if coordinator.stage_event(gen, |_| {}) {
                let _ = handle.emit_to(CONTROL_LABEL, events::STAGE_LAYOUT_FAILED, value);
            }
        }
    });

    let handle = app.clone();
    app.listen_any(events::STAGE_ESCAPE_PRESSED, move |event| {
        // Relay to control, which owns session shutdown policy — but only for
        // the stage that is actually live.
        if let Some((gen, value)) = generation(event.payload()) {
            let coordinator = handle.state::<AppCoordinator>();
            if coordinator.stage_event(gen, |_| {}) {
                let _ = handle.emit_to(CONTROL_LABEL, events::STAGE_ESCAPE_REQUESTED, value);
            }
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
