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
        DecisionCode::HoldOffScreen => "holdOffScreen",
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
    /// The display trajectory in the engine's own coordinates, with the stretch
    /// of the atom→token axis it can reach — so the stage reproduces
    /// `display_at` EXACTLY instead of approximately. See [`DisplayAtoms`].
    pub display_atoms: DisplayAtoms,
}

/// Everything the stage needs to evaluate `Snapshot::display_at` in atoms and
/// map the answer into tokens without an approximation.
///
/// # Why the token-space fields above are not enough
///
/// They project a margin, a cap, a rate and a ceiling through the atom→token
/// axis SEPARATELY, and the axis is piecewise linear — its slope changes
/// wherever a token spans several atoms (`$12`, `it's`) or an atom spans several
/// tokens (`one hundred and forty-three` → `143`). Separately projected pieces of
/// a curve do not compose back into the curve. Replayed over the captured
/// corpus compiled the way the app compiles it (`cc-bench projection`), the
/// stage's dim cursor disagreed with the engine's on 4.3% of 20 Hz samples, and
/// on 1.73% it was AHEAD — a word drawn as spoken that the engine had not
/// claimed — by up to 2.4 tokens over a spelled number. Projecting the margin
/// backward instead, the obvious repair, made it worse (2.32% ahead), because
/// the forward margin happens to cancel the forward-projected lead in steady
/// reading.
///
/// The exact answer is cheap because the display cannot go far. It is always
/// between `observed - margin` and the lesser of `observed + max_lead` and the
/// ceiling, so the axis is only needed over about half a dozen atom boundaries.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayAtoms {
    pub observed: f64,
    /// Display rate, atoms/s — `Snapshot::rate`.
    pub rate: f64,
    pub max_lead: f64,
    pub margin: f64,
    /// `min(display_limit, script_len)`, the ceiling `display_at` clamps to.
    pub ceiling: f64,
    /// The integer atom boundary `axis[0]` belongs to.
    pub axis_from: f64,
    /// Token position at atom boundaries `axis_from`, `axis_from + 1`, … —
    /// covering every position `display_at` can return for this snapshot.
    pub axis: Vec<f64>,
}

impl DisplayAtoms {
    pub fn of(snapshot: &Snapshot, script: &CompiledScript) -> Self {
        let ceiling = snapshot.display_limit.min(snapshot.script_len).max(0.0);
        let low = (snapshot.observed - snapshot.lead_margin_atoms)
            .max(0.0)
            .min(ceiling);
        let high = (snapshot.observed + snapshot.max_lead_atoms)
            .min(ceiling)
            .max(low);
        let from = low.floor().max(0.0);
        let to = high.ceil().max(from);
        let axis = (from as u64..=to as u64)
            .map(|atom| script.token_at(atom as f64))
            .collect();
        Self {
            observed: snapshot.observed,
            rate: snapshot.rate,
            max_lead: snapshot.max_lead_atoms,
            margin: snapshot.lead_margin_atoms,
            ceiling,
            axis_from: from,
            axis,
        }
    }

    /// Token position of a fractional atom position inside the window, by the
    /// same linear interpolation `CompiledScript::token_at` uses. Positions
    /// outside the window clamp to its ends.
    pub fn token_at(&self, atom: f64) -> f64 {
        let last = self.axis.len().saturating_sub(1);
        if self.axis.is_empty() {
            return 0.0;
        }
        let x = atom - self.axis_from;
        #[allow(clippy::neg_cmp_op_on_partial_ord)]
        if !(x > 0.0) {
            return self.axis[0];
        }
        if x >= last as f64 {
            return self.axis[last];
        }
        let i = x.floor() as usize;
        let frac = x - i as f64;
        self.axis[i] + (self.axis[i + 1] - self.axis[i]) * frac
    }
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
        /*
         * `!(x > 0.0)`, not `x <= 0.0`, and clippy's suggestion to swap them is
         * wrong here: the two differ on NaN, which is the value this guard
         * exists for. A NaN rate reaching the projection would make every
         * downstream position NaN, and the display would stop moving with no
         * error anywhere.
         */
        #[allow(clippy::neg_cmp_op_on_partial_ord)]
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
        display_atoms: DisplayAtoms::of(snapshot, script),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::script::{compile_tokens, TokenInput};
    use crate::tracker::{DecisionCode, TrackingState};
    use crate::AlignmentConfig;

    /// Tokens that expand (`$12`, `it's`) and a number that merges several
    /// tokens, so the axis bends in both directions.
    fn script() -> CompiledScript {
        let words = "It's $12 for one hundred and forty-three seats, we'll see it's fine today";
        let tokens: Vec<TokenInput> = words
            .split_whitespace()
            .enumerate()
            .map(|(i, s)| TokenInput {
                surface: s.to_string(),
                line: 0,
                para: 0,
                sentence_end: i == 7,
            })
            .collect();
        compile_tokens(&tokens)
    }

    fn snapshot(observed: f64, rate: f64, margin: f64, max_lead: f64, limit: f64, floor_ms: f64, len: f64) -> Snapshot {
        let c = AlignmentConfig::default();
        Snapshot {
            seq: 1,
            state: TrackingState::Following,
            decision: DecisionCode::LocalObserved,
            confirmed: observed,
            observed,
            rate,
            evidence_audio_ms: 1_000.0,
            at_audio_ms: 1_000.0,
            max_prediction_ms: c.max_prediction_ms,
            pause_onset_ms: c.pause_onset_ms,
            lead_floor_ms: floor_ms,
            max_lead_atoms: max_lead,
            lead_margin_atoms: margin,
            lead_ease_ms: c.lead_ease_ms,
            lead_hold_ms: c.lead_hold_ms,
            lead_decay_ms: c.lead_decay_ms,
            display_limit: limit,
            confidence: 0.8,
            suggestion: None,
            provisional: None,
            provisional_retracted: false,
            script_len: len,
        }
    }

    /// The window `DisplayAtoms` ships covers every position `display_at` can
    /// return for that snapshot, so mapping through it is exactly the full
    /// axis — including the cases where it would be easy to get wrong.
    #[test]
    fn the_display_window_covers_every_reachable_position() {
        let script = script();
        let len = script.len() as f64;
        let cases = [
            ("flowing", snapshot(3.0, 2.5, 1.0, 3.2, 9.0, 0.0, len)),
            ("holding at a nonzero position", snapshot(7.3, 0.0, 1.0, 3.2, 9.0, 0.0, len)),
            ("positive lead floor", snapshot(4.0, 3.0, 1.0, 3.2, 12.0, 500.0, len)),
            ("zero lead cap", snapshot(4.0, 3.0, 1.0, 0.0, 12.0, 0.0, len)),
            ("margin larger than the cap", snapshot(5.0, 2.5, 2.5, 1.0, 12.0, 0.0, len)),
            ("fractional ceiling", snapshot(4.0, 4.5, 1.0, 3.2, 5.5, 0.0, len)),
            ("at the script end", snapshot(len - 0.4, 4.0, 1.0, 3.2, len, 0.0, len)),
            ("start of script", snapshot(0.0, 2.8, 1.0, 3.2, 9.0, 0.0, len)),
            ("observed past the ceiling", snapshot(9.0, 2.5, 1.0, 3.2, 6.0, 0.0, len)),
            ("margin past the start", snapshot(0.4, 2.5, 1.0, 3.2, 9.0, 0.0, len)),
        ];
        for (name, snap) in cases {
            let window = DisplayAtoms::of(&snap, &script);
            let first = window.axis_from;
            let last = first + window.axis.len() as f64 - 1.0;
            let mut t = snap.evidence_audio_ms;
            while t < snap.evidence_audio_ms + 4_000.0 {
                let atom = snap.display_at(t);
                assert!(
                    atom >= first - 1e-9 && atom <= last + 1e-9,
                    "{name}: display_at({t}) = {atom} outside [{first}, {last}]"
                );
                let exact = script.token_at(atom);
                assert!(
                    (window.token_at(atom) - exact).abs() < 1e-9,
                    "{name}: window maps {atom} to {} not {exact}",
                    window.token_at(atom)
                );
                t += 25.0;
            }
        }
    }

    /// The window is a handful of boundaries at the shipping defaults and
    /// stays far under the stage's 256 cap at the largest margin and lead the
    /// config will accept.
    #[test]
    fn the_display_window_stays_small() {
        let script = script();
        let len = script.len() as f64;
        let ordinary = DisplayAtoms::of(&snapshot(6.0, 2.5, 1.0, 3.2, len, 0.0, len), &script);
        assert!(ordinary.axis.len() <= 7, "{}", ordinary.axis.len());

        let config = AlignmentConfig {
            lead_margin_atoms: 10_000.0,
            max_lead_atoms: 10_000.0,
            ..Default::default()
        }
        .sanitized();
        let reach = config.lead_margin_atoms + config.max_lead_atoms;
        assert!(reach + 2.0 <= 256.0, "{reach}");
    }
}
