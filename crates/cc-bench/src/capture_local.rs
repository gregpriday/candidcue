//! Capture: stream fixture audio through the on-device recogniser and persist
//! the event log in the shape `bench/runs*/` holds.
//!
//! A run directory is `events.jsonl` + `gold.json` + `manifest.json` +
//! `performance.txt`, and `tier-b --runs DIR` scores any of them with the same
//! evaluator against the same gold timeline. That shape predates this module —
//! the corpora captured before the recogniser moved on-device are written the
//! same way — which is what makes the older ones still comparable.
//!
//! Capture runs at real-time pace: the model is roughly 16× faster than real
//! time on this hardware, and partial-latency numbers taken faster than 1.0×
//! describe a machine nobody is presenting from.

use std::path::Path;

use cc_stt::{LocalRecognizer, SttFrame};

/// Stream `pcm` (raw PCM16 at `sample_rate`) through `recognizer` and return
/// every frame observed, in order.
pub fn capture_events(
    recognizer: &LocalRecognizer,
    pcm: &[u8],
    sample_rate: u32,
    pace: f64,
    prime_ms: u32,
) -> Vec<SttFrame> {
    let mut events = Vec::new();
    cc_stt::local::stream_pcm16(recognizer, pcm, sample_rate, 100, pace, prime_ms, |frame| {
        events.push(frame)
    });
    events
}

/// Read a captured run's event log, refusing anything that is not one.
///
/// ## Why this is not just `read_to_string` and a parse
///
/// The corpora under `bench/runs*/` are in **Git LFS**. Without a fetch, an
/// `events.jsonl` is not a truncated log — it is a ~130-byte pointer file:
///
/// ```text
/// version https://git-lfs.github.com/spec/v1
/// oid sha256:e3b0c44298fc1c149afbf4c8996fb924…
/// size 4823901
/// ```
///
/// The old reader parsed that as three lines of invalid JSON and returned an
/// error — which several call sites turned into "this run has no events" and
/// scored as a clean empty corpus. `bench/README.md` warns about exactly this,
/// and a warning in a README is not a gate. A benchmark that reports PASS
/// having replayed nothing is worse than one that fails: it is the shape of
/// evidence with none of the substance, and it is what a release would be
/// signed off against.
///
/// So: a pointer is named as a pointer, a corpus with no events is an error
/// rather than an empty vector, and a malformed line says which line.
pub fn read_events_jsonl(path: &Path) -> anyhow::Result<Vec<SttFrame>> {
    let text = std::fs::read_to_string(path)
        .map_err(|err| anyhow::anyhow!("{}: {err}", path.display()))?;

    if is_lfs_pointer(&text) {
        anyhow::bail!(
            "{} is a Git LFS pointer, not a captured run. The benchmark corpora are stored \
             in LFS; run `git lfs fetch --all && git lfs checkout` and try again. \
             (`git lfs ls-files` lists what should be materialised.)",
            path.display()
        );
    }

    let mut events = Vec::new();
    for (index, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        events.push(serde_json::from_str(line).map_err(|err| {
            anyhow::anyhow!("{}:{}: not a captured frame — {err}", path.display(), index + 1)
        })?);
    }

    if events.is_empty() {
        anyhow::bail!(
            "{} contains no events. A corpus that replays nothing scores as a clean pass, \
             which is the one result a benchmark must never produce by accident.",
            path.display()
        );
    }

    Ok(events)
}

/// Is this the pointer file Git LFS leaves behind instead of the content?
///
/// Matched on the spec's own first line rather than on size or on "does it
/// parse", both of which would also match other kinds of broken file and say
/// something less useful about them.
fn is_lfs_pointer(text: &str) -> bool {
    text.lines()
        .next()
        .map(|line| line.trim().starts_with("version https://git-lfs.github.com/spec/"))
        .unwrap_or(false)
}

pub fn write_events_jsonl(path: &Path, events: &[SttFrame]) -> anyhow::Result<()> {
    let mut out = String::new();
    for e in events {
        out.push_str(&serde_json::to_string(e)?);
        out.push('\n');
    }
    std::fs::write(path, out)?;
    Ok(())
}

#[cfg(test)]
mod corpus_integrity_tests {
    use super::*;

    fn write(dir: &std::path::Path, name: &str, body: &str) -> std::path::PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, body).expect("write");
        path
    }

    /// The failure the whole gate exists for. `bench/README.md` has always
    /// warned that an unfetched corpus is a ~130-byte pointer and that a run
    /// "finds no events rather than failing loudly" — a warning in a README is
    /// not a gate, and a benchmark that reports PASS having replayed nothing is
    /// the shape of evidence with none of the substance.
    #[test]
    fn an_lfs_pointer_is_named_as_one() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(
            dir.path(),
            "events.jsonl",
            "version https://git-lfs.github.com/spec/v1\n\
             oid sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n\
             size 4823901\n",
        );

        let err = read_events_jsonl(&path).expect_err("a pointer is not a corpus");
        let message = err.to_string();
        assert!(message.contains("Git LFS"), "{message}");
        assert!(
            message.contains("git lfs"),
            "the error must say how to fix it: {message}"
        );
    }

    /// An empty file is not a corpus either. It parses to zero events, which
    /// every scorer treats as a clean run.
    #[test]
    fn an_empty_corpus_is_an_error_rather_than_an_empty_pass() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(dir.path(), "events.jsonl", "\n\n   \n");

        let err = read_events_jsonl(&path).expect_err("nothing to replay is a failure");
        assert!(err.to_string().contains("no events"), "{err}");
    }

    /// And a real one still reads, or the gate above would be the only thing
    /// this function does.
    #[test]
    fn a_real_corpus_still_reads() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(
            dir.path(),
            "events.jsonl",
            "{\"kind\":\"itemStarted\",\"itemId\":\"1-0\",\"ordinal\":0,\"audioStartMs\":0.0}\n\
             {\"kind\":\"final\",\"itemId\":\"1-0\",\"text\":\"hello\",\"audioEndMs\":900.0,\"wallMs\":1100.0}\n",
        );

        let events = read_events_jsonl(&path).expect("a real corpus reads");
        assert_eq!(events.len(), 2);
    }

    /// A malformed line says WHICH line. A bare serde error on a 40 MB corpus
    /// is not something anyone can act on.
    #[test]
    fn a_malformed_line_is_located() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write(
            dir.path(),
            "events.jsonl",
            "{\"kind\":\"itemStarted\",\"itemId\":\"1-0\",\"ordinal\":0,\"audioStartMs\":0.0}\n\
             not json at all\n",
        );

        let err = read_events_jsonl(&path).expect_err("a broken line is a failure");
        assert!(err.to_string().contains(":2:"), "{err}");
    }
}
