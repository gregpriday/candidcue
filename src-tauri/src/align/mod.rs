//! Live speech-to-script alignment — the app's host for [`cc_align::Engine`].
//!
//! ---------------------------------------------------------------------------
//! WHY THE ENGINE LIVES HERE
//! ---------------------------------------------------------------------------
//! The alignment engine is a pure crate (`crates/cc-align`): no I/O, no clocks,
//! no randomness. This module is everything the crate deliberately refuses to
//! know — where transcript frames come from, what the audio clock reads, and
//! who wants to hear the answer. It sits next to the speech session
//! (`crate::speech`) because that is where the frames and the audio clock
//! already are: feeding the engine anywhere else would mean shipping both
//! across a process boundary and re-deriving a clock on the far side, which is
//! precisely the arrangement the previous TypeScript aligner failed under.
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

use cc_align::{project_to_tokens, AlignmentConfig, Engine, SessionEvent, TokenInput};
use serde::Deserialize;
use tauri::{Emitter, Manager};

use crate::speech::session::SttFrame;
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
    /// The last token of its sentence, per the compiler that laid the script
    /// out. The engine brakes prediction here rather than carrying the display
    /// into a sentence the reader has not started.
    ///
    /// It has to be told: the app's tokenizer drops terminal punctuation, so
    /// `end.` reaches this struct as `end` and no amount of looking at
    /// `surface` recovers the boundary. Defaulted so a payload from before this
    /// existed still deserializes — and costs only the finer ceiling, since
    /// paragraph ends are sentence ends regardless.
    #[serde(default)]
    pub sentence_end: bool,
}

/// What the stage and control receive after every transcript event.
///
/// Defined by the ENGINE crate (`cc_align::TokenSnapshot`), not here. It used to
/// be declared in this file next to the atom-to-token projection that builds it,
/// which put both out of reach of the benchmark harness — so the harness could
/// prove the ENGINE follows and could say nothing at all about whether the STAGE
/// does. Those are the two halves of "does the product follow", and the failure
/// that falls between them (the aligner is fine, the glass never moved) is
/// exactly the one this split was hiding. `cc-bench` now emits this same shape.
pub type AlignmentSnapshot = cc_align::TokenSnapshot;

/// A running alignment session.
///
/// ---------------------------------------------------------------------------
/// TWO GENERATIONS, AND THEY ARE NOT THE SAME NUMBER
/// ---------------------------------------------------------------------------
/// This is the trap that has now cost two rewrites, so it is spelled out here
/// rather than left to be rediscovered:
///
///   * `label` is the SESSION generation — the coordinator's count of takes.
///     Control assigns it, both webviews already know it, and it is stamped on
///     every snapshot purely so consumers can tell one take's output from
///     another's. Nothing is filtered on it here.
///
///   * `stream_generation` is the TRANSCRIPTION generation — Rust's own count
///     of recogniser sessions, minted by `SpeechEngine::start_stream`. This is
///     what a frame carries, and therefore the only thing a frame may be
///     filtered against.
///
/// They are unrelated counters and they routinely disagree: the microphone test
/// consumes stream generation 1, so the first real take runs on stream 2 while
/// the coordinator is still on session 1. Comparing a frame's stream number
/// against the take's session number therefore discards every word from a
/// recogniser reporting perfect health — words heard, nothing followed, no
/// error anywhere.
struct AlignmentSession {
    /// Echoed onto every snapshot as `session_generation`. Never a filter.
    label: u64,
    /// The socket whose frames this engine will accept, once one is bound.
    /// `None` until a stream starts, and an unbound session follows nothing —
    /// which is correct: there is no audio yet to follow.
    stream_generation: Option<u64>,
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

    /// Compile `tokens` and arm the engine against them.
    ///
    /// The script is compiled as English, stated here rather than defaulted
    /// into: this is the only entry point in this file that picks a language
    /// without being told one, and it exists for tests and for callers that
    /// have no setting to consult. Anything on the take path goes through
    /// [`AlignmentState::start_in`] instead, carrying the language the setting
    /// resolved to.
    ///
    /// `label` is the take's SESSION generation — an identity echoed onto every
    /// snapshot, never a filter (see [`AlignmentSession`]). The session starts
    /// UNBOUND: it follows nothing until [`AlignmentState::bind_stream`] ties
    /// it to the socket that will feed it.
    ///
    /// Replaces any session already running: a new take supersedes the old one,
    /// and keeping the previous engine alive would let speech from before the
    /// change drag the cursor.
    pub fn start(&self, label: u64, tokens: &[AlignToken]) {
        self.start_in(label, tokens, cc_align::AlignmentLanguage::English);
    }

    /// Compile `tokens` as `language` and arm the engine against them.
    ///
    /// The language is a PARAMETER rather than something this state reads for
    /// itself, and deliberately: `AlignmentState` owns an engine, not a
    /// database, and a take that consulted settings mid-flight could change
    /// language under a running session. The caller latches it once, at the top
    /// of the take, and hands it down.
    pub fn start_in(
        &self,
        label: u64,
        tokens: &[AlignToken],
        language: cc_align::AlignmentLanguage,
    ) {
        self.start_bound(label, None, tokens, language);
    }

    /// Arm the engine, optionally already bound to a live socket.
    ///
    /// `stream_generation` is `Some` when a transcription stream is ALREADY
    /// running as the take arms. That happens because both calls are async IPC
    /// and their landing order is not guaranteed: if the socket wins the race,
    /// `bind_stream` has already fired against no session and would never fire
    /// again. Seeding here is what makes the binding order-independent — and a
    /// later `bind_stream` still supersedes it, so a stale seed cannot stick.
    pub fn start_bound(
        &self,
        label: u64,
        stream_generation: Option<u64>,
        tokens: &[AlignToken],
        language: cc_align::AlignmentLanguage,
    ) {
        let inputs: Vec<TokenInput> = tokens
            .iter()
            .map(|t| TokenInput {
                surface: t.surface.clone(),
                line: t.line,
                para: t.para,
                sentence_end: t.sentence_end,
            })
            .collect();
        // The language the SETTING resolved to, which is what #157 threaded
        // here.
        //
        // This used to be a hardcoded `English` with a comment saying that the
        // day a second profile existed, the setting would have to reach this
        // line. It does now. What arrives is already resolved to a profile the
        // engine has — `start_alignment` asks `AlignmentLanguage::from_bcp47`
        // and falls back to English when the persisted tag names a language
        // this build cannot normalise — so there is no tag parsing and no
        // silent English fallback buried in the compile call itself.
        let script = cc_align::compile_tokens_in(&inputs, language);
        let engine = Engine::new(script, AlignmentConfig::default());
        *self.lock() = Some(AlignmentSession {
            label,
            stream_generation,
            engine,
            last_audio_ms: 0.0,
        });
    }

    /// Tie the armed session to the recogniser stream now feeding it.
    ///
    /// Called by `SpeechEngine::start_stream` at the moment a generation is
    /// minted, which is the only place that number exists — asking the frontend
    /// for it would be asking it to guess, and the guess it made was the
    /// session generation.
    ///
    /// Binding BEFORE the decoder thread is spawned is what makes this exact:
    /// no frame of the new stream can arrive first, and the previous stream's
    /// frames stop being accepted the instant its successor exists.
    pub fn bind_stream(&self, generation: u64) {
        if let Some(session) = self.lock().as_mut() {
            session.stream_generation = Some(generation);
        }
    }

    pub fn stop(&self) {
        *self.lock() = None;
    }

    /// The take label currently being aligned, if any.
    pub fn label(&self) -> Option<u64> {
        self.lock().as_ref().map(|s| s.label)
    }

    /// The socket this session accepts frames from, if one is bound.
    pub fn bound_stream(&self) -> Option<u64> {
        self.lock().as_ref().and_then(|s| s.stream_generation)
    }

    /// A poisoned alignment mutex must not take the app down: the panic that
    /// poisoned it already happened, and refusing to follow the script
    /// afterwards helps nobody. The session inside is plain data.
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<AlignmentSession>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The same observation, from a recogniser that did not time its words.
    ///
    /// Test-only. Production always goes through
    /// [`AlignmentState::observe_with_word_times`], because the recogniser the
    /// app ships DOES time its words and a path that quietly dropped them would
    /// be the bug this exists to prevent.
    #[cfg(test)]
    fn observe(&self, frame: &SttFrame, audio_now_ms: f64) -> Option<AlignmentSnapshot> {
        self.observe_with_word_times(frame, audio_now_ms, None)
    }

    /// Feed one transcript frame and return the projected snapshot.
    ///
    /// `audio_now_ms` is the session's bytes-sent audio clock read at the
    /// moment the frame arrived. It is NOT wall-clock time: the engine's lag
    /// model (`partial_lag_ms` / `endpoint_lag_ms`) was measured against the
    /// audio clock on live captures, and substituting a wall clock silently
    /// mis-times every prediction.
    fn observe_with_word_times(
        &self,
        frame: &SttFrame,
        audio_now_ms: f64,
        word_times: Option<&[cc_stt::WordTime]>,
    ) -> Option<AlignmentSnapshot> {
        let mut guard = self.lock();
        let session = guard.as_mut()?;
        // The SOCKET's number, not the take's. See `AlignmentSession`.
        let bound = session.stream_generation?;

        // A field copy and nothing else. Which words the recogniser's words
        // correspond to is a lexical question, and this module does not answer
        // lexical questions — the engine lines them up against its own atoms.
        let timed = || {
            word_times.map(|words| {
                words
                    .iter()
                    .map(|word| cc_align::TranscriptWordTime {
                        text: word.text.clone(),
                        start_ms: word.start_ms,
                    })
                    .collect()
            })
        };

        let event = match frame {
            SttFrame::ItemStarted {
                generation,
                item_id,
                audio_start_ms,
                ..
            } if *generation == bound => SessionEvent::ItemStarted {
                item_id: item_id.clone(),
                audio_start_ms: *audio_start_ms,
            },
            SttFrame::Partial {
                generation,
                item_id,
                text,
            } if *generation == bound => SessionEvent::Partial {
                item_id: item_id.clone(),
                text: text.clone(),
                audio_ms: audio_now_ms,
                word_times: timed(),
            },
            SttFrame::Final {
                generation,
                item_id,
                text,
                audio_end_ms,
            } if *generation == bound => SessionEvent::Final {
                item_id: item_id.clone(),
                text: text.clone(),
                audio_end_ms: *audio_end_ms,
                word_times: timed(),
            },
            // Transport, failure and audio-drop frames say nothing about where
            // the reader is. Feeding them would be inventing evidence.
            _ => return None,
        };

        session.last_audio_ms = audio_now_ms.max(session.last_audio_ms);
        let snapshot = session.engine.handle(event);
        Some(project_to_tokens(&snapshot, &session.engine.script, session.label))
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
        Some(project_to_tokens(&snapshot, &session.engine.script, session.label))
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
        // `last_token` is INCLUSIVE — the stage reports the last token it can
        // see — so the visible range ends at that token's far edge, not its
        // near one. Mapping the near edge drops the tail of any multi-atom
        // token, and a long hyphenated compound at the bottom of the screen
        // would then read as off-screen.
        let last = session
            .engine
            .script
            .atom_at(last_token + 1.0)
            .ceil()
            .max(0.0) as u32;
        session.engine.set_viewport_hint(first, last);
    }

    fn clear_viewport(&self) {
        if let Some(session) = self.lock().as_mut() {
            session.engine.clear_viewport_hint();
        }
    }
}

/// Publish a snapshot to both audiences.
///
/// The stage gets it for motion, control gets it for progress and the take
/// summary. Two names rather than one shared name: they are different
/// contracts to different windows, and a stage that starts receiving control's
/// diagnostics traffic is a stage doing work it has no reason to do.
fn publish<R: tauri::Runtime>(app: &tauri::AppHandle<R>, snapshot: &AlignmentSnapshot) {
    if let (Some(coordinator), Ok(value)) = (
        app.try_state::<crate::coordinator::AppCoordinator>(),
        serde_json::to_value(snapshot),
    ) {
        coordinator.store_stage_alignment(value);
    }
    // A failed emit means that window is gone, which alignment can do nothing
    // about and must not tear the session down for.
    let _ = app.emit_to(STAGE_LABEL, events::STAGE_ALIGNMENT_SNAPSHOT, snapshot);
    let _ = app.emit_to(CONTROL_LABEL, events::ALIGN_SNAPSHOT, snapshot);
}

/// Tie the armed alignment session to a newly minted recogniser stream.
///
/// Called from `SpeechEngine::start_stream`, which is where the generation
/// comes into existence. `try_state` rather than `state`: a runtime that never
/// managed an `AlignmentState` (a Rust integration test standing up the stream
/// alone) must not panic here — it simply has no alignment to bind.
pub fn bind_stream_generation<R: tauri::Runtime>(app: &tauri::AppHandle<R>, generation: u64) {
    if let Some(state) = app.try_state::<AlignmentState>() {
        state.bind_stream(generation);
    }
}

/// The single hook the recogniser thread calls. Called only for transcript
/// frames, with the audio clock read at arrival.
///
/// `word_times` rides alongside the frame rather than inside it. The renderer's
/// [`SttFrame`] is the `stt://event` wire contract and has no use for per-word
/// timing — the alignment engine lives in Rust and consumes these beside the
/// audio clock they were measured against — so widening that type would be
/// paying a protocol change for an audience of nobody.
pub fn observe_frame<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    frame: &SttFrame,
    audio_now_ms: f64,
    word_times: Option<&[cc_stt::WordTime]>,
) {
    let state: tauri::State<'_, AlignmentState> = app.state();
    if let Some(snapshot) = state.observe_with_word_times(frame, audio_now_ms, word_times) {
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
    if state.label() != Some(hint.session_generation) {
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
                sentence_end: false,
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
        state.bind_stream(7);

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

    /// The recogniser's word times survive the trip across this module.
    ///
    /// This is the production path: `session.rs` pulls `word_times` off the raw
    /// `cc_stt` frame and hands it here alongside the renderer-shaped one. The
    /// engine's own tests prove what it does with them; what this proves is
    /// that they arrive at all, and that carrying them does not disturb the
    /// answer for a session that gets none.
    #[test]
    fn word_times_reach_the_engine_without_widening_the_wire_frame() {
        // A trailing word the script does not contain, so the last MATCHED
        // atom is interior — the final atom of an item lands on the item's
        // corrected end whether or not it was measured.
        let heard = "good morning everyone and welcome to the quarterly review nevertheless";
        let frame = || SttFrame::Final {
            generation: 7,
            item_id: "7-0".into(),
            text: heard.into(),
            audio_end_ms: 8_000.0,
        };
        let observed_with = |times: Option<&[cc_stt::WordTime]>| {
            let state = AlignmentState::new();
            state.start(7, &tokens(SCRIPT));
            state.bind_stream(7);
            // Without this the ledger opens the item AT the final's own clock,
            // collapsing its window to a millisecond — every measurement then
            // reads as earlier and is declined, and this test would pass while
            // proving nothing.
            state.observe(
                &SttFrame::ItemStarted {
                    generation: 7,
                    item_id: "7-0".into(),
                    ordinal: 0,
                    audio_start_ms: 0.0,
                },
                0.0,
            );
            state
                .observe_with_word_times(&frame(), 8_000.0, times)
                .expect("a running session answers a transcript frame")
        };

        // Spoken late in the item but inside the window a 1400 ms endpoint
        // correction leaves (0..6600) — and later than the even spread, which
        // puts the last matched atom at 5940. A measurement that fell earlier
        // than the spread would be declined by design and prove nothing.
        let times: Vec<cc_stt::WordTime> = heard
            .split_whitespace()
            .enumerate()
            .map(|(i, text)| cc_stt::WordTime {
                text: text.to_string(),
                start_ms: 6_000.0 + i as f64 * 50.0,
            })
            .collect();

        let untimed = observed_with(None);
        let timed = observed_with(Some(&times));

        // The sidecar reached the engine and dated the evidence LATER. Strict,
        // so this fails rather than passes if the timing is dropped in transit.
        assert!(
            timed.evidence_audio_ms > untimed.evidence_audio_ms,
            "word times did not survive the handoff: {} !> {}",
            timed.evidence_audio_ms,
            untimed.evidence_audio_ms
        );
        // Same reader, same place — timing dates the evidence, it does not
        // relocate anyone.
        assert_eq!(timed.state, untimed.state);
        assert!((timed.observed_token - untimed.observed_token).abs() <= 2.0);

        // The renderer's frame is untouched by any of this: `word_times` is not
        // a field on it, so the `stt://event` payload cannot have grown one.
        let wire = serde_json::to_value(frame()).expect("frame serialises");
        assert!(
            wire.get("wordTimes").is_none() && wire.get("word_times").is_none(),
            "the wire frame grew a timing field: {wire}"
        );
    }

    /// A non-English script compiles, follows, and produces different ATOMS.
    ///
    /// Two separate claims, because an earlier version of this test conflated
    /// them and was wrong for an instructive reason. It asserted that compiling
    /// a French script as English would track WORSE, and it does not: script
    /// and transcript pass through the SAME normaliser, so a wrong profile
    /// makes both sides wrong in the same direction and they go on matching
    /// each other. `language.rs` says this exactly — an unanswered
    /// `DecimalSyntax` rule is "not a missed match, it is the wrong number".
    /// The damage is that the atom is a figure the reader never says, which
    /// costs nothing until real speech arrives and everything afterwards.
    ///
    /// So the atom-level difference is asserted where it is visible, and what
    /// is asserted HERE is the part only this layer can show: the one
    /// conversion in the system — engine atoms to app tokens, in this module —
    /// has never run on a non-English profile before, and it holds up.
    ///
    /// This is a unit test of the wiring. It is NOT evidence that French
    /// follows on real audio; that needs a corpus and the gate in `cc-bench`.
    #[test]
    fn a_script_is_compiled_in_the_language_it_was_armed_with() {
        const FRENCH_SCRIPT: &[&str] = &[
            "nos", "revenus", "ont", "augmenté", "de", "12,5%", "ce", "trimestre",
            "et", "l'équipe", "a", "livré", "trois", "fonctionnalités",
        ];

        // The profiles genuinely disagree about this script: French points with
        // a comma and reads `%` as two words. If this ever stops differing, the
        // session assertions below would pass without meaning anything.
        let as_french = cc_align::normalize::canonical_atoms_for(
            cc_align::AlignmentLanguage::French,
            "12,5%",
        );
        let as_english = cc_align::normalize::canonical_atoms_for(
            cc_align::AlignmentLanguage::English,
            "12,5%",
        );
        assert_eq!(as_french, vec!["12.5", "pour", "cent"]);
        assert_eq!(as_english, vec!["125", "percent"]);

        let french = AlignmentState::new();
        french.start_in(1, &tokens(FRENCH_SCRIPT), cc_align::AlignmentLanguage::French);

        // The load-bearing assertion: the ARMED engine's script says French.
        // Everything else in this test would still pass if `start_in` threw the
        // parameter away and compiled English — the atom comparison above is
        // standalone, and the session below advances either way, because script
        // and transcript share whatever profile was used. This reads it back
        // off the engine, so dropping the argument fails here and only here.
        assert_eq!(
            french
                .lock()
                .as_ref()
                .expect("a session was just armed")
                .engine
                .script
                .language(),
            cc_align::AlignmentLanguage::French,
            "the language did not reach `compile_tokens_in`"
        );

        french.bind_stream(1);
        let snapshot = french
            .observe(
                &SttFrame::Final {
                    generation: 1,
                    item_id: "1-0".into(),
                    text: "nos revenus ont augmenté de 12,5 pour cent ce trimestre".into(),
                    audio_end_ms: 3_000.0,
                },
                3_000.0,
            )
            .expect("a running session answers a transcript frame");

        assert_eq!(snapshot.state, "following");
        assert_eq!(snapshot.script_len_tokens, FRENCH_SCRIPT.len() as f64);
        // Eight of the fourteen script tokens were spoken. The atom-to-token
        // conversion has to land near there rather than anywhere: a French
        // figure that expanded to three atoms against one token is precisely
        // where that mapping could drift.
        assert!(
            (snapshot.observed_token - 8.0).abs() <= 2.0,
            "French speech against a French script should sit near token 8, \
             got {}",
            snapshot.observed_token
        );
        assert!(snapshot.confirmed_token <= snapshot.observed_token);
    }

    /// Frames from a superseded transcription socket must not reach the engine:
    /// this is the check that keeps the tail of a stopped take out of the next
    /// one's alignment.
    #[test]
    fn frames_from_another_socket_are_ignored() {
        let state = AlignmentState::new();
        state.start(1, &tokens(SCRIPT));
        state.bind_stream(2);
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

    /// THE REGRESSION THIS FILE EXISTS FOR.
    ///
    /// The take's session generation and the socket's generation are unrelated
    /// counters, and they disagree the moment Preflight's microphone test has
    /// consumed a socket. Filtering frames on the session number therefore
    /// dropped every word of every take, over a connection reporting perfect
    /// health — "words heard 28, script followed 0 of 26", with nothing
    /// anywhere reporting an error.
    #[test]
    fn a_take_follows_when_its_label_and_its_socket_disagree() {
        let state = AlignmentState::new();
        // Session 1 (the first take) on socket 2 (Preflight took socket 1).
        state.start(1, &tokens(SCRIPT));
        state.bind_stream(2);

        let snapshot = state
            .observe(
                &SttFrame::Final {
                    generation: 2,
                    item_id: "2-0".into(),
                    text: "good morning everyone and welcome".into(),
                    audio_end_ms: 2_000.0,
                },
                2_000.0,
            )
            .expect("a frame from the BOUND socket must reach the engine");

        assert_eq!(snapshot.state, "following");
        assert!(
            snapshot.observed_token > 0.0,
            "the cursor never moved: {} tokens",
            snapshot.observed_token,
        );
        // And the snapshot is labelled with the TAKE, which is the identity
        // both webviews already know.
        assert_eq!(snapshot.session_generation, 1);
    }

    /// An armed-but-unbound session follows nothing. There is no socket, so
    /// there is no audio — accepting a frame here would mean accepting one from
    /// a stream this take has nothing to do with.
    #[test]
    fn an_unbound_session_accepts_nothing() {
        let state = AlignmentState::new();
        state.start(1, &tokens(SCRIPT));
        assert_eq!(state.bound_stream(), None);
        assert!(state
            .observe(
                &SttFrame::Final {
                    generation: 1,
                    item_id: "1-0".into(),
                    text: "good morning everyone".into(),
                    audio_end_ms: 900.0,
                },
                900.0,
            )
            .is_none());
    }

    /// The socket won the race: the stream was already running when the take
    /// armed, so `bind_stream` fired against no session and will never fire
    /// again. Seeding at arm time is what keeps that ordering from silently
    /// costing the whole take.
    #[test]
    fn a_session_armed_after_its_socket_still_follows() {
        let state = AlignmentState::new();
        state.start_bound(1, Some(2), &tokens(SCRIPT), cc_align::AlignmentLanguage::English);
        assert_eq!(state.bound_stream(), Some(2));
        assert!(state
            .observe(
                &SttFrame::Final {
                    generation: 2,
                    item_id: "2-0".into(),
                    text: "good morning everyone".into(),
                    audio_end_ms: 900.0,
                },
                900.0,
            )
            .is_some());
    }

    /// A reconnect keeps the same socket generation, so following survives it;
    /// a NEW socket rebinds, and the old one stops being heard.
    #[test]
    fn rebinding_supersedes_the_previous_socket() {
        let state = AlignmentState::new();
        state.start(1, &tokens(SCRIPT));
        state.bind_stream(2);
        state.bind_stream(3);
        assert_eq!(state.bound_stream(), Some(3));
        assert!(state
            .observe(
                &SttFrame::Final {
                    generation: 2,
                    item_id: "2-0".into(),
                    text: "good morning".into(),
                    audio_end_ms: 500.0,
                },
                500.0,
            )
            .is_none());
        assert!(state
            .observe(
                &SttFrame::Final {
                    generation: 3,
                    item_id: "3-0".into(),
                    text: "good morning".into(),
                    audio_end_ms: 500.0,
                },
                500.0,
            )
            .is_some());
    }

    #[test]
    fn transport_frames_never_feed_the_engine() {
        let state = AlignmentState::new();
        state.start(1, &tokens(SCRIPT));
        state.bind_stream(1);
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
        state.bind_stream(1);
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
        state.bind_stream(1);

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
        state.bind_stream(1);
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

    /// The rate must describe how fast the reader is actually moving, even when
    /// the prediction horizon runs off the end of the script. Dividing a
    /// clamped distance by the full horizon reports a crawl.
    #[test]
    fn the_rate_stays_honest_at_the_end_of_the_script() {
        let state = AlignmentState::new();
        state.start(1, &tokens(SCRIPT));
        state.bind_stream(1);

        // Read the whole script, so the engine is at the end with a live rate.
        let heard = SCRIPT.join(" ").to_lowercase();
        let snapshot = state
            .observe(
                &SttFrame::Final {
                    generation: 1,
                    item_id: "1-0".into(),
                    text: heard,
                    audio_end_ms: 7_000.0,
                },
                7_000.0,
            )
            .expect("session is running");

        if snapshot.rate_tokens_per_second > 0.0 {
            // Whatever remains of the script, the reported pace must still be a
            // plausible reading pace rather than an artefact of the clamp.
            assert!(
                snapshot.rate_tokens_per_second > 0.5,
                "rate collapsed to {} tokens/s at the end of the script",
                snapshot.rate_tokens_per_second
            );
        }
        // And the prediction still cannot run past the end.
        let reach = snapshot.observed_token
            + snapshot.rate_tokens_per_second * snapshot.max_prediction_ms / 1000.0;
        assert!(reach <= snapshot.script_len_tokens + 1e-9);
    }

    #[test]
    fn viewport_hints_are_scoped_to_their_session() {
        let state = AlignmentState::new();
        state.start(4, &tokens(SCRIPT));
        state.bind_stream(4);

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
        assert_eq!(state.label(), Some(4));
    }

    #[test]
    fn starting_a_new_session_replaces_the_old_engine() {
        let state = AlignmentState::new();
        state.start(1, &tokens(SCRIPT));
        state.bind_stream(1);
        state.start(2, &tokens(&["completely", "different", "script", "text"]));
        // A new take arms UNBOUND: the previous socket binding must not carry
        // over, or the new engine would start listening to the old take.
        assert_eq!(state.bound_stream(), None);
        state.bind_stream(2);
        assert_eq!(state.label(), Some(2));
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
        assert_eq!(state.label(), None);
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

    /// The prose the app once created new scripts with, kept verbatim as a
    /// captured fixture, already tokenized the way the app's compiler tokenizes
    /// it. The heading is not spoken and neither is the cue line, so 26 spoken
    /// tokens remain. New scripts now start empty, but this stays as-is: what
    /// it pins down is that a word-perfect read moves the cursor, and the
    /// captured take below was recorded against exactly these 26 tokens.
    fn starter_tokens() -> Vec<AlignToken> {
        let sentence_one = "Write the words you plan to say, exactly the way you would say them.";
        let sentence_two = "When you present, the stage follows your voice and keeps your place.";
        let mut tokens = Vec::new();
        for (para, sentence) in [sentence_one, sentence_two].iter().enumerate() {
            // The trim mirrors `tokenize.ts`: the app's surfaces never carry
            // their terminal punctuation, which is why the sentence boundary
            // travels as its own field rather than being read back off the text.
            let words: Vec<&str> = sentence.split_whitespace().collect();
            for (index, word) in words.iter().enumerate() {
                let surface = word.trim_matches(|c: char| c == '.' || c == ',');
                if surface.is_empty() {
                    continue;
                }
                tokens.push(AlignToken {
                    surface: surface.to_string(),
                    line: para as u32,
                    para: 0,
                    sentence_end: index + 1 == words.len(),
                });
            }
        }
        tokens
    }

    /// The two utterances the recogniser returned, at the word counts the trace
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
        assert_eq!(tokens.len(), 26, "the captured starter fixture has 26 spoken tokens");

        let state = AlignmentState::new();
        state.start(1, &tokens);
        state.bind_stream(1);
        let snapshot = replay(&state, TAKE);

        assert_eq!(snapshot.state, "following");
        assert!(
            snapshot.confirmed_token >= 25.0,
            "a word-perfect read of the captured starter fixture was not followed: \
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
        state.bind_stream(1);
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
        state.bind_stream(1);

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

/// One canonicalization contract, asserted from both directions.
///
/// The app's Markdown compiler decides WHAT is a spoken token; this crate
/// decides what a token SOUNDS like. Those are different jobs and they live in
/// different languages, which is exactly the arrangement that let `&` fall
/// down the gap: the app emitted it as a token and the engine dropped it, so
/// the app rendered a word nothing could ever match.
///
/// The fixtures below are the app tokenizer's output for surfaces that
/// exercise the seam — punctuation-adjacent words, currency, percentages,
/// compounds, acronyms. The rule they enforce is simple and total: **every
/// spoken token the app renders must produce at least one atom**, because a
/// token with no atom is a word on the glass that the engine cannot hear.
///
/// The matching TypeScript half lives in
/// `tests/unit/markdown/spoken-token-contract.test.ts`, which asserts the app
/// tokenizer really does produce these surfaces.
#[cfg(test)]
mod canonicalization_contract_tests {
    use super::*;

    /// Surfaces exactly as `tokenizeText` in `src/shared/markdown/tokenize.ts`
    /// emits them — including the standalone `&`, which it explicitly does.
    const APP_TOKEN_SURFACES: &[&str] = &[
        "Hello", "world", "R", "&", "D", "AT&T", "$12", "50%", "well-known",
        "don't", "e.g", "U.S.A", "3.14", "42", "CandidCue", "twenty-first",
        "£20", "€5", "co-founder", "API",
    ];

    /// The sentence boundary has exactly one route from the compiler to the
    /// engine, and it is this JSON field.
    ///
    /// Worth a test of its own because every way it can break is silent. The
    /// key is camelCase on the wire and snake_case in Rust, so a struct-level
    /// rename that went missing would leave `sentence_end` quietly false; and
    /// `#[serde(default)]` means a payload that never mentions it deserializes
    /// happily. Both failures look like "prediction is a bit loose", not like
    /// an error.
    #[test]
    fn a_sentence_boundary_survives_the_ipc_shape() {
        let flagged: AlignToken =
            serde_json::from_str(r#"{"surface":"bravo","line":0,"para":0,"sentenceEnd":true}"#)
                .expect("camelCase sentenceEnd must deserialize");
        assert!(flagged.sentence_end);

        // A payload from before this field existed is still valid, and says no.
        let legacy: AlignToken =
            serde_json::from_str(r#"{"surface":"bravo","line":0,"para":0}"#)
                .expect("a payload without the field must still deserialize");
        assert!(!legacy.sentence_end);

        // And it reaches the compiled script rather than stopping at the struct.
        let tokens = vec![
            AlignToken {
                surface: "alpha".into(),
                line: 0,
                para: 0,
                sentence_end: false,
            },
            flagged,
            AlignToken {
                surface: "charlie".into(),
                line: 0,
                para: 0,
                sentence_end: false,
            },
        ];
        let inputs: Vec<TokenInput> = tokens
            .iter()
            .map(|t| TokenInput {
                surface: t.surface.clone(),
                line: t.line,
                para: t.para,
                sentence_end: t.sentence_end,
            })
            .collect();
        let script = cc_align::compile_tokens(&inputs);
        assert_eq!(script.sentence_end, vec![2, 2, 3]);
    }

    #[test]
    fn every_spoken_token_the_app_renders_produces_at_least_one_atom() {
        let tokens: Vec<AlignToken> = APP_TOKEN_SURFACES
            .iter()
            .map(|s| AlignToken {
                surface: (*s).to_string(),
                line: 0,
                para: 0,
                sentence_end: false,
            })
            .collect();
        let inputs: Vec<TokenInput> = tokens
            .iter()
            .map(|t| TokenInput {
                surface: t.surface.clone(),
                line: t.line,
                para: t.para,
                sentence_end: t.sentence_end,
            })
            .collect();
        let script = cc_align::compile_tokens(&inputs);

        let unmatched: Vec<&str> = APP_TOKEN_SURFACES
            .iter()
            .enumerate()
            .filter(|(i, _)| !script.atoms.iter().any(|a| a.token == *i as u32))
            .map(|(_, s)| *s)
            .collect();
        assert!(
            unmatched.is_empty(),
            "these surfaces render as words but produce no atom, so nothing \
             spoken can ever match them: {unmatched:?}",
        );
    }

    /// The axis stays monotone and lands exactly on the token count, whatever
    /// the surfaces expand to. This is the property every projected position
    /// depends on.
    #[test]
    fn the_token_axis_covers_the_whole_script_monotonically() {
        let inputs: Vec<TokenInput> = APP_TOKEN_SURFACES
            .iter()
            .map(|s| TokenInput {
                surface: (*s).to_string(),
                line: 0,
                para: 0,
                sentence_end: false,
            })
            .collect();
        let script = cc_align::compile_tokens(&inputs);

        let mut previous = f64::NEG_INFINITY;
        for &position in &script.atom_token_pos {
            assert!(position >= previous, "axis went backwards at {position}");
            previous = position;
        }
        assert_eq!(script.token_count, APP_TOKEN_SURFACES.len() as u32);
        assert_eq!(
            *script.atom_token_pos.last().unwrap(),
            APP_TOKEN_SURFACES.len() as f64
        );
        // And a position at the very start is the very start.
        assert_eq!(script.token_at(0.0), 0.0);
    }

    /// `R & D` read aloud is "r and d" — the whole point of the seam.
    #[test]
    fn an_ampersand_script_follows_speech_that_says_and() {
        let state = AlignmentState::new();
        let tokens: Vec<AlignToken> = ["Welcome", "to", "R", "&", "D", "this", "quarter"]
            .iter()
            .map(|s| AlignToken {
                surface: (*s).to_string(),
                line: 0,
                para: 0,
                sentence_end: false,
            })
            .collect();
        state.start(1, &tokens);
        state.bind_stream(1);

        let snapshot = state
            .observe(
                &SttFrame::Final {
                    generation: 1,
                    item_id: "1-0".into(),
                    text: "welcome to r and d this quarter".into(),
                    audio_end_ms: 3_000.0,
                },
                3_000.0,
            )
            .expect("session is running");

        assert_eq!(snapshot.state, "following");
        assert!(
            snapshot.observed_token >= 6.0,
            "the ampersand broke the match: observed {} of 7",
            snapshot.observed_token
        );
    }
}
