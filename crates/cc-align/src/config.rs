//! Every tunable constant in one serialisable, hashable structure.
//!
//! There are deliberately no magic numbers scattered through the tracker: the
//! benchmark harness sweeps THIS struct, and every benchmark run records the
//! configuration it ran with. Defaults are the baseline values; the
//! optimisation phase overwrites them only with benchmark evidence.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AlignmentConfig {
    // ---- evidence / tail ----
    /// Maximum transcript atoms aligned per event.
    pub max_query_atoms: usize,
    /// Minimum exact-matched content atoms before any observed update.
    pub observe_min_content: u32,

    // ---- candidate generation ----
    /// Atoms behind the predicted position covered by the local region.
    pub local_back: u32,
    /// Atoms ahead of the predicted position covered by the local region.
    pub local_forward: u32,
    /// Hard cap on candidate regions per event.
    pub max_regions: usize,
    /// Width of a global (anchor-proposed) region in atoms.
    pub global_region: u32,
    /// Max postings consulted per anchor key.
    pub max_postings_per_key: usize,
    /// Max distinct anchor keys consulted per event.
    pub max_anchor_keys: usize,
    /// Candidate regions whose starts are within this many atoms are merged.
    pub region_merge_slack: u32,

    // ---- DP costs (milli, scaled by script atom weight where noted) ----
    /// Fuzzy relation cost fraction (× weight).
    pub cost_fuzzy: i32,
    /// Ordinary substitution cost fraction (× weight).
    pub cost_substitution: i32,
    /// Phonetic relation cost fraction (× weight) — rare long words only.
    pub cost_phonetic: i32,
    /// Filler insertion (flat).
    pub cost_insert_filler: i32,
    /// Non-filler transcript insertion, opening (× stability).
    pub cost_insert_open: i32,
    /// Non-filler transcript insertion, extending (× stability).
    pub cost_insert_extend: i32,
    /// Deletion extension fraction (× weight) after the first deleted atom.
    pub del_extend_factor_milli: i32,

    // ---- observed-position gate ----
    pub observe_min_fidelity: f64,
    pub observe_min_coverage: f64,

    // ---- confirmed-position gate ----
    pub confirm_min_fidelity: f64,
    /// Stable content matches required to confirm from a partial.
    pub confirm_min_stable_content: u32,

    // ---- discontinuity gates (skips, retakes, relocation) ----
    /// A candidate whose start is further than this from the prediction is a
    /// discontinuity, not a local update.
    pub discontinuity_atoms: u32,
    pub jump_min_fidelity: f64,
    /// Exact-matched content atoms required to accept a far jump.
    pub jump_min_content: u32,
    /// Score margin (rank units) the far candidate must hold over the best
    /// local candidate.
    pub jump_margin: f64,
    /// Consecutive revisions a far candidate must survive before acceptance.
    pub jump_persistence: u8,
    /// Backward retakes are rarer and more dangerous: extra content evidence.
    pub retake_extra_content: u32,
    /// Content atoms required for the very first lock of a session.
    pub relocation_min_content: u32,
    /// Minimum unexplained atoms before a discontinuity is even evaluated.
    pub jump_query_min: usize,
    /// Unexplained CONTENT atoms that mark local evidence as weak (triggers
    /// global search).
    pub weak_unexplained_content: usize,
    /// Unexplained atoms of ANY kind that mark local evidence as weak.
    pub weak_unexplained_total: usize,
    /// Weak events before a full-script fallback region is allowed when the
    /// anchor indexes propose nothing.
    pub desperate_search_after: u32,
    /// How far behind the cursor the always-available retake corridor
    /// reaches (atoms).
    pub retake_corridor_atoms: u32,

    // ---- beam ----
    pub beam_size: usize,
    /// Hypotheses whose end positions differ by ≤ this many atoms are one
    /// cluster.
    pub cluster_radius: u32,
    /// Rank-score gap below which two distant clusters count as ambiguous.
    pub ambiguity_margin: f64,

    // ---- rate / prediction ----
    /// Atoms per second before any evidence.
    pub rate_default: f64,
    pub rate_min: f64,
    pub rate_max: f64,
    /// Max forward extrapolation while confidently following (ms).
    pub max_prediction_ms: f64,
    /// Extrapolation window after evidence stops arriving (ms).
    pub coast_ms: f64,
    /// Evidence age at which the display stops growing its lead and starts
    /// easing back (ms). Just above the provider's partial cadence p90, so
    /// an ordinary between-partials gap never triggers it — a real pause
    /// does.
    pub pause_onset_ms: f64,
    /// The residual lead (ms of reading) the display keeps once a pause is
    /// suspected. Zero: rest ON the last word actually heard, not past it.
    pub lead_floor_ms: f64,
    /// Fraction of the elapsed-time extrapolation the display actually claims.
    ///
    /// At 1.0 the display aims AT the reader's estimated position, which puts
    /// it ahead of them roughly half the time — every time they slow down,
    /// which is most of the times that matter. Below 1.0 it aims deliberately
    /// short, so the steady state is a little behind and the error has to
    /// accumulate before it ever becomes an overshoot. Unlike simply capping
    /// the lead, this keeps the display *moving* between transcript events
    /// rather than advancing and then stalling.
    ///
    /// This and [`Self::prediction_gain_fast`] are the only knobs that
    /// measurably move the `ahead_*` family. When custom vocabulary landed and
    /// every forward-overshoot metric got slightly worse, the obvious suspects
    /// were all innocent: sweeping `rank_w_matched_weight` (the term that
    /// rewards matching rare, heavy atoms), `max_lead_atoms`, `jump_margin`,
    /// `jump_persistence`, `jump_min_content`, `discontinuity_atoms` and
    /// `coast_ms` changed the numbers by exactly nothing. The drift is not in
    /// ranking and not in relocation; it is in plain extrapolation between
    /// events, which a cleaner transcript makes the engine more willing to do.
    /// `max_prediction_ms` reaches the same place and costs more `within5` to
    /// get there.
    pub prediction_gain: f64,
    /// Gain used once the measured pace reaches `prediction_gain_fast_rate`.
    ///
    /// Pipeline delay costs more whole words at a fast pace, while the
    /// ordinary/slow path should retain the conservative gain that protects
    /// pauses and deliberate slow-downs. The engine interpolates between the
    /// two instead of making every speaker pay for the fastest case.
    pub prediction_gain_fast: f64,
    /// Measured atoms/second at which `prediction_gain_fast` is fully active.
    pub prediction_gain_fast_rate: f64,
    /// Hard cap on the display's lead over `observed`, in atoms.
    ///
    /// The binding constraint on overshoot, and deliberately expressed in
    /// words rather than milliseconds: a reader who slows down invalidates the
    /// rate estimate without invalidating the clock, so a ms-denominated cap
    /// silently grows in the one situation it exists to contain.
    pub max_lead_atoms: f64,

    // ---- evidence timing ----
    /// Residual lag correction applied to evidence time after the ledger's
    /// per-timestamp corrections (ms).
    pub emission_lag_ms: f64,
    /// How far behind the audio clock the words of a PARTIAL are when it
    /// arrives (ms). Measured against gold word times on live captures.
    pub partial_lag_ms: f64,
    /// How long after the last word a FINAL arrives (server VAD waits for
    /// silence before committing) (ms).
    pub endpoint_lag_ms: f64,

    // ---- viewport prior ----
    /// Rank bonus at the centre of the user-visible region.
    pub viewport_bonus: f64,
    /// Gaussian falloff (atoms) for the viewport bonus.
    pub viewport_sigma: f64,

    // ---- ranking weights ----
    pub rank_w_fidelity: f64,
    pub rank_w_coverage: f64,
    pub rank_w_matched_weight: f64,
    pub rank_w_run: f64,
    /// Penalty multiplier on log-distance beyond the local band.
    pub rank_w_jump: f64,
    /// Extra multiplier for backward jumps.
    pub rank_backward_factor: f64,
}

impl AlignmentConfig {
    /// Clamp pathological values to something the engine can run with.
    /// The engine is fed persisted/user-supplied configuration in the app;
    /// a NaN rate or negative cost must degrade to defaults, not panic or
    /// poison every score.
    pub fn sanitized(mut self) -> Self {
        let d = AlignmentConfig::default();
        fn fix(v: &mut f64, fallback: f64) {
            if !v.is_finite() {
                *v = fallback;
            }
        }
        fix(&mut self.rate_default, d.rate_default);
        fix(&mut self.rate_min, d.rate_min);
        fix(&mut self.rate_max, d.rate_max);
        if self.rate_min > self.rate_max {
            std::mem::swap(&mut self.rate_min, &mut self.rate_max);
        }
        self.rate_min = self.rate_min.max(0.1);
        self.rate_max = self.rate_max.max(self.rate_min);
        self.rate_default = self.rate_default.clamp(self.rate_min, self.rate_max);
        fix(&mut self.max_prediction_ms, d.max_prediction_ms);
        self.max_prediction_ms = self.max_prediction_ms.max(0.0);
        fix(&mut self.coast_ms, d.coast_ms);
        self.coast_ms = self.coast_ms.max(0.0);
        fix(&mut self.pause_onset_ms, d.pause_onset_ms);
        self.pause_onset_ms = self.pause_onset_ms.max(0.0);
        fix(&mut self.lead_floor_ms, d.lead_floor_ms);
        self.lead_floor_ms = self.lead_floor_ms.max(0.0);
        fix(&mut self.max_lead_atoms, d.max_lead_atoms);
        self.max_lead_atoms = self.max_lead_atoms.max(0.0);
        fix(&mut self.prediction_gain, d.prediction_gain);
        self.prediction_gain = self.prediction_gain.clamp(0.0, 1.0);
        fix(&mut self.prediction_gain_fast, d.prediction_gain_fast);
        self.prediction_gain_fast = self.prediction_gain_fast.clamp(0.0, 1.0);
        fix(
            &mut self.prediction_gain_fast_rate,
            d.prediction_gain_fast_rate,
        );
        self.prediction_gain_fast_rate =
            self.prediction_gain_fast_rate.max(self.rate_default + 0.1);
        fix(&mut self.emission_lag_ms, d.emission_lag_ms);
        fix(&mut self.partial_lag_ms, d.partial_lag_ms);
        fix(&mut self.endpoint_lag_ms, d.endpoint_lag_ms);
        fix(&mut self.viewport_sigma, d.viewport_sigma);
        if self.viewport_sigma <= 0.0 {
            self.viewport_sigma = d.viewport_sigma;
        }
        fix(&mut self.viewport_bonus, d.viewport_bonus);
        for cost in [
            &mut self.cost_fuzzy,
            &mut self.cost_substitution,
            &mut self.cost_phonetic,
            &mut self.cost_insert_filler,
            &mut self.cost_insert_open,
            &mut self.cost_insert_extend,
            &mut self.del_extend_factor_milli,
        ] {
            if *cost < 0 {
                *cost = 0;
            }
        }
        self.max_query_atoms = self.max_query_atoms.clamp(4, 200);
        self.beam_size = self.beam_size.clamp(1, 64);
        self.max_regions = self.max_regions.clamp(1, 64);
        self
    }
}

impl Default for AlignmentConfig {
    fn default() -> Self {
        Self {
            max_query_atoms: 40,
            observe_min_content: 2,

            local_back: 48,
            local_forward: 112,
            max_regions: 16,
            global_region: 96,
            max_postings_per_key: 8,
            max_anchor_keys: 8,
            region_merge_slack: 12,

            cost_fuzzy: 350,
            cost_substitution: 1000,
            cost_phonetic: 550,
            cost_insert_filler: 120,
            cost_insert_open: 785,
            cost_insert_extend: 485,
            del_extend_factor_milli: 700,

            observe_min_fidelity: 0.50,
            observe_min_coverage: 0.35,

            confirm_min_fidelity: 0.70,
            confirm_min_stable_content: 3,

            discontinuity_atoms: 40,
            jump_min_fidelity: 0.75,
            jump_min_content: 3,
            jump_margin: 0.5,
            jump_persistence: 1,
            retake_extra_content: 0,
            relocation_min_content: 2,
            jump_query_min: 4,
            weak_unexplained_content: 3,
            weak_unexplained_total: 4,
            desperate_search_after: 3,
            retake_corridor_atoms: 240,

            beam_size: 8,
            cluster_radius: 3,
            ambiguity_margin: 0.35,

            rate_default: 2.8,
            rate_min: 0.5,
            rate_max: 7.0,
            max_prediction_ms: 1800.0,
            coast_ms: 300.0,
            pause_onset_ms: 1800.0,
            lead_floor_ms: 0.0,
            // 0.35 → 0.33 alongside custom vocabulary. A cleaner transcript
            // makes the engine more willing to extrapolate, and this is the
            // only knob that reaches that (see the doc comment). 0.31 would
            // also drive `ahead_events` back down to the no-vocabulary count,
            // but it costs 1.8–4.5 pp of `within2` across the three corpora to
            // remove ONE event in a four-run sample, while `ahead_worst` — how
            // far the display actually got in front of the reader — was
            // already level. Depth is what erases a line someone is reading;
            // the count is not worth that price.
            //
            // `prediction_gain_fast` is deliberately left where it was set:
            // it exists for pipeline delay at pace, it was tuned against its
            // own benchmarks, and four runs is not evidence enough to overrule
            // that.
            prediction_gain: 0.33,
            prediction_gain_fast: 0.55,
            prediction_gain_fast_rate: 3.7,
            max_lead_atoms: 2.5,

            emission_lag_ms: 0.0,
            partial_lag_ms: 300.0,
            endpoint_lag_ms: 1400.0,

            viewport_bonus: 0.6,
            viewport_sigma: 40.0,

            rank_w_fidelity: 2.0,
            rank_w_coverage: 1.0,
            rank_w_matched_weight: 0.35,
            rank_w_run: 0.25,
            rank_w_jump: 0.30,
            rank_backward_factor: 1.5,
        }
    }
}
