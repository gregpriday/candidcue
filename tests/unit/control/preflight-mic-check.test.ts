/**
 * §29.2 — the on-stage microphone check.
 *
 * The load-bearing assertion in this file is THE CAPTURE WAS RELEASED BEFORE
 * THE PROMISE SETTLED, and it is proved for every way the check can end, with
 * an ordering recorder attached BEFORE completion is triggered. Asserting it
 * afterwards proves nothing: an implementation that resolved first and released
 * in a microtask would satisfy a late `await`, while in production
 * `startSession` is already awaiting and resumes first.
 *
 * That is not defensive tidiness. `services/audio/ownership.ts` records the
 * measurement: a take whose microphone test was still open took 9.8 seconds to
 * acquire the device and then failed with "Voice tracking is unavailable",
 * where a second attempt with nothing holding it took 908 ms. This check runs
 * immediately before the take opens its own stream, which makes it the single
 * most dangerous holder of a capture in the codebase — get the teardown wrong
 * and the feature CAUSES the bug it was written to prevent.
 *
 * The subtlest version of that: `getUserMedia` is asynchronous, so the capture
 * can be PENDING rather than open when the presenter cancels. A disposer that
 * returns before the acquisition settles has released nothing. `deferred: true`
 * below models exactly that.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MIC_CHECK_MAX_DURATION_MS,
  MIC_CHECK_SETTLE_MS,
  runStageMicCheck,
  type MicCheckOutcome,
} from '../../../src/control/routes/preflight-mic-check';
import { MIC_CHECK_OVERRIDE_AFTER_MS } from '../../../src/control/services/audio/mic-check';
import type { AudioLevelSnapshot, StageMicCheckPayload } from '../../../src/shared/contracts';

const FRAME_MS = 90;

function frame(atMs: number, overrides: Partial<AudioLevelSnapshot> = {}): AudioLevelSnapshot {
  return {
    rms: 0.28,
    peak: 0.45,
    noiseFloor: 0.02,
    speaking: true,
    clipped: false,
    signalPresent: true,
    generatedAtMs: atMs,
    ...overrides,
  };
}

interface HarnessOptions {
  intentFails?: boolean;
  /**
   * Fail a publish.
   *
   * `first-rejects` is the PRODUCTION shape: `emitTo` reports failure by
   * returning a rejected promise, not by throwing, so a guard that only caught
   * synchronous throws would miss the case that actually happens.
   */
  publishThrowsAt?: 'first' | 'first-rejects' | 'periodic' | 'last';
  /** Model a disposer that only completes later — an in-flight acquisition. */
  deferred?: boolean;
  /** Expose an abort hook, as the stage-closed watcher does. */
  abortable?: boolean;
}

interface Harness {
  outcome: Promise<MicCheckOutcome>;
  release: ReturnType<typeof vi.fn>;
  published: StageMicCheckPayload[];
  unsubscribeIntent: ReturnType<typeof vi.fn>;
  /** Ordered log of teardown vs settlement, for the ordering assertions. */
  events: string[];
  /**
   * Move time forward for the timers AND the check's own clock together.
   *
   * They have to advance as one. The check reasons on a monotonic clock that
   * must match the `generatedAtMs` its level frames carry, so a harness that
   * advanced only the fake timers would be testing a version of the code where
   * the two had drifted apart.
   */
  advance(ms: number): void;
  emitLevel(overrides?: Partial<AudioLevelSnapshot>): void;
  answer(intent: 'start' | 'cancel'): void;
  abort(): void;
  /** Let the deferred release complete. */
  settleRelease(): void;
  last(): StageMicCheckPayload;
}

function harness(options: HarnessOptions = {}): Harness {
  const events: string[] = [];
  const unsubscribeIntent = vi.fn(() => {
    events.push('unsubscribe-intent');
  });
  const published: StageMicCheckPayload[] = [];
  let onLevel: ((level: AudioLevelSnapshot) => void) | null = null;
  let onIntent: ((intent: 'start' | 'cancel') => void) | null = null;
  let abortFn: ((reason: MicCheckOutcome) => void) | null = null;
  let releaseDeferred: (() => void) | null = null;
  // Starts well above zero so a bug that mistakes "no frame yet" for "a frame
  // at time 0" cannot pass by coincidence.
  let clock = 5000;
  let publishes = 0;

  const release = vi.fn(() => {
    if (!options.deferred) {
      events.push('release');
      return undefined;
    }
    return new Promise<void>((resolve) => {
      releaseDeferred = () => {
        events.push('release');
        resolve();
      };
    });
  });

  const outcome = runStageMicCheck({
    stageGeneration: 7,
    observeLevels: (cb) => {
      onLevel = cb;
      return release;
    },
    publish: (payload) => {
      publishes += 1;
      if (options.publishThrowsAt === 'first' && publishes === 1) {
        throw new Error('emit failed');
      }
      if (options.publishThrowsAt === 'first-rejects' && publishes === 1) {
        return Promise.reject(new Error('emit failed'));
      }
      if (options.publishThrowsAt === 'periodic' && publishes > 1 && payload.active) {
        throw new Error('emit failed');
      }
      if (options.publishThrowsAt === 'last' && !payload.active) {
        throw new Error('emit failed');
      }
      published.push(payload);
    },
    subscribeIntent: async (cb) => {
      if (options.intentFails === true) throw new Error('no event bus');
      onIntent = cb;
      return unsubscribeIntent;
    },
    now: () => clock,
    ...(options.abortable === true
      ? {
          onAbort: (abort: (reason: MicCheckOutcome) => void) => {
            abortFn = abort;
          },
        }
      : {}),
  });

  void outcome.then(
    () => events.push('settled'),
    () => events.push('rejected'),
  );

  return {
    outcome,
    release,
    published,
    unsubscribeIntent,
    events,
    advance: (ms) => {
      clock += ms;
      vi.advanceTimersByTime(ms);
    },
    emitLevel: (overrides = {}) => onLevel?.(frame(clock, overrides)),
    answer: (intent) => onIntent?.(intent),
    abort: () => abortFn?.('cancelled'),
    settleRelease: () => releaseDeferred?.(),
    last: () => {
      const payload = published.at(-1);
      if (!payload) throw new Error('nothing was published to the stage');
      return payload;
    },
  };
}

/** Speak for long enough to pass, at the analysis cadence. */
function speakUntilPassed(h: Harness, frames = 20): void {
  for (let i = 0; i < frames; i += 1) {
    h.emitLevel();
    h.advance(FRAME_MS);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the stage is drawn on immediately', () => {
  it('publishes before any level frame can have arrived', async () => {
    /*
     * The stage is already full screen when this starts. A gap between the
     * window appearing and the check appearing is a black screen with no
     * explanation — which is the experience being fixed, not a smaller version
     * of it.
     */
    const h = harness();
    expect(h.published.length).toBeGreaterThan(0);
    expect(h.last().active).toBe(true);
    expect(h.last().state).toBe('waiting');

    h.answer('cancel');
    await h.outcome;
  });

  it('stamps every frame with the stage generation it belongs to', async () => {
    const h = harness();
    speakUntilPassed(h);
    h.advance(MIC_CHECK_SETTLE_MS);
    await h.outcome;
    expect(h.published.every((p) => p.stageGeneration === 7)).toBe(true);
  });

  it('keeps publishing while nothing is heard, so the check stays alive on screen', async () => {
    const h = harness();
    const before = h.published.length;
    h.advance(1000);
    expect(h.published.length).toBeGreaterThan(before);

    h.answer('cancel');
    await h.outcome;
  });

  it('offers the override only after the presenter has had time to try', async () => {
    const h = harness();
    expect(h.last().canOverride).toBe(false);
    h.advance(MIC_CHECK_OVERRIDE_AFTER_MS);
    expect(h.last().canOverride).toBe(true);

    h.answer('cancel');
    await h.outcome;
  });
});

describe('releasing the microphone', () => {
  it('releases before settling on a pass', async () => {
    const h = harness();
    speakUntilPassed(h);
    h.advance(MIC_CHECK_SETTLE_MS);
    await h.outcome;
    expect(h.events).toEqual(['release', 'unsubscribe-intent', 'settled']);
  });

  it('releases before settling on a cancel', async () => {
    const h = harness();
    h.answer('cancel');
    await h.outcome;
    expect(h.events.indexOf('release')).toBeLessThan(h.events.indexOf('settled'));
  });

  it('releases before settling on an override', async () => {
    const h = harness();
    h.advance(MIC_CHECK_OVERRIDE_AFTER_MS);
    h.answer('start');
    await h.outcome;
    expect(h.events.indexOf('release')).toBeLessThan(h.events.indexOf('settled'));
  });

  it('releases before settling on the ceiling', async () => {
    const h = harness();
    h.advance(MIC_CHECK_MAX_DURATION_MS);
    await h.outcome;
    expect(h.events.indexOf('release')).toBeLessThan(h.events.indexOf('settled'));
  });

  it('WAITS for an acquisition that is still in flight', async () => {
    /*
     * THE critical case. `getUserMedia` takes ~900 ms; the presenter overrides
     * at four seconds having never been heard, but on a contended machine the
     * acquisition can still be outstanding. A disposer that returns before it
     * settles has released nothing, and the take then opens a second capture
     * against an outstanding claim — the 9.8-second contention, caused by the
     * check written to prevent it.
     */
    const h = harness({ deferred: true });
    h.advance(MIC_CHECK_OVERRIDE_AFTER_MS);
    h.answer('start');

    // The release has not completed, so the check must not have settled.
    await Promise.resolve();
    await Promise.resolve();
    expect(h.events).not.toContain('settled');

    h.settleRelease();
    await expect(h.outcome).resolves.toBe('overridden');
    expect(h.events.indexOf('release')).toBeLessThan(h.events.indexOf('settled'));
  });

  it('releases exactly once however many things try to end the check', async () => {
    const h = harness();
    h.answer('cancel');
    h.answer('start');
    h.advance(MIC_CHECK_MAX_DURATION_MS);
    await h.outcome;
    expect(h.release).toHaveBeenCalledTimes(1);
  });
});

describe('passing', () => {
  it('resolves "passed" once a voice has been heard', async () => {
    const h = harness();
    speakUntilPassed(h);
    h.advance(MIC_CHECK_SETTLE_MS);
    await expect(h.outcome).resolves.toBe('passed');
  });

  it('leaves the result on screen before it tears the overlay down', async () => {
    /*
     * Without the settle the overlay is replaced in the frame it succeeds, so
     * the presenter never sees the one thing they were asked to wait for.
     */
    const h = harness();
    speakUntilPassed(h);
    expect(h.last().active).toBe(true);
    expect(h.last().state).toBe('passed');

    h.advance(MIC_CHECK_SETTLE_MS);
    await h.outcome;
    expect(h.last().active).toBe(false);
  });

  it('is not overtaken by the ceiling when it lands in the final moments', async () => {
    /*
     * The settle window can straddle the cap. Left armed, the cap wins and the
     * check tells the presenter their microphone works and then refuses to
     * start — the worst possible combination of the two outcomes.
     */
    // Positioned so the pass latches with less than the settle window left on
    // the ceiling — the only arrangement where the two actually race.
    const FRAMES_TO_PASS = 15;
    const latchAfterMs = (FRAMES_TO_PASS - 1) * FRAME_MS;
    const h = harness();
    h.advance(MIC_CHECK_MAX_DURATION_MS - latchAfterMs - MIC_CHECK_SETTLE_MS / 2);
    speakUntilPassed(h, FRAMES_TO_PASS);
    h.advance(MIC_CHECK_SETTLE_MS);
    await expect(h.outcome).resolves.toBe('passed');
  });
});

describe('the presenter answering', () => {
  it('starting before a pass is an override, not a pass', async () => {
    // The distinction matters: one is evidence the microphone works, the other
    // is the presenter taking responsibility for it.
    const h = harness();
    h.advance(MIC_CHECK_OVERRIDE_AFTER_MS);
    h.answer('start');
    await expect(h.outcome).resolves.toBe('overridden');
  });

  it('IGNORES a start that arrives before the override is available', async () => {
    /*
     * Control is authoritative, not the stage. A webview emit is a broadcast
     * and the stage's idea of "available" is whatever frame it last received —
     * neither is a safeguard. If the gate lived only on the stage, a stale or
     * replayed intent would skip a check that had run for a fraction of a
     * second, restoring "press the thing to make the screen go away".
     */
    const h = harness();
    h.advance(MIC_CHECK_OVERRIDE_AFTER_MS - 1);
    h.answer('start');
    await Promise.resolve();
    expect(h.events).not.toContain('settled');

    // And it still works the moment the deadline genuinely passes.
    h.advance(1);
    h.answer('start');
    await expect(h.outcome).resolves.toBe('overridden');
  });

  it('starting after a pass is still a pass', async () => {
    // Impatience with the settle timer is not a skipped check.
    const h = harness();
    speakUntilPassed(h);
    h.answer('start');
    await expect(h.outcome).resolves.toBe('passed');
  });

  it('cancelling is honoured immediately, at any time', async () => {
    // A presenter must always be able to get off a full-screen stage — the
    // override delay must never apply to the way out.
    const h = harness();
    h.answer('cancel');
    await expect(h.outcome).resolves.toBe('cancelled');
  });

  it('keeps the fault on screen when cancelled, rather than claiming a pass', async () => {
    const h = harness();
    for (let i = 0; i < 40; i += 1) {
      h.emitLevel({ rms: 0, peak: 0, speaking: false, signalPresent: false });
      h.advance(FRAME_MS);
    }
    h.answer('cancel');
    await h.outcome;
    expect(h.last().state).toBe('unheard');
  });

  it('ignores a second answer', async () => {
    const h = harness();
    h.answer('cancel');
    h.answer('start');
    await expect(h.outcome).resolves.toBe('cancelled');
    expect(h.release).toHaveBeenCalledTimes(1);
  });
});

describe('the ceiling', () => {
  it('reports a walk-away as a timeout, not as the presenter saying no', async () => {
    /*
     * They are different events and the caller reports them differently: a
     * cancel is silent because the presenter knows what they did, a timeout
     * needs an explanation or the operator returns to a screen that looks like
     * the button never worked.
     */
    const h = harness();
    h.advance(MIC_CHECK_MAX_DURATION_MS);
    await expect(h.outcome).resolves.toBe('timed_out');
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it('does not fire once the check has already ended', async () => {
    const h = harness();
    speakUntilPassed(h);
    h.advance(MIC_CHECK_SETTLE_MS);
    await h.outcome;
    const publishedAtEnd = h.published.length;

    h.advance(MIC_CHECK_MAX_DURATION_MS * 2);
    expect(h.published).toHaveLength(publishedAtEnd);
    expect(h.release).toHaveBeenCalledTimes(1);
  });
});

describe('being aborted from outside', () => {
  it('ends when the caller aborts — the stage window died', async () => {
    /*
     * The keyboard is on the window that just disappeared, so without this the
     * only remaining exit is the five-minute ceiling: the capture stays held,
     * the start sequence stays blocked, and if the microphone then passes on
     * its own a take opens with no stage to prompt from.
     */
    const h = harness({ abortable: true });
    h.abort();
    await expect(h.outcome).resolves.toBe('cancelled');
    expect(h.events.indexOf('release')).toBeLessThan(h.events.indexOf('settled'));
  });
});

describe('when a dependency throws', () => {
  it('settles anyway if the final dismissal fails', async () => {
    /*
     * The worst bug this file exists to prevent. Teardown has already run, so
     * the microphone is free — but if the throw escaped, the promise would
     * never settle and `startSession` would hang forever behind a full-screen
     * always-on-top window with no key that dismisses it.
     */
    const h = harness({ publishThrowsAt: 'last' });
    h.answer('cancel');
    await expect(h.outcome).resolves.toBe('cancelled');
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it('keeps running when a periodic frame fails to publish', async () => {
    // The waveform is a readout. Losing frames must not end the check, and must
    // not escape a timer callback as an unhandled rejection.
    const h = harness({ publishThrowsAt: 'periodic' });
    h.advance(1000);
    speakUntilPassed(h);
    h.advance(MIC_CHECK_SETTLE_MS);
    await expect(h.outcome).resolves.toBe('passed');
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it('releases the capture when setup itself fails', async () => {
    /*
     * A rejection that leaked a live capture would hand the take a contended
     * device on top of an already-failing start.
     */
    const h = harness({ publishThrowsAt: 'first' });
    await expect(h.outcome).rejects.toThrow('emit failed');
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.events.indexOf('release')).toBeLessThan(h.events.indexOf('rejected'));
  });

  it('fails the start when the first frame never reaches the stage', async () => {
    /*
     * The production shape: `emitTo` REJECTS rather than throwing. Left
     * unhandled, the check would run on behind a stage that received no
     * overlay — and because the stage only intercepts the keyboard while a
     * check is drawn, Escape falls through to a handler control has not
     * subscribed to yet. Black full-screen window, no explanation, no way out
     * until the five-minute ceiling.
     */
    const h = harness({ publishThrowsAt: 'first-rejects' });
    await expect(h.outcome).rejects.toThrow('emit failed');
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.events.indexOf('release')).toBeLessThan(h.events.indexOf('rejected'));
  });
});

describe('degrading', () => {
  it('still runs when the keyboard path cannot be subscribed', async () => {
    /*
     * Losing the override is much better than refusing to start a take because
     * an event subscription failed. The check must still hear, still draw, and
     * still pass on its own; the ceiling bounds the case where the microphone
     * is dead too.
     */
    const h = harness({ intentFails: true });
    speakUntilPassed(h);
    h.advance(MIC_CHECK_SETTLE_MS);
    await expect(h.outcome).resolves.toBe('passed');
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes the intent listener when it ends', async () => {
    const h = harness();
    h.answer('cancel');
    await h.outcome;
    expect(h.unsubscribeIntent).toHaveBeenCalledTimes(1);
  });

  it('ignores level frames that arrive after it has settled', async () => {
    const h = harness();
    h.answer('cancel');
    await h.outcome;
    const publishedAtEnd = h.published.length;
    h.emitLevel();
    expect(h.published).toHaveLength(publishedAtEnd);
  });
});
