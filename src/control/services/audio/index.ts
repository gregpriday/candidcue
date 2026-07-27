/**
 * Public API of the audio services package (spec §28).
 *
 * Consumers (the session facade / UI layer) should import from this barrel
 * only. Browser APIs are injected via the interfaces in `types.ts`, so every
 * exported piece of logic is unit-testable without a WebView.
 */
export {
  buildAudioConstraints,
  type AudioConstraintOptions,
} from './constraints';
export {
  queryMicrophonePermission,
  requestMicrophoneAccess,
  releaseStream,
  type MicAccessResult,
  type MicPermissionState,
} from './permissions';
export {
  MicrophoneDeviceManager,
  FOLLOW_SYSTEM_DEFAULT,
  SYSTEM_DEFAULT_DEVICE_ID,
  SYSTEM_DEFAULT_OPTION,
  toAudioDeviceInfos,
  resolveMicrophoneSelection,
  matchRememberedMicrophone,
  microphoneOptions,
  diffDeviceLists,
  type MicrophoneOption,
  type MicrophoneSelection,
  type RememberedMicrophone,
  type ResolvedDevice,
  type DeviceChangeReport,
} from './devices';
export { LocalVad, computeFrameStats, type VadEvent, type FrameStats } from './vad';
export {
  MicrophoneMonitor,
  createAnalyserGraph,
  type MicrophoneMonitorDeps,
} from './levelMeter';
export {
  MicTestRecorder,
  createMediaRecorder,
  type MicTestClip,
  type MicTestRecorderDeps,
} from './micTest';
export {
  classifyGetUserMediaError,
  watchTrackHealth,
  SilentInputDetector,
  type TrackFailure,
} from './failures';
export {
  DEFAULT_VAD_CONFIG,
  DEFAULT_ANALYSIS_INTERVAL_MS,
  DEFAULT_SILENT_INPUT_MS,
  DEFAULT_SOFT_PAUSE_AUTO_DISCONNECT_MS,
  MIC_TEST_METER_SECONDS,
  VAD_SENSITIVITY_BOUNDS,
  vadConfigForSensitivity,
  type VadConfig,
} from './defaults';
export type {
  MediaStreamLike,
  MediaStreamTrackLike,
  MediaDevicesLike,
  MediaDeviceInfoLike,
  PermissionsLike,
  PermissionStatusLike,
  AnalyserLike,
  AudioAnalysisGraph,
  AnalysisGraphFactory,
  RecorderLike,
  RecorderFactory,
  IntervalScheduler,
  TimerHandle,
  Clock,
} from './types';
