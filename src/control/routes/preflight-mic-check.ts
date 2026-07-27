/**
 * Lifecycle of the on-stage microphone check (spec §29.2, between steps 3 and 4).
 *
 * The decision this makes is in `services/audio/mic-check.ts` and is pure. What
 * lives here is the part that owns things: a capture stream, a publish timer,
 * an event subscription, and a promise the start sequence is blocked on. Every
 * one of those has to be released on every path out — including the ones where
 * the presenter cancels, the stage dies, nobody ever speaks, or a dependency
 * throws in the middle of the teardown that was supposed to clean up after it.
 *
 * ---------------------------------------------------------------------------
 * THE HAZARD THIS FILE IS SHAPED AROUND
 * ---------------------------------------------------------------------------
 * `services/audio/ownership.ts` documents it with a measurement: a take whose
 * microphone test was still open took **9.8 seconds** to acquire the device and
 * then failed with "Voice tracking is unavailable", where a second attempt with
 * nothing else holding it took 908 ms. A microphone check that runs immediately
 * before the take is therefore the single most dangerous holder of a capture in
 * this codebase — get the teardown wrong and the feature CAUSES the bug it was
 * written to prevent.
 *
 * So the contract is absolute: **`runStageMicCheck` does not settle until its
 * capture has actually been released.** Note "actually". The release is
 * `await`ed, because `getUserMedia` may still be in flight when the presenter
 * cancels or overrides: a disposer that merely flags the acquisition as
 * unwanted has released nothing yet, and returning at that point hands the take
 * a device with an outstanding claim on it. Awaiting the release is the whole
 * difference between this check preventing the bug and reproducing it.
 *
 * ---------------------------------------------------------------------------
 * SETTLEMENT IS UNCONDITIONAL
 * ---------------------------------------------------------------------------
 * Every teardown step is individually guarded and the promise is settled from a
 * `finally`. The start sequence is blocked on this promise behind a full-screen
 * always-on-top window: a throw that escaped teardown would leave the presenter
 * staring at a stage that never goes away, with no key that dismisses it. A
 * failure to clean up must never become a failure to finish.
 */
import type {
  AudioLevelSnapshot,
  StageMicCheckPayload,
} from '../../shared/contracts';
import {
  INITIAL_MIC_CHECK_STATE,
  micCheckCanOverride,
  micCheckView,
  reduceMicCheck,
  type MicCheckState,
} from '../services/audio/mic-check';

/** How often the stage is told what the check thinks. ~Level-frame cadence. */
export const MIC_CHECK_PUBLISH_INTERVAL_MS = 100;

/**
 * How long the passed state is left on screen before the take opens.
 *
 * Without it the overlay is replaced in the same frame it turns green, so the
 * presenter never sees the one piece of information they asked for — that the
 * microphone works. It is also the seam where the capture is released, so the
 * device is genuinely free before the transport asks for it.
 */
export const MIC_CHECK_SETTLE_MS = 700;

/**
 * Absolute ceiling on the check.
 *
 * Not about money — nothing billable is open — but about the microphone and the
 * full-screen window. Five minutes of an open capture on a stage nobody is
 * speaking to means the presenter walked away, and leaving the device held and
 * the display commandeered indefinitely is not a state this app should be able
 * to reach on its own.
 */
export const MIC_CHECK_MAX_DURATION_MS = 300_000;

/**
 * How long to wait for the capture to confirm it has been released.
 *
 * Long enough to cover a normal acquisition finishing and letting go (~900 ms
 * measured), short enough that the pathological case — a `getUserMedia` that
 * never returns — costs a couple of seconds rather than the whole session.
 */
export const MIC_CHECK_RELEASE_TIMEOUT_MS = 2500;

/**
 * Why the check ended.
 *
 * `passed`     — heard a usable voice;
 * `overridden` — the presenter chose to start anyway;
 * `cancelled`  — Escape, or the caller aborted (the stage died); the take must
 *                not start, and the presenter already knows why;
 * `timed_out`  — the ceiling above. Distinct from `cancelled` because nobody
 *                chose it: reporting "the presenter said no" for a walk-away
 *                leaves an abandoned start with no explanation anywhere.
 */
export type MicCheckOutcome = 'passed' | 'overridden' | 'cancelled' | 'timed_out';

export type Unsubscribe = () => void;

/**
 * Release the capture. MAY be asynchronous, and is always awaited.
 *
 * See the header: a synchronous disposer over an asynchronous acquisition is
 * exactly the shape that reintroduces device contention.
 */
export type MicCheckRelease = () => void | Promise<void>;

export interface MicCheckTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface StageMicCheckDeps {
  /** The stage lifetime this check belongs to; stamped on every frame. */
  stageGeneration: number;
  /** Opens the capture and streams level frames. Its disposer is awaited. */
  observeLevels(cb: (snapshot: AudioLevelSnapshot) => void): MicCheckRelease;
  /**
   * Direct control → stage emit (`emitTo('stage', …)`).
   *
   * May return a promise, and the FIRST call's promise is awaited — see
   * `publishNow`. Returning nothing keeps every call best-effort, which is
   * correct for a caller that has no way to detect delivery.
   */
  publish(payload: StageMicCheckPayload): void | Promise<void>;
  /** Subscribes to the presenter's answer coming back off the stage. */
  subscribeIntent(cb: (intent: 'start' | 'cancel') => void): Promise<Unsubscribe>;
  /**
   * MONOTONIC clock, and it has to be the same one the level frames carry.
   *
   * `AudioLevelSnapshot.generatedAtMs` is stamped by `MicrophoneMonitor` from
   * `performance.now()`, and every hold window the decision rests on — the peak
   * hold, the clip latch, the no-signal timeout — is measured against it. An
   * epoch clock here would be ~1.8e12 against frame stamps of ~1e4, so
   * `nowMs - state.signalAtMs` clears any timeout on the first comparison: the
   * check would announce "CandidCue cannot hear that microphone" in the gap
   * between two words. Wall-clock time is used only for `sentAtMs`, which is
   * wire metadata and part of no decision.
   */
  now?(): number;
  timers?: MicCheckTimers;
  /**
   * Lets the caller end the check from outside — the stage window was
   * destroyed, the operator navigated away. Without it the only exits are the
   * presenter's keyboard and the five-minute ceiling, so a stage that dies
   * mid-check leaves the capture running until one of those happens.
   */
  onAbort?(abort: (reason: MicCheckOutcome) => void): void;
}

const defaultTimers: MicCheckTimers = {
  setInterval: (cb, ms) => setInterval(cb, ms),
  clearInterval: (handle) => clearInterval(handle as Parameters<typeof clearInterval>[0]),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
};

/**
 * Run the check to a decision, releasing the microphone before settling.
 *
 * Resolves rather than rejects for every ANSWER — "the presenter said no" is an
 * answer, not a fault, and the start sequence distinguishes them by value. It
 * rejects only when the check could not be set up at all, and then only after
 * its teardown has run.
 */
export async function runStageMicCheck(deps: StageMicCheckDeps): Promise<MicCheckOutcome> {
  const now = deps.now ?? (() => performance.now());
  const timers = deps.timers ?? defaultTimers;
  const startedAtMs = now();

  let state: MicCheckState = INITIAL_MIC_CHECK_STATE;
  let latest: AudioLevelSnapshot | null = null;
  let settled = false;

  let release: MicCheckRelease | null = null;
  let stopIntents: Unsubscribe | null = null;
  let publishTimer: unknown = null;
  let settleTimer: unknown = null;
  let capTimer: unknown = null;

  let resolveOutcome!: (outcome: MicCheckOutcome) => void;
  const outcomePromise = new Promise<MicCheckOutcome>((resolve) => {
    resolveOutcome = resolve;
  });

  const clearTimer = (handle: unknown, kind: 'interval' | 'timeout'): void => {
    if (handle === null) return;
    try {
      if (kind === 'interval') timers.clearInterval(handle);
      else timers.clearTimeout(handle);
    } catch {
      // A clock that cannot cancel a timer must not stop the rest of teardown.
    }
  };

  const buildPayload = (active: boolean, outcome?: MicCheckOutcome): StageMicCheckPayload => {
    const view = micCheckView(state, latest, now(), startedAtMs);
    return {
      stageGeneration: deps.stageGeneration,
      active,
      /*
       * A finished check reports what it CONCLUDED, not what the last frame
       * looked like. `passed`/`overridden` end the overlay on the result the
       * presenter was waiting for; a cancel or a timeout leaves the fault
       * showing, because claiming a pass there would be a lie.
       */
      state:
        outcome === 'passed' || outcome === 'overridden' ? 'passed' : view.state,
      levels: view.levels,
      headline: view.headline,
      detail: view.detail,
      canOverride: view.canOverride,
      sentAtMs: Date.now(),
    };
  };

  /**
   * Emit one live frame.
   *
   * The FIRST one is critical and the rest are not, and the asymmetry is the
   * point. Losing an intermediate frame costs one bar of the waveform. Losing
   * the first one costs everything: the stage is already full screen and has
   * received nothing, so it draws no overlay — and because it only intercepts
   * the keyboard while a check is on screen, Escape falls through to the
   * end-take handler that control has not subscribed to yet. The presenter
   * gets a black full-screen window, no explanation, and no key that dismisses
   * it, until the five-minute ceiling. That is a failed start, and it should
   * be reported as one.
   */
  const publishNow = (): void => {
    try {
      void Promise.resolve(deps.publish(buildPayload(true))).catch(() => {});
    } catch {
      // Best-effort, and it must never escape a timer callback as an unhandled
      // rejection.
    }
  };

  /**
   * The first paint, awaited so a delivery failure is a failure.
   *
   * `emitTo` reports failure by REJECTING, not by throwing, so a version of
   * this that only guarded against a synchronous throw would let the real
   * production failure straight through.
   */
  const publishFirst = async (): Promise<void> => {
    await deps.publish(buildPayload(true));
  };

  /**
   * Tear everything down, then settle. Each step is isolated so one failure
   * cannot skip the others, and the settle is in `finally` so no failure at
   * all can leave the start sequence hanging behind a full-screen stage.
   */
  const teardown = async (outcome: MicCheckOutcome): Promise<void> => {
    try {
      clearTimer(publishTimer, 'interval');
      clearTimer(settleTimer, 'timeout');
      clearTimer(capTimer, 'timeout');
      publishTimer = null;
      settleTimer = null;
      capTimer = null;

      /*
       * The microphone first, and awaited — see the header. Everything below
       * is cosmetic by comparison; this is the step the next `getUserMedia`
       * depends on.
       */
      const disposer = release;
      release = null;
      if (disposer) {
        try {
          /*
           * Bounded, because the thing being awaited is `getUserMedia` and its
           * documented pathological failure is that it never returns at all
           * (`services/audio/ownership.ts`). An unbounded await here would turn
           * that hang into a check that never settles — the start sequence
           * blocked forever behind a full-screen always-on-top window, which is
           * strictly worse than starting a take with a contended device.
           *
           * So: wait properly, but give up waiting. The abandoned acquisition
           * still releases itself when it eventually resolves, because the
           * disposer has already told it to.
           */
          await Promise.race([
            Promise.resolve(disposer()),
            new Promise<void>((resolve) => {
              timers.setTimeout(resolve, MIC_CHECK_RELEASE_TIMEOUT_MS);
            }),
          ]);
        } catch {
          // Failing to hang up cleanly must not stop the take from starting,
          // which is the one thing the presenter is waiting for.
        }
      }

      try {
        stopIntents?.();
      } catch {
        // As above.
      }
      stopIntents = null;

      /*
       * Tear the overlay down from control rather than letting the stage decide
       * it is finished. The stage holds no check state, so a missed final frame
       * would leave the panel up over a live script — much worse than a missed
       * frame in the middle. The stage carries its own backstop for the case
       * where this emit is lost entirely.
       */
      try {
        deps.publish(buildPayload(false, outcome));
      } catch {
        // Best-effort by necessity: there is nothing useful to do about a
        // failed dismissal here, and the take must still be allowed to start.
      }
    } finally {
      resolveOutcome(outcome);
    }
  };

  /** The single exit. Idempotent — three things can reach it in one tick. */
  const finish = (outcome: MicCheckOutcome): void => {
    if (settled) return;
    settled = true;
    void teardown(outcome);
  };

  /*
   * A pass does not end the check immediately — it schedules the end, so the
   * presenter reads "your microphone is working" instead of seeing the overlay
   * vanish in the frame it succeeded.
   */
  const passWhenReady = (): void => {
    if (settled || settleTimer !== null) return;
    /*
     * Disarm the ceiling. A pass landing inside the last 700 ms would otherwise
     * be overtaken by the cap timer and reported as a timeout — the check
     * telling the presenter their microphone works and then refusing to start.
     */
    clearTimer(capTimer, 'timeout');
    capTimer = null;
    settleTimer = timers.setTimeout(() => finish('passed'), MIC_CHECK_SETTLE_MS);
  };

  try {
    release = deps.observeLevels((snapshot) => {
      if (settled) return;
      latest = snapshot;
      /*
       * The frame's own clock, not the wall clock: `generatedAtMs` is what the
       * peak-hold and clip-latch windows in mic-advice are measured against,
       * and mixing the two would make those windows drift under load.
       */
      state = reduceMicCheck(state, snapshot, snapshot.generatedAtMs);
      if (state.passed) passWhenReady();
    });

    publishTimer = timers.setInterval(() => {
      if (settled) return;
      publishNow();
    }, MIC_CHECK_PUBLISH_INTERVAL_MS);

    capTimer = timers.setTimeout(() => finish('timed_out'), MIC_CHECK_MAX_DURATION_MS);

    deps.onAbort?.((reason) => finish(reason));

    /*
     * The keyboard path is opened BEFORE the overlay is painted, and the order
     * is deliberate: the paint is what makes the check interactive, so a
     * subscription started afterwards leaves a window in which the presenter
     * can see "press Escape to cancel" and press it into nothing.
     */
    void deps
      .subscribeIntent((intent) => {
        if (settled) return;
        if (intent === 'cancel') {
          finish('cancelled');
          return;
        }
        /*
         * Control decides whether a `start` is allowed, not the stage.
         *
         * The stage only offers the key once the override is available, but
         * a webview `emit` is a broadcast and the stage's copy of "available"
         * is whatever frame it last received — neither is a safeguard. If the
         * gate lived only on the stage, a stale or replayed intent would skip
         * a check that had run for a fraction of a second, which is precisely
         * the "press the thing to make the screen go away" failure the delay
         * exists to prevent. So the deadline is re-derived here, from the
         * clock this side owns.
         */
        if (state.passed) {
          finish('passed');
          return;
        }
        if (micCheckCanOverride(now() - startedAtMs)) {
          finish('overridden');
        }
        // Too early: ignored, deliberately silently. The overlay is already
        // telling the presenter what it needs from them.
      })
      .then((unsubscribe) => {
        // The check can be over before this resolves; a subscription that
        // arrives late must dispose itself rather than leak.
        if (settled) {
          unsubscribe();
          return;
        }
        stopIntents = unsubscribe;
      })
      .catch(() => {
        /*
         * No keyboard path to the check. Deliberately not fatal: the check
         * still runs, still shows the waveform, and still passes on its own
         * when it hears a voice — losing the override is much better than
         * refusing to start a take because an event subscription failed. The
         * ceiling is what bounds the case where the microphone is also dead.
         */
      });

    /*
     * Paint. The stage is already full screen at this point; a gap here is a
     * black screen with no explanation, which is the exact experience being
     * fixed — so this is the one delivery whose failure ends the start.
     */
    await publishFirst();
  } catch (error) {
    /*
     * Setup itself failed — the capture could not be opened, or a timer could
     * not be scheduled. Tear down whatever did get created before letting the
     * caller see it: a rejection that leaked a live capture would hand the
     * take a contended device on top of an already-failing start.
     */
    if (!settled) {
      settled = true;
      await teardown('cancelled');
    }
    throw error;
  }

  return outcomePromise;
}
