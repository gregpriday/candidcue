//! The one recogniser kept in memory, and the rules for replacing it.
//!
//! Split out of `SpeechEngine` so the rules can be tested without a model. The
//! weights are ~161 MB and not in git, so nothing in the suite can load a real
//! recogniser — but every rule here is about WHEN a load runs and what has to
//! wait for it, and none of that depends on what is being loaded.
//!
//! ---------------------------------------------------------------------------
//! TWO LOCKS, AND THE DIFFERENCE BETWEEN THEM IS THE POINT
//! ---------------------------------------------------------------------------
//! `slot` says what is resident. It is held for a pointer copy and never across
//! a load, so "which model is loaded?" answers at once while one is loading.
//! The status line and a model deletion both ask that question, and both used
//! to wait out the whole load behind a single mutex — over a second, five on a
//! slow start — each parking an async worker to do it (#256).
//!
//! `load_gate` serialises loads. Preload and the start of a take arrive
//! together as the normal case, not as a race to be tolerated, and without the
//! gate both would see "not loaded" and each build a recogniser, paying the
//! load and the memory twice for one that is immediately dropped. The gate IS
//! held across the load, and its waiters wait the full second: this is why a
//! load runs on a blocking thread and never on the async runtime.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

pub(crate) struct Resident<T> {
    slot: Mutex<Slot<T>>,
    load_gate: Mutex<()>,
}

struct Slot<T> {
    /// What is resident. The id travels WITH the handle rather than beside it:
    /// two mutexes holding two halves of one fact is an invitation for them to
    /// disagree, and the fact they would be disagreeing about is "what is doing
    /// the listening" — which is the question diagnostics exist to answer.
    cached: Option<(&'static str, Arc<T>)>,
    /// The model a load is building right now. At most one, because loads are
    /// serialised by the gate.
    loading: Option<&'static str>,
    /// Whether that model was evicted before its load finished.
    ///
    /// An eviction means the files the load is reading have just been replaced
    /// or removed. Caching the result would undo the eviction — the next take
    /// would run on the old weights, or on a model whose files are gone — so
    /// the result goes to the caller that asked for it and nowhere else.
    loading_evicted: bool,
}

impl<T> Resident<T> {
    pub(crate) fn new() -> Self {
        Self {
            slot: Mutex::new(Slot {
                cached: None,
                loading: None,
                loading_evicted: false,
            }),
            load_gate: Mutex::new(()),
        }
    }

    fn slot(&self) -> MutexGuard<'_, Slot<T>> {
        self.slot.lock().expect("stt model poisoned")
    }

    /// Which model is resident, if any. Never waits for a load in progress: a
    /// model that is still loading is not resident yet, and saying so is the
    /// truthful answer.
    pub(crate) fn loaded_id(&self) -> Option<&'static str> {
        self.slot().cached.as_ref().map(|(id, _)| *id)
    }

    /// The resident handle, if it is this model.
    fn cached(&self, id: &str) -> Option<Arc<T>> {
        cached_as(&self.slot(), id)
    }

    /// Forget this model if it is resident, or stop a load of it in progress
    /// from becoming resident.
    ///
    /// The handle is dropped after the lock is released. It may be the last
    /// reference to ~161 MB of graphs, and freeing them is not a pointer copy.
    pub(crate) fn evict(&self, id: &str) {
        let evicted = {
            let mut slot = self.slot();
            if slot.loading.is_some_and(|loading| loading == id) {
                slot.loading_evicted = true;
            }
            if slot
                .cached
                .as_ref()
                .is_some_and(|(cached, _)| *cached == id)
            {
                slot.cached.take()
            } else {
                None
            }
        };
        drop(evicted);
    }

    /// The resident handle for `id`, loading it first if it is not resident.
    ///
    /// Blocks for the length of a load, and for the length of anyone else's
    /// load already in progress — so never call this on an async worker.
    ///
    /// The load is split in two, because WHEN the previous model is dropped is
    /// one of the rules:
    ///
    /// - `prepare` runs while any previous model is still resident. A request
    ///   for a model this installation does not have should leave the one it
    ///   does have exactly where it was: evicting first would answer "you asked
    ///   for a model that isn't here" by also throwing the working one away,
    ///   and the next take would pay a cold load for nothing.
    /// - `load` runs after the cache has let go of it, so the cache never holds
    ///   two ~161 MB graph sets at once. A take already running keeps its own
    ///   `Arc` — and with it the old graphs, until the take ends — and finishes
    ///   on the model it started with.
    pub(crate) fn get_or_load<P, E>(
        &self,
        id: &'static str,
        prepare: impl FnOnce() -> Result<P, E>,
        load: impl FnOnce(P) -> Result<T, E>,
    ) -> Result<Arc<T>, E> {
        if let Some(hit) = self.cached(id) {
            return Ok(hit);
        }

        // Recovered rather than propagated. The gate guards no data, so a load
        // that panicked has left nothing inconsistent behind it, and refusing
        // every later load would turn one bad start into a recogniser that can
        // never be loaded again until the app restarts.
        let _gate = self
            .load_gate
            .lock()
            .unwrap_or_else(PoisonError::into_inner);

        {
            let mut slot = self.slot();
            // Checked again under the gate: the load this call queued behind
            // may have been for this very model.
            if let Some(hit) = cached_as(&slot, id) {
                return Ok(hit);
            }
            slot.loading = Some(id);
            slot.loading_evicted = false;
        }

        let prepared = match prepare() {
            Ok(prepared) => prepared,
            Err(err) => {
                self.slot().loading = None;
                return Err(err);
            }
        };

        // Taken out under the lock and dropped outside it, like `evict`.
        let previous = self.slot().cached.take();
        drop(previous);

        let loaded = load(prepared);
        let mut slot = self.slot();
        let evicted = std::mem::replace(&mut slot.loading_evicted, false);
        slot.loading = None;
        let loaded = Arc::new(loaded?);
        if !evicted {
            slot.cached = Some((id, Arc::clone(&loaded)));
        }
        Ok(loaded)
    }
}

fn cached_as<T>(slot: &Slot<T>, id: &str) -> Option<Arc<T>> {
    slot.cached
        .as_ref()
        .filter(|(cached, _)| *cached == id)
        .map(|(_, handle)| Arc::clone(handle))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;

    /// Long enough that only a deadlock reaches it, short enough that one fails
    /// the test instead of hanging the suite.
    const PATIENCE: Duration = Duration::from_secs(5);

    /// How long a test waits after starting a second request before letting the
    /// first one finish.
    ///
    /// Not synchronisation: no assertion depends on the second request arriving
    /// in time. It only makes it likely that the second is queued on the gate
    /// mid-load — the case worth testing — rather than arriving once the first
    /// has finished.
    const HEAD_START: Duration = Duration::from_millis(50);

    /// Run `work` on its own thread. The answer comes back over a channel
    /// rather than through `join`, so that a regression which deadlocks fails
    /// the test after `PATIENCE` instead of hanging it.
    fn spawn<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> mpsc::Receiver<T> {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(work());
        });
        rx
    }

    fn finish<T>(rx: &mpsc::Receiver<T>, what: &str) -> T {
        rx.recv_timeout(PATIENCE)
            .unwrap_or_else(|err| panic!("{what} did not finish: {err}"))
    }

    /// Run `query` on another thread and insist it answers while a load is
    /// still held open. On the old single mutex this is where it hung.
    fn answers_during_load<Q: Send + 'static>(query: impl FnOnce() -> Q + Send + 'static) -> Q {
        finish(&spawn(query), "the query, while a load was held open,")
    }

    /// The closure's half of a handshake that holds a load open in the middle:
    /// it says it has got there, then waits to be let go.
    struct Held {
        reached: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
    }

    impl Held {
        fn here(self) {
            self.reached.send(()).unwrap();
            self.release.recv_timeout(PATIENCE).expect("released");
        }
    }

    /// The test's half.
    struct Holder {
        reached: mpsc::Receiver<()>,
        release: mpsc::Sender<()>,
    }

    impl Holder {
        fn reached(&self) {
            self.reached
                .recv_timeout(PATIENCE)
                .expect("the load reached the point it is held at");
        }

        fn release(&self) {
            self.release.send(()).unwrap();
        }
    }

    fn hold() -> (Held, Holder) {
        let (reached_tx, reached) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        (
            Held {
                reached: reached_tx,
                release: release_rx,
            },
            Holder { reached, release },
        )
    }

    type Loaded = Result<Arc<String>, String>;

    fn ready(resident: &Resident<String>, id: &'static str) -> Arc<String> {
        resident
            .get_or_load(id, || Ok::<_, String>(()), |()| Ok(id.to_string()))
            .expect("load")
    }

    /// A load of `id`, started on another thread and held open while it builds.
    fn held_load(
        resident: &Arc<Resident<String>>,
        id: &'static str,
        builds: &Arc<AtomicUsize>,
    ) -> (Holder, mpsc::Receiver<Loaded>) {
        let (held, holder) = hold();
        let resident = Arc::clone(resident);
        let builds = Arc::clone(builds);
        let done = spawn(move || {
            resident.get_or_load(
                id,
                || Ok(()),
                move |()| {
                    builds.fetch_add(1, Ordering::SeqCst);
                    held.here();
                    Ok(id.to_string())
                },
            )
        });
        holder.reached();
        (holder, done)
    }

    fn no_builds() -> Arc<AtomicUsize> {
        Arc::new(AtomicUsize::new(0))
    }

    #[test]
    fn a_resident_model_is_handed_back_without_loading_again() {
        let resident = Resident::new();
        let first = ready(&resident, "a");
        let again = resident
            .get_or_load(
                "a",
                || -> Result<(), String> { panic!("prepared twice") },
                |()| panic!("loaded twice"),
            )
            .unwrap();
        assert!(Arc::ptr_eq(&first, &again));
        assert_eq!(resident.loaded_id(), Some("a"));
    }

    #[test]
    fn what_is_resident_is_answered_while_a_load_is_running() {
        let resident = Arc::new(Resident::new());
        ready(&resident, "a");
        // A held load is past `prepare`, so "a" has already been dropped: for
        // the length of the load nothing is resident, and the answer has to
        // say so now rather than "b" a second later.
        let (holder, done) = held_load(&resident, "b", &no_builds());

        let probe = Arc::clone(&resident);
        assert_eq!(answers_during_load(move || probe.loaded_id()), None);

        holder.release();
        finish(&done, "the load").unwrap();
        assert_eq!(resident.loaded_id(), Some("b"));
    }

    #[test]
    fn eviction_does_not_wait_for_a_load_in_progress() {
        let resident = Arc::new(Resident::new());
        let (holder, done) = held_load(&resident, "a", &no_builds());

        let probe = Arc::clone(&resident);
        answers_during_load(move || probe.evict("a"));

        holder.release();
        finish(&done, "the load").unwrap();
    }

    /// Preload and the start of a take, arriving together: one build, and both
    /// callers listening through the same recogniser.
    #[test]
    fn concurrent_requests_for_one_model_build_it_once() {
        let resident = Arc::new(Resident::new());
        let builds = no_builds();
        let (holder, first) = held_load(&resident, "a", &builds);

        let queued = {
            let resident = Arc::clone(&resident);
            let builds = Arc::clone(&builds);
            spawn(move || {
                resident.get_or_load(
                    "a",
                    || Ok::<_, String>(()),
                    move |()| {
                        builds.fetch_add(1, Ordering::SeqCst);
                        Ok("a".to_string())
                    },
                )
            })
        };
        std::thread::sleep(HEAD_START);
        holder.release();

        let first = finish(&first, "the first request").unwrap();
        let queued = finish(&queued, "the queued request").unwrap();
        assert!(Arc::ptr_eq(&first, &queued));
        assert_eq!(builds.load(Ordering::SeqCst), 1);
    }

    /// Two different models still load one at a time: the gate is about
    /// memory and the C library, not about which model is asked for.
    #[test]
    fn loads_of_different_models_never_overlap() {
        let resident = Arc::new(Resident::new());
        let first_finished = Arc::new(AtomicBool::new(false));
        let (held, holder) = hold();
        let first = {
            let resident = Arc::clone(&resident);
            let first_finished = Arc::clone(&first_finished);
            spawn(move || {
                resident.get_or_load(
                    "a",
                    || Ok::<_, String>(()),
                    move |()| {
                        held.here();
                        first_finished.store(true, Ordering::SeqCst);
                        Ok("a".to_string())
                    },
                )
            })
        };
        holder.reached();

        let second = {
            let resident = Arc::clone(&resident);
            let first_finished = Arc::clone(&first_finished);
            spawn(move || {
                resident.get_or_load(
                    "b",
                    || Ok::<_, String>(()),
                    move |()| {
                        Ok(format!(
                            "b, built after a: {}",
                            first_finished.load(Ordering::SeqCst)
                        ))
                    },
                )
            })
        };
        std::thread::sleep(HEAD_START);
        // Had "b" not waited, it would be resident by now.
        assert_eq!(resident.loaded_id(), None);
        holder.release();

        finish(&first, "the first load").unwrap();
        assert_eq!(
            *finish(&second, "the second load").unwrap(),
            "b, built after a: true"
        );
        assert_eq!(resident.loaded_id(), Some("b"));
    }

    /// Installed or deleted while it loaded: the files it read are not the
    /// files on disk any more, so it must not become what the next take uses.
    #[test]
    fn a_model_evicted_mid_load_is_not_left_resident() {
        let resident = Arc::new(Resident::new());
        let (holder, done) = held_load(&resident, "a", &no_builds());

        resident.evict("a");
        holder.release();

        // The caller that asked still gets what it asked for — a take arming on
        // it finishes on the weights it started with — but nothing is cached.
        let handed_back = finish(&done, "the load").unwrap();
        assert_eq!(*handed_back, "a");
        assert_eq!(resident.loaded_id(), None);

        // And the next request loads afresh rather than finding a stale copy.
        let fresh = ready(&resident, "a");
        assert!(!Arc::ptr_eq(&handed_back, &fresh));
    }

    /// The same, earlier: evicted while its directory was being resolved and
    /// checked. The files `prepare` found are the ones being replaced.
    #[test]
    fn a_model_evicted_while_it_is_prepared_is_not_left_resident() {
        let resident = Arc::new(Resident::new());
        ready(&resident, "a");
        let (held, holder) = hold();
        let done = {
            let resident = Arc::clone(&resident);
            spawn(move || {
                resident.get_or_load(
                    "b",
                    move || {
                        held.here();
                        Ok::<_, String>(())
                    },
                    |()| Ok("b".to_string()),
                )
            })
        };
        holder.reached();

        // Still resident: nothing is dropped until `prepare` has passed.
        let probe = Arc::clone(&resident);
        assert_eq!(answers_during_load(move || probe.loaded_id()), Some("a"));

        resident.evict("b");
        holder.release();
        assert_eq!(*finish(&done, "the load").unwrap(), "b");
        assert_eq!(resident.loaded_id(), None);
    }

    #[test]
    fn evicting_a_different_model_leaves_a_load_in_progress_alone() {
        let resident = Arc::new(Resident::new());
        let (holder, done) = held_load(&resident, "a", &no_builds());

        resident.evict("b");
        holder.release();
        finish(&done, "the load").unwrap();
        assert_eq!(resident.loaded_id(), Some("a"));
    }

    #[test]
    fn evicting_a_different_model_leaves_the_resident_one_alone() {
        let resident = Resident::new();
        let working = ready(&resident, "a");
        resident.evict("b");
        assert_eq!(resident.loaded_id(), Some("a"));
        assert!(Arc::ptr_eq(&working, &ready(&resident, "a")));
    }

    #[test]
    fn an_eviction_before_a_load_does_not_reach_the_next_one() {
        let resident = Resident::new();
        resident.evict("a");
        ready(&resident, "a");
        assert_eq!(resident.loaded_id(), Some("a"));
    }

    #[test]
    fn a_model_that_cannot_be_prepared_leaves_the_resident_one_in_place() {
        let resident = Resident::new();
        let working = ready(&resident, "a");
        let refused = resident.get_or_load(
            "b",
            || Err::<(), _>("not installed".to_string()),
            |()| panic!("loaded a model that failed to prepare"),
        );
        assert_eq!(refused.unwrap_err(), "not installed");
        assert_eq!(resident.loaded_id(), Some("a"));
        assert!(Arc::ptr_eq(&working, &ready(&resident, "a")));
    }

    /// Documents the trade `get_or_load` makes rather than defending it: the
    /// previous model is gone before the replacement is attempted, so a load
    /// that fails leaves nothing resident.
    #[test]
    fn a_load_that_fails_leaves_nothing_resident() {
        let resident = Resident::new();
        ready(&resident, "a");
        let failed =
            resident.get_or_load("b", || Ok(()), |()| Err::<String, _>("corrupt".to_string()));
        assert_eq!(failed.unwrap_err(), "corrupt");
        assert_eq!(resident.loaded_id(), None);
        // And it has not wedged the gate behind it.
        assert_eq!(*ready(&resident, "b"), "b");
    }

    /// Stands in for freeing ~161 MB of graphs: a destructor that says it has
    /// started and then waits to be released.
    ///
    /// The receiver is behind a mutex only because a resident value has to be
    /// `Sync`, as the real recogniser is, and a bare `Receiver` is not.
    struct SlowDrop {
        dropping: mpsc::Sender<()>,
        release: Mutex<mpsc::Receiver<()>>,
    }

    impl Drop for SlowDrop {
        fn drop(&mut self) {
            let _ = self.dropping.send(());
            if let Ok(release) = self.release.get_mut() {
                let _ = release.recv_timeout(PATIENCE);
            }
        }
    }

    /// Make "a" resident as a `SlowDrop`, run `action` on another thread, and
    /// insist the slot answers while `action` is inside the destructor.
    fn frees_outside_the_lock(action: impl FnOnce(&Resident<SlowDrop>) + Send + 'static) {
        let resident = Arc::new(Resident::new());
        let (dropping_tx, dropping) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        resident
            .get_or_load(
                "a",
                || Ok::<_, String>(()),
                |()| {
                    Ok(SlowDrop {
                        dropping: dropping_tx,
                        release: Mutex::new(release_rx),
                    })
                },
            )
            .unwrap();

        let acting = {
            let resident = Arc::clone(&resident);
            spawn(move || action(&resident))
        };
        dropping
            .recv_timeout(PATIENCE)
            .expect("the model was freed");

        let probe = Arc::clone(&resident);
        assert_eq!(answers_during_load(move || probe.loaded_id()), None);

        release.send(()).unwrap();
        finish(&acting, "the action");
    }

    #[test]
    fn freeing_an_evicted_model_does_not_hold_the_slot() {
        frees_outside_the_lock(|resident| resident.evict("a"));
    }

    #[test]
    fn freeing_a_replaced_model_does_not_hold_the_slot() {
        frees_outside_the_lock(|resident| {
            // The far end of both channels is already gone, so when this
            // replacement is freed in turn its destructor returns at once.
            let (dropping, _) = mpsc::channel();
            let (_, release) = mpsc::channel();
            resident
                .get_or_load(
                    "b",
                    || Ok::<_, String>(()),
                    |()| {
                        Ok(SlowDrop {
                            dropping,
                            release: Mutex::new(release),
                        })
                    },
                )
                .unwrap();
        });
    }

    /// Unwinding out of the load poisons the gate — its guard drops during the
    /// panic — so this is the recovery path, not a gate that was never touched.
    #[test]
    fn a_load_that_panics_does_not_lock_out_the_next_one() {
        let resident = Resident::new();
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            resident.get_or_load(
                "a",
                || Ok::<_, String>(()),
                |()| -> Result<String, String> { panic!("the C library fell over") },
            )
        }));
        assert!(panicked.is_err());
        assert!(resident.load_gate.is_poisoned());
        assert_eq!(*ready(&resident, "a"), "a");
    }
}
