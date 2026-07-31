//! Canonical text normalisation — the ONE normaliser both sides share.
//!
//! Script text and transcript text must pass through exactly the same
//! pipeline, otherwise the compiler and the tracker develop different opinions
//! about what a word is (the historical "0 of 26" failure class). The pipeline
//! is:
//!
//! 1. Unicode-aware lowercasing and punctuation stripping (apostrophes kept
//!    inside words, hyphens split words).
//! 2. Contraction expansion (`can't` → `can not`, `it's` → `it is`).
//! 3. Digit-token cleanup (`1,000` → `1000`, `$12` → `12 dollars`,
//!    `50%` → `50 percent`, ordinal digits → ordinal words).
//! 4. Inverse text normalisation of spelled-out numbers
//!    (`forty two` → `42`, `nineteen eighty four` → `1984`,
//!    `twelve point five` → `12.5`) so a script that writes digits matches a
//!    recogniser that writes words and vice versa — both land on the digit
//!    form.
//!
//! The output is a flat sequence of canonical atom strings. Everything
//! downstream (weights, anchors, alignment) operates on these atoms.

use crate::language::{
    AlignmentLanguage, CurrencyOrder, NormalizationProfile, PhoneticPolicy,
};

/// The English profile, for the free functions that predate per-language
/// normalisation.
///
/// These wrappers exist because `cc-bench` measures an English corpus and
/// reaches for the normaliser directly — computing word error rate, scoring
/// corpus difficulty. They are NOT a default for the engine: everything on the
/// production path takes its language from the compiled script (see
/// [`crate::script::CompiledScript::language`]), because a normaliser that
/// silently assumes English is precisely how a French model produces a green
/// test suite and a stage that does not follow.
fn english() -> &'static NormalizationProfile {
    AlignmentLanguage::English.profile()
}

/// English only. Callers that may see another language want
/// [`is_filler_for`].
pub fn is_filler(atom: &str) -> bool {
    english().is_filler(atom)
}

pub fn is_filler_for(language: AlignmentLanguage, atom: &str) -> bool {
    language.profile().is_filler(atom)
}

/// Minimum length for a word to carry a phonetic key at all. Short words
/// collide constantly and the relation is a last resort, not a first guess.
const MIN_PHONETIC_LEN: usize = 5;

/// A word's phonetic encoding, packed for comparison without allocating.
///
/// Used ONLY as a last-resort relation for rare, meaty words (names):
/// recognisers mangle unusual spellings far beyond edit distance ("Saoirse" →
/// "Sawersi"), but the consonant skeleton usually survives. Never applied to
/// common words — phonetic collisions on frequent vocabulary are noise, not
/// signal.
///
/// Empty when the word is too short to be worth encoding, which is what makes
/// [`PhoneticKey::matches`] safe to call on anything.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PhoneticKey {
    /// Was this word encoded at all? An explicit flag rather than a reserved
    /// value in `primary`: the first slot holds either a small consonant code
    /// or the first character cast to `u8`, and that cast is lossy — a word
    /// beginning `Ā` (U+0100) casts to exactly 0, so a sentinel of
    /// `primary[0] == 0` would quietly declare a real encoding "not encoded"
    /// and disable the relation for it. Canonical atoms are lowercased, which
    /// makes that unreachable today; `phonetic_key` is public, so "unreachable
    /// today" is not the same as safe.
    filled: bool,
    primary: [u8; 4],
    alternate: [u8; 4],
}

impl PhoneticKey {
    pub fn is_empty(&self) -> bool {
        !self.filled
    }

    /// Do these two words sound alike?
    ///
    /// Two slots because an encoder may offer a second reading for a word whose
    /// pronunciation is genuinely ambiguous; a match on either counts. The
    /// current encoder fills both with the same key.
    pub fn matches(&self, other: &PhoneticKey) -> bool {
        if self.is_empty() || other.is_empty() {
            return false;
        }
        let prefix3 = |a: &[u8; 4], b: &[u8; 4]| {
            a[2] != 0 && b[2] != 0 && a[..3] == b[..3]
        };
        self.primary == other.primary
            || self.primary == other.alternate
            || self.alternate == other.primary
            || self.alternate == other.alternate
            // Long unusual words frequently agree on the leading consonant
            // skeleton but diverge in the fourth slot because the recogniser
            // compresses a middle syllable ("Worcestershire" →
            // "Worstushier"). Phonetic evidence is already restricted to
            // rare anchor-grade words and cannot relocate on its own, so a
            // three-slot prefix is an appropriate recall-oriented fallback.
            || prefix3(&self.primary, &other.primary)
            || prefix3(&self.primary, &other.alternate)
            || prefix3(&self.alternate, &other.primary)
            || prefix3(&self.alternate, &other.alternate)
    }
}

/// Encode a word, or nothing if it is too short to be worth encoding.
///
/// Double Metaphone was tried here (the `rphonetic` crate) and measurably lost:
/// identical on the synthetic corpus, 0.15–0.17 pp worse on every live accuracy
/// row. This relation is a last resort carrying a low weight, so its job is
/// RECALL — catching "Saoirse" heard as "Sawersi" at all — and a more precise
/// algorithm that correctly separates "presenter" from "president" trades away
/// matches the looser skeleton was getting for free. Precision it does not
/// need, bought with recall it does. (It also panics on any non-ASCII input,
/// which is the one input class this relation exists for.)
/// English only. Callers that may see another language want
/// [`phonetic_key_for`].
pub fn phonetic_key(word: &str) -> PhoneticKey {
    phonetic_key_for(AlignmentLanguage::English, word)
}

/// The sounds-alike key for `word` under `language`'s phonetic policy.
///
/// A language whose policy is [`PhoneticPolicy::Disabled`] produces an empty
/// key, which [`PhoneticKey::matches`] already treats as "never matches". The
/// relation therefore switches off on BOTH sides together, so nothing that
/// used to match becomes a mismatch — which is what makes it safe to leave
/// unanswered.
pub fn phonetic_key_for(language: AlignmentLanguage, word: &str) -> PhoneticKey {
    match language.profile().phonetics {
        PhoneticPolicy::EnglishSkeleton => english_skeleton(word),
        PhoneticPolicy::Disabled => PhoneticKey::default(),
    }
}

fn english_skeleton(word: &str) -> PhoneticKey {
    // Bytes, not characters, because that is what the inline version measured
    // and this was meant to be a pure move. Counting characters instead would
    // have quietly dropped the relation for short international names —
    // `josé` is four characters and five bytes — which is a behaviour change
    // dressed up as a refactor.
    if word.len() < MIN_PHONETIC_LEN {
        return PhoneticKey::default();
    }
    let mut key = [0u8; 4];
    let mut n = 0;
    let mut last_code = 0u8;
    for (i, c) in word.chars().enumerate() {
        let code = match c.to_ascii_lowercase() {
            'b' | 'f' | 'p' | 'v' => 1,
            'c' | 'g' | 'j' | 'k' | 'q' | 's' | 'x' | 'z' => 2,
            'd' | 't' => 3,
            'l' => 4,
            'm' | 'n' => 5,
            'r' => 6,
            _ => 0, // vowels, h, w, y, non-ASCII
        };
        if i == 0 {
            // Code-class the first position too: classic Soundex keeps the
            // raw letter, which misses c/k ("CandidCue" → "Kandik") — the
            // exact confusion recognisers produce.
            key[0] = if code != 0 {
                code
            } else {
                c.to_ascii_lowercase() as u8
            };
            n = 1;
            last_code = code;
            continue;
        }
        if code != 0 && code != last_code {
            if n < 4 {
                key[n] = code;
                n += 1;
            } else {
                break;
            }
        }
        if code != 0 || !matches!(c.to_ascii_lowercase(), 'h' | 'w') {
            last_code = code;
        }
    }
    PhoneticKey {
        filled: true,
        primary: key,
        alternate: key,
    }
}

/// English only. Callers that may see another language want
/// [`is_stopword_for`].
pub fn is_stopword(atom: &str) -> bool {
    english().is_stopword(atom)
}

pub fn is_stopword_for(language: AlignmentLanguage, atom: &str) -> bool {
    language.profile().is_stopword(atom)
}

/// Normalise a run of text into canonical atoms, as English.
///
/// English only. The engine calls [`canonical_atoms_for`] with the language its
/// script was compiled in; this wrapper is for the benchmark tooling, which
/// measures an English corpus.
pub fn canonical_atoms(text: &str) -> Vec<String> {
    canonical_atoms_for(AlignmentLanguage::English, text)
}

/// Normalise a run of text into canonical atoms under `language`.
///
/// This is the only entry point; there is deliberately no "script variant" or
/// "transcript variant" of this function. Script text and transcript text pass
/// through it with the SAME language — which is not a convention the caller has
/// to remember, because the language is stored on the compiled script and both
/// sides read it from there.
pub fn canonical_atoms_for(language: AlignmentLanguage, text: &str) -> Vec<String> {
    let profile = language.profile();
    let mut words: Vec<String> = Vec::new();
    for raw in text.split_whitespace() {
        split_word(raw, profile, &mut words);
    }
    let mut atoms = if profile.spelled_numbers {
        itn_numbers(&words)
    } else {
        words
    };
    reorder_currency(&mut atoms, profile);
    expand_units(&mut atoms, profile);
    atoms
}

/// `$2.4 million` is said "two point four million dollars".
///
/// The symbol is written at the front of the amount and the unit is spoken at
/// the end of it, after the scale word. Emitting `dollars` where the symbol
/// stood left a transcript holding `2.4 dollars million` against a script
/// holding `2.4 million dollars`: the same three atoms, in an order that
/// matches nothing.
/// The word order itself is the per-language decision, not just the list:
/// [`CurrencyOrder`] says whether the unit follows the scale word at all.
fn reorder_currency(atoms: &mut [String], profile: &NormalizationProfile) {
    if profile.currency_order != CurrencyOrder::UnitAfterScale || atoms.len() < 3 {
        return;
    }
    for i in 1..atoms.len() - 1 {
        if !atoms[i - 1].starts_with(|c: char| c.is_ascii_digit()) {
            continue;
        }
        if profile.currency_units.contains(&atoms[i].as_str())
            && profile.scale_words.contains(&atoms[i + 1].as_str())
        {
            atoms.swap(i, i + 1);
        }
    }
}

/// Unit abbreviations, rewritten as the word that is actually said.
///
/// A script writes `24kHz` and `250ms`; the reader says "twenty-four kilohertz"
/// and the recogniser writes it out in full. Both sides expand, so the two meet
/// in the middle the same way spelled numbers do.
///
/// Only ever after a number. `250 ms` is a duration; `Ms Okonkwo` is a person,
/// and rewriting her name to "milliseconds" would invent a mismatch out of a
/// perfectly good match.
/// The abbreviations are shared across these languages; the spelled forms are
/// not. A profile that left this list English would not merely miss a match —
/// it would put the atom `milliseconds` into a French script, which the reader
/// is never going to say.
fn expand_units(atoms: &mut [String], profile: &NormalizationProfile) {
    for i in 1..atoms.len() {
        if !atoms[i - 1].starts_with(|c: char| c.is_ascii_digit()) {
            continue;
        }
        if let Some((_, spelled)) = profile
            .unit_words
            .iter()
            .find(|(abbrev, _)| *abbrev == atoms[i])
        {
            atoms[i] = (*spelled).to_string();
        }
    }
}

/// Stage 1+2+3: one whitespace-delimited chunk → zero or more word atoms.
fn split_word(raw: &str, profile: &NormalizationProfile, out: &mut Vec<String>) {
    /*
     * `&` is a WORD, and it is read aloud as "and" — in English. It is `et`,
     * `und` and `y` elsewhere, which is why the word comes from the profile
     * rather than sitting here as a literal.
     *
     * It used to be filtered out with the rest of the punctuation, which was a
     * quiet disagreement with the app's own tokenizer: that one emits `&` as a
     * spoken token (`R & D` is three tokens there), so the app rendered a word
     * the engine had no atom for. Nothing crashed — the token axis simply
     * skipped it — but the transcriber says "and" and there was nothing for it
     * to match, and in the degenerate case of a script whose only spoken token
     * is `&` the compiled script had no atoms at all.
     *
     * Rewriting it as a hyphen-delimited word reuses the compound path
     * exactly, so `AT&T` becomes `at and t` — which is what a recogniser
     * actually returns for it — and a bare `&` becomes `and`.
     */
    let expanded;
    let raw = match profile.ampersand {
        Some(word) if raw.contains('&') => {
            expanded = raw.replace('&', &format!("-{word}-"));
            expanded.as_str()
        }
        _ => raw,
    };

    // Currency prefix is remembered, stripped, and re-emitted as a trailing
    // word: `$12` → `12 dollars`, matching how it is read aloud.
    let mut currency: Option<&'static str> = None;
    let mut percent = false;

    // Strip outer punctuation, keep word-internal apostrophes and hyphens.
    let trimmed: String = raw
        .chars()
        .filter_map(|c| match c {
            '%' => {
                percent = true;
                None
            }
            // Last symbol in a token wins, as it always has.
            _ if profile.currency_symbols.iter().any(|(s, _)| *s == c) => {
                currency = profile
                    .currency_symbols
                    .iter()
                    .find(|(s, _)| *s == c)
                    .map(|(_, word)| *word);
                None
            }
            // Unicode apostrophes to ASCII so the contraction table matches.
            '\u{2019}' | '\u{02BC}' => Some('\''),
            // En/em dashes act as separators.
            '\u{2013}' | '\u{2014}' => Some('-'),
            /*
             * Colons and slashes separate words exactly the way a hyphen does.
             * They used to be filtered out with the rest of the punctuation,
             * which did not remove them so much as GLUE what they separated:
             * a recogniser writing `3:30` produced the atom `330`, a number
             * nobody says, and the script's own `three thirty` (`3`, `30`)
             * could never match it. Same for `2/3`, `28/07`, `and/or`.
             */
            ':' | '/' => Some('-'),
            c if c.is_alphanumeric() || c == '\'' || c == '-' || c == '.' || c == ',' => Some(c),
            _ => None,
        })
        .collect();

    // Hyphenated compounds are read as separate words.
    for piece in trimmed.split('-') {
        let piece = piece.trim_matches(|c: char| c == '\'' || c == '.' || c == ',');
        if piece.is_empty() {
            continue;
        }
        emit_piece(piece, profile, out);
    }

    // `%` is one atom in English and two in French and Spanish, so the profile
    // supplies a slice rather than a word.
    if percent {
        for word in profile.percent {
            out.push((*word).into());
        }
    }
    if let Some(unit) = currency {
        out.push(unit.into());
    }
}

fn emit_piece(piece: &str, profile: &NormalizationProfile, out: &mut Vec<String>) {
    let decimal = profile.decimal_separator;
    let group = profile.group_separator;

    // Pure number token: drop the grouping separator, keep the decimal one.
    //
    // Which character is which is the whole of the per-language decision here,
    // and getting it wrong is not a missed match. English `12,500` is twelve
    // and a half thousand and German `12,5` is twelve and a half; read with the
    // wrong convention the second one becomes the atom `125`, a number nobody
    // said.
    if piece
        .chars()
        .all(|c| c.is_ascii_digit() || c == group || c == decimal)
    {
        let digits: String = piece
            .chars()
            .filter(|c| *c != group)
            .map(|c| if c == decimal { '.' } else { c })
            .collect();
        let digits = digits.trim_matches('.');
        if !digits.is_empty() {
            out.push(digits.to_string());
        }
        return;
    }

    // Ordinal digits (`2nd`, `21st`) → ordinal words, the way they are read.
    if profile.ordinals {
        if let Some(words) = ordinal_digits_to_words(piece) {
            for w in words {
                out.push(w);
            }
            return;
        }
    }

    // Mixed alphanumeric like `24kHz` splits at the digit/letter boundary:
    // `24 khz`. Recognisers do the same.
    let mut current = String::new();
    let mut current_is_digit: Option<bool> = None;
    let lower = piece.to_lowercase();
    for c in lower.chars() {
        let is_digit = c.is_ascii_digit();
        if c == decimal || c == group {
            // Interior punctuation inside an alpha word (e.g. `u.s.a`) is
            // dropped; inside digits it was handled above.
            if current_is_digit == Some(true) && c == decimal {
                current.push('.');
            }
            continue;
        }
        match current_is_digit {
            Some(prev) if prev != is_digit => {
                flush(&mut current, profile, out);
                current_is_digit = Some(is_digit);
            }
            None => current_is_digit = Some(is_digit),
            _ => {}
        }
        if c == '\'' {
            current.push('\'');
        } else {
            current.push(c);
        }
    }
    flush(&mut current, profile, out);
}

fn flush(current: &mut String, profile: &NormalizationProfile, out: &mut Vec<String>) {
    if current.is_empty() {
        return;
    }
    let word = std::mem::take(current);
    let word = word.trim_matches('\'');
    if word.is_empty() {
        return;
    }
    if profile.contractions {
        expand_contraction(word, out);
    } else {
        // Elisions (`l'arbre`, `qu'il`) pass through untouched, which is safe
        // because BOTH sides pass through untouched: the script and the
        // recogniser write the same surface and still match each other. What
        // is lost is only the case where the two spell it differently.
        out.push(word.into());
    }
}

/// Contraction expansion. Both sides expand, so `cannot`, `can't` and
/// `can not` all land on `can not`. Ambiguous `'s` (is/has/possessive) is
/// expanded to `is` only for the pronoun-ish set where that is nearly always
/// right; other `'s` forms keep the suffix attached (`greg's` stays `greg's`),
/// which is fine because the recogniser writes the same surface.
fn expand_contraction(word: &str, out: &mut Vec<String>) {
    const TABLE: &[(&str, &[&str])] = &[
        ("can't", &["can", "not"]),
        ("cannot", &["can", "not"]),
        ("won't", &["will", "not"]),
        ("shan't", &["shall", "not"]),
        ("n't", &[]), // generic fallback handled below
        ("let's", &["let", "us"]),
        ("it's", &["it", "is"]),
        ("that's", &["that", "is"]),
        ("what's", &["what", "is"]),
        ("there's", &["there", "is"]),
        ("here's", &["here", "is"]),
        ("he's", &["he", "is"]),
        ("she's", &["she", "is"]),
        ("who's", &["who", "is"]),
        ("i'm", &["i", "am"]),
        ("gonna", &["going", "to"]),
        ("wanna", &["want", "to"]),
        ("gotta", &["got", "to"]),
    ];
    for (pat, expansion) in TABLE {
        if *pat != "n't" && word == *pat {
            for w in *expansion {
                out.push((*w).into());
            }
            return;
        }
    }
    // Generic suffix rules.
    if let Some(stem) = word.strip_suffix("n't") {
        if !stem.is_empty() {
            out.push(stem.into());
            out.push("not".into());
            return;
        }
    }
    for (suffix, expansion) in [
        ("'ll", "will"),
        ("'re", "are"),
        ("'ve", "have"),
        ("'d", "would"),
        ("'m", "am"),
    ] {
        if let Some(stem) = word.strip_suffix(suffix) {
            if !stem.is_empty() {
                out.push(stem.into());
                out.push(expansion.into());
                return;
            }
        }
    }
    out.push(word.into());
}

fn ordinal_digits_to_words(piece: &str) -> Option<Vec<String>> {
    if !piece.is_ascii() || piece.len() < 3 {
        return None;
    }
    let lower = piece.to_lowercase();
    let (digits, suffix) = lower.split_at(lower.len().saturating_sub(2));
    if !matches!(suffix, "st" | "nd" | "rd" | "th") || digits.is_empty() {
        return None;
    }
    let n: u32 = digits.parse().ok()?;
    ordinal_words(n)
}

fn ordinal_words(n: u32) -> Option<Vec<String>> {
    const SMALL: &[&str] = &[
        "zeroth", "first", "second", "third", "fourth", "fifth", "sixth",
        "seventh", "eighth", "ninth", "tenth", "eleventh", "twelfth",
        "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth",
        "eighteenth", "nineteenth", "twentieth",
    ];
    const TENS_ORD: &[(u32, &str)] = &[
        (30, "thirtieth"),
        (40, "fortieth"),
        (50, "fiftieth"),
        (60, "sixtieth"),
        (70, "seventieth"),
        (80, "eightieth"),
        (90, "ninetieth"),
    ];
    const TENS: &[(u32, &str)] = &[
        (20, "twenty"),
        (30, "thirty"),
        (40, "forty"),
        (50, "fifty"),
        (60, "sixty"),
        (70, "seventy"),
        (80, "eighty"),
        (90, "ninety"),
    ];
    if (n as usize) < SMALL.len() {
        return Some(vec![SMALL[n as usize].into()]);
    }
    for (v, w) in TENS_ORD {
        if n == *v {
            return Some(vec![(*w).into()]);
        }
    }
    if n < 100 {
        let tens = n / 10 * 10;
        let unit = n % 10;
        let tens_word = TENS.iter().find(|(v, _)| *v == tens)?.1;
        let unit_word = SMALL.get(unit as usize)?;
        return Some(vec![tens_word.into(), (*unit_word).into()]);
    }
    None
}

// ---------------------------------------------------------------------------
// Inverse text normalisation of spelled-out numbers.
// ---------------------------------------------------------------------------

fn unit_value(w: &str) -> Option<u64> {
    const UNITS: &[(&str, u64)] = &[
        ("zero", 0),
        ("one", 1),
        ("two", 2),
        ("three", 3),
        ("four", 4),
        ("five", 5),
        ("six", 6),
        ("seven", 7),
        ("eight", 8),
        ("nine", 9),
        ("ten", 10),
        ("eleven", 11),
        ("twelve", 12),
        ("thirteen", 13),
        ("fourteen", 14),
        ("fifteen", 15),
        ("sixteen", 16),
        ("seventeen", 17),
        ("eighteen", 18),
        ("nineteen", 19),
    ];
    UNITS.iter().find(|(s, _)| *s == w).map(|(_, v)| *v)
}

fn tens_value(w: &str) -> Option<u64> {
    const TENS: &[(&str, u64)] = &[
        ("twenty", 20),
        ("thirty", 30),
        ("forty", 40),
        ("fifty", 50),
        ("sixty", 60),
        ("seventy", 70),
        ("eighty", 80),
        ("ninety", 90),
    ];
    TENS.iter().find(|(s, _)| *s == w).map(|(_, v)| *v)
}

fn is_scale_word(w: &str) -> bool {
    matches!(w, "hundred" | "thousand" | "million" | "billion")
}

fn is_number_word(w: &str) -> bool {
    unit_value(w).is_some() || tens_value(w).is_some() || is_scale_word(w)
}

/// Does `one` here head a number, or is it the pronoun-ish word?
///
/// A lone `one` is left alone on purpose — "one of the reasons" is not the
/// numeral 1, and converting it would cost exact matches on every page. But
/// `one point two` IS the numeral, and leaving it alone left the transcript
/// holding `one point 2` against a script holding `1.2`: three atoms against
/// one, right where the reader is saying a figure out loud.
fn heads_a_decimal(words: &[String]) -> bool {
    words.len() >= 3
        && words[1] == "point"
        && unit_value(&words[2]).is_some_and(|v| v <= 9)
}

/// Is this `and` inside one number, or between two of them?
///
/// `one hundred and five` and `two thousand and nineteen` are single numbers,
/// and a recogniser writes both `2019` and the words. `between one thousand and
/// two thousand` is two numbers, and folding it to 3000 would put the
/// transcript on a figure the script never says. The tell is the tail: the part
/// after a number's `and` is its remainder — under a hundred, and never
/// carrying a scale word of its own.
fn bridges_a_number(current: u64, total: u64, tail: &[String]) -> bool {
    let Some(head) = tail.first() else {
        return false;
    };
    if !is_number_word(head) {
        return false;
    }
    // `one hundred and five`: the hundreds are still in `current`.
    if current > 0 && current % 100 == 0 {
        return true;
    }
    // `two thousand and nineteen`: the multiplier moved the value to `total`
    // and left `current` empty.
    if current != 0 || total == 0 {
        return false;
    }
    let (value, consumed, _) = parse_number_phrase(tail);
    consumed > 0 && value < 100 && !tail.get(consumed).is_some_and(|w| is_scale_word(w))
}

/// Collapse spelled-out number word runs to digit strings.
///
/// `forty two` → `42`; `one hundred and five` → `105`; `nineteen eighty
/// four` → `1984` (year join); `twelve point five` → `12.5`. A lone `one` is
/// left alone — it is far more often the pronoun-ish word than a numeral, and
/// converting it would cost exact matches everywhere.
fn itn_numbers(words: &[String]) -> Vec<String> {
    // `a hundred and twenty` is `one hundred and twenty` said at speed, and
    // recognisers write it both ways. Rewriting the article in front of a scale
    // word is the whole of the difference between the two spellings.
    //
    // Copied only when there is something to rewrite: this runs on every
    // partial of every item, and almost no sentence contains the pattern.
    let rewritten: Vec<String>;
    let words = if words
        .windows(2)
        .any(|pair| pair[0] == "a" && is_scale_word(&pair[1]))
    {
        rewritten = words
            .iter()
            .enumerate()
            .map(|(i, w)| {
                if w == "a" && words.get(i + 1).is_some_and(|next| is_scale_word(next)) {
                    "one".to_string()
                } else {
                    w.clone()
                }
            })
            .collect();
        &rewritten[..]
    } else {
        words
    };

    let mut out = Vec::with_capacity(words.len());
    let mut i = 0;
    while i < words.len() {
        let w = words[i].as_str();
        if !is_number_word(w) || w == "hundred" || w == "thousand" {
            out.push(words[i].clone());
            i += 1;
            continue;
        }
        // Greedily consume a number phrase, allowing interior "and".
        let (value, consumed, year_style) = parse_number_phrase(&words[i..]);
        if consumed == 0 || (consumed == 1 && w == "one" && !heads_a_decimal(&words[i..])) {
            out.push(words[i].clone());
            i += 1;
            continue;
        }
        let mut rendered = value.to_string();
        let _ = year_style;
        // Decimal tail: `point` + digit words.
        let mut j = i + consumed;
        if j < words.len() && words[j] == "point" {
            let mut frac = String::new();
            let mut k = j + 1;
            while k < words.len() {
                if let Some(v) = unit_value(&words[k]) {
                    if v <= 9 {
                        frac.push_val(v);
                        k += 1;
                        continue;
                    }
                }
                break;
            }
            if !frac.is_empty() {
                rendered.push('.');
                rendered.push_str(&frac);
                j = k;
            }
        }
        out.push(rendered);
        i = j;
    }
    out
}

trait PushVal {
    fn push_val(&mut self, v: u64);
}
impl PushVal for String {
    fn push_val(&mut self, v: u64) {
        self.push((b'0' + v as u8) as char);
    }
}

/// Parse the longest number phrase at the head of `words`.
/// Returns (value, tokens consumed, was year-style).
fn parse_number_phrase(words: &[String]) -> (u64, usize, bool) {
    // Standard grammar: [units|tens[-units]] [hundred] [and] ... [thousand] ...
    let mut total: u64 = 0;
    let mut current: u64 = 0;
    let mut i = 0;
    let mut consumed_any = false;
    while i < words.len() {
        let w = words[i].as_str();
        if let Some(v) = unit_value(w) {
            let low = current % 100;
            let merges = current == 0            // fresh group
                || current % 100 == 0            // `one hundred` + `five`
                || (v <= 9 && low >= 20 && low % 10 == 0); // `forty` + `two`
            if consumed_any && !merges {
                break; // `nineteen` + `eighty` → year join handles it below
            }
            current += v;
            consumed_any = true;
            i += 1;
        } else if let Some(v) = tens_value(w) {
            let merges = current == 0 || current % 100 == 0; // `one hundred` + `twenty`
            if consumed_any && !merges {
                break;
            }
            current += v;
            consumed_any = true;
            i += 1;
        } else if w == "hundred" && consumed_any && current > 0 && current < 100 {
            current *= 100;
            i += 1;
        } else if (w == "thousand" || w == "million" || w == "billion") && consumed_any {
            let mult = match w {
                "thousand" => 1_000,
                "million" => 1_000_000,
                _ => 1_000_000_000,
            };
            total += current.max(1) * mult;
            current = 0;
            i += 1;
        } else if w == "and" && consumed_any && bridges_a_number(current, total, &words[i + 1..]) {
            i += 1;
        } else {
            break;
        }
    }
    if !consumed_any {
        return (0, 0, false);
    }
    let mut value = total + current;
    let mut consumed = i;

    // Year join: `nineteen eighty four` = [19] [84], `twenty twenty six` =
    // [20] [26]. Detect a 10..=99 head immediately followed by another number
    // phrase worth 0..=99 that standard grammar refused to merge.
    let mut year = false;
    if value >= 10 && value <= 99 && consumed < words.len() {
        // `nineteen oh five`. The zero is spoken as a letter, so no number
        // parser sees it and the year fell apart into `19 oh 5` — three atoms
        // where the script has one.
        if matches!(words[consumed].as_str(), "oh" | "o") {
            if let Some(unit) = words.get(consumed + 1).and_then(|w| unit_value(w)) {
                let joined = value * 100 + unit;
                if unit <= 9 && (1000..=2999).contains(&joined) {
                    return (joined, consumed + 2, true);
                }
            }
        }
        let (tail, tail_consumed, _) = parse_number_phrase(&words[consumed..]);
        if tail_consumed > 0 && tail < 100 {
            // `oh` isn't handled; only join when the tail is 2 digits or a
            // bare unit following a tens (e.g. eighty + four already merged).
            let joined = value * 100 + tail;
            if (1000..=2999).contains(&joined) {
                value = joined;
                consumed += tail_consumed;
                year = true;
            }
        }
    }
    (value, consumed, year)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn atoms(s: &str) -> Vec<String> {
        canonical_atoms(s)
    }

    #[test]
    fn lowercases_and_strips_punctuation() {
        assert_eq!(atoms("Hello, World!"), vec!["hello", "world"]);
        assert_eq!(atoms("“Smart quotes.”"), vec!["smart", "quotes"]);
    }

    #[test]
    fn contractions_expand_on_both_sides() {
        assert_eq!(atoms("can't"), vec!["can", "not"]);
        assert_eq!(atoms("cannot"), vec!["can", "not"]);
        assert_eq!(atoms("can not"), vec!["can", "not"]);
        assert_eq!(atoms("it's we'll I'm"), vec!["it", "is", "we", "will", "i", "am"]);
        assert_eq!(atoms("don't"), vec!["do", "not"]);
    }

    #[test]
    fn hyphens_split() {
        assert_eq!(atoms("real-time"), vec!["real", "time"]);
        assert_eq!(atoms("state-of-the-art"), vec!["state", "of", "the", "art"]);
    }

    #[test]
    fn digits_and_spelled_numbers_meet_in_the_middle() {
        assert_eq!(atoms("forty two"), vec!["42"]);
        assert_eq!(atoms("forty-two"), vec!["42"]);
        assert_eq!(atoms("42"), vec!["42"]);
        assert_eq!(atoms("1,000"), vec!["1000"]);
        assert_eq!(atoms("one thousand"), vec!["1000"]);
        assert_eq!(atoms("one hundred and five"), vec!["105"]);
        assert_eq!(atoms("twelve point five"), vec!["12.5"]);
        assert_eq!(atoms("12.5"), vec!["12.5"]);
    }

    #[test]
    fn years_join() {
        assert_eq!(atoms("nineteen eighty four"), vec!["1984"]);
        assert_eq!(atoms("twenty twenty six"), vec!["2026"]);
        assert_eq!(atoms("1984"), vec!["1984"]);
    }

    #[test]
    fn currency_and_percent() {
        assert_eq!(atoms("$12"), vec!["12", "dollars"]);
        assert_eq!(atoms("50%"), vec!["50", "percent"]);
        assert_eq!(atoms("fifty percent"), vec!["50", "percent"]);
    }

    #[test]
    fn ordinals_from_digits() {
        assert_eq!(atoms("2nd"), vec!["second"]);
        // `21st` → `twenty first` → ITN folds the tens word → `20 first`.
        // Spoken `twenty-first` takes the same path, so both sides agree.
        assert_eq!(atoms("21st"), vec!["20", "first"]);
        assert_eq!(atoms("twenty-first"), vec!["20", "first"]);
        assert_eq!(atoms("second"), vec!["second"]);
    }

    #[test]
    fn lone_one_is_not_a_numeral() {
        assert_eq!(atoms("one of the reasons"), vec!["one", "of", "the", "reasons"]);
        // …but it is when a decimal follows it.
        assert_eq!(atoms("one point two seconds"), vec!["1.2", "seconds"]);
        assert_eq!(atoms("1.2 seconds"), vec!["1.2", "seconds"]);
    }

    /// Every pair here is the same sentence written by the script on one side
    /// and by the recogniser on the other. They must land on the same atoms.
    #[test]
    fn the_two_spellings_of_a_figure_meet() {
        let same = |script: &str, heard: &str| {
            assert_eq!(atoms(script), atoms(heard), "{script:?} vs {heard:?}");
        };
        same("three thirty in the afternoon", "3:30 in the afternoon");
        same("nine fifteen", "9:15");
        same("2019", "two thousand and nineteen");
        same("2024", "two thousand and twenty four");
        same("1905", "nineteen oh five");
        same("one hundred and twenty", "a hundred and twenty");
        same("2.4 million dollars", "$2.4 million");
        same("1.6 million dollars", "$1.6 million");
        same("24kHz", "24 kilohertz");
        same("250ms", "250 milliseconds");
    }

    /// The `and` that joins two numbers is not the `and` inside one.
    #[test]
    fn and_between_two_numbers_does_not_fuse_them() {
        assert_eq!(
            atoms("between one thousand and two thousand"),
            vec!["between", "1000", "and", "2000"]
        );
        assert_eq!(atoms("two thousand and nineteen"), vec!["2019"]);
    }

    #[test]
    fn colons_and_slashes_separate_rather_than_glue() {
        assert_eq!(atoms("3:30"), vec!["3", "30"]);
        assert_eq!(atoms("and/or"), vec!["and", "or"]);
        assert_eq!(atoms("2/3"), vec!["2", "3"]);
        // A sentence colon is trailing punctuation, not a separator with
        // anything on the far side of it.
        assert_eq!(atoms("three moments: the tease"), vec!["3", "moments", "the", "tease"]);
    }

    /// A unit abbreviation is only a unit when a number precedes it.
    #[test]
    fn units_expand_only_after_a_number() {
        assert_eq!(atoms("24kHz"), vec!["24", "kilohertz"]);
        assert_eq!(atoms("Ms Okonkwo"), vec!["ms", "okonkwo"]);
        assert_eq!(atoms("kg of it"), vec!["kg", "of", "it"]);
    }

    #[test]
    fn mixed_alphanumerics_split() {
        // The split itself, on a suffix that is not a known unit.
        assert_eq!(atoms("4090s"), vec!["4090", "s"]);
        assert_eq!(atoms("H100"), vec!["h", "100"]);
        // A known unit splits the same way and is then spoken in full.
        assert_eq!(atoms("24kHz"), vec!["24", "kilohertz"]);
    }

    /// The relation must not switch itself off for a word it did encode.
    #[test]
    fn an_encoded_word_is_never_mistaken_for_an_unencoded_one() {
        // `Ā` is U+0100; cast to `u8` it is exactly 0, which is what the old
        // sentinel read as "empty".
        // `ἀθήνα` is the reachable case: already lowercase, so it survives
        // canonicalisation unchanged, and its first character U+1F00 has a low
        // byte of exactly zero.
        for word in ["ἀθήνα", "Ābcdef", "ōtautahi", "joaquín", "przemysław", "teleprompter"] {
            assert!(
                !phonetic_key(word).is_empty(),
                "{word} encoded but reported empty"
            );
        }
        // The eligibility test is byte length, as it always was: `josé` is
        // four characters but five bytes and still encodes.
        assert!(!phonetic_key("josé").is_empty());
        // Too short to encode, and honest about it.
        assert!(phonetic_key("cat").is_empty());
        assert!(!phonetic_key("cat").matches(&phonetic_key("cot")));
    }

    #[test]
    fn fillers_and_stopwords_classified() {
        assert!(is_filler("um"));
        assert!(!is_filler("like"));
        assert!(is_stopword("the"));
        assert!(!is_stopword("teleprompter"));
    }

    /// The English constants moved out of this file and into a profile, and
    /// these are the atoms they must still produce.
    ///
    /// Written out in full ON PURPOSE. The obvious version of this test —
    /// asserting `canonical_atoms(t) == canonical_atoms_for(English, t)` — is
    /// worthless, because the wrapper simply CALLS the profile version: it
    /// compares a function to itself and would pass just as happily if every
    /// filler, unit and currency word had been changed. A test that cannot
    /// fail is worse than no test, because it implies coverage that is not
    /// there.
    ///
    /// The benchmark's English baselines (`ahead_worst` 6.700, `within5`
    /// 94.03, `gate.unread_never_spoken` 2.903) were all measured against the
    /// old constants. They remain evidence for anything only while these atoms
    /// are exactly these atoms.
    #[test]
    fn english_still_produces_the_atoms_the_baselines_were_measured_on() {
        // One case per rule the profile now owns.
        let cases: &[(&str, &[&str])] = &[
            // segmentation + punctuation
            ("Hello, World!", &["hello", "world"]),
            // currency symbol, decimal point, grouping comma, percent, and the
            // scale-word reordering all in one line
            (
                "It's a $2.4 million round, up 12.5% from 1,000.",
                &[
                    "it", "is", "a", "2.4", "million", "dollars", "round", "up",
                    "12.5", "percent", "from", "1000",
                ],
            ),
            // unit words, spelled out the way they are said
            (
                "24kHz at 250ms over 5km",
                &["24", "kilohertz", "at", "250", "milliseconds", "over", "5", "kilometres"],
            ),
            // ampersand as a spoken word
            ("R&D at AT&T", &["r", "and", "d", "at", "at", "and", "t"]),
            // Ordinal digits. `21st` expands to "twenty first" and then the
            // spelled-number pass folds the "twenty" to `20`, because it is
            // not followed by another number word. Ungainly, and correct
            // where it counts: a recogniser writing "twenty first" lands on
            // exactly the same two atoms, which is the entire point of
            // normalising both sides through one pipeline.
            ("the 2nd and the 21st", &["the", "second", "and", "the", "20", "first"]),
            // spelled-number ITN, including the year join
            ("nineteen eighty four", &["1984"]),
            ("forty two", &["42"]),
            ("one hundred and five", &["105"]),
            ("twelve point five", &["12.5"]),
            // contractions, both table and suffix rules
            ("She can't and won't", &["she", "can", "not", "and", "will", "not"]),
            ("I'm going to, they've gone", &["i", "am", "going", "to", "they", "have", "gone"]),
            // the other two currencies
            ("£50 and €20", &["50", "pounds", "and", "20", "euros"]),
        ];

        for (text, expected) in cases {
            assert_eq!(
                canonical_atoms(text),
                *expected,
                "English normalisation changed for {text:?} — if this is \
                 deliberate, every Tier B and Tier C baseline needs re-measuring"
            );
        }
    }

    /// The English profile's data, asserted directly.
    ///
    /// The atom test above covers the rules that fire on text; this covers the
    /// lists themselves, so silently dropping a filler or a stopword is caught
    /// even though no single sentence would reveal it.
    #[test]
    fn the_english_profile_still_holds_the_constants_it_replaced() {
        let p = AlignmentLanguage::English.profile();

        assert_eq!(
            p.fillers,
            ["um", "uh", "uhm", "erm", "er", "ah", "hm", "hmm", "mm", "mhm"]
        );
        assert_eq!(p.stopwords.len(), 89, "the stopword list changed size");
        for word in ["the", "a", "and", "of", "to", "is", "not", "me"] {
            assert!(p.is_stopword(word), "{word} must still be a stopword");
        }
        // The words the original list deliberately EXCLUDED, because they are
        // real script words.
        for word in ["like", "presenter", "so"] {
            assert!(!p.is_filler(word), "{word} must not be a filler");
        }

        assert_eq!(p.currency_units, ["dollars", "pounds", "euros"]);
        assert_eq!(p.percent, ["percent"]);
        assert_eq!(p.unit_words.len(), 14);
        assert_eq!(p.ampersand, Some("and"));
        assert!(p.contractions && p.spelled_numbers && p.ordinals);
    }

    /// Why switching the phonetic relation off is safe.
    ///
    /// Named for what it actually establishes. It does NOT exercise
    /// [`PhoneticPolicy::Disabled`] end to end, because no language selects
    /// that policy yet — English is the only profile, and it encodes. What it
    /// does establish is the property the `SafeEmpty` disposition rests on:
    /// an empty key is inert in BOTH directions, so when a future profile
    /// switches the relation off, script and transcript stop producing keys
    /// together and nothing that used to match becomes a mismatch.
    #[test]
    fn an_empty_phonetic_key_is_inert_in_both_directions() {
        let profile = AlignmentLanguage::English.profile();
        assert_eq!(profile.phonetics, PhoneticPolicy::EnglishSkeleton);

        // English still encodes, which is the behaviour every benchmark row
        // was measured against.
        let key = phonetic_key_for(AlignmentLanguage::English, "worcestershire");
        assert!(!key.is_empty());
        assert!(key.matches(&phonetic_key_for(
            AlignmentLanguage::English,
            "worstushier"
        )));

        let empty = PhoneticKey::default();
        assert!(empty.is_empty());
        assert!(!empty.matches(&key));
        assert!(!key.matches(&empty));
        // Including against another empty one — two words the relation has
        // given up on are not thereby evidence that they sound alike.
        assert!(!empty.matches(&empty));
    }

    /// The decimal separator is the rule the issue did not name and the one
    /// that produces a WRONG number rather than a missed match. English is
    /// asserted here; the failure it guards against is a profile that groups
    /// and points with the same character.
    #[test]
    fn english_groups_with_commas_and_points_with_periods() {
        assert_eq!(atoms("1,000"), vec!["1000"]);
        assert_eq!(atoms("12.5"), vec!["12.5"]);
        assert_eq!(atoms("1,234.5"), vec!["1234.5"]);

        let english = AlignmentLanguage::English.profile();
        assert_eq!(english.group_separator, ',');
        assert_eq!(english.decimal_separator, '.');
        // A profile that used one character for both would silently make
        // `12,5` into `125`; `supplies` refuses it.
        assert!(english.supplies(crate::language::LanguageRule::DecimalSyntax));
    }
}
