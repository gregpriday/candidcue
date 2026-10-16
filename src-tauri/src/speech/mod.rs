//! On-device speech-to-text — the app's only speech provider.
//!
//! ---------------------------------------------------------------------------
//! WHY THIS REPLACED A HOSTED SERVICE
//! ---------------------------------------------------------------------------
//! The app used to stream every take to a hosted recogniser over a websocket.
//! That worked, and it cost an API key, a network round trip, a per-minute
//! bill, and a class of failure — a revoked key, a dropped socket, a reconnect
//! loop — that lands in the middle of a take and cannot be recovered from on
//! stage.
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

/// The model's download is on this machine and sealed, and its files are no
/// longer what was installed (#258).
///
/// Recoverable, and for the same reason as [`not_installed`]: Settings › Speech
/// offers the download that repairs it, and it is raised BEFORE the C library
/// is asked to read the damaged graph — which, asked, aborts the process. The
/// detail (which file, what was wrong) is for the log; the presenter is told
/// what to do.
///
/// The message is written for Settings › Speech, which renders it verbatim
/// under the model's Download button — so it names no screen. A take never
/// shows it: the frontend's own copy for the code replaces it there.
pub(crate) fn model_damaged(detail: &str) -> AppError {
    AppError::structured(
        "STT_MODEL_DAMAGED",
        ErrorCategory::Validation,
        "The speech data on this computer is damaged and cannot be used. \
         Download it again to repair it.",
        true,
    )
    .with_log(detail.to_string())
}

pub mod catalogue;
pub mod language_options;
pub mod model_download;
pub mod model_manager;
pub mod model_store;
mod resident;
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
/// catalogue may be the longer list, so the two are asserted equal only where
/// they overlap, at the default.
pub use cc_stt::models::{bundled_models, default_model, model_by_id, BundledModel};

/// Managed state: the loaded model, and the live session if one is running.
///
/// Exactly one streaming session may exist at a time — a take owns the
/// microphone, and a second session would be transcribing audio nobody reads.
pub struct SpeechEngine {
    /// Loaded once and kept resident. A load takes over a second — 1.1 s on a
    /// warm release build, 5.2 s the worst the logs have recorded — which must
    /// not be spent at the top of a take: the presenter has already started
    /// talking by the time a session is armed.
    ///
    /// One slot, keyed, rather than a map from model to recogniser. A map would
    /// hold every model that had ever been used — ~161 MB of ONNX graphs each —
    /// to save a load on a switch that cannot happen during a take, since
    /// exactly one session may run at a time. Keeping the second model
    /// resident buys latency nobody is waiting on with memory the presenter's
    /// machine is using for something else.
    recognizer: resident::Resident<cc_stt::LocalRecognizer>,
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
            recognizer: resident::Resident::new(),
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
            // Nothing usable. Say whether that is because nothing was ever
            // downloaded or because what was downloaded has been damaged:
            // the remedy is the same button, and the second used to abort.
            if let Some(detail) = model_manager::damaged_for(app, entry) {
                return Err(model_damaged(&detail));
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
        let Ok(files) = cc_stt::local::ModelFiles::detect(&dir) else {
            return Err(not_installed());
        };
        files.check_graphs(&dir).map_err(|detail| model_damaged(&detail))?;
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
    ///
    /// A load of this model still in progress is stopped from becoming
    /// resident, for the same reason — it is reading the files being replaced.
    /// Never waits for that load to finish.
    pub fn evict_if_loaded(&self, model_id: &str) {
        self.recognizer.evict(model_id);
    }

    /// Load the requested model if it is not already resident, and hand back a
    /// handle.
    ///
    /// Idempotent and safe to call from a warm-up path as well as from the
    /// start of a take. Asking for a model other than the resident one replaces
    /// it rather than adding to it — see the field docs on `recognizer`.
    ///
    /// BLOCKS for the length of a load, which is over a second, and for any
    /// load already in progress. Call it on a blocking thread, never on an
    /// async worker: the commands go through `tauri::async_runtime::spawn_blocking`.
    pub fn ensure_loaded<R: tauri::Runtime>(
        &self,
        app: &tauri::AppHandle<R>,
        model: &BundledModel,
    ) -> Result<Arc<cc_stt::LocalRecognizer>, AppError> {
        self.recognizer.get_or_load(
            model.id,
            || {
                let dir = Self::model_dir(app, model)?;
                let config = cc_stt::LocalSttConfig::for_model(model, &dir);
                // Checked before the C library is asked, because `create`
                // answers a missing file with a null pointer and no reason at
                // all — and a damaged graph with no answer at all, because
                // onnxruntime throws and the process aborts (#258). And
                // checked while any previous model is still resident, which
                // `get_or_load` documents.
                //
                // The two halves of `LocalSttConfig::validate`, asked
                // separately because they are different faults with different
                // codes. `model_dir` has just resolved this directory, which
                // already asked both; this is the same question again at the
                // last moment before the load, for a file that changed since.
                let files = cc_stt::local::ModelFiles::detect(&dir).map_err(|detail| {
                    AppError::structured(
                        "STT_MODEL_MISSING",
                        ErrorCategory::Internal,
                        format!("The speech model is missing from this installation. {detail}"),
                        false,
                    )
                })?;
                files
                    .check_graphs(&dir)
                    .map_err(|detail| model_damaged(&detail))?;
                Ok((dir, config))
            },
            |(dir, config)| {
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
                Ok(loaded)
            },
        )
    }

    /// Whether a model is resident. Diagnostics and Settings.
    ///
    /// Never waits for a load in progress: a model still loading is not
    /// resident yet.
    pub fn is_loaded(&self) -> bool {
        self.recognizer.loaded_id().is_some()
    }

    /// Which model is resident, if any. Diagnostics and Settings.
    ///
    /// Never waits for a load in progress, which is the point: the status line
    /// and a model deletion both ask, and a load can take five seconds.
    pub fn loaded_model_id(&self) -> Option<&'static str> {
        self.recognizer.loaded_id()
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
    ///
    /// Blocks on a cold start, because it loads the model first: see
    /// [`Self::ensure_loaded`].
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

    /// End whatever session is live, whatever its generation.
    ///
    /// `stop_stream` takes a generation because every ordinary caller has one
    /// and stale generations must not stop a newer take. Shutdown has no
    /// generation and is not racing anything — the process is going away — and
    /// a session left running holds the decoder thread and a microphone the OS
    /// shows as in use until the process is reaped.
    pub fn shutdown(&self) {
        /*
         * A poisoned lock must not abort here.
         *
         * Every other caller `.expect()`s, and that is defensible mid-session:
         * a poisoned recogniser mutex means a decoder thread panicked, and
         * continuing would be pretending the engine is fine. This one runs
         * during shutdown, where the whole point is a BOUNDED exit — panicking
         * inside the close handler of a release build (`panic = "abort"`)
         * turns "quit" into "crash", and the user loses the flush that the
         * handshake was waiting on.
         */
        let mut guard = match self.session.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                tracing::warn!("stt session mutex was poisoned; stopping the session anyway");
                poisoned.into_inner()
            }
        };
        if let Some(session) = guard.take() {
            session.stop();
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
        /*
         * BOTH shapes. Tauri accepts `resources` as a list of paths or as a
         * source→destination map, and the config uses the map form now (the
         * licence notices, which state their own destination names). Reading
         * only the array form turned that into a panic, and a panic here is
         * still a red build — but the day someone "fixes" it by unwrapping to
         * an empty list, the check stops looking at anything.
         *
         * The SOURCE side is what matters: a map entry copying a model
         * directory to an innocuous name is still a model in the bundle.
         */
        let resources = &config["bundle"]["resources"];
        let bundled: Vec<&str> = match resources {
            serde_json::Value::Array(list) => list
                .iter()
                .filter_map(|entry| entry.as_str())
                .map(|entry| entry.trim_end_matches('/'))
                .collect(),
            serde_json::Value::Object(map) => map
                .keys()
                .map(|entry| entry.trim_start_matches("../").trim_end_matches('/'))
                .collect(),
            serde_json::Value::Null => Vec::new(),
            other => panic!("bundle.resources must be a list or a map, got {other:?}"),
        };
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
    /// allowed to be the longer list — it may describe models this build
    /// cannot yet decode with — but not the shorter one.
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
