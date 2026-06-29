import type { CaptureConfig } from '@shared/contracts';
// `?worker` makes Vite bundle the worklet into a transpiled, same-origin JS
// asset (not raw .ts in a data: URL); `?url` yields its URL string for
// audioWorklet.addModule(), which the production CSP serves under script-src 'self'.
import workletUrl from './pcm-worklet.ts?worker&url';

/** Gate states that mirror StageStateProjection.micState. */
export type MicGate = 'closed' | 'armed' | 'active';

interface CaptureChunkMessage {
  sessionId: string;
  turnId: string | null;
  sequence: number;
  capturedAtMs: number;
  payload: ArrayBuffer;
}

interface BufferedChunk {
  capturedAtMs: number;
  payload: ArrayBuffer;
}

const DEFAULT_PRE_ROLL_MS = 400;
/** ~100 ms per chunk -> keep a handful for the pre-roll ring buffer. */
const PRE_ROLL_SLACK_MS = 200;
/** How often to push a meter reading upstream. */
const METER_INTERVAL_MS = 100;

export interface CaptureControllerOptions {
  sessionId: string;
  deviceId: string | null;
  config: CaptureConfig | null;
  reportMeter: (reading: { peak: number; average: number; clipping: boolean }) => void;
  /** Resolves the MessagePort the main process reads capture chunks from. */
  openPort: (input: { sessionId: string }) => Promise<MessagePort>;
}

/**
 * Owns the live microphone graph: getUserMedia -> AudioWorkletNode (PCM16
 * conversion) -> a MessagePort to the main process. Forwarding is *gated* by the
 * latest mic state so we never leak audio while closed, but a short pre-roll ring
 * buffer is flushed on open so the first syllable isn't clipped.
 */
export class CaptureController {
  private readonly options: CaptureControllerOptions;

  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private analyser: AnalyserNode | null = null;
  private port: MessagePort | null = null;

  private gate: MicGate = 'closed';
  private currentTurnId: string | null = null;
  private sequence = 0;

  private readonly preRoll: BufferedChunk[] = [];
  private readonly preRollMs: number;

  private meterTimer: ReturnType<typeof setInterval> | null = null;
  private readonly meterScratch = new Float32Array(1024);

  private disposed = false;

  constructor(options: CaptureControllerOptions) {
    this.options = options;
    this.preRollMs =
      (options.config?.preRollMs ?? DEFAULT_PRE_ROLL_MS) + PRE_ROLL_SLACK_MS;
  }

  /** Acquire the device, build the graph, and open the capture port. */
  async start(): Promise<void> {
    const constraints: MediaStreamConstraints = {
      audio: {
        ...(this.options.deviceId !== null
          ? { deviceId: { exact: this.options.deviceId } }
          : {}),
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    if (this.disposed) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = stream;

    const context = new AudioContext();
    this.context = context;
    await context.audioWorklet.addModule(workletUrl);
    if (this.disposed) {
      await this.dispose();
      return;
    }

    const source = context.createMediaStreamSource(stream);
    this.sourceNode = source;

    const worklet = new AudioWorkletNode(context, 'pcm-worklet');
    this.workletNode = worklet;
    worklet.port.onmessage = (event: MessageEvent): void => {
      if (event.data instanceof ArrayBuffer) {
        this.handleChunk(event.data);
      }
    };

    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    this.analyser = analyser;

    source.connect(worklet);
    source.connect(analyser);
    // The worklet is a sink for conversion only — do not route to the speakers.

    const port = await this.options.openPort({ sessionId: this.options.sessionId });
    if (this.disposed) {
      port.close();
      await this.dispose();
      return;
    }
    this.port = port;
    port.start?.();

    this.startMeter();
  }

  /** React to the latest mic gate / turn id from StageStateProjection. */
  setGate(gate: MicGate, turnId: string | null): void {
    const opening = this.gate === 'closed' && gate !== 'closed';
    this.gate = gate;
    if (turnId !== null) {
      this.currentTurnId = turnId;
    }
    if (opening) {
      this.flushPreRoll();
    } else if (gate === 'closed') {
      this.preRoll.length = 0;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.stopMeter();
    if (this.workletNode !== null) {
      this.workletNode.port.onmessage = null;
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.analyser !== null) {
      this.analyser.disconnect();
      this.analyser = null;
    }
    if (this.sourceNode !== null) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.port !== null) {
      this.port.close();
      this.port = null;
    }
    if (this.stream !== null) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.context !== null) {
      try {
        await this.context.close();
      } catch {
        // Already closed.
      }
      this.context = null;
    }
    this.preRoll.length = 0;
  }

  private handleChunk(payload: ArrayBuffer): void {
    const capturedAtMs = Date.now();

    // Maintain a small pre-roll ring buffer while gated closed so the moment we
    // open we can prepend the most recent audio and not clip the first syllable.
    if (this.gate === 'closed') {
      this.preRoll.push({ capturedAtMs, payload });
      this.trimPreRoll(capturedAtMs);
      return;
    }

    this.forward(payload, capturedAtMs);
  }

  private flushPreRoll(): void {
    if (this.preRoll.length === 0) {
      return;
    }
    const buffered = this.preRoll.splice(0, this.preRoll.length);
    for (const chunk of buffered) {
      this.forward(chunk.payload, chunk.capturedAtMs);
    }
  }

  private trimPreRoll(nowMs: number): void {
    const cutoff = nowMs - this.preRollMs;
    while (this.preRoll.length > 0) {
      const head = this.preRoll[0];
      if (head !== undefined && head.capturedAtMs < cutoff) {
        this.preRoll.shift();
      } else {
        break;
      }
    }
  }

  private forward(payload: ArrayBuffer, capturedAtMs: number): void {
    const port = this.port;
    if (port === null) {
      return;
    }
    const message: CaptureChunkMessage = {
      sessionId: this.options.sessionId,
      turnId: this.currentTurnId,
      sequence: this.sequence,
      capturedAtMs,
      payload,
    };
    this.sequence += 1;
    port.postMessage(message, [payload]);
  }

  private startMeter(): void {
    this.meterTimer = setInterval(() => this.sampleMeter(), METER_INTERVAL_MS);
  }

  private stopMeter(): void {
    if (this.meterTimer !== null) {
      clearInterval(this.meterTimer);
      this.meterTimer = null;
    }
  }

  private sampleMeter(): void {
    const analyser = this.analyser;
    if (analyser === null) {
      return;
    }
    const scratch = this.meterScratch;
    analyser.getFloatTimeDomainData(scratch);

    let peak = 0;
    let sumSquares = 0;
    for (let i = 0; i < scratch.length; i += 1) {
      const v = scratch[i] ?? 0;
      const abs = v < 0 ? -v : v;
      if (abs > peak) {
        peak = abs;
      }
      sumSquares += v * v;
    }
    const average = Math.sqrt(sumSquares / scratch.length);
    this.options.reportMeter({
      peak,
      average,
      clipping: peak >= 0.999,
    });
  }
}
