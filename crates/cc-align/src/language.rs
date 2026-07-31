//! What supporting a language actually requires.
//!
//! The normaliser used to be English in the way water is wet: not by decision,
//! but because nobody had ever written anything else. `FILLERS` was English,
//! `STOPWORDS` was English, `CURRENCY_UNITS` was literally `["dollars",
//! "pounds", "euros"]`, and none of it was reachable from a caller who wanted
//! to say otherwise. A French model behind that engine produces a green test
//! suite and a stage that does not follow.
//!
//! This module is the decision that fixes the shape of the problem. It does
//! three things:
//!
//! 1. Names the languages the engine can normalise ([`AlignmentLanguage`]).
//!    The enum is CLOSED and currently has one variant. A language appears here
//!    when it has been measured, not when a model exists that speaks it.
//! 2. Enumerates every rule in the normaliser whose behaviour is language
//!    specific ([`LanguageRule`]) and records what each one costs if a language
//!    does not supply it ([`RuleDisposition`]).
//! 3. Holds the per-language data itself ([`NormalizationProfile`]), so adding
//!    a language is a matter of filling in a profile rather than hunting
//!    constants through `normalize.rs`.
//!
//! The contract is enforced by a test, not by prose: every `MUST_REPLACE` rule
//! must be supplied by every constructible language, and a new variant cannot
//! reach the shipping list without answering all of them. That is the part
//! worth having — a list of rules in a comment would be true on the day it was
//! written and quietly false a year later.
//!
//! ## What this module deliberately does NOT do
//!
//! It does not decide whether a language is fit to offer a user. Normalising
//! French correctly is necessary and nowhere near sufficient: the recogniser
//! needs its own `blank_penalty` sweep, and the language needs a corpus before
//! there is any Tier B or Tier C number to judge it by. That bar is a
//! measurement, it lives in `cc-bench`, and `bench/README.md` states it in
//! numbers.

/// A language the alignment engine knows how to normalise.
///
/// Closed on purpose, and short on purpose. Adding a variant makes every
/// `match` in this module fail to compile until it has been answered, which is
/// exactly the review that a new language deserves. There is deliberately no
/// `Other(String)` and no fallback from an unrecognised tag to English: a
/// silent fallback is how you ship a French model that normalises with English
/// stopwords, passes every test, and does not follow.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum AlignmentLanguage {
    #[default]
    English,
}

impl AlignmentLanguage {
    /// Every language the engine can currently normalise.
    pub const ALL: &'static [AlignmentLanguage] = &[AlignmentLanguage::English];

    /// The BCP-47 primary subtag, for matching against a settings value or a
    /// recogniser's advertised language.
    pub fn primary_subtag(self) -> &'static str {
        match self {
            AlignmentLanguage::English => "en",
        }
    }

    /// Resolve a BCP-47 tag (`en`, `en-US`, `en-GB`) to a language.
    ///
    /// Returns `None` rather than falling back to English. The caller has to
    /// decide what to do about a language the engine cannot normalise, and the
    /// one answer that is never right is to pretend it is English.
    pub fn from_bcp47(tag: &str) -> Option<Self> {
        let primary = tag.split(['-', '_']).next()?.to_ascii_lowercase();
        AlignmentLanguage::ALL
            .iter()
            .copied()
            .find(|lang| lang.primary_subtag() == primary)
    }

    /// The normalisation data for this language.
    pub fn profile(self) -> &'static NormalizationProfile {
        match self {
            AlignmentLanguage::English => &ENGLISH,
        }
    }
}

/// A rule in the normaliser whose correct behaviour depends on the language.
///
/// This list is the answer to "which of the English word lists have to be
/// replaced per language, and which can be left empty without hurting" — with
/// the correction that two of them are not word lists at all, and that leaving
/// them alone is not harmless.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LanguageRule {
    /// Lowercasing, punctuation stripping, whitespace and hyphen segmentation.
    Segmentation,
    /// Transcript noises that are free to skip.
    Fillers,
    /// Function words that carry little locating power.
    Stopwords,
    /// The last-resort sounds-alike relation for rare, meaty words.
    Phonetics,
    /// `&` read aloud as a word.
    Ampersand,
    /// Which character groups digits and which one is the decimal point.
    DecimalSyntax,
    /// `$`/`£`/`€` rewritten as the word that is spoken.
    CurrencySymbols,
    /// Where the currency word lands relative to a scale word.
    CurrencyOrder,
    /// `%` rewritten as the word(s) that are spoken.
    Percent,
    /// `24kHz` → `24 kilohertz`.
    UnitWords,
    /// `can't` → `can not`.
    Contractions,
    /// `forty two` → `42`.
    SpelledNumbers,
    /// `2nd` → `second`.
    Ordinals,
}

/// What it costs a language to leave a rule unanswered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuleDisposition {
    /// Correct unchanged for every language in [`AlignmentLanguage::ALL`].
    ///
    /// Whitespace segmentation is the reason the first supported set is four
    /// space-delimited Latin-script languages: a CJK model would need a real
    /// tokenizer here and is a much larger piece of work than a word list.
    Shared,
    /// A shipping profile MUST supply this. Leaving it English is not inert —
    /// it produces atoms that are actively wrong, or it silently changes the
    /// cost model the aligner runs on.
    MustReplace,
    /// May be left empty. The rule stops firing; nothing it would have matched
    /// becomes a mismatch, because both sides stop firing together.
    SafeEmpty,
    /// May be left empty and fails safe — no false merges — but the equivalence
    /// it was buying is gone. Whether that matters is a question for the
    /// language's own corpus, not one that can be answered here.
    InertRecallGap,
}

impl LanguageRule {
    pub const ALL: &'static [LanguageRule] = &[
        LanguageRule::Segmentation,
        LanguageRule::Fillers,
        LanguageRule::Stopwords,
        LanguageRule::Phonetics,
        LanguageRule::Ampersand,
        LanguageRule::DecimalSyntax,
        LanguageRule::CurrencySymbols,
        LanguageRule::CurrencyOrder,
        LanguageRule::Percent,
        LanguageRule::UnitWords,
        LanguageRule::Contractions,
        LanguageRule::SpelledNumbers,
        LanguageRule::Ordinals,
    ];

    /// What happens to a language that does not answer this rule.
    ///
    /// The three `MustReplace` entries that are NOT word lists are the ones
    /// worth reading twice, because the issue that prompted this module did not
    /// name them:
    ///
    /// * [`LanguageRule::DecimalSyntax`] — English groups with `,` and points
    ///   with `.`; French, German and Spanish do the opposite. Left alone, a
    ///   German script's `12,5` normalises to the atom `125`. That is not a
    ///   missed match, it is the wrong number.
    /// * [`LanguageRule::UnitWords`] — the abbreviations are shared but the
    ///   spelled forms are English words. Left alone, a French script gets the
    ///   atom `milliseconds`, which the reader will never say.
    /// * [`LanguageRule::Ampersand`] — `&` is rewritten to the spoken word, and
    ///   that word is `et`, `und` or `y`.
    ///
    /// [`LanguageRule::Stopwords`] is also stronger than it looks. An empty
    /// list does not merely lose a little cheapness: stopword-ness decides atom
    /// weight, whether an atom can be a global anchor, and what counts as
    /// content evidence for the observe/confirm/jump gates. A French take whose
    /// `le`/`la`/`de` all carry full locating weight is a different engine, and
    /// false anchoring on a frequent function word is exactly the failure this
    /// costs.
    pub fn disposition(self) -> RuleDisposition {
        match self {
            LanguageRule::Segmentation => RuleDisposition::Shared,

            LanguageRule::Fillers => RuleDisposition::MustReplace,
            LanguageRule::Stopwords => RuleDisposition::MustReplace,
            LanguageRule::Ampersand => RuleDisposition::MustReplace,
            LanguageRule::DecimalSyntax => RuleDisposition::MustReplace,
            LanguageRule::CurrencySymbols => RuleDisposition::MustReplace,
            LanguageRule::CurrencyOrder => RuleDisposition::MustReplace,
            LanguageRule::Percent => RuleDisposition::MustReplace,
            LanguageRule::UnitWords => RuleDisposition::MustReplace,

            // The relation is a last resort carrying a low weight, and it is
            // already restricted to rare words. Switching it off costs recall
            // on mangled names and nothing else — both sides stop producing
            // keys together, so nothing becomes a mismatch.
            LanguageRule::Phonetics => RuleDisposition::SafeEmpty,

            // These three fail safe because they are EQUIVALENCE rules: they
            // exist so a script that writes one surface matches a recogniser
            // that writes another. Switched off, both sides keep their own
            // surface and still match each other. What is lost is the case
            // where the two sides disagree.
            LanguageRule::Contractions => RuleDisposition::InertRecallGap,
            LanguageRule::SpelledNumbers => RuleDisposition::InertRecallGap,
            LanguageRule::Ordinals => RuleDisposition::InertRecallGap,
        }
    }
}

/// How a language says an amount that carries a scale word.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CurrencyOrder {
    /// `$2.4 million` is said "two point four million dollars" — the unit
    /// follows the scale word.
    UnitAfterScale,
    /// The unit stays where the symbol was.
    UnitInPlace,
}

/// Whether the sounds-alike relation runs for this language.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PhoneticPolicy {
    /// The English consonant skeleton in [`crate::normalize::phonetic_key`].
    ///
    /// It maps every non-ASCII character to code 0, exactly as it does vowels,
    /// so on accented text it degrades to inert rather than wrong.
    EnglishSkeleton,
    /// No key is produced, so the relation never fires.
    ///
    /// This is the right starting point for a new language, and the reason is
    /// measurement rather than taste. Double Metaphone was tried against the
    /// English skeleton here and measurably LOST (see
    /// [`crate::normalize::phonetic_key`]), so there is no reason to assume a
    /// per-language phonetic algorithm would win either — it has to be shown
    /// on that language's own corpus. Until it is, a relation that fires on
    /// evidence nobody has measured is worse than one that does not fire.
    ///
    /// Folding diacritics before the English skeleton is the obvious cheap
    /// alternative and is deliberately NOT done here. It is not the no-op it
    /// looks like: accented VOWELS already encode identically to unaccented
    /// ones, so folding only moves diacritic CONSONANTS and the first-character
    /// slot — and the English corpus contains `Przemysław`, `Joaquín`,
    /// `Dagný Þorvaldsdóttir` and `Reykjavík`, whose keys would change. That is
    /// an English behaviour change bought for a non-English benefit nobody has
    /// measured yet.
    Disabled,
}

/// Everything `normalize.rs` needs to know about a language.
///
/// One struct rather than scattered constants, for the same reason
/// [`crate::config::AlignmentConfig`] is one struct: a thing that is swept, or
/// reviewed, or diffed against another language, should be in one place where
/// somebody can see all of it at once.
#[derive(Debug)]
pub struct NormalizationProfile {
    pub language: AlignmentLanguage,

    /// Transcript insertions that are cheap to skip and carry zero positional
    /// evidence. Keep it short: a word that is also a real script word must NOT
    /// be here.
    pub fillers: &'static [&'static str],

    /// Function words that carry little locating power. They still align — an
    /// ordered run of them is real evidence — but mismatching one is cheap and
    /// one can never be a global anchor.
    pub stopwords: &'static [&'static str],

    pub phonetics: PhoneticPolicy,

    /// The word `&` is read aloud as, or `None` to leave the symbol alone.
    pub ampersand: Option<&'static str>,

    /// The character that separates a whole part from a fractional one.
    pub decimal_separator: char,
    /// The character that groups thousands, which normalisation discards.
    pub group_separator: char,

    /// Currency symbol → the word that is spoken for it.
    pub currency_symbols: &'static [(char, &'static str)],
    /// The spoken currency words, for the reordering rule.
    pub currency_units: &'static [&'static str],
    pub currency_order: CurrencyOrder,

    /// What `%` is read aloud as. More than one atom is normal outside English
    /// ("pour cent", "por ciento").
    pub percent: &'static [&'static str],

    /// Unit abbreviation → the word actually said. The abbreviations are shared
    /// across these languages; the spelled forms are not.
    pub unit_words: &'static [(&'static str, &'static str)],

    /// Whether the English contraction table runs.
    pub contractions: bool,
    /// Whether the English spelled-number grammar runs.
    ///
    /// This is a switch rather than a word list because the grammar itself is
    /// language specific: German says "zweiundvierzig" — units before tens —
    /// which is not a translation of the English rule but a different one.
    pub spelled_numbers: bool,
    /// Whether English ordinal digits (`2nd` → `second`) are rewritten.
    pub ordinals: bool,
}

impl NormalizationProfile {
    /// Does this profile answer `rule`?
    ///
    /// The contract test uses this to refuse a language that leaves a
    /// `MustReplace` rule empty. It reports on the DATA, not on intent, so a
    /// profile cannot satisfy the contract by declaring itself finished.
    pub fn supplies(&self, rule: LanguageRule) -> bool {
        match rule {
            // Not per-language data: every language in `ALL` is space
            // delimited, which is what the shared segmentation rule asserts.
            LanguageRule::Segmentation => true,

            LanguageRule::Fillers => !self.fillers.is_empty(),
            LanguageRule::Stopwords => !self.stopwords.is_empty(),
            LanguageRule::Ampersand => self.ampersand.is_some(),
            // A language that groups and points with the same character has
            // not thought about it.
            LanguageRule::DecimalSyntax => self.decimal_separator != self.group_separator,
            LanguageRule::CurrencySymbols => !self.currency_symbols.is_empty(),
            LanguageRule::CurrencyOrder => !self.currency_units.is_empty(),
            LanguageRule::Percent => !self.percent.is_empty(),
            LanguageRule::UnitWords => !self.unit_words.is_empty(),

            LanguageRule::Phonetics => self.phonetics != PhoneticPolicy::Disabled,
            LanguageRule::Contractions => self.contractions,
            LanguageRule::SpelledNumbers => self.spelled_numbers,
            LanguageRule::Ordinals => self.ordinals,
        }
    }

    pub fn is_filler(&self, atom: &str) -> bool {
        self.fillers.contains(&atom)
    }

    pub fn is_stopword(&self, atom: &str) -> bool {
        self.stopwords.contains(&atom)
    }
}

/// English, exactly as `normalize.rs` has always behaved.
///
/// Every value here was moved from a `const` in that file without editing it.
/// The English rows of the benchmark are the evidence that the move was clean,
/// which is why this profile is worth reading as a record rather than a draft.
static ENGLISH: NormalizationProfile = NormalizationProfile {
    language: AlignmentLanguage::English,

    fillers: &[
        "um", "uh", "uhm", "erm", "er", "ah", "hm", "hmm", "mm", "mhm",
    ],

    stopwords: &[
        "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "is",
        "are", "was", "were", "be", "been", "being", "it", "that", "this", "these",
        "those", "i", "you", "we", "they", "he", "she", "my", "your", "our",
        "their", "his", "her", "its", "as", "by", "for", "with", "from", "so",
        "do", "does", "did", "have", "has", "had", "will", "would", "can",
        "could", "should", "shall", "may", "might", "not", "no", "yes", "if",
        "then", "than", "there", "here", "what", "when", "where", "who", "how",
        "why", "all", "any", "some", "just", "also", "very", "now", "well", "oh",
        "okay", "up", "down", "out", "about", "into", "over", "us", "them", "me",
    ],

    phonetics: PhoneticPolicy::EnglishSkeleton,

    ampersand: Some("and"),

    decimal_separator: '.',
    group_separator: ',',

    currency_symbols: &[('$', "dollars"), ('£', "pounds"), ('€', "euros")],
    currency_units: &["dollars", "pounds", "euros"],
    currency_order: CurrencyOrder::UnitAfterScale,

    percent: &["percent"],

    unit_words: &[
        ("hz", "hertz"),
        ("khz", "kilohertz"),
        ("mhz", "megahertz"),
        ("ghz", "gigahertz"),
        ("ms", "milliseconds"),
        ("kb", "kilobytes"),
        ("mb", "megabytes"),
        ("gb", "gigabytes"),
        ("tb", "terabytes"),
        ("km", "kilometres"),
        ("kg", "kilograms"),
        ("cm", "centimetres"),
        ("mm", "millimetres"),
        ("fps", "frames"),
    ],

    contractions: true,
    spelled_numbers: true,
    ordinals: true,
};

#[cfg(test)]
mod tests {
    use super::*;

    /// The contract this module exists to enforce.
    ///
    /// A language that reaches [`AlignmentLanguage::ALL`] has answered every
    /// rule that produces wrong atoms when left English. This is the check that
    /// makes the rule table load-bearing instead of decorative — without it,
    /// #157 could add French with an empty `unit_words` and ship a script whose
    /// figures read out in English.
    #[test]
    fn every_language_answers_every_must_replace_rule() {
        for lang in AlignmentLanguage::ALL {
            let profile = lang.profile();
            for rule in LanguageRule::ALL {
                if rule.disposition() == RuleDisposition::MustReplace {
                    assert!(
                        profile.supplies(*rule),
                        "{lang:?} leaves {rule:?} unanswered, and that rule is \
                         MUST_REPLACE: an unanswered one does not fail quietly, \
                         it produces atoms the reader never says"
                    );
                }
            }
        }
    }

    /// A profile has to be reachable from its own enum variant, or the data and
    /// the identity can drift apart.
    #[test]
    fn every_profile_names_the_language_that_selects_it() {
        for lang in AlignmentLanguage::ALL {
            assert_eq!(lang.profile().language, *lang);
        }
    }

    /// `ALL` is what the contract test iterates. A variant missing from it
    /// would skip every check in this file.
    #[test]
    fn all_lists_every_variant() {
        // Exhaustive match: adding a variant breaks this until `ALL` is
        // updated to match.
        for lang in AlignmentLanguage::ALL {
            match lang {
                AlignmentLanguage::English => {}
            }
        }
        assert_eq!(AlignmentLanguage::ALL.len(), 1, "update this count with ALL");
    }

    #[test]
    fn bcp47_resolves_english_regions_and_refuses_everything_else() {
        for tag in ["en", "en-US", "en-GB", "EN-us", "en_US"] {
            assert_eq!(
                AlignmentLanguage::from_bcp47(tag),
                Some(AlignmentLanguage::English),
                "{tag} is English"
            );
        }
        // The important half. A tag the engine cannot normalise resolves to
        // nothing at all — never to English.
        for tag in ["fr", "fr-FR", "de", "de-DE", "es", "es-ES", "ja", ""] {
            assert_eq!(
                AlignmentLanguage::from_bcp47(tag),
                None,
                "{tag} must not resolve while it has no measured profile"
            );
        }
    }

    /// Every rule is classified. A rule added to `ALL` without a disposition
    /// cannot compile, but one added to the normaliser and never listed here
    /// would simply be forgotten — which this cannot catch and the module doc
    /// says so.
    #[test]
    fn every_rule_has_a_disposition() {
        for rule in LanguageRule::ALL {
            let _ = rule.disposition();
        }
        assert_eq!(
            LanguageRule::ALL.len(),
            13,
            "a rule was added or removed; update the count and bench/README.md"
        );
    }

    /// English is the baseline the benchmark numbers were measured against, so
    /// it must answer everything — including the rules another language is
    /// allowed to leave empty.
    #[test]
    fn english_answers_every_rule_including_the_optional_ones() {
        let profile = AlignmentLanguage::English.profile();
        for rule in LanguageRule::ALL {
            assert!(
                profile.supplies(*rule),
                "English must supply {rule:?} — it is the measured baseline"
            );
        }
    }
}
