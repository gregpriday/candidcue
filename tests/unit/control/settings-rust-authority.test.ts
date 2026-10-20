/**
 * #271 — a field Rust persists has one source, and it is the document.
 *
 * The launch choice, the stored session mode and the auto-scroll pace were all
 * copied into the localStorage overlay on every save, and `fromRust` merged the
 * overlay OVER the document. Nothing showed it while the two agreed. Settings ›
 * Data › Restore is the ordinary path that makes them disagree: it swaps the
 * database at the next launch and leaves localStorage alone, so the restored
 * document applied everywhere except these fields — and the next save in the
 * section wrote the pre-restore value back over it, because the store sends
 * whole sections.
 *
 * The horizontal mirror is the fourth field from the issue; it is a per-panel
 * migration now (#206) and is covered with the rest of that migration in
 * `optical-profile-settings.test.ts`.
 *
 * These drive the real service against a fake `ipcInvoke` and a real
 * (in-memory) localStorage, the same harness as `settings-retired-keys.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ipc = vi.hoisted(() => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const document = (
    general: Record<string, unknown> = {},
    stageBehavior: Record<string, unknown> = {},
  ) => ({
    revision: 4,
    value: {
      schemaVersion: 1,
      general: {
        openTo: 'library',
        ...general,
      },
      stageBehavior: {
        promptMode: 'voice',
        fixedSpeedWpm: 140,
        horizontalMirror: false,
        // Persisted, so the presentation-mode migration has nothing to adopt.
        presentationMode: 'prompter',
        ...stageBehavior,
      },
      audio: {
        transcriptionModel: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05',
        language: 'en',
      },
      commands: { wakePhrase: 'CandidCue', wakeMode: 'strict' },
      // Owned, so neither optical migration runs underneath these cases.
      optical: { migrated: true, profiles: {}, activeRig: {}, panelMirror: {} },
    },
  });
  let current = document();
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

type Section = Record<string, unknown>;

function overlay(): { general?: Section; teleprompter?: Section } {
  return JSON.parse(store.get(settings.SETTINGS_OVERLAY_KEY) ?? '{}') as {
    general?: Section;
    teleprompter?: Section;
  };
}

function seedOverlay(value: unknown): void {
  store.set(settings.SETTINGS_OVERLAY_KEY, JSON.stringify(value));
}

function rustPatches(): Array<Record<string, Section>> {
  return ipc.calls
    .filter((call) => call.command === 'update_settings')
    .map((call) => (call.args as { patch: Record<string, Section> }).patch);
}

beforeEach(() => {
  ipc.calls.length = 0;
  ipc.serve(ipc.document());
  store.clear();
  settings.resetMigrationStateForTesting();
});

/*
 * Both directions, so neither side can pass by happening to equal a default:
 * `library`/`voice` are the defaults, and the issue's own repro restores them.
 */
const RESTORED = [
  {
    name: 'restored to the defaults, under an overlay that moved off them',
    rust: { openTo: 'library', promptMode: 'voice', fixedSpeedWpm: 140 },
    stale: { launchBehavior: 'recent', defaultSessionMode: 'manual', fixedSpeedWpm: 200 },
    expected: { launchBehavior: 'library', defaultSessionMode: 'voice', fixedSpeedWpm: 140 },
  },
  {
    name: 'restored off the defaults, under an overlay that went back to them',
    rust: { openTo: 'last_script', promptMode: 'fixed', fixedSpeedWpm: 210 },
    stale: { launchBehavior: 'library', defaultSessionMode: 'voice', fixedSpeedWpm: 120 },
    expected: { launchBehavior: 'recent', defaultSessionMode: 'fixed', fixedSpeedWpm: 210 },
  },
] as const;

describe('#271 a restored document under an overlay that cached its fields', () => {
  function serveRestored(rust: (typeof RESTORED)[number]['rust']): void {
    ipc.serve(
      ipc.document(
        { openTo: rust.openTo },
        { promptMode: rust.promptMode, fixedSpeedWpm: rust.fixedSpeedWpm },
      ),
    );
  }

  function seedStale(stale: (typeof RESTORED)[number]['stale']): void {
    seedOverlay({
      general: {
        launchBehavior: stale.launchBehavior,
        defaultSessionMode: stale.defaultSessionMode,
        confirmEndSession: false,
      },
      teleprompter: { fixedSpeedWpm: stale.fixedSpeedWpm, fontSizePx: 72 },
    });
  }

  for (const { name, rust, stale, expected } of RESTORED) {
    it(`reads the document's values — ${name}`, async () => {
      serveRestored(rust);
      seedStale(stale);
      const before = store.get(settings.SETTINGS_OVERLAY_KEY);

      const loaded = await settings.getSettings();

      expect(loaded.general.launchBehavior).toBe(expected.launchBehavior);
      expect(loaded.general.defaultSessionMode).toBe(expected.defaultSessionMode);
      expect(loaded.teleprompter.fixedSpeedWpm).toBe(expected.fixedSpeedWpm);
      // The fields the overlay genuinely owns still come from it.
      expect(loaded.general.confirmEndSession).toBe(false);
      expect(loaded.teleprompter.fontSizePx).toBe(72);
      // And a read writes nothing.
      expect(store.get(settings.SETTINGS_OVERLAY_KEY)).toBe(before);
    });

    it(`adopts a broadcast the same way — ${name}`, () => {
      // The other window's write reaches this one as `settings://changed`,
      // through the same adapter, and must not be undone by this overlay.
      seedStale(stale);
      const doc = ipc.document(
        { openTo: rust.openTo },
        { promptMode: rust.promptMode, fixedSpeedWpm: rust.fixedSpeedWpm },
      );

      const adopted = settings.adaptRevisionedSettings(doc);

      expect(adopted?.general.launchBehavior).toBe(expected.launchBehavior);
      expect(adopted?.general.defaultSessionMode).toBe(expected.defaultSessionMode);
      expect(adopted?.teleprompter.fixedSpeedWpm).toBe(expected.fixedSpeedWpm);
    });

    it(`writes the document's values back on the next save, not the stale ones — ${name}`, async () => {
      /*
       * The second half of the bug. The store sends the whole section as it
       * shows it, so a stale value in the view is a stale value sent to Rust —
       * here as a change to two overlay-owned fields in the same sections.
       */
      serveRestored(rust);
      seedStale(stale);
      const loaded = await settings.getSettings();

      await settings.updateSettings(loaded.revision, {
        general: { ...loaded.general, confirmEndSession: true },
        teleprompter: { ...loaded.teleprompter, fontSizePx: 80 },
      });

      const [patch] = rustPatches();
      expect(patch?.['general']?.['openTo']).toBe(rust.openTo);
      expect(patch?.['stageBehavior']?.['promptMode']).toBe(rust.promptMode);
      expect(patch?.['stageBehavior']?.['fixedSpeedWpm']).toBe(rust.fixedSpeedWpm);
      // And the copy that carried the stale values is gone.
      expect(overlay().general).not.toHaveProperty('launchBehavior');
      expect(overlay().general).not.toHaveProperty('defaultSessionMode');
      expect(overlay().teleprompter).not.toHaveProperty('fixedSpeedWpm');
    });
  }
});

describe('#271 the overlay stops caching what Rust persists', () => {
  it('a whole-section save keeps every Rust-owned field out of the overlay', async () => {
    const loaded = await settings.getSettings();

    await settings.updateSettings(loaded.revision, {
      general: { ...loaded.general, launchBehavior: 'recent', defaultSessionMode: 'fixed' },
      teleprompter: { ...loaded.teleprompter, fixedSpeedWpm: 190 },
    });

    expect(rustPatches()).toEqual([
      {
        // `checkForUpdates` rides along because the whole section was sent,
        // and it is Rust-owned: Rust reads it before an automatic update check.
        general: { openTo: 'last_script', checkForUpdates: true },
        // No `pointerHideDelaySeconds`: nothing reads it (#218), so nothing sends it.
        stageBehavior: { promptMode: 'fixed', fixedSpeedWpm: 190 },
      },
    ]);
    const stored = overlay();
    expect(stored.general).not.toHaveProperty('launchBehavior');
    expect(stored.general).not.toHaveProperty('defaultSessionMode');
    expect(stored.general).not.toHaveProperty('checkForUpdates');
    expect(stored.teleprompter).not.toHaveProperty('fixedSpeedWpm');
    // The sections themselves are still there, holding what is local.
    expect(stored.general).toHaveProperty('confirmEndSession');
    expect(stored.teleprompter).toHaveProperty('fontSizePx');
  });

  it("drops an old overlay's copies even when the patch does not mention them", async () => {
    /*
     * Stripped from the MERGED section, not from the incoming patch: the write
     * spreads the stored section back in, so a patch-only strip would leave the
     * stale copies there for good. This patch has no Rust home at all, so it
     * also exercises the overlay-only path through `updateSettings`.
     */
    seedOverlay({
      general: { launchBehavior: 'recent', defaultSessionMode: 'manual', readHeadings: true },
      teleprompter: {
        fixedSpeedWpm: 200,
        mirrorX: true,
        mirrorY: true,
        fontSizePx: 72,
        hidePointer: false,
      },
    });

    await settings.updateSettings(4, {
      general: { confirmEndSession: false },
      teleprompter: { fontSizePx: 80 },
    } as never);

    expect(rustPatches(), 'neither field has a Rust home').toEqual([]);
    const stored = overlay();
    expect(stored.general).toEqual({ readHeadings: true, confirmEndSession: false });
    // `mirrorY` never reached Rust and the per-panel move still needs it;
    // `hidePointer` went with its row (#218).
    expect(stored.teleprompter).toEqual({ mirrorY: true, fontSizePx: 80 });
  });
});

describe('"Check for updates automatically" is Rust-owned', () => {
  /*
   * Rust reads `general.checkForUpdates` before it will make an automatic
   * update check (`commands::check_for_update`). So the switch must reach Rust,
   * must be read back from Rust, and must never be answered from a cached
   * overlay copy — a cleared or stale browser store turning checks back on
   * behind somebody's back is the failure this guards.
   */
  it('reads as on for a document written before the switch existed', async () => {
    const loaded = await settings.getSettings();
    expect(loaded.general.checkForUpdates).toBe(true);
  });

  it('reads the document, not a stale overlay copy', async () => {
    ipc.serve(ipc.document({ checkForUpdates: false }));
    seedOverlay({ general: { checkForUpdates: true } });
    const loaded = await settings.getSettings();
    expect(loaded.general.checkForUpdates).toBe(false);
  });

  it('writes the switch to Rust and keeps it out of the overlay', async () => {
    const loaded = await settings.getSettings();
    await settings.updateSettings(loaded.revision, { general: { checkForUpdates: false } } as never);
    expect(rustPatches()).toEqual([{ general: { checkForUpdates: false } }]);
    expect(overlay().general ?? {}).not.toHaveProperty('checkForUpdates');
  });
});
