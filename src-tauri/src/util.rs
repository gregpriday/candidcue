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

/// Hash a file WITHOUT reading it into memory.
///
/// This used to be `sha256_hex(&fs::read(path)?)`, so verifying a Listener pack
/// allocated every clip in full — hundreds of megabytes for a pack with several
/// loops, all at once, just to compute a digest (M3).
pub fn sha256_file(path: &Path) -> Result<String, AppError> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = std::io::Read::read(&mut file, &mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
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
    fs::create_dir_all(dir)?;
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
    if let Err(err) = fs::rename(&tmp_path, dest) {
        let _ = fs::remove_file(&tmp_path);
        return Err(err.into());
    }

    // Make the directory entry itself durable. Best effort: some filesystems
    // (and Windows) do not support opening a directory for sync.
    if let Ok(dir_handle) = fs::File::open(dir) {
        let _ = dir_handle.sync_all();
    }
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
