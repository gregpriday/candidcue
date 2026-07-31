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
//! Extraction is never resumed, only downloads. A half-extracted staging
//! directory is cheap to redo and expensive to reason about.

use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
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
pub const MODEL_HOP_LABELS: net::HopLabels = net::HopLabels {
    insecure_code: "STT_MODEL_URL_INSECURE",
    insecure_message: "Speech models can only be downloaded over https.",
    blocked_code: "STT_MODEL_URL_BLOCKED",
    blocked_message: "That model address is not publicly reachable and was refused.",
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
/// A flag rather than a `CancellationToken`: `tokio-util` is not in this tree
/// and the whole requirement is one boolean read per chunk.
#[derive(Debug, Clone, Default)]
pub struct CancelFlag(Arc<AtomicBool>);

impl CancelFlag {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
    fn check(&self) -> Result<(), AppError> {
        if self.is_cancelled() {
            Err(cancelled())
        } else {
            Ok(())
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
/// truncated or proxy-mangled transfer, not an attack, and the honest response
/// to that is to offer another go rather than to accuse anyone.
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
async fn open_transfer(
    url: &str,
    from: u64,
    validator: Option<&str>,
    policy: &HopPolicy,
) -> Result<Transfer, AppError> {
    let mut current = reqwest::Url::parse(url)
        .map_err(|_| download_failed(format!("model url is not valid: {url}")))?;

    for _ in 0..=net::MAX_REDIRECTS {
        let hop = net::check_hop(&current, policy).await?;
        let client = net::client_for(&hop, Deadline::Idle(IDLE_TIMEOUT))?;
        let mut request = client.get(hop.url.clone());
        // A range is only ever asked for WITH a validator. Without one there is
        // nothing to stop a replaced asset being appended to a prefix of the
        // old one, and the resulting file would be neither.
        if from > 0 {
            if let Some(validator) = validator {
                request = request
                    .header(RANGE, format!("bytes={from}-"))
                    .header(IF_RANGE, validator);
            }
        }
        let response = request
            .send()
            .await
            .map_err(|e| download_failed(format!("request failed: {e}")))?;

        let status = response.status();
        if status.is_redirection() {
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| download_failed(format!("{status} with no Location")))?
                .to_string();
            current = current.join(&location).map_err(|_| {
                net::blocked_url(
                    &MODEL_HOP_LABELS,
                    format!("unusable redirect target {location:?}"),
                )
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
            let range = response
                .headers()
                .get(CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| download_failed("206 with no Content-Range"))?;
            let offset = parse_content_range_start(range)
                .ok_or_else(|| download_failed(format!("unusable Content-Range {range:?}")))?;
            if offset != from {
                return Err(download_failed(format!(
                    "asked to resume at {from}, origin answered at {offset}"
                )));
            }
            offset
        } else if status.is_success() {
            0
        } else {
            return Err(download_failed(format!("status {status}")));
        };

        return Ok(Transfer {
            response,
            start,
            etag,
            last_modified,
            accepts_ranges,
        });
    }
    Err(net::blocked_url(&MODEL_HOP_LABELS, "too many redirects"))
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
async fn fetch_archive(
    url: &str,
    model: &ModelEntry,
    target: &Path,
    resume_path: &Path,
    policy: &HopPolicy,
    cancel: &CancelFlag,
    on_progress: &ProgressFn,
) -> Result<(), AppError> {
    let expected = model.archive.bytes;

    // Resume only when the sidecar agrees this partial belongs to this archive
    // at this url, and only up to what is actually on disk.
    let on_disk = std::fs::metadata(target).map(|m| m.len()).unwrap_or(0);
    let resume = read_resume(resume_path).filter(|state| state.matches(model, url));
    let (mut from, validator) = match (&resume, on_disk) {
        (Some(state), len) if len > 0 && len < expected => {
            (len, state.validator().map(|v| v.to_string()))
        }
        _ => (0, None),
    };
    if from == 0 {
        // Any partial we cannot justify resuming is discarded rather than
        // appended to.
        let _ = std::fs::remove_file(target);
    }

    cancel.check()?;
    let transfer = open_transfer(url, from, validator.as_deref(), policy).await?;
    if transfer.start == 0 {
        // The origin restarted us: it ignores ranges, or the asset changed
        // under `If-Range`. Either way the bytes on disk are not a prefix of
        // what is arriving.
        from = 0;
        let _ = std::fs::remove_file(target);
    }

    // Record what would let a LATER run resume this one, before spending the
    // transfer rather than after — a crash mid-download is exactly the case
    // this is for.
    let _ = write_resume(
        resume_path,
        &ResumeState {
            version: RESUME_VERSION,
            model_id: model.id.clone(),
            archive_sha256: model.archive.sha256.clone(),
            url: url.to_string(),
            etag: transfer.etag.clone().filter(|_| transfer.accepts_ranges),
            last_modified: transfer
                .last_modified
                .clone()
                .filter(|_| transfer.accepts_ranges),
        },
    );

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(from == 0)
        .open(target)
        .map_err(|e| install_failed(format!("could not open {}: {e}", target.display())))?;
    if from > 0 {
        use std::io::Seek as _;
        file.seek(std::io::SeekFrom::Start(from))
            .map_err(|e| install_failed(format!("could not seek the partial download: {e}")))?;
    }

    let mut written = from;
    let mut response = transfer.response;
    let mut last_report = std::time::Instant::now();
    on_progress(Phase::Downloading, written, expected);
    loop {
        cancel.check()?;
        let chunk = response
            .chunk()
            .await
            .map_err(|e| download_failed(format!("stream failed: {e}")))?;
        let Some(chunk) = chunk else { break };
        // The catalogue's byte count is a hard ceiling, enforced per chunk. An
        // origin that decides to stream forever fills neither memory nor disk,
        // and `Content-Length` — which is attacker-controlled — is never
        // trusted to size anything.
        if written + chunk.len() as u64 > expected {
            return Err(integrity_failed(format!(
                "archive exceeded the catalogue's {expected} bytes"
            )));
        }
        use std::io::Write as _;
        file.write_all(&chunk)
            .map_err(|e| install_failed(format!("could not write the download: {e}")))?;
        written += chunk.len() as u64;
        if last_report.elapsed() >= PROGRESS_INTERVAL {
            on_progress(Phase::Downloading, written, expected);
            last_report = std::time::Instant::now();
        }
    }
    file.sync_all()
        .map_err(|e| install_failed(format!("could not flush the download: {e}")))?;
    drop(file);
    on_progress(Phase::Downloading, written, expected);

    if written != expected {
        return Err(integrity_failed(format!(
            "expected {expected} bytes, received {written}"
        )));
    }
    Ok(())
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
    // Anything a previous run left mid-extraction is garbage; extraction is
    // never resumed.
    let _ = store::clear_staging(app_data_dir);

    let archive_path = downloads.join(store::archive_part_name(model));
    let resume_path = downloads.join(store::resume_name(model));

    // Mirror first, then upstream. A mirror miss is not a failure — the digest
    // is the trust root and either host satisfies it — so only the LAST url's
    // error is worth reporting.
    let urls = archive_urls(catalogue, model);
    let mut last_error = None;
    let mut fetched = false;
    for (index, url) in urls.iter().enumerate() {
        match fetch_archive(
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
                fetched = true;
                break;
            }
            // A cancellation is the user's decision, not a mirror miss. Stop.
            Err(err) if is_cancelled_error(&err) => return Err(err),
            Err(err) => {
                if index + 1 < urls.len() {
                    tracing::warn!(
                        url = %url,
                        error = %err,
                        "model mirror miss — falling back; the hash is checked either way"
                    );
                }
                last_error = Some(err);
            }
        }
    }
    if !fetched {
        return Err(last_error.unwrap_or_else(|| download_failed("no url produced an archive")));
    }

    on_progress(Phase::VerifyingArchive, 0, model.archive.bytes);
    if let Err(err) = verify_archive(&archive_path, model, cancel, on_progress) {
        // Bytes that failed the digest are never kept: they would be resumed
        // into on the next attempt and fail exactly the same way forever.
        if !is_cancelled_error(&err) {
            let _ = std::fs::remove_file(&archive_path);
            let _ = std::fs::remove_file(&resume_path);
        }
        return Err(err);
    }

    let staging = root.join(format!(
        "{}{}-{}",
        store::STAGING_PREFIX,
        model.install_dir,
        uuid::Uuid::new_v4()
    ));
    let outcome = install_from_archive(
        &archive_path,
        &staging,
        &root,
        model,
        cancel,
        on_progress,
    );
    if outcome.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
        return outcome;
    }

    // The archive has done its job. Keeping it would cost 128 MB for nothing —
    // a re-install re-downloads, and the installed files are what matter now.
    let _ = std::fs::remove_file(&archive_path);
    let _ = std::fs::remove_file(&resume_path);
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

    // From here to the seal, cancellation is not honoured. Stopping between
    // the remove and the rename would leave the user with no model at all.
    on_progress(Phase::Installing, 0, 1);
    let target = model.install_path(root);
    store::remove_dir_if_present(&target)
        .map_err(|e| install_failed(format!("could not clear the previous model: {e}")))?;
    std::fs::rename(staging, &target)
        .map_err(|e| install_failed(format!("could not install the model: {e}")))?;

    // Validated AGAIN, at the path it will actually be loaded from. The staged
    // check proves the files; this proves the install — and the seal below
    // means "proven HERE", which is a claim only this call can support.
    on_progress(Phase::Validating, 1, 1);
    cc_stt::local::ModelFiles::detect(&target).map_err(|detail| {
        integrity_failed(format!("the installed model is not loadable: {detail}"))
    })?;

    // Last. Everything before this is reversible; the seal is what makes the
    // directory eligible to be chosen.
    store::write_seal(&target, model)
        .map_err(|e| install_failed(format!("could not seal the model: {e}")))?;
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::speech::catalogue::{Archive, Attribution, License, ModelFile};
    use std::io::Write as _;
    use std::net::TcpListener;
    use std::sync::atomic::AtomicU64;

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

    /// How the origin should behave, per test.
    #[derive(Clone, Copy, PartialEq)]
    enum Behaviour {
        /// Serves ranges honestly, with a strong ETag.
        Ranged,
        /// Ignores `Range` entirely and always sends the whole body.
        NoRanges,
        /// Honours `Range` but the asset has CHANGED: `If-Range` no longer
        /// matches, so it must answer 200 with the new body.
        Replaced,
        /// Serves a body that is not the archive the catalogue pinned.
        Corrupt,
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
        /// only the tail.
        served: Arc<AtomicU64>,
    }

    impl MockOrigin {
        fn start(body: Vec<u8>, behaviour: Behaviour) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock origin");
            let port = listener.local_addr().unwrap().port();
            let requests = Arc::new(AtomicU64::new(0));
            let served = Arc::new(AtomicU64::new(0));
            let counters = (Arc::clone(&requests), Arc::clone(&served));

            std::thread::spawn(move || {
                let (requests, served) = counters;
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else { continue };
                    let mut buf = [0u8; 4096];
                    let read = std::io::Read::read(&mut stream, &mut buf).unwrap_or(0);
                    let request = String::from_utf8_lossy(&buf[..read]).to_string();
                    requests.fetch_add(1, Ordering::SeqCst);

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

                    // Header names are matched case-insensitively because hyper
                    // writes them lowercase on the wire. Matching `Range:` as
                    // spelled here silently never fired, and every resume test
                    // passed by restarting.
                    let lowered = request.to_ascii_lowercase();
                    let range_from = lowered.lines().find_map(|line| {
                        let rest = line.trim().strip_prefix("range: bytes=")?;
                        rest.split('-').next()?.trim().parse::<u64>().ok()
                    });
                    // `If-Range` present means the client is trying to resume
                    // against a validator. A "replaced" origin refuses it.
                    let conditional = lowered.lines().any(|l| l.trim().starts_with("if-range:"));

                    let honour_range = match behaviour {
                        Behaviour::Ranged | Behaviour::Corrupt => range_from.is_some(),
                        Behaviour::NoRanges => false,
                        Behaviour::Replaced => range_from.is_some() && !conditional,
                    };

                    let payload: &[u8] = &body;
                    let response = if honour_range {
                        let from = range_from.unwrap_or(0) as usize;
                        let slice = &payload[from.min(payload.len())..];
                        let mut head = format!(
                            "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\nAccept-Ranges: bytes\r\nETag: \"fixture\"\r\nConnection: close\r\n\r\n",
                            slice.len(),
                            from,
                            payload.len().saturating_sub(1),
                            payload.len()
                        )
                        .into_bytes();
                        head.extend_from_slice(slice);
                        served.fetch_add(slice.len() as u64, Ordering::SeqCst);
                        head
                    } else {
                        let accept = if behaviour == Behaviour::NoRanges {
                            ""
                        } else {
                            "Accept-Ranges: bytes\r\n"
                        };
                        let mut head = format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n{accept}ETag: \"fixture\"\r\nConnection: close\r\n\r\n",
                            payload.len()
                        )
                        .into_bytes();
                        head.extend_from_slice(payload);
                        served.fetch_add(payload.len() as u64, Ordering::SeqCst);
                        head
                    };
                    let _ = stream.write_all(&response);
                    let _ = stream.flush();
                }
            });
            Self {
                port,
                requests,
                served,
            }
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

    /// Point a catalogue entry's upstream url at the mock.
    fn aimed_at(mut model: ModelEntry, url: String) -> ModelEntry {
        model.archive.upstream_url = url;
        model
    }

    fn no_progress() -> Box<ProgressFn> {
        Box::new(|_, _, _| {})
    }

    /// The happy path, end to end: fetch, verify, unpack, install, seal.
    #[tokio::test]
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
    #[tokio::test]
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
    #[tokio::test]
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

    /// A partial from an interrupted run is continued, not restarted.
    #[tokio::test]
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
        .expect("a valid partial must be resumed");

        let served = origin.served.load(Ordering::SeqCst);
        assert!(
            served < archive.len() as u64,
            "resume transferred {served} of {} bytes — it restarted instead",
            archive.len()
        );
    }

    /// The case `If-Range` exists for. Upstream's release tag is mutable, so a
    /// partial can be a prefix of bytes that are no longer there; appending to
    /// it would produce a file that is neither version.
    #[tokio::test]
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
                etag: Some("\"stale\"".to_string()),
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

        // The proof is that it installed at all: appending would have failed
        // the archive digest.
        for (name, body) in &files {
            assert_eq!(&std::fs::read(dir.join(name)).unwrap(), body, "{name}");
        }
    }

    /// An origin with no range support still works; it just cannot resume.
    #[tokio::test]
    async fn an_origin_without_range_support_still_installs() {
        let files = fixture_files();
        let archive = build_archive("bundle-root", &files);
        let origin = MockOrigin::start(archive.clone(), Behaviour::NoRanges);
        let model = aimed_at(
            fixture_entry(&archive, &files, "bundle-root"),
            origin.url("/archive"),
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
        .expect("an origin that ignores Range must still work");
    }

    /// Bytes that fail the digest never reach a decompressor.
    #[tokio::test]
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

        let err = install(
            temp.path(),
            &catalogue,
            &catalogue.models[0],
            &origin.policy(),
            &CancelFlag::new(),
            &no_progress(),
        )
        .await
        .expect_err("a digest mismatch must stop the install");
        assert_eq!(err.code(), "STT_MODEL_CORRUPT", "{err:?}");

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
    }

    /// A body longer than the catalogue promises is cut off mid-stream rather
    /// than filling the disk and being rejected afterwards.
    #[tokio::test]
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
    }

    /// Only catalogue-named members are written. A bundle's extra payload —
    /// test audio, scripts, anything with a path that climbs — never lands.
    #[tokio::test]
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
        assert!(
            !root.join("escape.txt").exists() && !root.parent().unwrap().join("escape.txt").exists(),
            "a traversing member must never be written"
        );
        // Only the catalogue's files, the notice and the seal.
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
    #[tokio::test]
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

        // A previous, working installation.
        let installed = model.install_path(&store::models_root(temp.path()));
        std::fs::create_dir_all(&installed).unwrap();
        std::fs::write(installed.join("encoder.int8.onnx"), b"OLD").unwrap();

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
        let staging_left = std::fs::read_dir(store::models_root(temp.path()))
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with(store::STAGING_PREFIX)
            });
        assert!(!staging_left, "failed staging must be swept");
    }

    /// An archive missing a file the catalogue requires is refused, rather
    /// than installing a model that is short a graph.
    #[tokio::test]
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
    #[tokio::test]
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
    #[tokio::test]
    async fn a_dead_mirror_falls_through_to_upstream() {
        let files = fixture_files();
        let archive = build_archive("bundle-root", &files);
        let origin = MockOrigin::start(archive.clone(), Behaviour::Ranged);
        let model = aimed_at(
            fixture_entry(&archive, &files, "bundle-root"),
            origin.url("/archive"),
        );
        let mut catalogue = fixture_catalogue(model);
        // A mirror on a port nothing is listening on.
        catalogue.mirror_base_url = Some("http://127.0.0.1:1/mirror".to_string());
        let temp = tempfile::tempdir().unwrap();

        let mut policy = origin.policy();
        policy.exempt_authority = Some(format!("127.0.0.1:{}", origin.port));

        // The mirror url is on a different authority, so the guard refuses it
        // before the socket — which is exactly a mirror miss as far as the
        // fallback is concerned.
        install(
            temp.path(),
            &catalogue,
            &catalogue.models[0],
            &policy,
            &CancelFlag::new(),
            &no_progress(),
        )
        .await
        .expect("an unreachable mirror must fall through to upstream");

        assert!(
            origin.requests.load(Ordering::SeqCst) >= 1,
            "upstream must have been asked"
        );
    }

    /// A sidecar describing a different archive must not be resumed into.
    #[tokio::test]
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
