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

/// Every input to what the benchmark measures, relative to `crates/`: the
/// three crates, the workspace manifest and lockfile, and the model catalogue
/// the gate compiles in. One list drives both what Cargo watches and what
/// counts as dirty, so the two cannot disagree about a file.
const INPUTS: &[&str] = &[
    "cc-align",
    "cc-stt",
    "cc-bench",
    "Cargo.toml",
    "Cargo.lock",
    "../src-tauri/models/catalogue.json",
];

/// Watch a path only if it exists: Cargo reruns a build script on every build
/// when told to watch a path that is not there, and `packed-refs`, or a loose
/// ref once it has been packed, often is not.
fn watch(path: &Path) {
    if path.exists() {
        println!("cargo:rerun-if-changed={}", path.display());
    }
}

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let crates = manifest.parent().unwrap().to_path_buf();

    // Cargo scans a watched directory recursively for modified files.
    for input in INPUTS {
        watch(&crates.join(input));
    }

    let Some(commit) = git(&manifest, &["rev-parse", "HEAD"]) else {
        return;
    };
    if commit.is_empty() {
        return;
    }
    for name in ["HEAD", "packed-refs"] {
        if let Some(path) = git_path(&manifest, name) {
            watch(&path);
        }
    }
    if let Some(branch) = git(&manifest, &["symbolic-ref", "-q", "HEAD"]) {
        if let Some(path) = git_path(&manifest, &branch) {
            watch(&path);
        }
    }

    // Dirty means an uncommitted change to an input. A stray file elsewhere in
    // the repository does not change a measurement, and calling it dirty
    // would teach people to ignore the flag. A status that cannot be read is
    // dirty: clean is a claim, and nothing here can make it.
    let mut status = vec!["status", "--porcelain", "--untracked-files=normal", "--"];
    status.extend_from_slice(INPUTS);
    let dirty = git(&crates, &status).is_none_or(|s| !s.is_empty());

    println!("cargo:rustc-env=CC_BENCH_COMMIT={commit}");
    println!("cargo:rustc-env=CC_BENCH_DIRTY={}", if dirty { "1" } else { "0" });
}
