/**
 * The stage section's move out of localStorage, both halves of it.
 *
 * `presentationMode` used to live only in the browser overlay, where a cleared
 * store silently returned a reader to prompter, and `readerFrame` did not exist
 * at all — the reading window's bounds died with the process.
 *
 * These drive the real service against a fake `ipcInvoke`, because the failure
 * this file exists to catch is a mapping that exists in ONE direction. That has
 * happened twice already in `services/settings.ts` (`saveTranscript` and
 * `vadSensitivity`), and it presents as a control that works and then forgets —
 * which is indistinguishable from the bug being fixed here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ipc = vi.hoisted(() => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const baseline = {
    revision: 7,
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
    },
  };
  let document = structuredClone(baseline);
  return {
    calls,
    reset(): void {
      document = structuredClone(baseline);
    },
    /** Put a value into the persisted document, the way another window would. */
    setStageBehavior(patch: Record<string, unknown>): void {
      Object.assign(document.value.stageBehavior, patch);
    },
    /** Refuse the next command, the way a database that went away would. */
    failNext: null as Error | null,
    invoke: async (command: string, args?: unknown) => {
      ipc.calls.push({ command, args });
      const failure = ipc.failNext;
      ipc.failNext = null;
      if (failure !== null) throw failure;
      return document;
    },
  };
});

vi.mock('../../../src/control/services/ipc', () => ({
  isTauriRuntime: () => true,
  BackendUnavailableError: class extends Error {},
  ipcInvoke: ipc.invoke,
}));

/** A real in-memory localStorage, so the overlay path actually runs. */
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
const settings = await import('../../../src/control/services/settings');

function seedOverlay(stage: Record<string, unknown>): void {
  store.set(OVERLAY_KEY, JSON.stringify({ stage }));
}

function lastPatch(): Record<string, Record<string, unknown>> {
  const update = ipc.calls.filter((c) => c.command === 'update_settings').at(-1);
  expect(update, 'the change must reach Rust, not only the local overlay').toBeDefined();
  return (update!.args as { patch: Record<string, Record<string, unknown>> }).patch;
}

beforeEach(() => {
  ipc.calls.length = 0;
  ipc.reset();
  store.clear();
  // The pin's latch governs its fallback, so one case seeing Rust own the pin
  // would otherwise hide the overlay from every case after it.
  settings.resetMigrationStateForTesting();
});

describe('the size bias survives a reload', () => {
  it('round-trips through the overlay, since Rust has no field for it', async () => {
    /*
     * `teleprompter.sizeBias` is the control that decides how much of a line a
     * panel running on the AUTOMATIC profile shows. It is overlay-owned, like
     * `textIntensity` and `readingCue` beside it — Rust's `AppSettings` has no
     * teleprompter section at all — so this is the only thing standing between
     * the preference and a reload that forgets it.
     *
     * The failure it catches is the one this file was written for: a mapping
     * that exists in one direction. A `sizeBias` that writes but does not read
     * back presents as a slider that works, and then silently returns the
     * prompter to the narrow line on the next launch.
     */
    const current = await settings.getSettings();
    await settings.updateSettings(current.revision, {
      teleprompter: { ...current.teleprompter, sizeBias: 0 },
    });
    expect((await settings.getSettings()).teleprompter.sizeBias).toBe(0);

    // And it is genuinely in the store, not merely in a cached document.
    const overlay = JSON.parse(store.get(OVERLAY_KEY) ?? '{}');
    expect(overlay.teleprompter?.sizeBias).toBe(0);
  });

  it('is never sent to Rust, which has nowhere to put it', async () => {
    const current = await settings.getSettings();
    await settings.updateSettings(current.revision, {
      teleprompter: { ...current.teleprompter, sizeBias: 0.25 },
    });
    for (const call of ipc.calls.filter((c) => c.command === 'update_settings')) {
      expect(JSON.stringify(call.args)).not.toContain('sizeBias');
    }
  });
});

describe('the presentation mode is Rust-owned', () => {
  it('reads the persisted document when it has an answer', async () => {
    ipc.setStageBehavior({ presentationMode: 'reader' });
    const loaded = await settings.getSettings();
    expect(loaded.stage.presentationMode).toBe('reader');
  });

  it('adopts the existing overlay value when the document has never held one', async () => {
    /*
     * The upgrade path, and the whole reason the Rust field is nullable. A
     * reader who chose the mode before it moved must not be silently returned
     * to prompter by the build that moved it.
     */
    seedOverlay({ presentationMode: 'reader' });
    const loaded = await settings.getSettings();
    expect(loaded.stage.presentationMode).toBe('reader');
  });

  it('carries the retired "Full screen" boolean across the move as well', async () => {
    // A document that predates BOTH fields: the overlay still holds only the
    // boolean, and `migrateStageMode` is still the thing that reads it.
    seedOverlay({ fullscreen: false });
    const loaded = await settings.getSettings();
    expect(loaded.stage.presentationMode).toBe('reader');
  });

  it('lets the document override a stale overlay once it has an answer', async () => {
    // The direction that makes the move worth making: a cached local copy must
    // never win over what was actually persisted.
    seedOverlay({ presentationMode: 'reader' });
    ipc.setStageBehavior({ presentationMode: 'prompter' });
    const loaded = await settings.getSettings();
    expect(loaded.stage.presentationMode).toBe('prompter');
  });

  it('writes a change through to stageBehavior', async () => {
    await settings.updateSettings(7, { stage: { presentationMode: 'reader' } as never });
    expect(lastPatch()).toEqual({ stageBehavior: { presentationMode: 'reader' } });
  });

  it('never caches the mode in the overlay', async () => {
    /*
     * A cached copy would be read by the adoption path above on any document
     * that has no value yet, resurrecting an old choice over a newer one. The
     * pin rode along in the same save and is Rust-owned too now (#272).
     */
    await settings.updateSettings(7, {
      stage: { presentationMode: 'reader', displayFingerprint: 'panel-1' } as never,
    });
    const overlay = JSON.parse(store.get(OVERLAY_KEY) ?? '{}') as {
      stage?: Record<string, unknown>;
    };
    expect(overlay.stage).not.toHaveProperty('presentationMode');
    expect(overlay.stage).not.toHaveProperty('displayFingerprint');
  });

  it('falls back rather than inventing a default for a value it cannot read', async () => {
    // A document written by a newer build. The local answer is a better guess
    // than hard-coding prompter over the top of it.
    seedOverlay({ presentationMode: 'reader' });
    ipc.setStageBehavior({ presentationMode: 'picture-in-picture' });
    const loaded = await settings.getSettings();
    expect(loaded.stage.presentationMode).toBe('reader');
  });
});

describe('the reading window frame survives a quit', () => {
  const frame = { x: 120, y: 80, width: 900, height: 620 };

  it('reads a stored frame back', async () => {
    ipc.setStageBehavior({ readerFrame: frame });
    const loaded = await settings.getSettings();
    expect(loaded.stage.readerFrame).toEqual(frame);
  });

  it('is null until a reading window has actually been left somewhere', async () => {
    const loaded = await settings.getSettings();
    expect(loaded.stage.readerFrame).toBeNull();
  });

  it('writes the frame through to stageBehavior', async () => {
    await settings.updateSettings(7, { stage: { readerFrame: frame } as never });
    expect(lastPatch()).toEqual({ stageBehavior: { readerFrame: frame } });
  });

  it('sends an explicit null so Rust forgets the frame', async () => {
    /*
     * `merge_json` REMOVES a key whose patch value is null, which is how a frame
     * is forgotten. Dropping the null instead — the way `put` drops undefined —
     * would make "forget this" a silent no-op.
     */
    await settings.updateSettings(7, { stage: { readerFrame: null } as never });
    expect(lastPatch()).toEqual({ stageBehavior: { readerFrame: null } });
  });

  it('rejects a frame that would produce a window nobody can use', async () => {
    /*
     * These four numbers reach `set_position`/`set_size`. A half-written or
     * corrupt frame is not a wrong-looking setting, it is a window the operator
     * cannot see or click — so anything non-finite or non-positive is refused
     * rather than repaired.
     */
    for (const bad of [
      { x: 0, y: 0, width: 0, height: 400 },
      { x: 0, y: 0, width: 900, height: -1 },
      { x: Number.NaN, y: 0, width: 900, height: 400 },
      { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 400 },
      { x: 0, y: 0, width: 900 },
      { x: '10', y: 0, width: 900, height: 400 },
      'somewhere',
    ]) {
      ipc.reset();
      ipc.setStageBehavior({ readerFrame: bad });
      const loaded = await settings.getSettings();
      expect(loaded.stage.readerFrame, JSON.stringify(bad)).toBeNull();
    }
  });

  it('never caches the frame in the overlay', async () => {
    await settings.updateSettings(7, { stage: { readerFrame: frame } as never });
    const overlay = JSON.parse(store.get(OVERLAY_KEY) ?? '{}') as {
      stage?: Record<string, unknown>;
    };
    expect(overlay.stage ?? {}).not.toHaveProperty('readerFrame');
  });
});

describe('the pinned prompter display is Rust-owned (#272)', () => {
  it('reads the document over a different overlay pin', async () => {
    seedOverlay({ displayFingerprint: 'dsp-old-desk' });
    ipc.setStageBehavior({ displayFingerprint: 'dsp-glass', displayPinMigrated: true });
    const loaded = await settings.getSettings();
    expect(loaded.stage.displayFingerprint).toBe('dsp-glass');
    expect(settings.pendingDisplayPinAdoption()).toBeNull();
  });

  it('reads the overlay only while the document has never owned the pin', async () => {
    seedOverlay({ displayFingerprint: 'dsp-glass' });
    const loaded = await settings.getSettings();
    expect(loaded.stage.displayFingerprint).toBe('dsp-glass');
    expect(settings.pendingDisplayPinAdoption()).toBe('dsp-glass');
  });

  it('treats an owned document without a pin as unpinned, whatever the overlay says', async () => {
    /*
     * The failure the ownership flag exists for: an operator unpinned, the
     * overlay write that should have dropped the old copy failed, and the next
     * launch would otherwise read the stale pin back — and adopt it.
     */
    seedOverlay({ displayFingerprint: 'dsp-old-desk' });
    ipc.setStageBehavior({ displayPinMigrated: true });
    const loaded = await settings.getSettings();
    expect(loaded.stage.displayFingerprint).toBeNull();
    expect(settings.pendingDisplayPinAdoption()).toBeNull();
  });

  it('writes a pin through with the ownership flag beside it', async () => {
    await settings.updateSettings(7, { stage: { displayFingerprint: 'dsp-glass' } as never });
    expect(lastPatch()).toEqual({
      stageBehavior: { displayFingerprint: 'dsp-glass', displayPinMigrated: true },
    });
  });

  it('passes an unpin through as null, still claiming ownership', async () => {
    /*
     * `merge_json` removes a null key, so the null is how the pin is forgotten
     * — and the flag is how the document remembers that it was.
     */
    await settings.updateSettings(7, { stage: { displayFingerprint: null } as never });
    expect(lastPatch()).toEqual({
      stageBehavior: { displayFingerprint: null, displayPinMigrated: true },
    });
  });

  it('never reads or sends a pin Rust would refuse', async () => {
    // Every stage save carries the pin, so one Rust rejects would fail every
    // save of the section rather than just the one that set it.
    // 129 two-byte characters: 258 UTF-8 bytes, under 256 UTF-16 units. Rust
    // counts bytes, so this side must too.
    for (const bad of ['', '   ', 'x'.repeat(257), 'é'.repeat(129), 42, { fingerprint: 'dsp-glass' }]) {
      store.clear();
      settings.resetMigrationStateForTesting();
      seedOverlay({ displayFingerprint: bad });
      const loaded = await settings.getSettings();
      expect(loaded.stage.displayFingerprint, JSON.stringify(bad)).toBeNull();
      expect(settings.pendingDisplayPinAdoption(), JSON.stringify(bad)).toBeNull();
    }
    // The cap itself, in two-byte characters, is still a pin.
    store.clear();
    settings.resetMigrationStateForTesting();
    seedOverlay({ displayFingerprint: 'é'.repeat(128) });
    expect((await settings.getSettings()).stage.displayFingerprint).toBe('é'.repeat(128));
    await settings.updateSettings(7, { stage: { displayFingerprint: '' } as never });
    expect(lastPatch()).toEqual({
      stageBehavior: { displayFingerprint: null, displayPinMigrated: true },
    });
  });

  it('drops the overlay copy once a save has carried the pin to Rust', async () => {
    seedOverlay({ displayFingerprint: 'dsp-glass' });
    await settings.updateSettings(7, { stage: { displayFingerprint: 'dsp-glass' } as never });
    const overlay = JSON.parse(store.get(OVERLAY_KEY) ?? '{}') as {
      stage?: Record<string, unknown>;
    };
    expect(overlay.stage ?? {}).not.toHaveProperty('displayFingerprint');
  });

  it('keeps the only copy of an unadopted pin when a save never mentioned it', async () => {
    /*
     * A stage patch with no pin in it wrote nothing to Rust about the pin. Until
     * the adoption lands the overlay holds the only copy there is.
     */
    seedOverlay({ displayFingerprint: 'dsp-glass' });
    await settings.updateSettings(7, { stage: { presentationMode: 'reader' } as never });
    const overlay = JSON.parse(store.get(OVERLAY_KEY) ?? '{}') as {
      stage?: Record<string, unknown>;
    };
    expect(overlay.stage?.['displayFingerprint']).toBe('dsp-glass');
  });

  it('keeps the overlay copy when the write to Rust fails', async () => {
    seedOverlay({ displayFingerprint: 'dsp-glass' });
    ipc.failNext = new Error('database gone');
    await expect(
      settings.updateSettings(7, { stage: { displayFingerprint: null } as never }),
    ).rejects.toThrow('database gone');
    const overlay = JSON.parse(store.get(OVERLAY_KEY) ?? '{}') as {
      stage?: Record<string, unknown>;
    };
    expect(overlay.stage?.['displayFingerprint']).toBe('dsp-glass');
  });
});
