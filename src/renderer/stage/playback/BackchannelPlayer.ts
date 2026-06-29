import type { ListeningClipRef } from '@shared/contracts';

/**
 * Plays a short, pre-decoded verbal acknowledgment ("mm-hm", "got it") the
 * instant a turn commits (#53), filling the silent gap while STT finalizes and
 * the next question's TTS synthesizes.
 *
 * Latency is the whole point: at session bootstrap we fetch and decode every
 * backchannel clip once, so `play()` just starts an already-decoded buffer —
 * a few milliseconds, no IPC round-trip, no callbacks. It is fire-and-forget;
 * the orchestrator never waits on it.
 *
 * Owns its own AudioContext (independent of SpeechPlayer). The backchannel
 * plays during the THINKING visual state, never over Mira's speech, so there is
 * no output-device routing to share — the default destination is correct.
 */
export class BackchannelPlayer {
  private readonly context: AudioContext;
  private buffers: AudioBuffer[] = [];
  private disposed = false;

  constructor() {
    this.context = new AudioContext();
  }

  /**
   * Fetch + decode every backchannel clip once. Individual fetch/decode
   * failures are skipped so one bad clip can't sink the rest. Safe to call with
   * an empty list — the character simply ships no backchannel clips and
   * `play()` becomes a no-op.
   */
  async init(clips: ListeningClipRef[]): Promise<void> {
    if (clips.length === 0) {
      // Optional feature: a character with no backchannel clips is normal, not
      // an error. Note it once so its absence is observable but not noisy.
      console.info('backchannel.no_clips');
      return;
    }
    const decoded = await Promise.all(
      clips.map(async (clip) => {
        try {
          const response = await fetch(clip.url);
          const bytes = await response.arrayBuffer();
          // decodeAudioData detaches its input; the fetched buffer is ours to consume.
          return await this.context.decodeAudioData(bytes);
        } catch {
          return null;
        }
      }),
    );
    if (this.disposed) {
      return; // disposed mid-decode; don't retain buffers on a closing context
    }
    this.buffers = decoded.filter((b): b is AudioBuffer => b !== null);
    // The stage window receives no direct user gestures (it is driven by IPC),
    // so this context can start suspended and never leave it — leaving play()
    // to silently no-op at commit. Resume now, at bootstrap, where the latency
    // is irrelevant; play() must stay synchronous to fire the instant a turn
    // commits. Fire-and-forget: a rejected resume just leaves play() guarded.
    if (this.buffers.length > 0 && this.context.state === 'suspended') {
      void this.context.resume().catch(() => {});
    }
  }

  /**
   * Play a random backchannel clip immediately. No-op when there are no clips,
   * the context isn't running (suspended before the first user gesture), or the
   * stage is currently speaking (never talk over Mira). Fire-and-forget: the
   * source plays out and is garbage-collected; nothing is reported back.
   */
  play(visualState: string): void {
    if (this.disposed || this.buffers.length === 0) {
      return;
    }
    if (this.context.state !== 'running') {
      return; // suspended context: skip rather than queue a stale acknowledgment
    }
    if (visualState === 'speaking') {
      return; // don't overlap Mira's spoken audio
    }
    const buffer = this.buffers[Math.floor(Math.random() * this.buffers.length)]!;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    source.start(0);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.buffers = [];
    try {
      await this.context.close();
    } catch {
      // Context may already be closed.
    }
  }
}
