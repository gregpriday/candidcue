//! Suite orchestration: run every scenario, pool the results, and emit the
//! benchmark table — the numbers the optimisation phase moves and the final
//! report presents.
//!
//! The table is deliberately multi-dimensional (spec §19.1): safety,
//! accuracy, responsiveness, robustness, recovery, viewport, ambiguity and
//! runtime are separate rows. The lexicographic rule applies when comparing
//! configurations: a config that improves accuracy but adds a false jump is
//! a regression.

use serde::{Deserialize, Serialize};

use cc_align::AlignmentConfig;

use crate::metrics::{evaluate, percentile, RecoveryKind, RunMetrics};
use crate::plan::{expand, synthetic_timing};
use crate::replay::replay;
use crate::scenarios::build_suite;
use crate::synthetic::generate_events;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BenchEntry {
    pub name: String,
    pub value: f64,
    pub unit: String,
    /// "higher" or "lower" — which direction is an improvement.
    pub better: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SuiteResult {
    pub label: String,
    pub config: AlignmentConfig,
    pub table: Vec<BenchEntry>,
    pub runs: Vec<RunMetrics>,
}

fn entry(name: &str, value: f64, unit: &str, better: &str) -> BenchEntry {
    BenchEntry {
        name: name.to_string(),
        value,
        unit: unit.to_string(),
        better: better.to_string(),
    }
}

pub fn run_tier_a(
    scripts_dir: &std::path::Path,
    config: &AlignmentConfig,
    label: &str,
) -> anyhow::Result<SuiteResult> {
    let suite = build_suite(scripts_dir)?;
    let mut runs: Vec<RunMetrics> = Vec::new();

    // Pooled sample stores.
    let mut clean_abs: Vec<f64> = Vec::new();
    let mut clean_signed: Vec<f64> = Vec::new();
    let mut scale_us: std::collections::HashMap<String, f64> = Default::default();

    for scenario in &suite {
        let performance = expand(&scenario.plan, &scenario.script);
        let gold = synthetic_timing(&performance, scenario.wpm);
        let events = generate_events(&gold, &scenario.plan.corruption, scenario.plan.seed);
        let result = replay(
            scenario.script.clone(),
            config.clone(),
            &events,
            &gold.viewport_hints,
        );
        let spoken: String = performance
            .words
            .iter()
            .map(|w| w.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        let eval = evaluate(
            &scenario.plan.name,
            &scenario.plan.scenario,
            &gold,
            &result,
            Some(&spoken),
        );

        if is_clean_family(&scenario.plan.scenario) {
            clean_abs.extend_from_slice(&eval.samples.abs_err);
            clean_signed.extend_from_slice(&eval.samples.signed_err);
        }
        if scenario.plan.scenario == "scale_window" {
            scale_us.insert(scenario.plan.script.clone(), eval.metrics.mean_event_us);
        }
        runs.push(eval.metrics);
    }

    let table = build_table(&runs, &mut clean_abs, &clean_signed, &scale_us);
    Ok(SuiteResult {
        label: label.to_string(),
        config: config.clone(),
        table,
        runs,
    })
}

fn is_clean_family(scenario: &str) -> bool {
    matches!(
        scenario,
        "exact" | "pauses" | "rate_fast" | "rate_slow" | "restart"
    )
}

fn build_table(
    runs: &[RunMetrics],
    clean_abs: &mut Vec<f64>,
    clean_signed: &[f64],
    scale_us: &std::collections::HashMap<String, f64>,
) -> Vec<BenchEntry> {
    let mut table = Vec::new();

    // ---- safety ----
    let false_jumps: u32 = runs.iter().map(|r| r.false_jumps).sum();
    let catastrophic: u32 = runs.iter().map(|r| r.catastrophic).sum();
    table.push(entry("safety.false_jumps", false_jumps as f64, "count", "lower"));
    table.push(entry(
        "safety.catastrophic",
        catastrophic as f64,
        "count",
        "lower",
    ));

    // ---- accuracy on clean reads (pooled samples) ----
    let n = clean_abs.len().max(1) as f64;
    let within2 = clean_abs.iter().filter(|v| **v <= 2.0).count() as f64 / n * 100.0;
    let within5 = clean_abs.iter().filter(|v| **v <= 5.0).count() as f64 / n * 100.0;
    table.push(entry("accuracy.clean_within2", within2, "%", "higher"));
    table.push(entry("accuracy.clean_within5", within5, "%", "higher"));
    table.push(entry(
        "accuracy.clean_p95_abs",
        percentile(clean_abs, 95.0),
        "atoms",
        "lower",
    ));
    let mean_signed = if clean_signed.is_empty() {
        0.0
    } else {
        clean_signed.iter().sum::<f64>() / clean_signed.len() as f64
    };
    table.push(entry(
        "accuracy.mean_signed_abs",
        mean_signed.abs(),
        "atoms",
        "lower",
    ));

    // ---- responsiveness ----
    let (moved, total) = runs
        .iter()
        .fold((0usize, 0usize), |(m, t), r| (m + r.prefinal_moved, t + r.prefinal_total));
    table.push(entry(
        "responsiveness.prefinal_move",
        if total == 0 { 0.0 } else { 100.0 * moved as f64 / total as f64 },
        "%",
        "higher",
    ));
    let (frozen, freeze_eligible) = runs
        .iter()
        .filter(|r| is_clean_family(&r.scenario))
        .fold((0usize, 0usize), |(f, e), r| {
            (f + r.freeze_frozen, e + r.freeze_eligible)
        });
    table.push(entry(
        "responsiveness.freeze",
        if freeze_eligible == 0 {
            0.0
        } else {
            100.0 * frozen as f64 / freeze_eligible as f64
        },
        "%",
        "lower",
    ));
    let mut first_locks: Vec<f64> = runs
        .iter()
        .filter(|r| r.scenario != "viewport_start" && r.scenario != "names_cold_jump")
        .flat_map(|r| &r.recoveries)
        .filter(|e| e.kind == RecoveryKind::Initial)
        .filter_map(|e| e.recovered_in_s)
        .collect();
    table.push(entry(
        "responsiveness.first_lock_p50",
        percentile(&mut first_locks, 50.0),
        "s",
        "lower",
    ));

    // ---- robustness ----
    let corrupt: Vec<&RunMetrics> = runs.iter().filter(|r| r.scenario == "corrupt15").collect();
    let (c2, c5, ce) = corrupt.iter().fold((0, 0, 0), |(a, b, e), r| {
        (a + r.within2_hits, b + r.within5_hits, e + r.eligible_samples)
    });
    table.push(entry(
        "robust.corrupt15_within5",
        if ce == 0 { 0.0 } else { 100.0 * c5 as f64 / ce as f64 },
        "%",
        "higher",
    ));
    let _ = c2;
    let subs: Vec<&RunMetrics> = runs
        .iter()
        .filter(|r| r.scenario == "substitutions")
        .collect();
    let (s2, se) = subs
        .iter()
        .fold((0, 0), |(a, e), r| (a + r.within2_hits, e + r.eligible_samples));
    table.push(entry(
        "robust.substitutions_within2",
        if se == 0 { 0.0 } else { 100.0 * s2 as f64 / se as f64 },
        "%",
        "higher",
    ));
    // Repetitions: within ±5, because a repeated phrase legitimately puts
    // the reader a few atoms behind the monotonic cursor for its duration —
    // the failure this family catches is losing the lock, not the ±2 wobble.
    for (scenario_name, bench_name) in [
        ("word_repeats", "robust.word_repeats_within5"),
        ("phrase_repeats", "robust.phrase_repeats_within5"),
    ] {
        let sel: Vec<&RunMetrics> = runs
            .iter()
            .filter(|r| r.scenario == scenario_name)
            .collect();
        let (h, e) = sel
            .iter()
            .fold((0, 0), |(a, e), r| (a + r.within5_hits, e + r.eligible_samples));
        table.push(entry(
            bench_name,
            if e == 0 { 0.0 } else { 100.0 * h as f64 / e as f64 },
            "%",
            "higher",
        ));
    }

    // ---- recovery ----
    let by_kind = |kind: RecoveryKind, scenarios: Option<&[&str]>| -> (Vec<f64>, usize) {
        let mut times = Vec::new();
        let mut failures = 0usize;
        for r in runs {
            if let Some(list) = scenarios {
                if !list.contains(&r.scenario.as_str()) {
                    continue;
                }
            }
            for e in &r.recoveries {
                if e.kind == kind {
                    match e.recovered_in_s {
                        Some(t) => times.push(t),
                        None => failures += 1,
                    }
                }
            }
        }
        (times, failures)
    };

    let (mut skips, skip_fail) = by_kind(RecoveryKind::SkipForward, None);
    table.push(entry(
        "recovery.skip_p95",
        percentile(&mut skips, 95.0),
        "s",
        "lower",
    ));
    let (mut retakes, retake_fail) = by_kind(RecoveryKind::Retake, None);
    table.push(entry(
        "recovery.retake_p95",
        percentile(&mut retakes, 95.0),
        "s",
        "lower",
    ));
    let (mut adlibs, adlib_fail) = by_kind(RecoveryKind::AdlibReturn, None);
    table.push(entry(
        "recovery.adlib_p95",
        percentile(&mut adlibs, 95.0),
        "s",
        "lower",
    ));
    table.push(entry(
        "recovery.failures",
        (skip_fail + retake_fail + adlib_fail) as f64,
        "count",
        "lower",
    ));
    let mut drifts: Vec<f64> = runs.iter().filter_map(|r| r.adlib_max_drift).collect();
    table.push(entry(
        "recovery.adlib_drift_p95",
        percentile(&mut drifts, 95.0),
        "atoms",
        "lower",
    ));

    // ---- viewport & cold relocation ----
    let mut viewport_locks: Vec<f64> = runs
        .iter()
        .filter(|r| r.scenario == "viewport_start")
        .flat_map(|r| &r.recoveries)
        .filter(|e| e.kind == RecoveryKind::Initial)
        .filter_map(|e| e.recovered_in_s)
        .collect();
    let viewport_lock_failures = runs
        .iter()
        .filter(|r| r.scenario == "viewport_start")
        .flat_map(|r| &r.recoveries)
        .filter(|e| e.kind == RecoveryKind::Initial && e.recovered_in_s.is_none())
        .count();
    table.push(entry(
        "viewport.start_lock_p50",
        if viewport_lock_failures > 0 {
            f64::NAN
        } else {
            percentile(&mut viewport_locks, 50.0)
        },
        "s",
        "lower",
    ));
    let mut name_locks: Vec<f64> = runs
        .iter()
        .filter(|r| r.scenario == "names_cold_jump")
        .flat_map(|r| &r.recoveries)
        .filter(|e| matches!(e.kind, RecoveryKind::SkipForward | RecoveryKind::Initial))
        .filter_map(|e| e.recovered_in_s)
        .collect();
    table.push(entry(
        "names.cold_jump_lock_p95",
        if name_locks.is_empty() {
            f64::NAN
        } else {
            percentile(&mut name_locks, 95.0)
        },
        "s",
        "lower",
    ));

    // ---- ambiguity ----
    let refrain_jumps: u32 = runs
        .iter()
        .filter(|r| r.run.starts_with("refrain"))
        .map(|r| r.false_jumps)
        .sum();
    table.push(entry(
        "ambiguity.refrain_false_jumps",
        refrain_jumps as f64,
        "count",
        "lower",
    ));

    // ---- runtime ----
    let mut all_event_us: Vec<f64> = runs.iter().map(|r| r.mean_event_us).collect();
    table.push(entry(
        "perf.mean_event_us",
        if all_event_us.is_empty() {
            0.0
        } else {
            all_event_us.iter().sum::<f64>() / all_event_us.len() as f64
        },
        "µs",
        "lower",
    ));
    let p95s: Vec<u64> = runs.iter().map(|r| r.p95_event_us).collect();
    table.push(entry(
        "perf.p95_event_us",
        p95s.iter().copied().max().unwrap_or(0) as f64,
        "µs",
        "lower",
    ));
    let _ = &mut all_event_us;
    let scale_ratio = match (scale_us.get("huge"), scale_us.get("product-update")) {
        (Some(big), Some(small)) if *small > 0.0 => big / small,
        _ => f64::NAN,
    };
    table.push(entry("perf.scale_ratio_5k", scale_ratio, "×", "lower"));

    table
}

/// Manifest of one captured live run directory.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunManifest {
    pub name: String,
    pub script: String,
    pub scenario: String,
    pub engine: String,
    pub voice_index: usize,
    /// Spoken word count of the performance.
    pub words: usize,
    /// Audio length in seconds.
    pub audio_s: f64,
}

/// Replay every captured live run in `runs_dir` and build the Tier-B table.
pub fn run_tier_b(
    runs_dir: &std::path::Path,
    scripts_dir: &std::path::Path,
    config: &AlignmentConfig,
    label: &str,
) -> anyhow::Result<SuiteResult> {
    use crate::capture::read_events_jsonl;
    use crate::plan::GoldTimeline;

    let mut runs: Vec<RunMetrics> = Vec::new();
    let mut pooled_abs: Vec<f64> = Vec::new();
    let mut pooled_signed: Vec<f64> = Vec::new();
    let mut wer_weighted = 0.0f64;
    let mut wer_words = 0usize;

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
        let events = read_events_jsonl(&dir.join("events.jsonl"))?;
        let performance_text = std::fs::read_to_string(dir.join("performance.txt"))?;
        let source =
            std::fs::read_to_string(scripts_dir.join(format!("{}.md", manifest.script)))?;
        let script = cc_align::compile(&source, cc_align::CompileOptions::default());

        let result = crate::replay::replay(script, config.clone(), &events, &gold.viewport_hints);
        let eval = evaluate(
            &manifest.name,
            &manifest.scenario,
            &gold,
            &result,
            Some(&performance_text),
        );
        pooled_abs.extend_from_slice(&eval.samples.abs_err);
        pooled_signed.extend_from_slice(&eval.samples.signed_err);
        if let Some(wer) = eval.metrics.wer_pct {
            wer_weighted += wer * manifest.words as f64;
            wer_words += manifest.words;
        }
        runs.push(eval.metrics);
    }

    // Tier-B table: the live end-to-end numbers.
    let mut table = Vec::new();
    let n = pooled_abs.len().max(1) as f64;
    let within2 = pooled_abs.iter().filter(|v| **v <= 2.0).count() as f64 / n * 100.0;
    let within5 = pooled_abs.iter().filter(|v| **v <= 5.0).count() as f64 / n * 100.0;
    table.push(entry("live.within2", within2, "%", "higher"));
    table.push(entry("live.within5", within5, "%", "higher"));
    table.push(entry(
        "live.p95_abs",
        percentile(&mut pooled_abs, 95.0),
        "atoms",
        "lower",
    ));
    let mean_signed = if pooled_signed.is_empty() {
        0.0
    } else {
        pooled_signed.iter().sum::<f64>() / pooled_signed.len() as f64
    };
    table.push(entry("live.mean_signed_abs", mean_signed.abs(), "atoms", "lower"));
    let false_jumps: u32 = runs.iter().map(|r| r.false_jumps).sum();
    let catastrophic: u32 = runs.iter().map(|r| r.catastrophic).sum();
    table.push(entry("live.false_jumps", false_jumps as f64, "count", "lower"));
    table.push(entry("live.catastrophic", catastrophic as f64, "count", "lower"));
    let (moved, total) = runs
        .iter()
        .fold((0usize, 0usize), |(m, t), r| (m + r.prefinal_moved, t + r.prefinal_total));
    table.push(entry(
        "live.prefinal_move",
        if total == 0 { 0.0 } else { 100.0 * moved as f64 / total as f64 },
        "%",
        "higher",
    ));
    let (frozen, freeze_eligible) = runs.iter().fold((0usize, 0usize), |(f, e), r| {
        (f + r.freeze_frozen, e + r.freeze_eligible)
    });
    table.push(entry(
        "live.freeze",
        if freeze_eligible == 0 {
            0.0
        } else {
            100.0 * frozen as f64 / freeze_eligible as f64
        },
        "%",
        "lower",
    ));
    let mut recoveries: Vec<f64> = runs
        .iter()
        .flat_map(|r| &r.recoveries)
        .filter(|e| e.kind != RecoveryKind::Initial)
        .filter_map(|e| e.recovered_in_s)
        .collect();
    let recovery_failures = runs
        .iter()
        .flat_map(|r| &r.recoveries)
        .filter(|e| e.recovered_in_s.is_none())
        .count();
    table.push(entry(
        "live.recovery_p95",
        percentile(&mut recoveries, 95.0),
        "s",
        "lower",
    ));
    table.push(entry(
        "live.recovery_failures",
        recovery_failures as f64,
        "count",
        "lower",
    ));
    let mut first_locks: Vec<f64> = runs
        .iter()
        .flat_map(|r| &r.recoveries)
        .filter(|e| e.kind == RecoveryKind::Initial)
        .filter_map(|e| e.recovered_in_s)
        .collect();
    table.push(entry(
        "live.first_lock_p50",
        percentile(&mut first_locks, 50.0),
        "s",
        "lower",
    ));
    table.push(entry(
        "live.wer",
        if wer_words == 0 { 0.0 } else { wer_weighted / wer_words as f64 },
        "%",
        "higher_is_worse_diagnostic",
    ));

    Ok(SuiteResult {
        label: label.to_string(),
        config: config.clone(),
        table,
        runs,
    })
}

/// Render the table for the terminal.
pub fn print_table(result: &SuiteResult) {
    println!("== {} ==", result.label);
    for e in &result.table {
        println!("{:38} {:>10.3} {:<6} ({} is better)", e.name, e.value, e.unit, e.better);
    }
}

/// Comparison table between two suite results (same benchmark set).
pub fn compare_tables(baseline: &SuiteResult, candidate: &SuiteResult) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "{:<38} {:>12} {:>12} {:>10}\n",
        "benchmark",
        baseline.label.as_str(),
        candidate.label.as_str(),
        "delta"
    ));
    for b in &baseline.table {
        let Some(c) = candidate.table.iter().find(|e| e.name == b.name) else {
            continue;
        };
        let improved = match b.better.as_str() {
            "higher" => c.value > b.value,
            _ => c.value < b.value,
        };
        let marker = if (c.value - b.value).abs() < 1e-9 {
            " "
        } else if improved {
            "+"
        } else {
            "!"
        };
        out.push_str(&format!(
            "{:<38} {:>12.3} {:>12.3} {:>9}{}\n",
            b.name,
            b.value,
            c.value,
            format!("{:+.3}", c.value - b.value),
            marker
        ));
    }
    out
}
