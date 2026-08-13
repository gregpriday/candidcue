/**
 * SettingsStore (spec §45.2) — validated settings view with optimistic
 * patching through the settings service.
 */
import { get, writable } from 'svelte/store';
import * as settingsService from '../services/settings';
import { defaultAppSettings, type AppSettings } from '../services/settings-types';
import { describeError } from '../services/errors';
import { showToast } from './toasts';

const state = writable<AppSettings>(defaultAppSettings());
export const settings = { subscribe: state.subscribe };

let loaded = false;

/**
 * Adopt a settings document another window wrote (§14.1).
 *
 * Called by `services/settings-sync.ts` when Rust broadcasts a change. It
 * REPLACES the store rather than merging, because the payload is the whole
 * document at its new revision — merging would leave this window's
 * `expectedRevision` pointing at a version that no longer exists, which is the
 * conflict this whole mechanism exists to prevent.
 *
 * A payload that does not parse is ignored rather than adopted. An event is
 * delivered by evaluating JSON in the webview, so a malformed one is possible in
 * a way a typed command result is not, and replacing a working document with
 * nothing would be far worse than missing one update.
 *
 * `loaded` is set: a window that has been handed the current document has, for
 * every purpose, loaded it.
 */
export function adoptSettings(payload: unknown): boolean {
  const adapted = settingsService.adaptRevisionedSettings(payload);
  if (adapted === null) return false;
  /* A commit — so any read still in flight is stale. See `commitCount`. */
  commitSettings(adapted);
  return true;
}

/**
 * How many times the document has been COMMITTED.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS APPEARED WITH THE SECOND WINDOW
 * ---------------------------------------------------------------------------
 * `loadSettings` used to run at most once per window, from the shell, so there
 * was nothing to race. Three things now write the document at arbitrary
 * moments: a re-read forced by the `storage` event that carries an overlay
 * change between windows, a `settings://changed` broadcast adopted from the
 * other window, and this window's own save. Two of those in flight resolve in
 * whatever order the IPC layer answers, and the later `state.set` wins — so the
 * newest document could be overwritten by an older one that started first, and
 * the next save would fail its optimistic-concurrency check for reasons nobody
 * could see.
 *
 * ---------------------------------------------------------------------------
 * COUNTED ON COMMIT, NOT ON START
 * ---------------------------------------------------------------------------
 * The obvious version of this counts reads as they BEGIN and lets only the
 * newest commit. That is wrong in two ways, and both were real:
 *
 *   - a read that begins and then FAILS still invalidated an older read that
 *     had succeeded, so two reads racing at launch could leave the store never
 *     loaded at all;
 *   - it says nothing about a local save, which is a commit like any other —
 *     so a read that started before a save could still land after it and put
 *     the old value back.
 *
 * Counting commits answers all of it with one rule: a read commits only if
 * nothing else committed while it was in flight. A failed read commits
 * nothing and therefore invalidates nothing.
 */
let commitCount = 0;

/** Every write to the document goes through here, so nothing is missed. */
function commitSettings(value: AppSettings): void {
  commitCount += 1;
  state.set(value);
  loaded = true;
}

export async function loadSettings(force = false): Promise<AppSettings> {
  if (loaded && !force) return get(state);
  const committedAt = commitCount;
  const value = await settingsService.getSettings();
  if (commitCount === committedAt) commitSettings(value);
  /*
   * The migrations run WHETHER OR NOT this read committed.
   *
   * They are one-shot upgrades of a stored document, not a consequence of this
   * particular read winning — and when a broadcast arrives mid-read they would
   * otherwise be skipped, permanently: adopting sets `loaded`, so no later
   * unforced `loadSettings` would ever reach them again.
   */
  await adoptStageModeFromOverlay();
  await adoptOpticalFromOverlay();
  return get(state);
}

/**
 * Finish the presentation mode's move out of localStorage.
 *
 * ---------------------------------------------------------------------------
 * WHY A READ TRIGGERS A WRITE, JUST THIS ONCE
 * ---------------------------------------------------------------------------
 * Reading the old overlay as a fallback keeps an upgrading reader in reader
 * mode, and on its own that is only half a migration — Rust still holds
 * nothing, so the day the browser store is cleared they are silently back to
 * prompter. That is the exact failure the move was made to end, so the value
 * has to be written through rather than merely read.
 *
 * It happens here rather than in the service because a getter that writes is a
 * getter nobody can reason about. `pendingStageModeAdoption` reports what the
 * last read found; this acts on it once and then the flag stays null, because
 * the very next read sees a document that has an answer.
 *
 * Silent on failure, and deliberately: this is a migration the operator did not
 * ask for and cannot act on, the fallback keeps working in the meantime, and
 * the next launch tries again. A danger toast during startup for a settings
 * write nobody requested would be noise about a problem that fixes itself.
 */
/**
 * Forget that a migrated document was ever seen.
 *
 * A test seam. The latch that stops these one-shot migrations running twice
 * lives in the SERVICE, next to the raw Rust field it reads — see
 * `resetMigrationStateForTesting` there for why it cannot live here. This is
 * re-exported so a suite that drives the store does not have to know that.
 */
export function resetMigrationLatchesForTesting(): void {
  settingsService.resetMigrationStateForTesting();
}

async function adoptStageModeFromOverlay(): Promise<void> {
  const pending = settingsService.pendingStageModeAdoption();
  if (pending === null) return;
  const before = get(state);
  try {
    const saved = await settingsService.updateSettings(before.revision, {
      stage: { ...before.stage, presentationMode: pending },
    });
    /* A commit, like any other — see `commitCount`. */
    commitSettings(saved);
  } catch {
    // Left to the fallback, and to the next launch.
  }
}

/**
 * The same one-time move for calibrated rigs (§52), and the one that matters
 * most.
 *
 * Every measured viewing distance and lens placement used to live only in the
 * localStorage overlay — cleared by the OS under storage pressure, wiped by a
 * "clear website data" action nobody associates with an app, and written
 * through a `try` that swallowed every failure. A presentation mode somebody
 * loses is one menu click to set again; a viewing distance is a tape measure
 * and a room.
 *
 * Reading the overlay as a fallback would only be half the move: somebody who
 * calibrated last month and has not opened Calibrate since would leave Rust
 * holding nothing, so the measurement still dies with the browser store. The
 * read records what it found and this writes it through once.
 *
 * NOT silent on failure, unlike the mode above. That one has a working
 * fallback and a value the user can restate in a second; this one is the last
 * copy of something they measured. If it cannot be made durable the user needs
 * to know, because the fallback they are relying on is the thing that is about
 * to be cleared.
 */
async function adoptOpticalFromOverlay(): Promise<void> {
  const pending = settingsService.pendingOpticalAdoption();
  if (pending === null) return;
  const before = get(state);
  try {
    const saved = await settingsService.updateSettings(before.revision, {
      optical: pending,
    });
    /* A commit, like any other — see `commitCount`. */
    commitSettings(saved);
    /*
     * Only now, and this ordering is the fix.
     *
     * The legacy overlay copy has to outlive the write that adopts it — if the
     * write fails, the fallback the user is relying on must still be there.
     * And it has to be removed once the write lands, or it sits as a second
     * answer: `applyOverlayPatch` skips `optical`, so nothing else would ever
     * clear it, and a user who later deleted their last rig would find it
     * resurrected from the copy.
     */
    settingsService.forgetOverlayOptical();
  } catch (err) {
    showToast(
      'CandidCue could not move your saved teleprompter calibrations into permanent ' +
        `storage, so they are still only in this window's local data. ${describeError(err)}`,
      'danger',
    );
  }
}

/** Patch one settings section optimistically; reverts on failure. */
export async function patchSettings<K extends keyof AppSettings>(
  section: K,
  patch: Partial<AppSettings[K]>,
): Promise<void> {
  const before = get(state);
  const sectionValue = before[section];
  const optimistic: AppSettings = {
    ...before,
    [section]:
      typeof sectionValue === 'object' && sectionValue !== null
        ? { ...(sectionValue as object), ...(patch as object) }
        : patch,
  };
  /*
   * Deliberately NOT a commit.
   *
   * This is the optimistic half — shown immediately, and rolled back below if
   * the write is refused. Counting it would make a value that may never exist
   * invalidate a read that is about to deliver a real one. The commit is the
   * `commitSettings(saved)` a few lines down, once Rust has agreed.
   */
  state.set(optimistic);
  const committedAt = commitCount;
  try {
    const saved = await settingsService.updateSettings(before.revision, {
      [section]: optimistic[section],
    } as Partial<AppSettings>);
    /* A commit, so a read that started before this one cannot land after it
       and put the old value back. See `commitCount`. */
    commitSettings(saved);

    /*
     * A local-storage failure is reported, not swallowed.
     *
     * `saveOverlay` used to wrap its write in a bare `catch {}`, so a quota
     * error or disabled storage meant every per-machine preference silently
     * reverted at the next launch — repeatedly, with this screen reporting
     * success each time.
     *
     * Not a thrown error and not a revert: the authoritative half has already
     * committed by the time this runs, and what is left in the overlay after
     * calibrated rigs moved to Rust is presentation and capture state rather
     * than measured data. Losing it is annoying, not destructive; being lied
     * to about it is the actual problem.
     */
    const overlayFailure = settingsService.overlayStorageFailure();
    if (overlayFailure !== null) {
      showToast(
        'That setting was saved, but CandidCue could not store this window’s local ' +
          `preferences, so some of them will reset next launch. ${overlayFailure}`,
        'danger',
      );
    }
  } catch (err) {
    /*
     * Roll back ONLY IF nothing else committed meanwhile.
     *
     * The optimistic value is this window's guess and the rollback undoes it —
     * but "undo" means "put back what was there", and what was there may have
     * been replaced while the write was in flight. The other window saving, and
     * this window adopting the broadcast, is exactly that: restoring `before`
     * unconditionally would discard a document that is newer than the one this
     * save started from, and leave the store holding a revision that no longer
     * exists.
     *
     * When something did commit, the newer document stands. This save failed
     * and changed nothing, which is what the toast says either way.
     */
    if (commitCount === committedAt) state.set(before);
    showToast('Could not save settings. Nothing was changed.', 'danger');
    throw err;
  }
}

export function getSettingsSnapshot(): AppSettings {
  return get(state);
}
