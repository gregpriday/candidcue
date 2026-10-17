/**
 * The pinned prompter display's move out of localStorage (#272).
 *
 * Present moves the control window onto the pinned panel, so a pin lost to a
 * cleared browser store does not show up as a wrong setting — it shows up as
 * the next take filling the desk monitor, borderless and above everything. The
 * pin now lives in the Rust document, and an existing overlay pin is adopted
 * once.
 *
 * These run the REAL service and the REAL store against a fake Rust document
 * that applies patches the way `merge_json` does — including removing a key
 * whose patch value is null, which is exactly why "unpinned" needs the
 * `displayPinMigrated` flag to stay tellable from "never moved".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ipc = vi.hoisted(() => {
  const emptyDocument = () => ({
    revision: 3,
    value: {
      schemaVersion: 1,
      general: {
        openTo: 'library',
        autosaveDebounceMs: 800,
        revisionIntervalMinutes: 10,
        wordsPerMinuteEstimate: 150,
        analyticsEnabled: false,
      },
      editor: {},
      stageBehavior: {
        promptMode: 'voice',
        manualWheelMultiplier: 1,
        fixedSpeedWpm: 140,
        pointerHideDelaySeconds: 1.5,
        manualMoveTrackingGraceSeconds: 2,
        stageAcknowledgement: 'subtle',
        horizontalMirror: false,
        keepScreenAwake: true,
        blankColor: '#000000',
      } as Record<string, unknown>,
      audio: {
        transcriptionModel: 'x-asr',
        language: 'en-US',
        softPauseAutoDisconnectMinutes: 10,
        vadSensitivity: 0.5,
      },
    } as Record<string, unknown>,
  });

  let document = emptyDocument();
  let updates = 0;
  let failUpdates = 0;
  /** A write whose ANSWER is held back, to reorder it against a broadcast. */
  let held: { reached: () => void; gate: Promise<void> } | null = null;

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
      updates = 0;
      failUpdates = 0;
      held = null;
    },
    /**
     * Commit the next write at once but hold its answer until `release`.
     * `reached` settles when the write has landed.
     */
    holdNextUpdate(): { reached: Promise<void>; release: () => void } {
      let release!: () => void;
      let reached!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const landed = new Promise<void>((resolve) => (reached = resolve));
      held = { reached, gate };
      return { reached: landed, release };
    },
    /** Another window's save: applied to the document, returned as its broadcast. */
    otherWindowWrites(patch: Record<string, unknown>): unknown {
      merge(document.value, patch);
      document.revision += 1;
      return structuredClone(document);
    },
    stageBehavior: () => document.value['stageBehavior'] as Record<string, unknown>,
    /** How many `update_settings` calls reached the document. */
    updates: () => updates,
    /** Refuse the next `count` writes, the way a database that went away would. */
    failNextUpdates(count: number): void {
      failUpdates = count;
    },
    invoke: async (command: string, args?: unknown) => {
      if (command === 'update_settings') {
        if (failUpdates > 0) {
          failUpdates -= 1;
          throw new Error('database unavailable');
        }
        const { expectedRevision, patch } = args as {
          expectedRevision: number;
          patch: Record<string, unknown>;
        };
        if (expectedRevision !== document.revision) throw new Error('revision conflict');
        merge(document.value, patch);
        document.revision += 1;
        updates += 1;
        if (held !== null) {
          // The answer is the document as THIS write left it, however late it
          // arrives.
          const answer = structuredClone(document);
          const { reached, gate } = held;
          held = null;
          reached();
          await gate;
          return answer;
        }
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

function seedOverlay(stage: Record<string, unknown>): void {
  store.set(OVERLAY_KEY, JSON.stringify({ stage }));
}

function overlayStage(): Record<string, unknown> {
  const overlay = JSON.parse(store.get(OVERLAY_KEY) ?? '{}') as {
    stage?: Record<string, unknown>;
  };
  return overlay.stage ?? {};
}

beforeEach(() => {
  ipc.reset();
  store.clear();
  /* The latch is module state and only moves one way — without this, every
     case after the first would skip the migration and pass having asserted
     nothing. */
  settingsStore.resetMigrationLatchesForTesting();
});

describe('an upgrader keeps the pin they already had', () => {
  it('writes the overlay pin through on the first load, ownership and all', async () => {
    seedOverlay({ displayFingerprint: 'dsp-glass' });

    const loaded = await settingsStore.loadSettings(true);

    expect(loaded.stage.displayFingerprint).toBe('dsp-glass');
    expect(ipc.stageBehavior()['displayFingerprint']).toBe('dsp-glass');
    expect(ipc.stageBehavior()['displayPinMigrated']).toBe(true);
    // And the overlay copy is gone, so nothing is left to contradict it.
    expect(overlayStage()).not.toHaveProperty('displayFingerprint');
  });

  it('survives the browser store being cleared afterwards', async () => {
    /*
     * The whole of the issue. Before the move this returned null, and the next
     * Present filled the monitor the window happened to be on.
     */
    seedOverlay({ displayFingerprint: 'dsp-glass' });
    await settingsStore.loadSettings(true);

    store.clear();
    settingsStore.resetMigrationLatchesForTesting();
    const reloaded = await settingsStore.loadSettings(true);

    expect(reloaded.stage.displayFingerprint).toBe('dsp-glass');
  });

  it('moves the pin in the same write as the mode when both are waiting', async () => {
    // The mode's adoption writes the whole stage section, so it carries the
    // pin too and leaves nothing for a second write to do.
    seedOverlay({ presentationMode: 'reader', displayFingerprint: 'dsp-glass' });

    const loaded = await settingsStore.loadSettings(true);

    expect(ipc.updates()).toBe(1);
    expect(loaded.stage.presentationMode).toBe('reader');
    expect(ipc.stageBehavior()['presentationMode']).toBe('reader');
    expect(ipc.stageBehavior()['displayFingerprint']).toBe('dsp-glass');
  });

  it('writes nothing when there is no pin to move', async () => {
    await settingsStore.loadSettings(true);
    expect(ipc.updates()).toBe(0);
    expect(ipc.stageBehavior()).not.toHaveProperty('displayPinMigrated');
  });

  it('keeps the fallback when the write fails, and moves the pin on the next launch', async () => {
    seedOverlay({ displayFingerprint: 'dsp-glass' });
    ipc.failNextUpdates(1);

    const first = await settingsStore.loadSettings(true);
    // Takes still open on the glass in the meantime...
    expect(first.stage.displayFingerprint).toBe('dsp-glass');
    // ...because the only copy was left where it was.
    expect(overlayStage()['displayFingerprint']).toBe('dsp-glass');
    expect(ipc.stageBehavior()).not.toHaveProperty('displayFingerprint');

    await settingsStore.loadSettings(true);
    expect(ipc.stageBehavior()['displayFingerprint']).toBe('dsp-glass');
  });
});

describe('the document is the answer once it owns the pin', () => {
  it('wins over a different overlay pin, and writes nothing', async () => {
    seedOverlay({ displayFingerprint: 'dsp-old-desk' });
    Object.assign(ipc.stageBehavior(), {
      displayFingerprint: 'dsp-glass',
      displayPinMigrated: true,
    });

    const loaded = await settingsStore.loadSettings(true);

    expect(loaded.stage.displayFingerprint).toBe('dsp-glass');
    expect(ipc.updates()).toBe(0);
  });

  it('keeps an unpin across a reload, even when a stale overlay copy survived', async () => {
    /*
     * `merge_json` turns the unpin's null into an absent key, so without the
     * flag this document would look exactly like one from before the move —
     * and a stale copy left behind by a failed local write would be read
     * straight back and adopted.
     */
    seedOverlay({ displayFingerprint: 'dsp-glass' });
    await settingsStore.loadSettings(true);
    await settingsStore.patchSettings('stage', { displayFingerprint: null });
    expect(ipc.stageBehavior()).not.toHaveProperty('displayFingerprint');
    expect(ipc.stageBehavior()['displayPinMigrated']).toBe(true);

    // The local write that should have dropped it never happened.
    seedOverlay({ displayFingerprint: 'dsp-glass' });
    settingsStore.resetMigrationLatchesForTesting();
    const writesBefore = ipc.updates();
    const reloaded = await settingsStore.loadSettings(true);

    expect(reloaded.stage.displayFingerprint).toBeNull();
    expect(ipc.updates()).toBe(writesBefore);
  });

  it('takes a pin the document holds as ownership, with or without the flag', async () => {
    // A document written by hand, or by an older shape of this field: Rust
    // holding a value is answer enough, and the overlay's different pin is not
    // adopted over it.
    seedOverlay({ displayFingerprint: 'dsp-old-desk' });
    Object.assign(ipc.stageBehavior(), { displayFingerprint: 'dsp-glass' });

    const loaded = await settingsStore.loadSettings(true);

    expect(loaded.stage.displayFingerprint).toBe('dsp-glass');
    expect(ipc.updates()).toBe(0);
  });

  it('never falls back to the overlay for a stale document read after an owned one', async () => {
    /*
     * Documents do not arrive in the order they were produced. Once this window
     * has seen Rust own the pin, a read that began before the adoption and lands
     * after it must not put the overlay's answer back — not on screen, and not
     * as a second adoption.
     */
    const settingsService = await import('../../../src/control/services/settings');
    const stale = structuredClone(await ipc.invoke('get_settings'));
    Object.assign(ipc.stageBehavior(), { displayPinMigrated: true });
    const owned = structuredClone(await ipc.invoke('get_settings'));
    seedOverlay({ displayFingerprint: 'dsp-old-desk' });

    expect(settingsService.adaptRevisionedSettings(owned)?.stage.displayFingerprint).toBeNull();
    expect(settingsService.adaptRevisionedSettings(stale)?.stage.displayFingerprint).toBeNull();
    expect(settingsService.pendingDisplayPinAdoption()).toBeNull();
  });

  it('does not let an older adoption answer put back a pin another window removed', async () => {
    /*
     * The mode's adoption carries the whole stage section, pin included. If the
     * other window unpins while that write is in flight and its broadcast lands
     * first, adopting the older answer would show the pin again — and the next
     * save would send it back to Rust.
     */
    seedOverlay({ presentationMode: 'reader', displayFingerprint: 'dsp-glass' });
    const held = ipc.holdNextUpdate();

    const loading = settingsStore.loadSettings(true);
    await held.reached;
    const newer = ipc.otherWindowWrites({
      stageBehavior: { displayFingerprint: null, displayPinMigrated: true },
    });
    expect(settingsStore.adoptSettings(newer)).toBe(true);
    held.release();
    const loaded = await loading;

    expect(loaded.stage.displayFingerprint).toBeNull();
    expect(settingsStore.getSettingsSnapshot().stage.displayFingerprint).toBeNull();
  });

  it("takes another window's unpin as the answer, never having seen the pin itself", async () => {
    Object.assign(ipc.stageBehavior(), { displayPinMigrated: true });
    seedOverlay({ displayFingerprint: 'dsp-glass' });

    const loaded = await settingsStore.loadSettings(true);

    expect(loaded.stage.displayFingerprint).toBeNull();
    expect(ipc.updates()).toBe(0);
  });

  it('keeps a pin that names a panel which is not connected', async () => {
    /*
     * Nothing here knows which panels are plugged in, and nothing should: Present
     * falls back to the window's monitor without touching the pin, so the glass
     * gets its takes back the moment it is reconnected.
     */
    await settingsStore.loadSettings(true);
    await settingsStore.patchSettings('stage', { displayFingerprint: 'dsp-unplugged-1' });

    settingsStore.resetMigrationLatchesForTesting();
    const reloaded = await settingsStore.loadSettings(true);
    expect(reloaded.stage.displayFingerprint).toBe('dsp-unplugged-1');
    expect(ipc.stageBehavior()['displayFingerprint']).toBe('dsp-unplugged-1');
  });
});
