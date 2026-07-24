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

pub fn sha256_file(path: &Path) -> Result<String, AppError> {
    let bytes = fs::read(path)?;
    Ok(sha256_hex(&bytes))
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

/// Write to a temporary file in the same directory, fsync, then atomically
/// rename over the destination (spec §21.3).
pub fn atomic_write(dest: &Path, contents: &[u8]) -> Result<(), AppError> {
    let dir = dest
        .parent()
        .ok_or_else(|| AppError::Internal("atomic_write: destination has no parent".into()))?;
    fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(
        ".{}.tmp-{}",
        dest.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "file".into()),
        std::process::id()
    ));
    {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(contents)?;
        file.sync_all()?;
    }
    fs::rename(&tmp, dest)?;
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
