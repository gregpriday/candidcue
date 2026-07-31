//! Three gold timelines, not one.
//!
//! The existing evaluator asks one question — "where is the reader?" — and
//! answers it with `GoldTimeline::position_at`. That is the right reference for
//! exactly one of the things this system does, and the wrong one for most of
//! them, because CandidCue has at least three separate notions of position and
//! they diverge in normal use:
//!
//! * **the spoken frontier** `g_s(t)` — the last word finished acoustically.
//!   The only honest reference for *may this word be dark yet*. A word that has
//!   not been said may not be faded, full stop.
//! * **the visual reading focus** `g_f(t)` — the token the eyes are on, which
//!   LEADS the mouth. The right reference for *where should this line sit*.
//!   Scoring line placement against the mouth builds in a systematic
//!   eye-voice-lead worth of error and then calls it correct.
//! * **the narrative location within a pass** `g_p(t)` — where the reader is in
//!   the take they are currently performing. Retakes make the gold trajectory
//!   non-monotonic, and a word spoken two minutes ago in pass 0 still has to be
//!   BRIGHT if the reader is re-reading it in pass 1.
//!
//! That last one is why the global high-water mark in `metrics.rs` cannot be
//! the whole answer. It correctly refuses to let the display fade text that was
//! never spoken — and it is structurally blind to a retake left illegible,
//! because on the high-water reference that text is spoken and fading it is
//! free. Both references are needed and they measure different failures:
//!
//! | reference | catches |
//! |---|---|
//! | ever-spoken frontier | erasing text the reader has never read |
//! | current-pass frontier | failing to bring back text they must read again |
//!
//! Nothing here touches the recogniser or the engine. A `PassGold` is a pure
//! function of a `GoldTimeline`, so it can be derived for any fixture already
//! in `bench/runs*/` without recapturing anything.

use serde::{Deserialize, Serialize};

use crate::plan::{GoldTimeline, GoldWord};

/// A backward gold move at least this large starts a new reading pass.
///
/// Well under the 10-atom `GOLD_JUMP_ATOMS` the display-side metrics use,
/// because a pass boundary is a fact about the PERFORMANCE and a display jump
/// threshold is a judgement about the display. A reader who backs up four words
/// to re-take a clause has genuinely started reading those words again, and the
/// text has to be legible for them whether or not the engine chose to relocate.
const PASS_BACKSTEP_ATOMS: f64 = 3.0;

/// Off-script words in a row before the return counts as an ad-lib return
/// rather than a stumble. Matches `metrics.rs`.
const ADLIB_RUN: usize = 4;

/// Silence classes, in ms. A pause is not one thing: the display's obligations
/// during a 300 ms breath and a 6 s dramatic hold are different, and pooling
/// them reports one number about two behaviours.
const BREATH_MAX_MS: f64 = 700.0;
const SENTENCE_MAX_MS: f64 = 3_000.0;
const PARAGRAPH_MAX_MS: f64 = 10_000.0;

/// Default eye-voice lead, in atoms.
///
/// Readers look ahead of what they are saying; how far depends on the person,
/// the pace, and how hard the text is. Two words is the conservative end of the
/// published range for oral reading, and conservative is the right end here: an
/// over-estimated lead would ask the stage to place text further ahead than the
/// presenter is actually looking, which is the direction that hurts.
///
/// This is a MODEL, not a measurement, and every metric derived from it is
/// labelled `focus_*` so it is never mistaken for one. Tier D (real glass, real
/// gaze tracking) is what turns it into a measurement; see `bench/README.md`.
pub const DEFAULT_EYE_VOICE_LEAD_ATOMS: f64 = 2.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EventKind {
    /// Reading the script, in order, as written.
    OnScript,
    /// Silence.
    Silence,
    /// Off-script speech (ad-lib, aside, false start).
    OffScript,
    /// First on-script word after ≥ ADLIB_RUN off-script words.
    AdlibReturn,
    /// A forward gold discontinuity.
    SkipForward,
    /// A backward gold discontinuity — the reader is re-reading.
    Retake,
    /// The reader said different words for a script span (paraphrase, misspeak,
    /// or a re-spelling of the same sound).
    Substitution,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PauseClass {
    Breath,
    Sentence,
    Paragraph,
    Long,
}

impl PauseClass {
    fn of(ms: f64) -> Self {
        if ms <= BREATH_MAX_MS {
            PauseClass::Breath
        } else if ms <= SENTENCE_MAX_MS {
            PauseClass::Sentence
        } else if ms <= PARAGRAPH_MAX_MS {
            PauseClass::Paragraph
        } else {
            PauseClass::Long
        }
    }
}

/// One gold word, annotated with everything the perceptual metrics need.
#[derive(Debug, Clone)]
pub struct PassWord {
    pub start_ms: f64,
    /// Acoustic END of the word. This — not the recogniser's arrival time — is
    /// what every latency in this file is measured from. A recogniser that
    /// takes 400 ms to admit a word was said does not make the word later.
    pub end_ms: f64,
    pub pass: u32,
    /// Atom interval this word carries the reader across; None when off-script.
    pub span: Option<(f64, f64)>,
    pub kind: EventKind,
    pub respelled: bool,
}

/// A silent interval between spoken words, with its class.
#[derive(Debug, Clone, Copy)]
pub struct Silence {
    pub from_ms: f64,
    pub to_ms: f64,
    pub class: PauseClass,
    /// Gold position held through this silence.
    pub hold: f64,
    /// Frontier of the active pass entering the silence.
    pub frontier: f64,
}

/// A gold discontinuity worth measuring recovery from.
#[derive(Debug, Clone, Copy)]
pub struct Discontinuity {
    pub kind: EventKind,
    pub at_ms: f64,
    /// Where the reader went.
    pub to: f64,
    /// Where they were.
    pub from: f64,
    pub pass: u32,
}

/// The pass-aware view of a gold timeline.
#[derive(Debug, Clone)]
pub struct PassGold {
    pub words: Vec<PassWord>,
    pub silences: Vec<Silence>,
    pub discontinuities: Vec<Discontinuity>,
    pub total_ms: f64,
    /// Per pass, the (position, time) samples of the reader passing through the
    /// script — the raw material for `tau`.
    passes: Vec<Vec<(f64, f64)>>,
    /// Sorted word-end times with their spans, for frontier queries.
    frontier_marks: Vec<(f64, f64, u32)>,
    /// Global high-water frontier samples: (t, furthest ever completed).
    ever: Vec<(f64, f64)>,
    eye_voice_lead: f64,
}

impl PassGold {
    pub fn derive(gold: &GoldTimeline) -> Self {
        Self::derive_with_lead(gold, DEFAULT_EYE_VOICE_LEAD_ATOMS)
    }

    pub fn derive_with_lead(gold: &GoldTimeline, eye_voice_lead: f64) -> Self {
        let mut words: Vec<PassWord> = Vec::with_capacity(gold.words.len());
        let mut discontinuities = Vec::new();
        let mut pass = 0u32;
        let mut last_end: Option<f64> = None;
        let mut off_run = 0usize;
        let mut first_script = false;

        for w in &gold.words {
            let span = w.gold.span();
            let kind = match span {
                None => {
                    off_run += 1;
                    EventKind::OffScript
                }
                Some((start, _end)) => {
                    let mut kind = if w.respelled {
                        EventKind::Substitution
                    } else {
                        EventKind::OnScript
                    };
                    if !first_script {
                        first_script = true;
                    } else if let Some(prev) = last_end {
                        let delta = start - prev;
                        if delta <= -PASS_BACKSTEP_ATOMS {
                            // A retake opens a new pass: the words ahead of
                            // here are unread AGAIN, whatever they were before.
                            pass += 1;
                            kind = EventKind::Retake;
                            discontinuities.push(Discontinuity {
                                kind: EventKind::Retake,
                                at_ms: w.start_ms,
                                to: start,
                                from: prev,
                                pass,
                            });
                        } else if delta >= crate::passgold::SKIP_FORWARD_ATOMS {
                            kind = EventKind::SkipForward;
                            discontinuities.push(Discontinuity {
                                kind: EventKind::SkipForward,
                                at_ms: w.start_ms,
                                to: start,
                                from: prev,
                                pass,
                            });
                        } else if off_run >= ADLIB_RUN {
                            kind = EventKind::AdlibReturn;
                            discontinuities.push(Discontinuity {
                                kind: EventKind::AdlibReturn,
                                at_ms: w.start_ms,
                                to: start,
                                from: prev,
                                pass,
                            });
                        }
                    }
                    off_run = 0;
                    kind
                }
            };
            if let Some((_, end)) = span {
                last_end = Some(end);
            }
            words.push(PassWord {
                start_ms: w.start_ms,
                end_ms: w.end_ms,
                pass,
                span,
                kind,
                respelled: w.respelled,
            });
        }

        // ---- per-pass trajectory samples, for the inverse map ----
        let pass_count = words.iter().map(|w| w.pass).max().unwrap_or(0) as usize + 1;
        let mut passes: Vec<Vec<(f64, f64)>> = vec![Vec::new(); pass_count];
        for w in &words {
            if let Some((lo, hi)) = w.span {
                let samples = &mut passes[w.pass as usize];
                // Both ends of the span: a re-spelled run puts several words on
                // one atom range and several atom ranges on one word, and only
                // recording ends would make τ piecewise-constant across exactly
                // the passages where timing matters most.
                samples.push((lo, w.start_ms));
                samples.push((hi, w.end_ms));
            }
        }
        for samples in passes.iter_mut() {
            samples.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        }

        // ---- frontier marks and the global high-water series ----
        let mut frontier_marks: Vec<(f64, f64, u32)> = words
            .iter()
            .filter_map(|w| w.span.map(|(_, hi)| (w.end_ms, hi, w.pass)))
            .collect();
        frontier_marks
            .sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        let mut ever: Vec<(f64, f64)> = Vec::with_capacity(frontier_marks.len());
        let mut hw = f64::NEG_INFINITY;
        for &(t, pos, _) in &frontier_marks {
            hw = hw.max(pos);
            ever.push((t, hw));
        }

        // ---- silences ----
        let mut silences = Vec::new();
        let mut prev: Option<&PassWord> = None;
        for w in &words {
            if let Some(p) = prev {
                let gap = w.start_ms - p.end_ms;
                if gap > 1.0 {
                    silences.push(Silence {
                        from_ms: p.end_ms,
                        to_ms: w.start_ms,
                        class: PauseClass::of(gap),
                        hold: p.span.map(|(_, hi)| hi).unwrap_or(0.0),
                        frontier: p.span.map(|(_, hi)| hi).unwrap_or(0.0),
                    });
                }
            }
            prev = Some(w);
        }

        Self {
            words,
            silences,
            discontinuities,
            total_ms: gold.total_ms,
            passes,
            frontier_marks,
            ever,
            eye_voice_lead,
        }
    }

    /// Which pass is active at `t`.
    pub fn pass_at(&self, t: f64) -> u32 {
        let mut pass = 0;
        for w in &self.words {
            if w.start_ms > t {
                break;
            }
            pass = w.pass;
        }
        pass
    }

    /// `g_s(t)`: the furthest atom completed acoustically **in the active
    /// pass**. This is the fade frontier's licence: at or behind this, dark is
    /// correct; ahead of it, dark is erasure.
    pub fn spoken_frontier(&self, t: f64) -> f64 {
        let pass = self.pass_at(t);
        let mut frontier = f64::NEG_INFINITY;
        for &(end, pos, wp) in &self.frontier_marks {
            if end > t {
                break;
            }
            if wp == pass {
                frontier = frontier.max(pos);
            }
        }
        if frontier.is_finite() {
            frontier
        } else {
            // Early in a fresh pass nothing has been completed yet. The pass
            // STARTED somewhere, and that start is the honest frontier: the
            // reader is at it, not at atom zero.
            self.words
                .iter()
                .find(|w| w.pass == pass && w.span.is_some())
                .and_then(|w| w.span.map(|(lo, _)| lo))
                .unwrap_or(0.0)
        }
    }

    /// `g_e(t)`: the global high-water mark across every pass. Safety
    /// reference — text past this has never been spoken at all.
    pub fn ever_spoken_frontier(&self, t: f64) -> f64 {
        let mut hw = f64::NEG_INFINITY;
        for &(mark_t, pos) in &self.ever {
            if mark_t > t {
                break;
            }
            hw = pos;
        }
        if hw.is_finite() {
            hw
        } else {
            0.0
        }
    }

    /// `g_f(t)`: modelled visual reading focus — the spoken frontier plus the
    /// eye-voice lead, clamped into the pass's own material.
    pub fn focus(&self, t: f64) -> f64 {
        self.spoken_frontier(t) + self.eye_voice_lead
    }

    pub fn eye_voice_lead(&self) -> f64 {
        self.eye_voice_lead
    }

    /// `τ_p(z)`: the acoustic time at which the reader passed script position
    /// `z` during pass `p`, by linear interpolation between recorded samples.
    ///
    /// This is what converts a distance error into a TIME error, and it is the
    /// reason temporal metrics are speaking-rate invariant: a two-word lag at
    /// 80 wpm and a two-word lag at 220 wpm are not the same experience, and
    /// every atom-denominated row in the old table calls them identical.
    ///
    /// `None` when `z` is outside the range the pass actually covered — asking
    /// when the reader passed a word they never reached has no answer, and
    /// extrapolating one would invent lag out of nothing.
    pub fn tau(&self, pass: u32, z: f64) -> Option<f64> {
        let samples = self.passes.get(pass as usize)?;
        if samples.len() < 2 {
            return None;
        }
        let (first, last) = (samples[0], samples[samples.len() - 1]);
        if z < first.0 || z > last.0 {
            return None;
        }
        // Monotone in position by construction, so a binary search is valid.
        let idx = samples.partition_point(|&(p, _)| p <= z);
        if idx == 0 {
            return Some(first.1);
        }
        if idx >= samples.len() {
            return Some(last.1);
        }
        let (p0, t0) = samples[idx - 1];
        let (p1, t1) = samples[idx];
        if (p1 - p0).abs() < 1e-9 {
            return Some(t1.max(t0));
        }
        Some(t0 + (t1 - t0) * (z - p0) / (p1 - p0))
    }

    /// The atom span `[lo, hi]` pass `p` covers — exactly the range `tau` can
    /// answer for.
    ///
    /// A forward-looking metric has to know where the material it is walking
    /// runs out, and "the pass ended" is not the same complaint as "the display
    /// hid it". Without this the two are indistinguishable, and every take's
    /// last seconds score as a failure for the crime of being the last seconds.
    pub fn pass_span(&self, pass: u32) -> Option<(f64, f64)> {
        let samples = self.passes.get(pass as usize)?;
        match (samples.first(), samples.last()) {
            (Some(&(lo, _)), Some(&(hi, _))) if hi > lo => Some((lo, hi)),
            _ => None,
        }
    }

    /// Is a word being spoken at `t`?
    pub fn speaking(&self, t: f64) -> bool {
        self.words
            .iter()
            .any(|w| t >= w.start_ms && t <= w.end_ms)
    }

    /// Is the reader on-script at `t` (a script word in the mouth, or the
    /// silence after one)?
    pub fn on_script(&self, t: f64) -> bool {
        let mut on = false;
        for w in &self.words {
            if w.start_ms > t {
                break;
            }
            on = w.span.is_some();
        }
        on
    }

    /// The event kind in force at `t`.
    pub fn kind_at(&self, t: f64) -> EventKind {
        let mut kind = EventKind::Silence;
        for w in &self.words {
            if w.start_ms > t {
                break;
            }
            kind = if t <= w.end_ms { w.kind } else { EventKind::Silence };
        }
        kind
    }

    /// The silence containing `t`, if any.
    pub fn silence_at(&self, t: f64) -> Option<&Silence> {
        self.silences
            .iter()
            .find(|s| t >= s.from_ms && t < s.to_ms)
    }

    /// Words whose acoustic end lies in `[from, to)`, in order — the unit every
    /// per-word latency metric iterates.
    pub fn words_ending_in(&self, from: f64, to: f64) -> impl Iterator<Item = &PassWord> {
        self.words
            .iter()
            .filter(move |w| w.span.is_some() && w.end_ms >= from && w.end_ms < to)
    }

    /// Total on-script speaking time (ms) — the denominator for rate metrics.
    pub fn speaking_ms(&self) -> f64 {
        self.words
            .iter()
            .filter(|w| w.span.is_some())
            .map(|w| (w.end_ms - w.start_ms).max(0.0))
            .sum()
    }
}

/// A forward gold move at least this large is a skip, not ordinary reading.
/// Matches `metrics::GOLD_JUMP_ATOMS`; kept separate so the pass logic reads
/// without cross-module constants in the middle of an expression.
pub const SKIP_FORWARD_ATOMS: f64 = 10.0;

/// Reconstruct a `GoldTimeline` view over `PassGold`, for the places that still
/// want the old single-reference answer.
pub fn as_gold_words(pass: &PassGold) -> Vec<GoldWord> {
    pass.words
        .iter()
        .map(|w| GoldWord {
            start_ms: w.start_ms,
            end_ms: w.end_ms,
            text: String::new(),
            gold: match w.span {
                Some((lo, hi)) => crate::plan::GoldTag::Script {
                    pos_after: hi.ceil() as u32,
                    span: Some((lo, hi)),
                },
                None => crate::plan::GoldTag::Off { hold: 0 },
            },
            respelled: w.respelled,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::{expand, synthetic_timing, Corruption, PerformancePlan, PlanOp};
    use cc_align::{compile, CompileOptions};

    fn gold_for(ops: Vec<PlanOp>, atoms: &str) -> GoldTimeline {
        let script = compile(atoms, CompileOptions::default());
        let plan = PerformancePlan {
            name: "t".into(),
            script: "t".into(),
            scenario: "exact".into(),
            seed: 1,
            ops,
            corruption: Corruption::default(),
        };
        synthetic_timing(&expand(&plan, &script), 150)
    }

    const WORDS: &str = "alpha bravo charlie delta echo foxtrot golf hotel india juliet \
                         kilo lima mike november oscar papa quebec romeo sierra tango";

    #[test]
    fn a_retake_opens_a_new_pass() {
        let gold = gold_for(
            vec![
                PlanOp::Read { from: 0, to: 12 },
                PlanOp::Read { from: 6, to: 20 },
            ],
            WORDS,
        );
        let pg = PassGold::derive(&gold);
        assert_eq!(pg.words[0].pass, 0);
        assert_eq!(pg.words[11].pass, 0);
        assert_eq!(pg.words[12].pass, 1, "the backward move starts pass 1");
        assert_eq!(
            pg.discontinuities
                .iter()
                .filter(|d| d.kind == EventKind::Retake)
                .count(),
            1
        );
    }

    #[test]
    fn current_pass_frontier_rewinds_but_ever_spoken_does_not() {
        let gold = gold_for(
            vec![
                PlanOp::Read { from: 0, to: 12 },
                PlanOp::Read { from: 6, to: 20 },
            ],
            WORDS,
        );
        let pg = PassGold::derive(&gold);
        // Just after the retake's first word.
        let t = pg.words[12].end_ms + 1.0;
        assert!(
            pg.spoken_frontier(t) < 9.0,
            "the current pass has only reached atom 7, got {}",
            pg.spoken_frontier(t)
        );
        assert!(
            pg.ever_spoken_frontier(t) >= 12.0,
            "twelve atoms have been spoken at some point, got {}",
            pg.ever_spoken_frontier(t)
        );
    }

    #[test]
    fn tau_inverts_the_reading_trajectory() {
        let gold = gold_for(vec![PlanOp::Read { from: 0, to: 20 }], WORDS);
        let pg = PassGold::derive(&gold);
        // The reader passed atom 10 when word 10 ended.
        let expected = pg.words[9].end_ms;
        let got = pg.tau(0, 10.0).expect("inside the pass");
        assert!(
            (got - expected).abs() < 1.0,
            "tau(10) = {got}, word 10 ended at {expected}"
        );
    }

    #[test]
    fn tau_refuses_positions_the_pass_never_reached() {
        let gold = gold_for(vec![PlanOp::Read { from: 0, to: 10 }], WORDS);
        let pg = PassGold::derive(&gold);
        assert!(pg.tau(0, 18.0).is_none());
    }

    #[test]
    fn pass_span_is_the_range_tau_can_answer_for() {
        let gold = gold_for(
            vec![
                PlanOp::Read { from: 0, to: 12 },
                PlanOp::Read { from: 6, to: 20 },
            ],
            WORDS,
        );
        let pg = PassGold::derive(&gold);
        let (lo0, hi0) = pg.pass_span(0).expect("pass 0 was read");
        let (lo1, hi1) = pg.pass_span(1).expect("the retake opened pass 1");
        assert!(pg.tau(0, hi0).is_some() && pg.tau(0, hi0 + 1.0).is_none());
        assert!(pg.tau(1, lo1).is_some());
        assert!(lo1 < hi0, "the retake starts behind where pass 0 ended");
        assert!(hi1 > hi0, "and carries on past it");
        assert!(lo0 <= lo1);
        assert!(pg.pass_span(7).is_none(), "no such pass");
    }

    #[test]
    fn silences_are_classified() {
        let gold = gold_for(
            vec![
                PlanOp::Read { from: 0, to: 4 },
                PlanOp::Pause { ms: 400 },
                PlanOp::Read { from: 4, to: 8 },
                PlanOp::Pause { ms: 5_000 },
                PlanOp::Read { from: 8, to: 12 },
            ],
            WORDS,
        );
        let pg = PassGold::derive(&gold);
        let classes: Vec<_> = pg.silences.iter().map(|s| s.class).collect();
        assert!(classes.contains(&PauseClass::Breath), "{classes:?}");
        assert!(classes.contains(&PauseClass::Paragraph), "{classes:?}");
    }
}
