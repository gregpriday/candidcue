//! cc-bench CLI.
//!
//! ```text
//! cc-bench tier-a  --label L [--config cfg.json] [--out results.json]
//! cc-bench synth-audio --workdir DIR            # fal.ai TTS → fixture audio
//! cc-bench capture-local --workdir DIR --model DIR --runs DIR [--pace 1.0]
//! cc-bench vocab [SCRIPT ...]                   # show extracted bias terms
//! cc-bench tier-b  --label L [--config C] [--out F]
//! cc-bench compare baseline.json candidate.json
//! ```

use std::path::PathBuf;

use cc_align::AlignmentConfig;
use cc_bench::language_gate;
use cc_bench::plan::expand;
use cc_bench::scenarios::{build_suite, tier_b_selection};
use cc_bench::suite::{
    compare_tables, print_table, run_tier_a, run_tier_b, RunManifest, SuiteResult,
};
use cc_bench::tierc::TierCResult;
use cc_bench::tts::{shared_rendered_dir, synthesize, wav_bytes, Synthesizer};

/// Scripts `vocab` reports on when none are named: the three written to
/// exercise term extraction — proper names, brand spellings, and figures.
const VOCAB_SCRIPTS: &[&str] = &["names", "brands", "figures"];

/// Render the Tier-C table, then the per-layout headline.
///
/// The per-layout block is not decoration: the whole claim of the jerk-limited
/// controller is that it behaves the same at every refresh rate, and one averaged
/// number cannot check a claim about seven rigs.
fn print_tier_c(result: &TierCResult, verbose: bool) {
    println!("== {} (tier C: rendered stage) ==", result.label);
    let mut section = String::new();
    for e in &result.table {
        let prefix = e.name.split('.').next().unwrap_or("").to_string();
        if prefix != section {
            println!();
            section = prefix;
        }
        println!(
            "{:38} {:>10.3} {:<9} ({} is better)",
            e.name, e.value, e.unit, e.better
        );
    }
    println!("\n-- by layout --");
    let names: Vec<&String> = result.by_layout.keys().collect();
    if let Some(first) = result.by_layout.values().next() {
        print!("{:26}", "metric");
        for n in &names {
            print!(" {:>13}", n);
        }
        println!();
        for (i, row) in first.iter().enumerate() {
            print!("{:26}", row.name);
            for n in &names {
                let v = result.by_layout[*n]
                    .get(i)
                    .map(|e| e.value)
                    .unwrap_or(f64::NAN);
                print!(" {:>13.3}", v);
            }
            println!();
        }
    }
    if verbose {
        println!("\n-- per run (headline layout) --");
        for r in result.runs.iter().filter(|r| r.layout == "60hz") {
            println!(
                "{:34} readable {:>6.2}%  half-dim p50 {:>7.1}ms  unread {:>7.4}  \
                 band {:>6.2}%  disruptions {:>3}",
                r.run,
                r.readable_availability,
                r.half_dim_p50,
                r.uie_mean,
                r.band_occupancy_pct,
                r.disruptions,
            );
        }
    }
}

fn repo_root() -> PathBuf {
    let mut dir = std::env::current_dir().expect("cwd");
    loop {
        if dir.join("bench/scripts").is_dir() {
            return dir;
        }
        if !dir.pop() {
            panic!("bench/scripts not found above the working directory");
        }
    }
}

struct Flags {
    label: String,
    config: Option<PathBuf>,
    out: Option<PathBuf>,
    workdir: Option<PathBuf>,
    pace: f64,
    runs: Option<PathBuf>,
    /// `export-run`: seconds of audio to freeze. None means the whole run.
    seconds: Option<f64>,
    /// `capture-local`: directory holding the on-device model files.
    model: Option<PathBuf>,
    /// `capture-local`: ms of silence to prime the decoder with. `None` means
    /// "use the model's own tuned value", for the same reason `blank_penalty`
    /// below is optional.
    prime_ms: Option<u32>,
    /// `capture-local`: blank penalty override. `None` means "use the
    /// recogniser's own default" — a plain `f32` here silently overrode the
    /// tuned default with 0.0 and captured a whole corpus with the knob off.
    blank_penalty: Option<f32>,
    /// `capture-local`: `greedy_search` | `modified_beam_search`.
    decoding: Option<String>,
    /// `tier-c`: which rendered layouts to score. None means the whole sweep.
    layouts: Option<Vec<String>>,
    /// `robustness`: perturbations to evaluate per scenario.
    budget: usize,
    /// `tier-c`: aim the reading corridor this many atoms ahead of the tracked
    /// position. See `Layout::focus_lead_atoms`.
    focus_lead: Option<f64>,
    /// `gate-language`: the saved Tier B result to judge.
    tier_b: Option<PathBuf>,
    /// `gate-language`: the saved Tier C result to judge. Must have been run
    /// at the as-shipped layout (`--layouts 60hz --focus-lead 0`), or it scores
    /// a reading corridor the product does not have.
    tier_c: Option<PathBuf>,
    verbose: bool,
}

fn parse_flags<'a>(it: impl Iterator<Item = &'a String>) -> anyhow::Result<Flags> {
    let mut flags = Flags {
        label: "run".into(),
        config: None,
        out: None,
        workdir: None,
        pace: 1.0,
        runs: None,
        seconds: None,
        tier_b: None,
        tier_c: None,
        model: None,
        prime_ms: None,
        blank_penalty: None,
        decoding: None,
        layouts: None,
        budget: 240,
        focus_lead: None,
        verbose: false,
    };
    let mut it = it.peekable();
    while let Some(arg) = it.next() {
        let mut take = || {
            it.next()
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("missing value after {arg}"))
        };
        match arg.as_str() {
            "--label" => flags.label = take()?,
            "--config" => flags.config = Some(PathBuf::from(take()?)),
            "--out" => flags.out = Some(PathBuf::from(take()?)),
            "--workdir" => flags.workdir = Some(PathBuf::from(take()?)),
            "--pace" => flags.pace = take()?.parse()?,
            "--runs" => flags.runs = Some(PathBuf::from(take()?)),
            "--tier-b" => flags.tier_b = Some(PathBuf::from(take()?)),
            "--tier-c" => flags.tier_c = Some(PathBuf::from(take()?)),
            "--seconds" => flags.seconds = Some(take()?.parse()?),
            "--model" => flags.model = Some(PathBuf::from(take()?)),
            "--prime-ms" => flags.prime_ms = Some(take()?.parse()?),
            "--blank-penalty" => flags.blank_penalty = Some(take()?.parse()?),
            "--decoding" => flags.decoding = Some(take()?),
            "--budget" => flags.budget = take()?.parse()?,
            "--focus-lead" => flags.focus_lead = Some(take()?.parse()?),
            "--verbose" => flags.verbose = true,
            "--layouts" => {
                flags.layouts =
                    Some(take()?.split(',').map(|s| s.trim().to_string()).collect())
            }
            other => anyhow::bail!("unknown flag {other}"),
        }
    }
    Ok(flags)
}

fn load_config(path: &Option<PathBuf>) -> anyhow::Result<AlignmentConfig> {
    Ok(match path {
        Some(p) => serde_json::from_str(&std::fs::read_to_string(p)?)?,
        None => AlignmentConfig::default(),
    })
}

fn save_result(result: &SuiteResult, out: &Option<PathBuf>) -> anyhow::Result<()> {
    if let Some(out) = out {
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(out, serde_json::to_string_pretty(result)?)?;
        println!("wrote {}", out.display());
    }
    Ok(())
}

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let root = repo_root();
    let scripts_dir = root.join("bench/scripts");
    let runs_dir = root.join("bench/runs");

    match args.first().map(String::as_str) {
        Some("tier-a") => {
            let flags = parse_flags(args[1..].iter())?;
            let config = load_config(&flags.config)?;
            let result = run_tier_a(&scripts_dir, &config, &flags.label)?;
            print_table(&result);
            save_result(&result, &flags.out)?;
        }
        Some("tier-b") => {
            let flags = parse_flags(args[1..].iter())?;
            let config = load_config(&flags.config)?;
            // `--runs` points the suite at a fixture set other than the frozen
            // corpus — how a vocabulary capture gets scored on the same ruler.
            let runs_dir = flags.runs.unwrap_or(runs_dir);
            let result = run_tier_b(&runs_dir, &scripts_dir, &config, &flags.label)?;
            print_table(&result);
            save_result(&result, &flags.out)?;
        }
        Some("tier-c") => {
            // Tier C: the same engine output, driven through the stage model —
            // line map, jerk-limited plant, per-word opacity ramp — and scored on
            // what the presenter would have seen rather than on a scalar.
            let flags = parse_flags(args[1..].iter())?;
            let config = load_config(&flags.config)?;
            let mut layouts = cc_bench::tierc::layouts_for(flags.layouts.as_deref());
            anyhow::ensure!(!layouts.is_empty(), "no layouts matched --layouts");
            if let Some(lead) = flags.focus_lead {
                for l in layouts.iter_mut() {
                    l.focus_lead_atoms = lead;
                }
            }
            let result = match &flags.runs {
                // `--runs` scores captured recogniser output through the stage
                // model: the closest thing to a real take anything automated on
                // this machine can reach.
                Some(dir) => cc_bench::tierc::run_tier_c_captured(
                    dir,
                    &scripts_dir,
                    &config,
                    &flags.label,
                    &layouts,
                )?,
                None => cc_bench::tierc::run_tier_c(&scripts_dir, &config, &flags.label, &layouts)?,
            };
            print_tier_c(&result, flags.verbose);
            if let Some(out) = &flags.out {
                if let Some(parent) = out.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::write(out, serde_json::to_string_pretty(&result)?)?;
                println!("wrote {}", out.display());
            }
        }
        Some("compare-c") => {
            anyhow::ensure!(args.len() >= 3, "usage: compare-c baseline.json candidate.json");
            // Only the table is needed, and reading only the table is
            // deliberate: `runs` carries ninety-odd per-run metrics, any of which
            // can legitimately be NaN, and a comparison must not fail because a
            // metric it is not printing had an empty sample set.
            #[derive(serde::Deserialize)]
            struct Comparable {
                label: String,
                table: Vec<cc_bench::suite::BenchEntry>,
            }
            let read = |p: &str| -> anyhow::Result<Comparable> {
                Ok(serde_json::from_str(&std::fs::read_to_string(p)?)?)
            };
            let base = read(&args[1])?;
            let cand = read(&args[2])?;
            print!(
                "{}",
                cc_bench::suite::compare_entry_tables(
                    &base.label,
                    &base.table,
                    &cand.label,
                    &cand.table
                )
            );
        }
        Some("difficulty") => {
            // What the corpus is actually like. A benchmark can look excellent
            // simply because its scripts are easy to locate in.
            for stem in cc_bench::scenarios::corpus_scripts() {
                let path = scripts_dir.join(format!("{stem}.md"));
                let Ok(source) = std::fs::read_to_string(&path) else {
                    continue;
                };
                let script = cc_align::compile(&source, cc_align::CompileOptions::default());
                let d = cc_bench::difficulty::analyse(stem, &script);
                println!(
                    "{:16} {:>5} atoms  U50={:.0} U90={:.0}  ambiguous={:>5.1}%  \
                     anchors={:.2} (floor {:.2})  stopwords={:>4.1}%  paras={:>3} (max {})",
                    d.script,
                    d.atoms,
                    d.uniqueness_p50,
                    d.uniqueness_p90,
                    d.ambiguous_pct,
                    d.anchor_density,
                    d.min_window_anchor_density,
                    d.stopword_pct,
                    d.paragraphs,
                    d.longest_paragraph,
                );
            }
        }
        Some("metamorphic") => {
            // Invariants that need no gold timeline: the transformation IS the
            // oracle. Cheap enough to run over the whole corpus.
            let flags = parse_flags(args[1..].iter())?;
            let config = load_config(&flags.config)?;
            let suite = build_suite(&scripts_dir)?;
            let mut failures = 0usize;
            let mut total = 0usize;
            for scenario in suite.iter().filter(|s| s.plan.scenario == "exact") {
                let path = scripts_dir.join(format!("{}.md", scenario.plan.script));
                let source = std::fs::read_to_string(&path)?;
                let performance = expand(&scenario.plan, &scenario.script);
                let gold = cc_bench::plan::synthetic_timing(&performance, scenario.wpm);
                let events = cc_bench::synthetic::generate_events(
                    &gold,
                    &scenario.plan.corruption,
                    scenario.plan.seed,
                );
                for r in cc_bench::robustness::metamorphic_battery(
                    &scenario.plan.script,
                    &source,
                    &config,
                    &events,
                ) {
                    total += 1;
                    if !r.passed {
                        failures += 1;
                        println!(
                            "FAIL {:34} {:16} divergence {:.3} — {}",
                            r.name, r.script, r.worst_divergence, r.detail
                        );
                    } else if flags.verbose {
                        println!("ok   {:34} {:16} divergence {:.6}", r.name, r.script, r.worst_divergence);
                    }
                }
            }
            println!("\nmetamorphic: {}/{} invariants held", total - failures, total);
            anyhow::ensure!(failures == 0, "{failures} metamorphic invariant(s) violated");
        }
        Some("robustness") => {
            // How much recogniser corruption does unsafe behaviour actually
            // require? A radius, not a pass/fail: the objective is to push the
            // cost of a false jump beyond anything a real recogniser produces.
            let flags = parse_flags(args[1..].iter())?;
            let config = load_config(&flags.config)?;
            let suite = build_suite(&scripts_dir)?;
            let mut radii: Vec<f64> = Vec::new();
            let mut unbroken = 0usize;
            for scenario in suite.iter().filter(|s| {
                matches!(s.plan.scenario.as_str(), "exact" | "skip_forward" | "retake")
            }) {
                let path = scripts_dir.join(format!("{}.md", scenario.plan.script));
                let source = std::fs::read_to_string(&path)?;
                let performance = expand(&scenario.plan, &scenario.script);
                let gold = cc_bench::plan::synthetic_timing(&performance, scenario.wpm);
                let events = cc_bench::synthetic::generate_events(
                    &gold,
                    &scenario.plan.corruption,
                    scenario.plan.seed,
                );
                let pass = cc_bench::passgold::PassGold::derive(&gold);
                let r = cc_bench::robustness::adversarial_search(
                    &scenario.plan.script,
                    &scenario.plan.scenario,
                    &source,
                    &config,
                    &events,
                    &pass,
                    flags.budget,
                    scenario.plan.seed,
                );
                match r.radius() {
                    Some(rad) => {
                        radii.push(rad);
                        println!(
                            "{:16} {:18} radius {:>6.2}  (jump {:?} conf {:?} ink {:?}) {} evaluated",
                            r.script,
                            r.scenario,
                            rad,
                            r.false_jump_radius.map(|v| (v * 100.0).round() / 100.0),
                            r.false_confidence_radius.map(|v| (v * 100.0).round() / 100.0),
                            r.unread_ink_radius.map(|v| (v * 100.0).round() / 100.0),
                            r.evaluated,
                        );
                    }
                    None => {
                        unbroken += 1;
                        println!(
                            "{:16} {:18} UNBROKEN in {} perturbations",
                            r.script, r.scenario, r.evaluated
                        );
                    }
                }
            }
            radii.sort_by(|a, b| a.partial_cmp(b).unwrap());
            /*
             * "radius p05 NaN, p50 NaN" is what this printed when nothing broke,
             * and a NaN in a summary line reads as a measurement that failed
             * rather than as a result. There is no radius when every scenario
             * survives the whole budget — that is the outcome, and it deserves
             * saying in words.
             */
            if radii.is_empty() {
                println!(
                    "\nrobustness: {unbroken} unbroken, none broken — no radius to report \
                     (raise --budget to search harder)"
                );
            } else {
                println!(
                    "\nrobustness: {unbroken} unbroken, {} broken; radius p05 {:.2}, p50 {:.2}",
                    radii.len(),
                    cc_bench::perceptual::pctl(&radii, 5.0),
                    cc_bench::perceptual::pctl(&radii, 50.0),
                );
            }
        }
        Some("synth-audio") => {
            let flags = parse_flags(args[1..].iter())?;
            let workdir = flags
                .workdir
                .ok_or_else(|| anyhow::anyhow!("--workdir required"))?;
            // `--runs` names the corpus this audio is destined for. Synthesis
            // skips a run that corpus already holds, so pointing it at a fresh
            // corpus is what makes the audio get rendered a second time for a
            // different recogniser instead of being skipped as "captured".
            let runs_dir = flags.runs.unwrap_or(runs_dir);
            let runtime = tokio::runtime::Runtime::new()?;
            runtime.block_on(synth_audio(&scripts_dir, &runs_dir, &workdir))?;
        }
        Some("capture-local") => {
            // Synthesised audio heard by the on-device recogniser, written
            // into its own corpus so `tier-b --runs` can score it on the same
            // ruler as the corpora already in bench/.
            //
            // `--runs` is required rather than defaulted for a reason: the TTS
            // is not deterministic (the same plan re-synthesised differs by up
            // to 9 s), so a capture must never land on top of a frozen corpus —
            // that would confound a recogniser change with an audio change.
            let flags = parse_flags(args[1..].iter())?;
            let workdir = flags
                .workdir
                .ok_or_else(|| anyhow::anyhow!("--workdir required"))?;
            let model_dir = flags
                .model
                .ok_or_else(|| anyhow::anyhow!("--model <dir> required"))?;
            let out_runs = flags
                .runs
                .ok_or_else(|| anyhow::anyhow!("--runs <dir> required (do not overwrite bench/runs)"))?;
            capture_all_local(
                &workdir,
                &out_runs,
                &model_dir,
                flags.pace,
                flags.prime_ms,
                flags.blank_penalty,
                flags.decoding.clone(),
            )?;
        }
        Some("vocab") => {
            // What would this script send? No network, no cost — the fastest
            // way to see whether a change to the extractor helped or hurt.
            let names: Vec<String> = if args.len() > 1 {
                args[1..].to_vec()
            } else {
                VOCAB_SCRIPTS.iter().map(|s| s.to_string()).collect()
            };
            for name in names {
                let source = std::fs::read_to_string(scripts_dir.join(format!("{name}.md")))?;
                let terms = cc_align::extract_from_markdown(
                    &source,
                    cc_align::CompileOptions::default(),
                    cc_align::VocabLimits::default(),
                );
                println!("{name} ({} terms)", terms.len());
                for term in &terms {
                    println!("  {term}");
                }
                println!();
            }
        }
        Some("report") => {
            // cc-bench report <a-base> <a-opt> [<b-base> <b-opt>] — merged
            // baseline→optimized markdown table on stdout.
            let load = |p: &str| -> anyhow::Result<SuiteResult> {
                Ok(serde_json::from_str(&std::fs::read_to_string(p)?)?)
            };
            let a_base = load(&args[1])?;
            let a_opt = load(&args[2])?;
            let mut rows = cc_bench::report::rows(&a_base, &a_opt);
            if args.len() >= 5 {
                let b_base = load(&args[3])?;
                let b_opt = load(&args[4])?;
                rows.extend(cc_bench::report::rows(&b_base, &b_opt));
            }
            print!("{}", cc_bench::report::markdown_table(&rows));
        }
        Some("sweep") => {
            // Grid sweep over display/robustness knobs. Prints one line per
            // configuration; safety metrics are hard filters.
            let base = AlignmentConfig::default();
            println!(
                "{:<40} {:>6} {:>6} {:>6} {:>7} {:>6} {:>6} {:>6} {:>6}",
                "config", "fj", "cat", "w2%", "signed", "frz%", "skip", "rtk", "fail"
            );
            for emission_lag in [500.0, 800.0, 1100.0] {
                for max_prediction in [650.0, 1200.0, 1800.0] {
                    for coverage in [0.35, 0.50] {
                        let mut config = base.clone();
                        config.emission_lag_ms = emission_lag;
                        config.max_prediction_ms = max_prediction;
                        config.observe_min_coverage = coverage;
                        let result = run_tier_a(&scripts_dir, &config, "sweep")?;
                        let get = |name: &str| {
                            result
                                .table
                                .iter()
                                .find(|e| e.name == name)
                                .map(|e| e.value)
                                .unwrap_or(f64::NAN)
                        };
                        println!(
                            "lag={emission_lag:>4} cap={max_prediction:>4} cov={coverage:.2}              {:>6} {:>6} {:>6.2} {:>7.2} {:>6.2} {:>6.2} {:>6.2} {:>6}",
                            get("safety.false_jumps"),
                            get("safety.catastrophic"),
                            get("accuracy.clean_within2"),
                            get("accuracy.mean_signed_abs"),
                            get("responsiveness.freeze"),
                            get("recovery.skip_p95"),
                            get("recovery.retake_p95"),
                            get("recovery.failures"),
                        );
                    }
                }
            }
        }
        Some("inspect-live") => {
            // cc-bench inspect-live <run-name> [--config C] — compact trace
            // around discontinuities and large event-time errors in a frozen
            // Tier-B replay.
            let run_name = args.get(1).cloned().unwrap_or_default();
            let flags = parse_flags(args[2..].iter())?;
            let config = load_config(&flags.config)?;
            let dir = runs_dir.join(&run_name);
            let manifest: RunManifest =
                serde_json::from_str(&std::fs::read_to_string(dir.join("manifest.json"))?)?;
            let gold: cc_bench::plan::GoldTimeline =
                serde_json::from_str(&std::fs::read_to_string(dir.join("gold.json"))?)?;
            let events = cc_bench::capture_local::read_events_jsonl(&dir.join("events.jsonl"))?;
            let source =
                std::fs::read_to_string(scripts_dir.join(format!("{}.md", manifest.script)))?;
            let script = cc_align::compile(&source, cc_align::CompileOptions::default());
            let result =
                cc_bench::replay::replay(script, config, &events, &gold.viewport_hints);
            let transcript_events: Vec<_> = events
                .iter()
                .filter(|e| {
                    matches!(
                        e,
                        cc_stt::SttFrame::ItemStarted { .. }
                            | cc_stt::SttFrame::Partial { .. }
                            | cc_stt::SttFrame::Final { .. }
                    )
                })
                .collect();
            println!(
                "{:>9} {:<8} {:<22} {:>8} {:>8} {:>8} {:>8} {:>8}",
                "t_ms", "event", "decision", "observed", "display", "gold", "error", "delta"
            );
            let mut prior_observed = 0.0;
            for (frame, snap) in transcript_events.iter().zip(&result.snapshots) {
                let (kind, at_ms) = match frame {
                    cc_stt::SttFrame::ItemStarted { audio_start_ms, .. } => {
                        ("start", *audio_start_ms)
                    }
                    cc_stt::SttFrame::Partial { audio_ms, .. } => ("partial", *audio_ms),
                    cc_stt::SttFrame::Final { audio_end_ms, .. } => ("final", *audio_end_ms),
                    _ => unreachable!(),
                };
                let gold_pos = gold
                    .position_at(at_ms)
                    .map(|p| p.position)
                    .unwrap_or(f64::NAN);
                let display = snap.display_at(at_ms);
                let error = display - gold_pos;
                let delta = snap.observed - prior_observed;
                if delta.abs() > 8.0
                    || error.abs() > 10.0
                    || matches!(
                        snap.decision,
                        cc_align::DecisionCode::RelocationAccepted
                            | cc_align::DecisionCode::JumpForwardAccepted
                            | cc_align::DecisionCode::RetakeAccepted
                    )
                {
                    println!(
                        "{at_ms:>9.0} {kind:<8} {:<22?} {:>8.1} {:>8.1} {:>8.1} {:>8.1} {:>8.1}",
                        snap.decision,
                        snap.observed,
                        display,
                        gold_pos,
                        error,
                        delta,
                    );
                }
                prior_observed = snap.observed;
            }
        }
        Some("export-run") => {
            /*
             * cc-bench export-run <run-name> --out <path>
             *
             * Freeze a captured Tier-B run as the thing the STAGE consumes: the
             * token-space snapshot stream the app would publish, the tokens it
             * indexes into, and the gold reader position at each moment.
             *
             * This exists because the harness could prove the ENGINE follows and
             * could say nothing about whether the product does. Tier A and Tier B
             * both score `Snapshot::display_at`, which is Rust's model of the
             * display — not the renderer that actually moves the glass. A fixture
             * in this shape lets a browser test replay real recorded speech
             * through the real Svelte stage and assert the words arrive under the
             * reader's eye, which is the only claim a presenter cares about.
             *
             * The tokens travel WITH the snapshots, and that is not incidental.
             * Positions are indexes, and an index means nothing without the list
             * it indexes into: `cc_align::compile` and the app's TypeScript
             * compiler tokenise separately, so a test that rebuilt the document
             * from the markdown would be asserting against a different numbering
             * than the snapshots use. Emitting both together makes them agree by
             * construction.
             */
            let run_name = args.get(1).cloned().unwrap_or_default();
            let flags = parse_flags(args[2..].iter())?;
            let config = load_config(&flags.config)?;
            let dir = runs_dir.join(&run_name);
            let manifest: RunManifest =
                serde_json::from_str(&std::fs::read_to_string(dir.join("manifest.json"))?)?;
            let gold: cc_bench::plan::GoldTimeline =
                serde_json::from_str(&std::fs::read_to_string(dir.join("gold.json"))?)?;
            let events = cc_bench::capture_local::read_events_jsonl(&dir.join("events.jsonl"))?;
            let source =
                std::fs::read_to_string(scripts_dir.join(format!("{}.md", manifest.script)))?;
            // Compiled twice: `replay` consumes one, and the projection and the
            // token list below need the same script it ran against.
            let script = cc_align::compile(&source, cc_align::CompileOptions::default());
            let axis = cc_align::compile(&source, cc_align::CompileOptions::default());
            let result = cc_bench::replay::replay(script, config, &events, &gold.viewport_hints);

            // Host tokens, rebuilt from the atoms that carry them. One host
            // token can expand into several atoms ("$12" -> "12 dollars"), so
            // the surface is their join and the paragraph is the first one's.
            let mut tokens: Vec<(String, u32)> =
                vec![(String::new(), 0); axis.token_count as usize];
            for (i, atom) in axis.atoms.iter().enumerate() {
                let t = axis.atom_token_pos[i].floor().max(0.0) as usize;
                if t >= tokens.len() {
                    continue;
                }
                if tokens[t].0.is_empty() {
                    tokens[t] = (atom.surface.clone(), atom.para);
                } else {
                    tokens[t].0.push(' ');
                    tokens[t].0.push_str(&atom.surface);
                }
            }

            let transcript_events: Vec<_> = events
                .iter()
                .filter(|e| {
                    matches!(
                        e,
                        cc_stt::SttFrame::ItemStarted { .. }
                            | cc_stt::SttFrame::Partial { .. }
                            | cc_stt::SttFrame::Final { .. }
                    )
                })
                .collect();

            /*
             * How much of the run to freeze, in seconds of audio.
             *
             * A browser test has to replay this at REAL TIME — the snapshots
             * carry audio timestamps and the stage builds its clock estimate
             * from the offset between those and wall time, so compressing the
             * schedule without rewriting every stamp would hand the renderer a
             * clock that runs at the wrong rate and measure something nobody
             * experiences. A full Tier-B run is two minutes, which is not a
             * test; the first twenty seconds contain the first lock and enough
             * sustained reading to prove following, which is.
             */
            let seconds = flags.seconds.unwrap_or(f64::INFINITY);
            let cutoff_ms = seconds * 1000.0;

            let mut out_events = Vec::new();
            for (frame, snap) in transcript_events.iter().zip(&result.snapshots) {
                let at_ms = match frame {
                    cc_stt::SttFrame::ItemStarted { audio_start_ms, .. } => *audio_start_ms,
                    cc_stt::SttFrame::Partial { audio_ms, .. } => *audio_ms,
                    cc_stt::SttFrame::Final { audio_end_ms, .. } => *audio_end_ms,
                    _ => continue,
                };
                if at_ms > cutoff_ms {
                    break;
                }
                out_events.push(serde_json::json!({
                    "atMs": at_ms,
                    // Session generation 1: a fixture is one take, and the value
                    // only has to match the envelope the test publishes.
                    "snapshot": cc_align::project_to_tokens(snap, &axis, 1),
                }));
            }

            // Gold, in TOKEN space and sampled on a fixed grid, so a test can
            // ask "where should the reader be at t?" without re-deriving the
            // atom axis it has no access to.
            let mut out_gold = Vec::new();
            let mut t_ms = 0.0f64;
            while t_ms <= gold.total_ms.min(cutoff_ms) {
                if let Some(p) = gold.position_at(t_ms) {
                    out_gold.push(serde_json::json!({
                        "atMs": t_ms,
                        "token": axis.token_at(p.position),
                    }));
                }
                t_ms += 100.0;
            }

            let doc = serde_json::json!({
                "run": run_name,
                "script": manifest.script,
                "totalMs": gold.total_ms.min(cutoff_ms),
                "tokens": tokens
                    .iter()
                    .map(|(surface, para)| serde_json::json!({ "surface": surface, "para": para }))
                    .collect::<Vec<_>>(),
                "events": out_events,
                "gold": out_gold,
            });
            let out = flags
                .out
                .clone()
                .ok_or_else(|| anyhow::anyhow!("export-run needs --out <path>"))?;
            std::fs::write(&out, serde_json::to_string_pretty(&doc)?)?;
            println!(
                "wrote {} ({} snapshots, {} tokens)",
                out.display(),
                out_events.len(),
                tokens.len()
            );
        }
        Some("inspect") => {
            // cc-bench inspect <script> <scenario> [--config C] — per-event
            // decision trace for one Tier-A scenario, with gold comparison.
            let script_name = args.get(1).cloned().unwrap_or_default();
            let scenario_name = args.get(2).cloned().unwrap_or_default();
            let flags = parse_flags(args[3..].iter())?;
            let config = load_config(&flags.config)?;
            let suite = build_suite(&scripts_dir)?;
            let item = suite
                .iter()
                .find(|s| s.plan.script == script_name && s.plan.scenario == scenario_name)
                .ok_or_else(|| anyhow::anyhow!("no scenario {script_name}/{scenario_name}"))?;
            let performance = expand(&item.plan, &item.script);
            let gold = cc_bench::plan::synthetic_timing(&performance, item.wpm);
            let events = cc_bench::synthetic::generate_events(
                &gold,
                &item.plan.corruption,
                item.plan.seed,
            );
            let result = cc_bench::replay::replay(
                item.script.clone(),
                config,
                &events,
                &gold.viewport_hints,
            );
            println!(
                "{:>9} {:<9} {:<22} {:>8} {:>8} {:>8} {:>8}  {:<10}",
                "t_ms", "event", "decision", "observed", "confirm", "gold", "err", "state"
            );
            for (frame, snap) in events
                .iter()
                .filter(|e| {
                    matches!(
                        e,
                        cc_stt::SttFrame::ItemStarted { .. }
                            | cc_stt::SttFrame::Partial { .. }
                            | cc_stt::SttFrame::Final { .. }
                    )
                })
                .zip(result.snapshots.iter())
            {
                let kind = match frame {
                    cc_stt::SttFrame::ItemStarted { .. } => "start",
                    cc_stt::SttFrame::Partial { .. } => "partial",
                    cc_stt::SttFrame::Final { .. } => "final",
                    _ => "?",
                };
                let gold_pos = gold
                    .position_at(snap.at_audio_ms)
                    .map(|p| p.position)
                    .unwrap_or(f64::NAN);
                println!(
                    "{:>9.0} {:<9} {:<22} {:>8.1} {:>8.1} {:>8.1} {:>8.1}  {:?}",
                    snap.at_audio_ms,
                    kind,
                    format!("{:?}", snap.decision),
                    snap.observed,
                    snap.confirmed,
                    gold_pos,
                    snap.observed - gold_pos,
                    snap.state
                );
            }
        }
        Some("atoms") => {
            // cc-bench atoms <script> — the compiled atom sequence, and what
            // the verbalizer thinks the recogniser writes instead.
            //
            // Atom COUNT is load-bearing beyond debugging: Tier-B gold stores
            // reader positions as atom indexes, so a normalisation change that
            // adds or drops an atom on any fixture silently invalidates every
            // captured run for that script. This is how you check.
            let stem = args.get(1).cloned().unwrap_or_default();
            let source = std::fs::read_to_string(scripts_dir.join(format!("{stem}.md")))?;
            let script = cc_align::compile(&source, cc_align::CompileOptions::default());
            let verbalizer = cc_bench::verbalize::Verbalizer::from_source(&source);
            println!("{} atoms", script.len());
            let mut at = 0usize;
            while at < script.len() {
                match verbalizer.render(&script, at) {
                    Some(rendering) => {
                        let written: Vec<&str> = (at..at + rendering.span as usize)
                            .map(|i| script.atoms[i].surface.as_str())
                            .collect();
                        println!(
                            "{:>5}  {:<28} -> {}",
                            at,
                            written.join(" "),
                            rendering.words.join(" ")
                        );
                        at += rendering.span as usize;
                    }
                    None => {
                        println!("{:>5}  {}", at, script.atoms[at].surface);
                        at += 1;
                    }
                }
            }
        }
        Some("compare") => {
            let a: SuiteResult =
                serde_json::from_str(&std::fs::read_to_string(&args[1])?)?;
            let b: SuiteResult =
                serde_json::from_str(&std::fs::read_to_string(&args[2])?)?;
            print!("{}", compare_tables(&a, &b));
        }
        /*
         * The shipping decision for a language, as a number rather than a
         * feeling.
         *
         * It reads results the existing `tier-b` and `tier-c` commands already
         * write, instead of re-running them itself. That keeps the gate honest
         * about what it is — a policy, not a measurement — and it means the
         * thresholds can be exercised by unit tests on a machine with no
         * recogniser and no corpus, which is where a gate that nobody can run
         * would otherwise rot.
         *
         * Exits non-zero on failure, because a gate that always succeeds is
         * the thing this replaces.
         */
        Some("gate-language") => {
            let flags = parse_flags(args[1..].iter())?;
            let language = flags.label.clone();
            let tier_b: SuiteResult = serde_json::from_str(&std::fs::read_to_string(
                flags
                    .tier_b
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("--tier-b <result.json> required"))?,
            )?)?;
            let tier_c: TierCResult = serde_json::from_str(&std::fs::read_to_string(
                flags
                    .tier_c
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("--tier-c <result.json> required"))?,
            )?)?;

            // The two tiers use disjoint metric prefixes today (`live.*`,
            // `forms.*`, `safety.*` against `band.*`, `gate.*`, `outcome.*`,
            // `recover.*`, `time.*`), so merging them is safe. It is not
            // safe BY CONSTRUCTION, though, and a collision would silently
            // judge a Tier B threshold against a Tier C value — so refuse one
            // rather than let the last writer win.
            // The bar's Tier C numbers were measured on the as-shipped rig.
            // A whole-sweep result averages seven layouts and a corridor the
            // product does not have, so it is not the same measurement.
            //
            // This catches the wrong LAYOUT set. It cannot catch a 60 Hz run
            // made with a non-zero `focus_lead_atoms`, because `Layout` is not
            // serialised into the result — see bench/README.md, "Known gaps".
            let layouts: Vec<&String> = tier_c.by_layout.keys().collect();
            if layouts != vec![&"60hz".to_string()] {
                anyhow::bail!(
                    "Tier C evidence must be the as-shipped rig alone \
                     (--layouts 60hz --focus-lead 0); this result carries {:?}",
                    layouts
                );
            }

            let mut metrics = language_gate::metrics_of(&tier_b);
            for entry in &tier_c.table {
                if metrics.contains_key(&entry.name) {
                    anyhow::bail!(
                        "{} is emitted by BOTH Tier B and Tier C; the gate cannot \
                         tell which one a threshold means",
                        entry.name
                    );
                }
                metrics.insert(entry.name.clone(), entry.value);
            }

            let runs: Vec<String> = tier_b.runs.iter().map(|r| r.run.clone()).collect();
            let report = language_gate::evaluate(&language, &metrics, &runs);
            print!("{}", report.render());
            if !report.passed() {
                anyhow::bail!(
                    "{language} does not clear the bar — see bench/README.md, \
                     \"What supporting a language requires\""
                );
            }
        }
        _ => {
            eprintln!(
                "usage: cc-bench tier-a|tier-b --label L [--config C] [--out F]\n       cc-bench synth-audio --workdir DIR\n       cc-bench capture-local --workdir DIR --model DIR --runs DIR [--pace P]\n       cc-bench compare A B\n       cc-bench gate-language --label LANG --tier-b B.json --tier-c C.json"
            );
        }
    }
    Ok(())
}

/// Render every Tier-B run's audio into the machine-wide shared directory.
async fn synth_audio(
    scripts_dir: &std::path::Path,
    runs_dir: &std::path::Path,
    _workdir: &std::path::Path,
) -> anyhow::Result<()> {
    let suite = build_suite(scripts_dir)?;
    let synth = Synthesizer::new()?;
    let tts_dir = shared_rendered_dir();
    std::fs::create_dir_all(&tts_dir)?;

    for live in tier_b_selection() {
        let (script, scenario, engine, voice_index) =
            (live.script, live.scenario, live.engine, live.voice_index);
        let Some(item) = suite
            .iter()
            .find(|s| s.plan.script == script && s.plan.scenario == scenario)
        else {
            anyhow::bail!("no scenario {script}/{scenario} in the suite");
        };
        let name = format!("{}__{}__{}", script, scenario, engine.slug());
        let run_dir = tts_dir.join(&name);
        if run_dir.join("gold.json").exists() {
            println!("skip {name} (already synthesised)");
            continue;
        }
        // A run that is already a frozen fixture will never be captured again,
        // so rendering it again is a TTS bill for bytes nothing will read. The
        // shared completed-run directory makes this check consistent across
        // every worktree.
        if runs_dir.join(&name).join("events.jsonl").exists() {
            println!("skip {name} (already captured in bench/runs)");
            continue;
        }
        std::fs::create_dir_all(&run_dir)?;
        let performance = expand(&item.plan, &item.script);
        println!(
            "synthesising {name}: {} words, {} segments…",
            performance.words.len(),
            performance.segments.len()
        );
        let run = synthesize(&synth, engine, &performance, voice_index).await?;
        std::fs::write(run_dir.join("audio.wav"), wav_bytes(&run.pcm))?;
        std::fs::write(run_dir.join("gold.json"), serde_json::to_string(&run.gold)?)?;
        let spoken: String = performance
            .words
            .iter()
            .map(|w| w.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        std::fs::write(run_dir.join("performance.txt"), &spoken)?;
        let manifest = RunManifest {
            name: name.clone(),
            script: script.to_string(),
            scenario: scenario.to_string(),
            engine: engine.slug().to_string(),
            voice_index,
            words: performance.words.len(),
            audio_s: run.gold.total_ms / 1000.0,
            atom_count: Some(item.script.len()),
        };
        std::fs::write(
            run_dir.join("manifest.json"),
            serde_json::to_string_pretty(&manifest)?,
        )?;
        println!("  {:.1}s of audio", manifest.audio_s);
    }
    Ok(())
}

/// Stream every synthesised run through the ON-DEVICE recogniser and persist
/// the event logs as replay fixtures, in the same shape the hosted capture
/// wrote.
///
/// The model is loaded once for the whole corpus and a fresh stream is created
/// per run, which is also how the app is meant to hold it: loading costs
/// ~200 ms and belongs nowhere near the start of a take.
#[allow(clippy::too_many_arguments)]
fn capture_all_local(
    _workdir: &std::path::Path,
    runs_dir: &std::path::Path,
    model_dir: &std::path::Path,
    pace: f64,
    prime_ms: Option<u32>,
    blank_penalty: Option<f32>,
    decoding: Option<String>,
) -> anyhow::Result<()> {
    // The profile's tuning first, overrides on top. A capture that started
    // from anything else would be measuring a recogniser the app does not
    // ship, which is the one thing a baseline may not do.
    //
    // `--model` names a DIRECTORY, and nothing checks that the directory holds
    // the model whose tuning is being applied — so the log below says whose
    // tuning it is rather than claiming the weights are that model's. Pointing
    // this at another bundle gives it x-asr's `blank_penalty`, which is a
    // reasonable thing to want when sweeping and a corpus-poisoning mistake
    // when not noticed. Naming the profile is what makes it noticeable.
    let model = cc_stt::default_model();
    let mut config = cc_stt::LocalSttConfig::for_model(model, model_dir);
    if let Some(ms) = prime_ms {
        config.prime_ms = ms;
    }
    if let Some(penalty) = blank_penalty {
        config.blank_penalty = penalty;
    }
    if let Some(method) = decoding {
        config.decoding_method = method;
    }
    config.validate().map_err(|e| anyhow::anyhow!(e))?;
    let loading = std::time::Instant::now();
    let recognizer = cc_stt::LocalRecognizer::load(&config).map_err(|e| anyhow::anyhow!(e))?;
    println!(
        "loaded {} in {:.0}ms with {} tuning ({} threads, {}, prime {}ms, blank_penalty {})",
        model_dir.display(),
        loading.elapsed().as_secs_f64() * 1000.0,
        model.id,
        config.num_threads,
        config.decoding_method,
        config.prime_ms,
        config.blank_penalty,
    );

    let tts_dir = shared_rendered_dir();
    let mut dirs: Vec<_> = std::fs::read_dir(&tts_dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();

    for dir in dirs {
        let name = dir.file_name().unwrap().to_string_lossy().to_string();
        let out_dir = runs_dir.join(&name);
        if out_dir.join("events.jsonl").exists() {
            println!("skip {name} (already captured)");
            continue;
        }
        // Every file the fixture needs, not just the audio — synthesis writes
        // them in sequence, so a run can briefly have audio and gold and not
        // yet have its manifest. Capturing it then would abort the whole corpus
        // on a missing file that is about to exist, which matters because this
        // is deliberately run alongside a synthesis that is still going.
        let required = ["audio.wav", "gold.json", "manifest.json", "performance.txt"];
        if required.iter().any(|f| !dir.join(f).exists()) {
            println!("skip {name} (synthesis incomplete)");
            continue;
        }
        let wav = std::fs::read(dir.join("audio.wav"))?;
        anyhow::ensure!(wav.len() > 44, "empty audio for {name}");
        let pcm = &wav[44..]; // strip our own canonical WAV header
        let sample_rate = cc_stt::SAMPLE_RATE_HZ;
        let audio_s = pcm.len() as f64 / (sample_rate as f64 * 2.0);
        println!("capturing {name}: {audio_s:.1}s at {pace}× …");

        let started = std::time::Instant::now();
        // `config.prime_ms`, not the flag: the recogniser was loaded with the
        // resolved value and the stream must be primed with the same one.
        let events = cc_bench::capture_local::capture_events(
            &recognizer,
            pcm,
            sample_rate,
            pace,
            config.prime_ms,
        );
        let transcripts = events
            .iter()
            .filter(|e| {
                matches!(
                    e,
                    cc_stt::SttFrame::Partial { .. } | cc_stt::SttFrame::Final { .. }
                )
            })
            .count();
        println!(
            "  {} events ({} transcripts) in {:.1}s",
            events.len(),
            transcripts,
            started.elapsed().as_secs_f64()
        );
        anyhow::ensure!(transcripts > 0, "capture produced no transcripts for {name}");
        std::fs::create_dir_all(&out_dir)?;
        cc_bench::capture_local::write_events_jsonl(&out_dir.join("events.jsonl"), &events)?;
        for file in ["gold.json", "manifest.json", "performance.txt"] {
            std::fs::copy(dir.join(file), out_dir.join(file))?;
        }
    }
    Ok(())
}

