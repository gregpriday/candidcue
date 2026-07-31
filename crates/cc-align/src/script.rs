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

use std::collections::{HashMap, HashSet};

use crate::language::AlignmentLanguage;
use crate::normalize::{canonical_atoms_for, is_stopword_for, phonetic_key_for, PhoneticKey};

pub const FLAG_STOPWORD: u8 = 1 << 0;
pub const FLAG_NUMERIC: u8 = 1 << 1;
/// Eligible to propose a *global* relocation on its own.
pub const FLAG_ANCHOR: u8 = 1 << 2;
/// The last atom of a sentence — where the reader stops, breathes, and holds.
///
/// Structural, not lexical: the three flags above describe what a word IS, this
/// one describes where it SITS. It exists so [`CompiledScript::sentence_end`]
/// can be built by one scan, and it is the only thing either compile path has
/// to agree on — the Markdown path derives it from terminal punctuation, the
/// token path is told it by a caller that segmented the document properly.
pub const FLAG_SENTENCE_END: u8 = 1 << 3;
/// This word was handed to the recogniser as a bias term.
///
/// Never set by either compile path — provenance arrives only through
/// [`CompiledScript::set_biased_terms`], because only the caller that
/// configured the decoder knows what it was actually told to expect.
///
/// Bit 4, not 3: [`FLAG_SENTENCE_END`] took the next free bit first, and the
/// two must not alias. They are cleared and rebuilt by different owners — the
/// setter below wipes every [`FLAG_BIASED`] mark on each call, which under an
/// alias would erase the sentence structure the display brakes on.
pub const FLAG_BIASED: u8 = 1 << 4;

/// Every canonical surface a bias term could have compiled to.
///
/// The phrase first, then its words individually, because the two compiler
/// entry points normalise in different contexts — see
/// [`CompiledScript::set_biased_terms`]. Marking the union over-approximates in
/// the safe direction: an extra flagged word can only make a relocation ask for
/// more evidence, never make local following ask for less.
fn bias_surfaces(language: AlignmentLanguage, term: &str) -> Vec<String> {
    let mut out = canonical_atoms_for(language, term);
    if term.split_whitespace().nth(1).is_some() {
        for word in term.split_whitespace() {
            for surface in canonical_atoms_for(language, word) {
                if !out.contains(&surface) {
                    out.push(surface);
                }
            }
        }
    }
    out
}

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
    /// Phonetic key, derived once at compile time.
    ///
    /// The phonetic relation is evaluated in the DP inner loop, once per
    /// (query atom, script atom) cell. Encoding there meant re-deriving the
    /// same key thousands of times per revision — 10% of the engine's entire
    /// per-event cost. The script does not change mid-take, so it is derived
    /// here and the loop only compares.
    pub phonetic: PhoneticKey,
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
#[derive(Debug, Clone, Copy, Default)]
pub struct CompileOptions {
    pub read_headings: bool,
    /// The language this script is written in.
    ///
    /// Set once, here, and then carried by the compiled script for the life of
    /// the session — see [`CompiledScript::language`].
    pub language: AlignmentLanguage,
}

/// One normalised transcript word, classified under the script's language.
#[derive(Debug, Clone)]
pub struct QueryWord {
    pub surface: String,
    pub filler: bool,
    pub stopword: bool,
    pub phonetic: PhoneticKey,
}

#[derive(Debug, Clone)]
pub struct CompiledScript {
    /// The language every atom here was normalised under.
    ///
    /// Private, and deliberately so. This is the single source of truth for
    /// the whole session: the tracker normalises incoming transcript text by
    /// reading it back out (see [`CompiledScript::query_atoms`]), rather than
    /// being told the language a second time by whoever wired up the engine.
    ///
    /// The alternative — a language on `CompileOptions` AND one on
    /// `AlignmentConfig` — is two values that must agree, and the failure when
    /// they do not is the "0 of 26" class described in `normalize.rs`: a script
    /// compiled one way, a transcript normalised another, and two components
    /// with different opinions about what a word is. Storing it once makes that
    /// disagreement unrepresentable instead of merely tested against.
    language: AlignmentLanguage,
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
    /// For each atom, the EXCLUSIVE atom index ending its paragraph.
    ///
    /// The OUTER bound, not the display's ceiling — `sentence_end` below took
    /// that job. Crossing a paragraph break is still the one guess the engine is
    /// never allowed to make, because a break is exactly where a reader stops to
    /// breathe, check the camera, or decide whether to say the next bit at all;
    /// the finer rule simply brakes earlier and can never reach past this one.
    ///
    /// Two things still read it. The approximate-bridge gate
    /// (`Tracker::can_bridge_local_approx`) stays deliberately paragraph-bounded,
    /// because failing it does not merely dim less — it drops the engine into
    /// `Holding`. And [`CompiledScript::paragraph_ceiling`] is the off switch
    /// that reproduces the old display behaviour for comparison.
    pub para_end: Vec<u32>,
    /// For each atom, the EXCLUSIVE atom index ending its SENTENCE.
    ///
    /// The same rule as `para_end`, applied where readers actually pause. A
    /// full stop is where they slow down, take a breath and hold for effect,
    /// so it is the most likely place for the display to run past them — and
    /// a paragraph ceiling brakes at neither of the four sentence endings in a
    /// five-sentence paragraph. Prose has far more sentences than paragraphs,
    /// which is to say the paragraph rule caught the biggest version of this
    /// and missed every smaller one.
    ///
    /// Never greater than `para_end` at the same atom: every paragraph's last
    /// atom is forced to be a sentence end whether or not it was punctuated
    /// like one, so the coarser rule survives inside the finer one. A script
    /// with no terminal punctuation at all therefore compiles to
    /// `sentence_end == para_end` and behaves exactly as it did before — that
    /// is a property of how the table is built, not a special case.
    ///
    /// "Sentence" is whatever the compile path called one, and the token path
    /// is only as good as what it was told. The app hands over its NAVIGATION
    /// units, which are grammatical sentences in prose but deliberately one
    /// unit per list item however many sentences the bullet holds. So a
    /// multi-sentence bullet gets a ceiling at the end of the item and none
    /// inside it — no worse than the paragraph rule it replaces, and no
    /// better.
    pub sentence_end: Vec<u32>,
}

impl CompiledScript {
    pub fn len(&self) -> usize {
        self.atoms.len()
    }

    pub fn is_empty(&self) -> bool {
        self.atoms.is_empty()
    }

    /// How far the display may be carried by prediction from a frontier at
    /// `atom_pos`: the end of the SENTENCE the reader was last *heard* in.
    ///
    /// `atom_pos` is a frontier, so the atom to answer for is the one below it
    /// — which is what keeps the rule honest at a break. A reader who has just
    /// finished a sentence has a frontier sitting exactly on the next
    /// sentence's first word; answering with THAT sentence's end would let
    /// prediction fade its opening words on the strength of having heard the
    /// previous one end, which is the guess this function exists to refuse.
    ///
    /// A frontier of zero is the one place the phrasing strains: nothing has
    /// been heard at all, and the answer is the first sentence's end rather
    /// than nothing. That is the same room a reader gets for the first word of
    /// any sentence, and the display has nowhere behind it to sit anyway.
    pub fn prediction_ceiling(&self, atom_pos: f64) -> f64 {
        match self.last_heard(atom_pos) {
            Some(at) => self.sentence_end[at] as f64,
            None => 0.0,
        }
    }

    /// The same question answered at paragraph granularity — how far
    /// prediction could run before sentences reached the atom stream.
    ///
    /// Kept as the off switch behind [`crate::AlignmentConfig::
    /// sentence_prediction_ceiling`] so the two rules can be compared in one
    /// binary, which is the only way this engine's changes are ever believed.
    pub fn paragraph_ceiling(&self, atom_pos: f64) -> f64 {
        match self.last_heard(atom_pos) {
            Some(at) => self.para_end[at] as f64,
            None => 0.0,
        }
    }

    /// Index of the last atom actually spoken below the frontier `atom_pos`,
    /// or `None` for a script with nothing in it.
    ///
    /// Private and shared: the two ceilings differ only in which table they
    /// read, and the frontier-sits-exactly-on-the-break rule is subtle enough
    /// that two copies of it would eventually stop agreeing.
    fn last_heard(&self, atom_pos: f64) -> Option<usize> {
        if self.atoms.is_empty() {
            return None;
        }
        let last_heard = (atom_pos.ceil() as i64 - 1).max(0) as usize;
        Some(last_heard.min(self.atoms.len() - 1))
    }

    /// Canonical atoms for recogniser text, with word boundaries reconciled
    /// against this script's own vocabulary.
    ///
    /// A brand written `RustLight` is one word to the compiler and two to the
    /// recogniser, which hears no capital letter and writes `Rust Light`.
    /// Nothing was misheard, but the script has no atom either half can match,
    /// so a partner list — the one place a presenter genuinely cannot scroll
    /// with their eyes — is where the display was most likely to come apart.
    ///
    /// The join is deliberately timid. It fires only when the concatenation is
    /// a word THIS script actually contains, and only when the pieces are not
    /// all script words in their own right: if the script says both `rust` and
    /// `light` on their own, two words is a reading it already supports and
    /// guessing otherwise would be the aligner's job, not the normaliser's.
    /// The language this script was compiled in.
    pub fn language(&self) -> AlignmentLanguage {
        self.language
    }

    pub fn query_atoms(&self, text: &str) -> Vec<String> {
        self.rejoin_split_words(canonical_atoms_for(self.language, text))
    }

    /// Declare the vocabulary terms the recogniser was biased toward.
    ///
    /// A word the decoder was told to expect is not independent evidence that
    /// the reader is at the position which asked for it: bias the upcoming
    /// stretch, let weak acoustics decode as the scripted words, and the exact
    /// matches the aligner sees were partly produced by the hypothesis under
    /// test. The gates that authorise a relocation discount those matches
    /// ([`AlignmentConfig::biased_content_weight_milli`]); ordinary local
    /// continuity still takes them at full value, because a wrong local step is
    /// small and self-correcting.
    ///
    /// Provenance cannot come from the recogniser. sherpa-onnx matches hotwords
    /// against an internal context graph and no per-token "this was boosted"
    /// signal ever reaches a caller, so the only honest source is the term list
    /// the caller itself handed over — which is why this is an explicit setter
    /// rather than something `compile` infers. Re-deriving the terms here would
    /// flag atoms on a take where nothing was biased at all.
    ///
    /// Replaces the active set: the previous [`FLAG_BIASED`] marks are cleared
    /// first, so the flags always describe the decoder's *current* configuration
    /// and never accumulate across takes. Every other lexical flag survives.
    /// Passing an empty slice restores an unbiased script exactly.
    ///
    /// Terms are the authored spellings (`"RustLight Games"`), canonicalised the
    /// same way [`compile`] canonicalised the script, so a multi-word term
    /// reaches its constituent atoms. A term the script does not contain is
    /// ignored rather than interned: bias provenance must never invent a word.
    ///
    /// Pass the terms as they were extracted, not as fragments of them.
    /// Canonicalisation of numbers is context-sensitive — the script's
    /// `twenty-seven million` compiles to the single atom `27000000`, while
    /// `twenty-seven` on its own normalises to `27` and matches nothing.
    /// [`crate::vocab::extract_terms`] already emits the whole figure phrase,
    /// so a caller that forwards its output unmodified is correct by
    /// construction; one that splits terms up first quietly marks less than it
    /// thinks.
    ///
    /// A multi-word term is therefore resolved BOTH ways — as one phrase and
    /// word by word — and the union is marked. The two compiler entry points
    /// disagree about the context a number is normalised in:
    /// [`compile`] normalises a whole spoken line, so it holds `27000000`,
    /// while [`compile_tokens`] normalises each authored token separately and
    /// holds `27` and `million`. Resolving only the phrase would mark nothing
    /// at all on the token path, which is the one the app compiles through.
    ///
    /// Returns how many terms matched no atom in this script. Bias provenance
    /// fails open — an unmatched term leaves its words looking unsolicited, so
    /// they keep the full authority to move the reader — and the failure is
    /// otherwise silent. A caller enabling bias should treat a non-zero count
    /// as a defect in what it is about to send, not as routine. Some cases are
    /// known: the extractor can emit `one hundred` for a script that compiled
    /// `one hundred and five` into `105`, and a term is never partially
    /// matched into a folded figure.
    ///
    /// Every occurrence of a matched token is flagged, not just the one inside
    /// the extracted phrase. The recogniser's hotword configuration applies to
    /// the whole take rather than to one position, so a term biases each place
    /// it could be heard. That over-approximates, and deliberately: the cost is
    /// a relocation that needs more evidence, never a following step that gets
    /// less.
    ///
    /// [`AlignmentConfig::biased_content_weight_milli`]: crate::config::AlignmentConfig::biased_content_weight_milli
    pub fn set_biased_terms(&mut self, terms: &[String]) -> usize {
        let mut biased: HashSet<u32> = HashSet::new();
        let mut unmatched = 0usize;
        for term in terms {
            let mut matched = false;
            for surface in bias_surfaces(self.language, term) {
                // The interner is shared with the transcript, so a hit there is
                // not proof the script contains the word. The postings are
                // built from script atoms alone, which is what settles it.
                let known = self
                    .interner
                    .get(&surface)
                    .filter(|id| self.token_postings.contains_key(id));
                if let Some(id) = known {
                    biased.insert(id);
                    matched = true;
                }
            }
            if !matched && !term.trim().is_empty() {
                unmatched += 1;
            }
        }
        for atom in &mut self.atoms {
            if biased.contains(&atom.id) {
                atom.flags |= FLAG_BIASED;
            } else {
                atom.flags &= !FLAG_BIASED;
            }
        }
        unmatched
    }

    /// Transcript text, normalised and classified the way the script itself was.
    ///
    /// The classification travels WITH the atom rather than being recomputed
    /// downstream, which is what stops the ledger and the aligner reaching for
    /// the global English helpers behind the script's back. `filler`,
    /// `stopword` and the phonetic key are all language decisions, and this is
    /// the one place in the transcript path that knows the language.
    pub fn query_words(&self, text: &str) -> Vec<QueryWord> {
        let profile = self.language.profile();
        self.query_atoms(text)
            .into_iter()
            .map(|surface| QueryWord {
                filler: profile.is_filler(&surface),
                stopword: profile.is_stopword(&surface),
                phonetic: phonetic_key_for(self.language, &surface),
                surface,
            })
            .collect()
    }

    /// Is this canonical word one the script itself contains? The interner is
    /// shared with the transcript, so membership is decided by the postings —
    /// which are built from script atoms alone.
    fn knows(&self, word: &str) -> bool {
        self.interner
            .get(word)
            .is_some_and(|id| self.token_postings.contains_key(&id))
    }

    fn rejoin_split_words(&self, mut atoms: Vec<String>) -> Vec<String> {
        if self.token_postings.is_empty() || atoms.len() < 2 {
            return atoms;
        }
        // One lookup per atom, decided up front. This runs on every partial of
        // every item, and a reader reading the script produces runs where every
        // word is already a script word — which the guard below rejects without
        // building a single string.
        let known: Vec<bool> = atoms.iter().map(|a| self.knows(a)).collect();
        if known.iter().all(|k| *k) {
            return atoms;
        }

        let mut out: Vec<String> = Vec::with_capacity(atoms.len());
        let mut candidate = String::new();
        let mut i = 0;
        while i < atoms.len() {
            let mut joined: Option<(String, usize)> = None;
            candidate.clear();
            candidate.push_str(&atoms[i]);
            let reach = MAX_REJOIN_ATOMS.min(atoms.len() - i);
            for span in 2..=reach {
                candidate.push_str(&atoms[i + span - 1]);
                if known[i..i + span].iter().all(|k| *k) {
                    continue;
                }
                if candidate.len() >= MIN_REJOIN_LEN && self.knows(&candidate) {
                    joined = Some((candidate.clone(), span));
                }
            }
            match joined {
                Some((word, span)) => {
                    out.push(word);
                    i += span;
                }
                None => {
                    // Moved, not copied: everything below `i` is finished with.
                    out.push(std::mem::take(&mut atoms[i]));
                    i += 1;
                }
            }
        }
        out
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

/// How many transcript atoms may be glued back into one script word, and how
/// long the result must be. Three covers the compounds people actually build
/// (`BrightHarbour`, `LumenWorks`); six characters keeps the rule away from
/// short function words that happen to concatenate into something real.
const MAX_REJOIN_ATOMS: usize = 3;
const MIN_REJOIN_LEN: usize = 6;

pub fn compile(source: &str, options: CompileOptions) -> CompiledScript {
    let mut interner = Interner::default();
    let mut atoms: Vec<ScriptAtom> = Vec::new();
    let paras = for_each_spoken_line(source, options, |line_no, para, text| {
        push_line(
            text,
            line_no,
            para,
            options.language,
            &mut interner,
            &mut atoms,
        );
    });

    let para_count = if atoms.is_empty() { 0 } else { paras + 1 };
    let token_count = atoms.len() as u32;
    finalize(atoms, interner, para_count, token_count, options.language)
}

/// Does this authored word end a sentence?
///
/// Shared by the vocabulary extractor and the compiler so there is one answer
/// to the question in the crate, and it reads the AUTHORED spelling: by the
/// time text is atoms the punctuation is gone.
///
/// It is deliberately crude, and its two ways of being wrong are NOT worth the
/// same. Calling a boundary that is not one caps prediction early, and a
/// display trailing the reader by a word is the error this engine is built to
/// prefer. MISSING one is not free: it hands that stretch back to the paragraph
/// ceiling, which is precisely the overrun this brake exists to stop.
///
/// So the known imprecisions are worth naming in both directions. An honorific
/// (`Dr.`) reads as terminal here, which is the harmless direction. A figure
/// ending a sentence (`...up 27. Next year...`) does NOT, because the same rule
/// is what stops `3.14` being two sentences — that one costs a brake.
///
/// Both are confined to this entry point, which is the benchmark harness's.
/// The live path never reaches here: the app segments sentences with a real
/// abbreviation list (`src/shared/markdown/segment.ts`) and sends the
/// boundaries over IPC, so it gets `Dr.` and `27.` right. So a bench number is
/// not the product's number, and not a bound on it either — it errs in both
/// directions at once, braking where the product would not and running on
/// where it would stop.
///
/// Sharpening it is also a change to what the vocabulary extractor calls a
/// sentence, so it belongs with its own measurement rather than riding along
/// with a change to the display ceiling.
pub(crate) fn ends_sentence(raw: &str) -> bool {
    let trimmed = raw.trim_end_matches(['"', '\'', ')', ']', '”', '’']);
    let Some(last) = trimmed.chars().last() else {
        return false;
    };
    if !matches!(last, '.' | '!' | '?') {
        return false;
    }
    // `3.` never ends a sentence in a script that is reading figures aloud, and
    // a dotted acronym (`U.S.`) is one the tokenizer keeps whole.
    let body = &trimmed[..trimmed.len() - last.len_utf8()];
    if body.chars().last().is_some_and(|c| c.is_ascii_digit()) {
        return false;
    }
    body.chars().filter(|c| c.is_alphanumeric()).count() > 1 && !body.contains('.')
}

/// Walk the Markdown once and hand every SPOKEN run of text to `visit`, with
/// the source line and paragraph ordinal it belongs to.
///
/// Extracted from [`compile`] so that everything deciding "what does the
/// presenter actually say out loud" reads one copy of these rules. The
/// vocabulary extractor needs the same answer as the compiler and needs it in
/// the AUTHORED spelling — `compile` has already lowercased and split by the
/// time it has atoms, so it could not be reused wholesale.
///
/// Returns the final paragraph ordinal, which is one less than the paragraph
/// COUNT and is only meaningful when at least one line was spoken.
pub(crate) fn for_each_spoken_line(
    source: &str,
    options: CompileOptions,
    mut visit: impl FnMut(u32, u32, &str),
) -> u32 {
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
                visit(line_no as u32, para, text);
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
        visit(line_no as u32, para, &inline);
        last_line_had_content = true;
    }
    para
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
    /// This token is the last one of its sentence.
    ///
    /// Told, not inferred. The caller's own tokenizer has already dropped the
    /// full stop by the time it has a surface — `$12` and `well-known` survive
    /// intact, `end.` arrives as `end` — so the engine cannot read a boundary
    /// off the text the way it can on the Markdown path. The caller can: it
    /// segmented the document to lay it out, and knows where its own units
    /// stop. Whether those units are grammatical sentences is the caller's
    /// business; the engine brakes wherever it is told to.
    ///
    /// `false` everywhere is a valid answer. It costs nothing but the finer
    /// ceiling: paragraph ends are still sentence ends, so prediction brakes
    /// exactly where it used to.
    pub sentence_end: bool,
}

/// Compile from the caller's own spoken tokens.
///
/// A token may expand into several atoms (`$12` → `12 dollars`), into one, or
/// into none at all (a surface that normalizes away entirely). All three are
/// fine: the atom→token axis is built from what actually survives, so it stays
/// monotone regardless.
pub fn compile_tokens(tokens: &[TokenInput]) -> CompiledScript {
    compile_tokens_in(tokens, AlignmentLanguage::English)
}

/// The same, for a caller that knows which language the tokens are in.
pub fn compile_tokens_in(tokens: &[TokenInput], language: AlignmentLanguage) -> CompiledScript {
    let mut interner = Interner::default();
    let mut atoms: Vec<ScriptAtom> = Vec::new();

    for (index, token) in tokens.iter().enumerate() {
        for canonical in canonical_atoms_for(language, &token.surface) {
            let id = interner.intern(&canonical);
            atoms.push(ScriptAtom {
                id,
                surface: canonical,
                weight: 1000,
                line: token.line,
                para: token.para,
                flags: 0,
                occurrences: 0,
                phonetic: PhoneticKey::default(),
                token: index as u32,
            });
        }
        // The last atom standing is the sentence's last atom: a token that
        // normalized away entirely leaves the boundary on the word before it,
        // which is where the reader's voice actually stops.
        if token.sentence_end {
            if let Some(last) = atoms.last_mut() {
                last.flags |= FLAG_SENTENCE_END;
            }
        }
    }

    let para_count = atoms.last().map_or(0, |a| a.para + 1);
    finalize(atoms, interner, para_count, tokens.len() as u32, language)
}

/// Occurrence counts, weights, flags, postings and the token axis — everything
/// that is a pure function of the atom sequence, shared by both entry points so
/// the two can never drift in how they weigh a word.
fn finalize(
    mut atoms: Vec<ScriptAtom>,
    interner: Interner,
    para_count: u32,
    token_count: u32,
    language: AlignmentLanguage,
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
        let stop = is_stopword_for(language, surface);
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
        // Only anchor-grade words can ever take the phonetic relation, so only
        // they need a key; the rest keep the empty one, which never matches.
        if atom.flags & FLAG_ANCHOR != 0 {
            atom.phonetic = phonetic_key_for(language, &atom.surface);
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
    let para_end = build_para_end(&atoms);
    force_paragraph_tails(&mut atoms);
    let sentence_end = build_sentence_end(&atoms);

    CompiledScript {
        language,
        para_count,
        token_count,
        atom_token_pos,
        para_end,
        sentence_end,
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

/// Force every paragraph's last atom to be a sentence end.
///
/// A paragraph break is a sentence break whether or not the author typed a full
/// stop before it: running out of paragraph is running out of something to say.
/// Doing it here, on the atoms, rather than in each compile path means the two
/// paths cannot disagree about it, and it is what makes `sentence_end <=
/// para_end` hold by construction rather than by assertion.
///
/// "Paragraph" means whatever each path counted as one, and the two do not
/// agree on tight structure. The live compiler gives every heading and every
/// list item its own block. [`for_each_spoken_line`] only starts a new one at a
/// blank line, so `- alpha\n- bravo` is one paragraph to it and two to the app.
/// That divergence predates sentences and is not introduced here — but it does
/// mean an unpunctuated tight list brakes per LIST on the benchmark path and
/// per ITEM in the product, so a bench number about one says little about the
/// other.
fn force_paragraph_tails(atoms: &mut [ScriptAtom]) {
    if atoms.is_empty() {
        return;
    }
    for i in 0..atoms.len() - 1 {
        if atoms[i].para != atoms[i + 1].para {
            atoms[i].flags |= FLAG_SENTENCE_END;
        }
    }
    let last = atoms.len() - 1;
    atoms[last].flags |= FLAG_SENTENCE_END;
}

/// Exclusive end of each atom's sentence, read off the flags the compile paths
/// set. One pass, for the same reason `build_para_end` needs only one: atoms
/// are in reading order, so a sentence is a contiguous run.
fn build_sentence_end(atoms: &[ScriptAtom]) -> Vec<u32> {
    let mut ends = vec![0u32; atoms.len()];
    let mut start = 0usize;
    while start < atoms.len() {
        let mut end = start;
        while end < atoms.len() && atoms[end].flags & FLAG_SENTENCE_END == 0 {
            end += 1;
        }
        // The atom carrying the flag belongs to the sentence it ends.
        end = (end + 1).min(atoms.len());
        for slot in ends.iter_mut().take(end).skip(start) {
            *slot = end as u32;
        }
        start = end;
    }
    ends
}

/// Exclusive end of each atom's paragraph. Atoms are in reading order, so a
/// paragraph is a contiguous run and one pass over them is enough.
fn build_para_end(atoms: &[ScriptAtom]) -> Vec<u32> {
    let mut ends = vec![0u32; atoms.len()];
    let mut start = 0usize;
    while start < atoms.len() {
        let para = atoms[start].para;
        let mut end = start;
        while end < atoms.len() && atoms[end].para == para {
            end += 1;
        }
        for slot in ends.iter_mut().take(end).skip(start) {
            *slot = end as u32;
        }
        start = end;
    }
    ends
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

fn push_line(
    text: &str,
    line: u32,
    para: u32,
    language: AlignmentLanguage,
    interner: &mut Interner,
    atoms: &mut Vec<ScriptAtom>,
) {
    let canonical_line = canonical_atoms_for(language, text);
    let breaks = sentence_atom_breaks(language, text, &canonical_line);
    let base = atoms.len();
    for canonical in canonical_line {
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
            phonetic: PhoneticKey::default(),
            token,
        });
    }
    for end in breaks {
        atoms[base + end - 1].flags |= FLAG_SENTENCE_END;
    }
}

/// Where this line's sentences end, as EXCLUSIVE offsets into the atoms the
/// line just produced. Empty when the line holds no interior boundary, or when
/// finding one would have meant changing the atoms.
///
/// Normalization is not a per-word function: `itn_numbers` merges a spelled
/// number across several words into one atom, `split_word` turns `$12` into
/// two, and currency and unit expansion reorder what is left. So there is no
/// arithmetic that maps "the third raw word" onto an atom index, and the only
/// honest way to ask where a sentence ends is to normalize each sentence on
/// its own and count.
///
/// Which is a second opinion about what the atoms are, and the compiled script
/// can only have one. So the split is a MEASUREMENT, never the output: the
/// caller keeps the whole-line atoms regardless, and these offsets are handed
/// back only when normalizing the pieces reproduced the whole exactly. When a
/// number phrase or a currency run straddles a full stop the two disagree, and
/// the answer is no interior boundary for that line rather than an atom stream
/// that depends on where the sentences fell. Gold positions in the benchmark
/// corpus are atom indexes; a compiler that quietly renumbered them to brake
/// more often would invalidate the very measurements meant to judge it.
fn sentence_atom_breaks(
    language: AlignmentLanguage,
    text: &str,
    canonical_line: &[String],
) -> Vec<usize> {
    let mut chunks: Vec<(String, bool)> = Vec::new();
    let mut current = String::new();
    for raw in text.split_whitespace() {
        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(raw);
        if ends_sentence(raw) {
            chunks.push((std::mem::take(&mut current), true));
        }
    }
    // A trailing run with no terminator is the rest of a sentence that carries
    // on past this line — real text, but not a boundary.
    if !current.is_empty() {
        chunks.push((current, false));
    }
    if chunks.iter().filter(|(_, terminated)| *terminated).count() == 0 {
        return Vec::new();
    }

    let mut breaks = Vec::new();
    let mut rebuilt: Vec<String> = Vec::with_capacity(canonical_line.len());
    for (chunk, terminated) in &chunks {
        rebuilt.extend(canonical_atoms_for(language, chunk));
        // A sentence that normalized away entirely ends where the previous one
        // did; there is no atom of its own to hang the flag on.
        if *terminated && !rebuilt.is_empty() && breaks.last() != Some(&rebuilt.len()) {
            breaks.push(rebuilt.len());
        }
    }
    if rebuilt != canonical_line {
        return Vec::new();
    }
    breaks
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

    /// The whole point of the setter. Bias is off today, and a compiler that
    /// guessed at provenance would weaken the jump gates on every take of a
    /// product whose recogniser was never told anything.
    #[test]
    fn compiling_never_infers_bias_provenance() {
        let source = "RustLight Games shipped twenty-seven updates to LumenWorks.";
        let script = compile(source, CompileOptions::default());
        assert!(script.atoms.iter().all(|a| a.flags & FLAG_BIASED == 0));

        // Not even when the extractor would happily nominate those very words.
        let terms = crate::vocab::extract_from_markdown(
            source,
            CompileOptions::default(),
            crate::vocab::VocabLimits::default(),
        );
        assert!(!terms.is_empty());
        assert!(script.atoms.iter().all(|a| a.flags & FLAG_BIASED == 0));
    }

    /// The flags describe the decoder's CURRENT configuration, so a second call
    /// replaces the first rather than adding to it.
    #[test]
    fn setting_bias_terms_replaces_the_active_set() {
        let mut script = compile(
            "The teleprompter follows the presenter closely.",
            CompileOptions::default(),
        );
        let marked = |s: &CompiledScript| -> Vec<String> {
            s.atoms
                .iter()
                .filter(|a| a.flags & FLAG_BIASED != 0)
                .map(|a| a.surface.clone())
                .collect()
        };

        script.set_biased_terms(&["teleprompter".to_string()]);
        assert_eq!(marked(&script), vec!["teleprompter"]);

        script.set_biased_terms(&["presenter".to_string()]);
        assert_eq!(marked(&script), vec!["presenter"], "stale marks persisted");

        script.set_biased_terms(&[]);
        assert!(marked(&script).is_empty(), "an empty set must unbias");

        // Clearing bias must not have taken the lexical flags with it.
        let by_surface: HashMap<&str, &ScriptAtom> = script
            .atoms
            .iter()
            .map(|a| (a.surface.as_str(), a))
            .collect();
        assert!(by_surface["teleprompter"].flags & FLAG_ANCHOR != 0);
        assert!(by_surface["the"].flags & FLAG_STOPWORD != 0);
    }

    /// Terms arrive in the authored spelling; atoms are canonical. A term has
    /// to survive the same normalisation the script went through, or the
    /// provenance silently marks nothing.
    #[test]
    fn bias_terms_are_canonicalised_the_way_the_script_was() {
        let mut script = compile(
            "RustLight Games raised twenty-seven million last spring.",
            CompileOptions::default(),
        );
        script.set_biased_terms(&[
            "RustLight Games".to_string(),
            "twenty-seven million".to_string(),
        ]);

        let marked: Vec<&str> = script
            .atoms
            .iter()
            .filter(|a| a.flags & FLAG_BIASED != 0)
            .map(|a| a.surface.as_str())
            .collect();
        // A multi-word term reaches both constituents, and the figure reaches
        // the atom actually compiled from it rather than the authored spelling.
        assert_eq!(marked, vec!["rustlight", "games", "27000000"]);
    }

    /// Numbers canonicalise in context, so half a figure is not a term. Worth
    /// pinning: the failure is silent in the flags — the caller gets an unbiased
    /// script back and a jump gate that believes its evidence was unsolicited.
    /// The returned count is the only thing that says so.
    #[test]
    fn half_a_figure_is_not_the_term_the_script_compiled() {
        let mut script = compile("We raised twenty-seven million.", CompileOptions::default());
        assert!(script.atoms.iter().any(|a| a.surface == "27000000"));

        assert_eq!(script.set_biased_terms(&["twenty-seven".to_string()]), 1);
        assert!(script.atoms.iter().all(|a| a.flags & FLAG_BIASED == 0));

        assert_eq!(script.set_biased_terms(&["twenty-seven million".to_string()]), 0);
        assert_eq!(
            script
                .atoms
                .iter()
                .filter(|a| a.flags & FLAG_BIASED != 0)
                .count(),
            1
        );
    }

    /// The compiler entry points normalise in different contexts: `compile`
    /// takes a whole spoken line and folds `twenty-seven million` into one
    /// atom, while `compile_tokens` — the path the app compiles through —
    /// normalises each authored token on its own and holds two. A term resolved
    /// only as a phrase would mark nothing at all in production.
    #[test]
    fn a_figure_term_reaches_both_compiler_entry_points() {
        let tokens: Vec<TokenInput> = ["We", "raised", "twenty-seven", "million"]
            .iter()
            .map(|surface| TokenInput {
                surface: (*surface).to_string(),
                line: 0,
                para: 0,
                // Irrelevant here: bias provenance is lexical and this test
                // asserts nothing about a ceiling.
                sentence_end: false,
            })
            .collect();
        let mut script = compile_tokens(&tokens);
        assert!(
            script.atoms.iter().any(|a| a.surface == "27"),
            "token path no longer splits the figure: {:?}",
            script.atoms.iter().map(|a| &a.surface).collect::<Vec<_>>()
        );

        assert_eq!(script.set_biased_terms(&["twenty-seven million".to_string()]), 0);
        let marked: Vec<&str> = script
            .atoms
            .iter()
            .filter(|a| a.flags & FLAG_BIASED != 0)
            .map(|a| a.surface.as_str())
            .collect();
        assert_eq!(marked, vec!["27", "million"]);
    }

    /// A term matching nothing is reported, and reported per term rather than
    /// per word, so a caller can act on "this many of the words I am about to
    /// send will not be discounted".
    #[test]
    fn terms_that_match_no_atom_are_counted_not_swallowed() {
        let mut script = compile("Only these words exist.", CompileOptions::default());
        let unmatched = script.set_biased_terms(&[
            "kombucha".to_string(),
            "these words".to_string(),
            "entirely absent phrase".to_string(),
            "   ".to_string(),
        ]);
        // "kombucha" and "entirely absent phrase" miss; the blank is not a term.
        assert_eq!(unmatched, 2);
    }

    /// The decoder is configured for the whole take, not for one position, so a
    /// term biases every place it could be heard.
    #[test]
    fn a_bias_term_marks_every_occurrence_of_the_word() {
        let mut script = compile(
            "Harbour opens. Then harbour closes. Nothing else.",
            CompileOptions::default(),
        );
        script.set_biased_terms(&["harbour".to_string()]);
        assert_eq!(
            script
                .atoms
                .iter()
                .filter(|a| a.flags & FLAG_BIASED != 0)
                .count(),
            2
        );
    }

    /// Provenance may not invent vocabulary. A term the script does not contain
    /// is dropped rather than interned, so it cannot later be resolved as one.
    #[test]
    fn a_bias_term_the_script_lacks_marks_nothing_and_interns_nothing() {
        let mut script = compile("Only these words exist.", CompileOptions::default());
        let before = script.interner.len();
        script.set_biased_terms(&["kombucha".to_string(), String::new()]);
        assert!(script.atoms.iter().all(|a| a.flags & FLAG_BIASED == 0));
        assert_eq!(script.interner.len(), before);
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
                sentence_end: false,
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
                sentence_end: false,
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
                sentence_end: false,
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
                sentence_end: false,
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
                sentence_end: false,
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

    /// The paragraph rule, stated as behaviour: prediction may run to the end
    /// of the paragraph the reader is audibly in, and stops dead at the break.
    #[test]
    fn prediction_stops_at_the_paragraph_it_was_heard_in() {
        // Two paragraphs: atoms 0..3 and 3..6.
        let script = compile("alpha bravo charlie\n\ndelta echo foxtrot\n", CompileOptions::default());
        assert_eq!(script.para_end, vec![3, 3, 3, 6, 6, 6]);

        // Mid-first-paragraph: may be carried to the end of it, no further.
        assert_eq!(script.prediction_ceiling(1.0), 3.0);
        assert_eq!(script.prediction_ceiling(2.5), 3.0);

        // The frontier sits exactly ON the break: the reader has finished the
        // first paragraph and not yet been heard in the second, so the ceiling
        // must still be the break. Answering 6 here would let the display fade
        // the next paragraph's opening words on no evidence at all.
        assert_eq!(script.prediction_ceiling(3.0), 3.0);

        // One word of the second paragraph heard — now it may run to ITS end.
        assert_eq!(script.prediction_ceiling(4.0), 6.0);

        // Out of range clamps rather than panicking.
        assert_eq!(script.prediction_ceiling(0.0), 3.0);
        assert_eq!(script.prediction_ceiling(999.0), 6.0);
    }

    #[test]
    fn an_empty_script_has_no_prediction_room() {
        assert_eq!(compile_tokens(&[]).prediction_ceiling(0.0), 0.0);
    }

    /// The sentence rule, stated the same way: prediction may run to the end of
    /// the sentence the reader is audibly in, and stops dead at the full stop.
    #[test]
    fn prediction_stops_at_the_sentence_it_was_heard_in() {
        // ONE paragraph, two sentences: atoms 0..3 and 3..6. The paragraph
        // ceiling would have allowed the display all six from the first word.
        let script = compile(
            "alpha bravo charlie. delta echo foxtrot.\n",
            CompileOptions::default(),
        );
        assert_eq!(script.para_end, vec![6, 6, 6, 6, 6, 6]);
        assert_eq!(script.sentence_end, vec![3, 3, 3, 6, 6, 6]);

        // Mid-first-sentence: carried to the end of it, no further.
        assert_eq!(script.prediction_ceiling(1.0), 3.0);
        assert_eq!(script.prediction_ceiling(2.5), 3.0);

        // The frontier sits exactly ON the full stop. The reader has finished
        // the sentence and has not been heard in the next one — which is the
        // moment they are most likely to be drawing breath, and exactly when
        // fading `delta` would be a guess about a word they have not reached.
        assert_eq!(script.prediction_ceiling(3.0), 3.0);

        // One word of the second sentence heard — now it may run to ITS end.
        assert_eq!(script.prediction_ceiling(4.0), 6.0);

        // Out of range clamps rather than panicking.
        assert_eq!(script.prediction_ceiling(0.0), 3.0);
        assert_eq!(script.prediction_ceiling(999.0), 6.0);

        // Switched off, the same script answers the way it used to.
        assert_eq!(script.paragraph_ceiling(1.0), 6.0);
        assert_eq!(script.paragraph_ceiling(3.0), 6.0);
    }

    /// A sentence end is never allowed to reach past a paragraph end, and a
    /// paragraph end is always a sentence end even when nobody punctuated it.
    #[test]
    fn sentence_ends_never_run_past_paragraph_ends() {
        let script = compile(
            "alpha bravo. charlie\n\ndelta echo foxtrot\n",
            CompileOptions::default(),
        );
        assert_eq!(script.para_end, vec![3, 3, 3, 6, 6, 6]);
        // `charlie` closes its paragraph with no full stop, and still ends a
        // sentence: the reader has finished saying something either way.
        assert_eq!(script.sentence_end, vec![2, 2, 3, 6, 6, 6]);
        for (at, (sentence, para)) in script
            .sentence_end
            .iter()
            .zip(script.para_end.iter())
            .enumerate()
        {
            assert!(sentence <= para, "atom {at}: {sentence} > {para}");
        }
    }

    /// The graceful-degradation property, stated as a test rather than left as
    /// a claim: with no terminal punctuation anywhere the finer table collapses
    /// onto the coarser one and the engine behaves exactly as it did before.
    #[test]
    fn a_script_with_no_punctuation_keeps_the_paragraph_ceiling() {
        let script = compile("alpha bravo charlie\n\ndelta echo\n", CompileOptions::default());
        assert_eq!(script.sentence_end, script.para_end);
    }

    /// The parity guard. Normalization runs over a whole line at once and
    /// merges across word boundaries, so asking it where the sentences end can
    /// change what the atoms ARE — and the benchmark corpus indexes its gold
    /// positions by atom, so a compiler that renumbered them to brake more
    /// often would invalidate the measurements meant to judge it.
    #[test]
    fn finding_a_boundary_never_changes_the_atoms() {
        // `twenty` and `one` sit either side of the full stop and merge into a
        // single `21` when the line is normalized whole — the one case where
        // splitting first would have produced different atoms.
        let text = "It was twenty. One more thing.";
        let script = compile(text, CompileOptions::default());

        let surfaces: Vec<String> = script.atoms.iter().map(|a| a.surface.clone()).collect();
        assert_eq!(
            surfaces,
            canonical_atoms_for(AlignmentLanguage::English, text),
            "the atoms must be what normalizing the whole line produces"
        );
        // Having declined to split, the line offers no interior boundary and
        // the paragraph ceiling stands.
        assert_eq!(script.sentence_end, script.para_end);
    }

    /// The same guard where the split IS safe, so the test above cannot pass by
    /// the fallback never being exercised in either direction.
    #[test]
    fn a_boundary_is_found_when_splitting_agrees_with_the_whole_line() {
        // `twenty twenty four` merges into one atom WITHIN its sentence, so the
        // whole-line and per-sentence normalizations agree and the boundary is
        // taken. `$12` expanding to two atoms inside the second sentence pins
        // that the offsets are counted in atoms, not in words.
        let text = "We shipped in twenty twenty four. Revenue hit $12 today.";
        let script = compile(text, CompileOptions::default());

        let surfaces: Vec<String> = script.atoms.iter().map(|a| a.surface.clone()).collect();
        assert_eq!(
            surfaces,
            vec!["we", "shipped", "in", "2024", "revenue", "hit", "12", "dollars", "today"]
        );
        assert_eq!(
            surfaces,
            canonical_atoms_for(AlignmentLanguage::English, text)
        );
        assert_eq!(script.sentence_end, vec![4, 4, 4, 4, 9, 9, 9, 9, 9]);
    }

    /// A sentence that runs over a line break still ends on the right atom.
    ///
    /// `push_line` sees one line at a time, so the boundary is found in line
    /// two's own coordinates and has to be rebased onto the atoms already
    /// emitted. Line one contributing NO boundary is the correct answer there —
    /// the sentence did not end on it.
    #[test]
    fn a_sentence_running_over_a_line_break_ends_on_the_right_atom() {
        let script = compile("Alpha bravo\ncharlie delta. Echo\n", CompileOptions::default());

        let surfaces: Vec<&str> = script.atoms.iter().map(|a| a.surface.as_str()).collect();
        assert_eq!(surfaces, vec!["alpha", "bravo", "charlie", "delta", "echo"]);
        // Two source lines, one paragraph.
        assert_eq!(
            script.atoms.iter().map(|a| a.line).collect::<Vec<_>>(),
            vec![0, 0, 1, 1, 1]
        );
        assert_eq!(script.para_end, vec![5, 5, 5, 5, 5]);
        // The full stop is after `delta`, atom 3 — not after line one's atoms.
        assert_eq!(script.sentence_end, vec![4, 4, 4, 4, 5]);
    }

    /// The live path cannot read punctuation off a surface — the app's
    /// tokenizer has already dropped it — so it is told instead, and the flag
    /// has to land on the last atom the token expanded into.
    #[test]
    fn a_told_sentence_end_lands_on_the_last_atom_of_its_token() {
        let tokens = vec![
            TokenInput {
                surface: "Revenue".into(),
                line: 0,
                para: 0,
                sentence_end: false,
            },
            TokenInput {
                surface: "hit".into(),
                line: 0,
                para: 0,
                sentence_end: false,
            },
            // One token, two atoms: `12` and `dollars`.
            TokenInput {
                surface: "$12".into(),
                line: 0,
                para: 0,
                sentence_end: true,
            },
            TokenInput {
                surface: "Onward".into(),
                line: 0,
                para: 0,
                sentence_end: true,
            },
        ];
        let script = compile_tokens(&tokens);
        let surfaces: Vec<&str> = script.atoms.iter().map(|a| a.surface.as_str()).collect();
        assert_eq!(surfaces, vec!["revenue", "hit", "12", "dollars", "onward"]);

        // The boundary is after `dollars`, not after `12`.
        assert_eq!(script.sentence_end, vec![4, 4, 4, 4, 5]);
        assert_eq!(script.prediction_ceiling(1.0), 4.0);
        assert_eq!(script.prediction_ceiling(4.0), 4.0);
        assert_eq!(script.prediction_ceiling(5.0), 5.0);
    }

    /// A caller that says nothing about sentences — every older one — loses the
    /// finer ceiling and nothing else.
    ///
    /// Two paragraphs, deliberately: with one, an implementation that only ever
    /// flagged the very last atom of the script would pass this and still have
    /// dropped every interior paragraph tail.
    #[test]
    fn tokens_that_declare_no_sentences_fall_back_to_paragraphs() {
        let tokens: Vec<TokenInput> = [("alpha", 0), ("bravo", 0), ("charlie", 1), ("delta", 1)]
            .iter()
            .map(|(s, para)| TokenInput {
                surface: (*s).to_string(),
                line: 0,
                para: *para,
                sentence_end: false,
            })
            .collect();
        let script = compile_tokens(&tokens);
        assert_eq!(script.para_end, vec![2, 2, 4, 4]);
        assert_eq!(script.sentence_end, script.para_end);
    }

    /// A sentence whose every token normalizes away must not hand its boundary
    /// to the sentence that follows — that would brake the display a whole
    /// sentence early, at a full stop nobody will ever say.
    #[test]
    fn a_leading_atomless_sentence_does_not_end_the_next_one() {
        let tokens = vec![
            TokenInput {
                surface: "…".into(),
                line: 0,
                para: 0,
                sentence_end: true,
            },
            TokenInput {
                surface: "alpha".into(),
                line: 0,
                para: 0,
                sentence_end: false,
            },
            TokenInput {
                surface: "bravo".into(),
                line: 0,
                para: 0,
                sentence_end: true,
            },
        ];
        let script = compile_tokens(&tokens);
        let surfaces: Vec<&str> = script.atoms.iter().map(|a| a.surface.as_str()).collect();
        assert_eq!(surfaces, vec!["alpha", "bravo"]);
        // `alpha` opens the real first sentence; it does not close a phantom one.
        assert_eq!(script.atoms[0].flags & FLAG_SENTENCE_END, 0);
        assert_eq!(script.sentence_end, vec![2, 2]);
    }

    /// A token that normalizes away cannot take the boundary with it: the
    /// reader's voice stopped on the last word that survived.
    #[test]
    fn a_sentence_ending_on_an_unspoken_token_keeps_its_boundary() {
        let tokens = vec![
            TokenInput {
                surface: "alpha".into(),
                line: 0,
                para: 0,
                sentence_end: false,
            },
            TokenInput {
                surface: "…".into(),
                line: 0,
                para: 0,
                sentence_end: true,
            },
            TokenInput {
                surface: "bravo".into(),
                line: 0,
                para: 0,
                sentence_end: true,
            },
        ];
        let script = compile_tokens(&tokens);
        let surfaces: Vec<&str> = script.atoms.iter().map(|a| a.surface.as_str()).collect();
        assert_eq!(surfaces, vec!["alpha", "bravo"]);
        assert_eq!(script.sentence_end, vec![1, 2]);
    }

    /// What the shared predicate actually does, rather than what its old
    /// comment claimed. The honorific is the known imprecision; it is recorded
    /// here so a future change to it is a deliberate one.
    #[test]
    fn terminal_punctuation_is_read_conservatively() {
        assert!(ends_sentence("end."));
        assert!(ends_sentence("really?"));
        assert!(ends_sentence("stop!"));
        assert!(ends_sentence("done.\""));
        assert!(ends_sentence("done.)"));
        // A figure being read aloud, and a dotted acronym.
        assert!(!ends_sentence("3."));
        assert!(!ends_sentence("U.S."));
        assert!(!ends_sentence("e.g."));
        // No terminator at all.
        assert!(!ends_sentence("word"));
        assert!(!ends_sentence(""));
        // Single letter: an initial, not a sentence.
        assert!(!ends_sentence("J."));
        // KNOWN IMPRECISION: an honorific reads as terminal here. Harmless on
        // this path — it brakes the display a word early, which is the safe
        // direction — and unreachable on the live one, which is told its
        // boundaries by a segmenter that knows better.
        assert!(ends_sentence("Dr."));
    }

    /// The recogniser heard no capital letter and wrote two words. The script
    /// has one, and it is the one that has to win.
    #[test]
    fn a_name_the_recogniser_split_is_put_back_together() {
        let script = compile(
            "We ship with RustLight Games and LumenWorks every quarter.",
            CompileOptions::default(),
        );
        assert_eq!(
            script.query_atoms("we ship with rust light games"),
            vec!["we", "ship", "with", "rustlight", "games"]
        );
        // Three pieces, same rule.
        let three = compile("The BrightHarbourWorks release.", CompileOptions::default());
        assert_eq!(
            three.query_atoms("the bright harbour works release"),
            vec!["the", "brightharbourworks", "release"]
        );
    }

    /// The timid half of the rule. If the script says both words on their own,
    /// two words is a reading it already supports, and gluing them would take a
    /// decision that belongs to the aligner.
    #[test]
    fn words_the_script_uses_separately_are_left_alone() {
        let script = compile(
            "The lighthouse is dark. We keep a light in the house.",
            CompileOptions::default(),
        );
        assert_eq!(
            script.query_atoms("we keep a light in the house"),
            vec!["we", "keep", "a", "light", "in", "the", "house"]
        );
    }

    #[test]
    fn a_join_never_invents_a_word_the_script_does_not_have() {
        let script = compile("Nothing here matches.", CompileOptions::default());
        assert_eq!(
            script.query_atoms("some other words entirely"),
            vec!["some", "other", "words", "entirely"]
        );
    }

    #[test]
    fn postings_are_ascending_and_complete() {
        let script = compile("alpha beta alpha gamma alpha", CompileOptions::default());
        let alpha = script.interner.get("alpha").unwrap();
        assert_eq!(script.token_postings[&alpha], vec![0, 2, 4]);
    }

    /// Both compiler entry points record the language, so a script can always
    /// say what it was normalised as.
    #[test]
    fn both_entry_points_carry_the_language() {
        let from_markdown = compile("alpha beta", CompileOptions::default());
        assert_eq!(from_markdown.language(), AlignmentLanguage::English);

        let from_tokens = compile_tokens(&[TokenInput {
            surface: "alpha".into(),
            line: 0,
            para: 0,
            sentence_end: false,
        }]);
        assert_eq!(from_tokens.language(), AlignmentLanguage::English);

        let explicit = compile_tokens_in(
            &[TokenInput {
                surface: "alpha".into(),
                line: 0,
                para: 0,
                sentence_end: false,
            }],
            AlignmentLanguage::English,
        );
        assert_eq!(explicit.language(), AlignmentLanguage::English);
    }

    /// The reason the language lives on the compiled script at all.
    ///
    /// The transcript side does not get told which language to normalise as —
    /// it reads the one the script was compiled with. There is no second value
    /// to disagree with the first, which is what keeps the "0 of 26" class
    /// (compiler and tracker holding different opinions about what a word is)
    /// out of reach rather than merely tested for.
    #[test]
    fn the_transcript_side_takes_its_language_from_the_script() {
        let script = compile("We raised $2.4 million in the fourth quarter.", CompileOptions::default());

        // The same text, normalised by the script path and by the query path,
        // lands on the same atoms — because there is only one language here.
        assert_eq!(
            script.query_atoms("we raised $2.4 million"),
            canonical_atoms_for(script.language(), "we raised $2.4 million")
        );

        let words = script.query_words("um we raised the money");
        let surfaces: Vec<&str> = words.iter().map(|w| w.surface.as_str()).collect();
        assert_eq!(surfaces, vec!["um", "we", "raised", "the", "money"]);

        // And the classification travels WITH the word, rather than being
        // recomputed downstream against a global English list.
        assert!(words[0].filler, "um is a filler");
        assert!(words[1].stopword, "we is a stopword");
        assert!(!words[2].stopword, "raised is content");
        assert!(words.iter().all(|w| !w.filler || !w.stopword));
    }
}
