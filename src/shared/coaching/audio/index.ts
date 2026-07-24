/**
 * Public surface of the local audio-analysis pipeline (§12, §13).
 *
 * The seam types themselves — `AudioFrameFeatures`, `SpeechInterval`,
 * `PitchReliability`, `MicrophoneCoachState` — live in
 * `shared/contracts/coaching.ts` and are re-exported by that module, not this
 * one. Everything here is machinery that *produces* them.
 *
 * `audio-worklet.ts` is deliberately absent: it has no exports and calls
 * `registerProcessor` on import, so it must only ever be reached through
 * `audioWorklet.addModule()`, never through this barrel.
 */
export {
  PcmRingBuffer,
  RING_BUFFER_DEFAULT_SECONDS,
  RING_BUFFER_MAX_SECONDS_WITHOUT_CONSENT,
  RING_BUFFER_MAX_SECONDS_WITH_CONSENT,
  type PcmRingBufferOptions,
  type RingBufferClearReason,
} from './ring-buffer';

export {
  amplitudeToDbfs,
  clamp01,
  CLIP_AMPLITUDE,
  DBFS_FLOOR,
  frameClippingRatio,
  FrameFeatureExtractor,
  framePeakDbfs,
  frameRmsDbfs,
  frameZeroCrossingRate,
  packFrame,
  PACKED_FRAME_FIELDS,
  speechProbabilityFromSnr,
  SpectralFluxAnalyzer,
  unpackFrame,
  type FrameFeatureOptions,
} from './frame-features';

export { NoiseFloorEstimator, type NoiseFloorOptions } from './noise-estimator';

export {
  SpeechClock,
  type ClosedSpeechInterval,
  type SpeechClockOptions,
} from './vad';

export {
  PitchDecimator,
  PITCH_ANALYSIS_RATE_HZ,
  PITCH_HOP_MS,
  PITCH_MAX_HZ,
  PITCH_MIN_HZ,
  PITCH_WINDOW_MS,
  YinDetector,
  type YinOptions,
  type YinResult,
} from './pitch-yin';

export {
  PitchTracker,
  type PitchSample,
  type PitchTrackerOptions,
} from './pitch-tracker';

export {
  MicrophoneHealthMonitor,
  type MicrophoneConditionHold,
  type MicrophoneHealthOptions,
} from './microphone-health';

export {
  COACHING_WORKLET_PROCESSOR,
  WorkletAudioCore,
  type CoachingWorkletCommand,
  type CoachingWorkletMessage,
  type WorkletCoreDiagnostics,
  type WorkletCoreOptions,
} from './worklet-core';

export {
  attachCoachingAnalyzer,
  decodeFrames,
  type AudioContextLike,
  type AudioNodeLike,
  type AudioWorkletNodeLike,
  type CoachingAnalyzerDeps,
  type CoachingAnalyzerGraph,
  type MediaStreamHandle,
  type WorkletPortLike,
} from './worklet-node';

export { Biquad, DcBlocker } from './filters';
export { RealFft } from './fft';
