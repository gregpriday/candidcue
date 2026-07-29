//! One live Grok transcription session, supervised across reconnects.
//!
//! The renderer never sees this socket. It calls `start_transcription`, pushes
//! PCM16 frames with `push_transcription_audio`, and receives [`SttFrame`]
//! events on `stt://event`; everything between — the `Authorization` header,
//! the readiness handshake, the finality tiers, dropped connections and the
//! backoff — is this file's problem.
//!
//! ---------------------------------------------------------------------------
//! UTTERANCE IDENTITY
//! ---------------------------------------------------------------------------
//! Grok does not name its utterances: it sends interim transcripts, then
//! chunk-finals, then one with `speech_final`, and the next frame after that
//! belongs to a new utterance. The transcript ledger downstream is keyed by
//! item id, so the ids are minted here — `"{generation}-{ordinal}"` — and an
//! item opens at the first frame that carries words and closes on
//! `speech_final`. Minting them at the only place that can observe the boundary
//! is what stops two lanes inventing two different schemes for the same
//! utterance.
//!
//! An item is one UTTERANCE, not one chunk. Chunk-finals do not open new items;
//! they make the open item's text stop being revisable, which is the actual win
//! over a provider that only firms up at the end of a sentence.
//!
//! ---------------------------------------------------------------------------
//! HOW AN UTTERANCE IS ASSEMBLED
//! ---------------------------------------------------------------------------
//! Interims carry only the CURRENT chunk, not the whole utterance, so
//! [`Utterances::extend`] prepends the chunk-finals already locked. That is
//! what makes every `Partial` a full restatement of the utterance so far —
//! the property `cc_align`'s ledger is built on, and one this provider does
//! not supply on its own.
//!
//! The utterance-final then REPLACES all of it. It is the service's own
//! complete stitched utterance and it is authoritative.
//!
//! This was first written the other way, appending the locked text unless the
//! final already appeared to contain it, because the documentation left the
//! question open. An 18-run live capture settled it: the final is a RE-DECODE
//! of the audio rather than a join of the chunk texts, and it routinely
//! disagrees with the chunks about wording — one run had chunks reading "You
//! Should Not Have To" against a final reading "you shouldn't have to". No
//! textual prefix test can recognise that as a repeat, so the append branch
//! fired and every utterance came back doubled: 1.32× the spoken text, and a
//! WER of 44 % where the previous provider measured 7 %. The lesson is the
//! shape of the evidence, not the arithmetic — a guard that cannot fail
//! loudly will fail quietly, and this one was only visible in a metric nobody
//! would have run without a benchmark.
//!
//! ---------------------------------------------------------------------------
//! THE AUDIO CLOCK
//! ---------------------------------------------------------------------------
//! Alignment needs to know *when* words were spoken. Grok does supply word-level
//! `start`/`end` times, but the engine's lag model was calibrated against the
//! bytes-sent clock on live captures, and swapping the timing model is a change
//! that has to be measured on its own rather than smuggled into a provider
//! swap. So the clock remains the byte count: monotonic, immune to event-loop
//! jitter, and it does not advance while the microphone is closed.

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

use super::{provider_message, SttConfig, SAMPLE_RATE_HZ};

/// The event channel the renderer listens on.
pub const STT_EVENT: &str = "stt://event";

/// How long to keep the socket open after `Finalize`, waiting for the final
/// transcript of the last utterance.
///
/// `Finalize` finalizes the open utterance immediately rather than waiting out
/// the endpointing window, so this only has to cover a round-trip plus the
/// `transcript.done` that follows `audio.done` — far less than the 2.5 s the
/// previous provider's end-of-turn latency forced. Closing sooner strands the
/// last sentence of a take, which is exactly the sentence somebody just
/// finished saying when they pressed stop.
const DRAIN_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(1_500);

/// How long to wait for `transcript.created` before giving up on a socket that
/// upgraded and then said nothing.
///
/// Audio sent before this arrives is discarded by the service, so a session
/// that streams anyway would bill for a take that transcribes nothing.
const READY_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(5_000);

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
        config: SttConfig,
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
    /// design exists to make diagnosable. The supervisor drains this counter
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

    /// Finish cleanly: `Finalize`, wait out [`DRAIN_TIMEOUT`] for the final
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
    /// Text from chunk-finals of the open utterance. Never revised.
    locked: std::sync::Mutex<String>,
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

    /// The text to report for an interim or chunk-final carrying `text`.
    fn extend(&self, text: &str, is_chunk_final: bool) -> String {
        let mut locked = self.locked.lock().expect("utterance state poisoned");
        let combined = join(&locked, text);
        if is_chunk_final {
            *locked = combined.clone();
        }
        combined
    }

    /// The text to report for the utterance-final carrying `text`.
    ///
    /// The final REPLACES everything locked so far — it is the service's own
    /// complete stitched utterance, and it is authoritative. See the module
    /// header for the capture that settled this.
    fn finish(&self, text: &str) -> String {
        self.locked
            .lock()
            .expect("utterance state poisoned")
            .clear();
        text.trim().to_string()
    }

    fn close(&self) {
        *self.open.lock().expect("utterance state poisoned") = None;
        self.locked
            .lock()
            .expect("utterance state poisoned")
            .clear();
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

/// Why a connection could not be established, and whether retrying could help.
pub struct ConnectError {
    pub message: String,
    pub recoverable: bool,
    pub status: Option<u16>,
}

type Socket = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

/// Open the socket with the key in an `Authorization: Bearer` header.
///
/// The header is the whole reason this code is in Rust; see the module docs.
/// The key is never interpolated into an error — `HeaderValue::from_str`
/// failures report the shape of the problem, not the value.
///
/// A refusal arrives as an HTTP status on the **upgrade**, not as a WebSocket
/// error frame, so this is the only place it is visible. A live 403 read
/// `{"code":"The caller does not have permission…","error":"Your newly created
/// team doesn't have any credits or licenses yet…"}` — an account-funding
/// problem that no amount of reconnecting fixes, and which must not be
/// reported to the presenter as a network blip.
async fn connect(key: &SecretString, config: &SttConfig) -> Result<Socket, ConnectError> {
    let mut request = config
        .stream_url()
        .into_client_request()
        .map_err(|err| ConnectError {
            message: err.to_string(),
            recoverable: false,
            status: None,
        })?;
    let mut header = HeaderValue::from_str(&format!("Bearer {}", key.expose())).map_err(|_| {
        ConnectError {
            message: "The stored xAI key contains characters that cannot be sent as a header."
                .to_string(),
            recoverable: false,
            status: None,
        }
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
                // 429 is a rate limit a backoff can genuinely ride out; the
                // 4xx family below is a key, a permission or a malformed
                // request, and reconnecting gets the same answer every time.
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

/// Open a session and close it immediately, to learn whether the key works.
///
/// Used by key validation. No audio is sent, so this costs nothing but the
/// upgrade — and it exercises the exact endpoint, auth scheme and permissions a
/// real take uses, which a call to the batch endpoint would not.
pub async fn probe(key: &SecretString, config: &SttConfig) -> Result<(), ConnectError> {
    let mut socket = connect(key, config).await?;
    let _ = socket.close(None).await;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn supervise<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    generation: u64,
    key: SecretString,
    config: SttConfig,
    mut rx: mpsc::Receiver<Outbound>,
    audio_ms: Arc<AtomicU64>,
    dropped: Arc<AtomicU64>,
) {
    let utterances = Arc::new(Utterances {
        generation,
        ordinal: AtomicU64::new(0),
        open: std::sync::Mutex::new(None),
        locked: std::sync::Mutex::new(String::new()),
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

        let socket = match connect(&key, &config).await {
            Ok(socket) => socket,
            Err(err) => {
                // A refusal is not a retry candidate, however early it lands.
                // Reconnecting against a revoked key or an unfunded account
                // bills for every attempt and reports "reconnecting — your
                // position is held" while nothing can possibly recover.
                if !err.recoverable {
                    emit(
                        &app,
                        SttFrame::Failed {
                            generation,
                            code: if matches!(err.status, Some(401) | Some(403)) {
                                "AUTH_KEY_INVALID".into()
                            } else {
                                "REALTIME_CONFIG_REJECTED".into()
                            },
                            message: err.message,
                            recoverable: false,
                        },
                    );
                    break;
                }
                if attempt >= BACKOFF_MS.len() {
                    emit(
                        &app,
                        SttFrame::Failed {
                            generation,
                            code: "REALTIME_CONNECT_FAILED".into(),
                            message: err.message,
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
                        detail: Some(err.message),
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
                 * provider that accepts the socket and then errors — which is
                 * exactly what a revoked key or a rejected configuration does —
                 * produced an infinite 250 ms reconnect loop that billed for
                 * every attempt and transcribed nothing. The only connection
                 * worth resetting the budget for is one that actually delivered
                 * a transcript — otherwise a long, healthy take with five
                 * scattered network blips would exhaust the budget and give up
                 * for good.
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

#[allow(clippy::too_many_arguments)]
async fn run_connection<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    generation: u64,
    socket: Socket,
    rx: &mut mpsc::Receiver<Outbound>,
    audio_ms: &Arc<AtomicU64>,
    dropped: &Arc<AtomicU64>,
    utterances: &Arc<Utterances>,
) -> ConnectionEnd {
    let (mut sink, source) = socket.split();

    // There is no config frame — the session was configured by the URL. What
    // does have to happen first is the readiness handshake: audio sent before
    // `transcript.created` is discarded by the service without complaint, so a
    // session that streamed straight away would bill for a take that
    // transcribed nothing.
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<()>();

    let mut reader = tauri::async_runtime::spawn(read_loop(
        app.clone(),
        generation,
        source,
        Arc::clone(utterances),
        ready_tx,
    ));

    if tokio::time::timeout(READY_TIMEOUT, ready_rx).await.is_err() {
        reader.abort();
        let _ = sink.close().await;
        return ConnectionEnd::Dropped(Some(
            "the transcription service accepted the connection but never became ready".into(),
        ));
    }

    emit(
        app,
        SttFrame::Transport {
            generation,
            state: "connected",
            detail: None,
        },
    );

    let mut draining_until: Option<tokio::time::Instant> = None;

    loop {
        // Once `Finalize` is sent we stop pulling from the queue entirely and
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
                        // Raw binary — no base64, no JSON envelope. A third
                        // less bandwidth than the provider this replaced.
                        let ms = (pcm.len() as u64 * 1_000) / (SAMPLE_RATE_HZ as u64 * 2);
                        if sink.send(Message::Binary(pcm.into())).await.is_err() {
                            reader.abort();
                            return ConnectionEnd::Dropped(Some("audio frame could not be sent".into()));
                        }
                        // Two bytes per sample, one channel.
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
                        // `Finalize` finishes the open utterance; `audio.done`
                        // ends the stream so the service closes cleanly rather
                        // than waiting out its own idle timeout.
                        let _ = sink.send(Message::Text(r#"{"type":"Finalize"}"#.into())).await;
                        let _ = sink.send(Message::Text(r#"{"type":"audio.done"}"#.into())).await;
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
/// Everything arrives at the TOP LEVEL discriminated by `type` — there is no
/// `result` envelope, and errors are `{"type":"error","message":…}` with no
/// status code, so permanence cannot be judged from an error frame the way it
/// could from a gRPC status. That judgement moved to [`connect`], where the
/// HTTP status on the upgrade actually says.
async fn read_loop<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    generation: u64,
    mut source: futures_util::stream::SplitStream<Socket>,
    utterances: Arc<Utterances>,
    ready: tokio::sync::oneshot::Sender<()>,
) -> ConnectionEnd {
    let mut ready = Some(ready);

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

        match parsed.get("type").and_then(|value| value.as_str()) {
            Some("transcript.created") => {
                if let Some(tx) = ready.take() {
                    let _ = tx.send(());
                }
                continue;
            }
            Some("error") => {
                let message = parsed
                    .get("message")
                    .and_then(|value| value.as_str())
                    .unwrap_or("xAI reported an error")
                    .to_string();
                /*
                 * An in-session error carries no code, so the only signal about
                 * permanence is the text. A key revoked mid-take is the case
                 * worth catching: reconnecting would be refused at the upgrade
                 * anyway, where `connect` classifies it properly, so this
                 * reports and lets the supervisor's budget handle the rest.
                 */
                let lowered = message.to_lowercase();
                let permanent = lowered.contains("api key")
                    || lowered.contains("permission")
                    || lowered.contains("credits");
                emit(
                    &app,
                    SttFrame::Failed {
                        generation,
                        code: if permanent {
                            "AUTH_KEY_INVALID".into()
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
            // The post-`audio.done` summary. Everything it carries has already
            // been reported by the utterance-finals, and it is followed by the
            // service closing the socket.
            Some("transcript.done") => return ConnectionEnd::Dropped(None),
            Some("transcript.partial") => {}
            _ => continue,
        }

        let Some(body) = parsed.get("text").and_then(|value| value.as_str()) else {
            continue;
        };
        if body.trim().is_empty() {
            continue;
        }
        let is_final = parsed
            .get("is_final")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        let speech_final = parsed
            .get("speech_final")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);

        utterances.productive.store(true, Ordering::SeqCst);
        // Grok has no speech-start event, so the item opens at the first frame
        // that carries words — the earliest evidence there is.
        let item_id = utterances.current(&app);
        let audio_ms = utterances.audio_ms.load(Ordering::Relaxed) as f64;

        if speech_final {
            emit_transcript(
                &app,
                SttFrame::Final {
                    generation,
                    item_id,
                    text: utterances.finish(body),
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
                    text: utterances.extend(body, is_final),
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
            message: "Your team doesn't have any credits".into(),
            recoverable: false,
        })
        .unwrap();
        assert_eq!(fatal["recoverable"], false);
    }

    fn utterances() -> Utterances {
        Utterances {
            generation: 1,
            ordinal: AtomicU64::new(0),
            open: std::sync::Mutex::new(Some("1-0".into())),
            locked: std::sync::Mutex::new(String::new()),
            audio_ms: Arc::new(AtomicU64::new(0)),
            productive: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// The utterance-final replaces the locked chunks rather than extending
    /// them: it is the service's own complete stitched utterance.
    #[test]
    fn a_stitched_utterance_final_replaces_the_locked_chunks() {
        let state = utterances();
        assert_eq!(state.extend("hello there", false), "hello there");
        assert_eq!(state.extend("hello there", true), "hello there");
        assert_eq!(
            state.finish("Hello there, my name is Greg."),
            "Hello there, my name is Greg."
        );
    }

    /// The regression a live capture caught and no unit test predicted.
    ///
    /// The final re-decodes the audio rather than joining the chunk texts, so
    /// it disagrees with them about wording. An implementation that appends
    /// unless it recognises the chunks as a prefix cannot see this as a repeat,
    /// appends, and doubles every utterance in the take.
    #[test]
    fn a_final_that_rewords_the_locked_chunks_still_replaces_them() {
        let state = utterances();
        state.extend("It and Wait: You Should Not Have To", true);
        state.extend("Think about scrolling at all.", true);
        let finished = state.finish("And wait, you shouldn't have to think about scrolling at all.");
        assert_eq!(
            finished,
            "And wait, you shouldn't have to think about scrolling at all."
        );
        assert!(
            !finished.to_lowercase().contains("should not have to"),
            "the chunk wording must not survive alongside the final's: {finished}"
        );
    }

    #[test]
    fn chunk_finals_lock_text_that_later_interims_cannot_revise() {
        let state = utterances();
        state.extend("the first part", true);
        assert_eq!(
            state.extend("and the rest", false),
            "the first part and the rest"
        );
        // An interim that revises itself does not disturb the locked prefix.
        assert_eq!(
            state.extend("and the rest of it", false),
            "the first part and the rest of it"
        );
    }

    /// A reconnect mid-utterance must not carry the half-sentence into the new
    /// connection's first item.
    #[test]
    fn closing_an_utterance_clears_the_locked_text() {
        let state = utterances();
        state.extend("stranded half sentence", true);
        state.close();
        assert_eq!(state.finish("a fresh start"), "a fresh start");
    }
}
