/**
 * Which write to the settings document wins (desktop refinement §14.1).
 *
 * ---------------------------------------------------------------------------
 * THE RACE THE SECOND WINDOW CREATED
 * ---------------------------------------------------------------------------
 * `loadSettings` used to run once per window, from the shell, and there was
 * nothing to race. Settings is its own window now, and three things write the
 * document at moments nobody schedules:
 *
 *   - a forced re-read, from the `storage` event that carries an overlay change
 *     between windows;
 *   - `adoptSettings`, from the `settings://changed` broadcast Rust makes after
 *     every successful write in EITHER window;
 *   - this window's own `patchSettings`.
 *
 * Two of those in flight resolve in whatever order the IPC layer answers. The
 * consequence of getting it wrong is not cosmetic: every write is checked
 * against `expectedRevision`, so a stale document means the next save fails a
 * concurrency check the user did nothing to cause and cannot understand.
 *
 * The rule is that a read commits only if nothing else committed while it was
 * in flight. These tests state that rule three ways — and they are also the
 * guard on the version that counted reads as they STARTED, which looked
 * equivalent and left the store permanently unloaded when two racing reads
 * disagreed about which of them failed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import type { AppSettings } from '../../../src/control/services/settings-types';

/*
 * The SERVICE is mocked, not the IPC layer.
 *
 * `setInvokeForTesting` does not make `isTauriRuntime()` true, and
 * `getSettings` falls back to the in-memory mock backend when it is false — so
 * an injected invoke is never reached from here.
 *
 * Only the three functions this file needs to control are overridden. The
 * migrations are stubbed to "nothing pending" because they issue writes of
 * their own, and this file is about ordering rather than about upgrades.
 */
const reads: Array<{ resolve: (value: AppSettings) => void; reject: (err: unknown) => void }> = [];
const updates: Array<{ resolve: (value: AppSettings) => void; reject: (err: unknown) => void }> =
  [];

vi.mock('../../../src/control/services/settings', async () => {
  const actual = await vi.importActual<typeof import('../../../src/control/services/settings')>(
    '../../../src/control/services/settings',
  );
  return {
    ...actual,
    getSettings: () =>
      new Promise<AppSettings>((resolve, reject) => {
        reads.push({ resolve, reject });
      }),
    updateSettings: () =>
      new Promise<AppSettings>((resolve, reject) => {
        updates.push({ resolve, reject });
      }),
    overlayStorageFailure: () => null,
    pendingStageModeAdoption: () => null,
    pendingOpticalAdoption: () => null,
  };
});

const { adoptSettings, loadSettings, patchSettings, settings } = await import(
  '../../../src/control/stores/settings'
);

/** Enough of a composed document for these assertions. */
function loaded(revision: number, launchBehavior: 'library' | 'recent'): AppSettings {
  return {
    ...get(settings),
    revision,
    general: { ...get(settings).general, launchBehavior },
  };
}

/**
 * The wire shape Rust broadcasts, which `adoptSettings` parses.
 *
 * A whole document rather than the two fields these tests read: `fromRust`
 * validates the sections it maps, so a minimal object is rejected outright and
 * `adoptSettings` returns false — which would make the test pass for the wrong
 * reason. The same document `settings-retired-keys` loads.
 */
function broadcast(revision: number, openTo: 'library' | 'last_script'): unknown {
  const base = RUST_DOCUMENT;
  return {
    revision,
    value: { ...base.value, general: { ...base.value.general, openTo } },
  };
}

const RUST_DOCUMENT = {
  revision: 1,
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
      transcriptionModel: 'x-asr-480ms-streaming-zipformer-punct-int8-2026-06-05',
      language: 'en',
      delayProfile: 'low',
    },
    commands: {
      wakePhrase: 'CandidCue',
      wakeMode: 'strict',
    },
  },
};

beforeEach(() => {
  reads.length = 0;
  updates.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the settings document commits in the right order', () => {
  it('does not let a read that started earlier overwrite an adopted broadcast', async () => {
    const read = loadSettings(true);
    expect(reads).toHaveLength(1);

    // The other window saves; Rust broadcasts; this window adopts revision 9.
    expect(adoptSettings(broadcast(9, 'last_script'))).toBe(true);
    expect(get(settings).revision).toBe(9);

    // Only NOW does the older read answer, holding the revision before it.
    reads[0]!.resolve(loaded(8, 'library'));
    await read;

    /*
     * The broadcast stands. Letting the older read land would leave this window
     * editing against revision 8 — and its next save would be refused for a
     * conflict the user never caused.
     */
    expect(get(settings).revision).toBe(9);
    expect(get(settings).general.launchBehavior).toBe('recent');
  });

  it('still loads when two reads race and the newer one fails', async () => {
    /*
     * The regression the first version of this guard shipped with. It counted
     * reads as they BEGAN, so a second read invalidated the first merely by
     * starting — and when the second then failed, the first's perfectly good
     * answer had already been disqualified and the store was never loaded at
     * all. A read that fails commits nothing and so invalidates nothing.
     */
    const first = loadSettings(true);
    const second = loadSettings(true);
    expect(reads).toHaveLength(2);

    reads[0]!.resolve(loaded(4, 'recent'));
    await first;
    expect(get(settings).revision).toBe(4);

    reads[1]!.reject(new Error('read failed'));
    await second.catch(() => undefined);
    expect(get(settings).revision).toBe(4);
  });

  it('takes a later read once the earlier one has settled', async () => {
    /*
     * Anti-vacuity. The rule holds out a read that began before another
     * committed — otherwise it could not tell a stale answer from a fresh one —
     * so this checks the store is not left stuck: the next read, begun after
     * things settled, lands normally.
     */
    const first = loadSettings(true);
    reads[0]!.resolve(loaded(4, 'library'));
    await first;
    expect(get(settings).revision).toBe(4);

    const next = loadSettings(true);
    reads[1]!.resolve(loaded(5, 'recent'));
    await next;
    expect(get(settings).revision).toBe(5);
    expect(get(settings).general.launchBehavior).toBe('recent');
  });

  it('does not roll a failed save back over a document that arrived meanwhile', async () => {
    /*
     * `patchSettings` shows its change immediately and undoes it if the write
     * is refused. "Undo" means "put back what was there" — and what was there
     * may have been replaced while the write was in flight, which is exactly
     * what the other window saving does. Restoring unconditionally discarded
     * the newer document and left this window holding a revision that no
     * longer existed, so its next save failed too.
     */
    const first = loadSettings(true);
    reads[0]!.resolve(loaded(4, 'library'));
    await first;

    const save = patchSettings('general', { launchBehavior: 'recent' }).catch(() => undefined);
    // The other window's save lands while ours is still in flight — with the
    // OPPOSITE value to ours, so a rollback that wrongly re-laid the refused
    // patch over it would show.
    expect(adoptSettings(broadcast(11, 'library'))).toBe(true);
    updates[0]!.reject(new Error('refused'));
    await save;

    expect(get(settings).revision).toBe(11);
    expect(get(settings).general.launchBehavior).toBe('library');
  });
});
