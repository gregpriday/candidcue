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
    /// Estimated reading rate for display extrapolation (atoms/sec). Zero
    /// whenever extrapolating would be a guess (holding/searching/ambiguous).
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
    /// Heuristic 0..1 — NOT yet a calibrated probability; benchmarked as-is.
    pub confidence: f64,
    /// A distant candidate accumulating evidence (the "Suggest jump"
    /// interaction state): the UI may offer "possible match below — resume
    /// here?" instead of teleporting. None while following normally.
    pub suggestion: Option<f64>,
    /// Total spoken atoms in the script — the hard ceiling for `display_at`.
    pub script_len: f64,
}

impl Snapshot {
    /// Where the display should place the reader at audio-clock time `t`.
    /// This is the pure function the stage motion layer (and the evaluator)
    /// applies between snapshots.
    pub fn display_at(&self, t_audio_ms: f64) -> f64 {
        if self.rate <= 0.0 {
            return self.observed;
        }
        let age = (t_audio_ms - self.evidence_audio_ms).max(0.0);
        let onset = self.pause_onset_ms.min(self.max_prediction_ms);
        // While evidence is fresh the lead grows 1:1 (pipeline-lag
        // compensation). Once it goes stale — the reader has probably
        // paused — the lead eases back to a one-word rest instead of
        // parking five words ahead of someone who stopped talking.
        let lead = if age <= onset {
            age
        } else {
            (onset - (age - onset)).max(self.lead_floor_ms.min(onset))
        };
        (self.observed + self.rate * lead / 1000.0).min(self.script_len)
    }
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
                self.ledger
                    .revise(&mut self.script.interner, &item_id, &text, false, audio_ms);
                self.update(audio_ms)
            }
            SessionEvent::Final {
                item_id,
                text,
                audio_end_ms,
            } => {
                self.ledger
                    .revise(&mut self.script.interner, &item_id, &text, true, audio_end_ms);
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
                    if evidence.exact_matches + evidence.fuzzy_matches == 0 {
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
            .filter(|q| !q.filler && !crate::normalize::is_stopword(&q.surface))
            .count();

        let local_ok = local_candidate
            .as_ref()
            .map(|c| {
                c.evidence.fidelity >= self.config.observe_min_fidelity
                    && c.evidence.coverage >= self.config.observe_min_coverage
                    && c.evidence.content_matches >= self.config.observe_min_content
            })
            .unwrap_or(false);
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

        match local_candidate {
            // A phase-1 result far from the observed position (possible with
            // a very short tail and the band's free start) is a relocation
            // claim, and relocation claims go through the discontinuity
            // machinery — never through the cheap local gate.
            Some(local)
                if local.distance <= self.config.discontinuity_atoms as f64
                    && !(local.backward && local.distance > 6.0) =>
            {
                self.decide_local(local, f64::INFINITY, now_ms)
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

    fn decide_local(&mut self, best: Candidate, margin: f64, now_ms: f64) -> Snapshot {
        let c = self.config.clone();
        let ev = &best.evidence;
        let ambiguous = margin < c.ambiguity_margin;
        if ambiguous {
            self.state = TrackingState::Ambiguous;
            self.confidence = (self.confidence * 0.7).max(0.05);
            return self.snapshot(DecisionCode::HoldAmbiguous, self.last_evidence_ms, now_ms);
        }
        let passes = ev.fidelity >= c.observe_min_fidelity
            && ev.coverage >= c.observe_min_coverage
            && ev.content_matches >= c.observe_min_content;
        if !passes {
            // Off-script speech looks exactly like this: insertions dominate.
            let code = if ev.insertions > ev.exact_matches {
                DecisionCode::HoldOffScript
            } else {
                DecisionCode::HoldLowEvidence
            };
            return self.hold(code, now_ms);
        }

        let evidence_ms = self.evidence_time(ev, now_ms);
        self.accept(ev.end_position as f64, evidence_ms, false);
        self.state = TrackingState::Following;
        self.confidence = confidence_of(ev, margin);

        // Confirmed advancement: finals confirm outright; partials confirm
        // when enough *stable* content matched, and only up to the stable
        // portion of the evidence.
        let is_final_evidence = self
            .ledger
            .current_item()
            .map(|i| i.is_final)
            .unwrap_or(false);
        let mut decision = DecisionCode::LocalObserved;
        if ev.fidelity >= c.confirm_min_fidelity {
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
        if !matches!(self.state, TrackingState::Searching) {
            self.state = TrackingState::Holding;
        }
        self.confidence = (self.confidence * 0.8).max(0.05);
        self.snapshot(code, self.last_evidence_ms, now_ms)
    }

    fn snapshot(&mut self, decision: DecisionCode, evidence_ms: f64, now_ms: f64) -> Snapshot {
        self.seq += 1;
        // Speech is "flowing" only while an open utterance is producing
        // words. A final means the provider's VAD saw silence: park the
        // display exactly where the reader stopped. An empty just-opened
        // item parks too — extrapolating from stale evidence the moment
        // speechStarted fires would leap the whole horizon at once.
        let flowing = self
            .ledger
            .current_item()
            .map(|i| !i.is_final)
            .unwrap_or(false);
        let rate = match self.state {
            TrackingState::Following if flowing => self.rate,
            _ => 0.0,
        };
        Snapshot {
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
            confidence: self.confidence,
            suggestion: self.pending_jump.as_ref().map(|p| p.target as f64),
            script_len: self.script.len() as f64,
        }
    }
}

fn confidence_of(ev: &Evidence, margin: f64) -> f64 {
    let base = 0.5 * ev.fidelity
        + 0.3 * ev.coverage
        + 0.2 * (ev.stable_content_matches.min(5) as f64 / 5.0);
    let margin_factor = (margin / 2.0).clamp(0.5, 1.0);
    (base * margin_factor).clamp(0.0, 1.0)
}
