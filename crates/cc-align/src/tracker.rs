//! The position tracker: candidate generation, ranking, decision policy, and
//! the three positions (confirmed / observed / display).
//!
//! Design (spec §8–§12, condensed):
//!
//! * **Local continuity is the default.** Each event aligns the transcript
//!   tail against a band around the predicted position. One misspeak, filler,
//!   or retraction stays a *local* matter.
//! * **Discontinuities are explicit.** Far-forward skips, backward retakes and
//!   the initial lock go through stricter gates: more exact content evidence,
//!   a rank margin over the local explanation, and persistence across
//!   consecutive revisions. A wrong jump is worse than a late one.
//! * **The viewport is a prior, not a command.** `set_viewport_hint` tells the
//!   tracker what the presenter can currently see; candidates near it get a
//!   rank bonus and relocation prefers it, but text evidence always outranks
//!   the hint.
//! * **Three positions.** `confirmed` is conservative and (retakes aside)
//!   monotonic; `observed` follows the best supported evidence including
//!   provisional partials; the display extrapolates `observed` forward by the
//!   estimated reading rate, bounded by `max_prediction_ms`.

use serde::Serialize;

use crate::align::{align, AlignScratch, Evidence};
use crate::config::AlignmentConfig;
use crate::ledger::{Ledger, QueryAtom};
use crate::script::{CompiledScript, FLAG_ANCHOR};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum TrackingState {
    /// No lock yet (session start, manual reset, or lost).
    Searching,
    /// Locked with healthy local evidence.
    Following,
    /// Locked, but current evidence is weak or off-script; display holds.
    Holding,
    /// Two or more distant candidates are genuinely plausible; display holds.
    Ambiguous,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum DecisionCode {
    NoEvidence,
    LocalObserved,
    LocalConfirmed,
    HoldLowEvidence,
    HoldOffScript,
    HoldAmbiguous,
    RelocationAccepted,
    JumpForwardAccepted,
    RetakeAccepted,
    JumpPending,
    ManualAnchor,
}

/// Input events, mirroring the wire frames the Rust STT session emits
/// (`src-tauri/src/inworld/stream.rs::SttFrame`), with the receive-side audio
/// clock attached.
#[derive(Debug, Clone)]
pub enum SessionEvent {
    ItemStarted {
        item_id: String,
        audio_start_ms: f64,
    },
    Partial {
        item_id: String,
        text: String,
        /// Audio-clock value when this partial arrived.
        audio_ms: f64,
    },
    Final {
        item_id: String,
        text: String,
        audio_end_ms: f64,
    },
}

/// What the stage (or the evaluator) receives after every event.
#[derive(Debug, Clone, Serialize)]
pub struct Snapshot {
    pub seq: u64,
    pub state: TrackingState,
    pub decision: DecisionCode,
    /// Conservative anchor (atom boundary). Monotonic except accepted retakes
    /// and manual navigation.
    pub confirmed: f64,
    /// Best evidence-supported position (atom boundary).
    pub observed: f64,
    /// Rate the DISPLAY extrapolates at (atoms/sec) — the reading-rate estimate
    /// already scaled by `prediction_gain`, so it is deliberately short of how
    /// fast the reader is actually going. Zero whenever extrapolating would be
    /// a guess (holding/searching/ambiguous) or the reader has stopped.
    pub rate: f64,
    /// Audio time the observed position corresponds to.
    pub evidence_audio_ms: f64,
    /// Audio-clock time this snapshot was produced.
    pub at_audio_ms: f64,
    /// Cap on forward extrapolation from `evidence_audio_ms`.
    pub max_prediction_ms: f64,
    /// Evidence age (ms) at which the lead stops growing and eases back —
    /// a pause, not a between-partials gap.
    pub pause_onset_ms: f64,
    /// Residual lead (ms of reading) kept once paused.
    pub lead_floor_ms: f64,
    /// Hard cap on how far prediction may carry the display past `observed`
    /// (atoms), whatever the rate estimate says.
    pub max_lead_atoms: f64,
    /// Distance the display deliberately sits behind its own estimate while
    /// flowing — see `AlignmentConfig::lead_margin_atoms`.
    pub lead_margin_atoms: f64,
    /// Corner-rounding widths for the lead profile — see `display_at`.
    pub lead_ease_ms: f64,
    pub lead_hold_ms: f64,
    pub lead_decay_ms: f64,
    /// Absolute ceiling for the display: the end of the sentence the reader
    /// was last heard in. Prediction stops here and waits for evidence.
    pub display_limit: f64,
    /// Heuristic 0..1 — NOT yet a calibrated probability; benchmarked as-is.
    pub confidence: f64,
    /// A distant candidate accumulating evidence (the "Suggest jump"
    /// interaction state): the UI may offer "possible match below — resume
    /// here?" instead of teleporting. None while following normally.
    pub suggestion: Option<f64>,
    /// A bounded, reversible dimming frontier supported only by close local
    /// spelling/phonetic evidence. It never drives scrolling or progress.
    pub provisional: Option<f64>,
    /// True for the snapshot that explicitly withdraws a provisional frontier.
    /// The stage uses this one-shot signal to permit words to brighten again.
    pub provisional_retracted: bool,
    /// Total spoken atoms in the script — the hard ceiling for `display_at`.
    pub script_len: f64,
}

impl Snapshot {
    /// Where the display should place the reader at audio-clock time `t`.
    /// This is the pure function the stage motion layer (and the evaluator)
    /// applies between snapshots.
    ///
    /// The display fades out words as they are heard, so its two directions of
    /// error are not worth the same and it must not be tuned as if they were.
    /// Trailing leaves a word legible a moment longer than it needed to be and
    /// nobody notices. Leading erases a line the reader has not reached — and
    /// they are looking straight at it. Everything below is that asymmetry: a
    /// lead that is only ever a fraction of a word, that decays to nothing when
    /// evidence goes stale, and that stops dead at the end of the sentence the
    /// reader was last heard in.
    pub fn display_at(&self, t_audio_ms: f64) -> f64 {
        let ceiling = self.display_limit.min(self.script_len);
        let age = (t_audio_ms - self.evidence_audio_ms).max(0.0);
        let onset = self.pause_onset_ms.min(self.max_prediction_ms);
        // How far through the settle onto a pause this snapshot is. Computed
        // before the zero-rate branch because the MARGIN below depends on it
        // and the margin has to be applied whether or not there is a lead.
        let settle = smoothstep((age - (onset + self.lead_hold_ms)) / self.lead_decay_ms.max(1.0));
        // Caution as a distance, not as a reduced speed — see
        // `AlignmentConfig::lead_margin_atoms`. Fades out through the settle, so
        // a display that has come to rest rests ON the last word heard rather
        // than a word short of it.
        let margin = self.lead_margin_atoms * (1.0 - settle);
        if self.rate <= 0.0 {
            // The margin still applies. Returning bare `observed` here — which
            // is what this branch used to do — put a STEP in the reference at
            // every Following→Holding transition: the positive-rate path below
            // answers `observed - margin` at zero lead, so dropping the margin
            // moved the target forward by the whole margin in one frame, in the
            // one direction that is never safe, at the exact moment the engine
            // had decided it was no longer sure enough to extrapolate.
            return (self.observed - margin).clamp(0.0, ceiling.max(0.0));
        }
        // While evidence is fresh the lead grows 1:1 — that is pipeline-lag
        // compensation, not a guess about the future: the words are already
        // said, the recogniser has simply not finished saying so. It eases into
        // a plateau at `onset` rather than arriving there at full speed, holds,
        // and then eases back so the display rests on the last word actually
        // heard.
        //
        // The easing is the point. The previous profile turned at `onset` with
        // a slope that flipped from +rate to −rate in one sample: a velocity
        // step of twice the reading pace, at a moment the reader cannot
        // predict. Worse, the display CANNOT follow the descending limb —
        // ordinary following never moves backward — so the whole descent was
        // spent parked. Both halves of that read as a jerk.
        let rise = soft_min(age, onset, self.lead_ease_ms);
        let floor_ms = self.lead_floor_ms.min(onset);
        let lead_ms = rise * (1.0 - settle) + floor_ms * settle;
        // The rate estimate is the weak link — it is a median of recent
        // slopes, and a reader who slows down invalidates it silently. Capping
        // the lead in ATOMS bounds the damage directly instead of trusting the
        // estimate to stay honest.
        //
        // Approached softly, for the same reason: a hard `min()` here meant the
        // display travelled at full pace right up to the cap and then stopped
        // in a single frame. Measured, that one clip put the display at a
        // standstill for 19.7% of speaking time as soon as the pace estimate
        // was honest enough to reach it. The bound is unchanged — the display
        // still never leads by more than `max_lead_atoms` — it is now arrived
        // at by decelerating rather than by hitting a wall.
        let lead = soft_min(
            self.rate * lead_ms / 1000.0,
            self.max_lead_atoms,
            // The cap is in atoms; scale the knee into the same axis so one
            // config value shapes both limits consistently.
            self.rate * self.lead_ease_ms / 1000.0,
        );
        // Clamped into the script at BOTH ends. The margin can carry the
        // display behind `observed`, which is safe and deliberate, but near the
        // start of a script it can carry it behind the script itself — and a
        // negative position still reaches `lastDisplayToken`, the active-token
        // lookup and the benchmark before the plant's own bounds clamp the
        // pixels.
        (self.observed + lead - margin).clamp(0.0, ceiling.max(0.0))
    }
}

/// Hermite smoothstep, clamped: 0 below 0, 1 above 1, and zero slope at both
/// ends so a transition through it adds no velocity step.
pub(crate) fn smoothstep(u: f64) -> f64 {
    let u = u.clamp(0.0, 1.0);
    u * u * (3.0 - 2.0 * u)
}

///
/// Equal to `a` well below the cap, asymptotic to the cap above it, and
/// differentiable at every point between — which is the whole reason it exists.
/// `ease <= 0` returns the exact hard minimum, so every limit in this file can
/// be restored to its previous behaviour by zeroing one config value.
/// `a.min(cap)`, with the corner rounded off over a knee of width `ease`.
pub(crate) fn soft_min(a: f64, cap: f64, ease: f64) -> f64 {
    if !(ease > 0.0) || !cap.is_finite() || !a.is_finite() {
        return a.min(cap);
    }
    // The knee may never be wider than the cap it rounds. `soft_min` is exact
    // below `cap - ease`, so an `ease` larger than `cap` puts the exact region
    // entirely below zero and the knee straddles the origin: with
    // `max_lead_atoms = 0` — a legitimate "no lead at all" configuration that
    // passes every check in `config.rs` — a 1.26-atom knee returned −0.315,
    // turning the lead OFF into a lead BACKWARD. Config sanitisation checks
    // fields one at a time and cannot see a cross-field relationship like this,
    // so the function defends its own domain.
    let ease = ease.min(cap.abs() * 0.5);
    if !(ease > 0.0) {
        return a.min(cap);
    }
    // The knee is confined to `cap ± ease` and the function is EXACT outside
    // it. That matters more than it looks: the first version of this used a
    // softplus, which is asymptotic rather than exact and therefore wrong
    // everywhere — at a cap-to-knee ratio of 2 it returned −12.7% of the cap
    // where it should have returned zero, so with a 900 ms horizon and a 450 ms
    // knee the lead came out at −57 ms at zero evidence age and the display sat
    // a fifth of a word BEHIND the word just reported. Widening the ratio only
    // shrank the error; it never removed it.
    //
    // The quadratic below matches value and slope at `cap - ease` (slope 1) and
    // at `cap + ease` (slope 0, value `cap`), so it is C¹ across the whole
    // range and identical to `min` outside the knee.
    let lo = cap - ease;
    if a <= lo {
        return a;
    }
    if a >= cap + ease {
        return cap;
    }
    let u = (a - lo) / (2.0 * ease);
    lo + 2.0 * ease * (u - u * u / 2.0)
}


#[derive(Debug, Clone)]
struct Candidate {
    evidence: Evidence,
    score: f64,
    /// Distance (atoms) from the OBSERVED position — the prediction can
    /// drift ahead during a stall, and classifying against it once turned
    /// the stale local candidate into a phantom "backward retake".
    /// f64::INFINITY when the tracker has no lock.
    distance: f64,
    backward: bool,
    /// True when this candidate came from phase-2 global search (aligned on
    /// the unexplained suffix). Only these may propose discontinuities.
    from_global: bool,
    /// The distance penalty included in `score`. Gate margins compare
    /// EVIDENCE (score + penalty), otherwise a legitimate 4000-atom
    /// relocation can never out-margin nearby junk matches.
    jump_penalty: f64,
}

#[derive(Debug, Clone)]
struct PendingJump {
    target: u32,
    count: u8,
}

/// What a discontinuity evaluation concluded.
enum DiscontinuityOutcome {
    Accepted(Snapshot),
    /// Plausible target accumulating persistence; display should not chase
    /// it yet.
    Pending,
    Rejected,
}

pub struct Engine {
    pub script: CompiledScript,
    pub config: AlignmentConfig,
    ledger: Ledger,
    scratch: AlignScratch,
    seq: u64,

    state: TrackingState,
    confirmed: f64,
    observed: f64,
    /// (audio_ms, position) anchors from accepted local updates.
    rate_anchors: Vec<(f64, f64)>,
    rate: f64,
    last_evidence_ms: f64,
    confidence: f64,
    pending_jump: Option<PendingJump>,
    viewport: Option<(u32, u32)>,
    /// Consecutive events with weak local evidence — the trigger for global
    /// search (spec §9.5: global proposals only when local evidence fails).
    weak_streak: u32,
    /// Approximate-only local continuations since the last exact-content
    /// update. This is deliberately not inferred from `weak_streak`: a valid
    /// one-word bridge is healthy enough to keep motion alive, but not strong
    /// enough to authorize another guess.
    approximate_streak: u8,
    /// Reversible dim-only frontier. Kept out of `observed` and `confirmed` so
    /// a mistaken spelling inference can be withdrawn without rewinding the
    /// semantic tracker or the document.
    provisional: Option<f64>,
    provisional_retracted: bool,
    /// Evidence older than this is dead: it was spoken before the last
    /// accepted discontinuity (or manual move) and would otherwise keep
    /// out-voting the new location in the full-tail alignment — the failure
    /// mode where an accepted retake snapped straight back.
    tail_horizon_ms: f64,
    /// Region scratch reused across events.
    regions: Vec<(u32, u32)>,
}

impl Engine {
    pub fn new(script: CompiledScript, config: AlignmentConfig) -> Self {
        let config = config.sanitized();
        let rate_default = config.rate_default;
        Self {
            script,
            config,
            ledger: Ledger::default(),
            scratch: AlignScratch::new(),
            seq: 0,
            state: TrackingState::Searching,
            confirmed: 0.0,
            observed: 0.0,
            rate_anchors: Vec::new(),
            rate: rate_default,
            last_evidence_ms: 0.0,
            confidence: 0.0,
            pending_jump: None,
            viewport: None,
            weak_streak: 0,
            approximate_streak: 0,
            provisional: None,
            provisional_retracted: false,
            tail_horizon_ms: f64::MIN,
            regions: Vec::new(),
        }
    }

    /// Tell the tracker what range of atoms the presenter can currently see.
    /// This is the probabilistic "I am reading around here" prior: it biases
    /// candidate ranking and relocation, it never forces a position.
    pub fn set_viewport_hint(&mut self, first_atom: u32, last_atom: u32) {
        self.viewport = Some((first_atom, last_atom.max(first_atom)));
    }

    pub fn clear_viewport_hint(&mut self) {
        self.viewport = None;
    }

    /// Hard user action: "I am here". Resets evidence continuity.
    pub fn set_manual_position(&mut self, atom: u32, at_audio_ms: f64) -> Snapshot {
        let pos = (atom as f64).min(self.script.len() as f64);
        self.confirmed = pos;
        self.observed = pos;
        self.state = TrackingState::Following;
        self.rate_anchors.clear();
        self.rate = self.config.rate_default;
        self.pending_jump = None;
        self.weak_streak = 0;
        self.approximate_streak = 0;
        self.provisional = None;
        self.provisional_retracted = false;
        self.confidence = 0.9;
        self.last_evidence_ms = at_audio_ms;
        // Speech from before the manual move must not drag the cursor back.
        self.tail_horizon_ms = at_audio_ms;
        self.snapshot(DecisionCode::ManualAnchor, at_audio_ms, at_audio_ms)
    }

    pub fn handle(&mut self, event: SessionEvent) -> Snapshot {
        match event {
            SessionEvent::ItemStarted {
                item_id,
                audio_start_ms,
            } => {
                self.ledger.item_started(&item_id, audio_start_ms);
                // speechStarted is real evidence of one thing: the reader
                // is TALKING again. Rebase the evidence clock so the display
                // glides forward from the parked position at reading rate,
                // instead of waiting a full partial-cadence to move — while
                // never leaping (the rebased horizon starts at zero).
                if matches!(self.state, TrackingState::Following) {
                    self.last_evidence_ms = self.last_evidence_ms.max(audio_start_ms);
                }
                self.snapshot(DecisionCode::NoEvidence, self.last_evidence_ms, audio_start_ms)
            }
            SessionEvent::Partial {
                item_id,
                text,
                audio_ms,
            } => {
                // Canonicalised against the script's own vocabulary first, so
                // a name the recogniser split in two arrives as the one word
                // the script wrote. Two statements, not one: the script is
                // borrowed for the atoms, then its interner for the ledger.
                let atoms = self.script.query_words(&text);
                self.ledger.revise_atoms(
                    &mut self.script.interner,
                    &item_id,
                    atoms,
                    false,
                    audio_ms,
                );
                self.update(audio_ms)
            }
            SessionEvent::Final {
                item_id,
                text,
                audio_end_ms,
            } => {
                let atoms = self.script.query_words(&text);
                self.ledger.revise_atoms(
                    &mut self.script.interner,
                    &item_id,
                    atoms,
                    true,
                    audio_end_ms,
                );
                self.update(audio_end_ms)
            }
        }
    }

    // -----------------------------------------------------------------
    // Core update
    // -----------------------------------------------------------------

    fn update(&mut self, now_ms: f64) -> Snapshot {
        let mut query = self.ledger.tail(
            self.config.max_query_atoms,
            self.config.partial_lag_ms,
            self.config.endpoint_lag_ms,
        );
        query.retain(|q| q.audio_ms >= self.tail_horizon_ms);
        if query.is_empty() {
            return self.snapshot(DecisionCode::NoEvidence, self.last_evidence_ms, now_ms);
        }

        let locked = !matches!(self.state, TrackingState::Searching);
        let predicted = if locked {
            // Coasting is bounded: after a long silence the reader is far
            // more likely to be where they stopped than rate*60s ahead —
            // an unbounded dt once centred the local band 170 atoms past
            // the reader after a minute of quiet.
            let dt = ((now_ms - self.config.emission_lag_ms) - self.last_evidence_ms)
                .clamp(0.0, self.config.max_prediction_ms + self.config.coast_ms);
            (self.observed + self.rate * dt / 1000.0).min(self.script.len() as f64)
        } else {
            self.observed
        };
        let len = self.script.len() as u32;

        // ---------------------------------------------------------------
        // Phase 1: local continuity — the full tail against the band
        // around the prediction. This is the every-event hot path.
        // ---------------------------------------------------------------
        let local_region = if locked {
            let p = predicted.max(0.0) as u32;
            Some((p.saturating_sub(self.config.local_back), (p + self.config.local_forward).min(len)))
        } else {
            None
        };
        let observed = self.observed;
        let local_candidate: Option<Candidate> = local_region.and_then(|(start, end)| {
            align(&self.script, &query, start, end, &self.config, &mut self.scratch).and_then(
                |evidence| {
                    if evidence.exact_matches
                        + evidence.fuzzy_matches
                        + evidence.phonetic_matches
                        == 0
                    {
                        return None;
                    }
                    let distance = (evidence.end_position as f64 - observed).abs();
                    let backward = (evidence.end_position as f64) < observed;
                    let (score, jump_penalty) = self.rank(&evidence, predicted, locked);
                    Some(Candidate {
                        evidence,
                        score,
                        distance,
                        backward,
                        from_global: false,
                        jump_penalty,
                    })
                },
            )
        });

        // How much of the tail does the local explanation actually cover?
        // Everything after the last local match is UNEXPLAINED — the material
        // a skip, retake or ad-lib is made of. This is what discontinuity
        // evaluation aligns, so a jump's fidelity is not diluted by pre-jump
        // words (the failure that made baseline recovery take 20+ seconds).
        let unexplained_start = if locked {
            local_candidate
                .as_ref()
                .and_then(|c| {
                    // Solid runs only: one stray stopword match must not
                    // mark everything after it as explained. If the local
                    // path has no solid run at all, NOTHING is explained.
                    c.evidence.last_solid_match_query_index
                })
                .map(|i| i + 1)
                .unwrap_or(0)
        } else {
            0
        };
        let unexplained: &[QueryAtom] = &query[unexplained_start.min(query.len())..];
        let unexplained_content = unexplained
            .iter()
            .filter(|q| !q.filler && !q.stopword)
            .count();

        let ordinary_local_ok = local_candidate
            .as_ref()
            .map(|c| {
                c.evidence.fidelity >= self.config.observe_min_fidelity
                    && c.evidence.coverage >= self.config.observe_min_coverage
                    && c.evidence.content_matches >= self.config.observe_min_content
            })
            .unwrap_or(false);
        let approximate_local_ok = local_candidate
            .as_ref()
            .is_some_and(|candidate| self.can_bridge_local_approx(candidate, predicted));
        let local_ok = ordinary_local_ok || approximate_local_ok;
        // Weakness: gates failed, OR enough content went unexplained, OR a
        // long ordered run of anything (stopword-heavy scripts would starve
        // the content counter for seconds otherwise).
        let weak = !local_ok
            || unexplained_content >= self.config.weak_unexplained_content
            || unexplained.len() >= self.config.weak_unexplained_total;
        if weak {
            self.weak_streak = self.weak_streak.saturating_add(1);
            // Honesty: persistent weakness means we no longer know where the
            // reader is. Claiming `Following` here is exactly the
            // "confidently wrong" state the catastrophic metric punishes —
            // hold the display instead.
            if self.weak_streak >= 3 && matches!(self.state, TrackingState::Following) {
                self.state = TrackingState::Holding;
            }
        } else {
            self.weak_streak = 0;
            // Healthy local evidence: any distant target that was
            // accumulating persistence was a false alarm. Without this, a
            // stale count survives arbitrarily many good revisions and a
            // later unrelated candidate inherits it.
            self.pending_jump = None;
        }

        // ---------------------------------------------------------------
        // Phase 2: global search — only when something is actually wrong
        // (or there is no lock / a jump is pending / a viewport hint
        // exists). Keeping this off the healthy path is what makes cost
        // independent of script length.
        // ---------------------------------------------------------------
        let need_global = !locked
            || self.weak_streak >= 1
            || self.pending_jump.is_some()
            || self.viewport.is_some();

        let mut candidates: Vec<Candidate> = Vec::new();
        if let Some(c) = local_candidate.clone() {
            candidates.push(c);
        }

        // The query used for global candidates: the unexplained material
        // when locked (min length gated), the whole tail when searching.
        let global_query: &[QueryAtom] = if locked { unexplained } else { &query[..] };
        let global_query_ready = if locked {
            global_query.len() >= self.config.jump_query_min
        } else {
            !global_query.is_empty()
        };
        let mut local_suffix_score = f64::MIN;

        if need_global && global_query_ready {
            self.build_global_regions(global_query, locked, local_region);
            // Desperate fallback: evidence keeps failing — the anchors may
            // be proposing nothing, or proposing only junk (generated or
            // repetitive text can lack rare n-grams entirely). Cover the
            // whole script in WINDOWS rather than one region: each window
            // yields its own candidate, so near-duplicate passages become
            // visible as rival clusters and the ambiguity gate can hold
            // honestly instead of accepting the first lookalike.
            if self.weak_streak >= self.config.desperate_search_after {
                let window = 640u32;
                let stride = 600u32;
                let mut start = 0u32;
                loop {
                    self.regions.push((start, (start + window).min(len)));
                    if start + window >= len {
                        break;
                    }
                    start += stride;
                }
            }
            let regions = std::mem::take(&mut self.regions);
            for &(start, end) in &regions {
                if let Some(evidence) = align(
                    &self.script,
                    global_query,
                    start,
                    end,
                    &self.config,
                    &mut self.scratch,
                ) {
                    if evidence.exact_matches + evidence.fuzzy_matches == 0 {
                        continue;
                    }
                    let distance = if locked {
                        (evidence.end_position as f64 - observed).abs()
                    } else {
                        f64::INFINITY
                    };
                    let backward = (evidence.end_position as f64) < observed;
                    let (score, jump_penalty) = self.rank(&evidence, predicted, locked);
                    candidates.push(Candidate {
                        evidence,
                        score,
                        distance,
                        backward,
                        from_global: true,
                        jump_penalty,
                    });
                }
            }
            self.regions = regions;

            // Fair comparison for jump margins: "could the unexplained words
            // be explained at or AHEAD of the current position?" — scored on
            // the same query. Forward-only on purpose: a backward retake must
            // not be allowed to out-compete itself through this band.
            if locked && !global_query.is_empty() {
                let p = predicted.max(0.0) as u32;
                let start = p.saturating_sub(6);
                // Band edge == the discontinuity threshold: "continuing"
                // means within the same distance that makes a candidate
                // local. Wider, and a 50-atom skip's own evidence would veto
                // the skip through this comparison.
                let end = (p + self.config.discontinuity_atoms).min(len);
                if let Some(ev) = align(
                    &self.script,
                    global_query,
                    start,
                    end,
                    &self.config,
                    &mut self.scratch,
                ) {
                    local_suffix_score = self.rank(&ev, predicted, locked).0;
                }
            }
        }

        if candidates.is_empty() {
            return self.hold(DecisionCode::HoldLowEvidence, now_ms);
        }

        // Cluster by end position; keep the best per cluster, sorted by score.
        candidates.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.evidence.end_position.cmp(&b.evidence.end_position))
        });
        let mut clusters: Vec<Candidate> = Vec::new();
        for c in candidates {
            let dup = clusters.iter().any(|k| {
                (k.evidence.end_position as i64 - c.evidence.end_position as i64).unsigned_abs()
                    <= self.config.cluster_radius as u64
            });
            if !dup {
                clusters.push(c);
            }
            if clusters.len() >= self.config.beam_size {
                break;
            }
        }

        if !locked {
            let best = clusters[0].clone();
            let competitor = clusters
                .iter()
                .skip(1)
                .find(|c| {
                    (c.evidence.end_position as i64 - best.evidence.end_position as i64)
                        .unsigned_abs()
                        > self.config.discontinuity_atoms as u64
                })
                .cloned();
            let margin = competitor
                .as_ref()
                .map(|c| best.score - c.score)
                .unwrap_or(f64::INFINITY);
            return self.decide_relocation(best, margin, now_ms);
        }

        // Locked: try a discontinuity first if a distant cluster exists,
        // otherwise (or if it is merely pending) fall back to local.
        // Backward moves beyond a few atoms are ALWAYS discontinuities —
        // a monotonic alignment path cannot represent re-reading earlier
        // text, however close it is.
        let is_distant = |c: &Candidate| {
            c.from_global
                && (c.distance > self.config.discontinuity_atoms as f64
                    || (c.backward && c.distance > 6.0))
        };
        let best_distant = clusters.iter().find(|c| is_distant(c)).cloned();
        if std::env::var("CC_ALIGN_DEBUG").is_ok() {
            eprintln!(
                "t={now_ms:.0} pred={predicted:.1} unexpl_start={unexplained_start} unexpl_content={unexplained_content} weak={} local_ok={local_ok} local_end={:?} clusters={:?}",
                self.weak_streak,
                local_candidate.as_ref().map(|c| c.evidence.end_position),
                clusters
                    .iter()
                    .map(|c| (c.evidence.end_position, (c.score * 100.0) as i64, c.backward))
                    .collect::<Vec<_>>()
            );
        }
        if let Some(distant) = best_distant {
            // Ambiguity among distant targets (duplicate passages): the best
            // distant cluster must clearly beat the next distant cluster.
            let distant_rivals_gap = clusters
                .iter()
                .filter(|c| {
                    is_distant(c)
                        && (c.evidence.end_position as i64
                            - distant.evidence.end_position as i64)
                            .unsigned_abs()
                            > self.config.cluster_radius as u64 * 4
                })
                .map(|c| (distant.score + distant.jump_penalty) - (c.score + c.jump_penalty))
                .fold(f64::INFINITY, f64::min);
            let discontinuity_horizon = global_query.first().map(|q| q.audio_ms - 1.0);
            match self.try_discontinuity(
                &distant,
                local_suffix_score,
                distant_rivals_gap,
                discontinuity_horizon,
                now_ms,
            ) {
                DiscontinuityOutcome::Accepted(snapshot) => return snapshot,
                DiscontinuityOutcome::Pending => {
                    if !local_ok {
                        self.confidence = (self.confidence * 0.85).max(0.05);
                        return self.snapshot(
                            DecisionCode::JumpPending,
                            self.last_evidence_ms,
                            now_ms,
                        );
                    }
                    // A healthy local explanation continues below.
                }
                DiscontinuityOutcome::Rejected => {}
            }
        }

        // Phase-2 is also allowed to reconnect *inside* the continuity band.
        // This matters after a locally mangled span (proper names, figures,
        // acronyms): the full tail can remain attached to an old prefix while
        // the unexplained suffix already has a strong, current match a dozen
        // words ahead. Previously those suffix candidates were generated and
        // ranked, then discarded solely because they were not far enough to
        // count as a discontinuity.
        let nearby_suffix = if self.weak_streak > 0 {
            clusters
                .iter()
                .filter(|candidate| {
                    candidate.from_global
                        && candidate.distance <= self.config.discontinuity_atoms as f64
                        && !(candidate.backward && candidate.distance > 6.0)
                        && candidate.evidence.end_position as f64 > self.observed + 1.0
                        && candidate.evidence.fidelity >= self.config.observe_min_fidelity
                        && candidate.evidence.coverage >= self.config.observe_min_coverage
                        && candidate.evidence.content_matches >= self.config.observe_min_content
                })
                .max_by(|a, b| {
                    a.evidence
                        .end_position
                        .cmp(&b.evidence.end_position)
                        .then_with(|| {
                            a.score
                                .partial_cmp(&b.score)
                                .unwrap_or(std::cmp::Ordering::Equal)
                        })
                })
                .cloned()
        } else {
            None
        };
        let local_choice = nearby_suffix.or(local_candidate);

        match local_choice {
            // A phase-1 result far from the observed position (possible with
            // a very short tail and the band's free start) is a relocation
            // claim, and relocation claims go through the discontinuity
            // machinery — never through the cheap local gate.
            Some(local)
                if local.distance <= self.config.discontinuity_atoms as f64
                    && !(local.backward && local.distance > 6.0) =>
            {
                // A candidate can pass the aggregate fidelity/coverage gates
                // indefinitely by re-matching an old solid prefix while a
                // growing, unrecognised suffix accumulates after it. Calling
                // that "Following" is confidently wrong: the display has not
                // moved and the new speech has not been explained. Preserve
                // the honest hold after persistent weakness until local
                // evidence actually advances or a discontinuity is accepted.
                if self.weak_streak >= 3
                    && local.evidence.end_position as f64 <= self.observed + 1.0
                {
                    self.hold(DecisionCode::HoldLowEvidence, now_ms)
                } else {
                    self.decide_local(local, f64::INFINITY, predicted, now_ms)
                }
            }
            _ => self.hold(DecisionCode::HoldLowEvidence, now_ms),
        }
    }

    fn decide_relocation(&mut self, best: Candidate, margin: f64, now_ms: f64) -> Snapshot {
        let ev = &best.evidence;
        let c = &self.config;
        let viewport_agrees = self
            .viewport
            .map(|(lo, hi)| ev.end_position >= lo.saturating_sub(8) && ev.end_position <= hi + 8)
            .unwrap_or(false);
        // The viewport lowers the ambiguity bar (the presenter scrolled
        // here on purpose) but cannot waive it: two identical passages both
        // inside the visible range are still ambiguous.
        let required_margin = if viewport_agrees {
            c.ambiguity_margin * 0.4
        } else {
            c.ambiguity_margin
        };
        let enough = ev.fidelity >= c.jump_min_fidelity
            && ev.content_matches >= c.relocation_min_content
            && margin >= required_margin;
        if !enough {
            self.confidence = (self.confidence * 0.8).max(0.05);
            let code = if margin < c.ambiguity_margin {
                DecisionCode::HoldAmbiguous
            } else {
                DecisionCode::HoldLowEvidence
            };
            return self.snapshot(code, self.last_evidence_ms, now_ms);
        }
        let evidence_ms = self.evidence_time(ev, now_ms);
        self.accept(ev.end_position as f64, evidence_ms, true);
        self.state = TrackingState::Following;
        self.confidence = confidence_of(ev, margin);
        self.snapshot(DecisionCode::RelocationAccepted, evidence_ms, now_ms)
    }

    fn decide_local(
        &mut self,
        best: Candidate,
        margin: f64,
        predicted: f64,
        now_ms: f64,
    ) -> Snapshot {
        let c = self.config.clone();
        let ev = &best.evidence;
        let ambiguous = margin < c.ambiguity_margin;
        if ambiguous {
            self.state = TrackingState::Ambiguous;
            self.confidence = (self.confidence * 0.7).max(0.05);
            return self.snapshot(DecisionCode::HoldAmbiguous, self.last_evidence_ms, now_ms);
        }
        let ordinary_passes = ev.fidelity >= c.observe_min_fidelity
            && ev.coverage >= c.observe_min_coverage
            && ev.content_matches >= c.observe_min_content;
        let approximate_bridge = !ordinary_passes && self.can_bridge_local_approx(&best, predicted);
        if !ordinary_passes && !approximate_bridge {
            if self.provisional.is_some() && self.is_coherent_approx_chain(&best) {
                // The spelling evidence still points forward in order, but the
                // speculative budget is exhausted. Hold the existing dim
                // frontier; reaching the cap is not evidence that the earlier
                // provisional words were wrong.
                return self.hold_preserving_provisional(DecisionCode::HoldLowEvidence, now_ms);
            }
            // Off-script speech looks exactly like this: insertions dominate.
            let code = if ev.insertions > ev.exact_matches {
                DecisionCode::HoldOffScript
            } else {
                DecisionCode::HoldLowEvidence
            };
            return self.hold(code, now_ms);
        }

        let evidence_ms = self.evidence_time(ev, now_ms);
        if approximate_bridge {
            self.provisional = Some(ev.end_position as f64);
            self.approximate_streak = self.approximate_streak.saturating_add(1);
            self.state = TrackingState::Following;
            // A provisional spelling/phonetic bridge may shade the next word,
            // but it neither moves the sheet nor improves semantic confidence.
            self.confidence = (self.confidence * 0.92).max(0.2);
        } else {
            let target = ev.end_position as f64;
            if self.provisional.is_some_and(|p| target < p) {
                self.provisional_retracted = true;
            }
            self.provisional = None;
            self.approximate_streak = 0;
            self.accept(target, evidence_ms, false);
            self.state = TrackingState::Following;
            self.confidence = confidence_of(ev, margin);
        }

        // Confirmed advancement: finals confirm outright; partials confirm
        // when enough *stable* content matched, and only up to the stable
        // portion of the evidence.
        let is_final_evidence = self
            .ledger
            .current_item()
            .map(|i| i.is_final)
            .unwrap_or(false);
        let mut decision = DecisionCode::LocalObserved;
        if !approximate_bridge && ev.fidelity >= c.confirm_min_fidelity {
            let target = if is_final_evidence {
                Some(ev.end_position as f64)
            } else if ev.stable_content_matches >= c.confirm_min_stable_content {
                Some(ev.stable_end_position as f64)
            } else {
                None
            };
            if let Some(t) = target {
                if t > self.confirmed {
                    self.confirmed = t;
                    decision = DecisionCode::LocalConfirmed;
                }
            }
        }
        self.snapshot(decision, evidence_ms, now_ms)
    }

    /// May one close spelling/sound stand in for the immediately expected
    /// script word?
    ///
    /// This is intentionally much narrower than ordinary local alignment:
    /// one new approximate content relation per step, no unexplained transcript
    /// or skipped script material, forward by about one word, near the pace
    /// prediction, and only from an already-confident Following lock. It
    /// updates only the reversible dim frontier; never `observed`, `confirmed`,
    /// cold acquisition, or discontinuity authority.
    /// How far prediction may carry the display from where the reader was last
    /// heard — the sentence they are audibly in, or the paragraph when the
    /// finer rule is switched off for comparison.
    ///
    /// Both places that need the answer read it here rather than asking the
    /// script directly, so the reversible dim frontier and the display's hard
    /// limit can never end up obeying two different rules.
    fn prediction_ceiling(&self) -> f64 {
        if self.config.sentence_prediction_ceiling {
            self.script.prediction_ceiling(self.observed)
        } else {
            self.script.paragraph_ceiling(self.observed)
        }
    }

    fn can_bridge_local_approx(&self, candidate: &Candidate, predicted: f64) -> bool {
        let ev = &candidate.evidence;
        let c = &self.config;
        let frontier = self.provisional.unwrap_or(self.observed);
        matches!(self.state, TrackingState::Following)
            && self.confidence >= c.local_approx_min_confidence
            && self.approximate_streak < c.local_approx_max_consecutive
            && !candidate.backward
            && self.is_coherent_approx_chain(candidate)
            && ev.end_position as f64 > frontier
            && ev.end_position as f64 - frontier <= c.local_approx_max_step
            && ev.end_position as f64 - self.observed <= c.local_approx_max_advance
            && ev.end_position as f64 <= self.prediction_ceiling()
            && (ev.end_position as f64 - predicted).abs() <= c.local_approx_prediction_slack
            && ev.fidelity >= c.observe_min_fidelity
            && ev.coverage >= c.observe_min_coverage
            && ev.content_matches == 0
            && ev.approximate_content_matches == u32::from(self.approximate_streak) + 1
    }

    fn is_coherent_approx_chain(&self, candidate: &Candidate) -> bool {
        let ev = &candidate.evidence;
        !candidate.from_global
            && ev.content_matches == 0
            && ev.approximate_content_matches > 0
            && ev.approximate_content_matches == ev.fuzzy_matches + ev.phonetic_matches
            && ev.substitutions == 0
            && ev.insertions == 0
            && ev.deletions == 0
    }

    /// Evaluate a distant candidate scored on the unexplained suffix.
    ///
    /// `local_suffix_score` is the local band aligned with the SAME suffix —
    /// the honest "could this still be explained locally?" comparison.
    /// `distant_rivals_gap` is the margin to the next distant cluster
    /// (duplicate-passage protection).
    fn try_discontinuity(
        &mut self,
        best: &Candidate,
        local_suffix_score: f64,
        distant_rivals_gap: f64,
        horizon_ms: Option<f64>,
        now_ms: f64,
    ) -> DiscontinuityOutcome {
        let c = self.config.clone();
        let ev = &best.evidence;
        let needed_content = if best.backward {
            c.jump_min_content + c.retake_extra_content
        } else {
            c.jump_min_content
        };
        // Evidence-only margin: add the distance penalty back. The penalty
        // orders candidates; it must not make a far-but-correct relocation
        // permanently lose to nearby junk.
        let evidence_score = best.score + best.jump_penalty;
        let strong = ev.fidelity >= c.jump_min_fidelity
            && ev.content_matches >= needed_content
            && evidence_score - local_suffix_score >= c.jump_margin
            && distant_rivals_gap >= c.ambiguity_margin;

        if !strong {
            // Not evidence enough to even consider — clear any stale pending
            // target so an unrelated later fluctuation doesn't inherit its
            // persistence count.
            if ev.content_matches < 2 {
                self.pending_jump = None;
            }
            return DiscontinuityOutcome::Rejected;
        }

        // Persistence: the same distant target must win on consecutive
        // revisions before the display moves. A final with strong evidence
        // may jump immediately.
        let is_final_evidence = self
            .ledger
            .current_item()
            .map(|i| i.is_final)
            .unwrap_or(false);
        let target = ev.end_position;
        let matches_pending = self
            .pending_jump
            .as_ref()
            .map(|p| {
                // The target advances as the reader keeps speaking, so the
                // window is forgiving in the direction of travel.
                (p.target as i64 - target as i64).unsigned_abs()
                    <= (c.cluster_radius as u64) * 4
            })
            .unwrap_or(false);
        let count = if matches_pending {
            self.pending_jump.as_ref().map(|p| p.count).unwrap_or(0) + 1
        } else {
            1
        };

        // "Automatic micro-following, manual macro-navigation": a far target
        // the presenter cannot even SEE demands one extra round of evidence.
        // If they scrolled there, the viewport agrees and no extra round is
        // charged.
        let mut required = c.jump_persistence;
        if let Some((lo, hi)) = self.viewport {
            let outside = target < lo.saturating_sub(16) || target > hi + 16;
            if outside {
                required = required.saturating_add(1);
            }
        }

        if count < required && !is_final_evidence {
            self.pending_jump = Some(PendingJump { target, count });
            return DiscontinuityOutcome::Pending;
        }

        // Accepted.
        let backward = best.backward;
        self.pending_jump = None;
        self.weak_streak = 0;
        // Evidence from before the discontinuity is dead — without this the
        // next full-tail alignment out-votes the jump and snaps back.
        if let Some(h) = horizon_ms {
            self.tail_horizon_ms = self.tail_horizon_ms.max(h);
        }
        let evidence_ms = self.evidence_time(ev, now_ms);
        self.accept(target as f64, evidence_ms, true);
        self.state = TrackingState::Following;
        self.confidence = confidence_of(ev, evidence_score - local_suffix_score);
        let snapshot = if backward {
            // A retake re-reads earlier text: confirmed must follow backward,
            // or every subsequent confirm would be capped at the old position.
            self.confirmed = self.confirmed.min(target as f64);
            self.snapshot(DecisionCode::RetakeAccepted, evidence_ms, now_ms)
        } else {
            self.snapshot(DecisionCode::JumpForwardAccepted, evidence_ms, now_ms)
        };
        DiscontinuityOutcome::Accepted(snapshot)
    }

    // -----------------------------------------------------------------
    // Candidate regions
    // -----------------------------------------------------------------

    /// Global candidate regions from the (unexplained) evidence: viewport
    /// prior, script start (while searching), and anchor postings. The local
    /// band is excluded — phase 1 already owns it.
    fn build_global_regions(
        &mut self,
        query: &[QueryAtom],
        locked: bool,
        local_region: Option<(u32, u32)>,
    ) {
        let c = &self.config;
        let len = self.script.len() as u32;
        self.regions.clear();

        // 1. Viewport prior region.
        if let Some((lo, hi)) = self.viewport {
            let start = lo.saturating_sub(c.global_region / 4).min(len);
            let end = (hi + c.global_region / 4).min(len);
            if end > start {
                self.regions.push((start, end));
            }
        }

        // 2. Session start region while searching: presenters usually begin
        // at the top.
        if !locked {
            self.regions.push((0, c.global_region.min(len)));
        }

        // 3. Retake corridor: recently-read territory behind the cursor.
        // Presenters re-say things they already said far more often than
        // they quote distant text, and the re-read words need no rare
        // anchors to be findable here (research: repetition arcs are the
        // single largest robust-alignment win).
        if locked {
            let anchor = self.observed.max(0.0) as u32;
            let start = anchor.saturating_sub(c.retake_corridor_atoms);
            let end = anchor.saturating_sub(4).min(len);
            if end > start {
                self.regions.push((start, end));
            }
        }

        // 4. Anchor-proposed regions. Trailing-provisional atoms are
        // excluded (they flicker); interior-provisional ones may PROPOSE a
        // region — acceptance gates still require persistent evidence, and
        // waiting for full stability would add a whole partial-cadence of
        // recovery latency.
        let stable: Vec<&QueryAtom> = query
            .iter()
            .filter(|q| {
                !matches!(q.stability, crate::ledger::StabilityClass::TrailingProvisional)
                    && !q.filler
            })
            .collect();
        let mut keys_used = 0usize;

        // Trigrams then bigrams over consecutive stable atoms, newest first.
        for window in [3usize, 2] {
            if stable.len() < window {
                continue;
            }
            for i in (0..=stable.len() - window).rev() {
                if keys_used >= c.max_anchor_keys {
                    break;
                }
                let ids: Vec<u32> = stable[i..i + window].iter().map(|q| q.id).collect();
                let postings = match window {
                    3 => self
                        .script
                        .trigram_postings
                        .get(&(ids[0], ids[1], ids[2]))
                        .cloned(),
                    _ => self.script.bigram_postings.get(&(ids[0], ids[1])).cloned(),
                };
                if let Some(postings) = postings {
                    keys_used += 1;
                    for &p in postings.iter().take(c.max_postings_per_key) {
                        let start = p.saturating_sub(8);
                        let end = (start + c.global_region).min(len);
                        self.regions.push((start, end));
                    }
                }
            }
        }
        let _ = local_region;

        // Single rare-token anchors, newest first.
        for q in stable.iter().rev() {
            if keys_used >= c.max_anchor_keys {
                break;
            }
            if let Some(postings) = self.script.token_postings.get(&q.id) {
                let is_anchor = postings
                    .first()
                    .map(|&p| self.script.atoms[p as usize].flags & FLAG_ANCHOR != 0)
                    .unwrap_or(false);
                if !is_anchor {
                    continue;
                }
                keys_used += 1;
                for &p in postings.iter().take(c.max_postings_per_key) {
                    let start = p.saturating_sub(8);
                    let end = (start + c.global_region).min(len);
                    self.regions.push((start, end));
                }
            }
        }

        // Merge overlapping/nearby regions, cap the count. Earlier entries
        // (local, viewport) have priority.
        let slack = c.region_merge_slack;
        let mut merged: Vec<(u32, u32)> = Vec::new();
        for &(s, e) in self.regions.iter() {
            if let Some(existing) = merged
                .iter_mut()
                .find(|(ms, me)| s <= me.saturating_add(slack) && *ms <= e.saturating_add(slack))
            {
                existing.0 = existing.0.min(s);
                existing.1 = existing.1.max(e);
            } else if merged.len() < c.max_regions {
                merged.push((s, e));
            }
        }
        self.regions = merged;
    }

    // -----------------------------------------------------------------
    // Ranking and bookkeeping
    // -----------------------------------------------------------------

    /// Rank a candidate. Returns (score, jump_penalty): the score includes
    /// the distance prior; gate margins add the penalty back so evidence is
    /// compared with evidence.
    fn rank(&self, ev: &Evidence, predicted: f64, locked: bool) -> (f64, f64) {
        let c = &self.config;
        let mut score = c.rank_w_fidelity * ev.fidelity
            + c.rank_w_coverage * ev.coverage
            + c.rank_w_matched_weight * (1.0 + ev.matched_stable_weight / 1000.0).ln()
            + c.rank_w_run * (1.0 + ev.longest_run as f64).ln();

        let mut jump_penalty = 0.0;
        if locked {
            let d = (ev.end_position as f64 - predicted).abs();
            let band = c.discontinuity_atoms as f64;
            if d > band {
                let mut penalty = c.rank_w_jump * (1.0 + d - band).ln();
                if (ev.end_position as f64) < predicted {
                    penalty *= c.rank_backward_factor;
                }
                score -= penalty;
                jump_penalty = penalty;
            }
        }

        if let Some((lo, hi)) = self.viewport {
            let center = (lo + hi) as f64 / 2.0;
            let d = ev.end_position as f64 - center;
            score += c.viewport_bonus * (-0.5 * (d / c.viewport_sigma).powi(2)).exp();
        }
        (score, jump_penalty)
    }

    /// Apply an accepted position: update observed, rate anchors, timing.
    fn accept(&mut self, position: f64, evidence_ms: f64, discontinuity: bool) {
        if discontinuity {
            self.rate_anchors.clear();
            self.rate = self.config.rate_default;
        } else if evidence_ms > self.last_evidence_ms {
            self.rate_anchors.push((evidence_ms, position));
            if self.rate_anchors.len() > 8 {
                self.rate_anchors.remove(0);
            }
            self.rate = self.estimate_rate();
        }
        self.observed = position;
        // Re-interpolated word times can move slightly backward between
        // revisions; the evidence clock must not (it drives prediction).
        if discontinuity {
            self.last_evidence_ms = evidence_ms;
        } else {
            self.last_evidence_ms = self.last_evidence_ms.max(evidence_ms);
        }
    }

    /// Weighted-median pairwise slope over recent anchors (robust to one bad
    /// anchor in a way an EWMA is not).
    fn estimate_rate(&self) -> f64 {
        let a = &self.rate_anchors;
        if a.len() < 2 {
            return self.config.rate_default;
        }
        let mut slopes: Vec<f64> = Vec::new();
        for i in 0..a.len() {
            for j in (i + 1)..a.len() {
                let dt = a[j].0 - a[i].0;
                if dt >= 400.0 {
                    slopes.push(((a[j].1 - a[i].1) * 1000.0 / dt).max(0.0));
                }
            }
        }
        if slopes.is_empty() {
            return self.config.rate_default;
        }
        slopes.sort_by(|x, y| x.partial_cmp(y).unwrap_or(std::cmp::Ordering::Equal));
        let median = slopes[slopes.len() / 2];
        median.clamp(self.config.rate_min, self.config.rate_max)
    }

    /// When was the last matched word actually spoken? The audio clock counts
    /// bytes *sent*; the recogniser lags behind it. Subtracting the measured
    /// emission lag stops the display from placing "now" a second in the past.
    fn evidence_time(&self, ev: &Evidence, now_ms: f64) -> f64 {
        let raw = if ev.last_match_query_index.is_some() {
            ev.last_match_audio_ms
        } else {
            now_ms
        };
        (raw - self.config.emission_lag_ms).clamp(0.0, now_ms)
    }

    fn hold(&mut self, code: DecisionCode, now_ms: f64) -> Snapshot {
        if self.provisional.take().is_some() {
            self.provisional_retracted = true;
            self.approximate_streak = 0;
        }
        if !matches!(self.state, TrackingState::Searching) {
            self.state = TrackingState::Holding;
        }
        self.confidence = (self.confidence * 0.8).max(0.05);
        self.snapshot(code, self.last_evidence_ms, now_ms)
    }

    fn hold_preserving_provisional(
        &mut self,
        code: DecisionCode,
        now_ms: f64,
    ) -> Snapshot {
        if !matches!(self.state, TrackingState::Searching) {
            self.state = TrackingState::Holding;
        }
        self.confidence = (self.confidence * 0.8).max(0.05);
        self.snapshot(code, self.last_evidence_ms, now_ms)
    }

    fn snapshot(&mut self, decision: DecisionCode, evidence_ms: f64, now_ms: f64) -> Snapshot {
        self.seq += 1;
        // How stale the evidence is, which is the only honest way to ask
        // whether the reader is still going.
        //
        // This replaced a binary test on the provider's endpoint flag. A final
        // means the provider's VAD decided an utterance ended — but it says so
        // `endpoint_lag_ms` (1.4 s by default) after the last word, and the
        // display's speed was being set to exactly zero on arrival. So every
        // sentence boundary produced a full stop in the motion, ordered by an
        // event describing the past, and the display then had to be
        // accelerated again from rest by the next partial. That is the
        // stop-start the presenter feels most directly.
        //
        // Staleness answers the same question continuously: if the reader has
        // genuinely stopped, no new evidence arrives and this grows on its own.
        // If they are still talking, the next partial resets it and the display
        // never noticed the endpoint at all.
        let stale_ms = (now_ms - self.last_evidence_ms).max(0.0);
        let decay = smoothstep(
            (stale_ms - self.config.rate_hold_ms) / self.config.rate_decay_ms.max(1.0),
        );
        let flowing = decay < 1.0;
        // The gain is applied HERE, on the way out, and not to `self.rate`:
        // the engine's own forward prediction (the local search band) wants the
        // reader's true pace, while the display wants a deliberately cautious
        // one. Conflating them would drag the search band backwards and cost
        // recovery latency to buy display safety, which is not the trade.
        let gain_span =
            (self.config.prediction_gain_fast_rate - self.config.rate_default).max(0.1);
        let fast_mix = ((self.rate - self.config.rate_default) / gain_span).clamp(0.0, 1.0);
        let display_gain = self.config.prediction_gain
            + (self.config.prediction_gain_fast - self.config.prediction_gain) * fast_mix;
        let following = matches!(self.state, TrackingState::Following);
        let rate = match (following, flowing) {
            (true, true) => self.rate * display_gain * (1.0 - decay),
            _ => 0.0,
        };
        let snapshot = Snapshot {
            seq: self.seq,
            state: self.state,
            decision,
            confirmed: self.confirmed,
            observed: self.observed,
            rate,
            evidence_audio_ms: evidence_ms,
            at_audio_ms: now_ms,
            max_prediction_ms: self.config.max_prediction_ms,
            pause_onset_ms: self.config.pause_onset_ms,
            lead_floor_ms: self.config.lead_floor_ms,
            max_lead_atoms: self.config.max_lead_atoms,
            lead_margin_atoms: self.config.lead_margin_atoms,
            lead_ease_ms: self.config.lead_ease_ms,
            lead_hold_ms: self.config.lead_hold_ms,
            lead_decay_ms: self.config.lead_decay_ms,
            display_limit: self.prediction_ceiling(),
            confidence: self.confidence,
            suggestion: self.pending_jump.as_ref().map(|p| p.target as f64),
            provisional: self.provisional,
            provisional_retracted: self.provisional_retracted,
            script_len: self.script.len() as f64,
        };
        self.provisional_retracted = false;
        snapshot
    }
}

fn confidence_of(ev: &Evidence, margin: f64) -> f64 {
    let base = 0.5 * ev.fidelity
        + 0.3 * ev.coverage
        + 0.2 * (ev.stable_content_matches.min(5) as f64 / 5.0);
    let margin_factor = (margin / 2.0).clamp(0.5, 1.0);
    (base * margin_factor).clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::script::{compile, CompileOptions};

    fn final_item(engine: &mut Engine, ordinal: u32, text: &str, at_ms: f64) -> Snapshot {
        engine.handle(SessionEvent::Final {
            item_id: format!("item-{ordinal}"),
            text: text.to_string(),
            audio_end_ms: at_ms,
        })
    }

    fn approximate_script() -> CompiledScript {
        compile(
            "alpha bravo presenter teleprompter harbour narration delta echo foxtrot golf",
            CompileOptions::default(),
        )
    }

    /// The snapshot the stage actually receives carries the sentence ceiling,
    /// and the switch genuinely restores the old one — the two rules have to be
    /// comparable in one binary or a claim about either is unfalsifiable.
    #[test]
    fn the_display_limit_brakes_at_the_sentence_and_the_switch_restores_paragraphs() {
        // One paragraph, two sentences: atoms 0..3 and 3..6.
        let script = compile(
            "alpha bravo charlie. delta echo foxtrot.",
            CompileOptions::default(),
        );
        assert_eq!(script.sentence_end, vec![3, 3, 3, 6, 6, 6]);

        let mut engine = Engine::new(script.clone(), AlignmentConfig::default());
        engine.set_manual_position(1, 0.0);
        let snapshot = final_item(&mut engine, 1, "bravo", 350.0);
        assert!(
            snapshot.observed < 3.0,
            "the reader must still be inside the first sentence: {}",
            snapshot.observed
        );
        // Heard inside the first sentence, the display may reach its last word
        // and stop — `delta` stays lit.
        assert_eq!(snapshot.display_limit, 3.0);

        let paragraph_only = AlignmentConfig {
            sentence_prediction_ceiling: false,
            ..AlignmentConfig::default()
        };
        let mut engine = Engine::new(script, paragraph_only);
        engine.set_manual_position(1, 0.0);
        let snapshot = final_item(&mut engine, 1, "bravo", 350.0);
        assert!(snapshot.observed < 3.0);
        // The rule this replaces: the whole paragraph was fair game from the
        // first word of it.
        assert_eq!(snapshot.display_limit, 6.0);
    }

    #[test]
    fn one_close_local_word_advances_only_the_reversible_frontier() {
        let mut engine = Engine::new(approximate_script(), AlignmentConfig::default());
        engine.set_manual_position(2, 0.0);

        let snapshot = final_item(&mut engine, 1, "presentor", 350.0);

        assert_eq!(snapshot.state, TrackingState::Following);
        assert_eq!(snapshot.provisional, Some(3.0));
        assert_eq!(snapshot.observed, 2.0);
        assert_eq!(snapshot.confirmed, 2.0);
        assert!(!snapshot.provisional_retracted);
    }

    #[test]
    fn approximate_frontier_is_capped_and_does_not_move_the_document() {
        let mut engine = Engine::new(approximate_script(), AlignmentConfig::default());
        engine.set_manual_position(2, 0.0);

        assert_eq!(final_item(&mut engine, 1, "presentor", 350.0).provisional, Some(3.0));
        assert_eq!(
            final_item(&mut engine, 2, "teleprompters", 700.0).provisional,
            Some(4.0),
        );
        assert_eq!(final_item(&mut engine, 3, "harbor", 1_050.0).provisional, Some(5.0));

        // The fourth close spelling is coherent, but the three-word budget is
        // exhausted. Keep the existing frontier and hold rather than drifting.
        let capped = final_item(&mut engine, 4, "naration", 1_400.0);
        assert_eq!(capped.state, TrackingState::Holding);
        assert_eq!(capped.provisional, Some(5.0));
        assert_eq!(capped.observed, 2.0);
        assert_eq!(capped.confirmed, 2.0);
    }

    #[test]
    fn contradictory_text_retracts_the_provisional_frontier() {
        let mut engine = Engine::new(approximate_script(), AlignmentConfig::default());
        engine.set_manual_position(2, 0.0);
        assert_eq!(final_item(&mut engine, 1, "presentor", 350.0).provisional, Some(3.0));

        let retracted = final_item(&mut engine, 2, "banana", 700.0);
        assert_eq!(retracted.provisional, None);
        assert!(retracted.provisional_retracted);
        assert_eq!(retracted.observed, 2.0);
        assert_eq!(retracted.confirmed, 2.0);

        // Retraction is a one-shot rendering instruction.
        let after = engine.handle(SessionEvent::ItemStarted {
            item_id: "item-3".to_string(),
            audio_start_ms: 800.0,
        });
        assert!(!after.provisional_retracted);
    }

    #[test]
    fn exact_followup_commits_past_the_provisional_frontier() {
        let mut engine = Engine::new(approximate_script(), AlignmentConfig::default());
        engine.set_manual_position(2, 0.0);
        assert_eq!(final_item(&mut engine, 1, "presentor", 350.0).provisional, Some(3.0));

        let committed = final_item(&mut engine, 2, "teleprompter harbour", 800.0);
        assert_eq!(committed.provisional, None);
        assert!(!committed.provisional_retracted);
        assert!(committed.observed >= 5.0);
        assert!(committed.confirmed >= 5.0);
    }

    #[test]
    fn one_close_word_cannot_acquire_a_cold_lock() {
        let mut engine = Engine::new(approximate_script(), AlignmentConfig::default());
        let snapshot = final_item(&mut engine, 1, "presentor", 350.0);

        assert_ne!(snapshot.state, TrackingState::Following);
        assert_eq!(snapshot.provisional, None);
        assert_eq!(snapshot.observed, 0.0);
        assert_eq!(snapshot.confirmed, 0.0);
    }

    #[test]
    fn expected_proper_noun_can_use_phonetic_evidence_locally() {
        let script = compile(
            "alpha bravo Saoirse delta echo",
            CompileOptions::default(),
        );
        let mut engine = Engine::new(script, AlignmentConfig::default());
        engine.set_manual_position(2, 0.0);

        let snapshot = final_item(&mut engine, 1, "Sawersi", 350.0);
        assert_eq!(snapshot.provisional, Some(3.0));
        assert_eq!(snapshot.observed, 2.0);
        assert_eq!(snapshot.confirmed, 2.0);
    }
}
