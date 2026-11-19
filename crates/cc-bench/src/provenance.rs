//! What produced a benchmark number.
//!
//! A saved Tier B or Tier C result used to carry a free-text label, the
//! alignment config and its numbers — nothing that said which language was
//! spoken, which recogniser heard it, how that recogniser was tuned, which
//! stage layout drew it, or which build of this harness did the work. So
//! `gate-language` certified whatever file it was handed under whatever name
//! the operator typed, and English results labelled `fr` passed as French.
//!
//! Provenance is recorded where each fact is actually known:
//!
//! - **At capture**, beside every run's `events.jsonl`, as `capture.json`
//!   ([`CaptureRecord`]): the language the corpus was declared to be in, the
//!   catalogue model whose tuning was applied, the digests of the weights that
//!   were really loaded, every resolved recogniser knob, the pace, and the
//!   cc-bench build. Per RUN rather than per corpus, because a corpus is filled
//!   across capture sessions — `capture-local` skips runs already captured —
//!   and two sessions can differ.
//! - **At replay**, in the saved result ([`Provenance`]): the replaying build,
//!   the alignment language the scripts were compiled under, every run's
//!   capture record, and for Tier C the exact layouts it rendered, including
//!   `focus_lead_atoms`.
//!
//! Each `capture.json` carries a digest of the four fixture files it
//! describes, so a record copied into another corpus, or left behind when a
//! run's events were replaced, is refused at replay instead of lending its
//! conditions to audio it never heard.
//!
//! What this does NOT do is authenticate a result. Somebody who edits a saved
//! file consistently — provenance and numbers together — produces a file the
//! gate will read. The point is that results this harness writes say what
//! produced them, and that the gate refuses ones that do not.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::stage::Layout;

/// The file each captured run's record lives in.
pub const CAPTURE_FILE: &str = "capture.json";

/// The fixture files a capture record's digest covers, in digest order.
pub const FIXTURE_FILES: &[&str] = &["events.jsonl", "gold.json", "manifest.json", "performance.txt"];

/// The cc-bench build that did something.
///
/// Read from the build (see `build.rs`), not from the checkout at run time:
/// a binary built at one commit can replay a corpus in another.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Revision {
    /// The full commit hash, or `None` for a build made without Git.
    pub commit: Option<String>,
    /// Whether cc-align, cc-stt, cc-bench or their lockfile had uncommitted
    /// changes when the binary was built. A dirty build's numbers are not
    /// reproducible from the commit alone.
    pub dirty: bool,
}

impl Revision {
    /// The build this binary is.
    pub fn current() -> Self {
        Revision {
            commit: option_env!("CC_BENCH_COMMIT").map(str::to_string),
            dirty: option_env!("CC_BENCH_DIRTY") == Some("1"),
        }
    }

    /// Whether this revision names code somebody else can check out: a real
    /// commit, built clean. Two dirty builds of one commit record the same
    /// stamp and can be different programs, so neither is evidence.
    pub fn is_reproducible(&self) -> bool {
        self.commit.as_deref().is_some_and(|c| !c.trim().is_empty()) && !self.dirty
    }

    pub fn describe(&self) -> String {
        match &self.commit {
            Some(c) if self.dirty => format!("{} (dirty)", &c[..c.len().min(12)]),
            Some(c) => c[..c.len().min(12)].to_string(),
            None => "unknown".to_string(),
        }
    }
}

/// One model file as it was loaded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WeightFile {
    pub name: String,
    pub bytes: u64,
    pub sha256: String,
}

/// The conditions one run was captured under. Written by `capture-local` as
/// `capture.json` beside the run's events.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CaptureRecord {
    /// The run's manifest name. A record whose name is not its directory's
    /// manifest name was copied from somewhere else.
    pub run: String,
    /// The BCP-47 tag the corpus was declared to be spoken in. The recogniser
    /// is not told it — sherpa has no language switch — so this is the
    /// operator's statement about the audio, checked against what the model
    /// serves and what the engine compiles.
    pub language: String,
    /// The `cc_stt::BundledModel::id` whose tuning was applied. On its own it
    /// says whose TUNING, not whose weights: `--model` names a directory.
    pub model: String,
    /// What was actually in that directory: every file the recogniser loaded,
    /// with its SHA-256. This is what says whose weights.
    pub weights: Vec<WeightFile>,
    /// Every resolved recogniser knob, after the model's tuning and any
    /// command-line overrides — the config the recogniser was loaded with.
    pub recogniser: cc_stt::LocalSttConfig,
    /// Audio pacing: 1.0 is real time. Recorded, not judged — no metric
    /// depends on it — but a fixture's latencies are only honest at 1.0.
    pub pace: f64,
    /// The cc-bench build that captured.
    pub revision: Revision,
    /// SHA-256 over [`FIXTURE_FILES`], each name and length-prefixed.
    pub fixture_sha256: String,
}

impl CaptureRecord {
    /// The conditions with what legitimately differs between two runs of one
    /// capture removed: the run's own name and fixture digest, the model
    /// directory, which is a path on one machine, and the pace, which no
    /// metric reads (every one is a function of the audio clock).
    pub fn conditions(&self) -> CaptureRecord {
        let mut c = self.clone();
        c.run = String::new();
        c.fixture_sha256 = String::new();
        c.recogniser.model_dir = Default::default();
        c.pace = 1.0;
        // `EN-US` and `en-US` are one tag.
        c.language = c.language.to_ascii_lowercase();
        c
    }
}

/// Where a result's events came from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Source {
    /// Synthesised events from the Tier A generator — no recogniser at all.
    Synthetic,
    /// Captured recogniser output, with each run's record by manifest name.
    /// `None` is a run captured before records existed, named so the gate can
    /// say which one.
    Captured {
        runs: BTreeMap<String, Option<CaptureRecord>>,
    },
}

/// What produced a saved result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Provenance {
    /// The cc-bench build that replayed and scored.
    pub revision: Revision,
    /// The primary subtag of the alignment language the scripts were compiled
    /// under.
    pub alignment_language: String,
    /// Whether Tier B compiled scripts the way a take does
    /// (`CC_BENCH_APP_TOKENS`).
    #[serde(default)]
    pub app_tokens: bool,
    pub source: Source,
    /// Every layout Tier C rendered, exactly as rendered — `focus_lead_atoms`
    /// included. Empty for Tier A and Tier B, which render nothing.
    #[serde(default)]
    pub layouts: Vec<Layout>,
    /// SHA-256 of the script source each run was replayed against, by run
    /// (manifest) name.
    ///
    /// By run rather than by script, so the gate compares exactly what each
    /// scoring fixture was scored against without assuming its manifest's
    /// `script` matches the family in its name.
    ///
    /// Scripts are read from the checkout at run time, not built into the
    /// binary, and a capture's fixtures do not contain them — so without this
    /// the same corpus replayed by the same build against two different
    /// edits of a script would carry identical provenance. A script edit that
    /// changes the atom count is already refused at replay; this catches the
    /// one that does not.
    #[serde(default)]
    pub scripts: BTreeMap<String, String>,
}

impl Provenance {
    /// Provenance for a replay done by this build.
    pub fn of_replay(
        source: Source,
        app_tokens: bool,
        layouts: &[Layout],
        scripts: BTreeMap<String, String>,
    ) -> Self {
        Provenance {
            revision: Revision::current(),
            alignment_language: cc_align::CompileOptions::default()
                .language
                .primary_subtag()
                .to_string(),
            app_tokens,
            source,
            layouts: layouts.to_vec(),
            scripts,
        }
    }
}

/// SHA-256 of a script's source text, for [`Provenance::scripts`].
pub fn script_digest(source: &str) -> String {
    hex(ring::digest::digest(&ring::digest::SHA256, source.as_bytes()).as_ref())
}

/// Whether `tag` is shaped like a BCP-47 language tag: a 2-3 letter primary
/// subtag, then any number of non-empty alphanumeric subtags of at most eight.
/// Not a registry lookup — enough that `en-` or `-en` is not read as English.
pub fn is_language_tag(tag: &str) -> bool {
    let mut parts = tag.trim().split(['-', '_']);
    let primary = parts.next().unwrap_or_default();
    (2..=3).contains(&primary.len())
        && primary.chars().all(|c| c.is_ascii_alphabetic())
        && parts.all(|p| (1..=8).contains(&p.len()) && p.chars().all(|c| c.is_ascii_alphanumeric()))
}

/// A primary language subtag, lowercased: `en-US` → `en`.
pub fn primary_subtag(tag: &str) -> String {
    tag.trim()
        .split(['-', '_'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// SHA-256 of a file, streamed: the encoder alone is 155 MB.
pub fn sha256_file(path: &Path) -> std::io::Result<(u64, String)> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut ctx = ring::digest::Context::new(&ring::digest::SHA256);
    let mut buf = vec![0u8; 1 << 20];
    let mut total = 0u64;
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        total += n as u64;
        ctx.update(&buf[..n]);
    }
    Ok((total, hex(ctx.finish().as_ref())))
}

/// SHA-256 over a run directory's fixture files.
///
/// Each file contributes its name and its length before its bytes, so moving
/// bytes from one file to the next cannot produce the same digest.
pub fn fixture_digest(run_dir: &Path) -> anyhow::Result<String> {
    let mut ctx = ring::digest::Context::new(&ring::digest::SHA256);
    for name in FIXTURE_FILES {
        let bytes = std::fs::read(run_dir.join(name))
            .map_err(|e| anyhow::anyhow!("{}: {e}", run_dir.join(name).display()))?;
        ctx.update(name.as_bytes());
        ctx.update(&[0]);
        ctx.update(&(bytes.len() as u64).to_le_bytes());
        ctx.update(&bytes);
    }
    Ok(hex(ctx.finish().as_ref()))
}

/// Digest every file the recogniser loads from `model_dir`.
pub fn weights_of(model_dir: &Path) -> anyhow::Result<Vec<WeightFile>> {
    let files = cc_stt::local::ModelFiles::detect(model_dir).map_err(|e| anyhow::anyhow!(e))?;
    let mut names: Vec<String> = files.loaded_files().into_iter().map(str::to_string).collect();
    names.sort();
    names
        .into_iter()
        .map(|name| {
            let (bytes, sha256) = sha256_file(&model_dir.join(&name))?;
            Ok(WeightFile { name, bytes, sha256 })
        })
        .collect()
}

/// What a capture session knows before it touches any run.
#[derive(Debug, Clone)]
pub struct CaptureConditions {
    pub language: String,
    pub model: String,
    pub weights: Vec<WeightFile>,
    pub recogniser: cc_stt::LocalSttConfig,
    pub pace: f64,
}

/// Write `capture.json` for a run whose fixture files are all in place.
///
/// Called last, after the events and the copied synthesis files: a capture
/// interrupted before this leaves a run with no record, which the gate refuses,
/// rather than a record describing files that were never finished.
pub fn seal_capture(run_dir: &Path, conditions: &CaptureConditions) -> anyhow::Result<CaptureRecord> {
    let manifest: crate::suite::RunManifest =
        serde_json::from_str(&std::fs::read_to_string(run_dir.join("manifest.json"))?)?;
    let record = CaptureRecord {
        run: manifest.name,
        language: conditions.language.clone(),
        model: conditions.model.clone(),
        weights: conditions.weights.clone(),
        recogniser: conditions.recogniser.clone(),
        pace: conditions.pace,
        revision: Revision::current(),
        fixture_sha256: fixture_digest(run_dir)?,
    };
    std::fs::write(run_dir.join(CAPTURE_FILE), serde_json::to_string_pretty(&record)?)?;
    Ok(record)
}

/// Where one capture session assembles its runs before publishing them: a
/// directory beside the corpus, private to this process.
///
/// Beside rather than inside, because Tier B and Tier C replay every directory
/// in the corpus, and a half-written run left there by an interrupted capture
/// would stop every replay. On the same filesystem, so publishing is a rename.
///
/// Created here, exclusively, under a name no other session can share: a
/// process id alone repeats across containers and hosts that share a corpus.
/// The corpus path is resolved first, so `--runs .` stages beside the corpus
/// rather than inside it.
pub fn staging_root(runs_dir: &Path) -> anyhow::Result<std::path::PathBuf> {
    let corpus = std::fs::canonicalize(runs_dir)?;
    let name = corpus
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "runs".to_string());
    let parent = corpus
        .parent()
        .ok_or_else(|| anyhow::anyhow!("{} has no parent to stage beside", corpus.display()))?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    for attempt in 0..100u32 {
        let dir = parent.join(format!(
            ".{name}.capturing-{}-{nanos:x}-{attempt}",
            std::process::id()
        ));
        match std::fs::create_dir(&dir) {
            Ok(()) => return Ok(dir),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => anyhow::bail!("cannot create a staging directory beside {}: {e}", corpus.display()),
        }
    }
    anyhow::bail!("no free staging directory name beside {}", corpus.display())
}

/// Move a staged, sealed run into the corpus, never over a finished one.
///
/// Returns `false` when the corpus already holds a captured run of that name —
/// another capture got there first — and leaves both untouched. This is what
/// keeps two captures of one corpus from interleaving: written in place, one
/// could seal the other's events with its own weights' digests, and the replay
/// would verify a record that describes a recogniser that never heard them.
pub fn publish_run(staged: &Path, out_dir: &Path) -> anyhow::Result<bool> {
    let finished = || out_dir.join("events.jsonl").exists();
    if finished() {
        return Ok(false);
    }
    // A rename onto a directory that is not empty fails on every platform; on
    // Unix one onto an EMPTY directory replaces it, which loses nothing.
    match std::fs::rename(staged, out_dir) {
        Ok(()) => Ok(true),
        Err(_) if finished() => Ok(false),
        Err(e) => anyhow::bail!(
            "cannot move {} into place at {}: {e}",
            staged.display(),
            out_dir.display()
        ),
    }
}

/// Read a run's capture record, if it has one, and check it describes this
/// run's files.
///
/// Only a missing file means "no record" — a run captured before records
/// existed. A record that cannot be read or parsed, names another run, or
/// digests different bytes is an error naming the run: those are not missing
/// provenance, they are wrong provenance.
pub fn read_capture(run_dir: &Path, run: &str) -> anyhow::Result<Option<CaptureRecord>> {
    let path = run_dir.join(CAPTURE_FILE);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => anyhow::bail!("{run}: cannot read {}: {e}", path.display()),
    };
    let record: CaptureRecord = serde_json::from_str(&text)
        .map_err(|e| anyhow::anyhow!("{run}: {} is not a capture record: {e}", path.display()))?;
    anyhow::ensure!(
        record.run == run,
        "{run}: {} describes run {}, so it was copied here from another corpus",
        path.display(),
        record.run
    );
    let digest = fixture_digest(run_dir)?;
    anyhow::ensure!(
        record.fixture_sha256 == digest,
        "{run}: {} was written for different fixture files than the ones here \
         (the events, gold, manifest or performance text changed after capture)",
        path.display()
    );
    Ok(Some(record))
}

/// Collect a run's record into a captured source, refusing a manifest name
/// seen twice: two directories claiming one run would otherwise overwrite one
/// record with the other.
pub fn insert_run(
    runs: &mut BTreeMap<String, Option<CaptureRecord>>,
    run: &str,
    record: Option<CaptureRecord>,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        runs.insert(run.to_string(), record).is_none(),
        "two run directories share the manifest name {run}"
    );
    Ok(())
}

/// The expected weights of every model the catalogue names, by model name.
///
/// Read from `src-tauri/models/catalogue.json` — the same file the app's
/// downloader verifies an install against — so "these were x-asr's weights"
/// means the bytes the app would have installed, not whatever happened to be
/// in the directory `--model` named.
#[derive(Debug, Clone, Default)]
pub struct WeightCatalogue {
    /// model name → file name → SHA-256.
    pub models: BTreeMap<String, BTreeMap<String, String>>,
}

/// The catalogue this build was compiled with.
///
/// Built in rather than read from the checkout at run time, so the bytes a
/// gate accepts as a model's weights are fixed by the build — the same one the
/// result's revision names — and cannot change with the directory the binary
/// happens to be run from.
const SHIPPED_CATALOGUE: &str = include_str!("../../../src-tauri/models/catalogue.json");

impl WeightCatalogue {
    pub fn shipped() -> anyhow::Result<Self> {
        Self::from_json(SHIPPED_CATALOGUE)
    }

    pub fn from_json(text: &str) -> anyhow::Result<Self> {
        #[derive(Deserialize)]
        struct File {
            name: String,
            sha256: String,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Model {
            model_name: String,
            files: Vec<File>,
        }
        #[derive(Deserialize)]
        struct Catalogue {
            models: Vec<Model>,
        }
        let catalogue: Catalogue = serde_json::from_str(text)?;
        Ok(WeightCatalogue {
            models: catalogue
                .models
                .into_iter()
                .map(|m| {
                    let files = m.files.into_iter().map(|f| (f.name, f.sha256.to_ascii_lowercase())).collect();
                    (m.model_name, files)
                })
                .collect(),
        })
    }

    /// `None` when `weights` are files the catalogue lists for `model`, each
    /// with the catalogued digest, each once, and covering every graph and the
    /// token table; otherwise why not.
    ///
    /// Coverage is the catalogue's `.onnx` files and `tokens.txt`, not every
    /// file it lists: an install also carries `bpe.model`, which the loader
    /// never reads (see `cc_stt::local::ModelFiles::bpe_vocab`). Without the
    /// coverage rule a record holding only the genuine token table would vouch
    /// for an encoder nobody checked.
    pub fn mismatch(&self, model: &str, weights: &[WeightFile]) -> Option<String> {
        let Some(expected) = self.models.get(model) else {
            return Some(format!("the model catalogue has no entry for {model}"));
        };
        let mut recorded = std::collections::BTreeSet::new();
        for w in weights {
            if !recorded.insert(w.name.as_str()) {
                return Some(format!("{} is recorded twice", w.name));
            }
        }
        if let Some(missing) = expected
            .keys()
            .find(|name| (name.ends_with(".onnx") || *name == "tokens.txt") && !recorded.contains(name.as_str()))
        {
            return Some(format!("no digest was recorded for {model}'s {missing}"));
        }
        for w in weights {
            match expected.get(&w.name) {
                None => return Some(format!("{} is not one of {model}'s files", w.name)),
                Some(sha) if *sha != w.sha256 => {
                    return Some(format!("{} is not {model}'s {} (digest differs)", w.name, w.name))
                }
                Some(_) => {}
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_run(dir: &Path, name: &str, events: &str) {
        std::fs::create_dir_all(dir).unwrap();
        let manifest = crate::suite::RunManifest {
            name: name.to_string(),
            script: "starter".into(),
            scenario: "exact".into(),
            engine: "gemini".into(),
            voice_index: 0,
            words: 1,
            audio_s: 1.0,
            atom_count: None,
        };
        std::fs::write(dir.join("manifest.json"), serde_json::to_string(&manifest).unwrap()).unwrap();
        std::fs::write(dir.join("gold.json"), "{}").unwrap();
        std::fs::write(dir.join("performance.txt"), "hello").unwrap();
        std::fs::write(dir.join("events.jsonl"), events).unwrap();
    }

    fn conditions() -> CaptureConditions {
        CaptureConditions {
            language: "en-US".into(),
            model: cc_stt::default_model().id.into(),
            weights: vec![WeightFile {
                name: "tokens.txt".into(),
                bytes: 3,
                sha256: "abc".into(),
            }],
            recogniser: cc_stt::LocalSttConfig::for_model(cc_stt::default_model(), "/models/x"),
            pace: 1.0,
        }
    }

    #[test]
    fn a_sealed_run_reads_back_as_its_own_record() {
        let root = tempfile::tempdir().unwrap();
        let run = root.path().join("starter__exact__gemini");
        write_run(&run, "starter__exact__gemini", "{}\n");
        let sealed = seal_capture(&run, &conditions()).unwrap();
        let read = read_capture(&run, "starter__exact__gemini").unwrap().unwrap();
        assert_eq!(sealed, read);
        assert_eq!(read.recogniser.blank_penalty, cc_stt::default_model().tuning.blank_penalty);
    }

    #[test]
    fn no_record_is_none_but_a_broken_one_is_an_error() {
        let root = tempfile::tempdir().unwrap();
        let run = root.path().join("r");
        write_run(&run, "r", "{}\n");
        assert!(read_capture(&run, "r").unwrap().is_none());
        std::fs::write(run.join(CAPTURE_FILE), "{ not json").unwrap();
        let err = read_capture(&run, "r").unwrap_err().to_string();
        assert!(err.contains("not a capture record"), "{err}");
    }

    /// The counterexample the digest exists for: a record copied between
    /// corpora, or left behind when a run's events were replaced.
    #[test]
    fn a_record_does_not_survive_its_fixtures_changing_or_moving() {
        let root = tempfile::tempdir().unwrap();
        let a = root.path().join("a");
        let b = root.path().join("b");
        write_run(&a, "a", "{}\n");
        write_run(&b, "b", "{}\n");
        seal_capture(&a, &conditions()).unwrap();

        // Copied to another run.
        std::fs::copy(a.join(CAPTURE_FILE), b.join(CAPTURE_FILE)).unwrap();
        let err = read_capture(&b, "b").unwrap_err().to_string();
        assert!(err.contains("copied here"), "{err}");

        // Same run, different events.
        std::fs::write(a.join("events.jsonl"), "{\"other\":1}\n").unwrap();
        let err = read_capture(&a, "a").unwrap_err().to_string();
        assert!(err.contains("different fixture files"), "{err}");
    }

    #[test]
    fn the_fixture_digest_separates_files() {
        let root = tempfile::tempdir().unwrap();
        let a = root.path().join("a");
        let b = root.path().join("b");
        write_run(&a, "same", "ab");
        write_run(&b, "same", "ab");
        assert_eq!(fixture_digest(&a).unwrap(), fixture_digest(&b).unwrap());
        // Moving one byte from performance.txt into events.jsonl keeps the
        // concatenation identical; the digest must still differ.
        std::fs::write(b.join("events.jsonl"), "abh").unwrap();
        std::fs::write(b.join("performance.txt"), "ello").unwrap();
        assert_ne!(fixture_digest(&a).unwrap(), fixture_digest(&b).unwrap());
    }

    /// The interleaving staging exists for: two captures of one run, the
    /// second to finish must not replace or mix into the first.
    #[test]
    fn a_published_run_is_never_replaced() {
        let root = tempfile::tempdir().unwrap();
        let corpus = root.path().join("runs");
        std::fs::create_dir_all(&corpus).unwrap();
        let first = root.path().join("stage-a").join("r");
        let second = root.path().join("stage-b").join("r");
        write_run(&first, "r", "first\n");
        write_run(&second, "r", "second\n");
        seal_capture(&first, &conditions()).unwrap();
        let mut other = conditions();
        other.weights[0].sha256 = "def".into();
        seal_capture(&second, &other).unwrap();

        let out = corpus.join("r");
        assert!(publish_run(&first, &out).unwrap());
        assert!(!publish_run(&second, &out).unwrap());
        let published = read_capture(&out, "r").unwrap().unwrap();
        assert_eq!(published.weights[0].sha256, "abc");
        assert_eq!(std::fs::read_to_string(out.join("events.jsonl")).unwrap(), "first\n");
    }

    #[test]
    fn staging_is_beside_the_corpus_not_in_it() {
        let root = tempfile::tempdir().unwrap();
        let corpus = root.path().join("runs-fr");
        std::fs::create_dir_all(&corpus).unwrap();
        let a = staging_root(&corpus).unwrap();
        let b = staging_root(&corpus).unwrap();
        assert_ne!(a, b, "two sessions never share a staging directory");
        let parent = std::fs::canonicalize(root.path()).unwrap();
        for dir in [&a, &b] {
            assert!(dir.is_dir());
            assert_eq!(dir.parent(), Some(parent.as_path()));
            assert!(dir.file_name().unwrap().to_string_lossy().starts_with(".runs-fr.capturing-"));
        }
        // `--runs .` names the corpus by a path with no file name of its own.
        let dotted = staging_root(&corpus.join(".")).unwrap();
        assert_eq!(dotted.parent(), Some(parent.as_path()));
    }

    #[test]
    fn a_run_named_twice_is_refused() {
        let mut runs = BTreeMap::new();
        insert_run(&mut runs, "r", None).unwrap();
        assert!(insert_run(&mut runs, "r", None).is_err());
    }

    #[test]
    fn the_shipped_catalogue_parses_and_names_the_default_model() {
        let catalogue = WeightCatalogue::shipped().unwrap();
        let files = catalogue
            .models
            .get(cc_stt::default_model().id)
            .expect("the catalogue's modelName is the BundledModel id");
        assert!(files.contains_key("tokens.txt"));
    }

    #[test]
    fn weights_must_be_the_catalogued_bytes() {
        let mut catalogue = WeightCatalogue::default();
        catalogue.models.insert(
            "m".into(),
            [("tokens.txt".to_string(), "abc".to_string())].into_iter().collect(),
        );
        let w = |name: &str, sha: &str| WeightFile {
            name: name.into(),
            bytes: 1,
            sha256: sha.into(),
        };
        assert_eq!(catalogue.mismatch("m", &[w("tokens.txt", "abc")]), None);
        assert!(catalogue.mismatch("m", &[w("tokens.txt", "abd")]).is_some());
        assert!(catalogue.mismatch("m", &[w("encoder.onnx", "abc")]).is_some());
        assert!(catalogue.mismatch("other", &[w("tokens.txt", "abc")]).is_some());
        assert!(catalogue.mismatch("m", &[]).is_some());
        assert!(catalogue
            .mismatch("m", &[w("tokens.txt", "abc"), w("tokens.txt", "abc")])
            .unwrap()
            .contains("twice"));
    }

    /// The shipped model's genuine token table alone vouches for nothing.
    #[test]
    fn every_graph_must_be_accounted_for() {
        let catalogue = WeightCatalogue::shipped().unwrap();
        let model = cc_stt::default_model().id;
        let files = catalogue.models[model].clone();
        let all: Vec<WeightFile> = files
            .iter()
            .filter(|(name, _)| name.ends_with(".onnx") || *name == "tokens.txt")
            .map(|(name, sha)| WeightFile {
                name: name.clone(),
                bytes: 1,
                sha256: sha.clone(),
            })
            .collect();
        assert_eq!(all.len(), 4, "three graphs and the token table");
        assert_eq!(catalogue.mismatch(model, &all), None);
        let tokens_only: Vec<WeightFile> =
            all.iter().filter(|w| w.name == "tokens.txt").cloned().collect();
        let why = catalogue.mismatch(model, &tokens_only).unwrap();
        assert!(why.contains("no digest was recorded"), "{why}");
    }

    #[test]
    fn language_tags_are_checked_for_shape() {
        for good in ["en", "EN", "en-US", "en-GB", "zh-Hans", "fil", "es-419"] {
            assert!(is_language_tag(good), "{good}");
        }
        for bad in ["", "e", "en-", "-en", "english", "en--US", "e1", "en-toolongsubtag"] {
            assert!(!is_language_tag(bad), "{bad}");
        }
    }

    #[test]
    fn a_clean_commit_is_reproducible_and_nothing_else_is() {
        let r = |commit: Option<&str>, dirty| Revision {
            commit: commit.map(str::to_string),
            dirty,
        };
        assert!(r(Some("abc"), false).is_reproducible());
        assert!(!r(Some("abc"), true).is_reproducible());
        assert!(!r(Some(""), false).is_reproducible());
        assert!(!r(None, false).is_reproducible());
    }

    #[test]
    fn primary_subtags_compare_case_and_region_free() {
        assert_eq!(primary_subtag("en-US"), "en");
        assert_eq!(primary_subtag(" FR "), "fr");
        assert_eq!(primary_subtag("zh_Hans"), "zh");
    }
}
