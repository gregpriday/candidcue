//! How faithfully the stage reproduces the engine's display position.
//!
//! The engine decides where the display should be in ATOMS (`display_at`).
//! The stage never sees an atom: Rust projects every snapshot into token space
//! (`cc_align::project_to_tokens`) and the stage re-evaluates the same formula
//! there (`alignmentDisplayAt` in `src/shared/contracts/alignment.ts`). The
//! intended token position at any instant is `T(display_at(t))`, where `T` is
//! the compiled script's atom→token axis; what the stage actually computes is
//! the formula applied to projected parameters. The two agree exactly when one
//! token is one atom and drift apart wherever a token spans several (`$12`,
//! `it's`, a spelled number), because a margin, a cap and a rate projected
//! separately through a piecewise-linear axis do not compose back into the
//! original curve.
//!
//! This samples both at 20 Hz over a replayed take and reports the
//! disagreement. The number that matters is the dim cursor — `floor` of the
//! token position, which is what decides whether a word is drawn as spoken —
//! and in particular how often the stage's cursor sits AHEAD of the engine's,
//! because that is a word dimmed that the engine never claimed.

use cc_align::{project_to_tokens, CompiledScript, Snapshot, TokenSnapshot};

/// `alignmentDisplayAt`, ported from the TypeScript the stage runs: the exact
/// path through `display_atoms` unless `legacy`, which reproduces the
/// token-space formula the stage used before that field existed.
pub fn token_display_at(s: &TokenSnapshot, t_audio_ms: f64, legacy: bool) -> f64 {
    if !legacy {
        let d = &s.display_atoms;
        let atom = trajectory(
            s, t_audio_ms, d.observed, d.rate, d.max_lead, d.margin, d.ceiling,
        );
        return d.token_at(atom);
    }
    trajectory(
        s,
        t_audio_ms,
        s.observed_token,
        s.rate_tokens_per_second,
        s.max_lead_tokens,
        s.lead_margin_tokens,
        s.display_limit_token.min(s.script_len_tokens),
    )
}

/// The display formula over whichever coordinates it is handed.
fn trajectory(
    s: &TokenSnapshot,
    t_audio_ms: f64,
    observed: f64,
    rate: f64,
    max_lead: f64,
    lead_margin: f64,
    ceiling: f64,
) -> f64 {
    let age = (t_audio_ms - s.evidence_audio_ms).max(0.0);
    let onset = s.pause_onset_ms.min(s.max_prediction_ms);
    let settle = smoothstep((age - (onset + s.lead_hold_ms)) / s.lead_decay_ms.max(1.0));
    let margin = lead_margin * (1.0 - settle);
    let clamp = |p: f64| p.max(0.0).min(ceiling.max(0.0));
    #[allow(clippy::neg_cmp_op_on_partial_ord)]
    if !(rate > 0.0) {
        return clamp(observed - margin);
    }
    let rise = soft_min(age, onset, s.lead_ease_ms);
    let floor_ms = s.lead_floor_ms.min(onset);
    let lead_ms = rise * (1.0 - settle) + floor_ms * settle;
    let lead = soft_min(rate * lead_ms / 1000.0, max_lead, rate * s.lead_ease_ms / 1000.0);
    clamp(observed + lead - margin)
}

fn smoothstep(u: f64) -> f64 {
    let c = u.clamp(0.0, 1.0);
    c * c * (3.0 - 2.0 * c)
}

#[allow(clippy::neg_cmp_op_on_partial_ord)]
fn soft_min(a: f64, cap: f64, ease_raw: f64) -> f64 {
    if !(ease_raw > 0.0) || !cap.is_finite() || !a.is_finite() {
        return a.min(cap);
    }
    let ease = ease_raw.min(cap.abs() * 0.5);
    if !(ease > 0.0) {
        return a.min(cap);
    }
    let lo = cap - ease;
    if a <= lo {
        return a;
    }
    if a >= cap + ease {
        return cap;
    }
    let u = (a - lo) / (2.0 * ease);
    lo + 2.0 * ease * (u - u * u / 2.0)
}

#[derive(Debug, Default, Clone)]
pub struct ProjectionStats {
    pub samples: usize,
    /// |stage − intended| in tokens, every sample.
    pub abs_err: Vec<f64>,
    /// Samples where the stage's dim cursor is ahead of the intended one —
    /// a word drawn as spoken that the engine did not claim.
    pub cursor_ahead: usize,
    /// … and behind it: a word left bright that the engine had claimed.
    pub cursor_behind: usize,
    /// Largest signed lead of the stage over the intended position.
    pub max_ahead: f64,
}

impl ProjectionStats {
    pub fn merge(&mut self, other: ProjectionStats) {
        self.samples += other.samples;
        self.abs_err.extend(other.abs_err);
        self.cursor_ahead += other.cursor_ahead;
        self.cursor_behind += other.cursor_behind;
        self.max_ahead = self.max_ahead.max(other.max_ahead);
    }
}

/// Sample a replay at 20 Hz between consecutive snapshots.
pub fn measure(script: &CompiledScript, snapshots: &[Snapshot], legacy: bool) -> ProjectionStats {
    let mut stats = ProjectionStats::default();
    for (index, snap) in snapshots.iter().enumerate() {
        let token = project_to_tokens(snap, script, 0);
        let until = snapshots
            .get(index + 1)
            .map(|n| n.at_audio_ms)
            .unwrap_or(snap.at_audio_ms + 3000.0);
        let mut t = snap.at_audio_ms;
        while t < until {
            let intended = script.token_at(snap.display_at(t));
            let stage = token_display_at(&token, t, legacy);
            let err = stage - intended;
            stats.samples += 1;
            stats.abs_err.push(err.abs());
            stats.max_ahead = stats.max_ahead.max(err);
            let (a, b) = ((stage + 1e-9).floor() as i64, (intended + 1e-9).floor() as i64);
            if a > b {
                stats.cursor_ahead += 1;
            } else if a < b {
                stats.cursor_behind += 1;
            }
            t += 50.0;
        }
    }
    stats
}
