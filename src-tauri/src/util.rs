//! Small shared helpers: time, hashing, atomic file writes.

use std::fs;
use std::io::Write;
use std::path::Path;

use sha2::{Digest, Sha256};

use crate::errors::AppError;

/// UTC timestamp in RFC 3339 with second precision (spec Appendix B note:
/// timestamps are UTC RFC 3339 strings).
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn new_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// List a folder inside a script's own folder, to index what is in it again
/// (#252).
///
/// `Ok(None)` when there is no such folder, or when it is a symbolic link or
/// not a folder at all — noted, and not followed: a link's entries are files
/// from outside the script's folder, presented as the script's own. Any other
/// failure to list it is an error, because "could not look" is not "empty".
pub(crate) fn read_owned_dir(
    dir: &Path,
    notes: &mut Vec<String>,
) -> std::io::Result<Option<fs::ReadDir>> {
    let name = dir.file_name().unwrap_or_default().to_string_lossy().to_string();
    match fs::symlink_metadata(dir) {
        Ok(meta) if meta.file_type().is_symlink() => {
            notes.push(format!("{name}/ is a link, and was not followed"));
            Ok(None)
        }
        Ok(meta) if !meta.is_dir() => {
            notes.push(format!("{name} is not a folder, and was not read"));
            Ok(None)
        }
        Ok(_) => fs::read_dir(dir).map(Some),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err),
    }
}

/// Cheap external-change fingerprint: byte size + mtime nanos (spec §47.5).
pub fn file_fingerprint(path: &Path) -> Result<String, AppError> {
    let meta = fs::metadata(path)?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    Ok(format!("{}:{}", meta.len(), mtime))
}

/// Write to a uniquely named temporary file in the same directory, fsync the
/// file, atomically rename it over the destination, then fsync the directory
/// (spec §21.3, §47.5).
///
/// The temp name is claimed with `create_new` and a monotonic counter, so two
/// writers in the same process can never truncate each other's temp file — the
/// previous `<name>.tmp-<pid>` scheme guaranteed a collision for concurrent
/// writes to the same destination. The parent-directory sync is what makes the
/// new directory entry survive power loss; without it the rename itself is not
/// durable even though the file contents are.
/// fsync a directory, so an entry created or removed inside it survives a power
/// loss.
///
/// [`atomic_write`] does this for the directory the file it writes lives in.
/// This is for the callers that create the DIRECTORY: a new script's folder is
/// an entry in `scripts/`, and an entry that never reached the platter takes
/// everything under it with it.
///
/// No-op off Unix, which has no directory handle to flush and journals its
/// renames instead.
pub fn sync_dir(dir: &Path) -> Result<(), AppError> {
    #[cfg(unix)]
    {
        fs::File::open(dir)?.sync_all()?;
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
    }
    Ok(())
}

/// `create_dir_all`, with every directory it creates made durable.
///
/// ---------------------------------------------------------------------------
/// WHY THE PLAIN VERSION IS NOT ENOUGH
/// ---------------------------------------------------------------------------
/// A directory entry is metadata in its PARENT, and `create_dir_all` returns as
/// soon as the entry exists in the page cache. Every write underneath it can
/// then be fsynced perfectly and still vanish, because the folder holding them
/// was never committed — and the SQLite row naming the file IS durable, so what
/// survives is a library listing a script whose file is nowhere.
///
/// This creates the same directories and then fsyncs the parent of each one it
/// actually had to create, deepest last. Directories that already existed are
/// left alone: their entries are long since on disk, and syncing them would
/// cost an fsync per call on the hot path for nothing.
pub fn create_dir_all_durable(dir: &Path) -> Result<(), AppError> {
    // Which ancestors are missing, deepest first, before anything is created.
    let mut missing: Vec<&Path> = Vec::new();
    let mut cursor = Some(dir);
    while let Some(path) = cursor {
        if path.exists() {
            break;
        }
        missing.push(path);
        cursor = path.parent();
    }
    if missing.is_empty() {
        return Ok(());
    }
    fs::create_dir_all(dir)?;
    // Shallowest first: a parent's entry has to be durable before the child's
    // entry inside it means anything.
    for created in missing.iter().rev() {
        if let Some(parent) = created.parent() {
            sync_dir(parent)?;
        }
    }
    Ok(())
}

/// `fs::rename`, patient on Windows. Every rename in the app goes through it.
///
/// Windows will not rename or replace a file that another process holds open
/// without delete sharing — and on an ordinary Windows machine that other
/// process is very often not ours: Defender and the search indexer open a file
/// moments after it is written, to scan it, and hold it for a few
/// milliseconds. On macOS that is invisible; on Windows it failed a save, an
/// export or a restore at random with "being used by another process" (os
/// error 32). Those refusals are transient by nature, so they are retried with
/// a short backoff for up to two seconds: sharing and lock violations (32, 33)
/// and access denied (5), which is how the same race reads while the other
/// handle is being closed. A refusal that is still there after that is
/// returned as it is. Everywhere else this is exactly `fs::rename`.
pub fn rename(from: impl AsRef<Path>, to: impl AsRef<Path>) -> std::io::Result<()> {
    let (from, to) = (from.as_ref(), to.as_ref());
    #[cfg(windows)]
    {
        use std::time::{Duration, Instant};
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut delay = Duration::from_millis(10);
        loop {
            match fs::rename(from, to) {
                Err(err)
                    if matches!(err.raw_os_error(), Some(5 | 32 | 33)) && Instant::now() < deadline =>
                {
                    std::thread::sleep(delay);
                    delay = (delay * 2).min(Duration::from_millis(200));
                }
                result => return result,
            }
        }
    }
    #[cfg(not(windows))]
    {
        fs::rename(from, to)
    }
}

/// fsync one file by path, for callers that produced it some other way.
pub fn sync_file(path: &Path) -> Result<(), AppError> {
    open_for_sync(path)?.sync_all()?;
    Ok(())
}

/// Open an existing file so that `sync_all` may be called on it.
///
/// On Unix any descriptor will do, read-only included. Windows is stricter:
/// `sync_all` is `FlushFileBuffers`, which refuses a handle without write
/// access — so the read-only open every caller used to make failed with
/// "Access is denied" (os error 5) on every file, and with it every export,
/// restore and duplicate that flushes what it copied. Write access without
/// create or truncate changes nothing about the file.
pub fn open_for_sync(path: &Path) -> std::io::Result<fs::File> {
    if cfg!(windows) {
        fs::OpenOptions::new().write(true).open(path)
    } else {
        fs::File::open(path)
    }
}

pub fn atomic_write(dest: &Path, contents: &[u8]) -> Result<(), AppError> {
    atomic_write_with(dest, |file| {
        file.write_all(contents)?;
        Ok(())
    })
}

/// Same durability contract as [`atomic_write`], but the caller streams the
/// contents into the temporary file instead of materialising them first.
///
/// This is what makes a bundle export an atomic REPLACE. `File::create` on the
/// operator's chosen destination truncates it the instant the zip writer opens,
/// so a failure part-way through — or simply choosing a destination that turned
/// out to be an existing file — destroyed whatever was there. It also follows a
/// symlink, whereas the rename below replaces the link itself.
pub fn atomic_write_with<F>(dest: &Path, write: F) -> Result<(), AppError>
where
    F: FnOnce(&mut fs::File) -> Result<(), AppError>,
{
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);

    let dir = dest
        .parent()
        .ok_or_else(|| AppError::Internal("atomic_write: destination has no parent".into()))?;
    /*
     * Durably, because this can be the directory the write depends on.
     *
     * Startup reconciliation recovers an orphaned script file without
     * recreating its `revisions/` folder, so the next save creates it here —
     * and then writes the pre-save text into it and commits a durable revision
     * row. A plain `create_dir_all` leaves that folder's entry in the page
     * cache, so a power loss takes the retained pre-save text with it while the
     * canonical file has already been overwritten.
     */
    create_dir_all_durable(dir)?;
    let base = dest
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());

    let mut tmp = None;
    let mut last_err = None;
    for _ in 0..32 {
        let candidate = dir.join(format!(
            ".{}.tmp-{}-{}",
            base,
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => {
                tmp = Some((candidate, file));
                break;
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                last_err = Some(err);
                continue;
            }
            Err(err) => return Err(err.into()),
        }
    }
    let (tmp_path, mut file) = tmp.ok_or_else(|| {
        AppError::Internal(format!(
            "atomic_write: could not claim a temporary file in {}: {:?}",
            dir.display(),
            last_err
        ))
    })?;

    // From here on any failure must clean up the temp file rather than leave
    // a partial write behind.
    let write_result = write(&mut file).and_then(|()| file.sync_all().map_err(Into::into));
    drop(file);
    if let Err(err) = write_result {
        let _ = fs::remove_file(&tmp_path);
        return Err(err);
    }
    if let Err(err) = rename(&tmp_path, dest) {
        let _ = fs::remove_file(&tmp_path);
        return Err(err.into());
    }

    /*
     * Make the directory entry itself durable, and REPORT if that fails.
     *
     * This used to swallow both the open and the sync. The rename is what
     * publishes the new contents, so an unflushed directory entry means an
     * acknowledged save can revert to the previous version after a power loss —
     * and the caller was told it had been written. `sync_dir` is already a
     * documented no-op off Unix, which is the case the swallowing was there
     * for, so nothing is lost by letting a real error through.
     */
    sync_dir(dir)?;
    Ok(())
}

/// Reject path components that could escape a managed root (spec §21.6).
pub fn is_safe_relative_path(path: &str) -> bool {
    if path.is_empty() || path.starts_with('/') || path.starts_with('\\') {
        return false;
    }
    // Windows drive letters / UNC.
    if path.len() >= 2 && path.as_bytes()[1] == b':' {
        return false;
    }
    !path.split(['/', '\\']).any(|c| c == ".." || c.is_empty() || c == ".")
}

/// Ensure a canonicalized path stays inside a canonicalized root
/// (spec §47.8: reject symlinks escaping roots).
pub fn is_within_root(candidate: &Path, root: &Path) -> bool {
    match (candidate.canonicalize(), root.canonicalize()) {
        (Ok(c), Ok(r)) => c.starts_with(&r),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_relative_paths() {
        assert!(is_safe_relative_path("assets/img.png"));
        assert!(is_safe_relative_path("script.md"));
        assert!(!is_safe_relative_path("../escape.md"));
        assert!(!is_safe_relative_path("/abs/path.md"));
        assert!(!is_safe_relative_path("a/../b.md"));
        assert!(!is_safe_relative_path("C:\\windows\\path"));
        assert!(!is_safe_relative_path(""));
    }

    #[test]
    fn atomic_write_replaces_content() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("out.md");
        atomic_write(&dest, b"one").unwrap();
        atomic_write(&dest, b"two").unwrap();
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "two");
        // No stray temp files left behind.
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty());
    }
}
