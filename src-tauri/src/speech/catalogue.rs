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
//! Nothing here downloads anything. The URL and hash fields are what the
//! in-app downloader (`speech::model_download`) and the developer shell script
//! both take their targets from: each checks the ARCHIVE hash before it
//! unpacks, and the per-file hashes after, because a member's digest cannot be
//! taken until the member exists.

use std::sync::LazyLock;

use serde::Deserialize;

/// The catalogue bytes, compiled in. Same file the fetch script reads.
const CATALOGUE_JSON: &str = include_str!("../../models/catalogue.json");

/// Bumped when the shape changes in a way `model-catalogue.mjs` must be taught.
const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Deserialize)]
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

#[derive(Debug, Clone, Deserialize)]
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Archive {
    pub file_name: String,
    /// The single directory the archive unpacks into.
    pub root_dir: String,
    pub upstream_url: String,
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelFile {
    pub name: String,
    pub sha256: String,
    pub bytes: u64,
}

/// Title, author, source, licence — plus whether we changed anything.
///
/// Not display metadata. Mirroring is redistribution, and Apache-2.0 requires
/// the notice to travel with the files, which is why
/// `ATTRIBUTION.md` is written beside the model at unpack time from exactly
/// these fields rather than being maintained by hand somewhere else.
#[derive(Debug, Clone, Deserialize)]
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

#[derive(Debug, Clone, Deserialize)]
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

/// Every licence url the catalogue declares.
///
/// The allow-list for `open_model_licence`, derived from the catalogue rather
/// than restated beside it. That is what makes it impossible to drift: adding
/// a model with a new licence adds its url here automatically, and a url this
/// file does not name cannot be opened at all.
///
/// Stricter than a host allow-list on purpose. `https://www.apache.org/...`
/// as a HOST would also permit every other page on apache.org; as an exact url
/// it permits the licence and nothing else.
pub fn licence_urls() -> Vec<String> {
    CATALOGUE
        .models
        .iter()
        .map(|model| model.attribution.license.url.clone())
        .collect()
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
    ///
    /// Only meaningful for a build that opts into shipping one: stock
    /// `tauri.conf.json` bundles no models at all (§152), and the resolver
    /// treats this as a fallback to check rather than a place to expect.
    pub fn resource_dir(&self) -> String {
        format!("models/{}", self.install_dir)
    }

    /// Total size on disk once installed, in bytes.
    ///
    /// The archive's own `bytes` is the DOWNLOAD size and is much smaller —
    /// 128 MB of bz2 unpacks to ~161 MB here. Both are shown, because a user
    /// deciding whether to start needs the transfer and a user deciding
    /// whether to delete needs the footprint.
    pub fn installed_bytes(&self) -> u64 {
        self.files.iter().map(|file| file.bytes).sum()
    }

    /// The archive member this catalogue file is unpacked from.
    ///
    /// Composed rather than stored: every upstream bundle puts its files
    /// directly under one root directory, and `every_entry_is_well_formed`
    /// already refuses a `rootDir` or `name` that could escape it.
    pub fn member_path(&self, file: &ModelFile) -> String {
        format!("{}/{}", self.archive.root_dir, file.name)
    }

    /// The catalogue file this archive member is, if the catalogue wants it.
    ///
    /// Everything else in the archive — test WAVs, export scripts, symlinks —
    /// is never written to disk. The digest already proves these are the
    /// pinned bytes; naming the members is the separate claim that they are
    /// safe to unpack.
    pub fn file_for_member(&self, member: &str) -> Option<&ModelFile> {
        self.files
            .iter()
            .find(|file| self.member_path(file) == member)
    }

    /// Where this model installs to under a models root.
    ///
    /// Built from `install_dir`, which `every_entry_is_well_formed` pins to a
    /// single path segment with no separators, no leading dot and no NUL — so
    /// this cannot climb out of `root` however the catalogue is edited. A raw
    /// id off the IPC boundary never reaches this; callers resolve an entry
    /// first and pass the entry.
    pub fn install_path(&self, root: &std::path::Path) -> std::path::PathBuf {
        root.join(&self.install_dir)
    }
}

/// The model this build ships.
pub fn default_model() -> &'static ModelEntry {
    catalogue().default_model()
}

/// The name the notice is written under, inside the model directory.
pub const ATTRIBUTION_FILE: &str = "ATTRIBUTION.md";

/// The licence texts a distributed model may need, compiled in.
///
/// `include_str!` rather than a runtime read, and that is the point: the text
/// has to be present in a signed `.app` on a machine with no network and no
/// repository. A path lookup would work in `cargo test` and fail on the one
/// installation where the obligation actually applies.
///
/// Keyed by SPDX id, which is what `catalogue.json` records. Adding a model
/// under a licence that is not here is caught by
/// `every_catalogued_licence_has_committed_text` — before the build, rather
/// than by whoever reads the installed directory afterwards.
const LICENCE_TEXTS: &[(&str, &str)] = &[
    (
        "Apache-2.0",
        include_str!("../../../legal/licenses/Apache-2.0.txt"),
    ),
];

/// The full text of a licence by SPDX id, or `None` if none was committed.
pub fn licence_text(id: &str) -> Option<&'static str> {
    LICENCE_TEXTS
        .iter()
        .find(|(known, _)| *known == id)
        .map(|(_, text)| *text)
}

/// What the licence text is called inside the model directory.
///
/// The SPDX id is in the name so a directory holding a model under one licence
/// cannot be mistaken for one holding another — and so a support request that
/// lists the directory says which licence applies without opening anything.
pub fn licence_file_name(id: &str) -> String {
    format!("LICENSE-{id}.txt")
}

/// Render the licence notice that travels with an installed model.
///
/// A second renderer, beside `scripts/model-catalogue.mjs`, and deliberately.
/// The script writes the notice for a model fetched into the source tree at
/// dev time; this writes it for one downloaded into app data on a user's
/// machine, and only one of those two runs on a machine that has node. Both
/// read the SAME catalogue, so they cannot disagree about a licence — which is
/// the property that matters and the one
/// `the_runtime_notice_states_every_fact_the_committed_one_does` pins.
///
/// Byte-identity between the two is NOT asserted, because it would be a lie
/// dressed as a guarantee: the wording legitimately differs (the script can
/// tell you to re-run `pnpm models:fetch`; the app cannot), and pinning the
/// prose would make every copy-edit a cross-language chore that teaches people
/// to update the fixture rather than think about it.
pub fn render_attribution(model: &ModelEntry) -> String {
    let a = &model.attribution;
    let mut out = String::new();
    out.push_str(
        "<!-- Generated by CandidCue from src-tauri/models/catalogue.json.\n     \
         Do not edit by hand. -->\n\n\
         # Speech recognition model\n\n\
         CandidCue transcribes speech on-device using a model it does not own. This file\n\
         travels with the model because redistribution requires the attribution to travel\n\
         with it, and the upstream archive ships no licence file of its own.\n\n\
         It lives inside the model directory deliberately: the model is downloaded after\n\
         installation rather than shipped inside the app, so a notice kept anywhere else\n\
         would describe an artefact that may not be present.\n\n\
         ## The model\n\n",
    );
    out.push_str(&format!("**{}**\n\n", a.title));
    out.push_str(&format!("- Model: `{}`\n", model.model_name));
    out.push_str(&format!("- Languages: {}\n", model.languages.join(", ")));
    out.push_str(&format!("- Authors: {}\n", a.author));
    out.push_str(&format!("- Source: <{}>\n", a.source_url));
    if let Some(via) = &a.distributed_via {
        out.push_str(&format!(
            "- Distributed via: <{}>, as `{}`\n",
            via, model.archive.root_dir
        ));
    }
    out.push_str(&format!(
        "- **Licence: {}** (`{}`) — <{}>\n\n",
        a.license.name, a.license.id, a.license.url
    ));
    out.push_str(if a.modified {
        "CandidCue redistributes these model weights **with modifications**.\n"
    } else {
        "CandidCue redistributes these model weights **unmodified**.\n"
    });
    if let Some(note) = &a.license_note {
        out.push_str(&format!("\n{note}\n"));
    }
    out.push_str(
        "\n## Integrity\n\n\
         The archive these files came from is pinned in the catalogue by SHA-256, and\n\
         the download refuses to unpack bytes that do not match:\n\n",
    );
    out.push_str(&format!("- Archive: `{}`\n", model.archive.file_name));
    out.push_str(&format!("- SHA-256: `{}`\n", model.archive.sha256));
    out.push_str(&format!("- Size: {} bytes\n", model.archive.bytes));
    out.push_str(
        "\n## The runtime\n\n\
         Inference runs through **sherpa-onnx** (<https://github.com/k2-fsa/sherpa-onnx>),\n\
         Apache-2.0, linked statically via the `sherpa-onnx` Rust crate, which in turn\n\
         embeds **ONNX Runtime** (MIT).\n\n\
         ## Licence text\n\n",
    );
    out.push_str(&format!(
        "The full text of the {} is in `{}`, in this directory, beside the weights it\n\
         governs. It is written out at install time rather than linked, because a URL is\n\
         not a copy: a machine holding the model offline would otherwise have the thing\n\
         the licence covers and not the licence.\n\n",
        a.license.name,
        super::catalogue::licence_file_name(&a.license.id),
    ));
    out.push_str(&format!(
        "The canonical text is also published at <{}>.\n",
        a.license.url
    ));
    out
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
    /// `models/catalogue.json` describes everything `pnpm models:fetch` and the
    /// in-app installer can download. They are only required to agree about
    /// the default, which is what the tests below pin. Aliased rather than
    /// glob-imported so that neither name can quietly shadow the other.
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

    /// `model_manager::entry_for` accepts either id, so the two namespaces
    /// must never overlap: an `id` that equalled another entry's `modelName`
    /// would win the first lookup and resolve the persisted model to the wrong
    /// package, silently.
    #[test]
    fn catalogue_ids_and_recogniser_ids_are_disjoint() {
        let ids: HashSet<&str> = catalogue().models.iter().map(|m| m.id.as_str()).collect();
        for model in &catalogue().models {
            assert!(
                !ids.contains(model.model_name.as_str()),
                "{}: modelName {} is another entry's id",
                model.id,
                model.model_name
            );
        }
    }

    #[test]
    fn every_entry_is_well_formed() {
        let mut ids = HashSet::new();
        let mut dirs = HashSet::new();
        let mut model_names = HashSet::new();
        for model in &catalogue().models {
            // `modelName` is the join to `cc_stt::models::BundledModel::id`, and
            // it is what `audio.transcriptionModel` persists. Two entries
            // sharing one would make that setting ambiguous — `model_dir`
            // resolves the FIRST match, so the app would silently load a
            // different package than the one the user picked.
            assert!(
                model_names.insert(&model.model_name),
                "duplicate modelName {}",
                model.model_name
            );
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
            // Apache-2.0 §4(b) wants a notice that the files were changed; this
            // catalogue also wants it to say WHAT changed, because "modified"
            // alone tells whoever reads the notice nothing they can act on.
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

    /// No loadable recogniser serves a language nobody has measured.
    ///
    /// A `BundledModel` entry is a claim that the tuning beside it was
    /// MEASURED, and no `blank_penalty` sweep has been run for a recogniser in
    /// any of these. The English 3.0 cannot be borrowed — it was swept against
    /// the English corpus, where following quality and word error rate moved
    /// in OPPOSITE directions.
    ///
    /// This is load-bearing: the speech commands load whichever recogniser the
    /// persisted setting selects (§153), so a `BundledModel` entry is by itself
    /// enough to put an unmeasured recogniser in front of a live take. What
    /// supporting one of these languages takes, stated in full so nobody plans
    /// on half of it: a normalisation profile in `cc_align`, a corpus in the
    /// language, a `blank_penalty` sweep, a passing run of
    /// `cc-bench gate-language`, a catalogue entry for the weights, and then a
    /// `BundledModel` entry carrying the measured numbers.
    #[test]
    fn no_loadable_recogniser_serves_an_unmeasured_language() {
        for tag in ["fr-FR", "de-DE", "es-ES"] {
            assert!(
                !cc_stt::models::bundled_models()
                    .iter()
                    .any(|model| model.serves_language(tag)),
                "{tag} is served by a loadable model, which claims its tuning \
                 was measured — that requires a passing language gate first"
            );
        }
    }

    /// Every licence the catalogue can distribute under has its text committed.
    ///
    /// The obligation this closes: `ATTRIBUTION.md` said "a distributed build
    /// must include that text" and then linked to it, which is a notice that
    /// states its own obligation and does not meet it. Apache-2.0 §4(a) wants
    /// a COPY to travel with the work, and a user holding the weights offline
    /// has the work and not the licence.
    ///
    /// Checked over the WHOLE catalogue rather than the default model, because
    /// `start_speech_model_download` takes any catalogue id: a model no picker
    /// offers can still be installed, and it would install under a licence
    /// whose text was never written out.
    #[test]
    fn every_catalogued_licence_has_committed_text() {
        for model in &catalogue().models {
            let id = &model.attribution.license.id;
            let text = licence_text(id).unwrap_or_else(|| {
                panic!(
                    "{}: no committed text for {id}. Add legal/licenses/{id}.txt and \
                     include_str! it in LICENCE_TEXTS — a model must not be installable \
                     under a licence its own directory cannot show.",
                    model.id
                )
            });
            // Present is not enough; it has to be the licence it claims to be.
            assert!(
                text.len() > 2000,
                "{}: the committed {id} text is {} bytes — too short to be a licence",
                model.id,
                text.len()
            );
            assert!(
                text.contains(match id.as_str() {
                    "Apache-2.0" => "Apache License",
                    other => panic!("no identifying phrase known for {other}"),
                }),
                "{}: legal/licenses/{id}.txt does not read like {id}",
                model.id
            );
        }
    }

    /// And the notice points at the file, rather than only at a URL.
    #[test]
    fn the_notice_names_the_licence_file_beside_it() {
        for model in &catalogue().models {
            let rendered = render_attribution(model);
            let name = licence_file_name(&model.attribution.license.id);
            assert!(
                rendered.contains(&name),
                "{}: the notice must name {name}, the copy in the same directory",
                model.id
            );
        }
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
