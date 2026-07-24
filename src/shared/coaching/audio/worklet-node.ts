/**
 * §5.3 / §12.1. The control-window side of the coaching analyzer: attaching the
 * worklet to a capture stream **that already exists**, and decoding the frames
 * it publishes.
 *
 * ---------------------------------------------------------------------------
 * §5.3 — ONE CAPTURE, MULTIPLE CONSUMERS
 * ---------------------------------------------------------------------------
 * This module takes a `MediaStream` as an argument and never asks for one.
 * There is no `getUserMedia` call anywhere under `shared/coaching/audio/`, by
 * design: CandidCue opens the microphone once — today in
 * `control/services/voice-session.ts`, which passes the same stream to the
 * WebRTC transport (`acquireMicrophone`) and to `MicrophoneMonitor` — and the
 * coaching analyzer is simply a third consumer of that same
 * `MediaStreamTrack`. A second capture session would mean a second permission
 * surface, a second clock, device contention, and inconsistent gain processing.
 *
 * ---------------------------------------------------------------------------
 * §12.3 — THE TRANSMITTED TRACK IS NOT TOUCHED
 * ---------------------------------------------------------------------------
 * The graph is `MediaStreamSource → AudioWorkletNode`, a pure sink. The
 * processor never writes to its `outputs`, so the buffer it hands downstream is
 * digital silence by construction, and nothing it does can reach the track the
 * peer connection is sending. Conditioning (DC removal, high-pass) exists only
 * inside the analysis copy.
 *
 * The node is **never connected to `context.destination`**, matching
 * `control/services/audio/levelMeter.ts`. On a live set, microphone audio
 * reaching the speakers is a feedback loop, and "it is only a 0-gain node"
 * is one mistaken edit away from being false.
 *
 * RUNTIME RISK, flagged because no unit test can catch it: some engines only
 * pull an `AudioWorkletNode` that has a path to the destination. Chrome drives
 * a worklet fed by a live `MediaStreamSource` regardless, and this is the same
 * shape the existing `AnalyserNode` tap already relies on in this app — but it
 * must be confirmed in the real WKWebView build. The symptom is specific and
 * easy to recognise: `attachCoachingAnalyzer` resolves, no error is thrown, and
 * `onFrames` is simply never called. If that happens the fix is a
 * `GainNode(0) → destination` keep-alive, which stays silent because the
 * processor writes no output at all — but do not add it pre-emptively.
 *
 * ---------------------------------------------------------------------------
 * Bundling (flagged deliberately)
 * ---------------------------------------------------------------------------
 * `audioWorklet.addModule()` fetches a URL and evaluates it in a scope that has
 * no bundler and, on WKWebView, unreliable support for nested ES imports. The
 * worklet must therefore be emitted as **one self-contained script**, and how
 * that happens is a build decision this package does not own. The URL is
 * injected (`workletModuleUrl`) rather than computed here. Two options that
 * work with the current Vite config:
 *   - `import url from '.../audio-worklet.ts?worker&url'` — zero config change,
 *     Vite emits a standalone bundle;
 *   - add `audio-worklet.ts` as a rollup input in `vite.config.ts` and use the
 *     emitted filename.
 * Whoever wires this up should verify in the real WKWebView that
 * `addModule()` resolves, because a silent failure there costs the whole
 * coaching rail while every unit test stays green.
 */
import type { AudioFrameFeatures } from '../../contracts/coaching';
import { PACKED_FRAME_FIELDS, unpackFrame } from './frame-features';
import type { RingBufferClearReason } from './ring-buffer';
import {
  COACHING_WORKLET_PROCESSOR,
  type CoachingWorkletCommand,
  type CoachingWorkletMessage,
  type WorkletCoreOptions,
} from './worklet-core';

/**
 * Structural subsets of the browser APIs used here, mirroring the idiom in
 * `control/services/audio/types.ts` so this stays testable in node. Kept local
 * rather than imported because `shared/` must not depend on `control/`; the
 * shapes are compatible with that package's `MediaStreamLike`.
 */
export interface MediaStreamHandle {
  getAudioTracks(): unknown[];
}

export interface WorkletPortLike {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface AudioWorkletNodeLike {
  readonly port: WorkletPortLike;
  connect(destination: unknown): unknown;
  disconnect(): void;
}

export interface AudioNodeLike {
  connect(destination: unknown): unknown;
  disconnect(): void;
}

export interface AudioContextLike {
  readonly sampleRate: number;
  readonly audioWorklet: { addModule(url: string): Promise<void> };
  createMediaStreamSource(stream: unknown): AudioNodeLike;
  close(): Promise<void>;
}

export interface CoachingAnalyzerDeps {
  /** The capture stream the app already owns (§5.3). Never acquired here. */
  stream: MediaStreamHandle;
  /** URL of the bundled worklet module. See the bundling note above. */
  workletModuleUrl: string;
  /** Receives decoded frames, oldest first, once per aggregation window. */
  onFrames: (frames: AudioFrameFeatures[]) => void;
  processorOptions?: Omit<WorkletCoreOptions, 'sampleRate' | 'onFrames'>;
  /** Injection points for tests; default to the real Web Audio constructors. */
  createContext?: () => AudioContextLike;
  createWorkletNode?: (
    context: AudioContextLike,
    name: string,
    options: { processorOptions?: unknown },
  ) => AudioWorkletNodeLike;
}

export interface CoachingAnalyzerGraph {
  readonly sampleRate: number;
  /** §12.6. Drop retained PCM: take end, mic stop, app lock, user request. */
  clearBuffer(reason: RingBufferClearReason): void;
  /** §12.6. Reconstruct a diagnostic interval. Resolves `null` when evicted. */
  extract(startMs: number, endMs: number): Promise<Float32Array | null>;
  /** New take pass / microphone change. */
  reset(): void;
  /** Tear down the graph and clear the buffer. */
  close(): Promise<void>;
}

/** Decode a published batch into contract frames. */
export function decodeFrames(packed: Float64Array, frameCount: number): AudioFrameFeatures[] {
  const frames: AudioFrameFeatures[] = [];
  for (let i = 0; i < frameCount; i += 1) {
    frames.push(unpackFrame(packed, i * PACKED_FRAME_FIELDS));
  }
  return frames;
}

/**
 * Attach the coaching analyzer to an existing capture stream.
 *
 * Returns a handle the caller owns; `close()` must be called on microphone
 * stop, take end or session teardown, because §12.6 requires the retained PCM
 * to go away with the capture.
 */
export async function attachCoachingAnalyzer(
  deps: CoachingAnalyzerDeps,
): Promise<CoachingAnalyzerGraph> {
  const context = (deps.createContext ?? defaultCreateContext)();
  await context.audioWorklet.addModule(deps.workletModuleUrl);

  const source = context.createMediaStreamSource(deps.stream);
  const node = (deps.createWorkletNode ?? defaultCreateWorkletNode)(
    context,
    COACHING_WORKLET_PROCESSOR,
    { processorOptions: deps.processorOptions ?? {} },
  );
  source.connect(node);
  // Deliberately NOT connected onward to `context.destination`: the analyzer is
  // a sink, exactly like the existing `createAnalyserGraph`, and microphone
  // audio must never reach the speakers.

  const pending = new Map<number, (pcm: Float32Array | null) => void>();
  let nextRequestId = 1;

  node.port.onmessage = (event) => {
    const message = event.data as CoachingWorkletMessage;
    if (message.type === 'frames') {
      deps.onFrames(decodeFrames(message.packed, message.frameCount));
      return;
    }
    if (message.type === 'extracted') {
      const resolve = pending.get(message.requestId);
      if (resolve) {
        pending.delete(message.requestId);
        resolve(message.pcm);
      }
    }
  };

  const send = (command: CoachingWorkletCommand): void => node.port.postMessage(command);

  return {
    sampleRate: context.sampleRate,
    clearBuffer(reason) {
      send({ type: 'clear_buffer', reason });
    },
    extract(startMs, endMs) {
      const requestId = nextRequestId;
      nextRequestId += 1;
      return new Promise<Float32Array | null>((resolve) => {
        pending.set(requestId, resolve);
        send({ type: 'extract', requestId, startMs, endMs });
      });
    },
    reset() {
      send({ type: 'reset' });
    },
    async close() {
      send({ type: 'clear_buffer', reason: 'microphone_stop' });
      node.port.onmessage = null;
      for (const resolve of pending.values()) resolve(null);
      pending.clear();
      try {
        source.disconnect();
        node.disconnect();
      } catch {
        // already torn down
      }
      await context.close();
    },
  };
}

function defaultCreateContext(): AudioContextLike {
  return new AudioContext() as unknown as AudioContextLike;
}

function defaultCreateWorkletNode(
  context: AudioContextLike,
  name: string,
  options: { processorOptions?: unknown },
): AudioWorkletNodeLike {
  return new AudioWorkletNode(
    context as unknown as BaseAudioContext,
    name,
    options,
  ) as unknown as AudioWorkletNodeLike;
}
