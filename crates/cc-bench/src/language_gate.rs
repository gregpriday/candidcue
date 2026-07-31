//! The bar a language has to clear before it is offered to a user.
//!
//! `cc-align` can be taught to normalise French — that is a profile, and
//! `cc_align::language` defines its shape. Whether the result FOLLOWS is a
//! different question and only a measurement can answer it. This module is
//! that measurement's verdict: a fixed threshold table, evaluated against a
//! saved Tier B and Tier C result, that either passes or does not.
//!
//! ## Why it is code and not a paragraph
//!
//! The harness already computes every number here, and until now nothing did
//! anything with them. `BenchEntry::better` records which DIRECTION is an
//! improvement and `compare_tables` prints a `+` or a `!`, but both exit
//! successfully whatever the numbers say. That is fine for tuning English,
//! where a human reads the table and decides. It is not fine for a shipping
//! decision, because "follows about as well as English" is exactly the kind of
//! judgement that drifts — the issue that prompted this asked for a number
//! rather than a feeling, and a number nobody checks is a feeling with extra
//! steps.
//!
//! ## How the thresholds were chosen
//!
//! Every limit is anchored to the measured English baseline, quoted in
//! [`Threshold::english_baseline`]. A language is NOT required to match
//! English: the recogniser is a different model, the corpus is a different
//! recording, and holding a new language to English's exact numbers would
//! reject work that is perfectly good. What the bar refuses is a language that
//! is materially worse on the axes that decide whether a presenter can use it.
//!
//! The axis that matters most is DEPTH of overshoot, not how often it happens.
//! `ahead_worst` is how far the display actually got in front of the reader,
//! and running ahead is the failure a fade UI cannot survive — a line erased
//! before it is spoken is unreadable, whereas a line that arrives late is
//! merely late. `ahead_events` counts occurrences and is deliberately NOT
//! gating; the same distinction is already recorded in `AlignmentConfig`'s
//! `lead_margin_atoms` comment, where a change that took `ahead_events` from
//! 11 to 30 was accepted because `ahead_worst` barely moved.

use std::collections::BTreeMap;

use crate::suite::SuiteResult;

/// Which way a metric has to move to be worse.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    /// Lower is better; the limit is a ceiling.
    AtMost,
    /// Higher is better; the limit is a floor.
    AtLeast,
}

/// Which run produces the metric.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier {
    /// Captured recogniser output replayed through the engine.
    B,
    /// The RENDERED stage — what the glass actually shows.
    C,
}

impl Tier {
    pub fn label(self) -> &'static str {
        match self {
            Tier::B => "Tier B",
            Tier::C => "Tier C",
        }
    }
}

/// One row of the shipping bar.
#[derive(Debug, Clone, Copy)]
pub struct Threshold {
    /// The metric's name in the harness's own table. These are matched
    /// verbatim, so a renamed metric fails the gate loudly rather than
    /// silently passing it.
    pub metric: &'static str,
    pub tier: Tier,
    pub direction: Direction,
    /// The measured English value this limit was set against.
    pub english_baseline: f64,
    pub limit: f64,
    pub unit: &'static str,
    pub why: &'static str,
}

impl Threshold {
    /// Is this value even a possible measurement of this metric?
    ///
    /// Separate from [`Threshold::passes`] because a negative latency or a
    /// 101% rate is not a language that follows badly — it is a result file
    /// that does not mean what the gate thinks it means, and passing it
    /// silently is worse than failing it. `%` rows are bounded; everything
    /// else here is a duration, a distance or a count, none of which can be
    /// negative.
    pub fn plausible(&self, value: f64) -> bool {
        if !value.is_finite() {
            return false;
        }
        match self.unit {
            "%" => (0.0..=100.0).contains(&value),
            _ => value >= 0.0,
        }
    }

    pub fn passes(&self, value: f64) -> bool {
        if !self.plausible(value) {
            return false;
        }
        match self.direction {
            Direction::AtMost => value <= self.limit,
            Direction::AtLeast => value >= self.limit,
        }
    }
}

/// The number of Tier B fixtures a language's core corpus must contain.
///
/// Eight script families crossed with performance plans and three TTS engines,
/// which is the shape the English corpus already has. The count is fixed rather
/// than a minimum because `dim_never` is an absolute count, not a rate: it means
/// "runs where the display never caught up at all", and comparing 1-in-18
/// against 1-in-9 is not comparing anything. Diagnostic fixtures may exist
/// alongside these (the English corpus carries three `fuzzy-follow` runs) but
/// are excluded from scoring.
pub const REQUIRED_CORE_RUNS: usize = 18;

/// The script families the corpus has to cover.
///
/// A good score on an easy corpus is not evidence. These are the difficulty
/// families the English fixtures actually stratify across — read off
/// `bench/runs-local`, not invented — and a language that only ever reads
/// flowing prose has not been asked the hard questions: figures, names and
/// repeated passages are where following breaks.
pub const REQUIRED_SCRIPT_ROLES: &[&str] = &[
    "brands",
    "figures",
    "longform",
    "names",
    "product-update",
    "refrain",
    "starter",
    "technical",
];

/// Fixture families that are diagnostics rather than evidence.
///
/// `fuzzy-follow` exists to exercise the reversible dim frontier and is not
/// part of the scored core; counting it would move the `live.dim_never`
/// denominator.
pub const DIAGNOSTIC_ROLES: &[&str] = &["fuzzy-follow"];

/// The family a fixture belongs to.
///
/// Run directories are named `family__plan__engine` (`starter__retake__gemini`),
/// so the family is the leading segment.
pub fn role_of(run: &str) -> &str {
    run.split("__").next().unwrap_or(run)
}

/// The bar itself.
///
/// Absolute limits, not deltas, so a language is judged against a fixed line
/// rather than against whatever the last run happened to produce.
pub const SHIP_BAR: &[Threshold] = &[
    Threshold {
        metric: "live.ahead_worst",
        tier: Tier::B,
        direction: Direction::AtMost,
        english_baseline: 6.700,
        limit: 7.0,
        unit: "atoms",
        why: "Depth of overshoot. The display running ahead erases a line \
              someone is still reading, which no amount of lateness matches \
              for damage. This is the row to judge a language on.",
    },
    Threshold {
        metric: "live.within5",
        tier: Tier::B,
        direction: Direction::AtLeast,
        english_baseline: 94.03,
        limit: 90.0,
        unit: "%",
        why: "Ordinary following accuracy. Four points of slack below English \
              because the recogniser is a different model on a different \
              recording, not because worse tracking is acceptable.",
    },
    Threshold {
        metric: "live.dim_p50_ms",
        tier: Tier::B,
        direction: Direction::AtMost,
        english_baseline: 500.0,
        limit: 750.0,
        unit: "ms",
        why: "The delay a presenter actually perceives between finishing a \
              word and the display passing it. Every other accuracy row is a \
              distance, and the same 3-word lag is half a second at 150 wpm \
              and a second at 75.",
    },
    Threshold {
        metric: "live.dim_never",
        tier: Tier::B,
        direction: Direction::AtMost,
        english_baseline: 1.0,
        limit: 1.0,
        unit: "count",
        why: "WORDS the display never reached before the take ended, summed \
              over the corpus — not runs. The limit is a near-zero absolute \
              rather than a rate, deliberately: a raw word count does not \
              scale cleanly between a corpus and its translation, so the only \
              honest thing to say about it across languages is that it must \
              essentially not happen. English scores 1 word across all 18 \
              runs.",
    },
    Threshold {
        metric: "gate.unread_never_spoken",
        tier: Tier::C,
        direction: Direction::AtMost,
        english_baseline: 2.903,
        limit: 3.0,
        unit: "word·s",
        why: "The safety gate, measured on the RENDERED stage: text faded \
              before it was spoken, weighted by how likely the eye was on it. \
              This is the one number that describes the failure the product \
              cannot ship with.",
    },
    Threshold {
        metric: "outcome.readable_availability",
        tier: Tier::C,
        direction: Direction::AtLeast,
        english_baseline: 71.2,
        limit: 70.0,
        unit: "%",
        why: "How much of the take the next line was actually readable on the \
              glass. The outcome a presenter would describe as 'it worked'.",
    },
    Threshold {
        metric: "time.lag_p50",
        tier: Tier::C,
        direction: Direction::AtMost,
        english_baseline: 697.0,
        limit: 800.0,
        unit: "ms",
        why: "Rendered lag, as opposed to the engine's own estimate of it.",
    },
    Threshold {
        metric: "recover.readable_p50",
        tier: Tier::C,
        direction: Direction::AtMost,
        english_baseline: 2738.0,
        limit: 3000.0,
        unit: "ms",
        why: "How long the stage takes to become readable again after a skip \
              or a retake. Recovery is most of what a real take is made of.",
    },
];

/// Metrics that are reported but deliberately do NOT decide the outcome.
///
/// Written down because "we looked at it and chose not to gate on it" and "we
/// forgot" are indistinguishable a year later.
pub const REPORTED_NOT_GATING: &[(&str, &str)] = &[
    (
        "live.ahead_events",
        "Counts overshoot occurrences rather than depth. It moves with display \
         cadence — the floored dim frontier changed it from 11 to 30 while \
         `ahead_worst` stayed level — so gating on it would reject changes \
         that made the glass better.",
    ),
    (
        "live.within2",
        "A symmetric narrow band, which scores being 2 atoms AHEAD the same as \
         being 2 behind. Those are not the same event: one is late, the other \
         erases a line being read.",
    ),
    (
        "live.wer",
        "Word error rate is the recogniser's score, not the engine's. The \
         English blank_penalty sweep found the two moving in OPPOSITE \
         directions past 3.0, so selecting on WER would actively pick a worse \
         following experience.",
    ),
    (
        "live.freeze",
        "Worth reading during a blank_penalty sweep, but stillness is a \
         symptom rather than the thing being judged; `within5` plus the safety \
         gate already cover the outcome.",
    ),
];

/// What happened to one threshold.
#[derive(Debug, Clone)]
pub struct RowOutcome {
    pub threshold: Threshold,
    /// `None` when the metric was absent from the result entirely.
    pub value: Option<f64>,
    pub passed: bool,
    pub note: String,
}

/// The verdict.
#[derive(Debug, Clone)]
pub struct LanguageGateReport {
    pub language: String,
    pub rows: Vec<RowOutcome>,
    /// Problems with the corpus itself, which invalidate the numbers rather
    /// than failing them.
    pub corpus_problems: Vec<String>,
}

impl LanguageGateReport {
    pub fn passed(&self) -> bool {
        self.corpus_problems.is_empty() && self.rows.iter().all(|r| r.passed)
    }

    pub fn failures(&self) -> impl Iterator<Item = &RowOutcome> {
        self.rows.iter().filter(|r| !r.passed)
    }

    /// A table a human can read, in the same spirit as the report tables the
    /// harness already prints.
    pub fn render(&self) -> String {
        let mut out = String::new();
        out.push_str(&format!(
            "language gate — {}\n\n{:<32} {:>10} {:>10} {:>8}  {}\n",
            self.language, "metric", "value", "limit", "verdict", "tier"
        ));
        out.push_str(&"-".repeat(84));
        out.push('\n');
        for row in &self.rows {
            let value = match row.value {
                Some(v) if v.is_finite() => format!("{v:.3}"),
                Some(_) => "NaN".to_string(),
                None => "missing".to_string(),
            };
            let arrow = match row.threshold.direction {
                Direction::AtMost => "<=",
                Direction::AtLeast => ">=",
            };
            out.push_str(&format!(
                "{:<32} {:>10} {:>3}{:>7.3} {:>8}  {}\n",
                row.threshold.metric,
                value,
                arrow,
                row.threshold.limit,
                if row.passed { "pass" } else { "FAIL" },
                row.threshold.tier.label(),
            ));
        }
        if !self.corpus_problems.is_empty() {
            out.push_str("\ncorpus is not valid evidence:\n");
            for problem in &self.corpus_problems {
                out.push_str(&format!("  - {problem}\n"));
            }
        }
        if !self.passed() {
            out.push_str("\nwhy these rows matter:\n");
            for row in self.failures() {
                out.push_str(&format!(
                    "  {} ({} baseline {:.3} {})\n    {}\n",
                    row.threshold.metric,
                    row.threshold.tier.label(),
                    row.threshold.english_baseline,
                    row.threshold.unit,
                    row.threshold.why,
                ));
            }
        }
        out
    }
}

/// The bar as a Markdown table, so `bench/README.md` can state it without
/// becoming a second, drifting copy of it.
///
/// A prose threshold and a coded one disagree eventually, and the prose is
/// always the one people read. `the_readme_states_the_coded_bar` asserts this
/// exact text appears in the README, so changing a limit here and forgetting
/// the documentation is a failing test rather than a quiet lie.
pub fn render_bar_markdown() -> String {
    let mut out = String::from("| Tier | Metric | English | Ship bar |\n|---|---|---:|---:|\n");
    for t in SHIP_BAR {
        let arrow = match t.direction {
            Direction::AtMost => "<=",
            Direction::AtLeast => ">=",
        };
        out.push_str(&format!(
            "| {} | `{}` | {:.3} {} | {} {:.3} |\n",
            t.tier.label(),
            t.metric,
            t.english_baseline,
            t.unit,
            arrow,
            t.limit,
        ));
    }
    out
}

/// Flatten a saved suite result into a metric lookup.
pub fn metrics_of(result: &SuiteResult) -> BTreeMap<String, f64> {
    let mut map = BTreeMap::new();
    for entry in &result.table {
        map.insert(entry.name.clone(), entry.value);
    }
    map
}

/// Judge a language against [`SHIP_BAR`].
///
/// `run_names` is every fixture the result scored, named
/// `family__plan__engine`. The corpus is checked BEFORE any metric is read,
/// because a number computed over the wrong fixtures is not a worse
/// measurement — it is a measurement of something else.
pub fn evaluate(
    language: &str,
    metrics: &BTreeMap<String, f64>,
    run_names: &[String],
) -> LanguageGateReport {
    let mut corpus_problems = Vec::new();

    let core: Vec<&String> = run_names
        .iter()
        .filter(|r| !DIAGNOSTIC_ROLES.contains(&role_of(r)))
        .collect();

    if core.len() != REQUIRED_CORE_RUNS {
        corpus_problems.push(format!(
            "corpus has {} scoring runs; the bar is defined over exactly \
             {REQUIRED_CORE_RUNS}, and an absolute count like live.dim_never does \
             not transfer between denominators",
            core.len()
        ));
    }

    let present: std::collections::BTreeSet<&str> =
        core.iter().map(|r| role_of(r)).collect();
    let missing: Vec<&str> = REQUIRED_SCRIPT_ROLES
        .iter()
        .copied()
        .filter(|role| !present.contains(role))
        .collect();
    if !missing.is_empty() {
        corpus_problems.push(format!(
            "corpus does not cover {}; a good score on an easy corpus is not \
             evidence, and figures/names/refrain are where following breaks",
            missing.join(", ")
        ));
    }

    let rows = SHIP_BAR
        .iter()
        .map(|threshold| {
            let value = metrics.get(threshold.metric).copied();
            let (passed, note) = match value {
                None => (
                    false,
                    format!(
                        "{} is not in the result — a renamed or missing metric is a \
                         failed gate, not a passed one",
                        threshold.metric
                    ),
                ),
                Some(v) if !threshold.plausible(v) => (
                    false,
                    format!(
                        "{} = {v} is not a possible measurement of a {} — the \
                         result file is wrong, not the language",
                        threshold.metric, threshold.unit
                    ),
                ),
                Some(v) => {
                    let passed = threshold.passes(v);
                    let note = if passed {
                        String::new()
                    } else {
                        format!(
                            "{v:.3} {} against a limit of {:.3} {}",
                            threshold.unit, threshold.limit, threshold.unit
                        )
                    };
                    (passed, note)
                }
            };
            RowOutcome {
                threshold: *threshold,
                value,
                passed,
                note,
            }
        })
        .collect();

    LanguageGateReport {
        language: language.to_string(),
        rows,
        corpus_problems,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every gated metric at exactly the English baseline, which must pass.
    fn english_baseline_metrics() -> BTreeMap<String, f64> {
        SHIP_BAR
            .iter()
            .map(|t| (t.metric.to_string(), t.english_baseline))
            .collect()
    }

    /// The shape of the real English corpus: 18 scoring runs spread across
    /// every required family, plus the three `fuzzy-follow` diagnostics that
    /// must NOT be counted into the core.
    fn english_corpus() -> Vec<String> {
        let mut runs: Vec<String> = vec![
            "brands__exact__xai",
            "figures__exact__qwen",
            "figures__pauses__gemini",
            "longform__intro_then_end__qwen",
            "names__exact__xai",
            "names__names_cold_jump__gemini",
            "product-update__exact__qwen",
            "product-update__intro_then_end__xai",
            "product-update__viewport_start__gemini",
            "refrain__exact__gemini",
            "refrain__refrain_second__qwen",
            "starter__adlib_return__xai",
            "starter__exact__gemini",
            "starter__long_pauses__gemini",
            "starter__retake__gemini",
            "starter__skip_forward__qwen",
            "technical__exact__qwen",
            "technical__pauses__xai",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        assert_eq!(runs.len(), REQUIRED_CORE_RUNS);
        for engine in ["gemini", "qwen", "xai"] {
            runs.push(format!("fuzzy-follow__fuzzy_voice__{engine}"));
        }
        runs
    }

    #[test]
    fn english_baselines_clear_their_own_bar() {
        let report = evaluate("en", &english_baseline_metrics(), &english_corpus());
        assert!(
            report.passed(),
            "the measured English numbers must pass the bar they anchor:\n{}",
            report.render()
        );
    }

    /// A limit that a value sitting exactly on it fails would be a different
    /// bar than the one documented.
    #[test]
    fn a_value_exactly_on_the_limit_passes() {
        let metrics: BTreeMap<String, f64> = SHIP_BAR
            .iter()
            .map(|t| (t.metric.to_string(), t.limit))
            .collect();
        let report = evaluate("xx", &metrics, &english_corpus());
        assert!(report.passed(), "{}", report.render());
    }

    /// Each threshold, breached on its own, by the smallest amount that is
    /// unambiguously over the line.
    #[test]
    fn every_threshold_rejects_a_breach_of_its_own(
    ) {
        for threshold in SHIP_BAR {
            let mut metrics = english_baseline_metrics();
            let breach = match threshold.direction {
                Direction::AtMost => threshold.limit + 0.5,
                Direction::AtLeast => threshold.limit - 0.5,
            };
            metrics.insert(threshold.metric.to_string(), breach);

            let report = evaluate("xx", &metrics, &english_corpus());
            assert!(
                !report.passed(),
                "{} at {breach} should fail a limit of {}",
                threshold.metric,
                threshold.limit
            );
            let failed: Vec<&str> = report.failures().map(|r| r.threshold.metric).collect();
            assert_eq!(
                failed,
                vec![threshold.metric],
                "only {} should have failed",
                threshold.metric
            );
        }
    }

    /// The failure mode this gate exists to prevent: a metric that quietly
    /// stopped being produced reading as a pass.
    #[test]
    fn a_missing_metric_fails_rather_than_passes() {
        for threshold in SHIP_BAR {
            let mut metrics = english_baseline_metrics();
            metrics.remove(threshold.metric);
            let report = evaluate("xx", &metrics, &english_corpus());
            assert!(
                !report.passed(),
                "a result missing {} must not pass",
                threshold.metric
            );
        }
    }

    /// NaN is a legitimate value elsewhere in this harness (an empty
    /// percentile), so the gate has to reject it explicitly rather than
    /// relying on a comparison — `NaN <= limit` is false, but `NaN >= limit`
    /// is false too, and one of those would be an accidental pass if the
    /// direction were ever flipped.
    #[test]
    fn nan_is_not_a_measurement() {
        for threshold in SHIP_BAR {
            let mut metrics = english_baseline_metrics();
            metrics.insert(threshold.metric.to_string(), f64::NAN);
            let report = evaluate("xx", &metrics, &english_corpus());
            assert!(!report.passed(), "NaN {} must not pass", threshold.metric);
        }
        assert!(!SHIP_BAR[0].passes(f64::NAN));
        assert!(!SHIP_BAR[0].passes(f64::INFINITY));
    }

    /// A value that cannot be a measurement of its own metric means the result
    /// file is wrong, and a wrong file must not read as a pass.
    #[test]
    fn impossible_values_are_rejected_even_when_they_are_on_the_good_side() {
        for threshold in SHIP_BAR {
            // Negative durations, distances and counts.
            let mut metrics = english_baseline_metrics();
            metrics.insert(threshold.metric.to_string(), -1.0);
            assert!(
                !evaluate("xx", &metrics, &english_corpus()).passed(),
                "{} = -1 must not pass, even though it is 'better' than a \
                 ceiling",
                threshold.metric
            );

            // Rates outside 0..=100.
            if threshold.unit == "%" {
                for bogus in [101.0, 1000.0] {
                    let mut metrics = english_baseline_metrics();
                    metrics.insert(threshold.metric.to_string(), bogus);
                    assert!(
                        !evaluate("xx", &metrics, &english_corpus()).passed(),
                        "{} = {bogus}% is not a rate",
                        threshold.metric
                    );
                }
            }
        }
        assert!(!SHIP_BAR[0].plausible(f64::NEG_INFINITY));
        assert!(!SHIP_BAR[0].plausible(f64::INFINITY));
    }

    /// An empty result is the degenerate case of a missing metric, and the
    /// contract is worth stating rather than inferring.
    #[test]
    fn an_empty_result_fails_every_row() {
        let report = evaluate("xx", &BTreeMap::new(), &english_corpus());
        assert!(!report.passed());
        assert_eq!(report.failures().count(), SHIP_BAR.len());
    }

    /// A corpus of the wrong size invalidates the numbers rather than failing
    /// them, and says so.
    #[test]
    fn a_corpus_of_the_wrong_size_is_not_evidence() {
        let metrics = english_baseline_metrics();
        let full = english_corpus();
        for take in [0, 9, 17] {
            let runs: Vec<String> = full.iter().take(take).cloned().collect();
            let report = evaluate("xx", &metrics, &runs);
            assert!(
                !report.passed(),
                "{take} scoring runs must not produce a passing gate"
            );
            assert!(
                !report.corpus_problems.is_empty(),
                "{take} runs should be a corpus problem, not a metric failure"
            );
        }

        // One run too many is equally not the corpus the bar is defined over.
        let mut extra = full.clone();
        extra.push("starter__exact__qwen".into());
        assert!(!evaluate("xx", &metrics, &extra).passed());
    }

    /// The diagnostics must not be counted into the core, or `dim_never`'s
    /// denominator drifts and the whole absolute-count argument collapses.
    #[test]
    fn fuzzy_follow_diagnostics_are_excluded_from_the_core() {
        let metrics = english_baseline_metrics();

        // The real corpus is 21 directories, of which 3 are diagnostics.
        assert_eq!(english_corpus().len(), REQUIRED_CORE_RUNS + 3);
        assert!(evaluate("en", &metrics, &english_corpus()).passed());

        // Without the diagnostics it is still exactly the core, and still
        // passes — which is what "excluded" has to mean.
        let core_only: Vec<String> = english_corpus()
            .into_iter()
            .filter(|r| role_of(r) != "fuzzy-follow")
            .collect();
        assert_eq!(core_only.len(), REQUIRED_CORE_RUNS);
        assert!(evaluate("en", &metrics, &core_only).passed());
    }

    /// The check that makes `REQUIRED_SCRIPT_ROLES` load-bearing rather than a
    /// `pub const` sitting next to a README claim.
    #[test]
    fn a_corpus_missing_a_difficulty_family_is_not_evidence() {
        let metrics = english_baseline_metrics();
        for role in REQUIRED_SCRIPT_ROLES {
            // Drop one family and backfill the count from another, so the ONLY
            // thing wrong is coverage.
            let mut runs: Vec<String> = english_corpus()
                .into_iter()
                .filter(|r| role_of(r) != *role)
                .collect();
            // Backfill from a family that is NOT the one under test, or the
            // filler would put the dropped family straight back.
            let filler = REQUIRED_SCRIPT_ROLES
                .iter()
                .find(|r| *r != role)
                .expect("more than one required family");
            while runs
                .iter()
                .filter(|r| !DIAGNOSTIC_ROLES.contains(&role_of(r)))
                .count()
                < REQUIRED_CORE_RUNS
            {
                runs.push(format!("{filler}__filler_{}__gemini", runs.len()));
            }

            let report = evaluate("xx", &metrics, &runs);
            assert!(
                !report.passed(),
                "a corpus with no {role} fixture must not pass — a good score on \
                 an easy corpus is not evidence"
            );
            assert!(
                report
                    .corpus_problems
                    .iter()
                    .any(|p| p.contains(role)),
                "the report should name the missing family {role}"
            );
        }
    }

    #[test]
    fn role_is_the_leading_segment_of_a_run_name() {
        assert_eq!(role_of("starter__retake__gemini"), "starter");
        assert_eq!(role_of("product-update__exact__qwen"), "product-update");
        assert_eq!(role_of("fuzzy-follow__fuzzy_voice__xai"), "fuzzy-follow");
        // Degenerate shapes must not panic.
        assert_eq!(role_of("bare"), "bare");
        assert_eq!(role_of(""), "");
    }

    /// The non-gating list is a decision, so it must not silently overlap the
    /// gating one.
    #[test]
    fn reported_metrics_are_not_also_gated() {
        for (metric, _) in REPORTED_NOT_GATING {
            assert!(
                !SHIP_BAR.iter().any(|t| t.metric == *metric),
                "{metric} cannot be both gating and explicitly non-gating"
            );
        }
        // Moving one of these into the bar would change the shipping decision,
        // so the count is pinned.
        assert_eq!(REPORTED_NOT_GATING.len(), 4);
    }

    /// A metric named twice would let one row's verdict shadow another's.
    #[test]
    fn the_bar_has_no_duplicate_metrics() {
        let mut seen = std::collections::BTreeSet::new();
        for threshold in SHIP_BAR {
            assert!(
                seen.insert(threshold.metric),
                "{} appears twice in SHIP_BAR",
                threshold.metric
            );
        }
        assert_eq!(seen.len(), SHIP_BAR.len());
    }

    /// Every limit has to be on the correct side of the English baseline, or
    /// the bar would reject English itself — the one language known to work.
    #[test]
    fn every_limit_gives_slack_in_the_right_direction() {
        for t in SHIP_BAR {
            match t.direction {
                Direction::AtMost => assert!(
                    t.limit >= t.english_baseline,
                    "{}: a ceiling of {} is below the English baseline {}",
                    t.metric,
                    t.limit,
                    t.english_baseline
                ),
                Direction::AtLeast => assert!(
                    t.limit <= t.english_baseline,
                    "{}: a floor of {} is above the English baseline {}",
                    t.metric,
                    t.limit,
                    t.english_baseline
                ),
            }
            assert!(!t.why.is_empty(), "{} needs a rationale", t.metric);
        }
    }

    /// Both tiers have to be represented. A language judged on Tier B alone
    /// has been scored on what the engine estimated rather than on what the
    /// glass showed, which is the distinction Tier C exists for.
    #[test]
    fn the_bar_spans_both_evidence_tiers() {
        assert!(SHIP_BAR.iter().any(|t| t.tier == Tier::B));
        assert!(SHIP_BAR.iter().any(|t| t.tier == Tier::C));
    }

    /// The documented bar and the enforced bar are the same bar.
    ///
    /// `bench/README.md` is where somebody looks up what a language has to
    /// clear, and a README that has drifted from the code is worse than no
    /// README — it is a wrong answer delivered confidently.
    #[test]
    fn the_readme_states_the_coded_bar() {
        let readme = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../bench/README.md");
        let text = std::fs::read_to_string(&readme)
            .unwrap_or_else(|e| panic!("cannot read {}: {e}", readme.display()));

        let table = render_bar_markdown();
        assert!(
            text.contains(&table),
            "bench/README.md no longer states the coded bar. Replace the block \
             between the LANGUAGE GATE TABLE markers with:\n\n{table}"
        );

        // The non-gating decisions are part of the bar too: a reader who does
        // not know `ahead_events` is deliberately excluded will assume it was
        // forgotten.
        for (metric, _) in REPORTED_NOT_GATING {
            assert!(
                text.contains(metric),
                "bench/README.md does not say why {metric} is not gating"
            );
        }
    }

    #[test]
    fn the_rendered_report_names_what_failed_and_why() {
        let mut metrics = english_baseline_metrics();
        metrics.insert("live.ahead_worst".into(), 9.0);
        let report = evaluate("fr", &metrics, &english_corpus());
        let rendered = report.render();
        assert!(rendered.contains("live.ahead_worst"));
        assert!(rendered.contains("FAIL"));
        assert!(rendered.contains("Depth of overshoot"));
    }
}
