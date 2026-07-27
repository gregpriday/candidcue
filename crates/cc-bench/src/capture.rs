//! Live capture: stream synthesised fixture audio through the actual Inworld
//! endpoint via cc-stt (the same wire protocol the app uses) and persist the
//! resulting event log as an immutable replay fixture.
//!
//! Capture runs at real-time pace by default — provider partial cadence and
//! endpoint latency are only meaningful at 1.0×. The captured JSONL is small
//! and lives in bench/runs/ under git; the audio stays in the scratch dir.

use std::path::Path;

use tokio::sync::mpsc;

use cc_stt::{stream_pcm, SttFrame, TranscribeConfig};

/// Stream `pcm` and return every frame observed, in order.
pub async fn capture_events(pcm: &[u8], pace: f64) -> anyhow::Result<Vec<SttFrame>> {
    capture_events_with(pcm, pace, &[]).await
}

/// Stream `pcm` with a custom vocabulary on the config frame.
///
/// `prompts` empty is byte-for-byte the request [`capture_events`] has always
/// made, which is what lets a vocabulary run be compared against a frozen
/// fixture captured before this parameter existed.
pub async fn capture_events_with(
    pcm: &[u8],
    pace: f64,
    prompts: &[String],
) -> anyhow::Result<Vec<SttFrame>> {
    let key = std::env::var("INWORLD_API_KEY")
        .map_err(|_| anyhow::anyhow!("INWORLD_API_KEY not set in the environment"))?;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let config = TranscribeConfig {
        prompts: prompts.to_vec(),
        ..TranscribeConfig::default()
    };

    let streamer = stream_pcm(&key, &config, pcm, 100, pace, tx);
    let collector = async {
        let mut events = Vec::new();
        while let Some(frame) = rx.recv().await {
            let done = matches!(frame, SttFrame::Closed {});
            events.push(frame);
            if done {
                break;
            }
        }
        events
    };
    let (stream_result, events) = tokio::join!(streamer, collector);
    stream_result.map_err(|e| anyhow::anyhow!("stream failed: {e}"))?;

    if let Some(SttFrame::Error { message }) = events
        .iter()
        .find(|e| matches!(e, SttFrame::Error { .. }))
    {
        anyhow::bail!("provider error during capture: {message}");
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
