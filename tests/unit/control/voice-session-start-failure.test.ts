/**
 * `VoiceSessionPipeline.start()` arms the §33.11 command ticker BEFORE it
 * awaits `controller.start()`. When the start rejected — no key, no mic, no
 * network — the pipeline was left with `running = true` and a 250 ms
 * self-rescheduling timer that ran until something eventually called `stop()`.
 * The session store's own catch only set `connection: 'offline'`, so nothing
 * did.
 *
 * The clock here is virtual, so "is a timer still armed?" is directly
 * observable rather than inferred.
 */
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/shared/markdown';
import {
  COMMAND_TICK_INTERVAL_MS,
  VoiceSessionPipeline,
} from '../../../src/control/services/voice-session';
import type { TranscriptionConfig } from '../../../src/shared/contracts';
import type { TransportTimers } from '../../../src/control/services/realtime';

const script = compile('# Demo\n\nOne two three four five six seven eight.\n', {
  scriptId: 'start-failure',
  wakePhrases: ['CandidCue'],
});

const CONFIG: TranscriptionConfig = {
  model: 'gpt-realtime-whisper',
  language: 'en',
  delay: 'low',
  requestLogprobs: false,
};

class VirtualClock {
  now = 1_000;
  private seq = 0;
  private queue: Array<{ id: number; at: number; delay: number; cb: () => void }> = [];

  readonly timers: TransportTimers = {
    setTimeout: (cb: () => void, ms: number): unknown => {
      const id = ++this.seq;
      this.queue.push({ id, at: this.now + ms, delay: ms, cb });
      return id;
    },
    clearTimeout: (handle: unknown): void => {
      this.queue = this.queue.filter((entry) => entry.id !== handle);
    },
  };

  /** How many command ticks are currently armed. */
  armedCommandTicks(): number {
    return this.queue.filter((entry) => entry.delay === COMMAND_TICK_INTERVAL_MS).length;
  }

  async advance(ms: number): Promise<void> {
    const until = this.now + ms;
    for (;;) {
      const next = [...this.queue].sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next || next.at > until) break;
      this.queue = this.queue.filter((entry) => entry.id !== next.id);
      this.now = next.at;
      next.cb();
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    }
    this.now = until;
  }
}

interface StartSequenceGate {
  flushScriptSave(): Promise<void>;
  ensureCompiled(): Promise<void>;
  awaitStageAck(): Promise<void>;
}

function makePipeline(clock: VirtualClock, startSequence?: StartSequenceGate): VoiceSessionPipeline {
  return new VoiceSessionPipeline({
    ...(startSequence ? { startSequence } : {}),
    sessionId: 'sess-start-failure',
    sessionGeneration: 1,
    compiled: script,
    config: CONFIG,
    getCursorTokenIndex: () => 0,
    getPosition: () => ({ blockId: 'b0', sentenceId: 's0', tokenIndex: 0 }),
    getScrollMode: () => 'voice',
    onTrackingEvent: () => {},
    onMaskItems: () => {},
    onReleaseItems: () => {},
    onCommandPending: () => {},
    executeCommand: () => {},
    onUnknownCommand: () => {},
    onTranscriptLine: () => {},
    onConnectionState: () => {},
    timers: clock.timers,
    now: () => clock.now,
  });
}

describe('pipeline start failure', () => {
  it('disarms the command ticker when start() rejects', async () => {
    const clock = new VirtualClock();
    const pipe = makePipeline(clock);

    // There is no `navigator.mediaDevices` (and no Tauri) here, so the real
    // start sequence fails the way it does for a user with no microphone.
    const started = pipe.start();
    expect(clock.armedCommandTicks()).toBe(1); // armed before the await, as designed

    await expect(started).rejects.toBeDefined();
    expect(clock.armedCommandTicks()).toBe(0);

    // ...and it does not come back on the next tick boundary.
    await clock.advance(COMMAND_TICK_INTERVAL_MS * 10);
    expect(clock.armedCommandTicks()).toBe(0);
  });

  it('is still safe to stop afterwards', async () => {
    const clock = new VirtualClock();
    const pipe = makePipeline(clock);
    await pipe.start().catch(() => {});
    await expect(pipe.stop()).resolves.toBeUndefined();
    expect(clock.armedCommandTicks()).toBe(0);
  });
});

/**
 * §29.2 — the pipeline forwards its caller's start sequence into the controller.
 *
 * This is the hop between "the session store supplies a gate" and "the
 * controller enforces it". Both halves were previously asserted and this middle
 * one was not, which is exactly the shape of the original defect: a value
 * carried faithfully to the last call site and then not passed.
 */
describe('§29.2 the pipeline hands its start sequence to the controller', () => {
  it('runs steps 1–3 in order and stops on the first rejection', async () => {
    const clock = new VirtualClock();
    const calls: string[] = [];
    const pipe = makePipeline(clock, {
      flushScriptSave: async () => {
        calls.push('flush');
      },
      ensureCompiled: async () => {
        calls.push('compile');
        throw new Error('the script has not finished compiling');
      },
      awaitStageAck: async () => {
        calls.push('stage_ack');
      },
    });

    await expect(pipe.start()).rejects.toThrow('the script has not finished compiling');
    // Step 3 never ran, so nothing downstream of it did either — and the
    // transport was never asked for a credential, which is what makes this a
    // cost guarantee rather than a tidiness one.
    expect(calls).toEqual(['flush', 'compile']);
    expect(pipe.controller.state).not.toBe('ready');
  });

  it('reaches the microphone step when every precondition is met', async () => {
    const clock = new VirtualClock();
    const calls: string[] = [];
    const pipe = makePipeline(clock, {
      flushScriptSave: async () => {
        calls.push('flush');
      },
      ensureCompiled: async () => {
        calls.push('compile');
      },
      awaitStageAck: async () => {
        calls.push('stage_ack');
      },
    });

    // There is no `navigator.mediaDevices` here, so the start still fails —
    // but it fails AFTER the sequence, which is the whole point.
    await expect(pipe.start()).rejects.toBeDefined();
    expect(calls).toEqual(['flush', 'compile', 'stage_ack']);
  });
});
