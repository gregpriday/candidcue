//! The evaluator: compares a replayed display trajectory against the gold
//! timeline and produces the benchmark numbers.
//!
//! Two levels (spec §19): render-time product metrics come from sampling the
//! display trajectory on a uniform 50 ms grid (a long freeze cannot hide
//! between events); event-level metrics (pre-final movement) come from the
//! per-item traces. There is deliberately no single aggregate score — safety,
//! accuracy, responsiveness and recovery are reported separately and the
//! optimisation phase must not trade catastrophic jumps for average lag.

use serde::{Deserialize, Serialize};

use crate::plan::GoldTimeline;
use crate::replay::ReplayResult;

/// Sampling grid for render-time metrics.
const SAMPLE_MS: f64 = 50.0;
/// Freeze detection: display movement below this over the window…
const FREEZE_DISPLAY_ATOMS: f64 = 0.1;
/// …while gold advanced at least this much.
const FREEZE_GOLD_ATOMS: f64 = 1.5;
const FREEZE_WINDOW_MS: f64 = 700.0;
/// A display movement this large between adjacent samples is a jump.
const JUMP_ATOMS: f64 = 10.0;
/// Gold discontinuity threshold.
const GOLD_JUMP_ATOMS: f64 = 10.0;
/// A display jump is *false* if no gold discontinuity of the same sign lies
/// within this window around it.
const JUMP_MATCH_WINDOW_MS: f64 = 3_000.0;
/// Wrongness threshold + duration for a catastrophic period.
const CATASTROPHIC_ATOMS: f64 = 20.0;
const CATASTROPHIC_SUSTAIN_MS: f64 = 2_000.0;
/// Grace period after a gold discontinuity before wrongness counts as
/// catastrophic (recovery metrics own that window).
const DISCONTINUITY_GRACE_MS: f64 = 5_000.0;
/// ---------------------------------------------------------------------------
/// Overshoot: the display ahead of what the reader has actually said.
/// ---------------------------------------------------------------------------
/// The display fades words out as they are heard, so the two directions of
/// error are not symmetric and must not be pooled into one `|err|`. Trailing
/// leaves a word visible slightly too long — nobody notices. Leading *erases
/// text the reader has not read yet*, and they are reading it. Greg's ruling:
/// treat running ahead as the catastrophic direction and measure it on its own.
///
/// Measured against the HIGH-WATER MARK of `floor(gold)` — the furthest word
/// the reader has ever finished saying — not their instantaneous position. A
/// word is safe to fade once it has been spoken, and going back to re-read a
/// sentence does not un-speak it: on a retake or a repeated phrase the display
/// legitimately sits "ahead" of where the mouth is, and nothing has been
/// erased that the reader had not already read. Against instantaneous gold
/// that benign case swamps the metric — it scored 105 incidents, 100 of them
/// backward moves — and the defect being hunted here would be invisible in the
/// noise. A frontier resting on the word currently in the mouth is the
/// generous end of correct; the tolerance is one word past that.
const AHEAD_TOLERANCE_ATOMS: f64 = 1.0;
/// An excursion this far ahead, held this long, is one countable "it got ahead
/// of me" incident: two atoms past the last finished word means a word the
/// reader has not spoken at all has been faded out, and 300 ms is long enough
/// to see it happen.
const AHEAD_EVENT_ATOMS: f64 = 2.0;
const AHEAD_EVENT_SUSTAIN_MS: f64 = 300.0;
/// ---------------------------------------------------------------------------
/// Re-spelling windows: where the two sides disagreed about notation.
/// ---------------------------------------------------------------------------
/// A whole-run accuracy number on an `asr_forms` script is mostly measuring the
/// plain prose between the figures — a page with twenty re-spelled runs still
/// spends 90% of its words on ordinary words that were never in dispute, so a
/// real failure on every single number moves the headline by a few points and
/// stays inside ±5. These counters score only the samples inside a re-spelled
/// run and the window just after it, which is where the failure actually lives.
///
/// The tail exists because the evidence arrives late: a word is not in a
/// transcript until the provider emits one, so the display cannot be judged on
/// a figure at the instant it is spoken. 1.5 s is the same window the recovery
/// metrics use to decide a lock has held.
const SPAN_TAIL_MS: f64 = 1_500.0;
/// ---------------------------------------------------------------------------
/// Smoothness: how the display MOVES, not where it ends up.
/// ---------------------------------------------------------------------------
/// Every knob in the engine was tuned against the accuracy and overshoot
/// numbers above, which score the display's POSITION at each sample and say
/// nothing at all about the path it took to get there. A display that crawls
/// at a third of the reader's pace and then steps forward once a second scores
/// identically to one that glides — same positions, same errors — and only one
/// of them is watchable. These counters score the derivative.
///
/// Measured on the same 50 ms grid, gated on the reader actually SPEAKING and
/// on-script: a stopped display while the reader is silent is correct, and
/// pooling those samples in would swamp the signal with legitimate rest.
/// Intervals spanning a display jump are excluded — a relocation is a
/// deliberate discontinuity with its own metrics, not a symptom of jerk.
/// Below this the display is not moving (atoms/second).
const STATIONARY_ATOMS_S: f64 = 0.05;
/// A stall is the display dropping below this fraction of THE READER'S pace
/// and staying there — the "it keeps hesitating" complaint.
///
/// Referenced to the run's MEAN display speed, which is the reader: over a
/// speaking stretch the display must average the reader's pace or it would
/// fall arbitrarily behind. Referencing the median instead — the display's own
/// typical speed — makes the row meaningless across configurations, because a
/// config that crawls has a low median and its crawl never dips below its own
/// floor. Measured that way a display moving at a third of reading pace scored
/// 1.8 stalls/min and one moving *with* the reader scored 39, which is exactly
/// backwards.
const STALL_FRACTION: f64 = 0.2;
/// …for at least this long. Three samples: shorter than this is a sampling
/// artefact, longer and the eye has already noticed.
const STALL_SUSTAIN_MS: f64 = 150.0;
/// Recovery: locked when |err| ≤ 3, and stays ≤ 5 for the sustain window.
const RECOVER_HIT_ATOMS: f64 = 3.0;
const RECOVER_HOLD_ATOMS: f64 = 5.0;
const RECOVER_SUSTAIN_MS: f64 = 1_500.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RecoveryKind {
    Initial,
    SkipForward,
    Retake,
    AdlibReturn,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecoveryEvent {
    pub kind: RecoveryKind,
    pub at_ms: f64,
    /// None = never recovered before the run ended.
    pub recovered_in_s: Option<f64>,
}

/// Per-run metric summary (serialised into the run directory).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RunMetrics {
    pub run: String,
    pub scenario: String,
    /// Seconds of on-script speaking time evaluated.
    pub on_script_s: f64,
    pub within2_pct: f64,
    pub within5_pct: f64,
    pub p50_abs: f64,
    pub p95_abs: f64,
    pub mean_signed: f64,
    pub freeze_pct: f64,
    // Raw counts so the suite can pool across runs without re-weighting
    // percentages.
    pub eligible_samples: usize,
    pub within2_hits: usize,
    pub within5_hits: usize,
    pub freeze_frozen: usize,
    pub freeze_eligible: usize,
    pub prefinal_moved: usize,
    pub prefinal_total: usize,
    pub false_jumps: u32,
    pub catastrophic: u32,
    pub recoveries: Vec<RecoveryEvent>,
    /// Max |display − hold anchor| during off-script intervals (atoms).
    pub adlib_max_drift: Option<f64>,
    /// P95 of signed display lead while the reader is PAUSED (on-script,
    /// not speaking): how far the text ran ahead during a pause. The
    /// over-eager-forward failure lives here.
    pub pause_overshoot_p95: Option<f64>,
    /// % of on-script time the display sat more than a word ahead of the last
    /// word actually spoken.
    pub ahead_pct: f64,
    /// Seconds of that time.
    pub ahead_s: f64,
    /// Distinct excursions ≥3 atoms ahead, held ≥300 ms — "the number of times
    /// it jumped ahead of me".
    pub ahead_events: u32,
    /// Worst overshoot reached (atoms). None when nothing was ever ahead.
    pub ahead_worst: Option<f64>,
    /// Raw counts so the suite pools without re-weighting percentages.
    pub ahead_samples: usize,
    pub ahead_eligible: usize,
    /// % of ≥8-content-word items whose display moved before the final.
    pub prefinal_move_pct: Option<f64>,
    pub event_count: usize,
    pub mean_event_us: f64,
    pub p95_event_us: u64,
    /// Diagnostic WER of the final transcripts vs what was actually said.
    pub wer_pct: Option<f64>,
    /// Samples inside a re-spelling window (and its 1.5 s tail), and the hits
    /// among them. Zero on every family that re-spells nothing.
    ///
    /// Defaulted so results saved before these existed still deserialise —
    /// `report` and `compare` read checked-in JSON directly, and deriving
    /// `Default` on the struct does not make a missing field optional.
    #[serde(default)]
    pub span_eligible: usize,
    #[serde(default)]
    pub span_within2: usize,
    #[serde(default)]
    pub span_within5: usize,

    /// ---- smoothness (see the constants) ----
    /// Sample intervals scored for motion: on-script, speaking, no jump.
    #[serde(default)]
    pub motion_eligible: usize,
    /// …of which the display was not moving at all.
    #[serde(default)]
    pub motion_stationary: usize,
    /// % of speaking time the display sat still. The single most legible
    /// smoothness number: it is the stop half of stop-start.
    #[serde(default)]
    pub stationary_pct: f64,
    /// Display speed while the reader speaks (atoms/second). A system moving
    /// WITH the reader has these three close together; the spread between
    /// p10 and p90 is the surge-and-crawl amplitude.
    #[serde(default)]
    pub vel_p10: f64,
    #[serde(default)]
    pub vel_p50: f64,
    #[serde(default)]
    pub vel_p90: f64,
    /// Coefficient of variation of that speed (σ/μ). Scale-free, so it
    /// compares across readers and scripts; 0 is a perfectly steady glide.
    #[serde(default)]
    pub vel_cov: f64,
    /// Distinct hesitations: speed under `STALL_FRACTION` of the run median,
    /// held `STALL_SUSTAIN_MS`. "The number of times it paused on me."
    #[serde(default)]
    pub stalls: u32,
    /// P95 of |change in speed| between adjacent samples (atoms/s per sample)
    /// — the size of the steps the plant has to absorb. This is the metric
    /// that moves when the display stops being fed a once-a-second correction.
    #[serde(default)]
    pub surge_p95: f64,
}

/// Raw per-sample data kept for suite-level pooling (not serialised).
#[derive(Debug, Default)]
pub struct RunSamples {
    pub abs_err: Vec<f64>,
    pub signed_err: Vec<f64>,
    /// Signed lead (display − gold hold position) during speaking pauses.
    pub pause_lead: Vec<f64>,
    /// Signed overshoot (display − last word finished) at every on-script
    /// sample, pausing or speaking. Positive means text was faded early.
    pub ahead: Vec<f64>,
    /// Absolute error at samples inside a re-spelling window.
    pub span_abs: Vec<f64>,
    /// Display speed (atoms/second) over each motion-eligible interval, so the
    /// suite can pool a distribution across runs instead of averaging
    /// per-run percentiles.
    pub velocity: Vec<f64>,
}

pub struct RunEval {
    pub metrics: RunMetrics,
    pub samples: RunSamples,
}

/// Display sample: position plus the engine's claimed state at that moment.
/// The state matters for metric semantics — a display that is far from gold
/// while *claiming to follow* is catastrophic; the same distance while
/// holding/searching is a recovery problem, not false confidence.
#[derive(Debug, Clone, Copy)]
struct DisplaySample {
    position: f64,
    state: Option<cc_align::TrackingState>,
}

/// Latest snapshot at or before `t`, extrapolated by its own rate/caps — the
/// same pure function the stage motion layer uses.
fn display_at(replay: &ReplayResult, t: f64, cursor: &mut usize) -> DisplaySample {
    while *cursor + 1 < replay.snapshots.len()
        && replay.snapshots[*cursor + 1].at_audio_ms <= t
    {
        *cursor += 1;
    }
    if replay.snapshots.is_empty() {
        return DisplaySample {
            position: 0.0,
            state: None,
        };
    }
    let snap = &replay.snapshots[*cursor];
    if snap.at_audio_ms > t {
        // Before the first snapshot: nothing displayed yet.
        return DisplaySample {
            position: 0.0,
            state: None,
        };
    }
    DisplaySample {
        position: snap.display_at(t),
        state: Some(snap.state),
    }
}

pub fn evaluate(
    run: &str,
    scenario: &str,
    gold: &GoldTimeline,
    replay: &ReplayResult,
    performance_text: Option<&str>,
) -> RunEval {
    let mut m = RunMetrics {
        run: run.to_string(),
        scenario: scenario.to_string(),
        ..Default::default()
    };
    let mut samples = RunSamples::default();

    // ---- gold discontinuities & recovery events ----
    let mut recovery_targets: Vec<(RecoveryKind, f64)> = Vec::new();
    let mut gold_jumps: Vec<(f64, f64)> = Vec::new(); // (t, signed size)
    {
        let mut last_pos: Option<f64> = None;
        let mut off_run = 0usize;
        let mut first_script_seen = false;
        for w in &gold.words {
            match w.gold.span() {
                Some((span_start, span_end)) => {
                    let start_pos = span_start;
                    if !first_script_seen {
                        recovery_targets.push((RecoveryKind::Initial, w.start_ms));
                        first_script_seen = true;
                    } else if let Some(prev) = last_pos {
                        let delta = start_pos - prev;
                        if delta.abs() > GOLD_JUMP_ATOMS {
                            gold_jumps.push((w.start_ms, delta));
                            recovery_targets.push((
                                if delta > 0.0 {
                                    RecoveryKind::SkipForward
                                } else {
                                    RecoveryKind::Retake
                                },
                                w.start_ms,
                            ));
                        } else if off_run >= 4 {
                            recovery_targets.push((RecoveryKind::AdlibReturn, w.start_ms));
                        }
                    }
                    last_pos = Some(span_end);
                    off_run = 0;
                }
                None => {
                    off_run += 1;
                }
            }
        }
    }

    // ---- recoveries (computed first: the initial lock time gates which
    // samples count toward accuracy) ----
    let total = gold.total_ms;
    let mut recoveries = Vec::new();
    for &(kind, at) in &recovery_targets {
        let mut cursor = 0usize;
        let mut recovered: Option<f64> = None;
        let mut t = at;
        'outer: while t <= total {
            if let Some(point) = gold.position_at(t) {
                if point.on_script {
                    let sample = display_at(replay, t, &mut cursor);
                    let err = (sample.position - point.position).abs();
                    let following =
                        matches!(sample.state, Some(cc_align::TrackingState::Following));
                    if err <= RECOVER_HIT_ATOMS && following {
                        let mut hold_cursor = cursor;
                        let mut ht = t + SAMPLE_MS;
                        let mut ok = true;
                        while ht <= (t + RECOVER_SUSTAIN_MS).min(total) {
                            if let Some(hp) = gold.position_at(ht) {
                                if hp.on_script {
                                    let herr = (display_at(replay, ht, &mut hold_cursor)
                                        .position
                                        - hp.position)
                                        .abs();
                                    if herr > RECOVER_HOLD_ATOMS {
                                        ok = false;
                                        break;
                                    }
                                }
                            }
                            ht += SAMPLE_MS;
                        }
                        if ok {
                            recovered = Some((t - at) / 1000.0);
                            break 'outer;
                        }
                    }
                }
            }
            t += SAMPLE_MS;
        }
        recoveries.push(RecoveryEvent {
            kind,
            at_ms: at,
            recovered_in_s: recovered,
        });
    }

    // Accuracy counts from the moment the first lock lands. Before that
    // there is no position to be accurate about — lock latency is its own
    // benchmark, and letting a cold start pollute p95 turns every
    // start-in-the-middle run into a fake 100-atom error.
    let accuracy_from_ms = recoveries
        .iter()
        .find(|r| r.kind == RecoveryKind::Initial)
        .map(|r| match r.recovered_in_s {
            Some(rec) => r.at_ms + rec * 1000.0,
            None => f64::INFINITY,
        })
        .unwrap_or(0.0);

    // ---- re-spelling windows ----
    // Maximal runs of consecutive respelled words, each extended by the tail.
    let mut spans: Vec<(f64, f64)> = Vec::new();
    for w in &gold.words {
        if !w.respelled {
            continue;
        }
        match spans.last_mut() {
            Some(last) if w.start_ms <= last.1 => last.1 = w.end_ms + SPAN_TAIL_MS,
            _ => spans.push((w.start_ms, w.end_ms + SPAN_TAIL_MS)),
        }
    }
    let mut span_cursor = 0usize;
    let mut span_eligible = 0usize;
    let mut span_within2 = 0usize;
    let mut span_within5 = 0usize;

    // ---- uniform sampling ----
    let mut cursor = 0usize;
    let mut freeze_cursor = 0usize;
    let mut eligible = 0usize;
    let mut within2 = 0usize;
    let mut within5 = 0usize;
    let mut freeze_eligible = 0usize;
    let mut frozen = 0usize;
    let mut adlib_drift: Option<f64> = None;
    let mut catastrophic_run_ms = 0.0;
    let mut catastrophic_periods = 0u32;
    let mut in_catastrophic = false;
    let mut ahead_eligible = 0usize;
    let mut ahead_samples = 0usize;
    let mut ahead_events = 0u32;
    let mut ahead_worst = f64::NEG_INFINITY;
    let mut ahead_run_ms = 0.0;
    let mut in_ahead = false;
    // Furthest word the reader has ever finished — the fade frontier's ceiling.
    let mut heard_max = f64::NEG_INFINITY;

    // Motion sampling runs on its own cursor because it needs the PREVIOUS
    // sample to have been eligible too — a velocity computed across the moment
    // the reader started speaking measures the boundary, not the motion.
    // (t, display) of the last motion-eligible sample; None breaks the chain.
    let mut motion_prev: Option<(f64, f64)> = None;
    // (t, atoms/second) per eligible interval. Stalls need the run median, so
    // they are found in a second pass once the median exists.
    let mut velocity_series: Vec<(f64, f64)> = Vec::new();

    let mut display_prev_sample: Option<(f64, f64)> = None; // (t, display)
    // (t, signed delta, |display − gold| right after the jump)
    let mut display_jumps: Vec<(f64, f64, f64)> = Vec::new();

    let mut t = 0.0;
    while t <= total {
        let Some(point) = gold.position_at(t) else {
            t += SAMPLE_MS;
            continue;
        };
        let sample = display_at(replay, t, &mut cursor);
        let display = sample.position;

        // Display jump detection runs on every sample.
        if let Some((_pt, pd)) = display_prev_sample {
            let delta = display - pd;
            if delta.abs() > JUMP_ATOMS {
                display_jumps.push((t, delta, (display - point.position).abs()));
            }
        }
        display_prev_sample = Some((t, display));

        // ---- smoothness: the derivative of the path ----
        if point.on_script && point.speaking && t >= accuracy_from_ms {
            if let Some((pt, pd)) = motion_prev {
                let dt_ms = t - pt;
                let delta = display - pd;
                // Adjacent grid samples only, and never across a relocation:
                // a jump is a deliberate discontinuity that `false_jumps` and
                // the recovery metrics already own, and folding it in here
                // would report a 200 atoms/second "surge" as jerk.
                if (dt_ms - SAMPLE_MS).abs() < 1.0 && delta.abs() <= JUMP_ATOMS {
                    velocity_series.push((t, delta * 1000.0 / dt_ms));
                }
            }
            motion_prev = Some((t, display));
        } else {
            motion_prev = None;
        }

        // Inside the window after a gold discontinuity the engine is entitled
        // to be wrong: accepting a jump takes evidence and persistence rounds
        // by design, and the recovery metrics are what measure that.
        let in_grace = gold_jumps
            .iter()
            .any(|&(gt, _)| t >= gt && t < gt + DISCONTINUITY_GRACE_MS);

        // ---- catastrophic wrongness: NOT gated on first lock ----
        // A wrong early lock that claims Following must count; before any
        // lock the engine reports Searching, which never counts. Grace
        // applies only around gold discontinuities (their acceptance takes
        // persistence rounds by design) — not around the initial lock or
        // ad-lib returns.
        if point.on_script && point.speaking {
            let err = display - point.position;
            let claiming_follow =
                matches!(sample.state, Some(cc_align::TrackingState::Following));
            if err.abs() > CATASTROPHIC_ATOMS && !in_grace && claiming_follow {
                catastrophic_run_ms += SAMPLE_MS;
                if catastrophic_run_ms >= CATASTROPHIC_SUSTAIN_MS && !in_catastrophic {
                    catastrophic_periods += 1;
                    in_catastrophic = true;
                }
            } else {
                catastrophic_run_ms = 0.0;
                in_catastrophic = false;
            }
        } else {
            // A pause must not bridge two short wrong stretches into one
            // "sustained" period.
            catastrophic_run_ms = 0.0;
            in_catastrophic = false;
        }

        // ---- overshoot: ahead of what has actually been SAID ----
        // Speaking and paused alike — a fade frontier that runs ahead is the
        // same failure either way, and the pause is simply where it is most
        // likely to happen.
        //
        // No grace window and no `speaking` gate: a display that has faded
        // past everything ever spoken is wrong in a pause, wrong mid-word, and
        // wrong while recovering from a jump. The high-water reference is what
        // makes that fair — see the constants above.
        if point.on_script {
            heard_max = heard_max.max(point.position.floor());
        }
        if point.on_script && t >= accuracy_from_ms {
            let over = display - heard_max;
            samples.ahead.push(over);
            ahead_eligible += 1;
            ahead_worst = ahead_worst.max(over);
            if over > AHEAD_TOLERANCE_ATOMS {
                ahead_samples += 1;
            }
            if over > AHEAD_EVENT_ATOMS {
                ahead_run_ms += SAMPLE_MS;
                if ahead_run_ms >= AHEAD_EVENT_SUSTAIN_MS && !in_ahead {
                    ahead_events += 1;
                    in_ahead = true;
                }
            } else {
                ahead_run_ms = 0.0;
                in_ahead = false;
            }
        }

        // Re-spelling windows are scored on their own gate: speaking OR
        // paused. The tail exists to ask whether the display CAUGHT UP after a
        // figure, and the reader is most often silent while it does — a comma,
        // a breath, the end of the sentence. Scoring only while a word is in
        // the mouth threw away exactly the samples the `asr_forms_pauses`
        // scenario was built to produce.
        if point.on_script && t >= accuracy_from_ms {
            while span_cursor < spans.len() && spans[span_cursor].1 < t {
                span_cursor += 1;
            }
            if spans.get(span_cursor).is_some_and(|s| t >= s.0 && t <= s.1) {
                let err = (display - point.position).abs();
                span_eligible += 1;
                samples.span_abs.push(err);
                if err <= 2.0 {
                    span_within2 += 1;
                }
                if err <= 5.0 {
                    span_within5 += 1;
                }
            }
        }

        if point.on_script && point.speaking && t >= accuracy_from_ms {
            let err = display - point.position;
            eligible += 1;
            samples.abs_err.push(err.abs());
            samples.signed_err.push(err);
            if err.abs() <= 2.0 {
                within2 += 1;
            }
            if err.abs() <= 5.0 {
                within5 += 1;
            }


            // Freeze: gold moved, display did not.
            if t >= FREEZE_WINDOW_MS {
                let t0 = t - FREEZE_WINDOW_MS;
                if let Some(prev_point) = gold.position_at(t0) {
                    if prev_point.on_script {
                        let gold_moved = point.position - prev_point.position;
                        let display_then = display_at(replay, t0, &mut freeze_cursor).position;
                        let display_moved = display - display_then;
                        if gold_moved >= FREEZE_GOLD_ATOMS {
                            freeze_eligible += 1;
                            if display_moved.abs() < FREEZE_DISPLAY_ATOMS {
                                frozen += 1;
                            }
                        }
                    }
                }
            }

        } else if point.on_script && !point.speaking && t >= accuracy_from_ms {
            // The reader is PAUSED: gold holds at the last spoken word.
            // Positive lead = the display ran ahead during the pause.
            samples.pause_lead.push(display - point.position);
        } else if !point.on_script {
            // Ad-lib hold behaviour.
            let drift = (display - point.position).abs();
            adlib_drift = Some(adlib_drift.map_or(drift, |d: f64| d.max(drift)));
        }
        t += SAMPLE_MS;
    }

    // ---- smoothness ----
    // Second pass: a stall is defined relative to the run's own median pace,
    // which does not exist until the whole series does.
    let mut stalls = 0u32;
    let mut motion_stationary = 0usize;
    let mut surge_p95 = 0.0;
    let vel_median = percentile(
        &mut velocity_series.iter().map(|(_, v)| *v).collect::<Vec<_>>(),
        50.0,
    );
    if !velocity_series.is_empty() {
        let floor = mean(&velocity_series.iter().map(|(_, v)| *v).collect::<Vec<_>>())
            * STALL_FRACTION;
        let mut stall_run_ms = 0.0;
        let mut in_stall = false;
        let mut prev: Option<(f64, f64)> = None;
        let mut surges: Vec<f64> = Vec::new();
        for &(vt, v) in &velocity_series {
            if v < STATIONARY_ATOMS_S {
                motion_stationary += 1;
            }
            // A run of samples is only a sustained stall if the samples are
            // actually adjacent; a gap means the reader stopped speaking in
            // between, and rest is not a stall.
            let contiguous = prev.is_some_and(|(pt, _)| (vt - pt - SAMPLE_MS).abs() < 1.0);
            if !contiguous {
                stall_run_ms = 0.0;
                in_stall = false;
            } else if let Some((_, pv)) = prev {
                surges.push((v - pv).abs());
            }
            if v < floor {
                stall_run_ms += SAMPLE_MS;
                if stall_run_ms >= STALL_SUSTAIN_MS && !in_stall {
                    stalls += 1;
                    in_stall = true;
                }
            } else {
                stall_run_ms = 0.0;
                in_stall = false;
            }
            prev = Some((vt, v));
        }
        surge_p95 = percentile(&mut surges, 95.0);
    }
    samples.velocity = velocity_series.iter().map(|(_, v)| *v).collect();

    // ---- false jumps ----
    // A display jump is legitimate if (a) it lands close to where the reader
    // actually is — a LATE jump to the RIGHT place is a recovery-speed
    // problem, not a safety problem; (b) a gold discontinuity of the same
    // sign happened nearby; or (c) it is the initial lock from position 0.
    let mut false_jumps = 0u32;
    for &(jt, jd, err_after) in &display_jumps {
        if err_after <= RECOVER_HOLD_ATOMS {
            continue; // landed on the reader — a late-but-correct move
        }
        // A sign-matched gold discontinuity (or the initial lock) excuses a
        // jump ONLY if it also landed near the reader's actual region — a
        // +400-atom leap during a +50-atom gold skip is still false.
        let landed_close = err_after <= CATASTROPHIC_ATOMS;
        let matched = gold_jumps.iter().any(|&(gt, gd)| {
            (jt - gt).abs() <= JUMP_MATCH_WINDOW_MS && gd.signum() == jd.signum()
        });
        let initial = recovery_targets
            .iter()
            .any(|(k, at)| *k == RecoveryKind::Initial && (jt - at).abs() <= JUMP_MATCH_WINDOW_MS);
        if !((matched || initial) && landed_close) {
            false_jumps += 1;
        }
    }

    // ---- pre-final movement ----
    let big_items: Vec<_> = replay
        .items
        .iter()
        .filter(|i| i.final_content_words >= 8 && i.had_partial)
        .collect();
    let prefinal = if big_items.is_empty() {
        None
    } else {
        let moved = big_items
            .iter()
            .filter(|i| i.observed_at_last_partial > i.observed_at_item_start + 1.0)
            .count();
        Some(100.0 * moved as f64 / big_items.len() as f64)
    };

    // ---- WER (diagnostic) ----
    m.wer_pct = performance_text.map(|said| {
        let reference = cc_align::normalize::canonical_atoms(said);
        let hypothesis = cc_align::normalize::canonical_atoms(&replay.final_text);
        if reference.is_empty() {
            return 0.0;
        }
        100.0 * token_edit_distance(&reference, &hypothesis) as f64 / reference.len() as f64
    });

    // ---- summarise ----
    m.on_script_s = eligible as f64 * SAMPLE_MS / 1000.0;
    m.eligible_samples = eligible;
    m.within2_hits = within2;
    m.within5_hits = within5;
    m.freeze_frozen = frozen;
    m.freeze_eligible = freeze_eligible;
    m.prefinal_moved = big_items
        .iter()
        .filter(|i| i.observed_at_last_partial > i.observed_at_item_start + 1.0)
        .count();
    m.prefinal_total = big_items.len();
    m.within2_pct = pct(within2, eligible);
    m.within5_pct = pct(within5, eligible);
    m.p50_abs = percentile(&mut samples.abs_err.clone(), 50.0);
    m.p95_abs = percentile(&mut samples.abs_err.clone(), 95.0);
    m.mean_signed = mean(&samples.signed_err);
    m.freeze_pct = pct(frozen, freeze_eligible);
    m.false_jumps = false_jumps;
    m.catastrophic = catastrophic_periods;
    m.recoveries = recoveries;
    m.adlib_max_drift = adlib_drift;
    m.pause_overshoot_p95 = if samples.pause_lead.is_empty() {
        None
    } else {
        Some(percentile(&mut samples.pause_lead.clone(), 95.0))
    };
    m.ahead_eligible = ahead_eligible;
    m.ahead_samples = ahead_samples;
    m.ahead_pct = pct(ahead_samples, ahead_eligible);
    m.ahead_s = ahead_samples as f64 * SAMPLE_MS / 1000.0;
    m.ahead_events = ahead_events;
    m.ahead_worst = if ahead_worst.is_finite() {
        Some(ahead_worst)
    } else {
        None
    };
    m.prefinal_move_pct = prefinal;
    m.span_eligible = span_eligible;
    m.span_within2 = span_within2;
    m.span_within5 = span_within5;
    m.motion_eligible = samples.velocity.len();
    m.motion_stationary = motion_stationary;
    m.stationary_pct = pct(motion_stationary, samples.velocity.len());
    m.vel_p10 = percentile(&mut samples.velocity.clone(), 10.0);
    m.vel_p50 = vel_median;
    m.vel_p90 = percentile(&mut samples.velocity.clone(), 90.0);
    m.vel_cov = {
        let mu = mean(&samples.velocity);
        if mu.abs() < f64::EPSILON {
            0.0
        } else {
            let var = mean(
                &samples
                    .velocity
                    .iter()
                    .map(|v| (v - mu).powi(2))
                    .collect::<Vec<_>>(),
            );
            var.sqrt() / mu
        }
    };
    m.stalls = stalls;
    m.surge_p95 = surge_p95;
    m.event_count = replay.event_us.len();
    m.mean_event_us = mean(&replay.event_us.iter().map(|v| *v as f64).collect::<Vec<_>>());
    m.p95_event_us = {
        let mut v = replay.event_us.clone();
        v.sort_unstable();
        v.get((v.len() as f64 * 0.95) as usize)
            .copied()
            .or(v.last().copied())
            .unwrap_or(0)
    };

    RunEval {
        metrics: m,
        samples,
    }
}

fn pct(hit: usize, total: usize) -> f64 {
    if total == 0 {
        0.0
    } else {
        100.0 * hit as f64 / total as f64
    }
}

pub fn mean(v: &[f64]) -> f64 {
    if v.is_empty() {
        0.0
    } else {
        v.iter().sum::<f64>() / v.len() as f64
    }
}

pub fn percentile(v: &mut [f64], p: f64) -> f64 {
    if v.is_empty() {
        // An empty sample set has no percentile; 0.0 would read as a
        // perfect score on lower-is-better rows.
        return f64::NAN;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let idx = ((v.len() as f64 - 1.0) * p / 100.0).round() as usize;
    v[idx.min(v.len() - 1)]
}

/// Token-level Levenshtein distance (WER numerator).
pub fn token_edit_distance(a: &[String], b: &[String]) -> usize {
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0usize; b.len() + 1];
    for (i, ta) in a.iter().enumerate() {
        cur[0] = i + 1;
        for (j, tb) in b.iter().enumerate() {
            let cost = usize::from(ta != tb);
            cur[j + 1] = (prev[j] + cost).min(prev[j + 1] + 1).min(cur[j] + 1);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}
