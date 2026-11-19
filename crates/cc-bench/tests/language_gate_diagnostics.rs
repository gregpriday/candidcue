//! The language gate's numbers must not depend on whether diagnostic fixtures
//! sit in the corpus directory.
//!
//! The bar is defined over 18 scoring fixtures. The English corpus also
//! carries three `fuzzy-follow` diagnostics, and the gate used to exclude them
//! from the fixture COUNT while reading metric values from tables aggregated
//! over all 21 — which moved `gate.unread_never_spoken` from 3.067 to 2.629
//! and turned a failing English verdict into a passing one.
//!
//! This runs the real path twice — capture-shaped fixtures on disk, Tier B and
//! Tier C over the directory, the results through JSON as `--out` writes them,
//! then the gate — once over the 18 core fixtures and once with the three
//! diagnostics added beside them, and requires the same eight values and the
//! same verdict. The fixtures are synthesised from the Tier A scenarios rather
//! than read from `bench/runs-local`, whose events are in Git LFS: the shape
//! (names, families, the 18 + 3 split) is the real corpus's, the audio is not.

use std::path::{Path, PathBuf};

use cc_align::AlignmentConfig;
use cc_bench::capture_local::write_events_jsonl;
use cc_bench::language_gate::{evaluate_saved, is_scoring_run, LanguageGateReport, SHIP_BAR};
use cc_bench::plan::{expand, synthetic_timing};
use cc_bench::scenarios::{build_suite, tier_b_selection};
use cc_bench::suite::{run_tier_b, RunManifest, SuiteResult};
use cc_bench::synthetic::generate_events;
use cc_bench::tierc::{layouts_for, run_tier_c_captured, TierCResult};

fn scripts_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../bench/scripts")
}

/// What each diagnostic fixture is replayed from.
///
/// The fixture is a diagnostic because of its NAME (`fuzzy-follow__…`), which
/// is all the gate reads. Its content is chosen to move every pooled Tier C
/// row: the real `fuzzy-follow` plan is a contiguous read with no skip or
/// retake, so it contributes no readable-recovery samples at all, and a
/// scoring table that wrongly pooled every run's recoveries would still pass.
/// These plans each contain a discontinuity the stage has to recover from.
const DIAGNOSTIC_CONTENT: &[(&str, &str)] = &[
    ("starter", "retake"),
    ("starter", "skip_forward"),
    ("names", "names_cold_jump"),
];

/// Write one capture-shaped fixture directory per selected Tier B run.
fn write_corpus(dir: &Path, include: impl Fn(&str) -> bool) {
    let suite = build_suite(&scripts_dir()).expect("Tier A suite");
    let mut diagnostics = DIAGNOSTIC_CONTENT.iter();
    for live in tier_b_selection() {
        let name = format!("{}__{}__{}", live.script, live.scenario, live.engine.slug());
        if !include(&name) {
            continue;
        }
        let (script, scenario) = if is_scoring_run(&name) {
            (live.script, live.scenario)
        } else {
            *diagnostics.next().expect("one content plan per diagnostic")
        };
        let item = suite
            .iter()
            .find(|s| s.plan.script == script && s.plan.scenario == scenario)
            .unwrap_or_else(|| panic!("no Tier A scenario for {script}/{scenario}"));
        let performance = expand(&item.plan, &item.script);
        let gold = synthetic_timing(&performance, item.wpm);
        // A per-fixture seed, so the three engines of one plan do not replay
        // identical events.
        let seed = item.plan.seed ^ ((live.voice_index as u64 + 1) << 16);
        let events = generate_events(&gold, &item.plan.corruption, seed);

        let run_dir = dir.join(&name);
        std::fs::create_dir_all(&run_dir).unwrap();
        let manifest = RunManifest {
            name: name.clone(),
            script: script.to_string(),
            scenario: scenario.to_string(),
            engine: live.engine.slug().to_string(),
            voice_index: live.voice_index,
            words: performance.words.len(),
            audio_s: gold.total_ms / 1000.0,
            atom_count: Some(item.script.len()),
        };
        std::fs::write(
            run_dir.join("manifest.json"),
            serde_json::to_string(&manifest).unwrap(),
        )
        .unwrap();
        std::fs::write(run_dir.join("gold.json"), serde_json::to_string(&gold).unwrap()).unwrap();
        let spoken: Vec<&str> = performance.words.iter().map(|w| w.text.as_str()).collect();
        std::fs::write(run_dir.join("performance.txt"), spoken.join(" ")).unwrap();
        write_events_jsonl(&run_dir.join("events.jsonl"), &events).unwrap();
    }
}

struct Measured {
    tier_b: SuiteResult,
    tier_c: TierCResult,
    report: LanguageGateReport,
}

/// Tier B, Tier C at the as-shipped rig, a JSON round trip, then the gate.
fn measure(runs: &Path) -> Measured {
    let config = AlignmentConfig::default();
    let tier_b = run_tier_b(runs, &scripts_dir(), &config, "t").expect("tier-b");
    let mut layouts = layouts_for(Some(&["60hz".to_string()]));
    for layout in &mut layouts {
        layout.focus_lead_atoms = 0.0;
    }
    let tier_c =
        run_tier_c_captured(runs, &scripts_dir(), &config, "t", &layouts).expect("tier-c");

    // The gate reads saved files, so read what a saved file would carry.
    let tier_b: SuiteResult =
        serde_json::from_str(&serde_json::to_string(&tier_b).unwrap()).unwrap();
    let tier_c: TierCResult =
        serde_json::from_str(&serde_json::to_string(&tier_c).unwrap()).unwrap();
    let report = evaluate_saved("en", &tier_b, &tier_c).expect("valid evidence");
    Measured {
        tier_b,
        tier_c,
        report,
    }
}

fn row(table: &[cc_bench::suite::BenchEntry], name: &str) -> f64 {
    table
        .iter()
        .find(|e| e.name == name)
        .unwrap_or_else(|| panic!("{name} missing"))
        .value
}

#[test]
fn gate_values_and_verdict_are_invariant_to_diagnostics() {
    let root = tempfile::tempdir().unwrap();
    let runs = root.path().join("runs");

    write_corpus(&runs, is_scoring_run);
    let core = measure(&runs);

    write_corpus(&runs, |name| !is_scoring_run(name));
    assert_eq!(
        std::fs::read_dir(&runs).unwrap().count(),
        21,
        "the corpus should now be the English shape: 18 core plus 3 diagnostics"
    );
    let with = measure(&runs);

    // The core-only corpus is valid evidence, so the comparison below is a
    // comparison of numbers, not of two identical refusals.
    assert!(
        core.report.corpus_problems.is_empty(),
        "{}",
        core.report.render()
    );
    assert!(with.report.corpus_problems.is_empty(), "{}", with.report.render());

    // The diagnostics really are in the ordinary tables, and really move them
    // in both tiers — otherwise identical gate values would prove nothing.
    assert_eq!(with.tier_b.runs.len(), 21);
    let moved = |tier: &str, a: &[cc_bench::suite::BenchEntry], b: &[cc_bench::suite::BenchEntry]| {
        let changed: Vec<&str> = SHIP_BAR
            .iter()
            .map(|t| t.metric)
            .filter(|m| a.iter().any(|e| e.name == *m))
            .filter(|m| row(a, m).to_bits() != row(b, m).to_bits())
            .collect();
        assert!(
            !changed.is_empty(),
            "adding the diagnostics moved no {tier} gate row of the ordinary table, \
             so this test cannot tell a scoring table from an ordinary one"
        );
    };
    moved("Tier B", &core.tier_b.table, &with.tier_b.table);
    moved("Tier C", &core.tier_c.table, &with.tier_c.table);
    // Tier C's two percentile rows are the ones a saved file cannot recompute,
    // so each must be shown to move on its own: a scoring table that pooled
    // the wrong samples for either would otherwise go unseen.
    for pooled in ["time.lag_p50", "recover.readable_p50"] {
        assert_ne!(
            row(&core.tier_c.table, pooled).to_bits(),
            row(&with.tier_c.table, pooled).to_bits(),
            "the diagnostics do not move {pooled}, so this test cannot tell \
             whether the scoring table pooled only the core's samples"
        );
    }

    // The scoring tables reproduce the core-only corpus's own numbers exactly,
    // with or without the diagnostics alongside.
    for (core_table, with_scoring) in [
        (&core.tier_b.table, &with.tier_b.scoring),
        (&core.tier_c.table, &with.tier_c.scoring),
    ] {
        let scoring = with_scoring.as_ref().expect("a captured tier writes a scoring table");
        assert_eq!(scoring.runs.len(), 18);
        for entry in &scoring.table {
            assert_eq!(
                entry.value.to_bits(),
                row(core_table, &entry.name).to_bits(),
                "{}: the scoring value with diagnostics present ({}) is not the \
                 core-only corpus's value ({})",
                entry.name,
                entry.value,
                row(core_table, &entry.name)
            );
        }
    }

    // And so the gate reports the same rows, values and verdict.
    assert_eq!(core.report.rows.len(), SHIP_BAR.len());
    for (a, b) in core.report.rows.iter().zip(&with.report.rows) {
        assert_eq!(a.threshold.metric, b.threshold.metric);
        let value = a.value.unwrap_or_else(|| panic!("{} missing", a.threshold.metric));
        assert!(value.is_finite(), "{} is not a number", a.threshold.metric);
        assert_eq!(
            a.value.map(f64::to_bits),
            b.value.map(f64::to_bits),
            "{} changed when diagnostics were added",
            a.threshold.metric
        );
        assert_eq!(a.passed, b.passed, "{} changed verdict", a.threshold.metric);
    }
    assert_eq!(core.report.passed(), with.report.passed());
    assert_eq!(core.report.render(), with.report.render());

    // Pairing the two directories is the same corpus: diagnostics may differ
    // between the tiers' inputs, the scoring fixtures may not.
    let mixed = evaluate_saved("en", &core.tier_b, &with.tier_c).expect("valid evidence");
    assert!(mixed.corpus_problems.is_empty(), "{}", mixed.render());
}
