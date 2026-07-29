//! Tauri-free Grok (xAI) streaming STT client.
//!
//! Speaks the exact wire protocol of `src-tauri/src/stt/stream.rs`, with the
//! Tauri event plumbing replaced by an mpsc channel so the benchmark harness
//! can drive real audio through the real service from a plain binary:
//!
//! * `Authorization: Bearer <key>` header, and **all** session configuration
//!   as URL query parameters — there is no config frame;
//! * the server sends `{"type":"transcript.created"}` when its ASR backend is
//!   ready, and audio sent before that is discarded, so we wait for it;
//! * audio frames are **raw binary** WebSocket messages (no base64, no JSON
//!   envelope) — a third less bandwidth than the provider this replaced;
//! * `{"type":"Finalize"}` forces the open utterance to finalize immediately
//!   and `{"type":"audio.done"}` ends the stream; the server then answers
//!   `transcript.done` and closes;
//! * inbound transcripts are `{"type":"transcript.partial", …}` at the top
//!   level — there is no `result` envelope — and errors arrive as
//!   `{"type":"error","message":…}` with no status code.
//!
//! ---------------------------------------------------------------------------
//! THE THREE FINALITY TIERS, AND THE ONE AMBIGUITY
//! ---------------------------------------------------------------------------
//! Grok reports finality on two flags rather than one:
//!
//! | `is_final` | `speech_final` | meaning                                    |
//! |------------|----------------|--------------------------------------------|
//! | false      | false          | interim, revised freely (~500 ms cadence)  |
//! | true       | false          | **chunk final** — ~3 s of speech locked    |
//! | true       | true           | **utterance final** — the speaker stopped  |
//!
//! The docs do not say whether the text after a chunk-final continues from the
//! locked text or starts fresh, and they describe the utterance-final as a
//! "complete stitched utterance" — which, if taken literally, means appending
//! the chunk-finals AND the utterance-final duplicates every word.
//!
//! Rather than guess, [`Utterance::finish`] settles it deterministically: if
//! the utterance-final already carries the locked prefix it is used alone,
//! otherwise the locked text is prepended. That is correct under **both**
//! readings, costs one string comparison per utterance, and cannot silently
//! rot if the service changes its mind.
//!
//! An item is one UTTERANCE, closed on `speech_final` — deliberately the same
//! granularity the ledger downstream already assumes. Chunk-finals do not open
//! new items; they make the open item's text stop being revisable, which is
//! the actual win over a provider that only firms up at the end of a sentence.
//!
//! ---------------------------------------------------------------------------
//! THE AUDIO CLOCK
//! ---------------------------------------------------------------------------
//! Unchanged from the provider this replaced: the clock is the count of PCM
//! bytes handed to the socket, which at a pinned sample rate and width is a
//! duration. Grok *does* supply word-level `start`/`end` times, which is
//! better raw material — but adopting them is a change to the engine's timing
//! model and belongs to its own measured experiment, not to a provider swap.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::{HeaderValue, AUTHORIZATION};
use tokio_tungstenite::tungstenite::Message;

pub const STREAM_URL: &str = "wss://api.x.ai/v1/stt";
/// One-shot transcription of a complete clip. Used only to validate a key.
pub const SYNC_URL: &str = "https://api.x.ai/v1/stt";
pub const DEFAULT_LANGUAGE: &str = "en";
pub const SAMPLE_RATE_HZ: u32 = 24_000;

/// How long to wait after `Finalize`/`audio.done` for the last transcript.
///
/// `Finalize` finalizes immediately rather than waiting out an endpointing
/// window, so this is far shorter than the 2.5 s the previous provider needed
/// — but it still has to cover a round-trip plus `transcript.done`.
pub const DRAIN_TIMEOUT: Duration = Duration::from_millis(1_500);

/// Grok caps custom vocabulary at 100 terms of 50 characters.
///
/// Enforced here rather than at the call site because exceeding it is a
/// connect-time rejection, not a degraded take: the terms ride on the URL that
/// opens the socket, so a 101st term does not bias a session — it prevents one.
pub const MAX_KEYTERMS: usize = 100;
pub const MAX_KEYTERM_CHARS: usize = 50;

/// Session configuration. Every field becomes a URL query parameter.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SttConfig {
    pub sample_rate_hz: u32,
    /// Primary language subtag (`en`), not BCP-47 (`en-US`) — Grok rejects the
    /// regional form. [`primary_subtag`] does the narrowing.
    pub language: String,
    pub interim_results: bool,
    /// Silence (ms) before an utterance is called final. The default of 10 ms
    /// is far too eager for a presenter who pauses for emphasis mid-sentence.
    pub endpointing_ms: u32,
    pub vad_threshold: f64,
    /// End-of-turn confidence threshold. `None` leaves Smart Turn off.
    pub smart_turn: Option<f64>,
    /// Custom vocabulary — a soft bias towards terms the script uses.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keyterms: Vec<String>,
}

impl Default for SttConfig {
    fn default() -> Self {
        Self {
            sample_rate_hz: SAMPLE_RATE_HZ,
            language: DEFAULT_LANGUAGE.to_string(),
            interim_results: true,
            /*
             * 300 ms rather than the service default of 10 ms.
             *
             * At 10 ms every breath ends an utterance, which floods the ledger
             * with fragments and — because an item only closes once — throws
             * away the accumulated context that makes a long sentence track.
             * 300 ms is comfortably longer than an inter-word gap in read
             * delivery and comfortably shorter than a deliberate beat.
             */
            endpointing_ms: 300,
            vad_threshold: 0.08,
            smart_turn: None,
            keyterms: Vec::new(),
        }
    }
}

impl SttConfig {
    /// The full `wss://` URL for this configuration.
    ///
    /// Percent-encoding is done by hand for the fields that can contain
    /// anything — a key term is drawn from a script and may hold spaces,
    /// ampersands or non-ASCII, any of which would otherwise truncate the URL
    /// and silently change the session's configuration.
    pub fn stream_url(&self) -> String {
        let mut url = format!(
            "{STREAM_URL}?sample_rate={}&encoding=pcm&interim_results={}&endpointing={}&vad_threshold={}",
            self.sample_rate_hz, self.interim_results, self.endpointing_ms, self.vad_threshold
        );
        if !self.language.is_empty() {
            url.push_str(&format!("&language={}", encode_query(&self.language)));
        }
        if let Some(threshold) = self.smart_turn {
            url.push_str(&format!("&smart_turn={threshold}"));
        }
        for term in self.sanitised_keyterms() {
            url.push_str(&format!("&keyterm={}", encode_query(&term)));
        }
        url
    }

    /// The vocabulary actually sent: trimmed, deduplicated, over-long terms
    /// dropped, and capped at the provider's limit.
    pub fn sanitised_keyterms(&self) -> Vec<String> {
        let mut seen = std::collections::HashSet::new();
        self.keyterms
            .iter()
            .map(|term| term.trim())
            .filter(|term| !term.is_empty() && term.chars().count() <= MAX_KEYTERM_CHARS)
            .filter(|term| seen.insert(term.to_lowercase()))
            .take(MAX_KEYTERMS)
            .map(str::to_string)
            .collect()
    }
}

/// Narrow a BCP-47 tag to the primary subtag Grok wants (`en-US` → `en`).
pub fn primary_subtag(language: &str) -> String {
    language
        .split(['-', '_'])
        .next()
        .unwrap_or("")
        .to_lowercase()
}

fn encode_query(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Same shape the app's renderer receives, plus the audio clock at the moment
/// the frame was observed — which is what the alignment benchmark needs.
///
/// Deliberately UNCHANGED across the provider swap: the frozen replay fixtures
/// in `bench/runs/` deserialize into this enum, and a benchmark whose event
/// model moved with the provider could not compare the two.
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
        /// Audio-clock (bytes-sent) milliseconds when this partial arrived.
        audio_ms: f64,
        /// Wall-clock ms since session start when this partial arrived —
        /// captures provider latency for lag analysis.
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

/// Text assembled across the finality tiers of one utterance.
#[derive(Default)]
pub struct Utterance {
    /// Text from chunk-finals so far. Never revised.
    locked: String,
}

impl Utterance {
    /// The text to report for an interim or chunk-final carrying `text`.
    pub fn extend(&mut self, text: &str, is_chunk_final: bool) -> String {
        let combined = join(&self.locked, text);
        if is_chunk_final {
            self.locked = combined.clone();
        }
        combined
    }

    /// The text to report for the utterance-final carrying `text`.
    ///
    /// The final REPLACES everything locked so far — it is the service's own
    /// complete stitched utterance, and it is authoritative.
    ///
    /// This was originally written to append the locked chunks unless the final
    /// already contained them, on the theory that the docs left it ambiguous.
    /// A live 18-run capture settled it, and settled it against that design:
    /// the final is not a concatenation of the chunk texts, it is a RE-DECODE
    /// of the same audio, and it routinely disagrees with the chunks about
    /// wording. One run had chunks reading "You Should Not Have To" against a
    /// final reading "you shouldn't have to". A prefix test on words therefore
    /// cannot recognise the repeat, the append branch fired, and every
    /// utterance came back doubled — 1.32× the spoken text, and a WER of 44 %
    /// against the previous provider's 7 %.
    ///
    /// The locked text is still worth accumulating: it is what makes each
    /// PARTIAL a full restatement of the utterance so far, which is the
    /// property `cc-align`'s ledger is built on. It just has no say once the
    /// final arrives.
    pub fn finish(&mut self, text: &str) -> String {
        self.locked.clear();
        text.trim().to_string()
    }
}

fn join(left: &str, right: &str) -> String {
    let (left, right) = (left.trim(), right.trim());
    if left.is_empty() {
        return right.to_string();
    }
    if right.is_empty() {
        return left.to_string();
    }
    format!("{left} {right}")
}

/// Why a connection could not be established, and whether retrying could help.
#[derive(Debug)]
pub struct ConnectError {
    pub message: String,
    /// False means retrying is pointless — a bad key or an unfunded team.
    pub recoverable: bool,
    pub status: Option<u16>,
}

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Open the socket, distinguishing a refusal from a network problem.
///
/// The refusal arrives as an HTTP status on the **upgrade**, not as a
/// WebSocket error frame, so it is only visible here. A live 403 reads
/// `{"code":"The caller does not have permission…","error":"Your newly created
/// team doesn't have any credits or licenses yet…"}` — a funding problem that
/// no amount of reconnecting fixes, and which must not be reported as a
/// network blip.
pub async fn connect(key: &str, config: &SttConfig) -> Result<Socket, ConnectError> {
    let mut request = config
        .stream_url()
        .into_client_request()
        .map_err(|err| ConnectError {
            message: err.to_string(),
            recoverable: false,
            status: None,
        })?;
    let mut header =
        HeaderValue::from_str(&format!("Bearer {key}")).map_err(|_| ConnectError {
            message: "The stored xAI key contains characters that cannot be sent as a header."
                .into(),
            recoverable: false,
            status: None,
        })?;
    header.set_sensitive(true);
    request.headers_mut().insert(AUTHORIZATION, header);

    match tokio_tungstenite::connect_async(request).await {
        Ok((socket, _response)) => Ok(socket),
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            let status = response.status().as_u16();
            let body = response
                .body()
                .as_ref()
                .and_then(|bytes| String::from_utf8(bytes.clone()).ok())
                .unwrap_or_default();
            Err(ConnectError {
                message: provider_message(&body)
                    .unwrap_or_else(|| format!("xAI refused the connection (HTTP {status})")),
                // 401/403 are a key or a funding problem; 429 is a rate limit
                // that a backoff genuinely can ride out.
                recoverable: !matches!(status, 400 | 401 | 403 | 404),
                status: Some(status),
            })
        }
        Err(err) => Err(ConnectError {
            message: err.to_string(),
            recoverable: true,
            status: None,
        }),
    }
}

/// Pull the human-readable half out of an xAI error body.
///
/// The shape seen live is `{"code": <sentence>, "error": <sentence>}`, where
/// `error` is the one that says what to do about it.
pub fn provider_message(body: &str) -> Option<String> {
    let parsed = serde_json::from_str::<serde_json::Value>(body).ok()?;
    for key in ["error", "message", "code"] {
        if let Some(text) = parsed.get(key).and_then(|v| v.as_str()) {
            if !text.trim().is_empty() {
                return Some(text.trim().to_string());
            }
        }
    }
    parsed
        .pointer("/error/message")
        .and_then(|v| v.as_str())
        .map(str::to_string)
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
    config: &SttConfig,
    pcm: &[u8],
    frame_ms: u64,
    pace: f64,
    events: mpsc::UnboundedSender<SttFrame>,
) -> Result<(), String> {
    let socket = connect(key, config).await.map_err(|err| err.message)?;
    let (mut sink, mut source) = socket.split();

    let started = std::time::Instant::now();
    let bytes_per_ms = (config.sample_rate_hz as f64 * 2.0) / 1000.0;
    let sent_bytes = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));

    // `transcript.created` means the ASR backend is up. Audio sent before it is
    // discarded, so the writer waits on this rather than on a sleep.
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<()>();

    let reader_events = events.clone();
    let reader_sent = sent_bytes.clone();
    let reader = tokio::spawn(async move {
        let mut ordinal: u64 = 0;
        let mut open: Option<String> = None;
        let mut utterance = Utterance::default();
        let mut ready = Some(ready_tx);

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

            match parsed.get("type").and_then(|v| v.as_str()) {
                Some("transcript.created") => {
                    if let Some(tx) = ready.take() {
                        let _ = tx.send(());
                    }
                    continue;
                }
                Some("error") => {
                    let message = parsed
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("xAI reported an error")
                        .to_string();
                    let _ = reader_events.send(SttFrame::Error { message });
                    break;
                }
                // The post-`audio.done` summary. Everything it carries has
                // already been reported by the utterance-finals.
                Some("transcript.done") => break,
                Some("transcript.partial") => {}
                _ => continue,
            }

            let Some(body) = parsed.get("text").and_then(|v| v.as_str()) else {
                continue;
            };
            if body.trim().is_empty() {
                continue;
            }
            let is_final = parsed
                .get("is_final")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let speech_final = parsed
                .get("speech_final")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            let audio_ms =
                reader_sent.load(std::sync::atomic::Ordering::Relaxed) as f64 / bytes_per_ms;
            let wall_ms = started.elapsed().as_secs_f64() * 1000.0;

            // Grok has no speech-start event, so an item opens at the first
            // frame that carries words — the earliest evidence there is.
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

            if speech_final {
                let _ = reader_events.send(SttFrame::Final {
                    item_id,
                    text: utterance.finish(body),
                    audio_end_ms: audio_ms,
                    wall_ms,
                });
                open = None;
            } else {
                let _ = reader_events.send(SttFrame::Partial {
                    item_id,
                    text: utterance.extend(body, is_final),
                    audio_ms,
                    wall_ms,
                });
            }
        }
        let _ = reader_events.send(SttFrame::Closed {});
    });

    // Wait for the backend, but never forever — a server that accepts the
    // upgrade and then says nothing must fail as a stream, not hang a harness.
    let _ = tokio::time::timeout(Duration::from_secs(10), ready_rx).await;

    // Writer: paced frames, same 100 ms cadence as the app's capture loop.
    let frame_bytes = (config.sample_rate_hz as u64 * 2 * frame_ms / 1000) as usize;
    let mut offset = 0usize;
    let frame_interval = Duration::from_secs_f64(frame_ms as f64 / 1000.0 / pace);
    let mut ticker = tokio::time::interval(frame_interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    while offset < pcm.len() {
        ticker.tick().await;
        let end = (offset + frame_bytes).min(pcm.len());
        // Raw binary — no base64, no JSON envelope.
        sink.send(Message::Binary(pcm[offset..end].to_vec().into()))
            .await
            .map_err(|e| e.to_string())?;
        sent_bytes.fetch_add((end - offset) as u64, std::sync::atomic::Ordering::Relaxed);
        offset = end;
    }

    // Force the last utterance, then end the stream and wait out the drain.
    // Server VAD would get there on its own given trailing silence, but a file
    // that has just run out supplies none.
    let _ = sink
        .send(Message::Text(r#"{"type":"Finalize"}"#.into()))
        .await;
    let _ = sink
        .send(Message::Text(r#"{"type":"audio.done"}"#.into()))
        .await;
    let _ = tokio::time::timeout(DRAIN_TIMEOUT, reader).await;
    let _ = sink.close().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_url_carries_every_configured_field() {
        let url = SttConfig::default().stream_url();
        assert!(url.starts_with("wss://api.x.ai/v1/stt?"));
        assert!(url.contains("sample_rate=24000"));
        assert!(url.contains("encoding=pcm"));
        assert!(url.contains("interim_results=true"));
        assert!(url.contains("endpointing=300"));
        assert!(url.contains("language=en"));
        assert!(!url.contains("keyterm="), "empty vocabulary must not be sent");
        assert!(!url.contains("smart_turn="), "smart turn is opt-in");
    }

    #[test]
    fn key_terms_are_percent_encoded_so_they_cannot_truncate_the_url() {
        let config = SttConfig {
            keyterms: vec!["RustLight Games".into(), "A&B".into()],
            ..SttConfig::default()
        };
        let url = config.stream_url();
        assert!(url.contains("keyterm=RustLight%20Games"));
        assert!(url.contains("keyterm=A%26B"));
    }

    #[test]
    fn key_terms_are_capped_deduplicated_and_length_filtered() {
        let config = SttConfig {
            keyterms: {
                let mut terms = vec![
                    "alpha".to_string(),
                    "ALPHA".to_string(), // duplicate, case-folded
                    "x".repeat(51),      // too long
                    String::new(),       // empty
                ];
                terms.extend((0..120).map(|i| format!("term{i}")));
                terms
            },
            ..SttConfig::default()
        };
        let sent = config.sanitised_keyterms();
        assert_eq!(sent.len(), MAX_KEYTERMS);
        assert_eq!(sent[0], "alpha");
        assert!(!sent.iter().any(|t| t.chars().count() > MAX_KEYTERM_CHARS));
        assert!(!sent.iter().any(|t| t.is_empty()));
    }

    #[test]
    fn bcp47_is_narrowed_to_the_primary_subtag() {
        assert_eq!(primary_subtag("en-US"), "en");
        assert_eq!(primary_subtag("en"), "en");
        assert_eq!(primary_subtag("pt-BR"), "pt");
    }

    /// The utterance-final replaces the locked chunks rather than extending
    /// them: it is the service's own complete stitched utterance.
    #[test]
    fn a_stitched_utterance_final_replaces_the_locked_chunks() {
        let mut utterance = Utterance::default();
        assert_eq!(utterance.extend("hello there", false), "hello there");
        assert_eq!(utterance.extend("hello there", true), "hello there");
        assert_eq!(
            utterance.finish("Hello there, my name is Greg."),
            "Hello there, my name is Greg."
        );
    }

    /// The regression that a live capture caught and no unit test predicted.
    ///
    /// The final is a RE-DECODE of the audio, not a join of the chunk texts,
    /// so it disagrees with them about wording — here "should not" against
    /// "shouldn't". An implementation that appends unless it recognises the
    /// chunks as a prefix cannot recognise this, appends, and doubles every
    /// utterance in the take. Measured: 1.32× the spoken text, 44 % WER.
    #[test]
    fn a_final_that_rewords_the_locked_chunks_still_replaces_them() {
        let mut utterance = Utterance::default();
        utterance.extend("It and Wait: You Should Not Have To", true);
        utterance.extend("Think about scrolling at all.", true);
        let finished = utterance.finish("And wait, you shouldn't have to think about scrolling at all.");
        assert_eq!(
            finished,
            "And wait, you shouldn't have to think about scrolling at all."
        );
        assert!(
            !finished.to_lowercase().contains("should not have to"),
            "the chunk wording must not survive alongside the final's: {finished}"
        );
    }

    /// A second utterance must not inherit the first one's locked text.
    #[test]
    fn finishing_clears_the_locked_text_for_the_next_utterance() {
        let mut utterance = Utterance::default();
        utterance.extend("the first utterance", true);
        utterance.finish("The first utterance.");
        assert_eq!(utterance.extend("the second", false), "the second");
    }

    #[test]
    fn chunk_finals_lock_text_that_later_interims_cannot_revise() {
        let mut utterance = Utterance::default();
        utterance.extend("the first part", true);
        assert_eq!(
            utterance.extend("and the rest", false),
            "the first part and the rest"
        );
        // An interim that revises itself does not disturb the locked prefix.
        assert_eq!(
            utterance.extend("and the rest of it", false),
            "the first part and the rest of it"
        );
    }

    #[test]
    fn frames_serialize_with_the_names_the_fixtures_and_renderer_use() {
        let started = serde_json::to_value(SttFrame::ItemStarted {
            item_id: "1-0".into(),
            ordinal: 0,
            audio_start_ms: 1_200.0,
        })
        .unwrap();
        assert_eq!(started["kind"], "itemStarted");
        assert_eq!(started["itemId"], "1-0");
        assert_eq!(started["audioStartMs"], 1_200.0);
    }

    #[test]
    fn a_permission_failure_body_reports_the_actionable_half() {
        let body = r#"{"code":"The caller does not have permission to execute the specified operation","error":"Your newly created team doesn't have any credits or licenses yet."}"#;
        assert_eq!(
            provider_message(body).unwrap(),
            "Your newly created team doesn't have any credits or licenses yet."
        );
    }
}
