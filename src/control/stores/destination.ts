/**
 * Where the next take will open, kept current (CCUX-004, CCUX-005, #302).
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
 *   - the user drags the window to another panel, which Rust forwards onto the
 *     same display-change event — and window focus as a backstop, because
 *     coming back to the app is exactly when somebody is about to press
 *     Present;
 *   - the pinned prompter display, the rigs or the presentation mode change in
 *     Settings.
 *
 * Everything the resolution DECIDES lives in `lib/take-destination.ts` and is
 * pure. This module only fetches and schedules.
 */
import { get, writable, type Readable } from 'svelte/store';
import {
  resolveTakeDestination,
  type CalibratedRig,
  type TakeDestination,
} from '../lib/take-destination';
import { currentWindowDisplay, listDisplays, watchDisplayChanges } from '../services/stage';
import { activeOpticalProfile, type OpticalSettings, type PresentationMode } from '../services/settings-types';

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
  /**
   * The optical settings, which is where a CALIBRATION actually lives.
   *
   * Deliberately not read off `pinnedFingerprint`: a pinned panel says where a
   * prompter take opens and nothing about whether anything was ever measured
   * on it. Reading it as "the calibrated rig" warned people who had calibrated
   * nothing at all.
   */
  optical: OpticalSettings;
  /**
   * `settings.stage.displayFingerprint` — the panel a prompter take fills when
   * it is connected. Without it this store named the monitor the editor was
   * on, while Present filled the pinned panel (#302).
   */
  pinnedFingerprint: string | null;
}

const NO_OPTICAL: OpticalSettings = { profiles: {}, activeRig: {}, panelMirror: {} };

let context: DestinationContext = { mode: 'prompter', optical: NO_OPTICAL, pinnedFingerprint: null };
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
    const [current, displays] = await Promise.all([currentWindowDisplay(), listDisplays()]);
    // A slower earlier request must not overwrite a newer answer.
    if (ticket !== inFlight) return;

    /*
     * Only CONNECTED panels, and only ones with a rig in force. A profile for a
     * monitor that is not plugged in is not a mismatch with anything.
     */
    const calibratedRigs: CalibratedRig[] = [];
    for (const display of displays) {
      const profile = activeOpticalProfile(context.optical, display.fingerprint);
      if (profile !== null) calibratedRigs.push({ display, rigName: profile.rigName });
    }
    /*
     * The pinned panel's rig is the exception to "connected only": when that
     * panel is unplugged, the rig the operator set up is exactly what this take
     * is about to go without, and the warning should say so by name.
     */
    const pinned = context.pinnedFingerprint;
    const pinnedRigName =
      pinned === null ? null : (activeOpticalProfile(context.optical, pinned)?.rigName ?? null);

    store.set(
      resolveTakeDestination({
        mode: context.mode,
        currentDisplay: current,
        displays,
        pinnedFingerprint: pinned,
        calibratedRigs,
        pinnedRigName,
      }),
    );
  } catch {
    if (ticket === inFlight) store.set(null);
  }
}

/**
 * Start keeping the destination current. Returns a teardown.
 *
 * The display-change event carries both a topology change and a drag of the
 * control window, which Rust forwards onto it. Focus is the backstop and also
 * the crudest signal: refocusing the app is a superset of "the operator came
 * back to press Present", which is the moment the readout has to be right.
 */
export function watchTakeDestination(initial: DestinationContext): () => void {
  context = initial;
  void refreshTakeDestination();

  /*
   * Coalesced inside `watchDisplayChanges`: a drag is a burst of move events,
   * and the `inFlight` ticket stops a stale answer being STORED but does
   * nothing about the requests themselves.
   */
  return watchDisplayChanges(() => void refreshTakeDestination(), { focus: true });
}

/** Current value without subscribing — for callers that need it once. */
export function currentTakeDestination(): TakeDestination | null {
  return get(store);
}
