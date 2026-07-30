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

use crate::metrics::{evaluate, mean, percentile, RecoveryKind, RunMetrics};
use crate::plan::{expand, synthetic_timing};
use crate::replay::replay;
use crate::scenarios::build_suite;
use crate::synthetic::generate_events;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BenchEntry {
    pub name: String,
    /// The measured value, which may be NaN.
    ///
    /// NaN is a legitimate value here and always has been: `percentile` returns
    /// it for an empty sample set rather than 0.0, because 0.0 would read as a
    /// perfect score on every lower-is-better row. But `serde_json` writes NaN as
    /// `null` and then REFUSES to read `null` back into an `f64`, so a saved
    /// result containing one empty percentile could be written and never
    /// compared — the failure surfaced as `invalid type: null, expected f64`
    /// from `compare`, on a file this program had just produced itself.
    #[serde(with = "nan_as_null")]
    pub value: f64,
    pub unit: String,
    /// "higher" or "lower" — which direction is an improvement.
    pub better: String,
}

/// Round-trip a possibly-NaN `f64` through JSON's `null`.
mod nan_as_null {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &f64, s: S) -> Result<S::Ok, S::Error> {
        if v.is_finite() {
            s.serialize_f64(*v)
        } else {
            s.serialize_none()
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
        Ok(Option::<f64>::deserialize(d)?.unwrap_or(f64::NAN))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SuiteResult {
    pub label: String,
    pub config: AlignmentConfig,
    pub table: Vec<BenchEntry>,
    pub runs: Vec<RunMetrics>,
}

fn pct_of(hits: usize, eligible: usize) -> f64 {
    if eligible == 0 {
        0.0
    } else {
        100.0 * hits as f64 / eligible as f64
    }
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
    let mut pause_lead: Vec<f64> = Vec::new();
    let mut span_abs: Vec<f64> = Vec::new();
    // Overshoot pools across EVERY family, not just the clean ones: fading a
    // word the reader has not reached is just as wrong in a retake as in a
    // straight read.
    let mut ahead: Vec<f64> = Vec::new();
    // Smoothness pools across the clean families only. The corrupted and
    // jump families spend their time recovering, and recovery motion is
    // supposed to look different from reading motion — pooling it in would
    // report a successful relocation as jerk.
    let mut velocity: Vec<f64> = Vec::new();
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
            velocity.extend_from_slice(&eval.samples.velocity);
        }
        pause_lead.extend_from_slice(&eval.samples.pause_lead);
        ahead.extend_from_slice(&eval.samples.ahead);
        if matches!(scenario.plan.scenario.as_str(), "asr_forms" | "asr_forms_pauses") {
            span_abs.extend_from_slice(&eval.samples.span_abs);
        }
        if scenario.plan.scenario == "scale_window" {
            scale_us.insert(scenario.plan.script.clone(), eval.metrics.mean_event_us);
        }
        runs.push(eval.metrics);
    }

    let table = build_table(
        &runs,
        config,
        &mut clean_abs,
        &clean_signed,
        &scale_us,
        &mut pause_lead,
        &mut ahead,
        &mut span_abs,
        &mut velocity,
    );
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
    config: &AlignmentConfig,
    clean_abs: &mut [f64],
    clean_signed: &[f64],
    scale_us: &std::collections::HashMap<String, f64>,
    pause_lead: &mut [f64],
    ahead: &mut [f64],
    span_abs: &mut [f64],
    velocity: &mut [f64],
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
    // Running ahead of the reader is a safety failure, not an accuracy one:
    // with a fade display it deletes text they are still reading.
    let ahead_events: u32 = runs.iter().map(|r| r.ahead_events).sum();
    table.push(entry("safety.ahead_events", ahead_events as f64, "count", "lower"));
    let ahead_worst = runs
        .iter()
        .filter_map(|r| r.ahead_worst)
        .fold(f64::NEG_INFINITY, f64::max);
    table.push(entry(
        "safety.ahead_worst",
        if ahead_worst.is_finite() { ahead_worst } else { f64::NAN },
        "atoms",
        "lower",
    ));
    let (ahead_hits, ahead_eligible) = runs
        .iter()
        .fold((0usize, 0usize), |(h, e), r| (h + r.ahead_samples, e + r.ahead_eligible));
    table.push(entry(
        "overshoot.ahead_time",
        if ahead_eligible == 0 { 0.0 } else { 100.0 * ahead_hits as f64 / ahead_eligible as f64 },
        "%",
        "lower",
    ));
    table.push(entry(
        "overshoot.ahead_p95",
        percentile(ahead, 95.0),
        "atoms",
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
    // Pause overshoot: how far ahead the display sits while the reader is
    // silent. P95 over every pause sample in the suite.
    table.push(entry(
        "responsiveness.pause_overshoot_p95",
        percentile(pause_lead, 95.0),
        "atoms",
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

    // ---- smoothness ----
    // Everything above scores WHERE the display was. These score HOW IT GOT
    // THERE, over the clean families while the reader is actually speaking.
    // They are reported separately and deliberately carry no aggregate: a
    // change that buys a steadier glide by running ahead is not an
    // improvement, and only the safety rows can say so.
    let clean: Vec<&RunMetrics> = runs.iter().filter(|r| is_clean_family(&r.scenario)).collect();
    let (stationary, motion_eligible) = clean
        .iter()
        .fold((0usize, 0usize), |(s, e), r| (s + r.motion_stationary, e + r.motion_eligible));
    table.push(entry(
        "smoothness.stationary",
        pct_of(stationary, motion_eligible),
        "%",
        "lower",
    ));
    // Mean and median together are the diagnosis. Over a run the display must
    // average the reader's true pace or it would fall arbitrarily behind, so
    // the MEAN is the reader. Any gap between it and the MEDIAN is time spent
    // moving slower than the reader, repaid in steps — which is exactly the
    // shape `surge_p95` measures.
    table.push(entry("smoothness.vel_mean", mean(velocity), "atoms/s", "same"));
    let vel_p50 = percentile(&mut velocity.to_vec(), 50.0);
    table.push(entry("smoothness.vel_p10", percentile(&mut velocity.to_vec(), 10.0), "atoms/s", "higher"));
    table.push(entry("smoothness.vel_p50", vel_p50, "atoms/s", "same"));
    table.push(entry("smoothness.vel_p90", percentile(&mut velocity.to_vec(), 90.0), "atoms/s", "lower"));
    // σ/μ of the pooled speed. The headline: 0 is a perfect glide, and the
    // current surge-crawl-stall pattern is what makes it large.
    let vel_cov = {
        let mu = mean(velocity);
        if mu.abs() < f64::EPSILON {
            0.0
        } else {
            let var = mean(&velocity.iter().map(|v| (v - mu).powi(2)).collect::<Vec<_>>());
            var.sqrt() / mu
        }
    };
    table.push(entry("smoothness.vel_cov", vel_cov, "ratio", "lower"));
    // Per minute of scored speaking time, so adding scenarios does not look
    // like a regression.
    let speaking_min = motion_eligible as f64 * 50.0 / 60_000.0;
    let stalls: u32 = clean.iter().map(|r| r.stalls).sum();
    table.push(entry(
        "smoothness.stalls_per_min",
        if speaking_min > 0.0 { stalls as f64 / speaking_min } else { 0.0 },
        "count",
        "lower",
    ));
    table.push(entry(
        "smoothness.surge_p95",
        mean(&clean.iter().map(|r| r.surge_p95).collect::<Vec<_>>()),
        "atoms/s",
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
    table.extend(
        crate::dimming::benchmark(config)
            .into_iter()
            .map(|metric| entry(metric.name, metric.value, metric.unit, metric.better)),
    );
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

    // ---- spoken forms ----
    // The script and the recogniser spelled the same sound differently. These
    // rows are reported separately from `accuracy.*` on purpose: pooling them
    // in would let a spelling failure hide inside a corpus that is 90% plain
    // prose, which is how this class of bug survived unmeasured until a page of
    // numbers was read at it. The per-script rows exist for the same reason at
    // one level down — figures fail on normalisation, names fail on word
    // boundaries, and one number covering both would move for the wrong reason.
    // The headline is the spelling-only families. `asr_forms_skip` is a
    // relocation test and `asr_forms_corrupt` is a noise test, and both were
    // in here at first — which meant the headline moved when relocation or
    // recognition changed, with nothing to say it had. They get their own rows.
    let plain = |r: &RunMetrics| matches!(r.scenario.as_str(), "asr_forms" | "asr_forms_pauses");
    let any_forms = |r: &RunMetrics| r.scenario.starts_with("asr_forms");
    let (f2, f5, fe) = runs.iter().filter(|r| plain(r)).fold((0, 0, 0), |(a, b, e), r| {
        (a + r.within2_hits, b + r.within5_hits, e + r.eligible_samples)
    });
    table.push(entry("forms.within2", pct_of(f2, fe), "%", "higher"));
    table.push(entry("forms.within5", pct_of(f5, fe), "%", "higher"));

    // The same reading, scored ONLY where the two sides disagreed about
    // spelling. A whole-run number is nine parts undisputed prose; this one is
    // the benchmark the family was built to be.
    let (s2, s5, se) = runs.iter().filter(|r| plain(r)).fold((0, 0, 0), |(a, b, e), r| {
        (a + r.span_within2, b + r.span_within5, e + r.span_eligible)
    });
    table.push(entry("forms.span_within2", pct_of(s2, se), "%", "higher"));
    table.push(entry("forms.span_within5", pct_of(s5, se), "%", "higher"));
    table.push(entry(
        "forms.span_p95_abs",
        percentile(span_abs, 95.0),
        "atoms",
        "lower",
    ));
    // How many samples the span rows are computed over. Not a quality number:
    // it is the tell that the benchmark INPUT moved. The verbalizer reads
    // compiled atoms, so a normalisation change can alter which re-spellings
    // fire and how long they take — and then a before/after is not the same
    // experiment. If this row differs between two results, read the deltas
    // below it as directional only.
    table.push(entry("forms.span_samples", se as f64, "count", "same"));

    for (script, bench_name) in [
        ("figures", "forms.figures_within5"),
        ("brands", "forms.brands_within5"),
    ] {
        let (h, e) = runs
            .iter()
            .filter(|r| plain(r) && r.run.starts_with(script))
            .fold((0, 0), |(a, e), r| (a + r.within5_hits, e + r.eligible_samples));
        table.push(entry(bench_name, pct_of(h, e), "%", "higher"));
    }
    let (c5, ce) = runs
        .iter()
        .filter(|r| r.scenario == "asr_forms_corrupt")
        .fold((0, 0), |(a, e), r| (a + r.within5_hits, e + r.eligible_samples));
    table.push(entry("forms.corrupt_within5", pct_of(c5, ce), "%", "higher"));

    table.push(entry(
        "forms.false_jumps",
        runs.iter().filter(|r| any_forms(r)).map(|r| r.false_jumps).sum::<u32>() as f64,
        "count",
        "lower",
    ));
    let (forms_frozen, forms_freeze_eligible) = runs
        .iter()
        .filter(|r| plain(r))
        .fold((0usize, 0usize), |(f, e), r| {
            (f + r.freeze_frozen, e + r.freeze_eligible)
        });
    table.push(entry(
        "forms.freeze",
        pct_of(forms_frozen, forms_freeze_eligible),
        "%",
        "lower",
    ));
    // Relocation into a passage whose only landmarks were re-spelled. Skips
    // only: pooling the initial locks in swamped two skip events with a dozen
    // identical cold starts and made the row unable to move.
    let mut forms_relocations: Vec<f64> = runs
        .iter()
        .filter(|r| r.scenario == "asr_forms_skip")
        .flat_map(|r| &r.recoveries)
        .filter(|e| e.kind == RecoveryKind::SkipForward)
        .filter_map(|e| e.recovered_in_s)
        .collect();
    table.push(entry(
        "forms.relocate_p95",
        percentile(&mut forms_relocations, 95.0),
        "s",
        "lower",
    ));
    table.push(entry(
        "forms.lock_failures",
        runs.iter()
            .filter(|r| any_forms(r))
            .flat_map(|r| &r.recoveries)
            .filter(|e| e.recovered_in_s.is_none())
            .count() as f64,
        "count",
        "lower",
    ));

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
    let (_, initial_fail) = by_kind(RecoveryKind::Initial, None);
    table.push(entry(
        "recovery.failures",
        (skip_fail + retake_fail + adlib_fail + initial_fail) as f64,
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
    // Weighted by event count: a 10-event run must not count as much as a
    // 2,000-event run.
    let (total_us, total_events) = runs.iter().fold((0.0f64, 0usize), |(us, n), r| {
        (us + r.mean_event_us * r.event_count as f64, n + r.event_count)
    });
    table.push(entry(
        "perf.mean_event_us",
        if total_events == 0 { 0.0 } else { total_us / total_events as f64 },
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
    /// How many atoms the script compiled to when this run was captured.
    ///
    /// Gold stores the reader's position as an ATOM INDEX, and replay
    /// recompiles the script from source with whatever normaliser is current.
    /// So a normalisation change that adds or drops one atom does not fail —
    /// it silently shifts every gold position in every captured run for that
    /// script, and the benchmark keeps printing plausible numbers about the
    /// wrong words. This is the fingerprint that turns that into an error.
    ///
    /// `None` on fixtures captured before it existed.
    #[serde(default)]
    pub atom_count: Option<usize>,
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
    let mut pooled_pause: Vec<f64> = Vec::new();
    let mut pooled_ahead: Vec<f64> = Vec::new();
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
        if let Some(captured) = manifest.atom_count {
            anyhow::ensure!(
                captured == script.len(),
                "{}: {} compiles to {} atoms now, {} when this run was captured. \
                 Its gold is in atom indexes, so replaying it would score the engine \
                 against the wrong words. Re-capture the run, or revert the change to \
                 how {}.md normalises.",
                manifest.name,
                manifest.script,
                script.len(),
                captured,
                manifest.script,
            );
        }

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
        pooled_pause.extend_from_slice(&eval.samples.pause_lead);
        pooled_ahead.extend_from_slice(&eval.samples.ahead);
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
    table.push(entry(
        "live.pause_overshoot_p95",
        percentile(&mut pooled_pause, 95.0),
        "atoms",
        "lower",
    ));
    let live_ahead_events: u32 = runs.iter().map(|r| r.ahead_events).sum();
    table.push(entry("live.ahead_events", live_ahead_events as f64, "count", "lower"));
    let (live_ahead_hits, live_ahead_eligible) = runs
        .iter()
        .fold((0usize, 0usize), |(h, e), r| (h + r.ahead_samples, e + r.ahead_eligible));
    table.push(entry(
        "live.ahead_time",
        if live_ahead_eligible == 0 {
            0.0
        } else {
            100.0 * live_ahead_hits as f64 / live_ahead_eligible as f64
        },
        "%",
        "lower",
    ));
    table.push(entry(
        "live.ahead_p95",
        percentile(&mut pooled_ahead, 95.0),
        "atoms",
        "lower",
    ));
    let live_ahead_worst = runs
        .iter()
        .filter_map(|r| r.ahead_worst)
        .fold(f64::NEG_INFINITY, f64::max);
    table.push(entry(
        "live.ahead_worst",
        if live_ahead_worst.is_finite() { live_ahead_worst } else { f64::NAN },
        "atoms",
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
    // Time-to-dim: the headline responsiveness row, and the only one denominated
    // in what a reader waits rather than in how far behind the mark sits.
    //
    // Pooled over the RAW per-word samples, not averaged over per-run
    // percentiles. The runs are 75 to 463 words, so a mean of run medians
    // answers "the median run's median word" and silently gives a 75-word run
    // six times the weight per word of a 463-word one. `p95_abs`, pause
    // overshoot and ahead p95 all pool raw samples; this matches them.
    //
    // Empty pools report NaN rather than 0. A run that never locked contributes
    // nothing here, and 0 ms would read as instant rather than as absent.
    let mut dim_all: Vec<f64> = runs.iter().flat_map(|r| r.dim_samples_ms.clone()).collect();
    table.push(entry(
        "live.dim_p50_ms",
        percentile(&mut dim_all.clone(), 50.0),
        "ms",
        "lower",
    ));
    table.push(entry(
        "live.dim_p95_ms",
        percentile(&mut dim_all, 95.0),
        "ms",
        "lower",
    ));
    table.push(entry(
        "live.dim_never",
        runs.iter().map(|r| r.dim_never as f64).sum::<f64>(),
        "count",
        "lower",
    ));
    table.push(entry(
        "live.wer",
        if wer_words == 0 { 0.0 } else { wer_weighted / wer_words as f64 },
        "%",
        "higher_is_worse_diagnostic",
    ));
    table.extend(
        crate::dimming::benchmark(config)
            .into_iter()
            .map(|metric| entry(metric.name, metric.value, metric.unit, metric.better)),
    );

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
    compare_entry_tables(
        &baseline.label,
        &baseline.table,
        &candidate.label,
        &candidate.table,
    )
}

/// The same comparison over bare entry lists, so Tier C — whose result type
/// carries a per-layout block the tracking table has no equivalent for — reuses
/// one renderer instead of growing a second one that formats differently.
pub fn compare_entry_tables(
    baseline_label: &str,
    baseline: &[BenchEntry],
    candidate_label: &str,
    candidate: &[BenchEntry],
) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "{:<38} {:>12} {:>12} {:>10}\n",
        "benchmark", baseline_label, candidate_label, "delta"
    ));
    for b in baseline {
        let Some(c) = candidate.iter().find(|e| e.name == b.name) else {
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
