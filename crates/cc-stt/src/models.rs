//! The recognisers this build knows how to load.
//!
//! ---------------------------------------------------------------------------
//! WHY A TABLE IN THE SOURCE AND NOT A MANIFEST
//! ---------------------------------------------------------------------------
//! Upstream ships no manifest. A sherpa release tarball is graphs, a token
//! table, and nothing that says what language the model serves or how it should
//! be decoded — so that metadata cannot be discovered, it can only be
//! authored. The only question is where.
//!
//! It is authored here, in Rust, because every value in it is either a
//! measurement this repository took or a claim this repository is making. A
//! JSON or TOML companion beside the weights would buy a schema to version, a
//! parse to fail, and a file read on the path that starts a take — in exchange
//! for letting somebody edit a benchmarked constant without going near the
//! benchmark that produced it. `ATTRIBUTION.md` sits in the model directory
//! because Apache-2.0 requires the notice to travel with the weights; that is a
//! legal obligation, not a precedent for configuration.
//!
//! ---------------------------------------------------------------------------
//! WHAT BELONGS IN AN ENTRY
//! ---------------------------------------------------------------------------
//! Facts about the MODEL. Not facts about the machine (threads, execution
//! provider, beam width — those live in `LocalSttConfig::new`), and not facts
//! about the user (which model they picked — that is a setting).
//!
//! The catalogue lives in this crate rather than in the app because both the
//! app and `cc-bench` need the same answers, and `cc-bench` is in a workspace
//! that deliberately builds without Tauri. Splitting the tuning from the
//! resource directory into two tables keyed by the same id would only give
//! them somewhere to disagree.

use crate::local::LocalModelTuning;

/// One recogniser this build can load.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BundledModel {
    /// Stable identifier. This is what a settings document persists and what a
    /// diagnostics bundle reports, so it outlives the build that wrote it and
    /// must never be reused to mean a different model.
    pub id: &'static str,
    /// Where the weights live, relative to the host application's resource
    /// root.
    ///
    /// Inert data as far as this crate is concerned — it holds no opinion about
    /// resource roots and never resolves this itself. It lives here anyway so
    /// that "which model" and "where is it" cannot drift apart.
    pub resource_dir: &'static str,
    /// The primary language subtags this model transcribes, lowercase.
    ///
    /// Primary subtags rather than full tags, because a model that serves
    /// English serves `en-US` and `en-GB` alike and enumerating locales would
    /// be inventing distinctions the recogniser does not make.
    pub languages: &'static [&'static str],
    /// The tag to fall back to when a persisted language is one this model
    /// cannot serve.
    pub default_language: &'static str,
    /// How this model was measured. See [`LocalModelTuning`].
    pub tuning: LocalModelTuning,
}

impl BundledModel {
    /// Whether this model transcribes the given BCP-47 tag.
    ///
    /// Compares the PRIMARY SUBTAG only — the part before the first `-`. This
    /// used to be a `starts_with("en")` against the whole tag, which is a
    /// different and wrong test: it accepts `enochian` and it cannot express
    /// "serves Chinese as well" at all.
    pub fn serves_language(&self, tag: &str) -> bool {
        let primary = tag
            .trim()
            .split('-')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        !primary.is_empty() && self.languages.contains(&primary.as_str())
    }
}

/// The X-ASR streaming Zipformer transducer the app ships today.
///
/// Bilingual, and worth stating plainly because the code claimed otherwise for
/// a long time: the bundle is
/// `sherpa-onnx-x-asr-480ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05`
/// and roughly 4000 of its 5000 tokens are CJK. Every comment that called it
/// English-only was describing the model before it, and a language setting was
/// being discarded on the strength of that description.
const X_ASR_480MS: BundledModel = BundledModel {
    id: "x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05",
    resource_dir: "models/x-asr-480ms",
    languages: &["en", "zh"],
    default_language: "en-US",
    tuning: LocalModelTuning {
        // Upstream's documented defaults for this model. rule2 at 1.2 s is
        // close to Inworld's measured end-of-turn behaviour, which keeps
        // utterance granularity comparable between the two recognisers.
        rule1_min_trailing_silence: 2.4,
        rule2_min_trailing_silence: 1.2,
        rule3_min_utterance_length: 20.0,
        // Swept on this model specifically, not inherited: within5 92.74 → 94.03
        // and freeze 3.33% at 3.0, against a WER that gets steadily worse.
        // The table behind that trade is on `LocalSttConfig::blank_penalty`.
        blank_penalty: 3.0,
        prime_ms: 0,
    },
};

/// Every recogniser this build ships, the default first.
const BUNDLED: &[BundledModel] = &[X_ASR_480MS];

/// Every recogniser this build ships.
pub fn bundled_models() -> &'static [BundledModel] {
    BUNDLED
}

/// The recogniser used when nothing has chosen one.
pub fn default_model() -> &'static BundledModel {
    // Indexing rather than `first().unwrap()`: the table is a compile-time
    // constant, so an empty one should fail to build rather than at a take.
    &BUNDLED[0]
}

/// The recogniser with this id, if this build has one.
///
/// `None` is the honest answer for a settings document written by a build that
/// shipped something else — see the migration in the app's settings module.
pub fn model_by_id(id: &str) -> Option<&'static BundledModel> {
    BUNDLED.iter().find(|model| model.id == id.trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The number that made the first lock two seconds faster.
    ///
    /// Guarded because losing it is silent: a recogniser tuned back to 0.0 still
    /// transcribes, still passes every other test, and simply follows worse —
    /// which is exactly how a whole benchmark corpus was once captured with the
    /// knob off.
    #[test]
    fn the_shipping_model_keeps_the_blank_penalty_it_was_swept_to() {
        assert_eq!(default_model().tuning.blank_penalty, 3.0);
    }

    /// sherpa's own defaults for all three endpoint rules are zero, which
    /// DISABLES them rather than applying the documented values, so a model
    /// that leaves any at zero has silently turned off endpointing.
    #[test]
    fn every_model_sets_its_endpoint_rules_rather_than_leaving_sherpas_zeroes() {
        for model in bundled_models() {
            let tuning = model.tuning;
            assert!(tuning.rule1_min_trailing_silence > 0.0, "{}", model.id);
            assert!(tuning.rule2_min_trailing_silence > 0.0, "{}", model.id);
            assert!(tuning.rule3_min_utterance_length > 0.0, "{}", model.id);
        }
    }

    /// Ids are persisted in settings and reported in diagnostics, and resource
    /// directories decide which weights get loaded. Either colliding would make
    /// a lookup answer for the wrong model.
    #[test]
    fn ids_and_resource_directories_are_unique() {
        for (index, model) in bundled_models().iter().enumerate() {
            for other in &bundled_models()[index + 1..] {
                assert_ne!(model.id, other.id);
                assert_ne!(model.resource_dir, other.resource_dir);
            }
        }
    }

    #[test]
    fn a_model_serves_its_own_default_language() {
        for model in bundled_models() {
            assert!(
                model.serves_language(model.default_language),
                "{} cannot serve the language it falls back to",
                model.id
            );
            assert!(!model.languages.is_empty(), "{}", model.id);
        }
    }

    /// The shipped model is bilingual. A persisted `zh-CN` is a setting it can
    /// honour, and the code used to throw it away.
    #[test]
    fn the_shipping_model_serves_english_and_chinese() {
        let model = default_model();
        for served in ["en", "en-US", "en-GB", "EN-us", "zh", "zh-CN", "zh-Hans-CN"] {
            assert!(model.serves_language(served), "{served} must be served");
        }
        for unserved in ["fr-FR", "es-ES", "de-DE", "pt-BR", ""] {
            assert!(!model.serves_language(unserved), "{unserved} must not be");
        }
    }

    /// A prefix match on the whole tag accepts languages that merely start with
    /// the same letters. `enochian` is not English, and the old test could not
    /// tell.
    #[test]
    fn language_matching_uses_the_primary_subtag_not_a_prefix() {
        let model = default_model();
        assert!(!model.serves_language("enochian"));
        assert!(!model.serves_language("zhuang"));
        assert!(model.serves_language("en-Latn-US"));
    }

    #[test]
    fn an_unknown_id_is_not_resolved_to_something_else() {
        assert!(model_by_id("inworld/inworld-stt-1").is_none());
        assert!(model_by_id("").is_none());
        assert_eq!(model_by_id(default_model().id), Some(default_model()));
        // Whitespace a settings document picked up must not hide a known model.
        assert_eq!(
            model_by_id(&format!("  {}  ", default_model().id)),
            Some(default_model())
        );
    }
}
