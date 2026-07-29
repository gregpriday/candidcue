//! The speech-to-text boundary: one event protocol, and the recognisers that
//! speak it.
//!
//! [`SttFrame`] is the only thing the alignment engine, the replay harness and
//! the evaluator know about a recogniser. Everything else — websockets, model
//! files, audio clocks — lives behind it. That is what made replacing the
//! provider a measurable change rather than a leap of faith: a captured log
//! from either implementation replays through the same engine and is scored by
//! the same evaluator.
//!
//! * [`local`] — sherpa-onnx streaming Zipformer, on-device. **What the app
//!   ships.** No network, no key, no per-minute cost.
//! * `inworld` — the hosted websocket service the app used to depend on.
//!   Behind the non-default `inworld` feature and kept for exactly one reason:
//!   `bench/runs/` is the baseline the local model is judged against, and a
//!   baseline you can no longer re-measure is a number you have to take on
//!   faith. The app does not enable it.

pub mod local;

#[cfg(feature = "inworld")]
pub mod inworld;

use serde::{Deserialize, Serialize};

/// Sample rate of the benchmark fixture audio, and the rate the hosted service
/// was configured for. The local recogniser resamples internally, so this is
/// now a property of the fixtures rather than a constraint on capture.
pub const SAMPLE_RATE_HZ: u32 = 24_000;

/// Same shape the app's renderer receives, plus the audio clock at the moment
/// the frame was observed — which is what the alignment benchmark needs.
///
/// The audio clock is "how much audio the recogniser has consumed", however it
/// consumed it: bytes handed to a socket, or samples handed to an ONNX graph.
/// Both implementations define it that way, so the two are comparable.
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
    },
    #[serde(rename_all = "camelCase")]
    Final {
        item_id: String,
        text: String,
        audio_end_ms: f64,
        wall_ms: f64,
    },
    #[serde(rename_all = "camelCase")]
    Error { message: String },
    #[serde(rename_all = "camelCase")]
    Closed {},
}

pub use local::{LocalRecognizer, LocalSttConfig};
