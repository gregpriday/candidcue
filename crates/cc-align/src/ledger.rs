//! Transcript ledger: items, replacement partials, stability, and the
//! alignment tail.
//!
//! Partials are FULL RESTATEMENTS — each `Partial` for an item replaces the
//! previous text for that item, and the text can shrink.
//!
//! That property is now supplied rather than inherited. The previous provider
//! restated the whole utterance on every partial; Grok emits an interim that
//! covers only the current ~3 s chunk, and `Utterances::extend` in
//! `src-tauri/src/stt/stream.rs` prepends the chunk-finals already locked
//! before the frame is emitted. So what reaches this ledger is still a full
//! restatement of the utterance so far, and everything below is unchanged. If
//! that assembly is ever removed, this file's stability model breaks silently
//! — a partial that only carries the tail reads as a catastrophic shrink. The
//! ledger reconciles each revision against the previous one so that atoms
//! which survive revisions accumulate *stability*, and freshly changed
//! suffixes are treated as provisional. Stability is what lets the tracker
//! move before a final without trusting words the recogniser is still
//! chewing on.

use serde::Serialize;

use crate::normalize::{canonical_atoms, is_filler, phonetic_key, PhoneticKey};
use crate::script::Interner;

/// Evidence class of one transcript atom at alignment time (spec §7.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum StabilityClass {
    /// Item completed.
    Final,
    /// Survived ≥2 consecutive revisions and is not in the trailing 2 atoms.
    StablePrefix,
    /// Survived ≥1 revision, not trailing.
    AgeStable,
    /// Not trailing, but has not survived a revision yet.
    InteriorProvisional,
    /// Last 1–2 atoms of a live partial.
    TrailingProvisional,
}

impl StabilityClass {
    /// Evidence multiplier in milli. Tuned constants, see spec §7.3.
    pub fn multiplier_milli(self) -> u32 {
        match self {
            StabilityClass::Final => 1000,
            StabilityClass::StablePrefix => 950,
            StabilityClass::AgeStable => 850,
            StabilityClass::InteriorProvisional => 650,
            StabilityClass::TrailingProvisional => 350,
        }
    }

    pub fn is_stable(self) -> bool {
        matches!(
            self,
            StabilityClass::Final | StabilityClass::StablePrefix | StabilityClass::AgeStable
        )
    }
}

#[derive(Debug, Clone)]
pub struct LedgerAtom {
    pub id: u32,
    pub surface: String,
    /// Phonetic key, derived once when the atom is created rather than once
    /// per DP cell — see [`crate::script::ScriptAtom::phonetic`].
    pub phonetic: PhoneticKey,
    /// Consecutive revisions this atom has survived at this position.
    pub stability: u8,
    pub filler: bool,
}

#[derive(Debug, Clone)]
pub struct Item {
    pub item_id: String,
    pub atoms: Vec<LedgerAtom>,
    pub is_final: bool,
    pub audio_start_ms: f64,
    pub audio_end_ms: Option<f64>,
    /// Audio clock value when the latest revision of this item arrived.
    pub last_seen_audio_ms: f64,
    pub revision_count: u32,
    /// Atoms retracted (replaced) across the item's lifetime — a flicker
    /// signal for diagnostics and confidence.
    pub retracted_atoms: u32,
}

/// One atom of the alignment tail handed to the aligner, with everything the
/// observation model needs to weigh it.
#[derive(Debug, Clone)]
pub struct QueryAtom {
    pub id: u32,
    pub surface: String,
    pub phonetic: PhoneticKey,
    pub stability: StabilityClass,
    pub filler: bool,
    /// Best-effort audio time of this word (interpolated inside the item).
    pub audio_ms: f64,
    /// Index of the item this atom came from (into `Ledger::items`).
    pub item_index: usize,
}

#[derive(Debug, Default)]
pub struct Ledger {
    pub items: Vec<Item>,
}

impl Ledger {
    pub fn item_started(&mut self, item_id: &str, audio_start_ms: f64) {
        if self.items.iter().any(|i| i.item_id == item_id) {
            return;
        }
        self.items.push(Item {
            item_id: item_id.to_string(),
            atoms: Vec::new(),
            is_final: false,
            audio_start_ms,
            audio_end_ms: None,
            last_seen_audio_ms: audio_start_ms,
            revision_count: 0,
            retracted_atoms: 0,
        });
    }

    /// Apply a replacement partial (or the final restatement) for an item.
    /// Returns the number of atoms retracted by this revision.
    pub fn revise(
        &mut self,
        interner: &mut Interner,
        item_id: &str,
        text: &str,
        is_final: bool,
        audio_ms: f64,
    ) -> u32 {
        self.revise_atoms(
            interner,
            item_id,
            canonical_atoms(text),
            is_final,
            audio_ms,
        )
    }

    /// The same, for a caller that has already canonicalised the text.
    ///
    /// The tracker takes this door because its canonicalisation is
    /// script-aware — it rejoins words the recogniser split apart — and that
    /// needs the compiled script, which the ledger has no business holding.
    pub fn revise_atoms(
        &mut self,
        interner: &mut Interner,
        item_id: &str,
        atoms: Vec<String>,
        is_final: bool,
        audio_ms: f64,
    ) -> u32 {
        // An item can, in principle, receive a transcript before its
        // ItemStarted was observed (reconnect races). Open it here.
        if !self.items.iter().any(|i| i.item_id == item_id) {
            self.item_started(item_id, audio_ms);
        }
        let item = self
            .items
            .iter_mut()
            .rev()
            .find(|i| i.item_id == item_id)
            .expect("item exists");

        let new_atoms: Vec<LedgerAtom> = atoms
            .into_iter()
            .map(|surface| {
                let id = interner.intern(&surface);
                let filler = is_filler(&surface);
                LedgerAtom {
                    phonetic: phonetic_key(&surface),
                    id,
                    surface,
                    stability: 0,
                    filler,
                }
            })
            .collect();

        // Longest common prefix by canonical id survives with +1 stability.
        let common = item
            .atoms
            .iter()
            .zip(new_atoms.iter())
            .take_while(|(old, new)| old.id == new.id)
            .count();
        let retracted = (item.atoms.len() - common) as u32;

        let mut merged = Vec::with_capacity(new_atoms.len());
        for (i, mut atom) in new_atoms.into_iter().enumerate() {
            if i < common {
                atom.stability = item.atoms[i].stability.saturating_add(1);
            }
            merged.push(atom);
        }
        // Did this revision actually say anything new? A revision that
        // reproduces the previous atom sequence exactly is a HEARTBEAT, not
        // evidence: the provider is telling us it is still listening, not that
        // the words moved. Grok emits one every ~500 ms whether or not it
        // decoded anything (19 % of its partials across the benchmark corpus,
        // against 3 % on the previous provider), so the distinction is not
        // academic here.
        let unchanged = retracted == 0 && merged.len() == item.atoms.len();
        item.atoms = merged;
        item.is_final = is_final;
        item.revision_count += 1;
        item.retracted_atoms += retracted;
        // The content horizon is when the newest word was SPOKEN, and a
        // heartbeat does not move it. Advancing it here would re-date words
        // that have not changed — `tail` interpolates every word in the item
        // between its start and this value, so each heartbeat would slide the
        // whole utterance later in time and keep resetting the display's
        // extrapolation origin while the reader is still talking.
        if !unchanged {
            item.last_seen_audio_ms = audio_ms;
        }
        if is_final {
            item.audio_end_ms = Some(audio_ms);
        }
        retracted
    }

    /// The last `max_atoms` atoms across items, oldest first, with stability
    /// classes and interpolated audio times.
    ///
    /// The item timestamps are RECEIPT times, which lag the speech itself:
    /// a partial shows words spoken ~`partial_lag_ms` earlier, and a final
    /// arrives ~`endpoint_lag_ms` after the last word (server VAD waits for
    /// silence before committing). Correcting here — per timestamp kind —
    /// is what lets word times approximate actual speech time; a single
    /// downstream fudge factor cannot fix both at once.
    pub fn tail(
        &self,
        max_atoms: usize,
        partial_lag_ms: f64,
        endpoint_lag_ms: f64,
    ) -> Vec<QueryAtom> {
        let mut out: Vec<QueryAtom> = Vec::new();
        for (item_index, item) in self.items.iter().enumerate() {
            let n = item.atoms.len();
            if n == 0 {
                continue;
            }
            let start = item.audio_start_ms;
            let end = match item.audio_end_ms {
                Some(end) => end - endpoint_lag_ms,
                None => item.last_seen_audio_ms - partial_lag_ms,
            }
            .max(start + 1.0);
            for (i, atom) in item.atoms.iter().enumerate() {
                let stability = classify(item, i);
                // Word i of n spans [i/n, (i+1)/n] of the item; use the end of
                // its span as "when it had been said".
                let audio_ms = start + (end - start) * ((i + 1) as f64 / n as f64);
                out.push(QueryAtom {
                    id: atom.id,
                    surface: atom.surface.clone(),
                    phonetic: atom.phonetic,
                    stability,
                    filler: atom.filler,
                    audio_ms,
                    item_index,
                });
            }
        }
        if out.len() > max_atoms {
            out.drain(..out.len() - max_atoms);
        }
        out
    }

    pub fn current_item(&self) -> Option<&Item> {
        self.items.last()
    }
}

fn classify(item: &Item, index: usize) -> StabilityClass {
    if item.is_final {
        return StabilityClass::Final;
    }
    let n = item.atoms.len();
    let trailing = index + 2 >= n;
    let stability = item.atoms[index].stability;
    if trailing {
        return StabilityClass::TrailingProvisional;
    }
    if stability >= 2 {
        return StabilityClass::StablePrefix;
    }
    if stability >= 1 {
        return StabilityClass::AgeStable;
    }
    StabilityClass::InteriorProvisional
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ledger_with(texts: &[(&str, bool)]) -> (Ledger, Interner) {
        let mut ledger = Ledger::default();
        let mut interner = Interner::default();
        ledger.item_started("1-0", 0.0);
        for (i, (text, is_final)) in texts.iter().enumerate() {
            ledger.revise(&mut interner, "1-0", text, *is_final, (i as f64 + 1.0) * 1000.0);
        }
        (ledger, interner)
    }

    #[test]
    fn surviving_prefix_gains_stability() {
        let (ledger, _) = ledger_with(&[
            ("hello world", false),
            ("hello world this is", false),
            ("hello world this is a test", false),
        ]);
        let tail = ledger.tail(40, 0.0, 0.0);
        assert_eq!(tail[0].surface, "hello");
        // "hello" survived two revisions and is not trailing.
        assert_eq!(tail[0].stability, StabilityClass::StablePrefix);
        // The last two atoms are always trailing-provisional on a live item.
        assert_eq!(tail.last().unwrap().stability, StabilityClass::TrailingProvisional);
    }

    #[test]
    fn shrinking_partial_retracts() {
        let mut ledger = Ledger::default();
        let mut interner = Interner::default();
        ledger.item_started("1-0", 0.0);
        ledger.revise(&mut interner, "1-0", "we should build a very", false, 1000.0);
        let retracted = ledger.revise(&mut interner, "1-0", "we should build a", false, 1500.0);
        assert_eq!(retracted, 1);
        ledger.revise(&mut interner, "1-0", "we should build a complicated system", true, 2000.0);
        let tail = ledger.tail(40, 0.0, 0.0);
        assert!(tail.iter().all(|a| a.stability == StabilityClass::Final));
        assert_eq!(tail.len(), 6);
    }

    #[test]
    fn tail_spans_items_and_caps() {
        let mut ledger = Ledger::default();
        let mut interner = Interner::default();
        ledger.item_started("1-0", 0.0);
        ledger.revise(&mut interner, "1-0", "one two three", true, 1000.0);
        ledger.item_started("1-1", 1200.0);
        ledger.revise(&mut interner, "1-1", "four five six", false, 2000.0);
        let tail = ledger.tail(4, 0.0, 0.0);
        let surfaces: Vec<&str> = tail.iter().map(|a| a.surface.as_str()).collect();
        assert_eq!(surfaces, vec!["3", "4", "5", "6"]);
        assert_eq!(tail[0].item_index, 0);
        assert_eq!(tail[1].item_index, 1);
    }
}
