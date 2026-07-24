/**
 * §12.4. The assembled per-frame feature record.
 *
 * The signals are built with a known f0 and a known RMS, so the assertions are
 * on the actual Hertz and dBFS values. The SNR identity test is the one that
 * would catch a refactor silently emitting a stale noise floor: it re-derives
 * the invariant on every frame of a synthetic take rather than trusting a
 * single sample.
 */
import { describe, expect, it } from 'vitest';
import { FrameFeatureExtractor } from '../../../../src/shared/coaching/audio/frame-features';
import { makeRandom, speechTimeline, voicedTone, whiteNoise } from './signals';
import type { AudioFrameFeatures } from '../../../../src/shared/contracts/coaching';

const RATE = 48_000;
const FRAME_MS = 20;
const FRAME = (RATE * FRAME_MS) / 1000;

function runFrames(
  extractor: FrameFeatureExtractor,
  signal: Float32Array,
  dropoutFrames = new Set<number>(),
): AudioFrameFeatures[] {
  const frames: AudioFrameFeatures[] = [];
  const scratch = new Float32Array(FRAME);
  const count = Math.floor(signal.length / FRAME);
  for (let index = 0; index < count; index += 1) {
    const dropout = dropoutFrames.has(index);
    if (dropout) {
      scratch.fill(0);
    } else {
      for (let i = 0; i < FRAME; i += 1) scratch[i] = signal[index * FRAME + i] as number;
    }
    // The extractor reuses its output object (§12.1); copy to keep a history.
    frames.push({ ...extractor.process(scratch, index * FRAME_MS, dropout) });
  }
  return frames;
}

function newExtractor(): FrameFeatureExtractor {
  return new FrameFeatureExtractor({ sampleRate: RATE, frameMs: FRAME_MS });
}

describe('FrameFeatureExtractor on voiced speech', () => {
  const signal = speechTimeline({
    sampleRate: RATE,
    durationMs: 3000,
    noiseRms: 0.002, // -54 dBFS room
    segments: [{ startMs: 1000, endMs: 2500, f0Hz: 165, rms: 0.08 }], // -22 dBFS voice
  });
  const frames = runFrames(newExtractor(), signal);

  it('recovers the synthesized f0 during the voiced segment', () => {
    const voiced = frames.filter((f) => f.audioTimeMs > 1200 && f.audioTimeMs < 2300);
    const withPitch = voiced.filter((f) => f.f0Hz !== null);
    expect(withPitch.length / voiced.length).toBeGreaterThan(0.9);
    for (const frame of withPitch) {
      expect(frame.f0Hz as number).toBeGreaterThan(160);
      expect(frame.f0Hz as number).toBeLessThan(170);
    }
  });

  it('reports high speech probability inside the segment and low outside it', () => {
    const inside = frames.filter((f) => f.audioTimeMs > 1200 && f.audioTimeMs < 2300);
    const outside = frames.filter((f) => f.audioTimeMs < 800);
    expect(mean(inside.map((f) => f.speechProbability))).toBeGreaterThan(0.8);
    expect(mean(outside.map((f) => f.speechProbability))).toBeLessThan(0.15);
  });

  it('reports the voice ≈32 dB above the room, matching the synthesized levels', () => {
    // -22 dBFS voice over a -54 dBFS floor.
    const inside = frames.filter((f) => f.audioTimeMs > 1200 && f.audioTimeMs < 2300);
    expect(mean(inside.map((f) => f.rmsDbfs))).toBeCloseTo(-22, 0);
    expect(mean(inside.map((f) => f.estimatedSnrDb))).toBeGreaterThan(28);
    expect(mean(inside.map((f) => f.estimatedSnrDb))).toBeLessThan(36);
  });

  it('keeps the noise floor on the room, not on the voice (§12.5)', () => {
    const duringSpeech = frames.filter((f) => f.audioTimeMs > 1500 && f.audioTimeMs < 2400);
    for (const frame of duringSpeech) {
      // The floor must stay near -54 dBFS; training on speech would drag it up.
      expect(frame.noiseFloorDbfs).toBeLessThan(-45);
    }
  });

  it('holds the SNR identity on every single frame (Rule 2 sign convention)', () => {
    for (const frame of frames) {
      const expected = Math.max(0, frame.rmsDbfs - frame.noiseFloorDbfs);
      expect(frame.estimatedSnrDb).toBeCloseTo(expected, 9);
      expect(frame.estimatedSnrDb).toBeGreaterThanOrEqual(0);
      expect(frame.rmsDbfs).toBeLessThan(0);
      expect(frame.noiseFloorDbfs).toBeLessThan(0);
    }
  });

  it('stamps the audio clock, not wall time (Rule 3)', () => {
    for (let i = 0; i < frames.length; i += 1) {
      expect((frames[i] as AudioFrameFeatures).audioTimeMs).toBe(i * FRAME_MS);
    }
  });
});

describe('FrameFeatureExtractor on non-speech', () => {
  it('reports white noise as unvoiced with no pitch', () => {
    const noise = whiteNoise(0.01, RATE * 2, makeRandom(5));
    const frames = runFrames(newExtractor(), noise).slice(25); // past priming
    const voicedFraction = frames.filter((f) => f.f0Hz !== null).length / frames.length;
    expect(voicedFraction).toBeLessThan(0.1);
    expect(mean(frames.map((f) => f.voicedProbability))).toBeLessThan(0.2);
    // Steady noise settles to ~0 dB SNR against its own floor.
    expect(mean(frames.map((f) => f.estimatedSnrDb))).toBeLessThan(4);
  });

  it('does not call periodic room tone voiced when it sits at the noise floor', () => {
    // A 100 Hz hum is perfectly periodic; only the energy gate stops it.
    const hum = voicedTone(100, 0.001, RATE, RATE * 2);
    const frames = runFrames(newExtractor(), hum).slice(30);
    expect(mean(frames.map((f) => f.voicedProbability))).toBeLessThan(0.2);
    expect(frames.filter((f) => f.f0Hz !== null).length / frames.length).toBeLessThan(0.1);
  });

  it('reports digital silence at the dBFS floor without NaN or -Infinity', () => {
    const frames = runFrames(newExtractor(), new Float32Array(RATE));
    for (const frame of frames) {
      expect(Number.isFinite(frame.rmsDbfs)).toBe(true);
      expect(Number.isFinite(frame.estimatedSnrDb)).toBe(true);
      expect(frame.rmsDbfs).toBe(-100);
      expect(frame.speechProbability).toBe(0);
    }
  });
});

describe('FrameFeatureExtractor and clipping', () => {
  it('surfaces clipped samples as a ratio and a ~0 dBFS peak', () => {
    const signal = voicedTone(150, 0.5, RATE, RATE);
    for (let i = 0; i < signal.length; i += 1) {
      const value = (signal[i] as number) * 4;
      signal[i] = Math.max(-1, Math.min(1, value));
    }
    const frames = runFrames(newExtractor(), signal).slice(5);
    expect(mean(frames.map((f) => f.clippingRatio))).toBeGreaterThan(0.05);
    expect(mean(frames.map((f) => f.peakDbfs))).toBeCloseTo(0, 1);
  });
});

describe('FrameFeatureExtractor and dropouts (§12.4)', () => {
  const signal = speechTimeline({
    sampleRate: RATE,
    durationMs: 2000,
    noiseRms: 0.002,
    segments: [{ startMs: 200, endMs: 1800, f0Hz: 200, rms: 0.08 }],
  });
  // Frames 50-59 (1000-1200 ms) never arrived.
  const dropped = new Set([50, 51, 52, 53, 54, 55, 56, 57, 58, 59]);
  const frames = runFrames(newExtractor(), signal, dropped);

  it('marks the dropout and emits no measurement that could read as silence', () => {
    for (const index of dropped) {
      const frame = frames[index] as AudioFrameFeatures;
      expect(frame.processorDropout).toBe(true);
      expect(frame.speechProbability).toBe(0);
      expect(frame.f0Hz).toBeNull();
      expect(frame.estimatedSnrDb).toBe(0);
    }
  });

  it('does not let the noise floor learn the dropout as a quiet room', () => {
    const before = (frames[49] as AudioFrameFeatures).noiseFloorDbfs;
    const after = (frames[62] as AudioFrameFeatures).noiseFloorDbfs;
    expect(after).toBeCloseTo(before, 3);
  });

  it('drops pitch history so no window straddles the gap', () => {
    // 45 ms of window has to refill before pitch can be reported again.
    expect((frames[60] as AudioFrameFeatures).f0Hz).toBeNull();
    // ...and it does come back once the window is full again.
    const resumed = frames.slice(64, 80).filter((f) => f.f0Hz !== null);
    expect(resumed.length).toBeGreaterThan(8);
    for (const frame of resumed) {
      expect(frame.f0Hz as number).toBeGreaterThan(194);
      expect(frame.f0Hz as number).toBeLessThan(206);
    }
  });
});

describe('FrameFeatureExtractor allocation discipline (§12.1)', () => {
  it('returns the same object every frame', () => {
    const extractor = newExtractor();
    const scratch = new Float32Array(FRAME);
    const first = extractor.process(scratch, 0);
    const second = extractor.process(scratch, 20);
    expect(second).toBe(first);
  });
});

function mean(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
