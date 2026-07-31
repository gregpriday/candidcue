//! The perceptual metric families: what the presenter actually experienced.
//!
//! Everything in `metrics.rs` scores the engine's estimated position. This
//! module scores the rendered stage — word opacity, line placement, the path the
//! document took — against a pass-aware gold timeline, and denominates delay in
//! MILLISECONDS rather than in atoms.
//!
//! The organising idea is the perceptual chain:
//!
//! ```text
//! speech → recogniser evidence → tracker belief → display target
//!        → rendered motion → rendered opacity → readability → behaviour
//! ```
//!
//! A failure at any link produces a bad take, and the old table can only see the
//! first three. Each family below is deliberately reported on its own: there is
//! no aggregate, because the whole point of separating safety from comfort is
//! that a change which buys a steadier glide by erasing unread text is not an
//! improvement and only the safety rows can say so.

use serde::{Deserialize, Serialize};

use cc_align::TrackingState;

use crate::passgold::{EventKind, PassGold, PauseClass};
use crate::stage::{darkness, StageTrace, PAST_OPACITY};

/// Gaze weighting: σ in rendered lines. Tokens a line and a half from the
/// reading position carry ~60% weight, three lines ~13%. Unread text being
/// darkened directly under the presenter's eye is a different event from the
/// same thing happening at the bottom of the glass, and a flat count says they
/// are identical.
const GAZE_SIGMA_LINES: f64 = 1.5;

/// Darkness thresholds for the multi-threshold dim latency.
///
/// Three questions, not one: when did the word visibly BEGIN to change, when did
/// it clearly read as passed, and when did it fully enter the read state. A
/// single "the display passed it" instant answers none of them, because the
/// product does not switch a word off — it walks it down a four-step ramp with a
/// 240 ms tween on each step.
const FIRST_RESPONSE: f64 = 0.25;
const HALF_DIM: f64 = 0.50;
const COMMITTED_DIM: f64 = 0.85;

/// A word must be given at least this long after it was spoken before "the
/// display never dimmed it" means anything. Matches `metrics::DIM_TAIL_GRACE_MS`.
const DIM_TAIL_GRACE_MS: f64 = 1_500.0;

/// Unread-ink incident: gaze-weighted darkness on unread text at least this
/// deep, held at least this long, is one thing the presenter could see happen.
const UIE_INCIDENT_DARKNESS: f64 = 0.15;
const UIE_INCIDENT_MS: f64 = 150.0;

/// Readable-state thresholds (§3.1). Every one of these is a CANDIDATE pending
/// the human calibration in Tier D, and is named as such in the report — they
/// are the shape of the metric, not established perceptual facts.
const READABLE_BAND_SLACK_LINES: f64 = 0.5;
const READABLE_FUTURE_LINES: f64 = 1.5;
const READABLE_NEXT_WORDS: u32 = 8;
const READABLE_NEXT_MAX_DARKNESS: f64 = 0.25;
const READABLE_MAX_LINES_PER_S: f64 = 2.5;
const READABLE_MIN_DOC_OPACITY: f64 = 0.8;

/// Readable corridor (§6.3): how dark a word has to be before it stops counting
/// as material the reader still has in front of them.
///
/// Numerically `FIRST_RESPONSE`, and deliberately a separate constant. That one
/// answers "when did the ramp visibly begin", this one answers "may the reader
/// still count on this word" — the same number today because the first visible
/// change is exactly the point a word stops being dependable, but they are two
/// judgements and tying them together would hide that.
const READABLE_AHEAD_DARKNESS: f64 = 0.25;

/// How much readable material the reader needs in front of them, in ms of
/// reading at the pace they are actually reading at.
///
/// A CANDIDATE, in the same sense as the `READABLE_*` block above, and the
/// weakest-evidenced constant in this file. The oral reading literature puts
/// fixation roughly 500 ms ahead of articulation; none of it was measured
/// through teleprompter glass with a camera in the way, and Tier D is what would
/// turn it into a measurement. It is reported, never gated on — `..._p05` is
/// published beside the deficit so a later revision of this number can be
/// applied to old results instead of invalidating them.
const READABLE_AHEAD_MIN_MS: f64 = 500.0;

/// Blur exposure: above this rendered speed the text is not readable while it
/// moves. Lines per second.
const BLUR_LINES_PER_S: f64 = 3.0;

/// A perceptual disruption must last at least this long to count. Below it the
/// presenter's eye has not had time to register the event.
const DISRUPTION_MIN_MS: f64 = 200.0;

/// Snapshot pulse window: how long after an accepted snapshot the motion it
/// caused is integrated over.
const PULSE_WINDOW_MS: f64 = 400.0;

/// Cadence-ripple band, Hz — the recogniser update range. The shipping model
/// emits every ~500 ms, so periodic modulation from partial cadence lands here.
const RIPPLE_LO_HZ: f64 = 0.7;
const RIPPLE_HI_HZ: f64 = 3.0;

/// Rest: both gold and target stationary. Below this the plant is at rest.
const REST_V_PX_S: f64 = 1.0;

/// False-confidence thresholds, in atoms.
const FCE_DELTAS: [f64; 3] = [3.0, 5.0, 10.0];

/// Readable recovery has to HOLD, not merely occur. Same window the existing
/// recovery metric uses.
const RECOVERY_STABLE_MS: f64 = 1_500.0;

/// Recovery-regret weights. Kept at 1 and reported alongside their three
/// components, because a learned perceptual model is what should eventually set
/// them and inventing them now would bake a guess into a headline.
const REGRET_W_TEMPORAL: f64 = 1.0 / 1_000.0;
const REGRET_W_BAND: f64 = 1.0;
const REGRET_W_INK: f64 = 1.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DisruptionKind {
    /// Unread text materially darkened near the reading band.
    UnreadInk,
    /// The reading line displaced too far from the corridor.
    BandLoss,
    /// Clean on-script reading, and the engine was holding.
    UnnecessaryHold,
    /// The document travelled visibly fast enough to be unreadable.
    BlurTravel,
    /// Less than half a line of unread text below the focus.
    FutureStarvation,
    /// Following claimed while more than 10 atoms wrong.
    FalseConfidence,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Disruption {
    pub kind: DisruptionKind,
    pub at_ms: f64,
    pub duration_ms: f64,
}

/// A readable-recovery measurement, decomposed (§9.2).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct ReadableRecovery {
    pub kind: EventKind,
    pub at_ms: f64,
    /// t_r − t_0: semantic position recovered.
    pub semantic_ms: Option<f64>,
    /// t_v − t_0: visually readable state recovered and held.
    pub readable_ms: Option<f64>,
    /// Words the reader spoke before the readable state came back.
    pub words_spoken: u32,
    /// Integrated cost during the recovery, by component.
    pub regret_temporal: f64,
    pub regret_band: f64,
    pub regret_ink: f64,
    /// A second relocation inside 5 s of landing.
    pub snapback: bool,
}

/// Raw sample pools, so the suite can compute a real percentile across runs
/// instead of averaging per-run percentiles of unequal length.
#[derive(Debug, Clone, Default)]
pub struct PerceptualSamples {
    /// Signed temporal frontier error, ms. Positive = display late.
    pub temporal_err_ms: Vec<f64>,
    pub first_response_ms: Vec<f64>,
    pub half_dim_ms: Vec<f64>,
    pub committed_dim_ms: Vec<f64>,
    /// Negative values only: how early the worst words dimmed.
    pub premature_ms: Vec<f64>,
    /// Per-frame gaze-weighted unread-ink exposure (word-units).
    pub uie: Vec<f64>,
    pub sir: Vec<f64>,
    /// Normalised band error per frame, in lines.
    pub band_err_lines: Vec<f64>,
    pub future_reserve_lines: Vec<f64>,
    /// Milliseconds of legible reading ahead of the mouth, per frame. Frames
    /// that ran out of PASS MATERIAL are absent rather than zero.
    pub readable_ahead_ms: Vec<f64>,
    pub handoff_err_lines: Vec<f64>,
    /// |plant − target| / line pitch, per frame.
    pub plant_err_lines: Vec<f64>,
    /// Snapshot pulse energy, lines/s² integrated over the window.
    pub pulse: Vec<f64>,
    /// Per-frame rendered speed in lines/s, while speaking.
    pub speed_lines_s: Vec<f64>,
    /// (confidence, was_actually_right) for calibration.
    pub calibration: Vec<(f64, bool)>,
    /// Disruption durations, ms.
    pub disruption_ms: Vec<f64>,
    /// Time to first disruption per take, ms; None = survived the take.
    pub survival_ms: Vec<Option<f64>>,
    pub readable_recovery_ms: Vec<f64>,
    pub freshness_ms: Vec<f64>,
    /// Event-triggered average of velocity change around a snapshot: one entry
    /// per (lag bucket, Δ lines/s).
    pub eta_v: Vec<(f64, f64)>,
}

/// Per-run perceptual summary. Flat and named so the suite can pour it straight
/// into the benchmark table.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PerceptualMetrics {
    pub run: String,
    pub scenario: String,
    pub layout: String,
    pub frames: usize,
    pub take_ms: f64,

    // ---- §5 temporal synchronisation ----
    pub temporal_lag_p50: f64,
    pub temporal_lag_p95: f64,
    pub temporal_lead_p05: f64,
    pub temporal_lead_p01: f64,
    pub temporal_mad: f64,
    pub late_250_pct: f64,
    pub late_500_pct: f64,
    pub early_100_pct: f64,
    pub worst_lag_episode_ms: f64,
    /// The same lag, sliced by context (§5, conditional slices).
    pub lag_p50_opening: f64,
    pub lag_p50_steady: f64,
    pub lag_p50_after_pause: f64,
    pub lag_p50_after_retake: f64,

    // ---- §4.3 multi-threshold dim latency ----
    pub first_response_p50: f64,
    pub first_response_p95: f64,
    pub half_dim_p50: f64,
    pub half_dim_p95: f64,
    pub committed_dim_p50: f64,
    pub committed_dim_p95: f64,
    pub dim_latency_mad: f64,
    pub dim_spread_p95_p50: f64,
    pub premature_dim_p05: f64,
    pub premature_dim_p01: f64,
    pub dim_never: usize,

    // ---- §4.1/§4.2 ink ----
    pub uie_mean: f64,
    pub uie_incident_p95: f64,
    pub uie_incidents: u32,
    pub uie_max_tokens: u32,
    pub uie_max_darkness: f64,
    pub uie_max_duration_ms: f64,
    /// The same integral against the EVER-spoken frontier: text that has never
    /// been said at all. This is the hard-gate row.
    pub unread_never_spoken: f64,
    pub sir_mean: f64,

    // ---- §4.4/§4.5 retake & corrections ----
    pub retake_legibility_loss: f64,
    pub retake_anchor_bright_p95_ms: f64,
    pub retake_reread_max_darkness: f64,
    pub corrections_per_1k_words: f64,
    pub correction_depth_p95: f64,
    pub correction_duration_p95_ms: f64,

    // ---- §6 reading band ----
    pub band_occupancy_pct: f64,
    pub band_err_p50: f64,
    pub band_err_p95: f64,
    pub out_half_line_pct: f64,
    pub out_full_line_pct: f64,
    pub out_of_band_episodes: u32,
    pub out_of_band_max_ms: f64,
    pub future_reserve_p05: f64,
    pub future_reserve_p50: f64,
    pub future_reserve_min: f64,
    pub below_1_future_line_pct: f64,
    pub future_starvation_events: u32,

    // ---- §6.3 the readable corridor ----
    // Defaulted on read: results written before this metric existed have no
    // such key, and refusing to open them would strand every archived run.
    /// Milliseconds of legible reading ahead of the mouth, bad tail.
    #[serde(default)]
    pub readable_ahead_p05_ms: f64,
    /// % of scored frames with less than `READABLE_AHEAD_MIN_MS` in front of
    /// the reader. The headline; the two rows below split it by cause.
    #[serde(default)]
    pub readable_ahead_deficit_pct: f64,
    /// …because the dim ramp had already taken a word they had not said.
    #[serde(default)]
    pub readable_ahead_opacity_deficit_pct: f64,
    /// …because the corridor ran off the bottom of the glass.
    #[serde(default)]
    pub readable_ahead_viewport_deficit_pct: f64,
    /// Frames excluded because the PASS ran out, not the display. An audit
    /// count, not a quality number: it has no better direction.
    #[serde(default)]
    pub readable_ahead_material_end_frames: u32,

    pub handoff_err_p50: f64,
    pub handoff_err_p95: f64,

    // ---- §7 motion comfort ----
    pub plant_err_p50: f64,
    pub plant_err_p95: f64,
    pub plant_err_max: f64,
    pub plant_behind_quarter_pct: f64,
    pub snapshot_pulse_p50: f64,
    pub snapshot_pulse_p95: f64,
    pub snapshot_pulse_max: f64,
    pub pulses_per_min: f64,
    pub cadence_ripple: f64,
    pub motion_correction_effort: f64,
    pub silent_motion_breath_lines: f64,
    pub silent_motion_sentence_lines: f64,
    pub silent_motion_paragraph_lines: f64,
    pub silent_motion_long_lines: f64,
    pub silent_travel_max_lines: f64,
    pub rest_travel_lines: f64,
    pub rest_rms_v: f64,
    pub rest_reversals: u32,
    pub visible_relocation_lines: f64,
    pub relocation_max_opacity: f64,
    pub fade_count: u32,
    pub blur_exposure_s: f64,
    pub max_line_speed: f64,

    // ---- §8 honest uncertainty ----
    pub fce_3_pct: f64,
    pub fce_5_pct: f64,
    pub fce_10_pct: f64,
    pub fce_max_episode_ms: f64,
    pub fce_episodes: u32,
    pub hold_precision: f64,
    pub hold_recall: f64,
    pub unnecessary_hold_pct: f64,
    pub hold_release_p95_ms: f64,
    pub state_transitions_per_min: f64,
    pub brier: f64,
    pub ece: f64,

    // ---- §3 holistic ----
    pub readable_availability: f64,
    pub disruptions: u32,
    pub disruptions_per_10min: f64,
    pub disruption_p95_ms: f64,
    pub disruption_max_ms: f64,
    pub first_disruption_ms: Option<f64>,
    pub longest_clean_ms: f64,

    // ---- §9 readable recovery ----
    pub readable_recovery_p50: f64,
    pub readable_recovery_p95: f64,
    pub readable_recovery_failures: u32,
    pub recovery_regret: f64,
    pub recovery_snapbacks: u32,
    pub recovered_within_5_words_pct: f64,

    // ---- §10 reliability ----
    pub freshness_p50: f64,
    pub freshness_p95: f64,
    pub freshness_max: f64,
    pub stale_500_pct: f64,
    pub stale_1000_pct: f64,
    pub follow_availability: f64,

    pub disruption_log: Vec<Disruption>,
    pub recoveries: Vec<ReadableRecovery>,
}

pub struct PerceptualEval {
    pub metrics: PerceptualMetrics,
    pub samples: PerceptualSamples,
}

// ---------------------------------------------------------------------------
// small statistics helpers
// ---------------------------------------------------------------------------

pub fn pctl(v: &[f64], p: f64) -> f64 {
    if v.is_empty() {
        return f64::NAN;
    }
    let mut s: Vec<f64> = v.iter().copied().filter(|x| x.is_finite()).collect();
    if s.is_empty() {
        return f64::NAN;
    }
    s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let idx = (((s.len() as f64 - 1.0) * p / 100.0).round() as usize).min(s.len() - 1);
    s[idx]
}

pub fn mean_of(v: &[f64]) -> f64 {
    let n = v.iter().filter(|x| x.is_finite()).count();
    if n == 0 {
        return f64::NAN;
    }
    v.iter().filter(|x| x.is_finite()).sum::<f64>() / n as f64
}

/// Median absolute deviation — the consistency row.
///
/// A steady 250 ms response feels better than one alternating between 50 and
/// 700 ms, and the two have the same median. Percentiles cannot say so; this
/// can.
pub fn mad(v: &[f64]) -> f64 {
    if v.is_empty() {
        return f64::NAN;
    }
    let m = pctl(v, 50.0);
    let devs: Vec<f64> = v.iter().filter(|x| x.is_finite()).map(|x| (x - m).abs()).collect();
    pctl(&devs, 50.0)
}

fn pct(hit: usize, total: usize) -> f64 {
    if total == 0 {
        f64::NAN
    } else {
        100.0 * hit as f64 / total as f64
    }
}

/// Gaussian gaze weight for a token at document `y`, given the reading position
/// and line pitch.
fn gaze_weight(y: f64, reading_y: f64, pitch: f64) -> f64 {
    let sigma = GAZE_SIGMA_LINES * pitch;
    let d = y - reading_y;
    (-(d * d) / (2.0 * sigma * sigma)).exp()
}

/// Power in `[lo, hi]` Hz as a fraction of total power, by naive periodogram.
///
/// A ripple index needs a spectrum and the series is a few thousand samples, so
/// an O(N·K) DFT over a bounded bin count is cheaper than pulling in an FFT
/// crate and is exactly reproducible.
fn band_power_ratio(series: &[f64], dt_s: f64, lo_hz: f64, hi_hz: f64) -> f64 {
    let n = series.len();
    if n < 32 || dt_s <= 0.0 {
        return f64::NAN;
    }
    let mu = mean_of(series);
    if !mu.is_finite() {
        return f64::NAN;
    }
    let nyquist = 0.5 / dt_s;
    const BINS: usize = 192;
    let mut in_band = 0.0;
    let mut total = 0.0;
    for k in 1..=BINS {
        let f = nyquist * k as f64 / BINS as f64;
        let w = 2.0 * std::f64::consts::PI * f * dt_s;
        let (mut re, mut im) = (0.0, 0.0);
        for (i, x) in series.iter().enumerate() {
            let phase = w * i as f64;
            let c = x - mu;
            re += c * phase.cos();
            im -= c * phase.sin();
        }
        let power = re * re + im * im;
        total += power;
        if f >= lo_hz && f <= hi_hz {
            in_band += power;
        }
    }
    if total <= 0.0 {
        f64::NAN
    } else {
        in_band / total
    }
}

// ---------------------------------------------------------------------------
// The evaluator
// ---------------------------------------------------------------------------

/// Why the readable corridor stopped. Three different complaints, and reporting
/// them as one number would let the harmless case pay for the other two.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReadableAheadEnd {
    /// The dim ramp had already taken a word the reader has not said. The
    /// defect the metric exists for.
    DimRamp,
    /// The corridor ran off the glass. Legitimately a deficit — text the
    /// presenter cannot see is not text they can read — but it is a placement
    /// failure, not an opacity one, and `future_reserve` is its geometry-only
    /// sibling.
    Viewport,
    /// The pass ran out of material. NOT a defect: a reader four words from the
    /// end of a take genuinely has four words in front of them, and scoring
    /// that as starvation would make every take end in a manufactured failure.
    MaterialEnd,
}

/// Contiguous legible material ahead of the reader, and why it ended.
#[derive(Debug, Clone, Copy)]
struct ReadableAheadMeasurement {
    /// Milliseconds of reading, at the pace the reader is actually reading at.
    ms: f64,
    end: ReadableAheadEnd,
}

/// Walk forward from where the reader is and measure how far the legible text
/// reaches (§6.3).
///
/// This is the quantity `time.lag_p50` cannot see. A stage 700 ms behind the
/// mouth with the line correctly placed and stable opaque text under it is
/// fine; a stage with no lag at all that is fading the word about to be spoken
/// is unusable, and the lag row calls the second one better.
///
/// Anchored on `reader_position` — the SPOKEN frontier, the mouth — and not on
/// `PassGold::focus`. Focus is the frontier plus a modelled two-atom eye-voice
/// lead, so anchoring there would subtract an assumed lead before testing a
/// threshold justified by that same assumed lead. Measuring from the mouth
/// keeps the model in `READABLE_AHEAD_MIN_MS`, where it is labelled and can be
/// revised, instead of dissolving it into the measurement.
///
/// `token_opacity` is exactly the tokens on the glass, ascending and
/// contiguous, so a missing atom means off-screen rather than absent.
///
/// `None` when the position is outside the material `tau` can speak for, which
/// is the same condition that makes `temporal_err` `None`.
fn measure_readable_ahead(
    gold: &PassGold,
    pass: u32,
    reader_position: f64,
    token_opacity: &[(u32, f32)],
) -> Option<ReadableAheadMeasurement> {
    let (pass_lo, pass_hi) = gold.pass_span(pass)?;
    if reader_position < pass_lo || reader_position > pass_hi {
        return None;
    }
    let t_start = gold.tau(pass, reader_position)?;

    // Start at the token the reader is INSIDE, not the next one. A word being
    // dimmed while it is still in the mouth is the sharpest form of the defect,
    // and starting a token later would look straight past it.
    let mut atom = reader_position.floor().max(0.0);
    let (end_pos, end) = loop {
        // Material end wins ties: when the pass runs out on the same atom the
        // glass does, the honest reading is that there was nothing left to show.
        if atom >= pass_hi {
            break (pass_hi, ReadableAheadEnd::MaterialEnd);
        }
        match token_opacity
            .binary_search_by_key(&(atom as u32), |&(a, _)| a)
            .ok()
            .map(|i| token_opacity[i].1 as f64)
        {
            None => break (atom, ReadableAheadEnd::Viewport),
            Some(op) if darkness(op) >= READABLE_AHEAD_DARKNESS => {
                break (atom, ReadableAheadEnd::DimRamp)
            }
            Some(_) => atom += 1.0,
        }
    };

    // Clamped because the token the reader is inside starts BEHIND them: if it
    // is already dark the corridor is empty, not negative.
    let t_end = gold.tau(pass, end_pos.clamp(pass_lo, pass_hi))?;
    Some(ReadableAheadMeasurement {
        ms: (t_end - t_start).max(0.0),
        end,
    })
}

/// Per-frame derived quantities, computed once and reused by every family that
/// needs them. Several metrics want the same three or four numbers per frame
/// (focus line, band error, future reserve, next-word brightness) and computing
/// them independently would triple the cost and let two families disagree.
struct FrameView {
    t: f64,
    /// Current pass frontier and focus, in atoms.
    frontier: f64,
    focus: f64,
    ever: f64,
    on_script: bool,
    speaking: bool,
    kind: EventKind,
    /// Signed temporal frontier error (ms). Positive = display late.
    temporal_err: Option<f64>,
    /// |focus line − reading line| / pitch.
    band_err: f64,
    /// Unread rendered lines below the focus.
    future_reserve: f64,
    /// Worst darkness among the next READABLE_NEXT_WORDS unread tokens.
    next_worst_darkness: f64,
    /// Legible material ahead of the mouth (§6.3). `None` outside the frames
    /// `temporal_err` is scored over, so the two rows are comparable frame for
    /// frame — which is the comparison the row exists to make.
    readable_ahead: Option<ReadableAheadMeasurement>,
    /// Rendered speed, lines/s.
    speed_lines: f64,
    /// Gaze-weighted unread ink and spoken-ink retention this frame.
    uie: f64,
    uie_tokens: u32,
    uie_worst: f64,
    unread_never: f64,
    sir: f64,
    readable: bool,
}

/// Score one rendered stage trace against a pass-aware gold timeline.
pub fn evaluate_perceptual(
    run: &str,
    scenario: &str,
    gold: &PassGold,
    trace: &StageTrace,
    // `from_ms`: when the engine first locked. Before that there is no position
    // to be accurate about, and letting a cold start pollute these percentiles
    // turns every start-in-the-middle run into a fake catastrophe.
    from_ms: f64,
) -> PerceptualEval {
    let mut m = PerceptualMetrics {
        run: run.to_string(),
        scenario: scenario.to_string(),
        layout: trace.layout.name.clone(),
        frames: trace.frames.len(),
        take_ms: trace.frames.last().map(|f| f.t_ms).unwrap_or(0.0),
        ..Default::default()
    };
    let mut s = PerceptualSamples::default();

    let pitch = trace.line_map.line_pitch_px();
    let reading_line = trace.layout.reading_line_px();
    let frame_ms = trace.layout.frame_ms();
    let band_half = trace.layout.band_half_lines;

    // ---- pass 1: per-frame views ----
    let mut views: Vec<FrameView> = Vec::with_capacity(trace.frames.len());
    for f in &trace.frames {
        let t = f.t_ms;
        let pass = gold.pass_at(t);
        let frontier = gold.spoken_frontier(t);
        let focus = gold.focus(t);
        let ever = gold.ever_spoken_frontier(t);
        let on_script = gold.on_script(t);
        let speaking = gold.speaking(t);
        let kind = gold.kind_at(t);

        // ---- §5 temporal frontier error ----
        // Where the rendered DIM FRONTIER sits, expressed as the time the reader
        // passed that position. This is the row that makes lag comparable across
        // speaking rates.
        let dim_frontier = f.dim_cursor.map(|c| c as f64).unwrap_or(0.0);
        // Gated on SPEAKING, not merely on-script. `tau` answers "when did the
        // reader pass this position", and during a silence the answer for any
        // position at or ahead of the frontier lies on the far side of the
        // pause — so a display resting correctly through a three-second hold
        // scored as three seconds early. That is an artefact of asking a
        // reading-progress question at a moment when reading progress is not
        // happening; the pause has its own metrics (`silent_motion_*`,
        // `pause_overshoot_p95`) and this row must not double as one.
        let temporal_err = if on_script && speaking && t >= from_ms {
            gold.tau(pass, dim_frontier).map(|passed_at| t - passed_at)
        } else {
            None
        };

        // ---- §6 reading band and future reserve ----
        let focus_y = trace.line_map.y_of(focus);
        let focus_screen_y = focus_y - f.q_px;
        let raw = focus_screen_y - reading_line;
        let outside = (raw.abs() - band_half * pitch).max(0.0);
        let band_err = outside / pitch;

        // Unread lines still on the glass below the focus.
        let bottom_y = f.q_px + trace.layout.viewport_h_px;
        let future_reserve = ((bottom_y - focus_y).max(0.0)) / pitch;

        // ---- brightness of the text the presenter is about to read ----
        let mut next_worst = 0.0f64;
        let first_unread = frontier.ceil().max(0.0) as u32;
        for atom in first_unread..first_unread + READABLE_NEXT_WORDS {
            if let Some(op) = f.opacity_of(atom) {
                next_worst = next_worst.max(darkness(op));
            }
        }

        // ---- §6.3 the readable corridor ----
        // Same gate as `temporal_err` above, on purpose: the two rows are the
        // pair the issue asks to be able to tell apart, and comparing them
        // across different frame sets would be the same mistake in a new place.
        let readable_ahead = if on_script && speaking && t >= from_ms {
            measure_readable_ahead(gold, pass, frontier, &f.token_opacity)
        } else {
            None
        };

        // ---- §4.1/§4.2 the two ink integrals ----
        // D*_i = 1 once token i has been passed IN THE CURRENT PASS, else 0.
        // Positive residual either way is a defect, and the two directions are
        // separate metrics because they are separate complaints: "it erased text
        // I had not read" and "the word I just said takes forever to go grey".
        let mut uie = 0.0;
        let mut uie_tokens = 0u32;
        let mut uie_worst = 0.0f64;
        let mut unread_never = 0.0;
        let mut sir = 0.0;
        for &(atom, op) in &f.token_opacity {
            let d = darkness(op as f64);
            let w = gaze_weight(trace.line_map.y_of(atom as f64), f.q_px + reading_line, pitch);
            if w < 0.01 {
                continue;
            }
            let a = atom as f64;
            let ideal = if a + 1.0 <= frontier { 1.0 } else { 0.0 };
            let over = (d - ideal).max(0.0);
            if over > 0.0 {
                uie += w * over;
                if over > UIE_INCIDENT_DARKNESS {
                    uie_tokens += 1;
                    uie_worst = uie_worst.max(over);
                }
                // Against the global high-water mark: text that has never been
                // spoken at all in any pass. The hard-gate quantity.
                if a + 1.0 > ever {
                    unread_never += w * over;
                }
            }
            sir += w * (ideal - d).max(0.0);
        }

        let speed_lines = f.v_px_s.abs() / pitch;

        let readable = on_script
            && band_err <= READABLE_BAND_SLACK_LINES
            && future_reserve >= READABLE_FUTURE_LINES
            && next_worst <= READABLE_NEXT_MAX_DARKNESS
            && speed_lines <= READABLE_MAX_LINES_PER_S
            && f.doc_opacity >= READABLE_MIN_DOC_OPACITY;

        views.push(FrameView {
            t,
            frontier,
            focus,
            ever,
            on_script,
            speaking,
            kind,
            temporal_err,
            band_err,
            future_reserve,
            next_worst_darkness: next_worst,
            readable_ahead,
            speed_lines,
            uie,
            uie_tokens,
            uie_worst,
            unread_never,
            sir,
            readable,
        });
    }

    // ---- §5 summarise temporal ----
    let scored: Vec<&FrameView> = views.iter().filter(|v| v.t >= from_ms).collect();
    let errs: Vec<f64> = scored.iter().filter_map(|v| v.temporal_err).collect();
    s.temporal_err_ms = errs.clone();
    m.temporal_lag_p50 = pctl(&errs, 50.0);
    m.temporal_lag_p95 = pctl(&errs, 95.0);
    m.temporal_lead_p05 = pctl(&errs, 5.0);
    m.temporal_lead_p01 = pctl(&errs, 1.0);
    m.temporal_mad = mad(&errs);
    m.late_250_pct = pct(errs.iter().filter(|e| **e > 250.0).count(), errs.len());
    m.late_500_pct = pct(errs.iter().filter(|e| **e > 500.0).count(), errs.len());
    m.early_100_pct = pct(errs.iter().filter(|e| **e < -100.0).count(), errs.len());
    // Longest continuous stretch more than 500 ms late.
    {
        let mut run_ms = 0.0;
        let mut worst = 0.0f64;
        for v in &scored {
            match v.temporal_err {
                Some(e) if e > 500.0 => {
                    run_ms += frame_ms;
                    worst = worst.max(run_ms);
                }
                _ => run_ms = 0.0,
            }
        }
        m.worst_lag_episode_ms = worst;
    }
    // Conditional slices. A global p50 can hide a 900 ms delay on every resume.
    {
        let first_word = gold.words.first().map(|w| w.start_ms).unwrap_or(0.0);
        let slice = |pred: &dyn Fn(&FrameView) -> bool| -> f64 {
            let v: Vec<f64> = scored
                .iter()
                .filter(|fv| pred(fv))
                .filter_map(|fv| fv.temporal_err)
                .collect();
            pctl(&v, 50.0)
        };
        m.lag_p50_opening = slice(&|v| v.t < first_word + 4_000.0);
        m.lag_p50_steady = slice(&|v| {
            v.speaking
                && v.kind == EventKind::OnScript
                && gold.silence_at(v.t - 900.0).is_none()
        });
        m.lag_p50_after_pause = slice(&|v| {
            // Within a second of the end of a sentence-or-longer silence.
            gold.silences.iter().any(|sil| {
                sil.class != PauseClass::Breath && v.t >= sil.to_ms && v.t < sil.to_ms + 1_000.0
            })
        });
        m.lag_p50_after_retake = slice(&|v| {
            gold.discontinuities
                .iter()
                .any(|d| d.kind == EventKind::Retake && v.t >= d.at_ms && v.t < d.at_ms + 3_000.0)
        });
    }

    // ---- §4.1/§4.2 ink ----
    s.uie = scored.iter().map(|v| v.uie).collect();
    s.sir = scored.iter().map(|v| v.sir).collect();
    let secs = frame_ms / 1000.0;
    m.uie_mean = mean_of(&s.uie);
    m.sir_mean = mean_of(&s.sir);
    m.unread_never_spoken = scored.iter().map(|v| v.unread_never).sum::<f64>() * secs;
    // The frontier the safety row is measured against, kept on the view so a
    // reader of the trace can see WHICH reference produced a violation.
    debug_assert!(scored.iter().all(|v| v.ever >= 0.0));
    m.uie_max_tokens = scored.iter().map(|v| v.uie_tokens).max().unwrap_or(0);
    m.uie_max_darkness = scored.iter().map(|v| v.uie_worst).fold(0.0, f64::max);
    // Incidents: a stretch of frames each carrying real unread darkness.
    {
        let mut run_ms = 0.0;
        let mut acc = 0.0;
        let mut incidents = Vec::new();
        for v in &scored {
            if v.uie_tokens > 0 {
                run_ms += frame_ms;
                acc += v.uie * secs;
            } else {
                if run_ms >= UIE_INCIDENT_MS {
                    incidents.push((acc, run_ms));
                }
                run_ms = 0.0;
                acc = 0.0;
            }
        }
        if run_ms >= UIE_INCIDENT_MS {
            incidents.push((acc, run_ms));
        }
        m.uie_incidents = incidents.len() as u32;
        m.uie_incident_p95 = pctl(
            &incidents.iter().map(|(a, _)| *a).collect::<Vec<_>>(),
            95.0,
        );
        m.uie_max_duration_ms = incidents.iter().map(|(_, d)| *d).fold(0.0, f64::max);
    }

    // ---- §6 band, reserve, handoff ----
    let band: Vec<f64> = scored.iter().filter(|v| v.on_script).map(|v| v.band_err).collect();
    s.band_err_lines = band.clone();
    m.band_occupancy_pct = pct(band.iter().filter(|e| **e <= 0.0).count(), band.len());
    m.band_err_p50 = pctl(&band, 50.0);
    m.band_err_p95 = pctl(&band, 95.0);
    m.out_half_line_pct = pct(band.iter().filter(|e| **e > 0.5).count(), band.len());
    m.out_full_line_pct = pct(band.iter().filter(|e| **e > 1.0).count(), band.len());
    {
        let mut run_ms = 0.0;
        let mut episodes = 0u32;
        let mut worst = 0.0f64;
        let mut counted = false;
        for v in scored.iter().filter(|v| v.on_script) {
            if v.band_err > 0.5 {
                run_ms += frame_ms;
                worst = worst.max(run_ms);
                if run_ms >= DISRUPTION_MIN_MS && !counted {
                    episodes += 1;
                    counted = true;
                }
            } else {
                run_ms = 0.0;
                counted = false;
            }
        }
        m.out_of_band_episodes = episodes;
        m.out_of_band_max_ms = worst;
    }
    let reserve: Vec<f64> = scored.iter().filter(|v| v.on_script).map(|v| v.future_reserve).collect();
    s.future_reserve_lines = reserve.clone();
    m.future_reserve_p05 = pctl(&reserve, 5.0);
    m.future_reserve_p50 = pctl(&reserve, 50.0);
    m.future_reserve_min = reserve.iter().copied().fold(f64::INFINITY, f64::min);
    if !m.future_reserve_min.is_finite() {
        m.future_reserve_min = f64::NAN;
    }
    m.below_1_future_line_pct = pct(reserve.iter().filter(|r| **r < 1.0).count(), reserve.len());
    {
        let mut run_ms = 0.0;
        let mut events = 0u32;
        let mut counted = false;
        for v in scored.iter().filter(|v| v.on_script) {
            if v.future_reserve < 0.5 {
                run_ms += frame_ms;
                if run_ms >= DISRUPTION_MIN_MS && !counted {
                    events += 1;
                    counted = true;
                }
            } else {
                run_ms = 0.0;
                counted = false;
            }
        }
        m.future_starvation_events = events;
    }
    // §6.3 the readable corridor: how much legible text is in front of the
    // reader, rather than how far behind them the display is.
    //
    // `MaterialEnd` frames leave the denominator entirely. Censoring them is
    // the whole reason the termination cause is carried this far: a corridor
    // that ends because the script does is not a display defect, and letting it
    // into the percentage would put a fake deficit at the end of every take.
    {
        let measured: Vec<ReadableAheadMeasurement> =
            scored.iter().filter_map(|v| v.readable_ahead).collect();
        m.readable_ahead_material_end_frames = measured
            .iter()
            .filter(|r| r.end == ReadableAheadEnd::MaterialEnd)
            .count() as u32;
        let corridor: Vec<&ReadableAheadMeasurement> = measured
            .iter()
            .filter(|r| r.end != ReadableAheadEnd::MaterialEnd)
            .collect();

        s.readable_ahead_ms = corridor.iter().map(|r| r.ms).collect();
        m.readable_ahead_p05_ms = pctl(&s.readable_ahead_ms, 5.0);
        let short = |end: Option<ReadableAheadEnd>| -> f64 {
            pct(
                corridor
                    .iter()
                    .filter(|r| r.ms < READABLE_AHEAD_MIN_MS)
                    .filter(|r| end.is_none_or(|k| r.end == k))
                    .count(),
                corridor.len(),
            )
        };
        m.readable_ahead_deficit_pct = short(None);
        m.readable_ahead_opacity_deficit_pct = short(Some(ReadableAheadEnd::DimRamp));
        m.readable_ahead_viewport_deficit_pct = short(Some(ReadableAheadEnd::Viewport));
    }
    // §6.2 line handoff: at the acoustic end of each rendered line, where does
    // the NEXT line sit relative to the reading position? A stage can be well
    // placed on average and still produce a bad eye-return at every wrap.
    {
        let mut handoffs = Vec::new();
        let mut last_line = usize::MAX;
        for v in scored.iter().filter(|v| v.on_script && v.speaking) {
            let line = trace.line_map.line_of(v.focus);
            if last_line != usize::MAX && line != last_line {
                if let Some(f) = trace.frames.iter().find(|f| f.t_ms >= v.t) {
                    let next_y = trace.line_map.line_top_px(line) - f.q_px;
                    handoffs.push(((next_y - reading_line).abs()) / pitch);
                }
            }
            last_line = line;
        }
        s.handoff_err_lines = handoffs.clone();
        m.handoff_err_p50 = pctl(&handoffs, 50.0);
        m.handoff_err_p95 = pctl(&handoffs, 95.0);
    }

    // ---- §7 motion ----
    {
        let plant: Vec<f64> = trace
            .frames
            .iter()
            .filter(|f| f.t_ms >= from_ms)
            .map(|f| (f.q_px - f.target_px).abs() / pitch)
            .collect();
        s.plant_err_lines = plant.clone();
        m.plant_err_p50 = pctl(&plant, 50.0);
        m.plant_err_p95 = pctl(&plant, 95.0);
        m.plant_err_max = plant.iter().copied().fold(0.0, f64::max);
        m.plant_behind_quarter_pct = pct(
            trace
                .frames
                .iter()
                .filter(|f| f.t_ms >= from_ms && (f.target_px - f.q_px) / pitch > 0.25)
                .count(),
            plant.len(),
        );

        // §7.2 snapshot pulse energy + the event-triggered average.
        let mut pulses = Vec::new();
        for (i, f) in trace.frames.iter().enumerate() {
            if !f.snapshot_arrived || f.t_ms < from_ms {
                continue;
            }
            let v_before = trace.frames.get(i.saturating_sub(1)).map(|p| p.v_px_s).unwrap_or(0.0);
            let mut energy = 0.0;
            for g in trace.frames[i..].iter() {
                if g.t_ms > f.t_ms + PULSE_WINDOW_MS {
                    break;
                }
                energy += g.jerk_px_s3.abs() / pitch * secs;
                s.eta_v.push((g.t_ms - f.t_ms, (g.v_px_s - v_before) / pitch));
            }
            pulses.push(energy);
        }
        s.pulse = pulses.clone();
        m.snapshot_pulse_p50 = pctl(&pulses, 50.0);
        m.snapshot_pulse_p95 = pctl(&pulses, 95.0);
        m.snapshot_pulse_max = pulses.iter().copied().fold(0.0, f64::max);
        let minutes = (m.take_ms - from_ms).max(1.0) / 60_000.0;
        m.pulses_per_min = pulses.len() as f64 / minutes;

        // §7.3 cadence ripple: periodic modulation of speed in the recogniser
        // update band, after removing the intended semantic path velocity. The
        // reference is the gold reading rate, so a display that simply moves
        // with the reader has no residual at all.
        let residual: Vec<f64> = views
            .iter()
            .zip(trace.frames.iter())
            .filter(|(v, _)| v.t >= from_ms && v.speaking && v.on_script)
            .map(|(_, f)| f.v_px_s / pitch)
            .collect();
        m.cadence_ripple = band_power_ratio(&residual, frame_ms / 1000.0, RIPPLE_LO_HZ, RIPPLE_HI_HZ);

        // §7.4 motion correction effort, normalised by the profile's own limits
        // so the number is comparable across pitches.
        let a0 = 2600.0 * pitch / crate::stage::REFERENCE_LINE_PITCH_PX;
        let j0 = 12_000.0 * pitch / crate::stage::REFERENCE_LINE_PITCH_PX;
        let eff: Vec<f64> = trace
            .frames
            .iter()
            .filter(|f| f.t_ms >= from_ms)
            .map(|f| (f.a_px_s2 / a0).powi(2) + (f.jerk_px_s3 / j0).powi(2))
            .collect();
        m.motion_correction_effort = mean_of(&eff);

        // §7.5 silent motion burden, per pause class. Lines of document travelled
        // while the presenter was NOT speaking.
        let mut burden = [0.0f64; 4];
        let mut worst_silent = 0.0f64;
        for sil in &gold.silences {
            if sil.to_ms < from_ms {
                continue;
            }
            let travel: f64 = trace
                .frames
                .iter()
                .filter(|f| f.t_ms >= sil.from_ms && f.t_ms < sil.to_ms)
                .map(|f| f.v_px_s.abs() / pitch * secs)
                .sum();
            let slot = match sil.class {
                PauseClass::Breath => 0,
                PauseClass::Sentence => 1,
                PauseClass::Paragraph => 2,
                PauseClass::Long => 3,
            };
            burden[slot] += travel;
            worst_silent = worst_silent.max(travel);
        }
        m.silent_motion_breath_lines = burden[0];
        m.silent_motion_sentence_lines = burden[1];
        m.silent_motion_paragraph_lines = burden[2];
        m.silent_motion_long_lines = burden[3];
        m.silent_travel_max_lines = worst_silent;

        // §7.6 rest drift: the target should be MOTIONLESS when nothing is
        // happening, not merely under some large velocity threshold.
        let mut rest_travel = 0.0;
        let mut rest_v: Vec<f64> = Vec::new();
        let mut reversals = 0u32;
        let mut last_sign = 0.0f64;
        for (v, f) in views.iter().zip(trace.frames.iter()) {
            let target_still = trace
                .frames
                .iter()
                .find(|g| g.t_ms > f.t_ms)
                .map(|g| (g.target_px - f.target_px).abs() < 0.05)
                .unwrap_or(true);
            if v.t >= from_ms && !v.speaking && target_still {
                rest_travel += f.v_px_s.abs() / pitch * secs;
                rest_v.push(f.v_px_s);
                let sign = if f.v_px_s.abs() < REST_V_PX_S { 0.0 } else { f.v_px_s.signum() };
                if sign != 0.0 && last_sign != 0.0 && sign != last_sign {
                    reversals += 1;
                }
                if sign != 0.0 {
                    last_sign = sign;
                }
            }
        }
        m.rest_travel_lines = rest_travel;
        m.rest_rms_v = if rest_v.is_empty() {
            0.0
        } else {
            (rest_v.iter().map(|x| x * x).sum::<f64>() / rest_v.len() as f64).sqrt()
        };
        m.rest_reversals = reversals;

        // §7.7 visible relocation distance: travel weighted by how visible the
        // document was while it happened. A correct hidden re-anchor scores ~0.
        let mut visible = 0.0;
        let mut max_op = 0.0f64;
        let mut fades = 0u32;
        let mut in_fade = false;
        for f in trace.frames.iter().filter(|f| f.t_ms >= from_ms) {
            if f.doc_opacity < 0.999 {
                if !in_fade {
                    fades += 1;
                    in_fade = true;
                }
                visible += f.doc_opacity * f.v_px_s.abs() / pitch * secs;
                max_op = max_op.max(f.doc_opacity);
            } else {
                in_fade = false;
            }
        }
        m.visible_relocation_lines = visible;
        m.relocation_max_opacity = max_op;
        m.fade_count = fades;

        // §7.8 blur exposure.
        let speeds: Vec<f64> = views
            .iter()
            .filter(|v| v.t >= from_ms)
            .map(|v| v.speed_lines)
            .collect();
        s.speed_lines_s = speeds.clone();
        m.blur_exposure_s = speeds.iter().filter(|x| **x > BLUR_LINES_PER_S).count() as f64 * secs;
        m.max_line_speed = speeds.iter().copied().fold(0.0, f64::max);
    }

    (m, s) = honesty_and_holistic(m, s, gold, trace, &views, from_ms);

    PerceptualEval { metrics: m, samples: s }
}

/// Per-word opacity latency, retake legibility, engine honesty, the two holistic
/// outcomes, readable recovery, and pipeline health.
///
/// Split out purely for length: it consumes the same `views` the frame sweep
/// produced and returns the same two values, so the two halves are one pass over
/// the data conceptually.
fn honesty_and_holistic(
    mut m: PerceptualMetrics,
    mut s: PerceptualSamples,
    gold: &PassGold,
    trace: &StageTrace,
    views: &[FrameView],
    from_ms: f64,
) -> (PerceptualMetrics, PerceptualSamples) {
    let pitch = trace.line_map.line_pitch_px();
    let frame_ms = trace.layout.frame_ms();
    let secs = frame_ms / 1000.0;
    let total = m.take_ms;

    // -----------------------------------------------------------------------
    // §4.3 multi-threshold dim latency
    // -----------------------------------------------------------------------
    // For every on-script word: from the moment the mouth finished it, how long
    // until it visibly began to change, clearly read as passed, and fully
    // entered the read state? Measured on RENDERED OPACITY, so the 240 ms CSS
    // tween and the four-step ramp are both inside the number — which is the
    // whole point. The old `dim_p50_ms` asked when a scalar position crossed the
    // word and called that the answer.
    {
        // Frame index by time, so each word's search is a slice rather than a
        // scan from zero. Words are not monotone in position (a retake sends the
        // reader back), but they ARE monotone in time.
        let frame_at = |t: f64| -> usize {
            let idx = ((t - trace.frames.first().map(|f| f.t_ms).unwrap_or(0.0)) / frame_ms)
                .floor()
                .max(0.0) as usize;
            idx.min(trace.frames.len().saturating_sub(1))
        };
        for w in gold.words.iter().filter(|w| w.span.is_some()) {
            if w.end_ms < from_ms {
                continue;
            }
            let Some((_, hi)) = w.span else { continue };
            // The token the word finished ON. `hi` is an atom boundary, so the
            // token just completed is the one below it.
            let atom = (hi.ceil() as i64 - 1).max(0) as u32;
            let mut hits = [None::<f64>; 3];
            // Premature dimming: darkness on this token BEFORE it was finished.
            let mut premature: Option<f64> = None;
            let look_back = frame_at((w.start_ms - 500.0).max(0.0));
            for f in &trace.frames[look_back..frame_at(w.end_ms).max(look_back)] {
                if let Some(op) = f.opacity_of(atom) {
                    if darkness(op) >= FIRST_RESPONSE {
                        premature = Some(f.t_ms - w.end_ms);
                        break;
                    }
                }
            }
            if let Some(p) = premature {
                s.premature_ms.push(p);
            }
            for f in &trace.frames[frame_at(w.end_ms)..] {
                let Some(op) = f.opacity_of(atom) else { continue };
                let d = darkness(op);
                for (i, thr) in [FIRST_RESPONSE, HALF_DIM, COMMITTED_DIM].iter().enumerate() {
                    if hits[i].is_none() && d >= *thr {
                        hits[i] = Some(f.t_ms - w.end_ms);
                    }
                }
                if hits.iter().all(Option::is_some) {
                    break;
                }
            }
            if let Some(v) = hits[0] {
                s.first_response_ms.push(v);
            }
            if let Some(v) = hits[1] {
                s.half_dim_ms.push(v);
            }
            match hits[2] {
                Some(v) => s.committed_dim_ms.push(v),
                // Only a word the take gave a fair chance to counts as missed.
                None if w.end_ms + DIM_TAIL_GRACE_MS <= total => m.dim_never += 1,
                None => {}
            }
        }
        m.first_response_p50 = pctl(&s.first_response_ms, 50.0);
        m.first_response_p95 = pctl(&s.first_response_ms, 95.0);
        m.half_dim_p50 = pctl(&s.half_dim_ms, 50.0);
        m.half_dim_p95 = pctl(&s.half_dim_ms, 95.0);
        m.committed_dim_p50 = pctl(&s.committed_dim_ms, 50.0);
        m.committed_dim_p95 = pctl(&s.committed_dim_ms, 95.0);
        m.dim_latency_mad = mad(&s.half_dim_ms);
        m.dim_spread_p95_p50 = m.half_dim_p95 - m.half_dim_p50;
        m.premature_dim_p05 = pctl(&s.premature_ms, 5.0);
        m.premature_dim_p01 = pctl(&s.premature_ms, 1.0);
    }

    // -----------------------------------------------------------------------
    // §4.4 retake rebrightening / §4.5 correction burden
    // -----------------------------------------------------------------------
    // The global high-water metric is structurally blind to this: on that
    // reference the text a reader is re-reading has been spoken, so leaving it
    // dark is free. Pass-aware, it is a legibility failure.
    {
        let mut loss = 0.0;
        let mut anchor_bright = Vec::new();
        let mut worst_dark = 0.0f64;
        for d in gold
            .discontinuities
            .iter()
            .filter(|d| d.kind == EventKind::Retake && d.at_ms >= from_ms)
        {
            let anchor = d.to.floor().max(0.0) as u32;
            let mut bright_at: Option<f64> = None;
            for f in trace.frames.iter().filter(|f| f.t_ms >= d.at_ms) {
                // Word-seconds of text the reader must read again, left dim.
                let mut frame_loss = 0.0;
                for k in 0..READABLE_NEXT_WORDS {
                    if let Some(op) = f.opacity_of(anchor + k) {
                        let dk = darkness(op);
                        frame_loss += dk;
                        worst_dark = worst_dark.max(dk);
                    }
                }
                loss += frame_loss * secs;
                if bright_at.is_none() {
                    let ok = (0..READABLE_NEXT_WORDS).all(|k| {
                        f.opacity_of(anchor + k)
                            .map(|op| darkness(op) <= READABLE_NEXT_MAX_DARKNESS)
                            .unwrap_or(true)
                    });
                    if ok {
                        bright_at = Some(f.t_ms - d.at_ms);
                    }
                }
                if f.t_ms > d.at_ms + 6_000.0 {
                    break;
                }
            }
            if let Some(b) = bright_at {
                anchor_bright.push(b);
            }
        }
        m.retake_legibility_loss = loss;
        m.retake_anchor_bright_p95_ms = pctl(&anchor_bright, 95.0);
        m.retake_reread_max_darkness = worst_dark;

        // Corrections: a token that got darker and then came back. The objective
        // is NOT zero — a small smooth correction can beat universally late
        // darkening — so depth and duration are reported beside the count.
        let mut corrections = 0u32;
        let mut depths = Vec::new();
        let mut durations = Vec::new();
        // Track only tokens the cursor actually passed near, which is every
        // token that can be corrected at all.
        let mut peak: std::collections::HashMap<u32, (f64, f64)> = Default::default();
        for f in trace.frames.iter().filter(|f| f.t_ms >= from_ms) {
            for &(atom, op) in &f.token_opacity {
                let d = darkness(op as f64);
                let e = peak.entry(atom).or_insert((d, f.t_ms));
                if d > e.0 {
                    *e = (d, f.t_ms);
                } else if e.0 - d > UIE_INCIDENT_DARKNESS && e.0 > UIE_INCIDENT_DARKNESS {
                    corrections += 1;
                    depths.push(e.0 - d);
                    durations.push(f.t_ms - e.1);
                    *e = (d, f.t_ms);
                }
            }
        }
        let words = gold.words.iter().filter(|w| w.span.is_some()).count().max(1);
        m.corrections_per_1k_words = 1_000.0 * corrections as f64 / words as f64;
        m.correction_depth_p95 = pctl(&depths, 95.0);
        m.correction_duration_p95_ms = pctl(&durations, 95.0);
    }

    // -----------------------------------------------------------------------
    // §8 honest uncertainty
    // -----------------------------------------------------------------------
    // Being wrong while HOLDING is a recovery problem. Being wrong while
    // claiming to follow is a lie, and it is much worse: the presenter reads
    // dimming as "you are here". The old table only had a 20-atom catastrophic
    // threshold; this fills the space beneath it.
    {
        let mut fce_ms = [0.0f64; 3];
        let mut run_ms = 0.0;
        let mut episodes = 0u32;
        let mut counted = false;
        let mut worst = 0.0f64;
        let mut eligible = 0usize;
        let mut following_ms = 0.0;
        let mut hold_correct_ms = 0.0;
        let mut hold_total_ms = 0.0;
        let mut should_hold_ms = 0.0;
        let mut unnecessary_hold_ms = 0.0;
        let mut transitions = 0u32;
        let mut last_state: Option<TrackingState> = None;
        let mut releases = Vec::new();
        let mut hold_since: Option<f64> = None;

        for (v, f) in views.iter().zip(trace.frames.iter()) {
            if v.t < from_ms {
                continue;
            }
            if let Some(st) = f.state {
                if last_state.map(|p| p != st).unwrap_or(false) {
                    transitions += 1;
                }
                last_state = Some(st);
            }
            let following = matches!(f.state, Some(TrackingState::Following));
            let holding = matches!(
                f.state,
                Some(TrackingState::Holding) | Some(TrackingState::Ambiguous)
            );
            // Gold says a hold is CORRECT when the reader is off-script; it is
            // unnecessary when they are reading the script cleanly.
            let clean = v.on_script && v.speaking && v.kind == EventKind::OnScript;
            if !v.on_script {
                should_hold_ms += frame_ms;
            }
            if holding {
                hold_total_ms += frame_ms;
                if !v.on_script {
                    hold_correct_ms += frame_ms;
                }
                if clean {
                    unnecessary_hold_ms += frame_ms;
                }
                if hold_since.is_none() {
                    hold_since = Some(v.t);
                }
            } else if let Some(started) = hold_since.take() {
                // Hold-release latency: how long after the reader came back
                // on-script did the engine let go?
                if v.on_script {
                    releases.push(v.t - started);
                }
            }

            if following {
                following_ms += frame_ms;
                let err = (f.display_atoms - v.frontier).abs();
                eligible += 1;
                for (i, delta) in FCE_DELTAS.iter().enumerate() {
                    if err > *delta {
                        fce_ms[i] += frame_ms;
                    }
                }
                if err > FCE_DELTAS[2] {
                    run_ms += frame_ms;
                    worst = worst.max(run_ms);
                    if run_ms >= DISRUPTION_MIN_MS && !counted {
                        episodes += 1;
                        counted = true;
                    }
                } else {
                    run_ms = 0.0;
                    counted = false;
                }
                // §8.3 calibration: was the engine actually within 3 atoms while
                // reporting this confidence?
                s.calibration.push((f.confidence, err <= FCE_DELTAS[0]));
            } else {
                run_ms = 0.0;
                counted = false;
            }
        }
        let scored_ms = (eligible as f64 * frame_ms).max(1.0);
        m.fce_3_pct = 100.0 * fce_ms[0] / scored_ms;
        m.fce_5_pct = 100.0 * fce_ms[1] / scored_ms;
        m.fce_10_pct = 100.0 * fce_ms[2] / scored_ms;
        m.fce_max_episode_ms = worst;
        m.fce_episodes = episodes;
        m.hold_precision = if hold_total_ms > 0.0 {
            hold_correct_ms / hold_total_ms
        } else {
            f64::NAN
        };
        m.hold_recall = if should_hold_ms > 0.0 {
            hold_correct_ms / should_hold_ms
        } else {
            f64::NAN
        };
        let clean_ms: f64 = views
            .iter()
            .filter(|v| v.t >= from_ms && v.on_script && v.speaking && v.kind == EventKind::OnScript)
            .count() as f64
            * frame_ms;
        m.unnecessary_hold_pct = if clean_ms > 0.0 {
            100.0 * unnecessary_hold_ms / clean_ms
        } else {
            f64::NAN
        };
        m.hold_release_p95_ms = pctl(&releases, 95.0);
        let minutes = (total - from_ms).max(1.0) / 60_000.0;
        m.state_transitions_per_min = transitions as f64 / minutes;
        let _ = following_ms;

        // Brier + expected calibration error over ten bins.
        if !s.calibration.is_empty() {
            let n = s.calibration.len() as f64;
            m.brier = s
                .calibration
                .iter()
                .map(|(c, y)| (c - if *y { 1.0 } else { 0.0 }).powi(2))
                .sum::<f64>()
                / n;
            let mut bins = [(0.0f64, 0.0f64, 0usize); 10];
            for (c, y) in &s.calibration {
                let b = ((c * 10.0).floor() as usize).min(9);
                bins[b].0 += *c;
                bins[b].1 += if *y { 1.0 } else { 0.0 };
                bins[b].2 += 1;
            }
            m.ece = bins
                .iter()
                .filter(|(_, _, k)| *k > 0)
                .map(|(sc, sy, k)| {
                    let k = *k as f64;
                    (k / n) * ((sc / k) - (sy / k)).abs()
                })
                .sum();
        } else {
            m.brier = f64::NAN;
            m.ece = f64::NAN;
        }
    }

    // -----------------------------------------------------------------------
    // §3.1 readable availability / §3.2 disruption-free survival
    // -----------------------------------------------------------------------
    {
        let scored: Vec<&FrameView> = views.iter().filter(|v| v.t >= from_ms).collect();
        let clean: Vec<&&FrameView> = scored
            .iter()
            .filter(|v| v.on_script && v.kind == EventKind::OnScript)
            .collect();
        m.readable_availability = pct(
            clean.iter().filter(|v| v.readable).count(),
            clean.len(),
        );

        // Disruptions: each kind tracked as its own sustained excursion, so one
        // bad moment is not counted six times and two different failures in the
        // same second are not merged into one.
        let mut log: Vec<Disruption> = Vec::new();
        let kinds: [(DisruptionKind, &dyn Fn(&FrameView, &crate::stage::Frame) -> bool); 7] = [
            (DisruptionKind::UnreadInk, &|v, _| v.uie_tokens > 0 && v.uie_worst > 0.3),
            // Text the presenter is about to read, materially darkened.
            (DisruptionKind::UnreadInk, &|v, _| {
                v.on_script && v.next_worst_darkness > 0.5
            }),
            (DisruptionKind::BandLoss, &|v, _| v.on_script && v.band_err > 1.0),
            (DisruptionKind::UnnecessaryHold, &|v, f| {
                v.on_script
                    && v.speaking
                    && v.kind == EventKind::OnScript
                    && matches!(
                        f.state,
                        Some(TrackingState::Holding) | Some(TrackingState::Ambiguous)
                    )
            }),
            (DisruptionKind::BlurTravel, &|v, _| v.speed_lines > BLUR_LINES_PER_S),
            (DisruptionKind::FutureStarvation, &|v, _| {
                v.on_script && v.future_reserve < 0.5
            }),
            (DisruptionKind::FalseConfidence, &|v, f| {
                matches!(f.state, Some(TrackingState::Following))
                    && (f.display_atoms - v.frontier).abs() > FCE_DELTAS[2]
            }),
        ];
        for (kind, pred) in kinds {
            let mut run_ms = 0.0;
            let mut start = 0.0;
            for (v, f) in views.iter().zip(trace.frames.iter()) {
                if v.t < from_ms {
                    continue;
                }
                if pred(v, f) {
                    if run_ms == 0.0 {
                        start = v.t;
                    }
                    run_ms += frame_ms;
                } else {
                    if run_ms >= DISRUPTION_MIN_MS {
                        log.push(Disruption { kind, at_ms: start, duration_ms: run_ms });
                    }
                    run_ms = 0.0;
                }
            }
            if run_ms >= DISRUPTION_MIN_MS {
                log.push(Disruption { kind, at_ms: start, duration_ms: run_ms });
            }
        }
        log.sort_by(|a, b| a.at_ms.partial_cmp(&b.at_ms).unwrap_or(std::cmp::Ordering::Equal));
        s.disruption_ms = log.iter().map(|d| d.duration_ms).collect();
        m.disruptions = log.len() as u32;
        let minutes = (total - from_ms).max(1.0) / 60_000.0;
        m.disruptions_per_10min = 10.0 * log.len() as f64 / minutes;
        m.disruption_p95_ms = pctl(&s.disruption_ms, 95.0);
        m.disruption_max_ms = s.disruption_ms.iter().copied().fold(0.0, f64::max);
        m.first_disruption_ms = log.first().map(|d| d.at_ms - from_ms);
        s.survival_ms.push(m.first_disruption_ms);
        // Longest stretch with nothing going wrong — the number a presenter
        // would recognise as "it just worked for a while".
        {
            let mut best = 0.0f64;
            let mut cursor = from_ms;
            for d in &log {
                best = best.max(d.at_ms - cursor);
                cursor = d.at_ms + d.duration_ms;
            }
            m.longest_clean_ms = best.max(total - cursor);
        }
        m.disruption_log = log;
    }

    // -----------------------------------------------------------------------
    // §9 readable recovery
    // -----------------------------------------------------------------------
    // A recovery is not complete when the engine's number is right. It is
    // complete when the presenter can read again: correctly placed, brightly
    // rendered, and holding.
    {
        let mut recs = Vec::new();
        for d in gold.discontinuities.iter().filter(|d| d.at_ms >= from_ms) {
            let mut semantic = None;
            let mut readable = None;
            let mut regret = (0.0, 0.0, 0.0);
            for (i, (v, f)) in views.iter().zip(trace.frames.iter()).enumerate() {
                if v.t < d.at_ms {
                    continue;
                }
                if semantic.is_none() && (f.display_atoms - v.frontier).abs() <= FCE_DELTAS[0] {
                    semantic = Some(v.t - d.at_ms);
                }
                if readable.is_none() && v.readable {
                    // Must HOLD for the stability window.
                    let held = views[i..]
                        .iter()
                        .take_while(|g| g.t <= v.t + RECOVERY_STABLE_MS)
                        .all(|g| g.readable || !g.on_script);
                    if held {
                        readable = Some(v.t - d.at_ms);
                    }
                }
                if readable.is_none() {
                    regret.0 += v.temporal_err.unwrap_or(0.0).abs() * REGRET_W_TEMPORAL * secs;
                    regret.1 += v.band_err * REGRET_W_BAND * secs;
                    regret.2 += v.uie * REGRET_W_INK * secs;
                } else if v.t > d.at_ms + 8_000.0 {
                    break;
                }
            }
            let words_spoken = readable
                .map(|r| {
                    gold.words_ending_in(d.at_ms, d.at_ms + r)
                        .count() as u32
                })
                .unwrap_or(0);
            let snapback = readable
                .map(|r| {
                    gold.discontinuities.iter().any(|e| {
                        e.at_ms > d.at_ms + r && e.at_ms <= d.at_ms + r + 5_000.0
                    })
                })
                .unwrap_or(false);
            if let Some(r) = readable {
                s.readable_recovery_ms.push(r);
            }
            recs.push(ReadableRecovery {
                kind: d.kind,
                at_ms: d.at_ms,
                semantic_ms: semantic,
                readable_ms: readable,
                words_spoken,
                regret_temporal: regret.0,
                regret_band: regret.1,
                regret_ink: regret.2,
                snapback,
            });
        }
        m.readable_recovery_p50 = pctl(&s.readable_recovery_ms, 50.0);
        m.readable_recovery_p95 = pctl(&s.readable_recovery_ms, 95.0);
        m.readable_recovery_failures =
            recs.iter().filter(|r| r.readable_ms.is_none()).count() as u32;
        m.recovery_regret = recs
            .iter()
            .map(|r| r.regret_temporal + r.regret_band + r.regret_ink)
            .sum();
        m.recovery_snapbacks = recs.iter().filter(|r| r.snapback).count() as u32;
        m.recovered_within_5_words_pct = pct(
            recs.iter()
                .filter(|r| r.readable_ms.is_some() && r.words_spoken <= 5)
                .count(),
            recs.iter().filter(|r| r.readable_ms.is_some()).count(),
        );
        m.recoveries = recs;
    }

    // -----------------------------------------------------------------------
    // §10 evidence freshness and follow availability
    // -----------------------------------------------------------------------
    // The most dangerous reliability failure is not a crash; it is an
    // apparently healthy take that has quietly stopped following.
    {
        let fresh: Vec<f64> = trace
            .frames
            .iter()
            .filter(|f| f.t_ms >= from_ms && f.state.is_some())
            .map(|f| (f.t_ms - f.evidence_ms).max(0.0))
            .collect();
        s.freshness_ms = fresh.clone();
        m.freshness_p50 = pctl(&fresh, 50.0);
        m.freshness_p95 = pctl(&fresh, 95.0);
        m.freshness_max = fresh.iter().copied().fold(0.0, f64::max);
        m.stale_500_pct = pct(fresh.iter().filter(|x| **x > 500.0).count(), fresh.len());
        m.stale_1000_pct = pct(fresh.iter().filter(|x| **x > 1_000.0).count(), fresh.len());
        // A valid follow path this frame: a snapshot exists, its evidence is not
        // ancient, the line map is usable and the plant produced a finite
        // position.
        let healthy = trace
            .frames
            .iter()
            .filter(|f| f.t_ms >= from_ms)
            .filter(|f| {
                f.state.is_some()
                    && (f.t_ms - f.evidence_ms) < 3_000.0
                    && f.q_px.is_finite()
                    && f.target_px.is_finite()
                    && trace.line_map.line_count() > 0
            })
            .count();
        let all = trace.frames.iter().filter(|f| f.t_ms >= from_ms).count();
        m.follow_availability = pct(healthy, all);
    }

    let _ = (pitch, PAST_OPACITY);
    (m, s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::{expand, synthetic_timing, Corruption, PerformancePlan, PlanOp};
    use cc_align::{compile, CompileOptions};

    const WORDS: &str = "alpha bravo charlie delta echo foxtrot golf hotel india juliet \
                         kilo lima mike november oscar papa quebec romeo sierra tango";

    fn gold_at(wpm: u32, ops: Vec<PlanOp>) -> PassGold {
        let script = compile(WORDS, CompileOptions::default());
        let plan = PerformancePlan {
            name: "t".into(),
            script: "t".into(),
            scenario: "exact".into(),
            seed: 1,
            ops,
            corruption: Corruption::default(),
        };
        PassGold::derive(&synthetic_timing(&expand(&plan, &script), wpm))
    }

    /// Tokens on the glass: everything in `on_glass` bright, everything named in
    /// `dark` taken all the way to the far past. Contiguous and ascending, the
    /// way `stage::render` builds it — so an atom outside the range is
    /// off-screen, not merely unlisted.
    fn glass(on_glass: std::ops::Range<u32>, dark: &[u32]) -> Vec<(u32, f32)> {
        on_glass
            .map(|a| {
                let op = if dark.contains(&a) { PAST_OPACITY } else { 1.0 };
                (a, op as f32)
            })
            .collect()
    }

    #[test]
    fn the_corridor_ends_at_the_first_word_the_ramp_has_taken() {
        let gold = gold_at(150, vec![PlanOp::Read { from: 0, to: 20 }]);
        let r = measure_readable_ahead(&gold, 0, 5.0, &glass(0..20, &[8])).expect("inside pass 0");
        assert_eq!(r.end, ReadableAheadEnd::DimRamp);
        let expected = gold.tau(0, 8.0).unwrap() - gold.tau(0, 5.0).unwrap();
        assert!(
            (r.ms - expected).abs() < 1.0,
            "corridor {} ms, atoms 5→8 take {expected} ms",
            r.ms
        );
    }

    #[test]
    fn a_bright_word_past_the_dark_one_does_not_reopen_the_corridor() {
        let gold = gold_at(150, vec![PlanOp::Read { from: 0, to: 20 }]);
        // Dark at 8, bright again from 9. What the reader can rely on is the
        // CONTIGUOUS run; text past a hole in it is not a corridor.
        let broken = measure_readable_ahead(&gold, 0, 5.0, &glass(0..20, &[8])).unwrap();
        let clear = measure_readable_ahead(&gold, 0, 5.0, &glass(0..20, &[])).unwrap();
        assert!(broken.ms < clear.ms);
        assert_eq!(clear.end, ReadableAheadEnd::MaterialEnd);
    }

    #[test]
    fn the_corridor_is_denominated_in_the_readers_own_pace() {
        // The same three atoms, read at half the speed, is twice the reading.
        // An atom-denominated metric calls these two identical, which is the
        // whole reason this module works in milliseconds.
        let slow = measure_readable_ahead(
            &gold_at(120, vec![PlanOp::Read { from: 0, to: 20 }]),
            0,
            5.0,
            &glass(0..20, &[8]),
        )
        .unwrap();
        let fast = measure_readable_ahead(
            &gold_at(240, vec![PlanOp::Read { from: 0, to: 20 }]),
            0,
            5.0,
            &glass(0..20, &[8]),
        )
        .unwrap();
        // 3 words at 120 wpm = 1500 ms; at 240 wpm = 750 ms.
        assert!((slow.ms - 1_500.0).abs() < 5.0, "120 wpm gave {}", slow.ms);
        assert!((fast.ms - 750.0).abs() < 5.0, "240 wpm gave {}", fast.ms);
    }

    #[test]
    fn running_out_of_script_is_not_a_dimming_defect() {
        let gold = gold_at(150, vec![PlanOp::Read { from: 0, to: 20 }]);
        // Four words from the end, all of them on the glass and bright. The
        // reader really does have only four words left, and calling that
        // starvation would fail every take at its own ending.
        let r = measure_readable_ahead(&gold, 0, 16.0, &glass(0..20, &[])).unwrap();
        assert_eq!(r.end, ReadableAheadEnd::MaterialEnd);
    }

    #[test]
    fn material_end_frames_leave_the_deficit_denominator() {
        // Built directly, because the exclusion is in the summariser rather
        // than in the walk: a MaterialEnd frame must not be a sample AND must
        // not be counted against the percentage.
        let m = |ms: f64, end| Some(ReadableAheadMeasurement { ms, end });
        let views = [
            m(100.0, ReadableAheadEnd::DimRamp),
            m(50.0, ReadableAheadEnd::MaterialEnd),
            m(900.0, ReadableAheadEnd::Viewport),
        ];
        let measured: Vec<ReadableAheadMeasurement> = views.iter().flatten().copied().collect();
        let corridor: Vec<&ReadableAheadMeasurement> = measured
            .iter()
            .filter(|r| r.end != ReadableAheadEnd::MaterialEnd)
            .collect();
        assert_eq!(corridor.len(), 2, "the 50 ms tail of the script is censored");
        assert_eq!(
            pct(
                corridor.iter().filter(|r| r.ms < READABLE_AHEAD_MIN_MS).count(),
                corridor.len()
            ),
            50.0,
            "one of the two real frames was short, not one of three"
        );
    }

    #[test]
    fn running_off_the_glass_is_a_deficit_with_its_own_cause() {
        let gold = gold_at(150, vec![PlanOp::Read { from: 0, to: 20 }]);
        // Plenty of script left, but the glass stops at atom 10.
        let r = measure_readable_ahead(&gold, 0, 5.0, &glass(0..10, &[])).unwrap();
        assert_eq!(r.end, ReadableAheadEnd::Viewport);
        let expected = gold.tau(0, 10.0).unwrap() - gold.tau(0, 5.0).unwrap();
        assert!((r.ms - expected).abs() < 1.0);
    }

    #[test]
    fn a_word_dimmed_while_still_in_the_mouth_is_an_empty_corridor() {
        let gold = gold_at(150, vec![PlanOp::Read { from: 0, to: 20 }]);
        // The ramp has taken the word the reader is part-way through saying —
        // the sharpest form of the defect, and the walk has to start on that
        // token to see it at all.
        let r = measure_readable_ahead(&gold, 0, 5.4, &glass(0..20, &[5])).unwrap();
        assert_eq!(r.end, ReadableAheadEnd::DimRamp);
        assert_eq!(r.ms, 0.0, "an empty corridor, never a negative one");
    }

    #[test]
    fn the_corridor_sees_past_the_fixed_eight_word_window() {
        // `next_worst_darkness` scans exactly READABLE_NEXT_WORDS atoms, so a
        // word darkened beyond that is invisible to it. This is the evidence
        // the new row is a different measurement rather than a restatement.
        let gold = gold_at(150, vec![PlanOp::Read { from: 0, to: 20 }]);
        let reader = 5.0;
        let dark = reader as u32 + READABLE_NEXT_WORDS + 2;
        let mut next_worst = 0.0f64;
        let on_glass = glass(0..20, &[dark]);
        for atom in reader as u32..reader as u32 + READABLE_NEXT_WORDS {
            if let Some(&(_, op)) = on_glass.iter().find(|&&(a, _)| a == atom) {
                next_worst = next_worst.max(darkness(op as f64));
            }
        }
        assert!(next_worst <= READABLE_NEXT_MAX_DARKNESS, "the old check is happy");

        let r = measure_readable_ahead(&gold, 0, reader, &on_glass).unwrap();
        assert_eq!(r.end, ReadableAheadEnd::DimRamp, "the new one is not");
        let expected = gold.tau(0, dark as f64).unwrap() - gold.tau(0, reader).unwrap();
        assert!((r.ms - expected).abs() < 1.0);
    }

    #[test]
    fn a_retake_is_measured_against_its_own_pass() {
        // The retake is read at twice the speed, so the two passes disagree
        // about how long the same four atoms take. At one rate they would
        // agree by coincidence and the test would pass without the code
        // choosing a pass at all.
        let gold = gold_at(
            150,
            vec![
                PlanOp::Read { from: 0, to: 12 },
                PlanOp::Rate { wpm: 300 },
                PlanOp::Read { from: 6, to: 20 },
            ],
        );
        // Back at atom 7 on the second pass. Pass 0 also covers atom 7, and its
        // timing is a whole pass earlier — reading the corridor off the wrong
        // pass would produce a large negative, clamped to a silent zero.
        let r = measure_readable_ahead(&gold, 1, 7.0, &glass(0..20, &[11])).unwrap();
        assert_eq!(r.end, ReadableAheadEnd::DimRamp);
        assert!(r.ms > 0.0, "the retake pass genuinely has text ahead of it");
        let expected = gold.tau(1, 11.0).unwrap() - gold.tau(1, 7.0).unwrap();
        assert!((r.ms - expected).abs() < 1.0);

        let wrong_pass = measure_readable_ahead(&gold, 0, 7.0, &glass(0..20, &[11])).unwrap();
        assert!(
            (wrong_pass.ms - 2.0 * r.ms).abs() < 5.0,
            "pass 0 read the same atoms at half the speed: {} vs {}",
            wrong_pass.ms,
            r.ms
        );
    }

    #[test]
    fn a_position_outside_the_pass_has_no_answer() {
        let gold = gold_at(150, vec![PlanOp::Read { from: 0, to: 10 }]);
        // Same condition that makes `temporal_err` None: refusing beats
        // inventing a corridor out of material the pass never covered.
        assert!(measure_readable_ahead(&gold, 0, 18.0, &glass(0..20, &[])).is_none());
        assert!(measure_readable_ahead(&gold, 9, 5.0, &glass(0..20, &[])).is_none());
    }
}
