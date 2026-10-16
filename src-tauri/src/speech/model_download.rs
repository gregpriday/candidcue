//! Fetching a speech model, verifying it, and putting it where it belongs.
//!
//! ---------------------------------------------------------------------------
//! THE ORDER IS THE DESIGN
//! ---------------------------------------------------------------------------
//! Bytes arrive → the whole archive is hashed → members are extracted to a
//! staging directory → EVERY extracted file is hashed → the staged directory is
//! proven loadable → only then is anything moved into the model's real home,
//! and only then is the seal written.
//!
//! Each of those boundaries exists because of a specific way this can go wrong:
//!
//!   * Hashing the archive BEFORE unpacking means a corrupt or substituted
//!     transfer never reaches a decompressor at all.
//!   * Extracting only the members the catalogue names means a bundle's test
//!     WAVs, export scripts, symlinks and absolute paths never touch the disk.
//!     The digest already proves these are the pinned bytes; "the archive we
//!     pinned" and "an archive safe to unpack whole" are different claims.
//!   * Verifying every file before moving ANY of them is what
//!     `scripts/fetch-stt-model.sh` learned the hard way: verify-and-move in
//!     one pass lets a mismatch on the last file leave a new encoder beside an
//!     old decoder — a mixed model that still has every filename
//!     `ModelFiles::detect` looks for, and which fails at the top of a take.
//!   * Installing a whole DIRECTORY with one rename, rather than file by file,
//!     is that same guarantee one level up. There is no instant at which the
//!     model directory holds a partial set.
//!
//! ---------------------------------------------------------------------------
//! RESUMING
//! ---------------------------------------------------------------------------
//! 128 MB on a domestic connection is minutes, and a presenter who closes the
//! laptop should not start again from zero. The partial is kept with a sidecar
//! naming the archive digest it is a prefix of, plus whatever validator the
//! origin gave us.
//!
//! `Range` alone is not enough for that. Upstream is a GitHub release tag,
//! which is MUTABLE: an asset can be replaced under the same URL, and a range
//! request against the new bytes would append them to a prefix of the old ones
//! and produce a file that is neither. `If-Range` is what makes that safe — the
//! origin restarts the transfer from zero instead of honouring the range when
//! the validator no longer matches. The archive digest catches it either way;
//! the point of `If-Range` is to catch it before spending the bandwidth.
//!
//! What survives a failure depends on WHAT failed, not on the fact that
//! something did. A transfer that merely stopped — a dropped connection, a
//! closed lid, the idle timeout, a request that never connected — has judged
//! none of its bytes, so the partial and its sidecar are kept. Bytes that
//! failed the digest, overran the catalogue, or that the origin refuses to
//! continue are discarded, because resuming into them would fail the same way
//! forever. `FetchFailure` is where each failure says which it is.
//!
//! Extraction is never resumed, only downloads. A half-extracted staging
//! directory is cheap to redo and expensive to reason about.

use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

use reqwest::header::{
    ACCEPT_RANGES, CONTENT_RANGE, ETAG, IF_RANGE, LAST_MODIFIED, LOCATION, RANGE,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use super::catalogue::{Catalogue, ModelEntry};
use super::model_store as store;
use crate::errors::{AppError, ErrorCategory};
use crate::net::{self, Deadline, HopPolicy};

/// The codes the MODEL path reports a refused url under.
///
/// A host that cannot be reached is a download failure, not a refusal: it is
/// what Settings › Speech shows a machine with no network, so its copy says
/// what will fix it. The code is [`download_failed`]'s, so it reads the same as
/// a connection dropped mid-transfer.
pub const MODEL_HOP_LABELS: net::HopLabels = net::HopLabels {
    insecure_code: "STT_MODEL_URL_INSECURE",
    insecure_message: "Speech models can only be downloaded over https.",
    blocked_code: "STT_MODEL_URL_BLOCKED",
    blocked_message: "That model address is not publicly reachable and was refused.",
    unreachable_code: "STT_MODEL_DOWNLOAD_FAILED",
    unreachable_message:
        "The speech model could not be downloaded. Check your connection and try again.",
};

/// How long a transfer may sit with NO bytes arriving before it is abandoned.
///
/// An idle bound rather than a total one. A total deadline would abort a
/// healthy download for being slow, which on a 128 MB archive is a normal
/// property of a domestic connection rather than a fault.
const IDLE_TIMEOUT: Duration = Duration::from_secs(30);

/// Progress is reported at most this often, so a 128 MB transfer does not
/// emit an IPC message per 8 KB chunk.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(150);

/// Where a model install has got to.
///
/// Reported verbatim to the UI, because "downloading" reaching 100% and then
/// appearing to hang for the length of a bz2 decompression is the single most
/// confusing thing this process can do. Verification and extraction are
/// genuinely slow and are named.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Downloading,
    VerifyingArchive,
    Extracting,
    VerifyingFiles,
    Installing,
    Validating,
}

/// Cooperative cancellation.
///
/// A `watch` channel rather than a `CancellationToken`: `tokio-util` is not in
/// this tree. It used to be a bare flag, read once per chunk — and a stalled
/// origin never delivers the next chunk, so Stop waited out the whole
/// `IDLE_TIMEOUT` and then surfaced as a download failure. The channel keeps
/// the synchronous read the blocking phases poll, and adds a wait the network
/// awaits can race (see `race`).
///
/// Clones share one channel, so the manager's copy stops the task's.
#[derive(Debug, Clone, Default)]
pub struct CancelFlag(tokio::sync::watch::Sender<bool>);

impl CancelFlag {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn cancel(&self) {
        // `send_replace`, not `send`: `send` stores nothing when no receiver
        // exists, and nothing is subscribed between two network waits — a
        // Stop pressed then would be lost.
        self.0.send_replace(true);
    }
    pub fn is_cancelled(&self) -> bool {
        *self.0.borrow()
    }
    fn check(&self) -> Result<(), AppError> {
        if self.is_cancelled() {
            Err(cancelled())
        } else {
            Ok(())
        }
    }

    /// Resolves once `cancel` has been called, at once if it already has.
    async fn cancelled_wait(&self) {
        // `wait_for` tests the current value before it waits, so a Stop that
        // landed before this subscribed is seen rather than missed. The
        // channel cannot close while `self` holds its sender, and the borrow
        // it returns is dropped here rather than held.
        let mut receiver = self.0.subscribe();
        let _ = receiver.wait_for(|cancelled| *cancelled).await;
    }

    /// Run one network wait, unless Stop is pressed first.
    ///
    /// Only ever a wait: the work is dropped where it stands when Stop wins,
    /// so it must not be holding anything half-done. A pending request or
    /// chunk read qualifies — dropping it closes the connection and nothing
    /// on disk moves. A file write would not, and is never raced.
    async fn race<T>(&self, work: impl std::future::Future<Output = T>) -> Result<T, AppError> {
        tokio::select! {
            // Stop first, so a cancel already made beats work that happens to
            // be ready on the same poll.
            biased;
            () = self.cancelled_wait() => Err(cancelled()),
            out = work => Ok(out),
        }
    }
}

/// What the caller is told as the install proceeds.
pub type ProgressFn = dyn Fn(Phase, u64, u64) + Send + Sync;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Not a failure. Distinguished so the UI can return to "paused" rather than
/// showing the user an error for something they asked for.
pub fn cancelled() -> AppError {
    AppError::structured(
        "STT_MODEL_CANCELLED",
        ErrorCategory::Internal,
        "The model download was stopped.",
        true,
    )
}

pub fn is_cancelled_error(err: &AppError) -> bool {
    err.code() == "STT_MODEL_CANCELLED"
}

fn download_failed(reason: impl Into<String>) -> AppError {
    AppError::structured(
        "STT_MODEL_DOWNLOAD_FAILED",
        ErrorCategory::Network,
        "The speech model could not be downloaded.",
        true,
    )
    .with_log(reason.into())
}

/// The bytes are not the bytes the catalogue pinned.
///
/// Retryable, and worth saying why: the overwhelmingly likely cause is a
/// proxy-mangled transfer or a replaced upstream asset, not an attack, and the
/// honest response to that is to offer another go rather than to accuse
/// anyone. A transfer that merely stopped short is NOT this — see
/// `FetchFailure::Interrupted`.
fn integrity_failed(reason: impl Into<String>) -> AppError {
    AppError::structured(
        "STT_MODEL_CORRUPT",
        ErrorCategory::Media,
        "The downloaded speech model did not match its published checksum and was discarded.",
        true,
    )
    .with_log(reason.into())
}

fn install_failed(reason: impl Into<String>) -> AppError {
    AppError::structured(
        "STT_MODEL_INSTALL_FAILED",
        ErrorCategory::Internal,
        "The speech model could not be installed. Check there is enough free disk space.",
        true,
    )
    .with_log(reason.into())
}

/// Why a candidate url failed, and therefore what to do with the file it left.
///
/// The error a user sees and the fate of the bytes on disk are separate
/// questions. "The connection dropped" and "the bytes were wrong" can both
/// surface from the same transfer, and only the second is a reason to throw
/// away what arrived — discarding on the first is what sent every closed laptop
/// lid back to byte zero. Carried as a type rather than read back out of the
/// error so that keeping a partial is something a failure has to SAY, not
/// something inferred from a message.
enum FetchFailure {
    /// Nothing judged the bytes on disk. The transfer stopped, or never
    /// started, so the file is still an unverified prefix of the archive and
    /// its sidecar still describes it. Both are kept for the next run.
    Interrupted(AppError),
    /// The file is known to be unusable — it failed its digest, overran the
    /// catalogue, is the wrong file, or the origin refused to continue it — or
    /// it could not be written safely. Resuming into it would fail the same
    /// way every time, so it is discarded.
    Rejected(AppError),
}

impl FetchFailure {
    fn error(&self) -> &AppError {
        match self {
            Self::Interrupted(err) | Self::Rejected(err) => err,
        }
    }

    fn into_error(self) -> AppError {
        match self {
            Self::Interrupted(err) | Self::Rejected(err) => err,
        }
    }
}

// ---------------------------------------------------------------------------
// Where to fetch from
// ---------------------------------------------------------------------------

/// Mirror first, then upstream — both hash-checked identically.
///
/// The mirror is content-addressed (`/sha256/<digest>/<file>`), so one URL can
/// only ever name one set of bytes. It buys AVAILABILITY, not integrity: the
/// digest already provides that, and upstream's `asr-models` tag is mutable, so
/// an asset can be replaced or dropped out from under a build.
pub fn archive_urls(catalogue: &Catalogue, model: &ModelEntry) -> Vec<String> {
    let mut urls = Vec::new();
    if let Some(base) = &catalogue.mirror_base_url {
        urls.push(format!(
            "{}/sha256/{}/{}",
            base.trim_end_matches('/'),
            model.archive.sha256,
            model.archive.file_name
        ));
    }
    urls.push(model.archive.upstream_url.clone());
    urls
}

// ---------------------------------------------------------------------------
// Resume metadata
// ---------------------------------------------------------------------------

/// What a partial download is a prefix OF.
///
/// The partial's own length is authoritative for "how far did we get" — this
/// records only what cannot be recovered by looking at the file: which archive
/// it belongs to, and the validator the origin gave us for it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResumeState {
    version: u32,
    model_id: String,
    /// The digest the completed file must have. A catalogue that moves to a
    /// new archive makes every existing partial irrelevant, and this is how
    /// that is noticed rather than discovered after a wasted transfer.
    archive_sha256: String,
    url: String,
    etag: Option<String>,
    last_modified: Option<String>,
}

const RESUME_VERSION: u32 = 1;

impl ResumeState {
    /// Is this sidecar about the archive we are being asked for now?
    fn matches(&self, model: &ModelEntry, url: &str) -> bool {
        self.version == RESUME_VERSION
            && self.model_id == model.id
            && self.archive_sha256 == model.archive.sha256
            && self.url == url
    }

    /// The `If-Range` value, if the origin gave us one to use.
    ///
    /// A strong ETag is preferred; `Last-Modified` is the fallback. With
    /// neither there is nothing to make a range request safe against a
    /// replaced asset, and the caller starts from zero instead.
    fn validator(&self) -> Option<&str> {
        self.etag
            .as_deref()
            .filter(|tag| !tag.starts_with("W/"))
            .or(self.last_modified.as_deref())
    }
}

fn read_resume(path: &Path) -> Option<ResumeState> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// Written through a temporary sibling: a torn sidecar must read as "no
/// sidecar", which costs one restarted download, rather than as a lie about
/// which archive the partial belongs to.
fn write_resume(path: &Path, state: &ResumeState) -> std::io::Result<()> {
    let temp = path.with_extension("json.part");
    std::fs::write(&temp, serde_json::to_vec(state)?)?;
    std::fs::rename(&temp, path)
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

/// A validated response body, mid-transfer.
struct Transfer {
    response: reqwest::Response,
    /// Byte offset this body starts at. Non-zero only for an honoured range.
    start: u64,
    etag: Option<String>,
    last_modified: Option<String>,
    accepts_ranges: bool,
}

/// Follow redirects by hand, revalidating each hop, and open the body.
///
/// `from` is where we would like to resume; the returned `Transfer.start` says
/// where the origin actually started, which is the only one that counts.
///
/// Failing to open is `Interrupted` — no byte on disk has been looked at —
/// EXCEPT when the origin refuses or mangles a RANGE request. That answer is
/// about the partial, and it comes back identically on every retry for as long
/// as the partial exists, so keeping it would turn one bad answer into a
/// download that can never finish. A request that asked for no range says
/// nothing about whatever is on disk — which may be another url's prefix,
/// left for that url to resume — so its failures never cost it.
async fn open_transfer(
    url: &str,
    from: u64,
    validator: Option<&str>,
    policy: &HopPolicy,
) -> Result<Transfer, FetchFailure> {
    let interrupted = |reason: String| FetchFailure::Interrupted(download_failed(reason));
    let rejected = |reason: String| FetchFailure::Rejected(download_failed(reason));

    let mut current = reqwest::Url::parse(url)
        .map_err(|_| interrupted(format!("model url is not valid: {url}")))?;

    for _ in 0..=net::MAX_REDIRECTS {
        let hop = net::check_hop(&current, policy)
            .await
            .map_err(FetchFailure::Interrupted)?;
        let client = net::client_for(&hop, Deadline::Idle(IDLE_TIMEOUT))
            .map_err(FetchFailure::Interrupted)?;
        let mut request = client.get(hop.url.clone());
        // A range is only ever asked for WITH a validator. Without one there is
        // nothing to stop a replaced asset being appended to a prefix of the
        // old one, and the resulting file would be neither.
        let mut asked_for_range = false;
        if from > 0 {
            if let Some(validator) = validator {
                request = request
                    .header(RANGE, format!("bytes={from}-"))
                    .header(IF_RANGE, validator);
                asked_for_range = true;
            }
        }
        let response = request
            .send()
            .await
            .map_err(|e| interrupted(format!("request failed: {e}")))?;

        let status = response.status();
        if status.is_redirection() {
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| interrupted(format!("{status} with no Location")))?
                .to_string();
            current = current.join(&location).map_err(|_| {
                FetchFailure::Interrupted(net::blocked_url(
                    &MODEL_HOP_LABELS,
                    format!("unusable redirect target {location:?}"),
                ))
            })?;
            continue;
        }

        let header = |name: reqwest::header::HeaderName| {
            response
                .headers()
                .get(&name)
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string())
        };
        let accepts_ranges = response
            .headers()
            .get(ACCEPT_RANGES)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.split(',').any(|token| token.trim() == "bytes"));
        let etag = header(ETAG);
        let last_modified = header(LAST_MODIFIED);

        // 206 means the range was honoured. Anything else that succeeds is a
        // whole body, which is the origin telling us to start again — either it
        // ignores ranges or the validator no longer matches.
        let start = if status == reqwest::StatusCode::PARTIAL_CONTENT {
            // A 206 we did not ask for is not a gift. Honouring it would seek
            // to an offset chosen by the origin and write the tail of some
            // representation into a file we believe starts elsewhere.
            if !asked_for_range {
                return Err(interrupted("origin sent 206 to a request with no Range".to_string()));
            }
            let range = response
                .headers()
                .get(CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| rejected("206 with no Content-Range".to_string()))?;
            let offset = parse_content_range_start(range)
                .ok_or_else(|| rejected(format!("unusable Content-Range {range:?}")))?;
            if offset != from {
                return Err(rejected(format!(
                    "asked to resume at {from}, origin answered at {offset}"
                )));
            }
            offset
        } else if status.is_success() {
            0
        } else if asked_for_range
            && status.is_client_error()
            && status != reqwest::StatusCode::REQUEST_TIMEOUT
            && status != reqwest::StatusCode::TOO_MANY_REQUESTS
        {
            // The origin refused THIS request, and the range is what makes it
            // different from a fresh one. A 416 is the plain case: a range is
            // only ever sent with `If-Range`, and a validator that no longer
            // matched would have earned a whole 200, so this is the same asset
            // and it ends before our partial does. A CDN that forbids ranges
            // outright is the other. Either way asking again gets the same
            // answer, and only dropping the partial lets the next run ask
            // without one. Timeouts and rate limits are about the moment, not
            // the request, and are left to retry.
            return Err(rejected(format!("origin refused to resume at {from}: {status}")));
        } else {
            return Err(interrupted(format!("status {status}")));
        };

        return Ok(Transfer {
            response,
            start,
            etag,
            last_modified,
            accepts_ranges,
        });
    }
    Err(FetchFailure::Interrupted(net::blocked_url(
        &MODEL_HOP_LABELS,
        "too many redirects",
    )))
}

/// Make a failed download unusable, by deletion or failing that by truncation.
///
/// Truncation is the fallback rather than the first choice because an empty
/// file is still clutter — but it is enough: a zero-length archive matches
/// neither the complete-archive shortcut nor a resumable prefix, so the next
/// attempt starts cleanly instead of re-hashing bytes already known to be bad.
fn discard_archive(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => std::fs::File::create(path).map(|_| ()),
    }
}

/// The first byte offset named by a `Content-Range: bytes <start>-<end>/<len>`.
fn parse_content_range_start(value: &str) -> Option<u64> {
    let rest = value.trim().strip_prefix("bytes ")?;
    let range = rest.split('/').next()?;
    range.split('-').next()?.trim().parse().ok()
}

/// Fetch the archive to `target`, resuming when that is possible and safe.
///
/// Returns once the file on disk is exactly the length the catalogue promises.
/// It is NOT hashed here — that is a separate, named phase, because hashing
/// 128 MB takes long enough that a progress bar sitting at 100% during it is
/// the confusing failure this split exists to avoid.
///
/// Every failure says whether the file it leaves is still worth resuming; see
/// [`FetchFailure`].
async fn fetch_archive(
    url: &str,
    model: &ModelEntry,
    target: &Path,
    resume_path: &Path,
    policy: &HopPolicy,
    cancel: &CancelFlag,
    on_progress: &ProgressFn,
) -> Result<(), FetchFailure> {
    let expected = model.archive.bytes;
    let on_disk = std::fs::metadata(target).map(|m| m.len()).unwrap_or(0);

    // Already the full length: nothing to fetch. The caller hashes it next and
    // discards it if it is wrong, so this cannot install unverified bytes.
    //
    // Without this, every retry after a completed transfer re-downloaded the
    // whole archive: cancelling during verification or extraction, running out
    // of disk while unpacking, or crashing before the seal all leave exactly
    // this state, and `on_disk < expected` sent each of them back to the
    // network for 128 MB that was already sitting there.
    if on_disk == expected {
        on_progress(Phase::Downloading, expected, expected);
        return Ok(());
    }

    // Resume only when the sidecar agrees this partial belongs to this archive
    // at this url, AND the origin gave us a validator to make the range safe.
    //
    // No validator means no way to notice that the asset was replaced between
    // the two requests, and appending the tail of new bytes to a prefix of old
    // ones produces a file that is neither. Starting again costs bandwidth;
    // getting this wrong costs a download that can never succeed.
    let resume = read_resume(resume_path).filter(|state| state.matches(model, url));
    let (mut from, validator) = match (&resume, on_disk) {
        (Some(state), len) if len > 0 && len < expected => match state.validator() {
            Some(validator) => (len, Some(validator.to_string())),
            None => (0, None),
        },
        _ => (0, None),
    };

    // A partial we cannot resume is NOT deleted here. It is replaced only once
    // a replacement transfer has actually been accepted (the truncating open
    // below), because until then it is the most anyone has: with a mirror and
    // upstream both configured, the mirror can drop mid-transfer and leave a
    // resumable prefix, and upstream — whose url that prefix does not match —
    // can then fail to connect for the same reason the mirror dropped.
    // Deleting first would lose the prefix to a request that never started.
    //
    // Raced as a whole, because every await in it can sit on a dead network
    // for its own timeout: the DNS lookup, the connect, and the wait for
    // headers, once per redirect hop. A Stop here is `Interrupted` like any
    // other request that never got going, so the partial survives it.
    let transfer = cancel
        .race(open_transfer(url, from, validator.as_deref(), policy))
        .await
        .map_err(FetchFailure::Interrupted)??;
    // The open below can truncate the partial. A Stop that landed just as the
    // headers did must not cost it for a transfer that is not going to run.
    cancel.check().map_err(FetchFailure::Interrupted)?;
    if transfer.start == 0 {
        // The origin restarted us: it ignores ranges, or the asset changed
        // under `If-Range`. Either way the bytes on disk are not a prefix of
        // what is arriving.
        from = 0;
    }

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(from == 0)
        .open(target)
        .map_err(|e| {
            FetchFailure::Rejected(install_failed(format!(
                "could not open {}: {e}",
                target.display()
            )))
        })?;
    if from > 0 {
        use std::io::Seek as _;
        file.seek(std::io::SeekFrom::Start(from)).map_err(|e| {
            FetchFailure::Rejected(install_failed(format!(
                "could not seek the partial download: {e}"
            )))
        })?;
    }

    // Record what would let a LATER run resume this one, before spending the
    // transfer rather than after — a crash mid-download is exactly the case
    // this is for. After the open rather than before it, so a sidecar naming
    // this url never sits beside bytes that came from somewhere else.
    //
    // An honoured range is proof of range support in its own right.
    // `Accept-Ranges` is advisory and a 206 may omit it; trusting only the
    // header would strip the validator from a resumed transfer, and a second
    // drop would then start again from zero.
    let resumable = transfer.accepts_ranges || transfer.start > 0;
    let state = ResumeState {
        version: RESUME_VERSION,
        model_id: model.id.clone(),
        archive_sha256: model.archive.sha256.clone(),
        url: url.to_string(),
        etag: transfer.etag.clone().filter(|_| resumable),
        last_modified: transfer.last_modified.clone().filter(|_| resumable),
    };
    if write_resume(resume_path, &state).is_err() {
        // Failing to record this transfer is survivable; leaving the PREVIOUS
        // sidecar in place is not. It names another url's validator, and now
        // that a dropped transfer is kept, a later run would resume these
        // bytes against that url. No sidecar costs one restart instead — and
        // if even that cannot be arranged, nothing written from here on could
        // be trusted to resume, so the transfer does not start.
        match std::fs::remove_file(resume_path) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => {
                return Err(FetchFailure::Rejected(install_failed(format!(
                    "could not replace the resume sidecar: {err}"
                ))))
            }
        }
    }

    let mut written = from;
    let mut response = transfer.response;
    // Whether the response said how long it is. Read before the body is
    // consumed, and used only to explain a short ending — never to size
    // anything (see the per-chunk ceiling below).
    let framed = response.content_length().is_some();
    let mut last_report = std::time::Instant::now();
    on_progress(Phase::Downloading, written, expected);
    loop {
        let chunk = match cancel.race(response.chunk()).await {
            // Stopped — and not only between chunks. A stalled origin never
            // sends the next one, and a Stop that waited for it waited out the
            // whole IDLE_TIMEOUT and was then reported as a failed download.
            // Kept and flushed exactly as a dropped connection is below.
            Err(stopped) => return Err(keep_partial(file, stopped)),
            Ok(Ok(chunk)) => chunk,
            // The connection dropped, the laptop slept, or nothing arrived for
            // IDLE_TIMEOUT. Every byte written so far is a byte the origin sent
            // in order, and nothing has judged any of them — so they are kept
            // for the next run to resume, rather than thrown away for having
            // stopped. A torn tail after a power cut is still caught: the
            // archive digest covers the resumed file as a whole.
            //
            // Unless every byte the catalogue promises has already arrived.
            // That file is not a prefix of anything; it is a candidate archive,
            // and it is judged NOW, in this url's turn. Kept as a "partial", it
            // would meet the next url's complete-archive shortcut, fail the
            // digest there, and be discarded in a turn that never fetched — so
            // a mirror that sent the right number of wrong bytes and then
            // errored would stop upstream from ever being asked.
            Ok(Err(_)) if written == expected => break,
            Ok(Err(e)) => {
                return Err(keep_partial(
                    file,
                    download_failed(format!("stream failed: {e}")),
                ))
            }
        };
        let Some(chunk) = chunk else { break };
        // The catalogue's byte count is a hard ceiling, enforced per chunk. An
        // origin that decides to stream forever fills neither memory nor disk,
        // and `Content-Length` — which is attacker-controlled — is never
        // trusted to size anything.
        if written + chunk.len() as u64 > expected {
            return Err(FetchFailure::Rejected(integrity_failed(format!(
                "archive exceeded the catalogue's {expected} bytes"
            ))));
        }
        use std::io::Write as _;
        file.write_all(&chunk).map_err(|e| {
            FetchFailure::Rejected(install_failed(format!(
                "could not write the download: {e}"
            )))
        })?;
        written += chunk.len() as u64;
        if last_report.elapsed() >= PROGRESS_INTERVAL {
            on_progress(Phase::Downloading, written, expected);
            last_report = std::time::Instant::now();
        }
    }
    file.sync_all().map_err(|e| {
        FetchFailure::Rejected(install_failed(format!("could not flush the download: {e}")))
    })?;
    drop(file);
    on_progress(Phase::Downloading, written, expected);

    if written != expected {
        // The per-chunk ceiling rules out MORE, so this is always fewer.
        //
        // A whole-file response that declared its length and delivered all of
        // it is the origin's entire file, and that file is not our archive:
        // resuming past its end can only be refused. So is a framed 206 that
        // delivered NOTHING — an empty range is a 416 spelled wrong, and
        // keeping the partial would ask the same question, and get the same
        // answer, on every retry. Anything else simply ended: a dropped
        // close-delimited body looks exactly like this, and so does a 206
        // that served less of the range than was asked for (its length
        // describes only its own slice). That is kept like any other
        // interrupted transfer; if the origin's file really is shorter, the
        // resume is answered 416 and dropped then.
        let wrong_file = framed && (from == 0 || written == from);
        let reason = format!("expected {expected} bytes, received {written}");
        return Err(if wrong_file {
            FetchFailure::Rejected(integrity_failed(reason))
        } else {
            FetchFailure::Interrupted(download_failed(reason))
        });
    }
    Ok(())
}

/// Flush a partial to disk before handing it back as resumable.
///
/// "Kept for the next run" is a claim about the disk, not the page cache. If
/// the flush itself fails, the claim cannot be made, and the file is treated as
/// unusable rather than reported as safely kept.
fn keep_partial(file: std::fs::File, err: AppError) -> FetchFailure {
    match file.sync_all() {
        Ok(()) => FetchFailure::Interrupted(err),
        Err(e) => FetchFailure::Rejected(install_failed(format!(
            "could not flush the partial download: {e}"
        ))),
    }
}

/// Hash the archive on disk and compare it with the catalogue.
///
/// Streamed in blocks: the whole point of downloading to a file rather than to
/// memory is not to hold 128 MB, and hashing it by reading it back in one go
/// would give that up at the last moment.
fn verify_archive(
    path: &Path,
    model: &ModelEntry,
    cancel: &CancelFlag,
    on_progress: &ProgressFn,
) -> Result<(), AppError> {
    let mut file = std::fs::File::open(path)
        .map_err(|e| install_failed(format!("could not reopen the archive: {e}")))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    let mut read_total = 0u64;
    let mut last_report = std::time::Instant::now();
    loop {
        cancel.check()?;
        let read = file
            .read(&mut buffer)
            .map_err(|e| install_failed(format!("could not read the archive: {e}")))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        read_total += read as u64;
        if last_report.elapsed() >= PROGRESS_INTERVAL {
            on_progress(Phase::VerifyingArchive, read_total, model.archive.bytes);
            last_report = std::time::Instant::now();
        }
    }
    let actual = hex::encode(hasher.finalize());
    if actual != model.archive.sha256 {
        return Err(integrity_failed(format!(
            "archive sha256 {actual}, catalogue says {}",
            model.archive.sha256
        )));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/// Unpack ONLY the members the catalogue names, into `staging`.
///
/// Every entry's path is compared against the catalogue's own member list, so
/// there is no path arithmetic to get wrong: a name that is not in the list is
/// skipped whatever it contains, which covers `..`, absolute paths and
/// anything else in one rule rather than in a series of checks that have to be
/// individually right. Only regular files are ever written — a symlink or a
/// device node whose NAME matched would still be refused.
fn extract(
    archive_path: &Path,
    model: &ModelEntry,
    staging: &Path,
    cancel: &CancelFlag,
    on_progress: &ProgressFn,
) -> Result<(), AppError> {
    std::fs::create_dir_all(staging)
        .map_err(|e| install_failed(format!("could not create staging: {e}")))?;

    let file = std::fs::File::open(archive_path)
        .map_err(|e| install_failed(format!("could not open the archive: {e}")))?;
    let mut archive = tar::Archive::new(bzip2::read::BzDecoder::new(file));
    let entries = archive
        .entries()
        .map_err(|e| integrity_failed(format!("archive is not readable as tar: {e}")))?;

    let installed_total = model.installed_bytes();
    let mut written_total = 0u64;
    let mut seen: Vec<&str> = Vec::new();
    let mut last_report = std::time::Instant::now();
    on_progress(Phase::Extracting, 0, installed_total);

    for entry in entries {
        cancel.check()?;
        let mut entry =
            entry.map_err(|e| integrity_failed(format!("archive entry unreadable: {e}")))?;
        if entry.header().entry_type() != tar::EntryType::Regular {
            continue;
        }
        let path = entry
            .path()
            .map_err(|e| integrity_failed(format!("archive entry has no usable path: {e}")))?
            .to_string_lossy()
            .into_owned();
        let Some(wanted) = model.file_for_member(&path) else {
            continue;
        };
        if seen.contains(&wanted.name.as_str()) {
            return Err(integrity_failed(format!(
                "archive names {} more than once",
                wanted.name
            )));
        }
        seen.push(&wanted.name);

        // `wanted.name` came from the catalogue, which the catalogue tests pin
        // to a single path segment with no separators. This join cannot leave
        // `staging`.
        let out = staging.join(&wanted.name);
        let mut sink = std::fs::File::create(&out)
            .map_err(|e| install_failed(format!("could not write {}: {e}", wanted.name)))?;
        let mut buffer = vec![0u8; 1024 * 1024];
        let mut written = 0u64;
        loop {
            cancel.check()?;
            let read = entry
                .read(&mut buffer)
                .map_err(|e| integrity_failed(format!("{}: {e}", wanted.name)))?;
            if read == 0 {
                break;
            }
            // Bounded by the size the catalogue promises, so a decompression
            // bomb under a wanted name cannot fill the disk before the hash
            // check would have caught it.
            written += read as u64;
            if written > wanted.bytes {
                return Err(integrity_failed(format!(
                    "{} is larger than the catalogue's {} bytes",
                    wanted.name, wanted.bytes
                )));
            }
            use std::io::Write as _;
            sink.write_all(&buffer[..read])
                .map_err(|e| install_failed(format!("could not write {}: {e}", wanted.name)))?;
            written_total += read as u64;
            if last_report.elapsed() >= PROGRESS_INTERVAL {
                on_progress(Phase::Extracting, written_total, installed_total);
                last_report = std::time::Instant::now();
            }
        }
        // Forced to disk before the seal can possibly be written. The seal
        // means "these bytes were proven here", and after a power cut a
        // filesystem is free to make a small metadata write durable while the
        // large data writes that preceded it are still in page cache — which
        // would leave a valid seal over graphs that are not there.
        // `ModelFiles::detect` matches names and shape, not contents, so it
        // would not notice.
        sink.sync_all()
            .map_err(|e| install_failed(format!("could not flush {}: {e}", wanted.name)))?;
    }

    if seen.len() != model.files.len() {
        let missing: Vec<&str> = model
            .files
            .iter()
            .map(|f| f.name.as_str())
            .filter(|name| !seen.contains(name))
            .collect();
        return Err(integrity_failed(format!(
            "archive is missing {}",
            missing.join(", ")
        )));
    }
    Ok(())
}

/// Hash every staged file against the catalogue.
///
/// ALL of them, before any is moved. See the module header: this ordering is
/// the thing that stops a mismatch on the last file leaving a mixed model
/// behind that still looks complete to `ModelFiles::detect`.
fn verify_staged(
    staging: &Path,
    model: &ModelEntry,
    cancel: &CancelFlag,
    on_progress: &ProgressFn,
) -> Result<(), AppError> {
    let total = model.installed_bytes();
    let mut hashed = 0u64;
    for file in &model.files {
        cancel.check()?;
        let path = staging.join(&file.name);
        let meta = std::fs::metadata(&path)
            .map_err(|e| integrity_failed(format!("{}: {e}", file.name)))?;
        if meta.len() != file.bytes {
            return Err(integrity_failed(format!(
                "{}: expected {} bytes, got {}",
                file.name,
                file.bytes,
                meta.len()
            )));
        }
        let mut handle = std::fs::File::open(&path)
            .map_err(|e| integrity_failed(format!("{}: {e}", file.name)))?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; 1024 * 1024];
        loop {
            cancel.check()?;
            let read = handle
                .read(&mut buffer)
                .map_err(|e| integrity_failed(format!("{}: {e}", file.name)))?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
            hashed += read as u64;
        }
        let actual = hex::encode(hasher.finalize());
        if actual != file.sha256 {
            return Err(integrity_failed(format!(
                "{}: sha256 {actual}, catalogue says {}",
                file.name, file.sha256
            )));
        }
        on_progress(Phase::VerifyingFiles, hashed, total);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The whole sequence
// ---------------------------------------------------------------------------

/// Download, verify, unpack and install a model. Returns its directory.
///
/// Cancellation is checked between every chunk and every file, and is honoured
/// everywhere EXCEPT the remove-then-rename that installs the staged directory:
/// that window is the one place where stopping halfway could leave the model
/// directory missing with nothing to replace it, so it is allowed to finish.
/// Refuse an install the disk cannot hold, BEFORE anything is transferred.
///
/// ## What has to fit at once
///
/// An install is not "the size of the model". At its peak the volume holds:
///
/// * the **archive**, downloaded whole before it is verified;
/// * the **staging** tree, every file extracted and checked while the archive
///   is still there;
/// * the **current install**, which is not removed until the new one commits;
/// * the **backup** of that install, which is how an interrupted commit is
///   recoverable at all.
///
/// So the requirement is archive + 2 × installed + a margin — and for the
/// shipped model that is roughly 380 MB, not the 161 MB a user would guess
/// from the model's size, or the ~57 MB they see downloading.
///
/// ## Why it is worth refusing rather than discovering
///
/// Without this, running out of space is found somewhere in the middle: after
/// a 57 MB download on a hotel connection, or — worse — during the commit,
/// where the recovery path exists precisely because that is survivable but
/// unpleasant. The failure message then blamed the disk *after* the fact, and
/// the readiness review noted that installation errors "advise the user to
/// check disk space only after failure".
///
/// The numbers are stated in the error because "not enough space" without them
/// is not actionable: the user has to know how much to clear.
fn check_free_space(root: &Path, model: &ModelEntry) -> Result<(), AppError> {
    /// Headroom over the arithmetic. Space is not ours alone — Spotlight,
    /// Time Machine snapshots and the user's own work move underneath us —
    /// and a commit that fails on the last megabyte is the expensive failure.
    const MARGIN_BYTES: u64 = 256 * 1024 * 1024;

    let installed = model.installed_bytes();
    let required = model
        .archive
        .bytes
        .saturating_add(installed.saturating_mul(2))
        .saturating_add(MARGIN_BYTES);

    let Some(available) = available_bytes(root) else {
        // A volume that will not report its free space is not grounds to
        // refuse. The install will fail honestly if it runs out; refusing on a
        // failed syscall would make an unusual filesystem into a broken app.
        tracing::warn!(path = %root.display(), "could not read free space; skipping the preflight");
        return Ok(());
    };

    if available >= required {
        return Ok(());
    }

    let gb = |bytes: u64| format!("{:.1} GB", bytes as f64 / 1_000_000_000.0);
    Err(AppError::structured(
        "STT_MODEL_INSUFFICIENT_SPACE",
        crate::errors::ErrorCategory::Storage,
        format!(
            "There is not enough free space to install this language. It needs about {} \
             while it installs — the download, the files it unpacks into, and a backup of \
             any version already here — and {} is free. Nothing was downloaded.",
            gb(required),
            gb(available)
        ),
        true,
    )
    .with_action(crate::errors::RecoveryAction::RevealFolder)
    .with_detail("requiredBytes", required.to_string())
    .with_detail("availableBytes", available.to_string()))
}

/// Free bytes on the volume containing `path`, or `None` if it cannot be read.
///
/// `statvfs` reports the value for the FILESYSTEM the path is on, which is why
/// the model root is passed rather than the home directory: on a machine where
/// the app data directory is a symlink onto another volume — an ordinary way
/// to keep large data off a small boot disk — those are different answers.
#[cfg(unix)]
fn available_bytes(path: &Path) -> Option<u64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    // The directory must exist for `statvfs` to answer about it; walk up until
    // one does. A path whose parents are all missing is a bigger problem than
    // free space and is reported by the caller that tried to create it.
    let mut probe = path;
    loop {
        if probe.exists() {
            break;
        }
        probe = probe.parent()?;
    }

    let c_path = CString::new(probe.as_os_str().as_bytes()).ok()?;
    // SAFETY: `c_path` is a valid NUL-terminated path and `stat` is only read
    // after `statvfs` reports success.
    unsafe {
        let mut stat: libc::statvfs = std::mem::zeroed();
        if libc::statvfs(c_path.as_ptr(), &mut stat) != 0 {
            return None;
        }
        // `f_bavail` is blocks available to an UNPRIVILEGED process, which is
        // the number that matters — `f_bfree` includes the reserve only root
        // can spend.
        Some((stat.f_bavail as u64).saturating_mul(stat.f_frsize as u64))
    }
}

#[cfg(not(unix))]
fn available_bytes(_path: &Path) -> Option<u64> {
    // Windows would use GetDiskFreeSpaceExW. 1.0 ships macOS only (§P2-05),
    // and the caller treats `None` as "cannot say", which skips the preflight
    // rather than refusing — the same behaviour as an unreadable volume.
    None
}

pub async fn install(
    app_data_dir: &Path,
    catalogue: &Catalogue,
    model: &ModelEntry,
    policy: &HopPolicy,
    cancel: &CancelFlag,
    on_progress: &ProgressFn,
) -> Result<PathBuf, AppError> {
    let root = store::models_root(app_data_dir);
    let downloads = root.join(store::DOWNLOADS_DIR);
    std::fs::create_dir_all(&downloads)
        .map_err(|e| install_failed(format!("could not create the models directory: {e}")))?;

    // Before a byte moves. See `check_free_space`.
    check_free_space(&root, model)?;
    // A model left in its backup by an interrupted commit goes back FIRST: if
    // this attempt also fails, the machine still has the model it had before.
    let _ = store::recover_backup(&root, model);
    // Only then is what remains for this model garbage. Scoped to this model
    // so a concurrent install of a different one is untouched.
    let _ = store::clear_stale(app_data_dir, model);

    let archive_path = downloads.join(store::archive_part_name(model));
    let resume_path = downloads.join(store::resume_name(model));

    // Mirror first, then upstream. A mirror miss is not a failure — the digest
    // is the trust root and either host satisfies it — so only the LAST url's
    // error is worth reporting.
    //
    // Each candidate is fetched AND verified before the next is considered.
    // Verifying after the loop instead would let a mirror serving the right
    // number of wrong bytes end the search: the loop would break on a
    // successful transfer, the digest would fail, and upstream — which has the
    // bytes we want — would never be asked. A wrong mirror could then make a
    // model permanently uninstallable.
    let urls = archive_urls(catalogue, model);
    let mut last_error = None;
    let mut verified = false;
    for (index, url) in urls.iter().enumerate() {
        let is_last = index + 1 == urls.len();
        let outcome = match fetch_archive(
            url,
            model,
            &archive_path,
            &resume_path,
            policy,
            cancel,
            on_progress,
        )
        .await
        {
            Ok(()) => {
                on_progress(Phase::VerifyingArchive, 0, model.archive.bytes);
                // A full-length file that fails here is wrong, not unfinished.
                tokio::task::block_in_place(|| {
                    verify_archive(&archive_path, model, cancel, on_progress)
                })
                .map_err(FetchFailure::Rejected)
            }
            Err(failure) => Err(failure),
        };

        match outcome {
            Ok(()) => {
                verified = true;
                break;
            }
            // A cancellation is the user's decision, not a mirror miss. Stop,
            // and keep whatever was transferred so it can be resumed.
            Err(failure) if is_cancelled_error(failure.error()) => {
                return Err(failure.into_error())
            }
            // The transfer stopped, or never started; nothing judged the bytes.
            // Keep the partial AND its sidecar, which is what lets the next run
            // send a conditional range instead of starting from zero.
            //
            // The next candidate is still tried. If it opens, its transfer
            // replaces this prefix — a prefix from one url is never resumed
            // against another — and if it cannot open, this prefix survives.
            Err(FetchFailure::Interrupted(err)) => {
                if !is_last {
                    tracing::warn!(
                        url = %url,
                        error = %err,
                        "model source interrupted — keeping the partial and falling back"
                    );
                }
                last_error = Some(err);
            }
            Err(FetchFailure::Rejected(err)) => {
                // Bytes that failed are never kept: they would be treated as a
                // complete or resumable archive next time and fail identically
                // forever.
                //
                // A failed removal cannot be shrugged off. The next candidate
                // would see a file of exactly the catalogue's length, take the
                // complete-archive shortcut, and re-hash the same bad bytes —
                // so a mirror serving rubbish would stop upstream from ever
                // being reached. Truncating is the fallback; if even that
                // fails there is nothing useful left to try.
                if let Err(remove_err) = discard_archive(&archive_path) {
                    let _ = std::fs::remove_file(&resume_path);
                    return Err(install_failed(format!(
                        "could not discard a failed download at {}: {remove_err}",
                        archive_path.display()
                    )));
                }
                let _ = std::fs::remove_file(&resume_path);
                if !is_last {
                    tracing::warn!(
                        url = %url,
                        error = %err,
                        "model source miss — falling back; the hash is checked either way"
                    );
                }
                last_error = Some(err);
            }
        }
    }
    if !verified {
        return Err(last_error.unwrap_or_else(|| download_failed("no url produced an archive")));
    }

    let staging = root.join(format!(
        "{}{}-{}",
        store::STAGING_PREFIX,
        model.install_dir,
        uuid::Uuid::new_v4()
    ));
    let outcome = tokio::task::block_in_place(|| {
        install_from_archive(&archive_path, &staging, &root, model, cancel, on_progress)
    });
    if outcome.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
        return outcome;
    }

    // The archive has done its job. Keeping it would cost 128 MB for nothing —
    // the installed files are what matter now.
    //
    // Logged rather than ignored: a scanner holding the file open makes this
    // fail transiently, and silence would leave 128 MB nobody can account for
    // and no record of why.
    for path in [&archive_path, &resume_path] {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => {
                tracing::warn!(path = %path.display(), error = %err, "could not remove a spent model download")
            }
        }
    }
    outcome
}

/// Everything from a verified archive to a sealed model directory.
fn install_from_archive(
    archive_path: &Path,
    staging: &Path,
    root: &Path,
    model: &ModelEntry,
    cancel: &CancelFlag,
    on_progress: &ProgressFn,
) -> Result<PathBuf, AppError> {
    extract(archive_path, model, staging, cancel, on_progress)?;
    verify_staged(staging, model, cancel, on_progress)?;
    store::write_attribution(staging, model)
        .map_err(|e| install_failed(format!("could not write the licence notice: {e}")))?;

    // Proven loadable while still in staging, so a model that cannot load
    // never displaces one that can.
    //
    // Asked of the DIRECTORY rather than through a `LocalSttConfig`, for the
    // reason `get_speech_engine_status` gives: "are the files there and in a
    // shape the loader understands" is a question about the bundle, and
    // building a tuned config to ask it would imply the tuning had something
    // to do with the answer. `LocalSttConfig::validate` is this call anyway.
    on_progress(Phase::Validating, 0, 1);
    cc_stt::local::ModelFiles::detect(staging).map_err(|detail| {
        integrity_failed(format!("the downloaded model is not loadable: {detail}"))
    })?;

    // The last point at which stopping is free. Past here the old model starts
    // moving, and a cancellation would have to be undone rather than obeyed.
    cancel.check()?;

    // ---------------------------------------------------------------------
    // Commit, as a transaction.
    // ---------------------------------------------------------------------
    // This used to `remove_dir_all` the previous model and then rename the new
    // one into the hole. That is only safe if nothing can go wrong between the
    // two, and plenty can: `remove_dir_all` is a recursive walk that can fail
    // part-way on a permissions change, a scanner holding a handle, or an I/O
    // error, and the rename after it can fail too. Every one of those left the
    // user with NO model where they had a working one — and the post-rename
    // validation could still fail, leaving an unsealed directory the resolver
    // ignores.
    //
    // The old model is now moved ASIDE rather than destroyed. Nothing is
    // deleted until the replacement is proven in place, and every failure path
    // puts it back. The cost is transient disk: the old model, the staged new
    // one and the archive coexist for the length of the commit.
    on_progress(Phase::Installing, 0, 1);
    let target = model.install_path(root);
    let backup = store::backup_path(root, model);
    let _ = std::fs::remove_dir_all(&backup);

    let had_previous = target.exists();
    if had_previous {
        std::fs::rename(&target, &backup).map_err(|e| {
            install_failed(format!("could not set the previous model aside: {e}"))
        })?;
    }

    // Put the backup back. Split in two by whether the swap has HAPPENED,
    // because "what is at `target`" means different things either side of it.
    //
    // Before the swap, `target` is not ours — it is either absent or something
    // another actor put there — so deleting it would be destroying a stranger's
    // work. After the swap it is the staged model we just moved in, and
    // clearing it is the only way the backup can come home.
    let restore_backup = |after_swap: bool, err: AppError| -> AppError {
        if after_swap {
            if let Err(e) = std::fs::remove_dir_all(&target) {
                // The failed replacement is still sitting at `target` and the
                // good copy is still in the backup. Leaving both is right:
                // `recover_backup` prefers a sealed backup over an unsealed
                // target, so the next launch repairs it.
                tracing::error!(
                    error = %e,
                    target = %target.display(),
                    "could not remove a failed model install; the previous model is \
                     still in its backup and will be restored on the next launch"
                );
                return err;
            }
        }
        if had_previous && !target.exists() {
            if let Err(e) = std::fs::rename(&backup, &target) {
                tracing::error!(
                    error = %e,
                    backup = %backup.display(),
                    "could not restore the previous speech model; it is still in the \
                     backup directory and will be recovered on the next launch"
                );
            }
        }
        err
    };

    if let Err(e) = std::fs::rename(staging, &target) {
        // Nothing of ours is at `target` — the rename is precisely what did
        // not happen — so this must not delete whatever is.
        return Err(restore_backup(
            false,
            install_failed(format!("could not install the model: {e}")),
        ));
    }

    // Validated AGAIN, at the path it will actually be loaded from. The staged
    // check proves the files; this proves the install — and the seal below
    // means "proven HERE", which is a claim only this call can support.
    on_progress(Phase::Validating, 1, 1);
    if let Err(detail) = cc_stt::local::ModelFiles::detect(&target) {
        return Err(restore_backup(
            true,
            integrity_failed(format!("the installed model is not loadable: {detail}")),
        ));
    }

    // Last. Everything before this is reversible; the seal is what makes the
    // directory eligible to be chosen.
    if let Err(e) = store::write_seal(&target, model) {
        return Err(restore_backup(
            true,
            install_failed(format!("could not seal the model: {e}")),
        ));
    }

    // Committed. Only now is the old model actually gone.
    if had_previous {
        if let Err(e) = std::fs::remove_dir_all(&backup) {
            tracing::warn!(error = %e, "could not remove the replaced speech model");
        }
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::speech::catalogue::{Archive, Attribution, License, ModelFile};
    use std::io::Write as _;
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    /// The four files a fixture model is made of. Small enough that a whole
    /// install runs in milliseconds, real enough that `ModelFiles::detect`
    /// accepts the result — which is the thing being proved.
    fn fixture_files() -> Vec<(&'static str, Vec<u8>)> {
        vec![
            ("encoder.int8.onnx", b"encoder-graph-bytes".to_vec()),
            ("decoder.onnx", b"decoder-graph-bytes".to_vec()),
            ("joiner.int8.onnx", b"joiner-graph-bytes".to_vec()),
            ("tokens.txt", b"<blk> 0\n<unk> 1\n".to_vec()),
        ]
    }

    fn sha256_of(bytes: &[u8]) -> String {
        hex::encode(Sha256::digest(bytes))
    }

    /// A real `.tar.bz2` with the given members, built in memory.
    fn build_archive(root: &str, members: &[(&str, Vec<u8>)]) -> Vec<u8> {
        build_archive_with(root, members, &[])
    }

    /// As [`build_archive`], plus members whose paths are written straight into
    /// the tar header.
    ///
    /// `Builder::append_data` refuses to CREATE a path containing `..`, which
    /// is the right behaviour for a writer and useless for testing a reader: a
    /// hostile archive is not built with this crate. `append` takes a header
    /// that has already been filled in and does not revalidate it, so the name
    /// goes in by hand.
    fn build_archive_with(
        root: &str,
        members: &[(&str, Vec<u8>)],
        raw: &[(&str, Vec<u8>)],
    ) -> Vec<u8> {
        let mut tar_bytes = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar_bytes);
            for (name, body) in members {
                let mut header = tar::Header::new_gnu();
                header.set_size(body.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                builder
                    .append_data(&mut header, format!("{root}/{name}"), body.as_slice())
                    .unwrap();
            }
            for (name, body) in raw {
                let mut header = tar::Header::new_gnu();
                header.set_size(body.len() as u64);
                header.set_mode(0o644);
                header.set_entry_type(tar::EntryType::Regular);
                let bytes = name.as_bytes();
                header.as_gnu_mut().unwrap().name[..bytes.len()].copy_from_slice(bytes);
                header.set_cksum();
                builder.append(&header, body.as_slice()).unwrap();
            }
            builder.finish().unwrap();
        }
        let mut encoder =
            bzip2::write::BzEncoder::new(Vec::new(), bzip2::Compression::fast());
        encoder.write_all(&tar_bytes).unwrap();
        encoder.finish().unwrap()
    }

    /// A catalogue entry describing an archive we just built.
    fn fixture_entry(archive: &[u8], files: &[(&str, Vec<u8>)], root: &str) -> ModelEntry {
        ModelEntry {
            id: "x-asr-480ms".to_string(),
            model_name: "x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05".to_string(),
            install_dir: "x-asr-480ms".to_string(),
            languages: vec!["en".to_string()],
            archive: Archive {
                file_name: "fixture.tar.bz2".to_string(),
                root_dir: root.to_string(),
                upstream_url: "https://example.invalid/fixture.tar.bz2".to_string(),
                sha256: sha256_of(archive),
                bytes: archive.len() as u64,
            },
            files: files
                .iter()
                .map(|(name, body)| ModelFile {
                    name: (*name).to_string(),
                    sha256: sha256_of(body),
                    bytes: body.len() as u64,
                })
                .collect(),
            attribution: Attribution {
                title: "Fixture".to_string(),
                author: "Fixture".to_string(),
                source_url: "https://example.invalid/".to_string(),
                distributed_via: None,
                license: License {
                    id: "Apache-2.0".to_string(),
                    name: "Apache License 2.0".to_string(),
                    url: "https://example.invalid/licence".to_string(),
                },
                license_note: None,
                modified: false,
            },
        }
    }

    fn fixture_catalogue(model: ModelEntry) -> Catalogue {
        Catalogue {
            schema_version: 1,
            mirror_base_url: None,
            default_model_id: model.id.clone(),
            models: vec![model],
        }
    }

    /// The ETag a healthy fixture origin serves.
    const FIXTURE_ETAG: &str = "\"fixture\"";

    /// How many pieces `Behaviour::Slow` dribbles a body out in.
    const SLOW_PIECES: usize = 8;

    /// How long a stalled origin holds its connection open in silence.
    ///
    /// Past `IDLE_TIMEOUT`, so a client that cannot stop is ended by its own
    /// read timeout — the bug — rather than by the fixture giving up first.
    /// A client that CAN stop hangs up, which releases the hold at once.
    const STALL_HOLD: Duration = Duration::from_secs(60);

    /// How the origin should behave, per test.
    #[derive(Clone, Copy, PartialEq)]
    enum Behaviour {
        /// Serves ranges honestly, with a strong ETag.
        Ranged,
        /// Ignores `Range` entirely and always sends the whole body.
        NoRanges,
        /// Honours `Range`, but the asset has been REPLACED since the client
        /// last saw it: its ETag no longer matches the `If-Range` value, so
        /// the origin must ignore the range and send the whole new body.
        Replaced,
        /// Serves a body that is not the archive the catalogue pinned.
        Corrupt,
        /// Answers every request by closing the connection. A dead host, as
        /// opposed to one the hop guard refuses before connecting.
        Dead,
        /// Serves the body in two writes with a pause between, so a transfer
        /// can be cancelled while it is genuinely in flight.
        Slow,
        /// Promises the whole body in `Content-Length`, sends it only up to
        /// this archive offset, then closes. A dropped connection, a closed
        /// lid, a Wi-Fi drop — what the client sees mid-transfer.
        DropsAt(usize),
        /// As `DropsAt`, but with no `Content-Length` at all, so the body is
        /// delimited only by the connection closing. The client cannot tell
        /// this from a complete body; only the catalogue's size can.
        UnframedDropsAt(usize),
        /// Serves a file that ends at this offset, honestly framed: the
        /// origin's WHOLE file is shorter than the catalogue's archive.
        ShortAt(usize),
        /// Answers 503 without a body.
        Unavailable,
        /// Answers 416 to everything, as an origin does when asked to resume
        /// past the end of what it has.
        RangeNotSatisfiable,
        /// Promises the whole body, sends it up to this archive offset, then
        /// goes silent with the connection still open. Not a drop: nothing
        /// ends, so only the client's idle timeout — or a Stop — can.
        StallsAt(usize),
        /// Takes the request and never answers it, not even with headers.
        Silent,
    }

    /// What the origin was actually asked, so a test can prove a request was
    /// made rather than inferring it from the outcome.
    #[derive(Clone, Debug, Default, PartialEq)]
    struct SeenRequest {
        range_from: Option<u64>,
        if_range: Option<String>,
    }

    /// A dependency-free HTTP/1.1 origin that understands `Range`.
    ///
    /// The same shape as `assets::remote`'s mock and for the same reason: it
    /// drives the REAL reqwest client, so the range handling, the redirect
    /// revalidation and the chunk loop under test are the ones that ship.
    struct MockOrigin {
        port: u16,
        /// How many times a body has been served. Proves a resumed run sent a
        /// second request rather than quietly restarting.
        requests: Arc<AtomicU64>,
        /// Bytes served in total, so a test can prove a resume transferred
        /// only the tail — or that a retry transferred nothing at all.
        served: Arc<AtomicU64>,
        /// What each request actually carried.
        seen: Arc<std::sync::Mutex<Vec<SeenRequest>>>,
        /// The path each of those requests was for. Kept apart from
        /// `SeenRequest` so the resume assertions stay about the range; this
        /// is what proves WHICH candidate a mirror test reached, since the
        /// mirror and upstream share one listener.
        paths: Arc<std::sync::Mutex<Vec<String>>>,
    }

    impl MockOrigin {
        fn start(body: Vec<u8>, behaviour: Behaviour) -> Self {
            Self::start_scripted(body, vec![behaviour])
        }

        /// An origin whose behaviour changes from one request to the next:
        /// request N gets `script[N]`, and every request past the end of the
        /// script gets its last entry.
        ///
        /// One listener rather than one per behaviour, because the resume
        /// sidecar records the url it is a partial OF — "drops, then recovers"
        /// is only a resume if both halves are the same url. It also lets a
        /// mirror and upstream share the one authority a test policy exempts:
        /// `install` asks the mirror first, so the script's order is the
        /// candidates' order.
        fn start_scripted(body: Vec<u8>, script: Vec<Behaviour>) -> Self {
            assert!(!script.is_empty(), "a mock origin needs a behaviour");
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock origin");
            let port = listener.local_addr().unwrap().port();
            let requests = Arc::new(AtomicU64::new(0));
            let served = Arc::new(AtomicU64::new(0));
            let seen: Arc<std::sync::Mutex<Vec<SeenRequest>>> = Arc::default();
            let paths: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
            let counters = (
                Arc::clone(&requests),
                Arc::clone(&served),
                Arc::clone(&seen),
                Arc::clone(&paths),
            );

            std::thread::spawn(move || {
                let (requests, served, seen, paths) = counters;
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else { continue };
                    let mut buf = [0u8; 4096];
                    let read = std::io::Read::read(&mut stream, &mut buf).unwrap_or(0);
                    let request = String::from_utf8_lossy(&buf[..read]).to_string();
                    let attempt = requests.fetch_add(1, Ordering::SeqCst) as usize;
                    let behaviour = script[attempt.min(script.len() - 1)];

                    if behaviour == Behaviour::Dead {
                        // Close without answering. A host that is down, which
                        // is a different failure from one the hop guard
                        // refuses before a socket is ever opened.
                        drop(stream);
                        continue;
                    }

                    let path = request.split_whitespace().nth(1).unwrap_or("/").to_string();
                    if path == "/redirect" {
                        let _ = stream.write_all(
                            format!(
                                "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{port}/archive\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                            )
                            .as_bytes(),
                        );
                        let _ = stream.flush();
                        continue;
                    }

                    // Header NAMES are matched case-insensitively because hyper
                    // writes them lowercase on the wire. Matching `Range:` as
                    // spelled in the RFC silently never fired, and every resume
                    // test passed by restarting. Header VALUES keep their case,
                    // because an ETag is case-sensitive.
                    let header = |name: &str| -> Option<String> {
                        request.lines().find_map(|line| {
                            let (key, value) = line.split_once(':')?;
                            key.trim()
                                .eq_ignore_ascii_case(name)
                                .then(|| value.trim().to_string())
                        })
                    };
                    let range_from = header("range").and_then(|value| {
                        value
                            .trim()
                            .strip_prefix("bytes=")?
                            .split('-')
                            .next()?
                            .trim()
                            .parse::<u64>()
                            .ok()
                    });
                    let if_range = header("if-range");
                    paths.lock().unwrap().push(path.clone());
                    seen.lock().unwrap().push(SeenRequest {
                        range_from,
                        if_range: if_range.clone(),
                    });

                    if behaviour == Behaviour::Silent {
                        hold_until_hangup(&mut stream);
                        continue;
                    }

                    let refusal = match behaviour {
                        Behaviour::Unavailable => Some(
                            "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                                .to_string(),
                        ),
                        Behaviour::RangeNotSatisfiable => Some(format!(
                            "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                            body.len()
                        )),
                        _ => None,
                    };
                    if let Some(refusal) = refusal {
                        let _ = stream.write_all(refusal.as_bytes());
                        let _ = stream.flush();
                        continue;
                    }

                    // What the asset's validator is NOW. `Replaced` models an
                    // upstream release tag that was overwritten: the client's
                    // `If-Range` still names the old one.
                    let etag = if behaviour == Behaviour::Replaced {
                        "\"fixture-v2\""
                    } else {
                        FIXTURE_ETAG
                    };
                    // A conditional range is honoured only when the validator
                    // still matches — which is the entire point of `If-Range`.
                    let validator_ok = match &if_range {
                        Some(sent) => sent == etag,
                        None => true,
                    };
                    let honour_range = match behaviour {
                        Behaviour::NoRanges => false,
                        _ => range_from.is_some() && validator_ok,
                    };

                    let payload: &[u8] = match behaviour {
                        Behaviour::ShortAt(len) => &body[..len.min(body.len())],
                        _ => &body,
                    };
                    let (head, start, slice) = if honour_range {
                        let from = (range_from.unwrap_or(0) as usize).min(payload.len());
                        let slice = &payload[from..];
                        (
                            format!(
                                // No `Accept-Ranges`: it is advisory, a 206
                                // may omit it, and the client must not need it
                                // to resume a resumed transfer.
                                "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\nETag: {etag}\r\nConnection: close\r\n\r\n",
                                slice.len(),
                                from,
                                payload.len().saturating_sub(1),
                                payload.len()
                            ),
                            from,
                            slice,
                        )
                    } else {
                        let accept = if behaviour == Behaviour::NoRanges {
                            ""
                        } else {
                            "Accept-Ranges: bytes\r\n"
                        };
                        (
                            format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n{accept}ETag: {etag}\r\nConnection: close\r\n\r\n",
                                payload.len()
                            ),
                            0,
                            payload,
                        )
                    };
                    let head = match behaviour {
                        Behaviour::UnframedDropsAt(_) => {
                            head.replace(&format!("Content-Length: {}\r\n", slice.len()), "")
                        }
                        _ => head,
                    };
                    // What actually goes on the wire, which for a dropped
                    // connection is less than the head promised.
                    let sent = match behaviour {
                        Behaviour::DropsAt(at)
                        | Behaviour::UnframedDropsAt(at)
                        | Behaviour::StallsAt(at) => {
                            &slice[..at.saturating_sub(start).min(slice.len())]
                        }
                        _ => slice,
                    };

                    let _ = stream.write_all(head.as_bytes());
                    if behaviour == Behaviour::Slow && sent.len() >= SLOW_PIECES {
                        // Dripped out in pieces with gaps between, so the
                        // client sees many chunks and the throttled progress
                        // callback fires more than once BEFORE the body ends.
                        // Two writes was not enough: a fixture archive is a
                        // few hundred bytes, both halves landed inside one
                        // progress interval, and a "mid-transfer" cancellation
                        // could only ever fire after the last byte.
                        let piece = sent.len().div_ceil(SLOW_PIECES);
                        for part in sent.chunks(piece) {
                            let _ = stream.write_all(part);
                            let _ = stream.flush();
                            std::thread::sleep(Duration::from_millis(60));
                        }
                    } else {
                        let _ = stream.write_all(sent);
                    }
                    served.fetch_add(sent.len() as u64, Ordering::SeqCst);
                    let _ = stream.flush();
                    if matches!(behaviour, Behaviour::StallsAt(_)) {
                        hold_until_hangup(&mut stream);
                    } else if sent.len() < slice.len() {
                        // Hang up cleanly and wait for the client to notice,
                        // so what it sees is the body ending early rather than
                        // a reset that could discard bytes it has not yet read
                        // — which would make "kept exactly what arrived"
                        // impossible to assert.
                        let _ = stream.shutdown(std::net::Shutdown::Write);
                        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                        let _ = std::io::Read::read(&mut stream, &mut [0u8; 1]);
                    }
                }
            });
            Self {
                port,
                requests,
                served,
                seen,
                paths,
            }
        }

        fn seen(&self) -> Vec<SeenRequest> {
            self.seen.lock().unwrap().clone()
        }

        fn paths(&self) -> Vec<String> {
            self.paths.lock().unwrap().clone()
        }

        fn url(&self, path: &str) -> String {
            format!("http://127.0.0.1:{}{path}", self.port)
        }

        fn policy(&self) -> HopPolicy {
            HopPolicy {
                labels: MODEL_HOP_LABELS,
                exempt_authority: Some(format!("127.0.0.1:{}", self.port)),
            }
        }
    }

    /// Keep a connection open and silent until the client hangs up.
    ///
    /// One read, which returns the moment the client closes its end (or
    /// resets it) and otherwise after `STALL_HOLD`. Sleeping instead would hold
    /// the origin's only thread for the full stall even after the client had
    /// gone, and the request that resumes the download would queue behind it.
    fn hold_until_hangup(stream: &mut std::net::TcpStream) {
        let _ = stream.set_read_timeout(Some(STALL_HOLD));
        let _ = std::io::Read::read(stream, &mut [0u8; 1]);
    }

    /// Point a catalogue entry's upstream url at the mock.
    fn aimed_at(mut model: ModelEntry, url: String) -> ModelEntry {
        model.archive.upstream_url = url;
        model
    }

    /// A model directory `ModelFiles::detect` accepts, with recognisable bytes.
    fn write_model_dir(dir: &Path, marker: &[u8]) {
        std::fs::create_dir_all(dir).unwrap();
        for name in ["encoder.int8.onnx", "decoder.onnx", "joiner.int8.onnx"] {
            std::fs::write(dir.join(name), marker).unwrap();
        }
        std::fs::write(dir.join("tokens.txt"), b"<blk> 0\n").unwrap();
    }

    fn no_progress() -> Box<ProgressFn> {
        Box::new(|_, _, _| {})
    }

    /// A progress sink that remembers which phases were entered.
    ///
    /// "It did not install" is a much weaker claim than "it never reached
    /// extraction". Several tests below assert the absence of a phase, which
    /// is the only way to prove that a check happened BEFORE the work it is
    /// supposed to prevent rather than after it.
    #[derive(Clone, Default)]
    struct PhaseLog(Arc<std::sync::Mutex<Vec<Phase>>>);

    impl PhaseLog {
        fn sink(&self) -> Box<ProgressFn> {
            let seen = Arc::clone(&self.0);
            Box::new(move |phase, _, _| {
                let mut seen = seen.lock().unwrap();
                if seen.last() != Some(&phase) {
                    seen.push(phase);
                }
            })
        }

        fn saw(&self, phase: Phase) -> bool {
            self.0.lock().unwrap().contains(&phase)
        }
    }

    /// The happy path, end to end: fetch, verify, unpack, install, seal.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_model_downloads_verifies_extracts_and_installs() {
        let files = fixture_files();
        let archive = build_archive("bundle-root", &files);
        let origin = MockOrigin::start(archive.clone(), Behaviour::Ranged);
        let model = aimed_at(
            fixture_entry(&archive, &files, "bundle-root"),
            origin.url("/archive"),
        );
        let catalogue = fixture_catalogue(model.clone());
        let temp = tempfile::tempdir().unwrap();

        let dir = install(
            temp.path(),
            &catalogue,
            &catalogue.models[0],
            &origin.policy(),
            &CancelFlag::new(),
            &no_progress(),
        )
        .await
        .expect("a well-formed archive must install");

        for (name, body) in &files {
            assert_eq!(&std::fs::read(dir.join(name)).unwrap(), body, "{name}");
        }
        assert!(
            store::read_seal(&dir, &model).is_some(),
            "an installed model must be sealed"
        );
        assert!(
            dir.join("ATTRIBUTION.md").exists(),
            "the licence notice must travel with the weights"
        );
        // The archive is 128 MB in production and has done its job.
        let downloads = store::models_root(temp.path()).join(store::DOWNLOADS_DIR);
        assert!(!downloads.join(store::archive_part_name(&model)).exists());
    }

    /// Every hop is revalidated, so a redirect still lands correctly.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_redirect_is_followed_through_the_hardened_guard() {
        let files = fixture_files();
        let archive = build_archive("bundle-root", &files);
        let origin = MockOrigin::start(archive.clone(), Behaviour::Ranged);
        let model = aimed_at(
            fixture_entry(&archive, &files, "bundle-root"),
            origin.url("/redirect"),
        );
        let catalogue = fixture_catalogue(model);
        let temp = tempfile::tempdir().unwrap();

        install(
            temp.path(),
            &catalogue,
            &catalogue.models[0],
            &origin.policy(),
            &CancelFlag::new(),
            &no_progress(),
        )
        .await
        .expect("a redirect to an allowed hop must still install");
    }

    /// The production policy has no exemption, so the mock is refused outright
    /// — which is what proves the tests above pass because of the exemption
    /// rather than because the guard is weak.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_strict_policy_refuses_the_mock_origin() {
        let files = fixture_files();
        let archive = build_archive("bundle-root", &files);
        let origin = MockOrigin::start(archive.clone(), Behaviour::Ranged);
        let model = aimed_at(
            fixture_entry(&archive, &files, "bundle-root"),
            origin.url("/archive"),
        );
        let catalogue = fixture_catalogue(model);
        let temp = tempfile::tempdir().unwrap();

        let err = install(
            temp.path(),
            &catalogue,
            &catalogue.models[0],
            &HopPolicy::strict(MODEL_HOP_LABELS),
            &CancelFlag::new(),
            &no_progress(),
        )
        .await
        .expect_err("plaintext loopback must be refused in production");
        assert_eq!(err.code(), "STT_MODEL_URL_INSECURE", "{err:?}");
    }

    /// Offline, the lookup is the first thing to fail. That must read as a
    /// download failure with a remedy, never as an address the guard refused —
    /// and its code must stay the one a dropped transfer reports.
    #[test]
    fn an_unreachable_model_host_is_a_download_failure_not_a_refusal() {
        let unreachable = net::unreachable_host(&MODEL_HOP_LABELS, "dns lookup failed");
        let dropped = download_failed("stream failed");

        assert_eq!(unreachable.code(), dropped.code());
        assert_ne!(unreachable.code(), MODEL_HOP_LABELS.blocked_code);
        assert_eq!(unreachable.category(), dropped.category());
        assert_eq!(unreachable.recoverable(), dropped.recoverable());
        // Settings › Speech shows this Rust copy verbatim under "Try again".
        let message = unreachable.user_message();
        assert!(message.contains("Check your connection"), "{message}");
        assert!(!message.contains("refused"), "{message}");
    }

    /// A partial from an interrupted run is continued, not restarted.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_interrupted_download_resumes_from_the_partial() {
        let files = fixture_files();
        let archive = build_archive("bundle-root", &files);
        let origin = MockOrigin::start(archive.clone(), Behaviour::Ranged);
        let model = aimed_at(
            fixture_entry(&archive, &files, "bundle-root"),
            origin.url("/archive"),
        );
        let catalogue = fixture_catalogue(model.clone());
        let temp = tempfile::tempdir().unwrap();

        // Stage a half-finished download exactly as a killed run would leave
        // it: a prefix of the archive plus a sidecar naming its validator.
        let downloads = store::models_root(temp.path()).join(store::DOWNLOADS_DIR);
        std::fs::create_dir_all(&downloads).unwrap();
        let half = archive.len() / 2;
        std::fs::write(
            downloads.join(store::archive_part_name(&model)),
            &archive[..half],
        )
        .unwrap();
        write_resume(
            &downloads.join(store::resume_name(&model)),
            &ResumeState {
                version: RESUME_VERSION,
                model_id: model.id.clone(),
                archive_sha256: model.archive.sha256.clone(),
                url: model.archive.upstream_url.clone(),
                etag: Some(FIXTURE_ETAG.to_string()),
                last_modified: None,
            },
        )
        .unwrap();

        install(
            temp.path(),
            &catalogue,
            &catalogue.models[0],
            &origin.policy(),
            &CancelFlag::new(),
            &no_progress(),
        )
        .await
        .expect("a valid partial must be resumed");

        // Exactly the tail, and asked for the right way. Byte count alone
        // would not prove the request carried the conditional that makes the
        // range safe — an origin could simply have sent less.
        let served = origin.served.load(Ordering::SeqCst);
        assert_eq!(
            served,
            (archive.len() - half) as u64,
            "resume must transfer exactly the tail"
        );
        assert_eq!(
            origin.seen(),
            vec![SeenRequest {
                range_from: Some(half as u64),
                if_range: Some(FIXTURE_ETAG.to_string()),
            }],
            "the resume must be a conditional range request"
        );
    }

    /// A complete archive from an interrupted run is reused, not re-fetched.
    ///
    /// Cancelling during verification or extraction, running out of disk while
    /// unpacking, or crashing before the seal all leave a full archive on
    /// disk. Re-downloading 128 MB that is already there is the most expensive
    /// possible response to a retry.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_complete_archive_is_reused_without_touching_the_network() {
        let files = fixture_files();
        let archive = build_archive("bundle-root", &files);
        let origin = MockOrigin::start(archive.clone(), Behaviour::Ranged);
        let model = aimed_at(
            fixture_entry(&archive, &files, "bundle-root"),
            origin.url("/archive"),
        );
        let catalogue = fixture_catalogue(model.clone());
        let temp = tempfile::tempdir().unwrap();

        let downloads = store::models_root(temp.path()).join(store::DOWNLOADS_DIR);
        std::fs::create_dir_all(&downloads).unwrap();
        std::fs::write(downloads.join(store::archive_part_name(&model)), &archive).unwrap();

        install(
            temp.path(),
            &catalogue,
            &catalogue.models[0],
            &origin.policy(),
            &CancelFlag::new(),
            &no_progress(),
        )
        .await
        .expect("a complete archive must install without re-downloading");

        assert_eq!(
            origin.requests.load(Ordering::SeqCst),
            0,
            "the network must not be touched when the archive is already complete"
        );
    }

    /// The case `If-Range` exists for. Upstream's release tag is mutable, so a
    /// partial can be a prefix of bytes that are no longer there; appending to
    /// it would produce a file that is neither version.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_replaced_asset_restarts_instead_of_appending() {
        let files = fixture_files();
        let archive = build_archive("bundle-root", &files);
        let origin = MockOrigin::start(archive.clone(), Behaviour::Replaced);
        let model = aimed_at(
            fixture_entry(&archive, &files, "bundle-root"),
            origin.url("/archive"),
        );
        let catalogue = fixture_catalogue(model.clone());
        let temp = tempfile::tempdir().unwrap();

        // A partial of some OTHER archive, the same length as a real prefix.
        let downloads = store::models_root(temp.path()).join(store::DOWNLOADS_DIR);
        std::fs::create_dir_all(&downloads).unwrap();
        let half = archive.len() / 2;
        std::fs::write(
            downloads.join(store::archive_part_name(&model)),
            vec![0xEEu8; half],
        )
        .unwrap();
        write_resume(
            &downloads.join(store::resume_name(&model)),
            &ResumeState {
                version: RESUME_VERSION,
                model_id: model.id.clone(),
                archive_sha256: model.archive.sha256.clone(),
                url: model.archive.upstream_url.clone(),
                // The validator the client saw last time. The origin's asset
                // has since been replaced and now answers `"fixture-v2"`.
                etag: Some(FIXTURE_ETAG.to_string()),
                last_modified: None,
            },
        )
        .unwrap();

        let dir = install(
            temp.path(),
            &catalogue,
            &catalogue.models[0],
            &origin.policy(),
            &CancelFlag::new(),
            &no_progress(),
        )
        .await
        .expect("a replaced asset must restart cleanly rather than corrupt");

        // The client genuinely ATTEMPTED a conditional range — otherwise this
        // passes as an ordinary fresh download and proves nothing about
        // `If-Range` at all.
        assert_eq!(
            origin.seen(),
            vec![SeenRequest {
                range_from: Some(half as u64),
                if_range: Some(FIXTURE_ETAG.to_string()),
            }],
            "the client must have tried to resume against its stored validator"
        );
        // And the whole body came back, so nothing was appended.
        assert_eq!(origin.served.load(Ordering::SeqCst), archive.len() as u64);
        for (name, body) in &files {
            assert_eq!(&std::fs::read(dir.join(name)).unwrap(), body, "{name}");
        }
    }

    /// An origin with no range support still works; it just cannot resume.
    ///
    /// Started FROM a partial, so a range is actually attempted. With no
    /// partial this behaviour is indistinguishable from an ordinary fresh
    /// download and the test would prove nothing.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_origin_without_range_support_restarts_and_still_installs() {
        let files = fixture_files();
        let archive = build_archive("bundle-root", &files);
        let origin = MockOrigin::start(archive.clone(), Behaviour::NoRanges);
        let model = aimed_at(
            fixture_entry(&archive, &files, "bundle-root"),
            origin.url("/archive"),
        );
        let catalogue = fixture_catalogue(model.clone());
        let temp = tempfile::tempdir().unwrap();

        let downloads = store::models_root(temp.path()).join(store::DOWNLOADS_DIR);
        std::fs::create_dir_all(&downloads).unwrap();
        let half = archive.len() / 2;
        std::fs::write(
            downloads.join(store::archive_part_name(&model)),
            &archive[..half],
        )
        .unwrap();
        write_resume(
            &downloads.join(store::resume_name(&model)),
            &ResumeState {
                version: RESUME_VERSION,
                model_id: model.id.clone(),
                archive_sha256: model.archive.sha256.clone(),
                url: model.archive.upstream_url.clone(),
                etag: Some(FIXTURE_ETAG.to_string()),
                last_modified: None,
            },
        )
        .unwrap();

        let dir = install(
            temp.path(),
            &catalogue,
            &catalogue.models[0],
            &origin.policy(),
            &CancelFlag::new(),
            &no_progress(),
        )
        .await
        .expect("an origin that ignores Range must still work");

        assert_eq!(
            origin.seen().first().and_then(|r| r.range_from),
            Some(half as u64),
            "a range must have been attempted"
        );
        // The origin ignored it and sent everything; the partial must have
        // been truncated rather than appended to.
        assert_eq!(origin.served.load(Ordering::SeqCst), archive.len() as u64);
        for (name, body) in &files {
            assert_eq!(&std::fs::read(dir.join(name)).unwrap(), body, "{name}");
        }
    }

    /// Stopping mid-transfer keeps the bytes, and the next run continues them.
    ///
    /// The end-to-end claim the whole resume design exists for, and the one
    /// the cancel-before-the-first-request test cannot make.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelling_mid_transfer_keeps_the_partial_and_the_next_run_resumes_it() {
        let files = fixture_files();
        let archive = build_archive("bundle-root", &files);
        let origin = MockOrigin::start(archive.clone(), Behaviour::Slow);
        let model = aimed_at(
            fixture_entry(&archive, &files, "bundle-root"),
            origin.url("/archive"),
        );
        let catalogue = fixture_catalogue(model.clone());
        let temp = tempfile::tempdir().unwrap();

        // Cancelled on a timer rather than from a progress callback.
        //
        // The origin paces itself — SLOW_PIECES writes with a 60 ms gap, so
        // the body cannot arrive in under ~480 ms however fast the client is —
        // and the chunk loop races every read against the flag. Firing well
        // inside that window therefore lands mid-transfer by construction.
        // Triggering off a progress report instead made the test depend on
        // PROGRESS_INTERVAL, which is a throttle that exists for the UI and is
        // free to change.
        let cancel = CancelFlag::new();
        let trigger = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(120)).await;
            trigger.cancel();
        });
        let err = install(
            temp.path(),
            &catalogue,
            &catalogue.models[0],
            &origin.policy(),
            &cancel,
            &no_progress(),
        )
        .await
        .expect_err("a cancelled install must not report success");
        assert!(is_cancelled_error(&err), "{err:?}");

        // The partial survives — cancelling is "not now", not "throw it away".
        let part = store::models_root(temp.path())
            .join(store::DOWNLOADS_DIR)
            .join(store::archive_part_name(&model));
        let kept = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
        assert!(kept > 0 && kept < archive.len() as u64, "kept {kept} bytes");

        // And a fresh run continues it rather than starting again.
        //
        // The SAME origin, deliberately: the resume sidecar records the url it
        // is a partial of, and a second mock would be on a different port and
        // therefore legitimately not resumable.
        install(
            temp.path(),
            &catalogue,
            &catalogue.models[0],
            &origin.policy(),
            &CancelFlag::new(),
            &no_progress(),
        )
        .await
        .expect("the interrupted download must be resumable");
        assert_eq!(
            origin.seen().get(1).and_then(|r| r.range_from),
            Some(kept),
            "the second run must resume from exactly what was kept"
        );
    }

    /// How soon after Stop a stopped install must have returned.
    ///
    /// "A moment", given room for a loaded test machine. What matters is that
    /// it is far inside `IDLE_TIMEOUT`, which is what a Stop on a stalled
    /// connection used to wait out before reporting a failure.
    const STOP_WITHIN: Duration = Duration::from_secs(2);

    /// How long a stalled-install test waits before failing outright, so a
    /// Stop that does nothing fails in seconds rather than after the idle
    /// timeout.
    const STALL_WATCHDOG: Duration = Duration::from_secs(10);

    /// Press Stop once `parked` says the install is waiting on the network,
    /// and report when it was pressed.
    ///
    /// Keyed to what the install has DONE rather than to a bare timer, so the
    /// Stop lands in the wait under test and not before it. The short pause
    /// after makes it the parked wait that is woken, not the one about to
    /// begin — which the flag would catch even without being able to wake it.
    fn stop_once(
        cancel: &CancelFlag,
        parked: impl Fn() -> bool + Send + 'static,
    ) -> tokio::task::JoinHandle<std::time::Instant> {
        let trigger = cancel.clone();
        tokio::spawn(async move {
            let deadline = std::time::Instant::now() + STALL_WATCHDOG;
            while !parked() {
                assert!(
                    std::time::Instant::now() < deadline,
                    "the install never reached the stall"
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
            trigger.cancel();
            std::time::Instant::now()
        })
    }

    /// A Stop made while nothing is waiting for it is not lost — nothing is
    /// subscribed between two network waits — and it beats a wait that is
    /// already finished.
    #[tokio::test]
    async fn a_stop_made_before_the_wait_still_ends_it() {
        let cancel = CancelFlag::new();
        cancel.clone().cancel();
        assert!(cancel.is_cancelled());
        assert!(cancel.check().is_err_and(|err| is_cancelled_error(&err)));

        let raced = tokio::time::timeout(
            Duration::from_secs(5),
            cancel.race(std::future::pending::<()>()),
        )
        .await
        .expect("a Stop already made must end the wait at once");
        assert!(raced.is_err_and(|err| is_cancelled_error(&err)));
        // Ready on the same poll, and still second: a chunk that happens to
        // be buffered must not carry a stopped transfer one more step.
        assert!(cancel.race(std::future::ready(7)).await.is_err());
        // And it stays made, for every wait after.
        assert!(cancel.race(std::future::ready(7)).await.is_err());
    }

    /// A Stop wakes a wait that is already parked, which is the whole point:
    /// a stalled origin never wakes it any other way.
    #[tokio::test]
    async fn a_stop_during_the_wait_ends_it() {
        let cancel = CancelFlag::new();
        assert_eq!(cancel.race(std::future::ready(7)).await.unwrap(), 7);

        let trigger = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            trigger.cancel();
        });
        let raced = tokio::time::timeout(
            Duration::from_secs(5),
            cancel.race(std::future::pending::<()>()),
        )
        .await
        .expect("a Stop must wake a wait that nothing else will");
        assert!(raced.is_err_and(|err| is_cancelled_error(&err)));
    }

    /// Stop on a transfer that has stalled — headers and a prefix arrived,
    /// then silence on an open connection — ends at once, as a stop, keeping
    /// exactly what arrived. It used to wait out `IDLE_TIMEOUT` with the
    /// status still saying "downloading", and then report a failed download
    /// for something the user had asked for.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stopping_a_stalled_transfer_is_prompt_and_the_next_run_resumes_it() {
        let files = fixture_files();
        let archive = build_archive("bundle-root", &files);
        let at = archive.len() / 2;
        let origin = MockOrigin::start_scripted(
            archive.clone(),
            vec![Behaviour::StallsAt(at), Behaviour::Ranged],
        );
        let model = aimed_at(
            fixture_entry(&archive, &files, "bundle-root"),
            origin.url("/archive"),
        );
        let catalogue = fixture_catalogue(model.clone());
        let temp = tempfile::tempdir().unwrap();
        let (part, sidecar) = download_files(temp.path(), &model);

        let cancel = CancelFlag::new();
        let stopper = {
            let part = part.clone();
            stop_once(&cancel, move || {
                std::fs::metadata(&part).is_ok_and(|m| m.len() == at as u64)
            })
        };
        let phases = PhaseLog::default();
        let err = tokio::time::timeout(
            STALL_WATCHDOG,
            install(
                temp.path(),
                &catalogue,
                &catalogue.models[0],
                &origin.policy(),
                &cancel,
                &phases.sink(),
            ),
        )
        .await
        .expect("Stop must end a stalled transfer, not leave it to the idle timeout")
        .expect_err("a stopped install must not report success");
        let returned = std::time::Instant::now();
        let pressed = stopper.await.unwrap();

        assert!(is_cancelled_error(&err), "a Stop must end as a stop: {err:?}");
        let took = returned.duration_since(pressed);
        assert!(took < STOP_WITHIN, "Stop took {took:?}");
        assert!(!phases.saw(Phase::VerifyingArchive));
        // Exactly what arrived, and the sidecar that makes it resumable.
        assert_eq!(std::fs::read(&part).unwrap(), &archive[..at]);
        assert!(read_resume(&sidecar).is_some(), "a Stop must keep the sidecar");

        install_once(temp.path(), &catalogue, &origin.policy(), &no_progress())
            .await
            .expect("the stopped download must be resumable");
        let resumed = origin.seen().get(1).cloned().unwrap_or_default();
        assert_eq!(resumed.range_from, Some(at as u64));
        assert_eq!(resumed.if_range.as_deref(), Some(FIXTURE_ETAG));
    }

    /// Stop while the origin has the request and has not answered — the
    /// connect and header wait, which the chunk loop never covered — is just
    /// as prompt, and costs nothing: the partial that request was resuming is
    /// left exactly as it was, sidecar and all.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stopping_before_the_origin_answers_is_prompt_and_keeps_the_partial() {
        let files = fixture_files();
        let archive = build_archive("bundle-root", &files);
        let at = archive.len() / 2;
        let origin = MockOrigin::start_scripted(
            archive.clone(),
            vec![Behaviour::Silent, Behaviour::Ranged],
        );
        let model = aimed_at(
            fixture_entry(&archive, &files, "bundle-root"),
            origin.url("/archive"),
        );
        let catalogue = fixture_catalogue(model.clone());
        let temp = tempfile::tempdir().unwrap();
        seed_partial(temp.path(), &model, &archive[..at], &origin.url("/archive"));
        let (part, sidecar) = download_files(temp.path(), &model);
        let sidecar_before = std::fs::read(&sidecar).unwrap();

        let cancel = CancelFlag::new();
        let stopper = {
            let requests = Arc::clone(&origin.requests);
            stop_once(&cancel, move || requests.load(Ordering::SeqCst) >= 1)
        };
        let err = tokio::time::timeout(
            STALL_WATCHDOG,
            install(
                temp.path(),
                &catalogue,
                &catalogue.models[0],
                &origin.policy(),
                &cancel,
                &no_progress(),
            ),
        )
        .await
        .expect("Stop must end a request the origin never answers")
        .expect_err("a stopped install must not report success");
        let returned = std::time::Instant::now();
        let pressed = stopper.await.unwrap();

        assert!(is_cancelled_error(&err), "a Stop must end as a stop: {err:?}");
        let took = returned.duration_since(pressed);
        assert!(took < STOP_WITHIN, "Stop took {took:?}");
        // The request held was the resume, so the stop really did land
        // between asking and being answered.
        assert_eq!(origin.seen().first().and_then(|r| r.range_from), Some(at as u64));
        assert_eq!(std::fs::read(&part).unwrap(), &archive[..at]);
        assert_eq!(std::fs::read(&sidecar).unwrap(), sidecar_before);

        install_once(temp.path(), &catalogue, &origin.policy(), &no_progress())
            .await
            .expect("the partial a Stop left must still resume");
        assert_eq!(origin.seen().get(1).and_then(|r| r.range_from), Some(at as u64));
    }

    /// The partial archive and its resume sidecar, where `install` keeps them.
    fn download_files(app_data: &Path, model: &ModelEntry) -> (PathBuf, PathBuf) {
        let downloads = store::models_root(app_data).join(store::DOWNLOADS_DIR);
        (
            downloads.join(store::archive_part_name(model)),
            downloads.join(store::resume_name(model)),
        )
    }

    /// Stage a prefix of the archive exactly as an interrupted run leaves one:
    /// the bytes, plus a sidecar saying which url they came from.
    fn seed_partial(app_data: &Path, model: &ModelEntry, prefix: &[u8], url: &str) {
        let (part, sidecar) = download_files(app_data, model);
        std::fs::create_dir_all(part.parent().unwrap()).unwrap();
        std::fs::write(&part, prefix).unwrap();
        write_resume(
            &sidecar,
            &ResumeState {
                version: RESUME_VERSION,
                model_id: model.id.clone(),
                archive_sha256: model.archive.sha256.clone(),
                url: url.to_string(),
                etag: Some(FIXTURE_ETAG.to_string()),
                last_modified: None,
            },
        )
        .unwrap();
    }

    /// One `install` of the catalogue's only model, uncancelled.
    async fn install_once(
        app_data: &Path,
        catalogue: &Catalogue,
        policy: &HopPolicy,
        on_progress: &ProgressFn,
    ) -> Result<PathBuf, AppError> {
        install(
            app_data,
            catalogue,
            &catalogue.models[0],
            policy,
            &CancelFlag::new(),
            on_progress,
        )
        .await
    }

    /// The path a mock origin sees for the content-addressed mirror url.
    fn mirror_path(model: &ModelEntry) -> String {
        format!("/sha256/{}/{}", model.archive.sha256, model.archive.file_name)
    }

    /// A transfer that stops mid-body leaves exactly what arrived, with its
    /// sidecar, and the next run asks for only the rest.
    ///
    /// `noticed_by` is a fragment of the logged reason, which is what proves
    /// WHICH path saw the drop: a stream error from the HTTP client, or a body
    /// that ended cleanly short of the catalogue. The outcome is the same
    /// either way, so without it a mock that stopped producing one case would
    /// quietly test the other.
    async fn assert_a_drop_is_resumed(
        drop: Behaviour,
        half: usize,
        archive: Vec<u8>,
        noticed_by: &str,
    ) {
        let files = fixture_files();
        let origin = MockOrigin::start_scripted(archive.clone(), vec![drop, Behaviour::Ranged]);
        let model = aimed_at(
            fixture_entry(&archive, &files, "bundle-root"),
            origin.url("/archive"),
        );
        let catalogue = fixture_catalogue(model.clone());
        let temp = tempfile::tempdir().unwrap();
        let (part, sidecar) = download_files(temp.path(), &model);

        let phases = PhaseLog::default();
        let err = install_once(temp.path(), &catalogue, &origin.policy(), &phases.sink())
            .await
            .expect_err("half an archive cannot install");
        // A connection problem, worded as one — not a checksum failure, which
        // would also tell the user the bytes were thrown away.
        assert_eq!(err.code(), "STT_MODEL_DOWNLOAD_FAILED", "{err:?}");
        assert!(err.to_string().contains(noticed_by), "{err}");
        assert!(
            !phases.saw(Phase::VerifyingArchive),
            "an unfinished transfer was hashed as if it were complete"
        );
        assert_eq!(
            std::fs::read(&part).expect("the partial must survive a dropped connection"),
            &archive[..half],
            "the partial must be exactly the bytes that arrived"
        );
        let state = read_resume(&sidecar).expect("the resume sidecar must survive too");
        assert!(state.matches(&model, &model.archive.upstream_url));
        assert_eq!(state.validator(), Some(FIXTURE_ETAG));

        install_once(temp.path(), &catalogue, &origin.policy(), &no_progress())
            .await
            .expect("the retry must finish the interrupted download");
        assert_eq!(
            origin.seen().get(1),
            Some(&SeenRequest {
                range_from: Some(half as u64),
                if_range: Some(FIXTURE_ETAG.to_string()),
            }),
            "the retry must be a conditional range from exactly what was kept"
        );
        assert_eq!(
            origin.served.load(Ordering::SeqCst),
            archive.len() as u64,
            "the two attempts together must transfer the archive exactly once"
        );
        assert!(!part.exists() && !sidecar.exists(), "a finished install leaves no download behind");
    }

    /// The issue as reported: the origin promises the whole body, sends half,
    /// and closes. That used to delete the half and restart from byte zero.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_dropped_connection_keeps_the_partial_and_the_next_run_resumes_it() {
        let archive = build_archive("bundle-root", &fixture_files());
        let half = archive.len() / 2;
        assert_a_drop_is_resumed(Behaviour::DropsAt(half), half, archive, "stream failed").await;
    }

    /// A body with no `Content-Length` that stops early looks complete to the
    /// HTTP client. Only the catalogue's size says otherwise — and that is a
    /// transfer that ended, not bytes that were wrong.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_dropped_body_with_no_length_keeps_the_partial_and_resumes() {
        let archive = build_archive("bundle-root", &fixture_files());
        let half = archive.len() / 2;
        assert_a_drop_is_resumed(Behaviour::UnframedDropsAt(half), half, archive, "received")
            .await;
    }

    /// A long download on a bad connection drops more than once. The resumed
    /// transfer must leave a sidecar as resumable as the first one did — a
    /// 206 is proof of range support even without `Accept-Ranges`, which the
    /// mock deliberately omits from every 206.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_resumed_download_that_drops_again_resumes_again() {
        let files = fixture_files();
        let archive = build_archive("bundle-root", &files);
        let (first, second) = (archive.len() / 3, archive.len() * 2 / 3);
        let origin = MockOrigin::start_scripted(
            archive.clone(),
            vec![Behaviour::DropsAt(first), Behaviour::DropsAt(second), Behaviour::Ranged],
        );
        let model = aimed_at(
            fixture_entry(&archive, &files, "bundle-root"),
            origin.url("/archive"),
        );
        let catalogue = fixture_catalogue(model.clone());
        let temp = tempfile::tempdir().unwrap();
        let (part, sidecar) = download_files(temp.path(), &model);

        for kept in [first, second] {
            install_once(temp.path(), &catalogue, &origin.policy(), &no_progress())
                .await
                .expect_err("a dropped transfer cannot install");
            assert_eq!(std::fs::read(&part).unwrap(), &archive[..kept]);
            assert_eq!(
                read_resume(&sidecar).as_ref().and_then(ResumeState::validator),
                Some(FIXTURE_ETAG),
                "the sidecar after {kept} bytes must still carry a validator"
            );
        }
        install_once(temp.path(), &catalogue, &origin.policy(), &no_progress())
            .await
            .expect("the third attempt must finish the download");

        let conditional = |from: usize| SeenRequest {
            range_from: Some(from as u64),
            if_range: Some(FIXTURE_ETAG.to_string()),
        };
        assert_eq!(
            origin.seen(),
            vec![SeenRequest::default(), conditional(first), conditional(second)]
        );
        assert_eq!(origin.served.load(Ordering::SeqCst), archive.len() as u64);
    }

    /// A mirror that sends exactly the archive's length of WRONG bytes and
    /// then errors has not left a partial — it has left a full-length file,
    /// and that is judged in the mirror's own turn. Kept instead, upstream's
    /// turn would take it for a complete archive, fail the digest, and discard
    /// it without ever asking upstream for anything.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_mirror_that_errors_after_a_full_length_of_bad_bytes_still_reaches_upstream() {
        let files = fixture_files();
        let archive = build_archive("bundle-root", &files);
        let upstream = MockOrigin::start(archive.clone(), Behaviour::Ranged);
        let model = aimed_at(
            fixture_entry(&archive, &files, "bundle-root"),
            upstream.url("/archive"),
        );
        let mut catalogue = fixture_catalogue(model.clone());
        // Promises one byte more than the archive, sends exactly the archive's
        // length of rubbish, and hangs up: a stream error at full length.
        let mirror = MockOrigin::start(
            vec![0x5Au8; archive.len() + 1],
            Behaviour::DropsAt(archive.len()),
        );
        catalogue.mirror_base_url = Some(format!("http://127.0.0.1:{}", mirror.port));
        let policy = HopPolicy {
            labels: MODEL_HOP_LABELS,
            exempt_authority: Some(format!("127.0.0.1:{}", mirror.port)),
        };
        let _ = &upstream;
        let temp = tempfile::tempdir().unwrap();
        let (part, sidecar) = download_files(temp.path(), &model);

        let err = install_once(temp.path(), &catalogue, &policy, &no_progress())
            .await
            .expect_err("upstream is not exempt under this policy");
        // Upstream was actually DIALLED, which is the only way to reach the
        // policy's refusal. The shortcut would have reported a checksum.
        assert_eq!(err.code(), "STT_MODEL_URL_INSECURE", "{err:?}");
        assert!(mirror.requests.load(Ordering::SeqCst) >= 1, "the mirror must have been tried");
        assert!(!part.exists(), "a full-length file that failed its digest must be discarded");
        assert!(!sidecar.exists(), "and its sidecar with it");
    }

    /// A request that never gets a body has judged none of the bytes already
    /// on disk, so a refused or dead origin must not cost the partial.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_failed_request_keeps_the_partial_it_was_resuming() {
        let files = fixture_files();
        let archive = build_archive("bundle-root", &files);
        let half = archive.len() / 2;

        for failure in [Behaviour::Unavailable, Behaviour::Dead] {
            let origin =
                MockOrigin::start_scripted(archive.clone(), vec![failure, Behaviour::Ranged]);
            let model = aimed_at(
                fixture_entry(&archive, &files, "bundle-root"),
                origin.url("/archive"),
            );
            let catalogue = fixture_catalogue(model.clone());
            let temp = tempfile::tempdir().unwrap();
            seed_partial(temp.path(), &model, &archive[..half], &model.archive.upstream_url);
            let (part, sidecar) = download_files(temp.path(), &model);

            let err = install_once(temp.path(), &catalogue, &origin.policy(), &no_progress())
                .await
                .expect_err("an origin that does not answer cannot install");
            assert_eq!(err.code(), "STT_MODEL_DOWNLOAD_FAILED", "{err:?}");
            assert_eq!(
                std::fs::read(&part).unwrap(),
                &archive[..half],
                "a failed request must leave the partial untouched"
            );
            assert!(read_resume(&sidecar).is_some(), "and its sidecar");

            install_once(temp.path(), &catalogue, &origin.policy(), &no_progress())
                .await
                .expect("the partial must still be resumable once the origin answers");
            assert_eq!(
                origin.seen().last(),
                Some(&SeenRequest {
                    range_from: Some(half as u64),
                    if_range: Some(FIXTURE_ETAG.to_string()),
                }),
            );
        }
    }

    /// A mirror that drops is still a source miss: upstream is tried in the
    /// same run, and — because a prefix from one url is never resumed against
    /// another — it starts from zero rather than appending to the mirror's
    /// bytes. A mirror that always truncates must not be able to make a model
    /// uninstallable.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_mirror_that_drops_still_falls_through_to_upstream() {
        let files = fixture_files();
        let archive = build_archive("bundle-root", &files);
        let half = archive.len() / 2;
        let origin = MockOrigin::start_scripted(
            archive.clone(),
            vec![Behaviour::DropsAt(half), Behaviour::Ranged],
        );
        let model = aimed_at(
            fixture_entry(&archive, &files, "bundle-root"),
            origin.url("/archive"),
        );
        let mut catalogue = fixture_catalogue(model.clone());
        catalogue.mirror_base_url = Some(format!("http://127.0.0.1:{}", origin.port));
        let temp = tempfile::tempdir().unwrap();

        let dir = install_once(temp.path(), &catalogue, &origin.policy(), &no_progress())
            .await
            .expect("upstream must finish what the mirror dropped");
        assert_eq!(
            origin.paths(),
            vec![mirror_path(&model), "/archive".to_string()],
            "the second request must be upstream's, not the mirror again"
        );
        assert_eq!(
            origin.seen(),
            vec![SeenRequest::default(), SeenRequest::default()],
            "upstream must not be asked to continue the mirror's partial"
        );
        for (name, body) in &files {
            assert_eq!(&std::fs::read(dir.join(name)).unwrap(), body, "{name}");
        }
    }

    /// A mirror drops, and upstream cannot be reached either — the ordinary
    /// shape of a Wi-Fi drop, which takes out both. The mirror's partial must
    /// survive upstream's failure to connect, and the next run continues it.
    ///
    /// The partial used to be deleted before upstream's request was even
    /// sent, because it is not upstream's to resume.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_failed_upstream_keeps_the_mirror_partial() {
        let files = fixture_files();
        let archive = build_archive("bundle-root", &files);
        let half = archive.len() / 2;
        let origin = MockOrigin::start_scripted(
            archive.clone(),
            vec![Behaviour::DropsAt(half), Behaviour::Unavailable, Behaviour::Ranged],
        );
        let model = aimed_at(
            fixture_entry(&archive, &files, "bundle-root"),
            origin.url("/archive"),
        );
        let mut catalogue = fixture_catalogue(model.clone());
        catalogue.mirror_base_url = Some(format!("http://127.0.0.1:{}", origin.port));
        let mirror_url = archive_urls(&catalogue, &model)[0].clone();
        let temp = tempfile::tempdir().unwrap();
        let (part, sidecar) = download_files(temp.path(), &model);

        let err = install_once(temp.path(), &catalogue, &origin.policy(), &no_progress())
            .await
            .expect_err("neither source finished");
        assert_eq!(err.code(), "STT_MODEL_DOWNLOAD_FAILED", "{err:?}");
        assert_eq!(
            origin.paths(),
            vec![mirror_path(&model), "/archive".to_string()],
            "upstream must still have been tried"
        );
        assert_eq!(
            std::fs::read(&part).expect("the mirror's partial must survive"),
            &archive[..half]
        );
        assert!(
            read_resume(&sidecar).is_some_and(|state| state.matches(&model, &mirror_url)),
            "the sidecar must still describe the mirror's partial"
        );

        install_once(temp.path(), &catalogue, &origin.policy(), &no_progress())
            .await
            .expect("the mirror's partial must be resumable on the next run");
        assert_eq!(
            origin.seen().get(2),
            Some(&SeenRequest {
                range_from: Some(half as u64),
                if_range: Some(FIXTURE_ETAG.to_string()),
            }),
            "the next run must continue the mirror's partial, not restart it"
        );
        assert_eq!(origin.paths().get(2), Some(&mirror_path(&model)));
    }

    /// The mirror image of the above: an upstream partial is not lost to a
    /// mirror that cannot be reached, and upstream then continues it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_failed_mirror_keeps_an_upstream_partial() {
        let files = fixture_files();
        let archive = build_archive("bundle-root", &files);
        let half = archive.len() / 2;
        let origin = MockOrigin::start_scripted(
            archive.clone(),
            vec![Behaviour::Unavailable, Behaviour::Ranged],
        );
        let model = aimed_at(
            fixture_entry(&archive, &files, "bundle-root"),
            origin.url("/archive"),
        );
        let mut catalogue = fixture_catalogue(model.clone());
        catalogue.mirror_base_url = Some(format!("http://127.0.0.1:{}", origin.port));
        let temp = tempfile::tempdir().unwrap();
        seed_partial(temp.path(), &model, &archive[..half], &model.archive.upstream_url);

        install_once(temp.path(), &catalogue, &origin.policy(), &no_progress())
            .await
            .expect("upstream must resume its own partial");
        assert_eq!(origin.paths(), vec![mirror_path(&model), "/archive".to_string()]);
        assert_eq!(
            origin.seen(),
            vec![
                // The mirror is not the partial's url, so it is asked for the
                // whole archive — and fails before replacing anything.
                SeenRequest::default(),
                SeenRequest {
                    range_from: Some(half as u64),
                    if_range: Some(FIXTURE_ETAG.to_string()),
                },
            ]
        );
        assert_eq!(
            origin.served.load(Ordering::SeqCst),
            (archive.len() - half) as u64,
            "only the tail may have been transferred"
        );
    }

    /// A response that said how long it was and delivered all of it is the
    /// origin's whole file. Shorter than the catalogue's archive, it is the
    /// wrong file rather than an unfinished one, and is not kept to be resumed
    /// past its own end.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_complete_response_shorter_than_the_catalogue_is_discarded() {
        let files = fixture_files();
        let archive = build_archive("bundle-root", &files);
        let origin = MockOrigin::start(archive.clone(), Behaviour::ShortAt(archive.len() / 2));
        let model = aimed_at(
            fixture_entry(&archive, &files, "bundle-root"),
            origin.url("/archive"),
        );
        let catalogue = fixture_catalogue(model.clone());
        let temp = tempfile::tempdir().unwrap();
        let (part, sidecar) = download_files(temp.path(), &model);

        let err = install_once(temp.path(), &catalogue, &origin.policy(), &no_progress())
            .await
            .expect_err("a short file is not the archive");
        assert_eq!(err.code(), "STT_MODEL_CORRUPT", "{err:?}");
        assert!(!part.exists(), "a complete wrong file must not be kept");
        assert!(!sidecar.exists(), "nor its sidecar");
    }

    /// An origin that refuses to continue a partial will refuse it again on
    /// every retry. Keeping the partial would make that permanent; dropping it
    /// lets the next run start cleanly.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_refused_range_discards_the_partial_and_the_next_run_starts_clean() {
        let files = fixture_files();
        let archive = build_archive("bundle-root", &files);
        let half = archive.len() / 2;
        let origin = MockOrigin::start_scripted(
            archive.clone(),
            vec![Behaviour::RangeNotSatisfiable, Behaviour::Ranged],
        );
        let model = aimed_at(
            fixture_entry(&archive, &files, "bundle-root"),
            origin.url("/archive"),
        );
        let catalogue = fixture_catalogue(model.clone());
        let temp = tempfile::tempdir().unwrap();
        seed_partial(temp.path(), &model, &archive[..half], &model.archive.upstream_url);
        let (part, sidecar) = download_files(temp.path(), &model);

        install_once(temp.path(), &catalogue, &origin.policy(), &no_progress())
            .await
            .expect_err("a refused range does not install");
        assert!(!part.exists(), "a partial the origin will not continue must be dropped");
        assert!(!sidecar.exists(), "and its sidecar with it");

        install_once(temp.path(), &catalogue, &origin.policy(), &no_progress())
            .await
            .expect("a clean start must then succeed");
        assert_eq!(
            origin.seen().get(1),
            Some(&SeenRequest::default()),
            "the next run must not ask for the refused range again"
        );
    }

    /// An origin whose file ends exactly where our partial does, and which
    /// answers the resume with an EMPTY 206 instead of a 416. Nothing arrives,
    /// nothing errors, and the same request would get the same answer on
    /// every retry — so the partial must go, as it would have for the 416.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_empty_range_answer_discards_the_partial_instead_of_repeating_forever() {
        let files = fixture_files();
        let archive = build_archive("bundle-root", &files);
        let half = archive.len() / 2;
        // `ShortAt(half)` asked for `bytes=half-` serves a zero-length slice:
        // `206`, `Content-Length: 0`, `Content-Range: bytes half-(half-1)/half`.
        let origin = MockOrigin::start_scripted(
            archive.clone(),
            vec![Behaviour::ShortAt(half), Behaviour::Ranged],
        );
        let model = aimed_at(
            fixture_entry(&archive, &files, "bundle-root"),
            origin.url("/archive"),
        );
        let catalogue = fixture_catalogue(model.clone());
        let temp = tempfile::tempdir().unwrap();
        seed_partial(temp.path(), &model, &archive[..half], &model.archive.upstream_url);
        let (part, sidecar) = download_files(temp.path(), &model);

        install_once(temp.path(), &catalogue, &origin.policy(), &no_progress())
            .await
            .expect_err("an empty answer does not install");
        assert_eq!(origin.seen().first().and_then(|r| r.range_from), Some(half as u64));
        assert!(!part.exists(), "a partial the origin has nothing past must be dropped");
        assert!(!sidecar.exists(), "and its sidecar with it");

        install_once(temp.path(), &catalogue, &origin.policy(), &no_progress())
            .await
            .expect("a clean start must then succeed");
        assert_eq!(origin.seen().get(1), Some(&SeenRequest::default()));
    }

    /// Bytes that fail the digest never reach a decompressor.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_archive_that_fails_its_digest_is_never_unpacked() {
        let files = fixture_files();
        let archive = build_archive("bundle-root", &files);
        // Serve something else entirely, at the same length.
        let served = vec![0x5Au8; archive.len()];
        let origin = MockOrigin::start(served, Behaviour::Corrupt);
        let model = aimed_at(
            fixture_entry(&archive, &files, "bundle-root"),
            origin.url("/archive"),
        );
        let catalogue = fixture_catalogue(model.clone());
        let temp = tempfile::tempdir().unwrap();

        let phases = PhaseLog::default();
        let err = install(
            temp.path(),
            &catalogue,
            &catalogue.models[0],
            &origin.policy(),
            &CancelFlag::new(),
            &phases.sink(),
        )
        .await
        .expect_err("a digest mismatch must stop the install");
        assert_eq!(err.code(), "STT_MODEL_CORRUPT", "{err:?}");

        // The claim is that bad bytes never reach a DECOMPRESSOR, not merely
        // that they end up uninstalled. Extract-then-clean-up would satisfy
        // the absence check below on its own.
        assert!(
            !phases.saw(Phase::Extracting),
            "the archive was unpacked before its digest was checked"
        );
        assert!(
            !model.install_path(&store::models_root(temp.path())).exists(),
            "nothing may be installed from an archive that failed its digest"
        );
        // Kept bytes would be resumed into and fail identically forever.
        let downloads = store::models_root(temp.path()).join(store::DOWNLOADS_DIR);
        assert!(
            !downloads.join(store::archive_part_name(&model)).exists(),
            "bytes that failed the digest must be discarded, not resumed"
        );
        assert!(
            !downloads.join(store::resume_name(&model)).exists(),
            "a sidecar must not outlive the bytes it describes"
        );
    }

    /// A body longer than the catalogue promises is cut off mid-stream rather
    /// than filling the disk and being rejected afterwards.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_body_longer_than_the_catalogue_is_refused() {
        let files = fixture_files();
        let archive = build_archive("bundle-root", &files);
        let mut oversized = archive.clone();
        oversized.extend_from_slice(&vec![0u8; archive.len()]);
        let origin = MockOrigin::start(oversized, Behaviour::Corrupt);
        let model = aimed_at(
            fixture_entry(&archive, &files, "bundle-root"),
            origin.url("/archive"),
        );
        let catalogue = fixture_catalogue(model);
        let temp = tempfile::tempdir().unwrap();

        let model_for_paths = catalogue.models[0].clone();
        let err = install(
            temp.path(),
            &catalogue,
            &catalogue.models[0],
            &origin.policy(),
            &CancelFlag::new(),
            &no_progress(),
        )
        .await
        .expect_err("an over-long body must be refused");
        assert_eq!(err.code(), "STT_MODEL_CORRUPT", "{err:?}");

        // The claim is a bound applied PER CHUNK, not a size check after the
        // fact. Nothing longer than the catalogue promises may ever have
        // reached the disk — otherwise a hostile origin fills it before the
        // check that would have stopped it.
        let part = store::models_root(temp.path())
            .join(store::DOWNLOADS_DIR)
            .join(store::archive_part_name(&model_for_paths));
        let written = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
        assert!(
            written <= archive.len() as u64,
            "wrote {written} bytes for a {}-byte archive",
            archive.len()
        );
        // And what did reach it is not kept: an overrun is not an interrupted
        // transfer, and a resume would ask the same origin for the same excess.
        assert!(!part.exists(), "bytes from an overrunning origin must be discarded");
        assert!(
            !part.with_file_name(store::resume_name(&model_for_paths)).exists(),
            "and so must their sidecar"
        );
    }

    /// Only catalogue-named members are written. A bundle's extra payload —
    /// test audio, scripts, anything with a path that climbs — never lands.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn only_catalogue_named_members_are_extracted() {
        let mut members = fixture_files();
        members.push(("test_wavs/0.wav", b"not a model file".to_vec()));
        let archive = build_archive_with(
            "bundle-root",
            &members,
            // Traversal, an absolute path, and a name that matches a wanted
            // file but sits outside the archive root. None is in the
            // catalogue's member list, so none is written.
            &[
                ("../escape.txt", b"traversal".to_vec()),
                ("/etc/escape.txt", b"absolute".to_vec()),
                ("elsewhere/encoder.int8.onnx", b"wrong root".to_vec()),
            ],
        );
        let origin = MockOrigin::start(archive.clone(), Behaviour::Ranged);
        // The catalogue names only the four real files.
        let model = aimed_at(
            fixture_entry(&archive, &fixture_files(), "bundle-root"),
            origin.url("/archive"),
        );
        let catalogue = fixture_catalogue(model);
        let temp = tempfile::tempdir().unwrap();

        let dir = install(
            temp.path(),
            &catalogue,
            &catalogue.models[0],
            &origin.policy(),
            &CancelFlag::new(),
            &no_progress(),
        )
        .await
        .expect("extra members must be ignored, not fatal");

        assert!(!dir.join("test_wavs").exists(), "extra members must not land");
        assert!(!dir.join("0.wav").exists());
        let root = store::models_root(temp.path());
        // `../escape.txt` resolved against the staging directory would land
        // here; an absolute member would land at its own path. Neither may.
        for candidate in [
            root.join("escape.txt"),
            temp.path().join("escape.txt"),
            dir.join("escape.txt"),
            std::path::PathBuf::from("/etc/escape.txt"),
        ] {
            assert!(
                !candidate.exists(),
                "a traversing or absolute member was written to {}",
                candidate.display()
            );
        }
        // Only the catalogue's files, the notice, the licence text and the seal.
        let mut found: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        found.sort();
        assert_eq!(
            found,
            vec![
                ".candidcue-model.json",
                "ATTRIBUTION.md",
                "LICENSE-Apache-2.0.txt",
                "decoder.onnx",
                "encoder.int8.onnx",
                "joiner.int8.onnx",
                "tokens.txt",
            ]
        );
    }

    /// A file whose hash does not match must leave any existing installation
    /// exactly where it was — the mixed-model failure the staging order and
    /// the verify-all-before-move rule exist to prevent.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_file_hash_mismatch_leaves_the_previous_install_untouched() {
        let files = fixture_files();
        let archive = build_archive("bundle-root", &files);
        let origin = MockOrigin::start(archive.clone(), Behaviour::Ranged);
        // A catalogue claiming a different digest for one member than the
        // archive actually carries.
        let mut model = fixture_entry(&archive, &files, "bundle-root");
        model.files[1].sha256 = "0".repeat(64);
        let model = aimed_at(model, origin.url("/archive"));
        let catalogue = fixture_catalogue(model.clone());
        let temp = tempfile::tempdir().unwrap();

        // A previous installation that genuinely RESOLVES: complete, sealed,
        // and detectable. A lone sentinel file would prove only that the
        // directory was not deleted, not that a usable model survived.
        let root = store::models_root(temp.path());
        let installed = model.install_path(&root);
        write_model_dir(&installed, b"OLD");
        store::write_seal(&installed, &model).unwrap();

        let err = install(
            temp.path(),
            &catalogue,
            &catalogue.models[0],
            &origin.policy(),
            &CancelFlag::new(),
            &no_progress(),
        )
        .await
        .expect_err("a per-file digest mismatch must fail the install");
        assert_eq!(err.code(), "STT_MODEL_CORRUPT", "{err:?}");

        assert_eq!(
            std::fs::read(installed.join("encoder.int8.onnx")).unwrap(),
            b"OLD",
            "the working install must survive a failed replacement"
        );
        // Still the model the resolver would pick — the property that
        // actually matters to a presenter about to start a take.
        let resolved = store::resolve(temp.path(), None, &model)
            .expect("the previous model must still resolve after a failed replacement");
        assert_eq!(resolved.source, store::ModelSource::Downloaded);

        let leftovers: Vec<String> = std::fs::read_dir(&root)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| {
                name.starts_with(store::STAGING_PREFIX) || name.starts_with(store::BACKUP_PREFIX)
            })
            .collect();
        assert!(
            leftovers.is_empty(),
            "failed staging and backups must be swept, found {leftovers:?}"
        );
    }

    /// A replacement that fails its shape check must leave the previous model
    /// installed.
    ///
    /// This is the PRE-swap path: the staged model passes every per-file
    /// digest and then fails `ModelFiles::detect` while still in staging, so
    /// nothing has been renamed. The post-swap path is
    /// `an_unsealed_target_beside_a_sealed_backup_is_repaired` below — an
    /// earlier version of this test claimed to cover it and did not, because
    /// the staged check rejects the model before any rename happens.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_replacement_that_fails_validation_leaves_the_previous_model_installed() {
        // A catalogue whose files do not include a joiner: every digest
        // matches, so verification passes, and `ModelFiles::detect` then
        // refuses the result.
        let files = vec![
            ("encoder.int8.onnx", b"encoder-graph-bytes".to_vec()),
            ("tokens.txt", b"<blk> 0\n".to_vec()),
        ];
        let archive = build_archive("bundle-root", &files);
        let origin = MockOrigin::start(archive.clone(), Behaviour::Ranged);
        let model = aimed_at(
            fixture_entry(&archive, &files, "bundle-root"),
            origin.url("/archive"),
        );
        let catalogue = fixture_catalogue(model.clone());
        let temp = tempfile::tempdir().unwrap();

        let root = store::models_root(temp.path());
        let installed = model.install_path(&root);
        write_model_dir(&installed, b"OLD");
        store::write_seal(&installed, &model).unwrap();

        let err = install(
            temp.path(),
            &catalogue,
            &catalogue.models[0],
            &origin.policy(),
            &CancelFlag::new(),
            &no_progress(),
        )
        .await
        .expect_err("a model that cannot load must not install");
        assert_eq!(err.code(), "STT_MODEL_CORRUPT", "{err:?}");

        let resolved = store::resolve(temp.path(), None, &model)
            .expect("the previous model must be restored");
        assert_eq!(resolved.source, store::ModelSource::Downloaded);
        assert_eq!(
            std::fs::read(installed.join("joiner.int8.onnx")).unwrap(),
            b"OLD",
            "the restored model must be the whole previous one"
        );
    }

    /// A crash between moving the old model aside and renaming the new one in
    /// leaves no model and a full backup. Startup puts it back.
    #[test]
    fn an_interrupted_commit_is_recovered_on_the_next_launch() {
        let files = fixture_files();
        let archive = build_archive("bundle-root", &files);
        let model = fixture_entry(&archive, &files, "bundle-root");
        let temp = tempfile::tempdir().unwrap();
        let root = store::models_root(temp.path());

        // Exactly the state a crash in that window leaves behind.
        let backup = store::backup_path(&root, &model);
        write_model_dir(&backup, b"OLD");
        store::write_seal(&backup, &model).unwrap();

        assert!(
            store::resolve(temp.path(), None, &model).is_none(),
            "the model is genuinely unreachable before recovery"
        );
        assert!(store::recover_backup(&root, &model).unwrap());
        let resolved = store::resolve(temp.path(), None, &model)
            .expect("recovery must make the previous model resolvable again");
        assert_eq!(resolved.source, store::ModelSource::Downloaded);
    }

    /// Recovery never disturbs a model that is properly installed.
    #[test]
    fn recovery_leaves_a_sealed_model_alone() {
        let files = fixture_files();
        let archive = build_archive("bundle-root", &files);
        let model = fixture_entry(&archive, &files, "bundle-root");
        let temp = tempfile::tempdir().unwrap();
        let root = store::models_root(temp.path());

        // A finished install: complete, detectable and sealed.
        let installed = model.install_path(&root);
        write_model_dir(&installed, b"CURRENT");
        store::write_seal(&installed, &model).unwrap();
        let backup = store::backup_path(&root, &model);
        write_model_dir(&backup, b"OLD");
        store::write_seal(&backup, &model).unwrap();

        assert!(!store::recover_backup(&root, &model).unwrap());
        assert_eq!(
            std::fs::read(installed.join("encoder.int8.onnx")).unwrap(),
            b"CURRENT"
        );
    }

    /// The POST-swap crash window: the staged model was renamed into place and
    /// the process died before it could be sealed.
    ///
    /// The target looks complete and was never proven; the backup beside it
    /// was. Preferring the target because it merely EXISTS would keep the
    /// unproven copy and delete the working one — which is what "restore only
    /// when the target is absent" did, and why the seal is the test.
    #[test]
    fn an_unsealed_target_beside_a_sealed_backup_is_repaired() {
        let files = fixture_files();
        let archive = build_archive("bundle-root", &files);
        let model = fixture_entry(&archive, &files, "bundle-root");
        let temp = tempfile::tempdir().unwrap();
        let root = store::models_root(temp.path());

        let target = model.install_path(&root);
        write_model_dir(&target, b"NEW-BUT-UNPROVEN");
        let backup = store::backup_path(&root, &model);
        write_model_dir(&backup, b"OLD-BUT-PROVEN");
        store::write_seal(&backup, &model).unwrap();

        assert!(
            store::resolve(temp.path(), None, &model).is_none(),
            "an unsealed target must not resolve on its own"
        );
        assert!(store::recover_backup(&root, &model).unwrap());

        let resolved = store::resolve(temp.path(), None, &model)
            .expect("the proven model must be back in place");
        assert_eq!(resolved.source, store::ModelSource::Downloaded);
        assert_eq!(
            std::fs::read(target.join("encoder.int8.onnx")).unwrap(),
            b"OLD-BUT-PROVEN",
            "the PROVEN copy must win, not the one that merely exists"
        );
    }

    /// A backup survives until the model it protects is actually installed.
    ///
    /// The sweep used to delete it on the strength of "we are about to install
    /// anyway", which threw away a working model to make room for one that had
    /// not been downloaded yet — and if that download then failed, the user
    /// had neither.
    #[test]
    fn a_backup_is_kept_until_the_target_is_sealed() {
        let files = fixture_files();
        let archive = build_archive("bundle-root", &files);
        let model = fixture_entry(&archive, &files, "bundle-root");
        let temp = tempfile::tempdir().unwrap();
        let root = store::models_root(temp.path());
        let backup = store::backup_path(&root, &model);
        write_model_dir(&backup, b"OLD");
        store::write_seal(&backup, &model).unwrap();

        // Nothing installed yet: the backup is the only good copy.
        store::clear_stale(temp.path(), &model).unwrap();
        assert!(backup.is_dir(), "the only working copy must not be swept");

        // Once the replacement is sealed, it is genuinely redundant.
        let target = model.install_path(&root);
        write_model_dir(&target, b"NEW");
        store::write_seal(&target, &model).unwrap();
        store::clear_stale(temp.path(), &model).unwrap();
        assert!(!backup.exists(), "a superseded backup must be swept");
    }

    /// An archive missing a file the catalogue requires is refused, rather
    /// than installing a model that is short a graph.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_archive_missing_a_required_file_is_refused() {
        let all = fixture_files();
        let archive = build_archive("bundle-root", &all[..3]);
        let origin = MockOrigin::start(archive.clone(), Behaviour::Ranged);
        let model = aimed_at(
            fixture_entry(&archive, &all, "bundle-root"),
            origin.url("/archive"),
        );
        let catalogue = fixture_catalogue(model);
        let temp = tempfile::tempdir().unwrap();

        let err = install(
            temp.path(),
            &catalogue,
            &catalogue.models[0],
            &origin.policy(),
            &CancelFlag::new(),
            &no_progress(),
        )
        .await
        .expect_err("a short archive must be refused");
        assert_eq!(err.code(), "STT_MODEL_CORRUPT", "{err:?}");
    }

    /// Cancelling keeps the partial: stopping is usually "not now".
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelling_reports_cancellation_and_installs_nothing() {
        let files = fixture_files();
        let archive = build_archive("bundle-root", &files);
        let origin = MockOrigin::start(archive.clone(), Behaviour::Ranged);
        let model = aimed_at(
            fixture_entry(&archive, &files, "bundle-root"),
            origin.url("/archive"),
        );
        let catalogue = fixture_catalogue(model.clone());
        let temp = tempfile::tempdir().unwrap();

        let cancel = CancelFlag::new();
        cancel.cancel();
        let err = install(
            temp.path(),
            &catalogue,
            &catalogue.models[0],
            &origin.policy(),
            &cancel,
            &no_progress(),
        )
        .await
        .expect_err("a cancelled install must not report success");

        assert!(is_cancelled_error(&err), "{err:?}");
        assert!(!model.install_path(&store::models_root(temp.path())).exists());
    }

    /// The mirror buys availability, not integrity — so a mirror that is down
    /// must fall through to upstream rather than fail the install.
    ///
    /// The mirror here is a REACHABLE host that drops the connection, not a
    /// url the hop guard refuses before opening a socket. Those are different
    /// failures and only the first one exercises the network fallback: an
    /// earlier version pointed at `127.0.0.1:1` and merely proved that a
    /// rejected first candidate is skipped.
    /// A reachable mirror that drops the connection must not end the search.
    ///
    /// The mirror is exempted (so it is genuinely dialled and genuinely fails
    /// at the network layer) and upstream is not (so reaching it produces a
    /// distinctive policy refusal). The refusal IS the proof of fallthrough:
    /// stopping at the mirror would have reported a download failure instead.
    /// One policy can only exempt one authority, which is what makes this
    /// two-outcome shape the cheapest honest test.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_dead_mirror_is_not_the_end_of_the_search() {
        let files = fixture_files();
        let archive = build_archive("bundle-root", &files);
        let upstream = MockOrigin::start(archive.clone(), Behaviour::Ranged);
        let mirror = MockOrigin::start(Vec::new(), Behaviour::Dead);
        let model = aimed_at(
            fixture_entry(&archive, &files, "bundle-root"),
            upstream.url("/archive"),
        );
        let mut catalogue = fixture_catalogue(model);
        catalogue.mirror_base_url = Some(format!("http://127.0.0.1:{}", mirror.port));
        let temp = tempfile::tempdir().unwrap();

        let policy = HopPolicy {
            labels: MODEL_HOP_LABELS,
            exempt_authority: Some(format!("127.0.0.1:{}", mirror.port)),
        };

        let err = install(
            temp.path(),
            &catalogue,
            &catalogue.models[0],
            &policy,
            &CancelFlag::new(),
            &no_progress(),
        )
        .await
        .expect_err("upstream is not exempt under this policy");

        assert!(
            mirror.requests.load(Ordering::SeqCst) >= 1,
            "the mirror must actually have been dialled"
        );
        assert_eq!(
            err.code(),
            "STT_MODEL_URL_INSECURE",
            "the search stopped at the mirror instead of moving on: {err:?}"
        );
    }

    /// A mirror serving the right NUMBER of wrong bytes must not end the
    /// search: the digest fails, and upstream still has the bytes we want.
    ///
    /// Verification used to happen after the url loop, so the first candidate
    /// that produced a complete-looking file won — and a bad mirror could make
    /// a model permanently uninstallable.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_mirror_serving_corrupt_bytes_falls_through_to_upstream() {
        let files = fixture_files();
        let archive = build_archive("bundle-root", &files);
        let upstream = MockOrigin::start(archive.clone(), Behaviour::Ranged);
        let model = aimed_at(
            fixture_entry(&archive, &files, "bundle-root"),
            upstream.url("/archive"),
        );
        let mut catalogue = fixture_catalogue(model.clone());
        let temp = tempfile::tempdir().unwrap();

        // A mirror serving the right NUMBER of bytes and the wrong ones. Only
        // the digest can tell the difference, which is the point.
        let corrupt = MockOrigin::start(vec![0x5Au8; archive.len()], Behaviour::Corrupt);
        catalogue.mirror_base_url = Some(format!("http://127.0.0.1:{}", corrupt.port));
        let policy = HopPolicy {
            labels: MODEL_HOP_LABELS,
            exempt_authority: Some(format!("127.0.0.1:{}", corrupt.port)),
        };
        let _ = &upstream;

        let err = install(
            temp.path(),
            &catalogue,
            &catalogue.models[0],
            &policy,
            &CancelFlag::new(),
            &no_progress(),
        )
        .await
        .expect_err("upstream is not exempt under this policy");

        assert!(
            corrupt.requests.load(Ordering::SeqCst) >= 1,
            "the mirror must have been tried"
        );
        // It did NOT stop at the mirror's digest failure — it went on to the
        // next candidate, where the policy refuses the un-exempt authority.
        assert_eq!(err.code(), "STT_MODEL_URL_INSECURE", "{err:?}");
        // And the bad bytes were not kept to be mistaken for a resumable or
        // complete archive next time.
        let part = store::models_root(temp.path())
            .join(store::DOWNLOADS_DIR)
            .join(store::archive_part_name(&model));
        assert!(!part.exists(), "bytes that failed the digest must be discarded");
    }

    /// A sidecar describing a different archive must not be resumed into.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_partial_from_a_different_archive_is_discarded() {
        let files = fixture_files();
        let archive = build_archive("bundle-root", &files);
        let origin = MockOrigin::start(archive.clone(), Behaviour::Ranged);
        let model = aimed_at(
            fixture_entry(&archive, &files, "bundle-root"),
            origin.url("/archive"),
        );
        let catalogue = fixture_catalogue(model.clone());
        let temp = tempfile::tempdir().unwrap();

        let downloads = store::models_root(temp.path()).join(store::DOWNLOADS_DIR);
        std::fs::create_dir_all(&downloads).unwrap();
        std::fs::write(
            downloads.join(store::archive_part_name(&model)),
            vec![0xAAu8; archive.len() / 2],
        )
        .unwrap();
        write_resume(
            &downloads.join(store::resume_name(&model)),
            &ResumeState {
                version: RESUME_VERSION,
                model_id: model.id.clone(),
                // The catalogue has moved on to a different archive.
                archive_sha256: "0".repeat(64),
                url: model.archive.upstream_url.clone(),
                etag: Some("\"fixture\"".to_string()),
                last_modified: None,
            },
        )
        .unwrap();

        install(
            temp.path(),
            &catalogue,
            &catalogue.models[0],
            &origin.policy(),
            &CancelFlag::new(),
            &no_progress(),
        )
        .await
        .expect("a stale partial must be discarded, not resumed into");
    }

    #[test]
    fn content_range_starts_are_parsed_and_rubbish_is_not() {
        assert_eq!(parse_content_range_start("bytes 100-199/200"), Some(100));
        assert_eq!(parse_content_range_start("bytes 0-9/10"), Some(0));
        assert_eq!(parse_content_range_start("items 1-2/3"), None);
        assert_eq!(parse_content_range_start("bytes */200"), None);
        assert_eq!(parse_content_range_start(""), None);
    }

    /// A weak ETag cannot be used for `If-Range`: it promises semantic, not
    /// byte-for-byte, equivalence, which is exactly the wrong guarantee when
    /// the bytes are what is being appended to.
    #[test]
    fn a_weak_etag_is_not_used_as_a_range_validator() {
        let state = ResumeState {
            version: RESUME_VERSION,
            model_id: "x".to_string(),
            archive_sha256: "a".repeat(64),
            url: "https://example.invalid/a".to_string(),
            etag: Some("W/\"weak\"".to_string()),
            last_modified: Some("Wed, 21 Oct 2026 07:28:00 GMT".to_string()),
        };
        assert_eq!(state.validator(), Some("Wed, 21 Oct 2026 07:28:00 GMT"));
    }

    #[test]
    fn the_mirror_is_tried_before_upstream_and_is_content_addressed() {
        let files = fixture_files();
        let archive = build_archive("root", &files);
        let model = fixture_entry(&archive, &files, "root");
        let mut catalogue = fixture_catalogue(model.clone());
        catalogue.mirror_base_url = Some("https://mirror.example/".to_string());

        let urls = archive_urls(&catalogue, &catalogue.models[0]);
        assert_eq!(urls.len(), 2);
        assert_eq!(
            urls[0],
            format!(
                "https://mirror.example/sha256/{}/fixture.tar.bz2",
                model.archive.sha256
            ),
            "the digest belongs in the path so one url names one set of bytes"
        );
        assert_eq!(urls[1], model.archive.upstream_url);
    }

    #[test]
    fn with_no_mirror_configured_only_upstream_is_tried() {
        let files = fixture_files();
        let archive = build_archive("root", &files);
        let model = fixture_entry(&archive, &files, "root");
        let catalogue = fixture_catalogue(model.clone());
        assert_eq!(
            archive_urls(&catalogue, &catalogue.models[0]),
            vec![model.archive.upstream_url]
        );
    }
}
