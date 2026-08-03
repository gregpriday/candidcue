//! Logs that survive the app (spec §44.11, §179).
//!
//! The whole point of this module is a single measured fact: a macOS `.app`
//! launched from Finder has its stdout and stderr wired to `/dev/null` by
//! launchd. Not Console.app, not the unified log — nowhere. So a subscriber
//! that writes only to stdout, which is what this app shipped with, produces
//! exactly nothing in the one configuration every user runs. Every `warn!` and
//! `error!` in the Rust core was being written to a file descriptor pointed at
//! the void, and the first real bug report would have been unactionable.
//!
//! So there are two sinks. Stdout stays, because `pnpm tauri dev` is where most
//! of these lines are actually read. Beside it is a daily rolling file under
//! `logs/`, which is the copy that exists when the person who hit the bug is
//! not the person debugging it.
//!
//! Redaction, which this module's parent doc comment also promises, is NOT
//! implemented here — see the closing comment above the tests for why that is
//! a deliberate omission rather than an oversight.

use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

/// Rust log filenames are `candidcue-rust.<YYYY-MM-DD>.log`.
///
/// The prefix is load-bearing in a way that is easy to miss. `tracing-appender`
/// enforces its retention by listing the WHOLE log directory and deleting the
/// oldest entries whose names start with this prefix and end with this suffix —
/// it does not track the files it created. `client-trace.log` lives in the same
/// directory and shares the `.log` suffix, so the prefix is the only thing
/// standing between the client trace and the appender's pruner. Renaming this
/// to anything the client trace also starts with would make the appender
/// silently delete the frontend's trace. There is a test pinning that.
const RUST_LOG_PREFIX: &str = "candidcue-rust";
const RUST_LOG_SUFFIX: &str = "log";

/// Daily rotation, sized to keep at least a week: today plus seven days back.
///
/// The number is 9 rather than 8, and the difference is not an off-by-one.
/// `prune_old_logs` deletes down to `max_files - 1` and then opens the target
/// file, which normally restores the count. But it also runs at STARTUP, and a
/// same-day relaunch opens a file that ALREADY EXISTS — so no directory entry
/// is created, and the count stays at `max_files - 1`. An app relaunched twice
/// in a day at capacity therefore settles one file below the configured number,
/// which is exactly why the crate's own docs tell you to ask for `m + 1` when
/// you need `m`. A week is the horizon over which someone can plausibly say "it
/// started doing this a few days ago" and still have the evidence.
///
/// Note this bounds the file COUNT, not bytes: the appender has no size cap.
/// That is tolerable here only because nothing in this app logs on a hot path —
/// `align/` emits no events at all, `speech/` logs discrete lifecycle moments,
/// and the one renderer-driven logger is off by default in a packaged build. A
/// future per-frame `info!` would make a byte budget necessary.
const MAX_DAILY_LOG_FILES: usize = 9;

/// The frontend's trace for the run in front of you, and the run before it.
pub(crate) const CLIENT_TRACE: &str = "client-trace.log";
pub(crate) const CLIENT_TRACE_PREV: &str = "client-trace.prev.log";

/// Truncate the client trace at 4 MB. Long enough for many sessions, small
/// enough that a runaway caller cannot become a support problem of its own.
const MAX_CLIENT_TRACE_BYTES: u64 = 4 * 1024 * 1024;

/// Per-file ceiling on what reaches a support bundle.
///
/// The client trace caps itself at 4 MB, but the Rust log has no size cap at
/// all — only a file-count one — so a hot loop of `warn!` could leave a
/// multi-gigabyte day behind. A file over this size is copied from its tail,
/// because the end of a log is where the failure is. Note this is a per-file
/// cap and not a budget across files: shipping the tail of every day beats
/// shipping all of some days and none of others, which is what a global budget
/// would do to the oldest evidence.
const MAX_BUNDLED_FILE_BYTES: u64 = 8 * 1024 * 1024;

/// Marks a tail copy so nobody reads a truncated file as a complete one.
const TRUNCATION_MARKER: &str = "[… earlier lines omitted: file exceeded the support-bundle size limit …]\n";

/*
 * One lock over every direct write to the client trace.
 *
 * Every trace step is an independent async command, so several can be in the
 * file at once — and a `writeln!` that formats as it goes can emit more than
 * one write. The result was visible in a captured log: a doubled timestamp on
 * one line and none on the next, two steps spliced together. A trace whose
 * lines interleave is a trace you cannot read an ordering out of, which is the
 * only thing it is for.
 *
 * Startup rotation and `clear_logs` take the same lock, so a rename or a delete
 * cannot land between an append's size check and its write.
 */
static CLIENT_TRACE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Holds the non-blocking writer's worker thread open.
///
/// `WorkerGuard` is the tracing-appender contract for "the background flush
/// thread is still running". Drop it and the thread stops — with no error, no
/// panic, and no log lines. That failure mode is invisible in a test that only
/// checks the subscriber was installed, which is why this is a named type
/// managed by the app rather than a `let _ =` at the end of a setup closure:
/// Tauri drops managed state when the app itself goes down, which is exactly
/// as long as the writer needs to live.
#[derive(Debug)]
pub(crate) struct LoggingGuard {
    _worker: tracing_appender::non_blocking::WorkerGuard,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum LoggingInitError {
    #[error("could not open the rolling log file: {0}")]
    Appender(#[from] tracing_appender::rolling::InitError),
    #[error("a tracing subscriber was already installed: {0}")]
    Subscriber(#[from] tracing_subscriber::util::TryInitError),
}

/// Install the process-wide subscriber: stdout for a dev run, a daily rolling
/// file for every run.
///
/// Called from `setup`, not from `run()`, because the log directory is derived
/// from the app data dir and that needs an `AppHandle` which does not exist
/// until the builder has one. The cost is that anything Tauri itself logs while
/// registering plugins lands before this point and is not captured; the benefit
/// is that the file is opened where its path is actually known. A
/// `reload::Layer` could close that gap by installing stdout early and swapping
/// the file layer in later, but the gap it closes is stdout-only output in a
/// packaged build — which, per the module doc, goes to `/dev/null` regardless.
/// It would be machinery bought with nothing.
pub(crate) fn init(logs_dir: &Path) -> Result<LoggingGuard, LoggingInitError> {
    let (subscriber, worker) = build_subscriber(logs_dir)?;
    // Before `try_init`, not after. The appender built cleanly, so the file is
    // openable, and the hook writes to it directly rather than through the
    // subscriber — so it is useful even on the path where installing the
    // global dispatcher fails. Ordering it after would mean a `try_init`
    // failure left a release build with no synchronous record of a panic.
    install_panic_hook(logs_dir.to_path_buf());
    subscriber.try_init()?;
    Ok(LoggingGuard { _worker: worker })
}

/// The subscriber `init` installs, built but not yet global.
///
/// Split out for one reason: `try_init` sets a process-wide dispatcher exactly
/// once, so a test that called `init` would both prevent every other test in
/// the binary from doing so and pass or fail depending on test ordering. With
/// the construction separated from the installation, a test can drive this
/// EXACT subscriber — same prefix, same filter, same layers — through
/// `tracing::subscriber::with_default` and assert what lands on disk, while
/// `init` stays a thin wrapper with nothing left in it to get wrong.
#[allow(clippy::type_complexity)]
fn build_subscriber(
    logs_dir: &Path,
) -> Result<
    (
        impl tracing::Subscriber + SubscriberInitExt + Send + Sync,
        tracing_appender::non_blocking::WorkerGuard,
    ),
    LoggingInitError,
> {
    let appender = tracing_appender::rolling::RollingFileAppender::builder()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix(RUST_LOG_PREFIX)
        .filename_suffix(RUST_LOG_SUFFIX)
        .max_log_files(MAX_DAILY_LOG_FILES)
        .build(logs_dir)?;
    let (file_writer, worker) = tracing_appender::non_blocking(appender);

    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));

    let subscriber = tracing_subscriber::registry()
        .with(env_filter)
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stdout))
        // No ANSI on disk: escape codes in a file the user is going to open in
        // a text editor and paste into an issue are noise at best.
        .with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(file_writer),
        );
    Ok((subscriber, worker))
}

/// Last resort when the log file cannot be opened: keep stdout, so a dev run
/// still prints and the reason is at least visible somewhere.
///
/// Separate from `init` because it must not fail — by the time this is reached
/// the app is already starting without the thing this module exists to provide,
/// and turning that into a second failure would only make it harder to see.
pub(crate) fn init_stdout_only() {
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let _ = tracing_subscriber::registry()
        .with(env_filter)
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stdout))
        .try_init();
}

/// Write a panic to disk before the process dies.
///
/// The release profile sets `panic = "abort"`, which means no unwinding — so no
/// `Drop`, so the non-blocking writer's buffered lines never flush, so a panic
/// routed through `tracing::error!` would be assembled and then lost microseconds
/// later. A hook still RUNS under `panic = "abort"` (the abort happens after the
/// hook returns), so the fix is to make the hook do its own synchronous write and
/// not touch the tracing pipeline at all.
///
/// `strip = true` is not a problem here: it removes DWARF symbols, so a
/// backtrace would be addresses only, but the file and line come from
/// `Location`, which is a compile-time string baked into the binary and
/// survives stripping. Message plus location is what makes a panic report
/// actionable, and that is what this captures.
fn install_panic_hook(logs_dir: PathBuf) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // Deliberately infallible-by-ignoring: a panic hook that panics
        // replaces a diagnosable crash with an undiagnosable one.
        //
        // One clock sample, used for both the timestamp and the filename. Read
        // twice, a panic that starts at 23:59:59.999 can be stamped with
        // yesterday and filed under today.
        let now = chrono::Utc::now();
        let record = format_panic_record(
            &now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            std::thread::current().name(),
            panic_message(info),
            info.location().map(|l| (l.file(), l.line(), l.column())),
        );
        let _ = append_panic_record(&rust_log_path(&logs_dir, now.date_naive()), &record);
        previous(info);
    }));
}

/// The panic payload as a borrowed string, without copying it.
///
/// Borrowed rather than owned on purpose: a panic caused by memory exhaustion
/// is one where allocating a copy of the message is exactly the operation most
/// likely to fail, and failing here means the crash goes unrecorded.
fn panic_message<'a>(info: &'a std::panic::PanicHookInfo<'_>) -> &'a str {
    let payload = info.payload();
    if let Some(s) = payload.downcast_ref::<&str>() {
        s
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.as_str()
    } else {
        "panic payload was not a string"
    }
}

/// One panic, one line.
///
/// A panic message can contain newlines — `assert_eq!` failures always do — and
/// a multi-line record in a log whose every other entry is one line per event
/// is a record that gets read as several unrelated events. Control characters
/// are escaped rather than stripped so the original text is still recoverable.
fn format_panic_record(
    timestamp: &str,
    thread_name: Option<&str>,
    message: &str,
    location: Option<(&str, u32, u32)>,
) -> String {
    /// Enough for any panic worth reading; short enough that formatting one
    /// cannot itself become the reason the crash goes unrecorded.
    ///
    /// It bounds the MESSAGE, not the finished record: the timestamp, thread
    /// and location are all bounded already, and counting them here would mean
    /// a long file path silently ate the budget for the panic text.
    const MAX_PANIC_MESSAGE: usize = 8 * 1024;

    let mut record = String::with_capacity(512);
    record.push_str(timestamp);
    record.push_str(" PANIC thread=");
    record.push_str(thread_name.unwrap_or("unnamed"));
    record.push_str(" at ");
    match location {
        Some((file, line, column)) => {
            record.push_str(file);
            record.push(':');
            record.push_str(&line.to_string());
            record.push(':');
            record.push_str(&column.to_string());
        }
        None => record.push_str("unknown location"),
    }
    record.push_str(": ");

    // Escaped into the buffer a character at a time rather than through an
    // iterator chain that allocated a Vec per character. A panic message can be
    // arbitrarily long — `assert_eq!` on two big structures produces one — and
    // the old shape turned that into millions of allocations at the exact
    // moment the process is least able to afford them.
    let budget = record.len() + MAX_PANIC_MESSAGE;
    let mut truncated = false;
    for c in message.chars() {
        if record.len() >= budget {
            truncated = true;
            break;
        }
        match c {
            '\n' => record.push_str("\\n"),
            '\r' => record.push_str("\\r"),
            '\t' => record.push_str("\\t"),
            c if c.is_control() => record.push_str(&format!("\\u{{{:x}}}", c as u32)),
            c => record.push(c),
        }
    }
    if truncated {
        record.push_str(" […truncated]");
    }
    record.push('\n');
    record
}

/// Synchronous append, then `sync_data`. There is no second chance: the process
/// aborts as soon as the hook chain returns, so anything still in a userspace
/// buffer is gone.
fn append_panic_record(path: &Path, record: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    file.write_all(record.as_bytes())?;
    file.sync_data()
}

/// Test-only. Production never asks "what day is it" on its own: the panic hook
/// takes ONE clock sample and derives both its timestamp and its filename from
/// that, so a record cannot be stamped with one day and filed under another.
#[cfg(test)]
fn today_utc() -> chrono::NaiveDate {
    chrono::Utc::now().date_naive()
}

/// The daily file `tracing-appender` is writing to for a given date. Kept in
/// one place so the panic hook cannot drift from the appender's naming.
fn rust_log_path(logs_dir: &Path, date: chrono::NaiveDate) -> PathBuf {
    logs_dir.join(format!(
        "{RUST_LOG_PREFIX}.{}.{RUST_LOG_SUFFIX}",
        date.format("%Y-%m-%d")
    ))
}

/// Is this one of the appender's own files?
fn is_rust_log_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix(RUST_LOG_PREFIX) else {
        return false;
    };
    let Some(date) = rest
        .strip_prefix('.')
        .and_then(|r| r.strip_suffix(RUST_LOG_SUFFIX))
        .and_then(|r| r.strip_suffix('.'))
    else {
        return false;
    };
    // Parse the date rather than trusting the shape, so a hand-dropped
    // `candidcue-rust.notes.log` is not mistaken for ours and shipped in a
    // support bundle or truncated instead of cleared.
    //
    // This governs THIS module's decisions only. The appender's own pruner
    // never calls it — it matches on prefix and suffix alone — so a file with
    // our prefix and a `.log` suffix can still occupy a retention slot or be
    // deleted by the crate regardless of what this returns.
    chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_ok()
}

/// Start each run with an empty client trace — but keep the last one.
///
/// The live trace is a debugging artefact for the session in front of you, not
/// a history: appending across runs means whoever reads it has to work out
/// where one launch ended and the next began, and reading the tail of the wrong
/// run is how you diagnose a bug that was already fixed. That argument is why
/// this file used to be DELETED at startup — and deleting it meant that a crash
/// followed by the reflex relaunch destroyed the only record of the crash.
///
/// A rename settles both: the live file still contains exactly one launch, and
/// the launch that just died is still on disk under a name that says so.
///
/// Note what this does NOT do. A launch that produced no client trace leaves
/// the previous one alone rather than expiring it. If run B wrote nothing, then
/// run A's trace is the newest evidence that exists, and the failure mode this
/// whole issue is about is evidence being thrown away.
pub(crate) fn rotate_client_trace(logs_dir: &Path) -> std::io::Result<()> {
    let _guard = CLIENT_TRACE_LOCK.lock();
    let live = logs_dir.join(CLIENT_TRACE);
    if !live.exists() {
        return Ok(());
    }
    std::fs::rename(&live, logs_dir.join(CLIENT_TRACE_PREV))
}

/// Append one pre-formatted line to the live client trace, enforcing the size
/// cap. The caller owns sanitising and formatting; this owns the file.
pub(crate) fn append_client_trace(logs_dir: &Path, entry: &str) -> std::io::Result<()> {
    let _guard = CLIENT_TRACE_LOCK.lock();
    std::fs::create_dir_all(logs_dir)?;
    let path = logs_dir.join(CLIENT_TRACE);
    if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > MAX_CLIENT_TRACE_BYTES {
        let _ = std::fs::remove_file(&path);
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    file.write_all(entry.as_bytes())
}

#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct LogClearStats {
    pub removed_files: u32,
    pub removed_bytes: u64,
}

/// Empty the log directory without breaking the log.
///
/// The obvious implementation — `remove_file` on everything, which is what the
/// generic `clear_cache` loop does — is wrong for exactly one file: the daily
/// log the appender currently holds open. Unlinking it on macOS does not close
/// the descriptor, so the appender goes on writing happily into an inode with
/// no name, and every subsequent line is invisible until the next rotation
/// silently opens a new file. The user asked to clear the logs and got a
/// working app that no longer logs.
///
/// So the appender's own files are TRUNCATED in place instead. It opens them
/// with `append(true)`, so the next write goes to the start of the now-empty
/// file it is already holding, and logging continues uninterrupted.
///
/// This is point-in-time, not a switch: lines already queued in the
/// non-blocking writer can land immediately afterwards, and the app keeps
/// logging. Clearing the logs is not the same as turning logging off.
pub(crate) fn clear_logs(logs_dir: &Path) -> std::io::Result<LogClearStats> {
    let _guard = CLIENT_TRACE_LOCK.lock();
    let mut stats = LogClearStats::default();
    if !logs_dir.exists() {
        return Ok(stats);
    }
    for entry in std::fs::read_dir(logs_dir)?.filter_map(|e| e.ok()) {
        let path = entry.path();
        // `symlink_metadata` so a symlink is treated as the link it is rather
        // than followed to whatever it points at.
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        let name = entry.file_name();
        let name = name.to_string_lossy();

        if meta.is_file() && is_rust_log_name(&name) {
            let bytes = meta.len();
            if std::fs::OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(&path)
                .is_ok()
            {
                stats.removed_files += 1;
                stats.removed_bytes += bytes;
            }
            continue;
        }

        let bytes = if meta.is_dir() { dir_size(&path) } else { meta.len() };
        let removed = if meta.is_dir() {
            std::fs::remove_dir_all(&path).is_ok()
        } else {
            std::fs::remove_file(&path).is_ok()
        };
        if removed {
            stats.removed_files += 1;
            stats.removed_bytes += bytes;
        }
    }
    Ok(stats)
}

fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .filter_map(|e| e.ok())
        .map(|e| match std::fs::symlink_metadata(e.path()) {
            Ok(meta) if meta.is_dir() => dir_size(&e.path()),
            Ok(meta) => meta.len(),
            Err(_) => 0,
        })
        .sum()
}

/// Copy the logs into a support bundle, under `logs/`.
///
/// An allowlist rather than "every `*.log`": the bundle is something a user
/// hands to someone else, so what goes in it should be a decision made here and
/// not a consequence of whatever happens to be sitting in the directory.
pub(crate) fn copy_support_logs(logs_dir: &Path, bundle_dir: &Path) -> std::io::Result<()> {
    copy_support_logs_with_limit(logs_dir, bundle_dir, MAX_BUNDLED_FILE_BYTES)
}

fn copy_support_logs_with_limit(
    logs_dir: &Path,
    bundle_dir: &Path,
    max_bytes: u64,
) -> std::io::Result<()> {
    if !logs_dir.exists() {
        return Ok(());
    }
    let dest = bundle_dir.join("logs");
    std::fs::create_dir_all(&dest)?;

    let _guard = CLIENT_TRACE_LOCK.lock();
    for entry in std::fs::read_dir(logs_dir)?.filter_map(|e| e.ok()) {
        let name = entry.file_name();
        let name = name.to_string_lossy().to_string();
        let included =
            name == CLIENT_TRACE || name == CLIENT_TRACE_PREV || is_rust_log_name(&name);
        if !included {
            continue;
        }
        // Regular files only. A symlink in the log directory pointing at
        // something outside it is the one way this loop could copy data nobody
        // meant to include.
        match std::fs::symlink_metadata(entry.path()) {
            Ok(meta) if meta.is_file() => {}
            _ => continue,
        }
        // Best effort per file, matching how the recovery reports are copied:
        // one unreadable log must not fail the export and leave the user
        // holding nothing. But it is reported rather than swallowed — a bundle
        // silently missing the log someone is about to go looking for is how
        // this issue happened in the first place.
        if let Err(err) = copy_tail(&entry.path(), &dest.join(&name), max_bytes) {
            tracing::warn!(file = %name, error = %err, "a log file could not be added to the support bundle");
        }
    }
    Ok(())
}

/// Copy a file, or its last `max_bytes` if it is bigger than that.
///
/// The tail is aligned to the next line boundary so the bundle never opens on
/// half a log line, and a marker says why the beginning is missing.
fn copy_tail(source: &Path, dest: &Path, max_bytes: u64) -> std::io::Result<()> {
    let mut input = std::fs::File::open(source)?;
    let len = input.metadata()?.len();

    // Everything below reads through the descriptor already open, bounded by
    // the length measured through that same descriptor. `fs::copy` would
    // reopen by path — and the daily log is being appended to while this runs,
    // so reopening means copying a file that is no longer the one that was
    // measured, past the cap and potentially without end.
    if len <= max_bytes {
        let mut output = std::fs::File::create(dest)?;
        std::io::copy(&mut input.take(len), &mut output)?;
        return Ok(());
    }

    /*
     * Peek at the byte before the window.
     *
     * The tail has to start on a line boundary, and the obvious way to get
     * there — drop everything up to the first newline — is wrong twice. If the
     * window already begins just after a newline it throws away a complete
     * line for nothing; and if the window's only newline is its final byte it
     * throws away everything, leaving a file in the support bundle containing
     * the truncation marker and not one line of log.
     *
     * Reading the preceding byte answers the question the first newline was
     * being used to guess at.
     */
    let start = len - max_bytes;
    input.seek(SeekFrom::Start(start - 1))?;
    let mut preceding = [0u8; 1];
    input.read_exact(&mut preceding)?;

    let mut tail = Vec::new();
    input.take(max_bytes).read_to_end(&mut tail)?;
    if preceding[0] != b'\n' {
        // Mid-line. Drop the fragment. If there is no newline at all the whole
        // tail is one enormous line, and keeping it beats emitting nothing.
        if let Some(cut) = tail.iter().position(|b| *b == b'\n') {
            tail.drain(..=cut);
        }
    }

    let mut output = std::fs::File::create(dest)?;
    output.write_all(TRUNCATION_MARKER.as_bytes())?;
    output.write_all(&tail)
}

/*
 * On the redaction this module's parent doc comment promises.
 *
 * It is not implemented, and that is deliberate rather than pending. The app
 * holds no secrets: the OS keychain entry existed for exactly one credential —
 * the hosted speech provider's API key — and the recogniser now runs on-device,
 * so the credential store was deleted along with the client that used it. A
 * field scrubber matching `api_key`/`authorization`/`access_token` would filter
 * for values that provably cannot occur, while reading, to anyone who found it,
 * as evidence that logs had been audited for secrets. Machinery that implies a
 * guarantee it does not provide is worse than no machinery.
 *
 * What keeps user content out of these files is upstream, and it is a
 * convention rather than a mechanism: `log_client_diagnostic` is documented to
 * take step names, states and timings, and no call site today interpolates
 * script text, transcripts or audio into an event. It is worth being precise
 * about how far that goes — the command accepts an arbitrary string, the panic
 * hook records an arbitrary payload, and error paths log `Error` messages whose
 * text this module does not control. So the guarantee is "nothing puts user
 * content in", not "nothing can". If that stops holding, the fix belongs at the
 * call site that broke it; a formatter here would only hide it.
 */

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    fn write(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("parent");
        }
        std::fs::write(path, contents).expect("write");
    }

    fn read(path: &Path) -> String {
        std::fs::read_to_string(path).expect("read")
    }

    /// The hazard that is invisible until it costs you a bug report.
    ///
    /// `tracing-appender` enforces retention by listing the log directory and
    /// deleting the oldest files whose names start with its prefix AND end with
    /// its suffix — it keeps no record of the files it opened. The client trace
    /// sits in that same directory and ends in `.log`, so the prefix is the
    /// only thing keeping the appender's pruner off it. Rename the Rust log to
    /// anything the client trace also starts with and the frontend's trace
    /// starts vanishing on the eighth day, with nothing in the code to say why.
    #[test]
    fn the_rust_log_prefix_cannot_match_the_client_trace() {
        assert!(
            !CLIENT_TRACE.starts_with(RUST_LOG_PREFIX),
            "the appender's pruner would delete the client trace"
        );
        assert!(
            !CLIENT_TRACE_PREV.starts_with(RUST_LOG_PREFIX),
            "the appender's pruner would delete the previous client trace"
        );
        assert!(!is_rust_log_name(CLIENT_TRACE));
        assert!(!is_rust_log_name(CLIENT_TRACE_PREV));
    }

    #[test]
    fn rust_log_names_must_carry_a_real_date() {
        assert!(is_rust_log_name("candidcue-rust.2026-08-03.log"));
        // Shape alone is not enough: a file dropped in by hand is not evidence.
        assert!(!is_rust_log_name("candidcue-rust.notes.log"));
        assert!(!is_rust_log_name("candidcue-rust.2026-13-40.log"));
        assert!(!is_rust_log_name("candidcue-rust.log"));
        assert!(!is_rust_log_name("other.2026-08-03.log"));
        assert!(!is_rust_log_name("candidcue-rust.2026-08-03.txt"));
    }

    #[test]
    fn the_panic_hook_path_matches_the_appenders_own_naming() {
        let dir = temp();
        let date = chrono::NaiveDate::from_ymd_opt(2026, 8, 3).expect("date");
        let path = rust_log_path(dir.path(), date);
        assert_eq!(
            path.file_name().expect("name").to_string_lossy(),
            "candidcue-rust.2026-08-03.log"
        );
        // If this stops holding, a panic goes into a file the support bundle
        // does not collect.
        assert!(is_rust_log_name(&path.file_name().unwrap().to_string_lossy()));
    }

    #[test]
    fn rotation_is_a_no_op_on_a_fresh_install() {
        let dir = temp();
        rotate_client_trace(dir.path()).expect("rotate");
        assert!(!dir.path().join(CLIENT_TRACE).exists());
        assert!(!dir.path().join(CLIENT_TRACE_PREV).exists());
    }

    /// The regression the issue is about: this used to be `remove_file`, so a
    /// crash plus the reflex relaunch destroyed the only record of the crash.
    #[test]
    fn rotation_moves_the_live_trace_to_previous() {
        let dir = temp();
        write(&dir.path().join(CLIENT_TRACE), "the run that crashed\n");

        rotate_client_trace(dir.path()).expect("rotate");

        assert!(
            !dir.path().join(CLIENT_TRACE).exists(),
            "the live trace must start each run empty"
        );
        assert_eq!(
            read(&dir.path().join(CLIENT_TRACE_PREV)),
            "the run that crashed\n",
            "the launch that just died must still be on disk"
        );
    }

    #[test]
    fn rotation_replaces_an_older_previous_trace() {
        let dir = temp();
        write(&dir.path().join(CLIENT_TRACE_PREV), "two runs ago\n");
        write(&dir.path().join(CLIENT_TRACE), "one run ago\n");

        rotate_client_trace(dir.path()).expect("rotate");

        assert_eq!(read(&dir.path().join(CLIENT_TRACE_PREV)), "one run ago\n");
        assert!(!dir.path().join(CLIENT_TRACE).exists());
    }

    /// A launch that logged nothing must not expire the previous trace: if this
    /// run wrote no client diagnostics, the previous run's trace is the newest
    /// evidence in existence and deleting it is the exact failure this issue is
    /// about.
    #[test]
    fn rotation_keeps_previous_when_this_run_wrote_no_trace() {
        let dir = temp();
        write(&dir.path().join(CLIENT_TRACE_PREV), "the only evidence\n");

        rotate_client_trace(dir.path()).expect("rotate");

        assert_eq!(
            read(&dir.path().join(CLIENT_TRACE_PREV)),
            "the only evidence\n"
        );
    }

    #[test]
    fn client_trace_appends_and_is_capped() {
        let dir = temp();
        append_client_trace(dir.path(), "first\n").expect("append");
        append_client_trace(dir.path(), "second\n").expect("append");
        assert_eq!(read(&dir.path().join(CLIENT_TRACE)), "first\nsecond\n");

        // Over the cap, the file restarts rather than growing without bound.
        let oversized = "x".repeat(MAX_CLIENT_TRACE_BYTES as usize + 1);
        write(&dir.path().join(CLIENT_TRACE), &oversized);
        append_client_trace(dir.path(), "after the cap\n").expect("append");
        assert_eq!(read(&dir.path().join(CLIENT_TRACE)), "after the cap\n");
    }

    /// The measured fact this whole module exists for, asserted against the
    /// subscriber `init` actually installs: a `warn!` has to come back off the
    /// disk.
    ///
    /// It drives `build_subscriber` rather than rebuilding an appender by hand.
    /// That distinction is the point — an earlier version of this test
    /// constructed its own appender and layer, which meant it stayed green if
    /// `init` dropped the file layer, changed the prefix, or filtered warnings
    /// out. It proved a dependency worked, not that this module used it.
    ///
    /// `init` itself is still not called: `try_init` sets a process-wide
    /// dispatcher exactly once, so a test that called it would stop every other
    /// test in this binary from doing so and would pass or fail on ordering.
    /// What is left in `init` past this seam is the `try_init` and the hook
    /// install.
    #[test]
    fn a_warning_reaches_the_daily_file_on_disk() {
        let dir = temp();
        let (subscriber, worker) = build_subscriber(dir.path()).expect("subscriber");

        tracing::subscriber::with_default(subscriber, || {
            tracing::warn!("sentinel-line-179");
        });
        // Dropping the guard drains the worker. Without this the assertion
        // below races the flush thread — which is precisely the silent failure
        // mode the guard exists to prevent.
        drop(worker);

        // Discover the file rather than computing today's name: the appender
        // stamps its own filename, and recomputing the date here would make
        // this test fail for one instant per day if the event landed at
        // 23:59:59 and the assertion ran after midnight.
        let written: Vec<_> = std::fs::read_dir(dir.path())
            .expect("read logs dir")
            .filter_map(|e| e.ok())
            .filter(|e| is_rust_log_name(&e.file_name().to_string_lossy()))
            .collect();
        assert_eq!(
            written.len(),
            1,
            "expected exactly one daily log, found {:?}",
            written.iter().map(|e| e.file_name()).collect::<Vec<_>>()
        );

        let contents = read(&written[0].path());
        assert!(
            contents.contains("sentinel-line-179"),
            "the event never reached the file: {contents:?}"
        );
        assert!(
            contents.contains("WARN"),
            "the default filter must let a warning through: {contents:?}"
        );
        assert!(
            !contents.contains('\u{1b}'),
            "the on-disk copy must not carry ANSI escapes"
        );
    }

    /// The naming the panic hook relies on is the naming the appender actually
    /// produces. If these drift, a panic is written to a file the support
    /// bundle does not collect — and nothing else would notice.
    #[test]
    fn the_appender_writes_the_filename_the_panic_hook_targets() {
        let dir = temp();
        // Bracket the write. Sampling the date only afterwards would make this
        // fail for one instant a day, when the appender names a file at
        // 23:59:59 and the assertion recomputes the date after midnight.
        let before = today_utc();
        let (subscriber, worker) = build_subscriber(dir.path()).expect("subscriber");
        tracing::subscriber::with_default(subscriber, || {
            tracing::warn!("naming check");
        });
        drop(worker);
        let after = today_utc();

        let produced = std::fs::read_dir(dir.path())
            .expect("read logs dir")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .find(|n| is_rust_log_name(n))
            .expect("the appender wrote a file this module recognises");

        let candidates: Vec<String> = [before, after]
            .iter()
            .map(|d| {
                rust_log_path(dir.path(), *d)
                    .file_name()
                    .expect("name")
                    .to_string_lossy()
                    .to_string()
            })
            .collect();
        assert!(
            candidates.contains(&produced),
            "the panic hook would write to {candidates:?}, the appender wrote {produced:?}"
        );
    }

    #[test]
    fn a_panic_record_is_one_escaped_line() {
        let record = format_panic_record(
            "2026-08-03T10:00:00Z",
            Some("main"),
            "assertion failed\n  left: 1\n right: 2",
            Some(("src-tauri/src/app.rs", 42, 9)),
        );
        assert_eq!(
            record,
            "2026-08-03T10:00:00Z PANIC thread=main at src-tauri/src/app.rs:42:9: \
             assertion failed\\n  left: 1\\n right: 2\n"
        );
        assert_eq!(
            record.matches('\n').count(),
            1,
            "a multi-line panic record reads as several unrelated events"
        );
    }

    #[test]
    fn a_panic_record_without_a_location_still_says_something() {
        let record = format_panic_record("2026-08-03T10:00:00Z", None, "boom", None);
        assert_eq!(
            record,
            "2026-08-03T10:00:00Z PANIC thread=unnamed at unknown location: boom\n"
        );
    }

    /// The hook appends synchronously, because `panic = "abort"` means there is
    /// no unwind and therefore no flush of anything still buffered.
    #[test]
    fn a_panic_record_is_appended_to_the_daily_file() {
        let dir = temp();
        let path = rust_log_path(dir.path(), today_utc());
        write(&path, "an earlier line\n");

        append_panic_record(&path, "the panic line\n").expect("append");

        assert_eq!(read(&path), "an earlier line\nthe panic line\n");
    }

    #[test]
    fn the_support_bundle_carries_both_traces_and_the_rust_logs() {
        let dir = temp();
        let bundle = temp();
        write(&dir.path().join(CLIENT_TRACE), "live trace\n");
        write(&dir.path().join(CLIENT_TRACE_PREV), "previous trace\n");
        write(&dir.path().join("candidcue-rust.2026-08-02.log"), "day one\n");
        write(&dir.path().join("candidcue-rust.2026-08-03.log"), "day two\n");
        // Decoys: neither is ours, and neither belongs in something the user
        // hands to a stranger.
        write(&dir.path().join("candidcue-rust.notes.log"), "not a log\n");
        write(&dir.path().join("secrets.txt"), "not ours\n");

        copy_support_logs(dir.path(), bundle.path()).expect("copy");

        let logs = bundle.path().join("logs");
        assert_eq!(read(&logs.join(CLIENT_TRACE)), "live trace\n");
        assert_eq!(read(&logs.join(CLIENT_TRACE_PREV)), "previous trace\n");
        assert_eq!(read(&logs.join("candidcue-rust.2026-08-02.log")), "day one\n");
        assert_eq!(read(&logs.join("candidcue-rust.2026-08-03.log")), "day two\n");
        assert!(!logs.join("candidcue-rust.notes.log").exists());
        assert!(!logs.join("secrets.txt").exists());
    }

    #[test]
    fn the_support_bundle_survives_an_empty_log_directory() {
        let dir = temp();
        let bundle = temp();
        copy_support_logs(dir.path(), bundle.path()).expect("copy");
        assert!(bundle.path().join("logs").is_dir());
    }

    /// An oversized log is copied from its tail — the end of a log is where the
    /// failure is — starting at a line boundary and marked as incomplete.
    #[test]
    fn an_oversized_log_is_copied_from_its_tail() {
        let dir = temp();
        let bundle = temp();
        let mut contents = String::new();
        for i in 0..500 {
            contents.push_str(&format!("line {i}\n"));
        }
        write(&dir.path().join("candidcue-rust.2026-08-03.log"), &contents);

        copy_support_logs_with_limit(dir.path(), bundle.path(), 64).expect("copy");

        let copied = read(&bundle.path().join("logs/candidcue-rust.2026-08-03.log"));
        assert!(copied.starts_with(TRUNCATION_MARKER), "{copied:?}");
        assert!(copied.ends_with("line 499\n"), "the tail must be the newest lines");
        assert!(
            !copied.contains("line 0\n"),
            "the beginning should have been dropped"
        );
        // Every retained line is whole.
        for line in copied.lines().skip(1) {
            assert!(line.starts_with("line "), "half a line survived: {line:?}");
        }
    }

    /// A tail that already begins on a line boundary must keep its first line.
    ///
    /// The naive "drop everything up to the first newline" loses a whole
    /// complete line here for nothing — and in the degenerate case below it
    /// loses the entire file.
    #[test]
    fn a_tail_starting_on_a_line_boundary_keeps_its_first_line() {
        let dir = temp();
        let bundle = temp();
        // 16 bytes: two 8-byte lines. A window of exactly 8 begins precisely
        // after the first line's newline.
        write(
            &dir.path().join("candidcue-rust.2026-08-03.log"),
            "aaaaaaa\nbbbbbbb\n",
        );

        copy_support_logs_with_limit(dir.path(), bundle.path(), 8).expect("copy");

        let copied = read(&bundle.path().join("logs/candidcue-rust.2026-08-03.log"));
        assert_eq!(
            copied,
            format!("{TRUNCATION_MARKER}bbbbbbb\n"),
            "the last complete line must survive"
        );
    }

    /// The degenerate case: the window's only newline is its final byte.
    ///
    /// Draining through it leaves nothing at all, so the bundle would contain a
    /// file holding the truncation marker and not one line of log — which reads
    /// as "the log was empty" rather than "the copy was wrong".
    #[test]
    fn a_tail_whose_only_newline_is_its_last_byte_is_not_emptied() {
        let dir = temp();
        let bundle = temp();
        write(
            &dir.path().join("candidcue-rust.2026-08-03.log"),
            "xxxxxxxxxxxx\nyyyy\n",
        );

        // A 5-byte window is exactly "yyyy\n", which begins on a boundary.
        copy_support_logs_with_limit(dir.path(), bundle.path(), 5).expect("copy");

        let copied = read(&bundle.path().join("logs/candidcue-rust.2026-08-03.log"));
        assert!(
            copied.ends_with("yyyy\n"),
            "the tail must not be drained to nothing: {copied:?}"
        );
    }

    /// The bug that clearing logs would otherwise introduce. Unlinking the file
    /// the appender holds open leaves it writing into an inode with no name, so
    /// the app goes on "logging" to somewhere nobody can read.
    #[test]
    fn clearing_truncates_the_open_rust_log_instead_of_unlinking_it() {
        let dir = temp();
        let path = rust_log_path(dir.path(), today_utc());
        write(&path, "before the clear\n");
        // Stand in for the appender: a handle held open across the clear.
        let mut held = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("open");

        let stats = clear_logs(dir.path()).expect("clear");

        assert!(path.exists(), "the appender's file must keep its name");
        assert_eq!(std::fs::metadata(&path).expect("meta").len(), 0);
        assert_eq!(stats.removed_files, 1);
        assert_eq!(stats.removed_bytes, "before the clear\n".len() as u64);

        held.write_all(b"after the clear\n").expect("write");
        assert_eq!(
            read(&path),
            "after the clear\n",
            "writes through the held handle must still be retrievable by path"
        );
    }

    #[test]
    fn clearing_removes_the_client_traces() {
        let dir = temp();
        write(&dir.path().join(CLIENT_TRACE), "live\n");
        write(&dir.path().join(CLIENT_TRACE_PREV), "previous\n");

        let stats = clear_logs(dir.path()).expect("clear");

        assert!(!dir.path().join(CLIENT_TRACE).exists());
        assert!(!dir.path().join(CLIENT_TRACE_PREV).exists());
        assert_eq!(stats.removed_files, 2);
    }

    #[test]
    fn clearing_an_absent_directory_is_not_an_error() {
        let dir = temp();
        let missing = dir.path().join("nope");
        let stats = clear_logs(&missing).expect("clear");
        assert_eq!(stats.removed_files, 0);
    }

    /// `handle.manage` requires `Send + Sync + 'static`. If `WorkerGuard` ever
    /// stops satisfying that, this fails at compile time here rather than in
    /// the middle of `setup`.
    #[test]
    fn the_logging_guard_can_be_managed_by_tauri() {
        fn assert_managed<T: Send + Sync + 'static>() {}
        assert_managed::<LoggingGuard>();
    }
}
