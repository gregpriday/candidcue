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
}

impl CompiledScript {
    pub fn len(&self) -> usize {
        self.atoms.len()
    }

    pub fn is_empty(&self) -> bool {
        self.atoms.is_empty()
    }
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

    CompiledScript {
        para_count: if atoms.is_empty() { 0 } else { para + 1 },
        atoms,
        interner,
        token_postings,
        bigram_postings,
        trigram_postings,
    }
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
        atoms.push(ScriptAtom {
            id,
            surface: canonical,
            weight: 1000,
            line,
            para,
            flags: 0,
            occurrences: 0,
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
    fn postings_are_ascending_and_complete() {
        let script = compile("alpha beta alpha gamma alpha", CompileOptions::default());
        let alpha = script.interner.get("alpha").unwrap();
        assert_eq!(script.token_postings[&alpha], vec![0, 2, 4]);
    }
}
