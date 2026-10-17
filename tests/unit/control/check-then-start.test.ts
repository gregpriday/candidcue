/**
 * Every way of starting a take goes through one readiness check (#301).
 *
 * The check used to exist only on the editor's own Present button. File ›
 * Present, Present As, Practise, Session › Start Take, the Library and the
 * summary's Present again called `startTake` directly, so the same missing
 * model was warned about or not depending on which control was used — and the
 * editor's own answer was read once, when the script opened.
 *
 * What must NOT change is pinned alongside: a healthy setup still launches at
 * once with no sheet, and a missing model is a warning with Start anyway, never
 * a block.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get, type Writable } from 'svelte/store';

const h = vi.hoisted(() => ({
  startTake: vi.fn(async () => true),
  listMicrophones: vi.fn(async (): Promise<unknown[]> => []),
  requestMicrophoneAccess: vi.fn(async (): Promise<'granted' | 'denied'> => 'granted'),
  readMicrophonePermission: vi.fn(async (): Promise<string> => 'unsupported'),
}));

/** The OS's answer about the microphone (#303), set per test. */
vi.mock('../../../src/control/services/microphone-permission', () => ({
  readMicrophonePermission: h.readMicrophonePermission,
  openMicrophoneSettings: vi.fn(async () => {}),
  isMicrophoneRefused: (p: string) => p === 'denied' || p === 'restricted',
}));

vi.mock('../../../src/control/lib/start-take', async () => {
  const { readable } = await import('svelte/store');
  return { startTake: h.startTake, takeStarting: readable(false) };
});

/** The live model answer, set directly — its own suite covers how it is kept. */
vi.mock('../../../src/control/stores/speech-model-readiness', async () => {
  const { writable } = await import('svelte/store');
  return {
    speechModelReadiness: writable({
      known: true,
      installed: true,
      supported: true,
      damaged: false,
      installing: false,
    }),
  };
});

vi.mock('../../../src/control/services/voice-facade', async (orig) => ({
  ...(await orig<typeof import('../../../src/control/services/voice-facade')>()),
  getVoiceFacade: () => ({
    listMicrophones: h.listMicrophones,
    requestMicrophoneAccess: h.requestMicrophoneAccess,
  }),
}));

/** The editor's document and compile, which the check reads script facts from. */
vi.mock('../../../src/control/stores/editor', async (orig) => {
  const actual = await orig<typeof import('../../../src/control/stores/editor')>();
  const { writable } = await import('svelte/store');
  return { ...actual, editor: writable({ scriptId: null, loading: false }) };
});
vi.mock('../../../src/control/stores/compiled', async (orig) => {
  const actual = await orig<typeof import('../../../src/control/stores/compiled')>();
  const { writable } = await import('svelte/store');
  return {
    ...actual,
    compiled: writable({ status: 'idle', result: null, error: null, scriptId: null }),
  };
});

/** The settings document, swapped for one a test can write. */
vi.mock('../../../src/control/stores/settings', async (orig) => {
  const actual = await orig<typeof import('../../../src/control/stores/settings')>();
  const { writable } = await import('svelte/store');
  const { defaultAppSettings } = await import('../../../src/control/services/settings-types');
  return { ...actual, settings: writable(defaultAppSettings()) };
});

import {
  allowMicrophoneForTake,
  checkThenStart,
  checkThenStartTake,
  dismissTakeReadiness,
  recheckTakeReadiness,
  startAnyway,
  takeReadinessPrompt,
} from '../../../src/control/lib/check-then-start';
import { speechModelReadiness } from '../../../src/control/stores/speech-model-readiness';
import type { SpeechModelReadiness } from '../../../src/control/stores/speech-model-readiness';
import { settings } from '../../../src/control/stores/settings';
import { editor } from '../../../src/control/stores/editor';
import { compiled } from '../../../src/control/stores/compiled';
import {
  defaultAppSettings,
  type AppSettings,
} from '../../../src/control/services/settings-types';

const model = speechModelReadiness as unknown as Writable<SpeechModelReadiness>;
const settingsDoc = settings as unknown as Writable<AppSettings>;
const editorDoc = editor as unknown as Writable<{ scriptId: string | null; loading: boolean }>;
const compileDoc = compiled as unknown as Writable<Record<string, unknown>>;

const INSTALLED: SpeechModelReadiness = {
  known: true,
  installed: true,
  supported: true,
  damaged: false,
  installing: false,
};
const MISSING: SpeechModelReadiness = { ...INSTALLED, installed: false };

const YETI = {
  deviceId: 'mic-1',
  label: 'Blue Yeti',
  isDefault: false,
  available: true,
};

/** A microphone pinned in Settings rather than the system default. */
function pinYeti(): void {
  const base = defaultAppSettings();
  settingsDoc.set({
    ...base,
    audio: {
      ...base.audio,
      followSystemDefault: false,
      preferredDeviceId: YETI.deviceId,
      preferredDeviceLabel: YETI.label,
    },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function findingIds(): string[] {
  return get(takeReadinessPrompt)?.verdict.findings.map((f) => f.id) ?? [];
}

beforeEach(() => {
  h.startTake.mockClear();
  h.listMicrophones.mockReset();
  h.listMicrophones.mockResolvedValue([]);
  h.requestMicrophoneAccess.mockReset();
  h.requestMicrophoneAccess.mockResolvedValue('granted');
  h.readMicrophonePermission.mockReset();
  h.readMicrophonePermission.mockResolvedValue('unsupported');
  dismissTakeReadiness();
  model.set(INSTALLED);
  settingsDoc.set(defaultAppSettings());
  editorDoc.set({ scriptId: null, loading: false });
  compileDoc.set({ status: 'idle', result: null, error: null, scriptId: null });
});

describe('checkThenStartTake', () => {
  it('launches a healthy setup at once, with no sheet', async () => {
    await checkThenStartTake('script-1', { presentationMode: 'reader' });
    expect(h.startTake).toHaveBeenCalledWith('script-1', { presentationMode: 'reader' });
    expect(get(takeReadinessPrompt)).toBeNull();
  });

  it('warns about a missing model instead of launching past it', async () => {
    model.set(MISSING);
    await checkThenStartTake('script-1');
    expect(h.startTake).not.toHaveBeenCalled();
    const held = get(takeReadinessPrompt);
    expect(held?.verdict.show).toBe(true);
    // A warning, never a block: Start anyway stays on offer.
    expect(held?.verdict.blocked).toBe(false);
    expect(findingIds()).toEqual(['model_missing']);
  });

  it('resumes exactly the take that was asked for on Start anyway', async () => {
    model.set(MISSING);
    const options = {
      presentationMode: 'prompter' as const,
      startTokenIndex: 42,
      part: { id: 'part-3', whole: true },
    };
    await checkThenStartTake('script-1', options);
    await startAnyway();
    expect(h.startTake).toHaveBeenCalledTimes(1);
    expect(h.startTake).toHaveBeenCalledWith('script-1', options);
    expect(get(takeReadinessPrompt)).toBeNull();
  });

  it('launches nothing when the sheet is dismissed', async () => {
    model.set(MISSING);
    await checkThenStartTake('script-1');
    dismissTakeReadiness();
    await startAnyway();
    expect(h.startTake).not.toHaveBeenCalled();
  });

  it('reads the model as it is NOW — an install that finished is installed', async () => {
    // The issue's repro at the launch: the answer was taken when the script
    // opened, mid-download, and kept after the download finished.
    model.set({ ...MISSING, installing: true });
    await checkThenStartTake('script-1');
    expect(findingIds()).toEqual(['model_installing']);
    dismissTakeReadiness();

    model.set(INSTALLED);
    await checkThenStartTake('script-1');
    expect(get(takeReadinessPrompt)).toBeNull();
    expect(h.startTake).toHaveBeenCalledTimes(1);
  });

  it('and a model removed since is missing', async () => {
    await checkThenStartTake('script-1');
    expect(h.startTake).toHaveBeenCalledTimes(1);

    model.set(MISSING);
    await checkThenStartTake('script-1');
    expect(h.startTake).toHaveBeenCalledTimes(1);
    expect(findingIds()).toEqual(['model_missing']);
  });

  it('names a damaged download and an unloadable model as what they are', async () => {
    model.set({ ...MISSING, damaged: true });
    await checkThenStartTake('script-1');
    expect(findingIds()).toEqual(['model_damaged']);
    dismissTakeReadiness();

    model.set({ ...INSTALLED, supported: false });
    await checkThenStartTake('script-1');
    expect(findingIds()).toEqual(['model_unsupported']);
  });

  it('never warns a manual take about the model', async () => {
    settingsDoc.set({
      ...defaultAppSettings(),
      general: { ...defaultAppSettings().general, defaultSessionMode: 'manual' },
    });
    model.set(MISSING);
    await checkThenStartTake('script-1');
    expect(h.startTake).toHaveBeenCalledTimes(1);
    expect(get(takeReadinessPrompt)).toBeNull();
  });

  it('checks a practice like a take, and resumes it as a practice', async () => {
    model.set(MISSING);
    await checkThenStartTake('script-1', { practice: true });
    expect(findingIds()).toEqual(['model_missing']);
    await startAnyway();
    expect(h.startTake).toHaveBeenCalledWith('script-1', { practice: true });
  });

  it('does not judge a script by a compile of a different one', async () => {
    // The editor holds script A, settled, with nothing speakable in it.
    editorDoc.set({ scriptId: 'a', loading: false });
    compileDoc.set({
      status: 'ready',
      error: null,
      scriptId: 'a',
      result: { spokenWordCount: 0, diagnostics: [] },
    });

    // A launch of B from the Library knows nothing about B's compile, which
    // is optimistic — `startTake` compiles the saved source itself.
    await checkThenStartTake('b');
    expect(h.startTake).toHaveBeenCalledWith('b', {});

    // A's own launch is judged by it, and there is nothing to start.
    await checkThenStartTake('a');
    expect(findingIds()).toEqual(['script_silent']);
    expect(get(takeReadinessPrompt)?.verdict.blocked).toBe(true);
    await startAnyway();
    expect(h.startTake).toHaveBeenCalledTimes(1);
  });
});

describe('a pinned microphone', () => {
  it('is reported when it is not connected', async () => {
    // `matchRememberedMicrophone` answers `undefined` for "not connected"; a
    // comparison with null never fired.
    pinYeti();
    await checkThenStartTake('script-1');
    expect(findingIds()).toEqual(['mic_missing']);
    expect(get(takeReadinessPrompt)?.verdict.blocked).toBe(false);
  });

  it('is not reported when it is', async () => {
    pinYeti();
    h.listMicrophones.mockResolvedValue([YETI]);
    await checkThenStartTake('script-1');
    expect(h.startTake).toHaveBeenCalledTimes(1);
  });

  it('is not reported for the legacy `default` pin, which is the system default', async () => {
    // Older builds auto-pinned the browser's own `default` pseudo-device;
    // Settings reads that as "follow the system default", and so must this.
    const base = defaultAppSettings();
    settingsDoc.set({
      ...base,
      audio: { ...base.audio, followSystemDefault: false, preferredDeviceId: 'default' },
    });
    await checkThenStartTake('script-1');
    expect(get(takeReadinessPrompt)).toBeNull();
    expect(h.startTake).toHaveBeenCalledTimes(1);
  });

  it('is judged as it is pinned when the device list arrives', async () => {
    // Pinned and missing when the check began; switched back to the system
    // default in Settings while the list was being fetched.
    pinYeti();
    const devices = deferred<unknown[]>();
    h.listMicrophones.mockReturnValueOnce(devices.promise);
    const pending = checkThenStartTake('script-1');
    settingsDoc.set(defaultAppSettings());
    devices.resolve([]);
    await pending;
    expect(get(takeReadinessPrompt)).toBeNull();
    expect(h.startTake).toHaveBeenCalledTimes(1);
  });

  it('warns about the microphone the take will open, not the one it began with', async () => {
    // The Yeti is connected; the pin moves to one that is not, mid-check.
    pinYeti();
    const devices = deferred<unknown[]>();
    h.listMicrophones.mockReturnValueOnce(devices.promise);
    const pending = checkThenStartTake('script-1');
    const base = get(settings);
    settingsDoc.set({
      ...base,
      audio: { ...base.audio, preferredDeviceId: 'mic-2', preferredDeviceLabel: 'Røde NT-USB' },
    });
    devices.resolve([YETI]);
    await pending;
    expect(findingIds()).toEqual(['mic_missing']);
    expect(get(takeReadinessPrompt)?.verdict.findings[0]?.detail).toContain('Røde NT-USB');
  });
});

describe('checks that overlap', () => {
  it('a launch that goes ahead answers a sheet left from an earlier attempt', async () => {
    // Sheet up over a missing model; the model is installed from its own
    // button; File › Present is chosen with the sheet still showing.
    model.set(MISSING);
    await checkThenStartTake('script-1');
    expect(get(takeReadinessPrompt)).not.toBeNull();

    model.set(INSTALLED);
    await checkThenStartTake('script-1');
    expect(h.startTake).toHaveBeenCalledTimes(1);
    // Left up, the sheet would sit over the take with the old launch behind it.
    expect(get(takeReadinessPrompt)).toBeNull();
  });

  it('a check finishing after the sheet was dismissed does not bring it back', async () => {
    pinYeti();
    model.set(MISSING);
    const devices = deferred<unknown[]>();
    h.listMicrophones.mockReturnValueOnce(devices.promise);

    const pending = checkThenStartTake('script-1');
    dismissTakeReadiness();
    devices.resolve([YETI]);
    await pending;

    expect(get(takeReadinessPrompt)).toBeNull();
    expect(h.startTake).not.toHaveBeenCalled();
  });

  it('only the newest of two checks in flight goes on', async () => {
    pinYeti();
    model.set(MISSING);
    const first = deferred<unknown[]>();
    const second = deferred<unknown[]>();
    h.listMicrophones.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const older = checkThenStartTake('script-1', { presentationMode: 'reader' });
    const newer = checkThenStartTake('script-1', { presentationMode: 'prompter' });
    second.resolve([YETI]);
    await newer;
    first.resolve([YETI]);
    await older;

    await startAnyway();
    expect(h.startTake).toHaveBeenCalledTimes(1);
    expect(h.startTake).toHaveBeenCalledWith('script-1', { presentationMode: 'prompter' });
  });

  it('reads the model as it is when the device list arrives', async () => {
    pinYeti();
    model.set(MISSING);
    const devices = deferred<unknown[]>();
    h.listMicrophones.mockReturnValueOnce(devices.promise);

    const pending = checkThenStartTake('script-1');
    // The install finishes while the microphones are being listed.
    model.set(INSTALLED);
    devices.resolve([YETI]);
    await pending;

    expect(get(takeReadinessPrompt)).toBeNull();
    expect(h.startTake).toHaveBeenCalledTimes(1);
  });
});

describe('checkThenStart', () => {
  it('shows the sheet on request even for a healthy setup, and Start anyway launches', async () => {
    const launch = vi.fn(async () => {});
    await checkThenStart('script-1', { requested: true }, launch);
    expect(launch).not.toHaveBeenCalled();
    expect(get(takeReadinessPrompt)?.verdict.findings).toEqual([]);
    await startAnyway();
    expect(launch).toHaveBeenCalledTimes(1);
  });
});

/*
 * #303 — a refused or never-granted microphone is found out before Present
 * turns the window into the prompter, and the sheet carries the way back.
 */
describe('microphone access before the take', () => {
  it('launches at once when access is granted', async () => {
    h.readMicrophonePermission.mockResolvedValue('granted');
    await checkThenStartTake('script-1');
    expect(h.startTake).toHaveBeenCalledTimes(1);
    expect(get(takeReadinessPrompt)).toBeNull();
  });

  it('holds a refused launch, and Try again launches it once allowed', async () => {
    h.readMicrophonePermission.mockResolvedValue('denied');
    await checkThenStartTake('script-1', { presentationMode: 'prompter' });
    expect(h.startTake).not.toHaveBeenCalled();
    expect(findingIds()).toEqual(['mic_permission_denied']);

    // Still refused: the sheet stays, nothing launches.
    await recheckTakeReadiness();
    expect(h.startTake).not.toHaveBeenCalled();
    expect(findingIds()).toEqual(['mic_permission_denied']);

    // Allowed in System Settings, then Try again: the SAME launch goes.
    h.readMicrophonePermission.mockResolvedValue('granted');
    await recheckTakeReadiness();
    expect(h.startTake).toHaveBeenCalledTimes(1);
    expect(h.startTake).toHaveBeenCalledWith('script-1', { presentationMode: 'prompter' });
    expect(get(takeReadinessPrompt)).toBeNull();
  });

  it('asks for a never-asked microphone from the sheet, then launches on a grant', async () => {
    h.readMicrophonePermission.mockResolvedValue('prompt');
    await checkThenStartTake('script-1');
    expect(findingIds()).toEqual(['mic_permission_prompt']);
    // The readiness READ never asks: only the explicit action does.
    expect(h.requestMicrophoneAccess).not.toHaveBeenCalled();

    h.requestMicrophoneAccess.mockImplementation(async () => {
      h.readMicrophonePermission.mockResolvedValue('granted');
      return 'granted';
    });
    await allowMicrophoneForTake();
    expect(h.requestMicrophoneAccess).toHaveBeenCalledTimes(1);
    expect(h.startTake).toHaveBeenCalledTimes(1);
    expect(get(takeReadinessPrompt)).toBeNull();
  });

  it('turns a refusal at the prompt into the row that undoes it', async () => {
    h.readMicrophonePermission.mockResolvedValue('prompt');
    await checkThenStartTake('script-1');
    h.requestMicrophoneAccess.mockImplementation(async () => {
      h.readMicrophonePermission.mockResolvedValue('denied');
      return 'denied';
    });
    await allowMicrophoneForTake();
    expect(h.startTake).not.toHaveBeenCalled();
    expect(findingIds()).toEqual(['mic_permission_denied']);
  });

  it('lets a newer Present win over an older sheet’s Allow', async () => {
    // Allow is pending on the OS when Present is pressed again, and the newer
    // check is still reading its facts when Allow comes back. Re-running the
    // old check would retire the new one and launch the older take.
    h.readMicrophonePermission.mockResolvedValue('prompt');
    await checkThenStartTake('script-1', { presentationMode: 'reader' });
    const answer = deferred<'granted' | 'denied'>();
    h.requestMicrophoneAccess.mockReturnValue(answer.promise);
    const allowing = allowMicrophoneForTake();

    const devices = deferred<unknown[]>();
    pinYeti();
    h.listMicrophones.mockReturnValueOnce(devices.promise);
    h.readMicrophonePermission.mockResolvedValue('granted');
    const newer = checkThenStartTake('script-1', { presentationMode: 'prompter' });

    answer.resolve('granted');
    await allowing;
    expect(h.startTake, 'the older take must not launch').not.toHaveBeenCalled();

    devices.resolve([YETI]);
    await newer;
    expect(h.startTake).toHaveBeenCalledTimes(1);
    expect(h.startTake).toHaveBeenCalledWith('script-1', { presentationMode: 'prompter' });
  });

  it('says why when Allow finds no microphone, rather than looping', async () => {
    const { toasts, clearToasts } = await import('../../../src/control/stores/toasts');
    clearToasts();
    h.readMicrophonePermission.mockResolvedValue('prompt');
    await checkThenStartTake('script-1');
    h.requestMicrophoneAccess.mockRejectedValue(new Error('MIC_DEVICE_MISSING'));
    await allowMicrophoneForTake();
    expect(h.startTake).not.toHaveBeenCalled();
    // The sheet stays, Start anyway with it; the reason is said.
    expect(get(takeReadinessPrompt)?.verdict.blocked).toBe(false);
    const said = get(toasts).map((t) => t.message);
    expect(said.some((m) => m.startsWith('CandidCue could not open the microphone.'))).toBe(true);
    expect(said.join(' ')).not.toContain('MIC_DEVICE_MISSING');
  });

  it('launches nothing when the sheet is dismissed while the OS is asking', async () => {
    h.readMicrophonePermission.mockResolvedValue('prompt');
    await checkThenStartTake('script-1');
    const answer = deferred<'granted' | 'denied'>();
    h.requestMicrophoneAccess.mockReturnValue(answer.promise);
    const allowing = allowMicrophoneForTake();
    dismissTakeReadiness();
    h.readMicrophonePermission.mockResolvedValue('granted');
    answer.resolve('granted');
    await allowing;
    expect(h.startTake).not.toHaveBeenCalled();
    expect(get(takeReadinessPrompt)).toBeNull();
  });
});
