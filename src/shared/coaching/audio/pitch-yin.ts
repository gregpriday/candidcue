/**
 * §13.1–§13.2. YIN fundamental-frequency estimation.
 *
 * Textbook YIN (de Cheveigné & Kawahara 2002): squared-difference function,
 * cumulative mean normalisation, absolute threshold, parabolic interpolation.
 * Nothing here is speaker-specific and nothing here has a target value — §13.5
 * forbids gendered or absolute pitch targets, and this module could not
 * express one: it returns Hz and a periodicity, and never a judgement.
 *
 * **Cost.** Running YIN at the native 48 kHz over a 45 ms window would be
 * ~1.5 M operations per 10 ms hop — far too heavy for an audio render thread
 * (§12.1). The pitch path therefore runs on a decimated copy of the conditioned
 * signal at ≈8 kHz ({@link PitchDecimator}), which is ~35× cheaper and still
 * carries the whole 60–500 Hz search range with room to spare (8 kHz Nyquist is
 * 4 kHz; the shortest period searched is 16 samples, and parabolic
 * interpolation recovers the sub-sample resolution).
 *
 * All work arrays are allocated once in the constructor.
 */
import { Biquad } from './filters';

/** §13.2 initial F0 search range. Widened only with calibration evidence. */
export const PITCH_MIN_HZ = 60;
export const PITCH_MAX_HZ = 500;
/** §13.2 window and hop. */
export const PITCH_WINDOW_MS = 45;
export const PITCH_HOP_MS = 10;
/** Target rate for the decimated pitch signal. */
export const PITCH_ANALYSIS_RATE_HZ = 8000;

export interface YinOptions {
  /** Sample rate of the buffers passed to {@link YinDetector.detect}. */
  sampleRate: number;
  minF0Hz?: number;
  maxF0Hz?: number;
  /** §13.2 absolute threshold on the normalised difference. Default 0.15. */
  threshold?: number;
}

export interface YinResult {
  /** Estimated f0, or `null` when no period met the threshold. */
  f0Hz: number | null;
  /**
   * Periodicity, 0–1: `1 - d'(τ)` at the chosen lag. 1 is a perfect period,
   * ~0 is noise. This is the raw evidence behind both `f0Confidence` and
   * `voicedProbability` in {@link AudioFrameFeatures}.
   */
  periodicity: number;
}

export class YinDetector {
  readonly sampleRate: number;
  readonly minTau: number;
  readonly maxTau: number;
  private readonly threshold: number;
  private readonly difference: Float32Array;
  private readonly normalized: Float32Array;

  constructor(options: YinOptions) {
    this.sampleRate = options.sampleRate;
    this.threshold = options.threshold ?? 0.15;
    const maxF0 = options.maxF0Hz ?? PITCH_MAX_HZ;
    const minF0 = options.minF0Hz ?? PITCH_MIN_HZ;
    this.minTau = Math.max(2, Math.floor(this.sampleRate / maxF0));
    this.maxTau = Math.ceil(this.sampleRate / minF0);
    this.difference = new Float32Array(this.maxTau + 1);
    this.normalized = new Float32Array(this.maxTau + 1);
  }

  /** Shortest buffer `detect` can work with: one full period plus a window. */
  get minimumSampleCount(): number {
    return this.maxTau * 2;
  }

  /**
   * Estimate f0 over `buffer[0..count)`. Allocation-free; the result object is
   * the only allocation and callers on the render thread should read the two
   * numbers and drop it.
   */
  detect(buffer: Float32Array, count = buffer.length): YinResult {
    const window = count - this.maxTau;
    if (window < this.maxTau) return { f0Hz: null, periodicity: 0 };

    // Step 1-2: squared difference function.
    this.difference[0] = 0;
    for (let tau = 1; tau <= this.maxTau; tau += 1) {
      let sum = 0;
      for (let j = 0; j < window; j += 1) {
        const delta = (buffer[j] as number) - (buffer[j + tau] as number);
        sum += delta * delta;
      }
      this.difference[tau] = sum;
    }

    // Step 3: cumulative mean normalised difference.
    this.normalized[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= this.maxTau; tau += 1) {
      running += this.difference[tau] as number;
      this.normalized[tau] = running === 0 ? 1 : ((this.difference[tau] as number) * tau) / running;
    }

    // Step 4: absolute threshold — the *first* dip below it, not the deepest,
    // which is precisely what keeps YIN off the octave below.
    let bestTau = -1;
    for (let tau = this.minTau; tau <= this.maxTau; tau += 1) {
      if ((this.normalized[tau] as number) < this.threshold) {
        while (
          tau + 1 <= this.maxTau &&
          (this.normalized[tau + 1] as number) < (this.normalized[tau] as number)
        ) {
          tau += 1;
        }
        bestTau = tau;
        break;
      }
    }

    if (bestTau < 0) {
      // No lag met the threshold: report the best available periodicity so the
      // caller can see *how* unvoiced the frame was, but no pitch.
      let minimum = 1;
      for (let tau = this.minTau; tau <= this.maxTau; tau += 1) {
        const value = this.normalized[tau] as number;
        if (value < minimum) minimum = value;
      }
      return { f0Hz: null, periodicity: clampUnit(1 - minimum) };
    }

    // Step 5: parabolic interpolation around the chosen lag.
    const refinedTau = this.interpolate(bestTau);
    const periodicity = clampUnit(1 - (this.normalized[bestTau] as number));
    const f0Hz = this.sampleRate / refinedTau;
    return { f0Hz, periodicity };
  }

  private interpolate(tau: number): number {
    if (tau <= this.minTau || tau >= this.maxTau) return tau;
    const previous = this.normalized[tau - 1] as number;
    const current = this.normalized[tau] as number;
    const next = this.normalized[tau + 1] as number;
    const denominator = 2 * (2 * current - next - previous);
    if (denominator === 0) return tau;
    const shift = (next - previous) / denominator;
    // A parabola fitted to noise can point anywhere; a half-sample cap keeps
    // interpolation from inventing a lag that was never searched.
    if (!(shift > -0.5 && shift < 0.5)) return tau;
    return tau + shift;
  }
}

function clampUnit(value: number): number {
  if (!(value > 0)) return 0;
  return value > 1 ? 1 : value;
}

/**
 * Anti-aliased integer decimation to ≈{@link PITCH_ANALYSIS_RATE_HZ}.
 *
 * The factor is `round(sampleRate / 8000)`, so 48 kHz yields exactly 8 kHz and
 * 44.1 kHz yields 7350 Hz; both are reported through {@link outputRate}, and
 * everything downstream converts lags with that rate rather than assuming one.
 * Getting this wrong would scale every reported f0 by 8.8 % — a whole
 * semitone and a half — which is exactly the class of unit bug Rule 2 exists
 * to prevent, so the rate travels with the data.
 */
export class PitchDecimator {
  readonly factor: number;
  readonly outputRate: number;
  /** 4th-order Butterworth: one biquad leaves ~11 dB at 6 kHz, which aliases. */
  private readonly antiAliasA: Biquad;
  private readonly antiAliasB: Biquad;
  private phase = 0;

  constructor(sampleRate: number, targetRateHz = PITCH_ANALYSIS_RATE_HZ) {
    this.factor = Math.max(1, Math.round(sampleRate / targetRateHz));
    this.outputRate = sampleRate / this.factor;
    // Below the decimated Nyquist with margin; f0 lives two decades lower.
    const cutoff = Math.min(this.outputRate * 0.4, sampleRate * 0.45);
    this.antiAliasA = Biquad.lowPass(sampleRate, cutoff, 0.5412);
    this.antiAliasB = Biquad.lowPass(sampleRate, cutoff, 1.3066);
  }

  reset(): void {
    this.antiAliasA.reset();
    this.antiAliasB.reset();
    this.phase = 0;
  }

  /**
   * Filter and decimate `input[0..count)` into `out`, returning how many
   * samples were produced. `out` must have room for `ceil(count / factor)`.
   */
  process(input: Float32Array, count: number, out: Float32Array): number {
    let produced = 0;
    for (let i = 0; i < count; i += 1) {
      const filtered = this.antiAliasB.processSample(
        this.antiAliasA.processSample(input[i] as number),
      );
      if (this.phase === 0) {
        if (produced < out.length) out[produced] = filtered;
        produced += 1;
      }
      this.phase += 1;
      if (this.phase === this.factor) this.phase = 0;
    }
    return Math.min(produced, out.length);
  }
}
