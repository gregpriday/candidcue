//! Algorithmic robustness: metamorphic invariants and a bounded adversarial
//! search.
//!
//! A fixed scenario list can only find failures somebody thought of. These two
//! techniques find failures nobody thought of, in opposite directions:
//!
//! * **Metamorphic tests** change something that must NOT change behaviour
//!   (notation, layout, distant text) and assert that it did not. They need no
//!   gold timeline at all — the invariant *is* the oracle — which is what makes
//!   them cheap enough to run on every script in the corpus.
//! * **Adversarial search** looks for the SMALLEST transcript corruption that
//!   makes the engine do something unsafe, and reports the cost of that
//!   perturbation as a robustness radius. The goal is not zero failures at
//!   infinite corruption; it is to make unsafe behaviour require recogniser
//!   output no real recogniser would produce.
//!
//! Both are deterministic. The search is a seeded beam over a fixed operator set,
//! so a radius is reproducible and a regression in it is a real regression rather
//! than a different random draw.

use cc_align::{AlignmentConfig, CompileOptions, Engine, SessionEvent, TrackingState};
use cc_stt::SttFrame;
use serde::{Deserialize, Serialize};

use crate::synthetic::Lcg;

// ---------------------------------------------------------------------------
// Metamorphic invariants
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetamorphicResult {
    pub name: String,
    pub script: String,
    pub passed: bool,
    /// Largest position divergence observed, in atoms.
    pub worst_divergence: f64,
    pub detail: String,
}

/// Drive the engine over an event log and collect the observed positions.
fn observed_series(
    source: &str,
    config: &AlignmentConfig,
    events: &[SttFrame],
) -> Vec<(f64, f64, TrackingState)> {
    let script = cc_align::compile(source, CompileOptions::default());
    let mut engine = Engine::new(script, config.clone());
    let mut out = Vec::new();
    for frame in events {
        let event = match frame {
            SttFrame::ItemStarted { item_id, audio_start_ms, .. } => SessionEvent::ItemStarted {
                item_id: item_id.clone(),
                audio_start_ms: *audio_start_ms,
            },
            // Timing is dropped rather than carried: robustness rewrites the
            // TEXT of a frame (dropped words, swapped homophones), and word
            // times captured against the original no longer describe it. The
            // engine would reject the mismatch itself, but saying so here keeps
            // the perturbation honest about what it is handing over.
            SttFrame::Partial { item_id, text, audio_ms, .. } => SessionEvent::Partial {
                item_id: item_id.clone(),
                text: text.clone(),
                audio_ms: *audio_ms,
                word_times: None,
            },
            SttFrame::Final { item_id, text, audio_end_ms, .. } => SessionEvent::Final {
                item_id: item_id.clone(),
                text: text.clone(),
                audio_end_ms: *audio_end_ms,
                word_times: None,
            },
            SttFrame::Error { .. } | SttFrame::Closed {} => continue,
        };
        let snap = engine.handle(event);
        out.push((snap.at_audio_ms, snap.observed, snap.state));
    }
    out
}

/// Rewrite every partial/final text with `f`.
///
/// Word timings are DROPPED rather than carried: `f` is free to add, remove or
/// merge words, so a vector built for the original text may no longer line up
/// with a single word of the rewritten one. A perturbation exists to ask what
/// the engine does with worse evidence, and evidence that quietly disagrees
/// with itself is not the question being asked.
fn map_text(events: &[SttFrame], f: impl Fn(&str) -> String) -> Vec<SttFrame> {
    events
        .iter()
        .map(|e| match e {
            SttFrame::Partial { item_id, text, audio_ms, wall_ms, .. } => SttFrame::Partial {
                item_id: item_id.clone(),
                text: f(text),
                audio_ms: *audio_ms,
                wall_ms: *wall_ms,
                word_times: None,
            },
            SttFrame::Final { item_id, text, audio_end_ms, wall_ms, .. } => SttFrame::Final {
                item_id: item_id.clone(),
                text: f(text),
                audio_end_ms: *audio_end_ms,
                wall_ms: *wall_ms,
                word_times: None,
            },
            other => other.clone(),
        })
        .collect()
}

fn scale_word_times(
    word_times: &Option<Vec<cc_stt::WordTime>>,
    scale: f64,
) -> Option<Vec<cc_stt::WordTime>> {
    word_times.as_ref().map(|times| {
        times
            .iter()
            .map(|w| cc_stt::WordTime {
                text: w.text.clone(),
                start_ms: w.start_ms * scale,
            })
            .collect()
    })
}

/// Shift every timestamp by `scale`, which must be matched by a correspondingly
/// scaled rate ceiling for the invariant to be meaningful.
fn scale_time(events: &[SttFrame], scale: f64) -> Vec<SttFrame> {
    events
        .iter()
        .map(|e| match e {
            SttFrame::ItemStarted { item_id, ordinal, audio_start_ms } => SttFrame::ItemStarted {
                item_id: item_id.clone(),
                ordinal: *ordinal,
                audio_start_ms: audio_start_ms * scale,
            },
            SttFrame::Partial { item_id, text, audio_ms, wall_ms, word_times } => SttFrame::Partial {
                item_id: item_id.clone(),
                text: text.clone(),
                audio_ms: audio_ms * scale,
                wall_ms: wall_ms * scale,
                // Scaled with everything else: this perturbation stretches the
                // take's clock, and a word time left at its old value would put
                // the word outside the utterance it belongs to.
                word_times: scale_word_times(word_times, scale),
            },
            SttFrame::Final { item_id, text, audio_end_ms, wall_ms, word_times } => SttFrame::Final {
                item_id: item_id.clone(),
                text: text.clone(),
                audio_end_ms: audio_end_ms * scale,
                wall_ms: wall_ms * scale,
                word_times: scale_word_times(word_times, scale),
            },
            other => other.clone(),
        })
        .collect()
}

fn worst_divergence(
    a: &[(f64, f64, TrackingState)],
    b: &[(f64, f64, TrackingState)],
) -> f64 {
    a.iter()
        .zip(b.iter())
        .map(|(x, y)| (x.1 - y.1).abs())
        .fold(0.0, f64::max)
}

/// Tolerance for an invariant that should hold EXACTLY. Not zero, because the
/// display position is a float and the ledger's timestamp corrections are
/// arithmetic — but tight enough that a real behaviour change cannot hide.
const EXACT_TOLERANCE: f64 = 1e-6;
/// Tolerance for invariants that should hold to within a word.
const LOCAL_TOLERANCE: f64 = 1.0;

/// Run the metamorphic battery for one script and its event log.
pub fn metamorphic_battery(
    script_name: &str,
    source: &str,
    config: &AlignmentConfig,
    events: &[SttFrame],
) -> Vec<MetamorphicResult> {
    let base = observed_series(source, config, events);
    let mut out = Vec::new();

    let mut check = |name: &str, series: Vec<(f64, f64, TrackingState)>, tol: f64, note: &str| {
        let worst = worst_divergence(&base, &series);
        out.push(MetamorphicResult {
            name: name.to_string(),
            script: script_name.to_string(),
            passed: worst <= tol,
            worst_divergence: worst,
            detail: note.to_string(),
        });
    };

    // 1. Case and SENTENCE punctuation are normalised away, so they cannot move
    //    anything.
    //
    //    Only trailing punctuation is stripped, and that restriction is the
    //    finding rather than a workaround. Stripping every `.` and `,` turned
    //    `3.5` into `35` and `1,200` into `1200`, which measured 2 and 5 atoms of
    //    divergence on `technical` and `figures` — correctly, because those are
    //    different NUMBERS, not different notations for one. An invariant that
    //    cannot tell a decimal point from a full stop is asserting something
    //    untrue, and it would have been "fixed" by weakening the tolerance until
    //    a real punctuation bug could pass too.
    check(
        "case_and_punctuation",
        observed_series(source, config, &map_text(events, |t| {
            t.split_whitespace()
                .map(|w| {
                    w.trim_end_matches([',', '.', ';', ':', '!', '?'])
                        .to_uppercase()
                })
                .collect::<Vec<_>>()
                .join(" ")
        })),
        EXACT_TOLERANCE,
        "upper-cased, sentence-punctuation-stripped transcript must be identical",
    );

    // 2. Non-spoken Markdown does not change spoken positions.
    //    A cue, a comment block and a horizontal rule contribute no atoms, so
    //    inserting them must leave every atom index where it was.
    {
        let decorated = format!("---\n\n{source}\n\n---\n");
        check(
            "non_spoken_markdown",
            observed_series(&decorated, config, events),
            EXACT_TOLERANCE,
            "rules and blank blocks compile to no atoms and must not shift the map",
        );
    }

    // 3. Delayed evidence must not make the engine MORE confident, and must not
    //    increase its lead. This one is directional rather than an equality: a
    //    later partial is strictly less informative than a timely one.
    {
        let delayed = events
            .iter()
            .map(|e| match e {
                SttFrame::Partial { item_id, text, audio_ms, wall_ms, word_times } => SttFrame::Partial {
                    item_id: item_id.clone(),
                    text: text.clone(),
                    audio_ms: audio_ms + 250.0,
                    wall_ms: *wall_ms,
                    // Carried UNCHANGED. This perturbation delays when the
                    // frame arrives, not when the words were said — moving
                    // the word clocks with it would model a presenter who
                    // spoke late rather than a recogniser that reported late.
                    word_times: word_times.clone(),
                },
                other => other.clone(),
            })
            .collect::<Vec<_>>();
        let series = observed_series(source, config, &delayed);
        // The invariant is one-sided: delayed evidence may lag, never lead.
        let worst_ahead = base
            .iter()
            .zip(series.iter())
            .map(|(x, y)| y.1 - x.1)
            .fold(f64::NEG_INFINITY, f64::max);
        out.push(MetamorphicResult {
            name: "delayed_evidence_does_not_lead".into(),
            script: script_name.to_string(),
            passed: worst_ahead <= LOCAL_TOLERANCE,
            worst_divergence: worst_ahead.max(0.0),
            detail: "a partial that arrived later must not place the display further ahead".into(),
        });
    }

    // 4. Scaling the clock scales the trajectory. Time enters the engine only as
    //    explicit audio milliseconds, so a uniformly slower performance must be
    //    followed the same way in TOKEN space — the position at 2t under the
    //    stretched log has to match the position at t under the original.
    {
        let stretched = scale_time(events, 2.0);
        let series = observed_series(source, config, &stretched);
        // Rate-limited extrapolation legitimately differs mid-gap, so the
        // invariant is checked on the observed position at each EVENT, which is
        // evidence-driven and clock-free.
        let worst = worst_divergence(&base, &series);
        out.push(MetamorphicResult {
            name: "clock_scale_invariance".into(),
            script: script_name.to_string(),
            passed: worst <= 3.0,
            worst_divergence: worst,
            detail: "halving the speaking rate must not change which atoms the evidence supports"
                .into(),
        });
    }

    // 5. A distant duplicate passage must cost CONFIDENCE, not cause a jump.
    //    Appending a copy of the opening to the end of the script creates a
    //    perfect ambiguity at distance; the engine may hesitate, and may not
    //    teleport.
    {
        let head: String = source.split_whitespace().take(40).collect::<Vec<_>>().join(" ");
        let duplicated = format!("{source}\n\n{head}\n");
        let series = observed_series(&duplicated, config, events);
        let jumped = series
            .windows(2)
            .any(|w| (w[1].1 - w[0].1).abs() > 60.0);
        out.push(MetamorphicResult {
            name: "distant_duplicate_no_silent_jump".into(),
            script: script_name.to_string(),
            passed: !jumped,
            worst_divergence: series
                .windows(2)
                .map(|w| (w[1].1 - w[0].1).abs())
                .fold(0.0, f64::max),
            detail: "a duplicate passage far away must lower confidence, never move the display"
                .into(),
        });
    }

    out
}

// ---------------------------------------------------------------------------
// Bounded adversarial search
// ---------------------------------------------------------------------------

/// What makes a perturbed transcript "unsafe".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum UnsafeKind {
    /// The display moved more than 40 atoms to a place the reader was not.
    FalseJump,
    /// `Following` claimed while more than 10 atoms from the truth, held.
    FalseConfidence,
    /// The display passed a word the reader had never spoken.
    UnreadInk,
}

/// Perturbation cost weights (§13.2). Substitutions are cheap — real recognisers
/// make them constantly; retractions and large timing shifts are expensive
/// because a recogniser that does those is broken in a way the user would notice
/// independently.
const COST_SUB: f64 = 1.0;
const COST_DEL: f64 = 1.2;
const COST_INS: f64 = 1.5;
const COST_TIME_PER_100MS: f64 = 0.4;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RobustnessResult {
    pub script: String,
    pub scenario: String,
    /// Cheapest perturbation found that produced each failure, if any.
    pub false_jump_radius: Option<f64>,
    pub false_confidence_radius: Option<f64>,
    pub unread_ink_radius: Option<f64>,
    /// Perturbations evaluated.
    pub evaluated: usize,
}

impl RobustnessResult {
    /// The overall radius: the cheapest corruption that produced ANY unsafe
    /// behaviour. `None` means nothing in the searched neighbourhood broke it,
    /// which is the good answer and is reported as such rather than as zero.
    pub fn radius(&self) -> Option<f64> {
        [
            self.false_jump_radius,
            self.false_confidence_radius,
            self.unread_ink_radius,
        ]
        .into_iter()
        .flatten()
        .fold(None, |acc: Option<f64>, v| {
            Some(acc.map_or(v, |a: f64| a.min(v)))
        })
    }
}

/// One perturbation: which operator, applied where.
#[derive(Debug, Clone, Copy)]
struct Perturbation {
    /// Index into the event log.
    event: usize,
    /// Word index within that event's text.
    word: usize,
    op: PerturbOp,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum PerturbOp {
    /// Replace with a word taken from elsewhere in the script — the corruption
    /// that actually causes false jumps, because it looks like real evidence for
    /// somewhere else.
    SubstituteFromScript(usize),
    Delete,
    /// Insert a script word from elsewhere.
    InsertFromScript(usize),
    /// Shift the event's timestamp forward.
    DelayMs(u32),
}

impl PerturbOp {
    fn cost(&self) -> f64 {
        match self {
            PerturbOp::SubstituteFromScript(_) => COST_SUB,
            PerturbOp::Delete => COST_DEL,
            PerturbOp::InsertFromScript(_) => COST_INS,
            PerturbOp::DelayMs(ms) => COST_TIME_PER_100MS * (*ms as f64) / 100.0,
        }
    }
}

fn apply(events: &[SttFrame], perts: &[Perturbation], vocab: &[String]) -> Vec<SttFrame> {
    let mut out = events.to_vec();
    for p in perts {
        let Some(frame) = out.get_mut(p.event) else { continue };
        match frame {
            SttFrame::Partial { text, audio_ms, word_times, .. }
            | SttFrame::Final { text, audio_end_ms: audio_ms, word_times, .. } => {
                match p.op {
                    // Only WHEN the frame arrived moved; the words in it did
                    // not, so their clocks stand.
                    PerturbOp::DelayMs(ms) => *audio_ms += ms as f64,
                    _ => {
                        let mut words: Vec<String> =
                            text.split_whitespace().map(str::to_string).collect();
                        if words.is_empty() {
                            continue;
                        }
                        let at = p.word % words.len();
                        match p.op {
                            PerturbOp::SubstituteFromScript(v) => {
                                words[at] = vocab[v % vocab.len()].clone();
                            }
                            PerturbOp::Delete => {
                                words.remove(at);
                            }
                            PerturbOp::InsertFromScript(v) => {
                                words.insert(at, vocab[v % vocab.len()].clone());
                            }
                            PerturbOp::DelayMs(_) => unreachable!(),
                        }
                        *text = words.join(" ");
                        // The word list just changed length or spelling, so a
                        // timing vector built for the old one now describes a
                        // transcript that no longer exists. Nothing reads it
                        // yet, which is exactly why it must not be left to rot
                        // — the day something does, this frame would be a
                        // corrupt fixture rather than a harder one.
                        *word_times = None;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// Does this perturbed log make the engine misbehave, and how?
fn classify(
    source: &str,
    config: &AlignmentConfig,
    events: &[SttFrame],
    gold: &crate::passgold::PassGold,
) -> Option<UnsafeKind> {
    let series = observed_series(source, config, events);
    let mut prev: Option<f64> = None;
    let mut fce_run = 0.0;
    let mut last_t = 0.0;
    for &(t, pos, state) in &series {
        // Inside the window after a gold discontinuity the engine is ENTITLED to
        // be wrong: accepting a jump takes evidence and persistence rounds by
        // design, and that delay is what `recovery.*` measures. Without this the
        // search reported a radius of 1.0 on every `skip_forward` and `retake`
        // scenario after five perturbations — because the UNPERTURBED run was
        // already being classified unsafe, so the "cheapest corruption that
        // breaks safety" was whichever one happened to be tried first. A radius
        // computed from a baseline that already fails is not a radius.
        let in_grace = gold.discontinuities.iter().any(|d| {
            t >= d.at_ms && t < d.at_ms + DISCONTINUITY_GRACE_MS
        });
        let frontier = gold.spoken_frontier(t);
        let ever = gold.ever_spoken_frontier(t);
        if let Some(p) = prev {
            if !in_grace && (pos - p).abs() > 40.0 && (pos - frontier).abs() > 20.0 {
                return Some(UnsafeKind::FalseJump);
            }
        }
        prev = Some(pos);
        // Unread ink has NO grace: fading a word the reader has never said is
        // wrong during a recovery too. The high-water reference is what makes
        // that fair — a retake does not un-speak anything.
        if pos > ever + 2.0 {
            return Some(UnsafeKind::UnreadInk);
        }
        if !in_grace
            && matches!(state, TrackingState::Following)
            && (pos - frontier).abs() > 10.0
        {
            fce_run += t - last_t;
            if fce_run >= 1_000.0 {
                return Some(UnsafeKind::FalseConfidence);
            }
        } else {
            fce_run = 0.0;
        }
        last_t = t;
    }
    None
}

/// Grace after a gold discontinuity, matching `metrics::DISCONTINUITY_GRACE_MS`.
const DISCONTINUITY_GRACE_MS: f64 = 5_000.0;

/// Search for the cheapest corruption that breaks safety.
///
/// A seeded beam rather than an exhaustive sweep: the space is
/// (events × words × operators)^depth, and the useful answer is an upper bound on
/// the radius, which any search that finds *a* break provides. Depth is capped
/// at three because a three-operator corruption already describes a recogniser
/// having a bad second, and beyond that the perturbation is more implausible
/// than any behaviour it could provoke.
pub fn adversarial_search(
    script_name: &str,
    scenario: &str,
    source: &str,
    config: &AlignmentConfig,
    events: &[SttFrame],
    gold: &crate::passgold::PassGold,
    budget: usize,
    seed: u64,
) -> RobustnessResult {
    let script = cc_align::compile(source, CompileOptions::default());
    // The vocabulary a corruption can draw from is the SCRIPT's own words. Junk
    // is easy to reject; a real word from the wrong paragraph is what actually
    // proposes a wrong place.
    let vocab: Vec<String> = script
        .atoms
        .iter()
        .map(|a| a.surface.clone())
        .collect();
    if vocab.is_empty() || events.is_empty() {
        return RobustnessResult {
            script: script_name.into(),
            scenario: scenario.into(),
            false_jump_radius: None,
            false_confidence_radius: None,
            unread_ink_radius: None,
            evaluated: 0,
        };
    }

    // A radius is only meaningful relative to a SAFE baseline. If the
    // unperturbed log already misbehaves, that is a finding for the tracking
    // table, not a robustness number — reporting the first perturbation's cost
    // would be reporting noise with a decimal point on it.
    if let Some(kind) = classify(source, config, events, gold) {
        eprintln!(
            "  {script_name}/{scenario}: baseline already unsafe ({kind:?}); no radius reported"
        );
        return RobustnessResult {
            script: script_name.into(),
            scenario: scenario.into(),
            false_jump_radius: None,
            false_confidence_radius: None,
            unread_ink_radius: None,
            evaluated: 0,
        };
    }

    let mut rng = Lcg::new(seed);
    let mut best: [Option<f64>; 3] = [None, None, None];
    let mut evaluated = 0usize;

    // Beam: keep the cheapest perturbation sets that have not yet broken
    // anything, and extend them. A set that DID break something bounds the
    // radius, so it is recorded and not extended — extending it could only find
    // a more expensive break.
    let mut beam: Vec<(f64, Vec<Perturbation>)> = vec![(0.0, Vec::new())];
    const BEAM: usize = 12;
    const DEPTH: usize = 3;

    for _depth in 0..DEPTH {
        let mut next: Vec<(f64, Vec<Perturbation>)> = Vec::new();
        for (cost, perts) in &beam {
            for _ in 0..(budget / (BEAM * DEPTH)).max(4) {
                let op = match rng.next_u32() % 8 {
                    0..=3 => PerturbOp::SubstituteFromScript(rng.next_u32() as usize),
                    4..=5 => PerturbOp::Delete,
                    6 => PerturbOp::InsertFromScript(rng.next_u32() as usize),
                    _ => PerturbOp::DelayMs(100 + rng.next_u32() % 700),
                };
                let p = Perturbation {
                    event: rng.next_u32() as usize % events.len(),
                    word: rng.next_u32() as usize,
                    op,
                };
                let mut set = perts.clone();
                set.push(p);
                let total = cost + op.cost();
                let perturbed = apply(events, &set, &vocab);
                evaluated += 1;
                match classify(source, config, &perturbed, gold) {
                    Some(kind) => {
                        let slot = match kind {
                            UnsafeKind::FalseJump => 0,
                            UnsafeKind::FalseConfidence => 1,
                            UnsafeKind::UnreadInk => 2,
                        };
                        best[slot] = Some(best[slot].map_or(total, |b: f64| b.min(total)));
                    }
                    None => next.push((total, set)),
                }
            }
        }
        next.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        next.truncate(BEAM);
        if next.is_empty() {
            break;
        }
        beam = next;
    }

    RobustnessResult {
        script: script_name.into(),
        scenario: scenario.into(),
        false_jump_radius: best[0],
        false_confidence_radius: best[1],
        unread_ink_radius: best[2],
        evaluated,
    }
}

/// Parameter-neighbourhood robustness (§13.4): evaluate a configuration across a
/// local box rather than at one point, so a sharp optimum cannot be mistaken for
/// a good setting.
///
/// Returns the perturbed configurations to evaluate. The caller scores them,
/// because "worse" is a suite-level judgement and this module has no opinion
/// about which row matters.
pub fn parameter_neighbourhood(base: &AlignmentConfig, fraction: f64) -> Vec<(String, AlignmentConfig)> {
    let mut out = Vec::new();
    macro_rules! sweep {
        ($field:ident) => {{
            for (tag, sign) in [("-", -1.0), ("+", 1.0)] {
                let mut c = base.clone();
                c.$field *= 1.0 + sign * fraction;
                out.push((format!("{}{}{:.0}%", stringify!($field), tag, fraction * 100.0), c.sanitized()));
            }
        }};
    }
    // The knobs a plateau actually has to be flat over: everything that shapes
    // the lead profile and the pace estimate. A threshold that fails when
    // recogniser latency moves by 60 ms is not a robust product setting.
    sweep!(prediction_gain);
    sweep!(lead_margin_atoms);
    sweep!(max_lead_atoms);
    sweep!(max_prediction_ms);
    sweep!(pause_onset_ms);
    sweep!(lead_ease_ms);
    sweep!(lead_decay_ms);
    sweep!(rate_hold_ms);
    sweep!(partial_lag_ms);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tiny_events() -> Vec<SttFrame> {
        vec![
            SttFrame::ItemStarted { item_id: "1".into(), ordinal: 0, audio_start_ms: 0.0 },
            SttFrame::Partial {
                item_id: "1".into(),
                text: "alpha bravo charlie".into(),
                audio_ms: 1_000.0,
                wall_ms: 1_000.0,
                word_times: None,
            },
            SttFrame::Partial {
                item_id: "1".into(),
                text: "alpha bravo charlie delta echo".into(),
                audio_ms: 1_800.0,
                wall_ms: 1_800.0,
                word_times: None,
            },
            SttFrame::Final {
                item_id: "1".into(),
                text: "alpha bravo charlie delta echo".into(),
                audio_end_ms: 2_600.0,
                wall_ms: 2_600.0,
                word_times: None,
            },
        ]
    }

    #[test]
    fn case_and_punctuation_are_invariant() {
        let source = "alpha bravo charlie delta echo foxtrot golf";
        let results = metamorphic_battery(
            "t",
            source,
            &AlignmentConfig::default(),
            &tiny_events(),
        );
        let r = results
            .iter()
            .find(|r| r.name == "case_and_punctuation")
            .expect("battery ran the case test");
        assert!(r.passed, "divergence {}", r.worst_divergence);
    }

    #[test]
    fn parameter_neighbourhood_covers_both_directions() {
        let base = AlignmentConfig::default();
        let n = parameter_neighbourhood(&base, 0.05);
        assert!(n.len() >= 18);
        assert!(n.iter().any(|(k, _)| k.starts_with("prediction_gain-")));
        assert!(n.iter().any(|(k, _)| k.starts_with("prediction_gain+")));
        // Sanitisation must leave every candidate runnable.
        for (_, c) in &n {
            assert!(c.prediction_gain.is_finite() && c.prediction_gain > 0.0);
        }
    }
}
