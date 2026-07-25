/**
 * §28.4 voice-detection sensitivity — the round trip, and the two screens.
 *
 * The slider was wired to the VAD and to the Preflight meter and persisted in
 * the localStorage overlay ONLY: Rust's `AudioSettings` had no such field and
 * `toRustPatch` had no `audio` arm at all, so the mic tuning a presenter set
 * for their room did not survive a cleared browser store, and the backend
 * billing the key could not see the commit cadence it was paying for. This VAD's
 * `speech_ended` IS the Realtime commit cue (§29.3).
 *
 * Reads the same fixture as `src-tauri/tests/ipc_contract_tests.rs`
 * (`tests/fixtures/ipc/audio-settings-payload.json`), the pattern §30 coaching
 * and §37 Listener settings established.
 *
 * The tests fall into three groups, and each fails on a different revert:
 *
 *  - the adapter and the service, against a fake `ipcInvoke` that merges the way
 *    Rust's `merge_json` does — fails if either half of the mapping goes;
 *  - one setting, two screens: Settings → Audio and Preflight both read
 *    `settings.audio.vadSensitivity` and both write it through
 *    `patchSettings('audio', …)`, asserted on the sources, because the failure
 *    guarded against is two controls for one setting rather than one control
 *    in two places;
 *  - behaviour: a value that has been through Rust and back still changes what
 *    the VAD calls speech.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  audioToRustPatch,
  clampVadSensitivity,
  vadSensitivityFromRust,
  VAD_SENSITIVITY_COPY,
  VAD_SENSITIVITY_RANGE,
  type RustAudioSettings,
} from '../../../src/control/services/settings-audio';
import {
  DEFAULT_VAD_CONFIG,
  vadConfigForSensitivity,
} from '../../../src/control/services/audio/defaults';
import { LocalVad, type VadEvent } from '../../../src/control/services/audio/vad';
import { defaultAppSettings } from '../../../src/control/services/settings-types';

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../fixtures/ipc/audio-settings-payload.json', import.meta.url)),
    'utf8',
  ),
) as {
  settings: RustAudioSettings;
  patch: { input: Record<string, unknown>; expected: Record<string, unknown> };
  outOfRange: {
    clamped: Array<{ input: number; expected: number }>;
    neutral: unknown[];
  };
};

describe('§28.4 audio settings adapter', () => {
  it('reads the sensitivity out of the Rust document', () => {
    expect(vadSensitivityFromRust(fixture.settings)).toBe(fixture.settings.vadSensitivity);
    // Deliberately not the neutral default, so a dropped mapping cannot pass.
    expect(fixture.settings.vadSensitivity).not.toBe(VAD_SENSITIVITY_RANGE.neutral);
  });

  it('emits exactly the key Rust reads, and only that key', () => {
    const patch = audioToRustPatch(fixture.patch.input as { vadSensitivity?: number });
    expect(patch).toEqual(fixture.patch.expected);
    // The device id and the processing toggles are per-machine capture state.
    for (const overlayOnly of [
      'preferredDeviceId',
      'followSystemDefault',
      'noiseSuppression',
      'echoCancellation',
      'autoGainControl',
    ]) {
      expect(overlayOnly in patch, `${overlayOnly} belongs to the overlay`).toBe(false);
    }
  });

  it('round-trips: UI → patch → document → UI is the identity', () => {
    const ui = vadSensitivityFromRust(fixture.settings);
    const patch = audioToRustPatch({ vadSensitivity: ui });
    expect(vadSensitivityFromRust(patch as Partial<RustAudioSettings>)).toBe(ui);
  });

  it('emits nothing when the patch does not carry the field', () => {
    expect(audioToRustPatch({})).toEqual({});
    expect(audioToRustPatch(undefined)).toEqual({});
    // …so a concurrent write to another audio field is never clobbered.
    expect(audioToRustPatch({ vadSensitivity: 0 })).toEqual({ vadSensitivity: 0 });
  });

  it('falls back to the neutral midpoint for a document written before the field', () => {
    expect(vadSensitivityFromRust(undefined)).toBe(VAD_SENSITIVITY_RANGE.neutral);
    expect(vadSensitivityFromRust({})).toBe(VAD_SENSITIVITY_RANGE.neutral);
    expect(defaultAppSettings().audio.vadSensitivity).toBe(VAD_SENSITIVITY_RANGE.neutral);
  });

  it('clamps a slider that moved, and neutralises a document that is wrong', () => {
    for (const { input, expected } of fixture.outOfRange.clamped) {
      expect(clampVadSensitivity(input), String(input)).toBe(expected);
    }
    for (const bad of fixture.outOfRange.neutral) {
      // Never the nearest end: a corrupt setting must not silently become the
      // most aggressive VAD available.
      expect(clampVadSensitivity(bad), String(bad)).toBe(VAD_SENSITIVITY_RANGE.neutral);
    }
    expect(clampVadSensitivity(Number.NaN)).toBe(VAD_SENSITIVITY_RANGE.neutral);
  });
});

/* ---------------------------------------------------------------------------
 * One setting, two screens
 * ------------------------------------------------------------------------- */

describe('§28.4 Settings and Preflight expose ONE value', () => {
  const source = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');
  const settingsScreen = source('src/control/routes/Settings.svelte');
  const preflightScreen = source('src/control/routes/Preflight.svelte');

  it('both read the same store field and write the same patch', () => {
    for (const [name, screen] of [
      ['Settings', settingsScreen],
      ['Preflight', preflightScreen],
    ] as const) {
      expect(screen, `${name} must read the shared value`).toContain(
        '$settings.audio.vadSensitivity',
      );
      expect(screen, `${name} must write the shared value`).toContain(
        "patchSettings('audio', { vadSensitivity: value / 100 })",
      );
    }
  });

  it('neither screen keeps its own copy of the control or its wording', () => {
    for (const [name, screen] of [
      ['Settings', settingsScreen],
      ['Preflight', preflightScreen],
    ] as const) {
      // The label and the description come from settings-audio.ts. Two screens
      // describing one setting in two ways is how they drift into being two.
      expect(screen, `${name} must use the shared copy`).toContain('VAD_SENSITIVITY_COPY.label');
      expect(screen).toContain('VAD_SENSITIVITY_COPY.description');
      expect(screen).toContain('VAD_SENSITIVITY_COPY.format');
      // No local state: reading the store directly is what makes a change in
      // one screen visible in the other without a refresh.
      expect(screen.includes('let vadSensitivity'), `${name} must not shadow the store`).toBe(
        false,
      );
    }
  });

  /**
   * The copy has to say what the slider does NOT move, because that bound is
   * the reason it is safe to offer at all.
   *
   * The bound changed with the provider. It used to be "the pause that ends a
   * sentence and how often audio is sent are the same at every position",
   * which was the honest limit when a local detector decided turn boundaries.
   * Now the recogniser endpoints server-side and this slider cannot gate a
   * single byte — so the thing the copy must say is that it does not affect
   * what gets transcribed. A user who believes this control can make the app
   * hear them better will turn it up and be no better off.
   */
  it('says what stays fixed, in symptoms rather than decibels', () => {
    const text = VAD_SENSITIVITY_COPY.description.toLowerCase();
    expect(text).toMatch(/does not gate|not gate what/);
    expect(text).toContain('recogniser hears everything');
    expect(text).toMatch(/raise it if/);
    expect(text).toMatch(/lower it if/);
    // Raising sensitivity lowers the threshold, so being cut off is fixed by
    // RAISING this. The copy must not have that backwards.
    expect(text).not.toContain(' db');
  });

  it('names the midpoint in the readout so the default is findable', () => {
    expect(VAD_SENSITIVITY_COPY.format(50)).toBe('Default');
    expect(VAD_SENSITIVITY_COPY.format(72)).toBe('72%');
  });
});

/* ---------------------------------------------------------------------------
 * The service, against a fake backend that merges the way Rust merges
 * ------------------------------------------------------------------------- */

const ipc = vi.hoisted(() => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const base = {
    revision: 7,
    value: {
      schemaVersion: 1,
      general: {
        openTo: 'library',
        autosaveDebounceMs: 600,
        revisionIntervalMinutes: 5,
        wordsPerMinuteEstimate: 130,
        updateCheck: 'daily',
        analyticsEnabled: false,
        saveTranscript: 'off',
      },
      editor: {},
      stageBehavior: {
        promptMode: 'voice',
        manualWheelMultiplier: 1,
        fixedSpeedWpm: 130,
        pointerHideDelaySeconds: 1.5,
        manualMoveTrackingGraceSeconds: 2.5,
        stageAcknowledgement: 'subtle',
        horizontalMirror: false,
        keepScreenAwake: true,
        blankColor: '#000000',
      },
      audio: {
        transcriptionModel: 'inworld/inworld-stt-1',
        language: 'en',
        delayProfile: 'low',
        softPauseAutoDisconnectMinutes: 10,
        vadSensitivity: 0.5,
      },
      commands: {
        wakePhrase: 'CandidCue',
        wakeMode: 'strict',
      },
      listener: {},
    } as Record<string, unknown>,
  };
  let document = structuredClone(base);
  return {
    calls,
    reset(): void {
      document = structuredClone(base);
      calls.length = 0;
    },
    get audio(): Record<string, unknown> {
      return document.value.audio as Record<string, unknown>;
    },
    invoke: async (command: string, args?: unknown) => {
      calls.push({ command, args });
      if (command === 'update_settings') {
        const { patch } = args as { patch: Record<string, Record<string, unknown>> };
        for (const [section, values] of Object.entries(patch)) {
          const target = (document.value[section] ??= {}) as Record<string, unknown>;
          for (const [key, value] of Object.entries(values)) {
            if (value === null) delete target[key];
            else target[key] = value;
          }
        }
        document.revision += 1;
      }
      return document;
    },
  };
});

vi.mock('../../../src/control/services/ipc', () => ({
  isTauriRuntime: () => true,
  BackendUnavailableError: class extends Error {},
  ipcInvoke: ipc.invoke,
}));

const localStore = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => localStore.get(key) ?? null,
    setItem: (key: string, value: string) => void localStore.set(key, value),
    removeItem: (key: string) => void localStore.delete(key),
    clear: () => localStore.clear(),
  },
});

const OVERLAY_KEY = 'candidcue.settings-overlay.v1';
const settingsService = await import('../../../src/control/services/settings');

beforeEach(() => {
  ipc.reset();
  localStore.clear();
});

describe('§28.4 sensitivity through the real settings service', () => {
  it('a value set in the UI reaches Rust and comes back on the next read', async () => {
    const before = await settingsService.getSettings();
    expect(before.audio.vadSensitivity).toBe(0.5);

    const saved = await settingsService.updateSettings(before.revision, {
      audio: { ...before.audio, vadSensitivity: fixture.settings.vadSensitivity },
    });

    const update = ipc.calls.find((c) => c.command === 'update_settings');
    expect(update, 'a sensitivity change must be persisted, not overlaid').toBeDefined();
    expect((update!.args as { patch: Record<string, unknown> }).patch).toEqual({
      audio: { vadSensitivity: fixture.settings.vadSensitivity },
    });

    expect(saved.audio.vadSensitivity).toBe(fixture.settings.vadSensitivity);
    expect(ipc.audio.vadSensitivity).toBe(fixture.settings.vadSensitivity);
    expect((await settingsService.getSettings()).audio.vadSensitivity).toBe(
      fixture.settings.vadSensitivity,
    );
  });

  it('never writes the sensitivity into the localStorage overlay', async () => {
    const before = await settingsService.getSettings();
    await settingsService.updateSettings(before.revision, {
      audio: { ...before.audio, vadSensitivity: 0.9, noiseSuppression: false },
    });
    const overlay = JSON.parse(localStore.get(OVERLAY_KEY) ?? '{}');
    // The per-machine capture state still overlays…
    expect(overlay.audio.noiseSuppression).toBe(false);
    // …and the Rust-owned field does not, because a cached copy would outlive
    // the document and could contradict it.
    expect('vadSensitivity' in (overlay.audio ?? {})).toBe(false);
  });

  it('lets the document win over a stale overlay copy', async () => {
    // A store written by an older build, when the field WAS overlaid.
    localStore.set(OVERLAY_KEY, JSON.stringify({ audio: { vadSensitivity: 0.1 } }));
    ipc.audio.vadSensitivity = 0.72;
    expect((await settingsService.getSettings()).audio.vadSensitivity).toBe(0.72);
  });

  it('survives a document written before the field existed', async () => {
    delete ipc.audio.vadSensitivity;
    expect((await settingsService.getSettings()).audio.vadSensitivity).toBe(
      VAD_SENSITIVITY_RANGE.neutral,
    );
  });
});

/* ---------------------------------------------------------------------------
 * Behaviour: the persisted value still changes what counts as speech
 * ------------------------------------------------------------------------- */

const FRAME_MS = 50;

function opensSpeechAt(sensitivity: number, ambientRms: number, speechRms: number): boolean {
  const vad = new LocalVad(vadConfigForSensitivity(sensitivity));
  const feed = (startMs: number, durationMs: number, rms: number): VadEvent[] => {
    const events: VadEvent[] = [];
    for (let t = startMs; t < startMs + durationMs; t += FRAME_MS) {
      events.push(...vad.processFrame({ rms, peak: rms }, t));
    }
    return events;
  };
  feed(0, DEFAULT_VAD_CONFIG.calibrationMs + FRAME_MS, ambientRms);
  const events = feed(
    DEFAULT_VAD_CONFIG.calibrationMs + FRAME_MS,
    DEFAULT_VAD_CONFIG.speechOpenMs + 4 * FRAME_MS,
    speechRms,
  );
  return events.some((e) => e.type === 'speech_started');
}

describe('§28.4 the persisted value is still a real control', () => {
  it('changes what the VAD calls speech after a full round trip', async () => {
    const ambient = 0.006;
    const quietSpeech = 0.014;

    const before = await settingsService.getSettings();
    await settingsService.updateSettings(before.revision, {
      audio: { ...before.audio, vadSensitivity: 0 },
    });
    const insensitive = (await settingsService.getSettings()).audio.vadSensitivity;

    const mid = await settingsService.getSettings();
    await settingsService.updateSettings(mid.revision, {
      audio: { ...mid.audio, vadSensitivity: 1 },
    });
    const sensitive = (await settingsService.getSettings()).audio.vadSensitivity;

    // The persisted values are the ends of the slider…
    expect(insensitive).toBe(0);
    expect(sensitive).toBe(1);
    // …and at one level of input they disagree about whether it is speech.
    expect(opensSpeechAt(insensitive, ambient, quietSpeech)).toBe(false);
    expect(opensSpeechAt(sensitive, ambient, quietSpeech)).toBe(true);
  });

  it('keeps the commit cadence fixed at every persisted position', async () => {
    for (const sensitivity of [0, 0.25, 0.72, 1]) {
      const before = await settingsService.getSettings();
      const saved = await settingsService.updateSettings(before.revision, {
        audio: { ...before.audio, vadSensitivity: sensitivity },
      });
      const config = vadConfigForSensitivity(saved.audio.vadSensitivity) as Record<string, unknown>;
      // Money and latency, not detection — see VAD_SENSITIVITY_BOUNDS.
      for (const fixed of ['endOfTurnSilenceMs', 'maxUtteranceMs', 'calibrationMs']) {
        expect(fixed in config, `${fixed} must not move with the slider`).toBe(false);
      }
    }
  });
});
