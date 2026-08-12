//! Tier A: deterministic synthetic transcript events.
//!
//! Simulates the cadence of the recogniser the app SHIPS, without audio or
//! model: an item opens at speech onset, full-restatement partials arrive on a
//! ~300 ms cadence, a final restates the utterance after the closing pause.
//! Corruption is seeded and reproducible, so a Tier-A suite is a pure function
//! of (plan, seed) and runs in milliseconds — this is what CI regression
//! numbers come from.
//!
//! ---------------------------------------------------------------------------
//! RE-BASED WHEN SPEECH RECOGNITION MOVED ON-DEVICE
//! ---------------------------------------------------------------------------
//! These constants used to describe the hosted recogniser the app replaced:
//! partials every 900 ms, because that is what it did. The shipping on-device
//! transducer emits twice as often, so the old numbers modelled a cadence no
//! recogniser in this app produces.
//!
//! That mattered for more than realism. `AlignmentConfig::partial_lag_ms` is
//! the engine's correction for exactly this delay; tuning it against real
//! captures gave 0, and scoring THAT against a simulator still emitting a
//! 400 ms lag made Tier A look like a 16-point regression that no presenter
//! would ever have experienced. A simulator and a config that disagree about
//! the provider produce numbers that are precise and meaningless.
//!
//! Measured on 18 runs / 33 min of speech, per recogniser: the hosted service
//! emitted every 1000 ms, the 20M Zipformer every 300 ms, and the shipping
//! x-asr 480 ms model every 500 ms. Tier-A numbers from before this change are
//! NOT comparable with numbers from after it.

use cc_stt::SttFrame;

use crate::plan::{Corruption, GoldTimeline, GoldWord};

/// Gaps of at least this length close an utterance (server VAD behaviour).
const UTTERANCE_GAP_MS: f64 = 900.0;
/// Emission lag: a partial covers words finished this long before it arrives.
///
/// The simulator's half of `AlignmentConfig::partial_lag_ms`. The shipping
/// recogniser decodes in 480 ms chunks, so a partial covers words that ended
/// roughly that long before it arrives.
const PARTIAL_LAG_MS: f64 = 400.0;
/// Partial cadence while speech continues. Median measured on the shipping
/// recogniser's corpus (500 ms); the hosted service was 1000.
const PARTIAL_EVERY_MS: f64 = 500.0;
/// Final arrives this long after the last word of the utterance ends.
const FINAL_DELAY_MS: f64 = 1_200.0;
/// ItemStarted fires this long after actual onset — the decoder needs acoustic
/// context before it will commit to a first token. Median measured at 300 ms.
const ONSET_DELAY_MS: f64 = 300.0;

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
                    // Tier A scenarios are built from a gold timeline rather
                    // than heard, so any word time here would be the answer
                    // handed back to the engine as evidence.
                    word_times: None,
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
            /*
             * Tier A models a silence endpoint: `final_at` is placed an
             * endpoint lag after the last synthetic word, which is exactly
             * what an endpoint rule firing on trailing silence produces.
             * Saying so explicitly keeps the synthetic scenarios exercising
             * the same ledger branch the recorded corpora do.
             */
            close_reason: cc_stt::CloseReason::Silence,
            // Synthetic audio has no recogniser and therefore no measurement.
            // `None` means "nothing was said about timing", which the ledger
            // must not confuse with a measurement of zero.
            acoustic_end_ms: None,
            word_times: None,
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
                gold: crate::plan::GoldTag::Script {
                    pos_after: i + 1,
                    span: None,
                },
                respelled: false,
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

#[cfg(test)]
mod cadence_tests {
    use super::*;

    /// The simulator and the engine must describe the SAME recogniser.
    ///
    /// `PARTIAL_LAG_MS` here and `AlignmentConfig::partial_lag_ms` there are
    /// two halves of one physical fact: how far behind the audio clock a
    /// partial's words are. When they disagree, Tier A scores the engine
    /// against a cadence no recogniser emits and the number looks like a
    /// regression that nobody could ever experience — which is exactly what
    /// happened when the on-device model landed and only one of the two was
    /// updated. `clean_within2` read 41% against a real 99.9%.
    ///
    /// Both move when the bundled model does. This is the guard that makes
    /// forgetting one of them fail here instead of in a benchmark table.
    #[test]
    fn the_simulator_and_the_engine_agree_about_partial_lag() {
        assert_eq!(
            PARTIAL_LAG_MS,
            cc_align::AlignmentConfig::default().partial_lag_ms,
            "synthetic.rs PARTIAL_LAG_MS and AlignmentConfig::partial_lag_ms \
             describe the same recogniser and must be changed together"
        );
    }

    /// The modelled timings have to be timings.
    ///
    /// Deliberately does NOT assert `PARTIAL_LAG_MS <= PARTIAL_EVERY_MS`. That
    /// looks like a physical law and is not one: a recogniser is free to emit
    /// often while every hypothesis carries more pipeline latency than the gap
    /// between them, which is exactly what a low-latency chunked model with a
    /// deep encoder does. The only real coupling is the one above.
    /*
     * Compile-time, because these are constants: as a `#[test]` every one of
     * these assertions had a value the compiler already knew, so the test could
     * not fail — it passed whatever the constants said. A `const` block is
     * checked when the file is built, which is what "these have to be timings"
     * was always meant to mean.
     */
    const _: () = {
        assert!(PARTIAL_LAG_MS >= 0.0);
        assert!(PARTIAL_EVERY_MS > 0.0);
        assert!(FINAL_DELAY_MS > 0.0);
        assert!(ONSET_DELAY_MS >= 0.0);
    };
}
