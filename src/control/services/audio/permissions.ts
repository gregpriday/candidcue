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
  | {
      ok: true;
      stream: MediaStreamLike;
      /** How many `getUserMedia` calls it took. 1 on the ordinary path. */
      attempts: number;
      /**
       * True when the pinned device was busy and the system default was taken
       * instead. The caller is told rather than quietly handed a different
       * microphone — §28.2 says which input is in use is the user's business.
       */
      fellBackToDefault: boolean;
    }
  | { ok: false; code: AppErrorCode; cause?: unknown; attempts: number };

/**
 * How many times a BUSY device is asked for before giving up.
 *
 * ---------------------------------------------------------------------------
 * WHY A RETRY EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * macOS does not free an input device the instant `track.stop()` returns.
 * CoreAudio tears the capture down asynchronously — measurements and every
 * production WebRTC client (LiveKit, Twilio, Daily all ship the same loop) put
 * the window at roughly 200–500 ms — and a `getUserMedia` inside that window is
 * rejected with `NotReadableError` or `AbortError` rather than made to wait.
 *
 * This app hands the microphone over exactly there: the Preflight meter holds a
 * capture, the take releases it and immediately opens its own. Whether the
 * handover lands inside CoreAudio's window depends on how long the intervening
 * work took, which is why the symptom is "sometimes it does not pick up the
 * microphone" rather than a reproducible failure — the same code path, decided
 * by a few hundred milliseconds of unrelated IPC.
 *
 * Four attempts at 250/500/1000 ms cover ~1.75 s of contention, which is several
 * times the observed window, and the whole thing costs nothing when the device
 * is free (the first call succeeds and no delay is ever taken).
 */
export const MIC_ACQUIRE_ATTEMPTS = 4;

/** First backoff step; doubles per attempt (250 → 500 → 1000 ms). */
export const MIC_ACQUIRE_BACKOFF_MS = 250;

export interface MicAcquireRetry {
  attempts?: number;
  backoffMs?: number;
  /** Injected so tests do not spend real seconds proving the backoff. */
  sleep?: (ms: number) => Promise<void>;
  /** Called before each retry, for the audio trace. */
  onRetry?: (attempt: number, code: AppErrorCode, delayMs: number) => void;
  /**
   * Whether a still-busy pinned device may be abandoned for the system default
   * on the final attempt. OFF unless asked for.
   *
   * It is the right trade for a TAKE — presenting from the built-in microphone
   * beats not presenting, and the pipeline says so out loud when it happens.
   * It is the wrong one everywhere else: a Preflight meter that silently
   * measured a different microphone from the one named above it, or a
   * transcription test that passed on an input the take will not use, is a
   * diagnostic that lies. Those callers would rather fail and say the device
   * is busy.
   */
  allowDefaultFallback?: boolean;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Open the microphone (this is the call that may trigger the OS prompt —
 * invoke it only from an explicit user action such as the onboarding
 * microphone step or a mic test, per spec §28.1).
 *
 * Verifies an active audio track (spec §29.2 step 4); a stream with no live
 * track is treated as MIC_DEVICE_MISSING and closed.
 *
 * A device that is merely BUSY is retried with backoff (see
 * {@link MIC_ACQUIRE_ATTEMPTS}). Nothing else is: a denied permission and an
 * absent device are both answers, and asking again four times does not change
 * either one — it only delays telling the user something they can act on.
 */
export async function requestMicrophoneAccess(
  mediaDevices: MediaDevicesLike,
  options: AudioConstraintOptions = {},
  retry: MicAcquireRetry = {},
): Promise<MicAccessResult> {
  const attempts = Math.max(1, retry.attempts ?? MIC_ACQUIRE_ATTEMPTS);
  const backoffMs = Math.max(0, retry.backoffMs ?? MIC_ACQUIRE_BACKOFF_MS);
  const sleep = retry.sleep ?? defaultSleep;
  let last: { code: AppErrorCode; cause?: unknown } = { code: 'MIC_DEVICE_MISSING' };

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    /*
     * The final attempt drops a pinned device id.
     *
     * A device that has been busy for nearly two seconds is being held by
     * something this app cannot see — another application, or a capture of our
     * own that failed to release — and the system default is very often a
     * different device that is free. Presenting from the built-in microphone
     * beats not presenting, and the caller is told it happened.
     */
    const lastChance = attempt === attempts && attempts > 1;
    const fallingBack =
      lastChance && retry.allowDefaultFallback === true && options.deviceId !== undefined;
    const constraints = buildAudioConstraints(
      fallingBack ? { ...options, deviceId: undefined } : options,
    );

    let stream: MediaStreamLike;
    try {
      stream = await mediaDevices.getUserMedia(constraints);
    } catch (cause) {
      last = { code: classifyGetUserMediaError(cause), cause };
      if (!isBusy(last.code) || attempt === attempts) {
        return { ok: false, ...last, attempts: attempt };
      }
      const delayMs = backoffMs * 2 ** (attempt - 1);
      retry.onRetry?.(attempt, last.code, delayMs);
      await sleep(delayMs);
      continue;
    }

    const track = stream.getAudioTracks()[0];
    if (track && track.readyState === 'live') {
      return { ok: true, stream, attempts: attempt, fellBackToDefault: fallingBack };
    }
    /*
     * A stream whose track is already dead is the same transient as an outright
     * rejection — the device was handed over while it was still being released —
     * so it is retried on the same schedule rather than reported as a missing
     * device on the first try.
     */
    for (const t of stream.getTracks()) t.stop();
    last = { code: 'MIC_DEVICE_MISSING' };
    if (attempt === attempts) return { ok: false, ...last, attempts: attempt };
    const delayMs = backoffMs * 2 ** (attempt - 1);
    retry.onRetry?.(attempt, last.code, delayMs);
    await sleep(delayMs);
  }

  return { ok: false, ...last, attempts };
}

/**
 * Codes that mean "the device exists, something else has it" (§28.6).
 *
 * Only this one. `MIC_DEVICE_MISSING` covers NotFound and Overconstrained —
 * the pinned device is gone, or there are no inputs at all — and neither
 * changes by asking again; retrying them would just delay the picker (§28.2)
 * that is the actual remedy. `MIC_PERMISSION_DENIED` is an answer, not a race.
 */
function isBusy(code: AppErrorCode): boolean {
  return code === 'MIC_DEVICE_LOST';
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
