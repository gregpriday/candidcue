/**
 * B2 + B3 regressions: the Luna handoff could freeze the teleprompter.
 *
 * B2 — `resolveLuna` awaited `ipcInvoke('interpret_command')` with NO timeout,
 * and `case 'needs_luna'` never touched the pending flag at all. A hung or slow
 * Rust handler therefore held COMMAND_PENDING open indefinitely: the aligner
 * stops integrating, the stage stops moving, and the only thing that eventually
 * saved the take was the engine's own `commandPendingTimeoutMs` backstop — four
 * seconds of a frozen prompter mid-take, which is a ruined take, not a fix.
 *
 * B3 — `CommandRouter.tick` (which calls `expireLuna`) had no periodic caller,
 * so the router's own §33.11 expiry only ran when new transcript arrived. That
 * is exactly what does NOT happen while the aligner is frozen waiting for Luna,
 * so the expiry could never fire in the one situation it was written for.
 *
 * Both are driven here through the real pipeline, the real router, and a virtual
 * clock, so the assertions are about *when* the freeze releases, not merely that
 * it eventually does.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { compile } from '../../../src/shared/markdown';
import {
  COMMAND_TICK_INTERVAL_MS,
  VoiceSessionPipeline,
} from '../../../src/control/services/voice-session';
import { setInvokeForTesting } from '../../../src/control/services/ipc';
import type { TranscriptionConfig } from '../../../src/shared/contracts';
import type { TransportTimers } from '../../../src/control/services/realtime';

const script = compile('# Demo\n\nOne two three four five six seven eight nine ten eleven twelve.\n', {
  scriptId: 'luna-demo',
  wakePhrases: ['CandidCue'],
});

const CONFIG: TranscriptionConfig = {
  model: 'gpt-realtime-whisper',
  language: 'en',
  delay: 'low',
  requestLogprobs: false,
};

const LUNA_HARD_TIMEOUT_MS = 1_500;

/**
 * A phrase the deterministic grammar cannot parse but that still reads as a
 * command, so the router hands it to Luna (§33.7).
 */
const NEEDS_LUNA = 'candid cue show me the mood board';

/* ---------------------------------------------------------------------------
 * Virtual clock
 * ------------------------------------------------------------------------- */

interface Scheduled {
  id: number;
  at: number;
  delay: number;
  cb: () => void;
}

class VirtualClock {
  now = 10_000;
  readonly fired: number[] = [];
  private seq = 0;
  private queue: Scheduled[] = [];

  readonly timers: TransportTimers = {
    setTimeout: (cb: () => void, ms: number): unknown => {
      const entry: Scheduled = { id: ++this.seq, at: this.now + ms, delay: ms, cb };
      this.queue.push(entry);
      return entry.id;
    },
    clearTimeout: (handle: unknown): void => {
      this.queue = this.queue.filter((entry) => entry.id !== handle);
    },
  };

  scheduledDelays(): number[] {
    return this.queue.map((entry) => entry.delay);
  }

  /** Run every timer due at or before `now + ms`, in scheduled order. */
  async advance(ms: number): Promise<void> {
    const until = this.now + ms;
    for (;;) {
      const next = this.due(until, () => true);
      if (next === undefined) break;
      this.run(next);
      await flush();
    }
    this.now = until;
  }

  /**
   * Run only the timers scheduled with `delay`, `times` times. Used to isolate
   * the router tick (B3) from the pipeline's own Luna race (B2): both deadlines
   * derive from `lunaHardTimeoutMs`, so firing everything would not tell us
   * which one released the freeze.
   */
  async fireOnly(delay: number, times: number): Promise<number> {
    let ran = 0;
    for (let i = 0; i < times; i++) {
      const next = this.due(Number.POSITIVE_INFINITY, (entry) => entry.delay === delay);
      if (next === undefined) break;
      this.now = next.at;
      this.run(next);
      ran++;
      await flush();
    }
    return ran;
  }

  private due(until: number, match: (entry: Scheduled) => boolean): Scheduled | undefined {
    let best: Scheduled | undefined;
    for (const entry of this.queue) {
      if (entry.at > until || !match(entry)) continue;
      if (best === undefined || entry.at < best.at || (entry.at === best.at && entry.id < best.id)) {
        best = entry;
      }
    }
    return best;
  }

  private run(entry: Scheduled): void {
    this.queue = this.queue.filter((other) => other.id !== entry.id);
    this.now = Math.max(this.now, entry.at);
    this.fired.push(entry.delay);
    entry.cb();
  }
}

/** Let queued microtasks (the `Promise.race` continuation) settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

/* ---------------------------------------------------------------------------
 * Harness
 * ------------------------------------------------------------------------- */

interface Harness {
  pipe: VoiceSessionPipeline;
  clock: VirtualClock;
  pending: boolean[];
  unknown: string[];
  masked: string[][];
  speak(text: string): void;
}

function harness(executed: string[] = []): Harness {
  const clock = new VirtualClock();
  const pending: boolean[] = [];
  const unknown: string[] = [];
  const masked: string[][] = [];
  const pipe = new VoiceSessionPipeline({
    sessionId: 'sess-luna',
    sessionGeneration: 1,
    compiled: script,
    config: CONFIG,
    commandSettings: { lunaHardTimeoutMs: LUNA_HARD_TIMEOUT_MS },
    getCursorTokenIndex: () => 0,
    getPosition: () => ({ blockId: 'b0', sentenceId: 's0', tokenIndex: 0 }),
    getScrollMode: () => 'voice',
    onTrackingEvent: () => {},
    onMaskItems: (ids) => masked.push([...ids]),
    onReleaseItems: () => {},
    onCommandPending: (value) => pending.push(value),
    executeCommand: (command) => executed.push(command.action.action),
    onUnknownCommand: (message) => unknown.push(message),
    onTranscriptLine: () => {},
    onConnectionState: () => {},
    timers: clock.timers,
    now: () => clock.now,
  });
  let item = 0;
  const speak = (text: string): void => {
    const itemId = `item-${++item}`;
    const transport = (event: unknown): void => {
      (pipe as unknown as { handleTransportEvent(e: unknown): void }).handleTransportEvent(event);
    };
    transport({ type: 'item_started', itemId, commitSequence: item });
    transport({ type: 'completed', itemId, text });
  };
  return { pipe, clock, pending, unknown, masked, speak };
}

afterEach(() => {
  setInvokeForTesting(null);
});

/* ---------------------------------------------------------------------------
 * B2
 * ------------------------------------------------------------------------- */

describe('B2: a hung Luna handoff releases the freeze at lunaHardTimeoutMs', () => {
  it('freezes on handoff and un-freezes on the pipeline timeout, not the 4 s engine backstop', async () => {
    // A handler that never answers — the exact production failure.
    setInvokeForTesting(() => new Promise<never>(() => {}));
    const h = harness();

    h.speak(NEEDS_LUNA);
    await flush();

    // The handoff freezes the aligner and masks the command speech.
    expect(h.pending).toEqual([true]);
    expect(h.masked).toEqual([['item-1']]);
    // The pipeline armed its own deadline at exactly the configured timeout.
    expect(h.clock.scheduledDelays()).toContain(LUNA_HARD_TIMEOUT_MS);

    await h.clock.advance(LUNA_HARD_TIMEOUT_MS - 1);
    // Pre-fix: still `[true]` here AND forever after — nothing bounded the await.
    expect(h.pending).toEqual([true]);

    await h.clock.advance(1);
    expect(h.pending).toEqual([true, false]);
    // The engine's own commandPendingTimeoutMs is 4 s; we released well inside it.
    expect(h.clock.now).toBeLessThan(10_000 + 4_000);
    expect(h.unknown).toHaveLength(1);
  });

  it('a rejected handoff releases the freeze too', async () => {
    setInvokeForTesting(() => Promise.reject(new Error('NOT_IMPLEMENTED')));
    const h = harness();

    h.speak(NEEDS_LUNA);
    await flush();

    expect(h.pending).toEqual([true, false]);
    expect(h.unknown).toHaveLength(1);
  });

  it('a handoff that answers in time still resolves normally', async () => {
    const executed: string[] = [];
    setInvokeForTesting(() =>
      Promise.resolve({ action: 'pause', confidence: 0.9, requires_confirmation: false } as never),
    );
    const h = harness(executed);

    h.speak(NEEDS_LUNA);
    await flush();

    expect(h.pending).toEqual([true, false]);
    expect(h.unknown).toEqual([]);
    expect(executed).toEqual(['pause']);
  });
});

/* ---------------------------------------------------------------------------
 * B3
 * ------------------------------------------------------------------------- */

describe('B3: router.tick runs on a timer', () => {
  it('expires a pending handoff with no transcript events at all', async () => {
    setInvokeForTesting(() => new Promise<never>(() => {}));
    const h = harness();

    h.speak(NEEDS_LUNA);
    await flush();
    expect(h.pending).toEqual([true]);
    expect(h.pipe.router.hasPendingLuna()).toBe(true);

    // Fire ONLY the router tick — never the pipeline's own Luna deadline. Pre-fix
    // no such timer was ever scheduled, so `ran` is 0 and nothing expires.
    const ticksNeeded = Math.ceil(LUNA_HARD_TIMEOUT_MS / COMMAND_TICK_INTERVAL_MS) + 1;
    const ran = await h.clock.fireOnly(COMMAND_TICK_INTERVAL_MS, ticksNeeded);

    expect(ran).toBe(ticksNeeded);
    expect(h.pipe.router.hasPendingLuna()).toBe(false);
    expect(h.pending).toEqual([true, false]);
    expect(h.pipe.router.commandLog().some((entry) => entry.status === 'timeout')).toBe(true);
  });

  it('an ordinary tick with nothing pending never un-freezes the aligner', async () => {
    setInvokeForTesting(() => new Promise<never>(() => {}));
    const h = harness();

    h.speak(NEEDS_LUNA);
    await flush();

    // Two ticks well inside the timeout: `tick` returns a bare `none`, which
    // means "nothing expired" — running it through `applyObservation` would
    // release the freeze immediately, defeating the whole mechanism.
    await h.clock.fireOnly(COMMAND_TICK_INTERVAL_MS, 2);
    expect(h.pending).toEqual([true]);
    expect(h.pipe.router.hasPendingLuna()).toBe(true);
  });

  it('stopping the session disarms the ticker', async () => {
    setInvokeForTesting(() => new Promise<never>(() => {}));
    const h = harness();

    h.speak(NEEDS_LUNA);
    await flush();
    expect(h.clock.scheduledDelays()).toContain(COMMAND_TICK_INTERVAL_MS);

    await h.pipe.stop();
    expect(h.clock.scheduledDelays()).not.toContain(COMMAND_TICK_INTERVAL_MS);
  });
});
