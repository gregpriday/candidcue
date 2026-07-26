//! cc-bench CLI.
//!
//! ```text
//! cc-bench tier-a  --label L [--config cfg.json] [--out results.json]
//! cc-bench synth-audio --workdir DIR            # fal.ai TTS → fixture audio
//! cc-bench capture --workdir DIR [--pace 1.0]   # stream → bench/runs/
//! cc-bench tier-b  --label L [--config C] [--out F]
//! cc-bench compare baseline.json candidate.json
//! ```

use std::path::PathBuf;

use cc_align::AlignmentConfig;
use cc_bench::plan::expand;
use cc_bench::scenarios::{build_suite, tier_b_selection};
use cc_bench::suite::{
    compare_tables, print_table, run_tier_a, run_tier_b, RunManifest, SuiteResult,
};
use cc_bench::tts::{synthesize, wav_bytes, Synthesizer, TtsEngine};

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
}

fn parse_flags<'a>(it: impl Iterator<Item = &'a String>) -> anyhow::Result<Flags> {
    let mut flags = Flags {
        label: "run".into(),
        config: None,
        out: None,
        workdir: None,
        pace: 1.0,
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
            let result = run_tier_b(&runs_dir, &scripts_dir, &config, &flags.label)?;
            print_table(&result);
            save_result(&result, &flags.out)?;
        }
        Some("synth-audio") => {
            let flags = parse_flags(args[1..].iter())?;
            let workdir = flags
                .workdir
                .ok_or_else(|| anyhow::anyhow!("--workdir required"))?;
            let runtime = tokio::runtime::Runtime::new()?;
            runtime.block_on(synth_audio(&scripts_dir, &workdir))?;
        }
        Some("capture") => {
            let flags = parse_flags(args[1..].iter())?;
            let workdir = flags
                .workdir
                .ok_or_else(|| anyhow::anyhow!("--workdir required"))?;
            let runtime = tokio::runtime::Runtime::new()?;
            runtime.block_on(capture_all(&workdir, &runs_dir, flags.pace))?;
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
        Some("compare") => {
            let a: SuiteResult =
                serde_json::from_str(&std::fs::read_to_string(&args[1])?)?;
            let b: SuiteResult =
                serde_json::from_str(&std::fs::read_to_string(&args[2])?)?;
            print!("{}", compare_tables(&a, &b));
        }
        _ => {
            eprintln!(
                "usage: cc-bench tier-a|tier-b --label L [--config C] [--out F]\n       cc-bench synth-audio --workdir DIR\n       cc-bench capture --workdir DIR [--pace P]\n       cc-bench compare A B"
            );
        }
    }
    Ok(())
}

/// Render every Tier-B run's audio via fal.ai into the work directory.
async fn synth_audio(scripts_dir: &std::path::Path, workdir: &std::path::Path) -> anyhow::Result<()> {
    let suite = build_suite(scripts_dir)?;
    let synth = Synthesizer::new(workdir.join("tts-cache"))?;
    let engines = TtsEngine::all();

    for (i, (script, scenario)) in tier_b_selection().into_iter().enumerate() {
        let engine = engines[i % engines.len()];
        let Some(item) = suite
            .iter()
            .find(|s| s.plan.script == script && s.plan.scenario == scenario)
        else {
            anyhow::bail!("no scenario {script}/{scenario} in the suite");
        };
        let name = format!("{}__{}__{}", script, scenario, engine.slug());
        let run_dir = workdir.join("tts").join(&name);
        if run_dir.join("gold.json").exists() {
            println!("skip {name} (already synthesised)");
            continue;
        }
        std::fs::create_dir_all(&run_dir)?;
        let performance = expand(&item.plan, &item.script);
        println!(
            "synthesising {name}: {} words, {} segments…",
            performance.words.len(),
            performance.segments.len()
        );
        let run = synthesize(&synth, engine, &performance, i).await?;
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
            voice_index: i,
            words: performance.words.len(),
            audio_s: run.gold.total_ms / 1000.0,
        };
        std::fs::write(
            run_dir.join("manifest.json"),
            serde_json::to_string_pretty(&manifest)?,
        )?;
        println!("  {:.1}s of audio", manifest.audio_s);
    }
    Ok(())
}

/// Stream every synthesised run through the live recogniser and persist the
/// event logs as replay fixtures.
async fn capture_all(
    workdir: &std::path::Path,
    runs_dir: &std::path::Path,
    pace: f64,
) -> anyhow::Result<()> {
    let tts_dir = workdir.join("tts");
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
        let wav = std::fs::read(dir.join("audio.wav"))?;
        anyhow::ensure!(wav.len() > 44, "empty audio for {name}");
        let pcm = &wav[44..]; // strip our own canonical WAV header
        println!(
            "capturing {name}: {:.1}s at {pace}× …",
            pcm.len() as f64 / 48_000.0
        );
        let started = std::time::Instant::now();
        let events = cc_bench::capture::capture_events(pcm, pace).await?;
        let transcripts = events
            .iter()
            .filter(|e| matches!(e, cc_stt::SttFrame::Partial { .. } | cc_stt::SttFrame::Final { .. }))
            .count();
        println!(
            "  {} events ({} transcripts) in {:.1}s",
            events.len(),
            transcripts,
            started.elapsed().as_secs_f64()
        );
        anyhow::ensure!(transcripts > 0, "capture produced no transcripts for {name}");
        std::fs::create_dir_all(&out_dir)?;
        cc_bench::capture::write_events_jsonl(&out_dir.join("events.jsonl"), &events)?;
        for file in ["gold.json", "manifest.json", "performance.txt"] {
            std::fs::copy(dir.join(file), out_dir.join(file))?;
        }
    }
    Ok(())
}
