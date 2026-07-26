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

/// Fillers: transcript insertions that are cheap to skip and carry zero
/// positional evidence. Kept deliberately short — `so`/`like`/`well` are real
/// script words and must NOT be here.
const FILLERS: &[&str] = &[
    "um", "uh", "uhm", "erm", "er", "ah", "hm", "hmm", "mm", "mhm",
];

/// Function words that carry little locating power. They still align (an
/// ordered run of stopwords is real evidence) but mismatching or deleting one
/// is cheap, and one can never be a global anchor.
const STOPWORDS: &[&str] = &[
    "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "is",
    "are", "was", "were", "be", "been", "being", "it", "that", "this", "these",
    "those", "i", "you", "we", "they", "he", "she", "my", "your", "our",
    "their", "his", "her", "its", "as", "by", "for", "with", "from", "so",
    "do", "does", "did", "have", "has", "had", "will", "would", "can",
    "could", "should", "shall", "may", "might", "not", "no", "yes", "if",
    "then", "than", "there", "here", "what", "when", "where", "who", "how",
    "why", "all", "any", "some", "just", "also", "very", "now", "well", "oh",
    "okay", "up", "down", "out", "about", "into", "over", "us", "them", "me",
];

pub fn is_filler(atom: &str) -> bool {
    FILLERS.contains(&atom)
}

/// Compact Soundex-style phonetic key. Used ONLY as a last-resort relation
/// for rare, meaty words (names): recognisers mangle unusual spellings far
/// beyond edit distance ("Saoirse" → "Sawersi"), but the consonant skeleton
/// usually survives. Never applied to common words — phonetic collisions on
/// frequent vocabulary are noise, not signal.
pub fn phonetic_key(word: &str) -> [u8; 4] {
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
            key[0] = c.to_ascii_lowercase() as u8;
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
    key
}

pub fn is_stopword(atom: &str) -> bool {
    STOPWORDS.contains(&atom)
}

/// Normalise a run of text into canonical atoms.
///
/// This is the only entry point; there is deliberately no "script variant" or
/// "transcript variant" of this function.
pub fn canonical_atoms(text: &str) -> Vec<String> {
    let mut words: Vec<String> = Vec::new();
    for raw in text.split_whitespace() {
        split_word(raw, &mut words);
    }
    itn_numbers(&words)
}

/// Stage 1+2+3: one whitespace-delimited chunk → zero or more word atoms.
fn split_word(raw: &str, out: &mut Vec<String>) {
    // Currency prefix is remembered, stripped, and re-emitted as a trailing
    // word: `$12` → `12 dollars`, matching how it is read aloud.
    let mut currency: Option<&'static str> = None;
    let mut percent = false;

    // Strip outer punctuation, keep word-internal apostrophes and hyphens.
    let trimmed: String = raw
        .chars()
        .filter_map(|c| match c {
            '$' => {
                currency = Some("dollars");
                None
            }
            '£' => {
                currency = Some("pounds");
                None
            }
            '€' => {
                currency = Some("euros");
                None
            }
            '%' => {
                percent = true;
                None
            }
            // Unicode apostrophes to ASCII so the contraction table matches.
            '\u{2019}' | '\u{02BC}' => Some('\''),
            // En/em dashes act as separators.
            '\u{2013}' | '\u{2014}' => Some('-'),
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
        emit_piece(piece, out);
    }

    if percent {
        out.push("percent".into());
    }
    if let Some(unit) = currency {
        out.push(unit.into());
    }
}

fn emit_piece(piece: &str, out: &mut Vec<String>) {
    // Pure number token: strip grouping commas, keep decimal point.
    if piece.chars().all(|c| c.is_ascii_digit() || c == ',' || c == '.') {
        let digits: String = piece.chars().filter(|c| *c != ',').collect();
        let digits = digits.trim_matches('.');
        if !digits.is_empty() {
            out.push(digits.to_string());
        }
        return;
    }

    // Ordinal digits (`2nd`, `21st`) → ordinal words, the way they are read.
    if let Some(words) = ordinal_digits_to_words(piece) {
        for w in words {
            out.push(w);
        }
        return;
    }

    // Mixed alphanumeric like `24kHz` splits at the digit/letter boundary:
    // `24 khz`. Recognisers do the same.
    let mut current = String::new();
    let mut current_is_digit: Option<bool> = None;
    let lower = piece.to_lowercase();
    for c in lower.chars() {
        let is_digit = c.is_ascii_digit();
        if c == '.' || c == ',' {
            // Interior punctuation inside an alpha word (e.g. `u.s.a`) is
            // dropped; inside digits it was handled above.
            if current_is_digit == Some(true) && c == '.' {
                current.push('.');
            }
            continue;
        }
        match current_is_digit {
            Some(prev) if prev != is_digit => {
                flush(&mut current, out);
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
    flush(&mut current, out);
}

fn flush(current: &mut String, out: &mut Vec<String>) {
    if current.is_empty() {
        return;
    }
    let word = std::mem::take(current);
    let word = word.trim_matches('\'');
    if word.is_empty() {
        return;
    }
    expand_contraction(word, out);
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

fn is_number_word(w: &str) -> bool {
    unit_value(w).is_some()
        || tens_value(w).is_some()
        || matches!(w, "hundred" | "thousand" | "million" | "billion")
}

/// Collapse spelled-out number word runs to digit strings.
///
/// `forty two` → `42`; `one hundred and five` → `105`; `nineteen eighty
/// four` → `1984` (year join); `twelve point five` → `12.5`. A lone `one` is
/// left alone — it is far more often the pronoun-ish word than a numeral, and
/// converting it would cost exact matches everywhere.
fn itn_numbers(words: &[String]) -> Vec<String> {
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
        if consumed == 0 || (consumed == 1 && w == "one") {
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
        } else if w == "and" && consumed_any && current % 100 == 0 && current > 0 {
            // `one hundred and five` — only mid-number "and".
            if i + 1 < words.len() && is_number_word(&words[i + 1]) {
                i += 1;
            } else {
                break;
            }
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
    }

    #[test]
    fn mixed_alphanumerics_split() {
        assert_eq!(atoms("24kHz"), vec!["24", "khz"]);
    }

    #[test]
    fn fillers_and_stopwords_classified() {
        assert!(is_filler("um"));
        assert!(!is_filler("like"));
        assert!(is_stopword("the"));
        assert!(!is_stopword("teleprompter"));
    }
}
