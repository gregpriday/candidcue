import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompileOutput } from '../../../src/control/services/compiler';
import type { AppSettings } from '../../../src/control/services/settings-types';

const calls = vi.hoisted(() => ({
  saveNow: vi.fn(),
  getScript: vi.fn(),
  compileScript: vi.fn(),
  startSessionRecord: vi.fn(),
  endSessionRecord: vi.fn(),
  startLiveSession: vi.fn(),
  stopSession: vi.fn(),
  clearSession: vi.fn(),
  navigate: vi.fn(),
  fullscreen: vi.fn(),
  showToast: vi.fn(),
}));

const editorState = vi.hoisted(() => ({
  value: { scriptId: null as string | null, saveState: 'idle', lastError: null as string | null },
}));
const settingsState = vi.hoisted(() => ({ value: null as AppSettings | null }));
const micState = vi.hoisted(() => ({
  devices: [] as Array<{
    deviceId: string;
    label: string;
    isDefault: boolean;
    available: boolean;
  }>,
}));

vi.mock('../../../src/control/services/scripts', () => ({
  getScript: calls.getScript,
}));
vi.mock('../../../src/control/services/compiler', () => ({
  compileScript: calls.compileScript,
}));
vi.mock('../../../src/control/services/session-records', () => ({
  startSessionRecord: calls.startSessionRecord,
  endSessionRecord: calls.endSessionRecord,
}));
vi.mock('../../../src/control/services/control-window', () => ({
  setControlFullscreen: calls.fullscreen,
}));
vi.mock('../../../src/control/stores/session', () => ({
  startLiveSession: calls.startLiveSession,
  stopSession: calls.stopSession,
  clearSession: calls.clearSession,
}));
vi.mock('../../../src/control/stores/router', () => ({ navigate: calls.navigate }));
vi.mock('../../../src/control/stores/toasts', () => ({ showToast: calls.showToast }));
vi.mock('../../../src/control/stores/editor', async () => {
  const { readable } = await import('svelte/store');
  return {
    saveNow: calls.saveNow,
    editor: readable(editorState.value, (set) => {
      set(editorState.value);
      return () => {};
    }),
  };
});
vi.mock('../../../src/control/stores/settings', async () => {
  const { readable } = await import('svelte/store');
  return {
    loadSettings: async () => settingsState.value,
    settings: readable(settingsState.value, (set) => {
      set(settingsState.value);
      return () => {};
    }),
  };
});
vi.mock('../../../src/control/services/voice-facade', () => ({
  getVoiceFacade: () => ({ listMicrophones: async () => micState.devices }),
}));

// Present may enumerate displays to resolve the selected panel's optical
// calibration. Every mutating window operation remains a throwing double, so
// the take cannot accidentally regress to a second window.
const stageCalls = vi.hoisted(() => ({
  listDisplays: vi.fn(),
  openStage: vi.fn(),
  publishStageDocument: vi.fn(),
  waitForStageReady: vi.fn(),
  setStageFullscreen: vi.fn(),
  closeStage: vi.fn(),
}));
vi.mock('../../../src/control/services/stage', () => stageCalls);
vi.mock('../../../src/control/services/listeners', () => ({
  listInstalledListeners: vi.fn(async () => []),
  buildListenerSelection: vi.fn(),
}));
vi.mock('../../../src/control/services/display-profiles', async (original) => {
  const actual = await original<typeof import('../../../src/control/services/display-profiles')>();
  return {
    ...actual,
    listDisplayProfiles: vi.fn(async () => []),
    saveDisplayProfile: vi.fn(),
  };
});

const { defaultAppSettings } = await import('../../../src/control/services/settings-types');
const { startTake } = await import('../../../src/control/lib/start-take');

const SCRIPT = {
  id: 'script-1',
  title: 'One window',
  source: '# Opening\n\nHello there.',
  scriptRevision: 4,
};

function compiled(): CompileOutput {
  return {
    stale: false,
    requestId: 1,
    scriptId: SCRIPT.id,
    sourceHash: 'hash',
    script: {
      schemaVersion: 1,
      compilerVersion: '1',
      scriptId: SCRIPT.id,
      sourceHash: 'hash',
      settingsHash: 'settings',
      title: SCRIPT.title,
      outline: [],
      blocks: [],
      spokenTokens: [
        { index: 0, blockId: 'b1', sentenceId: 's1', surface: 'Hello', normalized: 'hello' },
      ],
      sentences: [
        {
          id: 's1',
          blockId: 'b1',
          startTokenIndex: 0,
          endTokenIndex: 1,
          text: 'Hello there.',
        },
      ],
      navigationTargets: [],
      cues: [],
      assets: [],
      diagnostics: [],
      statistics: {},
      literalCommandRanges: [],
    } as never,
    blocks: [],
    outline: [],
    sentences: [
      {
        id: 's1',
        blockId: 'b1',
        startTokenIndex: 0,
        endTokenIndex: 1,
        normalizedText: 'Hello there.',
      },
    ] as never,
    navigationTargets: [],
    diagnostics: [],
    spokenWordCount: 2,
    estimatedDurationSeconds: 2,
  };
}

beforeEach(() => {
  for (const fn of Object.values(calls)) fn.mockReset();
  for (const fn of Object.values(stageCalls)) fn.mockReset();
  settingsState.value = defaultAppSettings();
  editorState.value = { scriptId: null, saveState: 'idle', lastError: null };
  micState.devices = [
    { deviceId: 'default', label: 'Built-in', isDefault: true, available: true },
    { deviceId: 'usb', label: 'USB microphone', isDefault: false, available: true },
  ];
  calls.saveNow.mockResolvedValue(undefined);
  calls.getScript.mockResolvedValue(SCRIPT);
  calls.compileScript.mockResolvedValue(compiled());
  calls.startSessionRecord.mockResolvedValue({
    id: 'session-1',
    sessionGeneration: 9,
    transcriptRetained: false,
  });
  calls.endSessionRecord.mockResolvedValue(null);
  calls.navigate.mockResolvedValue(true);
  calls.fullscreen.mockResolvedValue(undefined);
  stageCalls.listDisplays.mockResolvedValue([]);

  for (const [name, fn] of Object.entries(stageCalls)) {
    if (name === 'listDisplays') continue;
    fn.mockRejectedValue(new Error('Present must never call the stage-window service'));
  }
});

describe('single-window Present', () => {
  it('starts voice/alignment in generation zero and full-screens this webview', async () => {
    await expect(startTake(SCRIPT.id)).resolves.toBe(true);

    expect(calls.startLiveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        stageGeneration: 0,
        displayLabel: 'This window',
        listener: null,
        compiled: expect.objectContaining({ scriptId: SCRIPT.id }),
        stageEnvelope: expect.objectContaining({
          sessionId: 'session-1',
          sessionGeneration: 9,
          stageGeneration: 0,
          scriptId: SCRIPT.id,
          renderDocument: expect.objectContaining({ title: SCRIPT.title }),
        }),
      }),
    );
    expect(calls.navigate).toHaveBeenCalledWith({
      name: 'live',
      sessionId: 'session-1',
      scriptId: SCRIPT.id,
    });
    expect(calls.fullscreen).toHaveBeenCalledWith(true);
    expect(stageCalls.listDisplays).toHaveBeenCalledOnce();
    for (const [name, fn] of Object.entries(stageCalls)) {
      if (name !== 'listDisplays') expect(fn).not.toHaveBeenCalled();
    }
  });

  it('uses the configured microphone without involving a stage window', async () => {
    settingsState.value!.audio.followSystemDefault = false;
    settingsState.value!.audio.preferredDeviceId = 'old-id';
    settingsState.value!.audio.preferredDeviceLabel = 'USB microphone';

    await startTake(SCRIPT.id);
    expect(calls.startLiveSession).toHaveBeenCalledWith(
      expect.objectContaining({ micDeviceId: 'usb' }),
    );
  });

  it('tears the take down if this window cannot enter full screen', async () => {
    calls.fullscreen.mockRejectedValue(new Error('fullscreen refused'));

    await expect(startTake(SCRIPT.id)).resolves.toBe(false);
    expect(calls.stopSession).toHaveBeenCalled();
    expect(calls.clearSession).toHaveBeenCalled();
    expect(calls.endSessionRecord).toHaveBeenCalledWith('session-1');
    for (const [name, fn] of Object.entries(stageCalls)) {
      if (name !== 'listDisplays') expect(fn).not.toHaveBeenCalled();
    }
  });

  it('does not full-screen when navigation to the live surface is vetoed', async () => {
    calls.navigate.mockResolvedValue(false);
    await expect(startTake(SCRIPT.id)).resolves.toBe(false);
    expect(calls.fullscreen).not.toHaveBeenCalled();
    expect(calls.stopSession).toHaveBeenCalled();
    expect(calls.clearSession).toHaveBeenCalled();
  });

  it('does not open a session or a window when compilation fails', async () => {
    calls.compileScript.mockResolvedValue({ ...compiled(), script: null });
    await expect(startTake(SCRIPT.id)).resolves.toBe(false);
    expect(calls.startSessionRecord).not.toHaveBeenCalled();
    expect(calls.fullscreen).not.toHaveBeenCalled();
    for (const fn of Object.values(stageCalls)) expect(fn).not.toHaveBeenCalled();
  });

  it('ignores a second Present while the first one is still starting', async () => {
    let release!: () => void;
    calls.getScript.mockImplementation(
      () => new Promise((resolve) => (release = () => resolve(SCRIPT))),
    );
    const first = startTake(SCRIPT.id);
    await Promise.resolve();
    await expect(startTake(SCRIPT.id)).resolves.toBe(false);
    release();
    await expect(first).resolves.toBe(true);
    expect(calls.startSessionRecord).toHaveBeenCalledTimes(1);
  });
});
