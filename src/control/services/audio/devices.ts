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
      ...(d.deviceId === '' || d.label === '' ? { withheld: true } : {}),
    };
  });
}

/**
 * Whether this list hides which inputs are which — and so cannot say whether a
 * remembered microphone is plugged in.
 *
 * Until a document has opened a microphone itself, the webview does not say
 * what is connected. WKWebView answers every `enumerateDevices()` with ONE
 * input, whose id and name are both empty, whatever is plugged in; Chromium
 * does the same before a grant. macOS having granted Speaking Glass the microphone
 * changes nothing: the rule is per document, and only a `getUserMedia` that
 * succeeds in it lifts it. So the control window is in this state for its
 * first take after every launch, and Settings each time it opens.
 *
 * Nothing can match against such a list — the one entry has no id, and its
 * name is a placeholder we made up — so a "no match" read as "not connected"
 * told everyone with a pinned microphone, on every launch, that it was
 * unplugged while they were speaking into it.
 */
export function inputsWithheld(devices: AudioDeviceInfo[]): boolean {
  return devices.some((d) => d.withheld === true);
}

/**
 * The picker row that means "follow whatever the system input is".
 *
 * Deliberately NOT the browser's own `default` device id: on Chrome that id is
 * a real enumerated entry, and conflating the two would make "follow the
 * system default" and "pin the device that happens to be default right now"
 * indistinguishable — which is the difference the setting exists to express.
 */
export const SYSTEM_DEFAULT_OPTION = '__system_default__';

export interface MicrophoneOption {
  value: string;
  label: string;
}

/** "Default - Blue Yeti" → "Blue Yeti"; anything else is left alone. */
function withoutDefaultPrefix(label: string): string {
  return label.replace(/^default\s+-\s+/i, '').trim();
}

export interface RememberedMicrophone {
  /** The id last written to settings; may be stale. */
  deviceId?: string | undefined;
  /** The label that id carried when it was chosen. */
  label?: string | undefined;
}

/**
 * The rows of the input picker: "follow the system default" first, then every
 * connected input.
 *
 * The system-default row names the device it currently resolves to, because
 * "System default" on its own is the one option whose meaning the user cannot
 * see — and not being able to see it is exactly how someone ends up presenting
 * through their headset without knowing why.
 *
 * `missing` is a remembered input that is not connected right now. It is kept
 * in the list, marked, and selectable so the picker shows what is remembered
 * instead of silently reading as though the choice was never made.
 */
export function microphoneOptions(
  devices: AudioDeviceInfo[],
  missing?: { deviceId: string; label: string } | undefined,
): MicrophoneOption[] {
  const systemDefault = devices.find((d) => d.isDefault);
  const resolvesTo = systemDefault ? withoutDefaultPrefix(systemDefault.label) : '';
  const options: MicrophoneOption[] = [
    {
      value: SYSTEM_DEFAULT_OPTION,
      label: resolvesTo ? `System default — ${resolvesTo}` : 'System default',
    },
    // An input without an id cannot be pinned. One with an id but no name can,
    // under the placeholder it was given.
    ...devices
      .filter((d) => !d.isDefault && d.deviceId !== '')
      .map((d) => ({ value: d.deviceId, label: d.label })),
  ];
  if (missing && !devices.some((d) => d.deviceId === missing.deviceId)) {
    // Withheld, the list cannot say it is unplugged — only that it is chosen.
    options.push({
      value: missing.deviceId,
      label: inputsWithheld(devices) ? missing.label : `${missing.label} (not connected)`,
    });
  }
  return options;
}

/**
 * Find the remembered microphone among the inputs connected right now — by id
 * first, then BY LABEL.
 *
 * A `deviceId` is not a stable name for a piece of hardware. WKWebView salts
 * them per origin and session, and a replug can change them, so matching on the
 * id alone means the app forgets the microphone the user chose and quietly
 * reverts to the system default on a restart — which is precisely what "use my
 * good microphone" must not do. The label ("Blue Yeti") is what was actually
 * chosen, so it is the fallback, and the caller re-pins the fresh id.
 */
export function matchRememberedMicrophone(
  devices: AudioDeviceInfo[],
  remembered: RememberedMicrophone,
): AudioDeviceInfo | undefined {
  const specific = devices.filter((d) => !d.isDefault);
  if (remembered.deviceId !== undefined && remembered.deviceId !== '') {
    const byId = specific.find((d) => d.deviceId === remembered.deviceId);
    if (byId) return byId;
  }
  if (remembered.label !== undefined && remembered.label !== '') {
    // A withheld input's label is our own placeholder, not its name.
    const byLabel = specific.find((d) => d.withheld !== true && d.label === remembered.label);
    if (byLabel) return byLabel;
  }
  return undefined;
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
  // A list without ids has not lost anything; it just is not saying. (Missing
  // names do not matter here: loss is judged by id.)
  const selectedDeviceLost =
    selection.mode === 'specific' &&
    !next.some((d) => d.deviceId === '') &&
    !nextIds.has(selection.deviceId);
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
