//! Session records (spec §36.1): one row per session with aggregate metrics,
//! and never transcript text.
//!
//! Optional transcript retention (§36.2) and per-take history (§36.3) used to
//! live here too. Takes stopped writing either (#214), and #217 removed the
//! storage along with what earlier builds had kept in it.

use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

use crate::errors::AppError;
use crate::util::{new_uuid, now_iso};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub id: String,
    pub session_generation: u64,
    pub script_id: String,
    pub script_source_hash: String,
    pub started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    pub mode: String,
    pub start_token_index: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_token_index: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
    pub soft_pause_ms: i64,
    pub command_count: i64,
    pub retake_count: i64,
    pub reconnect_count: i64,
    pub manual_correction_count: i64,
    /*
     * No `estimated_cost_usd`. It was per-take API spend from the hosted
     * transcription era. Transcription runs on this machine now, so a take
     * costs nothing — and a field that can only ever hold 0 is an invitation
     * for a screen to display a confident zero for a number that has no
     * meaning. The column went with it in the 1.0 schema baseline.
     *
     * No `transcript_retained` either: it was the consent latch for retained
     * transcripts, and went with them (#217).
     */
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartSessionInput {
    pub script_id: String,
    pub script_source_hash: String,
    /// 'voice' | 'manual' | 'fixed'.
    pub mode: String,
    #[serde(default)]
    pub start_token_index: i64,
    #[serde(default)]
    pub compile_hash: Option<String>,
}

/// End-of-session summary (spec §36.1 aggregate metrics).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndSessionSummary {
    #[serde(default)]
    pub end_token_index: Option<i64>,
    #[serde(default)]
    pub soft_pause_ms: Option<i64>,
    #[serde(default)]
    pub command_count: Option<i64>,
    #[serde(default)]
    pub retake_count: Option<i64>,
    #[serde(default)]
    pub reconnect_count: Option<i64>,
    #[serde(default)]
    pub manual_correction_count: Option<i64>,
    /// Aggregate tracking quality metrics without transcript text.
    #[serde(default)]
    pub metrics: Option<serde_json::Value>,
}

fn record_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<SessionRecord, sqlx::Error> {
    Ok(SessionRecord {
        id: row.try_get("id")?,
        session_generation: 0,
        script_id: row.try_get("script_id")?,
        script_source_hash: row.try_get("script_source_hash")?,
        started_at: row.try_get("started_at")?,
        ended_at: row.try_get("ended_at")?,
        mode: row.try_get("mode")?,
        start_token_index: row.try_get("start_token_index")?,
        end_token_index: row.try_get("end_token_index")?,
        duration_ms: row.try_get("duration_ms")?,
        soft_pause_ms: row.try_get("soft_pause_ms")?,
        command_count: row.try_get("command_count")?,
        retake_count: row.try_get("retake_count")?,
        reconnect_count: row.try_get("reconnect_count")?,
        manual_correction_count: row.try_get("manual_correction_count")?,
    })
}

pub async fn start_session(
    pool: &SqlitePool,
    input: &StartSessionInput,
) -> Result<SessionRecord, AppError> {
    if !matches!(input.mode.as_str(), "voice" | "manual" | "fixed") {
        return Err(AppError::invalid_input("Session mode must be voice, manual, or fixed."));
    }
    let script_id = crate::scripts::ScriptId::parse(&input.script_id)?;
    if !crate::scripts::repo::script_exists(pool, &script_id).await? {
        return Err(AppError::not_found("script"));
    }
    let id = new_uuid();
    let now = now_iso();
    sqlx::query(
        "INSERT INTO sessions
            (id, script_id, script_source_hash, started_at, mode, start_token_index,
             created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&input.script_id)
    .bind(&input.script_source_hash)
    .bind(&now)
    .bind(&input.mode)
    .bind(input.start_token_index)
    .bind(&now)
    .execute(pool)
    .await?;

    let row = sqlx::query("SELECT * FROM sessions WHERE id = ?")
        .bind(&id)
        .fetch_one(pool)
        .await?;
    Ok(record_from_row(&row)?)
}

pub async fn end_session(
    pool: &SqlitePool,
    session_id: &str,
    summary: EndSessionSummary,
) -> Result<SessionRecord, AppError> {
    let row = sqlx::query("SELECT * FROM sessions WHERE id = ?")
        .bind(session_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::not_found("session"))?;
    let started_at: String = row.try_get("started_at")?;
    let now = now_iso();
    let duration_ms = chrono::DateTime::parse_from_rfc3339(&started_at)
        .ok()
        .map(|start| {
            (chrono::Utc::now() - start.with_timezone(&chrono::Utc))
                .num_milliseconds()
                .max(0)
        });

    sqlx::query(
        "UPDATE sessions SET
            ended_at = ?, duration_ms = ?,
            end_token_index = COALESCE(?, end_token_index),
            soft_pause_ms = COALESCE(?, soft_pause_ms),
            command_count = COALESCE(?, command_count),
            retake_count = COALESCE(?, retake_count),
            reconnect_count = COALESCE(?, reconnect_count),
            manual_correction_count = COALESCE(?, manual_correction_count),
            metrics_json = COALESCE(?, metrics_json)
         WHERE id = ?",
    )
    .bind(&now)
    .bind(duration_ms)
    .bind(summary.end_token_index)
    .bind(summary.soft_pause_ms)
    .bind(summary.command_count)
    .bind(summary.retake_count)
    .bind(summary.reconnect_count)
    .bind(summary.manual_correction_count)
    .bind(summary.metrics.as_ref().and_then(|m| serde_json::to_string(m).ok()))
    .bind(session_id)
    .execute(pool)
    .await?;

    // Re-read as optional: a permanent delete of the script can remove the row
    // between the two reads, and that is the same "gone", not a database fault.
    let row = sqlx::query("SELECT * FROM sessions WHERE id = ?")
        .bind(session_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::not_found("session"))?;
    Ok(record_from_row(&row)?)
}

pub async fn list_sessions(
    pool: &SqlitePool,
    script_id: Option<String>,
    limit: u32,
) -> Result<Vec<SessionRecord>, AppError> {
    let limit = limit.clamp(1, 500) as i64;
    let rows = match script_id {
        Some(id) => {
            sqlx::query(
                "SELECT * FROM sessions WHERE script_id = ? ORDER BY started_at DESC LIMIT ?",
            )
            .bind(id)
            .bind(limit)
            .fetch_all(pool)
            .await?
        }
        None => {
            sqlx::query("SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?")
                .bind(limit)
                .fetch_all(pool)
                .await?
        }
    };
    rows.iter()
        .map(record_from_row)
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(Into::into)
}

/// Close session rows that were never ended (spec §36.1).
///
/// The frontend ends a session on every path it controls, but it cannot end one
/// on the paths it does not: a crash, a force quit, a power loss. Those leave a
/// row with `ended_at IS NULL` forever, which makes "the session that is running
/// right now" indistinguishable from "a session that died in 2024" for anything
/// that reads the table. Called at startup, when by definition no session is
/// live, so every open row is by definition abandoned.
///
/// `duration_ms` is deliberately left NULL rather than computed from `started_at`
/// — nobody knows when an abandoned take actually stopped, and inventing a
/// duration would put a fabricated number in the one place §36.1 metrics are
/// read from.
pub async fn close_orphaned_sessions(pool: &SqlitePool) -> Result<u64, AppError> {
    let now = now_iso();
    let result = sqlx::query("UPDATE sessions SET ended_at = ? WHERE ended_at IS NULL")
        .bind(&now)
        .execute(pool)
        .await?;
    Ok(result.rows_affected())
}
