//! Stamp the cc-bench binary with the commit it was built from.
//!
//! A saved benchmark result records the revision that produced it
//! (`provenance::Revision`), and that has to be the revision of the CODE that
//! ran, not of whatever checkout the binary happens to be launched from — a
//! binary built at one commit can replay a corpus in another worktree. So the
//! commit is read here, at build time, and baked in.
//!
//! The stamp is only as fresh as the last time this script ran, so it tells
//! Cargo to rerun it whenever the answer could change: a commit (the ref HEAD
//! points at, or HEAD itself when detached, or `packed-refs` after a gc), or
//! an edit to any crate the benchmark compiles — which is also what makes the
//! `dirty` flag honest, since an uncommitted edit to cc-align changes what the
//! benchmark measures without changing the commit.
//!
//! A build with no Git at all (a source tarball) stamps nothing, and the
//! result says its revision is unknown rather than guessing.

use std::path::{Path, PathBuf};
use std::process::Command;

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git").current_dir(dir).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// `git rev-parse --git-path`, resolved against the manifest directory: the
/// path Git prints is relative to where it ran, and a worktree's refs live in
/// the common directory rather than beside its own `HEAD`.
fn git_path(dir: &Path, name: &str) -> Option<PathBuf> {
    let p = PathBuf::from(git(dir, &["rev-parse", "--git-path", name])?);
    Some(if p.is_absolute() { p } else { dir.join(p) })
}

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let crates = manifest.parent().unwrap().to_path_buf();

    // Every input to what the benchmark measures. Cargo scans a directory
    // recursively for modified files.
    println!("cargo:rerun-if-changed=build.rs");
    for input in ["cc-bench/src", "cc-bench/Cargo.toml", "cc-align", "cc-stt", "Cargo.lock"] {
        println!("cargo:rerun-if-changed={}", crates.join(input).display());
    }

    let Some(commit) = git(&manifest, &["rev-parse", "HEAD"]) else {
        return;
    };
    for name in ["HEAD", "packed-refs"] {
        if let Some(path) = git_path(&manifest, name) {
            println!("cargo:rerun-if-changed={}", path.display());
        }
    }
    if let Some(branch) = git(&manifest, &["symbolic-ref", "-q", "HEAD"]) {
        if let Some(path) = git_path(&manifest, &branch) {
            println!("cargo:rerun-if-changed={}", path.display());
        }
    }

    // Dirty means an uncommitted change to the code that ran: the three crates
    // and their lockfile. A stray file elsewhere in the repository does not
    // change a measurement, and calling it dirty would teach people to ignore
    // the flag.
    let dirty = git(
        &crates,
        &["status", "--porcelain", "--untracked-files=normal", "--", "cc-align", "cc-stt", "cc-bench", "Cargo.lock"],
    )
    .is_some_and(|s| !s.is_empty());

    println!("cargo:rustc-env=CC_BENCH_COMMIT={commit}");
    println!("cargo:rustc-env=CC_BENCH_DIRTY={}", if dirty { "1" } else { "0" });
}
