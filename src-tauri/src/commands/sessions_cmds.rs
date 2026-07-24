//! Session record commands (spec §36). These extend §46 — session records
//! need a persistence entry point even though §46 does not enumerate one.

use tauri::State;

use crate::coordinator::AppCoordinator;
use crate::database::Database;
use crate::errors::AppError;
use crate::scripts::{repo, DataPaths, ScriptId, ScriptLocks};
use crate::sessions::{
    self, EndSessionSummary, SessionRecord, SessionTakeInput, SessionTakeRecord, StartSessionInput,
    TranscriptItemInput,
};

#[tauri::command]
pub async fn start_session(
    db: State<'_, Database>,
    paths: State<'_, DataPaths>,
    locks: State<'_, ScriptLocks>,
    coordinator: State<'_, AppCoordinator>,
    input: StartSessionInput,
) -> Result<SessionRecord, AppError> {
    let script_id = ScriptId::parse(&input.script_id)?;

    // Transcript retention is gated by settings (spec §36.2) and fixed at
    // session start — never silently enabled mid-session.
    let settings = crate::settings::get_settings(db.pool()).await?;
    let retention_enabled = settings.value.general.save_transcript != "off";

    // Spec §21.4: capture the script as it is about to be performed BEFORE
    // the session exists, so the performed text stays recoverable. Owned by
    // Rust so it cannot be skipped by a frontend that forgets to ask.
    repo::snapshot_pre_session(db.pool(), &paths, &locks, &script_id).await?;

    let mut record = sessions::start_session(db.pool(), &input, retention_enabled).await?;
    let generation = coordinator.begin_session(
        record.id.clone(),
        input.script_id.clone(),
        input.compile_hash.clone(),
    );
    record.session_generation = generation;
    Ok(record)
}

#[tauri::command]
pub async fn end_session(
    db: State<'_, Database>,
    coordinator: State<'_, AppCoordinator>,
    session_id: String,
    summary: Option<EndSessionSummary>,
) -> Result<SessionRecord, AppError> {
    let record =
        sessions::end_session(db.pool(), &session_id, summary.unwrap_or_default()).await?;
    coordinator.end_session(&session_id);
    Ok(record)
}

#[tauri::command]
pub async fn append_session_transcript(
    db: State<'_, Database>,
    session_id: String,
    items: Vec<TranscriptItemInput>,
) -> Result<u32, AppError> {
    sessions::append_transcript_items(db.pool(), &session_id, items).await
}

/// §36.3 take history. Upserts on `(session_id, passOrdinal)`, so a take may be
/// written while it is open and completed later; a different ordinal is always a
/// different take.
#[tauri::command]
pub async fn record_session_take(
    db: State<'_, Database>,
    session_id: String,
    take: SessionTakeInput,
) -> Result<SessionTakeRecord, AppError> {
    sessions::record_take(db.pool(), &session_id, take).await
}

#[tauri::command]
pub async fn list_session_takes(
    db: State<'_, Database>,
    session_id: String,
) -> Result<Vec<SessionTakeRecord>, AppError> {
    sessions::list_takes(db.pool(), &session_id).await
}

#[tauri::command]
pub async fn list_sessions(
    db: State<'_, Database>,
    script_id: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<SessionRecord>, AppError> {
    sessions::list_sessions(db.pool(), script_id, limit.unwrap_or(100)).await
}
