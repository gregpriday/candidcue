/**
 * §12.4. Per-frame acoustic features, and the extractor that assembles a
 * complete {@link AudioFrameFeatures} for one 20 ms analysis frame.
 *
 * Sign conventions are the contract's (`shared/contracts/coaching.ts`, Rule 2)
 * and are load-bearing here:
 * - `rmsDbfs`, `peakDbfs`, `noiseFloorDbfs` are dB relative to full scale and
 *   therefore **negative**, floored at {@link DBFS_FLOOR} for digital silence.
 * - `estimatedSnrDb` is a **positive** difference, and satisfies the exact
 *   invariant `estimatedSnrDb === max(0, rmsDbfs - noiseFloorDbfs)` — the
 *   emitted `noiseFloorDbfs` is the floor that was used for this frame's SNR,
 *   before the frame's own contribution is folded in.
 *
 * The pure functions take a frame and return a number; they hold no state and
 * allocate nothing. {@link FrameFeatureExtractor} holds the state that spans
 * frames (noise floor, previous spectrum, pitch history) and writes into a
 * single reused features object, because §12.1 forbids per-frame allocation.
 */
import type { AudioFrameFeatures } from '../../contracts/coaching';
import { RealFft } from './fft';
import { NoiseFloorEstimator, type NoiseFloorOptions } from './noise-estimator';
import {
  PitchDecimator,
  PITCH_HOP_MS,
  PITCH_WINDOW_MS,
  YinDetector,
  type YinResult,
} from './pitch-yin';

/** dBFS reported for digital silence. Everything is clamped at or above this. */
export const DBFS_FLOOR = -100;
/** Amplitude corresponding to {@link DBFS_FLOOR}. */
const AMPLITUDE_FLOOR = 1e-5;
/** |sample| at or above this counts as clipped (§12.7.1). */
export const CLIP_AMPLITUDE = 0.999;

/** Convert a linear amplitude (0–1) to dBFS, floored rather than `-Infinity`. */
export function amplitudeToDbfs(amplitude: number): number {
  const magnitude = Math.abs(amplitude);
  if (!(magnitude > AMPLITUDE_FLOOR)) return DBFS_FLOOR;
  return 20 * Math.log10(magnitude);
}

/** Frame RMS in dBFS (negative). A full-scale sine is ≈ -3.01. */
export function frameRmsDbfs(frame: Float32Array, count = frame.length): number {
  if (count <= 0) return DBFS_FLOOR;
  let sum = 0;
  for (let i = 0; i < count; i += 1) {
    const sample = frame[i] as number;
    sum += sample * sample;
  }
  return amplitudeToDbfs(Math.sqrt(sum / count));
}

/** Frame peak in dBFS (negative; ≈ 0 at full scale). */
export function framePeakDbfs(frame: Float32Array, count = frame.length): number {
  let peak = 0;
  for (let i = 0; i < count; i += 1) {
    const magnitude = Math.abs(frame[i] as number);
    if (magnitude > peak) peak = magnitude;
  }
  return amplitudeToDbfs(peak);
}

/** Fraction of samples at or beyond full scale, 0–1 (§12.4). */
export function frameClippingRatio(frame: Float32Array, count = frame.length): number {
  if (count <= 0) return 0;
  let clipped = 0;
  for (let i = 0; i < count; i += 1) {
    if (Math.abs(frame[i] as number) >= CLIP_AMPLITUDE) clipped += 1;
  }
  return clipped / count;
}

/**
 * Zero crossings per sample, 0–1. A sine at `f` in a stream at `rate` yields
 * `2f / rate`, which is what the unit test asserts.
 */
export function frameZeroCrossingRate(frame: Float32Array, count = frame.length): number {
  if (count < 2) return 0;
  let crossings = 0;
  let previous = frame[0] as number;
  for (let i = 1; i < count; i += 1) {
    const sample = frame[i] as number;
    if ((sample >= 0 && previous < 0) || (sample < 0 && previous >= 0)) crossings += 1;
    previous = sample;
  }
  return crossings / count;
}

/**
 * §12.4 `spectralFlux`: half-wave-rectified magnitude increase against the
 * previous frame, averaged over bins. Unitless and implementation-relative —
 * used only for onset detection, never displayed.
 */
export class SpectralFluxAnalyzer {
  private readonly previous: Float32Array;
  private primed = false;

  constructor(private readonly fft: { binCount: number; analyse(input: Float32Array, count?: number): Float32Array }) {
    this.previous = new Float32Array(fft.binCount);
  }

  reset(): void {
    this.previous.fill(0);
    this.primed = false;
  }

  /** Returns the flux for this frame; 0 for the first frame after a reset. */
  process(frame: Float32Array, count = frame.length): number {
    const magnitudes = this.fft.analyse(frame, count);
    let flux = 0;
    for (let bin = 0; bin < magnitudes.length; bin += 1) {
      const magnitude = magnitudes[bin] as number;
      const delta = magnitude - (this.previous[bin] as number);
      if (delta > 0) flux += delta;
      this.previous[bin] = magnitude;
    }
    if (!this.primed) {
      this.primed = true;
      return 0;
    }
    return flux / magnitudes.length;
  }
}

/**
 * §12.5. Frame speech likelihood, 0–1.
 *
 * Deliberately a smooth ramp over SNR rather than a hard threshold: the VAD
 * (`vad.ts`) owns the decision and its hysteresis, and a probability that
 * saturates at 0 or 1 would hide the margin the VAD needs. Voicing raises the
 * floor so a periodic-but-quiet syllable is not discarded, but energy alone is
 * enough — an unvoiced fricative is still speech.
 */
export function speechProbabilityFromSnr(snrDb: number, voicedProbability: number): number {
  const SNR_LOW_DB = 3;
  const SNR_HIGH_DB = 12;
  const energyScore = clamp01((snrDb - SNR_LOW_DB) / (SNR_HIGH_DB - SNR_LOW_DB));
  return clamp01(0.7 * energyScore + 0.3 * voicedProbability * energyScore + 0.15 * voicedProbability);
}

export function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

// ---------------------------------------------------------------------------
// The extractor
// ---------------------------------------------------------------------------

export interface FrameFeatureOptions {
  /** Native capture rate (§12.2): whatever the device gives us, 44.1 or 48 kHz. */
  sampleRate: number;
  /** §12.2 analysis frame. Default 20 ms. */
  frameMs?: number;
  /** §13.2 pitch window. Default 45 ms. */
  pitchWindowMs?: number;
  /** §13.2 pitch hop. Default 10 ms. */
  pitchHopMs?: number;
  minF0Hz?: number;
  maxF0Hz?: number;
  noise?: Omit<NoiseFloorOptions, 'frameMs'>;
  /**
   * A frame this close to the noise floor cannot be called voiced no matter how
   * periodic it looks: room tone from a fan is extremely periodic.
   */
  voicingSnrFloorDb?: number;
}

/**
 * §12.4. Assembles one complete {@link AudioFrameFeatures} per analysis frame.
 *
 * **The returned object is reused.** Consumers must read or pack it before the
 * next `process()` call; §12.1 forbids allocating one per frame, and the
 * worklet packs it into a transfer buffer immediately.
 *
 * Ordering inside a frame matters and is deliberate:
 *  1. level/spectral features (no dependencies);
 *  2. pitch, on the decimated path, at 10 ms hops;
 *  3. the noise floor, told whether to learn using the *previous* frame's
 *     speech decision plus this frame's periodicity — a 20 ms lag, in exchange
 *     for breaking the "SNR needs the floor, the floor needs the speech
 *     decision, the speech decision needs SNR" cycle in the safe direction
 *     (when in doubt, do not learn — §12.5);
 *  4. SNR, voicing and speech probability against the floor that was just
 *     reported, so `estimatedSnrDb === max(0, rmsDbfs - noiseFloorDbfs)` holds
 *     exactly for every emitted frame.
 */
export class FrameFeatureExtractor {
  readonly sampleRate: number;
  readonly frameMs: number;
  readonly frameSamples: number;
  /** Decimated rate the pitch estimator actually runs at (8000 at 48 kHz). */
  readonly pitchRate: number;

  private readonly flux: SpectralFluxAnalyzer;
  private readonly noise: NoiseFloorEstimator;
  private readonly decimator: PitchDecimator;
  private readonly yin: YinDetector;
  private readonly voicingSnrFloorDb: number;

  private readonly decimatedScratch: Float32Array;
  private readonly pitchWindow: Float32Array;
  private readonly pitchRing: Float32Array;
  private pitchRingWrite = 0;
  private pitchRingFilled = 0;
  private samplesSinceHop = 0;
  private readonly pitchWindowSamples: number;
  private readonly pitchHopSamples: number;

  private previousSpeechProbability = 0;
  private readonly features: AudioFrameFeatures;

  constructor(options: FrameFeatureOptions) {
    this.sampleRate = options.sampleRate;
    this.frameMs = options.frameMs ?? 20;
    this.frameSamples = Math.round((this.frameMs / 1000) * this.sampleRate);
    this.voicingSnrFloorDb = options.voicingSnrFloorDb ?? 4;

    this.flux = new SpectralFluxAnalyzer(new RealFft(nextPowerOfTwo(this.frameSamples)));
    this.noise = new NoiseFloorEstimator({ frameMs: this.frameMs, ...(options.noise ?? {}) });

    this.decimator = new PitchDecimator(this.sampleRate);
    this.pitchRate = this.decimator.outputRate;
    this.yin = new YinDetector({
      sampleRate: this.pitchRate,
      ...(options.minF0Hz === undefined ? {} : { minF0Hz: options.minF0Hz }),
      ...(options.maxF0Hz === undefined ? {} : { maxF0Hz: options.maxF0Hz }),
    });

    this.pitchWindowSamples = Math.max(
      Math.round((((options.pitchWindowMs ?? PITCH_WINDOW_MS) / 1000) * this.pitchRate)),
      this.yin.minimumSampleCount,
    );
    this.pitchHopSamples = Math.max(
      1,
      Math.round((((options.pitchHopMs ?? PITCH_HOP_MS) / 1000) * this.pitchRate)),
    );
    this.decimatedScratch = new Float32Array(Math.ceil(this.frameSamples / this.decimator.factor) + 2);
    this.pitchWindow = new Float32Array(this.pitchWindowSamples);
    this.pitchRing = new Float32Array(this.pitchWindowSamples);

    this.features = {
      audioTimeMs: 0,
      rmsDbfs: DBFS_FLOOR,
      peakDbfs: DBFS_FLOOR,
      clippingRatio: 0,
      noiseFloorDbfs: DBFS_FLOOR,
      estimatedSnrDb: 0,
      speechProbability: 0,
      voicedProbability: 0,
      f0Hz: null,
      f0Confidence: 0,
      spectralFlux: 0,
      zeroCrossingRate: 0,
      processorDropout: false,
    };
  }

  get noiseFloorDbfs(): number {
    return this.noise.valueDbfs;
  }

  reset(): void {
    this.flux.reset();
    this.noise.reset();
    this.resetPitchState();
    this.previousSpeechProbability = 0;
  }

  /**
   * Analyse one conditioned mono frame.
   *
   * `dropout` marks an interval the worklet never received (§12.4): no feature
   * is invented for it, the noise floor does not learn from it, and the pitch
   * history is dropped so no YIN window can straddle the gap and report a
   * period that never existed.
   */
  process(frame: Float32Array, audioTimeMs: number, dropout = false): AudioFrameFeatures {
    const out = this.features;
    out.audioTimeMs = audioTimeMs;
    out.processorDropout = dropout;

    if (dropout) {
      this.resetPitchState();
      this.flux.reset();
      out.rmsDbfs = DBFS_FLOOR;
      out.peakDbfs = DBFS_FLOOR;
      out.clippingRatio = 0;
      out.zeroCrossingRate = 0;
      out.spectralFlux = 0;
      out.noiseFloorDbfs = this.noise.valueDbfs;
      out.estimatedSnrDb = 0;
      out.speechProbability = 0;
      out.voicedProbability = 0;
      out.f0Hz = null;
      out.f0Confidence = 0;
      this.previousSpeechProbability = 0;
      return out;
    }

    const count = Math.min(frame.length, this.frameSamples);
    out.rmsDbfs = frameRmsDbfs(frame, count);
    out.peakDbfs = framePeakDbfs(frame, count);
    out.clippingRatio = frameClippingRatio(frame, count);
    out.zeroCrossingRate = frameZeroCrossingRate(frame, count);
    out.spectralFlux = this.flux.process(frame, count);

    const pitch = this.trackPitch(frame, count);

    // Step 3: decide whether the noise floor may learn from this frame.
    const provisionalSnr = NoiseFloorEstimator.snrDb(out.rmsDbfs, this.noise.valueDbfs);
    // While unprimed the estimator must learn from *something*: the floor
    // starts at -100 dBFS, which makes every frame look 60 dB above the room,
    // which would mark every frame as speech, which would leave the floor at
    // -100 forever. Priming is min-tracking, so a take that begins mid-sentence
    // primes high and then falls to the real room within a second of the first
    // pause — the recoverable direction. Refusing to prime is not recoverable.
    const looksLikeSpeech =
      this.noise.primed &&
      (this.previousSpeechProbability >= 0.5 || pitch.periodicity >= 0.6 || provisionalSnr > 6);
    const floorForFrame = this.noise.update(out.rmsDbfs, looksLikeSpeech);

    out.noiseFloorDbfs = floorForFrame;
    out.estimatedSnrDb = NoiseFloorEstimator.snrDb(out.rmsDbfs, floorForFrame);

    const energyGate = clamp01((out.estimatedSnrDb - this.voicingSnrFloorDb) / 4);
    const periodicityScore = clamp01((pitch.periodicity - 0.35) / 0.5);
    out.voicedProbability = periodicityScore * energyGate;
    out.f0Confidence = pitch.periodicity;
    out.f0Hz = out.voicedProbability >= 0.5 ? pitch.f0Hz : null;
    out.speechProbability = speechProbabilityFromSnr(out.estimatedSnrDb, out.voicedProbability);
    this.previousSpeechProbability = out.speechProbability;
    return out;
  }

  /**
   * Feed the frame into the decimated pitch path and run every 10 ms hop that
   * became available. The frame reports the *most periodic* hop it covers:
   * a 20 ms frame spans two hops, and taking the more confident of the two is
   * what keeps a hop straddling a voice onset from reporting the frame unvoiced.
   */
  private trackPitch(frame: Float32Array, count: number): YinResult {
    const produced = this.decimator.process(frame, count, this.decimatedScratch);
    let best: YinResult = { f0Hz: null, periodicity: 0 };

    for (let i = 0; i < produced; i += 1) {
      this.pitchRing[this.pitchRingWrite] = this.decimatedScratch[i] as number;
      this.pitchRingWrite += 1;
      if (this.pitchRingWrite === this.pitchWindowSamples) this.pitchRingWrite = 0;
      if (this.pitchRingFilled < this.pitchWindowSamples) this.pitchRingFilled += 1;
      this.samplesSinceHop += 1;

      if (this.samplesSinceHop >= this.pitchHopSamples) {
        this.samplesSinceHop = 0;
        if (this.pitchRingFilled < this.pitchWindowSamples) continue;
        // Unwrap the ring into the contiguous window YIN needs.
        let read = this.pitchRingWrite;
        for (let j = 0; j < this.pitchWindowSamples; j += 1) {
          this.pitchWindow[j] = this.pitchRing[read] as number;
          read += 1;
          if (read === this.pitchWindowSamples) read = 0;
        }
        const result = this.yin.detect(this.pitchWindow, this.pitchWindowSamples);
        if (result.periodicity > best.periodicity) best = result;
      }
    }
    return best;
  }

  private resetPitchState(): void {
    this.decimator.reset();
    this.pitchRing.fill(0);
    this.pitchRingWrite = 0;
    this.pitchRingFilled = 0;
    this.samplesSinceHop = 0;
  }
}

function nextPowerOfTwo(value: number): number {
  let size = 2;
  while (size < value) size <<= 1;
  return size;
}

// ---------------------------------------------------------------------------
// Frame packing (worklet → analyzer transfer)
// ---------------------------------------------------------------------------

/** Number of `Float64` slots one packed frame occupies. */
export const PACKED_FRAME_FIELDS = 13;

/**
 * Write one frame into a preallocated Float64Array at `offset`.
 *
 * The worklet posts *packed* frames rather than objects so the transfer costs
 * one preallocated buffer per aggregation window instead of one object per
 * 20 ms (§12.1: no per-frame allocation). `f0Hz === null` is encoded as `NaN`,
 * which is the only value the field can never legitimately take.
 */
export function packFrame(out: Float64Array, offset: number, frame: AudioFrameFeatures): void {
  out[offset] = frame.audioTimeMs;
  out[offset + 1] = frame.rmsDbfs;
  out[offset + 2] = frame.peakDbfs;
  out[offset + 3] = frame.clippingRatio;
  out[offset + 4] = frame.noiseFloorDbfs;
  out[offset + 5] = frame.estimatedSnrDb;
  out[offset + 6] = frame.speechProbability;
  out[offset + 7] = frame.voicedProbability;
  out[offset + 8] = frame.f0Hz === null ? Number.NaN : frame.f0Hz;
  out[offset + 9] = frame.f0Confidence;
  out[offset + 10] = frame.spectralFlux;
  out[offset + 11] = frame.zeroCrossingRate;
  out[offset + 12] = frame.processorDropout ? 1 : 0;
}

/** Inverse of {@link packFrame}. Allocates — analyzer side only. */
export function unpackFrame(source: Float64Array, offset: number): AudioFrameFeatures {
  const f0 = source[offset + 8] as number;
  return {
    audioTimeMs: source[offset] as number,
    rmsDbfs: source[offset + 1] as number,
    peakDbfs: source[offset + 2] as number,
    clippingRatio: source[offset + 3] as number,
    noiseFloorDbfs: source[offset + 4] as number,
    estimatedSnrDb: source[offset + 5] as number,
    speechProbability: source[offset + 6] as number,
    voicedProbability: source[offset + 7] as number,
    f0Hz: Number.isNaN(f0) ? null : f0,
    f0Confidence: source[offset + 9] as number,
    spectralFlux: source[offset + 10] as number,
    zeroCrossingRate: source[offset + 11] as number,
    processorDropout: (source[offset + 12] as number) !== 0,
  };
}
