/**
 * C11: `general.saveTranscript` — the one setting that decides whether spoken
 * words are written to disk — had no mapping in EITHER direction of
 * `services/settings.ts`. Rust validated it, `start_session` read it, and the
 * UI could neither see it nor change it.
 *
 * These drive the real service against a fake `ipcInvoke`, so a regression in
 * either half of the adapter fails here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ipc = vi.hoisted(() => {
  const calls: Array<{ command: string; args: unknown }> = [];
  let document = {
    revision: 4,
    value: {
      schemaVersion: 1,
      general: {
        openTo: 'library',
        autosaveDebounceMs: 800,
        revisionIntervalMinutes: 10,
        wordsPerMinuteEstimate: 150,
        analyticsEnabled: false,
        saveTranscript: 'off',
      },
      editor: {},
      stageBehavior: {
        promptMode: 'voice',
        manualWheelMultiplier: 1,
        fixedSpeedWpm: 140,
        pointerHideDelaySeconds: 1.5,
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
  };
  return {
    calls,
    setRetention(value: string): void {
      document = {
        ...document,
        value: { ...document.value, general: { ...document.value.general, saveTranscript: value } },
      };
    },
    invoke: async (command: string, args?: unknown) => {
      ipc.calls.push({ command, args });
      return document;
    },
  };
});

vi.mock('../../../src/control/services/ipc', () => ({
  isTauriRuntime: () => true,
  BackendUnavailableError: class extends Error {},
  ipcInvoke: ipc.invoke,
}));

/**
 * A real (in-memory) localStorage, so the overlay code path actually runs.
 * Without one the service short-circuits on `typeof localStorage === 'undefined'`
 * and the "the overlay must not contradict Rust" test would pass for the wrong
 * reason.
 */
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

beforeEach(() => {
  ipc.calls.length = 0;
  ipc.setRetention('off');
  store.clear();
});

describe('§36.2 transcript retention is readable and writable', () => {
  it('reads the Rust value into the UI settings view', async () => {
    ipc.setRetention('7d');
    const loaded = await settings.getSettings();
    expect(loaded.privacy.saveTranscript).toBe('7d');
  });

  it('defaults to off, which is the safe side of a privacy setting', async () => {
    const loaded = await settings.getSettings();
    expect(loaded.privacy.saveTranscript).toBe('off');
  });

  it('writes the change back to general.saveTranscript', async () => {
    await settings.updateSettings(4, { privacy: { saveTranscript: '30d' } as never });
    const update = ipc.calls.find((c) => c.command === 'update_settings');
    expect(update, 'the change must reach Rust, not only the local overlay').toBeDefined();
    expect((update!.args as { patch: Record<string, unknown> }).patch).toEqual({
      general: { saveTranscript: '30d' },
    });
  });

  it('never lets the local overlay contradict the persisted document', async () => {
    // Turn it on, then have Rust report it off (another window, or a failed
    // write). The UI must follow Rust, not a cached copy of its own optimism.
    await settings.updateSettings(4, { privacy: { saveTranscript: 'forever' } as never });
    ipc.setRetention('off');
    const reloaded = await settings.getSettings();
    expect(reloaded.privacy.saveTranscript).toBe('off');
  });

  it('treats an unrecognised persisted value as off', async () => {
    ipc.setRetention('someday');
    const loaded = await settings.getSettings();
    expect(loaded.privacy.saveTranscript).toBe('off');
  });
});
