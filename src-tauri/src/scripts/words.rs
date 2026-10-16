//! Spoken-word extraction from Markdown source (spec §21.8).
//!
//! The authoritative compiler is TypeScript (`src/shared/markdown/compile.ts`)
//! and runs in the frontend worker. This module is its Rust counterpart for the
//! one job that has no renderer in the loop: the Library's word count, duration
//! estimate, preview and search text, which are derived on create, save,
//! import, duplicate, external-edit adoption and startup reconciliation.
//!
//! "Use spoken tokens, not raw Markdown tokens" (§21.8) means agreeing with the
//! compiler about what a word is, so this is a port of its spoken rules rather
//! than a Markdown-to-text approximation:
//!
//! - words are matched with the compiler's own token pattern (`tokenize.ts`),
//!   so punctuation is never a word and `snake_case` is two;
//! - `[Cue: …]`, `[Take: …]`, `[Pause]`, `[Beat]` and `[Breathe]` are
//!   directives, not speech; `Word{say="…"}` and `:::spoken` speak their
//!   spoken form;
//! - comments, raw HTML, code, tables and `:::silent`/`:::stage` content are
//!   silent; headings, image alt text and inline code follow the script's
//!   settings;
//! - list markers, quote markers and setext underlines are structure.
//!
//! It is a bounded CommonMark reading, not a second parser: block structure,
//! emphasis, links and HTML are recognised in the forms scripts actually use.
//! `tests/fixtures/markdown/spoken-counts.json` is asserted against both
//! implementations, word for word, and is where a disagreement belongs when
//! one turns up. Known, accepted differences are listed at the bottom of this
//! file.

use std::sync::LazyLock;

use regex::Regex;

/// Version of this extraction, recorded on every row it derives
/// (`scripts.last_compile_version`). Startup reconciliation re-derives any row
/// stamped with a different value, so changing what counts as speech means
/// bumping this — otherwise existing libraries keep the old numbers until each
/// script happens to be saved again.
pub const SPOKEN_STATS_VERSION: &str = "spoken-stats-2";

/// The compiler's accepted speaking-rate range (`clampWpm` in `compile.ts`).
const MIN_WORDS_PER_MINUTE: u32 = 70;
const MAX_WORDS_PER_MINUTE: u32 = 220;

/// Options mirroring the per-script settings that affect spoken content.
#[derive(Debug, Clone, Copy, Default)]
pub struct SpokenTextOptions {
    pub read_headings: bool,
    pub read_image_alt_text: bool,
    pub read_inline_code: bool,
}

/// What a script says, as the Library sees it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SpokenText {
    /// What the presenter will say: authored punctuation kept, spoken aliases
    /// expanded, whitespace collapsed. Feeds the preview, search and the
    /// plain-text export.
    pub plain: String,
    /// The spoken words in order — the surfaces of the compiler's
    /// `spokenTokens`, which is what its word count counts.
    pub tokens: Vec<String>,
}

impl SpokenText {
    pub fn word_count(&self) -> u32 {
        self.tokens.len() as u32
    }
}

/// Extract the spoken text and words of a Markdown script.
pub fn spoken_text(source: &str, options: SpokenTextOptions) -> SpokenText {
    let mut collector = Collector::default();
    BlockWalker::new(source, options, &mut collector).run();
    collector.finish()
}

/// The spoken text alone (plain-text export).
pub fn spoken_plain_text(source: &str, options: SpokenTextOptions) -> String {
    spoken_text(source, options).plain
}

/// Estimated duration in whole seconds. The rate is clamped to the range the
/// compiler accepts, so the Library and the editor agree on a script whose
/// setting is out of range instead of one of them dividing by it raw.
pub fn estimated_duration_seconds(words: u32, wpm: u32) -> u32 {
    if words == 0 {
        return 0;
    }
    let wpm = wpm.clamp(MIN_WORDS_PER_MINUTE, MAX_WORDS_PER_MINUTE);
    ((words as f64 / wpm as f64) * 60.0).round() as u32
}

/// Short library preview — the leading spoken text, cut on a word boundary.
///
/// It used to slice at exactly 200 characters and append the ellipsis wherever
/// that landed, which was usually mid-word: the library showed "…whether the
/// text scrolls smoothly and rem…". A broken word is a worse identifier than a
/// shorter whole one, because the eye stops at the fragment instead of finishing
/// the sentence — and this string is the only thing distinguishing two scripts
/// that share a title.
pub fn preview_text(plain: &str) -> String {
    const LIMIT: usize = 200;
    if plain.chars().count() <= LIMIT {
        return plain.to_string();
    }
    let head: String = plain.chars().take(LIMIT).collect();
    // Back up to the last space so the preview ends on a whole word. With no
    // space in 200 characters the text is one unbroken run — a URL, or a script
    // in a language that does not space its words — and the hard cut is the only
    // thing left to do.
    let boundary = head.rfind(char::is_whitespace).unwrap_or(0);
    let trimmed = head[..boundary].trim_end();
    let body = if trimmed.is_empty() {
        head.trim_end()
    } else {
        trimmed
    };
    format!("{body}…")
}

/* ------------------------------------------------------------------ */
/* Words                                                                */
/* ------------------------------------------------------------------ */

/// `TOKEN_PATTERN` from `tokenize.ts`, character for character. A word starts
/// with a letter, digit or currency/`#` sign and runs through the characters
/// that occur inside words; a lone `&` is a word. Every alternative ends on a
/// letter, digit or `%`, so the compiler's trailing `.`/`,` trim can never fire
/// and has no counterpart here.
static TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[\p{L}\p{N}$£€#][\p{L}\p{N}.,'’\-%&]*[\p{L}\p{N}%]|[\p{L}\p{N}]|&")
        .expect("token pattern")
});

/// Characters that may sit between two source-adjacent runs without starting a
/// new word (`INLINE_DELIMITERS`): `**Candid**Cue` is said as one word.
const MAX_DELIMITER_GAP: usize = 8;

fn is_source_adjacent(src: &str, from: usize, to: usize) -> bool {
    if to == from {
        return true;
    }
    if to < from || to - from > MAX_DELIMITER_GAP {
        return false;
    }
    src.get(from..to)
        .is_some_and(|gap| gap.chars().all(|c| matches!(c, '*' | '_' | '~' | '`')))
}

fn ends_with_whitespace(text: &str) -> bool {
    text.chars().next_back().is_some_and(char::is_whitespace)
}

fn starts_with_whitespace(text: &str) -> bool {
    text.chars().next().is_some_and(char::is_whitespace)
}

struct TokenDraft {
    surface: String,
    /// End of the token in the draft's spoken text.
    text_end: usize,
    /// Produced by a spoken alias; never absorbs a following run.
    is_override: bool,
}

/// One block's spoken stream — the compiler's `BlockDraft.spokenText` and its
/// tokens, built the same way (`appendSpoken`, `appendOverrideTokens`).
#[derive(Default)]
struct Draft {
    text: String,
    tokens: Vec<TokenDraft>,
    /// Where the last spoken run ended in the block's source text, or `None`
    /// once something unspoken has interrupted the word run.
    last_end: Option<usize>,
}

impl Draft {
    /// Append a spoken run. `src_start..src_end` is where it sits in the
    /// block's source text: a run that follows the previous one across nothing
    /// but emphasis delimiters continues its last word.
    fn append(&mut self, src: &str, text: &str, src_start: usize, src_end: usize) {
        if text.is_empty() {
            return;
        }
        let adjacent = self
            .last_end
            .is_some_and(|end| is_source_adjacent(src, end, src_start));
        if !self.text.is_empty() && !ends_with_whitespace(&self.text) && !adjacent {
            self.text.push(' ');
        }
        let base = self.text.len();
        let merge = adjacent
            && !starts_with_whitespace(text)
            && self
                .tokens
                .last()
                .is_some_and(|last| !last.is_override && last.text_end == base);
        self.text.push_str(text);
        for (i, found) in TOKEN.find_iter(text).enumerate() {
            if i == 0 && merge && found.start() == 0 {
                let last = self.tokens.last_mut().expect("merge target exists");
                last.surface.push_str(found.as_str());
                last.text_end = base + found.end();
                continue;
            }
            self.tokens.push(TokenDraft {
                surface: found.as_str().to_string(),
                text_end: base + found.end(),
                is_override: false,
            });
        }
        self.last_end = Some(src_end);
    }

    /// A spoken alias (§23.4): the `say` words are spoken in place of the
    /// visual ones. A `say` with no words in it falls back to the visual text.
    fn append_override(&mut self, visual: &str, say: &str) {
        if !self.text.is_empty() && !ends_with_whitespace(&self.text) {
            self.text.push(' ');
        }
        let base = self.text.len();
        let say_words = TOKEN.find_iter(say).count();
        let (spoken, is_override) = if say_words == 0 {
            (visual, false)
        } else {
            (say, true)
        };
        self.text.push_str(spoken);
        for found in TOKEN.find_iter(spoken) {
            self.tokens.push(TokenDraft {
                surface: found.as_str().to_string(),
                text_end: base + found.end(),
                is_override,
            });
        }
        self.last_end = None;
    }

    fn hard_break(&mut self) {
        self.text.push(' ');
        self.last_end = None;
    }

    fn interrupt(&mut self) {
        self.last_end = None;
    }
}

/// The whole document's spoken text, assembled from its blocks.
#[derive(Default)]
struct Collector {
    plain: String,
    tokens: Vec<String>,
}

impl Collector {
    fn push(&mut self, draft: Draft) {
        // A block with no words (a cue on its own line, an image, a lone dash)
        // has nothing for the presenter to say and nothing for the preview.
        if draft.tokens.is_empty() {
            return;
        }
        if !self.plain.is_empty() {
            self.plain.push(' ');
        }
        self.plain.push_str(&draft.text);
        self.tokens
            .extend(draft.tokens.into_iter().map(|token| token.surface));
    }

    fn finish(self) -> SpokenText {
        SpokenText {
            plain: collapse_whitespace(&self.plain),
            tokens: self.tokens,
        }
    }
}

fn collapse_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last_space = true;
    for c in text.chars() {
        if c.is_whitespace() {
            if !last_space {
                out.push(' ');
                last_space = true;
            }
        } else {
            out.push(c);
            last_space = false;
        }
    }
    out.trim_end().to_string()
}

/* ------------------------------------------------------------------ */
/* Text nodes and inline directives                                     */
/* ------------------------------------------------------------------ */

/// `INLINE_DIRECTIVE_GLOBAL` from `compile.ts`: a `Word{say="…"}` alias or a
/// bracketed span, matched within one text node.
static INLINE_DIRECTIVE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(\S+)\{say="([^"\n]*)"\}|\[([^\[\]\n]*)\]"#).expect("directive pattern")
});

static NAMED_DIRECTIVE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([A-Za-z][A-Za-z-]*)\s*:").expect("named directive pattern"));

/// Whether a bracket label is a directive (`classifyBracketDirective`). A cue,
/// a take and a malformed one of either are all unspoken; anything else in
/// brackets — `[1]`, `[Note: …]` — is ordinary text and is read aloud.
fn is_bracket_directive(label: &str) -> bool {
    let trimmed = label.trim();
    if ["pause", "beat", "breathe"]
        .iter()
        .any(|name| trimmed.eq_ignore_ascii_case(name))
    {
        return true;
    }
    NAMED_DIRECTIVE.captures(trimmed).is_some_and(|caps| {
        let name = &caps[1];
        name.eq_ignore_ascii_case("cue") || name.eq_ignore_ascii_case("take")
    })
}

/// A run of text as the Markdown parser would hand it over: decoded, with each
/// byte's position in the block source and whether it was written literally.
/// `\[Pause]` and `&#91;Pause&#93;` decode to `[Pause]` but are not directive
/// syntax, which is what `literal` records.
#[derive(Default)]
struct TextNode {
    text: String,
    /// Source offset of every byte of `text`, plus one entry for its end.
    map: Vec<usize>,
    literal: Vec<bool>,
    end: usize,
}

impl TextNode {
    fn push_char(&mut self, c: char, at: usize, literal: bool) {
        for _ in 0..c.len_utf8() {
            self.map.push(at);
            self.literal.push(literal);
        }
        self.text.push(c);
    }

    /// Source text taken verbatim: no escapes, no entities.
    fn push_verbatim(&mut self, src: &str, start: usize, end: usize) {
        for (offset, c) in src[start..end].char_indices() {
            self.push_char(c, start + offset, true);
        }
        self.end = end;
    }

    /// Source text with backslash escapes and character references decoded.
    fn push_decoded(&mut self, src: &str, start: usize, end: usize) {
        let mut i = start;
        while i < end {
            let rest = &src[i..end];
            let c = rest.chars().next().expect("non-empty rest");
            if c == '\\' {
                if let Some(next) = rest[1..].chars().next() {
                    if next.is_ascii_punctuation() {
                        self.push_char(next, i, false);
                        i += 2;
                        continue;
                    }
                }
            } else if c == '&' {
                if let Some((decoded, len)) = decode_entity(rest) {
                    self.push_char(decoded, i, false);
                    i += len;
                    continue;
                }
            }
            self.push_char(c, i, true);
            i += c.len_utf8();
        }
        self.end = end;
    }

    /// Hand the node to the draft (`walkTextValue`): directives drop out,
    /// aliases speak their spoken form, everything else is spoken as written.
    fn flush(&mut self, draft: &mut Draft, src: &str) {
        let node = std::mem::take(self);
        if node.text.is_empty() {
            return;
        }
        let mut map = node.map;
        map.push(node.end);
        let append = |draft: &mut Draft, from: usize, to: usize| {
            draft.append(src, &node.text[from..to], map[from], map[to]);
        };
        let mut cursor = 0;
        for caps in INLINE_DIRECTIVE.captures_iter(&node.text) {
            let whole = caps.get(0).expect("whole match");
            if let Some(label) = caps.get(3) {
                if !is_bracket_directive(label.as_str()) {
                    continue;
                }
                // Only brackets typed as brackets are syntax.
                if !node.literal[whole.start()] || !node.literal[whole.end() - 1] {
                    continue;
                }
                append(draft, cursor, whole.start());
                cursor = whole.end();
                continue;
            }
            let visual = caps.get(1).expect("visual word");
            let say = caps.get(2).expect("say text");
            if !node.literal[visual.end()] {
                continue; // `\{say=…}` is literal text
            }
            append(draft, cursor, whole.start());
            draft.append_override(visual.as_str(), say.as_str());
            cursor = whole.end();
        }
        append(draft, cursor, node.text.len());
    }
}

static ENTITY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));")
        .expect("entity pattern")
});

/// Decode a character reference at the start of `text`. Named references are
/// limited to the ones scripts plausibly contain; an unknown name stays literal
/// text, which is also what the compiler does with a name HTML does not define.
fn decode_entity(text: &str) -> Option<(char, usize)> {
    let caps = ENTITY.captures(text)?;
    let len = caps.get(0)?.end();
    let decoded = if let Some(dec) = caps.get(1) {
        char::from_u32(dec.as_str().parse().ok()?).filter(|c| *c != '\0').unwrap_or('\u{FFFD}')
    } else if let Some(hex) = caps.get(2) {
        char::from_u32(u32::from_str_radix(hex.as_str(), 16).ok()?)
            .filter(|c| *c != '\0')
            .unwrap_or('\u{FFFD}')
    } else {
        named_entity(caps.get(3)?.as_str())?
    };
    Some((decoded, len))
}

fn named_entity(name: &str) -> Option<char> {
    Some(match name {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        "nbsp" => '\u{A0}',
        "hellip" => '…',
        "mdash" => '—',
        "ndash" => '–',
        "lsquo" => '‘',
        "rsquo" => '’',
        "ldquo" => '“',
        "rdquo" => '”',
        "laquo" => '«',
        "raquo" => '»',
        "bull" => '•',
        "middot" => '·',
        "times" => '×',
        "divide" => '÷',
        "deg" => '°',
        "copy" => '©',
        "reg" => '®',
        "trade" => '™',
        "euro" => '€',
        "pound" => '£',
        "cent" => '¢',
        "yen" => '¥',
        "sect" => '§',
        "para" => '¶',
        "shy" => '\u{AD}',
        "eacute" => 'é',
        "egrave" => 'è',
        "agrave" => 'à',
        "aacute" => 'á',
        "ccedil" => 'ç',
        "ntilde" => 'ñ',
        "auml" => 'ä',
        "ouml" => 'ö',
        "uuml" => 'ü',
        "szlig" => 'ß',
        _ => return None,
    })
}

/* ------------------------------------------------------------------ */
/* Inline structure                                                     */
/* ------------------------------------------------------------------ */

/// Link and image reference definitions, keyed by normalised label.
type Definitions = std::collections::HashMap<String, String>;

fn normalize_label(label: &str) -> String {
    label.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// A run of `*`, `_` or `~`. Characters used as emphasis are syntax; the rest
/// stay literal text. A closer consumes from the front of its run and an
/// opener from the back, as in CommonMark's delimiter algorithm.
struct Delimiter {
    ch: u8,
    start: usize,
    len: usize,
    can_open: bool,
    can_close: bool,
    used_front: usize,
    used_back: usize,
}

impl Delimiter {
    fn remaining(&self) -> usize {
        self.len - self.used_front - self.used_back
    }
}

enum Inline {
    /// Source text, decoded when it reaches a text node.
    Text { start: usize, end: usize },
    Delimiter(Delimiter),
    Code { content: String, start: usize, end: usize },
    Link { label: Vec<Inline> },
    Image { alt: String, alt_start: usize, url: String },
    /// Inline HTML or a comment: never spoken, and it interrupts a word run.
    Silent,
    Break,
}

static INLINE_HTML: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r#"^(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*/?>"#,
        r"|</[A-Za-z][A-Za-z0-9-]*\s*>",
        r"|<!---?>|<!--[\s\S]*?-->",
        r"|<\?[\s\S]*?\?>",
        r"|<!\[CDATA\[[\s\S]*?\]\]>",
        r"|<![A-Za-z][^>]*>)",
    ))
    .expect("inline html pattern")
});

static AUTOLINK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*",
        r"|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?",
        r"(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>",
    ))
    .expect("autolink pattern")
});

fn is_punctuation(c: char) -> bool {
    c.is_ascii_punctuation() || (!c.is_alphanumeric() && !c.is_whitespace())
}

/// Parse `src[start..end]` into inline items.
fn parse_inlines(src: &str, start: usize, end: usize, defs: &Definitions) -> Vec<Inline> {
    let bytes = src.as_bytes();
    let mut items = Vec::new();
    let mut text_start = start;
    let mut i = start;
    let flush = |items: &mut Vec<Inline>, from: usize, to: usize| {
        if from < to {
            items.push(Inline::Text { start: from, end: to });
        }
    };
    while i < end {
        match bytes[i] {
            b'\\' => {
                if i + 1 < end && bytes[i + 1] == b'\n' {
                    flush(&mut items, text_start, i);
                    items.push(Inline::Break);
                    i += 2;
                    text_start = i;
                } else if i + 1 < end && bytes[i + 1].is_ascii_punctuation() {
                    i += 2;
                } else {
                    i += 1;
                }
            }
            b'\n' => {
                let mut spaces_from = i;
                while spaces_from > text_start && bytes[spaces_from - 1] == b' ' {
                    spaces_from -= 1;
                }
                if i - spaces_from >= 2 {
                    flush(&mut items, text_start, spaces_from);
                    items.push(Inline::Break);
                    text_start = i + 1;
                }
                i += 1;
            }
            b'`' => {
                let run = bytes[i..end].iter().take_while(|b| **b == b'`').count();
                match find_code_close(bytes, i + run, end, run) {
                    Some(close) => {
                        flush(&mut items, text_start, i);
                        let (content, content_start) = code_content(src, i + run, close);
                        items.push(Inline::Code {
                            end: content_start + content.len(),
                            content,
                            start: content_start,
                        });
                        i = close + run;
                        text_start = i;
                    }
                    None => i += run,
                }
            }
            b'!' if i + 1 < end && bytes[i + 1] == b'[' => match match_link(src, i + 1, end, defs) {
                Some(link) => {
                    flush(&mut items, text_start, i);
                    items.push(Inline::Image {
                        alt: label_text(src, link.label_start, link.label_end, defs),
                        alt_start: link.label_start,
                        url: link.url,
                    });
                    i = link.next;
                    text_start = i;
                }
                None => i += 1,
            },
            b'[' => match match_link(src, i, end, defs) {
                Some(link) => {
                    flush(&mut items, text_start, i);
                    items.push(Inline::Link {
                        label: parse_inlines(src, link.label_start, link.label_end, defs),
                    });
                    i = link.next;
                    text_start = i;
                }
                None => i += 1,
            },
            b'<' => {
                if let Some(caps) = AUTOLINK.captures(&src[i..end]) {
                    let inner = caps.get(1).expect("autolink target");
                    flush(&mut items, text_start, i);
                    items.push(Inline::Link {
                        label: vec![Inline::Text {
                            start: i + inner.start(),
                            end: i + inner.end(),
                        }],
                    });
                    i += caps.get(0).expect("autolink").end();
                    text_start = i;
                } else if let Some(found) = INLINE_HTML.find(&src[i..end]) {
                    flush(&mut items, text_start, i);
                    items.push(Inline::Silent);
                    i += found.end();
                    text_start = i;
                } else {
                    i += 1;
                }
            }
            ch @ (b'*' | b'_' | b'~') => {
                let len = bytes[i..end].iter().take_while(|b| **b == ch).count();
                flush(&mut items, text_start, i);
                items.push(Inline::Delimiter(delimiter_run(src, ch, i, len)));
                i += len;
                text_start = i;
            }
            _ => i += src[i..].chars().next().map_or(1, char::len_utf8),
        }
    }
    flush(&mut items, text_start, end);
    match_emphasis(&mut items);
    items
}

fn find_code_close(bytes: &[u8], from: usize, end: usize, run: usize) -> Option<usize> {
    let mut j = from;
    while j < end {
        if bytes[j] == b'`' {
            let len = bytes[j..end].iter().take_while(|b| **b == b'`').count();
            if len == run {
                return Some(j);
            }
            j += len;
        } else {
            j += 1;
        }
    }
    None
}

/// Code span content per CommonMark: line endings become spaces, and one space
/// of padding is stripped from each side when both are present.
fn code_content(src: &str, start: usize, end: usize) -> (String, usize) {
    let raw = src[start..end].replace('\n', " ");
    if raw.len() >= 2 && raw.starts_with(' ') && raw.ends_with(' ') && raw.trim() != "" {
        (raw[1..raw.len() - 1].to_string(), start + 1)
    } else {
        (raw, start)
    }
}

fn delimiter_run(src: &str, ch: u8, start: usize, len: usize) -> Delimiter {
    let before = src[..start].chars().next_back();
    let after = src[start + len..].chars().next();
    let space_before = before.is_none_or(char::is_whitespace);
    let space_after = after.is_none_or(char::is_whitespace);
    let punct_before = before.is_some_and(is_punctuation);
    let punct_after = after.is_some_and(is_punctuation);
    let left = !space_after && (!punct_after || space_before || punct_before);
    let right = !space_before && (!punct_before || space_after || punct_after);
    let (can_open, can_close) = match ch {
        b'_' => (
            left && (!right || punct_before),
            right && (!left || punct_after),
        ),
        // GFM strikethrough takes one or two tildes, never more.
        b'~' if len > 2 => (false, false),
        _ => (left, right),
    };
    Delimiter {
        ch,
        start,
        len,
        can_open,
        can_close,
        used_front: 0,
        used_back: 0,
    }
}

/// CommonMark's "process emphasis", reduced to deciding which delimiter
/// characters are syntax. Nothing else about emphasis matters to speech.
fn match_emphasis(items: &mut [Inline]) {
    let mut openers: Vec<usize> = Vec::new();
    for idx in 0..items.len() {
        let Inline::Delimiter(closer) = &items[idx] else {
            continue;
        };
        let (ch, can_open, can_close, closer_len) =
            (closer.ch, closer.can_open, closer.can_close, closer.len);
        if can_close {
            loop {
                let Inline::Delimiter(closer) = &items[idx] else {
                    unreachable!()
                };
                if closer.remaining() == 0 {
                    break;
                }
                let found = openers.iter().rposition(|&o| {
                    let Inline::Delimiter(opener) = &items[o] else {
                        return false;
                    };
                    if opener.ch != ch || opener.remaining() == 0 {
                        return false;
                    }
                    if ch == b'~' {
                        return opener.len == closer_len;
                    }
                    let either_both = (opener.can_open && opener.can_close) || (can_open && can_close);
                    !(either_both
                        && (opener.len + closer_len) % 3 == 0
                        && !(opener.len % 3 == 0 && closer_len % 3 == 0))
                });
                let Some(position) = found else {
                    break;
                };
                let o = openers[position];
                let opener_left = match &items[o] {
                    Inline::Delimiter(opener) => opener.remaining(),
                    _ => unreachable!(),
                };
                let closer_left = match &items[idx] {
                    Inline::Delimiter(closer) => closer.remaining(),
                    _ => unreachable!(),
                };
                let used = if ch == b'~' {
                    closer_left
                } else if opener_left >= 2 && closer_left >= 2 {
                    2
                } else {
                    1
                };
                if let Inline::Delimiter(opener) = &mut items[o] {
                    opener.used_back += used;
                }
                if let Inline::Delimiter(closer) = &mut items[idx] {
                    closer.used_front += used;
                }
                // Delimiters between the pair can no longer match anything.
                openers.truncate(position + 1);
                if opener_left == used {
                    openers.pop();
                }
            }
        }
        let remaining = match &items[idx] {
            Inline::Delimiter(delimiter) => delimiter.remaining(),
            _ => unreachable!(),
        };
        if can_open && remaining > 0 {
            openers.push(idx);
        }
    }
}

struct LinkMatch {
    label_start: usize,
    label_end: usize,
    url: String,
    next: usize,
}

/// A link (or, after `!`, an image) whose label opens at `open`: inline
/// `[label](url)`, full `[label][ref]`, collapsed `[label][]` or shortcut
/// `[label]`. A reference form only counts when the reference is defined —
/// an undefined `[Cue: smile]` stays text, which is what makes it a directive.
fn match_link(src: &str, open: usize, end: usize, defs: &Definitions) -> Option<LinkMatch> {
    let bytes = src.as_bytes();
    let mut depth = 0usize;
    let mut j = open + 1;
    let close = loop {
        if j >= end {
            return None;
        }
        match bytes[j] {
            b'\\' => j += 2,
            b'[' => {
                depth += 1;
                j += 1;
            }
            b']' if depth == 0 => break j,
            b']' => {
                depth -= 1;
                j += 1;
            }
            _ => j += 1,
        }
    };
    let (label_start, label_end) = (open + 1, close);
    let after = close + 1;
    if after < end && bytes[after] == b'(' {
        if let Some((url, next)) = inline_destination(src, after, end) {
            return Some(LinkMatch { label_start, label_end, url, next });
        }
    }
    if after < end && bytes[after] == b'[' {
        if let Some(offset) = src[after + 1..end].find(']') {
            let reference = &src[after + 1..after + 1 + offset];
            let key = if reference.trim().is_empty() {
                &src[label_start..label_end]
            } else {
                reference
            };
            if let Some(url) = defs.get(&normalize_label(key)) {
                let next = after + 1 + offset + 1;
                return Some(LinkMatch { label_start, label_end, url: url.clone(), next });
            }
        }
    }
    let url = defs.get(&normalize_label(&src[label_start..label_end]))?;
    Some(LinkMatch { label_start, label_end, url: url.clone(), next: after })
}

/// `(destination "optional title")` starting at the `(`; returns the
/// destination and the offset after the `)`.
fn inline_destination(src: &str, paren: usize, end: usize) -> Option<(String, usize)> {
    let bytes = src.as_bytes();
    let skip_space = |mut k: usize| {
        while k < end && bytes[k].is_ascii_whitespace() {
            k += 1;
        }
        k
    };
    let mut k = skip_space(paren + 1);
    let destination;
    if k < end && bytes[k] == b'<' {
        let close = src[k + 1..end].find(|c| c == '>' || c == '<' || c == '\n')?;
        if bytes[k + 1 + close] != b'>' {
            return None;
        }
        destination = src[k + 1..k + 1 + close].to_string();
        k += close + 2;
    } else {
        let from = k;
        let mut depth = 0usize;
        while k < end {
            match bytes[k] {
                b'\\' => k += 2,
                b'(' => {
                    depth += 1;
                    k += 1;
                }
                b')' if depth == 0 => break,
                b')' => {
                    depth -= 1;
                    k += 1;
                }
                b if b.is_ascii_whitespace() || b.is_ascii_control() => break,
                _ => k += 1,
            }
        }
        destination = src[from..k.min(end)].to_string();
    }
    k = skip_space(k);
    if k < end && matches!(bytes[k], b'"' | b'\'' | b'(') {
        let closing = if bytes[k] == b'(' { ')' } else { bytes[k] as char };
        let offset = src[k + 1..end].find(closing)?;
        k = skip_space(k + 1 + offset + 1);
    }
    (k < end && bytes[k] == b')').then(|| (destination, k + 1))
}

/// An image's alt text: the label's text content with its markup removed.
fn label_text(src: &str, start: usize, end: usize, defs: &Definitions) -> String {
    fn collect(src: &str, items: &[Inline], out: &mut String) {
        for item in items {
            match item {
                Inline::Text { start, end } => {
                    let mut node = TextNode::default();
                    node.push_decoded(src, *start, *end);
                    out.push_str(&node.text);
                }
                Inline::Delimiter(delimiter) => {
                    let from = delimiter.start + delimiter.used_front;
                    let to = delimiter.start + delimiter.len - delimiter.used_back;
                    out.push_str(&src[from..to]);
                }
                Inline::Code { content, .. } => out.push_str(content),
                Inline::Link { label } => collect(src, label, out),
                Inline::Image { alt, .. } => out.push_str(alt),
                Inline::Break => out.push(' '),
                Inline::Silent => {}
            }
        }
    }
    let mut out = String::new();
    collect(src, &parse_inlines(src, start, end, defs), &mut out);
    out
}

/// The compiler's URL allowlist (`classifyUrl`): an image whose reference is
/// dropped keeps its alt text on the glass but never speaks it.
fn image_url_allowed(raw: &str) -> bool {
    let url: String = raw.chars().filter(|c| *c > ' ' && *c != '\u{7f}').collect();
    if url.starts_with("//") {
        return false;
    }
    let Some(colon) = url.find(':') else {
        return true;
    };
    let scheme = &url[..colon];
    let is_scheme = scheme.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'));
    if !is_scheme {
        return true;
    }
    ["http", "https", "mailto", "tel", "asset"]
        .iter()
        .any(|allowed| scheme.eq_ignore_ascii_case(allowed))
}

/// Feed inline items to a draft (`walkPhrasing`).
fn walk_inlines(draft: &mut Draft, src: &str, items: &[Inline], options: SpokenTextOptions) {
    let mut node = TextNode::default();
    for item in items {
        match item {
            Inline::Text { start, end } => node.push_decoded(src, *start, *end),
            Inline::Delimiter(delimiter) => {
                // Emphasis characters end the text node they close and open a
                // new one; leftover characters are ordinary text.
                if delimiter.used_front > 0 {
                    node.flush(draft, src);
                }
                let from = delimiter.start + delimiter.used_front;
                let to = delimiter.start + delimiter.len - delimiter.used_back;
                if from < to {
                    node.push_verbatim(src, from, to);
                }
                if delimiter.used_back > 0 {
                    node.flush(draft, src);
                }
            }
            Inline::Code { content, start, end } => {
                node.flush(draft, src);
                if options.read_inline_code {
                    draft.append(src, content, *start, *end);
                } else {
                    draft.interrupt();
                }
            }
            Inline::Link { label } => {
                node.flush(draft, src);
                walk_inlines(draft, src, label, options);
            }
            Inline::Image { alt, alt_start, url } => {
                node.flush(draft, src);
                if options.read_image_alt_text && !alt.is_empty() && image_url_allowed(url) {
                    draft.append(src, alt, *alt_start, alt_start + alt.len());
                    draft.interrupt();
                }
            }
            Inline::Silent => {
                node.flush(draft, src);
                draft.interrupt();
            }
            Inline::Break => {
                node.flush(draft, src);
                draft.hard_break();
            }
        }
    }
    node.flush(draft, src);
}

/* ------------------------------------------------------------------ */
/* Front matter and ::: containers (directives.ts)                      */
/* ------------------------------------------------------------------ */

static COACH_KEY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^coach\s*:").expect("coach key pattern"));
static CONTAINER_OPEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^:::\s*([A-Za-z][A-Za-z-]*)\s*$").expect("container open pattern")
});
static CONTAINER_CLOSE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^:::\s*$").expect("container close pattern"));
static FENCE_OPEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^ {0,3}(`{3,}|~{3,})(.*)$").expect("fence open pattern"));
static FENCE_CLOSE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^ {0,3}(`{3,}|~{3,})[ \t]*$").expect("fence close pattern"));
static SPOKEN_VISUAL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^[ \t]*visual:[ \t]*(.*)$").expect("visual pattern"));
static SPOKEN_SAY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^[ \t]*say:[ \t]*(.*)$").expect("say pattern"));

/// The last line of `coach:` front matter (§19.5), which the compiler masks
/// out. Any other front matter is ordinary Markdown to it, and so here.
fn coach_front_matter_end(lines: &[&str]) -> Option<usize> {
    if lines.first()?.trim() != "---" {
        return None;
    }
    let close = lines
        .iter()
        .enumerate()
        .skip(1)
        .find(|(_, line)| matches!(line.trim(), "---" | "..."))?
        .0;
    lines[1..close]
        .iter()
        .any(|line| COACH_KEY.is_match(line))
        .then_some(close)
}

/// A code fence: its character, length, and (for the opening line) whether it
/// is one at all — a backtick fence's info string may not contain a backtick.
fn fence_open(line: &str) -> Option<(u8, usize)> {
    let caps = FENCE_OPEN.captures(line)?;
    let fence = caps.get(1)?.as_str();
    let ch = fence.as_bytes()[0];
    if ch == b'`' && caps.get(2)?.as_str().contains('`') {
        return None;
    }
    Some((ch, fence.len()))
}

fn is_fence_close(line: &str, ch: u8, len: usize) -> bool {
    FENCE_CLOSE.captures(line).is_some_and(|caps| {
        let fence = caps[1].as_bytes();
        fence[0] == ch && fence.len() >= len
    })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ContainerKind {
    Spoken,
    Silent,
    Stage,
    LiteralCommand,
}

/// What the `:::` scan decided about each line.
struct ContainerScan {
    /// Fence lines of closed (or unclosed known) containers and `:::spoken`
    /// bodies: blank to the Markdown that follows.
    masked: Vec<bool>,
    /// Inside a closed `:::silent` or `:::stage`.
    suppressed: Vec<bool>,
    /// A well-formed `:::spoken` block opening on this line: (visual, say).
    spoken_at: Vec<Option<(String, String)>>,
}

/// `scanContainers`: containers nest, a bare `:::` closes the innermost, a
/// `:::` line inside a code fence is example text, an unknown name stays
/// readable source, and a container that never closes compiles as ordinary
/// text — so an unclosed `:::silent` is spoken.
fn scan_containers(lines: &[&str]) -> ContainerScan {
    let n = lines.len();
    let mut scan = ContainerScan {
        masked: vec![false; n],
        suppressed: vec![false; n],
        spoken_at: vec![None; n],
    };
    let mut stack: Vec<(Option<ContainerKind>, usize)> = Vec::new();
    let mut fence: Option<(u8, usize)> = None;
    for (i, line) in lines.iter().enumerate() {
        if let Some((ch, len)) = fence {
            if is_fence_close(line, ch, len) {
                fence = None;
            }
            continue;
        }
        if let Some(open) = fence_open(line) {
            fence = Some(open);
            continue;
        }
        if let Some(caps) = CONTAINER_OPEN.captures(line) {
            let kind = match caps[1].to_ascii_lowercase().as_str() {
                "spoken" => Some(ContainerKind::Spoken),
                "silent" => Some(ContainerKind::Silent),
                "stage" => Some(ContainerKind::Stage),
                "literal-command" => Some(ContainerKind::LiteralCommand),
                _ => None,
            };
            stack.push((kind, i));
            continue;
        }
        if !CONTAINER_CLOSE.is_match(line) {
            continue;
        }
        let Some((kind, open)) = stack.pop() else {
            scan.masked[i] = true; // stray closing fence
            continue;
        };
        let Some(kind) = kind else {
            continue; // unknown container: both fences stay visible
        };
        scan.masked[open] = true;
        scan.masked[i] = true;
        match kind {
            ContainerKind::Spoken => {
                for masked in &mut scan.masked[open + 1..i] {
                    *masked = true;
                }
                scan.spoken_at[open] = parse_spoken_body(&lines[open + 1..i]);
            }
            ContainerKind::Silent | ContainerKind::Stage => {
                for suppressed in &mut scan.suppressed[open..=i] {
                    *suppressed = true;
                }
            }
            ContainerKind::LiteralCommand => {}
        }
    }
    for (kind, open) in stack {
        if kind.is_some() {
            scan.masked[open] = true;
        }
    }
    scan
}

/// The `visual:` and `say:` lines of a `:::spoken` block, or `None` when it is
/// malformed — which the compiler shows as an error card and never speaks.
fn parse_spoken_body(body: &[&str]) -> Option<(String, String)> {
    let visual = body.iter().find_map(|line| SPOKEN_VISUAL.captures(line))?[1].trim().to_string();
    let say = body.iter().find_map(|line| SPOKEN_SAY.captures(line))?[1].trim().to_string();
    (!visual.is_empty() && !say.is_empty()).then_some((visual, say))
}

/* ------------------------------------------------------------------ */
/* Block grammar                                                        */
/* ------------------------------------------------------------------ */

static ATX_HEADING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^ {0,3}#{1,6}(?:[ \t]+(.*))?$").expect("atx pattern"));
static THEMATIC_BREAK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$")
        .expect("thematic break pattern")
});
static SETEXT_UNDERLINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^ {0,3}(?:=+|-+)[ \t]*$").expect("setext pattern"));
static LINK_DEFINITION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^ {0,3}\[((?:[^\[\]\\]|\\.)+)\]:[ \t]*(?:<([^>\n]*)>|(\S+))")
        .expect("definition pattern")
});
static TABLE_DELIMITER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$")
        .expect("table delimiter pattern")
});
static HTML_RAW_TEXT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^ {0,3}<(?:script|pre|style|textarea)(?:\s|>|$)").expect("html type 1 pattern")
});
static HTML_DECLARATION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^ {0,3}<![A-Za-z]").expect("html type 4 pattern"));
static HTML_BLOCK_TAG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?i)^ {0,3}</?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col",
        r"|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame",
        r"|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav",
        r"|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th",
        r"|thead|title|tr|track|ul)(?:\s|/?>|$)",
    ))
    .expect("html type 6 pattern")
});
static HTML_LONE_TAG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r#"^ {0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*/?>"#,
        r"|</[A-Za-z][A-Za-z0-9-]*\s*>)[ \t]*$",
    ))
    .expect("html type 7 pattern")
});
static LOOKS_LIKE_MARKUP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<[a-zA-Z/!?]").expect("markup pattern"));

fn is_blank(line: &str) -> bool {
    line.chars().all(|c| c == ' ' || c == '\t')
}

fn leading_spaces(line: &str) -> usize {
    line.bytes().take_while(|b| *b == b' ').count()
}

/// Leading tabs become spaces to the next multiple of four, which is all the
/// indentation arithmetic below needs.
fn expand_leading_tabs(line: &str) -> String {
    let indent_len = line.bytes().take_while(|b| *b == b' ' || *b == b'\t').count();
    if !line[..indent_len].contains('\t') {
        return line.to_string();
    }
    let mut out = String::with_capacity(line.len() + 8);
    let mut column = 0;
    for b in line[..indent_len].bytes() {
        let width = if b == b'\t' { 4 - column % 4 } else { 1 };
        out.extend(std::iter::repeat_n(' ', width));
        column += width;
    }
    out.push_str(&line[indent_len..]);
    out
}

/// A blockquote marker (`>` and one optional space), returning what follows.
fn strip_quote(line: &str) -> Option<&str> {
    let spaces = leading_spaces(line);
    if spaces > 3 || line.as_bytes().get(spaces) != Some(&b'>') {
        return None;
    }
    let rest = &line[spaces + 1..];
    Some(rest.strip_prefix(' ').unwrap_or(rest))
}

struct ListItem {
    /// Columns a continuation line must be indented by to stay in the item.
    indent: usize,
    /// Where the item's content starts on its first line.
    content: usize,
    empty: bool,
    ordered_start: Option<u64>,
}

fn list_item(line: &str) -> Option<ListItem> {
    let spaces = leading_spaces(line);
    if spaces > 3 {
        return None;
    }
    let bytes = &line.as_bytes()[spaces..];
    let (marker_len, ordered_start) = match bytes.first()? {
        b'-' | b'*' | b'+' => (1, None),
        _ => {
            let digits = bytes.iter().take_while(|b| b.is_ascii_digit()).count();
            if digits == 0 || digits > 9 || !matches!(bytes.get(digits), Some(b'.' | b')')) {
                return None;
            }
            (digits + 1, line[spaces..spaces + digits].parse().ok())
        }
    };
    let marker_end = spaces + marker_len;
    let tail = &line[marker_end..];
    if !tail.is_empty() && !tail.starts_with([' ', '\t']) {
        return None;
    }
    let gap = tail.bytes().take_while(|b| *b == b' ' || *b == b'\t').count();
    let (indent, content, empty) = if is_blank(tail) {
        (marker_end + 1, line.len(), true)
    } else if gap >= 5 {
        (marker_end + 1, marker_end + 1, false)
    } else {
        (marker_end + gap, marker_end + gap, false)
    };
    Some(ListItem { indent, content, empty, ordered_start })
}

/// GFM task-list checkbox at the start of an item: structure, never a word.
fn strip_task_checkbox(content: &str) -> &str {
    for box_ in ["[ ] ", "[x] ", "[X] ", "[ ]\t", "[x]\t", "[X]\t"] {
        if let Some(rest) = content.strip_prefix(box_) {
            return rest;
        }
    }
    content
}

/// An ATX heading's text, without its opening and closing `#` runs.
fn atx_heading(line: &str) -> Option<String> {
    let caps = ATX_HEADING.captures(line)?;
    let content = caps.get(1).map_or("", |m| m.as_str()).trim_end();
    let without_hashes = content.trim_end_matches('#');
    let text = if without_hashes.is_empty() {
        ""
    } else if without_hashes.ends_with([' ', '\t']) {
        without_hashes.trim_end()
    } else {
        content
    };
    Some(text.to_string())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum HtmlEnd {
    /// Type 2: an HTML comment, which ends at the line holding `-->`.
    Comment,
    /// Types 1, 3, 4, 5: the line containing one of these.
    Contains(&'static [&'static str]),
    /// Types 6 and 7: a blank line.
    Blank,
}

/// The CommonMark HTML block that `line` opens, if any. Type 7 (a lone tag)
/// cannot interrupt a paragraph.
fn html_block_start(line: &str, interrupting: bool) -> Option<HtmlEnd> {
    let trimmed = line.trim_start_matches(' ');
    if line.len() - trimmed.len() > 3 || !trimmed.starts_with('<') {
        return None;
    }
    if HTML_RAW_TEXT.is_match(line) {
        return Some(HtmlEnd::Contains(&["</script>", "</pre>", "</style>", "</textarea>"]));
    }
    if trimmed.starts_with("<!--") {
        return Some(HtmlEnd::Comment);
    }
    if trimmed.starts_with("<?") {
        return Some(HtmlEnd::Contains(&["?>"]));
    }
    if trimmed.starts_with("<![CDATA[") {
        return Some(HtmlEnd::Contains(&["]]>"]));
    }
    if HTML_DECLARATION.is_match(line) {
        return Some(HtmlEnd::Contains(&[">"]));
    }
    if HTML_BLOCK_TAG.is_match(line) || (!interrupting && HTML_LONE_TAG.is_match(line)) {
        return Some(HtmlEnd::Blank);
    }
    None
}

fn html_end_reached(end: HtmlEnd, line: &str, first_line: bool) -> bool {
    match end {
        HtmlEnd::Comment => {
            let from = if first_line {
                line.find("<!--").map_or(0, |at| at + 4)
            } else {
                0
            };
            line[from..].contains("-->")
        }
        HtmlEnd::Contains(markers) => {
            let lower = line.to_ascii_lowercase();
            markers.iter().any(|marker| lower.contains(marker))
        }
        HtmlEnd::Blank => false,
    }
}

fn table_cells(row: &str) -> usize {
    let row = row.trim();
    let row = row.strip_prefix('|').unwrap_or(row);
    let row = row.strip_suffix('|').unwrap_or(row);
    let mut cells = 1;
    let mut escaped = false;
    for c in row.chars() {
        match c {
            '\\' if !escaped => escaped = true,
            '|' if !escaped => cells += 1,
            _ => escaped = false,
        }
    }
    cells
}

enum Container {
    Quote,
    Item { indent: usize },
}

enum Leaf {
    None,
    Paragraph { lines: Vec<String>, first: usize },
    Fence { ch: u8, len: usize },
    IndentedCode,
    Html { end: HtmlEnd, lines: Vec<String>, first: usize },
    Table,
}

/// Line-by-line block structure: open containers (quotes, list items) are
/// matched first, new ones opened, then the rest of the line goes to the
/// current leaf — the shape of CommonMark's own algorithm, without the parts
/// that cannot change what is spoken.
struct BlockWalker<'a> {
    options: SpokenTextOptions,
    out: &'a mut Collector,
    lines: Vec<String>,
    scan: ContainerScan,
    defs: Definitions,
    containers: Vec<Container>,
    leaf: Leaf,
}

impl<'a> BlockWalker<'a> {
    fn new(source: &str, options: SpokenTextOptions, out: &'a mut Collector) -> Self {
        let mut raw: Vec<&str> = source.lines().collect();
        if let Some(end) = coach_front_matter_end(&raw) {
            for line in &mut raw[..=end] {
                *line = "";
            }
        }
        let scan = scan_containers(&raw);
        let lines: Vec<String> = raw
            .iter()
            .enumerate()
            .map(|(i, line)| if scan.masked[i] { String::new() } else { expand_leading_tabs(line) })
            .collect();
        let defs = collect_definitions(&lines);
        Self {
            options,
            out,
            lines,
            scan,
            defs,
            containers: Vec::new(),
            leaf: Leaf::None,
        }
    }

    fn run(mut self) {
        for index in 0..self.lines.len() {
            if let Some((visual, say)) = self.scan.spoken_at[index].take() {
                // A :::spoken block is spoken wherever it sits, even inside a
                // :::stage or :::silent (§23.6).
                self.close_leaf();
                let mut draft = Draft::default();
                draft.append_override(&visual, &say);
                self.out.push(draft);
            }
            let line = std::mem::take(&mut self.lines[index]);
            self.line(&line, index);
        }
        self.close_leaf();
    }

    fn line(&mut self, line: &str, index: usize) {
        let mut rest = line;
        let mut matched = 0;
        for container in &self.containers {
            match container {
                Container::Quote => match strip_quote(rest) {
                    Some(inner) => rest = inner,
                    None => break,
                },
                Container::Item { indent } => {
                    if !is_blank(rest) {
                        if leading_spaces(rest) < *indent {
                            break;
                        }
                        rest = &rest[*indent..];
                    }
                }
            }
            matched += 1;
        }
        let all_matched = matched == self.containers.len();

        if all_matched {
            match &mut self.leaf {
                Leaf::Fence { ch, len } => {
                    if is_fence_close(rest, *ch, *len) {
                        self.leaf = Leaf::None;
                    }
                    return;
                }
                Leaf::Html { end: HtmlEnd::Blank, lines, .. } => {
                    if is_blank(rest) {
                        self.close_leaf();
                    } else {
                        lines.push(rest.to_string());
                    }
                    return;
                }
                Leaf::Html { end, lines, .. } => {
                    let end = *end;
                    lines.push(rest.to_string());
                    if html_end_reached(end, rest, false) {
                        self.close_leaf();
                    }
                    return;
                }
                _ => {}
            }
        }

        let paragraph_open = matches!(self.leaf, Leaf::Paragraph { .. });
        let mut opened = Vec::new();
        loop {
            if leading_spaces(rest) >= 4 {
                break;
            }
            if let Some(inner) = strip_quote(rest) {
                opened.push(Container::Quote);
                rest = inner;
                continue;
            }
            if THEMATIC_BREAK.is_match(rest) {
                break;
            }
            if let Some(item) = list_item(rest) {
                // Only a non-empty bullet, or a list starting at 1, may
                // interrupt a paragraph.
                let interrupting = paragraph_open && all_matched && opened.is_empty();
                if interrupting && (item.empty || item.ordered_start.is_some_and(|n| n != 1)) {
                    break;
                }
                opened.push(Container::Item { indent: item.indent });
                rest = strip_task_checkbox(&rest[item.content..]);
                continue;
            }
            break;
        }

        // Lazy continuation: a paragraph carries on past a missing `>` or a
        // short indent, as long as the line does not start a block of its own.
        if opened.is_empty()
            && !all_matched
            && paragraph_open
            && !is_blank(rest)
            && !self.starts_block(rest)
        {
            if let Leaf::Paragraph { lines, .. } = &mut self.leaf {
                lines.push(rest.trim_start().to_string());
            }
            return;
        }

        if !all_matched {
            self.close_leaf();
            self.containers.truncate(matched);
        }
        if !opened.is_empty() {
            self.close_leaf();
            self.containers.extend(opened);
        }
        self.leaf_line(rest, index);
    }

    fn leaf_line(&mut self, rest: &str, index: usize) {
        match self.leaf {
            Leaf::IndentedCode => {
                if is_blank(rest) || leading_spaces(rest) >= 4 {
                    return;
                }
                self.leaf = Leaf::None;
            }
            Leaf::Table => {
                if !is_blank(rest) && !self.starts_block(rest) {
                    return;
                }
                self.leaf = Leaf::None;
            }
            _ => {}
        }
        if is_blank(rest) {
            self.close_leaf();
            return;
        }

        if matches!(self.leaf, Leaf::Paragraph { .. }) {
            if SETEXT_UNDERLINE.is_match(rest) {
                if let Leaf::Paragraph { lines, first } = std::mem::replace(&mut self.leaf, Leaf::None) {
                    self.heading(&lines.join("\n"), first);
                }
                return;
            }
            if self.table_starts(rest, index) {
                self.close_leaf();
                self.leaf = Leaf::Table;
                return;
            }
            if !self.interrupts_paragraph(rest) {
                if let Leaf::Paragraph { lines, .. } = &mut self.leaf {
                    lines.push(rest.trim_start().to_string());
                }
                return;
            }
            self.close_leaf();
        }

        if leading_spaces(rest) >= 4 {
            self.leaf = Leaf::IndentedCode;
        } else if let Some((ch, len)) = fence_open(rest) {
            self.leaf = Leaf::Fence { ch, len };
        } else if let Some(text) = atx_heading(rest) {
            self.heading(&text, index);
        } else if THEMATIC_BREAK.is_match(rest) {
            // A divider: structure, nothing to say.
        } else if let Some(end) = html_block_start(rest, false) {
            self.leaf = Leaf::Html { end, lines: vec![rest.to_string()], first: index };
            if html_end_reached(end, rest, true) {
                self.close_leaf();
            }
        } else if LINK_DEFINITION.is_match(rest) {
            // A reference definition: metadata, never rendered.
        } else if self.table_starts(rest, index) {
            self.leaf = Leaf::Table;
        } else {
            self.leaf = Leaf::Paragraph { lines: vec![rest.trim_start().to_string()], first: index };
        }
    }

    fn interrupts_paragraph(&self, rest: &str) -> bool {
        atx_heading(rest).is_some()
            || fence_open(rest).is_some()
            || THEMATIC_BREAK.is_match(rest)
            || html_block_start(rest, true).is_some()
    }

    fn starts_block(&self, rest: &str) -> bool {
        self.interrupts_paragraph(rest)
            || strip_quote(rest).is_some()
            || list_item(rest).is_some_and(|item| !item.empty)
    }

    /// A GFM table: a row with pipes over a delimiter row with as many cells.
    /// It can take over the last line of a paragraph.
    fn table_starts(&self, rest: &str, index: usize) -> bool {
        if !rest.contains('|') {
            return false;
        }
        let Some(next) = self.lines.get(index + 1) else {
            return false;
        };
        let next = next.trim_start_matches([' ', '>']);
        next.contains('|') && TABLE_DELIMITER.is_match(next) && table_cells(rest) == table_cells(next)
    }

    fn close_leaf(&mut self) {
        match std::mem::replace(&mut self.leaf, Leaf::None) {
            Leaf::Paragraph { lines, first } => {
                if !self.scan.suppressed[first] {
                    self.markdown_block(&lines.join("\n"));
                }
            }
            Leaf::Html { end: HtmlEnd::Comment, lines, first } => {
                if !self.scan.suppressed[first] {
                    self.comment_block(&lines.join("\n"));
                }
            }
            _ => {}
        }
    }

    fn heading(&mut self, text: &str, first: usize) {
        if self.options.read_headings && !self.scan.suppressed[first] {
            self.markdown_block(text);
        }
    }

    fn markdown_block(&mut self, text: &str) {
        let items = parse_inlines(text, 0, text.len(), &self.defs);
        let mut draft = Draft::default();
        walk_inlines(&mut draft, text, &items, self.options);
        self.out.push(draft);
    }

    /// `splitHtmlBlock`: a comment block is silent, but CommonMark ends it at
    /// the line holding `-->`, so words written after the comment on that line
    /// belong to the block. They are still the presenter's words — taken as
    /// plain text with directives — unless they are themselves markup.
    fn comment_block(&mut self, text: &str) {
        let mut cursor = 0;
        let mut comments = 0;
        loop {
            cursor += text[cursor..].len() - text[cursor..].trim_start().len();
            if !text[cursor..].starts_with("<!--") {
                break;
            }
            let Some(close) = text[cursor + 4..].find("-->") else {
                break;
            };
            cursor += 4 + close + 3;
            comments += 1;
        }
        let rest = text[cursor..].trim();
        if comments == 0 || rest.is_empty() || LOOKS_LIKE_MARKUP.is_match(rest) {
            return;
        }
        let mut node = TextNode::default();
        node.push_verbatim(rest, 0, rest.len());
        let mut draft = Draft::default();
        node.flush(&mut draft, rest);
        self.out.push(draft);
    }
}

/// Every reference definition in the document, outside code fences.
fn collect_definitions(lines: &[String]) -> Definitions {
    let mut defs = Definitions::new();
    let mut fence: Option<(u8, usize)> = None;
    for line in lines {
        let content = line.trim_start_matches([' ', '>']);
        if let Some((ch, len)) = fence {
            if is_fence_close(content, ch, len) {
                fence = None;
            }
            continue;
        }
        if let Some(open) = fence_open(content) {
            fence = Some(open);
            continue;
        }
        if let Some(caps) = LINK_DEFINITION.captures(content) {
            let url = caps.get(2).or_else(|| caps.get(3)).map_or("", |m| m.as_str());
            defs.entry(normalize_label(&caps[1])).or_insert_with(|| url.to_string());
        }
    }
    defs
}

/*
 * Accepted differences from the compiler, each rare in a real script:
 *
 * - CommonMark corner cases outside the forms above: multi-line link
 *   destinations and definitions, link labels containing code spans, HTML
 *   blocks nested oddly inside list items, and character references beyond the
 *   common named ones (an unknown name stays literal; the compiler decodes
 *   every name HTML defines).
 * - A list or quote that starts outside a `:::` container and runs on inside it
 *   takes the container's semantics per line here and per top-level block in
 *   the compiler.
 */

#[cfg(test)]
mod tests {
    use super::*;

    fn plain(source: &str) -> String {
        spoken_plain_text(source, SpokenTextOptions::default())
    }

    fn words(source: &str) -> u32 {
        spoken_text(source, SpokenTextOptions::default()).word_count()
    }

    #[test]
    fn excludes_code_headings_and_silent_containers() {
        let source = "# Title\n\nHello world from CandidCue.\n\n```rust\nlet x = 1;\n```\n\n:::silent\nsmile now\n:::\n\nSecond paragraph here.\n";
        assert_eq!(plain(source), "Hello world from CandidCue. Second paragraph here.");
        assert_eq!(words(source), 7);
    }

    #[test]
    fn an_unknown_container_is_readable_source_and_spoken() {
        // `:::cue` is not a CandidCue container. The compiler leaves it on the
        // glass as written, and what is on the glass is read.
        let source = ":::cue\nsmile now\n:::\n";
        assert_eq!(plain(source), ":::cue smile now :::");
        assert_eq!(words(source), 3);
    }

    #[test]
    fn issue_249_previews_say_what_the_presenter_says() {
        assert_eq!(
            plain("Welcome back. [Cue: smile at camera] Today we look at one thing. [Pause] Let's go."),
            "Welcome back. Today we look at one thing. Let's go."
        );
        assert_eq!(
            plain("<!-- TODO: cut this line before Friday -->\n\nHello there everyone.\n"),
            "Hello there everyone."
        );
        assert_eq!(plain("Our API{say=\"a p i\"} is fast."), "Our a p i is fast.");
        assert_eq!(
            plain(":::spoken\nvisual: 10x faster\nsay: ten times faster\n:::\n\nDone.\n"),
            "ten times faster Done."
        );
        assert_eq!(plain("1. First point here\n2. Second point here\n"), "First point here Second point here");
        assert_eq!(plain("Big Title\n=========\n\nBody text here.\n"), "Body text here.");
    }

    #[test]
    fn preview_leaves_short_text_alone() {
        assert_eq!(preview_text("Good morning, everyone."), "Good morning, everyone.");
    }

    #[test]
    fn preview_cuts_on_a_word_boundary() {
        // The library used to read "…text scrolls smoothly and rem…", because the
        // cut was a flat 200-character slice.
        //
        // The 7-character unit is the point: 200 is not a multiple of it, so the
        // old implementation's cut landed four characters into a word and produced
        // "…abcd…". A 5-character unit divides 200 exactly, which is why the
        // obvious "word ".repeat(60) fixture passed against the OLD code too and
        // proved nothing.
        let plain = "abcdef ".repeat(40);
        let preview = preview_text(&plain);

        assert!(preview.ends_with("abcdef…"), "cut mid-word: {preview}");
        let body = preview.trim_end_matches('…');
        // `all` over an empty iterator is vacuously true, so the emptiness of the
        // body is its own assertion rather than something the loop below implies.
        assert!(!body.is_empty(), "the preview lost its text entirely");

        let words: Vec<&str> = body.split_whitespace().collect();
        assert_eq!(words.len(), 28, "{preview}");
        assert!(
            words.iter().all(|w| *w == "abcdef"),
            "no half-spelled word may survive: {preview}"
        );
        // Backing up to the boundary must not push it past the limit either.
        assert!(body.chars().count() <= 200, "{}", body.chars().count());
    }

    #[test]
    fn preview_hard_cuts_text_with_no_boundary() {
        // One unbroken run — a URL, or a script whose language does not space its
        // words. There is no boundary to back up to, so the flat cut is all there
        // is, and it must still terminate rather than return the whole document.
        let plain = "a".repeat(500);
        let preview = preview_text(&plain);
        assert_eq!(preview.chars().count(), 201);
        assert!(preview.ends_with('…'));
    }

    #[test]
    fn keeps_link_labels_drops_images() {
        let source = "See [our site](https://example.com) and ![diagram](assets/x.png) today.\n";
        assert_eq!(plain(source), "See our site and today.");
    }

    #[test]
    fn headings_included_when_enabled() {
        let source = "# Welcome\n\nBody text.\n";
        let options = SpokenTextOptions {
            read_headings: true,
            ..Default::default()
        };
        assert_eq!(spoken_plain_text(source, options), "Welcome Body text.");
    }

    #[test]
    fn duration_uses_wpm() {
        assert_eq!(estimated_duration_seconds(130, 130), 60);
        assert_eq!(estimated_duration_seconds(0, 130), 0);
        assert_eq!(estimated_duration_seconds(65, 130), 30);
    }

    #[test]
    fn duration_clamps_the_rate_like_the_compiler() {
        // A rate of 10 would make seven words take 42 seconds; the compiler reads
        // it as 70. A rate of zero used to report no duration at all.
        assert_eq!(estimated_duration_seconds(7, 10), 6);
        assert_eq!(estimated_duration_seconds(7, 0), 6);
        assert_eq!(estimated_duration_seconds(220, 1000), 60);
    }

    /// The shared fixture, asserted word for word. Its `tokens`, `words` and
    /// `durationSeconds` are the compiler's own output and are checked against
    /// `compile()` by `tests/unit/markdown/spoken-counts.test.ts`; `plain` is
    /// this extraction's preview text, which the compiler does not publish.
    #[test]
    fn matches_the_compiler_on_the_shared_fixture() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/markdown");
        let fixture = std::fs::read_to_string(root.join("spoken-counts.json")).expect("fixture");
        let cases: Vec<serde_json::Value> = serde_json::from_str(&fixture).expect("fixture json");
        assert!(cases.len() > 50, "the fixture lost its cases");

        let mut failures = Vec::new();
        for case in &cases {
            let name = case["name"].as_str().expect("name");
            let source = match case["file"].as_str() {
                Some(file) => std::fs::read_to_string(root.join(file)).expect("fixture file"),
                None => case["source"].as_str().expect("source").to_string(),
            };
            let options = &case["options"];
            let flag = |key: &str| options[key].as_bool().unwrap_or(false);
            let extracted = spoken_text(
                &source,
                SpokenTextOptions {
                    read_headings: flag("readHeadings"),
                    read_image_alt_text: flag("readImageAltText"),
                    read_inline_code: flag("readInlineCode"),
                },
            );
            let expected_tokens: Vec<&str> = case["tokens"]
                .as_array()
                .expect("tokens")
                .iter()
                .map(|t| t.as_str().expect("token"))
                .collect();
            let wpm = options["wordsPerMinute"].as_u64().unwrap_or(130) as u32;
            let duration = estimated_duration_seconds(extracted.word_count(), wpm);

            if extracted.tokens != expected_tokens {
                failures.push(format!(
                    "{name}: words differ\n  compiler: {}\n  library:  {}",
                    expected_tokens.join(" "),
                    extracted.tokens.join(" ")
                ));
            }
            if case["words"].as_u64() != Some(extracted.word_count() as u64) {
                failures.push(format!("{name}: count {} vs {}", case["words"], extracted.word_count()));
            }
            if case["durationSeconds"].as_u64() != Some(duration as u64) {
                failures.push(format!("{name}: duration {} vs {duration}", case["durationSeconds"]));
            }
            if let Some(expected_plain) = case["plain"].as_str() {
                if extracted.plain != expected_plain {
                    failures.push(format!(
                        "{name}: preview text\n  expected: {expected_plain}\n  actual:   {}",
                        extracted.plain
                    ));
                }
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }
}
