//! Script → recogniser vocabulary bias: the terms a take sends ahead of its
//! audio so the transcript comes back spelled the way the script is written.
//!
//! ---------------------------------------------------------------------------
//! WHAT THIS IS FOR
//! ---------------------------------------------------------------------------
//! A recogniser vocabulary bias is a soft bias — a list of strings that makes
//! the model likelier to write particular words. It is not a keyword lock and
//! it cannot make a wrong word right. What it can do is win the coin-flips the
//! model was going to lose anyway: `RustLight` over `Rust Light`, `Saoirse`
//! over `Sersha`, `twenty-seven` over `27`.
//!
//! **Nothing in the shipping app sends these terms today.** The on-device
//! recogniser can bias toward hotwords, but only under `modified_beam_search`
//! and only with a `bpe.vocab` beside the model, and the bundle ships neither
//! (see `src-tauri/src/commands/speech_cmds.rs::TranscriptionOptions`).
//! Reinstating it is a model-packaging decision. This extractor stays because
//! it is the half of that capability that is already correct and measured — the
//! unit tests below hold it there, and `cc-bench vocab` prints what a script
//! would send — and rewriting it later from nothing would be throwing away the
//! part that was never the problem.
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
//! 2. **Ordinary English**, which is a filter rather than a detector. It
//!    exists to stop the capitalisation rule firing on `Then`, `Monday` or the
//!    `Big Idea` of a title. It is judged from hand-written tables — grammar
//!    words, plus the days, months and titles in `ORDINARY_CAPITALISED` — and
//!    from the script itself: a capital the script also writes in lowercase
//!    is a word, whatever its capital says elsewhere. A name is almost never
//!    written that way, which is the property the filter exists to keep.
//!
//!    There is deliberately no dictionary behind this. A frequency list large
//!    enough to matter carries names (`aaron`, `aaliyah` and `zimbabwe` all
//!    sit in the top 20k of a web ranking), and would quietly suppress exactly
//!    the words this module is here to find.
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
//! A term list is configuration a recogniser reads BEFORE it will accept audio.
//! The recogniser this was measured against refused the configuration outright
//! over a single character outside letters, digits, spaces and basic
//! punctuation — so a bad character did not degrade a take, it prevented one.
//! (What was measured was a one-term list; whether a mixed list would have lost
//! only the bad term was never tested, which is itself a reason not to find
//! out the hard way.) Everything leaving this module goes through [`sanitize`],
//! which is an allowlist, and anything it cannot clean is dropped rather than
//! handed over and hoped for. Whatever consumes these terms next, that is the
//! cheap side of the bet to be on.

use crate::script::{ends_sentence, CompileOptions};

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

/// How much of a term list this may fill.
///
/// Defaults are deliberately modest. `max_terms` is the dilution budget
/// discussed in the module docs; the two character limits exist so that a
/// pathological script — a page of hyphenated chemical names — cannot produce
/// a list large enough to be interesting to whatever is asked to hold it.
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
    let english = OrdinaryEnglish::of(&words);
    let mut candidates: Vec<Candidate> = Vec::new();
    collect_figure_phrases(&words, &mut candidates);
    collect_name_phrases(&words, &english, &mut candidates);
    collect_singletons(&words, &english, &mut candidates);
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

/// Grammar words the alignment stopword profile does not already hold.
///
/// Closed classes only: pronouns, determiners, prepositions, conjunctions,
/// auxiliaries, greetings, and the handful of time words a sentence opens on.
/// A closed class is grammar rather than vocabulary — it can be written down
/// whole and it does not grow — which is what keeps this table from becoming
/// a dictionary again. A word that is as often a noun, a verb or a brand as it
/// is grammar (`even`, `next`, `mine`, `hey`) is left out on purpose: this
/// table is consulted with no context at all, and it decides whether the first
/// word of a sentence belongs to the name after it. Whether `Design` is
/// ordinary is a question for the script's own evidence (see
/// [`OrdinaryEnglish`]), not for a list.
///
/// Read together with [`crate::normalize::is_stopword`], which is deliberately
/// NOT widened for this: it sets alignment weights, and growing it would move
/// the aligner to fix the extractor.
const FUNCTION_WORDS: &[&str] = &[
    "after", "again", "against", "ago", "almost", "along", "already", "although", "always", "am",
    "among", "another", "anybody", "anyone", "anything", "anyway", "anywhere", "around", "because",
    "before", "behind", "below", "beneath", "beside", "besides", "between", "beyond", "both",
    "during", "each", "either", "else", "enough", "ever", "every", "everybody", "everyone",
    "everything", "everywhere", "except", "few", "further", "hello", "hence", "hers", "herself",
    "hi", "him", "himself", "however", "inside", "itself", "least", "less", "many", "maybe", "more",
    "most", "much", "must", "myself", "neither", "never", "nobody", "none", "nor", "nothing",
    "nowhere", "off", "often", "once", "only", "onto", "other", "others", "ought", "ours",
    "ourselves", "outside", "own", "perhaps", "please", "quite", "rather", "same", "several",
    "since", "somebody", "someone", "something", "sometimes", "somewhere", "still", "such",
    "theirs", "themselves", "therefore", "though", "through", "throughout", "thus", "today",
    "together", "tomorrow", "tonight", "too", "toward", "towards", "under", "unless", "until",
    "upon", "whatever", "whenever", "whether", "which", "while", "whom", "whose", "within",
    "without", "yesterday", "yet", "yours", "yourself", "yourselves",
];

/// Endings a possessive or contraction adds to the word wearing it.
///
/// `nobody's` is `nobody` and `doesn't` is `does`. Ordinary English with an
/// apostrophe attached is still ordinary English: `That's SoundCloud` opens
/// on grammar exactly as `That SoundCloud` would.
const CLITICS: &[&str] = &["'s", "'re", "'ve", "'ll", "'d", "'m", "n't"];

/// The negatives whose stem is not the word left by removing `n't`.
const IRREGULAR_NEGATIVES: &[(&str, &str)] =
    &[("can't", "can"), ("shan't", "shall"), ("won't", "will")];

/// The form a word is looked up under, or `None` if it cannot be ordinary.
///
/// Case-insensitive, ASCII-only by definition: a word carrying a letter outside
/// ASCII is never ordinary for this purpose, because that letter is exactly the
/// thing the recogniser is about to get wrong. A lone letter is never ordinary
/// either — `A` and `I` are articles and pronouns, but in `A Smith` it is an
/// initial, and dropping it would cost the name its first half.
fn ordinary_key(word: &str) -> Option<String> {
    let lowered = word
        .trim_matches(|c: char| !c.is_alphanumeric())
        .to_lowercase()
        .replace('\u{2019}', "'");
    let stem = IRREGULAR_NEGATIVES
        .iter()
        .find_map(|(negative, stem)| (*negative == lowered).then_some(*stem))
        .or_else(|| {
            CLITICS
                .iter()
                .find_map(|clitic| lowered.strip_suffix(clitic).filter(|s| !s.is_empty()))
        })
        .unwrap_or(&lowered);
    (stem.len() >= 2 && stem.chars().all(|c| c.is_ascii_lowercase())).then(|| stem.to_string())
}

fn is_function_word(key: &str) -> bool {
    crate::normalize::is_stopword(key) || FUNCTION_WORDS.binary_search(&key).is_ok()
}

/// Is `word` ordinary English in ANY script — grammar no recogniser needs
/// teaching?
///
/// Deliberately narrow: `FUNCTION_WORDS` and the stopword profile, and nothing
/// else. `people` and `design` are not in it and do not need to be — a plain
/// lowercase word is never sent anyway, and a capitalised one is judged against
/// the script's own lowercase uses by `OrdinaryEnglish`. What this answers is
/// the part no script can: whether `Then`, opening a sentence in front of
/// `SoundCloud`, is grammar or the first half of a name.
pub fn is_ordinary_word(word: &str) -> bool {
    ordinary_key(word).is_some_and(|key| is_function_word(&key))
}

/// Ordinary English for ONE script: the grammar words, plus every plain word
/// the script itself writes in lowercase — ASCII letters and apostrophes, so
/// never a compound, a figure or an identifier.
///
/// The second half is evidence standing in for a corpus, and it speaks only to
/// CAPITALS. `The Big Idea` is a title when the same script talks about "a big
/// idea", and `IMPORTANT` is emphasis when it also says "important"; `Saoirse`
/// stays a name because a script does not write `saoirse`. What a lowercase
/// word cannot vouch for is English: `onnx` is lowercase because that is how
/// it is spelled. So the two places that ask "is this English?" rather than
/// "is this capital a word?" — trimming the word that opens a sentence, and
/// judging the parts of a lowercase compound — ask [`is_ordinary_word`] and
/// never this.
///
/// Matched on the spelling, up to case and the [`CLITICS`] above. No suffix is
/// stripped and no spelling is folded, because both invent relationships the
/// script never made: `Miller` is not `mill`, and a witness that has to be
/// argued for is not a witness.
///
/// What it cannot see is a name the script also writes as a word (`Harvest`
/// beside `harvest`), or an ordinary capital the script never repeats in
/// lowercase. The first loses the name's proper-noun score, though never a
/// spelling score — `RustLight` beside `rustlight` keeps its internal capital.
/// The second sends a capital that a dictionary would have cleared, which is
/// the direction a filter without one has to err in.
struct OrdinaryEnglish {
    witnessed: std::collections::BTreeSet<String>,
}

impl OrdinaryEnglish {
    fn of(words: &[Word<'_>]) -> Self {
        let witnessed = words
            .iter()
            .filter(|w| {
                w.core
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c == '\'' || c == '\u{2019}')
            })
            .filter_map(|w| ordinary_key(w.core))
            .collect();
        Self { witnessed }
    }

    fn contains(&self, word: &str) -> bool {
        ordinary_key(word)
            .is_some_and(|key| is_function_word(&key) || self.witnessed.contains(&key))
    }
}

/// Capitalised words that are ordinary despite being proper nouns.
///
/// A script rarely writes a day, a month or a title in lowercase, so its own
/// evidence cannot be relied on to clear one, and without this table `Monday`
/// would look exactly like `Nkosinathi`. It is consulted for a single word —
/// the proper-noun and initialism scores — not for a whole name phrase. Short
/// and hand-written: every entry is here because it is a capitalised word a
/// presenter says without needing help.
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
fn collect_name_phrases(
    words: &[Word<'_>],
    english: &OrdinaryEnglish,
    out: &mut Vec<Candidate>,
) {
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
        // boundary explains, on a word that is grammar, is not evidence — so
        // the run starts after it. Grammar alone may decide this, not the
        // script's lowercase words: the script writing `figma` says nothing
        // about whether `Figma Studio` opening a sentence is a brand.
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
                .any(|w| w.shape.is_distinctive() || !english.contains(w.core));
            if informative {
                let text = span.iter().map(|w| w.core).collect::<Vec<_>>().join(" ");
                let strongest = span
                    .iter()
                    .map(|w| shape_score(w, english.contains(w.core)))
                    .max()
                    .unwrap_or(0);
                // The phrase must out-score every word inside it, or the
                // containment rule in `rank` keeps the fragment and discards
                // the phrase — the wrong way round. So it earns the same
                // bonuses its best part would earn on its own, plus the phrase
                // bonus for the context it adds.
                let uncommon = if span.iter().any(|w| !english.contains(w.core)) {
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

fn collect_singletons(words: &[Word<'_>], english: &OrdinaryEnglish, out: &mut Vec<Candidate>) {
    for (index, word) in words.iter().enumerate() {
        if word.core.is_empty() || word.shape.letters == 0 {
            continue;
        }
        let shape = word.shape;
        let ordinary = english.contains(word.core);
        let mut score = shape_score(word, ordinary);

        // Grammar alone judges the parts: a lowercase witness says how a word
        // is spelled, not that it is English (see `OrdinaryEnglish`).
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
        // rare it looks. This class used to be offered when
        // the script repeated it, and every member it ever produced —
        // `backend`, `microphone`, `milliseconds`, `transcribe`, `ingestion`,
        // `onboarding` — is ordinary technical English that no recogniser has
        // trouble with. It bought nothing and, on `technical.md`, cost four of
        // the nine duplications that made that capture worse. Ordinary English
        // is a filter on candidates orthography has already found; being
        // outside it is not itself a reason to send a word.
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
    // Score first, then authored order. Never hash order — a term list that
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

/// Reduce a term to characters a recogniser will accept, or reject it.
///
/// An allowlist, because the failure mode is a rejected term list and a take
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
    fn grammar_is_ordinary_in_any_script_and_names_never_are() {
        for word in ["the", "Then", "nobody", "Through", "today", "doesn't", "We're", "won't"] {
            assert!(is_ordinary_word(word), "{word} should be ordinary");
        }
        // A lone letter is an initial as often as it is a word: `A Smith`.
        for initial in ["A", "I"] {
            assert!(!is_ordinary_word(initial), "{initial} may be an initial");
        }
        // A content word is not grammar. Whether `design` is ordinary is the
        // script's call, made by `OrdinaryEnglish`, never this table's.
        for word in ["people", "design", "children"] {
            assert!(!is_ordinary_word(word), "{word} is not a function word");
        }
        // Names and brands must survive the filter — that is its whole job.
        for word in ["saoirse", "dlamini", "rustlight", "pagerduty", "reykjavik", "zimbabwe"] {
            assert!(!is_ordinary_word(word), "{word} must not be filtered out");
        }
    }

    #[test]
    fn a_title_the_script_also_says_in_lowercase_is_not_a_name() {
        let terms = extract(&[
            "Every team has a big idea it never ships.",
            "Ours was called The Big Idea and Saoirse built it.",
        ]);
        for title in ["The Big Idea", "Big Idea"] {
            assert!(!has(&terms, title), "{title} in {terms:?}");
        }
        // The same evidence can never clear a name: nobody writes `saoirse`.
        assert!(has(&terms, "Saoirse"), "{terms:?}");
    }

    #[test]
    fn emphasis_is_not_an_initialism_when_the_script_uses_the_word() {
        let terms = extract(&[
            "This part is IMPORTANT, so read it twice.",
            "The important thing is that GDPR still applies.",
        ]);
        assert!(!has(&terms, "IMPORTANT"), "{terms:?}");
        assert!(has(&terms, "GDPR"), "{terms:?}");
    }

    #[test]
    fn a_lowercase_compound_is_cleared_by_grammar_alone() {
        // Saying `sherpa-onnx` twice is not saying `sherpa` and `onnx`; if a
        // compound witnessed its parts, every compound would clear itself.
        let terms = extract(&[
            "We run the model through sherpa-onnx on the laptop.",
            "Every take goes through sherpa-onnx and nothing else.",
        ]);
        assert!(has(&terms, "sherpa-onnx"), "{terms:?}");
        // Nor do the parts said on their own: `onnx` is lowercase because
        // that is how it is spelled, not because it is English.
        let terms = extract(&["The sherpa runtime loads onnx graphs, hence sherpa-onnx."]);
        assert!(has(&terms, "sherpa-onnx"), "{terms:?}");
        // A compound of grammar words is grammar.
        let terms = extract(&["We are somewhere in-between today."]);
        assert!(!has(&terms, "in-between"), "{terms:?}");
    }

    #[test]
    fn a_lowercase_word_never_trims_a_name_that_opens_a_sentence() {
        // `figma` written in lowercase is how the brand is spelled, not
        // evidence that `Figma` opening a sentence is grammar.
        let terms = extract(&["We design everything in figma.", "Figma Studio ships the files."]);
        assert!(has(&terms, "Figma Studio"), "{terms:?}");
    }

    #[test]
    fn a_witness_matches_the_spelling_not_the_stem() {
        let terms = extract(&["We hired Miller to run the mill."]);
        assert!(has(&terms, "Miller"), "{terms:?}");
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
        // A capital that opens a sentence is evidence of nothing and a plain
        // lowercase word is never sent, so ordinary prose offers nothing at
        // all — not even `roadmap`, which no table of grammar words knows.
        assert!(terms.is_empty(), "{terms:?}");
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
        assert!(is_ordinary_word("nobody\u{2019}s"), "a curly apostrophe is still one");
        let terms = extract(&["Replacing them is nobody's favourite quarter."]);
        assert!(!has(&terms, "nobody's"), "{terms:?}");
    }

    #[test]
    fn the_constant_tables_are_sorted_for_binary_search() {
        for (name, table) in [
            ("NUMBER_WORDS", NUMBER_WORDS),
            ("UNIT_WORDS", UNIT_WORDS),
            ("ORDINARY_CAPITALISED", ORDINARY_CAPITALISED),
            ("FUNCTION_WORDS", FUNCTION_WORDS),
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

    /// The loop the caller will actually close once bias returns: whatever this
    /// extractor nominates is what the decoder is told, so the same list has to
    /// land on script atoms when handed straight back.
    ///
    /// It is not obvious that it would. Terms come out in the authored spelling
    /// and the compiler works in canonical atoms, so a term that survives
    /// extraction but not normalisation would mark nothing at all — and would do
    /// so silently, leaving a jump gate that believes its evidence was
    /// unsolicited.
    #[test]
    fn extracted_terms_mark_the_atoms_they_came_from() {
        use crate::script::{compile, FLAG_BIASED};

        let source = "RustLight Games shipped the harbour release. \
             The release raised twenty-seven million.";
        let terms = extract_from_markdown(source, CompileOptions::default(), VocabLimits::default());
        assert!(
            terms.iter().any(|t| t.contains("RustLight")),
            "fixture no longer exercises a multi-word term: {terms:?}"
        );

        let mut script = compile(source, CompileOptions::default());
        script.set_biased_terms(&terms);

        let marked: Vec<&str> = script
            .atoms
            .iter()
            .filter(|a| a.flags & FLAG_BIASED != 0)
            .map(|a| a.surface.as_str())
            .collect();
        assert!(marked.contains(&"rustlight"), "marked: {marked:?}");
        assert!(marked.contains(&"games"), "marked: {marked:?}");
        // The extractor emits the whole figure phrase, which is exactly why
        // forwarding its output unmodified survives the compiler folding
        // `twenty-seven million` into one atom.
        assert!(marked.contains(&"27000000"), "marked: {marked:?}");
        // Ordinary words the extractor declined are left alone, so the discount
        // stays aimed at the words bias would actually have boosted.
        assert!(!marked.contains(&"shipped"), "marked: {marked:?}");
        assert!(!marked.contains(&"the"), "marked: {marked:?}");
    }
}
