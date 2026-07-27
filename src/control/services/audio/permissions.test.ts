import { describe, expect, it, vi } from 'vitest';
import { queryMicrophonePermission, releaseStream, requestMicrophoneAccess } from './permissions';
import type {
  MediaDevicesLike,
  MediaStreamLike,
  MediaStreamTrackLike,
  PermissionsLike,
} from './types';

function fakeTrack(readyState: 'live' | 'ended' = 'live'): MediaStreamTrackLike & { stopped: boolean } {
  return {
    kind: 'audio',
    label: 'Fake Mic',
    readyState,
    stopped: false,
    stop() {
      this.stopped = true;
    },
    addEventListener() {},
    removeEventListener() {},
  };
}

function fakeStream(tracks: MediaStreamTrackLike[]): MediaStreamLike {
  return { getAudioTracks: () => tracks, getTracks: () => tracks };
}

describe('queryMicrophonePermission (spec §28.1 — passive, never prompts)', () => {
  it('returns the Permissions API state', async () => {
    const permissions: PermissionsLike = {
      query: vi.fn().mockResolvedValue({ state: 'granted', addEventListener() {}, removeEventListener() {} }),
    };
    expect(await queryMicrophonePermission(permissions)).toBe('granted');
  });

  it('returns unsupported without a Permissions API', async () => {
    expect(await queryMicrophonePermission(undefined)).toBe('unsupported');
  });

  it('returns unsupported when the query throws (unknown descriptor)', async () => {
    const permissions: PermissionsLike = { query: vi.fn().mockRejectedValue(new TypeError('nope')) };
    expect(await queryMicrophonePermission(permissions)).toBe('unsupported');
  });
});

describe('requestMicrophoneAccess (spec §28.1/§28.6)', () => {
  it('returns the stream when a live track is present', async () => {
    const track = fakeTrack();
    const stream = fakeStream([track]);
    const media = { getUserMedia: vi.fn().mockResolvedValue(stream) } as unknown as MediaDevicesLike;
    const result = await requestMicrophoneAccess(media, { deviceId: 'mic-1' });
    expect(result.ok).toBe(true);
    expect(media.getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({ video: false, audio: expect.objectContaining({ deviceId: { exact: 'mic-1' } }) }),
    );
  });

  it('classifies a denied prompt', async () => {
    const err = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    const media = { getUserMedia: vi.fn().mockRejectedValue(err) } as unknown as MediaDevicesLike;
    const result = await requestMicrophoneAccess(media);
    expect(result).toMatchObject({ ok: false, code: 'MIC_PERMISSION_DENIED' });
  });

  it('treats a stream with no live track as MIC_DEVICE_MISSING and stops it', async () => {
    const track = fakeTrack('ended');
    const media = {
      getUserMedia: vi.fn().mockResolvedValue(fakeStream([track])),
    } as unknown as MediaDevicesLike;
    const result = await requestMicrophoneAccess(media, {}, { sleep: async () => {} });
    expect(result).toMatchObject({ ok: false, code: 'MIC_DEVICE_MISSING' });
    expect(track.stopped).toBe(true);
  });
});

/**
 * The intermittency this suite exists for.
 *
 * macOS frees an input device asynchronously, so a `getUserMedia` issued within
 * a few hundred milliseconds of the previous holder's `track.stop()` is
 * REJECTED rather than queued. This app hands the microphone over exactly
 * there — the Preflight meter lets go, the take opens its own capture — so
 * whether a take could hear anything came down to how long the intervening IPC
 * happened to take. Same code, same machine, different answer: "sometimes it
 * does not pick up the microphone".
 */
describe('a busy device is retried (spec §28.6, macOS device handover)', () => {
  const busy = (): Error => Object.assign(new Error('busy'), { name: 'NotReadableError' });

  it('succeeds on a later attempt when the device frees up', async () => {
    const stream = fakeStream([fakeTrack()]);
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(busy())
      .mockRejectedValueOnce(busy())
      .mockResolvedValue(stream);
    const slept: number[] = [];
    const result = await requestMicrophoneAccess(
      { getUserMedia } as unknown as MediaDevicesLike,
      {},
      {
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ attempts: 3 });
    // Backoff, not a busy-wait: the device needs time, and hammering it is how
    // WebKit's capture pipeline gets wedged.
    expect(slept).toEqual([250, 500]);
  });

  it('does not delay the ordinary path at all', async () => {
    const sleep = vi.fn(async () => {});
    const media = {
      getUserMedia: vi.fn().mockResolvedValue(fakeStream([fakeTrack()])),
    } as unknown as MediaDevicesLike;
    const result = await requestMicrophoneAccess(media, {}, { sleep });
    expect(result).toMatchObject({ ok: true, attempts: 1, fellBackToDefault: false });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('falls back to the system default on the last attempt, and says so', async () => {
    /*
     * A device busy for the best part of two seconds is held by something this
     * app cannot see. The built-in microphone is very often free, and
     * presenting from the wrong input beats not presenting — but the caller is
     * TOLD, because a take running on an input the user did not choose is a
     * take whose audio is not what they think it is (§28.2).
     */
    const stream = fakeStream([fakeTrack()]);
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(busy())
      .mockRejectedValueOnce(busy())
      .mockRejectedValueOnce(busy())
      .mockResolvedValue(stream);
    const result = await requestMicrophoneAccess(
      { getUserMedia } as unknown as MediaDevicesLike,
      { deviceId: 'usb-mic' },
      { sleep: async () => {} },
    );
    expect(result).toMatchObject({ ok: true, attempts: 4, fellBackToDefault: true });
    // The first three asked for the pinned device; the last did not.
    const constraints = getUserMedia.mock.calls.map(([c]) => (c as MediaStreamConstraints).audio);
    expect(constraints.slice(0, 3).every((a) => 'deviceId' in (a as object))).toBe(true);
    expect('deviceId' in (constraints[3] as object)).toBe(false);
  });

  it('gives up with the busy code rather than retrying forever', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(busy());
    const result = await requestMicrophoneAccess(
      { getUserMedia } as unknown as MediaDevicesLike,
      {},
      { sleep: async () => {} },
    );
    expect(result).toMatchObject({ ok: false, code: 'MIC_DEVICE_LOST', attempts: 4 });
    expect(getUserMedia).toHaveBeenCalledTimes(4);
  });

  it('never retries a denied permission', async () => {
    // Asking four times does not change an answer, it only delays telling the
    // user the one thing they can act on.
    const err = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    const getUserMedia = vi.fn().mockRejectedValue(err);
    const result = await requestMicrophoneAccess(
      { getUserMedia } as unknown as MediaDevicesLike,
      {},
      { sleep: async () => {} },
    );
    expect(result).toMatchObject({ ok: false, code: 'MIC_PERMISSION_DENIED', attempts: 1 });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('never retries a device that is not there', async () => {
    // §28.2: the remedy is the input picker, and it should appear at once.
    const err = Object.assign(new Error('gone'), { name: 'NotFoundError' });
    const getUserMedia = vi.fn().mockRejectedValue(err);
    const result = await requestMicrophoneAccess(
      { getUserMedia } as unknown as MediaDevicesLike,
      { deviceId: 'usb-mic' },
      { sleep: async () => {} },
    );
    expect(result).toMatchObject({ ok: false, code: 'MIC_DEVICE_MISSING', attempts: 1 });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('reports each retry so the diagnostics can explain a slow start', async () => {
    const onRetry = vi.fn();
    const getUserMedia = vi.fn().mockRejectedValueOnce(busy()).mockResolvedValue(fakeStream([fakeTrack()]));
    await requestMicrophoneAccess(
      { getUserMedia } as unknown as MediaDevicesLike,
      {},
      { sleep: async () => {}, onRetry },
    );
    expect(onRetry).toHaveBeenCalledWith(1, 'MIC_DEVICE_LOST', 250);
  });
});

describe('releaseStream (spec §28.7 retention)', () => {
  it('stops all tracks and tolerates stop() throwing', () => {
    const good = fakeTrack();
    const bad = fakeTrack();
    bad.stop = () => {
      throw new Error('already ended');
    };
    expect(() => releaseStream(fakeStream([bad, good]))).not.toThrow();
    expect(good.stopped).toBe(true);
  });

  it('tolerates null', () => {
    expect(() => releaseStream(null)).not.toThrow();
  });
});
