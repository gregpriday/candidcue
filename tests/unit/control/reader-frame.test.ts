/**
 * Remembering where a reading window was left.
 *
 * The interesting cases are all about restraint: this runs on teardown paths
 * that must complete, so it has to decline quietly far more often than it
 * writes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultAppSettings, type AppSettings } from '../../../src/control/services/settings-types';

const store = vi.hoisted(() => ({
  patchSettings: vi.fn(),
  snapshot: null as AppSettings | null,
}));

vi.mock('../../../src/control/stores/settings', () => ({
  patchSettings: store.patchSettings,
  getSettingsSnapshot: () => store.snapshot,
}));

const { rememberReaderFrame } = await import('../../../src/control/lib/reader-frame');

const FRAME = { x: 120, y: 90, width: 860, height: 600 };

/** What Rust answers when a take ends out of reader mode. */
function leaving(readerFrame?: typeof FRAME) {
  return {
    presenting: false,
    width: 1240,
    height: 820,
    ...(readerFrame ? { readerFrame } : {}),
  };
}

beforeEach(() => {
  store.patchSettings.mockReset();
  store.patchSettings.mockResolvedValue(undefined);
  store.snapshot = defaultAppSettings();
});

describe('remembering the reading window', () => {
  it('stores the frame a departing reader reported', async () => {
    await rememberReaderFrame(leaving(FRAME));
    expect(store.patchSettings).toHaveBeenCalledWith('stage', { readerFrame: FRAME });
  });

  it('writes nothing when the state carried no frame', async () => {
    // Every prompter exit, which is most of them.
    await rememberReaderFrame(leaving());
    expect(store.patchSettings).not.toHaveBeenCalled();
  });

  it('writes nothing when the exit itself failed', async () => {
    // `exitPresentation` is called with `.catch(() => null)` on every teardown
    // path, so null is an ordinary input here rather than a defect.
    await rememberReaderFrame(null);
    expect(store.patchSettings).not.toHaveBeenCalled();
  });

  it('does not rewrite a frame that has not moved', async () => {
    /*
     * Present in a window, read, stop — without touching the window — is the
     * common case, and it would otherwise write an identical rectangle to
     * SQLite on the end of every take.
     */
    store.snapshot!.stage.readerFrame = { ...FRAME };
    await rememberReaderFrame(leaving(FRAME));
    expect(store.patchSettings).not.toHaveBeenCalled();
  });

  it('writes when any single edge moved', async () => {
    store.snapshot!.stage.readerFrame = { ...FRAME, width: FRAME.width + 1 };
    await rememberReaderFrame(leaving(FRAME));
    expect(store.patchSettings).toHaveBeenCalledWith('stage', { readerFrame: FRAME });
  });

  it('records nothing at all when the operator turned remembering off', async () => {
    /*
     * The toggle governs REMEMBERING as well as restoring. Somebody who turned
     * it off is saying they do not want the app tracking where their windows
     * sit — keeping the note while declining to use it would be keeping a note
     * they asked us not to keep.
     */
    store.snapshot!.general.restoreWindows = false;
    await rememberReaderFrame(leaving(FRAME));
    expect(store.patchSettings).not.toHaveBeenCalled();
  });

  it('never throws, whatever the settings write does', async () => {
    /*
     * Every call site is on a path that must complete: an exit that fails
     * partway leaves the operator looking at a covered window. Failing to
     * remember a rectangle is not a reason to strand somebody there.
     */
    store.patchSettings.mockRejectedValue(new Error('revision conflict'));
    await expect(rememberReaderFrame(leaving(FRAME))).resolves.toBeUndefined();
  });
});
