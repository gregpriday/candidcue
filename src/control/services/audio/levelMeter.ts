/**
 * Level meter + local VAD runner (spec §28.4).
 *
 * Owns the polling loop over an injected analyser graph and feeds the pure
 * `LocalVad`. The default graph factory builds AudioContext →
 * MediaStreamSource → AnalyserNode and never connects to a destination, so
 * microphone audio cannot reach the speakers (feedback is explicitly
 * prevented, spec §28.4).
 */
import type { AudioLevelSnapshot, Unsubscribe } from '../../../shared/contracts';
import { DEFAULT_ANALYSIS_INTERVAL_MS, type VadConfig } from './defaults';
import { computeFrameStats, LocalVad, type VadEvent } from './vad';
import {
  defaultIntervalScheduler,
  type AnalysisGraphFactory,
  type Clock,
  type IntervalScheduler,
  type MediaStreamLike,
  type TimerHandle,
} from './types';

export interface MicrophoneMonitorDeps {
  createGraph: AnalysisGraphFactory;
  now?: Clock;
  schedule?: IntervalScheduler;
  intervalMs?: number;
  vadConfig?: Partial<VadConfig>;
}

/**
 * Default analysis graph for the real WebView. Analysis only — the source is
 * never routed to `AudioContext.destination`.
 */
export const createAnalyserGraph: AnalysisGraphFactory = (stream) => {
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream as unknown as MediaStream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  // Intentionally NOT connected to context.destination (no feedback).
  return {
    analyser,
    close: async () => {
      try {
        source.disconnect();
      } catch {
        // already disconnected
      }
      await context.close();
    },
  };
};

export class MicrophoneMonitor {
  private readonly vad: LocalVad;
  private readonly now: Clock;
  private readonly schedule: IntervalScheduler;
  private readonly intervalMs: number;
  private readonly levelListeners = new Set<(snapshot: AudioLevelSnapshot) => void>();
  private readonly vadListeners = new Set<(event: VadEvent) => void>();
  private timer: TimerHandle | null = null;
  private graph: Awaited<ReturnType<AnalysisGraphFactory>> | null = null;
  private buffer: Float32Array | null = null;

  constructor(private readonly deps: MicrophoneMonitorDeps) {
    this.vad = new LocalVad(deps.vadConfig ?? {});
    this.now = deps.now ?? (() => performance.now());
    this.schedule = deps.schedule ?? defaultIntervalScheduler;
    this.intervalMs = deps.intervalMs ?? DEFAULT_ANALYSIS_INTERVAL_MS;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  get speaking(): boolean {
    return this.vad.speaking;
  }

  getSnapshot(): AudioLevelSnapshot | null {
    return this.vad.getSnapshot();
  }

  onLevel(listener: (snapshot: AudioLevelSnapshot) => void): Unsubscribe {
    this.levelListeners.add(listener);
    return () => this.levelListeners.delete(listener);
  }

  onVadEvent(listener: (event: VadEvent) => void): Unsubscribe {
    this.vadListeners.add(listener);
    return () => this.vadListeners.delete(listener);
  }

  async start(stream: MediaStreamLike): Promise<void> {
    await this.stop();
    this.vad.reset();
    this.graph = await this.deps.createGraph(stream);
    this.buffer = new Float32Array(this.graph.analyser.fftSize);
    this.timer = this.schedule(() => this.tick(), this.intervalMs);
  }

  /** Stop analysis and tear down the audio graph (spec §28.7 retention). */
  async stop(): Promise<void> {
    if (this.timer) {
      this.timer.cancel();
      this.timer = null;
    }
    if (this.graph) {
      const graph = this.graph;
      this.graph = null;
      this.buffer = null;
      await graph.close();
    }
  }

  private tick(): void {
    if (!this.graph || !this.buffer) return;
    this.graph.analyser.getFloatTimeDomainData(this.buffer);
    const stats = computeFrameStats(this.buffer);
    const events = this.vad.processFrame(stats, this.now());
    const snapshot = this.vad.getSnapshot();
    if (snapshot) {
      for (const listener of this.levelListeners) listener(snapshot);
    }
    for (const event of events) {
      for (const listener of this.vadListeners) listener(event);
    }
  }
}
