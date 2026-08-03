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
    /// A single fuzzy/phonetic content word may bridge an otherwise empty
    /// local update only while an existing lock is at least this confident.
    pub local_approx_min_confidence: f64,
    /// Maximum forward movement (atoms) granted by one provisional word.
    pub local_approx_max_step: f64,
    /// Maximum total speculative advance beyond `observed`.
    pub local_approx_max_advance: f64,
    /// Maximum distance from the pace-predicted frontier for the bridge.
    pub local_approx_prediction_slack: f64,
    /// Consecutive approximate-only bridges allowed before exact evidence must
    /// re-establish the path. The total-distance cap remains authoritative.
    pub local_approx_max_consecutive: u8,

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
    /// How much authority to relocate a *biased* content match carries, in
    /// thousandths of an ordinary one.
    ///
    /// A word the recogniser was told to expect is partly a product of the
    /// hypothesis being tested — bias the upcoming stretch, let weak acoustics
    /// decode as the scripted words, and the exact matches that authorise the
    /// jump were solicited by the position the jump is being tested against.
    /// The observation model assumes recogniser errors are unconditioned on
    /// where we think the reader is, and bias breaks exactly that assumption,
    /// in the direction that looks like success.
    ///
    /// Applies only where a relocation or a far jump is authorised. Ordinary
    /// local continuity reads the undiscounted count, because a wrong local
    /// step costs little and corrects itself.
    ///
    /// `1000` is full authority (the discount off), `0` a veto. The default
    /// halves it: a genuinely heard hotword is still evidence, it just takes
    /// two of them to move the reader as far as one unsolicited word does.
    /// Inert until something actually declares bias terms — see
    /// [`crate::script::CompiledScript::set_biased_terms`] — so the shipping
    /// greedy-decoding path is unaffected whatever this says.
    pub biased_content_weight_milli: u32,
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

    // ---- off-script aside ----
    /// Consecutive insertion-dominated revisions before the tracker latches
    /// off-script.
    ///
    /// Going off script is ordinary: an aside, an answer, fifteen seconds of
    /// riffing. It is not the same thing as thin evidence, and it must not be
    /// decided by one revision — a single partial where insertions happen to
    /// dominate is a bad partial, not an aside.
    pub off_script_enter_revisions: u8,
    /// Consecutive ordered-exact revisions required to release the latch.
    ///
    /// Coming back is also not a single-revision fact: one revision that
    /// happens to line up is not proof the reader is back on the page.
    pub off_script_return_revisions: u8,
    /// Consecutive exact matches that count as *ordered* evidence the reader
    /// is back on the line they left.
    ///
    /// This is the bar the ordinary local gate does not clear on its own:
    /// `fidelity` and `coverage` are ratios over the whole tail, so words from
    /// the aside dilute them, while a run of consecutive exact matches is a
    /// count that aside material cannot manufacture in script order.
    pub off_script_return_min_run: u32,

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
    /// Ceiling on how far ahead of the last evidence the display may
    /// extrapolate, in milliseconds of reader time.
    ///
    /// 2400 -> 1400 alongside `lead_margin_atoms`. This is the knob that
    /// governs a PAUSE: between transcript events the display coasts at the
    /// reader's estimated pace, and when the reader simply stops, this is what
    /// decides how long it keeps going. Measured on the Tier-A pause scenario
    /// at margin 1.6: 2.32 atoms of overshoot at 1800, 1.03 at 1400, 0.90 at
    /// 1200 — against a guard that allows 2.5.
    ///
    /// Lowering it further keeps working (1000 gives 0.56) but starts buying
    /// stillness: `live.freeze` runs 3.76% at 1800, 4.46% at 1400 and 5.35% at
    /// 1000. 1400 is where the pause is comfortably safe and the display has
    /// not yet begun waiting around.
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
    /// Brake prediction at the end of every SENTENCE rather than only at the
    /// end of every paragraph.
    ///
    /// Not a tuning parameter — the two settings are two different rules, and
    /// this exists so they can be compared in one binary against one corpus.
    /// Everything above is measured that way, and a rule about where the
    /// display may go is not worth believing on argument alone.
    ///
    /// Turning it off restores the paragraph ceiling exactly, which is the
    /// rollback if braking this often ever reads as stop-start on the glass.
    pub sentence_prediction_ceiling: bool,

    // ---- motion shape ----
    // Everything above decides WHERE the display may be. These decide how it
    // gets there. The lead profile used to be piecewise linear: a 1:1 rise, a
    // corner at `pause_onset_ms` where the slope flipped from +rate to −rate,
    // and a hard `min()` against `max_lead_atoms`. Position was continuous at
    // all three, and velocity was continuous at none of them — every one is an
    // instantaneous change of speed that the plant can only absorb by
    // accelerating hard and then decelerating, which is what "it moves in a
    // jerk and then a jerk" is. These widths round the corners off.
    /// How far behind its own estimate the display deliberately sits while the
    /// reader is flowing, in atoms.
    ///
    /// This is the knob that lets caution be bought WITHOUT buying jerk, and it
    /// exists because the two were the same knob for a long time.
    /// `prediction_gain` cannot separate them: the display's position is
    /// `observed + gain·pace·age`, so between transcript events it travels at
    /// `gain × pace`, and when the next event lands `observed` jumps by the
    /// reader's real progress while `age` resets. The step that lands on the
    /// display is therefore exactly `(1 − gain)·pace·Δt` — rigidly tied to the
    /// gain, and zero only when the gain is 1. A conservative gain does not
    /// make the display careful; it makes the display crawl and then jump.
    ///
    /// A margin is subtracted instead. At gain 1 the display travels at the
    /// reader's pace — continuous, no step at the event boundary — and sits
    /// this far behind where that estimate says the reader is. Same caution,
    /// expressed as a distance rather than as a permanent reduction in speed.
    ///
    /// It fades out through the same settle the lead does, so the display still
    /// comes to rest ON the last word actually heard rather than a word before
    /// it.
    pub lead_margin_atoms: f64,
    /// Width of the knee where a limit is approached (ms of lead time, and
    /// scaled for the atom cap). The display eases into a bound over this
    /// window instead of arriving at it at full speed and stopping dead.
    /// Zero restores the old hard corners exactly.
    pub lead_ease_ms: f64,
    /// How long the lead holds at its plateau past `pause_onset_ms` before it
    /// begins easing back toward `lead_floor_ms`. The old profile began
    /// reversing the instant it reached the onset, so an ordinary long gap
    /// between partials read as a pause and stopped the display dead — the
    /// descending limb cannot move the display backward (the plant refuses),
    /// so it simply parks it.
    pub lead_hold_ms: f64,
    /// How long that ease back to the floor takes.
    pub lead_decay_ms: f64,
    /// How long the reader's pace estimate stays at full strength after the
    /// last evidence, before decaying toward zero over `rate_decay_ms`.
    ///
    /// This replaced a binary gate on the provider's endpoint: the display's
    /// speed used to become exactly zero the moment an utterance was marked
    /// final, which is an event that — at `endpoint_lag_ms` — describes what
    /// the reader was doing 1.4 s ago. Silence is a thing you infer from the
    /// clock, not a thing the recogniser announces.
    pub rate_hold_ms: f64,
    /// Time constant of that decay.
    pub rate_decay_ms: f64,

    // ---- evidence timing ----
    /// Residual lag correction applied to evidence time after the ledger's
    /// per-timestamp corrections (ms).
    pub emission_lag_ms: f64,
    /// How far behind the audio clock the words of a PARTIAL are when it
    /// arrives (ms). Measured against gold word times on live captures.
    ///
    /// **A PROPERTY OF THE RECOGNISER, and it changes when the model does.**
    ///
    /// This constant is a property of the recogniser's pipeline: the hosted
    /// service put a network round trip and a server-side buffer between the
    /// audio and the hypothesis; the on-device transducer publishes in the same
    /// call that consumed the samples, so a partial's words are current as of
    /// the audio clock and the correction should be ~0.
    ///
    /// It is the observation latency of the recogniser — how far behind the
    /// audio clock a partial's words are when it arrives. It tracks chunk size
    /// and encoder depth, so it is NOT simply the emission cadence, and a
    /// recogniser can perfectly well emit often while every hypothesis is
    /// several hundred milliseconds old. Measured median partial interval,
    /// on the same 33-minute corpus:
    ///
    /// | recogniser | partial interval | right value |
    /// |---|---|---|
    /// | hosted (the frozen `bench/runs/` corpus) | 1000 ms | 300 |
    /// | streaming-zipformer-en-20M | 300 ms | 0 |
    /// | **x-asr 480 ms (shipping)** | **500 ms** | **400** |
    ///
    /// Getting it wrong is expensive in both directions and was measured that
    /// way: on the x-asr corpus, 0 costs `first_lock` 3.80 s against 2.00 s at
    /// 400 and `within5` 91.81 against 94.03; going further to 600 buys
    /// nothing and takes `ahead_time` from 2.00% to 3.54%.
    ///
    /// This is not only the app's constant: `cc-bench`'s Tier-A simulator has
    /// a matching `PARTIAL_LAG_MS`, and the two must describe the same
    /// recogniser or Tier A scores the engine against a cadence nothing
    /// produces. Change both together; see `synthetic.rs`.
    pub partial_lag_ms: f64,
    /// How long after the last word a FINAL arrives (the recogniser waits for
    /// trailing silence before committing) (ms).
    ///
    /// **A CONSTANT IS THE WRONG SHAPE FOR THIS, and 1400 is inherited from a
    /// provider the app no longer uses.** Not changed here because it cannot be
    /// validated on the frozen corpus — the fixtures carry the `audioEndMs` they
    /// were captured with, so re-dating finals needs a re-capture to measure.
    /// Written down instead, with the recipe, because the arithmetic is now known
    /// rather than guessed.
    ///
    /// The shipping recogniser is sherpa-onnx, whose endpointing is Kaldi's three
    /// rules, configured in `cc_stt::local` as 2.4 / 1.2 / 20.0:
    ///
    /// | rule | fires on | our value |
    /// |---|---|---|
    /// | 1 | trailing silence with NO symbol decoded yet | 2.4 s |
    /// | 2 | trailing silence AFTER a symbol | 1.2 s |
    /// | 3 | utterance length cap, no silence PREREQUISITE | 20 s |
    ///
    /// So one constant cannot be right, because the lag depends on which rule
    /// fired:
    ///
    ///   - rule 2 — the endpoint is declared 1.2 s of audio after the trailing
    ///     silence began, so a final timestamped at "now" is about 1.2 s late.
    ///     We subtract 1.4, over-correcting by ~200 ms.
    ///   - rule 3 — the cap expired. There is no silence REQUIREMENT, so the
    ///     final may be dated while speech is still running, and subtracting 1.4
    ///     then dates it too EARLY. (Note this is a weaker claim than "there is
    ///     no trailing silence": rule 3 can also fire during a pause. What is
    ///     certain is only that the 1.2 s is not implied.) A presenter reading
    ///     aloud rarely leaves 1.2 s of silence, which is why the tracking
    ///     report expected rule 3 to be the common case in a take.
    ///   - `finish()` also calls `close_item`, so the last final of a take fires
    ///     no rule at all and has no endpoint lag to correct for.
    ///
    /// A CANDIDATE FIX, NOT A KNOWN ONE. `cc_stt::local::close_item` dates the
    /// final at `self.audio_ms()` — the current audio clock. The recogniser
    /// carries better information: `start_time` and per-token `timestamps`, from
    /// which `start_time + timestamps.last()` is *approximately* the acoustic
    /// time of the last decoded token. Three things would have to be established
    /// before that could replace this constant:
    ///
    ///   - whether `timestamps` is segment-relative or stream-relative, and
    ///     whether it stays so across a segment boundary. SETTLED: they are
    ///     segment-relative, and `start_time` carries the segment's origin —
    ///     measured by forcing a second segment. See `cc_stt::word_times`.
    ///   - that `timestamps.last()` is the END of the last token rather than its
    ///     ONSET. SETTLED: it is the ONSET, and it runs 100–340 ms late (mean
    ///     ~200) against true acoustic onset, because a streaming transducer
    ///     times a token from the frame it committed on.
    ///   - that the result is better than 1400 on a re-captured corpus. STILL
    ///     OPEN. The frozen fixtures carry the `audioEndMs` they were captured
    ///     with, so this is not measurable without a fresh capture — which is
    ///     the reason the constant has not simply been changed.
    ///
    /// What DID change, and — more importantly — what did not. The per-word
    /// times those first two facts unlocked now reach the ledger, and
    /// [`crate::ledger::Ledger::tail`] dates an atom by the larger of its
    /// measurement and its interpolated share of the item.
    ///
    /// This constant still sets BOTH ends of that arithmetic. It is the floor,
    /// via the interpolation a measurement has to beat; it is the ceiling, in
    /// that a measurement landing after the corrected end is declined rather
    /// than believed; and because the last atom's interpolated share IS the
    /// corrected end, the final atom of every item is dated by this constant
    /// alone, measured or not. What measurement buys is the INSIDE of an
    /// utterance — words no longer sit on the wrong side of a pause. Where the
    /// utterance ends is still this number, and still wrong in the four ways
    /// described above.
    ///
    /// That is deliberate, not an oversight. Re-dating the end is the change
    /// this doc has always said needs a corpus, and it is not a free
    /// improvement even when correct: a later evidence clock reads as fresher
    /// to [`crate::tracker::Snapshot::display_at`], which delays its settle
    /// onto a pause and holds the display's lead open longer. Right answer,
    /// re-tuned constants — and no way to tell which way that trades until
    /// there is something to measure it on.
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
        fix(&mut self.lead_margin_atoms, d.lead_margin_atoms);
        self.lead_margin_atoms = self.lead_margin_atoms.max(0.0);
        fix(&mut self.lead_ease_ms, d.lead_ease_ms);
        self.lead_ease_ms = self.lead_ease_ms.max(0.0);
        fix(&mut self.lead_hold_ms, d.lead_hold_ms);
        self.lead_hold_ms = self.lead_hold_ms.max(0.0);
        fix(&mut self.lead_decay_ms, d.lead_decay_ms);
        self.lead_decay_ms = self.lead_decay_ms.max(0.0);
        fix(&mut self.rate_hold_ms, d.rate_hold_ms);
        self.rate_hold_ms = self.rate_hold_ms.max(0.0);
        fix(&mut self.rate_decay_ms, d.rate_decay_ms);
        self.rate_decay_ms = self.rate_decay_ms.max(0.0);
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
        fix(
            &mut self.local_approx_min_confidence,
            d.local_approx_min_confidence,
        );
        self.local_approx_min_confidence = self.local_approx_min_confidence.clamp(0.0, 1.0);
        fix(&mut self.local_approx_max_step, d.local_approx_max_step);
        self.local_approx_max_step = self.local_approx_max_step.max(0.0);
        fix(
            &mut self.local_approx_max_advance,
            d.local_approx_max_advance,
        );
        self.local_approx_max_advance = self.local_approx_max_advance.max(0.0);
        fix(
            &mut self.local_approx_prediction_slack,
            d.local_approx_prediction_slack,
        );
        self.local_approx_prediction_slack = self.local_approx_prediction_slack.max(0.0);
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
        // A biased match must never be worth MORE than an unsolicited one; a
        // sweep that overshoots the top of the range gets full weight, not a
        // bonus for having been told the answer.
        self.biased_content_weight_milli = self.biased_content_weight_milli.min(1000);
        // A zero here would latch (or release) on the single revision the
        // hysteresis exists to disregard, which is the bug, not a tuning.
        self.off_script_enter_revisions = self.off_script_enter_revisions.clamp(2, 16);
        self.off_script_return_revisions = self.off_script_return_revisions.clamp(2, 16);
        // One matched word is not an order. The upper bound is the tail
        // itself: a run longer than the query can hold is a run the evidence
        // can never report, which would latch an aside shut for good.
        self.off_script_return_min_run = self
            .off_script_return_min_run
            .clamp(2, (self.max_query_atoms as u32).max(2));
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
            local_approx_min_confidence: 0.60,
            local_approx_max_step: 1.25,
            local_approx_max_advance: 3.0,
            local_approx_prediction_slack: 1.5,
            local_approx_max_consecutive: 3,

            confirm_min_fidelity: 0.70,
            confirm_min_stable_content: 3,

            discontinuity_atoms: 40,
            jump_min_fidelity: 0.75,
            jump_min_content: 3,
            jump_margin: 0.5,
            jump_persistence: 1,
            retake_extra_content: 0,
            relocation_min_content: 2,
            biased_content_weight_milli: 500,
            jump_query_min: 4,
            weak_unexplained_content: 3,
            weak_unexplained_total: 4,
            desperate_search_after: 3,
            retake_corridor_atoms: 240,

            off_script_enter_revisions: 3,
            off_script_return_revisions: 2,
            off_script_return_min_run: 3,

            beam_size: 8,
            cluster_radius: 3,
            ambiguity_margin: 0.35,

            rate_default: 2.8,
            rate_min: 0.5,
            rate_max: 7.0,
            max_prediction_ms: 1400.0,
            coast_ms: 300.0,
            pause_onset_ms: 2400.0,
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
            // 0.33 → 0.55, which is simply `prediction_gain_fast`: the slow and
            // ordinary paths now use the gain that was already tuned and
            // accepted for the fast one, and the interpolation between them no
            // longer does anything until `prediction_gain_fast` is changed.
            //
            // The conservative gain was costing far more than it looked. It is
            // the slope of the display's position between transcript events, so
            // at 0.33 the display travelled at a third of reading pace and took
            // the rest of each second's distance in a step — measured on the
            // clean suite, a mean speed of 2.44 atoms/s (which is the reader)
            // against a median of 0.83 (which is the reader times the gain),
            // with a P95 step of 23 atoms/s. It was also costing accuracy, not
            // just comfort: `clean_within2` 53.8% → 75.1%.
            //
            // 0.55 is the knee, and the knee is sharp. 0.65 takes
            // `ahead_events` from 2 to 27 and 0.90 takes it to 72; 0.55 leaves
            // it at 2 against a baseline of 1, with `ahead_p95` still NEGATIVE
            // (−0.296) — the display still trails the reader at the 95th
            // percentile, which is the invariant this engine exists to hold.
            prediction_gain: 1.0,
            prediction_gain_fast: 1.0,
            prediction_gain_fast_rate: 3.7,
            // 2.5 → 3.0. At the old gain the cap could not bind (2.5 atoms at
            // 0.83 atoms/s needs 2.7 s and the profile turns over at 1.8 s), so
            // it was inert; at an honest gain it becomes the binding constraint
            // and the display arrives at it mid-sentence. 3.0 keeps it just
            // clear of ordinary reading while still bounding the damage when
            // the rate estimate is wrong.
            // 4.5 -> 3.2. Tightened in step with `lead_margin_atoms` so the
            // NET worst-case lead over `observed` is held near where it was
            // while the constant offset comes off. Sweeping the two together
            // showed the cap has a sharp knee: at margin 0.6 the suite's
            // `ahead_events` ran 71 at a cap of 3.0 and 5 at 2.6.
            max_lead_atoms: 3.2,
            // On: a full stop is where the reader slows, breathes and holds,
            // and it is the commonest place for the display to get ahead of
            // them. Off restores the paragraph-only ceiling for comparison.
            sentence_prediction_ceiling: true,

            // Every one of these three is a SAFETY knob as much as a comfort
            // one, which is not obvious and is worth stating: they decide how
            // long the display holds its lead before conceding the reader has
            // stopped. Narrowing the knee to 250 ms took `ahead_events` from 2
            // to 30; holding the plateau for 400 ms took it from 2 to 24. Tune
            // them against `overshoot.*` and `pause_overshoot_p95`, never
            // against the smoothness rows alone.
            // 2.2 -> 1.6, tuned against `live.dim_p50_ms`: the time between a
            // reader finishing a word and the display passing it. That is the
            // thing a presenter perceives, and nothing here measured it until
            // now — every other accuracy row is a DISTANCE, and the same
            // 3-word lag is half a second at 150 wpm and a second at 75.
            //
            // The margin was also buying less than it looked. Dropping it
            // IMPROVES `within5` (94.33 -> 95.24) and `p95_abs` (5.29 -> 4.91),
            // because a permanent trailing offset is a position error as well
            // as a delay.
            //
            // It could not be reduced on its own: the margin is not what holds
            // the display back during a PAUSE. `pauses_do_not_run_the_display_
            // ahead` — the guard written from the field report "if I take a
            // pause, it just keeps rushing forward" — failed at every value
            // below 2.2, and passed at 2.2 with almost no headroom (2.55 at
            // 2.1 against a 2.5 limit). What actually runs the display on
            // through a pause is `max_prediction_ms`, which is why that came
            // down with it.
            // 1.6 -> 1.0, together with `max_lead_atoms` 4.5 -> 3.2, once Tier C
            // could see what the margin actually bought.
            //
            // The margin is a CONSTANT trailing offset, so it costs dim latency
            // on every word of every take, and it buys overshoot protection only
            // in the minority of moments when the reader slows down or stops.
            // `max_lead_atoms` is the opposite: inert during steady reading,
            // binding exactly when the rate estimate over-runs. Trading one for
            // the other keeps the protection and stops paying for it constantly.
            //
            // On the captured corpus (real recogniser output, `bench/runs-local`):
            // `dim_p50_ms` 700 -> 500, `dim_p95_ms` 1750 -> 1550, `within2`
            // 59.3 -> 74.0, `p95_abs` 4.91 -> 4.71, and Tier C's gaze-weighted
            // never-spoken gate 3.47 -> 2.89 word·s.
            //
            // The cost is real and is in the ENGINE's overshoot counters:
            // `ahead_events` 11 -> 30 and `ahead_time` 3.59% -> 6.95%. Depth,
            // which is what actually erases a line someone is reading, barely
            // moves — `ahead_worst` 6.70 -> 6.98 — and `within5` improves. The
            // reason the count can rise while the ink metric falls is that the
            // rendered dim frontier now FLOORS the estimate instead of rounding
            // it, so a half-token of overshoot no longer reaches the glass; see
            // `cc_bench::stage`. Judge this pair on `ahead_worst` and on the ink
            // gate, not on the event count.
            lead_margin_atoms: 1.0,
            lead_ease_ms: 450.0,
            lead_hold_ms: 0.0,
            lead_decay_ms: 1200.0,
            rate_hold_ms: 1600.0,
            rate_decay_ms: 900.0,

            emission_lag_ms: 0.0,
            partial_lag_ms: 400.0,
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Half authority by default: a solicited word is still evidence, it just
    /// takes two of them to move the reader as far as one unsolicited word.
    #[test]
    fn biased_content_weight_defaults_to_half_and_never_exceeds_full() {
        assert_eq!(AlignmentConfig::default().biased_content_weight_milli, 500);

        let veto = AlignmentConfig {
            biased_content_weight_milli: 0,
            ..Default::default()
        }
        .sanitized();
        assert_eq!(veto.biased_content_weight_milli, 0);

        let full = AlignmentConfig {
            biased_content_weight_milli: 1000,
            ..Default::default()
        }
        .sanitized();
        assert_eq!(full.biased_content_weight_milli, 1000);

        // A sweep that overshoots gets full weight, never a bonus for having
        // been told the answer.
        let over = AlignmentConfig {
            biased_content_weight_milli: 9_000,
            ..Default::default()
        }
        .sanitized();
        assert_eq!(over.biased_content_weight_milli, 1000);
    }

    /// Recorded benchmark configurations predate this field and must still load.
    #[test]
    fn a_config_without_the_field_deserialises_to_the_default() {
        let restored: AlignmentConfig = serde_json::from_str("{\"jump_min_content\":3}").unwrap();
        assert_eq!(restored.biased_content_weight_milli, 500);
    }
}
