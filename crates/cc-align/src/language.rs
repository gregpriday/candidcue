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
//!    The enum is CLOSED. A language appears here when somebody has written and
//!    reviewed a profile for it — which is a claim about NORMALISATION and not
//!    about following quality; see "What this module deliberately does NOT do".
//! 2. Enumerates every rule in the normaliser whose behaviour is language
//!    specific ([`LanguageRule`]) and records what each one costs if a language
//!    does not supply it ([`RuleDisposition`]).
//! 3. Holds the per-language data itself ([`NormalizationProfile`]), so adding
//!    a language is a matter of filling in a profile rather than hunting
//!    constants through `normalize.rs`.
//!
//! The contract is enforced by a test, not by prose: every `MUST_REPLACE` rule
//! must be supplied by every constructible language, and a new variant cannot
//! reach [`AlignmentLanguage::ALL`] without answering all of them. That is the
//! part worth having — a list of rules in a comment would be true on the day it
//! was written and quietly false a year later.
//!
//! ## What this module deliberately does NOT do
//!
//! It does not decide whether a language is fit to offer a user, and the
//! distinction is worth stating plainly because an earlier draft of this file
//! conflated the two. Membership here means the engine CAN NORMALISE the
//! language. It does not mean anybody has shown that it FOLLOWS.
//!
//! Those come apart because normalising French correctly is necessary and
//! nowhere near sufficient: the recogniser needs its own `blank_penalty` sweep,
//! and the language needs a corpus before there is any Tier B or Tier C number
//! to judge it by. That bar is a measurement, it lives in `cc-bench`, and
//! `bench/README.md` states it in numbers.
//!
//! What actually holds the door is a different list, in a different crate: a
//! language reaches a user only through a `cc_stt::models::BundledModel` that
//! serves it, and that table admits nothing without measured tuning. No model
//! this build can load serves French, German or Spanish, so nothing here
//! offers them.
//!
//! A profile is the PRECONDITION for measuring a language rather than the
//! measurement: a corpus cannot be scored in a language the normaliser does not
//! have. Being precise about the remaining distance — `cc-bench` compiles every
//! suite with `CompileOptions::default()`, so selecting one of these from its
//! command line is still to be built.

/// A language the alignment engine knows how to normalise.
///
/// Closed on purpose. Adding a variant makes every `match` in this module fail
/// to compile until it has been answered, which is exactly the review that a
/// new language deserves. There is deliberately no `Other(String)` and no
/// fallback from an unrecognised tag to English: a silent fallback is how you
/// ship a French model that normalises with English stopwords, passes every
/// test, and does not follow.
///
/// A variant here is a normalisation capability and NOT a shipping decision —
/// see the module docs. English is the only one of these four that has been
/// measured; French, German and Spanish arrived with #157 so that a corpus in
/// those languages can be compiled and scored at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum AlignmentLanguage {
    #[default]
    English,
    French,
    German,
    Spanish,
}

impl AlignmentLanguage {
    /// Every language the engine can currently normalise.
    ///
    /// NOT the list of languages the product offers. See the module docs: this
    /// is a capability, and the shipping decision is a measurement held
    /// elsewhere.
    pub const ALL: &'static [AlignmentLanguage] = &[
        AlignmentLanguage::English,
        AlignmentLanguage::French,
        AlignmentLanguage::German,
        AlignmentLanguage::Spanish,
    ];

    /// The BCP-47 primary subtag, for matching against a settings value or a
    /// recogniser's advertised language.
    pub fn primary_subtag(self) -> &'static str {
        match self {
            AlignmentLanguage::English => "en",
            AlignmentLanguage::French => "fr",
            AlignmentLanguage::German => "de",
            AlignmentLanguage::Spanish => "es",
        }
    }

    /// Resolve a BCP-47 tag (`en`, `en-US`, `en-GB`) to a language.
    ///
    /// Returns `None` rather than falling back to English. The caller has to
    /// decide what to do about a language the engine cannot normalise, and the
    /// one answer that is never right is to pretend it is English.
    ///
    /// Resolving a tag is NOT permission to use it. This answers "is there a
    /// profile for this?", and the app's own gate — in `settings::migrate_in_place`
    /// — additionally asks the resolved recogniser whether it serves the
    /// language, which is what keeps an unmeasured one from being honoured.
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
            AlignmentLanguage::French => &FRENCH,
            AlignmentLanguage::German => &GERMAN,
            AlignmentLanguage::Spanish => &SPANISH,
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
    /// The magnitude words a currency amount can carry — `million`,
    /// `millions`, `Millionen`, `millones`.
    ScaleWords,
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
        LanguageRule::ScaleWords,
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
            LanguageRule::ScaleWords => RuleDisposition::MustReplace,
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
    ///
    /// One atom each, which is a real limitation and not an oversight worth
    /// discovering later: French says "millions DE dollars", so a faithful
    /// French profile needs an atom SEQUENCE here. Recorded in
    /// `bench/README.md` as a known gap rather than built speculatively — the
    /// right shape is easier to see with a French corpus in hand than without.
    pub currency_units: &'static [&'static str],
    pub currency_order: CurrencyOrder,

    /// The magnitude words an amount can carry.
    ///
    /// Needed by the currency reordering rule independently of the spelled
    /// number grammar: `reorder_currency` has to recognise the scale word to
    /// know where the unit belongs, and it runs whether or not a language has
    /// a number grammar the engine can parse.
    pub scale_words: &'static [&'static str],

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
            LanguageRule::ScaleWords => !self.scale_words.is_empty(),
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
    scale_words: &["hundred", "thousand", "million", "billion"],

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

/* ---------------------------------------------------------------------------
 * The three profiles #157 added, and what they are and are not
 * ---------------------------------------------------------------------------
 * These answer every `MustReplace` rule, which is the contract this module
 * enforces. That is a narrower claim than "French is supported", and the
 * difference is the whole reason the module docs separate capability from
 * measurement: nobody has yet read a French script to a French recogniser and
 * measured what the glass did.
 *
 * Known limitations, recorded now rather than discovered later. The first two
 * are specific to these languages; the last three are properties of the schema
 * that English shares, listed because a reader comparing profiles will
 * otherwise think they are new here.
 *
 * * GROUPING SEPARATOR. `group_separator` is one character, and French groups
 *   thousands with a narrow no-break space rather than a point. `.` is the
 *   convention German and Spanish actually use, and no single character can be
 *   right for French, so it is chosen as the one that is at least right for two
 *   of the three — but it is not complete French, in two ways. A French script
 *   writing `3.5` and
 *   meaning three and a half normalises to `35`, because interior points are
 *   dropped without checking that the groups are three digits long. And a
 *   script writing the number CORRECTLY, as `1 234,5`, never reaches the
 *   separator logic at all: `canonical_atoms_for` splits on whitespace first,
 *   so that is two atoms, `1` and `234.5`. The decimal half — the half that
 *   changes the NUMBER — is right for all three.
 * * REGIONAL SPLITS. The profile is chosen by PRIMARY subtag, so `es-MX` gets
 *   this one, and Mexican usage is the English convention: decimal point,
 *   grouping comma. `de-CH` is a third convention again. A locale-aware
 *   numeric profile is a bigger change than a word list and wants a corpus
 *   behind it.
 * * CURRENCY SEQUENCES — FRENCH ONLY. `currency_units` holds one atom per
 *   unit, and French elides before a vowel: "millions D'EUROS" is the atom
 *   `d'euros`, which is not `euros`. Spanish and German are FINE here, and the
 *   distinction is worth keeping straight — "millones DE euros" leaves `euros`
 *   intact and merely adds an unmatched `de`, and German says "Millionen Euro"
 *   exactly. So this costs French one atom in three, and the other two
 *   nothing. `the_french_currency_sequence_is_a_known_gap` in `normalize.rs`
 *   pins it.
 * * SINGULAR AT ONE. `1 km` expands to `kilomètres` against a reader who says
 *   `kilomètre`. English has had this since the unit table existed (`1 km` →
 *   `kilometres`) and it is the measured baseline, so it is a property of the
 *   one-atom substitution rather than anything these three do differently.
 * * PARTIAL UNIT PHRASES. `fps` is "images par seconde", "Bilder pro Sekunde",
 *   "fotogramas por segundo" — three atoms, and the table substitutes one. It
 *   expands to the head noun, so the first atom matches and the rest do not.
 *   English does exactly the same (`fps` → `frames`).
 * * SCALE SEQUENCES. Spanish says `mil millones` for 10^9. That is two atoms,
 *   and `scale_words` entries must be one, so the currency swap does not see
 *   it. `millardo` exists and is rare enough that using it would be its own
 *   mismatch.
 * * VOCABULARY. The filler and stopword lists are deliberately short. A
 *   stopword list decides atom weight and global-anchor eligibility, so padding
 *   it speculatively changes the engine rather than merely adding words. The
 *   entries mirror the CATEGORIES the measured English profile uses — it lists
 *   `yes`, `no`, `here`, `there`, `now`, `very`, `well` — rather than a
 *   stricter rule invented for these three.
 */

/// French. Candidate, not measured — see the block comment above.
static FRENCH: NormalizationProfile = NormalizationProfile {
    language: AlignmentLanguage::French,

    // Elisions never reach this list: `l'arbre` is ONE atom, because the
    // normaliser keeps word-internal apostrophes. These are the standalone
    // forms, which are the only ones that can match.
    //
    // `hum` is deliberately absent though a recogniser may well emit it: in a
    // written script it is a deliberate interjection carrying doubt, and a
    // filler is skipped, so listing it would throw away a word the author
    // chose. The rule at the top of the struct — never a real script word —
    // decides that, not how often the recogniser writes it.
    fillers: &["euh", "heu", "hmm", "mm", "mmh"],

    // The elided forms are here on purpose and are the reason this list is
    // longer than a translation of the English one. Because word-internal
    // apostrophes survive, `c'est` and `qu'il` are single atoms made entirely
    // of function words — among the most frequent atoms in any French script —
    // and neither `ce` nor `est` classifies them. Left out, they would carry
    // full locating weight and be eligible as global anchors, which is exactly
    // the false-anchoring failure the rule's doc warns about.
    //
    // `fait` and `faire` are deliberately absent: `fait` is also the ordinary
    // noun "fact", and the English list has no comparable content word.
    stopwords: &[
        "le", "la", "les", "un", "une", "des", "de", "du", "et", "ou", "mais",
        "à", "au", "aux", "en", "dans", "sur", "sous", "pour", "par", "avec",
        "sans", "chez", "entre", "depuis", "vers", "que", "qui", "quoi",
        "dont", "où", "ce", "cet", "cette", "ces", "il", "elle", "ils",
        "elles", "je", "tu", "nous", "vous", "on", "me", "te", "se", "lui",
        "y", "ça", "mon", "ma", "mes", "ton", "ta", "tes", "son", "sa", "ses",
        "notre", "nos", "votre", "vos", "leur", "leurs", "est", "sont",
        "était", "étaient", "être", "été", "suis", "a", "ai", "as", "avons",
        "avez", "ont", "avait", "avaient", "avoir", "ne", "pas", "plus",
        "non", "oui", "si", "alors", "donc", "très", "bien", "aussi", "tout",
        "tous", "toute", "toutes", "comme", "quand", "déjà", "encore", "ici",
        "là", "c'est", "qu'il", "qu'elle", "n'est", "j'ai", "d'un", "d'une",
    ],

    phonetics: PhoneticPolicy::Disabled,

    ampersand: Some("et"),

    decimal_separator: ',',
    group_separator: '.',

    currency_symbols: &[('€', "euros"), ('$', "dollars"), ('£', "livres")],
    currency_units: &["euros", "dollars", "livres"],
    currency_order: CurrencyOrder::UnitAfterScale,
    scale_words: &[
        "cent", "cents", "mille", "million", "millions", "milliard",
        "milliards",
    ],

    percent: &["pour", "cent"],

    unit_words: &[
        ("hz", "hertz"),
        ("khz", "kilohertz"),
        ("mhz", "mégahertz"),
        ("ghz", "gigahertz"),
        ("ms", "millisecondes"),
        // Both spellings of the abbreviation, because a French script is more
        // likely to write `500 Go` than `500 GB` and matching is exact on the
        // abbreviation — `go` left out would simply never expand. Lowercasing
        // happens first, so these are the folded forms of Ko/Mo/Go/To.
        ("ko", "kilooctets"),
        ("mo", "mégaoctets"),
        ("go", "gigaoctets"),
        ("to", "téraoctets"),
        ("kb", "kilooctets"),
        ("mb", "mégaoctets"),
        ("gb", "gigaoctets"),
        ("tb", "téraoctets"),
        ("km", "kilomètres"),
        ("kg", "kilogrammes"),
        ("cm", "centimètres"),
        ("mm", "millimètres"),
        ("fps", "images"),
    ],

    contractions: false,
    spelled_numbers: false,
    ordinals: false,
};

/// German. Candidate, not measured — see the block comment above.
static GERMAN: NormalizationProfile = NormalizationProfile {
    language: AlignmentLanguage::German,

    // `hm` and `mhm` are deliberately absent. Both are ordinary German
    // responses — reflection and agreement — rather than noise, and `hm` is
    // also the SI symbol for hectometre, which `unit_words` does not expand.
    // A filler that is really a unit would silently drop a measurement.
    fillers: &["äh", "ähm", "öhm", "hmm", "mmh"],

    stopwords: &[
        "der", "die", "das", "den", "dem", "des", "ein", "eine", "einen",
        "einem", "einer", "eines", "und", "oder", "aber", "von", "vom", "zu",
        "zum", "zur", "in", "im", "an", "am", "auf", "für", "mit", "bei",
        "nach", "über", "unter", "durch", "um", "ist", "sind", "war", "waren",
        "sein", "gewesen", "bin", "hat", "haben", "habe", "hast", "hatte",
        "hatten", "wird", "werden", "wurde", "wurden", "kann", "können",
        "soll", "sollen", "muss", "müssen", "will", "wollen", "nicht",
        "kein", "keine", "ja", "nein", "ich", "du", "er", "sie", "es", "wir",
        "ihr", "man", "mich", "dich", "mir", "dir", "ihm", "ihn", "ihnen",
        "sich", "uns", "euch", "mein", "dein", "unser", "als", "wie", "wenn",
        "dass", "weil", "denn", "doch", "auch", "noch", "schon", "nur",
        "sehr", "hier", "da", "dort", "so", "dann", "jetzt", "alle", "alles",
        "was", "wer", "wo", "wann", "warum",
        // Prepositions and the fused preposition+article forms, which are
        // single words in German and among the most frequent atoms there is.
        "aus", "vor", "ohne", "seit", "bis", "gegen", "zwischen", "pro",
        "ins", "ans", "beim",
        "dieser", "diese", "dieses", "diesen", "diesem",
    ],

    phonetics: PhoneticPolicy::Disabled,

    ampersand: Some("und"),

    decimal_separator: ',',
    group_separator: '.',

    // Singular after a number: German says "2,4 Millionen Euro", not "Euros".
    currency_symbols: &[('€', "euro"), ('$', "dollar"), ('£', "pfund")],
    currency_units: &["euro", "dollar", "pfund"],
    currency_order: CurrencyOrder::UnitAfterScale,
    scale_words: &[
        "hundert", "tausend", "million", "millionen", "milliarde",
        "milliarden",
    ],

    percent: &["prozent"],

    unit_words: &[
        ("hz", "hertz"),
        ("khz", "kilohertz"),
        ("mhz", "megahertz"),
        ("ghz", "gigahertz"),
        ("ms", "millisekunden"),
        ("kb", "kilobyte"),
        ("mb", "megabyte"),
        ("gb", "gigabyte"),
        ("tb", "terabyte"),
        ("km", "kilometer"),
        ("kg", "kilogramm"),
        ("cm", "zentimeter"),
        ("mm", "millimeter"),
        ("fps", "bilder"),
    ],

    contractions: false,
    // German counts units before tens — "zweiundvierzig" is one word, not
    // "forty two" — so the English grammar is not a translation away from
    // working here. Off until somebody writes the German one and measures it.
    spelled_numbers: false,
    ordinals: false,
};

/// Spanish. Candidate, not measured — see the block comment above.
static SPANISH: NormalizationProfile = NormalizationProfile {
    language: AlignmentLanguage::Spanish,

    // `eh` is deliberately absent: it is a real Spanish interjection — "¿eh?",
    // "eh, tú" — and a script that writes it means it. `em` and `ehm` are not
    // ordinary words, so they are safe to skip.
    fillers: &["ehm", "em", "mm", "mmm", "hmm"],

    stopwords: &[
        "el", "la", "los", "las", "un", "una", "unos", "unas", "de", "del",
        "al", "a", "y", "e", "o", "u", "ni", "pero", "sino", "aunque", "en",
        "con", "sin", "por", "para", "sobre", "entre", "hasta", "desde",
        "que", "quien", "cual", "cuando", "donde", "como", "es", "son",
        "era", "eran", "ser", "sido", "soy", "eres", "somos",
        "está", "están", "estaba", "estaban", "estar", "estoy", "estás",
        "estamos", "ha", "han", "he", "has", "hemos", "había",
        "habían", "haber", "hay", "fue", "fueron", "no", "sí", "yo", "tú",
        "él", "ella", "ellos", "ellas", "nosotros", "vosotros", "usted",
        "ustedes", "me", "te", "se", "lo", "le", "les",
        "nos", "os", "mi", "mis", "tu", "tus", "su", "sus",
        "nuestro", "nuestra", "nuestros", "nuestras", "este", "esta", "esto",
        "estos", "estas", "ese", "esa", "eso", "esos", "esas",
        "muy", "más", "menos", "también", "ya", "ahora", "aquí", "allí",
        "todo", "todos", "toda", "todas", "algo", "si", "entonces", "porque",
        "así", "bien",
        // Spanish accents its interrogatives, and accents survive
        // normalisation — so `que` does not classify `qué`. Without these the
        // most frequent question words in the language would each carry full
        // anchor weight.
        "qué", "quién", "cuál", "cuándo", "dónde", "cómo",
    ],

    phonetics: PhoneticPolicy::Disabled,

    ampersand: Some("y"),

    decimal_separator: ',',
    group_separator: '.',

    currency_symbols: &[('€', "euros"), ('$', "dólares"), ('£', "libras")],
    currency_units: &["euros", "dólares", "libras"],
    currency_order: CurrencyOrder::UnitAfterScale,
    scale_words: &["cien", "ciento", "cientos", "mil", "millón", "millones"],

    percent: &["por", "ciento"],

    unit_words: &[
        ("hz", "hercios"),
        ("khz", "kilohercios"),
        ("mhz", "megahercios"),
        ("ghz", "gigahercios"),
        ("ms", "milisegundos"),
        ("kb", "kilobytes"),
        ("mb", "megabytes"),
        ("gb", "gigabytes"),
        ("tb", "terabytes"),
        ("km", "kilómetros"),
        ("kg", "kilogramos"),
        ("cm", "centímetros"),
        ("mm", "milímetros"),
        ("fps", "fotogramas"),
    ],

    contractions: false,
    spelled_numbers: false,
    ordinals: false,
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

    /// `ALL` is what the contract test iterates, so a variant missing from it
    /// would skip every check in this file.
    ///
    /// What this can and cannot do is worth being exact about, because the
    /// name promises more than a test in Rust can deliver: there is no way to
    /// enumerate an enum's variants, so nothing here can PROVE `ALL` is
    /// complete. What makes a forgotten variant fail is the compiler — every
    /// `match` in this module is exhaustive, so adding one breaks
    /// `primary_subtag` and `profile` until it is answered. This test adds the
    /// two things the compiler cannot see: that each variant is actually
    /// LISTED, and a pinned count so silently dropping one is a failure rather
    /// than a quietly shorter loop.
    #[test]
    fn all_lists_every_variant() {
        for lang in [
            AlignmentLanguage::English,
            AlignmentLanguage::French,
            AlignmentLanguage::German,
            AlignmentLanguage::Spanish,
        ] {
            assert!(
                AlignmentLanguage::ALL.contains(&lang),
                "{lang:?} has a profile but is missing from ALL, so every \
                 contract test in this file skips it"
            );
        }
        assert_eq!(AlignmentLanguage::ALL.len(), 4, "update this count with ALL");
    }

    /// Resolution is about the PROFILE TABLE, not about permission.
    ///
    /// This test used to assert that `fr`/`de`/`es` resolved to nothing, which
    /// was the right assertion while they had no profile and the wrong reason:
    /// it read as "French is not allowed" when it meant "French cannot be
    /// normalised". #157 gave all three a profile, so they resolve here — and
    /// `settings::migrate_in_place` is what still refuses them, because no
    /// recogniser this build can load serves them. The two halves are tested
    /// separately now because they fail for different reasons and only one of
    /// them is a shipping decision.
    #[test]
    fn bcp47_resolves_every_language_that_has_a_profile() {
        for (tag, expected) in [
            ("en", AlignmentLanguage::English),
            ("en-US", AlignmentLanguage::English),
            ("EN-us", AlignmentLanguage::English),
            ("en_US", AlignmentLanguage::English),
            ("fr", AlignmentLanguage::French),
            ("fr-FR", AlignmentLanguage::French),
            ("fr-CA", AlignmentLanguage::French),
            ("de", AlignmentLanguage::German),
            ("de-DE", AlignmentLanguage::German),
            ("de_AT", AlignmentLanguage::German),
            ("es", AlignmentLanguage::Spanish),
            ("es-ES", AlignmentLanguage::Spanish),
            ("ES-mx", AlignmentLanguage::Spanish),
        ] {
            assert_eq!(
                AlignmentLanguage::from_bcp47(tag),
                Some(expected),
                "{tag} resolves to {expected:?}"
            );
        }
        // Still the important half: a tag the engine cannot normalise resolves
        // to nothing at all — never to English.
        for tag in ["ja", "zh", "zh-CN", "pt", "pt-BR", "english", "eng", ""] {
            assert_eq!(
                AlignmentLanguage::from_bcp47(tag),
                None,
                "{tag} has no profile and must not resolve to one"
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
            14,
            "a rule was added or removed; update the count and bench/README.md"
        );
    }

    /// Every word a profile can SUBSTITUTE has to be one atom.
    ///
    /// The rule the normaliser actually implements, and the one most likely to
    /// be broken by a well-meaning translation: `expand_units` replaces one
    /// atom with one string, and `reorder_currency` compares and swaps single
    /// atoms. A `unit_words` value of "images par seconde" would therefore
    /// produce the atom `images par seconde`, with spaces inside it, which
    /// cannot equal any atom on the transcript side — the text is split on
    /// whitespace before it ever gets there. It would not fail loudly; it would
    /// simply never match, which is the failure mode this whole module exists
    /// to make impossible.
    ///
    /// `percent` is exempt because it is PUSHED as a sequence rather than
    /// substituted, which is exactly why it is a slice.
    #[test]
    fn every_substituted_word_is_a_single_atom() {
        for lang in AlignmentLanguage::ALL {
            let profile = lang.profile();
            for (abbrev, spelled) in profile.unit_words {
                assert!(
                    !spelled.split_whitespace().nth(1).is_some(),
                    "{lang:?} expands {abbrev} to {spelled:?}, which is more \
                     than one atom and can never match"
                );
                assert!(
                    !abbrev.split_whitespace().nth(1).is_some(),
                    "{lang:?} has a multi-word unit abbreviation {abbrev:?}"
                );
            }
            for unit in profile.currency_units {
                assert!(
                    !unit.split_whitespace().nth(1).is_some(),
                    "{lang:?} currency unit {unit:?} is more than one atom"
                );
            }
            for scale in profile.scale_words {
                assert!(
                    !scale.split_whitespace().nth(1).is_some(),
                    "{lang:?} scale word {scale:?} is more than one atom"
                );
            }
            for word in profile.percent {
                assert!(
                    !word.split_whitespace().nth(1).is_some(),
                    "{lang:?} percent word {word:?} is more than one atom"
                );
            }
            if let Some(word) = profile.ampersand {
                assert!(
                    !word.split_whitespace().nth(1).is_some(),
                    "{lang:?} reads & as {word:?}, which is more than one atom"
                );
            }
        }
    }

    /// Atoms are lowercased before anything is compared against these lists, so
    /// an uppercase entry is an entry that can never match.
    ///
    /// The keyed lists are held to the same bar for the same reason. A
    /// `unit_words` abbreviation is compared by exact equality against an
    /// already-lowercased atom, so `("KB", ...)` would never fire; and both it
    /// and `currency_symbols` are looked up with `.find()`, so a duplicate key
    /// is not an error but a shadow — the second entry simply never wins. Like
    /// the multi-atom substitutions above, neither would fail loudly.
    #[test]
    fn every_word_list_is_lowercase_and_free_of_duplicates() {
        for lang in AlignmentLanguage::ALL {
            let profile = lang.profile();
            let lists: [(&str, &[&str]); 4] = [
                ("fillers", profile.fillers),
                ("stopwords", profile.stopwords),
                ("scale_words", profile.scale_words),
                ("currency_units", profile.currency_units),
            ];
            for (name, list) in lists {
                for word in list {
                    assert_eq!(
                        *word,
                        word.to_lowercase(),
                        "{lang:?} {name} contains {word:?}, which is not \
                         lowercase and so can never match an atom"
                    );
                }
                let mut seen = std::collections::BTreeSet::new();
                for word in list {
                    assert!(
                        seen.insert(*word),
                        "{lang:?} {name} lists {word:?} twice"
                    );
                }
            }
            let mut abbrevs = std::collections::BTreeSet::new();
            for (abbrev, _) in profile.unit_words {
                assert_eq!(
                    *abbrev,
                    abbrev.to_lowercase(),
                    "{lang:?} unit_words contains {abbrev:?}, which is not \
                     lowercase and so can never match an atom"
                );
                assert!(
                    abbrevs.insert(*abbrev),
                    "{lang:?} unit_words lists {abbrev:?} twice; only the \
                     first expansion can ever fire"
                );
            }
            let mut symbols = std::collections::BTreeSet::new();
            for (symbol, _) in profile.currency_symbols {
                assert!(
                    symbols.insert(*symbol),
                    "{lang:?} currency_symbols lists {symbol:?} twice; only \
                     the first spoken word can ever fire"
                );
            }
        }
    }

    /// A filler is skipped outright, so a word that is also a real script word
    /// would delete evidence rather than noise.
    #[test]
    fn no_filler_is_also_a_stopword() {
        for lang in AlignmentLanguage::ALL {
            let profile = lang.profile();
            for filler in profile.fillers {
                assert!(
                    !profile.stopwords.contains(filler),
                    "{lang:?} lists {filler:?} as both a filler and a stopword; \
                     the two disagree about whether it is a word at all"
                );
            }
        }
    }

    /// The three profiles #157 added are candidates, and the thing that makes
    /// them candidates rather than copies is that they do not reuse English's
    /// data. A profile that silently pointed at `ENGLISH` would satisfy every
    /// other test in this file.
    #[test]
    fn the_candidate_languages_do_not_reuse_english_data() {
        let english = AlignmentLanguage::English.profile();
        for lang in [
            AlignmentLanguage::French,
            AlignmentLanguage::German,
            AlignmentLanguage::Spanish,
        ] {
            let profile = lang.profile();
            assert_ne!(profile.stopwords, english.stopwords, "{lang:?} stopwords");
            assert_ne!(profile.fillers, english.fillers, "{lang:?} fillers");
            assert_ne!(profile.percent, english.percent, "{lang:?} percent");
            assert_ne!(
                profile.unit_words, english.unit_words,
                "{lang:?} unit words"
            );
            assert_ne!(
                profile.ampersand, english.ampersand,
                "{lang:?} reads & the English way"
            );
            // The one that changes the NUMBER rather than the wording.
            assert_eq!(
                (profile.decimal_separator, profile.group_separator),
                (',', '.'),
                "{lang:?} must group and point the way its readers write"
            );
        }
    }

    /// The candidate profiles are complete enough to normalise with, and carry
    /// no claim about following quality.
    ///
    /// Named for what it checks. It does NOT verify that fr/de/es are
    /// unreachable by a user — that gate is a `cc_stt::models::BundledModel`
    /// serving the language, which is two crates away and is asserted in
    /// `src-tauri/src/speech/catalogue.rs`. This crate cannot see it, and a
    /// test here that claimed to would be checking nothing.
    #[test]
    fn a_candidate_profile_normalises_without_claiming_to_follow() {
        for lang in [
            AlignmentLanguage::French,
            AlignmentLanguage::German,
            AlignmentLanguage::Spanish,
        ] {
            // Constructible and normalising: the benchmark needs exactly this.
            assert!(!lang.profile().stopwords.is_empty());
            assert_eq!(lang.profile().language, lang);
            // And carrying no claim about following quality: the phonetic
            // relation is off, which is the documented starting point for a
            // language nobody has measured.
            assert_eq!(
                lang.profile().phonetics,
                PhoneticPolicy::Disabled,
                "{lang:?} must not borrow the English phonetic skeleton before \
                 anybody has shown it helps on a corpus in that language"
            );
        }
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
