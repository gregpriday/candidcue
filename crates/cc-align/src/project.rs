//! Atom space → token space: the snapshot the app actually publishes.
//!
//! WHY THIS IS IN THE ENGINE CRATE
//! ------------------------------
//! The engine works in ATOMS (a token can expand into several — "twenty-seven"
//! against `27`), and every consumer outside it works in TOKENS. That
//! conversion used to live in `src-tauri/src/align/mod.rs`, which is the only
//! place it was needed and the one place the benchmark harness cannot reach.
//!
//! The consequence was a hole exactly where the product's own question lives.
//! `cc-bench` could prove the ENGINE follows — Tier A and Tier B both replay
//! real captured speech and score the result — and could say nothing at all
//! about whether the STAGE follows, because it could not produce the thing the
//! stage consumes. The two halves were benchmarked and shipped separately, and
//! "the aligner is fine, the glass never moved" is precisely the failure that
//! falls between them.
//!
//! So the projection lives here, the app calls it, and the harness calls the
//! same function. A fixture emitted by `cc-bench` is byte-identical to what a
//! take publishes, which is what lets a browser test replay real speech through
//! the real renderer and assert that the words arrive under the reader's eye.
use serde::Serialize;

use crate::script::CompiledScript;
use crate::tracker::{DecisionCode, Snapshot, TrackingState};

/// The user-facing state contract. These four strings are matched exhaustively
/// in TypeScript (`ALIGNMENT_STATES`); renaming one would compile on both sides
/// and silently stop the stage from following.
pub fn state_name(state: TrackingState) -> &'static str {
    match state {
        TrackingState::Searching => "searching",
        TrackingState::Following => "following",
        TrackingState::Holding => "holding",
        TrackingState::Ambiguous => "ambiguous",
    }
}

/// Diagnostics vocabulary. Deliberately NOT parallel to `state_name`: these are
/// for a log line and a debug panel, and mapping them to user-facing text is
/// what the integration note forbids.
pub fn decision_name(decision: DecisionCode) -> &'static str {
    match decision {
        DecisionCode::NoEvidence => "noEvidence",
        DecisionCode::LocalObserved => "localObserved",
        DecisionCode::LocalConfirmed => "localConfirmed",
        DecisionCode::HoldLowEvidence => "holdLowEvidence",
        DecisionCode::HoldOffScript => "holdOffScript",
        DecisionCode::HoldAmbiguous => "holdAmbiguous",
        DecisionCode::RelocationAccepted => "relocationAccepted",
        DecisionCode::JumpForwardAccepted => "jumpForwardAccepted",
        DecisionCode::RetakeAccepted => "retakeAccepted",
        DecisionCode::JumpPending => "jumpPending",
        DecisionCode::ManualAnchor => "manualAnchor",
    }
}

/// What the stage and control receive after every transcript event.
///
/// Positions are FRACTIONAL TOKEN INDEXES into the compiled script. `display_at`
/// is reproduced on the stage from `observed_token` / `rate_tokens_per_second` /
/// the audio stamps, so the 60 Hz motion loop never calls back into Rust.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenSnapshot {
    /// The alignment session this belongs to. A snapshot from a superseded
    /// session must be discarded rather than followed.
    pub session_generation: u64,
    /// Monotone per session; the stage drops anything not newer.
    pub seq: u64,
    pub state: &'static str,
    /// Diagnostics only. Never map this to user-facing copy.
    pub decision: &'static str,
    /// Conservative anchor: progress, "words covered", recovery UI.
    pub confirmed_token: f64,
    /// Best evidence-supported position. NOT the scroll target.
    pub observed_token: f64,
    /// Rate for display extrapolation, tokens/sec. Already zero whenever
    /// extrapolating would be a guess, and already below the reader's true
    /// pace so the display trails rather than leads.
    pub rate_tokens_per_second: f64,
    pub evidence_audio_ms: f64,
    pub at_audio_ms: f64,
    pub max_prediction_ms: f64,
    pub pause_onset_ms: f64,
    pub lead_floor_ms: f64,
    pub max_lead_tokens: f64,
    /// Distance the display sits behind its estimate while flowing, in tokens.
    pub lead_margin_tokens: f64,
    /// Corner-rounding widths for the lead profile — see `Snapshot::display_at`.
    pub lead_ease_ms: f64,
    pub lead_hold_ms: f64,
    pub lead_decay_ms: f64,
    pub display_limit_token: f64,
    pub confidence: f64,
    pub suggestion_token: Option<f64>,
    /// Reversible dim-only frontier; never a scroll/progress position.
    pub provisional_token: Option<f64>,
    /// One-shot instruction allowing the stage to brighten provisional words.
    pub provisional_retracted: bool,
    pub script_len_tokens: f64,
    /// Atom-space originals. Diagnostics and benchmark parity only.
    pub observed_atom: f64,
    pub confirmed_atom: f64,
}

/// Project an engine snapshot from atom space into token space.
///
/// The rate conversion is endpoint-exact rather than a local derivative: the
/// prediction horizon's far end is mapped through the same axis as its near
/// end, and the reported rate is whatever connects them. That matters because
/// the axis is piecewise linear with a different slope wherever a token expands
/// into several atoms — a derivative sampled at `observed` would be right at the
/// start of the horizon and wrong by the end of it, which is the half of the
/// horizon the presenter actually reaches.
pub fn project_to_tokens(
    snapshot: &Snapshot,
    script: &CompiledScript,
    generation: u64,
) -> TokenSnapshot {
    let observed_token = script.token_at(snapshot.observed);
    let horizon_seconds = snapshot.max_prediction_ms / 1000.0;
    /*
     * Divide by the time the engine would ACTUALLY take to cover the
     * distance, not by the whole horizon.
     *
     * Near the end of the script the far endpoint clamps to `script_len`,
     * and dividing that shortened distance by the full horizon reports a
     * rate far below the truth: at 2 atoms/s with one atom left and a 2 s
     * horizon it says 0.5 tokens/s, so the display crawls the last word
     * over four times as long as the reader takes to say it. Clamping the
     * TIME as well keeps the endpoint and the pace honest together.
     */
    let project_rate = |rate_atoms: f64| -> f64 {
        if !(rate_atoms > 0.0) || !(horizon_seconds > 0.0) {
            // Already zeroed by the engine whenever extrapolating would be a
            // guess.
            return 0.0;
        }
        let unclamped_far = snapshot.observed + rate_atoms * horizon_seconds;
        let far_atom = unclamped_far.min(snapshot.script_len);
        let seconds = if unclamped_far > snapshot.script_len {
            ((snapshot.script_len - snapshot.observed) / rate_atoms).max(f64::EPSILON)
        } else {
            horizon_seconds
        };
        (script.token_at(far_atom) - observed_token) / seconds
    };
    let rate_tokens_per_second = project_rate(snapshot.rate);

    TokenSnapshot {
        session_generation: generation,
        seq: snapshot.seq,
        state: state_name(snapshot.state),
        decision: decision_name(snapshot.decision),
        confirmed_token: script.token_at(snapshot.confirmed),
        observed_token,
        rate_tokens_per_second,
        evidence_audio_ms: snapshot.evidence_audio_ms,
        at_audio_ms: snapshot.at_audio_ms,
        max_prediction_ms: snapshot.max_prediction_ms,
        pause_onset_ms: snapshot.pause_onset_ms,
        lead_floor_ms: snapshot.lead_floor_ms,
        // Both are projected as DIFFERENCES/positions through the same axis as
        // `observed_token`, so the cap and the ceiling land on exactly the
        // token the engine meant even where a token expands into several atoms.
        max_lead_tokens: script.token_at(snapshot.observed + snapshot.max_lead_atoms)
            - observed_token,
        lead_margin_tokens: script.token_at(snapshot.observed + snapshot.lead_margin_atoms)
            - observed_token,
        lead_ease_ms: snapshot.lead_ease_ms,
        lead_hold_ms: snapshot.lead_hold_ms,
        lead_decay_ms: snapshot.lead_decay_ms,
        display_limit_token: script.token_at(snapshot.display_limit),
        confidence: snapshot.confidence,
        suggestion_token: snapshot.suggestion.map(|a| script.token_at(a)),
        provisional_token: snapshot.provisional.map(|a| script.token_at(a)),
        provisional_retracted: snapshot.provisional_retracted,
        script_len_tokens: script.token_count as f64,
        observed_atom: snapshot.observed,
        confirmed_atom: snapshot.confirmed,
    }
}
