//! PerformancePlan: a declarative description of what the presenter actually
//! says, built BEFORE any audio exists, preserving an exact mapping back to
//! script atoms. Everything downstream — TTS rendering, synthetic transcript
//! generation, and the gold timeline the metrics compare against — derives
//! from the same plan, which is what makes the gold standard independent of
//! the recogniser under test.

use serde::{Deserialize, Serialize};

use cc_align::script::CompiledScript;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum PlanOp {
    /// Read script atoms `[from, to)` as written. Skips, retakes and repeats
    /// are just Read ranges that jump around.
    Read { from: u32, to: u32 },
    /// Read `[from, to)` but say `say` instead (substitution / paraphrase /
    /// misspeak). Gold position still advances through the range.
    Substitute {
        from: u32,
        to: u32,
        say: Vec<String>,
        /// Is this a re-SPELLING (same sound, different notation) rather than
        /// a paraphrase?
        ///
        /// Only re-spellings belong in the `forms.span_*` windows. Without the
        /// distinction the ordinary `substitutions` family — where the reader
        /// genuinely says a different word — reported per-run "re-spelling"
        /// numbers for a disagreement that was never about spelling.
        #[serde(default)]
        respelled: bool,
    },
    /// Off-script speech (ad-lib, false start, aside). Gold holds position.
    Say { words: Vec<String> },
    /// Silence.
    Pause { ms: u32 },
    /// Change the assumed speaking rate (Tier-A timing and gold only).
    Rate { wpm: u32 },
    /// Simulate the presenter scrolling: from here on, the tracker is told
    /// this atom range is what's visible.
    Viewport { first: u32, last: u32 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PerformancePlan {
    pub name: String,
    /// Script fixture stem (e.g. "starter" → bench/scripts/starter.md).
    pub script: String,
    /// Scenario family for metric grouping (e.g. "exact", "skip", "retake").
    pub scenario: String,
    pub seed: u64,
    pub ops: Vec<PlanOp>,
    /// Tier-A synthetic ASR corruption rates (per mille). Zero = clean.
    #[serde(default)]
    pub corruption: Corruption,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Corruption {
    /// Probability (per mille) a word is replaced with a mangled form.
    pub substitute: u32,
    /// Probability (per mille) a word is dropped.
    pub delete: u32,
    /// Probability (per mille) junk is inserted after a word.
    pub insert: u32,
}

/// One element of the expanded performance timeline.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum GoldTag {
    /// Word carries the reader from `pos` to `pos_after` (atom boundaries).
    Script {
        pos_after: u32,
        /// The fractional atom span this word actually carries the reader
        /// across, when it is not one whole atom.
        ///
        /// A re-spelled run breaks the one-word-one-atom assumption in both
        /// directions: `143` is said as five words, `three thirty` is written
        /// as one. Rounding that to integers made the gold nonsense — five
        /// words each sweeping the SAME atom from start to end, so the
        /// reference position ran forward and snapped back four times inside
        /// one number, and a two-atom span written as one token left its first
        /// atom untraversed entirely.
        ///
        /// Absent in fixtures captured before this existed; the word then
        /// carries exactly one atom, ending at `pos_after`, which is what
        /// every plain read does anyway.
        #[serde(default)]
        span: Option<(f64, f64)>,
    },
    /// Off-script word; display should hold near `hold` (atom boundary).
    Off { hold: u32 },
}

impl GoldTag {
    /// The atom interval this word carries the reader across.
    pub fn span(&self) -> Option<(f64, f64)> {
        match self {
            GoldTag::Script { pos_after, span } => {
                Some(span.unwrap_or((*pos_after as f64 - 1.0, *pos_after as f64)))
            }
            GoldTag::Off { .. } => None,
        }
    }
}

/// A spoken word with its gold annotation. `text` is what the mouth says
/// (and what TTS renders); gold says where the reader is when it ends.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpokenWord {
    pub text: String,
    pub gold: GoldTag,
    /// How much of the performance clock this word takes, in whole-word units.
    ///
    /// A re-spelled run must occupy exactly the time the words it replaced
    /// would have: the premise of the `asr_forms` family is that the SOUND is
    /// unchanged and only the notation differs, so `asr_forms` and `exact` on
    /// the same script have to be the same performance, of the same length,
    /// with the same partial cadence. Without this they were not — five words
    /// for `143` bought the tracker four extra word-times of evidence, and the
    /// scenario ran 10% longer than the control it is compared against.
    #[serde(default = "one_word")]
    pub clock: f64,
    /// Was this word produced by a re-spelling? Marks the windows the
    /// `forms.span_*` metrics score.
    #[serde(default)]
    pub respelled: bool,
}

fn one_word() -> f64 {
    1.0
}

/// The expanded performance: what is said, in order, plus pauses, rate
/// changes and viewport hints anchored to word indexes.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Performance {
    pub words: Vec<SpokenWord>,
    /// (before word index, pause ms)
    pub pauses: Vec<(usize, u32)>,
    /// (from word index, wpm)
    pub rates: Vec<(usize, u32)>,
    /// (before word index, first atom, last atom)
    pub viewports: Vec<(usize, u32, u32)>,
    /// Segment boundaries for TTS rendering: (start word idx, end word idx).
    /// Each segment becomes one TTS clip, so gold word timing inside a
    /// segment only ever interpolates across a short clip.
    pub segments: Vec<(usize, usize)>,
}

/// Cap on words per TTS segment — short clips keep linear word-timing
/// interpolation honest (±1 word), which the ±2-atom metrics depend on.
const MAX_SEGMENT_WORDS: usize = 12;

pub fn expand(plan: &PerformancePlan, script: &CompiledScript) -> Performance {
    let mut p = Performance::default();
    let mut hold = 0u32;
    for op in &plan.ops {
        match op {
            PlanOp::Read { from, to } => {
                let from = (*from).min(script.len() as u32);
                let to = (*to).min(script.len() as u32);
                let seg_start = p.words.len();
                for atom in from..to {
                    p.words.push(SpokenWord {
                        text: script.atoms[atom as usize].surface.clone(),
                        gold: GoldTag::Script {
                            pos_after: atom + 1,
                            span: None,
                        },
                        clock: 1.0,
                        respelled: false,
                    });
                }
                hold = to;
                push_segments(&mut p.segments, seg_start, p.words.len(), script, from);
            }
            PlanOp::Substitute {
                from,
                to,
                say,
                respelled,
            } => {
                let seg_start = p.words.len();
                let n = say.len().max(1) as f64;
                let atoms = (to - from) as f64;
                for (i, w) in say.iter().enumerate() {
                    // Gold advances proportionally, and in fractions: the
                    // reader is a fifth of the way through `143` after saying
                    // "one", not finished with it.
                    let lo = *from as f64 + atoms * i as f64 / n;
                    let hi = *from as f64 + atoms * (i as f64 + 1.0) / n;
                    p.words.push(SpokenWord {
                        text: w.clone(),
                        gold: GoldTag::Script {
                            pos_after: hi.ceil() as u32,
                            span: Some((lo, hi)),
                        },
                        // The span takes the time its atoms would have taken.
                        clock: atoms / n,
                        respelled: *respelled,
                    });
                }
                hold = *to;
                p.segments.push((seg_start, p.words.len()));
            }
            PlanOp::Say { words } => {
                let seg_start = p.words.len();
                for w in words {
                    p.words.push(SpokenWord {
                        text: w.clone(),
                        gold: GoldTag::Off { hold },
                        clock: 1.0,
                        respelled: false,
                    });
                }
                p.segments.push((seg_start, p.words.len()));
            }
            PlanOp::Pause { ms } => {
                p.pauses.push((p.words.len(), *ms));
            }
            PlanOp::Rate { wpm } => {
                p.rates.push((p.words.len(), *wpm));
            }
            PlanOp::Viewport { first, last } => {
                p.viewports.push((p.words.len(), *first, *last));
            }
        }
    }
    p
}

/// Split a Read run into segments at paragraph boundaries, hard-capped at
/// MAX_SEGMENT_WORDS.
fn push_segments(
    segments: &mut Vec<(usize, usize)>,
    word_start: usize,
    word_end: usize,
    script: &CompiledScript,
    atom_from: u32,
) {
    let mut seg_start = word_start;
    let mut last_para = script
        .atoms
        .get(atom_from as usize)
        .map(|a| a.para)
        .unwrap_or(0);
    for w in word_start..word_end {
        let atom = atom_from as usize + (w - word_start);
        let para = script.atoms[atom].para;
        let too_long = w - seg_start >= MAX_SEGMENT_WORDS;
        if (para != last_para || too_long) && w > seg_start {
            segments.push((seg_start, w));
            seg_start = w;
        }
        last_para = para;
    }
    if word_end > seg_start {
        segments.push((seg_start, word_end));
    }
}

/// Gold timeline: for every spoken word, when it starts/ends and where the
/// reader is. Built from either Tier-A synthetic timing (wpm-driven) or
/// Tier-B TTS segment timing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoldWord {
    pub start_ms: f64,
    pub end_ms: f64,
    pub text: String,
    pub gold: GoldTag,
    /// Was this word produced by a re-spelling? See [`SpokenWord::respelled`].
    #[serde(default)]
    pub respelled: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GoldTimeline {
    pub words: Vec<GoldWord>,
    /// (audio_ms, first_atom, last_atom) — when each viewport hint applies.
    pub viewport_hints: Vec<(f64, u32, u32)>,
    pub total_ms: f64,
}

impl GoldTimeline {
    /// Gold reader position (atom boundary, fractional) at time `t`.
    /// During off-script speech and silence the position holds.
    pub fn position_at(&self, t_ms: f64) -> Option<GoldPoint> {
        if self.words.is_empty() {
            return None;
        }
        let mut last: Option<GoldPoint> = None;
        for w in &self.words {
            if t_ms < w.start_ms {
                return last;
            }
            let (pos, on_script) = match w.gold.span() {
                Some((lo, hi)) => {
                    let frac = if w.end_ms > w.start_ms {
                        ((t_ms - w.start_ms) / (w.end_ms - w.start_ms)).clamp(0.0, 1.0)
                    } else {
                        1.0
                    };
                    (lo + (hi - lo) * frac, true)
                }
                None => match w.gold {
                    GoldTag::Off { hold } => (hold as f64, false),
                    GoldTag::Script { .. } => unreachable!("a script tag always has a span"),
                },
            };
            let speaking = t_ms <= w.end_ms;
            last = Some(GoldPoint {
                position: pos,
                on_script,
                speaking,
            });
            if t_ms <= w.end_ms {
                return last;
            }
        }
        last
    }
}

#[derive(Debug, Clone, Copy)]
pub struct GoldPoint {
    pub position: f64,
    pub on_script: bool,
    /// Is a word actively being spoken at this instant (false in gaps)?
    pub speaking: bool,
}

/// Build gold timing for Tier A: words take 60000/wpm ms, pauses insert gaps.
pub fn synthetic_timing(performance: &Performance, default_wpm: u32) -> GoldTimeline {
    let mut timeline = GoldTimeline::default();
    let mut t = 500.0; // lead-in before the first word
    let mut wpm = default_wpm.max(60);
    let mut rate_idx = 0usize;
    let mut pause_idx = 0usize;
    let mut vp_idx = 0usize;
    for (i, w) in performance.words.iter().enumerate() {
        while rate_idx < performance.rates.len() && performance.rates[rate_idx].0 <= i {
            wpm = performance.rates[rate_idx].1.max(60);
            rate_idx += 1;
        }
        while pause_idx < performance.pauses.len() && performance.pauses[pause_idx].0 == i {
            t += performance.pauses[pause_idx].1 as f64;
            pause_idx += 1;
        }
        while vp_idx < performance.viewports.len() && performance.viewports[vp_idx].0 <= i {
            let (_, first, last) = performance.viewports[vp_idx];
            timeline.viewport_hints.push((t, first, last));
            vp_idx += 1;
        }
        let dur = 60_000.0 / wpm as f64 * w.clock;
        timeline.words.push(GoldWord {
            start_ms: t,
            end_ms: t + dur,
            text: w.text.clone(),
            gold: w.gold.clone(),
            respelled: w.respelled,
        });
        t += dur;
    }
    timeline.total_ms = t + 500.0;
    timeline
}

#[cfg(test)]
mod tests {
    use super::*;
    use cc_align::{compile, CompileOptions};

    #[test]
    fn expansion_maps_gold_positions() {
        let script = compile("alpha bravo charlie delta echo", CompileOptions::default());
        let plan = PerformancePlan {
            name: "t".into(),
            script: "t".into(),
            scenario: "exact".into(),
            seed: 1,
            ops: vec![
                PlanOp::Read { from: 0, to: 2 },
                PlanOp::Say {
                    words: vec!["hello".into()],
                },
                PlanOp::Read { from: 2, to: 5 },
            ],
            corruption: Corruption::default(),
        };
        let p = expand(&plan, &script);
        assert_eq!(p.words.len(), 6);
        assert!(matches!(p.words[1].gold, GoldTag::Script { pos_after: 2, .. }));
        assert!(matches!(p.words[2].gold, GoldTag::Off { hold: 2 }));
        assert!(matches!(p.words[5].gold, GoldTag::Script { pos_after: 5, .. }));
    }

    #[test]
    fn gold_timeline_holds_during_off_script() {
        let script = compile("alpha bravo charlie delta echo", CompileOptions::default());
        let plan = PerformancePlan {
            name: "t".into(),
            script: "t".into(),
            scenario: "adlib".into(),
            seed: 1,
            ops: vec![
                PlanOp::Read { from: 0, to: 2 },
                PlanOp::Say {
                    words: vec!["x".into(), "y".into()],
                },
                PlanOp::Read { from: 2, to: 3 },
            ],
            corruption: Corruption::default(),
        };
        let p = expand(&plan, &script);
        let gold = synthetic_timing(&p, 150);
        // Mid-ad-lib the position holds at 2.0.
        let mid = gold.words[2].start_ms + 10.0;
        let point = gold.position_at(mid).unwrap();
        assert_eq!(point.position, 2.0);
        assert!(!point.on_script);
    }
}
