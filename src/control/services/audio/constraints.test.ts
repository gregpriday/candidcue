import { describe, expect, it } from 'vitest';
import { buildAudioConstraints } from './constraints';

describe('buildAudioConstraints (spec §28.3)', () => {
  it('builds the default constraint set with no device pinned', () => {
    const constraints = buildAudioConstraints();
    expect(constraints.video).toBe(false);
    expect(constraints.audio).toEqual({
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
  });

  it('pins an exact deviceId when one is selected', () => {
    const constraints = buildAudioConstraints({ deviceId: 'mic-42' });
    expect((constraints.audio as MediaTrackConstraints).deviceId).toEqual({ exact: 'mic-42' });
  });

  it('omits deviceId for empty string (follow system default)', () => {
    const constraints = buildAudioConstraints({ deviceId: '' });
    expect((constraints.audio as MediaTrackConstraints).deviceId).toBeUndefined();
  });

  it('honors advanced toggles', () => {
    const constraints = buildAudioConstraints({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
    const audio = constraints.audio as MediaTrackConstraints;
    expect(audio.echoCancellation).toBe(false);
    expect(audio.noiseSuppression).toBe(false);
    expect(audio.autoGainControl).toBe(false);
  });
});
