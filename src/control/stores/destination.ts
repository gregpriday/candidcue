/**
 * Where the next take will open, kept current (CCUX-004, CCUX-005).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A STORE AND NOT A CALL AT LAUNCH
 * ---------------------------------------------------------------------------
 * The whole value of the readout is that it is on screen BEFORE the button is
 * pressed. Resolving it inside `startTake` would tell the operator where the
 * take went, which they can already see, at the one moment they can no longer
 * do anything about it.
 *
 * So it is resolved ahead of time and refreshed on the three occasions the
 * answer can change without this app doing anything:
 *
 *   - a monitor is plugged, unplugged or rearranged (`onDisplayTopologyChange`);
 *   - the user drags the window to another panel, which produces no event this
 *     app can see, so window focus is used as the proxy — you cannot drag a
 *     window without focusing it, and coming back to the app is exactly when
 *     somebody is about to press Present;
 *   - the pinned calibration display or presentation mode changes in Settings.
 *
 * Everything the resolution DECIDES lives in `lib/take-destination.ts` and is
 * pure. This module only fetches and schedules.
 */
import { get, writable, type Readable } from 'svelte/store';
import {
  resolveTakeDestination,
  type TakeDestination,
} from '../lib/take-destination';
import { listDisplayProfiles, profileForDisplay } from '../services/display-profiles';
import { currentWindowDisplay, listDisplays, onDisplayTopologyChange } from '../services/stage';
import type { PresentationMode } from '../services/settings-types';
import type { DisplayDescriptor } from '../services/stage-types';

/**
 * Null until the first resolution completes.
 *
 * Callers render nothing rather than a placeholder: a Present button that
 * flickers "unknown display" for a frame on every editor open would be worse
 * than one that says nothing until it knows.
 */
const store = writable<TakeDestination | null>(null);

export const takeDestination: Readable<TakeDestination | null> = { subscribe: store.subscribe };

/** The settings this depends on, passed in so the store imports no settings module. */
export interface DestinationContext {
  mode: PresentationMode;
  /** `settings.stage.displayFingerprint` — the panel pinned for calibration. */
  calibratedFingerprint: string | null;
}

let context: DestinationContext = { mode: 'prompter', calibratedFingerprint: null };
/** Guards against overlapping refreshes landing out of order. */
let inFlight = 0;

/**
 * Re-resolve now.
 *
 * Failures resolve to null rather than throwing or keeping a stale answer: a
 * destination readout that is confidently wrong is worse than one that is
 * absent, and this is decoration on a button that works regardless.
 */
export async function refreshTakeDestination(next?: Partial<DestinationContext>): Promise<void> {
  if (next !== undefined) context = { ...context, ...next };
  const ticket = ++inFlight;

  try {
    const [current, displays, profiles] = await Promise.all([
      currentWindowDisplay(),
      listDisplays(),
      listDisplayProfiles().catch(() => []),
    ]);
    // A slower earlier request must not overwrite a newer answer.
    if (ticket !== inFlight) return;

    const calibrated: DisplayDescriptor | null =
      context.calibratedFingerprint === null
        ? null
        : displays.find((d) => d.fingerprint === context.calibratedFingerprint) ?? null;

    store.set(
      resolveTakeDestination({
        mode: context.mode,
        currentDisplay: current,
        calibratedDisplay: calibrated,
        rigName: profileForDisplay(profiles, context.calibratedFingerprint)?.name ?? null,
      }),
    );
  } catch {
    if (ticket === inFlight) store.set(null);
  }
}

/**
 * Start keeping the destination current. Returns a teardown.
 *
 * The focus listener is the load-bearing one and also the crudest: dragging a
 * window between monitors emits nothing this app receives, so there is no
 * precise signal to use. Refocusing the app is a superset of "the operator came
 * back to press Present", which is the moment the readout has to be right.
 */
export function watchTakeDestination(initial: DestinationContext): () => void {
  context = initial;
  void refreshTakeDestination();

  const stopTopology = onDisplayTopologyChange(() => void refreshTakeDestination());

  const onFocus = (): void => void refreshTakeDestination();
  if (typeof window !== 'undefined') window.addEventListener('focus', onFocus);

  return () => {
    stopTopology();
    if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus);
  };
}

/** Current value without subscribing — for callers that need it once. */
export function currentTakeDestination(): TakeDestination | null {
  return get(store);
}
