/**
 * Microphone permission flow helpers (spec §28.1).
 *
 * Rules encoded here:
 * - Never trigger the OS permission prompt on launch. `queryMicrophonePermission`
 *   is strictly passive (Permissions API only; never getUserMedia).
 * - The prompt may only be triggered by an explicit user action —
 *   `requestMicrophoneAccess` is that action and is the single place a
 *   microphone stream is opened.
 */
import type { AppErrorCode } from '../../../shared/contracts';
import { buildAudioConstraints, type AudioConstraintOptions } from './constraints';
import { classifyGetUserMediaError } from './failures';
import type { MediaDevicesLike, MediaStreamLike, PermissionsLike } from './types';

export type MicPermissionState = 'granted' | 'denied' | 'prompt' | 'unsupported';

/**
 * Passively read the current microphone permission state without ever
 * prompting. Safe to call at launch. Returns 'unsupported' where the
 * Permissions API is unavailable or does not know 'microphone' (some
 * WebViews) — callers must then treat state as unknown-until-user-action.
 */
export async function queryMicrophonePermission(
  permissions: PermissionsLike | undefined,
): Promise<MicPermissionState> {
  if (!permissions) return 'unsupported';
  try {
    const status = await permissions.query({ name: 'microphone' });
    return status.state;
  } catch {
    return 'unsupported';
  }
}

export type MicAccessResult =
  | { ok: true; stream: MediaStreamLike }
  | { ok: false; code: AppErrorCode; cause?: unknown };

/**
 * Open the microphone (this is the call that may trigger the OS prompt —
 * invoke it only from an explicit user action such as the onboarding
 * microphone step or a mic test, per spec §28.1).
 *
 * Verifies an active audio track (spec §29.2 step 4); a stream with no live
 * track is treated as MIC_DEVICE_MISSING and closed.
 */
export async function requestMicrophoneAccess(
  mediaDevices: MediaDevicesLike,
  options: AudioConstraintOptions = {},
): Promise<MicAccessResult> {
  let stream: MediaStreamLike;
  try {
    stream = await mediaDevices.getUserMedia(buildAudioConstraints(options));
  } catch (cause) {
    return { ok: false, code: classifyGetUserMediaError(cause), cause };
  }
  const track = stream.getAudioTracks()[0];
  if (!track || track.readyState !== 'live') {
    for (const t of stream.getTracks()) t.stop();
    return { ok: false, code: 'MIC_DEVICE_MISSING' };
  }
  return { ok: true, stream };
}

/** Stop every track and drop references (spec §28.7 retention rules). */
export function releaseStream(stream: MediaStreamLike | null | undefined): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // Track may already be ended; releasing must never throw.
    }
  }
}
