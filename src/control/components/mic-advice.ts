/**
 * Input-level interpretation for MicMeter (spec §14.2 C, copy from F.4).
 *
 * The raw AudioLevelSnapshot is a per-frame reading at ~90 ms, so a naive
 * mapping flickers: `clipped` is momentary and `speaking` drops out between
 * words. This module keeps a tiny amount of history — a decaying peak hold
 * and a clip latch — so the meter states a problem long enough for the
 * operator to read it, and pairs every problem with the remedy from F.4.
 *
 * Pure and time-injected so the behaviour is unit-testable.
 */
import type { AudioLevelSnapshot } from '../../shared/contracts';

export type MicCondition = 'idle' | 'clipping' | 'no_signal' | 'too_low' | 'quiet' | 'speaking';

/** How long a momentary clip keeps the warning on screen. */
export const CLIP_HOLD_MS = 1500;
/** Window over which the loudest peak is remembered. */
export const PEAK_HOLD_MS = 3000;
/** Peak below which a present signal is judged too quiet to transcribe well. */
export const TOO_LOW_PEAK = 0.12;
/**
 * How long the input must be continuously absent before the meter says so.
 *
 * `signalPresent` is a per-frame reading at ~90 ms, and it goes false in the
 * gap between two words. Reporting `no_signal` from one frame meant the meter
 * accused the microphone of being unusable every time the speaker drew breath —
 * "as soon as the volume goes down it says it can't hear you" — and then took
 * it back a moment later, which is both wrong and the source of the flicker.
 *
 * Silence is only news if it lasts. Two and a half seconds is longer than any
 * pause inside a sentence and shorter than the patience of someone who has
 * genuinely selected the wrong input device.
 */
export const NO_SIGNAL_AFTER_MS = 2500;

export interface MicAdviceState {
  /** Loudest peak inside the hold window. */
  peak: number;
  peakAtMs: number;
  /** When a clip was last observed (-Infinity when never). */
  clippedAtMs: number;
  /** When signal was last present (-Infinity when never). */
  signalAtMs: number;
  /** Set once any frame has been measured; before that the meter is idle. */
  measured: boolean;
}

export const INITIAL_MIC_ADVICE_STATE: MicAdviceState = {
  peak: 0,
  peakAtMs: -Infinity,
  clippedAtMs: -Infinity,
  signalAtMs: -Infinity,
  measured: false,
};

/** Fold one level frame into the held state. */
export function reduceMicLevel(
  state: MicAdviceState,
  level: AudioLevelSnapshot,
  nowMs: number,
): MicAdviceState {
  const expired = nowMs - state.peakAtMs > PEAK_HOLD_MS;
  const peak = expired || level.peak >= state.peak ? level.peak : state.peak;
  return {
    peak,
    peakAtMs: expired || level.peak >= state.peak ? nowMs : state.peakAtMs,
    clippedAtMs: level.clipped ? nowMs : state.clippedAtMs,
    signalAtMs: level.signalPresent ? nowMs : state.signalAtMs,
    measured: true,
  };
}

export function micCondition(
  level: AudioLevelSnapshot | null,
  state: MicAdviceState,
  nowMs: number,
): MicCondition {
  if (level === null || !state.measured) return 'idle';
  if (level.clipped || nowMs - state.clippedAtMs < CLIP_HOLD_MS) return 'clipping';
  if (level.speaking) return 'speaking';
  // A gap between words is not a broken microphone. Only a sustained absence
  // — and one with no recent peak behind it — is worth reporting as one.
  if (!level.signalPresent) {
    const heardRecently = nowMs - state.signalAtMs < NO_SIGNAL_AFTER_MS;
    return heardRecently ? 'quiet' : 'no_signal';
  }
  // Sustained presence that never gets loud enough to read reliably.
  if (state.peak < TOO_LOW_PEAK) return 'too_low';
  return 'quiet';
}

/** Short status word beside the meter (spec §20: state is also text). */
export const MIC_STATUS_LABEL: Record<MicCondition, string> = {
  idle: 'No signal yet',
  clipping: 'Clipping',
  no_signal: 'No signal',
  too_low: 'Too quiet',
  quiet: 'Quiet',
  speaking: 'Hearing you',
};

/**
 * The line under the meter. Every condition has one — including the good ones.
 *
 * Three of these used to be `null`, so the line existed only while something
 * was wrong: it appeared the moment you stopped talking, vanished when you
 * started again, and took the layout below it along for the ride. Speaking into
 * a microphone to test it is precisely when the level moves the most, so the
 * only time the advice flickered was the only time anyone was looking at it.
 *
 * A line that is always present costs one row and removes the whole class of
 * problem. The remedies for the fault states are still verbatim from Appendix
 * F.4 — naming a problem without saying what to do about it is not worth
 * showing — and the healthy states simply say what is true.
 */
export const MIC_ADVICE: Record<MicCondition, string> = {
  idle: 'Say a few words to check the level.',
  clipping: 'The signal is clipping. Reduce the microphone gain for more reliable transcription.',
  no_signal: 'CandidCue cannot hear this microphone. Check the selected device and input level.',
  too_low: 'The signal is very quiet. Move closer or increase the microphone level.',
  quiet: 'Ready when you are — the level moves as you speak.',
  speaking: 'This microphone is working.',
};

/** Meter fill zone for the current frame. */
export function micZone(level: AudioLevelSnapshot | null, condition: MicCondition): 'low' | 'mid' | 'high' {
  if (condition === 'clipping') return 'high';
  const rms = level?.rms ?? 0;
  if (rms > 0.65) return 'high';
  if (rms > 0.35) return 'mid';
  return 'low';
}

/**
 * Gain the meter applies so an ordinary voice fills an ordinary amount of bar.
 *
 * Raw RMS from a typical laptop or USB microphone at conversational distance
 * sits around 0.05–0.15. Drawn as a straight percentage that is a bar which
 * barely leaves the left edge, so the meter read "nearly nothing" while the
 * microphone was working perfectly well — the app appearing not to hear
 * someone it could hear.
 *
 * The normalisation is against the held peak rather than a fixed multiplier, so
 * a quiet microphone and a hot one both end up using most of the bar and the
 * user is not asked to interpret an absolute number that means nothing to them.
 * A floor keeps a genuinely dead input from being amplified into a healthy
 * looking bar, and the CONDITION above is unaffected either way: this changes
 * what is drawn, never what is judged.
 */
export const METER_REFERENCE_PEAK = 0.35;

export function micFillPercent(level: AudioLevelSnapshot | null, state: MicAdviceState): number {
  const rms = level?.rms ?? 0;
  if (rms <= 0) return 0;
  const reference = Math.max(METER_REFERENCE_PEAK, state.peak);
  return Math.round(Math.min(1, rms / reference) * 100);
}
