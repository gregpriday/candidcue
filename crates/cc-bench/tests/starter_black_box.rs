//! The black-box acceptance test the historical "0 of 26" failure demanded
//! (spec §22.1): load the real starter script, feed a deterministic
//! Inworld-cadence event sequence, and assert on what the PRESENTER would
//! see — not on any internal score.

use cc_bench::metrics::evaluate;
use cc_bench::plan::{expand, synthetic_timing, Corruption, PerformancePlan, PlanOp};
use cc_bench::replay::replay;
use cc_bench::synthetic::generate_events;
use cc_align::{compile, AlignmentConfig, CompileOptions, TrackingState};

fn starter_script() -> cc_align::CompiledScript {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../bench/scripts/starter.md");
    let source = std::fs::read_to_string(root).expect("starter fixture");
    compile(&source, CompileOptions::default())
}

#[test]
fn starter_script_is_followed_end_to_end() {
    let script = starter_script();
    let n = script.len() as u32;
    assert!(n > 200, "starter must be a real script, got {n} atoms");

    let plan = PerformancePlan {
        name: "starter_black_box".into(),
        script: "starter".into(),
        scenario: "exact".into(),
        seed: 7,
        ops: vec![PlanOp::Read { from: 0, to: n }],
        corruption: Corruption::default(),
    };
    let performance = expand(&plan, &script);
    let gold = synthetic_timing(&performance, 150);
    let events = generate_events(&gold, &plan.corruption, plan.seed);

    let result = replay(
        script.clone(),
        AlignmentConfig::default(),
        &events,
        &gold.viewport_hints,
    );

    // 1. The display moves BEFORE the first final (the finals-only lurch was
    //    the shipped failure this guards against).
    let first_final_idx = events
        .iter()
        .position(|e| matches!(e, cc_stt::SttFrame::Final { .. }))
        .expect("a final");
    let observed_before_final = result.snapshots[..first_final_idx]
        .iter()
        .any(|s| s.observed > 1.0);
    assert!(
        observed_before_final,
        "the cursor must advance on partials, not wait for the final"
    );

    // 2. The engine ends at the end of the script, in Following state.
    let last = result.snapshots.last().expect("snapshots");
    assert!(
        (last.observed - n as f64).abs() <= 3.0,
        "end position {} must reach the final atom {n}",
        last.observed
    );
    assert_eq!(last.state, TrackingState::Following);

    // 3. Product metrics: high accuracy, no safety events, no freezes worth
    //    the name.
    let eval = evaluate("starter_black_box", "exact", &gold, &result, None);
    assert_eq!(eval.metrics.false_jumps, 0, "no false jumps on a clean read");
    assert_eq!(eval.metrics.catastrophic, 0);
    assert!(
        eval.metrics.within5_pct > 95.0,
        "within±5 {}% must exceed 95%",
        eval.metrics.within5_pct
    );
    assert!(
        eval.metrics.freeze_pct < 10.0,
        "freeze ratio {}% must stay under 10%",
        eval.metrics.freeze_pct
    );

    // 4. Confidence must be reachable by a verbatim read (the historical
    //    scorer made 1.0 impossible; anything gating on it wedged).
    assert!(
        result.snapshots.iter().any(|s| s.confidence > 0.7),
        "a verbatim read must reach high confidence"
    );
}

#[test]
fn intro_then_end_jump_is_followed() {
    // Greg's scenario: say something at the beginning, stop, then read the
    // ending. The tracker must relocate without a manual hint.
    let script = starter_script();
    let n = script.len() as u32;
    let plan = PerformancePlan {
        name: "starter_intro_end".into(),
        script: "starter".into(),
        scenario: "intro_then_end".into(),
        seed: 11,
        ops: vec![
            PlanOp::Read { from: 0, to: n / 6 },
            PlanOp::Pause { ms: 3_000 },
            PlanOp::Read {
                from: n * 85 / 100,
                to: n,
            },
        ],
        corruption: Corruption::default(),
    };
    let performance = expand(&plan, &script);
    let gold = synthetic_timing(&performance, 150);
    let events = generate_events(&gold, &plan.corruption, plan.seed);
    let result = replay(
        script,
        AlignmentConfig::default(),
        &events,
        &gold.viewport_hints,
    );
    let eval = evaluate("starter_intro_end", "intro_then_end", &gold, &result, None);

    assert_eq!(eval.metrics.false_jumps, 0);
    assert_eq!(eval.metrics.catastrophic, 0);
    let skip = eval
        .metrics
        .recoveries
        .iter()
        .find(|r| matches!(r.kind, cc_bench::metrics::RecoveryKind::SkipForward))
        .expect("the jump to the ending is a skip event");
    let recovered = skip.recovered_in_s.expect("must recover");
    assert!(
        recovered < 8.0,
        "relocation to the ending took {recovered}s"
    );
}
