//! Cross-subsystem authority (spec §43.4, §43.5, §44.2).
//!
//! A single mutex-protected service tracking window generations, the active
//! session, stage handshake/heartbeat state, and shutdown state. Subsystems
//! stay typed and separate; this only coordinates.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

#[derive(Debug, Default, Clone)]
pub struct StageState {
    pub exists: bool,
    pub visible: bool,
    pub fullscreen: bool,
    pub generation: u64,
    pub session_id: Option<String>,
    pub display_fingerprint: Option<String>,
    /// Handshake step 0: the stage webview's bundle has run and it can now
    /// receive events. Separate from `hydrated` because the gap between the
    /// two is where the lost first envelope lived, and because a stage that
    /// never gets this far has a different problem (its bundle failed to load)
    /// than one that gets this far and no further (its document never came).
    pub listening: bool,
    /// Stage handshake progress (spec §43.3 steps 5–7).
    pub hydrated: bool,
    pub layout_ready: bool,
    /// Last heartbeat instant (ms since Unix epoch) and acknowledged
    /// tracking revision (spec §43.5).
    pub last_heartbeat_ms: Option<i64>,
    pub last_tracking_revision: Option<i64>,
    pub media_healthy: bool,
}

#[derive(Debug, Default, Clone)]
pub struct SessionState {
    pub session_id: Option<String>,
    pub session_generation: u64,
    pub script_id: Option<String>,
    pub compile_hash: Option<String>,
}

#[derive(Debug, Default, Clone)]
pub struct CoordinatorSnapshot {
    pub stage: StageState,
    pub session: SessionState,
}

#[derive(Default)]
pub struct AppCoordinator {
    state: Mutex<CoordinatorSnapshot>,
    /// The last document envelope published to the stage, and the stage
    /// generation it was published under (spec §43.3).
    ///
    /// A Tauri webview `emit` is delivered by evaluating JS in the target
    /// webview. The stage window is created and returned from `open_stage`
    /// long before its bundle has executed, so the envelope that control
    /// publishes moments later can arrive at a page that has not yet
    /// registered a single listener — and a Tauri event has no queue, so it is
    /// simply gone. Nothing retried it, the stage therefore never hydrated,
    /// and `waitForStageReady` sat out its full timeout: no session could be
    /// started at all, which is exactly what "the stage did not finish
    /// preparing in time" was.
    ///
    /// So the envelope is kept here and replayed when the stage announces that
    /// its subscriptions are live (`stage://listening`). That also covers the
    /// stage window reloading mid-session, which is routine under `tauri dev`.
    ///
    /// Deliberately NOT part of `CoordinatorSnapshot`: the snapshot is cloned
    /// on every `get_stage_status` poll, and this is the largest payload in
    /// the app.
    ///
    /// LOCK ORDER: `state` before `pending_document`, always. Both are needed
    /// together because "which stage is open" and "whose document is held"
    /// have to change as one fact — deciding under `state`, releasing it, and
    /// then touching `pending_document` leaves a window in which a close for
    /// an old generation discards a new generation's envelope. Nothing may
    /// take `pending_document` first and then reach for `state`.
    pending_document: Mutex<Option<(u64, serde_json::Value)>>,
    stage_generation: AtomicU64,
    session_generation: AtomicU64,
    quitting: AtomicBool,
}

impl AppCoordinator {
    /// Monotonic stage generation; stale snapshots from a previous stage
    /// generation are ignored (spec §43.5).
    pub fn next_stage_generation(&self) -> u64 {
        self.stage_generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn next_session_generation(&self) -> u64 {
        self.session_generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn register_stage(
        &self,
        generation: u64,
        session_id: Option<String>,
        display_fingerprint: Option<String>,
    ) {
        let mut state = self.state.lock().expect("coordinator poisoned");
        // A new stage window starts with no document of its own; the previous
        // generation's envelope must not be replayable to it. Cleared while
        // holding `state`, so the two facts change together — see the lock
        // ordering note on `pending_document`.
        self.clear_stage_document();
        state.stage = StageState {
            exists: true,
            visible: false,
            fullscreen: false,
            generation,
            session_id,
            display_fingerprint,
            listening: false,
            hydrated: false,
            layout_ready: false,
            last_heartbeat_ms: None,
            last_tracking_revision: None,
            media_healthy: true,
        };
    }

    /// Remember the envelope published under `generation`, so it can be
    /// replayed to a stage that was not yet listening when it was sent.
    ///
    /// Returns false if that stage is no longer the open one. The caller
    /// validated the generation against a snapshot it has since released, and
    /// a window can be destroyed in the gap; storing anyway would leave up to
    /// `MAX_STAGE_DOCUMENT_BYTES` tied to a window that no close will ever come
    /// for, because its close already ran.
    pub fn store_stage_document(&self, generation: u64, envelope: serde_json::Value) -> bool {
        let state = self.state.lock().expect("coordinator poisoned");
        if !state.stage.exists || state.stage.generation != generation {
            return false;
        }
        *self.pending_document.lock().expect("coordinator poisoned") =
            Some((generation, envelope));
        true
    }

    /// The envelope to replay for the CURRENT stage, if there is one.
    ///
    /// Generation-checked like every other stage path: an envelope left over
    /// from a previous stage window is never replayed to a new one, so a
    /// reloading stage can only ever be handed the document it was opened for.
    pub fn stage_document_for_replay(&self) -> Option<(u64, serde_json::Value)> {
        let state = self.state.lock().expect("coordinator poisoned");
        if !state.stage.exists {
            return None;
        }
        let current = state.stage.generation;
        let pending = self.pending_document.lock().expect("coordinator poisoned");
        match pending.as_ref() {
            Some((generation, envelope)) if *generation == current => {
                Some((current, envelope.clone()))
            }
            _ => None,
        }
    }

    /// The current stage announced that its subscriptions are live.
    ///
    /// Ungenerationed on purpose: the stage does not learn its generation
    /// until the envelope arrives, so this is the one stage-originated fact
    /// that cannot carry one. It is applied to whichever window is currently
    /// open, which is the only one that could have emitted it.
    pub fn stage_listening(&self) {
        let mut state = self.state.lock().expect("coordinator poisoned");
        if state.stage.exists {
            state.stage.listening = true;
        }
    }

    pub fn clear_stage_document(&self) {
        *self.pending_document.lock().expect("coordinator poisoned") = None;
    }

    pub fn stage_closed(&self, generation: u64) {
        let mut state = self.state.lock().expect("coordinator poisoned");
        if state.stage.generation == generation {
            state.stage.exists = false;
            state.stage.listening = false;
            state.stage.hydrated = false;
            state.stage.layout_ready = false;
            state.stage.visible = false;
        }
        /*
         * Nothing can be replayed to a window that is gone, and holding the
         * envelope would keep a whole compiled script alive for the life of
         * the process. Qualified by generation and done under `state`, both
         * deliberately.
         *
         * A window's `Destroyed` callback runs on another thread, so a close
         * for generation G can still be in flight while `open_stage` registers
         * G+1 and control publishes for it — this is the ordinary retake path,
         * where `open_stage` destroys the previous window itself. Deciding
         * under `state`, releasing, and then clearing unconditionally left a
         * window in which the late close wiped the NEW stage's envelope, whose
         * only symptom would have been the exact start-up timeout this whole
         * mechanism exists to prevent.
         */
        let mut pending = self.pending_document.lock().expect("coordinator poisoned");
        if matches!(pending.as_ref(), Some((held, _)) if *held == generation) {
            *pending = None;
        }
    }

    /// Apply stage-originated handshake/heartbeat facts. Events carrying a
    /// stale generation are ignored (spec §43.5).
    pub fn stage_event(&self, generation: u64, apply: impl FnOnce(&mut StageState)) -> bool {
        let mut state = self.state.lock().expect("coordinator poisoned");
        if state.stage.generation != generation || !state.stage.exists {
            return false;
        }
        apply(&mut state.stage);
        true
    }

    pub fn set_stage_visible(&self, visible: bool, fullscreen: bool) {
        let mut state = self.state.lock().expect("coordinator poisoned");
        state.stage.visible = visible;
        state.stage.fullscreen = fullscreen;
    }

    pub fn begin_session(
        &self,
        session_id: String,
        script_id: String,
        compile_hash: Option<String>,
    ) -> u64 {
        let generation = self.next_session_generation();
        let mut state = self.state.lock().expect("coordinator poisoned");
        state.session = SessionState {
            session_id: Some(session_id),
            session_generation: generation,
            script_id: Some(script_id),
            compile_hash,
        };
        generation
    }

    pub fn end_session(&self, session_id: &str) {
        let mut state = self.state.lock().expect("coordinator poisoned");
        if state.session.session_id.as_deref() == Some(session_id) {
            state.session = SessionState {
                session_generation: state.session.session_generation,
                ..Default::default()
            };
        }
    }

    pub fn snapshot(&self) -> CoordinatorSnapshot {
        self.state.lock().expect("coordinator poisoned").clone()
    }

    pub fn begin_quit(&self) {
        self.quitting.store(true, Ordering::SeqCst);
    }

    pub fn is_quitting(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
    }
}
