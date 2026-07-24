/**
 * §12.1 real-time budget.
 *
 * This runs on the audio render thread during a live take, alongside a WebRTC
 * session and the alignment worker. If a frame costs more than its own 20 ms
 * the presenter sees a dropout, so the cost has to be checked, not assumed.
 *
 * Measured on a development machine (Apple silicon, node): a real-time factor
 * of **0.004–0.006**, i.e. ~80–110 µs of CPU per 20 ms frame, or about half a
 * percent of one core.
 *
 * The assertion is set at 0.05 — roughly 10× the measured cost. That is chosen
 * against a specific failure, not picked to be comfortable: the one change that
 * would genuinely threaten this code is running YIN at the native 48 kHz
 * instead of on the decimated ~8 kHz path, which costs ~35× and would land
 * around 0.15. A 10× bound catches that with room for a loaded CI box; a bound
 * of 0.25 would *not* have, which is exactly the kind of toothless performance
 * assertion this project has been bitten by before.
 */
import { describe, expect, it } from 'vitest';
import { WorkletAudioCore } from '../../../../src/shared/coaching/audio/worklet-core';
import { makeRandom, voicedTone, whiteNoise } from './signals';

const RATE = 48_000;
const QUANTUM = 128;
const SECONDS = 20;

function measureRealtimeFactor(ringBuffer: boolean): number {
  const random = makeRandom(17);
  const signal = voicedTone(150, 0.06, RATE, RATE * SECONDS);
  const noise = whiteNoise(0.002, RATE * SECONDS, random);
  for (let i = 0; i < signal.length; i += 1) {
    signal[i] = (signal[i] as number) + (noise[i] as number);
  }

  const core = new WorkletAudioCore({
    sampleRate: RATE,
    ringBuffer: { enabled: ringBuffer, capacitySeconds: 30 },
    onFrames: () => {},
  });
  const buffer = new Float32Array(QUANTUM);
  const started = performance.now();
  let read = 0;
  while (read + QUANTUM <= signal.length) {
    for (let i = 0; i < QUANTUM; i += 1) buffer[i] = signal[read + i] as number;
    core.pushQuantum([buffer], QUANTUM, read);
    read += QUANTUM;
  }
  const elapsedMs = performance.now() - started;
  const factor = elapsedMs / (SECONDS * 1000);
  const perFrameUs = (elapsedMs / (SECONDS * 50)) * 1000;
  // eslint-disable-next-line no-console
  console.log(
    `[worklet core] ring=${ringBuffer ? 'on' : 'off'} realtime-factor=${factor.toFixed(4)} ` +
      `per-frame=${perFrameUs.toFixed(0)}µs`,
  );
  return factor;
}

describe('§12.1 real-time budget', () => {
  it('processes audio far faster than real time with the ring buffer on', () => {
    expect(measureRealtimeFactor(true)).toBeLessThan(0.05);
  });

  it('processes audio far faster than real time with the ring buffer off', () => {
    expect(measureRealtimeFactor(false)).toBeLessThan(0.05);
  });
});
