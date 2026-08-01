//! Offline replay: drive the real engine with an ordered event log (captured
//! live or generated synthetically) plus timed viewport hints, and record
//! everything the evaluator needs. The engine sees *identical* inputs live
//! and in replay — timestamps come from the log, never from a wall clock.

use std::time::Instant;

use cc_align::{AlignmentConfig, CompiledScript, Engine, SessionEvent, Snapshot, TranscriptWordTime};
use cc_stt::SttFrame;

/// Captured per-word timing, in the engine's own vocabulary.
///
/// A fixture recorded before the recogniser timed its words has no `wordTimes`
/// key at all and arrives here as `None`, which is the engine's "date these by
/// interpolation" path — so every frozen corpus replays exactly as it did
/// before, and only a freshly captured one exercises the measured path.
pub fn engine_word_times(times: &Option<Vec<cc_stt::WordTime>>) -> Option<Vec<TranscriptWordTime>> {
    times.as_ref().map(|words| {
        words
            .iter()
            .map(|word| TranscriptWordTime {
                text: word.text.clone(),
                start_ms: word.start_ms,
            })
            .collect()
    })
}

/// Per-item bookkeeping for the pre-final responsiveness metric.
#[derive(Debug, Clone)]
pub struct ItemTrace {
    pub item_id: String,
    pub final_content_words: usize,
    pub observed_at_item_start: f64,
    pub observed_at_last_partial: f64,
    pub observed_at_final: f64,
    pub had_partial: bool,
}

#[derive(Debug)]
pub struct ReplayResult {
    /// Snapshot after every transcript event, in order.
    pub snapshots: Vec<Snapshot>,
    pub items: Vec<ItemTrace>,
    /// Engine time per handled event, microseconds.
    pub event_us: Vec<u64>,
    /// Concatenated final transcript texts (for diagnostic WER).
    pub final_text: String,
}

pub fn replay(
    script: CompiledScript,
    config: AlignmentConfig,
    events: &[SttFrame],
    viewport_hints: &[(f64, u32, u32)],
) -> ReplayResult {
    let mut engine = Engine::new(script, config);
    let mut snapshots = Vec::new();
    let mut items: Vec<ItemTrace> = Vec::new();
    let mut event_us = Vec::new();
    let mut final_text = String::new();
    let mut hint_idx = 0usize;

    let apply_hints = |engine: &mut Engine, up_to_ms: f64, hint_idx: &mut usize| {
        while *hint_idx < viewport_hints.len() && viewport_hints[*hint_idx].0 <= up_to_ms {
            let (_, first, last) = viewport_hints[*hint_idx];
            engine.set_viewport_hint(first, last);
            *hint_idx += 1;
        }
    };

    for frame in events {
        let (event, time_ms) = match frame {
            SttFrame::ItemStarted {
                item_id,
                audio_start_ms,
                ..
            } => (
                SessionEvent::ItemStarted {
                    item_id: item_id.clone(),
                    audio_start_ms: *audio_start_ms,
                },
                *audio_start_ms,
            ),
            SttFrame::Partial {
                item_id,
                text,
                audio_ms,
                word_times,
                ..
            } => (
                SessionEvent::Partial {
                    item_id: item_id.clone(),
                    text: text.clone(),
                    audio_ms: *audio_ms,
                    word_times: engine_word_times(word_times),
                },
                *audio_ms,
            ),
            SttFrame::Final {
                item_id,
                text,
                audio_end_ms,
                word_times,
                ..
            } => (
                SessionEvent::Final {
                    item_id: item_id.clone(),
                    text: text.clone(),
                    audio_end_ms: *audio_end_ms,
                    word_times: engine_word_times(word_times),
                },
                *audio_end_ms,
            ),
            SttFrame::Error { .. } | SttFrame::Closed {} => continue,
        };
        apply_hints(&mut engine, time_ms, &mut hint_idx);

        let started = Instant::now();
        let snapshot = engine.handle(event.clone());
        event_us.push(started.elapsed().as_micros() as u64);

        // Item bookkeeping.
        match &event {
            SessionEvent::ItemStarted { item_id, .. } => {
                items.push(ItemTrace {
                    item_id: item_id.clone(),
                    final_content_words: 0,
                    observed_at_item_start: snapshot.observed,
                    observed_at_last_partial: snapshot.observed,
                    observed_at_final: snapshot.observed,
                    had_partial: false,
                });
            }
            SessionEvent::Partial { item_id, .. } => {
                if let Some(item) = items.iter_mut().rev().find(|i| &i.item_id == item_id) {
                    item.observed_at_last_partial = snapshot.observed;
                    item.had_partial = true;
                }
            }
            SessionEvent::Final { item_id, text, .. } => {
                let content_words = cc_align::normalize::canonical_atoms(text)
                    .iter()
                    .filter(|w| !cc_align::normalize::is_stopword(w))
                    .count();
                if let Some(item) = items.iter_mut().rev().find(|i| &i.item_id == item_id) {
                    item.observed_at_final = snapshot.observed;
                    item.final_content_words = content_words;
                } else {
                    // Final without ItemStarted (possible on live captures).
                    items.push(ItemTrace {
                        item_id: item_id.clone(),
                        final_content_words: content_words,
                        observed_at_item_start: snapshot.observed,
                        observed_at_last_partial: snapshot.observed,
                        observed_at_final: snapshot.observed,
                        had_partial: false,
                    });
                }
                if !final_text.is_empty() {
                    final_text.push(' ');
                }
                final_text.push_str(text);
            }
        }
        snapshots.push(snapshot);
    }

    ReplayResult {
        snapshots,
        items,
        event_us,
        final_text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cc_align::{compile, CompileOptions};

    /// The recogniser's own output, through the real reconstruction, into the
    /// script's reconciliation — and out the other side carrying a clock.
    ///
    /// The GATE is what this covers, not the engine: that word times survive
    /// into the evidence clock is pinned in `cc_align::tracker` and again over
    /// the Tauri handoff in `src-tauri/src/align`. What only this can show is
    /// that the two accounts of an utterance — sherpa's `result.text` and the
    /// words rebuilt from its tokens — still agree once normalised, because
    /// only this crate can see both cc-stt and cc-align.
    ///
    /// This test exists because of a specific past failure. The reversible dim
    /// frontier was believed to work for months while `provisional_advances`
    /// was zero on every recorded fixture: every row exercising it came from
    /// the harness's own synthetic data, and nobody had checked that real
    /// speech could reach it at all.
    ///
    /// Word timing has the same shape of risk. The engine only dates atoms when
    /// it can show that normalising each recogniser word on its own reproduces
    /// the whole utterance exactly, and a gate that never opens would leave the
    /// old interpolation running behind a feature that looks shipped. So this
    /// starts from pieces the real model really emitted — the same ones
    /// `cc_stt::word_times` was measured against, bare boundary marker and
    /// attached punctuation included — and asserts the gate OPENS.
    #[test]
    fn real_recogniser_pieces_reach_the_engine_carrying_their_clocks() {
        // `It's a quick brown fox.` as sherpa pieces it: a leading space marks
        // a word, `'` continues one, and `quick` opens on a piece that is
        // NOTHING but the boundary marker.
        let tokens: Vec<String> = [
            " It", "'", "s", " a", " ", "q", "u", "i", "ck", " brown", " fox", " .",
        ]
        .iter()
        .map(|t| t.to_string())
        .collect();
        let timestamps: [f32; 12] = [
            0.16, 0.20, 0.24, 0.36, 0.60, 0.64, 0.68, 0.72, 0.76, 1.04, 1.40, 1.60,
        ];

        let words = cc_stt::word_times::reconstruct(&tokens, &timestamps, 0.0, 0.0, 2_000.0)
            .expect("the real pieces reconstruct");
        assert_eq!(
            words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>(),
            ["It's", "a", "quick", "brown", "fox."],
            "reconstruction changed; the rest of this test is about the engine"
        );

        // The frame's text is the recogniser's own, which is these pieces with
        // the markers rewritten as spaces — so punctuation stands off the word
        // here where reconstruction attached it. The gate has to survive that.
        let text = "It's a quick brown fox .";
        let script = compile("it's a quick brown fox", CompileOptions::default());
        let dated = script.query_words_with_times(text, &engine_word_times(&Some(words)).unwrap());

        assert!(
            dated.iter().all(|w| w.measured_start_ms.is_some()),
            "the gate refused ordinary punctuated English: {:?}",
            dated
                .iter()
                .map(|w| (&w.surface, w.measured_start_ms))
                .collect::<Vec<_>>()
        );
        // The contraction becomes two atoms out of the ONE word the recogniser
        // timed, and both are dated to it — neither half was spoken at a moment
        // the recogniser has any separate opinion about. `quick` is dated to
        // the bare boundary marker that opened it, which is where the word
        // began, not to the `q` that followed.
        //
        // The offsets arrive as `f32` seconds, so a clean 0.16 s is 159.99999
        // ms by the time it is milliseconds; sub-millisecond noise on a number
        // whose own quantum is 40 ms is not worth chasing.
        let expected = [
            ("it", 160.0),
            ("is", 160.0),
            ("a", 360.0),
            ("quick", 600.0),
            ("brown", 1_040.0),
            ("fox", 1_400.0),
        ];
        assert_eq!(
            dated.iter().map(|w| w.surface.as_str()).collect::<Vec<_>>(),
            expected.iter().map(|(s, _)| *s).collect::<Vec<_>>()
        );
        for (word, (surface, at_ms)) in dated.iter().zip(&expected) {
            let got = word.measured_start_ms.expect("dated");
            assert!(
                (got - at_ms).abs() < 0.01,
                "{surface} dated {got} ms, expected ~{at_ms}"
            );
        }
    }

    /// A frame captured before the recogniser timed its words has no
    /// `wordTimes` key at all, and must reach the engine as "no timing" rather
    /// than as an empty list that could be mistaken for "no words".
    #[test]
    fn a_fixture_without_word_times_carries_none() {
        assert!(engine_word_times(&None).is_none());
    }
}
