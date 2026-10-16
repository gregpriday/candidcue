//! Which languages this build can actually offer, and what picking one costs.
//!
//! ---------------------------------------------------------------------------
//! THREE LISTS, ONE ANSWER
//! ---------------------------------------------------------------------------
//! "Which languages can CandidCue follow?" is not a question any single table
//! in this repository answers, and the three that contribute all mean different
//! things:
//!
//!   * `models/catalogue.json` — everything that can be DOWNLOADED. One model
//!     today. An entry here is a promise about bytes and a licence, not about
//!     following.
//!   * `cc_stt::models::BUNDLED` — everything this build can DECODE with,
//!     because tuning is measured rather than discovered. One model today.
//!   * `cc_align::AlignmentLanguage::ALL` — everything the engine can
//!     NORMALISE. Four today: English, French, German and Spanish. A
//!     normalisation profile is a CAPABILITY of the engine and nothing more —
//!     it is not a claim that the product follows that language, because
//!     following also needs a model this build is tuned to decode with.
//!     `language.rs` is emphatic that a silent fallback to English here is how
//!     you ship a French model that passes every test and does not follow.
//!
//! A language is offerable only where all three agree, and the conjunction is
//! computed HERE so that no screen has to restate it. Today it selects exactly
//! one pair — `x-asr-480ms` × `en`, so CandidCue 1.0 follows English and
//! nothing else. Chinese fails the third list even though the recogniser
//! transcribes it; French, German and Spanish pass it — all three have
//! profiles — and fail the second, because no recogniser this build can load
//! speaks them and no measurement says it could decode with one.
//!
//! ---------------------------------------------------------------------------
//! WHY UNOFFERABLE LANGUAGES ARE NOT RETURNED AT ALL
//! ---------------------------------------------------------------------------
//! §153 is explicit: a language we cannot follow well should not be in the list
//! at all. Not greyed out, not behind a "coming soon" badge — absent. A picker
//! that lists French with a size beside it has already made a promise, and the
//! bar French has to clear is a measurement in `cc-bench` that has not been
//! taken yet (§156, §157).
//!
//! That leaves one honest gap, which [`SpeechLanguageOptions::removable`]
//! closes: a model already ON DISK whose language this build no longer offers
//! still has to be removable, or a downgrade would strand a few hundred
//! megabytes with no way to reclaim them.
//!
//! ---------------------------------------------------------------------------
//! SHORT IDS AND LONG IDS
//! ---------------------------------------------------------------------------
//! There are two identifiers for a model and they are not interchangeable:
//!
//!   * the CATALOGUE id (`x-asr-480ms`) — short, also the install directory,
//!     and what every `SpeechModelStatus` and every install command carries;
//!   * the RECOGNISER id (`x-asr-480ms-streaming-zipformer-punct-int8-…`) —
//!     long, `BundledModel::id`, and what `audio.transcriptionModel` persists.
//!
//! `ModelEntry::model_name` is the join between them. Confusing the two is the
//! easiest mistake to make in this module, so the DTO names them apart and
//! `the_two_model_identifiers_are_not_interchangeable` pins it.

use serde::Serialize;

use super::catalogue::{catalogue, Attribution, ModelEntry};
use super::model_manager::{loadable_model, SpeechModelManager, SpeechModelStatus};
use super::model_download;
use crate::settings::AppSettings;

/// Everything the language picker paints, in one reply.
///
/// One command rather than "list the languages, then ask about each model":
/// the screen cannot render a single row without both halves, and issuing N+1
/// calls would give the sizes and the install state separate chances to be
/// stale relative to each other.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechLanguageOptions {
    /// What settings currently says, whether or not it is still offerable.
    pub active: SpeechActiveLanguage,
    /// Whether a take is running, so activation is refused right now.
    ///
    /// Carried rather than left to the frontend to work out, because the
    /// authority is Rust's and a screen that decided this for itself would be
    /// guessing at a state it does not own.
    pub change_blocked: bool,
    /// The languages this build can follow. Offerable ones ONLY.
    pub languages: Vec<SpeechLanguageOption>,
    /// Models on disk that back none of the above — a previous language, or one
    /// a downgrade stopped offering. Present so their disk can be reclaimed.
    pub removable: Vec<SpeechModelStatus>,
}

/// The persisted choice.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechActiveLanguage {
    /// The BCP-47 tag as persisted, e.g. `en-US`.
    pub language_tag: String,
    /// Its primary subtag, e.g. `en`. What rows are matched on.
    pub primary_subtag: String,
    /// The CATALOGUE id of the model serving it, when it has a catalogue entry.
    ///
    /// `None` is reachable: `cc_stt` may know a recogniser the catalogue does
    /// not list, and a settings document written by another build may name one
    /// this build resolves to a model with no entry.
    pub model_id: Option<String>,
    /// The RECOGNISER id, as persisted in `audio.transcriptionModel`.
    pub recognizer_id: String,
}

/// One language the user may choose, and what choosing it involves.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechLanguageOption {
    /// The tag that gets persisted if this is activated, e.g. `en-US`.
    ///
    /// The recogniser's own `default_language` when its primary subtag matches,
    /// so activating English persists `en-US` rather than a bare `en` — the
    /// same value a fresh install starts with.
    pub language_tag: String,
    pub primary_subtag: String,
    /// Catalogue id. Joins to every install command and to `status.modelId`.
    pub model_id: String,
    /// The recogniser id this option would persist.
    pub recognizer_id: String,
    /// Whether this is the language settings currently names.
    pub active: bool,
    /// Sizes, install phase, progress and error — the existing shape, unchanged
    /// so that a progress event and this reply cannot describe a model
    /// differently.
    pub status: SpeechModelStatus,
    /// Where the bytes come from, in the order they are tried.
    pub origins: Vec<SpeechDownloadOrigin>,
    /// The licence obligation this model carries. Informational: §153 is
    /// explicit that this is the app's obligation to display, never a consent
    /// gate on the download.
    pub attribution: SpeechModelAttribution,
}

/// One host the archive may be fetched from.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechDownloadOrigin {
    pub kind: SpeechDownloadOriginKind,
    /// Host only. The full URL carries a digest path that means nothing to a
    /// reader and would make the line unreadable.
    pub host: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SpeechDownloadOriginKind {
    /// A mirror we control, tried first. Absent while none is configured.
    Mirror,
    /// Where the model actually comes from.
    Upstream,
}

/// The catalogue's attribution, minus the integrity fields.
///
/// A separate type rather than reusing `catalogue::Attribution` because that
/// one is a `Deserialize` of a file on disk and this is a `Serialize` across
/// IPC; giving one struct both roles would let a change to the catalogue's file
/// format silently change the IPC contract.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechModelAttribution {
    pub title: String,
    pub author: String,
    pub source_url: String,
    pub distributed_via: Option<String>,
    pub license: SpeechModelLicense,
    pub license_note: Option<String>,
    pub modified: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechModelLicense {
    pub id: String,
    pub name: String,
    pub url: String,
}

impl From<&Attribution> for SpeechModelAttribution {
    fn from(a: &Attribution) -> Self {
        Self {
            title: a.title.clone(),
            author: a.author.clone(),
            source_url: a.source_url.clone(),
            distributed_via: a.distributed_via.clone(),
            license: SpeechModelLicense {
                id: a.license.id.clone(),
                name: a.license.name.clone(),
                url: a.license.url.clone(),
            },
            license_note: a.license_note.clone(),
            modified: a.modified,
        }
    }
}

/// A language this build can follow, and the model that would do it.
///
/// The tuple every offer is derived from. Returned in catalogue order, which is
/// stable because the catalogue is a committed file.
pub struct OfferableLanguage {
    pub entry: &'static ModelEntry,
    pub model: &'static cc_stt::models::BundledModel,
    /// The tag to persist. See [`SpeechLanguageOption::language_tag`].
    pub language_tag: String,
    /// The primary subtag, canonicalised by `cc_align`.
    pub primary_subtag: &'static str,
}

/// Every (language, model) pair all three tables agree on.
///
/// The conjunction this whole module exists for:
///
///   1. the catalogue lists the model, so there are bytes to fetch and a
///      licence to carry;
///   2. `cc_stt` has a measured profile for it, so it can be decoded;
///   3. `cc_align` has a normalisation profile for the language AND the
///      recogniser transcribes it, so what comes back can be matched against a
///      script.
///
/// Test (2) is `loadable_model`, the same function `SpeechModelStatus.supported`
/// reports, so an offer and a status cannot disagree about support.
///
/// AT MOST ONE OFFER PER LANGUAGE. Two catalogue entries could serve the same
/// language — a second English model, or one entry listing both `en` and a
/// regional variant — and the picker would then show the same language twice
/// while `offer_for_tag` could only ever activate one of them. Picking a row
/// that silently activates a different model is worse than not offering the
/// duplicate, so the FIRST qualifying entry in catalogue order wins. Catalogue
/// order is a committed file, which makes that a deliberate preference rather
/// than an accident of iteration.
pub fn offerable_languages() -> Vec<OfferableLanguage> {
    let mut offers: Vec<OfferableLanguage> = Vec::new();
    for entry in &catalogue().models {
        // (2) Can this build decode with it at all?
        let Some(model) = loadable_model(entry) else {
            continue;
        };
        for language in &entry.languages {
            // (3a) Does the engine know how to normalise this language? Asked
            // of `cc_align`'s own table rather than a literal list here, so a
            // language that earns a profile becomes offerable without anybody
            // remembering to edit this file.
            let Some(alignment) = cc_align::AlignmentLanguage::from_bcp47(language) else {
                continue;
            };
            let primary_subtag = alignment.primary_subtag();
            // (3b) …and does THIS recogniser actually transcribe it? The
            // catalogue's `languages` and the model's are two claims about the
            // same thing and are allowed to disagree; the recogniser's is the
            // one that decides what comes back.
            if !model.serves_language(primary_subtag) {
                continue;
            }
            // One row per language — see the note on this function.
            if offers
                .iter()
                .any(|existing| existing.primary_subtag == primary_subtag)
            {
                continue;
            }
            // Persist the recogniser's own default tag when it is this
            // language — `en-US` rather than a bare `en`, matching what a fresh
            // install writes — and the bare subtag otherwise.
            let language_tag = if model
                .serves_language(model.default_language)
                && cc_align::AlignmentLanguage::from_bcp47(model.default_language)
                    .is_some_and(|l| l.primary_subtag() == primary_subtag)
            {
                model.default_language.to_string()
            } else {
                primary_subtag.to_string()
            };
            offers.push(OfferableLanguage {
                entry,
                model,
                language_tag,
                primary_subtag,
            });
        }
    }
    offers
}

/// The offer matching a requested tag, by primary subtag.
///
/// Matched on the SUBTAG rather than the whole string so that a client asking
/// for `en-GB` gets English rather than nothing. What is persisted is still the
/// offer's own canonical tag, never the caller's spelling — otherwise the
/// picker would show a language the settings document did not name.
pub fn offer_for_tag(tag: &str) -> Option<OfferableLanguage> {
    let requested = cc_align::AlignmentLanguage::from_bcp47(tag.trim())?;
    offerable_languages()
        .into_iter()
        .find(|offer| offer.primary_subtag == requested.primary_subtag())
}

/// Assemble everything the picker paints.
pub fn build<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    models: &SpeechModelManager,
    settings: &AppSettings,
    change_blocked: bool,
) -> SpeechLanguageOptions {
    let recognizer_id = settings.audio.transcription_model.clone();
    let active_subtag = cc_align::AlignmentLanguage::from_bcp47(settings.audio.language.trim())
        .map(|language| language.primary_subtag().to_string())
        // A tag the engine cannot resolve is reported as it was persisted
        // rather than repaired to something it is not. `migrate_in_place`
        // already repairs on read; inventing a subtag here would hide a
        // document that somehow escaped it.
        .unwrap_or_else(|| settings.audio.language.trim().to_ascii_lowercase());

    let languages: Vec<SpeechLanguageOption> = offerable_languages()
        .into_iter()
        .map(|offer| {
            let status = models.status(app, offer.entry);
            SpeechLanguageOption {
                // Active when BOTH halves match. The subtag alone would call a
                // row active while a different recogniser was persisted for it,
                // which is precisely the disagreement §153 is about.
                active: offer.primary_subtag == active_subtag && offer.model.id == recognizer_id,
                language_tag: offer.language_tag,
                primary_subtag: offer.primary_subtag.to_string(),
                model_id: offer.entry.id.clone(),
                recognizer_id: offer.model.id.to_string(),
                origins: origins_for(offer.entry),
                attribution: SpeechModelAttribution::from(&offer.entry.attribution),
                status,
            }
        })
        .collect();

    // Installed models that back no offer. Only ones actually on disk, and only
    // ones this app downloaded — a bundled or overridden model is not ours to
    // remove, which `canRemove` in the frontend already encodes.
    //
    // Scoped to THIS BUILD'S CATALOGUE, which leaves one gap open: a model
    // installed by a newer build and then downgraded away from is not
    // enumerated here, and `entry_for` refuses to delete an id the catalogue
    // does not know — so its disk is stranded until the user upgrades again.
    // Closing that needs an app-owned on-disk inventory rather than a catalogue
    // walk, and a deletion path that does not resolve through `entry_for`;
    // widening `entry_for` instead is not an option, since refusing unknown ids
    // is exactly what keeps a raw string off the IPC boundary away from the
    // filesystem. The case this DOES cover is the ordinary one: switching
    // language leaves the previous model listed and removable.
    let removable: Vec<SpeechModelStatus> = catalogue()
        .models
        .iter()
        .filter(|entry| !languages.iter().any(|option| option.model_id == entry.id))
        .map(|entry| models.status(app, entry))
        // `source` rather than `installed`: a download damaged after install
        // (#258) is not installed, and is still disk the user can reclaim.
        // `source` is set for exactly the usable copies and that one case.
        .filter(|status| status.source.is_some())
        .collect();

    let active_model_id = languages
        .iter()
        .find(|option| option.active)
        .map(|option| option.model_id.clone())
        .or_else(|| {
            // Not offerable, but the model may still be catalogued — a state a
            // downgrade can produce, and the one the `removable` list exists
            // for. Reported so the screen can name what is selected rather than
            // showing a blank.
            catalogue()
                .models
                .iter()
                .find(|entry| entry.model_name == recognizer_id)
                .map(|entry| entry.id.clone())
        });

    SpeechLanguageOptions {
        active: SpeechActiveLanguage {
            language_tag: settings.audio.language.clone(),
            primary_subtag: active_subtag,
            model_id: active_model_id,
            recognizer_id,
        },
        change_blocked,
        languages,
        removable,
    }
}

/// The hosts the archive is fetched from, in the order they are tried.
///
/// Derived from `archive_urls` — the function the downloader itself uses —
/// rather than restated, so the screen cannot name an origin the download does
/// not actually contact.
fn origins_for(entry: &ModelEntry) -> Vec<SpeechDownloadOrigin> {
    let urls = model_download::archive_urls(catalogue(), entry);
    let last = urls.len().saturating_sub(1);
    urls.iter()
        .enumerate()
        .filter_map(|(index, url)| {
            Some(SpeechDownloadOrigin {
                // `archive_urls` puts the mirror first and upstream last, and
                // pushes upstream unconditionally — so the final entry is
                // always upstream and anything before it is the mirror.
                kind: if index == last {
                    SpeechDownloadOriginKind::Upstream
                } else {
                    SpeechDownloadOriginKind::Mirror
                },
                host: host_of(url)?,
            })
        })
        .collect()
}

/// The host part of a URL, for display.
///
/// `reqwest::Url` rather than splitting on punctuation, which `net.rs` already
/// does for the hop policy. A hand-rolled version got `https://[2001:db8::1]:443/x`
/// wrong — splitting the authority at the first colon reports the host as
/// `[2001` — and a mirror named by an IPv6 literal is a perfectly ordinary URL
/// to put in the catalogue. Getting it wrong would mean telling the user the
/// download comes from somewhere it does not.
///
/// Credentials and the port are deliberately dropped: neither is part of what a
/// reader is being told about where their bytes come from.
fn host_of(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    parsed.host_str().map(|host| host.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The whole point of the module, stated as a test: today exactly one
    /// language is offerable, and it is English on the bundled recogniser.
    ///
    /// This will change when #157 lands profiles for French, German and
    /// Spanish — at which point this test should be UPDATED rather than
    /// deleted, because "which languages does this build claim to follow" is
    /// worth one deliberate edit per language.
    #[test]
    fn only_english_is_offerable_in_this_build() {
        let offers = offerable_languages();
        assert_eq!(
            offers.len(),
            1,
            "expected exactly one offerable language, got {:?}",
            offers
                .iter()
                .map(|o| (&o.entry.id, o.primary_subtag))
                .collect::<Vec<_>>()
        );
        assert_eq!(offers[0].entry.id, "x-asr-480ms");
        assert_eq!(offers[0].primary_subtag, "en");
        assert_eq!(offers[0].language_tag, "en-US");
    }

    /// Chinese fails on the ALIGNMENT half, not the recogniser half. Worth
    /// pinning separately because the two failures look identical from the
    /// picker and have completely different fixes.
    #[test]
    fn chinese_is_transcribable_but_not_followable() {
        let entry = catalogue().get("x-asr-480ms").expect("bundled entry");
        let model = loadable_model(entry).expect("bundled model is loadable");
        assert!(
            model.serves_language("zh"),
            "the shipped recogniser does transcribe Chinese"
        );
        assert!(
            cc_align::AlignmentLanguage::from_bcp47("zh").is_none(),
            "the alignment engine has no Chinese profile"
        );
        assert!(!offerable_languages()
            .iter()
            .any(|offer| offer.primary_subtag == "zh"));
    }

    /// French, German and Spanish fail on the RECOGNISER half: the engine has
    /// profiles for them and no recogniser this build can load speaks them.
    /// §157 is what changes this.
    #[test]
    fn a_normalisable_language_without_a_recogniser_is_not_offerable() {
        for subtag in ["fr", "de", "es"] {
            assert!(
                cc_align::AlignmentLanguage::from_bcp47(subtag).is_some(),
                "{subtag} should normalise — the engine has the profile"
            );
            assert!(
                !offerable_languages()
                    .iter()
                    .any(|offer| offer.primary_subtag == subtag),
                "{subtag} must not be offered while it cannot be followed"
            );
        }
    }

    /// §153: a language we cannot follow must not appear in the list at all.
    /// Not disabled, not annotated — absent.
    #[test]
    fn nothing_unfollowable_reaches_the_offer_list() {
        for offer in offerable_languages() {
            assert!(
                cc_align::AlignmentLanguage::from_bcp47(offer.primary_subtag).is_some(),
                "{} was offered without an alignment profile",
                offer.primary_subtag
            );
            assert!(
                offer.model.serves_language(offer.primary_subtag),
                "{} was offered on a recogniser that does not transcribe it",
                offer.primary_subtag
            );
            assert!(
                loadable_model(offer.entry).is_some(),
                "{} was offered on a model this build cannot load",
                offer.entry.id
            );
        }
    }

    /// The short catalogue id and the long recogniser id are different strings
    /// for different jobs, and swapping them is the easiest bug to write here.
    #[test]
    fn the_two_model_identifiers_are_not_interchangeable() {
        let offer = &offerable_languages()[0];
        assert_ne!(offer.entry.id, offer.model.id);
        // The join, and the only relationship between them.
        assert_eq!(offer.entry.model_name, offer.model.id);
        // What settings persists is the LONG one.
        assert_eq!(
            crate::settings::AudioSettings::default().transcription_model,
            offer.model.id
        );
    }

    /// A client asking for `en-GB` gets English — but what would be persisted
    /// is the offer's own canonical tag, never the caller's spelling.
    #[test]
    fn a_tag_resolves_by_primary_subtag_and_persists_the_canonical_form() {
        for requested in ["en", "en-US", "en-GB", "EN-us", "en-Latn-US", "  en-AU  "] {
            let offer = offer_for_tag(requested)
                .unwrap_or_else(|| panic!("{requested} must resolve to English"));
            assert_eq!(offer.language_tag, "en-US", "requested {requested}");
        }
        for requested in ["zh-CN", "fr-FR", "de-DE", "es-ES", "english", "eng", "", "   "] {
            assert!(
                offer_for_tag(requested).is_none(),
                "{requested} must not resolve to an offer"
            );
        }
    }

    /// The picker names where the bytes come from. With no mirror configured
    /// that is upstream alone, and upstream is always last.
    #[test]
    fn origins_name_the_hosts_the_downloader_actually_uses() {
        let entry = catalogue().get("x-asr-480ms").expect("bundled entry");
        let origins = origins_for(entry);
        assert!(!origins.is_empty());
        assert_eq!(
            origins.last().map(|o| o.kind),
            Some(SpeechDownloadOriginKind::Upstream)
        );
        assert_eq!(origins.last().map(|o| o.host.as_str()), Some("github.com"));
        assert_eq!(
            origins.len(),
            model_download::archive_urls(catalogue(), entry).len()
        );
    }

    #[test]
    fn a_host_is_extracted_without_scheme_credentials_or_port() {
        assert_eq!(host_of("https://github.com/k2-fsa/x.tar.bz2").as_deref(), Some("github.com"));
        assert_eq!(host_of("https://Mirror.Example:8443/sha256/ab/x").as_deref(), Some("mirror.example"));
        assert_eq!(host_of("https://user:pw@cdn.example/x").as_deref(), Some("cdn.example"));
        // The case the hand-rolled parser got wrong: splitting the authority at
        // the first colon reported this host as `[2001`.
        assert_eq!(
            host_of("https://[2001:db8::10]:8443/sha256/ab/x").as_deref(),
            Some("[2001:db8::10]")
        );
        assert_eq!(host_of("https://"), None);
        assert_eq!(host_of("not a url"), None);
    }
}
