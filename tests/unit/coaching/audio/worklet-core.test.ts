/**
 * §12.1–§12.3. The render-thread core: conditioning, framing, the audio clock,
 * dropout detection, and the ring buffer join.
 *
 * The most valuable test in this file is the dullest one: pushing a quantum
 * must not modify the caller's samples. That is §12.3 — "analysis filters must
 * not modify the source track" — expressed as something a test can actually
 * check, and it is the failure that would be invisible until a listener
 * complained that the recording sounded thin.
 */
import { describe, expect, it } from 'vitest';
import { WorkletAudioCore } from '../../../../src/shared/coaching/audio/worklet-core';
import {
  PACKED_FRAME_FIELDS,
  unpackFrame,
} from '../../../../src/shared/coaching/audio/frame-features';
import { makeRandom, sine, speechTimeline, whiteNoise } from './signals';
import type { AudioFrameFeatures } from '../../../../src/shared/contracts/coaching';

const RATE = 48_000;
const QUANTUM = 128;

interface Harness {
  core: WorkletAudioCore;
  frames: AudioFrameFeatures[];
  publishes: number[];
}

function harness(options: Partial<Parameters<typeof buildCore>[0]> = {}): Harness {
  return buildCore({ sampleRate: RATE, ...options });
}

function buildCore(options: {
  sampleRate: number;
  frameMs?: number;
  publishIntervalMs?: number;
  ringBuffer?: { enabled: boolean; capacitySeconds?: number };
}): Harness {
  const frames: AudioFrameFeatures[] = [];
  const publishes: number[] = [];
  const core = new WorkletAudioCore({
    ...options,
    onFrames: (packed, frameCount) => {
      publishes.push(frameCount);
      for (let i = 0; i < frameCount; i += 1) {
        frames.push(unpackFrame(packed, i * PACKED_FRAME_FIELDS));
      }
    },
  });
  return { core, frames, publishes };
}

/** Feed a whole signal through in 128-sample render quanta. */
function pump(
  core: WorkletAudioCore,
  signal: Float32Array,
  options: { gapAtSample?: number; gapSamples?: number; channels?: number } = {},
): void {
  const channelCount = options.channels ?? 1;
  const buffers: Float32Array[] = [];
  for (let c = 0; c < channelCount; c += 1) buffers.push(new Float32Array(QUANTUM));
  let contextSample = 0;
  let read = 0;

  while (read + QUANTUM <= signal.length) {
    if (
      options.gapAtSample !== undefined &&
      options.gapSamples !== undefined &&
      contextSample >= options.gapAtSample &&
      contextSample < options.gapAtSample + options.gapSamples
    ) {
      // The process callback simply is not invoked for this stretch; the
      // context clock keeps running, which is exactly how a real dropout looks.
      contextSample += QUANTUM;
      read += QUANTUM;
      continue;
    }
    for (let c = 0; c < channelCount; c += 1) {
      const buffer = buffers[c] as Float32Array;
      for (let i = 0; i < QUANTUM; i += 1) buffer[i] = signal[read + i] as number;
    }
    core.pushQuantum(buffers, QUANTUM, contextSample);
    contextSample += QUANTUM;
    read += QUANTUM;
  }
  core.flush();
}

describe('§12.3 the analysis path never modifies its input', () => {
  it('leaves the caller-owned sample buffers bit-identical', () => {
    const { core } = harness();
    const input = sine(200, 0.5, RATE, QUANTUM);
    // A DC offset guarantees the DC blocker has something to remove, so a
    // filter that ran in place would be visible here.
    for (let i = 0; i < QUANTUM; i += 1) input[i] = (input[i] as number) + 0.3;
    const copy = Float32Array.from(input);

    for (let q = 0; q < 20; q += 1) core.pushQuantum([input], QUANTUM, q * QUANTUM);

    expect(Array.from(input)).toEqual(Array.from(copy));
  });

  it('does not modify either channel of a stereo input while downmixing', () => {
    const { core } = harness();
    const left = sine(200, 0.4, RATE, QUANTUM);
    const right = sine(300, 0.4, RATE, QUANTUM);
    const leftCopy = Float32Array.from(left);
    const rightCopy = Float32Array.from(right);
    core.pushQuantum([left, right], QUANTUM, 0);
    expect(Array.from(left)).toEqual(Array.from(leftCopy));
    expect(Array.from(right)).toEqual(Array.from(rightCopy));
  });
});

describe('§12.3 signal conditioning', () => {
  it('removes DC offset', () => {
    const { core, frames } = harness();
    const signal = new Float32Array(RATE); // 1 s
    for (let i = 0; i < signal.length; i += 1) {
      signal[i] = 0.4 + (sine(400, 0.05, RATE, 1, i)[0] as number);
    }
    pump(core, signal);
    // With a 0.4 DC offset intact, RMS would be ≈ -8 dBFS. Removed, only the
    // 0.05 tone remains: ≈ -29 dBFS.
    const settled = frames.slice(25);
    const meanRms = settled.reduce((sum, f) => sum + f.rmsDbfs, 0) / settled.length;
    expect(meanRms).toBeLessThan(-24);
    expect(meanRms).toBeGreaterThan(-34);
  });

  it('attenuates rumble below the ~70 Hz high-pass but passes speech', () => {
    function levelOf(frequencyHz: number): number {
      const { core, frames } = harness();
      pump(core, sine(frequencyHz, 0.3, RATE, RATE));
      const settled = frames.slice(25);
      return settled.reduce((sum, f) => sum + f.rmsDbfs, 0) / settled.length;
    }
    const rumble30 = levelOf(30);
    const speech200 = levelOf(200);
    const speech1k = levelOf(1000);

    // A 2nd-order high-pass at 70 Hz gives ~-15 dB at 30 Hz.
    expect(speech200 - rumble30).toBeGreaterThan(10);
    // ...while the speech band is essentially untouched.
    expect(Math.abs(speech1k - speech200)).toBeLessThan(1.5);
    expect(speech1k).toBeCloseTo(-13.5, 0); // 0.3 amplitude sine => -13.5 dBFS RMS
  });

  it('downmixes stereo to the mean of the channels', () => {
    const mono = harness();
    const stereo = harness();
    const tone = sine(300, 0.4, RATE, RATE);
    pump(mono.core, tone);
    pump(stereo.core, tone, { channels: 2 }); // identical channels => same mono

    const meanOf = (frames: AudioFrameFeatures[]): number =>
      frames.slice(25).reduce((sum, f) => sum + f.rmsDbfs, 0) / (frames.length - 25);
    expect(meanOf(stereo.frames)).toBeCloseTo(meanOf(mono.frames), 6);
  });
});

describe('§12.2 framing and the audio clock', () => {
  it('emits 20 ms frames stamped from the context sample index', () => {
    const { core, frames } = harness();
    pump(core, whiteNoise(0.05, RATE, makeRandom(2))); // 1 s

    // 1 s of audio at 20 ms per frame, less whatever the 128-sample quantum
    // leaves in the partial frame at the end.
    expect(frames.length).toBeGreaterThanOrEqual(49);
    expect(frames.length).toBeLessThanOrEqual(50);
    for (let i = 0; i < frames.length; i += 1) {
      expect((frames[i] as AudioFrameFeatures).audioTimeMs).toBeCloseTo(i * 20, 6);
    }
  });

  it('publishes on the aggregation window, not per frame (§12.1)', () => {
    const { core, publishes, frames } = harness({ publishIntervalMs: 100 });
    pump(core, whiteNoise(0.05, RATE, makeRandom(4)));
    // 5 frames per publish, not 1.
    for (const count of publishes.slice(0, -1)) expect(count).toBe(5);
    expect(frames.length).toBeGreaterThan(45);
  });

  it('keeps the clock monotonic and gap-free across quantum boundaries', () => {
    const { core, frames } = harness({ frameMs: 20 });
    pump(core, whiteNoise(0.05, RATE * 2, makeRandom(6)));
    for (let i = 1; i < frames.length; i += 1) {
      const delta =
        (frames[i] as AudioFrameFeatures).audioTimeMs -
        (frames[i - 1] as AudioFrameFeatures).audioTimeMs;
      expect(delta).toBeCloseTo(20, 6);
    }
  });
});

describe('§12.4 dropout detection', () => {
  it('publishes a lost stretch as dropout frames, not as silence', () => {
    const { core, frames } = harness();
    const signal = speechTimeline({
      sampleRate: RATE,
      durationMs: 2000,
      noiseRms: 0.002,
      segments: [{ startMs: 200, endMs: 1800, f0Hz: 150, rms: 0.08 }],
    });
    // 300 ms of missed process() callbacks starting at 1000 ms.
    pump(core, signal, { gapAtSample: RATE, gapSamples: Math.round(RATE * 0.3) });

    const dropouts = frames.filter((f) => f.processorDropout);
    expect(dropouts.length).toBeGreaterThanOrEqual(14);
    expect(dropouts.length).toBeLessThanOrEqual(17);
    expect(core.diagnostics.gapCount).toBe(1);
    expect(core.diagnostics.droppedFrameCount).toBeGreaterThanOrEqual(14);

    // Every dropout frame must be *unmeasured*, never a quiet measurement.
    for (const frame of dropouts) {
      expect(frame.speechProbability).toBe(0);
      expect(frame.estimatedSnrDb).toBe(0);
      expect(frame.f0Hz).toBeNull();
    }
    // And the clock does not rewind or stall across the gap.
    for (let i = 1; i < frames.length; i += 1) {
      expect((frames[i] as AudioFrameFeatures).audioTimeMs).toBeGreaterThan(
        (frames[i - 1] as AudioFrameFeatures).audioTimeMs,
      );
    }
  });

  it('realigns the clock to the device after a gap rather than drifting', () => {
    const { core, frames } = harness();
    pump(core, whiteNoise(0.05, RATE, makeRandom(8)), {
      gapAtSample: RATE / 2,
      gapSamples: Math.round(RATE * 0.2),
    });
    const last = frames[frames.length - 1] as AudioFrameFeatures;
    // 1 s of context time, whatever happened in the middle of it.
    expect(last.audioTimeMs).toBeGreaterThan(940);
    expect(last.audioTimeMs).toBeLessThanOrEqual(1000);
  });
});

describe('§12.6 ring buffer integration', () => {
  it('retains raw PCM addressable by audio time, and clears on request', () => {
    const { core } = harness({ ringBuffer: { enabled: true, capacitySeconds: 2 } });
    pump(core, sine(200, 0.5, RATE, RATE));

    const pcm = core.extract(200, 400);
    expect(pcm).not.toBeNull();
    expect((pcm as Float32Array).length).toBe(Math.round(RATE * 0.2));

    // Raw, not high-passed: a 200 Hz tone at 0.5 keeps its amplitude.
    let peak = 0;
    for (const sample of pcm as Float32Array) peak = Math.max(peak, Math.abs(sample));
    expect(peak).toBeGreaterThan(0.45);

    core.clearRingBuffer('take_end');
    expect(core.extract(200, 400)).toBeNull();
  });

  it('retains nothing at all when the ring buffer is disabled', () => {
    const { core } = harness();
    pump(core, sine(200, 0.5, RATE, RATE));
    expect(core.ringBuffer).toBeNull();
    expect(core.extract(100, 200)).toBeNull();
  });

  it('refuses to reconstruct an interval that spans a dropout', () => {
    const { core } = harness({ ringBuffer: { enabled: true, capacitySeconds: 2 } });
    pump(core, sine(200, 0.5, RATE, RATE), {
      gapAtSample: RATE / 2,
      gapSamples: Math.round(RATE * 0.1),
    });
    // 400-700 ms straddles the 500-600 ms hole.
    expect(core.extract(400, 700)).toBeNull();
    // Audio after the gap is still available and correctly dated.
    expect(core.extract(700, 900)).not.toBeNull();
  });
});

describe('lifecycle', () => {
  it('reset clears diagnostics and retained audio', () => {
    const { core } = harness({ ringBuffer: { enabled: true, capacitySeconds: 2 } });
    pump(core, sine(200, 0.5, RATE, RATE));
    expect(core.diagnostics.framesProduced).toBeGreaterThan(40);
    core.reset('take_end');
    expect(core.diagnostics.framesProduced).toBe(0);
    expect(core.extract(200, 400)).toBeNull();
  });

  it('survives an empty input (a muted track) without producing frames', () => {
    const { core, frames } = harness();
    core.pushQuantum([], 0, 0);
    expect(frames).toHaveLength(0);
  });
});
