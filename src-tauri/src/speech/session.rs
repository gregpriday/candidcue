//! One live on-device transcription session.
//!
//! The renderer's side of this is unchanged from the websocket era: it calls
//! `stt_start`, pushes PCM16 frames with `stt_audio`, and receives [`SttFrame`]
//! events on `stt://event`. Keeping that contract is deliberate — the audio
//! capture graph, the level meter, the device picker and the transcript ledger
//! were all built against it and none of them care where the words come from.
//!
//! ---------------------------------------------------------------------------
//! WHY A DEDICATED OS THREAD
//! ---------------------------------------------------------------------------
//! ONNX inference is blocking CPU work measured in milliseconds per call. On
//! the async runtime it would occupy a worker for the length of a take and
//! starve every other Tauri command — database writes, stage emits, the take
//! summary. So the recogniser gets a real thread, fed by a bounded channel, and
//! the IPC command that hands it audio never blocks on inference.
//!
//! ---------------------------------------------------------------------------
//! WHAT NO LONGER EXISTS
//! ---------------------------------------------------------------------------
//! Reconnect backoff, a drain timeout, transport degradation, `endTurn`, and
//! every gRPC status code that used to decide whether retrying was worth it.
//! There is no connection to lose. `Transport` survives as an event only
//! because the renderer's pill reports session state with it, and a local
//! session genuinely does have a `connecting` (loading) and a `closed`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::Emitter;

use crate::errors::AppError;
use crate::windows::CONTROL_LABEL;

use super::SAMPLE_RATE_HZ;

/// The event channel the renderer listens on.
pub const STT_EVENT: &str = "stt://event";

/// How many audio frames may queue ahead of the recogniser.
///
/// 100 ms per frame, so this is ~5 s of speech. The model runs ~16× faster than
/// real time, so in practice this queue holds one or two frames; a backlog deep
/// enough to hit this bound means the machine is in trouble, and transcribing
/// five-second-old audio would put the cursor in the past. Frames are dropped
/// and the drop is reported rather than silently swallowed.
const AUDIO_QUEUE_FRAMES: usize = 50;

/// What the renderer receives.
///
/// Byte-identical in shape to what the websocket session emitted — the
/// TypeScript adapter switches on these exact strings, and a rename would
/// compile on both sides and silently stop producing transcripts.
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
        /// False means retrying is pointless — a broken installation, not a
        /// transient hiccup.
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
    tx: std::sync::mpsc::SyncSender<Outbound>,
    audio_ms: Arc<AtomicU64>,
    /// Frames `push_audio` could not queue, awaiting a report by the worker.
    dropped: Arc<AtomicU64>,
    /// Set by [`SessionHandle::stop`], never by [`SessionHandle::abandon`].
    ///
    /// The `Stop` MESSAGE is not a reliable shutdown signal on its own: it goes
    /// through the same bounded queue as audio, so a session whose queue is
    /// full — exactly the case where the recogniser is behind and the last
    /// words matter most — would have its stop dropped by `try_send`, exit on
    /// the disconnect instead, and never flush. The presenter would lose the
    /// sentence they had just finished saying, and the session would still
    /// report `closed` as though nothing had gone wrong.
    ///
    /// This flag cannot be dropped, so it is what actually distinguishes "the
    /// take ended" from "a newer take replaced this one".
    stop_requested: Arc<std::sync::atomic::AtomicBool>,
}

impl SessionHandle {
    pub fn spawn<R: tauri::Runtime>(
        app: tauri::AppHandle<R>,
        generation: u64,
        recognizer: Arc<cc_stt::LocalRecognizer>,
    ) -> Self {
        let (tx, rx) = std::sync::mpsc::sync_channel(AUDIO_QUEUE_FRAMES);
        let audio_ms = Arc::new(AtomicU64::new(0));
        let dropped = Arc::new(AtomicU64::new(0));
        let stop_requested = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let handle = Self {
            generation,
            tx,
            audio_ms: Arc::clone(&audio_ms),
            dropped: Arc::clone(&dropped),
            stop_requested: Arc::clone(&stop_requested),
        };

        let worker_audio_ms = Arc::clone(&audio_ms);
        let worker_dropped = Arc::clone(&dropped);
        let worker_stop = Arc::clone(&stop_requested);
        // Cloned before the closure takes ownership, so the failure branch
        // below still has a handle to report through.
        let reporter = app.clone();
        let spawned = std::thread::Builder::new()
            .name(format!("stt-{generation}"))
            .spawn(move || {
                run_session(
                    app,
                    generation,
                    recognizer,
                    rx,
                    worker_audio_ms,
                    worker_dropped,
                    worker_stop,
                )
            });

        if let Err(err) = spawned {
            // A thread that cannot be spawned is not a take that can be
            // rescued, and the presenter needs to be told now rather than
            // discovering it as silence.
            emit(
                &reporter,
                SttFrame::Failed {
                    generation,
                    code: "STT_WORKER_FAILED".into(),
                    message: format!("The speech recogniser could not be started: {err}"),
                    recoverable: false,
                },
            );
            emit(
                &reporter,
                SttFrame::Transport {
                    generation,
                    state: "closed",
                    detail: None,
                },
            );
        }
        handle
    }

    /// Milliseconds of audio handed to the recogniser so far. This is the
    /// session clock the transcripts are timed against.
    pub fn audio_ms(&self) -> f64 {
        self.audio_ms.load(Ordering::Relaxed) as f64
    }

    /// Forward one frame of PCM16.
    ///
    /// `try_send` rather than `send`: this is called from an IPC command on the
    /// capture cadence, and blocking it would stall the renderer's capture loop
    /// to wait for a recogniser that is already behind.
    ///
    /// The drop is COUNTED here, which is the whole point. Audio discarded
    /// silently is indistinguishable downstream from a presenter who said
    /// nothing, and "words heard: 0" with no explanation is the failure this
    /// design exists to make diagnosable.
    ///
    /// A closed channel is NOT counted: the session is over, and every frame
    /// after that is expected rather than lost.
    pub fn push_audio(&self, pcm: Vec<u8>) -> Result<(), AppError> {
        match self.tx.try_send(Outbound::Audio(pcm)) {
            Ok(()) => Ok(()),
            Err(std::sync::mpsc::TrySendError::Full(_)) => {
                self.dropped.fetch_add(1, Ordering::Relaxed);
                Ok(())
            }
            Err(std::sync::mpsc::TrySendError::Disconnected(_)) => Ok(()),
        }
    }

    /// Finish cleanly: flush the recogniser's trailing context so the last
    /// utterance gets its final, then close.
    ///
    /// Unlike the websocket path this needs no drain timeout — the flush is a
    /// function call, not a round trip, and it completes in milliseconds.
    ///
    /// The flag is set BEFORE the message is offered, and it is the flag that
    /// carries the meaning. `try_send` may legitimately fail here (a full queue
    /// is the whole reason `push_audio` does not block), and the message is
    /// only a fast path that lets the worker skip the audio still queued behind
    /// it. If it does not fit, the worker finds the flag when the channel
    /// disconnects and flushes anyway.
    pub fn stop(self) {
        self.stop_requested.store(true, Ordering::SeqCst);
        let _ = self.tx.try_send(Outbound::Stop);
    }

    /// Drop the session without flushing. Used when a *newer* session has
    /// already replaced this one, where the last utterance of the old take is
    /// of no interest to anybody.
    ///
    /// Deliberately does NOT set `stop_requested`: that is the difference
    /// between the two, and it is why the worker can tell an ended take from a
    /// superseded one when the channel disconnects.
    pub fn abandon(self) {
        drop(self.tx);
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
/// engine — a session notice is not evidence about where the presenter is
/// reading.
///
/// `audio_now_ms` is the audio clock read at arrival. The engine's lag model
/// was calibrated against that clock on live captures; a wall clock would
/// mis-time every prediction in a way nothing downstream can detect.
fn emit_transcript<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    frame: SttFrame,
    audio_now_ms: f64,
) {
    crate::align::observe_frame(app, &frame, audio_now_ms);
    emit(app, frame);
}

/// The recogniser thread: own the stream, consume audio, publish frames.
#[allow(clippy::too_many_arguments)]
fn run_session<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    generation: u64,
    recognizer: Arc<cc_stt::LocalRecognizer>,
    rx: std::sync::mpsc::Receiver<Outbound>,
    audio_ms: Arc<AtomicU64>,
    dropped: Arc<AtomicU64>,
    stop_requested: Arc<std::sync::atomic::AtomicBool>,
) {
    emit(
        &app,
        SttFrame::Transport {
            generation,
            state: "connecting",
            detail: None,
        },
    );

    // The model is already resident; creating a stream is cheap, so the session
    // is usable immediately rather than after a load.
    let mut session = recognizer.session(generation);

    emit(
        &app,
        SttFrame::Transport {
            generation,
            state: "connected",
            detail: None,
        },
    );

    // Translate the engine's protocol frames into the renderer's, stamping the
    // generation the renderer filters on. `cc_stt` deliberately does not know
    // about generations — it is the same crate the offline harness drives.
    let publish = |frame: cc_stt::SttFrame, app: &tauri::AppHandle<R>| match frame {
        cc_stt::SttFrame::ItemStarted {
            item_id,
            ordinal,
            audio_start_ms,
        } => emit_transcript(
            app,
            SttFrame::ItemStarted {
                generation,
                item_id,
                ordinal,
                audio_start_ms,
            },
            audio_start_ms,
        ),
        cc_stt::SttFrame::Partial {
            item_id,
            text,
            audio_ms,
            ..
        } => emit_transcript(
            app,
            SttFrame::Partial {
                generation,
                item_id,
                text,
            },
            audio_ms,
        ),
        cc_stt::SttFrame::Final {
            item_id,
            text,
            audio_end_ms,
            ..
        } => emit_transcript(
            app,
            SttFrame::Final {
                generation,
                item_id,
                text,
                audio_end_ms,
            },
            audio_end_ms,
        ),
        cc_stt::SttFrame::Error { message } => emit(
            app,
            SttFrame::Failed {
                generation,
                code: "STT_ENGINE_ERROR".into(),
                message,
                recoverable: false,
            },
        ),
        // The engine's own end-of-stream marker. The session reports `closed`
        // itself, below, so this needs no renderer frame of its own.
        cc_stt::SttFrame::Closed {} => {}
    };

    let mut flushed = false;
    while let Ok(outbound) = rx.recv() {
        match outbound {
            Outbound::Audio(pcm) => {
                session.push_pcm16(&pcm, SAMPLE_RATE_HZ, &mut |frame| publish(frame, &app));
                // Two bytes per sample, one channel. Read from the session so
                // there is one definition of the clock rather than two that can
                // disagree.
                audio_ms.store(session.audio_ms() as u64, Ordering::Relaxed);

                // Reported on the first frame that gets through after a run of
                // drops, so one gap produces one event rather than one per lost
                // frame.
                let lost = dropped.swap(0, Ordering::Relaxed);
                if lost > 0 {
                    emit(&app, SttFrame::AudioDropped { generation, frames: lost });
                }
            }
            Outbound::Stop => {
                session.finish(&mut |frame| publish(frame, &app));
                flushed = true;
                break;
            }
        }
    }

    // The channel disconnected without the fast-path `Stop` arriving. Which of
    // the two shutdowns this was is on the flag, not on the message: a stop
    // whose message did not fit in a full queue still has to flush, or the take
    // silently loses its last sentence.
    if !flushed && stop_requested.load(Ordering::SeqCst) {
        session.finish(&mut |frame| publish(frame, &app));
    }

    // Any drops still outstanding are reported before the session goes quiet.
    // They are otherwise only flushed by the next successful frame, so a run
    // that ends in a stop would swallow the count — which is exactly the take
    // where the presenter most needs to know audio was lost.
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A stop must survive a full audio queue.
    ///
    /// The bug this guards: `stop` offered `Outbound::Stop` with `try_send` and
    /// ignored the result. A queue full of audio — which is precisely the state
    /// a struggling machine is in at the end of a take — swallowed it, the
    /// worker exited on the channel disconnect instead of on the message, and
    /// `session.finish()` never ran. The last utterance got no `Final`, the
    /// recogniser's trailing context was never flushed, and the session still
    /// reported `closed`, so the loss looked like a clean shutdown.
    ///
    /// This asserts the flag rather than the message, because the flag is what
    /// the worker now keys the flush on.
    #[test]
    fn a_stop_survives_a_full_audio_queue() {
        let (tx, _rx) = std::sync::mpsc::sync_channel::<Outbound>(1);
        let stop_requested = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let handle = SessionHandle {
            generation: 1,
            tx,
            audio_ms: Arc::new(AtomicU64::new(0)),
            dropped: Arc::new(AtomicU64::new(0)),
            stop_requested: Arc::clone(&stop_requested),
        };

        // Fill the queue, then confirm it really is full: a further frame is
        // dropped and counted rather than blocking.
        handle.push_audio(vec![0; 8]).expect("first frame queues");
        handle.push_audio(vec![0; 8]).expect("second frame is dropped");
        assert_eq!(handle.dropped.load(Ordering::Relaxed), 1);

        handle.stop();

        assert!(
            stop_requested.load(Ordering::SeqCst),
            "a stop against a full queue must still be recorded, or the take \
             loses the sentence the presenter just finished saying"
        );
    }

    /// Abandoning is the other half of the same distinction: a superseded take
    /// has nothing worth flushing, and must not be mistaken for one that ended.
    #[test]
    fn abandoning_does_not_request_a_flush() {
        let (tx, _rx) = std::sync::mpsc::sync_channel::<Outbound>(4);
        let stop_requested = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let handle = SessionHandle {
            generation: 2,
            tx,
            audio_ms: Arc::new(AtomicU64::new(0)),
            dropped: Arc::new(AtomicU64::new(0)),
            stop_requested: Arc::clone(&stop_requested),
        };

        handle.abandon();

        assert!(!stop_requested.load(Ordering::SeqCst));
    }

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
            code: "STT_MODEL_MISSING".into(),
            message: "model files are not in this installation".into(),
            recoverable: false,
        })
        .unwrap();
        assert_eq!(fatal["recoverable"], false);
    }
}
