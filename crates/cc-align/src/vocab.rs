//! Script → recogniser vocabulary bias: the terms a take sends ahead of its
//! audio so the transcript comes back spelled the way the script is written.
//!
//! ---------------------------------------------------------------------------
//! WHAT THIS IS FOR
//! ---------------------------------------------------------------------------
//! Inworld's `transcribeConfig.prompts` is a soft bias — an array of strings
//! that makes the recogniser likelier to write particular words. It is not a
//! keyword lock and it cannot make a wrong word right. What it can do is win
//! the coin-flips the model was going to lose anyway: `RustLight` over
//! `Rust Light`, `Saoirse` over `Sersha`, `twenty-seven` over `27`.
//!
//! Two different wins, worth naming separately because they have different
//! shapes:
//!
//!   * **Mishearing.** A name the model has no prior for comes back as
//!     something else entirely. Alignment recovers some of this through the
//!     phonetic relation (see [`crate::normalize`]), but only for anchor-grade
//!     words and only as a last resort.
//!   * **Re-spelling.** Nothing was misheard; the model simply wrote a number,
//!     a time or a compound in a different notation than the script used. The
//!     normaliser already folds both spellings onto one atom, so this costs
//!     nothing *once the words are in the ledger* — but every fold is a chance
//!     to be wrong, and the cheapest fold is the one that was never needed.
//!
//! So this module reads the script and answers one question per token: is this
//! a word the recogniser might plausibly get wrong, and would the script care?
//!
//! ---------------------------------------------------------------------------
//! HOW A WORD IS JUDGED UNUSUAL
//! ---------------------------------------------------------------------------
//! Two signals, in this order of authority:
//!
//! 1. **Orthography**, which is free and nearly always right. A capital in the
//!    middle of a word is a brand. A run of capitals is an initialism. A letter
//!    outside ASCII is a name somebody chose deliberately. Digits mixed with
//!    letters are a model number or a unit. None of these needs a corpus to
//!    recognise, and none of them is ambiguous.
//! 2. **Absence from ordinary English** (`assets/common-words.txt`), which is a
//!    filter rather than a detector. It exists to stop the capitalisation rule
//!    firing on `Monday`, and to let a plain lowercase word like `teleprompter`
//!    through at a low score when nothing better fills the list.
//!
//! Position matters as much as shape: a capitalised word at the start of a
//! sentence is evidence of nothing, which is why [`VocabToken`] carries a
//! sentence ordinal. `Growth brought its own characters` must not offer
//! `Growth`, and `Nkosinathi Dlamini wrote the first prototype` must offer
//! `Nkosinathi Dlamini` — the difference is not in the words, it is in whether
//! a second capital follows.
//!
//! ---------------------------------------------------------------------------
//! WHY THE OUTPUT IS CAPPED
//! ---------------------------------------------------------------------------
//! A soft bias is a budget. Hand the recogniser two hundred rare terms and it
//! starts finding them in ordinary prose, which trades a handful of missed
//! names for a scatter of invented ones — a much worse deal, because a name
//! that arrives late still aligns and a name hallucinated mid-sentence drags
//! the cursor somewhere the presenter is not. So candidates are scored, sorted
//! and cut. The cap is the point of the ranking; without it the ranking would
//! be decoration.
//!
//! ---------------------------------------------------------------------------
//! THE SANITISER IS NOT OPTIONAL
//! ---------------------------------------------------------------------------
//! The gateway rejects terms containing characters outside letters, digits,
//! spaces and basic punctuation, and it rejects them with `INVALID_ARGUMENT`
//! on the config frame — the frame that LEADS the socket. A bad character
//! therefore does not degrade a take, it prevents one. Everything leaving this
//! module goes through [`sanitize`], which is an allowlist, and anything it
//! cannot clean is dropped rather than sent and hoped for.

use crate::script::CompileOptions;

/// One authored spoken token, in reading order.
#[derive(Debug, Clone, Copy)]
pub struct VocabToken<'a> {
    /// The AUTHORED surface — `RustLight`, `$2.4`, `twenty-seven`.
    ///
    /// Deliberately NOT the canonical atom the aligner works in: casing and
    /// punctuation are the entire signal here, and canonicalisation is defined
    /// by having thrown both away.
    pub surface: &'a str,
    /// Which sentence this token belongs to.
    ///
    /// Only equality with the previous token's value is read. That is enough
    /// to separate "capitalised because it is a name" from "capitalised
    /// because it is Monday morning and the sentence had to start somewhere",
    /// and it costs the caller nothing — the app already carries a sentence
    /// ordinal on every spoken token.
    pub sentence: u32,
}

/// What a config frame may carry.
///
/// Defaults are deliberately modest. `max_terms` is the dilution budget
/// discussed in the module docs; the two character limits exist so that a
/// pathological script — a page of hyphenated chemical names — cannot produce
/// a config frame large enough to be interesting to the gateway.
#[derive(Debug, Clone, Copy)]
pub struct VocabLimits {
    pub max_terms: usize,
    pub max_term_chars: usize,
    pub max_total_chars: usize,
}

impl Default for VocabLimits {
    fn default() -> Self {
        Self {
            max_terms: 48,
            max_term_chars: 64,
            max_total_chars: 1_500,
        }
    }
}

/// The vocabulary terms for a script, best first.
///
/// Deterministic: same tokens in, same terms out, in the same order. Ties break
/// on first appearance in the script, never on hash order.
pub fn extract_terms(tokens: &[VocabToken<'_>], limits: VocabLimits) -> Vec<String> {
    let words: Vec<Word<'_>> = tokens
        .iter()
        .enumerate()
        .map(|(index, token)| {
            let core = trim_edges(token.surface);
            Word {
                core,
                shape: Shape::of(core),
                sentence_start: index == 0 || tokens[index - 1].sentence != token.sentence,
                breaks_after: breaks_after(token.surface),
            }
        })
        .collect();

    let occurrences = count_occurrences(&words);
    let mut candidates: Vec<Candidate> = Vec::new();
    collect_figure_phrases(&words, &mut candidates);
    collect_name_phrases(&words, &mut candidates);
    collect_singletons(&words, &mut candidates);
    rank(candidates, &occurrences, limits)
}

/// The vocabulary terms for a Markdown script.
///
/// Shares [`crate::script::for_each_spoken_line`] with the compiler, so a
/// container or code fence the presenter never reads aloud cannot contribute a
/// term. Sentence boundaries are recovered from terminal punctuation, which the
/// app path gets exactly instead of guessing.
pub fn extract_from_markdown(
    source: &str,
    options: CompileOptions,
    limits: VocabLimits,
) -> Vec<String> {
    let mut owned: Vec<(String, u32)> = Vec::new();
    let mut sentence = 0u32;
    let mut last_para: Option<u32> = None;
    crate::script::for_each_spoken_line(source, options, |_line, para, text| {
        if last_para.is_some_and(|p| p != para) {
            sentence += 1;
        }
        last_para = Some(para);
        for raw in text.split_whitespace() {
            owned.push((raw.to_string(), sentence));
            if ends_sentence(raw) {
                sentence += 1;
            }
        }
    });

    let tokens: Vec<VocabToken<'_>> = owned
        .iter()
        .map(|(surface, sentence)| VocabToken {
            surface,
            sentence: *sentence,
        })
        .collect();
    extract_terms(&tokens, limits)
}

/// Every spoken word of a Markdown script, in the AUTHORED spelling.
///
/// The compiled script cannot answer this: `compile` canonicalises as it goes,
/// so by the time it has atoms `twenty-seven` is already `27`. Anything asking
/// "did the recogniser write this the way the page did" needs the page, and
/// this is the only route to it that still obeys the compiler's rules about
/// which blocks are spoken at all.
pub fn spoken_surfaces(source: &str, options: CompileOptions) -> Vec<String> {
    let mut out = Vec::new();
    crate::script::for_each_spoken_line(source, options, |_line, _para, text| {
        out.extend(text.split_whitespace().map(str::to_string));
    });
    out
}

/* -------------------------------------------------------------------------
 * Ordinary English
 * ---------------------------------------------------------------------- */

/// The list, with its comment header stripped. See the asset for provenance.
const COMMON_WORDS: &str = include_str!("../assets/common-words.txt");

fn common_words() -> &'static [&'static str] {
    static WORDS: std::sync::OnceLock<Vec<&'static str>> = std::sync::OnceLock::new();
    WORDS.get_or_init(|| {
        COMMON_WORDS
            .lines()
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .collect()
    })
}

/// Is `word` ordinary English — a word no script needs to teach a recogniser?
///
/// Case-insensitive, ASCII-only by definition: a word carrying a letter outside
/// ASCII is never ordinary for this purpose, because that letter is exactly the
/// thing the recogniser is about to get wrong.
///
/// Tries the word itself, then its US/UK counterpart, then a short list of
/// regular suffix strips against both. The asset holds word FAMILIES, so the
/// strips are a backstop for words the NGSL lists without every derivation
/// (`teleprompter` is absent either way; `dashboards` is reachable from
/// `dashboard`), not the primary mechanism.
pub fn is_ordinary_word(word: &str) -> bool {
    // `nobody's` is `nobody`. Possessives and contractions are ordinary English
    // wearing an apostrophe, and treating one as an unknown word would offer
    // the recogniser `nobody's` as a term worth learning.
    let lowered = word
        .trim_matches(|c: char| !c.is_alphanumeric())
        .to_lowercase()
        .replace(['\'', '\u{2019}'], "");
    if lowered.len() < 2 || !lowered.chars().all(|c| c.is_ascii_alphabetic()) {
        return false;
    }
    let list = common_words();
    let known = |w: &str| list.binary_search(&w).is_ok();
    if known(&lowered) {
        return true;
    }
    for variant in fold_spelling(&lowered) {
        if known(&variant) {
            return true;
        }
        for stem in strip_suffixes(&variant) {
            if known(&stem) {
                return true;
            }
        }
    }
    strip_suffixes(&lowered).iter().any(|s| known(s))
}

/// US/UK spelling equivalents of `word`.
///
/// The asset stores one spelling of each pair, so this is what makes a British
/// script behave like an American one. Each rule is applied independently — a
/// word matching none of them yields nothing and costs a single length check.
fn fold_spelling(word: &str) -> Vec<String> {
    const SUFFIX_SWAPS: &[(&str, &str)] = &[
        ("isation", "ization"),
        ("isations", "izations"),
        ("ise", "ize"),
        ("ises", "izes"),
        ("ised", "ized"),
        ("ising", "izing"),
        ("yse", "yze"),
        ("ysed", "yzed"),
        ("ysing", "yzing"),
        ("our", "or"),
        ("ours", "ors"),
        ("oured", "ored"),
        ("ouring", "oring"),
        ("ence", "ense"),
        ("ences", "enses"),
        ("ogue", "og"),
        ("ogues", "ogs"),
        ("mme", "m"),
        ("mmes", "ms"),
        ("re", "er"),
        ("res", "ers"),
        ("lling", "ling"),
        ("lled", "led"),
        ("ller", "ler"),
    ];
    let mut out = Vec::new();
    for (from, to) in SUFFIX_SWAPS {
        // `re` → `er` on a three-letter word turns `are` into `aer`; the guard
        // keeps the shortest rules away from words that are mostly suffix.
        if word.len() >= from.len() + 3 {
            if let Some(stem) = word.strip_suffix(from) {
                out.push(format!("{stem}{to}"));
            }
        }
    }
    // `anaemia` → `anemia`, `oesophagus` → `esophagus`.
    for digraph in ["ae", "oe"] {
        if let Some(at) = word.find(digraph) {
            let mut folded = String::with_capacity(word.len() - 1);
            folded.push_str(&word[..at]);
            folded.push('e');
            folded.push_str(&word[at + digraph.len()..]);
            out.push(folded);
        }
    }
    out
}

/// Regular inflections, stripped back towards a headword.
fn strip_suffixes(word: &str) -> Vec<String> {
    const SUFFIXES: &[&str] = &["s", "es", "ed", "ing", "ly", "er", "est", "'s"];
    let mut out = Vec::new();
    if let Some(stem) = word.strip_suffix("ies") {
        out.push(format!("{stem}y"));
    }
    for suffix in SUFFIXES {
        if word.len() >= suffix.len() + 3 {
            if let Some(stem) = word.strip_suffix(suffix) {
                out.push(stem.to_string());
                // `running` → `run`, `stopped` → `stop`.
                let bytes = stem.as_bytes();
                if bytes.len() >= 3 && bytes[bytes.len() - 1] == bytes[bytes.len() - 2] {
                    out.push(stem[..stem.len() - 1].to_string());
                }
            }
        }
    }
    out
}

/// Capitalised words that are ordinary despite being proper nouns.
///
/// The NGSL strips days, months and numerals on purpose — sensible for a
/// vocabulary syllabus, wrong for us, because it leaves `Monday` looking
/// exactly like `Nkosinathi`. Short and hand-written: every entry is here
/// because it is a capitalised word a presenter says without needing help.
const ORDINARY_CAPITALISED: &[&str] = &[
    "april", "august", "december", "dr", "february", "friday", "january", "july", "june",
    "march", "may", "miss", "monday", "mr", "mrs", "ms", "november", "october", "ok",
    "professor", "saturday", "september", "sunday", "thursday", "tuesday", "wednesday",
];

fn is_ordinary_capitalised(word: &str) -> bool {
    let lowered = word.to_lowercase();
    ORDINARY_CAPITALISED.binary_search(&lowered.as_str()).is_ok()
}

/* -------------------------------------------------------------------------
 * Token shape
 * ---------------------------------------------------------------------- */

#[derive(Debug, Clone, Copy)]
struct Word<'a> {
    core: &'a str,
    shape: Shape,
    sentence_start: bool,
    /// Punctuation after this token separates it from the next.
    ///
    /// `SoundCloud, PagerDuty and OpenTable` is a LIST of three names, not one
    /// three-word name, and the comma is the only thing that says so.
    ///
    /// Best-effort by necessity: the app's tokenizer cannot produce a surface
    /// ending in `.` or `,` (see `tokenize.ts`), so on that path this is almost
    /// always false and a list can still be read as a phrase. That is survivable
    /// rather than fixed here, because a distinctive word keeps its own slot in
    /// [`rank`] whether or not a phrase also swallowed it — the phrase costs a
    /// slot, never a term.
    breaks_after: bool,
}

fn breaks_after(surface: &str) -> bool {
    surface
        .trim_end_matches(['"', '\'', ')', ']', '”', '’'])
        .ends_with([',', ';', ':', '.', '!', '?', '—'])
}

#[derive(Debug, Clone, Copy, Default)]
struct Shape {
    letters: usize,
    digits: usize,
    /// First alphabetic character is uppercase.
    leading_upper: bool,
    /// An uppercase letter appears after a lowercase one — `RustLight`, `iPhone`.
    internal_upper: bool,
    /// Two or more letters, none lowercase — `RTX`, `API`.
    all_upper: bool,
    /// A letter outside ASCII — `Þorvaldsdóttir`, `Siobhán`.
    non_ascii_letter: bool,
    hyphenated: bool,
    /// Punctuation with a digit on both sides — `3.2`, `9:00`, `1,000`.
    inner_digit_punct: bool,
}

impl Shape {
    fn of(word: &str) -> Self {
        let mut shape = Shape::default();
        let chars: Vec<char> = word.chars().collect();
        let mut seen_lower = false;
        let mut seen_upper = false;
        let mut any_lower = false;
        for (i, &c) in chars.iter().enumerate() {
            if c.is_alphabetic() {
                shape.letters += 1;
                if !c.is_ascii() {
                    shape.non_ascii_letter = true;
                }
                if c.is_uppercase() {
                    seen_upper = true;
                    if seen_lower {
                        shape.internal_upper = true;
                    }
                    if shape.letters == 1 {
                        shape.leading_upper = true;
                    }
                } else if c.is_lowercase() {
                    seen_lower = true;
                    any_lower = true;
                }
            } else if c.is_ascii_digit() {
                shape.digits += 1;
            } else if c == '-' {
                shape.hyphenated = true;
            } else if matches!(c, '.' | ':' | ',') {
                let before = i > 0 && chars[i - 1].is_ascii_digit();
                let after = chars.get(i + 1).is_some_and(|n| n.is_ascii_digit());
                if before && after {
                    shape.inner_digit_punct = true;
                }
            }
        }
        shape.all_upper = shape.letters >= 2 && seen_upper && !any_lower;
        shape
    }

    /// Shape alone is enough to want this word, whatever the corpus says.
    fn is_distinctive(&self) -> bool {
        self.internal_upper
            || self.non_ascii_letter && self.letters >= 3
            || self.all_upper
            || (self.digits > 0 && self.letters > 0)
    }
}

fn trim_edges(surface: &str) -> &str {
    surface.trim_matches(|c: char| !c.is_alphanumeric())
}

fn ends_sentence(raw: &str) -> bool {
    let trimmed = raw.trim_end_matches(['"', '\'', ')', ']', '”', '’']);
    let Some(last) = trimmed.chars().last() else {
        return false;
    };
    if !matches!(last, '.' | '!' | '?') {
        return false;
    }
    // `3.` never ends a sentence in a script that is reading figures aloud, and
    // `Dr.` / `U.S.` are abbreviations the tokenizer keeps whole.
    let body = &trimmed[..trimmed.len() - last.len_utf8()];
    if body.chars().last().is_some_and(|c| c.is_ascii_digit()) {
        return false;
    }
    body.chars().filter(|c| c.is_alphanumeric()).count() > 1 && !body.contains('.')
}

/// Case-insensitive identity for deduplication and occurrence counting.
fn fold_key(word: &str) -> String {
    word.to_lowercase()
}

fn count_occurrences(words: &[Word<'_>]) -> std::collections::BTreeMap<String, u32> {
    let mut counts = std::collections::BTreeMap::new();
    for word in words {
        if word.core.is_empty() {
            continue;
        }
        *counts.entry(fold_key(word.core)).or_insert(0) += 1;
    }
    counts
}

/* -------------------------------------------------------------------------
 * Candidates
 * ---------------------------------------------------------------------- */

#[derive(Debug, Clone)]
struct Candidate {
    text: String,
    score: u32,
    first: usize,
    /// Token span, so a single word already covered by a phrase can be dropped.
    words: usize,
    /// Is this word's own SPELLING the thing being biased?
    ///
    /// Decides whether a phrase containing it may take its slot. `Dlamini` is
    /// a name the surrounding `Nkosinathi Dlamini` already carries, so it can
    /// go; `PagerDuty` is a spelling in its own right and keeps its slot even
    /// when a run glued it to the brand next to it in a list.
    distinctive: bool,
}

const SCORE_INTERNAL_UPPER: u32 = 60;
const SCORE_NON_ASCII: u32 = 55;
const SCORE_DIGIT_LETTER_MIX: u32 = 45;
const SCORE_ALL_UPPER: u32 = 40;
const SCORE_PROPER_NOUN: u32 = 40;
const SCORE_FIGURE: u32 = 35;
const SCORE_HYPHENATED: u32 = 25;
const SCORE_UNCOMMON: u32 = 15;
const SCORE_PHRASE: u32 = 8;

/// Shortest an ASCII, ordinarily-cased proper noun may be and still be sent.
///
/// Measured, not guessed. A capture of `technical.md` with no length bar sent
/// `Rust`, `API` and `IPC`, and the recogniser came back having written each of
/// them TWICE where the script said them once — nine spurious insertions in 305
/// words, enough to push WER from 10.5% to 15.1% while the term-hit count
/// tripled. Short, ordinary-looking words are ones the model already knows;
/// biasing them cannot improve recognition and can only inflate their prior.
const MIN_PLAIN_NAME_LEN: usize = 6;

/// Shortest initialism worth sending, by the same measurement.
///
/// `GDPR` was recovered by the bias and `API`/`IPC`/`SDK` were duplicated by
/// it. Three letters is where an acronym stops being unusual.
const MIN_INITIALISM_LEN: usize = 4;

/* ------------------------------ figures ------------------------------ */

const NUMBER_WORDS: &[&str] = &[
    "billion", "billions", "eight", "eighteen", "eighteenth", "eighth", "eightieth", "eighty",
    "eleven", "eleventh", "fifteen", "fifteenth", "fifth", "fiftieth", "fifty", "first", "five",
    "forth", "fortieth", "forty", "four", "fourteen", "fourteenth", "fourth", "half", "halves",
    "hundred", "hundreds", "hundredth", "million", "millions", "millionth", "nine", "nineteen",
    "nineteenth", "ninetieth", "ninety", "ninth", "oh", "one", "quarter", "second", "seven",
    "seventeen", "seventeenth", "seventh", "seventieth", "seventy", "six", "sixteen",
    "sixteenth", "sixth", "sixtieth", "sixty", "ten", "tenth", "third", "thirteen",
    "thirteenth", "thirtieth", "thirty", "thousand", "thousands", "thousandth", "three",
    "twelfth", "twelve", "twentieth", "twenty", "two", "zero",
];

/// Words that finish a figure: the unit or currency said after the number.
const UNIT_WORDS: &[&str] = &[
    "am", "bytes", "centimetres", "dollars", "euros", "feet", "gigabytes", "gigahertz", "grams",
    "hertz", "hours", "inches", "kilobytes", "kilograms", "kilohertz", "kilometres", "megabytes",
    "megahertz", "metres", "miles", "milliseconds", "minutes", "percent", "pm", "pounds",
    "seconds", "terabytes", "years",
];

fn is_number_word(word: &str) -> bool {
    if word.is_empty() {
        return false;
    }
    let lowered = word.to_lowercase();
    lowered
        .split('-')
        .filter(|part| !part.is_empty())
        .all(|part| NUMBER_WORDS.binary_search(&part).is_ok())
}

fn is_unit_word(word: &str) -> bool {
    UNIT_WORDS
        .binary_search(&word.to_lowercase().as_str())
        .is_ok()
}

/// `28th`, `95th`, `3rd` — digits wearing an ordinal suffix.
fn is_ordinal_suffixed(word: &str) -> bool {
    let lowered = word.to_lowercase();
    ["st", "nd", "rd", "th"].iter().any(|suffix| {
        lowered
            .strip_suffix(suffix)
            .is_some_and(|stem| !stem.is_empty() && stem.chars().all(|c| c.is_ascii_digit()))
    })
}

fn is_figure_token(word: &Word<'_>) -> bool {
    word.shape.digits > 0 || is_number_word(word.core)
}

/// Figures in the script's own notation.
///
/// This is the re-spelling half of the problem and it is the reason a term can
/// be a phrase rather than a word. `three thirty` and `twenty-seven` are the
/// forms a recogniser is most likely to write back as `3:30` and `27`; sending
/// the authored form is the only chance of being handed back what was written.
///
/// A bare small number is deliberately NOT offered. `27` on its own is not a
/// spelling the model needs help with, and every term spent on one is a term
/// not spent on a name.
fn collect_figure_phrases(words: &[Word<'_>], out: &mut Vec<Candidate>) {
    let mut i = 0;
    while i < words.len() {
        if words[i].core.is_empty() || !is_figure_token(&words[i]) {
            i += 1;
            continue;
        }
        let mut end = i + 1;
        while end < words.len() {
            let next = &words[end];
            if next.core.is_empty() {
                break;
            }
            if words[end - 1].breaks_after {
                break;
            }
            if is_figure_token(next) || is_unit_word(next.core) {
                end += 1;
                continue;
            }
            break;
        }

        // A capitalised or initialised qualifier in front is part of the term:
        // `RTX 4090` and `Q3 2026` bias far better than `4090` and `2026`.
        //
        // Unless punctuation already said otherwise. `three thirty, 24kHz,
        // 1905.` is a list of three figures, and gluing the last two together
        // invents `24kHz 1905` — a term that is not in the script, cannot be
        // said, and costs a slot a real figure wanted.
        let mut start = i;
        if i > 0 {
            let prev = &words[i - 1];
            let qualifies = prev.shape.all_upper
                || prev.shape.internal_upper
                || (prev.shape.leading_upper && !prev.sentence_start);
            if qualifies && !prev.breaks_after && words[i].shape.digits > 0 {
                start = i - 1;
            }
        }

        let qualified = start < i;
        let span = &words[start..end];
        let spans_words = end - start;
        let complex = span.iter().any(|w| {
            (w.shape.digits > 0 && w.shape.letters > 0)
                || w.shape.inner_digit_punct
                || (w.shape.hyphenated && is_number_word(w.core))
        });
        // A spelled-out figure is only interesting when it is long enough to be
        // written back a different way. `three thirty` and `twenty-seven
        // thousand` are; `two years` and `forty percent` are not — there is no
        // second notation for `two`, and each one spent is a name unsent.
        let number_tokens = span.iter().filter(|w| is_number_word(w.core)).count();
        let spelled_richly = number_tokens >= 2;
        // Two figure tokens in a row, a spelled-out number with real structure,
        // a token whose own notation is unusual, or a number belonging to a
        // named thing. A lone `27` matches none of them.
        // A lone figure must carry a real letter to be worth sending. `24kHz`
        // is a notation the recogniser can get wrong; `0.29`, `3.2` and `95th`
        // are not, and the `technical` capture wrote each of them one more time
        // than it was said. An ordinal suffix does not count as a letter — it
        // is the digits that carry the meaning.
        let lone_figure_is_notable = spans_words > 1
            || span.iter().any(|w| {
                w.shape.letters > 0
                    && !is_ordinal_suffixed(w.core)
                    && (w.shape.digits == 0 || w.shape.letters >= 2)
            });
        let worth_it =
            (complex || qualified || spelled_richly || spans_words >= 3) && lone_figure_is_notable;
        if worth_it {
            let text = span
                .iter()
                .map(|w| w.core)
                .collect::<Vec<_>>()
                .join(" ");
            let mut score = SCORE_FIGURE;
            if complex {
                score += SCORE_DIGIT_LETTER_MIX / 2;
            }
            if spans_words > 1 {
                score += SCORE_PHRASE;
            }
            out.push(Candidate {
                text,
                score,
                first: start,
                words: spans_words,
                distinctive: false,
            });
        }
        i = end.max(i + 1);
    }
}

/* ------------------------------- names ------------------------------- */

fn is_name_part(word: &Word<'_>) -> bool {
    !word.core.is_empty() && word.shape.letters > 0 && word.shape.leading_upper
}

/// What a token's ORTHOGRAPHY alone is worth, independent of where it sits.
///
/// Shared by singletons and phrases so that `RustLight Games` is never ranked
/// below the `RustLight` inside it. A phrase that contains a distinctive word
/// is at least as useful as that word alone — it carries the same spelling plus
/// the context the recogniser hears around it — and if it ranked lower, the
/// containment rule below would keep the weaker of the two.
fn shape_score(word: &Word<'_>, ordinary: bool) -> u32 {
    let shape = word.shape;
    let mut score = 0;
    if shape.internal_upper {
        score += SCORE_INTERNAL_UPPER;
    }
    if shape.non_ascii_letter && shape.letters >= 3 {
        score += SCORE_NON_ASCII;
    }
    if shape.all_upper
        && shape.letters >= MIN_INITIALISM_LEN
        && !ordinary
        && !is_ordinary_capitalised(word.core)
    {
        score += SCORE_ALL_UPPER;
    }
    // `24kHz` mixes digits and letters into a notation; `95th` mixes them into
    // an ordinal, where the letters are grammar rather than spelling and there
    // is nothing for a bias to teach.
    if shape.digits > 0 && shape.letters > 0 && !is_ordinal_suffixed(word.core) {
        score += SCORE_DIGIT_LETTER_MIX;
    }
    score
}

/// Runs of capitalised words: `Nkosinathi Dlamini`, `RustLight Games`.
///
/// A run of two or more is a name even when it starts a sentence — English
/// capitalises the first word of a sentence, not the second. A run of one is
/// only evidence when it is NOT sentence-initial, which is the whole reason
/// [`VocabToken`] carries a sentence ordinal.
fn collect_name_phrases(words: &[Word<'_>], out: &mut Vec<Candidate>) {
    let mut i = 0;
    while i < words.len() {
        if !is_name_part(&words[i]) {
            i += 1;
            continue;
        }
        let mut end = i + 1;
        while end < words.len() && !words[end - 1].breaks_after && is_name_part(&words[end]) {
            end += 1;
        }
        // `Then SoundCloud` is not a two-word name. A capital that a sentence
        // boundary explains, on a word ordinary English already knows, is
        // grammar rather than evidence — so the run starts after it.
        let mut start = i;
        if words[start].sentence_start
            && is_ordinary_word(words[start].core)
            && !words[start].shape.is_distinctive()
            && end - start >= 2
        {
            start += 1;
        }
        let span = &words[start..end];
        let spans_words = end - start;
        if spans_words >= 2 {
            // A capitalised run of entirely ordinary words is a title, not a
            // name: `The Big Idea` teaches the recogniser nothing.
            let informative = span
                .iter()
                .any(|w| w.shape.is_distinctive() || !is_ordinary_word(w.core));
            if informative {
                let text = span.iter().map(|w| w.core).collect::<Vec<_>>().join(" ");
                let strongest = span
                    .iter()
                    .map(|w| shape_score(w, is_ordinary_word(w.core)))
                    .max()
                    .unwrap_or(0);
                // The phrase must out-score every word inside it, or the
                // containment rule in `rank` keeps the fragment and discards
                // the phrase — the wrong way round. So it earns the same
                // bonuses its best part would earn on its own, plus the phrase
                // bonus for the context it adds.
                let uncommon = if span.iter().any(|w| !is_ordinary_word(w.core)) {
                    SCORE_UNCOMMON
                } else {
                    0
                };
                let score = SCORE_PROPER_NOUN + SCORE_PHRASE + strongest + uncommon;
                out.push(Candidate {
                    text,
                    score,
                    first: start,
                    words: spans_words,
                    distinctive: false,
                });
            }
        }
        i = end.max(i + 1);
    }
}

/* ----------------------------- singletons ---------------------------- */

fn collect_singletons(words: &[Word<'_>], out: &mut Vec<Candidate>) {
    for (index, word) in words.iter().enumerate() {
        if word.core.is_empty() || word.shape.letters == 0 {
            continue;
        }
        let shape = word.shape;
        let ordinary = is_ordinary_word(word.core);
        let mut score = shape_score(word, ordinary);

        if shape.hyphenated
            && shape.letters >= 5
            && word
                .core
                .split('-')
                .any(|part| part.len() >= 3 && !is_ordinary_word(part))
        {
            score += SCORE_HYPHENATED;
        }
        // A lone capital is a name only away from the start of its sentence —
        // and only when it is long enough to be one the recogniser could
        // plausibly miss. `Dlamini` and `Saoirse` clear the bar; `Rust` and
        // `Mac` do not, and sending them is how a bias starts writing words
        // nobody said.
        if shape.leading_upper
            && !shape.all_upper
            && !word.sentence_start
            && !ordinary
            && shape.letters >= MIN_PLAIN_NAME_LEN
            && !is_ordinary_capitalised(word.core)
        {
            score += SCORE_PROPER_NOUN;
        }
        // A plain lowercase word with no shape signal is NEVER sent, however
        // rare the word list thinks it is. This class used to be offered when
        // the script repeated it, and every member it ever produced —
        // `backend`, `microphone`, `milliseconds`, `transcribe`, `ingestion`,
        // `onboarding` — is ordinary technical English that no recogniser has
        // trouble with. It bought nothing and, on `technical.md`, cost four of
        // the nine duplications that made that capture worse. The word list is
        // a filter on candidates orthography has already found; it is not
        // itself a reason to send a word.
        if score == 0 {
            continue;
        }
        if !ordinary {
            score += SCORE_UNCOMMON;
        }
        out.push(Candidate {
            text: word.core.to_string(),
            score,
            first: index,
            words: 1,
            distinctive: shape.is_distinctive(),
        });
    }
}

/* -------------------------------------------------------------------------
 * Ranking
 * ---------------------------------------------------------------------- */

/// Score, dedupe, sanitise and cut.
///
/// Repetition is a positive signal and is applied here rather than at
/// collection: a term the script says five times is a term of art, and getting
/// it wrong costs the display five times rather than once.
fn rank(
    candidates: Vec<Candidate>,
    occurrences: &std::collections::BTreeMap<String, u32>,
    limits: VocabLimits,
) -> Vec<String> {
    let mut best: std::collections::BTreeMap<String, Candidate> = std::collections::BTreeMap::new();
    for mut candidate in candidates {
        let Some(text) = sanitize(&candidate.text, limits.max_term_chars) else {
            continue;
        };
        candidate.text = text;
        let repeats = candidate
            .text
            .split(' ')
            .filter_map(|w| occurrences.get(&fold_key(w)))
            .copied()
            .min()
            .unwrap_or(1);
        candidate.score += repeats.min(5) * 5;

        let key = fold_key(&candidate.text);
        match best.get(&key) {
            Some(existing) if existing.score >= candidate.score => {}
            _ => {
                best.insert(key, candidate);
            }
        }
    }

    let mut ranked: Vec<Candidate> = best.into_values().collect();
    // Score first, then authored order. Never hash order — a config frame that
    // differs run to run would make every measurement of this feature noise.
    ranked.sort_by(|a, b| b.score.cmp(&a.score).then(a.first.cmp(&b.first)));

    // A word already inside a kept phrase is not worth its own slot: the bias
    // applies to the phrase's parts anyway, and the slot buys another term.
    let mut kept: Vec<Candidate> = Vec::new();
    let mut total = 0usize;
    for candidate in ranked {
        if kept.len() >= limits.max_terms {
            break;
        }
        // A plain name already carried by a phrase above it does not need its
        // own slot. A distinctive SPELLING does: the phrase may have been a
        // list the tokenizer could not see the commas in, and dropping
        // `PagerDuty` because `SoundCloud PagerDuty` outranked it would lose
        // the term this feature exists to send.
        if candidate.words == 1
            && !candidate.distinctive
            && kept
                .iter()
                .any(|k| k.words > 1 && contains_word(&k.text, &candidate.text))
        {
            continue;
        }
        if total + candidate.text.len() > limits.max_total_chars {
            continue;
        }
        total += candidate.text.len();
        kept.push(candidate);
    }
    kept.into_iter().map(|c| c.text).collect()
}

fn contains_word(phrase: &str, word: &str) -> bool {
    phrase.split(' ').any(|part| part.eq_ignore_ascii_case(word))
}

/// Reduce a term to characters the gateway accepts, or reject it.
///
/// An allowlist, because the failure mode is a rejected config frame and a take
/// that never starts. Letters (including non-ASCII, which is the point of half
/// these terms), digits, single spaces, and the punctuation that appears INSIDE
/// real terms: `.` `,` `'` `-` `:`. Everything else is removed — `$2.4 million`
/// becomes `2.4 million`, which is still the bias worth having.
fn sanitize(raw: &str, max_chars: usize) -> Option<String> {
    let chars: Vec<char> = raw.chars().collect();
    let mut out = String::with_capacity(raw.len());
    for (i, &c) in chars.iter().enumerate() {
        let mapped = match c {
            '\u{2019}' | '\u{02BC}' => '\'',
            '\u{2010}'..='\u{2015}' => '-',
            _ => c,
        };
        if mapped.is_alphabetic()
            || mapped.is_ascii_digit()
            || matches!(mapped, ' ' | '.' | ',' | '\'' | '-' | ':')
        {
            out.push(mapped);
        } else {
            // Removing a character with real text on BOTH sides does not clean
            // the term, it fuses two halves into a word nobody wrote: `R&D`
            // becomes `RD`, `docs.example.com/setup` becomes one long run.
            // A term that cannot survive the allowlist intact is dropped —
            // a missing bias is nothing, a wrong bias is worse than nothing.
            let joins = i > 0
                && chars[i - 1].is_alphanumeric()
                && chars.get(i + 1).is_some_and(|n| n.is_alphanumeric());
            if joins {
                return None;
            }
        }
    }
    // Collapse the runs the removals just created, and drop punctuation that
    // ended up leading or trailing.
    let collapsed = out.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed
        .trim_matches(|c: char| !c.is_alphanumeric())
        .to_string();
    if trimmed.chars().count() > max_chars {
        return None;
    }
    if trimmed.len() < 2 || !trimmed.chars().any(|c| c.is_alphanumeric()) {
        return None;
    }
    Some(trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build tokens from a sentence-per-line fixture, which is how the app
    /// hands them over: one sentence ordinal per sentence.
    fn tokens(lines: &[&str]) -> Vec<(String, u32)> {
        let mut out = Vec::new();
        for (index, line) in lines.iter().enumerate() {
            for word in line.split_whitespace() {
                out.push((word.to_string(), index as u32));
            }
        }
        out
    }

    fn extract(lines: &[&str]) -> Vec<String> {
        let owned = tokens(lines);
        let refs: Vec<VocabToken<'_>> = owned
            .iter()
            .map(|(s, sentence)| VocabToken {
                surface: s,
                sentence: *sentence,
            })
            .collect();
        extract_terms(&refs, VocabLimits::default())
    }

    fn has(terms: &[String], want: &str) -> bool {
        terms.iter().any(|t| t.eq_ignore_ascii_case(want))
    }

    #[test]
    fn the_word_list_is_sorted_and_loads() {
        let words = common_words();
        assert!(words.len() > 8_000, "got {}", words.len());
        assert!(words.windows(2).all(|w| w[0] < w[1]), "asset must stay sorted");
    }

    #[test]
    fn ordinary_english_is_recognised_through_inflection_and_spelling() {
        for word in ["the", "people", "design", "went", "children", "margins"] {
            assert!(is_ordinary_word(word), "{word} should be ordinary");
        }
        // US/UK folding.
        for word in ["colour", "centre", "organisation", "travelling", "programme", "defence"] {
            assert!(is_ordinary_word(word), "{word} should fold to its US spelling");
        }
        // Names and brands must survive the filter — that is its whole job.
        for word in ["saoirse", "dlamini", "rustlight", "pagerduty", "reykjavik", "zimbabwe"] {
            assert!(!is_ordinary_word(word), "{word} must not be filtered out");
        }
    }

    #[test]
    fn compound_brands_and_initialisms_are_offered() {
        let terms = extract(&[
            "We ship with RustLight Games, who were first.",
            "Then SoundCloud, PagerDuty and OpenTable signed.",
            "The rules under GDPR have not changed.",
        ]);
        assert!(has(&terms, "RustLight Games"), "{terms:?}");
        assert!(has(&terms, "SoundCloud"), "{terms:?}");
        assert!(has(&terms, "PagerDuty"), "{terms:?}");
        assert!(has(&terms, "GDPR"), "{terms:?}");
    }

    #[test]
    fn names_are_offered_even_when_they_open_a_sentence() {
        let terms = extract(&[
            "Nkosinathi Dlamini wrote the first prototype.",
            "Growth brought its own characters.",
            "We hired Saoirse from a games studio.",
            "Dagný Þorvaldsdóttir arrived from Reykjavík.",
        ]);
        assert!(has(&terms, "Nkosinathi Dlamini"), "{terms:?}");
        assert!(has(&terms, "Saoirse"), "{terms:?}");
        assert!(has(&terms, "Dagný Þorvaldsdóttir"), "{terms:?}");
        // A capital that is only capitalised because a sentence started there
        // is not a name and must not spend a slot.
        assert!(!has(&terms, "Growth"), "{terms:?}");
        assert!(!has(&terms, "We"), "{terms:?}");
    }

    #[test]
    fn figures_are_offered_in_the_notation_the_script_wrote() {
        let terms = extract(&[
            "I write twenty-seven and it writes 27.",
            "The call is at three thirty every day.",
            "We sample at 24kHz and ship version 3.2.",
            "That is 2.4 million dollars a year.",
        ]);
        assert!(has(&terms, "twenty-seven"), "{terms:?}");
        assert!(has(&terms, "three thirty"), "{terms:?}");
        assert!(has(&terms, "24kHz"), "{terms:?}");
        // A bare decimal is NOT offered: it is not a notation the recogniser
        // gets wrong, and sending it made `technical.md` measurably worse.
        assert!(!has(&terms, "3.2"), "{terms:?}");
        assert!(
            terms.iter().any(|t| t.contains("2.4 million")),
            "{terms:?}"
        );
    }

    #[test]
    fn a_bare_number_is_not_worth_a_slot() {
        let terms = extract(&["We shipped 27 of them and 5 came back."]);
        assert!(!has(&terms, "27"), "{terms:?}");
        assert!(!has(&terms, "5"), "{terms:?}");
    }

    #[test]
    fn a_qualifier_travels_with_its_model_number() {
        let terms = extract(&["The rig runs an RTX 4090 under load."]);
        assert!(has(&terms, "RTX 4090"), "{terms:?}");
    }

    #[test]
    fn ordinary_prose_offers_nothing() {
        let terms = extract(&[
            "Before we get into the roadmap I want to introduce the people who built this.",
            "It is a good idea and we should do it today.",
        ]);
        // `roadmap` is outside the NGSL, so it may appear as a low-scoring
        // plain word; nothing capitalised or ordinary may.
        for unwanted in ["Before", "It", "people", "today", "good"] {
            assert!(!has(&terms, unwanted), "{unwanted} in {terms:?}");
        }
    }

    #[test]
    fn a_plain_name_inside_a_kept_phrase_does_not_take_a_second_slot() {
        let terms = extract(&["The prototype was written by Nkosinathi Dlamini."]);
        assert!(has(&terms, "Nkosinathi Dlamini"), "{terms:?}");
        assert!(!has(&terms, "Dlamini"), "{terms:?}");
    }

    #[test]
    fn a_distinctive_spelling_keeps_its_slot_inside_a_phrase() {
        // The app's tokenizer cannot produce a surface ending in a comma, so a
        // list of brands reaches the extractor looking exactly like one long
        // name. Losing `PagerDuty` to that would be losing the point.
        let owned: Vec<(String, u32)> = "Then SoundCloud PagerDuty and OpenTable signed"
            .split_whitespace()
            .map(|w| (w.to_string(), 0u32))
            .collect();
        let refs: Vec<VocabToken<'_>> = owned
            .iter()
            .map(|(s, sentence)| VocabToken {
                surface: s,
                sentence: *sentence,
            })
            .collect();
        let terms = extract_terms(&refs, VocabLimits::default());
        assert!(has(&terms, "SoundCloud"), "{terms:?}");
        assert!(has(&terms, "PagerDuty"), "{terms:?}");
        assert!(has(&terms, "OpenTable"), "{terms:?}");
    }

    #[test]
    fn punctuation_ends_a_run_where_the_caller_preserved_it() {
        let terms = extract(&["Then SoundCloud, PagerDuty and OpenTable signed."]);
        assert!(
            !terms.iter().any(|t| t.contains(' ') && t.contains("SoundCloud")),
            "a comma-separated list must not become one phrase: {terms:?}"
        );
        assert!(!has(&terms, "Then"), "{terms:?}");
    }

    #[test]
    fn a_term_that_cannot_survive_the_allowlist_is_dropped_not_fused() {
        // Stripping `&` from `R&D` leaves `RD`, which is not a word anyone
        // said and would bias the recogniser towards nonsense.
        let terms = extract(&["The R&D budget sits under the same chain as AT&T used to."]);
        for wrong in ["RD", "ATT"] {
            assert!(!has(&terms, wrong), "{wrong} in {terms:?}");
        }
    }

    #[test]
    fn a_comma_separated_list_of_figures_stays_separate() {
        let terms = extract(&["Twenty-seven, three thirty, 24kHz, 1905."]);
        assert!(has(&terms, "24kHz"), "{terms:?}");
        assert!(!has(&terms, "24kHz 1905"), "{terms:?}");
    }

    #[test]
    fn a_short_spelled_figure_with_a_unit_is_not_worth_a_slot() {
        let terms = extract(&["It ran for two years and grew forty percent."]);
        assert!(!has(&terms, "two years"), "{terms:?}");
        assert!(!has(&terms, "forty percent"), "{terms:?}");
    }

    #[test]
    fn a_plain_lowercase_word_is_never_sent_however_rare_it_looks() {
        // Repetition used to promote these. It was measured and withdrawn: a
        // capture of `technical.md` sent `backend`, `microphone`, `transcribe`
        // and `milliseconds`, and the recogniser wrote each of them one more
        // time than it was said.
        let terms = extract(&[
            "The recogniser writes it down its own way through the backend.",
            "That is what a recogniser does to the backend, in milliseconds.",
        ]);
        for plain in ["recogniser", "backend", "milliseconds"] {
            assert!(!has(&terms, plain), "{plain} in {terms:?}");
        }
    }

    #[test]
    fn short_words_the_recogniser_already_knows_are_not_sent() {
        // Every one of these was duplicated into the transcript by the bias.
        let terms = extract(&[
            "We publish an API and ship an SDK over IPC.",
            "The whole backend is written in Rust by Mac.",
        ]);
        for short in ["API", "SDK", "IPC", "Rust", "Mac"] {
            assert!(!has(&terms, short), "{short} in {terms:?}");
        }
        // Four letters is where an initialism becomes worth the risk.
        let kept = extract(&["Our GDPR posture is reviewed every year."]);
        assert!(has(&kept, "GDPR"), "{kept:?}");
    }

    #[test]
    fn a_bare_figure_is_not_a_notation_worth_biasing() {
        let terms = extract(&[
            "Latency sits at 0.29 and the 95th percentile is fine.",
            "We ship version 3.2 today.",
        ]);
        for bare in ["0.29", "95th", "3.2"] {
            assert!(!has(&terms, bare), "{bare} in {terms:?}");
        }
    }

    #[test]
    fn a_possessive_is_still_ordinary_english() {
        assert!(is_ordinary_word("nobody's"), "possessive must fold to its stem");
        let terms = extract(&["Replacing them is nobody's favourite quarter."]);
        assert!(!has(&terms, "nobody's"), "{terms:?}");
    }

    #[test]
    fn the_constant_tables_are_sorted_for_binary_search() {
        for (name, table) in [
            ("NUMBER_WORDS", NUMBER_WORDS),
            ("UNIT_WORDS", UNIT_WORDS),
            ("ORDINARY_CAPITALISED", ORDINARY_CAPITALISED),
        ] {
            assert!(
                table.windows(2).all(|w| w[0] < w[1]),
                "{name} must stay sorted — it is binary-searched"
            );
        }
    }

    #[test]
    fn rejected_characters_are_stripped_rather_than_sent() {
        // `#`, `/`, `@` and `|` are rejected by the gateway on the config
        // frame, which would cost the whole take.
        let terms = extract(&[
            "Read more at docs.example.com/setup or ping @support.",
            "The build is tagged v2#final for now.",
        ]);
        for term in &terms {
            assert!(
                !term.contains(['#', '/', '@', '|', '$', '%']),
                "unsafe character survived in {term:?}"
            );
        }
    }

    #[test]
    fn currency_keeps_the_amount_and_drops_the_symbol() {
        let owned = tokens(&["It came to $2.4 million last year."]);
        let refs: Vec<VocabToken<'_>> = owned
            .iter()
            .map(|(s, sentence)| VocabToken {
                surface: s,
                sentence: *sentence,
            })
            .collect();
        let terms = extract_terms(&refs, VocabLimits::default());
        assert!(terms.iter().any(|t| t.starts_with("2.4 million")), "{terms:?}");
        assert!(!terms.iter().any(|t| t.contains('$')), "{terms:?}");
    }

    #[test]
    fn output_is_capped_and_deterministic() {
        let mut lines: Vec<String> = Vec::new();
        for i in 0..200 {
            lines.push(format!("Brand{i}Works shipped Zyxwv{i} to Qwerty{i} Ltd."));
        }
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        let first = extract(&refs);
        let second = extract(&refs);
        assert_eq!(first, second, "extraction must be deterministic");
        assert!(first.len() <= VocabLimits::default().max_terms, "{}", first.len());
        let total: usize = first.iter().map(String::len).sum();
        assert!(total <= VocabLimits::default().max_total_chars, "{total}");
    }

    #[test]
    fn markdown_never_offers_a_term_from_something_unspoken() {
        let source = "\
# Heading With CamelCaseHeadingTerm

We ship with RustLight Games.

```
let SecretCodeTerm = 1;
```

::: note
HiddenContainerTerm lives here.
:::

| TableTerm | second |
";
        let terms = extract_from_markdown(source, CompileOptions::default(), VocabLimits::default());
        assert!(has(&terms, "RustLight Games"), "{terms:?}");
        for unspoken in [
            "CamelCaseHeadingTerm",
            "SecretCodeTerm",
            "HiddenContainerTerm",
            "TableTerm",
        ] {
            assert!(!has(&terms, unspoken), "{unspoken} in {terms:?}");
        }
    }

    #[test]
    fn authored_surfaces_keep_the_spelling_the_compiler_throws_away() {
        let source = "We finished with twenty-seven thousand accounts.\n";
        let authored = spoken_surfaces(source, CompileOptions::default());
        assert!(
            authored.iter().any(|w| w.starts_with("twenty-seven")),
            "{authored:?}"
        );
        // The compiled script has already folded it to digits, which is why a
        // spelling comparison cannot be made against compiled atoms.
        let compiled = crate::compile(source, CompileOptions::default());
        assert!(
            compiled.atoms.iter().any(|a| a.surface == "27000"),
            "the compiler is expected to canonicalise this"
        );
    }

    #[test]
    fn an_empty_script_is_an_empty_config() {
        assert!(extract(&[]).is_empty());
        assert!(extract(&["", "   "]).is_empty());
    }
}
