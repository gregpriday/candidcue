/**
 * Finishing the presentation mode's move out of localStorage.
 *
 * Reading the old overlay as a fallback is only half a migration, and the
 * missing half is the half the move was FOR: a reader who upgrades and never
 * opens the split menu leaves Rust holding nothing, so the day their browser
 * store is cleared they are silently back to prompter — the exact failure the
 * move was made to end.
 *
 * These run the REAL service and the REAL store against a fake Rust document
 * that applies patches the way `merge_json` does, so the round trip is the one
 * that ships rather than a mock agreeing with itself.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ipc = vi.hoisted(() => {
  const emptyDocument = () => ({
    revision: 3,
    value: {
      schemaVersion: 1,
      general: {
        openTo: 'library',
      },
      stageBehavior: {
        promptMode: 'voice',
        fixedSpeedWpm: 140,
        horizontalMirror: false,
      },
      audio: {
        transcriptionModel: 'x-asr',
        language: 'en-US',
        vadSensitivity: 0.5,
      },
    } as Record<string, unknown>,
  });

  let document = emptyDocument();

  /** `merge_json`: objects merge key-by-key, a null REMOVES the key. */
  const merge = (base: Record<string, unknown>, patch: Record<string, unknown>): void => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) {
        delete base[key];
      } else if (
        typeof value === 'object' &&
        !Array.isArray(value) &&
        typeof base[key] === 'object' &&
        base[key] !== null &&
        !Array.isArray(base[key])
      ) {
        merge(base[key] as Record<string, unknown>, value as Record<string, unknown>);
      } else {
        base[key] = value;
      }
    }
  };

  return {
    reset(): void {
      document = emptyDocument();
    },
    stageBehavior: () => document.value['stageBehavior'] as Record<string, unknown>,
    /** A fresh copy of the un-migrated document, for ordering tests. */
    documentValue: () => JSON.parse(JSON.stringify(emptyDocument().value)) as Record<string, unknown>,
    invoke: async (command: string, args?: unknown) => {
      if (command === 'update_settings') {
        const { expectedRevision, patch } = args as {
          expectedRevision: number;
          patch: Record<string, unknown>;
        };
        if (expectedRevision !== document.revision) throw new Error('revision conflict');
        merge(document.value, patch);
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

const OVERLAY_KEY = 'candidcue.settings-overlay.v1';
const settingsStore = await import('../../../src/control/stores/settings');
const settingsService = await import('../../../src/control/services/settings');

beforeEach(() => {
  ipc.reset();
  store.clear();
  /* The migration runs once per session and the store is one module for the
     whole file — without this, every case after the first would be skipped and
     pass having asserted nothing. */
  settingsStore.resetMigrationLatchesForTesting();
});

describe('the mode is carried into Rust, not merely read out of the overlay', () => {
  it('writes an upgrading reader through on the first load', async () => {
    store.set(OVERLAY_KEY, JSON.stringify({ stage: { presentationMode: 'reader' } }));

    const loaded = await settingsStore.loadSettings(true);
    expect(loaded.stage.presentationMode).toBe('reader');
    // The point: the persisted document now holds it too.
    expect(ipc.stageBehavior()['presentationMode']).toBe('reader');
  });

  it('survives the browser store being cleared afterwards', async () => {
    /*
     * The whole reason for the move. Before the adoption existed this returned
     * 'prompter' and the reader had to rediscover their own preference.
     */
    store.set(OVERLAY_KEY, JSON.stringify({ stage: { presentationMode: 'reader' } }));
    await settingsStore.loadSettings(true);

    store.clear();
    const reloaded = await settingsStore.loadSettings(true);
    expect(reloaded.stage.presentationMode).toBe('reader');
  });

  it('carries the retired "Full screen" boolean across too', async () => {
    store.set(OVERLAY_KEY, JSON.stringify({ stage: { fullscreen: false } }));
    await settingsStore.loadSettings(true);
    expect(ipc.stageBehavior()['presentationMode']).toBe('reader');
  });

  it('writes nothing when there was never a local preference to carry', async () => {
    /*
     * A fresh install must stay "unchosen". Pinning 'prompter' on first launch
     * would collapse the distinction the nullable Rust field exists to hold, and
     * the next build that wanted to change the default could not tell somebody
     * who chose prompter from somebody who simply never looked.
     */
    const loaded = await settingsStore.loadSettings(true);
    expect(loaded.stage.presentationMode).toBe('prompter');
    expect(ipc.stageBehavior()['presentationMode']).toBeUndefined();
  });

  it('does not re-adopt over a choice the document already holds', async () => {
    // A stale overlay must never win over what was actually persisted.
    store.set(OVERLAY_KEY, JSON.stringify({ stage: { presentationMode: 'reader' } }));
    await settingsStore.loadSettings(true);
    await settingsStore.patchSettings('stage', { presentationMode: 'prompter' });

    const reloaded = await settingsStore.loadSettings(true);
    expect(reloaded.stage.presentationMode).toBe('prompter');
    expect(ipc.stageBehavior()['presentationMode']).toBe('prompter');
  });

  it('scrubs the retired keys out of the overlay once they are Rust-owned', async () => {
    /*
     * The stale copy is not inert: the migration fallback reads exactly these
     * keys whenever Rust has no answer, so one left behind could bring a dead
     * choice back. The pin went the same way once it moved to Rust (#272).
     */
    store.set(
      OVERLAY_KEY,
      JSON.stringify({ stage: { presentationMode: 'reader', fullscreen: false } }),
    );
    await settingsStore.loadSettings(true);
    await settingsStore.patchSettings('stage', { displayFingerprint: 'panel-1' });

    const overlay = JSON.parse(store.get(OVERLAY_KEY) ?? '{}') as {
      stage?: Record<string, unknown>;
    };
    expect(overlay.stage).not.toHaveProperty('presentationMode');
    expect(overlay.stage).not.toHaveProperty('fullscreen');
    expect(overlay.stage).not.toHaveProperty('readerFrame');
    expect(overlay.stage).not.toHaveProperty('displayFingerprint');
    expect(ipc.stageBehavior()['displayFingerprint']).toBe('panel-1');
  });
});

/**
 * The migration must not run TWICE because two windows disagreed about when.
 *
 * ---------------------------------------------------------------------------
 * THE ORDERING THAT MAKES THIS POSSIBLE
 * ---------------------------------------------------------------------------
 * `pendingStageModeAdoption` reports what the LAST PARSED document showed, and
 * documents do not arrive in the order they were produced. Settings is its own
 * window now, so the other one can perform this migration while a read started
 * here is still in flight — and that read then parses a document from before
 * the write and puts the flag back to "pending". The migration runs a second
 * time: not destructive, because it writes what is already there, but a
 * settings revision nobody asked for, broadcast to both windows, for work that
 * was already done.
 *
 * What closes it is that the latch reads RUST'S OWN FIELD rather than this
 * window having performed the write — so a document adopted from the other
 * window's broadcast closes it exactly as a local write does — and that it only
 * ever moves one way, which is what makes it immune to the order.
 *
 * Asserted through `adaptRevisionedSettings`, which is the function
 * `adoptSettings` parses a broadcast with and the same one every read goes
 * through. That is the seam where the flag is written, so it is the seam where
 * the ordering can be stated.
 */
describe('a migration another window already performed', () => {
  /** A document in which Rust does NOT hold the mode — the pre-migration one. */
  function unmigrated(): unknown {
    return { revision: 3, value: ipc.documentValue() };
  }

  /** The same document after somebody migrated it. */
  function migrated(): unknown {
    const value = ipc.documentValue() as Record<string, unknown>;
    return {
      revision: 4,
      value: {
        ...value,
        stageBehavior: {
          ...(value['stageBehavior'] as Record<string, unknown>),
          presentationMode: 'reader',
        },
      },
    };
  }

  it('is not run again when a stale read arrives after it', () => {
    store.set(OVERLAY_KEY, JSON.stringify({ stage: { presentationMode: 'reader' } }));

    // Before anything: the overlay states a mode Rust does not hold, so the
    // migration is genuinely pending. Without this the test proves nothing.
    settingsService.adaptRevisionedSettings(unmigrated());
    expect(settingsService.pendingStageModeAdoption()).toBe('reader');

    // The other window migrates; Rust broadcasts; this window adopts.
    settingsService.adaptRevisionedSettings(migrated());
    expect(settingsService.pendingStageModeAdoption()).toBeNull();

    /*
     * And NOW the read that began before all of that finally answers, holding
     * the document as it was. It must not revive the migration.
     */
    settingsService.adaptRevisionedSettings(unmigrated());
    expect(settingsService.pendingStageModeAdoption()).toBeNull();
  });

  it('still runs when no document has ever shown Rust holding it', () => {
    // Anti-vacuity for the latch: it must not simply refuse for ever.
    store.set(OVERLAY_KEY, JSON.stringify({ stage: { presentationMode: 'reader' } }));
    settingsService.adaptRevisionedSettings(unmigrated());
    settingsService.adaptRevisionedSettings(unmigrated());
    expect(settingsService.pendingStageModeAdoption()).toBe('reader');
  });
});
