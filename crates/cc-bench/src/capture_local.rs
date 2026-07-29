//! Local capture: stream the same fixture audio through the on-device
//! recogniser and persist the event log in the same shape `bench/runs/` holds.
//!
//! This is the twin of [`crate::capture`], and the pairing is the experiment.
//! Both write `events.jsonl` + `gold.json` + `manifest.json` + `performance.txt`
//! into a run directory; `tier-b --runs DIR` scores either one with the same
//! evaluator against the same gold timeline. The only variable between the two
//! corpora is which recogniser heard the audio.
//!
//! Capture runs at real-time pace for the same reason the hosted capture did:
//! the model is roughly 16× faster than real time on this hardware, and
//! partial-latency numbers taken faster than 1.0× describe a machine nobody is
//! presenting from.

use std::path::Path;

use cc_stt::{LocalRecognizer, SttFrame};

/// Stream `pcm` (raw PCM16 at `sample_rate`) through `recognizer` and return
/// every frame observed, in order.
pub fn capture_events(
    recognizer: &LocalRecognizer,
    pcm: &[u8],
    sample_rate: u32,
    pace: f64,
) -> Vec<SttFrame> {
    let mut events = Vec::new();
    cc_stt::local::stream_pcm16(recognizer, pcm, sample_rate, 100, pace, |frame| {
        events.push(frame)
    });
    events
}

/// Read a captured run's event log. Shape-identical to the hosted corpus, so
/// this is [`crate::capture::read_events_jsonl`] by another name — it exists so
/// a local-only build does not have to reach through the `inworld` module.
pub fn read_events_jsonl(path: &Path) -> anyhow::Result<Vec<SttFrame>> {
    crate::capture::read_events_jsonl(path)
}

pub fn write_events_jsonl(path: &Path, events: &[SttFrame]) -> anyhow::Result<()> {
    crate::capture::write_events_jsonl(path, events)
}
