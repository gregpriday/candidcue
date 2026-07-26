//! cc-bench CLI.
//!
//! ```text
//! cc-bench tier-a --label baseline [--config cfg.json] [--out results.json]
//! cc-bench compare baseline.json candidate.json
//! ```
//! (TTS synthesis and live capture subcommands are added by the harness as
//! they come online.)

use std::path::PathBuf;

use cc_align::AlignmentConfig;
use cc_bench::suite::{compare_tables, print_table, run_tier_a, SuiteResult};

fn scripts_dir() -> PathBuf {
    // Walk up from CWD until a bench/scripts directory appears.
    let mut dir = std::env::current_dir().expect("cwd");
    loop {
        let candidate = dir.join("bench/scripts");
        if candidate.is_dir() {
            return candidate;
        }
        if !dir.pop() {
            panic!("bench/scripts not found above the working directory");
        }
    }
}

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut it = args.iter();
    match it.next().map(String::as_str) {
        Some("tier-a") => {
            let mut label = "run".to_string();
            let mut config_path: Option<PathBuf> = None;
            let mut out: Option<PathBuf> = None;
            while let Some(arg) = it.next() {
                match arg.as_str() {
                    "--label" => label = it.next().cloned().unwrap_or(label),
                    "--config" => config_path = it.next().map(PathBuf::from),
                    "--out" => out = it.next().map(PathBuf::from),
                    other => anyhow::bail!("unknown flag {other}"),
                }
            }
            let config: AlignmentConfig = match config_path {
                Some(path) => serde_json::from_str(&std::fs::read_to_string(path)?)?,
                None => AlignmentConfig::default(),
            };
            let result = run_tier_a(&scripts_dir(), &config, &label)?;
            print_table(&result);
            if let Some(out) = out {
                std::fs::create_dir_all(out.parent().unwrap_or(&PathBuf::from(".")))?;
                std::fs::write(&out, serde_json::to_string_pretty(&result)?)?;
                println!("wrote {}", out.display());
            }
        }
        Some("compare") => {
            let a: SuiteResult =
                serde_json::from_str(&std::fs::read_to_string(it.next().expect("baseline"))?)?;
            let b: SuiteResult =
                serde_json::from_str(&std::fs::read_to_string(it.next().expect("candidate"))?)?;
            print!("{}", compare_tables(&a, &b));
        }
        _ => {
            eprintln!("usage: cc-bench tier-a --label L [--config C] [--out F] | compare A B");
        }
    }
    Ok(())
}
