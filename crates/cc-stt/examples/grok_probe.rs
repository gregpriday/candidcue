//! Throwaway probe: dump the raw Grok STT wire protocol.
//!
//! The docs do not say whether transcript text accumulates across a chunk-final
//! (`is_final=true, speech_final=false`), and they describe the utterance-final
//! as a "complete stitched utterance" — which would mean appending chunk-finals
//! AND the utterance-final duplicates every word. That single question decides
//! the whole read loop, so we ask the live service instead of guessing.
//!
//! Usage: cargo run -p cc-stt --example grok_probe -- <wav> <seconds>

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::{HeaderValue, AUTHORIZATION};
use tokio_tungstenite::tungstenite::Message;

/// Locate the `data` chunk of a RIFF/WAVE file rather than assuming 44 bytes —
/// `say` and the TTS stitcher both emit extra chunks before it.
fn wav_payload(bytes: &[u8]) -> &[u8] {
    let mut at = 12; // past "RIFF" + size + "WAVE"
    while at + 8 <= bytes.len() {
        let id = &bytes[at..at + 4];
        let size = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().unwrap()) as usize;
        if id == b"data" {
            let end = (at + 8 + size).min(bytes.len());
            return &bytes[at + 8..end];
        }
        at += 8 + size + (size & 1);
    }
    &bytes[44.min(bytes.len())..]
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = rustls::crypto::ring::default_provider().install_default();

    let mut args = std::env::args().skip(1);
    let path = args.next().expect("usage: grok_probe <wav> <seconds>");
    let seconds: f64 = args.next().unwrap_or_else(|| "25".into()).parse()?;

    let key = std::env::var("GROK_API_KEY").expect("GROK_API_KEY not set");
    let raw = std::fs::read(&path)?;
    let pcm = wav_payload(&raw);
    let want = (24_000.0 * 2.0 * seconds) as usize;
    let pcm = &pcm[..want.min(pcm.len())];
    eprintln!(
        "[probe] {} → {} bytes ({:.1}s of 24kHz mono PCM16)",
        path,
        pcm.len(),
        pcm.len() as f64 / 48_000.0
    );

    let url = "wss://api.x.ai/v1/stt\
               ?sample_rate=24000&encoding=pcm&interim_results=true&language=en";
    let mut request = url.into_client_request()?;
    let mut header = HeaderValue::from_str(&format!("Bearer {key}"))?;
    header.set_sensitive(true);
    request.headers_mut().insert(AUTHORIZATION, header);

    let (socket, response) = tokio_tungstenite::connect_async(request).await?;
    eprintln!("[probe] upgraded: HTTP {}", response.status());
    let (mut sink, mut source) = socket.split();

    let started = std::time::Instant::now();
    let sent = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));

    // Reader: print every inbound frame verbatim, stamped with wall time and
    // the bytes-sent audio clock, so lag and accumulation are both readable.
    let reader_sent = sent.clone();
    let reader = tokio::spawn(async move {
        while let Some(message) = source.next().await {
            let wall = started.elapsed().as_secs_f64() * 1000.0;
            let audio = reader_sent.load(std::sync::atomic::Ordering::Relaxed) as f64 / 48.0;
            match message {
                Ok(Message::Text(text)) => {
                    println!("[{wall:8.0}ms wall | {audio:8.0}ms audio] {text}");
                }
                Ok(Message::Close(frame)) => {
                    println!("[{wall:8.0}ms] CLOSE {frame:?}");
                    break;
                }
                Ok(_) => {}
                Err(err) => {
                    println!("[{wall:8.0}ms] ERR {err}");
                    break;
                }
            }
        }
    });

    // The docs say to await `transcript.created` before sending audio; give the
    // backend a moment rather than racing it.
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;

    // 100 ms frames at real-time pace — the app's exact capture cadence.
    let frame_bytes = 24_000 * 2 * 100 / 1000;
    let mut ticker = tokio::time::interval(std::time::Duration::from_millis(100));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut offset = 0usize;
    while offset < pcm.len() {
        ticker.tick().await;
        let end = (offset + frame_bytes).min(pcm.len());
        sink.send(Message::Binary(pcm[offset..end].to_vec().into()))
            .await?;
        sent.fetch_add((end - offset) as u64, std::sync::atomic::Ordering::Relaxed);
        offset = end;
    }
    eprintln!("[probe] audio sent, finalizing");

    sink.send(Message::Text(r#"{"type":"Finalize"}"#.into()))
        .await?;
    sink.send(Message::Text(r#"{"type":"audio.done"}"#.into()))
        .await?;

    let _ = tokio::time::timeout(std::time::Duration::from_secs(8), reader).await;
    let _ = sink.close().await;
    eprintln!("[probe] done");
    Ok(())
}
