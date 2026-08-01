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
