//! Live speech-to-script alignment — the app's host for [`cc_align::Engine`].
//!
//! ---------------------------------------------------------------------------
//! WHY THE ENGINE LIVES HERE
//! ---------------------------------------------------------------------------
//! The alignment engine is a pure crate (`crates/cc-align`): no I/O, no clocks,
//! no randomness. This module is everything the crate deliberately refuses to
//! know — where transcript frames come from, what the audio clock reads, and
//! who wants to hear the answer. It sits next to the Inworld socket because
//! that is where the frames and the audio clock already are: feeding the engine
//! anywhere else would mean shipping both across a process boundary and
//! re-deriving a clock on the far side, which is precisely the arrangement the
//! previous TypeScript aligner failed under.
//!
//! ---------------------------------------------------------------------------
//! TWO COORDINATE SYSTEMS, ONE CONVERSION, IN ONE PLACE
//! ---------------------------------------------------------------------------
//! The engine positions the reader in *atoms* — its own normalized units, where
//! `$12` is two atoms because it is two spoken words. The app renders *tokens* —
//! what its Markdown compiler produced, where `$12` is one span on the glass
//! with one measured rectangle.
//!
//! Those two sequences do not correspond index-for-index and never will. So the
//! script is compiled through [`cc_align::compile_tokens`], which builds atoms
//! *from the app's own tokens* and records where each came from. Every snapshot
//! is then projected back into token space HERE, and nothing downstream of this
//! file ever sees an atom. The stage keeps its existing geometry, the renderer
//! keeps its existing token spans, and there is exactly one conversion in the
//! system rather than one per consumer.
//!
//! ---------------------------------------------------------------------------
//! WHAT THIS MODULE MUST NOT DO
//! ---------------------------------------------------------------------------
//! No lexical judgement. No stopword list, no tokenizer, no "is this word close
//! enough" check. All of that is the engine's, and the one time it was
//! duplicated the two copies disagreed and the cursor sat at `0 of 26` through
//! an entire take.

use std::sync::Mutex;

use cc_align::tracker::{DecisionCode, TrackingState};
use cc_align::{AlignmentConfig, Engine, SessionEvent, Snapshot, TokenInput};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

use crate::inworld::stream::SttFrame;
use crate::windows::{events, CONTROL_LABEL, STAGE_LABEL};

/// One spoken token, as the app's compiler produced it.
///
/// `surface` is the AUTHORED text (`$12`, `well-known`), never pre-split: the
/// engine's normalizer is the only thing allowed to decide how a surface breaks
/// into spoken words, and a caller that splits first would be a second
/// tokenizer by the back door.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignToken {
    pub surface: String,
    #[serde(default)]
    pub line: u32,
    #[serde(default)]
    pub para: u32,
}

/// What the stage and control receive after every transcript event.
///
/// Positions are FRACTIONAL TOKEN INDEXES into the app's compiled script —
/// already converted (see the module note). `display_at` is reproduced on the
/// stage from `observed_token` / `rate_tokens_per_second` / the audio stamps, so
/// the 60 Hz motion loop never has to call back into Rust.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentSnapshot {
    /// The alignment session this belongs to. A snapshot from a superseded
    /// session must be discarded rather than followed.
    pub session_generation: u64,
    /// Monotone per session; the stage drops anything not newer.
    pub seq: u64,
    /// `searching` | `following` | `holding` | `ambiguous`.
    pub state: &'static str,
    /// Diagnostics only. Never map this to user-facing copy — `state` is the
    /// user-facing contract.
    pub decision: &'static str,
    /// Conservative anchor: progress, "words covered", recovery UI.
    pub confirmed_token: f64,
    /// Best evidence-supported position. NOT the scroll target — see
    /// `rate_tokens_per_second`.
    pub observed_token: f64,
    /// Reading rate for display extrapolation, tokens/sec. Already zero
    /// whenever extrapolating would be a guess, so the stage must not
    /// re-derive that condition.
    pub rate_tokens_per_second: f64,
    /// Audio time `observed_token` corresponds to.
    pub evidence_audio_ms: f64,
    /// Audio time this snapshot was produced.
    pub at_audio_ms: f64,
    /// Hard cap on forward extrapolation from `evidence_audio_ms`.
    pub max_prediction_ms: f64,
    /// Documented heuristic in 0..1, not a calibrated probability. Fine for a
    /// debug meter; do not gate behaviour on exact thresholds.
    pub confidence: f64,
    /// A distant candidate accumulating evidence — "possible match below".
    /// The UI may offer it; it must never auto-scroll to it.
    pub suggestion_token: Option<f64>,
    /// Total tokens, the ceiling for any display position.
    pub script_len_tokens: f64,
    /// Atom-space originals, for the diagnostics panel and bench parity only.
    pub observed_atom: f64,
    pub confirmed_atom: f64,
}

/// A running alignment session.
struct AlignmentSession {
    generation: u64,
    engine: Engine,
    /// Last audio-clock reading the engine was given. Manual moves that arrive
    /// between transcript frames are stamped with it, so a move is never dated
    /// ahead of the evidence the engine holds.
    last_audio_ms: f64,
}

/// Managed state. At most one session runs at a time, for the same reason at
/// most one transcription stream does: a take owns the microphone.
#[derive(Default)]
pub struct AlignmentState(Mutex<Option<AlignmentSession>>);

impl AlignmentState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Compile `tokens` and begin aligning against them.
    ///
    /// Replaces any session already running: a new take supersedes the old one,
    /// and keeping the previous engine alive would let speech from before the
    /// change drag the cursor.
    pub fn start(&self, generation: u64, tokens: &[AlignToken]) {
        let inputs: Vec<TokenInput> = tokens
            .iter()
            .map(|t| TokenInput {
                surface: t.surface.clone(),
                line: t.line,
                para: t.para,
            })
            .collect();
        let script = cc_align::compile_tokens(&inputs);
        let engine = Engine::new(script, AlignmentConfig::default());
        *self.lock() = Some(AlignmentSession {
            generation,
            engine,
            last_audio_ms: 0.0,
        });
    }

    pub fn stop(&self) {
        *self.lock() = None;
    }

    /// The generation currently being aligned, if any.
    pub fn generation(&self) -> Option<u64> {
        self.lock().as_ref().map(|s| s.generation)
    }

    /// A poisoned alignment mutex must not take the app down: the panic that
    /// poisoned it already happened, and refusing to follow the script
    /// afterwards helps nobody. The session inside is plain data.
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<AlignmentSession>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Feed one transcript frame and return the projected snapshot.
    ///
    /// `audio_now_ms` is the session's bytes-sent audio clock read at the
    /// moment the frame arrived. It is NOT wall-clock time: the engine's lag
    /// model (`partial_lag_ms` / `endpoint_lag_ms`) was measured against the
    /// audio clock on live captures, and substituting a wall clock silently
    /// mis-times every prediction.
    fn observe(&self, frame: &SttFrame, audio_now_ms: f64) -> Option<AlignmentSnapshot> {
        let mut guard = self.lock();
        let session = guard.as_mut()?;

        let event = match frame {
            SttFrame::ItemStarted {
                generation,
                item_id,
                audio_start_ms,
                ..
            } if *generation == session.generation => SessionEvent::ItemStarted {
                item_id: item_id.clone(),
                audio_start_ms: *audio_start_ms,
            },
            SttFrame::Partial {
                generation,
                item_id,
                text,
            } if *generation == session.generation => SessionEvent::Partial {
                item_id: item_id.clone(),
                text: text.clone(),
                audio_ms: audio_now_ms,
            },
            SttFrame::Final {
                generation,
                item_id,
                text,
                audio_end_ms,
            } if *generation == session.generation => SessionEvent::Final {
                item_id: item_id.clone(),
                text: text.clone(),
                audio_end_ms: *audio_end_ms,
            },
            // Transport, failure and audio-drop frames say nothing about where
            // the reader is. Feeding them would be inventing evidence.
            _ => return None,
        };

        session.last_audio_ms = audio_now_ms.max(session.last_audio_ms);
        let snapshot = session.engine.handle(event);
        Some(project(&snapshot, &session.engine, session.generation))
    }

    /// "I am here" — a tapped paragraph or a jump-to-section — published to
    /// both audiences if a session is running.
    ///
    /// Resets evidence continuity inside the engine, so speech from before the
    /// move can never pull the cursor back to where it was.
    pub fn set_position_and_publish<R: tauri::Runtime>(
        &self,
        app: &tauri::AppHandle<R>,
        token: f64,
    ) {
        if let Some(snapshot) = self.set_position(token) {
            publish(app, &snapshot);
        }
    }

    fn set_position(&self, token: f64) -> Option<AlignmentSnapshot> {
        let mut guard = self.lock();
        let session = guard.as_mut()?;
        let atom = session.engine.script.atom_at(token).round().max(0.0);
        let at = session.last_audio_ms;
        let snapshot = session.engine.set_manual_position(atom as u32, at);
        Some(project(&snapshot, &session.engine, session.generation))
    }

    /// "This is what I can see." A prior on candidate ranking, never a command:
    /// it speeds up locks that start mid-script and makes a jump to somewhere
    /// off-screen require an extra round of evidence.
    fn set_viewport(&self, first_token: f64, last_token: f64) {
        let mut guard = self.lock();
        let Some(session) = guard.as_mut() else {
            return;
        };
        if !first_token.is_finite() || !last_token.is_finite() || last_token < first_token {
            session.engine.clear_viewport_hint();
            return;
        }
        let first = session.engine.script.atom_at(first_token).floor().max(0.0) as u32;
        let last = session.engine.script.atom_at(last_token).ceil().max(0.0) as u32;
        session.engine.set_viewport_hint(first, last);
    }

    fn clear_viewport(&self) {
        if let Some(session) = self.lock().as_mut() {
            session.engine.clear_viewport_hint();
        }
    }
}

/// Project an engine snapshot from atom space into the app's token space.
///
/// The rate conversion is endpoint-exact rather than a local derivative: the
/// prediction horizon's far end is mapped through the same axis as its near
/// end, and the reported rate is whatever connects them. That matters because
/// the axis is piecewise linear with a different slope wherever a token expands
/// into several atoms — a derivative sampled at `observed` would be right at
/// the start of the horizon and wrong by the end of it, which is the half of
/// the horizon the presenter actually reaches.
fn project(snapshot: &Snapshot, engine: &Engine, generation: u64) -> AlignmentSnapshot {
    let script = &engine.script;
    let observed_token = script.token_at(snapshot.observed);
    let horizon_seconds = snapshot.max_prediction_ms / 1000.0;
    let rate_tokens_per_second = if snapshot.rate > 0.0 && horizon_seconds > 0.0 {
        let far_atom =
            (snapshot.observed + snapshot.rate * horizon_seconds).min(snapshot.script_len);
        (script.token_at(far_atom) - observed_token) / horizon_seconds
    } else {
        // Already zeroed by the engine whenever extrapolating would be a guess.
        0.0
    };

    AlignmentSnapshot {
        session_generation: generation,
        seq: snapshot.seq,
        state: state_name(snapshot.state),
        decision: decision_name(snapshot.decision),
        confirmed_token: script.token_at(snapshot.confirmed),
        observed_token,
        rate_tokens_per_second,
        evidence_audio_ms: snapshot.evidence_audio_ms,
        at_audio_ms: snapshot.at_audio_ms,
        max_prediction_ms: snapshot.max_prediction_ms,
        confidence: snapshot.confidence,
        suggestion_token: snapshot.suggestion.map(|a| script.token_at(a)),
        script_len_tokens: script.token_count as f64,
        observed_atom: snapshot.observed,
        confirmed_atom: snapshot.confirmed,
    }
}

/// The user-facing contract (§3 of the integration note). These four strings are
/// matched exhaustively in TypeScript; renaming one would compile on both sides
/// and silently stop the stage from following.
fn state_name(state: TrackingState) -> &'static str {
    match state {
        TrackingState::Searching => "searching",
        TrackingState::Following => "following",
        TrackingState::Holding => "holding",
        TrackingState::Ambiguous => "ambiguous",
    }
}

/// Diagnostics vocabulary. Deliberately NOT parallel to `state_name`: these are
/// for a log line and a debug panel, and mapping them to user-facing text is
/// what the integration note forbids.
fn decision_name(decision: DecisionCode) -> &'static str {
    match decision {
        DecisionCode::NoEvidence => "noEvidence",
        DecisionCode::LocalObserved => "localObserved",
        DecisionCode::LocalConfirmed => "localConfirmed",
        DecisionCode::HoldLowEvidence => "holdLowEvidence",
        DecisionCode::HoldOffScript => "holdOffScript",
        DecisionCode::HoldAmbiguous => "holdAmbiguous",
        DecisionCode::RelocationAccepted => "relocationAccepted",
        DecisionCode::JumpForwardAccepted => "jumpForwardAccepted",
        DecisionCode::RetakeAccepted => "retakeAccepted",
        DecisionCode::JumpPending => "jumpPending",
        DecisionCode::ManualAnchor => "manualAnchor",
    }
}

/// Publish a snapshot to both audiences.
///
/// The stage gets it for motion, control gets it for progress and the take
/// summary. Two names rather than one shared name: they are different
/// contracts to different windows, and a stage that starts receiving control's
/// diagnostics traffic is a stage doing work it has no reason to do.
fn publish<R: tauri::Runtime>(app: &tauri::AppHandle<R>, snapshot: &AlignmentSnapshot) {
    // A failed emit means that window is gone, which alignment can do nothing
    // about and must not tear the session down for.
    let _ = app.emit_to(STAGE_LABEL, events::STAGE_ALIGNMENT_SNAPSHOT, snapshot);
    let _ = app.emit_to(CONTROL_LABEL, events::ALIGN_SNAPSHOT, snapshot);
}

/// The single hook the Inworld stream calls. Called only for transcript frames,
/// with the audio clock read at arrival.
pub fn observe_frame<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    frame: &SttFrame,
    audio_now_ms: f64,
) {
    let state: tauri::State<'_, AlignmentState> = app.state();
    if let Some(snapshot) = state.observe(frame, audio_now_ms) {
        publish(app, &snapshot);
    }
}

/// The stage's debounced "this is what I can see" report, relayed by the stage
/// event bridge.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewportHint {
    pub session_generation: u64,
    pub first_token: f64,
    pub last_token: f64,
    /// True when the concept does not apply (a full-script overview), which
    /// clears the prior rather than asserting a bogus one.
    #[serde(default)]
    pub cleared: bool,
}

pub fn apply_viewport_hint(state: &AlignmentState, hint: &ViewportHint) {
    if state.generation() != Some(hint.session_generation) {
        return;
    }
    if hint.cleared {
        state.clear_viewport();
    } else {
        state.set_viewport(hint.first_token, hint.last_token);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens(words: &[&str]) -> Vec<AlignToken> {
        words
            .iter()
            .enumerate()
            .map(|(i, w)| AlignToken {
                surface: (*w).to_string(),
                line: i as u32,
                para: 0,
            })
            .collect()
    }

    const SCRIPT: &[&str] = &[
        "Good", "morning", "everyone", "and", "welcome", "to", "the", "quarterly", "review",
        "our", "revenue", "grew", "sharply", "this", "period", "and", "the", "team", "shipped",
        "three", "major", "features",
    ];

    #[test]
    fn a_session_follows_speech_into_token_space() {
        let state = AlignmentState::new();
        state.start(7, &tokens(SCRIPT));

        let heard = "good morning everyone and welcome to the quarterly review";
        let snapshot = state
            .observe(
                &SttFrame::Final {
                    generation: 7,
                    item_id: "7-0".into(),
                    text: heard.into(),
                    audio_end_ms: 3_000.0,
                },
                3_000.0,
            )
            .expect("a running session answers a transcript frame");

        assert_eq!(snapshot.session_generation, 7);
        assert_eq!(snapshot.state, "following");
        assert_eq!(snapshot.script_len_tokens, SCRIPT.len() as f64);
        // Nine words heard, so the reader is at the ninth token boundary.
        assert!(
            (snapshot.observed_token - 9.0).abs() <= 2.0,
            "observed {} should be near token 9",
            snapshot.observed_token
        );
        assert!(snapshot.confirmed_token <= snapshot.observed_token);
    }

    /// Frames from a superseded transcription socket must not reach the engine:
    /// this is the check that keeps the tail of a stopped take out of the next
    /// one's alignment.
    #[test]
    fn frames_from_another_generation_are_ignored() {
        let state = AlignmentState::new();
        state.start(2, &tokens(SCRIPT));
        let stale = state.observe(
            &SttFrame::Final {
                generation: 1,
                item_id: "1-0".into(),
                text: "good morning everyone".into(),
                audio_end_ms: 900.0,
            },
            900.0,
        );
        assert!(stale.is_none());
    }

    #[test]
    fn transport_frames_never_feed_the_engine() {
        let state = AlignmentState::new();
        state.start(1, &tokens(SCRIPT));
        assert!(state
            .observe(
                &SttFrame::Transport {
                    generation: 1,
                    state: "connected",
                    detail: None,
                },
                0.0,
            )
            .is_none());
        assert!(state
            .observe(
                &SttFrame::AudioDropped {
                    generation: 1,
                    frames: 3,
                },
                0.0,
            )
            .is_none());
    }

    #[test]
    fn no_session_means_no_snapshot() {
        let state = AlignmentState::new();
        assert!(state
            .observe(
                &SttFrame::Final {
                    generation: 1,
                    item_id: "1-0".into(),
                    text: "good morning".into(),
                    audio_end_ms: 500.0,
                },
                500.0,
            )
            .is_none());
    }

    /// A manual move is authoritative and lands where it was asked to land.
    #[test]
    fn manual_position_moves_the_cursor_and_reports_it() {
        let state = AlignmentState::new();
        state.start(1, &tokens(SCRIPT));
        let snapshot = state.set_position(12.0).expect("session is running");
        assert_eq!(snapshot.decision, "manualAnchor");
        assert!(
            (snapshot.confirmed_token - 12.0).abs() < 1.0,
            "confirmed {} should be token 12",
            snapshot.confirmed_token
        );
    }

    /// Multi-atom tokens are where a naive projection breaks: the engine counts
    /// `$12` as two atoms, the app renders one span, and a snapshot that
    /// reported atoms would put the reader a token further along than they are.
    #[test]
    fn expanding_tokens_do_not_drift_the_reported_position() {
        let state = AlignmentState::new();
        let script = tokens(&["We", "raised", "$12", "million", "last", "year", "in", "total"]);
        state.start(1, &script);

        let snapshot = state
            .observe(
                &SttFrame::Final {
                    generation: 1,
                    item_id: "1-0".into(),
                    text: "we raised twelve dollars million last year".into(),
                    audio_end_ms: 2_500.0,
                },
                2_500.0,
            )
            .expect("session is running");

        // Six tokens read. In atom space that is seven atoms, and reporting the
        // atom count would place the reader on "in".
        assert!(
            snapshot.observed_token <= 6.5,
            "observed {} drifted past the tokens actually read",
            snapshot.observed_token
        );
        assert!(snapshot.observed_atom >= snapshot.observed_token);
    }

    /// The rate is a token-space rate. Reporting the engine's atom rate
    /// unconverted would over-scroll every script containing a number.
    #[test]
    fn projected_rate_stays_within_the_prediction_horizon() {
        let state = AlignmentState::new();
        state.start(1, &tokens(SCRIPT));
        for (i, text) in [
            "good morning",
            "good morning everyone and",
            "good morning everyone and welcome to",
        ]
        .iter()
        .enumerate()
        {
            let at = 1_000.0 * (i as f64 + 1.0);
            let snapshot = state
                .observe(
                    &SttFrame::Final {
                        generation: 1,
                        item_id: format!("1-{i}"),
                        text: (*text).into(),
                        audio_end_ms: at,
                    },
                    at,
                )
                .expect("session is running");

            assert!(snapshot.rate_tokens_per_second >= 0.0);
            // Whatever the rate, one full horizon of it may not run past the end.
            let reach = snapshot.observed_token
                + snapshot.rate_tokens_per_second * snapshot.max_prediction_ms / 1000.0;
            assert!(
                reach <= snapshot.script_len_tokens + 1e-9,
                "prediction reached {reach} past {} tokens",
                snapshot.script_len_tokens
            );
        }
    }

    #[test]
    fn viewport_hints_are_scoped_to_their_session() {
        let state = AlignmentState::new();
        state.start(4, &tokens(SCRIPT));

        // A hint for a session that is not running is ignored outright.
        apply_viewport_hint(
            &state,
            &ViewportHint {
                session_generation: 3,
                first_token: 0.0,
                last_token: 5.0,
                cleared: false,
            },
        );
        // A hint for the live session applies, and clearing it is accepted too.
        apply_viewport_hint(
            &state,
            &ViewportHint {
                session_generation: 4,
                first_token: 4.0,
                last_token: 14.0,
                cleared: false,
            },
        );
        apply_viewport_hint(
            &state,
            &ViewportHint {
                session_generation: 4,
                first_token: 0.0,
                last_token: 0.0,
                cleared: true,
            },
        );
        // Reaching here without panicking is the assertion: hint application is
        // total, and a nonsense range clears rather than poisons the prior.
        state.set_viewport(f64::NAN, 3.0);
        state.set_viewport(9.0, 2.0);
        assert_eq!(state.generation(), Some(4));
    }

    #[test]
    fn starting_a_new_session_replaces_the_old_engine() {
        let state = AlignmentState::new();
        state.start(1, &tokens(SCRIPT));
        state.start(2, &tokens(&["completely", "different", "script", "text"]));
        assert_eq!(state.generation(), Some(2));
        let snapshot = state
            .observe(
                &SttFrame::Final {
                    generation: 2,
                    item_id: "2-0".into(),
                    text: "completely different".into(),
                    audio_end_ms: 800.0,
                },
                800.0,
            )
            .expect("the new session is live");
        assert_eq!(snapshot.script_len_tokens, 4.0);
        state.stop();
        assert_eq!(state.generation(), None);
    }
}

/// The repro that this whole rewrite exists to keep answered.
///
/// "Does a take actually follow?" was the one question no test asked, and a
/// build shipped twice in which every unit test passed, the provider returned
/// 28 words, and the cursor never moved. These drive the REAL engine with the
/// REAL frame sequence captured from a failing take, through the same token
/// path the app uses, and assert that words in produce movement out.
#[cfg(test)]
mod starter_script_tests {
    use super::*;

    /// `scripts/<id>/script.md` as the app creates it for a new user, already
    /// tokenized the way the app's compiler tokenizes it. The heading is not
    /// spoken and neither is the cue line, so 26 spoken tokens remain.
    fn starter_tokens() -> Vec<AlignToken> {
        let sentence_one = "Write the words you plan to say, exactly the way you would say them.";
        let sentence_two = "When you present, the stage follows your voice and keeps your place.";
        let mut tokens = Vec::new();
        for (para, sentence) in [sentence_one, sentence_two].iter().enumerate() {
            for word in sentence.split_whitespace() {
                let surface = word.trim_matches(|c: char| c == '.' || c == ',');
                if surface.is_empty() {
                    continue;
                }
                tokens.push(AlignToken {
                    surface: surface.to_string(),
                    line: para as u32,
                    para: 0,
                });
            }
        }
        tokens
    }

    /// The two utterances Inworld returned, at the word counts the trace
    /// recorded — partials included, because a take is followed as it happens.
    const TAKE: &[(&str, &[&str], &str)] = &[
        (
            "1-0",
            &[
                "Write the words you plan to",
                "Write the words you plan to say",
                "Write the words you plan to say exactly the way",
                "Write the words you plan to say exactly the way you would say them",
            ],
            "Write the words you plan to say, exactly the way you would say them.",
        ),
        (
            "1-1",
            &[
                "When you present the stage",
                "When you present the stage follows your voice",
                "When you present the stage follows your voice and keeps your place",
            ],
            "When you present, the stage follows your voice and keeps your place.",
        ),
    ];

    /// Replay `take` and return the last snapshot.
    fn replay(state: &AlignmentState, take: &[(&str, &[&str], &str)]) -> AlignmentSnapshot {
        let mut audio_ms = 1_000.0;
        let mut last = None;
        for (item_id, partials, final_text) in take {
            audio_ms += 800.0;
            last = state
                .observe(
                    &SttFrame::ItemStarted {
                        generation: 1,
                        item_id: (*item_id).to_string(),
                        ordinal: 0,
                        audio_start_ms: audio_ms,
                    },
                    audio_ms,
                )
                .or(last);
            for text in *partials {
                audio_ms += 800.0;
                last = state
                    .observe(
                        &SttFrame::Partial {
                            generation: 1,
                            item_id: (*item_id).to_string(),
                            text: (*text).to_string(),
                        },
                        audio_ms,
                    )
                    .or(last);
            }
            audio_ms += 800.0;
            last = state
                .observe(
                    &SttFrame::Final {
                        generation: 1,
                        item_id: (*item_id).to_string(),
                        text: (*final_text).to_string(),
                        audio_end_ms: audio_ms,
                    },
                    audio_ms,
                )
                .or(last);
        }
        last.expect("a running session answers every transcript frame")
    }

    #[test]
    fn the_starter_script_read_verbatim_is_followed_to_the_last_word() {
        let tokens = starter_tokens();
        assert_eq!(tokens.len(), 26, "the starter script has 26 spoken tokens");

        let state = AlignmentState::new();
        state.start(1, &tokens);
        let snapshot = replay(&state, TAKE);

        assert_eq!(snapshot.state, "following");
        assert!(
            snapshot.confirmed_token >= 25.0,
            "a word-perfect read of the app's own starter script was not followed: \
             confirmed {} of 26",
            snapshot.confirmed_token
        );
        assert!(snapshot.confidence >= 0.6, "confidence {}", snapshot.confidence);
    }

    /// Following at the END is not following.
    ///
    /// The cursor has to move as the presenter reads, so the first utterance
    /// alone must commit — this is the assertion that fails if the engine only
    /// ever resolves in hindsight.
    #[test]
    fn the_first_sentence_commits_before_the_second_is_spoken() {
        let state = AlignmentState::new();
        state.start(1, &starter_tokens());
        let snapshot = replay(&state, &TAKE[..1]);

        assert!(
            snapshot.confirmed_token >= 12.0,
            "the first sentence did not commit while it was the only thing said: \
             confirmed {}",
            snapshot.confirmed_token
        );
        assert!(snapshot.confirmed_token <= 14.0, "ran past the first sentence");
    }

    /// Partials move the display before the final arrives.
    ///
    /// This is what the presenter actually experiences — a cursor that waits
    /// for endpointing lags by a whole utterance, which reads as the script
    /// being stuck and then lurching.
    #[test]
    fn partials_advance_the_observed_position_before_any_final() {
        let state = AlignmentState::new();
        state.start(1, &starter_tokens());

        let early = state
            .observe(
                &SttFrame::Partial {
                    generation: 1,
                    item_id: "1-0".into(),
                    text: "Write the words you plan to".into(),
                },
                800.0,
            )
            .expect("session running");
        assert!(
            early.observed_token >= 5.0,
            "partials did not move the position: observed {}",
            early.observed_token
        );
        // Nothing is confirmed yet — a partial is revisable evidence.
        assert!(early.confirmed_token <= early.observed_token);
    }
}
