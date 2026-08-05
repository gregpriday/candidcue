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
/// Not display metadata. Mirroring is redistribution, and both Apache-2.0 and
/// CC-BY-SA require the notice to travel with the files, which is why
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
        "The full text of the {} is at <{}>.\n\n",
        a.license.name, a.license.url
    ));
    out.push_str(
        "A distributed build must include that text. If CandidCue grows a general\n\
         third-party licence screen, this entry belongs in it; until then this file is\n\
         the record, and it travels with the model.\n",
    );
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

    /// The Kroko models are downloadable and NOT loadable, and that is the
    /// whole of #157's shipping decision.
    ///
    /// `cc_align` gained French, German and Spanish normalisation profiles, so
    /// the engine can compile a script in those languages — the precondition
    /// for ever scoring a corpus in one, since a corpus cannot be judged in a
    /// language the normaliser does not have. (Selecting one from `cc-bench`'s
    /// command line is still to do; `CompileOptions` carries the language, but
    /// every call site there passes `default()`.) Nothing else changed here,
    /// because nothing else may:
    /// a `BundledModel` entry is a claim that the tuning beside it was
    /// MEASURED, and no `blank_penalty` sweep has been run for any of these
    /// three. The English 3.0 cannot be borrowed — it was swept against the
    /// English corpus, where following quality and word error rate moved in
    /// OPPOSITE directions, so carrying it across would be picking a number by
    /// coincidence and calling it evidence.
    ///
    /// So `loadable_model` answers `None` for them, the model manager reports
    /// them unsupported and refuses the download, and
    /// `settings::migrate_in_place` refuses a `fr-FR` because no loadable
    /// recogniser serves French. Deleting this test to make a language work is
    /// the mistake it exists to catch.
    ///
    /// What the fix actually is, stated in full so nobody plans on half of it:
    /// a corpus in the language, a `blank_penalty` sweep, a passing run of
    /// `cc-bench gate-language`, and then a `BundledModel` entry carrying the
    /// measured numbers. That list is now the whole of it. The speech commands
    /// used to owe a debt here as well — `start_transcription` and
    /// `preload_speech_engine` both called `default_model()` and never read the
    /// setting — but §153 gave them a `selected_model` helper that resolves the
    /// persisted choice through `settings::selected_model` on every call, so
    /// whichever recogniser the user picked is the one that listens. Which
    /// makes this test load-bearing rather than merely tidy: a `BundledModel`
    /// entry is now by itself enough to put an unmeasured recogniser in front
    /// of a live take, with no second piece of wiring left to forget.
    #[test]
    fn the_kroko_models_download_but_do_not_load_until_they_are_measured() {
        for id in ["kroko-fr", "kroko-de", "kroko-es"] {
            let entry = catalogue()
                .get(id)
                .unwrap_or_else(|| panic!("{id} must stay in the catalogue"));
            assert!(
                crate::speech::model_manager::loadable_model(entry).is_none(),
                "{id} has a BundledModel, so this build would offer a language \
                 nobody has measured. See bench/README.md, \"What supporting a \
                 language requires\"."
            );

            // The alignment half IS ready, and saying so here is the point:
            // these two facts are meant to be separable, and a reader who finds
            // only the refusal above should be able to see that the profile
            // exists and is waiting on a measurement rather than on more code.
            let tag = entry.languages.first().expect("a language");
            assert!(
                cc_align::AlignmentLanguage::from_bcp47(tag).is_some(),
                "{id} serves {tag}, which the alignment engine cannot normalise"
            );
        }
    }

    /// The other half of the gate, from the settings side: a language the
    /// engine can normalise is still refused while no loadable model serves it.
    ///
    /// This is what makes the profiles safe to land ahead of the measurement.
    #[test]
    fn a_normalisable_language_is_not_thereby_an_offered_one() {
        for tag in ["fr-FR", "de-DE", "es-ES"] {
            assert!(
                cc_align::AlignmentLanguage::from_bcp47(tag).is_some(),
                "{tag} should normalise — #157 added the profile"
            );
            assert!(
                !cc_stt::models::bundled_models()
                    .iter()
                    .any(|model| model.serves_language(tag)),
                "{tag} is served by a loadable model, so the settings gate \
                 would now honour it — which requires a passing language gate \
                 first"
            );
        }
    }

    /// A CC-BY-SA claim is only as good as the archive it was checked against.
    ///
    /// Banafo ships Kroko in two tiers. The Hugging Face community weights are
    /// the free one; Banafo also sells Commercial & OEM models through
    /// `kroko.ai` — different weights, separate terms, no relation to the
    /// licence recorded here beyond sharing an author. The failure this guards
    /// against is quiet: someone adds a Kroko model and copies the
    /// `attribution` block off the entry above because every other field is
    /// right, and the catalogue now records a CC-BY-SA licence over weights
    /// nobody checked. That claim then travels — into `ATTRIBUTION.md` on the
    /// user's disk and into the licence line in Settings › Speech — looking
    /// exactly like one that was checked.
    ///
    /// So the guard keys off the archive digest, which names the actual bytes,
    /// rather than the author or the source URL, which are prose someone can
    /// edit in the same keystroke as the mistake. Copying an attribution block
    /// onto a new model does not copy its digest, so the copy fails here.
    ///
    /// It does NOT say every Banafo entry must be CC-BY-SA-4.0. A paid model
    /// recorded under its own real terms is a perfectly good catalogue entry
    /// and this test must not stand in its way. It says the reverse: an entry
    /// *claiming* CC-BY-SA — any version, hence the prefix match — has to be one
    /// of the archives below, and adding one means a person went and read the
    /// terms for those bytes.
    ///
    /// **On the version.** Upstream does not name one. As of 2026-08-05 the
    /// Hugging Face card carries `license: other` with an empty LICENSE file,
    /// and the model card, `kroko-onnx` and `kroko.ai` all write a bare
    /// "CC-BY-SA" (§197). Recording 4.0 is this project's reading, not a
    /// quotation, and `licenseNote` is where that is said out loud.
    ///
    /// Picking 4.0 is picking the *more permissive* candidate, which is worth
    /// being deliberate about: 2.0 and 3.0 require the work's title in the
    /// attribution and forbid applying technical protection measures, where 4.0
    /// relaxes both. It is safe here only because the notice CandidCue renders
    /// satisfies the stricter versions anyway — `render_attribution` states the
    /// title, the author, the source and that the weights are unmodified, and
    /// nothing in the app puts a TPM near them. Keep that true and the version
    /// question stays academic. Stop stating the title, and it stops being.
    #[test]
    fn a_cc_by_sa_claim_stays_with_the_archive_it_was_checked_against() {
        // The archives someone actually read the terms for, by id and digest.
        const REVIEWED_COMMUNITY_WEIGHTS: [(&str, &str); 3] = [
            (
                "kroko-fr",
                "e6ffd3dc43725cd6c8137b05c739f15607d0df946b9b90eb141e10059efca024",
            ),
            (
                "kroko-de",
                "9e27b783c20e67b0d0f13a258c1861fce199917c969d9176a438bee38df64962",
            ),
            (
                "kroko-es",
                "31b2230a95d23290b308b393da930015a4b2105cb3abb9367aed35f7fcf29cf1",
            ),
        ];
        const COMMUNITY_SOURCE: &str = "https://huggingface.co/Banafo/Kroko-ASR";
        const COMMUNITY_LICENSE_ID: &str = "CC-BY-SA-4.0";
        const COMMUNITY_LICENSE_NAME: &str =
            "Creative Commons Attribution-ShareAlike 4.0 International";
        const COMMUNITY_LICENSE_URL: &str =
            "https://creativecommons.org/licenses/by-sa/4.0/legalcode";

        for (id, sha256) in REVIEWED_COMMUNITY_WEIGHTS {
            let entry = catalogue()
                .get(id)
                .unwrap_or_else(|| panic!("{id} must stay in the catalogue"));
            assert_eq!(
                entry.archive.sha256, sha256,
                "{id}: the archive changed, so the licence recorded for the old \
                 bytes does not carry over — read the terms for the new ones"
            );
            let a = &entry.attribution;
            assert_eq!(a.author, "Banafo", "{id}: unexpected author");
            assert_eq!(a.source_url, COMMUNITY_SOURCE, "{id}: unexpected source");
            // Pinned explicitly, because the sweep below only inspects entries
            // that already claim CC-BY-SA. An entry quietly reverted to the
            // unversioned form §197 replaced would match the prefix — but one
            // relicensed to something else entirely would slip past it, and
            // these three are not free to be relicensed.
            assert_eq!(
                a.license.id, COMMUNITY_LICENSE_ID,
                "{id}: the version is pinned. Unversioned, the attribution and \
                 termination terms that apply are unresolved — commercial use \
                 is permitted under every CC-BY-SA version, so that was never \
                 the open question."
            );
            // The version is inferred, so the note has to say so, and it has to
            // keep the tier boundary the licence depends on. Rendered verbatim
            // into ATTRIBUTION.md and into Settings › Speech.
            let note = a
                .license_note
                .as_deref()
                .unwrap_or_else(|| panic!("{id}: an inferred version needs a licenseNote"));
            assert!(
                note.contains("Commercial and OEM"),
                "{id}: the note must keep saying this licence does not reach \
                 Banafo's paid tier"
            );
        }

        for model in &catalogue().models {
            let a = &model.attribution;
            if !a.license.id.starts_with("CC-BY-SA") {
                continue;
            }
            assert!(
                REVIEWED_COMMUNITY_WEIGHTS
                    .iter()
                    .any(|(id, sha256)| model.id == *id && model.archive.sha256 == *sha256),
                "{}: a CC-BY-SA claim needs an archive somebody read the terms \
                 for. Copying an attribution block does not make its licence \
                 true of different bytes — Commercial & OEM weights need their \
                 own terms recorded. Add the digest above once it is checked.",
                model.id
            );
            assert_eq!(
                a.license.name, COMMUNITY_LICENSE_NAME,
                "{}: use the canonical CC-BY-SA-4.0 name",
                model.id
            );
            // `render_attribution` writes "The full text of the {name} is at
            // {url}", so this URL has to be somewhere that text actually is. It
            // pointed at the Hugging Face page until §197, which made that
            // sentence false; `sourceUrl` is where provenance belongs.
            assert_eq!(
                a.license.url, COMMUNITY_LICENSE_URL,
                "{}: the licence URL must reach the licence text",
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
