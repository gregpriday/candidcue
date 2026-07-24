/**
 * §12.4 pure frame features.
 *
 * Each assertion pins a value that is derivable on paper from the synthesized
 * signal — a full-scale sine is -3.01 dBFS RMS, a 1 kHz sine at 48 kHz crosses
 * zero 2000 times a second — so a stubbed or constant implementation fails.
 */
import { describe, expect, it } from 'vitest';
import {
  amplitudeToDbfs,
  clamp01,
  DBFS_FLOOR,
  frameClippingRatio,
  framePeakDbfs,
  frameRmsDbfs,
  frameZeroCrossingRate,
  packFrame,
  PACKED_FRAME_FIELDS,
  speechProbabilityFromSnr,
  SpectralFluxAnalyzer,
  unpackFrame,
} from '../../../../src/shared/coaching/audio/frame-features';
import { RealFft } from '../../../../src/shared/coaching/audio/fft';
import { makeRandom, sine, whiteNoise } from './signals';
import type { AudioFrameFeatures } from '../../../../src/shared/contracts/coaching';

const RATE = 48_000;
const FRAME = 960; // 20 ms

describe('level features (§12.4)', () => {
  it('reports a full-scale sine at the textbook -3.01 dBFS RMS and 0 dBFS peak', () => {
    const frame = sine(1000, 1, RATE, FRAME);
    expect(frameRmsDbfs(frame)).toBeCloseTo(-3.01, 1);
    expect(framePeakDbfs(frame)).toBeCloseTo(0, 1);
  });

  it('reports white noise at exactly the RMS it was synthesized with', () => {
    const frame = whiteNoise(0.01, FRAME, makeRandom(3)); // 0.01 => -40 dBFS
    expect(frameRmsDbfs(frame)).toBeCloseTo(-40, 1);
  });

  it('halving amplitude costs exactly 6 dB', () => {
    const loud = sine(300, 0.5, RATE, FRAME);
    const quiet = sine(300, 0.25, RATE, FRAME);
    expect(frameRmsDbfs(loud) - frameRmsDbfs(quiet)).toBeCloseTo(6.02, 1);
  });

  it('floors digital silence rather than returning -Infinity', () => {
    const frame = new Float32Array(FRAME);
    expect(frameRmsDbfs(frame)).toBe(DBFS_FLOOR);
    expect(framePeakDbfs(frame)).toBe(DBFS_FLOOR);
    expect(amplitudeToDbfs(0)).toBe(DBFS_FLOOR);
  });

  it('keeps dBFS negative for every level below full scale (Rule 2 sign convention)', () => {
    for (const amplitude of [0.001, 0.01, 0.1, 0.5, 0.9]) {
      expect(frameRmsDbfs(sine(200, amplitude, RATE, FRAME))).toBeLessThan(0);
    }
  });
});

describe('clipping ratio (§12.4)', () => {
  it('is zero for an unclipped signal', () => {
    expect(frameClippingRatio(sine(440, 0.9, RATE, FRAME))).toBe(0);
  });

  it('counts exactly the samples at or beyond full scale', () => {
    const frame = sine(440, 0.5, RATE, FRAME);
    frame[10] = 1;
    frame[11] = -1.4;
    frame[12] = 0.9995;
    expect(frameClippingRatio(frame)).toBeCloseTo(3 / FRAME, 8);
  });

  it('reaches 1 for a fully saturated frame', () => {
    const frame = new Float32Array(FRAME).fill(1);
    expect(frameClippingRatio(frame)).toBe(1);
  });
});

describe('zero-crossing rate (§12.4)', () => {
  it('matches 2f/rate for a sine, to within the one frame-boundary crossing', () => {
    // A 20 ms frame of a 1 kHz sine contains 20 periods = 40 crossings; whether
    // the crossing sitting exactly on the frame edge is counted is a ±1 detail,
    // so the assertion is on the crossing *count*, tight to one crossing.
    expect(frameZeroCrossingRate(sine(1000, 0.5, RATE, FRAME)) * FRAME).toBeGreaterThanOrEqual(39);
    expect(frameZeroCrossingRate(sine(1000, 0.5, RATE, FRAME)) * FRAME).toBeLessThanOrEqual(41);
    // 200 Hz: 4 periods = 8 crossings.
    expect(frameZeroCrossingRate(sine(200, 0.5, RATE, FRAME)) * FRAME).toBeGreaterThanOrEqual(7);
    expect(frameZeroCrossingRate(sine(200, 0.5, RATE, FRAME)) * FRAME).toBeLessThanOrEqual(9);
  });

  it('is far higher for noise than for a low-frequency tone', () => {
    const noiseZcr = frameZeroCrossingRate(whiteNoise(0.1, FRAME, makeRandom(11)));
    const toneZcr = frameZeroCrossingRate(sine(120, 0.1, RATE, FRAME));
    expect(noiseZcr).toBeGreaterThan(toneZcr * 10);
  });
});

describe('spectral flux (§12.4)', () => {
  const fft = new RealFft(1024);

  it('is ~0 for a steady tone and large at an onset', () => {
    const analyzer = new SpectralFluxAnalyzer(fft);
    // Prime on silence, then hold a steady tone.
    analyzer.process(new Float32Array(FRAME));
    const onset = analyzer.process(sine(440, 0.5, RATE, FRAME, 0));
    const steadyA = analyzer.process(sine(440, 0.5, RATE, FRAME, FRAME));
    const steadyB = analyzer.process(sine(440, 0.5, RATE, FRAME, FRAME * 2));

    expect(onset).toBeGreaterThan(0);
    expect(steadyA).toBeLessThan(onset / 5);
    expect(steadyB).toBeLessThan(onset / 5);
  });

  it('ignores an offset (level drop) because it is half-wave rectified', () => {
    const analyzer = new SpectralFluxAnalyzer(fft);
    analyzer.process(sine(440, 0.5, RATE, FRAME));
    analyzer.process(sine(440, 0.5, RATE, FRAME, FRAME));
    const decay = analyzer.process(new Float32Array(FRAME));
    expect(decay).toBeCloseTo(0, 6);
  });

  it('returns 0 on the first frame after reset rather than a phantom onset', () => {
    const analyzer = new SpectralFluxAnalyzer(fft);
    expect(analyzer.process(sine(440, 0.9, RATE, FRAME))).toBe(0);
    analyzer.reset();
    expect(analyzer.process(sine(440, 0.9, RATE, FRAME))).toBe(0);
  });
});

describe('FFT', () => {
  it('places a tone in the bin its frequency belongs to', () => {
    const fft = new RealFft(1024);
    const magnitudes = fft.analyse(sine(3000, 0.5, RATE, FRAME), FRAME);
    let peakBin = 0;
    for (let bin = 1; bin < magnitudes.length; bin += 1) {
      if ((magnitudes[bin] as number) > (magnitudes[peakBin] as number)) peakBin = bin;
    }
    // Bin width is rate / size = 46.875 Hz; 3000 Hz sits at bin 64.
    expect(peakBin).toBe(64);
  });
});

describe('speech probability (§12.5)', () => {
  it('rises monotonically with SNR and stays inside 0–1', () => {
    const values = [-10, 0, 3, 6, 9, 12, 30].map((snr) => speechProbabilityFromSnr(snr, 0));
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i] as number).toBeGreaterThanOrEqual(values[i - 1] as number);
      expect(values[i] as number).toBeGreaterThanOrEqual(0);
      expect(values[i] as number).toBeLessThanOrEqual(1);
    }
    expect(speechProbabilityFromSnr(0, 0)).toBe(0);
    expect(speechProbabilityFromSnr(30, 1)).toBeGreaterThan(0.9);
  });

  it('treats an unvoiced but loud frame as speech (fricatives are speech)', () => {
    expect(speechProbabilityFromSnr(20, 0)).toBeGreaterThan(0.6);
  });

  it('clamps', () => {
    expect(clamp01(-2)).toBe(0);
    expect(clamp01(3)).toBe(1);
    expect(clamp01(0.25)).toBe(0.25);
  });
});

describe('frame packing', () => {
  const frame: AudioFrameFeatures = {
    audioTimeMs: 1234.5,
    rmsDbfs: -21.5,
    peakDbfs: -8.25,
    clippingRatio: 0.125,
    noiseFloorDbfs: -52.5,
    estimatedSnrDb: 31,
    speechProbability: 0.875,
    voicedProbability: 0.5,
    f0Hz: 187.25,
    f0Confidence: 0.75,
    spectralFlux: 0.003_25,
    zeroCrossingRate: 0.0625,
    processorDropout: false,
  };

  it('round-trips every field exactly', () => {
    const packed = new Float64Array(PACKED_FRAME_FIELDS);
    packFrame(packed, 0, frame);
    expect(unpackFrame(packed, 0)).toEqual(frame);
  });

  it('round-trips a null f0 and a dropout flag', () => {
    const packed = new Float64Array(PACKED_FRAME_FIELDS * 2);
    packFrame(packed, PACKED_FRAME_FIELDS, { ...frame, f0Hz: null, processorDropout: true });
    const decoded = unpackFrame(packed, PACKED_FRAME_FIELDS);
    expect(decoded.f0Hz).toBeNull();
    expect(decoded.processorDropout).toBe(true);
    expect(decoded.audioTimeMs).toBe(1234.5);
  });
});
