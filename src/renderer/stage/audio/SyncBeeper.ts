/**
 * Web Audio engine that emits a short, sharp tone at interview session start.
 *
 * Purpose: the founder records on a separate camera whose audio has no shared
 * clock with CandidCue's per-turn timeline. Playing one clean transient through
 * the default output (room speakers) gives that camera mic a single audible
 * anchor; combined with the app's per-turn timecodes, an editor can align every
 * answer to a position in the camera file.
 *
 * A single sharp pulse — not a multi-beep clapper — is deliberate: it is the
 * easiest shape to detect algorithmically and to eyeball on a waveform.
 *
 * Mirrors {@link SpeechPlayer}'s `AudioContext` lifecycle: own the context, call
 * `resume()` immediately before scheduling, and schedule against the monotonic
 * audio clock rather than `setTimeout`.
 */

/** Tone pitch; ~880 Hz cuts through ambient room noise with a sharp transient. */
const BEEP_FREQ_HZ = 880;
/** Peak amplitude; full 1.0 on a raw oscillator is jarring, 0.8 is audible but not harsh. */
const BEEP_PEAK_GAIN = 0.8;
/** Linear attack to peak — short enough to stay a crisp onset for alignment. */
const BEEP_ATTACK_S = 0.005;
/** Sustain at peak before the release begins. */
const BEEP_SUSTAIN_S = 0.04;
/** Exponential release time-constant; ~3x this decays to near-silence. */
const BEEP_RELEASE_TC_S = 0.015;
/** Total scheduled lifetime of the oscillator (attack + sustain + tail). */
const BEEP_DURATION_S = 0.08;

export class SyncBeeper {
  private readonly context: AudioContext;

  constructor() {
    this.context = new AudioContext();
  }

  /**
   * Play the sync tone once. Fire-and-forget: any failure (suspended context
   * that won't resume, a closed context during teardown) is swallowed so a
   * session start is never blocked by the marker.
   */
  play(): void {
    void (async () => {
      try {
        await this.context.resume();
        const t = this.context.currentTime;
        const oscillator = this.context.createOscillator();
        const gain = this.context.createGain();

        oscillator.type = 'sine';
        oscillator.frequency.value = BEEP_FREQ_HZ;

        // Envelope: silence -> linear attack -> sustain -> exponential tail. The
        // ramp in/out avoids the click a hard on/off gate would produce.
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(BEEP_PEAK_GAIN, t + BEEP_ATTACK_S);
        gain.gain.setValueAtTime(BEEP_PEAK_GAIN, t + BEEP_ATTACK_S + BEEP_SUSTAIN_S);
        gain.gain.setTargetAtTime(0, t + BEEP_ATTACK_S + BEEP_SUSTAIN_S, BEEP_RELEASE_TC_S);

        oscillator.connect(gain);
        // Default destination = system output, which the external camera mic hears.
        gain.connect(this.context.destination);

        oscillator.start(t);
        oscillator.stop(t + BEEP_DURATION_S);
      } catch {
        // Context closed or could not resume — the interview proceeds silently.
      }
    })();
  }

  async dispose(): Promise<void> {
    try {
      await this.context.close();
    } catch {
      // Context may already be closed.
    }
  }
}
