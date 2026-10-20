//! Session record commands (spec §36). These extend §46 — session records
//! need a persistence entry point even though §46 does not enumerate one.

use tauri::State;

use crate::coordinator::AppCoordinator;
use crate::database::Database;
use crate::errors::AppError;
use crate::scripts::{repo, DataPaths, ScriptId, ScriptLocks};
use crate::sessions::{self, EndSessionSummary, SessionRecord, StartSessionInput};

#[tauri::command]
pub async fn start_session(
    boot: State<'_, crate::database::BootStatus>,
    db: State<'_, Database>,
    paths: State<'_, DataPaths>,
    locks: State<'_, ScriptLocks>,
    coordinator: State<'_, AppCoordinator>,
    input: StartSessionInput,
) -> Result<SessionRecord, AppError> {
    // Recovery mode owns no writable database (database::BootStatus).
    boot.require_ready()?;
    // An installed update is about to restart the app (crate::updater).
    if let Some(refusal) = crate::updater::restart_refusal() {
        return Err(refusal);
    }
    let script_id = ScriptId::parse(&input.script_id)?;

    // Spec §21.4: capture the script as it is about to be performed BEFORE
    // the session exists, so the performed text stays recoverable. Owned by
    // Rust so it cannot be skipped by a frontend that forgets to ask.
    repo::snapshot_pre_session(db.pool(), &paths, &locks, &script_id).await?;

    let mut record = sessions::start_session(db.pool(), &input).await?;
    // Asked again, as one step with recording the take, because an install
    // can overtake the awaits above (crate::updater::begin_take_unless_restarting).
    let begun = crate::updater::begin_take_unless_restarting(|| {
        coordinator.begin_session(
            record.id.clone(),
            input.script_id.clone(),
            input.compile_hash.clone(),
        )
    });
    match begun {
        Ok(generation) => {
            record.session_generation = generation;
            Ok(record)
        }
        Err(refusal) => {
            // The row exists but no take ever ran in it.
            if let Err(err) =
                sessions::end_session(db.pool(), &record.id, sessions::EndSessionSummary::default()).await
            {
                tracing::warn!(error = %err, "could not close the refused session row");
            }
            Err(refusal)
        }
    }
}

#[tauri::command]
pub async fn end_session(
    boot: State<'_, crate::database::BootStatus>,
    db: State<'_, Database>,
    coordinator: State<'_, AppCoordinator>,
    session_id: String,
    summary: Option<EndSessionSummary>,
) -> Result<SessionRecord, AppError> {
    // Recovery mode owns no writable database (database::BootStatus).
    boot.require_ready()?;
    let record =
        match sessions::end_session(db.pool(), &session_id, summary.unwrap_or_default()).await {
            Ok(record) => record,
            Err(err) => {
                // The row is gone only when its script was deleted permanently
                // mid-take, which deletes the script's sessions. The take is
                // over all the same; left in the coordinator it would go on
                // reporting a take that is running (a locked language picker).
                if err.code() == "NOT_FOUND" {
                    coordinator.end_session(&session_id);
                }
                return Err(err);
            }
        };
    coordinator.end_session(&session_id);
    Ok(record)
}

#[tauri::command]
pub async fn list_sessions(
    db: State<'_, Database>,
    script_id: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<SessionRecord>, AppError> {
    sessions::list_sessions(db.pool(), script_id, limit.unwrap_or(100)).await
}
