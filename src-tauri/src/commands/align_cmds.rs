//! Alignment commands (§46) — the control window's handle on the live
//! alignment session.
//!
//! Thin by design: every one of these is a lifecycle call into
//! [`crate::align::AlignmentState`], which owns the engine. There is no
//! per-frame command and there never should be — transcript frames reach the
//! engine inside Rust, and snapshots leave it as events, so the IPC boundary
//! carries three lifecycle messages a take rather than one message a word.

use crate::align::{AlignToken, AlignmentState};
use crate::database::Database;
use crate::errors::AppError;
use crate::speech::SpeechEngine;

/// Begin aligning against a compiled script.
///
/// `generation` is the TRANSCRIPTION generation this alignment belongs to, so
/// frames from a superseded session can never reach a newer engine.
#[tauri::command]
pub async fn start_alignment(
    boot: tauri::State<'_, crate::database::BootStatus>,
    db: tauri::State<'_, Database>,
    state: tauri::State<'_, AlignmentState>,
    speech: tauri::State<'_, SpeechEngine>,
    generation: u64,
    tokens: Vec<AlignToken>,
) -> Result<(), AppError> {
    // Recovery mode owns no writable database (database::BootStatus).
    boot.require_ready()?;
    if tokens.is_empty() {
        return Err(AppError::invalid_input(
            "cannot align against a script with no spoken tokens",
        ));
    }
    let language = resolve_language(&db).await;
    // `generation` is the take's SESSION generation — a label, echoed onto
    // every snapshot. What the engine FILTERS frames on is the socket, which
    // Rust owns; seeding it here covers the case where the stream started
    // first, and `bind_stream` covers the case where it starts second.
    state.start_bound(generation, speech.current_generation(), &tokens, language);
    Ok(())
}

/// The language to compile this take's script in.
///
/// Read once, here, at the top of the take, rather than by the engine while it
/// runs — see [`AlignmentState::start_in`] for why that separation matters.
///
/// Two things can go wrong and both answer English, but not for the same
/// reason, and the weaker of the two is worth being honest about.
///
/// A failed settings read is a real failure and English is a degraded answer,
/// not a correct one. It is chosen because this build ships one recogniser and
/// it is English: following in the language every install starts in beats not
/// following, and the alternative is not "fail loudly" but "the take runs with
/// no following at all", since the caller in `services/session.ts` catches an
/// alignment start failure and carries on. That trade stops being right the
/// day a second language ships, at which point this should resolve the
/// language alongside the MODEL and fail when they disagree.
///
/// An unresolvable tag is different: it should be unreachable.
/// `settings::migrate_in_place` runs on every read and repairs any tag this
/// build cannot both transcribe and normalise, so `None` here means that
/// invariant broke. It is logged as such rather than silently absorbed —
/// `from_bcp47`'s own doc says pretending an unknown tag is English is never
/// right, and this is the one place that would otherwise do it quietly.
async fn resolve_language(db: &Database) -> cc_align::AlignmentLanguage {
    let tag = match crate::settings::get_settings(db.pool()).await {
        Ok(settings) => settings.value.audio.language,
        Err(err) => {
            tracing::warn!(
                "alignment: could not read the language setting ({err}); \
                 compiling as English"
            );
            return cc_align::AlignmentLanguage::English;
        }
    };
    cc_align::AlignmentLanguage::from_bcp47(tag.trim()).unwrap_or_else(|| {
        tracing::error!(
            "alignment: settings returned {tag:?}, which has no normalisation \
             profile — migrate_in_place should have repaired it before this \
             point. Compiling as English."
        );
        cc_align::AlignmentLanguage::English
    })
}

#[tauri::command]
pub async fn stop_alignment(state: tauri::State<'_, AlignmentState>) -> Result<(), AppError> {
    state.stop();
    Ok(())
}

/// Manual navigation: the presenter said where they are.
#[tauri::command]
pub async fn reacquire_alignment<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, AlignmentState>,
    first_token: f64,
    last_token: f64,
) -> Result<(), AppError> {
    if !first_token.is_finite() || !last_token.is_finite() || last_token < first_token {
        return Err(AppError::invalid_input(
            "a reacquisition window must be a finite, ordered token range",
        ));
    }
    state.reacquire_and_publish(&app, first_token, last_token);
    Ok(())
}

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

