import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompileOutput } from '../../../src/control/services/compiler';
import type { AppSettings } from '../../../src/control/services/settings-types';
import type { DisplayDescriptor } from '../../../src/control/services/stage-types';
import type { LensPlacement } from '../../../src/shared/contracts/optical';

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
  patchSettings: vi.fn(),
  preloadSpeechEngine: vi.fn(),
}));

const editorState = vi.hoisted(() => ({
  value: { scriptId: null as string | null, saveState: 'idle', lastError: null as string | null },
}));
const settingsState = vi.hoisted(() => ({ value: null as AppSettings | null }));
/**
 * The cover phase is READ by `startTake` as well as written by it, so the mock
 * has to be a real value rather than a pair of spies: the entry guard refuses a
 * take that would begin while another transition still owns the cover, and a
 * stub that always answered "off" would make that guard untestable.
 */
const presentingState = vi.hoisted(() => ({ phase: 'off' as string }));
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
  // `get()` on a store only needs `subscribe`, and the real store's semantics
  // are one comparison — copied rather than imported so the mock cannot drift
  // into re-exporting the module it is standing in for.
  presentingPhase: { subscribe: (run: (v: string) => void) => (run(presentingState.phase), () => {}) },
  coverIsUp: (value: string) => value === 'opening' || value === 'closing',
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
    patchSettings: calls.patchSettings,
    settings: readable(settingsState.value, (set) => {
      set(settingsState.value);
      return () => {};
    }),
  };
});
vi.mock('../../../src/control/services/voice-facade', () => ({
  getVoiceFacade: () => ({ listMicrophones: async () => micState.devices }),
}));
vi.mock('../../../src/control/services/stt/local', () => ({
  preloadSpeechEngine: calls.preloadSpeechEngine,
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

const { defaultAppSettings, opticalRigKey, READER_RIG_NAME } = await import(
  '../../../src/control/services/settings-types'
);
const { defaultOpticalProfile } = await import('../../../src/shared/contracts/optical');
const { resolveLandedDisplay, startTake } = await import('../../../src/control/lib/start-take');

type PresentationState = {
  presenting: boolean;
  width: number;
  height: number;
  /** The panel presenting landed on; absent when it could not be named. */
  displayFingerprint?: string;
};

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
    parts: [],
    diagnostics: [],
    spokenWordCount: 2,
    estimatedDurationSeconds: 2,
  };
}

/**
 * A glass panel whose saved mirroring is on, and the only display connected —
 * so whichever mode a take opens in, it lands here. No physical size and no
 * prompter name, so it resolves no optics: these tests are about the mirror.
 */
const GLASS: DisplayDescriptor = {
  id: 'display-glass',
  name: 'Glass monitor',
  primary: false,
  physicalPosition: { x: 0, y: 0 },
  physicalSize: { width: 1920, height: 1080 },
  logicalSize: { width: 1920, height: 1080 },
  scaleFactor: 1,
  fingerprint: 'panel-glass',
  topologyHash: 'topology-glass',
};

/** Connect only `GLASS`, mirrored horizontally the way a beamsplitter needs. */
function presentOnMirroredGlass(): void {
  stageCalls.listDisplays.mockResolvedValue([GLASS]);
  settingsState.value!.optical.panelMirror = {
    [GLASS.fingerprint]: { horizontal: true, vertical: false },
  };
}

beforeEach(() => {
  for (const fn of Object.values(calls)) fn.mockReset();
  for (const fn of Object.values(stageCalls)) fn.mockReset();
  settingsState.value = defaultAppSettings();
  presentingState.phase = 'off';
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
  });
  calls.endSessionRecord.mockResolvedValue(null);
  calls.navigate.mockResolvedValue(true);
  calls.enterPresentation.mockResolvedValue({ presenting: true, width: 1920, height: 1080 });
  calls.exitPresentation.mockResolvedValue({ presenting: false, width: 1240, height: 820 });
  calls.awaitViewportSettled.mockResolvedValue(undefined);
  calls.painted.mockResolvedValue(undefined);
  calls.patchSettings.mockResolvedValue(undefined);
  calls.preloadSpeechEngine.mockResolvedValue(undefined);
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
   * The recogniser starts loading while the take is still being built (#257).
   *
   * A cold load is over a second, and the voice pipeline is the last thing a
   * take starts. The compile and the window taking the display are time the
   * load can run in rather than time the presenter spends talking ahead of it.
   */
  it('starts loading the recogniser before the compile, not when the session goes live', async () => {
    await expect(startTake(SCRIPT.id)).resolves.toBe(true);

    expect(calls.preloadSpeechEngine).toHaveBeenCalledOnce();
    const preloadAt = calls.preloadSpeechEngine.mock.invocationCallOrder[0]!;
    expect(preloadAt).toBeLessThan(calls.compileScript.mock.invocationCallOrder[0]!);
    expect(preloadAt).toBeLessThan(calls.enterPresentation.mock.invocationCallOrder[0]!);
    expect(preloadAt).toBeLessThan(calls.startLiveSession.mock.invocationCallOrder[0]!);
  });

  it('does not wait for the load', async () => {
    calls.preloadSpeechEngine.mockReturnValue(new Promise(() => {}));
    await expect(startTake(SCRIPT.id)).resolves.toBe(true);
    expect(calls.startLiveSession).toHaveBeenCalledOnce();
  });

  it('presents anyway when the preload fails, leaving the error to the take', async () => {
    calls.preloadSpeechEngine.mockRejectedValue({ code: 'STT_MODEL_NOT_INSTALLED' });

    await expect(startTake(SCRIPT.id)).resolves.toBe(true);
    expect(calls.startLiveSession).toHaveBeenCalledOnce();
    expect(calls.showToast).not.toHaveBeenCalled();
  });

  for (const mode of ['manual', 'fixed'] as const) {
    it(`does not load a recogniser for a ${mode} take, which never starts one`, async () => {
      const base = defaultAppSettings();
      settingsState.value = { ...base, general: { ...base.general, defaultSessionMode: mode } };

      await expect(startTake(SCRIPT.id)).resolves.toBe(true);
      expect(calls.startLiveSession).toHaveBeenCalledWith(expect.objectContaining({ mode }));
      expect(calls.preloadSpeechEngine).not.toHaveBeenCalled();
    });
  }

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

  /*
   * A START MAY NOT RACE A FINISH.
   *
   * Both ends of a presentation transition write `presentingPhase` from a
   * `finally`, last writer wins, and nothing carries an owner token — so a take
   * begun while a teardown is still unwinding has its `opening` overwritten by
   * the other one's `off`. The result is an app presenting with no cover, or
   * covered with nothing to present, and the only way out is quitting.
   *
   * It became reachable when a take started ending on the EDITOR: the route
   * swap happens under the cover, so for one paint the screen underneath has a
   * Present button and answers the Present shortcut. The console it replaced
   * had neither, which is why the existing `takeStarting` latch — which only
   * ever stopped a second START — was enough before and is not now.
   */
  it.each(['opening', 'closing'])(
    'refuses to begin while another transition still owns the cover (%s)',
    async (phase) => {
      presentingState.phase = phase;
      await expect(startTake(SCRIPT.id)).resolves.toBe(false);
      // Nothing at all, not even a phase write: the point is that the other
      // transition's cover is left exactly as it found it.
      expect(calls.setPresentingPhase).not.toHaveBeenCalled();
      expect(calls.enterPresentation).not.toHaveBeenCalled();
      expect(calls.startSessionRecord).not.toHaveBeenCalled();
      expect(calls.navigate).not.toHaveBeenCalled();
    },
  );

  it('still begins from the steady states', async () => {
    // The guard must be about transitions only. `off` is the ordinary case and
    // `on` is a take already running, which is somebody else's problem to
    // refuse — a guard that caught either would break Present outright.
    presentingState.phase = 'on';
    await expect(startTake(SCRIPT.id)).resolves.toBe(true);
  });

  it('does not open a session or touch the window when compilation fails', async () => {
    calls.compileScript.mockResolvedValue({ ...compiled(), script: null });
    await expect(startTake(SCRIPT.id)).resolves.toBe(false);
    expect(calls.startSessionRecord).not.toHaveBeenCalled();
    expect(calls.enterPresentation).not.toHaveBeenCalled();
    for (const fn of Object.values(stageCalls)) expect(fn).not.toHaveBeenCalled();
  });

  /**
   * New scripts start empty, so this is the state a script is in for as long as
   * it takes somebody to write the first line — and Present sat live over it.
   *
   * Nothing downstream would have said so. An empty script compiles clean (that
   * is deliberate: a blank document is not a mistake), `startAlignment` no-ops on
   * zero tokens and the session counts that as a healthy start. So the take would
   * open the microphone, load the recogniser, fill the monitor, and hold still.
   */
  it('refuses to present a script with no words, without acquiring anything', async () => {
    calls.compileScript.mockResolvedValue({ ...compiled(), spokenWordCount: 0 });

    await expect(startTake(SCRIPT.id)).resolves.toBe(false);
    expect(calls.startSessionRecord).not.toHaveBeenCalled();
    expect(calls.startLiveSession).not.toHaveBeenCalled();
    expect(calls.enterPresentation).not.toHaveBeenCalled();
    expect(calls.navigate).not.toHaveBeenCalled();
    // Nothing was acquired, so there is nothing to tear down — and the window
    // was never covered, which is what would strand the operator behind an
    // opaque plate if the refusal took the failure path instead.
    expect(calls.setPresentingPhase).not.toHaveBeenCalled();
    expect(calls.exitPresentation).not.toHaveBeenCalled();
    for (const fn of Object.values(stageCalls)) expect(fn).not.toHaveBeenCalled();
  });

  it('says why it refused, as a notice rather than a failure', async () => {
    calls.compileScript.mockResolvedValue({ ...compiled(), spokenWordCount: 0 });

    await startTake(SCRIPT.id);
    const [message, tone] = calls.showToast.mock.calls[0] ?? [];
    // An empty script is an ordinary state, not a fault, and the copy has to be
    // about the script rather than about the app failing to do something.
    expect(tone).toBe('info');
    expect(message).toContain('no words');
    expect(message).not.toContain('Could not');
  });

  it('lets a take that has just one word through', async () => {
    // The guard is "nothing to follow", not a length opinion. A one-word script
    // is a strange script and a perfectly valid take.
    calls.compileScript.mockResolvedValue({ ...compiled(), spokenWordCount: 1 });
    await expect(startTake(SCRIPT.id)).resolves.toBe(true);
    expect(calls.startLiveSession).toHaveBeenCalled();
  });

  /* ------------------------------------------------- how the take opens */

  it('opens in the saved mode and writes nothing when no choice was made', async () => {
    // The main Present button. It asks no question and changes no setting.
    settingsState.value!.stage.presentationMode = 'reader';
    await expect(startTake(SCRIPT.id)).resolves.toBe(true);
    expect(calls.enterPresentation).toHaveBeenCalledWith('reader', null, null);
    expect(calls.patchSettings).not.toHaveBeenCalled();
  });

  it('composes the stage for the mode it is actually opening in', async () => {
    /*
     * The regression this exists for. The mode used to be resolved into a bare
     * string while `stageSettingsFromSettings` kept reading the PRE-CHOICE
     * settings snapshot — so choosing "Present in a window" from a prompter
     * default opened a reading window composed for glass: prompter optics, and
     * a horizontally mirrored script if the rig had mirroring on.
     *
     * Asserted on what the session is actually handed, because that is the
     * object the stage renders from. Checking the window command alone is what
     * let this through: that call was always correct.
     */
    settingsState.value!.stage.presentationMode = 'prompter';
    presentOnMirroredGlass();

    await expect(startTake(SCRIPT.id, { presentationMode: 'reader' })).resolves.toBe(true);

    const opened = calls.startLiveSession.mock.calls[0]![0] as {
      presentationMode: string;
      stageSettings: { readingContext?: string; mirrorX: boolean };
      stageEnvelope: { stageSettings: { readingContext?: string; mirrorX: boolean } };
    };
    expect(opened.presentationMode).toBe('reader');
    expect(opened.stageSettings.readingContext).toBe('reader');
    // A reading window is read at desk distance with no beamsplitter in the
    // optical path, so there is nothing for a mirror to undo.
    expect(opened.stageSettings.mirrorX).toBe(false);
    // The envelope is what actually reaches the renderer; it must not disagree.
    expect(opened.stageEnvelope.stageSettings.readingContext).toBe('reader');
    expect(opened.stageEnvelope.stageSettings.mirrorX).toBe(false);
  });

  it('composes the stage for a prompter chosen out of a reader default', async () => {
    // The same defect in the other direction: a glass rig composed as a desk.
    settingsState.value!.stage.presentationMode = 'reader';
    presentOnMirroredGlass();

    await expect(startTake(SCRIPT.id, { presentationMode: 'prompter' })).resolves.toBe(true);

    const opened = calls.startLiveSession.mock.calls[0]![0] as {
      presentationMode: string;
      stageSettings: { readingContext?: string; mirrorX: boolean };
    };
    expect(opened.presentationMode).toBe('prompter');
    expect(opened.stageSettings.readingContext).not.toBe('reader');
    expect(opened.stageSettings.mirrorX).toBe(true);
  });

  it('remembers a mode chosen explicitly at the moment of presenting', async () => {
    /*
     * The whole point of the split menu. An explicit choice is a statement about
     * how this operator presents — unlike the mid-take toggle, which
     * `stores/session.ts` deliberately keeps take-scoped — so the NEXT take must
     * open the same way without being told again.
     */
    settingsState.value!.stage.presentationMode = 'prompter';
    await expect(
      startTake(SCRIPT.id, { presentationMode: 'reader' }),
    ).resolves.toBe(true);
    expect(calls.patchSettings).toHaveBeenCalledWith('stage', { presentationMode: 'reader' });
    expect(calls.enterPresentation).toHaveBeenCalledWith('reader', null, null);
  });

  it('does not write a setting that already says what was asked for', async () => {
    settingsState.value!.stage.presentationMode = 'reader';
    await expect(startTake(SCRIPT.id, { presentationMode: 'reader' })).resolves.toBe(true);
    expect(calls.patchSettings).not.toHaveBeenCalled();
  });

  it('presents anyway when the choice could not be saved', async () => {
    // A settings document that would not take the patch is not a reason to
    // refuse to present. `patchSettings` has already reported the failure.
    calls.patchSettings.mockRejectedValue(new Error('revision conflict'));
    await expect(startTake(SCRIPT.id, { presentationMode: 'reader' })).resolves.toBe(true);
    expect(calls.enterPresentation).toHaveBeenCalledWith('reader', null, null);
  });

  it('hands back a remembered reading window', async () => {
    const frame = { x: 40, y: 60, width: 720, height: 540 };
    settingsState.value!.stage.presentationMode = 'reader';
    settingsState.value!.stage.readerFrame = frame;
    settingsState.value!.general.restoreWindows = true;
    await expect(startTake(SCRIPT.id)).resolves.toBe(true);
    expect(calls.enterPresentation).toHaveBeenCalledWith('reader', frame, null);
  });

  it('leaves the window where it is when the operator asked us not to remember', async () => {
    settingsState.value!.stage.presentationMode = 'reader';
    settingsState.value!.stage.readerFrame = { x: 40, y: 60, width: 720, height: 540 };
    settingsState.value!.general.restoreWindows = false;
    await expect(startTake(SCRIPT.id)).resolves.toBe(true);
    expect(calls.enterPresentation).toHaveBeenCalledWith('reader', null, null);
  });

  it('never hands a stored frame to a prompter', async () => {
    // A prompter fills whichever monitor it is on. A stored rectangle would be
    // describing something else entirely.
    settingsState.value!.stage.presentationMode = 'prompter';
    settingsState.value!.stage.readerFrame = { x: 40, y: 60, width: 720, height: 540 };
    await expect(startTake(SCRIPT.id)).resolves.toBe(true);
    expect(calls.enterPresentation).toHaveBeenCalledWith('prompter', null, null);
  });

  it('hands the pinned panel to a prompter, so Present moves the window there', async () => {
    /*
     * The rig this app is for: the editor lives on the desk monitor and the
     * prompter is a 1024x600 panel behind a lens. Present used to fill whichever
     * monitor the window was on, so every take began by dragging the editor
     * onto the glass. Rust honours the pin when it is connected and falls back
     * to the current monitor when it is not; the frontend's job is to pass it.
     */
    settingsState.value!.stage.presentationMode = 'prompter';
    settingsState.value!.stage.displayFingerprint = 'elgato-1024x600';
    await expect(startTake(SCRIPT.id)).resolves.toBe(true);
    expect(calls.enterPresentation).toHaveBeenCalledWith('prompter', null, 'elgato-1024x600');
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

/* ------------------------------------------ the panel the take is measured on */

/**
 * Where a take begins (CCUX-014, CCUX-015, CCUX-016).
 *
 * `startTake` wrote `startTokenIndex: 0` onto every session row while the field
 * had been on the record since it was written, so a creator who fumbled a line
 * six minutes in had to read the first six minutes again.
 *
 * The snapping itself is unit-tested in `take-start-point.test.ts`. What is
 * asserted here is the WIRING — that one number reaches all three of the places
 * that have to agree about it, because a start point recorded on the session
 * but not given to the aligner is worse than none: the glass would show one
 * place and the engine would be searching from another.
 */
describe('starting somewhere other than the top', () => {
  /** A script with three sentences and a heading, so a start point can exist. */
  function multiSentence() {
    const base = compiled();
    const sentences = [
      { id: 's1', blockId: 'b1', startTokenIndex: 0, endTokenIndex: 9, normalizedText: 'welcome to the update' },
      { id: 's2', blockId: 'b2', startTokenIndex: 20, endTokenIndex: 29, normalizedText: 'our pricing changed' },
      { id: 's3', blockId: 'b3', startTokenIndex: 30, endTokenIndex: 39, normalizedText: 'the standard plan is thirty' },
    ];
    return {
      ...base,
      sentences: sentences as never,
      spokenWordCount: 40,
      script: { ...(base.script as unknown as Record<string, unknown>), sentences } as never,
    };
  }

  beforeEach(() => {
    calls.compileScript.mockResolvedValue(multiSentence());
  });

  it('records the start point on the session row', async () => {
    await expect(startTake(SCRIPT.id, { startTokenIndex: 34 })).resolves.toBe(true);
    expect(calls.startSessionRecord).toHaveBeenCalledWith(
      // Snapped back to the start of the sentence containing token 34.
      expect.objectContaining({ startTokenIndex: 30 }),
    );
  });

  it('opens the glass at the same token it recorded', async () => {
    await expect(startTake(SCRIPT.id, { startTokenIndex: 34 })).resolves.toBe(true);
    const input = calls.startLiveSession.mock.calls[0]![0] as {
      startTokenIndex: number;
      stageEnvelope: { initialTokenIndex: number };
    };
    /*
     * Both, and they must match. `initialTokenIndex` has been on the envelope
     * since it was written and nothing on the stage read it, so a take asked to
     * start at a section opened at the top and then CRAWLED there — a
     * jerk-limited travel through the whole script before a word was said.
     */
    expect(input.startTokenIndex).toBe(30);
    expect(input.stageEnvelope.initialTokenIndex).toBe(30);
  });

  it('still starts at the beginning when nothing asks otherwise', async () => {
    // The default path must be bit-identical to what it was before start
    // points existed.
    await expect(startTake(SCRIPT.id)).resolves.toBe(true);
    expect(calls.startSessionRecord).toHaveBeenCalledWith(
      expect.objectContaining({ startTokenIndex: 0 }),
    );
    const input = calls.startLiveSession.mock.calls[0]![0] as {
      stageEnvelope: { initialTokenIndex: number };
    };
    expect(input.stageEnvelope.initialTokenIndex).toBe(0);
  });

  it('refuses to start past the end of the script', async () => {
    // An index from a stale outline or a previous, longer revision must not
    // anchor the aligner outside the token array it was handed.
    await expect(startTake(SCRIPT.id, { startTokenIndex: 9999 })).resolves.toBe(true);
    const recorded = calls.startSessionRecord.mock.calls[0]![0] as { startTokenIndex: number };
    expect(recorded.startTokenIndex).toBeLessThan(40);
    expect(recorded.startTokenIndex).toBe(30);
  });
});

describe('the display a take is calibrated against', () => {
  /*
   * The defect: Present fills whichever monitor this window is already on and
   * deliberately not the pinned one (`windows/present.rs` argues why), but the
   * take used to be SIZED from the pin. An operator with an external prompter
   * pinned who pressed Present at their laptop therefore read type laid out in
   * the external panel's millimetres-per-pixel — and `mmPerCssPx` is the whole
   * basis of the angular model, so that is a confidently wrong physical size
   * rather than a near miss.
   *
   * Asserted through `fontSizePx`, which is the number the presenter actually
   * sees. Two panels with different millimetres-per-pixel and the same rig
   * settings must not produce the same type.
   */
  const LAPTOP: DisplayDescriptor = {
    id: 'display-1',
    name: 'Built-in Display',
    primary: true,
    physicalPosition: { x: 0, y: 0 },
    physicalSize: { width: 3456, height: 2234 },
    logicalSize: { width: 1728, height: 1117 },
    scaleFactor: 2,
    fingerprint: 'panel-laptop',
    topologyHash: 'topology-1',
  };
  const PROMPTER: DisplayDescriptor = {
    ...LAPTOP,
    id: 'display-2',
    name: 'Elgato Prompter',
    primary: false,
    fingerprint: 'panel-prompter',
  };

  /** A calibrated rig, distinguishable only by the panel scale it was measured at. */
  function rig(rigName: string, mmPerCssPx: number, lensPlacement: LensPlacement) {
    return {
      ...defaultOpticalProfile(),
      rigName,
      lensPlacement,
      scale: { mmPerCssPx, source: 'ruler' as const },
      viewingDistanceMm: 900,
    };
  }

  /**
   * Both panels calibrated, under `rigName`, at scales that cannot be confused.
   *
   * `lensPlacement` is not decoration. `readerOpticalProfile` adopts a stored
   * rig only when it reads `'none'` — the one field only a reading rig has —
   * and otherwise derives an uncalibrated profile, refusing even to inherit a
   * `'ruler'` scale because a ruler measures the finished optical path. A
   * reader fixture left at the prompter default therefore sizes BOTH panels
   * identically, and a test asserting only the panel's name would pass while
   * the type came out the same either way.
   */
  function calibrateBoth(rigName: string, lensPlacement: LensPlacement): void {
    settingsState.value!.optical = {
      activeRig: { [LAPTOP.fingerprint]: rigName, [PROMPTER.fingerprint]: rigName },
      profiles: {
        [opticalRigKey(LAPTOP.fingerprint, rigName)]: rig(rigName, 0.12, lensPlacement),
        [opticalRigKey(PROMPTER.fingerprint, rigName)]: rig(rigName, 0.48, lensPlacement),
      },
      panelMirror: {},
    };
  }

  /** The `StageSettings` the session was actually opened with. */
  function opened(): {
    stageSettings: { fontSizePx: number };
    stageEnvelope: { stageSettings: { fontSizePx: number } };
    stageDisplay: DisplayDescriptor | null;
  } {
    return calls.startLiveSession.mock.calls[0]![0] as never;
  }

  beforeEach(() => {
    stageCalls.listDisplays.mockResolvedValue([LAPTOP, PROMPTER]);
  });

  it('sizes a prompter from the panel it landed on, not the pinned one', async () => {
    // The issue's exact rig: the external prompter is pinned, and the window is
    // sitting on the laptop when Present is pressed.
    settingsState.value!.stage.presentationMode = 'prompter';
    settingsState.value!.stage.displayFingerprint = PROMPTER.fingerprint;
    calibrateBoth('Studio hood', 'in-panel');
    calls.enterPresentation.mockResolvedValue({
      presenting: true,
      width: 1728,
      height: 1117,
      displayFingerprint: LAPTOP.fingerprint,
    });

    await expect(startTake(SCRIPT.id)).resolves.toBe(true);

    expect(opened().stageDisplay?.fingerprint).toBe(LAPTOP.fingerprint);
    const onLaptop = opened().stageSettings.fontSizePx;
    // The envelope is what actually reaches the renderer; it must not disagree.
    expect(opened().stageEnvelope.stageSettings.fontSizePx).toBe(onLaptop);

    /*
     * And the two panels must genuinely size differently, or every assertion
     * above would pass just as well on a pin that happened to be harmless.
     * This is the number the presenter reads off the glass.
     */
    calls.startLiveSession.mockClear();
    calls.enterPresentation.mockResolvedValue({
      presenting: true,
      width: 1728,
      height: 1117,
      displayFingerprint: PROMPTER.fingerprint,
    });
    await expect(startTake(SCRIPT.id)).resolves.toBe(true);
    expect(opened().stageSettings.fontSizePx).not.toBe(onLaptop);
  });

  it('mirrors only for the glass, so a take that falls back to the laptop reads forwards (#206)', async () => {
    /*
     * The issue's first case, exactly: the glass is pinned and mirrored, the
     * operator presses Present with the window on the laptop, and Rust lands
     * the take there. Mirroring used to be one global switch, so the laptop
     * showed the script backwards.
     */
    settingsState.value!.stage.presentationMode = 'prompter';
    settingsState.value!.stage.displayFingerprint = PROMPTER.fingerprint;
    settingsState.value!.optical = {
      ...settingsState.value!.optical,
      panelMirror: { [PROMPTER.fingerprint]: { horizontal: true, vertical: true } },
    };
    calls.enterPresentation.mockResolvedValue({
      presenting: true,
      width: 1728,
      height: 1117,
      displayFingerprint: LAPTOP.fingerprint,
    });

    await expect(startTake(SCRIPT.id)).resolves.toBe(true);

    const onLaptop = calls.startLiveSession.mock.calls[0]![0] as {
      stageSettings: { mirrorX: boolean; mirrorY: boolean };
      stageEnvelope: { stageSettings: { mirrorX: boolean; mirrorY: boolean } };
    };
    expect(onLaptop.stageSettings.mirrorX).toBe(false);
    expect(onLaptop.stageSettings.mirrorY).toBe(false);
    // The envelope is what reaches the renderer; it must not disagree.
    expect(onLaptop.stageEnvelope.stageSettings.mirrorX).toBe(false);

    // And the glass itself is still mirrored the way that rig needs.
    calls.startLiveSession.mockClear();
    calls.enterPresentation.mockResolvedValue({
      presenting: true,
      width: 1024,
      height: 600,
      displayFingerprint: PROMPTER.fingerprint,
    });
    await expect(startTake(SCRIPT.id)).resolves.toBe(true);
    const onGlass = calls.startLiveSession.mock.calls[0]![0] as {
      stageSettings: { mirrorX: boolean; mirrorY: boolean };
      stageEnvelope: { stageSettings: { mirrorX: boolean } };
    };
    expect(onGlass.stageSettings.mirrorX).toBe(true);
    expect(onGlass.stageSettings.mirrorY).toBe(true);
    expect(onGlass.stageEnvelope.stageSettings.mirrorX).toBe(true);
  });

  it('sizes a reading window from the panel it landed on', async () => {
    /*
     * The same exposure in reader mode. `chooseStageDisplay` guessed the PRIMARY
     * display here, which is the honest guess and still wrong for a reader who
     * dragged their window to the external panel before pressing Present.
     */
    settingsState.value!.stage.presentationMode = 'reader';
    // `'none'` is what makes these adoptable AS reading rigs; see `calibrateBoth`.
    calibrateBoth(READER_RIG_NAME, 'none');
    calls.enterPresentation.mockResolvedValue({
      presenting: true,
      width: 1200,
      height: 800,
      displayFingerprint: PROMPTER.fingerprint,
    });

    await expect(startTake(SCRIPT.id)).resolves.toBe(true);

    expect(opened().stageDisplay?.fingerprint).toBe(PROMPTER.fingerprint);
    const onPrompter = opened().stageSettings.fontSizePx;

    // Named the right panel AND sized from it — the two are separate claims,
    // and a reader fixture that is not a reading rig satisfies only the first.
    calls.startLiveSession.mockClear();
    calls.enterPresentation.mockResolvedValue({
      presenting: true,
      width: 1200,
      height: 800,
      displayFingerprint: LAPTOP.fingerprint,
    });
    await expect(startTake(SCRIPT.id)).resolves.toBe(true);
    expect(opened().stageDisplay?.fingerprint).toBe(LAPTOP.fingerprint);
    expect(opened().stageSettings.fontSizePx).not.toBe(onPrompter);
  });

  it('falls back to the guess when Rust names no display', async () => {
    /*
     * Plain-browser dev has no monitors to name, and a rig whose monitor cannot
     * be identified reports nothing rather than guessing. Neither may take the
     * take down with it: the pre-present guess is what shipped before this
     * reporting existed, so falling back to it is never a regression.
     */
    settingsState.value!.stage.presentationMode = 'prompter';
    settingsState.value!.stage.displayFingerprint = PROMPTER.fingerprint;
    calibrateBoth('Studio hood', 'in-panel');
    calls.enterPresentation.mockResolvedValue({ presenting: true, width: 1728, height: 1117 });

    await expect(startTake(SCRIPT.id)).resolves.toBe(true);

    expect(opened().stageDisplay?.fingerprint).toBe(PROMPTER.fingerprint);
  });

  it('falls back rather than inventing a panel nobody enumerated', async () => {
    // A fingerprint naming a display this enumeration does not have is the same
    // "we do not know" — and a profile keyed to a display nobody can see is not
    // calibration.
    settingsState.value!.stage.presentationMode = 'prompter';
    settingsState.value!.stage.displayFingerprint = LAPTOP.fingerprint;
    calibrateBoth('Studio hood', 'in-panel');
    calls.enterPresentation.mockResolvedValue({
      presenting: true,
      width: 1728,
      height: 1117,
      displayFingerprint: 'panel-that-went-away',
    });

    await expect(startTake(SCRIPT.id)).resolves.toBe(true);

    expect(opened().stageDisplay?.fingerprint).toBe(LAPTOP.fingerprint);
  });

  it('does not compose the stage until the window has actually presented', async () => {
    /*
     * The ordering this fix depends on. The panel is not known until
     * `enterPresentation` resolves, so a stage composed before that could only
     * have been composed from a guess.
     */
    settingsState.value!.stage.presentationMode = 'prompter';
    /*
     * Pinned to the laptop so the pre-present guess and the landed panel
     * disagree. Without that the guess would happen to name the same display
     * and this would pass just as well on the code that never asked.
     */
    settingsState.value!.stage.displayFingerprint = LAPTOP.fingerprint;
    calibrateBoth('Studio hood', 'in-panel');
    const held = deferred<PresentationState>();
    calls.enterPresentation.mockReturnValue(held.promise);

    const take = startTake(SCRIPT.id);
    await settle();
    expect(calls.startLiveSession).not.toHaveBeenCalled();

    held.resolve({
      presenting: true,
      width: 1728,
      height: 1117,
      displayFingerprint: PROMPTER.fingerprint,
    } as PresentationState);
    await expect(take).resolves.toBe(true);
    expect(opened().stageDisplay?.fingerprint).toBe(PROMPTER.fingerprint);
  });

  /*
   * The same answer, read at the other moment it arrives. Every arm of
   * `set_control_presenting` reports the panel it applied geometry to, and the
   * mid-take ⌃⌘F switch goes through that command too — `Live.svelte` resolves
   * the reply through this and hands it to `adoptPresentationMode`, which is
   * what stops a switch onto another monitor keeping the opening panel's scale.
   */
  describe('resolving the panel a switch landed on', () => {
    it('names the display the fingerprint belongs to', async () => {
      await expect(resolveLandedDisplay(PROMPTER.fingerprint)).resolves.toEqual(PROMPTER);
    });

    it('answers null rather than guessing when Rust names nothing', async () => {
      // Null is "no answer", not "the wrong panel": the caller keeps the panel
      // the take is already measured against, which is better than a guess.
      await expect(resolveLandedDisplay(undefined)).resolves.toBeNull();
      expect(stageCalls.listDisplays).not.toHaveBeenCalled();
    });

    it('answers null for a panel this enumeration does not have', async () => {
      await expect(resolveLandedDisplay('panel-that-went-away')).resolves.toBeNull();
    });

    it('answers null rather than throwing when the displays cannot be enumerated', async () => {
      // A failed enumeration must not take down a switch the window has already
      // made — the mode still has to be adopted.
      stageCalls.listDisplays.mockRejectedValue(new Error('no display server'));
      await expect(resolveLandedDisplay(PROMPTER.fingerprint)).resolves.toBeNull();
    });
  });
});

/* --------------------------------------------------------------- practice */

/**
 * Opening a rehearsal.
 *
 * The whole risk in this feature is a practice that quietly becomes something
 * else — a take, because the voice pipeline was cut; or a habit, because the
 * window it forces was written back to Settings. Both are asserted here on what
 * `startLiveSession` is actually handed, which is the object the rest of the
 * app reads.
 */
describe('starting a practice', () => {
  const openedBy = (): {
    presentationMode: string;
    practice?: boolean;
    mode: string;
    micDeviceId?: string;
    transcription?: { model: string; language: string };
  } => calls.startLiveSession.mock.calls[0]![0];

  it('opens in a window whatever the saved mode says', async () => {
    /*
     * Forced, not resolved. Rehearsing at a desk is what a practice IS, so the
     * operator who presents to glass every day still practises in a window.
     */
    settingsState.value!.stage.presentationMode = 'prompter';
    await expect(startTake(SCRIPT.id, { practice: true })).resolves.toBe(true);
    expect(openedBy().presentationMode).toBe('reader');
    expect(calls.enterPresentation).toHaveBeenCalledWith('reader', null, null);
  });

  it('never writes the forced window back to Settings', async () => {
    /*
     * The defect this guards is silent and slow: somebody who rehearses before
     * every take would find their real takes had stopped filling the display,
     * with nothing that happened at the moment it changed.
     */
    settingsState.value!.stage.presentationMode = 'prompter';
    await expect(startTake(SCRIPT.id, { practice: true })).resolves.toBe(true);
    expect(calls.patchSettings).not.toHaveBeenCalled();
  });

  it('still follows the voice — that is the thing being practised', async () => {
    /*
     * The one property that must never be "optimised" away. A rehearsal with no
     * microphone and no recogniser rehearses nothing: reading aloud and being
     * followed is the skill, and the only way to find out whether the script
     * follows YOUR delivery is to deliver it.
     */
    settingsState.value!.audio.followSystemDefault = false;
    settingsState.value!.audio.preferredDeviceId = 'usb';
    settingsState.value!.audio.preferredDeviceLabel = 'USB microphone';

    await expect(startTake(SCRIPT.id, { practice: true })).resolves.toBe(true);
    const opened = openedBy();
    expect(opened.mode).toBe('voice');
    expect(opened.transcription).toEqual({
      model: settingsState.value!.speech.transcriptionModel,
      language: settingsState.value!.speech.language,
    });
    // The pinned microphone is resolved exactly as a take resolves it.
    expect(opened.micDeviceId).toBe('usb');
  });

  it('composes the stage for the window it forces, not for the saved mode', async () => {
    /*
     * THE SAME DEFECT THIS FILE ALREADY GUARDS ONE DOOR AGAINST, arriving by the
     * other one. See "composes the stage for the mode it is actually opening in"
     * above: choosing a window out of a prompter default used to compose the
     * stage from the pre-choice settings, so the reading window opened with
     * prompter optics and a mirrored script.
     *
     * That path is safe because `resolveLaunchSettings` bakes the explicit
     * choice into the settings it returns. A practice deliberately does NOT go
     * through the resolver — that is the whole mechanism by which it avoids
     * writing the default — so the settings it composes from still say
     * `prompter`, and the fix had to be made again for it.
     *
     * This is the operator the feature was written for: somebody who presents
     * to glass every day and rehearses at their desk. It is the DEFAULT case
     * for them, not an edge one.
     */
    settingsState.value!.stage.presentationMode = 'prompter';
    presentOnMirroredGlass();

    await expect(startTake(SCRIPT.id, { practice: true })).resolves.toBe(true);

    const opened = calls.startLiveSession.mock.calls[0]![0] as {
      presentationMode: string;
      stageSettings: { readingContext?: string; mirrorX: boolean };
      stageEnvelope: { stageSettings: { readingContext?: string; mirrorX: boolean } };
    };
    expect(opened.presentationMode).toBe('reader');
    expect(opened.stageSettings.readingContext).toBe('reader');
    // Nothing in a desk window's optical path for a mirror to undo.
    expect(opened.stageSettings.mirrorX).toBe(false);
    // The envelope is what reaches the renderer; it must not disagree.
    expect(opened.stageEnvelope.stageSettings.readingContext).toBe('reader');
    expect(opened.stageEnvelope.stageSettings.mirrorX).toBe(false);
  });

  it('tells the session it is a rehearsal', async () => {
    await expect(startTake(SCRIPT.id, { practice: true })).resolves.toBe(true);
    expect(openedBy().practice).toBe(true);
  });

  it('leaves an ordinary take with no practice flag at all', async () => {
    /*
     * Absent rather than false, because the flag is the only thing that makes a
     * take a rehearsal and an explicit `false` on every take invites a reader to
     * think there is a third state.
     */
    await expect(startTake(SCRIPT.id, {})).resolves.toBe(true);
    expect(openedBy().practice).toBeUndefined();
  });

  it('writes an ordinary session row, in the ordinary place', async () => {
    /*
     * A rehearsal is a real reading and its ending is a real place in the
     * script — "From last ending" is offered on it. Nothing about the row says
     * practice, which is also why the feature needs no migration.
     */
    await expect(startTake(SCRIPT.id, { practice: true })).resolves.toBe(true);
    expect(calls.startSessionRecord).toHaveBeenCalledWith(
      expect.objectContaining({ scriptId: SCRIPT.id, mode: 'voice' }),
    );
  });

  it('starts from a chosen place like any other take', async () => {
    await expect(startTake(SCRIPT.id, { practice: true, startTokenIndex: 4 })).resolves.toBe(true);
    expect(calls.startSessionRecord).toHaveBeenCalledWith(
      expect.objectContaining({ startTokenIndex: expect.any(Number) }),
    );
  });
});


/**
 * Recording ONE PART of a script (§parts).
 *
 * The unit tests for the division itself live in `src/shared/markdown/parts.test.ts`
 * and the store's completion latch in `take-part-bounds.test.ts`. What is
 * asserted here is the WIRING, and specifically the one thing only this seam can
 * get wrong: a part is chosen from a menu drawn against whatever the editor had
 * compiled at the time, and the take runs against a compile taken fresh at
 * launch. Those two documents can differ — somebody edits, then presents — so
 * the part has to be re-measured here or the take is bounded to a span that
 * moved.
 */
describe('recording one part of a script', () => {
  const PARTS = [
    { id: 'p1', label: 'Welcome', ordinal: 1, startTokenIndex: 0, endTokenIndex: 19, origin: 'marker' as const },
    { id: 'p2', label: 'Pricing', ordinal: 2, startTokenIndex: 20, endTokenIndex: 29, origin: 'marker' as const },
    { id: 'p3', label: 'Close', ordinal: 3, startTokenIndex: 30, endTokenIndex: 39, origin: 'marker' as const },
  ];

  /** The same three-sentence script, divided into three parts. */
  function divided(parts = PARTS) {
    const base = compiled();
    const sentences = [
      { id: 's1', blockId: 'b1', startTokenIndex: 0, endTokenIndex: 19, normalizedText: 'welcome to the update' },
      { id: 's2', blockId: 'b2', startTokenIndex: 20, endTokenIndex: 29, normalizedText: 'our pricing changed' },
      { id: 's3', blockId: 'b3', startTokenIndex: 30, endTokenIndex: 39, normalizedText: 'the standard plan is thirty' },
    ];
    return {
      ...base,
      sentences: sentences as never,
      parts: parts as never,
      spokenWordCount: 40,
      script: {
        ...(base.script as unknown as Record<string, unknown>),
        sentences,
        parts,
      } as never,
    };
  }

  function opened(): { startTokenIndex: number; part: unknown; nextPart: unknown } {
    return calls.startLiveSession.mock.calls[0]![0] as never;
  }

  beforeEach(() => {
    calls.compileScript.mockResolvedValue(divided());
  });

  it('bounds the take to the chosen part, with the part after it', async () => {
    await expect(
      startTake(SCRIPT.id, { startTokenIndex: 20, part: { id: 'p2' } }),
    ).resolves.toBe(true);
    expect(opened().part).toEqual({
      id: 'p2',
      label: 'Pricing',
      ordinal: 2,
      totalParts: 3,
      startTokenIndex: 20,
      endTokenIndex: 29,
    });
    expect(opened().nextPart).toMatchObject({ id: 'p3', ordinal: 3 });
  });

  it('offers no next part for the last one', async () => {
    await expect(
      startTake(SCRIPT.id, { startTokenIndex: 30, part: { id: 'p3' } }),
    ).resolves.toBe(true);
    expect(opened().nextPart).toBeNull();
  });

  it('re-measures the part against the compile the take runs on', async () => {
    /*
     * The script grew before the row was chosen: "Pricing" now begins at 30,
     * not at 20. The caller's token index is the stale one, and following it
     * would open the take inside part one while reporting on part two.
     */
    calls.compileScript.mockResolvedValue(
      divided([
        { ...PARTS[0]!, endTokenIndex: 29 },
        { ...PARTS[1]!, startTokenIndex: 30, endTokenIndex: 39 },
      ]),
    );
    await expect(
      startTake(SCRIPT.id, { startTokenIndex: 20, part: { id: 'p2' } }),
    ).resolves.toBe(true);
    expect(opened().startTokenIndex).toBe(30);
    expect(opened().part).toMatchObject({ startTokenIndex: 30, endTokenIndex: 39 });
  });

  it('records the part start on the session row and the glass together', async () => {
    await expect(
      startTake(SCRIPT.id, { startTokenIndex: 20, part: { id: 'p2' } }),
    ).resolves.toBe(true);
    expect(calls.startSessionRecord).toHaveBeenCalledWith(
      expect.objectContaining({ startTokenIndex: 20 }),
    );
    expect(opened().startTokenIndex).toBe(20);
  });

  it('runs unbounded when the chosen part no longer exists', async () => {
    await expect(
      startTake(SCRIPT.id, { startTokenIndex: 20, part: { id: 'deleted' } }),
    ).resolves.toBe(true);
    expect(opened().part).toBeNull();
    expect(opened().nextPart).toBeNull();
    // The caller's own start point still stands — it is all that is left.
    expect(opened().startTokenIndex).toBe(20);
  });

  it('leaves an ordinary take unbounded', async () => {
    await expect(startTake(SCRIPT.id, {})).resolves.toBe(true);
    expect(opened().part).toBeNull();
    expect(opened().nextPart).toBeNull();
  });

  /*
   * "From here" on a divided script: the caret's token AND the caret's part.
   *
   * Every part in `divided()` is a single sentence, so a caret anywhere inside
   * one snaps back to where the part begins and cannot tell the caret from the
   * part's start — which is how the part's start came to overrule the caret
   * unnoticed. These parts have sentences inside them.
   */
  describe('from a token inside the part', () => {
    const SECTIONS = [
      { id: 'p1', label: 'Setup', ordinal: 1, startTokenIndex: 0, endTokenIndex: 19, origin: 'heading' as const },
      { id: 'p2', label: 'Demo', ordinal: 2, startTokenIndex: 20, endTokenIndex: 49, origin: 'heading' as const },
      { id: 'p3', label: 'Close', ordinal: 3, startTokenIndex: 50, endTokenIndex: 59, origin: 'heading' as const },
    ];

    const SENTENCES = [
      { id: 's1', blockId: 'b1', startTokenIndex: 0, endTokenIndex: 19, normalizedText: 'here is the setup' },
      { id: 's2', blockId: 'b2', startTokenIndex: 20, endTokenIndex: 29, normalizedText: 'open the demo project' },
      { id: 's3', blockId: 'b3', startTokenIndex: 30, endTokenIndex: 39, normalizedText: 'press the run button' },
      { id: 's4', blockId: 'b4', startTokenIndex: 40, endTokenIndex: 49, normalizedText: 'watch the output appear' },
      { id: 's5', blockId: 'b5', startTokenIndex: 50, endTokenIndex: 59, normalizedText: 'that is all for today' },
    ];

    function sectioned(parts: readonly unknown[] = SECTIONS, sentences: readonly unknown[] = SENTENCES) {
      const base = compiled();
      return {
        ...base,
        sentences: sentences as never,
        parts: parts as never,
        spokenWordCount: 60,
        script: {
          ...(base.script as unknown as Record<string, unknown>),
          sentences,
          parts,
        } as never,
      };
    }

    function glass(): number {
      const input = calls.startLiveSession.mock.calls[0]![0] as {
        stageEnvelope: { initialTokenIndex: number };
      };
      return input.stageEnvelope.initialTokenIndex;
    }

    beforeEach(() => {
      calls.compileScript.mockResolvedValue(sectioned());
    });

    it('opens at the caret’s sentence and still records the caret’s part', async () => {
      await expect(
        startTake(SCRIPT.id, { startTokenIndex: 40, part: { id: 'p2' } }),
      ).resolves.toBe(true);
      // The session row, the live session and the glass all agree.
      expect(calls.startSessionRecord).toHaveBeenCalledWith(
        expect.objectContaining({ startTokenIndex: 40 }),
      );
      expect(opened().startTokenIndex).toBe(40);
      expect(glass()).toBe(40);
      // Begun part way, but a take of part two all the same.
      expect(opened().part).toEqual({
        id: 'p2',
        label: 'Demo',
        ordinal: 2,
        totalParts: 3,
        startTokenIndex: 20,
        endTokenIndex: 49,
      });
      expect(opened().nextPart).toMatchObject({ id: 'p3', ordinal: 3 });
    });

    it('snaps a caret part way through a sentence to that sentence, not to the part', async () => {
      await expect(
        startTake(SCRIPT.id, { startTokenIndex: 44, part: { id: 'p2' } }),
      ).resolves.toBe(true);
      expect(opened().startTokenIndex).toBe(40);
      expect(glass()).toBe(40);
    });

    it('counts the part’s last token as inside it', async () => {
      // `endTokenIndex` is inclusive (`parts.ts`).
      await expect(
        startTake(SCRIPT.id, { startTokenIndex: 49, part: { id: 'p2' } }),
      ).resolves.toBe(true);
      expect(opened().startTokenIndex).toBe(40);
    });

    it('opens a part at its start when no token comes with it', async () => {
      await expect(startTake(SCRIPT.id, { part: { id: 'p2' } })).resolves.toBe(true);
      expect(calls.startSessionRecord).toHaveBeenCalledWith(
        expect.objectContaining({ startTokenIndex: 20 }),
      );
      expect(opened().startTokenIndex).toBe(20);
      expect(glass()).toBe(20);
    });

    it('opens a WHOLE part at its re-measured start even where its old start now falls inside it', async () => {
      /*
       * The part row was drawn when "Demo" began at 40; an edit above it has
       * since moved it to 20..49. The stale 40 is inside the new span, so it is
       * indistinguishable from a caret by position — which is why a part row
       * says `whole` rather than relying on the token to mean "the start".
       */
      await expect(
        startTake(SCRIPT.id, { startTokenIndex: 40, part: { id: 'p2', whole: true } }),
      ).resolves.toBe(true);
      expect(calls.startSessionRecord).toHaveBeenCalledWith(
        expect.objectContaining({ startTokenIndex: 20 }),
      );
      expect(opened().startTokenIndex).toBe(20);
      expect(glass()).toBe(20);
      expect(opened().part).toMatchObject({ id: 'p2', startTokenIndex: 20, endTokenIndex: 49 });
    });

    it('opens a whole part that can no longer be found at the token that came with it', async () => {
      /*
       * A marker part's identity includes its source offset, so an edit
       * anywhere above the marker re-identifies it and the lookup misses. The
       * take runs unbounded, as it says — but from where the part was, not from
       * the top of the script.
       */
      await expect(
        startTake(SCRIPT.id, { startTokenIndex: 40, part: { id: 'renamed', whole: true } }),
      ).resolves.toBe(true);
      expect(opened().part).toBeNull();
      expect(opened().startTokenIndex).toBe(40);
      expect(glass()).toBe(40);
    });

    it('lets a practice keep its token and drop the part', async () => {
      // A practice is never bounded (§practice), so the part is not there to
      // confine the token — and it is not "missing" either, so nothing is said.
      await expect(
        startTake(SCRIPT.id, { practice: true, startTokenIndex: 55, part: { id: 'p2' } }),
      ).resolves.toBe(true);
      expect(opened().startTokenIndex).toBe(50);
      expect(glass()).toBe(50);
      expect(opened().part).toBeNull();
      expect(opened().nextPart).toBeNull();
      expect(calls.showToast).not.toHaveBeenCalled();
    });

    it.each([
      ['before it', 10],
      ['after it, in the next part', 55],
    ])(
      'falls back to the part’s start when the token is no longer inside it (%s)',
      async (_where, token) => {
        // An edit made with the menu open can move the caret's sentence out of
        // the part it was drawn in. The part is what was asked for, so the
        // take is still of the part — from its start, not from a token that
        // would have it begin somewhere it is not reporting on.
        await expect(
          startTake(SCRIPT.id, { startTokenIndex: token, part: { id: 'p2' } }),
        ).resolves.toBe(true);
        expect(opened().startTokenIndex).toBe(20);
        expect(opened().part).toMatchObject({ id: 'p2' });
      },
    );

    it('never opens before the part it reports on', async () => {
      /*
       * Defensive, not compiler output: a part always begins on a sentence, so
       * snapping a token inside one cannot leave it. This part starts in the
       * middle of a sentence to prove the invariant holds if that ever stops
       * being true.
       */
      calls.compileScript.mockResolvedValue(
        sectioned([
          { ...SECTIONS[0]!, endTokenIndex: 24 },
          { ...SECTIONS[1]!, startTokenIndex: 25 },
          SECTIONS[2]!,
        ]),
      );
      await expect(
        startTake(SCRIPT.id, { startTokenIndex: 27, part: { id: 'p2' } }),
      ).resolves.toBe(true);
      expect(opened().startTokenIndex).toBe(25);
      expect(glass()).toBe(25);
    });
  });
});
