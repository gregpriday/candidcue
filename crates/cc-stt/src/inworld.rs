//! The hosted Inworld streaming STT client — the app's former recogniser.
//!
//! Retained behind the non-default `inworld` feature so `bench/runs/` (the
//! baseline the on-device model is judged against) can be re-captured. The app
//! no longer compiles this.
//!
//! Originally: Tauri-free Inworld streaming STT client.
//!
//! Speaks the exact wire protocol of `src-tauri/src/inworld/stream.rs`, with
//! the Tauri event plumbing replaced by an mpsc channel so the benchmark
//! harness can drive real audio through the real service from a plain binary:
//!
//! * `Authorization: Basic <key>` **header** (query-param auth is rejected by
//!   the live service even though the docs describe it);
//! * first frame is `{"transcribeConfig": …}` — audio sent before it is
//!   silently discarded;
//! * audio frames are `{"audioChunk": {"content": base64(pcm16)}}`;
//! * `{"endTurn":{}}` finishes the last utterance (server VAD never sees
//!   silence from a closed file, so it must be explicit);
//! * inbound transcripts are wrapped in `result`, errors arrive FLAT as
//!   `{"error": …}`.
//!
//! Utterance identity is minted here exactly as the app does: interim frames
//! open an item, `isFinal` closes it, ids are `"{generation}-{ordinal}"`.
//! The audio clock is the byte count of PCM handed to the socket.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};

use crate::{SttFrame, SAMPLE_RATE_HZ};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::{HeaderValue, AUTHORIZATION};
use tokio_tungstenite::tungstenite::Message;

pub const STREAM_URL: &str = "wss://api.inworld.ai/stt/v1/transcribe:streamBidirectional";
pub const DEFAULT_MODEL: &str = "inworld/inworld-stt-1";
pub const DEFAULT_LANGUAGE: &str = "en-US";

/// How long to wait after `endTurn` for the final transcript (matches the
/// app: measured end-of-turn latency ~1.7s plus headroom).
pub const DRAIN_TIMEOUT: Duration = Duration::from_millis(2_500);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeConfig {
    pub model_id: String,
    pub audio_encoding: String,
    pub sample_rate_hertz: u32,
    pub language: String,
    /// Custom vocabulary: a soft bias towards terms the script uses.
    ///
    /// Omitted entirely when empty rather than sent as `[]`, so a run without
    /// vocabulary produces byte-for-byte the config frame this client has
    /// always sent — which is what makes an A/B against a captured baseline a
    /// comparison of one variable.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub prompts: Vec<String>,
}

impl Default for TranscribeConfig {
    fn default() -> Self {
        Self {
            model_id: DEFAULT_MODEL.to_string(),
            audio_encoding: "LINEAR16".to_string(),
            sample_rate_hertz: SAMPLE_RATE_HZ,
            language: DEFAULT_LANGUAGE.to_string(),
            prompts: Vec::new(),
        }
    }
}

/// Stream `pcm` (raw 24 kHz mono PCM16, no WAV header) through the live
/// service in `frame_ms` chunks at `pace × real-time`, forwarding every
/// transcript frame to `events`.
///
/// `pace = 1.0` reproduces the app's cadence exactly (100 ms frames, one per
/// 100 ms of wall time). Values > 1.0 stream faster than real time; latency
/// measurements are only meaningful at 1.0.
pub async fn stream_pcm(
    key: &str,
    config: &TranscribeConfig,
    pcm: &[u8],
    frame_ms: u64,
    pace: f64,
    events: mpsc::UnboundedSender<SttFrame>,
) -> Result<(), String> {
    let mut request = STREAM_URL
        .into_client_request()
        .map_err(|e| e.to_string())?;
    let mut header = HeaderValue::from_str(&format!("Basic {key}"))
        .map_err(|_| "key not header-safe".to_string())?;
    header.set_sensitive(true);
    request.headers_mut().insert(AUTHORIZATION, header);

    let (socket, _resp) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| e.to_string())?;
    let (mut sink, mut source) = socket.split();

    // Config frame must lead.
    let opening = serde_json::json!({ "transcribeConfig": config });
    sink.send(Message::Text(opening.to_string().into()))
        .await
        .map_err(|e| e.to_string())?;

    let started = std::time::Instant::now();

    // Reader task: parse the result envelope, mint item ids.
    let reader_events = events.clone();
    let bytes_per_ms = (SAMPLE_RATE_HZ as f64 * 2.0) / 1000.0;
    let sent_bytes = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let reader_sent = sent_bytes.clone();
    let reader = tokio::spawn(async move {
        let mut ordinal: u64 = 0;
        let mut open: Option<String> = None;
        while let Some(message) = source.next().await {
            let text = match message {
                Ok(Message::Text(t)) => t.to_string(),
                Ok(Message::Binary(b)) => match String::from_utf8(b.to_vec()) {
                    Ok(t) => t,
                    Err(_) => continue,
                },
                Ok(Message::Close(_)) => break,
                Ok(_) => continue,
                Err(e) => {
                    let _ = reader_events.send(SttFrame::Error {
                        message: e.to_string(),
                    });
                    break;
                }
            };
            let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) else {
                continue;
            };
            // Errors arrive FLAT, not inside `result`.
            if let Some(error) = parsed.get("error") {
                let message = error
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("provider error")
                    .to_string();
                let _ = reader_events.send(SttFrame::Error { message });
                break;
            }
            let Some(result) = parsed.get("result") else {
                continue;
            };
            let audio_ms =
                reader_sent.load(std::sync::atomic::Ordering::Relaxed) as f64 / bytes_per_ms;
            let wall_ms = started.elapsed().as_secs_f64() * 1000.0;
            if result.get("speechStarted").is_some() && open.is_none() {
                let id = format!("1-{ordinal}");
                ordinal += 1;
                open = Some(id.clone());
                let _ = reader_events.send(SttFrame::ItemStarted {
                    item_id: id,
                    ordinal: ordinal - 1,
                    audio_start_ms: audio_ms,
                });
            }
            let Some(transcription) = result.get("transcription") else {
                continue;
            };
            let Some(transcript) = transcription.get("transcript").and_then(|v| v.as_str())
            else {
                continue;
            };
            let is_final = transcription
                .get("isFinal")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let item_id = match open.clone() {
                Some(id) => id,
                None => {
                    let id = format!("1-{ordinal}");
                    ordinal += 1;
                    open = Some(id.clone());
                    let _ = reader_events.send(SttFrame::ItemStarted {
                        item_id: id.clone(),
                        ordinal: ordinal - 1,
                        audio_start_ms: audio_ms,
                    });
                    id
                }
            };
            if is_final {
                let _ = reader_events.send(SttFrame::Final {
                    item_id,
                    text: transcript.to_string(),
                    audio_end_ms: audio_ms,
                    wall_ms,
                    // The hosted service never reported per-word timing, which
                    // is the honest reason `bench/runs/` has none.
                    word_times: None,
                });
                open = None;
            } else {
                let _ = reader_events.send(SttFrame::Partial {
                    item_id,
                    text: transcript.to_string(),
                    audio_ms,
                    wall_ms,
                    word_times: None,
                });
            }
        }
        let _ = reader_events.send(SttFrame::Closed {});
    });

    // Writer: paced frames, same 100 ms cadence as the app's capture loop.
    let frame_bytes = (SAMPLE_RATE_HZ as u64 * 2 * frame_ms / 1000) as usize;
    let mut offset = 0usize;
    let frame_interval = Duration::from_secs_f64(frame_ms as f64 / 1000.0 / pace);
    let mut ticker = tokio::time::interval(frame_interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // Inworld rejects chunks shorter than 20 ms ("invalid audio chunk
    // duration"); a trailing runt gets padded with silence to the minimum.
    let min_chunk_bytes = (SAMPLE_RATE_HZ as usize * 2 * 20 / 1000) & !1;
    let mut padded_tail: Vec<u8>;
    while offset < pcm.len() {
        ticker.tick().await;
        let end = (offset + frame_bytes).min(pcm.len());
        let mut chunk = &pcm[offset..end];
        if chunk.len() < min_chunk_bytes {
            padded_tail = chunk.to_vec();
            padded_tail.resize(min_chunk_bytes, 0);
            chunk = &padded_tail;
        }
        let frame = serde_json::json!({
            "audioChunk": { "content": encode_base64(chunk) }
        });
        sink.send(Message::Text(frame.to_string().into()))
            .await
            .map_err(|e| e.to_string())?;
        sent_bytes.fetch_add(chunk.len() as u64, std::sync::atomic::Ordering::Relaxed);
        offset = end;
    }

    // Ask for the last final, then wait out the drain.
    let _ = sink.send(Message::Text(r#"{"endTurn":{}}"#.into())).await;
    let _ = tokio::time::timeout(DRAIN_TIMEOUT, reader).await;
    let _ = sink.close().await;
    Ok(())
}

pub fn encode_base64(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_serialises_with_the_wire_names_the_service_expects() {
        let json = serde_json::to_value(TranscribeConfig::default()).unwrap();
        assert_eq!(json["modelId"], DEFAULT_MODEL);
        assert_eq!(json["audioEncoding"], "LINEAR16");
        assert_eq!(json["sampleRateHertz"], SAMPLE_RATE_HZ);
        assert_eq!(json["language"], DEFAULT_LANGUAGE);
        assert!(json.get("prompts").is_none(), "empty vocabulary must not be sent");
    }

    #[test]
    fn vocabulary_serialises_as_the_prompts_array() {
        let config = TranscribeConfig {
            prompts: vec!["RustLight".into(), "twenty-seven".into()],
            ..TranscribeConfig::default()
        };
        let json = serde_json::to_value(config).unwrap();
        assert_eq!(json["prompts"][0], "RustLight");
        assert_eq!(json["prompts"][1], "twenty-seven");
    }
}
