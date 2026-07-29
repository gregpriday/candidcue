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
import { STT_SAMPLE_RATE_HZ } from '../stt/session';
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
 * Default analysis graph for the real WebView.
 *
 * Two things here are about WKWebView specifically, and both were absent.
 *
 * A graph with no path to `destination` is not guaranteed to be PULLED. The
 * spec only requires a node to render if it reaches the destination, and some
 * engines take that literally — an `AnalyserNode` hanging off the end of a
 * source with nowhere to go can return zeros forever while every state looks
 * healthy. This repository already documents that exact hazard for the
 * coaching graph (`coaching-analyzer.ts`), and this one was left dangling. The
 * silent path is `analyser → GainNode(0) → destination`: it makes the graph
 * render without emitting a sample of the presenter's own voice back into the
 * room, which is what the original "no feedback" note was protecting against.
 *
 * And an `AudioContext` can be constructed `suspended`. Nothing resumed it, so
 * every frame the VAD measured could have been silence regardless of what the
 * microphone was doing — which looks identical to a presenter who never spoke.
 */
/**
 * The analyser's context, at the capture's rate where the engine allows it.
 *
 * Safari has honoured an explicit `sampleRate` since 14.1, so the fallback is
 * insurance rather than the normal path — but it is insurance worth carrying:
 * an engine that REFUSES the rate would throw out of a constructor, and losing
 * the level meter entirely is a worse outcome than the mismatch this pins.
 * Nothing downstream depends on the rate; the monitor reads time-domain
 * samples and computes an RMS, which is rate-agnostic.
 */
function analyserContext(): AudioContext {
  try {
    return new AudioContext({ sampleRate: STT_SAMPLE_RATE_HZ });
  } catch {
    return new AudioContext();
  }
}

export const createAnalyserGraph: AnalysisGraphFactory = (stream) => {
  /*
   * PINNED to the rate the PCM tap uses, and that is not a detail.
   *
   * One microphone is tapped twice — this analyser and `PcmCapture` — and each
   * used to build its own `AudioContext`: this one at the hardware rate, the
   * capture at `STT_SAMPLE_RATE_HZ`. Two `MediaStreamAudioSourceNode`s on one
   * `MediaStream` across contexts at DIFFERENT rates is the WebKit case where
   * one of them quietly delivers nothing, and on a RODE NT-USB Mini (48 kHz
   * hardware) it is this one that loses. The Settings screen has been printing
   * the contradiction all along, one line above the other:
   *
   *     No signal — CandidCue cannot hear this microphone.
   *     Transcription is working.   "This is a test of the transcription."
   *
   * That silence reached the §28.6 dead-input detector, which held following
   * for the whole take: the stage heard, transcribed, aligned and moved the
   * document, then stopped, with every instrument reporting health.
   *
   * Matching the rates removes the mismatch. It does not make two contexts on
   * one stream a good idea — the analyser only ever reads
   * `getFloatTimeDomainData`, which is exactly what the capture already has, so
   * the real answer is one context feeding both. That is a larger change than
   * this, and `frameHasSignal` in `voice-session.ts` means a relapse can no
   * longer stop anybody presenting.
   */
  const context = analyserContext();
  const source = context.createMediaStreamSource(stream as unknown as MediaStream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  // Zero gain: renders the graph without playing the microphone back.
  const mute = context.createGain();
  mute.gain.value = 0;
  analyser.connect(mute);
  mute.connect(context.destination);
  if (context.state === 'suspended') {
    void context.resume().catch(() => {
      // A context that will not resume is reported by the levels being zero;
      // failing the take here would be worse than measuring nothing.
    });
  }
  return {
    analyser,
    close: async () => {
      try {
        source.disconnect();
        mute.disconnect();
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

/**
 * Does this PCM frame carry anything at all?
 *
 * Deliberately a floor, not a speech threshold. It answers "is this device
 * producing audio" — the question the §28.6 dead-input detector is really
 * asking — and it has to be true of a quiet room, because a quiet room is a
 * working microphone. Real analog silence still carries thermal noise and a
 * dither floor; a dead capture path returns samples that are exactly zero.
 *
 * The bar sits just above absolute silence for that reason: anything a real
 * converter produces clears it, and only a stream of literal zeros fails.
 */
const PCM_SIGNAL_FLOOR = 1e-4;

export function frameHasSignal(samples: Float32Array): boolean {
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i];
    if (sample !== undefined && Math.abs(sample) > PCM_SIGNAL_FLOOR) return true;
  }
  return false;
}
