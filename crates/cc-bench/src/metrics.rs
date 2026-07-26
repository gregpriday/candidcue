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

use crate::plan::{GoldTag, GoldTimeline};
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
    /// % of ≥8-content-word items whose display moved before the final.
    pub prefinal_move_pct: Option<f64>,
    pub event_count: usize,
    pub mean_event_us: f64,
    pub p95_event_us: u64,
    /// Diagnostic WER of the final transcripts vs what was actually said.
    pub wer_pct: Option<f64>,
}

/// Raw per-sample data kept for suite-level pooling (not serialised).
#[derive(Debug, Default)]
pub struct RunSamples {
    pub abs_err: Vec<f64>,
    pub signed_err: Vec<f64>,
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
            match &w.gold {
                GoldTag::Script { pos_after } => {
                    let start_pos = *pos_after as f64 - 1.0;
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
                    last_pos = Some(*pos_after as f64);
                    off_run = 0;
                }
                GoldTag::Off { .. } => {
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
                            if display_moved < FREEZE_DISPLAY_ATOMS {
                                frozen += 1;
                            }
                        }
                    }
                }
            }

            // Catastrophic wrongness: far from gold while CLAIMING to follow,
            // outside grace windows. A stale hold (Holding/Searching) is a
            // recovery failure, not false confidence — recovery metrics own
            // that.
            let in_grace = recovery_targets
                .iter()
                .any(|(_, at)| t >= *at && t < *at + DISCONTINUITY_GRACE_MS)
                || recovery_targets
                    .first()
                    .map(|(_, at)| t < *at + DISCONTINUITY_GRACE_MS)
                    .unwrap_or(false);
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
        } else if !point.on_script {
            // Ad-lib hold behaviour.
            let drift = (display - point.position).abs();
            adlib_drift = Some(adlib_drift.map_or(drift, |d: f64| d.max(drift)));
        }
        t += SAMPLE_MS;
    }

    // ---- false jumps ----
    // A display jump is legitimate if (a) it lands close to where the reader
    // actually is — a LATE jump to the RIGHT place is a recovery-speed
    // problem, not a safety problem; (b) a gold discontinuity of the same
    // sign happened nearby; or (c) it is the initial lock from position 0.
    let mut false_jumps = 0u32;
    for &(jt, jd, err_after) in &display_jumps {
        if err_after <= RECOVER_HOLD_ATOMS {
            continue;
        }
        let matched = gold_jumps.iter().any(|&(gt, gd)| {
            (jt - gt).abs() <= JUMP_MATCH_WINDOW_MS && gd.signum() == jd.signum()
        });
        let initial = recovery_targets
            .iter()
            .any(|(k, at)| *k == RecoveryKind::Initial && (jt - at).abs() <= JUMP_MATCH_WINDOW_MS);
        if !matched && !initial {
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
    m.prefinal_move_pct = prefinal;
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

fn mean(v: &[f64]) -> f64 {
    if v.is_empty() {
        0.0
    } else {
        v.iter().sum::<f64>() / v.len() as f64
    }
}

pub fn percentile(v: &mut [f64], p: f64) -> f64 {
    if v.is_empty() {
        return 0.0;
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
