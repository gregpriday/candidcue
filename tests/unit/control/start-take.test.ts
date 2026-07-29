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
  enterPresentation: vi.fn(),
  exitPresentation: vi.fn(),
  awaitViewportSettled: vi.fn(),
  painted: vi.fn(),
  setPresentingPhase: vi.fn(),
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
  enterPresentation: calls.enterPresentation,
  exitPresentation: calls.exitPresentation,
  awaitViewportSettled: calls.awaitViewportSettled,
  painted: calls.painted,
}));
vi.mock('../../../src/control/stores/presenting', () => ({
  setPresentingPhase: calls.setPresentingPhase,
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

type PresentationState = { presenting: boolean; width: number; height: number };

/** A promise plus its resolver, for holding one step of `startTake` open. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * Let every already-resolved await in `startTake` run to the next real gate.
 *
 * A fixed number of microtask turns rather than a timer: the sequence under
 * test is a chain of awaits over immediately-resolved mocks, and this has to
 * drain all of them without also waiting out anything deliberately held open.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

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
  calls.enterPresentation.mockResolvedValue({ presenting: true, width: 1920, height: 1080 });
  calls.exitPresentation.mockResolvedValue({ presenting: false, width: 1240, height: 820 });
  calls.awaitViewportSettled.mockResolvedValue(undefined);
  calls.painted.mockResolvedValue(undefined);
  stageCalls.listDisplays.mockResolvedValue([]);

  for (const [name, fn] of Object.entries(stageCalls)) {
    if (name === 'listDisplays') continue;
    fn.mockRejectedValue(new Error('Present must never call the stage-window service'));
  }
});

describe('single-window Present', () => {
  it('starts voice/alignment in generation zero and presents this webview', async () => {
    await expect(startTake(SCRIPT.id)).resolves.toBe(true);

    expect(calls.startLiveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        stageGeneration: 0,
        displayLabel: 'This window',
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
    expect(calls.enterPresentation).toHaveBeenCalledOnce();
    expect(stageCalls.listDisplays).toHaveBeenCalledOnce();
    for (const [name, fn] of Object.entries(stageCalls)) {
      if (name !== 'listDisplays') expect(fn).not.toHaveBeenCalled();
    }
  });

  /**
   * THE ORDER IS THE FIX.
   *
   * Present used to navigate to Live, mount the stage, and only then ask the
   * window to change shape. That is what put a white bar over the top of the
   * glass for the length of the macOS full-screen animation — the webview's
   * painted surface was the old, smaller one and AppKit filled the rest with
   * the window background — and it is also what made the stage measure its
   * whole line map at the editor's window size and then measure it again after
   * the resize.
   *
   * Neither symptom is visible to this suite: nothing here has a window, and
   * the browser suite's Tauri shim does not resize anything. So the ordering
   * itself is the thing under test, asserted through the call clock, because it
   * is the only part of the fix a headless run can actually see.
   */
  it('changes the window shape before the session goes live, not after', async () => {
    await expect(startTake(SCRIPT.id)).resolves.toBe(true);

    const enteredAt = calls.enterPresentation.mock.invocationCallOrder[0]!;
    const settledAt = calls.awaitViewportSettled.mock.invocationCallOrder[0]!;
    const sessionAt = calls.startLiveSession.mock.invocationCallOrder[0]!;
    const navigatedAt = calls.navigate.mock.invocationCallOrder[0]!;

    // The cover goes up first, and is painted before anything moves — raising
    // a cover and moving the window in the same frame is the same bug with a
    // different first frame.
    expect(calls.setPresentingPhase).toHaveBeenNthCalledWith(1, 'opening');
    expect(calls.painted.mock.invocationCallOrder[0]!).toBeLessThan(enteredAt);

    expect(enteredAt).toBeLessThan(settledAt);
    expect(settledAt).toBeLessThan(sessionAt);
    expect(sessionAt).toBeLessThan(navigatedAt);

    // ...and the cover only comes down once the stage has had a frame to paint.
    expect(calls.setPresentingPhase).toHaveBeenLastCalledWith('on');
    expect(calls.painted).toHaveBeenCalledTimes(2);
  });

  /**
   * ...AND IT ACTUALLY WAITS, WHICH THE TEST ABOVE DOES NOT PROVE.
   *
   * `invocationCallOrder` records when a call STARTED. Every mock above
   * resolves immediately, so dropping the `await` from `enterPresentation()`
   * would leave the start order completely unchanged and that test green —
   * while the stage mounted into a window that had not finished moving, which
   * is the entire defect.
   *
   * So these two hold the gate open and assert that nothing downstream has
   * happened yet. A missing `await` fails here and nowhere else.
   */
  it('does not start the session until the window has actually moved', async () => {
    const gate = deferred<PresentationState>();
    calls.enterPresentation.mockReturnValue(gate.promise);

    const running = startTake(SCRIPT.id);
    await settle();

    expect(calls.enterPresentation).toHaveBeenCalledOnce();
    expect(calls.startLiveSession).not.toHaveBeenCalled();
    expect(calls.navigate).not.toHaveBeenCalled();

    gate.resolve({ presenting: true, width: 1920, height: 1080 });
    await expect(running).resolves.toBe(true);
    expect(calls.startLiveSession).toHaveBeenCalledOnce();
  });

  it('does not start the session until the viewport has settled at the new size', async () => {
    const gate = deferred<void>();
    calls.awaitViewportSettled.mockReturnValue(gate.promise);

    const running = startTake(SCRIPT.id);
    await settle();

    expect(calls.awaitViewportSettled).toHaveBeenCalledOnce();
    expect(calls.startLiveSession).not.toHaveBeenCalled();

    gate.resolve();
    await expect(running).resolves.toBe(true);
    expect(calls.startLiveSession).toHaveBeenCalledOnce();
  });

  /**
   * The cover must not come down before the stage has had its frame — dropping
   * it early shows whatever the editor left behind, which is a worse artifact
   * than the one being fixed because it is the WRONG screen, not a blank one.
   */
  it('holds the cover up until the stage has painted', async () => {
    const gate = deferred<void>();
    // The second `painted()` is the stage hand-off; the first is the cover's own.
    calls.painted.mockResolvedValueOnce(undefined).mockReturnValueOnce(gate.promise);

    const running = startTake(SCRIPT.id);
    await settle();

    expect(calls.navigate).toHaveBeenCalledOnce();
    expect(calls.setPresentingPhase).not.toHaveBeenCalledWith('on');

    gate.resolve();
    await expect(running).resolves.toBe(true);
    expect(calls.setPresentingPhase).toHaveBeenLastCalledWith('on');
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

  it('tears the take down if this window cannot be presented', async () => {
    calls.enterPresentation.mockRejectedValue(new Error('presentation refused'));

    await expect(startTake(SCRIPT.id)).resolves.toBe(false);
    expect(calls.stopSession).toHaveBeenCalled();
    expect(calls.clearSession).toHaveBeenCalled();
    expect(calls.endSessionRecord).toHaveBeenCalledWith('session-1');
    expect(calls.setPresentingPhase).toHaveBeenLastCalledWith('off');
    for (const [name, fn] of Object.entries(stageCalls)) {
      if (name !== 'listDisplays') expect(fn).not.toHaveBeenCalled();
    }
  });

  /**
   * The window is already borderless and monitor-sized by the time navigation
   * is vetoed, so the teardown has to give it back — otherwise the operator is
   * stranded full-screen with no titlebar, looking at the editor and a toast.
   */
  it('puts the window back when navigation to the live surface is vetoed', async () => {
    calls.navigate.mockResolvedValue(false);
    await expect(startTake(SCRIPT.id)).resolves.toBe(false);
    expect(calls.exitPresentation).toHaveBeenCalledOnce();
    expect(calls.setPresentingPhase).toHaveBeenLastCalledWith('off');
    expect(calls.stopSession).toHaveBeenCalled();
    expect(calls.clearSession).toHaveBeenCalled();
  });

  it('does not open a session or touch the window when compilation fails', async () => {
    calls.compileScript.mockResolvedValue({ ...compiled(), script: null });
    await expect(startTake(SCRIPT.id)).resolves.toBe(false);
    expect(calls.startSessionRecord).not.toHaveBeenCalled();
    expect(calls.enterPresentation).not.toHaveBeenCalled();
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
