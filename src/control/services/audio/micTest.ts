/**
 * Microphone test recorder (spec §28.5 local signal test, §28.7 retention).
 *
 * Records a short clip strictly to memory for immediate playback, and is
 * always explicitly discarded — no microphone audio is written to disk.
 */
import type { Clock, MediaStreamLike, RecorderFactory, RecorderLike } from './types';

export interface MicTestClip {
  blob: Blob;
  durationMs: number;
  mimeType: string;
}

export interface MicTestRecorderDeps {
  createRecorder: RecorderFactory;
  now?: Clock;
  /** Injected for tests; defaults to URL.createObjectURL/revokeObjectURL. */
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
}

/** Default recorder factory for the real WebView. */
export const createMediaRecorder: RecorderFactory = (stream) =>
  new MediaRecorder(stream as unknown as MediaStream) as unknown as RecorderLike;

export class MicTestRecorder {
  private recorder: RecorderLike | null = null;
  private chunks: Blob[] = [];
  private clip: MicTestClip | null = null;
  private playbackUrl: string | null = null;
  private startedAtMs = 0;
  private stopResolve: ((clip: MicTestClip | null) => void) | null = null;
  private readonly now: Clock;

  constructor(private readonly deps: MicTestRecorderDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  get recording(): boolean {
    return this.recorder !== null && this.recorder.state === 'recording';
  }

  getClip(): MicTestClip | null {
    return this.clip;
  }

  /** Begin recording into memory. Any previous clip is discarded first. */
  start(stream: MediaStreamLike): void {
    this.discard();
    this.chunks = [];
    this.startedAtMs = this.now();
    const recorder = this.deps.createRecorder(stream);
    this.recorder = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) this.chunks.push(event.data);
    };
    recorder.onstop = () => this.finalize();
    recorder.onerror = () => this.finalize();
    recorder.start();
  }

  /** Stop and resolve with the in-memory clip (null if nothing captured). */
  stop(): Promise<MicTestClip | null> {
    const recorder = this.recorder;
    if (!recorder || recorder.state === 'inactive') {
      return Promise.resolve(this.clip);
    }
    return new Promise((resolve) => {
      this.stopResolve = resolve;
      recorder.stop();
    });
  }

  /** Object URL for playback in an <audio> element. Revoked on discard. */
  createPlaybackUrl(): string | null {
    if (!this.clip) return null;
    if (this.playbackUrl) return this.playbackUrl;
    const create = this.deps.createObjectUrl ?? ((blob: Blob) => URL.createObjectURL(blob));
    this.playbackUrl = create(this.clip.blob);
    return this.playbackUrl;
  }

  /**
   * Drop the clip and every buffered chunk (spec §28.7: discard after test;
   * nothing persists past the recorder's lifetime).
   */
  discard(): void {
    if (this.playbackUrl) {
      const revoke = this.deps.revokeObjectUrl ?? ((url: string) => URL.revokeObjectURL(url));
      revoke(this.playbackUrl);
      this.playbackUrl = null;
    }
    this.chunks = [];
    this.clip = null;
    this.recorder = null;
  }

  private finalize(): void {
    const durationMs = Math.max(0, this.now() - this.startedAtMs);
    if (this.chunks.length > 0) {
      const first = this.chunks[0];
      const mimeType = first && first.type ? first.type : 'audio/webm';
      this.clip = { blob: new Blob(this.chunks, { type: mimeType }), durationMs, mimeType };
    } else {
      this.clip = null;
    }
    this.chunks = [];
    this.recorder = null;
    if (this.stopResolve) {
      this.stopResolve(this.clip);
      this.stopResolve = null;
    }
  }
}
