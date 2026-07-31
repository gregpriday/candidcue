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
use catalogue::catalogue;

/// The model is not on this machine — and that is now an ordinary state.
///
/// It used to mean "your installation is damaged", because every build carried
/// the weights and their absence could only be corruption. Since §152 the
/// stock installer ships none, so the honest message points at the download
/// rather than telling the user to reinstall the app. Recoverable, because it
/// genuinely is: Settings has the button.
fn not_installed() -> AppError {
    AppError::structured(
        "STT_MODEL_NOT_INSTALLED",
        ErrorCategory::Validation,
        "The speech model has not been downloaded yet. \
         Open Settings › Speech to install it.",
        true,
    )
}

pub mod catalogue;
pub mod model_download;
pub mod model_manager;
pub mod model_store;
pub mod session;

/// The one sample rate the app captures and streams at.
///
/// Pinned rather than negotiated: the renderer resamples its capture graph to
/// this and the audio-clock arithmetic converts sample counts to milliseconds
/// with it. The recogniser itself resamples internally and would accept any
/// rate, but two places still have to agree, so there is one constant.
pub const SAMPLE_RATE_HZ: u32 = 24_000;

/// Which recognisers this build can load, and how each was measured.
///
/// Re-exported from `cc_stt` so that the app has one name for "the catalogue"
/// and the tests that assert against it do not have to reach across workspaces
/// to say so.
///
/// Not to be confused with `models/catalogue.json`, which `catalogue.rs` reads.
/// That one is a FETCH manifest — URLs, digests, sizes, licences for everything
/// `pnpm models:fetch` can download. This one is a BUNDLE manifest: the models
/// this build actually ships and the tuning each was measured with. The fetch
/// catalogue is deliberately the longer list, so the two are asserted equal only
/// where they overlap, at the default.
pub use cc_stt::models::{bundled_models, default_model, model_by_id, BundledModel};

/// The recogniser resident in memory, and which one it is.
///
/// The id travels WITH the handle rather than beside it. Two mutexes holding
/// two halves of one fact is an invitation for them to disagree, and the fact
/// they would be disagreeing about is "what is doing the listening" — which is
/// the question diagnostics exist to answer.
struct CachedRecognizer {
    model_id: &'static str,
    recognizer: Arc<cc_stt::LocalRecognizer>,
}

/// Managed state: the loaded model, and the live session if one is running.
///
/// Exactly one streaming session may exist at a time — a take owns the
/// microphone, and a second session would be transcribing audio nobody reads.
pub struct SpeechEngine {
    /// Loaded once and kept resident. Loading costs ~200 ms, which is 200 ms
    /// that must not be spent at the top of a take: the presenter has already
    /// started talking by the time a session is armed.
    ///
    /// One slot, keyed, rather than a map from model to recogniser. A map would
    /// hold every model that had ever been used — ~161 MB of ONNX graphs each —
    /// to save a ~200 ms load on a switch that cannot happen during a take,
    /// since exactly one session may run at a time. Keeping the second model
    /// resident buys latency nobody is waiting on with memory the presenter's
    /// machine is using for something else.
    recognizer: std::sync::Mutex<Option<CachedRecognizer>>,
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
            session: std::sync::Mutex::new(None),
            next_generation: std::sync::atomic::AtomicU64::new(1),
        }
    }

    /// Find this model's directory on this machine.
    ///
    /// This used to be one line: resolve the resource directory and hand it
    /// back, on the assumption that every model this build knows about is
    /// inside the application bundle. §152 removed that assumption — stock
    /// builds bundle no models at all — so the question changed from "where
    /// would the bundler have put it" to "where, if anywhere, IS it".
    ///
    /// `model_store::resolve` answers that, preferring what this machine
    /// downloaded and falling back to a bundled resource for the builds that
    /// still ship one. The resource path still comes from Tauri's resolver
    /// rather than from reasoning about the executable's location, because the
    /// answer differs between `tauri dev`, a macOS `.app`, an MSI install and
    /// a Linux package.
    ///
    /// The model is a parameter rather than a constant because which one is
    /// wanted is a runtime question — even while there is only one answer to
    /// it. A build-time constant here is what made a second model impossible
    /// to add without touching every caller.
    pub fn model_dir<R: tauri::Runtime>(
        app: &tauri::AppHandle<R>,
        model: &BundledModel,
    ) -> Result<PathBuf, AppError> {
        // The bundle manifest and the fetch catalogue agree at the default,
        // and `the_resource_dir_is_the_catalogue_install_dir` pins that. An
        // entry that is genuinely absent from the catalogue can still be
        // resolved the old way, so a model added to `cc_stt` before the
        // catalogue catches up degrades to "bundled only" rather than to
        // "unfindable".
        let entry = catalogue()
            .models
            .iter()
            .find(|entry| entry.model_name == model.id);
        if let Some(entry) = entry {
            if let Some(found) = model_manager::resolve_for(app, entry) {
                return Ok(found.dir);
            }
            return Err(not_installed());
        }

        use tauri::Manager as _;
        let dir = app
            .path()
            .resolve(model.resource_dir, tauri::path::BaseDirectory::Resource)
            .map_err(|err| {
                AppError::structured(
                    "STT_MODEL_MISSING",
                    ErrorCategory::Internal,
                    format!("The speech model could not be located in this installation: {err}"),
                    false,
                )
            })?;
        if cc_stt::local::ModelFiles::detect(&dir).is_err() {
            return Err(not_installed());
        }
        Ok(dir)
    }

    /// Evict the resident recogniser if it is this model.
    ///
    /// Called after a model is installed or deleted. The cache holds an `Arc`
    /// to graphs loaded from a directory that has just been replaced or
    /// removed, and keeping it would mean the next take runs on the old
    /// weights — or on files that are no longer there.
    ///
    /// A take already running keeps its own `Arc` and finishes on the model it
    /// started with, which is the only safe answer: swapping a recogniser out
    /// from under a live session would change what the engine is hearing
    /// halfway through.
    pub fn evict_if_loaded(&self, model_id: &str) {
        let mut slot = self.recognizer.lock().expect("stt model poisoned");
        if slot.as_ref().is_some_and(|c| c.model_id == model_id) {
            *slot = None;
        }
    }

    /// Load the requested model if it is not already resident, and hand back a
    /// handle.
    ///
    /// Idempotent and safe to call from a warm-up path as well as from the
    /// start of a take. Asking for a model other than the resident one replaces
    /// it rather than adding to it — see the field docs on `recognizer`.
    pub fn ensure_loaded<R: tauri::Runtime>(
        &self,
        app: &tauri::AppHandle<R>,
        model: &BundledModel,
    ) -> Result<Arc<cc_stt::LocalRecognizer>, AppError> {
        // The lock is held ACROSS the load, not just across the check. Preload
        // and the start of a take can arrive together — that is the normal
        // case, not a race to be tolerated — and a check-then-load would let
        // both see "not loaded" and each build a recognizer, paying the ~200 ms
        // and the memory twice for one that is immediately dropped.
        let mut slot = self.recognizer.lock().expect("stt model poisoned");
        if let Some(cached) = slot.as_ref() {
            if cached.model_id == model.id {
                return Ok(Arc::clone(&cached.recognizer));
            }
        }

        let dir = Self::model_dir(app, model)?;
        let config = cc_stt::LocalSttConfig::for_model(model, &dir);
        // Checked before the C library is asked, because `create` answers a
        // missing file with a null pointer and no reason at all.
        //
        // Resolved and checked while any previous model is STILL CACHED. A
        // request for a model this installation does not have should leave the
        // one it does have exactly where it was — evicting first would answer
        // "you asked for a model that isn't here" by also throwing away the
        // working one, and the next take would pay a cold load for nothing.
        config.validate().map_err(|detail| {
            AppError::structured(
                "STT_MODEL_MISSING",
                ErrorCategory::Internal,
                format!("The speech model is missing from this installation. {detail}"),
                false,
            )
        })?;

        // Dropped immediately before the replacement is built, so two ~161 MB
        // graph sets never sit in the cache together. A take already running
        // keeps its own `Arc` and finishes on the model it started with — the
        // only safe answer, since swapping a recogniser out from under a
        // session would change what the engine is hearing halfway through.
        *slot = None;

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
            model = model.id,
            dir = %dir.display(),
            blank_penalty = config.blank_penalty,
            load_ms = started.elapsed().as_millis(),
            "loaded on-device speech model"
        );

        let loaded = Arc::new(loaded);
        *slot = Some(CachedRecognizer {
            model_id: model.id,
            recognizer: Arc::clone(&loaded),
        });
        Ok(loaded)
    }

    /// Whether a model is resident. Diagnostics and Settings.
    pub fn is_loaded(&self) -> bool {
        self.recognizer
            .lock()
            .expect("stt model poisoned")
            .is_some()
    }

    /// Which model is resident, if any. Diagnostics and Settings.
    pub fn loaded_model_id(&self) -> Option<&'static str> {
        self.recognizer
            .lock()
            .expect("stt model poisoned")
            .as_ref()
            .map(|cached| cached.model_id)
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
        model: &BundledModel,
    ) -> Result<u64, AppError> {
        let recognizer = self.ensure_loaded(&app, model)?;
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

    /// The stock installer ships NO speech model (§152).
    ///
    /// This is the inverse of the test that used to be here, which required
    /// every registered model to appear in `bundle.resources`. That was the
    /// right guard while the weights were part of the app: the two lists
    /// drifting meant a build that installed and then failed to transcribe,
    /// with a resource resolver reporting success over a file that was not
    /// there.
    ///
    /// The policy is now the opposite, so the test is too. ~161 MB of ONNX
    /// graphs in every download and every update bought nothing that the
    /// catalogue's SHA-256 was not already providing, and the model is fetched
    /// after install instead. Re-adding a `models/` entry here would silently
    /// restore the payload this issue removed, which is exactly the kind of
    /// change that is invisible in a diff review and obvious on a download
    /// page — so it fails here instead.
    ///
    /// A build that deliberately wants an offline installer can still add one:
    /// `model_store::resolve` keeps the bundled fallback. It just cannot happen
    /// by accident on `main`.
    ///
    /// Read as JSON rather than searched as text. A substring test passes on a
    /// path that appears anywhere in the file, including inside a longer path
    /// or a setting that has nothing to do with bundling.
    #[test]
    fn the_stock_bundle_ships_no_speech_model() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json"))
                .expect("tauri.conf.json must be valid JSON");
        let resources = config["bundle"]["resources"]
            .as_array()
            .expect("bundle.resources must be a list");
        let bundled: Vec<&str> = resources
            .iter()
            .filter_map(|entry| entry.as_str())
            .map(|entry| entry.trim_end_matches('/'))
            .collect();
        // Containment, not equality. An exact-string check passes on `models`,
        // `models/`, or a glob like `models/*` — every one of which puts the
        // whole payload back while the test stays green. What is being
        // asserted is that nothing in the resource list REACHES a model
        // directory, however it is spelled.
        for model in bundled_models() {
            let dir = model.resource_dir.trim_end_matches('/');
            for entry in &bundled {
                let reaches = dir == *entry
                    || dir.starts_with(&format!("{entry}/"))
                    || entry.trim_end_matches("/*").trim_end_matches("/**") == dir
                    || dir.starts_with(&format!(
                        "{}/",
                        entry.trim_end_matches('*').trim_end_matches('/')
                    ));
                assert!(
                    !reaches,
                    "tauri.conf.json resource {entry:?} bundles {} for model {}. \
                     Models are downloaded after install (#152); bundling one puts \
                     ~161 MB back into every download. If that is deliberate, this \
                     test is the place to say so.",
                    model.resource_dir, model.id
                );
            }
        }
    }

    /// Every model this build can LOAD must be one the catalogue can fetch.
    ///
    /// The guard that replaces the bundling one, and the same failure it was
    /// really about: a model registered in `cc_stt` with no way to obtain it
    /// is offered in the UI and can never be installed. The catalogue is
    /// allowed to be the longer list — it describes models this build cannot
    /// yet decode with — but not the shorter one.
    #[test]
    fn every_loadable_model_can_be_downloaded() {
        for model in bundled_models() {
            assert!(
                catalogue()
                    .models
                    .iter()
                    .any(|entry| entry.model_name == model.id),
                "models/catalogue.json has no entry for {}, so it can never be \
                 installed on a machine that does not already have it",
                model.id
            );
        }
    }

    /// The default is what everything without an explicit choice gets, so it
    /// has to be a model the catalogue can actually look up.
    #[test]
    fn the_default_model_is_in_the_catalogue() {
        assert_eq!(model_by_id(default_model().id), Some(default_model()));
    }
}
