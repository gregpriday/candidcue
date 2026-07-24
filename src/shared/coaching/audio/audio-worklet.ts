/**
 * §12.1. The `AudioWorkletProcessor` shell.
 *
 * Intentionally almost empty: every line of DSP lives in `worklet-core.ts`,
 * which is plain TypeScript and fully unit tested. This file exists only to
 * (a) satisfy the worklet global scope's `registerProcessor` contract, (b) turn
 * `currentFrame` into the core's audio clock, and (c) move packed frames across
 * the port. There is nothing here to test in node — and nothing here worth
 * testing, which is the point of the split.
 *
 * **It never acquires a microphone.** The processor is attached to a stream the
 * control window already owns (§5.3: one capture, many consumers). There is no
 * `getUserMedia` in this file or anywhere under `shared/coaching/audio/`.
 *
 * **It never returns audio.** `process()` returns `true` without writing to
 * `outputs`, and the node is never connected to a destination, so nothing here
 * can alter or echo the track the Realtime peer connection is sending (§12.3).
 *
 * Bundling note: this module must be loaded through `audioWorklet.addModule()`
 * as a **self-contained** script. See `worklet-node.ts` for how the URL is
 * obtained — the caller supplies it, because how a worklet is emitted is a
 * build concern and this package does not own the Vite config.
 */
import {
  COACHING_WORKLET_PROCESSOR,
  WorkletAudioCore,
  type CoachingWorkletCommand,
  type WorkletCoreOptions,
} from './worklet-core';

// The AudioWorklet global scope is not described by lib.dom; declare exactly
// the four things this file touches rather than pulling in an ambient package.
declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(name: string, processorCtor: unknown): void;
declare abstract class AudioWorkletProcessor {
  readonly port: {
    postMessage(message: unknown, transfer?: unknown[]): void;
    onmessage: ((event: { data: unknown }) => void) | null;
  };
}

type ProcessorOptions = Omit<WorkletCoreOptions, 'sampleRate' | 'onFrames'>;

class CoachingAnalyzerProcessor extends AudioWorkletProcessor {
  private readonly core: WorkletAudioCore;

  constructor(options?: { processorOptions?: ProcessorOptions }) {
    super();
    this.core = new WorkletAudioCore({
      sampleRate,
      ...(options?.processorOptions ?? {}),
      onFrames: (packed, frameCount) => {
        // One structured-clone copy per aggregation window (~100 ms), not one
        // allocation per 20 ms frame (§12.1). `subarray` is a view, so only the
        // frames actually produced are copied.
        this.port.postMessage({
          type: 'frames',
          packed: packed.subarray(0, frameCount * 13),
          frameCount,
          sampleRate,
        });
      },
    });

    this.port.onmessage = (event) => this.handleCommand(event.data as CoachingWorkletCommand);
  }

  private handleCommand(command: CoachingWorkletCommand): void {
    switch (command.type) {
      case 'clear_buffer':
        this.core.clearRingBuffer(command.reason);
        return;
      case 'reset':
        this.core.reset();
        return;
      case 'flush':
        this.core.flush();
        return;
      case 'extract': {
        // Allocating, but off the framing path: this runs on a message, at most
        // once per precision-transcription chunk.
        const pcm = this.core.extract(command.startMs, command.endMs);
        this.port.postMessage({
          type: 'extracted',
          requestId: command.requestId,
          pcm,
          sampleRate,
        });
        return;
      }
      default:
        return;
    }
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const channel = input?.[0];
    if (channel !== undefined) {
      this.core.pushQuantum(input as Float32Array[], channel.length, currentFrame);
    }
    // Keep the processor alive across microphone mutes: a muted track delivers
    // empty inputs, and returning false here would tear the analyzer down
    // permanently the first time the user hit mute.
    return true;
  }
}

registerProcessor(COACHING_WORKLET_PROCESSOR, CoachingAnalyzerProcessor);
