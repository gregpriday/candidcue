//! Does `transcribeConfig.prompts` actually do anything?
//!
//! The question is not rhetorical. `src-tauri/src/inworld/mod.rs` records that
//! this service ignores unknown config keys in silence — a deliberately bogus
//! config block once produced timings identical to a correct one — so a field
//! being accepted proves nothing at all about it being read. The only evidence
//! that counts is the same audio, streamed twice, differing in one field.
//!
//! That is what this does: for each script, synthesise its performance once
//! (the TTS clip cache means the second stream costs nothing extra), stream it
//! with an empty vocabulary, stream it again with the vocabulary
//! [`cc_align::vocab`] extracted from the script, and print what changed.
//!
//! ---------------------------------------------------------------------------
//! WHY THREE NUMBERS AND NOT ONE
//! ---------------------------------------------------------------------------
//! The two wins this feature is after do not show up in the same measurement,
//! and a single WER would hide one behind the other.
//!
//! * `wer` is computed on CANONICAL atoms — the aligner's own normalisation,
//!   which folds `twenty-seven` and `27` onto one atom on purpose. So it
//!   answers "were the right WORDS heard", and it is the number that moves
//!   when a name stops being mangled.
//! * `raw` is computed on bare lowercased surfaces with no number folding at
//!   all. It answers "were they SPELLED the way the script spelled them", which
//!   is invisible to `wer` by construction and is the entire point of biasing a
//!   figure like `three thirty`.
//! * `terms` is the bluntest and most direct: of the terms actually sent, how
//!   many came back in the transcript verbatim. A bias that works shows up here
//!   first, and a bias the service is ignoring shows up here as a flat line.
//!
//! A fourth thing worth watching is in the printed transcript diff rather than
//! the table: terms appearing where they were never said. That is the failure
//! mode of over-biasing, and it is why the term list is capped.

use std::collections::BTreeSet;
use std::path::Path;

use cc_align::vocab::VocabLimits;
use cc_stt::SttFrame;

use crate::metrics::token_edit_distance;
use crate::plan::expand;
use crate::scenarios::{build_suite, tier_b_selection};
use crate::suite::RunManifest;
use crate::tts::{synthesize, wav_bytes, Synthesizer};

/// One side of the comparison.
#[derive(Debug, Clone)]
pub struct Side {
    pub transcript: String,
    pub wer_pct: f64,
    pub raw_wer_pct: f64,
    /// How many of `terms` appear verbatim in the transcript.
    pub term_hits: usize,
}

#[derive(Debug, Clone)]
pub struct Comparison {
    pub name: String,
    pub words: usize,
    pub audio_s: f64,
    pub terms: Vec<String>,
    pub without: Side,
    pub with: Side,
}

/// Scripts worth asking the question of, and nothing else.
///
/// Names and brands are where mishearing lives; figures is where re-spelling
/// lives. A script of ordinary prose would answer "no measurable difference"
/// at full price, because there is nothing in it to bias.
pub const DEFAULT_SCRIPTS: &[&str] = &["names", "brands", "figures"];

pub async fn run(
    scripts_dir: &Path,
    workdir: &Path,
    scripts: &[String],
    pace: f64,
) -> anyhow::Result<Vec<Comparison>> {
    // Both sides are persisted as ordinary replay fixtures, under
    // `runs-without/` and `runs-with/`, so the alignment suite can be pointed
    // at each in turn. WER is a transcription number; whether a cleaner
    // transcript actually steadies the DISPLAY is a different question, and it
    // is answered by the same replay machinery every other number in the report
    // comes from, or it is not answered at all.
    let runs_without = workdir.join("runs-without");
    let runs_with = workdir.join("runs-with");
    let suite = build_suite(scripts_dir)?;
    let synth = Synthesizer::new(workdir.join("tts-cache"))?;
    let selection = tier_b_selection();
    let mut out = Vec::new();

    for spec in scripts {
        // `figures` means `figures:exact`; `figures:pauses` asks for the other
        // tier-B rendering of the same page, which is a DIFFERENT VOICE. That
        // matters more here than it looks: a result that only holds for one
        // TTS engine is a result about that engine.
        let (script, scenario) = match spec.split_once(':') {
            Some((script, scenario)) => (script, scenario),
            None => (spec.as_str(), "exact"),
        };
        // Reuse the tier-B identity so the voice matches the frozen corpus and
        // any audio already in the workdir is a cache hit rather than a second
        // bill for the same words.
        let Some(live) = selection
            .iter()
            .find(|l| l.script == script && l.scenario == scenario)
        else {
            anyhow::bail!("no tier-B `{scenario}` run defined for {script}");
        };
        let Some(item) = suite
            .iter()
            .find(|s| s.plan.script == script && s.plan.scenario == scenario)
        else {
            anyhow::bail!("no scenario {script}/{scenario} in the suite");
        };

        let name = format!("{}__{}__{}", script, scenario, live.engine.slug());
        let run_dir = workdir.join("tts").join(&name);
        std::fs::create_dir_all(&run_dir)?;
        let audio_path = run_dir.join("audio.wav");
        let spoken_path = run_dir.join("performance.txt");

        let performance = expand(&item.plan, &item.script);
        let spoken: String = performance
            .words
            .iter()
            .map(|w| w.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");

        // Always re-stitch rather than reading back `audio.wav`: every clip is
        // cached by content hash so this costs nothing, it yields the gold
        // timeline the replay needs, and it sidesteps the torn file two
        // concurrent runs of this command would otherwise leave behind.
        if audio_path.exists() {
            println!("reusing cached audio for {name}");
        } else {
            println!(
                "synthesising {name}: {} words, {} segments…",
                performance.words.len(),
                performance.segments.len()
            );
        }
        let rendered = synthesize(&synth, live.engine, &performance, live.voice_index).await?;
        std::fs::write(&audio_path, wav_bytes(&rendered.pcm))?;
        std::fs::write(&spoken_path, &spoken)?;
        let pcm = rendered.pcm.as_slice();
        anyhow::ensure!(!pcm.is_empty(), "empty audio for {name}");
        let audio_s = pcm.len() as f64 / 48_000.0;

        let manifest = RunManifest {
            name: name.clone(),
            script: script.to_string(),
            scenario: scenario.to_string(),
            engine: live.engine.slug().to_string(),
            voice_index: live.voice_index,
            words: performance.words.len(),
            audio_s,
            atom_count: Some(item.script.len()),
        };

        let source = std::fs::read_to_string(scripts_dir.join(format!("{script}.md")))?;
        let terms = cc_align::extract_from_markdown(
            &source,
            cc_align::CompileOptions::default(),
            VocabLimits::default(),
        );
        println!("{name}: {} terms — {}", terms.len(), terms.join(" · "));

        // Two references, because the two numbers ask different questions.
        //
        // `spoken` is the performance text, which is built from COMPILED atoms
        // and has therefore already been through inverse text normalisation:
        // the script's `twenty-seven` reaches it as `27`. That is the right
        // reference for "were the right words heard" and exactly the wrong one
        // for "were they spelled the script's way" — measured against it, a
        // recogniser persuaded to write `twenty-seven thousand` scores WORSE
        // for having done the thing the bias asked of it. `authored` is the
        // page as written, which is what the spelling question actually means.
        let authored = cc_align::spoken_surfaces(&source, cc_align::CompileOptions::default())
            .join(" ");

        println!("  streaming without vocabulary ({audio_s:.0}s)…");
        let (bare, bare_events) = stream_side(pcm, pace, &[], &spoken, &authored, &terms).await?;
        println!("  streaming with vocabulary…");
        let (biased, biased_events) =
            stream_side(pcm, pace, &terms, &spoken, &authored, &terms).await?;

        for (root, events) in [(&runs_without, &bare_events), (&runs_with, &biased_events)] {
            let out = root.join(&name);
            std::fs::create_dir_all(&out)?;
            crate::capture::write_events_jsonl(&out.join("events.jsonl"), events)?;
            std::fs::write(out.join("gold.json"), serde_json::to_string(&rendered.gold)?)?;
            std::fs::write(out.join("manifest.json"), serde_json::to_string_pretty(&manifest)?)?;
            std::fs::write(out.join("performance.txt"), &spoken)?;
        }

        out.push(Comparison {
            name,
            words: performance.words.len(),
            audio_s,
            terms,
            without: bare,
            with: biased,
        });
    }
    println!();
    println!(
        "replay fixtures written to {} and {}",
        runs_without.display(),
        runs_with.display()
    );
    Ok(out)
}

#[allow(clippy::too_many_arguments)]
async fn stream_side(
    pcm: &[u8],
    pace: f64,
    prompts: &[String],
    spoken: &str,
    authored: &str,
    terms: &[String],
) -> anyhow::Result<(Side, Vec<SttFrame>)> {
    let events = crate::capture::capture_events_with(pcm, pace, prompts).await?;
    let transcript = finals(&events);
    anyhow::ensure!(
        !transcript.trim().is_empty(),
        "capture produced no final transcripts"
    );
    Ok((
        Side {
            wer_pct: canonical_wer(spoken, &transcript),
            raw_wer_pct: raw_wer(authored, &transcript),
            term_hits: terms.iter().filter(|t| contains_term(&transcript, t)).count(),
            transcript,
        },
        events,
    ))
}

fn finals(events: &[SttFrame]) -> String {
    let mut text = String::new();
    for event in events {
        if let SttFrame::Final { text: t, .. } = event {
            if !text.is_empty() {
                text.push(' ');
            }
            text.push_str(t);
        }
    }
    text
}

/// WER through the aligner's own normalisation — words, not spellings.
fn canonical_wer(reference: &str, hypothesis: &str) -> f64 {
    let a = cc_align::normalize::canonical_atoms(reference);
    let b = cc_align::normalize::canonical_atoms(hypothesis);
    if a.is_empty() {
        return 0.0;
    }
    100.0 * token_edit_distance(&a, &b) as f64 / a.len() as f64
}

/// WER on bare surfaces against the AUTHORED page — spellings, not words.
///
/// Deliberately does NOT go through `canonical_atoms`: that function exists to
/// make `27` and `twenty-seven` the same token, which is exactly the difference
/// this number is trying to see. For the same reason its reference must be the
/// script rather than the performance text, which is built from atoms that have
/// already been folded.
fn raw_wer(reference: &str, hypothesis: &str) -> f64 {
    let a = raw_words(reference);
    let b = raw_words(hypothesis);
    if a.is_empty() {
        return 0.0;
    }
    100.0 * token_edit_distance(&a, &b) as f64 / a.len() as f64
}

fn raw_words(text: &str) -> Vec<String> {
    text.split_whitespace()
        .map(|w| {
            w.trim_matches(|c: char| !c.is_alphanumeric())
                .to_lowercase()
        })
        .filter(|w| !w.is_empty())
        .collect()
}

/// Did this exact term come back, as a whole-word run?
fn contains_term(transcript: &str, term: &str) -> bool {
    let hay = raw_words(transcript);
    let needle = raw_words(term);
    if needle.is_empty() || needle.len() > hay.len() {
        return false;
    }
    hay.windows(needle.len()).any(|w| w == needle.as_slice())
}

/// The table, plus the words each side got that the other did not.
pub fn report(results: &[Comparison]) {
    println!();
    println!(
        "{:<28} {:>6} {:>7} {:>8} {:>8} {:>8} {:>8} {:>10}",
        "run", "words", "terms", "wer−", "wer+", "raw−", "raw+", "hits −/+"
    );
    for r in results {
        println!(
            "{:<28} {:>6} {:>7} {:>8.2} {:>8.2} {:>8.2} {:>8.2} {:>10}",
            r.name,
            r.words,
            r.terms.len(),
            r.without.wer_pct,
            r.with.wer_pct,
            r.without.raw_wer_pct,
            r.with.raw_wer_pct,
            format!("{}/{}", r.without.term_hits, r.with.term_hits),
        );
    }

    for r in results {
        let gained: BTreeSet<&String> = r
            .terms
            .iter()
            .filter(|t| !contains_term(&r.without.transcript, t) && contains_term(&r.with.transcript, t))
            .collect();
        let lost: BTreeSet<&String> = r
            .terms
            .iter()
            .filter(|t| contains_term(&r.without.transcript, t) && !contains_term(&r.with.transcript, t))
            .collect();
        if gained.is_empty() && lost.is_empty() {
            continue;
        }
        println!();
        println!("{}:", r.name);
        if !gained.is_empty() {
            let list: Vec<&str> = gained.iter().map(|s| s.as_str()).collect();
            println!("  gained: {}", list.join(" · "));
        }
        if !lost.is_empty() {
            let list: Vec<&str> = lost.iter().map(|s| s.as_str()).collect();
            println!("  lost:   {}", list.join(" · "));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_term_is_found_only_as_a_whole_word_run() {
        assert!(contains_term("we ship with RustLight games today", "rustlight games"));
        assert!(!contains_term("we ship with rust light games", "rustlight"));
        // A substring of a longer word is not a hit.
        assert!(!contains_term("the lighthouse is tall", "light"));
    }

    #[test]
    fn raw_wer_sees_a_re_spelling_that_canonical_wer_folds_away() {
        let reference = "I write twenty-seven every time";
        let hypothesis = "I write 27 every time";
        assert_eq!(
            canonical_wer(reference, hypothesis),
            0.0,
            "canonical normalisation is supposed to fold this"
        );
        assert!(
            raw_wer(reference, hypothesis) > 0.0,
            "raw WER is supposed to see it"
        );
    }
}
