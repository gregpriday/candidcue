/**
 * §13.1–§13.2. YIN core.
 *
 * The synthesized signals have a known period by construction, so every
 * assertion here is on the *Hertz value* — a detector returning a constant, or
 * one whose lag→Hz conversion used the wrong sample rate (the decimated rate
 * is 8000 at 48 kHz but 7350 at 44.1 kHz, an 8.8 % error), fails these.
 */
import { describe, expect, it } from 'vitest';
import {
  PitchDecimator,
  PITCH_MAX_HZ,
  PITCH_MIN_HZ,
  YinDetector,
} from '../../../../src/shared/coaching/audio/pitch-yin';
import { makeRandom, sine, voicedTone, whiteNoise } from './signals';

const WINDOW_MS = 45;

/** Decimate a native-rate buffer exactly as the extractor does, then detect. */
function detectDecimated(
  signal: Float32Array,
  sampleRate: number,
): { f0Hz: number | null; periodicity: number; outputRate: number } {
  const decimator = new PitchDecimator(sampleRate);
  const out = new Float32Array(Math.ceil(signal.length / decimator.factor));
  const produced = decimator.process(signal, signal.length, out);
  const detector = new YinDetector({ sampleRate: decimator.outputRate });
  const result = detector.detect(out, produced);
  return { ...result, outputRate: decimator.outputRate };
}

function windowOf(f0Hz: number, sampleRate: number, rms = 0.1): Float32Array {
  const count = Math.round((WINDOW_MS / 1000) * sampleRate);
  return voicedTone(f0Hz, rms, sampleRate, count);
}

describe('YinDetector at the native rate', () => {
  it('finds 220 Hz in a 220 Hz sine', () => {
    const rate = 48_000;
    const detector = new YinDetector({ sampleRate: rate });
    const signal = sine(220, 0.5, rate, Math.round((WINDOW_MS / 1000) * rate));
    const result = detector.detect(signal);
    expect(result.f0Hz).not.toBeNull();
    expect(result.f0Hz as number).toBeCloseTo(220, 0); // within 0.5 Hz
    expect(result.periodicity).toBeGreaterThan(0.95);
  });

  it('finds the fundamental of a harmonic stack, not a harmonic of it', () => {
    const rate = 48_000;
    const detector = new YinDetector({ sampleRate: rate });
    const result = detector.detect(windowOf(120, rate));
    expect(result.f0Hz as number).toBeGreaterThan(118);
    expect(result.f0Hz as number).toBeLessThan(122);
  });
});

describe('YinDetector on the decimated pitch path', () => {
  it.each([
    [80, 48_000],
    [110, 48_000],
    [147, 48_000],
    [220, 48_000],
    [330, 48_000],
    [440, 48_000],
    [110, 44_100],
    [220, 44_100],
    [330, 44_100],
  ])('recovers %i Hz at %i Hz capture rate to within 2 %%', (f0Hz, rate) => {
    const result = detectDecimated(windowOf(f0Hz, rate), rate);
    expect(result.f0Hz).not.toBeNull();
    const error = Math.abs((result.f0Hz as number) - f0Hz) / f0Hz;
    expect(error).toBeLessThan(0.02);
  });

  it('uses the true decimated rate, not a hardcoded 8000 (44.1 kHz)', () => {
    const decimator = new PitchDecimator(44_100);
    expect(decimator.factor).toBe(6);
    expect(decimator.outputRate).toBeCloseTo(7350, 6);
    // 8000 vs 7350 would land a 220 Hz tone at 239 Hz; the 2 % assertions above
    // are what catch it, and this pins the cause.
    expect(new PitchDecimator(48_000).outputRate).toBe(8000);
  });

  it('covers the whole §13.2 search range at its edges', () => {
    for (const f0Hz of [PITCH_MIN_HZ + 2, PITCH_MAX_HZ - 20]) {
      const result = detectDecimated(windowOf(f0Hz, 48_000), 48_000);
      expect(result.f0Hz).not.toBeNull();
      expect(Math.abs((result.f0Hz as number) - f0Hz) / f0Hz).toBeLessThan(0.03);
    }
  });
});

describe('YinDetector rejects what is not pitched', () => {
  it('returns no pitch for white noise', () => {
    const rate = 48_000;
    const noise = whiteNoise(0.1, Math.round((WINDOW_MS / 1000) * rate), makeRandom(29));
    const result = detectDecimated(noise, rate);
    expect(result.periodicity).toBeLessThan(0.6);
    if (result.f0Hz !== null) {
      // Even a spurious lag must come with visibly poor periodicity.
      expect(result.periodicity).toBeLessThan(0.9);
    }
  });

  it('returns no pitch for digital silence', () => {
    const rate = 48_000;
    const silence = new Float32Array(Math.round((WINDOW_MS / 1000) * rate));
    const result = detectDecimated(silence, rate);
    expect(result.f0Hz).toBeNull();
  });

  it('refuses to guess from a buffer shorter than one search window', () => {
    const detector = new YinDetector({ sampleRate: 8000 });
    const short = new Float32Array(100);
    expect(detector.detect(short).f0Hz).toBeNull();
    expect(detector.minimumSampleCount).toBeGreaterThan(200);
  });
});

describe('PitchDecimator', () => {
  it('produces count/factor samples and preserves a low-frequency tone', () => {
    const rate = 48_000;
    const decimator = new PitchDecimator(rate);
    const input = sine(200, 0.5, rate, 4800); // 100 ms
    const out = new Float32Array(1000);
    const produced = decimator.process(input, input.length, out);
    expect(produced).toBe(800);

    // Measure RMS over the settled tail: a 200 Hz tone must survive intact.
    let sum = 0;
    for (let i = 400; i < 800; i += 1) sum += (out[i] as number) ** 2;
    expect(Math.sqrt(sum / 400)).toBeCloseTo(0.5 / Math.SQRT2, 1);
  });

  it('attenuates content above the decimated Nyquist instead of aliasing it', () => {
    const rate = 48_000;
    const decimator = new PitchDecimator(rate);
    const input = sine(6000, 0.5, rate, 4800); // 6 kHz: above 4 kHz Nyquist
    const out = new Float32Array(1000);
    decimator.process(input, input.length, out);
    let sum = 0;
    for (let i = 400; i < 800; i += 1) sum += (out[i] as number) ** 2;
    const rms = Math.sqrt(sum / 400);
    // Would fold back to 2 kHz at nearly full level without the anti-alias.
    expect(rms).toBeLessThan(0.05);
  });
});
