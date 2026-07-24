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

/** Meter/VAD analysis frame cadence in milliseconds. */
export const DEFAULT_ANALYSIS_INTERVAL_MS = 50;

/** Local signal test length (spec §28.5: 10-second live meter). */
export const MIC_TEST_METER_SECONDS = 10;

/** Sustained no-signal duration before MIC_NO_SIGNAL is raised. */
export const DEFAULT_SILENT_INPUT_MS = 5000;

/** Soft-pause auto-disconnect default (A.6: 10 minutes). */
export const DEFAULT_SOFT_PAUSE_AUTO_DISCONNECT_MS = 10 * 60 * 1000;
