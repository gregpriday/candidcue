//! Transcript ledger: items, replacement partials, stability, and the
//! alignment tail.
//!
//! The recogniser sends full-restatement partials — each `Partial` for an item
//! replaces the previous text for that item, and the text can shrink. The
//! ledger reconciles each revision against the previous one so that atoms
//! which survive revisions accumulate *stability*, and freshly changed
//! suffixes are treated as provisional. Stability is what lets the tracker
//! move before a final without trusting words the recogniser is still
//! chewing on.

use serde::Serialize;

use crate::normalize::PhoneticKey;
use crate::script::{Interner, QueryWord};

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
    /// Carried rather than recomputed: which words are function words is a
    /// language decision, and only the compiled script knows the language.
    pub stopword: bool,
    /// When the recogniser says this word was spoken, if it said at all.
    ///
    /// See [`crate::script::CompiledScript::query_words_with_times`] for what
    /// makes this `None`, and [`Ledger::tail`] for how it is used — which is
    /// never on its own, and never to move an atom earlier.
    pub measured_start_ms: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct Item {
    pub item_id: String,
    pub atoms: Vec<LedgerAtom>,
    pub is_final: bool,
    pub audio_start_ms: f64,
    pub audio_end_ms: Option<f64>,
    /// When the last word of this item was actually SPOKEN, if the host could
    /// say.
    ///
    /// `audio_end_ms` is when the final was produced, which for a silence
    /// endpoint is a whole endpoint lag after the speaking stopped — that lag
    /// is what `endpoint_lag_ms` subtracts. The subtraction is a category
    /// error for the other two ways an utterance ends: a final closed by the
    /// utterance-length cap, or by an explicit stop, has NO trailing silence,
    /// so subtracting 1.4 s dates the last word 1.4 seconds before it was
    /// said, and the display settles onto a pause that never happened.
    ///
    /// The engine does not know sherpa's endpoint rules and must not: time
    /// enters here as explicit audio-clock milliseconds. `src-tauri/src/align`
    /// maps the recogniser's close reason — and its per-token timestamps,
    /// where it reports them — onto this field. `None` means "nothing was said
    /// about it", which is every frame in the frozen corpora, and falls back to
    /// the configured lag exactly as before.
    pub acoustic_end_ms: Option<f64>,
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
    /// See [`LedgerAtom::stopword`] — classified once, under the script's
    /// language, and carried from there.
    pub stopword: bool,
    /// Best-effort audio time of this word: the recogniser's own measurement
    /// where it had one and it fell later than the even spread across the item,
    /// and that spread otherwise. See [`Ledger::tail`].
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
            acoustic_end_ms: None,
            last_seen_audio_ms: audio_start_ms,
            revision_count: 0,
            retracted_atoms: 0,
        });
    }

    /// Apply a replacement partial (or the final restatement) for an item.
    /// Returns the number of atoms retracted by this revision.
    ///
    /// The words arrive already canonicalised AND already classified, because
    /// both are language decisions and the ledger has no language. It used to
    /// take raw text and reach for the global English normaliser, which worked
    /// only for as long as English was the only thing there was; see
    /// [`crate::script::CompiledScript::query_words`], which is the one place
    /// in the transcript path that knows what language is being spoken.
    pub fn revise_atoms(
        &mut self,
        interner: &mut Interner,
        item_id: &str,
        atoms: Vec<QueryWord>,
        is_final: bool,
        audio_ms: f64,
        acoustic_end_ms: Option<f64>,
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
            .map(|word| {
                let id = interner.intern(&word.surface);
                LedgerAtom {
                    phonetic: word.phonetic,
                    id,
                    surface: word.surface,
                    stability: 0,
                    filler: word.filler,
                    stopword: word.stopword,
                    measured_start_ms: word.measured_start_ms,
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
                // A word the recogniser is still revising can be re-dated, and
                // the LATER of the two readings is the one to keep. Not because
                // it is the more accurate — the first sighting is usually
                // closer to the sound — but because this number ends up as the
                // evidence clock the display extrapolates FROM, and a time that
                // moves earlier lengthens that extrapolation. A word already
                // credited to a moment is never taken back to before it.
                atom.measured_start_ms = match (item.atoms[i].measured_start_ms, atom.measured_start_ms) {
                    (Some(old), Some(new)) => Some(old.max(new)),
                    (Some(old), None) => Some(old),
                    (None, new) => new,
                };
            }
            merged.push(atom);
        }
        item.atoms = merged;
        item.is_final = is_final;
        item.revision_count += 1;
        item.retracted_atoms += retracted;
        item.last_seen_audio_ms = audio_ms;
        if is_final {
            item.audio_end_ms = Some(audio_ms);
            item.acoustic_end_ms = acoustic_end_ms;
        }
        retracted
    }

    /// The last `max_atoms` atoms across items, oldest first, with stability
    /// classes and audio times.
    ///
    /// The item timestamps are RECEIPT times, which lag the speech itself:
    /// a partial shows words spoken ~`partial_lag_ms` earlier, and a final
    /// arrives ~`endpoint_lag_ms` after the last word (server VAD waits for
    /// silence before committing). Correcting here — per timestamp kind —
    /// is what lets word times approximate actual speech time; a single
    /// downstream fudge factor cannot fix both at once.
    ///
    /// # Measured times, and why they may only ever move an atom later
    ///
    /// Spreading an item evenly over its own duration assumes every word took
    /// an equal share of it, which is not how anyone speaks: one rhetorical
    /// pause dates every word around it on the wrong side of the silence. Where
    /// the recogniser reported when it actually heard a word, that reading is
    /// available here as [`LedgerAtom::measured_start_ms`].
    ///
    /// It is applied as a floor rather than a replacement — `max(interpolated,
    /// measured)`, never `measured` alone. This number becomes the evidence
    /// clock the display works from, and an atom dated EARLIER lengthens the
    /// forward extrapolation off it. On a stage that dims what has been read,
    /// running ahead is the one failure that cannot be taken back, while
    /// running late merely trails. So a measurement is taken when it says a
    /// word was spoken later than the even spread believed, and declined when
    /// it says earlier.
    ///
    /// The running maximum is load-bearing too, not decoration — though not
    /// because a single revision arrives unsorted. `CompiledScript::dated_atoms`
    /// declines `word_times` that step backwards, and the source word it dates
    /// each atom from only ever climbs, so one revision's measurements are
    /// sorted by construction. Order is lost ACROSS revisions instead: the
    /// per-index merge in [`Ledger::revise_atoms`] keeps `old.max(new)` for
    /// every atom that survives, so atom i can hold an old LATE reading while
    /// atom i+1 accepts a new EARLIER one.
    ///
    /// # What this does NOT buy, stated plainly
    ///
    /// "Only ever later, therefore it cannot add lead" is TRUE of the linear
    /// term and FALSE of the display as a whole, and it would be comfortable to
    /// stop at the first half. [`crate::tracker::Snapshot::display_at`] eases
    /// its lead back to nothing as evidence goes stale, and it measures
    /// staleness as `now - evidence_ms`. Dating a word later makes the evidence
    /// look FRESHER, so that settle starts later: into a silence, the display
    /// can hold a lead a little longer than it used to.
    ///
    /// That is why the clamp is the item's own `end` rather than the raw
    /// receipt clock. It bounds the effect to the item's span instead of
    /// letting a whole `endpoint_lag_ms` of extra freshness in on top, and it
    /// keeps this change on the right side of a scope line: an even spread
    /// being wrong ABOUT THE INSIDE of an utterance is this issue; where the
    /// utterance ENDS is `endpoint_lag_ms`, which cannot be re-tuned until
    /// there is a corpus to measure it on. The residual is real, bounded, and
    /// UNMEASURED on live audio: every frozen fixture predates per-word timing
    /// and replays through the interpolation branch below, so no benchmark in
    /// the tree scores this. Do not read a green suite as evidence about it.
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
            /*
             * When this item stopped being spoken.
             *
             * A host-supplied acoustic end wins over the lag arithmetic. It is
             * either a measurement (the last token's own timestamp) or a
             * statement that there was no trailing silence to subtract (a
             * length-cap or explicit-stop close), and both beat a constant
             * that was inherited from a different recogniser and describes
             * only the silence-endpoint case.
             *
             * The fallback is unchanged, which is what keeps every frozen
             * fixture replaying identically: none of them carries an acoustic
             * end, so all of them take the `endpoint_lag_ms` branch exactly as
             * they always did.
             */
            let end = match (item.acoustic_end_ms, item.audio_end_ms) {
                (Some(acoustic), _) => acoustic,
                (None, Some(end)) => end - endpoint_lag_ms,
                (None, None) => item.last_seen_audio_ms - partial_lag_ms,
            }
            .max(start + 1.0);
            let mut resolved = f64::NEG_INFINITY;
            for (i, atom) in item.atoms.iter().enumerate() {
                let stability = classify(item, i);
                // Word i of n spans [i/n, (i+1)/n] of the item; use the end of
                // its span as "when it had been said".
                let interpolated = start + (end - start) * ((i + 1) as f64 / n as f64);
                // Only inside the item's OWN window, `end` included. A
                // measurement redistributes words within the stretch the lag
                // constants say this item occupies; it does not get to move the
                // far edge of that stretch, which is the `endpoint_lag_ms`
                // question — still waiting on the re-captured corpus that could
                // answer it, see `AlignmentConfig::endpoint_lag_ms`.
                //
                // DECLINED when it falls outside, not clamped into. Clamping
                // reads as the conservative choice and is the more dangerous
                // one: a final closed by the 20 s cap has no trailing silence,
                // so its last second of words all measure later than `end` and
                // would land on `end` EXACTLY — a plateau of identical
                // timestamps. The tail is retired by timestamp (`retain(audio_ms
                // >= horizon)`, with the horizon set one millisecond below an
                // accepted position's clock), and a plateau spans that cut: the
                // stale half of a retake survives it, and stable stale atoms
                // are exactly what outvotes the retake on the next revision and
                // snaps the reader forward. Declining leaves the atom on its
                // interpolated share, which is strictly increasing, so the cut
                // still has distinct values to bite on.
                //
                // That trades one source of plateaus for a shorter one rather
                // than removing them. The running maximum below lifts every
                // following atom whose interpolated share falls under an
                // accepted measurement onto that measurement —
                // `out_of_order_measurements_never_step_backwards` pins a
                // two-atom run at 3500. Length is the whole difference: a clamp
                // collapses however many words the cap cut short onto a single
                // value, while a run made this way is bounded above by the
                // item's own `end` and breaks at the first atom whose share
                // clears it. Crowding this fine is not new either — see
                // `an_untimed_item_is_dated_exactly_as_it_always_was`, where a
                // collapsed window already spaces atoms 0.167 ms apart.
                let measured = match atom.measured_start_ms {
                    // A non-finite clock is not a measurement. Checked rather
                    // than compared into, because a NaN start would otherwise
                    // make every comparison below quietly false.
                    Some(ms)
                        if ms.is_finite()
                            && start.is_finite()
                            && end.is_finite()
                            && ms >= start
                            && ms <= end =>
                    {
                        ms
                    }
                    _ => f64::NEG_INFINITY,
                };
                let audio_ms = interpolated.max(measured).max(resolved);
                resolved = audio_ms;
                out.push(QueryAtom {
                    id: atom.id,
                    surface: atom.surface.clone(),
                    phonetic: atom.phonetic,
                    stability,
                    filler: atom.filler,
                    stopword: atom.stopword,
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
    use crate::language::AlignmentLanguage;
    use crate::normalize::{canonical_atoms_for, is_filler_for, is_stopword_for, phonetic_key_for};

    /// The door the ledger no longer offers.
    ///
    /// Production hands it [`QueryWord`]s from the compiled script, which is
    /// what makes the language single-sourced. These tests are about stability
    /// and retraction rather than normalisation, so they canonicalise as
    /// English right here — explicitly, rather than by a default hidden inside
    /// the ledger.
    fn revise_text(
        ledger: &mut Ledger,
        interner: &mut Interner,
        item_id: &str,
        text: &str,
        is_final: bool,
        audio_ms: f64,
    ) -> u32 {
        let lang = AlignmentLanguage::English;
        let words: Vec<QueryWord> = canonical_atoms_for(lang, text)
            .into_iter()
            .map(|surface| QueryWord {
                filler: is_filler_for(lang, &surface),
                stopword: is_stopword_for(lang, &surface),
                phonetic: phonetic_key_for(lang, &surface),
                surface,
                measured_start_ms: None,
            })
            .collect();
        ledger.revise_atoms(interner, item_id, words, is_final, audio_ms, None)
    }

    fn ledger_with(texts: &[(&str, bool)]) -> (Ledger, Interner) {
        let mut ledger = Ledger::default();
        let mut interner = Interner::default();
        ledger.item_started("1-0", 0.0);
        for (i, (text, is_final)) in texts.iter().enumerate() {
            revise_text(&mut ledger, &mut interner, "1-0", text, *is_final, (i as f64 + 1.0) * 1000.0);
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
        revise_text(&mut ledger, &mut interner, "1-0", "we should build a very", false, 1000.0);
        let retracted = revise_text(&mut ledger, &mut interner, "1-0", "we should build a", false, 1500.0);
        assert_eq!(retracted, 1);
        revise_text(&mut ledger, &mut interner, "1-0", "we should build a complicated system", true, 2000.0);
        let tail = ledger.tail(40, 0.0, 0.0);
        assert!(tail.iter().all(|a| a.stability == StabilityClass::Final));
        assert_eq!(tail.len(), 6);
    }

    /// Times measured for each atom, in order. The ledger takes them attached
    /// to the words, so this is the shortest way to say "this item was heard
    /// at these moments" without going through a compiled script.
    fn revise_timed(
        ledger: &mut Ledger,
        interner: &mut Interner,
        item_id: &str,
        text: &str,
        is_final: bool,
        audio_ms: f64,
        times: &[Option<f64>],
    ) {
        let lang = AlignmentLanguage::English;
        let words: Vec<QueryWord> = canonical_atoms_for(lang, text)
            .into_iter()
            .enumerate()
            .map(|(i, surface)| QueryWord {
                filler: is_filler_for(lang, &surface),
                stopword: is_stopword_for(lang, &surface),
                phonetic: phonetic_key_for(lang, &surface),
                surface,
                measured_start_ms: times.get(i).copied().flatten(),
            })
            .collect();
        ledger.revise_atoms(interner, item_id, words, is_final, audio_ms, None);
    }

    /// The interpolated times, for comparison. Whatever a measurement does, it
    /// may not produce a number below the one on this line.
    fn interpolated(n: usize, start: f64, end: f64) -> Vec<f64> {
        (0..n)
            .map(|i| start + (end - start) * ((i + 1) as f64 / n as f64))
            .collect()
    }

    /// The whole point of the change: a pause inside an utterance.
    ///
    /// Five words over four seconds with a two-second silence in the middle.
    /// The even spread puts word 3 at 2400 ms — inside the silence, when
    /// nothing at all was being said. The measurement puts it where it was
    /// actually heard.
    #[test]
    fn a_measured_word_is_dated_where_it_was_heard_not_where_the_spread_guessed() {
        let mut ledger = Ledger::default();
        let mut interner = Interner::default();
        ledger.item_started("1-0", 0.0);
        revise_timed(
            &mut ledger,
            &mut interner,
            "1-0",
            "one two three four five",
            true,
            4_000.0,
            &[
                Some(200.0),
                Some(600.0),
                // Said AFTER the two-second silence, not during it.
                Some(3_000.0),
                Some(3_400.0),
                Some(3_800.0),
            ],
        );
        let tail = ledger.tail(40, 0.0, 0.0);
        let times: Vec<f64> = tail.iter().map(|a| a.audio_ms).collect();
        let spread = interpolated(5, 0.0, 4_000.0);

        // The word after the pause moves LATER than the spread believed —
        // 3000 rather than 2400 — which is the correction that matters.
        assert_eq!(times[2], 3_000.0);
        assert!(times[2] > spread[2]);
        // And nothing anywhere moved earlier.
        for (measured, even) in times.iter().zip(&spread) {
            assert!(
                measured >= even,
                "a measurement may not date an atom before the spread did: {measured} < {even}"
            );
        }
    }

    /// The safety property, stated directly. An earlier evidence time is a
    /// longer extrapolation, and a longer extrapolation is display lead.
    #[test]
    fn a_measurement_earlier_than_the_spread_is_declined() {
        let mut ledger = Ledger::default();
        let mut interner = Interner::default();
        ledger.item_started("1-0", 0.0);
        revise_timed(
            &mut ledger,
            &mut interner,
            "1-0",
            "one two three four",
            true,
            4_000.0,
            // Every word claimed at the very start of the item.
            &[Some(10.0), Some(20.0), Some(30.0), Some(40.0)],
        );
        let tail = ledger.tail(40, 0.0, 0.0);
        let times: Vec<f64> = tail.iter().map(|a| a.audio_ms).collect();
        assert_eq!(times, interpolated(4, 0.0, 4_000.0));
    }

    /// Measured times can reach the ledger unsorted, because the per-index
    /// merge in `revise_atoms` keeps `old.max(new)` per surviving atom: one
    /// atom can hold an old late reading while the next accepts a newer earlier
    /// one. The running maximum is what keeps the tail monotonic when that
    /// happens, at the price of a short plateau — which this test pins too, so
    /// the cost is on the record rather than assumed away.
    #[test]
    fn out_of_order_measurements_never_step_backwards() {
        let mut ledger = Ledger::default();
        let mut interner = Interner::default();
        ledger.item_started("1-0", 0.0);
        revise_timed(
            &mut ledger,
            &mut interner,
            "1-0",
            "one two three four",
            true,
            4_000.0,
            &[Some(3_500.0), Some(1_000.0), Some(3_600.0), Some(3_900.0)],
        );
        let tail = ledger.tail(40, 0.0, 0.0);
        let times: Vec<f64> = tail.iter().map(|a| a.audio_ms).collect();
        assert!(
            times.windows(2).all(|w| w[1] >= w[0]),
            "tail must be non-decreasing, got {times:?}"
        );
        // The late first word is kept, and the early second is lifted to it
        // rather than dragging the sequence back.
        assert_eq!(times[0], 3_500.0);
        assert_eq!(times[1], 3_500.0);
    }

    /// A measurement redistributes words INSIDE the window the lag constants
    /// give the item. It does not get to move the far edge of that window —
    /// that is the `endpoint_lag_ms` question, and it is still waiting on the
    /// corpus that could answer it.
    ///
    /// This bound is also what keeps the change bounded: a later clock makes
    /// evidence look FRESHER, which delays the display's settle onto a pause,
    /// so letting a measurement run past the corrected end would add up to a
    /// whole `endpoint_lag_ms` of held-open lead on top of the item's own span.
    #[test]
    fn a_measurement_outside_the_window_is_declined_not_clamped() {
        let mut ledger = Ledger::default();
        let mut interner = Interner::default();
        ledger.item_started("1-0", 0.0);
        revise_timed(
            &mut ledger,
            &mut interner,
            "1-0",
            "one two",
            true,
            5_000.0,
            // Both claim times past the corrected end; the second past the
            // receipt clock entirely.
            &[Some(4_200.0), Some(9_999.0)],
        );
        // A 1400 ms endpoint correction puts the interpolated end at 3600.
        let tail = ledger.tail(40, 0.0, 1_400.0);
        let times: Vec<f64> = tail.iter().map(|a| a.audio_ms).collect();
        assert_eq!(times, interpolated(2, 0.0, 3_600.0));
    }

    /// The reason the branch above declines rather than clamps.
    ///
    /// A final closed by the 20 s cap has no trailing silence, so its last
    /// second of words all measure later than the lag-corrected end. Clamped,
    /// every one of them would land on that end EXACTLY — and the tail is
    /// retired by timestamp, so a plateau of identical clocks spans the cut
    /// that is supposed to drop the stale half of a retake.
    #[test]
    fn a_run_of_late_measurements_does_not_collapse_onto_one_timestamp() {
        let mut ledger = Ledger::default();
        let mut interner = Interner::default();
        ledger.item_started("1-0", 0.0);
        revise_timed(
            &mut ledger,
            &mut interner,
            "1-0",
            "one two three four five",
            true,
            20_000.0,
            // Everything heard in the last stretch, past the corrected end.
            &[
                Some(19_000.0),
                Some(19_200.0),
                Some(19_400.0),
                Some(19_600.0),
                Some(19_800.0),
            ],
        );
        let tail = ledger.tail(40, 0.0, 1_400.0);
        let times: Vec<f64> = tail.iter().map(|a| a.audio_ms).collect();
        assert!(
            times.windows(2).all(|w| w[1] > w[0]),
            "timestamps must stay distinct for the horizon to cut on: {times:?}"
        );
    }

    /// A non-finite clock is not a measurement. It must be ignored rather than
    /// propagated — and `f64::clamp` panics on non-finite bounds, so the item
    /// start has to be checked too.
    #[test]
    fn non_finite_clocks_are_ignored_rather_than_propagated() {
        for start in [0.0, f64::NAN] {
            let mut ledger = Ledger::default();
            let mut interner = Interner::default();
            ledger.item_started("1-0", start);
            revise_timed(
                &mut ledger, &mut interner, "1-0", "one two three", true, 3_000.0,
                &[Some(f64::NAN), Some(f64::INFINITY), Some(1_000.0)],
            );
            let tail = ledger.tail(40, 0.0, 0.0);
            assert_eq!(tail.len(), 3, "a bad clock must not drop an atom");
            if start.is_finite() {
                let spread = interpolated(3, 0.0, 3_000.0);
                // The two unusable clocks fall back; the real one is declined
                // for being earlier than its own share of the spread.
                assert_eq!(tail[0].audio_ms, spread[0]);
                assert_eq!(tail[1].audio_ms, spread[1]);
                assert_eq!(tail[2].audio_ms, spread[2]);
            } else {
                // A NaN item start is already beyond saving — the interpolation
                // it feeds is NaN too, and always was. What matters is that
                // reading a measurement past it no longer PANICS, which
                // `f64::clamp` did on non-finite bounds. What comes out stays
                // unusable, and the tail retention downstream drops it on the
                // same comparison that dropped the NaN before.
                assert!(tail.iter().all(|a| !a.audio_ms.is_finite()));
                assert!(!tail.iter().any(|a| a.audio_ms >= 0.0));
            }
        }
    }

    /// Two items, both timed. The running maximum is per item, so item 2 is
    /// free to start where it actually started rather than being dragged by
    /// item 1 — but neither item may hand back a time before its own spread.
    #[test]
    fn timing_survives_across_items() {
        let mut ledger = Ledger::default();
        let mut interner = Interner::default();
        ledger.item_started("1-0", 0.0);
        revise_timed(
            &mut ledger, &mut interner, "1-0", "one two three", true, 3_000.0,
            &[Some(400.0), Some(2_400.0), Some(2_800.0)],
        );
        ledger.item_started("1-1", 4_000.0);
        revise_timed(
            &mut ledger, &mut interner, "1-1", "four five six", true, 7_000.0,
            &[Some(4_400.0), Some(6_400.0), Some(6_800.0)],
        );
        let tail = ledger.tail(40, 0.0, 0.0);
        let times: Vec<f64> = tail.iter().map(|a| a.audio_ms).collect();
        assert!(
            times.windows(2).all(|w| w[1] >= w[0]),
            "tail must stay ordered across items, got {times:?}"
        );
        // The pause inside item 1 is honoured: word 2 sits at its measured
        // 2400, not at the 2000 the even spread assumed.
        assert_eq!(times[1], 2_400.0);
        assert_eq!(tail[3].item_index, 1);
        assert_eq!(times[4], 6_400.0);
    }

    /// One atom without a time among atoms that have one. It falls back to its
    /// own interpolated value, and is lifted only if that would step backwards.
    #[test]
    fn an_untimed_atom_falls_back_on_its_own() {
        let mut ledger = Ledger::default();
        let mut interner = Interner::default();
        ledger.item_started("1-0", 0.0);
        revise_timed(
            &mut ledger,
            &mut interner,
            "1-0",
            "one two three four",
            true,
            4_000.0,
            &[Some(1_500.0), None, Some(3_500.0), None],
        );
        let tail = ledger.tail(40, 0.0, 0.0);
        let times: Vec<f64> = tail.iter().map(|a| a.audio_ms).collect();
        let spread = interpolated(4, 0.0, 4_000.0);
        assert_eq!(times[0], 1_500.0);
        // Its own spread value (2000) survives — it is later than 1500.
        assert_eq!(times[1], spread[1]);
        assert_eq!(times[2], 3_500.0);
        // Its spread value (4000) is later than the atom before it, so it stands.
        assert_eq!(times[3], spread[3]);
        assert!(times.windows(2).all(|w| w[1] >= w[0]));
    }

    /// A word re-reported by a later partial keeps the LATER of the two
    /// readings. The first sighting is usually the truer one, but this number
    /// is the clock the display extrapolates from, and letting it move earlier
    /// lengthens that extrapolation after the fact.
    #[test]
    fn a_re_dated_word_never_moves_earlier() {
        let mut ledger = Ledger::default();
        let mut interner = Interner::default();
        ledger.item_started("1-0", 0.0);
        revise_timed(
            &mut ledger, &mut interner, "1-0", "one two", false, 1_000.0,
            &[Some(900.0), Some(950.0)],
        );
        revise_timed(
            &mut ledger, &mut interner, "1-0", "one two three", false, 2_000.0,
            // The recogniser revises the first word EARLIER, and is refused.
            &[Some(100.0), Some(1_200.0), Some(1_800.0)],
        );
        let item = ledger.current_item().expect("item");
        assert_eq!(item.atoms[0].measured_start_ms, Some(900.0));
        // A later reading of the second word is taken.
        assert_eq!(item.atoms[1].measured_start_ms, Some(1_200.0));
    }

    /// A revision that reports no timing at all must not erase what the
    /// surviving prefix already established.
    #[test]
    fn an_untimed_revision_does_not_erase_a_surviving_prefix() {
        let mut ledger = Ledger::default();
        let mut interner = Interner::default();
        ledger.item_started("1-0", 0.0);
        revise_timed(
            &mut ledger, &mut interner, "1-0", "one two", false, 1_000.0,
            &[Some(900.0), Some(950.0)],
        );
        revise_text(&mut ledger, &mut interner, "1-0", "one two three", false, 2_000.0);
        let item = ledger.current_item().expect("item");
        assert_eq!(item.atoms[0].measured_start_ms, Some(900.0));
        assert_eq!(item.atoms[1].measured_start_ms, Some(950.0));
        assert_eq!(item.atoms[2].measured_start_ms, None);
    }

    /// A retracted suffix is new evidence, not surviving evidence — it must not
    /// inherit the clock of the word it replaced.
    #[test]
    fn a_retracted_suffix_does_not_inherit_the_old_time() {
        let mut ledger = Ledger::default();
        let mut interner = Interner::default();
        ledger.item_started("1-0", 0.0);
        revise_timed(
            &mut ledger, &mut interner, "1-0", "one two", false, 1_000.0,
            &[Some(900.0), Some(950.0)],
        );
        revise_timed(
            &mut ledger, &mut interner, "1-0", "one banana", false, 2_000.0,
            &[Some(900.0), None],
        );
        let item = ledger.current_item().expect("item");
        assert_eq!(item.atoms[1].surface, "banana");
        assert_eq!(item.atoms[1].measured_start_ms, None);
    }

    /// Nothing about an untimed item may have changed. This is the path every
    /// frozen benchmark fixture still takes.
    #[test]
    fn an_untimed_item_is_dated_exactly_as_it_always_was() {
        let (ledger, _) = ledger_with(&[("hello world this is a test", true)]);
        let tail = ledger.tail(40, 400.0, 1_400.0);
        let times: Vec<f64> = tail.iter().map(|a| a.audio_ms).collect();
        // Item start 0, final at 1000, endpoint correction 1400 → the window
        // collapses and the `start + 1.0` floor applies, exactly as before.
        assert_eq!(times, interpolated(6, 0.0, 1.0));
    }

    #[test]
    fn tail_spans_items_and_caps() {
        let mut ledger = Ledger::default();
        let mut interner = Interner::default();
        ledger.item_started("1-0", 0.0);
        revise_text(&mut ledger, &mut interner, "1-0", "one two three", true, 1000.0);
        ledger.item_started("1-1", 1200.0);
        revise_text(&mut ledger, &mut interner, "1-1", "four five six", false, 2000.0);
        let tail = ledger.tail(4, 0.0, 0.0);
        let surfaces: Vec<&str> = tail.iter().map(|a| a.surface.as_str()).collect();
        assert_eq!(surfaces, vec!["3", "4", "5", "6"]);
        assert_eq!(tail[0].item_index, 0);
        assert_eq!(tail[1].item_index, 1);
    }
}

#[cfg(test)]
mod acoustic_end_tests {
    use super::*;

    fn interner() -> Interner {
        Interner::default()
    }

    fn word(surface: &str) -> QueryWord {
        QueryWord {
            surface: surface.to_string(),
            phonetic: crate::normalize::phonetic_key(surface),
            filler: false,
            stopword: false,
            measured_start_ms: None,
        }
    }

    /// Three atoms in one item, closed at `audio_end_ms`, with the host's
    /// answer for when speaking actually stopped.
    fn tail_of(acoustic_end_ms: Option<f64>) -> Vec<f64> {
        let mut ledger = Ledger::default();
        let mut interner = interner();
        ledger.item_started("i1", 1_000.0);
        ledger.revise_atoms(
            &mut interner,
            "i1",
            vec![word("alpha"), word("bravo"), word("charlie")],
            true,
            5_000.0,
            acoustic_end_ms,
        );
        ledger
            .tail(16, 300.0, 1_400.0)
            .into_iter()
            .map(|atom| atom.audio_ms)
            .collect()
    }

    /// The behaviour every frozen corpus depends on. None of them carries an
    /// acoustic end, so all of them must take the `endpoint_lag_ms` branch
    /// exactly as they did before the field existed — otherwise every recorded
    /// baseline in `bench/` silently stops describing the code.
    #[test]
    fn without_an_acoustic_end_the_configured_lag_still_applies() {
        let times = tail_of(None);
        // The item spans 1000 → (5000 - 1400); the last atom sits at the end.
        assert_eq!(times.last().copied(), Some(3_600.0));
    }

    /// The correctness fix. A final closed by the utterance-length cap or by an
    /// explicit stop has NO trailing silence, so the host reports the receipt
    /// time as the acoustic end — and subtracting 1.4 s from it, as the engine
    /// used to do unconditionally, dated the last word 1.4 seconds before it
    /// was said.
    #[test]
    fn an_acoustic_end_overrides_the_lag_entirely() {
        let times = tail_of(Some(5_000.0));
        assert_eq!(
            times.last().copied(),
            Some(5_000.0),
            "a host-supplied end must not have a lag subtracted from it as well"
        );
    }

    /// Anti-vacuity: the two branches must actually differ. If the override
    /// were dropped, both tests above would agree and neither would fail.
    #[test]
    fn the_two_branches_disagree_by_the_whole_endpoint_lag() {
        let with_lag = tail_of(None).last().copied().expect("atoms");
        let measured = tail_of(Some(5_000.0)).last().copied().expect("atoms");
        assert!(
            (measured - with_lag - 1_400.0).abs() < 1.0,
            "the difference is the whole endpoint lag: {measured} vs {with_lag}"
        );
    }
}
