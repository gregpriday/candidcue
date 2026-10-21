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
 * established.
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

describe('\u00a728.4 one value, and the take runs on it', () => {
  const source = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');
  const settingsScreen = source('src/control/routes/Settings.svelte');
  const startTake = source('src/control/lib/start-take.ts');

  /*
   * This used to assert that Settings and Preflight exposed ONE value, because
   * there were two screens with a sensitivity slider on them and the risk was
   * that they drifted into being two settings. Preflight is gone: the slider
   * exists once. What is worth pinning now is the other half of that same
   * invariant — that the value the meter is read at is the value the TAKE runs
   * at. A meter tuned against settings the session then ignores is a diagnostic
   * that lies, which is exactly what having two copies produced.
   */
  it('the screen reads and writes the store rather than a copy of it', () => {
    expect(settingsScreen, 'Settings must read the shared value').toContain(
      '$settings.audio.vadSensitivity',
    );
    expect(settingsScreen, 'Settings must write the shared value').toContain(
      "patchSettings('audio', { vadSensitivity: value / 100 })",
    );
    // No local state: reading the store directly is what makes the meter
    // reflect a change to the slider without a reload.
    expect(settingsScreen.includes('let vadSensitivity'), 'must not shadow the store').toBe(false);
  });

  it('the level meter observes at the sensitivity and processing a take uses', () => {
    expect(settingsScreen).toContain('vadSensitivity: $settings.audio.vadSensitivity');
    for (const field of ['echoCancellation', 'noiseSuppression', 'autoGainControl']) {
      expect(settingsScreen, `the meter must observe with ${field}`).toContain(
        `${field}: $settings.audio.${field}`,
      );
      expect(startTake, `the take must capture with ${field}`).toContain(
        `${field}: s.audio.${field}`,
      );
    }
  });

  it('uses the shared copy rather than its own wording', () => {
    // The label and the description come from settings-audio.ts.
    expect(settingsScreen).toContain('VAD_SENSITIVITY_COPY.label');
    expect(settingsScreen).toContain('VAD_SENSITIVITY_COPY.description');
    expect(settingsScreen).toContain('VAD_SENSITIVITY_COPY.format');
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
  it('says what stays fixed, and in no units anyone has to look up', () => {
    const text = VAD_SENSITIVITY_COPY.description.toLowerCase();
    expect(text).toMatch(/does not gate|not gate what/);
    expect(text).toContain('recogniser hears everything');
    expect(text).not.toContain(' db');
  });

  /**
   * …and sends each symptom to the end of the slider that actually cures it.
   *
   * The assertion this replaced checked only that the words "raise it if" and
   * "lower it if" both appeared somewhere. That is true of the correct copy and
   * of its exact inverse alike, so it stayed green while the shipped string
   * told a user with a noisy room to turn the sensitivity UP and a user whose
   * quiet speech was being missed to turn it DOWN — both of which make the
   * reported symptom worse (#120). The doc comment above the string had stated
   * the direction correctly the whole time; prose and mapping simply drifted.
   *
   * The pairing is asserted on the literal phrases rather than parsed out of
   * the sentence. Splitting English into clauses and reading the nearest verb
   * looks more general, but it cannot see negation or a direction mentioned
   * twice — "do not lower it if a fan…; do not raise it if quiet speech…"
   * parses as correct advice. A reworded description SHOULD have to come back
   * through this test, which is the lesson of #120 rather than an obstacle to it.
   *
   * What is derived at runtime is which phrase belongs where: `noiseFloorMargin`
   * falls as sensitivity rises, so the high end is the easier trigger. Flip the
   * bounds and this fails, pointing at the copy that now lies about them.
   */
  it('sends each symptom to the end of the slider that cures it', () => {
    const marginAt = (sensitivity: number): number => {
      const margin = vadConfigForSensitivity(sensitivity).noiseFloorMargin;
      // A renamed field would leave both ends undefined, and `undefined >
      // undefined` is false — a direction picked out of nothing.
      expect(
        Number.isFinite(margin),
        `vadConfigForSensitivity(${sensitivity}) must set a finite margin`,
      ).toBe(true);
      return margin as number;
    };

    // Read off the mapping rather than assumed: a smaller margin triggers sooner.
    expect(marginAt(0), 'sensitivity 1 must be the easier trigger').toBeGreaterThan(marginAt(1));

    // So false triggering is cured at the LOW end, missed speech at the HIGH end.
    expect(VAD_SENSITIVITY_COPY.description).toContain(
      'Lower it if a fan or people nearby keep the indicator lit',
    );
    expect(VAD_SENSITIVITY_COPY.description).toContain(
      'raise it if quiet speech does not register',
    );
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
      },
      stageBehavior: {
        promptMode: 'voice',
        fixedSpeedWpm: 130,
        horizontalMirror: false,
      },
      audio: {
        transcriptionModel: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05',
        language: 'en',
        delayProfile: 'low',
        vadSensitivity: 0.5,
      },
      commands: {
        wakePhrase: 'Speaking Glass',
        wakeMode: 'strict',
      },
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

const OVERLAY_KEY = 'speaking-glass.settings-overlay.v1';
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
