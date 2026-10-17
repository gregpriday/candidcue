//! The script as a TAKE compiles it, not as the benchmark used to.
//!
//! The app never hands the engine Markdown. It tokenises the spoken text
//! itself (`src/shared/markdown/tokenize.ts`), sends each word with its block
//! ordinal and sentence end (`alignTokensFor`), and the host compiles those
//! with [`cc_align::compile_tokens_in`] — one token at a time. Every replay in
//! this crate compiled the Markdown with [`cc_align::compile`] instead, which
//! normalises a whole spoken line at once. The two agree for most prose and
//! disagree wherever normalisation reaches across a word boundary: a script
//! that writes `forty two` compiles to `42` on the Markdown path and to `40 2`
//! in the app, while the recogniser's own `forty two` normalises to `42`.
//!
//! So a Tier-B number about the Markdown path is a number about a compile the
//! product does not perform. This module reproduces the app's tokens closely
//! enough to compile the script the way a take does, and maps gold — which is
//! stored in Markdown-path atom indexes — into that compile's atom space, so
//! the same evaluator can score the engine against the same words.

use cc_align::script::{for_each_spoken_line, CompiledScript};
use cc_align::{CompileOptions, TokenInput};

use crate::plan::{GoldTag, GoldTimeline};

/// `TOKEN_PATTERN` from `tokenize.ts`:
///
/// ```text
/// [\p{L}\p{N}$£€#][\p{L}\p{N}.,''’\-%&]*[\p{L}\p{N}%] | [\p{L}\p{N}] | &
/// ```
fn starts_token(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '$' | '£' | '€' | '#')
}

fn continues_token(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '.' | ',' | '\'' | '‘' | '’' | '-' | '%' | '&')
}

fn ends_token(c: char) -> bool {
    c.is_alphanumeric() || c == '%'
}

/// One token: its surface and the char range it occupies in the line.
struct Raw {
    surface: String,
    end: usize,
}

fn tokenize(text: &str) -> Vec<Raw> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        if starts_token(c) {
            // Greedy continuation, then back off to the last legal ending — the
            // first alternative of the pattern, which needs at least two chars.
            let mut j = i + 1;
            while j < chars.len() && continues_token(chars[j]) {
                j += 1;
            }
            let mut end = None;
            let mut k = j;
            while k > i + 1 {
                if ends_token(chars[k - 1]) {
                    end = Some(k);
                    break;
                }
                k -= 1;
            }
            if let Some(end) = end {
                out.push(Raw {
                    surface: chars[i..end].iter().collect(),
                    end,
                });
                i = end;
                continue;
            }
            // Second alternative: a single letter or digit.
            if c.is_alphanumeric() {
                out.push(Raw {
                    surface: c.to_string(),
                    end: i + 1,
                });
            }
            i += 1;
            continue;
        }
        if c == '&' {
            out.push(Raw {
                surface: "&".into(),
                end: i + 1,
            });
        }
        i += 1;
    }
    out
}

/// Words after which a full stop does not end a sentence (`segment.ts`).
const NON_TERMINAL: &[&str] = &[
    "mr", "mrs", "ms", "dr", "prof", "st", "jr", "sr", "vs", "etc", "e.g", "eg", "i.e", "ie",
    "no", "dept", "approx", "fig", "al", "inc", "ltd", "co", "corp", "jan", "feb", "mar", "apr",
    "jun", "jul", "aug", "sept", "sep", "oct", "nov", "dec", "mon", "tue", "tues", "wed", "thu",
    "thurs", "fri", "sat", "sun", "a.m", "p.m", "am", "pm", "u.s", "u.k", "ph.d", "min", "max",
    "sec", "ft",
];

/// The spoken tokens a take would send, in order.
///
/// Sentence ends are read off the text between a token and the next: terminal
/// punctuation there, after a word that is not a known abbreviation, ends the
/// sentence. That approximates `segment.ts` rather than reproducing it; what
/// matters for the comparisons this module serves is that both sides of an A/B
/// see the same flags, which they do.
pub fn app_tokens(source: &str, options: CompileOptions) -> Vec<TokenInput> {
    let mut out: Vec<TokenInput> = Vec::new();
    for_each_spoken_line(source, options, |line, para, text| {
        let chars: Vec<char> = text.chars().collect();
        let raws = tokenize(text);
        for (index, raw) in raws.iter().enumerate() {
            let next = raws
                .get(index + 1)
                .map(|n| n.end - n.surface.chars().count())
                .unwrap_or(chars.len());
            let between: String = chars[raw.end..next.max(raw.end)].iter().collect();
            let lower = raw.surface.to_lowercase();
            let terminal = between.contains(['.', '!', '?'])
                && !(between.trim_start().starts_with('.')
                    && NON_TERMINAL.contains(&lower.trim_end_matches('.')));
            out.push(TokenInput {
                surface: raw.surface.clone(),
                line,
                para,
                sentence_end: terminal,
            });
        }
    });
    out
}

/// Compile `source` the way a take does.
pub fn compile_like_app(source: &str, options: CompileOptions) -> CompiledScript {
    cc_align::compile_tokens_in(&app_tokens(source, options), options.language)
}

/// A monotone map from boundaries of one atom sequence to boundaries of
/// another, built from a minimum-edit alignment of the two.
///
/// `map[i]` is the boundary in `to` that corresponds to boundary `i` of `from`
/// — the furthest point in `to` the alignment has reached once `from` has
/// consumed `i` atoms. A run that normalised to `27000` on one side and `27
/// thousand` on the other therefore maps "after 27000" to "after thousand":
/// finishing the number on one side is finishing it on the other.
pub struct AtomMap {
    map: Vec<f64>,
}

impl AtomMap {
    pub fn between(from: &CompiledScript, to: &CompiledScript) -> Self {
        let a: Vec<&str> = from.atoms.iter().map(|x| x.surface.as_str()).collect();
        let b: Vec<&str> = to.atoms.iter().map(|x| x.surface.as_str()).collect();
        let (n, m) = (a.len(), b.len());
        // Plain edit distance; the sequences differ only where normalisation
        // crossed a word boundary, so the table is overwhelmingly diagonal.
        let mut d = vec![vec![0u32; m + 1]; n + 1];
        for (i, row) in d.iter_mut().enumerate() {
            row[0] = i as u32;
        }
        for (j, cell) in d[0].iter_mut().enumerate() {
            *cell = j as u32;
        }
        for i in 1..=n {
            for j in 1..=m {
                let sub = d[i - 1][j - 1] + u32::from(a[i - 1] != b[j - 1]);
                d[i][j] = sub.min(d[i - 1][j] + 1).min(d[i][j - 1] + 1);
            }
        }
        let mut map = vec![0.0f64; n + 1];
        let (mut i, mut j) = (n, m);
        map[n] = m as f64;
        while i > 0 || j > 0 {
            if i > 0 && j > 0 && d[i][j] == d[i - 1][j - 1] + u32::from(a[i - 1] != b[j - 1]) {
                i -= 1;
                j -= 1;
            } else if i > 0 && d[i][j] == d[i - 1][j] + 1 {
                i -= 1;
            } else {
                j -= 1;
            }
            // Walking backward, the first visit to boundary `i` is the
            // furthest `j` it reaches.
            if map[i] == 0.0 && i > 0 {
                map[i] = j as f64;
            }
        }
        map[0] = 0.0;
        // Force monotone non-decreasing (a deletion run leaves zeros behind).
        for k in 1..=n {
            if map[k] < map[k - 1] {
                map[k] = map[k - 1];
            }
        }
        Self { map }
    }

    // `!(x > 0.0)` rather than `x <= 0.0`: the two differ on NaN, which must
    // map to the start rather than fall through to the interpolation.
    #[allow(clippy::neg_cmp_op_on_partial_ord)]
    pub fn at(&self, x: f64) -> f64 {
        let last = self.map.len() - 1;
        if !(x > 0.0) {
            return self.map[0];
        }
        if x >= last as f64 {
            return self.map[last];
        }
        let lo = x.floor() as usize;
        let frac = x - lo as f64;
        self.map[lo] + (self.map[lo + 1] - self.map[lo]) * frac
    }

    pub fn is_identity(&self) -> bool {
        self.map.iter().enumerate().all(|(i, v)| (*v - i as f64).abs() < 1e-9)
    }
}

/// Gold and viewport hints, re-expressed in the app compile's atom space.
pub fn map_gold(gold: &GoldTimeline, map: &AtomMap) -> GoldTimeline {
    let mut out = gold.clone();
    for word in &mut out.words {
        word.gold = match &word.gold {
            GoldTag::Script { pos_after, span } => {
                let (a, b) = span.unwrap_or((*pos_after as f64 - 1.0, *pos_after as f64));
                let (ma, mb) = (map.at(a), map.at(b));
                GoldTag::Script {
                    pos_after: mb.ceil() as u32,
                    span: Some((ma, mb)),
                }
            }
            GoldTag::Off { hold } => GoldTag::Off {
                hold: map.at(*hold as f64).round() as u32,
            },
        };
    }
    for hint in &mut out.viewport_hints {
        hint.1 = map.at(hint.1 as f64).floor() as u32;
        hint.2 = map.at(hint.2 as f64).ceil() as u32;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn surfaces(text: &str) -> Vec<String> {
        tokenize(text).into_iter().map(|r| r.surface).collect()
    }

    /// The shapes `tokenize.ts` documents, reproduced.
    #[test]
    fn tokenises_like_the_app() {
        assert_eq!(
            surfaces("It's $12, well-known — 50% & U.S.A. done."),
            vec!["It's", "$12", "well-known", "50%", "&", "U.S.A", "done"]
        );
        assert_eq!(surfaces("three thirty, 3:30"), vec!["three", "thirty", "3", "30"]);
        assert_eq!(surfaces("1,000.5 dollars"), vec!["1,000.5", "dollars"]);
    }

    #[test]
    fn marks_sentence_ends_but_not_abbreviations() {
        let tokens = app_tokens("Dr. Ncube left. Then we ate!", CompileOptions::default());
        let ends: Vec<(String, bool)> = tokens
            .iter()
            .map(|t| (t.surface.clone(), t.sentence_end))
            .collect();
        assert_eq!(
            ends,
            vec![
                ("Dr".to_string(), false),
                ("Ncube".to_string(), false),
                ("left".to_string(), true),
                ("Then".to_string(), false),
                ("we".to_string(), false),
                ("ate".to_string(), true),
            ]
        );
    }

    #[test]
    fn identical_compiles_map_to_the_identity() {
        let source = "The quick brown fox jumps over the lazy dog.";
        let md = cc_align::compile(source, CompileOptions::default());
        let app = compile_like_app(source, CompileOptions::default());
        assert!(AtomMap::between(&md, &app).is_identity());
    }

    /// Two compiles that disagree about a span map its END to its end, so
    /// gold "after the number" stays "after the number".
    #[test]
    fn a_disagreeing_span_maps_its_end_to_its_end() {
        let one = cc_align::compile("We had 27000 active accounts.", CompileOptions::default());
        let two = cc_align::compile("We had 27 thousand active accounts.", CompileOptions::default());
        let map = AtomMap::between(&one, &two);
        let after_one = one.atoms.iter().position(|a| a.surface == "27000").unwrap() + 1;
        let after_two = two.atoms.iter().position(|a| a.surface == "thousand").unwrap() + 1;
        assert_eq!(map.at(after_one as f64), after_two as f64);
        assert_eq!(map.at(one.len() as f64), two.len() as f64);
    }

    /// The compile this module exists to reproduce now agrees with the
    /// Markdown path on spelled numbers — see `compile_tokens_in`.
    #[test]
    fn the_app_compile_agrees_on_spelled_numbers() {
        let source = "We have forty two seats left.";
        let md = cc_align::compile(source, CompileOptions::default());
        let app = compile_like_app(source, CompileOptions::default());
        assert!(AtomMap::between(&md, &app).is_identity());
    }
}

