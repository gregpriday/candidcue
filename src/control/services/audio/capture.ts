/**
 * PCM capture for speech-to-text (spec §28.3).
 *
 * Takes the single microphone stream the session already owns and produces
 * fixed-size mono frames at the one sample rate the provider is told about.
 * Nothing here decides whether the presenter is speaking: the recogniser endpoints
 * server-side, so this pipe is unconditional for the length of a take. A frame
 * of silence is not waste — it is what tells the server the sentence ended.
 *
 * ---------------------------------------------------------------------------
 * WHY `ScriptProcessorNode`
 * ---------------------------------------------------------------------------
 * It is deprecated, and it is the right tool anyway. An `AudioWorklet` would
 * move ~24k samples/second of arithmetic off the main thread — work that is
 * genuinely negligible at this rate — in exchange for a separately-bundled
 * module, a port protocol, and a load step that can fail after the take has
 * started. Every one of those is a way for a take to open the microphone and
 * send nothing, which is the exact failure this rewrite exists to eliminate.
 * If profiling ever shows this on a flame graph, revisit it then.
 *
 * ---------------------------------------------------------------------------
 * TWO WKWEBVIEW HAZARDS, BOTH LOAD-BEARING
 * ---------------------------------------------------------------------------
 * 1. A graph with no path to `destination` is not guaranteed to be pulled, so
 *    the processor's callback may simply never fire. It is connected through a
 *    zero gain, which renders the graph without playing the presenter's own
 *    voice back into the room.
 * 2. An `AudioContext` can be constructed already `suspended`, in which case
 *    every frame is silence and the symptom is indistinguishable from someone
 *    who never spoke. It is resumed explicitly.
 */
import { STT_SAMPLE_RATE_HZ, STT_FRAME_MS } from '../stt/local';
import type { MediaStreamLike } from './types';

/** Samples in one outbound frame. */
export const FRAME_SAMPLES = Math.round((STT_SAMPLE_RATE_HZ * STT_FRAME_MS) / 1000);

/**
 * Buffer the processor asks for, at the context's own rate.
 *
 * 2048 at 24 kHz is ~85 ms, so a 100 ms frame fills in one or two callbacks.
 * Smaller buffers raise the callback rate for no benefit; larger ones add
 * latency directly to how quickly a word can move the cursor.
 */
const PROCESSOR_BUFFER = 2048;

export interface PcmCaptureDeps {
  /** Seam for tests. Defaults to a real context at the target rate. */
  createContext?(sampleRate: number): AudioContext;
  /** One frame of exactly {@link FRAME_SAMPLES} mono samples. */
  onFrame(samples: Float32Array): void;
}

/**
 * Resample linearly to the target rate.
 *
 * Only runs when the engine refused the requested `sampleRate` — Safari has
 * honoured it since 14.1, so this is insurance rather than the normal path.
 * Insurance worth carrying: without it a context that came back at 48 kHz
 * would send double-speed audio under a config frame claiming 24 kHz, and the
 * result is not an error but a transcript of something nobody said.
 */
export function resampleLinear(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLength = Math.floor(input.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const at = i * ratio;
    const low = Math.floor(at);
    const high = Math.min(low + 1, input.length - 1);
    const t = at - low;
    out[i] = (input[low] ?? 0) * (1 - t) + (input[high] ?? 0) * t;
  }
  return out;
}

/**
 * Accumulate arbitrary-length chunks into exactly-sized frames.
 *
 * Exported for its own sake: "the last partial frame is dropped on every
 * callback" is a defect that costs a few percent of every utterance and shows
 * up only as slightly worse recognition, which is unfalsifiable in a manual
 * test and trivial to assert here.
 */
export class FrameAccumulator {
  private pending: number[] = [];

  constructor(
    private readonly frameSamples: number,
    private readonly emit: (frame: Float32Array) => void,
  ) {}

  push(chunk: Float32Array): void {
    for (const sample of chunk) this.pending.push(sample);
    while (this.pending.length >= this.frameSamples) {
      this.emit(Float32Array.from(this.pending.splice(0, this.frameSamples)));
    }
  }

  /** Samples held back because they do not fill a frame yet. */
  get pendingCount(): number {
    return this.pending.length;
  }

  reset(): void {
    this.pending = [];
  }
}

export class PcmCapture {
  private context: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private gain: GainNode | null = null;
  private readonly accumulator: FrameAccumulator;

  constructor(private readonly deps: PcmCaptureDeps) {
    this.accumulator = new FrameAccumulator(FRAME_SAMPLES, (frame) => this.deps.onFrame(frame));
  }

  async start(stream: MediaStreamLike): Promise<void> {
    await this.stop();
    const create =
      this.deps.createContext ?? ((rate: number) => new AudioContext({ sampleRate: rate }));
    const context = create(STT_SAMPLE_RATE_HZ);
    this.context = context;
    // Hazard 2: a suspended context measures silence forever.
    if (context.state === 'suspended') await context.resume();

    const source = context.createMediaStreamSource(stream as unknown as MediaStream);
    const processor = context.createScriptProcessor(PROCESSOR_BUFFER, 1, 1);
    const gain = context.createGain();
    gain.gain.value = 0;

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      // Copied before resampling or buffering: the engine reuses this backing
      // buffer for the next callback, so anything retained by reference is
      // overwritten with future audio before it is sent.
      const copy = new Float32Array(input);
      this.accumulator.push(resampleLinear(copy, context.sampleRate, STT_SAMPLE_RATE_HZ));
    };

    source.connect(processor);
    // Hazard 1: without a path to the destination the callback may never run.
    processor.connect(gain);
    gain.connect(context.destination);

    this.source = source;
    this.processor = processor;
    this.gain = gain;
  }

  async stop(): Promise<void> {
    if (this.processor) {
      this.processor.onaudioprocess = null;
      this.processor.disconnect();
      this.processor = null;
    }
    this.source?.disconnect();
    this.source = null;
    this.gain?.disconnect();
    this.gain = null;
    this.accumulator.reset();
    const context = this.context;
    this.context = null;
    if (context && context.state !== 'closed') {
      try {
        await context.close();
      } catch {
        /* already closing */
      }
    }
  }

  /** The rate the engine actually gave us; `STT_SAMPLE_RATE_HZ` when honoured. */
  get contextSampleRate(): number | null {
    return this.context?.sampleRate ?? null;
  }
}
