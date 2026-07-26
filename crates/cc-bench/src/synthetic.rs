//! Tier A: deterministic synthetic transcript events.
//!
//! Simulates the observed Inworld cadence without audio or network: server
//! VAD opens an item at speech onset, full-restatement partials arrive on a
//! ~900 ms cadence lagging the audio clock, a final restates the utterance
//! ~1.2 s after the closing pause. Corruption is seeded and reproducible, so
//! a Tier-A suite is a pure function of (plan, seed) and runs in
//! milliseconds — this is what CI regression numbers come from.

use cc_stt::SttFrame;

use crate::plan::{Corruption, GoldTimeline, GoldWord};

/// Gaps of at least this length close an utterance (server VAD behaviour).
const UTTERANCE_GAP_MS: f64 = 900.0;
/// Emission lag: a partial covers words finished this long before it arrives.
/// 400 ms is the p50 measured against gold word times on live Inworld
/// captures (bench/runs) — the simulator tracks the measured provider.
const PARTIAL_LAG_MS: f64 = 400.0;
/// Partial cadence while speech continues.
const PARTIAL_EVERY_MS: f64 = 900.0;
/// Final arrives this long after the last word of the utterance ends.
const FINAL_DELAY_MS: f64 = 1_200.0;
/// speechStarted (ItemStarted) fires this long after actual onset.
const ONSET_DELAY_MS: f64 = 250.0;

/// Deterministic 64-bit LCG (Numerical Recipes constants) — no rand crate,
/// no platform variance.
pub struct Lcg(u64);

impl Lcg {
    pub fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407))
    }
    pub fn next_u32(&mut self) -> u32 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (self.0 >> 33) as u32
    }
    /// Uniform in [0, 1000).
    pub fn per_mille(&mut self) -> u32 {
        self.next_u32() % 1000
    }
    pub fn pick<'a>(&mut self, options: &'a [&'a str]) -> &'a str {
        options[(self.next_u32() as usize) % options.len()]
    }
}

/// Apply persistent ASR-style corruption to the spoken words: what the
/// recogniser "hears" for the whole session. Substitutions mangle the word
/// the same way in partials and finals — real recognisers are consistently
/// wrong, not randomly wrong per revision.
fn corrupt_words(words: &[GoldWord], corruption: &Corruption, seed: u64) -> Vec<Option<String>> {
    let mut rng = Lcg::new(seed ^ 0x5bd1e995);
    const JUNK: &[&str] = &["a", "the", "and", "it", "that", "to"];
    words
        .iter()
        .map(|w| {
            let roll = rng.per_mille();
            if roll < corruption.delete {
                return None;
            }
            if roll < corruption.delete + corruption.substitute {
                return Some(mangle(&w.text, &mut rng));
            }
            let mut text = w.text.clone();
            if rng.per_mille() < corruption.insert {
                text.push(' ');
                text.push_str(rng.pick(JUNK));
            }
            Some(text)
        })
        .collect()
}

/// Deterministically mangle a word the way ASR errors look: drop a
/// character, double one, or swap a vowel.
fn mangle(word: &str, rng: &mut Lcg) -> String {
    let chars: Vec<char> = word.chars().collect();
    if chars.len() < 3 {
        return format!("{word}s");
    }
    match rng.next_u32() % 3 {
        0 => {
            // Drop an interior character.
            let at = 1 + (rng.next_u32() as usize) % (chars.len() - 2);
            chars
                .iter()
                .enumerate()
                .filter(|(i, _)| *i != at)
                .map(|(_, c)| c)
                .collect()
        }
        1 => {
            // Swap a vowel.
            let vowels = ['a', 'e', 'i', 'o', 'u'];
            let mut out: Vec<char> = chars.clone();
            for c in out.iter_mut() {
                if vowels.contains(c) {
                    *c = vowels[(rng.next_u32() as usize) % vowels.len()];
                    break;
                }
            }
            out.into_iter().collect()
        }
        _ => {
            // Double a character.
            let at = (rng.next_u32() as usize) % chars.len();
            let mut out = String::new();
            for (i, c) in chars.iter().enumerate() {
                out.push(*c);
                if i == at {
                    out.push(*c);
                }
            }
            out
        }
    }
}

/// Generate the full ordered event log for a gold timeline.
pub fn generate_events(gold: &GoldTimeline, corruption: &Corruption, seed: u64) -> Vec<SttFrame> {
    let heard = corrupt_words(&gold.words, corruption, seed);
    let mut events: Vec<SttFrame> = Vec::new();

    // Group words into utterances by gap.
    let mut utterances: Vec<(usize, usize)> = Vec::new(); // [start, end) word idx
    let mut start = 0usize;
    for i in 1..gold.words.len() {
        if gold.words[i].start_ms - gold.words[i - 1].end_ms >= UTTERANCE_GAP_MS {
            utterances.push((start, i));
            start = i;
        }
    }
    if start < gold.words.len() {
        utterances.push((start, gold.words.len()));
    }

    for (ordinal, &(u_start, u_end)) in utterances.iter().enumerate() {
        let item_id = format!("1-{ordinal}");
        let speech_start = gold.words[u_start].start_ms;
        let speech_end = gold.words[u_end - 1].end_ms;

        events.push(SttFrame::ItemStarted {
            item_id: item_id.clone(),
            ordinal: ordinal as u64,
            audio_start_ms: speech_start + ONSET_DELAY_MS,
        });

        // Partials on a cadence until the final.
        let final_at = speech_end + FINAL_DELAY_MS;
        let mut t = speech_start + PARTIAL_LAG_MS + PARTIAL_EVERY_MS / 2.0;
        while t < final_at - 200.0 {
            let visible_until = t - PARTIAL_LAG_MS;
            let text = utterance_text(&gold.words, &heard, u_start, u_end, visible_until);
            if !text.is_empty() {
                events.push(SttFrame::Partial {
                    item_id: item_id.clone(),
                    text,
                    audio_ms: t,
                    wall_ms: t,
                });
            }
            t += PARTIAL_EVERY_MS;
        }

        let text = utterance_text(&gold.words, &heard, u_start, u_end, f64::INFINITY);
        events.push(SttFrame::Final {
            item_id,
            text,
            audio_end_ms: final_at,
            wall_ms: final_at,
        });
    }
    events
}

fn utterance_text(
    words: &[GoldWord],
    heard: &[Option<String>],
    start: usize,
    end: usize,
    until_ms: f64,
) -> String {
    let mut out = String::new();
    for i in start..end {
        if words[i].end_ms > until_ms {
            break;
        }
        if let Some(text) = &heard[i] {
            if !out.is_empty() {
                out.push(' ');
            }
            out.push_str(text);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::{expand, synthetic_timing, PerformancePlan, PlanOp};
    use cc_align::{compile, CompileOptions};

    #[test]
    fn clean_read_produces_partials_then_final() {
        let script = compile(
            "alpha bravo charlie delta echo foxtrot golf hotel india juliet",
            CompileOptions::default(),
        );
        let plan = PerformancePlan {
            name: "t".into(),
            script: "t".into(),
            scenario: "exact".into(),
            seed: 7,
            ops: vec![PlanOp::Read { from: 0, to: 10 }],
            corruption: Default::default(),
        };
        let perf = expand(&plan, &script);
        let gold = synthetic_timing(&perf, 150);
        let events = generate_events(&gold, &plan.corruption, plan.seed);
        let partials = events
            .iter()
            .filter(|e| matches!(e, SttFrame::Partial { .. }))
            .count();
        let finals = events
            .iter()
            .filter(|e| matches!(e, SttFrame::Final { .. }))
            .count();
        assert!(partials >= 2, "10 words at 150wpm spans several partials");
        assert_eq!(finals, 1);
        // The final restates all ten words.
        if let Some(SttFrame::Final { text, .. }) = events.last() {
            assert_eq!(text.split_whitespace().count(), 10);
        } else {
            panic!("last event must be the final");
        }
    }

    #[test]
    fn pause_splits_utterances() {
        let script = compile(
            "alpha bravo charlie delta echo foxtrot",
            CompileOptions::default(),
        );
        let plan = PerformancePlan {
            name: "t".into(),
            script: "t".into(),
            scenario: "pause".into(),
            seed: 7,
            ops: vec![
                PlanOp::Read { from: 0, to: 3 },
                PlanOp::Pause { ms: 2_000 },
                PlanOp::Read { from: 3, to: 6 },
            ],
            corruption: Default::default(),
        };
        let perf = expand(&plan, &script);
        let gold = synthetic_timing(&perf, 150);
        let events = generate_events(&gold, &plan.corruption, plan.seed);
        let finals = events
            .iter()
            .filter(|e| matches!(e, SttFrame::Final { .. }))
            .count();
        assert_eq!(finals, 2, "the 2s pause must split the take into two items");
    }

    #[test]
    fn corruption_is_deterministic() {
        let gold_words: Vec<GoldWord> = (0..50)
            .map(|i| GoldWord {
                start_ms: i as f64 * 400.0,
                end_ms: i as f64 * 400.0 + 400.0,
                text: format!("word{i}"),
                gold: crate::plan::GoldTag::Script { pos_after: i + 1 },
            })
            .collect();
        let gold = GoldTimeline {
            words: gold_words,
            viewport_hints: vec![],
            total_ms: 21_000.0,
        };
        let corruption = Corruption {
            substitute: 100,
            delete: 50,
            insert: 50,
        };
        let a = generate_events(&gold, &corruption, 42);
        let b = generate_events(&gold, &corruption, 42);
        assert_eq!(
            serde_json::to_string(&a).unwrap(),
            serde_json::to_string(&b).unwrap()
        );
    }
}
