//! Capture: stream fixture audio through the on-device recogniser and persist
//! the event log in the shape `bench/runs*/` holds.
//!
//! A run directory is `events.jsonl` + `gold.json` + `manifest.json` +
//! `performance.txt`, and `tier-b --runs DIR` scores any of them with the same
//! evaluator against the same gold timeline. That shape predates this module —
//! the corpora captured before the recogniser moved on-device are written the
//! same way — which is what makes the older ones still comparable.
//!
//! Capture runs at real-time pace: the model is roughly 16× faster than real
//! time on this hardware, and partial-latency numbers taken faster than 1.0×
//! describe a machine nobody is presenting from.

use std::path::Path;

use cc_stt::{LocalRecognizer, SttFrame};

/// Stream `pcm` (raw PCM16 at `sample_rate`) through `recognizer` and return
/// every frame observed, in order.
pub fn capture_events(
    recognizer: &LocalRecognizer,
    pcm: &[u8],
    sample_rate: u32,
    pace: f64,
    prime_ms: u32,
) -> Vec<SttFrame> {
    let mut events = Vec::new();
    cc_stt::local::stream_pcm16(recognizer, pcm, sample_rate, 100, pace, prime_ms, |frame| {
        events.push(frame)
    });
    events
}

/// Read a captured run's event log.
pub fn read_events_jsonl(path: &Path) -> anyhow::Result<Vec<SttFrame>> {
    let text = std::fs::read_to_string(path)?;
    let mut events = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        events.push(serde_json::from_str(line)?);
    }
    Ok(events)
}

pub fn write_events_jsonl(path: &Path, events: &[SttFrame]) -> anyhow::Result<()> {
    let mut out = String::new();
    for e in events {
        out.push_str(&serde_json::to_string(e)?);
        out.push('\n');
    }
    std::fs::write(path, out)?;
    Ok(())
}
