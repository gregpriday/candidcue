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

export interface MicAdviceState {
  /** Loudest peak inside the hold window. */
  peak: number;
  peakAtMs: number;
  /** When a clip was last observed (-Infinity when never). */
  clippedAtMs: number;
  /** Set once any frame has been measured; before that the meter is idle. */
  measured: boolean;
}

export const INITIAL_MIC_ADVICE_STATE: MicAdviceState = {
  peak: 0,
  peakAtMs: -Infinity,
  clippedAtMs: -Infinity,
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
  if (!level.signalPresent) return 'no_signal';
  if (level.speaking) return 'speaking';
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
 * The remedy, verbatim from Appendix F.4. A problem state that names the
 * problem without saying what to do about it is not worth showing.
 */
export const MIC_ADVICE: Record<MicCondition, string | null> = {
  idle: null,
  clipping: 'The signal is clipping. Reduce the microphone gain for more reliable transcription.',
  no_signal: 'CandidCue cannot hear this microphone. Check the selected device and input level.',
  too_low: 'The signal is very quiet. Move closer or increase the microphone level.',
  quiet: null,
  speaking: null,
};

/** Meter fill zone for the current frame. */
export function micZone(level: AudioLevelSnapshot | null, condition: MicCondition): 'low' | 'mid' | 'high' {
  if (condition === 'clipping') return 'high';
  const rms = level?.rms ?? 0;
  if (rms > 0.65) return 'high';
  if (rms > 0.35) return 'mid';
  return 'low';
}
