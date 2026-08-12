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
import { adoptSettings } from '../stores/settings';
import { isTauriRuntime } from './ipc';

/** Rust → every window. Mirrored in `windows/mod.rs::events::SETTINGS_CHANGED`. */
export const SETTINGS_CHANGED_EVENT = 'settings://changed';

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
