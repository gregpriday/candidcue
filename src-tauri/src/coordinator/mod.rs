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
        state.stage = StageState {
            exists: true,
            visible: false,
            fullscreen: false,
            generation,
            session_id,
            display_fingerprint,
            hydrated: false,
            layout_ready: false,
            last_heartbeat_ms: None,
            last_tracking_revision: None,
            media_healthy: true,
        };
    }

    pub fn stage_closed(&self, generation: u64) {
        let mut state = self.state.lock().expect("coordinator poisoned");
        if state.stage.generation == generation {
            state.stage.exists = false;
            state.stage.hydrated = false;
            state.stage.layout_ready = false;
            state.stage.visible = false;
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
