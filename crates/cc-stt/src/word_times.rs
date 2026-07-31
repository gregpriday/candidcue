//! Turning a recogniser's sub-word tokens into words with clocks.
//!
//! sherpa hands back a hypothesis as SentencePiece pieces — `[" ju", "mp",
//! "s"]` — with one timestamp each. The alignment engine wants WORDS, so this
//! module is the join: it walks the pieces, decides where words begin, and
//! anchors each word to the clock of the piece that opened it.
//!
//! It is deliberately free of the model, the C library and the session: given
//! two vectors and an origin it is a pure function, which is the only reason
//! the awkward cases below can be tested at all without 161 MB of ONNX graphs.
//!
//! # What the timestamps actually mean
//!
//! Measured against `say`-generated speech whose word boundaries were known to
//! the millisecond (silence trimmed, then concatenated with exact gaps), on the
//! shipped `x-asr-480ms` bundle:
//!
//! * **Timestamps are SEGMENT-relative.** They restart near zero every time the
//!   endpoint rule fires and `segment` ticks over; `start_time` carries the
//!   segment's own origin. Absolute audio-clock ms is
//!   `(start_time + timestamps[i]) * 1000`. This was settled by forcing a
//!   second segment with a 2 s gap: `segment` went `0 → 1`, `start_time` went
//!   `0.0 → 4.8`, and the timestamps restarted at `0.04`.
//! * **A timestamp is a token ONSET, and it runs late** — 100–340 ms late
//!   (mean ~200 ms) against true acoustic onset, because a streaming
//!   transducer times a token from the frame at which it committed to the
//!   token rather than the frame the sound started. Within a word the pieces
//!   still spread across that word's own span, and every word's first piece
//!   lands well before that word's true END, which is what rules out the
//!   alternative reading.
//!
//! Both facts are properties of THIS tokenizer and THIS model. A model swap
//! invalidates them, and `examples/probe_timestamps.rs` is how they were
//! measured — re-run it rather than assuming they carried over.

use crate::WordTime;

/// SentencePiece's word-boundary marker as `tokens.txt` stores it.
///
/// Present here for completeness, because sherpa does NOT hand it back: the
/// JSON result has already rewritten it to a plain space, so a hypothesis
/// arrives as `[" It", "'", "s"]` rather than `["▁It", "'", "s"]`. Accepting
/// both costs one comparison and means a future sherpa that stops rewriting is
/// a no-op here instead of a silent collapse to one enormous word.
const SENTENCEPIECE_SPACE: char = '\u{2581}';

/// Does this piece begin a new word?
fn starts_word(token: &str) -> bool {
    token.starts_with(' ') || token.starts_with(SENTENCEPIECE_SPACE)
}

/// The piece with its boundary marker removed.
fn strip_marker(token: &str) -> &str {
    token
        .strip_prefix(' ')
        .or_else(|| token.strip_prefix(SENTENCEPIECE_SPACE))
        .unwrap_or(token)
}

/// Is this piece punctuation rather than a word?
///
/// It has to be asked, because the punctuated model marks punctuation as
/// word-initial exactly like a real word: a full stop arrives as `" ."`. Taken
/// at face value that mints `.` as its own word, and every sentence in the
/// transcript would carry a bare-stop "word" that the script can never match.
fn is_punctuation(stripped: &str) -> bool {
    !stripped.is_empty()
        && stripped
            .chars()
            .all(|c| !c.is_alphanumeric() && !matches!(c, '\'' | '’' | '-'))
}

/// Join `tokens` into words and put each one on the audio clock.
///
/// `segment_start_ms` is the segment's own origin — sherpa's `start_time`, in
/// milliseconds — because the timestamps are relative to it. `floor_ms` and
/// `ceil_ms` bound the result into the window the item is actually known to
/// occupy: the clock the item was opened at, and the clock of the frame being
/// emitted.
///
/// Returns `None` rather than a partial answer whenever the inputs cannot be
/// trusted — a length mismatch, a non-finite number, no timestamps at all.
/// Handing back a short vector would be worse than handing back nothing:
/// downstream is going to line these up against words, and a silently
/// truncated vector mis-clocks every word after the gap instead of announcing
/// that it does not know.
pub fn reconstruct(
    tokens: &[String],
    timestamps: &[f32],
    segment_start_ms: f64,
    floor_ms: f64,
    ceil_ms: f64,
) -> Option<Vec<WordTime>> {
    if tokens.is_empty() || tokens.len() != timestamps.len() {
        return None;
    }
    if !segment_start_ms.is_finite() || !floor_ms.is_finite() || !ceil_ms.is_finite() {
        return None;
    }
    if timestamps.iter().any(|t| !t.is_finite()) {
        return None;
    }

    let mut words: Vec<WordTime> = Vec::new();
    // Punctuation ahead of the first real word has nothing to attach to yet, so
    // it waits here for one.
    let mut orphaned = String::new();

    for (token, offset) in tokens.iter().zip(timestamps) {
        let piece = strip_marker(token);
        if piece.is_empty() {
            continue;
        }
        let at_ms = segment_start_ms + *offset as f64 * 1000.0;

        if is_punctuation(piece) {
            match words.last_mut() {
                // Punctuation belongs to the word it follows and must not
                // disturb that word's clock — the word was spoken when it was
                // spoken, whatever the comma after it is dated.
                Some(word) => word.text.push_str(piece),
                None => orphaned.push_str(piece),
            }
            continue;
        }

        if starts_word(token) || words.is_empty() {
            let mut text = std::mem::take(&mut orphaned);
            text.push_str(piece);
            words.push(WordTime {
                text,
                start_ms: at_ms,
            });
        } else {
            // A continuation piece. The word keeps the clock of the piece that
            // opened it, which is the closest thing to its onset available.
            words
                .last_mut()
                .expect("non-empty by the branch above")
                .text
                .push_str(piece);
        }
    }

    if words.is_empty() {
        return None;
    }

    // Bound into the item's known window, and keep the sequence non-decreasing.
    // Equal neighbours are legitimate: the encoder quantises to a frame step,
    // so two short words can genuinely land on the same one.
    let lo = floor_ms.min(ceil_ms);
    let mut running = lo;
    for word in &mut words {
        running = word.start_ms.clamp(lo, ceil_ms).max(running);
        word.start_ms = running;
    }

    Some(words)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens(raw: &[&str]) -> Vec<String> {
        raw.iter().map(|t| t.to_string()).collect()
    }

    /// The offsets arrive as `f32` seconds, so a clean 0.84 s is 839.99997 ms
    /// by the time it is milliseconds. Sub-millisecond noise on a number whose
    /// own quantum is 40 ms is not worth chasing — but it does mean these
    /// assertions cannot be exact.
    #[track_caller]
    fn assert_close(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() < 0.001,
            "expected ~{expected} ms, got {actual}"
        );
    }

    /// The shape the model actually emits — a leading SPACE, not `▁`.
    #[test]
    fn space_prefixed_pieces_join_into_words() {
        let words = reconstruct(
            &tokens(&[" ju", "mp", "s", " over"]),
            &[1.52, 1.64, 1.72, 1.88],
            0.0,
            0.0,
            5_000.0,
        )
        .expect("reconstructs");

        assert_eq!(words.len(), 2);
        assert_eq!(words[0].text, "jumps");
        assert_close(words[0].start_ms, 1520.0);
        assert_eq!(words[1].text, "over");
        assert_close(words[1].start_ms, 1880.0);
    }

    /// The marker `tokens.txt` stores, in case sherpa ever stops rewriting it.
    #[test]
    fn sentencepiece_marked_pieces_join_the_same_way() {
        let words = reconstruct(
            &tokens(&["▁read", "ing", "▁world"]),
            &[0.1, 0.2, 0.4],
            0.0,
            0.0,
            5_000.0,
        )
        .expect("reconstructs");

        assert_eq!(words.len(), 2);
        assert_eq!(words[0].text, "reading");
        assert_eq!(words[1].text, "world");
    }

    /// A word is anchored to the piece that OPENED it, not the last one.
    #[test]
    fn a_multi_piece_word_keeps_the_clock_of_its_first_piece() {
        let words = reconstruct(
            &tokens(&[" b", "ro", "w", "n"]),
            &[0.84, 0.96, 1.04, 1.08],
            0.0,
            0.0,
            5_000.0,
        )
        .expect("reconstructs");

        assert_eq!(words.len(), 1);
        assert_eq!(words[0].text, "brown");
        assert_close(words[0].start_ms, 840.0);
    }

    /// The punctuated model marks a full stop as word-initial. Believing it
    /// would mint `.` as a word the script can never match.
    #[test]
    fn punctuation_attaches_rather_than_becoming_its_own_word() {
        let words = reconstruct(
            &tokens(&[" Hello", " ,", " world", " ."]),
            &[0.1, 0.3, 0.4, 0.9],
            0.0,
            0.0,
            5_000.0,
        )
        .expect("reconstructs");

        assert_eq!(words.len(), 2);
        assert_eq!(words[0].text, "Hello,");
        assert_eq!(words[1].text, "world.");
        // The comma is dated 300 ms; the word it follows keeps its own 100 ms.
        assert_close(words[0].start_ms, 100.0);
        assert_close(words[1].start_ms, 400.0);
    }

    #[test]
    fn punctuation_before_any_word_is_carried_onto_the_first_one() {
        let words = reconstruct(
            &tokens(&[" ,", " well"]),
            &[0.1, 0.2],
            0.0,
            0.0,
            5_000.0,
        )
        .expect("reconstructs");

        assert_eq!(words.len(), 1);
        assert_eq!(words[0].text, ",well");
        assert_close(words[0].start_ms, 200.0);
    }

    /// An apostrophe is inside a word, not punctuation between words —
    /// `["It", "'", "s"]` is one word, and splitting it would hand the engine
    /// a bare `'`.
    #[test]
    fn an_apostrophe_does_not_split_a_contraction() {
        let words = reconstruct(
            &tokens(&[" It", "'", "s", " a"]),
            &[0.16, 0.2, 0.24, 0.36],
            0.0,
            0.0,
            5_000.0,
        )
        .expect("reconstructs");

        assert_eq!(words.len(), 2);
        assert_eq!(words[0].text, "It's");
        assert_eq!(words[1].text, "a");
    }

    /// Timestamps are relative to the segment, so a second utterance's words
    /// have to be lifted by its origin or every one of them lands near zero.
    #[test]
    fn a_second_segments_offsets_are_lifted_onto_the_audio_clock() {
        let words = reconstruct(
            &tokens(&[" P", "a", "ck", " my"]),
            &[0.04, 0.12, 0.2, 0.32],
            4_800.0,
            4_497.0,
            5_500.0,
        )
        .expect("reconstructs");

        assert_eq!(words.len(), 2);
        assert_eq!(words[0].text, "Pack");
        assert_close(words[0].start_ms, 4840.0);
        assert_close(words[1].start_ms, 5120.0);
    }

    #[test]
    fn times_are_bounded_by_the_items_own_window() {
        let words = reconstruct(
            &tokens(&[" a", " b"]),
            &[0.0, 9.0],
            0.0,
            500.0,
            2_000.0,
        )
        .expect("reconstructs");

        // Floored to the item's start, capped at the frame's clock.
        assert_close(words[0].start_ms, 500.0);
        assert_close(words[1].start_ms, 2000.0);
    }

    /// The encoder quantises, so two short words genuinely can share a frame.
    /// Equal is fine; going backwards is not.
    #[test]
    fn the_sequence_never_steps_backwards_but_may_stand_still() {
        let words = reconstruct(
            &tokens(&[" a", " b", " c"]),
            &[1.0, 0.5, 1.0],
            0.0,
            0.0,
            5_000.0,
        )
        .expect("reconstructs");

        assert_close(words[0].start_ms, 1000.0);
        // Pulled up to its predecessor, not left behind at 500.
        assert_close(words[1].start_ms, 1000.0);
        assert_close(words[2].start_ms, 1000.0);
    }

    /// Fail closed. A short vector would mis-clock every word after the gap,
    /// and do it silently.
    #[test]
    fn a_length_mismatch_reports_nothing_rather_than_a_partial_answer() {
        assert_eq!(
            reconstruct(&tokens(&[" a", " b"]), &[0.1], 0.0, 0.0, 5_000.0),
            None
        );
        assert_eq!(
            reconstruct(&tokens(&[" a"]), &[0.1, 0.2], 0.0, 0.0, 5_000.0),
            None
        );
    }

    #[test]
    fn nothing_to_say_is_reported_as_nothing() {
        assert_eq!(reconstruct(&[], &[], 0.0, 0.0, 5_000.0), None);
        // Pieces that are only a boundary marker leave no word behind.
        assert_eq!(
            reconstruct(&tokens(&[" "]), &[0.1], 0.0, 0.0, 5_000.0),
            None
        );
    }

    #[test]
    fn a_non_finite_number_anywhere_reports_nothing() {
        assert_eq!(
            reconstruct(&tokens(&[" a"]), &[f32::NAN], 0.0, 0.0, 5_000.0),
            None
        );
        assert_eq!(
            reconstruct(&tokens(&[" a"]), &[f32::INFINITY], 0.0, 0.0, 5_000.0),
            None
        );
        assert_eq!(
            reconstruct(&tokens(&[" a"]), &[0.1], f64::NAN, 0.0, 5_000.0),
            None
        );
        assert_eq!(
            reconstruct(&tokens(&[" a"]), &[0.1], 0.0, f64::NAN, 5_000.0),
            None
        );
    }

    /// Punctuation with nothing else in the hypothesis is not a word.
    #[test]
    fn punctuation_alone_produces_no_words() {
        assert_eq!(
            reconstruct(&tokens(&[" ."]), &[0.1], 0.0, 0.0, 5_000.0),
            None
        );
    }
}
