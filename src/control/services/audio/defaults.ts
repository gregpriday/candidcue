/**
 * Realtime audio defaults (spec Appendix A.6). These are evaluation
 * parameters surfaced in one place — not magic numbers scattered through the
 * codebase (spec §28.4).
 */

export interface VadConfig {
  /** Sustained level above threshold before speech opens (A.6: 100 ms). */
  speechOpenMs: number;
  /** Silence duration that closes a turn and triggers commit (A.6: 420 ms). */
  endOfTurnSilenceMs: number;
  /** Force a commit after this much continuous speech (A.6: 5 s). */
  maxUtteranceMs: number;
  /** Ambient noise-floor calibration window (A.6: 2 s). */
  calibrationMs: number;
  /** Speech threshold = max(minSpeechRms, noiseFloor * noiseFloorMargin). */
  noiseFloorMargin: number;
  /** Absolute RMS floor below which input is never treated as speech. */
  minSpeechRms: number;
  /** Peak amplitude at or above which a frame counts as clipped. */
  clipPeak: number;
  /** RMS below this for the whole window means "no signal present". */
  signalPresentRms: number;
  /** EMA factor for the smoothed level exposed to meters (0..1). */
  levelSmoothing: number;
}

export const DEFAULT_VAD_CONFIG: VadConfig = {
  speechOpenMs: 100,
  endOfTurnSilenceMs: 420,
  maxUtteranceMs: 5000,
  calibrationMs: 2000,
  noiseFloorMargin: 2.5,
  minSpeechRms: 0.01,
  clipPeak: 0.985,
  signalPresentRms: 0.0015,
  levelSmoothing: 0.25,
};

/**
 * Bounds for the Settings → Audio "Local voice-detection sensitivity" slider.
 *
 * The slider is 0–1 with 0.5 meaning "exactly the A.6 defaults", and it moves
 * the SPEECH THRESHOLD only — `noiseFloorMargin` and the absolute `minSpeechRms`
 * floor. Endpointing sensitivity is genuinely room- and device-dependent (a
 * condenser in a quiet office and a laptop mic in a hotel room do not share a
 * noise floor), so the control has to do something real.
 *
 * What it must NOT do is move the commit cadence. This VAD is not only a
 * detector: `speech_ended` is the Realtime commit cue (§29.3), so every turn it
 * closes is a billable commit and a transcription round trip. `endOfTurnSilenceMs`
 * (420 ms), `maxUtteranceMs` (5 s) and `calibrationMs` are therefore fixed at
 * their A.6 values at every slider position, which bounds the damage in both
 * directions:
 *
 *  - at maximum sensitivity the threshold sits near the noise floor, so room
 *    tone can hold a turn open — but the unchanged 5 s forced commit still caps
 *    the worst case at one commit every five seconds, and reconciliation stays
 *    bounded because `max_utterance` re-anchors;
 *  - at minimum sensitivity quiet speech drops below threshold more often, so
 *    turns close sooner — but the unchanged 100 ms open plus 420 ms close means
 *    a turn can still never be shorter than about half a second, which is the
 *    floor on commit frequency and therefore on cost.
 *
 * The threshold multiplier is confined to roughly ×0.64…×1.6 of the default
 * margin. That is a deliberately narrow band: wide enough to rescue a noisy room
 * or a quiet talker, too narrow to turn the VAD into something that either never
 * commits or commits on every breath.
 */
export const VAD_SENSITIVITY_BOUNDS = {
  /** `noiseFloorMargin` at sensitivity 0 — hardest to trigger. */
  marginAtMin: 4,
  /** `noiseFloorMargin` at sensitivity 0.5 — the A.6 default. */
  marginAtMid: DEFAULT_VAD_CONFIG.noiseFloorMargin,
  /** `noiseFloorMargin` at sensitivity 1 — easiest to trigger. */
  marginAtMax: 1.6,
  /** `minSpeechRms` at sensitivity 0. */
  floorAtMin: 0.02,
  /** `minSpeechRms` at sensitivity 0.5 — the A.6 default. */
  floorAtMid: DEFAULT_VAD_CONFIG.minSpeechRms,
  /** `minSpeechRms` at sensitivity 1. */
  floorAtMax: 0.005,
} as const;

/**
 * Turn the user's 0–1 sensitivity into a `VadConfig` override.
 *
 * Only the two threshold fields are returned; everything the caller does not see
 * here keeps its A.6 value, which is the whole point — see the bounds above.
 * Out-of-range and non-finite input falls back to the neutral midpoint rather
 * than clamping to an extreme, because a corrupt setting must not silently
 * become the most aggressive configuration available.
 */
export function vadConfigForSensitivity(sensitivity: number): Partial<VadConfig> {
  const s = Number.isFinite(sensitivity) ? Math.max(0, Math.min(1, sensitivity)) : 0.5;
  const b = VAD_SENSITIVITY_BOUNDS;
  return {
    noiseFloorMargin: interpolate(s, b.marginAtMin, b.marginAtMid, b.marginAtMax),
    minSpeechRms: interpolate(s, b.floorAtMin, b.floorAtMid, b.floorAtMax),
  };
}

/**
 * Piecewise-linear through the midpoint, so 0.5 lands exactly on the A.6 value
 * rather than near it. A single linear ramp between the extremes would put the
 * default at 2.8 instead of 2.5 and quietly retune every existing user.
 */
function interpolate(s: number, atMin: number, atMid: number, atMax: number): number {
  return s <= 0.5 ? atMin + (atMid - atMin) * (s / 0.5) : atMid + (atMax - atMid) * ((s - 0.5) / 0.5);
}

/** Meter/VAD analysis frame cadence in milliseconds. */
export const DEFAULT_ANALYSIS_INTERVAL_MS = 50;

/** Local signal test length (spec §28.5: 10-second live meter). */
export const MIC_TEST_METER_SECONDS = 10;

/** Sustained no-signal duration before MIC_NO_SIGNAL is raised. */
export const DEFAULT_SILENT_INPUT_MS = 5000;

/** Soft-pause auto-disconnect default (A.6: 10 minutes). */
export const DEFAULT_SOFT_PAUSE_AUTO_DISCONNECT_MS = 10 * 60 * 1000;
