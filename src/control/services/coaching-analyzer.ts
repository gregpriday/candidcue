/**
 * §5.3 / §12.1. The control-side owner of the coaching analysis branch.
 *
 * ---------------------------------------------------------------------------
 * ONE CAPTURE, THREE CONSUMERS
 * ---------------------------------------------------------------------------
 * This module never calls `getUserMedia`. It is handed the `MediaStream` that
 * `VoiceSessionPipeline.acquireMicrophone` already opened for the WebRTC peer
 * connection and for `MicrophoneMonitor`, and attaches a third consumer to the
 * same `MediaStreamTrack`. A second capture would mean a second permission
 * surface, a second clock, device contention and inconsistent gain.
 *
 * ---------------------------------------------------------------------------
 * §12.3 — THE TRANSMITTED TRACK IS NOT TOUCHED
 * ---------------------------------------------------------------------------
 * The graph is `MediaStreamSource → AudioWorkletNode`, a pure sink on a private
 * `AudioContext`. Conditioning happens inside the worklet's own analysis copy.
 * Nothing here can reach the track the peer connection is sending, because
 * nothing here writes to that track — an `AudioContext` graph built from a
 * `MediaStreamSource` observes the stream, it does not rewrite it.
 *
 * ---------------------------------------------------------------------------
 * THE KEEP-ALIVE, AND WHY IT IS EVIDENCE-DRIVEN RATHER THAN PRE-EMPTIVE
 * ---------------------------------------------------------------------------
 * `worklet-node.ts` flags a runtime risk no unit test can catch: some engines
 * only pull an `AudioWorkletNode` that has a path to `destination`. The failure
 * is silent — `attachCoachingAnalyzer` resolves, nothing throws, and `onFrames`
 * is simply never called — and the documented remedy is a `GainNode(0)`
 * keep-alive. The header is equally clear that it must not be added
 * pre-emptively, because "it is only a 0-gain node" is one mistaken edit away
 * from routing the microphone to the speakers on a live set.
 *
 * So it is neither added blindly nor left out: a watchdog makes the silence
 * *observable*, and only after the analyzer has demonstrably produced no frames
 * is the keep-alive installed. Two properties make that safe:
 *
 *   1. the keep-alive is fed by the **worklet node**, never by the microphone
 *      source, and the processor writes nothing to its outputs — so the signal
 *      reaching the gain node is digital silence before the gain is applied;
 *   2. `gain.value` is set to 0 and asserted immediately after connection; a
 *      future edit that removes the 0 still routes silence, and an edit that
 *      re-points the input at `source` would have to delete the comment on the
 *      line it is written on.
 *
 * Every escalation is reported through {@link CoachingAnalyzerDiagnostics} so
 * an operator sees "the analyzer produced no frames" rather than a rail that
 * quietly stays blank.
 */
import type { AudioFrameFeatures } from '../../shared/contracts/coaching';
import {
  attachCoachingAnalyzer,
  type AudioContextLike,
  type AudioNodeLike,
  type AudioWorkletNodeLike,
  type CoachingAnalyzerGraph,
} from '../../shared/coaching/audio/worklet-node';
import type { RingBufferClearReason } from '../../shared/coaching/audio/ring-buffer';
import type { MediaStreamLike } from './audio';

/** What the watchdog observed. Reported once per transition, never repeated. */
export type CoachingAnalyzerNotice =
  /** No frames within the watchdog window. The keep-alive has been installed. */
  | 'no_frames_keepalive_installed'
  /** Still no frames after the keep-alive. The analyzer is genuinely dead. */
  | 'no_frames_after_keepalive'
  /** Frames arrived. Emitted once, so "it works" is observable too. */
  | 'frames_flowing'
  /** `addModule()` or the graph build failed; the rail runs without audio. */
  | 'attach_failed';

export interface CoachingAnalyzerHandle {
  /** Sample rate of the analysis context, Hz. */
  readonly sampleRate: number;
  /**
   * §5.4. The audio clock, in ms: `AudioContext.currentTime`, which is the same
   * hardware clock the worklet's `currentFrame / sampleRate` counts. This is
   * the *only* clock the orchestrator is given.
   */
  currentTimeMs(): number;
  /** §12.6. Drop retained PCM. */
  clearBuffer(reason: RingBufferClearReason): void;
  /** §12.6. Reconstruct a diagnostic interval, or `null` when evicted. */
  extract(startMs: number, endMs: number): Promise<Float32Array | null>;
  /** New take pass / microphone change. */
  reset(): void;
  close(): Promise<void>;
  /** Frames decoded since attach. Zero is the symptom the watchdog watches. */
  readonly frameCount: number;
  /** True once the `GainNode(0)` keep-alive has been installed. */
  readonly keepAliveInstalled: boolean;
}

export interface CoachingAnalyzerOptions {
  /** The capture stream the app already owns (§5.3). Never acquired here. */
  stream: MediaStreamLike;
  onFrames(frames: AudioFrameFeatures[]): void;
  /** Watchdog + keep-alive reporting. */
  onNotice?(notice: CoachingAnalyzerNotice): void;
  /**
   * §12.6: a ring buffer is only retained for the Precision modes. `false`
   * keeps the analyzer running with no PCM retained at all.
   */
  retainPcm?: boolean;
  /**
   * How long to wait for the first frame before installing the keep-alive.
   * Frames publish every ~100 ms (§12.2), so anything beyond a second is a
   * fault, not jitter.
   */
  watchdogMs?: number;
  /** Injected for tests; defaults to the lazily-imported Vite worker URL. */
  workletModuleUrl?: string | (() => Promise<string>);
  /** Injected for tests; defaults to the real Web Audio constructors. */
  createContext?: () => KeepAliveCapableContext;
  setTimeoutFn?: (callback: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

/**
 * The extra surface the keep-alive needs beyond `AudioContextLike`. Declared
 * structurally, like everything else in the audio packages, so a node test can
 * exercise the escalation with a plain object.
 */
export interface KeepAliveCapableContext extends AudioContextLike {
  /** Seconds, per the Web Audio API. Converted to ms at the seam. */
  readonly currentTime: number;
  createGain(): GainNodeLike;
  readonly destination: unknown;
}

export interface GainNodeLike extends AudioNodeLike {
  readonly gain: { value: number };
}

async function defaultWorkletModuleUrl(): Promise<string> {
  // Lazy so a node test that never attaches does not pull a Vite worker build
  // into an environment that cannot produce one.
  const module = await import('./coaching-worklet-url');
  return module.default;
}

function defaultCreateContext(): KeepAliveCapableContext {
  return new AudioContext() as unknown as KeepAliveCapableContext;
}

/**
 * Attach the coaching analyzer to the capture stream the session already owns.
 *
 * Rejects only when the graph could not be built at all; the caller treats that
 * as "no audio lane this take" and the session continues (§5.2).
 */
export async function startCoachingAnalyzer(
  options: CoachingAnalyzerOptions,
): Promise<CoachingAnalyzerHandle> {
  const setTimeoutFn =
    options.setTimeoutFn ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimeoutFn =
    options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const watchdogMs = options.watchdogMs ?? 1_500;
  const notify = options.onNotice ?? (() => {});

  const urlSource = options.workletModuleUrl ?? defaultWorkletModuleUrl;
  const workletModuleUrl = typeof urlSource === 'string' ? urlSource : await urlSource();

  let context: KeepAliveCapableContext | null = null;
  let workletNode: AudioWorkletNodeLike | null = null;
  let frameCount = 0;
  let keepAlive: GainNodeLike | null = null;
  let closed = false;
  let watchdog: unknown = null;

  /**
   * One node factory. A test's context carries its own
   * `createWorkletNodeForTest`, so there is a single code path here rather than
   * two conditional ones — the node reference the keep-alive needs is captured
   * the same way in both cases.
   */
  const createWorkletNode = (
    ctx: AudioContextLike,
    name: string,
    nodeOptions: { processorOptions?: unknown },
  ): AudioWorkletNodeLike => {
    const testFactory = (
      ctx as unknown as {
        createWorkletNodeForTest?: (
          name: string,
          nodeOptions: { processorOptions?: unknown },
        ) => AudioWorkletNodeLike;
      }
    ).createWorkletNodeForTest;
    workletNode = testFactory
      ? testFactory(name, nodeOptions)
      : (new AudioWorkletNode(
          ctx as unknown as BaseAudioContext,
          name,
          nodeOptions as AudioWorkletNodeOptions,
        ) as unknown as AudioWorkletNodeLike);
    return workletNode;
  };

  let graph: CoachingAnalyzerGraph;
  try {
    graph = await attachCoachingAnalyzer({
      stream: options.stream as unknown as { getAudioTracks(): unknown[] },
      workletModuleUrl,
      onFrames: (frames) => {
        const first = frameCount === 0 && frames.length > 0;
        frameCount += frames.length;
        if (first) {
          clearTimeoutFn(watchdog);
          watchdog = null;
          notify('frames_flowing');
        }
        options.onFrames(frames);
      },
      // §12.6: PCM is retained only for the Precision transcription modes. The
      // default is no ring buffer at all, which is also the §32.1 default.
      processorOptions: { ringBuffer: { enabled: options.retainPcm === true } },
      createContext: () => {
        context = (options.createContext ?? defaultCreateContext)();
        return context;
      },
      createWorkletNode,
    });
  } catch (error) {
    notify('attach_failed');
    throw error;
  }

  /**
   * The documented remedy, applied only on evidence.
   *
   * INPUT IS THE WORKLET NODE, NEVER `source`. The processor writes nothing to
   * its outputs, so what reaches this gain node is digital silence by
   * construction; the 0 gain is the second of two independent reasons the
   * speakers stay quiet, not the only one.
   */
  const installKeepAlive = (): void => {
    if (keepAlive !== null || closed) return;
    const ctx = context;
    const node = workletNode;
    if (ctx === null || node === null) return;
    try {
      const gain = ctx.createGain();
      gain.gain.value = 0;
      node.connect(gain);
      gain.connect(ctx.destination);
      if (gain.gain.value !== 0) {
        // Belt and braces: if anything above left a non-zero gain, tear the
        // path down rather than risk mic-to-speakers on a live set.
        gain.disconnect();
        return;
      }
      keepAlive = gain;
      notify('no_frames_keepalive_installed');
      watchdog = setTimeoutFn(() => {
        if (frameCount === 0 && !closed) notify('no_frames_after_keepalive');
      }, watchdogMs);
    } catch {
      // A context without `createGain` (or a closed one) simply gets no
      // keep-alive; the notice above already said what happened.
    }
  };

  watchdog = setTimeoutFn(() => {
    watchdog = null;
    if (frameCount === 0 && !closed) installKeepAlive();
  }, watchdogMs);

  return {
    get sampleRate() {
      return graph.sampleRate;
    },
    currentTimeMs() {
      return context === null ? 0 : (context as KeepAliveCapableContext).currentTime * 1000;
    },
    clearBuffer(reason) {
      graph.clearBuffer(reason);
    },
    extract(startMs, endMs) {
      return graph.extract(startMs, endMs);
    },
    reset() {
      graph.reset();
    },
    async close() {
      if (closed) return;
      closed = true;
      clearTimeoutFn(watchdog);
      watchdog = null;
      try {
        keepAlive?.disconnect();
      } catch {
        /* already torn down */
      }
      keepAlive = null;
      await graph.close();
    },
    get frameCount() {
      return frameCount;
    },
    get keepAliveInstalled() {
      return keepAlive !== null;
    },
  };
}
