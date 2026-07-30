//! Tier C: the rendered stage.
//!
//! Tier A and Tier B both stop at the engine's *estimated position*. That is one
//! scalar, and the presenter never sees it. What they see is:
//!
//! ```text
//! engine snapshot → line map → scroll target → jerk-limited plant
//!                 → rendered scroll px → per-word opacity → glass
//! ```
//!
//! Every stage after the first can fail on its own. A tracker that is perfectly
//! positioned still reads badly if the plant lags it by half a line, if the
//! reading line drifts out of the corridor, if the word behind the presenter
//! takes 700 ms to grey out, or if each recogniser partial lands as a visible
//! kick. None of those can be seen in `within2` and none of them were measured
//! anywhere before this module.
//!
//! ## What this is and is not
//!
//! This is a **model of the shipping stage, not the shipping stage.** The real
//! renderer is Svelte in a WKWebView and Apple ships no WebDriver for it, so
//! nothing automated on this machine can drive the packaged app — that gap is
//! real and stays (`README.md`, and Tier D in `bench/README.md`). What this
//! module does is port the parts that decide MOTION and OPACITY, and it ports
//! them from the source rather than approximating them:
//!
//! | modelled here | shipping source |
//! |---|---|
//! | jerk-limited follower, sub-stepped | `src/stage/motion/controller.ts` |
//! | S-curve stopping distance guard | same, `stoppingDistancePx` |
//! | forward-only following, rest deadband | same |
//! | motion limits per tracking state | `src/stage/motion/profiles.ts` |
//! | four-step per-word dim ramp + tween | `src/stage/renderer/InlineNodes.svelte` |
//! | dim freeze off `state != following` | `src/stage/renderer/ScriptLayer.svelte` |
//!
//! What is NOT modelled: real text measurement (the line map is synthetic),
//! compositor timing, WebKit's own opacity interpolation curve, and every
//! non-motion effect on the glass. So Tier C proves *the controller and the
//! opacity ramp behave*, and says nothing about layout on a real panel.
//! Reporting it as anything more would be the same overclaim the README already
//! warns about.

use serde::{Deserialize, Serialize};

use cc_align::{Snapshot, TrackingState};

use crate::replay::ReplayResult;

/// Reference typography, from `DEFAULT_SMOOTH_FOLLOW_PROFILE`'s own arithmetic:
/// 64 px body at a 1.32 line height.
pub const REFERENCE_LINE_PITCH_PX: f64 = 84.48;

/// ---------------------------------------------------------------------------
/// The dim ramp, verbatim from `InlineNodes.svelte`.
/// ---------------------------------------------------------------------------
/// A token `behind` words back from the rendered cursor gets these opacities.
/// Index 0 is unused (at or ahead of the cursor is fully bright); 4 and beyond
/// fall through to `PAST_OPACITY`.
pub const DIM_STEPS: [f64; 4] = [1.0, 0.78, 0.64, 0.52];
/// `--stage-past-opacity` default — the far past.
pub const PAST_OPACITY: f64 = 0.42;
/// `--stage-fx-ms`: the CSS opacity transition on every rendered word.
pub const DIM_TWEEN_MS: f64 = 240.0;

/// Fixed integration sub-step — `CONTROLLER_SUBSTEP_MS`.
const SUBSTEP_MS: f64 = 8.0;
/// `MAX_FRAME_DT_MS`.
const MAX_FRAME_DT_MS: f64 = 50.0;
/// `BRAKE_AUTHORITY`.
const BRAKE_AUTHORITY: f64 = 0.6;
/// `VELOCITY_EPSILON_PX_S`.
const V_EPSILON: f64 = 4.0;

/// Convert a rendered opacity to the darkness axis the opacity metrics use:
/// 0 = fully bright, 1 = as dark as the far past ever gets.
///
/// Normalising by `PAST_OPACITY` rather than by 0 is what makes the thresholds
/// mean something. On a raw `1 - opacity` axis the deepest step the product ever
/// renders is 0.58, so a "85% dark" threshold would be unreachable by
/// construction and `committed_dim` would be permanently infinite.
pub fn darkness(opacity: f64) -> f64 {
    ((1.0 - opacity) / (1.0 - PAST_OPACITY)).clamp(0.0, 1.0)
}

/// Opacity of a token `behind` whole words behind the rendered dim cursor.
pub fn dim_opacity(behind: i64) -> f64 {
    if behind <= 0 {
        1.0
    } else if (behind as usize) < DIM_STEPS.len() {
        DIM_STEPS[behind as usize].max(PAST_OPACITY)
    } else {
        PAST_OPACITY
    }
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/// One rendered configuration. Tier C sweeps these: the same engine output has
/// to be readable at 30 Hz on a 4K panel over HDMI and at 120 Hz on a laptop,
/// and a controller tuned at one refresh rate is not automatically fine at the
/// others.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Layout {
    pub name: String,
    pub line_pitch_px: f64,
    /// Spoken atoms per rendered line. Real wrapping depends on glyph widths;
    /// this is the synthetic stand-in, and it is swept rather than assumed.
    pub atoms_per_line: f64,
    pub viewport_h_px: f64,
    /// Where the spoken line is placed, as a fraction of viewport height. The
    /// product puts it above centre so there is always text to read into.
    pub reading_line_frac: f64,
    /// Half-height of the acceptable reading corridor, in rendered lines.
    pub band_half_lines: f64,
    pub refresh_hz: f64,
    /// Device pixel ratio — only affects the sub-pixel snap counter.
    pub dpr: f64,
    /// Inject a dropped frame every N frames (0 = none), to model a panel that
    /// is not keeping up.
    pub hitch_every: u32,
}

impl Layout {
    pub fn reading_line_px(&self) -> f64 {
        self.viewport_h_px * self.reading_line_frac
    }
    pub fn frame_ms(&self) -> f64 {
        1000.0 / self.refresh_hz.max(1.0)
    }
    pub fn px_per_atom(&self) -> f64 {
        self.line_pitch_px / self.atoms_per_line.max(0.001)
    }
}

/// The layout sweep Tier C runs by default.
///
/// Deliberately not a single "reference" rig. The refresh rates are the four the
/// controller claims to be independent of; `tight-lines` and `wide-lines` move
/// the pixel-per-spoken-word ratio by 2.5×, which is what actually changes how
/// much travel a word of speech costs; and `hitchy-30hz` is 4K@30 over HDMI
/// dropping every eighth frame, which is a cheap teleprompter monitor rather
/// than a corner case.
pub fn default_layouts() -> Vec<Layout> {
    let base = |name: &str, hz: f64| Layout {
        name: name.to_string(),
        line_pitch_px: REFERENCE_LINE_PITCH_PX,
        atoms_per_line: 7.0,
        viewport_h_px: 1080.0,
        reading_line_frac: 0.38,
        band_half_lines: 0.5,
        refresh_hz: hz,
        dpr: 2.0,
        hitch_every: 0,
    };
    vec![
        base("30hz", 30.0),
        base("60hz", 60.0),
        base("90hz", 90.0),
        base("120hz", 120.0),
        Layout {
            name: "tight-lines".into(),
            atoms_per_line: 4.0,
            ..base("tight-lines", 60.0)
        },
        Layout {
            name: "wide-lines".into(),
            atoms_per_line: 10.0,
            line_pitch_px: 60.0,
            ..base("wide-lines", 60.0)
        },
        Layout {
            name: "hitchy-30hz".into(),
            hitch_every: 8,
            ..base("hitchy-30hz", 30.0)
        },
    ]
}

/// Atom → rendered line and vertical position.
///
/// Paragraph breaks force a new line and cost an extra half pitch of gap, which
/// is what makes `future_reserve` and `line_handoff` mean anything at a section
/// boundary — the place where a reader is most likely to be left with nothing
/// to read into.
#[derive(Debug, Clone)]
pub struct LineMap {
    /// First atom of each line.
    line_starts: Vec<u32>,
    /// Top y of each line.
    line_y: Vec<f64>,
    pitch: f64,
    atoms: u32,
    doc_h_px: f64,
}

impl LineMap {
    pub fn build(script: &cc_align::CompiledScript, layout: &Layout) -> Self {
        let per_line = layout.atoms_per_line.max(1.0).round() as u32;
        let mut line_starts = Vec::new();
        let mut line_y = Vec::new();
        let mut y = 0.0;
        let mut i = 0u32;
        let n = script.len() as u32;
        while i < n {
            line_starts.push(i);
            line_y.push(y);
            y += layout.pitch_of_line();
            let para = script.atoms[i as usize].para;
            let mut taken = 0u32;
            while i < n && taken < per_line && script.atoms[i as usize].para == para {
                i += 1;
                taken += 1;
            }
            // A paragraph boundary inside the run ends the line early and adds
            // the inter-paragraph gap.
            if i < n && script.atoms[i as usize].para != para {
                y += layout.line_pitch_px * 0.5;
            }
        }
        let doc_h = y;
        Self {
            line_starts,
            line_y,
            pitch: layout.line_pitch_px,
            atoms: n,
            doc_h_px: doc_h,
        }
    }

    pub fn doc_height_px(&self) -> f64 {
        self.doc_h_px
    }

    pub fn line_pitch_px(&self) -> f64 {
        self.pitch
    }

    pub fn line_count(&self) -> usize {
        self.line_starts.len()
    }

    /// Line index containing atom `a` (fractional atoms round down).
    pub fn line_of(&self, a: f64) -> usize {
        let a = a.max(0.0).min(self.atoms.saturating_sub(1) as f64) as u32;
        match self.line_starts.binary_search(&a) {
            Ok(i) => i,
            Err(i) => i.saturating_sub(1),
        }
    }

    /// Vertical position of atom `a` in document pixels, interpolated across
    /// the line so a fractional atom position produces continuous motion. The
    /// engine's display position IS fractional, and quantising it to whole
    /// lines here would manufacture a step per line in every motion metric.
    pub fn y_of(&self, a: f64) -> f64 {
        if self.line_starts.is_empty() {
            return 0.0;
        }
        let line = self.line_of(a);
        let start = self.line_starts[line] as f64;
        let end = self
            .line_starts
            .get(line + 1)
            .map(|&v| v as f64)
            .unwrap_or(self.atoms as f64);
        let span = (end - start).max(1.0);
        let frac = ((a - start) / span).clamp(0.0, 1.0);
        let top = self.line_y[line];
        let next = self
            .line_y
            .get(line + 1)
            .copied()
            .unwrap_or(top + self.pitch);
        top + (next - top) * frac
    }

    pub fn line_top_px(&self, line: usize) -> f64 {
        self.line_y
            .get(line)
            .copied()
            .unwrap_or_else(|| self.doc_h_px)
    }

    pub fn first_atom_of_line(&self, line: usize) -> u32 {
        self.line_starts.get(line).copied().unwrap_or(self.atoms)
    }
}

impl Layout {
    fn pitch_of_line(&self) -> f64 {
        self.line_pitch_px
    }
}

// ---------------------------------------------------------------------------
// The plant
// ---------------------------------------------------------------------------

/// Motion limits for one frame — the shape `limitsForState` produces.
#[derive(Debug, Clone, Copy)]
pub struct MotionLimits {
    pub omega: f64,
    pub zeta: f64,
    pub v_forward_max: f64,
    pub v_backward_max: f64,
    pub a_max: f64,
    pub jerk_max: f64,
    pub feed_forward_scale: f64,
    pub rest_deadband_px: f64,
    pub allow_backward: bool,
}

/// `FOLLOWING_OMEGA_SCALE` / `FOLLOWING_ZETA_SCALE` from `profiles.ts`: ordinary
/// following closes an error far more slowly than any other state, and is
/// overdamped so it eases on rather than overshooting and coming back.
const FOLLOWING_OMEGA: f64 = 2.0;
const FOLLOWING_ZETA: f64 = 1.15;

impl MotionLimits {
    /// Per-state limits, mirroring `profiles.ts::stateMultipliers` over the
    /// engine's four states.
    pub fn for_state(state: TrackingState, pitch_px: f64) -> Self {
        // `lineUnits` scaling: the profile's pixel bounds were tuned at the
        // reference pitch, so a stage with a different pitch scales them rather
        // than inheriting numbers that mean a different number of lines.
        let s = pitch_px / REFERENCE_LINE_PITCH_PX;
        let base = MotionLimits {
            omega: FOLLOWING_OMEGA,
            zeta: FOLLOWING_ZETA,
            v_forward_max: 900.0 * s,
            v_backward_max: 600.0 * s,
            a_max: 2600.0 * s,
            jerk_max: 12_000.0 * s,
            feed_forward_scale: 1.0,
            rest_deadband_px: 1.5 * s,
            allow_backward: false,
        };
        match state {
            TrackingState::Following => base,
            TrackingState::Searching => MotionLimits {
                v_forward_max: base.v_forward_max * 0.6,
                a_max: base.a_max * 0.7,
                feed_forward_scale: 0.8,
                zeta: base.zeta * 1.05,
                ..base
            },
            TrackingState::Holding => MotionLimits {
                v_forward_max: base.v_forward_max * 0.35,
                a_max: base.a_max * 0.6,
                zeta: base.zeta * 1.3,
                feed_forward_scale: 0.5,
                omega: base.omega * 0.8,
                ..base
            },
            TrackingState::Ambiguous => MotionLimits {
                v_forward_max: base.v_forward_max * 0.15,
                a_max: base.a_max * 0.5,
                zeta: base.zeta * 1.4,
                feed_forward_scale: 0.0,
                omega: base.omega * 0.7,
                ..base
            },
        }
    }
}

/// `stoppingDistancePx` — the three-phase S-curve stop. Ported exactly,
/// including the reason it takes `a`: a jerk-limited plant that is still
/// accelerating has already committed to travel that `v²/2a` cannot see.
pub fn stopping_distance_px(v: f64, a: f64, a_brake: f64, jerk_max: f64) -> f64 {
    if !(v > 0.0) {
        return 0.0;
    }
    if !(a_brake > 0.0) {
        return f64::INFINITY;
    }
    if !(jerk_max > 0.0) {
        return v * v / (2.0 * a_brake);
    }
    let a0 = a.max(-a_brake);
    let t_a = (a0 + a_brake) / jerk_max;
    let d_a = v * t_a + 0.5 * a0 * t_a * t_a - (jerk_max * t_a * t_a * t_a) / 6.0;
    let v_a = v + a0 * t_a - 0.5 * jerk_max * t_a * t_a;
    if v_a <= 0.0 {
        return d_a.max(0.0);
    }
    let v_c = (a_brake * a_brake) / (2.0 * jerk_max);
    if v_a <= v_c {
        return d_a + v_a * (v_a / jerk_max).sqrt();
    }
    let d_b = (v_a * v_a - v_c * v_c) / (2.0 * a_brake);
    let d_c = (a_brake * a_brake * a_brake) / (6.0 * jerk_max * jerk_max);
    d_a + d_b + d_c
}

/// `jerkLimitedAccel` — the largest |a| that can still be ramped to zero inside
/// the remaining velocity headroom, including the discrete `dt` term.
fn jerk_limited_accel(headroom: f64, jerk_max: f64, dt: f64) -> f64 {
    if !(headroom > 0.0) {
        return 0.0;
    }
    if !(jerk_max > 0.0) {
        return f64::INFINITY;
    }
    let margin = jerk_max * dt.max(0.0);
    (margin * margin + 2.0 * jerk_max * headroom).sqrt() - margin
}

fn approach(current: f64, target: f64, max_delta: f64) -> f64 {
    let delta = target - current;
    if delta.abs() <= max_delta {
        target
    } else {
        current + delta.signum() * max_delta
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Plant {
    pub q: f64,
    pub v: f64,
    pub a: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct StepResult {
    pub jerk: f64,
    pub saturated: bool,
    pub hard_stop: bool,
    pub at_rest: bool,
}

impl Plant {
    /// One displayed frame. `dt_ms` is the measured frame delta, capped and
    /// sub-stepped exactly as the shipping controller does so gains behave the
    /// same at 30 and 120 Hz.
    pub fn step(
        &mut self,
        dt_ms: f64,
        target_px: f64,
        feed_forward_px_s: f64,
        limits: &MotionLimits,
        min_px: f64,
        max_px: f64,
    ) -> StepResult {
        let target = target_px.clamp(min_px, max_px);
        let integrated = dt_ms.max(0.0).min(MAX_FRAME_DT_MS);
        let a_before = self.a;
        let a_brake = limits.a_max.max(0.0) * BRAKE_AUTHORITY;
        let envelope_dt = SUBSTEP_MS / 1000.0;
        let mut saturated = false;
        let mut wall = false;

        let mut remaining = integrated;
        while remaining > 0.0 {
            let step_ms = remaining.min(SUBSTEP_MS);
            remaining -= step_ms;
            let dt = step_ms / 1000.0;
            if dt <= 0.0 {
                break;
            }

            let error = target - self.q;
            let v_target = feed_forward_px_s * limits.feed_forward_scale;
            let v_hi = limits.v_forward_max.max(0.0);
            let v_lo = if limits.allow_backward {
                -limits.v_backward_max.max(0.0)
            } else {
                0.0
            };
            let a_upper = limits
                .a_max
                .min(jerk_limited_accel(v_hi - self.v, limits.jerk_max, envelope_dt));
            let a_lower = (-limits.a_max)
                .max(-jerk_limited_accel(self.v - v_lo, limits.jerk_max, envelope_dt));

            let mut a_desired =
                limits.omega * limits.omega * error - 2.0 * limits.zeta * limits.omega * (self.v - v_target);

            // Overshoot guard: ordinary following may not move backward, so an
            // overshoot is permanent. Measured on the speed RELATIVE to the
            // target's own feed-forward — matching a moving target is not
            // overshoot.
            let slack = limits.rest_deadband_px.max(0.0);
            let v_rel_forward = self.v - v_target.max(0.0);
            if v_rel_forward > 0.0
                && stopping_distance_px(v_rel_forward, self.a, a_brake, limits.jerk_max)
                    > error + slack
            {
                a_desired = -limits.a_max;
                saturated = true;
            }

            let started_above = self.v > v_hi;
            let started_below = self.v < v_lo;
            if started_above {
                a_desired = a_lower;
                saturated = true;
            } else if started_below {
                a_desired = a_upper;
                saturated = true;
            } else {
                if a_desired > a_upper || a_desired < a_lower {
                    saturated = true;
                }
                a_desired = a_desired.clamp(a_lower, a_upper);
            }
            a_desired = a_desired.clamp(-limits.a_max, limits.a_max);

            let v_prev = self.v;
            self.a = approach(self.a, a_desired, limits.jerk_max * dt);
            let mut v = self.v + self.a * dt;

            let v_ceiling = if started_above { v_hi.max(v) } else { v_hi };
            let v_floor = if started_below { v_lo.min(v) } else { v_lo };
            let v_net = v.clamp(v_floor, v_ceiling);
            if (v_net - v).abs() > f64::EPSILON {
                v = v_net;
                saturated = true;
            }

            self.v = v;
            self.q += self.v * dt;

            let mut hard_stop = false;
            if self.q <= min_px {
                self.q = min_px;
                if self.v < 0.0 {
                    self.v = 0.0;
                    hard_stop = true;
                }
            } else if self.q >= max_px {
                self.q = max_px;
                if self.v > 0.0 {
                    self.v = 0.0;
                    hard_stop = true;
                }
            }
            if hard_stop {
                self.a = 0.0;
                wall = true;
            } else if (self.v - (v_prev + self.a * dt)).abs() > 1e-9 {
                self.a = (self.v - v_prev) / dt;
            }
        }

        let error = target - self.q;
        let v_target = feed_forward_px_s * limits.feed_forward_scale;
        let at_rest = error.abs() < limits.rest_deadband_px
            && v_target.abs() < V_EPSILON
            && self.v.abs() < V_EPSILON;
        if at_rest && (limits.allow_backward || target >= self.q) {
            self.q = target;
            self.v = 0.0;
            self.a = 0.0;
        }

        let dt_sec = integrated / 1000.0;
        StepResult {
            jerk: if dt_sec > 0.0 {
                (self.a - a_before) / dt_sec
            } else {
                0.0
            },
            saturated,
            hard_stop: wall,
            at_rest,
        }
    }

    pub fn reanchor(&mut self, px: f64) {
        self.q = px;
        self.v = 0.0;
        self.a = 0.0;
    }
}

// ---------------------------------------------------------------------------
// The trace
// ---------------------------------------------------------------------------

/// One rendered frame. This is the record the perceptual metrics are computed
/// from, and it deliberately holds what was RENDERED rather than what was asked
/// for — `target_px` and `q_px` are separate fields for exactly that reason.
#[derive(Debug, Clone)]
pub struct Frame {
    pub t_ms: f64,
    /// Engine display position in atoms at this instant.
    pub display_atoms: f64,
    /// Where the plant was asked to be.
    pub target_px: f64,
    /// Where the plant actually was.
    pub q_px: f64,
    pub v_px_s: f64,
    pub a_px_s2: f64,
    pub jerk_px_s3: f64,
    /// Whole-token dim cursor the renderer is using (latched during holds).
    pub dim_cursor: Option<i64>,
    /// Document-layer opacity — 0 through a re-anchor fade, 1 otherwise.
    pub doc_opacity: f64,
    pub state: Option<TrackingState>,
    pub confidence: f64,
    /// Audio time of the newest evidence supporting this frame's output.
    pub evidence_ms: f64,
    /// A snapshot was accepted within this frame.
    pub snapshot_arrived: bool,
    pub saturated: bool,
    pub hard_stop: bool,
    /// Per-token rendered opacity, for tokens inside the viewport. `(atom,
    /// opacity)`, ascending.
    pub token_opacity: Vec<(u32, f32)>,
}

impl Frame {
    /// Rendered opacity of `atom`, or None when it is off-screen this frame.
    pub fn opacity_of(&self, atom: u32) -> Option<f64> {
        self.token_opacity
            .binary_search_by_key(&atom, |&(a, _)| a)
            .ok()
            .map(|i| self.token_opacity[i].1 as f64)
    }
}

pub struct StageTrace {
    pub layout: Layout,
    pub line_map: LineMap,
    pub frames: Vec<Frame>,
    /// Frame deltas that exceeded the integration cap.
    pub hitches: usize,
}

/// Fade-down/-up duration for a re-anchor, from `ScriptLayer.svelte`'s
/// `--dur-slow`. A relocation this large is hidden rather than travelled.
const REANCHOR_FADE_MS: f64 = 200.0;
/// A target move at least this many lines is re-anchored (faded) rather than
/// travelled — `reanchorThresholdLines`.
const REANCHOR_THRESHOLD_LINES: f64 = 4.25;

/// Render a replayed engine trace through the stage model.
pub fn render(
    script: &cc_align::CompiledScript,
    replay: &ReplayResult,
    layout: &Layout,
) -> StageTrace {
    let line_map = LineMap::build(script, layout);
    let px_per_atom = layout.px_per_atom();
    let reading_line = layout.reading_line_px();
    let min_px = 0.0;
    let max_px = (line_map.doc_height_px() - layout.viewport_h_px * 0.35).max(0.0);
    let frame_ms = layout.frame_ms();
    let reanchor_threshold = REANCHOR_THRESHOLD_LINES * layout.line_pitch_px;

    let end_ms = replay
        .snapshots
        .last()
        .map(|s| s.at_audio_ms + 2_000.0)
        .unwrap_or(0.0);

    let mut plant = Plant::default();
    let mut frames: Vec<Frame> = Vec::new();
    let mut cursor = 0usize;
    let mut hitches = 0usize;
    let mut frame_no = 0u32;
    // Per-token tween state: current rendered opacity, walking toward the
    // target step over DIM_TWEEN_MS. Only tokens that have ever been near the
    // cursor are touched, so this stays cheap on a 5k-atom script.
    let mut rendered_opacity: Vec<f64> = vec![1.0; script.len()];
    let mut latched_cursor: Option<i64> = None;
    let mut fade_until = f64::NEG_INFINITY;
    let mut last_target = f64::NAN;
    let mut last_seq: u64 = u64::MAX;

    let mut t = 0.0;
    while t <= end_ms {
        // Advance to the newest snapshot at or before `t`.
        let mut arrived = false;
        while cursor + 1 < replay.snapshots.len()
            && replay.snapshots[cursor + 1].at_audio_ms <= t
        {
            cursor += 1;
        }
        let snap: Option<&Snapshot> = replay
            .snapshots
            .get(cursor)
            .filter(|s| s.at_audio_ms <= t);
        if let Some(s) = snap {
            if s.seq != last_seq {
                arrived = true;
                last_seq = s.seq;
            }
        }

        let (display_atoms, state, rate, confidence, evidence_ms) = match snap {
            Some(s) => (
                s.display_at(t),
                Some(s.state),
                s.rate,
                s.confidence,
                s.evidence_audio_ms,
            ),
            None => (0.0, None, 0.0, 0.0, 0.0),
        };

        let target_px = (line_map.y_of(display_atoms) - reading_line).clamp(min_px, max_px);

        // A large target move is a re-anchor: fade out, move under cover, fade
        // back. `visible_relocation_distance` is the metric that checks the
        // cover actually held.
        if last_target.is_finite() && (target_px - last_target).abs() >= reanchor_threshold {
            fade_until = t + REANCHOR_FADE_MS;
            plant.reanchor(target_px);
        }
        last_target = target_px;
        let doc_opacity = if t < fade_until {
            // Symmetric triangle: down and back over the window.
            let k = ((fade_until - t) / REANCHOR_FADE_MS).clamp(0.0, 1.0);
            (1.0 - 2.0 * (0.5 - (0.5 - k).abs())).clamp(0.0, 1.0)
        } else {
            1.0
        };

        // Frame delta: the modelled panel, plus a periodic dropped frame.
        frame_no += 1;
        let dt = if layout.hitch_every > 0 && frame_no % layout.hitch_every == 0 {
            hitches += 1;
            frame_ms * 2.0
        } else {
            frame_ms
        };

        let limits = MotionLimits::for_state(
            state.unwrap_or(TrackingState::Searching),
            layout.line_pitch_px,
        );
        let ff = rate * px_per_atom;
        let step = plant.step(dt, target_px, ff, &limits, min_px, max_px);

        // ---- opacity ----
        // `dimFrozen`: the ramp only advances while the engine claims to be
        // following. A cursor keeps arriving during a hold — it is the last
        // position anyone believed — and walking the ramp on it would grey out
        // words behind a reader who has not been located for seconds.
        let following = matches!(state, Some(TrackingState::Following));
        let live_cursor = state.map(|_| display_atoms.round() as i64);
        let dim_cursor = if following || latched_cursor.is_none() {
            latched_cursor = live_cursor;
            live_cursor
        } else {
            latched_cursor
        };

        // Which tokens are on the glass this frame.
        let top_atom = first_atom_at_y(&line_map, plant.q);
        let bottom_atom = first_atom_at_y(&line_map, plant.q + layout.viewport_h_px);
        let lo = top_atom;
        let hi = bottom_atom.min(script.len() as u32);
        let tween = (dt / DIM_TWEEN_MS).clamp(0.0, 1.0);
        let mut token_opacity = Vec::with_capacity((hi.saturating_sub(lo)) as usize + 1);
        for atom in lo..hi {
            let want = match dim_cursor {
                Some(c) => dim_opacity(c - atom as i64),
                None => 1.0,
            };
            let cur = &mut rendered_opacity[atom as usize];
            // Linear approach over the CSS transition duration. WebKit eases
            // out; linear is the conservative model — it reaches a threshold no
            // sooner than an ease-out does, so no latency reported here is
            // optimistic.
            *cur += (want - *cur) * tween;
            token_opacity.push((atom, *cur as f32));
        }

        frames.push(Frame {
            t_ms: t,
            display_atoms,
            target_px,
            q_px: plant.q,
            v_px_s: plant.v,
            a_px_s2: plant.a,
            jerk_px_s3: step.jerk,
            dim_cursor,
            doc_opacity,
            state,
            confidence,
            evidence_ms,
            snapshot_arrived: arrived,
            saturated: step.saturated,
            hard_stop: step.hard_stop,
            token_opacity,
        });

        t += frame_ms;
    }

    StageTrace {
        layout: layout.clone(),
        line_map,
        frames,
        hitches,
    }
}

/// First atom whose line top is at or below document `y`.
fn first_atom_at_y(map: &LineMap, y: f64) -> u32 {
    let mut lo = 0usize;
    let mut hi = map.line_count();
    while lo < hi {
        let mid = (lo + hi) / 2;
        if map.line_top_px(mid) < y {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    map.first_atom_of_line(lo.saturating_sub(1))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits() -> MotionLimits {
        MotionLimits::for_state(TrackingState::Following, REFERENCE_LINE_PITCH_PX)
    }

    #[test]
    fn darkness_axis_reaches_one_at_the_far_past() {
        assert!(darkness(1.0).abs() < 1e-9);
        assert!((darkness(PAST_OPACITY) - 1.0).abs() < 1e-9);
        // The published thresholds have to be reachable, which is the whole
        // reason the axis is normalised.
        assert!(darkness(DIM_STEPS[1]) > 0.25);
        assert!(darkness(DIM_STEPS[2]) > 0.5);
    }

    #[test]
    fn following_never_moves_backward() {
        let mut plant = Plant { q: 500.0, v: 0.0, a: 0.0 };
        let l = limits();
        for _ in 0..200 {
            let before = plant.q;
            plant.step(16.7, 0.0, 0.0, &l, 0.0, 10_000.0);
            assert!(
                plant.q >= before - 1e-6,
                "forward-only profile moved backward: {before} -> {}",
                plant.q
            );
        }
    }

    #[test]
    fn plant_respects_the_jerk_limit() {
        let mut plant = Plant::default();
        let l = limits();
        let mut worst = 0.0f64;
        for i in 0..300 {
            // A target that jumps around, to provoke the guard.
            let target = if i % 40 < 20 { 2_000.0 } else { 100.0 };
            let r = plant.step(16.7, target, 300.0, &l, 0.0, 10_000.0);
            if !r.hard_stop {
                worst = worst.max(r.jerk.abs());
            }
        }
        // The per-FRAME jerk estimate can exceed jerkMax when a frame contains
        // several sub-steps all ramping the same way; what must hold is that it
        // stays within the sub-step bound times the sub-steps in a frame.
        let bound = l.jerk_max * 1.05;
        assert!(worst <= bound, "realized jerk {worst} exceeded {bound}");
    }

    #[test]
    fn plant_converges_on_a_static_target() {
        let mut plant = Plant::default();
        let l = limits();
        for _ in 0..600 {
            plant.step(16.7, 1_000.0, 0.0, &l, 0.0, 10_000.0);
        }
        assert!(
            (plant.q - 1_000.0).abs() < 2.0,
            "did not settle: {}",
            plant.q
        );
    }

    #[test]
    fn line_map_is_monotone_and_continuous() {
        let script = cc_align::compile(
            &(0..200)
                .map(|i| format!("word{i}"))
                .collect::<Vec<_>>()
                .join(" "),
            cc_align::CompileOptions::default(),
        );
        let layout = default_layouts()
            .into_iter()
            .find(|l| l.name == "60hz")
            .unwrap();
        let map = LineMap::build(&script, &layout);
        let mut prev = f64::NEG_INFINITY;
        let mut a = 0.0;
        while a < 199.0 {
            let y = map.y_of(a);
            assert!(y >= prev - 1e-9, "y went backward at atom {a}");
            prev = y;
            a += 0.25;
        }
        assert!(map.line_count() > 20);
    }
}
