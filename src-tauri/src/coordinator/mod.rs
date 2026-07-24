//! Cross-subsystem authority (spec §43.4, §44.2).
//!
//! A single mutex-protected service tracking window generations, the active
//! session, and shutdown state. Subsystems stay typed and separate; this only
//! coordinates.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

#[derive(Debug, Default, Clone)]
pub struct CoordinatorSnapshot {
    pub stage_exists: bool,
    pub stage_generation: u64,
    pub selected_display_fingerprint: Option<String>,
    pub active_session_id: Option<String>,
    pub active_script_id: Option<String>,
    pub active_compile_hash: Option<String>,
}

#[derive(Default)]
pub struct AppCoordinator {
    state: Mutex<CoordinatorSnapshot>,
    stage_generation: AtomicU64,
    quitting: AtomicBool,
}

impl AppCoordinator {
    /// Monotonic stage generation; stale snapshots from a previous stage
    /// generation are ignored (spec §43.5).
    pub fn next_stage_generation(&self) -> u64 {
        self.stage_generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn register_stage(&self, generation: u64, session_id: Option<String>) {
        let mut state = self.state.lock().expect("coordinator poisoned");
        state.stage_exists = true;
        state.stage_generation = generation;
        state.active_session_id = session_id;
    }

    pub fn stage_closed(&self, generation: u64) {
        let mut state = self.state.lock().expect("coordinator poisoned");
        if state.stage_generation == generation {
            state.stage_exists = false;
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
