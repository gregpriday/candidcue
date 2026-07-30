/**
 * Remembering where a reading window was.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A MODULE AND NOT THREE LINES IN `leavePresentation`
 * ---------------------------------------------------------------------------
 * A take stops presenting through `leavePresentation` (all three Live exits),
 * through the navigation guard in `App.svelte`, and — the one that is not an
 * exit at all — through the mid-take switch out of reader mode. Each is handed
 * a `ControlPresentationState`, and each is the last moment the reading
 * window's bounds exist to be read.
 *
 * A rule applied at several call sites is a rule that is applied at most of
 * them within a month, and the symptom of missing one is the worst kind: the
 * window comes back correctly most of the time, so the path that forgets reads
 * as flakiness rather than as a bug.
 *
 * Two paths deliberately do NOT call this, and both have their reasons written
 * where they are: the startup recovery in `App.svelte` (settings are not loaded
 * yet, so the write would be against the wrong revision) and `startTake`'s
 * failure path (a take that never opened has no window anybody shaped).
 */
import type { ControlPresentationState } from '../services/control-window';
import type { ReaderFrame } from '../services/settings-types';
import { getSettingsSnapshot, patchSettings } from '../stores/settings';

/**
 * A frame is only worth writing if it actually moved.
 *
 * Presenting in reader mode, reading, and stopping without touching the window
 * is the common case, and it would otherwise write an identical rectangle to
 * SQLite on the end of every take. The comparison is exact rather than
 * tolerance-based: these numbers come back from the same measurement path every
 * time, so anything that differs at all differs because the window moved.
 */
function sameFrame(a: ReaderFrame | null, b: ReaderFrame | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * Persist the reading window's bounds, if this state carried any.
 *
 * Never throws. Every call site is on a path that must complete — an exit that
 * fails partway leaves the operator looking at a covered window — and failing
 * to remember a rectangle is not a reason to strand somebody there.
 * `patchSettings` reverts its own optimistic update and reports failure to the
 * operator, so swallowing here loses nothing but the ability to make teardown
 * worse.
 *
 * Callers DO await it, though, which is the opposite of what it first looks
 * like it wants. The write has to be ordered against `startTake`'s forced
 * settings re-read: a read that overtakes it hands the next take the previous
 * frame and then patches from that revision. Every caller is behind the black
 * cover already, so the round trip is invisible.
 */
export async function rememberReaderFrame(
  state: ControlPresentationState | null,
): Promise<void> {
  const frame = state?.readerFrame;
  if (!frame) return;
  const saved = getSettingsSnapshot();
  /*
   * The toggle governs REMEMBERING as well as restoring, which is the honest
   * reading of a switch labelled "Restore windows": somebody who turned it off
   * is saying they do not want the app tracking where their windows sit, and
   * recording the frame anyway — while declining to use it — would be keeping a
   * note they asked us not to keep.
   */
  if (!saved.general.restoreWindows) return;
  if (sameFrame(saved.stage.readerFrame, frame)) return;
  await patchSettings('stage', { readerFrame: frame }).catch(() => {});
}
