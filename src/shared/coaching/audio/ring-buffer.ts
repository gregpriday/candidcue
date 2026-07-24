/**
 * §12.6. Rolling in-memory PCM ring buffer.
 *
 * Exists so a delayed precision-transcription result can be reconstructed from
 * the exact audio interval it describes (§5.4: results are mapped *back* onto
 * their interval, never stamped with arrival time).
 *
 * Hard constraints encoded here:
 * - memory only. This module has no filesystem, IPC or network import, and it
 *   must never acquire one: §12.6 forbids writing capture to disk merely to
 *   call a transcription API.
 * - capacity defaults to 30 s and is clamped to 60 s without recording consent.
 * - `clear()` is callable on take end, microphone stop, application lock and
 *   user request, and zero-fills so evicted audio cannot resurface through a
 *   later read.
 *
 * The buffer is addressed in *audio-clock milliseconds* (§5.4), not in sample
 * indices, so callers never have to know the device sample rate. A gap in the
 * incoming stream (a worklet dropout) makes the audio before the gap
 * unreadable rather than silently splicing across it: a spliced read would
 * hand the transcriber audio whose timeline does not match its own stamps.
 */

export const RING_BUFFER_DEFAULT_SECONDS = 30;
/** §12.6 hard maximum without recording consent. */
export const RING_BUFFER_MAX_SECONDS_WITHOUT_CONSENT = 60;
/** With explicit recording consent the buffer may grow, but never unbounded. */
export const RING_BUFFER_MAX_SECONDS_WITH_CONSENT = 300;

/** §12.6. Every reason the buffer must be dropped. */
export type RingBufferClearReason =
  | 'take_end'
  | 'microphone_stop'
  | 'application_lock'
  | 'user_request'
  | 'session_reset';

export interface PcmRingBufferOptions {
  sampleRate: number;
  /** Default 30 s. Clamped to the consent-dependent maximum. */
  capacitySeconds?: number;
  /** Default false. False clamps capacity to 60 s (§12.6). */
  recordingConsent?: boolean;
}

export class PcmRingBuffer {
  readonly sampleRate: number;
  readonly capacitySamples: number;

  private readonly data: Float32Array;
  /** Absolute count of samples accepted since the origin, including skipped gaps. */
  private totalWritten = 0;
  /** Absolute index of the oldest sample that is still contiguous with the newest. */
  private contiguousStart = 0;
  /** Audio-clock time of absolute sample 0. */
  private originMs = 0;
  private originSet = false;
  private lastClearReason: RingBufferClearReason | null = null;

  constructor(options: PcmRingBufferOptions) {
    if (!(options.sampleRate > 0)) {
      throw new Error('PcmRingBuffer: sampleRate must be positive');
    }
    this.sampleRate = options.sampleRate;
    const maxSeconds = options.recordingConsent
      ? RING_BUFFER_MAX_SECONDS_WITH_CONSENT
      : RING_BUFFER_MAX_SECONDS_WITHOUT_CONSENT;
    const requested = options.capacitySeconds ?? RING_BUFFER_DEFAULT_SECONDS;
    const seconds = Math.min(Math.max(requested, 0.02), maxSeconds);
    this.capacitySamples = Math.max(1, Math.round(seconds * this.sampleRate));
    this.data = new Float32Array(this.capacitySamples);
  }

  get capacityMs(): number {
    return (this.capacitySamples / this.sampleRate) * 1000;
  }

  /** Audio time of the oldest readable sample, or `null` when empty. */
  get availableStartMs(): number | null {
    if (this.availableSampleCount === 0) return null;
    return this.sampleToMs(this.oldestSample);
  }

  /** Audio time just past the newest written sample, or `null` when empty. */
  get availableEndMs(): number | null {
    if (this.availableSampleCount === 0) return null;
    return this.sampleToMs(this.totalWritten);
  }

  get availableSampleCount(): number {
    return this.totalWritten - this.oldestSample;
  }

  get clearReason(): RingBufferClearReason | null {
    return this.lastClearReason;
  }

  private get oldestSample(): number {
    return Math.max(this.contiguousStart, this.totalWritten - this.capacitySamples);
  }

  /**
   * Append conditioned mono PCM.
   *
   * `firstSampleAudioTimeMs` is optional but strongly recommended: when it runs
   * ahead of the buffer's own cursor the difference is a capture gap, and the
   * gap is skipped (zero-filled) with everything before it dropped from
   * availability rather than being spliced onto the newer audio.
   *
   * Allocation-free: copies by index, never via `subarray`.
   */
  write(samples: Float32Array, count = samples.length, firstSampleAudioTimeMs?: number): void {
    if (!this.originSet) {
      this.originMs = firstSampleAudioTimeMs ?? 0;
      this.originSet = true;
    } else if (firstSampleAudioTimeMs !== undefined) {
      const expectedMs = this.sampleToMs(this.totalWritten);
      const driftSamples = Math.round(
        ((firstSampleAudioTimeMs - expectedMs) * this.sampleRate) / 1000,
      );
      if (driftSamples > 0) this.skip(driftSamples);
    }

    const total = Math.min(count, samples.length);
    if (total <= 0) return;

    // A single write larger than the whole buffer: only its newest tail can
    // survive, and the head it displaces is not readable.
    let srcStart = 0;
    if (total > this.capacitySamples) {
      srcStart = total - this.capacitySamples;
      this.totalWritten += srcStart;
    }

    const cap = this.capacitySamples;
    let pos = this.totalWritten % cap;
    for (let i = srcStart; i < total; i += 1) {
      this.data[pos] = samples[i] as number;
      pos += 1;
      if (pos === cap) pos = 0;
    }
    this.totalWritten += total - srcStart;
  }

  /**
   * Advance the cursor across a capture gap. The skipped region is zero-filled
   * and `contiguousStart` jumps to the far side, so no read can span the gap.
   */
  private skip(gapSamples: number): void {
    const cap = this.capacitySamples;
    const fill = Math.min(gapSamples, cap);
    let pos = this.totalWritten % cap;
    for (let i = 0; i < fill; i += 1) {
      this.data[pos] = 0;
      pos += 1;
      if (pos === cap) pos = 0;
    }
    this.totalWritten += gapSamples;
    this.contiguousStart = this.totalWritten;
  }

  /**
   * §12.6. Drop everything held. The audio clock is *not* rewound — the origin
   * and cursor stay put, because a monotonic audio clock is the only clock
   * (Rule 3) and rewinding it would re-date every later interval.
   */
  clear(reason: RingBufferClearReason): void {
    this.data.fill(0);
    this.contiguousStart = this.totalWritten;
    this.lastClearReason = reason;
  }

  /** True when `[startMs, endMs)` is entirely present and contiguous. */
  hasInterval(startMs: number, endMs: number): boolean {
    const start = this.msToSample(startMs);
    const end = this.msToSample(endMs);
    return end > start && start >= this.oldestSample && end <= this.totalWritten;
  }

  /**
   * Copy `[startMs, endMs)` into `out`. Returns the number of samples copied,
   * or 0 when the interval is unavailable — partially evicted intervals are
   * refused outright rather than returned short, because a short buffer read
   * as a full one shifts every timestamp derived from it.
   */
  readInto(startMs: number, endMs: number, out: Float32Array): number {
    const start = this.msToSample(startMs);
    const end = this.msToSample(endMs);
    if (!(end > start) || start < this.oldestSample || end > this.totalWritten) return 0;
    const length = Math.min(end - start, out.length);
    const cap = this.capacitySamples;
    let pos = ((start % cap) + cap) % cap;
    for (let i = 0; i < length; i += 1) {
      out[i] = this.data[pos] as number;
      pos += 1;
      if (pos === cap) pos = 0;
    }
    return length;
  }

  /**
   * Allocating convenience read for diagnostics and precision transcription.
   * Never call this from the worklet's render path (§12.1).
   */
  read(startMs: number, endMs: number): Float32Array | null {
    const start = this.msToSample(startMs);
    const end = this.msToSample(endMs);
    if (!(end > start) || start < this.oldestSample || end > this.totalWritten) return null;
    const out = new Float32Array(end - start);
    this.readInto(startMs, endMs, out);
    return out;
  }

  private msToSample(ms: number): number {
    return Math.round(((ms - this.originMs) * this.sampleRate) / 1000);
  }

  private sampleToMs(sample: number): number {
    return this.originMs + (sample / this.sampleRate) * 1000;
  }
}
