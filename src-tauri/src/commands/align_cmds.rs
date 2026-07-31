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
    db: tauri::State<'_, Database>,
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
/// Two things can go wrong and both answer English, for the same reason. A
/// settings read that fails should not take the take down: the presenter is
/// about to speak, and refusing to follow at all is worse than following in the
/// language every install starts in. A persisted tag naming a language the
/// engine has no profile for should not either — but note that this is
/// belt-and-braces rather than the real defence. `settings::migrate_in_place`
/// already repairs such a tag on every load, and it does it with a stronger
/// test than this one: it also asks whether the RECOGNISER serves the language,
/// which is what keeps a normalisable-but-unmeasured French out. By the time a
/// tag reaches here it has been through that gate.
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
        tracing::warn!(
            "alignment: no normalisation profile for {tag:?}; compiling as English"
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

