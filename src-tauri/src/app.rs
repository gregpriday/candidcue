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
    // Logging is initialised inside `setup`, not here. It needs the log
    // directory, the log directory comes from the app data dir, and that needs
    // an `AppHandle` which does not exist until the builder does. See
    // `diagnostics::logging::init`.
    tauri::Builder::default()
        /*
         * One instance, and it must be FIRST.
         *
         * The plugin works by having the second process hand its arguments to
         * the first and exit. That handover happens during plugin
         * initialisation, so every plugin registered before this one would run
         * in the doomed process — and `setup` below is where the database pool
         * opens, interrupted model installs are recovered, and startup
         * reconciliation rewrites script files. None of that is designed as a
         * multi-process transaction.
         *
         * SQLite can coordinate two writers. The things around it cannot: the
         * canonical Markdown tree, `model_store`'s staging/backup/commit
         * sequence, the deterministic partial-download paths, and
         * reconciliation's repair pass are all guarded by in-memory locks
         * (`ScriptLocks`, the model-operation mutex) that a second process
         * simply does not participate in. `model_store`'s own comments already
         * account for "another process may be doing this" and cannot actually
         * defend against it.
         *
         * The callback runs in the SURVIVING process, so the right thing to do
         * with a second launch is to show the window the user was really
         * asking for.
         */
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let Some(window) = app.get_webview_window(CONTROL_LABEL) else {
                // No control window means the first instance is still inside
                // `setup` — or has lost its window entirely. Either way there
                // is nothing to focus, and the second process has already done
                // the important half of its job by declining to start.
                tracing::warn!("second launch: no control window to focus");
                return;
            };
            // Unminimise before focusing: a minimised window accepts focus
            // without coming back on screen, which looks exactly like the app
            // refusing to open.
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
            tracing::info!("second launch refused; focused the running instance");
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::app_version,
            // Recovery (§48.5). These work on FILES and never open the damaged
            // database for writing, because the failures they exist for are
            // the ones that stop the application starting at all.
            commands::get_boot_status,
            commands::list_database_backups,
            commands::restore_database_backup,
            commands::rebuild_database_index,
            commands::rescue_scripts,
            commands::reveal_data_folder,
            commands::write_unsaved_recovery,
            commands::get_startup_findings,
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
            // No `import_remote_image`. The URL-based image import has no UI
            // caller — the editor imports local files and the compiler rejects
            // remote images — so registering it was standing permission for a
            // network path nobody uses. It is feature-gated off for 1.0
            // (`remote-images`); the hardened implementation is still there.
            commands::open_model_licence,
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
            // Language choice (§153): the user picks a language; the model is
            // an implementation detail of that choice.
            commands::get_speech_language_options,
            commands::select_speech_language,
            // Speech-to-script alignment (crates/cc-align, hosted in src/align)
            commands::start_alignment,
            commands::stop_alignment,
            commands::set_alignment_position,
            commands::reacquire_alignment,
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
            commands::restore_all_data,
            commands::clear_cache,
            commands::get_system_diagnostics,
            commands::log_client_diagnostic,
            commands::export_support_bundle,
            // Desktop shell (refinement §5, §6)
            commands::set_menu_state,
            commands::set_window_title,
            commands::set_drop_target_script,
            commands::open_preferences,
            commands::close_preferences,
            commands::focus_app_window,
            commands::reveal_logs,
            // No `check_for_update` / `install_update`. CandidCue 1.0 updates
            // manually (docs/updates.md); both used to be registered here and
            // always returned NOT_IMPLEMENTED, which put a dead command on the
            // ACL that a later change could have quietly filled in.
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
             * Logs, before anything that might need explaining happens.
             *
             * This is the first thing after the directories exist, so the
             * database connection, the migrations, the model recovery and the
             * startup reconciliation below are all inside the captured window.
             * A packaged build launched from Finder has no stdout — launchd
             * points it at /dev/null — so until this line runs, every warning
             * this app can emit goes nowhere at all (§179).
             *
             * A failure here does NOT stop the app. `create_dir_all` two lines
             * up proves the directory exists, not that it can be written to —
             * an existing read-only `logs/` satisfies it and then fails to open
             * a log file. Propagating that would turn "cannot write logs" into
             * "will not launch", and Tauri turns a setup error into a panic
             * that a release build aborts on before this very hook is
             * installed: the user would get an app that vanishes from Finder
             * with nothing on screen and nothing on disk saying why.
             *
             * Refusing to start is the wrong trade for a teleprompter. It falls
             * back to stdout, which is at least visible under `tauri dev`, and
             * says why as loudly as it still can.
             */
            match crate::diagnostics::logging::init(&paths.logs_dir()) {
                Ok(logging) => {
                    handle.manage(logging);
                }
                Err(err) => {
                    crate::diagnostics::logging::init_stdout_only();
                    tracing::error!(
                        error = %err,
                        path = %paths.logs_dir().display(),
                        "no log file: this run cannot be debugged from a support bundle"
                    );
                }
            }

            /*
             * Start each run with an empty client trace — but keep the last one.
             *
             * It is a debugging artefact for the session in front of you, not
             * a history: appending across runs means whoever reads it has to
             * work out where one launch ended and the next began, and reading
             * the tail of the wrong run is how you diagnose a bug that was
             * already fixed. The Rust log keeps accumulating; this one is
             * deliberately per-launch.
             *
             * It used to be DELETED here, which meant a crash followed by the
             * reflex relaunch destroyed the only record of the crash. Renaming
             * it keeps both properties: the live file still holds exactly one
             * launch, and the launch that just died is still on disk.
             */
            if let Err(err) = crate::diagnostics::logging::rotate_client_trace(&paths.logs_dir()) {
                // Not fatal. The old trace stays where it is and the new run
                // appends to it — worse to read, but nothing is lost, and
                // refusing to start over a rename is out of proportion.
                tracing::warn!(error = %err, "could not rotate the client trace");
            }

            /*
             * Database: connect + run migrations before any command can run.
             *
             * A failure here used to `?` straight out of `setup`, which aborts
             * startup BEFORE a webview exists — so `DATABASE_CORRUPT` and a
             * failed migration, the two failures most likely to need a human,
             * removed every in-app recovery action at exactly the moment one
             * was needed. In a release build (`panic = "abort"`) the user got
             * an application that vanished from the Dock with nothing on
             * screen saying why.
             *
             * The failure is carried into the running app instead. The window
             * opens, `get_boot_status` reports what happened, and the frontend
             * renders recovery instead of the application. See
             * `database::BootStatus`.
             */
            let (pool, boot_status) = match tauri::async_runtime::block_on(database::init(&data_dir))
            {
                Ok(pool) => (pool, database::BootStatus::Ready),
                Err(err) => {
                    tracing::error!(
                        error = %err,
                        "database did not come up; starting in recovery mode"
                    );
                    // An empty in-memory pool so that `State<'_, Database>` is
                    // managed and no command panics on the way to the recovery
                    // screen. Nothing on disk is opened.
                    let scratch = tauri::async_runtime::block_on(
                        database::in_memory_recovery_pool(),
                    )?;
                    (scratch, database::BootStatus::Failed(err))
                }
            };
            let database_ready = boot_status.is_ready();
            handle.manage(boot_status);
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

            // Put back any model whose replacement was interrupted mid-commit
            // (§152). Restore-only: it never deletes, so it cannot damage an
            // install running in another instance. Stale staging is swept by
            // the next install of that model instead, which is the moment it
            // is provably garbage.
            crate::speech::model_store::recover_interrupted(&data_dir);

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
            //
            // Skipped entirely in recovery mode. Reconciliation REPAIRS: it
            // deletes stale temp files, inserts recovered rows, purges trash
            // and rewrites index state. Running any of that against the scratch
            // in-memory pool would compare the canonical files on disk against
            // an empty database and "recover" every one of them into a store
            // that disappears when the process exits — while touching the real
            // files on the way.
            let reconciliation = if !database_ready {
                tracing::warn!("recovery mode: skipping startup reconciliation");
                Ok(Default::default())
            } else {
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
                        /*
                         * STORED, then announced — not announced and hoped for.
                         *
                         * This used to be an emit alone, with a comment
                         * admitting the race: reconciliation finishes inside
                         * `setup`, which is before the control webview has
                         * executed a line of JavaScript, so the event lands on
                         * a page with no listeners and is gone. A Tauri event
                         * is delivered by evaluating JS in the target webview
                         * and is never queued.
                         *
                         * The findings now sit in managed state that the
                         * frontend QUERIES once it is up
                         * (`get_startup_findings`). The event stays as a nudge
                         * for a window that is already listening; it is no
                         * longer the only delivery.
                         */
                        handle.manage(crate::scripts::reconcile::StartupFindings::new(
                            report.clone(),
                        ));
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

            handle.manage(crate::windows::shutdown::ShutdownState::default());
            install_close_coordinator(&handle);

            /*
             * The native menu, and the window's last resting frame.
             *
             * Both are deliberately at the END of setup rather than the start.
             * `restore_window_frame` reads `DataPaths`, which is only managed a
             * hundred lines up, and it moves the window — which is a thing best
             * done once, before the first frame is painted, rather than
             * competing with a webview that is already loading.
             *
             * `menu::install` builds every item DISABLED; the frontend enables
             * what it can answer as soon as its stores are up. That ordering is
             * the point: a menu bar live before the app has loaded a library is
             * a menu bar whose File › Present acts on nothing.
             */
            crate::menu::install(&handle);
            /*
             * Markdown dropped on the window, imported IN RUST.
             *
             * See `windows/drag_drop.rs` for why the obvious JavaScript
             * implementation is the wrong one: a dropped path is an absolute
             * filesystem path chosen outside the app, and §50.7's rule is that
             * no such path is ever named by, or passed through, the renderer.
             */
            handle.manage(crate::windows::drag_drop::DropTargetScript::default());
            crate::windows::drag_drop::install(&handle);
            crate::commands::shell_cmds::restore_window_frame(&handle);
            install_window_frame_recorder(&handle);

            tracing::info!("CandidCue started; database ready at {:?}", data_dir);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running CandidCue")
        .run(|handle, event| {
            /*
             * Quit (⌘Q, the application menu, a logout) as well as a window
             * close. `ExitRequested` fires before the process goes away and
             * can be prevented, which is what gives the frontend its one
             * bounded chance to flush.
             *
             * `ShutdownState` makes the handshake idempotent: on macOS ⌘Q can
             * produce both a window close and an exit request, and asking the
             * frontend to flush while it is already flushing would be worse
             * than not asking.
             */
            if let tauri::RunEvent::ExitRequested { api, .. } = &event {
                let state = handle.state::<crate::windows::shutdown::ShutdownState>();
                if !state.is_finished() {
                    api.prevent_exit();
                    let handle = handle.clone();
                    // Off the event loop: the handshake blocks for up to
                    // SHUTDOWN_DEADLINE, and blocking the loop would stop the
                    // webview being able to answer at all — a deadlock that
                    // would always time out.
                    std::thread::spawn(move || {
                        // Only the caller that OWNS the handshake exits. A
                        // non-owner returns immediately because the claim is
                        // already taken, and exiting there would kill the
                        // process while the owner was still flushing.
                        if crate::windows::shutdown::run_shutdown_handshake(&handle) {
                            handle.exit(0);
                        }
                    });
                }
            }

            // Never let the display-sleep assertion outlive the app, and take
            // any lingering identification overlay down with us (§52.4, §52.7).
            if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
                crate::windows::sleep::release(handle);
                crate::windows::close_identify_overlays(handle);
            }
        });
}

/// Remember where the control window rests (desktop refinement §5.3).
///
/// A desktop application that reopens 1240 × 820 in the middle of the screen
/// every launch, no matter how the user last arranged it, is one of the plainest
/// tells that a window belongs to a web page rather than to the desktop. This is
/// the recording half; `shell_cmds::restore_window_frame` is the replay.
///
/// Two things it deliberately does NOT do:
///
///   - it does not record while a take is running. Presentation rewrites the
///     window to fill a monitor with no titlebar, and storing that would reopen
///     the app at teleprompter size. `present::is_presenting` is the same latch
///     the presentation state machine reads, so there is one answer.
///   - it does not write on every event. A drag produces a `Moved` per frame;
///     writing a file per frame would put a few hundred writes on the disk for
///     one gesture. The frame is written at most once per second, and — because
///     the last event of a drag is the one that matters — the recorder always
///     writes once more after the window has been still for that interval.
fn install_window_frame_recorder(app: &tauri::AppHandle) {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc;
    use std::sync::Arc;
    use std::time::Duration;

    let Some(window) = app.get_webview_window(CONTROL_LABEL) else {
        return;
    };

    /*
     * ONE long-lived worker and a counter, not a thread per burst.
     *
     * The first version spawned a thread on the leading edge of each burst and
     * had it poll a shared `Option<Instant>`. That had a lost-update race with
     * no good outcome: the worker decided the timestamp was old enough, RELEASED
     * the lock, then reacquired it to clear the slot — and an event arriving in
     * that gap set a fresh timestamp, saw the slot occupied, declined to spawn,
     * and then had its timestamp cleared by the departing worker. The trailing
     * write of that gesture never happened. Running the other way round, an
     * event immediately after the clear started a second worker while the first
     * was still writing.
     *
     * A channel plus a monotonically increasing counter removes the shared
     * mutable state entirely. Every event bumps the counter and pokes the
     * worker; the worker sleeps, then writes ONLY if the counter has not moved
     * since it woke — so the write always belongs to the last event of a
     * gesture, and there is only ever one writer.
     */
    let generation = Arc::new(AtomicU64::new(0));
    let (tx, rx) = mpsc::channel::<()>();

    let handle = app.clone();
    let worker_generation = generation.clone();
    std::thread::spawn(move || {
        // Ends when the sender is dropped, which happens when the window's
        // event handler is torn down at shutdown. No leaked thread.
        while rx.recv().is_ok() {
            // Drain anything that piled up while we were writing, so a burst
            // costs one wait rather than one per event.
            while rx.try_recv().is_ok() {}
            loop {
                let before = worker_generation.load(Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(400));
                if worker_generation.load(Ordering::SeqCst) == before {
                    break;
                }
                // Still moving; wait again from the newer mark.
            }
            // Re-checked after the wait: a take can start during it, and the
            // frame this would store is then the presentation's.
            if crate::windows::present::is_presenting() {
                continue;
            }
            let Some(window) = handle.get_webview_window(CONTROL_LABEL) else {
                continue;
            };
            let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else {
                continue;
            };
            let Some(paths) = handle.try_state::<crate::scripts::DataPaths>() else {
                continue;
            };
            if let Err(err) = crate::commands::shell_cmds::write_frame(
                &paths,
                crate::commands::shell_cmds::WindowFrame {
                    x: position.x,
                    y: position.y,
                    width: size.width,
                    height: size.height,
                },
            ) {
                tracing::debug!(error = ?err, "the window frame could not be recorded");
            }
        }
    });

    window.on_window_event(move |event| {
        if !matches!(
            event,
            tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)
        ) {
            return;
        }
        if crate::windows::present::is_presenting() {
            return;
        }
        generation.fetch_add(1, Ordering::SeqCst);
        // A closed channel means the worker is gone (shutdown). Nothing to do.
        let _ = tx.send(());
    });
}

/// Intercept the control window's close button.
///
/// Closing the window is a quit on macOS as far as a user is concerned — there
/// is one window and no dock-icon reopen — but it arrives as a WINDOW event,
/// not an application one, so it needs its own interception. Both paths reach
/// the same handshake, and `ShutdownState` stops them running it twice.
fn install_close_coordinator(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window(CONTROL_LABEL) else {
        tracing::warn!("no control window to install the close coordinator on");
        return;
    };
    let handle = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            let state = handle.state::<crate::windows::shutdown::ShutdownState>();
            if state.is_finished() {
                return;
            }
            api.prevent_close();
            let handle = handle.clone();
            std::thread::spawn(move || {
                // Owner-only exit; see the ExitRequested handler above.
                if crate::windows::shutdown::run_shutdown_handshake(&handle) {
                    handle.exit(0);
                }
            });
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
