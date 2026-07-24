/**
 * Microphone device enumeration and selection (spec §28.2).
 *
 * Rules encoded here:
 * - labels may be unavailable before permission — synthesize placeholders;
 * - a "follow system default" selection mode is first-class;
 * - a saved device that disappears falls back to the system default;
 * - `devicechange` is observed, but a newly connected microphone is never
 *   switched to automatically during a live take (the manager only reports;
 *   callers decide).
 */
import type { AudioDeviceInfo, Unsubscribe } from '../../../shared/contracts';
import type { MediaDeviceInfoLike, MediaDevicesLike } from './types';

/** Sentinel deviceId browsers use for the system default input. */
export const SYSTEM_DEFAULT_DEVICE_ID = 'default';

export type MicrophoneSelection =
  | { mode: 'system_default' }
  | { mode: 'specific'; deviceId: string };

export const FOLLOW_SYSTEM_DEFAULT: MicrophoneSelection = { mode: 'system_default' };

/** Convert raw enumeration output to the shared AudioDeviceInfo contract. */
export function toAudioDeviceInfos(devices: MediaDeviceInfoLike[]): AudioDeviceInfo[] {
  const inputs = devices.filter((d) => d.kind === 'audioinput');
  let unnamed = 0;
  return inputs.map((d) => {
    const isDefault = d.deviceId === SYSTEM_DEFAULT_DEVICE_ID;
    let label = d.label;
    if (!label) {
      // Pre-permission enumeration returns empty labels (spec §28.2).
      unnamed += 1;
      label = isDefault ? 'System default microphone' : `Microphone ${unnamed}`;
    }
    return {
      deviceId: d.deviceId,
      groupId: d.groupId || undefined,
      label,
      isDefault,
      available: true,
    };
  });
}

export interface ResolvedDevice {
  /** Constraint-ready device id; undefined means follow system default. */
  deviceId: string | undefined;
  /** True when a saved specific device was missing and we fell back. */
  usedFallback: boolean;
}

/**
 * Resolve a selection against the currently available inputs. A saved
 * specific device that has disappeared falls back to the system default
 * (spec §28.2) with `usedFallback: true` so the UI can say so.
 */
export function resolveMicrophoneSelection(
  selection: MicrophoneSelection,
  available: AudioDeviceInfo[],
): ResolvedDevice {
  if (selection.mode === 'system_default') {
    return { deviceId: undefined, usedFallback: false };
  }
  const found = available.find((d) => d.deviceId === selection.deviceId);
  if (found) return { deviceId: found.deviceId, usedFallback: false };
  return { deviceId: undefined, usedFallback: true };
}

export interface DeviceChangeReport {
  devices: AudioDeviceInfo[];
  added: AudioDeviceInfo[];
  removed: AudioDeviceInfo[];
  /** True when the currently selected specific device is no longer present. */
  selectedDeviceLost: boolean;
}

/** Pure diff used by the manager and directly testable. */
export function diffDeviceLists(
  previous: AudioDeviceInfo[],
  next: AudioDeviceInfo[],
  selection: MicrophoneSelection,
): DeviceChangeReport {
  const prevIds = new Set(previous.map((d) => d.deviceId));
  const nextIds = new Set(next.map((d) => d.deviceId));
  const added = next.filter((d) => !prevIds.has(d.deviceId));
  const removed = previous.filter((d) => !nextIds.has(d.deviceId));
  const selectedDeviceLost =
    selection.mode === 'specific' && !nextIds.has(selection.deviceId);
  return { devices: next, added, removed, selectedDeviceLost };
}

/**
 * Stateful device manager for the control window. Holds the current
 * selection, re-enumerates on `devicechange`, and notifies listeners with a
 * diff. It never mutates the selection on its own during a live take — a
 * lost device is only *reported*; switching requires an explicit call to
 * `select()` (confirmation lives in the UI, spec §28.2).
 */
export class MicrophoneDeviceManager {
  private selection: MicrophoneSelection = FOLLOW_SYSTEM_DEFAULT;
  private lastDevices: AudioDeviceInfo[] = [];
  private readonly listeners = new Set<(report: DeviceChangeReport) => void>();
  private detach: (() => void) | null = null;

  constructor(private readonly mediaDevices: MediaDevicesLike) {}

  getSelection(): MicrophoneSelection {
    return this.selection;
  }

  select(selection: MicrophoneSelection): void {
    this.selection = selection;
  }

  async listInputs(): Promise<AudioDeviceInfo[]> {
    const raw = await this.mediaDevices.enumerateDevices();
    this.lastDevices = toAudioDeviceInfos(raw);
    return this.lastDevices;
  }

  /** Resolve the current selection to a constraint-ready device id. */
  async resolve(): Promise<ResolvedDevice> {
    const devices = await this.listInputs();
    return resolveMicrophoneSelection(this.selection, devices);
  }

  /** Subscribe to devicechange reports. First subscriber attaches the listener. */
  onDeviceChange(listener: (report: DeviceChangeReport) => void): Unsubscribe {
    this.listeners.add(listener);
    if (!this.detach) {
      const handler = () => {
        void this.refreshAndNotify();
      };
      this.mediaDevices.addEventListener('devicechange', handler);
      this.detach = () => this.mediaDevices.removeEventListener('devicechange', handler);
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.detach) {
        this.detach();
        this.detach = null;
      }
    };
  }

  private async refreshAndNotify(): Promise<void> {
    const previous = this.lastDevices;
    let next: AudioDeviceInfo[];
    try {
      next = toAudioDeviceInfos(await this.mediaDevices.enumerateDevices());
    } catch {
      return; // Enumeration hiccups must not crash the session.
    }
    this.lastDevices = next;
    const report = diffDeviceLists(previous, next, this.selection);
    for (const listener of this.listeners) listener(report);
  }
}
