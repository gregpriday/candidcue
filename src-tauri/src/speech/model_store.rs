//! Where a downloaded speech model lives, and whether it can be trusted.
//!
//! ---------------------------------------------------------------------------
//! WHY THE MODEL IS NOT IN THE INSTALLER ANY MORE
//! ---------------------------------------------------------------------------
//! It was ~161 MB of ONNX graphs inside every build (§152). Every download of
//! the app, every update, and every CI artefact carried the whole recogniser
//! whether or not the machine already had it — and the archive it comes from is
//! already pinned by SHA-256 in a catalogue the binary compiles in, so shipping
//! the bytes bought integrity nothing.
//!
//! `tauri.conf.json` now bundles no models at all. This module is what fills
//! that gap: it owns `$APPDATA/models/`, decides whether what is on disk is
//! usable, and is the only thing that answers "where is the model".
//!
//! ---------------------------------------------------------------------------
//! THE SEAL, AND WHY EXISTENCE IS NOT ENOUGH
//! ---------------------------------------------------------------------------
//! A model directory is preferred only when it carries `.candidcue-model.json`
//! naming the archive digest this build's catalogue expects. Nothing else
//! counts — not "the files are there", not "the rename succeeded".
//!
//! That is not belt-and-braces. The install sequence writes real files into
//! their real home and only afterwards can prove the result is whole, so there
//! is a window in which a complete-looking directory is not yet known to be.
//! A crash inside that window leaves exactly the thing a presence check would
//! accept and a take would then fail on: `OnlineRecognizer::create` answers a
//! MISSING file with a null pointer and no reason at all, and a half-written
//! GRAPH with no answer whatever — onnxruntime throws, and the process aborts.
//! The seal is written last, after [`verify_contents`] has passed against the
//! final path, so its presence means "this was proven here", and an unsealed
//! directory is treated as absent and re-downloaded.
//!
//! ---------------------------------------------------------------------------
//! A SEAL IS NOT A GUARANTEE FOR EVER
//! ---------------------------------------------------------------------------
//! The seal records what was true at install. Disks fail, `~/Library` gets
//! half-restored, cleanup tools truncate things, and none of that touches the
//! seal. So a sealed directory is checked again every time it is judged —
//! cheaply, by length and by graph envelope, never by hash — and one that no
//! longer matches is reported as DAMAGED rather than installed (#258). Before
//! that it read as "Downloaded" in Settings, offered no Download button, and
//! took the app down at the start of every take.
//!
//! The seal also carries the archive digest, so a catalogue that moves to a new
//! model version does not silently keep serving the old weights: the seal stops
//! matching, the directory stops being preferred, and the user is offered the
//! download that the new catalogue describes.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::catalogue::{ModelEntry, ATTRIBUTION_FILE};

/// Serialises every test that reads or writes `CANDIDCUE_MODELS_DIR`.
///
/// At module scope rather than inside `mod tests` because `model_download`'s
/// tests call `resolve` too, and a lock private to this file's test module
/// would leave them racing the one test that sets the override — which is the
/// bug it was added to fix, one module over.
#[cfg(test)]
pub(crate) static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// A poisoned lock still serialises. A panicking test must not cascade into
/// every other test that resolves reporting the same failure.
#[cfg(test)]
pub(crate) fn env_guard() -> std::sync::MutexGuard<'static, ()> {
    ENV_LOCK.lock().unwrap_or_else(|err| err.into_inner())
}

/// Marks a model directory as installed AND proven loadable.
pub const SEAL_FILE: &str = ".candidcue-model.json";

/// Bumped when the seal's shape changes. An unreadable or older seal is not an
/// error — it is simply not a seal, so the directory is re-installed.
const SEAL_VERSION: u32 = 1;

/// Prefix for a staging directory, which is a sibling of the final one so the
/// rename that installs it is same-filesystem and therefore atomic.
///
/// A leading dot keeps it out of the way of anything listing installed models,
/// and `every_entry_is_well_formed` refuses a catalogue `installDir` that
/// starts with one, so a staging directory can never collide with a real model.
pub const STAGING_PREFIX: &str = ".staging-";

/// Prefix for a model held aside while its replacement is proven.
///
/// Also a sibling of the final directory, for the same reason: the commit and
/// the rollback are both renames, and a rename only has the atomicity this
/// design depends on within one filesystem.
pub const BACKUP_PREFIX: &str = ".backup-";

/// Where partial archives and their resume metadata live, under the models
/// root. One directory rather than beside each model: a partial download is
/// not an installed model and should not look like one.
pub const DOWNLOADS_DIR: &str = ".downloads";

/// What a sealed model directory says about itself.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallSeal {
    pub seal_version: u32,
    /// Catalogue id, so a directory renamed by hand is not mistaken for
    /// another model.
    pub model_id: String,
    /// The archive digest these files were extracted from and verified against.
    pub archive_sha256: String,
}

impl InstallSeal {
    /// Does this seal describe the model the compiled catalogue now wants?
    fn matches(&self, model: &ModelEntry) -> bool {
        self.seal_version == SEAL_VERSION
            && self.model_id == model.id
            && self.archive_sha256 == model.archive.sha256
    }
}

/// Where an installed model was found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelSource {
    /// `$APPDATA/models/<installDir>` — downloaded by this app.
    Downloaded,
    /// A Tauri resource. Stock builds ship none; a custom build may.
    Bundled,
    /// `CANDIDCUE_MODELS_DIR`, a development override.
    Override,
}

/// A model directory that is present, sealed where a seal is required, and
/// whose contents `ModelFiles::detect` understands.
#[derive(Debug, Clone)]
pub struct ResolvedModel {
    pub dir: PathBuf,
    pub source: ModelSource,
}

/// The models root under app data: `$APPDATA/models`.
pub fn models_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("models")
}

/// Read a directory's seal, if it has a valid one for this model.
pub fn read_seal(dir: &Path, model: &ModelEntry) -> Option<InstallSeal> {
    let raw = std::fs::read_to_string(dir.join(SEAL_FILE)).ok()?;
    let seal: InstallSeal = serde_json::from_str(&raw).ok()?;
    seal.matches(model).then_some(seal)
}

/// Write the seal, last, once the model has been proven loadable in place.
///
/// Through a temporary sibling and a rename, so a torn write leaves no seal
/// rather than half a one — the failure mode that would make an unproven
/// directory look proven.
pub fn write_seal(dir: &Path, model: &ModelEntry) -> std::io::Result<()> {
    let seal = InstallSeal {
        seal_version: SEAL_VERSION,
        model_id: model.id.clone(),
        archive_sha256: model.archive.sha256.clone(),
    };
    let body = serde_json::to_vec_pretty(&seal)
        .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))?;
    let temp = dir.join(format!("{SEAL_FILE}.part"));
    std::fs::write(&temp, &body)?;
    crate::util::rename(&temp, dir.join(SEAL_FILE))
}

/// What a candidate model directory turned out to be.
#[derive(Debug)]
enum Inspection {
    /// Present, sealed where a seal is required, and whole.
    Usable,
    /// Not an installation of this model at all: absent, unsealed, sealed for
    /// another catalogue entry, or an unsealed directory that does not check
    /// out. The ordinary state of a machine that has not downloaded it.
    Absent,
    /// Sealed — so this app installed it and proved it — and no longer what
    /// was installed. The one state the user did not cause and cannot see
    /// without being told, carried with what was found for the log.
    Damaged(String),
}

/// Judge one candidate directory.
///
/// A SEALED directory is held to the catalogue: the seal pins the archive
/// digest and the install extracted exactly the catalogued members, so every
/// one of them must still be there at its catalogued length — see
/// [`verify_contents`]. Anything less is damage that happened after the
/// install, and is reported as such rather than as "not installed".
///
/// An unsealed one — the developer override, a bundled resource — gets the
/// structural half only. It may legitimately be a variant the catalogue does
/// not describe, so there are no lengths to hold it to; but its graphs are
/// still walked, because a damaged one would take the process down at the
/// next load whatever its provenance. It is skipped rather than reported:
/// Download is not its remedy.
fn inspect(dir: &Path, model: &ModelEntry, require_seal: bool) -> Inspection {
    if require_seal {
        if read_seal(dir, model).is_none() {
            return Inspection::Absent;
        }
        return match verify_contents(dir, model) {
            Ok(()) => Inspection::Usable,
            Err(detail) => Inspection::Damaged(detail),
        };
    }
    let Ok(files) = cc_stt::local::ModelFiles::detect(dir) else {
        return Inspection::Absent;
    };
    match files.check_graphs(dir) {
        Ok(()) => Inspection::Usable,
        Err(detail) => {
            tracing::warn!(
                dir = %dir.display(),
                detail = %detail,
                "skipping an unsealed speech model whose graphs are damaged"
            );
            Inspection::Absent
        }
    }
}

/// Are the files in `dir` still the ones this catalogue entry describes?
///
/// Three questions, cheapest first, and none of them a hash:
///
///   * the names — `ModelFiles::detect`, asked rather than a list of filenames
///     because upstream is not consistent about naming and detection is what
///     the loader itself will do;
///   * the lengths — every catalogued file at exactly its catalogued size,
///     which catches a truncation of ANY member, the token table included,
///     for the price of a `stat`;
///   * the graphs — each one the loader will pick walked as an ONNX envelope,
///     which catches what a length cannot: the right number of wrong bytes.
///
/// The full SHA-256 was checked once, at install. Repeating it here would put
/// ~170 MB of hashing in front of every take and every status read (#257), and
/// what it would add over these three — damage inside a graph that leaves its
/// envelope intact — is spelled out in `cc_stt::local::check_onnx_envelope`.
///
/// Also what the install itself proves before it writes the seal, so a model
/// that installs is a model this function accepts. Holding the two to
/// different standards would be a model that downloads cleanly and then
/// reads as damaged for ever.
pub fn verify_contents(dir: &Path, model: &ModelEntry) -> Result<(), String> {
    let files = cc_stt::local::ModelFiles::detect(dir)?;
    for file in &model.files {
        let len = std::fs::metadata(dir.join(&file.name))
            .map_err(|err| format!("{} cannot be read: {err}", file.name))?
            .len();
        if len != file.bytes {
            return Err(format!(
                "{} is {len} bytes where this model's is {}",
                file.name, file.bytes
            ));
        }
    }
    files.check_graphs(dir)
}

/// Is this directory a usable installation of this model?
fn is_usable(dir: &Path, model: &ModelEntry, require_seal: bool) -> bool {
    matches!(inspect(dir, model, require_seal), Inspection::Usable)
}

/// Why this model's download is sealed and yet unusable, if it is.
///
/// [`resolve`] answers one question — is there a copy a take can run on — and
/// falls through a broken download on purpose. This is the other half, for the
/// screens that must then say WHY there is not one. Before it existed a
/// damaged download was indistinguishable from a model that was never
/// fetched, except that the files were there and the next load aborted.
///
/// `None` for a download that is merely absent, unsealed or superseded: those
/// are "not installed", which is the ordinary state and needs no explaining.
pub fn damaged_download(app_data_dir: &Path, model: &ModelEntry) -> Option<String> {
    match inspect(
        &model.install_path(&models_root(app_data_dir)),
        model,
        true,
    ) {
        Inspection::Damaged(detail) => Some(detail),
        Inspection::Usable | Inspection::Absent => None,
    }
}

/// The development override, if one is set and usable.
///
/// `CANDIDCUE_MODELS_DIR` is the same variable `scripts/fetch-stt-model.sh`
/// already honours, pointing at the same layout. It exists because emptying
/// `bundle.resources` also stopped `tauri dev` from seeing a model fetched into
/// the source tree — Tauri only stages resources a build declares — and a
/// contributor who has already run `pnpm models:fetch` should not have to
/// re-download through the UI to get a working dev build. Nothing sets it for
/// you: `models:fetch` fills the source tree but does not export anything, so
/// without this variable a dev build takes the same in-app download a user
/// does. The README's "Running it" section carries the line to export.
///
/// NOT sealed, deliberately: the files it points at were put there by the fetch
/// script, which verified every one of them against the same catalogue. It is
/// still shape-checked and its graphs walked, so a stale, half-extracted or
/// damaged directory is skipped rather than loaded.
fn override_dir(model: &ModelEntry) -> Option<PathBuf> {
    let root = std::env::var_os("CANDIDCUE_MODELS_DIR")?;
    let dir = model.install_path(Path::new(&root));
    is_usable(&dir, model, false).then_some(dir)
}

/// Find this model, preferring what this machine downloaded.
///
/// Order is deliberate:
///   1. `CANDIDCUE_MODELS_DIR` — a developer saying explicitly where to look.
///   2. The download in app data, sealed. What a user's machine actually has.
///   3. A bundled resource, if this build shipped one. Stock builds do not.
///
/// A downloaded directory that fails its checks does NOT shadow a bundled
/// fallback. Falling through is the whole point: "there is something broken in
/// app data" is not a reason to refuse a model that works.
pub fn resolve(
    app_data_dir: &Path,
    resource_dir: Option<&Path>,
    model: &ModelEntry,
) -> Option<ResolvedModel> {
    if let Some(dir) = override_dir(model) {
        tracing::info!(
            model = %model.id,
            dir = %dir.display(),
            "using CANDIDCUE_MODELS_DIR override for the speech model"
        );
        return Some(ResolvedModel {
            dir,
            source: ModelSource::Override,
        });
    }
    let downloaded = model.install_path(&models_root(app_data_dir));
    if is_usable(&downloaded, model, true) {
        return Some(ResolvedModel {
            dir: downloaded,
            source: ModelSource::Downloaded,
        });
    }
    if let Some(dir) = resource_dir {
        if is_usable(dir, model, false) {
            return Some(ResolvedModel {
                dir: dir.to_path_buf(),
                source: ModelSource::Bundled,
            });
        }
    }
    None
}

/// Remove this model's download from app data.
///
/// Only ever app data. A bundled resource is inside the application bundle and
/// is not ours to delete; after this returns, `resolve` may well find one and
/// report the model as still present from a different source, which is the
/// honest answer rather than a bug.
///
/// The partial archive goes too. Leaving it would mean "delete" freed a
/// fraction of what the user expected and a later download silently resumed
/// something they thought they had thrown away.
pub fn delete_downloaded(app_data_dir: &Path, model: &ModelEntry) -> std::io::Result<()> {
    let root = models_root(app_data_dir);
    remove_dir_if_present(&model.install_path(&root))?;
    let downloads = root.join(DOWNLOADS_DIR);
    for name in [archive_part_name(model), resume_name(model)] {
        match std::fs::remove_file(downloads.join(name)) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(err),
        }
    }
    Ok(())
}

/// `remove_dir_all`, treating "it was not there" as success.
///
/// The install path used to call this immediately before renaming a staged
/// directory into place. It no longer does: a replacement moves the old model
/// aside to [`backup_path`] instead of deleting it, so that remove-then-rename
/// window is gone and there is no install-site caller to find.
///
/// [`delete_downloaded`] is the one caller left, and there "it was not there"
/// is exactly the state the user asked for rather than an error: the model may
/// be absent because an earlier delete succeeded, because an install never got
/// as far as committing, or because the only copy was ever a bundled one this
/// function is not allowed to touch.
pub fn remove_dir_if_present(dir: &Path) -> std::io::Result<()> {
    match std::fs::remove_dir_all(dir) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

/// Where a model being replaced is held until its replacement is proven.
///
/// A sibling of the final directory, so moving it there and back is a rename
/// rather than a copy. Deterministic per model rather than random, so a crash
/// mid-commit leaves exactly one place [`recover_backup`] has to look.
pub fn backup_path(root: &Path, model: &ModelEntry) -> PathBuf {
    root.join(format!("{BACKUP_PREFIX}{}", model.install_dir))
}

/// Put back a model whose replacement was interrupted mid-commit.
///
/// The install commit moves the old model aside, renames the new one into
/// place, proves it, then deletes the backup. Two crash windows are visible
/// from outside, and both end here:
///
///   * between the two renames — no model at all, and a full backup;
///   * between the second rename and the seal — a model that LOOKS complete
///     at `target` but was never proven, beside the backup that was.
///
/// The second is why "is the target absent?" is not the right question. An
/// unsealed target is exactly the thing the seal exists to distrust, and
/// preferring it over a proven backup would throw away the working model to
/// keep an unproven one.
///
/// It never touches a target that is sealed AND whole, so it cannot disturb a
/// finished install — including one another instance has just completed. A
/// sealed target that has since been damaged is a different thing: keeping it
/// over a proven backup would keep the copy that aborts the app.
pub fn recover_backup(root: &Path, model: &ModelEntry) -> std::io::Result<bool> {
    let backup = backup_path(root, model);
    let target = model.install_path(root);
    if !backup.is_dir() {
        return Ok(false);
    }
    // A sealed, whole target is a completed install. Nothing to recover.
    if is_usable(&target, model, true) {
        return Ok(false);
    }
    // Only a backup that is itself usable is worth restoring; otherwise the
    // honest answer is that neither copy is good and the model re-downloads.
    if !is_usable(&backup, model, true) {
        return Ok(false);
    }
    if target.exists() {
        std::fs::remove_dir_all(&target)?;
    }
    crate::util::rename(&backup, &target)?;
    tracing::warn!(
        model = %model.id,
        "restored a speech model whose replacement was interrupted"
    );
    Ok(true)
}

/// Recover every model interrupted mid-replacement. Called at startup.
pub fn recover_interrupted(app_data_dir: &Path) {
    let root = models_root(app_data_dir);
    if !root.is_dir() {
        return;
    }
    for model in &super::catalogue::catalogue().models {
        if let Err(err) = recover_backup(&root, model) {
            // Loud rather than best-effort: a backup that could not be
            // restored is a working model the user cannot reach, and the next
            // install is under instruction not to delete it.
            tracing::error!(
                model = %model.id,
                error = %err,
                "could not restore an interrupted speech model backup"
            );
        }
    }
}

/// Delete staging and backup directories left by a run that did not finish,
/// for ONE model.
///
/// Scoped to a single model, and called only from that model's own install
/// rather than at startup. A startup-wide sweep looked tidier and was a way to
/// destroy work: a second instance launching while the first was mid-install
/// would delete the live staging directory out from under it, and the commit
/// that followed would fail with the old model already moved aside.
///
/// Extraction is never resumed — only downloads are — so a staging directory
/// belonging to THIS model at the moment we are about to install it is always
/// garbage. A backup at that moment is garbage too: [`recover_backup`] has
/// already had its chance to put it back.
pub fn clear_stale(app_data_dir: &Path, model: &ModelEntry) -> std::io::Result<()> {
    let root = models_root(app_data_dir);
    let entries = match std::fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err),
    };
    // A backup is only garbage once the model it was protecting is actually
    // installed, sealed and whole. Deleting it on the strength of "we are
    // about to install anyway" throws away the user's working model to make
    // room for one that has not been downloaded yet, and if the download then
    // fails they have neither. A seal alone is not enough for the same reason:
    // a damaged target beside a good backup is a backup worth keeping.
    let target_is_installed = is_usable(&model.install_path(&root), model, true);
    let staging = format!("{STAGING_PREFIX}{}-", model.install_dir);
    let backup = format!("{BACKUP_PREFIX}{}", model.install_dir);
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let stale = name.starts_with(&staging) || (*name == *backup && target_is_installed);
        if stale {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
    Ok(())
}

/// The partial archive's filename. Keyed by model id, not archive name, so a
/// catalogue that renames an archive does not orphan the old partial.
pub fn archive_part_name(model: &ModelEntry) -> String {
    format!("{}.archive.part", model.id)
}

/// The resume sidecar's filename.
pub fn resume_name(model: &ModelEntry) -> String {
    format!("{}.resume.json", model.id)
}

/// Write the licence notice AND the licence text beside the weights.
///
/// Into staging, before the install rename, so a model directory is never
/// visible without the notice its licence requires to travel with it.
///
/// ## Why the full text, and not only the URL
///
/// `ATTRIBUTION.md` has always said "a distributed build must include that
/// text" and then linked to apache.org — a notice that states its own
/// obligation and does not meet it. Apache-2.0 §4(a) requires a COPY of the
/// licence to travel with the work, and a URL is not a copy: the user who has
/// the weights on a machine with no network has the thing the licence governs
/// and not the licence.
///
/// So the text is committed under `legal/licenses/` and written out here.
/// `licence_text` returning `None` is a refusal rather than a silent skip —
/// see `every_catalogued_licence_has_committed_text`, which makes adding a
/// model under a licence nobody committed a failing test rather than a
/// distribution nobody can defend.
pub fn write_attribution(dir: &Path, model: &ModelEntry) -> std::io::Result<()> {
    std::fs::write(
        dir.join(ATTRIBUTION_FILE),
        super::catalogue::render_attribution(model),
    )?;
    let id = &model.attribution.license.id;
    let Some(text) = super::catalogue::licence_text(id) else {
        return Err(std::io::Error::other(format!(
            "no committed licence text for {id}; add legal/licenses/{id}.txt"
        )));
    };
    std::fs::write(dir.join(super::catalogue::licence_file_name(id)), text)
}

/// Model files this module will accept, for the tests here and in
/// `model_download`, which judge directories through [`resolve`] too.
#[cfg(test)]
pub(crate) mod fixtures {
    use std::io::{Seek as _, SeekFrom, Write as _};
    use std::path::Path;

    use crate::speech::catalogue::ModelEntry;

    /// `opset_import { version: 13 }`, the field that closes every graph here.
    const OPSET: [u8; 4] = [0x42, 0x02, 0x10, 0x0d];

    fn varint(mut value: u64) -> Vec<u8> {
        let mut out = Vec::new();
        loop {
            let byte = (value & 0x7f) as u8;
            value >>= 7;
            if value == 0 {
                out.push(byte);
                return out;
            }
            out.push(byte | 0x80);
        }
    }

    /// `ir_version: 7`, then the graph's tag and the length that makes the
    /// whole file exactly `len` bytes once the opset is appended.
    fn header(len: u64) -> Vec<u8> {
        for width in 1..=10u64 {
            let Some(payload) = len.checked_sub(3 + width + OPSET.len() as u64) else {
                break;
            };
            let encoded = varint(payload);
            if encoded.len() as u64 == width {
                return [vec![0x08, 0x07, 0x3a], encoded].concat();
            }
        }
        panic!("no ONNX envelope is exactly {len} bytes");
    }

    /// A whole ONNX envelope of exactly `len` bytes, with `marker` at the start
    /// of its graph so a test can tell one copy from another.
    pub(crate) fn graph_bytes(len: u64, marker: &[u8]) -> Vec<u8> {
        let mut bytes = header(len);
        bytes.extend_from_slice(marker);
        assert!(bytes.len() + OPSET.len() <= len as usize, "{len} bytes cannot hold the marker");
        bytes.resize(len as usize - OPSET.len(), 0);
        bytes.extend_from_slice(&OPSET);
        bytes
    }

    /// [`graph_bytes`], written as a SPARSE file.
    ///
    /// The graph payload between the marker and the opset is a hole, so a
    /// catalogue-length 155 MB encoder costs a few bytes of disk. The envelope
    /// walk seeks past payloads, so a hole is exactly what it would see in a
    /// real graph.
    pub(crate) fn write_graph(path: &Path, len: u64, marker: &[u8]) {
        let mut file = std::fs::File::create(path).unwrap();
        file.write_all(&header(len)).unwrap();
        file.write_all(marker).unwrap();
        file.seek(SeekFrom::Start(len - OPSET.len() as u64)).unwrap();
        file.write_all(&OPSET).unwrap();
    }

    /// A file of exactly `len` bytes that starts with `head`.
    pub(crate) fn write_padded(path: &Path, len: u64, head: &[u8]) {
        let mut file = std::fs::File::create(path).unwrap();
        file.write_all(head).unwrap();
        file.set_len(len).unwrap();
    }

    /// The length the catalogue gives `name`, if it lists it.
    pub(crate) fn catalogued_len(model: &ModelEntry, name: &str) -> Option<u64> {
        model.files.iter().find(|file| file.name == name).map(|file| file.bytes)
    }

    /// A directory that passes every check [`super::resolve`] makes for
    /// `model`, with `marker` in each graph.
    ///
    /// Every catalogued file at its catalogued length, and every graph role
    /// present whether or not the catalogue lists it, so the directory detects
    /// even under a fixture catalogue that is deliberately short a file.
    pub(crate) fn write_model(dir: &Path, model: &ModelEntry, marker: &[u8]) {
        std::fs::create_dir_all(dir).unwrap();
        for name in ["encoder.int8.onnx", "decoder.onnx", "joiner.int8.onnx"] {
            let len = catalogued_len(model, name).unwrap_or(64);
            write_graph(&dir.join(name), len, marker);
        }
        for file in &model.files {
            if !file.name.ends_with(".onnx") {
                write_padded(&dir.join(&file.name), file.bytes, b"<blk> 0\n");
            }
        }
        if catalogued_len(model, cc_stt::local::TOKENS_FILE).is_none() {
            write_padded(&dir.join(cc_stt::local::TOKENS_FILE), 8, b"<blk> 0\n");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::{catalogued_len, write_graph, write_model};
    use super::*;
    use crate::speech::catalogue;

    /// Sets `CANDIDCUE_MODELS_DIR` and puts back whatever was there before.
    ///
    /// Restoring on DROP rather than at the end of the test body: a panic
    /// between set and unset would otherwise leave the variable set for the
    /// rest of the process, and the next test to resolve would silently pick
    /// up a temp directory that no longer exists. It also preserves a value a
    /// developer had exported before running the suite.
    struct EnvOverride {
        previous: Option<std::ffi::OsString>,
    }

    impl EnvOverride {
        fn set(value: &Path) -> Self {
            let previous = std::env::var_os("CANDIDCUE_MODELS_DIR");
            std::env::set_var("CANDIDCUE_MODELS_DIR", value);
            Self { previous }
        }
    }

    impl Drop for EnvOverride {
        fn drop(&mut self) {
            match self.previous.take() {
                Some(value) => std::env::set_var("CANDIDCUE_MODELS_DIR", value),
                None => std::env::remove_var("CANDIDCUE_MODELS_DIR"),
            }
        }
    }

    /// A whole copy of the shipping model, as far as every check can tell:
    /// the real catalogue's names and lengths, and real graph envelopes.
    fn write_detectable_model(dir: &Path) {
        write_model(dir, catalogue::default_model(), b"graph");
    }

    /// A sealed download of the shipping model, in the given temp app-data dir.
    fn sealed_download(app_data: &Path) -> PathBuf {
        let model = catalogue::default_model();
        let dir = model.install_path(&models_root(app_data));
        write_detectable_model(&dir);
        write_seal(&dir, model).unwrap();
        dir
    }

    #[test]
    fn a_sealed_and_detectable_download_resolves() {
        let _env = env_guard();
        let temp = tempfile::tempdir().unwrap();
        let model = catalogue::default_model();
        let dir = model.install_path(&models_root(temp.path()));
        write_detectable_model(&dir);
        write_seal(&dir, model).unwrap();

        let resolved = resolve(temp.path(), None, model).expect("a sealed model must resolve");
        assert_eq!(resolved.source, ModelSource::Downloaded);
        assert_eq!(resolved.dir, dir);
    }

    /// The window this seal exists for: files in place, load never proven.
    #[test]
    fn an_unsealed_download_is_not_used() {
        let _env = env_guard();
        let temp = tempfile::tempdir().unwrap();
        let model = catalogue::default_model();
        write_detectable_model(&model.install_path(&models_root(temp.path())));

        assert!(
            resolve(temp.path(), None, model).is_none(),
            "a directory that was never proven loadable must not be preferred"
        );
    }

    /// A seal from the catalogue entry this build no longer describes.
    #[test]
    fn a_seal_for_a_different_archive_is_not_honoured() {
        let _env = env_guard();
        let temp = tempfile::tempdir().unwrap();
        let model = catalogue::default_model();
        let dir = model.install_path(&models_root(temp.path()));
        write_detectable_model(&dir);
        let stale = InstallSeal {
            seal_version: SEAL_VERSION,
            model_id: model.id.clone(),
            archive_sha256: "0".repeat(64),
        };
        std::fs::write(
            dir.join(SEAL_FILE),
            serde_json::to_vec(&stale).unwrap(),
        )
        .unwrap();

        assert!(
            resolve(temp.path(), None, model).is_none(),
            "a model superseded by a catalogue change must not keep serving"
        );
    }

    /// A broken download must not hide a working bundled model.
    #[test]
    fn a_broken_download_falls_through_to_the_bundled_resource() {
        let _env = env_guard();
        let temp = tempfile::tempdir().unwrap();
        let model = catalogue::default_model();
        // Present but unsealed, and missing a joiner: broken twice over.
        let downloaded = model.install_path(&models_root(temp.path()));
        std::fs::create_dir_all(&downloaded).unwrap();
        std::fs::write(downloaded.join("encoder.int8.onnx"), b"graph").unwrap();

        let resource = temp.path().join("resources").join("models/x-asr-480ms");
        write_detectable_model(&resource);

        let resolved = resolve(temp.path(), Some(&resource), model)
            .expect("the bundled model must still be found");
        assert_eq!(resolved.source, ModelSource::Bundled);
    }

    /// The truncated encoder from #258: sealed, named right, cut short.
    ///
    /// It used to resolve — the seal and the names were all `is_usable` looked
    /// at — and the next load aborted the process.
    #[test]
    fn a_sealed_download_cut_short_is_damaged_rather_than_installed() {
        let _env = env_guard();
        let temp = tempfile::tempdir().unwrap();
        let model = catalogue::default_model();
        let dir = sealed_download(temp.path());
        let encoder = std::fs::OpenOptions::new()
            .write(true)
            .open(dir.join("encoder.int8.onnx"))
            .unwrap();
        encoder.set_len(50 * 1024 * 1024).unwrap();

        assert!(resolve(temp.path(), None, model).is_none());
        let detail = damaged_download(temp.path(), model).expect("the damage must be reported");
        assert!(detail.contains("encoder.int8.onnx"), "{detail}");
    }

    /// The other #258 case: every length right, one graph's bytes wrong. Only
    /// the envelope walk can see it.
    #[test]
    fn a_sealed_download_with_the_right_number_of_wrong_bytes_is_damaged() {
        let _env = env_guard();
        let temp = tempfile::tempdir().unwrap();
        let model = catalogue::default_model();
        let dir = sealed_download(temp.path());
        let len = catalogued_len(model, "decoder.onnx").unwrap();
        super::fixtures::write_padded(&dir.join("decoder.onnx"), len, b"<!DOCTYPE html>");

        assert!(resolve(temp.path(), None, model).is_none());
        let detail = damaged_download(temp.path(), model).expect("the damage must be reported");
        assert!(detail.contains("decoder.onnx"), "{detail}");
        assert!(detail.contains("not a readable ONNX model"), "{detail}");
    }

    /// Damage is not only to graphs. A token table cut short or deleted out of
    /// a sealed directory is the same fault, and the length check is what
    /// sees the first.
    #[test]
    fn a_sealed_download_with_a_damaged_or_missing_token_table_is_damaged() {
        let _env = env_guard();
        let model = catalogue::default_model();

        let temp = tempfile::tempdir().unwrap();
        let dir = sealed_download(temp.path());
        std::fs::write(dir.join("tokens.txt"), b"<blk> 0\n").unwrap();
        let detail = damaged_download(temp.path(), model).expect("a short token table is damage");
        assert!(detail.contains("tokens.txt"), "{detail}");

        let temp = tempfile::tempdir().unwrap();
        let dir = sealed_download(temp.path());
        std::fs::remove_file(dir.join("tokens.txt")).unwrap();
        assert!(resolve(temp.path(), None, model).is_none());
        let detail = damaged_download(temp.path(), model).expect("a missing token table is damage");
        assert!(detail.contains("tokens.txt"), "{detail}");
    }

    /// "Damaged" is a claim about a model this app installed and proved. A
    /// download that is merely absent, unsealed or superseded is "not
    /// installed", and must not be described as broken.
    #[test]
    fn only_a_sealed_download_is_ever_called_damaged() {
        let _env = env_guard();
        let model = catalogue::default_model();

        let nothing = tempfile::tempdir().unwrap();
        assert!(damaged_download(nothing.path(), model).is_none());

        let unsealed = tempfile::tempdir().unwrap();
        let dir = model.install_path(&models_root(unsealed.path()));
        write_detectable_model(&dir);
        std::fs::write(dir.join("decoder.onnx"), b"not a graph").unwrap();
        assert!(damaged_download(unsealed.path(), model).is_none());

        let whole = tempfile::tempdir().unwrap();
        sealed_download(whole.path());
        assert!(damaged_download(whole.path(), model).is_none());
        assert_eq!(
            resolve(whole.path(), None, model).map(|found| found.source),
            Some(ModelSource::Downloaded),
            "a whole sealed download must still resolve at the real catalogue's lengths"
        );
    }

    /// Damage in app data does not hide a working fallback — and the damage is
    /// still there to report once the fallback is gone.
    #[test]
    fn a_damaged_download_still_falls_through_to_a_working_bundled_model() {
        let _env = env_guard();
        let temp = tempfile::tempdir().unwrap();
        let model = catalogue::default_model();
        let dir = sealed_download(temp.path());
        std::fs::write(dir.join("joiner.int8.onnx"), b"").unwrap();
        let resource = temp.path().join("resources").join("models/x-asr-480ms");
        write_detectable_model(&resource);

        let resolved = resolve(temp.path(), Some(&resource), model)
            .expect("the bundled model must still be found");
        assert_eq!(resolved.source, ModelSource::Bundled);
        assert!(damaged_download(temp.path(), model).is_some());
    }

    /// An override is unsealed, so its lengths are not held to the catalogue,
    /// but its graphs are still walked: a damaged one would abort the next
    /// load whatever its provenance.
    #[test]
    fn a_damaged_override_falls_through_to_the_download() {
        let temp = tempfile::tempdir().unwrap();
        let model = catalogue::default_model();
        let _env = env_guard();

        let source_tree = temp.path().join("src-tauri/models");
        let overridden = model.install_path(&source_tree);
        write_detectable_model(&overridden);
        std::fs::write(overridden.join("encoder.int8.onnx"), [0u8; 4096]).unwrap();
        let _override = EnvOverride::set(&source_tree);
        sealed_download(temp.path());

        let resolved = resolve(temp.path(), None, model).expect("the download must be used");
        assert_eq!(resolved.source, ModelSource::Downloaded);
    }

    /// A variant the catalogue does not describe is still a usable override:
    /// lengths are a claim only a seal can make.
    #[test]
    fn an_override_is_not_held_to_the_catalogue_lengths() {
        let temp = tempfile::tempdir().unwrap();
        let model = catalogue::default_model();
        let _env = env_guard();

        let source_tree = temp.path().join("src-tauri/models");
        let overridden = model.install_path(&source_tree);
        std::fs::create_dir_all(&overridden).unwrap();
        for name in ["encoder.int8.onnx", "decoder.onnx", "joiner.int8.onnx"] {
            write_graph(&overridden.join(name), 64, b"variant");
        }
        std::fs::write(overridden.join("tokens.txt"), b"<blk> 0\n").unwrap();
        let _override = EnvOverride::set(&source_tree);

        let resolved = resolve(temp.path(), None, model).expect("the override must resolve");
        assert_eq!(resolved.source, ModelSource::Override);
    }

    /// A sealed target that has since been damaged is not a "completed
    /// install" to protect. A proven backup beside it is put back.
    #[test]
    fn a_proven_backup_replaces_a_damaged_sealed_target() {
        let _env = env_guard();
        let temp = tempfile::tempdir().unwrap();
        let model = catalogue::default_model();
        let root = models_root(temp.path());
        let target = sealed_download(temp.path());
        std::fs::write(target.join("decoder.onnx"), b"damaged").unwrap();
        let backup = backup_path(&root, model);
        write_detectable_model(&backup);
        write_seal(&backup, model).unwrap();

        // The sweep must not throw the good copy away on the strength of the
        // damaged one's seal.
        clear_stale(temp.path(), model).unwrap();
        assert!(backup.is_dir(), "a backup beside a damaged target is the only good copy");

        assert!(recover_backup(&root, model).unwrap());
        let resolved = resolve(temp.path(), None, model).expect("the backup must be back in place");
        assert_eq!(resolved.dir, target);
        assert!(damaged_download(temp.path(), model).is_none());
    }

    #[test]
    fn nothing_anywhere_resolves_to_nothing() {
        let _env = env_guard();
        let temp = tempfile::tempdir().unwrap();
        assert!(resolve(temp.path(), None, catalogue::default_model()).is_none());
    }

    /// A bundled resource is inside the app bundle and is not ours to remove.
    #[test]
    fn deleting_a_download_leaves_the_bundled_resource_alone() {
        let _env = env_guard();
        let temp = tempfile::tempdir().unwrap();
        let model = catalogue::default_model();
        let downloaded = model.install_path(&models_root(temp.path()));
        write_detectable_model(&downloaded);
        write_seal(&downloaded, model).unwrap();
        let resource = temp.path().join("resources").join("models/x-asr-480ms");
        write_detectable_model(&resource);

        delete_downloaded(temp.path(), model).unwrap();

        assert!(!downloaded.exists(), "the download must be gone");
        let resolved = resolve(temp.path(), Some(&resource), model)
            .expect("the bundled fallback must be revealed");
        assert_eq!(resolved.source, ModelSource::Bundled);
    }

    #[test]
    fn deleting_a_model_that_is_not_there_is_not_an_error() {
        let temp = tempfile::tempdir().unwrap();
        delete_downloaded(temp.path(), catalogue::default_model()).unwrap();
    }

    /// Deleting must also drop the partial, or "delete" frees less than it
    /// says and the next download resumes bytes the user discarded.
    #[test]
    fn deleting_a_model_also_discards_its_partial_download() {
        let temp = tempfile::tempdir().unwrap();
        let model = catalogue::default_model();
        let downloads = models_root(temp.path()).join(DOWNLOADS_DIR);
        std::fs::create_dir_all(&downloads).unwrap();
        let part = downloads.join(archive_part_name(model));
        let resume = downloads.join(resume_name(model));
        std::fs::write(&part, b"half an archive").unwrap();
        std::fs::write(&resume, b"{}").unwrap();

        delete_downloaded(temp.path(), model).unwrap();

        assert!(!part.exists(), "the partial archive must be discarded");
        assert!(!resume.exists(), "the resume sidecar must be discarded");
    }

    #[test]
    fn stale_directories_are_swept_but_installed_models_are_not() {
        let temp = tempfile::tempdir().unwrap();
        let model = catalogue::default_model();
        let root = models_root(temp.path());
        let installed = model.install_path(&root);
        write_detectable_model(&installed);
        // SEALED, because that is what makes the backup redundant. An unsealed
        // target means the replacement never completed, and the backup is then
        // the only proven copy — see `a_backup_is_kept_until_the_target_is_sealed`.
        write_seal(&installed, model).unwrap();
        let staging = root.join(format!("{STAGING_PREFIX}{}-abc", model.install_dir));
        std::fs::create_dir_all(&staging).unwrap();
        let backup = backup_path(&root, model);
        std::fs::create_dir_all(&backup).unwrap();

        clear_stale(temp.path(), model).unwrap();

        assert!(!staging.exists(), "staging must be swept");
        assert!(!backup.exists(), "a superseded backup must be swept");
        assert!(installed.exists(), "an installed model must survive");
    }

    /// Scoped to ONE model, so a concurrent install of another is untouched.
    ///
    /// The sweep used to run at startup across every model, which meant a
    /// second app instance launching could delete the staging directory of an
    /// install running in the first — and that install's commit would then
    /// fail with the previous model already moved aside.
    #[test]
    fn sweeping_one_model_leaves_another_models_staging_alone() {
        let temp = tempfile::tempdir().unwrap();
        let root = models_root(temp.path());
        std::fs::create_dir_all(&root).unwrap();
        let mine = root.join(format!("{STAGING_PREFIX}x-asr-480ms-abc"));
        let theirs = root.join(format!("{STAGING_PREFIX}another-model-def"));
        std::fs::create_dir_all(&mine).unwrap();
        std::fs::create_dir_all(&theirs).unwrap();

        clear_stale(temp.path(), catalogue::default_model()).unwrap();

        assert!(!mine.exists(), "this model's staging must be swept");
        assert!(theirs.exists(), "another model's live staging must survive");
    }

    #[test]
    fn sweeping_without_a_models_root_is_not_an_error() {
        let temp = tempfile::tempdir().unwrap();
        clear_stale(temp.path(), catalogue::default_model()).unwrap();
    }

    /// The override exists so a contributor who ran `pnpm models:fetch` keeps
    /// a working dev build once nothing is bundled.
    #[test]
    fn the_models_dir_override_wins_and_needs_no_seal() {
        let temp = tempfile::tempdir().unwrap();
        let model = catalogue::default_model();
        let source_tree = temp.path().join("src-tauri/models");
        write_detectable_model(&model.install_path(&source_tree));

        // The variable is process-wide and cargo runs tests on threads, so the
        // lock is held for the whole set-resolve-restore sequence. Without it
        // every other resolving test can observe this override.
        let _env = env_guard();
        let _override = EnvOverride::set(&source_tree);

        let resolved = resolve(temp.path(), None, model).expect("the override must resolve");
        assert_eq!(resolved.source, ModelSource::Override);
    }

    /// An override pointing somewhere useless is skipped, not preferred.
    ///
    /// It is the only source that is not sealed, so shape-checking it is the
    /// whole of its safety: a stale or half-extracted directory must fall
    /// through to the download rather than shadow it.
    #[test]
    fn an_unusable_override_falls_through_to_the_download() {
        let temp = tempfile::tempdir().unwrap();
        let model = catalogue::default_model();
        let _env = env_guard();

        let empty = temp.path().join("empty-override");
        std::fs::create_dir_all(model.install_path(&empty)).unwrap();
        let _override = EnvOverride::set(&empty);

        let downloaded = model.install_path(&models_root(temp.path()));
        write_detectable_model(&downloaded);
        write_seal(&downloaded, model).unwrap();

        let resolved = resolve(temp.path(), None, model).expect("the download must be used");
        assert_eq!(resolved.source, ModelSource::Downloaded);
    }

    #[test]
    fn the_runtime_notice_states_every_fact_the_committed_one_does() {
        let model = catalogue::default_model();
        let rendered = catalogue::render_attribution(model);
        let a = &model.attribution;
        // The same needle list `the_committed_attribution_states_the_catalogue_licence`
        // holds the generated file to. Two renderers, one set of obligations.
        for needle in [
            a.title.as_str(),
            a.author.as_str(),
            a.source_url.as_str(),
            a.license.name.as_str(),
            a.license.url.as_str(),
            model.model_name.as_str(),
            model.archive.sha256.as_str(),
        ] {
            assert!(
                rendered.contains(needle),
                "the runtime notice does not mention {needle:?}"
            );
        }
        assert!(rendered.contains(if a.modified {
            "with modifications"
        } else {
            "unmodified"
        }));
    }
}
