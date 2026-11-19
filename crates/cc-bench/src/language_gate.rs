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
//! The baselines are the 18 scoring fixtures of `bench/runs-local`, replayed
//! at `ee5174fd` (2026-11-19) with `--layouts 60hz --focus-lead 0`. The first
//! version of this table was anchored to the same replays averaged over all 21
//! directories, three `fuzzy-follow` diagnostics included, which understated
//! the safety row (2.903 against 3.385 on the core at the time) and the
//! availability row (71.2% against 81.1%). Re-anchoring kept the original
//! proportional headroom on those two rows — 3.34% above English for unread
//! exposure, 1.69% below it for availability — rather than the old absolute
//! limits: 3.0 would fail English itself, and 70% would let a language fall
//! eleven points short of it where the bar meant to allow one. The other six
//! limits barely moved their anchors and are unchanged.
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

use crate::provenance::{primary_subtag, CaptureRecord, Provenance, Source, WeightCatalogue};
use crate::suite::{ScoringTable, SuiteResult};
use crate::tierc::TierCResult;

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
/// "words the display never reached at all", summed over the corpus, and
/// comparing that count over 18 runs against one over 9 is not comparing
/// anything. Diagnostic fixtures may exist
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
/// part of the scored core. It is excluded from the gate's VALUES as well as
/// its fixture count: the three English runs score ~0 unread exposure and ~12%
/// readable availability, so averaging them in moved `gate.unread_never_spoken`
/// from 3.067 to 2.629 and `outcome.readable_availability` from 81.1% to 71.2%.
pub const DIAGNOSTIC_ROLES: &[&str] = &["fuzzy-follow"];

/// Does this fixture count towards the gate?
///
/// Tier B and Tier C both call this while they still hold the raw samples, to
/// build the `ScoringTable` the gate reads.
pub fn is_scoring_run(run: &str) -> bool {
    !DIAGNOSTIC_ROLES.contains(&role_of(run))
}

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
        english_baseline: 6.976,
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
        english_baseline: 95.554,
        limit: 90.0,
        unit: "%",
        why: "Ordinary following accuracy. About five points of slack below English \
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
              distance, and the same 3-word lag is 1.2 seconds at 150 wpm \
              and 2.4 at 75.",
    },
    Threshold {
        metric: "live.dim_never",
        tier: Tier::B,
        direction: Direction::AtMost,
        english_baseline: 0.0,
        limit: 1.0,
        unit: "count",
        why: "WORDS the display never reached before the take ended, summed \
              over the corpus — not runs. The limit is a near-zero absolute \
              rather than a rate, deliberately: a raw word count does not \
              scale cleanly between a corpus and its translation, so the only \
              honest thing to say about it across languages is that it must \
              essentially not happen. English scores 0 across its 18 scoring \
              runs; the one word its corpus never dims is in a fuzzy-follow \
              diagnostic.",
    },
    Threshold {
        metric: "gate.unread_never_spoken",
        tier: Tier::C,
        direction: Direction::AtMost,
        english_baseline: 3.067,
        limit: 3.17,
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
        english_baseline: 81.129,
        limit: 79.76,
        unit: "%",
        why: "How much of the take the next line was actually readable on the \
              glass. The outcome a presenter would describe as 'it worked'.",
    },
    Threshold {
        metric: "time.lag_p50",
        tier: Tier::C,
        direction: Direction::AtMost,
        english_baseline: 708.542,
        limit: 800.0,
        unit: "ms",
        why: "Rendered lag, as opposed to the engine's own estimate of it.",
    },
    Threshold {
        metric: "recover.readable_p50",
        tier: Tier::C,
        direction: Direction::AtMost,
        english_baseline: 2737.5,
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

/// Judge a language from saved Tier B and Tier C results.
///
/// Reads each tier's [`ScoringTable`], never its ordinary `table`: the ordinary
/// table is aggregated over every fixture in the directory, diagnostics
/// included, and the bar is defined over the scoring fixtures alone. A result
/// without a scoring table — saved before it existed, or from a synthetic
/// corpus — is refused rather than read the old way.
///
/// `language` is the CLAIM — the tag the operator says the results are for —
/// and the results' recorded provenance has to agree with it: the language
/// every scoring fixture was captured in, the language the engine compiled the
/// scripts as, and a recogniser that transcribes it, whose recorded weights
/// are the bytes `catalogue` lists for that model.
///
/// Errors mean the files are not the evidence the gate reads; a report with
/// corpus problems means they are, but of the wrong corpus.
pub fn evaluate_saved(
    language: &str,
    tier_b: &SuiteResult,
    tier_c: &TierCResult,
    catalogue: &WeightCatalogue,
) -> anyhow::Result<LanguageGateReport> {
    // Provenance before anything else, so a file saved before it existed is
    // reported as what it is — lacking provenance — and not as whatever else
    // happens to be wrong with it.
    let lacking = |tier: &str, command: &str| {
        anyhow::anyhow!(
            "the {tier} result lacks provenance: it was saved before results \
             recorded the language, recogniser and build that produced them, so \
             it cannot say it is evidence for {language}. Re-run `cc-bench \
             {command} --out FILE` on a corpus captured with `capture-local`"
        )
    };
    let prov_b = tier_b
        .provenance
        .as_ref()
        .ok_or_else(|| lacking("Tier B", "tier-b --runs DIR"))?;
    let prov_c = tier_c
        .provenance
        .as_ref()
        .ok_or_else(|| lacking("Tier C", "tier-c --runs DIR --layouts 60hz --focus-lead 0"))?;
    let captured = |tier: &str, p: &'_ Provenance| -> anyhow::Result<()> {
        match p.source {
            Source::Captured { .. } => Ok(()),
            Source::Synthetic => anyhow::bail!(
                "the {tier} result was replayed from synthetic events, not from a \
                 recogniser; a language's evidence is a captured corpus (--runs DIR)"
            ),
        }
    };
    captured("Tier B", prov_b)?;
    captured("Tier C", prov_c)?;

    // The bar's Tier C numbers were measured on the as-shipped rig, and the
    // evidence has to be that rig alone: a sweep is a different run, made for
    // a different question, even though its headline rows are 60 Hz. The
    // recorded layout is compared field for field, because a 60 Hz run made
    // with a non-zero `focus_lead_atoms` has the same NAME and scores a
    // reading corridor the product does not have.
    let shipped = crate::tierc::shipped_headline_layout();
    if prov_c.layouts != [shipped.clone()] {
        anyhow::bail!(
            "Tier C evidence must be rendered at the as-shipped rig alone \
             (--layouts 60hz --focus-lead 0, i.e. {shipped:?}); this result \
             was rendered at {:?}",
            prov_c.layouts
        );
    }
    let mut layouts: std::collections::BTreeSet<&str> =
        tier_c.by_layout.keys().map(|l| l.as_str()).collect();
    layouts.extend(tier_c.runs.iter().map(|r| r.layout.as_str()));
    if layouts.iter().ne(["60hz"].iter()) {
        anyhow::bail!(
            "Tier C evidence must be the as-shipped rig alone \
             (--layouts 60hz --focus-lead 0); this result carries {:?}",
            layouts
        );
    }

    let missing = |tier: &str, command: &str| {
        anyhow::anyhow!(
            "the {tier} result has no scoring table, so its only numbers are \
             aggregated over every fixture including diagnostics. Re-run \
             `cc-bench {command} --out FILE` on the captured corpus to produce one"
        )
    };
    let b = tier_b
        .scoring
        .as_ref()
        .ok_or_else(|| missing("Tier B", "tier-b --runs DIR"))?;
    let c = tier_c.scoring.as_ref().ok_or_else(|| {
        missing("Tier C", "tier-c --runs DIR --layouts 60hz --focus-lead 0")
    })?;

    // A scoring table is only meaningful if it covers exactly the result's own
    // scoring runs. Anything else is a file that was edited or assembled by
    // hand, and its rows describe a corpus nobody can name.
    check_scoring_runs("Tier B", b, tier_b.runs.iter().map(|r| r.run.as_str()))?;
    check_scoring_runs(
        "Tier C",
        c,
        tier_c
            .runs
            .iter()
            .filter(|r| r.layout == "60hz")
            .map(|r| r.run.as_str()),
    )?;

    // Each row is read from the tier its threshold names, so a value can
    // never be judged against the other tier's threshold, and one metric
    // cannot be supplied twice.
    let mut metrics: BTreeMap<String, f64> = BTreeMap::new();
    for (tier, table) in [(Tier::B, b), (Tier::C, c)] {
        for entry in &table.table {
            if !SHIP_BAR
                .iter()
                .any(|t| t.tier == tier && t.metric == entry.name)
            {
                anyhow::bail!(
                    "the {} scoring table carries {}, which is not one of its \
                     tier's gated metrics",
                    tier.label(),
                    entry.name
                );
            }
            if metrics.insert(entry.name.clone(), entry.value).is_some() {
                anyhow::bail!("{} appears twice in the {} scoring table", entry.name, tier.label());
            }
        }
    }

    let mut report = evaluate(language, &metrics, &b.runs);

    // Both halves of a verdict have to describe the same fixtures, each
    // counted once. Diagnostics may differ between the two directories; the
    // scoring runs may not. (`evaluate` has already checked Tier B's list for
    // duplicates.)
    if let Some(problem) = duplicate_problem(&c.runs) {
        report.corpus_problems.push(format!("Tier C {problem}"));
    }
    let in_b: std::collections::BTreeSet<&String> = b.runs.iter().collect();
    let in_c: std::collections::BTreeSet<&String> = c.runs.iter().collect();
    if in_b != in_c {
        let only = |a: &std::collections::BTreeSet<&String>,
                    z: &std::collections::BTreeSet<&String>| {
            a.difference(z)
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        };
        report.corpus_problems.push(format!(
            "Tier B and Tier C scored different fixtures (only in Tier B: [{}]; \
             only in Tier C: [{}]), so the verdict would combine two corpora",
            only(&in_b, &in_c),
            only(&in_c, &in_b)
        ));
    }

    // Nor may they come from two engine configurations: a verdict whose Tier B
    // half was replayed under one config and its Tier C half under another is
    // not a measurement of anything that exists.
    if serde_json::to_value(&tier_b.config).ok() != serde_json::to_value(&tier_c.config).ok() {
        report.corpus_problems.push(
            "Tier B and Tier C were replayed under different alignment configs, \
             so the verdict would combine two engines"
                .to_string(),
        );
    }

    let scoring = [("Tier B", prov_b, &b.runs), ("Tier C", prov_c, &c.runs)];
    report
        .corpus_problems
        .extend(provenance_problems(language, &scoring, catalogue));
    Ok(report)
}

/// Every way the recorded conditions disagree with the claim or each other.
///
/// Only the scoring fixtures are held to the claim: diagnostics may sit in a
/// corpus captured some other way, exactly as they may differ between the two
/// tiers' directories.
fn provenance_problems(
    language: &str,
    tiers: &[(&str, &Provenance, &Vec<String>)],
    catalogue: &WeightCatalogue,
) -> Vec<String> {
    let claim = primary_subtag(language);
    let mut problems: Vec<String> = Vec::new();
    let mut note = |p: String| {
        if !problems.contains(&p) {
            problems.push(p);
        }
    };
    if claim.is_empty() {
        note("no language was claimed (--label is empty)".to_string());
    }

    for (tier, prov, _) in tiers {
        if prov.revision.commit.is_none() {
            note(format!(
                "{tier} was replayed by a cc-bench build with no recorded revision, \
                 so nobody can say which code produced it"
            ));
        }
        if prov.alignment_language != claim {
            note(format!(
                "{tier} compiled its scripts as {}, not {claim}",
                prov.alignment_language
            ));
        }
    }
    let (_, first, _) = tiers[0];
    for (tier, prov, _) in &tiers[1..] {
        if prov.revision != first.revision {
            note(format!(
                "Tier B and {tier} were replayed by different cc-bench builds ({} and {})",
                first.revision.describe(),
                prov.revision.describe()
            ));
        }
        if prov.app_tokens != first.app_tokens {
            note(format!(
                "Tier B and {tier} compiled scripts differently (CC_BENCH_APP_TOKENS)"
            ));
        }
    }

    // One record per scoring fixture per tier, the same record in both.
    let mut seen: BTreeMap<&str, (&str, &CaptureRecord)> = BTreeMap::new();
    for (tier, prov, runs) in tiers {
        let Source::Captured { runs: records } = &prov.source else {
            continue;
        };
        let mut conditions: Option<(&str, CaptureRecord)> = None;
        for run in runs.iter() {
            let record = match records.get(run) {
                Some(Some(record)) => record,
                Some(None) => {
                    note(format!(
                        "{tier}: {run} has no capture record (captured before \
                         capture.json existed), so nothing says what heard it; \
                         re-capture the corpus"
                    ));
                    continue;
                }
                None => {
                    note(format!(
                        "{tier}: the result's provenance does not cover {run}, \
                         which it scored"
                    ));
                    continue;
                }
            };
            if let Some((other_tier, other)) = seen.get(run.as_str()) {
                if *other != record {
                    note(format!(
                        "{other_tier} and {tier} scored different captures of {run}"
                    ));
                }
            } else {
                seen.insert(run, (tier, record));
            }
            match &conditions {
                None => conditions = Some((run, record.conditions())),
                Some((first_run, c)) if *c != record.conditions() => note(format!(
                    "{tier}: {first_run} and {run} were captured under different \
                     conditions (language, model, weights, recogniser settings, \
                     pace or build), so the corpus is not one measurement"
                )),
                Some(_) => {}
            }
            check_record(&claim, record, catalogue, &mut note);
        }
    }
    problems
}

/// One capture record against the claim and the catalogue.
fn check_record(
    claim: &str,
    record: &CaptureRecord,
    catalogue: &WeightCatalogue,
    note: &mut impl FnMut(String),
) {
    if primary_subtag(&record.language) != claim {
        note(format!(
            "the corpus was captured as {}, not {claim}",
            record.language
        ));
    }
    match cc_stt::model_by_id(&record.model) {
        None => note(format!(
            "the corpus was captured with {}, which this build does not ship",
            record.model
        )),
        Some(model) if !model.serves_language(claim) => note(format!(
            "{} does not transcribe {claim} (it serves {:?})",
            model.id, model.languages
        )),
        Some(_) => {}
    }
    if let Some(why) = catalogue.mismatch(&record.model, &record.weights) {
        note(format!(
            "the recogniser that captured the corpus was not {}'s weights: {why}",
            record.model
        ));
    }
    if record.pace != 1.0 {
        note(format!(
            "the corpus was captured at {}x pace; the bar was measured in real time",
            record.pace
        ));
    }
    if record.revision.commit.is_none() {
        note(
            "the corpus was captured by a cc-bench build with no recorded revision"
                .to_string(),
        );
    }
}

/// `Some(description)` when a scoring list names a fixture more than once.
fn duplicate_problem(runs: &[String]) -> Option<String> {
    let distinct: std::collections::BTreeSet<&String> = runs.iter().collect();
    (distinct.len() != runs.len()).then(|| {
        format!(
            "names {} scoring runs but only {} distinct ones; a fixture scored \
             twice is not two pieces of evidence",
            runs.len(),
            distinct.len()
        )
    })
}

fn check_scoring_runs<'a>(
    tier: &str,
    scoring: &ScoringTable,
    runs: impl Iterator<Item = &'a str>,
) -> anyhow::Result<()> {
    let mut expected: Vec<&str> = runs.filter(|r| is_scoring_run(r)).collect();
    let mut claimed: Vec<&str> = scoring.runs.iter().map(|r| r.as_str()).collect();
    expected.sort_unstable();
    claimed.sort_unstable();
    if expected != claimed {
        let absent = |from: &[&str], other: &[&str]| -> String {
            from.iter()
                .filter(|r| !other.contains(r))
                .copied()
                .collect::<Vec<_>>()
                .join(", ")
        };
        anyhow::bail!(
            "the {tier} scoring table lists {} fixtures but the result scored {} \
             non-diagnostic ones (listed but not scored: [{}]; scored but not \
             listed: [{}]); the file has been altered since the tier wrote it",
            claimed.len(),
            expected.len(),
            absent(&claimed, &expected),
            absent(&expected, &claimed)
        );
    }
    Ok(())
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
        .filter(|r| is_scoring_run(r))
        .collect();

    let core_names: Vec<String> = core.iter().map(|r| (*r).clone()).collect();
    if let Some(problem) = duplicate_problem(&core_names) {
        corpus_problems.push(format!("corpus {problem}"));
    }

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

    const WEIGHTS_SHA: &str = "00ff";

    /// A catalogue in which the shipped model's one file is `WEIGHTS_SHA`.
    fn catalogue() -> WeightCatalogue {
        let mut catalogue = WeightCatalogue::default();
        catalogue.models.insert(
            cc_stt::default_model().id.to_string(),
            [("tokens.txt".to_string(), WEIGHTS_SHA.to_string())]
                .into_iter()
                .collect(),
        );
        catalogue
    }

    fn revision() -> crate::provenance::Revision {
        crate::provenance::Revision {
            commit: Some("0123456789abcdef".into()),
            dirty: false,
        }
    }

    /// What `capture-local` records for an English run of the shipped model.
    fn capture_record(run: &str) -> CaptureRecord {
        let model = cc_stt::default_model();
        CaptureRecord {
            run: run.to_string(),
            language: "en-US".into(),
            model: model.id.into(),
            weights: vec![crate::provenance::WeightFile {
                name: "tokens.txt".into(),
                bytes: 1,
                sha256: WEIGHTS_SHA.into(),
            }],
            recogniser: cc_stt::LocalSttConfig::for_model(model, format!("/models/{run}")),
            pace: 1.0,
            revision: revision(),
            fixture_sha256: format!("digest of {run}"),
        }
    }

    fn provenance(source: Source, layouts: Vec<crate::stage::Layout>) -> Provenance {
        Provenance {
            revision: revision(),
            alignment_language: "en".into(),
            app_tokens: false,
            source,
            layouts,
        }
    }

    /// Every scoring run's record in both tiers, changed the same way.
    fn edit_records(
        b: &mut SuiteResult,
        c: &mut TierCResult,
        edit: impl Fn(&str, &mut CaptureRecord),
    ) {
        for prov in [b.provenance.as_mut().unwrap(), c.provenance.as_mut().unwrap()] {
            let Source::Captured { runs } = &mut prov.source else {
                unreachable!()
            };
            for (run, record) in runs.iter_mut() {
                edit(run, record.as_mut().unwrap());
            }
        }
    }

    /// Saved results as captured Tier B and Tier C write them: ordinary tables
    /// over every fixture, scoring tables over the core alone.
    fn saved(
        corpus: &[String],
        ordinary: &BTreeMap<String, f64>,
        scoring: &BTreeMap<String, f64>,
    ) -> (SuiteResult, TierCResult) {
        use crate::metrics::RunMetrics;
        use crate::perceptual::PerceptualMetrics;
        use crate::suite::BenchEntry;

        let rows = |tier: Tier, values: &BTreeMap<String, f64>| -> Vec<BenchEntry> {
            SHIP_BAR
                .iter()
                .filter(|t| t.tier == tier)
                .filter_map(|t| {
                    values.get(t.metric).map(|v| BenchEntry {
                        name: t.metric.to_string(),
                        value: *v,
                        unit: t.unit.to_string(),
                        better: "lower".to_string(),
                    })
                })
                .collect()
        };
        let core: Vec<String> = corpus.iter().filter(|r| is_scoring_run(r)).cloned().collect();
        let source = Source::Captured {
            runs: corpus
                .iter()
                .map(|r| (r.clone(), Some(capture_record(r))))
                .collect(),
        };
        let tier_b = SuiteResult {
            label: "t".into(),
            config: cc_align::AlignmentConfig::default(),
            table: rows(Tier::B, ordinary),
            runs: corpus
                .iter()
                .map(|r| RunMetrics {
                    run: r.clone(),
                    ..Default::default()
                })
                .collect(),
            scoring: Some(ScoringTable {
                runs: core.clone(),
                table: rows(Tier::B, scoring),
            }),
            provenance: Some(provenance(source.clone(), Vec::new())),
        };
        let tier_c = TierCResult {
            label: "t".into(),
            config: cc_align::AlignmentConfig::default(),
            table: rows(Tier::C, ordinary),
            runs: corpus
                .iter()
                .map(|r| PerceptualMetrics {
                    run: r.clone(),
                    layout: "60hz".into(),
                    ..Default::default()
                })
                .collect(),
            by_layout: [("60hz".to_string(), Vec::new())].into_iter().collect(),
            scoring: Some(ScoringTable {
                runs: core,
                table: rows(Tier::C, scoring),
            }),
            provenance: Some(provenance(
                source,
                vec![crate::tierc::shipped_headline_layout()],
            )),
        };
        (tier_b, tier_c)
    }

    /// The defect this replaced: diagnostics that score ~0 unread exposure
    /// diluted the ordinary table enough to pass a corpus whose core fails.
    #[test]
    fn the_gate_reads_the_scoring_table_not_the_ordinary_one() {
        let good = english_baseline_metrics();
        let mut bad = good.clone();
        bad.insert("gate.unread_never_spoken".into(), 3.5);
        bad.insert("live.within5".into(), 80.0);

        let (b, c) = saved(&english_corpus(), &good, &bad);
        let report = evaluate_saved("en", &b, &c, &catalogue()).unwrap();
        let failed: Vec<&str> = report.failures().map(|r| r.threshold.metric).collect();
        assert_eq!(failed, vec!["live.within5", "gate.unread_never_spoken"]);

        let (b, c) = saved(&english_corpus(), &bad, &good);
        assert!(evaluate_saved("en", &b, &c, &catalogue()).unwrap().passed());
    }

    /// A file saved before scoring tables existed holds only the diluted
    /// numbers, and reading them would reproduce the defect.
    #[test]
    fn a_result_without_a_scoring_table_is_refused() {
        let m = english_baseline_metrics();
        let (mut b, c) = saved(&english_corpus(), &m, &m);
        b.scoring = None;
        let err = evaluate_saved("en", &b, &c, &catalogue()).unwrap_err().to_string();
        assert!(err.contains("Tier B") && err.contains("tier-b"), "{err}");

        let (b, mut c) = saved(&english_corpus(), &m, &m);
        c.scoring = None;
        let err = evaluate_saved("en", &b, &c, &catalogue()).unwrap_err().to_string();
        assert!(err.contains("Tier C") && err.contains("tier-c"), "{err}");
    }

    #[test]
    fn a_scoring_table_that_disagrees_with_its_own_runs_is_refused() {
        let m = english_baseline_metrics();

        let refused_by = |b: &SuiteResult, c: &TierCResult| -> String {
            evaluate_saved("en", b, c, &catalogue()).unwrap_err().to_string()
        };

        // A diagnostic counted into the scoring set.
        let (mut b, c) = saved(&english_corpus(), &m, &m);
        b.scoring.as_mut().unwrap().runs.push("fuzzy-follow__fuzzy_voice__xai".into());
        assert!(refused_by(&b, &c).contains("Tier B scoring table"));

        // A core fixture the result scored, missing from the set.
        let (b, mut c) = saved(&english_corpus(), &m, &m);
        c.scoring.as_mut().unwrap().runs.pop();
        assert!(refused_by(&b, &c).contains("Tier C scoring table"));

        // Same length, different fixture: a count comparison would miss it.
        let (b, mut c) = saved(&english_corpus(), &m, &m);
        c.scoring.as_mut().unwrap().runs[0] = "brands__exact__gemini".into();
        let err = refused_by(&b, &c);
        assert!(err.contains("Tier C scoring table"), "{err}");
        assert!(
            err.contains("brands__exact__gemini") && err.contains("brands__exact__xai"),
            "the refusal should name both sides of the substitution: {err}"
        );
    }

    /// A fixture duplicated in one tier's directory is weighted twice there,
    /// and a set comparison between the tiers cannot see it.
    #[test]
    fn a_fixture_scored_twice_by_tier_c_alone_is_not_evidence() {
        let m = english_baseline_metrics();
        let (b, _) = saved(&english_corpus(), &m, &m);
        let mut doubled = english_corpus();
        doubled.push("refrain__exact__gemini".into());
        let (_, c) = saved(&doubled, &m, &m);
        let report = evaluate_saved("en", &b, &c, &catalogue()).unwrap();
        assert!(!report.passed());
        assert!(
            report.corpus_problems.iter().any(|p| p.starts_with("Tier C") && p.contains("distinct")),
            "{:?}",
            report.corpus_problems
        );
    }

    #[test]
    fn both_tiers_must_be_replayed_under_one_config() {
        let m = english_baseline_metrics();
        let (b, mut c) = saved(&english_corpus(), &m, &m);
        c.config.lead_margin_atoms += 1.0;
        let report = evaluate_saved("en", &b, &c, &catalogue()).unwrap();
        assert!(!report.passed());
        assert!(report.corpus_problems.iter().any(|p| p.contains("config")));
    }

    /// Two different 18-fixture corpora would each pass the count and the
    /// coverage check, and the verdict would combine them.
    #[test]
    fn both_tiers_must_score_the_same_fixtures() {
        let m = english_baseline_metrics();
        let (b, _) = saved(&english_corpus(), &m, &m);
        let mut other = english_corpus();
        let swapped = other
            .iter()
            .position(|r| r == "starter__exact__gemini")
            .unwrap();
        other[swapped] = "starter__exact__qwen".into();
        let (_, c) = saved(&other, &m, &m);

        let report = evaluate_saved("en", &b, &c, &catalogue()).unwrap();
        assert!(!report.passed());
        let problem = report.corpus_problems.join("\n");
        assert!(
            problem.contains("starter__exact__gemini") && problem.contains("starter__exact__qwen"),
            "{problem}"
        );

        // Diagnostics, by contrast, may differ between the two directories.
        let core_only: Vec<String> = english_corpus()
            .into_iter()
            .filter(|r| is_scoring_run(r))
            .collect();
        let (_, c) = saved(&core_only, &m, &m);
        assert!(evaluate_saved("en", &b, &c, &catalogue()).unwrap().passed());
    }

    #[test]
    fn a_fixture_named_twice_is_not_two_fixtures() {
        let m = english_baseline_metrics();
        let mut runs = english_corpus();
        let first = runs[0].clone();
        let at = runs.iter().position(|r| r == "starter__exact__gemini").unwrap();
        runs[at] = first;
        let report = evaluate("en", &m, &runs);
        assert!(!report.passed());
        assert!(report.corpus_problems.iter().any(|p| p.contains("distinct")));
    }

    #[test]
    fn tier_c_must_be_the_as_shipped_layout_alone() {
        let m = english_baseline_metrics();
        let (b, mut c) = saved(&english_corpus(), &m, &m);
        c.by_layout.insert("30hz".into(), Vec::new());
        assert!(evaluate_saved("en", &b, &c, &catalogue()).is_err(), "an extra layout");

        // One layout, but the wrong one.
        let (b, mut c) = saved(&english_corpus(), &m, &m);
        c.by_layout = [("30hz".to_string(), Vec::new())].into_iter().collect();
        for r in &mut c.runs {
            r.layout = "30hz".into();
        }
        assert!(evaluate_saved("en", &b, &c, &catalogue()).is_err(), "a lone 30hz rig");

        // A sweep with its other layouts trimmed from the summary only.
        let (b, mut c) = saved(&english_corpus(), &m, &m);
        let mut extra = c.runs[0].clone();
        extra.layout = "120hz".into();
        c.runs.push(extra);
        assert!(evaluate_saved("en", &b, &c, &catalogue()).is_err(), "runs at another layout");
    }

    /// The hole the layout NAME left: a 60 Hz run with the harness's reading
    /// corridor switched on is called `60hz` too, and moves a gated row.
    #[test]
    fn tier_c_must_be_rendered_without_focus_lead() {
        let m = english_baseline_metrics();
        let (b, c) = saved(&english_corpus(), &m, &m);
        assert!(evaluate_saved("en", &b, &c, &catalogue()).unwrap().passed());

        let (b, mut c) = saved(&english_corpus(), &m, &m);
        c.provenance.as_mut().unwrap().layouts[0].focus_lead_atoms = 3.0;
        let err = evaluate_saved("en", &b, &c, &catalogue()).unwrap_err().to_string();
        assert!(err.contains("focus-lead 0"), "{err}");

        // Lead 0, but some other geometry under the same name.
        let (b, mut c) = saved(&english_corpus(), &m, &m);
        c.provenance.as_mut().unwrap().layouts[0].atoms_per_line = 4.0;
        assert!(evaluate_saved("en", &b, &c, &catalogue()).is_err());

        // A sweep: the right layout and others beside it.
        let (b, mut c) = saved(&english_corpus(), &m, &m);
        c.provenance.as_mut().unwrap().layouts.push(crate::tierc::layouts_for(None)[0].clone());
        assert!(evaluate_saved("en", &b, &c, &catalogue()).is_err());
    }

    /// The defect in the issue: English results labelled `fr` passed as French.
    #[test]
    fn english_evidence_is_not_evidence_for_another_language() {
        let m = english_baseline_metrics();
        let (b, c) = saved(&english_corpus(), &m, &m);
        let report = evaluate_saved("fr", &b, &c, &catalogue()).unwrap();
        assert!(!report.passed());
        let problems = report.corpus_problems.join("\n");
        assert!(problems.contains("captured as en-US, not fr"), "{problems}");
        assert!(problems.contains("compiled its scripts as en, not fr"), "{problems}");
        assert!(problems.contains("does not transcribe fr"), "{problems}");

        // A region is not a different language.
        assert!(evaluate_saved("en-GB", &b, &c, &catalogue()).unwrap().passed());
        assert!(evaluate_saved("EN", &b, &c, &catalogue()).unwrap().passed());
    }

    /// A corpus declared as a language the model serves is still refused when
    /// the engine compiled the scripts as something else.
    #[test]
    fn a_served_language_the_engine_did_not_compile_is_refused() {
        let m = english_baseline_metrics();
        let (mut b, mut c) = saved(&english_corpus(), &m, &m);
        edit_records(&mut b, &mut c, |_, r| r.language = "zh".into());
        let report = evaluate_saved("zh", &b, &c, &catalogue()).unwrap();
        let problems = report.corpus_problems.join("\n");
        assert!(problems.contains("compiled its scripts as en, not zh"), "{problems}");
        assert!(!problems.contains("captured as"), "{problems}");
    }

    #[test]
    fn results_saved_before_provenance_load_and_are_refused_as_lacking_it() {
        let m = english_baseline_metrics();
        let (b, c) = saved(&english_corpus(), &m, &m);
        // What a pre-provenance file looks like: the same JSON, no key.
        let strip = |v: serde_json::Value| {
            let mut v = v;
            v.as_object_mut().unwrap().remove("provenance").unwrap();
            serde_json::to_string(&v).unwrap()
        };
        let old_b: SuiteResult =
            serde_json::from_str(&strip(serde_json::to_value(&b).unwrap())).unwrap();
        let old_c: TierCResult =
            serde_json::from_str(&strip(serde_json::to_value(&c).unwrap())).unwrap();
        assert!(old_b.provenance.is_none() && old_c.provenance.is_none());

        let err = evaluate_saved("en", &old_b, &c, &catalogue()).unwrap_err().to_string();
        assert!(err.contains("Tier B result lacks provenance"), "{err}");
        let err = evaluate_saved("en", &b, &old_c, &catalogue()).unwrap_err().to_string();
        assert!(err.contains("Tier C result lacks provenance"), "{err}");
    }

    #[test]
    fn synthetic_evidence_is_refused() {
        let m = english_baseline_metrics();
        let (mut b, c) = saved(&english_corpus(), &m, &m);
        b.provenance.as_mut().unwrap().source = Source::Synthetic;
        let err = evaluate_saved("en", &b, &c, &catalogue()).unwrap_err().to_string();
        assert!(err.contains("synthetic"), "{err}");
    }

    #[test]
    fn a_scoring_run_without_a_capture_record_is_refused() {
        let m = english_baseline_metrics();
        let (b, mut c) = saved(&english_corpus(), &m, &m);
        let Source::Captured { runs } = &mut c.provenance.as_mut().unwrap().source else {
            unreachable!()
        };
        *runs.get_mut("starter__exact__gemini").unwrap() = None;
        let report = evaluate_saved("en", &b, &c, &catalogue()).unwrap();
        let problems = report.corpus_problems.join("\n");
        assert!(
            problems.contains("Tier C: starter__exact__gemini has no capture record"),
            "{problems}"
        );

        // A diagnostic without one is not the claim's business.
        let (b, mut c) = saved(&english_corpus(), &m, &m);
        let Source::Captured { runs } = &mut c.provenance.as_mut().unwrap().source else {
            unreachable!()
        };
        *runs.get_mut("fuzzy-follow__fuzzy_voice__xai").unwrap() = None;
        assert!(evaluate_saved("en", &b, &c, &catalogue()).unwrap().passed());
    }

    #[test]
    fn the_recorded_weights_must_be_the_catalogued_model() {
        let m = english_baseline_metrics();
        let (mut b, mut c) = saved(&english_corpus(), &m, &m);
        edit_records(&mut b, &mut c, |_, r| r.weights[0].sha256 = "beef".into());
        let report = evaluate_saved("en", &b, &c, &catalogue()).unwrap();
        assert!(
            report.corpus_problems.iter().any(|p| p.contains("digest differs")),
            "{:?}",
            report.corpus_problems
        );

        let (mut b, mut c) = saved(&english_corpus(), &m, &m);
        edit_records(&mut b, &mut c, |_, r| r.model = "some-other-model".into());
        let problems = evaluate_saved("en", &b, &c, &catalogue()).unwrap().corpus_problems.join("\n");
        assert!(problems.contains("does not ship"), "{problems}");
    }

    /// One fixture captured another way is enough to make the corpus two
    /// measurements; the machine-local model path is not such a difference.
    #[test]
    fn a_corpus_captured_under_mixed_conditions_is_refused() {
        let m = english_baseline_metrics();
        let (mut b, mut c) = saved(&english_corpus(), &m, &m);
        edit_records(&mut b, &mut c, |run, r| {
            if run == "names__exact__xai" {
                r.recogniser.blank_penalty = 0.0;
            }
        });
        let problems = evaluate_saved("en", &b, &c, &catalogue()).unwrap().corpus_problems.join("\n");
        assert!(problems.contains("names__exact__xai") && problems.contains("different conditions"), "{problems}");

        // The helper already gives every run a different model_dir.
        let (b, c) = saved(&english_corpus(), &m, &m);
        assert!(evaluate_saved("en", &b, &c, &catalogue()).unwrap().passed());
    }

    #[test]
    fn both_tiers_must_score_the_same_capture_from_the_same_build() {
        let m = english_baseline_metrics();
        let (b, mut c) = saved(&english_corpus(), &m, &m);
        let Source::Captured { runs } = &mut c.provenance.as_mut().unwrap().source else {
            unreachable!()
        };
        runs.get_mut("refrain__exact__gemini").unwrap().as_mut().unwrap().fixture_sha256 =
            "another capture".into();
        let problems = evaluate_saved("en", &b, &c, &catalogue()).unwrap().corpus_problems.join("\n");
        assert!(problems.contains("different captures of refrain__exact__gemini"), "{problems}");

        let (b, mut c) = saved(&english_corpus(), &m, &m);
        c.provenance.as_mut().unwrap().revision.commit = Some("fedcba".into());
        let problems = evaluate_saved("en", &b, &c, &catalogue()).unwrap().corpus_problems.join("\n");
        assert!(problems.contains("different cc-bench builds"), "{problems}");

        let (mut b, c) = saved(&english_corpus(), &m, &m);
        b.provenance.as_mut().unwrap().revision.commit = None;
        let problems = evaluate_saved("en", &b, &c, &catalogue()).unwrap().corpus_problems.join("\n");
        assert!(problems.contains("no recorded revision"), "{problems}");
    }

    #[test]
    fn a_corpus_not_captured_in_real_time_is_refused() {
        let m = english_baseline_metrics();
        let (mut b, mut c) = saved(&english_corpus(), &m, &m);
        edit_records(&mut b, &mut c, |_, r| r.pace = 4.0);
        assert!(!evaluate_saved("en", &b, &c, &catalogue()).unwrap().passed());
    }

    /// A row is judged only from the tier its threshold names, and only once.
    #[test]
    fn a_row_in_the_wrong_tier_or_twice_is_refused() {
        let m = english_baseline_metrics();

        // Tier C's rows supplied by Tier B, with Tier C's table empty: every
        // metric is still present exactly once, which a merged lookup accepts.
        let (mut b, mut c) = saved(&english_corpus(), &m, &m);
        let moved = std::mem::take(&mut c.scoring.as_mut().unwrap().table);
        b.scoring.as_mut().unwrap().table.extend(moved);
        let err = evaluate_saved("en", &b, &c, &catalogue()).unwrap_err().to_string();
        assert!(err.contains("Tier B scoring table carries gate."), "{err}");

        let (b, mut c) = saved(&english_corpus(), &m, &m);
        let again = c.scoring.as_ref().unwrap().table[0].clone();
        c.scoring.as_mut().unwrap().table.push(again);
        let err = evaluate_saved("en", &b, &c, &catalogue()).unwrap_err().to_string();
        assert!(err.contains("twice"), "{err}");
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
