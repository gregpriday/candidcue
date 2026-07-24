/**
 * Minimal radix-2 FFT, allocation-free after construction.
 *
 * Not in the §28 module list; it exists because §12.4 requires a spectral-flux
 * feature and the worklet may not allocate per frame (§12.1). Everything it
 * needs — twiddles, bit-reversal permutation, the real/imaginary work arrays
 * and the magnitude output — is allocated once in the constructor and reused.
 *
 * Used only for onset/flux analysis; nothing here is user-visible.
 */
export class RealFft {
  readonly size: number;
  /** Number of usable magnitude bins, `size / 2 + 1`. */
  readonly binCount: number;

  private readonly re: Float32Array;
  private readonly im: Float32Array;
  private readonly cos: Float32Array;
  private readonly sin: Float32Array;
  private readonly reverse: Uint32Array;
  private readonly window: Float32Array;
  private readonly magnitudes: Float32Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`RealFft: size must be a power of two, received ${size}`);
    }
    this.size = size;
    this.binCount = size / 2 + 1;
    this.re = new Float32Array(size);
    this.im = new Float32Array(size);
    this.cos = new Float32Array(size / 2);
    this.sin = new Float32Array(size / 2);
    this.reverse = new Uint32Array(size);
    this.window = new Float32Array(size);
    this.magnitudes = new Float32Array(this.binCount);

    for (let i = 0; i < size / 2; i += 1) {
      const angle = (-2 * Math.PI * i) / size;
      this.cos[i] = Math.cos(angle);
      this.sin[i] = Math.sin(angle);
    }
    const bits = Math.log2(size);
    for (let i = 0; i < size; i += 1) {
      let reversed = 0;
      for (let bit = 0; bit < bits; bit += 1) {
        reversed = (reversed << 1) | ((i >>> bit) & 1);
      }
      this.reverse[i] = reversed;
    }
    // Periodic Hann. Zero-padding beyond `count` is handled in `analyse`.
    for (let i = 0; i < size; i += 1) {
      this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
    }
  }

  /**
   * Window, zero-pad and transform `input[0..count)`, returning the internal
   * magnitude array. The array is reused on every call: read it or copy it
   * before the next `analyse`.
   *
   * Magnitudes are normalised by `count` so they are comparable across frame
   * sizes and independent of FFT length.
   */
  analyse(input: Float32Array, count = input.length): Float32Array {
    const n = this.size;
    const usable = Math.min(count, n);
    // The Hann window is defined over the *signal*, not the zero padding.
    const windowScale = n / Math.max(usable, 1);
    for (let i = 0; i < usable; i += 1) {
      const phase = i * windowScale;
      const index = phase >= n ? n - 1 : phase | 0;
      this.re[this.reverse[i] as number] = (input[i] as number) * (this.window[index] as number);
    }
    for (let i = usable; i < n; i += 1) {
      this.re[this.reverse[i] as number] = 0;
    }
    this.im.fill(0);

    for (let span = 2; span <= n; span <<= 1) {
      const half = span >> 1;
      const step = n / span;
      for (let start = 0; start < n; start += span) {
        for (let k = 0; k < half; k += 1) {
          const twiddle = k * step;
          const wr = this.cos[twiddle] as number;
          const wi = this.sin[twiddle] as number;
          const a = start + k;
          const b = a + half;
          const br = this.re[b] as number;
          const bi = this.im[b] as number;
          const tr = br * wr - bi * wi;
          const ti = br * wi + bi * wr;
          this.re[b] = (this.re[a] as number) - tr;
          this.im[b] = (this.im[a] as number) - ti;
          this.re[a] = (this.re[a] as number) + tr;
          this.im[a] = (this.im[a] as number) + ti;
        }
      }
    }

    const norm = 2 / Math.max(usable, 1);
    for (let bin = 0; bin < this.binCount; bin += 1) {
      const r = this.re[bin] as number;
      const i = this.im[bin] as number;
      this.magnitudes[bin] = Math.sqrt(r * r + i * i) * norm;
    }
    return this.magnitudes;
  }
}
