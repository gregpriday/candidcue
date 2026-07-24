/**
 * §12.1–§12.3. The render-thread core of the coaching analysis path.
 *
 * This class is deliberately free of every Web Audio type: it takes render
 * quanta as plain `Float32Array`s and returns nothing. `audio-worklet.ts` is a
 * thin `AudioWorkletProcessor` shell around it. That split exists because the
 * shell cannot be unit tested (there is no `AudioWorkletProcessor` in node) and
 * the DSP must be.
 *
 * ---------------------------------------------------------------------------
 * §12.1 constraints, and how each is met
 * ---------------------------------------------------------------------------
 * - **No per-frame allocation.** Every buffer is allocated in the constructor.
 *   Frames are packed into a preallocated `Float64Array` and published once per
 *   ~100 ms aggregation window (§12.2), so the steady-state cost is one small
 *   copy per publish, not one object per 20 ms frame.
 * - **No IPC, no network, no Luna, no DOM.** This module imports nothing but
 *   its sibling DSP modules. There is no `postMessage` here either — the core
 *   hands frames to a callback and the shell decides how to publish them.
 * - **No clock but the audio clock.** Time comes from the sample counter, via
 *   the context sample index the shell passes in. No `Date.now()`, no
 *   `performance.now()`, no `currentTime` seconds-vs-milliseconds conversion.
 *
 * ---------------------------------------------------------------------------
 * §12.3 / §5.3 — this never touches the transmitted track
 * ---------------------------------------------------------------------------
 * The core is a *sink*. It reads the samples the graph gives it and writes
 * nothing back into the graph, so the `MediaStreamTrack` fanned out to the
 * Realtime peer connection is bit-identical whether or not coaching is running.
 * Conditioning (DC removal, ~70 Hz high-pass) applies only to the analysis
 * copy. The PCM retained in the ring buffer is the *unconditioned* mono
 * downmix, because that buffer feeds precision transcription and a transcriber
 * should receive what the microphone heard, not what our high-pass left behind.
 */
import { DcBlocker, Biquad } from './filters';
import { FrameFeatureExtractor, PACKED_FRAME_FIELDS, packFrame } from './frame-features';
import { PcmRingBuffer, type PcmRingBufferOptions, type RingBufferClearReason } from './ring-buffer';

/** Beyond this, a gap is reported as a capped run of dropout frames (§12.4). */
const MAX_DROPOUT_FRAMES = 500;

/** Registered name of the processor in `audio-worklet.ts`. */
export const COACHING_WORKLET_PROCESSOR = 'candidcue-coaching-analyzer';

/** Control-window → worklet. */
export type CoachingWorkletCommand =
  | { type: 'clear_buffer'; reason: RingBufferClearReason }
  | { type: 'extract'; requestId: number; startMs: number; endMs: number }
  | { type: 'reset' }
  | { type: 'flush' };

/** Worklet → control window. */
export type CoachingWorkletMessage =
  | { type: 'frames'; packed: Float64Array; frameCount: number; sampleRate: number }
  | {
      type: 'extracted';
      requestId: number;
      pcm: Float32Array | null;
      sampleRate: number;
    }
  | { type: 'diagnostics'; diagnostics: WorkletCoreDiagnostics };

export interface WorkletCoreOptions {
  /** Native context sample rate (§12.2). */
  sampleRate: number;
  /** §12.2 analysis frame. Default 20 ms. */
  frameMs?: number;
  /** §12.2 aggregation update. Default 100 ms. */
  publishIntervalMs?: number;
  /** §12.3 gentle high-pass, Hz. Default 70 (spec allows 60–80). */
  highPassHz?: number;
  /** §12.6 ring buffer. Omitted or `enabled: false` means no PCM is retained. */
  ringBuffer?: Omit<PcmRingBufferOptions, 'sampleRate'> & { enabled: boolean };
  /**
   * Called once per aggregation window with `frameCount` packed frames at the
   * front of `packed`. The buffer is reused — read or copy it synchronously.
   */
  onFrames?: (packed: Float64Array, frameCount: number) => void;
}

export interface WorkletCoreDiagnostics {
  /** §37 `droppedFrameCount`. */
  droppedFrameCount: number;
  framesProduced: number;
  gapCount: number;
}

export class WorkletAudioCore {
  readonly sampleRate: number;
  readonly frameMs: number;
  readonly frameSamples: number;

  private readonly extractor: FrameFeatureExtractor;
  private readonly dcBlocker: DcBlocker;
  private readonly highPass: Biquad;
  private readonly monoScratch: Float32Array;
  private readonly frameBuffer: Float32Array;
  private readonly packed: Float64Array;
  private readonly framesPerPublish: number;
  private readonly ring: PcmRingBuffer | null;
  private readonly onFrames: ((packed: Float64Array, frameCount: number) => void) | undefined;

  private frameFill = 0;
  /** Absolute context sample index of the first sample of the frame in progress. */
  private frameStartSample = 0;
  /** Absolute context sample index we expect the next quantum to begin at. */
  private nextExpectedSample = 0;
  private started = false;
  private packedFrames = 0;
  private diagnosticsState: WorkletCoreDiagnostics = {
    droppedFrameCount: 0,
    framesProduced: 0,
    gapCount: 0,
  };

  constructor(options: WorkletCoreOptions) {
    this.sampleRate = options.sampleRate;
    this.frameMs = options.frameMs ?? 20;
    this.frameSamples = Math.round((this.frameMs / 1000) * this.sampleRate);
    this.onFrames = options.onFrames;

    this.extractor = new FrameFeatureExtractor({
      sampleRate: this.sampleRate,
      frameMs: this.frameMs,
    });
    this.dcBlocker = new DcBlocker(this.sampleRate);
    this.highPass = Biquad.highPass(this.sampleRate, options.highPassHz ?? 70);

    this.monoScratch = new Float32Array(4096); // far above any render quantum
    this.frameBuffer = new Float32Array(this.frameSamples);
    this.framesPerPublish = Math.max(
      1,
      Math.round((options.publishIntervalMs ?? 100) / this.frameMs),
    );
    this.packed = new Float64Array(this.framesPerPublish * PACKED_FRAME_FIELDS);

    this.ring =
      options.ringBuffer?.enabled === true
        ? new PcmRingBuffer({ sampleRate: this.sampleRate, ...options.ringBuffer })
        : null;
  }

  get diagnostics(): WorkletCoreDiagnostics {
    return { ...this.diagnosticsState };
  }

  get ringBuffer(): PcmRingBuffer | null {
    return this.ring;
  }

  /** Audio-clock time of the next sample to be consumed. */
  get audioTimeMs(): number {
    return (this.nextExpectedSample / this.sampleRate) * 1000;
  }

  /**
   * Consume one render quantum.
   *
   * `contextSampleIndex` is the absolute sample index of `channels[*][0]` — in
   * a worklet, `currentFrame`. When it runs ahead of what we have consumed, the
   * difference is audio the process callback never received (buffer underrun,
   * device change, thread starvation) and is published as `processorDropout`
   * frames. It is *not* published as silence: §12.4 is explicit that a dropout
   * read as a pause corrupts pace and cadence.
   */
  pushQuantum(
    channels: readonly Float32Array[],
    frameCount: number,
    contextSampleIndex?: number,
  ): void {
    if (frameCount <= 0) return;

    if (contextSampleIndex !== undefined) {
      if (!this.started) {
        this.nextExpectedSample = contextSampleIndex;
        this.frameStartSample = contextSampleIndex;
      } else if (contextSampleIndex > this.nextExpectedSample) {
        this.handleGap(contextSampleIndex - this.nextExpectedSample, contextSampleIndex);
      }
    }
    this.started = true;

    const count = Math.min(frameCount, this.monoScratch.length);
    this.downmix(channels, count);

    // §12.6: retained PCM is the raw downmix, before conditioning.
    this.ring?.write(this.monoScratch, count, (this.nextExpectedSample / this.sampleRate) * 1000);

    // §12.3: conditioning applies to the analysis copy only.
    this.dcBlocker.process(this.monoScratch, count);
    this.highPass.process(this.monoScratch, count);

    for (let i = 0; i < count; i += 1) {
      this.frameBuffer[this.frameFill] = this.monoScratch[i] as number;
      this.frameFill += 1;
      if (this.frameFill === this.frameSamples) {
        this.emitFrame(false);
        this.frameFill = 0;
        this.frameStartSample += this.frameSamples;
      }
    }
    this.nextExpectedSample += count;
  }

  /** Publish any frames held back by the aggregation window. */
  flush(): void {
    if (this.packedFrames > 0) this.publish();
  }

  /** §12.6. Drop retained PCM. No-op when the ring buffer is disabled. */
  clearRingBuffer(reason: RingBufferClearReason): void {
    this.ring?.clear(reason);
  }

  /**
   * §12.6. Reconstruct a short interval for precision transcription. Allocates,
   * and is therefore called from a message handler, never from the render path.
   */
  extract(startMs: number, endMs: number): Float32Array | null {
    return this.ring?.read(startMs, endMs) ?? null;
  }

  /** Full reset — new take, microphone change, session restart. */
  reset(clearReason: RingBufferClearReason = 'session_reset'): void {
    this.extractor.reset();
    this.dcBlocker.reset();
    this.highPass.reset();
    this.frameFill = 0;
    this.packedFrames = 0;
    this.started = false;
    this.nextExpectedSample = 0;
    this.frameStartSample = 0;
    this.diagnosticsState = { droppedFrameCount: 0, framesProduced: 0, gapCount: 0 };
    this.ring?.clear(clearReason);
  }

  private downmix(channels: readonly Float32Array[], count: number): void {
    const channelCount = channels.length;
    if (channelCount === 0) {
      this.monoScratch.fill(0, 0, count);
      return;
    }
    const first = channels[0] as Float32Array;
    for (let i = 0; i < count; i += 1) this.monoScratch[i] = first[i] as number;
    for (let channel = 1; channel < channelCount; channel += 1) {
      const data = channels[channel] as Float32Array;
      for (let i = 0; i < count; i += 1) {
        this.monoScratch[i] = (this.monoScratch[i] as number) + (data[i] as number);
      }
    }
    if (channelCount > 1) {
      const gain = 1 / channelCount;
      for (let i = 0; i < count; i += 1) {
        this.monoScratch[i] = (this.monoScratch[i] as number) * gain;
      }
    }
  }

  /**
   * Publish the gap as dropout frames and realign to the far side of it.
   * Frames after a dropout are aligned to the gap's end rather than to a global
   * grid, because the samples that would have defined the old grid do not
   * exist. The clock itself never drifts: it is always derived from the
   * context's own sample index.
   */
  private handleGap(gapSamples: number, contextSampleIndex: number): void {
    this.diagnosticsState.gapCount += 1;
    const missing = this.frameFill + gapSamples;
    const dropoutFrames = Math.max(1, Math.ceil(missing / this.frameSamples));
    const emitted = Math.min(dropoutFrames, MAX_DROPOUT_FRAMES);
    for (let i = 0; i < emitted; i += 1) {
      this.emitFrame(true);
      this.frameStartSample += this.frameSamples;
    }
    this.diagnosticsState.droppedFrameCount += dropoutFrames;
    this.frameFill = 0;
    this.frameStartSample = contextSampleIndex;
    this.nextExpectedSample = contextSampleIndex;
  }

  private emitFrame(dropout: boolean): void {
    const audioTimeMs = (this.frameStartSample / this.sampleRate) * 1000;
    const features = this.extractor.process(this.frameBuffer, audioTimeMs, dropout);
    packFrame(this.packed, this.packedFrames * PACKED_FRAME_FIELDS, features);
    this.packedFrames += 1;
    this.diagnosticsState.framesProduced += 1;
    if (this.packedFrames === this.framesPerPublish) this.publish();
  }

  private publish(): void {
    this.onFrames?.(this.packed, this.packedFrames);
    this.packedFrames = 0;
  }
}
