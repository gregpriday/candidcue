/**
 * Audio failure-state detection (spec §28.6).
 *
 * Covers the locally detectable failures: permission denied/dismissed, no
 * input devices, device busy, device unplugged, track ended, silent input.
 * Transport-side failures (negotiation, connection loss, missing transcript
 * events) live in the realtime package.
 */
import type { AppErrorCode } from '../../../shared/contracts';
import type { AudioLevelSnapshot } from '../../../shared/contracts';
import type { Clock, MediaStreamTrackLike } from './types';
import { DEFAULT_SILENT_INPUT_MS } from './defaults';

/** Map a getUserMedia rejection to a stable app error code (spec §28.6/E.7). */
export function classifyGetUserMediaError(error: unknown): AppErrorCode {
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? String((error as { name: unknown }).name)
      : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      // Covers both explicit denial and a dismissed prompt.
      return 'MIC_PERMISSION_DENIED';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      // Requested/saved device does not exist (or no inputs at all).
      return 'MIC_DEVICE_MISSING';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      // Device exists but is busy or unavailable.
      return 'MIC_DEVICE_LOST';
    default:
      return 'MIC_DEVICE_MISSING';
  }
}

export type TrackFailure = 'track_ended' | 'track_muted' | 'track_recovered';

/**
 * Watch a live microphone track for the "track ended" / "device gone"
 * failure states. Emits once per state change; `dispose` removes listeners.
 */
export function watchTrackHealth(
  track: MediaStreamTrackLike,
  onFailure: (failure: TrackFailure, code: AppErrorCode | null) => void,
): () => void {
  const onEnded = () => onFailure('track_ended', 'MIC_DEVICE_LOST');
  const onMute = () => onFailure('track_muted', null);
  const onUnmute = () => onFailure('track_recovered', null);
  track.addEventListener('ended', onEnded);
  track.addEventListener('mute', onMute);
  track.addEventListener('unmute', onUnmute);
  return () => {
    track.removeEventListener('ended', onEnded);
    track.removeEventListener('mute', onMute);
    track.removeEventListener('unmute', onUnmute);
  };
}

/**
 * Silent-input detector (spec §28.6 "silent input", §28.5 no-signal warning).
 * Feed it level snapshots; it raises MIC_NO_SIGNAL after a sustained period
 * with no signal present, and resets as soon as signal returns.
 */
export class SilentInputDetector {
  private silentSinceMs: number | null = null;
  private raised = false;

  constructor(
    private readonly thresholdMs: number = DEFAULT_SILENT_INPUT_MS,
    private readonly now: Clock = () => Date.now(),
  ) {}

  /** Returns 'MIC_NO_SIGNAL' exactly once per silent stretch, else null. */
  observe(snapshot: AudioLevelSnapshot): AppErrorCode | null {
    if (snapshot.signalPresent) {
      this.silentSinceMs = null;
      this.raised = false;
      return null;
    }
    const at = Number.isFinite(snapshot.generatedAtMs) ? snapshot.generatedAtMs : this.now();
    if (this.silentSinceMs === null) this.silentSinceMs = at;
    if (!this.raised && at - this.silentSinceMs >= this.thresholdMs) {
      this.raised = true;
      return 'MIC_NO_SIGNAL';
    }
    return null;
  }

  reset(): void {
    this.silentSinceMs = null;
    this.raised = false;
  }
}
