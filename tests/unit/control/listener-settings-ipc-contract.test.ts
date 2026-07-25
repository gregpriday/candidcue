/**
 * §37 Listener settings — the TypeScript half of the round trip.
 *
 * Reads the same fixture as `src-tauri/tests/ipc_contract_tests.rs`
 * (`tests/fixtures/ipc/listener-settings-payload.json`), the pattern the §30
 * coaching settings established, and for a sharper reason: this feature had two
 * settings structures for one thing. Rust declared a typed `ListenerSettings`
 * that TypeScript read as an opaque bag and never mapped, while the UI kept a
 * separate `listeners` section in a localStorage overlay whose fields nothing
 * read. Both halves passed their own tests. Neither could see the other.
 *
 * The service-level tests at the bottom drive the REAL `getSettings` /
 * `updateSettings` against a fake `ipcInvoke` that merges the patch the way
 * Rust's `merge_json` does, with `isTauriRuntime` mocked to `true` — so
 * `mock-backend.ts` is never consulted and every assertion is a statement about
 * the adapter rather than about the mock.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clampListenerSettings,
  defaultListenerSettings,
  listenerFromRust,
  listenerToRustPatch,
  type RustListenerSettings,
} from '../../../src/control/services/settings-listener';
import type { ListenerSettings } from '../../../src/control/services/settings-types';

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../fixtures/ipc/listener-settings-payload.json', import.meta.url)),
    'utf8',
  ),
) as {
  settings: RustListenerSettings;
  clearPatch: { input: Record<string, unknown>; expected: Record<string, unknown> };
  outOfRange: { input: Record<string, unknown>; expected: Record<string, unknown> };
};

describe('§37 listener settings adapter', () => {
  it('reads the Rust document into the UI view with every value intact', () => {
    expect(listenerFromRust(fixture.settings)).toEqual(fixture.settings as ListenerSettings);
  });

  it('emits exactly the document Rust reads, for a whole-section write', () => {
    expect(listenerToRustPatch(listenerFromRust(fixture.settings))).toEqual(fixture.settings);
  });

  it('round-trips: UI → patch → document → UI is the identity', () => {
    const ui = listenerFromRust(fixture.settings);
    const patch = listenerToRustPatch(ui);
    expect(listenerFromRust(patch as Partial<RustListenerSettings>)).toEqual(ui);
  });

  /*
   * The mutation check, written down. Every field is named individually so a
   * dropped mapping fails with the field's name rather than as an object
   * mismatch, and so no key can quietly leave the contract.
   */
  it('maps every field of the contract, named one by one', () => {
    const patch = listenerToRustPatch(listenerFromRust(fixture.settings));
    const expectedKeys: Array<keyof RustListenerSettings> = [
      'defaultPackId',
      'autoplay',
      'dimPercent',
      'blurPx',
      'saturation',
      'keepWhenBlanked',
    ];
    expect(Object.keys(patch).sort()).toEqual([...expectedKeys].sort());
    for (const key of expectedKeys) {
      expect(patch[key], `${key} must survive the mapping`).toEqual(fixture.settings[key]);
    }
  });

  it('has no field the old structures had and nothing can set', () => {
    // scale / crossfadeMs / softPause / hardPause / hideOnBlank were declared in
    // Rust and unreachable from anywhere. They are gone, not renamed.
    const patch = listenerToRustPatch(listenerFromRust(fixture.settings));
    for (const dead of ['scale', 'crossfadeMs', 'softPause', 'hardPause', 'hideOnBlank', 'opacityAfterDim']) {
      expect(dead in patch, `${dead} must not come back`).toBe(false);
    }
  });

  it('sends null to forget the remembered pack, rather than omitting the key', () => {
    const patch = listenerToRustPatch(fixture.clearPatch.input as Partial<ListenerSettings>);
    expect(patch).toEqual(fixture.clearPatch.expected);
    expect('defaultPackId' in patch).toBe(true);
  });

  it('emits only the keys the patch carried, so a concurrent write is not clobbered', () => {
    expect(listenerToRustPatch({ dimPercent: 12 })).toEqual({ dimPercent: 12 });
    expect(listenerToRustPatch({})).toEqual({});
    expect(listenerToRustPatch(undefined)).toEqual({});
  });

  it('falls back to defaults for a document written before the section existed', () => {
    expect(listenerFromRust(undefined)).toEqual(defaultListenerSettings());
    expect(listenerFromRust({})).toEqual(defaultListenerSettings());
  });

  it('clamps a value Rust would refuse rather than throwing it at a CSS filter', () => {
    const clamped = clampListenerSettings(fixture.outOfRange.input as Partial<ListenerSettings>);
    for (const [key, value] of Object.entries(fixture.outOfRange.expected)) {
      expect(clamped[key as keyof ListenerSettings], key).toBe(value);
    }
  });

  it('treats a blank or missing pack id as "no remembered pack"', () => {
    expect(clampListenerSettings({ defaultPackId: '   ' }).defaultPackId).toBeNull();
    expect(listenerFromRust({ ...fixture.settings, defaultPackId: null }).defaultPackId).toBeNull();
  });

  it('never lets a malformed number reach the stage', () => {
    const ui = listenerFromRust({
      dimPercent: Number.NaN,
      blurPx: Number.POSITIVE_INFINITY,
      saturation: 'plenty' as unknown as number,
    });
    expect(Number.isFinite(ui.dimPercent)).toBe(true);
    expect(Number.isFinite(ui.blurPx)).toBe(true);
    expect(Number.isFinite(ui.saturation)).toBe(true);
  });

  it('keeps the shipped look as the default, so reconciling changed nothing visible', () => {
    // The stage hard-coded `saturation: 0.85` while Rust declared 0.55. The
    // setting adopts the value users actually saw.
    expect(defaultListenerSettings().saturation).toBe(0.85);
    expect(defaultListenerSettings().dimPercent).toBe(40);
  });
});

/* ---------------------------------------------------------------------------
 * The service, against a fake backend that merges the way Rust merges
 * ------------------------------------------------------------------------- */

const ipc = vi.hoisted(() => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const base = {
    revision: 3,
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
    get listener(): Record<string, unknown> | undefined {
      return document.value.listener as Record<string, unknown> | undefined;
    },
    invoke: async (command: string, args?: unknown) => {
      calls.push({ command, args });
      if (command === 'update_settings') {
        const { patch } = args as { patch: Record<string, Record<string, unknown>> };
        // Rust's `merge_json`: objects merge key by key, null REMOVES the key.
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

const settings = await import('../../../src/control/services/settings');

beforeEach(() => {
  ipc.reset();
  localStore.clear();
});

describe('§37 listener settings through the real settings service', () => {
  it('a value set in the UI survives the write and the next read', async () => {
    const before = await settings.getSettings();
    expect(before.listeners).toEqual(defaultListenerSettings());

    const wanted = listenerFromRust(fixture.settings);
    const saved = await settings.updateSettings(before.revision, { listeners: wanted });

    // The write reached Rust, not only the local overlay. This is the exact
    // assertion the old code could not have passed: it had no `listener` arm in
    // `toRustPatch` at all, so a Listener setting never left the browser.
    const update = ipc.calls.find((c) => c.command === 'update_settings');
    expect(update, 'a listener change must be persisted, not overlaid').toBeDefined();
    expect((update!.args as { patch: Record<string, unknown> }).patch).toEqual({
      listener: fixture.settings,
    });

    expect(saved.listeners).toEqual(wanted);
    expect((await settings.getSettings()).listeners).toEqual(wanted);
  });

  it('never writes a listener value into the localStorage overlay', async () => {
    const before = await settings.getSettings();
    await settings.updateSettings(before.revision, {
      listeners: { ...before.listeners, dimPercent: 70 },
    });
    const overlay = JSON.parse(localStore.get('candidcue.settings-overlay.v1') ?? '{}');
    expect(overlay.listeners, 'the overlay copy is what made this section unreadable').toBeUndefined();
  });

  it('follows Rust rather than a stale overlay when the two disagree', async () => {
    // Simulate an install that still carries the pre-reconciliation overlay.
    localStore.set(
      'candidcue.settings-overlay.v1',
      JSON.stringify({ listeners: { dimPercent: 5, autoplay: false, saturation: 0.1 } }),
    );
    const loaded = await settings.getSettings();
    expect(loaded.listeners).toEqual(defaultListenerSettings());
  });

  it('forgets the remembered pack end to end (null removes the key, default refills it)', async () => {
    const first = await settings.getSettings();
    const remembered = await settings.updateSettings(first.revision, {
      listeners: { ...first.listeners, defaultPackId: 'mira' },
    });
    expect(remembered.listeners.defaultPackId).toBe('mira');
    expect(ipc.listener?.defaultPackId).toBe('mira');

    const cleared = await settings.updateSettings(remembered.revision, {
      listeners: { ...remembered.listeners, defaultPackId: null },
    });
    expect(cleared.listeners.defaultPackId).toBeNull();
    expect(ipc.listener?.defaultPackId).toBeUndefined();
  });

  it('reads a document written before the section had these fields', async () => {
    // `listener: {}` is what an existing install carries.
    const loaded = await settings.getSettings();
    expect(loaded.listeners).toEqual(defaultListenerSettings());
  });
});
