//! The model catalogue — one place that says what a speech model *is*.
//!
//! `src-tauri/models/catalogue.json` names, per model: the archive and where to
//! get it, its SHA-256 and byte size, the files to keep and each of their
//! hashes, the languages it covers, and the licence its redistribution is
//! subject to. `scripts/fetch-stt-model.sh` reads that file through
//! `scripts/model-catalogue.mjs`; this module compiles the same bytes in with
//! `include_str!`. Neither side can restate a model's identity on its own, so
//! the dev path and the shipped path cannot drift into disagreeing about it.
//!
//! The catalogue is **not** signed, and deliberately. It ships inside the
//! binary rather than being fetched, so it already inherits whatever trust the
//! application bundle has — a detached signature would be answering a question
//! this design does not ask. That changes the day the catalogue itself arrives
//! over the network, which is issue #152's territory, not this module's.
//!
//! Nothing here downloads anything. The URL and hash fields are carried so the
//! in-app downloader has them when it exists; today only the shell script
//! fetches, and it verifies before it unpacks.

use std::sync::LazyLock;

use serde::Deserialize;

/// The catalogue bytes, compiled in. Same file the fetch script reads.
const CATALOGUE_JSON: &str = include_str!("../../models/catalogue.json");

/// Bumped when the shape changes in a way `model-catalogue.mjs` must be taught.
const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Catalogue {
    pub schema_version: u32,
    /// Base URL of the mirror we control, or `None` while none is stood up.
    ///
    /// `None` is not a failure: the fetch script falls straight through to the
    /// upstream URL, which is hash-checked exactly the same way. The mirror
    /// buys availability — upstream's release tag is mutable and an asset can
    /// vanish — not integrity, which the digest already provides.
    pub mirror_base_url: Option<String>,
    pub default_model_id: String,
    pub models: Vec<ModelEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelEntry {
    /// Stable short identifier. Also the directory the model installs into.
    pub id: String,
    /// What the app calls this model when it reports what is listening.
    pub model_name: String,
    pub install_dir: String,
    pub languages: Vec<String>,
    pub archive: Archive,
    pub files: Vec<ModelFile>,
    pub attribution: Attribution,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Archive {
    pub file_name: String,
    /// The single directory the archive unpacks into.
    pub root_dir: String,
    pub upstream_url: String,
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelFile {
    pub name: String,
    pub sha256: String,
    pub bytes: u64,
}

/// Title, author, source, licence — plus whether we changed anything.
///
/// Not display metadata. Mirroring is redistribution, and both Apache-2.0 and
/// CC-BY-SA require the notice to travel with the files, which is why
/// `ATTRIBUTION.md` is written beside the model at unpack time from exactly
/// these fields rather than being maintained by hand somewhere else.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Attribution {
    pub title: String,
    pub author: String,
    pub source_url: String,
    pub distributed_via: Option<String>,
    pub license: License,
    /// Anything that qualifies the licence — e.g. upstream naming a licence
    /// family without a version. Required when `modified` is true.
    pub license_note: Option<String>,
    pub modified: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct License {
    pub id: String,
    pub name: String,
    pub url: String,
}

/// Parsed once. A malformed committed catalogue is a build defect, not user
/// input, so this panics rather than growing a recovery path nobody can take.
static CATALOGUE: LazyLock<Catalogue> = LazyLock::new(|| {
    let parsed: Catalogue =
        serde_json::from_str(CATALOGUE_JSON).expect("models/catalogue.json must parse");
    assert_eq!(
        parsed.schema_version, SCHEMA_VERSION,
        "catalogue schemaVersion {} but this build understands {SCHEMA_VERSION}",
        parsed.schema_version
    );
    parsed
});

pub fn catalogue() -> &'static Catalogue {
    &CATALOGUE
}

impl Catalogue {
    pub fn get(&self, id: &str) -> Option<&ModelEntry> {
        self.models.iter().find(|m| m.id == id)
    }

    /// The model this build ships. Guaranteed present — a `defaultModelId`
    /// naming no entry fails the test below before it can ship.
    pub fn default_model(&self) -> &ModelEntry {
        self.get(&self.default_model_id)
            .expect("defaultModelId must name an entry")
    }
}

impl ModelEntry {
    /// Where the bundler puts this model, relative to the resource root.
    pub fn resource_dir(&self) -> String {
        format!("models/{}", self.install_dir)
    }
}

/// The model this build ships.
pub fn default_model() -> &'static ModelEntry {
    catalogue().default_model()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// The BUNDLE manifest's default, as opposed to this module's
    /// `default_model()`, which is the FETCH manifest's.
    ///
    /// Two lists, deliberately: `cc_stt::models` is compiled in and describes
    /// what this build actually ships and how each entry was tuned, while
    /// `models/catalogue.json` describes everything `pnpm models:fetch` can
    /// download — four models against the one `tauri.conf.json` bundles. They
    /// are only required to agree about the default, which is what the tests
    /// below pin. Aliased rather than glob-imported so that neither name can
    /// quietly shadow the other.
    use cc_stt::models::default_model as bundled_default;

    /// A name that stays inside the model directory. Mirrors the same check in
    /// `model-catalogue.mjs` — the shell script joins these onto a path.
    fn is_safe_name(name: &str) -> bool {
        !name.is_empty()
            && !name.starts_with('.')
            && !name.contains('/')
            && !name.contains('\\')
            && !name.contains('\0')
    }

    fn is_sha256(value: &str) -> bool {
        value.len() == 64 && value.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
    }

    #[test]
    fn the_catalogue_parses_and_names_a_default() {
        let cat = catalogue();
        assert_eq!(cat.schema_version, SCHEMA_VERSION);
        assert!(!cat.models.is_empty());
        // Panics if `defaultModelId` names nothing.
        let _ = cat.default_model();
    }

    #[test]
    fn every_entry_is_well_formed() {
        let mut ids = HashSet::new();
        let mut dirs = HashSet::new();
        for model in &catalogue().models {
            assert!(is_safe_name(&model.id), "{}: unsafe id", model.id);
            assert!(ids.insert(&model.id), "duplicate id {}", model.id);
            assert!(
                is_safe_name(&model.install_dir),
                "{}: unsafe installDir",
                model.id
            );
            assert!(
                dirs.insert(&model.install_dir),
                "duplicate installDir {}",
                model.install_dir
            );
            assert!(!model.model_name.is_empty(), "{}: empty modelName", model.id);
            assert!(!model.languages.is_empty(), "{}: no languages", model.id);

            assert!(
                is_safe_name(&model.archive.file_name),
                "{}: unsafe archive fileName",
                model.id
            );
            assert!(
                is_safe_name(&model.archive.root_dir),
                "{}: unsafe archive rootDir",
                model.id
            );
            assert!(
                is_sha256(&model.archive.sha256),
                "{}: archive sha256 must be 64 lowercase hex chars",
                model.id
            );
            assert!(model.archive.bytes > 0, "{}: archive bytes", model.id);
            assert!(
                model.archive.upstream_url.starts_with("https://"),
                "{}: upstream URL must be https",
                model.id
            );

            assert!(!model.files.is_empty(), "{}: no files", model.id);
            let mut names = HashSet::new();
            for file in &model.files {
                assert!(
                    is_safe_name(&file.name),
                    "{}: unsafe file name {}",
                    model.id,
                    file.name
                );
                assert!(
                    names.insert(&file.name),
                    "{}: duplicate file {}",
                    model.id,
                    file.name
                );
                assert!(
                    is_sha256(&file.sha256),
                    "{}: {}: sha256 must be 64 lowercase hex chars",
                    model.id,
                    file.name
                );
                assert!(file.bytes > 0, "{}: {}: bytes", model.id, file.name);
            }
        }
    }

    #[test]
    fn every_entry_carries_a_usable_attribution() {
        for model in &catalogue().models {
            let a = &model.attribution;
            assert!(!a.title.is_empty(), "{}: title", model.id);
            assert!(!a.author.is_empty(), "{}: author", model.id);
            assert!(
                a.source_url.starts_with("https://"),
                "{}: source URL must be https",
                model.id
            );
            assert!(!a.license.id.is_empty(), "{}: licence id", model.id);
            assert!(!a.license.name.is_empty(), "{}: licence name", model.id);
            assert!(
                a.license.url.starts_with("https://"),
                "{}: licence URL must be https",
                model.id
            );
            // Saying the files were changed without saying what changed does
            // not satisfy either licence's modification clause.
            if a.modified {
                assert!(
                    a.license_note
                        .as_deref()
                        .is_some_and(|note| !note.trim().is_empty()),
                    "{}: modified is true but licenseNote does not say what changed",
                    model.id
                );
            }
        }
    }

    /// The mirror URL layout is content-addressed on purpose: the digest is in
    /// the path, so one URL can only ever name one set of bytes — the property
    /// upstream's mutable `asr-models` tag lacks.
    #[test]
    fn the_mirror_base_is_https_when_one_is_configured() {
        if let Some(base) = &catalogue().mirror_base_url {
            assert!(
                base.starts_with("https://"),
                "mirror base must be https, got {base}"
            );
        }
    }

    /// The bundled model's id is what Settings reports and what the log line
    /// carries; the fetch catalogue's `modelName` is what gets downloaded.
    /// Before the catalogue existed this was a second hardcoded string that had
    /// already drifted from the one in the fetch script.
    #[test]
    fn the_reported_model_name_is_the_catalogue_default() {
        assert_eq!(bundled_default().id, default_model().model_name);
    }

    /// The bundled model's `resource_dir` is where the resolver looks at
    /// runtime and what `tauri.conf.json` bundles. The fetch catalogue derives
    /// the same path from its `installDir`, so the download lands where the
    /// resolver will look.
    #[test]
    fn the_resource_dir_is_the_catalogue_install_dir() {
        assert_eq!(bundled_default().resource_dir, default_model().resource_dir());
    }

    /// The frontend carries its own copy of the model name, for the browser
    /// mock and the offline fallback — the two places Rust is not there to
    /// correct a stale value. Same `include_str!` trick the stage event names
    /// use, for the same reason.
    #[test]
    fn the_frontend_names_the_same_recogniser() {
        let ts = include_str!("../../../src/shared/contracts/audio.ts");
        let expected = format!("export const BUNDLED_MODEL_NAME = '{}';", bundled_default().id);
        assert!(
            ts.contains(&expected),
            "src/shared/contracts/audio.ts must declare {expected}"
        );
    }

    /// The committed notice is generated output. If the catalogue's licence
    /// facts change and nobody re-runs `pnpm models:fetch`, the file on disk
    /// starts describing a model on terms it is not distributed under.
    #[test]
    fn the_committed_attribution_states_the_catalogue_licence() {
        let committed = include_str!("../../models/x-asr-480ms/ATTRIBUTION.md");
        let model = default_model();
        let a = &model.attribution;
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
                committed.contains(needle),
                "ATTRIBUTION.md is stale — it does not mention {needle:?}. \
                 Re-run `pnpm models:fetch` to regenerate it."
            );
        }
        assert!(
            committed.contains(if a.modified {
                "with modifications"
            } else {
                "unmodified"
            }),
            "ATTRIBUTION.md must state whether the files were modified"
        );
    }
}
