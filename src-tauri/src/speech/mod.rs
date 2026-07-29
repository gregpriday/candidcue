//! On-device speech-to-text — the app's only speech provider.
//!
//! ---------------------------------------------------------------------------
//! WHY THIS REPLACED A HOSTED SERVICE
//! ---------------------------------------------------------------------------
//! The app used to stream every take to Inworld over a websocket. That worked,
//! and it cost an API key, a network round trip, a per-minute bill, and a class
//! of failure — a revoked key, a dropped socket, a reconnect loop — that lands
//! in the middle of a take and cannot be recovered from on stage.
//!
//! A streaming Zipformer transducer runs the same job on the presenter's own
//! machine at a real-time factor around 0.03 — a few percent of one core. There
//! is no key to hold, no socket to supervise, and no reason a take can fail
//! that is not visible on the machine it runs on.
//!
//! ---------------------------------------------------------------------------
//! WHAT WE GAVE UP, AND WHY IT IS AFFORDABLE
//! ---------------------------------------------------------------------------
//! Some raw transcription accuracy: word error rate is roughly 10.9% against
//! the hosted service's 6.3% on the benchmark corpus.
//!
//! That matters much less than it sounds, because **nothing on the glass is
//! transcribed
//! text**. The recogniser is a position sensor: the app already knows the
//! script, and `cc_align` matches a noisy hypothesis against a constrained
//! window of a document it has compiled. Case and punctuation are normalised
//! away before matching, and a wrong word inside a correct run costs nothing
//! the tracker cannot absorb. `bench/REPORT.md` is where that claim is
//! measured rather than asserted.
//!
//! What we gained, beyond cost and reliability: **latency**. The hosted service
//! restated an utterance about once a second and finalised it 1.2–1.7 s after
//! silence. This model produces a fresh hypothesis every time it has enough
//! frames to decode one, and we publish on every change — earlier evidence
//! about where the reader is, which is the entire product.
//!
//! ---------------------------------------------------------------------------
//! THE AUDIO CLOCK
//! ---------------------------------------------------------------------------
//! Unchanged, and deliberately so. Alignment needs to know *when* words were
//! spoken; the clock is the count of audio handed to the recogniser, which at a
//! pinned sample rate is a duration. It is monotonic, immune to event-loop
//! jitter, and does not advance while the microphone is closed. The engine's
//! lag model was calibrated against that definition and still is.

use std::path::PathBuf;
use std::sync::Arc;

use crate::errors::{AppError, ErrorCategory};

pub mod session;

/// The one sample rate the app captures and streams at.
///
/// Pinned rather than negotiated: the renderer resamples its capture graph to
/// this and the audio-clock arithmetic converts sample counts to milliseconds
/// with it. The recogniser itself resamples internally and would accept any
/// rate, but two places still have to agree, so there is one constant.
pub const SAMPLE_RATE_HZ: u32 = 24_000;

/// Where the model lives inside the bundle, relative to the resource root.
pub const MODEL_RESOURCE_DIR: &str = "models/x-asr-480ms";

/// The recogniser this build ships. Reported to Settings so the app can say
/// what is doing the listening without pretending there is a choice.
pub const MODEL_NAME: &str = "x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05";

/// Managed state: the loaded model, and the live session if one is running.
///
/// Exactly one streaming session may exist at a time — a take owns the
/// microphone, and a second session would be transcribing audio nobody reads.
pub struct SpeechEngine {
    /// Loaded once and kept resident. Loading costs ~200 ms, which is 200 ms
    /// that must not be spent at the top of a take: the presenter has already
    /// started talking by the time a session is armed.
    recognizer: std::sync::Mutex<Option<Arc<cc_stt::LocalRecognizer>>>,
    model_dir: std::sync::Mutex<Option<PathBuf>>,
    session: std::sync::Mutex<Option<session::SessionHandle>>,
    next_generation: std::sync::atomic::AtomicU64,
}

impl Default for SpeechEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl SpeechEngine {
    pub fn new() -> Self {
        Self {
            recognizer: std::sync::Mutex::new(None),
            model_dir: std::sync::Mutex::new(None),
            session: std::sync::Mutex::new(None),
            next_generation: std::sync::atomic::AtomicU64::new(1),
        }
    }

    /// Resolve the bundled model directory for this installation.
    ///
    /// Always through Tauri's resource resolver, never by reasoning about the
    /// executable's path: the answer differs between `tauri dev`, a macOS
    /// `.app`, an MSI install and a Linux package, and the resolver is the only
    /// thing that knows which one it is in.
    pub fn model_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, AppError> {
        use tauri::Manager as _;
        app.path()
            .resolve(MODEL_RESOURCE_DIR, tauri::path::BaseDirectory::Resource)
            .map_err(|err| {
                AppError::structured(
                    "STT_MODEL_MISSING",
                    ErrorCategory::Internal,
                    format!("The speech model could not be located in this installation: {err}"),
                    false,
                )
            })
    }

    /// Load the model if it is not loaded already, and hand back a handle.
    ///
    /// Idempotent and safe to call from a warm-up path as well as from the
    /// start of a take.
    pub fn ensure_loaded<R: tauri::Runtime>(
        &self,
        app: &tauri::AppHandle<R>,
    ) -> Result<Arc<cc_stt::LocalRecognizer>, AppError> {
        // The lock is held ACROSS the load, not just across the check. Preload
        // and the start of a take can arrive together — that is the normal
        // case, not a race to be tolerated — and a check-then-load would let
        // both see "not loaded" and each build a recognizer, paying the ~200 ms
        // and the memory twice for one that is immediately dropped.
        let mut slot = self.recognizer.lock().expect("stt model poisoned");
        if let Some(loaded) = slot.as_ref() {
            return Ok(Arc::clone(loaded));
        }

        let dir = Self::model_dir(app)?;
        let config = cc_stt::LocalSttConfig::with_model_dir(&dir);
        // Checked before the C library is asked, because `create` answers a
        // missing file with a null pointer and no reason at all.
        config.validate().map_err(|detail| {
            AppError::structured(
                "STT_MODEL_MISSING",
                ErrorCategory::Internal,
                format!("The speech model is missing from this installation. {detail}"),
                false,
            )
        })?;

        let started = std::time::Instant::now();
        let loaded = cc_stt::LocalRecognizer::load(&config).map_err(|detail| {
            AppError::structured(
                "STT_MODEL_LOAD_FAILED",
                ErrorCategory::Internal,
                format!("The speech model could not be loaded. {detail}"),
                false,
            )
        })?;
        tracing::info!(
            model = MODEL_NAME,
            dir = %dir.display(),
            load_ms = started.elapsed().as_millis(),
            "loaded on-device speech model"
        );

        let loaded = Arc::new(loaded);
        *slot = Some(Arc::clone(&loaded));
        *self.model_dir.lock().expect("stt model dir poisoned") = Some(dir);
        Ok(loaded)
    }

    /// Whether the model is resident. Diagnostics and Settings.
    pub fn is_loaded(&self) -> bool {
        self.recognizer
            .lock()
            .expect("stt model poisoned")
            .is_some()
    }

    /// The generation of the session currently running, if any.
    ///
    /// Exists so an alignment session armed AFTER its recogniser can still bind
    /// to it. Both are async IPC calls from the frontend and their landing order
    /// is not guaranteed, so binding cannot rely on one arriving first.
    pub fn current_generation(&self) -> Option<u64> {
        self.session
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|handle| handle.generation))
    }

    /// Open a streaming session, replacing any session already running.
    ///
    /// Returns the generation, which stamps every event the session emits and
    /// every audio frame the renderer pushes. Without it, a frame in flight
    /// when a take ends would be appended to the next take's audio, and a
    /// transcript from the old session would land in the new take's ledger.
    pub fn start_stream<R: tauri::Runtime>(
        &self,
        app: tauri::AppHandle<R>,
    ) -> Result<u64, AppError> {
        let recognizer = self.ensure_loaded(&app)?;
        let generation = self
            .next_generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);

        /*
         * Bind the alignment engine to THIS session, before the worker that
         * feeds it is started.
         *
         * The generation exists nowhere else — it is minted here and stamped on
         * every frame — so this is the only place that can tie the two
         * together. Asking the frontend for it would be asking it to guess, and
         * the guess it made was the SESSION generation: an unrelated counter
         * that routinely disagrees. Every frame was then dropped on a session
         * reporting perfect health.
         *
         * Before the spawn, so no frame of the new session can arrive ahead of
         * the binding.
         */
        crate::align::bind_stream_generation(&app, generation);
        let handle = session::SessionHandle::spawn(app, generation, recognizer);
        let previous = self
            .session
            .lock()
            .expect("stt session poisoned")
            .replace(handle);
        if let Some(previous) = previous {
            previous.abandon();
        }
        Ok(generation)
    }

    /// Forward one PCM16 frame. Silently ignores frames stamped with a
    /// generation that is no longer current — that is a late frame from a take
    /// that has ended, not an error worth surfacing.
    pub fn push_audio(&self, generation: u64, pcm: Vec<u8>) -> Result<(), AppError> {
        let guard = self.session.lock().expect("stt session poisoned");
        match guard.as_ref() {
            Some(session) if session.generation == generation => session.push_audio(pcm),
            _ => Ok(()),
        }
    }

    /// End the session so the last utterance is finalized rather than stranded.
    pub fn stop_stream(&self, generation: u64) {
        let mut guard = self.session.lock().expect("stt session poisoned");
        let matches = guard
            .as_ref()
            .is_some_and(|session| session.generation == generation);
        if matches {
            if let Some(session) = guard.take() {
                session.stop();
            }
        }
    }

    /// Generation of the live session, if any. Diagnostics only.
    pub fn active_generation(&self) -> Option<u64> {
        self.session
            .lock()
            .expect("stt session poisoned")
            .as_ref()
            .map(|session| session.generation)
    }
}

pub(crate) fn decode_base64(text: &str) -> Result<Vec<u8>, AppError> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(text)
        .map_err(|_| AppError::invalid_input("Audio frame was not valid base64."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_round_trips_pcm_frames() {
        use base64::Engine as _;
        let pcm: Vec<u8> = (0..512u16).flat_map(|s| s.to_le_bytes()).collect();
        let encoded = base64::engine::general_purpose::STANDARD.encode(&pcm);
        assert_eq!(decode_base64(&encoded).unwrap(), pcm);
        assert!(decode_base64("not base64!!").is_err());
    }

    #[test]
    fn the_bundled_model_directory_is_the_one_the_bundler_ships() {
        // tauri.conf.json lists this path under `bundle.resources`. If the two
        // drift, the app builds, installs, and fails to transcribe anything —
        // with a resource resolver that reports success and a file that is not
        // there.
        let config = include_str!("../../tauri.conf.json");
        assert!(
            config.contains(MODEL_RESOURCE_DIR),
            "tauri.conf.json must bundle {MODEL_RESOURCE_DIR}"
        );
    }
}
