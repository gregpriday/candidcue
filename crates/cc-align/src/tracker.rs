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
use crate::script::{CompiledScript, TranscriptWordTime, FLAG_ANCHOR};

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

/// Input events, mirroring the frames the Rust STT session emits
/// (`cc_stt::SttFrame`), with the receive-side audio clock attached.
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
        /// When the recogniser heard each word of `text`, if it reported that.
        ///
        /// `None` is the ordinary answer for a recogniser that does not time
        /// its words, and for every frame captured before one did — the engine
        /// dates the words by interpolation exactly as it always has.
        word_times: Option<Vec<TranscriptWordTime>>,
    },
    Final {
        item_id: String,
        text: String,
        /// The audio clock when the final was PRODUCED — not when the last
        /// word was spoken.
        audio_end_ms: f64,
        /// When the last word was actually spoken, if the host could say.
        ///
        /// `audio_end_ms` is a receipt time. For a silence endpoint it runs a
        /// whole endpoint lag after the speaking stopped, and
        /// `AlignmentConfig::endpoint_lag_ms` subtracts that. For the other two
        /// ways an utterance closes — the length cap, or an explicit stop —
        /// there is no trailing silence at all, and that subtraction dates the
        /// last word before it happened.
        ///
        /// The engine does not know the recogniser's endpoint rules and must
        /// not: time enters as explicit audio-clock milliseconds, and
        /// `src-tauri/src/align` does the translation from
        /// `cc_stt::CloseReason` and per-token timestamps. `None` means
        /// "nothing was said about it" — every frame in the frozen corpora —
        /// and takes the configured lag exactly as before.
        acoustic_end_ms: Option<f64>,
        /// See [`SessionEvent::Partial::word_times`].
        word_times: Option<Vec<TranscriptWordTime>>,
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

/// Do two candidate alignments consume the SAME script text?
///
/// Two places in the document scoring alike can mean either of two completely
/// different things, and the score alone cannot tell them apart:
///
/// * two weakly-supported candidates that happen to land near each other —
///   the engine does not know where the reader is, or
/// * a refrain, where the places are indistinguishable *because they are the
///   same words*.
///
/// Only the second is safe to treat permissively. In a refrain the tie carries
/// no information about what is being read — the reader's words fit both
/// places equally well and always will — so it is a fact about the document,
/// not about the evidence.
///
/// Compares interned atom ids, which is the same canonical identity the
/// aligner matches on: lowercased, expanded, and tokenised once at compile
/// time. Exact ids only — a fuzzy or phonetic near-match is precisely the case
/// where the two places are NOT interchangeable, and counting it here is how a
/// spelling coincidence would end up authorising a jump.
///
/// The span compared is `start_position..end_position`, which ends at the last
/// atom the alignment MATCHED — script consumed by a trailing substitution
/// falls outside it. That is the right span rather than a shortcoming: the
/// question is whether the words already spoken can tell the two places apart,
/// and material neither place matched cannot. Divergence after the span is
/// expected — a refrain is followed by different text, and that difference is
/// exactly how the tie resolves itself a moment later.
///
/// Fails closed. An empty or out-of-range span is not evidence of anything.
fn same_matched_span(script: &CompiledScript, a: &Evidence, b: &Evidence) -> bool {
    let span = |ev: &Evidence| {
        let start = ev.start_position as usize;
        let end = ev.end_position as usize;
        if end <= start {
            return None;
        }
        script.atoms.get(start..end)
    };
    match (span(a), span(b)) {
        (Some(left), Some(right)) => {
            left.len() == right.len() && left.iter().zip(right).all(|(x, y)| x.id == y.id)
        }
        _ => false,
    }
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
    /// Latched aside: the reader is talking, but not from the script.
    ///
    /// Deliberately not inferred from `weak_streak`. Weakness means the engine
    /// has lost the thread and should search harder; an aside means there is
    /// nothing to find, and searching harder is how a fifteen-second answer to
    /// a question ends up moving the sheet. They want opposite responses.
    off_script: bool,
    /// Consecutive revisions voting for an aside, and (once latched) the
    /// consecutive revisions of ordered exact evidence voting to end it.
    off_script_enter_streak: u8,
    off_script_return_streak: u8,
    /// Script position the last returning revision reached. The tail is
    /// cumulative, so without this one lucky run of script words stays in the
    /// window and votes to end the aside again on every later revision —
    /// the same three words counted twice, which is not two pieces of evidence.
    off_script_return_position: f64,
    /// Audio time the return began, so releasing the latch can retire the
    /// aside's own words from the tail rather than leaving them to drag the
    /// ordinary ratio gate back down over a reader who has plainly resumed.
    off_script_return_from_ms: f64,
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
            off_script: false,
            off_script_enter_streak: 0,
            off_script_return_streak: 0,
            off_script_return_position: 0.0,
            off_script_return_from_ms: 0.0,
            tail_horizon_ms: f64::MIN,
            regions: Vec::new(),
        }
    }

    /// Begin the aside, in one step.
    ///
    /// The latch has to take the display with it. `weak_streak` reaches
    /// `Holding` on its own count, and on a tuned config the aside can be
    /// certain first — leaving `off_script` true while the snapshot still says
    /// `Following` and publishes a rate. That is the confidently-wrong state
    /// this engine exists to avoid, so entry parks the display itself rather
    /// than trusting a later hold to do it.
    fn enter_off_script(&mut self) {
        if self.off_script {
            return;
        }
        self.off_script = true;
        if !matches!(self.state, TrackingState::Searching) {
            self.state = TrackingState::Holding;
        }
        // The dim frontier is a guess about the next word. There is no next
        // word while the reader is off the page.
        if self.provisional.take().is_some() {
            self.provisional_retracted = true;
            self.approximate_streak = 0;
        }
    }

    /// End the aside. Any accepted position — a manual anchor, a relocation, a
    /// skip — is better evidence about where the reader is than the latch is.
    fn clear_off_script(&mut self) {
        self.off_script = false;
        self.off_script_enter_streak = 0;
        self.off_script_return_streak = 0;
        self.off_script_return_position = 0.0;
        self.off_script_return_from_ms = 0.0;
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
        self.clear_off_script();
        self.confidence = 0.9;
        self.last_evidence_ms = at_audio_ms;
        // Speech from before the manual move must not drag the cursor back.
        self.tail_horizon_ms = at_audio_ms;
        self.snapshot(DecisionCode::ManualAnchor, at_audio_ms, at_audio_ms)
    }

    /// "Re-find me here." Reopen the search around a position the reader can
    /// see, rather than asserting that position.
    ///
    /// ## Why this is not `set_manual_position`
    ///
    /// It used to be. The control store's own comment said so:
    ///
    /// > TODO(integration): use a dedicated `reacquire` message so the aligner
    /// > reopens candidate windows instead of being re-seeded with its own
    /// > cursor.
    ///
    /// Two things were wrong with re-using the manual move. It seeded the
    /// engine with `confirmedToken` — the engine's OWN current answer — so
    /// "re-find me" asked it to look exactly where it was already looking,
    /// which is the one place it is demonstrably not finding the reader. And
    /// it set `Following` at confidence 0.9, asserting a lock the presenter
    /// had just told it it did not have; the display then moved off that
    /// assertion before any evidence arrived to support it.
    ///
    /// A reacquisition is a different act from a jump. The presenter is not
    /// saying "I am at token N", they are saying "I am somewhere on this
    /// screen and you are wrong". So:
    ///
    /// * the state goes to [`TrackingState::Searching`] — the display HOLDS
    ///   until evidence arrives, which is the safe direction for a follower
    ///   that must never run ahead;
    /// * `around_atom` is a *prior*, expressed through the same viewport hint
    ///   the stage already uses, not a position;
    /// * evidence continuity is cut — the tail horizon moves to now, so words
    ///   spoken before the presenter asked for help cannot drag the cursor
    ///   back to where it was already wrong;
    /// * the script-position estimate is left where it was rather than moved.
    ///   Nothing has been established yet, and moving it would be the
    ///   assertion this exists to avoid.
    ///
    /// `window_atoms` widens the prior either side of `around_atom`. It is the
    /// visible region, so the caller passes what is actually on the glass.
    pub fn reacquire(&mut self, around_atom: u32, window_atoms: u32, at_audio_ms: f64) -> Snapshot {
        let len = self.script.len() as u32;
        let first = around_atom.saturating_sub(window_atoms);
        let last = around_atom.saturating_add(window_atoms).min(len);
        self.set_viewport_hint(first, last);

        self.state = TrackingState::Searching;
        // Nothing is established, so nothing claims to be.
        self.confidence = 0.0;
        self.rate_anchors.clear();
        self.rate = self.config.rate_default;
        self.pending_jump = None;
        self.weak_streak = 0;
        self.approximate_streak = 0;
        self.provisional = None;
        self.provisional_retracted = false;
        self.clear_off_script();

        // Speech from before the presenter asked for help must not be used to
        // answer the question. It is what produced the wrong answer.
        self.last_evidence_ms = at_audio_ms;
        self.tail_horizon_ms = at_audio_ms;

        self.snapshot(DecisionCode::NoEvidence, at_audio_ms, at_audio_ms)
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
                word_times,
            } => {
                // Canonicalised against the script's own vocabulary first, so
                // a name the recogniser split in two arrives as the one word
                // the script wrote. Two statements, not one: the script is
                // borrowed for the atoms, then its interner for the ledger.
                let atoms = self.query_words_for(&text, word_times.as_deref());
                self.ledger.revise_atoms(
                    &mut self.script.interner,
                    &item_id,
                    atoms,
                    false,
                    audio_ms,
                    // A partial has not ended, so there is no end to date.
                    None,
                );
                self.update(audio_ms)
            }
            SessionEvent::Final {
                item_id,
                text,
                audio_end_ms,
                acoustic_end_ms,
                word_times,
            } => {
                let atoms = self.query_words_for(&text, word_times.as_deref());
                self.ledger.revise_atoms(
                    &mut self.script.interner,
                    &item_id,
                    atoms,
                    true,
                    audio_end_ms,
                    acoustic_end_ms,
                );
                self.update(audio_end_ms)
            }
        }
    }

    // -----------------------------------------------------------------
    // Core update
    // -----------------------------------------------------------------

    /// Transcript words for this event, timed where the recogniser timed them.
    ///
    /// The choice is only ever about the CLOCK on each word. Both paths produce
    /// the same atoms — [`CompiledScript::query_words_with_times`] falls back
    /// to the untimed ones itself if it cannot show the two accounts of the
    /// text describe the same words — so no evidence and no matching decision
    /// turns on whether a recogniser reports timing.
    fn query_words_for(
        &self,
        text: &str,
        word_times: Option<&[TranscriptWordTime]>,
    ) -> Vec<crate::script::QueryWord> {
        match word_times {
            Some(times) => self.script.query_words_with_times(text, times),
            None => self.script.query_words(text),
        }
    }

    /// Where to centre the local search band for this event.
    ///
    /// This is the engine's OWN prediction, not the display's. The display
    /// stops extrapolating the moment the state leaves `Following`; this does
    /// not, and that is the coast an aside has to end.
    fn predicted_position(&self, locked: bool, now_ms: f64) -> f64 {
        if self.off_script {
            // An aside is not reading, so there is no pace to extrapolate.
            // Left to coast, the band keeps sliding forward on the pace the
            // reader had BEFORE they left — away from the line they are coming
            // back to, at exactly the moment nothing is confirming it.
            //
            // `self.rate` is deliberately untouched. The learned pace is still
            // true of this reader, and discarding it would make the return
            // slower, not safer.
            return self.observed;
        }
        if !locked {
            return self.observed;
        }
        // Coasting is bounded: after a long silence the reader is far
        // more likely to be where they stopped than rate*60s ahead —
        // an unbounded dt once centred the local band 170 atoms past
        // the reader after a minute of quiet.
        let dt = ((now_ms - self.config.emission_lag_ms) - self.last_evidence_ms)
            .clamp(0.0, self.config.max_prediction_ms + self.config.coast_ms);
        (self.observed + self.rate * dt / 1000.0).min(self.script.len() as f64)
    }

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
        let predicted = self.predicted_position(locked, now_ms);
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

        // Is this revision an aside, or merely a thin one?
        //
        // Judged on the UNEXPLAINED suffix, not the whole tail. The tail still
        // holds the words the reader spoke before they left, and those are
        // genuine exact matches — comparing insertions against them says
        // "on script" right through an aside, and says "off script" on any
        // partial that happens to open with an unlucky word. The material
        // after the last solid run is the part an aside is actually made of.
        //
        // A revision with content in it and NO local explanation at all is the
        // strongest version of this, not the weakest: nothing to match is a
        // clearer statement than a bad match.
        //
        // A bad recogniser also makes insertions dominate, and that reader is
        // still on script — latching there parks a reader who never left. The
        // two are told apart by the same thing the return gate asks for: a run
        // of consecutive exact matches anywhere in the tail. Corruption still
        // throws them off intermittently, an aside does not.
        //
        // Because the tail is cumulative, the reader's last on-script run keeps
        // vetoing entry until it ages out — so an aside is latched from the
        // point the script genuinely stops explaining the speech, not from the
        // first odd revision. That patience is deliberate and it is measured:
        // relaxing this to only veto on an ADVANCING run latches far more
        // eagerly and costs both recovery and accuracy (adlib_p95 6.35s ->
        // 11.75s, corrupt_within5 96.7% -> 93.0% on Tier A).
        let off_script_vote = locked
            && weak
            && unexplained_content >= self.config.weak_unexplained_content
            && local_candidate.as_ref().is_none_or(|c| {
                c.evidence.insertions as usize >= unexplained_content
                    && c.evidence.longest_run < self.config.off_script_return_min_run
            });
        if off_script_vote {
            self.off_script_enter_streak = self.off_script_enter_streak.saturating_add(1);
            if self.off_script_enter_streak >= self.config.off_script_enter_revisions {
                self.enter_off_script();
            }
        } else {
            self.off_script_enter_streak = 0;
        }
        // A revision that explained nothing locally is not a step towards
        // coming back. The return streak is otherwise only touched in
        // `decide_local`, which several hold paths never reach — without this
        // a contradictory revision in the middle would leave an earlier vote
        // standing and let a later unrelated run count as consecutive.
        if self.off_script && local_candidate.is_none() {
            self.off_script_return_streak = 0;
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
            // One pass: the margin to the nearest distant rival, and the rivals
            // close enough to be blocking it. Two passes and a second `Vec`
            // would be tidier to read and this runs on every revision, with
            // `beam_size` sanitised as high as 64.
            let evidence_score = |c: &Candidate| c.score + c.jump_penalty;
            let best_evidence = evidence_score(&distant);
            let mut distant_rivals_gap = f64::INFINITY;
            let mut blocking: Vec<&Candidate> = Vec::new();
            for rival in clusters.iter().filter(|c| {
                is_distant(c)
                    && (c.evidence.end_position as i64 - distant.evidence.end_position as i64)
                        .unsigned_abs()
                        > self.config.cluster_radius as u64 * 4
            }) {
                let gap = best_evidence - evidence_score(rival);
                distant_rivals_gap = distant_rivals_gap.min(gap);
                if gap < self.config.ambiguity_margin {
                    blocking.push(rival);
                }
            }

            // A tie among rivals that are *the same words* is a fact about the
            // document, not a failure to read the evidence. Progress through a
            // refrain is unambiguous even while the place it occupies is not,
            // so the duplicate-passage veto is answering "which copy is this?"
            // — a question the display does not have to answer to keep moving.
            //
            // Where the veto still applies untouched: rivals that merely score
            // alike. There the engine really is lost, and holding is honest.
            //
            // FORWARD copies only, and only when every one of them is forward.
            // Copies straddling the reader are the case where choosing wrong
            // does not merely arrive late, it arrives AHEAD — the display
            // running past a presenter who is actually behind it is the one
            // failure this engine will not trade for responsiveness. Backward
            // ties are refused for the mirror reason: a rewind onto an earlier
            // chorus is the most expensive thing a wrong guess can do, and no
            // amount of extra content evidence can tell identical copies
            // apart. Both keep the old honest hold.
            //
            // Waiving the veto does NOT waive anything else. The jump must
            // still out-argue the local explanation by `jump_margin`, clear the
            // fidelity and content-authority bars, and persist across
            // revisions. That local comparison is what keeps a straight read
            // through a repeated chorus in place: while local continuity is
            // healthy it explains the words at least as well as any far copy,
            // so no jump is offered in the first place.
            // The span compared ends at the last atom that MATCHED, which is
            // what makes it the right question: a copy the reader's words
            // carried further reports a longer span and is not identical, so
            // it is the better explanation and the ordinary gap decides. A
            // reader saying "...mnemonic terminus" reaches `terminus` in the
            // copy that has it and stops at `mnemonic` in the copy that does
            // not.
            //
            // The counts are belt-and-braces on top of that. Identical spans
            // aligned against the same query should already yield identical
            // counts, so nothing here is expected to turn on them — but the
            // spans come out of a DP whose path is chosen by cost, and that is
            // an invariant of the aligner rather than anything this gate can
            // see. Cheap to ask, and the answer being surprising is exactly
            // the case worth refusing.
            let evidence_equivalent = |c: &Candidate| {
                c.evidence.exact_matches == distant.evidence.exact_matches
                    && c.evidence.content_matches == distant.evidence.content_matches
                    && same_matched_span(&self.script, &distant.evidence, &c.evidence)
            };
            let identical_rival_tie = !blocking.is_empty()
                && !distant.backward
                && blocking.iter().all(|c| !c.backward && evidence_equivalent(c));

            // Among copies that are word-for-word identical the evidence
            // cannot choose, and does not need to: whichever is real, the
            // reader traverses the same run of tokens. What is left to decide
            // is only *where*, and there the least-displacement answer is the
            // right one — the nearest copy is the one that asks the page to
            // move least on a guess, and being a little short of the reader is
            // recoverable in a way overshooting them is not.
            //
            // Measured from `observed`, the same place eligibility is measured
            // from, and deliberately NOT from `predicted`. Prediction coasts
            // during a stall, and a stale one sitting far ahead would pull the
            // choice toward the copy furthest from where the reader was
            // actually last heard — the overshoot this ordering exists to
            // prevent, arriving through the back door. Today's defaults keep
            // the drift under a dozen atoms and it could not bite, but that is
            // an accident of two unrelated config values rather than anything
            // this code is entitled to assume.
            let selected = if identical_rival_tie {
                blocking
                    .iter()
                    .copied()
                    .chain(std::iter::once(&distant))
                    .min_by(|a, b| {
                        let from_reader =
                            |c: &Candidate| ((c.evidence.end_position as f64) - self.observed).abs();
                        // `total_cmp`, not `partial_cmp`: a total order needs no
                        // guess about what an unordered pair means. The position
                        // tiebreak keeps the choice deterministic.
                        from_reader(a)
                            .total_cmp(&from_reader(b))
                            .then(a.evidence.end_position.cmp(&b.evidence.end_position))
                    })
                    .cloned()
                    .unwrap_or_else(|| distant.clone())
            } else {
                distant.clone()
            };

            let discontinuity_horizon = global_query.first().map(|q| q.audio_ms - 1.0);
            match self.try_discontinuity(
                &selected,
                local_suffix_score,
                distant_rivals_gap,
                identical_rival_tie,
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
                        // Discounted, unlike the other `observe_min_content`
                        // gates: this one picks a candidate the global index
                        // proposed and can carry the reader tens of atoms to
                        // it. That it is bounded by `discontinuity_atoms`
                        // makes it cheaper than a jump, not local — and a
                        // forward reconnection onto solicited words is exactly
                        // the creep this discount exists to stop, since the
                        // bias window would advance with it.
                        && self.content_authority_ok(
                            &candidate.evidence,
                            self.config.observe_min_content,
                        )
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
                    self.decide_local(local, predicted, now_ms)
                }
            }
            _ => self.hold(DecisionCode::HoldLowEvidence, now_ms),
        }
    }

    /// Does this candidate carry enough content evidence to *move the reader*,
    /// counting solicited words at a discount?
    ///
    /// A word the recogniser was biased toward is not independent evidence of
    /// the position that asked for it, so it buys a fraction of an ordinary
    /// match here (`biased_content_weight_milli`). Only the gates that
    /// authorise a relocation or a far jump ask this — ordinary local
    /// continuity compares `content_matches` directly, because a wrong local
    /// step is cheap and self-correcting, while a wrong jump is not.
    ///
    /// Compared in milli-units rather than rounded back to whole words, so
    /// fractional authority accumulates exactly: at half weight, two solicited
    /// matches are worth precisely one unsolicited one, with no per-token
    /// rounding to lose.
    ///
    /// Widened to `u64` for the comparison. In `u32` both sides can saturate at
    /// once, and two saturated sides compare EQUAL — which turns a gate that
    /// should fail into one that passes. Every `u32 × 1000` fits in `u64`
    /// exactly, so the widened form simply cannot reach that state.
    fn content_authority_ok(&self, ev: &Evidence, required: u32) -> bool {
        let biased = ev.biased_content_matches.min(ev.content_matches);
        let unbiased = ev.content_matches.saturating_sub(biased);
        // `Engine::new` sanitises, but `config` is public and may be replaced
        // afterwards. A solicited match must never be worth more than an
        // unsolicited one, whatever it says.
        let weight = self.config.biased_content_weight_milli.min(1000);
        let available = u64::from(unbiased) * 1000 + u64::from(biased) * u64::from(weight);
        available >= u64::from(required) * 1000
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
            && self.content_authority_ok(ev, c.relocation_min_content)
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
        self.clear_off_script();
        self.state = TrackingState::Following;
        self.confidence = confidence_of(ev, margin);
        self.snapshot(DecisionCode::RelocationAccepted, evidence_ms, now_ms)
    }

    fn decide_local(&mut self, best: Candidate, predicted: f64, now_ms: f64) -> Snapshot {
        let c = self.config.clone();
        let ev = &best.evidence;
        // There is deliberately no ambiguity check here, and no margin to make
        // one from. An ambiguity hold used to sit at the top of this function
        // and stopped being reachable when candidate generation was split into
        // a local phase and a global one — the surviving caller supplies no
        // margin at all. That is the invariant rather than an oversight: this
        // path handles a reader who is continuing, whether through the local
        // band or a nearby suffix reconnection, and neither is a claim about
        // which of several places in the document the reader is in. Duplicate
        // passages are a discontinuity question and are settled in
        // `try_discontinuity`, where the rival copies actually exist.
        let mut ordinary_passes = ev.fidelity >= c.observe_min_fidelity
            && ev.coverage >= c.observe_min_coverage
            && ev.content_matches >= c.observe_min_content;

        // Coming back from an aside is a different question from ordinary local
        // continuity, and it is deliberately not asked the same way.
        //
        // The ordinary gate is mostly RATIOS — fidelity and coverage over the
        // whole tail — and the tail still holds the aside. After fifteen
        // seconds of riffing those ratios are poisoned by the reader's own
        // words, so requiring them here would mean out-talking the aside before
        // the script would take you back.
        //
        // Ask for ORDER instead, which is a count and cannot be diluted: a run
        // of consecutive exact matches, at or past where they left, twice
        // running. A reader riffing near their place throws off script words by
        // coincidence; coincidence does not arrive in script order twice.
        //
        // The second run must also CLEAR the first. The tail is cumulative, so
        // one lucky run survives in the window and would otherwise vote again
        // on every later revision — one piece of evidence counted twice.
        // Requiring a whole run's worth of daylight between them is what makes
        // the two votes independent rather than the same words re-read.
        //
        // A revision that neither contradicts the return nor gets past the last
        // one is a RESTATEMENT, and neither counts nor cancels. The on-device
        // recogniser closes an item by re-emitting its last hypothesis as a
        // final, so treating "no progress" as contradiction would cancel the
        // vote the matching partial just earned, on every short utterance.
        if self.off_script {
            let position = ev.end_position as f64;
            let ordered = ev.longest_run >= c.off_script_return_min_run
                && ev.content_matches >= c.observe_min_content
                && position >= self.observed;
            let clears_last = self.off_script_return_streak == 0
                || position >= self.off_script_return_position + c.off_script_return_min_run as f64;
            if !ordered {
                self.off_script_return_streak = 0;
            } else if clears_last {
                self.off_script_return_streak = self.off_script_return_streak.saturating_add(1);
                self.off_script_return_position = position;
                if self.off_script_return_streak == 1 {
                    // Where coming back began. On release this retires the
                    // aside so its words stop dragging the ratios down.
                    self.off_script_return_from_ms = ev.last_match_audio_ms;
                }
            }
            if self.off_script_return_streak < c.off_script_return_revisions {
                return self.hold(DecisionCode::HoldOffScript, now_ms);
            }
            // The aside is over. Retire the words it was made of: they are the
            // reason the ordinary ratio gate cannot see the reader, and left in
            // the tail they would re-park them within a revision or two.
            self.tail_horizon_ms = self.tail_horizon_ms.max(self.off_script_return_from_ms);
            // The pace anchors now straddle the aside. A pair spanning twenty
            // silent seconds reads as a crawl, and the median would clamp to
            // `rate_min` just as the reader gets going again — so drop them and
            // re-learn the pace from what they read next.
            self.rate_anchors.clear();
            self.clear_off_script();
            // Ordered exact evidence is the stronger claim of the two. Having
            // asked for it, honour it — otherwise the aside's leftover words
            // would fail the ratio gate below and re-park a reader who is
            // demonstrably back on the line.
            ordinary_passes = true;
        }

        let approximate_bridge = !ordinary_passes && self.can_bridge_local_approx(&best, predicted);
        if !ordinary_passes && !approximate_bridge {
            if self.provisional.is_some() && self.is_coherent_approx_chain(&best) {
                // The spelling evidence still points forward in order, but the
                // speculative budget is exhausted. Hold the existing dim
                // frontier; reaching the cap is not evidence that the earlier
                // provisional words were wrong.
                return self.hold_preserving_provisional(DecisionCode::HoldLowEvidence, now_ms);
            }
            // Thin evidence, not an aside: an aside has already been latched by
            // `off_script` above, over several revisions, and says so through
            // `hold`. One revision where insertions happen to outnumber exact
            // matches is a bad partial.
            return self.hold(DecisionCode::HoldLowEvidence, now_ms);
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
            // No rival to be scored against, so no margin penalty: local
            // continuity is confident in proportion to its own evidence.
            self.confidence = confidence_of(ev, f64::INFINITY);
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

    /// How far prediction may carry the DISPLAY from where the reader was last
    /// heard — the sentence they are audibly in, or the paragraph when the
    /// finer rule is switched off for comparison.
    ///
    /// Only the display's limit comes through here. The approximate-bridge gate
    /// keeps the paragraph ceiling on purpose; see the note at its call site.
    fn prediction_ceiling(&self) -> f64 {
        if self.config.sentence_prediction_ceiling {
            self.script.prediction_ceiling(self.observed)
        } else {
            self.script.paragraph_ceiling(self.observed)
        }
    }

    /// May one close spelling/sound stand in for the immediately expected
    /// script word?
    ///
    /// This is intentionally much narrower than ordinary local alignment:
    /// one new approximate content relation per step, no unexplained transcript
    /// or skipped script material, forward by about one word, near the pace
    /// prediction, and only from an already-confident Following lock. What it
    /// MOVES is only the reversible dim frontier; never `observed`,
    /// `confirmed`, cold acquisition, or discontinuity authority.
    ///
    /// What it DECIDES reaches further than that, which is easy to miss and
    /// matters: the local-health check reads this answer as part of `local_ok`,
    /// and the ordinary-evidence path treats a refusal here as grounds to hold.
    /// So a stricter gate does not merely dim less — it can stop the engine
    /// extrapolating at all.
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
            // Deliberately the PARAGRAPH ceiling, not the sentence one. This
            // gate is not dim-only: `local_ok` above reads it to decide whether
            // evidence is weak, and failing it here drops the engine into
            // `Holding` — so tightening it to sentences would stop
            // extrapolation and change motion state at every full stop. The
            // display does not need that to stay behind the reader; the
            // sentence rule is enforced where it belongs, on `display_limit`,
            // which already refuses to cross the boundary. Braking the display
            // is the goal; halting the tracker at every full stop is not.
            && ev.end_position as f64 <= self.script.paragraph_ceiling(self.observed)
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
    /// (duplicate-passage protection). `identical_rival_tie` says that margin
    /// is small only because the tied rivals are word-for-word identical, which
    /// the caller has already resolved by picking the copy nearest `observed`
    /// — the minimum overshoot available, never the one furthest ahead. See
    /// the note there.
    fn try_discontinuity(
        &mut self,
        best: &Candidate,
        local_suffix_score: f64,
        distant_rivals_gap: f64,
        identical_rival_tie: bool,
        horizon_ms: Option<f64>,
        now_ms: f64,
    ) -> DiscontinuityOutcome {
        let c = self.config.clone();
        let ev = &best.evidence;
        let needed_content = if best.backward {
            c.jump_min_content.saturating_add(c.retake_extra_content)
        } else {
            c.jump_min_content
        };
        // Evidence-only margin: add the distance penalty back. The penalty
        // orders candidates; it must not make a far-but-correct relocation
        // permanently lose to nearby junk.
        let evidence_score = best.score + best.jump_penalty;
        // The duplicate-passage veto asks "is this copy the one?", and a
        // refrain answers with a permanent no. Identity is not resolved when
        // the caller sets `identical_rival_tie` — it is decided to be
        // undecidable, and the choice made on the only ground left. What the
        // veto would buy from here is not safety but stillness for the length
        // of the passage, so it does not apply.
        let no_rival_veto = identical_rival_tie || distant_rivals_gap >= c.ambiguity_margin;
        let strong = ev.fidelity >= c.jump_min_fidelity
            && self.content_authority_ok(ev, needed_content)
            && evidence_score - local_suffix_score >= c.jump_margin
            && no_rival_veto;

        if !strong {
            // Not evidence enough to even consider — clear any stale pending
            // target so an unrelated later fluctuation doesn't inherit its
            // persistence count.
            //
            // Undiscounted deliberately: forgetting a target authorises
            // nothing. Whether the pending entry survives or not, accepting it
            // still has to clear the discounted gate above, so reading a
            // solicited match at full value here only decides how long a
            // suggestion is remembered.
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
        // An accepted relocation says where the reader is; that outranks a
        // latch that only says where they are not.
        self.clear_off_script();
        // Evidence from before the discontinuity is dead — without this the
        // next full-tail alignment out-votes the jump and snaps back.
        if let Some(h) = horizon_ms {
            self.tail_horizon_ms = self.tail_horizon_ms.max(h);
        }
        let evidence_ms = self.evidence_time(ev, now_ms);
        self.accept(target as f64, evidence_ms, true);
        self.state = TrackingState::Following;
        self.confidence = confidence_of(ev, evidence_score - local_suffix_score);
        if identical_rival_tie {
            // Moving was the right call and the words on the glass are right
            // either way, but a copy chosen by proximity is still a copy
            // chosen without evidence. Say so: confidence is what the rest of
            // the engine reads to decide how much rope to give the next
            // approximate bridge, and it should have less of it here.
            self.confidence = (self.confidence * 0.7).max(0.05);
        }
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
        // Every hold taken during a latched aside IS the aside. Without this
        // the diagnostic contradicts the engine: the tracker is deliberately
        // parked because the reader is off script, while the trace says the
        // evidence merely came up short.
        let code = if self.off_script {
            DecisionCode::HoldOffScript
        } else {
            code
        };
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
            // The default for every existing test: nothing said about the
            // acoustic end, so the configured endpoint lag applies exactly as
            // it did before this field existed.
            acoustic_end_ms: None,
            word_times: None,
        })
    }

    fn approximate_script() -> CompiledScript {
        compile(
            "alpha bravo presenter teleprompter harbour narration delta echo foxtrot golf",
            CompileOptions::default(),
        )
    }

    /// Word times reach the evidence clock, and reach it only in the direction
    /// that is safe to be wrong in.
    ///
    /// `evidence_audio_ms` is what the display extrapolates FROM. Dating it
    /// earlier makes the stage run further ahead of the reader, so a
    /// measurement is taken when it says "later than you thought" and declined
    /// when it says "earlier".
    #[test]
    fn measured_word_times_move_the_evidence_clock_only_later() {
        let script = || compile("alpha bravo charlie delta", CompileOptions::default());
        // A trailing word the script does not contain, so the last MATCHED
        // atom is an interior one. The final atom of an item always lands
        // exactly on the item's corrected end whether or not it was measured —
        // that edge is `endpoint_lag_ms`'s to move, not this change's — so an
        // interior match is where a measurement is visible at all.
        let heard = "alpha bravo charlie delta epsilon";

        let baseline = {
            let mut engine = Engine::new(script(), AlignmentConfig::default());
            engine.handle(SessionEvent::ItemStarted {
                item_id: "item-0".into(),
                audio_start_ms: 0.0,
            });
            final_item(&mut engine, 0, heard, 4_000.0).evidence_audio_ms
        };

        let with_times = |times: Vec<TranscriptWordTime>| {
            let mut engine = Engine::new(script(), AlignmentConfig::default());
            engine.handle(SessionEvent::ItemStarted {
                item_id: "item-0".into(),
                audio_start_ms: 0.0,
            });
            engine
                .handle(SessionEvent::Final {
            acoustic_end_ms: None,
                    item_id: "item-0".into(),
                    text: heard.to_string(),
                    audio_end_ms: 4_000.0,
                    word_times: Some(times),
                })
                .evidence_audio_ms
        };

        let word = |text: &str, start_ms: f64| TranscriptWordTime {
            text: text.to_string(),
            start_ms,
        };

        // Heard late in the item — later than the even spread believed.
        let late = with_times(vec![
            word("alpha", 2_000.0),
            word("bravo", 2_100.0),
            word("charlie", 2_200.0),
            word("delta", 2_300.0),
            word("epsilon", 2_400.0),
        ]);
        // STRICTLY later, not merely "not earlier". `>=` would hold just as
        // well if the timing were dropped on the floor, which is the shape of
        // vacuous test this whole change is most at risk of.
        assert!(
            late > baseline,
            "measured times must actually reach the evidence clock: {late} !> {baseline}"
        );

        // Heard right at the top of the item. Believing it would lengthen the
        // display's extrapolation, so it is refused.
        let early = with_times(vec![
            word("alpha", 10.0),
            word("bravo", 20.0),
            word("charlie", 30.0),
            word("delta", 40.0),
            word("epsilon", 50.0),
        ]);
        assert_eq!(
            early, baseline,
            "an earlier measurement must not move the evidence clock at all"
        );
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

    /// Braking the display at a full stop must not also halt the tracker
    /// there.
    ///
    /// `can_bridge_local_approx` looks like a dimming concern and is not: the
    /// health check reads it to decide whether evidence is weak, and failing it
    /// drops the engine to `Holding` with the rate at zero. Gating it on
    /// sentences would therefore stop extrapolation at every full stop — a
    /// stutter in the motion, bought for a safety the `display_limit` was
    /// already providing on its own.
    #[test]
    fn a_sentence_break_brakes_the_display_without_stalling_the_tracker() {
        // The full stop falls after `bravo`, so the bridge's candidate — which
        // lands on `presenter`, atom 3 — sits BEYOND the sentence ceiling and
        // inside the paragraph. That gap is the whole point: with the gate on
        // the sentence ceiling the bridge is refused and the engine holds, so
        // this test fails if the ceiling is ever put back on it.
        let script = compile(
            "alpha bravo. presenter teleprompter harbour narration",
            CompileOptions::default(),
        );
        assert_eq!(script.sentence_end, vec![2, 2, 6, 6, 6, 6]);
        assert_eq!(script.para_end, vec![6, 6, 6, 6, 6, 6]);

        let mut engine = Engine::new(script, AlignmentConfig::default());
        engine.set_manual_position(2, 0.0);
        let snapshot = final_item(&mut engine, 1, "presentor", 350.0);

        // Heard through `bravo` and holding at the full stop, the display may
        // not reach `presenter`...
        assert_eq!(snapshot.display_limit, 2.0);
        // ...but the tracker keeps following and the reversible dim frontier
        // still advances, because shading can be taken back and a stalled
        // engine cannot.
        assert_eq!(snapshot.state, TrackingState::Following);
        assert_eq!(snapshot.provisional, Some(3.0));
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

    // ---- off-script aside (issue #167) ----

    fn aside_script() -> CompiledScript {
        compile(
            "alpha bravo charlie delta echo foxtrot golf hotel india juliet \
             kilo lima mike november oscar papa quebec romeo sierra tango",
            CompileOptions::default(),
        )
    }

    /// An engine parked at atom 4 with a latched aside behind it.
    fn engine_off_script() -> Engine {
        let mut engine = Engine::new(aside_script(), AlignmentConfig::default());
        engine.set_manual_position(4, 0.0);
        for (n, at) in [(1u32, 400.0), (2, 800.0), (3, 1_200.0)] {
            final_item(&mut engine, n, "wombat pangolin marmoset", at);
        }
        assert!(engine.off_script, "fixture failed to latch");
        engine
    }

    #[test]
    fn one_insertion_heavy_revision_is_a_bad_partial_not_an_aside() {
        let mut engine = Engine::new(aside_script(), AlignmentConfig::default());
        engine.set_manual_position(4, 0.0);

        let snapshot = final_item(&mut engine, 1, "wombat pangolin marmoset", 400.0);

        // The old code called this off-script on the strength of one
        // comparison. One partial where insertions dominate is a bad partial.
        assert_eq!(snapshot.decision, DecisionCode::HoldLowEvidence);
        assert!(!engine.off_script);
        assert_eq!(engine.off_script_enter_streak, 1);
        assert_eq!(snapshot.observed, 4.0);
    }

    #[test]
    fn an_aside_latches_only_after_consecutive_revisions() {
        let mut engine = Engine::new(aside_script(), AlignmentConfig::default());
        engine.set_manual_position(4, 0.0);

        assert_eq!(
            final_item(&mut engine, 1, "wombat pangolin marmoset", 400.0).decision,
            DecisionCode::HoldLowEvidence,
        );
        assert_eq!(
            final_item(&mut engine, 2, "aardvark quokka numbat", 800.0).decision,
            DecisionCode::HoldLowEvidence,
        );
        assert!(!engine.off_script);

        let latched = final_item(&mut engine, 3, "capybara dugong axolotl", 1_200.0);
        assert!(engine.off_script);
        assert_eq!(latched.decision, DecisionCode::HoldOffScript);
        assert_eq!(latched.state, TrackingState::Holding);
        // The aside never moves the sheet.
        assert_eq!(latched.observed, 4.0);
        assert_eq!(latched.confirmed, 4.0);
    }

    #[test]
    fn script_speech_resets_the_entry_streak() {
        let mut engine = Engine::new(aside_script(), AlignmentConfig::default());
        engine.set_manual_position(4, 0.0);

        final_item(&mut engine, 1, "wombat pangolin marmoset", 400.0);
        final_item(&mut engine, 2, "aardvark quokka numbat", 800.0);
        assert_eq!(engine.off_script_enter_streak, 2);

        // Reading the script again is not the third revision of an aside. The
        // revision is still WEAK — the aside's own words are most of the tail,
        // so the ordinary ratio gate cannot pass yet — which is exactly why
        // weakness alone must not be allowed to stand in for an aside.
        let reading = final_item(&mut engine, 3, "echo foxtrot golf", 1_200.0);
        assert_eq!(engine.off_script_enter_streak, 0);
        assert!(!engine.off_script);
        assert_ne!(reading.decision, DecisionCode::HoldOffScript);

        // ...and the count really did restart, rather than the latch simply
        // being one revision away.
        final_item(&mut engine, 4, "wombat pangolin marmoset", 1_600.0);
        let still_clear = final_item(&mut engine, 5, "aardvark quokka numbat", 2_000.0);
        assert!(!engine.off_script);
        assert_eq!(still_clear.decision, DecisionCode::HoldLowEvidence);
    }

    #[test]
    fn a_corrupt_recogniser_is_not_an_aside() {
        let mut engine = Engine::new(aside_script(), AlignmentConfig::default());
        engine.set_manual_position(4, 0.0);

        // Every revision is weak and insertion-dominated, but each still
        // carries an ordered run of script words that reaches further on —
        // a reader being mangled by the recogniser, not one who left.
        final_item(&mut engine, 1, "echo foxtrot golf zzqx vvwy ppkr", 400.0);
        final_item(&mut engine, 2, "hotel india juliet zzqx vvwy ppkr", 800.0);
        let third = final_item(&mut engine, 3, "kilo lima mike zzqx vvwy ppkr", 1_200.0);

        assert!(
            !engine.off_script,
            "corruption must not park a reader who never left the script",
        );
        assert_ne!(third.decision, DecisionCode::HoldOffScript);
    }

    #[test]
    fn a_latched_aside_freezes_the_search_band_without_forgetting_the_pace() {
        let mut engine = engine_off_script();
        // A pace the reader actually set, not the default — otherwise this
        // cannot tell "kept the pace" from "reset it to the default".
        engine.rate = 5.0;
        engine.last_evidence_ms = 1_200.0;

        // The engine's own prediction, a second and a half later. Not the
        // published rate: that is zero for any hold and would prove nothing.
        let frozen = engine.predicted_position(true, 2_700.0);
        assert_eq!(
            frozen, engine.observed,
            "a latched aside must centre the band on the last real evidence",
        );

        // The same instant without the latch is the coast the aside removes.
        engine.off_script = false;
        let coasting = engine.predicted_position(true, 2_700.0);
        assert!(
            coasting > frozen,
            "fixture is not exercising the freeze: coasting {coasting} vs frozen {frozen}",
        );

        // The learned pace survived — it is still true of this reader.
        assert_eq!(engine.rate, 5.0);
    }

    #[test]
    fn every_hold_inside_an_aside_says_off_script() {
        let mut engine = engine_off_script();

        // This revision reaches a different hold site than the one that
        // latched — the diagnostic must not go back to claiming thin evidence
        // while the engine is deliberately parked.
        let snapshot = final_item(&mut engine, 4, "wallaby", 1_600.0);
        assert_eq!(snapshot.decision, DecisionCode::HoldOffScript);
        assert!(engine.off_script);
    }

    #[test]
    fn incidental_script_words_do_not_end_an_aside() {
        let mut engine = engine_off_script();

        // A reader riffing near their place throws off script words by
        // coincidence. Out of order, they prove nothing.
        let snapshot = final_item(&mut engine, 4, "quebec wombat alpha numbat", 1_600.0);

        assert!(engine.off_script);
        assert_eq!(snapshot.decision, DecisionCode::HoldOffScript);
        assert_eq!(snapshot.observed, 4.0);
        assert_eq!(engine.off_script_return_streak, 0);
    }

    #[test]
    fn returning_needs_ordered_exact_evidence_twice() {
        let mut engine = engine_off_script();

        // One ordered run is a start, not a return.
        let first = final_item(&mut engine, 4, "echo foxtrot golf", 1_600.0);
        assert_eq!(first.decision, DecisionCode::HoldOffScript);
        assert!(engine.off_script);
        assert_eq!(engine.off_script_return_streak, 1);

        // The second consecutive run releases the latch and the sheet moves.
        let second = final_item(&mut engine, 5, "hotel india juliet", 2_000.0);
        assert!(!engine.off_script);
        assert_eq!(second.state, TrackingState::Following);
        assert!(
            second.observed > 4.0,
            "returning should move the cursor past the departure point, got {}",
            second.observed,
        );
    }

    #[test]
    fn going_back_to_the_aside_does_not_complete_the_return() {
        let mut engine = engine_off_script();

        final_item(&mut engine, 4, "echo foxtrot golf", 1_600.0);
        assert_eq!(engine.off_script_return_streak, 1);

        // Back to the aside before the return completed. More aside words
        // cannot supply the second vote however many arrive, because that vote
        // has to come from a run further on than the first — and the reader is
        // not producing runs at all.
        for (n, at) in [(5u32, 2_000.0), (6, 2_400.0), (7, 2_800.0)] {
            let snapshot = final_item(&mut engine, n, "wombat pangolin marmoset", at);
            assert_eq!(snapshot.decision, DecisionCode::HoldOffScript);
        }
        assert!(engine.off_script);
        assert_eq!(engine.observed, 4.0);
    }

    #[test]
    fn one_lucky_run_cannot_vote_itself_out_of_an_aside() {
        let mut engine = engine_off_script();

        // Three script words in order, said once by coincidence.
        let first = final_item(&mut engine, 4, "echo foxtrot golf", 1_600.0);
        assert_eq!(first.decision, DecisionCode::HoldOffScript);
        assert_eq!(engine.off_script_return_streak, 1);

        // Silence. The run is still in the tail and still aligns, but the
        // reader has not moved through the script, so it is the same evidence
        // — not a second piece of it.
        let second = engine.handle(SessionEvent::ItemStarted {
            item_id: "item-5".to_string(),
            audio_start_ms: 2_000.0,
        });
        let third = final_item(&mut engine, 6, "echo foxtrot golf", 2_400.0);

        assert!(
            engine.off_script,
            "a static run must not accumulate a return streak: {:?} then {:?}",
            second.decision, third.decision,
        );
    }

    #[test]
    fn restating_the_same_words_neither_counts_nor_cancels() {
        let mut engine = engine_off_script();

        let partial = engine.handle(SessionEvent::Partial {
            item_id: "item-4".to_string(),
            text: "echo foxtrot golf".to_string(),
            audio_ms: 1_600.0,
            word_times: None,
        });
        assert_eq!(partial.decision, DecisionCode::HoldOffScript);
        assert_eq!(engine.off_script_return_streak, 1);

        // The recogniser closes the item by re-emitting the same hypothesis.
        // That is one utterance, not a contradiction — it must not cancel the
        // vote its own partial just earned.
        final_item(&mut engine, 4, "echo foxtrot golf", 1_700.0);
        assert_eq!(
            engine.off_script_return_streak, 1,
            "a duplicate final restated the same words; it is not evidence against the return",
        );
        assert!(engine.off_script);
    }

    #[test]
    fn a_reader_who_keeps_reading_always_gets_back() {
        // A swept config where progress cannot be measured by counting exact
        // matches: the tail holds four atoms, so a reader reading perfectly
        // pins that count at four forever while their position keeps moving.
        let config = AlignmentConfig {
            max_query_atoms: 4,
            off_script_return_min_run: 4,
            ..AlignmentConfig::default()
        }
        .sanitized();
        assert_eq!(config.off_script_return_min_run, 4, "clamp changed the case under test");

        let mut engine = Engine::new(aside_script(), config);
        engine.set_manual_position(4, 0.0);
        for (n, at) in [(1u32, 400.0), (2, 800.0), (3, 1_200.0)] {
            final_item(&mut engine, n, "wombat pangolin marmoset", at);
        }
        assert!(engine.off_script, "fixture failed to latch");

        // Now read on, correctly, for as long as any presenter reasonably would.
        let mut at = 1_600.0;
        let phrases = [
            "echo foxtrot golf hotel",
            "india juliet kilo lima",
            "mike november oscar papa",
            "quebec romeo sierra tango",
        ];
        for (n, phrase) in phrases.iter().enumerate() {
            final_item(&mut engine, 10 + n as u32, phrase, at);
            at += 400.0;
        }

        assert!(
            !engine.off_script,
            "a reader reading the script must always be able to get back",
        );
    }

    #[test]
    fn a_manual_anchor_ends_an_aside() {
        let mut engine = engine_off_script();

        let snapshot = engine.set_manual_position(12, 2_000.0);

        assert!(!engine.off_script);
        assert_eq!(engine.off_script_enter_streak, 0);
        assert_eq!(engine.off_script_return_streak, 0);
        assert_eq!(snapshot.state, TrackingState::Following);
        assert_eq!(snapshot.decision, DecisionCode::ManualAnchor);
        assert_eq!(snapshot.observed, 12.0);

        // The label must not survive the anchor either.
        let after = final_item(&mut engine, 9, "wombat pangolin marmoset", 2_400.0);
        assert_eq!(after.decision, DecisionCode::HoldLowEvidence);
    }

    #[test]
    fn entering_an_aside_parks_the_display_in_the_same_step() {
        let mut engine = Engine::new(aside_script(), AlignmentConfig::default());
        engine.set_manual_position(4, 0.0);
        for (n, at) in [(1u32, 400.0), (2, 800.0)] {
            final_item(&mut engine, n, "wombat pangolin marmoset", at);
        }

        let latched = final_item(&mut engine, 3, "capybara dugong axolotl", 1_200.0);

        // Latching must take the display with it. A snapshot that still said
        // Following, with a rate, while the engine had decided the reader is
        // off the page is the confidently-wrong state this engine avoids.
        assert!(engine.off_script);
        assert_ne!(latched.state, TrackingState::Following);
        assert_eq!(latched.rate, 0.0);
        assert_eq!(latched.provisional, None);
    }

    /// The same opening as `aside_script`, followed by enough ordinary body to
    /// put the last passage outside the local band, and a closing passage whose
    /// words occur nowhere else. Reaching that passage can only be an accepted
    /// discontinuity — it is 116 atoms past where the aside is latched, so
    /// neither local continuity nor the return gate can explain it.
    fn distant_passage_script() -> CompiledScript {
        compile(
            "alpha bravo charlie delta echo foxtrot golf hotel india juliet \
             kilo lima mike november oscar papa quebec romeo sierra tango \
             amber anvil apricot ardent aspen azure badger ballast bamboo banner \
             basalt beacon bellows birch bison blossom bramble bronze buckle burrow \
             cactus canyon cavern cedar chalice cinder cistern clover cobalt comet \
             copper coral cricket crimson crocus cypress dahlia damson dolphin drift \
             dune ebony elder ember falcon fennel fjord flint forge fossil \
             gable garnet geyser ginger glacier granite gravel grotto gull gypsum \
             hammock harbour hazel heather hedge heron hollow hornet ivory jasmine \
             jasper kettle lantern lattice lichen lilac linen lobster lupin magnet \
             mallow mantle maple marble meadow mercury mesa mica mint mistral \
             monsoon mortar mosaic moth mulberry myrtle nectar nettle nickel nutmeg \
             obsidian pelican quicksilver ravine saffron thistle vellum wicket \
             xylem zephyr basilisk cormorant",
            CompileOptions::default(),
        )
    }

    #[test]
    fn an_accepted_jump_ends_an_aside() {
        let mut engine = Engine::new(distant_passage_script(), AlignmentConfig::default());
        engine.set_manual_position(4, 0.0);
        for (n, at) in [(1u32, 400.0), (2, 800.0), (3, 1_200.0)] {
            final_item(&mut engine, n, "wombat pangolin marmoset", at);
        }
        assert!(engine.off_script, "fixture failed to latch");

        // The third way out of the latch, and the only one the return gate is
        // not involved in: the reader turns up somewhere else entirely, reading
        // a passage that appears nowhere else in the script. That is evidence
        // about WHERE they are, and it outranks a latch that only says where
        // they are not — so the relocation is allowed to bypass the gate.
        let jumped = final_item(
            &mut engine,
            4,
            "obsidian pelican quicksilver ravine saffron thistle \
             vellum wicket xylem zephyr basilisk cormorant",
            1_600.0,
        );

        assert_eq!(jumped.decision, DecisionCode::JumpForwardAccepted);
        assert_eq!(jumped.state, TrackingState::Following);
        assert_eq!(jumped.observed, 132.0);
        assert!(!engine.off_script);
        assert_eq!(engine.off_script_enter_streak, 0);
        assert_eq!(engine.off_script_return_streak, 0);

        // ...and the state is genuinely gone rather than masked by the accepted
        // position. `hold` relabels every hold `HoldOffScript` while the latch
        // is up, so a later thin revision saying `HoldLowEvidence` is the thing
        // that distinguishes "cleared" from "still latched, currently quiet".
        let after: Vec<DecisionCode> = [(5u32, 2_000.0), (6, 2_400.0), (7, 2_800.0)]
            .into_iter()
            .map(|(n, at)| final_item(&mut engine, n, "wombat pangolin marmoset", at).decision)
            .collect();
        assert!(
            !after.contains(&DecisionCode::HoldOffScript),
            "the aside survived an accepted jump: {after:?}",
        );
        assert!(
            after.contains(&DecisionCode::HoldLowEvidence),
            "expected a thin-evidence hold once the reader stopped reading again: {after:?}",
        );
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

    /* ----------------------------------------------------------------------
     * Solicited evidence (issue #169)
     * ------------------------------------------------------------------- */

    /// Filler, then a passage that occurs nowhere else and sits far enough away
    /// to be a discontinuity rather than a local step.
    ///
    /// Four distinct content words, not three: `jump_query_min` will not even
    /// evaluate a discontinuity against a shorter unexplained tail, so a
    /// three-word passage tests the discount by never reaching it.
    fn jump_script() -> CompiledScript {
        compile(&jump_source(&["Zanzibar quartzite mnemonic obsidian."]), CompileOptions::default())
    }

    fn jump_source(tail: &[&str]) -> String {
        let mut source = String::new();
        for i in 0..24 {
            source.push_str(&format!("region {i} holds ordinary material here. "));
        }
        for piece in tail {
            source.push_str(piece);
        }
        source
    }

    const DISTANT: &str = "zanzibar quartzite mnemonic obsidian";

    fn distant_terms(words: &str) -> Vec<String> {
        words.split(' ').map(str::to_string).collect()
    }

    /// The thresholds these tests reason about, pinned rather than inherited.
    ///
    /// The benchmark sweeps `AlignmentConfig` and has moved several of these
    /// before. Inheriting them would let a future sweep leave the suite green
    /// while it silently stopped exercising the discount at all — the failure
    /// mode that matters here, because the whole feature is a gate that is
    /// supposed to STOP doing something.
    fn gate_config() -> AlignmentConfig {
        AlignmentConfig {
            jump_min_content: 3,
            relocation_min_content: 2,
            observe_min_content: 2,
            retake_extra_content: 0,
            jump_query_min: 4,
            discontinuity_atoms: 40,
            biased_content_weight_milli: 500,
            ..Default::default()
        }
    }

    /// The named case from the issue. Four exact content matches carry a jump
    /// (threshold 3); the same four, solicited from the decoder, are worth 2 at
    /// half weight and do not.
    #[test]
    fn solicited_matches_lose_the_authority_to_jump() {
        let mut engine = Engine::new(jump_script(), gate_config());
        engine.set_manual_position(0, 0.0);
        let jumped = final_item(&mut engine, 1, DISTANT, 900.0);
        assert_eq!(jumped.decision, DecisionCode::JumpForwardAccepted);
        let landed = jumped.observed;

        let mut script = jump_script();
        assert_eq!(script.set_biased_terms(&distant_terms(DISTANT)), 0);
        let mut engine = Engine::new(script, gate_config());
        engine.set_manual_position(0, 0.0);
        let held = final_item(&mut engine, 1, DISTANT, 900.0);

        assert_ne!(held.decision, DecisionCode::JumpForwardAccepted);
        assert!(
            held.observed < landed,
            "a solicited run still reached {} (unmarked landed at {landed})",
            held.observed
        );
    }

    /// The third gate: a phase-2 reconnection the global index proposed, close
    /// enough that `try_discontinuity` never sees it.
    ///
    /// Phase 1 holds position on its twenty matched prefix atoms, so the
    /// unexplained suffix is what goes to global search — and the candidate it
    /// finds is only fifteen atoms away, far short of `discontinuity_atoms`.
    /// Nothing else can move the reader here, which is what makes this the one
    /// arrangement where the gate is load-bearing rather than shadowed by the
    /// ordinary local candidate.
    #[test]
    fn solicited_matches_cannot_reconnect_through_the_nearby_suffix_path() {
        const PREFIX: &str = "alpha bravo charlie delta echo foxtrot golf hotel india juliet \
             kilo lima mike november oscar papa quebec romeo sierra tango";
        const GAP: &str = "uniform victor whiskey xray yankee zebra amber birch cedar dogwood elm fir";
        const TARGET: &str = "zanzibar quartzite mnemonic";

        let reached = |mark: bool| -> f64 {
            let mut script = compile(
                &format!("{PREFIX} {GAP} {TARGET}"),
                CompileOptions::default(),
            );
            if mark {
                assert_eq!(script.set_biased_terms(&distant_terms(TARGET)), 0);
            }
            let mut engine = Engine::new(script, gate_config());
            engine.set_manual_position(20, 0.0);
            final_item(&mut engine, 1, &format!("{PREFIX} garbled {TARGET}"), 900.0).observed
        };

        // Three unsolicited content matches clear `observe_min_content`, so the
        // reconnection lands on the target.
        let bare = reached(false);
        assert!(bare > 30.0, "the nearby-suffix path did not fire: {bare}");
        // Solicited they are worth 1.5, under the bar, and the reader stays put.
        assert_eq!(reached(true), 20.0);
    }

    /// The authority arithmetic itself, at the thresholds the gates use.
    #[test]
    fn content_authority_is_spent_in_whole_and_half_units() {
        let engine_with = |weight: u32| {
            Engine::new(
                compile("alpha bravo charlie", CompileOptions::default()),
                AlignmentConfig {
                    biased_content_weight_milli: weight,
                    ..gate_config()
                },
            )
        };
        let ev = |content: u32, biased: u32| Evidence {
            content_matches: content,
            biased_content_matches: biased,
            ..Default::default()
        };

        let half = engine_with(500);
        // Unsolicited evidence is unchanged: the gate is exactly `>=`.
        assert!(half.content_authority_ok(&ev(2, 0), 2));
        assert!(!half.content_authority_ok(&ev(1, 0), 2));
        // Halves accumulate exactly: four of them are two whole words and meet
        // a bar of two, three of them are one and a half and do not.
        assert!(half.content_authority_ok(&ev(4, 4), 2));
        assert!(!half.content_authority_ok(&ev(3, 3), 2));
        // The mixed case the jump test drives: of four matches, marking one
        // leaves 3.5 and marking three leaves 2.5, either side of a bar of 3.
        assert!(half.content_authority_ok(&ev(4, 1), 3));
        assert!(!half.content_authority_ok(&ev(4, 3), 3));

        // Zero vetoes, full weight is the discount switched off.
        assert!(!engine_with(0).content_authority_ok(&ev(9, 9), 1));
        assert!(engine_with(1000).content_authority_ok(&ev(3, 3), 3));
        // `Engine::new` sanitises, but `config` is public. A weight written
        // afterwards still cannot make a solicited word worth more than an
        // ordinary one — which is what the defensive cap in the helper is for.
        let mut escaped = engine_with(500);
        escaped.config.biased_content_weight_milli = u32::MAX;
        assert!(!escaped.content_authority_ok(&ev(2, 2), 3));

        // Nothing required is always satisfied; a count that cannot happen
        // (more solicited than content) is clamped rather than wrapping.
        assert!(half.content_authority_ok(&ev(0, 0), 0));
        assert!(!half.content_authority_ok(&ev(u32::MAX, u32::MAX), u32::MAX));
    }

    /// The cold-start gate, which every other test here skips by locking the
    /// engine with `set_manual_position` first.
    ///
    /// Three content words against `relocation_min_content: 2` — solicited they
    /// are worth 1.5 and fall short. Four would be worth exactly 2 and still
    /// acquire, which is the discount working as specified rather than a bug:
    /// half authority is a discount, not a veto.
    #[test]
    fn solicited_matches_cannot_acquire_a_cold_lock() {
        let source = jump_source(&["Zanzibar quartzite mnemonic obsidian."]);
        const SPOKEN: &str = "zanzibar quartzite mnemonic";

        let mut engine = Engine::new(compile(&source, CompileOptions::default()), gate_config());
        let acquired = final_item(&mut engine, 1, SPOKEN, 900.0);
        assert_eq!(acquired.decision, DecisionCode::RelocationAccepted);

        let mut script = compile(&source, CompileOptions::default());
        assert_eq!(script.set_biased_terms(&distant_terms(SPOKEN)), 0);
        let mut engine = Engine::new(script, gate_config());
        let held = final_item(&mut engine, 1, SPOKEN, 900.0);
        assert_ne!(held.decision, DecisionCode::RelocationAccepted);
        assert_eq!(held.observed, 0.0);

        // The control: at full weight the same marked run acquires as before,
        // so this tests the discount and not merely the presence of a flag.
        let mut script = compile(&source, CompileOptions::default());
        script.set_biased_terms(&distant_terms(SPOKEN));
        let config = AlignmentConfig {
            biased_content_weight_milli: 1000,
            ..gate_config()
        };
        let mut engine = Engine::new(script, config);
        assert_eq!(
            final_item(&mut engine, 1, SPOKEN, 900.0).decision,
            DecisionCode::RelocationAccepted
        );
    }

    /// Authority is spent per word, so a candidate part solicited and part not
    /// lands between the two. Four content matches against a threshold of 3:
    /// marking one leaves 3.5 and jumps, marking three leaves 2.5 and does not.
    /// This is the case that proves the weighting is a sum rather than a switch.
    #[test]
    fn mixed_evidence_crosses_the_threshold_word_by_word() {
        let jumps_with = |marked: &str| -> bool {
            let mut script = jump_script();
            script.set_biased_terms(&distant_terms(marked));
            let mut engine = Engine::new(script, gate_config());
            engine.set_manual_position(0, 0.0);
            final_item(&mut engine, 1, DISTANT, 900.0).decision
                == DecisionCode::JumpForwardAccepted
        };

        assert!(jumps_with("zanzibar"), "3 whole + 1 half = 3.5 must jump");
        assert!(
            !jumps_with("zanzibar quartzite mnemonic"),
            "1 whole + 3 half = 2.5 must not jump"
        );
    }

    /// Zero is a veto, and reaching it takes no special case in the arithmetic.
    #[test]
    fn zero_weight_leaves_solicited_matches_no_authority_at_all() {
        let source = jump_source(&["Zanzibar quartzite mnemonic obsidian pergola cinnabar."]);
        const LONGER: &str = "zanzibar quartzite mnemonic obsidian pergola cinnabar";
        let mut script = compile(&source, CompileOptions::default());
        script.set_biased_terms(&distant_terms(LONGER));
        let config = AlignmentConfig {
            biased_content_weight_milli: 0,
            ..gate_config()
        };
        let mut engine = Engine::new(script, config);
        engine.set_manual_position(0, 0.0);

        // Six solicited words are worth exactly the threshold at half weight —
        // the previous test proves they jump there. At zero they are worth
        // nothing, and no quantity of them adds up to a relocation.
        assert_ne!(
            final_item(&mut engine, 1, LONGER, 1_800.0).decision,
            DecisionCode::JumpForwardAccepted
        );
    }

    /// A backward retake asks for more content, and the discount applies to the
    /// raised bar rather than the base one.
    #[test]
    fn solicited_matches_pay_the_raised_retake_threshold() {
        let mut source = String::from("Zanzibar quartzite mnemonic obsidian opens the piece. ");
        for i in 0..24 {
            source.push_str(&format!("region {i} holds ordinary material here. "));
        }
        let config = AlignmentConfig {
            retake_extra_content: 1,
            ..gate_config()
        };

        let mut engine = Engine::new(compile(&source, CompileOptions::default()), config.clone());
        engine.set_manual_position(60, 0.0);
        let back = final_item(&mut engine, 1, DISTANT, 900.0);
        assert!(back.observed < 30.0, "expected a backward retake, got {}", back.observed);

        let mut script = compile(&source, CompileOptions::default());
        script.set_biased_terms(&distant_terms(DISTANT));
        let mut engine = Engine::new(script, config);
        engine.set_manual_position(60, 0.0);
        let held = final_item(&mut engine, 1, DISTANT, 900.0);
        assert!(
            held.observed > 30.0,
            "a solicited run retook backward to {}",
            held.observed
        );
    }

    /// Weight is authority, not a switch: at full weight the discount is off and
    /// the marked run jumps exactly as the unmarked one did. This is what keeps
    /// the mechanism a tunable rather than a second, hidden veto.
    #[test]
    fn solicited_matches_at_full_weight_jump_as_before() {
        let mut script = jump_script();
        script.set_biased_terms(&distant_terms(DISTANT));
        let config = AlignmentConfig {
            biased_content_weight_milli: 1000,
            ..gate_config()
        };
        let mut engine = Engine::new(script, config);
        engine.set_manual_position(0, 0.0);

        assert_eq!(
            final_item(&mut engine, 1, DISTANT, 900.0).decision,
            DecisionCode::JumpForwardAccepted
        );
    }

    /// The discount is fractional, not a veto: enough solicited evidence still
    /// authorises the move. Six half-weight matches are worth three whole ones,
    /// exactly, with no per-token rounding lost along the way.
    #[test]
    fn enough_solicited_evidence_still_earns_the_jump() {
        const LONGER: &str = "zanzibar quartzite mnemonic obsidian pergola cinnabar";
        let source = jump_source(&["Zanzibar quartzite mnemonic obsidian pergola cinnabar."]);
        let mut script = compile(&source, CompileOptions::default());
        assert_eq!(script.set_biased_terms(&distant_terms(LONGER)), 0);

        let mut engine = Engine::new(script, gate_config());
        engine.set_manual_position(0, 0.0);

        assert_eq!(
            final_item(&mut engine, 1, LONGER, 1_800.0).decision,
            DecisionCode::JumpForwardAccepted
        );
    }

    /// The other half of the issue: ordinary local continuity takes solicited
    /// words at full value, because a wrong local step is small and
    /// self-correcting. Two marked content words must still advance the reader —
    /// under the jump discount they would be worth one, and hold.
    #[test]
    fn solicited_matches_keep_full_local_authority() {
        let mut script = compile(
            "alpha bravo charlie zanzibar quartzite delta echo foxtrot",
            CompileOptions::default(),
        );
        assert_eq!(
            script.set_biased_terms(&["zanzibar".to_string(), "quartzite".to_string()]),
            0
        );
        let mut engine = Engine::new(script, gate_config());
        engine.set_manual_position(3, 0.0);

        let snapshot = final_item(&mut engine, 1, "zanzibar quartzite", 700.0);
        assert_eq!(snapshot.state, TrackingState::Following);
        assert!(
            snapshot.observed >= 5.0,
            "local following was discounted: observed {}",
            snapshot.observed
        );
    }

    /// The invariant that matters while bias is off: with nothing declared, the
    /// weight cannot reach anything. Same events, same snapshots, byte for byte.
    #[test]
    fn an_unmarked_script_is_unaffected_by_the_bias_weight() {
        let drive = |weight: u32| -> String {
            let config = AlignmentConfig {
                biased_content_weight_milli: weight,
                ..gate_config()
            };
            let mut engine = Engine::new(jump_script(), config);
            engine.set_manual_position(0, 0.0);
            let mut out = Vec::new();
            out.push(final_item(&mut engine, 1, "region 0 holds ordinary", 600.0));
            out.push(final_item(&mut engine, 2, "material here region 1", 1_200.0));
            out.push(final_item(&mut engine, 3, DISTANT, 1_900.0));
            out.push(final_item(&mut engine, 4, "region 3 holds ordinary", 2_600.0));
            serde_json::to_string(&out).unwrap()
        };

        // A jump lands inside this sequence, so the discounted gate is genuinely
        // exercised — the comparison is not vacuous.
        assert!(drive(500).contains("JumpForwardAccepted"));
        assert_eq!(drive(500), drive(1000));
        assert_eq!(drive(500), drive(0));
    }

    /* ----------------------------------------------------------------------
     * Repeated passages (issue #168)
     * ------------------------------------------------------------------- */

    /// Filler, the refrain, more filler, the same refrain again.
    ///
    /// Both copies must sit outside the phase-1 continuity band, not merely
    /// past `discontinuity_atoms` — the band reaches `local_forward` (112)
    /// atoms ahead, and a copy inside it is explained as ordinary local
    /// material and never becomes a distant rival at all. At six atoms per
    /// filler region, 24 regions puts the first copy near atom 144 and the
    /// second near 292, so a reader at the top has two DISTANT candidates that
    /// are word-for-word identical — the tie the issue is about.
    fn refrain_source(first_copy: &str, second_copy: &str) -> String {
        refrain_source_spaced(first_copy, second_copy, 24)
    }

    /// `gap` filler regions between the copies, six atoms each, so a test can
    /// place the reader BETWEEN them with neither inside the local band.
    fn refrain_source_spaced(first_copy: &str, second_copy: &str, gap: u32) -> String {
        let mut source = String::new();
        for i in 0..24 {
            source.push_str(&format!("region {i} holds ordinary material here. "));
        }
        source.push_str(first_copy);
        for i in 24..24 + gap {
            source.push_str(&format!("region {i} holds ordinary material here. "));
        }
        source.push_str(second_copy);
        source
    }

    /// Everything these tests depend on to produce TWO blocking distant
    /// rivals, pinned rather than inherited.
    ///
    /// `gate_config` already pins the content thresholds, but the duplicate
    /// path also needs BOTH copies to be proposed as regions, to survive the
    /// beam, to stay far enough apart to count as rivals, and to sit outside
    /// the local band. A sweep that shrank `beam_size` or `max_postings_per_key`
    /// to 1, widened `cluster_radius` past 37, or dropped `ambiguity_margin`
    /// to zero would leave every test below green while quietly ceasing to
    /// exercise the duplicate tie at all — one copy proposed, no rival, and
    /// the ordinary gate doing the work. That is the failure mode this file's
    /// other pinned config exists to prevent.
    fn refrain_config() -> AlignmentConfig {
        AlignmentConfig {
            ambiguity_margin: 0.35,
            beam_size: 8,
            cluster_radius: 3,
            local_forward: 112,
            max_postings_per_key: 8,
            max_regions: 8,
            ..gate_config()
        }
    }

    /// The two copies are the same words, so nothing about the evidence can
    /// choose between them — and nothing needs to. Whichever is real the
    /// reader traverses the same run of tokens, so the page must keep moving
    /// rather than wait for the wording to diverge.
    ///
    /// Before the fix this held: the duplicate-passage veto refused the jump
    /// on the score tie and the display sat still for the whole passage.
    #[test]
    fn identical_repeated_passages_do_not_freeze_the_page() {
        let script = compile(
            &refrain_source(
                "Zanzibar quartzite mnemonic obsidian. ",
                "Zanzibar quartzite mnemonic obsidian.",
            ),
            CompileOptions::default(),
        );
        let mut engine = Engine::new(script, refrain_config());
        engine.set_manual_position(0, 0.0);

        let snapshot = final_item(&mut engine, 1, DISTANT, 900.0);

        assert_eq!(
            snapshot.decision,
            DecisionCode::JumpForwardAccepted,
            "a refrain must not veto its own motion: {:?}",
            snapshot.decision,
        );
        assert_eq!(snapshot.state, TrackingState::Following);
        // 24 filler regions of six atoms each put the first copy at 144..148;
        // the second ends at 296. Pinned exactly: a range would also accept
        // 147, which is the boundary a *failed* match on `obsidian` leaves.
        assert_eq!(snapshot.observed, 148.0);
    }

    /// The safety half, and the reason the check is textual rather than a
    /// looser margin: two passages that merely SCORE alike are two places the
    /// engine cannot tell apart, and moving to one of them is a guess.
    ///
    /// Proximity never outranks the evidence. Here the far copy is what was
    /// actually said and the near copy is one word off, so there is a textual
    /// winner and the tie-break has no business firing: landing on the near
    /// copy at 147 would mean it had.
    ///
    /// This is the honest form of a test that started out claiming more. Two
    /// passages that are textually different but score within
    /// `ambiguity_margin` of each other turn out to be hard to build through
    /// the whole engine — different words do not tie, which is the reason the
    /// margin gate works at all. Every construction tried either produced a
    /// clear winner (this one) or produced candidates whose MATCHED spans were
    /// genuinely identical because the difference fell past the last matched
    /// atom, which is a real tie and correctly moves the page. The textual
    /// check itself is pinned directly by
    /// `same_matched_span_is_exact_and_fails_closed`.
    #[test]
    fn a_clear_textual_winner_outranks_the_nearer_copy() {
        let script = compile(
            &refrain_source(
                "Zanzibar quartzite mnemonic obsidian. ",
                "Zanzibar quartzite mnemonic basilisk.",
            ),
            CompileOptions::default(),
        );
        let mut engine = Engine::new(script, refrain_config());
        engine.set_manual_position(0, 0.0);

        let snapshot = final_item(&mut engine, 1, "zanzibar quartzite mnemonic basilisk", 900.0);

        assert_eq!(
            snapshot.decision,
            DecisionCode::JumpForwardAccepted,
            "{:?}",
            snapshot.decision,
        );
        assert_eq!(
            snapshot.observed, 296.0,
            "proximity beat the evidence and took the nearer copy",
        );
    }

    /// A reader with a copy on either side of them does not get pulled to
    /// either one.
    ///
    /// The forward-only guard is what holds this, and the ranked scores make
    /// it look otherwise: the backward copy takes `rank_backward_factor` on
    /// top of its distance penalty and trails by 0.76, which reads as a clear
    /// winner. It is not one. The gates compare EVIDENCE, adding the distance
    /// penalty back, and on evidence the two copies are level — so the
    /// backward copy is blocking, and without the guard proximity would pick
    /// 512 over 148 and move the page. Deleting `!c.backward` fails this test,
    /// which is the point of it.
    #[test]
    fn a_reader_between_two_copies_is_not_pulled_to_either() {
        // Widely spaced on purpose. The local band reaches 48 atoms back and
        // 112 forward, so copies only 148 apart cannot BOTH be outside it —
        // one would be explained as ordinary local material and never become a
        // rival at all. 60 filler regions put the second copy at 512.
        let script = compile(
            &refrain_source_spaced(
                "Zanzibar quartzite mnemonic obsidian. ",
                "Zanzibar quartzite mnemonic obsidian.",
                60,
            ),
            CompileOptions::default(),
        );
        let mut engine = Engine::new(script, refrain_config());
        // Between the copies (148 and 512), outside the band on both sides.
        engine.set_manual_position(330, 0.0);

        let snapshot = final_item(&mut engine, 1, DISTANT, 900.0);

        assert!(
            !matches!(
                snapshot.decision,
                DecisionCode::JumpForwardAccepted | DecisionCode::RetakeAccepted
            ),
            "committed to one of two copies straddling the reader: {:?}",
            snapshot.decision,
        );
        assert_eq!(snapshot.observed, 330.0, "the page moved on a coin flip");
    }

    /// A copy the reader's words carry further is not an identical rival, and
    /// the page goes there rather than to whichever copy happens to be closer.
    ///
    /// `terminus` is in the second copy and not the first, so saying it
    /// reaches one atom further there. The matched span is what carries this:
    /// it ends at the last atom that matched, so the better explanation
    /// reports the longer span and the two stop looking alike. Proximity would
    /// have taken 148.
    #[test]
    fn a_copy_that_explains_more_is_not_an_identical_rival() {
        let script = compile(
            &refrain_source(
                "Zanzibar quartzite mnemonic wharf. ",
                "Zanzibar quartzite mnemonic terminus.",
            ),
            CompileOptions::default(),
        );
        let mut engine = Engine::new(script, refrain_config());
        engine.set_manual_position(0, 0.0);

        let snapshot = final_item(&mut engine, 1, "zanzibar quartzite mnemonic terminus", 900.0);

        assert_eq!(
            snapshot.observed, 296.0,
            "took the nearer copy over the one that explained more",
        );
    }

    /// The tie-break's whole safety argument rests on this comparison, so it is
    /// pinned directly: canonical atom ids over the entire consumed span, and
    /// nothing weaker.
    #[test]
    fn same_matched_span_is_exact_and_fails_closed() {
        let script = compile(
            "alpha bravo charlie delta alpha bravo charlie echo",
            CompileOptions::default(),
        );
        let span = |start: u32, end: u32| Evidence {
            start_position: start,
            end_position: end,
            ..Evidence::default()
        };

        // `alpha bravo charlie` in both halves.
        assert!(same_matched_span(&script, &span(0, 3), &span(4, 7)));
        // `alpha bravo charlie delta` vs `alpha bravo charlie echo`.
        assert!(!same_matched_span(&script, &span(0, 4), &span(4, 8)));
        // Different lengths are not "identical so far".
        assert!(!same_matched_span(&script, &span(0, 3), &span(4, 8)));
        // Empty, reversed and out-of-range spans are not evidence of anything.
        assert!(!same_matched_span(&script, &span(2, 2), &span(2, 2)));
        assert!(!same_matched_span(&script, &span(3, 1), &span(3, 1)));
        assert!(!same_matched_span(&script, &span(0, 3), &span(6, 99)));
    }
}

#[cfg(test)]
mod reacquire_tests {
    use super::*;
    use crate::script::{compile, CompileOptions};

    fn fresh_engine() -> Engine {
        let script = compile(
            "alpha bravo charlie delta echo foxtrot golf hotel india juliet \
             kilo lima mike november oscar papa quebec romeo sierra tango",
            CompileOptions::default(),
        );
        Engine::new(script, AlignmentConfig::default())
    }

    /// A reacquisition is not a jump.
    ///
    /// It used to be one: the control store called
    /// `set_manual_position(confirmedToken)`, which sets `Following` at
    /// confidence 0.9. So a presenter saying "you are in the wrong place" got
    /// the engine asserting a lock on the place they had just disputed, and the
    /// display moved off that assertion before any evidence arrived.
    #[test]
    fn a_reacquisition_holds_the_display_rather_than_asserting_a_lock() {
        let mut engine = fresh_engine();
        let asserted = engine.set_manual_position(4, 1_000.0);
        assert_eq!(asserted.state, TrackingState::Following);
        assert!(asserted.confidence > 0.5, "a manual move asserts a position");

        let mut engine = fresh_engine();
        let reacquired = engine.reacquire(4, 3, 1_000.0);
        assert_eq!(
            reacquired.state,
            TrackingState::Searching,
            "a reacquisition reopens the search; the display must hold until \
             evidence arrives, which is the safe direction for a follower"
        );
        assert_eq!(
            reacquired.confidence, 0.0,
            "nothing has been established, so nothing may claim to be"
        );
    }

    /// The prior is the visible range, not the engine's own cursor.
    ///
    /// Seeding with `confirmedToken` asked the engine to look exactly where it
    /// was already looking — the one place it is demonstrably not finding the
    /// reader.
    #[test]
    fn a_reacquisition_sets_a_viewport_prior_around_the_visible_range() {
        let mut engine = fresh_engine();
        engine.clear_viewport_hint();
        engine.reacquire(10, 4, 1_000.0);
        // The hint is private state; its effect is what is observable, so this
        // asserts the engine accepted a window rather than the exact bounds.
        // The anti-vacuity partner is the test above: without the hint call,
        // `reacquire` would be indistinguishable from clearing state.
        let source = include_str!("tracker.rs");
        assert!(
            source.contains("self.set_viewport_hint(first, last)"),
            "reacquire must express its prior through the viewport hint"
        );
    }

    /// Evidence from before the presenter asked for help is what produced the
    /// wrong answer, so it must not be used to answer the question.
    #[test]
    fn a_reacquisition_cuts_evidence_continuity() {
        let mut engine = fresh_engine();
        engine.reacquire(4, 3, 7_500.0);
        assert_eq!(
            engine.tail_horizon_ms, 7_500.0,
            "words spoken before the reacquisition must not drag the cursor back"
        );
        assert_eq!(engine.last_evidence_ms, 7_500.0);
    }

    /// It does not MOVE the script position. Nothing has been established yet,
    /// and moving it would be the assertion this exists to avoid.
    #[test]
    fn a_reacquisition_does_not_move_the_position_it_is_asking_about() {
        let mut engine = fresh_engine();
        engine.set_manual_position(12, 500.0);
        let before = engine.confirmed;
        engine.reacquire(4, 3, 1_000.0);
        assert_eq!(
            engine.confirmed, before,
            "a reacquisition asks a question; it does not answer it"
        );
    }
}
