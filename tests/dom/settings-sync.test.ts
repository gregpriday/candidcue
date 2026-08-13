/**
 * Keeping two windows' settings in step (desktop refinement §14.1).
 *
 * Settings became its own window, and a module singleton in another webview is
 * a different instance — so there are two copies of one document with no path
 * between them. Three mechanisms close that, and this file covers the one that
 * is pure DOM and therefore testable here:
 *
 *   - `settings://changed`, broadcast by Rust after every `update_settings`
 *     (and now after `select_speech_language` too). Needs a Tauri runtime.
 *   - `settings://show-section`, for a window that is already open. Same.
 *   - `installOverlaySync`, below — a `storage` listener, because the OVERLAID
 *     fields (stage font and stage type size) never reach Rust at all and so
 *     have no command to hook a broadcast onto.
 *
 * The overlay is the one that had no coverage and the one most likely to be
 * got wrong, because `storage` has two behaviours worth pinning: it fires only
 * for OTHER documents of the origin, and a `clear()` reports `key === null`
 * rather than naming every key it removed.
 *
 * WHAT THIS DOES NOT COVER: that the two CALLERS pass the right key. Both name
 * `SETTINGS_OVERLAY_KEY`, which is exported from the module that owns the
 * overlay — and the defect this feature shipped with was exactly a caller
 * naming the wrong key (the workspace store's). A test that mounted both
 * windows would catch that; this one asserts the listener's own contract, and
 * the shared constant is what stops the callers drifting.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installOverlaySync } from '../../src/control/services/settings-sync';

function fire(key: string | null): void {
  window.dispatchEvent(new StorageEvent('storage', { key }));
}

describe('installOverlaySync', () => {
  const teardowns: Array<() => void> = [];

  afterEach(() => {
    for (const stop of teardowns.splice(0)) stop();
    vi.restoreAllMocks();
  });

  it('re-reads when a watched key moves', () => {
    const reread = vi.fn();
    teardowns.push(installOverlaySync(['candidcue.settings-overlay.v1'], reread));
    fire('candidcue.settings-overlay.v1');
    expect(reread).toHaveBeenCalledTimes(1);
  });

  it('ignores a key it is not watching', () => {
    /*
     * The workspace store lives in the same origin and is written on every pane
     * drag. Re-composing the settings document on each of those would put an
     * IPC round trip behind a pointer gesture, and adopt nothing.
     */
    const reread = vi.fn();
    teardowns.push(installOverlaySync(['candidcue.settings-overlay.v1'], reread));
    fire('candidcue.workspace.v1');
    expect(reread).not.toHaveBeenCalled();
  });

  it('re-reads on a clear, which names no key at all', () => {
    // `localStorage.clear()` dispatches `key: null`. Treating that as "not my
    // key" would leave the window holding an overlay that no longer exists.
    const reread = vi.fn();
    teardowns.push(installOverlaySync(['candidcue.settings-overlay.v1'], reread));
    fire(null);
    expect(reread).toHaveBeenCalledTimes(1);
  });

  it('stops listening when torn down', () => {
    const reread = vi.fn();
    const stop = installOverlaySync(['candidcue.settings-overlay.v1'], reread);
    stop();
    fire('candidcue.settings-overlay.v1');
    expect(reread).not.toHaveBeenCalled();
  });
});
