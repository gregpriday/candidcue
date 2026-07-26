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
    /// Heuristic 0..1 — NOT yet a calibrated probability; benchmarked as-is.
    pub confidence: f64,
}

impl Snapshot {
    /// Where the display should place the reader at audio-clock time `t`.
    /// This is the pure function the stage motion layer (and the evaluator)
    /// applies between snapshots.
    pub fn display_at(&self, t_audio_ms: f64) -> f64 {
        if self.rate <= 0.0 {
            return self.observed;
        }
        let horizon = (t_audio_ms - self.evidence_audio_ms).clamp(0.0, self.max_prediction_ms);
        self.observed + self.rate * horizon / 1000.0
    }
}

#[derive(Debug, Clone)]
struct Candidate {
    evidence: Evidence,
    score: f64,
    /// Distance (atoms) from the predicted position; f64::INFINITY when the
    /// tracker has no lock.
    distance: f64,
    backward: bool,
}

#[derive(Debug, Clone)]
struct PendingJump {
    target: u32,
    count: u8,
    backward: bool,
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
    /// Region scratch reused across events.
    regions: Vec<(u32, u32)>,
}

impl Engine {
    pub fn new(script: CompiledScript, config: AlignmentConfig) -> Self {
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
        self.confidence = 0.9;
        self.last_evidence_ms = at_audio_ms;
        self.snapshot(DecisionCode::ManualAnchor, at_audio_ms, at_audio_ms)
    }

    pub fn handle(&mut self, event: SessionEvent) -> Snapshot {
        match event {
            SessionEvent::ItemStarted {
                item_id,
                audio_start_ms,
            } => {
                self.ledger.item_started(&item_id, audio_start_ms);
                self.snapshot(DecisionCode::NoEvidence, audio_start_ms, audio_start_ms)
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
        let query = self.ledger.tail(self.config.max_query_atoms);
        if query.is_empty() {
            return self.snapshot(DecisionCode::NoEvidence, now_ms, now_ms);
        }

        let locked = !matches!(self.state, TrackingState::Searching);
        let predicted = if locked {
            let dt = ((now_ms - self.config.emission_lag_ms) - self.last_evidence_ms).max(0.0);
            (self.observed + self.rate * dt / 1000.0).min(self.script.len() as f64)
        } else {
            self.observed
        };

        self.build_regions(&query, predicted, locked);

        // Align every region, keep the best candidate per region.
        let mut candidates: Vec<Candidate> = Vec::with_capacity(self.regions.len());
        let regions = std::mem::take(&mut self.regions);
        for &(start, end) in &regions {
            if let Some(evidence) = align(
                &self.script,
                &query,
                start,
                end,
                &self.config,
                &mut self.scratch,
            ) {
                if evidence.exact_matches + evidence.fuzzy_matches == 0 {
                    continue;
                }
                let distance = if locked {
                    (evidence.end_position as f64 - predicted).abs()
                } else {
                    f64::INFINITY
                };
                let backward = (evidence.end_position as f64) < predicted;
                let score = self.rank(&evidence, predicted, locked);
                candidates.push(Candidate {
                    evidence,
                    score,
                    distance,
                    backward,
                });
            }
        }
        self.regions = regions;

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

        let best = clusters[0].clone();
        // The strongest *distant* competitor to the best cluster.
        let competitor = clusters
            .iter()
            .skip(1)
            .find(|c| {
                (c.evidence.end_position as i64 - best.evidence.end_position as i64).unsigned_abs()
                    > self.config.discontinuity_atoms as u64
            })
            .cloned();
        let margin = competitor
            .as_ref()
            .map(|c| best.score - c.score)
            .unwrap_or(f64::INFINITY);

        if !locked {
            return self.decide_relocation(best, margin, now_ms);
        }

        let local = best.distance <= self.config.discontinuity_atoms as f64;
        if local {
            self.pending_jump = None;
            self.decide_local(best, margin, now_ms)
        } else {
            // The best explanation is far away. The best local cluster (if
            // any) is what we compare it against.
            let best_local = clusters
                .iter()
                .find(|c| c.distance <= self.config.discontinuity_atoms as f64)
                .cloned();
            self.decide_discontinuity(best, best_local, now_ms)
        }
    }

    fn decide_relocation(&mut self, best: Candidate, margin: f64, now_ms: f64) -> Snapshot {
        let ev = &best.evidence;
        let c = &self.config;
        let viewport_agrees = self
            .viewport
            .map(|(lo, hi)| ev.end_position >= lo.saturating_sub(8) && ev.end_position <= hi + 8)
            .unwrap_or(false);
        let enough = ev.fidelity >= c.jump_min_fidelity
            && ev.content_matches >= c.relocation_min_content
            && (margin >= c.ambiguity_margin || viewport_agrees);
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

    fn decide_discontinuity(
        &mut self,
        best: Candidate,
        best_local: Option<Candidate>,
        now_ms: f64,
    ) -> Snapshot {
        let c = &self.config;
        let ev = &best.evidence;
        let local_score = best_local.as_ref().map(|c| c.score).unwrap_or(f64::MIN);
        let needed_content = if best.backward {
            c.jump_min_content + c.retake_extra_content
        } else {
            c.jump_min_content
        };
        let strong = ev.fidelity >= c.jump_min_fidelity
            && ev.content_matches >= needed_content
            && best.score - local_score >= c.jump_margin;

        if !strong {
            self.pending_jump = None;
            // A decent local explanation continues to track; otherwise hold.
            if let Some(local) = best_local {
                if local.evidence.fidelity >= c.observe_min_fidelity
                    && local.evidence.content_matches >= c.observe_min_content
                {
                    return self.decide_local(local, f64::INFINITY, now_ms);
                }
            }
            return self.hold(DecisionCode::HoldLowEvidence, now_ms);
        }

        // Persistence: the same distant target must win on consecutive
        // revisions before we move the display. A final with strong unique
        // evidence may jump immediately.
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
                (p.target as i64 - target as i64).unsigned_abs()
                    <= (c.cluster_radius as u64) * 4
            })
            .unwrap_or(false);
        let count = if matches_pending {
            self.pending_jump.as_ref().map(|p| p.count).unwrap_or(0) + 1
        } else {
            1
        };

        let required = c.jump_persistence;
        if count < required && !is_final_evidence {
            self.pending_jump = Some(PendingJump {
                target,
                count,
                backward: best.backward,
            });
            self.confidence = (self.confidence * 0.85).max(0.05);
            return self.snapshot(DecisionCode::JumpPending, self.last_evidence_ms, now_ms);
        }

        // Accepted.
        let backward = best.backward;
        self.pending_jump = None;
        let evidence_ms = self.evidence_time(ev, now_ms);
        self.accept(target as f64, evidence_ms, true);
        self.state = TrackingState::Following;
        self.confidence = confidence_of(ev, best.score - local_score);
        if backward {
            // A retake re-reads earlier text: confirmed must follow backward,
            // or every subsequent confirm would be capped at the old position.
            self.confirmed = self.confirmed.min(target as f64);
            self.snapshot(DecisionCode::RetakeAccepted, evidence_ms, now_ms)
        } else {
            self.snapshot(DecisionCode::JumpForwardAccepted, evidence_ms, now_ms)
        }
    }

    // -----------------------------------------------------------------
    // Candidate regions
    // -----------------------------------------------------------------

    fn build_regions(&mut self, query: &[QueryAtom], predicted: f64, locked: bool) {
        let c = &self.config;
        let len = self.script.len() as u32;
        self.regions.clear();

        // 1. Local band around the prediction.
        if locked {
            let p = predicted.max(0.0) as u32;
            let start = p.saturating_sub(c.local_back);
            let end = (p + c.local_forward).min(len);
            self.regions.push((start, end));
        }

        // 2. Viewport prior region.
        if let Some((lo, hi)) = self.viewport {
            let start = lo.saturating_sub(c.global_region / 4).min(len);
            let end = (hi + c.global_region / 4).min(len);
            if end > start {
                self.regions.push((start, end));
            }
        }

        // 3. Session start region while searching: presenters usually begin
        // at the top.
        if !locked {
            self.regions.push((0, c.global_region.min(len)));
        }

        // 4. Anchor-proposed global regions from stable evidence.
        let stable: Vec<&QueryAtom> = query
            .iter()
            .filter(|q| q.stability.is_stable() && !q.filler)
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

    fn rank(&self, ev: &Evidence, predicted: f64, locked: bool) -> f64 {
        let c = &self.config;
        let mut score = c.rank_w_fidelity * ev.fidelity
            + c.rank_w_coverage * ev.coverage
            + c.rank_w_matched_weight * (1.0 + ev.matched_stable_weight / 1000.0).ln()
            + c.rank_w_run * (1.0 + ev.longest_run as f64).ln();

        if locked {
            let d = (ev.end_position as f64 - predicted).abs();
            let band = c.discontinuity_atoms as f64;
            if d > band {
                let mut penalty = c.rank_w_jump * (1.0 + d - band).ln();
                if (ev.end_position as f64) < predicted {
                    penalty *= c.rank_backward_factor;
                }
                score -= penalty;
            }
        }

        if let Some((lo, hi)) = self.viewport {
            let center = (lo + hi) as f64 / 2.0;
            let d = ev.end_position as f64 - center;
            score += c.viewport_bonus * (-0.5 * (d / c.viewport_sigma).powi(2)).exp();
        }
        score
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
        self.last_evidence_ms = evidence_ms;
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
        let rate = match self.state {
            TrackingState::Following => self.rate,
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
            confidence: self.confidence,
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
