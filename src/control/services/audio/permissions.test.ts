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
    const result = await requestMicrophoneAccess(media);
    expect(result).toMatchObject({ ok: false, code: 'MIC_DEVICE_MISSING' });
    expect(track.stopped).toBe(true);
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
