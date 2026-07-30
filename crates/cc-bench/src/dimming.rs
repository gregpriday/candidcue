//! Deterministic micro-benchmarks for the reversible visual dim frontier.
//!
//! The ordinary replay suite cannot faithfully create the key starting state:
//! the presenter has manually positioned the script, is confidently locked,
//! and the next recogniser item contains only one misspelled word. Driving the
//! real engine directly keeps that precondition explicit and lets the suite
//! measure the benefit separately from its bounded safety cost.

use cc_align::{compile, AlignmentConfig, CompileOptions, Engine, SessionEvent, Snapshot};

const FALLBACK_WAIT_MS: f64 = 1_200.0;

pub struct DimmingMetric {
    pub name: &'static str,
    pub value: f64,
    pub unit: &'static str,
    pub better: &'static str,
}

fn metric(
    name: &'static str,
    value: f64,
    unit: &'static str,
    better: &'static str,
) -> DimmingMetric {
    DimmingMetric {
        name,
        value,
        unit,
        better,
    }
}

fn final_word(engine: &mut Engine, ordinal: usize, heard: &str, at_ms: f64) -> Snapshot {
    engine.handle(SessionEvent::Final {
        item_id: format!("dimming-{ordinal}"),
        text: heard.to_string(),
        audio_end_ms: at_ms,
    })
}

fn one_word(config: &AlignmentConfig, expected: &str, heard: &str, locked: bool) -> Snapshot {
    let script = compile(
        &format!("alpha bravo {expected} delta echo"),
        CompileOptions::default(),
    );
    let mut engine = Engine::new(script, config.clone());
    if locked {
        engine.set_manual_position(2, 0.0);
    }
    final_word(&mut engine, 1, heard, 350.0)
}

fn hit_rate(config: &AlignmentConfig, pairs: &[(&str, &str)]) -> f64 {
    let hits = pairs
        .iter()
        .filter(|(expected, heard)| {
            one_word(config, expected, heard, true)
                .provisional
                .is_some()
        })
        .count();
    100.0 * hits as f64 / pairs.len() as f64
}

pub fn benchmark(config: &AlignmentConfig) -> Vec<DimmingMetric> {
    // Character-distance errors commonly produced by recognisers. The set
    // covers deletion, insertion, vowel substitution and transposition.
    let spelling = [
        ("presenter", "presentor"),
        ("teleprompter", "teleprompters"),
        ("harbour", "harbor"),
        ("narration", "naration"),
        ("accommodate", "acommodate"),
        ("entrepreneur", "entreprenuer"),
    ];
    // Sound-alike spellings for names or rare terms, where edit distance alone
    // is insufficient and the phonetic relation must carry the bridge.
    let phonetic_names = [
        ("Saoirse", "Searsha"),
        ("Saoirse", "Sairs"),
        ("Sowersby", "Soursby"),
        ("Worcestershire", "Worstushier"),
        ("Kubernetes", "Kubernettes"),
    ];
    // Clearly unrelated speech must not dim merely because the microphone is
    // active. This is the guard against an "any detected speech" fallback.
    let unrelated = [
        ("presenter", "banana"),
        ("teleprompter", "weather"),
        ("narration", "coffee"),
        ("Kubernetes", "morning"),
    ];
    // Real words can be only one edit apart while meaning different things.
    // No spelling matcher can distinguish these from a mistranscription using
    // one word alone; this row makes that irreducible ambiguity visible.
    let near_word_collisions = [
        ("desert", "dessert"),
        ("affect", "effect"),
        ("trial", "trail"),
        ("adaptation", "adoption"),
    ];

    let spelling_recall = hit_rate(config, &spelling);
    let phonetic_recall = hit_rate(config, &phonetic_names);
    let unrelated_false = hit_rate(config, &unrelated);
    let collision_false = hit_rate(config, &near_word_collisions);

    let chain_script = compile(
        "alpha bravo presenter teleprompter harbour narration delta echo",
        CompileOptions::default(),
    );
    let mut chain = Engine::new(chain_script.clone(), config.clone());
    chain.set_manual_position(2, 0.0);
    let mut chain_advances = 0usize;
    let mut max_depth = 0.0f64;
    let mut previous = None;
    for (i, heard) in ["presentor", "teleprompters", "harbor", "naration"]
        .iter()
        .enumerate()
    {
        let snapshot = final_word(&mut chain, i + 1, heard, 350.0 * (i + 1) as f64);
        if snapshot
            .provisional
            .is_some_and(|frontier| previous.is_none_or(|last| frontier > last))
        {
            chain_advances += 1;
        }
        if let Some(frontier) = snapshot.provisional {
            max_depth = max_depth.max(frontier - snapshot.observed);
        }
        previous = snapshot.provisional;
    }

    let mut rollback = Engine::new(chain_script, config.clone());
    rollback.set_manual_position(2, 0.0);
    let assumed = final_word(&mut rollback, 1, "presentor", 350.0);
    let contradicted = final_word(&mut rollback, 2, "banana", 700.0);
    let rollback_success = assumed.provisional.is_some()
        && contradicted.provisional.is_none()
        && contradicted.provisional_retracted
        && contradicted.observed == 2.0
        && contradicted.confirmed == 2.0;

    let cold_false = usize::from(
        one_word(config, "presenter", "presentor", false)
            .provisional
            .is_some(),
    );

    vec![
        metric("fuzzy.spelling_recall", spelling_recall, "%", "higher"),
        metric(
            "fuzzy.spelling_visual_wait",
            FALLBACK_WAIT_MS * (1.0 - spelling_recall / 100.0),
            "ms",
            "lower",
        ),
        metric("fuzzy.phonetic_name_recall", phonetic_recall, "%", "higher"),
        metric(
            "fuzzy.phonetic_name_visual_wait",
            FALLBACK_WAIT_MS * (1.0 - phonetic_recall / 100.0),
            "ms",
            "lower",
        ),
        metric(
            "fuzzy.unrelated_false_bridge",
            unrelated_false,
            "%",
            "lower",
        ),
        metric(
            "fuzzy.near_word_false_bridge",
            collision_false,
            "%",
            // Diagnostic, not a gate. `desert`/`dessert` and `affect`/`effect`
            // are one edit apart and no single-word matcher can separate a real
            // near word from a mistranscription, so this sits at 100% by
            // construction and cannot be driven down. Labelled "lower" it read
            // as a permanently failing gate — the one row in the table that
            // could never move — which trains a reader to ignore the column.
            "diagnostic",
        ),
        metric(
            "fuzzy.chain_advances",
            chain_advances as f64,
            "count",
            "higher",
        ),
        metric("fuzzy.max_speculative_depth", max_depth, "atoms", "lower"),
        metric(
            "fuzzy.rollback_success",
            if rollback_success { 100.0 } else { 0.0 },
            "%",
            "higher",
        ),
        metric(
            "fuzzy.rollback_event_latency",
            if rollback_success { 0.0 } else { FALLBACK_WAIT_MS },
            "ms",
            "lower",
        ),
        metric(
            "fuzzy.rollback_exposure",
            if rollback_success { 350.0 } else { 0.0 },
            "ms",
            "lower",
        ),
        metric(
            "fuzzy.cold_false_advances",
            cold_false as f64,
            "count",
            "lower",
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_configuration_hits_the_core_case_and_rolls_back() {
        let metrics = benchmark(&AlignmentConfig::default());
        let get = |name| metrics.iter().find(|m| m.name == name).unwrap().value;
        assert!(get("fuzzy.spelling_recall") > 0.0);
        assert_eq!(get("fuzzy.unrelated_false_bridge"), 0.0);
        assert_eq!(get("fuzzy.rollback_success"), 100.0);
        assert_eq!(get("fuzzy.cold_false_advances"), 0.0);
        assert!(get("fuzzy.max_speculative_depth") <= 3.0);
    }

    #[test]
    fn reports_each_captured_name_form_that_does_not_bridge() {
        let config = AlignmentConfig::default();
        for (expected, heard) in [
            ("Saoirse", "Searsha"),
            ("Saoirse", "Sairs"),
            ("Sowersby", "Soursby"),
            ("Worcestershire", "Worstushier"),
            ("Kubernetes", "Kubernettes"),
        ] {
            let expected_key = cc_align::normalize::phonetic_key(&expected.to_lowercase());
            let heard_key = cc_align::normalize::phonetic_key(&heard.to_lowercase());
            assert!(
                one_word(&config, expected, heard, true)
                    .provisional
                    .is_some(),
                "{expected} ← {heard}; keys {expected_key:?} ← {heard_key:?}",
            );
        }
    }
}
