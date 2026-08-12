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

export async function loadSettings(force = false): Promise<AppSettings> {
  if (loaded && !force) return get(state);
  const value = await settingsService.getSettings();
  state.set(value);
  loaded = true;
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
async function adoptStageModeFromOverlay(): Promise<void> {
  const pending = settingsService.pendingStageModeAdoption();
  if (pending === null) return;
  const before = get(state);
  try {
    const saved = await settingsService.updateSettings(before.revision, {
      stage: { ...before.stage, presentationMode: pending },
    });
    state.set(saved);
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
    state.set(saved);
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
  state.set(optimistic);
  try {
    const saved = await settingsService.updateSettings(before.revision, {
      [section]: optimistic[section],
    } as Partial<AppSettings>);
    state.set(saved);

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
    state.set(before);
    showToast('Could not save settings. Nothing was changed.', 'danger');
    throw err;
  }
}

export function getSettingsSnapshot(): AppSettings {
  return get(state);
}
