//! Alignment commands (§46) — the control window's handle on the live
//! alignment session.
//!
//! Thin by design: every one of these is a lifecycle call into
//! [`crate::align::AlignmentState`], which owns the engine. There is no
//! per-frame command and there never should be — transcript frames reach the
//! engine inside Rust, and snapshots leave it as events, so the IPC boundary
//! carries three lifecycle messages a take rather than one message a word.

use crate::align::{AlignToken, AlignmentState};
use crate::errors::AppError;
use crate::speech::SpeechEngine;

/// Begin aligning against a compiled script.
///
/// `generation` is the TRANSCRIPTION generation this alignment belongs to, so
/// frames from a superseded session can never reach a newer engine.
#[tauri::command]
pub async fn start_alignment(
    state: tauri::State<'_, AlignmentState>,
    speech: tauri::State<'_, SpeechEngine>,
    generation: u64,
    tokens: Vec<AlignToken>,
) -> Result<(), AppError> {
    if tokens.is_empty() {
        return Err(AppError::invalid_input(
            "cannot align against a script with no spoken tokens",
        ));
    }
    // `generation` is the take's SESSION generation — a label, echoed onto
    // every snapshot. What the engine FILTERS frames on is the socket, which
    // Rust owns; seeding it here covers the case where the stream started
    // first, and `bind_stream` covers the case where it starts second.
    state.start_bound(generation, speech.current_generation(), &tokens);
    Ok(())
}

#[tauri::command]
pub async fn stop_alignment(state: tauri::State<'_, AlignmentState>) -> Result<(), AppError> {
    state.stop();
    Ok(())
}

/// Manual navigation: the presenter said where they are.
#[tauri::command]
pub async fn set_alignment_position<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, AlignmentState>,
    token: f64,
) -> Result<(), AppError> {
    if !token.is_finite() || token < 0.0 {
        return Err(AppError::invalid_input("alignment position must be finite"));
    }
    state.set_position_and_publish(&app, token);
    Ok(())
}

