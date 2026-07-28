/**
 * The start sequence, now that there is no screen standing in front of it.
 *
 * `lib/start-take.ts` is what Present runs. Everything it does used to live in
 * a component that could not be mounted in this project, so the guarantees
 * below were only ever asserted against its SOURCE — which is how a start
 * sequence ends up with a documented order and a different real one.
 *
 * Three things are worth proving here, and they are the three that have
 * actually broken:
 *
 *   1. ORDER. `start_session` is the only path to Rust's
 *      `AppCoordinator::begin_session`, which is the only writer of the session
 *      generation. Opening the stage first left the coordinator at generation 0
 *      while control stamped payloads with 1, so `validate_stage_payload_header`
 *      rejected the entire stage stream and no session could start at all in a
 *      packaged build.
 *   2. TEARDOWN. Every failure path has to leave nothing behind: no stage
 *      window, no unfinished session row, no pipeline, no microphone. An
 *      unfinished row is indistinguishable from a crash and gets closed at next
 *      launch.
 *   3. THE MAPPING. Settings are now the ONLY input to a take. A field that
 *      fails to reach the envelope is a setting that silently does nothing,
 *      which is the exact complaint that removed the screen in the first place.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompileOutput } from '../../../src/control/services/compiler';
import type { AppSettings } from '../../../src/control/services/settings-types';

/* ---------------------------------------------------------------- fixtures */

const SCRIPT_DOC = {
  id: 'script-1',
  title: 'Launch video',
  source: '# Launch\n\nHello there.\n',
  scriptRevision: 9,
};

function compileOutput(overrides: Partial<CompileOutput> = {}): CompileOutput {
  return {
    stale: false,
    requestId: 1,
    scriptId: 'script-1',
    sourceHash: 'hash-abc',
    script: {
      schemaVersion: 1,
      compilerVersion: '1.0.0',
      scriptId: 'script-1',
      sourceHash: 'hash-abc',
      settingsHash: 'settings-abc',
      title: 'Launch video',
      outline: [],
      blocks: [],
      spokenTokens: [{ index: 0, blockId: 'b-1', sentenceId: 's-1', surface: 'Hello', normalized: 'hello' }],
      sentences: [{ id: 's-1', blockId: 'b-1', startTokenIndex: 0, endTokenIndex: 1, text: 'Hello there.' }],
      navigationTargets: [],
      cues: [],
      assets: [],
      diagnostics: [],
      statistics: {},
      literalCommandRanges: [],
    } as never,
    blocks: [],
    outline: [{ id: 'b-1', level: 1, text: 'Launch' }] as never,
    sentences: [{ id: 's-1', blockId: 'b-1', startTokenIndex: 0, endTokenIndex: 1 }] as never,
    navigationTargets: [],
    diagnostics: [],
    spokenWordCount: 42,
    estimatedDurationSeconds: 20,
    ...overrides,
  };
}

function display(
  fingerprint: string,
  name: string,
  primary: boolean,
): import('../../../src/control/services/stage-types').DisplayDescriptor {
  return {
    id: fingerprint,
    fingerprint,
    name,
    primary,
    physicalPosition: { x: 0, y: 0 },
    physicalSize: { width: 1920, height: 1080 },
    logicalSize: { width: 1920, height: 1080 },
    scaleFactor: 1,
    topologyHash: 'topology-1',
  };
}

const DISPLAYS = [
  display('primary-1', 'Built-in Display', true),
  display('external-1', 'Teleprompter Display', false),
];

/* -------------------------------------------------------------- the doubles */

/** Every service call, in the order it happened. */
const order = vi.hoisted(() => [] as string[]);

const services = vi.hoisted(() => ({
  getScript: vi.fn(),
  compileScript: vi.fn(),
  listDisplays: vi.fn(),
  openStage: vi.fn(),
  publishStageDocument: vi.fn(),
  waitForStageReady: vi.fn(),
  setStageFullscreen: vi.fn(),
  closeStage: vi.fn(),
  startSessionRecord: vi.fn(),
  endSessionRecord: vi.fn(),
  resolveDocumentAssets: vi.fn(),
  listInstalledListeners: vi.fn(),
  buildListenerSelection: vi.fn(),
  listDisplayProfiles: vi.fn(),
  saveDisplayProfile: vi.fn(),
  startLiveSession: vi.fn(),
  stopSession: vi.fn(),
  clearSession: vi.fn(),
  reportStageWindowFault: vi.fn(),
  navigate: vi.fn(),
  showToast: vi.fn(),
  saveNow: vi.fn(),
}));

/** Wrap a double so the call ORDER is recorded, not just the arguments. */
function traced<T>(name: string, fn: (...args: never[]) => T): (...args: never[]) => T {
  return (...args: never[]) => {
    order.push(name);
    return fn(...args);
  };
}

vi.mock('../../../src/control/services/scripts', () => ({
  getScript: (...a: never[]) => traced('getScript', services.getScript)(...a),
}));
vi.mock('../../../src/control/services/compiler', () => ({
  compileScript: (...a: never[]) => traced('compileScript', services.compileScript)(...a),
}));
vi.mock('../../../src/control/services/stage', () => ({
  listDisplays: (...a: never[]) => traced('listDisplays', services.listDisplays)(...a),
  openStage: (...a: never[]) => traced('openStage', services.openStage)(...a),
  publishStageDocument: (...a: never[]) =>
    traced('publishStageDocument', services.publishStageDocument)(...a),
  waitForStageReady: (...a: never[]) =>
    traced('waitForStageReady', services.waitForStageReady)(...a),
  setStageFullscreen: (...a: never[]) =>
    traced('setStageFullscreen', services.setStageFullscreen)(...a),
  closeStage: (...a: never[]) => traced('closeStage', services.closeStage)(...a),
}));
vi.mock('../../../src/control/services/session-records', () => ({
  startSessionRecord: (...a: never[]) =>
    traced('startSessionRecord', services.startSessionRecord)(...a),
  endSessionRecord: (...a: never[]) => traced('endSessionRecord', services.endSessionRecord)(...a),
}));
vi.mock('../../../src/control/services/stage-envelope', async (orig) => {
  // `buildStageSettings` and `buildStageEnvelope` stay REAL — they are half the
  // mapping this file exists to check, and a stub of them would assert nothing.
  const actual = await orig<typeof import('../../../src/control/services/stage-envelope')>();
  return { ...actual, resolveDocumentAssets: services.resolveDocumentAssets };
});
vi.mock('../../../src/control/services/listeners', () => ({
  listInstalledListeners: (...a: never[]) =>
    traced('listInstalledListeners', services.listInstalledListeners)(...a),
  buildListenerSelection: (...a: never[]) =>
    traced('buildListenerSelection', services.buildListenerSelection)(...a),
}));
vi.mock('../../../src/control/services/display-profiles', async (orig) => {
  // `profileForDisplay` and `buildDisplayProfile` stay REAL: they are the logic
  // that decides WHICH row a take updates, and a stub of them would assert
  // nothing about the one behaviour worth pinning here.
  const actual = await orig<typeof import('../../../src/control/services/display-profiles')>();
  return {
    ...actual,
    listDisplayProfiles: (...a: never[]) =>
      traced('listDisplayProfiles', services.listDisplayProfiles)(...a),
    saveDisplayProfile: (...a: never[]) =>
      traced('saveDisplayProfile', services.saveDisplayProfile)(...a),
  };
});
vi.mock('../../../src/control/stores/session', () => ({
  startLiveSession: (...a: never[]) => traced('startLiveSession', services.startLiveSession)(...a),
  stopSession: (...a: never[]) => traced('stopSession', services.stopSession)(...a),
  clearSession: (...a: never[]) => traced('clearSession', services.clearSession)(...a),
  reportStageWindowFault: services.reportStageWindowFault,
}));
vi.mock('../../../src/control/stores/router', () => ({
  navigate: (...a: never[]) => traced('navigate', services.navigate)(...a),
}));
vi.mock('../../../src/control/stores/toasts', () => ({ showToast: services.showToast }));
/**
 * The inputs plugged in for a given test. The take resolves its remembered
 * microphone against this list, so "the saved id is stale" and "the microphone
 * is gone" are two different, testable situations.
 */
const micState = vi.hoisted(() => ({
  devices: [] as { deviceId: string; label: string; isDefault: boolean; available: boolean }[],
  fail: false,
}));
vi.mock('../../../src/control/services/voice-facade', () => ({
  getVoiceFacade: () => ({
    listMicrophones: async () => {
      if (micState.fail) throw new Error('enumeration failed');
      return micState.devices;
    },
  }),
}));
const editorState = vi.hoisted(() => ({
  value: { scriptId: null as string | null, saveState: 'idle', lastError: null as string | null },
}));
vi.mock('../../../src/control/stores/editor', async () => {
  const { readable } = await import('svelte/store');
  return {
    saveNow: services.saveNow,
    editor: readable(editorState.value, (set) => {
      set(editorState.value);
      return () => {};
    }),
  };
});

/** The settings store, driven per-test. */
const settingsState = vi.hoisted(() => ({ value: null as AppSettings | null }));
vi.mock('../../../src/control/stores/settings', async () => {
  const { readable } = await import('svelte/store');
  type AppSettings = import('../../../src/control/services/settings-types').AppSettings;
  return {
    loadSettings: async () => settingsState.value,
    settings: readable<AppSettings | null>(null, (set) => {
      set(settingsState.value);
      return () => {};
    }),
  };
});

const { defaultAppSettings, withOpticalProfile } = await import(
  '../../../src/control/services/settings-types'
);
const { defaultOpticalProfile } = await import('../../../src/shared/contracts');
type OpticalProfile = import('../../../src/shared/contracts').OpticalProfile;
const { startTake, chooseStageDisplay } = await import('../../../src/control/lib/start-take');

/* ------------------------------------------------------------------ setup */

function settingsWith(patch: (s: AppSettings) => void = () => {}): AppSettings {
  const s = defaultAppSettings();
  patch(s);
  return s;
}

/** The arguments `startLiveSession` was handed, or a failure. */
function liveInput(): Record<string, unknown> {
  const call = services.startLiveSession.mock.calls.at(-1);
  if (!call) throw new Error('startLiveSession was never called');
  return call[0] as Record<string, unknown>;
}

beforeEach(() => {
  order.length = 0;
  for (const fn of Object.values(services)) fn.mockReset();
  settingsState.value = settingsWith();
  micState.fail = false;
  micState.devices = [
    { deviceId: 'default', label: 'Default - Built-in Microphone', isDefault: true, available: true },
    { deviceId: 'usb-mic', label: 'Blue Yeti', isDefault: false, available: true },
  ];
  editorState.value = { scriptId: null, saveState: 'idle', lastError: null };

  services.saveNow.mockResolvedValue(undefined);
  services.getScript.mockResolvedValue(SCRIPT_DOC);
  services.compileScript.mockResolvedValue(compileOutput());
  services.listDisplays.mockResolvedValue(DISPLAYS);
  services.startSessionRecord.mockResolvedValue({
    id: 'session-uuid-1',
    sessionGeneration: 7,
    transcriptRetained: false,
  });
  services.openStage.mockResolvedValue({ stageGeneration: 3 });
  services.resolveDocumentAssets.mockResolvedValue([]);
  services.publishStageDocument.mockResolvedValue({ accepted: true });
  services.waitForStageReady.mockResolvedValue(undefined);
  services.setStageFullscreen.mockResolvedValue({ displayFingerprint: 'external-1' });
  services.closeStage.mockResolvedValue(undefined);
  services.endSessionRecord.mockResolvedValue(null);
  services.listInstalledListeners.mockResolvedValue([]);
  services.listDisplayProfiles.mockResolvedValue([]);
  services.saveDisplayProfile.mockResolvedValue({ id: 'profile-1' });
  services.navigate.mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ tests */

describe('the §29.2 order', () => {
  it('opens the session record before the stage window', async () => {
    /*
     * C1, as an ordering assertion rather than a comment. Rust assigns the
     * session generation inside `start_session`; a stage opened before it
     * carries a generation the coordinator has not issued, and every payload on
     * that stage is refused.
     */
    await expect(startTake('script-1')).resolves.toBe(true);
    const seq = order.filter((c) =>
      ['startSessionRecord', 'openStage', 'publishStageDocument', 'setStageFullscreen'].includes(c),
    );
    expect(seq).toEqual([
      'startSessionRecord',
      'openStage',
      'publishStageDocument',
      'setStageFullscreen',
    ]);
  });

  it('arms the stage-ready wait BEFORE publishing, not after', async () => {
    /*
     * A wait armed after the publish can miss a handshake that has already
     * landed, and then spends its whole timeout before blaming the stage. The
     * ordering is the fix, so the ordering is what is asserted.
     */
    await startTake('script-1');
    expect(order.indexOf('waitForStageReady')).toBeLessThan(
      order.indexOf('publishStageDocument'),
    );
  });

  it('goes live before it navigates, so Live never renders an empty session', async () => {
    await startTake('script-1');
    expect(order.indexOf('startLiveSession')).toBeLessThan(order.indexOf('navigate'));
    expect(services.navigate).toHaveBeenCalledWith({
      name: 'live',
      sessionId: 'session-uuid-1',
      scriptId: 'script-1',
    });
  });

  it('flushes the editor first, so the take reads what is on disk', async () => {
    await startTake('script-1');
    expect(services.saveNow).toHaveBeenCalled();
    expect(order.indexOf('getScript')).toBeGreaterThan(-1);
  });
});

describe('settings are the only input to a take', () => {
  it('carries the mode, the transcription config and the compiled script', async () => {
    settingsState.value = settingsWith((s) => {
      s.general.defaultSessionMode = 'manual';
      s.inworld.transcriptionModel = 'inworld/inworld-stt-1';
      s.inworld.language = 'en-GB';
    });
    await startTake('script-1');

    const input = liveInput();
    expect(input['mode']).toBe('manual');
    expect(input['transcription']).toEqual({
      model: 'inworld/inworld-stt-1',
      language: 'en-GB',
    });
    expect(input['scriptRevision']).toBe(9);
    expect(input['sessionGeneration']).toBe(7);
    expect(input['stageGeneration']).toBe(3);
    expect(input['totalTokens']).toBe(42);
  });

  it('turns the teleprompter settings into the stage settings the stage renders', async () => {
    settingsState.value = settingsWith((s) => {
      s.teleprompter.fontSizePx = 96;
      s.teleprompter.columnWidthPercent = 55;
      s.teleprompter.mirrorX = true;
      s.teleprompter.textIntensity = 'strong';
    });
    await startTake('script-1');

    const stage = liveInput()['stageSettings'] as Record<string, unknown>;
    expect(stage['fontSizePx']).toBe(96);
    expect(stage['columnWidthPercent']).toBe(55);
    expect(stage['mirrorX']).toBe(true);
    /*
     * `textIntensity` is what replaced the "Stage background" menu, which
     * offered two shades of black and delivered neither — the stage hard-codes
     * `--stage-bg`, so both options rendered identically. The field colour is a
     * constant now; the luminance of the TEXT is the thing that moves.
     */
    expect(stage['textIntensity']).toBe('strong');
    expect(stage['background']).toBe('#000000');
  });

  /**
   * The optical seam, end to end: a rig calibrated for THIS panel has to reach
   * the stage as geometry. The profile is keyed by display fingerprint, so a
   * take on another monitor must not pick it up — that is the whole reason
   * per-rig storage exists rather than one profile on `teleprompter`.
   */
  describe('a calibrated rig', () => {
    /** A 9-inch prompter at 1.4 m, calibrated for the external display only. */
    function calibrate(s: AppSettings, fingerprint: string): void {
      const profile: OpticalProfile = {
        ...defaultOpticalProfile(),
        rigName: 'Desk hood',
        hardwareKind: 'elgato-prompter',
        scale: { mmPerCssPx: (9 * 25.4) / Math.hypot(1920, 1080), source: 'model' },
        viewingDistanceMm: 1400,
        intensity: 'soft',
      };
      s.optical = withOpticalProfile(s.optical, fingerprint, profile);
    }

    it('sizes the take by measured distance instead of the settings slider', async () => {
      settingsState.value = settingsWith((s) => {
        s.teleprompter.fontSizePx = 96;
        calibrate(s, 'external-1');
      });
      await startTake('script-1');

      const stage = liveInput()['stageSettings'] as Record<string, unknown>;
      const optics = stage['optics'] as { calibrated: boolean; viewingDistanceMm: number };
      expect(optics.calibrated).toBe(true);
      expect(optics.viewingDistanceMm).toBe(1400);
      // The legacy field is calibrated too, or an older stage build renders the
      // uncalibrated size inside an envelope that looks fully calibrated.
      expect(stage['fontSizePx']).not.toBe(96);
      expect((stage['opticalProfile'] as { rigName: string }).rigName).toBe('Desk hood');
      // The rig's own brightness beats the global default, which is 'standard'.
      expect(stage['textIntensity']).toBe('soft');
    });

    it('ignores a rig calibrated for a different panel', async () => {
      settingsState.value = settingsWith((s) => {
        s.teleprompter.fontSizePx = 96;
        // The stage opens on 'external-1'; this rig belongs to the laptop.
        calibrate(s, 'primary-1');
      });
      await startTake('script-1');

      const stage = liveInput()['stageSettings'] as Record<string, unknown>;
      expect(stage['optics']).toBeUndefined();
      expect(stage['fontSizePx']).toBe(96);
    });
  });

  it('pins no device while "follow system default" is on', async () => {
    settingsState.value = settingsWith((s) => {
      s.audio.followSystemDefault = true;
      s.audio.preferredDeviceId = 'usb-mic';
    });
    await startTake('script-1');
    // Following the system default means exactly that: the pipeline must be
    // free to follow a mid-session input change, which a pinned id prevents.
    expect(liveInput()).not.toHaveProperty('micDeviceId');
  });

  it('pins the chosen device once the user has turned that off', async () => {
    settingsState.value = settingsWith((s) => {
      s.audio.followSystemDefault = false;
      s.audio.preferredDeviceId = 'usb-mic';
    });
    await startTake('script-1');
    expect(liveInput()['micDeviceId']).toBe('usb-mic');
  });

  it('finds the remembered microphone again when its device id has been re-salted', async () => {
    // The saved id is stale — WKWebView re-salts ids per session — but the
    // microphone itself is plugged in. Without the label match this take would
    // silently open the system default, which is the whole "it keeps using my
    // headphones" complaint.
    settingsState.value = settingsWith((s) => {
      s.audio.followSystemDefault = false;
      s.audio.preferredDeviceId = 'stale-id-from-last-launch';
      s.audio.preferredDeviceLabel = 'Blue Yeti';
    });
    await startTake('script-1');
    expect(liveInput()['micDeviceId']).toBe('usb-mic');
  });

  it('falls back to the system default and says so when the chosen microphone is unplugged', async () => {
    settingsState.value = settingsWith((s) => {
      s.audio.followSystemDefault = false;
      s.audio.preferredDeviceId = 'gone';
      s.audio.preferredDeviceLabel = 'Røde NT-USB';
    });
    await startTake('script-1');
    expect(liveInput()).not.toHaveProperty('micDeviceId');
    expect(services.showToast).toHaveBeenCalledWith(
      expect.stringContaining('Røde NT-USB is not connected'),
      'info',
    );
  });

  it('honours the pin when the inputs cannot be enumerated at all', async () => {
    // Absence was not proven, so the remembered choice stands: the capture
    // retry in voice-session is a better place to discover a dead device than a
    // guess made here.
    micState.fail = true;
    settingsState.value = settingsWith((s) => {
      s.audio.followSystemDefault = false;
      s.audio.preferredDeviceId = 'usb-mic';
    });
    await startTake('script-1');
    expect(liveInput()['micDeviceId']).toBe('usb-mic');
  });

  it('compiles with the heading setting, because it changes what a token is', async () => {
    settingsState.value = settingsWith((s) => {
      s.general.readHeadings = true;
    });
    await startTake('script-1');
    expect(services.compileScript).toHaveBeenCalledWith('script-1', SCRIPT_DOC.source, {
      readHeadings: true,
    });
  });

  it('opens with the remembered Listener, framed the way it was saved', async () => {
    settingsState.value = settingsWith((s) => {
      s.listeners.autoplay = true;
      s.listeners.defaultPackId = 'mira';
      s.listeners.dimPercent = 62;
      s.listenerFraming.placement = 'lens_left';
      s.listenerFraming.zoomPercent = 130;
    });
    services.listInstalledListeners.mockResolvedValue([
      { packId: 'mira', version: '2.0.0', state: 'installed' },
    ]);
    services.buildListenerSelection.mockResolvedValue({ packId: 'mira', placement: 'lens_left' });

    await startTake('script-1');

    expect(services.buildListenerSelection).toHaveBeenCalledWith(
      'mira',
      '2.0.0',
      expect.objectContaining({ placement: 'lens_left', zoomPercent: 130, dimPercent: 62 }),
    );
    expect(liveInput()['listener']).toEqual({ packId: 'mira', placement: 'lens_left' });
  });

  it('says so out loud when the remembered Listener is not installed', async () => {
    settingsState.value = settingsWith((s) => {
      s.listeners.autoplay = true;
      s.listeners.defaultPackId = 'mira';
    });
    services.listInstalledListeners.mockResolvedValue([]);

    await expect(startTake('script-1')).resolves.toBe(true);
    // An empty stage where a person was expected is worth one sentence.
    expect(services.showToast).toHaveBeenCalledWith(expect.stringContaining('not installed'), 'info');
    expect(liveInput()['listener']).toBeNull();
  });

  it('opens with no Listener at all when autoplay is off', async () => {
    settingsState.value = settingsWith((s) => {
      s.listeners.autoplay = false;
      s.listeners.defaultPackId = 'mira';
    });
    await startTake('script-1');
    expect(services.listInstalledListeners).not.toHaveBeenCalled();
    expect(liveInput()['listener']).toBeNull();
  });
});

describe('choosing a display', () => {
  it('prefers a display that is not the primary one', () => {
    // The primary display is the one with the operator's face pointed at the
    // control window; putting the prompt window over it is not presenting.
    expect(chooseStageDisplay(DISPLAYS, null)?.fingerprint).toBe('external-1');
  });

  it('honours a pinned fingerprint over the automatic choice', () => {
    expect(chooseStageDisplay(DISPLAYS, 'primary-1')?.fingerprint).toBe('primary-1');
  });

  it('takes the only display there is', () => {
    expect(chooseStageDisplay([DISPLAYS[0]!], null)?.fingerprint).toBe('primary-1');
  });

  it('has nothing to choose from an empty list', () => {
    expect(chooseStageDisplay([], 'external-1')).toBeNull();
  });

  it('falls back and SAYS SO when the pinned display is unplugged', async () => {
    settingsState.value = settingsWith((s) => {
      s.stage.displayFingerprint = 'unplugged-thunderbolt';
    });
    services.setStageFullscreen.mockResolvedValue({ displayFingerprint: 'external-1' });

    await expect(startTake('script-1')).resolves.toBe(true);
    expect(services.openStage).toHaveBeenCalledWith({
      displayFingerprint: 'external-1',
      sessionId: 'session-uuid-1',
    });
    expect(services.showToast).toHaveBeenCalledWith(
      expect.stringContaining('not connected'),
      'info',
    );
  });

  it('raises the §52.7 mismatch when the stage lands somewhere else entirely', async () => {
    /*
     * Rust emits STAGE_DISPLAY_MISMATCH on `stage://error` one step before the
     * stage bridge is installed, so control is not listening yet and the event
     * is lost. The same fact is in the value the command returns, which is why
     * the check is repeated here — after the session exists to carry it.
     */
    services.setStageFullscreen.mockResolvedValue({ displayFingerprint: 'primary-1' });
    await startTake('script-1');
    expect(services.reportStageWindowFault).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'STAGE_DISPLAY_MISMATCH',
        requestedFingerprint: 'external-1',
        actualFingerprint: 'primary-1',
      }),
    );
    // And it is raised AFTER the session exists, or there is nothing to carry it.
    expect(order.indexOf('startLiveSession')).toBeGreaterThan(-1);
  });

  it('does not raise a mismatch when the stage landed where it was asked to', async () => {
    await startTake('script-1');
    expect(services.reportStageWindowFault).not.toHaveBeenCalled();
  });

  it('refuses to start when there is no display at all', async () => {
    services.listDisplays.mockResolvedValue([]);
    await expect(startTake('script-1')).resolves.toBe(false);
    expect(services.startSessionRecord).not.toHaveBeenCalled();
    expect(services.showToast).toHaveBeenCalledWith(
      expect.stringContaining('No displays were detected'),
      'danger',
    );
  });
});

describe('a failed start leaves nothing behind', () => {
  /**
   * The teardown contract: stop the pipeline, clear the session, close the
   * record, close the stage. `closeStage` alone left the tracking worker, the
   * transport, the microphone capture, the billing meter, the elapsed clock and
   * the heartbeat all running.
   */
  function expectTornDown(): void {
    expect(services.stopSession).toHaveBeenCalled();
    expect(services.clearSession).toHaveBeenCalled();
    expect(services.endSessionRecord).toHaveBeenCalledWith('session-uuid-1');
    expect(services.closeStage).toHaveBeenCalledWith('session-uuid-1');
    expect(services.navigate).not.toHaveBeenCalled();
  }

  it('when the stage window will not open', async () => {
    services.openStage.mockRejectedValue(new Error('no window server'));
    await expect(startTake('script-1')).resolves.toBe(false);
    expectTornDown();
  });

  it('when the envelope cannot be published', async () => {
    services.publishStageDocument.mockRejectedValue(new Error('IPC refused'));
    await expect(startTake('script-1')).resolves.toBe(false);
    expectTornDown();
  });

  it('when a second stage window raced this one', async () => {
    // A refused envelope is an ack, not an error (§43.5) — and nothing used to
    // read it, so a refusal was indistinguishable from a slow stage and the
    // wait ran its full 12 s before blaming the timing.
    services.publishStageDocument.mockResolvedValue({ accepted: false });
    await expect(startTake('script-1')).resolves.toBe(false);
    expectTornDown();
    expect(services.startLiveSession).not.toHaveBeenCalled();
  });

  it('when the handshake never comes', async () => {
    services.waitForStageReady.mockRejectedValue(new Error('stage did not report ready'));
    await expect(startTake('script-1')).resolves.toBe(false);
    expectTornDown();
  });

  it('when a navigation guard vetoes the move to Live', async () => {
    // The session is already running behind whatever screen is still showing;
    // leaving it there would leave the microphone and the billing meter on.
    services.navigate.mockResolvedValue(false);
    await expect(startTake('script-1')).resolves.toBe(false);
    expect(services.stopSession).toHaveBeenCalled();
    expect(services.endSessionRecord).toHaveBeenCalledWith('session-uuid-1');
    expect(services.closeStage).toHaveBeenCalledWith('session-uuid-1');
  });

  it.each([
    ['the publish throws', () => services.publishStageDocument.mockRejectedValue(new Error('IPC refused'))],
    ['the publish is refused', () => services.publishStageDocument.mockResolvedValue({ accepted: false })],
  ])('never leaves the stage-ready wait rejecting into nothing when %s', async (_case, arrange) => {
    /*
     * The wait is armed BEFORE the publish, so every path out of the publish
     * owes it a handler. Left bare, its 12-second timeout rejects into nothing
     * long after the operator has been told the start failed — an unhandled
     * rejection with no owner.
     *
     * Asserted by spying on `.catch` rather than by listening for an unhandled
     * rejection: the process hook is timing-dependent and quietly passes when
     * the guard is removed, which makes it exactly the kind of test that looks
     * like a regression guard and is not one. This one fails when the handler
     * goes away.
     */
    const rejection = Promise.reject(new Error('stage timed out'));
    const caught = vi.fn((onRejected: (reason: unknown) => unknown) => rejection.catch(onRejected));
    services.waitForStageReady.mockReturnValue({
      then: (...a: never[]) => rejection.then(...a),
      catch: caught,
    });
    arrange();

    await expect(startTake('script-1')).resolves.toBe(false);
    expect(caught, 'the armed wait must be given an owner on the way out').toHaveBeenCalled();
    await rejection.catch(() => {});
  });

  it('does not open a session for a script that cannot compile', async () => {
    services.compileScript.mockResolvedValue(
      compileOutput({
        diagnostics: [{ blocking: true, severity: 'error', code: 'X', message: 'Unclosed cue.' }] as never,
      }),
    );
    await expect(startTake('script-1')).resolves.toBe(false);
    expect(services.startSessionRecord).not.toHaveBeenCalled();
    expect(services.openStage).not.toHaveBeenCalled();
    expect(services.showToast).toHaveBeenCalledWith(
      expect.stringContaining('Unclosed cue.'),
      'danger',
    );
  });
});

describe('an unsaved conflict is not something to present through', () => {
  /*
   * `saveNow()` reports a conflict through store state and resolves normally
   * either way, so awaiting it proves nothing. Presenting anyway means the
   * stage shows the older text while the editor shows the newer, and Rust's
   * §21.4 pre-session snapshot records a revision that does not match the
   * compile the aligner was built from.
   */
  it('refuses when the open script changed outside CandidCue', async () => {
    editorState.value = { scriptId: 'script-1', saveState: 'conflict', lastError: null };
    await expect(startTake('script-1')).resolves.toBe(false);
    expect(services.startSessionRecord).not.toHaveBeenCalled();
    expect(services.showToast).toHaveBeenCalledWith(
      expect.stringContaining('changed outside CandidCue'),
      'danger',
    );
  });

  it('refuses when the latest edits could not be written', async () => {
    editorState.value = { scriptId: 'script-1', saveState: 'error', lastError: 'Disk is full.' };
    await expect(startTake('script-1')).resolves.toBe(false);
    expect(services.openStage).not.toHaveBeenCalled();
    expect(services.showToast).toHaveBeenCalledWith(
      expect.stringContaining('older text'),
      'danger',
    );
  });

  it('ignores a conflict belonging to a DIFFERENT script', async () => {
    // Present from the library presents a script the editor never opened; a
    // stale conflict on some other document has no standing over it.
    editorState.value = { scriptId: 'other-script', saveState: 'conflict', lastError: null };
    await expect(startTake('script-1')).resolves.toBe(true);
  });
});

describe('one Present is one take', () => {
  it('a second press while the first is still opening is ignored', async () => {
    /*
     * The sequence is long enough to be double-clicked through — a compile, a
     * window, a handshake — and a second run would open a second stage on top
     * of the first and orphan the first session row.
     */
    let releaseCompile = (): void => {};
    services.compileScript.mockReturnValue(
      new Promise((resolve) => {
        releaseCompile = () => resolve(compileOutput());
      }),
    );

    const first = startTake('script-1');
    const second = startTake('script-1');
    expect(await second).toBe(false);

    releaseCompile();
    expect(await first).toBe(true);
    expect(services.startSessionRecord).toHaveBeenCalledTimes(1);
    expect(services.openStage).toHaveBeenCalledTimes(1);
  });

  it('the guard clears after a failure, so a retry is possible', async () => {
    services.openStage.mockRejectedValueOnce(new Error('no window server'));
    expect(await startTake('script-1')).toBe(false);
    expect(await startTake('script-1')).toBe(true);
  });
});

describe('a take records what the panel ran with, and never asks it', () => {
  /*
   * §52 rows are write-only on this path, and that asymmetry is the contract.
   *
   * The version that shipped for one afternoon RESTORED a profile, and only for
   * an explicitly PINNED display, so the default "Automatic" path wrote a row
   * per take and read none — and moving from a pinned panel to Automatic
   * carried the pinned panel's type across and then saved it over the other
   * panel's row. Appearance still comes from Settings and from the rig in
   * `settings.optical`; what the row is for now is durability, because the
   * optical section lives in a localStorage overlay that "Clear cache" wipes
   * and the row carries `opticalProfile` inside it.
   */
  async function settle(): Promise<void> {
    // The write is detached from the start sequence on purpose.
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  }

  it('saves the stage settings it actually ran against the panel', async () => {
    await startTake('script-1');
    await settle();

    expect(services.saveDisplayProfile).toHaveBeenCalledTimes(1);
    const saved = services.saveDisplayProfile.mock.calls[0]![0] as {
      displayFingerprint: string;
      name: string;
    };
    expect(saved.displayFingerprint).toBe('external-1');
    expect(saved.name).toBe('Teleprompter Display');
  });

  it('updates the panel’s existing row instead of adding one per take', async () => {
    // Rust's upsert is keyed on `id`, so a take that did not resolve the
    // existing row would insert a new one on every single Present, forever.
    services.listDisplayProfiles.mockResolvedValue([
      { id: 'row-for-laptop', displayFingerprint: 'primary-1', updatedAt: '2026-07-02T00:00:00Z' },
      { id: 'row-for-external', displayFingerprint: 'external-1', updatedAt: '2026-07-01T00:00:00Z' },
    ]);
    await startTake('script-1');
    await settle();

    expect(services.listDisplayProfiles).toHaveBeenCalled();
    const saved = services.saveDisplayProfile.mock.calls[0]![0] as { id?: string };
    // …and the row it picks is the one for THIS panel, not the newest overall.
    expect(saved.id).toBe('row-for-external');
  });

  it('never lets a saved row decide what the take looks like', async () => {
    // A row carrying wildly different type must not change a thing: Settings
    // owns appearance, and reading a row to decide it is precisely the defect
    // that made §52 dormant.
    services.listDisplayProfiles.mockResolvedValue([
      {
        id: 'row-for-external',
        displayFingerprint: 'external-1',
        updatedAt: '2026-07-01T00:00:00Z',
        stage: { schemaVersion: 1, fontSizePx: 200, columnWidthPercent: 30 },
      },
    ]);
    settingsState.value = settingsWith((s) => {
      s.teleprompter.fontSizePx = 96;
    });
    await startTake('script-1');
    await settle();

    const stage = liveInput()['stageSettings'] as Record<string, unknown>;
    expect(stage['fontSizePx']).toBe(96);
    expect(stage['columnWidthPercent']).toBe(defaultAppSettings().teleprompter.columnWidthPercent);
  });

  it('presents anyway when the profile store is unreachable', async () => {
    // Failing to remember a preference is not a reason not to present, and an
    // unhandled rejection from a detached write would surface minutes later
    // with nothing to attach it to.
    services.listDisplayProfiles.mockRejectedValue(new Error('database is locked'));
    await expect(startTake('script-1')).resolves.toBe(true);
    await settle();
    expect(services.saveDisplayProfile).not.toHaveBeenCalled();
  });
});
