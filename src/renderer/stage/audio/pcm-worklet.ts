/// <reference path="../../global.d.ts" />

/**
 * Audio worklet that downsamples the live mic to 16 kHz mono PCM16 and posts
 * ~100 ms chunks (1600 samples) to the main thread as transferable ArrayBuffers.
 *
 * This module imports NOTHING — it runs inside the AudioWorkletGlobalScope and
 * relies only on the worklet globals declared in src/renderer/global.d.ts.
 *
 * Sequencing / timestamps are added downstream by the CaptureController; the
 * worklet only handles the heavy float -> PCM16 conversion off the UI thread.
 */

const TARGET_SAMPLE_RATE = 16000;
/** ~100 ms at 16 kHz. */
const CHUNK_SAMPLES = 1600;

class PcmWorkletProcessor extends AudioWorkletProcessor {
  /** Fractional read position into the *input* stream for linear resampling. */
  private readPosition = 0;
  /** Accumulated 16 kHz mono samples awaiting a full chunk. */
  private readonly accumulator: Float32Array = new Float32Array(CHUNK_SAMPLES);
  private accumulated = 0;
  /** Ratio of input sample rate to the 16 kHz target. */
  private readonly resampleRatio: number = sampleRate / TARGET_SAMPLE_RATE;

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (input === undefined || input.length === 0) {
      // No input connected this quantum; keep the processor alive.
      return true;
    }
    const channel = input[0];
    if (channel === undefined || channel.length === 0) {
      return true;
    }

    const frames = channel.length;
    // Walk the fractional read position across this quantum, emitting one 16 kHz
    // sample per step via linear interpolation between adjacent input frames.
    while (this.readPosition < frames) {
      const baseIndex = Math.floor(this.readPosition);
      const frac = this.readPosition - baseIndex;
      const a = channel[baseIndex] ?? 0;
      const b = channel[baseIndex + 1] ?? a;
      const sample = a + (b - a) * frac;

      this.accumulator[this.accumulated] = sample;
      this.accumulated += 1;

      if (this.accumulated >= CHUNK_SAMPLES) {
        this.flush();
      }

      this.readPosition += this.resampleRatio;
    }

    // Carry the fractional remainder into the next quantum.
    this.readPosition -= frames;

    return true;
  }

  private flush(): void {
    const buffer = new ArrayBuffer(this.accumulated * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < this.accumulated; i += 1) {
      const clamped = Math.max(-1, Math.min(1, this.accumulator[i] ?? 0));
      // Asymmetric scaling keeps the full -32768..32767 range.
      const pcm = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      view.setInt16(i * 2, pcm | 0, true);
    }
    this.accumulated = 0;
    this.port.postMessage(buffer, [buffer]);
  }
}

registerProcessor('pcm-worklet', PcmWorkletProcessor);
