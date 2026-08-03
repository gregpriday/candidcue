//! The speech-to-text boundary: one event protocol, and the recognisers that
//! speak it.
//!
//! [`SttFrame`] is the only thing the alignment engine, the replay harness and
//! the evaluator know about a recogniser. Everything else — model files, audio
//! clocks — lives behind it. That boundary is what let the recogniser be
//! swapped as a measurable change rather than a leap of faith: a captured log
//! replays through the same engine and is scored by the same evaluator
//! whichever implementation wrote it, which is why the frozen corpora under
//! `bench/runs*/` still mean something.
//!
//! [`local`] — sherpa-onnx streaming Zipformer, on-device — is the only
//! recogniser there is. No network, no key, no per-minute cost.

pub mod local;
pub mod models;
pub mod word_times;

use serde::{Deserialize, Serialize};

/// Sample rate of the benchmark fixture audio. The local recogniser resamples
/// internally, so this is a property of the fixtures rather than a constraint
/// on capture.
pub const SAMPLE_RATE_HZ: u32 = 24_000;

/// One word of a hypothesis, and when the recogniser believes it was spoken.
///
/// `start_ms` is on the same audio clock as every other time in [`SttFrame`],
/// so it is directly comparable to `audio_ms` / `audio_end_ms` without knowing
/// anything about the recogniser that produced it.
///
/// **It is a word ONSET, and it runs late.** Measured against speech with
/// known word boundaries, the shipped x-asr model's timestamps trail the true
/// acoustic onset by roughly 100–340 ms (mean ~200 ms) — a streaming
/// transducer times a token from the frame at which the decoder *committed* to
/// it, not from the frame the sound began. That direction is the safe one for
/// this app: the display trailing the presenter is survivable and leading them
/// is not. Anything that later turns these into scroll motion must keep
/// treating the number as a lower bound on "this had been said by now", not as
/// an exact acoustic mark. See `word_times` for how one is derived.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WordTime {
    /// The word as the recogniser spelled it, punctuation attached.
    pub text: String,
    /// Audio-clock milliseconds at which this word was timed.
    pub start_ms: f64,
}

/// Same shape the app's renderer receives, plus the audio clock at the moment
/// the frame was observed — which is what the alignment benchmark needs.
///
/// The audio clock is "how much audio the recogniser has consumed" — samples
/// handed to the ONNX graph. Every corpus under `bench/runs*/` was captured
/// against that same definition, which is what keeps them comparable.
///
/// `word_times` is optional because it is genuinely absent rather than empty,
/// two ways. Every run captured in `bench/runs*/` predates the field, so a
/// whole corpus reads as untimed; and live, [`word_times::reconstruct`] declines
/// rather than guesses when the recogniser hands back tokens and timestamps it
/// cannot reconcile. `None` means "nothing was said about timing", which a
/// consumer must not confuse with "it said there were no words". Anything
/// scoring word timing has to report that as *unavailable* rather than treating
/// a missing vector as zeroes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SttFrame {
    #[serde(rename_all = "camelCase")]
    ItemStarted {
        item_id: String,
        ordinal: u64,
        audio_start_ms: f64,
    },
    #[serde(rename_all = "camelCase")]
    Partial {
        item_id: String,
        text: String,
        /// Audio-clock milliseconds when this partial arrived.
        audio_ms: f64,
        /// Wall-clock ms since session start when this partial arrived —
        /// captures recogniser latency for lag analysis.
        wall_ms: f64,
        /// When each word of `text` was spoken, if the recogniser reports it.
        ///
        /// Carried on every revision rather than only on the final: a final
        /// arrives after the endpoint silence that closed the utterance, which
        /// is far too late to be worth anything to a live follower.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        word_times: Option<Vec<WordTime>>,
    },
    #[serde(rename_all = "camelCase")]
    Final {
        item_id: String,
        text: String,
        audio_end_ms: f64,
        wall_ms: f64,
        /// When each word of `text` was spoken, if the recogniser reports it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        word_times: Option<Vec<WordTime>>,
    },
    #[serde(rename_all = "camelCase")]
    Error { message: String },
    #[serde(rename_all = "camelCase")]
    Closed {},
}

pub use local::{LocalModelTuning, LocalRecognizer, LocalSttConfig};
pub use models::{bundled_models, default_model, model_by_id, BundledModel};

#[cfg(test)]
mod protocol_tests {
    use super::*;

    /// Every run under `bench/runs*/` was captured before word timing existed.
    /// Those files are the frozen baseline the on-device model is judged
    /// against, so a widening that cannot read them is not a widening — it is a
    /// corpus you have to take on faith.
    #[test]
    fn a_frame_captured_before_word_timing_still_reads() {
        let partial = r#"{"kind":"partial","itemId":"1-0","text":"hello","audioMs":120.0,"wallMs":340.0}"#;
        let frame: SttFrame = serde_json::from_str(partial).expect("legacy partial reads");
        match frame {
            SttFrame::Partial {
                text, word_times, ..
            } => {
                assert_eq!(text, "hello");
                assert_eq!(word_times, None, "a legacy frame reports no timing at all");
            }
            other => panic!("expected a partial, got {other:?}"),
        }

        let final_line = r#"{"kind":"final","itemId":"1-0","text":"hello","audioEndMs":900.0,"wallMs":1100.0}"#;
        let frame: SttFrame = serde_json::from_str(final_line).expect("legacy final reads");
        match frame {
            SttFrame::Final { word_times, .. } => assert_eq!(word_times, None),
            other => panic!("expected a final, got {other:?}"),
        }
    }

    /// An untimed frame must serialise back to the shape the corpus already
    /// holds. If `wordTimes: null` started appearing, every captured file would
    /// differ from the one beside it for a reason that is not a measurement.
    #[test]
    fn an_untimed_frame_serialises_exactly_as_it_used_to() {
        let json = serde_json::to_string(&SttFrame::Partial {
            item_id: "1-0".into(),
            text: "hello".into(),
            audio_ms: 120.0,
            wall_ms: 340.0,
            word_times: None,
        })
        .expect("serialises");
        assert!(
            !json.contains("wordTimes"),
            "an untimed frame must not mention the field: {json}"
        );
    }

    #[test]
    fn word_times_round_trip_in_camel_case() {
        let frame = SttFrame::Final {
            item_id: "1-0".into(),
            text: "hello world".into(),
            audio_end_ms: 900.0,
            wall_ms: 1100.0,
            word_times: Some(vec![
                WordTime {
                    text: "hello".into(),
                    start_ms: 120.0,
                },
                WordTime {
                    text: "world".into(),
                    start_ms: 480.0,
                },
            ]),
        };
        let json = serde_json::to_string(&frame).expect("serialises");
        assert!(json.contains(r#""wordTimes""#), "{json}");
        assert!(json.contains(r#""startMs":120.0"#), "{json}");

        let back: SttFrame = serde_json::from_str(&json).expect("reads back");
        match back {
            SttFrame::Final { word_times, .. } => {
                let times = word_times.expect("timing survives the round trip");
                assert_eq!(times.len(), 2);
                assert_eq!(times[1].text, "world");
                assert_eq!(times[1].start_ms, 480.0);
            }
            other => panic!("expected a final, got {other:?}"),
        }
    }
}
