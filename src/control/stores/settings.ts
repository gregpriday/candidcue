/**
 * SettingsStore (spec §45.2) — validated settings view with optimistic
 * patching through the settings service.
 */
import { get, writable } from 'svelte/store';
import * as settingsService from '../services/settings';
import { defaultAppSettings, type AppSettings } from '../services/settings-types';
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
  } catch (err) {
    state.set(before);
    showToast('Could not save settings. Nothing was changed.', 'danger');
    throw err;
  }
}

export function getSettingsSnapshot(): AppSettings {
  return get(state);
}
