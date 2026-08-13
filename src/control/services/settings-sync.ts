/**
 * Keeping two windows' settings in step (desktop refinement §14.1).
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM THAT ARRIVED WITH THE SECOND WINDOW
 * ---------------------------------------------------------------------------
 * `stores/settings.ts` is a module singleton, and a module singleton in another
 * webview is a DIFFERENT INSTANCE — separate JavaScript contexts share nothing
 * but the backend. So the moment Settings moved into its own window there were
 * two copies of one document, and no path between them.
 *
 * That is not merely untidy. Every write is optimistic-concurrency checked
 * against `expectedRevision`, so a change made in one window silently
 * invalidates the other's revision: the next save there fails with a conflict
 * the user did nothing to cause and cannot understand. And a stage setting
 * changed in Preferences would not reach the take being composed in the control
 * window at all.
 *
 * Rust broadcasts the whole revisioned document after every successful
 * `update_settings` (`settings://changed`). This adopts it.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PAYLOAD IS THE DOCUMENT, NOT A NUDGE
 * ---------------------------------------------------------------------------
 * A "something changed, go and read it" event leaves a window between the
 * notification and the re-read in which this window answers questions from a
 * copy it already knows is wrong. Carrying the document closes it: the store is
 * correct the instant the event lands, with no round trip and nothing to race.
 */
import { isSettingsSection } from '../lib/commands';
import type { SettingsSection } from '../stores/router';
import { adoptSettings } from '../stores/settings';
import { isTauriRuntime } from './ipc';

/** Rust → every window. Mirrored in `windows/mod.rs::events::SETTINGS_CHANGED`. */
export const SETTINGS_CHANGED_EVENT = 'settings://changed';

/**
 * Control → the Settings window: show this section.
 *
 * `openSettingsWindow` records the section in the workspace store and the
 * Settings window reads it ON MOUNT. That is enough the first time and does
 * nothing at all the second: asking for Settings › Privacy while the window is
 * already open only brings it forward, still showing whatever section it was
 * left on, because nothing mounts again.
 *
 * So the section is also broadcast. A window that is opening now ignores it —
 * it has not started listening yet — and reads the store instead; a window
 * already open takes it and navigates. The store write stays because it is
 * what makes "reopen where I was" work across a restart.
 */
export const SETTINGS_SECTION_EVENT = 'settings://show-section';

/**
 * Listen for settings written by any window, including this one.
 *
 * This window receiving its own write is a no-op rather than a loop: adopting a
 * document identical to the one already held changes nothing, and `revision`
 * only moves when a write actually lands.
 */
export function installSettingsSync(): () => void {
  if (!isTauriRuntime()) return () => {};

  let disposed = false;
  let unlisten: (() => void) | null = null;

  void (async () => {
    try {
      const { listen } = await import('@tauri-apps/api/event');
      const stop = await listen<unknown>(SETTINGS_CHANGED_EVENT, (event) => {
        adoptSettings(event.payload);
      });
      if (disposed) stop();
      else unlisten = stop;
    } catch (err) {
      /*
       * Logged, not toasted. Without the broadcast the two windows drift, and
       * the symptom a user meets is a save that reports a conflict — which the
       * settings store already explains in its own words. A second message here
       * about an event channel would name a cause nobody can act on.
       */
      console.warn('settings changes will not be synchronised between windows', err);
    }
  })();

  return () => {
    disposed = true;
    unlisten?.();
  };
}

/**
 * Broadcast which Settings section to show.
 *
 * For a window that is ALREADY OPEN. Tauri events are not durable — a window
 * created after this emit never sees it — which is exactly why the section is
 * also written to the shared workspace store and flushed before the window is
 * asked to open. The two cover the two cases between them; neither covers both.
 *
 * The emit is fanned out to every webview, including this one, which ignores it
 * because nothing here listens for it.
 */
export async function emitSettingsSection(section: SettingsSection): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const { emit } = await import('@tauri-apps/api/event');
    await emit(SETTINGS_SECTION_EVENT, { section });
  } catch (err) {
    /* The window still opens; it opens on the section the store recorded. */
    console.debug('the settings section could not be broadcast', err);
  }
}

/** Listen for it, in the Settings window. */
export function installSettingsSectionSync(show: (section: SettingsSection) => void): () => void {
  if (!isTauriRuntime()) return () => {};

  let disposed = false;
  let unlisten: (() => void) | null = null;

  void (async () => {
    try {
      const { listen } = await import('@tauri-apps/api/event');
      const stop = await listen<{ section?: string }>(SETTINGS_SECTION_EVENT, (event) => {
        const section = event.payload?.section;
        /*
         * VALIDATED, not cast. A webview emit is fanned out to every webview by
         * Tauri, so this listener will accept whatever any window sends under
         * this name — and an unrecognised section would navigate the router to
         * a route that renders nothing.
         */
        if (typeof section === 'string' && isSettingsSection(section)) show(section);
      });
      if (disposed) stop();
      else unlisten = stop;
    } catch (err) {
      console.debug('the settings section broadcast is not connected', err);
    }
  })();

  return () => {
    disposed = true;
    unlisten?.();
  };
}

/**
 * Re-read settings that were written WITHOUT going through `update_settings`.
 *
 * ---------------------------------------------------------------------------
 * WHY THE BROADCAST ABOVE IS NOT THE WHOLE STORY
 * ---------------------------------------------------------------------------
 * `settings://changed` is emitted by Rust from the one command that writes the
 * settings document. Two kinds of change do not pass through it:
 *
 *   - OVERLAY settings — stage font, stage type size, mirror — which are stored
 *     per-window in `localStorage` and never reach Rust at all;
 *   - other Rust commands that write settings as a side effect, the speech
 *     language picker being the one that exists today.
 *
 * The second is fixed at the source (`speech_cmds.rs` broadcasts now). The
 * first cannot be: there is no command to hook. `localStorage` fires a `storage`
 * event in OTHER documents of the same origin when a key changes, which is
 * exactly the signal needed and exactly the windows that need it — so the
 * overlay is re-read from storage when the other window writes it.
 *
 * A re-read rather than a payload, because unlike the settings document the
 * overlay's source of truth IS `localStorage`: the event says which key moved,
 * and the store reads it back the same way it did at launch.
 */
export function installOverlaySync(keys: readonly string[], reread: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return () => {};
  }
  const watched = new Set(keys);
  const onStorage = (event: StorageEvent): void => {
    /* `key === null` is a `clear()` — everything moved, so re-read. */
    if (event.key !== null && !watched.has(event.key)) return;
    reread();
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}
