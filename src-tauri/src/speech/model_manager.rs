//! One place that knows what is happening to a speech model right now.
//!
//! The download itself is in `model_download`; where a model lives and whether
//! it can be trusted is in `model_store`. This is the part that has to exist
//! because both of those are asked about from more than one place at once: the
//! Settings screen polls status, the user presses Download, the Welcome screen
//! is watching, and a take may be running on the very model being replaced.
//!
//! Two rules, and everything else follows from them:
//!
//!   * ONE operation per model. A second Download press joins the running job
//!     rather than starting a second transfer into the same partial file —
//!     which is not a race to be tolerated but the obvious way to corrupt a
//!     download, since both would seek and write the same bytes.
//!   * A model in use is not modified. Deleting the weights out from under a
//!     live take would take the recogniser's files away mid-sentence.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{Emitter as _, Manager as _};

use super::catalogue::{catalogue, ModelEntry};
use super::model_download::{self, CancelFlag, Phase};
use super::model_store::{self as store, ModelSource};
use crate::errors::{AppError, ErrorCategory};
use crate::windows::{events, CONTROL_LABEL};

/// What the control window is told about a model.
///
/// The same shape is returned by every command AND carried by every progress
/// event, deliberately. A UI that gets one shape from a command and a
/// different one from an event has to merge them, and merging is where a
/// progress bar learns to disagree with the button beside it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechModelStatus {
    /// Catalogue id, e.g. `x-asr-480ms`.
    pub model_id: String,
    /// The recogniser's own long name, for diagnostics.
    pub model_name: String,
    pub languages: Vec<String>,
    pub phase: StatusPhase,
    /// Where the usable copy came from, when there is one.
    pub source: Option<ModelSource>,
    /// Whether a take could run on this model right now.
    pub installed: bool,
    /// Whether this build can actually LOAD it. A catalogue entry with no
    /// compiled tuning is downloadable and not yet usable — see
    /// `loadable_model` below.
    pub supported: bool,
    /// Bytes to transfer, from the catalogue.
    pub download_bytes: u64,
    /// Bytes on disk once installed. Much larger than the compressed archive.
    pub installed_bytes: u64,
    pub progress_bytes: u64,
    pub progress_total: u64,
    /// Identifies the run these numbers belong to, so a late event from a
    /// cancelled job can be dropped rather than repainted.
    pub operation_id: Option<String>,
    pub error: Option<StatusError>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StatusPhase {
    NotInstalled,
    Downloading,
    VerifyingArchive,
    Extracting,
    VerifyingFiles,
    Installing,
    Validating,
    Installed,
    Failed,
}

impl From<Phase> for StatusPhase {
    fn from(phase: Phase) -> Self {
        match phase {
            Phase::Downloading => Self::Downloading,
            Phase::VerifyingArchive => Self::VerifyingArchive,
            Phase::Extracting => Self::Extracting,
            Phase::VerifyingFiles => Self::VerifyingFiles,
            Phase::Installing => Self::Installing,
            Phase::Validating => Self::Validating,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusError {
    pub code: String,
    pub message: String,
}

/// A model is being worked on. Downloads and deletions both take one.
struct Operation {
    id: String,
    /// `None` for a deletion, which is synchronous and cannot be stopped.
    cancel: Option<CancelFlag>,
    phase: StatusPhase,
    progress_bytes: u64,
    progress_total: u64,
}

/// Everything the manager knows, under ONE lock.
///
/// These were two mutexes — one for running operations, one for the last
/// failure per model — and every transition had to take both. Between them a
/// finishing job could remove itself, be descheduled, and then clear a failure
/// recorded by the job that started in the gap: the screen would show "not
/// installed" for a download that had just failed. Two locks around one
/// invariant is an invitation for the halves to disagree, so there is one.
#[derive(Default)]
struct ManagerState {
    operations: HashMap<String, Operation>,
    /// The last failure per model, so a screen opened after a download failed
    /// can still say why rather than showing a bare "not installed".
    failures: HashMap<String, StatusError>,
}

/// Managed state. One per app.
#[derive(Default)]
pub struct SpeechModelManager {
    state: Mutex<ManagerState>,
}

/// The catalogue entry for an id off the IPC boundary.
///
/// Every path this module builds is derived from a resolved entry, never from
/// the caller's string: `install_path` joins `install_dir`, which the
/// catalogue tests pin to a single safe segment. An unknown id is refused here
/// and therefore cannot reach the filesystem at all.
pub fn entry_for(model_id: &str) -> Result<&'static ModelEntry, AppError> {
    catalogue().get(model_id).ok_or_else(|| {
        AppError::structured(
            "STT_MODEL_UNKNOWN",
            ErrorCategory::Validation,
            "That speech model is not one this version of CandidCue knows about.",
            false,
        )
        .with_log(format!("unknown model id {model_id:?}"))
    })
}

/// The compiled recogniser profile for a catalogue entry, if this build has
/// one.
///
/// The catalogue lists every model that can be DOWNLOADED; `cc_stt::models`
/// lists the ones this build knows how to decode with, because tuning is
/// measured rather than discovered. The catalogue is deliberately the longer
/// list, so an entry with no profile is honestly reported as unsupported
/// rather than offered and then failing at the top of a take.
pub fn loadable_model(entry: &ModelEntry) -> Option<&'static cc_stt::models::BundledModel> {
    cc_stt::models::model_by_id(&entry.model_name)
}

impl SpeechModelManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Status for one model, as things stand.
    pub fn status<R: tauri::Runtime>(
        &self,
        app: &tauri::AppHandle<R>,
        entry: &ModelEntry,
    ) -> SpeechModelStatus {
        // One read of both halves, so the phase and the failure cannot come
        // from either side of a transition.
        let (running, failure) = {
            let state = self.state.lock().expect("model state poisoned");
            (
                state.operations.get(&entry.id).map(|op| {
                    (op.id.clone(), op.phase, op.progress_bytes, op.progress_total)
                }),
                state.failures.get(&entry.id).cloned(),
            )
        };

        let resolved = resolve_for(app, entry);

        let (phase, operation_id, progress_bytes, progress_total) = match running {
            Some((id, phase, done, total)) => (phase, Some(id), done, total),
            None if resolved.is_some() => (StatusPhase::Installed, None, 0, 0),
            None if failure.is_some() => (StatusPhase::Failed, None, 0, 0),
            None => (StatusPhase::NotInstalled, None, 0, 0),
        };

        SpeechModelStatus {
            model_id: entry.id.clone(),
            model_name: entry.model_name.clone(),
            languages: entry.languages.clone(),
            phase,
            source: resolved.as_ref().map(|found| found.source),
            installed: resolved.is_some(),
            supported: loadable_model(entry).is_some(),
            download_bytes: entry.archive.bytes,
            installed_bytes: entry.installed_bytes(),
            progress_bytes,
            progress_total,
            operation_id,
            // A failure that has since been superseded by a working install is
            // not news. Only reported while the model is actually unusable.
            error: failure.filter(|_| resolved.is_none()),
        }
    }

    /// Begin a download, or join the one already running.
    ///
    /// Returns immediately with the status the caller should paint; the work
    /// continues on the async runtime and reports through
    /// [`events::SPEECH_MODEL_PROGRESS`].
    pub fn start<R: tauri::Runtime>(
        &self,
        app: &tauri::AppHandle<R>,
        entry: &'static ModelEntry,
    ) -> Result<SpeechModelStatus, AppError> {
        if loadable_model(entry).is_none() {
            return Err(AppError::structured(
                "STT_MODEL_UNSUPPORTED",
                ErrorCategory::Validation,
                "This version of CandidCue cannot run that model yet.",
                false,
            ));
        }

        let cancel = {
            let mut state = self.state.lock().expect("model state poisoned");
            if state.operations.contains_key(&entry.id) {
                // Already running. Joining is the honest answer to a second
                // press — a second transfer into the same partial file would
                // interleave writes and corrupt it.
                //
                // The guard is dropped before `status`, which re-locks: this
                // mutex is not reentrant and holding it here would deadlock.
                drop(state);
                return Ok(self.status(app, entry));
            }
            let cancel = CancelFlag::new();
            state.operations.insert(
                entry.id.clone(),
                Operation {
                    id: uuid::Uuid::new_v4().to_string(),
                    cancel: Some(cancel.clone()),
                    phase: StatusPhase::Downloading,
                    progress_bytes: 0,
                    progress_total: entry.archive.bytes,
                },
            );
            // Claimed and cleared under the SAME guard as the check above, so
            // a second press cannot land between them.
            state.failures.remove(&entry.id);
            cancel
        };

        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            run_install(handle, entry, cancel).await;
        });
        Ok(self.status(app, entry))
    }

    /// Ask a running download to stop.
    ///
    /// The partial is kept: stopping is usually "not now", not "never", and
    /// throwing away 100 MB the user may resume in a minute is not what they
    /// asked for. Delete is the button that discards it.
    pub fn cancel<R: tauri::Runtime>(
        &self,
        app: &tauri::AppHandle<R>,
        entry: &ModelEntry,
    ) -> SpeechModelStatus {
        {
            let state = self.state.lock().expect("model state poisoned");
            if let Some(op) = state.operations.get(&entry.id) {
                // `None` for a deletion, which is synchronous and has nothing
                // to interrupt.
                if let Some(cancel) = &op.cancel {
                    cancel.cancel();
                }
            }
        }
        self.status(app, entry)
    }

    /// Remove a downloaded model from app data.
    pub fn delete<R: tauri::Runtime>(
        &self,
        app: &tauri::AppHandle<R>,
        entry: &ModelEntry,
    ) -> Result<SpeechModelStatus, AppError> {
        // A take holding this recogniser is reading these files. Removing them
        // mid-sentence is the one outcome a presenter cannot recover from.
        //
        // Checked BEFORE the claim below so a refusal leaves no operation
        // behind. It remains a check against a moving target — a take can
        // start immediately afterwards — but `ensure_loaded` validates the
        // directory before every load, so the worst case is a take that fails
        // to arm rather than one that dies mid-sentence.
        let speech = app.state::<super::SpeechEngine>();
        if speech.active_generation().is_some()
            && loadable_model(entry).is_some_and(|m| speech.loaded_model_id() == Some(m.id))
        {
            return Err(busy(
                "This model is in use by a take that is running.",
                "a session is live on this model",
            ));
        }

        // Claim the model, rather than merely observing that nobody else has.
        // The check and the claim under one guard is what stops a Download
        // press landing in the gap and having its partial deleted out from
        // under it — the reason a deletion is an operation at all.
        {
            let mut state = self.state.lock().expect("model state poisoned");
            if state.operations.contains_key(&entry.id) {
                return Err(busy(
                    "Stop the download before removing this model.",
                    "an install is running",
                ));
            }
            state.operations.insert(
                entry.id.clone(),
                Operation {
                    id: uuid::Uuid::new_v4().to_string(),
                    cancel: None,
                    phase: StatusPhase::Installing,
                    progress_bytes: 0,
                    progress_total: 0,
                },
            );
        }

        let outcome = (|| -> Result<(), AppError> {
            let data_dir = app_data_dir(app)?;
            store::delete_downloaded(&data_dir, entry)
                .map_err(|e| AppError::Internal(format!("could not remove the model: {e}")))
        })();

        // Released however the delete went; a failed removal must not leave
        // the model permanently claimed.
        {
            let mut state = self.state.lock().expect("model state poisoned");
            state.operations.remove(&entry.id);
            state.failures.remove(&entry.id);
        }
        outcome?;

        // The resident recogniser was loaded from files that are now gone.
        // Evicting is what makes the next take reload from whatever `resolve`
        // finds instead of holding a handle to a deleted directory.
        if let Some(model) = loadable_model(entry) {
            speech.evict_if_loaded(model.id);
        }
        Ok(self.status(app, entry))
    }

    fn record_progress(&self, model_id: &str, phase: StatusPhase, done: u64, total: u64) {
        let mut state = self.state.lock().expect("model state poisoned");
        if let Some(op) = state.operations.get_mut(model_id) {
            op.phase = phase;
            op.progress_bytes = done;
            op.progress_total = total;
        }
    }

    /// Retire an operation, recording how it ended.
    ///
    /// `operation_id` is checked: a task only ever retires ITSELF. Without it a
    /// finishing job could clear a failure belonging to the job that started
    /// after it — the screen would show "not installed" for a download that
    /// had just failed for a reason nobody was told.
    fn finish(&self, model_id: &str, operation_id: &str, error: Option<StatusError>) {
        let mut state = self.state.lock().expect("model state poisoned");
        let owns = state
            .operations
            .get(model_id)
            .is_some_and(|op| op.id == operation_id);
        if !owns {
            return;
        }
        state.operations.remove(model_id);
        match error {
            Some(error) => {
                state.failures.insert(model_id.to_string(), error);
            }
            None => {
                state.failures.remove(model_id);
            }
        }
    }

    /// The id of the operation currently running for this model.
    fn operation_id(&self, model_id: &str) -> Option<String> {
        self.state
            .lock()
            .expect("model state poisoned")
            .operations
            .get(model_id)
            .map(|op| op.id.clone())
    }
}

/// The user-facing half of an error, never the log half.
///
/// `AppError`'s `Display` is `"{code}: {log_message}"`, and `log_message` is
/// documented as never crossing IPC — it carries request detail, digests and
/// filesystem paths. Putting `to_string()` into a status the Settings panel
/// renders verbatim published exactly what that field exists to keep private.
/// `to_payload()` is the same redaction the IPC boundary already applies.
fn status_error(err: &AppError) -> StatusError {
    let payload = err.to_payload();
    StatusError {
        code: payload.code,
        message: payload.user_message,
    }
}

fn busy(message: &str, log: &str) -> AppError {
    AppError::structured("STT_MODEL_BUSY", ErrorCategory::Validation, message, true)
        .with_log(log.to_string())
}

fn app_data_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, AppError> {
    app.path()
        .app_data_dir()
        .map_err(|e| AppError::Internal(format!("no app data directory: {e}")))
}

/// Where this model is, if anywhere.
///
/// The one place that knows the bundled fallback's path, because only Tauri's
/// resolver can turn a resource-relative directory into a real one and the
/// answer differs between `tauri dev`, a `.app`, an MSI and a Linux package.
pub fn resolve_for<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    entry: &ModelEntry,
) -> Option<store::ResolvedModel> {
    let data_dir = app.path().app_data_dir().ok()?;
    // Stock builds bundle nothing, so this resolving to a path that does not
    // exist is the NORMAL case, not an error worth reporting. `store::resolve`
    // shape-checks whatever it is handed.
    let resource = app
        .path()
        .resolve(&entry.resource_dir(), tauri::path::BaseDirectory::Resource)
        .ok();
    store::resolve(&data_dir, resource.as_deref(), entry)
}

/// The install task: run it, report every step, and always leave the manager
/// with no operation for this model when it ends.
async fn run_install<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    entry: &'static ModelEntry,
    cancel: CancelFlag,
) {
    // Whose operation this is. Every state change below names it, so a task
    // that has already been superseded cannot retire its successor.
    let Some(operation_id) = app.state::<SpeechModelManager>().operation_id(&entry.id) else {
        return;
    };

    let data_dir = match app_data_dir(&app) {
        Ok(dir) => dir,
        Err(err) => {
            app.state::<SpeechModelManager>().finish(
                &entry.id,
                &operation_id,
                Some(status_error(&err)),
            );
            emit_status(&app, entry);
            return;
        }
    };

    let progress = {
        let app = app.clone();
        move |phase: Phase, done: u64, total: u64| {
            let manager = app.state::<SpeechModelManager>();
            manager.record_progress(&entry.id, phase.into(), done, total);
            emit_status(&app, entry);
        }
    };

    let outcome = model_download::install(
        &data_dir,
        catalogue(),
        entry,
        &crate::net::HopPolicy::strict(model_download::MODEL_HOP_LABELS),
        &cancel,
        &progress,
    )
    .await;

    let error = match outcome {
        Ok(dir) => {
            tracing::info!(
                model = %entry.id,
                dir = %dir.display(),
                "installed speech model"
            );
            // The recogniser resident in memory, if any, was loaded from a
            // different directory. Evicting makes the next take pick up what
            // was just installed rather than keeping the old handle.
            if let Some(model) = loadable_model(entry) {
                app.state::<super::SpeechEngine>().evict_if_loaded(model.id);
            }
            None
        }
        // A cancellation is not a failure and must not be shown as one. The
        // partial survives, so the model goes back to "not installed" with a
        // resume available rather than to an error.
        Err(err) if model_download::is_cancelled_error(&err) => {
            tracing::info!(model = %entry.id, "speech model download stopped");
            None
        }
        Err(err) => {
            // The full detail goes to the log, where it belongs; only the
            // redacted half reaches the screen.
            tracing::warn!(model = %entry.id, error = %err, "speech model install failed");
            Some(status_error(&err))
        }
    };

    app.state::<SpeechModelManager>().finish(&entry.id, &operation_id, error);
    emit_status(&app, entry);
}

/// Publish the current status to the control window.
///
/// Control only. The stage window holds no invoke permission and has nothing to
/// do with model management; broadcasting there would be handing a screen that
/// is showing a script an event it has no listener for.
fn emit_status<R: tauri::Runtime>(app: &tauri::AppHandle<R>, entry: &ModelEntry) {
    let status = app.state::<SpeechModelManager>().status(app, entry);
    let _ = app.emit_to(CONTROL_LABEL, events::SPEECH_MODEL_PROGRESS, status);
}
