/**
 * #215 — the retired transcript retention window must not cost anybody their
 * other settings.
 *
 * Every settings document on disk still carries `general.saveTranscript` (Rust
 * keeps the field until #217), and a localStorage overlay written by an older
 * build can still hold `privacy.saveTranscript`. Neither is read any more, and
 * both have to be tolerated the way the retired `updateCheck` key is: the rest
 * of the document loads exactly as it would without them, and nothing this
 * side of the boundary writes the field back.
 *
 * These drive the real service against a fake `ipcInvoke` and a real
 * (in-memory) localStorage, so the overlay code path actually runs — without
 * one the service short-circuits on `typeof localStorage === 'undefined'` and
 * the overlay tests would pass for the wrong reason.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ipc = vi.hoisted(() => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const document = (general: Record<string, unknown>) => ({
    revision: 4,
    value: {
      schemaVersion: 1,
      general: {
        openTo: 'last_script',
        autosaveDebounceMs: 800,
        revisionIntervalMinutes: 10,
        wordsPerMinuteEstimate: 150,
        analyticsEnabled: false,
        ...general,
      },
      editor: {},
      stageBehavior: {
        promptMode: 'fixed',
        manualWheelMultiplier: 1,
        fixedSpeedWpm: 172,
        pointerHideDelaySeconds: 0,
        manualMoveTrackingGraceSeconds: 2,
        stageAcknowledgement: 'flash',
        horizontalMirror: false,
        keepScreenAwake: true,
        blankColor: '#000000',
      },
      audio: {
        transcriptionModel: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05',
        language: 'en',
        delayProfile: 'low',
        softPauseAutoDisconnectMinutes: 10,
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
    expect(without.teleprompter.hidePointer).toBe(false);
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
