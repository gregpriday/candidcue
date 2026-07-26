/**
 * The stage's periodic motion report, as control receives it (companion §54).
 *
 * Deliberately NOT a feedback loop into following: the stage tells control how
 * its own plant is doing — frame drops, tracking error, controller state — and
 * control shows it in diagnostics. Nothing here reaches back into where the
 * presenter is believed to be. That direction is one-way by design, because a
 * display that could influence the position estimate would be able to confirm
 * its own mistakes.
 */
import type { StageMotionAck } from '../../shared/contracts';
import { STAGE_EVENT } from '../../shared/contracts';
import { isTauriRuntime } from './ipc';

/** The stage's periodic motion report (companion §54), owned by contracts. */
export const STAGE_MOTION_ACK_EVENT = STAGE_EVENT.motionAck;

/**
 * Monotonic wall clock. `Date.now()` is subject to NTP steps and manual clock
 * changes; a backward step inflates every subsequent age measurement and a
 * forward one hides real staleness.
 */
export function monotonicNowMs(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

/**
 * Listen for stage motion acks. Returns an unsubscribe function; a no-op
 * outside the Tauri runtime so browser dev and unit tests are unaffected.
 */
export function subscribeStageMotionAcks(handler: (ack: StageMotionAck) => void): () => void {
  if (!isTauriRuntime()) return () => {};
  let unlisten: (() => void) | null = null;
  let cancelled = false;
  void (async () => {
    const { listen } = await import('@tauri-apps/api/event');
    const stop = await listen<StageMotionAck>(STAGE_MOTION_ACK_EVENT, (event) => {
      handler(event.payload);
    });
    if (cancelled) stop();
    else unlisten = stop;
  })().catch(() => {
    // The stage has not started emitting acks yet — diagnostics simply stay
    // empty; following is unaffected.
  });
  return () => {
    cancelled = true;
    unlisten?.();
    unlisten = null;
  };
}
