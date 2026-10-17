/**
 * #215 — the retired transcript retention window must not cost anybody their
 * other settings.
 *
 * A settings document written before #217 still carries
 * `general.saveTranscript` until its next save, and a localStorage overlay
 * written by an older build can still hold `privacy.saveTranscript`. Neither
 * is read any more, and both have to be tolerated the way the retired
 * `updateCheck` key is: the rest of the document loads exactly as it would
 * without them, and nothing this side of the boundary writes the field back.
 *
 * These drive the real service against a fake `ipcInvoke` and a real
 * (in-memory) localStorage, so the overlay code path actually runs — without
 * one the service short-circuits on `typeof localStorage === 'undefined'` and
 * the overlay tests would pass for the wrong reason.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import retiredDocument from '../../fixtures/ipc/settings-retired-document.json';

const ipc = vi.hoisted(() => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const document = (general: Record<string, unknown>) => ({
    revision: 4,
    value: {
      schemaVersion: 1,
      general: {
        openTo: 'last_script',
        ...general,
      },
      stageBehavior: {
        promptMode: 'fixed',
        fixedSpeedWpm: 172,
        horizontalMirror: false,
      },
      audio: {
        transcriptionModel: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05',
        language: 'en',
        delayProfile: 'low',
      },
      commands: {
        wakePhrase: 'CandidCue',
        wakeMode: 'strict',
      },
    },
  });
  let current = document({});
  return {
    calls,
    document,
    serve(next: ReturnType<typeof document>): void {
      current = next;
    },
    invoke: async (command: string, args?: unknown) => {
      calls.push({ command, args });
      return current;
    },
  };
});

vi.mock('../../../src/control/services/ipc', () => ({
  isTauriRuntime: () => true,
  BackendUnavailableError: class extends Error {},
  ipcInvoke: ipc.invoke,
}));

const store = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  },
});

const settings = await import('../../../src/control/services/settings');

function overlay(): Record<string, unknown> {
  return JSON.parse(store.get(settings.SETTINGS_OVERLAY_KEY) ?? '{}') as Record<string, unknown>;
}

beforeEach(() => {
  ipc.calls.length = 0;
  ipc.serve(ipc.document({}));
  store.clear();
});

describe('#215 a document that still carries saveTranscript', () => {
  it('loads every other setting exactly as a document without it does', async () => {
    const without = await settings.getSettings();

    for (const value of ['off', '7d', 'forever', 'someday']) {
      ipc.serve(ipc.document({ saveTranscript: value }));
      const loaded = await settings.getSettings();
      expect(loaded, `general.saveTranscript: '${value}'`).toStrictEqual(without);
    }
    // And the values the fixture moved off their defaults really arrived, so
    // the comparison above is not two copies of `defaultAppSettings()`.
    expect(without.general.launchBehavior).toBe('recent');
    expect(without.general.defaultSessionMode).toBe('fixed');
    expect(without.teleprompter.fixedSpeedWpm).toBe(172);
  });

  it('surfaces no privacy section for anything to read', async () => {
    ipc.serve(ipc.document({ saveTranscript: '30d' }));
    const loaded = await settings.getSettings();
    expect(Object.hasOwn(loaded, 'privacy')).toBe(false);
  });

  it('is adopted from a broadcast like any other document', () => {
    // Cross-window adoption goes through the same adapter, and a document it
    // refused would leave the other window on a stale revision.
    const adopted = settings.adaptRevisionedSettings(ipc.document({ saveTranscript: '7d' }));
    expect(adopted).not.toBeNull();
    expect(adopted?.revision).toBe(4);
  });
});

describe('#215 an overlay written by a build that had the retention row', () => {
  beforeEach(() => {
    store.set(
      settings.SETTINGS_OVERLAY_KEY,
      JSON.stringify({
        privacy: { saveTranscript: 'forever' },
        stage: { displayFingerprint: 'dsp-2' },
      }),
    );
  });

  it('is ignored on read, and the rest of the overlay still applies', async () => {
    const loaded = await settings.getSettings();
    expect(Object.hasOwn(loaded, 'privacy')).toBe(false);
    expect(loaded.stage.displayFingerprint).toBe('dsp-2');
    // A read never writes: the stale section is still there until a save.
    expect(overlay()).toHaveProperty('privacy');
  });

  it('loses the stale section on the next save and keeps everything else', async () => {
    await settings.updateSettings(4, { teleprompter: { fixedSpeedWpm: 160 } as never });
    expect(overlay()).not.toHaveProperty('privacy');
    expect(overlay()).toMatchObject({ stage: { displayFingerprint: 'dsp-2' } });
  });
});

describe('#215 nothing writes saveTranscript any more', () => {
  it('sends no general.saveTranscript, even for a legacy-shaped patch', async () => {
    await settings.updateSettings(4, {
      privacy: { saveTranscript: '7d' },
      teleprompter: { fixedSpeedWpm: 160 },
    } as never);

    const updates = ipc.calls.filter((call) => call.command === 'update_settings');
    expect(updates, 'the speed change must still reach Rust').toHaveLength(1);
    expect((updates[0]!.args as { patch: Record<string, unknown> }).patch).toEqual({
      stageBehavior: { fixedSpeedWpm: 160 },
    });
    // And the stray section did not land in the overlay instead.
    expect(overlay()).not.toHaveProperty('privacy');
  });

  it('a privacy-only patch has no Rust home and writes nothing', async () => {
    await settings.updateSettings(4, { privacy: { saveTranscript: 'forever' } } as never);
    expect(ipc.calls.map((call) => call.command)).not.toContain('update_settings');
    expect(overlay()).not.toHaveProperty('privacy');
  });
});

/*
 * #300 — the stored `teleprompter.stageMode` is nobody's choice.
 *
 * No control ever wrote it, and the store saves a whole section at a time, so
 * any teleprompter change at all carried the old `'diagnostic'` default into
 * the overlay with it. Honouring that copy would keep those profiles in
 * Diagnostic Take after the default moved; `diagnosticTake` is where a choice
 * is recorded now.
 */
describe('#300 an overlay that still carries teleprompter.stageMode', () => {
  function seed(teleprompter: Record<string, unknown>): void {
    store.set(
      settings.SETTINGS_OVERLAY_KEY,
      JSON.stringify({ teleprompter, stage: { displayFingerprint: 'dsp-2' } }),
    );
  }

  it('is ignored on read, and the rest of the section still applies', async () => {
    for (const legacy of ['diagnostic', 'clean']) {
      seed({ stageMode: legacy, fontSizePx: 72 });
      const loaded = await settings.getSettings();
      expect(Object.hasOwn(loaded.teleprompter, 'stageMode'), legacy).toBe(false);
      expect(loaded.teleprompter.diagnosticTake, legacy).toBe(false);
      expect(loaded.teleprompter.fontSizePx, legacy).toBe(72);
      expect(loaded.stage.displayFingerprint, legacy).toBe('dsp-2');
    }
    // A read never writes: the stale key is still there until a save.
    expect((overlay().teleprompter as Record<string, unknown>).stageMode).toBe('clean');
  });

  it('honours a stored diagnosticTake beside it', async () => {
    seed({ stageMode: 'clean', diagnosticTake: true });
    const loaded = await settings.getSettings();
    expect(loaded.teleprompter.diagnosticTake).toBe(true);
    expect(Object.hasOwn(loaded.teleprompter, 'stageMode')).toBe(false);
  });

  it('loses the stale key on the next teleprompter save and keeps everything else', async () => {
    seed({ stageMode: 'diagnostic', fontSizePx: 72 });
    const loaded = await settings.getSettings();
    // The store sends the WHOLE section, as `sendPatchBatch` does.
    await settings.updateSettings(4, {
      teleprompter: { ...loaded.teleprompter, diagnosticTake: true },
    });
    const stored = overlay().teleprompter as Record<string, unknown>;
    expect(stored).not.toHaveProperty('stageMode');
    expect(stored).toMatchObject({ diagnosticTake: true, fontSizePx: 72 });
    expect(overlay()).toMatchObject({ stage: { displayFingerprint: 'dsp-2' } });
  });

  it('cannot be written back by a legacy-shaped patch', async () => {
    await settings.updateSettings(4, {
      teleprompter: { stageMode: 'diagnostic', fixedSpeedWpm: 160 },
    } as never);
    expect(overlay().teleprompter).not.toHaveProperty('stageMode');
    const loaded = await settings.getSettings();
    expect(loaded.teleprompter.diagnosticTake).toBe(false);
  });
});

/*
 * #218 — Settings rows that changed nothing.
 *
 * Revision retention pruned nothing, nothing read "When a session ends", and
 * the stage hides the pointer after a fixed 1.5 s whatever "Hide the pointer"
 * said. The rows are gone, and an overlay saved while they existed still holds
 * all three keys — the store saved whole sections, so the defaults rode in with
 * any change to General or Teleprompter.
 */
describe('#218 an overlay that still carries the retired rows', () => {
  const current = {
    general: { confirmEndSession: false, readHeadings: true },
    teleprompter: { fontSizePx: 72, diagnosticTake: true },
    stage: { displayFingerprint: 'dsp-2' },
  };
  const legacy = {
    general: { ...current.general, revisionRetentionDays: 7 },
    teleprompter: { ...current.teleprompter, stageEndBehavior: 'blank', hidePointer: false },
    stage: current.stage,
  };

  function seed(value: unknown): void {
    store.set(settings.SETTINGS_OVERLAY_KEY, JSON.stringify(value));
  }

  it('loads exactly as the same overlay without them', async () => {
    seed(current);
    const without = await settings.getSettings();

    seed(legacy);
    const loaded = await settings.getSettings();
    expect(loaded).toStrictEqual(without);
    expect(Object.hasOwn(loaded.general, 'revisionRetentionDays')).toBe(false);
    expect(Object.hasOwn(loaded.teleprompter, 'stageEndBehavior')).toBe(false);
    expect(Object.hasOwn(loaded.teleprompter, 'hidePointer')).toBe(false);
    // And the rest of the overlay really applied, so the comparison above is
    // not two copies of the defaults.
    expect(loaded.general.confirmEndSession).toBe(false);
    expect(loaded.general.readHeadings).toBe(true);
    expect(loaded.teleprompter.fontSizePx).toBe(72);
    expect(loaded.teleprompter.diagnosticTake).toBe(true);
    expect(loaded.stage.displayFingerprint).toBe('dsp-2');
    // A read never writes: the stale keys are still there until a save.
    expect(overlay()).toStrictEqual(legacy);
  });

  it('is adopted from a broadcast without them', () => {
    seed(legacy);
    const adopted = settings.adaptRevisionedSettings(ipc.document({}));
    expect(adopted).not.toBeNull();
    expect(Object.hasOwn(adopted!.general, 'revisionRetentionDays')).toBe(false);
    expect(Object.hasOwn(adopted!.teleprompter, 'hidePointer')).toBe(false);
    expect(adopted!.teleprompter.fontSizePx).toBe(72);
  });

  it('loses them on the next save of each section and keeps everything else', async () => {
    seed(legacy);
    const loaded = await settings.getSettings();
    // The store sends the WHOLE section, as `sendPatchBatch` does.
    await settings.updateSettings(4, {
      general: { ...loaded.general, confirmEndSession: true },
      teleprompter: { ...loaded.teleprompter, fontSizePx: 80 },
    });
    const stored = overlay() as { general: object; teleprompter: object; stage: object };
    expect(stored.general).not.toHaveProperty('revisionRetentionDays');
    expect(stored.general).toMatchObject({ confirmEndSession: true, readHeadings: true });
    expect(stored.teleprompter).not.toHaveProperty('stageEndBehavior');
    expect(stored.teleprompter).not.toHaveProperty('hidePointer');
    expect(stored.teleprompter).toMatchObject({ fontSizePx: 80, diagnosticTake: true });
    expect(stored.stage).toStrictEqual({ displayFingerprint: 'dsp-2' });
  });

  it('drops the stored copies even when the patch does not mention them', async () => {
    // Stripped from the MERGED section: the write spreads the stored section
    // back in, so a patch-only strip would leave them there for good.
    seed(legacy);
    await settings.updateSettings(4, {
      general: { confirmEndSession: true },
      teleprompter: { fontSizePx: 80 },
    } as never);
    const stored = overlay() as { general: object; teleprompter: object };
    expect(stored.general).toStrictEqual({ confirmEndSession: true, readHeadings: true });
    expect(stored.teleprompter).toStrictEqual({ fontSizePx: 80, diagnosticTake: true });
  });
});

describe('#218 nothing writes the retired rows any more', () => {
  it('a legacy-shaped patch stores none of them and sends Rust no pointer delay', async () => {
    await settings.updateSettings(4, {
      general: { revisionRetentionDays: 90 },
      teleprompter: { stageEndBehavior: 'blank', hidePointer: false, fixedSpeedWpm: 160 },
    } as never);

    const updates = ipc.calls.filter((call) => call.command === 'update_settings');
    expect(updates, 'the speed change must still reach Rust').toHaveLength(1);
    expect((updates[0]!.args as { patch: Record<string, unknown> }).patch).toEqual({
      stageBehavior: { fixedSpeedWpm: 160 },
    });
    const stored = overlay() as { general?: object; teleprompter?: object };
    expect(stored.general ?? {}).not.toHaveProperty('revisionRetentionDays');
    expect(stored.teleprompter ?? {}).not.toHaveProperty('stageEndBehavior');
    expect(stored.teleprompter ?? {}).not.toHaveProperty('hidePointer');
  });

  it('a whole-section save from the defaults carries none of them', async () => {
    const loaded = await settings.getSettings();
    await settings.updateSettings(4, {
      general: { ...loaded.general, confirmEndSession: false },
      teleprompter: { ...loaded.teleprompter, fontSizePx: 80 },
    });
    const patch = (ipc.calls.find((call) => call.command === 'update_settings')!.args as {
      patch: { stageBehavior?: Record<string, unknown> };
    }).patch;
    expect(patch.stageBehavior ?? {}).not.toHaveProperty('pointerHideDelaySeconds');
    const stored = overlay() as { general: object; teleprompter: object };
    expect(stored.general).not.toHaveProperty('revisionRetentionDays');
    expect(stored.teleprompter).not.toHaveProperty('stageEndBehavior');
    expect(stored.teleprompter).not.toHaveProperty('hidePointer');
  });

  it("Rust's stored pointer delay changes nothing this side can see", async () => {
    ipc.serve(ipc.document({}));
    const hidden = await settings.getSettings();
    const shown = ipc.document({});
    shown.value.stageBehavior.pointerHideDelaySeconds = 1.5;
    ipc.serve(shown);
    expect(await settings.getSettings()).toStrictEqual(hidden);
  });
});

describe('#218 a document that still carries the retired following fields', () => {
  function withFollowing(following: Record<string, unknown>) {
    const doc = ipc.document({});
    return { ...doc, value: { ...doc.value, following } };
  }
  const following = {
    feel: 'calm',
    motionProfileId: 'default-v4',
    developerDiagnostics: true,
  };

  it('loads every other following setting exactly as a document without them', async () => {
    ipc.serve(withFollowing(following));
    const without = await settings.getSettings();

    ipc.serve(
      withFollowing({ ...following, fidelityMode: 'exact', semanticRequestLimit: 40 }),
    );
    const loaded = await settings.getSettings();
    expect(loaded).toStrictEqual(without);
    expect(Object.hasOwn(loaded.following, 'fidelityMode')).toBe(false);
    expect(Object.hasOwn(loaded.following, 'semanticRequestLimit')).toBe(false);
    expect(loaded.following.feel).toBe('calm');
    expect(loaded.following.developerDiagnostics).toBe(true);
  });

  it('a whole-section following save sends neither back', async () => {
    ipc.serve(
      withFollowing({ ...following, fidelityMode: 'exact', semanticRequestLimit: 40 }),
    );
    const loaded = await settings.getSettings();
    await settings.updateSettings(4, { following: { ...loaded.following, feel: 'responsive' } });

    const update = ipc.calls.find((call) => call.command === 'update_settings');
    expect((update!.args as { patch: Record<string, unknown> }).patch).toEqual({
      following: {
        feel: 'responsive',
        motionProfileId: loaded.following.motionProfileId,
        developerDiagnostics: true,
      },
    });
  });
});

/*
 * #219 — the twenty fields nothing read, gone from Rust and from the twin.
 *
 * The fixture is the one the Rust tests load through the real struct, the real
 * row and a real export: a document carrying every removed key, with every
 * surviving value moved off its default. Here it goes through the real service,
 * which must read it exactly as the same document without those keys, and must
 * not send any of them back on a save of every section that has a Rust home.
 */
describe('#219 a document that still carries every field nothing read', () => {
  const served = () => ({ revision: 9, value: structuredClone(retiredDocument.document) });
  const carries = (document: Record<string, unknown>, path: string): boolean => {
    const [section, field] = path.split('.');
    const value = document[section!];
    if (field === undefined) return value !== undefined;
    return typeof value === 'object' && value !== null && Object.hasOwn(value, field);
  };
  function withoutRetired() {
    const doc = served();
    const value = doc.value as Record<string, Record<string, unknown>>;
    for (const path of retiredDocument.retired) {
      const [section, field] = path.split('.');
      expect(carries(value, path), `the fixture must carry ${path}`).toBe(true);
      if (field === undefined) delete value[section!];
      else delete value[section!]![field];
    }
    return doc;
  }

  it('loads every surviving setting exactly as a document without them does', async () => {
    ipc.serve(withoutRetired() as never);
    const without = await settings.getSettings();

    ipc.serve(served() as never);
    const loaded = await settings.getSettings();
    expect(loaded).toStrictEqual(without);
    // And the survivors really arrived, so the comparison above is not two
    // copies of `defaultAppSettings()`.
    expect(loaded.revision).toBe(9);
    expect(loaded.general.launchBehavior).toBe('recent');
    expect(loaded.general.defaultSessionMode).toBe('fixed');
    expect(loaded.teleprompter.fixedSpeedWpm).toBe(172);
    expect(loaded.audio.vadSensitivity).toBe(0.72);
    expect(loaded.following.feel).toBe('calm');
    expect(loaded.following.developerDiagnostics).toBe(true);
    expect(loaded.speech.language).toBe('en-GB');
    expect(loaded.stage.presentationMode).toBe('reader');
    expect(loaded.stage.readerFrame).toEqual({ x: 120, y: 90, width: 860, height: 600 });
    expect(loaded.stage.displayFingerprint).toBe('dsp-glass');
    // The calibration itself, not just its key — and the persisted mirror, which
    // sets an axis the old global switch could never have rebuilt.
    expect(Object.keys(loaded.optical.profiles)).toEqual(['dsp-glass::Glass%20rig']);
    expect(loaded.optical.profiles['dsp-glass::Glass%20rig']).toMatchObject({
      viewingDistanceMm: 900,
      bias: 0.55,
    });
    expect(loaded.optical.activeRig).toEqual({ 'dsp-glass': 'Glass rig' });
    expect(loaded.optical.panelMirror['dsp-glass']).toEqual({ horizontal: true, vertical: true });
  });

  it('is adopted from a broadcast exactly as the same document without them', () => {
    const adopted = settings.adaptRevisionedSettings(served());
    expect(adopted).toStrictEqual(settings.adaptRevisionedSettings(withoutRetired()));
    expect(adopted?.revision).toBe(9);
    expect(adopted?.teleprompter.fixedSpeedWpm).toBe(172);
  });

  it('a save of every Rust-backed section sends what survives and none of them', async () => {
    ipc.serve(served() as never);
    const loaded = await settings.getSettings();
    // Whole sections, as `sendPatchBatch` sends them. Not `speech`: the
    // language goes through `select_speech_language`, and `update_settings`
    // refuses a patch that names it.
    await settings.updateSettings(9, {
      general: loaded.general,
      audio: loaded.audio,
      stage: loaded.stage,
      teleprompter: { ...loaded.teleprompter, fixedSpeedWpm: 150 },
      following: loaded.following,
      optical: loaded.optical,
    });

    const update = ipc.calls.find((call) => call.command === 'update_settings');
    const patch = (update!.args as { patch: Record<string, unknown> }).patch;
    // Every section with a Rust home reached it, so the loop below is not
    // passing over a patch that sent nothing.
    expect(Object.keys(patch).sort()).toEqual([
      'audio',
      'following',
      'general',
      'optical',
      'stageBehavior',
    ]);
    expect(patch).toMatchObject({
      general: { openTo: 'last_script' },
      audio: { vadSensitivity: 0.72 },
      stageBehavior: {
        promptMode: 'fixed',
        fixedSpeedWpm: 150,
        presentationMode: 'reader',
        displayFingerprint: 'dsp-glass',
      },
      following: { feel: 'calm', developerDiagnostics: true },
      optical: { activeRig: { 'dsp-glass': 'Glass rig' } },
    });
    for (const path of retiredDocument.retired) {
      expect(carries(patch, path), `${path} must not be sent`).toBe(false);
    }
  });
});
