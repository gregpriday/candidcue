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

function makePipeline(clock: VirtualClock): VoiceSessionPipeline {
  return new VoiceSessionPipeline({
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
