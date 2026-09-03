/**
 * One settings write at a time, and the rest coalesce behind it.
 *
 * ---------------------------------------------------------------------------
 * THE COLUMN OF TOASTS
 * ---------------------------------------------------------------------------
 * Every write is checked against `expectedRevision`. `patchSettings` used to
 * send each patch the moment it was asked for, with whatever revision the
 * store held — so dragging a slider sent thirty writes carrying the same
 * revision, the first landed and retired it, and the other twenty-nine were
 * refused. Each refusal toasted "Could not save settings. Nothing was
 * changed." for a value that had been saved, and the Settings window filled
 * with a column of them.
 *
 * These pin the replacement: a write in flight holds later patches, which are
 * merged and sent as ONE write with the revision the first handed back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import type { AppSettings } from '../../../src/control/services/settings-types';

interface Update {
  expectedRevision: number;
  patch: Partial<AppSettings>;
  resolve: (value: AppSettings) => void;
  reject: (err: unknown) => void;
}
const updates: Update[] = [];
const toasts: string[] = [];

vi.mock('../../../src/control/services/settings', async () => {
  const actual = await vi.importActual<typeof import('../../../src/control/services/settings')>(
    '../../../src/control/services/settings',
  );
  return {
    ...actual,
    updateSettings: (expectedRevision: number, patch: Partial<AppSettings>) =>
      new Promise<AppSettings>((resolve, reject) => {
        updates.push({ expectedRevision, patch, resolve, reject });
      }),
    overlayStorageFailure: () => null,
    pendingStageModeAdoption: () => null,
    pendingOpticalAdoption: () => null,
  };
});

vi.mock('../../../src/control/stores/toasts', () => ({
  showToast: (message: string) => {
    toasts.push(message);
  },
  dismissToastByKey: () => {},
  clearConditionToasts: () => {},
}));

const { adoptSettings, patchSettings, settings } = await import(
  '../../../src/control/stores/settings'
);

/**
 * The wire shape Rust broadcasts — a whole document, because `fromRust`
 * validates the sections it maps. Copied from settings-commit-order.test.ts.
 */
function broadcast(revision: number, openTo: 'library' | 'last_script'): unknown {
  return {
    revision,
    value: {
      schemaVersion: 1,
      general: {
        openTo,
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
}

/**
 * The backend's own copy of the document — independent of the store, so a
 * response never accidentally carries a change that belongs to a LATER batch
 * and lets the queue pass for the wrong reason.
 */
let backend: AppSettings;

/** The document Rust would hand back for a write: the patch, at the next revision. */
function saved(update: Update, revision: number): AppSettings {
  const merged = { ...backend, revision } as AppSettings;
  for (const [section, value] of Object.entries(update.patch)) {
    (merged as unknown as Record<string, unknown>)[section] = value;
  }
  backend = merged;
  return structuredClone(merged);
}

/**
 * A caller's promise settles inside the batch that carried it, BEFORE the
 * queue moves on to the next batch — so the next write is on the wire one
 * macrotask later than the await, not in the same one.
 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  updates.length = 0;
  toasts.length = 0;
  backend = structuredClone(get(settings));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('settings writes are serialised', () => {
  it('holds patches made during a write and sends them as one, at the new revision', async () => {
    const startRevision = get(settings).revision;
    const first = patchSettings('teleprompter', { fontSizePx: 80 });
    expect(updates).toHaveLength(1);
    expect(updates[0]!.expectedRevision).toBe(startRevision);

    // The slider keeps moving while the first write is on the wire.
    const second = patchSettings('teleprompter', { fontSizePx: 81 });
    const third = patchSettings('teleprompter', { fontSizePx: 82 });
    const other = patchSettings('general', { launchBehavior: 'recent' });
    // Nothing else has been sent: they are waiting their turn.
    expect(updates).toHaveLength(1);
    // But every one of them is already on screen.
    expect(get(settings).teleprompter.fontSizePx).toBe(82);
    expect(get(settings).general.launchBehavior).toBe('recent');

    updates[0]!.resolve(saved(updates[0]!, startRevision + 1));
    await first;
    await flush();

    // ONE write for the three that queued, carrying the revision just handed
    // back — never the one the first write retired.
    expect(updates).toHaveLength(2);
    expect(updates[1]!.expectedRevision).toBe(startRevision + 1);
    expect(updates[1]!.patch.teleprompter?.fontSizePx).toBe(82);
    expect(updates[1]!.patch.general?.launchBehavior).toBe('recent');

    updates[1]!.resolve(saved(updates[1]!, startRevision + 2));
    await Promise.all([second, third, other]);
    expect(get(settings).revision).toBe(startRevision + 2);
    expect(get(settings).teleprompter.fontSizePx).toBe(82);
    expect(toasts).toEqual([]);
  });

  it('settles every queued caller with the outcome of the write that carried it', async () => {
    const startRevision = get(settings).revision;
    const first = patchSettings('teleprompter', { fontSizePx: 90 });
    const queuedA = patchSettings('teleprompter', { fontSizePx: 91 });
    const queuedB = patchSettings('teleprompter', { fontSizePx: 92 });

    updates[0]!.resolve(saved(updates[0]!, startRevision + 1));
    await first;
    await flush();
    expect(updates).toHaveLength(2);

    // The coalesced write is refused: both callers hear about it, once.
    updates[1]!.reject(new Error('refused'));
    await expect(queuedA).rejects.toThrow('refused');
    await expect(queuedB).rejects.toThrow('refused');
    expect(toasts).toEqual(['Could not save settings. Nothing was changed.']);
    // And the store is back on the last document Rust agreed to.
    expect(get(settings).teleprompter.fontSizePx).toBe(90);
    expect(get(settings).revision).toBe(startRevision + 1);
  });

  it('keeps every key when one section is patched twice with different keys', async () => {
    const startRevision = get(settings).revision;
    const first = patchSettings('general', { launchBehavior: 'recent' });
    const size = patchSettings('teleprompter', { fontSizePx: 88 });
    const height = patchSettings('teleprompter', { lineHeight: 1.5 });
    updates[0]!.resolve(saved(updates[0]!, startRevision + 1));
    await first;
    await flush();

    // One write, with BOTH of the teleprompter keys the two patches carried.
    expect(updates).toHaveLength(2);
    expect(updates[1]!.patch.teleprompter?.fontSizePx).toBe(88);
    expect(updates[1]!.patch.teleprompter?.lineHeight).toBe(1.5);
    updates[1]!.resolve(saved(updates[1]!, startRevision + 2));
    await Promise.all([size, height]);
    expect(get(settings).teleprompter.fontSizePx).toBe(88);
    expect(get(settings).teleprompter.lineHeight).toBe(1.5);
  });

  it('sends the patch queued behind a refused write, at the revision that still stands', async () => {
    const startRevision = get(settings).revision;
    const first = patchSettings('teleprompter', { fontSizePx: 60 }).catch(() => undefined);
    const second = patchSettings('teleprompter', { lineHeight: 1.4 });

    // The first write is refused; its change is rolled back — and the one
    // queued behind it is still on screen and still goes out.
    updates[0]!.reject(new Error('refused'));
    await first;
    expect(get(settings).teleprompter.fontSizePx).not.toBe(60);
    expect(get(settings).teleprompter.lineHeight).toBe(1.4);
    await flush();

    expect(updates).toHaveLength(2);
    expect(updates[1]!.expectedRevision).toBe(startRevision);
    expect(updates[1]!.patch.teleprompter?.lineHeight).toBe(1.4);
    // Nothing of the refused patch rides along.
    expect(updates[1]!.patch.teleprompter?.fontSizePx).not.toBe(60);
    updates[1]!.resolve(saved(updates[1]!, startRevision + 1));
    await second;
    expect(get(settings).teleprompter.lineHeight).toBe(1.4);
  });

  it('does not adopt a write\'s answer over a newer document that arrived first', async () => {
    const startRevision = get(settings).revision;
    const write = patchSettings('general', { launchBehavior: 'recent' });
    // The other window's LATER write is broadcast before our answer lands.
    expect(adoptSettings(broadcast(startRevision + 2, 'library'))).toBe(true);
    expect(get(settings).revision).toBe(startRevision + 2);

    updates[0]!.resolve(saved(updates[0]!, startRevision + 1));
    await write;
    await flush();

    // The newer document stands, and the next write is sent against it.
    expect(get(settings).revision).toBe(startRevision + 2);
    const next = patchSettings('teleprompter', { fontSizePx: 77 });
    expect(updates).toHaveLength(2);
    expect(updates[1]!.expectedRevision).toBe(startRevision + 2);
    updates[1]!.resolve(saved(updates[1]!, startRevision + 3));
    await next;
  });

  it('sends the next patch straight away once the queue has drained', async () => {
    // Anti-vacuity: serialising must not leave the queue stuck after a batch.
    const startRevision = get(settings).revision;
    const first = patchSettings('teleprompter', { fontSizePx: 70 });
    updates[0]!.resolve(saved(updates[0]!, startRevision + 1));
    await first;
    await flush();

    const next = patchSettings('teleprompter', { fontSizePx: 71 });
    expect(updates).toHaveLength(2);
    expect(updates[1]!.expectedRevision).toBe(startRevision + 1);
    updates[1]!.resolve(saved(updates[1]!, startRevision + 2));
    await next;
    expect(get(settings).teleprompter.fontSizePx).toBe(71);
  });
});
