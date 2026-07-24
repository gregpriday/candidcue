import { describe, expect, it } from 'vitest';
import {
  diffDeviceLists,
  FOLLOW_SYSTEM_DEFAULT,
  MicrophoneDeviceManager,
  resolveMicrophoneSelection,
  toAudioDeviceInfos,
} from './devices';
import type { MediaDeviceInfoLike, MediaDevicesLike, MediaStreamLike } from './types';

function device(deviceId: string, label = '', kind = 'audioinput'): MediaDeviceInfoLike {
  return { deviceId, groupId: `g-${deviceId}`, kind, label };
}

class FakeMediaDevices implements MediaDevicesLike {
  devices: MediaDeviceInfoLike[] = [];
  private listeners = new Set<() => void>();

  enumerateDevices(): Promise<MediaDeviceInfoLike[]> {
    return Promise.resolve([...this.devices]);
  }
  getUserMedia(): Promise<MediaStreamLike> {
    return Promise.reject(new Error('not used'));
  }
  addEventListener(_type: 'devicechange', listener: () => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: 'devicechange', listener: () => void): void {
    this.listeners.delete(listener);
  }
  get listenerCount(): number {
    return this.listeners.size;
  }
  async fireDeviceChange(): Promise<void> {
    for (const listener of this.listeners) listener();
    await Promise.resolve(); // let async refresh settle
    await Promise.resolve();
  }
}

describe('toAudioDeviceInfos (spec §28.2)', () => {
  it('filters to audio inputs and flags the system default', () => {
    const infos = toAudioDeviceInfos([
      device('default', 'Default - MacBook Pro Microphone'),
      device('mic-1', 'Blue Yeti'),
      device('cam-1', 'FaceTime Camera', 'videoinput'),
    ]);
    expect(infos).toHaveLength(2);
    expect(infos[0]?.isDefault).toBe(true);
    expect(infos[1]?.label).toBe('Blue Yeti');
  });

  it('synthesizes placeholder labels before permission', () => {
    const infos = toAudioDeviceInfos([device('default'), device('mic-1')]);
    expect(infos[0]?.label).toBe('System default microphone');
    expect(infos[1]?.label).toBe('Microphone 2');
  });
});

describe('resolveMicrophoneSelection (spec §28.2)', () => {
  const available = toAudioDeviceInfos([device('default', 'Default'), device('mic-1', 'Yeti')]);

  it('follows the system default with no explicit device', () => {
    expect(resolveMicrophoneSelection(FOLLOW_SYSTEM_DEFAULT, available)).toEqual({
      deviceId: undefined,
      usedFallback: false,
    });
  });

  it('resolves a present specific device', () => {
    expect(resolveMicrophoneSelection({ mode: 'specific', deviceId: 'mic-1' }, available)).toEqual({
      deviceId: 'mic-1',
      usedFallback: false,
    });
  });

  it('falls back to default when the saved device disappeared', () => {
    expect(resolveMicrophoneSelection({ mode: 'specific', deviceId: 'gone' }, available)).toEqual({
      deviceId: undefined,
      usedFallback: true,
    });
  });
});

describe('MicrophoneDeviceManager', () => {
  it('reports device changes with diffs and never auto-switches the selection', async () => {
    const media = new FakeMediaDevices();
    media.devices = [device('default', 'Default'), device('mic-1', 'Yeti')];
    const manager = new MicrophoneDeviceManager(media);
    manager.select({ mode: 'specific', deviceId: 'mic-1' });
    await manager.listInputs();

    const reports: Parameters<Parameters<typeof manager.onDeviceChange>[0]>[0][] = [];
    const unsubscribe = manager.onDeviceChange((report) => reports.push(report));

    // A new mic appears mid-take: report only, selection untouched (§28.2).
    media.devices = [device('default', 'Default'), device('mic-1', 'Yeti'), device('mic-2', 'AirPods')];
    await media.fireDeviceChange();
    expect(reports[0]?.added.map((d) => d.deviceId)).toEqual(['mic-2']);
    expect(reports[0]?.selectedDeviceLost).toBe(false);
    expect(manager.getSelection()).toEqual({ mode: 'specific', deviceId: 'mic-1' });

    // The selected mic is unplugged: flagged, still not auto-switched.
    media.devices = [device('default', 'Default'), device('mic-2', 'AirPods')];
    await media.fireDeviceChange();
    expect(reports[1]?.removed.map((d) => d.deviceId)).toEqual(['mic-1']);
    expect(reports[1]?.selectedDeviceLost).toBe(true);
    expect(manager.getSelection()).toEqual({ mode: 'specific', deviceId: 'mic-1' });

    // Resolution now falls back to system default.
    expect(await manager.resolve()).toEqual({ deviceId: undefined, usedFallback: true });

    unsubscribe();
    expect(media.listenerCount).toBe(0);
  });

  it('diffDeviceLists flags a lost selected device', () => {
    const before = toAudioDeviceInfos([device('default'), device('mic-1')]);
    const after = toAudioDeviceInfos([device('default')]);
    const report = diffDeviceLists(before, after, { mode: 'specific', deviceId: 'mic-1' });
    expect(report.selectedDeviceLost).toBe(true);
    expect(report.removed).toHaveLength(1);
  });
});
