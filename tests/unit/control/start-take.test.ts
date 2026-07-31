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
    diagnostics: [],
    spokenWordCount: 2,
    estimatedDurationSeconds: 2,
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
    transcriptRetained: false,
  });
  calls.endSessionRecord.mockResolvedValue(null);
  calls.navigate.mockResolvedValue(true);
  calls.enterPresentation.mockResolvedValue({ presenting: true, width: 1920, height: 1080 });
  calls.exitPresentation.mockResolvedValue({ presenting: false, width: 1240, height: 820 });
  calls.awaitViewportSettled.mockResolvedValue(undefined);
  calls.painted.mockResolvedValue(undefined);
  calls.patchSettings.mockResolvedValue(undefined);
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
    expect(calls.enterPresentation).toHaveBeenCalledWith('reader', null);
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
    settingsState.value!.teleprompter.mirrorX = true;

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
    settingsState.value!.teleprompter.mirrorX = true;

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
    expect(calls.enterPresentation).toHaveBeenCalledWith('reader', null);
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
    expect(calls.enterPresentation).toHaveBeenCalledWith('reader', null);
  });

  it('hands back a remembered reading window', async () => {
    const frame = { x: 40, y: 60, width: 720, height: 540 };
    settingsState.value!.stage.presentationMode = 'reader';
    settingsState.value!.stage.readerFrame = frame;
    settingsState.value!.general.restoreWindows = true;
    await expect(startTake(SCRIPT.id)).resolves.toBe(true);
    expect(calls.enterPresentation).toHaveBeenCalledWith('reader', frame);
  });

  it('leaves the window where it is when the operator asked us not to remember', async () => {
    settingsState.value!.stage.presentationMode = 'reader';
    settingsState.value!.stage.readerFrame = { x: 40, y: 60, width: 720, height: 540 };
    settingsState.value!.general.restoreWindows = false;
    await expect(startTake(SCRIPT.id)).resolves.toBe(true);
    expect(calls.enterPresentation).toHaveBeenCalledWith('reader', null);
  });

  it('never hands a stored frame to a prompter', async () => {
    // A prompter fills whichever monitor it is on. A stored rectangle would be
    // describing something else entirely.
    settingsState.value!.stage.presentationMode = 'prompter';
    settingsState.value!.stage.readerFrame = { x: 40, y: 60, width: 720, height: 540 };
    await expect(startTake(SCRIPT.id)).resolves.toBe(true);
    expect(calls.enterPresentation).toHaveBeenCalledWith('prompter', null);
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
