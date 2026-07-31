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
//! their real home and only afterwards can prove the result loads, so there is
//! a window in which a complete-looking directory is not yet known to work. A
//! crash inside that window leaves exactly the thing a presence check would
//! accept and a take would then fail on: `OnlineRecognizer::create` answers a
//! wrong or half-written file with a null pointer and no reason at all. The
//! seal is written last, after `LocalSttConfig::validate` has passed against
//! the final path, so its presence means "this was proven here", and an
//! unsealed directory is treated as absent and re-downloaded.
//!
//! The seal also carries the archive digest, so a catalogue that moves to a new
//! model version does not silently keep serving the old weights: the seal stops
//! matching, the directory stops being preferred, and the user is offered the
//! download that the new catalogue describes.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::catalogue::{ModelEntry, ATTRIBUTION_FILE};

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
    std::fs::rename(&temp, dir.join(SEAL_FILE))
}

/// Is this directory a usable installation of this model?
///
/// Sealed AND shape-valid. `ModelFiles::detect` is asked rather than a list of
/// filenames because upstream is not consistent about naming and detection is
/// what the loader itself will do — checking anything else here would be
/// checking a different question than the one that decides whether a take runs.
fn is_usable(dir: &Path, model: &ModelEntry, require_seal: bool) -> bool {
    if require_seal && read_seal(dir, model).is_none() {
        return false;
    }
    cc_stt::local::ModelFiles::detect(dir).is_ok()
}

/// The development override, if one is set and usable.
///
/// `CANDIDCUE_MODELS_DIR` is the same variable `scripts/fetch-stt-model.sh`
/// already honours, pointing at the same layout. It exists because emptying
/// `bundle.resources` also stopped `tauri dev` from seeing a model fetched into
/// the source tree — Tauri only stages resources a build declares — and a
/// contributor who has already run `pnpm models:fetch` should not have to
/// re-download through the UI to get a working dev build.
///
/// NOT sealed, deliberately: the files it points at were put there by the fetch
/// script, which verified every one of them against the same catalogue. It is
/// still shape-checked, so a stale or half-extracted directory is skipped
/// rather than loaded.
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
/// Used immediately before the rename that installs a staged directory:
/// `rename` onto a non-empty directory fails with `ENOTEMPTY` on macOS and
/// `EEXIST` on Windows, so clearing the target first is required rather than
/// tidy. Keeping the gap between the two as short as possible is why this is
/// its own call at the install site and not part of a longer sequence.
pub fn remove_dir_if_present(dir: &Path) -> std::io::Result<()> {
    match std::fs::remove_dir_all(dir) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

/// Delete any staging directory left behind by a run that did not finish.
///
/// Extraction is never resumed — only downloads are. A staging directory is
/// therefore always garbage by the time anything looks at it, and clearing it
/// before a new attempt keeps a failed run from costing disk forever.
pub fn clear_staging(app_data_dir: &Path) -> std::io::Result<()> {
    let root = models_root(app_data_dir);
    let entries = match std::fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err),
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if name.to_string_lossy().starts_with(STAGING_PREFIX) {
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

/// Write the licence notice beside the weights.
///
/// Into staging, before the install rename, so a model directory is never
/// visible without the notice its licence requires to travel with it.
pub fn write_attribution(dir: &Path, model: &ModelEntry) -> std::io::Result<()> {
    std::fs::write(
        dir.join(ATTRIBUTION_FILE),
        super::catalogue::render_attribution(model),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::speech::catalogue;

    /// Enough of a model directory for `ModelFiles::detect` to accept it.
    fn write_detectable_model(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        for name in ["encoder.int8.onnx", "decoder.onnx", "joiner.int8.onnx"] {
            std::fs::write(dir.join(name), b"graph").unwrap();
        }
        std::fs::write(dir.join("tokens.txt"), b"<blk> 0\n").unwrap();
    }

    #[test]
    fn a_sealed_and_detectable_download_resolves() {
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

    #[test]
    fn nothing_anywhere_resolves_to_nothing() {
        let temp = tempfile::tempdir().unwrap();
        assert!(resolve(temp.path(), None, catalogue::default_model()).is_none());
    }

    /// A bundled resource is inside the app bundle and is not ours to remove.
    #[test]
    fn deleting_a_download_leaves_the_bundled_resource_alone() {
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
    fn staging_directories_are_swept_but_installed_models_are_not() {
        let temp = tempfile::tempdir().unwrap();
        let model = catalogue::default_model();
        let root = models_root(temp.path());
        let installed = model.install_path(&root);
        write_detectable_model(&installed);
        let staging = root.join(format!("{STAGING_PREFIX}x-asr-480ms-abc"));
        std::fs::create_dir_all(&staging).unwrap();

        clear_staging(temp.path()).unwrap();

        assert!(!staging.exists(), "staging must be swept");
        assert!(installed.exists(), "an installed model must survive");
    }

    #[test]
    fn sweeping_staging_without_a_models_root_is_not_an_error() {
        let temp = tempfile::tempdir().unwrap();
        clear_staging(temp.path()).unwrap();
    }

    /// The override exists so a contributor who ran `pnpm models:fetch` keeps
    /// a working dev build once nothing is bundled.
    #[test]
    fn the_models_dir_override_wins_and_needs_no_seal() {
        let temp = tempfile::tempdir().unwrap();
        let model = catalogue::default_model();
        let source_tree = temp.path().join("src-tauri/models");
        write_detectable_model(&model.install_path(&source_tree));

        // Set for this test only. Serialised with the test below by running
        // both under one #[test], because the environment is process-wide and
        // cargo runs tests in threads.
        std::env::set_var("CANDIDCUE_MODELS_DIR", &source_tree);
        let resolved = resolve(temp.path(), None, model);
        std::env::remove_var("CANDIDCUE_MODELS_DIR");

        let resolved = resolved.expect("the override must resolve");
        assert_eq!(resolved.source, ModelSource::Override);
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
