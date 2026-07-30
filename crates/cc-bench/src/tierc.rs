//! Tier C orchestration: replay → render → score, across the layout sweep.
//!
//! Pooling rule (§17): metrics are computed PER RUN and then macro-averaged
//! across scenarios, never pooled frame-by-frame across the whole suite. At
//! 60 Hz a nine-minute `longform` read contributes 32,000 frames and a
//! 40-second `retake` contributes 2,400, so a frame-pooled average is a report
//! about `longform` with the interesting scenarios as rounding error. Raw sample
//! pools are still kept for the percentile rows, where the question genuinely is
//! "of all the words a presenter said, how long did the median one take" — but
//! the rate and percentage rows macro-average.

use std::collections::BTreeMap;

use cc_align::AlignmentConfig;
use serde::{Deserialize, Serialize};

use crate::metrics::RecoveryKind;
use crate::passgold::PassGold;
use crate::perceptual::{
    evaluate_perceptual, mad, mean_of, pctl, PerceptualMetrics, PerceptualSamples,
};
use crate::plan::{expand, synthetic_timing, GoldTimeline};
use crate::stage::{default_layouts, render, Layout};
use crate::suite::{BenchEntry, RunManifest};
use crate::synthetic::generate_events;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TierCResult {
    pub label: String,
    pub config: AlignmentConfig,
    pub table: Vec<BenchEntry>,
    pub runs: Vec<PerceptualMetrics>,
    /// Per-layout headline rows, so a controller that only works at 60 Hz is
    /// visible rather than averaged away.
    pub by_layout: BTreeMap<String, Vec<BenchEntry>>,
}

fn entry(name: &str, value: f64, unit: &str, better: &str) -> BenchEntry {
    BenchEntry {
        name: name.to_string(),
        value,
        unit: unit.to_string(),
        better: better.to_string(),
    }
}

/// The layouts scored for the headline table.
///
/// The headline is the reference 60 Hz rig; every other layout is reported in
/// `by_layout` and gated on the safety rows. Averaging seven layouts into one
/// number would let a 30 Hz failure be paid for by a 120 Hz success, and a
/// presenter only ever has one panel.
const HEADLINE_LAYOUT: &str = "60hz";

/// Score one replayed run through the stage model at every layout.
fn score_run(
    name: &str,
    scenario: &str,
    script: &cc_align::CompiledScript,
    gold: &GoldTimeline,
    replay: &crate::replay::ReplayResult,
    layouts: &[Layout],
    out: &mut Vec<PerceptualMetrics>,
    pools: &mut PerceptualSamples,
    headline_pools: &mut PerceptualSamples,
) {
    let pass = PassGold::derive(gold);
    // Accuracy starts at the first lock, for the same reason `metrics.rs` does
    // it: before then there is no position to judge and a cold start would post
    // a fake 100-atom error in every percentile.
    let from_ms = first_lock_ms(gold, replay);

    for layout in layouts {
        let trace = render(script, replay, layout);
        let eval = evaluate_perceptual(name, scenario, &pass, &trace, from_ms);
        merge(pools, &eval.samples);
        if layout.name == HEADLINE_LAYOUT {
            merge(headline_pools, &eval.samples);
        }
        out.push(eval.metrics);
    }
}

/// When the engine first got within 3 atoms of the reader and claimed to follow.
fn first_lock_ms(gold: &GoldTimeline, replay: &crate::replay::ReplayResult) -> f64 {
    let Some(first) = gold.words.iter().find(|w| w.gold.span().is_some()) else {
        return 0.0;
    };
    let mut t = first.start_ms;
    let mut cursor = 0usize;
    while t <= gold.total_ms {
        while cursor + 1 < replay.snapshots.len()
            && replay.snapshots[cursor + 1].at_audio_ms <= t
        {
            cursor += 1;
        }
        if let (Some(point), Some(snap)) = (gold.position_at(t), replay.snapshots.get(cursor)) {
            if point.on_script
                && snap.at_audio_ms <= t
                && matches!(snap.state, cc_align::TrackingState::Following)
                && (snap.display_at(t) - point.position).abs() <= 3.0
            {
                return t;
            }
        }
        t += 50.0;
    }
    // Never locked. Scoring from zero would blame the perceptual metrics for a
    // tracking failure the tracking table already reports.
    0.0
}

fn merge(into: &mut PerceptualSamples, from: &PerceptualSamples) {
    into.temporal_err_ms.extend_from_slice(&from.temporal_err_ms);
    into.first_response_ms.extend_from_slice(&from.first_response_ms);
    into.half_dim_ms.extend_from_slice(&from.half_dim_ms);
    into.committed_dim_ms.extend_from_slice(&from.committed_dim_ms);
    into.premature_ms.extend_from_slice(&from.premature_ms);
    into.band_err_lines.extend_from_slice(&from.band_err_lines);
    into.future_reserve_lines
        .extend_from_slice(&from.future_reserve_lines);
    into.handoff_err_lines.extend_from_slice(&from.handoff_err_lines);
    into.plant_err_lines.extend_from_slice(&from.plant_err_lines);
    into.pulse.extend_from_slice(&from.pulse);
    into.disruption_ms.extend_from_slice(&from.disruption_ms);
    into.survival_ms.extend_from_slice(&from.survival_ms);
    into.readable_recovery_ms
        .extend_from_slice(&from.readable_recovery_ms);
    into.freshness_ms.extend_from_slice(&from.freshness_ms);
    into.calibration.extend_from_slice(&from.calibration);
    into.eta_v.extend_from_slice(&from.eta_v);
}

/// Tier C over the synthetic Tier-A corpus.
pub fn run_tier_c(
    scripts_dir: &std::path::Path,
    config: &AlignmentConfig,
    label: &str,
    layouts: &[Layout],
) -> anyhow::Result<TierCResult> {
    let suite = crate::scenarios::build_suite(scripts_dir)?;
    let mut runs = Vec::new();
    let mut pools = PerceptualSamples::default();
    let mut headline = PerceptualSamples::default();

    for scenario in &suite {
        let performance = expand(&scenario.plan, &scenario.script);
        let gold = synthetic_timing(&performance, scenario.wpm);
        let events = generate_events(&gold, &scenario.plan.corruption, scenario.plan.seed);
        let replay = crate::replay::replay(
            scenario.script.clone(),
            config.clone(),
            &events,
            &gold.viewport_hints,
        );
        score_run(
            &scenario.plan.name,
            &scenario.plan.scenario,
            &scenario.script,
            &gold,
            &replay,
            layouts,
            &mut runs,
            &mut pools,
            &mut headline,
        );
    }

    Ok(finish(label, config, runs, headline, pools))
}

/// Tier C over captured live fixtures — the same stage model, real recogniser
/// output. This is the configuration closest to a real take that anything
/// automated on this machine can reach.
pub fn run_tier_c_captured(
    runs_dir: &std::path::Path,
    scripts_dir: &std::path::Path,
    config: &AlignmentConfig,
    label: &str,
    layouts: &[Layout],
) -> anyhow::Result<TierCResult> {
    let mut runs = Vec::new();
    let mut pools = PerceptualSamples::default();
    let mut headline = PerceptualSamples::default();

    let mut dirs: Vec<_> = std::fs::read_dir(runs_dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();
    anyhow::ensure!(!dirs.is_empty(), "no captured runs in {}", runs_dir.display());

    for dir in dirs {
        let manifest: RunManifest =
            serde_json::from_str(&std::fs::read_to_string(dir.join("manifest.json"))?)?;
        let gold: GoldTimeline =
            serde_json::from_str(&std::fs::read_to_string(dir.join("gold.json"))?)?;
        let events = crate::capture::read_events_jsonl(&dir.join("events.jsonl"))?;
        let source = std::fs::read_to_string(scripts_dir.join(format!("{}.md", manifest.script)))?;
        let script = cc_align::compile(&source, cc_align::CompileOptions::default());
        if let Some(captured) = manifest.atom_count {
            anyhow::ensure!(
                captured == script.len(),
                "{}: {} compiles to {} atoms now, {} when captured — its gold is in \
                 atom indexes, so Tier C would score the stage against the wrong words.",
                manifest.name,
                manifest.script,
                script.len(),
                captured,
            );
        }
        let replay = crate::replay::replay(script.clone(), config.clone(), &events, &gold.viewport_hints);
        score_run(
            &manifest.name,
            &manifest.scenario,
            &script,
            &gold,
            &replay,
            layouts,
            &mut runs,
            &mut pools,
            &mut headline,
        );
    }

    Ok(finish(label, config, runs, headline, pools))
}

/// Macro-average a per-run field over the headline layout.
fn macro_avg(runs: &[PerceptualMetrics], f: impl Fn(&PerceptualMetrics) -> f64) -> f64 {
    let v: Vec<f64> = runs
        .iter()
        .filter(|r| r.layout == HEADLINE_LAYOUT)
        .map(&f)
        .filter(|x| x.is_finite())
        .collect();
    mean_of(&v)
}

fn total_u32(runs: &[PerceptualMetrics], f: impl Fn(&PerceptualMetrics) -> u32) -> f64 {
    runs.iter()
        .filter(|r| r.layout == HEADLINE_LAYOUT)
        .map(|r| f(r) as f64)
        .sum()
}

/// Every-layout total: a safety row must hold on all seven rigs, not on the one
/// the headline happens to use.
fn total_u32_all(runs: &[PerceptualMetrics], f: impl Fn(&PerceptualMetrics) -> u32) -> f64 {
    runs.iter().map(|r| f(r) as f64).sum()
}

fn finish(
    label: &str,
    config: &AlignmentConfig,
    runs: Vec<PerceptualMetrics>,
    headline: PerceptualSamples,
    _all: PerceptualSamples,
) -> TierCResult {
    let mut t = Vec::new();

    // ---- SAFETY GATES (§16.1). Not weighted; gated. ----
    t.push(entry(
        "gate.unread_never_spoken",
        macro_avg(&runs, |r| r.unread_never_spoken),
        "word·s",
        "lower",
    ));
    t.push(entry(
        "gate.fce_10_pct",
        macro_avg(&runs, |r| r.fce_10_pct),
        "%",
        "lower",
    ));
    t.push(entry(
        "gate.fce_episodes",
        total_u32_all(&runs, |r| r.fce_episodes),
        "count",
        "lower",
    ));
    t.push(entry(
        "gate.visible_relocation",
        macro_avg(&runs, |r| r.visible_relocation_lines),
        "lines",
        "lower",
    ));
    t.push(entry(
        "gate.readable_recovery_failures",
        total_u32_all(&runs, |r| r.readable_recovery_failures),
        "count",
        "lower",
    ));

    // ---- HOLISTIC OUTCOMES (§3) ----
    t.push(entry(
        "outcome.readable_availability",
        macro_avg(&runs, |r| r.readable_availability),
        "%",
        "higher",
    ));
    t.push(entry(
        "outcome.disruptions_per_10min",
        macro_avg(&runs, |r| r.disruptions_per_10min),
        "count",
        "lower",
    ));
    t.push(entry(
        "outcome.disruption_p95_ms",
        pctl(&headline.disruption_ms, 95.0),
        "ms",
        "lower",
    ));
    t.push(entry(
        "outcome.disruption_max_ms",
        runs.iter()
            .filter(|r| r.layout == HEADLINE_LAYOUT)
            .map(|r| r.disruption_max_ms)
            .fold(0.0, f64::max),
        "ms",
        "lower",
    ));
    t.push(entry(
        "outcome.longest_clean_s",
        macro_avg(&runs, |r| r.longest_clean_ms / 1000.0),
        "s",
        "higher",
    ));
    // §3.2 survival: the fraction of takes that reached a milestone with nothing
    // conspicuous having happened. Closer to how trust actually develops than any
    // average — one visible problem in a 20-minute take matters more than
    // thousands of well-scored frames.
    for (name, horizon) in [("survive_60s", 60_000.0), ("survive_180s", 180_000.0)] {
        let takes: Vec<&Option<f64>> = headline.survival_ms.iter().collect();
        let survived = takes
            .iter()
            .filter(|s| s.map(|v| v > horizon).unwrap_or(true))
            .count();
        t.push(entry(
            &format!("outcome.{name}"),
            if takes.is_empty() {
                f64::NAN
            } else {
                100.0 * survived as f64 / takes.len() as f64
            },
            "%",
            "higher",
        ));
    }
    t.push(entry(
        "outcome.zero_disruption_takes",
        {
            let takes = runs.iter().filter(|r| r.layout == HEADLINE_LAYOUT).count();
            let clean = runs
                .iter()
                .filter(|r| r.layout == HEADLINE_LAYOUT && r.disruptions == 0)
                .count();
            if takes == 0 {
                f64::NAN
            } else {
                100.0 * clean as f64 / takes as f64
            }
        },
        "%",
        "higher",
    ));

    // ---- OPACITY (§4) ----
    t.push(entry(
        "ink.first_response_p50",
        pctl(&headline.first_response_ms, 50.0),
        "ms",
        "lower",
    ));
    t.push(entry(
        "ink.first_response_p95",
        pctl(&headline.first_response_ms, 95.0),
        "ms",
        "lower",
    ));
    t.push(entry(
        "ink.half_dim_p50",
        pctl(&headline.half_dim_ms, 50.0),
        "ms",
        "lower",
    ));
    t.push(entry(
        "ink.half_dim_p95",
        pctl(&headline.half_dim_ms, 95.0),
        "ms",
        "lower",
    ));
    t.push(entry(
        "ink.committed_dim_p50",
        pctl(&headline.committed_dim_ms, 50.0),
        "ms",
        "lower",
    ));
    t.push(entry(
        "ink.committed_dim_p95",
        pctl(&headline.committed_dim_ms, 95.0),
        "ms",
        "lower",
    ));
    // Consistency, not only speed: a steady 250 ms reads better than an average
    // of 250 that alternates 50 and 700, and percentiles cannot say so.
    t.push(entry("ink.dim_mad", mad(&headline.half_dim_ms), "ms", "lower"));
    t.push(entry(
        "ink.dim_spread_p95_p50",
        pctl(&headline.half_dim_ms, 95.0) - pctl(&headline.half_dim_ms, 50.0),
        "ms",
        "lower",
    ));
    t.push(entry(
        "ink.premature_p05",
        pctl(&headline.premature_ms, 5.0),
        "ms",
        "higher",
    ));
    t.push(entry(
        "ink.dim_never",
        total_u32(&runs, |r| r.dim_never as u32),
        "count",
        "lower",
    ));
    t.push(entry(
        "ink.unread_exposure",
        macro_avg(&runs, |r| r.uie_mean),
        "words",
        "lower",
    ));
    t.push(entry(
        "ink.unread_incidents",
        total_u32(&runs, |r| r.uie_incidents),
        "count",
        "lower",
    ));
    t.push(entry(
        "ink.unread_max_darkness",
        runs.iter()
            .filter(|r| r.layout == HEADLINE_LAYOUT)
            .map(|r| r.uie_max_darkness)
            .fold(0.0, f64::max),
        "0-1",
        "lower",
    ));
    t.push(entry(
        "ink.spoken_retention",
        macro_avg(&runs, |r| r.sir_mean),
        "words",
        "lower",
    ));
    t.push(entry(
        "ink.retake_legibility_loss",
        macro_avg(&runs, |r| r.retake_legibility_loss),
        "word·s",
        "lower",
    ));
    t.push(entry(
        "ink.retake_bright_p95_ms",
        macro_avg(&runs, |r| r.retake_anchor_bright_p95_ms),
        "ms",
        "lower",
    ));
    t.push(entry(
        "ink.corrections_per_1k",
        macro_avg(&runs, |r| r.corrections_per_1k_words),
        "count",
        "lower",
    ));

    // ---- TEMPORAL (§5) ----
    t.push(entry(
        "time.lag_p50",
        pctl(&headline.temporal_err_ms, 50.0),
        "ms",
        "lower",
    ));
    t.push(entry(
        "time.lag_p95",
        pctl(&headline.temporal_err_ms, 95.0),
        "ms",
        "lower",
    ));
    t.push(entry(
        "time.lead_p05",
        pctl(&headline.temporal_err_ms, 5.0),
        "ms",
        "higher",
    ));
    t.push(entry("time.mad", mad(&headline.temporal_err_ms), "ms", "lower"));
    t.push(entry(
        "time.late_500_pct",
        macro_avg(&runs, |r| r.late_500_pct),
        "%",
        "lower",
    ));
    t.push(entry(
        "time.early_100_pct",
        macro_avg(&runs, |r| r.early_100_pct),
        "%",
        "lower",
    ));
    t.push(entry(
        "time.worst_lag_episode",
        runs.iter()
            .filter(|r| r.layout == HEADLINE_LAYOUT)
            .map(|r| r.worst_lag_episode_ms)
            .fold(0.0, f64::max),
        "ms",
        "lower",
    ));
    // The conditional slices. A single global p50 can hide a 900 ms delay on
    // every single resume after a pause, which is the moment a presenter is most
    // likely to look at the prompter and lose faith in it.
    t.push(entry(
        "time.lag_p50_after_pause",
        macro_avg(&runs, |r| r.lag_p50_after_pause),
        "ms",
        "lower",
    ));
    t.push(entry(
        "time.lag_p50_steady",
        macro_avg(&runs, |r| r.lag_p50_steady),
        "ms",
        "lower",
    ));
    t.push(entry(
        "time.lag_p50_opening",
        macro_avg(&runs, |r| r.lag_p50_opening),
        "ms",
        "lower",
    ));

    // ---- READING BAND (§6) ----
    t.push(entry(
        "band.occupancy",
        macro_avg(&runs, |r| r.band_occupancy_pct),
        "%",
        "higher",
    ));
    t.push(entry(
        "band.err_p95",
        pctl(&headline.band_err_lines, 95.0),
        "lines",
        "lower",
    ));
    t.push(entry(
        "band.out_1_line_pct",
        macro_avg(&runs, |r| r.out_full_line_pct),
        "%",
        "lower",
    ));
    t.push(entry(
        "band.out_episodes",
        total_u32(&runs, |r| r.out_of_band_episodes),
        "count",
        "lower",
    ));
    t.push(entry(
        "band.future_reserve_p05",
        pctl(&headline.future_reserve_lines, 5.0),
        "lines",
        "higher",
    ));
    t.push(entry(
        "band.future_reserve_min",
        runs.iter()
            .filter(|r| r.layout == HEADLINE_LAYOUT)
            .map(|r| r.future_reserve_min)
            .filter(|x| x.is_finite())
            .fold(f64::INFINITY, f64::min),
        "lines",
        "higher",
    ));
    t.push(entry(
        "band.starvation_events",
        total_u32(&runs, |r| r.future_starvation_events),
        "count",
        "lower",
    ));
    t.push(entry(
        "band.handoff_p95",
        pctl(&headline.handoff_err_lines, 95.0),
        "lines",
        "lower",
    ));

    // ---- MOTION (§7) ----
    t.push(entry(
        "motion.plant_err_p95",
        pctl(&headline.plant_err_lines, 95.0),
        "lines",
        "lower",
    ));
    t.push(entry(
        "motion.plant_err_max",
        runs.iter()
            .filter(|r| r.layout == HEADLINE_LAYOUT)
            .map(|r| r.plant_err_max)
            .fold(0.0, f64::max),
        "lines",
        "lower",
    ));
    t.push(entry(
        "motion.pulse_p50",
        pctl(&headline.pulse, 50.0),
        "lines/s²",
        "lower",
    ));
    t.push(entry(
        "motion.pulse_p95",
        pctl(&headline.pulse, 95.0),
        "lines/s²",
        "lower",
    ));
    t.push(entry(
        "motion.pulse_max",
        runs.iter()
            .filter(|r| r.layout == HEADLINE_LAYOUT)
            .map(|r| r.snapshot_pulse_max)
            .fold(0.0, f64::max),
        "lines/s²",
        "lower",
    ));
    t.push(entry(
        "motion.cadence_ripple",
        macro_avg(&runs, |r| r.cadence_ripple),
        "ratio",
        "lower",
    ));
    t.push(entry(
        "motion.correction_effort",
        macro_avg(&runs, |r| r.motion_correction_effort),
        "ratio",
        "lower",
    ));
    t.push(entry(
        "motion.silent_burden_sentence",
        macro_avg(&runs, |r| r.silent_motion_sentence_lines),
        "lines",
        "lower",
    ));
    t.push(entry(
        "motion.silent_burden_paragraph",
        macro_avg(&runs, |r| r.silent_motion_paragraph_lines),
        "lines",
        "lower",
    ));
    t.push(entry(
        "motion.silent_travel_max",
        runs.iter()
            .filter(|r| r.layout == HEADLINE_LAYOUT)
            .map(|r| r.silent_travel_max_lines)
            .fold(0.0, f64::max),
        "lines",
        "lower",
    ));
    t.push(entry(
        "motion.rest_travel",
        macro_avg(&runs, |r| r.rest_travel_lines),
        "lines",
        "lower",
    ));
    t.push(entry(
        "motion.blur_exposure",
        macro_avg(&runs, |r| r.blur_exposure_s),
        "s",
        "lower",
    ));
    t.push(entry(
        "motion.max_line_speed",
        runs.iter()
            .filter(|r| r.layout == HEADLINE_LAYOUT)
            .map(|r| r.max_line_speed)
            .fold(0.0, f64::max),
        "lines/s",
        "lower",
    ));
    // §7.2 event-triggered average: the mean velocity change 0–250 ms after a
    // snapshot lands. If the stage visibly accelerates on every recogniser
    // update, this is the row that says so in one number.
    t.push(entry(
        "motion.eta_v_0_250ms",
        mean_of(
            &headline
                .eta_v
                .iter()
                .filter(|(lag, _)| *lag >= 0.0 && *lag <= 250.0)
                .map(|(_, dv)| *dv)
                .collect::<Vec<_>>(),
        ),
        "lines/s",
        "lower",
    ));

    // ---- HONESTY (§8) ----
    t.push(entry(
        "honest.fce_3_pct",
        macro_avg(&runs, |r| r.fce_3_pct),
        "%",
        "lower",
    ));
    t.push(entry(
        "honest.fce_5_pct",
        macro_avg(&runs, |r| r.fce_5_pct),
        "%",
        "lower",
    ));
    t.push(entry(
        "honest.hold_precision",
        macro_avg(&runs, |r| r.hold_precision),
        "ratio",
        "higher",
    ));
    t.push(entry(
        "honest.hold_recall",
        macro_avg(&runs, |r| r.hold_recall),
        "ratio",
        "higher",
    ));
    t.push(entry(
        "honest.unnecessary_hold_pct",
        macro_avg(&runs, |r| r.unnecessary_hold_pct),
        "%",
        "lower",
    ));
    t.push(entry(
        "honest.hold_release_p95",
        macro_avg(&runs, |r| r.hold_release_p95_ms),
        "ms",
        "lower",
    ));
    t.push(entry(
        "honest.state_churn_per_min",
        macro_avg(&runs, |r| r.state_transitions_per_min),
        "count",
        "lower",
    ));
    // Calibration is a DIAGNOSTIC, not a target: `confidence` is documented as a
    // heuristic rather than a probability, so a poor Brier score here is a fact
    // about the field's honesty, not a bug to optimise away.
    t.push(entry("honest.brier", {
        let n = headline.calibration.len().max(1) as f64;
        headline
            .calibration
            .iter()
            .map(|(c, y)| (c - if *y { 1.0 } else { 0.0 }).powi(2))
            .sum::<f64>()
            / n
    }, "score", "lower"));

    // ---- READABLE RECOVERY (§9) ----
    t.push(entry(
        "recover.readable_p50",
        pctl(&headline.readable_recovery_ms, 50.0),
        "ms",
        "lower",
    ));
    t.push(entry(
        "recover.readable_p95",
        pctl(&headline.readable_recovery_ms, 95.0),
        "ms",
        "lower",
    ));
    t.push(entry(
        "recover.regret",
        macro_avg(&runs, |r| r.recovery_regret),
        "cost",
        "lower",
    ));
    t.push(entry(
        "recover.snapbacks",
        total_u32_all(&runs, |r| r.recovery_snapbacks),
        "count",
        "lower",
    ));
    t.push(entry(
        "recover.within_5_words",
        macro_avg(&runs, |r| r.recovered_within_5_words_pct),
        "%",
        "higher",
    ));

    // ---- RELIABILITY (§10) ----
    t.push(entry(
        "health.freshness_p95",
        pctl(&headline.freshness_ms, 95.0),
        "ms",
        "lower",
    ));
    t.push(entry(
        "health.stale_1s_pct",
        macro_avg(&runs, |r| r.stale_1000_pct),
        "%",
        "lower",
    ));
    t.push(entry(
        "health.follow_availability",
        macro_avg(&runs, |r| r.follow_availability),
        "%",
        "higher",
    ));

    // ---- per-layout headline, so a 30 Hz regression cannot hide ----
    let mut by_layout: BTreeMap<String, Vec<BenchEntry>> = BTreeMap::new();
    for layout in runs.iter().map(|r| r.layout.clone()).collect::<std::collections::BTreeSet<_>>() {
        let sel: Vec<&PerceptualMetrics> = runs.iter().filter(|r| r.layout == layout).collect();
        let avg = |f: &dyn Fn(&PerceptualMetrics) -> f64| -> f64 {
            mean_of(&sel.iter().map(|r| f(r)).filter(|x| x.is_finite()).collect::<Vec<_>>())
        };
        by_layout.insert(
            layout,
            vec![
                entry("readable_availability", avg(&|r| r.readable_availability), "%", "higher"),
                entry("band.occupancy", avg(&|r| r.band_occupancy_pct), "%", "higher"),
                entry("motion.plant_err_p95", avg(&|r| r.plant_err_p95), "lines", "lower"),
                entry("motion.pulse_p95", avg(&|r| r.snapshot_pulse_p95), "lines/s²", "lower"),
                entry("ink.half_dim_p50", avg(&|r| r.half_dim_p50), "ms", "lower"),
                entry("ink.unread_exposure", avg(&|r| r.uie_mean), "words", "lower"),
                entry("disruptions_per_10min", avg(&|r| r.disruptions_per_10min), "count", "lower"),
            ],
        );
    }

    TierCResult {
        label: label.to_string(),
        config: config.clone(),
        table: t,
        runs,
        by_layout,
    }
}

/// Default layout sweep.
pub fn layouts_for(names: Option<&[String]>) -> Vec<Layout> {
    let all = default_layouts();
    match names {
        None => all,
        Some(want) => all
            .into_iter()
            .filter(|l| want.iter().any(|w| w == &l.name))
            .collect(),
    }
}

/// Keep `RecoveryKind` reachable for callers that mix the two tables.
pub fn recovery_kind_name(k: RecoveryKind) -> &'static str {
    match k {
        RecoveryKind::Initial => "initial",
        RecoveryKind::SkipForward => "skip",
        RecoveryKind::Retake => "retake",
        RecoveryKind::AdlibReturn => "adlib",
    }
}
