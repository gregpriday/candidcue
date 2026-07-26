//! One live Inworld transcription session, supervised across reconnects.
//!
//! The renderer never sees this socket. It calls `stt_start`, pushes PCM16
//! frames with `stt_audio`, and receives [`SttFrame`] events on `stt://event`;
//! everything between — the `Authorization` header, the config handshake, the
//! `result` envelope, dropped connections and the backoff — is this file's
//! problem.
//!
//! ---------------------------------------------------------------------------
//! UTTERANCE IDENTITY
//! ---------------------------------------------------------------------------
//! Inworld does not name its utterances: it sends interim transcripts and then
//! one with `isFinal`, and the next interim after that belongs to a new
//! utterance. The transcript ledger downstream is keyed by item id, so the ids
//! are minted here — `"{generation}-{ordinal}"` — and an item opens at the
//! first frame that mentions it and closes on its final. Minting them at the
//! only place that can observe the boundary is what stops two lanes inventing
//! two different schemes for the same utterance.
//!
//! ---------------------------------------------------------------------------
//! THE AUDIO CLOCK
//! ---------------------------------------------------------------------------
//! Alignment needs to know *when* words were spoken, and there is no timestamp
//! on the wire we can trust for that. What we do know exactly is how many bytes
//! of audio have been handed to the socket, which at a pinned sample rate and
//! width is a duration. So the clock is the byte count: monotonic, immune to
//! event-loop jitter, and it does not advance while the microphone is closed.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tauri::Emitter;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::{HeaderValue, AUTHORIZATION};
use tokio_tungstenite::tungstenite::Message;

use crate::errors::AppError;
use crate::secrets::SecretString;
use crate::windows::CONTROL_LABEL;

use super::{encode_base64, TranscribeConfig, SAMPLE_RATE_HZ, STREAM_URL};

/// The event channel the renderer listens on.
pub const STT_EVENT: &str = "stt://event";

/// How long to keep the socket open after `endTurn`, waiting for the final
/// transcript of the last utterance.
///
/// End-of-turn latency measured against the live service is ~1.7 s and did not
/// respond to any config we could find, so this is that plus headroom. Closing
/// sooner strands the last sentence of a take — which is exactly the sentence
/// somebody just finished saying when they pressed stop.
const DRAIN_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(2_500);

/// Reconnect backoff. Five attempts over ~8 s; past that the take is not going
/// to recover on its own and the presenter needs to be told rather than watched
/// over by a retry loop that never gives up.
const BACKOFF_MS: [u64; 5] = [250, 500, 1_000, 2_000, 4_000];

/// How many audio frames may queue while a reconnect is in flight.
///
/// 100 ms per frame, so this is ~5 s of speech. Beyond that the audio is stale
/// enough that transcribing it would put the cursor in the past; frames are
/// dropped and the drop is reported rather than silently swallowed.
const AUDIO_QUEUE_FRAMES: usize = 50;

/// What the renderer receives. Deliberately closer to the wire than to the
/// tracking engine's event model — the mapping to `TranscriptEvent` happens in
/// TypeScript, where the receive timestamps come from the same clock the ledger
/// already uses.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SttFrame {
    #[serde(rename_all = "camelCase")]
    ItemStarted {
        generation: u64,
        item_id: String,
        ordinal: u64,
        audio_start_ms: f64,
    },
    #[serde(rename_all = "camelCase")]
    Partial {
        generation: u64,
        item_id: String,
        text: String,
    },
    #[serde(rename_all = "camelCase")]
    Final {
        generation: u64,
        item_id: String,
        text: String,
        audio_end_ms: f64,
    },
    /// `connecting` | `connected` | `degraded` | `closed`
    #[serde(rename_all = "camelCase")]
    Transport {
        generation: u64,
        state: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Failed {
        generation: u64,
        code: String,
        message: String,
        /// False means retrying is pointless — a bad key, not a bad network.
        recoverable: bool,
    },
    /// Audio the session could not forward, so "words heard: 0" is never a
    /// mystery. Reported once per contiguous run of drops.
    #[serde(rename_all = "camelCase")]
    AudioDropped { generation: u64, frames: u64 },
}

enum Outbound {
    Audio(Vec<u8>),
    /// Finish the current utterance and close.
    Stop,
}

/// Handle to a running session. Dropping it does not stop the session — call
/// [`SessionHandle::stop`] or [`SessionHandle::abandon`], both of which are
/// explicit about whether the last utterance is worth waiting for.
pub struct SessionHandle {
    pub generation: u64,
    tx: mpsc::Sender<Outbound>,
    audio_ms: Arc<AtomicU64>,
    /// Frames `push_audio` could not queue, awaiting a report by the supervisor.
    dropped: Arc<AtomicU64>,
}

impl SessionHandle {
    pub fn spawn<R: tauri::Runtime>(
        app: tauri::AppHandle<R>,
        generation: u64,
        key: SecretString,
        config: TranscribeConfig,
    ) -> Self {
        let (tx, rx) = mpsc::channel(AUDIO_QUEUE_FRAMES);
        let audio_ms = Arc::new(AtomicU64::new(0));
        let dropped = Arc::new(AtomicU64::new(0));
        let handle = Self {
            generation,
            tx,
            audio_ms: Arc::clone(&audio_ms),
            dropped: Arc::clone(&dropped),
        };
        tauri::async_runtime::spawn(supervise(
            app, generation, key, config, rx, audio_ms, dropped,
        ));
        handle
    }

    /// Milliseconds of audio handed to the socket so far. This is the session
    /// clock the transcripts are timed against.
    pub fn audio_ms(&self) -> f64 {
        self.audio_ms.load(Ordering::Relaxed) as f64
    }

    /// Forward one frame of PCM16.
    ///
    /// `try_send` rather than `send`: this is called from an IPC command on the
    /// capture cadence, and blocking it would stall the renderer's capture loop
    /// to wait for a socket that is already in trouble. A full queue means the
    /// connection is down or wedged, and the frame is dropped.
    ///
    /// The drop is COUNTED here, which is the whole point. Audio discarded
    /// silently is indistinguishable downstream from a presenter who said
    /// nothing, and "words heard: 0" with no explanation is the failure this
    /// rewrite exists to make diagnosable. The supervisor drains this counter
    /// into an `AudioDropped` event.
    ///
    /// A closed channel is NOT counted: the session is over, and every frame
    /// after that is expected rather than lost.
    pub fn push_audio(&self, pcm: Vec<u8>) -> Result<(), AppError> {
        match self.tx.try_send(Outbound::Audio(pcm)) {
            Ok(()) => Ok(()),
            Err(mpsc::error::TrySendError::Full(_)) => {
                self.dropped.fetch_add(1, Ordering::Relaxed);
                Ok(())
            }
            Err(mpsc::error::TrySendError::Closed(_)) => Ok(()),
        }
    }

    /// Finish cleanly: `endTurn`, wait out [`DRAIN_TIMEOUT`] for the final
    /// transcript, then close.
    pub fn stop(self) {
        let tx = self.tx;
        tauri::async_runtime::spawn(async move {
            let _ = tx.send(Outbound::Stop).await;
        });
    }

    /// Drop the session without waiting for anything. Used when a *newer*
    /// session has already replaced this one, where the last utterance of the
    /// old take is of no interest to anybody.
    pub fn abandon(self) {
        drop(self.tx);
    }
}

/// Per-connection utterance bookkeeping, shared with the reader task.
struct Utterances {
    generation: u64,
    ordinal: AtomicU64,
    open: std::sync::Mutex<Option<String>>,
    audio_ms: Arc<AtomicU64>,
    /// Set once this connection has delivered a transcript of any kind.
    ///
    /// This is what "the connection worked" means, and it is the only thing
    /// that may forgive a retry: a socket that opens and then errors has not
    /// worked, however healthy its handshake looked.
    productive: std::sync::atomic::AtomicBool,
}

impl Utterances {
    /// The id of the utterance currently in progress, opening one if this is
    /// the first frame that refers to it.
    fn current<R: tauri::Runtime>(&self, app: &tauri::AppHandle<R>) -> String {
        let mut open = self.open.lock().expect("utterance state poisoned");
        if let Some(id) = open.as_ref() {
            return id.clone();
        }
        let ordinal = self.ordinal.fetch_add(1, Ordering::SeqCst);
        let id = format!("{}-{}", self.generation, ordinal);
        *open = Some(id.clone());
        let audio_ms = self.audio_ms.load(Ordering::Relaxed) as f64;
        emit_transcript(
            app,
            SttFrame::ItemStarted {
                generation: self.generation,
                item_id: id.clone(),
                ordinal,
                audio_start_ms: audio_ms,
            },
            audio_ms,
        );
        id
    }

    fn close(&self) {
        *self.open.lock().expect("utterance state poisoned") = None;
    }
}

fn emit<R: tauri::Runtime>(app: &tauri::AppHandle<R>, frame: SttFrame) {
    // A failed emit means the control window is gone, which is not something
    // this session can do anything about and not worth tearing down for.
    let _ = app.emit_to(CONTROL_LABEL, STT_EVENT, frame);
}

/// Emit a frame that carries speech, and feed the same frame to the aligner.
///
/// Only `ItemStarted` / `Partial` / `Final` come through here. That is a
/// structural guarantee rather than a convention: transport, failure and
/// audio-drop frames go through plain [`emit`] and therefore cannot reach the
/// engine, which is what §9 of the integration note requires — a reconnect
/// notice is not evidence about where the presenter is reading.
///
/// `audio_now_ms` is the bytes-sent audio clock read here, at arrival. The
/// engine's lag model was calibrated against that clock on live captures; a
/// wall clock would mis-time every prediction in a way nothing downstream can
/// detect.
fn emit_transcript<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    frame: SttFrame,
    audio_now_ms: f64,
) {
    crate::align::observe_frame(app, &frame, audio_now_ms);
    emit(app, frame);
}

/// Why a connection ended, which decides whether to reconnect.
enum ConnectionEnd {
    /// The socket dropped. Worth retrying.
    Dropped(Option<String>),
    /// The service refused us. Retrying would refuse us again.
    Fatal,
    /// We closed it on purpose.
    Finished,
}

#[allow(clippy::too_many_arguments)]
async fn supervise<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    generation: u64,
    key: SecretString,
    config: TranscribeConfig,
    mut rx: mpsc::Receiver<Outbound>,
    audio_ms: Arc<AtomicU64>,
    dropped: Arc<AtomicU64>,
) {
    let utterances = Arc::new(Utterances {
        generation,
        ordinal: AtomicU64::new(0),
        open: std::sync::Mutex::new(None),
        audio_ms: Arc::clone(&audio_ms),
        productive: std::sync::atomic::AtomicBool::new(false),
    });

    let mut attempt = 0usize;
    loop {
        emit(
            &app,
            SttFrame::Transport {
                generation,
                state: "connecting",
                detail: None,
            },
        );

        let socket = match connect(&key).await {
            Ok(socket) => socket,
            Err(reason) => {
                if attempt >= BACKOFF_MS.len() {
                    emit(
                        &app,
                        SttFrame::Failed {
                            generation,
                            code: "REALTIME_CONNECT_FAILED".into(),
                            message: reason,
                            recoverable: true,
                        },
                    );
                    break;
                }
                emit(
                    &app,
                    SttFrame::Transport {
                        generation,
                        state: "degraded",
                        detail: Some(reason),
                    },
                );
                tokio::time::sleep(std::time::Duration::from_millis(BACKOFF_MS[attempt])).await;
                attempt += 1;
                continue;
            }
        };

        match run_connection(
            &app,
            generation,
            &config,
            socket,
            &mut rx,
            &audio_ms,
            &dropped,
            &utterances,
        )
        .await
        {
            ConnectionEnd::Finished => break,
            ConnectionEnd::Fatal => break,
            ConnectionEnd::Dropped(detail) => {
                /*
                 * Counted against the SAME budget as an upgrade failure.
                 *
                 * `attempt` used to reset on every successful 101, so a
                 * provider that accepts the socket and then errors on the
                 * config frame — which is exactly what a revoked key or a bad
                 * model id does — produced an infinite 250 ms reconnect loop
                 * that billed for every attempt and transcribed nothing. The
                 * only connection worth resetting the budget for is one that
                 * actually delivered a transcript — otherwise a long, healthy
                 * take with five scattered network blips would exhaust the
                 * budget and give up for good.
                 */
                if utterances.productive.swap(false, Ordering::SeqCst) {
                    attempt = 0;
                }
                if attempt >= BACKOFF_MS.len() {
                    emit(
                        &app,
                        SttFrame::Failed {
                            generation,
                            code: "REALTIME_CONNECT_FAILED".into(),
                            message: detail.unwrap_or_else(|| {
                                "the transcription connection kept dropping".into()
                            }),
                            recoverable: true,
                        },
                    );
                    break;
                }
                // A dropped socket mid-utterance leaves an item open that will
                // never receive its final. Close it so the next transcript
                // opens a fresh one rather than appending to a sentence the
                // presenter finished saying before the reconnect.
                utterances.close();
                emit(
                    &app,
                    SttFrame::Transport {
                        generation,
                        state: "degraded",
                        detail: None,
                    },
                );
                tokio::time::sleep(std::time::Duration::from_millis(BACKOFF_MS[attempt])).await;
                attempt += 1;
            }
        }
    }

    // Any drops still outstanding are reported before the session goes quiet.
    // They are otherwise only flushed by the next successful send, so an outage
    // that ends in a stop or a fatal error would swallow the count — which is
    // exactly the run where the presenter most needs to know audio was lost.
    let lost = dropped.swap(0, Ordering::Relaxed);
    if lost > 0 {
        emit(&app, SttFrame::AudioDropped { generation, frames: lost });
    }

    emit(
        &app,
        SttFrame::Transport {
            generation,
            state: "closed",
            detail: None,
        },
    );
}

type Socket = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

/// Open the socket with the key in an `Authorization` header.
///
/// The header is the whole reason this code is in Rust; see the module docs.
/// The key is never interpolated into an error — `HeaderValue::from_str`
/// failures report the shape of the problem, not the value.
async fn connect(key: &SecretString) -> Result<Socket, String> {
    let mut request = STREAM_URL
        .into_client_request()
        .map_err(|err| err.to_string())?;
    let mut header = HeaderValue::from_str(&format!("Basic {}", key.expose()))
        .map_err(|_| "The stored Inworld key contains characters that cannot be sent as a header.".to_string())?;
    header.set_sensitive(true);
    request.headers_mut().insert(AUTHORIZATION, header);

    let (socket, _response) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|err| err.to_string())?;
    Ok(socket)
}

#[allow(clippy::too_many_arguments)]
async fn run_connection<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    generation: u64,
    config: &TranscribeConfig,
    socket: Socket,
    rx: &mut mpsc::Receiver<Outbound>,
    audio_ms: &Arc<AtomicU64>,
    dropped: &Arc<AtomicU64>,
    utterances: &Arc<Utterances>,
) -> ConnectionEnd {
    let (mut sink, source) = socket.split();

    // The config frame must lead; audio sent before it is discarded by the
    // service without complaint.
    let opening = serde_json::json!({ "transcribeConfig": config });
    if let Err(err) = sink.send(Message::Text(opening.to_string().into())).await {
        return ConnectionEnd::Dropped(Some(err.to_string()));
    }

    emit(
        app,
        SttFrame::Transport {
            generation,
            state: "connected",
            detail: None,
        },
    );

    let mut reader = tauri::async_runtime::spawn(read_loop(
        app.clone(),
        generation,
        source,
        Arc::clone(utterances),
    ));

    let mut draining_until: Option<tokio::time::Instant> = None;

    loop {
        // Once `endTurn` is sent we stop pulling from the queue entirely and
        // only wait for the final, so a renderer still pushing frames cannot
        // extend the drain indefinitely.
        let deadline = draining_until;
        tokio::select! {
            biased;

            outcome = &mut reader => {
                let end = outcome.unwrap_or(ConnectionEnd::Dropped(None));
                // A reader that ends during the drain has done its job.
                return if draining_until.is_some() && matches!(end, ConnectionEnd::Dropped(_)) {
                    ConnectionEnd::Finished
                } else {
                    end
                };
            }

            _ = async {
                match deadline {
                    Some(at) => tokio::time::sleep_until(at).await,
                    None => std::future::pending().await,
                }
            } => {
                reader.abort();
                let _ = sink.close().await;
                return ConnectionEnd::Finished;
            }

            outbound = rx.recv(), if draining_until.is_none() => {
                match outbound {
                    Some(Outbound::Audio(pcm)) => {
                        let frame = serde_json::json!({
                            "audioChunk": { "content": encode_base64(&pcm) }
                        });
                        if sink.send(Message::Text(frame.to_string().into())).await.is_err() {
                            reader.abort();
                            return ConnectionEnd::Dropped(Some("audio frame could not be sent".into()));
                        }
                        // Two bytes per sample, one channel.
                        let ms = (pcm.len() as u64 * 1_000) / (SAMPLE_RATE_HZ as u64 * 2);
                        audio_ms.fetch_add(ms, Ordering::Relaxed);
                        // Reported on the first frame that gets through after a
                        // run of drops, so one gap produces one event rather
                        // than one per lost frame.
                        let lost = dropped.swap(0, Ordering::Relaxed);
                        if lost > 0 {
                            emit(app, SttFrame::AudioDropped { generation, frames: lost });
                        }
                    }
                    Some(Outbound::Stop) => {
                        // Ask for the boundary explicitly. Server VAD would get
                        // there on its own given trailing silence, but a
                        // microphone that has just been closed supplies none.
                        let _ = sink.send(Message::Text(r#"{"endTurn":{}}"#.into())).await;
                        draining_until = Some(tokio::time::Instant::now() + DRAIN_TIMEOUT);
                    }
                    // Every sender dropped: the session was abandoned.
                    None => {
                        reader.abort();
                        let _ = sink.close().await;
                        return ConnectionEnd::Finished;
                    }
                }
            }
        }
    }
}

/// Read inbound frames and turn them into [`SttFrame`] events.
///
/// The envelope is the trap: every normal frame is wrapped in `result`, and
/// errors are **not** — they arrive flat as `{"error":{…}}`. Code reading
/// `result.error` finds nothing and reports silence instead of a bad key, which
/// is the failure mode that cost a day on the previous provider.
async fn read_loop<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    generation: u64,
    mut source: futures_util::stream::SplitStream<Socket>,
    utterances: Arc<Utterances>,
) -> ConnectionEnd {
    while let Some(message) = source.next().await {
        let text = match message {
            Ok(Message::Text(text)) => text.to_string(),
            Ok(Message::Binary(bytes)) => match String::from_utf8(bytes.to_vec()) {
                Ok(text) => text,
                Err(_) => continue,
            },
            Ok(Message::Close(frame)) => {
                return ConnectionEnd::Dropped(frame.map(|f| f.reason.to_string()));
            }
            Ok(_) => continue,
            Err(err) => return ConnectionEnd::Dropped(Some(err.to_string())),
        };

        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };

        if let Some(error) = parsed.get("error") {
            let message = error
                .get("message")
                .and_then(|value| value.as_str())
                .unwrap_or("Inworld reported an error")
                .to_string();
            /*
             * Retry only what retrying could possibly fix.
             *
             * These are gRPC status codes. `7` PERMISSION_DENIED is a bad or
             * deleted key; `3` INVALID_ARGUMENT is a config the service will
             * never accept, and `12` UNIMPLEMENTED likewise. Reconnecting with
             * the same key and the same config gets the same answer every time,
             * so retrying is not resilience — it is a billed loop that hides the
             * cause. Only `3` had to be learned the hard way: a settings
             * document written by the previous build still named that
             * provider's model, the take forwarded it, and the session
             * reconnected seven times in twelve seconds while reporting
             * "reconnecting — your position is held".
             */
            let status = error.get("code").and_then(|value| value.as_u64());
            let permanent = matches!(status, Some(3) | Some(7) | Some(12))
                || message.to_lowercase().contains("api key");
            let auth = status == Some(7) || message.to_lowercase().contains("api key");
            emit(
                &app,
                SttFrame::Failed {
                    generation,
                    code: if auth {
                        "AUTH_KEY_INVALID".into()
                    } else if permanent {
                        "REALTIME_CONFIG_REJECTED".into()
                    } else {
                        "REALTIME_PROVIDER_ERROR".into()
                    },
                    message,
                    recoverable: !permanent,
                },
            );
            return if permanent {
                ConnectionEnd::Fatal
            } else {
                ConnectionEnd::Dropped(None)
            };
        }

        let Some(result) = parsed.get("result") else {
            continue;
        };

        // Opens the utterance if this is its first frame, so a transcript is
        // never attributed to an item the ledger has not been told about.
        if result.get("speechStarted").is_some() {
            let _ = utterances.current(&app);
        }

        let Some(transcription) = result.get("transcription") else {
            continue;
        };
        let Some(transcript) = transcription.get("transcript").and_then(|v| v.as_str()) else {
            continue;
        };
        let is_final = transcription
            .get("isFinal")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);

        utterances
            .productive
            .store(true, Ordering::SeqCst);
        let item_id = utterances.current(&app);
        let audio_ms = utterances.audio_ms.load(Ordering::Relaxed) as f64;
        if is_final {
            emit_transcript(
                &app,
                SttFrame::Final {
                    generation,
                    item_id,
                    text: transcript.to_string(),
                    audio_end_ms: audio_ms,
                },
                audio_ms,
            );
            utterances.close();
        } else {
            emit_transcript(
                &app,
                SttFrame::Partial {
                    generation,
                    item_id,
                    text: transcript.to_string(),
                },
                audio_ms,
            );
        }
    }
    ConnectionEnd::Dropped(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The renderer's adapter switches on these exact strings; a variant rename
    /// would compile fine on both sides and silently stop producing transcripts.
    #[test]
    fn frames_serialize_with_the_names_the_renderer_matches_on() {
        let started = serde_json::to_value(SttFrame::ItemStarted {
            generation: 3,
            item_id: "3-0".into(),
            ordinal: 0,
            audio_start_ms: 1_200.0,
        })
        .unwrap();
        assert_eq!(started["kind"], "itemStarted");
        assert_eq!(started["itemId"], "3-0");
        assert_eq!(started["audioStartMs"], 1_200.0);

        let final_frame = serde_json::to_value(SttFrame::Final {
            generation: 3,
            item_id: "3-0".into(),
            text: "hello".into(),
            audio_end_ms: 2_400.0,
        })
        .unwrap();
        assert_eq!(final_frame["kind"], "final");
        assert_eq!(final_frame["audioEndMs"], 2_400.0);

        let transport = serde_json::to_value(SttFrame::Transport {
            generation: 3,
            state: "connected",
            detail: None,
        })
        .unwrap();
        assert_eq!(transport["kind"], "transport");
        assert_eq!(transport["state"], "connected");
        assert!(
            transport.get("detail").is_none(),
            "an absent detail must be omitted, not null"
        );
    }

    #[test]
    fn a_failed_frame_says_whether_retrying_could_possibly_help() {
        let fatal = serde_json::to_value(SttFrame::Failed {
            generation: 1,
            code: "AUTH_KEY_INVALID".into(),
            message: "API key does not exist".into(),
            recoverable: false,
        })
        .unwrap();
        assert_eq!(fatal["recoverable"], false);
    }
}
