import type { SpeechPlaybackPlan } from '@shared/contracts';

/**
 * Web Audio engine that owns the interviewer's spoken audio for a turn.
 *
 * Lifecycle per plan:
 *  1. `load(plan)`  decode the WAV bytes, then `reportReady`.
 *  2. `start()`     called when the visual state becomes 'speaking'; plays the
 *                   decoded buffer and `reportStarted`.
 *  3. on `ended`    `reportEnded` — audio end is authoritative for the turn.
 *
 * Output routing: we attempt `setSinkId` on a hidden <audio> element when an
 * explicit output device was chosen and the platform supports it; otherwise we
 * fall back to the default destination. Nothing about routing is surfaced on
 * stage.
 */

type ReportReady = (input: { turnId: string }) => void;
type ReportStarted = (input: { turnId: string; atMs: number }) => void;
type ReportEnded = (input: { turnId: string; atMs: number }) => void;
type ReportError = (input: { turnId: string; reason: string }) => void;

export interface SpeechPlayerCallbacks {
  reportReady: ReportReady;
  reportStarted: ReportStarted;
  reportEnded: ReportEnded;
  reportError: ReportError;
  /** Fired locally so the deck can return to listening when speech finishes. */
  onEnded: (turnId: string) => void;
}

interface LoadedTurn {
  turnId: string;
  buffer: AudioBuffer;
  outputDeviceId: string | null;
}

export class SpeechPlayer {
  private readonly callbacks: SpeechPlayerCallbacks;
  private readonly context: AudioContext;
  /** Hidden element used purely to pin Web Audio output to a chosen device. */
  private readonly sinkElement: HTMLAudioElement;
  private sinkNode: MediaStreamAudioDestinationNode | null = null;

  private loaded: LoadedTurn | null = null;
  private source: AudioBufferSourceNode | null = null;
  private startedTurnId: string | null = null;

  constructor(callbacks: SpeechPlayerCallbacks) {
    this.callbacks = callbacks;
    this.context = new AudioContext();

    const el = document.createElement('audio');
    el.autoplay = true;
    // Keep it out of the layout/AT tree; it is an audio sink only.
    el.setAttribute('aria-hidden', 'true');
    el.style.display = 'none';
    document.body.appendChild(el);
    this.sinkElement = el;
  }

  /**
   * Decode a plan's audio and signal readiness. Safe to call repeatedly; the
   * most recently loaded turn wins.
   */
  async load(plan: SpeechPlaybackPlan): Promise<void> {
    const { turnId } = plan;
    try {
      // decodeAudioData detaches the buffer, so decode a copy and keep the
      // original plan bytes intact for any later use.
      const copy = plan.audio.bytes.slice(0);
      const buffer = await this.context.decodeAudioData(copy);
      this.loaded = {
        turnId,
        buffer,
        outputDeviceId: plan.audio.outputDeviceId,
      };
      this.callbacks.reportReady({ turnId });
    } catch (error) {
      this.callbacks.reportError({
        turnId,
        reason: error instanceof Error ? error.message : 'decode_failed',
      });
    }
  }

  /**
   * Begin playing the loaded turn. No-op unless the loaded turn matches and is
   * not already playing.
   */
  start(): void {
    const loaded = this.loaded;
    if (loaded === null) {
      return;
    }
    if (this.startedTurnId === loaded.turnId) {
      return;
    }

    void this.routeOutput(loaded.outputDeviceId);

    const source = this.context.createBufferSource();
    source.buffer = loaded.buffer;
    source.connect(this.context.destination);

    const turnId = loaded.turnId;
    source.onended = (): void => {
      // Ignore ended events from a source we have already superseded/stopped.
      if (this.source !== source) {
        return;
      }
      this.source = null;
      this.callbacks.reportEnded({ turnId, atMs: Date.now() });
      this.callbacks.onEnded(turnId);
    };

    void this.context.resume().finally(() => {
      // Guard against a newer turn having been started while resuming.
      if (this.source !== source) {
        return;
      }
      source.start();
      this.callbacks.reportStarted({ turnId, atMs: Date.now() });
    });

    this.source = source;
    this.startedTurnId = turnId;
  }

  /** Stop any in-flight playback without reporting an end for the turn. */
  stop(): void {
    if (this.source !== null) {
      const source = this.source;
      this.source = null;
      try {
        source.onended = null;
        source.stop();
      } catch {
        // Already stopped / never started — nothing to do.
      }
    }
    this.startedTurnId = null;
  }

  async dispose(): Promise<void> {
    this.stop();
    this.sinkElement.remove();
    if (this.sinkNode !== null) {
      this.sinkNode.disconnect();
      this.sinkNode = null;
    }
    try {
      await this.context.close();
    } catch {
      // Context may already be closed.
    }
  }

  /**
   * Best-effort pinning of the Web Audio graph to a specific output device.
   * When unsupported (no `setSinkId`) we simply stay on the default output.
   */
  private async routeOutput(outputDeviceId: string | null): Promise<void> {
    if (outputDeviceId === null || outputDeviceId === '') {
      return;
    }
    // `setSinkId` is gated behind platform support; treat its absence as default.
    const el = this.sinkElement as HTMLAudioElement & {
      setSinkId?(deviceId: string): Promise<void>;
    };
    if (typeof el.setSinkId !== 'function') {
      return;
    }
    try {
      if (this.sinkNode === null) {
        this.sinkNode = this.context.createMediaStreamDestination();
        // Mirror the graph into the element so its sink selection takes effect.
        this.context.destination.channelInterpretation = 'speakers';
        this.sinkElement.srcObject = this.sinkNode.stream;
      }
      await el.setSinkId(outputDeviceId);
    } catch {
      // Fall back to the default output silently.
    }
  }
}
