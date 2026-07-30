//! Script difficulty, so a good score cannot come from an easy corpus.
//!
//! A benchmark can look excellent simply because its scripts are easy to locate
//! in. Every number in the suite is conditional on the corpus, and nothing in the
//! old table said what the corpus was like — so a fixture set that happens to be
//! full of rare proper nouns reports a tracker that is better than it is, and the
//! failure mode the engine actually has (repetitive, stopword-heavy passages)
//! stays invisible.
//!
//! Three axes, all computed from the compiled script alone:
//!
//! * **uniqueness radius** — how long a phrase must be before it identifies one
//!   place in the script;
//! * **anchor density** — how much of a window is anchor-grade material;
//! * **layout difficulty** — how much pixel travel a spoken word costs.
//!
//! Results are stratified by decile on the first of these, and the WORST decile
//! is reported beside the mean. A teleprompter is judged by its worst
//! conspicuous moments, not its average ones.

use std::collections::HashMap;

use cc_align::script::{CompiledScript, FLAG_ANCHOR};
use serde::{Deserialize, Serialize};

/// Longest n-gram considered before a position is declared non-unique. Beyond
/// about eight words the tracker has other problems and the exact number stops
/// being informative.
pub const MAX_UNIQUENESS_K: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScriptDifficulty {
    pub script: String,
    pub atoms: usize,
    /// `U(i)`: smallest k such that the k-gram ending at i occurs exactly once.
    /// `MAX_UNIQUENESS_K + 1` marks a position no bounded phrase pins down.
    pub uniqueness: Vec<u8>,
    pub uniqueness_p50: f64,
    pub uniqueness_p90: f64,
    /// Fraction of positions no k-gram up to `MAX_UNIQUENESS_K` disambiguates.
    pub ambiguous_pct: f64,
    /// Anchor-grade atoms as a fraction of the script.
    pub anchor_density: f64,
    /// The lowest anchor density over any 48-atom window — the passage the
    /// tracker will actually struggle in.
    pub min_window_anchor_density: f64,
    /// Mean weight of the script's atoms (rare words weigh more).
    pub mean_weight: f64,
    /// Stopword fraction.
    pub stopword_pct: f64,
    /// Paragraph count and the longest paragraph in atoms.
    pub paragraphs: usize,
    pub longest_paragraph: usize,
}

/// Window used for the anchor-density floor: the same width as the tracker's own
/// backward local band, so the number describes a region it really does search.
const ANCHOR_WINDOW: usize = 48;

pub fn analyse(name: &str, script: &CompiledScript) -> ScriptDifficulty {
    let n = script.len();
    let canon: Vec<&str> = script.atoms.iter().map(|a| a.surface.as_str()).collect();

    // ---- uniqueness radius ----
    // Counting each k separately keeps this O(n·k) with one hash pass per k,
    // which matters: `huge` is 5k atoms and this runs on every suite invocation.
    let mut uniqueness = vec![(MAX_UNIQUENESS_K + 1) as u8; n];
    for k in 1..=MAX_UNIQUENESS_K {
        if k > n {
            break;
        }
        let mut counts: HashMap<&[&str], u32> = HashMap::with_capacity(n);
        for i in (k - 1)..n {
            *counts.entry(&canon[i + 1 - k..=i]).or_insert(0) += 1;
        }
        for i in (k - 1)..n {
            if uniqueness[i] as usize <= MAX_UNIQUENESS_K {
                continue;
            }
            if counts.get(&canon[i + 1 - k..=i]).copied().unwrap_or(0) == 1 {
                uniqueness[i] = k as u8;
            }
        }
    }
    let mut u: Vec<f64> = uniqueness.iter().map(|&v| v as f64).collect();
    u.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let at = |p: f64| -> f64 {
        if u.is_empty() {
            f64::NAN
        } else {
            u[(((u.len() - 1) as f64 * p).round() as usize).min(u.len() - 1)]
        }
    };

    // ---- anchor density ----
    let is_anchor: Vec<bool> = script
        .atoms
        .iter()
        .map(|a| a.flags & FLAG_ANCHOR != 0)
        .collect();
    let anchors = is_anchor.iter().filter(|b| **b).count();
    let mut min_window = 1.0f64;
    if n >= ANCHOR_WINDOW {
        let mut in_window = is_anchor[..ANCHOR_WINDOW].iter().filter(|b| **b).count();
        min_window = in_window as f64 / ANCHOR_WINDOW as f64;
        for i in ANCHOR_WINDOW..n {
            in_window += usize::from(is_anchor[i]);
            in_window -= usize::from(is_anchor[i - ANCHOR_WINDOW]);
            min_window = min_window.min(in_window as f64 / ANCHOR_WINDOW as f64);
        }
    }

    // ---- paragraphs ----
    let mut paragraphs = 0usize;
    let mut longest = 0usize;
    let mut run = 0usize;
    let mut last_para = u32::MAX;
    for a in &script.atoms {
        if a.para != last_para {
            if run > 0 {
                longest = longest.max(run);
            }
            paragraphs += 1;
            run = 0;
            last_para = a.para;
        }
        run += 1;
    }
    longest = longest.max(run);

    ScriptDifficulty {
        script: name.to_string(),
        atoms: n,
        uniqueness_p50: at(0.5),
        uniqueness_p90: at(0.9),
        ambiguous_pct: 100.0
            * uniqueness
                .iter()
                .filter(|&&v| v as usize > MAX_UNIQUENESS_K)
                .count() as f64
            / n.max(1) as f64,
        anchor_density: anchors as f64 / n.max(1) as f64,
        min_window_anchor_density: min_window,
        mean_weight: if n == 0 {
            0.0
        } else {
            script.atoms.iter().map(|a| a.weight as f64).sum::<f64>() / n as f64
        },
        stopword_pct: 100.0
            * script
                .atoms
                .iter()
                .filter(|a| cc_align::normalize::is_stopword(&a.surface))
                .count() as f64
            / n.max(1) as f64,
        paragraphs,
        longest_paragraph: longest,
        uniqueness,
    }
}

/// Which uniqueness decile position `i` falls in (0 = easiest, 9 = hardest).
///
/// The point of the decile is conditional reporting: a lock time averaged over a
/// whole script tells you nothing about whether the engine can find its way in
/// the repetitive passage, which is the only place it ever fails.
pub fn decile_of(d: &ScriptDifficulty, i: usize) -> usize {
    let u = d.uniqueness.get(i).copied().unwrap_or(1) as usize;
    // Uniqueness is small-integer valued, so a rank-based decile would collapse.
    // Bucketing by value is what actually separates easy from hard here.
    ((u.min(MAX_UNIQUENESS_K + 1) - 1) * 9 / MAX_UNIQUENESS_K).min(9)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cc_align::{compile, CompileOptions};

    #[test]
    fn a_unique_script_needs_short_phrases() {
        let script = compile(
            "alpha bravo charlie delta echo foxtrot golf hotel",
            CompileOptions::default(),
        );
        let d = analyse("t", &script);
        assert_eq!(d.uniqueness_p50, 1.0, "every word occurs once");
        assert_eq!(d.ambiguous_pct, 0.0);
    }

    #[test]
    fn a_refrain_needs_longer_phrases_and_shows_up_as_ambiguity() {
        // The same four words three times: no k-gram inside a repeat can pin it.
        let script = compile(
            "and now the thing and now the thing and now the thing",
            CompileOptions::default(),
        );
        let d = analyse("t", &script);
        assert!(
            d.ambiguous_pct > 40.0,
            "expected a mostly-ambiguous script, got {:.1}%",
            d.ambiguous_pct
        );
        assert!(d.uniqueness_p90 as usize > MAX_UNIQUENESS_K);
    }

    #[test]
    fn anchor_floor_finds_the_worst_passage() {
        let mut text = String::new();
        // A stretch of pure stopwords, then rare nouns.
        for _ in 0..60 {
            text.push_str("of the and to ");
        }
        text.push_str("Kubernetes Pinecone Anthropic Zipformer ");
        let script = compile(&text, CompileOptions::default());
        let d = analyse("t", &script);
        assert!(
            d.min_window_anchor_density < d.anchor_density + 1e-9,
            "the floor must be at or below the mean"
        );
        assert!(d.stopword_pct > 80.0);
    }
}
