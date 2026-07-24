/**
 * Thin structural interfaces over the browser media APIs used by the audio
 * services. Everything the package touches in the WebView goes through these
 * so the pure logic (VAD, device resolution, failure classification, mic
 * test) is fully unit-testable in a node environment with plain fakes.
 */

export interface MediaStreamTrackLike {
  readonly kind: string;
  readonly label: string;
  readonly readyState: 'live' | 'ended';
  readonly muted?: boolean;
  stop(): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface MediaStreamLike {
  getAudioTracks(): MediaStreamTrackLike[];
  getTracks(): MediaStreamTrackLike[];
}

export interface MediaDeviceInfoLike {
  readonly deviceId: string;
  readonly groupId: string;
  readonly kind: string;
  readonly label: string;
}

export interface MediaDevicesLike {
  enumerateDevices(): Promise<MediaDeviceInfoLike[]>;
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStreamLike>;
  addEventListener(type: 'devicechange', listener: () => void): void;
  removeEventListener(type: 'devicechange', listener: () => void): void;
}

export interface PermissionStatusLike {
  readonly state: 'granted' | 'denied' | 'prompt';
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
}

export interface PermissionsLike {
  query(descriptor: { name: string }): Promise<PermissionStatusLike>;
}

/**
 * Minimal analyser surface (subset of `AnalyserNode`). The concrete graph
 * must never be routed to speakers — analysis only (spec §28.4).
 */
export interface AnalyserLike {
  readonly fftSize: number;
  getFloatTimeDomainData(target: Float32Array): void;
}

/** A built analysis graph: analyser plus teardown of context/source nodes. */
export interface AudioAnalysisGraph {
  analyser: AnalyserLike;
  close(): Promise<void> | void;
}

export type AnalysisGraphFactory = (
  stream: MediaStreamLike,
) => AudioAnalysisGraph | Promise<AudioAnalysisGraph>;

/** Minimal recorder surface (subset of `MediaRecorder`). */
export interface RecorderLike {
  readonly state: 'inactive' | 'recording' | 'paused';
  start(timesliceMs?: number): void;
  stop(): void;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type RecorderFactory = (stream: MediaStreamLike) => RecorderLike;

export interface TimerHandle {
  cancel(): void;
}

/** Injected interval scheduler so meters/watchers are testable. */
export type IntervalScheduler = (callback: () => void, intervalMs: number) => TimerHandle;

export type Clock = () => number;

export const defaultIntervalScheduler: IntervalScheduler = (callback, intervalMs) => {
  const id = setInterval(callback, intervalMs);
  return { cancel: () => clearInterval(id) };
};
