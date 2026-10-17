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

/// The ways a bias term could have compiled: as one phrase, and word by word.
///
/// Two representations rather than one flat set of surfaces, because the two
/// compiler entry points normalise in different contexts — see
/// [`CompiledScript::set_biased_terms`] — and a term counts as present only if
/// one of them survives INTACT. Flattening them would let a stray constituent
/// stand in for the whole: a script that says `one` somewhere would "resolve"
/// the term `one hundred` while the figure it came from went unmarked, which is
/// precisely the silent miss the term count exists to report.
fn bias_representations(language: AlignmentLanguage, term: &str) -> Vec<Vec<String>> {
    let phrase = canonical_atoms_for(language, term);
    if term.split_whitespace().nth(1).is_none() {
        return vec![phrase];
    }
    let by_token: Vec<String> = term
        .split_whitespace()
        .flat_map(|word| canonical_atoms_for(language, word))
        .collect();
    if by_token == phrase {
        vec![phrase]
    } else {
        vec![phrase, by_token]
    }
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
    /// When the recogniser says this word was spoken, on the audio clock.
    ///
    /// `None` whenever the recogniser reported no per-word timing, or reported
    /// timing this script could not line up against its own atoms — see
    /// [`CompiledScript::query_words_with_times`]. The ledger dates an atom by
    /// interpolation in that case, exactly as it always has.
    pub measured_start_ms: Option<f64>,
}

/// One word the recogniser timed, in the engine's own vocabulary.
///
/// A copy of `cc_stt::WordTime` rather than a re-export: the engine does not
/// depend on the recogniser crate, and a benchmark replaying captured frames
/// has to be able to build these without one.
#[derive(Debug, Clone, PartialEq)]
pub struct TranscriptWordTime {
    pub text: String,
    /// Onset of this word on the audio clock, in milliseconds.
    pub start_ms: f64,
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
            for representation in bias_representations(self.language, term) {
                if representation.is_empty() {
                    continue;
                }
                // All or nothing: a representation the script only partly
                // contains is not this term, and marking its stray words would
                // discount evidence the decoder was never biased toward.
                //
                // The interner is shared with the transcript, so a hit there is
                // not proof the script contains the word. The postings are
                // built from script atoms alone, which is what settles it.
                let ids: Option<Vec<u32>> = representation
                    .iter()
                    .map(|surface| {
                        self.interner
                            .get(surface)
                            .filter(|id| self.token_postings.contains_key(id))
                    })
                    .collect();
                if let Some(ids) = ids {
                    biased.extend(ids);
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
                measured_start_ms: None,
            })
            .collect()
    }

    /// The same words, carrying the recogniser's own clock where it can be
    /// trusted to describe the same atoms.
    ///
    /// The atoms are ALWAYS the ones [`CompiledScript::query_words`] would have
    /// produced for `text`. Timing is the only thing this can add, and the only
    /// thing it can get wrong — which is why the surfaces are compared rather
    /// than assumed, and why a disagreement returns the untimed words instead
    /// of a best guess.
    ///
    /// # Why the atoms have to be re-derived to be dated
    ///
    /// `word_times` is keyed to the RECOGNISER's word boundaries, and this
    /// script's are not the same ones: `$12` is one word to the recogniser and
    /// the atoms `12 dollars` here, while `Rust Light` is two words there and
    /// the single atom `rustlight` here. Zipping the two lists together lines
    /// up only until the first disagreement and then silently mis-clocks
    /// everything after it.
    ///
    /// So the correspondence is MEASURED, the way [`sentence_atom_breaks`]
    /// measures where a sentence ends: normalise each recogniser word on its
    /// own, concatenate, and use the result only if it reproduced the whole
    /// exactly. When it does, each atom's source word is known outright rather
    /// than inferred. When it does not — a spelled number or a currency run
    /// that only normalises correctly as a phrase — there is no honest mapping
    /// and this hands back untimed words rather than a plausible one.
    pub fn query_words_with_times(
        &self,
        text: &str,
        word_times: &[TranscriptWordTime],
    ) -> Vec<QueryWord> {
        match self.dated_atoms(text, word_times) {
            Some(dated) => {
                let profile = self.language.profile();
                dated
                    .into_iter()
                    .map(|(surface, start_ms)| QueryWord {
                        filler: profile.is_filler(&surface),
                        stopword: profile.is_stopword(&surface),
                        phonetic: phonetic_key_for(self.language, &surface),
                        surface,
                        measured_start_ms: Some(start_ms),
                    })
                    .collect()
            }
            None => self.query_words(text),
        }
    }

    /// Atoms paired with the onset of the recogniser word each came from, or
    /// `None` when the two accounts of the text cannot be shown to agree.
    fn dated_atoms(
        &self,
        text: &str,
        word_times: &[TranscriptWordTime],
    ) -> Option<Vec<(String, f64)>> {
        if word_times.is_empty() {
            return None;
        }
        // A time that is not a number, or one that goes backwards, is not
        // evidence about when anything was said. `cc_stt` already guarantees
        // both; a captured fixture or a future recogniser might not, and the
        // cost of checking is one pass over a handful of words.
        let mut previous = f64::NEG_INFINITY;
        for word in word_times {
            if !word.start_ms.is_finite() || word.start_ms < previous {
                return None;
            }
            previous = word.start_ms;
        }

        // Each recogniser word normalised on its own, remembering which word
        // every atom came from.
        let mut rebuilt: Vec<String> = Vec::new();
        let mut source: Vec<usize> = Vec::new();
        for (index, word) in word_times.iter().enumerate() {
            for atom in canonical_atoms_for(self.language, &word.text) {
                rebuilt.push(atom);
                source.push(index);
            }
        }
        if rebuilt.is_empty() {
            return None;
        }
        // The whole, normalised as one run — which is what the engine actually
        // aligns against. Anything the pieces did differently means a transform
        // spanned a word boundary, and the mapping is guesswork from there.
        if rebuilt != canonical_atoms_for(self.language, text) {
            return None;
        }

        // The join runs on the reconstruction, so it consumes the same spans it
        // would have consumed on the whole — and reports which, so a joined
        // atom keeps a source word rather than losing one.
        let (joined, spans) = self.rejoin_split_words_tracked(rebuilt);
        Some(
            joined
                .into_iter()
                .zip(spans)
                .map(|(surface, span)| {
                    // The LAST recogniser word the atom covers. A word is not
                    // finished being said until its final piece has been, and
                    // dating `rustlight` to `rust` would put it before half the
                    // sound it stands for.
                    let start_ms = word_times[source[span.end - 1]].start_ms;
                    (surface, start_ms)
                })
                .collect(),
        )
    }

    /// Is this canonical word one the script itself contains? The interner is
    /// shared with the transcript, so membership is decided by the postings —
    /// which are built from script atoms alone.
    fn knows(&self, word: &str) -> bool {
        self.interner
            .get(word)
            .is_some_and(|id| self.token_postings.contains_key(&id))
    }

    fn rejoin_split_words(&self, atoms: Vec<String>) -> Vec<String> {
        self.rejoin_split_words_tracked(atoms).0
    }

    /// The join, reporting which input atoms each output atom was built from.
    ///
    /// One implementation rather than two: a second copy of this walk that only
    /// counted spans would be free to drift from the one that decides the
    /// atoms, and a span that disagrees with the join it describes is worse
    /// than no span at all. The extra vector is the same order of cost as the
    /// `known` lookups the join already builds.
    fn rejoin_split_words_tracked(
        &self,
        mut atoms: Vec<String>,
    ) -> (Vec<String>, Vec<std::ops::Range<usize>>) {
        let identity = |n: usize| (0..n).map(|i| i..i + 1).collect::<Vec<_>>();
        if self.token_postings.is_empty() || atoms.len() < 2 {
            let spans = identity(atoms.len());
            return (atoms, spans);
        }
        // One lookup per atom, decided up front. This runs on every partial of
        // every item, and a reader reading the script produces runs where every
        // word is already a script word — which the guard below rejects without
        // building a single string.
        let known: Vec<bool> = atoms.iter().map(|a| self.knows(a)).collect();
        if known.iter().all(|k| *k) {
            let spans = identity(atoms.len());
            return (atoms, spans);
        }

        let mut out: Vec<String> = Vec::with_capacity(atoms.len());
        let mut spans: Vec<std::ops::Range<usize>> = Vec::with_capacity(atoms.len());
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
                    spans.push(i..i + span);
                    i += span;
                }
                None => {
                    // Moved, not copied: everything below `i` is finished with.
                    out.push(std::mem::take(&mut atoms[i]));
                    spans.push(i..i + 1);
                    i += 1;
                }
            }
        }
        (out, spans)
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
pub fn for_each_spoken_line(
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
///
/// # Normalised a sentence at a time, attributed a token at a time
///
/// Each token used to be normalised on its own. That is the right answer for
/// almost every word and the wrong one wherever normalisation reaches across a
/// word boundary — which spelled numbers always do. A script that says
/// `one hundred and forty-three` arrives as four tokens and compiled to
/// `one hundred and 43`, while the recogniser's `one hundred and forty three`
/// is normalised as a phrase, to `143`. Nothing on the script side could match
/// it, and the display stopped on a number the presenter had already said.
/// The Markdown path never had the problem because it normalises a whole line
/// at once, which is also why the benchmark — which compiled through that path
/// — could not see it: replaying the captured corpus through THIS compile took
/// `live.within5` on the two figures fixtures from 85.4% and 98.6% to 78.4% and
/// 92.5%.
///
/// So each sentence is normalised as one string, the way a transcript is, and
/// every resulting atom is attributed back to the tokens it came from by
/// aligning it against the per-token normalisation (see [`attribute_atoms`]).
/// Where the two agree — every sentence without a cross-word rule in it — the
/// result is exactly what the per-token compile produced.
///
/// One limit is inherited rather than introduced. The tokens carry no
/// punctuation, but neither does the number folding on either side: the
/// shared normaliser strips commas before it folds, so `nineteen, twenty`
/// becomes `1920` in a transcript that spells it out and in a Markdown
/// compile alike, and now in this one too. A transcript that writes the
/// digits (`19, 20`) matches neither. Fixing that belongs in the normaliser,
/// for both sides at once.
pub fn compile_tokens_in(tokens: &[TokenInput], language: AlignmentLanguage) -> CompiledScript {
    let mut interner = Interner::default();
    let mut atoms: Vec<ScriptAtom> = Vec::new();

    let mut start = 0usize;
    while start < tokens.len() {
        // A run is one sentence inside one block: it ends on a sentence end or
        // before the block changes. Normalisation never reaches across either,
        // which keeps a number at the end of one sentence from absorbing the
        // number that opens the next.
        let mut end = start + 1;
        while end < tokens.len()
            && !tokens[end - 1].sentence_end
            && tokens[end].para == tokens[start].para
        {
            end += 1;
        }
        let run = &tokens[start..end];
        for (canonical, index) in attribute_atoms(run, start, language) {
            let token = &tokens[index];
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
        if run.last().is_some_and(|t| t.sentence_end) {
            if let Some(last) = atoms.last_mut() {
                last.flags |= FLAG_SENTENCE_END;
            }
        }
        start = end;
    }

    let para_count = atoms.last().map_or(0, |a| a.para + 1);
    finalize(atoms, interner, para_count, tokens.len() as u32, language)
}

/// The atoms of one sentence, normalised as a phrase, each with the index of
/// the token it belongs to.
///
/// The per-token normalisation knows exactly which token every atom came from;
/// the phrase normalisation is the one that agrees with a transcript. Where
/// they disagree, ownership has to be inferred, and the inference is built so
/// that every error it can make is in the SAFE direction. An atom credited to
/// a token later than the one it really came from moves the token axis ahead
/// of the speech — words dimmed before they are said — while one credited
/// earlier only makes the display trail. So:
///
/// * the common prefix and suffix keep their own tokens outright. Most of a
///   sentence is one of these, and nothing has to be inferred about it;
/// * the stretch between is aligned (minimum edits, equal strings matching)
///   with ties broken toward the EARLIEST per-token atom, so a word that occurs
///   both inside and outside a number (`and one hundred and forty-three`)
///   anchors to its first occurrence rather than its second;
/// * a disagreeing stretch — `one hundred and 43` against `143` — is spread
///   across the tokens it came from, in order, starting on the first. A single
///   merged atom therefore lands on the FIRST of its tokens and the axis
///   interpolates it across all of them;
/// * tokens whose atoms the phrase absorbed without leaving an atom of their
///   own (`zero twenty` → `20`) hand their position to the next atom, which
///   starts earlier rather than leaving them to be skipped;
/// * past `MAX_ATTRIBUTION_CELLS` the stretch is not aligned at all but spread
///   evenly — still in order, still starting on its first token — so an
///   unpunctuated legacy payload cannot turn into a quadratic allocation.
///
/// Monotone by construction: every stretch sits between agreeing atoms whose
/// tokens bound it, and the hand-forward only ever lowers a token toward one
/// already passed.
fn attribute_atoms(
    run: &[TokenInput],
    offset: usize,
    language: AlignmentLanguage,
) -> Vec<(String, usize)> {
    let per: Vec<(String, usize)> = run
        .iter()
        .enumerate()
        .flat_map(|(i, t)| {
            canonical_atoms_for(language, &t.surface)
                .into_iter()
                .map(move |a| (a, offset + i))
        })
        .collect();
    if run.len() < 2 {
        return per;
    }
    let joined = run
        .iter()
        .map(|t| t.surface.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let phrase = canonical_atoms_for(language, &joined);
    if phrase.len() == per.len() && phrase.iter().zip(&per).all(|(a, (b, _))| a == b) {
        return per;
    }

    // The agreeing prefix and suffix need no inference.
    let prefix = phrase
        .iter()
        .zip(&per)
        .take_while(|(a, (b, _))| *a == b)
        .count();
    let suffix = phrase[prefix..]
        .iter()
        .rev()
        .zip(per[prefix..].iter().rev())
        .take_while(|(a, (b, _))| *a == b)
        .count();
    let middle = &phrase[prefix..phrase.len() - suffix];
    let per_middle = &per[prefix..per.len() - suffix];
    // The token the middle starts on: its own first per-token atom's, or —
    // when the per-token side has nothing there — the token the prefix ended
    // on, which is never later than where the middle's speech begins.
    let middle_start = per_middle
        .first()
        .map(|(_, t)| *t)
        .or_else(|| per[..prefix].last().map(|(_, t)| *t))
        .unwrap_or(offset);

    let mut out: Vec<(String, usize)> = Vec::with_capacity(phrase.len());
    out.extend(phrase[..prefix].iter().cloned().zip(per[..prefix].iter().map(|(_, t)| *t)));
    let carried = attribute_middle(middle, per_middle, middle_start, &mut out);
    let suffix_start = out.len();
    out.extend(
        phrase[phrase.len() - suffix..]
            .iter()
            .cloned()
            .zip(per[per.len() - suffix..].iter().map(|(_, t)| *t)),
    );
    // Tokens the middle absorbed without an atom go to the first atom after
    // it, exactly as they would to the next atom inside the middle.
    if let (Some(c), Some(first)) = (carried, out.get_mut(suffix_start)) {
        first.1 = first.1.min(c);
    }
    out
}

/// The alignment `attribute_atoms` performs, capped. Beyond this many DP
/// cells the disagreeing stretch is spread evenly instead: a sentence-sized
/// stretch is a few hundred cells, and only a paragraph sent without any
/// sentence ends can approach this.
const MAX_ATTRIBUTION_CELLS: usize = 250_000;

/// Returns the tokens it absorbed without leaving an atom, still waiting for
/// one — the caller hands them to the next atom after the stretch.
fn attribute_middle(
    phrase: &[String],
    per: &[(String, usize)],
    start_token: usize,
    out: &mut Vec<(String, usize)>,
) -> Option<usize> {
    let (n, m) = (phrase.len(), per.len());
    if n == 0 {
        return per.first().map(|(_, t)| *t);
    }
    // Spread `atoms` across tokens `first..=last`, in order, from the first.
    let spread = |atoms: &[String], first: usize, last: usize, out: &mut Vec<(String, usize)>| {
        let span = last.max(first) - first + 1;
        for (k, atom) in atoms.iter().enumerate() {
            out.push((atom.clone(), first + k * span / atoms.len()));
        }
    };
    if m == 0 || (n + 1) * (m + 1) > MAX_ATTRIBUTION_CELLS {
        let last = per.last().map_or(start_token, |(_, t)| *t);
        spread(phrase, start_token, last, out);
        return None;
    }

    let mut d = vec![vec![0u32; m + 1]; n + 1];
    for (i, row) in d.iter_mut().enumerate() {
        row[0] = i as u32;
    }
    for j in 0..=m {
        d[0][j] = j as u32;
    }
    for i in 1..=n {
        for j in 1..=m {
            let sub = d[i - 1][j - 1] + u32::from(phrase[i - 1] != per[j - 1].0);
            d[i][j] = sub.min(d[i - 1][j] + 1).min(d[i][j - 1] + 1);
        }
    }
    // Walk back from the end, consuming a per-token atom before matching
    // whenever that costs nothing extra: each phrase atom then pairs with the
    // EARLIEST per-token atom an optimal alignment allows.
    let mut anchors: Vec<(usize, usize)> = Vec::new();
    let (mut i, mut j) = (n, m);
    while i > 0 && j > 0 {
        let equal = phrase[i - 1] == per[j - 1].0;
        if d[i][j] == d[i][j - 1] + 1 {
            j -= 1;
        } else if d[i][j] == d[i - 1][j - 1] + u32::from(!equal) {
            if equal {
                anchors.push((i - 1, j - 1));
            }
            i -= 1;
            j -= 1;
        } else {
            i -= 1;
        }
    }
    anchors.reverse();

    // Tokens absorbed without an atom of their own, waiting to be handed to
    // the next atom.
    let mut carried: Option<usize> = None;
    let mut prev: Option<(usize, usize)> = None;
    for anchor in anchors.iter().copied().map(Some).chain(std::iter::once(None)) {
        let phrase_from = prev.map_or(0, |(pi, _)| pi + 1);
        let phrase_to = anchor.map_or(n, |(pi, _)| pi);
        let per_from = prev.map_or(0, |(_, pj)| pj + 1);
        let per_to = anchor.map_or(m, |(_, pj)| pj);
        let first_per = (per_to > per_from).then(|| per[per_from].1);
        if phrase_to > phrase_from {
            // A stretch with per-token atoms spreads over their tokens; one
            // with none (an atom only the phrase produced, like a reordered
            // currency unit) stays on the token BEFORE it, never the next.
            let (first, last) = match first_per {
                Some(first) => (first, per[per_to - 1].1),
                None => {
                    let t = prev.map_or(start_token, |(_, pj)| per[pj].1);
                    (t, t)
                }
            };
            let first = carried.take().map_or(first, |c| c.min(first));
            spread(&phrase[phrase_from..phrase_to], first, last, out);
        } else if let Some(first) = first_per {
            carried = Some(carried.map_or(first, |c| c.min(first)));
        }
        if let Some((pi, pj)) = anchor {
            let own = per[pj].1;
            let token = carried.take().map_or(own, |c| c.min(own));
            out.push((phrase[pi].clone(), token));
        }
        prev = anchor;
    }
    carried
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
    /// takes a whole spoken line, `compile_tokens` — the path the app compiles
    /// through — a sentence of authored tokens. Both now fold
    /// `twenty-seven million` into one atom (they used to disagree, which is
    /// what `compile_tokens_in` documents), and a figure term must still mark
    /// it on the path production actually takes.
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
        let markdown = compile("We raised twenty-seven million", CompileOptions::default());
        let surfaces = |s: &CompiledScript| s.atoms.iter().map(|a| a.surface.clone()).collect::<Vec<_>>();
        assert_eq!(surfaces(&script), surfaces(&markdown));

        assert_eq!(script.set_biased_terms(&["twenty-seven million".to_string()]), 0);
        let marked: Vec<&str> = script
            .atoms
            .iter()
            .filter(|a| a.flags & FLAG_BIASED != 0)
            .map(|a| a.surface.as_str())
            .collect();
        assert_eq!(marked, vec!["27000000"]);
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

    /// A stray constituent is not the term. `one hundred and five` compiles to
    /// `105`, so the extractor's `one hundred` matched nothing — and must be
    /// reported as such even though the script says `one` elsewhere, or the
    /// count reassures a caller about provenance it does not have.
    #[test]
    fn a_partly_present_term_is_not_a_match() {
        let mut script = compile(
            "One more thing: we shipped one hundred and five units.",
            CompileOptions::default(),
        );
        let surfaces: Vec<&str> = script.atoms.iter().map(|a| a.surface.as_str()).collect();
        assert!(surfaces.contains(&"one"), "fixture lost its stray word: {surfaces:?}");
        assert!(surfaces.contains(&"105"), "fixture lost its figure: {surfaces:?}");

        assert_eq!(script.set_biased_terms(&["one hundred".to_string()]), 1);
        // And the stray `one` is left unmarked, so nothing is discounted on the
        // strength of a word the decoder was never told about as such.
        assert!(script.atoms.iter().all(|a| a.flags & FLAG_BIASED == 0));
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

    fn words(text: &str, sentence_end_after: &[usize]) -> Vec<TokenInput> {
        text.split_whitespace()
            .enumerate()
            .map(|(i, s)| TokenInput {
                surface: s.to_string(),
                line: 0,
                para: 0,
                sentence_end: sentence_end_after.contains(&i),
            })
            .collect()
    }

    /// A spelled number spans several tokens and must compile to the atom a
    /// transcript of it normalises to — not to one atom per word.
    #[test]
    fn a_spelled_number_across_tokens_compiles_like_its_transcript() {
        let script = compile_tokens(&words(
            "Support handled one hundred and forty-three escalations",
            &[6],
        ));
        let surfaces: Vec<&str> = script.atoms.iter().map(|a| a.surface.as_str()).collect();
        assert_eq!(surfaces, vec!["support", "handled", "143", "escalations"]);
        assert_eq!(
            script.query_atoms("support handled one hundred and forty three escalations"),
            surfaces,
        );
        // The merged atom sits on the FIRST of its four tokens and the axis
        // spreads it across all of them, so finishing the number passes the
        // whole run and starting it passes none of it.
        assert_eq!(script.atoms[2].token, 2);
        assert_eq!(script.atoms[3].token, 6);
        assert_eq!(script.token_at(2.0), 2.0);
        assert_eq!(script.token_at(3.0), 6.0);
    }

    /// Several merges in one sentence, plus words both normalisations agree on,
    /// keep reading order and a monotone axis.
    #[test]
    fn mixed_merges_stay_in_order() {
        let script = compile_tokens(&words(
            "We had twenty seven thousand accounts and nineteen thousand four hundred users",
            &[11],
        ));
        let surfaces: Vec<&str> = script.atoms.iter().map(|a| a.surface.as_str()).collect();
        assert_eq!(
            surfaces,
            vec!["we", "had", "27000", "accounts", "and", "19400", "users"]
        );
        let tokens: Vec<u32> = script.atoms.iter().map(|a| a.token).collect();
        assert_eq!(tokens, vec![0, 1, 2, 5, 6, 7, 11]);
        let mut previous = f64::NEG_INFINITY;
        for &position in &script.atom_token_pos {
            assert!(position >= previous, "axis went backwards at {position}");
            previous = position;
        }
    }

    fn token_indexes(script: &CompiledScript) -> Vec<u32> {
        script.atoms.iter().map(|a| a.token).collect()
    }

    /// A word that occurs both outside and inside a number must keep its own
    /// token. Matching the leading `and` to the one inside the number started
    /// the axis three tokens late — the words before it would have been drawn
    /// as spoken before anyone said them.
    #[test]
    fn a_repeated_word_keeps_its_own_token() {
        let script = compile_tokens(&words("and one hundred and forty-three people", &[5]));
        let surfaces: Vec<&str> = script.atoms.iter().map(|a| a.surface.as_str()).collect();
        assert_eq!(surfaces, vec!["and", "143", "people"]);
        assert_eq!(token_indexes(&script), vec![0, 1, 5]);
        assert_eq!(script.token_at(0.0), 0.0);

        let tail = compile_tokens(&words("one hundred and forty-three and more", &[5]));
        assert_eq!(token_indexes(&tail), vec![0, 4, 5]);
    }

    /// A token the phrase absorbed without an atom of its own hands its place
    /// to the next atom, so it is passed when that atom is said and not before.
    #[test]
    fn an_absorbed_token_is_not_skipped() {
        let script = compile_tokens(&words("zero twenty seconds", &[2]));
        assert_eq!(script.atoms[0].token, 0, "{:?}", token_indexes(&script));
        assert_eq!(script.token_at(0.0), 0.0);
    }

    /// Currency reordering moves an atom past a token; the moved atom stays on
    /// the token before it rather than reaching forward, and the token left
    /// without an atom (`million`) is handed to the next word — so it is passed
    /// a word late, never a word early.
    #[test]
    fn reordered_currency_never_reaches_forward() {
        let script = compile_tokens(&words("Revenue was $2.4 million today", &[4]));
        let surfaces: Vec<&str> = script.atoms.iter().map(|a| a.surface.as_str()).collect();
        assert_eq!(surfaces, vec!["revenue", "was", "2.4", "million", "dollars", "today"]);
        assert_eq!(token_indexes(&script), vec![0, 1, 2, 2, 2, 3]);
    }

    /// A paragraph sent without sentence ends — an older payload — with the
    /// disagreements far apart: the alignment would need millions of cells, so
    /// the stretch is spread instead, still in order.
    #[test]
    fn an_unpunctuated_paragraph_stays_bounded_and_monotone() {
        let mut text = String::from("twenty seven ");
        for i in 0..3000 {
            text.push_str(if i % 2 == 0 { "plain " } else { "words " });
        }
        text.push_str("twenty seven");
        let tokens = words(&text, &[]);
        let script = compile_tokens(&tokens);
        assert_eq!(script.atoms.first().unwrap().surface, "27");
        assert_eq!(script.atoms.last().unwrap().surface, "27");
        assert_eq!(script.atoms.first().unwrap().token, 0);
        let mut previous = 0u32;
        for atom in &script.atoms {
            assert!(atom.token >= previous);
            previous = atom.token;
        }
        assert!(previous as usize <= tokens.len() - 1);
    }

    /// Normalisation never reaches across a sentence end: a number closing one
    /// sentence does not absorb the number opening the next.
    #[test]
    fn a_sentence_end_bounds_the_phrase() {
        let script = compile_tokens(&words("we counted twenty Seven more arrived", &[2]));
        let surfaces: Vec<&str> = script.atoms.iter().map(|a| a.surface.as_str()).collect();
        assert_eq!(surfaces, vec!["we", "counted", "20", "7", "more", "arrived"]);
        assert!(script.atoms[2].flags & FLAG_SENTENCE_END != 0);
    }

    /// Where no rule crosses a word boundary the result is exactly the old
    /// per-token compile, token for token.
    #[test]
    fn ordinary_sentences_compile_exactly_as_before() {
        let tokens = words("It's $12, well-known and 50% cheaper than before", &[7]);
        let script = compile_tokens(&tokens);
        let per_token: Vec<(String, u32)> = tokens
            .iter()
            .enumerate()
            .flat_map(|(i, t)| {
                canonical_atoms_for(AlignmentLanguage::English, &t.surface)
                    .into_iter()
                    .map(move |a| (a, i as u32))
            })
            .collect();
        let compiled: Vec<(String, u32)> = script
            .atoms
            .iter()
            .map(|a| (a.surface.clone(), a.token))
            .collect();
        assert_eq!(compiled, per_token);
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

    // ---------------------------------------------------------------
    // Dating atoms from the recogniser's word times
    // ---------------------------------------------------------------

    fn timed(words: &[(&str, f64)]) -> Vec<TranscriptWordTime> {
        words
            .iter()
            .map(|(text, start_ms)| TranscriptWordTime {
                text: (*text).to_string(),
                start_ms: *start_ms,
            })
            .collect()
    }

    fn dated(script: &CompiledScript, text: &str, times: &[TranscriptWordTime]) -> Vec<(String, Option<f64>)> {
        script
            .query_words_with_times(text, times)
            .into_iter()
            .map(|w| (w.surface, w.measured_start_ms))
            .collect()
    }

    /// The ordinary case, and the one that has to work or none of this is worth
    /// having: plain speech, one recogniser word per atom.
    ///
    /// This is deliberately shaped the way a real frame is — the text is the
    /// words joined back together — because a reconciliation that only ever
    /// declines is decoration, and this codebase has shipped one of those
    /// before.
    #[test]
    fn plain_speech_is_dated_word_for_word() {
        let script = compile("we should build a simple system", CompileOptions::default());
        let times = timed(&[
            ("we", 100.0),
            ("should", 340.0),
            ("build", 620.0),
            ("a", 900.0),
            ("simple", 1_040.0),
            ("system", 1_380.0),
        ]);
        assert_eq!(
            dated(&script, "we should build a simple system", &times),
            vec![
                ("we".to_string(), Some(100.0)),
                ("should".to_string(), Some(340.0)),
                ("build".to_string(), Some(620.0)),
                ("a".to_string(), Some(900.0)),
                ("simple".to_string(), Some(1_040.0)),
                ("system".to_string(), Some(1_380.0)),
            ]
        );
    }

    /// Punctuation rides along on the recogniser's words, because the model is
    /// punctuated and that is the text a real frame carries.
    #[test]
    fn punctuated_recogniser_words_still_line_up() {
        let script = compile("hello world it works", CompileOptions::default());
        let times = timed(&[
            ("Hello,", 100.0),
            ("world.", 400.0),
            ("It", 800.0),
            ("works.", 1_000.0),
        ]);
        assert_eq!(
            dated(&script, "Hello, world. It works.", &times),
            vec![
                ("hello".to_string(), Some(100.0)),
                ("world".to_string(), Some(400.0)),
                ("it".to_string(), Some(800.0)),
                ("works".to_string(), Some(1_000.0)),
            ]
        );
    }

    /// One recogniser word, several atoms. Both halves of `$12` were said
    /// during the one word the recogniser timed, so both take its clock.
    #[test]
    fn atoms_split_from_one_word_share_its_clock() {
        let script = compile("it costs $12 today", CompileOptions::default());
        let times = timed(&[("it", 100.0), ("costs", 300.0), ("$12", 700.0), ("today", 1_200.0)]);
        assert_eq!(
            dated(&script, "it costs $12 today", &times),
            vec![
                ("it".to_string(), Some(100.0)),
                ("costs".to_string(), Some(300.0)),
                ("12".to_string(), Some(700.0)),
                ("dollars".to_string(), Some(700.0)),
                ("today".to_string(), Some(1_200.0)),
            ]
        );
    }

    /// Several recogniser words, one atom. The script writes `RustLight`; the
    /// recogniser hears no capital letter and writes two words. The joined atom
    /// is dated to the LAST of them — it is not finished being said until the
    /// second half has been.
    #[test]
    fn a_joined_atom_takes_the_clock_of_its_last_word() {
        let script = compile("we ship with rustlight games", CompileOptions::default());
        let times = timed(&[
            ("we", 100.0),
            ("ship", 300.0),
            ("with", 500.0),
            ("rust", 700.0),
            ("light", 900.0),
            ("games", 1_100.0),
        ]);
        let out = dated(&script, "we ship with rust light games", &times);
        assert_eq!(
            out.iter().map(|(s, _)| s.as_str()).collect::<Vec<_>>(),
            vec!["we", "ship", "with", "rustlight", "games"]
        );
        assert_eq!(out[3].1, Some(900.0), "dated to `light`, not `rust`");
    }

    /// A transform that only works as a phrase has no honest per-word mapping,
    /// so the whole revision goes untimed rather than partly mis-timed.
    #[test]
    fn a_number_spanning_words_declines_rather_than_guesses() {
        let script = compile("we saw forty two of them", CompileOptions::default());
        let times = timed(&[
            ("we", 100.0),
            ("saw", 300.0),
            ("forty", 500.0),
            ("two", 700.0),
            ("of", 900.0),
            ("them", 1_100.0),
        ]);
        let out = dated(&script, "we saw forty two of them", &times);
        // The atoms are still exactly what the untimed path produces.
        assert_eq!(
            out.iter().map(|(s, _)| s.as_str()).collect::<Vec<_>>(),
            vec!["we", "saw", "42", "of", "them"]
        );
        assert!(
            out.iter().all(|(_, t)| t.is_none()),
            "no atom may be dated when the pieces disagree with the whole"
        );
    }

    /// Timing that describes different text than the frame does is not evidence
    /// about the frame. It is refused whole rather than zipped on positionally.
    #[test]
    fn timing_for_other_text_is_refused() {
        let script = compile("alpha bravo charlie", CompileOptions::default());
        let times = timed(&[("alpha", 100.0), ("delta", 300.0)]);
        let out = dated(&script, "alpha bravo charlie", &times);
        assert_eq!(
            out.iter().map(|(s, _)| s.as_str()).collect::<Vec<_>>(),
            vec!["alpha", "bravo", "charlie"]
        );
        assert!(out.iter().all(|(_, t)| t.is_none()));
    }

    /// A number that is not one, or a sequence that goes backwards, says
    /// nothing about when anything was spoken.
    #[test]
    fn unusable_times_are_refused() {
        let script = compile("alpha bravo", CompileOptions::default());
        for bad in [
            timed(&[("alpha", f64::NAN), ("bravo", 300.0)]),
            timed(&[("alpha", 500.0), ("bravo", 300.0)]),
            timed(&[("alpha", f64::INFINITY), ("bravo", 300.0)]),
        ] {
            let out = dated(&script, "alpha bravo", &bad);
            assert!(
                out.iter().all(|(_, t)| t.is_none()),
                "expected no timing from {bad:?}"
            );
        }
        // And no timing at all is simply the untimed path.
        assert!(dated(&script, "alpha bravo", &[])
            .iter()
            .all(|(_, t)| t.is_none()));
    }

    /// A timed word that normalises to nothing contributes no atom, and must
    /// not shift the words around it onto the wrong clock.
    #[test]
    fn a_word_that_normalises_to_nothing_does_not_shift_the_others() {
        let script = compile("alpha bravo charlie", CompileOptions::default());
        // The middle entry is punctuation the normaliser drops entirely.
        let times = timed(&[("alpha", 100.0), ("--", 200.0), ("bravo", 300.0), ("charlie", 500.0)]);
        assert_eq!(
            dated(&script, "alpha -- bravo charlie", &times),
            vec![
                ("alpha".to_string(), Some(100.0)),
                ("bravo".to_string(), Some(300.0)),
                ("charlie".to_string(), Some(500.0)),
            ]
        );
    }

    /// Empty and whitespace-only word text is not a word. It contributes no
    /// atom, exactly as punctuation does.
    #[test]
    fn empty_word_text_contributes_nothing() {
        let script = compile("alpha bravo", CompileOptions::default());
        let times = timed(&[("alpha", 100.0), ("", 200.0), ("   ", 250.0), ("bravo", 300.0)]);
        assert_eq!(
            dated(&script, "alpha bravo", &times),
            vec![
                ("alpha".to_string(), Some(100.0)),
                ("bravo".to_string(), Some(300.0)),
            ]
        );
    }

    /// Whatever timing does or does not arrive, the ATOMS are the ones the
    /// untimed path would have produced. Nothing about matching turns on
    /// whether a recogniser reports a clock.
    #[test]
    fn timing_never_changes_which_atoms_come_out() {
        let script = compile("we ship with rustlight games and saw forty two", CompileOptions::default());
        for text in [
            "we ship with rust light games",
            "we saw forty two",
            "it costs $12",
            "Hello, world.",
        ] {
            let plain: Vec<String> = script.query_words(text).into_iter().map(|w| w.surface).collect();
            // Times that fit, and times that do not.
            let fitting: Vec<TranscriptWordTime> = text
                .split_whitespace()
                .enumerate()
                .map(|(i, w)| TranscriptWordTime {
                    text: w.to_string(),
                    start_ms: i as f64 * 100.0,
                })
                .collect();
            for times in [fitting, timed(&[("nonsense", 10.0)])] {
                let timed_surfaces: Vec<String> = script
                    .query_words_with_times(text, &times)
                    .into_iter()
                    .map(|w| w.surface)
                    .collect();
                assert_eq!(timed_surfaces, plain, "atoms changed for {text:?}");
            }
        }
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
