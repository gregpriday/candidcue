/**
 * §12.3 signal conditioning primitives: DC removal and a gentle high-pass.
 *
 * Not in the §28 module list — these are the shared filter kernels used by the
 * worklet's conditioning stage and by the pitch path's anti-alias stage, and
 * duplicating them in both would be worse.
 *
 * **§12.3 boundary:** everything here filters the *analysis copy only*. The
 * `MediaStreamTrack` fanned out to the OpenAI peer connection (§5.3) is never
 * routed through these; an AudioWorkletNode that is not connected to a
 * destination cannot alter the track it observes.
 *
 * All state is scalar and preallocated: no allocation per sample or per frame.
 */

/** One direct-form-II transposed biquad section. */
export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private z1 = 0;
  private z2 = 0;

  static highPass(sampleRate: number, cutoffHz: number, q = Math.SQRT1_2): Biquad {
    const filter = new Biquad();
    filter.designHighPass(sampleRate, cutoffHz, q);
    return filter;
  }

  static lowPass(sampleRate: number, cutoffHz: number, q = Math.SQRT1_2): Biquad {
    const filter = new Biquad();
    filter.designLowPass(sampleRate, cutoffHz, q);
    return filter;
  }

  designHighPass(sampleRate: number, cutoffHz: number, q = Math.SQRT1_2): void {
    const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
    const cosW0 = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = ((1 + cosW0) / 2) / a0;
    this.b1 = (-(1 + cosW0)) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cosW0) / a0;
    this.a2 = (1 - alpha) / a0;
    this.reset();
  }

  designLowPass(sampleRate: number, cutoffHz: number, q = Math.SQRT1_2): void {
    const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
    const cosW0 = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = ((1 - cosW0) / 2) / a0;
    this.b1 = (1 - cosW0) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cosW0) / a0;
    this.a2 = (1 - alpha) / a0;
    this.reset();
  }

  reset(): void {
    this.z1 = 0;
    this.z2 = 0;
  }

  processSample(input: number): number {
    const output = this.b0 * input + this.z1;
    this.z1 = this.b1 * input - this.a1 * output + this.z2;
    this.z2 = this.b2 * input - this.a2 * output;
    return output;
  }

  /** Filter in place. Allocation-free. */
  process(buffer: Float32Array, count = buffer.length): void {
    for (let i = 0; i < count; i += 1) {
      buffer[i] = this.processSample(buffer[i] as number);
    }
  }
}

/**
 * First-order DC blocker, `y[n] = x[n] - x[n-1] + R·y[n-1]`.
 *
 * Runs ahead of the high-pass because a large DC offset (some USB interfaces
 * ship one) biases RMS, peak and every zero-crossing count — and a biased
 * zero-crossing rate makes an unvoiced frame look voiced.
 */
export class DcBlocker {
  private readonly r: number;
  private lastInput = 0;
  private lastOutput = 0;

  constructor(sampleRate: number, cutoffHz = 15) {
    this.r = Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
  }

  reset(): void {
    this.lastInput = 0;
    this.lastOutput = 0;
  }

  processSample(input: number): number {
    const output = input - this.lastInput + this.r * this.lastOutput;
    this.lastInput = input;
    this.lastOutput = output;
    return output;
  }

  process(buffer: Float32Array, count = buffer.length): void {
    for (let i = 0; i < count; i += 1) {
      buffer[i] = this.processSample(buffer[i] as number);
    }
  }
}
