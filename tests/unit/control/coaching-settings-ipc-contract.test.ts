/**
 * §30 Live Coaching settings — the TypeScript half of the round trip.
 *
 * Reads the same fixture as `src-tauri/tests/ipc_contract_tests.rs`
 * (`tests/fixtures/ipc/coaching-settings-payload.json`), so the two halves
 * cannot drift apart quietly: Rust proves the patch deserializes into the
 * struct and serializes back unchanged, and this file proves the adapter emits
 * that patch and reads that document back to the same UI value.
 *
 * The reason this is the test that matters: a settings field mapped in ONE
 * direction passes a naive test easily — write it, read your own optimistic
 * copy back, green — and this project has shipped that defect twice. Every
 * value in the fixture is non-default, so a missing mapping in either
 * direction comes back as a default and fails naming the field.
 *
 * The service-level test at the bottom drives the *real* `getSettings` /
 * `updateSettings` against a fake `ipcInvoke` that actually merges the patch
 * into a document, the way Rust does. It is deliberately NOT satisfied by
 * `invokeOrMock`'s fallback: `isTauriRuntime` is mocked to `true`, so
 * `mock-backend.ts` is never consulted and an assertion here is a statement
 * about the adapter, not about the mock.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  coachingFromRust,
  coachingToRustPatch,
  type RustCoachingSettings,
} from '../../../src/control/services/settings-coaching';
import {
  clampCoaching,
  defaultCoachingSettings,
} from '../../../src/control/lib/coaching-profiles';
import type { CoachingSettings } from '../../../src/shared/contracts';

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../fixtures/ipc/coaching-settings-payload.json', import.meta.url)),
    'utf8',
  ),
) as {
  settings: RustCoachingSettings;
  presetPatch: { input: Record<string, unknown>; expected: Record<string, unknown> };
  clearPatch: { input: Record<string, unknown>; expected: Record<string, unknown> };
};

describe('§30 coaching settings adapter', () => {
  it('reads the Rust document into the UI view with every value intact', () => {
    const ui = coachingFromRust(fixture.settings);
    expect(ui).toEqual(fixture.settings as unknown as CoachingSettings);
  });

  it('emits exactly the document Rust reads, for a whole-section write', () => {
    const ui = coachingFromRust(fixture.settings);
    expect(coachingToRustPatch(ui)).toEqual(fixture.settings);
  });

  it('round-trips: UI → patch → document → UI is the identity', () => {
    const ui = coachingFromRust(fixture.settings);
    const patch = coachingToRustPatch(ui);
    // What Rust stores is the merge of the patch onto the document; for a
    // whole-section write that is the patch itself.
    const backAgain = coachingFromRust(patch as Partial<RustCoachingSettings>);
    expect(backAgain).toEqual(ui);
  });

  /*
   * The mutation check, written down: every field is asserted individually, so
   * a reviewer can see that "the object matched" is not doing the work. If a
   * key were dropped from `coachingToRustPatch`, the whole-section assertion
   * above fails; if it were dropped from `coachingFromRust`, the first one
   * does. Both are listed here by name so neither can be deleted by accident.
   */
  it('maps every field of the contract, named one by one', () => {
    const patch = coachingToRustPatch(coachingFromRust(fixture.settings));
    const expectedKeys: Array<keyof RustCoachingSettings> = [
      'mode',
      'deliveryStyle',
      'pacePreset',
      'targetWpmLow',
      'targetWpmHigh',
      'targetVarietyLow',
      'targetVarietyHigh',
      'targetDurationSeconds',
      'liveTipFrequency',
      'precisionTranscriptionMode',
      'fillerDetectionScope',
      'customFillerWords',
      'trackRepeatedOpeners',
      'positiveReinforcementEnabled',
      'postTakeReportEnabled',
      'retainAudioRecordingEnabled',
      'personalCalibrationEnabled',
      'personalCalibrationResetAtEpochMs',
      'goals',
      'railTextScale',
      'modules',
    ];
    expect(Object.keys(patch).sort()).toEqual([...expectedKeys].sort());
    for (const key of expectedKeys) {
      expect(patch[key], `${key} must survive the mapping`).toEqual(fixture.settings[key]);
    }
  });

  it('sends the band with the preset that decided it (§14.6)', () => {
    const patch = coachingToRustPatch(fixture.presetPatch.input as Partial<CoachingSettings>);
    expect(patch).toEqual(fixture.presetPatch.expected);
  });

  it('sends null to clear a target duration, rather than omitting the key', () => {
    const patch = coachingToRustPatch(fixture.clearPatch.input as Partial<CoachingSettings>);
    expect(patch).toEqual(fixture.clearPatch.expected);
    expect('targetDurationSeconds' in patch).toBe(true);
  });

  it('falls back to defaults for a document written before the section existed', () => {
    expect(coachingFromRust(undefined)).toEqual(defaultCoachingSettings());
    expect(coachingFromRust({})).toEqual(defaultCoachingSettings());
  });

  it('clamps an unrecognised persisted value rather than throwing', () => {
    const ui = coachingFromRust({
      ...fixture.settings,
      mode: 'telepathy',
      precisionTranscriptionMode: 'true',
    });
    expect(ui.mode).toBe('coach');
    expect(ui.precisionTranscriptionMode).toBe('off');
  });

  /* §32.1/§32.2 — the safe side of "I could not understand this". */
  it('treats a non-boolean audio consent as off', () => {
    const ui = coachingFromRust({
      ...fixture.settings,
      retainAudioRecordingEnabled: 'yes' as unknown as boolean,
    });
    expect(ui.retainAudioRecordingEnabled).toBe(false);
  });

  it('never invents a goal threshold from a zero or a negative', () => {
    const ui = clampCoaching({
      goals: {
        maxFillersPerMinute: 0,
        maxFillersPerHundredWords: -2,
        paceWithinTargetRange: false,
        finishWithinTargetDuration: false,
        varietyWithinTargetBand: false,
      },
    });
    expect(ui.goals.maxFillersPerMinute).toBeNull();
    expect(ui.goals.maxFillersPerHundredWords).toBeNull();
  });

  it('does not cap the user’s own filler vocabulary', () => {
    const many = Array.from({ length: 400 }, (_, i) => `filler-${i}`);
    expect(clampCoaching({ customFillerWords: many }).customFillerWords).toHaveLength(400);
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
        transcriptionModel: 'gpt-realtime-whisper',
        language: 'en',
        delayProfile: 'low',
        softPauseAutoDisconnectMinutes: 10,
      },
      commands: {
        wakePhrase: 'CandidCue',
        wakeMode: 'strict',
        lunaFallback: true,
        commandModel: 'gpt-5.6-luna',
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
    get coaching(): Record<string, unknown> | undefined {
      return document.value.coaching as Record<string, unknown> | undefined;
    },
    invoke: async (command: string, args?: unknown) => {
      calls.push({ command, args });
      if (command === 'update_settings') {
        const { patch } = args as { patch: Record<string, Record<string, unknown>> };
        // Rust's `merge_json`: objects merge key by key, a null REMOVES the key,
        // everything else replaces. Reproduced here because the whole point of
        // this test is that the frontend's patch means what Rust does with it.
        for (const [section, values] of Object.entries(patch)) {
          const target = ((document.value[section] ??= {}) as Record<string, unknown>);
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

const settings = await import('../../../src/control/services/settings');
const retention = await import('../../../src/control/services/settings-retention');

beforeEach(() => {
  ipc.reset();
  localStore.clear();
  retention.clearRetentionPurgers();
});

describe('§30 coaching settings through the real settings service', () => {
  it('a value set in the UI survives the write and the next read', async () => {
    const before = await settings.getSettings();
    expect(before.coaching).toEqual(defaultCoachingSettings());

    const wanted = coachingFromRust(fixture.settings);
    const saved = await settings.updateSettings(before.revision, { coaching: wanted });

    // The write reached Rust, not only the local overlay.
    const update = ipc.calls.find((c) => c.command === 'update_settings');
    expect(update, 'a coaching change must be persisted, not overlaid').toBeDefined();
    expect((update!.args as { patch: Record<string, unknown> }).patch).toEqual({
      coaching: fixture.settings,
    });

    expect(saved.coaching).toEqual(wanted);

    // And a fresh read of the stored document gives the same value back.
    const reloaded = await settings.getSettings();
    expect(reloaded.coaching).toEqual(wanted);
  });

  it('never writes a coaching value into the localStorage overlay', async () => {
    const before = await settings.getSettings();
    await settings.updateSettings(before.revision, {
      coaching: { ...before.coaching, mode: 'studio' },
    });
    const overlay = localStore.get('candidcue.settings-overlay.v1') ?? '{}';
    expect(
      JSON.parse(overlay).coaching,
      'a cached copy of a retention consent must not exist',
    ).toBeUndefined();
  });

  it('follows Rust rather than its own optimism when the document disagrees', async () => {
    const before = await settings.getSettings();
    await settings.updateSettings(before.revision, {
      coaching: { ...before.coaching, retainAudioRecordingEnabled: true },
    });
    // Another window turns it back off.
    delete (ipc.coaching as Record<string, unknown>).retainAudioRecordingEnabled;
    const reloaded = await settings.getSettings();
    expect(reloaded.coaching.retainAudioRecordingEnabled).toBe(false);
  });

  it('clears a target duration end to end (null removes the key, default refills it)', async () => {
    const first = await settings.getSettings();
    const withTarget = await settings.updateSettings(first.revision, {
      coaching: { ...first.coaching, targetDurationSeconds: 420 },
    });
    expect(withTarget.coaching.targetDurationSeconds).toBe(420);

    const cleared = await settings.updateSettings(withTarget.revision, {
      coaching: { ...withTarget.coaching, targetDurationSeconds: null },
    });
    expect(cleared.coaching.targetDurationSeconds).toBeNull();
    expect(ipc.coaching?.targetDurationSeconds).toBeUndefined();
  });

  /* §32.2 consent revocation — the settings half of ReportStore's rule. */
  it('purges what an earlier take stored when a retention consent goes off', async () => {
    const purged: string[] = [];
    retention.registerRetentionPurger('coaching_report', async () => void purged.push('report'));
    retention.registerRetentionPurger('audio_recording', async () => void purged.push('audio'));

    const before = await settings.getSettings();
    await settings.updateSettings(before.revision, {
      coaching: {
        ...before.coaching,
        postTakeReportEnabled: false,
        retainAudioRecordingEnabled: false,
      },
    });
    expect(purged).toEqual(['report', 'audio']);
  });

  it('does not purge when a consent is being turned ON', async () => {
    const purged: string[] = [];
    retention.registerRetentionPurger('audio_recording', async () => void purged.push('audio'));
    const before = await settings.getSettings();
    await settings.updateSettings(before.revision, {
      coaching: { ...before.coaching, retainAudioRecordingEnabled: true },
    });
    expect(purged).toEqual([]);
  });

  it('reports a failed purge instead of letting the user believe data is gone', async () => {
    retention.registerRetentionPurger('audio_recording', async () => {
      throw new Error('disk is read-only');
    });
    const before = await settings.getSettings();
    const saved = await settings.updateSettings(before.revision, {
      coaching: { ...before.coaching, retainAudioRecordingEnabled: false },
    });
    // The settings change genuinely persisted…
    expect(saved.coaching.retainAudioRecordingEnabled).toBe(false);
    // …and the failure is available to say out loud, exactly once.
    const message = settings.takeRetentionPurgeFailure();
    expect(message).toContain('still on this device');
    expect(settings.takeRetentionPurgeFailure()).toBeNull();
  });
});
