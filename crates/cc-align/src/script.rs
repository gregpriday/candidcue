//! Markdown → compiled spoken script.
//!
//! Mirrors the spoken-content contract of `src-tauri/src/scripts/words.rs`
//! (code fences, `:::` containers, tables and dividers are never spoken;
//! headings excluded by default; link labels kept, image alt text dropped),
//! but keeps *positions*: every spoken atom knows its source line and
//! paragraph so a viewport can be expressed in atoms, and every atom carries
//! the weight and anchor metadata the aligner uses.
//!
//! The compiler — not the tracker — owns lexical importance. There is no
//! second stopword list anywhere downstream.

use std::collections::HashMap;

use crate::normalize::{canonical_atoms, is_stopword};

pub const FLAG_STOPWORD: u8 = 1 << 0;
pub const FLAG_NUMERIC: u8 = 1 << 1;
/// Eligible to propose a *global* relocation on its own.
pub const FLAG_ANCHOR: u8 = 1 << 2;

/// One spoken atom of the script, in reading order.
#[derive(Debug, Clone)]
pub struct ScriptAtom {
    /// Interned canonical token id.
    pub id: u32,
    /// Canonical surface (lowercased, expanded). Debugging and reports only.
    pub surface: String,
    /// Alignment weight in milli-units: the cost of deleting or mismatching
    /// this atom. Stopwords are cheap, rare content words are expensive.
    pub weight: u16,
    /// 0-based source line in the Markdown document.
    pub line: u32,
    /// 0-based paragraph ordinal (blank-line separated).
    pub para: u32,
    pub flags: u8,
    /// How many times this canonical token occurs in the whole script.
    pub occurrences: u16,
    /// Index of the *host token* this atom was produced from.
    ///
    /// The engine never reads this — it exists so a caller that tokenized the
    /// script itself can map an atom position back onto its own coordinate
    /// system without a second tokenizer (see [`compile_tokens`]). On the
    /// Markdown path every atom is its own token, so this is the atom index.
    pub token: u32,
}

/// String interner shared by script and transcript so atom comparison is an
/// integer compare in the DP hot loop.
#[derive(Debug, Clone, Default)]
pub struct Interner {
    map: HashMap<String, u32>,
    strings: Vec<String>,
}

impl Interner {
    pub fn intern(&mut self, s: &str) -> u32 {
        if let Some(id) = self.map.get(s) {
            return *id;
        }
        let id = self.strings.len() as u32;
        self.strings.push(s.to_string());
        self.map.insert(s.to_string(), id);
        id
    }

    pub fn get(&self, s: &str) -> Option<u32> {
        self.map.get(s).copied()
    }

    pub fn resolve(&self, id: u32) -> &str {
        &self.strings[id as usize]
    }

    pub fn len(&self) -> usize {
        self.strings.len()
    }

    pub fn is_empty(&self) -> bool {
        self.strings.is_empty()
    }
}

/// Options mirroring the per-script settings that affect spoken content.
#[derive(Debug, Clone, Copy)]
pub struct CompileOptions {
    pub read_headings: bool,
}

impl Default for CompileOptions {
    fn default() -> Self {
        Self {
            read_headings: false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct CompiledScript {
    pub atoms: Vec<ScriptAtom>,
    pub interner: Interner,
    /// token id → ascending atom indexes where it occurs.
    pub token_postings: HashMap<u32, Vec<u32>>,
    /// (id,id) → atom index of the first token. Only n-grams with few
    /// occurrences are kept — frequent ones are useless as anchors.
    pub bigram_postings: HashMap<(u32, u32), Vec<u32>>,
    pub trigram_postings: HashMap<(u32, u32, u32), Vec<u32>>,
    pub para_count: u32,
    /// How many host tokens the script was built from (see [`ScriptAtom::token`]).
    pub token_count: u32,
    /// Fractional host-token position at the START of each atom, plus a final
    /// entry equal to `token_count`. Length is `atoms.len() + 1`.
    ///
    /// Non-decreasing by construction, which is what makes
    /// [`CompiledScript::token_at`] a monotone map: a display position that
    /// only moves forward in atom space can only move forward in token space.
    /// When one host token expands into several atoms (`$12` → `12 dollars`)
    /// the atoms share that token's interval evenly, so the reader advances
    /// smoothly across it instead of stalling and then jumping.
    pub atom_token_pos: Vec<f64>,
}

impl CompiledScript {
    pub fn len(&self) -> usize {
        self.atoms.len()
    }

    pub fn is_empty(&self) -> bool {
        self.atoms.is_empty()
    }

    /// Fractional atom position → fractional host-token position.
    ///
    /// Clamped at both ends: a caller extrapolating past the last atom gets the
    /// end of the script, never a position past it.
    pub fn token_at(&self, atom_pos: f64) -> f64 {
        interpolate(&self.atom_token_pos, atom_pos)
    }

    /// Fractional host-token position → fractional atom position. The inverse
    /// of [`CompiledScript::token_at`], for hints and manual moves arriving in
    /// the caller's coordinates.
    pub fn atom_at(&self, token_pos: f64) -> f64 {
        let axis = &self.atom_token_pos;
        if axis.len() < 2 || !token_pos.is_finite() {
            return 0.0;
        }
        let last = axis.len() - 1;
        if token_pos <= axis[0] {
            return 0.0;
        }
        if token_pos >= axis[last] {
            return last as f64;
        }
        // `axis` is non-decreasing, so partition_point finds the first index
        // whose token position exceeds the query; the atom before it contains
        // the query.
        let upper = axis.partition_point(|&t| t <= token_pos);
        let i = upper.saturating_sub(1);
        let (lo, hi) = (axis[i], axis[(i + 1).min(last)]);
        if hi <= lo {
            return i as f64;
        }
        i as f64 + (token_pos - lo) / (hi - lo)
    }
}

/// Sample a non-decreasing axis at a fractional index.
fn interpolate(axis: &[f64], at: f64) -> f64 {
    if axis.is_empty() {
        return 0.0;
    }
    if !at.is_finite() || at <= 0.0 {
        return axis[0];
    }
    let last = axis.len() - 1;
    if at >= last as f64 {
        return axis[last];
    }
    let i = at.floor() as usize;
    let frac = at - i as f64;
    let lo = axis[i];
    let hi = axis[(i + 1).min(last)];
    lo + (hi - lo) * frac
}

/// How many postings an n-gram may have and still act as a relocation anchor.
const MAX_ANCHOR_POSTINGS: usize = 4;

pub fn compile(source: &str, options: CompileOptions) -> CompiledScript {
    let mut interner = Interner::default();
    let mut atoms: Vec<ScriptAtom> = Vec::new();

    let mut in_fence = false;
    let mut in_comment = false;
    let mut container_depth = 0usize;
    let mut para = 0u32;
    let mut last_line_had_content = false;

    for (line_no, line) in source.lines().enumerate() {
        let trimmed = line.trim();

        // HTML comments (`<!-- cc:style calm -->` directives and the like)
        // are never spoken.
        if in_comment {
            if trimmed.contains("-->") {
                in_comment = false;
            }
            continue;
        }
        if trimmed.starts_with("<!--") {
            if !trimmed.contains("-->") {
                in_comment = true;
            }
            continue;
        }

        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }

        // Whole-line bracket directives — `[Cue: …]`, `[Beat]`,
        // `[Take: …]` — are stage annotations, not spoken words.
        if trimmed.starts_with('[') && trimmed.ends_with(']') && !trimmed.contains("](") {
            continue;
        }
        if trimmed.starts_with(":::") {
            if container_depth > 0 && trimmed == ":::" {
                container_depth -= 1;
            } else if trimmed.len() > 3 {
                container_depth += 1;
            }
            continue;
        }
        if container_depth > 0 {
            continue;
        }
        if trimmed.is_empty() {
            if last_line_had_content {
                para += 1;
            }
            last_line_had_content = false;
            continue;
        }
        if trimmed.starts_with('#') {
            if options.read_headings {
                let text = trimmed.trim_start_matches('#').trim();
                push_line(text, line_no as u32, para, &mut interner, &mut atoms);
                last_line_had_content = true;
            }
            continue;
        }
        if trimmed.starts_with('|') || is_divider(trimmed) {
            continue;
        }

        let stripped = trimmed
            .trim_start_matches('>')
            .trim_start_matches(['-', '*', '+'])
            .trim_start();
        let inline = strip_inline(stripped);
        push_line(&inline, line_no as u32, para, &mut interner, &mut atoms);
        last_line_had_content = true;
    }

    let para_count = if atoms.is_empty() { 0 } else { para + 1 };
    let token_count = atoms.len() as u32;
    finalize(atoms, interner, para_count, token_count)
}

/// One spoken token of a script the CALLER has already tokenized.
///
/// This is the seam that keeps the app on one tokenizer. The app's compiler
/// owns document structure — which blocks are spoken, where each word sits in
/// the rendered DOM — and cc-align owns lexical judgement. Handing the app's
/// tokens here instead of re-parsing its Markdown means the two can never
/// disagree about what is spoken, and every atom carries the app's own token
/// index home with it.
#[derive(Debug, Clone)]
pub struct TokenInput {
    /// Authored surface, exactly as the caller rendered it (`$12`, `well-known`).
    /// Normalization into atoms happens here, so the caller must not pre-split.
    pub surface: String,
    /// 0-based source line, carried through for viewport/debug reporting.
    pub line: u32,
    /// 0-based paragraph (block) ordinal.
    pub para: u32,
}

/// Compile from the caller's own spoken tokens.
///
/// A token may expand into several atoms (`$12` → `12 dollars`), into one, or
/// into none at all (a surface that normalizes away entirely). All three are
/// fine: the atom→token axis is built from what actually survives, so it stays
/// monotone regardless.
pub fn compile_tokens(tokens: &[TokenInput]) -> CompiledScript {
    let mut interner = Interner::default();
    let mut atoms: Vec<ScriptAtom> = Vec::new();

    for (index, token) in tokens.iter().enumerate() {
        for canonical in canonical_atoms(&token.surface) {
            let id = interner.intern(&canonical);
            atoms.push(ScriptAtom {
                id,
                surface: canonical,
                weight: 1000,
                line: token.line,
                para: token.para,
                flags: 0,
                occurrences: 0,
                token: index as u32,
            });
        }
    }

    let para_count = atoms.last().map_or(0, |a| a.para + 1);
    finalize(atoms, interner, para_count, tokens.len() as u32)
}

/// Occurrence counts, weights, flags, postings and the token axis — everything
/// that is a pure function of the atom sequence, shared by both entry points so
/// the two can never drift in how they weigh a word.
fn finalize(
    mut atoms: Vec<ScriptAtom>,
    interner: Interner,
    para_count: u32,
    token_count: u32,
) -> CompiledScript {
    // Occurrence counts, weights, flags.
    let mut counts: HashMap<u32, u16> = HashMap::new();
    for atom in &atoms {
        let c: &mut u16 = counts.entry(atom.id).or_default();
        *c = c.saturating_add(1);
    }
    for atom in &mut atoms {
        let occurrences = counts[&atom.id];
        atom.occurrences = occurrences;
        let surface = &atom.surface;
        let stop = is_stopword(surface);
        let numeric = surface.chars().next().is_some_and(|c| c.is_ascii_digit());
        if stop {
            atom.flags |= FLAG_STOPWORD;
        }
        if numeric {
            atom.flags |= FLAG_NUMERIC;
        }
        atom.weight = compute_weight(surface, stop, occurrences);
        // Rare, meaty tokens can carry a relocation on their own.
        if !stop && occurrences as usize <= MAX_ANCHOR_POSTINGS && (surface.len() >= 4 || numeric)
        {
            atom.flags |= FLAG_ANCHOR;
        }
    }

    // Postings.
    let mut token_postings: HashMap<u32, Vec<u32>> = HashMap::new();
    for (i, atom) in atoms.iter().enumerate() {
        token_postings.entry(atom.id).or_default().push(i as u32);
    }
    let mut bigram_postings: HashMap<(u32, u32), Vec<u32>> = HashMap::new();
    for i in 0..atoms.len().saturating_sub(1) {
        bigram_postings
            .entry((atoms[i].id, atoms[i + 1].id))
            .or_default()
            .push(i as u32);
    }
    let mut trigram_postings: HashMap<(u32, u32, u32), Vec<u32>> = HashMap::new();
    for i in 0..atoms.len().saturating_sub(2) {
        trigram_postings
            .entry((atoms[i].id, atoms[i + 1].id, atoms[i + 2].id))
            .or_default()
            .push(i as u32);
    }
    // N-grams that occur everywhere cannot anchor anything; drop them so the
    // candidate generator never has to think about them.
    bigram_postings.retain(|_, v| v.len() <= MAX_ANCHOR_POSTINGS);
    trigram_postings.retain(|_, v| v.len() <= MAX_ANCHOR_POSTINGS);

    let atom_token_pos = build_token_axis(&atoms, token_count);

    CompiledScript {
        para_count,
        token_count,
        atom_token_pos,
        atoms,
        interner,
        token_postings,
        bigram_postings,
        trigram_postings,
    }
}

/// Fractional token position at the start of every atom, plus the end marker.
///
/// Atoms sharing a host token divide that token's unit interval evenly, so the
/// axis advances by a real fraction across a multi-atom token rather than
/// sitting still and then stepping. Tokens that produced no atoms simply do not
/// appear — the axis skips over them, which is what keeps it monotone.
fn build_token_axis(atoms: &[ScriptAtom], token_count: u32) -> Vec<f64> {
    /*
     * A script with tokens but no atoms is entirely unspoken — every surface
     * normalized away. The end marker alone would then be the whole axis, so
     * `token_at(0)` would answer `token_count`: the reader reported at the end
     * of a script before saying a word. Nothing to read means position zero.
     */
    if atoms.is_empty() {
        return vec![0.0];
    }
    let mut axis = Vec::with_capacity(atoms.len() + 1);
    let mut at = 0usize;
    while at < atoms.len() {
        let token = atoms[at].token;
        let mut end = at;
        while end < atoms.len() && atoms[end].token == token {
            end += 1;
        }
        let share = (end - at) as f64;
        for (offset, _) in (at..end).enumerate() {
            axis.push(token as f64 + offset as f64 / share);
        }
        at = end;
    }
    axis.push(token_count as f64);
    axis
}

fn compute_weight(surface: &str, stop: bool, occurrences: u16) -> u16 {
    if stop || surface.len() <= 2 {
        return 350;
    }
    if occurrences > 6 {
        return 600;
    }
    if occurrences > 3 {
        return 800;
    }
    if surface.len() >= 8 {
        return 1300;
    }
    1000
}

fn push_line(text: &str, line: u32, para: u32, interner: &mut Interner, atoms: &mut Vec<ScriptAtom>) {
    for canonical in canonical_atoms(text) {
        let id = interner.intern(&canonical);
        // On the Markdown path there is no host tokenizer, so every atom is its
        // own token and the axis is the identity — which is exactly what the
        // benchmark harness has always assumed.
        let token = atoms.len() as u32;
        atoms.push(ScriptAtom {
            id,
            surface: canonical,
            weight: 1000,
            line,
            para,
            flags: 0,
            occurrences: 0,
            token,
        });
    }
}

fn is_divider(line: &str) -> bool {
    line.len() >= 3 && line.chars().all(|c| c == '-' || c == '_' || c == '*')
}

/// Strip inline Markdown: images dropped, link labels kept, inline code
/// dropped, emphasis markers removed. Same behaviour as the Rust library
/// metadata extractor and the frontend renderer.
fn strip_inline(text: &str) -> String {
    let mut chars = text.chars().peekable();
    let mut out = String::with_capacity(text.len());
    while let Some(c) = chars.next() {
        match c {
            '!' if chars.peek() == Some(&'[') => {
                chars.next();
                let _alt = take_until(&mut chars, ']');
                if chars.peek() == Some(&'(') {
                    chars.next();
                    let _url = take_until(&mut chars, ')');
                }
            }
            '[' => {
                let label = take_until(&mut chars, ']');
                if chars.peek() == Some(&'(') {
                    chars.next();
                    let _url = take_until(&mut chars, ')');
                }
                out.push_str(&label);
            }
            '`' => {
                let _code = take_until(&mut chars, '`');
            }
            '*' | '_' | '~' => {}
            _ => out.push(c),
        }
    }
    out
}

fn take_until(chars: &mut std::iter::Peekable<std::str::Chars<'_>>, end: char) -> String {
    let mut collected = String::new();
    for c in chars.by_ref() {
        if c == end {
            break;
        }
        collected.push(c);
    }
    collected
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compiles_spoken_content_only() {
        let source = "# Title\n\nHello world from CandidCue.\n\n```rust\nlet x = 1;\n```\n\n:::cue\nsmile now\n:::\n\nSecond paragraph here.\n";
        let script = compile(source, CompileOptions::default());
        let words: Vec<&str> = script.atoms.iter().map(|a| a.surface.as_str()).collect();
        assert_eq!(
            words,
            vec!["hello", "world", "from", "candidcue", "second", "paragraph", "here"]
        );
        // Two spoken paragraphs survive; skipped blocks consume no ordinal.
        assert_eq!(script.atoms[0].para, 0);
        assert_eq!(script.atoms.last().unwrap().para, 1);
    }

    #[test]
    fn weights_make_stopwords_cheap_and_rare_words_expensive() {
        let script = compile("The teleprompter follows the presenter.", CompileOptions::default());
        let by_surface: HashMap<&str, &ScriptAtom> = script
            .atoms
            .iter()
            .map(|a| (a.surface.as_str(), a))
            .collect();
        assert!(by_surface["the"].weight < by_surface["teleprompter"].weight);
        assert!(by_surface["teleprompter"].flags & FLAG_ANCHOR != 0);
        assert!(by_surface["the"].flags & FLAG_ANCHOR == 0);
    }

    #[test]
    fn cue_directives_and_comments_are_not_spoken() {
        let source = "Hello there.\n\n[Cue: smile and hold eye contact]\n\n<!-- cc:style calm -->\n\n[Beat]\n\nStill here with [a link](https://x.com) inline.\n";
        let script = compile(source, CompileOptions::default());
        let words: Vec<&str> = script.atoms.iter().map(|a| a.surface.as_str()).collect();
        assert_eq!(
            words,
            vec!["hello", "there", "still", "here", "with", "a", "link", "inline"]
        );
    }

    #[test]
    fn markdown_path_keeps_an_identity_token_axis() {
        let script = compile("alpha beta gamma", CompileOptions::default());
        assert_eq!(script.token_count, 3);
        assert_eq!(script.atom_token_pos, vec![0.0, 1.0, 2.0, 3.0]);
        assert_eq!(script.token_at(1.5), 1.5);
        assert_eq!(script.atom_at(1.5), 1.5);
    }

    /// The whole point of the token path: one host token, several atoms, and a
    /// map that still lands back on the token the caller handed in.
    #[test]
    fn expanding_tokens_share_their_interval() {
        let tokens: Vec<TokenInput> = ["Revenue", "hit", "$12", "today"]
            .iter()
            .map(|s| TokenInput {
                surface: (*s).to_string(),
                line: 0,
                para: 0,
            })
            .collect();
        let script = compile_tokens(&tokens);

        let surfaces: Vec<&str> = script.atoms.iter().map(|a| a.surface.as_str()).collect();
        assert_eq!(surfaces, vec!["revenue", "hit", "12", "dollars", "today"]);
        // `$12` produced two atoms; both belong to host token 2.
        assert_eq!(script.atoms[2].token, 2);
        assert_eq!(script.atoms[3].token, 2);
        assert_eq!(script.token_count, 4);

        // They split token 2's interval instead of both sitting on 2.0.
        assert_eq!(script.token_at(2.0), 2.0);
        assert_eq!(script.token_at(3.0), 2.5);
        assert_eq!(script.token_at(4.0), 3.0);
        // And the inverse round-trips.
        assert!((script.atom_at(2.5) - 3.0).abs() < 1e-9);
        assert!((script.atom_at(3.0) - 4.0).abs() < 1e-9);
    }

    #[test]
    fn token_axis_is_monotone_and_clamped() {
        let tokens: Vec<TokenInput> = ["well-known", "50%", "...", "end"]
            .iter()
            .map(|s| TokenInput {
                surface: (*s).to_string(),
                line: 0,
                para: 0,
            })
            .collect();
        let script = compile_tokens(&tokens);

        // A surface that normalizes away entirely contributes no atom; the axis
        // skips it without ever going backwards.
        let mut previous = f64::NEG_INFINITY;
        for &position in &script.atom_token_pos {
            assert!(position >= previous, "axis went backwards at {position}");
            previous = position;
        }
        assert_eq!(script.token_count, 4);
        assert_eq!(*script.atom_token_pos.last().unwrap(), 4.0);

        // Out-of-range queries clamp rather than extrapolate.
        assert_eq!(script.token_at(-5.0), 0.0);
        assert_eq!(script.token_at(1e9), 4.0);
        assert_eq!(script.atom_at(-5.0), 0.0);
        assert_eq!(script.atom_at(1e9), script.atoms.len() as f64);
    }

    #[test]
    fn token_path_and_markdown_path_agree_on_lexical_judgement() {
        let markdown = compile("The teleprompter follows the presenter", CompileOptions::default());
        let tokens: Vec<TokenInput> = ["The", "teleprompter", "follows", "the", "presenter"]
            .iter()
            .map(|s| TokenInput {
                surface: (*s).to_string(),
                line: 0,
                para: 0,
            })
            .collect();
        let from_tokens = compile_tokens(&tokens);

        let lexical = |script: &CompiledScript| -> Vec<(String, u16, u8)> {
            script
                .atoms
                .iter()
                .map(|a| (a.surface.clone(), a.weight, a.flags))
                .collect()
        };
        assert_eq!(lexical(&markdown), lexical(&from_tokens));
    }

    /// `&` is a spoken word on BOTH sides of the seam.
    ///
    /// The app's tokenizer emits it as a token; if the engine dropped it, the
    /// app would render a word the engine had no atom for, and the recogniser's
    /// "and" would have nothing to match.
    #[test]
    fn ampersands_are_read_as_a_word() {
        let tokens: Vec<TokenInput> = ["R", "&", "D", "at", "AT&T"]
            .iter()
            .map(|s| TokenInput {
                surface: (*s).to_string(),
                line: 0,
                para: 0,
            })
            .collect();
        let script = compile_tokens(&tokens);
        let surfaces: Vec<&str> = script.atoms.iter().map(|a| a.surface.as_str()).collect();
        assert_eq!(surfaces, vec!["r", "and", "d", "at", "at", "and", "t"]);
        // Every host token produced at least one atom, so none is unmatchable.
        for token in 0..script.token_count {
            assert!(
                script.atoms.iter().any(|a| a.token == token),
                "token {token} produced no atoms"
            );
        }
    }

    /// A script whose every surface normalizes away has nothing to read, and
    /// must report position zero rather than the end of the script.
    #[test]
    fn an_entirely_unspoken_script_starts_at_zero() {
        let tokens: Vec<TokenInput> = ["...", "—"]
            .iter()
            .map(|s| TokenInput {
                surface: (*s).to_string(),
                line: 0,
                para: 0,
            })
            .collect();
        let script = compile_tokens(&tokens);
        assert!(script.is_empty());
        assert_eq!(script.token_count, 2);
        assert_eq!(
            script.token_at(0.0),
            0.0,
            "an unspoken script reported itself already read"
        );
        assert_eq!(script.atom_at(0.0), 0.0);
    }

    #[test]
    fn empty_token_list_is_a_valid_empty_script() {
        let script = compile_tokens(&[]);
        assert!(script.is_empty());
        assert_eq!(script.token_count, 0);
        assert_eq!(script.atom_token_pos, vec![0.0]);
        assert_eq!(script.token_at(0.0), 0.0);
        assert_eq!(script.atom_at(0.0), 0.0);
    }

    #[test]
    fn postings_are_ascending_and_complete() {
        let script = compile("alpha beta alpha gamma alpha", CompileOptions::default());
        let alpha = script.interner.get("alpha").unwrap();
        assert_eq!(script.token_postings[&alpha], vec![0, 2, 4]);
    }
}
