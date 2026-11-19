/**
 * getUserMedia constraint builder. Pure.
 */

export interface AudioConstraintOptions {
  /** Explicit device, or undefined to follow the system default. */
  deviceId?: string;
  /** Advanced toggles — default all on. */
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
}

/**
 * Build the initial constraints. These are defaults, not
 * guarantees; no sample-rate controls are exposed. `video` is always false.
 */
export function buildAudioConstraints(options: AudioConstraintOptions = {}): MediaStreamConstraints {
  const audio: MediaTrackConstraints = {
    channelCount: 1,
    echoCancellation: options.echoCancellation ?? true,
    noiseSuppression: options.noiseSuppression ?? true,
    autoGainControl: options.autoGainControl ?? true,
  };
  if (options.deviceId !== undefined && options.deviceId !== '') {
    audio.deviceId = { exact: options.deviceId };
  }
  return { audio, video: false };
}
